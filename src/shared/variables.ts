/**
 * Variable resolution (pure). Precedence, narrowest wins: local > data > environment > collection > global.
 * `{{name}}` is replaced recursively (values may reference other variables, max depth 10);
 * unknown names are left untouched; `{{$dynamic}}` variables are generated per occurrence;
 * `{{vault:…}}` references are *left in place* — they are resolved in the main process at send time.
 */
import type { KeyValue, Variable } from './types'

export const MASK = '••••'

export interface VariableLayers {
  global: Record<string, string>
  collection: Record<string, string>
  environment: Record<string, string>
  data: Record<string, string>
  local: Record<string, string>
}

export function emptyLayers(): VariableLayers {
  return { global: {}, collection: {}, environment: {}, data: {}, local: {} }
}

const PRECEDENCE: (keyof VariableLayers)[] = ['local', 'data', 'environment', 'collection', 'global']

export function lookupVariable(name: string, layers: VariableLayers): string | undefined {
  for (const layer of PRECEDENCE) {
    const v = layers[layer]
    if (Object.prototype.hasOwnProperty.call(v, name)) return v[name]
  }
  return undefined
}

/**
 * Effective values of a variable list: enabled variables only, current value (if any) overrides the
 * shared value; `vault`-typed variables become a `{{vault:ref}}` template.
 */
export function effectiveValues(vars: Variable[], current: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {}
  const declared = new Set<string>()
  for (const v of vars) {
    if (!v.key) continue
    declared.add(v.key)
    if (!v.enabled) continue
    const raw = Object.prototype.hasOwnProperty.call(current, v.key) ? current[v.key] : v.value
    out[v.key] = v.type === 'vault' ? toVaultTemplate(raw) : raw
  }
  // Keys only present as current values (e.g. created by `pm.environment.set`) are local-only variables.
  for (const [k, val] of Object.entries(current)) if (!declared.has(k)) out[k] = val
  return out
}

// ---------------------------------------------------------------------------------------------
// Key Vault references
// ---------------------------------------------------------------------------------------------

export interface VaultRef {
  alias?: string
  name: string
  version?: string
}

const SECRET_NAME = /^[0-9A-Za-z-]{1,127}$/
const ALIAS = /^[A-Za-z0-9_.-]{1,64}$/
const VERSION = /^[0-9A-Za-z]{1,64}$/

/** Parses `name`, `alias/name`, `name@version`, `alias/name@version` (optionally prefixed `vault:` or wrapped in `{{…}}`). */
export function parseVaultRef(input: string): VaultRef | null {
  let s = input.trim()
  const wrapped = /^\{\{\s*(.*?)\s*\}\}$/.exec(s)
  if (wrapped) s = wrapped[1]
  if (s.startsWith('vault:')) s = s.slice(6)
  let version: string | undefined
  const at = s.lastIndexOf('@')
  if (at >= 0) {
    version = s.slice(at + 1)
    s = s.slice(0, at)
    if (!VERSION.test(version)) return null
  }
  let alias: string | undefined
  const slash = s.indexOf('/')
  if (slash >= 0) {
    alias = s.slice(0, slash)
    s = s.slice(slash + 1)
    if (!ALIAS.test(alias)) return null
  }
  if (!SECRET_NAME.test(s)) return null
  return { ...(alias ? { alias } : {}), name: s, ...(version ? { version } : {}) }
}

export function formatVaultRef(ref: VaultRef): string {
  return `${ref.alias ? ref.alias + '/' : ''}${ref.name}${ref.version ? '@' + ref.version : ''}`
}

export function toVaultTemplate(value: string): string {
  const ref = parseVaultRef(value)
  return ref ? `{{vault:${formatVaultRef(ref)}}}` : value
}

const VAULT_TEMPLATE = /\{\{\s*vault:([^{}\s]+)\s*\}\}/g

export function findVaultRefs(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(VAULT_TEMPLATE)) out.push(m[1])
  return out
}

export function replaceVaultRefs(text: string, fn: (ref: string) => string): string {
  return text.replace(VAULT_TEMPLATE, (_m, ref: string) => fn(ref))
}

// ---------------------------------------------------------------------------------------------
// Dynamic variables
// ---------------------------------------------------------------------------------------------

const FIRST = ['Ada', 'Alan', 'Grace', 'Linus', 'Margaret', 'Ken', 'Barbara', 'Dennis', 'Radia', 'Tim']
const LAST = ['Lovelace', 'Turing', 'Hopper', 'Torvalds', 'Hamilton', 'Thompson', 'Liskov', 'Ritchie', 'Perlman', 'Berners-Lee']
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima']
const CITIES = ['Amsterdam', 'Berlin', 'Dublin', 'Lisbon', 'Oslo', 'Seattle', 'Tokyo', 'Toronto']
const COUNTRIES = ['Netherlands', 'Germany', 'Ireland', 'Portugal', 'Norway', 'United States', 'Japan', 'Canada']
const COLORS = ['red', 'green', 'blue', 'orange', 'purple', 'teal', 'yellow', 'black']

function rnd(n: number): number {
  return Math.floor(Math.random() * n)
}
function pick<T>(a: T[]): T {
  return a[rnd(a.length)]
}
function alnum(n: number): string {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < n; i++) s += c[rnd(c.length)]
  return s
}

export const DYNAMIC_VARIABLES: Record<string, () => string> = {
  $guid: () => globalThis.crypto.randomUUID(),
  $randomUUID: () => globalThis.crypto.randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(rnd(1001)),
  $randomBoolean: () => String(Math.random() < 0.5),
  $randomAlphaNumeric: () => alnum(1),
  $randomFirstName: () => pick(FIRST),
  $randomLastName: () => pick(LAST),
  $randomFullName: () => `${pick(FIRST)} ${pick(LAST)}`,
  $randomUserName: () => `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase()}${rnd(100)}`,
  $randomEmail: () => `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase()}${rnd(1000)}@example.com`,
  $randomWord: () => pick(WORDS),
  $randomLoremWord: () => pick(WORDS),
  $randomCity: () => pick(CITIES),
  $randomCountry: () => pick(COUNTRIES),
  $randomColor: () => pick(COLORS),
  $randomIP: () => `${1 + rnd(254)}.${rnd(256)}.${rnd(256)}.${1 + rnd(254)}`,
  $randomPhoneNumber: () => `${100 + rnd(900)}-${100 + rnd(900)}-${1000 + rnd(9000)}`,
  $randomPrice: () => (rnd(100000) / 100).toFixed(2)
}

// ---------------------------------------------------------------------------------------------
// Substitution
// ---------------------------------------------------------------------------------------------

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g
const MAX_DEPTH = 10

/** Resolve `{{…}}` in a string. Unknown names stay as `{{name}}`; vault refs stay for main to resolve. */
export function resolveTemplate(input: string, layers: VariableLayers): string {
  if (!input || input.indexOf('{{') < 0) return input
  let current = input
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    let changed = false
    const next = current.replace(TEMPLATE, (match, rawName: string) => {
      const name = rawName.trim()
      if (name.startsWith('vault:')) return match
      const value = lookupVariable(name, layers)
      if (value !== undefined) {
        if (value !== match) changed = true
        return value
      }
      const dyn = DYNAMIC_VARIABLES[name]
      if (dyn) {
        changed = true
        return dyn()
      }
      return match
    })
    current = next
    if (!changed || current.indexOf('{{') < 0) break
  }
  return current
}

/** Variable names referenced in a string (excluding dynamic and vault refs), for UI highlighting. */
export function referencedVariables(input: string): string[] {
  const out = new Set<string>()
  for (const m of input.matchAll(TEMPLATE)) {
    const n = m[1].trim()
    if (!n.startsWith('$') && !n.startsWith('vault:')) out.add(n)
  }
  return [...out]
}

export function isPureTemplate(value: string): boolean {
  return /^\s*\{\{[^{}]+\}\}\s*$/.test(value)
}

// ---------------------------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------------------------

/** Split `https://x/y?a=1&b` into the base URL and params (all enabled). Keeps `{{…}}` intact. */
export function splitQuery(url: string): { base: string; params: KeyValue[] } {
  const hashIdx = url.indexOf('#')
  const noHash = hashIdx >= 0 ? url.slice(0, hashIdx) : url
  const q = noHash.indexOf('?')
  if (q < 0) return { base: url, params: [] }
  const base = noHash.slice(0, q) + (hashIdx >= 0 ? url.slice(hashIdx) : '')
  const params: KeyValue[] = []
  for (const part of noHash.slice(q + 1).split('&')) {
    if (part === '') continue
    const eq = part.indexOf('=')
    const key = eq >= 0 ? part.slice(0, eq) : part
    const value = eq >= 0 ? part.slice(eq + 1) : ''
    params.push({ key: safeDecode(key), value: safeDecode(value), enabled: true })
  }
  return { base, params }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, '%20'))
  } catch {
    return s
  }
}

/** Percent-encode what would break a query component, keep existing %XX escapes and common readable characters. */
export function encodeQueryComponent(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    // keep unresolved `{{…}}` templates intact so they can still be resolved later
    if (ch === '{' && s[i + 1] === '{') {
      const end = s.indexOf('}}', i + 2)
      if (end > 0 && !s.slice(i + 2, end).includes('{')) {
        out += s.slice(i, end + 2)
        i = end + 1
        continue
      }
    }
    if (ch === '%' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out += ch
      continue
    }
    if (/[A-Za-z0-9\-._~!$'()*,;:@/?]/.test(ch)) out += ch
    else out += encodeURIComponent(ch)
  }
  return out
}

/** Fill `:name` path segments from path variables (values already resolved). */
export function applyPathVariables(url: string, pathVariables: KeyValue[]): string {
  if (!pathVariables.length) return url
  const values = new Map(pathVariables.filter((p) => p.enabled !== false && p.key).map((p) => [p.key, p.value]))
  const schemeEnd = url.indexOf('://')
  const pathStart = url.indexOf('/', schemeEnd >= 0 ? schemeEnd + 3 : 0)
  if (pathStart < 0) return url
  const qIdx = url.search(/[?#]/)
  const pathEnd = qIdx >= 0 && qIdx > pathStart ? qIdx : url.length
  const path = url.slice(pathStart, pathEnd).replace(/\/:([A-Za-z0-9_-]+)/g, (m, name: string) =>
    values.has(name) ? '/' + encodeURIComponent(values.get(name) as string) : m
  )
  return url.slice(0, pathStart) + path + url.slice(pathEnd)
}

/** URL + enabled params (+ path variables). */
export function buildUrl(url: string, params: KeyValue[], pathVariables: KeyValue[] = []): string {
  let out = applyPathVariables(url, pathVariables)
  const enabled = params.filter((p) => p.enabled && p.key !== '')
  if (enabled.length) {
    const hashIdx = out.indexOf('#')
    const hash = hashIdx >= 0 ? out.slice(hashIdx) : ''
    const main = hashIdx >= 0 ? out.slice(0, hashIdx) : out
    const qs = enabled
      .map((p) => encodeQueryComponent(p.key) + (p.value === '' ? '' : '=' + encodeQueryComponent(p.value)))
      .join('&')
    out = main + (main.includes('?') ? (main.endsWith('?') || main.endsWith('&') ? '' : '&') : '?') + qs + hash
  }
  return out
}

/** Prefix `http://` when the user typed a bare host. */
export function normalizeUrl(url: string): string {
  const t = url.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t
  return 'http://' + t
}
