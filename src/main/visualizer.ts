/**
 * `pm.visualizer.set(template, data)` rendering, done in the main process because the Visualize frame
 * runs no scripts (Postman runs Handlebars inside the frame; Courier cannot). A logic-less subset of
 * Handlebars:
 *
 *   {{path}}  {{{path}}}  {{this}}  {{a.b.c}}  {{a/b}}  {{[odd key]}}  {{../x}}  {{@root.x}}
 *   {{#each list}}…{{@index}} {{@key}} {{@first}} {{@last}}…{{else}}…{{/each}}
 *   {{#if x}}…{{else}}…{{/if}}  {{#unless x}}…{{/unless}}  {{#with x}}…{{/with}}
 *   {{! comment }}  {{!-- comment --}}  whitespace control {{~ … ~}}
 *
 * Deviations from Postman: both `{{x}}` and `{{{x}}}` are HTML-escaped (there is no unescaped output);
 * helpers with arguments and subexpressions are not supported; `<script>` in a template never runs, and
 * the frame cannot load anything from the network (see `wrapDocument`). Lookups only see the data's
 * own properties (no prototype access), and template size, output size, nesting and loop counts are
 * capped.
 */

export const LIMITS = { templateChars: 1_000_000, outputChars: 5_000_000, depth: 64, iterations: 200_000 }

type Node =
  | { kind: 'text'; text: string }
  | { kind: 'var'; path: string }
  | { kind: 'block'; name: 'each' | 'if' | 'unless' | 'with'; path: string; body: Node[]; inverse: Node[] }

interface Tag {
  raw: string
  inner: string
  triple: boolean
  start: number
  end: number
  trimLeft: boolean
  trimRight: boolean
}

function tokenize(src: string): (string | Tag)[] {
  const out: (string | Tag)[] = []
  let i = 0
  while (i < src.length) {
    const open = src.indexOf('{{', i)
    if (open < 0) {
      out.push(src.slice(i))
      break
    }
    if (open > i) out.push(src.slice(i, open))
    // Comments may contain "}}" when written as {{!-- … --}}.
    if (src.startsWith('{{!--', open) || src.startsWith('{{~!--', open)) {
      const close = src.indexOf('--}}', open)
      const closeT = src.indexOf('--~}}', open)
      const end = close < 0 ? (closeT < 0 ? -1 : closeT + 5) : closeT >= 0 && closeT < close ? closeT + 5 : close + 4
      if (end < 0) throw new Error('Unclosed {{!-- comment.')
      i = end
      continue
    }
    const triple = src.startsWith('{{{', open)
    const closeTok = triple ? '}}}' : '}}'
    const close = src.indexOf(closeTok, open + (triple ? 3 : 2))
    if (close < 0) throw new Error(`Unclosed tag at offset ${open}.`)
    let inner = src.slice(open + (triple ? 3 : 2), close)
    let trimLeft = false
    let trimRight = false
    if (inner.startsWith('~')) {
      trimLeft = true
      inner = inner.slice(1)
    }
    if (inner.endsWith('~')) {
      trimRight = true
      inner = inner.slice(0, -1)
    }
    out.push({ raw: src.slice(open, close + closeTok.length), inner: inner.trim(), triple, start: open, end: close + closeTok.length, trimLeft, trimRight })
    i = close + closeTok.length
  }
  // Whitespace control.
  for (let k = 0; k < out.length; k++) {
    const t = out[k]
    if (typeof t === 'string') continue
    if (t.trimLeft && typeof out[k - 1] === 'string') out[k - 1] = (out[k - 1] as string).replace(/\s+$/, '')
    if (t.trimRight && typeof out[k + 1] === 'string') out[k + 1] = (out[k + 1] as string).replace(/^\s+/, '')
  }
  return out
}

const PATH = /^(?:@?[A-Za-z0-9_$-]+|\[[^\]]*\]|\.\.|\.|this)(?:[./](?:[A-Za-z0-9_$-]+|\[[^\]]*\]|\.\.))*$/

function parse(src: string): Node[] {
  if (src.length > LIMITS.templateChars) throw new Error(`Template is larger than ${LIMITS.templateChars} characters.`)
  const tokens = tokenize(src)
  let pos = 0
  const parseList = (depth: number, closing?: string): { nodes: Node[]; inverse: Node[] } => {
    if (depth > LIMITS.depth) throw new Error('Template blocks are nested too deeply.')
    const nodes: Node[] = []
    const inverse: Node[] = []
    let target = nodes
    while (pos < tokens.length) {
      const t = tokens[pos++]
      if (typeof t === 'string') {
        if (t) target.push({ kind: 'text', text: t })
        continue
      }
      const inner = t.inner
      if (inner.startsWith('!')) continue
      if (inner.startsWith('#')) {
        const m = /^#(each|if|unless|with)\s+(\S+)\s*$/.exec(inner)
        if (!m) throw new Error(`Unsupported block ${t.raw} (supported: #each, #if, #unless, #with with one path).`)
        if (!PATH.test(m[2])) throw new Error(`Unsupported expression in ${t.raw}.`)
        const body = parseList(depth + 1, m[1])
        target.push({ kind: 'block', name: m[1] as 'each' | 'if' | 'unless' | 'with', path: m[2], body: body.nodes, inverse: body.inverse })
        continue
      }
      if (inner.startsWith('/')) {
        const name = inner.slice(1).trim()
        if (name !== closing) throw new Error(`Unexpected ${t.raw}${closing ? ` (expected {{/${closing}}})` : ''}.`)
        return { nodes, inverse }
      }
      if (inner === 'else' || inner === '^') {
        if (!closing) throw new Error('{{else}} outside a block.')
        target = inverse
        continue
      }
      if (inner.startsWith('>')) throw new Error(`Partials (${t.raw}) are not supported.`)
      if (!PATH.test(inner)) throw new Error(`Unsupported expression ${t.raw} (helpers and subexpressions are not supported).`)
      target.push({ kind: 'var', path: inner })
    }
    if (closing) throw new Error(`Missing {{/${closing}}}.`)
    return { nodes, inverse }
  }
  return parseList(0).nodes
}

interface Frame {
  value: unknown
  data: Record<string, unknown>
}

const own = (o: unknown, k: string): boolean => {
  if (o === null || o === undefined) return false
  if (typeof o === 'string') return k === 'length'
  if (typeof o !== 'object') return false
  if (Array.isArray(o) && k === 'length') return true
  return Object.prototype.hasOwnProperty.call(o, k)
}

function parsePath(path: string): { up: number; root: boolean; data?: string; segs: string[] } {
  let p = path
  let up = 0
  while (p.startsWith('../')) {
    up++
    p = p.slice(3)
  }
  if (p === '..') {
    up++
    p = ''
  }
  let root = false
  if (p === '@root' || p.startsWith('@root.') || p.startsWith('@root/')) {
    root = true
    p = p.slice(6)
  } else if (p.startsWith('@')) return { up, root, data: p.slice(1), segs: [] }
  if (p === 'this' || p === '.') p = ''
  else if (p.startsWith('this.') || p.startsWith('this/')) p = p.slice(5)
  else if (p.startsWith('./')) p = p.slice(2)
  const segs = [...p.matchAll(/\[([^\]]*)\]|([^./[\]]+)/g)].map((m) => m[1] ?? m[2])
  return { up, root, segs }
}

function lookup(stack: Frame[], path: string): unknown {
  const p = parsePath(path)
  const frame = p.root ? stack[0] : stack[Math.max(0, stack.length - 1 - p.up)]
  if (p.data !== undefined) return Object.prototype.hasOwnProperty.call(frame.data, p.data) ? frame.data[p.data] : undefined
  let v: unknown = frame.value
  for (const k of p.segs) v = own(v, k) ? (v as Record<string, unknown>)[k] : undefined
  return v
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;', '`': '&#x60;', '=': '&#x3D;' }
export const escapeHtml = (s: string): string => s.replace(/[&<>"'`=]/g, (c) => ESC[c])

function toText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map(toText).join(',')
  if (typeof v === 'object') return '[object Object]'
  return String(v)
}

const truthy = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : Boolean(v) && !(typeof v === 'number' && Number.isNaN(v)))

/** Renders the template against `data`. Throws on unsupported syntax or when a limit is hit. */
export function renderTemplate(template: string, data: unknown): string {
  const nodes = parse(template)
  const out: string[] = []
  let size = 0
  let iterations = 0
  const emit = (s: string): void => {
    size += s.length
    if (size > LIMITS.outputChars) throw new Error(`Rendered output is larger than ${LIMITS.outputChars} characters.`)
    out.push(s)
  }
  const walk = (list: Node[], stack: Frame[]): void => {
    for (const n of list) {
      if (n.kind === 'text') emit(n.text)
      else if (n.kind === 'var') emit(escapeHtml(toText(lookup(stack, n.path))))
      else {
        const v = lookup(stack, n.path)
        const frame = stack[stack.length - 1]
        if (n.name === 'if') walk(truthy(v) ? n.body : n.inverse, stack)
        else if (n.name === 'unless') walk(!truthy(v) ? n.body : n.inverse, stack)
        else if (n.name === 'with') walk(truthy(v) ? n.body : n.inverse, truthy(v) ? [...stack, { value: v, data: frame.data }] : stack)
        else {
          const entries: [string | number, unknown][] = Array.isArray(v) ? v.map((x, i) => [i, x]) : v && typeof v === 'object' ? Object.keys(v).map((k) => [k, (v as Record<string, unknown>)[k]]) : []
          if (!entries.length) {
            walk(n.inverse, stack)
            continue
          }
          entries.forEach(([k, x], idx) => {
            if (++iterations > LIMITS.iterations) throw new Error(`More than ${LIMITS.iterations} loop iterations.`)
            const data = { ...frame.data, index: idx, key: k, first: idx === 0, last: idx === entries.length - 1 }
            walk(n.body, [...stack, { value: x, data }])
          })
        }
      }
    }
  }
  walk(nodes, [{ value: data, data: {} }])
  return out.join('')
}

/**
 * The document shown in the Visualize frame. Its own CSP forbids every load except inline styles and
 * data: images/fonts, on top of the app's CSP and the frame's `sandbox` (no scripts, forms, popups or
 * top navigation); main also blocks any navigation of sub-frames.
 */
export const VISUALIZER_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

export function wrapDocument(body: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${VISUALIZER_CSP}">` +
    '<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:13px;margin:12px;color:#1d1d1f;background:#fff}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}</style>' +
    `</head><body>${body}</body></html>`
  )
}

export function renderVisualizer(template: string, data: unknown): { html: string; error?: string } {
  try {
    return { html: wrapDocument(renderTemplate(template, data)) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { html: wrapDocument(`<p style="color:#b00020"><strong>Visualizer template error:</strong> ${escapeHtml(message)}</p>`), error: message }
  }
}
