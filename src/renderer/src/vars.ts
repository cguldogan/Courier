/** Renderer-side variable preview (display only — sends are always resolved by main). */
import type { Id, WorkspaceSnapshot } from '../../shared/types'
import { effectiveValues, emptyLayers, lookupVariable, type VariableLayers } from '../../shared/variables'

export function layersFor(snap: WorkspaceSnapshot | null, collectionId: Id | null | undefined): VariableLayers {
  const l = emptyLayers()
  if (!snap) return l
  l.global = effectiveValues(snap.globals)
  const col = collectionId ? snap.collections.find((c) => c.collection.id === collectionId)?.collection : undefined
  if (col) l.collection = effectiveValues(col.variables, snap.currentValues.collections[col.id])
  const env = snap.activeEnvironmentId ? snap.environments.find((e) => e.environment.id === snap.activeEnvironmentId)?.environment : undefined
  if (env) l.environment = effectiveValues(env.variables, snap.currentValues.environments[env.id])
  return l
}

export type TokenKind = 'text' | 'var' | 'missing' | 'vault' | 'dynamic'
export interface Token {
  kind: TokenKind
  text: string
  name?: string
  value?: string
  source?: string
}

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g

function sourceOf(name: string, l: VariableLayers): string | undefined {
  for (const k of ['local', 'data', 'environment', 'collection', 'global'] as const) if (Object.prototype.hasOwnProperty.call(l[k], name)) return k
  return undefined
}

/** Split text into plain runs and `{{…}}` tokens annotated with their resolution. */
export function tokenize(text: string, l: VariableLayers): Token[] {
  const out: Token[] = []
  let last = 0
  for (const m of text.matchAll(TEMPLATE)) {
    const i = m.index ?? 0
    if (i > last) out.push({ kind: 'text', text: text.slice(last, i) })
    const name = m[1].trim()
    if (name.startsWith('vault:')) out.push({ kind: 'vault', text: m[0], name: name.slice(6) })
    else if (name.startsWith('$')) out.push({ kind: 'dynamic', text: m[0], name })
    else {
      const value = lookupVariable(name, l)
      if (value === undefined) out.push({ kind: 'missing', text: m[0], name })
      else out.push({ kind: value.includes('{{vault:') ? 'vault' : 'var', text: m[0], name, value, source: sourceOf(name, l) })
    }
    last = i + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

export function describeToken(t: Token): string {
  switch (t.kind) {
    case 'missing':
      return `{{${t.name}}} is not defined in the active environment, collection or globals`
    case 'vault':
      return t.value ? `${t.name} → ${t.value} (Key Vault, resolved at send time)` : `Key Vault secret ${t.name} (resolved at send time, never stored)`
    case 'dynamic':
      return `${t.name}: generated at send time`
    case 'var':
      return `${t.name} = ${t.value === '' ? '(empty)' : t.value}${t.source ? `  · ${t.source}` : ''}`
    default:
      return ''
  }
}
