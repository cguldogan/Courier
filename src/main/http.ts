/**
 * HTTP engine (undici). Manual redirect following, TLS-verification toggle, timeout/cancel,
 * tough-cookie jar, body size cap with truncation flag.
 */
import { Agent, request as undiciRequest, FormData as UndiciFormData, Response as UndiciResponse } from 'undici'
import { openAsBlob } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { Cookie, type CookieJar } from 'tough-cookie'
import type { HttpResponseData, ResponseCookie } from '../shared/types'
import { Fault, errorCodeOf, messageOf } from './errors'

export interface PreparedRequest {
  method: string
  url: string
  headers: [string, string][]
  body?: Buffer | string | null
}

export interface SendOptions {
  followRedirects: boolean
  maxRedirects: number
  verifyTls: boolean
  timeoutMs: number
  maxResponseBytes: number
  cookieJar?: CookieJar
  signal?: AbortSignal
}

const agents = new Map<boolean, Agent>()
function agentFor(verifyTls: boolean): Agent {
  let a = agents.get(verifyTls)
  if (!a) {
    a = new Agent({ connect: { rejectUnauthorized: verifyTls }, allowH2: false })
    agents.set(verifyTls, a)
  }
  return a
}

const BINARY_TYPES = /^(image|audio|video)\/|application\/(pdf|octet-stream|zip|gzip)/i

function headerList(h: Record<string, string | string[] | undefined>): [string, string][] {
  const out: [string, string][] = []
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue
    if (Array.isArray(v)) for (const x of v) out.push([k, x])
    else out.push([k, v])
  }
  return out
}

function toResponseCookie(c: Cookie): ResponseCookie {
  const out: ResponseCookie = { name: c.key, value: c.value }
  if (c.domain) out.domain = c.domain
  if (c.path) out.path = c.path
  if (c.expires && c.expires !== 'Infinity') out.expires = (c.expires as Date).toISOString()
  if (c.httpOnly) out.httpOnly = true
  if (c.secure) out.secure = true
  if (c.sameSite) out.sameSite = c.sameSite
  return out
}

function decodeBody(buf: Buffer, contentType: string): string {
  const m = /charset=([^;]+)/i.exec(contentType)
  const charset = m ? m[1].trim().replace(/"/g, '') : 'utf-8'
  try {
    return new TextDecoder(charset).decode(buf)
  } catch {
    return new TextDecoder('utf-8').decode(buf)
  }
}

function mapError(err: unknown, url: string, timeoutMs: number, userAborted: boolean): Fault {
  if (err instanceof Fault) return err
  const code = errorCodeOf(err)
  const name = (err as { name?: string })?.name
  if (userAborted) return new Fault('CANCELLED', 'Request cancelled.')
  if (name === 'TimeoutError' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT' || code === 'UND_ERR_CONNECT_TIMEOUT')
    return new Fault('TIMEOUT', `Request timed out after ${timeoutMs} ms.`)
  if (name === 'AbortError') return new Fault('CANCELLED', 'Request cancelled.')
  let host = url
  try {
    host = new URL(url).host
  } catch {
    /* keep */
  }
  switch (code) {
    case 'ECONNREFUSED':
      return new Fault('NETWORK', `Connection refused (${host}).`)
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new Fault('NETWORK', `Could not resolve host "${host}".`)
    case 'ECONNRESET':
    case 'UND_ERR_SOCKET':
      return new Fault('NETWORK', `Connection to ${host} was reset.`)
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'CERT_HAS_EXPIRED':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return new Fault('NETWORK', `TLS certificate problem for ${host}: ${messageOf(err)} (disable TLS verification to bypass).`)
    default:
      if (code === 'ERR_INVALID_URL' || /invalid url/i.test(messageOf(err))) return new Fault('INVALID_ARGUMENT', `Invalid URL "${url}".`)
      return new Fault('NETWORK', messageOf(err))
  }
}

export async function sendHttp(req: PreparedRequest, opts: SendOptions): Promise<HttpResponseData> {
  let url: URL
  try {
    url = new URL(req.url)
  } catch {
    throw new Fault('INVALID_ARGUMENT', `Invalid URL "${req.url}".`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Fault('INVALID_ARGUMENT', `Unsupported protocol "${url.protocol}".`)

  const signals: AbortSignal[] = []
  if (opts.signal) signals.push(opts.signal)
  if (opts.timeoutMs > 0) signals.push(AbortSignal.timeout(opts.timeoutMs))
  const signal = signals.length ? AbortSignal.any(signals) : undefined

  const started = performance.now()
  const redirects: { status: number; url: string }[] = []
  let method = req.method.toUpperCase()
  let body = req.body ?? null
  let headers = [...req.headers]

  try {
    for (let hop = 0; ; hop++) {
      const sendHeaders: [string, string][] = headers.map(([k, v]) => [k, v])
      if (opts.cookieJar) {
        const jarCookies = await opts.cookieJar.getCookieString(url.toString())
        if (jarCookies) {
          const existing = sendHeaders.findIndex(([k]) => k.toLowerCase() === 'cookie')
          if (existing >= 0) sendHeaders[existing] = [sendHeaders[existing][0], `${sendHeaders[existing][1]}; ${jarCookies}`]
          else sendHeaders.push(['Cookie', jarCookies])
        }
      }
      const flat: string[] = []
      for (const [k, v] of sendHeaders) flat.push(k, v)

      const res = await undiciRequest(url, {
        method: method as never,
        headers: flat,
        body: method === 'HEAD' ? null : body,
        dispatcher: agentFor(opts.verifyTls),
        signal,
        headersTimeout: opts.timeoutMs > 0 ? opts.timeoutMs : 0,
        bodyTimeout: opts.timeoutMs > 0 ? opts.timeoutMs : 0
      })

      const resHeaders = headerList(res.headers as Record<string, string | string[] | undefined>)
      const setCookies = resHeaders.filter(([k]) => k === 'set-cookie').map(([, v]) => v)
      if (opts.cookieJar) for (const sc of setCookies) await opts.cookieJar.setCookie(sc, url.toString(), { ignoreError: true })

      const location = resHeaders.find(([k]) => k === 'location')?.[1]
      const isRedirect = [301, 302, 303, 307, 308].includes(res.statusCode) && location
      if (isRedirect && opts.followRedirects && hop < opts.maxRedirects) {
        await res.body.dump()
        const next = new URL(location, url)
        redirects.push({ status: res.statusCode, url: next.toString() })
        if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method !== 'GET' && method !== 'HEAD')) {
          method = method === 'HEAD' ? 'HEAD' : 'GET'
          body = null
          headers = headers.filter(([k]) => !['content-type', 'content-length'].includes(k.toLowerCase()))
        }
        if (next.origin !== url.origin) headers = headers.filter(([k]) => !['authorization', 'cookie'].includes(k.toLowerCase()))
        url = next
        continue
      }

      // Body: count wire bytes, transparently decode gzip/deflate/br, keep at most maxResponseBytes.
      let size = 0
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length
          cb(null, chunk)
        }
      })
      const encoding = (resHeaders.find(([k]) => k === 'content-encoding')?.[1] ?? '').trim().toLowerCase()
      const decoder =
        encoding === 'gzip' || encoding === 'x-gzip'
          ? createGunzip()
          : encoding === 'deflate'
            ? createInflate()
            : encoding === 'br'
              ? createBrotliDecompress()
              : null
      const decoded: Readable = decoder ? res.body.pipe(counter).pipe(decoder) : res.body.pipe(counter)
      res.body.on('error', (e) => decoded.destroy(e))
      const chunks: Buffer[] = []
      let kept = 0
      let truncated = false
      try {
        for await (const chunk of decoded) {
          const b = chunk as Buffer
          if (kept < opts.maxResponseBytes) {
            const room = opts.maxResponseBytes - kept
            if (b.length > room) {
              chunks.push(b.subarray(0, room))
              kept += room
              truncated = true
            } else {
              chunks.push(b)
              kept += b.length
            }
          } else truncated = true
        }
      } catch (err) {
        if (signal?.aborted) throw err // timeout / cancel → mapped by mapError below
        // empty/garbled compressed bodies (e.g. HEAD, 204) are not fatal
        if (!(decoder && size === 0)) {
          if (decoder) throw new Fault('NETWORK', `Response body could not be decoded (${encoding}): ${messageOf(err)}`)
          throw err
        }
      }
      const buf = Buffer.concat(chunks)
      const contentType = resHeaders.find(([k]) => k === 'content-type')?.[1] ?? ''
      const cookies: ResponseCookie[] = []
      for (const sc of setCookies) {
        const c = Cookie.parse(sc)
        if (c) cookies.push(toResponseCookie(c))
      }
      const out: HttpResponseData = {
        status: res.statusCode,
        statusText: STATUS_TEXT[res.statusCode] ?? '',
        headers: resHeaders,
        cookies,
        timeMs: Math.round(performance.now() - started),
        sizeBytes: size,
        headersSizeBytes: resHeaders.reduce((n, [k, v]) => n + k.length + v.length + 4, 0),
        contentType,
        bodyText: BINARY_TYPES.test(contentType) && !/svg/i.test(contentType) ? '' : decodeBody(buf, contentType),
        truncated,
        finalUrl: url.toString(),
        redirects
      }
      if (BINARY_TYPES.test(contentType) && !truncated) out.bodyBase64 = buf.toString('base64')
      return out
    }
  } catch (err) {
    throw mapError(err, url.toString(), opts.timeoutMs, opts.signal?.aborted === true)
  }
}

/** multipart/form-data body (files read from disk) → bytes + content-type with boundary. */
export async function buildMultipart(fields: { key: string; value?: string; filePath?: string; contentType?: string }[]): Promise<{ body: Buffer; contentType: string }> {
  const fd = new UndiciFormData()
  for (const f of fields) {
    if (f.filePath !== undefined) {
      let blob: Blob
      try {
        blob = await openAsBlob(f.filePath, f.contentType ? { type: f.contentType } : undefined)
      } catch {
        throw new Fault('INVALID_ARGUMENT', `Cannot read form-data file "${f.filePath}".`)
      }
      fd.append(f.key, blob, basename(f.filePath))
    } else if (f.contentType) {
      fd.append(f.key, new Blob([f.value ?? ''], { type: f.contentType }))
    } else fd.append(f.key, f.value ?? '')
  }
  const r = new UndiciResponse(fd)
  return { body: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') ?? 'multipart/form-data' }
}

export async function readBodyFile(path: string): Promise<Buffer> {
  try {
    return await readFile(path)
  } catch {
    throw new Fault('INVALID_ARGUMENT', `Cannot read body file "${path}".`)
  }
}

export const STATUS_TEXT: Record<number, string> = {
  100: 'Continue', 101: 'Switching Protocols', 200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non-Authoritative Information',
  204: 'No Content', 205: 'Reset Content', 206: 'Partial Content', 207: 'Multi-Status', 300: 'Multiple Choices',
  301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect',
  308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable', 407: 'Proxy Authentication Required',
  408: 'Request Timeout', 409: 'Conflict', 410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed',
  413: 'Payload Too Large', 414: 'URI Too Long', 415: 'Unsupported Media Type', 416: 'Range Not Satisfiable',
  417: 'Expectation Failed', 418: "I'm a teapot", 422: 'Unprocessable Entity', 423: 'Locked', 424: 'Failed Dependency',
  425: 'Too Early', 426: 'Upgrade Required', 428: 'Precondition Required', 429: 'Too Many Requests',
  431: 'Request Header Fields Too Large', 451: 'Unavailable For Legal Reasons', 500: 'Internal Server Error',
  501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported', 507: 'Insufficient Storage', 511: 'Network Authentication Required'
}
