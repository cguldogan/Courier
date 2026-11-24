/**
 * Renderer state (zustand). The engine owns all persistent data; this store only mirrors what
 * `window.courier` returns plus purely-UI state (open tabs with their unsaved drafts, dialogs, toasts).
 */
import { create } from 'zustand'
import type { AppInfo, MockLogEntry, MockServerInfo, MonitorInfo, SyncOverview, SyncReport } from '../../shared/api'
import type {
  Auth,
  Collection,
  ExecutionResult,
  Folder,
  HistoryEntry,
  Id,
  IdentityStatus,
  Item,
  GrpcCallType,
  GrpcStatusInfo,
  RequestDef,
  RequestItem,
  ResponseExample,
  RunItemResult,
  RunSummary,
  Settings,
  Variable,
  Team,
  WorkspaceSnapshot,
  WsHandshake,
  WsStatus
} from '../../shared/types'
import type { BoundedLog } from '../../shared/realtime'
import { findItem, newId } from '../../shared/types'
import { splitQuery } from '../../shared/variables'

// ---------------------------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------------------------

/**
 * A request tab: HTTP, WebSocket or gRPC (`draft.type`). Save, rename, move, close-with-unsaved and
 * Save As work the same for every kind. Live WebSocket / gRPC state is kept in `AppState.live`
 * (keyed by tab id, memory only), outside `draft`, so it never counts as an unsaved change.
 */
export interface RequestTab {
  kind: 'request'
  id: string
  collectionId: Id | null
  requestId: Id | null
  draft: RequestItem
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

/** A saved response example: request read-only, response (name, status, headers, body) editable. */
export interface ExampleTab {
  kind: 'example'
  id: string
  collectionId: Id
  requestId: Id
  exampleId: Id
  draft: ResponseExample
  /** '__gone__' when the example was deleted elsewhere while this tab had edits. */
  baseline: string
}

export interface MocksTab {
  kind: 'mocks'
  id: string
  /** Selected collection. */
  collectionId: Id | null
}

export interface MonitorsTab {
  kind: 'monitors'
  id: string
  monitorId: Id | null
  /** Run shown in detail (from the history or a notification). */
  runId: Id | null
}

export type Tab = RequestTab | ContainerTab | EnvironmentTab | GlobalsTab | RunnerTab | ExampleTab | MocksTab | MonitorsTab

export function isDirty(t: Tab): boolean {
  switch (t.kind) {
    case 'request':
      return JSON.stringify(t.draft) !== t.baseline
    case 'container':
    case 'environment':
    case 'globals':
    case 'example':
      return JSON.stringify(t.draft) !== t.baseline
    default:
      return false
  }
}

/**
 * Editor form of a request: query string moved into `params` so URL bar and Params stay in sync.
 * Examples are left out: they are edited in their own tabs, and a request save without them keeps them.
 */
export function editorRequest(r: RequestDef): RequestDef {
  const { examples: _examples, ...rest } = r
  const c = structuredClone(rest) as RequestDef
  if (c.url.includes('?')) {
    const { base, params } = splitQuery(c.url)
    c.url = base
    c.params = [...params, ...c.params]
  }
  return c
}

/** Editor form of any request kind (HTTP and WebSocket: query string moved into `params`). */
export function editorItem(r: RequestItem): RequestItem {
  if (r.type === 'request') return editorRequest(r)
  const c = structuredClone(r)
  if (c.type === 'websocket' && c.url.includes('?')) {
    const { base, params } = splitQuery(c.url)
    c.url = base
    c.params = [...params, ...c.params]
  }
  return c
}

/** Tab narrowed to one request kind (the editors). */
export type TabOf<D extends RequestItem> = Omit<RequestTab, 'draft'> & { draft: D }

// ---------------------------------------------------------------------------------------------
// Live WebSocket / gRPC state (memory only, never persisted)
// ---------------------------------------------------------------------------------------------

export interface WsLive {
  kind: 'websocket'
  connectionId: string
  status: WsStatus
  code?: number
  reason?: string
  error?: { code: string; message: string }
  handshake?: WsHandshake
  attempt?: number
  log: BoundedLog
}

export interface GrpcLive {
  kind: 'grpc'
  callId: string
  running: boolean
  callType?: GrpcCallType
  path?: string
  target?: string
  tls?: boolean
  requestMetadata: [string, string][]
  headers: [string, string][]
  trailers: [string, string][]
  status?: GrpcStatusInfo
  hint?: string
  durationMs?: number
  /** Request preparation failed (nothing was sent). */
  error?: string
  log: BoundedLog
}

export type Live = WsLive | GrpcLive

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
  /** `locationChoice`: also pick Personal or a team; `onSubmit` then gets the team id (null = Personal). */
  | { type: 'prompt'; title: string; label: string; initial?: string; confirmLabel?: string; locationChoice?: boolean; onSubmit: (value: string, teamId?: Id | null) => void | Promise<void> }
  /** Review a team's Key Vault hosts (from its manifest) and approve them on this machine. */
  | { type: 'teamVaults'; teamId: Id }
  | { type: 'confirm'; title: string; message: string; confirmLabel?: string; danger?: boolean; alt?: { label: string; onClick: () => void | Promise<void> }; onConfirm: () => void | Promise<void> }
  /** Save the response of a request tab as an example. */
  | { type: 'saveExample'; tabId: string }
  /** Create (no `monitorId`) or edit a monitor. */
  | { type: 'monitorEdit'; monitorId?: Id; collectionId?: Id }

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
  /** Live WebSocket / gRPC state per request tab id. */
  live: Record<string, Live>
  /** Mock servers (running and configured). */
  mocks: MockServerInfo[]
  /** Request log per mocked collection (memory only, bounded like main's). */
  mockLogs: Record<Id, MockLogEntry[]>
  monitors: MonitorInfo[]

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
  live: {},
  mocks: [],
  mockLogs: {},
  monitors: [],

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
      const live = { ...s.live }
      delete live[id]
      return { tabs, activeTabId, live }
    }),
  activate: (id) => set({ activeTabId: id })
}))

// ---------------------------------------------------------------------------------------------
// Selectors / helpers
// ---------------------------------------------------------------------------------------------

/** Stable empty list for selectors (a fresh `[]` per render would loop). */
export const NO_TEAMS: readonly Team[] = []

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
