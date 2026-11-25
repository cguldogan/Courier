// Local test infrastructure for the e2e drive script. Nothing here touches a real Azure resource:
//  - a throw-away self-signed cert for 127.0.0.1 (node:crypto, no openssl binary needed),
//  - Azurite (blob) over HTTPS with `--oauth basic` (accepts the fake unsigned JWTs),
//  - a mock Key Vault speaking the secrets REST API incl. the 401 bearer challenge,
//  - a plain HTTP echo server.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { writeSelfSignedCert } from '../tests/fixtures/selfsigned.mjs'

export const ROOT = resolve(import.meta.dirname, '..')

export function makeCert() {
  const dir = mkdtempSync(join(tmpdir(), 'courier-e2e-pki-'))
  const cert = join(dir, 'cert.pem')
  const key = join(dir, 'key.pem')
  writeSelfSignedCert(cert, key)
  return { dir, cert, key, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
}

export async function freePort() {
  return new Promise((res, rej) => {
    const s = createNetServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
    s.on('error', rej)
  })
}

async function waitForPort(port, timeoutMs) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const ok = await new Promise((res) => {
      const c = connect(port, '127.0.0.1')
      c.once('connect', () => {
        c.destroy()
        res(true)
      })
      c.once('error', () => res(false))
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`nothing listening on ${port}`)
}

export async function startAzurite(pki) {
  const port = await freePort()
  const main = join(ROOT, 'node_modules/azurite/dist/src/blob/main.js')
  const proc = spawn(process.execPath, [
    main, '--blobHost', '127.0.0.1', '--blobPort', String(port), '--oauth', 'basic', '--cert', pki.cert, '--key', pki.key,
    '--inMemoryPersistence', '--disableTelemetry', '--silent', '--skipApiVersionCheck', '--loose'
  ], { stdio: ['ignore', 'ignore', 'pipe'], cwd: pki.dir })
  let stderr = ''
  proc.stderr.on('data', (d) => (stderr += String(d)))
  try {
    await waitForPort(port, 20_000)
  } catch (err) {
    proc.kill()
    throw new Error(`Azurite did not start: ${err.message}\n${stderr}`)
  }
  // stop() resolves once Azurite has exited (its cwd, the cert directory, can then be removed on Windows too).
  const exited = new Promise((r) => (proc.exitCode !== null || proc.signalCode !== null ? r() : proc.once('exit', () => r())))
  return { url: `https://127.0.0.1:${port}/devstoreaccount1`, stop: () => (proc.kill(), exited) }
}

const b64url = (s) => Buffer.from(s).toString('base64url')
/** Same shape as src/main/azure.ts mintFakeJwt — unsigned, accepted by Azurite --oauth basic. */
export function fakeJwt(id, scope) {
  const now = Math.floor(Date.now() / 1000)
  const aud = scope.replace(/\/\.default$/, '').replace(/\/$/, '')
  const payload = { aud, iss: `https://sts.windows.net/${id.tid}/`, iat: now - 5, nbf: now - 5, exp: now + 3600, oid: id.oid, tid: id.tid, sub: id.oid, name: id.name, upn: id.upn, scp: 'user_impersonation', ver: '1.0' }
  return `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.`
}

/** Create a blob container in Azurite with a bearer token (REST, no SDK, no keys). */
export async function createContainer(accountUrl, container, id, caFile) {
  const { request } = await import('node:https')
  const url = new URL(`${accountUrl}/${container}?restype=container`)
  await new Promise((res, rej) => {
    const req = request(url, {
      method: 'PUT',
      ca: readFileSync(caFile),
      headers: { authorization: `Bearer ${fakeJwt(id, 'https://storage.azure.com/.default')}`, 'x-ms-version': '2021-12-02', 'x-ms-date': new Date().toUTCString(), 'content-length': 0 }
    }, (r) => {
      r.resume()
      r.on('end', () => (r.statusCode === 201 ? res() : rej(new Error(`create container: HTTP ${r.statusCode}`))))
    })
    req.on('error', rej)
    req.end()
  })
}

/** Delete a blob container in Azurite with a bearer token (simulates a team whose container is gone). */
export async function deleteContainer(accountUrl, container, id, caFile) {
  const { request } = await import('node:https')
  const url = new URL(`${accountUrl}/${container}?restype=container`)
  await new Promise((res, rej) => {
    const req = request(url, {
      method: 'DELETE',
      ca: readFileSync(caFile),
      headers: { authorization: `Bearer ${fakeJwt(id, 'https://storage.azure.com/.default')}`, 'x-ms-version': '2021-12-02', 'x-ms-date': new Date().toUTCString() }
    }, (r) => {
      r.resume()
      r.on('end', () => (r.statusCode === 202 ? res() : rej(new Error(`delete container: HTTP ${r.statusCode}`))))
    })
    req.on('error', rej)
    req.end()
  })
}

/** Blob names in an Azurite container (REST list, bearer token, no keys). */
export async function listBlobs(accountUrl, container, id, caFile) {
  const { request } = await import('node:https')
  const url = new URL(`${accountUrl}/${container}?restype=container&comp=list`)
  const xml = await new Promise((res, rej) => {
    const req = request(url, {
      method: 'GET',
      ca: readFileSync(caFile),
      headers: { authorization: `Bearer ${fakeJwt(id, 'https://storage.azure.com/.default')}`, 'x-ms-version': '2021-12-02', 'x-ms-date': new Date().toUTCString() }
    }, (r) => {
      let body = ''
      r.on('data', (c) => (body += c))
      r.on('end', () => (r.statusCode === 200 ? res(body) : rej(new Error(`list blobs: HTTP ${r.statusCode}`))))
    })
    req.on('error', rej)
    req.end()
  })
  return [...xml.matchAll(/<Name>([^<]+)<\/Name>/g)].map((m) => m[1]).sort()
}

/** Echo server: replies with method, url, headers and body as JSON. Records every request. */
export async function startEcho() {
  const requests = []
  const server = createHttpServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method, url: req.url, headers: req.headers, body })
      if (req.url === '/html') {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end('<!doctype html><h1>Hello preview</h1><script>document.title = "scripts must not run"</script>')
        return
      }
      res.setHeader('content-type', 'application/json')
      res.setHeader('set-cookie', 'e2e=1; Path=/')
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, requests, stop: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) }) }
}

/** Mock Key Vault (secrets REST API subset) with the 401 bearer challenge. */
export async function startMockVault(pki, tid, initial) {
  const secrets = new Map(Object.entries(initial).map(([k, v]) => [k, [{ version: 'v1', value: v }]]))
  const hits = []
  const server = createHttpsServer({ cert: readFileSync(pki.cert), key: readFileSync(pki.key) }, (req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const url = new URL(req.url ?? '/', 'https://vault.local')
      const auth = req.headers.authorization
      hits.push({ method: req.method, path: url.pathname, authorized: Boolean(auth) })
      res.setHeader('content-type', 'application/json; charset=utf-8')
      if (!auth?.startsWith('Bearer ')) {
        res.statusCode = 401
        res.setHeader('www-authenticate', `Bearer authorization="https://login.microsoftonline.com/${tid}", resource="https://vault.azure.net"`)
        res.end(JSON.stringify({ error: { code: 'Unauthorized', message: 'missing token' } }))
        return
      }
      const base = `https://${req.headers.host}`
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts[0] !== 'secrets') {
        res.statusCode = 404
        res.end('{}')
        return
      }
      const name = parts[1]
      const attrs = { enabled: true, created: 1700000000, updated: 1700000000, recoveryLevel: 'Recoverable' }
      if (name === 'forbidden-secret') {
        res.statusCode = 403
        res.end(JSON.stringify({ error: { code: 'Forbidden', message: 'Caller is not authorized to perform action on resource.', innererror: { code: 'ForbiddenByRbac' } } }))
        return
      }
      if (req.method === 'GET' && !name) {
        res.end(JSON.stringify({ value: [...secrets.keys()].map((n) => ({ id: `${base}/secrets/${n}`, attributes: attrs })), nextLink: null }))
        return
      }
      if (req.method === 'PUT' && name) {
        const { value } = JSON.parse(body)
        const list = secrets.get(name) ?? []
        const s = { version: `v${list.length + 1}`, value }
        secrets.set(name, [...list, s])
        res.end(JSON.stringify({ value: s.value, id: `${base}/secrets/${name}/${s.version}`, attributes: attrs }))
        return
      }
      const versions = secrets.get(name)
      const s = versions && (parts[2] ? versions.find((v) => v.version === parts[2]) : versions.at(-1))
      if (!s) {
        res.statusCode = 404
        res.end(JSON.stringify({ error: { code: 'SecretNotFound', message: `A secret with (name/id) ${name} was not found in this key vault.` } }))
        return
      }
      res.end(JSON.stringify({ value: s.value, id: `${base}/secrets/${name}/${s.version}`, attributes: attrs }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `https://127.0.0.1:${server.address().port}`, hits, secrets, stop: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) }) }
}

/**
 * Extra Chromium switches for test launches only (never set by the shipped app). On Linux the
 * `chrome-sandbox` helper that npm installs is not setuid root and CI kernels often block unprivileged
 * user namespaces, so Electron cannot start sandboxed there: tests pass --no-sandbox.
 */
export const TEST_SWITCHES = process.platform === 'linux' ? ['--no-sandbox'] : []

/** Launch the BUILT app with the test hooks. */
export async function launchApp({ userData, identity, cert, colorScheme = 'light' }) {
  const app = await electron.launch({
    // --use-mock-keychain: safeStorage (OAuth token encryption) must not touch the real macOS keychain.
    args: ['.', '--use-mock-keychain', ...TEST_SWITCHES],
    cwd: ROOT,
    colorScheme,
    env: {
      ...process.env,
      COURIER_USER_DATA: userData,
      COURIER_FAKE_IDENTITY: JSON.stringify(identity),
      COURIER_KV_INSECURE_CHALLENGE: '1',
      // Monitors may run every N seconds (test hook).
      COURIER_MONITOR_SECONDS: '1',
      NODE_EXTRA_CA_CERTS: cert
    }
  })
  const win = await app.firstWindow()
  return { app, win }
}

/** Replace native open/save dialogs in the main process (dialogs cannot be driven by Playwright). */
export async function stubDialogs(app, { open, save }) {
  await app.evaluate(({ dialog }, paths) => {
    globalThis.__e2eOpen = paths.open
    globalThis.__e2eSave = paths.save
    dialog.showOpenDialog = async () => (globalThis.__e2eOpen ? { canceled: false, filePaths: [globalThis.__e2eOpen] } : { canceled: true, filePaths: [] })
    dialog.showSaveDialog = async () => (globalThis.__e2eSave ? { canceled: false, filePath: globalThis.__e2eSave } : { canceled: true })
  }, { open: open ?? null, save: save ?? null })
}

export async function setDialogPaths(app, { open, save }) {
  await app.evaluate((_e, paths) => {
    if (paths.open !== undefined) globalThis.__e2eOpen = paths.open
    if (paths.save !== undefined) globalThis.__e2eSave = paths.save
  }, { open, save })
}

/**
 * Local fake servers for the auth types (independent verifiers written here, not Courier's code):
 *  /digest/*  RFC 7616 Digest, MD5, qop=auth
 *  /ntlm/*    NTLMv2 with handshake state per socket (Type 3 on another socket is refused); the NT hash
 *             of the test password "Password" is the MS-NLMP 4.2.2.1.2 value
 *  /aws/*     SigV4 verification (service execute-api) recomputed from the received request
 *  /jwt/*     HS256 JWT verification
 *  /idp/authorize, /idp/token   OAuth 2.0 authorization code + PKCE (S256 checked) fake IdP
 *  /api/*     accepts only a Bearer token the IdP issued
 *  /canary/*  records any hit (the Visualize frame must never load anything)
 */
export async function startAuthServers({ jwtSecret, aws, user }) {
  const { createHash, createHmac, randomBytes } = await import('node:crypto')
  const hits = { digest: [], ntlm: [], aws: [], jwt: [], token: [], api: [], canary: [] }
  const NT_HASH = Buffer.from('a4f49c406510bdcab6824ee7c30fd852', 'hex') // NTOWFv1("Password"), MS-NLMP 4.2.2.1.2
  const sockets = new WeakMap()
  let sockSeq = 0
  const codes = new Map()
  const issued = new Set()
  const md5 = (s) => createHash('md5').update(s).digest('hex')
  const sha = (s) => createHash('sha256').update(s).digest('hex')
  const hmac = (k, s) => createHmac('sha256', k).update(s).digest()
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  const params = (h) => Object.fromEntries([...h.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)].map((m) => [m[1], m[2] ?? m[3]]))
  let nonce = randomBytes(8).toString('hex')

  const server = createHttpServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const url = new URL(req.url ?? '/', 'http://local')
      const json = (status, obj, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify(obj))
      }
      const auth = req.headers.authorization ?? ''
      if (url.pathname.startsWith('/canary')) {
        hits.canary.push(req.url)
        return json(200, {})
      }
      if (url.pathname.startsWith('/digest')) {
        const p = auth.startsWith('Digest ') ? params(auth.slice(7)) : null
        const challenge = { 'www-authenticate': `Digest realm="e2e@contoso.test", qop="auth", algorithm=MD5, nonce="${nonce}", opaque="e2e-op"` }
        if (!p) return json(401, { ok: false }, challenge)
        const ha1 = md5(`${user.name}:e2e@contoso.test:${user.password}`)
        const expected = md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${md5(`${req.method}:${p.uri}`)}`)
        const ok = p.nonce === nonce && p.response === expected && p.opaque === 'e2e-op' && p.uri === req.url
        hits.digest.push({ ok, nc: p.nc })
        return ok ? json(200, { ok: true, scheme: 'digest' }) : json(401, { ok: false }, challenge)
      }
      if (url.pathname.startsWith('/ntlm')) {
        let st = sockets.get(req.socket)
        if (!st) sockets.set(req.socket, (st = { id: ++sockSeq }))
        const m = /^NTLM (.+)$/.exec(auth)
        if (!m) return json(401, { ok: false }, { 'www-authenticate': 'NTLM' })
        const msg = Buffer.from(m[1], 'base64')
        const type = msg.readUInt32LE(8)
        if (type === 1) {
          st.challenge = randomBytes(8)
          const t2 = Buffer.alloc(48)
          t2.write('NTLMSSP\0', 0, 'latin1')
          t2.writeUInt32LE(2, 8)
          t2.writeUInt32LE(0xe28a8235, 20)
          st.challenge.copy(t2, 24)
          const ti = Buffer.from('02000e0043004f004e0054004f0053004f0000000000', 'hex') // NbDomainName "CONTOSO" + EOL
          t2.writeUInt16LE(ti.length, 40)
          t2.writeUInt16LE(ti.length, 42)
          t2.writeUInt32LE(48, 44)
          hits.ntlm.push({ leg: 1, socket: st.id })
          return json(401, { ok: false }, { 'www-authenticate': `NTLM ${Buffer.concat([t2, ti]).toString('base64')}` })
        }
        const field = (at) => msg.subarray(msg.readUInt32LE(at + 4), msg.readUInt32LE(at + 4) + msg.readUInt16LE(at))
        if (!st.challenge) {
          hits.ntlm.push({ leg: 3, socket: st.id, ok: false, reason: 'no challenge on this socket' })
          return json(401, { ok: false }, { 'www-authenticate': 'NTLM' })
        }
        const nt = field(20)
        const u = field(36).toString('utf16le')
        const d = field(28).toString('utf16le')
        const key = createHmac('md5', NT_HASH).update(Buffer.from(u.toUpperCase() + d, 'utf16le')).digest()
        const ok = createHmac('md5', key).update(Buffer.concat([st.challenge, nt.subarray(16)])).digest().equals(nt.subarray(0, 16))
        hits.ntlm.push({ leg: 3, socket: st.id, ok, user: `${d}\\${u}` })
        return ok ? json(200, { ok: true, scheme: 'ntlm', user: `${d}\\${u}` }) : json(401, { ok: false }, { 'www-authenticate': 'NTLM' })
      }
      if (url.pathname.startsWith('/aws')) {
        const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth)
        if (!m) return json(403, { ok: false, reason: 'no signature' })
        const [, akid, date8, region, service, signedHeaders, signature] = m
        const names = signedHeaders.split(';')
        const canonicalHeaders = names.map((n) => `${n}:${String(req.headers[n] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('')
        const query = [...url.searchParams].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&')
        // Non-S3: the path exactly as received, URI-encoded once more.
        const path = (req.url ?? '/').split('?')[0].split('/').map((s) => enc(s)).join('/')
        const creq = [req.method, path, query, canonicalHeaders, signedHeaders, sha(body)].join('\n')
        const amzDate = String(req.headers['x-amz-date'])
        const sts = ['AWS4-HMAC-SHA256', amzDate, `${date8}/${region}/${service}/aws4_request`, sha(creq)].join('\n')
        const kSigning = hmac(hmac(hmac(hmac('AWS4' + aws.secretKey, date8), region), service), 'aws4_request')
        const ok = akid === aws.accessKey && createHmac('sha256', kSigning).update(sts).digest('hex') === signature && names.includes('host') && names.includes('x-amz-date')
        hits.aws.push({ ok, signedHeaders })
        return ok ? json(200, { ok: true, scheme: 'aws' }) : json(403, { ok: false, reason: 'signature mismatch' })
      }
      if (url.pathname.startsWith('/jwt')) {
        const t = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        const [h, p, s] = t.split('.')
        const ok = !!s && createHmac('sha256', jwtSecret).update(`${h}.${p}`).digest('base64url') === s
        const payload = ok ? JSON.parse(Buffer.from(p, 'base64url').toString()) : null
        hits.jwt.push({ ok, payload })
        return ok ? json(200, { ok: true, scheme: 'jwt', sub: payload.sub }) : json(401, { ok: false })
      }
      if (url.pathname === '/idp/authorize') {
        const q = url.searchParams
        const redirect = q.get('redirect_uri') ?? ''
        if (q.get('client_id') !== 'courier-e2e' || !/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirect) || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return json(400, { error: 'invalid_request' })
        const code = randomBytes(8).toString('hex')
        codes.set(code, { challenge: q.get('code_challenge'), redirect })
        const back = new URL(redirect)
        back.searchParams.set('code', code)
        back.searchParams.set('state', q.get('state') ?? '')
        res.writeHead(302, { location: back.toString() })
        return res.end()
      }
      if (url.pathname === '/idp/token') {
        const f = new URLSearchParams(body.toString())
        const c = codes.get(f.get('code') ?? '')
        codes.delete(f.get('code') ?? '')
        const pkceOk = !!c && createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') === c.challenge && c.redirect === f.get('redirect_uri')
        hits.token.push({ grant: f.get('grant_type'), pkceOk })
        if (!pkceOk) return json(400, { error: 'invalid_grant' })
        const at = `e2e-at-${randomBytes(16).toString('hex')}`
        issued.add(at)
        return json(200, { access_token: at, refresh_token: `e2e-rt-${randomBytes(16).toString('hex')}`, token_type: 'Bearer', expires_in: 3600 })
      }
      if (url.pathname.startsWith('/api')) {
        const ok = auth.startsWith('Bearer ') && issued.has(auth.slice(7))
        hits.api.push({ ok, token: auth.slice(7) })
        return ok ? json(200, { ok: true, scheme: 'oauth2' }) : json(401, { ok: false })
      }
      json(404, {})
    })
  })
  server.keepAliveTimeout = 10_000
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, hits, issued, stop: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) }) }
}

/**
 * Replaces `shell.openExternal` in the main process with a fake system browser: it GETs the authorize
 * URL, takes the IdP's redirect and requests it (the loopback listener), like a real browser would.
 * Every opened URL is recorded in `globalThis.__e2eOpened`.
 */
export async function stubBrowser(app) {
  await app.evaluate(({ shell }) => {
    globalThis.__e2eOpened = []
    shell.openExternal = async (url) => {
      globalThis.__e2eOpened.push(url)
      const r = await fetch(url, { redirect: 'manual' })
      const loc = r.headers.get('location')
      if (loc) await fetch(loc).then((x) => x.text())
    }
  })
}

/**
 * Records OS notifications instead of showing them: `Notification.prototype.show` pushes the instance
 * to `globalThis.__e2eNotes` (title, body; `emit('click')` simulates a click).
 */
export async function stubNotifications(app) {
  await app.evaluate(({ Notification }) => {
    globalThis.__e2eNotes = []
    Notification.prototype.show = function () {
      globalThis.__e2eNotes.push(this)
    }
  })
}
