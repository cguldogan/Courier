/**
 * Team sync on Azure Blob Storage, accessed only with the signed-in credential
 * (`BlobServiceClient(accountUrl, credential)` — no keys, SAS or connection strings).
 * One `TeamSync` per joined team; each team is its own container:
 *
 *   <container>/courier-team.json                  team manifest { version, name, vaults }
 *   <container>/shared/collections/<id>.json
 *   <container>/shared/environments/<id>.json
 *
 * One blob per doc, optimistic concurrency with ETags:
 *   upload new      → If-None-Match: *     upload changed → If-Match: <etag>
 *   delete          → If-Match: <etag>      412/409        → conflict (mine | theirs | both)
 *
 * A team's engine only reads and writes its own cache (see workspace.ts); Personal items are never
 * seen by any engine and never cause a request.
 */
import type { TokenCredential } from '@azure/core-auth'
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob'
import type { ConflictDetail, ConflictResolution, ConnectionTestResult, SyncReport } from '../shared/api'
import type { Collection, Environment, Id, ItemKind, ItemRef, SecretFinding, SyncState, TeamManifest } from '../shared/types'
import { TEAM_MANIFEST_BLOB, newId } from '../shared/types'
import { isValidId, reidItems, sameContent } from '../shared/serialize'
import { Fault, isNetworkError, messageOf } from './errors'
import { scanCollection, scanEnvironment } from './secrets-scan'
import { parseManifest, serializeManifest, type RejectedVault } from './teams'
import { parseDoc, serializeDoc, type CacheEntry, type Doc, type LocalCache, type Tombstone } from './workspace'

export interface SyncIdentity {
  /** upn or display name, recorded as `updatedBy`. */
  label: string
}

export interface TeamRef {
  id: Id
  name: string
  accountUrl: string
  container: string
}

export interface TeamSyncOptions {
  team: () => TeamRef
  /** This team's cache — never another home's. */
  cache: LocalCache
  container: () => ContainerClient
  /** Null when not signed in. */
  identity: () => SyncIdentity | null
  /** Where an id lives locally, in any home (Personal = `teamId` null), or null. */
  locate: (kind: ItemKind, id: Id) => Promise<{ teamId: Id | null; sync: SyncState } | null>
}

export function createContainerClient(accountUrl: string, container: string, credential: TokenCredential): ContainerClient {
  return new BlobServiceClient(accountUrl, credential, { retryOptions: { maxTries: 2, retryDelayInMs: 200 } }).getContainerClient(container)
}

/** After a successful listing, a 403 on one item is a missing *write* permission: record it and go on. */
const FATAL_PER_ITEM = new Set<string>(['CONTAINER_NOT_FOUND', 'NETWORK', 'NOT_SIGNED_IN', 'AUTH_FAILED'])

const KIND_DIR: Record<ItemKind, string> = { collection: 'collections', environment: 'environments' }
const PREFIX = 'shared/'

export function blobName(kind: ItemKind, id: Id): string {
  if (!isValidId(id)) throw new Fault('INVALID_ARGUMENT', 'Invalid id.')
  return `${PREFIX}${KIND_DIR[kind]}/${id}.json`
}

function parseBlobName(name: string): { kind: ItemKind; id: Id } | null {
  if (!name.startsWith(PREFIX)) return null
  const m = /^(collections|environments)\/([A-Za-z0-9_-]{1,64})\.json$/.exec(name.slice(PREFIX.length))
  if (!m) return null
  return { kind: m[1] === 'collections' ? 'collection' : 'environment', id: m[2] }
}

/** ETags come quoted from blob responses and unquoted from listings: store them unquoted. */
export function normEtag(etag: string | undefined): string {
  return (etag ?? '').replace(/^W\//, '').replace(/"/g, '')
}
const quoted = (etag: string): string => `"${normEtag(etag)}"`

function statusOf(err: unknown): number | undefined {
  return (err as { statusCode?: number }).statusCode
}

function errorCodeHeader(err: unknown): string | undefined {
  const e = err as { code?: string; details?: { errorCode?: string } }
  return e.details?.errorCode ?? e.code
}

/** Clear, actionable storage errors. */
export function storageFault(err: unknown, accountUrl: string, container: string): Fault {
  if (err instanceof Fault) return err
  const status = statusOf(err)
  const code = errorCodeHeader(err)
  const msg = messageOf(err)
  if (/sign in with your azure identity/i.test(msg)) return new Fault('NOT_SIGNED_IN', 'Sign in with your Azure identity to sync.')
  if (status === 403)
    return new Fault(
      'FORBIDDEN',
      `Access denied to container "${container}" in ${accountUrl}${code ? ` (${code})` : ''}. Your identity needs the "Storage Blob Data Contributor" role (or "Storage Blob Data Reader" for read-only) on this team's container. New role assignments can take a few minutes to apply.`
    )
  if (status === 404 && code === 'BlobNotFound') return new Fault('NOT_FOUND', `The blob was not found in container "${container}".`)
  if (status === 404 && (code === 'ContainerNotFound' || !code))
    return new Fault('CONTAINER_NOT_FOUND', `Container "${container}" was not found in ${accountUrl}. Check the team in Settings → Teams, or ask an administrator to create it.`)
  if (status === 401) return new Fault('AUTH_FAILED', `The storage account rejected the token${code ? ` (${code})` : ''}: ${msg.split('\n')[0]}`)
  if (isNetworkError(err) || /ENOTFOUND|ECONNREFUSED|getaddrinfo|socket hang up/i.test(msg))
    return new Fault('NETWORK', `Cannot reach storage account ${accountUrl}: ${msg.split('\n')[0]}`)
  return new Fault('INTERNAL', `Storage error${status ? ` ${status}` : ''}${code ? ` (${code})` : ''}: ${msg.split('\n')[0]}`)
}

async function streamToString(stream: NodeJS.ReadableStream | undefined): Promise<string> {
  if (!stream) return ''
  const chunks: Buffer[] = []
  for await (const c of stream as AsyncIterable<Buffer | string>) chunks.push(typeof c === 'string' ? Buffer.from(c) : c)
  return Buffer.concat(chunks).toString('utf8')
}

export function emptyReport(): SyncReport {
  const now = new Date().toISOString()
  return { startedAt: now, finishedAt: now, teams: [], uploaded: [], downloaded: [], removedLocally: [], deletedRemotely: [], conflicts: [], blocked: [], notices: [], errors: [] }
}

export function scanDoc(kind: ItemKind, doc: Doc): SecretFinding[] {
  return kind === 'collection' ? scanCollection(doc as Collection) : scanEnvironment(doc as Environment)
}

// ---------------------------------------------------------------------------------------------
// Team manifest (courier-team.json)
// ---------------------------------------------------------------------------------------------

export interface ManifestRead {
  manifest: TeamManifest
  rejected: RejectedVault[]
  etag: string
}

/** Reads the manifest; null when the container has none. Other failures throw a storage Fault. */
export async function readManifest(c: ContainerClient, where: { accountUrl: string; container: string }, anyVaultHost: boolean): Promise<ManifestRead | null> {
  let text: string
  let etag: string
  try {
    const res = await c.getBlockBlobClient(TEAM_MANIFEST_BLOB).download()
    text = await streamToString(res.readableStreamBody)
    etag = normEtag(res.etag)
  } catch (err) {
    if (statusOf(err) === 404 && errorCodeHeader(err) === 'BlobNotFound') return null
    throw storageFault(err, where.accountUrl, where.container)
  }
  if (text.length > 256 * 1024) throw new Fault('INVALID_ARGUMENT', 'courier-team.json is too large.')
  return { ...parseManifest(text, anyVaultHost), etag }
}

/** Writes the manifest with a precondition; returns the new ETag. 412/409 → CONFLICT. */
export async function writeManifest(
  c: ContainerClient,
  where: { accountUrl: string; container: string },
  m: { name: string; vaults: { alias: string; url: string }[] },
  condition: { ifMatch: string } | { ifNoneMatch: '*' }
): Promise<string> {
  const text = serializeManifest(m)
  try {
    const res = await c.getBlockBlobClient(TEAM_MANIFEST_BLOB).upload(text, Buffer.byteLength(text), {
      conditions: 'ifMatch' in condition ? { ifMatch: quoted(condition.ifMatch) } : condition,
      blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' }
    })
    return normEtag(res.etag)
  } catch (err) {
    const st = statusOf(err)
    if (st === 412 || st === 409)
      throw new Fault(
        'CONFLICT',
        'ifMatch' in condition
          ? 'Someone changed the team settings in the meantime. The latest version was loaded; review it and save again.'
          : `Container "${where.container}" already has a team manifest. Join the team instead.`
      )
    throw storageFault(err, where.accountUrl, where.container)
  }
}

// ---------------------------------------------------------------------------------------------
// Read-only access (command-line runner: download only, no local cache, nothing uploaded)
// ---------------------------------------------------------------------------------------------

/** Ids and ETags of a team's collections or environments (one listing; no blob is read). */
export async function listTeamDocs(c: ContainerClient, where: { accountUrl: string; container: string }, kind: ItemKind): Promise<{ id: Id; etag: string }[]> {
  const out: { id: Id; etag: string }[] = []
  try {
    for await (const b of c.listBlobsFlat({ prefix: `${PREFIX}${KIND_DIR[kind]}/` })) {
      const parsed = parseBlobName(b.name)
      if (parsed && parsed.kind === kind) out.push({ id: parsed.id, etag: normEtag(b.properties.etag) })
    }
  } catch (err) {
    throw storageFault(err, where.accountUrl, where.container)
  }
  return out
}

/** Downloads and parses one team doc. The id from the blob name wins over the one in the document. */
export async function downloadTeamDoc(c: ContainerClient, where: { accountUrl: string; container: string }, kind: ItemKind, id: Id): Promise<{ doc: Doc; etag: string }> {
  let text: string
  let etag: string
  try {
    const res = await c.getBlockBlobClient(blobName(kind, id)).download()
    text = await streamToString(res.readableStreamBody)
    etag = normEtag(res.etag)
  } catch (err) {
    throw storageFault(err, where.accountUrl, where.container)
  }
  let doc: Doc
  try {
    doc = parseDoc(kind, text)
  } catch (err) {
    throw new Fault('INVALID_ARGUMENT', `The team's ${kind} ${id} is not valid JSON: ${messageOf(err)}`)
  }
  doc.id = id
  return { doc, etag }
}

// ---------------------------------------------------------------------------------------------
// Per-team sync
// ---------------------------------------------------------------------------------------------

export class TeamSync {
  constructor(private readonly o: TeamSyncOptions) {}

  get teamId(): Id {
    return this.o.team().id
  }

  private ref(kind: ItemKind, doc: { id: Id; name: string }): ItemRef {
    return { kind, id: doc.id, name: doc.name, teamId: this.teamId }
  }

  private requireIdentity(): SyncIdentity {
    const id = this.o.identity()
    if (!id) throw new Fault('NOT_SIGNED_IN', 'Sign in with your Azure identity to sync.')
    return id
  }

  fault(err: unknown): Fault {
    const t = this.o.team()
    return storageFault(err, t.accountUrl, t.container)
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      this.requireIdentity()
      const it = this.o.container().listBlobsFlat({ prefix: PREFIX }).byPage({ maxPageSize: 1 })
      await it.next()
      return { ok: true, message: `Connected to container "${this.o.team().container}".` }
    } catch (err) {
      const f = this.fault(err)
      return { ok: false, code: f.code, message: f.message }
    }
  }

  private async download(c: ContainerClient, name: string, kind: ItemKind): Promise<{ doc: Doc; etag: string }> {
    const res = await c.getBlockBlobClient(name).download()
    const text = await streamToString(res.readableStreamBody)
    return { doc: parseDoc(kind, text), etag: normEtag(res.etag) }
  }

  private async upload(c: ContainerClient, kind: ItemKind, doc: Doc, condition: { ifMatch: string } | { ifNoneMatch: '*' }, who: SyncIdentity): Promise<{ etag: string; doc: Doc }> {
    const stamped = { ...doc, updatedBy: who.label, updatedAt: new Date().toISOString() } as Doc
    const text = serializeDoc(kind, stamped)
    const res = await c.getBlockBlobClient(blobName(kind, doc.id)).upload(text, Buffer.byteLength(text), {
      conditions: 'ifMatch' in condition ? { ifMatch: quoted(condition.ifMatch) } : condition,
      blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' }
    })
    return { etag: normEtag(res.etag), doc: parseDoc(kind, text) }
  }

  /**
   * A tombstone left by a move to another team is applied only once the item has been uploaded
   * there (or has since moved to Personal or been deleted). Plain deletes apply right away.
   */
  private async deleteReady(t: Tombstone): Promise<boolean> {
    if (!t.movedToTeam) return true
    const here = await this.o.locate(t.kind, t.id)
    if (!here) return true
    if (here.teamId === null) return true
    if (here.teamId === this.teamId) return false
    return Boolean(here.sync.etag)
  }

  /** Applies ready tombstones. Returns the keys whose blob must be left alone (still pending). */
  private async applyDeletes(c: ContainerClient, remote: Map<string, RemoteBlob> | null, report: SyncReport, onlyMoves: boolean): Promise<Set<string>> {
    const pending = new Set<string>()
    for (const t of await this.o.cache.tombstones()) {
      if (onlyMoves && !t.movedToTeam) continue
      const key = `${t.kind}:${t.id}`
      const ref: ItemRef = { kind: t.kind, id: t.id, name: t.name, teamId: this.teamId }
      if (!(await this.deleteReady(t))) {
        pending.add(key)
        continue
      }
      if (remote && !remote.has(key)) {
        await this.o.cache.removeTombstone(t)
        continue
      }
      try {
        const etag = t.etag ?? remote?.get(key)?.etag
        await c.getBlockBlobClient(blobName(t.kind, t.id)).delete(etag ? { conditions: { ifMatch: quoted(etag) } } : {})
        await this.o.cache.removeTombstone(t)
        remote?.delete(key)
        report.deletedRemotely.push(ref)
      } catch (err) {
        const st = statusOf(err)
        if (st === 404) {
          await this.o.cache.removeTombstone(t)
          remote?.delete(key)
        } else if (st === 412) {
          await this.o.cache.removeTombstone(t)
          const message = t.movedToTeam
            ? `"${t.name}" was changed in this team after you moved it, so the team's copy was kept.`
            : `"${t.name}" was changed remotely after you deleted it, so it was not deleted and has been restored.`
          report.notices.push({ teamId: this.teamId, ref, message })
        } else {
          pending.add(key)
          const f = this.fault(err)
          if (FATAL_PER_ITEM.has(f.code)) throw f
          report.errors.push({ teamId: this.teamId, ref, code: f.code, message: f.message })
        }
      }
    }
    return pending
  }

  /** Syncs this team's items into `report`. Throws a Fault for team-level failures. */
  async run(opts: { acknowledgeWarnings?: boolean }, report: SyncReport): Promise<void> {
    const who = this.requireIdentity()
    const c = this.o.container()
    const remote = new Map<string, RemoteBlob>()
    try {
      for await (const b of c.listBlobsFlat({ prefix: PREFIX })) {
        const parsed = parseBlobName(b.name)
        if (parsed) remote.set(`${parsed.kind}:${parsed.id}`, { ...parsed, name: b.name, etag: normEtag(b.properties.etag) })
      }
    } catch (err) {
      throw this.fault(err)
    }

    // 1. pending deletes (moves wait for the upload to the destination team)
    const pendingDeletes = await this.applyDeletes(c, remote, report, false)

    // 2. local items of this team
    const locals: CacheEntry[] = [...(await this.o.cache.list('collection')), ...(await this.o.cache.list('environment'))]
    const localKeys = new Set<string>()
    for (const e of locals) {
      const key = `${e.kind}:${e.doc.id}`
      localKeys.add(key)
      const r = remote.get(key)
      const ref = this.ref(e.kind, e.doc)
      try {
        if (e.sync.conflict) {
          report.conflicts.push(ref)
          continue
        }
        if (r) {
          if (e.sync.etag === r.etag) {
            if (e.sync.dirty) await this.pushItem(c, e, { ifMatch: r.etag }, who, opts, report)
          } else if (!e.sync.dirty) {
            const d = await this.download(c, r.name, e.kind)
            if (await this.writeBack(e, 'downloaded', d.doc, { ...e.sync, etag: d.etag, dirty: false, lastSyncedAt: new Date().toISOString(), notice: undefined }))
              report.downloaded.push(this.ref(e.kind, d.doc))
            else report.conflicts.push(ref)
          } else {
            const d = await this.download(c, r.name, e.kind)
            if (sameContent(e.doc, d.doc, e.kind)) {
              await this.writeBack(e, 'uploaded', d.doc, { ...e.sync, etag: d.etag, dirty: false, lastSyncedAt: new Date().toISOString() })
            } else {
              await this.markConflict(e, d.doc, d.etag, e.sync.etag ? 'both-changed' : 'precondition-failed')
              report.conflicts.push(ref)
            }
          }
        } else if (e.sync.etag) {
          // remote deleted
          const removed =
            !e.sync.dirty &&
            (await this.o.cache.lock(async () => {
              const cur = await this.o.cache.get(e.kind, e.doc.id)
              if (!cur || cur.sync.dirty) return false
              await this.o.cache.remove(e.kind, e.doc.id)
              return true
            }))
          if (removed) {
            report.removedLocally.push(ref)
          } else {
            const message = `"${e.doc.name}" was deleted remotely. Your local changes were kept and will be uploaded as a new item on the next sync.`
            await this.o.cache.setSync(e.kind, e.doc.id, (s) => ({ ...s, etag: undefined, dirty: true, notice: message }))
            report.notices.push({ teamId: this.teamId, ref, message })
          }
        } else if (e.sync.dirty) {
          await this.pushItem(c, e, { ifNoneMatch: '*' }, who, opts, report)
        }
      } catch (err) {
        const f = this.fault(err)
        if (FATAL_PER_ITEM.has(f.code)) throw f
        report.errors.push({ teamId: this.teamId, ref, code: f.code, message: f.message })
      }
    }

    // 3. remote-only items → download (ids are unique across homes on this machine)
    for (const [key, r] of remote) {
      if (localKeys.has(key) || pendingDeletes.has(key)) continue
      const elsewhere = await this.o.locate(r.kind, r.id)
      if (elsewhere) {
        if (elsewhere.teamId !== this.teamId && !(await this.o.cache.tombstones()).some((t) => t.kind === r.kind && t.id === r.id))
          report.notices.push({
            teamId: this.teamId,
            ref: { kind: r.kind, id: r.id, name: r.id, teamId: this.teamId },
            message: `An item with the same id already exists ${elsewhere.teamId === null ? 'in Personal' : 'in another team'} on this machine, so this team's copy was not downloaded.`
          })
        continue
      }
      try {
        const d = await this.download(c, r.name, r.kind)
        d.doc.id = r.id
        const sync: SyncState = { dirty: false, etag: d.etag, lastSyncedAt: new Date().toISOString() }
        const stored = await this.o.cache.lock(async () => {
          if (await this.o.locate(r.kind, r.id)) return false
          await this.o.cache.put(r.kind, d.doc, sync)
          return true
        })
        if (stored) report.downloaded.push(this.ref(r.kind, d.doc))
      } catch (err) {
        const f = this.fault(err)
        if (FATAL_PER_ITEM.has(f.code)) throw f
        report.errors.push({ teamId: this.teamId, ref: { kind: r.kind, id: r.id, name: r.id, teamId: this.teamId }, code: f.code, message: f.message })
      }
    }
  }

  /** Second pass after every team ran: old blobs of items that have now reached their new team. */
  async applyMovedDeletes(report: SyncReport): Promise<void> {
    if (!(await this.o.cache.tombstones()).some((t) => t.movedToTeam)) return
    this.requireIdentity()
    try {
      await this.applyDeletes(this.o.container(), null, report, true)
    } catch (err) {
      const f = this.fault(err)
      report.errors.push({ teamId: this.teamId, code: f.code, message: f.message })
    }
  }

  private async pushItem(
    c: ContainerClient,
    e: CacheEntry,
    condition: { ifMatch: string } | { ifNoneMatch: '*' },
    who: SyncIdentity,
    opts: { acknowledgeWarnings?: boolean },
    report: SyncReport
  ): Promise<void> {
    const ref = this.ref(e.kind, e.doc)
    if (!opts.acknowledgeWarnings) {
      const findings = scanDoc(e.kind, e.doc)
      if (findings.length) {
        report.blocked.push({ ref, findings })
        return
      }
    }
    try {
      const up = await this.upload(c, e.kind, e.doc, condition, who)
      await this.writeBack(e, 'uploaded', up.doc, { ...e.sync, etag: up.etag, dirty: false, lastSyncedAt: new Date().toISOString(), notice: undefined, conflict: undefined })
      report.uploaded.push(ref)
    } catch (err) {
      const st = statusOf(err)
      if (st === 412 || st === 409) {
        const d = await this.download(c, blobName(e.kind, e.doc.id), e.kind)
        await this.markConflict(e, d.doc, d.etag, 'precondition-failed')
        report.conflicts.push(ref)
        return
      }
      throw err
    }
  }

  /**
   * Write a sync result back under the cache lock. If the user edited the item while the network
   * call was in flight, never overwrite those edits:
   *  - after an upload: keep the newer local doc, rebase it on the new etag, stay dirty;
   *  - after a download: the remote changed too → conflict.
   * Returns false when the local item changed, moved away or vanished meanwhile.
   */
  private writeBack(snapshot: CacheEntry, mode: 'uploaded' | 'downloaded', doc: Doc, sync: SyncState): Promise<boolean> {
    return this.o.cache.lock(async () => {
      const cur = await this.o.cache.get(snapshot.kind, snapshot.doc.id)
      if (!cur) return false
      if (serializeDoc(cur.kind, cur.doc) !== serializeDoc(snapshot.kind, snapshot.doc)) {
        if (mode === 'uploaded') await this.o.cache.setSync(cur.kind, cur.doc.id, (s) => ({ ...s, etag: sync.etag, dirty: true }))
        else await this.markConflictLocked(cur, doc, sync.etag ?? '', 'both-changed')
        return false
      }
      await this.o.cache.put(snapshot.kind, doc, sync)
      return true
    })
  }

  private markConflict(e: CacheEntry, theirs: Doc, etag: string, reason: 'both-changed' | 'precondition-failed'): Promise<void> {
    return this.o.cache.lock(() => this.markConflictLocked(e, theirs, etag, reason))
  }

  private async markConflictLocked(e: CacheEntry, theirs: Doc, etag: string, reason: 'both-changed' | 'precondition-failed'): Promise<void> {
    theirs.id = e.doc.id
    await this.o.cache.saveConflictCopy(e.kind, theirs)
    await this.o.cache.setSync(e.kind, e.doc.id, (s) => ({
      ...s,
      conflict: {
        reason,
        remoteEtag: etag,
        ...(theirs.updatedBy ? { remoteUpdatedBy: theirs.updatedBy } : {}),
        ...(theirs.updatedAt ? { remoteUpdatedAt: theirs.updatedAt } : {}),
        detectedAt: new Date().toISOString()
      }
    }))
  }

  async getConflict(kind: ItemKind, id: Id): Promise<ConflictDetail> {
    const e = await this.o.cache.require(kind, id)
    const theirs = await this.o.cache.loadConflictCopy(kind, id)
    if (!e.sync.conflict || !theirs) throw new Fault('NOT_FOUND', 'This item has no open conflict.')
    return {
      ref: this.ref(kind, e.doc),
      reason: e.sync.conflict.reason,
      mine: e.doc,
      theirs,
      ...(e.sync.conflict.remoteUpdatedBy ? { remoteUpdatedBy: e.sync.conflict.remoteUpdatedBy } : {}),
      ...(e.sync.conflict.remoteUpdatedAt ? { remoteUpdatedAt: e.sync.conflict.remoteUpdatedAt } : {})
    }
  }

  /** Applies a resolution locally; the caller then syncs this team. Returns the "my copy" ref for `both`. */
  resolveLocally(kind: ItemKind, id: Id, resolution: ConflictResolution): Promise<ItemRef | undefined> {
    return this.o.cache.lock(async (): Promise<ItemRef | undefined> => {
      const e = await this.o.cache.require(kind, id)
      const conflict = e.sync.conflict
      const theirs = await this.o.cache.loadConflictCopy(kind, id)
      if (!conflict || !theirs) throw new Fault('NOT_FOUND', 'This item has no open conflict.')
      let copy: ItemRef | undefined
      const now = new Date().toISOString()
      if (resolution === 'theirs') {
        await this.o.cache.put(kind, theirs, { ...e.sync, etag: conflict.remoteEtag, dirty: false, conflict: undefined, notice: undefined, lastSyncedAt: now })
      } else if (resolution === 'mine') {
        // Rebase the local doc on the remote etag; the next upload uses If-Match: <remoteEtag>.
        await this.o.cache.put(kind, e.doc, { ...e.sync, etag: conflict.remoteEtag, dirty: true, conflict: undefined, notice: undefined })
      } else {
        const mine = structuredClone(e.doc) as Doc
        mine.id = newId()
        mine.name = `${e.doc.name} (my copy)`
        if (kind === 'collection') (mine as Collection).items = reidItems((mine as Collection).items)
        delete mine.updatedBy
        delete mine.updatedAt
        await this.o.cache.put(kind, mine, { dirty: true })
        await this.o.cache.put(kind, theirs, { ...e.sync, etag: conflict.remoteEtag, dirty: false, conflict: undefined, notice: undefined, lastSyncedAt: now })
        copy = this.ref(kind, mine)
      }
      await this.o.cache.removeConflictCopy(kind, id)
      return copy
    })
  }

  /**
   * Throw away local changes to a team item (edits or a pending delete); the remote version is
   * downloaded again by the next sync. Items that were never uploaded cannot be discarded.
   */
  async discardLocal(kind: ItemKind, id: Id): Promise<void> {
    await this.o.cache.lock(async () => {
      const tombs = (await this.o.cache.tombstones()).filter((t) => t.kind === kind && t.id === id)
      for (const t of tombs) await this.o.cache.removeTombstone(t)
      const e = await this.o.cache.get(kind, id)
      if (!e) {
        if (!tombs.length) throw new Fault('NOT_FOUND', 'Nothing to discard for this item.')
        return
      }
      if (!e.sync.etag) throw new Fault('INVALID_ARGUMENT', 'This item was never uploaded; delete it instead.')
      await this.o.cache.remove(kind, id)
    })
  }

  async hasTombstone(kind: ItemKind, id: Id): Promise<boolean> {
    return (await this.o.cache.tombstones()).some((t) => t.kind === kind && t.id === id)
  }

  /** Best-effort immediate remote delete for a tombstone (stays queued on failure). */
  async flushTombstone(t: Tombstone): Promise<void> {
    if (!this.o.identity() || t.movedToTeam) return
    try {
      await this.o.container().getBlockBlobClient(blobName(t.kind, t.id)).delete(t.etag ? { conditions: { ifMatch: quoted(t.etag) } } : {})
      await this.o.cache.removeTombstone(t)
    } catch (err) {
      if (statusOf(err) === 404) await this.o.cache.removeTombstone(t)
      // 412 and transient errors are handled by the next full sync.
    }
  }
}

interface RemoteBlob {
  name: string
  etag: string
  kind: ItemKind
  id: Id
}
