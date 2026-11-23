/**
 * Postman Collection v2.1 (and v2.0 on import) + Postman environment import/export (pure).
 *
 * Mapping notes:
 *  - request without `auth` → `inherit`; `noauth` → `none`; unsupported auth types → `inherit` + warning.
 *  - Courier `entra` auth has no Postman equivalent: exported as `bearer` with token
 *    `{{courier_entra:<scope>}}`, recognised again on import.
 *  - `secret` variables are exported with an empty value (current values are never exported).
 *  - `vault` variables are exported as default variables whose value is `{{vault:ref}}`.
 *  - OAuth 2.0: client credentials and authorization code (with or without PKCE) round-trip;
 *    Courier's extra authorize parameters map to Postman's `authRequestParams`. Other grants
 *    (implicit, password) import as authorization code / client credentials with a warning.
 *  - Digest, AWS Signature, NTLM and JWT bearer map field by field. Postman's pre-filled Digest
 *    values (realm, nonce, qop…) are ignored: Courier always answers the server's challenge.
 */
import type {
  Auth,
  JwtAlgorithm,
  Collection,
  Environment,
  FormDataField,
  Folder,
  Item,
  KeyValue,
  RawLanguage,
  RequestBody,
  RequestDef,
  Variable
} from './types'
import { JWT_ALGORITHMS, newCollection, newEnvironment, newFolder, newId, newRequest } from './types'
import { buildUrl, splitQuery, toVaultTemplate } from './variables'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const s = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '')
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

export const POSTMAN_SCHEMA_V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
const ENTRA_TOKEN = /^\{\{courier_entra:(.+)\}\}$/

export interface ImportOutcome<T> {
  value: T
  warnings: string[]
}

export function isPostmanCollection(json: unknown): boolean {
  return isObj(json) && isObj(json.info) && (s(json.info.schema).includes('getpostman.com/json/collection') || Array.isArray(json.item))
}

export function isPostmanEnvironment(json: unknown): boolean {
  return isObj(json) && Array.isArray(json.values) && typeof json.name === 'string' && !('info' in json)
}

// ---------------------------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------------------------

function description(v: unknown): string {
  if (typeof v === 'string') return v
  if (isObj(v)) return s(v.content)
  return ''
}

function script(events: unknown, listen: 'prerequest' | 'test'): string {
  for (const e of arr(events)) {
    if (!isObj(e) || e.listen !== listen || e.disabled === true) continue
    const sc = isObj(e.script) ? e.script : {}
    const exec = sc.exec
    return Array.isArray(exec) ? exec.map(s).join('\n') : s(exec)
  }
  return ''
}

/** v2.1 `[{key,value}]` or v2.0 `{key: value}` → map. */
function authParams(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(v)) for (const p of v) if (isObj(p)) out[s(p.key)] = s(p.value)
  if (isObj(v)) for (const [k, val] of Object.entries(v)) out[k] = s(val)
  return out
}

/** The raw (non-stringified) value of one v2.1 auth parameter, e.g. an array. */
function rawAuthParam(v: unknown, key: string): unknown {
  if (Array.isArray(v)) for (const p of v) if (isObj(p) && p.key === key) return p.value
  if (isObj(v)) return v[key]
  return undefined
}

const truthyParam = (v: string | undefined): boolean => v === 'true'

function importAuth(v: unknown, warnings: string[], where: string, missing: Auth): Auth {
  if (!isObj(v)) return missing
  const type = s(v.type)
  const p = authParams(v[type])
  switch (type) {
    case 'noauth':
      return { type: 'none' }
    case 'basic':
      return { type: 'basic', username: p.username ?? '', password: p.password ?? '' }
    case 'bearer': {
      const token = p.token ?? ''
      const m = ENTRA_TOKEN.exec(token)
      return m ? { type: 'entra', scope: m[1] } : { type: 'bearer', token }
    }
    case 'apikey':
      return { type: 'apikey', key: p.key ?? '', value: p.value ?? '', in: p.in === 'query' ? 'query' : 'header' }
    case 'oauth2': {
      const grant = p.grant_type ?? 'client_credentials'
      const code = grant === 'authorization_code' || grant === 'authorization_code_with_pkce' || grant === 'implicit'
      if (grant !== 'client_credentials' && grant !== 'authorization_code' && grant !== 'authorization_code_with_pkce')
        warnings.push(`${where}: OAuth 2.0 grant "${grant}" is not supported; imported as ${code ? 'authorization code with PKCE' : 'client credentials'}.`)
      const base = {
        type: 'oauth2' as const,
        accessTokenUrl: p.accessTokenUrl ?? '',
        clientId: p.clientId ?? '',
        clientSecret: p.clientSecret ?? '',
        scope: p.scope ?? '',
        audience: p.audience ?? '',
        clientAuthentication: p.client_authentication === 'body' ? ('body' as const) : ('header' as const)
      }
      if (!code) return { ...base, grantType: 'client_credentials' }
      const extra = new URLSearchParams()
      for (const x of arr(rawAuthParam(v[type], 'authRequestParams')))
        if (isObj(x) && x.enabled !== false && s(x.key) && s(x.key) !== 'audience') extra.append(s(x.key), s(x.value))
      return {
        ...base,
        grantType: 'authorization_code',
        authUrl: p.authUrl ?? '',
        redirectUri: /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(p.redirect_uri ?? '') ? (p.redirect_uri ?? '') : '',
        pkce: grant !== 'authorization_code',
        extraParams: extra.toString()
      }
    }
    case 'digest':
      return { type: 'digest', username: p.username ?? '', password: p.password ?? '' }
    case 'ntlm':
      return { type: 'ntlm', username: p.username ?? '', password: p.password ?? '', domain: p.domain ?? '', workstation: p.workstation ?? '' }
    case 'awsv4':
      return {
        type: 'awsv4',
        accessKey: p.accessKey ?? '',
        secretKey: p.secretKey ?? '',
        sessionToken: p.sessionToken ?? '',
        region: p.region ?? '',
        service: p.service ?? '',
        addTo: truthyParam(p.addAuthDataToQuery) ? 'query' : 'header'
      }
    case 'jwt': {
      const alg = (JWT_ALGORITHMS as readonly string[]).includes(p.algorithm ?? '') ? (p.algorithm as JwtAlgorithm) : 'HS256'
      if (p.algorithm && alg !== p.algorithm) warnings.push(`${where}: JWT algorithm "${p.algorithm}" is not supported; imported as HS256.`)
      return {
        type: 'jwt',
        algorithm: alg,
        secret: alg.startsWith('HS') ? (p.secret ?? '') : (p.privateKey ?? p.secret ?? ''),
        secretBase64: truthyParam(p.isSecretBase64Encoded),
        payload: p.payload ?? '',
        header: p.header ?? '',
        addTo: p.addTokenTo === 'queryParam' ? 'query' : 'header',
        headerPrefix: p.headerPrefix ?? 'Bearer',
        queryParamKey: p.queryParamKey ?? 'token'
      }
    }
    case '':
      return missing
    default:
      warnings.push(`${where}: auth type "${type}" is not supported and was replaced by "${missing.type}".`)
      return missing
  }
}

function importKv(v: unknown): KeyValue {
  const o = isObj(v) ? v : {}
  const kv: KeyValue = { key: s(o.key), value: s(o.value), enabled: o.disabled !== true }
  const d = description(o.description)
  if (d) kv.description = d
  return kv
}

function importUrl(v: unknown): { url: string; params: KeyValue[]; pathVariables: KeyValue[] } {
  if (typeof v === 'string') {
    const { base, params } = splitQuery(v)
    return { url: base, params, pathVariables: [] }
  }
  if (!isObj(v)) return { url: '', params: [], pathVariables: [] }
  let raw = s(v.raw)
  if (!raw) {
    const host = Array.isArray(v.host) ? v.host.map(s).join('.') : s(v.host)
    const path = Array.isArray(v.path) ? v.path.map((p) => (isObj(p) ? s(p.value) : s(p))).join('/') : s(v.path)
    const proto = s(v.protocol)
    raw = (proto ? proto + '://' : '') + host + (path ? '/' + path : '')
  }
  const split = splitQuery(raw)
  const params = Array.isArray(v.query) ? v.query.map(importKv) : split.params
  const pathVariables = arr(v.variable).map(importKv)
  return { url: split.base, params, pathVariables }
}

function importBody(v: unknown, warnings: string[], where: string): RequestBody {
  if (!isObj(v) || v.disabled === true) return { mode: 'none' }
  switch (v.mode) {
    case 'raw': {
      const opts = isObj(v.options) && isObj(v.options.raw) ? v.options.raw : {}
      const lang = s(opts.language) as RawLanguage
      return { mode: 'raw', raw: s(v.raw), language: ['json', 'text', 'xml', 'html', 'javascript'].includes(lang) ? lang : 'text' }
    }
    case 'urlencoded':
      return { mode: 'urlencoded', urlencoded: arr(v.urlencoded).map(importKv) }
    case 'formdata':
      return {
        mode: 'formdata',
        formdata: arr(v.formdata).map((f): FormDataField => {
          const o = isObj(f) ? f : {}
          const base = importKv(o)
          if (o.type === 'file') {
            const src = Array.isArray(o.src) ? s(o.src[0]) : s(o.src)
            if (Array.isArray(o.src) && o.src.length > 1) warnings.push(`${where}: only the first file of form field "${base.key}" was kept.`)
            const field: FormDataField = { ...base, value: '', kind: 'file' }
            if (src) field.filePath = src
            if (o.contentType) field.contentType = s(o.contentType)
            return field
          }
          const field: FormDataField = { ...base, kind: 'text' }
          if (o.contentType) field.contentType = s(o.contentType)
          return field
        })
      }
    case 'file': {
      const f = isObj(v.file) ? v.file : {}
      return { mode: 'binary', filePath: s(f.src) }
    }
    case 'graphql': {
      const g = isObj(v.graphql) ? v.graphql : {}
      return { mode: 'graphql', graphql: { query: s(g.query), variables: s(g.variables) } }
    }
    default:
      return { mode: 'none' }
  }
}

function importVariable(v: unknown): Variable {
  const o = isObj(v) ? v : {}
  const value = s(o.value)
  const t = o.type === 'secret' ? 'secret' : 'default'
  const variable: Variable = { key: s(o.key), value, enabled: o.disabled !== true && o.enabled !== false, type: t }
  const d = description(o.description)
  if (d) variable.description = d
  return variable
}

function importItem(v: unknown, warnings: string[], path: string): Item {
  const o = isObj(v) ? v : {}
  const name = s(o.name) || 'Untitled'
  const where = path ? `${path} / ${name}` : name
  if (Array.isArray(o.item)) {
    return newFolder({
      id: newId(),
      name,
      description: description(o.description),
      auth: importAuth(o.auth, warnings, where, { type: 'inherit' }),
      preRequestScript: script(o.event, 'prerequest'),
      testScript: script(o.event, 'test'),
      items: o.item.map((c) => importItem(c, warnings, where))
    })
  }
  const req = typeof o.request === 'string' ? { url: o.request, method: 'GET' } : isObj(o.request) ? o.request : {}
  const { url, params, pathVariables } = importUrl(req.url)
  return newRequest({
    id: newId(),
    name,
    description: description(req.description) || description(o.description),
    method: (s(req.method) || 'GET').toUpperCase(),
    url,
    params,
    pathVariables,
    headers: arr(req.header).map(importKv),
    body: importBody(req.body, warnings, where),
    auth: importAuth(req.auth, warnings, where, { type: 'inherit' }),
    preRequestScript: script(o.event, 'prerequest'),
    testScript: script(o.event, 'test')
  })
}

export function importPostmanCollection(json: unknown): ImportOutcome<Collection> {
  if (!isPostmanCollection(json)) throw new Error('Not a Postman collection (missing "info"/"item").')
  const o = json as Obj
  const info = isObj(o.info) ? o.info : {}
  const warnings: string[] = []
  const schema = s(info.schema)
  if (schema && !/v2\.[01]\.\d/.test(schema)) warnings.push(`Unrecognised collection schema "${schema}"; imported as v2.1.`)
  const collection = newCollection({
    id: newId(),
    name: s(info.name) || 'Imported collection',
    description: description(info.description),
    auth: importAuth(o.auth, warnings, 'Collection', { type: 'none' }),
    variables: arr(o.variable).map(importVariable),
    preRequestScript: script(o.event, 'prerequest'),
    testScript: script(o.event, 'test'),
    items: arr(o.item).map((i) => importItem(i, warnings, ''))
  })
  if (collection.auth.type === 'inherit') collection.auth = { type: 'none' }
  return { value: collection, warnings }
}

export function importPostmanEnvironment(json: unknown): ImportOutcome<Environment> {
  if (!isPostmanEnvironment(json)) throw new Error('Not a Postman environment (missing "name"/"values").')
  const o = json as Obj
  return {
    value: newEnvironment({ id: newId(), name: s(o.name), variables: arr(o.values).map(importVariable) }),
    warnings: []
  }
}

// ---------------------------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------------------------

function exportScriptEvents(pre: string, test: string): Obj[] | undefined {
  const ev: Obj[] = []
  if (pre) ev.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: pre.split('\n') } })
  if (test) ev.push({ listen: 'test', script: { type: 'text/javascript', exec: test.split('\n') } })
  return ev.length ? ev : undefined
}

function pmParams(p: Record<string, string>): Obj[] {
  return Object.entries(p).map(([key, value]) => ({ key, value, type: 'string' }))
}

/** v2.1 auth parameters with their JSON types (Postman writes booleans and arrays unquoted). */
function pmTyped(p: Record<string, unknown>): Obj[] {
  return Object.entries(p).map(([key, value]) => ({ key, value, type: typeof value === 'boolean' ? 'boolean' : Array.isArray(value) ? 'any' : 'string' }))
}

function exportAuth(a: Auth): Obj | undefined {
  switch (a.type) {
    case 'inherit':
      return undefined
    case 'none':
      return { type: 'noauth' }
    case 'basic':
      return { type: 'basic', basic: pmParams({ username: a.username, password: a.password }) }
    case 'bearer':
      return { type: 'bearer', bearer: pmParams({ token: a.token }) }
    case 'apikey':
      return { type: 'apikey', apikey: pmParams({ key: a.key, value: a.value, in: a.in }) }
    case 'oauth2':
      if (a.grantType === 'authorization_code')
        return {
          type: 'oauth2',
          oauth2: pmTyped({
            grant_type: a.pkce === false ? 'authorization_code' : 'authorization_code_with_pkce',
            ...(a.pkce === false ? {} : { challengeAlgorithm: 'S256' }),
            authUrl: a.authUrl ?? '',
            accessTokenUrl: a.accessTokenUrl,
            clientId: a.clientId,
            clientSecret: a.clientSecret,
            scope: a.scope,
            ...(a.redirectUri ? { redirect_uri: a.redirectUri } : {}),
            useBrowser: true,
            client_authentication: a.clientAuthentication,
            ...(a.audience || a.extraParams
              ? {
                  authRequestParams: [
                    ...(a.audience ? [{ key: 'audience', value: a.audience, enabled: true, send_as: 'request_url' }] : []),
                    ...[...new URLSearchParams(a.extraParams ?? '')].map(([key, value]) => ({ key, value, enabled: true, send_as: 'request_url' }))
                  ]
                }
              : {}),
            ...(a.audience ? { audience: a.audience } : {})
          })
        }
      return {
        type: 'oauth2',
        oauth2: pmParams({
          grant_type: 'client_credentials',
          accessTokenUrl: a.accessTokenUrl,
          clientId: a.clientId,
          clientSecret: a.clientSecret,
          scope: a.scope,
          audience: a.audience,
          client_authentication: a.clientAuthentication
        })
      }
    case 'entra':
      return { type: 'bearer', bearer: pmParams({ token: `{{courier_entra:${a.scope}}}` }) }
    case 'digest':
      return { type: 'digest', digest: pmParams({ username: a.username, password: a.password, algorithm: 'MD5' }) }
    case 'ntlm':
      return { type: 'ntlm', ntlm: pmParams({ username: a.username, password: a.password, domain: a.domain, workstation: a.workstation }) }
    case 'awsv4':
      return {
        type: 'awsv4',
        awsv4: pmTyped({ accessKey: a.accessKey, secretKey: a.secretKey, sessionToken: a.sessionToken, region: a.region, service: a.service, addAuthDataToQuery: a.addTo === 'query' })
      }
    case 'jwt':
      return {
        type: 'jwt',
        jwt: pmTyped({
          algorithm: a.algorithm,
          ...(a.algorithm.startsWith('HS') ? { secret: a.secret, isSecretBase64Encoded: a.secretBase64 } : { privateKey: a.secret }),
          payload: a.payload,
          addTokenTo: a.addTo === 'query' ? 'queryParam' : 'header',
          headerPrefix: a.headerPrefix,
          queryParamKey: a.queryParamKey,
          header: a.header
        })
      }
  }
}

function exportKv(kv: KeyValue, extra: Obj = {}): Obj {
  const o: Obj = { key: kv.key, value: kv.value, ...extra }
  if (!kv.enabled) o.disabled = true
  if (kv.description) o.description = kv.description
  return o
}

function exportUrl(r: RequestDef): Obj {
  const raw = buildUrl(r.url, r.params.filter((p) => p.enabled))
  const out: Obj = { raw }
  const noQuery = r.url.split('?')[0]
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(.*)$/i.exec(noQuery)
  const hostPart = m ? m[2] : noQuery.split('/')[0]
  const pathPart = m ? m[3] : noQuery.slice(hostPart.length)
  if (m) out.protocol = m[1]
  out.host = hostPart.startsWith('{{') ? [hostPart] : hostPart.split('.')
  const path = pathPart.split('/').filter((x) => x !== '')
  if (path.length) out.path = path
  if (r.params.length) out.query = r.params.map((p) => exportKv(p))
  if (r.pathVariables.length) out.variable = r.pathVariables.map((p) => exportKv(p))
  return out
}

function exportBody(b: RequestBody): Obj | undefined {
  switch (b.mode) {
    case 'none':
      return undefined
    case 'raw':
      return { mode: 'raw', raw: b.raw, options: { raw: { language: b.language } } }
    case 'urlencoded':
      return { mode: 'urlencoded', urlencoded: b.urlencoded.map((kv) => exportKv(kv, { type: 'text' })) }
    case 'formdata':
      return {
        mode: 'formdata',
        formdata: b.formdata.map((f) => {
          const o: Obj =
            f.kind === 'file' ? { key: f.key, type: 'file', src: f.filePath ?? '' } : { key: f.key, value: f.value, type: 'text' }
          if (f.contentType) o.contentType = f.contentType
          if (!f.enabled) o.disabled = true
          if (f.description) o.description = f.description
          return o
        })
      }
    case 'graphql':
      return { mode: 'graphql', graphql: { query: b.graphql.query, variables: b.graphql.variables } }
    case 'binary':
      return { mode: 'file', file: { src: b.filePath } }
  }
}

function exportVariable(v: Variable): Obj {
  if (v.type === 'vault') {
    return { key: v.key, value: toVaultTemplate(v.value), type: 'default', ...(v.enabled ? {} : { disabled: true }) }
  }
  const o: Obj = { key: v.key, value: v.type === 'secret' ? '' : v.value, type: v.type === 'secret' ? 'secret' : 'default' }
  if (!v.enabled) o.disabled = true
  if (v.description) o.description = v.description
  return o
}

/** Postman v2.1 has no WebSocket / gRPC request: those items are left out (see `collectionNonHttp`). */
const exportable = (item: Item): item is Folder | RequestDef => item.type === 'folder' || item.type === 'request'

function exportItem(item: Folder | RequestDef): Obj {
  if (item.type === 'folder') return exportFolder(item)
  const request: Obj = { method: item.method, header: item.headers.map((h) => exportKv(h, { type: 'text' })) }
  const body = exportBody(item.body)
  if (body) request.body = body
  request.url = exportUrl(item)
  const auth = exportAuth(item.auth)
  if (auth) request.auth = auth
  if (item.description) request.description = item.description
  const o: Obj = { name: item.name, request, response: [] }
  const ev = exportScriptEvents(item.preRequestScript, item.testScript)
  if (ev) o.event = ev
  return o
}

function exportFolder(f: Folder): Obj {
  const o: Obj = { name: f.name, item: f.items.filter(exportable).map(exportItem) }
  if (f.description) o.description = f.description
  const auth = exportAuth(f.auth)
  if (auth) o.auth = auth
  const ev = exportScriptEvents(f.preRequestScript, f.testScript)
  if (ev) o.event = ev
  return o
}

export function exportPostmanCollection(c: Collection): Obj {
  const o: Obj = {
    info: { _postman_id: c.id, name: c.name, description: c.description, schema: POSTMAN_SCHEMA_V21 },
    item: c.items.filter(exportable).map(exportItem)
  }
  const auth = exportAuth(c.auth)
  if (auth && c.auth.type !== 'none') o.auth = auth
  const ev = exportScriptEvents(c.preRequestScript, c.testScript)
  if (ev) o.event = ev
  if (c.variables.length) o.variable = c.variables.map(exportVariable)
  return o
}

export function exportPostmanEnvironment(e: Environment): Obj {
  return {
    id: e.id,
    name: e.name,
    values: e.variables.map((v) => {
      const x = exportVariable(v)
      return { key: x.key, value: x.value, type: x.type, enabled: v.enabled }
    }),
    _postman_variable_scope: 'environment'
  }
}
