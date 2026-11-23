/** Generic and small dialogs: prompt, confirm, secret warnings, Save As, code snippet, import, export, cookies. */
import { useEffect, useMemo, useState } from 'react'
import type { ExportFormat, ImportResult } from '../../../shared/api'
import type { CookieInfo, Item, SecretFinding, SnippetLanguage, Space } from '../../../shared/types'
import { attempt, courier } from '../api'
import { openDraft, reloadWorkspace, saveRequestTo, spaceLabel } from '../actions'
import { type DialogSpec, type RequestTab, locate, useApp } from '../store'
import { CodeEditor } from './CodeEditor'
import { Icon, Modal, Spinner, copyText } from './ui'

type Spec<T extends DialogSpec['type']> = Extract<DialogSpec, { type: T }>

function useBusy(): [boolean, (fn: () => Promise<unknown> | unknown) => Promise<void>] {
  const [busy, setBusy] = useState(false)
  return [
    busy,
    async (fn) => {
      setBusy(true)
      try {
        await fn()
      } finally {
        setBusy(false)
      }
    }
  ]
}

export function SpaceSelect({ value, onChange, id }: { value: Space; onChange: (s: Space) => void; id?: string }): React.JSX.Element {
  const sync = useApp((s) => s.sync)
  const signedIn = useApp((s) => s.identity?.signedIn)
  const cloud = !!(sync?.configured && signedIn)
  return (
    <select id={id} aria-label="Space" value={value} onChange={(e) => onChange(e.target.value as Space)}>
      <option value="local">Local — this machine only</option>
      <option value="personal" disabled={!cloud}>
        Personal — your prefix in team storage{cloud ? '' : ' (sign in + configure storage)'}
      </option>
      <option value="shared" disabled={!cloud}>
        Shared — the team space{cloud ? '' : ' (sign in + configure storage)'}
      </option>
    </select>
  )
}

export function PromptDialog({ spec, onClose }: { spec: Spec<'prompt'>; onClose: () => void }): React.JSX.Element {
  const [value, setValue] = useState(spec.initial ?? '')
  const [space, setSpace] = useState<Space>('local')
  const [busy, run] = useBusy()
  const submit = (): void => {
    if (!value.trim()) return
    void run(async () => {
      await spec.onSubmit(value.trim(), spec.spaceChoice ? space : undefined)
      onClose()
    })
  }
  return (
    <Modal
      title={spec.title}
      onClose={onClose}
      width={420}
      testId="prompt-dialog"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" data-testid="prompt-confirm" disabled={busy || !value.trim()} onClick={submit}>
            {busy && <Spinner />} {spec.confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      <div className="form-stack">
        <label className="field-label" htmlFor="prompt-input">
          {spec.label}
        </label>
        <input
          id="prompt-input"
          autoFocus
          data-testid="prompt-input"
          value={value}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
        {spec.spaceChoice && (
          <>
            <label className="field-label" htmlFor="prompt-space">
              Space
            </label>
            <SpaceSelect id="prompt-space" value={space} onChange={setSpace} />
          </>
        )}
      </div>
    </Modal>
  )
}

export function ConfirmDialog({ spec, onClose }: { spec: Spec<'confirm'>; onClose: () => void }): React.JSX.Element {
  const [busy, run] = useBusy()
  return (
    <Modal
      title={spec.title}
      onClose={onClose}
      width={440}
      testId="confirm-dialog"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          {spec.alt && (
            <button
              className="btn"
              onClick={() =>
                void run(async () => {
                  onClose()
                  await spec.alt?.onClick()
                })
              }
            >
              {spec.alt.label}
            </button>
          )}
          <button
            className={`btn ${spec.danger ? 'danger' : 'primary'}`}
            data-testid="confirm-button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                onClose()
                await spec.onConfirm()
              })
            }
          >
            {spec.confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      <p>{spec.message}</p>
    </Modal>
  )
}

export function FindingsList({ findings }: { findings: SecretFinding[] }): React.JSX.Element {
  return (
    <ul className="findings" data-testid="findings">
      {findings.map((f, i) => (
        <li key={i}>
          <div>
            <Icon name="warn" size={12} className="warn-icon" /> <strong>{f.location}</strong> <code className="small">{f.preview}</code>
          </div>
          <div className="muted small">{f.suggestion}</div>
        </li>
      ))}
    </ul>
  )
}

export function WarningsDialog({ spec, onClose }: { spec: Spec<'warnings'>; onClose: () => void }): React.JSX.Element {
  const [busy, run] = useBusy()
  return (
    <Modal
      title={spec.title}
      onClose={onClose}
      width={620}
      testId="warnings-dialog"
      footer={
        <>
          <button className="btn" data-testid="warnings-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn danger"
            data-testid="warnings-proceed"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                onClose()
                await spec.onProceed()
              })
            }
          >
            {spec.proceedLabel}
          </button>
        </>
      }
    >
      <p>
        These values look like literal credentials. Everyone with access to the shared space will be able to read them.
      </p>
      <FindingsList findings={spec.findings} />
      <div className="info-box small">
        <strong>Tip:</strong> store the secret in Azure Key Vault (toolbar → Key Vault) and reference it instead, e.g. <code>{'{{vault:main/api-token}}'}</code>, or use an environment variable of type <em>secret</em> / <em>Key Vault</em>. References are resolved at send time with each user's own identity and are never uploaded.
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------
// Save As
// ---------------------------------------------------------------------------------------------

function folderOptions(items: Item[], depth = 1): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = []
  for (const it of items) if (it.type === 'folder') out.push({ id: it.id, label: `${'  '.repeat(depth)}${it.name}` }, ...folderOptions(it.items, depth + 1))
  return out
}

export function SaveAsDialog({ spec, onClose }: { spec: Spec<'saveAs'>; onClose: () => void }): React.JSX.Element {
  const tab = useApp((s) => s.tabs.find((t) => t.id === spec.tabId)) as RequestTab | undefined
  const snapshot = useApp((s) => s.snapshot)
  const cols = snapshot?.collections ?? []
  const current = tab?.collectionId && tab.requestId ? locate(tab.collectionId, tab.requestId) : undefined
  const [name, setName] = useState(tab?.draft.name ?? 'New Request')
  const [collectionId, setCollectionId] = useState<string>(tab?.collectionId ?? cols[0]?.collection.id ?? '')
  const [parentId, setParentId] = useState<string>(current?.parents.length ? current.parents[current.parents.length - 1].id : '')
  const [newCol, setNewCol] = useState('')
  const [busy, run] = useBusy()
  const col = cols.find((c) => c.collection.id === collectionId)?.collection
  if (!tab) return <Modal title="Save request" onClose={onClose}><p>Tab closed.</p></Modal>
  const save = (): void =>
    void run(async () => {
      let cid = collectionId
      if (!cid) {
        const e = await attempt(courier().collections.create({ name: newCol.trim() || 'My Collection', space: 'local' }))
        if (!e) return
        cid = e.collection.id
        await reloadWorkspace()
      }
      try {
        await saveRequestTo(tab, cid, parentId || null, true, name.trim() || tab.draft.name)
      } catch {
        return
      }
      onClose()
      if (spec.closeAfter) useApp.getState().closeTab(tab.id)
    })
  return (
    <Modal
      title="Save request"
      onClose={onClose}
      width={480}
      testId="save-as-dialog"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" data-testid="save-as-confirm" disabled={busy || (!collectionId && !newCol.trim())} onClick={save}>
            {busy && <Spinner />} Save
          </button>
        </>
      }
    >
      <div className="form-stack">
        <label className="field-label" htmlFor="sa-name">
          Request name
        </label>
        <input id="sa-name" aria-label="Request name" data-testid="save-as-name" value={name} onChange={(e) => setName(e.target.value)} />
        <label className="field-label" htmlFor="sa-col">
          Collection
        </label>
        <select
          id="sa-col"
          aria-label="Collection"
          data-testid="save-as-collection"
          value={collectionId}
          onChange={(e) => {
            setCollectionId(e.target.value)
            setParentId('')
          }}
        >
          {cols.map((c) => (
            <option key={c.collection.id} value={c.collection.id}>
              {c.collection.name} ({spaceLabel(c.sync.space)})
            </option>
          ))}
          <option value="">+ New collection…</option>
        </select>
        {!collectionId && <input aria-label="New collection name" placeholder="New collection name" value={newCol} onChange={(e) => setNewCol(e.target.value)} />}
        {col && (
          <>
            <label className="field-label" htmlFor="sa-folder">
              Folder
            </label>
            <select id="sa-folder" aria-label="Folder" value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">(collection root)</option>
              {folderOptions(col.items).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </>
        )}
        {current && <p className="muted small">Saves a new copy; the original request stays unchanged.</p>}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------
// Code snippet
// ---------------------------------------------------------------------------------------------

const LANGS: { id: SnippetLanguage; label: string }[] = [
  { id: 'curl', label: 'cURL' },
  { id: 'js-fetch', label: 'JavaScript fetch' },
  { id: 'python-requests', label: 'Python requests' }
]

export function SnippetDialog({ spec, onClose }: { spec: Spec<'snippet'>; onClose: () => void }): React.JSX.Element {
  const tab = useApp((s) => s.tabs.find((t) => t.id === spec.tabId)) as RequestTab | undefined
  const [lang, setLang] = useState<SnippetLanguage>('curl')
  const [code, setCode] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (!tab) return
    let live = true
    setCode(null)
    const saved = tab.collectionId && tab.requestId && locate(tab.collectionId, tab.requestId)
    void courier()
      .requests.snippet({ language: lang, collectionId: tab.collectionId, requestId: saved ? tab.requestId : null, draft: tab.draft })
      .then((r) => {
        if (!live) return
        if (r.ok) {
          setCode(r.value)
          setErr(null)
        } else setErr(r.error.message)
      })
    return () => {
      live = false
    }
  }, [lang, tab])
  return (
    <Modal
      title="Code snippet"
      onClose={onClose}
      width={760}
      testId="snippet-dialog"
      footer={
        <>
          <span className="muted small grow">Variables are resolved; Key Vault secrets and tokens are masked.</span>
          <button className="btn primary" disabled={!code} data-testid="snippet-copy" onClick={() => code && void copyText(code, 'Snippet copied')}>
            <Icon name="copy" /> Copy
          </button>
        </>
      }
    >
      <div className="seg" role="radiogroup" aria-label="Language">
        {LANGS.map((l) => (
          <button key={l.id} role="radio" aria-checked={lang === l.id} className={`seg-btn ${lang === l.id ? 'on' : ''}`} onClick={() => setLang(l.id)}>
            {l.label}
          </button>
        ))}
      </div>
      <div className="snippet-box" data-testid="snippet-code">
        {err ? <p className="error-text">{err}</p> : code === null ? <Spinner /> : <CodeEditor value={code} readOnly language={lang === 'js-fetch' ? 'javascript' : 'text'} ariaLabel="Code snippet" lineNumbers={false} wrap />}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------------------------

export function ImportDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [mode, setMode] = useState<'file' | 'text'>('file')
  const [text, setText] = useState('')
  const [space, setSpace] = useState<Space>('local')
  const [result, setResult] = useState<ImportResult | null>(null)
  const [busy, run] = useBusy()
  const done = async (r: ImportResult | null | undefined): Promise<void> => {
    if (!r) return
    const s = useApp.getState()
    if (r.kind === 'request') {
      openDraft(r.request)
      s.toast('success', `Opened "${r.request.name}" as a new request`)
    } else {
      await reloadWorkspace()
      const name = r.kind === 'collection' ? r.entry.collection.name : r.entry.environment.name
      s.toast('success', `Imported ${r.kind} "${name}"`)
      if (r.kind === 'collection') s.set({ expanded: { ...s.expanded, [r.entry.collection.id]: true }, sidebarTab: 'collections' })
      else s.set({ sidebarTab: 'environments' })
    }
    if (r.warnings.length) setResult(r)
    else onClose()
  }
  return (
    <Modal
      title="Import"
      onClose={onClose}
      width={640}
      testId="import-dialog"
      footer={
        result ? (
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            {mode === 'file' ? (
              <button className="btn primary" data-testid="import-file" disabled={busy} onClick={() => void run(async () => done(await attempt(courier().files.importFile({ space }), { context: 'Import failed' })))}>
                {busy && <Spinner />} Choose file…
              </button>
            ) : (
              <button className="btn primary" data-testid="import-text-confirm" disabled={busy || !text.trim()} onClick={() => void run(async () => done(await attempt(courier().files.importText({ text, space }), { context: 'Import failed' })))}>
                {busy && <Spinner />} Import
              </button>
            )}
          </>
        )
      }
    >
      {result ? (
        <div>
          <p>Imported with {result.warnings.length} warning(s):</p>
          <ul className="warn-list">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="form-stack">
          <div className="seg" role="radiogroup" aria-label="Import source">
            <button role="radio" aria-checked={mode === 'file'} className={`seg-btn ${mode === 'file' ? 'on' : ''}`} onClick={() => setMode('file')}>
              File
            </button>
            <button role="radio" aria-checked={mode === 'text'} data-testid="import-mode-text" className={`seg-btn ${mode === 'text' ? 'on' : ''}`} onClick={() => setMode('text')}>
              Paste text
            </button>
          </div>
          <p className="muted small">Postman collections and environments (v2.0/v2.1), OpenAPI 3 (JSON/YAML), Courier JSON{mode === 'text' ? ', or a cURL command (opens as a new request)' : ''}.</p>
          {mode === 'text' && <textarea className="import-text mono" aria-label="Text to import" data-testid="import-text" placeholder={"curl https://api.example.com/users -H 'Accept: application/json'"} value={text} onChange={(e) => setText(e.target.value)} />}
          <label className="field-label" htmlFor="import-space">
            Import into space
          </label>
          <SpaceSelect id="import-space" value={space} onChange={setSpace} />
        </div>
      )}
    </Modal>
  )
}

export function ExportDialog({ spec, onClose }: { spec: Spec<'export'>; onClose: () => void }): React.JSX.Element {
  const [format, setFormat] = useState<ExportFormat>('postman')
  const [busy, run] = useBusy()
  const doExport = (): void =>
    void run(async () => {
      const api = courier().files
      const p = await attempt(spec.kind === 'collection' ? api.exportCollection({ id: spec.id, format }) : api.exportEnvironment({ id: spec.id, format }), { context: 'Export failed' })
      if (p) {
        useApp.getState().toast('success', `Exported to ${p}`)
        onClose()
      }
    })
  return (
    <Modal
      title={`Export “${spec.name}”`}
      onClose={onClose}
      width={440}
      testId="export-dialog"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" data-testid="export-confirm" disabled={busy} onClick={doExport}>
            {busy && <Spinner />} Export…
          </button>
        </>
      }
    >
      <div className="radio-stack" role="radiogroup" aria-label="Format">
        <label className="radio">
          <input type="radio" name="fmt" checked={format === 'postman'} onChange={() => setFormat('postman')} /> Postman {spec.kind === 'collection' ? 'Collection v2.1' : 'environment'}
        </label>
        <label className="radio">
          <input type="radio" name="fmt" checked={format === 'courier'} onChange={() => setFormat('courier')} /> Courier JSON
        </label>
      </div>
      <p className="muted small">Secret-typed variable values and current values are not exported.</p>
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------------------------

export function CookiesDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [cookies, setCookies] = useState<CookieInfo[] | null>(null)
  const [filter, setFilter] = useState('')
  const load = async (): Promise<void> => {
    const c = await attempt(courier().cookies.list())
    if (c) setCookies(c)
  }
  useEffect(() => {
    void load()
    return courier().on('cookies:changed', () => void load())
  }, [])
  const byDomain = useMemo(() => {
    const m = new Map<string, CookieInfo[]>()
    for (const c of cookies ?? []) {
      if (filter && !c.domain.includes(filter) && !c.key.includes(filter)) continue
      m.set(c.domain, [...(m.get(c.domain) ?? []), c])
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [cookies, filter])
  return (
    <Modal
      title="Cookies"
      onClose={onClose}
      width={760}
      testId="cookies-dialog"
      footer={
        <>
          <span className="muted small grow">The cookie jar is stored on this machine and used for every request.</span>
          <button className="btn danger" disabled={!cookies?.length} onClick={() => void attempt(courier().cookies.clear()).then(load)}>
            Clear all
          </button>
        </>
      }
    >
      <div className="search-box">
        <Icon name="search" size={12} />
        <input aria-label="Filter cookies" placeholder="Filter by domain or name" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {cookies === null ? (
        <Spinner />
      ) : byDomain.length === 0 ? (
        <p className="muted">No cookies.</p>
      ) : (
        <div className="cookie-groups">
          {byDomain.map(([domain, list]) => (
            <div key={domain}>
              <div className="section-title">{domain}</div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Value</th>
                    <th>Path</th>
                    <th>Expires</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.map((c) => (
                    <tr key={`${c.path}|${c.key}`} data-testid="cookie-row">
                      <td className="mono">{c.key}</td>
                      <td className="mono break">{c.value}</td>
                      <td>{c.path}</td>
                      <td>{c.expires ? new Date(c.expires).toLocaleString() : 'Session'}</td>
                      <td className="kv-actions">
                        <button className="icon-btn subtle" aria-label={`Delete cookie ${c.key}`} onClick={() => void attempt(courier().cookies.delete({ domain: c.domain, path: c.path, key: c.key })).then(load)}>
                          <Icon name="trash" size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
