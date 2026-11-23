/**
 * Azure identity (main process only). Modes: managed-identity | azure-cli | browser | auto (MI → CLI).
 * Tokens stay in main; the renderer only sees decoded display claims.
 *
 * Test hook: `COURIER_FAKE_IDENTITY={"name","upn","oid","tid"}` → a fake credential that mints
 * *unsigned* JWTs (aud derived from the requested scope) — accepted by Azurite `--oauth basic` and by
 * the mock Key Vault in tests. Never used unless that env var is set.
 */
import type { AccessToken, GetTokenOptions, TokenCredential } from '@azure/core-auth'
import { AzureCliCredential, CredentialUnavailableError, InteractiveBrowserCredential, ManagedIdentityCredential } from '@azure/identity'
import type { IdentityAccount, IdentitySettings, IdentityStatus } from '../shared/types'
import { Fault, messageOf } from './errors'

/** Scope used to prove sign-in and read display claims. */
export const SIGN_IN_SCOPE = 'https://management.azure.com/.default'
export const STORAGE_SCOPE = 'https://storage.azure.com/.default'
/** Azure CLI's well-known public client id (default for InteractiveBrowserCredential). */
const DEFAULT_BROWSER_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'

export interface FakeIdentity {
  name?: string
  upn?: string
  oid: string
  tid: string
}

export function parseFakeIdentity(raw: string | undefined): FakeIdentity | null {
  if (!raw) return null
  const o = JSON.parse(raw) as Partial<FakeIdentity>
  if (!o.oid || !o.tid) throw new Error('COURIER_FAKE_IDENTITY needs at least "oid" and "tid".')
  return { name: o.name, upn: o.upn, oid: o.oid, tid: o.tid }
}

const b64url = (s: string): string => Buffer.from(s).toString('base64url')

export function audienceForScope(scope: string): string {
  return scope.replace(/\/\.default$/, '').replace(/\/$/, '')
}

/** Unsigned JWT (`alg: none`) — for tests only. */
export function mintFakeJwt(id: FakeIdentity, scope: string, lifetimeSec = 3600): { token: string; exp: number } {
  const now = Math.floor(Date.now() / 1000)
  const exp = now + lifetimeSec
  const payload = {
    aud: audienceForScope(scope),
    iss: `https://sts.windows.net/${id.tid}/`,
    iat: now - 5,
    nbf: now - 5,
    exp,
    oid: id.oid,
    tid: id.tid,
    sub: id.oid,
    name: id.name,
    upn: id.upn,
    unique_name: id.upn,
    scp: 'user_impersonation',
    ver: '1.0'
  }
  return { token: `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.`, exp }
}

export class FakeCredential implements TokenCredential {
  constructor(private readonly id: FakeIdentity) {}
  async getToken(scopes: string | string[]): Promise<AccessToken> {
    const scope = Array.isArray(scopes) ? scopes[0] : scopes
    const { token, exp } = mintFakeJwt(this.id, scope)
    return { token, expiresOnTimestamp: exp * 1000 }
  }
}

/** Decode JWT claims for display only (no validation). */
export function decodeJwtClaims(token: string): Record<string, unknown> {
  const part = token.split('.')[1]
  if (!part) return {}
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function accountFromClaims(c: Record<string, unknown>): IdentityAccount {
  const s = (k: string): string | undefined => (typeof c[k] === 'string' ? (c[k] as string) : undefined)
  const a: IdentityAccount = {}
  const name = s('name')
  const upn = s('upn') ?? s('unique_name') ?? s('preferred_username') ?? s('email')
  const oid = s('oid')
  const tid = s('tid')
  const appId = s('appid') ?? s('azp')
  if (name) a.name = name
  if (upn) a.upn = upn
  if (oid) a.oid = oid
  if (tid) a.tid = tid
  if (appId) a.appId = appId
  return a
}

export interface TokenProvider {
  /** Access token for `scope` from the signed-in identity (throws `NOT_SIGNED_IN`). */
  getToken(scope: string, opts?: { tenantId?: string }): Promise<string>
  /** A stable TokenCredential that delegates to whatever identity is signed in. */
  credential(): TokenCredential
  account(): IdentityAccount | null
}

/**
 * Off Azure, the managed-identity endpoint (IMDS) may not answer at all and the SDK then waits for
 * minutes (measured > 120 s on a dev Mac). Bound it and report "unavailable" so callers can move on.
 */
export class TimeboxedCredential implements TokenCredential {
  constructor(
    private readonly inner: TokenCredential,
    private readonly ms: number,
    private readonly what: string
  ) {}
  getToken(scopes: string | string[], options?: GetTokenOptions): Promise<AccessToken | null> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new CredentialUnavailableError(`${this.what}: no response within ${Math.round(this.ms / 1000)} s.`)), this.ms)
      this.inner.getToken(scopes, options).then(
        (v) => {
          clearTimeout(t)
          resolve(v)
        },
        (e: unknown) => {
          clearTimeout(t)
          reject(e)
        }
      )
    })
  }
}

/** `auto`: managed identity (short probe) → Azure CLI; the first one that works is kept. */
export class AutoCredential implements TokenCredential {
  private chosen: TokenCredential | null = null
  constructor(
    private readonly mi: TokenCredential,
    private readonly cli: TokenCredential
  ) {}
  async getToken(scopes: string | string[], options?: GetTokenOptions): Promise<AccessToken | null> {
    if (this.chosen) return this.chosen.getToken(scopes, options)
    const errors: string[] = []
    for (const c of [this.mi, this.cli]) {
      try {
        const tok = await c.getToken(scopes, options)
        if (tok) {
          this.chosen = c
          return tok
        }
      } catch (err) {
        errors.push(messageOf(err).split('\n')[0])
      }
    }
    throw new CredentialUnavailableError(`No identity available (managed identity, then Azure CLI): ${errors.join(' | ')}`)
  }
}

export const MI_PROBE_MS = 3_000
export const MI_EXPLICIT_MS = 15_000

function buildCredential(s: IdentitySettings): TokenCredential {
  const mi = (ms: number): TokenCredential =>
    new TimeboxedCredential(
      s.managedIdentityClientId ? new ManagedIdentityCredential({ clientId: s.managedIdentityClientId }) : new ManagedIdentityCredential(),
      ms,
      'Managed identity endpoint'
    )
  const cli = (): AzureCliCredential => new AzureCliCredential(s.tenantId ? { tenantId: s.tenantId } : {})
  switch (s.mode) {
    case 'managed-identity':
      return mi(MI_EXPLICIT_MS)
    case 'azure-cli':
      return cli()
    case 'browser':
      return new InteractiveBrowserCredential({
        tenantId: s.tenantId || 'organizations',
        clientId: s.clientId || DEFAULT_BROWSER_CLIENT_ID
      })
    case 'auto':
    default:
      return new AutoCredential(mi(MI_PROBE_MS), cli())
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Fault('TIMEOUT', `${what} timed out after ${Math.round(ms / 1000)} s.`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

export class IdentityService implements TokenProvider {
  private cred: TokenCredential | null = null
  private acct: IdentityAccount | null = null
  private mode: IdentitySettings['mode']
  private busy = false
  private lastError: string | undefined
  private readonly cache = new Map<string, { token: string; exp: number }>()
  private readonly delegating: TokenCredential

  constructor(
    initial: IdentitySettings,
    private readonly fake: FakeIdentity | null,
    private readonly onChange: (s: IdentityStatus) => void = () => {}
  ) {
    this.mode = initial.mode
    const self = this
    this.delegating = {
      async getToken(scopes: string | string[], options?: GetTokenOptions): Promise<AccessToken | null> {
        const c = self.cred
        if (!c) throw new Fault('NOT_SIGNED_IN', 'Sign in with your Azure identity first.')
        return c.getToken(scopes, options)
      }
    }
  }

  /** Reflect the saved mode before the first sign-in. */
  setMode(mode: IdentitySettings['mode']): void {
    if (!this.cred && !this.busy) this.mode = mode
  }

  status(): IdentityStatus {
    return {
      signedIn: this.cred !== null,
      busy: this.busy,
      mode: this.mode,
      account: this.acct,
      fake: this.fake !== null,
      ...(this.lastError ? { error: this.lastError } : {})
    }
  }

  account(): IdentityAccount | null {
    return this.acct
  }

  credential(): TokenCredential {
    return this.delegating
  }

  async signIn(settings: IdentitySettings): Promise<IdentityStatus> {
    if (this.busy) throw new Fault('BUSY', 'A sign-in is already in progress.')
    this.busy = true
    this.mode = settings.mode
    this.lastError = undefined
    this.onChange(this.status())
    try {
      const cred = this.fake ? new FakeCredential(this.fake) : buildCredential(settings)
      const timeoutMs = settings.mode === 'browser' ? 5 * 60_000 : 60_000
      const tok = await withTimeout(cred.getToken(SIGN_IN_SCOPE), timeoutMs, 'Sign-in')
      if (!tok) throw new Fault('AUTH_FAILED', 'The identity returned no token.')
      this.cache.clear()
      this.cache.set(SIGN_IN_SCOPE, { token: tok.token, exp: tok.expiresOnTimestamp })
      this.cred = cred
      this.acct = accountFromClaims(decodeJwtClaims(tok.token))
      this.busy = false
      return this.status()
    } catch (err) {
      this.cred = null
      this.acct = null
      this.lastError = cleanAuthError(err, settings.mode)
      throw err instanceof Fault ? err : new Fault('AUTH_FAILED', this.lastError)
    } finally {
      this.busy = false
      this.onChange(this.status())
    }
  }

  signOut(): IdentityStatus {
    this.cred = null
    this.acct = null
    this.lastError = undefined
    this.cache.clear()
    this.onChange(this.status())
    return this.status()
  }

  async getToken(scope: string, opts: { tenantId?: string } = {}): Promise<string> {
    if (!this.cred) throw new Fault('NOT_SIGNED_IN', 'Sign in with your Azure identity first.')
    const key = `${opts.tenantId ?? ''}|${scope}`
    const hit = this.cache.get(key)
    if (hit && hit.exp - Date.now() > 120_000) return hit.token
    try {
      const tok = await this.cred.getToken(scope, opts.tenantId ? { tenantId: opts.tenantId } : undefined)
      if (!tok) throw new Error('no token returned')
      this.cache.set(key, { token: tok.token, exp: tok.expiresOnTimestamp })
      return tok.token
    } catch (err) {
      throw new Fault('AUTH_FAILED', `Could not get a token for "${scope}": ${cleanAuthError(err, this.mode)}`)
    }
  }
}

function cleanAuthError(err: unknown, mode: IdentitySettings['mode']): string {
  const msg = messageOf(err).split('\n')[0]
  if (/az login|Azure CLI not found|Please run 'az login'/i.test(msg)) return "Azure CLI is not signed in or not installed — run 'az login' and retry."
  if (mode === 'managed-identity' && /unavailable|IMDS|endpoint|no response/i.test(msg))
    return 'No managed identity is available here (the app must run on Azure compute with an identity assigned).'
  return msg
}
