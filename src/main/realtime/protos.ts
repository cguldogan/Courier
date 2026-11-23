/**
 * gRPC service definitions (protobufjs, main process only).
 *
 * Storage form: a request's `GrpcDescriptor.json` is protobufjs JSON (`Root.toJSON()` shape). It comes
 * from `.proto` files (parsed here, imports resolved only inside the directories the user picked) or
 * from server reflection (FileDescriptorProtos converted by `fileDescriptorsToJson`, which handles map
 * entries and proto3 `optional` itself because protobufjs's own descriptor conversion does not).
 *
 * Every definition is untrusted (a teammate's collection, a server's reflection answer): before
 * protobufjs sees it, `normalizeProtoJson` rebuilds it from a whitelist — identifiers only, no
 * `__proto__`/`constructor`/`prototype`, no options except a few booleans, no defaults, no extensions,
 * size and count caps. protobufjs generates encoder code from type definitions; only rebuilt,
 * identifier-checked definitions ever reach it.
 *
 * JSON dialect (input validation, responses and the example generator agree): the proto3 JSON
 * mapping — lowerCamelCase field names on output (proto names accepted on input), 64-bit integers
 * as strings, bytes as base64, enums by name, Timestamp as RFC 3339 text, Duration as "1.5s",
 * wrappers as plain values, Struct/Value/ListValue as plain JSON, FieldMask as "a.b,c", Any as
 * {"@type": "type.googleapis.com/pkg.Msg", ...fields}.
 */
import { createHash } from 'node:crypto'
import { realpath, stat, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import protobuf from 'protobufjs'
import descriptorJson from 'protobufjs/google/protobuf/descriptor.json'
import { GRPC_DESCRIPTOR_MAX_CHARS } from '../../shared/realtime'
import type { GrpcCallType, GrpcDescriptor, GrpcServiceInfo } from '../../shared/types'
import { Fault, messageOf } from '../errors'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

// ---------------------------------------------------------------------------------------------
// Whitelist normaliser
// ---------------------------------------------------------------------------------------------

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const TYPE_REF = /^\.?[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])
export const SCALARS = ['double', 'float', 'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool', 'string', 'bytes'] as const
const KEY_TYPES = new Set(SCALARS.filter((s) => s !== 'double' && s !== 'float' && s !== 'bytes'))
const EDITIONS = new Set(['proto2', 'proto3', '2023', '2024'])
const MAX_NODES = 50_000
const MAX_DEPTH = 40
const MAX_FIELD_ID = 536_870_911

class Budget {
  nodes = 0
  tick(): void {
    if (++this.nodes > MAX_NODES) throw new Fault('INVALID_ARGUMENT', `The service definition is too large (more than ${MAX_NODES} definitions).`)
  }
}

function ident(name: string, what: string): string {
  if (!IDENT.test(name) || FORBIDDEN.has(name)) throw new Fault('INVALID_ARGUMENT', `The service definition has an invalid ${what} name "${name.slice(0, 80)}".`)
  return name
}

function typeRef(v: unknown, what: string): string {
  if (typeof v !== 'string' || !TYPE_REF.test(v) || v.split('.').some((p) => FORBIDDEN.has(p))) throw new Fault('INVALID_ARGUMENT', `The service definition has an invalid type reference for ${what}.`)
  return v
}

function normField(name: string, raw: unknown, where: string): Obj {
  const f = isObj(raw) ? raw : {}
  const out: Obj = {}
  const type = typeof f.type === 'string' ? f.type : ''
  out.type = (SCALARS as readonly string[]).includes(type) ? type : typeRef(type, `field ${where}.${name}`)
  if (typeof f.id !== 'number' || !Number.isInteger(f.id) || f.id < 1 || f.id > MAX_FIELD_ID) throw new Fault('INVALID_ARGUMENT', `Field ${where}.${name} has an invalid number.`)
  out.id = f.id
  if (f.keyType !== undefined) {
    if (typeof f.keyType !== 'string' || !KEY_TYPES.has(f.keyType as never)) throw new Fault('INVALID_ARGUMENT', `Map field ${where}.${name} has an invalid key type.`)
    out.keyType = f.keyType
  } else if (f.rule === 'repeated' || f.rule === 'required' || f.rule === 'optional') out.rule = f.rule
  const o = isObj(f.options) ? f.options : {}
  const opts: Obj = {}
  if (typeof o.packed === 'boolean') opts.packed = o.packed
  if (o.proto3_optional === true) opts.proto3_optional = true
  if (typeof o.json_name === 'string' && IDENT.test(o.json_name) && !FORBIDDEN.has(o.json_name)) opts.json_name = o.json_name
  if (Object.keys(opts).length) out.options = opts
  return out
}

function normEnum(raw: Obj, where: string, b: Budget): Obj {
  const values: Obj = {}
  for (const [k, v] of Object.entries(isObj(raw.values) ? raw.values : {})) {
    b.tick()
    ident(k, `enum value (${where})`)
    if (typeof v !== 'number' || !Number.isInteger(v) || v < -2147483648 || v > 2147483647) throw new Fault('INVALID_ARGUMENT', `Enum value ${where}.${k} is not a 32-bit integer.`)
    values[k] = v
  }
  if (!Object.keys(values).length) throw new Fault('INVALID_ARGUMENT', `Enum ${where} has no values.`)
  const out: Obj = { values }
  if (typeof raw.edition === 'string' && EDITIONS.has(raw.edition)) out.edition = raw.edition
  const o = isObj(raw.options) ? raw.options : {}
  if (o.allow_alias === true) out.options = { allow_alias: true }
  return out
}

function normType(raw: Obj, where: string, b: Budget, depth: number): Obj {
  const fields: Obj = {}
  for (const [k, v] of Object.entries(isObj(raw.fields) ? raw.fields : {})) {
    b.tick()
    fields[ident(k, `field (${where})`)] = normField(k, v, where)
  }
  const out: Obj = { fields }
  if (isObj(raw.oneofs)) {
    const oneofs: Obj = {}
    for (const [k, v] of Object.entries(raw.oneofs)) {
      b.tick()
      ident(k, `oneof (${where})`)
      const members = isObj(v) && Array.isArray(v.oneof) ? v.oneof.filter((m): m is string => typeof m === 'string' && own(fields, m)) : []
      if (members.length) oneofs[k] = { oneof: members }
    }
    if (Object.keys(oneofs).length) out.oneofs = oneofs
  }
  if (typeof raw.edition === 'string' && EDITIONS.has(raw.edition)) out.edition = raw.edition
  const nested = normNested(raw.nested, where, b, depth + 1)
  if (nested) out.nested = nested
  return out
}

function normService(raw: Obj, where: string, b: Budget): Obj {
  const methods: Obj = {}
  for (const [k, v] of Object.entries(isObj(raw.methods) ? raw.methods : {})) {
    b.tick()
    ident(k, `method (${where})`)
    const m = isObj(v) ? v : {}
    methods[k] = {
      requestType: typeRef(m.requestType, `${where}.${k} request`),
      responseType: typeRef(m.responseType, `${where}.${k} response`),
      ...(m.requestStream === true ? { requestStream: true } : {}),
      ...(m.responseStream === true ? { responseStream: true } : {})
    }
  }
  return { methods }
}

function normNested(raw: unknown, where: string, b: Budget, depth: number): Obj | null {
  if (!isObj(raw)) return null
  if (depth > MAX_DEPTH) throw new Fault('INVALID_ARGUMENT', 'The service definition is nested too deeply.')
  const out: Obj = {}
  for (const [k, v] of Object.entries(raw)) {
    b.tick()
    ident(k, 'definition')
    if (!isObj(v)) continue
    const at = where ? `${where}.${k}` : k
    if (isObj(v.fields)) out[k] = normType(v, at, b, depth)
    else if (isObj(v.values)) out[k] = normEnum(v, at, b)
    else if (isObj(v.methods)) out[k] = normService(v, at, b)
    else if (v.extend !== undefined || v.id !== undefined) continue // extension fields (custom options): dropped
    else {
      const n = normNested(v.nested, at, b, depth + 1)
      if (n && Object.keys(n).length) out[k] = { nested: n }
    }
  }
  return out
}

/** Rebuilds a protobufjs JSON definition from the whitelist. Throws INVALID_ARGUMENT. */
export function normalizeProtoJson(raw: unknown): Obj {
  const b = new Budget()
  const nested = normNested(isObj(raw) ? raw.nested : undefined, '', b, 0)
  if (!nested || !Object.keys(nested).length) throw new Fault('INVALID_ARGUMENT', 'The service definition is empty.')
  return { nested }
}

// ---------------------------------------------------------------------------------------------
// Loading (cached per definition text)
// ---------------------------------------------------------------------------------------------

const cache = new Map<string, protobuf.Root>()

/** The protobufjs root for a stored definition (validated, resolved). Throws INVALID_ARGUMENT. */
export function loadDescriptor(d: GrpcDescriptor | null | undefined): protobuf.Root {
  if (!d || typeof d.json !== 'string' || !d.json) throw new Fault('INVALID_ARGUMENT', 'Load the service definition first: use server reflection or import .proto files (Service definition tab).')
  if (d.json.length > GRPC_DESCRIPTOR_MAX_CHARS) throw new Fault('INVALID_ARGUMENT', 'The stored service definition is too large.')
  const key = createHash('sha256').update(d.json).digest('hex')
  const hit = cache.get(key)
  if (hit) return hit
  let parsed: unknown
  try {
    parsed = JSON.parse(d.json)
  } catch {
    throw new Fault('INVALID_ARGUMENT', 'The stored service definition is not valid JSON. Load it again.')
  }
  const root = rootFromJson(normalizeProtoJson(parsed))
  cache.set(key, root)
  if (cache.size > 16) cache.delete(cache.keys().next().value as string)
  return root
}

function rootFromJson(json: Obj): protobuf.Root {
  try {
    const root = protobuf.Root.fromJSON(json as protobuf.INamespace)
    root.resolveAll()
    return root
  } catch (err) {
    throw new Fault('INVALID_ARGUMENT', `The service definition is incomplete: ${messageOf(err)}`)
  }
}

/** Serialised, normalised definition for storage. */
export function descriptorFromRoot(root: protobuf.Root, source: GrpcDescriptor['source'], files: string[]): GrpcDescriptor {
  const json = JSON.stringify(normalizeProtoJson(root.toJSON({ keepComments: false })))
  if (json.length > GRPC_DESCRIPTOR_MAX_CHARS) throw new Fault('INVALID_ARGUMENT', `The service definition is too large to store (${Math.round(json.length / 1024)} KB, max ${GRPC_DESCRIPTOR_MAX_CHARS / 1024 / 1024} MB).`)
  const check = rootFromJson(JSON.parse(json) as Obj)
  if (!listServices(check).length) throw new Fault('INVALID_ARGUMENT', 'No service definitions were found.')
  return { source, files: files.slice(0, 1000), loadedAt: new Date().toISOString(), json }
}

function callType(m: protobuf.Method): GrpcCallType {
  if (m.requestStream && m.responseStream) return 'bidi'
  if (m.requestStream) return 'client-stream'
  if (m.responseStream) return 'server-stream'
  return 'unary'
}

export function listServices(root: protobuf.Root): GrpcServiceInfo[] {
  const out: GrpcServiceInfo[] = []
  const walk = (ns: protobuf.NamespaceBase): void => {
    for (const n of ns.nestedArray) {
      if (n instanceof protobuf.Service) {
        const name = n.fullName.replace(/^\./, '')
        out.push({
          name,
          methods: n.methodsArray.map((m) => ({
            service: name,
            method: m.name,
            path: `/${name}/${m.name}`,
            requestType: (m.resolvedRequestType?.fullName ?? m.requestType).replace(/^\./, ''),
            responseType: (m.resolvedResponseType?.fullName ?? m.responseType).replace(/^\./, ''),
            callType: callType(m)
          }))
        })
      }
      if (n instanceof protobuf.Namespace) walk(n)
    }
  }
  walk(root)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export interface ResolvedMethod {
  path: string
  callType: GrpcCallType
  requestType: protobuf.Type
  responseType: protobuf.Type
}

export function findMethod(root: protobuf.Root, service: string, method: string): ResolvedMethod {
  if (!service || !method) throw new Fault('INVALID_ARGUMENT', 'Pick a service method first.')
  let svc: protobuf.Service
  try {
    svc = root.lookupService(service)
  } catch {
    throw new Fault('NOT_FOUND', `Service "${service}" is not in the loaded service definition. Reload it or pick another method.`)
  }
  const m = svc.methods[method]
  if (!m || !own(svc.methods, method)) throw new Fault('NOT_FOUND', `Method "${method}" is not part of service "${service}".`)
  m.resolve()
  if (!m.resolvedRequestType || !m.resolvedResponseType) throw new Fault('INVALID_ARGUMENT', `The message types of ${service}/${method} are missing from the service definition.`)
  return { path: `/${svc.fullName.replace(/^\./, '')}/${m.name}`, callType: callType(m), requestType: m.resolvedRequestType, responseType: m.resolvedResponseType }
}

// ---------------------------------------------------------------------------------------------
// .proto files
// ---------------------------------------------------------------------------------------------

const MAX_PROTO_FILE = 2 * 1024 * 1024
const MAX_PROTO_TOTAL = 16 * 1024 * 1024
const MAX_PROTO_FILES = 2000

function isInside(root: string, p: string): boolean {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'))
}

/** Bundled definitions for `google/protobuf/*.proto` imports (no filesystem access). */
function bundled(name: string): Obj | null {
  const common = protobuf.common as unknown as Record<string, Obj | undefined>
  if (/^google\/protobuf\/[a-z_]+\.proto$/.test(name) && own(common, name)) return (common[name] as Obj) ?? null
  if (name === 'google/protobuf/descriptor.proto') return descriptorJson as unknown as Obj
  return null
}

/**
 * Parses picked `.proto` files. Imports resolve against the picked import directories, then the
 * directories of the picked files (like `protoc -I`); `google/protobuf/*.proto` are bundled. A file
 * is read only if its real path (symlinks resolved) is inside one of those directories.
 */
export async function parseProtoFiles(input: { files: string[]; importDirs: string[] }): Promise<GrpcDescriptor> {
  if (!input.files.length) throw new Fault('INVALID_ARGUMENT', 'Choose at least one .proto file.')
  const dirs: string[] = []
  for (const d of input.importDirs) dirs.push(await realpath(d))
  const picked: string[] = []
  for (const f of input.files) {
    const real = await realpath(f)
    picked.push(real)
    const dir = dirname(real)
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  const nameFor = (real: string): string => {
    for (const d of dirs) if (isInside(d, real)) return relative(d, real).split(sep).join('/')
    return real.split(sep).pop() as string
  }
  const root = new protobuf.Root()
  const loaded = new Set<string>()
  const bundledDone = new Set<string>()
  const names: string[] = []
  let total = 0
  const queue: { name: string; real: string; from?: string }[] = picked.map((real) => ({ name: nameFor(real), real }))
  while (queue.length) {
    const next = queue.shift() as { name: string; real: string; from?: string }
    if (loaded.has(next.real)) continue
    loaded.add(next.real)
    if (loaded.size > MAX_PROTO_FILES) throw new Fault('INVALID_ARGUMENT', `Too many .proto files (more than ${MAX_PROTO_FILES}).`)
    if (!dirs.some((d) => isInside(d, next.real))) throw new Fault('FORBIDDEN', `"${next.name}" is outside the chosen directories.`)
    const st = await stat(next.real)
    if (!st.isFile()) throw new Fault('INVALID_ARGUMENT', `"${next.name}" is not a file.`)
    if (st.size > MAX_PROTO_FILE) throw new Fault('INVALID_ARGUMENT', `"${next.name}" is too large (max 2 MB per file).`)
    total += st.size
    if (total > MAX_PROTO_TOTAL) throw new Fault('INVALID_ARGUMENT', 'The .proto files are too large together (max 16 MB).')
    const source = await readFile(next.real, 'utf8')
    let parsed: protobuf.IParserResult
    try {
      parsed = protobuf.parse(source, root, { keepCase: true, alternateCommentMode: false })
    } catch (err) {
      throw new Fault('IMPORT_FAILED', `${next.name}: ${messageOf(err)}`)
    }
    names.push(next.name)
    for (const imp of [...(parsed.imports ?? []), ...(parsed.weakImports ?? [])]) {
      const b = bundled(imp)
      if (b) {
        if (!bundledDone.has(imp)) {
          bundledDone.add(imp)
          root.addJSON(((b.nested as Obj | undefined) ?? b) as Record<string, protobuf.AnyNestedObject>)
        }
        continue
      }
      if (isAbsolute(imp) || imp.split('/').includes('..')) throw new Fault('IMPORT_FAILED', `${next.name}: import "${imp}" must be a relative path inside an import directory.`)
      let found: string | null = null
      for (const d of dirs) {
        const candidate = resolve(d, imp)
        try {
          const real = await realpath(candidate)
          if (dirs.some((x) => isInside(x, real))) {
            found = real
            break
          }
        } catch {
          /* not in this directory */
        }
      }
      if (!found) throw new Fault('IMPORT_FAILED', `${next.name}: import "${imp}" was not found in the import directories (${dirs.length}). Add the directory that contains it.`)
      queue.push({ name: imp, real: found, from: next.name })
    }
  }
  try {
    root.resolveAll()
  } catch (err) {
    throw new Fault('IMPORT_FAILED', `The .proto files do not resolve: ${messageOf(err)}`)
  }
  return descriptorFromRoot(root, 'proto', names)
}

// ---------------------------------------------------------------------------------------------
// Reflection answers (FileDescriptorProto) → protobufjs JSON
// ---------------------------------------------------------------------------------------------

const DESCRIPTOR = protobuf.Root.fromJSON(descriptorJson as protobuf.INamespace).lookupType('google.protobuf.FileDescriptorProto')

export interface FileDescriptor {
  name: string
  package: string
  dependency: string[]
  syntax: string
  messageType: DescriptorProtoLike[]
  enumType: EnumProtoLike[]
  service: ServiceProtoLike[]
}
interface FieldProtoLike {
  name: string
  number: number
  label: number
  type: number
  typeName?: string
  jsonName?: string
  oneofIndex?: number
  proto3Optional?: boolean
  options?: { packed?: boolean }
}
interface DescriptorProtoLike {
  name: string
  field: FieldProtoLike[]
  nestedType: DescriptorProtoLike[]
  enumType: EnumProtoLike[]
  oneofDecl: { name: string }[]
  options?: { mapEntry?: boolean }
}
interface EnumProtoLike {
  name: string
  value: { name: string; number: number }[]
  options?: { allowAlias?: boolean }
}
interface ServiceProtoLike {
  name: string
  method: { name: string; inputType: string; outputType: string; clientStreaming?: boolean; serverStreaming?: boolean }[]
}

/** Decodes one serialized FileDescriptorProto (from a reflection answer). */
export function decodeFileDescriptor(bytes: Uint8Array): FileDescriptor {
  try {
    const msg = DESCRIPTOR.decode(bytes)
    return DESCRIPTOR.toObject(msg, { longs: Number, enums: Number, arrays: true, defaults: false }) as unknown as FileDescriptor
  } catch (err) {
    throw new Fault('INVALID_ARGUMENT', `The server sent an unreadable file descriptor: ${messageOf(err)}`)
  }
}

const SCALAR_BY_TYPE: Record<number, string> = {
  1: 'double', 2: 'float', 3: 'int64', 4: 'uint64', 5: 'int32', 6: 'fixed64', 7: 'fixed32', 8: 'bool', 9: 'string',
  12: 'bytes', 13: 'uint32', 15: 'sfixed32', 16: 'sfixed64', 17: 'sint32', 18: 'sint64'
}

function lowerCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
}

function convertEnum(e: EnumProtoLike, edition: string | null): Obj {
  const values: Obj = {}
  for (const v of e.value ?? []) values[v.name] = v.number ?? 0
  return { values, ...(edition ? { edition } : {}), ...(e.options?.allowAlias ? { options: { allow_alias: true } } : {}) }
}

function convertMessage(m: DescriptorProtoLike, fullName: string, edition: string | null): Obj {
  const mapEntries = new Map<string, DescriptorProtoLike>()
  for (const n of m.nestedType ?? []) if (n.options?.mapEntry) mapEntries.set(n.name, n)
  const entryFor = (typeName: string | undefined): DescriptorProtoLike | undefined => {
    if (!typeName) return undefined
    const short = typeName.startsWith('.') ? (typeName.startsWith(`${fullName}.`) ? typeName.slice(fullName.length + 1) : '') : typeName
    return short && !short.includes('.') ? mapEntries.get(short) : undefined
  }
  const fields: Obj = {}
  for (const f of m.field ?? []) {
    const out: Obj = { id: f.number }
    const entry = f.label === 3 && (f.type === 11 || f.type === 10) ? entryFor(f.typeName) : undefined
    if (entry) {
      const key = entry.field.find((x) => x.number === 1)
      const val = entry.field.find((x) => x.number === 2)
      if (!key || !val) throw new Fault('INVALID_ARGUMENT', `Map field ${fullName}.${f.name} has a malformed entry type.`)
      out.keyType = SCALAR_BY_TYPE[key.type] ?? 'string'
      out.type = SCALAR_BY_TYPE[val.type] ?? val.typeName ?? ''
    } else {
      out.type = SCALAR_BY_TYPE[f.type] ?? f.typeName ?? ''
      if (f.label === 3) out.rule = 'repeated'
      else if (f.label === 2) out.rule = 'required'
    }
    const opts: Obj = {}
    if (typeof f.options?.packed === 'boolean') opts.packed = f.options.packed
    if (f.proto3Optional) opts.proto3_optional = true
    if (f.jsonName && f.jsonName !== lowerCamel(f.name)) opts.json_name = f.jsonName
    if (Object.keys(opts).length) out.options = opts
    fields[f.name] = out
  }
  const oneofs: Obj = {}
  ;(m.oneofDecl ?? []).forEach((o, i) => {
    const members = (m.field ?? []).filter((f) => f.oneofIndex === i).map((f) => f.name)
    if (members.length) oneofs[o.name] = { oneof: members }
  })
  const nested: Obj = {}
  for (const n of m.nestedType ?? []) if (!n.options?.mapEntry) nested[n.name] = convertMessage(n, `${fullName}.${n.name}`, null)
  for (const e of m.enumType ?? []) nested[e.name] = convertEnum(e, null)
  return { fields, ...(Object.keys(oneofs).length ? { oneofs } : {}), ...(edition ? { edition } : {}), ...(Object.keys(nested).length ? { nested } : {}) }
}

/** FileDescriptorProtos (a reflection answer) → protobufjs JSON (then normalised by the caller). */
export function fileDescriptorsToJson(files: FileDescriptor[]): Obj {
  const root: Obj = { nested: {} }
  const nsFor = (pkg: string): Obj => {
    let cur = root
    for (const part of pkg ? pkg.split('.') : []) {
      ident(part, 'package')
      const nested = (cur.nested ?? (cur.nested = {})) as Obj
      if (!own(nested, part)) nested[part] = { nested: {} }
      cur = nested[part] as Obj
      if (!isObj(cur.nested)) cur.nested = {}
    }
    return cur
  }
  const put = (ns: Obj, name: string, def: Obj): void => {
    ident(name, 'definition')
    const nested = (ns.nested ?? (ns.nested = {})) as Obj
    if (own(nested, name) && isObj(nested[name]) && isObj((nested[name] as Obj).nested) && !isObj((nested[name] as Obj).fields))
      // A package part and a message with the same name: keep both (protobufjs merges namespaces).
      nested[name] = { ...def, nested: { ...((nested[name] as Obj).nested as Obj), ...((def.nested as Obj | undefined) ?? {}) } }
    else nested[name] = def
  }
  for (const f of files) {
    const pkg = f.package ?? ''
    const edition = f.syntax === 'proto2' || !f.syntax ? 'proto2' : null
    const ns = nsFor(pkg)
    for (const m of f.messageType ?? []) put(ns, m.name, convertMessage(m, `.${pkg ? `${pkg}.` : ''}${m.name}`, edition))
    for (const e of f.enumType ?? []) put(ns, e.name, convertEnum(e, edition))
    for (const s of f.service ?? []) {
      const methods: Obj = {}
      for (const m of s.method ?? [])
        methods[m.name] = { requestType: m.inputType, responseType: m.outputType, ...(m.clientStreaming ? { requestStream: true } : {}), ...(m.serverStreaming ? { responseStream: true } : {}) }
      put(ns, s.name, { methods })
    }
  }
  return root
}

/** Merges protobufjs `nested` maps (namespaces merge; definitions already present win). */
function mergeNested(into: Obj, from: Obj): void {
  for (const [k, v] of Object.entries(from)) {
    if (!isObj(v)) continue
    const cur = into[k]
    if (!own(into, k)) into[k] = structuredClone(v)
    else if (isObj(cur) && isObj(cur.nested) && isObj(v.nested) && !isObj(v.fields) && !isObj(v.values) && !isObj(v.methods)) mergeNested(cur.nested, v.nested)
  }
}

/** Reflection answer → stored definition. Missing `google/protobuf/*` files are filled from the bundled copies. */
export function descriptorFromFiles(files: FileDescriptor[]): GrpcDescriptor {
  const known = new Set(files.map((f) => f.name))
  const json = fileDescriptorsToJson(files)
  for (const f of files)
    for (const dep of f.dependency ?? [])
      if (!known.has(dep)) {
        const b = bundled(dep)
        if (b) {
          known.add(dep)
          mergeNested(json.nested as Obj, ((b.nested as Obj | undefined) ?? b) as Obj)
        }
      }
  // protobufjs resolves every reference while it builds the root.
  const root = rootFromJson(normalizeProtoJson(json))
  return descriptorFromRoot(root, 'reflection', files.map((f) => f.name))
}

// ---------------------------------------------------------------------------------------------
// proto3 JSON mapping
// ---------------------------------------------------------------------------------------------

export function jsonName(f: protobuf.Field): string {
  const o = f.options as Obj | undefined
  return typeof o?.json_name === 'string' ? o.json_name : lowerCamel(f.name)
}

function fieldById(t: protobuf.Type, id: number): protobuf.Field {
  const f = t.fieldsById[id]
  if (!f) throw new Fault('INVALID_ARGUMENT', `${t.fullName.slice(1)} is not a standard well-known type.`)
  return f
}

const WRAPPERS = new Set(['DoubleValue', 'FloatValue', 'Int64Value', 'UInt64Value', 'Int32Value', 'UInt32Value', 'BoolValue', 'StringValue', 'BytesValue'].map((n) => `.google.protobuf.${n}`))
const INT32 = new Set(['int32', 'sint32', 'sfixed32'])
const UINT32 = new Set(['uint32', 'fixed32'])
const INT64 = new Set(['int64', 'sint64', 'sfixed64'])
const UINT64 = new Set(['uint64', 'fixed64'])

const describe = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : typeof v === 'string' ? `"${v.length > 40 ? v.slice(0, 40) + '…' : v}"` : String(v))

function bad(path: string, msg: string): never {
  throw new Fault('INVALID_ARGUMENT', `Field "${path || '(message)'}": ${msg}`)
}

function scalarIn(type: string, v: unknown, path: string): unknown {
  if (type === 'string') return typeof v === 'string' ? v : bad(path, `expected a string, got ${describe(v)}.`)
  if (type === 'bool') return typeof v === 'boolean' ? v : bad(path, `expected true or false, got ${describe(v)}.`)
  if (type === 'bytes') {
    if (typeof v !== 'string' || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(v)) bad(path, `expected base64 text, got ${describe(v)}.`)
    return Buffer.from((v as string).replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  }
  if (type === 'double' || type === 'float') {
    if (typeof v === 'number') return v
    if (v === 'NaN' || v === 'Infinity' || v === '-Infinity') return Number(v)
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
    return bad(path, `expected a number, got ${describe(v)}.`)
  }
  const text = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : '') : typeof v === 'string' ? v.trim() : ''
  if (!/^-?\d+$/.test(text)) bad(path, `expected an integer (${type}), got ${describe(v)}.`)
  const n = BigInt(text)
  const range = INT32.has(type) ? [-(2n ** 31n), 2n ** 31n - 1n] : UINT32.has(type) ? [0n, 2n ** 32n - 1n] : INT64.has(type) ? [-(2n ** 63n), 2n ** 63n - 1n] : [0n, 2n ** 64n - 1n]
  if (n < range[0] || n > range[1]) bad(path, `${text} is out of range for ${type}.`)
  if (INT64.has(type) || UINT64.has(type)) {
    const Long = protobuf.util.Long as unknown as { fromString(s: string, unsigned: boolean): unknown } | undefined
    return Long ? Long.fromString(text, UINT64.has(type)) : Number(text)
  }
  return Number(text)
}

function enumIn(e: protobuf.Enum, v: unknown, path: string): number {
  if (typeof v === 'string') {
    if (own(e.values, v)) return e.values[v]
    const names = Object.keys(e.values)
    return bad(path, `"${v}" is not a value of enum ${e.fullName.slice(1)} (${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''}).`)
  }
  if (typeof v === 'number' && Number.isInteger(v)) return v
  return bad(path, `expected an enum name of ${e.fullName.slice(1)}, got ${describe(v)}.`)
}

function timestampIn(v: unknown, path: string): { seconds: number; nanos: number } {
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})$/.exec(v) : null
  if (!m) return bad(path, `expected an RFC 3339 timestamp such as "2025-01-31T12:00:00Z", got ${describe(v)}.`)
  let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  if (m[8] !== 'Z' && m[8] !== 'z') {
    const sign = m[8][0] === '-' ? -1 : 1
    ms -= sign * (Number(m[8].slice(1, 3)) * 60 + Number(m[8].slice(4, 6))) * 60_000
  }
  return { seconds: Math.floor(ms / 1000), nanos: m[7] ? Number(m[7].padEnd(9, '0')) : 0 }
}

function durationIn(v: unknown, path: string): { seconds: number; nanos: number } {
  const m = typeof v === 'string' ? /^(-)?(\d+)(?:\.(\d{1,9}))?s$/.exec(v) : null
  if (!m) return bad(path, `expected a duration such as "1.5s", got ${describe(v)}.`)
  const sign = m[1] ? -1 : 1
  return { seconds: sign * Number(m[2]), nanos: sign * (m[3] ? Number(m[3].padEnd(9, '0')) : 0) }
}

/** google.protobuf.Value from plain JSON. */
function valueIn(t: protobuf.Type, v: unknown, path: string, depth: number): Obj {
  if (depth > 64) bad(path, 'nested too deeply.')
  const f = (id: number): string => fieldById(t, id).name
  if (v === null) return { [f(1)]: 0 }
  if (typeof v === 'number') return { [f(2)]: v }
  if (typeof v === 'string') return { [f(3)]: v }
  if (typeof v === 'boolean') return { [f(4)]: v }
  const structT = fieldById(t, 5).resolvedType as protobuf.Type
  const listT = fieldById(t, 6).resolvedType as protobuf.Type
  if (Array.isArray(v)) return { [f(6)]: listIn(listT, v, path, depth + 1) }
  return { [f(5)]: structIn(structT, v, path, depth + 1) }
}
function structIn(t: protobuf.Type, v: unknown, path: string, depth: number): Obj {
  if (!isObj(v)) bad(path, `expected a JSON object, got ${describe(v)}.`)
  const valueT = fieldById(t, 1).resolvedType as protobuf.Type
  const fields: Obj = {}
  for (const [k, x] of Object.entries(v as Obj)) fields[k] = valueIn(valueT, x, `${path}.${k}`, depth + 1)
  return { [fieldById(t, 1).name]: fields }
}
function listIn(t: protobuf.Type, v: unknown, path: string, depth: number): Obj {
  if (!Array.isArray(v)) bad(path, `expected an array, got ${describe(v)}.`)
  const valueT = fieldById(t, 1).resolvedType as protobuf.Type
  return { [fieldById(t, 1).name]: (v as unknown[]).map((x, i) => valueIn(valueT, x, `${path}[${i}]`, depth + 1)) }
}

function messageIn(t: protobuf.Type, v: unknown, path: string, depth: number): Obj {
  if (depth > 64) bad(path, 'nested too deeply.')
  const full = t.fullName
  if (full === '.google.protobuf.Timestamp') return timestampIn(v, path)
  if (full === '.google.protobuf.Duration') return durationIn(v, path)
  if (WRAPPERS.has(full)) {
    const f = fieldById(t, 1)
    return { [f.name]: scalarIn(f.type, v, path) }
  }
  if (full === '.google.protobuf.Struct') return structIn(t, v, path, depth)
  if (full === '.google.protobuf.ListValue') return listIn(t, v, path, depth)
  if (full === '.google.protobuf.Value') return valueIn(t, v, path, depth)
  if (full === '.google.protobuf.FieldMask') {
    if (typeof v !== 'string') bad(path, `expected field paths such as "name,address.city", got ${describe(v)}.`)
    const paths = (v as string).split(',').map((p) => p.trim()).filter(Boolean).map((p) => p.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))
    return { [fieldById(t, 1).name]: paths }
  }
  if (full === '.google.protobuf.Any') {
    if (!isObj(v)) bad(path, `expected an object with "@type", got ${describe(v)}.`)
    const o = v as Obj
    if (!Object.keys(o).length) return {}
    const url = o['@type']
    if (typeof url !== 'string' || !url.includes('/')) bad(path, 'an Any needs "@type": "type.googleapis.com/package.Message".')
    let inner: protobuf.Type
    try {
      inner = t.root.lookupType((url as string).slice((url as string).lastIndexOf('/') + 1))
    } catch {
      return bad(path, `"@type" names ${describe(url)}, which is not in the service definition.`)
    }
    const { ['@type']: _t, ...rest } = o
    const special = inner.fullName.startsWith('.google.protobuf.') && inner.fullName !== '.google.protobuf.Empty'
    const payload = messageIn(inner, special ? rest.value : rest, path, depth + 1)
    return { [fieldById(t, 1).name]: url, [fieldById(t, 2).name]: inner.encode(inner.fromObject(payload)).finish() }
  }
  if (!isObj(v)) bad(path, `expected a JSON object for ${full.slice(1)}, got ${describe(v)}.`)
  const out: Obj = {}
  const byName = new Map<string, protobuf.Field>()
  for (const f of t.fieldsArray) {
    byName.set(jsonName(f), f)
    byName.set(f.name, f)
  }
  const oneofSet = new Map<string, string>()
  for (const [k, x] of Object.entries(v as Obj)) {
    const p = path ? `${path}.${k}` : k
    const f = byName.get(k)
    if (!f) {
      const names = t.fieldsArray.map(jsonName)
      bad(p, `${t.fullName.slice(1)} has no field "${k}"${names.length ? ` (fields: ${names.slice(0, 15).join(', ')}${names.length > 15 ? ', …' : ''})` : ''}.`)
    }
    f.resolve()
    const isValueLike = f.resolvedType?.fullName === '.google.protobuf.Value' || f.resolvedType?.fullName === '.google.protobuf.NullValue'
    if (x === null && !isValueLike) continue
    if (f.partOf && f.partOf.oneof.length > 1) {
      const prev = oneofSet.get(f.partOf.name)
      if (prev) bad(p, `only one of ${f.partOf.oneof.map((n) => `"${n}"`).join(', ')} may be set (also got "${prev}").`)
      oneofSet.set(f.partOf.name, k)
    }
    out[f.name] = fieldIn(f, x, p, depth)
  }
  return out
}

function valueOf(f: protobuf.Field, v: unknown, path: string, depth: number): unknown {
  const rt = f.resolvedType
  if (rt instanceof protobuf.Type) return messageIn(rt, v, path, depth + 1)
  if (rt instanceof protobuf.Enum) return rt.fullName === '.google.protobuf.NullValue' ? 0 : enumIn(rt, v, path)
  return scalarIn(f.type, v, path)
}

function fieldIn(f: protobuf.Field, v: unknown, path: string, depth: number): unknown {
  if (f.map) {
    if (!isObj(v)) bad(path, `expected a JSON object (map), got ${describe(v)}.`)
    const out: Obj = {}
    for (const [k, x] of Object.entries(v as Obj)) {
      const kp = `${path}["${k}"]`
      const kt = (f as unknown as protobuf.MapField).keyType
      if (kt === 'bool' && k !== 'true' && k !== 'false') bad(kp, 'map keys must be "true" or "false".')
      if (kt !== 'string' && kt !== 'bool' && !/^-?\d+$/.test(k)) bad(kp, `map keys must be integers (${kt}).`)
      out[k] = valueOf(f, x, kp, depth)
    }
    return out
  }
  if (f.repeated) {
    if (!Array.isArray(v)) bad(path, `expected an array, got ${describe(v)}.`)
    return (v as unknown[]).map((x, i) => valueOf(f, x, `${path}[${i}]`, depth))
  }
  return valueOf(f, v, path, depth)
}

/** Validates JSON text against a message type and encodes it. Errors name the offending field. */
export function encodeJson(t: protobuf.Type, text: string): { bytes: Buffer; normalized: unknown } {
  let value: unknown
  try {
    value = text.trim() ? JSON.parse(text) : {}
  } catch (err) {
    throw new Fault('INVALID_ARGUMENT', `The message is not valid JSON: ${messageOf(err)}`)
  }
  const obj = messageIn(t, value, '', 0)
  let bytes: Uint8Array
  try {
    bytes = t.encode(t.fromObject(obj)).finish()
  } catch (err) {
    throw new Fault('INVALID_ARGUMENT', `The message does not match ${t.fullName.slice(1)}: ${messageOf(err)}`)
  }
  return { bytes: Buffer.from(bytes), normalized: value }
}

// --- output ------------------------------------------------------------------------------------

function longOut(v: unknown): string {
  if (typeof v === 'number') return String(v)
  if (v && typeof v === 'object' && 'toString' in v) return String(v)
  return '0'
}

function scalarOut(type: string, v: unknown): unknown {
  if (INT64.has(type) || UINT64.has(type)) return longOut(v)
  if (type === 'bytes') return Buffer.from((v as Uint8Array | undefined) ?? []).toString('base64')
  if ((type === 'double' || type === 'float') && typeof v === 'number' && !Number.isFinite(v)) return String(v)
  return v
}

function timestampOut(seconds: unknown, nanos: number): string {
  const s = Number(longOut(seconds))
  const d = new Date(s * 1000)
  const base = d.toISOString().replace(/\.\d{3}Z$/, '')
  if (!nanos) return `${base}Z`
  return `${base}.${String(nanos).padStart(9, '0').replace(/(?:000)+$/, '')}Z`
}

function valueOut(t: protobuf.Type, m: Obj): unknown {
  const name = (id: number): string => fieldById(t, id).name
  if (own(m, name(1))) return null
  if (own(m, name(2))) return m[name(2)]
  if (own(m, name(3))) return m[name(3)]
  if (own(m, name(4))) return m[name(4)]
  if (own(m, name(5))) return messageOut(fieldById(t, 5).resolvedType as protobuf.Type, m[name(5)] as Obj)
  if (own(m, name(6))) return messageOut(fieldById(t, 6).resolvedType as protobuf.Type, m[name(6)] as Obj)
  return null
}

function fieldValueOut(f: protobuf.Field, v: unknown): unknown {
  const rt = f.resolvedType
  if (rt instanceof protobuf.Type) return v == null ? null : messageOut(rt, v as Obj)
  if (rt instanceof protobuf.Enum) return rt.fullName === '.google.protobuf.NullValue' ? null : (rt.valuesById[v as number] ?? v)
  return scalarOut(f.type, v)
}

/** Decoded message → proto3 JSON value (well-known types in their JSON form). */
export function messageOut(t: protobuf.Type, m: Obj, depth = 0): unknown {
  if (depth > 64) return '…'
  const full = t.fullName
  const name = (id: number): string => fieldById(t, id).name
  if (full === '.google.protobuf.Timestamp') return timestampOut(m[name(1)], Number(m[name(2)] ?? 0))
  if (full === '.google.protobuf.Duration') {
    const s = Number(longOut(m[name(1)]))
    const n = Number(m[name(2)] ?? 0)
    const neg = s < 0 || n < 0
    const frac = n ? `.${String(Math.abs(n)).padStart(9, '0').replace(/(?:000)+$/, '')}` : ''
    return `${neg ? '-' : ''}${Math.abs(s)}${frac}s`
  }
  if (WRAPPERS.has(full)) return scalarOut(fieldById(t, 1).type, m[name(1)] ?? (fieldById(t, 1).type === 'string' ? '' : fieldById(t, 1).type === 'bool' ? false : 0))
  if (full === '.google.protobuf.Struct') {
    const valueT = fieldById(t, 1).resolvedType as protobuf.Type
    const out: Obj = {}
    for (const [k, v] of Object.entries((m[name(1)] as Obj) ?? {})) out[k] = valueOut(valueT, v as Obj)
    return out
  }
  if (full === '.google.protobuf.ListValue') {
    const valueT = fieldById(t, 1).resolvedType as protobuf.Type
    return ((m[name(1)] as Obj[]) ?? []).map((v) => valueOut(valueT, v))
  }
  if (full === '.google.protobuf.Value') return valueOut(t, m)
  if (full === '.google.protobuf.FieldMask') return ((m[name(1)] as string[]) ?? []).map(lowerCamel).join(',')
  if (full === '.google.protobuf.Any') {
    const url = String(m[name(1)] ?? '')
    if (!url) return {}
    try {
      const inner = t.root.lookupType(url.slice(url.lastIndexOf('/') + 1))
      const decoded = inner.decode((m[name(2)] as Uint8Array) ?? new Uint8Array()) as unknown as Obj
      const body = messageOut(inner, decoded, depth + 1)
      return inner.fullName.startsWith('.google.protobuf.') && inner.fullName !== '.google.protobuf.Empty' ? { '@type': url, value: body } : { '@type': url, ...(body as Obj) }
    } catch {
      return { '@type': url, value: Buffer.from((m[name(2)] as Uint8Array) ?? []).toString('base64') }
    }
  }
  const out: Obj = {}
  for (const f of [...t.fieldsArray].sort((a, b) => a.id - b.id)) {
    f.resolve()
    const key = jsonName(f)
    const has = own(m, f.name) && m[f.name] != null
    if (f.map) {
      const o: Obj = {}
      for (const [k, v] of Object.entries((m[f.name] as Obj) ?? {})) o[k] = fieldValueOut(f, v)
      out[key] = o
    } else if (f.repeated) out[key] = ((m[f.name] as unknown[]) ?? []).map((v) => fieldValueOut(f, v))
    else if (f.partOf || f.resolvedType instanceof protobuf.Type) {
      // Oneof members, proto3 `optional` and message fields: only when set.
      if (has) out[key] = fieldValueOut(f, m[f.name])
    } else out[key] = fieldValueOut(f, has ? m[f.name] : f.resolvedType instanceof protobuf.Enum ? 0 : f.defaultValue)
  }
  return out
}

/** Decodes bytes into pretty proto3 JSON text. */
export function decodeToJson(t: protobuf.Type, bytes: Uint8Array): string {
  let msg: protobuf.Message
  try {
    msg = t.decode(bytes)
  } catch (err) {
    throw new Fault('INVALID_ARGUMENT', `The response could not be decoded as ${t.fullName.slice(1)}: ${messageOf(err)}`)
  }
  return JSON.stringify(messageOut(t, msg as unknown as Obj), null, 2)
}

// ---------------------------------------------------------------------------------------------
// Example messages
// ---------------------------------------------------------------------------------------------

function scalarExample(type: string): unknown {
  if (type === 'string' || type === 'bytes') return ''
  if (type === 'bool') return false
  if (INT64.has(type) || UINT64.has(type)) return '0'
  return 0
}

function exampleValue(f: protobuf.Field, path: string[]): unknown {
  const rt = f.resolvedType
  if (rt instanceof protobuf.Type) return exampleMessage(rt, path)
  if (rt instanceof protobuf.Enum) {
    if (rt.fullName === '.google.protobuf.NullValue') return null
    const zero = rt.valuesById[0]
    return zero ?? Object.keys(rt.values)[0]
  }
  return scalarExample(f.type)
}

/** A skeleton of a message: every field once (first member of each oneof), recursion cut off. */
export function exampleMessage(t: protobuf.Type, path: string[] = []): unknown {
  const full = t.fullName
  if (full === '.google.protobuf.Timestamp') return new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z')
  if (full === '.google.protobuf.Duration') return '1s'
  if (WRAPPERS.has(full)) return scalarExample(fieldById(t, 1).type)
  if (full === '.google.protobuf.Struct') return {}
  if (full === '.google.protobuf.ListValue') return []
  if (full === '.google.protobuf.Value') return null
  if (full === '.google.protobuf.FieldMask') return ''
  if (full === '.google.protobuf.Any' || full === '.google.protobuf.Empty') return {}
  if (path.includes(full) || path.length > 6) return undefined
  const next = [...path, full]
  const out: Obj = {}
  const oneofDone = new Set<string>()
  for (const f of [...t.fieldsArray].sort((a, b) => a.id - b.id)) {
    f.resolve()
    if (f.partOf && f.partOf.oneof.length > 1) {
      if (oneofDone.has(f.partOf.name)) continue
      oneofDone.add(f.partOf.name)
    }
    if (f.map) {
      const kt = (f as unknown as protobuf.MapField).keyType
      const v = exampleValue(f, next)
      out[jsonName(f)] = v === undefined ? {} : { [kt === 'string' ? 'key' : kt === 'bool' ? 'true' : '0']: v }
    } else if (f.repeated) {
      const v = exampleValue(f, next)
      out[jsonName(f)] = v === undefined ? [] : [v]
    } else {
      const v = exampleValue(f, next)
      if (v !== undefined) out[jsonName(f)] = v
    }
  }
  return out
}
