/** Response viewer: status line, body (pretty/raw/preview + search), headers, cookies, tests, console, request. */
import { useMemo, useState } from 'react'
import type { ExecutionResult } from '../../../shared/types'
import { updateUi } from '../actions'
import type { RequestTab } from '../store'
import { CodeEditor, type CodeLanguage } from './CodeEditor'
import { OpenScriptVaultSettingButton, ReviewTeamVaultsButton } from './Editors'
import { Icon, Spinner, SubTabs, copyText, formatBytes, formatMs, statusClass } from './ui'

type View = 'body' | 'headers' | 'cookies' | 'tests' | 'console' | 'request'
type BodyView = 'pretty' | 'raw' | 'preview'

function bodyLanguage(contentType: string, body: string): CodeLanguage {
  const ct = contentType.toLowerCase()
  if (ct.includes('json')) return 'json'
  if (ct.includes('html')) return 'html'
  if (ct.includes('xml')) return 'xml'
  if (ct.includes('javascript')) return 'javascript'
  const t = body.trimStart()
  if (t.startsWith('{') || t.startsWith('[')) return 'json'
  if (t.startsWith('<')) return 'xml'
  return 'text'
}

function pretty(lang: CodeLanguage, body: string): string {
  if (lang !== 'json') return body
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

const ERROR_HINTS: Record<string, string> = {
  NETWORK: 'Check the URL, that the server is running and reachable, and proxy/VPN settings.',
  TIMEOUT: 'Increase the timeout in the request Settings tab or in Settings → Requests.',
  CANCELLED: 'The request was cancelled.',
  VAULT_ERROR: 'A Key Vault reference could not be resolved. Check the vault alias/URL in Settings → Key Vault and that you are signed in.',
  FORBIDDEN: 'Your identity lacks the role needed (Key Vault: "Key Vault Secrets User"; Storage: "Storage Blob Data Reader/Contributor").',
  NOT_FOUND: 'A referenced Key Vault secret does not exist (check the name and version).',
  NOT_CONFIGURED: 'Configure the vault alias in Settings → Key Vault (your vaults) or Settings → Teams (team vaults).',
  NOT_SIGNED_IN: 'Sign in with your Azure identity (top right) to use Entra auth or Key Vault references.',
  AUTH_FAILED: 'Token acquisition failed — check the auth settings and your sign-in.',
  SCRIPT_ERROR: 'Fix the pre-request script; see the Console tab.',
  VAULT_SCRIPT_BLOCKED: 'Declarative {{vault:…}} references in the request still work; only scripts are blocked from reading secrets.',
  VAULT_NOT_APPROVED: 'The vault comes from the team settings, which any team member with write access can change. Nothing was sent to it. Check the host, then approve it if it is one of your organisation’s Key Vaults.',
  INVALID_ARGUMENT: 'Check the URL and request fields.'
}

export function ResponsePane({ tab, layout }: { tab: RequestTab; layout: 'horizontal' | 'vertical' }): React.JSX.Element {
  const [view, setView] = useState<View>('body')
  const [bodyView, setBodyView] = useState<BodyView>('pretty')
  const [search, setSearch] = useState('')
  const r = tab.result
  const toggleLayout = (
    <button className="icon-btn subtle" aria-label="Toggle response layout" title={layout === 'horizontal' ? 'Stack request above response' : 'Show request and response side by side'} onClick={() => void updateUi({ layout: layout === 'horizontal' ? 'vertical' : 'horizontal' })}>
      <Icon name={layout === 'horizontal' ? 'splitH' : 'split'} />
    </button>
  )

  if (tab.sending)
    return (
      <div className="response empty">
        <div className="res-toolbar">
          <span className="pane-label">Response</span>
          {toggleLayout}
        </div>
        <div className="empty-center">
          <Spinner size={20} />
          <span className="muted">Sending request…</span>
        </div>
      </div>
    )
  if (!r)
    return (
      <div className="response empty" data-testid="response-empty">
        <div className="res-toolbar">
          <span className="pane-label">Response</span>
          {toggleLayout}
        </div>
        <div className="empty-center">
          <Icon name="play" size={28} className="faint" />
          <span className="muted">Send the request to see the response here.</span>
          <span className="muted small">⌘/Ctrl + Enter</span>
        </div>
      </div>
    )

  const res = r.response
  const failedTests = r.tests.filter((t) => !t.passed).length
  // A blocked pre-request script is already explained (with its action) by the error box.
  const shownScriptErrors = r.scriptErrors.filter((e) => !(e.code === 'VAULT_SCRIPT_BLOCKED' && r.error?.code === 'VAULT_SCRIPT_BLOCKED'))
  return (
    <div className="response" data-testid="response">
      <div className="res-toolbar">
        <span className="pane-label">Response</span>
        {res ? (
          <div className="res-meta">
            <span className={`status-pill ${statusClass(res.status)}`} data-testid="response-status">
              {res.status} {res.statusText}
            </span>
            <span className="meta-item" data-testid="response-time" title="Total time including redirects">
              {formatMs(res.timeMs)}
            </span>
            <span className="meta-item" data-testid="response-size" title={`Body ${formatBytes(res.sizeBytes)}, headers ${formatBytes(res.headersSizeBytes)}`}>
              {formatBytes(res.sizeBytes)}
            </span>
            {res.redirects.length > 0 && <span className="meta-item" title={res.redirects.map((x) => `${x.status} → ${x.url}`).join('\n')}>{res.redirects.length} redirect(s)</span>}
          </div>
        ) : (
          <div className="res-meta">
            <span className="status-pill st-server" data-testid="response-status">
              {r.error?.code ?? 'Error'}
            </span>
          </div>
        )}
        {toggleLayout}
      </div>
      {r.error && <ErrorBox r={r} collectionId={tab.collectionId} />}
      {shownScriptErrors.length > 0 && (
        <div className="error-box" data-testid="script-errors">
          <Icon name="warn" />
          <div>
            {shownScriptErrors.map((e, i) => (
              <div key={i}>
                <strong>
                  {e.source.phase === 'pre-request' ? 'Pre-request' : 'Post-response'} script error ({e.source.level} “{e.source.name}”):
                </strong>{' '}
                {e.message}
                {e.code === 'VAULT_SCRIPT_BLOCKED' && (
                  <div className="error-actions">
                    <OpenScriptVaultSettingButton collectionId={tab.collectionId} />
                  </div>
                )}
                {e.code === 'VAULT_NOT_APPROVED' && r.error?.code !== 'VAULT_NOT_APPROVED' && (
                  <div className="error-actions">
                    <ReviewTeamVaultsButton collectionId={tab.collectionId} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <SubTabs<View>
        testId="response-tabs"
        value={view}
        onChange={setView}
        tabs={[
          { id: 'body', label: 'Body' },
          { id: 'headers', label: 'Headers', badge: res?.headers.length || undefined },
          { id: 'cookies', label: 'Cookies', badge: res?.cookies.length || undefined },
          { id: 'tests', label: r.tests.length ? `Tests ${r.tests.length - failedTests}/${r.tests.length}` : 'Tests', badge: failedTests ? `${failedTests} failed` : undefined },
          { id: 'console', label: 'Console', badge: r.console.length + r.scriptErrors.length || undefined },
          { id: 'request', label: 'Request' }
        ]}
      />
      <div className="res-body">
        {view === 'body' && (res ? <BodyView r={r} view={bodyView} setView={setBodyView} search={search} setSearch={setSearch} /> : <p className="muted pad">No response body.</p>)}
        {view === 'headers' && res && <PairTable rows={res.headers} testId="response-headers" />}
        {view === 'cookies' && res && (
          <div className="scroll-pad">
            {res.cookies.length === 0 ? (
              <p className="muted">No cookies were set by this response.</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Value</th>
                    <th>Domain</th>
                    <th>Path</th>
                    <th>Expires</th>
                    <th>Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {res.cookies.map((c, i) => (
                    <tr key={i}>
                      <td className="mono">{c.name}</td>
                      <td className="mono break">{c.value}</td>
                      <td>{c.domain ?? ''}</td>
                      <td>{c.path ?? ''}</td>
                      <td>{c.expires ?? 'Session'}</td>
                      <td>{[c.httpOnly && 'HttpOnly', c.secure && 'Secure', c.sameSite && `SameSite=${c.sameSite}`].filter(Boolean).join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
        {view === 'tests' && <TestsView r={r} />}
        {view === 'console' && <ConsoleView r={r} />}
        {view === 'request' && (
          <div className="scroll-pad">
            <div className="sent-line mono">
              <strong>{r.request.method}</strong> <span className="break">{r.request.url}</span>
            </div>
            <PairTable rows={r.request.headers} testId="sent-headers" />
            {r.request.bodyPreview && <pre className="pre-box mono">{r.request.bodyPreview}</pre>}
            <p className="muted small">Key Vault secrets and tokens are shown as ••••.</p>
          </div>
        )}
      </div>
    </div>
  )
}

function ErrorBox({ r, collectionId }: { r: ExecutionResult; collectionId: string | null }): React.JSX.Element {
  const code = r.error?.code ?? ''
  if (code === 'VAULT_SCRIPT_BLOCKED')
    return (
      <div className="error-box" data-testid="response-error" data-code={code}>
        <Icon name="warn" />
        <div>
          <div>
            <strong>Scripts may not read Key Vault secrets here:</strong> {r.error?.message}
          </div>
          <div className="muted small">{ERROR_HINTS[code]}</div>
          <div className="error-actions">
            <OpenScriptVaultSettingButton collectionId={collectionId} />
          </div>
        </div>
      </div>
    )
  if (code === 'VAULT_NOT_APPROVED')
    return (
      <div className="error-box" data-testid="response-error" data-code={code}>
        <Icon name="warn" />
        <div>
          <div>
            <strong>Team Key Vault not approved on this machine:</strong> {r.error?.message}
          </div>
          <div className="muted small">{ERROR_HINTS[code]}</div>
          <div className="error-actions">
            <ReviewTeamVaultsButton collectionId={collectionId} />
          </div>
        </div>
      </div>
    )
  return (
    <div className="error-box" data-testid="response-error" data-code={code}>
      <Icon name="warn" />
      <div>
        <div>
          <strong>{code === 'VAULT_ERROR' || code === 'FORBIDDEN' || code === 'NOT_CONFIGURED' ? 'Could not resolve Key Vault reference' : code === 'TIMEOUT' ? 'Request timed out' : code === 'CANCELLED' ? 'Cancelled' : 'Could not send request'}:</strong> {r.error?.message}
        </div>
        {ERROR_HINTS[code] && <div className="muted small">{ERROR_HINTS[code]}</div>}
      </div>
    </div>
  )
}

function PairTable({ rows, testId }: { rows: [string, string][]; testId: string }): React.JSX.Element {
  return (
    <div className="scroll-pad">
      <table className="data-table" data-testid={testId}>
        <thead>
          <tr>
            <th style={{ width: '32%' }}>Key</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, v], i) => (
            <tr key={i}>
              <td className="mono">{k}</td>
              <td className="mono break">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function BodyView({ r, view, setView, search, setSearch }: { r: ExecutionResult; view: BodyView; setView: (v: BodyView) => void; search: string; setSearch: (s: string) => void }): React.JSX.Element {
  const res = r.response!
  const lang = bodyLanguage(res.contentType, res.bodyText)
  const prettyText = useMemo(() => pretty(lang, res.bodyText), [lang, res.bodyText])
  const isImage = res.contentType.toLowerCase().startsWith('image/') && !!res.bodyBase64
  const isHtml = lang === 'html'
  const canPreview = isImage || isHtml
  const effective: BodyView = view === 'preview' && !canPreview ? 'pretty' : view
  const text = effective === 'raw' ? res.bodyText : prettyText
  const matches = useMemo(() => {
    if (!search) return 0
    const hay = text.toLowerCase()
    const q = search.toLowerCase()
    let n = 0
    for (let i = hay.indexOf(q); i >= 0 && n < 10000; i = hay.indexOf(q, i + q.length)) n++
    return n
  }, [text, search])
  return (
    <div className="body-view">
      <div className="body-view-bar">
        <div className="seg" role="radiogroup" aria-label="Body view">
          {(['pretty', 'raw', ...(canPreview ? ['preview'] : [])] as BodyView[]).map((v) => (
            <button key={v} role="radio" aria-checked={effective === v} className={`seg-btn ${effective === v ? 'on' : ''}`} onClick={() => setView(v)}>
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        <span className="muted small">{lang.toUpperCase()}</span>
        <div className="grow" />
        {effective !== 'preview' && (
          <div className="search-box">
            <Icon name="search" size={12} />
            <input aria-label="Search response body" data-testid="body-search" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
            {search && <span className="muted small">{matches}</span>}
          </div>
        )}
        <button className="icon-btn subtle" aria-label="Copy response body" title="Copy body" onClick={() => void copyText(res.bodyText, 'Response body copied')}>
          <Icon name="copy" />
        </button>
      </div>
      {res.truncated && (
        <div className="warn-box small" data-testid="truncated">
          <Icon name="warn" size={12} /> Body truncated for display ({formatBytes(res.sizeBytes)} received). Raise the limit in Settings → Requests to see more.
        </div>
      )}
      <div className="body-view-content" data-testid="response-body">
        {effective === 'preview' ? (
          isImage ? (
            <div className="image-preview">
              <img alt="Response preview" src={`data:${res.contentType.split(';')[0]};base64,${res.bodyBase64}`} />
            </div>
          ) : (
            <iframe className="html-preview" title="HTML preview" sandbox="" srcDoc={res.bodyText} />
          )
        ) : (
          <CodeEditor value={text} readOnly language={effective === 'raw' ? 'text' : lang} search={search} ariaLabel="Response body" wrap={effective === 'raw'} />
        )}
      </div>
    </div>
  )
}

function TestsView({ r }: { r: ExecutionResult }): React.JSX.Element {
  const [filter, setFilter] = useState<'all' | 'passed' | 'failed'>('all')
  const passed = r.tests.filter((t) => t.passed).length
  const failed = r.tests.length - passed
  const shown = r.tests.filter((t) => filter === 'all' || (filter === 'passed' ? t.passed : !t.passed))
  if (!r.tests.length) return <p className="muted pad">No tests ran. Add pm.test(...) calls in the Post-response script.</p>
  return (
    <div className="scroll-pad">
      <div className="tests-summary" data-testid="tests-summary">
        <div className="seg" role="radiogroup" aria-label="Filter tests">
          {(['all', 'passed', 'failed'] as const).map((f) => (
            <button key={f} role="radio" aria-checked={filter === f} className={`seg-btn ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
              {f === 'all' ? `All (${r.tests.length})` : f === 'passed' ? `Passed (${passed})` : `Failed (${failed})`}
            </button>
          ))}
        </div>
      </div>
      <ul className="test-list">
        {shown.map((t, i) => (
          <li key={i} className={`test ${t.passed ? 'pass' : 'fail'}`} data-testid="test-result" data-passed={t.passed}>
            <span className={`test-badge ${t.passed ? 'pass' : 'fail'}`}>{t.passed ? 'PASS' : 'FAIL'}</span>
            <span className="test-name">{t.name}</span>
            {t.error && <span className="test-error">{t.error}</span>}
            <span className="muted small test-src">{t.source.level !== 'request' ? `${t.source.level}: ${t.source.name}` : ''}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ConsoleView({ r }: { r: ExecutionResult }): React.JSX.Element {
  if (!r.console.length && !r.scriptErrors.length && !r.mutations.length) return <p className="muted pad">No console output. Use console.log(...) in scripts.</p>
  return (
    <div className="scroll-pad console" data-testid="console">
      {r.console.map((c, i) => (
        <div key={i} className={`console-line lvl-${c.level}`}>
          <span className="console-src">{c.source.phase === 'pre-request' ? 'pre' : 'test'}</span>
          <span className="mono break">{c.message}</span>
        </div>
      ))}
      {r.scriptErrors.map((e, i) => (
        <div key={`e${i}`} className="console-line lvl-error">
          <span className="console-src">{e.source.phase === 'pre-request' ? 'pre' : 'test'}</span>
          <span className="mono break">{e.message}</span>
        </div>
      ))}
      {r.mutations.length > 0 && (
        <>
          <div className="section-title">Variable changes</div>
          {r.mutations.map((m, i) => (
            <div key={`m${i}`} className="console-line lvl-info">
              <span className="console-src">{m.scope}</span>
              <span className="mono break">
                {m.action === 'set' ? `${m.key} = ${m.value ?? ''}` : `unset ${m.key}`}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
