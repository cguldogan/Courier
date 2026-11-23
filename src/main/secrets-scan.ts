/**
 * Secret scan before an item goes to a team: literal credentials in auth fields, secret-looking
 * headers (HTTP and WebSocket), gRPC metadata and secret-looking variables. Template references (`{{var}}`, `{{vault:x}}`) are fine.
 */
import type { Auth, Collection, Environment, Item, KeyValue, SecretFinding, Variable } from '../shared/types'

const SECRET_HEADERS = /^(authorization|proxy-authorization|x-api-key|api-key|apikey|x-auth-token|x-access-token|ocp-apim-subscription-key|x-functions-key|cookie)$/i
const SECRET_VAR_NAMES = /(pass(word)?|pwd|secret|token|api[-_]?key|apikey|private[-_]?key|connection[-_]?string|client[-_]?secret|sas|credential)/i
const SUGGESTION = 'Replace the literal value with {{vault:secret-name}} (Key Vault) or a secret-typed environment variable.'

/** True when the value carries literal secret material (not just template references / an auth scheme word). */
export function isLiteralSecret(value: string): boolean {
  const stripped = value
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/^\s*(bearer|basic|token|apikey|sharedaccesssignature)\b/i, '')
    .trim()
  return stripped.length > 0
}

export function preview(value: string): string {
  const v = value.trim()
  if (v.length <= 6) return '•'.repeat(v.length)
  return `${v.slice(0, 3)}…${v.slice(-2)}`
}

function authFindings(auth: Auth, where: string, push: (field: SecretFinding['field'], location: string, value: string) => void): void {
  switch (auth.type) {
    case 'basic':
      if (isLiteralSecret(auth.password)) push('basic.password', `${where} › auth (basic password)`, auth.password)
      break
    case 'bearer':
      if (isLiteralSecret(auth.token)) push('bearer.token', `${where} › auth (bearer token)`, auth.token)
      break
    case 'apikey':
      if (isLiteralSecret(auth.value)) push('apikey.value', `${where} › auth (API key "${auth.key}")`, auth.value)
      break
    case 'oauth2':
      if (isLiteralSecret(auth.clientSecret)) push('oauth2.clientSecret', `${where} › auth (OAuth 2.0 client secret)`, auth.clientSecret)
      break
    case 'digest':
      if (isLiteralSecret(auth.password)) push('digest.password', `${where} › auth (Digest password)`, auth.password)
      break
    case 'ntlm':
      if (isLiteralSecret(auth.password)) push('ntlm.password', `${where} › auth (NTLM password)`, auth.password)
      break
    case 'awsv4':
      if (isLiteralSecret(auth.secretKey)) push('awsv4.secretKey', `${where} › auth (AWS secret access key)`, auth.secretKey)
      if (isLiteralSecret(auth.sessionToken)) push('awsv4.sessionToken', `${where} › auth (AWS session token)`, auth.sessionToken)
      break
    case 'jwt':
      if (isLiteralSecret(auth.secret)) push('jwt.secret', `${where} › auth (JWT ${auth.algorithm.startsWith('HS') ? 'secret' : 'private key'})`, auth.secret)
      break
    default:
      break
  }
}

function headerFindings(headers: KeyValue[], where: string, push: (field: SecretFinding['field'], location: string, value: string) => void): void {
  for (const h of headers) if (SECRET_HEADERS.test(h.key.trim()) && isLiteralSecret(h.value)) push('header', `${where} › header "${h.key}"`, h.value)
}

/** gRPC metadata: the same secret-looking keys as headers (metadata keys are lower-case on the wire). */
function metadataFindings(metadata: KeyValue[], where: string, push: (field: SecretFinding['field'], location: string, value: string) => void): void {
  for (const m of metadata) if (SECRET_HEADERS.test(m.key.trim()) && isLiteralSecret(m.value)) push('metadata', `${where} › metadata "${m.key}"`, m.value)
}

function variableFindings(vars: Variable[], where: string, push: (field: SecretFinding['field'], location: string, value: string) => void): void {
  for (const v of vars) {
    if (v.type !== 'default' || !v.value) continue
    if (SECRET_VAR_NAMES.test(v.key) && isLiteralSecret(v.value)) push('variable', `${where} › variable "${v.key}"`, v.value)
  }
}

export function scanCollection(c: Collection): SecretFinding[] {
  const out: SecretFinding[] = []
  const push = (field: SecretFinding['field'], location: string, value: string): void => {
    out.push({ kind: 'collection', itemId: c.id, itemName: c.name, location, field, preview: preview(value), suggestion: SUGGESTION })
  }
  authFindings(c.auth, c.name, push)
  variableFindings(c.variables, c.name, push)
  const walk = (items: Item[], path: string): void => {
    for (const it of items) {
      const where = `${path} / ${it.name}`
      authFindings(it.auth, where, push)
      if (it.type === 'folder') walk(it.items, where)
      else if (it.type === 'grpc') metadataFindings(it.metadata, where, push)
      else headerFindings(it.headers, where, push)
    }
  }
  walk(c.items, c.name)
  return out
}

export function scanEnvironment(e: Environment): SecretFinding[] {
  const out: SecretFinding[] = []
  variableFindings(e.variables, e.name, (field, location, value) =>
    out.push({ kind: 'environment', itemId: e.id, itemName: e.name, location, field, preview: preview(value), suggestion: SUGGESTION })
  )
  return out
}
