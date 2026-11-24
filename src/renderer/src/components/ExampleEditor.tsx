/** Saved response examples: the example tab (request read-only, response editable) and "Save as example". */
import { useMemo, useState } from 'react'
import { EXAMPLE_BODY_MAX_CHARS, isSensitiveResponseHeader } from '../../../shared/examples'
import type { KeyValue, RawLanguage } from '../../../shared/types'
import { buildUrl } from '../../../shared/variables'
import { attempt, courier } from '../api'
import { openExample, openMocks, openRequest, reloadWorkspace } from '../actions'
import { type DialogSpec, type ExampleTab, type RequestTab, useApp } from '../store'
import { CodeEditor } from './CodeEditor'
import { SaveBar } from './Editors'
import { KeyValueGrid } from './KeyValueGrid'
import { Icon, MethodBadge, Modal, Spinner, SubTabs, formatBytes, statusClass } from './ui'

const LANGS: RawLanguage[] = ['json', 'xml', 'html', 'javascript', 'text']

export function ExampleEditor({ tab }: { tab: ExampleTab }): React.JSX.Element {
  const updateTab = useApp((s) => s.updateTab)
  const request = useApp((s) => {
    const c = s.snapshot?.collections.find((x) => x.collection.id === tab.collectionId)?.collection
    const walk = (items: NonNullable<typeof c>['items']): { name: string } | undefined => {
      for (const it of items) {
        if (it.id === tab.requestId) return it
        if (it.type === 'folder') {
          const r = walk(it.items)
          if (r) return r
        }
      }
      return undefined
    }
    return c ? walk(c.items) : undefined
  })
  const [view, setView] = useState<'body' | 'headers'>('body')
  const [reqView, setReqView] = useState<'params' | 'headers' | 'body'>('params')
  const d = tab.draft
  const res = d.response
  const patch = (fn: (x: ExampleTab['draft']) => ExampleTab['draft']): void => updateTab(tab.id, (t) => ({ ...t, draft: fn((t as ExampleTab).draft) }) as ExampleTab)
  const setRes = (p: Partial<typeof res>): void => patch((x) => ({ ...x, response: { ...x.response, ...p } }))
  const body = d.request.body
  const reqBody = body.mode === 'raw' ? body.raw : body.mode === 'graphql' ? body.graphql.query : body.mode === 'urlencoded' ? body.urlencoded.map((p) => `${p.key}=${p.value}`).join('&') : body.mode === 'formdata' ? body.formdata.map((f) => `${f.key}=${f.kind === 'file' ? '(file)' : f.value}`).join('\n') : body.mode === 'binary' ? '(binary file, not stored with the example)' : ''
  const binaryBytes = res.bodyBase64 !== undefined ? Math.floor((res.bodyBase64.length * 3) / 4) : 0
  return (
    <div className="doc-editor example-editor" data-testid="example-editor">
      <div className="doc-header">
        <Icon name="file" size={16} />
        <input className="title-input" aria-label="Example name" data-testid="example-name" value={d.name} onChange={(e) => patch((x) => ({ ...x, name: e.target.value }))} />
        <span className="doc-meta small">
          Example of{' '}
          <button className="link-btn small" onClick={() => openRequest(tab.collectionId, tab.requestId)}>
            {request?.name ?? 'a deleted request'}
          </button>
        </span>
        <div className="grow" />
        <SaveBar tab={tab}>
          <button className="btn" data-testid="example-open-mocks" onClick={() => openMocks(tab.collectionId)} title="Serve this collection's examples on a local mock server">
            <Icon name="server" size={12} /> Mock server
          </button>
        </SaveBar>
      </div>
      <div className="example-split">
        <section className="example-pane" aria-label="Request (read-only)">
          <div className="pane-label">Request <span className="muted small">(as sent, read-only)</span></div>
          <div className="example-url mono" data-testid="example-request-line">
            <MethodBadge method={d.request.method} /> <span className="break">{buildUrl(d.request.url, d.request.params)}</span>
          </div>
          <SubTabs
            value={reqView}
            onChange={setReqView}
            tabs={[
              { id: 'params', label: 'Params', badge: d.request.params.length || undefined },
              { id: 'headers', label: 'Headers', badge: d.request.headers.length || undefined },
              { id: 'body', label: 'Body', badge: body.mode !== 'none' ? body.mode : undefined }
            ]}
          />
          <div className="example-pane-body">
            {reqView === 'params' && <ReadOnlyPairs rows={d.request.params} empty="No query parameters." />}
            {reqView === 'headers' && <ReadOnlyPairs rows={d.request.headers} empty="No headers." testId="example-request-headers" />}
            {reqView === 'body' && (reqBody ? <pre className="pre-box mono">{reqBody}</pre> : <p className="muted pad">No body.</p>)}
            <p className="muted small pad">Templates are kept as written ({'{{variables}}'} unresolved), so no resolved secret is stored.</p>
          </div>
        </section>
        <section className="example-pane" aria-label="Response">
          <div className="example-status-row">
            <span className="pane-label">Response</span>
            <label className="small muted" htmlFor="ex-status">
              Status
            </label>
            <input id="ex-status" className={`status-input mono ${statusClass(res.status)}`} type="number" min={100} max={599} aria-label="Status code" data-testid="example-status" value={res.status} onChange={(e) => setRes({ status: Math.min(599, Math.max(100, Math.floor(Number(e.target.value) || 200))) })} />
            <input className="status-text" aria-label="Status text" data-testid="example-status-text" placeholder="OK" value={res.statusText} onChange={(e) => setRes({ statusText: e.target.value })} />
            <div className="grow" />
            <select aria-label="Body language" value={res.language} onChange={(e) => setRes({ language: e.target.value as RawLanguage })}>
              {LANGS.map((l) => (
                <option key={l} value={l}>
                  {l.toUpperCase()}
                </option>
              ))}
            </select>
          </div>
          <SubTabs value={view} onChange={setView} tabs={[{ id: 'body', label: 'Body' }, { id: 'headers', label: 'Headers', badge: res.headers.length || undefined }]} />
          <div className="example-pane-body">
            {res.truncated && (
              <div className="warn-box small" data-testid="example-truncated">
                <Icon name="warn" size={12} /> The body was cut to the example size limit when it was saved.
              </div>
            )}
            {view === 'body' &&
              (res.bodyBase64 !== undefined ? (
                <div className="pad">
                  <p className="muted">Binary body ({formatBytes(binaryBytes)}), stored as base64. It is served as is by the mock server and cannot be edited here.</p>
                  <button className="btn small" onClick={() => setRes({ bodyBase64: undefined, body: '' })}>
                    Replace with an empty text body
                  </button>
                </div>
              ) : (
                <div className="example-body">
                  <CodeEditor value={res.body} onChange={(v) => setRes({ body: v.slice(0, EXAMPLE_BODY_MAX_CHARS) })} language={res.language} ariaLabel="Example response body" testId="example-body" />
                </div>
              ))}
            {view === 'headers' && (
              <div className="scroll-pad">
                <KeyValueGrid rows={res.headers} onChange={(rows: KeyValue[]) => setRes({ headers: rows })} testId="example-headers" />
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function ReadOnlyPairs({ rows, empty, testId }: { rows: KeyValue[]; empty: string; testId?: string }): React.JSX.Element {
  if (!rows.length) return <p className="muted pad">{empty}</p>
  return (
    <table className="data-table" data-testid={testId}>
      <thead>
        <tr>
          <th style={{ width: '36%' }}>Key</th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={r.enabled ? '' : 'disabled'}>
            <td className="mono">{r.key}</td>
            <td className="mono break">{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** "Save as example" for a request tab's last response. */
export function SaveExampleDialog({ spec, onClose }: { spec: Extract<DialogSpec, { type: 'saveExample' }>; onClose: () => void }): React.JSX.Element {
  const tab = useApp((s) => s.tabs.find((t) => t.id === spec.tabId)) as RequestTab | undefined
  const res = tab?.result?.response
  const [name, setName] = useState(() => (res ? `${res.status} ${res.statusText}`.trim() : 'Example'))
  const sensitive = useMemo(() => {
    const seen = new Map<string, string>()
    for (const [k] of res?.headers ?? []) if (isSensitiveResponseHeader(k) && !seen.has(k.toLowerCase())) seen.set(k.toLowerCase(), k)
    return [...seen.values()]
  }, [res])
  const [keep, setKeep] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const tooLong = !!res && res.bodyBase64 === undefined && res.bodyText.length > EXAMPLE_BODY_MAX_CHARS
  const save = async (): Promise<void> => {
    if (!tab?.collectionId || !tab.requestId || !tab.result) return
    setBusy(true)
    const r = await attempt(
      courier().examples.saveResponse({ executionId: tab.result.executionId, collectionId: tab.collectionId, requestId: tab.requestId, name, keepHeaders: sensitive.filter((h) => keep[h.toLowerCase()]) }),
      { context: 'Save as example' }
    )
    setBusy(false)
    if (!r) return
    await reloadWorkspace()
    useApp.getState().set({ expanded: { ...useApp.getState().expanded, [tab.requestId]: true } })
    useApp.getState().toast('success', `Saved example "${r.example.name}"${r.stripped.length ? ` (left out: ${r.stripped.join(', ')})` : ''}`)
    if (r.truncatedNote) useApp.getState().toast('info', r.truncatedNote)
    onClose()
    openExample(tab.collectionId, tab.requestId, r.example.id)
  }
  return (
    <Modal
      title="Save response as example"
      onClose={onClose}
      width={520}
      testId="save-example-dialog"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" data-testid="save-example-confirm" disabled={busy || !name.trim() || !res} onClick={() => void save()}>
            {busy && <Spinner />} Save example
          </button>
        </>
      }
    >
      <div className="form-stack">
        <label className="field-label" htmlFor="ex-name">
          Name
        </label>
        <input id="ex-name" autoFocus data-testid="save-example-name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} />
        <p className="muted small">
          The request is stored as written ({'{{variables}}'} and {'{{vault:…}}'} unresolved) with the response as shown here: Key Vault values, tokens and secret-typed variable values are stored masked as ••••. The example is saved in the collection and synced with it.
        </p>
        {sensitive.length > 0 && (
          <div className="warn-box small" data-testid="save-example-stripped">
            <div>
              <strong>Left out by default</strong> — these response headers usually carry session cookies or credentials. Tick one only if it holds nothing secret:
            </div>
            {sensitive.map((h) => (
              <label key={h} className="check">
                <input type="checkbox" aria-label={`Keep header ${h}`} data-testid="keep-header" data-header={h} checked={!!keep[h.toLowerCase()]} onChange={(e) => setKeep({ ...keep, [h.toLowerCase()]: e.target.checked })} /> Keep <code>{h}</code>
              </label>
            ))}
          </div>
        )}
        {(tooLong || res?.truncated) && (
          <div className="info-box small">The body is {res?.truncated ? 'already truncated for display' : `longer than ${EXAMPLE_BODY_MAX_CHARS.toLocaleString()} characters`}; the example keeps a truncated copy and says so.</div>
        )}
      </div>
    </Modal>
  )
}
