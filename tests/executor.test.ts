import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { CookieJar } from 'tough-cookie'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executeRequest, type ExecutorDeps } from '../src/main/executor'
import type { ScriptVars } from '../src/main/sandbox'
import type { Collection, Folder, RequestDef } from '../src/shared/types'
import { newCollection, newFolder, newRequest } from '../src/shared/types'
import { cleanupTempDirs, echoServer, settings, tempDir } from './helpers'

let srv: Awaited<ReturnType<typeof echoServer>>
let tokenCalls = 0

beforeAll(async () => {
  srv = await echoServer({
    '/login': (_req, res) => {
      res.statusCode = 302
      res.setHeader('set-cookie', ['session=abc123; Path=/; HttpOnly', 'theme=dark; Path=/'])
      res.setHeader('location', '/me')
      res.end()
    },
    '/me': (req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }))
    },
    '/oauth/token': (_req, res, body) => {
      tokenCalls++
      res.setHeader('content-type', 'application/json')
      const form = new URLSearchParams(body.toString())
      res.end(JSON.stringify({ access_token: `tok-${form.get('scope')}-${tokenCalls}`, expires_in: 3600 }))
    },
    '/gzip': (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.setHeader('content-encoding', 'gzip')
      res.end(gzipSync(JSON.stringify({ compressed: true })))
    },
    '/slow': (_req, res) => {
      setTimeout(() => res.end('late'), 1500)
    },
    '/big': (_req, res) => {
      res.end('x'.repeat(5000))
    }
  })
})
afterAll(async () => {
  await srv.close()
  cleanupTempDirs()
})

function vars(): ScriptVars {
  return { global: {}, collection: {}, environment: {}, data: {}, local: {} }
}
function deps(extra: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return { settings: settings(), cookieJar: new CookieJar(), oauthCache: new Map(), ...extra }
}
async function run(request: RequestDef, opts: { collection?: Collection; folders?: Folder[]; vars?: ScriptVars; deps?: Partial<ExecutorDeps> } = {}) {
  const v = opts.vars ?? vars()
  const result = await executeRequest({ collection: opts.collection ?? null, folders: opts.folders ?? [], request, vars: v }, deps(opts.deps), { executionId: 'x' })
  return { result, vars: v, echo: result.response ? (JSON.parse(result.response.bodyText || 'null') as { method: string; url: string; headers: Record<string, string>; body: string; cookie?: string }) : null }
}

describe('request pipeline', () => {
  it('resolves auth through the inherit chain (collection → folder → request)', async () => {
    const req = newRequest({ url: `${srv.url}/echo`, auth: { type: 'inherit' } })
    const inner = newFolder({ name: 'inner', auth: { type: 'inherit' }, items: [req] })
    const outer = newFolder({ name: 'outer', auth: { type: 'inherit' }, items: [inner] })
    const col = newCollection({ auth: { type: 'basic', username: 'u', password: '{{pw}}' }, variables: [{ key: 'pw', value: 'p@ss', enabled: true, type: 'default' }], items: [outer] })
    const v = vars()
    v.collection = { pw: 'p@ss' }
    const a = await run(req, { collection: col, folders: [outer, inner], vars: v })
    expect(a.echo!.headers.authorization).toBe('Basic ' + Buffer.from('u:p@ss').toString('base64'))

    inner.auth = { type: 'bearer', token: 'folder-token' }
    const b = await run(req, { collection: col, folders: [outer, inner] })
    expect(b.echo!.headers.authorization).toBe('Bearer folder-token')

    const own = { ...req, auth: { type: 'apikey' as const, key: 'api_key', value: 'k 1', in: 'query' as const } }
    const c = await run(own, { collection: col, folders: [outer, inner] })
    expect(c.echo!.headers.authorization).toBeUndefined()
    expect(c.echo!.url).toBe('/echo?api_key=k%201')

    const none = { ...req, auth: { type: 'none' as const } }
    expect((await run(none, { collection: col, folders: [outer, inner] })).echo!.headers.authorization).toBeUndefined()
  })

  it('runs pre-request scripts collection → folder → request; a script can set a variable used by the request', async () => {
    const req = newRequest({
      method: 'POST',
      url: `${srv.url}/users/:id`,
      pathVariables: [{ key: 'id', value: '{{userId}}', enabled: true }],
      params: [{ key: 'trace', value: '{{trace}}', enabled: true }],
      headers: [{ key: 'X-Order', value: '{{order}}', enabled: true }],
      body: { mode: 'raw', language: 'json', raw: '{"user":"{{userId}}"}' },
      preRequestScript: "pm.variables.set('order', pm.variables.get('order') + ',request'); console.log('request')"
    })
    const folder = newFolder({ preRequestScript: "pm.variables.set('order', pm.variables.get('order') + ',folder'); console.log('folder')", items: [req] })
    const col = newCollection({
      preRequestScript: "pm.variables.set('order', 'collection'); pm.environment.set('userId', '42'); pm.variables.set('trace', 'a b'); console.log('collection')",
      items: [folder]
    })
    const { result, echo, vars: v } = await run(req, { collection: col, folders: [folder] })
    expect(result.error).toBeUndefined()
    expect(result.console.map((c) => `${c.source.level}:${c.message}`)).toEqual(['collection:collection', 'folder:folder', 'request:request'])
    expect(echo!.url).toBe('/users/42?trace=a%20b')
    expect(echo!.headers['x-order']).toBe('collection,folder,request')
    expect(echo!.headers['content-type']).toBe('application/json')
    expect(echo!.body).toBe('{"user":"42"}')
    expect(v.environment.userId).toBe('42')
    expect(result.mutations.filter((m) => m.scope === 'environment')).toEqual([{ scope: 'environment', key: 'userId', action: 'set', value: '42' }])
  })

  it('reports passing and failing tests from every level', async () => {
    const req = newRequest({ url: `${srv.url}/echo`, testScript: "pm.test('req ok', () => pm.response.to.have.status(200)); pm.test('req fails', () => pm.expect(pm.response.json().method).to.eql('POST'))" })
    const col = newCollection({ testScript: "pm.test('col json', () => pm.response.to.be.json)", items: [req] })
    const { result } = await run(req, { collection: col })
    expect(result.tests.map((t) => [t.source.level, t.name, t.passed])).toEqual([
      ['collection', 'col json', true],
      ['request', 'req ok', true],
      ['request', 'req fails', false]
    ])
    expect(result.tests[2].error).toBe("expected 'GET' to deeply equal 'POST'")
  })

  it('pm.sendRequest in a pre-request script fetches a token used by the main request', async () => {
    const req = newRequest({
      url: `${srv.url}/echo`,
      headers: [{ key: 'Authorization', value: 'Bearer {{fetched}}', enabled: true }],
      preRequestScript: `
        pm.sendRequest(
          { url: '${srv.url}/oauth/token', method: 'POST', body: { mode: 'urlencoded', urlencoded: [{ key: 'scope', value: 'script' }] } },
          (err, r) => pm.variables.set('fetched', r.json().access_token)
        );
      `
    })
    const { result, echo } = await run(req)
    expect(result.error).toBeUndefined()
    expect(echo!.headers.authorization).toMatch(/^Bearer tok-script-\d+$/)
  })

  it('follows redirects with the cookie jar; cookies are reused; redirects can be disabled', async () => {
    const jar = new CookieJar()
    const login = await run(newRequest({ url: `${srv.url}/login` }), { deps: { cookieJar: jar } })
    expect(login.result.response!.status).toBe(200)
    expect(login.result.response!.redirects).toEqual([{ status: 302, url: `${srv.url}/me` }])
    expect(login.echo).toEqual({ cookie: 'session=abc123; theme=dark' })
    expect(login.result.response!.finalUrl).toBe(`${srv.url}/me`)
    const again = await run(newRequest({ url: `${srv.url}/me` }), { deps: { cookieJar: jar } })
    expect(again.echo).toEqual({ cookie: 'session=abc123; theme=dark' })
    const noFollow = await run(newRequest({ url: `${srv.url}/login`, settings: { followRedirects: false } }), { deps: { cookieJar: new CookieJar() } })
    expect(noFollow.result.response!.status).toBe(302)
    expect(noFollow.result.response!.cookies.map((c) => c.name)).toEqual(['session', 'theme'])
    expect(noFollow.result.response!.cookies[0].httpOnly).toBe(true)
  })

  it('sends urlencoded, multipart (picked files only), graphql and binary bodies', async () => {
    const dir = tempDir()
    const file = join(dir, 'note.txt')
    writeFileSync(file, 'file-content')
    const allowed = { fileAllowed: (p: string) => p === file }

    const ue = await run(newRequest({ method: 'POST', url: `${srv.url}/e`, body: { mode: 'urlencoded', urlencoded: [{ key: 'a', value: '1 2', enabled: true }, { key: 'b', value: 'x', enabled: false }] } }))
    expect(ue.echo!.body).toBe('a=1%202')
    expect(ue.echo!.headers['content-type']).toBe('application/x-www-form-urlencoded')

    const fd = await run(
      newRequest({ method: 'POST', url: `${srv.url}/e`, body: { mode: 'formdata', formdata: [{ key: 't', value: 'text', enabled: true, kind: 'text' }, { key: 'f', value: '', enabled: true, kind: 'file', filePath: file }] } }),
      { deps: allowed }
    )
    expect(fd.echo!.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    expect(fd.echo!.body).toContain('name="f"; filename="note.txt"')
    expect(fd.echo!.body).toContain('file-content')

    const blocked = await run(newRequest({ method: 'POST', url: `${srv.url}/e`, body: { mode: 'binary', filePath: '/etc/hosts' } }), { deps: allowed })
    expect(blocked.result.error?.code).toBe('INVALID_ARGUMENT')
    expect(blocked.result.error?.message).toMatch(/Re-select/)
    expect(srv.requests.some((r) => r.body.includes('localhost') && r.url === '/e' && r.method === 'POST' && r.headers['content-type'] === 'application/octet-stream')).toBe(false)

    const bin = await run(newRequest({ method: 'PUT', url: `${srv.url}/e`, body: { mode: 'binary', filePath: file } }), { deps: allowed })
    expect(bin.echo!.body).toBe('file-content')
    expect(bin.echo!.headers['content-type']).toBe('application/octet-stream')

    const gql = await run(newRequest({ method: 'POST', url: `${srv.url}/e`, body: { mode: 'graphql', graphql: { query: '{ me { id } }', variables: '{"x":1}' } } }))
    expect(JSON.parse(gql.echo!.body)).toEqual({ query: '{ me { id } }', variables: { x: 1 } })
  })

  it('OAuth 2.0 client credentials: token fetched once and cached', async () => {
    const before = tokenCalls
    const auth = { type: 'oauth2' as const, grantType: 'client_credentials' as const, accessTokenUrl: `${srv.url}/oauth/token`, clientId: 'cid', clientSecret: 'cs', scope: 'orders', audience: '', clientAuthentication: 'header' as const }
    const cache = new Map()
    const a = await run(newRequest({ url: `${srv.url}/oauth-a`, auth }), { deps: { oauthCache: cache } })
    await run(newRequest({ url: `${srv.url}/oauth-b`, auth }), { deps: { oauthCache: cache } })
    expect(tokenCalls - before).toBe(1)
    const onWire = (path: string): string | undefined => srv.requests.filter((r) => r.url === path).at(-1)!.headers.authorization
    expect(onWire('/oauth-a')).toMatch(/^Bearer tok-orders-\d+$/)
    expect(onWire('/oauth-b')).toBe(onWire('/oauth-a'))
    // the acquired token never goes back to the renderer (request info and echoed response are masked)
    expect(a.result.request.headers.find(([k]) => k === 'Authorization')![1]).toBe('Bearer ••••')
    expect(JSON.stringify(a.result)).not.toContain(onWire('/oauth-a')!.slice(7))
    const tokenReq = srv.requests.filter((r) => r.url === '/oauth/token').at(-1)!
    expect(tokenReq.headers.authorization).toBe('Basic ' + Buffer.from('cid:cs').toString('base64'))
  })

  it('entra auth uses the signed-in identity token for the configured scope', async () => {
    const scopes: string[] = []
    const { result } = await run(newRequest({ url: `${srv.url}/entra`, auth: { type: 'entra', scope: 'api://my-api/.default' } }), {
      deps: { tokens: { getToken: async (s) => (scopes.push(s), 'entra-token-xyz') } }
    })
    expect(scopes).toEqual(['api://my-api/.default'])
    expect(srv.requests.filter((r) => r.url === '/entra').at(-1)!.headers.authorization).toBe('Bearer entra-token-xyz')
    expect(JSON.stringify(result)).not.toContain('entra-token-xyz')
    const noIdentity = await run(newRequest({ url: `${srv.url}/e`, auth: { type: 'entra', scope: 'x' } }))
    expect(noIdentity.result.error?.code).toBe('NOT_SIGNED_IN')
  })

  it('decodes gzip, truncates huge bodies, times out and reports network errors', async () => {
    const gz = await run(newRequest({ url: `${srv.url}/gzip` }))
    expect(gz.echo).toEqual({ compressed: true })
    expect(srv.requests.find((r) => r.url === '/gzip')!.headers['accept-encoding']).toBe('gzip, deflate, br')

    const big = await executeRequest({ collection: null, folders: [], request: newRequest({ url: `${srv.url}/big` }), vars: vars() }, { settings: { ...settings(), http: { ...settings().http, maxResponseBytes: 1024 } } }, { executionId: 'b' })
    expect(big.response!.truncated).toBe(true)
    expect(big.response!.bodyText.length).toBe(1024)
    expect(big.response!.sizeBytes).toBe(5000)

    const slow = await run(newRequest({ url: `${srv.url}/slow`, settings: { timeoutMs: 200 } }))
    expect(slow.result.error).toEqual({ code: 'TIMEOUT', message: 'Request timed out after 200 ms.' })

    const refused = await run(newRequest({ url: 'http://127.0.0.1:1/x' }))
    expect(refused.result.error?.code).toBe('NETWORK')
    expect(refused.result.error?.message).toMatch(/Connection refused/)
  })

  it('a cancelled request stops; a failing pre-request script prevents the send', async () => {
    const ac = new AbortController()
    const p = executeRequest({ collection: null, folders: [], request: newRequest({ url: `${srv.url}/slow` }), vars: vars() }, deps(), { executionId: 'c', signal: ac.signal })
    setTimeout(() => ac.abort(), 100)
    expect((await p).error?.code).toBe('CANCELLED')

    const n = srv.requests.length
    const bad = await run(newRequest({ url: `${srv.url}/never`, preRequestScript: 'throw new Error("nope")' }))
    expect(bad.result.error?.code).toBe('SCRIPT_ERROR')
    expect(bad.result.error?.message).toMatch(/nope/)
    expect(srv.requests.length).toBe(n)
  })
})
