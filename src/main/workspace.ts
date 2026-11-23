/**
 * Local document caches (userData/data). There is one cache per *home*: Personal and each joined
 * team. A team's cache only ever holds that team's docs, sync state, pending remote deletes
 * (tombstones) and conflict copies, so two teams never share a file, and leaving a team removes
 * its directory.
 *
 *   data/collections/<id>.json                 Personal (this machine only, never uploaded)
 *   data/environments/<id>.json
 *   data/state.json
 *   data/teams/<teamId>/collections/<id>.json  team cache (same bytes as the blob)
 *   data/teams/<teamId>/environments/<id>.json
 *   data/teams/<teamId>/conflicts/<kind>-<id>.json   remote ("theirs") version while a conflict is open
 *   data/teams/<teamId>/state.json             { items: { "<kind>:<id>": SyncState }, tombstones: [...] }
 *
 * Ids are validated (`[A-Za-z0-9_-]{1,64}`) before they ever become path components. All caches
 * share one `Mutex`, because a move between homes touches two of them.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Collection, Environment, Id, ItemKind, SyncState } from '../shared/types'
import { isValidId, normalizeCollection, normalizeEnvironment, serializeCollection, serializeEnvironment } from '../shared/serialize'
import { Fault } from './errors'
import { JsonFile } from './store'

export type Doc = Collection | Environment

export interface Tombstone {
  kind: ItemKind
  id: Id
  name: string
  etag?: string
  /**
   * The item moved to this team: delete the old blob only once the item has been uploaded there
   * (so a blocked or failed upload never loses the remote copy).
   */
  movedToTeam?: Id
}

interface StateFile {
  items: Record<string, SyncState>
  tombstones: Tombstone[]
}

export interface CacheEntry<D extends Doc = Doc> {
  kind: ItemKind
  doc: D
  sync: SyncState
}

const DIRS: Record<ItemKind, string> = { collection: 'collections', environment: 'environments' }

export function serializeDoc(kind: ItemKind, doc: Doc): string {
  return kind === 'collection' ? serializeCollection(doc as Collection) : serializeEnvironment(doc as Environment)
}

export function parseDoc(kind: ItemKind, text: string): Doc {
  const json: unknown = JSON.parse(text)
  return kind === 'collection' ? normalizeCollection(json) : normalizeEnvironment(json)
}

function assertId(id: string): void {
  if (!isValidId(id)) throw new Fault('INVALID_ARGUMENT', `Invalid id "${String(id).slice(0, 80)}".`)
}

async function atomicWrite(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

/** Serialises read-modify-write sequences on docs across all caches (UI saves vs. sync write-backs). */
export class Mutex {
  private chain: Promise<unknown> = Promise.resolve()
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn)
    this.chain = p.catch(() => undefined)
    return p
  }
}

/** Root directory of a home's cache. */
export function cacheRoot(dataDir: string, teamId: Id | null): string {
  if (teamId === null) return dataDir
  assertId(teamId)
  return join(dataDir, 'teams', teamId)
}

export class LocalCache {
  private readonly state: JsonFile<StateFile>

  /**
   * @param teamId null = Personal. Entries read from this cache carry `sync.teamId` accordingly;
   *               whatever `teamId` a caller passes in a SyncState is never stored.
   */
  constructor(
    readonly root: string,
    readonly teamId: Id | null,
    private readonly mutex: Mutex = new Mutex()
  ) {
    this.state = new JsonFile(join(root, 'state.json'), () => ({ items: {}, tombstones: [] }))
  }

  /** Never call `lock` from inside a locked section (of any cache: the mutex is shared). */
  lock<T>(fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(fn)
  }

  private docPath(kind: ItemKind, id: Id): string {
    assertId(id)
    return join(this.root, DIRS[kind], `${id}.json`)
  }

  private conflictPath(kind: ItemKind, id: Id): string {
    assertId(id)
    return join(this.root, 'conflicts', `${kind}-${id}.json`)
  }

  async init(): Promise<void> {
    for (const d of ['collections', 'environments', 'conflicts']) await mkdir(join(this.root, d), { recursive: true })
  }

  /** Remove the whole cache directory (teams only). */
  async destroy(): Promise<void> {
    if (this.teamId === null) throw new Fault('INTERNAL', 'The Personal cache cannot be removed.')
    await rm(this.root, { recursive: true, force: true })
  }

  /** Stored state minus anything that does not belong in it; `teamId` is derived from the home. */
  private withHome(s: SyncState | undefined): SyncState {
    const { teamId: _ignored, ...rest } = s ?? { dirty: false }
    void _ignored
    const base: SyncState = this.teamId === null ? { ...rest, dirty: false } : rest
    return this.teamId === null ? base : { ...base, teamId: this.teamId }
  }

  private stored(s: SyncState): SyncState {
    const { teamId: _ignored, ...rest } = s
    void _ignored
    return rest
  }

  private async readState(): Promise<StateFile> {
    const s = await this.state.read()
    return { items: s.items ?? {}, tombstones: Array.isArray(s.tombstones) ? s.tombstones : [] }
  }

  async list(kind: ItemKind): Promise<CacheEntry[]> {
    const state = await this.readState()
    let files: string[] = []
    try {
      files = await readdir(join(this.root, DIRS[kind]))
    } catch {
      return []
    }
    const out: CacheEntry[] = []
    for (const f of files.sort()) {
      if (!f.endsWith('.json')) continue
      const id = f.slice(0, -5)
      if (!isValidId(id)) continue
      try {
        const doc = parseDoc(kind, await readFile(join(this.root, DIRS[kind], f), 'utf8'))
        if (doc.id !== id) doc.id = id
        out.push({ kind, doc, sync: this.withHome(state.items[`${kind}:${id}`]) })
      } catch {
        // unreadable file: skip (never crash the workspace)
      }
    }
    return out
  }

  async get(kind: ItemKind, id: Id): Promise<CacheEntry | null> {
    const path = this.docPath(kind, id)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return null
    }
    const state = await this.readState()
    const doc = parseDoc(kind, text)
    doc.id = id
    return { kind, doc, sync: this.withHome(state.items[`${kind}:${id}`]) }
  }

  async require(kind: ItemKind, id: Id): Promise<CacheEntry> {
    const e = await this.get(kind, id)
    if (!e) throw new Fault('NOT_FOUND', `${kind === 'collection' ? 'Collection' : 'Environment'} not found.`)
    return e
  }

  /** Writes the doc (canonical bytes) and its sync state. */
  async put(kind: ItemKind, doc: Doc, sync: SyncState): Promise<CacheEntry> {
    await mkdir(join(this.root, DIRS[kind]), { recursive: true })
    await atomicWrite(this.docPath(kind, doc.id), serializeDoc(kind, doc))
    const stored = this.stored(sync)
    await this.state.update((s) => {
      const st = { items: s.items ?? {}, tombstones: s.tombstones ?? [] }
      st.items[`${kind}:${doc.id}`] = stored
      return st
    })
    return { kind, doc: parseDoc(kind, serializeDoc(kind, doc)), sync: this.withHome(stored) }
  }

  async setSync(kind: ItemKind, id: Id, fn: (s: SyncState) => SyncState): Promise<void> {
    await this.state.update((s) => {
      const st = { items: s.items ?? {}, tombstones: s.tombstones ?? [] }
      const key = `${kind}:${id}`
      st.items[key] = this.stored(fn(this.withHome(st.items[key])))
      return st
    })
  }

  async remove(kind: ItemKind, id: Id, tombstone?: Tombstone): Promise<void> {
    await rm(this.docPath(kind, id), { force: true })
    await rm(this.conflictPath(kind, id), { force: true })
    await this.state.update((s) => {
      const st = { items: s.items ?? {}, tombstones: s.tombstones ?? [] }
      delete st.items[`${kind}:${id}`]
      if (tombstone) st.tombstones = [...st.tombstones.filter((t) => !(t.kind === tombstone.kind && t.id === tombstone.id)), tombstone]
      return st
    })
  }

  async addTombstone(t: Tombstone): Promise<void> {
    await this.state.update((s) => ({
      items: s.items ?? {},
      tombstones: [...(s.tombstones ?? []).filter((x) => !(x.kind === t.kind && x.id === t.id)), t]
    }))
  }

  async tombstones(): Promise<Tombstone[]> {
    return (await this.readState()).tombstones
  }

  async removeTombstone(t: Pick<Tombstone, 'kind' | 'id'>): Promise<void> {
    await this.state.update((s) => ({
      items: s.items ?? {},
      tombstones: (s.tombstones ?? []).filter((x) => !(x.kind === t.kind && x.id === t.id))
    }))
  }

  async saveConflictCopy(kind: ItemKind, doc: Doc): Promise<void> {
    await mkdir(join(this.root, 'conflicts'), { recursive: true })
    await atomicWrite(this.conflictPath(kind, doc.id), serializeDoc(kind, doc))
  }

  async loadConflictCopy(kind: ItemKind, id: Id): Promise<Doc | null> {
    try {
      return parseDoc(kind, await readFile(this.conflictPath(kind, id), 'utf8'))
    } catch {
      return null
    }
  }

  async removeConflictCopy(kind: ItemKind, id: Id): Promise<void> {
    await rm(this.conflictPath(kind, id), { force: true })
  }
}
