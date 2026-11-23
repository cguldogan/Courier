/**
 * OAuth 2.0 authorization code grant (RFC 6749 §4.1) with PKCE S256 (RFC 7636), for native apps
 * (RFC 8252): the SYSTEM browser opens the authorize URL, the IdP redirects to a loopback listener on
 * 127.0.0.1 (random port, or the fixed port of a configured redirect URI), `state` is checked, the
 * code is exchanged at the token endpoint, and the token (plus refresh token) is cached and refreshed
 * automatically shortly before it expires.
 *
 * Token storage (decision):
 *  - Tokens live in main-process memory. They are persisted to `oauth-tokens.bin` in userData ONLY
 *    encrypted with the OS keystore through Electron `safeStorage` (injected as a `SecretBox`); when
 *    encryption is unavailable (or Linux falls back to its `basic_text` backend), tokens stay in
 *    memory and are gone after a restart. Nothing is ever written in plain text.
 *  - The file is outside every collection document, so tokens are never synced to a team.
 *  - The renderer only ever sees expiry and a masked preview (`eyJ…X1c`); sends mask the token in
 *    history, console and the request view like every other acquired token.
 *
 * Tokens are keyed by the RESOLVED authorize URL, token URL, client id, scope, audience, extra
 * parameters, redirect URI and the context (Personal or the team), never by templates or the client
 * secret. A variable that points the token URL elsewhere therefore needs a new token (and, for a
 * team collection, a new host approval) instead of sending an existing refresh token to a new host.
 *
 * Team collections are teammate-controlled input: before the first acquisition for a config, the
 * user must approve the authorize host (where the browser goes) and the token host (which receives
 * the client secret and the code). Approvals are stored per team + both origins.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { Fault } from './errors'
import { sendHttp, type SendOptions } from './http'
import { JsonFile } from './store'

export interface SecretBox {
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

export type Opener = (url: string) => Promise<void>

/** Fully resolved (variables and Key Vault references substituted) authorization-code config. */
export interface OAuthCodeConfig {
  /** `personal` or `team:<id>`: tokens and host approvals never cross contexts. */
  context: string
  authUrl: string
  tokenUrl: string
  clientId: string
  clientSecret: string
  scope: string
  audience: string
  extraParams: string
  redirectUri: string
  pkce: boolean
  clientAuthentication: 'header' | 'body'
}

export interface OAuthTokenView {
  hasToken: boolean
  expiresAt?: string
  expired: boolean
  refreshable: boolean
  /** First/last characters only. */
  preview?: string
}

interface TokenRecord {
  accessToken: string
  refreshToken?: string
  tokenType: string
  /** Epoch ms; absent = the server gave no expiry. */
  expiresAt?: number
  obtainedAt: number
}

export interface OAuthServiceOptions {
  userDataDir: string
  box: SecretBox | null
  /** Opens a URL in the system browser (Electron `shell.openExternal`; tests inject a fake browser). */
  open: Opener
  http: () => Omit<SendOptions, 'signal' | 'cookieJar'>
  /** How long to wait for the browser redirect (default 5 minutes). */
  timeoutMs?: number
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
const RESERVED = new Set(['response_type', 'client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method'])
const REFRESH_MARGIN_MS = 60_000

const b64url = (b: Buffer): string => b.toString('base64url')

export function maskedPreview(token: string): string {
  if (token.length <= 8) return '•'.repeat(token.length)
  return `${token.slice(0, 3)}…${token.slice(-3)}`
}

function httpUrl(raw: string, what: string): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Fault('INVALID_ARGUMENT', `OAuth 2.0: the ${what} "${raw}" is not a valid URL.`)
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Fault('INVALID_ARGUMENT', `OAuth 2.0: the ${what} must be an http(s) URL.`)
  return u
}

export function oauthHosts(cfg: Pick<OAuthCodeConfig, 'authUrl' | 'tokenUrl'>): { authHost: string; tokenHost: string } {
  return { authHost: httpUrl(cfg.authUrl, 'authorization URL').host, tokenHost: httpUrl(cfg.tokenUrl, 'access token URL').host }
}

/** The loopback redirect: `http://127.0.0.1:<port>/<path>` (port 0 = pick one). Anything else is refused. */
export function parseRedirect(raw: string): { hostname: string; bind: string; port: number; path: string } {
  if (!raw.trim()) return { hostname: '127.0.0.1', bind: '127.0.0.1', port: 0, path: '/callback' }
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new Fault('INVALID_ARGUMENT', `OAuth 2.0: the redirect URI "${raw}" is not a valid URL.`)
  }
  if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname))
    throw new Fault('INVALID_ARGUMENT', 'OAuth 2.0: the redirect URI must be a loopback http URL such as http://127.0.0.1:8765/callback (Courier listens on this machine only).')
  return { hostname: u.hostname, bind: u.hostname === '[::1]' ? '::1' : '127.0.0.1', port: u.port ? Number(u.port) : 80, path: u.pathname || '/' }
}

export function tokenKey(cfg: OAuthCodeConfig): string {
  return createHash('sha256')
    .update(JSON.stringify([cfg.context, cfg.authUrl, cfg.tokenUrl, cfg.clientId, cfg.scope, cfg.audience, cfg.extraParams, cfg.redirectUri]))
    .digest('hex')
}

const PAGE = (title: string, text: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;padding:3em;text-align:center"><h1>${title}</h1><p>${text}</p></body></html>`

export class OAuthService {
  private readonly file: string
  private readonly approvals: JsonFile<string[]>
  private tokens: Map<string, TokenRecord> | null = null
  private readonly refreshing = new Map<string, Promise<TokenRecord>>()
  private pending: AbortController | null = null

  constructor(private readonly opts: OAuthServiceOptions) {
    this.file = join(opts.userDataDir, 'oauth-tokens.bin')
    this.approvals = new JsonFile(join(opts.userDataDir, 'oauth-approvals.json'), () => [])
  }

  /** Where tokens are kept on this machine. */
  get storage(): 'encrypted' | 'memory' {
    return this.opts.box ? 'encrypted' : 'memory'
  }

  private async load(): Promise<Map<string, TokenRecord>> {
    if (this.tokens) return this.tokens
    const map = new Map<string, TokenRecord>()
    if (this.opts.box) {
      try {
        const data = await readFile(this.file)
        const parsed = JSON.parse(this.opts.box.decrypt(data)) as Record<string, TokenRecord>
        for (const [k, v] of Object.entries(parsed)) if (v && typeof v.accessToken === 'string') map.set(k, v)
      } catch {
        /* no file, or written by another keystore: start empty */
      }
    }
    this.tokens = map
    return map
  }

  private async persist(): Promise<void> {
    if (!this.opts.box || !this.tokens) return
    const data = this.opts.box.encrypt(JSON.stringify(Object.fromEntries(this.tokens)))
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, data)
    await rename(tmp, this.file)
  }

  private view(rec: TokenRecord | undefined): OAuthTokenView {
    if (!rec) return { hasToken: false, expired: false, refreshable: false }
    const expired = rec.expiresAt !== undefined && rec.expiresAt <= Date.now()
    return {
      hasToken: true,
      ...(rec.expiresAt !== undefined ? { expiresAt: new Date(rec.expiresAt).toISOString() } : {}),
      expired,
      refreshable: Boolean(rec.refreshToken),
      preview: maskedPreview(rec.accessToken)
    }
  }

  async status(cfg: OAuthCodeConfig): Promise<OAuthTokenView> {
    return this.view((await this.load()).get(tokenKey(cfg)))
  }

  async clear(cfg: OAuthCodeConfig): Promise<void> {
    const map = await this.load()
    if (map.delete(tokenKey(cfg))) await this.persist()
  }

  // ---------------------------------------------------------------------------------------------
  // Host approval (team collections)
  // ---------------------------------------------------------------------------------------------

  private approvalKey(cfg: OAuthCodeConfig): string {
    return `${cfg.context}|${httpUrl(cfg.authUrl, 'authorization URL').origin}|${httpUrl(cfg.tokenUrl, 'access token URL').origin}`
  }

  /** Personal configs never need approval; team configs need it once per authorize + token origin. */
  async needsApproval(cfg: OAuthCodeConfig): Promise<boolean> {
    if (cfg.context === 'personal') return false
    return !(await this.approvals.read()).includes(this.approvalKey(cfg))
  }

  /** Approves the hosts the user was shown; refuses if the config resolves to different hosts now. */
  async approve(cfg: OAuthCodeConfig, seen: { authHost: string; tokenHost: string }): Promise<void> {
    const now = oauthHosts(cfg)
    if (now.authHost !== seen.authHost || now.tokenHost !== seen.tokenHost)
      throw new Fault('CONFLICT', `The OAuth 2.0 hosts changed to ${now.authHost} / ${now.tokenHost} since you reviewed them. Review them again.`)
    const key = this.approvalKey(cfg)
    await this.approvals.update((list) => (Array.isArray(list) && list.includes(key) ? list : [...(Array.isArray(list) ? list : []), key]))
  }

  // ---------------------------------------------------------------------------------------------
  // Interactive acquisition
  // ---------------------------------------------------------------------------------------------

  /** Cancels a running "Get new token" flow. */
  cancel(): boolean {
    if (!this.pending) return false
    this.pending.abort()
    return true
  }

  async authorize(cfg: OAuthCodeConfig): Promise<OAuthTokenView> {
    const authUrl = httpUrl(cfg.authUrl, 'authorization URL')
    httpUrl(cfg.tokenUrl, 'access token URL')
    if (!cfg.clientId) throw new Fault('INVALID_ARGUMENT', 'OAuth 2.0: the client ID is empty.')
    if (await this.needsApproval(cfg)) {
      const h = oauthHosts(cfg)
      throw new Fault('FORBIDDEN', `Review and approve the OAuth 2.0 hosts first (browser: ${h.authHost}, token: ${h.tokenHost}).`)
    }
    const redirect = parseRedirect(cfg.redirectUri)
    this.pending?.abort()
    const ac = new AbortController()
    this.pending = ac
    const state = b64url(randomBytes(24))
    const verifier = b64url(randomBytes(32))
    const challenge = b64url(createHash('sha256').update(verifier).digest())

    let server: Server | null = null
    try {
      const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
        let redirectUri = ''
        const fail = (err: Fault): void => reject(err)
        server = createServer((req, res) => {
          const u = new URL(req.url ?? '/', 'http://loopback')
          if (u.pathname !== redirect.path) {
            res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
            return
          }
          const p = u.searchParams
          if (p.get('state') !== state) {
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Sign-in rejected', 'The response did not match the sign-in Courier started (state mismatch). Start again from Courier.'))
            fail(new Fault('AUTH_FAILED', 'OAuth 2.0: the authorization response had the wrong state parameter, so it was rejected. Start again with "Get new token".'))
            return
          }
          const error = p.get('error')
          if (error) {
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Sign-in failed', 'The identity provider returned an error. Return to Courier for details.'))
            const desc = p.get('error_description')
            fail(new Fault('AUTH_FAILED', `OAuth 2.0 authorization failed: ${error}${desc ? ` (${desc.slice(0, 300)})` : ''}`))
            return
          }
          const code = p.get('code')
          if (!code) {
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Sign-in failed', 'No authorization code was returned.'))
            fail(new Fault('AUTH_FAILED', 'OAuth 2.0: the authorization response carried no code.'))
            return
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }).end(PAGE('Signed in', 'You can close this tab and return to Courier.'))
          resolve({ code, redirectUri })
        })
        server.on('error', (err: NodeJS.ErrnoException) =>
          fail(new Fault('NETWORK', err.code === 'EADDRINUSE' ? `OAuth 2.0: port ${redirect.port} for the redirect URI is already in use.` : `OAuth 2.0: could not listen for the redirect: ${err.message}`))
        )
        const timer = setTimeout(() => fail(new Fault('TIMEOUT', 'OAuth 2.0: no response from the browser in time. Start again with "Get new token".')), this.opts.timeoutMs ?? 300_000)
        ac.signal.addEventListener('abort', () => fail(new Fault('CANCELLED', 'OAuth 2.0 sign-in cancelled.')))
        const done = (): void => clearTimeout(timer)
        ac.signal.addEventListener('abort', done)
        server.on('close', done)
        server.listen(redirect.port, redirect.bind, () => {
          const port = (server?.address() as AddressInfo).port
          redirectUri = cfg.redirectUri.trim() || `http://${redirect.hostname}:${port}${redirect.path}`
          const target = new URL(authUrl)
          const q = target.searchParams
          for (const [k, v] of new URLSearchParams(cfg.extraParams)) if (!RESERVED.has(k)) q.append(k, v)
          q.set('response_type', 'code')
          q.set('client_id', cfg.clientId)
          q.set('redirect_uri', redirectUri)
          if (cfg.scope) q.set('scope', cfg.scope)
          if (cfg.audience) q.set('audience', cfg.audience)
          q.set('state', state)
          if (cfg.pkce) {
            q.set('code_challenge', challenge)
            q.set('code_challenge_method', 'S256')
          }
          this.opts.open(target.toString()).catch((err: unknown) => fail(new Fault('INTERNAL', `Could not open the browser: ${err instanceof Error ? err.message : String(err)}`)))
        })
      })
      const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri })
      if (cfg.pkce) form.set('code_verifier', verifier)
      const rec = await this.tokenRequest(cfg, form, ac.signal)
      const map = await this.load()
      map.set(tokenKey(cfg), rec)
      await this.persist()
      return this.view(rec)
    } finally {
      if (this.pending === ac) this.pending = null
      const s = server as Server | null
      if (s) {
        s.closeAllConnections()
        s.close()
      }
    }
  }

  private async tokenRequest(cfg: OAuthCodeConfig, form: URLSearchParams, signal?: AbortSignal, previous?: TokenRecord): Promise<TokenRecord> {
    const headers: [string, string][] = [
      ['Content-Type', 'application/x-www-form-urlencoded'],
      ['Accept', 'application/json']
    ]
    if (cfg.clientAuthentication === 'header' && cfg.clientSecret)
      headers.push(['Authorization', 'Basic ' + Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString('base64')])
    else {
      form.set('client_id', cfg.clientId)
      if (cfg.clientSecret) form.set('client_secret', cfg.clientSecret)
    }
    const res = await sendHttp({ method: 'POST', url: cfg.tokenUrl, headers, body: form.toString() }, { ...this.opts.http(), signal })
    let json: { access_token?: string; refresh_token?: string; expires_in?: number | string; token_type?: string; error?: string; error_description?: string } = {}
    try {
      json = JSON.parse(res.bodyText)
    } catch {
      json = Object.fromEntries(new URLSearchParams(res.bodyText))
    }
    if (res.status >= 400 || !json.access_token) {
      const why = json.error_description ?? json.error ?? `HTTP ${res.status}`
      throw new Fault(res.status === 400 || res.status === 401 ? 'AUTH_REQUIRED' : 'AUTH_FAILED', `OAuth 2.0 token request failed (${res.status}): ${String(why).slice(0, 300)}`)
    }
    const expiresIn = Number(json.expires_in)
    return {
      accessToken: json.access_token,
      ...(json.refresh_token ? { refreshToken: json.refresh_token } : previous?.refreshToken ? { refreshToken: previous.refreshToken } : {}),
      tokenType: json.token_type ?? 'Bearer',
      ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
      obtainedAt: Date.now()
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Send time (never opens a browser)
  // ---------------------------------------------------------------------------------------------

  /** A valid access token for the config, refreshed if it expires within a minute. */
  async accessToken(cfg: OAuthCodeConfig, signal?: AbortSignal): Promise<string> {
    const map = await this.load()
    const key = tokenKey(cfg)
    const rec = map.get(key)
    if (!rec) throw new Fault('AUTH_REQUIRED', 'No OAuth 2.0 access token for this configuration yet. Open the Authorization tab and press "Get new token".')
    if (rec.expiresAt === undefined || rec.expiresAt - Date.now() > REFRESH_MARGIN_MS) return rec.accessToken
    if (!rec.refreshToken) throw new Fault('AUTH_REQUIRED', 'The OAuth 2.0 access token has expired and there is no refresh token. Press "Get new token" in the Authorization tab.')
    let p = this.refreshing.get(key)
    if (!p) {
      const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rec.refreshToken })
      if (cfg.scope) form.set('scope', cfg.scope)
      p = this.tokenRequest(cfg, form, signal, rec)
        .then(async (next) => {
          map.set(key, next)
          await this.persist()
          return next
        })
        .catch(async (err: unknown) => {
          if (err instanceof Fault && err.code === 'AUTH_REQUIRED') {
            map.delete(key)
            await this.persist()
            throw new Fault('AUTH_REQUIRED', `${err.message} The refresh token was rejected; press "Get new token" in the Authorization tab.`)
          }
          throw err
        })
        .finally(() => this.refreshing.delete(key))
      this.refreshing.set(key, p)
    }
    return (await p).accessToken
  }
}

/** The resolved authorization-code config of a (variable- and vault-resolved) oauth2 auth. */
export function codeConfig(a: { accessTokenUrl: string; clientId: string; clientSecret: string; scope: string; audience: string; clientAuthentication: 'header' | 'body'; authUrl?: string; redirectUri?: string; pkce?: boolean; extraParams?: string }, context: string): OAuthCodeConfig {
  return {
    context,
    authUrl: (a.authUrl ?? '').trim(),
    tokenUrl: a.accessTokenUrl.trim(),
    clientId: a.clientId,
    clientSecret: a.clientSecret,
    scope: a.scope,
    audience: a.audience,
    extraParams: a.extraParams ?? '',
    redirectUri: (a.redirectUri ?? '').trim(),
    pkce: a.pkce !== false,
    clientAuthentication: a.clientAuthentication
  }
}
