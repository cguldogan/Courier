/**
 * HTTP Digest (RFC 7616): the RFC's own worked example (section 3.9.1, MD5 and SHA-256,
 * https://www.rfc-editor.org/rfc/rfc7616.txt, fetched 2026-11-23), then a local server that issues
 * challenges and verifies responses with its own (independent) hash computation: MD5, SHA-256,
 * qop=auth and auth-int, opaque, nonce count, nonce reuse and stale-nonce retry.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { CookieJar } from 'tough-cookie'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { digestAuthorization, parseDigestAuthorization, parseDigestChallenges } from '../src/main/auth/digest'
import type { DigestCache } from '../src/main/auth/send-auth'
import { executeRequest } from '../src/main/executor'
import { newRequest, type RequestDef } from '../src/shared/types'
import { listen, readBody, settings, type Listening } from './helpers'

describe('RFC 7616 section 3.9.1 example', () => {
  const header = [
    'Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=SHA-256, nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"',
    'Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=MD5, nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"'
  ]
  const challenges = parseDigestChallenges(header)
  const base = { username: 'Mufasa', password: 'Circle of Life', method: 'GET', uri: '/dir/index.html', nc: 1, cnonce: 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ' }
  it('parses both challenges, SHA-256 first', () => {
    expect(challenges.map((c) => c.algorithm)).toEqual(['SHA-256', 'MD5'])
    expect(challenges[0].qop).toEqual(['auth', 'auth-int'])
    expect(challenges[0].opaque).toBe('FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS')
  })
  it('SHA-256 response', () => {
    const r = digestAuthorization({ ...base, challenge: challenges[0] })
    expect(r.response).toBe('753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1')
    const p = parseDigestAuthorization(r.header)!
    expect(p).toMatchObject({ username: 'Mufasa', realm: 'http-auth@example.org', uri: '/dir/index.html', algorithm: 'SHA-256', nc: '00000001', qop: 'auth', opaque: 'FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS' })
  })
  it('MD5 response', () => {
    expect(digestAuthorization({ ...base, challenge: challenges[1] }).response).toBe('8ca523f5e9506fed4657c9700eebdbec')
  })
})

describe('-sess algorithms and userhash (computed independently here)', () => {
  it('SHA-256-sess with userhash', () => {
    const [c] = parseDigestChallenges(['Digest realm="r", nonce="n1", qop="auth", algorithm=SHA-256-sess, userhash=true'])
    expect(c).toMatchObject({ algorithm: 'SHA-256-sess', userhash: true })
    const r = digestAuthorization({ challenge: c, username: 'u', password: 'p', method: 'GET', uri: '/x', nc: 1, cnonce: 'cn' })
    const h = (s: string): string => createHash('sha256').update(s).digest('hex')
    const ha1 = h(`${h('u:r:p')}:n1:cn`)
    expect(r.response).toBe(h(`${ha1}:n1:00000001:cn:auth:${h('GET:/x')}`))
    const p = parseDigestAuthorization(r.header)!
    expect(p.username).toBe(h('u:r'))
    expect(p.userhash).toBe('true')
  })
  it('MD5-sess and RFC 2069 (no qop)', () => {
    const md5 = (s: string): string => createHash('md5').update(s).digest('hex')
    const [sess] = parseDigestChallenges(['Digest realm="r", nonce="n", qop="auth", algorithm=MD5-sess'])
    expect(digestAuthorization({ challenge: sess, username: 'u', password: 'p', method: 'GET', uri: '/', nc: 2, cnonce: 'c' }).response).toBe(md5(`${md5(`${md5('u:r:p')}:n:c`)}:n:00000002:c:auth:${md5('GET:/')}`))
    const [old] = parseDigestChallenges(['Digest realm="r", nonce="n"'])
    const r = digestAuthorization({ challenge: old, username: 'u', password: 'p', method: 'GET', uri: '/', nc: 1 })
    expect(r.response).toBe(md5(`${md5('u:r:p')}:n:${md5('GET:/')}`))
    expect(r.header).not.toMatch(/qop=|nc=/)
  })
})

// -----------------------------------------------------------------------------------------------

const USER = 'digest-user'
const PASSWORD = 'D1gest-Pa55!'
const REALM = 'courier-test@contoso.test'

interface Mode {
  algorithm: 'MD5' | 'SHA-256'
  qop: string
  /** Each nonce is accepted this many times, then answered with stale=true. */
  maxUses: number
}
let mode: Mode = { algorithm: 'MD5', qop: 'auth', maxUses: 100 }
const nonces = new Map<string, { uses: number; lastNc: number }>()
const seen: { auth?: Record<string, string>; status: number; stale?: boolean }[] = []
let server: Listening

function H(alg: string, s: string | Buffer): string {
  return createHash(alg === 'SHA-256' ? 'sha256' : 'md5').update(s).digest('hex')
}

function challenge(res: ServerResponse, stale = false): void {
  const nonce = randomBytes(12).toString('base64')
  nonces.set(nonce, { uses: 0, lastNc: 0 })
  res.statusCode = 401
  res.setHeader('www-authenticate', `Digest realm="${REALM}", qop="${mode.qop}", algorithm=${mode.algorithm}, nonce="${nonce}", opaque="op-4711"${stale ? ', stale=true' : ''}`)
  res.end('unauthorized')
}

function handler(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const header = req.headers.authorization
  const p = header ? parseDigestAuthorization(header) : null
  if (!p) {
    seen.push({ status: 401 })
    return challenge(res)
  }
  const state = nonces.get(p.nonce)
  const nc = parseInt(p.nc, 16)
  if (!state || state.uses >= mode.maxUses) {
    seen.push({ auth: p, status: 401, stale: true })
    return challenge(res, true)
  }
  const ha1 = H(mode.algorithm, `${USER}:${REALM}:${PASSWORD}`)
  const ha2 = p.qop === 'auth-int' ? H(mode.algorithm, `${req.method}:${p.uri}:${H(mode.algorithm, body)}`) : H(mode.algorithm, `${req.method}:${p.uri}`)
  const expected = H(mode.algorithm, `${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`)
  const ok = p.username === USER && p.realm === REALM && p.uri === req.url && p.opaque === 'op-4711' && p.algorithm === mode.algorithm && p.response === expected && nc > state.lastNc
  if (!ok) {
    seen.push({ auth: p, status: 401 })
    return challenge(res)
  }
  state.uses++
  state.lastNc = nc
  seen.push({ auth: p, status: 200 })
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ ok: true, nc: p.nc }))
}

beforeAll(async () => {
  server = await listen(createServer(async (req, res) => handler(req, res, await readBody(req))))
})
afterAll(async () => {
  await server.close()
})

const vars = () => ({ global: {}, collection: {}, environment: {}, data: {}, local: {} })
const run = (request: RequestDef, digestCache?: DigestCache) => executeRequest({ collection: null, folders: [], request, vars: vars() }, { settings: settings(), cookieJar: new CookieJar(), digestCache }, { executionId: 'd' })
const auth = { type: 'digest' as const, username: USER, password: PASSWORD }

describe('Digest against a local server', () => {
  for (const algorithm of ['MD5', 'SHA-256'] as const) {
    it(`${algorithm}, qop=auth: challenge → authorized; header masked`, async () => {
      mode = { algorithm, qop: 'auth', maxUses: 100 }
      seen.length = 0
      const result = await run(newRequest({ url: `${server.url}/dir/index.html?x=1`, auth }))
      expect(result.response?.status).toBe(200)
      expect(seen.map((s) => s.status)).toEqual([401, 200])
      expect(seen[1].auth).toMatchObject({ algorithm, qop: 'auth', nc: '00000001', uri: '/dir/index.html?x=1' })
      expect(result.request.headers.find(([k]) => k === 'Authorization')?.[1]).toBe('••••')
    })
  }

  it('qop=auth-int hashes the body', async () => {
    mode = { algorithm: 'SHA-256', qop: 'auth-int', maxUses: 100 }
    seen.length = 0
    const result = await run(newRequest({ method: 'POST', url: `${server.url}/upload`, body: { mode: 'raw', language: 'json', raw: '{"a":1}' }, auth }))
    expect(result.response?.status).toBe(200)
    expect(seen[1].auth?.qop).toBe('auth-int')
  })

  it('reuses a nonce with an increasing nonce count, and retries once on stale=true', async () => {
    mode = { algorithm: 'MD5', qop: 'auth', maxUses: 2 }
    const cache: DigestCache = new Map()
    seen.length = 0
    const r1 = await run(newRequest({ url: `${server.url}/a`, auth }), cache)
    const r2 = await run(newRequest({ url: `${server.url}/b`, auth }), cache)
    expect([r1.response?.status, r2.response?.status]).toEqual([200, 200])
    // 1st: challenge + nc=1; 2nd: preemptive with the same nonce, nc=2.
    expect(seen.map((s) => `${s.status}:${s.auth?.nc ?? '-'}`)).toEqual(['401:-', '200:00000001', '200:00000002'])
    expect(seen[2].auth?.nonce).toBe(seen[1].auth?.nonce)
    // 3rd: the nonce is used up → stale=true → one retry with the new nonce, nc back to 1.
    seen.length = 0
    const r3 = await run(newRequest({ url: `${server.url}/c`, auth }), cache)
    expect(r3.response?.status).toBe(200)
    expect(seen.map((s) => `${s.status}:${s.auth?.nc ?? '-'}${s.stale ? ':stale' : ''}`)).toEqual(['401:00000003:stale', '200:00000001'])
  })

  it('new auth types inherit from a folder like the existing ones', async () => {
    mode = { algorithm: 'SHA-256', qop: 'auth', maxUses: 100 }
    seen.length = 0
    const folder = { type: 'folder' as const, id: 'f', name: 'F', description: '', auth, preRequestScript: '', testScript: '', items: [] }
    const request = newRequest({ url: `${server.url}/inherited`, auth: { type: 'inherit' } })
    const result = await executeRequest({ collection: null, folders: [folder], request, vars: vars() }, { settings: settings(), cookieJar: new CookieJar() }, { executionId: 'i' })
    expect(result.response?.status).toBe(200)
    expect(seen.map((x) => x.status)).toEqual([401, 200])
  })

  it('a wrong password ends with 401 after one answer (no loop)', async () => {
    mode = { algorithm: 'MD5', qop: 'auth', maxUses: 100 }
    seen.length = 0
    const result = await run(newRequest({ url: `${server.url}/x`, auth: { ...auth, password: 'nope' } }))
    expect(result.response?.status).toBe(401)
    expect(seen).toHaveLength(2)
  })
})
