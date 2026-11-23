/**
 * Renderer state (zustand). The engine owns all persistent data; this store only mirrors what
 * `window.courier` returns plus purely-UI state (open tabs with their unsaved drafts, dialogs, toasts).
 */
import { create } from 'zustand'
import type { AppInfo, SyncOverview, SyncReport } from '../../shared/api'
import type {
  Auth,
  Collection,
  ExecutionResult,
  Folder,
  HistoryEntry,
  Id,
  IdentityStatus,
  Item,
  RequestDef,
  RunItemResult,
  RunSummary,
  Settings,
  Variable,
  WorkspaceSnapshot
} from '../../shared/types'
import { findItem, newId } from '../../shared/types'
import { splitQuery } from '../../shared/variables'

// ---------------------------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------------------------

export interface RequestTab {
  kind: 'request'
  id: string
  collectionId: Id | null
  requestId: Id | null
  draft: RequestDef
  /** JSON of the saved version (editor-normalised); '' for never-saved drafts. */
  baseline: string
  result?: ExecutionResult
  sending?: boolean
  executionId?: string
}

/** Editable variable row: shared value + this machine's current value. */
export interface VarRow extends Variable {
  current: string
}

export interface ContainerDraft {
  name: string
  description: string
  auth: Auth
  preRequestScript: string
  testScript: string
  /** Collection only. */
  variables: VarRow[]
}

export interface ContainerTab {
  kind: 'container'
  id: string
  collectionId: Id
  /** null = the collection itself. */
  folderId: Id | null
  draft: ContainerDraft
  baseline: string
  /** Set (to a timestamp) to bring the "scripts may read Key Vault" setting into view. */
  focusVaultAccess?: number
}

export interface EnvironmentTab {
  kind: 'environment'
  id: string
  environmentId: Id
  draft: { name: string; variables: VarRow[] }
  baseline: string
}

export interface GlobalsTab {
  kind: 'globals'
  id: string
  draft: Variable[]
  baseline: string
}

export interface RunnerTab {
  kind: 'runner'
  id: string
  collectionId: Id | null
  folderId: Id | null
  runId?: string
}

export type Tab = RequestTab | ContainerTab | EnvironmentTab | GlobalsTab | RunnerTab

export function isDirty(t: Tab): boolean {
  switch (t.kind) {
    case 'request':
      return JSON.stringify(t.draft) !== t.baseline
    case 'container':
    case 'environment':
    case 'globals':
      return JSON.stringify(t.draft) !== t.baseline
    default:
      return false
  }
}

/** Editor form of a request: query string moved into `params` so URL bar and Params stay in sync. */
export function editorRequest(r: RequestDef): RequestDef {
  const c = structuredClone(r)
  if (c.url.includes('?')) {
    const { base, params } = splitQuery(c.url)
    c.url = base
    c.params = [...params, ...c.params]
  }
  return c
}

// ---------------------------------------------------------------------------------------------
// Dialogs and toasts
// ---------------------------------------------------------------------------------------------

export type DialogSpec =
  | { type: 'settings'; section?: string }
  | { type: 'sync' }
  | { type: 'conflict'; kind: 'collection' | 'environment'; id: Id }
  | { type: 'vault' }
  | { type: 'cookies' }
  | { type: 'import' }
  | { type: 'export'; kind: 'collection' | 'environment'; id: Id; name: string }
  | { type: 'snippet'; tabId: string }
  | { type: 'saveAs'; tabId: string; closeAfter?: boolean }
  | { type: 'warnings'; title: string; findings: import('../../shared/types').SecretFinding[]; proceedLabel: string; onProceed: () => void | Promise<void> }
  | { type: 'prompt'; title: string; label: string; initial?: string; confirmLabel?: string; spaceChoice?: boolean; onSubmit: (value: string, space?: import('../../shared/types').Space) => void | Promise<void> }
  | { type: 'confirm'; title: string; message: string; confirmLabel?: string; danger?: boolean; alt?: { label: string; onClick: () => void | Promise<void> }; onConfirm: () => void | Promise<void> }

export interface Toast {
  id: number
  kind: 'error' | 'success' | 'info'
  message: string
}

export interface RunState {
  runId: string
  total: number
  completed: number
  results: RunItemResult[]
  summary?: RunSummary
}

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

export interface AppState {
  info: AppInfo | null
  snapshot: WorkspaceSnapshot | null
  settings: Settings | null
  identity: IdentityStatus | null
  sync: SyncOverview | null
  lastReport: SyncReport | null
  history: HistoryEntry[]
  tabs: Tab[]
  activeTabId: string | null
  dialogs: (DialogSpec & { key: number })[]
  toasts: Toast[]
  runs: Record<string, RunState>
  sidebarTab: 'collections' | 'environments' | 'history'
  expanded: Record<string, boolean>
  renaming: string | null

  set: (patch: Partial<AppState>) => void
  toast: (kind: Toast['kind'], message: string) => void
  dismissToast: (id: number) => void
  openDialog: (d: DialogSpec) => void
  closeDialog: () => void
  openTab: (t: Tab) => void
  updateTab: (id: string, fn: (t: Tab) => Tab) => void
  closeTab: (id: string) => void
  activate: (id: string) => void
}

let toastSeq = 1
let dialogSeq = 1

export const useApp = create<AppState>((set, get) => ({
  info: null,
  snapshot: null,
  settings: null,
  identity: null,
  sync: null,
  lastReport: null,
  history: [],
  tabs: [],
  activeTabId: null,
  dialogs: [],
  toasts: [],
  runs: {},
  sidebarTab: 'collections',
  expanded: {},
  renaming: null,

  set: (patch) => set(patch),
  toast: (kind, message) => {
    const id = toastSeq++
    set((s) => ({ toasts: [...s.toasts.filter((t) => t.message !== message), { id, kind, message }].slice(-5) }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 9000 : 4000)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  openDialog: (d) => set((s) => ({ dialogs: [...s.dialogs, { ...d, key: dialogSeq++ }] })),
  closeDialog: () => set((s) => ({ dialogs: s.dialogs.slice(0, -1) })),
  openTab: (t) => set((s) => ({ tabs: [...s.tabs, t], activeTabId: t.id })),
  updateTab: (id, fn) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? fn(t) : t)) })),
  closeTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id)
      const tabs = s.tabs.filter((t) => t.id !== id)
      let activeTabId = s.activeTabId
      if (activeTabId === id) activeTabId = tabs.length ? tabs[Math.min(idx, tabs.length - 1)].id : null
      return { tabs, activeTabId }
    }),
  activate: (id) => set({ activeTabId: id })
}))

// ---------------------------------------------------------------------------------------------
// Selectors / helpers
// ---------------------------------------------------------------------------------------------

export function getCollection(id: Id | null | undefined): Collection | undefined {
  if (!id) return undefined
  return useApp.getState().snapshot?.collections.find((c) => c.collection.id === id)?.collection
}

export function locate(collectionId: Id, itemId: Id): { item: Item; parents: Folder[] } | undefined {
  const c = getCollection(collectionId)
  return c ? findItem(c.items, itemId) : undefined
}

export function newTabId(): string {
  return newId()
}
