/**
 * Single-request pipeline (pure Node, no Electron):
 *   inherit chain → pre-request scripts (collection → folders → request) → `{{var}}` substitution →
 *   Key Vault references → auth → HTTP → test scripts (collection → folders → request) → result.
 *
 * Key Vault values and acquired tokens are tracked by a `Masker` and replaced with `••••` in
 * everything returned (request info, console, test messages, mutations, response) — only the live
 * request on the wire carries them.
 *
 * Scripts and Key Vault (see script-trust.ts): unless `deps.scriptVault.allowed`, no script can obtain
 * a resolved Key Vault value. `pm.vault.get` and `pm.sendRequest` with `{{vault:…}}` reject with
 * VAULT_SCRIPT_BLOCKED; variables whose value holds a `{{vault:…}}` reference read as `••••`; test
 * scripts see the response with secrets masked; and a pre-request script may not add vault references
 * to the request or change where a request carrying them goes. Declarative `{{vault:…}}` references
 * in the saved request itself still resolve.
 */
import type { CookieJar } from 'tough-cookie'
import type {
  Auth,
  Collection,
  ConsoleEntry,
  ExecutionResult,
  Folder,
  KeyValue,
  RequestDef,
  ResolvedRequestInfo,
  ScriptError,
  ScriptSource,
  Settings,
  TestResult,
  VariableMutation
} from '../shared/types'
import type { SnippetBody, SnippetRequest } from '../shared/codegen'
import { MASK, buildUrl, encodeQueryComponent, findVaultRefs, normalizeUrl, replaceVaultRefs, resolveTemplate, type VariableLayers } from '../shared/variables'
import { Fault, toErrorInfo } from './errors'
import { buildMultipart, readBodyFile, sendHttp, type PreparedRequest } from './http'
import { runScript, type SandboxRequest, type SandboxResponse, type ScriptHooks, type ScriptVars } from './sandbox'
import { VAULT_SCRIPT_BLOCKED, blockedMessage, type ScriptVaultGate } from './script-trust'

export const USER_AGENT = 'Courier/0.1'

export interface VaultResolver {
  /** Resolve `name`, `alias/name`, `name@version` → secret value. Throws Fault. */
  resolve(ref: string): Promise<string>
}

export interface EntraTokenSource {
  getToken(scope: string): Promise<string>
}

export interface ExecutorDeps {
  settings: Settings
  tokens?: EntraTokenSource | null
  vault?: VaultResolver | null
  cookieJar?: CookieJar
  oauthCache?: Map<string, { token: string; exp: number }>
  /**
   * Gate for body files (binary / form-data). Paths in docs can come from team collections or
   * imports, so main only allows files the user picked on this machine. Default: allow none.
   */
  fileAllowed?: (path: string) => boolean
  /**
   * Whether scripts may obtain Key Vault values in this execution (decided by core from this
   * machine's allow-list). Default: not allowed.
   */
  scriptVault?: ScriptVaultGate
}

export interface ExecutionScope {
  collection: Collection | null
  /** Ancestor folders, outermost first. */
  folders: Folder[]
  request: RequestDef
  /** Mutable variable layers; updated in place with script changes. */
  vars: ScriptVars
  iteration?: number
  iterationCount?: number
  /**
   * Variables before any script of this execution (the runner passes the values from the start of
   * the run). Used to detect scripts redirecting Key Vault references. Default: `vars` at entry.
   */
  baselineVars?: ScriptVars
}

export interface ExecuteOptions {
  executionId: string
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------------------------

export class Masker {
  private readonly secrets = new Set<string>()
  /** Registers a secret plus the encodings it may appear in (URL, form, JSON-escaped). */
  add(value: string | undefined | null): void {
    if (!value || value.length < 3) return
    const variants = [
      value,
      encodeURIComponent(value),
      encodeQueryComponent(value),
      encodeURI(value),
      new URLSearchParams({ v: value }).toString().slice(2),
      JSON.stringify(value).slice(1, -1)
    ]
    for (const v of variants) if (v.length >= 3) this.secrets.add(v)
  }
  /** True when `text` contains a registered secret. */
  hits(text: string): boolean {
    for (const s of this.secrets) if (text.includes(s)) return true
    return false
  }
  get size(): number {
    return this.secrets.size
  }
  mask(text: string): string {
    if (!text || !this.secrets.size) return text
    let out = text
    for (const s of [...this.secrets].sort((a, b) => b.length - a.length)) if (out.includes(s)) out = out.split(s).join(MASK)
    return out
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

export function effectiveAuth(collection: Collection | null, folders: Folder[], request: RequestDef | null): { auth: Auth; from: string } {
  if (request && request.auth.type !== 'inherit') return { auth: request.auth, from: request.name }
  for (let i = folders.length - 1; i >= 0; i--) if (folders[i].auth.type !== 'inherit') return { auth: folders[i].auth, from: folders[i].name }
  if (collection && collection.auth.type !== 'inherit') return { auth: collection.auth, from: collection.name }
  return { auth: { type: 'none' }, from: collection?.name ?? '' }
}

function layers(v: ScriptVars): VariableLayers {
  return { global: v.global, collection: v.collection, environment: v.environment, data: v.data, local: v.local }
}

const CONTENT_TYPES: Record<string, string> = {
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  javascript: 'application/javascript',
  text: 'text/plain'
}

function hasHeader(h: [string, string][], name: string): boolean {
  return h.some(([k]) => k.toLowerCase() === name.toLowerCase())
}
function setHeader(h: [string, string][], name: string, value: string): void {
  const i = h.findIndex(([k]) => k.toLowerCase() === name.toLowerCase())
  if (i >= 0) h[i] = [h[i][0], value]
  else h.push([name, value])
}

function toSandboxRequest(r: RequestDef): SandboxRequest {
  const body: SandboxRequest['body'] = { mode: r.body.mode }
  if (r.body.mode === 'raw') body.raw = r.body.raw
  if (r.body.mode === 'urlencoded') body.urlencoded = r.body.urlencoded.map((p) => ({ key: p.key, value: p.value, disabled: !p.enabled }))
  if (r.body.mode === 'formdata') body.formdata = r.body.formdata.map((p) => ({ key: p.key, value: p.kind === 'file' ? (p.filePath ?? '') : p.value, disabled: !p.enabled }))
  if (r.body.mode === 'graphql') body.graphql = { ...r.body.graphql }
  return {
    id: r.id,
    name: r.name,
    method: r.method,
    url: buildUrl(r.url, r.params),
    headers: r.headers.map((h) => ({ key: h.key, value: h.value, ...(h.enabled ? {} : { disabled: true }) })),
    body
  }
}

/** Apply script edits (url/method/headers/raw body) back onto the request template. */
function fromSandboxRequest(orig: RequestDef, before: SandboxRequest, after: SandboxRequest): RequestDef {
  const r = structuredClone(orig)
  if (after.url !== before.url) {
    r.url = after.url
    r.params = []
  }
  r.method = after.method || r.method
  r.headers = after.headers.map((h) => ({ key: h.key, value: h.value, enabled: !h.disabled }))
  if (r.body.mode === 'raw' && typeof after.body?.raw === 'string') r.body = { ...r.body, raw: after.body.raw }
  return r
}

// ---------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------

interface Resolved {
  method: string
  /** URL template part (resolved); params/path variables are assembled by `finalUrl()` after the vault pass. */
  url: string
  params: KeyValue[]
  pathVariables: KeyValue[]
  headers: [string, string][]
  body: RequestDef['body']
  auth: Auth
}

/** `{{var}}` substitution everywhere (vault refs left in place). */
function substitute(r: RequestDef, auth: Auth, l: VariableLayers): Resolved {
  const t = (s: string): string => resolveTemplate(s, l)
  const kv = (list: KeyValue[]): KeyValue[] => list.filter((p) => p.enabled).map((p) => ({ ...p, key: t(p.key), value: t(p.value) }))
  const url = t(r.url)
  const params = kv(r.params)
  const pathVariables = kv(r.pathVariables)
  const headers: [string, string][] = kv(r.headers).filter((h) => h.key !== '').map((h) => [h.key, h.value])
  let body: RequestDef['body'] = r.body
  switch (r.body.mode) {
    case 'raw':
      body = { ...r.body, raw: t(r.body.raw) }
      break
    case 'urlencoded':
      body = { mode: 'urlencoded', urlencoded: kv(r.body.urlencoded) }
      break
    case 'formdata':
      body = {
        mode: 'formdata',
        formdata: r.body.formdata
          .filter((f) => f.enabled)
          .map((f) => ({ ...f, key: t(f.key), value: t(f.value), ...(f.filePath ? { filePath: t(f.filePath) } : {}) }))
      }
      break
    case 'graphql':
      body = { mode: 'graphql', graphql: { query: t(r.body.graphql.query), variables: t(r.body.graphql.variables) } }
      break
    case 'binary':
      body = { mode: 'binary', filePath: t(r.body.filePath) }
      break
  }
  let a: Auth = auth
  switch (auth.type) {
    case 'basic':
      a = { ...auth, username: t(auth.username), password: t(auth.password) }
      break
    case 'bearer':
      a = { ...auth, token: t(auth.token) }
      break
    case 'apikey':
      a = { ...auth, key: t(auth.key), value: t(auth.value) }
      break
    case 'oauth2':
      a = {
        ...auth,
        accessTokenUrl: t(auth.accessTokenUrl),
        clientId: t(auth.clientId),
        clientSecret: t(auth.clientSecret),
        scope: t(auth.scope),
        audience: t(auth.audience)
      }
      break
    case 'entra':
      a = { ...auth, scope: t(auth.scope) }
      break
  }
  return { method: r.method.toUpperCase(), url, params, pathVariables, headers, body, auth: a }
}

/** Map every string in the resolved request through `fn`. */
function mapStrings(r: Resolved, fn: (s: string) => string): Resolved {
  const out: Resolved = {
    method: r.method,
    url: fn(r.url),
    params: r.params.map((p) => ({ ...p, key: fn(p.key), value: fn(p.value) })),
    pathVariables: r.pathVariables.map((p) => ({ ...p, key: fn(p.key), value: fn(p.value) })),
    headers: r.headers.map(([k, v]) => [fn(k), fn(v)]),
    body: r.body,
    auth: r.auth
  }
  const b = r.body
  if (b.mode === 'raw') out.body = { ...b, raw: fn(b.raw) }
  else if (b.mode === 'urlencoded') out.body = { mode: 'urlencoded', urlencoded: b.urlencoded.map((p) => ({ ...p, key: fn(p.key), value: fn(p.value) })) }
  else if (b.mode === 'formdata') out.body = { mode: 'formdata', formdata: b.formdata.map((p) => ({ ...p, key: fn(p.key), value: fn(p.value) })) }
  else if (b.mode === 'graphql') out.body = { mode: 'graphql', graphql: { query: fn(b.graphql.query), variables: fn(b.graphql.variables) } }
  const a = r.auth
  if (a.type === 'basic') out.auth = { ...a, username: fn(a.username), password: fn(a.password) }
  else if (a.type === 'bearer') out.auth = { ...a, token: fn(a.token) }
  else if (a.type === 'apikey') out.auth = { ...a, key: fn(a.key), value: fn(a.value) }
  else if (a.type === 'oauth2') out.auth = { ...a, accessTokenUrl: fn(a.accessTokenUrl), clientId: fn(a.clientId), clientSecret: fn(a.clientSecret), scope: fn(a.scope), audience: fn(a.audience) }
  else if (a.type === 'entra') out.auth = { ...a, scope: fn(a.scope) }
  return out
}

async function resolveVaultRefs(r: Resolved, vault: VaultResolver | null | undefined, masker: Masker): Promise<Resolved> {
  const refs = new Set<string>()
  mapStrings(r, (s) => {
    for (const ref of findVaultRefs(s)) refs.add(ref)
    return s
  })
  if (!refs.size) return r
  if (!vault) throw new Fault('NOT_CONFIGURED', 'This request uses Key Vault references but Key Vault is not available.')
  const values = new Map<string, string>()
  for (const ref of refs) {
    const v = await vault.resolve(ref)
    values.set(ref, v)
    masker.add(v)
  }
  return mapStrings(r, (s) => replaceVaultRefs(s, (ref) => values.get(ref) ?? ''))
}

function vaultRefsIn(r: Resolved): Set<string> {
  const refs = new Set<string>()
  mapStrings(r, (s) => {
    for (const ref of findVaultRefs(s)) refs.add(ref)
    return s
  })
  return refs
}

function originOf(url: string): string {
  try {
    return new URL(normalizeUrl(url)).origin
  } catch {
    return url.trim().split(/[/?#]/, 3).join('/').toLowerCase()
  }
}

/** Where a resolved request (and its OAuth token request) would go. */
function destinations(r: Resolved): string {
  return `${originOf(finalUrl(r))}|${r.auth.type === 'oauth2' ? originOf(r.auth.accessTokenUrl) : ''}`
}

const VAR_LAYERS = ['global', 'collection', 'environment', 'data', 'local'] as const
type Hidden = { layer: (typeof VAR_LAYERS)[number]; key: string; value: string }[]

/** Copy of the variables in which every value holding a `{{vault:…}}` reference reads as MASK. */
function hideVaultValues(v: ScriptVars): { vars: ScriptVars; hidden: Hidden } {
  const hidden: Hidden = []
  const out = { global: { ...v.global }, collection: { ...v.collection }, environment: { ...v.environment }, data: { ...v.data }, local: { ...v.local } }
  for (const layer of VAR_LAYERS)
    for (const [key, value] of Object.entries(out[layer]))
      if (findVaultRefs(value).length) {
        hidden.push({ layer, key, value })
        out[layer][key] = MASK
      }
  return { vars: out, hidden }
}

async function fetchClientCredentialsToken(
  a: Extract<Auth, { type: 'oauth2' }>,
  deps: ExecutorDeps,
  signal?: AbortSignal
): Promise<string> {
  const key = [a.accessTokenUrl, a.clientId, a.scope, a.audience, a.clientAuthentication, a.clientSecret.length, hashish(a.clientSecret)].join('|')
  const cache = deps.oauthCache
  const hit = cache?.get(key)
  if (hit && hit.exp - Date.now() > 30_000) return hit.token
  const form = new URLSearchParams({ grant_type: 'client_credentials' })
  if (a.scope) form.set('scope', a.scope)
  if (a.audience) form.set('audience', a.audience)
  const headers: [string, string][] = [
    ['Content-Type', 'application/x-www-form-urlencoded'],
    ['Accept', 'application/json']
  ]
  if (a.clientAuthentication === 'header')
    headers.push(['Authorization', 'Basic ' + Buffer.from(`${encodeURIComponent(a.clientId)}:${encodeURIComponent(a.clientSecret)}`).toString('base64')])
  else {
    form.set('client_id', a.clientId)
    form.set('client_secret', a.clientSecret)
  }
  const res = await sendHttp(
    { method: 'POST', url: a.accessTokenUrl, headers, body: form.toString() },
    { ...httpOptions(deps.settings, {}), signal }
  )
  let json: { access_token?: string; expires_in?: number; error?: string; error_description?: string } = {}
  try {
    json = JSON.parse(res.bodyText)
  } catch {
    /* handled below */
  }
  if (res.status >= 400 || !json.access_token)
    throw new Fault('AUTH_FAILED', `OAuth 2.0 token request failed (${res.status}): ${json.error_description ?? json.error ?? res.bodyText.slice(0, 200)}`)
  cache?.set(key, { token: json.access_token, exp: Date.now() + (json.expires_in ?? 3600) * 1000 })
  return json.access_token
}

function hashish(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36)
}

function httpOptions(settings: Settings, req: RequestDef['settings']): {
  followRedirects: boolean
  maxRedirects: number
  verifyTls: boolean
  timeoutMs: number
  maxResponseBytes: number
} {
  return {
    followRedirects: req.followRedirects ?? settings.http.followRedirects,
    maxRedirects: req.maxRedirects ?? settings.http.maxRedirects,
    verifyTls: req.verifyTls ?? settings.http.verifyTls,
    timeoutMs: req.timeoutMs ?? settings.http.timeoutMs,
    maxResponseBytes: settings.http.maxResponseBytes
  }
}

function finalUrl(r: Resolved): string {
  return buildUrl(r.url, r.params, r.pathVariables)
}

async function applyAuth(r: Resolved, deps: ExecutorDeps, masker: Masker, signal?: AbortSignal): Promise<Resolved> {
  const a = r.auth
  const headers = [...r.headers]
  let url = finalUrl(r)
  switch (a.type) {
    case 'basic': {
      const credential = Buffer.from(`${a.username}:${a.password}`).toString('base64')
      if (masker.hits(`${a.username}:${a.password}`)) masker.add(credential)
      setHeader(headers, 'Authorization', 'Basic ' + credential)
      break
    }
    case 'bearer':
      if (a.token) setHeader(headers, 'Authorization', `Bearer ${a.token}`)
      break
    case 'apikey':
      if (!a.key) break
      if (a.in === 'header') setHeader(headers, a.key, a.value)
      else url = buildUrl(url, [{ key: a.key, value: a.value, enabled: true }])
      break
    case 'oauth2': {
      if (!a.accessTokenUrl) throw new Fault('INVALID_ARGUMENT', 'OAuth 2.0: access token URL is empty.')
      const token = await fetchClientCredentialsToken(a, deps, signal)
      masker.add(token)
      setHeader(headers, 'Authorization', `Bearer ${token}`)
      break
    }
    case 'entra': {
      if (!a.scope) throw new Fault('INVALID_ARGUMENT', 'Entra auth: scope is empty (e.g. https://graph.microsoft.com/.default).')
      if (!deps.tokens) throw new Fault('NOT_SIGNED_IN', 'Sign in with your Azure identity to use Entra auth.')
      const token = await deps.tokens.getToken(a.scope)
      masker.add(token)
      setHeader(headers, 'Authorization', `Bearer ${token}`)
      break
    }
  }
  return { ...r, headers, url, params: [], pathVariables: [] }
}

async function buildBody(r: Resolved, fileAllowed: (path: string) => boolean): Promise<{ body: Buffer | string | null; headers: [string, string][]; preview?: string }> {
  const headers = [...r.headers]
  const b = r.body
  switch (b.mode) {
    case 'none':
      return { body: null, headers }
    case 'raw':
      if (!hasHeader(headers, 'content-type') && b.raw) headers.push(['Content-Type', CONTENT_TYPES[b.language] ?? 'text/plain'])
      return { body: b.raw, headers, preview: b.raw }
    case 'urlencoded': {
      const text = b.urlencoded.map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&')
      if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded'])
      return { body: text, headers, preview: text }
    }
    case 'formdata': {
      for (const f of b.formdata)
        if (f.kind === 'file' && !fileAllowed(f.filePath ?? ''))
          throw new Fault('INVALID_ARGUMENT', `Re-select the file for form field "${f.key}" — files must be chosen on this machine (files.pickFile).`)
      const mp = await buildMultipart(
        b.formdata.map((f) => (f.kind === 'file' ? { key: f.key, filePath: f.filePath ?? '', contentType: f.contentType } : { key: f.key, value: f.value, contentType: f.contentType }))
      )
      const i = headers.findIndex(([k]) => k.toLowerCase() === 'content-type')
      if (i >= 0) headers.splice(i, 1)
      headers.push(['Content-Type', mp.contentType])
      return {
        body: mp.body,
        headers,
        preview: b.formdata.map((f) => `${f.key}=${f.kind === 'file' ? `@${f.filePath ?? ''}` : f.value}`).join('\n')
      }
    }
    case 'graphql': {
      let variables: unknown = {}
      if (b.graphql.variables.trim()) {
        try {
          variables = JSON.parse(b.graphql.variables)
        } catch {
          throw new Fault('INVALID_ARGUMENT', 'GraphQL variables are not valid JSON.')
        }
      }
      const text = JSON.stringify({ query: b.graphql.query, variables })
      if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', 'application/json'])
      return { body: text, headers, preview: text }
    }
    case 'binary': {
      if (!b.filePath) return { body: null, headers }
      if (!fileAllowed(b.filePath)) throw new Fault('INVALID_ARGUMENT', 'Re-select the body file — files must be chosen on this machine (files.pickFile).')
      const data = await readBodyFile(b.filePath)
      if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', 'application/octet-stream'])
      return { body: data, headers, preview: `[file ${b.filePath}, ${data.length} bytes]` }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------------------------

export async function executeRequest(scope: ExecutionScope, deps: ExecutorDeps, opts: ExecuteOptions): Promise<ExecutionResult> {
  const started = Date.now()
  const masker = new Masker()
  const tests: TestResult[] = []
  const consoleEntries: ConsoleEntry[] = []
  const scriptErrors: ScriptError[] = []
  const mutations: VariableMutation[] = []
  const { collection, folders } = scope
  let request = scope.request
  const limits = { timeoutMs: deps.settings.scripts.timeoutMs, memoryLimitMb: deps.settings.scripts.memoryLimitMb }

  // Script → Key Vault gate (see script-trust.ts).
  const gate: ScriptVaultGate = deps.scriptVault ?? { allowed: false }
  const vaultOk = gate.allowed === true
  const blockMsg = blockedMessage(gate)
  const baselineVars: ScriptVars = structuredClone(scope.baselineVars ?? scope.vars)
  /** Scripts that tried to obtain a Key Vault value while blocked. */
  const blockedBy = new Set<ScriptSource>()
  let currentSource: ScriptSource | null = null
  const block = (): never => {
    if (currentSource) blockedBy.add(currentSource)
    throw new Fault(VAULT_SCRIPT_BLOCKED, blockMsg)
  }
  /** Team vault hosts not approved on this machine: keep the stable code when a script hits one. */
  const denied = new Map<ScriptSource, Fault>()
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof Fault && err.code === 'VAULT_NOT_APPROVED' && currentSource) denied.set(currentSource, err)
      throw err
    }
  }

  const hooks: ScriptHooks = {
    sendRequest: async (sr) => {
      let resolved: Resolved = { method: sr.method, url: sr.url, params: [], pathVariables: [], headers: sr.headers, body: sr.body !== undefined ? { mode: 'raw', raw: sr.body, language: 'text' } : { mode: 'none' }, auth: { type: 'none' } }
      if (!vaultOk && vaultRefsIn(resolved).size) block()
      resolved = await guard(() => resolveVaultRefs(resolved, deps.vault, masker))
      const res = await sendHttp(
        { method: resolved.method, url: resolved.url, headers: resolved.headers, body: resolved.body.mode === 'raw' ? resolved.body.raw : null },
        { ...httpOptions(deps.settings, {}), cookieJar: deps.cookieJar, signal: opts.signal }
      )
      return { code: res.status, status: res.statusText, headers: res.headers, body: res.bodyText, responseTime: res.timeMs }
    },
    vaultGet: async (ref) => {
      if (!vaultOk) block()
      const vault = deps.vault
      if (!vault) throw new Error('Key Vault is not configured.')
      const v = await guard(() => vault.resolve(ref))
      masker.add(v)
      return v
    }
  }

  const chain: { code: string; source: ScriptSource }[] = []
  const scripts = (phase: 'pre-request' | 'test'): { code: string; source: ScriptSource }[] => {
    chain.length = 0
    const pick = (x: { preRequestScript: string; testScript: string }): string => (phase === 'pre-request' ? x.preRequestScript : x.testScript)
    if (collection && pick(collection).trim()) chain.push({ code: pick(collection), source: { level: 'collection', name: collection.name, phase } })
    for (const f of folders) if (pick(f).trim()) chain.push({ code: pick(f), source: { level: 'folder', name: f.name, phase } })
    if (pick(request).trim()) chain.push({ code: pick(request), source: { level: 'request', name: request.name, phase } })
    return [...chain]
  }

  const runPhase = async (phase: 'pre-request' | 'test', response?: SandboxResponse): Promise<void> => {
    // Blocked scripts see the response the way the UI does: Key Vault values (and tokens) masked.
    if (response && !vaultOk && masker.size) {
      const m = (x: string): string => masker.mask(x)
      response = { ...response, body: m(response.body), headers: response.headers.map(([k, v]) => [k, m(v)]), cookies: response.cookies.map((c) => ({ ...c, value: m(c.value) })) }
    }
    for (const s of scripts(phase)) {
      if (opts.signal?.aborted) throw new Fault('CANCELLED', 'Request cancelled.')
      const before = toSandboxRequest(request)
      const shown = vaultOk ? { vars: scope.vars, hidden: [] as Hidden } : hideVaultValues(scope.vars)
      currentSource = s.source
      const outcome = await runScript(
        {
          code: s.code,
          source: s.source,
          request: before,
          response,
          vars: shown.vars,
          info: {
            requestName: request.name,
            requestId: request.id,
            iteration: scope.iteration ?? 0,
            iterationCount: scope.iterationCount ?? 1,
            eventName: phase === 'pre-request' ? 'prerequest' : 'test'
          }
        },
        hooks,
        limits
      )
      currentSource = null
      const isHidden = (layer: string, key: string): boolean => shown.hidden.some((h) => h.layer === layer && h.key === key)
      tests.push(...outcome.tests)
      consoleEntries.push(...outcome.console)
      // A blocked script copying a masked variable must not overwrite the stored reference with ••••.
      mutations.push(...outcome.mutations.filter((x) => !(x.action === 'set' && x.value === MASK && isHidden(x.scope, x.key))))
      const blocked = blockedBy.has(s.source)
      if (blocked) scriptErrors.push({ source: s.source, message: blockMsg, code: VAULT_SCRIPT_BLOCKED })
      // Like a blocked script, a script that reached for an unapproved team vault fails even if it swallowed the rejection.
      const hostDenied = denied.get(s.source)
      if (hostDenied) scriptErrors.push({ source: s.source, message: hostDenied.message, code: hostDenied.code })
      if (outcome.error && !(blocked && outcome.error.includes(blockMsg)) && !(hostDenied && outcome.error.includes(hostDenied.message))) scriptErrors.push({ source: s.source, message: outcome.error })
      // Put the hidden references back so declarative `{{var}}` → `{{vault:…}}` still resolves.
      for (const h of shown.hidden) if (outcome.vars[h.layer]?.[h.key] === MASK) outcome.vars[h.layer][h.key] = h.value
      Object.assign(scope.vars, outcome.vars)
      if (phase === 'pre-request') request = fromSandboxRequest(request, before, outcome.request)
    }
  }

  let info: ResolvedRequestInfo = { method: request.method, url: request.url, headers: [] }
  let result: Omit<ExecutionResult, 'tests' | 'console' | 'scriptErrors' | 'mutations' | 'durationMs'>
  try {
    await runPhase('pre-request')
    if (blockedBy.size) throw new Fault(VAULT_SCRIPT_BLOCKED, blockMsg)
    if (scriptErrors.length) {
      const e = scriptErrors.find((x) => x.code === 'VAULT_NOT_APPROVED') ?? scriptErrors[scriptErrors.length - 1]
      throw new Fault(e.code === 'VAULT_NOT_APPROVED' ? 'VAULT_NOT_APPROVED' : 'SCRIPT_ERROR', `Pre-request script (${e.source.level} "${e.source.name}") failed, request not sent: ${e.message}`)
    }
    const { auth } = effectiveAuth(collection, folders, request)
    let resolved = substitute(request, auth, layers(scope.vars))
    info = { method: resolved.method, url: finalUrl(resolved), headers: resolved.headers }
    if (!vaultOk) {
      // Scripts may not add Key Vault references or change where the ones the request declares go.
      const refs = vaultRefsIn(resolved)
      if (refs.size) {
        const declared = substitute(scope.request, effectiveAuth(collection, folders, scope.request).auth, layers(baselineVars))
        const declaredRefs = vaultRefsIn(declared)
        if ([...refs].some((r) => !declaredRefs.has(r)) || destinations(resolved) !== destinations(declared))
          throw new Fault(VAULT_SCRIPT_BLOCKED, `A script changed this request so that it would send Key Vault secrets somewhere else or add new ones; the request was not sent. ${blockMsg}`)
      }
    }
    resolved = await resolveVaultRefs(resolved, deps.vault, masker)
    resolved = await applyAuth(resolved, deps, masker, opts.signal)
    const built = await buildBody(resolved, deps.fileAllowed ?? (() => false))
    const headers = built.headers
    if (!hasHeader(headers, 'user-agent')) headers.push(['User-Agent', USER_AGENT])
    if (!hasHeader(headers, 'accept')) headers.push(['Accept', '*/*'])
    if (!hasHeader(headers, 'accept-encoding')) headers.push(['Accept-Encoding', 'gzip, deflate, br'])
    const prepared: PreparedRequest = { method: resolved.method, url: resolved.url, headers, body: built.body }
    info = {
      method: prepared.method,
      url: prepared.url,
      headers: prepared.headers,
      ...(built.preview !== undefined ? { bodyPreview: built.preview.length > 65536 ? built.preview.slice(0, 65536) + '…' : built.preview } : {})
    }
    const response = await sendHttp(prepared, { ...httpOptions(deps.settings, request.settings), cookieJar: deps.cookieJar, signal: opts.signal })
    await runPhase('test', {
      code: response.status,
      status: response.statusText,
      headers: response.headers,
      body: response.bodyText,
      responseTime: response.timeMs,
      responseSize: response.sizeBytes,
      cookies: response.cookies.map((c) => ({ name: c.name, value: c.value }))
    })
    result = { executionId: opts.executionId, name: request.name, request: info, response, startedAt: new Date(started).toISOString() }
  } catch (err) {
    result = { executionId: opts.executionId, name: request.name, request: info, error: toErrorInfo(err), startedAt: new Date(started).toISOString() }
  }

  // Mask everything that leaves the pipeline.
  const m = (s: string): string => masker.mask(s)
  const out: ExecutionResult = {
    ...result,
    request: {
      method: result.request.method,
      url: m(result.request.url),
      headers: result.request.headers.map(([k, v]) => [k, m(v)]),
      ...(result.request.bodyPreview !== undefined ? { bodyPreview: m(result.request.bodyPreview) } : {})
    },
    tests: tests.map((t) => ({ ...t, name: m(t.name), ...(t.error ? { error: m(t.error) } : {}) })),
    console: consoleEntries.map((c) => ({ ...c, message: m(c.message) })),
    scriptErrors: scriptErrors.map((e) => ({ ...e, message: m(e.message) })),
    mutations: mutations.map((x) => (x.value !== undefined ? { ...x, value: m(x.value) } : x)),
    durationMs: Date.now() - started
  }
  if (out.error) out.error = { ...out.error, message: m(out.error.message) }
  if (out.response && masker.size) {
    out.response = {
      ...out.response,
      bodyText: m(out.response.bodyText),
      headers: out.response.headers.map(([k, v]) => [k, m(v)]),
      finalUrl: m(out.response.finalUrl),
      redirects: out.response.redirects.map((r) => ({ ...r, url: m(r.url) })),
      cookies: out.response.cookies.map((c) => ({ ...c, value: m(c.value) }))
    }
  }
  // Variables holding a secret must never be persisted with the value.
  if (masker.size) {
    for (const layer of ['global', 'collection', 'environment', 'local'] as const) {
      const store = scope.vars[layer]
      for (const k of Object.keys(store)) store[k] = m(store[k])
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Snippets (no scripts, no network; vault refs and tokens become placeholders)
// ---------------------------------------------------------------------------------------------

export async function prepareSnippetRequest(scope: Omit<ExecutionScope, 'iteration' | 'iterationCount'>): Promise<SnippetRequest> {
  const { auth } = effectiveAuth(scope.collection, scope.folders, scope.request)
  let r = substitute(scope.request, auth, layers(scope.vars))
  r = mapStrings(r, (s) => replaceVaultRefs(s, () => MASK))
  const a = r.auth
  const headers = [...r.headers]
  let url = finalUrl(r)
  if (a.type === 'basic') setHeader(headers, 'Authorization', 'Basic ' + Buffer.from(`${a.username}:${a.password}`).toString('base64'))
  else if (a.type === 'bearer' && a.token) setHeader(headers, 'Authorization', `Bearer ${a.token}`)
  else if (a.type === 'apikey' && a.key) {
    if (a.in === 'header') setHeader(headers, a.key, a.value)
    else url = buildUrl(url, [{ key: a.key, value: a.value, enabled: true }])
  } else if (a.type === 'oauth2') setHeader(headers, 'Authorization', 'Bearer <oauth2-access-token>')
  else if (a.type === 'entra') setHeader(headers, 'Authorization', `Bearer <entra-token:${a.scope}>`)
  const b = r.body
  let body: SnippetBody = { kind: 'none' }
  if (b.mode === 'raw') {
    body = { kind: 'text', text: b.raw }
    if (!hasHeader(headers, 'content-type') && b.raw) headers.push(['Content-Type', CONTENT_TYPES[b.language] ?? 'text/plain'])
  } else if (b.mode === 'urlencoded') {
    body = { kind: 'urlencoded', fields: b.urlencoded.map((p) => [p.key, p.value]) }
    if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded'])
  } else if (b.mode === 'formdata') body = { kind: 'formdata', fields: b.formdata.map((f) => (f.kind === 'file' ? { key: f.key, filePath: f.filePath ?? '' } : { key: f.key, value: f.value })) }
  else if (b.mode === 'graphql') {
    let variables: unknown = {}
    try {
      variables = b.graphql.variables.trim() ? JSON.parse(b.graphql.variables) : {}
    } catch {
      variables = {}
    }
    body = { kind: 'text', text: JSON.stringify({ query: b.graphql.query, variables }) }
    if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', 'application/json'])
  } else if (b.mode === 'binary' && b.filePath) body = { kind: 'file', filePath: b.filePath }
  return { method: r.method, url, headers, body }
}
