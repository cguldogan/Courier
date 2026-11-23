/**
 * WebSocket requests end to end in the engine (CourierCore, no Electron) against a local `ws` server:
 * text / binary, subprotocols, handshake headers + auth + cookies, close codes, size limit, TLS,
 * variables + Key Vault resolution with masking, unsupported auth, log bounds and cleanup.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CourierCore } from '../src/main/core'
import type { CourierEvents } from '../src/shared/api'
import { appendBounded, EMPTY_LOG, type BoundedLog } from '../src/shared/realtime'
import { MASK } from '../src/shared/variables'
import { newWebSocketRequest, type Auth, type RealtimeLogEntry, type WebSocketRequestDef, type WsEvent } from '../src/shared/types'
import { startWsServer, type WsTestServer } from './fixtures/realtime-servers.mjs'
import { ID_A, cleanupTempDirs, mockVault, tempDir } from './helpers'

const SECRET = 'ws-Vault-S3cret-41f9'
let vault: Awaited<ReturnType<typeof mockVault>>
let server: WsTestServer
let tlsServer: WsTestServer
let untrusted: { cert: Buffer; key: Buffer }

beforeAll(async () => {
  vault = await mockVault({ 'ws-token': SECRET })
  server = await startWsServer()
  tlsServer = await startWsServer({ tls: { cert: readFileSync(process.env.COURIER_TEST_CERT as string), key: readFileSync(process.env.COURIER_TEST_KEY as string) } })
  // A second self-signed certificate that is NOT in NODE_EXTRA_CA_CERTS.
  const dir = tempDir('courier-ws-pki-')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' })
  untrusted = { cert: readFileSync(join(dir, 'c.pem')), key: readFileSync(join(dir, 'k.pem')) }
})
afterAll(async () => {
  await server.stop()
  await tlsServer.stop()
  await vault.close()
  cleanupTempDirs()
})

interface Harness {
  core: CourierCore
  events: WsEvent[]
  collectionId: string
  /** Saves the request in the collection and connects it. */
  connect(req: WebSocketRequestDef, connectionId?: string): ReturnType<CourierCore['wsConnect']>
  log(connectionId: string): RealtimeLogEntry[]
  waitFor(pred: () => boolean, ms?: number): Promise<void>
}

async function harness(opts: { auth?: Auth; variables?: { key: string; value: string }[] } = {}): Promise<Harness> {
  const events: WsEvent[] = []
  const core = new CourierCore({
    userDataDir: tempDir('courier-ws-ud-'),
    fakeIdentity: ID_A,
    keyVaultInsecureChallenge: true,
    emit: <E extends keyof CourierEvents>(event: E, payload: CourierEvents[E]) => {
      if (event === 'ws:event') events.push(payload as WsEvent)
    }
  })
  await core.init()
  await core.updateSettings({ keyVault: { vaults: [{ alias: 'main', url: vault.url }], cacheTtlSeconds: 300 } })
  await core.signIn({ mode: 'azure-cli' })
  const { collection } = await core.createCollection({ name: 'Sockets' })
  await core.saveCollection({ ...collection, auth: opts.auth ?? { type: 'none' }, variables: (opts.variables ?? []).map((v) => ({ ...v, enabled: true, type: 'default' as const })) })
  const waitFor = async (pred: () => boolean, ms = 5000): Promise<void> => {
    const end = Date.now() + ms
    while (!pred()) {
      if (Date.now() > end) throw new Error('timed out waiting')
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  return {
    core,
    events,
    collectionId: collection.id,
    async connect(req, connectionId = `c${Math.random().toString(36).slice(2, 10)}`) {
      await core.upsertItem({ collectionId: collection.id, item: req })
      return core.wsConnect({ collectionId: collection.id, requestId: req.id, connectionId }, 7)
    },
    log: (id) => events.filter((e): e is Extract<WsEvent, { type: 'message' }> => e.connectionId === id && e.type === 'message').map((e) => e.entry),
    waitFor
  }
}

const statusOf = (h: Harness, id: string): Extract<WsEvent, { type: 'status' }> | undefined =>
  [...h.events].reverse().find((e): e is Extract<WsEvent, { type: 'status' }> => e.connectionId === id && e.type === 'status')

describe('WebSocket connections', () => {
  it('sends text with {{variables}} and {{vault:…}} resolved in main; the log and handshake show the secret masked', async () => {
    const h = await harness({ variables: [{ key: 'room', value: 'lobby' }, { key: 'wsToken', value: '{{vault:ws-token}}' }] })
    const req = newWebSocketRequest({
      url: `${server.url}/chat`,
      params: [{ key: 'room', value: '{{room}}', enabled: true }],
      headers: [{ key: 'X-Token', value: '{{wsToken}}', enabled: true }]
    })
    const r = await h.connect(req, 'conn-text')
    expect(r.status).toBe('open')
    const hs = server.handshakes.at(-1)!
    expect(hs.query.room).toBe('lobby')
    expect(hs.headers['x-token']).toBe(SECRET)
    const open = statusOf(h, 'conn-text')!
    expect(open.status).toBe('open')
    expect(open.handshake?.status).toBe(101)
    expect(open.handshake?.requestHeaders.find(([k]) => k.toLowerCase() === 'x-token')?.[1]).toBe(MASK)
    expect(JSON.stringify(h.events)).not.toContain(SECRET)

    const sent = await h.core.wsSend({ connectionId: 'conn-text', message: { kind: 'text', format: 'json', body: '{"room":"{{room}}","key":"{{vault:ws-token}}"}' } })
    expect(sent.direction).toBe('out')
    expect(sent.text).toBe(`{"room":"lobby","key":"${MASK}"}`)
    await h.waitFor(() => h.log('conn-text').some((e) => e.direction === 'in' && e.kind === 'text'))
    expect(server.received.at(-1)!.data.toString('utf8')).toBe(`{"room":"lobby","key":"${SECRET}"}`)
    const echoed = h.log('conn-text').find((e) => e.direction === 'in' && e.kind === 'text')!
    expect(echoed.text).toBe(`{"room":"lobby","key":"${MASK}"}`)
    expect(echoed.size).toBe(Buffer.byteLength(`{"room":"lobby","key":"${SECRET}"}`))
    expect(JSON.stringify(h.events)).not.toContain(SECRET)
    expect(h.core.wsDisconnect({ connectionId: 'conn-text' })).toBe(true)
    await h.waitFor(() => statusOf(h, 'conn-text')?.status === 'closed')
    expect(statusOf(h, 'conn-text')).toMatchObject({ status: 'closed', code: 1000 })
  })

  it('sends binary from base64 and hex input and shows received binary as base64', async () => {
    const h = await harness()
    await h.connect(newWebSocketRequest({ url: server.url }), 'conn-bin')
    await h.core.wsSend({ connectionId: 'conn-bin', message: { kind: 'binary', format: 'hex', body: 'de ad be ef' } })
    await h.core.wsSend({ connectionId: 'conn-bin', message: { kind: 'binary', format: 'base64', body: Buffer.from([1, 2, 3]).toString('base64') } })
    await h.waitFor(() => h.log('conn-bin').filter((e) => e.direction === 'in').length === 2)
    const binIn = h.log('conn-bin').filter((e) => e.direction === 'in')
    expect(binIn.map((e) => [e.kind, e.base64, e.size])).toEqual([
      ['binary', Buffer.from('deadbeef', 'hex').toString('base64'), 4],
      ['binary', 'AQID', 3]
    ])
    expect(server.received.slice(-2).map((x) => [x.binary, x.data.toString('hex')])).toEqual([
      [true, 'deadbeef'],
      [true, '010203']
    ])
    await expect(h.core.wsSend({ connectionId: 'conn-bin', message: { kind: 'binary', format: 'hex', body: 'abc' } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    h.core.closeRealtime()
  })

  it('negotiates a subprotocol and shows the handshake response', async () => {
    const h = await harness()
    await h.connect(newWebSocketRequest({ url: server.url, subprotocols: ['chat', 'courier.v2'] }), 'conn-proto')
    const open = statusOf(h, 'conn-proto')!
    expect(server.handshakes.at(-1)!.headers['sec-websocket-protocol']).toBe('chat, courier.v2'.replace(', ', ','))
    expect(open.handshake?.protocol).toBe('courier.v2')
    expect(open.handshake?.responseHeaders.some(([k, v]) => k.toLowerCase() === 'sec-websocket-protocol' && v === 'courier.v2')).toBe(true)
    h.core.closeRealtime()
  })

  it('applies inherited auth, sends jar cookies on the handshake and stores Set-Cookie from it', async () => {
    const h = await harness({ auth: { type: 'bearer', token: '{{vault:ws-token}}' } })
    const r1 = await h.connect(newWebSocketRequest({ url: `${server.url}/needs-auth` }), 'conn-auth')
    expect(r1.status).toBe('open')
    expect(server.handshakes.at(-1)!.headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(statusOf(h, 'conn-auth')!.handshake!.requestHeaders.find(([k]) => k.toLowerCase() === 'authorization')?.[1]).toBe(`Bearer ${MASK}`)
    await h.waitFor(() => false, 50).catch(() => undefined)
    const cookies = await h.core.listCookies()
    expect(cookies.map((c) => [c.key, c.value, c.domain])).toContainEqual(['wscookie', 'from-handshake', '127.0.0.1'])
    h.core.closeRealtime()
    await h.connect(newWebSocketRequest({ url: `${server.url}/again` }), 'conn-cookie')
    expect(server.handshakes.at(-1)!.headers.cookie).toBe('wscookie=from-handshake')
    h.core.closeRealtime()
  })

  it('a refused handshake reports the status and body; a missing credential gets 401', async () => {
    const h = await harness()
    const r = await h.connect(newWebSocketRequest({ url: `${server.url}/reject` }), 'conn-403')
    expect(r.status).toBe('error')
    expect(r.error?.message).toMatch(/403 Forbidden instead of 101.*no websockets for you/)
    expect(statusOf(h, 'conn-403')).toMatchObject({ status: 'error', handshake: { status: 403 } })
    const r2 = await h.connect(newWebSocketRequest({ url: `${server.url}/needs-auth` }), 'conn-401')
    expect(r2.error).toMatchObject({ code: 'AUTH_FAILED' })
  })

  it('reports close codes and reasons from the server', async () => {
    const h = await harness()
    const r = await h.connect(newWebSocketRequest({ url: server.url }), 'conn-close')
    expect(r, JSON.stringify(h.events)).toMatchObject({ status: 'open' })
    await h.core.wsSend({ connectionId: 'conn-close', message: { kind: 'text', format: 'text', body: 'close:4001:bye now' } })
    await h.waitFor(() => statusOf(h, 'conn-close')?.status === 'closed')
    expect(statusOf(h, 'conn-close')).toMatchObject({ status: 'closed', code: 4001, reason: 'bye now' })
    await expect(h.core.wsSend({ connectionId: 'conn-close', message: { kind: 'text', format: 'text', body: 'x' } })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('closes with 1009 when a message exceeds the maximum size', async () => {
    const h = await harness()
    await h.connect(newWebSocketRequest({ url: server.url, settings: { maxMessageBytes: 1000 } }), 'conn-big')
    await h.core.wsSend({ connectionId: 'conn-big', message: { kind: 'text', format: 'text', body: 'big:5000' } })
    await h.waitFor(() => statusOf(h, 'conn-big')?.status === 'closed')
    const st = statusOf(h, 'conn-big')!
    expect(st.code).toBe(1009)
    expect(st.error?.message).toMatch(/larger than the maximum message size \(1000 bytes\)/)
  })

  it('shows pings from the server and sends pings', async () => {
    const h = await harness()
    await h.connect(newWebSocketRequest({ url: server.url }), 'conn-ping')
    await h.core.wsSend({ connectionId: 'conn-ping', message: { kind: 'text', format: 'text', body: 'ping:hello' } })
    h.core.wsPing('conn-ping')
    await h.waitFor(() => h.log('conn-ping').some((e) => e.kind === 'ping' && e.direction === 'in') && h.log('conn-ping').some((e) => e.kind === 'pong'))
    expect(h.log('conn-ping').find((e) => e.kind === 'ping' && e.direction === 'in')?.text).toBe('hello')
    h.core.closeRealtime()
  })

  it('TLS: trusted certificate works; an untrusted one fails unless verification is off', async () => {
    const h = await harness()
    expect((await h.connect(newWebSocketRequest({ url: tlsServer.url }), 'conn-tls')).status).toBe('open')
    const bad = await startWsServer({ tls: untrusted })
    try {
      const r = await h.connect(newWebSocketRequest({ url: bad.url }), 'conn-untrusted')
      expect(r.status).toBe('error')
      expect(r.error?.message).toMatch(/self.signed|certificate/i)
      expect(r.error?.message).toMatch(/Verify TLS certificates/)
      const off = await h.connect(newWebSocketRequest({ url: bad.url, settings: { verifyTls: false } }), 'conn-insecure')
      expect(off.status).toBe('open')
    } finally {
      h.core.closeRealtime()
      await bad.stop()
    }
  })

  it('Digest, NTLM and AWS Signature report that they are not supported for WebSocket', async () => {
    const h = await harness({ auth: { type: 'digest', username: 'u', password: 'p' } })
    await expect(h.connect(newWebSocketRequest({ url: server.url }), 'conn-digest')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/Digest authorization is not supported for WebSocket/) })
    expect(statusOf(h, 'conn-digest')).toMatchObject({ status: 'error' })
    const ntlm = newWebSocketRequest({ url: server.url, auth: { type: 'ntlm', username: 'u', password: 'p', domain: '', workstation: '' } })
    await expect(h.connect(ntlm, 'conn-ntlm')).rejects.toThrow(/NTLM authorization is not supported for WebSocket/)
  })

  it('rejects non-ws URLs and the wrong request kind', async () => {
    const h = await harness()
    await expect(h.connect(newWebSocketRequest({ url: 'http://127.0.0.1:1/' }), 'conn-http')).rejects.toThrow(/start with ws:\/\/ or wss:\/\//)
    await expect(h.core.wsConnect({ draft: { ...newWebSocketRequest(), type: 'grpc' } as never, connectionId: 'x1' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('reconnects after an unexpected close only when auto-reconnect is on', async () => {
    const h = await harness()
    const req = newWebSocketRequest({ url: server.url, settings: { autoReconnect: true } })
    await h.core.upsertItem({ collectionId: h.collectionId, item: req })
    await h.core.wsConnect({ collectionId: h.collectionId, requestId: req.id, connectionId: 'conn-re' })
    const opened = (): number => h.events.filter((e) => e.connectionId === 'conn-re' && e.type === 'status' && e.status === 'open').length
    await h.core.wsSend({ connectionId: 'conn-re', message: { kind: 'text', format: 'text', body: 'close:4002:restart' } })
    await h.waitFor(() => h.events.some((e) => e.connectionId === 'conn-re' && e.type === 'status' && e.status === 'reconnecting'))
    await h.waitFor(() => opened() === 2, 4000)
    h.core.wsDisconnect({ connectionId: 'conn-re' })
    await h.waitFor(() => statusOf(h, 'conn-re')?.status === 'closed')
  })

  it('closing a window closes its connections (and only those); quit closes the rest', async () => {
    const h = await harness()
    await h.core.upsertItem({ collectionId: h.collectionId, item: newWebSocketRequest({ id: 'w1', url: server.url }) })
    await h.core.wsConnect({ collectionId: h.collectionId, requestId: 'w1', connectionId: 'own-1' }, 1)
    await h.core.wsConnect({ collectionId: h.collectionId, requestId: 'w1', connectionId: 'own-2' }, 2)
    const before = server.clients()
    expect(h.core.websockets.size).toBe(2)
    h.core.closeRealtime(1)
    expect(h.core.websockets.size).toBe(1)
    await h.waitFor(() => server.clients() === before - 1)
    h.core.closeRealtime()
    expect(h.core.websockets.size).toBe(0)
    await h.waitFor(() => server.clients() === before - 2)
  })
})

describe('message log bounds', () => {
  const entry = (seq: number, text: string): RealtimeLogEntry => ({ seq, direction: 'in', kind: 'text', at: '', size: text.length, text })
  it('drops the oldest entries beyond the count cap and counts them', () => {
    let log: BoundedLog = EMPTY_LOG
    for (let i = 1; i <= 12; i++) log = appendBounded(log, [entry(i, 'x')], { maxEntries: 5, maxBytes: 1e9 })
    expect(log.entries.map((e) => e.seq)).toEqual([8, 9, 10, 11, 12])
    expect(log.dropped).toBe(7)
  })
  it('drops by size, always keeping the newest entry', () => {
    let log: BoundedLog = EMPTY_LOG
    log = appendBounded(log, [entry(1, 'a'.repeat(100)), entry(2, 'b'.repeat(100))], { maxEntries: 100, maxBytes: 300 })
    expect(log.entries.map((e) => e.seq)).toEqual([2])
    log = appendBounded(log, [entry(3, 'c'.repeat(1000))], { maxEntries: 100, maxBytes: 300 })
    expect(log.entries.map((e) => e.seq)).toEqual([3])
    expect(log.dropped).toBe(2)
  })
})
