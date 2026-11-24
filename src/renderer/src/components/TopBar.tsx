/** Top bar: brand, environment selector + quick peek, sync, identity, tools. */
import { useRef, useState } from 'react'
import { courier, succeeded } from '../api'
import { openEnvironment, openMocks, openMonitors, openRunner, reloadWorkspace, runSync, signIn, signOut, updateUi } from '../actions'
import { useApp } from '../store'
import { Icon, Popover, Spinner, timeAgo } from './ui'

export function TopBar(): React.JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const openDialog = useApp((s) => s.openDialog)
  const settings = useApp((s) => s.settings)
  const theme = (settings?.ui.theme as string) ?? 'system'
  const envRef = useRef<HTMLButtonElement>(null)
  const [peek, setPeek] = useState(false)
  const envs = snapshot?.environments ?? []
  const active = envs.find((e) => e.environment.id === snapshot?.activeEnvironmentId)
  const runningMocks = useApp((s) => s.mocks.filter((m) => m.running).length)
  const monitors = useApp((s) => s.monitors)
  const failing = monitors.filter((m) => m.enabled && m.lastRun && !m.lastRun.passed)

  return (
    <header className="topbar">
      <div className="brand" aria-label="Courier">
        <span className="brand-mark">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
            <path d="M21 3 3 10.3l6.9 2.7z" fill="currentColor" />
            <path d="M21 3 9.9 13l1.9 7.2z" fill="currentColor" opacity=".6" />
            <path d="M21 3 11.8 20.2l3.8-5.4 3.4 1.6z" fill="currentColor" />
            <path d="M2.5 15h3.6M4 18.4h4.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity=".55" />
          </svg>
        </span>
        Courier
      </div>
      <div className="topbar-tools">
        <button className="tool-btn" data-testid="runner-button" onClick={() => openRunner(useApp.getState().snapshot?.collections[0]?.collection.id ?? null)} title="Collection runner">
          <Icon name="play" size={12} /> Runner
        </button>
        <button className="tool-btn" data-testid="mocks-button" aria-label={`Mock servers${runningMocks ? `, ${runningMocks} running` : ''}`} onClick={() => openMocks()} title="Mock servers (local)">
          <Icon name="server" size={13} /> Mocks
          {runningMocks > 0 && (
            <span className="badge good" data-testid="mocks-running">
              {runningMocks}
            </span>
          )}
        </button>
        <button
          className="tool-btn"
          data-testid="monitors-button"
          aria-label={`Monitors${failing.length ? `, ${failing.length} failing` : ''}`}
          onClick={() => (failing.length ? openMonitors(failing[0].id, failing[0].lastRun?.id ?? null) : openMonitors())}
          title={failing.length ? `Failing: ${failing.map((m) => m.name).join(', ')}` : 'Scheduled collection runs'}
        >
          <Icon name="pulse" size={13} /> Monitors
          {failing.length > 0 && (
            <span className="badge danger" data-testid="monitors-badge">
              {failing.length}
            </span>
          )}
        </button>
        <button className="tool-btn" data-testid="vault-button" onClick={() => openDialog({ type: 'vault' })} title="Key Vault secrets">
          <Icon name="key" size={13} /> Key Vault
        </button>
        <button className="tool-btn" data-testid="cookies-button" onClick={() => openDialog({ type: 'cookies' })} title="Cookie jar">
          <Icon name="cookie" size={13} /> Cookies
        </button>
      </div>
      <div className="grow" />
      <div className="env-picker">
        <Icon name="layers" size={13} className="muted" />
        <select
          aria-label="Active environment"
          data-testid="env-select"
          value={snapshot?.activeEnvironmentId ?? ''}
          onChange={async (e) => {
            if (await succeeded(courier().environments.setActive(e.target.value || null))) await reloadWorkspace()
          }}
        >
          <option value="">No environment</option>
          {envs.map((e) => (
            <option key={e.environment.id} value={e.environment.id}>
              {e.environment.name}
            </option>
          ))}
        </select>
        <button ref={envRef} className={`icon-btn ${peek ? 'on' : ''}`} aria-label="Peek environment variables" data-testid="env-peek" title="Quick look at variables" onClick={() => setPeek(!peek)}>
          <Icon name="eye" />
        </button>
      </div>
      {peek && (
        <Popover anchor={envRef.current} onClose={() => setPeek(false)} align="right" width={520} testId="env-peek-popover">
          <EnvPeek onClose={() => setPeek(false)} activeId={active?.environment.id ?? null} />
        </Popover>
      )}
      <SyncButton />
      <IdentityChip />
      <button className="icon-btn" aria-label="Toggle theme" data-testid="theme-toggle" title={`Theme: ${theme}`} onClick={() => void updateUi({ theme: theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark' })}>
        <Icon name={theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'monitor'} />
      </button>
      <button className="icon-btn" aria-label="Settings" data-testid="settings-button" title="Settings" onClick={() => openDialog({ type: 'settings' })}>
        <Icon name="gear" />
      </button>
    </header>
  )
}

function EnvPeek({ activeId, onClose }: { activeId: string | null; onClose: () => void }): React.JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const env = snapshot?.environments.find((e) => e.environment.id === activeId)?.environment
  const current = (activeId && snapshot?.currentValues.environments[activeId]) || {}
  const [edits, setEdits] = useState<Record<string, string>>({})
  const commit = async (key: string): Promise<void> => {
    if (!env || edits[key] === undefined) return
    const values = { ...current }
    if (edits[key] === '') delete values[key]
    else values[key] = edits[key]
    if (await succeeded(courier().variables.setCurrentValues({ scope: 'environment', id: env.id, values }))) {
      await reloadWorkspace()
      setEdits((e) => {
        const { [key]: _drop, ...rest } = e
        return rest
      })
    }
  }
  return (
    <div className="peek">
      <div className="peek-head">
        <strong>{env ? env.name : 'No active environment'}</strong>
        <div className="grow" />
        {env && (
          <button
            className="link-btn small"
            onClick={() => {
              openEnvironment(env.id)
              onClose()
            }}
          >
            Edit
          </button>
        )}
      </div>
      {env && env.variables.length === 0 && <p className="muted small">This environment has no variables yet.</p>}
      {env && env.variables.length > 0 && (
        <table className="data-table peek-table">
          <thead>
            <tr>
              <th>Variable</th>
              <th>Type</th>
              <th>Shared value</th>
              <th>Current value</th>
            </tr>
          </thead>
          <tbody>
            {env.variables.map((v) => (
              <tr key={v.key} className={v.enabled ? '' : 'disabled'}>
                <td className="mono">{v.key}</td>
                <td>
                  <span className={`type-pill t-${v.type}`}>{v.type === 'vault' ? 'Key Vault' : v.type}</span>
                </td>
                <td className="mono break">{v.type === 'secret' ? <span className="muted">not synced</span> : v.value || <span className="muted">empty</span>}</td>
                <td>
                  <input
                    className="cell mono"
                    aria-label={`Current value of ${v.key}`}
                    type={v.type === 'secret' ? 'password' : 'text'}
                    value={edits[v.key] ?? current[v.key] ?? ''}
                    placeholder={v.type === 'secret' ? 'secret' : 'same as shared'}
                    onChange={(e) => setEdits({ ...edits, [v.key]: e.target.value })}
                    onBlur={() => void commit(v.key)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="peek-globals muted small">
        Globals: {snapshot?.globals.length ?? 0} · Current values stay on this machine and are never synced.
      </div>
    </div>
  )
}

function SyncButton(): React.JSX.Element {
  const sync = useApp((s) => s.sync)
  const lastReport = useApp((s) => s.lastReport)
  const openDialog = useApp((s) => s.openDialog)
  const running = sync?.running
  const conflicts = sync?.conflicts.length ?? 0
  const pending = sync?.pending ?? 0
  const last = lastReport?.finishedAt ?? sync?.lastReport?.finishedAt
  const failing = sync?.teams.filter((t) => t.lastError) ?? []
  const title = !sync?.configured
    ? 'No team joined — open Settings → Teams (Personal items never sync)'
    : !sync.signedIn
      ? 'Sign in to sync'
      : `Sync all ${sync.teams.length} team(s) · ${pending} pending · last sync ${timeAgo(last)}${failing.length ? ` · failing: ${failing.map((t) => t.name).join(', ')}` : ''}`
  return (
    <div className="sync-group">
      <button
        className={`tool-btn sync-btn ${conflicts ? 'has-conflicts' : ''}`}
        data-testid="sync-button"
        title={title}
        aria-label="Sync now"
        disabled={running}
        onClick={() => {
          if (!sync?.configured) return openDialog({ type: 'settings', section: 'teams' })
          if (!sync.signedIn) return void signIn()
          void runSync()
        }}
      >
        {running ? <Spinner /> : <Icon name="sync" size={13} />}
        <span>Sync</span>
        {pending > 0 && (
          <span className="badge" data-testid="sync-pending" title={`${pending} change(s) not uploaded yet`}>
            {pending}
          </span>
        )}
        {conflicts > 0 && (
          <span className="badge danger" data-testid="sync-conflicts" title={`${conflicts} conflict(s)`}>
            {conflicts}!
          </span>
        )}
        {failing.length > 0 && (
          <span className="badge danger" data-testid="sync-team-errors" title={failing.map((t) => `${t.name}: ${t.lastError?.message}`).join('\n')}>
            {failing.length} failed
          </span>
        )}
      </button>
      <button className="tool-btn sync-more" aria-label="Sync details" data-testid="sync-panel-button" title={`Sync status · last sync ${timeAgo(last)}`} onClick={() => openDialog({ type: 'sync' })}>
        <Icon name="down" size={12} />
      </button>
    </div>
  )
}

function IdentityChip(): React.JSX.Element {
  const identity = useApp((s) => s.identity)
  const openDialog = useApp((s) => s.openDialog)
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  if (!identity?.signedIn)
    return (
      <button className="btn primary small sign-in" data-testid="sign-in" disabled={identity?.busy} onClick={() => void signIn()} title={identity?.error ?? `Sign in with Azure identity (${identity?.mode ?? 'auto'})`}>
        {identity?.busy ? <Spinner /> : <Icon name="user" size={12} />} Sign in
      </button>
    )
  const a = identity.account
  const label = a?.name ?? a?.upn ?? 'Signed in'
  const initials = label
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('')
  return (
    <>
      <button ref={ref} className="identity-chip" data-testid="identity-chip" onClick={() => setOpen(!open)} title={a?.upn ?? label}>
        <span className="avatar">{initials}</span>
        <span className="identity-name">{label}</span>
      </button>
      {open && (
        <Popover anchor={ref.current} onClose={() => setOpen(false)} align="right" width={320} testId="identity-popover">
          <div className="identity-card">
            <div className="identity-top">
              <span className="avatar big">{initials}</span>
              <div>
                <div className="strong">{a?.name ?? '—'}</div>
                <div className="muted small">{a?.upn ?? ''}</div>
              </div>
            </div>
            <dl className="kv-list small">
              <dt>Sign-in mode</dt>
              <dd>{identity.mode}{identity.fake ? ' (test identity)' : ''}</dd>
              <dt>Object id</dt>
              <dd className="mono">{a?.oid ?? '—'}</dd>
              <dt>Tenant</dt>
              <dd className="mono">{a?.tid ?? '—'}</dd>
            </dl>
            <div className="row-gap end">
              <button
                className="btn small"
                onClick={() => {
                  setOpen(false)
                  openDialog({ type: 'settings', section: 'account' })
                }}
              >
                Account settings
              </button>
              <button
                className="btn small"
                data-testid="sign-out"
                onClick={() => {
                  setOpen(false)
                  void signOut()
                }}
              >
                Sign out
              </button>
            </div>
          </div>
        </Popover>
      )}
    </>
  )
}
