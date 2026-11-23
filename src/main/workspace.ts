/**
 * Local document cache (userData/data). Holds every collection/environment of every space, plus the
 * per-item sync state, pending remote deletes (tombstones) and the remote copy of conflicted items.
 *
 *   data/collections/<id>.json     canonical doc (same bytes as the blob)
 *   data/environments/<id>.json
 *   data/conflicts/<kind>-<id>.json  remote ("theirs") version while a conflict is open
 *   data/state.json                { items: { "<kind>:<id>": SyncState }, tombstones: [...] }
 *
 * Ids are validated (`[A-Za-z0-9_-]{1,64}`) before they ever become path components.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Collection, Environment, Id, ItemKind, Space, SyncState } from '../shared/types'
import { isValidId, normalizeCollection, normalizeEnvironment, serializeCollection, serializeEnvironment } from '../shared/serialize'
import { Fault } from './errors'
import { JsonFile } from './store'

export type Doc = Collection | Environment

export interface Tombstone {
  kind: ItemKind
  id: Id
  name: string
  space: Exclude<Space, 'local'>
  ownerOid?: string
  etag?: string
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

export class LocalCache {
  private readonly state: JsonFile<StateFile>
  private lockChain: Promise<unknown> = Promise.resolve()

  /**
   * Serialises read-modify-write sequences on docs (UI saves vs. sync write-backs).
   * Never call `lock` from inside a locked section.
   */
  lock<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.lockChain.then(fn, fn)
    this.lockChain = p.catch(() => undefined)
    return p
  }

  constructor(readonly root: string) {
    this.state = new JsonFile(join(root, 'state.json'), () => ({ items: {}, tombstones: [] }))
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
        out.push({ kind, doc, sync: state.items[`${kind}:${id}`] ?? { space: 'local', dirty: false } })
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
    return { kind, doc, sync: state.items[`${kind}:${id}`] ?? { space: 'local', dirty: false } }
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
    await this.state.update((s) => {
      const st = { items: s.items ?? {}, tombstones: s.tombstones ?? [] }
      st.items[`${kind}:${doc.id}`] = sync
      return st
    })
    return { kind, doc: parseDoc(kind, serializeDoc(kind, doc)), sync }
  }

  async setSync(kind: ItemKind, id: Id, fn: (s: SyncState) => SyncState): Promise<void> {
    await this.state.update((s) => {
      const st = { items: s.items ?? {}, tombstones: s.tombstones ?? [] }
      const key = `${kind}:${id}`
      st.items[key] = fn(st.items[key] ?? { space: 'local', dirty: false })
      return st
    })
  }

  async remove(kind: ItemKind, id: Id, tombstone?: Tombstone): Promise<void> {
    await rm(this.docPath(kind, id), { force: true })
    await rm(this.conflictPath(kind, id), { force: true })
    await this.state.update((s) => {
      const st = { items: s.items ?? {}, tombstones: s.tombstones ?? [] }
      delete st.items[`${kind}:${id}`]
      if (tombstone) st.tombstones = [...st.tombstones.filter((t) => !(t.kind === tombstone.kind && t.id === tombstone.id && t.space === tombstone.space)), tombstone]
      return st
    })
  }

  async addTombstone(t: Tombstone): Promise<void> {
    await this.state.update((s) => ({
      items: s.items ?? {},
      tombstones: [...(s.tombstones ?? []).filter((x) => !(x.kind === t.kind && x.id === t.id && x.space === t.space)), t]
    }))
  }

  async tombstones(): Promise<Tombstone[]> {
    return (await this.readState()).tombstones
  }

  async removeTombstone(t: Pick<Tombstone, 'kind' | 'id' | 'space'>): Promise<void> {
    await this.state.update((s) => ({
      items: s.items ?? {},
      tombstones: (s.tombstones ?? []).filter((x) => !(x.kind === t.kind && x.id === t.id && x.space === t.space))
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
