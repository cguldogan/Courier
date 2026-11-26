/**
 * OAuth 2.0 authorization code + PKCE end to end against a local fake IdP. The "system browser" is
 * an injected opener that fetches the authorize URL and follows the redirect to Courier's loopback
 * listener, as a browser would. The IdP checks client id, redirect URI, state round-trip and the S256
 * code challenge itself. Team collections use Azurite (local) for the team container.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeCredential } from '../src/main/azure'
import { createContainerClient } from '../src/main/blobsync'
import type { CourierCore } from '../src/main/core'
import type { SecretBox } from '../src/main/oauth'
import { newRequest, type Auth } from '../src/shared/types'
import { ID_A, cleanupTempDirs, echoServer, readTree, seedManifest, teamClient, tempDir } from './helpers'

// Ask the OS for a free port: a random number can fall in a range Windows reserves (listen EACCES).
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const p = (probe.address() as AddressInfo).port
      probe.close(() => resolve(p))
    })
  })
}

const ACCOUNT = process.env.COURIER_TEST_AZURITE as string

interface Issued {
  access: string
  refresh: string
}
let idp: Awaited<ReturnType<typeof echoServer>>
let api: Awaited<ReturnType<typeof echoServer>>
const codes = new Map<string, { challenge?: string; redirectUri: string; clientId: string }>()
const tokens = new Map<string, Issued>()
let expiresIn = 3600
let refreshCalls = 0
let authorizeCalls = 0
let lastTokenRequest: { form: URLSearchParams; authorization?: string } | null = null

const s256 = (v: string): string => createHash('sha256').update(v).digest('base64url')

beforeAll(async () => {
  idp = await echoServer({
    '/authorize': (req, res) => {
      authorizeCalls++
      const u = new URL(req.url ?? '/', 'http://idp')
      const q = u.searchParams
      const redirect = q.get('redirect_uri') ?? ''
      if (q.get('client_id') !== 'courier-app' || !/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirect) || q.get('response_type') !== 'code') {
        res.statusCode = 400
        return void res.end('bad authorize request')
      }
      if (q.has('code_challenge') && q.get('code_challenge_method') !== 'S256') {
        res.statusCode = 400
        return void res.end('only S256')
      }
      const code = randomBytes(8).toString('hex')
      codes.set(code, { challenge: q.get('code_challenge') ?? undefined, redirectUri: redirect, clientId: q.get('client_id')! })
      const back = new URL(redirect)
      back.searchParams.set('code', code)
      back.searchParams.set('state', q.get('state') ?? '')
      res.statusCode = 302
      res.setHeader('location', back.toString())
      res.end()
    },
    '/token': (req, res, body) => {
      const form = new URLSearchParams(body.toString())
      lastTokenRequest = { form, authorization: req.headers.authorization }
      res.setHeader('content-type', 'application/json')
      const issue = (): void => {
        const t = { access: `at-${randomBytes(12).toString('hex')}`, refresh: `rt-${randomBytes(12).toString('hex')}` }
        tokens.set(t.refresh, t)
        res.end(JSON.stringify({ access_token: t.access, refresh_token: t.refresh, token_type: 'Bearer', expires_in: expiresIn }))
      }
      const fail = (error: string): void => {
        res.statusCode = 400
        res.end(JSON.stringify({ error }))
      }
      if (form.get('grant_type') === 'authorization_code') {
        const c = codes.get(form.get('code') ?? '')
        codes.delete(form.get('code') ?? '')
        if (!c || c.redirectUri !== form.get('redirect_uri')) return fail('invalid_grant')
        if (c.challenge && s256(form.get('code_verifier') ?? '') !== c.challenge) return fail('invalid_grant')
        const basic = req.headers.authorization?.startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString() : null
        const clientId = basic ? decodeURIComponent(basic.split(':')[0]) : form.get('client_id')
        if (clientId !== c.clientId) return fail('invalid_client')
        return issue()
      }
      if (form.get('grant_type') === 'refresh_token') {
        refreshCalls++
        if (!tokens.has(form.get('refresh_token') ?? '')) return fail('invalid_grant')
        tokens.delete(form.get('refresh_token') ?? '')
        return issue()
      }
      fail('unsupported_grant_type')
    }
  })
  api = await echoServer()
})
afterAll(async () => {
  await idp.close()
  await api.close()
  cleanupTempDirs()
})
beforeEach(() => {
  expiresIn = 3600
})

/** A fake browser: GET the authorize URL, follow its redirect to the loopback listener. */
function browser(tamper?: (callback: URL) => void): { open: (url: string) => Promise<void>; opened: string[] } {
  const opened: string[] = []
  return {
    opened,
    open: async (url: string) => {
      opened.push(url)
      const r = await fetch(url, { redirect: 'manual' })
      const loc = r.headers.get('location')
      if (!loc) return
      const cb = new URL(loc)
      tamper?.(cb)
      void fetch(cb).then((x) => x.text()).catch(() => undefined)
    }
  }
}

/** Stand-in for Electron safeStorage: AES-256-GCM with a key that never touches disk. */
function testBox(): SecretBox {
  const key = randomBytes(32)
  return {
    encrypt: (plain) => {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', key, iv)
      const data = Buffer.concat([c.update(plain, 'utf8'), c.final()])
      return Buffer.concat([iv, c.getAuthTag(), data])
    },
    decrypt: (b) => {
      const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
      d.setAuthTag(b.subarray(12, 28))
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')
    }
  }
}

async function core(opts: { box?: SecretBox | null; open?: (url: string) => Promise<void>; userDataDir?: string } = {}): Promise<CourierCore> {
  const { CourierCore } = await import('../src/main/core')
  const c = new CourierCore({ userDataDir: opts.userDataDir ?? tempDir('courier-oauth-'), secretBox: opts.box === undefined ? testBox() : opts.box, openExternal: opts.open, oauthTimeoutMs: 5000 })
  await c.init()
  return c
}

const AUTH = (over: Partial<Extract<Auth, { type: 'oauth2' }>> = {}): Extract<Auth, { type: 'oauth2' }> => ({
  type: 'oauth2',
  grantType: 'authorization_code',
  authUrl: '{{idp}}/authorize',
  accessTokenUrl: '{{idp}}/token',
  clientId: 'courier-app',
  clientSecret: '',
  scope: 'orders.read',
  audience: '',
  clientAuthentication: 'body',
  redirectUri: '',
  pkce: true,
  extraParams: 'prompt=consent',
  ...over
})

/** Personal collection with `idp` as a collection variable and one request using `auth`. */
async function setup(c: CourierCore, auth: Auth = AUTH(), teamId: string | null = null): Promise<{ collectionId: string; requestId: string }> {
  const { collection } = await c.createCollection({ name: 'OAuth', teamId })
  const req = newRequest({ name: 'Orders', url: `${api.url}/orders`, auth })
  await c.saveCollection({ ...collection, variables: [{ key: 'idp', value: idp.url, enabled: true, type: 'default' }], items: [req] })
  return { collectionId: collection.id, requestId: req.id }
}

const bearerSent = (): string => String(api.requests.at(-1)?.headers.authorization ?? '')

describe('OAuth 2.0 authorization code + PKCE', () => {
  it('Get new token: system browser → loopback redirect → PKCE-checked code exchange; the send uses the token, masked everywhere', async () => {
    const b = browser()
    const c = await core({ open: b.open })
    const { collectionId, requestId } = await setup(c)
    const auth = AUTH()
    expect((await c.oauthStatus({ auth, collectionId })).hasToken).toBe(false)
    // Send never opens a browser: without a token it fails with AUTH_REQUIRED.
    const before = await c.send({ collectionId, requestId })
    expect(before.error?.code).toBe('AUTH_REQUIRED')
    expect(b.opened).toHaveLength(0)

    const got = await c.oauthGetNewToken({ auth, collectionId })
    expect(got.status).toBe('ok')
    const opened = new URL(b.opened[0])
    expect(opened.origin).toBe(idp.url)
    expect(opened.searchParams.get('code_challenge_method')).toBe('S256')
    expect(opened.searchParams.get('prompt')).toBe('consent')
    expect(opened.searchParams.get('state')).toMatch(/^[\w-]{20,}$/)
    expect(lastTokenRequest?.form.get('code_verifier')).toBeTruthy()
    const status = got.status === 'ok' ? got.token : null
    expect(status).toMatchObject({ hasToken: true, refreshable: true, expired: false, storage: 'encrypted', authHost: new URL(idp.url).host, needsApproval: false })
    expect(status?.preview).toMatch(/^at-…[0-9a-f]{3}$/)

    const result = await c.send({ collectionId, requestId })
    expect(result.response?.status).toBe(200)
    const token = bearerSent().slice(7)
    expect(token).toMatch(/^at-[0-9a-f]{24}$/)
    expect(JSON.stringify(result)).not.toContain(token)
    expect(result.request.headers.find(([k]) => k === 'Authorization')?.[1]).toBe('Bearer ••••')
    expect(JSON.stringify(await c.listHistory())).not.toContain(token)
    expect(JSON.stringify(await c.oauthStatus({ auth, collectionId }))).not.toContain(token)
  })

  it('tokens are never written to disk in plain text: encrypted file with a keystore, no file without one', async () => {
    const dir = tempDir('courier-oauth-ud-')
    const c = await core({ open: browser().open, userDataDir: dir })
    const { collectionId, requestId } = await setup(c)
    await c.oauthGetNewToken({ auth: AUTH(), collectionId })
    await c.send({ collectionId, requestId })
    const token = bearerSent().slice(7)
    const refresh = [...tokens.values()].find((t) => t.access === token)!.refresh
    expect(existsSync(join(dir, 'oauth-tokens.bin'))).toBe(true)
    for (const f of readTree(dir)) {
      expect(f.content, f.path).not.toContain(token)
      expect(f.content, f.path).not.toContain(refresh)
    }
    // A new process with the same keystore reads the token back.
    const box = testBox()
    const dir2 = tempDir('courier-oauth-ud2-')
    const c2 = await core({ open: browser().open, userDataDir: dir2, box })
    const s2 = await setup(c2)
    await c2.oauthGetNewToken({ auth: AUTH(), collectionId: s2.collectionId })
    const c3 = await core({ userDataDir: dir2, box })
    expect((await c3.oauthStatus({ auth: AUTH(), collectionId: s2.collectionId })).hasToken).toBe(true)

    // Without encryption: memory only, nothing written.
    const dir4 = tempDir('courier-oauth-mem-')
    const c4 = await core({ open: browser().open, userDataDir: dir4, box: null })
    const s4 = await setup(c4)
    const got = await c4.oauthGetNewToken({ auth: AUTH(), collectionId: s4.collectionId })
    expect(got.status === 'ok' && got.token.storage).toBe('memory')
    expect((await c4.send({ collectionId: s4.collectionId, requestId: s4.requestId })).response?.status).toBe(200)
    expect(existsSync(join(dir4, 'oauth-tokens.bin'))).toBe(false)
    const memToken = bearerSent().slice(7)
    for (const f of readTree(dir4)) expect(f.content, f.path).not.toContain(memToken)
    const c5 = await core({ userDataDir: dir4, box: null })
    expect((await c5.oauthStatus({ auth: AUTH(), collectionId: s4.collectionId })).hasToken).toBe(false)
  })

  it('rejects a redirect with the wrong state (no code exchange happens)', async () => {
    const b = browser((cb) => cb.searchParams.set('state', 'forged-state'))
    const c = await core({ open: b.open })
    const { collectionId } = await setup(c)
    lastTokenRequest = null
    await expect(c.oauthGetNewToken({ auth: AUTH(), collectionId })).rejects.toMatchObject({ code: 'AUTH_FAILED', message: expect.stringMatching(/state/) })
    expect(lastTokenRequest).toBeNull()
    expect((await c.oauthStatus({ auth: AUTH(), collectionId })).hasToken).toBe(false)
  })

  it('refreshes automatically shortly before expiry (single-flight), and uses the new token', async () => {
    const c = await core({ open: browser().open })
    const { collectionId, requestId } = await setup(c)
    expiresIn = 30 // inside the 60 s refresh margin
    await c.oauthGetNewToken({ auth: AUTH(), collectionId })
    await c.send({ collectionId, requestId })
    const first = bearerSent()
    const calls = refreshCalls
    // Two concurrent sends share one refresh.
    expiresIn = 3600
    const [a, b] = await Promise.all([c.send({ collectionId, requestId }), c.send({ collectionId, requestId })])
    expect([a.response?.status, b.response?.status]).toEqual([200, 200])
    expect(refreshCalls).toBe(calls + 1)
    expect(bearerSent()).not.toBe(first)
    expect(lastTokenRequest?.form.get('grant_type')).toBe('refresh_token')
  })

  it('a rejected refresh token drops the token and asks for a new one', async () => {
    const c = await core({ open: browser().open })
    const { collectionId, requestId } = await setup(c)
    expiresIn = 10
    await c.oauthGetNewToken({ auth: AUTH(), collectionId })
    tokens.clear() // the IdP revoked every refresh token
    const r = await c.send({ collectionId, requestId })
    expect(r.error?.code).toBe('AUTH_REQUIRED')
    expect((await c.oauthStatus({ auth: AUTH(), collectionId })).hasToken).toBe(false)
  })

  it('plain authorization code (no PKCE) with a client secret in the Basic header; fixed redirect port', async () => {
    const port = await freePort()
    const b = browser()
    const c = await core({ open: b.open })
    const auth = AUTH({ pkce: false, clientSecret: 'app-Secret-77', clientAuthentication: 'header', redirectUri: `http://127.0.0.1:${port}/callback` })
    const { collectionId } = await setup(c, auth)
    expect((await c.oauthGetNewToken({ auth, collectionId })).status).toBe('ok')
    expect(new URL(b.opened[0]).searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${port}/callback`)
    expect(new URL(b.opened[0]).searchParams.has('code_challenge')).toBe(false)
    expect(lastTokenRequest?.authorization).toBe('Basic ' + Buffer.from('courier-app:app-Secret-77').toString('base64'))
    expect(lastTokenRequest?.form.has('code_verifier')).toBe(false)
  })

  it('refuses non-loopback redirect URIs and non-http(s) authorize URLs before opening anything', async () => {
    const b = browser()
    const c = await core({ open: b.open })
    const { collectionId } = await setup(c)
    await expect(c.oauthGetNewToken({ auth: AUTH({ redirectUri: 'https://evil.example.com/cb' }), collectionId })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(c.oauthGetNewToken({ auth: AUTH({ authUrl: 'file:///etc/passwd' }), collectionId })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(b.opened).toHaveLength(0)
  })

  it('gives up with TIMEOUT when the browser never comes back, and frees the redirect port', async () => {
    const { CourierCore } = await import('../src/main/core')
    const c = new CourierCore({ userDataDir: tempDir('courier-oauth-to-'), secretBox: testBox(), openExternal: async () => undefined, oauthTimeoutMs: 300 })
    await c.init()
    const port = await freePort()
    const auth = AUTH({ redirectUri: `http://localhost:${port}/callback` })
    const { collectionId } = await setup(c, auth)
    await expect(c.oauthGetNewToken({ auth, collectionId })).rejects.toMatchObject({ code: 'TIMEOUT' })
    await expect(c.oauthGetNewToken({ auth, collectionId })).rejects.toMatchObject({ code: 'TIMEOUT' }) // port is free again
  })

  it('cancel stops a pending sign-in', async () => {
    const c = await core({ open: async () => undefined }) // a browser the user never finishes
    const { collectionId } = await setup(c)
    const p = c.oauthGetNewToken({ auth: AUTH(), collectionId })
    await new Promise((r) => setTimeout(r, 100))
    expect(c.oauth.cancel()).toBe(true)
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it('a blocked test script sees the echoed token masked', async () => {
    const c = await core({ open: browser().open })
    const { collection } = await c.createCollection({ name: 'S', teamId: null })
    const req = newRequest({ name: 'Echo', url: `${api.url}/e`, auth: AUTH(), testScript: "console.log(pm.response.text()); pm.sendRequest('" + api.url + "/leak?x=' + encodeURIComponent(pm.response.text()));" })
    await c.saveCollection({ ...collection, variables: [{ key: 'idp', value: idp.url, enabled: true, type: 'default' }], items: [req] })
    await c.oauthGetNewToken({ auth: AUTH(), collectionId: collection.id })
    const r = await c.send({ collectionId: collection.id, requestId: req.id })
    const token = String(api.requests.find((x) => x.url === '/e')?.headers.authorization).slice(7)
    expect(r.console[0].message).toContain('Bearer ••••')
    expect(api.requests.at(-1)!.url).toMatch(/^\/leak/)
    expect(decodeURIComponent(api.requests.at(-1)!.url)).not.toContain(token)
  })
})

describe('team collections: the authorize / token hosts are teammate-controlled', () => {
  let container = ''
  beforeEach(async () => {
    container = `o${Math.random().toString(36).slice(2, 12)}`
    await createContainerClient(ACCOUNT, container, new FakeCredential(ID_A)).create()
    await seedManifest(ACCOUNT, container, { name: 'OAuth team' })
  })

  it('shows the hosts before the first acquisition; approval is per team + hosts, and a changed host asks again', async () => {
    const b = browser()
    const { core: c, teamId } = await teamClient({ accountUrl: ACCOUNT, container, openExternal: b.open })
    const { collectionId, requestId } = await setup(c, AUTH(), teamId)
    const host = new URL(idp.url).host
    expect(await c.oauthStatus({ auth: AUTH(), collectionId })).toMatchObject({ needsApproval: true, authHost: host, tokenHost: host })
    const first = await c.oauthGetNewToken({ auth: AUTH(), collectionId })
    expect(first).toEqual({ status: 'approval-required', authHost: host, tokenHost: host })
    expect(b.opened).toHaveLength(0)
    // Approving hosts other than the ones the config resolves to is refused.
    await expect(c.oauthGetNewToken({ auth: AUTH(), collectionId, approveHosts: { authHost: 'login.contoso.test', tokenHost: host } })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(b.opened).toHaveLength(0)
    const ok = await c.oauthGetNewToken({ auth: AUTH(), collectionId, approveHosts: { authHost: host, tokenHost: host } })
    expect(ok.status).toBe('ok')
    expect((await c.send({ collectionId, requestId })).response?.status).toBe(200)
    // Approved now: no prompt the second time.
    expect((await c.oauthGetNewToken({ auth: AUTH(), collectionId })).status).toBe('ok')
    // A teammate points the token URL at another host (here: the API server) → new key, new prompt.
    const moved = AUTH({ accessTokenUrl: `${api.url.replace('127.0.0.1', 'localhost')}/token` })
    expect((await c.oauthStatus({ auth: moved, collectionId })).hasToken).toBe(false)
    expect((await c.oauthGetNewToken({ auth: moved, collectionId })).status).toBe('approval-required')
    // A Personal collection with the same settings does not see the team's token.
    const personal = await setup(c)
    expect((await c.oauthStatus({ auth: AUTH(), collectionId: personal.collectionId })).hasToken).toBe(false)
  })
})

