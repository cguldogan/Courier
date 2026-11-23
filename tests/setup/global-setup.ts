/**
 * Runs once in the vitest main process before any worker starts:
 *  1. generates a throw-away self-signed cert for 127.0.0.1 (openssl),
 *  2. exports it via NODE_EXTRA_CA_CERTS so every forked worker trusts it (read at process start),
 *  3. starts Azurite (blob only) with `--oauth basic` over HTTPS, in-memory.
 * Nothing here touches a real Azure resource.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let azurite: ChildProcess | null = null
let dir = ''

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => res(p))
    })
    s.on('error', rej)
  })
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const ok = await new Promise<boolean>((res) => {
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
  throw new Error(`Azurite did not start on port ${port}`)
}

export default async function setup(): Promise<() => Promise<void>> {
  dir = mkdtempSync(join(tmpdir(), 'courier-test-pki-'))
  const cert = join(dir, 'cert.pem')
  const key = join(dir, 'key.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'
  ], { stdio: 'ignore' })
  process.env.NODE_EXTRA_CA_CERTS = cert
  process.env.COURIER_TEST_CERT = cert
  process.env.COURIER_TEST_KEY = key

  const port = await freePort()
  const main = resolve(__dirname, '../../node_modules/azurite/dist/src/blob/main.js')
  azurite = spawn(process.execPath, [
    main, '--blobHost', '127.0.0.1', '--blobPort', String(port), '--oauth', 'basic', '--cert', cert, '--key', key,
    '--inMemoryPersistence', '--disableTelemetry', '--silent', '--skipApiVersionCheck', '--loose'
  ], { stdio: ['ignore', 'ignore', 'pipe'], cwd: dir })
  let stderr = ''
  azurite.stderr?.on('data', (d) => (stderr += String(d)))
  try {
    await waitForPort(port, 20_000)
  } catch (err) {
    throw new Error(`${(err as Error).message}\n${stderr}`)
  }
  process.env.COURIER_TEST_AZURITE = `https://127.0.0.1:${port}/devstoreaccount1`

  return async () => {
    azurite?.kill()
    rmSync(dir, { recursive: true, force: true })
  }
}
