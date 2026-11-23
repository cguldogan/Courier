/** Settings → Teams: list, join, create, rename, edit team vaults, approve vault hosts, leave, test connection. */
import { useState } from 'react'
import type { ConnectionTestResult, TeamProbe } from '../../../shared/api'
import type { Team, VaultConfig } from '../../../shared/types'
import { attempt, courier, errorCode, errorMessage, call } from '../api'
import { reloadWorkspace } from '../actions'
import { NO_TEAMS, useApp } from '../store'
import { Icon, Spinner } from './ui'

function refreshAll(): Promise<void> {
  return reloadWorkspace()
}

export function TeamsSettings(): React.JSX.Element {
  const teams = useApp((s) => s.snapshot?.teams ?? NO_TEAMS)
  const signedIn = useApp((s) => !!s.identity?.signedIn)
  const [adding, setAdding] = useState(teams.length === 0)
  return (
    <div className="form-stack" data-testid="teams-settings">
      <h3>Teams</h3>
      <p className="muted small">
        A team is one Azure Storage container, reached with your signed-in identity (no keys or SAS). Who can read or change a team&apos;s collections is decided by Azure RBAC on that container: give each team its own container and assign <strong>Storage Blob Data Contributor</strong> (or <strong>Storage Blob Data Reader</strong> for read-only members) scoped to the container. Items in <strong>Personal</strong> stay on this machine and are never uploaded.
      </p>
      {teams.length === 0 && <p className="muted small">You have not joined a team yet.</p>}
      {teams.map((t) => (
        <TeamCard key={t.id} team={t} />
      ))}
      {adding ? (
        <JoinTeamForm onDone={() => setAdding(false)} />
      ) : (
        <div className="row-gap">
          <button className="btn" data-testid="add-team" disabled={!signedIn} title={signedIn ? undefined : 'Sign in first'} onClick={() => setAdding(true)}>
            <Icon name="plus" size={12} /> Join or create a team
          </button>
          {!signedIn && <span className="muted small">Sign in first (Account).</span>}
        </div>
      )}
    </div>
  )
}

function JoinTeamForm({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [accountUrl, setAccountUrl] = useState('')
  const [container, setContainer] = useState('')
  const [name, setName] = useState('')
  const [probe, setProbe] = useState<TeamProbe | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const loc = { accountUrl: accountUrl.trim(), container: container.trim() }
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const joined = async (t: Team, verb: string): Promise<void> => {
    await refreshAll()
    useApp.getState().toast('success', `${verb} team "${t.name}"`)
    onDone()
  }
  return (
    <div className="team-card" data-testid="join-team-form">
      <div className="strong">Join or create a team</div>
      <div className="form-grid">
        <label htmlFor="team-acct">Storage account URL</label>
        <input id="team-acct" data-testid="team-account" placeholder="https://myaccount.blob.core.windows.net" value={accountUrl} onChange={(e) => (setAccountUrl(e.target.value), setProbe(null))} />
        <label htmlFor="team-cont">Container</label>
        <input id="team-cont" data-testid="team-container" placeholder="team-payments" value={container} onChange={(e) => (setContainer(e.target.value), setProbe(null))} />
      </div>
      <div className="row-gap">
        <button className="btn" data-testid="team-lookup" disabled={busy || !loc.accountUrl || !loc.container} onClick={() => void run(async () => setProbe(await call(courier().teams.probe(loc), { quiet: true })))}>
          {busy && !probe && <Spinner />} Look up
        </button>
        <button className="link-btn small" onClick={onDone}>
          Cancel
        </button>
      </div>
      {error && (
        <div className="error-box small" data-testid="team-lookup-error">
          <Icon name="warn" />
          <div>{error}</div>
        </div>
      )}
      {probe && probe.joinedTeamId && <div className="info-box small">You have already joined this team.</div>}
      {probe && !probe.joinedTeamId && probe.manifest && (
        <div className="form-stack" data-testid="team-found">
          <div>
            Team <strong data-testid="team-found-name">{probe.manifest.name}</strong>
            {probe.manifest.vaults.length > 0 && (
              <span className="muted small">
                {' '}
                · Key Vaults: {probe.manifest.vaults.map((v) => `${v.alias} (${new URL(v.url).host})`).join(', ')} — you will be asked to approve each host before it is used
              </span>
            )}
          </div>
          <div className="row-gap">
            <button className="btn primary" data-testid="team-join" disabled={busy} onClick={() => void run(async () => joined(await call(courier().teams.join(loc), { quiet: true }), 'Joined'))}>
              {busy && <Spinner />} Join team
            </button>
          </div>
        </div>
      )}
      {probe && !probe.joinedTeamId && !probe.manifest && (
        <div className="form-stack" data-testid="team-missing">
          <p className="small">
            This container has no team settings (<code>courier-team.json</code>) yet. If you can write to it, create the team. Read-only members can still join under a name of their choice.
          </p>
          <div className="form-grid">
            <label htmlFor="team-name">Team name</label>
            <input id="team-name" data-testid="team-name" placeholder="Payments" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="row-gap">
            <button className="btn primary" data-testid="team-create" disabled={busy || !name.trim()} onClick={() => void run(async () => joined(await call(courier().teams.create({ ...loc, name: name.trim() }), { quiet: true }), 'Created'))}>
              {busy && <Spinner />} Create team
            </button>
            <button className="btn" data-testid="team-join-readonly" disabled={busy || !name.trim()} onClick={() => void run(async () => joined(await call(courier().teams.join({ ...loc, name: name.trim() }), { quiet: true }), 'Joined'))}>
              Join read-only
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function TeamCard({ team }: { team: Team }): React.JSX.Element {
  const openDialog = useApp((s) => s.openDialog)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [vaults, setVaults] = useState<VaultConfig[] | null>(null)
  const [baseEtag, setBaseEtag] = useState<string | null>(null)
  const [test, setTest] = useState<ConnectionTestResult | null>(null)
  const [busy, setBusy] = useState(false)
  const hasManifest = team.manifestEtag !== null

  /** Returns 'ok' or the error code (the error is shown as a toast). */
  const update = async (patch: { name?: string; vaults?: VaultConfig[] }, etag?: string | null): Promise<string> => {
    setBusy(true)
    try {
      await call(courier().teams.update({ id: team.id, ...patch, ...(etag ? { etag } : {}) }), { context: 'Could not save the team settings' })
      return 'ok'
    } catch (err) {
      return errorCode(err) ?? 'INTERNAL'
    } finally {
      setBusy(false)
      await refreshAll()
    }
  }
  const leave = (): void =>
    openDialog({
      type: 'confirm',
      title: `Leave team "${team.name}"?`,
      message: "Its collections and environments are removed from this machine. Nothing is deleted from the team's storage; you can join again later.",
      confirmLabel: 'Leave team',
      danger: true,
      onConfirm: async () => {
        const r = await attempt(courier().teams.leave({ id: team.id }))
        if (!r) return
        if (r.left) {
          useApp.getState().toast('success', `Left team "${team.name}"`)
          await refreshAll()
          return
        }
        openDialog({
          type: 'confirm',
          title: 'Discard unsynced changes?',
          message: `${r.unsynced.length} change(s) in this team are not synced yet (${r.unsynced.map((x) => x.name).join(', ')}). Leaving drops them from this machine.`,
          confirmLabel: 'Discard and leave',
          danger: true,
          onConfirm: async () => {
            const again = await attempt(courier().teams.leave({ id: team.id, discardUnsynced: true }))
            if (again?.left) {
              useApp.getState().toast('success', `Left team "${team.name}"`)
              await refreshAll()
            }
          }
        })
      }
    })

  return (
    <div className="team-card" data-testid="team-card" data-team-name={team.name}>
      <div className="team-card-head">
        <Icon name="users" size={14} />
        <div className="grow">
          {renaming !== null ? (
            <div className="row-gap">
              <input aria-label="Team name" data-testid="team-rename-input" value={renaming} onChange={(e) => setRenaming(e.target.value)} />
              <button
                className="btn small primary"
                data-testid="team-rename-save"
                disabled={busy || !renaming.trim()}
                onClick={async () => {
                  if ((await update({ name: renaming.trim() })) === 'ok') setRenaming(null)
                }}
              >
                Save
              </button>
              <button className="link-btn small" onClick={() => setRenaming(null)}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="strong">{team.name}</div>
          )}
          <div className="mono small muted break">
            {team.accountUrl}/{team.container}
          </div>
        </div>
        <button
          className="btn small"
          data-testid="team-test-connection"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            const r = await attempt(courier().teams.testConnection(team.id))
            setBusy(false)
            if (r) setTest(r)
          }}
        >
          Test connection
        </button>
        <button className="btn small" data-testid="team-rename" onClick={() => setRenaming(team.name)} title={hasManifest ? 'Renames the team for everyone (team settings in the container)' : 'Renames the team on this machine'}>
          Rename
        </button>
        <button className="btn small" data-testid="team-leave" onClick={leave}>
          Leave
        </button>
      </div>
      {test && (
        <div className={test.ok ? 'good-text small' : 'error-text small'} data-testid="team-connection-result">
          {test.ok ? '✓ ' : ''}
          {test.message}
        </div>
      )}
      <div className="small muted">
        {hasManifest ? (
          <>Name and Key Vaults come from the team settings (courier-team.json) in the container and are shared with every member.</>
        ) : (
          <>This container has no team settings (courier-team.json) yet, so the name is only stored on this machine. Members with write access can create them to share the name and Key Vaults with the team.</>
        )}
      </div>
      <div className="row-gap">
        <button
          className="btn small"
          data-testid="team-reload"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            const r = await attempt(courier().teams.refresh(team.id), { context: 'Could not read the team settings' })
            setBusy(false)
            if (r) useApp.getState().toast('success', `Reloaded the settings of team "${r.name}"`)
            await refreshAll()
          }}
        >
          Reload team settings
        </button>
        {!hasManifest && (
          <button
            className="btn small"
            data-testid="team-create-settings"
            disabled={busy}
            onClick={async () => {
              if ((await update({ vaults: [] })) === 'ok') useApp.getState().toast('success', `Created the team settings for "${team.name}"`)
            }}
          >
            Create team settings
          </button>
        )}
      </div>
      {vaults === null ? (
        <>
          {team.vaults.map((v) => (
            <div key={v.url} className="team-vault-row" data-testid="team-vault-row" data-alias={v.alias} data-approved={v.approved}>
              <Icon name="key" size={12} />
              <code>{v.alias}</code>
              <span className="host grow">{v.host}</span>
              {v.approved ? (
                <span className="good-text small">approved on this machine</span>
              ) : (
                <button className="btn small" data-testid="team-review-host" onClick={() => openDialog({ type: 'teamVaults', teamId: team.id })}>
                  Review host…
                </button>
              )}
            </div>
          ))}
          {team.rejectedVaults.map((r) => (
            <div key={`${r.alias}|${r.url}`} className="team-vault-row error-text small">
              <Icon name="warn" size={12} />
              <code>{r.alias || '(no alias)'}</code>
              <span className="host grow">{r.url}</span>
              ignored: {r.reason}
            </div>
          ))}
          {hasManifest && (
            <div className="row-gap">
              <button
                className="btn small"
                data-testid="team-edit-vaults"
                onClick={() => {
                  setVaults(team.vaults.map((v) => ({ alias: v.alias, url: v.url })))
                  setBaseEtag(team.manifestEtag)
                }}
              >
                {team.vaults.length ? 'Edit team Key Vaults' : 'Add team Key Vaults'}
              </button>
              <span className="muted small">
                Team collections can use <code>{'{{vault:alias/name}}'}</code> with these aliases; a bare <code>{'{{vault:name}}'}</code> uses the team&apos;s first vault.
              </span>
            </div>
          )}
        </>
      ) : (
        <div className="form-stack" data-testid="team-vaults-editor">
          <table className="kv-table">
            <thead>
              <tr>
                <th style={{ width: 140 }}>Alias</th>
                <th>Vault URL</th>
                <th className="kv-actions" />
              </tr>
            </thead>
            <tbody>
              {vaults.map((v, i) => (
                <tr key={i} data-testid="team-vault-edit-row">
                  <td>
                    <input className="cell mono" aria-label="Team vault alias" value={v.alias} onChange={(e) => setVaults(vaults.map((x, j) => (j === i ? { ...x, alias: e.target.value } : x)))} />
                  </td>
                  <td>
                    <input className="cell mono" aria-label="Team vault URL" placeholder="https://team-kv.vault.azure.net" value={v.url} onChange={(e) => setVaults(vaults.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} />
                  </td>
                  <td className="kv-actions">
                    <button className="icon-btn subtle" aria-label={`Remove team vault ${v.alias}`} onClick={() => setVaults(vaults.filter((_, j) => j !== i))}>
                      <Icon name="trash" size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row-gap">
            <button className="btn small" data-testid="team-add-vault" onClick={() => setVaults([...vaults, { alias: vaults.length ? `vault${vaults.length + 1}` : 'team', url: '' }])}>
              <Icon name="plus" size={12} /> Add vault
            </button>
            <div className="grow" />
            <button className="link-btn small" onClick={() => setVaults(null)}>
              Cancel
            </button>
            <button
              className="btn small primary"
              data-testid="team-vaults-save"
              disabled={busy}
              onClick={async () => {
                const list = vaults.filter((v) => v.alias.trim() || v.url.trim()).map((v) => ({ alias: v.alias.trim(), url: v.url.trim() }))
                const res = await update({ vaults: list }, baseEtag)
                if (res === 'ok') useApp.getState().toast('success', `Saved the Key Vaults of team "${team.name}"`)
                // On success, and on an ETag conflict (the latest version is now loaded), leave the editor.
                if (res === 'ok' || res === 'CONFLICT') setVaults(null)
              }}
            >
              {busy && <Spinner />} Save for the team
            </button>
          </div>
          <p className="muted small">Saved to the team settings with an ETag check: if a teammate changed them meanwhile, nothing is overwritten and the latest version is loaded. Vault URLs must be https Key Vault hosts; the ones you save here count as approved on this machine.</p>
        </div>
      )}
    </div>
  )
}
