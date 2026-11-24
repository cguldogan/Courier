/**
 * Courier data model. Pure types + tiny constructors; no Node or Electron APIs (imported by the renderer).
 *
 * Storage model:
 *  - every Collection / Environment belongs to **Personal** (this machine only, userData, never
 *    uploaded) or to exactly one **team**;
 *  - a team is its own storage location (account URL + container); isolation between teams is
 *    whatever Azure RBAC grants on each container. Team docs are cached in userData per team and
 *    synced with ETag preconditions;
 *  - environment/collection *current* values, globals, cookies, history and settings never leave userData.
 */

export type Id = string

export type ItemKind = 'collection' | 'environment'

// ---------------------------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------------------------

/**
 * `default` – plain value.
 * `secret`  – value is never written to a cloud doc (stored as ""); the real value lives only in the
 *             userData *current value* for that variable.
 * `vault`   – value is a Key Vault reference (`name`, `alias/name`, `name@version`, optionally written
 *             as `vault:…` or `{{vault:…}}`); `{{key}}` resolves through Key Vault at send time.
 */
export type VariableType = 'default' | 'secret' | 'vault'

export interface Variable {
  key: string
  /** Shared / initial value (what is synced). Empty for `secret` variables. */
  value: string
  enabled: boolean
  type: VariableType
  description?: string
}

export interface KeyValue {
  key: string
  value: string
  enabled: boolean
  description?: string
}

export interface FormDataField extends KeyValue {
  kind: 'text' | 'file'
  /** Absolute path of the file for `kind: 'file'` (choose it with `files.pickFile()`). */
  filePath?: string
  contentType?: string
}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
/** Any upper-case token is accepted (custom methods allowed). */
export type HttpMethod = string

export type RawLanguage = 'json' | 'text' | 'xml' | 'html' | 'javascript'

export type RequestBody =
  | { mode: 'none' }
  | { mode: 'raw'; raw: string; language: RawLanguage }
  | { mode: 'urlencoded'; urlencoded: KeyValue[] }
  | { mode: 'formdata'; formdata: FormDataField[] }
  | { mode: 'graphql'; graphql: { query: string; variables: string } }
  | { mode: 'binary'; filePath: string }

export type BodyMode = RequestBody['mode']

export type OAuth2GrantType = 'client_credentials' | 'authorization_code'

export const JWT_ALGORITHMS = ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384'] as const
export type JwtAlgorithm = (typeof JWT_ALGORITHMS)[number]

export type Auth =
  | { type: 'inherit' }
  | { type: 'none' }
  | { type: 'basic'; username: string; password: string }
  | { type: 'bearer'; token: string }
  | { type: 'apikey'; key: string; value: string; in: 'header' | 'query' }
  | {
      type: 'oauth2'
      grantType: OAuth2GrantType
      accessTokenUrl: string
      clientId: string
      clientSecret: string
      scope: string
      audience: string
      /** `header` = HTTP Basic client auth, `body` = client_id/client_secret form fields. */
      clientAuthentication: 'header' | 'body'
      /** authorization_code: the IdP's authorize endpoint (opened in the system browser). */
      authUrl?: string
      /** authorization_code: fixed loopback redirect URI (`http://127.0.0.1:8765/callback`); empty = random port. */
      redirectUri?: string
      /** authorization_code: PKCE with S256 (default on). */
      pkce?: boolean
      /** authorization_code: extra authorize-request parameters, `prompt=consent&resource=…`. */
      extraParams?: string
    }
  /** Token from the signed-in Azure identity for `scope` (e.g. `https://graph.microsoft.com/.default`). */
  | { type: 'entra'; scope: string }
  /** RFC 7616 Digest (MD5 / SHA-256, qop auth / auth-int), driven by the server's challenge. */
  | { type: 'digest'; username: string; password: string }
  /** AWS Signature Version 4. `addTo: 'query'` presigns the URL instead of adding an Authorization header. */
  | { type: 'awsv4'; accessKey: string; secretKey: string; sessionToken: string; region: string; service: string; addTo: 'header' | 'query' }
  /** NTLMv2 three-message handshake on one connection. */
  | { type: 'ntlm'; username: string; password: string; domain: string; workstation: string }
  /** A JWT signed at send time. `secret` is the HMAC secret (HS*) or a PEM private key (RS256…, ES256…). */
  | {
      type: 'jwt'
      algorithm: JwtAlgorithm
      secret: string
      secretBase64: boolean
      /** JSON payload (variables allowed). */
      payload: string
      /** Extra JOSE header fields as JSON (`alg` and `typ` are set by Courier). */
      header: string
      addTo: 'header' | 'query'
      headerPrefix: string
      queryParamKey: string
    }

export type AuthType = Auth['type']

/** Per-request overrides; `undefined` = use the global setting. */
export interface RequestSettings {
  followRedirects?: boolean
  maxRedirects?: number
  verifyTls?: boolean
  timeoutMs?: number
}

/**
 * A request. `url` may contain a query string; enabled `params` are *appended* at send time.
 * Use `splitQuery()` from `@shared/variables` to move a pasted query string into `params`.
 * `:name` path segments are filled from `pathVariables`.
 */
export interface RequestDef {
  type: 'request'
  id: Id
  name: string
  description: string
  method: HttpMethod
  url: string
  params: KeyValue[]
  pathVariables: KeyValue[]
  headers: KeyValue[]
  body: RequestBody
  auth: Auth
  preRequestScript: string
  testScript: string
  settings: RequestSettings
  /**
   * Saved response examples (Postman `response[]`). Absent when there are none, so documents without
   * examples serialise exactly as before. Edited only through `examples.*`: a request save that
   * carries no `examples` keeps the stored ones (request tabs never hold them).
   */
  examples?: ResponseExample[]
}

// ---------------------------------------------------------------------------------------------
// Saved response examples
// ---------------------------------------------------------------------------------------------

/** The request an example was saved from, in its *template* form (`{{variables}}` unresolved). */
export interface ExampleRequest {
  method: string
  /** URL template without the query string. */
  url: string
  params: KeyValue[]
  headers: KeyValue[]
  /** Local file paths are never stored (binary and form-data file fields keep no path). */
  body: RequestBody
}

export interface ExampleResponse {
  status: number
  statusText: string
  headers: KeyValue[]
  /** Text body (Key Vault values and tokens already masked when saved from a response). */
  body: string
  /** Binary body (image, PDF, …) as base64; then `body` is empty. */
  bodyBase64?: string
  /** Display / Postman preview language. */
  language: RawLanguage
  /** The body was cut to the example size limit when it was saved. */
  truncated?: boolean
}

export interface ResponseExample {
  id: Id
  name: string
  request: ExampleRequest
  response: ExampleResponse
}

// ---------------------------------------------------------------------------------------------
// WebSocket and gRPC requests (no scripts; skipped by the runner, Postman export and snippets)
// ---------------------------------------------------------------------------------------------

/** `text` frames are written as JSON / XML / plain text; `binary` frames are typed as base64 or hex. */
export type WsMessageKind = 'text' | 'binary'
export type WsMessageFormat = 'json' | 'xml' | 'text' | 'base64' | 'hex'

export interface WsMessage {
  kind: WsMessageKind
  format: WsMessageFormat
  /** `{{variables}}` / `{{vault:…}}` resolve at send time. */
  body: string
}

export interface SavedWsMessage extends WsMessage {
  id: Id
  name: string
}

/** Per-request overrides; `undefined` = default. */
export interface WsSettings {
  verifyTls?: boolean
  handshakeTimeoutMs?: number
  /** Largest incoming message accepted (bytes); larger ones close the connection with 1009. */
  maxMessageBytes?: number
  /** Reconnect after an unexpected close (off by default). */
  autoReconnect?: boolean
}

export interface WebSocketRequestDef {
  type: 'websocket'
  id: Id
  name: string
  description: string
  /** `ws://` or `wss://`. Enabled `params` are appended at connect time. */
  url: string
  params: KeyValue[]
  headers: KeyValue[]
  /** Offered in `Sec-WebSocket-Protocol`, in order. */
  subprotocols: string[]
  auth: Auth
  /** The composer's current message. */
  message: WsMessage
  savedMessages: SavedWsMessage[]
  settings: WsSettings
}

/**
 * A gRPC service definition stored with the request so teammates can call it without the .proto
 * files. `json` is the definition in protobufjs JSON form (`Root.toJSON()` shape), rebuilt from a
 * whitelist and size-checked by main every time it is used: it is untrusted input.
 */
export interface GrpcDescriptor {
  source: 'reflection' | 'proto'
  /** File names (display only; never local paths). */
  files: string[]
  loadedAt: string
  json: string
}

export interface GrpcSettings {
  verifyTls?: boolean
  /** Per-call deadline; `undefined` = none. */
  deadlineMs?: number
  /** Largest response message accepted (bytes). */
  maxReceiveBytes?: number
}

export interface GrpcRequestDef {
  type: 'grpc'
  id: Id
  name: string
  description: string
  /** `host:port`; `grpc://` (plaintext) and `grpcs://` (TLS) prefixes override `tls`. */
  address: string
  tls: boolean
  metadata: KeyValue[]
  auth: Auth
  /** Fully-qualified service name, e.g. `courier.test.v1.Echo`. */
  service: string
  method: string
  /** Request message as JSON (proto3 JSON mapping); `{{variables}}` resolve at invoke time. */
  message: string
  descriptor: GrpcDescriptor | null
  settings: GrpcSettings
}

export interface Folder {
  type: 'folder'
  id: Id
  name: string
  description: string
  auth: Auth
  preRequestScript: string
  testScript: string
  items: Item[]
}

/** Anything that is not a folder. */
export type RequestItem = RequestDef | WebSocketRequestDef | GrpcRequestDef
export type RequestKind = RequestItem['type']
export type Item = Folder | RequestItem

export function isRequestItem(item: Item): item is RequestItem {
  return item.type !== 'folder'
}

export const REQUEST_KIND_LABELS: Record<RequestKind, string> = { request: 'HTTP', websocket: 'WebSocket', grpc: 'gRPC' }

export interface Collection {
  id: Id
  name: string
  description: string
  /** Collection-level auth; `inherit` is treated as `none`. */
  auth: Auth
  variables: Variable[]
  preRequestScript: string
  testScript: string
  items: Item[]
  /** Stamped on upload (team items) / save (Personal): upn or display name of the last writer. */
  updatedBy?: string
  updatedAt?: string
}

export interface Environment {
  id: Id
  name: string
  variables: Variable[]
  updatedBy?: string
  updatedAt?: string
}

// ---------------------------------------------------------------------------------------------
// Sync state (per item, local only)
// ---------------------------------------------------------------------------------------------

export interface ConflictInfo {
  /**
   * `both-changed`: local dirty and the remote ETag moved.
   * `precondition-failed`: upload rejected with 412/409.
   * `remote-deleted`: (informational, not a conflict) – see `SyncState.notice`.
   */
  reason: 'both-changed' | 'precondition-failed'
  remoteEtag: string
  remoteUpdatedBy?: string
  remoteUpdatedAt?: string
  detectedAt: string
}

export interface SyncState {
  /** The team the item belongs to; absent = Personal (this machine only). */
  teamId?: Id
  /** ETag of the remote blob this local copy is based on (team items). */
  etag?: string
  /** Local changes not yet uploaded (always false for Personal items). */
  dirty: boolean
  lastSyncedAt?: string
  conflict?: ConflictInfo
  /** Human-readable note for the UI, e.g. "Deleted remotely by bob@contoso.com – kept your local changes". */
  notice?: string
}

export interface CollectionEntry {
  collection: Collection
  sync: SyncState
}

export interface EnvironmentEntry {
  environment: Environment
  sync: SyncState
}

export interface ItemRef {
  kind: ItemKind
  id: Id
  name: string
  /** Absent = Personal. */
  teamId?: Id
}

/** `values[key]` overrides the shared value of that variable on this machine only. */
export interface CurrentValues {
  environments: Record<Id, Record<string, string>>
  collections: Record<Id, Record<string, string>>
}

export interface WorkspaceSnapshot {
  collections: CollectionEntry[]
  environments: EnvironmentEntry[]
  globals: Variable[]
  currentValues: CurrentValues
  activeEnvironmentId: Id | null
  /** Teams this machine has joined (sidebar groups, "Move to…" targets). */
  teams: Team[]
}

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

export interface ScriptSource {
  level: 'collection' | 'folder' | 'request'
  /** Name of the collection / folder / request that owns the script. */
  name: string
  phase: 'pre-request' | 'test'
}

export interface TestResult {
  name: string
  passed: boolean
  error?: string
  source: ScriptSource
}

export interface ConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  /** Already formatted for display (objects JSON-stringified); secrets masked. */
  message: string
  source: ScriptSource
  at: number
}

export interface ScriptError {
  source: ScriptSource
  message: string
  /** Stable code for errors the UI acts on (e.g. `VAULT_SCRIPT_BLOCKED`). */
  code?: string
}

export type VariableScope = 'global' | 'environment' | 'collection' | 'local'

export interface VariableMutation {
  scope: VariableScope
  key: string
  action: 'set' | 'unset'
  /** Masked if it contained a Key Vault secret. */
  value?: string
}

export interface ResponseCookie {
  name: string
  value: string
  domain?: string
  path?: string
  expires?: string
  httpOnly?: boolean
  secure?: boolean
  sameSite?: string
}

export interface HttpResponseData {
  status: number
  statusText: string
  headers: [string, string][]
  cookies: ResponseCookie[]
  /** Wall time from first byte sent to last byte received, all redirects included. */
  timeMs: number
  /** Body bytes received (before truncation). */
  sizeBytes: number
  headersSizeBytes: number
  contentType: string
  /** UTF-8 (or declared charset) decoded body, possibly truncated. */
  bodyText: string
  /** Present for image/* (and other binary types) when not truncated. */
  bodyBase64?: string
  truncated: boolean
  finalUrl: string
  redirects: { status: number; url: string }[]
}

/** What was actually sent, for display. Key Vault secrets are masked as `••••`. */
export interface ResolvedRequestInfo {
  method: string
  url: string
  headers: [string, string][]
  bodyPreview?: string
}

export interface ExecutionResult {
  executionId: string
  /** Name of the request (draft or saved). */
  name: string
  request: ResolvedRequestInfo
  /** Present when an HTTP response was received (any status). */
  response?: HttpResponseData
  /** Network / validation / auth acquisition failure. */
  error?: { code: string; message: string }
  tests: TestResult[]
  console: ConsoleEntry[]
  scriptErrors: ScriptError[]
  mutations: VariableMutation[]
  startedAt: string
  durationMs: number
  /** A pre-request script called `pm.execution.skipRequest()`: nothing was sent. */
  skipped?: boolean
  /** HTML from `pm.visualizer.set` (rendered in main, secrets masked; shown in a script-less, network-less frame). */
  visualizer?: { html: string }
  /**
   * `pm.execution.setNextRequest(x)` / `postman.setNextRequest(x)` was called (last call wins).
   * Only the runner acts on it; a single Send ignores it, as in Postman.
   */
  nextRequest?: { value: string | null }
  /** A script changed the cookie jar (`pm.cookies.jar()`). */
  cookiesChanged?: boolean
}

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

export interface RunItemResult {
  iteration: number
  index: number
  requestId: Id
  name: string
  method: string
  url: string
  status?: number
  timeMs?: number
  tests: TestResult[]
  scriptErrors: ScriptError[]
  error?: { code: string; message: string }
  /** Skipped by `pm.execution.skipRequest()`. */
  skipped?: boolean
  /** No error, no script error and all tests passed. */
  passed: boolean
}

export interface RunSummary {
  runId: string
  collectionId: Id
  startedAt: string
  finishedAt: string
  durationMs: number
  iterations: number
  totalRequests: number
  failedRequests: number
  totalTests: number
  passedTests: number
  failedTests: number
  stopped: boolean
  /** `script`: `setNextRequest(null)`; `loop-guard`: too many `setNextRequest` jumps (see `stopMessage`). */
  stoppedReason?: 'user' | 'failure' | 'error' | 'script' | 'loop-guard'
  stopMessage?: string
  results: RunItemResult[]
  /** WebSocket / gRPC requests in the run's scope; the runner does not run them. */
  skipped?: SkippedItem[]
}

/** A request the runner, export or snippets leave out because it is not HTTP. */
export interface SkippedItem {
  id: Id
  name: string
  type: Exclude<RequestKind, 'request'>
  /** Folder path inside the collection (`A / B`), empty at the root. */
  path: string
}

// ---------------------------------------------------------------------------------------------
// WebSocket / gRPC live state (memory only: never written to disk, never synced)
// ---------------------------------------------------------------------------------------------

export type WsStatus = 'connecting' | 'open' | 'closing' | 'closed' | 'error' | 'reconnecting'

/** One line of a WebSocket or gRPC message log. Text is masked and possibly truncated by main. */
export interface RealtimeLogEntry {
  /** Increasing per connection / call (the renderer renumbers entries across reconnects). */
  seq: number
  direction: 'in' | 'out' | 'info'
  kind: 'text' | 'binary' | 'ping' | 'pong' | 'event' | 'error'
  at: string
  /** Full message size in bytes (before truncation). */
  size: number
  /** Text frames, gRPC JSON, events. Key Vault secrets and tokens are `••••`. */
  text?: string
  /** Binary frames (possibly truncated). */
  base64?: string
  truncated?: boolean
  /** gRPC: milliseconds since the call started. */
  elapsedMs?: number
}

export interface WsHandshake {
  /** Masked. */
  url: string
  /** As sent (masked). */
  requestHeaders: [string, string][]
  status?: number
  statusText?: string
  responseHeaders: [string, string][]
  /** Negotiated subprotocol (empty = none). */
  protocol?: string
  extensions?: string
}

export type WsEvent = { connectionId: string } & (
  | {
      type: 'status'
      status: WsStatus
      code?: number
      reason?: string
      error?: { code: string; message: string }
      handshake?: WsHandshake
      /** Reconnect attempt number while `reconnecting`. */
      attempt?: number
    }
  | { type: 'message'; entry: RealtimeLogEntry }
)

export type GrpcCallType = 'unary' | 'server-stream' | 'client-stream' | 'bidi'

export interface GrpcMethodInfo {
  service: string
  method: string
  /** `/pkg.Service/Method` */
  path: string
  requestType: string
  responseType: string
  callType: GrpcCallType
}

export interface GrpcServiceInfo {
  name: string
  methods: GrpcMethodInfo[]
}

export interface GrpcStatusInfo {
  code: number
  /** `OK`, `UNAVAILABLE`, … */
  name: string
  /** Server's status message (masked). */
  details: string
}

export type GrpcEvent = { callId: string } & (
  | { type: 'started'; callType: GrpcCallType; path: string; target: string; tls: boolean; requestMetadata: [string, string][] }
  | { type: 'headers'; metadata: [string, string][] }
  | { type: 'message'; entry: RealtimeLogEntry }
  | { type: 'end'; status: GrpcStatusInfo; trailers: [string, string][]; durationMs: number; hint?: string }
)

/** CA / client certificate / key for a gRPC request: paths stay on this machine (userData), keyed by request id. */
export interface GrpcTlsFiles {
  ca?: { path: string; name: string }
  cert?: { path: string; name: string }
  key?: { path: string; name: string }
}

// ---------------------------------------------------------------------------------------------
// Identity / settings / misc
// ---------------------------------------------------------------------------------------------

export type IdentityMode = 'auto' | 'managed-identity' | 'azure-cli' | 'browser'

export interface IdentitySettings {
  mode: IdentityMode
  /** Browser mode: tenant to sign in to (default `organizations`). Also passed to the CLI credential. */
  tenantId?: string
  /** Browser mode: public client id (default: the Azure CLI's well-known client id). */
  clientId?: string
  /** Managed identity: client id of a user-assigned identity (omit for system-assigned). */
  managedIdentityClientId?: string
}

export interface IdentityAccount {
  name?: string
  upn?: string
  oid?: string
  tid?: string
  appId?: string
}

export interface IdentityStatus {
  signedIn: boolean
  busy: boolean
  mode: IdentityMode
  account: IdentityAccount | null
  /** True when the `COURIER_FAKE_IDENTITY` test hook is active. */
  fake: boolean
  error?: string
}

export interface VaultConfig {
  /** Short name used in `{{vault:alias/name}}`. */
  alias: string
  /** e.g. `https://my-vault.vault.azure.net` */
  url: string
}

export interface Settings {
  http: {
    timeoutMs: number
    followRedirects: boolean
    maxRedirects: number
    verifyTls: boolean
    /** Bodies above this are truncated for display. */
    maxResponseBytes: number
  }
  scripts: {
    timeoutMs: number
    memoryLimitMb: number
  }
  identity: IdentitySettings
  keyVault: {
    /**
     * Your own vaults. First entry is the default vault for `{{vault:name}}` in Personal items;
     * team items look in their team's vaults first (see `Team.vaults`).
     */
    vaults: VaultConfig[]
    cacheTtlSeconds: number
  }
  /** Free-form bag for renderer preferences (theme, layout…). Persisted as-is. */
  ui: Record<string, unknown>
}

// ---------------------------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------------------------

/** `courier-team.json` at the root of a team container. */
export interface TeamManifest {
  version: 1
  name: string
  vaults: VaultConfig[]
}

export const TEAM_MANIFEST_BLOB = 'courier-team.json'

/** A Key Vault listed in a team manifest. Manifest content comes from teammates, so it is untrusted. */
export interface TeamVault {
  alias: string
  /** Canonical origin, e.g. `https://team-kv.vault.azure.net`. */
  url: string
  /** Host shown to the user when asking for approval. */
  host: string
  /** Approved on this machine for this team (approval is keyed by team + vault URL). */
  approved: boolean
}

export interface Team {
  /** Local id (this machine only); the container is identified by `accountUrl` + `container`. */
  id: Id
  /** From the manifest when there is one, otherwise the name given when joining. */
  name: string
  accountUrl: string
  container: string
  joinedAt: string
  /** ETag of the manifest as last read; null when the container has no manifest. */
  manifestEtag: string | null
  manifestReadAt?: string
  vaults: TeamVault[]
  /** Manifest vault entries Courier ignored, with the reason (e.g. not https). */
  rejectedVaults: { alias: string; url: string; reason: string }[]
}

export interface HistoryEntry {
  id: Id
  at: string
  name: string
  method: string
  /** Resolved URL with secrets masked. */
  url: string
  status?: number
  timeMs?: number
  sizeBytes?: number
  error?: string
  collectionId?: Id
  requestId?: Id
  /** The request *template* as sent (unresolved `{{…}}`, so no secret values). */
  request: RequestDef
}

export interface CookieInfo {
  key: string
  value: string
  domain: string
  path: string
  expires?: string
  httpOnly: boolean
  secure: boolean
  sameSite?: string
}

export interface SecretFinding {
  kind: ItemKind
  itemId: Id
  itemName: string
  /** Human path, e.g. `Users / Get user › auth (bearer token)`. */
  location: string
  field:
    | 'basic.password'
    | 'bearer.token'
    | 'apikey.value'
    | 'oauth2.clientSecret'
    | 'digest.password'
    | 'awsv4.secretKey'
    | 'awsv4.sessionToken'
    | 'ntlm.password'
    | 'jwt.secret'
    | 'header'
    /** A header of a saved response example (its request or its response). */
    | 'example.header'
    /** gRPC metadata entry. */
    | 'metadata'
    | 'variable'
  /** First/last characters only, e.g. `eyJh…X1c`. */
  preview: string
  suggestion: string
}

export interface SecretSummary {
  name: string
  enabled: boolean
  contentType?: string
  createdOn?: string
  updatedOn?: string
  version?: string
}

export interface SecretValue extends SecretSummary {
  value: string
}

export type SnippetLanguage = 'curl' | 'js-fetch' | 'python-requests'

// ---------------------------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------------------------

export function newId(): Id {
  return globalThis.crypto.randomUUID()
}

export function newRequest(partial: Partial<RequestDef> = {}): RequestDef {
  return {
    type: 'request',
    id: partial.id ?? newId(),
    name: partial.name ?? 'New Request',
    description: partial.description ?? '',
    method: partial.method ?? 'GET',
    url: partial.url ?? '',
    params: partial.params ?? [],
    pathVariables: partial.pathVariables ?? [],
    headers: partial.headers ?? [],
    body: partial.body ?? { mode: 'none' },
    auth: partial.auth ?? { type: 'inherit' },
    preRequestScript: partial.preRequestScript ?? '',
    testScript: partial.testScript ?? '',
    settings: partial.settings ?? {},
    ...(partial.examples?.length ? { examples: partial.examples } : {})
  }
}

export function newWebSocketRequest(partial: Partial<WebSocketRequestDef> = {}): WebSocketRequestDef {
  return {
    type: 'websocket',
    id: partial.id ?? newId(),
    name: partial.name ?? 'New WebSocket',
    description: partial.description ?? '',
    url: partial.url ?? '',
    params: partial.params ?? [],
    headers: partial.headers ?? [],
    subprotocols: partial.subprotocols ?? [],
    auth: partial.auth ?? { type: 'inherit' },
    message: partial.message ?? { kind: 'text', format: 'json', body: '' },
    savedMessages: partial.savedMessages ?? [],
    settings: partial.settings ?? {}
  }
}

export function newGrpcRequest(partial: Partial<GrpcRequestDef> = {}): GrpcRequestDef {
  return {
    type: 'grpc',
    id: partial.id ?? newId(),
    name: partial.name ?? 'New gRPC',
    description: partial.description ?? '',
    address: partial.address ?? '',
    tls: partial.tls ?? false,
    metadata: partial.metadata ?? [],
    auth: partial.auth ?? { type: 'inherit' },
    service: partial.service ?? '',
    method: partial.method ?? '',
    message: partial.message ?? '{}',
    descriptor: partial.descriptor ?? null,
    settings: partial.settings ?? {}
  }
}

export function newFolder(partial: Partial<Folder> = {}): Folder {
  return {
    type: 'folder',
    id: partial.id ?? newId(),
    name: partial.name ?? 'New Folder',
    description: partial.description ?? '',
    auth: partial.auth ?? { type: 'inherit' },
    preRequestScript: partial.preRequestScript ?? '',
    testScript: partial.testScript ?? '',
    items: partial.items ?? []
  }
}

export function newCollection(partial: Partial<Collection> = {}): Collection {
  return {
    id: partial.id ?? newId(),
    name: partial.name ?? 'New Collection',
    description: partial.description ?? '',
    auth: partial.auth ?? { type: 'none' },
    variables: partial.variables ?? [],
    preRequestScript: partial.preRequestScript ?? '',
    testScript: partial.testScript ?? '',
    items: partial.items ?? [],
    ...(partial.updatedBy !== undefined ? { updatedBy: partial.updatedBy } : {}),
    ...(partial.updatedAt !== undefined ? { updatedAt: partial.updatedAt } : {})
  }
}

export function newEnvironment(partial: Partial<Environment> = {}): Environment {
  return {
    id: partial.id ?? newId(),
    name: partial.name ?? 'New Environment',
    variables: partial.variables ?? []
  }
}

export function newVariable(key: string, value = '', type: VariableType = 'default'): Variable {
  return { key, value, enabled: true, type }
}

/** Depth-first walk over items, yielding each item with its ancestor folders (outermost first). */
export function* walkItems(items: Item[], parents: Folder[] = []): Generator<{ item: Item; parents: Folder[] }> {
  for (const item of items) {
    yield { item, parents }
    if (item.type === 'folder') yield* walkItems(item.items, [...parents, item])
  }
}

export function findItem(items: Item[], id: Id): { item: Item; parents: Folder[] } | undefined {
  for (const entry of walkItems(items)) if (entry.item.id === id) return entry
  return undefined
}
