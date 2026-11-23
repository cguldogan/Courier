/** Sync panel and conflict resolution dialog. */
import { useEffect, useMemo, useState } from 'react'
import type { ConflictDetail, ConflictResolution, ConnectionTestResult } from '../../../shared/api'
import type { Collection, Environment, Item, ItemRef, Variable } from '../../../shared/types'
import { buildUrl } from '../../../shared/variables'
import { attempt, courier } from '../api'
import { handleReport, reloadWorkspace, runSync, signIn, spaceLabel } from '../actions'
import { useApp } from '../store'
import { Icon, Modal, SpaceBadge, Spinner, timeAgo } from './ui'

function RefList({ refs, empty }: { refs: ItemRef[]; empty?: string }): React.JSX.Element {
  if (!refs.length) return <span className="muted small">{empty ?? 'none'}</span>
  return (
    <ul className="ref-list">
      {refs.map((r) => (
        <li key={`${r.kind}:${r.id}`}>
          <SpaceBadge space={r.space} /> {r.name} <span className="muted small">({r.kind})</span>
        </li>
      ))}
    </ul>
  )
}

export function SyncPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const sync = useApp((s) => s.sync)
  const snapshot = useApp((s) => s.snapshot)
  const identity = useApp((s) => s.identity)
  const lastReport = useApp((s) => s.lastReport) ?? sync?.lastReport ?? null
  const openDialog = useApp((s) => s.openDialog)
  const [test, setTest] = useState<ConnectionTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const items = [
    ...(snapshot?.collections ?? []).map((c) => ({ kind: 'collection' as const, id: c.collection.id, name: c.collection.name, sync: c.sync, updatedBy: c.collection.updatedBy, updatedAt: c.collection.updatedAt })),
    ...(snapshot?.environments ?? []).map((e) => ({ kind: 'environment' as const, id: e.environment.id, name: e.environment.name, sync: e.sync, updatedBy: e.environment.updatedBy, updatedAt: e.environment.updatedAt }))
  ].filter((i) => i.sync.space !== 'local')

  const discard = (kind: 'collection' | 'environment', id: string, name: string): void =>
    openDialog({
      type: 'confirm',
      title: 'Discard local changes?',
      message: `Your unsynced changes to "${name}" are dropped and the cloud version is downloaded again.`,
      confirmLabel: 'Discard',
      danger: true,
      onConfirm: async () => {
        const r = await attempt(courier().sync.discardLocalChanges({ kind, id }))
        if (r) {
          handleReport(r, { silentSuccess: true })
          useApp.getState().toast('success', `Discarded local changes to "${name}"`)
          await reloadWorkspace()
        }
      }
    })

  return (
    <Modal title="Sync" onClose={onClose} width={720} testId="sync-panel">
      {!sync?.configured ? (
        <div className="onboard-inline">
          <p>Cloud sync is not configured. Set a storage account and container to share collections with your team.</p>
          <button className="btn primary" onClick={() => openDialog({ type: 'settings', section: 'storage' })}>
            Configure storage
          </button>
        </div>
      ) : (
        <>
          <div className="sync-head">
            <div className="grow">
              <div className="mono small break">
                {sync.accountUrl}/{sync.container}
              </div>
              <div className="muted small">
                {identity?.signedIn ? `Signed in as ${identity.account?.upn ?? identity.account?.name}` : 'Not signed in'} · last sync {timeAgo(lastReport?.finishedAt)} · {sync.pending} pending · {sync.conflicts.length} conflict(s)
              </div>
            </div>
            <button
              className="btn"
              disabled={testing}
              data-testid="sync-test-connection"
              onClick={async () => {
                setTesting(true)
                const r = await attempt(courier().sync.testConnection())
                setTesting(false)
                if (r) setTest(r)
              }}
            >
              {testing && <Spinner />} Test connection
            </button>
            {identity?.signedIn ? (
              <button className="btn primary" data-testid="sync-now" disabled={sync.running} onClick={() => void runSync()}>
                {sync.running ? <Spinner /> : <Icon name="sync" size={13} />} Sync now
              </button>
            ) : (
              <button className="btn primary" onClick={() => void signIn()}>
                Sign in
              </button>
            )}
          </div>
          {test && (
            <div className={test.ok ? 'info-box small' : 'error-box small'} data-testid="sync-connection-result">
              {test.message}
            </div>
          )}
          {sync.conflicts.length > 0 && (
            <div className="warn-box">
              <strong>{sync.conflicts.length} conflict(s)</strong> — the cloud copy changed while you edited it.
              <ul className="ref-list">
                {sync.conflicts.map((c) => (
                  <li key={c.id}>
                    {c.name}{' '}
                    <button className="link-btn small" data-testid="resolve-conflict" onClick={() => openDialog({ type: 'conflict', kind: c.kind, id: c.id })}>
                      Resolve…
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="section-title">Cloud items</div>
          {items.length === 0 ? (
            <p className="muted small">No personal or shared items yet. Use “Move to space” on a collection or environment, then sync.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Space</th>
                  <th>State</th>
                  <th>Last change</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={`${i.kind}:${i.id}`} data-testid="sync-item">
                    <td>
                      {i.name} <span className="muted small">({i.kind})</span>
                      {i.sync.notice && <div className="muted small">{i.sync.notice}</div>}
                    </td>
                    <td>
                      <SpaceBadge space={i.sync.space} /> {spaceLabel(i.sync.space)}
                    </td>
                    <td>
                      {i.sync.conflict ? <span className="bad-text">conflict</span> : i.sync.dirty ? <span className="warn-text">{i.sync.etag ? 'modified' : 'new'}</span> : <span className="good-text">synced</span>}
                    </td>
                    <td className="small">
                      {i.updatedBy ?? ''} {timeAgo(i.sync.lastSyncedAt ?? i.updatedAt)}
                    </td>
                    <td className="kv-actions">
                      {i.sync.conflict ? (
                        <button className="link-btn small" onClick={() => openDialog({ type: 'conflict', kind: i.kind, id: i.id })}>
                          Resolve
                        </button>
                      ) : i.sync.dirty && i.sync.etag ? (
                        <button className="link-btn small" onClick={() => discard(i.kind, i.id, i.name)}>
                          Discard changes
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {sync.pendingDeletes.length > 0 && (
            <>
              <div className="section-title">Pending deletes</div>
              <p className="muted small">Deleted here, not yet removed from the cloud (they are applied on the next sync).</p>
              <table className="data-table">
                <tbody>
                  {sync.pendingDeletes.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <SpaceBadge space={d.space} /> {d.name} <span className="muted small">({d.kind})</span>
                      </td>
                      <td className="kv-actions">
                        <button className="link-btn small" onClick={() => discard(d.kind, d.id, d.name)}>
                          Restore from cloud
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {lastReport && (
            <>
              <div className="section-title">Last sync ({new Date(lastReport.finishedAt).toLocaleTimeString()})</div>
              <div className="report-grid small">
                <span>Uploaded</span>
                <RefList refs={lastReport.uploaded} />
                <span>Downloaded</span>
                <RefList refs={lastReport.downloaded} />
                {lastReport.deletedRemotely.length > 0 && (
                  <>
                    <span>Deleted remotely</span>
                    <RefList refs={lastReport.deletedRemotely} />
                  </>
                )}
                {lastReport.removedLocally.length > 0 && (
                  <>
                    <span>Removed locally</span>
                    <RefList refs={lastReport.removedLocally} />
                  </>
                )}
                {lastReport.blocked.length > 0 && (
                  <>
                    <span>Held back</span>
                    <div>
                      <RefList refs={lastReport.blocked.map((b) => b.ref)} />
                      <button className="link-btn small" onClick={() => void runSync(true)}>
                        Upload anyway
                      </button>
                    </div>
                  </>
                )}
                {lastReport.errors.length > 0 && (
                  <>
                    <span>Errors</span>
                    <ul className="ref-list">
                      {lastReport.errors.map((e, i) => (
                        <li key={i} className="error-text">
                          {e.ref ? `${e.ref.name}: ` : ''}
                          {e.message}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {lastReport.notices.length > 0 && (
                  <>
                    <span>Notices</span>
                    <ul className="ref-list">
                      {lastReport.notices.map((n, i) => (
                        <li key={i}>
                          {n.ref.name}: {n.message}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------
// Conflict dialog
// ---------------------------------------------------------------------------------------------

interface Row {
  label: string
  mine: string
  theirs: string
}

function describeItem(it: Item | undefined, path: string): string {
  if (!it) return '(not present)'
  if (it.type === 'folder') return `Folder ${path}${it.description ? `\n${it.description}` : ''}`
  const lines = [`${it.method} ${buildUrl(it.url, it.params)}`]
  for (const h of it.headers) lines.push(`${h.enabled ? '' : '// '}${h.key}: ${h.value}`)
  if (it.body.mode === 'raw' && it.body.raw) lines.push(`body: ${it.body.raw.length > 120 ? it.body.raw.slice(0, 120) + '…' : it.body.raw}`)
  else if (it.body.mode !== 'none') lines.push(`body: ${it.body.mode}`)
  if (it.auth.type !== 'inherit') lines.push(`auth: ${it.auth.type}`)
  if (it.preRequestScript || it.testScript) lines.push(`scripts: ${it.preRequestScript.length + it.testScript.length} chars`)
  return lines.join('\n')
}

function itemIndex(items: Item[], path = ''): Map<string, { item: Item; path: string }> {
  const out = new Map<string, { item: Item; path: string }>()
  for (const it of items) {
    const p = path ? `${path} / ${it.name}` : it.name
    out.set(it.id, { item: it, path: p })
    if (it.type === 'folder') for (const [k, v] of itemIndex(it.items, p)) out.set(k, v)
  }
  return out
}

function compare(kind: 'collection' | 'environment', mine: Collection | Environment, theirs: Collection | Environment): Row[] {
  const rows: Row[] = [{ label: 'Name', mine: mine.name, theirs: theirs.name }]
  const add = (label: string, a: string, b: string): void => {
    if (a !== b) rows.push({ label, mine: a, theirs: b })
  }
  if (kind === 'collection') {
    const m = mine as Collection
    const t = theirs as Collection
    add('Description', m.description, t.description)
    add('Auth', JSON.stringify(m.auth), JSON.stringify(t.auth))
    const mi = itemIndex(m.items)
    const ti = itemIndex(t.items)
    const strip = (x: Item | undefined): string => (x ? JSON.stringify(x.type === 'folder' ? { ...x, items: x.items.map((i) => i.id) } : x) : '')
    for (const id of new Set([...mi.keys(), ...ti.keys()])) {
      const a = mi.get(id)
      const b = ti.get(id)
      if (strip(a?.item) === strip(b?.item)) continue
      rows.push({ label: (a ?? b)!.path, mine: describeItem(a?.item, a?.path ?? ''), theirs: describeItem(b?.item, b?.path ?? '') })
    }
    add('Collection scripts', m.preRequestScript + m.testScript, t.preRequestScript + t.testScript)
  }
  const vm = new Map(mine.variables.map((v) => [v.key, v]))
  const vt = new Map(theirs.variables.map((v) => [v.key, v]))
  const show = (v: Variable | undefined): string => (v ? `${v.type === 'secret' ? '(secret)' : v.value}${v.enabled ? '' : ' (disabled)'}${v.type === 'vault' ? ' [Key Vault]' : ''}` : '(not present)')
  for (const k of new Set([...vm.keys(), ...vt.keys()])) if (JSON.stringify(vm.get(k)) !== JSON.stringify(vt.get(k))) rows.push({ label: `Variable ${k}`, mine: show(vm.get(k)), theirs: show(vt.get(k)) })
  return rows
}

/** Minimal line diff (LCS) for the raw JSON view. */
function lineDiff(a: string[], b: string[]): { left: { t: string; ch: boolean }[]; right: { t: string; ch: boolean }[] } {
  const n = a.length
  const m = b.length
  if (n * m > 4_000_000) return { left: a.map((t) => ({ t, ch: false })), right: b.map((t) => ({ t, ch: false })) }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const left: { t: string; ch: boolean }[] = []
  const right: { t: string; ch: boolean }[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      left.push({ t: a[i++], ch: false })
      right.push({ t: b[j++], ch: false })
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      left.push({ t: a[i++], ch: true })
      right.push({ t: '', ch: false })
    } else {
      left.push({ t: '', ch: false })
      right.push({ t: b[j++], ch: true })
    }
  }
  while (i < n) {
    left.push({ t: a[i++], ch: true })
    right.push({ t: '', ch: false })
  }
  while (j < m) {
    left.push({ t: '', ch: false })
    right.push({ t: b[j++], ch: true })
  }
  return { left, right }
}

export function ConflictDialog({ kind, id, onClose }: { kind: 'collection' | 'environment'; id: string; onClose: () => void }): React.JSX.Element {
  const [detail, setDetail] = useState<ConflictDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [view, setView] = useState<'summary' | 'json'>('summary')
  const [busy, setBusy] = useState<ConflictResolution | null>(null)
  useEffect(() => {
    void courier()
      .sync.getConflict({ kind, id })
      .then((r) => (r.ok ? setDetail(r.value) : setErr(r.error.message)))
  }, [kind, id])
  const rows = useMemo(() => (detail ? compare(kind, detail.mine, detail.theirs) : []), [detail, kind])
  const diff = useMemo(() => {
    if (!detail || view !== 'json') return null
    const strip = (d: Collection | Environment): string => JSON.stringify({ ...d, updatedAt: undefined, updatedBy: undefined }, null, 2)
    return lineDiff(strip(detail.mine).split('\n'), strip(detail.theirs).split('\n'))
  }, [detail, view])

  const resolve = async (resolution: ConflictResolution, acknowledgeWarnings = false): Promise<void> => {
    setBusy(resolution)
    const r = await attempt(courier().sync.resolveConflict({ kind, id, resolution, acknowledgeWarnings }))
    setBusy(null)
    if (!r) return
    onClose()
    await reloadWorkspace()
    const s = useApp.getState()
    s.toast('success', resolution === 'mine' ? 'Kept your version' : resolution === 'theirs' ? 'Took the cloud version' : `Kept both — your version is now "${r.copy?.name ?? 'a copy'}"`)
    handleReport(r.report, { silentSuccess: true })
  }

  return (
    <Modal
      title={detail ? `Sync conflict: ${detail.ref.name}` : 'Sync conflict'}
      onClose={onClose}
      width={900}
      testId="conflict-dialog"
      footer={
        <>
          <span className="muted small grow">“Keep both” saves your version as a copy and takes the cloud version.</span>
          <button className="btn" onClick={onClose}>
            Later
          </button>
          <button className="btn" data-testid="conflict-both" disabled={!detail || !!busy} onClick={() => void resolve('both')}>
            {busy === 'both' && <Spinner />} Keep both
          </button>
          <button className="btn" data-testid="conflict-theirs" disabled={!detail || !!busy} onClick={() => void resolve('theirs')}>
            {busy === 'theirs' && <Spinner />} Take theirs
          </button>
          <button className="btn primary" data-testid="conflict-mine" disabled={!detail || !!busy} onClick={() => void resolve('mine')}>
            {busy === 'mine' && <Spinner />} Keep mine
          </button>
        </>
      }
    >
      {err && <p className="error-text">{err}</p>}
      {!detail && !err && <Spinner />}
      {detail && (
        <>
          <p className="small">
            {detail.reason === 'precondition-failed' ? 'Your upload was rejected because the cloud copy changed in the meantime.' : 'This item changed both here and in the cloud since the last sync.'}{' '}
            {detail.remoteUpdatedBy && (
              <>
                Cloud version by <strong>{detail.remoteUpdatedBy}</strong> {timeAgo(detail.remoteUpdatedAt)}.
              </>
            )}
          </p>
          <div className="seg" role="radiogroup" aria-label="Comparison view">
            <button role="radio" aria-checked={view === 'summary'} className={`seg-btn ${view === 'summary' ? 'on' : ''}`} onClick={() => setView('summary')}>
              Summary
            </button>
            <button role="radio" aria-checked={view === 'json'} className={`seg-btn ${view === 'json' ? 'on' : ''}`} onClick={() => setView('json')}>
              JSON diff
            </button>
          </div>
          {view === 'summary' ? (
            <table className="data-table conflict-table" data-testid="conflict-summary">
              <thead>
                <tr>
                  <th style={{ width: '18%' }} />
                  <th>Mine (this machine)</th>
                  <th>Theirs (cloud)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={r.mine !== r.theirs ? 'changed' : ''}>
                    <td className="muted small">{r.label}</td>
                    <td className="mono small break pre-line">{r.mine || <span className="muted">empty</span>}</td>
                    <td className="mono small break pre-line">{r.theirs || <span className="muted">empty</span>}</td>
                  </tr>
                ))}
                {rows.length <= 1 && (
                  <tr>
                    <td colSpan={3} className="muted small">
                      Only metadata differs.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          ) : (
            diff && (
              <div className="json-diff">
                <div className="diff-col">
                  <div className="pane-label">Mine</div>
                  <pre className="mono">
                    {diff.left.map((l, i) => (
                      <div key={i} className={l.ch ? 'diff-del' : l.t === '' ? 'diff-gap' : ''}>
                        {l.t || ' '}
                      </div>
                    ))}
                  </pre>
                </div>
                <div className="diff-col">
                  <div className="pane-label">Theirs</div>
                  <pre className="mono">
                    {diff.right.map((l, i) => (
                      <div key={i} className={l.ch ? 'diff-add' : l.t === '' ? 'diff-gap' : ''}>
                        {l.t || ' '}
                      </div>
                    ))}
                  </pre>
                </div>
              </div>
            )
          )}
        </>
      )}
    </Modal>
  )
}
