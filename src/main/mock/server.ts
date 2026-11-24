/**
 * Local mock server (plain `node:http`, no Electron; used by the app and `courier mock`).
 *
 * Security:
 *  - binds to 127.0.0.1 only (there is no option for another interface);
 *  - the Host header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding);
 *  - request bodies are read up to `MOCK_MAX_BODY_BYTES` and never used (413 above that); headers are
 *    capped by Node (`maxHeaderSize`); malformed requests get a 400 from `clientError`;
 *  - it only replays saved examples: it never proxies, reads files or runs scripts;
 *  - `{{variables}}` in example bodies/headers are substituted (when enabled) from *plain* variables
 *    only: Key Vault references, `vault`- and `secret`-typed variables are served as `••••` and are
 *    never resolved (see `mockVariables`).
 *
 * The collection is looked up on every request, so edits to examples apply immediately.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { MockLogEntry } from '../../shared/api'
import { HOP_BY_HOP_HEADERS } from '../../shared/examples'
import type { Collection, Environment, RawLanguage, Variable } from '../../shared/types'
import { MASK, emptyLayers, replaceVaultRefs, resolveTemplate, type VariableLayers } from '../../shared/variables'
import { Fault } from '../errors'
import { matchRequest, mockCandidates, type MockCandidate } from './match'

export const MOCK_HOST = '127.0.0.1'
export const MOCK_MAX_BODY_BYTES = 1024 * 1024
export const MOCK_MAX_DELAY_MS = 60_000
/** `••••` in a header value (headers cannot carry the bullet character). */
export const HEADER_MASK = '****'

export interface MockRuntimeSettings {
  delayMs: number
  cors: boolean
  substituteVariables: boolean
}

export interface MockServerOptions {
  /** 0 = any free port. */
  port: number
  /** Read on every request (live edits). Null = the collection is gone (503). */
  collection: () => Promise<Collection | null> | Collection | null
  /** Variables for substitution (read on every request when substitution is on). */
  variables: () => Promise<VariableLayers> | VariableLayers
  settings: () => MockRuntimeSettings
  onLog?: (entry: Omit<MockLogEntry, 'seq'>) => void
}

const CONTENT_TYPES: Record<RawLanguage, string> = {
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  html: 'text/html; charset=utf-8',
  javascript: 'application/javascript; charset=utf-8',
  text: 'text/plain; charset=utf-8'
}

/**
 * Plain values for substitution: enabled `default`-typed variables with their *shared* value (what the
 * document holds), environment over collection. This machine's current values are not used (scripts
 * often store tokens there). `secret`- and `vault`-typed variables and any value holding a Key Vault
 * reference read as `••••`.
 */
export function mockVariables(collection: Collection | null, environment: Environment | null): VariableLayers {
  const plain = (vars: Variable[]): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const v of vars) {
      if (!v.key || !v.enabled) continue
      out[v.key] = v.type === 'default' ? replaceVaultRefs(v.value, () => MASK) : MASK
    }
    return out
  }
  return { ...emptyLayers(), collection: collection ? plain(collection.variables) : {}, environment: environment ? plain(environment.variables) : {} }
}

/** `{{variables}}` resolved, then every Key Vault reference (written or produced) served masked. */
function substitute(text: string, layers: VariableLayers): string {
  return replaceVaultRefs(resolveTemplate(text, layers), () => MASK)
}

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body, null, 2) + '\n'
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...extra })
  res.end(text)
}

export class MockServer {
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  private readonly timers = new Set<NodeJS.Timeout>()
  private boundPort = 0

  constructor(private readonly opts: MockServerOptions) {}

  get port(): number {
    return this.boundPort
  }

  get url(): string {
    return `http://${MOCK_HOST}:${this.boundPort}`
  }

  get running(): boolean {
    return this.server !== null
  }

  async start(): Promise<number> {
    if (this.server) return this.boundPort
    const port = Math.floor(Number(this.opts.port) || 0)
    if (port < 0 || port > 65535) throw new Fault('INVALID_ARGUMENT', 'The port must be between 0 (any free port) and 65535.')
    const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30_000, headersTimeout: 15_000, keepAliveTimeout: 5_000 }, (req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) {
          try {
            json(res, 500, { error: 'mockServerError', message: 'The mock server could not answer this request.' })
          } catch {
            res.destroy()
          }
        } else res.destroy()
      })
    })
    server.on('connection', (s: Socket) => {
      this.sockets.add(s)
      s.on('close', () => this.sockets.delete(s))
    })
    // Malformed requests, oversized headers, timeouts: answer 400 where possible, never throw.
    server.on('clientError', (err: NodeJS.ErrnoException, socket: Socket) => {
      if (socket.writable && err.code !== 'ECONNRESET') socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      else socket.destroy()
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening)
        if (err.code === 'EADDRINUSE') reject(new Fault('CONFLICT', `Port ${port} is already in use on ${MOCK_HOST}. Choose another port, or 0 for any free port.`))
        else if (err.code === 'EACCES') reject(new Fault('FORBIDDEN', `Port ${port} needs elevated privileges. Choose a port above 1023, or 0 for any free port.`))
        else reject(new Fault('INTERNAL', `The mock server could not start: ${err.message}`))
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen({ host: MOCK_HOST, port, exclusive: true })
    })
    server.on('error', () => undefined)
    this.server = server
    this.boundPort = (server.address() as AddressInfo).port
    return this.boundPort
  }

  async stop(): Promise<void> {
    const s = this.server
    if (!s) return
    this.server = null
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    await new Promise<void>((resolve) => {
      s.close(() => resolve())
      s.closeAllConnections()
      for (const sock of this.sockets) sock.destroy()
    })
  }

  private allowedHost(host: string | undefined): boolean {
    if (!host) return false
    const h = host.trim().toLowerCase()
    return h === `${MOCK_HOST}:${this.boundPort}` || h === `localhost:${this.boundPort}`
  }

  private corsHeaders(req: IncomingMessage): Record<string, string> {
    if (!this.opts.settings().cors) return {}
    const asked = req.headers['access-control-request-headers']
    return {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
      'access-control-allow-headers': typeof asked === 'string' && asked.length < 2000 ? asked : '*',
      'access-control-expose-headers': '*',
      'access-control-max-age': '600'
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now()
    const method = (req.method ?? 'GET').toUpperCase()
    const rawPath = (req.url ?? '/').split('?', 1)[0] || '/'
    const log = (status: number, extra: Partial<MockLogEntry> = {}): void =>
      this.opts.onLog?.({ at: new Date().toISOString(), method, path: rawPath.slice(0, 2000), status, durationMs: Math.round(performance.now() - started), ...extra })

    // DNS rebinding: a page on another origin that resolves its own name to 127.0.0.1 sends its own Host.
    if (!this.allowedHost(req.headers.host)) {
      req.resume()
      json(res, 403, { error: 'hostNotAllowed', message: `This mock server only answers requests for ${MOCK_HOST}:${this.boundPort} or localhost:${this.boundPort}.` }, { connection: 'close' })
      log(403, { note: `refused Host "${String(req.headers.host ?? '').slice(0, 100)}"` })
      return
    }
    // Read (and discard) the body, up to the cap.
    const tooLarge = await new Promise<boolean>((resolve) => {
      let size = 0
      let done = false
      const declared = Number(req.headers['content-length'] ?? 0)
      if (declared > MOCK_MAX_BODY_BYTES) {
        done = true
        return resolve(true)
      }
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > MOCK_MAX_BODY_BYTES && !done) {
          done = true
          resolve(true)
        }
      })
      req.on('end', () => !done && resolve(false))
      req.on('error', () => !done && resolve(true))
    })
    if (tooLarge) {
      json(res, 413, { error: 'payloadTooLarge', message: `Request bodies are limited to ${MOCK_MAX_BODY_BYTES} bytes.` }, { connection: 'close', ...this.corsHeaders(req) })
      res.on('finish', () => req.destroy())
      log(413, { note: 'request body too large' })
      return
    }
    const settings = this.opts.settings()
    // CORS preflight (only while CORS is on; otherwise OPTIONS is matched like any method).
    if (settings.cors && method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.writeHead(204, this.corsHeaders(req))
      res.end()
      log(204, { note: 'CORS preflight' })
      return
    }
    const collection = await this.opts.collection()
    if (!collection) {
      json(res, 503, { error: 'collectionGone', message: 'The mocked collection no longer exists.' }, this.corsHeaders(req))
      log(503, { note: 'collection gone' })
      return
    }
    const url = new URL(req.url ?? '/', `http://${MOCK_HOST}`)
    const result = matchRequest(mockCandidates(collection), { method, path: url.pathname, query: [...url.searchParams], headers: req.headers })
    if (settings.delayMs > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          this.timers.delete(t)
          resolve()
        }, Math.min(settings.delayMs, MOCK_MAX_DELAY_MS))
        this.timers.add(t)
        res.on('close', () => {
          clearTimeout(t)
          this.timers.delete(t)
          resolve()
        })
      })
      if (res.destroyed || !this.server) return
    }
    if (!result.matched) {
      json(res, 404, result.notFound, this.corsHeaders(req))
      log(404, { note: 'no match' })
      return
    }
    await this.reply(req, res, result.candidate, result.headOnly || method === 'HEAD', settings)
    log(res.statusCode, { example: { id: result.candidate.example.id, name: result.candidate.example.name, request: result.candidate.request.name } })
  }

  private async reply(req: IncomingMessage, res: ServerResponse, c: MockCandidate, noBody: boolean, settings: MockRuntimeSettings): Promise<void> {
    const ex = c.example.response
    const layers = settings.substituteVariables ? await this.opts.variables() : null
    const text = (s: string): string => (layers ? substitute(s, layers) : replaceVaultRefs(s, () => MASK))
    const body = ex.bodyBase64 !== undefined ? Buffer.from(ex.bodyBase64, 'base64') : Buffer.from(text(ex.body), 'utf8')
    const headers: [string, string][] = []
    for (const h of ex.headers) {
      if (!h.enabled || !h.key.trim() || HOP_BY_HOP_HEADERS.test(h.key.trim())) continue
      // Example headers come from documents (possibly a teammate's): skip anything Node refuses.
      const key = h.key.trim()
      // Header values are Latin-1 on the wire: the mask is written as ASCII there.
      const value = text(h.value).split(MASK).join(HEADER_MASK)
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[^\t\x20-\x7e\x80-\xff]/.test(value)) continue
      headers.push([key, value])
    }
    if (!headers.some(([k]) => k.toLowerCase() === 'content-type') && (body.length || ex.bodyBase64 !== undefined))
      headers.push(['content-type', ex.bodyBase64 !== undefined ? 'application/octet-stream' : CONTENT_TYPES[ex.language] ?? CONTENT_TYPES.text])
    for (const [k, v] of Object.entries(this.corsHeaders(req))) if (!headers.some(([x]) => x.toLowerCase() === k)) headers.push([k, v])
    const status = ex.status >= 200 && ex.status <= 599 ? ex.status : 200
    const bodyless = status === 204 || status === 304
    // HEAD: the length the GET would have, and no body.
    if (!bodyless) headers.push(['content-length', String(body.length)])
    headers.push(['x-mock-example-id', c.example.id])
    const flat: string[] = headers.flatMap(([k, v]) => [k, v])
    res.writeHead(status, ex.statusText || undefined, flat)
    res.end(noBody || bodyless ? undefined : body)
  }
}
