// Local test infrastructure for the e2e drive script. Nothing here touches a real Azure resource:
//  - a throw-away self-signed cert for 127.0.0.1 (openssl),
//  - Azurite (blob) over HTTPS with `--oauth basic` (accepts the fake unsigned JWTs),
//  - a mock Key Vault speaking the secrets REST API incl. the 401 bearer challenge,
//  - a plain HTTP echo server.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

export const ROOT = resolve(import.meta.dirname, '..')

export function makeCert() {
  const dir = mkdtempSync(join(tmpdir(), 'courier-e2e-pki-'))
  const cert = join(dir, 'cert.pem')
  const key = join(dir, 'key.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'
  ], { stdio: 'ignore' })
  return { dir, cert, key, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
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
  return { url: `https://127.0.0.1:${port}/devstoreaccount1`, stop: () => proc.kill() }
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

/** Launch the BUILT app with the test hooks. */
export async function launchApp({ userData, identity, cert, colorScheme = 'light' }) {
  const app = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    colorScheme,
    env: {
      ...process.env,
      COURIER_USER_DATA: userData,
      COURIER_FAKE_IDENTITY: JSON.stringify(identity),
      COURIER_KV_INSECURE_CHALLENGE: '1',
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
