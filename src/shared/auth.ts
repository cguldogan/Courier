/**
 * Auth helpers shared by main and renderer: the one place that knows which fields of each auth type
 * are strings (so `{{variables}}`, `{{vault:…}}` references and masking cover every field), plus
 * defaults for a new auth of each type.
 */
import type { Auth, AuthType } from './types'

/**
 * Applies `fn` to every string field of an auth. Optional fields that are absent stay absent.
 * Every consumer (variable substitution, Key Vault resolution, the script gate's reference scan,
 * snippets) goes through this, so a new field cannot be missed by one of them.
 */
export function mapAuthStrings(a: Auth, fn: (s: string) => string): Auth {
  switch (a.type) {
    case 'inherit':
    case 'none':
      return a
    case 'basic':
      return { ...a, username: fn(a.username), password: fn(a.password) }
    case 'bearer':
      return { ...a, token: fn(a.token) }
    case 'apikey':
      return { ...a, key: fn(a.key), value: fn(a.value) }
    case 'oauth2':
      return {
        ...a,
        accessTokenUrl: fn(a.accessTokenUrl),
        clientId: fn(a.clientId),
        clientSecret: fn(a.clientSecret),
        scope: fn(a.scope),
        audience: fn(a.audience),
        ...(a.authUrl !== undefined ? { authUrl: fn(a.authUrl) } : {}),
        ...(a.redirectUri !== undefined ? { redirectUri: fn(a.redirectUri) } : {}),
        ...(a.extraParams !== undefined ? { extraParams: fn(a.extraParams) } : {})
      }
    case 'entra':
      return { ...a, scope: fn(a.scope) }
    case 'digest':
      return { ...a, username: fn(a.username), password: fn(a.password) }
    case 'awsv4':
      return { ...a, accessKey: fn(a.accessKey), secretKey: fn(a.secretKey), sessionToken: fn(a.sessionToken), region: fn(a.region), service: fn(a.service) }
    case 'ntlm':
      return { ...a, username: fn(a.username), password: fn(a.password), domain: fn(a.domain), workstation: fn(a.workstation) }
    case 'jwt':
      return { ...a, secret: fn(a.secret), payload: fn(a.payload), header: fn(a.header), headerPrefix: fn(a.headerPrefix), queryParamKey: fn(a.queryParamKey) }
    default: {
      const never: never = a
      return never
    }
  }
}

/** Calls `fn` for every string field (read-only walk). */
export function forEachAuthString(a: Auth, fn: (s: string) => void): void {
  mapAuthStrings(a, (s) => {
    fn(s)
    return s
  })
}

export function defaultAuth(type: AuthType): Auth {
  switch (type) {
    case 'inherit':
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
    case 'digest':
      return { type, username: '', password: '' }
    case 'awsv4':
      return { type, accessKey: '', secretKey: '', sessionToken: '', region: 'us-east-1', service: '', addTo: 'header' }
    case 'ntlm':
      return { type, username: '', password: '', domain: '', workstation: '' }
    case 'jwt':
      return { type, algorithm: 'HS256', secret: '', secretBase64: false, payload: '{\n  "sub": "1234567890"\n}', header: '', addTo: 'header', headerPrefix: 'Bearer', queryParamKey: 'token' }
    default: {
      const never: never = type
      return never
    }
  }
}

/** OAuth 2.0 authorization-code configs (interactive, token acquired with "Get new token"). */
export function isAuthCode(a: Auth): a is Extract<Auth, { type: 'oauth2' }> {
  return a.type === 'oauth2' && a.grantType === 'authorization_code'
}
