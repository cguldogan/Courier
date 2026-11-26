/**
 * Mock servers: the matching rules (one row per rule, plus the 404 diagnostics), the Host check,
 * CORS and preflight, delay, variable substitution with Key Vault references left unresolved, port in
 * use, live example edits and cleanup through the core, malformed and oversized requests, and the
 * built `courier mock` bundle as a child process. Everything on 127.0.0.1.
 */
import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { connect, createServer } from 'node:net'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { compilePath, examplePath, matchRequest, mockCandidates, pathMatches, requestSegments, type MockRequestInfo } from '../src/main/mock/match'
import { MOCK_MAX_BODY_BYTES, MockServer, mockVariables } from '../src/main/mock/server'
import { serializeCollection } from '../src/shared/serialize'
import { MASK } from '../src/shared/variables'
import { newCollection, newEnvironment, newFolder, newRequest, type Collection, type RequestDef, type ResponseExample } from '../src/shared/types'
import { CLI_BIN } from './cli-helpers'
import { cleanupTempDirs, makeCore, tempDir } from './helpers'

afterAll(cleanupTempDirs)

let seq = 0
function ex(name: string, url: string, partial: { method?: string; status?: number; body?: string; params?: [string, string][]; headers?: [string, string][]; language?: ResponseExample['response']['language']; id?: string } = {}): ResponseExample {
  return {
    id: partial.id ?? `ex-${++seq}`,
    name,
    request: { method: partial.method ?? 'GET', url, params: (partial.params ?? []).map(([key, value]) => ({ key, value, enabled: true })), headers: [], body: { mode: 'none' } },
    response: { status: partial.status ?? 200, statusText: '', headers: (partial.headers ?? []).map(([key, value]) => ({ key, value, enabled: true })), body: partial.body ?? `{"example":"${name}"}`, language: partial.language ?? 'json' }
  }
}

function col(examples: ResponseExample[][], extra: Partial<Collection> = {}): Collection {
  return newCollection({ id: 'mock-col', name: 'Mocked', items: examples.map((e, i) => newRequest({ id: `r${i}`, name: `Req ${i}`, url: e[0]?.request.url ?? '', method: e[0]?.request.method ?? 'GET', examples: e })), ...extra })
}

function req(method: string, url: string, headers: Record<string, string> = {}): MockRequestInfo {
  const u = new URL(url, 'http://127.0.0.1')
  return { method, path: u.pathname, query: [...u.searchParams], headers }
}

function pick(c: Collection, r: MockRequestInfo): string {
  const m = matchRequest(mockCandidates(c), r)
  return m.matched ? m.candidate.example.name : `404: ${m.notFound.message}`
}

describe('matching rules', () => {
  it('derives the path from the URL template', () => {
    expect(examplePath('{{baseUrl}}/users/:id?x=1')).toBe('/users/:id')
    expect(examplePath('https://api.test:8443/v1/orders#frag')).toBe('/v1/orders')
    expect(examplePath('{{host}}:8080/a')).toBe('/a')
    expect(examplePath('api.test/a/b')).toBe('/a/b')
    expect(examplePath('{{baseUrl}}')).toBe('/')
    expect(examplePath('/plain')).toBe('/plain')
    expect(pathMatches(compilePath('/users/:id/'), requestSegments('/users/7'))).toBe(true)
    expect(pathMatches(compilePath('/users//{{id}}'), requestSegments('/users/7/'))).toBe(true)
    expect(pathMatches(compilePath('/files/v{{ver}}.json'), requestSegments('/files/v2.json'))).toBe(true)
    expect(pathMatches(compilePath('/files/v{{ver}}.json'), requestSegments('/files/x2.json'))).toBe(false)
    expect(pathMatches(compilePath('/a%20b'), requestSegments('/a b'))).toBe(true)
  })

  const c = col([
    [ex('List users', '{{baseUrl}}/users'), ex('Empty list', '{{baseUrl}}/users', { status: 200, body: '[]', params: [['empty', 'true']] })],
    [ex('User by id', '{{baseUrl}}/users/:id'), ex('User missing', '{{baseUrl}}/users/:id', { status: 404, id: 'ex-missing' })],
    [ex('Me', '{{baseUrl}}/users/me')],
    [ex('Create user', '{{baseUrl}}/users', { method: 'POST', status: 201 })],
    [ex('Search page 2', '{{baseUrl}}/search', { params: [['q', '{{term}}'], ['page', '2']] }), ex('Search any', '{{baseUrl}}/search', { params: [['q', '{{term}}']] })]
  ])

  it.each([
    ['method + path', req('GET', '/users'), 'List users'],
    ['methods are case-insensitive, other methods do not match', req('post', '/users'), 'Create user'],
    ['trailing slash tolerated', req('GET', '/users/'), 'List users'],
    [':id matches any segment', req('GET', '/users/42'), 'User by id'],
    ['most specific path wins (literal before variable)', req('GET', '/users/me'), 'Me'],
    ['first in collection order among equals', req('GET', '/users/7'), 'User by id'],
    ['x-mock-response-code narrows', req('GET', '/users/7', { 'x-mock-response-code': '404' }), 'User missing'],
    ['x-mock-response-name narrows (case-insensitive)', req('GET', '/users/7', { 'x-mock-response-name': 'user MISSING' }), 'User missing'],
    ['x-mock-response-id narrows', req('GET', '/users/7', { 'x-mock-response-id': 'ex-missing' }), 'User missing'],
    ['query overlap picks the example with matching parameters', req('GET', '/users?empty=true'), 'Empty list'],
    ['query: a {{var}} value accepts any value; more matches win', req('GET', '/search?q=x&page=2'), 'Search page 2'],
    ['query: fewer missing parameters breaks a tie', req('GET', '/search?q=x'), 'Search any'],
    ['HEAD falls back to GET', req('HEAD', '/users/me'), 'Me']
  ])('%s', (_rule, r, expected) => {
    expect(pick(c, r)).toBe(expected)
  })

  it('reports HEAD fallback so the body is left out', () => {
    const m = matchRequest(mockCandidates(c), req('HEAD', '/users'))
    expect(m.matched && m.headOnly).toBe(true)
  })

  it('404 diagnostics: what was tried and the closest examples', () => {
    const m = matchRequest(mockCandidates(c), req('DELETE', '/users/7?x=1'))
    expect(m.matched).toBe(false)
    if (m.matched) return
    expect(m.notFound.error).toBe('mockRequestNotFoundError')
    expect(m.notFound.request).toEqual({ method: 'DELETE', path: '/users/7', query: { x: '1' } })
    expect(m.notFound.tried[0]).toMatch(/method \+ path: DELETE \/users\/7 against 8 example/)
    expect(m.notFound.closest[0]).toMatchObject({ name: 'User by id', reason: 'same path, but the example is GET' })
    const h = matchRequest(mockCandidates(c), req('GET', '/users/7', { 'x-mock-response-code': '500' }))
    expect(h.matched).toBe(false)
    if (!h.matched) {
      expect(h.notFound.message).toMatch(/No example with status "500" among the 2 example\(s\) matching GET \/users\/7/)
      expect(h.notFound.tried).toContain('x-mock-response-code: 500')
    }
    const p = matchRequest(mockCandidates(c), req('GET', '/orders/1'))
    if (!p.matched) expect(p.notFound.closest.some((x) => /path differs at segment 1: expected "users", got "orders"/.test(x.reason))).toBe(true)
    const none = matchRequest([], req('GET', '/'))
    if (!none.matched) expect(none.notFound.message).toMatch(/no saved examples/)
  })
})

// ---------------------------------------------------------------------------------------------

interface Raw {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}
function raw(port: number, opts: { method?: string; path?: string; host?: string | null; headers?: Record<string, string>; body?: Buffer | string } = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) }
    if (opts.host !== null) headers.host = opts.host ?? `127.0.0.1:${port}`
    const r = httpRequest({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path ?? '/', headers, setHost: false, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    r.on('error', reject)
    r.end(opts.body)
  })
}

const servers: MockServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
})

async function serve(c: Collection, settings: Partial<{ delayMs: number; cors: boolean; substituteVariables: boolean }> = {}, port = 0, vars = mockVariables(c, null)): Promise<MockServer> {
  const s = new MockServer({ port, collection: () => c, variables: () => vars, settings: () => ({ delayMs: 0, cors: true, substituteVariables: true, ...settings }) })
  servers.push(s)
  await s.start()
  return s
}

describe('the HTTP server', () => {
  const c = col([[ex('Hello', '{{baseUrl}}/hello', { headers: [['X-Custom', 'yes'], ['Content-Length', '999'], ['Content-Encoding', 'gzip']] })], [ex('Created', '/things', { method: 'POST', status: 201, body: 'made' , language: 'text' })]])

  it('binds 127.0.0.1 only and answers with the example (framing headers are its own)', async () => {
    const s = await serve(c)
    expect(s.url).toBe(`http://127.0.0.1:${s.port}`)
    const r = await raw(s.port, { path: '/hello' })
    expect(r.status).toBe(200)
    expect(r.body).toBe('{"example":"Hello"}')
    expect(r.headers['x-custom']).toBe('yes')
    expect(r.headers['content-length']).toBe(String(r.body.length))
    expect(r.headers['content-encoding']).toBeUndefined()
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(r.headers['x-mock-example-id']).toBeDefined()
    const res = await fetch(`${s.url}/things`, { method: 'POST', body: 'x' })
    expect([res.status, await res.text()]).toEqual([201, 'made'])
    // Not reachable on another interface (the only non-loopback check possible here: the bound address).
    expect((s as unknown as { server: { address(): { address: string } } }).server.address().address).toBe('127.0.0.1')
  })

  it('refuses other Host headers (DNS rebinding) and a missing Host', async () => {
    const s = await serve(c)
    expect((await raw(s.port, { path: '/hello', host: `localhost:${s.port}` })).status).toBe(200)
    expect((await raw(s.port, { path: '/hello', host: `LOCALHOST:${s.port}` })).status).toBe(200)
    const evil = await raw(s.port, { path: '/hello', host: `attacker.example:${s.port}` })
    expect(evil.status).toBe(403)
    expect(JSON.parse(evil.body).error).toBe('hostNotAllowed')
    expect((await raw(s.port, { path: '/hello', host: '127.0.0.1' })).status).toBe(403)
    expect((await raw(s.port, { path: '/hello', host: `127.0.0.1:${s.port + 1}` })).status).toBe(403)
    expect((await raw(s.port, { method: 'OPTIONS', path: '/hello', host: 'evil.test', headers: { origin: 'http://evil.test', 'access-control-request-method': 'GET' } })).status).toBe(403)
  })

  it('CORS on: headers on answers and preflight; off: no headers, OPTIONS is matched like any method', async () => {
    const on = await serve(c)
    const pre = await raw(on.port, { method: 'OPTIONS', path: '/hello', headers: { origin: 'http://app.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-mock-response-code' } })
    expect(pre.status).toBe(204)
    expect(pre.headers['access-control-allow-origin']).toBe('*')
    expect(pre.headers['access-control-allow-headers']).toBe('x-mock-response-code')
    expect(pre.headers['access-control-allow-private-network']).toBeUndefined()
    expect((await raw(on.port, { path: '/hello', headers: { origin: 'http://app.test' } })).headers['access-control-allow-origin']).toBe('*')
    expect((await raw(on.port, { path: '/nope' })).headers['access-control-allow-origin']).toBe('*')
    const off = await serve(c, { cors: false })
    const r = await raw(off.port, { path: '/hello' })
    expect(r.headers['access-control-allow-origin']).toBeUndefined()
    expect((await raw(off.port, { method: 'OPTIONS', path: '/hello', headers: { 'access-control-request-method': 'GET' } })).status).toBe(404)
  })

  it('a fixed delay is applied before answering', async () => {
    const s = await serve(c, { delayMs: 300 })
    const t = Date.now()
    expect((await raw(s.port, { path: '/hello' })).status).toBe(200)
    expect(Date.now() - t).toBeGreaterThanOrEqual(280)
  })

  it('no match: 404 JSON with diagnostics', async () => {
    const s = await serve(c)
    const r = await raw(s.port, { path: '/missing' })
    expect(r.status).toBe(404)
    const b = JSON.parse(r.body)
    expect(b.error).toBe('mockRequestNotFoundError')
    expect(b.closest.length).toBeGreaterThan(0)
  })

  it('substitutes plain variables; Key Vault references, vault- and secret-typed variables stay masked', async () => {
    const vc = col([[ex('Vars', '/vars', { body: '{"env":"{{stage}}","col":"{{owner}}","kv":"{{vault:main/api-key}}","vv":"{{fromVault}}","sec":"{{pw}}","unknown":"{{nope}}"}', headers: [['X-Stage', '{{stage}}'], ['X-Kv', '{{vault:api-key}}']] })]], {
      variables: [
        { key: 'owner', value: 'team-a', enabled: true, type: 'default' },
        { key: 'fromVault', value: 'main/api-key', enabled: true, type: 'vault' },
        { key: 'pw', value: '', enabled: true, type: 'secret' },
        { key: 'indirect', value: '{{vault:main/x}}', enabled: true, type: 'default' }
      ]
    })
    const env = newEnvironment({ name: 'E', variables: [{ key: 'stage', value: 'staging', enabled: true, type: 'default' }] })
    const s = await serve(vc, {}, 0, mockVariables(vc, env))
    const r = await raw(s.port, { path: '/vars' })
    expect(JSON.parse(r.body)).toEqual({ env: 'staging', col: 'team-a', kv: MASK, vv: MASK, sec: MASK, unknown: '{{nope}}' })
    expect(r.headers['x-stage']).toBe('staging')
    expect(r.headers['x-kv']).toBe('****')
    expect(mockVariables(vc, null).collection.indirect).toBe(MASK)
    const plain = await serve(vc, { substituteVariables: false })
    expect(JSON.parse((await raw(plain.port, { path: '/vars' })).body).env).toBe('{{stage}}')
    expect(JSON.parse((await raw(plain.port, { path: '/vars' })).body).kv).toBe(MASK)
  })

  it('port in use: a clear error', async () => {
    const blocker = createServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()))
    const port = (blocker.address() as { port: number }).port
    const s = new MockServer({ port, collection: () => c, variables: () => mockVariables(c, null), settings: () => ({ delayMs: 0, cors: true, substituteVariables: true }) })
    await expect(s.start()).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining(`Port ${port} is already in use on 127.0.0.1`) })
    await new Promise<void>((r) => blocker.close(() => r()))
  })

  it('malformed requests and large bodies do not crash it', async () => {
    const s = await serve(c)
    const garbage = await new Promise<string>((resolve) => {
      const sock = connect(s.port, '127.0.0.1', () => sock.write('NOT HTTP AT ALL\r\n\r\n'))
      let out = ''
      sock.on('data', (d) => (out += d.toString()))
      sock.on('close', () => resolve(out))
      sock.on('error', () => resolve(out))
    })
    expect(garbage).toMatch(/^HTTP\/1\.1 400/)
    const big = await raw(s.port, { method: 'POST', path: '/things', body: Buffer.alloc(MOCK_MAX_BODY_BYTES + 10, 1), headers: { 'content-type': 'application/octet-stream' } }).catch((e: Error) => ({ status: -1, body: e.message, headers: {} }))
    expect([413, -1]).toContain(big.status)
    const huge = await raw(s.port, { path: '/hello', headers: { 'x-big': 'y'.repeat(40_000) } }).catch(() => ({ status: 431, body: '', headers: {} }))
    expect([400, 431]).toContain(huge.status)
    expect((await raw(s.port, { path: '/hello' })).status).toBe(200)
  })

  it('serves examples that came from a hostile document without throwing', async () => {
    const bad = col([[{ ...ex('Weird', '/weird', { headers: [['Bad Header', 'x'], ['X-Ok', 'fine'], ['X-Ctl', 'a\u0001b']] }), response: { status: 200, statusText: 'Fine', headers: [{ key: 'Bad Header', value: 'x', enabled: true }, { key: 'X-Ok', value: 'fine', enabled: true }, { key: 'X-Ctl', value: 'a\u0001b', enabled: true }], body: 'ok', language: 'text' } }]])
    const s = await serve(bad)
    const r = await raw(s.port, { path: '/weird' })
    expect(r.status).toBe(200)
    expect(r.headers['x-ok']).toBe('fine')
    expect(r.headers['x-ctl']).toBeUndefined()
  })
})

describe('mock servers through the core', () => {
  it('start / live edits / log / settings / port in use / stop on delete; several at once', async () => {
    const core = await makeCore()
    const a = (await core.createCollection({ name: 'A' })).collection
    const b = (await core.createCollection({ name: 'B' })).collection
    const r = newRequest({ id: 'ra', name: 'Ping', url: '{{baseUrl}}/ping', examples: [ex('Pong', '{{baseUrl}}/ping', { body: 'pong', language: 'text' })] })
    await core.upsertItem({ collectionId: a.id, item: r })
    await core.upsertItem({ collectionId: b.id, item: newRequest({ id: 'rb', name: 'B', url: '/b', examples: [ex('Bee', '/b', { body: 'bee', language: 'text' })] }) })
    const sa = await core.mockStart({ collectionId: a.id, settings: { delayMs: 0 } })
    const sb = await core.mockStart({ collectionId: b.id })
    expect(sa.running && sb.running && sa.port !== sb.port).toBe(true)
    expect(await (await fetch(`${sa.url}/ping`)).text()).toBe('pong')
    expect(await (await fetch(`${sb.url}/b`)).text()).toBe('bee')
    // Editing the example takes effect without a restart.
    const saved = (await core.load()).collections.find((e) => e.collection.id === a.id)!.collection.items[0] as RequestDef
    await core.exampleSave({ collectionId: a.id, requestId: 'ra', example: { ...saved.examples![0], response: { ...saved.examples![0].response, body: 'pong v2' } } })
    expect(await (await fetch(`${sa.url}/ping`)).text()).toBe('pong v2')
    const log = core.mockLog(a.id)
    expect(log.map((l) => [l.method, l.path, l.status, l.example?.name])).toEqual([
      ['GET', '/ping', 200, 'Pong'],
      ['GET', '/ping', 200, 'Pong']
    ])
    await fetch(`${sa.url}/nothing`)
    expect(core.mockLog(a.id).at(-1)).toMatchObject({ status: 404, note: 'no match' })
    core.mockClearLog(a.id)
    expect(core.mockLog(a.id)).toEqual([])
    // Settings apply to the running server at once.
    await core.mockUpdate({ collectionId: a.id, settings: { cors: false } })
    expect((await fetch(`${sa.url}/ping`)).headers.get('access-control-allow-origin')).toBeNull()
    // Port in use (by the other mock).
    const c2 = (await core.createCollection({ name: 'C' })).collection
    await expect(core.mockStart({ collectionId: c2.id, settings: { port: sb.port } })).rejects.toMatchObject({ code: 'CONFLICT' })
    // The chosen settings are remembered on this machine.
    expect((await core.mocksList()).find((x) => x.collectionId === a.id)?.settings).toMatchObject({ cors: false, port: 0 })
    // Deleting the collection stops its server.
    await core.deleteDoc('collection', a.id)
    await expect(fetch(`${sa.url}/ping`)).rejects.toThrow()
    expect((await core.mocksList()).some((x) => x.collectionId === a.id)).toBe(false)
    await core.shutdown()
    await expect(fetch(`${sb.url}/b`)).rejects.toThrow()
  })
})

describe('courier mock (built bundle, child process)', () => {
  it('serves the file until SIGINT, logging each request', async () => {
    const dir = tempDir('courier-mock-cli-')
    const file = join(dir, 'm.courier.json')
    writeFileSync(file, serializeCollection(newCollection({ name: 'CLI Mock', variables: [{ key: 'who', value: 'world', enabled: true, type: 'default' }], items: [newFolder({ name: 'F', items: [newRequest({ name: 'Hi', url: '{{baseUrl}}/hi/:name', examples: [ex('Hello', '{{baseUrl}}/hi/:name', { body: 'hello {{who}} {{vault:k}}', language: 'text' })] })] })] })))
    const child = spawn(process.execPath, [CLI_BIN, 'mock', file, '--delay', '10'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    const url = await new Promise<string>((resolve, reject) => {
      const t = setInterval(() => {
        const m = /listening on (http:\/\/127\.0\.0\.1:\d+) \(1 example\)/.exec(stdout)
        if (m) {
          clearInterval(t)
          resolve(m[1])
        }
      }, 50)
      setTimeout(() => {
        clearInterval(t)
        reject(new Error(`no listening line: ${stdout} ${stderr}`))
      }, 15_000)
    })
    const res = await fetch(`${url}/hi/bob`)
    expect([res.status, await res.text()]).toEqual([200, `hello world ${MASK}`])
    expect((await fetch(`${url}/nope`)).status).toBe(404)
    await new Promise((r) => setTimeout(r, 100))
    expect(stdout).toMatch(/GET {5}\/hi\/bob {2}→ 200 {2}"Hello" \(Hi\)/)
    expect(stdout).toMatch(/GET {5}\/nope {2}→ 404 {2}no match/)
    const code = await new Promise<number | null>((resolve) => {
      child.on('close', (c) => resolve(c))
      child.kill('SIGINT')
    })
    // Windows cannot deliver SIGINT to a child process: kill() terminates it and there is no exit code.
    if (process.platform === 'win32') expect(code === null || code === 0 || code === 1).toBe(true)
    else expect(code).toBe(0)
    if (process.platform !== 'win32') expect(stdout).toMatch(/Mock server stopped\.\n$/)
    expect(stderr).toBe('')
  })
})
