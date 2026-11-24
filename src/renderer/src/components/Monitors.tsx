/** Monitors tab (list, status, history with drill-down) and the create / edit dialog. */
import { useEffect, useState } from 'react'
import type { Monitor, MonitorInfo, MonitorRun, MonitorRunSummary, MonitorSchedule } from '../../../shared/api'
import { describeSchedule } from '../../../shared/monitor-schedule'
import { type Folder, type Item } from '../../../shared/types'
import { attempt, courier } from '../api'
import { reloadMonitors } from '../actions'
import { type DialogSpec, type MonitorsTab, useApp } from '../store'
import { OpenScriptVaultSettingButton, ReviewTeamVaultsButton } from './Editors'
import { Icon, MethodBadge, Modal, Spinner, formatMs, statusClass, timeAgo } from './ui'

function when(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString() : d.toLocaleString()
}

function StatusDot({ m }: { m: MonitorInfo }): React.JSX.Element {
  const state = m.running ? 'running' : !m.lastRun ? 'none' : m.lastRun.passed ? 'pass' : 'fail'
  return <span className={`mon-dot ${state}`} data-testid="monitor-status" data-state={state} title={state === 'none' ? 'Not run yet' : state === 'running' ? 'Running' : state === 'pass' ? 'Last run passed' : 'Last run failed'} />
}

export function MonitorsPanel({ tab }: { tab: MonitorsTab }): React.JSX.Element {
  const monitors = useApp((s) => s.monitors)
  const openDialog = useApp((s) => s.openDialog)
  const updateTab = useApp((s) => s.updateTab)
  const selected = monitors.find((m) => m.id === tab.monitorId) ?? null
  const select = (id: string): void => updateTab(tab.id, (t) => ({ ...t, monitorId: id, runId: null }) as MonitorsTab)
  return (
    <div className="runner monitors" data-testid="monitors">
      <div className="runner-config">
        <h2 className="panel-title">
          <Icon name="pulse" size={14} /> Monitors
          <span className="grow" />
          <button className="btn small primary" data-testid="monitor-new" onClick={() => openDialog({ type: 'monitorEdit' })}>
            <Icon name="plus" size={12} /> New monitor
          </button>
        </h2>
        <p className="muted small">
          Scheduled collection runs on this machine while Courier is open. Runs missed while the app was closed are not replayed; use “Run now”. Monitors are not synced.
        </p>
        <ul className="mon-list" role="listbox" aria-label="Monitors">
          {monitors.length === 0 && <li className="muted small">No monitors yet.</li>}
          {monitors.map((m) => (
            <li key={m.id} role="option" aria-selected={m.id === tab.monitorId} tabIndex={0} className={`mon-item ${m.id === tab.monitorId ? 'active' : ''} ${m.enabled ? '' : 'off'}`} data-testid="monitor-row" data-name={m.name} onClick={() => select(m.id)} onKeyDown={(e) => e.key === 'Enter' && select(m.id)}>
              <StatusDot m={m} />
              <div className="mon-main">
                <div className="ellipsis strong">{m.name}</div>
                <div className="muted small ellipsis">
                  {m.collectionName ?? 'collection missing'} · {describeSchedule(m.schedule)}
                </div>
                <div className="muted small">
                  {m.lastRun ? `Last ${m.lastRun.passed ? 'passed' : 'failed'} ${timeAgo(m.lastRun.finishedAt)}` : 'Not run yet'}
                  {m.enabled && m.nextRunAt ? ` · next ${when(m.nextRunAt)}` : m.enabled ? '' : ' · disabled'}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="runner-results">{selected ? <MonitorDetail key={selected.id} m={selected} tab={tab} /> : <div className="empty-center"><Icon name="pulse" size={28} className="faint" /><span className="muted">Create a monitor to run a collection on a schedule.</span></div>}</div>
    </div>
  )
}

function MonitorDetail({ m, tab }: { m: MonitorInfo; tab: MonitorsTab }): React.JSX.Element {
  const openDialog = useApp((s) => s.openDialog)
  const updateTab = useApp((s) => s.updateTab)
  const [history, setHistory] = useState<MonitorRunSummary[] | null>(null)
  const [run, setRun] = useState<MonitorRun | null>(null)
  const [busy, setBusy] = useState(false)
  const lastKey = `${m.lastRun?.id ?? ''}|${m.running}`
  useEffect(() => {
    void attempt(courier().monitors.history(m.id), { quiet: true }).then((h) => setHistory(h ?? []))
  }, [m.id, lastKey])
  useEffect(() => {
    if (!tab.runId) return setRun(null)
    void attempt(courier().monitors.getRun({ monitorId: m.id, runId: tab.runId })).then((r) => setRun(r ?? null))
  }, [m.id, tab.runId])
  const showRun = (id: string | null): void => updateTab(tab.id, (t) => ({ ...t, runId: id }) as MonitorsTab)
  return (
    <div className="mon-detail" data-testid="monitor-detail">
      <div className="mock-head">
        <h3 className="mock-title">{m.name}</h3>
        <span className={`mock-state ${m.enabled ? 'on' : ''}`}>{m.enabled ? 'Enabled' : 'Disabled'}</span>
        <div className="grow" />
        <label className="check small">
          <input
            type="checkbox"
            aria-label="Enabled"
            data-testid="monitor-enabled"
            checked={m.enabled}
            onChange={async (e) => {
              const enabled = e.target.checked
              // Optimistic: the checkbox follows the click at once; the list is re-read either way.
              useApp.setState((s) => ({ monitors: s.monitors.map((x) => (x.id === m.id ? { ...x, enabled } : x)) }))
              await attempt(courier().monitors.setEnabled({ id: m.id, enabled }))
              await reloadMonitors()
            }}
          />{' '}
          Enabled
        </label>
        <button
          className="btn primary"
          data-testid="monitor-run-now"
          disabled={busy || m.running}
          onClick={async () => {
            setBusy(true)
            const r = await attempt(courier().monitors.runNow(m.id))
            setBusy(false)
            await reloadMonitors()
            if (r) showRun(r.id)
          }}
        >
          {busy || m.running ? <Spinner /> : <Icon name="play" size={12} />} Run now
        </button>
        <button className="btn" data-testid="monitor-edit" onClick={() => openDialog({ type: 'monitorEdit', monitorId: m.id })}>
          Edit
        </button>
        <button
          className="btn danger"
          aria-label="Delete monitor"
          onClick={() =>
            openDialog({
              type: 'confirm',
              title: 'Delete monitor?',
              message: `"${m.name}" and its run history will be deleted from this machine.`,
              confirmLabel: 'Delete',
              danger: true,
              onConfirm: async () => {
                if (await attempt(courier().monitors.delete(m.id))) await reloadMonitors()
              }
            })
          }
        >
          <Icon name="trash" size={12} />
        </button>
      </div>
      <dl className="kv-list small mon-facts">
        <dt>Collection</dt>
        <dd>{m.collectionName ?? <span className="error-text">The collection is gone</span>}</dd>
        <dt>Schedule</dt>
        <dd data-testid="monitor-schedule">{describeSchedule(m.schedule)}</dd>
        <dt>Next run</dt>
        <dd data-testid="monitor-next">{m.enabled ? (m.running ? 'running now' : when(m.nextRunAt)) : 'disabled'}</dd>
        <dt>Iterations</dt>
        <dd>{m.iterations}</dd>
        <dt>Notify on failure</dt>
        <dd>{m.notifyOnFailure ? 'Yes (OS notification on failure and on recovery)' : 'No'}</dd>
      </dl>
      <div className="section-title">History {history ? `(${history.length})` : ''}</div>
      <table className="data-table run-table" data-testid="monitor-history">
        <thead>
          <tr>
            <th>Started</th>
            <th>Result</th>
            <th>Requests</th>
            <th>Tests</th>
            <th>Duration</th>
            <th>Trigger</th>
          </tr>
        </thead>
        <tbody>
          {history?.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No runs yet.
              </td>
            </tr>
          )}
          {history?.map((h) => (
            <tr key={h.id} className={`run-row ${h.passed ? 'pass' : 'fail'} ${tab.runId === h.id ? 'selected' : ''}`} data-testid="monitor-run" data-passed={h.passed} onClick={() => showRun(tab.runId === h.id ? null : h.id)}>
              <td>{when(h.startedAt)}</td>
              <td>{h.passed ? <span className="good-text">Passed</span> : <span className="bad-text">{h.error ? h.error.code : 'Failed'}</span>}</td>
              <td>
                {h.totalRequests - h.failedRequests}/{h.totalRequests}
              </td>
              <td>
                {h.passedTests}/{h.totalTests}
              </td>
              <td>{formatMs(h.durationMs)}</td>
              <td className="muted small">{h.trigger === 'manual' ? 'Run now' : 'Schedule'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {run && <RunDetail run={run} collectionId={m.collectionId} />}
    </div>
  )
}

function RunDetail({ run, collectionId }: { run: MonitorRun; collectionId: string }): React.JSX.Element {
  const blocked = run.results.some((r) => r.error?.code === 'VAULT_SCRIPT_BLOCKED')
  const notApproved = run.results.some((r) => r.error?.code === 'VAULT_NOT_APPROVED')
  return (
    <div className="mon-run" data-testid="monitor-run-detail" data-passed={run.passed}>
      <div className="section-title">
        Run of {when(run.startedAt)} — {run.passed ? <span className="good-text">passed</span> : <span className="bad-text">failed</span>}
      </div>
      {run.error && (
        <div className="error-box small" data-testid="monitor-run-error">
          <Icon name="warn" /> {run.error.message}
        </div>
      )}
      {run.stopMessage && <div className="warn-box small">{run.stopMessage}</div>}
      {(blocked || notApproved) && (
        <div className="error-actions">
          {blocked && <OpenScriptVaultSettingButton collectionId={collectionId} />}
          {notApproved && <ReviewTeamVaultsButton collectionId={collectionId} />}
        </div>
      )}
      <table className="data-table">
        <tbody>
          {run.results.map((r, i) => (
            <tr key={i} className={`run-row ${r.passed ? 'pass' : 'fail'}`} data-testid="monitor-result" data-passed={r.passed}>
              <td className="muted">{r.iteration + 1}</td>
              <td>
                <MethodBadge method={r.method} short /> {r.name}
                <div className="mono small muted break">{r.url}</div>
                {r.error && <div className="error-text small">{r.error.message}</div>}
                {r.scriptErrors.map((e, k) => (
                  <div key={k} className="error-text small">
                    Script error: {e}
                  </div>
                ))}
                {r.failedTests.map((t, k) => (
                  <div key={k} className="small" data-testid="monitor-failed-test">
                    <span className="test-badge fail">FAIL</span> {t.name}
                    {t.error && <span className="muted"> — {t.error}</span>}
                  </div>
                ))}
              </td>
              <td>{r.status ? <span className={`status-mini ${statusClass(r.status)}`}>{r.status}</span> : <span className="status-mini st-server">{r.error?.code ?? '—'}</span>}</td>
              <td className="small">{r.timeMs !== undefined ? formatMs(r.timeMs) : ''}</td>
              <td className="small">
                {r.tests.passed}/{r.tests.total}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {run.resultsOmitted ? <p className="muted small">{run.resultsOmitted} more result(s) were not stored.</p> : null}
    </div>
  )
}

function foldersIn(items: Item[], depth = 0): { f: Folder; depth: number }[] {
  const out: { f: Folder; depth: number }[] = []
  for (const it of items) if (it.type === 'folder') out.push({ f: it, depth }, ...foldersIn(it.items, depth + 1))
  return out
}

export function MonitorEditDialog({ spec, onClose }: { spec: Extract<DialogSpec, { type: 'monitorEdit' }>; onClose: () => void }): React.JSX.Element {
  const existing = useApp((s) => (spec.monitorId ? s.monitors.find((m) => m.id === spec.monitorId) : undefined))
  const snapshot = useApp((s) => s.snapshot)
  const seconds = useApp((s) => s.info?.monitorSeconds === true)
  const cols = snapshot?.collections ?? []
  const [name, setName] = useState(existing?.name ?? '')
  const [collectionId, setCollectionId] = useState(existing?.collectionId ?? spec.collectionId ?? cols[0]?.collection.id ?? '')
  const [folderId, setFolderId] = useState(existing?.folderIds[0] ?? '')
  const [environmentId, setEnvironmentId] = useState<string>(existing?.environmentId ?? '')
  const [iterations, setIterations] = useState(existing?.iterations ?? 1)
  const [schedule, setSchedule] = useState<MonitorSchedule>(existing?.schedule ?? { kind: 'interval', every: 15, unit: 'minutes' })
  const [enabled, setEnabled] = useState(existing?.enabled ?? true)
  const [notify, setNotify] = useState(existing?.notifyOnFailure ?? true)
  const [busy, setBusy] = useState(false)
  const collection = cols.find((c) => c.collection.id === collectionId)?.collection
  const save = async (): Promise<void> => {
    setBusy(true)
    const input: Omit<Monitor, 'id' | 'createdAt'> & { id?: string } = {
      ...(existing ? { id: existing.id } : {}),
      name: name.trim() || collection?.name || 'Monitor',
      collectionId,
      folderIds: folderId ? [folderId] : [],
      environmentId: environmentId || null,
      iterations,
      schedule,
      enabled,
      notifyOnFailure: notify
    }
    const r = await attempt(courier().monitors.save(input))
    setBusy(false)
    if (!r) return
    await reloadMonitors()
    useApp.getState().toast('success', `${existing ? 'Saved' : 'Created'} monitor "${r.name}"`)
    onClose()
    const s = useApp.getState()
    const t = s.tabs.find((x) => x.kind === 'monitors')
    if (t) s.updateTab(t.id, (x) => ({ ...x, monitorId: r.id, runId: null }) as MonitorsTab)
  }
  const timeValue = schedule.kind === 'interval' ? '09:00' : schedule.time
  return (
    <Modal
      title={existing ? `Edit monitor "${existing.name}"` : 'New monitor'}
      onClose={onClose}
      width={560}
      testId="monitor-dialog"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" data-testid="monitor-save" disabled={busy || !collectionId} onClick={() => void save()}>
            {busy && <Spinner />} {existing ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label htmlFor="mon-name">Name</label>
        <input id="mon-name" autoFocus data-testid="monitor-name" placeholder={collection?.name ?? 'Monitor'} value={name} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="mon-col">Collection</label>
        <select id="mon-col" data-testid="monitor-collection" value={collectionId} onChange={(e) => (setCollectionId(e.target.value), setFolderId(''))}>
          {cols.map((c) => (
            <option key={c.collection.id} value={c.collection.id}>
              {c.collection.name}
              {c.sync.teamId ? ` (team: ${snapshot?.teams.find((t) => t.id === c.sync.teamId)?.name ?? 'team'})` : ''}
            </option>
          ))}
        </select>
        <label htmlFor="mon-folder">Folder</label>
        <select id="mon-folder" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
          <option value="">Whole collection</option>
          {collection &&
            foldersIn(collection.items).map(({ f, depth }) => (
              <option key={f.id} value={f.id}>
                {'  '.repeat(depth) + f.name}
              </option>
            ))}
        </select>
        <label htmlFor="mon-env">Environment</label>
        <select id="mon-env" data-testid="monitor-environment" value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
          <option value="">No environment</option>
          {snapshot?.environments.map((e) => (
            <option key={e.environment.id} value={e.environment.id}>
              {e.environment.name}
            </option>
          ))}
        </select>
        <label htmlFor="mon-iter">Iterations</label>
        <input id="mon-iter" type="number" min={1} max={100} value={iterations} onChange={(e) => setIterations(Math.min(100, Math.max(1, Math.floor(Number(e.target.value) || 1))))} />
        <label htmlFor="mon-kind">Schedule</label>
        <div className="row-gap schedule-row">
          <select
            id="mon-kind"
            data-testid="monitor-schedule-kind"
            value={schedule.kind}
            onChange={(e) => {
              const k = e.target.value as MonitorSchedule['kind']
              setSchedule(k === 'interval' ? { kind: 'interval', every: 15, unit: 'minutes' } : { kind: k, time: timeValue })
            }}
          >
            <option value="interval">Every…</option>
            <option value="daily">Every day at</option>
            <option value="weekdays">Weekdays (Mon–Fri) at</option>
          </select>
          {schedule.kind === 'interval' ? (
            <>
              <input type="number" min={1} aria-label="Every" data-testid="monitor-every" style={{ width: 80 }} value={schedule.every} onChange={(e) => setSchedule({ ...schedule, every: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} />
              <select aria-label="Unit" data-testid="monitor-unit" value={schedule.unit} onChange={(e) => setSchedule({ ...schedule, unit: e.target.value as 'minutes' })}>
                {seconds && <option value="seconds">seconds (test hook)</option>}
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
              </select>
            </>
          ) : (
            <input type="time" aria-label="Time" data-testid="monitor-time" value={schedule.time} onChange={(e) => setSchedule({ ...schedule, time: e.target.value || '09:00' })} />
          )}
        </div>
        <span />
        <label className="check">
          <input type="checkbox" data-testid="monitor-enabled-input" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
        </label>
        <span />
        <label className="check">
          <input type="checkbox" data-testid="monitor-notify" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Notify on failure (and once when it passes again)
        </label>
      </div>
      <p className="muted small">
        Runs use the same engine and Key Vault rules as the collection runner: scripts read Key Vault only if the collection allows it on this machine, and team vaults must be approved. Variable changes made by scripts are not kept. Daily times are local time.
      </p>
    </Modal>
  )
}
