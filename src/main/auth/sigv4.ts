/**
 * AWS Signature Version 4 (pure). Header signing (Authorization header) or query signing
 * (presigned URL). Verified against AWS's published test vectors (tests/sigv4.test.ts).
 *
 * - Every header present at signing time is signed except the ones proxies or the HTTP stack may
 *   change (list below, the same idea as the AWS SDKs' "unsignable" headers). The cookie jar's
 *   `Cookie` header is added later by http.ts and is never signed.
 * - S3 (`service` `s3`): the path is URI-encoded once and `x-amz-content-sha256` is always sent;
 *   for other services the path as sent is URI-encoded again ("double encoding").
 * - Query signing signs only `host`; for S3 the payload is `UNSIGNED-PAYLOAD`.
 */
import { createHash, createHmac } from 'node:crypto'

export interface SigV4Input {
  method: string
  url: string
  headers: [string, string][]
  body?: Buffer | string | null
  accessKey: string
  secretKey: string
  sessionToken?: string
  region: string
  service: string
  date: Date
  mode: 'header' | 'query'
  /** Query signing only (default 3600, max 604800). */
  expiresSeconds?: number
}

export interface SigV4Result {
  url: string
  headers: [string, string][]
  canonicalRequest: string
  stringToSign: string
  signature: string
  /** Header mode. */
  authorization?: string
}

const UNSIGNABLE = new Set([
  'authorization',
  'connection',
  'expect',
  'from',
  'keep-alive',
  'max-forwards',
  'pragma',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'x-amzn-trace-id',
  'cookie',
  'accept-encoding',
  'content-length'
])

const sha256hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest()

/** RFC 3986 encoding (unreserved: A-Z a-z 0-9 - . _ ~). */
export function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

export function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

const isS3 = (service: string): boolean => /^s3(-object-lambda)?$/i.test(service)

/**
 * `pathname` is the path as it goes on the wire (already percent-encoded where the URL needs it).
 * S3: each segment normalised to RFC 3986 encoding once. Other services: the wire path is encoded
 * once more (the "double encoding" of the SigV4 docs, as botocore does it), so a raw `:` becomes `%3A`
 * and an `%20` on the wire becomes `%2520`.
 */
function canonicalPath(pathname: string, s3: boolean): string {
  if (!pathname) return '/'
  return pathname
    .split('/')
    .map((seg) => (s3 ? rfc3986(safeDecode(seg)) : rfc3986(seg)))
    .join('/')
}

function canonicalQuery(search: string): string {
  const raw = search.startsWith('?') ? search.slice(1) : search
  if (!raw) return ''
  const pairs = raw
    .split('&')
    .filter((p) => p !== '')
    .map((p) => {
      const i = p.indexOf('=')
      const k = i < 0 ? p : p.slice(0, i)
      const v = i < 0 ? '' : p.slice(i + 1)
      return [rfc3986(safeDecode(k)), rfc3986(safeDecode(v))] as [string, string]
    })
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  return pairs.map(([k, v]) => `${k}=${v}`).join('&')
}

const findHeader = (h: [string, string][], name: string): string | undefined => h.find(([k]) => k.toLowerCase() === name)?.[1]

export function signingKey(secretKey: string, date8: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac('AWS4' + secretKey, date8), region), service), 'aws4_request')
}

export function signV4(input: SigV4Input): SigV4Result {
  const u = new URL(input.url)
  const s3 = isS3(input.service)
  const headers: [string, string][] = input.headers.map(([k, v]) => [k, v])
  const stamp = (input.mode === 'header' ? findHeader(headers, 'x-amz-date') : undefined) ?? amzDate(input.date)
  const date8 = stamp.slice(0, 8)
  const scope = `${date8}/${input.region}/${input.service}/aws4_request`
  const host = findHeader(headers, 'host') ?? u.host
  const body = input.body ?? ''

  let payloadHash = findHeader(headers, 'x-amz-content-sha256')
  if (!payloadHash) payloadHash = input.mode === 'query' && s3 ? 'UNSIGNED-PAYLOAD' : sha256hex(body)

  let signed: [string, string][]
  if (input.mode === 'header') {
    if (!findHeader(headers, 'x-amz-date')) headers.push(['X-Amz-Date', stamp])
    if (input.sessionToken && !findHeader(headers, 'x-amz-security-token')) headers.push(['X-Amz-Security-Token', input.sessionToken])
    if (s3 && !findHeader(headers, 'x-amz-content-sha256')) headers.push(['X-Amz-Content-Sha256', payloadHash])
    const byName = new Map<string, string[]>()
    if (!findHeader(headers, 'host')) byName.set('host', [host])
    for (const [k, v] of headers) {
      const name = k.toLowerCase().trim()
      if (UNSIGNABLE.has(name)) continue
      byName.set(name, [...(byName.get(name) ?? []), v])
    }
    signed = [...byName.entries()].map(([k, vs]) => [k, vs.map((v) => v.trim().replace(/\s+/g, ' ')).join(',')])
  } else {
    const expires = Math.max(1, Math.min(604800, Math.floor(input.expiresSeconds ?? 3600)))
    const params: [string, string][] = [
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', `${input.accessKey}/${scope}`],
      ['X-Amz-Date', stamp],
      ['X-Amz-Expires', String(expires)],
      ['X-Amz-SignedHeaders', 'host']
    ]
    if (input.sessionToken) params.push(['X-Amz-Security-Token', input.sessionToken])
    const extra = params.map(([k, v]) => `${k}=${rfc3986(v)}`).join('&')
    u.search = u.search && u.search !== '?' ? `${u.search}&${extra}` : `?${extra}`
    signed = [['host', host]]
  }
  signed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const signedHeaders = signed.map(([k]) => k).join(';')
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(u.pathname, s3),
    canonicalQuery(u.search),
    signed.map(([k, v]) => `${k}:${v}\n`).join(''),
    signedHeaders,
    payloadHash
  ].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256hex(canonicalRequest)].join('\n')
  const signature = createHmac('sha256', signingKey(input.secretKey, date8, input.region, input.service)).update(stringToSign, 'utf8').digest('hex')
  if (input.mode === 'query') {
    u.search = `${u.search}&X-Amz-Signature=${signature}`
    return { url: u.toString(), headers, canonicalRequest, stringToSign, signature }
  }
  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  headers.push(['Authorization', authorization])
  return { url: u.toString(), headers, canonicalRequest, stringToSign, signature, authorization }
}
