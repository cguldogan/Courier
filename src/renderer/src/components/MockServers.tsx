/** Mock servers tab: collections with example counts, start/stop, port, base URL, settings, live log. */
import { useEffect, useMemo, useState } from 'react'
import type { MockSettings } from '../../../shared/api'
import type { Collection } from '../../../shared/types'
import { walkItems } from '../../../shared/types'
import { attempt, courier } from '../api'
import { openExample, reloadMocks, startMock, stopMock, useMockUrl } from '../actions'
import { type MocksTab, useApp } from '../store'
import { Icon, LocationBadge, MethodBadge, Spinner, copyText, formatMs, statusClass } from './ui'

export function exampleCount(c: Collection): number {
  let n = 0
  for (const { item } of walkItems(c.items)) if (item.type === 'request') n += item.examples?.length ?? 0
  return n
}

const NO_ENVS: never[] = []
const DEFAULTS: MockSettings = { port: 0, delayMs: 0, cors: true, substituteVariables: true, environmentId: null }

export function MockServersPanel({ tab }: { tab: MocksTab }): React.JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const mocks = useApp((s) => s.mocks)
  const updateTab = useApp((s) => s.updateTab)
  const cols = snapshot?.collections ?? []
  const selected = cols.find((c) => c.collection.id === tab.collectionId)
  return (
    <div className="runner mocks" data-testid="mock-servers">
      <div className="runner-config mocks-list">
        <h2 className="panel-title">
          <Icon name="server" size={14} /> Mock servers
        </h2>
        <p className="muted small">
          Serve a collection&apos;s saved examples on this machine (127.0.0.1 only). Save a response as an example from a request&apos;s response pane first.
        </p>
        <ul className="mock-collections" role="listbox" aria-label="Collections">
          {cols.length === 0 && <li className="muted">No collections yet.</li>}
          {cols.map((e) => {
            const info = mocks.find((m) => m.collectionId === e.collection.id)
            const n = exampleCount(e.collection)
            return (
              <li
                key={e.collection.id}
                role="option"
                aria-selected={tab.collectionId === e.collection.id}
                tabIndex={0}
                className={`mock-collection ${tab.collectionId === e.collection.id ? 'active' : ''}`}
                data-testid="mock-collection"
                data-name={e.collection.name}
                onClick={() => updateTab(tab.id, (t) => ({ ...t, collectionId: e.collection.id }) as MocksTab)}
                onKeyDown={(ev) => ev.key === 'Enter' && updateTab(tab.id, (t) => ({ ...t, collectionId: e.collection.id }) as MocksTab)}
              >
                <LocationBadge teamId={e.sync.teamId} />
                <span className="ellipsis grow">{e.collection.name}</span>
                <span className="muted small">{n} example{n === 1 ? '' : 's'}</span>
                {info?.running && (
                  <span className="mock-live" title={`Running at ${info.url}`} data-testid="mock-running-badge">
                    :{info.port}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      </div>
      <div className="runner-results">
        {selected ? <MockDetail key={selected.collection.id} collection={selected.collection} /> : (
          <div className="empty-center">
            <Icon name="server" size={28} className="faint" />
            <span className="muted">Choose a collection.</span>
          </div>
        )}
      </div>
    </div>
  )
}

function MockDetail({ collection }: { collection: Collection }): React.JSX.Element {
  const info = useApp((s) => s.mocks.find((m) => m.collectionId === collection.id))
  const log = useApp((s) => s.mockLogs[collection.id])
  const envs = useApp((s) => s.snapshot?.environments ?? NO_ENVS)
  const settings = info?.settings ?? DEFAULTS
  const running = !!info?.running
  const [port, setPort] = useState(String(settings.port || ''))
  const [busy, setBusy] = useState(false)
  const n = exampleCount(collection)
  useEffect(() => {
    void attempt(courier().mocks.log(collection.id), { quiet: true }).then((entries) => {
      if (entries) useApp.setState((s) => ({ mockLogs: { ...s.mockLogs, [collection.id]: entries } }))
    })
  }, [collection.id, running])
  const update = async (patch: Partial<MockSettings>): Promise<void> => {
    if (await attempt(courier().mocks.update({ collectionId: collection.id, settings: patch }))) await reloadMocks()
  }
  const examples = useMemo(() => {
    const out: { requestId: string; exampleId: string; method: string; name: string; status: number }[] = []
    for (const { item } of walkItems(collection.items))
      if (item.type === 'request') for (const e of item.examples ?? []) out.push({ requestId: item.id, exampleId: e.id, method: e.request.method, name: e.name, status: e.response.status })
    return out
  }, [collection])
  return (
    <div className="mock-detail" data-testid="mock-detail" data-running={running}>
      <div className="mock-head">
        <h3 className="mock-title">{collection.name}</h3>
        <span className={`mock-state ${running ? 'on' : ''}`} data-testid="mock-state">
          {running ? 'Running' : 'Stopped'}
        </span>
        <div className="grow" />
        {running ? (
          <button className="btn danger" data-testid="mock-stop" onClick={() => void stopMock(collection.id)}>
            <Icon name="stop" size={12} /> Stop
          </button>
        ) : (
          <button
            className="btn primary"
            data-testid="mock-start"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              const p = Math.floor(Number(port) || 0)
              if (p !== settings.port) await update({ port: p })
              await startMock(collection.id)
              setBusy(false)
            }}
          >
            {busy ? <Spinner /> : <Icon name="play" size={12} />} Start
          </button>
        )}
      </div>
      {running && info?.url && (
        <div className="mock-url-row">
          <span className="muted small">Base URL</span>
          <code className="mock-url" data-testid="mock-url">
            {info.url}
          </code>
          <button className="icon-btn" aria-label="Copy mock URL" data-testid="mock-copy-url" title="Copy" onClick={() => void copyText(info.url ?? '', 'Mock URL copied')}>
            <Icon name="copy" />
          </button>
          <button className="btn small" data-testid="mock-use-url" title="Set the collection variable {{mockUrl}} to this URL" onClick={() => void useMockUrl(collection.id, info.url ?? '')}>
            Use as {'{{mockUrl}}'}
          </button>
        </div>
      )}
      {n === 0 && <div className="info-box small">This collection has no saved examples yet: every request gets a 404 that lists what was tried. Send a request and use “Save as example” in the response pane.</div>}
      <div className="form-grid narrow mock-settings">
        <label htmlFor="mock-port">Port</label>
        <div className="row-gap">
          <input id="mock-port" type="number" min={0} max={65535} aria-label="Port" data-testid="mock-port" placeholder="any free port" value={running ? String(info?.port ?? '') : port} disabled={running} onChange={(e) => setPort(e.target.value)} onBlur={() => void update({ port: Math.floor(Number(port) || 0) })} />
          <span className="muted small">{running ? 'Stop the server to change the port.' : 'Empty or 0: any free port. 127.0.0.1 only.'}</span>
        </div>
        <label htmlFor="mock-delay">Delay (ms)</label>
        <input id="mock-delay" type="number" min={0} max={60000} aria-label="Delay (ms)" data-testid="mock-delay" value={settings.delayMs} onChange={(e) => void update({ delayMs: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
        <span />
        <label className="check">
          <input type="checkbox" data-testid="mock-cors" checked={settings.cors} onChange={(e) => void update({ cors: e.target.checked })} /> CORS headers and preflight answers
        </label>
        <span />
        <label className="check">
          <input type="checkbox" data-testid="mock-vars" checked={settings.substituteVariables} onChange={(e) => void update({ substituteVariables: e.target.checked })} /> Substitute {'{{variables}}'} in example bodies and headers
        </label>
        <label htmlFor="mock-env">Environment</label>
        <select id="mock-env" aria-label="Environment for substitution" data-testid="mock-env" value={settings.environmentId ?? ''} disabled={!settings.substituteVariables} onChange={(e) => void update({ environmentId: e.target.value || null })}>
          <option value="">No environment</option>
          {envs.map((e) => (
            <option key={e.environment.id} value={e.environment.id}>
              {e.environment.name}
            </option>
          ))}
        </select>
      </div>
      <p className="muted small mock-note" data-testid="mock-vault-note">
        Key Vault references are never resolved by the mock server: they, and Key Vault or secret-typed variables, are served as ••••. Only plain shared variable values are substituted.
        {settings.cors ? ' With CORS on, web pages open in your browser can read these mock responses while the server runs.' : ''} Matching: method + path, then the x-mock-response-id / -name / -code headers, then query parameters, then the most specific path.
      </p>
      <div className="section-title">
        Examples ({examples.length})
      </div>
      <ul className="mock-examples">
        {examples.slice(0, 200).map((e) => (
          <li key={e.exampleId}>
            <MethodBadge method={e.method} short />
            <button className="link-btn small ellipsis" onClick={() => openExample(collection.id, e.requestId, e.exampleId)}>
              {e.name}
            </button>
            <span className={`status-mini ${statusClass(e.status)}`}>{e.status}</span>
          </li>
        ))}
      </ul>
      <div className="section-title">
        Request log <span className="muted small">(this session only)</span>
        <span className="grow" />
        <button
          className="link-btn small"
          data-testid="mock-clear-log"
          disabled={!log?.length}
          onClick={async () => {
            if (await attempt(courier().mocks.clearLog(collection.id))) useApp.setState((s) => ({ mockLogs: { ...s.mockLogs, [collection.id]: [] } }))
          }}
        >
          Clear
        </button>
      </div>
      <table className="data-table mock-log" data-testid="mock-log">
        <thead>
          <tr>
            <th>Time</th>
            <th>Request</th>
            <th>Answered with</th>
            <th>Status</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {!log?.length && (
            <tr>
              <td colSpan={5} className="muted">
                {running ? 'Waiting for requests…' : 'No requests yet.'}
              </td>
            </tr>
          )}
          {[...(log ?? [])].reverse().map((l) => (
            <tr key={l.seq} data-testid="mock-log-row" data-status={l.status}>
              <td className="muted small">{new Date(l.at).toLocaleTimeString()}</td>
              <td className="mono small break">
                <MethodBadge method={l.method} short /> {l.path}
              </td>
              <td className="small">{l.example ? l.example.name : <span className="muted">{l.note ?? 'no match'}</span>}</td>
              <td>
                <span className={`status-mini ${statusClass(l.status)}`}>{l.status}</span>
              </td>
              <td className="small">{formatMs(l.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
