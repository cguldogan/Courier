/**
 * Cloud spaces on Azure Blob Storage, accessed only with the signed-in credential
 * (`BlobServiceClient(accountUrl, credential)` — no keys, SAS or connection strings).
 *
 *   shared/collections/<id>.json        shared/environments/<id>.json
 *   users/<oid>/collections/<id>.json   users/<oid>/environments/<id>.json
 *
 * One blob per doc, optimistic concurrency with ETags:
 *   upload new      → If-None-Match: *     upload changed → If-Match: <etag>
 *   delete          → If-Match: <etag>      412/409        → conflict (mine | theirs | both)
 */
import type { TokenCredential } from '@azure/core-auth'
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob'
import type { ConflictDetail, ConflictResolution, ConnectionTestResult, ResolveConflictResult, SyncReport } from '../shared/api'
import type { Collection, Environment, Id, ItemKind, ItemRef, SecretFinding, Space, SyncState } from '../shared/types'
import { newId } from '../shared/types'
import { isValidId, reidItems, sameContent } from '../shared/serialize'
import { Fault, isNetworkError, messageOf } from './errors'
import { scanCollection, scanEnvironment } from './secrets-scan'
import { parseDoc, serializeDoc, type CacheEntry, type Doc, type LocalCache, type Tombstone } from './workspace'

export type CloudSpace = Exclude<Space, 'local'>

export interface SyncIdentity {
  oid?: string
  /** upn or display name, recorded as `updatedBy`. */
  label: string
}

export interface BlobSyncOptions {
  cache: LocalCache
  /** Null when no storage account is configured. */
  container: () => ContainerClient | null
  /** Null when not signed in. */
  identity: () => SyncIdentity | null
  describe: () => { accountUrl: string; container: string }
}

export function createContainerClient(accountUrl: string, container: string, credential: TokenCredential): ContainerClient {
  return new BlobServiceClient(accountUrl, credential, { retryOptions: { maxTries: 2, retryDelayInMs: 200 } }).getContainerClient(container)
}

/** Account-level failures: stop the whole sync. */
const FATAL = new Set<string>(['FORBIDDEN', 'CONTAINER_NOT_FOUND', 'NETWORK', 'NOT_SIGNED_IN', 'AUTH_FAILED'])
/** After a successful listing, a 403 on one item is a missing *write* permission: record it and go on. */
const FATAL_PER_ITEM = new Set<string>(['CONTAINER_NOT_FOUND', 'NETWORK', 'NOT_SIGNED_IN', 'AUTH_FAILED'])

const KIND_DIR: Record<ItemKind, string> = { collection: 'collections', environment: 'environments' }

export function blobName(space: CloudSpace, kind: ItemKind, id: Id, oid?: string): string {
  if (!isValidId(id)) throw new Fault('INVALID_ARGUMENT', 'Invalid id.')
  if (space === 'personal') {
    if (!oid || !isValidId(oid)) throw new Fault('NOT_SIGNED_IN', 'Personal space needs a signed-in identity with an object id.')
    return `users/${oid}/${KIND_DIR[kind]}/${id}.json`
  }
  return `shared/${KIND_DIR[kind]}/${id}.json`
}

function prefixFor(space: CloudSpace, oid?: string): string {
  return space === 'shared' ? 'shared/' : `users/${oid}/`
}

function parseBlobName(name: string, prefix: string): { kind: ItemKind; id: Id } | null {
  if (!name.startsWith(prefix)) return null
  const m = /^(collections|environments)\/([A-Za-z0-9_-]{1,64})\.json$/.exec(name.slice(prefix.length))
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
      `Access denied to container "${container}" in ${accountUrl}${code ? ` (${code})` : ''}. Your identity needs the "Storage Blob Data Contributor" role (or "Storage Blob Data Reader" for read-only) on the storage account or container. New role assignments can take a few minutes to apply.`
    )
  if (status === 404 && (code === 'ContainerNotFound' || !code))
    return new Fault('CONTAINER_NOT_FOUND', `Container "${container}" was not found in ${accountUrl}. Check Settings → Storage, or ask an administrator to create it.`)
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

function refOf(kind: ItemKind, doc: Doc, space: Space): ItemRef {
  return { kind, id: doc.id, name: doc.name, space }
}

export function emptyReport(): SyncReport {
  const now = new Date().toISOString()
  return { startedAt: now, finishedAt: now, spaces: [], uploaded: [], downloaded: [], removedLocally: [], deletedRemotely: [], conflicts: [], blocked: [], notices: [], errors: [] }
}

export function scanDoc(kind: ItemKind, doc: Doc): SecretFinding[] {
  return kind === 'collection' ? scanCollection(doc as Collection) : scanEnvironment(doc as Environment)
}

export class SyncEngine {
  private running: Promise<SyncReport> | null = null

  constructor(private readonly o: BlobSyncOptions) {}

  get isRunning(): boolean {
    return this.running !== null
  }

  private requireContainer(): ContainerClient {
    const c = this.o.container()
    if (!c) throw new Fault('NOT_CONFIGURED', 'No storage account is configured. Set the account URL and container in Settings → Storage.')
    return c
  }

  private requireIdentity(): SyncIdentity {
    const id = this.o.identity()
    if (!id) throw new Fault('NOT_SIGNED_IN', 'Sign in with your Azure identity to sync.')
    return id
  }

  private fault(err: unknown): Fault {
    const d = this.o.describe()
    return storageFault(err, d.accountUrl, d.container)
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const c = this.requireContainer()
      this.requireIdentity()
      const it = c.listBlobsFlat({ prefix: 'shared/' }).byPage({ maxPageSize: 1 })
      await it.next()
      return { ok: true, message: `Connected to container "${this.o.describe().container}".` }
    } catch (err) {
      const f = this.fault(err)
      return { ok: false, code: f.code, message: f.message }
    }
  }

  /** Runs one sync (concurrent callers share the same run). */
  run(opts: { acknowledgeWarnings?: boolean } = {}): Promise<SyncReport> {
    if (this.running) return this.running
    this.running = this.doRun(opts).finally(() => {
      this.running = null
    })
    return this.running
  }

  private async download(c: ContainerClient, name: string, kind: ItemKind): Promise<{ doc: Doc; etag: string }> {
    const res = await c.getBlockBlobClient(name).download()
    const text = await streamToString(res.readableStreamBody)
    return { doc: parseDoc(kind, text), etag: normEtag(res.etag) }
  }

  private async upload(
    c: ContainerClient,
    kind: ItemKind,
    doc: Doc,
    space: CloudSpace,
    oid: string | undefined,
    condition: { ifMatch: string } | { ifNoneMatch: '*' },
    who: SyncIdentity
  ): Promise<{ etag: string; doc: Doc }> {
    const stamped = { ...doc, updatedBy: who.label, updatedAt: new Date().toISOString() } as Doc
    const text = serializeDoc(kind, stamped)
    const res = await c.getBlockBlobClient(blobName(space, kind, doc.id, oid)).upload(text, Buffer.byteLength(text), {
      conditions: 'ifMatch' in condition ? { ifMatch: quoted(condition.ifMatch) } : condition,
      blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' }
    })
    return { etag: normEtag(res.etag), doc: parseDoc(kind, text) }
  }

  private async doRun(opts: { acknowledgeWarnings?: boolean }): Promise<SyncReport> {
    const report = emptyReport()
    const c = this.requireContainer()
    const who = this.requireIdentity()
    const spaces: CloudSpace[] = who.oid ? ['personal', 'shared'] : ['shared']
    if (!who.oid) report.notices.push({ ref: { kind: 'collection', id: '-', name: '-', space: 'personal' }, message: 'Personal space skipped: the signed-in identity has no object id.' })

    for (const space of spaces) {
      try {
        await this.syncSpace(c, space, who, opts, report)
        report.spaces.push(space)
      } catch (err) {
        const f = this.fault(err)
        report.errors.push({ code: f.code, message: f.message })
        // Account-level failures (RBAC, missing container, network, auth) would repeat for the other space.
        if (FATAL.has(f.code)) break
      }
    }
    report.finishedAt = new Date().toISOString()
    return report
  }

  private async syncSpace(c: ContainerClient, space: CloudSpace, who: SyncIdentity, opts: { acknowledgeWarnings?: boolean }, report: SyncReport): Promise<void> {
    const oid = space === 'personal' ? who.oid : undefined
    const prefix = prefixFor(space, oid)
    const remote = new Map<string, { name: string; etag: string; kind: ItemKind; id: Id }>()
    for await (const b of c.listBlobsFlat({ prefix })) {
      const parsed = parseBlobName(b.name, prefix)
      if (parsed) remote.set(`${parsed.kind}:${parsed.id}`, { ...parsed, name: b.name, etag: normEtag(b.properties.etag) })
    }

    // 1. pending deletes
    const pendingDeletes = new Set<string>()
    for (const t of await this.o.cache.tombstones()) {
      if (t.space !== space || (space === 'personal' && t.ownerOid !== oid)) continue
      const key = `${t.kind}:${t.id}`
      const r = remote.get(key)
      if (!r) {
        await this.o.cache.removeTombstone(t)
        continue
      }
      try {
        await c.getBlockBlobClient(r.name).delete({ conditions: { ifMatch: quoted(t.etag ?? r.etag) } })
        await this.o.cache.removeTombstone(t)
        remote.delete(key)
        report.deletedRemotely.push({ kind: t.kind, id: t.id, name: t.name, space })
      } catch (err) {
        const st = statusOf(err)
        if (st === 404) {
          await this.o.cache.removeTombstone(t)
          remote.delete(key)
        } else if (st === 412) {
          await this.o.cache.removeTombstone(t)
          report.notices.push({ ref: { kind: t.kind, id: t.id, name: t.name, space }, message: `"${t.name}" was changed remotely after you deleted it, so it was not deleted and has been restored.` })
        } else {
          pendingDeletes.add(key)
          const f = this.fault(err)
          report.errors.push({ ref: { kind: t.kind, id: t.id, name: t.name, space }, code: f.code, message: f.message })
        }
      }
    }

    // 2. local items of this space
    const locals: CacheEntry[] = [...(await this.o.cache.list('collection')), ...(await this.o.cache.list('environment'))].filter(
      (e) => e.sync.space === space && (space !== 'personal' || e.sync.ownerOid === oid)
    )
    const localKeys = new Set<string>()
    for (const e of locals) {
      const key = `${e.kind}:${e.doc.id}`
      localKeys.add(key)
      const r = remote.get(key)
      const ref = refOf(e.kind, e.doc, space)
      try {
        if (e.sync.conflict) {
          report.conflicts.push(ref)
          continue
        }
        if (r) {
          if (e.sync.etag === r.etag) {
            if (e.sync.dirty) await this.pushItem(c, e, space, oid, { ifMatch: r.etag }, who, opts, report)
          } else if (!e.sync.dirty) {
            const d = await this.download(c, r.name, e.kind)
            if (await this.writeBack(e, 'downloaded', d.doc, { ...e.sync, etag: d.etag, dirty: false, lastSyncedAt: new Date().toISOString(), notice: undefined }))
              report.downloaded.push(refOf(e.kind, d.doc, space))
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
              if (!cur || cur.sync.dirty || cur.sync.space !== space) return false
              await this.o.cache.remove(e.kind, e.doc.id)
              return true
            }))
          if (removed) {
            report.removedLocally.push(ref)
          } else {
            const message = `"${e.doc.name}" was deleted remotely. Your local changes were kept and will be uploaded as a new item on the next sync.`
            await this.o.cache.setSync(e.kind, e.doc.id, (s) => ({ ...s, etag: undefined, dirty: true, notice: message }))
            report.notices.push({ ref, message })
          }
        } else if (e.sync.dirty) {
          await this.pushItem(c, e, space, oid, { ifNoneMatch: '*' }, who, opts, report)
        }
      } catch (err) {
        const f = this.fault(err)
        if (FATAL_PER_ITEM.has(f.code)) throw f
        report.errors.push({ ref, code: f.code, message: f.message })
      }
    }

    // 3. remote-only items → download
    for (const [key, r] of remote) {
      if (localKeys.has(key) || pendingDeletes.has(key)) continue
      const existing = await this.o.cache.get(r.kind, r.id)
      if (existing) {
        // Same id lives locally in another space (e.g. just moved): leave the blob alone.
        continue
      }
      try {
        const d = await this.download(c, r.name, r.kind)
        d.doc.id = r.id
        const sync: SyncState = { space, dirty: false, etag: d.etag, lastSyncedAt: new Date().toISOString(), ...(oid ? { ownerOid: oid } : {}) }
        const stored = await this.o.cache.lock(async () => {
          if (await this.o.cache.get(r.kind, r.id)) return false
          await this.o.cache.put(r.kind, d.doc, sync)
          return true
        })
        if (stored) report.downloaded.push(refOf(r.kind, d.doc, space))
      } catch (err) {
        const f = this.fault(err)
        report.errors.push({ ref: { kind: r.kind, id: r.id, name: r.id, space }, code: f.code, message: f.message })
      }
    }
  }

  private async pushItem(
    c: ContainerClient,
    e: CacheEntry,
    space: CloudSpace,
    oid: string | undefined,
    condition: { ifMatch: string } | { ifNoneMatch: '*' },
    who: SyncIdentity,
    opts: { acknowledgeWarnings?: boolean },
    report: SyncReport
  ): Promise<void> {
    const ref = refOf(e.kind, e.doc, space)
    if (space === 'shared' && !opts.acknowledgeWarnings) {
      const findings = scanDoc(e.kind, e.doc)
      if (findings.length) {
        report.blocked.push({ ref, findings })
        return
      }
    }
    try {
      const up = await this.upload(c, e.kind, e.doc, space, oid, condition, who)
      await this.writeBack(e, 'uploaded', up.doc, { ...e.sync, etag: up.etag, dirty: false, lastSyncedAt: new Date().toISOString(), notice: undefined, conflict: undefined })
      report.uploaded.push(ref)
    } catch (err) {
      const st = statusOf(err)
      if (st === 412 || st === 409) {
        const name = blobName(space, e.kind, e.doc.id, oid)
        const d = await this.download(c, name, e.kind)
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
   * Returns false when the local item changed (or vanished) meanwhile.
   */
  private writeBack(snapshot: CacheEntry, mode: 'uploaded' | 'downloaded', doc: Doc, sync: SyncState): Promise<boolean> {
    return this.o.cache.lock(async () => {
      const cur = await this.o.cache.get(snapshot.kind, snapshot.doc.id)
      if (!cur) return false
      if (serializeDoc(cur.kind, cur.doc) !== serializeDoc(snapshot.kind, snapshot.doc) || cur.sync.space !== snapshot.sync.space) {
        if (cur.sync.space !== snapshot.sync.space) return false
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
      ref: refOf(kind, e.doc, e.sync.space),
      reason: e.sync.conflict.reason,
      mine: e.doc,
      theirs,
      ...(e.sync.conflict.remoteUpdatedBy ? { remoteUpdatedBy: e.sync.conflict.remoteUpdatedBy } : {}),
      ...(e.sync.conflict.remoteUpdatedAt ? { remoteUpdatedAt: e.sync.conflict.remoteUpdatedAt } : {})
    }
  }

  async resolveConflict(kind: ItemKind, id: Id, resolution: ConflictResolution, opts: { acknowledgeWarnings?: boolean } = {}): Promise<ResolveConflictResult> {
    const copy = await this.o.cache.lock(async (): Promise<ItemRef | undefined> => {
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
        await this.o.cache.put(kind, mine, { space: e.sync.space, dirty: e.sync.space !== 'local', ...(e.sync.ownerOid ? { ownerOid: e.sync.ownerOid } : {}) })
        await this.o.cache.put(kind, theirs, { ...e.sync, etag: conflict.remoteEtag, dirty: false, conflict: undefined, notice: undefined, lastSyncedAt: now })
        copy = refOf(kind, mine, e.sync.space)
      }
      await this.o.cache.removeConflictCopy(kind, id)
      return copy
    })
    const report = await this.run(opts)
    return { ...(copy ? { copy } : {}), report }
  }

  /**
   * Throw away local changes to a cloud item (edits or a pending delete); the remote version is
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
      if (e.sync.space === 'local') throw new Fault('INVALID_ARGUMENT', 'Local items have no remote version to go back to.')
      if (!e.sync.etag) throw new Fault('INVALID_ARGUMENT', 'This item was never uploaded; delete it instead.')
      await this.o.cache.remove(kind, id)
    })
  }

  /** Best-effort immediate remote delete for a tombstone (stays queued on failure). */
  async flushTombstone(t: Tombstone): Promise<void> {
    const c = this.o.container()
    const who = this.o.identity()
    if (!c || !who) return
    if (t.space === 'personal' && t.ownerOid !== who.oid) return
    try {
      const name = blobName(t.space, t.kind, t.id, t.ownerOid)
      await c.getBlockBlobClient(name).delete(t.etag ? { conditions: { ifMatch: quoted(t.etag) } } : {})
      await this.o.cache.removeTombstone(t)
    } catch (err) {
      const st = statusOf(err)
      if (st === 404) await this.o.cache.removeTombstone(t)
      // 412 and transient errors are handled by the next full sync.
    }
  }
}
