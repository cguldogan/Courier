/**
 * WebSocket connections (pure Node, `ws`). One `WsConnection` per open tab; `WsManager` owns them.
 *
 * The handshake is prepared like an HTTP send (`prepareConnection`: variables, Key Vault, auth), sends
 * the app's cookies for the URL and stores `Set-Cookie` from the 101 response. Outgoing messages
 * resolve `{{variables}}` / `{{vault:…}}` at send time. One `Masker` per connection collects every Key
 * Vault value and token, and everything sent to the renderer (handshake headers, both directions of
 * the log, close reasons, errors) is masked with it. Nothing here writes a message to disk.
 */
import type { IncomingMessage } from 'node:http'
import type { CookieJar } from 'tough-cookie'
import WebSocket from 'ws'
import { decodeBinaryInput, PREVIEW_MAX_BYTES, WS_DEFAULT_HANDSHAKE_TIMEOUT_MS, WS_DEFAULT_MAX_MESSAGE_BYTES } from '../../shared/realtime'
import type { Auth, RealtimeLogEntry, WebSocketRequestDef, WsEvent, WsHandshake, WsMessage, WsStatus } from '../../shared/types'
import type { VariableLayers } from '../../shared/variables'
import { Fault, messageOf } from '../errors'
import { Masker, USER_AGENT, prepareConnection, resolveText, type ExecutorDeps } from '../executor'

/** What a connection needs from core, fetched fresh for the handshake and for every send. */
export interface WsContext {
  layers: VariableLayers
  deps: ExecutorDeps
}

export interface WsConnectionOptions {
  id: string
  /** Renderer that opened it (closed with its window). */
  owner: number | null
  request: WebSocketRequestDef
  /** Effective auth after the inherit chain. */
  auth: Auth
  context: () => Promise<WsContext>
  emit: (e: WsEvent) => void
  /** Persist the cookie jar after the handshake stored cookies. */
  cookiesChanged?: () => void
  /** Defaults (Settings → Requests). */
  defaults: { verifyTls: boolean }
  /** Reconnect delays (tests shorten them). */
  reconnectDelaysMs?: number[]
}

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000]
const BODY_PREVIEW = 64 * 1024

/** `ws:` → `http:` (and `wss:` → `https:`) for cookie matching. */
function cookieUrl(url: string): string {
  return url.replace(/^ws(s?):/i, 'http$1:')
}

function pairs(raw: string[]): [string, string][] {
  const out: [string, string][] = []
  for (let i = 0; i + 1 < raw.length; i += 2) out.push([raw[i], raw[i + 1]])
  return out
}

function tlsHint(code: string | undefined): string {
  return code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/i.test(code) ? ' (TLS certificate not trusted — turn off "Verify TLS certificates" in the request settings for a test server)' : ''
}

export class WsConnection {
  readonly id: string
  readonly owner: number | null
  private readonly opts: WsConnectionOptions
  private readonly masker = new Masker()
  private socket: WebSocket | null = null
  private seq = 0
  private status: WsStatus = 'closed'
  private userClosed = false
  private everOpened = false
  private attempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(opts: WsConnectionOptions) {
    this.opts = opts
    this.id = opts.id
    this.owner = opts.owner
  }

  get state(): WsStatus {
    return this.status
  }

  private m(s: string): string {
    return this.masker.mask(s)
  }

  private setStatus(status: WsStatus, extra: Omit<Extract<WsEvent, { type: 'status' }>, 'connectionId' | 'type' | 'status'> = {}): void {
    this.status = status
    this.opts.emit({ connectionId: this.id, type: 'status', status, ...extra })
  }

  private log(entry: Omit<RealtimeLogEntry, 'seq' | 'at'>): RealtimeLogEntry {
    const e: RealtimeLogEntry = { seq: ++this.seq, at: new Date().toISOString(), ...entry }
    this.opts.emit({ connectionId: this.id, type: 'message', entry: e })
    return e
  }

  /** A text / binary payload as a (masked, truncated) log entry. */
  private payload(direction: 'in' | 'out', data: Buffer, binary: boolean): Omit<RealtimeLogEntry, 'seq' | 'at'> {
    const size = data.length
    if (!binary) {
      const text = data.toString('utf8')
      const cut = text.length > PREVIEW_MAX_BYTES
      return { direction, kind: 'text', size, text: this.m(cut ? text.slice(0, PREVIEW_MAX_BYTES) : text), ...(cut ? { truncated: true } : {}) }
    }
    let bytes = data
    // A secret inside binary data: show the masked bytes instead of the real ones.
    if (this.masker.size && this.masker.hits(data.toString('utf8'))) bytes = Buffer.from(this.m(data.toString('utf8')), 'utf8')
    const cut = bytes.length > PREVIEW_MAX_BYTES
    return { direction, kind: 'binary', size, base64: (cut ? bytes.subarray(0, PREVIEW_MAX_BYTES) : bytes).toString('base64'), ...(cut ? { truncated: true } : {}) }
  }

  /** Opens the connection. Resolves with the outcome of the handshake (never rejects for network failures). */
  async connect(): Promise<{ status: WsStatus; error?: { code: string; message: string } }> {
    this.userClosed = false
    this.setStatus('connecting')
    let prepared: { url: string; headers: [string, string][] }
    let ctx: WsContext
    try {
      ctx = await this.opts.context()
      const r = this.opts.request
      prepared = await prepareConnection({ url: r.url.trim(), params: r.params, headers: r.headers, auth: this.opts.auth }, { protocol: 'WebSocket', layers: ctx.layers, deps: ctx.deps, masker: this.masker })
      let u: URL
      try {
        u = new URL(prepared.url)
      } catch {
        throw new Fault('INVALID_ARGUMENT', `"${this.m(prepared.url)}" is not a valid WebSocket URL.`)
      }
      if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Fault('INVALID_ARGUMENT', 'WebSocket URLs start with ws:// or wss://.')
    } catch (err) {
      const f = err instanceof Fault ? err : new Fault('INTERNAL', messageOf(err))
      const error = { code: f.code, message: this.m(f.message) }
      this.log({ direction: 'info', kind: 'error', size: 0, text: error.message })
      this.setStatus('error', { error })
      throw new Fault(f.code, error.message)
    }
    return this.open(prepared, ctx.deps)
  }

  private open(prepared: { url: string; headers: [string, string][] }, deps: ExecutorDeps): Promise<{ status: WsStatus; error?: { code: string; message: string } }> {
    const r = this.opts.request
    const s = r.settings
    const jar: CookieJar | undefined = deps.cookieJar
    const httpUrl = cookieUrl(prepared.url)
    const headers: Record<string, string> = {}
    const has = (k: string): boolean => Object.keys(headers).some((x) => x.toLowerCase() === k.toLowerCase())
    for (const [k, v] of prepared.headers) {
      const existing = Object.keys(headers).find((x) => x.toLowerCase() === k.toLowerCase())
      if (existing) headers[existing] = `${headers[existing]}, ${v}`
      else headers[k] = v
    }
    if (!has('user-agent')) headers['User-Agent'] = USER_AGENT
    return new Promise((resolve) => {
      let settled = false
      const done = (v: { status: WsStatus; error?: { code: string; message: string } }): void => {
        if (!settled) {
          settled = true
          resolve(v)
        }
      }
      const start = async (): Promise<void> => {
        if (jar && !has('cookie')) {
          try {
            const c = await jar.getCookieString(httpUrl)
            if (c) headers['Cookie'] = c
          } catch {
            /* no cookies for this URL */
          }
        }
        const handshake: WsHandshake = { url: this.m(prepared.url), requestHeaders: [], responseHeaders: [] }
        let failure: { code: string; message: string } | null = null
        /** Close code Courier sent itself (ws reports 1006 locally when it stops reading). */
        let closeCode: number | null = null
        let ws: WebSocket
        try {
          ws = new WebSocket(prepared.url, r.subprotocols, {
            headers,
            handshakeTimeout: s.handshakeTimeoutMs ?? WS_DEFAULT_HANDSHAKE_TIMEOUT_MS,
            maxPayload: s.maxMessageBytes ?? WS_DEFAULT_MAX_MESSAGE_BYTES,
            rejectUnauthorized: s.verifyTls ?? this.opts.defaults.verifyTls,
            followRedirects: false,
            perMessageDeflate: true,
            finishRequest: (req) => {
              handshake.requestHeaders = Object.entries(req.getHeaders()).map(([k, v]) => [k, this.m(Array.isArray(v) ? v.join(', ') : String(v))])
              req.end()
            }
          })
        } catch (err) {
          const error = { code: 'INVALID_ARGUMENT', message: this.m(messageOf(err)) }
          this.log({ direction: 'info', kind: 'error', size: 0, text: error.message })
          this.setStatus('error', { error })
          done({ status: 'error', error })
          return
        }
        this.socket = ws
        ws.on('upgrade', (res: IncomingMessage) => {
          handshake.status = res.statusCode
          handshake.statusText = res.statusMessage
          handshake.responseHeaders = pairs(res.rawHeaders).map(([k, v]) => [k, this.m(v)])
          const set = res.headers['set-cookie']
          if (jar && set?.length) {
            void Promise.all(set.map((c) => jar.setCookie(c, httpUrl, { ignoreError: true }).catch(() => undefined))).then(() => this.opts.cookiesChanged?.())
          }
        })
        ws.on('unexpected-response', (_req, res: IncomingMessage) => {
          handshake.status = res.statusCode
          handshake.statusText = res.statusMessage
          handshake.responseHeaders = pairs(res.rawHeaders).map(([k, v]) => [k, this.m(v)])
          const chunks: Buffer[] = []
          let n = 0
          const finish = (): void => {
            const body = Buffer.concat(chunks).toString('utf8').trim()
            const code = res.statusCode === 401 || res.statusCode === 403 ? 'AUTH_FAILED' : 'NETWORK'
            failure = { code, message: this.m(`The server answered ${res.statusCode} ${res.statusMessage ?? ''} instead of 101 Switching Protocols${body ? `: ${body.slice(0, 500)}` : '.'}`) }
            ws.terminate()
          }
          res.on('data', (c: Buffer) => {
            if (n < BODY_PREVIEW) chunks.push(c)
            n += c.length
          })
          res.on('end', finish)
          res.on('error', finish)
          setTimeout(() => res.destroy(), 2000).unref()
        })
        ws.on('open', () => {
          this.everOpened = true
          this.attempt = 0
          handshake.protocol = ws.protocol
          handshake.extensions = ws.extensions
          this.log({ direction: 'info', kind: 'event', size: 0, text: `Connected to ${this.m(prepared.url)}${ws.protocol ? ` (subprotocol ${ws.protocol})` : ''}` })
          this.setStatus('open', { handshake })
          done({ status: 'open' })
        })
        ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
          const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
          this.log(this.payload('in', buf, isBinary))
        })
        ws.on('ping', (data: Buffer) => this.log({ direction: 'in', kind: 'ping', size: data.length, ...(data.length ? { text: this.m(data.toString('utf8')) } : {}) }))
        ws.on('pong', (data: Buffer) => this.log({ direction: 'in', kind: 'pong', size: data.length, ...(data.length ? { text: this.m(data.toString('utf8')) } : {}) }))
        ws.on('error', (err: Error & { code?: string }) => {
          if (failure) return
          const msg = messageOf(err)
          let code = 'NETWORK'
          let text = msg
          if (/handshake has timed out/i.test(msg)) {
            code = 'TIMEOUT'
            text = `The opening handshake timed out after ${s.handshakeTimeoutMs ?? WS_DEFAULT_HANDSHAKE_TIMEOUT_MS} ms.`
          } else if (/max payload size exceeded/i.test(msg) || err.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') {
            code = 'INVALID_ARGUMENT'
            closeCode = 1009
            text = `A message was larger than the maximum message size (${s.maxMessageBytes ?? WS_DEFAULT_MAX_MESSAGE_BYTES} bytes); the connection was closed with 1009.`
          } else if (err.code === 'ECONNREFUSED') text = `Connection refused by ${new URL(prepared.url).host}.`
          else text = `${msg}${tlsHint(err.code)}`
          failure = { code, message: this.m(text) }
          if (this.everOpened && this.status === 'open') this.log({ direction: 'info', kind: 'error', size: 0, text: failure.message })
        })
        ws.on('close', (code: number, reasonBuf: Buffer) => {
          const reason = this.m(reasonBuf.toString('utf8'))
          this.socket = null
          if (this.status === 'connecting' || this.status === 'reconnecting' || !this.everOpened) {
            // Handshake never completed.
            const error = failure ?? { code: 'NETWORK', message: 'The connection closed before the handshake completed.' }
            this.log({ direction: 'info', kind: 'error', size: 0, text: error.message })
            this.setStatus('error', { error, handshake })
            done({ status: 'error', error })
            if (this.everOpened) this.scheduleReconnect(prepared, deps)
            return
          }
          this.log({ direction: 'info', kind: 'event', size: 0, text: `Closed ${closeCode ?? code}${reason ? ` ${reason}` : ''}${this.userClosed ? '' : closeCode ? ' (by Courier)' : ' (by the server or the network)'}` })
          const error = !this.userClosed && failure ? failure : undefined
          const shown = closeCode ?? code
          this.setStatus('closed', { code: shown, reason, ...(error ? { error } : {}) })
          done({ status: 'closed' })
          if (!this.userClosed) this.scheduleReconnect(prepared, deps)
        })
      }
      void start()
    })
  }

  private scheduleReconnect(prepared: { url: string; headers: [string, string][] }, deps: ExecutorDeps): void {
    const delays = this.opts.reconnectDelaysMs ?? RECONNECT_DELAYS
    if (!this.opts.request.settings.autoReconnect || this.userClosed || this.disposed || this.attempt >= delays.length) return
    const delay = delays[this.attempt++]
    this.setStatus('reconnecting', { attempt: this.attempt })
    this.log({ direction: 'info', kind: 'event', size: 0, text: `Reconnecting in ${Math.round(delay / 100) / 10} s (attempt ${this.attempt} of ${delays.length})` })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.userClosed || this.disposed) return
      void this.open(prepared, deps)
    }, delay)
  }

  /** Sends one message; `{{variables}}` / `{{vault:…}}` resolve now. Returns the (masked) log entry. */
  async send(message: WsMessage): Promise<RealtimeLogEntry> {
    const ws = this.socket
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Fault('INVALID_ARGUMENT', 'Not connected. Connect first.')
    const ctx = await this.opts.context()
    const body = await resolveText(typeof message?.body === 'string' ? message.body : '', ctx.layers, ctx.deps.vault, this.masker)
    let data: Buffer
    const binary = message?.kind === 'binary'
    if (binary) {
      try {
        data = Buffer.from(decodeBinaryInput(body, message.format === 'hex' ? 'hex' : 'base64'))
      } catch (err) {
        throw new Fault('INVALID_ARGUMENT', messageOf(err))
      }
    } else data = Buffer.from(body, 'utf8')
    await new Promise<void>((resolve, reject) => ws.send(data, { binary }, (err) => (err ? reject(new Fault('NETWORK', `Sending failed: ${messageOf(err)}`)) : resolve())))
    return this.log(this.payload('out', data, binary))
  }

  /** Sends a ping frame (optional payload). */
  ping(): void {
    const ws = this.socket
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Fault('INVALID_ARGUMENT', 'Not connected. Connect first.')
    ws.ping()
    this.log({ direction: 'out', kind: 'ping', size: 0 })
  }

  /** Normal close (default 1000). Terminates if the peer does not answer within 5 s. */
  close(code = 1000, reason = ''): boolean {
    this.userClosed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
      this.setStatus('closed', { code, reason })
      return true
    }
    const ws = this.socket
    if (!ws) return false
    if (ws.readyState === WebSocket.CONNECTING) {
      ws.terminate()
      return true
    }
    const valid = code === 1000 || (code >= 3000 && code <= 4999)
    this.setStatus('closing')
    ws.close(valid ? code : 1000, reason.slice(0, 120))
    setTimeout(() => {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
    }, 5000).unref()
    return true
  }

  /** Immediate teardown (tab closed, window closed, app quit). */
  dispose(): void {
    this.disposed = true
    this.userClosed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.socket?.terminate()
    this.socket = null
  }
}

/** All open connections of the app, by id. */
export class WsManager {
  private readonly connections = new Map<string, WsConnection>()

  get size(): number {
    return this.connections.size
  }

  get(id: string): WsConnection {
    const c = this.connections.get(id)
    if (!c) throw new Fault('NOT_FOUND', 'This WebSocket connection is closed. Connect again.')
    return c
  }

  async connect(opts: WsConnectionOptions): Promise<{ status: WsStatus; error?: { code: string; message: string } }> {
    this.connections.get(opts.id)?.dispose()
    const c = new WsConnection({
      ...opts,
      emit: (e) => {
        opts.emit(e)
        // Forget connections that ended for good (a reconnect sets `reconnecting` right after).
        if (e.type === 'status' && (e.status === 'closed' || e.status === 'error'))
          setImmediate(() => {
            if ((c.state === 'closed' || c.state === 'error') && this.connections.get(opts.id) === c) this.connections.delete(opts.id)
          })
      }
    })
    this.connections.set(opts.id, c)
    try {
      return await c.connect()
    } catch (err) {
      if (this.connections.get(opts.id) === c) this.connections.delete(opts.id)
      throw err
    }
  }

  disconnect(id: string, code?: number, reason?: string): boolean {
    const c = this.connections.get(id)
    if (!c) return false
    const r = c.close(code, reason)
    this.connections.delete(id)
    return r
  }

  /** Closes every connection (or only those opened by `owner`). */
  closeAll(owner?: number): number {
    let n = 0
    for (const [id, c] of this.connections) {
      if (owner !== undefined && c.owner !== owner) continue
      c.dispose()
      this.connections.delete(id)
      n++
    }
    return n
  }
}
