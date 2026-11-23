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

export type Auth =
  | { type: 'inherit' }
  | { type: 'none' }
  | { type: 'basic'; username: string; password: string }
  | { type: 'bearer'; token: string }
  | { type: 'apikey'; key: string; value: string; in: 'header' | 'query' }
  | {
      type: 'oauth2'
      grantType: 'client_credentials'
      accessTokenUrl: string
      clientId: string
      clientSecret: string
      scope: string
      audience: string
      /** `header` = HTTP Basic client auth, `body` = client_id/client_secret form fields. */
      clientAuthentication: 'header' | 'body'
    }
  /** Token from the signed-in Azure identity for `scope` (e.g. `https://graph.microsoft.com/.default`). */
  | { type: 'entra'; scope: string }

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

export type Item = Folder | RequestDef

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
  stoppedReason?: 'user' | 'failure' | 'error'
  results: RunItemResult[]
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
  field: 'basic.password' | 'bearer.token' | 'apikey.value' | 'oauth2.clientSecret' | 'header' | 'variable'
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
