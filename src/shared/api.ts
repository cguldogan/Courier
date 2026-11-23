/**
 * The complete renderer ⇄ main contract: `window.courier: CourierApi`.
 *
 * ERROR CONVENTION (one rule, everywhere):
 *   Every method returns `Promise<Result<T>>` and never rejects for expected failures.
 *   `{ ok: true, value }` on success, `{ ok: false, error: { code, message } }` on failure, where
 *   `message` is a clean, user-presentable sentence (no stack, no "Error invoking remote method").
 *   Use `unwrap(await courier.x.y())` to get the value or throw a `CourierError` (which keeps `code`).
 *   (Errors thrown across `contextBridge` lose custom properties, hence the envelope.)
 *
 * IDs, not paths: the renderer only ever passes ids; main loads docs from its own cache. Filesystem
 * paths only come back *from* main dialogs (`files.pickFile`) and are used for request bodies.
 *
 * Events: `courier.on(event, cb)` returns an unsubscribe function. After any `workspace:changed` or
 * `variables:changed`, re-read with `courier.workspace.load()`.
 *
 * There is one implicit workspace per app install (userData). Every collection/environment belongs
 * to Personal (this machine only, `teamId` absent/null) or to exactly one joined team (`teamId`).
 * Globals, current values, history and the cookie jar are per install. Team sync is explicit
 * (`sync.run`) — saves only mark team items dirty. Personal items never touch the network.
 *
 * Pure helpers the renderer may import directly from `src/shared`: types/constructors (`types.ts`),
 * `variables.ts` (resolveTemplate, splitQuery, buildUrl, referencedVariables, parseVaultRef, MASK),
 * `serialize.ts` (normalize*), `curl.ts` (parseCurl), `codegen.ts`, `slug.ts`, `datafile.ts`.
 */
import type {
  Auth,
  Collection,
  GrpcCallType,
  GrpcDescriptor,
  GrpcEvent,
  GrpcRequestDef,
  GrpcServiceInfo,
  GrpcTlsFiles,
  RealtimeLogEntry,
  WebSocketRequestDef,
  WsEvent,
  WsMessage,
  WsStatus,
  CollectionEntry,
  CookieInfo,
  Environment,
  EnvironmentEntry,
  ExecutionResult,
  HistoryEntry,
  Id,
  IdentitySettings,
  IdentityStatus,
  Item,
  ItemKind,
  ItemRef,
  RequestDef,
  RunItemResult,
  RunSummary,
  SecretFinding,
  SecretSummary,
  SecretValue,
  Settings,
  SkippedItem,
  SnippetLanguage,
  Team,
  TeamManifest,
  Variable,
  VaultConfig,
  WorkspaceSnapshot
} from './types'

// ---------------------------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------------------------

export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'NOT_SIGNED_IN'
  | 'AUTH_FAILED'
  /** OAuth 2.0 authorization code: no (valid) token yet; use "Get new token" in the Authorization tab. */
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'CONTAINER_NOT_FOUND'
  | 'NOT_CONFIGURED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'CONFLICT'
  | 'SCRIPT_ERROR'
  | 'VAULT_ERROR'
  /** A script tried to obtain a Key Vault value but its collection is not allowed to on this machine. */
  | 'VAULT_SCRIPT_BLOCKED'
  /** A team manifest's Key Vault has not been approved on this machine yet (Settings → Teams). */
  | 'VAULT_NOT_APPROVED'
  | 'IMPORT_FAILED'
  | 'BUSY'
  | 'INTERNAL'

export interface CourierErrorInfo {
  code: ErrorCode
  message: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: CourierErrorInfo }

export class CourierError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'CourierError'
    this.code = code
  }
}

export function unwrap<T>(r: Result<T>): T {
  if (r.ok) return r.value
  throw new CourierError(r.error.code, r.error.message)
}

// ---------------------------------------------------------------------------------------------
// Method inputs / outputs
// ---------------------------------------------------------------------------------------------

export interface AppInfo {
  name: string
  version: string
  platform: string
  arch: string
  electron: string
  userDataDir: string
  /** `COURIER_FAKE_IDENTITY` test hook active. */
  fakeIdentity: boolean
}

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

export interface SendRequestInput {
  /** Optional client-chosen id so the request can be cancelled with `requests.cancel`. */
  executionId?: string
  /** Saved request location (inherit chain, collection variables and scripts come from here). */
  collectionId?: Id | null
  requestId?: Id | null
  /**
   * Unsaved edits. With `collectionId`(+`requestId`) it replaces the saved request but keeps the
   * collection/folder chain; alone it is a scratch request with no collection.
   */
  draft?: RequestDef
  /** `undefined` = the active environment, `null` = no environment. */
  environmentId?: Id | null
}

export interface SnippetInput {
  collectionId?: Id | null
  requestId?: Id | null
  draft?: RequestDef
  environmentId?: Id | null
  language: SnippetLanguage
}

export interface RunInput {
  collectionId: Id
  /** Run only this folder's subtree. */
  folderId?: Id
  /** Explicit subset/order of request ids (default: all requests in tree order). */
  requestIds?: Id[]
  /** `undefined` = active environment, `null` = none. */
  environmentId?: Id | null
  /** Ignored when `data` is given (one iteration per row). Default 1. */
  iterations?: number
  delayMs?: number
  stopOnFailure?: boolean
  /** Rows from `files.pickDataFile()`. */
  data?: Record<string, string>[]
  /** Persist env/global/collection variable changes at the end (default true). */
  persistVariables?: boolean
  /** Loop guard: most `setNextRequest` jumps per iteration (default 1000). */
  maxJumps?: number
}

/**
 * A WebSocket / gRPC request to connect or invoke: a saved item (`collectionId` + `requestId`), its
 * unsaved `draft`, or a scratch draft. Variables, auth inheritance and the Key Vault context come
 * from the collection, as for `requests.send`.
 */
export interface RealtimeTarget<D> {
  collectionId?: Id | null
  requestId?: Id | null
  draft?: D
  /** `undefined` = the active environment, `null` = none (re-read at every send). */
  environmentId?: Id | null
}

export interface WsConnectResult {
  status: WsStatus
  error?: { code: string; message: string }
}

export type GrpcTlsKind = keyof GrpcTlsFiles

/**
 * Identifies an OAuth 2.0 authorization-code config for "Get new token" / "Clear token". `auth` is the
 * editor's (possibly unsaved) auth; its `{{variables}}` resolve against the collection and environment,
 * and the collection decides the context (Personal or its team).
 */
export interface OAuthTokenInput {
  auth: Auth
  collectionId?: Id | null
  /** `undefined` = the active environment, `null` = none. */
  environmentId?: Id | null
}

export interface OAuthTokenStatus {
  hasToken: boolean
  expiresAt?: string
  expired: boolean
  refreshable: boolean
  /** First and last characters only; the token itself never reaches the renderer. */
  preview?: string
  /** Where the browser goes, and which host receives the code and client secret. */
  authHost: string
  tokenHost: string
  /** `encrypted`: persisted with the OS keystore (safeStorage); `memory`: gone after a restart. */
  storage: 'encrypted' | 'memory'
  /** Team collection whose hosts were not approved on this machine yet. */
  needsApproval: boolean
}

export type OAuthAcquireResult =
  /** Show the hosts to the user, then call again with `approveHosts`. */
  | { status: 'approval-required'; authHost: string; tokenHost: string }
  | { status: 'ok'; token: OAuthTokenStatus }

export interface MoveResult {
  /** False when blocked by secret warnings (moving to a team without `acknowledgeWarnings`). */
  moved: boolean
  warnings: SecretFinding[]
}

export interface SyncError {
  /** The team whose sync failed (always set for sync errors). */
  teamId?: Id
  ref?: ItemRef
  code: ErrorCode
  message: string
}

export interface SyncNotice {
  teamId?: Id
  ref?: ItemRef
  message: string
}

/** Outcome of one team in a sync run. One team failing never stops the others. */
export interface TeamSyncResult {
  teamId: Id
  name: string
  ok: boolean
  /** Team-level failure (RBAC, missing container, network…); item-level errors are in `errors`. */
  error?: CourierErrorInfo
}

/** Items in the lists carry `teamId`, so the report can be grouped per team. */
export interface SyncReport {
  startedAt: string
  finishedAt: string
  teams: TeamSyncResult[]
  uploaded: ItemRef[]
  downloaded: ItemRef[]
  /** Remote blob gone and local copy was clean → local copy removed. */
  removedLocally: ItemRef[]
  /** Pending local deletes applied to the remote. */
  deletedRemotely: ItemRef[]
  conflicts: ItemRef[]
  /** Team items held back because of secret findings (re-run with `acknowledgeWarnings: true`). */
  blocked: { ref: ItemRef; findings: SecretFinding[] }[]
  notices: SyncNotice[]
  errors: SyncError[]
}

export interface TeamSyncStatus {
  teamId: Id
  name: string
  accountUrl: string
  container: string
  /** Dirty items + pending deletes of this team. */
  pending: number
  /** Local deletes not yet applied remotely (discard with `sync.discardLocalChanges`). */
  pendingDeletes: ItemRef[]
  conflicts: ItemRef[]
  /** Team-level error of the last sync of this team (cleared by a successful sync). */
  lastError?: CourierErrorInfo
  lastSyncedAt?: string
}

export interface SyncOverview {
  /** At least one team joined. */
  configured: boolean
  signedIn: boolean
  running: boolean
  teams: TeamSyncStatus[]
  /** Totals over all teams. */
  pending: number
  pendingDeletes: ItemRef[]
  conflicts: ItemRef[]
  lastReport: SyncReport | null
}

export interface ConflictDetail {
  ref: ItemRef
  reason: 'both-changed' | 'precondition-failed'
  mine: Collection | Environment
  theirs: Collection | Environment
  remoteUpdatedBy?: string
  remoteUpdatedAt?: string
}

export type ConflictResolution = 'mine' | 'theirs' | 'both'

export interface ResolveConflictResult {
  /** Present for `both`: the new copy holding your version. */
  copy?: ItemRef
  report: SyncReport
}

export interface ConnectionTestResult {
  ok: boolean
  code?: ErrorCode
  message: string
}

/** What a container holds before joining it: its manifest (or null when there is none). */
export interface TeamProbe {
  accountUrl: string
  container: string
  manifest: TeamManifest | null
  /** Vault entries of the manifest that would be ignored, with the reason. */
  rejectedVaults: { alias: string; url: string; reason: string }[]
  /** Already joined on this machine. */
  joinedTeamId?: Id
}

export interface LeaveTeamResult {
  left: boolean
  /** Unsynced local changes that leaving would drop (`left` is false unless `discardUnsynced`). */
  unsynced: ItemRef[]
}

export interface PickedFile {
  path: string
  name: string
  size: number
}

export interface DataFile {
  name: string
  columns: string[]
  rows: Record<string, string>[]
}

export type ImportResult =
  | { kind: 'collection'; entry: CollectionEntry; warnings: string[] }
  | { kind: 'environment'; entry: EnvironmentEntry; warnings: string[] }
  /** cURL: returned as an unsaved draft — save it with `collections.upsertItem`. */
  | { kind: 'request'; request: RequestDef; warnings: string[] }

export type ExportFormat = 'postman' | 'courier'

/** A written collection export. Postman v2.1 has no WebSocket / gRPC request: those are listed in `skipped`. */
export interface CollectionExportResult {
  path: string
  skipped: SkippedItem[]
}

/**
 * Whether a collection's scripts may obtain Key Vault values on THIS machine (`pm.vault.get`,
 * `{{vault:…}}` in `pm.sendRequest`, vault-backed variables). Stored in userData only, never synced.
 * The grant is bound to a hash of all script text in the collection: local saves re-bind it, script
 * changes that arrive any other way (sync, conflict resolution) make it lapse.
 */
export interface ScriptVaultAccess {
  allowed: boolean
  grantedAt?: string
  /** Set when a grant was withdrawn because the scripts changed outside a local save. */
  lapsed?: { at: string; updatedBy?: string }
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

export interface CourierEvents {
  /** Collections/environments changed on disk (save, sync, import, delete, move, conflict). */
  'workspace:changed': { reason: 'save' | 'delete' | 'move' | 'sync' | 'import' | 'conflict' | 'team'; refs: ItemRef[] }
  /** Globals / current values / active environment changed (incl. after sends and runs). */
  'variables:changed': { reason: 'request' | 'run' | 'edit' }
  'settings:changed': Settings
  'auth:changed': IdentityStatus
  'sync:state': SyncOverview
  'runner:progress': { runId: string; completed: number; total: number; result: RunItemResult }
  /** WebSocket status changes and log lines (masked). Logs live in renderer memory only. */
  'ws:event': WsEvent
  /** gRPC call start, headers, messages and end status (masked). */
  'grpc:event': GrpcEvent
  'runner:finished': RunSummary
  'history:changed': Record<string, never>
  'cookies:changed': Record<string, never>
}

export type CourierEventName = keyof CourierEvents

// ---------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------

type R<T> = Promise<Result<T>>

export interface CourierApi {
  app: {
    info(): R<AppInfo>
    /** Opens an http(s) URL in the system browser. */
    openExternal(url: string): R<void>
  }
  settings: {
    get(): R<Settings>
    /** Deep-merges `patch` (arrays replaced). Emits `settings:changed`. */
    update(patch: DeepPartial<Settings>): R<Settings>
  }
  identity: {
    status(): R<IdentityStatus>
    /** Signs in with the given (or saved) identity settings; persists them. Emits `auth:changed`. */
    signIn(settings?: Partial<IdentitySettings>): R<IdentityStatus>
    signOut(): R<IdentityStatus>
  }
  workspace: {
    /** Everything the UI needs: all entries, globals, current values, active environment. */
    load(): R<WorkspaceSnapshot>
  }
  collections: {
    /** `teamId` null/absent = Personal. */
    create(input: { name: string; teamId?: Id | null }): R<CollectionEntry>
    /** Replace the whole collection doc (tree included). Marks team items dirty. Secret-typed variable values are moved to current values. */
    save(collection: Collection): R<CollectionEntry>
    /** Insert or replace one item (request/folder) under `parentId` (null = collection root) at `index` (default end; existing items keep position). */
    upsertItem(input: { collectionId: Id; parentId?: Id | null; item: Item; index?: number }): R<CollectionEntry>
    deleteItem(input: { collectionId: Id; itemId: Id }): R<CollectionEntry>
    moveItem(input: { collectionId: Id; itemId: Id; parentId: Id | null; index: number }): R<CollectionEntry>
    /** Deep copy with fresh ids, same team (or Personal), name + " Copy". */
    duplicate(id: Id): R<CollectionEntry>
    /** Deletes locally and (team items) the blob with If-Match; queued if offline. */
    delete(id: Id): R<void>
    /**
     * Move to Personal (`teamId: null`) or to a team. Moving to a team returns secret warnings
     * unless `acknowledgeWarnings`. The next sync uploads to the new team first and only then
     * deletes the old blob (If-Match).
     */
    move(input: { id: Id; teamId: Id | null; acknowledgeWarnings?: boolean }): R<MoveResult>
    /** This machine's permission for the collection's scripts to read Key Vault secrets (default: not allowed). */
    getScriptVaultAccess(id: Id): R<ScriptVaultAccess>
    /** Grant (bound to the current script text) or withdraw that permission. Never synced. */
    setScriptVaultAccess(input: { id: Id; allowed: boolean }): R<ScriptVaultAccess>
  }
  environments: {
    create(input: { name: string; teamId?: Id | null }): R<EnvironmentEntry>
    save(environment: Environment): R<EnvironmentEntry>
    duplicate(id: Id): R<EnvironmentEntry>
    delete(id: Id): R<void>
    move(input: { id: Id; teamId: Id | null; acknowledgeWarnings?: boolean }): R<MoveResult>
    setActive(id: Id | null): R<void>
  }
  variables: {
    setGlobals(variables: Variable[]): R<void>
    /** Replace all current values for an environment or collection (keys not present fall back to the shared value). */
    setCurrentValues(input: { scope: 'environment' | 'collection'; id: Id; values: Record<string, string> }): R<void>
  }
  requests: {
    /** Full pipeline: scripts → variables → Key Vault → auth → HTTP → tests. Persists variable changes, history, cookies. */
    send(input: SendRequestInput): R<ExecutionResult>
    cancel(executionId: string): R<boolean>
    /** Code snippet with variables resolved; Key Vault secrets and tokens masked / placeholders. */
    snippet(input: SnippetInput): R<string>
    /** Effective auth after the inherit chain (for "Inherited from …" hints). */
    effectiveAuth(input: { collectionId: Id; itemId: Id | null }): R<{ auth: Auth; from: string }>
  }
  oauth: {
    /** Token state for an authorization-code config (expiry and masked preview only). */
    status(input: OAuthTokenInput): R<OAuthTokenStatus>
    /**
     * Opens the system browser and waits for the loopback redirect (PKCE + state). For a team
     * collection the first call returns `approval-required` with the hosts; pass them back as
     * `approveHosts` after the user agreed (refused if the config resolves to other hosts by then).
     */
    getNewToken(input: OAuthTokenInput & { approveHosts?: { authHost: string; tokenHost: string } }): R<OAuthAcquireResult>
    /** Cancels a pending "Get new token". */
    cancel(): R<boolean>
    clearToken(input: OAuthTokenInput): R<void>
  }
  websocket: {
    /**
     * Opens a connection (id chosen by the caller, one per tab). Resolves when the handshake succeeded
     * or failed; afterwards everything arrives as `ws:event`. Rejects only when the request cannot be
     * prepared (invalid URL, unsupported auth, Key Vault errors).
     */
    connect(input: RealtimeTarget<WebSocketRequestDef> & { connectionId: string }): R<WsConnectResult>
    /** Resolves `{{variables}}` / `{{vault:…}}` in the message now and sends it. Returns the (masked) log entry. */
    send(input: { connectionId: string; message: WsMessage }): R<RealtimeLogEntry>
    ping(connectionId: string): R<void>
    /** Normal close (1000, or 3000–4999). False when the connection was already gone. */
    disconnect(input: { connectionId: string; code?: number; reason?: string }): R<boolean>
  }
  grpc: {
    /** Server reflection (v1, then v1alpha) at the request's address, with its TLS, metadata and auth. */
    reflect(input: RealtimeTarget<GrpcRequestDef>): R<GrpcDescriptor>
    /** Native open dialog for .proto files (multi-select); the picked files may be read by `loadProtos` in this session. */
    pickProtoFiles(): R<PickedFile[] | null>
    /** Native folder dialog for an import (include) directory. */
    pickImportDir(): R<{ path: string; name: string } | null>
    /** Parses picked .proto files; imports resolve only inside picked directories. */
    loadProtos(input: { files: string[]; importDirs: string[] }): R<GrpcDescriptor>
    describe(input: { descriptor: GrpcDescriptor }): R<GrpcServiceInfo[]>
    /** A JSON skeleton of the method's request message. */
    example(input: { descriptor: GrpcDescriptor; service: string; method: string }): R<string>
    /** Starts a call (id chosen by the caller); progress and the final status arrive as `grpc:event`. */
    invoke(input: RealtimeTarget<GrpcRequestDef> & { callId: string }): R<{ callType: GrpcCallType }>
    /** Client / bidirectional streaming: one more request message (JSON, variables resolved now). */
    send(input: { callId: string; message: string }): R<RealtimeLogEntry>
    /** Half-close the request stream. */
    end(callId: string): R<boolean>
    cancel(callId: string): R<boolean>
    /** CA / client certificate / key chosen on this machine for a request (never synced). */
    tlsFiles(requestId: Id): R<GrpcTlsFiles>
    pickTlsFile(input: { requestId: Id; kind: GrpcTlsKind }): R<GrpcTlsFiles>
    clearTlsFile(input: { requestId: Id; kind: GrpcTlsKind }): R<GrpcTlsFiles>
  }
  runner: {
    /** Starts a run; progress via `runner:progress`, completion via `runner:finished`. */
    start(input: RunInput): R<{ runId: string }>
    stop(runId: string): R<boolean>
  }
  sync: {
    status(): R<SyncOverview>
    /** Syncs every joined team (or only `teamId`). A failing team is reported in `report.teams` and never blocks the others. */
    run(input?: { teamId?: Id; acknowledgeWarnings?: boolean }): R<SyncReport>
    getConflict(input: { kind: ItemKind; id: Id }): R<ConflictDetail>
    /**
     * Applies the resolution, then syncs that item's team. Uploads with secret findings stay in
     * `report.blocked` unless `acknowledgeWarnings`.
     */
    resolveConflict(input: { kind: ItemKind; id: Id; resolution: ConflictResolution; acknowledgeWarnings?: boolean }): R<ResolveConflictResult>
    /** Secret scan preview for an item (what would be flagged on upload to a team). */
    scan(input: { kind: ItemKind; id: Id }): R<SecretFinding[]>
    /**
     * Drop local edits / a pending delete of a cloud item and re-download the remote version
     * (e.g. a Reader-role user who edited by accident). Runs a sync.
     */
    discardLocalChanges(input: { kind: ItemKind; id: Id }): R<SyncReport>
  }
  teams: {
    list(): R<Team[]>
    /** Reads `courier-team.json` of a container (name + vaults) before joining or creating. */
    probe(input: { accountUrl: string; container: string }): R<TeamProbe>
    /** Joins the team in that container. `name` is required when the container has no manifest (read-only join). */
    join(input: { accountUrl: string; container: string; name?: string }): R<Team>
    /** Writes a new manifest (If-None-Match: *) and joins. CONFLICT when the container already has one. */
    create(input: { accountUrl: string; container: string; name: string; vaults?: VaultConfig[] }): R<Team>
    /** Re-reads the manifest. */
    refresh(id: Id): R<Team>
    /**
     * Edits the team manifest (If-Match `etag`, default: the last read ETag) — CONFLICT when someone
     * changed it meanwhile. For a team without a manifest, passing `vaults` creates one
     * (If-None-Match: *); passing only `name` renames the team on this machine. Vault URLs you add
     * in an edit count as approved on this machine; entries a teammate listed keep their state.
     */
    update(input: { id: Id; name?: string; vaults?: VaultConfig[]; etag?: string }): R<Team>
    /** Approve a team vault host on this machine (keyed by team + vault URL). */
    approveVault(input: { id: Id; url: string }): R<Team>
    /** Removes the team and its local cache (never deletes blobs). Refuses with the unsynced list unless `discardUnsynced`. */
    leave(input: { id: Id; discardUnsynced?: boolean }): R<LeaveTeamResult>
    /** Checks account URL/container/RBAC with the signed-in identity. Never throws a Result error for remote failures — inspect `ok`. */
    testConnection(id: Id): R<ConnectionTestResult>
  }
  vault: {
    /**
     * Secret names in a vault. `teamId` selects the context: that team's manifest vaults first,
     * then your own (default: your own vaults only). Alias default = the context's first vault.
     */
    list(input?: { alias?: string; teamId?: Id | null }): R<SecretSummary[]>
    /** Reveal a secret value on demand. Not cached in the renderer by main. */
    get(input: { alias?: string; teamId?: Id | null; name: string; version?: string }): R<SecretValue>
    /** Creates a new version. */
    set(input: { alias?: string; teamId?: Id | null; name: string; value: string; contentType?: string }): R<SecretSummary>
    clearCache(): R<void>
  }
  files: {
    /** Native open dialog for a body file (form-data file field / binary body). Null if cancelled. */
    pickFile(input?: { title?: string }): R<PickedFile | null>
    /** Native open dialog for a runner data file (CSV with header row, or JSON array of objects). */
    pickDataFile(): R<DataFile | null>
    /** Native open dialog; detects Postman collection/environment (v2.0/2.1) or OpenAPI 3 (JSON/YAML). */
    importFile(input?: { teamId?: Id | null }): R<ImportResult | null>
    /** Same detection on pasted text, plus cURL commands (returned as an unsaved draft). */
    importText(input: { text: string; teamId?: Id | null }): R<ImportResult>
    /**
     * Native save dialog. Returns the written path (and, for Postman format, the WebSocket / gRPC
     * requests that were left out), or null if cancelled.
     */
    exportCollection(input: { id: Id; format: ExportFormat }): R<CollectionExportResult | null>
    exportEnvironment(input: { id: Id; format: ExportFormat }): R<string | null>
  }
  history: {
    list(): R<HistoryEntry[]>
    delete(id: Id): R<void>
    clear(): R<void>
  }
  cookies: {
    list(): R<CookieInfo[]>
    delete(input: { domain: string; path: string; key: string }): R<void>
    clear(): R<void>
  }
  /** Subscribe to a main-process event. Returns the unsubscribe function. */
  on<E extends CourierEventName>(event: E, callback: (payload: CourierEvents[E]) => void): () => void
}

// ---------------------------------------------------------------------------------------------
// Runtime method table (used by preload + ipc so the two can't drift; checked against CourierApi)
// ---------------------------------------------------------------------------------------------

type Namespaces = Exclude<keyof CourierApi, 'on'>

export const API_METHODS = {
  app: ['info', 'openExternal'],
  settings: ['get', 'update'],
  identity: ['status', 'signIn', 'signOut'],
  workspace: ['load'],
  collections: ['create', 'save', 'upsertItem', 'deleteItem', 'moveItem', 'duplicate', 'delete', 'move', 'getScriptVaultAccess', 'setScriptVaultAccess'],
  environments: ['create', 'save', 'duplicate', 'delete', 'move', 'setActive'],
  variables: ['setGlobals', 'setCurrentValues'],
  requests: ['send', 'cancel', 'snippet', 'effectiveAuth'],
  oauth: ['status', 'getNewToken', 'cancel', 'clearToken'],
  websocket: ['connect', 'send', 'ping', 'disconnect'],
  grpc: ['reflect', 'pickProtoFiles', 'pickImportDir', 'loadProtos', 'describe', 'example', 'invoke', 'send', 'end', 'cancel', 'tlsFiles', 'pickTlsFile', 'clearTlsFile'],
  runner: ['start', 'stop'],
  sync: ['status', 'run', 'getConflict', 'resolveConflict', 'scan', 'discardLocalChanges'],
  teams: ['list', 'probe', 'join', 'create', 'refresh', 'update', 'approveVault', 'leave', 'testConnection'],
  vault: ['list', 'get', 'set', 'clearCache'],
  files: ['pickFile', 'pickDataFile', 'importFile', 'importText', 'exportCollection', 'exportEnvironment'],
  history: ['list', 'delete', 'clear'],
  cookies: ['list', 'delete', 'clear']
} as const satisfies { [N in Namespaces]: readonly (keyof CourierApi[N])[] }

// Compile-time completeness check: every method of CourierApi appears in API_METHODS.
type Listed<N extends Namespaces> = (typeof API_METHODS)[N][number]
type Missing = { [N in Namespaces]: Exclude<keyof CourierApi[N], Listed<N>> }[Namespaces]
const _complete: [Missing] extends [never] ? true : Missing = true
void _complete

export const EVENT_NAMES: readonly CourierEventName[] = [
  'workspace:changed',
  'variables:changed',
  'settings:changed',
  'auth:changed',
  'sync:state',
  'runner:progress',
  'runner:finished',
  'ws:event',
  'grpc:event',
  'history:changed',
  'cookies:changed'
]

/** IPC channel names (internal to preload/main). */
export const IPC_INVOKE = 'courier:invoke'
export const IPC_EVENT = 'courier:event'

/** Handler table type implemented by main: same signatures, but returning plain values/promises (main wraps into Result). */
export type ApiHandlers = {
  [N in Namespaces]: {
    [M in keyof CourierApi[N]]: CourierApi[N][M] extends (...args: infer A) => Promise<Result<infer T>>
      ? (...args: A) => T | Promise<T>
      : never
  }
}
