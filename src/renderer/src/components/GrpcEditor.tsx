/** gRPC request tab: address, method picker, message (with example), metadata / auth / service definition / settings, call log. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { GrpcTlsKind } from '../../../shared/api'
import type { GrpcCallType, GrpcDescriptor, GrpcMethodInfo, GrpcRequestDef, GrpcServiceInfo, GrpcSettings, GrpcTlsFiles, KeyValue } from '../../../shared/types'
import { attempt, courier } from '../api'
import { updateUi } from '../actions'
import { clearLog, grpcCancel, grpcEnd, grpcInvoke, grpcSend } from '../realtime'
import { type GrpcLive, type RequestTab, type TabOf, locate, useApp } from '../store'
import { AuthEditor } from './AuthEditor'
import { CodeEditor } from './CodeEditor'
import { KeyValueGrid } from './KeyValueGrid'
import { MessageLog, PairsTable } from './MessageLog'
import { RequestHeader } from './RequestHeader'
import { Icon, KindBadge, Popover, Spinner, Splitter, SubTabs, VarInput, formatMs } from './ui'

type Section = 'message' | 'metadata' | 'auth' | 'definition' | 'settings'

const CALL_LABEL: Record<GrpcCallType, string> = { unary: 'Unary', 'server-stream': 'Server streaming', 'client-stream': 'Client streaming', bidi: 'Bidirectional streaming' }

/** Services of a stored definition (parsed in main), cached per definition text. */
function useServices(descriptor: GrpcDescriptor | null): { services: GrpcServiceInfo[]; error: string | null } {
  const [state, setState] = useState<{ key: string; services: GrpcServiceInfo[]; error: string | null }>({ key: '', services: [], error: null })
  const key = descriptor ? `${descriptor.loadedAt}:${descriptor.json.length}` : ''
  useEffect(() => {
    let live = true
    if (!descriptor) {
      setState({ key: '', services: [], error: null })
      return
    }
    void courier()
      .grpc.describe({ descriptor })
      .then((r) => {
        if (live) setState({ key, services: r.ok ? r.value : [], error: r.ok ? null : r.error.message })
      })
    return () => {
      live = false
    }
  }, [key])
  return { services: state.services, error: state.error }
}

export function GrpcEditor({ tab }: { tab: TabOf<GrpcRequestDef> }): React.JSX.Element {
  const updateTab = useApp((s) => s.updateTab)
  const settings = useApp((s) => s.settings)
  const live = useApp((s) => (s.live[tab.id]?.kind === 'grpc' ? (s.live[tab.id] as GrpcLive) : undefined))
  const [section, setSection] = useState<Section>(() => (tab.draft.descriptor ? 'message' : 'definition'))
  const [picker, setPicker] = useState<HTMLElement | null>(null)
  const layout = (settings?.ui.layout as string) === 'horizontal' ? 'horizontal' : 'vertical'
  const [split, setSplit] = useState<number>(() => (typeof settings?.ui.split === 'number' ? (settings.ui.split as number) : 0.5))
  const containerRef = useRef<HTMLDivElement>(null)
  const splitRef = useRef(split)
  splitRef.current = split
  const d = tab.draft
  const set = (fn: (d: GrpcRequestDef) => GrpcRequestDef): void => updateTab(tab.id, (t) => ({ ...t, draft: fn((t as RequestTab).draft as GrpcRequestDef) }) as RequestTab)
  const patch = (p: Partial<GrpcRequestDef>): void => set((x) => ({ ...x, ...p }))
  const { services, error: describeError } = useServices(d.descriptor)
  const method: GrpcMethodInfo | undefined = services.find((s) => s.name === d.service)?.methods.find((m) => m.method === d.method)
  const running = !!live?.running
  const streamingOut = running && (live?.callType === 'client-stream' || live?.callType === 'bidi')

  const found = tab.collectionId && tab.requestId ? locate(tab.collectionId, tab.requestId) : undefined
  const parents = found?.parents ?? []
  const parentRef = tab.collectionId ? { collectionId: tab.collectionId, itemId: parents.length ? parents[parents.length - 1].id : null } : null
  const metaCount = d.metadata.filter((m) => m.enabled && m.key).length

  const generateExample = async (svc = d.service, m = d.method, descriptor = d.descriptor): Promise<void> => {
    if (!descriptor || !svc || !m) return
    const ex = await attempt(courier().grpc.example({ descriptor, service: svc, method: m }), { context: 'Example failed' })
    if (ex !== undefined) patch({ message: ex })
  }

  const pick = (m: GrpcMethodInfo): void => {
    setPicker(null)
    const empty = !d.message.trim() || d.message.trim() === '{}'
    patch({ service: m.service, method: m.method })
    if (empty) void generateExample(m.service, m.method)
    setSection('message')
  }

  return (
    <div className="request-editor rt-editor" data-testid="grpc-editor">
      <RequestHeader tab={tab} />
      <div className="url-bar">
        <span className="kind-label kind-grpc" aria-hidden="true">
          <KindBadge kind="grpc" />
        </span>
        <VarInput
          className="url-input grpc-address"
          ariaLabel="Server address"
          testId="grpc-address"
          collectionId={tab.collectionId}
          placeholder="localhost:50051 (grpcs:// for TLS)"
          value={d.address}
          onChange={(address) => patch({ address, ...(/^grpcs:\/\//i.test(address) ? { tls: true } : /^grpc:\/\//i.test(address) ? { tls: false } : {}) })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey) && !running) void grpcInvoke(tab.id)
          }}
        />
        <button className="btn method-picker" data-testid="grpc-method-picker" aria-label="Select a service method" aria-haspopup="dialog" onClick={(e) => setPicker(picker ? null : e.currentTarget)} title={method ? `${method.path} · ${CALL_LABEL[method.callType]}` : 'Select a service method'}>
          {d.method ? (
            <>
              <span className="mono method-picker-name">{d.method}</span>
              <span className="muted small method-picker-svc">{d.service.split('.').pop()}</span>
            </>
          ) : (
            <span className="muted">Select method</span>
          )}
          <Icon name="down" size={11} />
        </button>
        {running ? (
          <button className="btn danger send-btn" data-testid="grpc-cancel" aria-label="Cancel call" onClick={() => void grpcCancel(tab.id)}>
            <Spinner /> Cancel
          </button>
        ) : (
          <button className="btn primary send-btn" data-testid="grpc-invoke" aria-label="Invoke" onClick={() => void grpcInvoke(tab.id)} title="Invoke (⌘/Ctrl+Enter)">
            <Icon name="play" size={12} /> Invoke
          </button>
        )}
      </div>
      {picker && <MethodPicker anchor={picker} services={services} error={describeError} hasDescriptor={!!d.descriptor} current={method?.path} onPick={pick} onClose={() => setPicker(null)} onLoad={() => {
          setPicker(null)
          setSection('definition')
        }} />}

      <div className={`req-split ${layout}`} ref={containerRef}>
        <div className="req-pane" style={{ flexBasis: `${split * 100}%` }}>
          <SubTabs<Section>
            testId="grpc-sections"
            value={section}
            onChange={setSection}
            tabs={[
              { id: 'message', label: 'Message' },
              { id: 'metadata', label: 'Metadata', badge: metaCount || undefined },
              { id: 'auth', label: 'Authorization', badge: d.auth.type !== 'inherit' && d.auth.type !== 'none' ? '●' : undefined },
              { id: 'definition', label: 'Service definition', badge: d.descriptor ? '●' : undefined },
              { id: 'settings', label: 'Settings', badge: d.tls ? 'TLS' : undefined }
            ]}
          />
          <div className="section-body">
            {section === 'message' && (
              <div className="composer">
                <div className="composer-bar">
                  {method ? (
                    <span className="small muted" data-testid="grpc-method-info">
                      <span className="call-type">{CALL_LABEL[method.callType]}</span> {method.requestType} → {method.responseType}
                    </span>
                  ) : (
                    <span className="small muted">{d.descriptor ? 'Select a method to see its message type.' : 'Load the service definition first.'}</span>
                  )}
                  <div className="grow" />
                  <button className="btn small" data-testid="grpc-example" aria-label="Generate example message" disabled={!method} onClick={() => void generateExample()}>
                    <Icon name="wand" size={12} /> Example
                  </button>
                  <button
                    className="btn small"
                    data-testid="grpc-beautify"
                    aria-label="Beautify JSON"
                    onClick={() => {
                      try {
                        patch({ message: JSON.stringify(JSON.parse(d.message), null, 2) })
                      } catch {
                        useApp.getState().toast('error', 'The message is not valid JSON.')
                      }
                    }}
                  >
                    Beautify
                  </button>
                  {streamingOut && (
                    <>
                      <button className="btn small primary" data-testid="grpc-send" aria-label="Send message on the stream" onClick={() => void grpcSend(tab.id)} title="Send (⌘/Ctrl+Enter)">
                        <Icon name="play" size={11} /> Send
                      </button>
                      <button className="btn small" data-testid="grpc-end" aria-label="End the request stream" onClick={() => void grpcEnd(tab.id)}>
                        End stream
                      </button>
                    </>
                  )}
                </div>
                <div className="composer-editor" data-testid="grpc-message">
                  <CodeEditor value={d.message} onChange={(message) => patch({ message })} language="json" ariaLabel="Request message (JSON)" placeholder='{"name": "{{user}}"}' />
                </div>
                <p className="muted small composer-hint">
                  {method?.callType === 'client-stream' || method?.callType === 'bidi'
                    ? 'Invoke opens the stream; then Send sends this message (edit it between sends), End stream half-closes.'
                    : 'Proto3 JSON: 64-bit integers as strings, bytes as base64, enums by name, Timestamp as "2025-01-31T12:00:00Z".'}{' '}
                  {'{{variables}}'} and {'{{vault:…}}'} resolve at invoke / send time.
                </p>
              </div>
            )}
            {section === 'metadata' && (
              <div className="scroll-pad">
                <KeyValueGrid testId="grpc-metadata-grid" rows={d.metadata} collectionId={tab.collectionId} keyPlaceholder="key (lower-case)" onChange={(metadata: KeyValue[]) => patch({ metadata })} />
                <p className="muted small">Sent as request metadata. Keys ending in -bin take base64 values. Auth adds an authorization entry unless you set one.</p>
              </div>
            )}
            {section === 'auth' && (
              <div className="scroll-pad">
                <AuthEditor auth={d.auth} onChange={(auth) => patch({ auth })} collectionId={tab.collectionId} parentRef={parentRef} allowInherit unsupported={{ protocol: 'gRPC', types: ['digest', 'ntlm', 'awsv4'] }} />
                <p className="muted small">API keys and JWTs are sent as metadata (gRPC has no query string).</p>
              </div>
            )}
            {section === 'definition' && <DefinitionEditor tab={tab} services={services} describeError={describeError} onLoaded={(descriptor) => patch({ descriptor })} />}
            {section === 'settings' && <GrpcSettingsEditor requestId={d.id} tls={d.tls} value={d.settings} onTls={(tls) => patch({ tls })} onChange={(s) => patch({ settings: s })} address={d.address} />}
          </div>
        </div>
        <Splitter
          direction={layout === 'horizontal' ? 'x' : 'y'}
          label="Resize request and response"
          onDrag={(delta) => {
            const el = containerRef.current
            if (!el) return
            const size = layout === 'horizontal' ? el.clientWidth : el.clientHeight
            setSplit((s) => Math.min(0.85, Math.max(0.15, s + delta / size)))
          }}
          onEnd={() => void updateUi({ split: splitRef.current })}
        />
        <div className="res-pane">
          <GrpcPane tabId={tab.id} live={live} layout={layout} />
        </div>
      </div>
    </div>
  )
}

function MethodPicker({
  anchor,
  services,
  error,
  hasDescriptor,
  current,
  onPick,
  onClose,
  onLoad
}: {
  anchor: HTMLElement
  services: GrpcServiceInfo[]
  error: string | null
  hasDescriptor: boolean
  current?: string
  onPick: (m: GrpcMethodInfo) => void
  onClose: () => void
  onLoad: () => void
}): React.JSX.Element {
  const [q, setQ] = useState('')
  const query = q.trim().toLowerCase()
  const shown = useMemo(
    () => services.map((s) => ({ ...s, methods: s.methods.filter((m) => !query || m.path.toLowerCase().includes(query) || m.requestType.toLowerCase().includes(query)) })).filter((s) => s.methods.length),
    [services, query]
  )
  return (
    <Popover anchor={anchor} onClose={onClose} width={460} testId="grpc-method-popover">
      <div className="method-search">
        <div className="search-box grow">
          <Icon name="search" size={12} />
          <input autoFocus aria-label="Search methods" data-testid="grpc-method-search" placeholder="Search services and methods" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="method-list" role="listbox" aria-label="Service methods">
        {!hasDescriptor && (
          <div className="pad">
            <p className="muted">No service definition yet.</p>
            <button className="btn small" aria-label="Load the service definition" data-testid="grpc-picker-load" onClick={onLoad}>
              Load via reflection or .proto files
            </button>
          </div>
        )}
        {error && <p className="error-text pad">{error}</p>}
        {hasDescriptor && !error && shown.length === 0 && <p className="muted pad">No methods match.</p>}
        {shown.map((s) => (
          <div key={s.name} className="method-group">
            <div className="method-group-name mono small">{s.name}</div>
            {s.methods.map((m) => (
              <button key={m.path} role="option" aria-label={`${m.method} (${m.service})`} aria-selected={m.path === current} className={`method-option ${m.path === current ? 'on' : ''}`} data-testid="grpc-method-option" data-path={m.path} onClick={() => onPick(m)}>
                <span className="mono">{m.method}</span>
                <span className="muted small">
                  {m.requestType.split('.').pop()} → {m.responseType.split('.').pop()}
                </span>
                {m.callType !== 'unary' && <span className="log-tag">{m.callType === 'bidi' ? 'BIDI' : m.callType === 'server-stream' ? 'SERVER STREAM' : 'CLIENT STREAM'}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </Popover>
  )
}

function DefinitionEditor({ tab, services, describeError, onLoaded }: { tab: TabOf<GrpcRequestDef>; services: GrpcServiceInfo[]; describeError: string | null; onLoaded: (d: GrpcDescriptor | null) => void }): React.JSX.Element {
  const d = tab.draft
  const [files, setFiles] = useState<{ path: string; name: string }[]>([])
  const [dirs, setDirs] = useState<{ path: string; name: string }[]>([])
  const [busy, setBusy] = useState<'reflect' | 'protos' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reflect = async (): Promise<void> => {
    setBusy('reflect')
    setError(null)
    const t = useApp.getState().tabs.find((x) => x.id === tab.id) as RequestTab | undefined
    const savedHere = t?.collectionId && t.requestId && locate(t.collectionId, t.requestId)
    const r = await courier().grpc.reflect({ collectionId: t?.collectionId ?? null, requestId: savedHere ? t.requestId : null, draft: (t?.draft ?? d) as GrpcRequestDef })
    setBusy(null)
    if (r.ok) {
      onLoaded(r.value)
      useApp.getState().toast('success', 'Loaded the service definition from the server')
    } else setError(r.error.message)
  }
  const loadProtos = async (): Promise<void> => {
    setBusy('protos')
    setError(null)
    const r = await courier().grpc.loadProtos({ files: files.map((f) => f.path), importDirs: dirs.map((x) => x.path) })
    setBusy(null)
    if (r.ok) {
      onLoaded(r.value)
      useApp.getState().toast('success', `Loaded ${r.value.files.length} .proto file${r.value.files.length === 1 ? '' : 's'}`)
    } else setError(r.error.message)
  }
  const methodCount = services.reduce((n, s) => n + s.methods.length, 0)
  return (
    <div className="scroll-pad" data-testid="grpc-definition">
      {d.descriptor ? (
        <div className="info-box definition-info" data-testid="grpc-descriptor-info" data-source={d.descriptor.source}>
          <div>
            <strong>{d.descriptor.source === 'reflection' ? 'From server reflection' : 'From .proto files'}</strong> · {services.length} service{services.length === 1 ? '' : 's'}, {methodCount} method{methodCount === 1 ? '' : 's'} · loaded {new Date(d.descriptor.loadedAt).toLocaleString()}
          </div>
          <div className="muted small mono definition-files">{d.descriptor.files.join(', ')}</div>
          <div className="muted small">Stored with the request, so teammates can call it without the files. Load again to refresh.</div>
          <button className="link-btn small" aria-label="Remove the service definition" data-testid="grpc-clear-descriptor" onClick={() => onLoaded(null)}>
            Remove definition
          </button>
        </div>
      ) : (
        <p className="muted">Load the service definition from the server (reflection) or from .proto files.</p>
      )}
      {describeError && <p className="error-text">{describeError}</p>}
      {error && (
        <div className="error-box" data-testid="grpc-definition-error">
          <Icon name="warn" />
          <div>{error}</div>
        </div>
      )}
      <div className="section-title">Server reflection</div>
      <div className="row-gap">
        <button className="btn" data-testid="grpc-reflect" aria-label="Load via server reflection" disabled={busy !== null || !d.address.trim()} onClick={() => void reflect()}>
          {busy === 'reflect' ? <Spinner /> : <Icon name="sync" size={12} />} Load via reflection
        </button>
        <span className="muted small">Uses the address, TLS settings, metadata and auth above (grpc.reflection.v1, then v1alpha).</span>
      </div>
      <div className="section-title">.proto files</div>
      <div className="row-gap">
        <button
          className="btn"
          data-testid="grpc-pick-protos"
          aria-label="Choose .proto files"
          onClick={async () => {
            const r = await attempt(courier().grpc.pickProtoFiles())
            if (r) setFiles((prev) => [...prev.filter((p) => !r.some((x) => x.path === p.path)), ...r.map((x) => ({ path: x.path, name: x.name }))])
          }}
        >
          <Icon name="import" size={12} /> Choose .proto files…
        </button>
        <button
          className="btn"
          data-testid="grpc-add-import-dir"
          aria-label="Add import directory"
          onClick={async () => {
            const r = await attempt(courier().grpc.pickImportDir())
            if (r) setDirs((prev) => [...prev.filter((p) => p.path !== r.path), r])
          }}
        >
          <Icon name="folder" size={12} /> Add import directory…
        </button>
        <button className="btn primary" data-testid="grpc-load-protos" aria-label="Load the chosen .proto files" disabled={!files.length || busy !== null} onClick={() => void loadProtos()}>
          {busy === 'protos' ? <Spinner /> : null} Load
        </button>
      </div>
      {(files.length > 0 || dirs.length > 0) && (
        <ul className="picked-list" data-testid="grpc-picked">
          {files.map((f) => (
            <li key={f.path} title={f.path}>
              <Icon name="code" size={11} /> <span className="mono">{f.name}</span>
              <button className="icon-btn" aria-label={`Remove ${f.name}`} data-testid="grpc-picked-remove" onClick={() => setFiles((p) => p.filter((x) => x.path !== f.path))}>
                <Icon name="x" size={10} />
              </button>
            </li>
          ))}
          {dirs.map((x) => (
            <li key={x.path} title={x.path}>
              <Icon name="folder" size={11} /> <span className="mono">{x.name}/</span> <span className="muted small">import directory</span>
              <button className="icon-btn" aria-label={`Remove ${x.name}`} data-testid="grpc-import-dir-remove" onClick={() => setDirs((p) => p.filter((y) => y.path !== x.path))}>
                <Icon name="x" size={10} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">Imports resolve in the import directories and the folders of the chosen files; google/protobuf/*.proto are built in. Nothing outside those folders is read, and only file names are stored.</p>
    </div>
  )
}

function GrpcSettingsEditor({ requestId, tls, value, onTls, onChange, address }: { requestId: string; tls: boolean; value: GrpcSettings; onTls: (v: boolean) => void; onChange: (s: GrpcSettings) => void; address: string }): React.JSX.Element {
  const http = useApp((s) => s.settings?.http)
  const [files, setFiles] = useState<GrpcTlsFiles>({})
  useEffect(() => {
    let live = true
    void courier()
      .grpc.tlsFiles(requestId)
      .then((r) => {
        if (live && r.ok) setFiles(r.value)
      })
    return () => {
      live = false
    }
  }, [requestId])
  const scheme = /^grpcs:\/\//i.test(address.trim()) ? 'grpcs' : /^grpc:\/\//i.test(address.trim()) ? 'grpc' : null
  const num = (k: 'deadlineMs' | 'maxReceiveBytes', v: string, scale = 1): void => {
    const n = v.trim() === '' ? undefined : Math.max(1, Math.floor(Number(v) * scale))
    const next = { ...value }
    if (n === undefined || Number.isNaN(n)) delete next[k]
    else next[k] = n
    onChange(next)
  }
  const fileRow = (kind: GrpcTlsKind, label: string): React.JSX.Element => (
    <>
      <label>{label}</label>
      <div className="row-gap tls-file">
        <span className="mono small" data-testid={`grpc-tls-${kind}-name`}>
          {files[kind]?.name ?? <span className="muted">none</span>}
        </span>
        <button
          className="btn small"
          aria-label={`Choose ${label}`}
          data-testid={`grpc-tls-${kind}`}
          onClick={async () => {
            const r = await attempt(courier().grpc.pickTlsFile({ requestId, kind }))
            if (r) setFiles(r)
          }}
        >
          Choose…
        </button>
        {files[kind] && (
          <button
            className="link-btn small"
            aria-label={`Remove ${label}`}
            data-testid={`grpc-tls-${kind}-remove`}
            onClick={async () => {
              const r = await attempt(courier().grpc.clearTlsFile({ requestId, kind }))
              if (r) setFiles(r)
            }}
          >
            Remove
          </button>
        )}
      </div>
    </>
  )
  return (
    <div className="scroll-pad">
      <div className="form-grid narrow">
        <label />
        <label className="check">
          <input type="checkbox" aria-label="Use TLS" data-testid="grpc-tls" checked={scheme ? scheme === 'grpcs' : tls} disabled={scheme !== null} onChange={(e) => onTls(e.target.checked)} /> Use TLS{scheme ? ` (set by ${scheme}://)` : ''}
        </label>
        <label>Verify TLS certificates</label>
        <select aria-label="Verify TLS certificates" data-testid="grpc-verify-tls" value={value.verifyTls === undefined ? 'default' : value.verifyTls ? 'on' : 'off'} onChange={(e) => onChange(e.target.value === 'default' ? (({ verifyTls: _x, ...rest }) => rest)(value) : { ...value, verifyTls: e.target.value === 'on' })}>
          <option value="default">Default ({http?.verifyTls ?? true ? 'on' : 'off'})</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
        {fileRow('ca', 'CA certificate')}
        {fileRow('cert', 'Client certificate')}
        {fileRow('key', 'Client key')}
        <label htmlFor="grpc-deadline">Deadline (ms)</label>
        <input id="grpc-deadline" type="number" min={1} aria-label="Deadline (ms)" data-testid="grpc-deadline" placeholder="None" value={value.deadlineMs ?? ''} onChange={(e) => num('deadlineMs', e.target.value)} />
        <label htmlFor="grpc-max">Max receive message size (KB)</label>
        <input id="grpc-max" type="number" min={1} aria-label="Max receive message size (KB)" data-testid="grpc-max-receive" placeholder="Default (4096)" value={value.maxReceiveBytes ? Math.round(value.maxReceiveBytes / 1024) : ''} onChange={(e) => num('maxReceiveBytes', e.target.value, 1024)} />
      </div>
      <p className="muted small">CA, certificate and key files are remembered on this machine only (never synced); teammates choose their own. Without a CA file the system trust store is used.</p>
    </div>
  )
}

function GrpcPane({ tabId, live, layout }: { tabId: string; live: GrpcLive | undefined; layout: 'horizontal' | 'vertical' }): React.JSX.Element {
  const [view, setView] = useState<'messages' | 'headers' | 'trailers' | 'request'>('messages')
  const st = live?.status
  const cls = live?.running ? 'st-redirect' : st ? (st.code === 0 ? 'st-ok' : 'st-server') : live?.error ? 'st-server' : 'st-none'
  return (
    <div className="response" data-testid="grpc-pane">
      <div className="res-toolbar">
        <span className="pane-label">Response</span>
        <div className="res-meta">
          {(live || st) && (
            <span className={`status-pill ${cls}`} data-testid="grpc-status" data-code={st?.code ?? ''} data-name={live?.running ? 'RUNNING' : (st?.name ?? (live?.error ? 'ERROR' : ''))}>
              {live?.running ? 'Running…' : st ? `${st.code} ${st.name}` : live?.error ? 'Not sent' : ''}
            </span>
          )}
          {live?.callType && <span className="meta-item">{CALL_LABEL[live.callType]}</span>}
          {live?.durationMs !== undefined && (
            <span className="meta-item" data-testid="grpc-duration" title="Total call duration">
              {formatMs(live.durationMs)}
            </span>
          )}
        </div>
        <button className="icon-btn subtle" aria-label="Toggle layout" data-testid="grpc-layout-toggle" title={layout === 'horizontal' ? 'Stack request above response' : 'Show request and response side by side'} onClick={() => void updateUi({ layout: layout === 'horizontal' ? 'vertical' : 'horizontal' })}>
          <Icon name={layout === 'horizontal' ? 'splitH' : 'split'} />
        </button>
      </div>
      {live?.error && (
        <div className="error-box" data-testid="grpc-error" data-code="PREPARE">
          <Icon name="warn" />
          <div>
            <strong>Not sent:</strong> {live.error}
          </div>
        </div>
      )}
      {st && st.code !== 0 && (
        <div className="error-box" data-testid="grpc-error" data-code={st.name}>
          <Icon name="warn" />
          <div>
            <div>
              <strong>{st.name}</strong>
              {st.details ? `: ${st.details}` : ''}
            </div>
            {live?.hint && <div className="muted small">{live.hint}</div>}
          </div>
        </div>
      )}
      <SubTabs<'messages' | 'headers' | 'trailers' | 'request'>
        testId="grpc-pane-tabs"
        value={view}
        onChange={setView}
        tabs={[
          { id: 'messages', label: 'Messages', badge: live?.log.entries.filter((e) => e.direction !== 'info').length || undefined },
          { id: 'headers', label: 'Headers', badge: live?.headers.length || undefined },
          { id: 'trailers', label: 'Trailers', badge: live?.trailers.length || undefined },
          { id: 'request', label: 'Request' }
        ]}
      />
      <div className="res-body">
        {view === 'messages' && <MessageLog testId="grpc-log" log={live?.log ?? { entries: [], bytes: 0, dropped: 0 }} onClear={() => clearLog(tabId)} elapsed empty="Invoke the method. Request and response messages appear here with their time since the call started (memory only)." />}
        {view === 'headers' && (
          <div className="scroll-pad">
            <PairsTable rows={live?.headers ?? []} testId="grpc-headers" empty="No response headers yet." />
          </div>
        )}
        {view === 'trailers' && (
          <div className="scroll-pad">
            <PairsTable rows={live?.trailers ?? []} testId="grpc-trailers" empty="No trailers yet (they arrive with the status)." />
          </div>
        )}
        {view === 'request' && (
          <div className="scroll-pad" data-testid="grpc-request">
            {live?.path ? (
              <>
                <div className="sent-line mono">
                  <strong>{live.path}</strong> <span className="muted">→ {live.target}</span> <span className="log-tag">{live.tls ? 'TLS' : 'plaintext'}</span>
                </div>
                <div className="section-title">Request metadata</div>
                <PairsTable rows={live.requestMetadata} testId="grpc-request-metadata" empty="No metadata." />
                <p className="muted small">Key Vault secrets and tokens are shown as ••••.</p>
              </>
            ) : (
              <p className="muted">Invoke to see what was sent.</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
