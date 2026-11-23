/**
 * Pure helpers for WebSocket and gRPC requests, shared by main and the renderer: limits, the bounded
 * message log, binary input decoding, gRPC address parsing and the list of items that HTTP-only
 * features (runner, Postman export, snippets) leave out.
 */
import type { Collection, Folder, Item, RealtimeLogEntry, SkippedItem } from './types'

/** Message log bounds (renderer memory; logs are never written to disk). */
export const LOG_MAX_ENTRIES = 2000
export const LOG_MAX_BYTES = 8 * 1024 * 1024
/** Largest text / binary preview main sends to the renderer for one message. */
export const PREVIEW_MAX_BYTES = 256 * 1024

export const WS_DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024
export const WS_DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000
export const GRPC_DEFAULT_MAX_RECEIVE_BYTES = 4 * 1024 * 1024
/** Cap for a stored gRPC service definition (`GrpcDescriptor.json`). */
export const GRPC_DESCRIPTOR_MAX_CHARS = 4 * 1024 * 1024

export interface BoundedLog {
  entries: RealtimeLogEntry[]
  /** Bytes held (by `entrySize`). */
  bytes: number
  /** Entries dropped from the front since the log was cleared. */
  dropped: number
}

export const EMPTY_LOG: BoundedLog = { entries: [], bytes: 0, dropped: 0 }

/** Memory an entry takes in the log (its previews, not the original message size). */
export function entrySize(e: RealtimeLogEntry): number {
  return (e.text?.length ?? 0) * 2 + (e.base64?.length ?? 0) + 64
}

/** Appends and drops the oldest entries until the log fits both caps. Never mutates `log`. */
export function appendBounded(log: BoundedLog, add: RealtimeLogEntry[], limits = { maxEntries: LOG_MAX_ENTRIES, maxBytes: LOG_MAX_BYTES }): BoundedLog {
  if (!add.length) return log
  const entries = [...log.entries, ...add]
  let bytes = log.bytes + add.reduce((n, e) => n + entrySize(e), 0)
  let drop = 0
  while (entries.length - drop > 1 && (entries.length - drop > limits.maxEntries || bytes > limits.maxBytes)) {
    bytes -= entrySize(entries[drop])
    drop++
  }
  return { entries: drop ? entries.slice(drop) : entries, bytes, dropped: log.dropped + drop }
}

/** Binary composer input → bytes. Whitespace is ignored; throws an Error with a user-facing message. */
export function decodeBinaryInput(text: string, format: 'base64' | 'hex'): Uint8Array {
  const s = text.replace(/\s+/g, '')
  if (format === 'hex') {
    const h = s.replace(/^0x/i, '')
    if (h.length % 2 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error('Hex input must be pairs of 0-9 / a-f digits (spaces allowed).')
    const out = new Uint8Array(h.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
    return out
  }
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(s) || s.length % 4 === 1) throw new Error('Base64 input is not valid.')
  const std = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** `de ad be ef` preview of base64 data (first `max` bytes). */
export function hexPreview(base64: string, max = 64): string {
  let bin = ''
  try {
    bin = atob(base64)
  } catch {
    return ''
  }
  const parts: string[] = []
  for (let i = 0; i < Math.min(bin.length, max); i++) parts.push(bin.charCodeAt(i).toString(16).padStart(2, '0'))
  return parts.join(' ') + (bin.length > max ? ' …' : '')
}

export interface GrpcTarget {
  /** `host:port` for grpc-js. */
  target: string
  host: string
  port: number
  tls: boolean
}

/**
 * `host:port`, `grpc://host:port` (plaintext) or `grpcs://host:port` (TLS). A scheme overrides the
 * TLS toggle; without a port, 443 (TLS) or 80 is used. Throws an Error with a user-facing message.
 */
export function parseGrpcAddress(address: string, tlsToggle: boolean): GrpcTarget {
  let s = address.trim()
  if (!s) throw new Error('Enter the server address, e.g. localhost:50051.')
  let tls = tlsToggle
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s)
  if (scheme) {
    const p = scheme[1].toLowerCase()
    if (p === 'grpcs' || p === 'https') tls = true
    else if (p === 'grpc' || p === 'http') tls = false
    else throw new Error(`Unsupported scheme "${scheme[1]}://" — use host:port, grpc:// or grpcs://.`)
    s = s.slice(scheme[0].length)
  }
  s = s.replace(/\/+$/, '')
  if (s.includes('/') || s.includes('@') || /\s/.test(s)) throw new Error(`"${address}" is not a server address (expected host:port).`)
  let host = s
  let port = tls ? 443 : 80
  const v6 = /^\[([0-9a-fA-F:.]+)\](?::(\d+))?$/.exec(s)
  if (v6) {
    host = `[${v6[1]}]`
    if (v6[2]) port = Number(v6[2])
  } else {
    const m = /^([^:]+)(?::(\d+))?$/.exec(s)
    if (!m) throw new Error(`"${address}" is not a server address (expected host:port).`)
    host = m[1]
    if (m[2]) port = Number(m[2])
  }
  if (!host || !(port > 0 && port < 65536)) throw new Error(`"${address}" has an invalid port.`)
  return { target: `${host}:${port}`, host: host.replace(/^\[|\]$/g, ''), port, tls }
}

/** WebSocket and gRPC requests under `items` (tree order), with their folder path. */
export function nonHttpItems(items: Item[], parents: Folder[] = []): SkippedItem[] {
  const out: SkippedItem[] = []
  for (const it of items) {
    if (it.type === 'folder') out.push(...nonHttpItems(it.items, [...parents, it]))
    else if (it.type !== 'request') out.push({ id: it.id, name: it.name, type: it.type, path: parents.map((p) => p.name).join(' / ') })
  }
  return out
}

/** One sentence naming the skipped items, e.g. for the runner and the command line. */
export function skippedNote(skipped: SkippedItem[], what: string): string {
  if (!skipped.length) return ''
  const names = skipped.slice(0, 5).map((s) => `"${s.path ? `${s.path} / ` : ''}${s.name}" (${s.type === 'websocket' ? 'WebSocket' : 'gRPC'})`)
  const more = skipped.length > 5 ? ` and ${skipped.length - 5} more` : ''
  return `${skipped.length} WebSocket/gRPC request${skipped.length === 1 ? '' : 's'} ${skipped.length === 1 ? 'is' : 'are'} not ${what}: ${names.join(', ')}${more}.`
}

export function collectionNonHttp(c: Collection): SkippedItem[] {
  return nonHttpItems(c.items)
}
