/**
 * HTTP Digest access authentication (RFC 7616), pure functions. Algorithms MD5, MD5-sess, SHA-256,
 * SHA-256-sess (SHA-512-256 is not offered by Node crypto under that name and is skipped);
 * qop `auth` (preferred) and `auth-int`; nonce count; `opaque` echoed; `userhash`; `stale`.
 */
import { createHash, randomBytes } from 'node:crypto'

export interface DigestChallenge {
  realm: string
  nonce: string
  opaque?: string
  algorithm: 'MD5' | 'MD5-sess' | 'SHA-256' | 'SHA-256-sess'
  /** Offered qop values (lower case); empty = RFC 2069 compatibility (no qop). */
  qop: string[]
  stale: boolean
  userhash: boolean
}

/** Splits `key=value` / `key="quoted, value"` auth-params. */
function parseParams(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g
  for (let m = re.exec(s); m; m = re.exec(s)) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3]
  return out
}

/** All Digest challenges in the `WWW-Authenticate` values, strongest algorithm first. */
export function parseDigestChallenges(values: string[]): DigestChallenge[] {
  const out: DigestChallenge[] = []
  for (const v of values) {
    // A header may carry several schemes; split at each "Digest " token.
    for (const part of v.split(/(?=\bDigest\s)/i)) {
      const m = /^\s*Digest\s+(.*)$/is.exec(part)
      if (!m) continue
      const p = parseParams(m[1])
      if (!p.nonce) continue
      const alg = (p.algorithm ?? 'MD5').toUpperCase()
      const algorithm = alg === 'MD5' ? 'MD5' : alg === 'MD5-SESS' ? 'MD5-sess' : alg === 'SHA-256' ? 'SHA-256' : alg === 'SHA-256-SESS' ? 'SHA-256-sess' : null
      if (!algorithm) continue
      out.push({
        realm: p.realm ?? '',
        nonce: p.nonce,
        ...(p.opaque !== undefined ? { opaque: p.opaque } : {}),
        algorithm,
        qop: (p.qop ?? '')
          .split(',')
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean),
        stale: (p.stale ?? '').toLowerCase() === 'true',
        userhash: (p.userhash ?? '').toLowerCase() === 'true'
      })
    }
  }
  const rank = (c: DigestChallenge): number => (c.algorithm.startsWith('SHA-256') ? 0 : 1)
  return out.sort((a, b) => rank(a) - rank(b))
}

const hashFn = (alg: DigestChallenge['algorithm']) => (s: string | Buffer): string =>
  createHash(alg.startsWith('SHA-256') ? 'sha256' : 'md5')
    .update(s)
    .digest('hex')

const quote = (s: string): string => `"${s.replace(/(["\\])/g, '\\$1')}"`

export interface DigestInput {
  challenge: DigestChallenge
  username: string
  password: string
  method: string
  /** request-target: path + query of the request URL. */
  uri: string
  body?: Buffer | string | null
  /** Nonce count for this nonce (1 for the first use). */
  nc: number
  cnonce?: string
  /** Use `auth-int` when the server offers it (default: prefer `auth`). */
  preferAuthInt?: boolean
}

export function digestAuthorization(input: DigestInput): { header: string; response: string; cnonce: string; qop?: string } {
  const c = input.challenge
  const H = hashFn(c.algorithm)
  const cnonce = input.cnonce ?? randomBytes(16).toString('hex')
  const nc = input.nc.toString(16).padStart(8, '0')
  const qop = c.qop.length === 0 ? undefined : input.preferAuthInt && c.qop.includes('auth-int') ? 'auth-int' : c.qop.includes('auth') ? 'auth' : c.qop.includes('auth-int') ? 'auth-int' : undefined
  let ha1 = H(`${input.username}:${c.realm}:${input.password}`)
  if (c.algorithm.endsWith('-sess')) ha1 = H(`${ha1}:${c.nonce}:${cnonce}`)
  const ha2 = qop === 'auth-int' ? H(`${input.method}:${input.uri}:${H(input.body ?? '')}`) : H(`${input.method}:${input.uri}`)
  const response = qop ? H(`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${c.nonce}:${ha2}`)
  const username = c.userhash ? H(`${input.username}:${c.realm}`) : input.username
  const parts = [
    `username=${quote(username)}`,
    `realm=${quote(c.realm)}`,
    `nonce=${quote(c.nonce)}`,
    `uri=${quote(input.uri)}`,
    `algorithm=${c.algorithm}`,
    `response=${quote(response)}`
  ]
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce=${quote(cnonce)}`)
  if (c.opaque !== undefined) parts.push(`opaque=${quote(c.opaque)}`)
  if (c.userhash) parts.push('userhash=true')
  return { header: `Digest ${parts.join(', ')}`, response, cnonce, ...(qop ? { qop } : {}) }
}

/** Server-side check used by tests and the e2e fake server's twin: parses an Authorization: Digest header. */
export function parseDigestAuthorization(header: string): Record<string, string> | null {
  const m = /^\s*Digest\s+(.*)$/is.exec(header)
  return m ? parseParams(m[1]) : null
}
