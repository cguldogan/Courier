/**
 * WebSocket and gRPC actions in the renderer. All network I/O happens in main; this module only calls
 * `window.courier.websocket/grpc` and folds the `ws:event` / `grpc:event` stream into `AppState.live`
 * (memory only, bounded by `appendBounded`). A tab's connection or call is closed when the tab goes away.
 */
import { appendBounded, EMPTY_LOG } from '../../shared/realtime'
import { newId, type GrpcEvent, type GrpcRequestDef, type RealtimeLogEntry, type WebSocketRequestDef, type WsEvent, type WsMessage } from '../../shared/types'
import { attempt, courier } from './api'
import { type GrpcLive, type Live, type RequestTab, type WsLive, locate, useApp } from './store'

const st = useApp.getState

function tabOf(tabId: string): RequestTab | undefined {
  const t = st().tabs.find((x) => x.id === tabId)
  return t?.kind === 'request' ? t : undefined
}

function target<D>(t: RequestTab): { collectionId: string | null; requestId: string | null; draft: D } {
  const savedHere = t.collectionId && t.requestId && locate(t.collectionId, t.requestId)
  return { collectionId: t.collectionId ?? null, requestId: savedHere ? t.requestId : null, draft: t.draft as D }
}

function setLive(tabId: string, fn: (l: Live | undefined) => Live | undefined): void {
  useApp.setState((s) => {
    const next = fn(s.live[tabId])
    const live = { ...s.live }
    if (next) live[tabId] = next
    else delete live[tabId]
    return { live }
  })
}

// ---------------------------------------------------------------------------------------------
// Event stream (batched per animation frame)
// ---------------------------------------------------------------------------------------------

let queue: (WsEvent | GrpcEvent)[] = []
/** Renderer-wide log entry number: a tab's log outlives one connection (reconnects restart main's `seq`). */
let logSeq = 0
let scheduled = false

function flush(): void {
  scheduled = false
  const events = queue
  queue = []
  if (!events.length) return
  useApp.setState((s) => {
    const live = { ...s.live }
    const tabFor = new Map<string, string>()
    for (const [tabId, l] of Object.entries(live)) tabFor.set(l.kind === 'websocket' ? l.connectionId : l.callId, tabId)
    const pending = new Map<string, RealtimeLogEntry[]>()
    const push = (tabId: string, e: RealtimeLogEntry): void => {
      const list = pending.get(tabId) ?? []
      list.push(e)
      pending.set(tabId, list)
    }
    for (const e of events) {
      const id = 'connectionId' in e ? e.connectionId : e.callId
      const tabId = tabFor.get(id)
      if (!tabId) continue
      const cur = live[tabId]
      if ('connectionId' in e && cur?.kind === 'websocket') {
        if (e.type === 'message') push(tabId, { ...e.entry, seq: ++logSeq })
        else
          live[tabId] = {
            ...cur,
            status: e.status,
            code: e.code,
            reason: e.reason,
            error: e.error,
            attempt: e.attempt,
            ...(e.handshake ? { handshake: e.handshake } : {})
          }
      } else if ('callId' in e && cur?.kind === 'grpc') {
        if (e.type === 'message') push(tabId, { ...e.entry, seq: ++logSeq })
        else if (e.type === 'started') live[tabId] = { ...cur, running: true, callType: e.callType, path: e.path, target: e.target, tls: e.tls, requestMetadata: e.requestMetadata }
        else if (e.type === 'headers') live[tabId] = { ...cur, headers: e.metadata }
        else live[tabId] = { ...cur, running: false, status: e.status, trailers: e.trailers, durationMs: e.durationMs, hint: e.hint }
      }
    }
    for (const [tabId, entries] of pending) {
      const cur = live[tabId]
      if (cur) live[tabId] = { ...cur, log: appendBounded(cur.log, entries) } as Live
    }
    return { live }
  })
}

function enqueue(e: WsEvent | GrpcEvent): void {
  queue.push(e)
  if (!scheduled) {
    scheduled = true
    requestAnimationFrame(flush)
  }
}

/** Subscribes to the engine's event stream and closes connections of tabs that went away. Returns the unsubscribe. */
export function startRealtimeEvents(): () => void {
  const c = courier()
  const offs = [c.on('ws:event', enqueue), c.on('grpc:event', enqueue)]
  const unsub = useApp.subscribe((s, prev) => {
    if (s.tabs === prev.tabs) return
    const open = new Set(s.tabs.map((t) => t.id))
    for (const [tabId, l] of Object.entries(prev.live)) if (!open.has(tabId)) stopLiveState(l)
  })
  return () => {
    offs.forEach((off) => off())
    unsub()
  }
}

function stopLiveState(l: Live): void {
  if (l.kind === 'websocket' && l.status !== 'closed' && l.status !== 'error') void courier().websocket.disconnect({ connectionId: l.connectionId })
  if (l.kind === 'grpc' && l.running) void courier().grpc.cancel(l.callId)
}

/** Closes the tab's connection / cancels its call. */
export function stopLive(tabId: string): void {
  const l = st().live[tabId]
  if (l) stopLiveState(l)
}

export function clearLog(tabId: string): void {
  setLive(tabId, (l) => (l ? ({ ...l, log: EMPTY_LOG } as Live) : l))
}

// ---------------------------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------------------------

export function wsLive(tabId: string): WsLive | undefined {
  const l = st().live[tabId]
  return l?.kind === 'websocket' ? l : undefined
}

export async function wsConnect(tabId: string): Promise<void> {
  const t = tabOf(tabId)
  if (!t || t.draft.type !== 'websocket') return
  if (!t.draft.url.trim()) {
    st().toast('error', 'Enter a ws:// or wss:// URL first.')
    return
  }
  const prev = wsLive(tabId)
  if (prev && (prev.status === 'open' || prev.status === 'connecting' || prev.status === 'reconnecting')) return
  // A fresh id per connection, so late events of an earlier connection never land in this one.
  const connectionId = newId()
  setLive(tabId, () => ({ kind: 'websocket', connectionId, status: 'connecting', log: prev?.log ?? EMPTY_LOG }))
  const r = await courier().websocket.connect({ ...target<WebSocketRequestDef>(t), connectionId })
  if (!r.ok) {
    setLive(tabId, (l) => (l?.kind === 'websocket' && l.connectionId === connectionId ? { ...l, status: 'error', error: r.error } : l))
    st().toast('error', r.error.message)
  } else if (r.value.status === 'error' && r.value.error) {
    setLive(tabId, (l) => (l?.kind === 'websocket' && l.connectionId === connectionId ? { ...l, status: 'error', error: r.value.error } : l))
  }
}

export async function wsDisconnect(tabId: string): Promise<void> {
  const l = wsLive(tabId)
  if (!l) return
  setLive(tabId, (x) => (x?.kind === 'websocket' && x.status === 'open' ? { ...x, status: 'closing' } : x))
  const r = await courier().websocket.disconnect({ connectionId: l.connectionId })
  if (r.ok && !r.value) setLive(tabId, (x) => (x?.kind === 'websocket' ? { ...x, status: 'closed' } : x))
}

export async function wsSend(tabId: string, message?: WsMessage): Promise<boolean> {
  const t = tabOf(tabId)
  const l = wsLive(tabId)
  if (!t || t.draft.type !== 'websocket') return false
  if (!l || l.status !== 'open') {
    st().toast('error', 'Connect first.')
    return false
  }
  const m = message ?? t.draft.message
  return (await attempt(courier().websocket.send({ connectionId: l.connectionId, message: m }), { context: 'Send failed' })) !== undefined
}

export async function wsPing(tabId: string): Promise<void> {
  const l = wsLive(tabId)
  if (l?.status === 'open') await attempt(courier().websocket.ping(l.connectionId))
}

/** ⌘/Ctrl+Enter: connect when closed, otherwise send the composer message. */
export async function wsPrimary(tabId: string): Promise<void> {
  const l = wsLive(tabId)
  if (l?.status === 'open') await wsSend(tabId)
  else if (!l || l.status === 'closed' || l.status === 'error') await wsConnect(tabId)
}

// ---------------------------------------------------------------------------------------------
// gRPC
// ---------------------------------------------------------------------------------------------

export function grpcLive(tabId: string): GrpcLive | undefined {
  const l = st().live[tabId]
  return l?.kind === 'grpc' ? l : undefined
}

export async function grpcInvoke(tabId: string): Promise<void> {
  const t = tabOf(tabId)
  if (!t || t.draft.type !== 'grpc') return
  const d = t.draft
  if (!d.address.trim()) return void st().toast('error', 'Enter the server address first (host:port).')
  if (!d.descriptor) return void st().toast('error', 'Load the service definition first: use server reflection or import .proto files.')
  if (!d.service || !d.method) return void st().toast('error', 'Pick a service method first.')
  const prev = grpcLive(tabId)
  if (prev?.running) return
  const callId = newId()
  setLive(tabId, () => ({ kind: 'grpc', callId, running: true, requestMetadata: [], headers: [], trailers: [], log: EMPTY_LOG }))
  const r = await courier().grpc.invoke({ ...target<GrpcRequestDef>(t), callId })
  if (!r.ok) {
    setLive(tabId, (l) => (l?.kind === 'grpc' && l.callId === callId ? { ...l, running: false, error: r.error.message } : l))
  }
}

export async function grpcSend(tabId: string): Promise<boolean> {
  const t = tabOf(tabId)
  const l = grpcLive(tabId)
  if (!t || t.draft.type !== 'grpc' || !l?.running) return false
  return (await attempt(courier().grpc.send({ callId: l.callId, message: t.draft.message }), { context: 'Send failed' })) !== undefined
}

export async function grpcEnd(tabId: string): Promise<void> {
  const l = grpcLive(tabId)
  if (l?.running) await attempt(courier().grpc.end(l.callId))
}

export async function grpcCancel(tabId: string): Promise<void> {
  const l = grpcLive(tabId)
  if (l?.running) await attempt(courier().grpc.cancel(l.callId))
}

/** ⌘/Ctrl+Enter: invoke when idle; send the message while a client / bidirectional stream is open. */
export async function grpcPrimary(tabId: string): Promise<void> {
  const l = grpcLive(tabId)
  if (l?.running && (l.callType === 'client-stream' || l.callType === 'bidi')) await grpcSend(tabId)
  else if (!l?.running) await grpcInvoke(tabId)
}
