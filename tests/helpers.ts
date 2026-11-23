import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { CourierCore } from '../src/main/core'
import type { FakeIdentity } from '../src/main/azure'
import type { DeepPartial } from '../src/shared/api'
import type { Settings } from '../src/shared/types'
import { defaultSettings } from '../src/main/store'

export const tempDirs: string[] = []
export function tempDir(prefix = 'courier-test-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(d)
  return d
}
export function cleanupTempDirs(): void {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
}

export function settings(patch: DeepPartial<Settings> = {}): Settings {
  const s = defaultSettings()
  return {
    ...s,
    ...patch,
    http: { ...s.http, ...(patch.http ?? {}) },
    scripts: { ...s.scripts, ...(patch.scripts ?? {}) }
  } as Settings
}

export interface Listening {
  url: string
  port: number
  close(): Promise<void>
}

export async function listen(server: Server, protocol = 'http'): Promise<Listening> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  return {
    url: `${protocol}://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.()
        server.close(() => r())
      })
  }
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

/** Echo server: replies with method, url, headers and body as JSON. Extra routes can be layered on top. */
export async function echoServer(
  routes: Record<string, (req: IncomingMessage, res: ServerResponse, body: Buffer) => void> = {}
): Promise<Listening & { requests: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[] }> {
  const requests: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[] = []
  const server = createServer(async (req, res) => {
    const body = await readBody(req)
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: body.toString('utf8') })
    const path = (req.url ?? '/').split('?')[0]
    const route = routes[path]
    if (route) return route(req, res, body)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: body.toString('utf8') }))
  })
  const l = await listen(server)
  return Object.assign(l, { requests })
}

export function httpsServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server {
  const cert = readFileSync(process.env.COURIER_TEST_CERT as string)
  const key = readFileSync(process.env.COURIER_TEST_KEY as string)
  return createHttpsServer({ cert, key }, handler) as unknown as Server
}

export const ID_A: FakeIdentity = { name: 'Alice', upn: 'alice@contoso.test', oid: 'aaaaaaaa-0000-0000-0000-000000000001', tid: 'tttttttt-0000-0000-0000-000000000001' }
export const ID_B: FakeIdentity = { name: 'Bob', upn: 'bob@contoso.test', oid: 'bbbbbbbb-0000-0000-0000-000000000002', tid: 'tttttttt-0000-0000-0000-000000000001' }

export async function makeCore(opts: { identity?: FakeIdentity | null; settings?: DeepPartial<Settings>; signIn?: boolean; userDataDir?: string; insecureKv?: boolean } = {}): Promise<CourierCore> {
  const core = new CourierCore({
    userDataDir: opts.userDataDir ?? tempDir('courier-ud-'),
    fakeIdentity: opts.identity ?? null,
    keyVaultInsecureChallenge: opts.insecureKv
  })
  await core.init()
  if (opts.settings) await core.updateSettings(opts.settings)
  if (opts.identity && opts.signIn !== false) await core.signIn({ mode: 'azure-cli' })
  return core
}

/** Writes `courier-team.json` into a container (as a teammate with write access would). */
export async function seedManifest(accountUrl: string, container: string, manifest: { name: string; vaults?: { alias: string; url: string }[] }, as: FakeIdentity = ID_A): Promise<void> {
  const { createContainerClient } = await import('../src/main/blobsync')
  const { FakeCredential } = await import('../src/main/azure')
  const text = JSON.stringify({ version: 1, name: manifest.name, vaults: manifest.vaults ?? [] }, null, 2)
  await createContainerClient(accountUrl, container, new FakeCredential(as)).getBlockBlobClient('courier-team.json').upload(text, Buffer.byteLength(text))
}

/** A signed-in core that joined the team in `container` (whose manifest must exist). Returns the core and the team id. */
export async function teamClient(opts: { identity?: FakeIdentity; accountUrl: string; container: string; userDataDir?: string; insecureKv?: boolean; settings?: DeepPartial<Settings> }): Promise<{ core: CourierCore; teamId: string }> {
  const core = await makeCore({ identity: opts.identity ?? ID_A, userDataDir: opts.userDataDir, insecureKv: opts.insecureKv, settings: opts.settings })
  const team = await core.joinTeam({ accountUrl: opts.accountUrl, container: opts.container })
  return { core, teamId: team.id }
}

/** Every file under a directory (recursive) with its UTF-8 content. */
export function readTree(dir: string): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out.push({ path: p, content: readFileSync(p, 'utf8') })
    }
  }
  walk(dir)
  return out
}
