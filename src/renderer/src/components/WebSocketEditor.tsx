/** WebSocket request tab: URL + connect, composer and saved messages, params / headers / auth / settings, message log. */
import { useEffect, useRef, useState } from 'react'
import { newId, type KeyValue, type WebSocketRequestDef, type WsMessage, type WsMessageFormat, type WsSettings } from '../../../shared/types'
import { buildUrl, splitQuery } from '../../../shared/variables'
import { updateUi } from '../actions'
import { clearLog, wsConnect, wsDisconnect, wsPing, wsSend } from '../realtime'
import { type RequestTab, type TabOf, type WsLive, locate, useApp } from '../store'
import { AuthEditor } from './AuthEditor'
import { CodeEditor } from './CodeEditor'
import { KeyValueGrid } from './KeyValueGrid'
import { MessageLog, PairsTable } from './MessageLog'
import { RequestHeader } from './RequestHeader'
import { Icon, KindBadge, Spinner, Splitter, SubTabs, VarInput } from './ui'

type Section = 'message' | 'saved' | 'params' | 'headers' | 'auth' | 'settings'

const TEXT_FORMATS: { id: WsMessageFormat; label: string }[] = [
  { id: 'json', label: 'JSON' },
  { id: 'xml', label: 'XML' },
  { id: 'text', label: 'Text' }
]
const BINARY_FORMATS: { id: WsMessageFormat; label: string }[] = [
  { id: 'base64', label: 'Base64' },
  { id: 'hex', label: 'Hex' }
]

const STATUS_LABEL: Record<WsLive['status'], string> = {
  connecting: 'Connecting…',
  open: 'Connected',
  closing: 'Closing…',
  closed: 'Disconnected',
  error: 'Error',
  reconnecting: 'Reconnecting…'
}

export function statusClassFor(status: WsLive['status'] | undefined): string {
  if (status === 'open') return 'st-ok'
  if (status === 'error') return 'st-server'
  if (status === 'connecting' || status === 'reconnecting' || status === 'closing') return 'st-redirect'
  return 'st-none'
}

/** URL bar text = base URL + enabled params (as for HTTP). */
function applyTypedUrl(d: WebSocketRequestDef, text: string): WebSocketRequestDef {
  const { base, params } = splitQuery(text)
  const disabled = d.params.filter((p) => !p.enabled)
  return { ...d, url: base, params: [...params, ...disabled] }
}

export function WebSocketEditor({ tab }: { tab: TabOf<WebSocketRequestDef> }): React.JSX.Element {
  const updateTab = useApp((s) => s.updateTab)
  const openDialog = useApp((s) => s.openDialog)
  const settings = useApp((s) => s.settings)
  const live = useApp((s) => (s.live[tab.id]?.kind === 'websocket' ? (s.live[tab.id] as WsLive) : undefined))
  const [section, setSection] = useState<Section>('message')
  const [urlText, setUrlText] = useState<string | null>(null)
  const layout = (settings?.ui.layout as string) === 'horizontal' ? 'horizontal' : 'vertical'
  const [split, setSplit] = useState<number>(() => (typeof settings?.ui.split === 'number' ? (settings.ui.split as number) : 0.5))
  const containerRef = useRef<HTMLDivElement>(null)
  const splitRef = useRef(split)
  splitRef.current = split
  const d = tab.draft
  const set = (fn: (d: WebSocketRequestDef) => WebSocketRequestDef): void => updateTab(tab.id, (t) => ({ ...t, draft: fn((t as RequestTab).draft as WebSocketRequestDef) }) as RequestTab)
  const patch = (p: Partial<WebSocketRequestDef>): void => set((x) => ({ ...x, ...p }))
  const setMessage = (m: Partial<WsMessage>): void => set((x) => ({ ...x, message: { ...x.message, ...m } }))
  useEffect(() => setUrlText(null), [tab.id])

  const found = tab.collectionId && tab.requestId ? locate(tab.collectionId, tab.requestId) : undefined
  const parents = found?.parents ?? []
  const parentRef = tab.collectionId ? { collectionId: tab.collectionId, itemId: parents.length ? parents[parents.length - 1].id : null } : null
  const status = live?.status
  const connected = status === 'open'
  const busy = status === 'connecting' || status === 'reconnecting' || status === 'closing'
  const headerCount = d.headers.filter((h) => h.enabled && h.key).length
  const paramCount = d.params.filter((p) => p.enabled && p.key).length

  const saveMessage = (): void =>
    openDialog({
      type: 'prompt',
      title: 'Save message',
      label: 'Name',
      initial: `Message ${d.savedMessages.length + 1}`,
      confirmLabel: 'Save',
      onSubmit: (name) => {
        set((x) => ({ ...x, savedMessages: [...x.savedMessages, { id: newId(), name: name.trim() || 'Message', ...x.message }] }))
        useApp.getState().toast('success', `Message "${name.trim() || 'Message'}" added — save the request to keep it`)
      }
    })

  return (
    <div className="request-editor rt-editor" data-testid="ws-editor">
      <RequestHeader tab={tab} />
      <div className="url-bar">
        <span className="kind-label kind-websocket" aria-hidden="true">
          <KindBadge kind="websocket" />
        </span>
        <VarInput
          className="url-input"
          ariaLabel="WebSocket URL"
          testId="ws-url"
          collectionId={tab.collectionId}
          placeholder="ws://localhost:8080/socket or wss://…"
          value={urlText ?? buildUrl(d.url, d.params)}
          onFocus={() => setUrlText(buildUrl(d.url, d.params))}
          onBlur={() => setUrlText(null)}
          onChange={(v) => {
            setUrlText(v)
            set((x) => applyTypedUrl(x, v))
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey) && !connected) void wsConnect(tab.id)
          }}
        />
        {connected || status === 'closing' || status === 'reconnecting' ? (
          <button className="btn danger send-btn" data-testid="ws-disconnect" aria-label="Disconnect" onClick={() => void wsDisconnect(tab.id)} disabled={status === 'closing'}>
            {status === 'closing' ? <Spinner /> : <Icon name="stop" size={12} />} Disconnect
          </button>
        ) : (
          <button className="btn primary send-btn" data-testid="ws-connect" aria-label="Connect" onClick={() => void wsConnect(tab.id)} disabled={busy} title="Connect (⌘/Ctrl+Enter)">
            {busy ? <Spinner /> : <Icon name="play" size={12} />} Connect
          </button>
        )}
      </div>

      <div className={`req-split ${layout}`} ref={containerRef}>
        <div className="req-pane" style={{ flexBasis: `${split * 100}%` }}>
          <SubTabs<Section>
            testId="ws-sections"
            value={section}
            onChange={setSection}
            tabs={[
              { id: 'message', label: 'Message' },
              { id: 'saved', label: 'Saved messages', badge: d.savedMessages.length || undefined },
              { id: 'params', label: 'Params', badge: paramCount || undefined },
              { id: 'headers', label: 'Headers', badge: headerCount || undefined },
              { id: 'auth', label: 'Authorization', badge: d.auth.type !== 'inherit' && d.auth.type !== 'none' ? '●' : undefined },
              { id: 'settings', label: 'Settings', badge: d.subprotocols.length ? d.subprotocols.length : undefined }
            ]}
          />
          <div className="section-body">
            {section === 'message' && (
              <div className="composer">
                <div className="composer-bar">
                  <div className="seg" role="radiogroup" aria-label="Message type">
                    {(['text', 'binary'] as const).map((k) => (
                      <button
                        key={k}
                        role="radio"
                        aria-label={k === 'text' ? 'Text message' : 'Binary message'}
                        aria-checked={d.message.kind === k}
                        data-testid={`ws-kind-${k}`}
                        className={`seg-btn ${d.message.kind === k ? 'on' : ''}`}
                        onClick={() => setMessage({ kind: k, format: k === 'binary' ? 'base64' : 'json' })}
                      >
                        {k === 'text' ? 'Text' : 'Binary'}
                      </button>
                    ))}
                  </div>
                  <select aria-label="Message format" data-testid="ws-format" value={d.message.format} onChange={(e) => setMessage({ format: e.target.value as WsMessageFormat })}>
                    {(d.message.kind === 'binary' ? BINARY_FORMATS : TEXT_FORMATS).map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  {d.message.format === 'json' && (
                    <button
                      className="btn small"
                      data-testid="ws-beautify"
                      aria-label="Beautify JSON"
                      onClick={() => {
                        try {
                          setMessage({ body: JSON.stringify(JSON.parse(d.message.body), null, 2) })
                        } catch {
                          useApp.getState().toast('error', 'The message is not valid JSON (variables inside strings are fine).')
                        }
                      }}
                    >
                      Beautify
                    </button>
                  )}
                  <div className="grow" />
                  <button className="btn small" data-testid="ws-save-message" aria-label="Save message" onClick={saveMessage} disabled={!d.message.body}>
                    <Icon name="save" size={12} /> Save message
                  </button>
                  <button className="btn small" aria-label="Send ping" data-testid="ws-ping" disabled={!connected} onClick={() => void wsPing(tab.id)}>
                    Ping
                  </button>
                  <button className="btn primary small" data-testid="ws-send" aria-label="Send message" disabled={!connected} onClick={() => void wsSend(tab.id)} title="Send (⌘/Ctrl+Enter)">
                    <Icon name="play" size={11} /> Send
                  </button>
                </div>
                <div className="composer-editor" data-testid="ws-message-editor">
                  <CodeEditor
                    value={d.message.body}
                    onChange={(body) => setMessage({ body })}
                    language={d.message.format === 'json' ? 'json' : d.message.format === 'xml' ? 'xml' : 'text'}
                    ariaLabel="Message to send"
                    placeholder={d.message.kind === 'binary' ? (d.message.format === 'hex' ? 'de ad be ef' : 'base64, e.g. 3q2+7w==') : '{"type": "hello", "token": "{{token}}"}'}
                    wrap={d.message.kind === 'binary'}
                  />
                </div>
                <p className="muted small composer-hint">{'{{variables}}'} and {'{{vault:…}}'} are resolved when you press Send; the log shows Key Vault values as ••••.</p>
              </div>
            )}
            {section === 'saved' && (
              <div className="scroll-pad" data-testid="ws-saved">
                {d.savedMessages.length === 0 && <p className="muted">No saved messages. Write one in Message and press “Save message”.</p>}
                {d.savedMessages.map((m) => (
                  <div key={m.id} className="saved-msg" data-testid="ws-saved-row" data-name={m.name}>
                    <div className="saved-msg-main">
                      <span className="strong">{m.name}</span>
                      <span className="log-tag">{m.kind === 'binary' ? `BIN ${m.format}` : m.format.toUpperCase()}</span>
                      <span className="mono small muted saved-msg-preview">{m.body.replace(/\s+/g, ' ').slice(0, 120)}</span>
                    </div>
                    <button className="btn small" aria-label={`Load ${m.name}`} data-testid="ws-saved-load" onClick={() => {
                        setMessage({ kind: m.kind, format: m.format, body: m.body })
                        setSection('message')
                      }}>
                      Load
                    </button>
                    <button className="btn small primary" aria-label={`Send ${m.name}`} data-testid="ws-saved-send" disabled={!connected} onClick={() => void wsSend(tab.id, { kind: m.kind, format: m.format, body: m.body })}>
                      Send
                    </button>
                    <button className="icon-btn" aria-label={`Delete ${m.name}`} data-testid="ws-saved-delete" onClick={() => patch({ savedMessages: d.savedMessages.filter((x) => x.id !== m.id) })}>
                      <Icon name="trash" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {section === 'params' && (
              <div className="scroll-pad">
                <div className="section-title">Query params</div>
                <KeyValueGrid testId="ws-params-grid" rows={d.params} collectionId={tab.collectionId} onChange={(params: KeyValue[]) => patch({ params })} />
              </div>
            )}
            {section === 'headers' && (
              <div className="scroll-pad">
                <KeyValueGrid testId="ws-headers-grid" rows={d.headers} collectionId={tab.collectionId} onChange={(headers: KeyValue[]) => patch({ headers })} />
                <p className="muted small">Sent on the opening handshake. Cookies from the cookie jar and auth headers are added automatically unless you set them here.</p>
              </div>
            )}
            {section === 'auth' && (
              <div className="scroll-pad">
                <AuthEditor auth={d.auth} onChange={(auth) => patch({ auth })} collectionId={tab.collectionId} parentRef={parentRef} allowInherit unsupported={{ protocol: 'WebSocket', types: ['digest', 'ntlm', 'awsv4'] }} />
              </div>
            )}
            {section === 'settings' && <WsSettingsEditor value={d.settings} subprotocols={d.subprotocols} onChange={(s) => patch({ settings: s })} onSubprotocols={(subprotocols) => patch({ subprotocols })} />}
          </div>
        </div>
        <Splitter
          direction={layout === 'horizontal' ? 'x' : 'y'}
          label="Resize request and messages"
          onDrag={(delta) => {
            const el = containerRef.current
            if (!el) return
            const size = layout === 'horizontal' ? el.clientWidth : el.clientHeight
            setSplit((s) => Math.min(0.85, Math.max(0.15, s + delta / size)))
          }}
          onEnd={() => void updateUi({ split: splitRef.current })}
        />
        <div className="res-pane">
          <WsPane tabId={tab.id} live={live} layout={layout} />
        </div>
      </div>
    </div>
  )
}

function WsPane({ tabId, live, layout }: { tabId: string; live: WsLive | undefined; layout: 'horizontal' | 'vertical' }): React.JSX.Element {
  const [view, setView] = useState<'messages' | 'handshake'>('messages')
  const hs = live?.handshake
  return (
    <div className="response" data-testid="ws-pane">
      <div className="res-toolbar">
        <span className="pane-label">Messages</span>
        <div className="res-meta">
          <span className={`status-pill ${statusClassFor(live?.status)}`} data-testid="ws-status" data-status={live?.status ?? 'idle'}>
            {live ? STATUS_LABEL[live.status] : 'Not connected'}
            {live?.status === 'closed' && live.code !== undefined ? ` ${live.code}` : ''}
            {live?.status === 'reconnecting' && live.attempt ? ` (${live.attempt})` : ''}
          </span>
          {live?.status === 'closed' && live.reason && <span className="meta-item" data-testid="ws-close-reason">{live.reason}</span>}
          {hs?.protocol && (
            <span className="meta-item" title="Negotiated subprotocol">
              {hs.protocol}
            </span>
          )}
        </div>
        <button className="icon-btn subtle" aria-label="Toggle layout" data-testid="ws-layout-toggle" title={layout === 'horizontal' ? 'Stack request above messages' : 'Show request and messages side by side'} onClick={() => void updateUi({ layout: layout === 'horizontal' ? 'vertical' : 'horizontal' })}>
          <Icon name={layout === 'horizontal' ? 'splitH' : 'split'} />
        </button>
      </div>
      {live?.error && (live.status === 'error' || live.status === 'closed') && (
        <div className="error-box" data-testid="ws-error" data-code={live.error.code}>
          <Icon name="warn" />
          <div>
            <strong>{live.status === 'error' ? 'Could not connect' : 'Connection closed'}:</strong> {live.error.message}
          </div>
        </div>
      )}
      <SubTabs<'messages' | 'handshake'>
        testId="ws-pane-tabs"
        value={view}
        onChange={setView}
        tabs={[
          { id: 'messages', label: 'Messages', badge: live?.log.entries.filter((e) => e.direction !== 'info').length || undefined },
          { id: 'handshake', label: 'Handshake', badge: hs?.status }
        ]}
      />
      <div className="res-body">
        {view === 'messages' && <MessageLog testId="ws-log" log={live?.log ?? { entries: [], bytes: 0, dropped: 0 }} onClear={() => clearLog(tabId)} pings empty="Connect, then send a message. Messages in both directions appear here (kept in memory only)." />}
        {view === 'handshake' && (
          <div className="scroll-pad" data-testid="ws-handshake">
            {!hs ? (
              <p className="muted">Connect to see the handshake.</p>
            ) : (
              <>
                <div className="sent-line mono">
                  <strong>GET</strong> <span className="break">{hs.url}</span>
                  {hs.status !== undefined && (
                    <span className={`status-pill ${hs.status === 101 ? 'st-ok' : 'st-server'}`} style={{ marginLeft: 8 }} data-testid="ws-handshake-status">
                      {hs.status} {hs.statusText ?? ''}
                    </span>
                  )}
                </div>
                <div className="section-title">Request headers</div>
                <PairsTable rows={hs.requestHeaders} testId="ws-request-headers" empty="No headers." />
                <div className="section-title">Response headers</div>
                <PairsTable rows={hs.responseHeaders} testId="ws-response-headers" empty="No response yet." />
                <p className="muted small">Key Vault secrets and tokens are shown as ••••.</p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function TriState({ label, value, def, onChange, testId }: { label: string; value: boolean | undefined; def: boolean; onChange: (v: boolean | undefined) => void; testId?: string }): React.JSX.Element {
  return (
    <>
      <label>{label}</label>
      <select aria-label={label} data-testid={testId} value={value === undefined ? 'default' : value ? 'on' : 'off'} onChange={(e) => onChange(e.target.value === 'default' ? undefined : e.target.value === 'on')}>
        <option value="default">Default ({def ? 'on' : 'off'})</option>
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    </>
  )
}

function WsSettingsEditor({ value, subprotocols, onChange, onSubprotocols }: { value: WsSettings; subprotocols: string[]; onChange: (s: WsSettings) => void; onSubprotocols: (p: string[]) => void }): React.JSX.Element {
  const http = useApp((s) => s.settings?.http)
  const [protoText, setProtoText] = useState(subprotocols.join(', '))
  const num = (k: 'handshakeTimeoutMs' | 'maxMessageBytes', v: string, scale = 1): void => {
    const n = v.trim() === '' ? undefined : Math.max(1, Math.floor(Number(v) * scale))
    const next = { ...value }
    if (n === undefined || Number.isNaN(n)) delete next[k]
    else next[k] = n
    onChange(next)
  }
  return (
    <div className="scroll-pad">
      <div className="form-grid narrow">
        <label htmlFor="ws-protocols">Subprotocols</label>
        <input
          id="ws-protocols"
          aria-label="Subprotocols"
          data-testid="ws-subprotocols"
          placeholder="e.g. graphql-transport-ws, json"
          value={protoText}
          onChange={(e) => {
            setProtoText(e.target.value)
            onSubprotocols(
              e.target.value
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean)
            )
          }}
        />
        <TriState label="Verify TLS certificates" testId="ws-verify-tls" value={value.verifyTls} def={http?.verifyTls ?? true} onChange={(v) => onChange(v === undefined ? (({ verifyTls: _x, ...rest }) => rest)(value) : { ...value, verifyTls: v })} />
        <label htmlFor="ws-timeout">Handshake timeout (ms)</label>
        <input id="ws-timeout" type="number" min={1} aria-label="Handshake timeout (ms)" data-testid="ws-handshake-timeout" placeholder="Default (30000)" value={value.handshakeTimeoutMs ?? ''} onChange={(e) => num('handshakeTimeoutMs', e.target.value)} />
        <label htmlFor="ws-max">Max message size (KB)</label>
        <input id="ws-max" type="number" min={1} aria-label="Max message size (KB)" data-testid="ws-max-size" placeholder="Default (16384)" value={value.maxMessageBytes ? Math.round(value.maxMessageBytes / 1024) : ''} onChange={(e) => num('maxMessageBytes', e.target.value, 1024)} />
        <label />
        <label className="check">
          <input type="checkbox" aria-label="Reconnect automatically" data-testid="ws-auto-reconnect" checked={value.autoReconnect === true} onChange={(e) => onChange({ ...value, autoReconnect: e.target.checked })} /> Reconnect automatically after an unexpected close
        </label>
      </div>
      <p className="muted small">Subprotocols are offered in this order (Sec-WebSocket-Protocol). Larger incoming messages close the connection with code 1009.</p>
    </div>
  )
}
