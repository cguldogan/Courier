/** Authorization editor for requests, folders and collections. */
import { useEffect, useState } from 'react'
import type { Auth, AuthType, Id } from '../../../shared/types'
import { courier } from '../api'
import { useApp } from '../store'
import { VarInput } from './ui'

const LABELS: Record<AuthType, string> = {
  inherit: 'Inherit auth from parent',
  none: 'No auth',
  basic: 'Basic auth',
  bearer: 'Bearer token',
  apikey: 'API key',
  oauth2: 'OAuth 2.0 (client credentials)',
  entra: 'Azure identity (Entra ID token)'
}

function defaults(type: AuthType): Auth {
  switch (type) {
    case 'inherit':
      return { type }
    case 'none':
      return { type }
    case 'basic':
      return { type, username: '', password: '' }
    case 'bearer':
      return { type, token: '' }
    case 'apikey':
      return { type, key: 'X-Api-Key', value: '', in: 'header' }
    case 'oauth2':
      return { type, grantType: 'client_credentials', accessTokenUrl: '', clientId: '', clientSecret: '', scope: '', audience: '', clientAuthentication: 'body' }
    case 'entra':
      return { type, scope: '' }
  }
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
      return 'OAuth 2.0 client credentials'
    case 'entra':
      return `Azure identity token for ${a.scope || '(no scope)'}`
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
        <select id="auth-type" aria-label="Auth type" data-testid="auth-type" value={auth.type} onChange={(e) => onChange(defaults(e.target.value as AuthType))}>
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
            <select aria-label="Grant type" value="client_credentials" disabled>
              <option value="client_credentials">Client credentials</option>
            </select>
            <label>Access token URL</label>
            <VarInput ariaLabel="Access token URL" value={auth.accessTokenUrl} collectionId={collectionId} onChange={(v) => set({ accessTokenUrl: v })} />
            <label>Client ID</label>
            <VarInput ariaLabel="Client ID" value={auth.clientId} collectionId={collectionId} onChange={(v) => set({ clientId: v })} />
            <label>Client secret</label>
            <VarInput ariaLabel="Client secret" value={auth.clientSecret} collectionId={collectionId} placeholder="{{vault:client-secret}}" onChange={(v) => set({ clientSecret: v })} />
            <label>Scope</label>
            <VarInput ariaLabel="Scope" value={auth.scope} collectionId={collectionId} onChange={(v) => set({ scope: v })} />
            <label>Audience</label>
            <VarInput ariaLabel="Audience" value={auth.audience} collectionId={collectionId} onChange={(v) => set({ audience: v })} />
            <label>Client authentication</label>
            <select aria-label="Client authentication" value={auth.clientAuthentication} onChange={(e) => set({ clientAuthentication: e.target.value as 'header' | 'body' })}>
              <option value="body">Send credentials in body</option>
              <option value="header">Send as Basic auth header</option>
            </select>
            <span />
            <p className="muted small">The token is fetched before the request and cached in memory until it expires.</p>
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
