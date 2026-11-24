/**
 * Mock server matching (pure; shared by the app and `courier mock`).
 *
 * An incoming request is matched against every saved example of the collection's HTTP requests:
 *
 *  1. Method and path. The example's path is its request URL without the base: a leading
 *     `scheme://host`, or a leading `{{variable}}` (the base URL, e.g. `{{baseUrl}}/users/:id` →
 *     `/users/:id`), or a bare `host` before the first `/`. Segments are compared one by one after
 *     percent-decoding; a segment that is `:name` or `{{name}}` matches any one segment, and a segment
 *     with an embedded `{{name}}` (`v{{version}}`) matches any text in that place. Empty segments are
 *     ignored, so trailing and doubled slashes do not matter. Methods compare case-insensitively; a
 *     HEAD request with no HEAD example falls back to the GET examples (sent without a body).
 *  2. Narrowing by headers, in this order, each only among the step-1 matches:
 *     `x-mock-response-id` (example id), `x-mock-response-name` (example name, case-insensitive),
 *     `x-mock-response-code` (response status). A header that matches none of them is a 404 that
 *     says so (it never picks an example on another path, unlike Postman's cloud mocks).
 *  3. Query parameters: the examples whose enabled query parameters agree with the most of the
 *     request's (same key and value; a `{{variable}}` value accepts any value) win; ties go to the
 *     one with fewer parameters the request lacks.
 *  4. Most specific: more literal path segments win (`/users/me` before `/users/:id`), then the
 *     first in collection order.
 *
 * No match → 404 with a JSON body listing what was tried and the closest examples.
 */
import type { Collection, Folder, RequestDef, ResponseExample } from '../../shared/types'
import { walkItems } from '../../shared/types'

type Segment = { kind: 'literal'; value: string } | { kind: 'any' } | { kind: 'pattern'; re: RegExp; source: string }

export interface MockCandidate {
  example: ResponseExample
  request: RequestDef
  /** Folder path (`A / B`), empty at the root. */
  folder: string
  method: string
  path: string
  segments: Segment[]
  query: { key: string; value: string }[]
  /** Position in collection order. */
  index: number
}

export interface MockRequestInfo {
  method: string
  /** Raw request target path (no query). */
  path: string
  query: [string, string][]
  /** Lower-case header names. */
  headers: Record<string, string | string[] | undefined>
}

export interface ClosestCandidate {
  id: string
  name: string
  request: string
  method: string
  path: string
  reason: string
}

export interface MockNotFound {
  error: 'mockRequestNotFoundError'
  message: string
  request: { method: string; path: string; query: Record<string, string> }
  tried: string[]
  closest: ClosestCandidate[]
}

export type MatchResult = { matched: true; candidate: MockCandidate; headOnly: boolean; steps: string[] } | { matched: false; notFound: MockNotFound }

const WHOLE_VAR = /^(?::[A-Za-z0-9_.-]+|\{\{[^{}]+\}\})$/
const EMBEDDED_VAR = /\{\{[^{}]+\}\}/g

function decode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** The path part of an example's URL template (see the module comment). */
export function examplePath(url: string): string {
  let s = url.trim().split(/[?#]/, 1)[0]
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(s)
  if (scheme) s = s.slice(scheme[0].length)
  else if (s.startsWith('{{')) {
    const end = s.indexOf('}}')
    s = end >= 0 ? s.slice(end + 2) : s
    if (s && !s.startsWith('/')) {
      const slash = s.indexOf('/')
      s = slash >= 0 ? s.slice(slash) : ''
    }
  } else if (!s.startsWith('/')) {
    const slash = s.indexOf('/')
    s = slash >= 0 ? s.slice(slash) : ''
  }
  return s.startsWith('/') ? s : `/${s}`
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function compilePath(path: string): Segment[] {
  return path
    .split('/')
    .filter((x) => x !== '')
    .map((raw): Segment => {
      if (WHOLE_VAR.test(raw)) return { kind: 'any' }
      if (/\{\{[^{}]+\}\}/.test(raw)) {
        const parts = raw.split(EMBEDDED_VAR).map((p) => escapeRe(decode(p)))
        return { kind: 'pattern', re: new RegExp(`^${parts.join('.+?')}$`), source: raw }
      }
      return { kind: 'literal', value: decode(raw) }
    })
}

export function requestSegments(path: string): string[] {
  return path
    .split('?', 1)[0]
    .split('/')
    .filter((x) => x !== '')
    .map(decode)
}

function segmentMatches(seg: Segment, value: string): boolean {
  if (seg.kind === 'any') return true
  if (seg.kind === 'pattern') return seg.re.test(value)
  return seg.value === value
}

export function pathMatches(segments: Segment[], actual: string[]): boolean {
  return segments.length === actual.length && segments.every((s, i) => segmentMatches(s, actual[i]))
}

function specificity(c: MockCandidate): number {
  return c.segments.reduce((n, s) => n + (s.kind === 'literal' ? 2 : s.kind === 'pattern' ? 1 : 0), 0)
}

/** Every example of the collection's HTTP requests, in collection order. */
export function mockCandidates(collection: Collection): MockCandidate[] {
  const out: MockCandidate[] = []
  for (const { item, parents } of walkItems(collection.items)) {
    if (item.type !== 'request' || !item.examples?.length) continue
    for (const example of item.examples) {
      const path = examplePath(example.request.url || item.url)
      out.push({
        example,
        request: item,
        folder: parents.map((f: Folder) => f.name).join(' / '),
        method: (example.request.method || item.method || 'GET').toUpperCase(),
        path,
        segments: compilePath(path),
        query: example.request.params.filter((p) => p.enabled && p.key).map((p) => ({ key: p.key, value: p.value })),
        index: out.length
      })
    }
  }
  return out
}

function header(h: MockRequestInfo['headers'], name: string): string | undefined {
  const v = h[name]
  if (Array.isArray(v)) return v[0]
  return typeof v === 'string' ? v : undefined
}

function queryScore(c: MockCandidate, query: [string, string][]): { hits: number; missing: number } {
  let hits = 0
  let missing = 0
  for (const p of c.query) {
    const values = query.filter(([k]) => k === p.key).map(([, v]) => v)
    const isVar = /^\{\{[^{}]+\}\}$/.test(p.value.trim())
    if (values.length && (isVar || values.includes(p.value))) hits++
    else missing++
  }
  return { hits, missing }
}

function describeCandidate(c: MockCandidate, reason: string): ClosestCandidate {
  return { id: c.example.id, name: c.example.name, request: c.folder ? `${c.folder} / ${c.request.name}` : c.request.name, method: c.method, path: c.path, reason }
}

function closest(all: MockCandidate[], method: string, actual: string[]): ClosestCandidate[] {
  const scored = all.map((c) => {
    let same = 0
    let firstDiff = -1
    for (let i = 0; i < Math.max(c.segments.length, actual.length); i++) {
      const s = c.segments[i]
      if (s && i < actual.length && segmentMatches(s, actual[i])) same++
      else if (firstDiff < 0) firstDiff = i
    }
    const methodOk = c.method === method || (method === 'HEAD' && c.method === 'GET')
    const pathOk = pathMatches(c.segments, actual)
    const score = (methodOk ? 3 : 0) + same * 2 - Math.abs(c.segments.length - actual.length)
    let reason: string
    if (pathOk && !methodOk) reason = `same path, but the example is ${c.method}`
    else if (c.segments.length !== actual.length) reason = `the example path has ${c.segments.length} segment(s), the request has ${actual.length}`
    else {
      const s = c.segments[firstDiff]
      const want = s?.kind === 'literal' ? `"${s.value}"` : s?.kind === 'pattern' ? `"${s.source}"` : 'any'
      reason = `path differs at segment ${firstDiff + 1}: expected ${want}, got "${actual[firstDiff] ?? ''}"${methodOk ? '' : ` (and the example is ${c.method})`}`
    }
    return { c, score, reason }
  })
  return scored
    .sort((a, b) => b.score - a.score || a.c.index - b.c.index)
    .slice(0, 5)
    .map((x) => describeCandidate(x.c, x.reason))
}

/** Runs the matching rules (module comment) over `candidates`. */
export function matchRequest(candidates: MockCandidate[], req: MockRequestInfo): MatchResult {
  const method = req.method.toUpperCase()
  const actual = requestSegments(req.path)
  const tried: string[] = [`method + path: ${method} /${actual.join('/')} against ${candidates.length} example(s)`]
  const query = Object.fromEntries(req.query)
  const notFound = (message: string, pool: MockCandidate[]): MatchResult => ({
    matched: false,
    notFound: { error: 'mockRequestNotFoundError', message, request: { method, path: `/${actual.join('/')}`, query }, tried, closest: pool.length ? closest(pool, method, actual) : [] }
  })
  if (!candidates.length) return notFound('This collection has no saved examples. Save a response as an example first.', [])
  let pool = candidates.filter((c) => c.method === method && pathMatches(c.segments, actual))
  let headOnly = false
  if (!pool.length && method === 'HEAD') {
    pool = candidates.filter((c) => c.method === 'GET' && pathMatches(c.segments, actual))
    if (pool.length) {
      headOnly = true
      tried.push('HEAD → the GET examples (no body)')
    }
  }
  if (!pool.length) return notFound(`No example matches ${method} /${actual.join('/')}.`, candidates)
  const steps: string[] = []
  const byHeader = (name: string, test: (c: MockCandidate, v: string) => boolean, what: string): MatchResult | null => {
    const v = header(req.headers, name)?.trim()
    if (!v) return null
    const next = pool.filter((c) => test(c, v))
    tried.push(`${name}: ${v}`)
    if (!next.length) return notFound(`No example ${what} "${v}" among the ${pool.length} example(s) matching ${method} /${actual.join('/')} (${name}).`, pool)
    pool = next
    steps.push(`${name}`)
    return null
  }
  const r =
    byHeader('x-mock-response-id', (c, v) => c.example.id === v, 'with id') ??
    byHeader('x-mock-response-name', (c, v) => c.example.name.toLowerCase() === v.toLowerCase(), 'named') ??
    byHeader('x-mock-response-code', (c, v) => String(c.example.response.status) === v, 'with status')
  if (r) return r
  if (pool.length > 1 && pool.some((c) => c.query.length)) {
    const scored = pool.map((c) => ({ c, ...queryScore(c, req.query) }))
    const best = Math.max(...scored.map((s) => s.hits))
    let top = scored.filter((s) => s.hits === best)
    const least = Math.min(...top.map((s) => s.missing))
    top = top.filter((s) => s.missing === least)
    if (top.length < pool.length) steps.push('query parameters')
    pool = top.map((s) => s.c)
  }
  if (pool.length > 1) {
    const most = Math.max(...pool.map(specificity))
    const top = pool.filter((c) => specificity(c) === most)
    if (top.length < pool.length) steps.push('most specific path')
    pool = top
  }
  const candidate = [...pool].sort((a, b) => a.index - b.index)[0]
  if (pool.length > 1) steps.push('first in collection order')
  return { matched: true, candidate, headOnly, steps }
}
