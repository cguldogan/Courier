/**
 * gRPC requests in the engine (CourierCore, no Electron) against a local @grpc/grpc-js server
 * (tests/fixtures/realtime-servers.mjs): reflection v1 / v1alpha, .proto import with import
 * directories and well-known types, all four call types, metadata, deadlines, error statuses, TLS,
 * JSON validation, example messages, masking and hostile service definitions.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CourierCore } from '../src/main/core'
import { descriptorFromFiles, normalizeProtoJson, type FileDescriptor } from '../src/main/realtime/protos'
import type { CourierEvents } from '../src/shared/api'
import { MASK } from '../src/shared/variables'
import { newGrpcRequest, type Auth, type GrpcDescriptor, type GrpcEvent, type GrpcRequestDef } from '../src/shared/types'
import { ECHO_PROTO, PROTO_ROOT, startGrpcServer, type GrpcTestServer } from './fixtures/realtime-servers.mjs'
import { ID_A, cleanupTempDirs, mockVault, tempDir } from './helpers'

const SECRET = 'grpc-Vault-S3cret-7d21'
let vault: Awaited<ReturnType<typeof mockVault>>
let plain: GrpcTestServer
let v1alpha: GrpcTestServer
let noReflection: GrpcTestServer
let tls: GrpcTestServer
let untrustedTls: GrpcTestServer
let untrustedCertPath = ''

beforeAll(async () => {
  vault = await mockVault({ 'grpc-token': SECRET })
  plain = await startGrpcServer()
  v1alpha = await startGrpcServer({ reflection: 'v1alpha' })
  noReflection = await startGrpcServer({ reflection: 'none' })
  tls = await startGrpcServer({ tls: { cert: readFileSync(process.env.COURIER_TEST_CERT as string), key: readFileSync(process.env.COURIER_TEST_KEY as string) } })
  const dir = tempDir('courier-grpc-pki-')
  untrustedCertPath = join(dir, 'c.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', untrustedCertPath, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' })
  untrustedTls = await startGrpcServer({ tls: { cert: readFileSync(untrustedCertPath), key: readFileSync(join(dir, 'k.pem')) } })
})
afterAll(async () => {
  for (const s of [plain, v1alpha, noReflection, tls, untrustedTls]) await s.stop()
  await vault.close()
  cleanupTempDirs()
})

interface Harness {
  core: CourierCore
  events: GrpcEvent[]
  collectionId: string
  save(req: GrpcRequestDef): Promise<GrpcRequestDef>
  /** Invokes and waits for the end event. */
  run(req: GrpcRequestDef, callId?: string): Promise<{ messages: string[]; end: Extract<GrpcEvent, { type: 'end' }>; all: GrpcEvent[] }>
  waitEnd(callId: string): Promise<Extract<GrpcEvent, { type: 'end' }>>
  messages(callId: string, direction?: 'in' | 'out'): string[]
}

let descriptorCache: GrpcDescriptor | null = null

async function harness(opts: { auth?: Auth; variables?: { key: string; value: string }[] } = {}): Promise<Harness> {
  const events: GrpcEvent[] = []
  const core = new CourierCore({
    userDataDir: tempDir('courier-grpc-ud-'),
    fakeIdentity: ID_A,
    keyVaultInsecureChallenge: true,
    emit: <E extends keyof CourierEvents>(event: E, payload: CourierEvents[E]) => {
      if (event === 'grpc:event') events.push(payload as GrpcEvent)
    }
  })
  await core.init()
  await core.updateSettings({ keyVault: { vaults: [{ alias: 'main', url: vault.url }], cacheTtlSeconds: 300 } })
  await core.signIn({ mode: 'azure-cli' })
  const { collection } = await core.createCollection({ name: 'RPC' })
  await core.saveCollection({ ...collection, auth: opts.auth ?? { type: 'none' }, variables: (opts.variables ?? []).map((v) => ({ ...v, enabled: true, type: 'default' as const })) })
  const waitEnd = async (callId: string): Promise<Extract<GrpcEvent, { type: 'end' }>> => {
    const end = Date.now() + 10_000
    for (;;) {
      const e = events.find((x): x is Extract<GrpcEvent, { type: 'end' }> => x.callId === callId && x.type === 'end')
      if (e) return e
      if (Date.now() > end) throw new Error(`no end event for ${callId}: ${JSON.stringify(events.filter((x) => x.callId === callId))}`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  const messages = (callId: string, direction?: 'in' | 'out'): string[] =>
    events.filter((e): e is Extract<GrpcEvent, { type: 'message' }> => e.callId === callId && e.type === 'message' && (!direction || e.entry.direction === direction)).map((e) => e.entry.text ?? '')
  const h: Harness = {
    core,
    events,
    collectionId: collection.id,
    async save(req) {
      await core.upsertItem({ collectionId: collection.id, item: req })
      return req
    },
    async run(req, callId = `g${Math.random().toString(36).slice(2, 10)}`) {
      await h.save(req)
      await core.grpcInvoke({ collectionId: collection.id, requestId: req.id, callId }, 3)
      const end = await waitEnd(callId)
      return { messages: messages(callId, 'in'), end, all: events.filter((e) => e.callId === callId) }
    },
    waitEnd,
    messages
  }
  return h
}

async function echoDescriptor(core: CourierCore): Promise<GrpcDescriptor> {
  if (descriptorCache) return descriptorCache
  core.allowProtoPath(ECHO_PROTO)
  core.allowProtoPath(PROTO_ROOT)
  descriptorCache = await core.grpcLoadProtos({ files: [ECHO_PROTO], importDirs: [PROTO_ROOT] })
  return descriptorCache
}

async function echoReq(core: CourierCore, partial: Partial<GrpcRequestDef>): Promise<GrpcRequestDef> {
  return newGrpcRequest({ address: plain.address, service: 'courier.test.v1.Echo', descriptor: await echoDescriptor(core), ...partial })
}

describe('service definitions', () => {
  it('loads services through server reflection v1 (reflection services themselves are left out)', async () => {
    const h = await harness()
    const req = await h.save(newGrpcRequest({ address: plain.address }))
    const d = await h.core.grpcReflect({ collectionId: h.collectionId, requestId: req.id })
    expect(d.source).toBe('reflection')
    const services = h.core.grpcDescribe({ descriptor: d })
    expect(services.map((s) => s.name)).toEqual(['courier.test.v1.Echo'])
    expect(services[0].methods.map((m) => `${m.method}:${m.callType}`)).toEqual(['Say:unary', 'Count:server-stream', 'Sum:client-stream', 'Chat:bidi', 'Fail:unary', 'Slow:unary', 'Metadata:unary'])
    expect(plain.calls.some((c) => c.name === 'Say')).toBe(false)
  })

  it('falls back to reflection v1alpha, and says clearly when a server has no reflection', async () => {
    const h = await harness()
    const a = await h.save(newGrpcRequest({ address: `grpc://${v1alpha.address}` }))
    const d = await h.core.grpcReflect({ collectionId: h.collectionId, requestId: a.id })
    expect(h.core.grpcDescribe({ descriptor: d })[0].methods).toHaveLength(7)
    const b = await h.save(newGrpcRequest({ address: noReflection.address }))
    await expect(h.core.grpcReflect({ collectionId: h.collectionId, requestId: b.id })).rejects.toThrow(/does not offer server reflection \(tried grpc\.reflection\.v1 and v1alpha\)/)
  })

  it('a reflected definition and an imported one encode a complex message identically', async () => {
    const h = await harness()
    const reflected = await h.core.grpcReflect({ draft: newGrpcRequest({ address: plain.address }) })
    const imported = await echoDescriptor(h.core)
    const msg = JSON.stringify({ text: 'hi', counters: { a: '5' }, groupId: '9007199254740993', ttl: '1.5s', urgent: false, nickname: 'n', extra: { k: [1, 'x', null] } })
    const run = async (descriptor: GrpcDescriptor): Promise<string> => {
      const r = await h.run(newGrpcRequest({ address: plain.address, service: 'courier.test.v1.Echo', method: 'Say', descriptor, message: msg }))
      expect(r.end.status.name).toBe('OK')
      return r.messages[0]
    }
    expect(await run(reflected)).toBe(await run(imported))
  })

  it('imports .proto files: imports resolve in the chosen import directories; well-known types are bundled', async () => {
    const h = await harness()
    h.core.allowProtoPath(ECHO_PROTO)
    await expect(h.core.grpcLoadProtos({ files: [ECHO_PROTO], importDirs: [] })).rejects.toThrow(/import "courier\/test\/v1\/common.proto" was not found/)
    h.core.allowProtoPath(PROTO_ROOT)
    const d = await h.core.grpcLoadProtos({ files: [ECHO_PROTO], importDirs: [PROTO_ROOT] })
    expect(d.source).toBe('proto')
    expect(d.files).toEqual(['courier/test/v1/echo.proto', 'courier/test/v1/common.proto'])
    expect(JSON.stringify(d)).not.toContain(PROTO_ROOT)
    expect(d.json).toContain('"Timestamp"')
  })

  it('reads nothing outside the picked directories and only files picked with the dialog', async () => {
    const h = await harness()
    const dir = tempDir('courier-proto-')
    const outside = tempDir('courier-outside-')
    writeFileSync(join(outside, 'secret.proto'), 'syntax = "proto3"; message Secret { string s = 1; }')
    writeFileSync(join(dir, 'up.proto'), 'syntax = "proto3"; import "../secret.proto"; service S { rpc M(Secret) returns (Secret); }')
    mkdirSync(join(dir, 'sub'))
    symlinkSync(join(outside, 'secret.proto'), join(dir, 'sub', 'link.proto'))
    writeFileSync(join(dir, 'link.proto'), 'syntax = "proto3"; import "sub/link.proto"; service S { rpc M(Secret) returns (Secret); }')
    for (const f of ['up.proto', 'link.proto']) h.core.allowProtoPath(join(dir, f))
    await expect(h.core.grpcLoadProtos({ files: [join(dir, 'up.proto')], importDirs: [] })).rejects.toThrow(/must be a relative path inside an import directory/)
    await expect(h.core.grpcLoadProtos({ files: [join(dir, 'link.proto')], importDirs: [] })).rejects.toThrow(/was not found in the import directories/)
    await expect(h.core.grpcLoadProtos({ files: [join(outside, 'secret.proto')], importDirs: [] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('rebuilds untrusted definitions from a whitelist (no __proto__, no odd names, no options with code)', () => {
    const ok = normalizeProtoJson({
      nested: { p: { nested: { M: { fields: { a: { type: 'string', id: 1, options: { default: 'x', '(evil)': 'require("child_process")' } } }, options: { foo: 1 } } } } }
    })
    expect(ok).toEqual({ nested: { p: { nested: { M: { fields: { a: { type: 'string', id: 1 } } } } } } })
    const nested = (name: string): unknown => ({ nested: { p: { nested: { M: { fields: { [name]: { type: 'string', id: 1 } } } } } } })
    expect(() => normalizeProtoJson(JSON.parse('{"nested":{"__proto__":{"nested":{}}}}'))).toThrow(/invalid definition name/)
    expect(() => normalizeProtoJson(nested('constructor'))).toThrow(/invalid field/)
    expect(() => normalizeProtoJson(nested('a-b'))).toThrow(/invalid field/)
    expect(() => normalizeProtoJson({ nested: { p: { nested: { M: { fields: { a: { type: 'x"]);process.exit(1);//', id: 1 } } } } } } })).toThrow(/invalid type reference/)
    expect(() => normalizeProtoJson({ nested: { p: { nested: { M: { fields: { a: { type: 'string', id: 0 } } } } } } })).toThrow(/invalid number/)
    const wide: Record<string, unknown> = {}
    for (let i = 0; i < 60_000; i++) wide[`M${i}`] = { fields: {} }
    expect(() => normalizeProtoJson({ nested: wide })).toThrow(/too large/)
  })

  it('converts protoc-style descriptors (fully-qualified map entries, proto3 optional, oneofs, nested enums, proto2)', async () => {
    const files: FileDescriptor[] = [
      {
        name: 'shop/v1/shop.proto',
        package: 'shop.v1',
        dependency: ['google/protobuf/timestamp.proto'],
        syntax: 'proto3',
        enumType: [],
        messageType: [
          {
            name: 'Order',
            field: [
              { name: 'labels', number: 1, label: 3, type: 11, typeName: '.shop.v1.Order.LabelsEntry', jsonName: 'labels' },
              { name: 'note', number: 2, label: 1, type: 9, jsonName: 'note', oneofIndex: 0, proto3Optional: true },
              { name: 'sku', number: 3, label: 1, type: 9, jsonName: 'sku', oneofIndex: 1 },
              { name: 'gift_id', number: 4, label: 1, type: 3, jsonName: 'giftId', oneofIndex: 1 },
              { name: 'state', number: 5, label: 1, type: 14, typeName: '.shop.v1.Order.State', jsonName: 'state' },
              { name: 'at', number: 6, label: 1, type: 11, typeName: '.google.protobuf.Timestamp', jsonName: 'at' },
              { name: 'qty', number: 7, label: 3, type: 5, jsonName: 'qty' }
            ],
            nestedType: [{ name: 'LabelsEntry', field: [{ name: 'key', number: 1, label: 1, type: 9 }, { name: 'value', number: 2, label: 1, type: 3 }], nestedType: [], enumType: [], oneofDecl: [], options: { mapEntry: true } }],
            enumType: [{ name: 'State', value: [{ name: 'NEW', number: 0 }, { name: 'PAID', number: 1 }] }],
            oneofDecl: [{ name: '_note' }, { name: 'item' }]
          }
        ],
        service: [{ name: 'Shop', method: [{ name: 'Place', inputType: '.shop.v1.Order', outputType: '.shop.v1.Order', serverStreaming: true }] }]
      },
      { name: 'legacy.proto', package: 'legacy', dependency: [], syntax: 'proto2', enumType: [], service: [], messageType: [{ name: 'Old', field: [{ name: 'must', number: 1, label: 2, type: 5 }], nestedType: [], enumType: [], oneofDecl: [] }] }
    ]
    const d = descriptorFromFiles(files)
    const h = await harness()
    expect(h.core.grpcDescribe({ descriptor: d })).toEqual([{ name: 'shop.v1.Shop', methods: [{ service: 'shop.v1.Shop', method: 'Place', path: '/shop.v1.Shop/Place', requestType: 'shop.v1.Order', responseType: 'shop.v1.Order', callType: 'server-stream' }] }])
    const json = JSON.parse(d.json)
    const order = json.nested.shop.nested.v1.nested.Order
    expect(order.fields.labels).toEqual({ type: 'int64', id: 1, keyType: 'string' })
    expect(order.fields.note.options).toEqual({ proto3_optional: true })
    expect(order.oneofs).toEqual({ _note: { oneof: ['note'] }, item: { oneof: ['sku', 'gift_id'] } })
    expect(order.nested.LabelsEntry).toBeUndefined()
    expect(json.nested.legacy.nested.Old).toEqual({ fields: { must: { type: 'int32', id: 1, rule: 'required' } }, edition: 'proto2' })
    const ex = JSON.parse(h.core.grpcExample({ descriptor: d, service: 'shop.v1.Shop', method: 'Place' }))
    expect(ex).toMatchObject({ labels: { key: '0' }, note: '', sku: '', state: 'NEW', qty: [0] })
    expect(ex.giftId).toBeUndefined()
  })

  it('a stored definition that does not parse or resolve fails clearly', async () => {
    const h = await harness()
    expect(() => h.core.grpcDescribe({ descriptor: { source: 'proto', files: [], loadedAt: '', json: '{not json' } })).toThrow(/not valid JSON/)
    expect(() => h.core.grpcDescribe({ descriptor: { source: 'proto', files: [], loadedAt: '', json: JSON.stringify({ nested: { S: { methods: { M: { requestType: 'Nope', responseType: 'Nope' } } } } }) } })).toThrow(/incomplete/)
  })
})

describe('calls', () => {
  it('unary with nested messages, enums, repeated, maps, oneof and well-known types (proto3 JSON both ways)', async () => {
    const h = await harness()
    const message = JSON.stringify({
      text: 'hi',
      times: 2,
      mood: 'HAPPY',
      tags: ['a', 'b'],
      counters: { x: '9007199254740993' },
      address: { street: 'Main', city: 'Town', kind: 'WORK' },
      user: 'u1',
      sentAt: '2025-01-31T12:00:00.250Z',
      ttl: '90s',
      extra: { nested: { list: [1, true, null] } },
      nickname: 'nick',
      urgent: false,
      payload: Buffer.from('bytes!').toString('base64'),
      history: [{ city: 'Old' }],
      tree: { name: 'root', children: [{ name: 'leaf' }] }
    })
    const r = await h.run(await echoReq(h.core, { method: 'Say', message }))
    expect(r.end.status).toMatchObject({ code: 0, name: 'OK' })
    const reply = JSON.parse(r.messages[0])
    expect(reply.text).toBe('hihi')
    expect(reply.at).toBe('2023-11-14T22:13:20.005Z')
    expect(reply.echo).toMatchObject({
      text: 'hi',
      mood: 'HAPPY',
      tags: ['a', 'b'],
      counters: { x: '9007199254740993' },
      address: { street: 'Main', city: 'Town', kind: 'WORK' },
      user: 'u1',
      sentAt: '2025-01-31T12:00:00.250Z',
      ttl: '90s',
      extra: { nested: { list: [1, true, null] } },
      nickname: 'nick',
      urgent: false,
      payload: Buffer.from('bytes!').toString('base64'),
      history: [{ street: '', city: 'Old', kind: 'HOME' }],
      tree: { name: 'root', children: [{ name: 'leaf', children: [] }] }
    })
    expect(reply.echo.groupId).toBeUndefined()
    expect(r.end.durationMs).toBeGreaterThanOrEqual(0)
    expect(r.all.find((e) => e.type === 'started')).toMatchObject({ callType: 'unary', path: '/courier.test.v1.Echo/Say', tls: false })
  })

  it('metadata, inherited auth and Key Vault values reach the server; everything shown is masked', async () => {
    const h = await harness({ auth: { type: 'bearer', token: '{{vault:grpc-token}}' }, variables: [{ key: 'tenant', value: 'contoso' }] })
    const req = await echoReq(h.core, {
      method: 'Metadata',
      metadata: [
        { key: 'x-tenant', value: '{{tenant}}', enabled: true },
        { key: 'x-key', value: '{{vault:grpc-token}}', enabled: true },
        { key: 'x-off', value: 'no', enabled: false }
      ]
    })
    const r = await h.run(req)
    const seen = plain.calls.filter((c) => c.name === 'Metadata').at(-1)!.metadata
    expect(seen['x-tenant']).toBe('contoso')
    expect(seen['x-key']).toBe(SECRET)
    expect(seen.authorization).toBe(`Bearer ${SECRET}`)
    expect(seen['x-off']).toBeUndefined()
    const started = r.all.find((e) => e.type === 'started') as Extract<GrpcEvent, { type: 'started' }>
    expect(started.requestMetadata).toEqual(expect.arrayContaining([['x-tenant', 'contoso'], ['x-key', MASK], ['authorization', `Bearer ${MASK}`]]))
    expect(r.all.find((e) => e.type === 'headers')).toMatchObject({ metadata: expect.arrayContaining([['x-server', 'courier-test']]) })
    expect(r.end.trailers).toEqual(expect.arrayContaining([['x-trailer', 'done']]))
    // The server echoes the metadata back in the reply: masked there too.
    expect(JSON.parse(r.messages[0]).metadata).toMatchObject({ 'x-key': MASK, authorization: `Bearer ${MASK}` })
    expect(JSON.stringify(h.events)).not.toContain(SECRET)
  })

  it('variables and Key Vault values in the message JSON resolve in main and are masked in the log', async () => {
    const h = await harness({ variables: [{ key: 'who', value: 'world' }] })
    const r = await h.run(await echoReq(h.core, { method: 'Say', message: '{"text":"{{who}}-{{vault:grpc-token}}"}' }))
    expect(JSON.parse(r.messages[0]).text).toBe(`world-${MASK}`)
    expect(h.messages(r.all[0].callId, 'out')[0]).toContain(`"world-${MASK}"`)
    expect(JSON.stringify(h.events)).not.toContain(SECRET)
  })

  it('server streaming: messages arrive in order as they come', async () => {
    const h = await harness()
    const r = await h.run(await echoReq(h.core, { method: 'Count', message: '{"from":1,"to":5,"delayMs":5}' }))
    expect(r.end.status.name).toBe('OK')
    expect(r.messages.map((m) => JSON.parse(m).value)).toEqual(['1', '2', '3', '4', '5'])
    const ins = r.all.filter((e): e is Extract<GrpcEvent, { type: 'message' }> => e.type === 'message' && e.entry.direction === 'in')
    expect(ins.map((e) => e.entry.seq)).toEqual([...ins.map((e) => e.entry.seq)].sort((a, b) => a - b))
  })

  it('client streaming: send messages one by one, then end the stream', async () => {
    const h = await harness()
    const req = await h.save(await echoReq(h.core, { method: 'Sum' }))
    await h.core.grpcInvoke({ collectionId: h.collectionId, requestId: req.id, callId: 'sum1' })
    for (const v of ['1', '2', '39']) await h.core.grpcSend({ callId: 'sum1', message: `{"value":"${v}"}` })
    await expect(h.core.grpcSend({ callId: 'sum1', message: '{"valu":1}' })).rejects.toThrow(/Field "valu": courier.test.v1.Number has no field "valu"/)
    expect(h.core.grpcEnd('sum1')).toBe(true)
    const end = await h.waitEnd('sum1')
    expect(end.status.name).toBe('OK')
    expect(JSON.parse(h.messages('sum1', 'in')[0])).toEqual({ total: '42', count: 3 })
  })

  it('bidirectional streaming: exchange messages, end, and cancel', async () => {
    const h = await harness()
    const req = await h.save(await echoReq(h.core, { method: 'Chat' }))
    await h.core.grpcInvoke({ collectionId: h.collectionId, requestId: req.id, callId: 'chat1' })
    await h.core.grpcSend({ callId: 'chat1', message: '{"text":"one"}' })
    await h.core.grpcSend({ callId: 'chat1', message: '{"text":"two"}' })
    const deadline = Date.now() + 5000
    while (h.messages('chat1', 'in').length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    expect(h.messages('chat1', 'in').map((m) => JSON.parse(m).text)).toEqual(['echo: one', 'echo: two'])
    h.core.grpcEnd('chat1')
    expect((await h.waitEnd('chat1')).status.name).toBe('OK')
    await h.core.grpcInvoke({ collectionId: h.collectionId, requestId: req.id, callId: 'chat2' })
    expect(h.core.grpcCancel('chat2')).toBe(true)
    expect((await h.waitEnd('chat2')).status.name).toBe('CANCELLED')
    await expect(h.core.grpcSend({ callId: 'chat2', message: '{}' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('deadline exceeded, unauthenticated, unimplemented and unavailable get clear statuses and hints', async () => {
    const h = await harness()
    const slow = await h.run(await echoReq(h.core, { method: 'Slow', message: '{"delayMs":2000}', settings: { deadlineMs: 150 } }))
    expect(slow.end.status.name).toBe('DEADLINE_EXCEEDED')
    expect(slow.end.hint).toMatch(/deadline \(150 ms\)/)
    const unauth = await h.run(await echoReq(h.core, { method: 'Fail', message: '{"code":16,"message":"token expired"}' }))
    expect(unauth.end.status).toEqual({ code: 16, name: 'UNAUTHENTICATED', details: 'token expired' })
    expect(unauth.end.hint).toMatch(/Authorization tab/)
    // A service the server does not implement (from an extra .proto file).
    const dir = tempDir('courier-proto-missing-')
    writeFileSync(join(dir, 'missing.proto'), 'syntax = "proto3"; package courier.test.v1; import "google/protobuf/empty.proto"; service Missing { rpc Nope(google.protobuf.Empty) returns (google.protobuf.Empty); }')
    h.core.allowProtoPath(join(dir, 'missing.proto'))
    const missing = await h.core.grpcLoadProtos({ files: [join(dir, 'missing.proto')], importDirs: [] })
    const unimpl = await h.run(newGrpcRequest({ address: plain.address, descriptor: missing, service: 'courier.test.v1.Missing', method: 'Nope' }))
    expect(unimpl.end.status.name).toBe('UNIMPLEMENTED')
    expect(unimpl.end.hint).toMatch(/does not implement \/courier\.test\.v1\.Missing\/Nope/)
    const down = await h.run(await echoReq(h.core, { address: '127.0.0.1:1', method: 'Say', settings: { deadlineMs: 3000 } }))
    expect(down.end.status.name).toBe('UNAVAILABLE')
    expect(down.end.hint).toMatch(/server at 127\.0\.0\.1:1 could not be reached/)
  })

  it('JSON that does not match the message type names the offending field; nothing is sent', async () => {
    const h = await harness()
    const before = plain.calls.length
    const bad = async (message: string): Promise<string> => {
      const req = await h.save(await echoReq(h.core, { method: 'Say', message }))
      return h.core.grpcInvoke({ collectionId: h.collectionId, requestId: req.id, callId: `bad${Math.random().toString(36).slice(2, 8)}` }).then(
        () => 'sent',
        (e: Error) => e.message
      )
    }
    expect(await bad('{"txt":"x"}')).toMatch(/^Field "txt": courier\.test\.v1\.SayRequest has no field "txt" \(fields: text, times, mood/)
    expect(await bad('{"times":"many"}')).toMatch(/Field "times": expected an integer \(int32\), got "many"/)
    expect(await bad('{"address":{"cty":"x"}}')).toMatch(/Field "address\.cty": courier\.test\.v1\.Address has no field "cty"/)
    expect(await bad('{"mood":"SAD"}')).toMatch(/Field "mood": "SAD" is not a value of enum courier\.test\.v1\.Mood \(MOOD_UNSPECIFIED, HAPPY, GRUMPY\)/)
    expect(await bad('{"user":"a","groupId":"1"}')).toMatch(/Field "groupId": only one of "user", "group_id" may be set/)
    expect(await bad('{"history":[{"city":1}]}')).toMatch(/Field "history\[0\]\.city": expected a string, got 1/)
    expect(await bad('{"sentAt":"yesterday"}')).toMatch(/Field "sentAt": expected an RFC 3339 timestamp/)
    expect(await bad('{"counters":{"a":"x"}}')).toMatch(/Field "counters\["a"\]": expected an integer/)
    expect(await bad('{"times": 2147483648}')).toMatch(/out of range for int32/)
    expect(await bad('{not json')).toMatch(/The message is not valid JSON/)
    expect(plain.calls.length).toBe(before)
  })

  it('generates an example message that is valid for the method', async () => {
    const h = await harness()
    const d = await echoDescriptor(h.core)
    const ex = JSON.parse(h.core.grpcExample({ descriptor: d, service: 'courier.test.v1.Echo', method: 'Say' }))
    expect(Object.keys(ex)).toEqual(['text', 'times', 'mood', 'tags', 'counters', 'address', 'user', 'sentAt', 'ttl', 'extra', 'nickname', 'urgent', 'payload', 'history', 'tree'])
    expect(ex).toMatchObject({ text: '', times: 0, mood: 'MOOD_UNSPECIFIED', tags: [''], counters: { key: '0' }, address: { street: '', city: '', kind: 'HOME' }, user: '', ttl: '1s', extra: {}, nickname: '', urgent: false, history: [{ kind: 'HOME' }], tree: { name: '' } })
    expect(ex.sentAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    expect(ex.tree.children).toEqual([])
    const r = await h.run(await echoReq(h.core, { method: 'Say', message: JSON.stringify(ex) }))
    expect(r.end.status.name).toBe('OK')
  })

  it('TLS: trusted certificate; untrusted fails unless verification is off or its CA is chosen', async () => {
    const h = await harness()
    expect((await h.run(await echoReq(h.core, { address: `grpcs://${tls.address}`, method: 'Say', message: '{"text":"tls"}' }))).end.status.name).toBe('OK')
    const req = await echoReq(h.core, { address: untrustedTls.address, tls: true, method: 'Say', message: '{"text":"x"}', settings: { deadlineMs: 3000 } })
    const fail = await h.run(req)
    expect(fail.end.status.name).toBe('UNAVAILABLE')
    expect((await h.run({ ...req, settings: { ...req.settings, verifyTls: false } })).end.status.name).toBe('OK')
    await h.core.setGrpcTlsFile(req.id, 'ca', untrustedCertPath)
    expect(await h.core.grpcTlsFiles(req.id)).toEqual({ ca: { path: untrustedCertPath, name: 'c.pem' } })
    expect((await h.run(req)).end.status.name).toBe('OK')
    // The path stays on this machine: it is not in the request or the collection document.
    const col = (await h.core.load()).collections.find((c) => c.collection.id === h.collectionId)!
    expect(JSON.stringify(col)).not.toContain(untrustedCertPath)
    await h.core.setGrpcTlsFile(req.id, 'ca', null)
    expect(await h.core.grpcTlsFiles(req.id)).toEqual({})
  })

  it('Digest, NTLM and AWS Signature report that they are not supported for gRPC', async () => {
    const h = await harness({ auth: { type: 'awsv4', accessKey: 'a', secretKey: 'b', sessionToken: '', region: '', service: 'x', addTo: 'header' } })
    const req = await h.save(await echoReq(h.core, { method: 'Say' }))
    await expect(h.core.grpcInvoke({ collectionId: h.collectionId, requestId: req.id, callId: 'aws1' })).rejects.toThrow(/AWS Signature authorization is not supported for gRPC/)
  })

  it('API key and JWT become metadata (even when set to "query")', async () => {
    const h = await harness({ auth: { type: 'apikey', key: 'X-Api-Key', value: 'k-123', in: 'query' } })
    await h.run(await echoReq(h.core, { method: 'Metadata' }))
    expect(plain.calls.filter((c) => c.name === 'Metadata').at(-1)!.metadata['x-api-key']).toBe('k-123')
    const jwt: Auth = { type: 'jwt', algorithm: 'HS256', secret: 'jwt-secret-for-test', secretBase64: false, payload: '{"sub":"grpc"}', header: '', addTo: 'query', headerPrefix: 'Bearer', queryParamKey: 'token' }
    const r = await h.run(await echoReq(h.core, { method: 'Metadata', auth: jwt }))
    const sent = String(plain.calls.filter((c) => c.name === 'Metadata').at(-1)!.metadata.authorization)
    expect(sent).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    expect(JSON.parse(Buffer.from(sent.split('.')[1], 'base64url').toString('utf8'))).toMatchObject({ sub: 'grpc' })
    // The signed token is masked in what the window sees.
    expect((r.all.find((e) => e.type === 'started') as Extract<GrpcEvent, { type: 'started' }>).requestMetadata).toContainEqual(['authorization', `Bearer ${MASK}`])
  })

  it('closing a window cancels its running calls', async () => {
    const h = await harness()
    const req = await h.save(await echoReq(h.core, { method: 'Chat' }))
    await h.core.grpcInvoke({ collectionId: h.collectionId, requestId: req.id, callId: 'w-chat' }, 9)
    expect(h.core.grpcCalls.size).toBe(1)
    h.core.closeRealtime(9)
    expect(h.core.grpcCalls.size).toBe(0)
  })
})
