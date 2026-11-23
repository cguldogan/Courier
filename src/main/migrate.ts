/**
 * One-time migration from the "spaces" layout (local / personal / shared, one storage account in
 * settings) to Personal + Teams. Runs at startup before anything else reads userData; idempotent
 * and safe to re-run after a crash (every step can be repeated).
 *
 *  - `settings.storage` (when an account URL was set) becomes one team named "Team"; the name is
 *    replaced by the manifest's on the first sync if the container has a `courier-team.json`.
 *    An existing team with the same account URL + container is reused.
 *  - `shared` items move to that team's cache keeping etag, dirty flag, conflict (with its
 *    conflict copy) and notice; their pending deletes become the team's pending deletes.
 *  - `personal` items (the old per-user blob prefix) become Personal items: their sync state and
 *    conflict copies are dropped and their pending deletes are discarded. Their remote blobs are
 *    left untouched.
 *  - `local` items are Personal items already (same directory).
 *  - `storage` is removed from settings.json last. Everything else in userData (current values,
 *    script → Key Vault grants, history, cookies…) is keyed by item id and keeps working.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ItemKind, SyncState } from '../shared/types'
import { newId } from '../shared/types'
import { isValidId } from '../shared/serialize'
import { JsonFile } from './store'
import type { TeamStore } from './teams'
import { cacheRoot, type Tombstone } from './workspace'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const DIRS: Record<ItemKind, string> = { collection: 'collections', environment: 'environments' }

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err
  }
}

function legacySync(s: Obj): SyncState {
  const out: SyncState = { dirty: s.dirty === true }
  if (typeof s.etag === 'string') out.etag = s.etag
  if (typeof s.lastSyncedAt === 'string') out.lastSyncedAt = s.lastSyncedAt
  if (isObj(s.conflict)) out.conflict = s.conflict as unknown as SyncState['conflict']
  if (typeof s.notice === 'string') out.notice = s.notice
  return out
}

/** Returns true when something was migrated. */
export async function migrateSpacesToTeams(userDataDir: string, teams: TeamStore): Promise<boolean> {
  const dataDir = join(userDataDir, 'data')
  const settingsPath = join(userDataDir, 'settings.json')
  const statePath = join(dataDir, 'state.json')
  const settings = await readJson(settingsPath)
  const state = await readJson(statePath)
  const storage = isObj(settings) && isObj(settings.storage) ? settings.storage : null
  const items = isObj(state) && isObj(state.items) ? state.items : {}
  const tombs = isObj(state) && Array.isArray(state.tombstones) ? state.tombstones.filter(isObj) : []
  const legacyState = Object.values(items).some((s) => isObj(s) && 'space' in s) || tombs.some((t) => 'space' in t)
  if (!storage && !legacyState) return false

  // 1. the storage setting → a team (reused when re-running)
  let teamId: string | null = null
  const accountUrl = storage && typeof storage.accountUrl === 'string' ? storage.accountUrl.trim().replace(/\/+$/, '') : ''
  if (accountUrl) {
    const container = typeof storage?.container === 'string' && storage.container.trim() ? storage.container.trim() : 'courier'
    const existing = teams.findByLocation({ accountUrl, container })
    if (existing) teamId = existing.id
    else {
      teamId = newId()
      await teams.add({ id: teamId, name: 'Team', accountUrl, container, joinedAt: new Date().toISOString(), manifest: null })
    }
  }

  // 2. shared items → the team cache (state first, then the files, so a re-run finishes the job)
  if (legacyState) {
    const personal: Record<string, SyncState> = {}
    const teamItems: Record<string, SyncState> = {}
    const teamTombs: Tombstone[] = []
    const teamRoot = teamId ? cacheRoot(dataDir, teamId) : null
    if (teamRoot) for (const d of ['collections', 'environments', 'conflicts']) await mkdir(join(teamRoot, d), { recursive: true })
    for (const [key, raw] of Object.entries(items)) {
      const m = /^(collection|environment):(.+)$/.exec(key)
      if (!m || !isValidId(m[2]) || !isObj(raw)) continue
      const kind = m[1] as ItemKind
      const id = m[2]
      const conflictFile = join(dataDir, 'conflicts', `${kind}-${id}.json`)
      if (raw.space === 'shared' && teamRoot) {
        teamItems[key] = legacySync(raw)
        continue
      }
      // local, personal (and shared without a storage account): Personal, no sync state
      if (raw.space === 'personal' || raw.space === 'shared') await rm(conflictFile, { force: true })
      personal[key] = { dirty: false }
    }
    if (teamRoot) {
      for (const t of tombs) {
        if (t.space !== 'shared' || (t.kind !== 'collection' && t.kind !== 'environment') || !isValidId(t.id)) continue
        teamTombs.push({ kind: t.kind, id: t.id as string, name: typeof t.name === 'string' ? t.name : String(t.id), ...(typeof t.etag === 'string' ? { etag: t.etag } : {}) })
      }
      const teamState = new JsonFile<{ items: Record<string, SyncState>; tombstones: Tombstone[] }>(join(teamRoot, 'state.json'), () => ({ items: {}, tombstones: [] }))
      await teamState.update((s) => {
        const merged = { items: { ...(isObj(s.items) ? s.items : {}), ...teamItems }, tombstones: Array.isArray(s.tombstones) ? [...s.tombstones] : [] }
        for (const t of teamTombs) if (!merged.tombstones.some((x) => x.kind === t.kind && x.id === t.id)) merged.tombstones.push(t)
        return merged
      })
      for (const key of Object.keys(teamItems)) {
        const [kind, id] = key.split(':') as [ItemKind, string]
        await move(join(dataDir, DIRS[kind], `${id}.json`), join(teamRoot, DIRS[kind], `${id}.json`))
        await move(join(dataDir, 'conflicts', `${kind}-${id}.json`), join(teamRoot, 'conflicts', `${kind}-${id}.json`))
      }
    }
    // Personal state no longer carries spaces; this is what makes the migration "done".
    await writeFile(statePath, JSON.stringify({ items: personal, tombstones: [] }, null, 2) + '\n', 'utf8')
  }

  // 3. drop the old storage setting last
  if (isObj(settings) && 'storage' in settings) {
    const { storage: _old, ...rest } = settings
    void _old
    const tmp = `${settingsPath}.${process.pid}.migrate.tmp`
    await writeFile(tmp, JSON.stringify(rest, null, 2) + '\n', 'utf8')
    await rename(tmp, settingsPath)
  }
  return true
}
