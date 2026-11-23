/**
 * Basic OpenAPI 3.x (JSON or YAML) → Collection import (pure).
 * - `servers[0]` → collection variable `baseUrl` (server variables filled with defaults)
 * - operations grouped into folders by first tag; `{param}` → `:param` path variables
 * - query/header parameters, JSON / urlencoded / multipart request bodies (example or schema-derived sample)
 * - global security scheme → collection auth with `{{placeholders}}`; operation `security: []` → no auth
 */
import { parse as parseYaml } from 'yaml'
import type { Auth, Collection, FormDataField, Folder, KeyValue, RequestBody, RequestDef, Variable } from './types'
import { newCollection, newFolder, newId, newRequest } from './types'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const s = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '')
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']

export function parseOpenApiText(text: string): Obj | null {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    try {
      doc = parseYaml(text)
    } catch {
      return null
    }
  }
  return isOpenApi(doc) ? (doc as Obj) : null
}

export function isOpenApi(doc: unknown): boolean {
  return isObj(doc) && typeof doc.openapi === 'string' && doc.openapi.startsWith('3') && isObj(doc.paths)
}

function makeResolver(root: Obj): (v: unknown) => unknown {
  const resolve = (v: unknown, depth = 0): unknown => {
    if (!isObj(v) || typeof v.$ref !== 'string' || depth > 20) return v
    const ref = v.$ref
    if (!ref.startsWith('#/')) return {}
    let cur: unknown = root
    for (const part of ref.slice(2).split('/')) {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
      cur = isObj(cur) ? cur[key] : undefined
    }
    return resolve(cur, depth + 1)
  }
  return (v) => resolve(v)
}

function sampleFromSchema(schema: unknown, resolve: (v: unknown) => unknown, depth = 0): unknown {
  const sc = resolve(schema)
  if (!isObj(sc) || depth > 6) return null
  if (sc.example !== undefined) return sc.example
  if (sc.default !== undefined) return sc.default
  if (Array.isArray(sc.enum) && sc.enum.length) return sc.enum[0]
  for (const k of ['allOf', 'oneOf', 'anyOf']) {
    const list = sc[k]
    if (Array.isArray(list) && list.length) {
      if (k === 'allOf') {
        const merged: Obj = {}
        for (const part of list) {
          const v = sampleFromSchema(part, resolve, depth + 1)
          if (isObj(v)) Object.assign(merged, v)
        }
        return merged
      }
      return sampleFromSchema(list[0], resolve, depth + 1)
    }
  }
  const type = Array.isArray(sc.type) ? s(sc.type[0]) : s(sc.type)
  if (type === 'object' || isObj(sc.properties)) {
    const out: Obj = {}
    for (const [k, v] of Object.entries(isObj(sc.properties) ? sc.properties : {})) out[k] = sampleFromSchema(v, resolve, depth + 1)
    return out
  }
  if (type === 'array') return [sampleFromSchema(sc.items, resolve, depth + 1)]
  if (type === 'integer' || type === 'number') return 0
  if (type === 'boolean') return true
  if (type === 'string') {
    if (sc.format === 'date-time') return '2024-01-01T00:00:00Z'
    if (sc.format === 'date') return '2024-01-01'
    if (sc.format === 'uuid') return '00000000-0000-0000-0000-000000000000'
    if (sc.format === 'email') return 'user@example.com'
    return 'string'
  }
  return null
}

function schemeToAuth(scheme: unknown, name: string): { auth: Auth; vars: Variable[] } | null {
  if (!isObj(scheme)) return null
  const v = (key: string, type: Variable['type'] = 'default'): Variable => ({ key, value: '', enabled: true, type })
  if (scheme.type === 'http' && s(scheme.scheme).toLowerCase() === 'bearer')
    return { auth: { type: 'bearer', token: '{{bearerToken}}' }, vars: [v('bearerToken', 'secret')] }
  if (scheme.type === 'http' && s(scheme.scheme).toLowerCase() === 'basic')
    return { auth: { type: 'basic', username: '{{username}}', password: '{{password}}' }, vars: [v('username'), v('password', 'secret')] }
  if (scheme.type === 'apiKey' && (scheme.in === 'header' || scheme.in === 'query'))
    return { auth: { type: 'apikey', key: s(scheme.name) || name, value: '{{apiKey}}', in: scheme.in }, vars: [v('apiKey', 'secret')] }
  if (scheme.type === 'oauth2' && isObj(scheme.flows) && isObj(scheme.flows.clientCredentials)) {
    const cc = scheme.flows.clientCredentials
    return {
      auth: {
        type: 'oauth2',
        grantType: 'client_credentials',
        accessTokenUrl: s(cc.tokenUrl),
        clientId: '{{clientId}}',
        clientSecret: '{{clientSecret}}',
        scope: isObj(cc.scopes) ? Object.keys(cc.scopes).join(' ') : '',
        audience: '',
        clientAuthentication: 'header'
      },
      vars: [v('clientId'), v('clientSecret', 'secret')]
    }
  }
  return null
}

export function importOpenApi(text: string): { value: Collection; warnings: string[] } {
  const doc = parseOpenApiText(text)
  if (!doc) throw new Error('Not an OpenAPI 3 document (expected "openapi: 3.x" and "paths").')
  const warnings: string[] = []
  const resolve = makeResolver(doc)
  const info = isObj(doc.info) ? doc.info : {}
  const variables: Variable[] = []

  const servers = Array.isArray(doc.servers) ? doc.servers : []
  let baseUrl = ''
  if (servers.length && isObj(servers[0])) {
    baseUrl = s(servers[0].url)
    const sv = isObj(servers[0].variables) ? servers[0].variables : {}
    for (const [k, v] of Object.entries(sv)) baseUrl = baseUrl.split(`{${k}}`).join(isObj(v) ? s(v.default) : '')
  }
  variables.push({ key: 'baseUrl', value: baseUrl.replace(/\/$/, ''), enabled: true, type: 'default' })

  let collectionAuth: Auth = { type: 'none' }
  const schemes = isObj(doc.components) && isObj(doc.components.securitySchemes) ? doc.components.securitySchemes : {}
  const globalSec = Array.isArray(doc.security) ? doc.security : []
  if (globalSec.length && isObj(globalSec[0])) {
    const name = Object.keys(globalSec[0])[0]
    const mapped = name ? schemeToAuth(resolve(schemes[name]), name) : null
    if (mapped) {
      collectionAuth = mapped.auth
      variables.push(...mapped.vars)
    } else if (name) warnings.push(`Security scheme "${name}" is not supported; collection auth left as none.`)
  }

  const folders = new Map<string, Folder>()
  const rootItems: (Folder | RequestDef)[] = []

  for (const [path, rawPathItem] of Object.entries(doc.paths as Obj)) {
    const pathItem = resolve(rawPathItem)
    if (!isObj(pathItem)) continue
    const commonParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : []
    for (const method of METHODS) {
      const op = pathItem[method]
      if (!isObj(op)) continue
      const params: KeyValue[] = []
      const headers: KeyValue[] = []
      const pathVariables: KeyValue[] = []
      const allParams = [...commonParams, ...(Array.isArray(op.parameters) ? op.parameters : [])].map(resolve).filter(isObj)
      for (const p of allParams) {
        const example = p.example !== undefined ? s(p.example) : s(sampleFromSchema(p.schema, resolve) ?? '')
        const kv: KeyValue = { key: s(p.name), value: example, enabled: p.required === true || p.in === 'path' }
        if (p.description) kv.description = s(p.description)
        if (p.in === 'query') params.push(kv)
        else if (p.in === 'header') headers.push(kv)
        else if (p.in === 'path') pathVariables.push(kv)
      }
      let body: RequestBody = { mode: 'none' }
      const rb = resolve(op.requestBody)
      if (isObj(rb) && isObj(rb.content)) {
        const content = rb.content
        const pickExample = (media: Obj): unknown => {
          if (media.example !== undefined) return media.example
          if (isObj(media.examples)) {
            const first = resolve(Object.values(media.examples)[0])
            if (isObj(first) && first.value !== undefined) return first.value
          }
          return sampleFromSchema(media.schema, resolve)
        }
        const jsonType = Object.keys(content).find((k) => k.includes('json'))
        if (jsonType && isObj(content[jsonType])) {
          body = { mode: 'raw', language: 'json', raw: JSON.stringify(pickExample(content[jsonType] as Obj), null, 2) }
          headers.push({ key: 'Content-Type', value: jsonType, enabled: true })
        } else if (isObj(content['application/x-www-form-urlencoded'])) {
          const sample = pickExample(content['application/x-www-form-urlencoded'] as Obj)
          body = { mode: 'urlencoded', urlencoded: Object.entries(isObj(sample) ? sample : {}).map(([key, v]) => ({ key, value: s(v), enabled: true })) }
        } else if (isObj(content['multipart/form-data'])) {
          const media = content['multipart/form-data'] as Obj
          const schema = resolve(media.schema)
          const props = isObj(schema) && isObj(schema.properties) ? schema.properties : {}
          body = {
            mode: 'formdata',
            formdata: Object.entries(props).map(([key, p]): FormDataField => {
              const ps = resolve(p)
              const isFile = isObj(ps) && (ps.format === 'binary' || ps.format === 'base64')
              return isFile ? { key, value: '', enabled: true, kind: 'file' } : { key, value: s(sampleFromSchema(ps, resolve) ?? ''), enabled: true, kind: 'text' }
            })
          }
        } else {
          const xmlType = Object.keys(content).find((k) => k.includes('xml'))
          const textType = xmlType ?? Object.keys(content).find((k) => k.startsWith('text/'))
          if (textType) {
            body = { mode: 'raw', language: xmlType ? 'xml' : 'text', raw: '' }
            headers.push({ key: 'Content-Type', value: textType, enabled: true })
          }
        }
      }
      let auth: Auth = { type: 'inherit' }
      if (Array.isArray(op.security)) {
        if (op.security.length === 0) auth = { type: 'none' }
        else if (isObj(op.security[0])) {
          const name = Object.keys(op.security[0])[0]
          const mapped = name ? schemeToAuth(resolve(schemes[name]), name) : null
          if (mapped && JSON.stringify(mapped.auth) !== JSON.stringify(collectionAuth)) {
            auth = mapped.auth
            for (const v of mapped.vars) if (!variables.some((x) => x.key === v.key)) variables.push(v)
          }
        }
      }
      const req = newRequest({
        id: newId(),
        name: s(op.summary) || s(op.operationId) || `${method.toUpperCase()} ${path}`,
        description: s(op.description),
        method: method.toUpperCase(),
        url: '{{baseUrl}}' + path.replace(/\{([^}]+)\}/g, ':$1'),
        params,
        headers,
        pathVariables,
        body,
        auth
      })
      const tag = Array.isArray(op.tags) && op.tags.length ? s(op.tags[0]) : ''
      if (tag) {
        let folder = folders.get(tag)
        if (!folder) {
          folder = newFolder({ id: newId(), name: tag })
          folders.set(tag, folder)
          rootItems.push(folder)
        }
        folder.items.push(req)
      } else rootItems.push(req)
    }
  }

  const tagDescriptions = Array.isArray(doc.tags) ? doc.tags.filter(isObj) : []
  for (const t of tagDescriptions) {
    const f = folders.get(s(t.name))
    if (f && t.description) f.description = s(t.description)
  }

  return {
    value: newCollection({
      id: newId(),
      name: s(info.title) || 'OpenAPI import',
      description: s(info.description),
      auth: collectionAuth,
      variables,
      items: rootItems
    }),
    warnings
  }
}
