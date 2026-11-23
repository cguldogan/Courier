/**
 * gRPC calls and server reflection (pure Node, `@grpc/grpc-js`). One `GrpcCall` per invoke;
 * `GrpcManager` owns the running ones.
 *
 * Address, metadata and the request message resolve `{{variables}}` / `{{vault:…}}` in main;
 * auth comes from `prepareConnection` (the HTTP path), so team vault approval and OAuth host rules are
 * unchanged. A `Masker` per call masks Key Vault values and tokens in everything sent to the renderer:
 * request metadata, messages in both directions, response headers, trailers and status details.
 * Messages are encoded/decoded here (not by grpc-js) so JSON errors name the offending field.
 */
import * as grpc from '@grpc/grpc-js'
import protobuf from 'protobufjs'
import { GRPC_DEFAULT_MAX_RECEIVE_BYTES, PREVIEW_MAX_BYTES, parseGrpcAddress, type GrpcTarget } from '../../shared/realtime'
import type { Auth, GrpcCallType, GrpcDescriptor, GrpcEvent, GrpcRequestDef, GrpcStatusInfo, RealtimeLogEntry } from '../../shared/types'
import type { VariableLayers } from '../../shared/variables'
import { Fault, messageOf } from '../errors'
import { Masker, USER_AGENT, prepareConnection, resolveText, type ExecutorDeps } from '../executor'
import { decodeFileDescriptor, decodeToJson, descriptorFromFiles, encodeJson, findMethod, loadDescriptor, type FileDescriptor, type ResolvedMethod } from './protos'

export interface GrpcContext {
  layers: VariableLayers
  deps: ExecutorDeps
}

/** PEM contents read by core from files picked on this machine. */
export interface GrpcTlsMaterial {
  ca?: Buffer
  cert?: Buffer
  key?: Buffer
}

export const STATUS_NAMES: Record<number, string> = Object.fromEntries(Object.entries(grpc.status).filter(([, v]) => typeof v === 'number').map(([k, v]) => [v as number, k]))

export function statusHint(code: number, ctx: { target: string; path: string; deadlineMs?: number; tls: boolean }): string | undefined {
  switch (code) {
    case grpc.status.UNAVAILABLE:
      return `The server at ${ctx.target} could not be reached. Check the address, that the server is running, and whether it expects TLS (TLS is ${ctx.tls ? 'on' : 'off'}).`
    case grpc.status.UNAUTHENTICATED:
      return 'The server rejected or did not get credentials. Check the Authorization tab and the metadata.'
    case grpc.status.PERMISSION_DENIED:
      return 'The credentials were accepted but do not allow this call.'
    case grpc.status.DEADLINE_EXCEEDED:
      return ctx.deadlineMs ? `No answer within the deadline (${ctx.deadlineMs} ms). Raise it in the Settings tab.` : 'The call ran out of time.'
    case grpc.status.UNIMPLEMENTED:
      return `The server does not implement ${ctx.path}. Check the server address, and reload the service definition (reflection or .proto files).`
    case grpc.status.RESOURCE_EXHAUSTED:
      return 'A message was larger than allowed. Raise "Max receive message size" in the Settings tab if the response is expected to be this large.'
    case grpc.status.CANCELLED:
      return 'The call was cancelled.'
    default:
      return undefined
  }
}

function credentials(target: GrpcTarget, verify: boolean, tls: GrpcTlsMaterial): grpc.ChannelCredentials {
  if (!target.tls) return grpc.credentials.createInsecure()
  if (Boolean(tls.cert) !== Boolean(tls.key)) throw new Fault('INVALID_ARGUMENT', 'A client certificate needs its private key (and the other way round). Choose both in the Settings tab.')
  return grpc.credentials.createSsl(tls.ca ?? null, tls.key ?? null, tls.cert ?? null, verify ? {} : { rejectUnauthorized: false, checkServerIdentity: () => undefined })
}

function makeClient(target: GrpcTarget, creds: grpc.ChannelCredentials, maxReceive: number): grpc.Client {
  return new grpc.Client(target.target, creds, {
    'grpc.max_receive_message_length': maxReceive,
    'grpc.max_send_message_length': -1,
    'grpc.primary_user_agent': USER_AGENT,
    'grpc.enable_retries': 0
  })
}

const METADATA_KEY = /^[0-9a-z_.-]+$/

function toMetadata(headers: [string, string][]): grpc.Metadata {
  const md = new grpc.Metadata()
  for (const [rawKey, value] of headers) {
    const key = rawKey.trim().toLowerCase()
    if (!METADATA_KEY.test(key)) throw new Fault('INVALID_ARGUMENT', `Metadata key "${rawKey}" is not valid (lower-case letters, digits, "-", "_" and "." only).`)
    if (key.startsWith('grpc-') || key === 'content-type' || key === 'te' || key === 'user-agent') throw new Fault('INVALID_ARGUMENT', `Metadata key "${key}" is reserved by gRPC.`)
    try {
      if (key.endsWith('-bin')) md.add(key, Buffer.from(value, 'base64'))
      else md.add(key, value)
    } catch (err) {
      throw new Fault('INVALID_ARGUMENT', `Metadata "${key}": ${messageOf(err)}`)
    }
  }
  return md
}

function metadataPairs(md: grpc.Metadata | undefined, mask: (s: string) => string): [string, string][] {
  if (!md) return []
  const out: [string, string][] = []
  for (const [k, values] of Object.entries(md.getMap())) {
    const all = md.get(k)
    for (const v of all.length ? all : [values]) out.push([k, mask(Buffer.isBuffer(v) ? v.toString('base64') : String(v))])
  }
  return out
}

interface Prepared {
  target: GrpcTarget
  metadata: grpc.Metadata
  shownMetadata: [string, string][]
  creds: grpc.ChannelCredentials
  maxReceive: number
}

async function prepare(
  r: GrpcRequestDef,
  auth: Auth,
  ctx: GrpcContext,
  masker: Masker,
  defaults: { verifyTls: boolean },
  tls: GrpcTlsMaterial
): Promise<Prepared> {
  const prepared = await prepareConnection({ url: r.address.trim(), params: [], headers: r.metadata, auth }, { protocol: 'gRPC', layers: ctx.layers, deps: ctx.deps, masker })
  let target: GrpcTarget
  try {
    target = parseGrpcAddress(prepared.url, r.tls)
  } catch (err) {
    throw new Fault('INVALID_ARGUMENT', masker.mask(messageOf(err)))
  }
  const metadata = toMetadata(prepared.headers)
  return {
    target,
    metadata,
    shownMetadata: prepared.headers.map(([k, v]) => [k.toLowerCase(), masker.mask(v)]),
    creds: credentials(target, r.settings.verifyTls ?? defaults.verifyTls, tls),
    maxReceive: r.settings.maxReceiveBytes ?? GRPC_DEFAULT_MAX_RECEIVE_BYTES
  }
}

export interface GrpcCallOptions {
  id: string
  owner: number | null
  request: GrpcRequestDef
  auth: Auth
  context: () => Promise<GrpcContext>
  emit: (e: GrpcEvent) => void
  defaults: { verifyTls: boolean }
  tls: GrpcTlsMaterial
}

type AnyCall = grpc.ClientUnaryCall | grpc.ClientReadableStream<Buffer> | grpc.ClientWritableStream<Buffer> | grpc.ClientDuplexStream<Buffer, Buffer>

const identity = (b: Buffer): Buffer => b

export class GrpcCall {
  readonly id: string
  readonly owner: number | null
  private readonly opts: GrpcCallOptions
  private readonly masker = new Masker()
  private method!: ResolvedMethod
  private client: grpc.Client | null = null
  private call: AnyCall | null = null
  private started = 0
  private seq = 0
  private ended = false
  private writable = false
  private onEnd: (() => void) | null = null

  constructor(opts: GrpcCallOptions) {
    this.opts = opts
    this.id = opts.id
    this.owner = opts.owner
  }

  get done(): boolean {
    return this.ended
  }

  get callType(): GrpcCallType {
    return this.method.callType
  }

  private m(s: string): string {
    return this.masker.mask(s)
  }

  private log(entry: Omit<RealtimeLogEntry, 'seq' | 'at' | 'elapsedMs'>): RealtimeLogEntry {
    const e: RealtimeLogEntry = { seq: ++this.seq, at: new Date().toISOString(), elapsedMs: this.started ? Date.now() - this.started : 0, ...entry }
    this.opts.emit({ callId: this.id, type: 'message', entry: e })
    return e
  }

  private jsonEntry(direction: 'in' | 'out', text: string, size: number): Omit<RealtimeLogEntry, 'seq' | 'at' | 'elapsedMs'> {
    const masked = this.m(text)
    const cut = masked.length > PREVIEW_MAX_BYTES
    return { direction, kind: 'text', size, text: cut ? masked.slice(0, PREVIEW_MAX_BYTES) : masked, ...(cut ? { truncated: true } : {}) }
  }

  /** Validates, resolves and encodes one request message. */
  private async encode(text: string, ctx?: GrpcContext): Promise<{ bytes: Buffer; shown: string }> {
    const c = ctx ?? (await this.opts.context())
    const resolved = await resolveText(text, c.layers, c.deps.vault, this.masker)
    const { bytes, normalized } = encodeJson(this.method.requestType, resolved)
    return { bytes, shown: JSON.stringify(normalized, null, 2) }
  }

  /**
   * Starts the call. Unary and server-streaming calls send the message now; client-streaming and
   * bidirectional calls stay open for `send` / `end`. Resolves once the call is on its way; the
   * outcome arrives as events (`end` carries the status).
   */
  async start(): Promise<{ callType: GrpcCallType }> {
    const r = this.opts.request
    const root: protobuf.Root = loadDescriptor(r.descriptor)
    this.method = findMethod(root, r.service, r.method)
    const ctx = await this.opts.context()
    const p = await prepare(r, this.opts.auth, ctx, this.masker, this.opts.defaults, this.opts.tls)
    const first = this.method.callType === 'unary' || this.method.callType === 'server-stream' ? await this.encode(r.message, ctx) : null
    const deadlineMs = r.settings.deadlineMs
    const options: grpc.CallOptions = deadlineMs ? { deadline: new Date(Date.now() + deadlineMs) } : {}
    this.client = makeClient(p.target, p.creds, p.maxReceive)
    this.started = Date.now()
    this.opts.emit({ callId: this.id, type: 'started', callType: this.method.callType, path: this.method.path, target: p.target.target, tls: p.target.tls, requestMetadata: p.shownMetadata })
    const res = this.method.responseType
    const onMessage = (b: Buffer): void => {
      try {
        this.log(this.jsonEntry('in', decodeToJson(res, b), b.length))
      } catch (err) {
        this.log({ direction: 'info', kind: 'error', size: b.length, text: this.m(messageOf(err)) })
      }
    }
    const client = this.client
    let call: AnyCall
    const path = this.method.path
    switch (this.method.callType) {
      case 'unary':
        call = client.makeUnaryRequest(path, identity, identity, (first as { bytes: Buffer }).bytes, p.metadata, options, (err, value) => {
          if (!err && value) onMessage(value)
        })
        break
      case 'server-stream': {
        const c = client.makeServerStreamRequest(path, identity, identity, (first as { bytes: Buffer }).bytes, p.metadata, options)
        c.on('data', onMessage)
        call = c
        break
      }
      case 'client-stream':
        call = client.makeClientStreamRequest(path, identity, identity, p.metadata, options, (err, value) => {
          if (!err && value) onMessage(value)
        })
        this.writable = true
        break
      default: {
        const c = client.makeBidiStreamRequest(path, identity, identity, p.metadata, options)
        c.on('data', onMessage)
        call = c
        this.writable = true
      }
    }
    this.call = call
    if (first) this.log(this.jsonEntry('out', first.shown, first.bytes.length))
    // Stream errors are reported through 'status'; the listener keeps them from being thrown.
    const events = call as unknown as NodeJS.EventEmitter
    events.on('error', () => undefined)
    events.on('metadata', (md: grpc.Metadata) => this.opts.emit({ callId: this.id, type: 'headers', metadata: metadataPairs(md, (s) => this.m(s)) }))
    events.on('status', (st: grpc.StatusObject) => {
      // Unary / client-stream: the callback (message) runs before 'status' on success.
      setImmediate(() => this.finish(st, p, deadlineMs))
    })
    return { callType: this.method.callType }
  }

  private finish(st: grpc.StatusObject, p: Prepared, deadlineMs: number | undefined): void {
    if (this.ended) return
    this.ended = true
    this.writable = false
    const status: GrpcStatusInfo = { code: st.code, name: STATUS_NAMES[st.code] ?? String(st.code), details: this.m(st.details ?? '') }
    const hint = st.code === grpc.status.OK ? undefined : statusHint(st.code, { target: p.target.target, path: this.method.path, deadlineMs, tls: p.target.tls })
    this.opts.emit({ callId: this.id, type: 'end', status, trailers: metadataPairs(st.metadata, (s) => this.m(s)), durationMs: Date.now() - this.started, ...(hint ? { hint } : {}) })
    this.client?.close()
    this.client = null
    this.onEnd?.()
  }

  /** Client / bidirectional streaming: send one more message. */
  async send(text: string): Promise<RealtimeLogEntry> {
    if (!this.call || this.ended) throw new Fault('INVALID_ARGUMENT', 'The call has ended. Invoke again.')
    if (!this.writable) throw new Fault('INVALID_ARGUMENT', this.method.callType === 'unary' || this.method.callType === 'server-stream' ? 'This method takes a single request message.' : 'The request stream was already ended.')
    const { bytes, shown } = await this.encode(text)
    const w = this.call as grpc.ClientWritableStream<Buffer>
    await new Promise<void>((resolve, reject) => w.write(bytes, (err: unknown) => (err ? reject(new Fault('NETWORK', `Sending failed: ${messageOf(err)}`)) : resolve())))
    return this.log(this.jsonEntry('out', shown, bytes.length))
  }

  /** Half-close: no more request messages. */
  end(): boolean {
    if (!this.call || this.ended || !this.writable) return false
    this.writable = false
    ;(this.call as grpc.ClientWritableStream<Buffer>).end()
    this.log({ direction: 'info', kind: 'event', size: 0, text: 'Request stream ended (half-close).' })
    return true
  }

  cancel(): boolean {
    if (!this.call || this.ended) return false
    this.call.cancel()
    return true
  }

  /** Teardown (window closed, app quit). */
  dispose(): void {
    if (this.call && !this.ended) this.call.cancel()
    this.client?.close()
    this.client = null
  }

  whenEnded(fn: () => void): void {
    this.onEnd = fn
  }
}

export class GrpcManager {
  private readonly calls = new Map<string, GrpcCall>()

  get size(): number {
    return this.calls.size
  }

  get(id: string): GrpcCall {
    const c = this.calls.get(id)
    if (!c || c.done) throw new Fault('NOT_FOUND', 'This call has ended. Invoke again.')
    return c
  }

  async start(opts: GrpcCallOptions): Promise<{ callType: GrpcCallType }> {
    this.calls.get(opts.id)?.dispose()
    const c = new GrpcCall(opts)
    this.calls.set(opts.id, c)
    c.whenEnded(() => {
      if (this.calls.get(opts.id) === c) this.calls.delete(opts.id)
    })
    try {
      return await c.start()
    } catch (err) {
      c.dispose()
      if (this.calls.get(opts.id) === c) this.calls.delete(opts.id)
      throw err
    }
  }

  cancel(id: string): boolean {
    return this.calls.get(id)?.cancel() ?? false
  }

  closeAll(owner?: number): number {
    let n = 0
    for (const [id, c] of this.calls) {
      if (owner !== undefined && c.owner !== owner) continue
      c.dispose()
      this.calls.delete(id)
      n++
    }
    return n
  }
}

// ---------------------------------------------------------------------------------------------
// Server reflection (grpc.reflection.v1, then v1alpha)
// ---------------------------------------------------------------------------------------------

const REFLECTION_MESSAGES = {
  ServerReflectionRequest: {
    oneofs: { message_request: { oneof: ['file_by_filename', 'file_containing_symbol', 'file_containing_extension', 'all_extension_numbers_of_type', 'list_services'] } },
    fields: {
      host: { type: 'string', id: 1 },
      file_by_filename: { type: 'string', id: 3 },
      file_containing_symbol: { type: 'string', id: 4 },
      file_containing_extension: { type: 'ExtensionRequest', id: 5 },
      all_extension_numbers_of_type: { type: 'string', id: 6 },
      list_services: { type: 'string', id: 7 }
    }
  },
  ExtensionRequest: { fields: { containing_type: { type: 'string', id: 1 }, extension_number: { type: 'int32', id: 2 } } },
  ServerReflectionResponse: {
    oneofs: { message_response: { oneof: ['file_descriptor_response', 'all_extension_numbers_response', 'list_services_response', 'error_response'] } },
    fields: {
      valid_host: { type: 'string', id: 1 },
      original_request: { type: 'ServerReflectionRequest', id: 2 },
      file_descriptor_response: { type: 'FileDescriptorResponse', id: 4 },
      all_extension_numbers_response: { type: 'ExtensionNumberResponse', id: 5 },
      list_services_response: { type: 'ListServiceResponse', id: 6 },
      error_response: { type: 'ErrorResponse', id: 7 }
    }
  },
  FileDescriptorResponse: { fields: { file_descriptor_proto: { rule: 'repeated', type: 'bytes', id: 1 } } },
  ExtensionNumberResponse: { fields: { base_type_name: { type: 'string', id: 1 }, extension_number: { rule: 'repeated', type: 'int32', id: 2 } } },
  ListServiceResponse: { fields: { service: { rule: 'repeated', type: 'ServiceResponse', id: 1 } } },
  ServiceResponse: { fields: { name: { type: 'string', id: 1 } } },
  ErrorResponse: { fields: { error_code: { type: 'int32', id: 1 }, error_message: { type: 'string', id: 2 } } }
}
const REFLECTION_ROOT = protobuf.Root.fromJSON({ nested: { grpc: { nested: { reflection: { nested: { v1: { nested: REFLECTION_MESSAGES }, v1alpha: { nested: REFLECTION_MESSAGES } } } } } } })
const REQ = REFLECTION_ROOT.lookupType('grpc.reflection.v1.ServerReflectionRequest')
const RES = REFLECTION_ROOT.lookupType('grpc.reflection.v1.ServerReflectionResponse')

const MAX_REFLECTION_BYTES = 16 * 1024 * 1024
const MAX_REFLECTION_FILES = 2000

interface ReflectionResponse {
  file_descriptor_response?: { file_descriptor_proto?: Uint8Array[] }
  list_services_response?: { service?: { name?: string }[] }
  error_response?: { error_code?: number; error_message?: string }
}

class ReflectionError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}

/** One reflection session: list services, fetch the files that define them and their dependencies. */
async function reflectWith(client: grpc.Client, version: 'v1' | 'v1alpha', metadata: grpc.Metadata, deadline: Date): Promise<FileDescriptor[]> {
  const call = client.makeBidiStreamRequest(`/grpc.reflection.${version}.ServerReflection/ServerReflectionInfo`, identity, identity, metadata, { deadline })
  const waiting: { resolve: (r: ReflectionResponse) => void; reject: (e: unknown) => void }[] = []
  let failure: ReflectionError | null = null
  let received = 0
  call.on('data', (b: Buffer) => {
    received += b.length
    const w = waiting.shift()
    if (!w) return
    if (received > MAX_REFLECTION_BYTES) return w.reject(new Fault('INVALID_ARGUMENT', 'The reflection answers are too large (over 16 MB).'))
    try {
      w.resolve(RES.toObject(RES.decode(b), { arrays: true, longs: Number }) as ReflectionResponse)
    } catch (err) {
      w.reject(new Fault('INVALID_ARGUMENT', `Unreadable reflection answer: ${messageOf(err)}`))
    }
  })
  call.on('error', (err: grpc.ServiceError) => {
    failure = new ReflectionError(err.code ?? grpc.status.UNKNOWN, err.details || err.message)
    for (const w of waiting.splice(0)) w.reject(failure)
  })
  call.on('end', () => {
    for (const w of waiting.splice(0)) w.reject(failure ?? new ReflectionError(grpc.status.UNKNOWN, 'The server ended the reflection stream.'))
  })
  const ask = (req: Record<string, unknown>): Promise<ReflectionResponse> =>
    new Promise((resolve, reject) => {
      if (failure) return reject(failure)
      waiting.push({ resolve, reject })
      call.write(Buffer.from(REQ.encode(REQ.fromObject(req)).finish()))
    })
  try {
    const list = await ask({ list_services: '*' })
    if (list.error_response) throw new ReflectionError(list.error_response.error_code ?? 2, list.error_response.error_message ?? 'list_services failed')
    const services = (list.list_services_response?.service ?? []).map((s) => s.name ?? '').filter((n) => n && !n.startsWith('grpc.reflection.'))
    const files = new Map<string, FileDescriptor>()
    const take = (r: ReflectionResponse): void => {
      for (const bytes of r.file_descriptor_response?.file_descriptor_proto ?? []) {
        const fd = decodeFileDescriptor(bytes)
        if (!files.has(fd.name)) files.set(fd.name, fd)
        if (files.size > MAX_REFLECTION_FILES) throw new Fault('INVALID_ARGUMENT', 'The server described too many files.')
      }
    }
    for (const s of services.slice(0, 500)) {
      const r = await ask({ file_containing_symbol: s })
      if (r.error_response) throw new ReflectionError(r.error_response.error_code ?? 5, `Service "${s}": ${r.error_response.error_message ?? 'not found'}`)
      take(r)
    }
    // Dependencies the server did not send along (google/protobuf/* fall back to the bundled copies).
    const missing = (): string[] => [...new Set([...files.values()].flatMap((f) => f.dependency ?? []))].filter((d) => !files.has(d))
    const tried = new Set<string>()
    for (let round = 0; round < 50; round++) {
      const need = missing().filter((d) => !tried.has(d))
      if (!need.length) break
      for (const dep of need) {
        tried.add(dep)
        const r = await ask({ file_by_filename: dep })
        if (!r.error_response) take(r)
      }
    }
    return [...files.values()]
  } finally {
    call.end()
    call.cancel()
  }
}

export interface ReflectOptions {
  request: GrpcRequestDef
  auth: Auth
  context: GrpcContext
  defaults: { verifyTls: boolean }
  tls: GrpcTlsMaterial
  timeoutMs: number
}

/** Loads the service definition from the server: reflection v1 first, then v1alpha. */
export async function reflectDescriptor(o: ReflectOptions): Promise<GrpcDescriptor> {
  const masker = new Masker()
  const p = await prepare(o.request, o.auth, o.context, masker, o.defaults, o.tls)
  const client = makeClient(p.target, p.creds, Math.max(p.maxReceive, MAX_REFLECTION_BYTES))
  const deadline = (): Date => new Date(Date.now() + o.timeoutMs)
  try {
    let files: FileDescriptor[]
    try {
      files = await reflectWith(client, 'v1', p.metadata, deadline())
    } catch (err) {
      if (!(err instanceof ReflectionError) || err.code !== grpc.status.UNIMPLEMENTED) throw err
      files = await reflectWith(client, 'v1alpha', p.metadata, deadline())
    }
    if (!files.length) throw new Fault('NOT_FOUND', 'The server lists no services through reflection.')
    return descriptorFromFiles(files)
  } catch (err) {
    if (err instanceof ReflectionError) {
      const name = STATUS_NAMES[err.code] ?? String(err.code)
      const what =
        err.code === grpc.status.UNIMPLEMENTED
          ? 'The server does not offer server reflection (tried grpc.reflection.v1 and v1alpha). Import the .proto files instead.'
          : `Server reflection failed with ${name}: ${err.message}`
      const hint = err.code === grpc.status.UNIMPLEMENTED ? undefined : statusHint(err.code, { target: p.target.target, path: 'server reflection', tls: p.target.tls, deadlineMs: o.timeoutMs })
      throw new Fault(err.code === grpc.status.UNAVAILABLE ? 'NETWORK' : err.code === grpc.status.DEADLINE_EXCEEDED ? 'TIMEOUT' : err.code === grpc.status.UNAUTHENTICATED ? 'AUTH_FAILED' : 'INVALID_ARGUMENT', masker.mask(`${what}${hint ? ` ${hint}` : ''}`))
    }
    throw err
  } finally {
    client.close()
  }
}
