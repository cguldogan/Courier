/**
 * Auth that needs the fully built request (body, final headers) or a server challenge:
 *  - AWS SigV4 signs the prepared request last (after body and default headers).
 *  - Digest sends, reads the 401 challenge, answers it (and retries once on `stale=true`); a nonce
 *    seen before is reused with an incremented nonce count, so later requests authenticate at once.
 *  - NTLM runs the NEGOTIATE / CHALLENGE / AUTHENTICATE handshake through ONE single-connection
 *    undici Client (never the shared pool), because NTLM authenticates the connection.
 * Every value that could be replayed or cracked offline (Digest/NTLM Authorization values, AWS
 * session token, presigned-URL signature) is registered with the masker.
 */
import type { Auth, HttpResponseData } from '../../shared/types'
import { Fault } from '../errors'
import { sendHttp, singleConnection, type PreparedRequest, type SendOptions } from '../http'
import { digestAuthorization, parseDigestChallenges, type DigestChallenge } from './digest'
import { authenticateMessage, challengeFromHeaders, negotiateMessage, parseChallenge } from './ntlm'
import { signV4 } from './sigv4'

export interface SecretSink {
  add(value: string | undefined | null): void
}

export type DigestCache = Map<string, { challenge: DigestChallenge; nc: number }>

type Aws = Extract<Auth, { type: 'awsv4' }>

const setHeader = (h: [string, string][], name: string, value: string): [string, string][] => [...h.filter(([k]) => k.toLowerCase() !== name.toLowerCase()), [name, value]]
const authenticateValues = (r: HttpResponseData): string[] => r.headers.filter(([k]) => k.toLowerCase() === 'www-authenticate').map(([, v]) => v)

export function signAws(req: PreparedRequest, a: Aws, date: Date, masker: SecretSink): PreparedRequest {
  if (!a.accessKey || !a.secretKey) throw new Fault('INVALID_ARGUMENT', 'AWS Signature: access key and secret key are required.')
  if (!a.service) throw new Fault('INVALID_ARGUMENT', 'AWS Signature: the service name is empty (for example s3, execute-api, sts).')
  const signed = signV4({
    method: req.method,
    url: req.url,
    headers: req.headers,
    body: req.body ?? null,
    accessKey: a.accessKey,
    secretKey: a.secretKey,
    sessionToken: a.sessionToken || undefined,
    region: a.region || 'us-east-1',
    service: a.service,
    date,
    mode: a.addTo
  })
  masker.add(a.sessionToken)
  if (a.addTo === 'query') masker.add(signed.signature)
  return { ...req, url: signed.url, headers: signed.headers }
}

export async function sendWithAuth(
  req: PreparedRequest,
  auth: Auth,
  opts: SendOptions,
  ctx: { masker: SecretSink; digestCache?: DigestCache }
): Promise<{ response: HttpResponseData; sent: PreparedRequest }> {
  if (auth.type === 'digest') return sendDigest(req, auth, opts, ctx)
  if (auth.type === 'ntlm') return sendNtlm(req, auth, opts, ctx.masker)
  return { response: await sendHttp(req, opts), sent: req }
}

async function sendDigest(
  req: PreparedRequest,
  a: Extract<Auth, { type: 'digest' }>,
  opts: SendOptions,
  ctx: { masker: SecretSink; digestCache?: DigestCache }
): Promise<{ response: HttpResponseData; sent: PreparedRequest }> {
  const u = new URL(req.url)
  const uri = `${u.pathname}${u.search}`
  const key = `${u.origin}|${a.username}`
  const withAuth = (challenge: DigestChallenge, nc: number): PreparedRequest => {
    const { header } = digestAuthorization({ challenge, username: a.username, password: a.password, method: req.method, uri, body: req.body ?? null, nc })
    ctx.masker.add(header)
    return { ...req, headers: setHeader(req.headers, 'Authorization', header) }
  }
  const answer = async (res: HttpResponseData, retryStale: boolean): Promise<{ response: HttpResponseData; sent: PreparedRequest } | null> => {
    const ch = parseDigestChallenges(authenticateValues(res))[0]
    if (!ch) return null
    ctx.digestCache?.set(key, { challenge: ch, nc: 1 })
    const sent = withAuth(ch, 1)
    const response = await sendHttp(sent, opts)
    if (response.status === 401 && retryStale) {
      const again = parseDigestChallenges(authenticateValues(response))[0]
      if (again?.stale) return (await answer(response, false)) ?? { response, sent }
    }
    return { response, sent }
  }
  const cached = ctx.digestCache?.get(key)
  let first: { response: HttpResponseData; sent: PreparedRequest }
  if (cached) {
    cached.nc++
    const sent = withAuth(cached.challenge, cached.nc)
    first = { response: await sendHttp(sent, opts), sent }
  } else first = { response: await sendHttp(req, opts), sent: req }
  if (first.response.status !== 401) return first
  ctx.digestCache?.delete(key)
  return (await answer(first.response, true)) ?? first
}

async function sendNtlm(req: PreparedRequest, a: Extract<Auth, { type: 'ntlm' }>, opts: SendOptions, masker: SecretSink): Promise<{ response: HttpResponseData; sent: PreparedRequest }> {
  let { username, domain } = a
  // Accept DOMAIN\user when the domain field is empty.
  if (!domain && username.includes('\\')) [domain, username] = [username.slice(0, username.indexOf('\\')), username.slice(username.indexOf('\\') + 1)]
  const origin = new URL(req.url).origin
  const client = singleConnection(origin, opts.verifyTls)
  try {
    const leg1: PreparedRequest = { ...req, headers: setHeader(req.headers, 'Authorization', `NTLM ${negotiateMessage().toString('base64')}`) }
    const r1 = await sendHttp(leg1, { ...opts, dispatcher: client, followRedirects: false })
    if (r1.status !== 401) return { response: r1, sent: leg1 }
    const token = challengeFromHeaders(authenticateValues(r1))
    if (!token) return { response: r1, sent: leg1 }
    let challenge
    try {
      challenge = parseChallenge(token)
    } catch {
      throw new Fault('AUTH_FAILED', 'NTLM: the server sent a malformed challenge.')
    }
    const type3 = `NTLM ${authenticateMessage({ challenge, user: username, password: a.password, domain, workstation: a.workstation }).toString('base64')}`
    masker.add(type3)
    const leg3: PreparedRequest = { ...req, headers: setHeader(req.headers, 'Authorization', type3) }
    return { response: await sendHttp(leg3, { ...opts, dispatcher: client }), sent: leg3 }
  } finally {
    await client.close().catch(() => undefined)
  }
}
