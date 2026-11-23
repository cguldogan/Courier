/** Collection runner tab: configure, run with live progress, per-request results, summary. */
import { useEffect, useMemo, useState } from 'react'
import type { DataFile } from '../../../shared/api'
import { type Folder, type Item, type RequestDef, findItem } from '../../../shared/types'
import { attempt, courier } from '../api'
import { type RunnerTab, useApp } from '../store'
import { OpenScriptVaultSettingButton, ReviewTeamVaultsButton } from './Editors'
import { Icon, MethodBadge, Spinner, formatMs, statusClass } from './ui'

function requestsIn(items: Item[], path: string[] = []): { req: RequestDef; path: string }[] {
  const out: { req: RequestDef; path: string }[] = []
  for (const it of items) {
    if (it.type === 'request') out.push({ req: it, path: path.join(' / ') })
    else out.push(...requestsIn(it.items, [...path, it.name]))
  }
  return out
}

function foldersIn(items: Item[], depth = 0): { f: Folder; depth: number }[] {
  const out: { f: Folder; depth: number }[] = []
  for (const it of items) if (it.type === 'folder') out.push({ f: it, depth }, ...foldersIn(it.items, depth + 1))
  return out
}

export function Runner({ tab }: { tab: RunnerTab }): React.JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const updateTab = useApp((s) => s.updateTab)
  const run = useApp((s) => (tab.runId ? s.runs[tab.runId] : undefined))
  const cols = snapshot?.collections ?? []
  const collection = cols.find((c) => c.collection.id === tab.collectionId)?.collection
  const [environmentId, setEnvironmentId] = useState<string | null | undefined>(undefined)
  const [iterations, setIterations] = useState(1)
  const [delayMs, setDelayMs] = useState(0)
  const [stopOnFailure, setStopOnFailure] = useState(false)
  const [persist, setPersist] = useState(true)
  const [maxJumps, setMaxJumps] = useState(1000)
  const [data, setData] = useState<DataFile | null>(null)
  const [order, setOrder] = useState<{ id: string; on: boolean }[]>([])
  const [starting, setStarting] = useState(false)
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})

  const scopeItems = useMemo(() => {
    if (!collection) return []
    if (tab.folderId) {
      const f = findItem(collection.items, tab.folderId)
      return f?.item.type === 'folder' ? f.item.items : []
    }
    return collection.items
  }, [collection, tab.folderId])
  const all = useMemo(() => requestsIn(scopeItems), [scopeItems])
  const allKey = all.map((r) => r.req.id).join(',')
  useEffect(() => {
    setOrder(all.map((r) => ({ id: r.req.id, on: true })))
  }, [allKey, tab.collectionId, tab.folderId])

  const byId = new Map(all.map((r) => [r.req.id, r]))
  const running = !!run && !run.summary
  const selected = order.filter((o) => o.on).map((o) => o.id)

  const start = async (): Promise<void> => {
    if (!collection) return
    setStarting(true)
    const r = await attempt(
      courier().runner.start({
        collectionId: collection.id,
        ...(tab.folderId ? { folderId: tab.folderId } : {}),
        requestIds: selected,
        ...(environmentId !== undefined ? { environmentId } : {}),
        iterations,
        delayMs,
        stopOnFailure,
        persistVariables: persist,
        maxJumps,
        ...(data ? { data: data.rows } : {})
      })
    )
    setStarting(false)
    if (!r) return
    useApp.setState((s) => ({ runs: { ...s.runs, [r.runId]: { runId: r.runId, total: selected.length * (data ? data.rows.length : iterations), completed: 0, results: [] } } }))
    updateTab(tab.id, (t) => ({ ...t, runId: r.runId }) as RunnerTab)
    setExpanded({})
  }

  const move = (i: number, dir: -1 | 1): void => {
    const j = i + dir
    if (j < 0 || j >= order.length) return
    const next = [...order]
    ;[next[i], next[j]] = [next[j], next[i]]
    setOrder(next)
  }

  const summary = run?.summary
  return (
    <div className="runner" data-testid="runner">
      <div className="runner-config">
        <h2 className="panel-title">
          <Icon name="play" size={14} /> Collection Runner
        </h2>
        <div className="form-grid">
          <label htmlFor="run-col">Collection</label>
          <select id="run-col" aria-label="Collection" data-testid="runner-collection" value={tab.collectionId ?? ''} disabled={running} onChange={(e) => updateTab(tab.id, (t) => ({ ...t, collectionId: e.target.value || null, folderId: null, runId: undefined }) as RunnerTab)}>
            <option value="">Choose a collection…</option>
            {cols.map((c) => (
              <option key={c.collection.id} value={c.collection.id}>
                {c.collection.name}
              </option>
            ))}
          </select>
          <label htmlFor="run-folder">Folder</label>
          <select id="run-folder" aria-label="Folder" value={tab.folderId ?? ''} disabled={running || !collection} onChange={(e) => updateTab(tab.id, (t) => ({ ...t, folderId: e.target.value || null }) as RunnerTab)}>
            <option value="">Whole collection</option>
            {collection &&
              foldersIn(collection.items).map(({ f, depth }) => (
                <option key={f.id} value={f.id}>
                  {'  '.repeat(depth) + f.name}
                </option>
              ))}
          </select>
          <label htmlFor="run-env">Environment</label>
          <select id="run-env" aria-label="Environment" value={environmentId === undefined ? '__active__' : (environmentId ?? '')} disabled={running} onChange={(e) => setEnvironmentId(e.target.value === '__active__' ? undefined : e.target.value || null)}>
            <option value="__active__">Active environment{snapshot?.activeEnvironmentId ? ` (${snapshot.environments.find((x) => x.environment.id === snapshot.activeEnvironmentId)?.environment.name})` : ' (none)'}</option>
            <option value="">No environment</option>
            {snapshot?.environments.map((e) => (
              <option key={e.environment.id} value={e.environment.id}>
                {e.environment.name}
              </option>
            ))}
          </select>
          <label htmlFor="run-iter">Iterations</label>
          <input id="run-iter" type="number" min={1} max={10000} aria-label="Iterations" data-testid="runner-iterations" value={data ? data.rows.length : iterations} disabled={running || !!data} onChange={(e) => setIterations(Math.max(1, Math.floor(Number(e.target.value) || 1)))} />
          <label htmlFor="run-delay">Delay (ms)</label>
          <input id="run-delay" type="number" min={0} aria-label="Delay (ms)" value={delayMs} disabled={running} onChange={(e) => setDelayMs(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
          <label htmlFor="run-jumps" title="Loop guard for pm.execution.setNextRequest">Max setNextRequest jumps</label>
          <input id="run-jumps" type="number" min={1} aria-label="Max setNextRequest jumps" data-testid="runner-max-jumps" value={maxJumps} disabled={running} onChange={(e) => setMaxJumps(Math.max(1, Math.floor(Number(e.target.value) || 1)))} />
          <label>Data file</label>
          <div className="row-gap">
            <button
              className="btn small"
              disabled={running}
              onClick={async () => {
                const f = await attempt(courier().files.pickDataFile())
                if (f) setData(f)
              }}
            >
              Choose CSV/JSON
            </button>
            {data ? (
              <>
                <span className="small ellipsis" title={data.columns.join(', ')}>
                  {data.name} · {data.rows.length} rows · {data.columns.length} columns
                </span>
                <button className="icon-btn subtle" aria-label="Remove data file" onClick={() => setData(null)}>
                  <Icon name="x" size={12} />
                </button>
              </>
            ) : (
              <span className="muted small">One iteration per row</span>
            )}
          </div>
          <span />
          <label className="check">
            <input type="checkbox" checked={stopOnFailure} disabled={running} onChange={(e) => setStopOnFailure(e.target.checked)} /> Stop on first failure
          </label>
          <span />
          <label className="check">
            <input type="checkbox" checked={persist} disabled={running} onChange={(e) => setPersist(e.target.checked)} /> Keep variable changes after the run
          </label>
        </div>
        <div className="section-title">
          Requests ({selected.length}/{order.length})
          <span className="grow" />
          <button className="link-btn small" disabled={running} onClick={() => setOrder(order.map((o) => ({ ...o, on: true })))}>
            All
          </button>
          <button className="link-btn small" disabled={running} onClick={() => setOrder(order.map((o) => ({ ...o, on: false })))}>
            None
          </button>
        </div>
        <ul className="run-order">
          {order.map((o, i) => {
            const r = byId.get(o.id)
            if (!r) return null
            return (
              <li key={o.id} className={o.on ? '' : 'off'}>
                <input type="checkbox" aria-label={`Include ${r.req.name}`} checked={o.on} disabled={running} onChange={(e) => setOrder(order.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
                <MethodBadge method={r.req.method} short />
                <span className="ellipsis grow" title={r.path ? `${r.path} / ${r.req.name}` : r.req.name}>
                  {r.req.name}
                  {r.path && <span className="muted small"> · {r.path}</span>}
                </span>
                <button className="icon-btn subtle" aria-label={`Move ${r.req.name} up`} disabled={running || i === 0} onClick={() => move(i, -1)}>
                  <Icon name="down" size={12} className="flip" />
                </button>
                <button className="icon-btn subtle" aria-label={`Move ${r.req.name} down`} disabled={running || i === order.length - 1} onClick={() => move(i, 1)}>
                  <Icon name="down" size={12} />
                </button>
              </li>
            )
          })}
          {collection && order.length === 0 && <li className="muted">No requests here.</li>}
        </ul>
        <div className="runner-actions">
          {running ? (
            <button className="btn danger" data-testid="runner-stop" onClick={() => tab.runId && void attempt(courier().runner.stop(tab.runId))}>
              <Icon name="stop" size={12} /> Stop
            </button>
          ) : (
            <button className="btn primary" data-testid="runner-start" disabled={!collection || !selected.length || starting} onClick={() => void start()}>
              {starting ? <Spinner /> : <Icon name="play" size={12} />} Run {collection?.name ?? ''}
            </button>
          )}
        </div>
      </div>
      <div className="runner-results" data-testid="runner-results">
        {!run && (
          <div className="empty-center">
            <Icon name="play" size={28} className="faint" />
            <span className="muted">Choose what to run and press Run. Results stream in here.</span>
          </div>
        )}
        {run && (
          <>
            <div className="run-progress">
              <div className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={run.total} aria-valuenow={run.completed}>
                <div className={`progress-fill ${summary && (summary.failedRequests || summary.failedTests) ? 'bad' : ''}`} style={{ width: `${run.total ? Math.min(100, (run.completed / run.total) * 100) : 100}%` }} />
              </div>
              <span className="small">
                {running ? <Spinner size={10} /> : null} {run.completed}/{run.total} requests
              </span>
            </div>
            {summary && (
              <div className="run-summary" data-testid="runner-summary">
                <div className="stat">
                  <span className="stat-num">{summary.iterations}</span>
                  <span className="stat-label">iterations</span>
                </div>
                <div className="stat">
                  <span className="stat-num">{summary.totalRequests}</span>
                  <span className="stat-label">requests</span>
                </div>
                <div className={`stat ${summary.failedRequests ? 'bad' : 'good'}`}>
                  <span className="stat-num">{summary.failedRequests}</span>
                  <span className="stat-label">failed requests</span>
                </div>
                <div className="stat good">
                  <span className="stat-num" data-testid="runner-passed">{summary.passedTests}</span>
                  <span className="stat-label">tests passed</span>
                </div>
                <div className={`stat ${summary.failedTests ? 'bad' : ''}`}>
                  <span className="stat-num">{summary.failedTests}</span>
                  <span className="stat-label">tests failed</span>
                </div>
                <div className="stat">
                  <span className="stat-num">{formatMs(summary.durationMs)}</span>
                  <span className="stat-label">duration</span>
                </div>
                {summary.stopped && (
                  <div className="warn-box small" data-testid="runner-stopped" data-reason={summary.stoppedReason}>
                    {summary.stoppedReason === 'user'
                      ? 'Stopped by you.'
                      : summary.stoppedReason === 'failure'
                        ? 'Stopped after a failure.'
                        : summary.stoppedReason === 'script'
                          ? summary.stopMessage ?? 'Stopped by setNextRequest(null).'
                          : summary.stoppedReason === 'loop-guard'
                            ? summary.stopMessage ?? 'Stopped by the setNextRequest loop guard.'
                            : summary.stopMessage ?? 'Stopped because of an error.'}
                  </div>
                )}
              </div>
            )}
            <table className="data-table run-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Request</th>
                  <th>Status</th>
                  <th>Time</th>
                  <th>Tests</th>
                </tr>
              </thead>
              <tbody>
                {run.results.map((r, i) => {
                  const passed = r.tests.filter((t) => t.passed).length
                  return [
                    <tr key={i} className={`run-row ${r.passed ? 'pass' : 'fail'}`} data-testid="run-result" data-passed={r.passed} onClick={() => setExpanded({ ...expanded, [i]: !expanded[i] })}>
                      <td className="muted">{r.iteration + 1}</td>
                      <td>
                        <MethodBadge method={r.method} short /> {r.name}
                      </td>
                      <td>{r.status ? <span className={`status-mini ${statusClass(r.status)}`}>{r.status}</span> : r.skipped ? <span className="status-mini muted">skipped</span> : <span className="status-mini st-server">{r.error?.code ?? 'ERR'}</span>}</td>
                      <td>{r.timeMs !== undefined ? formatMs(r.timeMs) : ''}</td>
                      <td>
                        <span className={r.tests.length && passed === r.tests.length ? 'good-text' : r.tests.length ? 'bad-text' : 'muted'}>{r.tests.length ? `${passed}/${r.tests.length}` : '—'}</span>
                      </td>
                    </tr>,
                    expanded[i] || !r.passed ? (
                      <tr key={`d${i}`} className="run-detail">
                        <td />
                        <td colSpan={4}>
                          <div className="mono small muted break">{r.url}</div>
                          {r.error && <div className="error-text small">{r.error.message}</div>}
                          {r.scriptErrors
                            .filter((e) => !(e.code === 'VAULT_SCRIPT_BLOCKED' && r.error?.code === 'VAULT_SCRIPT_BLOCKED'))
                            .map((e, k) => (
                              <div key={k} className="error-text small">
                                Script error: {e.message}
                              </div>
                            ))}
                          {(r.error?.code === 'VAULT_SCRIPT_BLOCKED' || r.scriptErrors.some((e) => e.code === 'VAULT_SCRIPT_BLOCKED')) && (
                            <div className="error-actions" onClick={(e) => e.stopPropagation()}>
                              <OpenScriptVaultSettingButton collectionId={tab.collectionId} />
                            </div>
                          )}
                          {(r.error?.code === 'VAULT_NOT_APPROVED' || r.scriptErrors.some((e) => e.code === 'VAULT_NOT_APPROVED')) && (
                            <div className="error-actions" onClick={(e) => e.stopPropagation()}>
                              <ReviewTeamVaultsButton collectionId={tab.collectionId} />
                            </div>
                          )}
                          {r.tests.map((t, k) => (
                            <div key={k} className="small">
                              <span className={`test-badge ${t.passed ? 'pass' : 'fail'}`}>{t.passed ? 'PASS' : 'FAIL'}</span> {t.name}
                              {t.error && <span className="muted"> — {t.error}</span>}
                            </div>
                          ))}
                        </td>
                      </tr>
                    ) : null
                  ]
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  )
}
