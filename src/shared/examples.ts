/**
 * Saved response examples (pure, shared by main, the command line and the renderer): size limits,
 * which response headers are left out by default, and building an example from a sent request.
 *
 * Secrets: an example is built in main from the executor's *masked* response (Key Vault values and
 * acquired tokens are `••••`) and the request *template* (unresolved `{{…}}`). Response headers that
 * usually carry credentials (`Set-Cookie`, `Authorization`, API keys…) are left out unless the user
 * keeps them one by one, and every example header goes through the pre-upload secret scan.
 */
import type { ExampleRequest, ExampleResponse, HttpResponseData, KeyValue, RawLanguage, RequestBody, RequestDef, ResponseExample } from './types'
import { newId } from './types'

/** Most examples per request (more are dropped when a document is read). */
export const MAX_EXAMPLES_PER_REQUEST = 100
/** Text body limit of an example (characters); longer bodies are cut and marked `truncated`. */
export const EXAMPLE_BODY_MAX_CHARS = 1_000_000
/** Binary body limit (base64 characters, about 1.1 MB of data); larger binary bodies are not kept. */
export const EXAMPLE_BASE64_MAX_CHARS = 1_500_000
/** Most headers per example request / response. */
export const MAX_EXAMPLE_HEADERS = 200
export const MAX_EXAMPLE_NAME = 200

/** Response headers that usually carry credentials or session state: left out of an example unless kept explicitly. */
export const SENSITIVE_RESPONSE_HEADERS =
  /^(set-cookie2?|cookie|authorization|proxy-authorization|proxy-authenticate-info|authentication-info|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-refresh-token|x-amz-security-token|x-csrf-token|x-xsrf-token|ocp-apim-subscription-key|x-functions-key)$/i

export function isSensitiveResponseHeader(name: string): boolean {
  return SENSITIVE_RESPONSE_HEADERS.test(name.trim())
}

/** Headers a replayed example must not repeat: framing and encoding are the mock server's own. */
export const HOP_BY_HOP_HEADERS = /^(content-length|transfer-encoding|content-encoding|connection|keep-alive|upgrade|trailer|te|proxy-connection)$/i

export function languageOf(contentType: string, body: string): RawLanguage {
  const ct = contentType.toLowerCase()
  if (ct.includes('json')) return 'json'
  if (ct.includes('html')) return 'html'
  if (ct.includes('xml')) return 'xml'
  if (ct.includes('javascript')) return 'javascript'
  const t = body.trimStart()
  if (t.startsWith('{') || t.startsWith('[')) return 'json'
  if (t.startsWith('<')) return 'xml'
  return 'text'
}

/** A request body with local file paths removed (they mean nothing on another machine). */
export function bodyWithoutFiles(b: RequestBody): RequestBody {
  if (b.mode === 'binary') return { mode: 'binary', filePath: '' }
  if (b.mode === 'formdata') return { mode: 'formdata', formdata: b.formdata.map((f) => (f.kind === 'file' ? { key: f.key, value: '', enabled: f.enabled, kind: 'file', ...(f.contentType ? { contentType: f.contentType } : {}) } : { ...f })) }
  return structuredClone(b)
}

/** The request part of an example: the template as it was sent (no auth, no scripts, no file paths). */
export function exampleRequestOf(r: RequestDef): ExampleRequest {
  const kv = (list: KeyValue[]): KeyValue[] => list.slice(0, MAX_EXAMPLE_HEADERS).map((x) => ({ key: x.key, value: x.value, enabled: x.enabled, ...(x.description ? { description: x.description } : {}) }))
  return { method: r.method, url: r.url, params: kv(r.params), headers: kv(r.headers), body: bodyWithoutFiles(r.body) }
}

export interface ExampleBuild {
  example: ResponseExample
  /** Response header names that were left out (sensitive and not kept). */
  stripped: string[]
  /** Why the body is incomplete, if it is. */
  truncatedNote?: string
}

/**
 * Builds an example from a sent request's template and its (masked) response. `keepHeaders` lists
 * sensitive response header names (case-insensitive) the user chose to keep.
 */
export function buildExample(template: RequestDef, res: HttpResponseData, opts: { name: string; keepHeaders?: string[] }): ExampleBuild {
  const keep = new Set((opts.keepHeaders ?? []).map((h) => h.trim().toLowerCase()))
  const stripped: string[] = []
  const headers: KeyValue[] = []
  for (const [key, value] of res.headers) {
    if (isSensitiveResponseHeader(key) && !keep.has(key.toLowerCase())) {
      if (!stripped.some((s) => s.toLowerCase() === key.toLowerCase())) stripped.push(key)
      continue
    }
    if (headers.length < MAX_EXAMPLE_HEADERS) headers.push({ key, value, enabled: true })
  }
  let body = res.bodyText
  let bodyBase64: string | undefined
  let truncated = res.truncated
  let truncatedNote: string | undefined = res.truncated ? 'The response body was already truncated for display when it was received.' : undefined
  if (res.bodyBase64 !== undefined) {
    if (res.bodyBase64.length <= EXAMPLE_BASE64_MAX_CHARS) bodyBase64 = res.bodyBase64
    else {
      truncated = true
      truncatedNote = `The binary body (${res.sizeBytes} bytes) is larger than the example limit and was not kept.`
    }
    body = ''
  } else if (body.length > EXAMPLE_BODY_MAX_CHARS) {
    body = body.slice(0, EXAMPLE_BODY_MAX_CHARS)
    truncated = true
    truncatedNote = `The body was cut to ${EXAMPLE_BODY_MAX_CHARS.toLocaleString('en-US')} characters.`
  } else if (!body && res.sizeBytes > 0 && /^(image|audio|video)\/|application\/(pdf|octet-stream|zip|gzip)/i.test(res.contentType)) {
    // A binary body that was too large to be kept as base64 when it was received.
    truncated = true
    truncatedNote = 'The binary body was too large to keep.'
  }
  const response: ExampleResponse = {
    status: res.status,
    statusText: res.statusText,
    headers,
    body,
    ...(bodyBase64 !== undefined ? { bodyBase64 } : {}),
    language: languageOf(res.contentType, res.bodyText),
    ...(truncated ? { truncated: true } : {})
  }
  const name = (opts.name.trim() || `${res.status} ${res.statusText}`.trim()).slice(0, MAX_EXAMPLE_NAME)
  return { example: { id: newId(), name, request: exampleRequestOf(template), response }, stripped, ...(truncatedNote ? { truncatedNote } : {}) }
}
