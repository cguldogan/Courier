/**
 * WebSocket / gRPC items as collection data: canonical serialisation (existing HTTP-only files stay
 * byte-identical), the secret scan, what HTTP-only features leave out (runner, command line, Postman
 * export, snippets), and the stored gRPC service definition surviving save/load and team sync.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeCredential } from '../src/main/azure'
import { createContainerClient } from '../src/main/blobsync'
import { CourierCore } from '../src/main/core'
import { scanCollection } from '../src/main/secrets-scan'
import { exportPostmanCollection } from '../src/shared/postman'
import { decodeBinaryInput, parseGrpcAddress } from '../src/shared/realtime'
import { normalizeCollection, normalizeItem, serializeCollection } from '../src/shared/serialize'
import { newCollection, newFolder, newGrpcRequest, newRequest, newWebSocketRequest, type Collection, type GrpcDescriptor, type GrpcRequestDef, type RunSummary, type WebSocketRequestDef } from '../src/shared/types'
import { runCli } from './cli-helpers'
import { ECHO_PROTO, PROTO_ROOT, startGrpcServer, startWsServer, type GrpcTestServer, type WsTestServer } from './fixtures/realtime-servers.mjs'
import { ID_A, ID_B, cleanupTempDirs, echoServer, makeCore, mockVault, seedManifest, teamClient, tempDir } from './helpers'

let echo: Awaited<ReturnType<typeof echoServer>>
let grpcSrv: GrpcTestServer
let wsSrv: WsTestServer
let descriptor: GrpcDescriptor

beforeAll(async () => {
  echo = await echoServer()
  grpcSrv = await startGrpcServer()
  wsSrv = await startWsServer()
  const core = await makeCore()
  core.allowProtoPath(ECHO_PROTO)
  core.allowProtoPath(PROTO_ROOT)
  descriptor = await core.grpcLoadProtos({ files: [ECHO_PROTO], importDirs: [PROTO_ROOT] })
})
afterAll(async () => {
  await echo.close()
  await grpcSrv.stop()
  await wsSrv.stop()
  cleanupTempDirs()
})

function wsItem(partial: Partial<WebSocketRequestDef> = {}): WebSocketRequestDef {
  return newWebSocketRequest({
    id: 'ws-1',
    name: 'Live feed',
    url: 'wss://example.test/feed',
    params: [{ key: 'room', value: '{{room}}', enabled: true }],
    headers: [{ key: 'X-Trace', value: '1', enabled: false, description: 'off' }],
    subprotocols: ['v2.chat', 'json'],
    message: { kind: 'text', format: 'json', body: '{"hello":1}' },
    savedMessages: [
      { id: 'm1', name: 'Hello', kind: 'text', format: 'json', body: '{"hi":true}' },
      { id: 'm2', name: 'Bytes', kind: 'binary', format: 'hex', body: 'de ad' }
    ],
    settings: { verifyTls: false, maxMessageBytes: 4096, autoReconnect: true },
    ...partial
  })
}

function grpcItem(partial: Partial<GrpcRequestDef> = {}): GrpcRequestDef {
  return newGrpcRequest({
    id: 'grpc-1',
    name: 'Say hello',
    address: '{{grpcHost}}',
    tls: true,
    metadata: [{ key: 'x-tenant', value: 'contoso', enabled: true }],
    service: 'courier.test.v1.Echo',
    method: 'Say',
    message: '{"text":"hi"}',
    descriptor,
    settings: { deadlineMs: 5000 },
    ...partial
  })
}

describe('canonical format', () => {
  it('existing HTTP-only collection files (written before WebSocket/gRPC existed) re-serialise byte-identically', () => {
    const dir = join(__dirname, 'fixtures/userdata-v1/data/collections')
    const files = readdirSync(dir)
    expect(files.length).toBeGreaterThan(3)
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8')
      expect(serializeCollection(normalizeCollection(JSON.parse(text))), f).toBe(text)
    }
  })

  it('WebSocket and gRPC items round-trip with a fixed key order', () => {
    const c = newCollection({ id: 'c2', name: 'Mixed', items: [wsItem(), newFolder({ id: 'f', name: 'RPC', items: [grpcItem()] })] })
    const text = serializeCollection(c)
    expect(serializeCollection(normalizeCollection(JSON.parse(text)))).toBe(text)
    const doc = JSON.parse(text)
    expect(Object.keys(doc.items[0])).toEqual(['type', 'id', 'name', 'description', 'url', 'params', 'headers', 'subprotocols', 'auth', 'message', 'savedMessages', 'settings'])
    expect(Object.keys(doc.items[1].items[0])).toEqual(['type', 'id', 'name', 'description', 'address', 'tls', 'metadata', 'auth', 'service', 'method', 'message', 'descriptor', 'settings'])
    expect(doc.items[1].items[0].descriptor.json).toBe(descriptor.json)
  })

  it('normalises hostile or broken items defensively', () => {
    const ws = normalizeItem({ type: 'websocket', id: '../x', url: 5, subprotocols: ['ok', 'bad proto', 7], message: { kind: 'binary', format: 'json' }, savedMessages: [{ id: 'a' }, { id: 'a' }], settings: { maxMessageBytes: -1, handshakeTimeoutMs: 1e12 } }) as WebSocketRequestDef
    expect(ws.type).toBe('websocket')
    expect(ws.id).not.toBe('../x')
    expect(ws.url).toBe('5')
    expect(ws.subprotocols).toEqual(['ok', '7'])
    expect(ws.message).toEqual({ kind: 'binary', format: 'base64', body: '' })
    expect(new Set(ws.savedMessages.map((m) => m.id)).size).toBe(2)
    expect(ws.settings).toEqual({ handshakeTimeoutMs: 600_000 })
    const g = normalizeItem({ type: 'grpc', tls: 'yes', descriptor: { json: 'x'.repeat(5 * 1024 * 1024) } }) as GrpcRequestDef
    expect(g.tls).toBe(false)
    expect(g.descriptor).toBeNull()
  })

  it('parses gRPC addresses and binary composer input', () => {
    expect(parseGrpcAddress('localhost:50051', false)).toMatchObject({ target: 'localhost:50051', tls: false })
    expect(parseGrpcAddress('grpcs://api.test', false)).toMatchObject({ target: 'api.test:443', tls: true })
    expect(parseGrpcAddress('grpc://[::1]:9000', true)).toMatchObject({ target: '[::1]:9000', tls: false })
    expect(() => parseGrpcAddress('https://x/y', false)).toThrow(/not a server address/)
    expect(() => parseGrpcAddress('ftp://x', false)).toThrow(/Unsupported scheme/)
    expect([...decodeBinaryInput('0xDE AD', 'hex')]).toEqual([0xde, 0xad])
    expect([...decodeBinaryInput('AQID', 'base64')]).toEqual([1, 2, 3])
    expect(() => decodeBinaryInput('zz', 'hex')).toThrow(/Hex input/)
  })
})

describe('secret scan before a team upload', () => {
  it('flags literal credentials in WebSocket headers and auth, and in gRPC metadata', () => {
    const c = newCollection({
      name: 'Live',
      items: [
        wsItem({ headers: [{ key: 'Authorization', value: 'Bearer abc.def.ghi', enabled: true }, { key: 'X-Api-Key', value: '{{vault:key}}', enabled: true }] }),
        grpcItem({ metadata: [{ key: 'authorization', value: 'Bearer literal-token-123', enabled: true }, { key: 'x-tenant', value: 'contoso', enabled: true }], auth: { type: 'basic', username: 'u', password: 'pw-literal' } })
      ]
    })
    const f = scanCollection(c)
    expect(f.map((x) => [x.field, x.location])).toEqual([
      ['header', 'Live / Live feed › header "Authorization"'],
      ['basic.password', 'Live / Say hello › auth (basic password)'],
      ['metadata', 'Live / Say hello › metadata "authorization"']
    ])
  })
})

describe('HTTP-only features leave WebSocket and gRPC requests out, saying so', () => {
  const mixed = (): Collection =>
    newCollection({
      name: 'Mixed',
      items: [newRequest({ id: 'h1', name: 'Ping', url: `${echo.url}/ping` }), wsItem({ url: wsSrv.url }), newFolder({ id: 'fold', name: 'RPC', items: [grpcItem({ address: grpcSrv.address, tls: false })] })]
    })

  it('collection runner: runs the HTTP requests and lists the others', async () => {
    const events: [string, unknown][] = []
    const core = new CourierCore({ userDataDir: tempDir(), emit: (e, p) => events.push([e, p]) })
    await core.init()
    const { collection } = await core.createCollection({ name: 'Mixed' })
    await core.saveCollection({ ...mixed(), id: collection.id })
    await (await core.startRun({ collectionId: collection.id })).done
    const sum = events.find(([e]) => e === 'runner:finished')![1] as RunSummary
    expect(sum.results.map((r) => r.name)).toEqual(['Ping'])
    expect(sum.skipped).toEqual([
      { id: 'ws-1', name: 'Live feed', type: 'websocket', path: '' },
      { id: 'grpc-1', name: 'Say hello', type: 'grpc', path: 'RPC' }
    ])
    await expect(core.startRun({ collectionId: collection.id, folderId: 'fold' })).rejects.toThrow(
      /There are no HTTP requests to run\. 1 WebSocket\/gRPC request is not run by the collection runner: "RPC \/ Say hello" \(gRPC\)/
    )
  })

  it('command-line runner: warns and lists them in the JSON report', async () => {
    const dir = tempDir('courier-cli-rt-')
    const file = join(dir, 'mixed.courier.json')
    writeFileSync(file, serializeCollection(mixed()))
    const json = join(dir, 'report.json')
    const r = await runCli(['run', file, '--reporter-json-export', json])
    expect(r.code).toBe(0)
    expect(r.stderr).toMatch(/warning: 2 WebSocket\/gRPC requests are not run \(the runner only sends HTTP requests\): "Live feed" \(WebSocket\), "RPC \/ Say hello" \(gRPC\)\./)
    const report = JSON.parse(readFileSync(json, 'utf8'))
    expect(report.run.skipped).toEqual([
      { id: 'ws-1', name: 'Live feed', type: 'websocket', path: '' },
      { id: 'grpc-1', name: 'Say hello', type: 'grpc', path: 'RPC' }
    ])
    expect(report.executions.map((e: { name: string }) => e.name)).toEqual(['Ping'])
  })

  it('Postman export leaves them out and lists them; Courier export keeps them', async () => {
    const core = await makeCore()
    const { collection } = await core.createCollection({ name: 'Mixed' })
    await core.saveCollection({ ...mixed(), id: collection.id })
    const pm = await core.exportDoc('collection', collection.id, 'postman')
    expect(pm.skipped.map((s) => s.name)).toEqual(['Live feed', 'Say hello'])
    const doc = JSON.parse(pm.content)
    expect(doc.item.map((i: { name: string }) => i.name)).toEqual(['Ping', 'RPC'])
    expect(doc.item[1].item).toEqual([])
    expect(exportPostmanCollection(mixed()).item).toHaveLength(2)
    const own = await core.exportDoc('collection', collection.id, 'courier')
    expect(own.skipped).toEqual([])
    expect(JSON.parse(own.content).items).toHaveLength(3)
  })

  it('code snippets and Send refuse them with a clear message', async () => {
    const core = await makeCore()
    await expect(core.snippet({ draft: wsItem() as never, language: 'curl' })).rejects.toThrow(/Code snippets are only available for HTTP requests; WebSocket requests have none/)
    await expect(core.send({ draft: grpcItem() as never })).rejects.toThrow(/This is a gRPC request/)
  })
})

describe('stored with the collection', () => {
  it('survive save, reload from disk, duplicate, move and delete like HTTP requests', async () => {
    const ud = tempDir('courier-rt-ud-')
    const core = await makeCore({ userDataDir: ud })
    const { collection } = await core.createCollection({ name: 'Live' })
    const { collection: other } = await core.createCollection({ name: 'Other' })
    await core.upsertItem({ collectionId: collection.id, item: newFolder({ id: 'f1', name: 'F' }) })
    await core.upsertItem({ collectionId: collection.id, parentId: 'f1', item: wsItem() })
    await core.upsertItem({ collectionId: collection.id, item: grpcItem() })
    const again = await makeCore({ userDataDir: ud })
    const loaded = (await again.load()).collections.find((c) => c.collection.id === collection.id)!.collection
    const f = loaded.items.find((i) => i.type === 'folder')
    expect(f && f.type === 'folder' ? f.items[0] : null).toEqual(wsItem())
    expect(loaded.items.find((i) => i.type === 'grpc')).toEqual(grpcItem())
    // The reloaded definition still works (no files needed).
    expect(again.grpcDescribe({ descriptor: (loaded.items.find((i) => i.type === 'grpc') as GrpcRequestDef).descriptor! })[0].name).toBe('courier.test.v1.Echo')
    await again.moveItem({ collectionId: collection.id, itemId: 'ws-1', parentId: null, index: 0 })
    const dup = await again.duplicate('collection', collection.id)
    expect((dup.doc as Collection).items.map((i) => i.type)).toEqual(['websocket', 'folder', 'grpc'])
    expect((dup.doc as Collection).items.every((i) => !['ws-1', 'grpc-1', 'f1'].includes(i.id))).toBe(true)
    await again.upsertItem({ collectionId: other.id, item: grpcItem() })
    await again.deleteItem({ collectionId: collection.id, itemId: 'grpc-1' })
    const after = (await again.load()).collections
    expect(after.find((c) => c.collection.id === other.id)!.collection.items.map((i) => i.type)).toEqual(['grpc'])
    expect(after.find((c) => c.collection.id === collection.id)!.collection.items.map((i) => i.type)).toEqual(['websocket', 'folder'])
  })
})

describe('team sync (Azurite)', () => {
  const ACCOUNT = process.env.COURIER_TEST_AZURITE as string
  let container = ''
  beforeEach(async () => {
    container = `rt${Math.random().toString(36).slice(2, 12)}`
    await createContainerClient(ACCOUNT, container, new FakeCredential(ID_A)).create()
    await seedManifest(ACCOUNT, container, { name: 'Platform' })
  })

  it('WebSocket and gRPC items (with the service definition) sync to a teammate byte-identically, who can invoke without .proto files', async () => {
    const a = await teamClient({ identity: ID_A, accountUrl: ACCOUNT, container })
    const { collection } = await a.core.createCollection({ name: 'Realtime', teamId: a.teamId })
    await a.core.saveCollection({ ...collection, variables: [{ key: 'grpcHost', value: grpcSrv.address, enabled: true, type: 'default' }], items: [wsItem(), grpcItem({ tls: false })] })
    const up = await a.core.runSync()
    expect(up.errors).toEqual([])
    expect(up.uploaded.map((x) => x.name)).toEqual(['Realtime'])
    const b = await teamClient({ identity: ID_B, accountUrl: ACCOUNT, container })
    const down = await b.core.runSync()
    expect(down.downloaded.map((x) => x.name)).toEqual(['Realtime'])
    const mine = (await a.core.load()).collections.find((c) => c.collection.id === collection.id)!.collection
    const theirs = (await b.core.load()).collections.find((c) => c.collection.id === collection.id)!.collection
    expect(serializeCollection({ ...theirs, updatedAt: undefined, updatedBy: undefined })).toBe(serializeCollection({ ...mine, updatedAt: undefined, updatedBy: undefined }))
    const blob = (await createContainerClient(ACCOUNT, container, new FakeCredential(ID_A)).getBlockBlobClient(`shared/collections/${collection.id}.json`).downloadToBuffer()).toString('utf8')
    expect(blob).toContain('"type": "grpc"')
    expect(blob).not.toContain(PROTO_ROOT)
    // B invokes with the synced definition.
    const events: unknown[] = []
    ;(b.core as unknown as { emit: (e: string, p: unknown) => void }).emit = (e, p) => events.push([e, p])
    await b.core.grpcInvoke({ collectionId: collection.id, requestId: 'grpc-1', callId: 'sync-call' })
    const deadline = Date.now() + 5000
    while (!events.some((x) => (x as [string, { type: string }])[1]?.type === 'end') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    const end = events.map((x) => (x as [string, { type: string; status?: { name: string } }])[1]).find((p) => p.type === 'end')
    expect(end?.status?.name).toBe('OK')
  })

  it('team Key Vault approval gates WebSocket handshakes and gRPC calls exactly like HTTP sends', async () => {
    const teamVault = await mockVault({ 'rt-key': 'team-rt-secret' })
    try {
      await seedManifest(ACCOUNT, container, { name: 'Platform', vaults: [{ alias: 'tkv', url: teamVault.url }] })
      const a = await teamClient({ identity: ID_A, accountUrl: ACCOUNT, container, insecureKv: true })
      const { collection } = await a.core.createCollection({ name: 'Gated', teamId: a.teamId })
      const ws = wsItem({ url: `${wsSrv.url}/gated`, subprotocols: [], headers: [{ key: 'X-K', value: '{{vault:tkv/rt-key}}', enabled: true }], params: [] })
      const g = grpcItem({ address: grpcSrv.address, tls: false, method: 'Metadata', metadata: [{ key: 'x-k', value: '{{vault:tkv/rt-key}}', enabled: true }] })
      await a.core.saveCollection({ ...collection, items: [ws, g] })
      const handshakes = wsSrv.handshakes.length
      const calls = grpcSrv.calls.length
      await expect(a.core.wsConnect({ collectionId: collection.id, requestId: ws.id, connectionId: 'gate-ws' })).rejects.toMatchObject({ code: 'VAULT_NOT_APPROVED' })
      await expect(a.core.grpcInvoke({ collectionId: collection.id, requestId: g.id, callId: 'gate-grpc' })).rejects.toMatchObject({ code: 'VAULT_NOT_APPROVED' })
      expect(wsSrv.handshakes.length).toBe(handshakes)
      expect(grpcSrv.calls.length).toBe(calls)
      expect(teamVault.hits.filter((h) => h.authorized)).toEqual([])
      await a.core.approveTeamVault({ id: a.teamId, url: new URL(teamVault.url).origin })
      expect((await a.core.wsConnect({ collectionId: collection.id, requestId: ws.id, connectionId: 'gate-ws' })).status).toBe('open')
      expect(wsSrv.handshakes.at(-1)!.headers['x-k']).toBe('team-rt-secret')
      a.core.closeRealtime()
    } finally {
      await teamVault.close()
    }
  })

  it('a TLS file picked for gRPC never becomes sendable as an HTTP body file', async () => {
    const core = await makeCore()
    const dir = tempDir('courier-tls-')
    const keyPath = join(dir, 'client.key')
    writeFileSync(keyPath, '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n')
    await core.setGrpcTlsFile('grpc-1', 'key', keyPath)
    const before = echo.requests.length
    const r = await core.send({ draft: newRequest({ method: 'POST', url: `${echo.url}/upload`, body: { mode: 'binary', filePath: keyPath } }) })
    expect(r.error?.message).toMatch(/Re-select the body file/)
    expect(echo.requests.length).toBe(before)
  })

  it('literal credentials in a WebSocket header hold the upload back until acknowledged', async () => {
    const a = await teamClient({ identity: ID_A, accountUrl: ACCOUNT, container })
    const { collection } = await a.core.createCollection({ name: 'Leaky', teamId: a.teamId })
    await a.core.saveCollection({ ...collection, items: [wsItem({ headers: [{ key: 'Authorization', value: 'Bearer very-literal-token', enabled: true }] })] })
    const r = await a.core.runSync()
    expect(r.blocked.map((x) => x.findings.map((f) => f.field))).toEqual([['header']])
    const ack = await a.core.runSync({ acknowledgeWarnings: true })
    expect(ack.uploaded.map((x) => x.name)).toEqual(['Leaky'])
  })
})
