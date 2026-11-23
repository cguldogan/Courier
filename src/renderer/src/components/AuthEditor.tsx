/** Authorization editor for requests, folders and collections. */
import { useEffect, useState } from 'react'
import type { OAuthTokenStatus } from '../../../shared/api'
import { defaultAuth } from '../../../shared/auth'
import { JWT_ALGORITHMS, type Auth, type AuthType, type Id, type JwtAlgorithm } from '../../../shared/types'
import { courier } from '../api'
import { useApp } from '../store'
import { Spinner, VarInput } from './ui'

const LABELS: Record<AuthType, string> = {
  inherit: 'Inherit auth from parent',
  none: 'No auth',
  basic: 'Basic auth',
  bearer: 'Bearer token',
  apikey: 'API key',
  jwt: 'JWT bearer',
  digest: 'Digest auth',
  oauth2: 'OAuth 2.0',
  awsv4: 'AWS Signature',
  ntlm: 'NTLM',
  entra: 'Azure identity (Entra ID token)'
}

function describe(a: Auth): string {
  switch (a.type) {
    case 'basic':
      return `Basic auth (${a.username || 'no username'})`
    case 'bearer':
      return 'Bearer token'
    case 'apikey':
      return `API key "${a.key}" in ${a.in}`
    case 'oauth2':
      return a.grantType === 'authorization_code' ? 'OAuth 2.0 authorization code' : 'OAuth 2.0 client credentials'
    case 'entra':
      return `Azure identity token for ${a.scope || '(no scope)'}`
    case 'digest':
      return `Digest auth (${a.username || 'no username'})`
    case 'awsv4':
      return `AWS Signature (${a.service || 'no service'}, ${a.region || 'us-east-1'})`
    case 'ntlm':
      return `NTLM (${a.domain ? a.domain + '\\' : ''}${a.username || 'no username'})`
    case 'jwt':
      return `JWT bearer (${a.algorithm})`
    default:
      return 'No auth'
  }
}

/**
 * `parentRef`: where the "inherit" hint is computed from (the collection + the parent folder of
 * the edited item, or null for top level). Omit to hide the inherit option (collection level).
 */
export function AuthEditor({
  auth,
  onChange,
  collectionId,
  parentRef,
  allowInherit
}: {
  auth: Auth
  onChange: (a: Auth) => void
  collectionId: Id | null
  parentRef?: { collectionId: Id; itemId: Id | null } | null
  allowInherit: boolean
}): React.JSX.Element {
  const identity = useApp((s) => s.identity)
  const snapshot = useApp((s) => s.snapshot)
  const [inherited, setInherited] = useState<{ auth: Auth; from: string } | null>(null)
  const [inheritErr, setInheritErr] = useState<string | null>(null)
  const types = (Object.keys(LABELS) as AuthType[]).filter((t) => allowInherit || t !== 'inherit')
  const refKey = parentRef ? `${parentRef.collectionId}:${parentRef.itemId}` : ''

  useEffect(() => {
    let live = true
    if (auth.type !== 'inherit' || !parentRef) {
      setInherited(null)
      return
    }
    void courier()
      .requests.effectiveAuth(parentRef)
      .then((r) => {
        if (!live) return
        if (r.ok) {
          setInherited(r.value)
          setInheritErr(null)
        } else setInheritErr(r.error.message)
      })
    return () => {
      live = false
    }
  }, [auth.type, refKey, snapshot])

  const set = (patch: Partial<Auth>): void => onChange({ ...auth, ...patch } as Auth)

  return (
    <div className="auth-editor" data-testid="auth-editor">
      <div className="auth-type">
        <label className="field-label" htmlFor="auth-type">
          Auth type
        </label>
        <select id="auth-type" aria-label="Auth type" data-testid="auth-type" value={auth.type} onChange={(e) => onChange(defaultAuth(e.target.value as AuthType))}>
          {types.map((t) => (
            <option key={t} value={t}>
              {LABELS[t]}
            </option>
          ))}
        </select>
        <p className="muted small">Values can use {'{{variables}}'} and Key Vault references like {'{{vault:alias/secret-name}}'} — those are resolved at send time and never stored.</p>
      </div>
      <div className="auth-fields">
        {auth.type === 'inherit' &&
          (parentRef ? (
            inheritErr ? (
              <p className="error-text">{inheritErr}</p>
            ) : (
              <p className="info-box" data-testid="inherited-auth">
                {inherited ? (
                  <>
                    Uses <strong>{describe(inherited.auth)}</strong> inherited from <strong>{inherited.from}</strong>.
                  </>
                ) : (
                  'Resolving inherited auth…'
                )}
              </p>
            )
          ) : (
            <p className="info-box">This request is not saved in a collection, so there is nothing to inherit — no auth is sent.</p>
          ))}
        {auth.type === 'none' && <p className="muted">No Authorization header is added.</p>}
        {auth.type === 'basic' && (
          <div className="form-grid">
            <label>Username</label>
            <VarInput ariaLabel="Username" value={auth.username} collectionId={collectionId} onChange={(v) => set({ username: v })} />
            <label>Password</label>
            <VarInput ariaLabel="Password" type={auth.password.includes('{{') ? 'text' : 'password'} value={auth.password} collectionId={collectionId} onChange={(v) => set({ password: v })} />
          </div>
        )}
        {auth.type === 'bearer' && (
          <div className="form-grid">
            <label>Token</label>
            <VarInput ariaLabel="Token" value={auth.token} collectionId={collectionId} placeholder="{{token}} or {{vault:api-token}}" onChange={(v) => set({ token: v })} />
          </div>
        )}
        {auth.type === 'apikey' && (
          <div className="form-grid">
            <label>Key</label>
            <VarInput ariaLabel="API key name" value={auth.key} collectionId={collectionId} onChange={(v) => set({ key: v })} />
            <label>Value</label>
            <VarInput ariaLabel="API key value" value={auth.value} collectionId={collectionId} onChange={(v) => set({ value: v })} />
            <label>Add to</label>
            <select aria-label="Add API key to" value={auth.in} onChange={(e) => set({ in: e.target.value as 'header' | 'query' })}>
              <option value="header">Header</option>
              <option value="query">Query params</option>
            </select>
          </div>
        )}
        {auth.type === 'oauth2' && (
          <div className="form-grid">
            <label>Grant type</label>
            <select
              aria-label="Grant type"
              data-testid="oauth-grant"
              value={auth.grantType}
              onChange={(e) =>
                onChange(
                  e.target.value === 'authorization_code'
                    ? { ...auth, grantType: 'authorization_code', authUrl: auth.authUrl ?? '', redirectUri: auth.redirectUri ?? '', pkce: auth.pkce ?? true, extraParams: auth.extraParams ?? '' }
                    : { type: 'oauth2', grantType: 'client_credentials', accessTokenUrl: auth.accessTokenUrl, clientId: auth.clientId, clientSecret: auth.clientSecret, scope: auth.scope, audience: auth.audience, clientAuthentication: auth.clientAuthentication }
                )
              }
            >
              <option value="client_credentials">Client credentials</option>
              <option value="authorization_code">Authorization code (browser)</option>
            </select>
            {auth.grantType === 'authorization_code' && (
              <>
                <label>Authorization URL</label>
                <VarInput ariaLabel="Authorization URL" testId="oauth-auth-url" value={auth.authUrl ?? ''} collectionId={collectionId} placeholder="https://login.example.com/oauth2/authorize" onChange={(v) => set({ authUrl: v })} />
              </>
            )}
            <label>Access token URL</label>
            <VarInput ariaLabel="Access token URL" testId="oauth-token-url" value={auth.accessTokenUrl} collectionId={collectionId} onChange={(v) => set({ accessTokenUrl: v })} />
            <label>Client ID</label>
            <VarInput ariaLabel="Client ID" testId="oauth-client-id" value={auth.clientId} collectionId={collectionId} onChange={(v) => set({ clientId: v })} />
            <label>Client secret</label>
            <VarInput ariaLabel="Client secret" value={auth.clientSecret} collectionId={collectionId} placeholder={auth.grantType === 'authorization_code' ? 'Optional with PKCE · {{vault:client-secret}}' : '{{vault:client-secret}}'} onChange={(v) => set({ clientSecret: v })} />
            <label>Scope</label>
            <VarInput ariaLabel="Scope" testId="oauth-scope" value={auth.scope} collectionId={collectionId} onChange={(v) => set({ scope: v })} />
            <label>Audience</label>
            <VarInput ariaLabel="Audience" value={auth.audience} collectionId={collectionId} onChange={(v) => set({ audience: v })} />
            {auth.grantType === 'authorization_code' && (
              <>
                <label>Redirect URI</label>
                <VarInput ariaLabel="Redirect URI" testId="oauth-redirect" value={auth.redirectUri ?? ''} collectionId={collectionId} placeholder="http://127.0.0.1:<random port>/callback" onChange={(v) => set({ redirectUri: v })} />
                <label>Extra authorize parameters</label>
                <VarInput ariaLabel="Extra authorize parameters" value={auth.extraParams ?? ''} collectionId={collectionId} placeholder="prompt=consent&resource=…" onChange={(v) => set({ extraParams: v })} />
                <span />
                <label className="check">
                  <input type="checkbox" aria-label="Use PKCE" checked={auth.pkce !== false} onChange={(e) => set({ pkce: e.target.checked })} /> PKCE (S256)
                </label>
              </>
            )}
            <label>Client authentication</label>
            <select aria-label="Client authentication" value={auth.clientAuthentication} onChange={(e) => set({ clientAuthentication: e.target.value as 'header' | 'body' })}>
              <option value="body">Send credentials in body</option>
              <option value="header">Send as Basic auth header</option>
            </select>
            <span />
            {auth.grantType === 'authorization_code' ? (
              <OAuthTokenPanel auth={auth} collectionId={collectionId} />
            ) : (
              <p className="muted small">The token is fetched before the request and cached in memory until it expires.</p>
            )}
          </div>
        )}
        {auth.type === 'digest' && (
          <div className="form-grid">
            <label>Username</label>
            <VarInput ariaLabel="Digest username" testId="digest-username" value={auth.username} collectionId={collectionId} onChange={(v) => set({ username: v })} />
            <label>Password</label>
            <VarInput ariaLabel="Digest password" testId="digest-password" type={auth.password.includes('{{') ? 'text' : 'password'} value={auth.password} collectionId={collectionId} onChange={(v) => set({ password: v })} />
            <span />
            <p className="muted small">Courier answers the server&apos;s challenge (MD5 or SHA-256, qop auth / auth-int) and retries once when the nonce is stale.</p>
          </div>
        )}
        {auth.type === 'ntlm' && (
          <div className="form-grid">
            <label>Username</label>
            <VarInput ariaLabel="NTLM username" testId="ntlm-username" value={auth.username} collectionId={collectionId} onChange={(v) => set({ username: v })} />
            <label>Password</label>
            <VarInput ariaLabel="NTLM password" testId="ntlm-password" type={auth.password.includes('{{') ? 'text' : 'password'} value={auth.password} collectionId={collectionId} onChange={(v) => set({ password: v })} />
            <label>Domain</label>
            <VarInput ariaLabel="NTLM domain" testId="ntlm-domain" value={auth.domain} collectionId={collectionId} onChange={(v) => set({ domain: v })} />
            <label>Workstation</label>
            <VarInput ariaLabel="NTLM workstation" value={auth.workstation} collectionId={collectionId} onChange={(v) => set({ workstation: v })} />
            <span />
            <p className="muted small">NTLMv2 only. The three-message handshake runs on one connection.</p>
          </div>
        )}
        {auth.type === 'awsv4' && (
          <div className="form-grid">
            <label>Access key</label>
            <VarInput ariaLabel="AWS access key" testId="aws-access-key" value={auth.accessKey} collectionId={collectionId} onChange={(v) => set({ accessKey: v })} />
            <label>Secret key</label>
            <VarInput ariaLabel="AWS secret key" testId="aws-secret-key" value={auth.secretKey} collectionId={collectionId} placeholder="{{vault:aws-secret-key}}" onChange={(v) => set({ secretKey: v })} />
            <label>Session token</label>
            <VarInput ariaLabel="AWS session token" value={auth.sessionToken} collectionId={collectionId} placeholder="Optional" onChange={(v) => set({ sessionToken: v })} />
            <label>Region</label>
            <VarInput ariaLabel="AWS region" testId="aws-region" value={auth.region} collectionId={collectionId} placeholder="us-east-1" onChange={(v) => set({ region: v })} />
            <label>Service</label>
            <VarInput ariaLabel="AWS service" testId="aws-service" value={auth.service} collectionId={collectionId} placeholder="s3, execute-api, sts…" onChange={(v) => set({ service: v })} />
            <label>Add signature to</label>
            <select aria-label="Add AWS signature to" value={auth.addTo} onChange={(e) => set({ addTo: e.target.value as 'header' | 'query' })}>
              <option value="header">Authorization header</option>
              <option value="query">Query parameters (presigned URL)</option>
            </select>
          </div>
        )}
        {auth.type === 'jwt' && (
          <div className="form-grid">
            <label>Algorithm</label>
            <select aria-label="JWT algorithm" data-testid="jwt-algorithm" value={auth.algorithm} onChange={(e) => set({ algorithm: e.target.value as JwtAlgorithm })}>
              {JWT_ALGORITHMS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
            {auth.algorithm.startsWith('HS') ? (
              <>
                <label>Secret</label>
                <VarInput ariaLabel="JWT secret" testId="jwt-secret" value={auth.secret} collectionId={collectionId} placeholder="{{vault:jwt-secret}}" onChange={(v) => set({ secret: v })} />
                <span />
                <label className="check">
                  <input type="checkbox" aria-label="Secret is Base64 encoded" checked={auth.secretBase64} onChange={(e) => set({ secretBase64: e.target.checked })} /> Secret is Base64 encoded
                </label>
              </>
            ) : (
              <>
                <label>Private key (PEM)</label>
                <textarea aria-label="JWT private key" data-testid="jwt-private-key" className="mono auth-textarea" rows={4} spellCheck={false} placeholder="{{vault:jwt-private-key}} or -----BEGIN PRIVATE KEY-----…" value={auth.secret} onChange={(e) => set({ secret: e.target.value })} />
              </>
            )}
            <label>Payload (JSON)</label>
            <textarea aria-label="JWT payload" data-testid="jwt-payload" className="mono auth-textarea" rows={5} spellCheck={false} value={auth.payload} onChange={(e) => set({ payload: e.target.value })} />
            <label>Extra header (JSON)</label>
            <textarea aria-label="JWT header" className="mono auth-textarea" rows={2} spellCheck={false} placeholder='{"kid": "key-1"}' value={auth.header} onChange={(e) => set({ header: e.target.value })} />
            <label>Add token to</label>
            <select aria-label="Add JWT to" value={auth.addTo} onChange={(e) => set({ addTo: e.target.value as 'header' | 'query' })}>
              <option value="header">Authorization header</option>
              <option value="query">Query parameter</option>
            </select>
            {auth.addTo === 'header' ? (
              <>
                <label>Header prefix</label>
                <VarInput ariaLabel="JWT header prefix" value={auth.headerPrefix} collectionId={collectionId} onChange={(v) => set({ headerPrefix: v })} />
              </>
            ) : (
              <>
                <label>Query parameter</label>
                <VarInput ariaLabel="JWT query parameter" value={auth.queryParamKey} collectionId={collectionId} onChange={(v) => set({ queryParamKey: v })} />
              </>
            )}
            <span />
            <p className="muted small">Signed at send time; the token is masked in history and the console.</p>
          </div>
        )}
        {auth.type === 'entra' && (
          <div className="form-grid">
            <label>Scope</label>
            <VarInput ariaLabel="Entra scope" testId="entra-scope" value={auth.scope} collectionId={collectionId} placeholder="https://graph.microsoft.com/.default" onChange={(v) => set({ scope: v })} />
            <span />
            <p className="muted small">
              Sends <code>Authorization: Bearer &lt;token&gt;</code> using the signed-in Azure identity
              {identity?.signedIn ? ` (${identity.account?.upn ?? identity.account?.name ?? 'signed in'})` : ' — you are not signed in yet'}. The token stays in the main process and is masked in history.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function expiresIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'expired'
  const min = Math.round(ms / 60000)
  return min < 60 ? `in ${min} min` : `in ${Math.round(min / 60)} h`
}

/** Token state + "Get new token" / "Clear token" for the authorization-code grant. */
function OAuthTokenPanel({ auth, collectionId }: { auth: Extract<Auth, { type: 'oauth2' }>; collectionId: Id | null }): React.JSX.Element {
  const openDialog = useApp((s) => s.openDialog)
  const toast = useApp((s) => s.toast)
  const activeEnv = useApp((s) => s.snapshot?.activeEnvironmentId)
  const [status, setStatus] = useState<OAuthTokenStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = { auth, collectionId }
  const key = JSON.stringify([auth, collectionId, activeEnv])

  const refresh = async (): Promise<void> => {
    const r = await courier().oauth.status(input)
    if (r.ok) {
      setStatus(r.value)
      setError(null)
    } else setError(r.error.message)
  }
  useEffect(() => {
    const t = setTimeout(() => void refresh(), 250)
    return () => clearTimeout(t)
  }, [key])

  const acquire = async (approveHosts?: { authHost: string; tokenHost: string }): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await courier().oauth.getNewToken({ ...input, ...(approveHosts ? { approveHosts } : {}) })
    setBusy(false)
    if (!r.ok) {
      setError(r.error.message)
      if (r.error.code !== 'CANCELLED') toast('error', r.error.message)
      return
    }
    if (r.value.status === 'approval-required') {
      const hosts = { authHost: r.value.authHost, tokenHost: r.value.tokenHost }
      openDialog({
        type: 'confirm',
        title: 'Review OAuth 2.0 hosts',
        message: `This collection belongs to a team, so its OAuth settings come from teammates. Your browser will open ${hosts.authHost}, and the authorization code${auth.clientSecret ? ' and the client secret' : ''} will be sent to ${hosts.tokenHost}. Continue only if you trust both hosts.`,
        confirmLabel: 'Trust and continue',
        onConfirm: () => acquire(hosts)
      })
      return
    }
    setStatus(r.value.token)
    toast('success', 'OAuth 2.0 token acquired')
  }

  return (
    <div className="oauth-panel" data-testid="oauth-panel">
      <div className="oauth-status" data-testid="oauth-token-status" data-has-token={status?.hasToken ? 'true' : 'false'}>
        {status?.hasToken ? (
          <>
            Token <code data-testid="oauth-token-preview">{status.preview}</code>
            {status.expiresAt ? (
              <span data-testid="oauth-token-expiry">
                {' '}
                · expires {new Date(status.expiresAt).toLocaleTimeString()} ({expiresIn(status.expiresAt)})
              </span>
            ) : (
              ' · no expiry given'
            )}
            {status.refreshable && ' · refreshes automatically'}
          </>
        ) : (
          'No token yet. Requests fail until you get one.'
        )}
      </div>
      <div className="row-gap">
        {busy ? (
          <>
            <button className="btn small" data-testid="oauth-cancel" onClick={() => void courier().oauth.cancel()}>
              Cancel
            </button>
            <span className="muted small">
              <Spinner size={10} /> Waiting for the browser…
            </span>
          </>
        ) : (
          <button className="btn small primary" data-testid="oauth-get-token" onClick={() => void acquire()}>
            Get new token
          </button>
        )}
        <button
          className="btn small"
          data-testid="oauth-clear-token"
          disabled={busy || !status?.hasToken}
          onClick={async () => {
            const r = await courier().oauth.clearToken(input)
            if (r.ok) await refresh()
          }}
        >
          Clear token
        </button>
      </div>
      {error && <p className="error-text small">{error}</p>}
      <p className="muted small">
        {status?.authHost ? `Opens ${status.authHost} in your browser; ` : ''}redirects to a loopback address on this machine.{' '}
        {status?.storage === 'memory' ? 'Tokens are kept in memory only (OS encryption is unavailable).' : 'Tokens are stored encrypted with the OS keystore and never synced.'}
      </p>
    </div>
  )
}
