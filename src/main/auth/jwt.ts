/**
 * JWT signing (RFC 7519 / 7515) with Node crypto: HS256/384/512 (HMAC), RS256/384/512
 * (RSASSA-PKCS1-v1_5) and ES256/384 (ECDSA, IEEE P1363 signature encoding as JWS requires).
 */
import { createHmac, createPrivateKey, sign } from 'node:crypto'
import type { JwtAlgorithm } from '../../shared/types'
import { Fault } from '../errors'

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url')

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  if (!text.trim()) return {}
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch (err) {
    throw new Fault('INVALID_ARGUMENT', `JWT ${what} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Fault('INVALID_ARGUMENT', `JWT ${what} must be a JSON object.`)
  return v as Record<string, unknown>
}

export function signJwt(input: { algorithm: JwtAlgorithm; secret: string; secretBase64?: boolean; payload: string; header?: string }): string {
  const header = { ...parseJsonObject(input.header ?? '', 'header'), alg: input.algorithm, typ: 'JWT' }
  const payload = parseJsonObject(input.payload, 'payload')
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const bits = input.algorithm.slice(2)
  const digest = `sha${bits}`
  let sig: Buffer
  if (input.algorithm.startsWith('HS')) {
    if (!input.secret) throw new Fault('INVALID_ARGUMENT', 'JWT: the secret is empty.')
    const key = input.secretBase64 ? Buffer.from(input.secret, 'base64') : Buffer.from(input.secret, 'utf8')
    sig = createHmac(digest, key).update(signingInput).digest()
  } else {
    let key
    try {
      key = createPrivateKey(input.secret.replace(/\\n/g, '\n'))
    } catch {
      throw new Fault('INVALID_ARGUMENT', `JWT ${input.algorithm}: the private key is not a valid PEM private key.`)
    }
    const want = input.algorithm.startsWith('RS') ? 'rsa' : 'ec'
    if (key.asymmetricKeyType !== want) throw new Fault('INVALID_ARGUMENT', `JWT ${input.algorithm} needs an ${want.toUpperCase()} private key (got ${key.asymmetricKeyType ?? 'unknown'}).`)
    sig = want === 'rsa' ? sign(digest, Buffer.from(signingInput), key) : sign(digest, Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' })
  }
  return `${signingInput}.${b64url(sig)}`
}
