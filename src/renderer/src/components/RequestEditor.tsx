/** Request tab: URL bar, sub-tabs (params/auth/headers/body/scripts/settings) and the response pane. */
import { useEffect, useRef, useState } from 'react'
import { HTTP_METHODS, type KeyValue, type RequestDef, type RequestSettings } from '../../../shared/types'
import { buildUrl, splitQuery } from '../../../shared/variables'
import { cancelTab, saveTab, sendTab, updateUi } from '../actions'
import { type RequestTab, isDirty, locate, useApp } from '../store'
import { AuthEditor } from './AuthEditor'
import { BodyEditor } from './BodyEditor'
import { KeyValueGrid } from './KeyValueGrid'
import { ResponsePane } from './ResponsePane'
import { ScriptEditor } from './ScriptEditor'
import { Icon, Spinner, Splitter, SubTabs, VarInput } from './ui'

type Section = 'params' | 'auth' | 'headers' | 'body' | 'scripts' | 'settings'

const COMMON_HEADERS = ['Accept', 'Accept-Encoding', 'Accept-Language', 'Authorization', 'Cache-Control', 'Content-Type', 'Cookie', 'If-Match', 'If-None-Match', 'Origin', 'User-Agent', 'X-Request-Id', 'X-Api-Key']

/** URL bar text = base URL + enabled params. */
function displayUrl(d: RequestDef): string {
  return buildUrl(d.url, d.params)
}

/** Apply a typed URL: base + query → params (disabled rows are kept, enabled ones replaced in order). */
function applyTypedUrl(d: RequestDef, text: string): RequestDef {
  const { base, params } = splitQuery(text)
  const enabledOld = d.params.filter((p) => p.enabled)
  const merged: KeyValue[] = params.map((p, i) => ({ ...p, ...(enabledOld[i]?.description ? { description: enabledOld[i].description } : {}) }))
  // keep each disabled row at roughly its old position
  const out: KeyValue[] = []
  let ei = 0
  for (const p of d.params) {
    if (p.enabled) {
      if (ei < merged.length) out.push(merged[ei++])
    } else out.push(p)
  }
  while (ei < merged.length) out.push(merged[ei++])
  return { ...d, url: base, params: out }
}

/** Keep `:name` path variables in step with the URL. */
function syncPathVars(d: RequestDef): RequestDef {
  const names = [...d.url.replace(/^[a-z]+:\/\/[^/]*/i, '').matchAll(/\/:([A-Za-z0-9_-]+)/g)].map((m) => m[1])
  const cur = d.pathVariables
  if (names.length === cur.length && names.every((n, i) => cur[i].key === n)) return d
  return { ...d, pathVariables: names.map((n) => cur.find((p) => p.key === n) ?? { key: n, value: '', enabled: true }) }
}

export function RequestEditor({ tab }: { tab: RequestTab }): React.JSX.Element {
  const updateTab = useApp((s) => s.updateTab)
  const openDialog = useApp((s) => s.openDialog)
  const settings = useApp((s) => s.settings)
  const snapshot = useApp((s) => s.snapshot)
  const [section, setSection] = useState<Section>(() => (tab.draft.body.mode !== 'none' ? 'body' : 'params'))
  const [urlText, setUrlText] = useState<string | null>(null)
  const [editingName, setEditingName] = useState(false)
  const layout = (settings?.ui.layout as string) === 'horizontal' ? 'horizontal' : 'vertical'
  const [split, setSplit] = useState<number>(() => (typeof settings?.ui.split === 'number' ? (settings.ui.split as number) : 0.5))
  const containerRef = useRef<HTMLDivElement>(null)
  const splitRef = useRef(split)
  splitRef.current = split
  const d = tab.draft
  const set = (fn: (d: RequestDef) => RequestDef): void => updateTab(tab.id, (t) => ({ ...t, draft: fn((t as RequestTab).draft) }) as RequestTab)
  const patch = (p: Partial<RequestDef>): void => set((x) => ({ ...x, ...p }))
  const dirty = isDirty(tab)

  useEffect(() => setUrlText(null), [tab.id])

  const found = tab.collectionId && tab.requestId ? locate(tab.collectionId, tab.requestId) : undefined
  const parents = found?.parents ?? []
  const collection = snapshot?.collections.find((c) => c.collection.id === tab.collectionId)?.collection
  const parentRef = tab.collectionId ? { collectionId: tab.collectionId, itemId: parents.length ? parents[parents.length - 1].id : null } : null
  const headerCount = d.headers.filter((h) => h.enabled && h.key).length
  const paramCount = d.params.filter((p) => p.enabled && p.key).length

  return (
    <div className="request-editor" data-testid="request-editor">
      <div className="req-header">
        <div className="breadcrumb">
          {collection ? (
            <>
              <span className="crumb">{collection.name}</span>
              {parents.map((p) => (
                <span key={p.id} className="crumb">
                  {p.name}
                </span>
              ))}
            </>
          ) : (
            <span className="crumb muted">{tab.requestId ? '' : 'Unsaved request'}</span>
          )}
          {editingName ? (
            <input
              className="name-input"
              aria-label="Request name"
              autoFocus
              defaultValue={d.name}
              onBlur={(e) => {
                patch({ name: e.target.value.trim() || d.name })
                setEditingName(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setEditingName(false)
              }}
            />
          ) : (
            <button className="crumb crumb-name" title="Rename" data-testid="request-name" onClick={() => setEditingName(true)}>
              {d.name}
            </button>
          )}
          {dirty && <span className="dirty-dot" title="Unsaved changes" />}
        </div>
        <div className="req-header-actions">
          <button className="btn" data-testid="save-button" onClick={() => void saveTab(tab.id)} title="Save (⌘/Ctrl+S)">
            <Icon name="save" /> Save
          </button>
          <button className="btn" onClick={() => openDialog({ type: 'saveAs', tabId: tab.id })} data-testid="save-as-button">
            Save As…
          </button>
          <button className="btn" data-testid="code-button" onClick={() => openDialog({ type: 'snippet', tabId: tab.id })} title="Generate code">
            <Icon name="code" /> Code
          </button>
        </div>
      </div>

      <div className="url-bar">
        <select className="method-select" aria-label="HTTP method" data-testid="method-select" value={d.method} onChange={(e) => patch({ method: e.target.value })} data-method={d.method.toLowerCase()}>
          {HTTP_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <VarInput
          className="url-input"
          ariaLabel="Request URL"
          testId="url-input"
          collectionId={tab.collectionId}
          placeholder="Enter URL, e.g. {{baseUrl}}/users"
          value={urlText ?? displayUrl(d)}
          onFocus={() => setUrlText(displayUrl(d))}
          onBlur={() => setUrlText(null)}
          onChange={(v) => {
            setUrlText(v)
            set((x) => syncPathVars(applyTypedUrl(x, v)))
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) void sendTab(tab.id)
          }}
        />
        {tab.sending ? (
          <button className="btn danger send-btn" data-testid="cancel-button" onClick={() => void cancelTab(tab.id)}>
            <Spinner /> Cancel
          </button>
        ) : (
          <button className="btn primary send-btn" data-testid="send-button" onClick={() => void sendTab(tab.id)} title="Send (⌘/Ctrl+Enter)">
            <Icon name="play" size={12} /> Send
          </button>
        )}
      </div>

      <div className={`req-split ${layout}`} ref={containerRef}>
        <div className="req-pane" style={{ flexBasis: `${split * 100}%` }}>
          <SubTabs<Section>
            testId="request-sections"
            value={section}
            onChange={setSection}
            tabs={[
              { id: 'params', label: 'Params', badge: paramCount || undefined },
              { id: 'auth', label: 'Authorization', badge: d.auth.type !== 'inherit' && d.auth.type !== 'none' ? '●' : undefined },
              { id: 'headers', label: 'Headers', badge: headerCount || undefined },
              { id: 'body', label: 'Body', badge: d.body.mode !== 'none' ? '●' : undefined },
              { id: 'scripts', label: 'Scripts', badge: d.preRequestScript.trim() || d.testScript.trim() ? '●' : undefined },
              { id: 'settings', label: 'Settings' }
            ]}
          />
          <div className="section-body">
            {section === 'params' && (
              <div className="scroll-pad">
                <div className="section-title">Query params</div>
                <KeyValueGrid testId="params-grid" rows={d.params} collectionId={tab.collectionId} onChange={(params) => patch({ params })} />
                {d.pathVariables.length > 0 && (
                  <>
                    <div className="section-title">Path variables</div>
                    <KeyValueGrid testId="path-grid" rows={d.pathVariables} collectionId={tab.collectionId} allowBulk={false} onChange={(pathVariables) => patch({ pathVariables })} />
                  </>
                )}
              </div>
            )}
            {section === 'auth' && (
              <div className="scroll-pad">
                <AuthEditor auth={d.auth} onChange={(auth) => patch({ auth })} collectionId={tab.collectionId} parentRef={parentRef} allowInherit />
              </div>
            )}
            {section === 'headers' && (
              <div className="scroll-pad">
                <KeyValueGrid testId="headers-grid" rows={d.headers} collectionId={tab.collectionId} keySuggestions={COMMON_HEADERS} onChange={(headers) => patch({ headers })} />
                <p className="muted small">Content-Type, User-Agent and auth headers are added automatically at send time unless you set them here.</p>
              </div>
            )}
            {section === 'body' && <BodyEditor body={d.body} onChange={(body) => patch({ body })} collectionId={tab.collectionId} />}
            {section === 'scripts' && <ScriptEditor pre={d.preRequestScript} test={d.testScript} onChange={(p) => patch(p)} />}
            {section === 'settings' && <RequestSettingsEditor value={d.settings} onChange={(s) => patch({ settings: s })} />}
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
          onEnd={() => {
            void updateUi({ split: splitRef.current })
          }}
        />
        <div className="res-pane">
          <ResponsePane tab={tab} layout={layout} />
        </div>
      </div>
    </div>
  )
}

function TriState({ label, value, def, onChange }: { label: string; value: boolean | undefined; def: boolean; onChange: (v: boolean | undefined) => void }): React.JSX.Element {
  return (
    <>
      <label>{label}</label>
      <select aria-label={label} value={value === undefined ? 'default' : value ? 'on' : 'off'} onChange={(e) => onChange(e.target.value === 'default' ? undefined : e.target.value === 'on')}>
        <option value="default">Default ({def ? 'on' : 'off'})</option>
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    </>
  )
}

function RequestSettingsEditor({ value, onChange }: { value: RequestSettings; onChange: (s: RequestSettings) => void }): React.JSX.Element {
  const http = useApp((s) => s.settings?.http)
  const num = (k: 'maxRedirects' | 'timeoutMs', v: string): void => {
    const n = v.trim() === '' ? undefined : Math.max(0, Math.floor(Number(v)))
    const next = { ...value }
    if (n === undefined || Number.isNaN(n)) delete next[k]
    else next[k] = n
    onChange(next)
  }
  const bool = (k: 'followRedirects' | 'verifyTls', v: boolean | undefined): void => {
    const next = { ...value }
    if (v === undefined) delete next[k]
    else next[k] = v
    onChange(next)
  }
  return (
    <div className="scroll-pad">
      <div className="form-grid narrow">
        <TriState label="Follow redirects" value={value.followRedirects} def={http?.followRedirects ?? true} onChange={(v) => bool('followRedirects', v)} />
        <label>Max redirects</label>
        <input type="number" min={0} aria-label="Max redirects" placeholder={`Default (${http?.maxRedirects ?? 10})`} value={value.maxRedirects ?? ''} onChange={(e) => num('maxRedirects', e.target.value)} />
        <TriState label="Verify TLS certificates" value={value.verifyTls} def={http?.verifyTls ?? true} onChange={(v) => bool('verifyTls', v)} />
        <label>Timeout (ms)</label>
        <input type="number" min={0} aria-label="Timeout (ms)" placeholder={`Default (${http?.timeoutMs ?? 30000})`} value={value.timeoutMs ?? ''} onChange={(e) => num('timeoutMs', e.target.value)} />
      </div>
      <p className="muted small">Defaults come from Settings → Requests. 0 ms means no timeout.</p>
    </div>
  )
}
