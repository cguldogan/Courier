/**
 * UI actions: everything that talks to the engine and then reconciles renderer state.
 */
import type { ItemKind, Space } from '../../shared/types'
import { type Collection, type Folder, type Id, type Item, type RequestDef, type Variable, findItem, newFolder, newId, newRequest } from '../../shared/types'
import type { SyncReport } from '../../shared/api'
import { attempt, call, courier } from './api'
import {
  type ContainerDraft,
  type ContainerTab,
  type EnvironmentTab,
  type RequestTab,
  type Tab,
  type VarRow,
  editorRequest,
  getCollection,
  isDirty,
  locate,
  newTabId,
  useApp
} from './store'

const st = useApp.getState

// ---------------------------------------------------------------------------------------------
// Loading / reconciling
// ---------------------------------------------------------------------------------------------

export async function loadAll(): Promise<void> {
  const c = courier()
  const [info, settings, identity, sync, history] = await Promise.all([
    attempt(c.app.info()),
    attempt(c.settings.get()),
    attempt(c.identity.status()),
    attempt(c.sync.status()),
    attempt(c.history.list())
  ])
  st().set({ info: info ?? null, settings: settings ?? null, identity: identity ?? null, sync: sync ?? null, history: history ?? [] })
  await reloadWorkspace()
}

export async function reloadHistory(): Promise<void> {
  const h = await attempt(courier().history.list())
  if (h) st().set({ history: h })
}

let reloadChain: Promise<void> = Promise.resolve()
export function reloadWorkspace(): Promise<void> {
  reloadChain = reloadChain.then(doReload, doReload)
  return reloadChain
}

async function doReload(): Promise<void> {
  const snap = await attempt(courier().workspace.load())
  if (!snap) return
  st().set({ snapshot: snap })
  reconcileTabs()
}

/** After the workspace changed: clean tabs follow the saved copy, dirty tabs keep their draft. */
function reconcileTabs(): void {
  const s = st()
  const snap = s.snapshot
  if (!snap) return
  let changed = false
  const tabs: Tab[] = s.tabs.map((t): Tab => {
    if (t.kind === 'request' && t.requestId && t.collectionId) {
      const found = locate(t.collectionId, t.requestId)
      if (!found || found.item.type !== 'request') {
        changed = true
        // Target is gone: keep the work as an unsaved draft.
        return { ...t, requestId: null, collectionId: getCollection(t.collectionId) ? t.collectionId : null, draft: { ...t.draft, id: newId() }, baseline: '' }
      }
      const saved = editorRequest(found.item)
      const savedJson = JSON.stringify(saved)
      if (savedJson === t.baseline) return t
      changed = true
      if (!isDirty(t)) return { ...t, draft: saved, baseline: savedJson }
      return { ...t, baseline: savedJson }
    }
    if (t.kind === 'request' && t.collectionId && !getCollection(t.collectionId)) {
      changed = true
      return { ...t, collectionId: null }
    }
    if (t.kind === 'container') {
      const d = containerDraft(t.collectionId, t.folderId)
      if (!d) {
        changed = true
        return { ...t, baseline: isDirty(t) ? '__gone__' : '__remove__' }
      }
      const j = JSON.stringify(d)
      if (j === t.baseline) return t
      changed = true
      return isDirty(t) ? { ...t, baseline: j } : { ...t, draft: d, baseline: j }
    }
    if (t.kind === 'environment') {
      const d = environmentDraft(t.environmentId)
      if (!d) {
        changed = true
        return { ...t, baseline: isDirty(t) ? '__gone__' : '__remove__' }
      }
      const j = JSON.stringify(d)
      if (j === t.baseline) return t
      changed = true
      return isDirty(t) ? { ...t, baseline: j } : { ...t, draft: d, baseline: j }
    }
    if (t.kind === 'globals') {
      const j = JSON.stringify(snap.globals)
      if (j === t.baseline) return t
      changed = true
      return isDirty(t) ? { ...t, baseline: j } : { ...t, draft: structuredClone(snap.globals), baseline: j }
    }
    return t
  })
  // Close tabs whose environment/container vanished and that had no edits (edited ones stay, flagged).
  const kept = tabs.filter((t) => !((t.kind === 'container' || t.kind === 'environment') && t.baseline === '__remove__'))
  if (changed) {
    const active = kept.some((t) => t.id === s.activeTabId) ? s.activeTabId : (kept[kept.length - 1]?.id ?? null)
    s.set({ tabs: kept, activeTabId: active })
  }
}

// ---------------------------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------------------------

export function openRequest(collectionId: Id, requestId: Id): void {
  const s = st()
  const existing = s.tabs.find((t) => t.kind === 'request' && t.requestId === requestId && t.collectionId === collectionId)
  if (existing) return s.activate(existing.id)
  const found = locate(collectionId, requestId)
  if (!found || found.item.type !== 'request') return
  const draft = editorRequest(found.item)
  s.openTab({ kind: 'request', id: newTabId(), collectionId, requestId, draft, baseline: JSON.stringify(draft) })
}

export function openDraft(req?: RequestDef, collectionId: Id | null = null): void {
  const draft = editorRequest(req ? { ...req, id: newId() } : newRequest({ name: 'Untitled Request' }))
  st().openTab({ kind: 'request', id: newTabId(), collectionId, requestId: null, draft, baseline: '' })
}

function varRows(vars: Variable[], current: Record<string, string> | undefined): VarRow[] {
  return vars.map((v) => ({ ...v, current: current && Object.prototype.hasOwnProperty.call(current, v.key) ? current[v.key] : '' }))
}

export function containerDraft(collectionId: Id, folderId: Id | null): ContainerDraft | null {
  const c = getCollection(collectionId)
  if (!c) return null
  if (!folderId) {
    const cur = st().snapshot?.currentValues.collections[c.id]
    return { name: c.name, description: c.description, auth: c.auth, preRequestScript: c.preRequestScript, testScript: c.testScript, variables: varRows(c.variables, cur) }
  }
  const f = findItem(c.items, folderId)
  if (!f || f.item.type !== 'folder') return null
  const it = f.item
  return { name: it.name, description: it.description, auth: it.auth, preRequestScript: it.preRequestScript, testScript: it.testScript, variables: [] }
}

export function environmentDraft(environmentId: Id): EnvironmentTab['draft'] | null {
  const snap = st().snapshot
  const e = snap?.environments.find((x) => x.environment.id === environmentId)?.environment
  if (!e) return null
  return { name: e.name, variables: varRows(e.variables, snap?.currentValues.environments[e.id]) }
}

export function openContainer(collectionId: Id, folderId: Id | null): void {
  const s = st()
  const existing = s.tabs.find((t) => t.kind === 'container' && t.collectionId === collectionId && t.folderId === folderId)
  if (existing) return s.activate(existing.id)
  const d = containerDraft(collectionId, folderId)
  if (!d) return
  s.openTab({ kind: 'container', id: newTabId(), collectionId, folderId, draft: d, baseline: JSON.stringify(d) })
}

/** Opens the collection's settings at the "scripts may read Key Vault secrets" toggle. */
export function openScriptVaultSetting(collectionId: Id): void {
  openContainer(collectionId, null)
  const s = st()
  const t = s.tabs.find((x) => x.kind === 'container' && x.collectionId === collectionId && x.folderId === null)
  if (t) s.updateTab(t.id, (x) => ({ ...x, focusVaultAccess: Date.now() }) as Tab)
}

export function openEnvironment(environmentId: Id): void {
  const s = st()
  const existing = s.tabs.find((t) => t.kind === 'environment' && t.environmentId === environmentId)
  if (existing) return s.activate(existing.id)
  const d = environmentDraft(environmentId)
  if (!d) return
  s.openTab({ kind: 'environment', id: newTabId(), environmentId, draft: d, baseline: JSON.stringify(d) })
}

export function openGlobals(): void {
  const s = st()
  const existing = s.tabs.find((t) => t.kind === 'globals')
  if (existing) return s.activate(existing.id)
  const g = s.snapshot?.globals ?? []
  s.openTab({ kind: 'globals', id: newTabId(), draft: structuredClone(g), baseline: JSON.stringify(g) })
}

export function openRunner(collectionId: Id | null, folderId: Id | null = null): void {
  const s = st()
  const existing = s.tabs.find((t) => t.kind === 'runner' && !t.runId)
  if (existing) {
    s.updateTab(existing.id, (t) => ({ ...t, collectionId, folderId }) as Tab)
    return s.activate(existing.id)
  }
  s.openTab({ kind: 'runner', id: newTabId(), collectionId, folderId })
}

export function requestCloseTab(id: string): void {
  const s = st()
  const t = s.tabs.find((x) => x.id === id)
  if (!t) return
  if (t.kind === 'request' && t.sending && t.executionId) void courier().requests.cancel(t.executionId)
  if (!isDirty(t) || (t.kind !== 'request' && (t as ContainerTab).baseline === '__gone__')) return s.closeTab(id)
  s.openDialog({
    type: 'confirm',
    title: 'Unsaved changes',
    message: `"${tabTitle(t)}" has unsaved changes. Save them before closing?`,
    confirmLabel: 'Save',
    alt: { label: "Don't save", onClick: () => st().closeTab(id) },
    onConfirm: async () => {
      const ok = await saveTab(id, { closeAfter: true })
      if (ok) st().closeTab(id)
    }
  })
}

export function tabTitle(t: Tab): string {
  switch (t.kind) {
    case 'request':
      return t.draft.name || 'Untitled Request'
    case 'container':
      return t.draft.name || 'Settings'
    case 'environment':
      return t.draft.name || 'Environment'
    case 'globals':
      return 'Globals'
    case 'runner':
      return 'Runner'
  }
}

// ---------------------------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------------------------

/** Returns true when saved (false if cancelled or failed). Unsaved request drafts open "Save As". */
export async function saveTab(id: string, opts: { closeAfter?: boolean } = {}): Promise<boolean> {
  const s = st()
  const t = s.tabs.find((x) => x.id === id)
  if (!t) return false
  try {
    if (t.kind === 'request') {
      if (!t.requestId || !t.collectionId || !locate(t.collectionId, t.requestId)) {
        s.openDialog({ type: 'saveAs', tabId: id, closeAfter: opts.closeAfter })
        return false
      }
      await saveRequestTo(t, t.collectionId, null, false)
      return true
    }
    if (t.kind === 'container') return await saveContainer(t)
    if (t.kind === 'environment') return await saveEnvironment(t)
    if (t.kind === 'globals') {
      await call(courier().variables.setGlobals(t.draft.filter((v) => v.key)))
      await reloadWorkspace()
      st().updateTab(id, (x) => ({ ...x, baseline: JSON.stringify((x as typeof t).draft) }) as Tab)
      return true
    }
  } catch {
    return false
  }
  return false
}

/** Save a request tab's draft. `asNew` writes a copy (fresh id) into `collectionId`/`parentId`. */
export async function saveRequestTo(t: RequestTab, collectionId: Id, parentId: Id | null, asNew: boolean, name?: string): Promise<void> {
  const item: RequestDef = { ...t.draft, ...(name ? { name } : {}), ...(asNew ? { id: newId() } : {}) }
  const input = asNew || !t.requestId ? { collectionId, parentId, item } : { collectionId, item }
  await call(courier().collections.upsertItem(input))
  await reloadWorkspace()
  const draft = editorRequest(item)
  st().updateTab(t.id, () => ({ ...t, ...st().tabs.find((x) => x.id === t.id), draft, collectionId, requestId: item.id, baseline: JSON.stringify(draft) }) as RequestTab)
  st().set({ expanded: { ...st().expanded, [collectionId]: true, ...(parentId ? { [parentId]: true } : {}) } })
  st().toast('success', `Saved "${item.name}"`)
}

async function saveContainer(t: ContainerTab): Promise<boolean> {
  const c = getCollection(t.collectionId)
  if (!c) {
    st().toast('error', 'The collection no longer exists.')
    return false
  }
  const d = t.draft
  if (!t.folderId) {
    const vars: Variable[] = d.variables.filter((v) => v.key).map(({ current: _c, ...v }) => (v.type === 'secret' ? { ...v, value: '' } : v))
    const next: Collection = { ...c, name: d.name, description: d.description, auth: d.auth, preRequestScript: d.preRequestScript, testScript: d.testScript, variables: vars }
    await call(courier().collections.save(next))
    await saveCurrentValues('collection', c.id, d.variables)
  } else {
    const found = findItem(c.items, t.folderId)
    if (!found || found.item.type !== 'folder') {
      st().toast('error', 'The folder no longer exists.')
      return false
    }
    const parentId = found.parents.length ? found.parents[found.parents.length - 1].id : null
    const folder: Folder = { ...found.item, name: d.name, description: d.description, auth: d.auth, preRequestScript: d.preRequestScript, testScript: d.testScript }
    await call(courier().collections.upsertItem({ collectionId: c.id, parentId, item: folder }))
  }
  await reloadWorkspace()
  const fresh = containerDraft(t.collectionId, t.folderId)
  if (fresh) st().updateTab(t.id, (x) => ({ ...x, draft: fresh, baseline: JSON.stringify(fresh) }) as Tab)
  st().toast('success', `Saved "${d.name}"`)
  return true
}

/** Replace current values for a scope, keeping undeclared (script-set) keys. */
async function saveCurrentValues(scope: 'environment' | 'collection', id: Id, rows: VarRow[]): Promise<void> {
  const snap = st().snapshot
  const existing = (scope === 'collection' ? snap?.currentValues.collections[id] : snap?.currentValues.environments[id]) ?? {}
  const declared = new Set(rows.map((r) => r.key))
  const values: Record<string, string> = {}
  for (const [k, v] of Object.entries(existing)) if (!declared.has(k)) values[k] = v
  for (const r of rows) {
    if (!r.key) continue
    if (r.type === 'secret') {
      const v = r.current !== '' ? r.current : r.value
      if (v !== '') values[r.key] = v
    } else if (r.current !== '') values[r.key] = r.current
  }
  await call(courier().variables.setCurrentValues({ scope, id, values }))
}

async function saveEnvironment(t: EnvironmentTab): Promise<boolean> {
  const snap = st().snapshot
  const e = snap?.environments.find((x) => x.environment.id === t.environmentId)?.environment
  if (!e) {
    st().toast('error', 'The environment no longer exists.')
    return false
  }
  const vars: Variable[] = t.draft.variables.filter((v) => v.key).map(({ current: _c, ...v }) => (v.type === 'secret' ? { ...v, value: '' } : v))
  await call(courier().environments.save({ ...e, name: t.draft.name, variables: vars }))
  await saveCurrentValues('environment', e.id, t.draft.variables)
  await reloadWorkspace()
  const fresh = environmentDraft(e.id)
  if (fresh) st().updateTab(t.id, (x) => ({ ...x, draft: fresh, baseline: JSON.stringify(fresh) }) as Tab)
  st().toast('success', `Saved "${t.draft.name}"`)
  return true
}

// ---------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------

export async function sendTab(id: string): Promise<void> {
  const s = st()
  const t = s.tabs.find((x) => x.id === id)
  if (!t || t.kind !== 'request' || t.sending) return
  if (!t.draft.url.trim()) {
    s.toast('error', 'Enter a URL first.')
    return
  }
  const executionId = newId()
  s.updateTab(id, (x) => ({ ...x, sending: true, executionId }) as Tab)
  const savedHere = t.collectionId && t.requestId && locate(t.collectionId, t.requestId)
  const r = await courier().requests.send({
    executionId,
    collectionId: t.collectionId ?? null,
    requestId: savedHere ? t.requestId : null,
    draft: t.draft
  })
  st().updateTab(id, (x) => ({ ...x, sending: false, executionId: undefined, ...(r.ok ? { result: r.value } : {}) }) as Tab)
  if (!r.ok) st().toast('error', r.error.message)
}

export async function cancelTab(id: string): Promise<void> {
  const t = st().tabs.find((x) => x.id === id)
  if (t?.kind === 'request' && t.executionId) await attempt(courier().requests.cancel(t.executionId))
}

// ---------------------------------------------------------------------------------------------
// Collections tree operations
// ---------------------------------------------------------------------------------------------

export async function createCollection(name: string, space: Space): Promise<void> {
  const e = await attempt(courier().collections.create({ name, space }))
  if (!e) return
  await reloadWorkspace()
  st().set({ expanded: { ...st().expanded, [e.collection.id]: true }, sidebarTab: 'collections' })
}

export async function addRequest(collectionId: Id, parentId: Id | null, name = 'New Request'): Promise<void> {
  const item = newRequest({ name })
  const ok = await attempt(courier().collections.upsertItem({ collectionId, parentId, item }))
  if (!ok) return
  await reloadWorkspace()
  st().set({ expanded: { ...st().expanded, [collectionId]: true, ...(parentId ? { [parentId]: true } : {}) } })
  openRequest(collectionId, item.id)
}

export async function addFolder(collectionId: Id, parentId: Id | null, name: string): Promise<void> {
  const item = newFolder({ name })
  const ok = await attempt(courier().collections.upsertItem({ collectionId, parentId, item }))
  if (!ok) return
  await reloadWorkspace()
  st().set({ expanded: { ...st().expanded, [collectionId]: true, ...(parentId ? { [parentId]: true } : {}), [item.id]: true } })
}

export async function renameItem(collectionId: Id, itemId: Id, name: string): Promise<void> {
  const found = locate(collectionId, itemId)
  if (!found || !name.trim()) return
  const parentId = found.parents.length ? found.parents[found.parents.length - 1].id : null
  const ok = await attempt(courier().collections.upsertItem({ collectionId, parentId, item: { ...found.item, name: name.trim() } as Item }))
  if (!ok) return
  // Keep an open (possibly dirty) tab's name in step with the rename.
  for (const t of st().tabs) {
    if (t.kind === 'request' && t.requestId === itemId) {
      const base = t.baseline ? { ...JSON.parse(t.baseline), name: name.trim() } : null
      st().updateTab(t.id, (x) => ({ ...x, draft: { ...(x as RequestTab).draft, name: name.trim() }, baseline: base ? JSON.stringify(base) : '' }) as Tab)
    }
  }
  await reloadWorkspace()
}

export async function renameCollection(id: Id, name: string): Promise<void> {
  const c = getCollection(id)
  if (!c || !name.trim()) return
  const ok = await attempt(courier().collections.save({ ...c, name: name.trim() }))
  if (ok) await reloadWorkspace()
}

function reid(items: Item[]): Item[] {
  return items.map((it) => (it.type === 'folder' ? { ...it, id: newId(), items: reid(it.items) } : { ...it, id: newId() }))
}

export async function duplicateItem(collectionId: Id, itemId: Id): Promise<void> {
  const found = locate(collectionId, itemId)
  if (!found) return
  const parentId = found.parents.length ? found.parents[found.parents.length - 1].id : null
  const list = found.parents.length ? found.parents[found.parents.length - 1].items : (getCollection(collectionId)?.items ?? [])
  const index = list.findIndex((x) => x.id === itemId) + 1
  const copy = reid([structuredClone(found.item)])[0]
  copy.name = `${found.item.name} Copy`
  const ok = await attempt(courier().collections.upsertItem({ collectionId, parentId, item: copy, index }))
  if (ok) await reloadWorkspace()
}

export async function deleteItem(collectionId: Id, itemId: Id): Promise<void> {
  const ok = await attempt(courier().collections.deleteItem({ collectionId, itemId }))
  if (ok) await reloadWorkspace()
}

export async function moveItem(collectionId: Id, itemId: Id, parentId: Id | null, index: number): Promise<void> {
  const ok = await attempt(courier().collections.moveItem({ collectionId, itemId, parentId, index }))
  if (ok) await reloadWorkspace()
}

/** Move to another collection: insert a copy there, then delete the original. */
export async function moveItemToCollection(fromCollectionId: Id, itemId: Id, toCollectionId: Id, parentId: Id | null): Promise<void> {
  const found = locate(fromCollectionId, itemId)
  if (!found) return
  const ok = await attempt(courier().collections.upsertItem({ collectionId: toCollectionId, parentId, item: found.item }))
  if (!ok) return
  await attempt(courier().collections.deleteItem({ collectionId: fromCollectionId, itemId }))
  for (const t of st().tabs) if (t.kind === 'request' && t.requestId === itemId) st().updateTab(t.id, (x) => ({ ...x, collectionId: toCollectionId }) as Tab)
  await reloadWorkspace()
}

/** Move a collection/environment between spaces, with the secret-scan warning flow for `shared`. */
export async function moveToSpace(kind: ItemKind, id: Id, name: string, space: Space): Promise<void> {
  const api = kind === 'collection' ? courier().collections : courier().environments
  const r = await attempt(api.move({ id, space }))
  if (!r) return
  if (!r.moved && r.warnings.length) {
    st().openDialog({
      type: 'warnings',
      title: `Move "${name}" to Shared?`,
      findings: r.warnings,
      proceedLabel: 'Move anyway',
      onProceed: async () => {
        const again = await attempt(api.move({ id, space, acknowledgeWarnings: true }))
        if (again?.moved) {
          st().toast('success', `Moved "${name}" to ${spaceLabel(space)}`)
          await reloadWorkspace()
        }
      }
    })
    return
  }
  if (r.moved) {
    st().toast('success', `Moved "${name}" to ${spaceLabel(space)}${space !== 'local' ? ' — sync to upload it' : ''}`)
    await reloadWorkspace()
  }
}

export function spaceLabel(s: Space): string {
  return s === 'local' ? 'Local' : s === 'personal' ? 'Personal' : 'Shared'
}

// ---------------------------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------------------------

export async function runSync(acknowledgeWarnings = false): Promise<SyncReport | undefined> {
  const r = await attempt(courier().sync.run({ acknowledgeWarnings }), { context: 'Sync failed' })
  if (!r) return undefined
  handleReport(r)
  return r
}

export function handleReport(r: SyncReport, opts: { silentSuccess?: boolean } = {}): void {
  const s = st()
  s.set({ lastReport: r })
  for (const e of r.errors) s.toast('error', e.ref ? `${e.ref.name}: ${e.message}` : e.message)
  for (const n of r.notices) s.toast('info', `${n.ref.name}: ${n.message}`)
  if (r.blocked.length) {
    s.openDialog({
      type: 'warnings',
      title: 'Possible secrets in shared items',
      findings: r.blocked.flatMap((b) => b.findings),
      proceedLabel: 'Upload anyway',
      onProceed: async () => {
        await runSync(true)
      }
    })
  }
  if (r.conflicts.length) {
    const c = r.conflicts[0]
    s.openDialog({ type: 'conflict', kind: c.kind, id: c.id })
  }
  if (!opts.silentSuccess && !r.errors.length && !r.conflicts.length && !r.blocked.length) {
    const parts = [
      r.uploaded.length ? `${r.uploaded.length} uploaded` : '',
      r.downloaded.length ? `${r.downloaded.length} downloaded` : '',
      r.deletedRemotely.length ? `${r.deletedRemotely.length} deleted remotely` : '',
      r.removedLocally.length ? `${r.removedLocally.length} removed locally` : ''
    ].filter(Boolean)
    s.toast('success', parts.length ? `Synced: ${parts.join(', ')}` : 'Everything is up to date')
  }
}

export async function signIn(): Promise<void> {
  const st0 = st()
  st0.set({ identity: st0.identity ? { ...st0.identity, busy: true } : st0.identity })
  const r = await attempt(courier().identity.signIn(), { context: 'Sign-in failed' })
  if (r) {
    st().set({ identity: r })
    if (r.signedIn) st().toast('success', `Signed in as ${r.account?.upn ?? r.account?.name ?? 'Azure identity'}`)
    else if (r.error) st().toast('error', r.error)
  } else {
    const s = await attempt(courier().identity.status(), { quiet: true })
    if (s) st().set({ identity: s })
  }
}

export async function signOut(): Promise<void> {
  const r = await attempt(courier().identity.signOut())
  if (r) st().set({ identity: r })
}

export async function updateUi(patch: Record<string, unknown>): Promise<void> {
  const r = await attempt(courier().settings.update({ ui: patch }))
  if (r) st().set({ settings: r })
}
