/**
 * Canonical (deterministic) document format + defensive normalisation of untrusted input (pure).
 *
 * `normalize*` turns anything (IPC payloads, downloaded blobs, imported files) into a well-formed
 * object with every field present; `serialize*` emits JSON with a fixed key order, 2-space indent and
 * a trailing newline, so the same document always produces byte-identical output.
 */
import type {
  Auth,
  Collection,
  Environment,
  FormDataField,
  Folder,
  Item,
  KeyValue,
  RawLanguage,
  RequestBody,
  RequestDef,
  RequestSettings,
  Variable,
  VariableType
} from './types'
import { newId } from './types'

export const COLLECTION_SCHEMA = 'courier.collection/v1'
export const ENVIRONMENT_SCHEMA = 'courier.environment/v1'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : d)
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
export function isValidId(v: unknown): v is string {
  return typeof v === 'string' && ID_PATTERN.test(v)
}
function id(v: unknown): string {
  return isValidId(v) ? v : newId()
}

// ---------------------------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------------------------

export function normalizeKeyValue(v: unknown): KeyValue {
  const o = isObj(v) ? v : {}
  const kv: KeyValue = { key: str(o.key), value: str(o.value), enabled: bool(o.enabled, true) }
  if (typeof o.description === 'string' && o.description) kv.description = o.description
  return kv
}

function normalizeFormField(v: unknown): FormDataField {
  const o = isObj(v) ? v : {}
  const f: FormDataField = { ...normalizeKeyValue(o), kind: o.kind === 'file' ? 'file' : 'text' }
  if (typeof o.filePath === 'string' && o.filePath) f.filePath = o.filePath
  if (typeof o.contentType === 'string' && o.contentType) f.contentType = o.contentType
  return f
}

const VAR_TYPES: VariableType[] = ['default', 'secret', 'vault']
export function normalizeVariable(v: unknown): Variable {
  const o = isObj(v) ? v : {}
  const t = VAR_TYPES.includes(o.type as VariableType) ? (o.type as VariableType) : 'default'
  const out: Variable = { key: str(o.key), value: str(o.value), enabled: bool(o.enabled, true), type: t }
  if (typeof o.description === 'string' && o.description) out.description = o.description
  return out
}

const LANGS: RawLanguage[] = ['json', 'text', 'xml', 'html', 'javascript']
export function normalizeBody(v: unknown): RequestBody {
  const o = isObj(v) ? v : {}
  switch (o.mode) {
    case 'raw':
      return { mode: 'raw', raw: str(o.raw), language: LANGS.includes(o.language as RawLanguage) ? (o.language as RawLanguage) : 'text' }
    case 'urlencoded':
      return { mode: 'urlencoded', urlencoded: arr(o.urlencoded).map(normalizeKeyValue) }
    case 'formdata':
      return { mode: 'formdata', formdata: arr(o.formdata).map(normalizeFormField) }
    case 'graphql': {
      const g = isObj(o.graphql) ? o.graphql : {}
      return { mode: 'graphql', graphql: { query: str(g.query), variables: str(g.variables) } }
    }
    case 'binary':
      return { mode: 'binary', filePath: str(o.filePath) }
    default:
      return { mode: 'none' }
  }
}

export function normalizeAuth(v: unknown, fallback: Auth = { type: 'inherit' }): Auth {
  const o = isObj(v) ? v : {}
  switch (o.type) {
    case 'inherit':
      return { type: 'inherit' }
    case 'none':
      return { type: 'none' }
    case 'basic':
      return { type: 'basic', username: str(o.username), password: str(o.password) }
    case 'bearer':
      return { type: 'bearer', token: str(o.token) }
    case 'apikey':
      return { type: 'apikey', key: str(o.key), value: str(o.value), in: o.in === 'query' ? 'query' : 'header' }
    case 'oauth2':
      return {
        type: 'oauth2',
        grantType: 'client_credentials',
        accessTokenUrl: str(o.accessTokenUrl),
        clientId: str(o.clientId),
        clientSecret: str(o.clientSecret),
        scope: str(o.scope),
        audience: str(o.audience),
        clientAuthentication: o.clientAuthentication === 'body' ? 'body' : 'header'
      }
    case 'entra':
      return { type: 'entra', scope: str(o.scope) }
    default:
      return fallback
  }
}

function normalizeSettings(v: unknown): RequestSettings {
  const o = isObj(v) ? v : {}
  const s: RequestSettings = {}
  if (typeof o.followRedirects === 'boolean') s.followRedirects = o.followRedirects
  if (typeof o.maxRedirects === 'number' && o.maxRedirects >= 0) s.maxRedirects = Math.min(Math.floor(o.maxRedirects), 50)
  if (typeof o.verifyTls === 'boolean') s.verifyTls = o.verifyTls
  if (typeof o.timeoutMs === 'number' && o.timeoutMs > 0) s.timeoutMs = Math.floor(o.timeoutMs)
  return s
}

export function normalizeRequest(v: unknown): RequestDef {
  const o = isObj(v) ? v : {}
  return {
    type: 'request',
    id: id(o.id),
    name: str(o.name, 'Untitled request') || 'Untitled request',
    description: str(o.description),
    method: (str(o.method, 'GET').trim().toUpperCase() || 'GET').replace(/[^A-Z0-9_-]/g, ''),
    url: str(o.url),
    params: arr(o.params).map(normalizeKeyValue),
    pathVariables: arr(o.pathVariables).map(normalizeKeyValue),
    headers: arr(o.headers).map(normalizeKeyValue),
    body: normalizeBody(o.body),
    auth: normalizeAuth(o.auth),
    preRequestScript: str(o.preRequestScript),
    testScript: str(o.testScript),
    settings: normalizeSettings(o.settings)
  }
}

export function normalizeFolder(v: unknown, depth = 0): Folder {
  const o = isObj(v) ? v : {}
  return {
    type: 'folder',
    id: id(o.id),
    name: str(o.name, 'Untitled folder') || 'Untitled folder',
    description: str(o.description),
    auth: normalizeAuth(o.auth),
    preRequestScript: str(o.preRequestScript),
    testScript: str(o.testScript),
    items: normalizeItems(o.items, depth + 1)
  }
}

export function normalizeItem(v: unknown, depth = 0): Item {
  return isObj(v) && v.type === 'folder' ? normalizeFolder(v, depth) : normalizeRequest(v)
}

function normalizeItems(v: unknown, depth: number): Item[] {
  if (depth > 32) return []
  const seen = new Set<string>()
  const out: Item[] = []
  for (const raw of arr(v)) {
    const item = normalizeItem(raw, depth)
    if (seen.has(item.id)) item.id = newId()
    seen.add(item.id)
    out.push(item)
  }
  return out
}

/** Also re-ids duplicate ids anywhere in the tree (copy/paste in a hand-edited doc). */
export function normalizeCollection(v: unknown): Collection {
  const o = isObj(v) ? v : {}
  const c: Collection = {
    id: id(o.id),
    name: str(o.name, 'Untitled collection') || 'Untitled collection',
    description: str(o.description),
    auth: normalizeAuth(o.auth, { type: 'none' }),
    variables: arr(o.variables).map(normalizeVariable),
    preRequestScript: str(o.preRequestScript),
    testScript: str(o.testScript),
    items: normalizeItems(o.items, 0)
  }
  if (c.auth.type === 'inherit') c.auth = { type: 'none' }
  if (typeof o.updatedBy === 'string') c.updatedBy = o.updatedBy
  if (typeof o.updatedAt === 'string') c.updatedAt = o.updatedAt
  const all = new Set<string>()
  const dedupe = (items: Item[]): void => {
    for (const it of items) {
      if (all.has(it.id)) it.id = newId()
      all.add(it.id)
      if (it.type === 'folder') dedupe(it.items)
    }
  }
  dedupe(c.items)
  return c
}

export function normalizeEnvironment(v: unknown): Environment {
  const o = isObj(v) ? v : {}
  const e: Environment = {
    id: id(o.id),
    name: str(o.name, 'Untitled environment') || 'Untitled environment',
    variables: arr(o.variables).map(normalizeVariable)
  }
  if (typeof o.updatedBy === 'string') e.updatedBy = o.updatedBy
  if (typeof o.updatedAt === 'string') e.updatedAt = o.updatedAt
  return e
}

// ---------------------------------------------------------------------------------------------
// canonical key order
// ---------------------------------------------------------------------------------------------

function kvOut(kv: KeyValue): Obj {
  const o: Obj = { key: kv.key, value: kv.value, enabled: kv.enabled }
  if (kv.description) o.description = kv.description
  return o
}

function varOut(v: Variable): Obj {
  const o: Obj = { key: v.key, value: v.type === 'secret' ? '' : v.value, enabled: v.enabled, type: v.type }
  if (v.description) o.description = v.description
  return o
}

function authOut(a: Auth): Obj {
  switch (a.type) {
    case 'inherit':
    case 'none':
      return { type: a.type }
    case 'basic':
      return { type: a.type, username: a.username, password: a.password }
    case 'bearer':
      return { type: a.type, token: a.token }
    case 'apikey':
      return { type: a.type, key: a.key, value: a.value, in: a.in }
    case 'oauth2':
      return {
        type: a.type,
        grantType: a.grantType,
        accessTokenUrl: a.accessTokenUrl,
        clientId: a.clientId,
        clientSecret: a.clientSecret,
        scope: a.scope,
        audience: a.audience,
        clientAuthentication: a.clientAuthentication
      }
    case 'entra':
      return { type: a.type, scope: a.scope }
  }
}

function bodyOut(b: RequestBody): Obj {
  switch (b.mode) {
    case 'none':
      return { mode: 'none' }
    case 'raw':
      return { mode: 'raw', language: b.language, raw: b.raw }
    case 'urlencoded':
      return { mode: 'urlencoded', urlencoded: b.urlencoded.map(kvOut) }
    case 'formdata':
      return {
        mode: 'formdata',
        formdata: b.formdata.map((f) => {
          const o: Obj = { key: f.key, kind: f.kind, value: f.value, enabled: f.enabled }
          if (f.filePath) o.filePath = f.filePath
          if (f.contentType) o.contentType = f.contentType
          if (f.description) o.description = f.description
          return o
        })
      }
    case 'graphql':
      return { mode: 'graphql', graphql: { query: b.graphql.query, variables: b.graphql.variables } }
    case 'binary':
      return { mode: 'binary', filePath: b.filePath }
  }
}

function settingsOut(s: RequestSettings): Obj {
  const o: Obj = {}
  if (s.followRedirects !== undefined) o.followRedirects = s.followRedirects
  if (s.maxRedirects !== undefined) o.maxRedirects = s.maxRedirects
  if (s.verifyTls !== undefined) o.verifyTls = s.verifyTls
  if (s.timeoutMs !== undefined) o.timeoutMs = s.timeoutMs
  return o
}

function itemOut(item: Item): Obj {
  if (item.type === 'folder') {
    return {
      type: 'folder',
      id: item.id,
      name: item.name,
      description: item.description,
      auth: authOut(item.auth),
      preRequestScript: item.preRequestScript,
      testScript: item.testScript,
      items: item.items.map(itemOut)
    }
  }
  return {
    type: 'request',
    id: item.id,
    name: item.name,
    description: item.description,
    method: item.method,
    url: item.url,
    params: item.params.map(kvOut),
    pathVariables: item.pathVariables.map(kvOut),
    headers: item.headers.map(kvOut),
    body: bodyOut(item.body),
    auth: authOut(item.auth),
    preRequestScript: item.preRequestScript,
    testScript: item.testScript,
    settings: settingsOut(item.settings)
  }
}

export function collectionToCanonical(c: Collection): Obj {
  const o: Obj = {
    schema: COLLECTION_SCHEMA,
    id: c.id,
    name: c.name,
    description: c.description,
    auth: authOut(c.auth),
    variables: c.variables.map(varOut),
    preRequestScript: c.preRequestScript,
    testScript: c.testScript,
    items: c.items.map(itemOut)
  }
  if (c.updatedBy !== undefined) o.updatedBy = c.updatedBy
  if (c.updatedAt !== undefined) o.updatedAt = c.updatedAt
  return o
}

export function environmentToCanonical(e: Environment): Obj {
  const o: Obj = { schema: ENVIRONMENT_SCHEMA, id: e.id, name: e.name, variables: e.variables.map(varOut) }
  if (e.updatedBy !== undefined) o.updatedBy = e.updatedBy
  if (e.updatedAt !== undefined) o.updatedAt = e.updatedAt
  return o
}

/** Deterministic JSON: fixed key order, 2-space indent, trailing newline. Secret variable values are blanked. */
export function serializeCollection(c: Collection): string {
  return JSON.stringify(collectionToCanonical(normalizeCollection(c)), null, 2) + '\n'
}

export function serializeEnvironment(e: Environment): string {
  return JSON.stringify(environmentToCanonical(normalizeEnvironment(e)), null, 2) + '\n'
}

/** Content equality ignoring the `updatedBy/updatedAt` stamp. */
export function sameContent(a: Collection | Environment, b: Collection | Environment, kind: 'collection' | 'environment'): boolean {
  const strip = <T extends { updatedBy?: string; updatedAt?: string }>(x: T): T => ({ ...x, updatedBy: undefined, updatedAt: undefined })
  return kind === 'collection'
    ? serializeCollection(strip(a as Collection)) === serializeCollection(strip(b as Collection))
    : serializeEnvironment(strip(a as Environment)) === serializeEnvironment(strip(b as Environment))
}

/** Deep copy with fresh ids for every item. */
export function reidItems(items: Item[]): Item[] {
  return items.map((it) =>
    it.type === 'folder' ? { ...structuredClone(it), id: newId(), items: reidItems(it.items) } : { ...structuredClone(it), id: newId() }
  )
}
