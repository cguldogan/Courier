/** Collection/folder settings tab, environment editor tab and globals tab. */
import { useEffect, useRef, useState } from 'react'
import type { ScriptVaultAccess } from '../../../shared/api'
import { locationLabel, openRunner, openScriptVaultSetting, saveTab } from '../actions'
import { attempt, courier } from '../api'
import { type ContainerDraft, type ContainerTab, type EnvironmentTab, type GlobalsTab, type Tab, isDirty, locate, useApp } from '../store'
import { AuthEditor } from './AuthEditor'
import { ScriptEditor } from './ScriptEditor'
import { Icon, LocationBadge, SubTabs, timeAgo } from './ui'
import { VariablesGrid, globalsToRows, rowsToGlobals } from './VariablesGrid'

export function SaveBar({ tab, children }: { tab: Tab; children?: React.ReactNode }): React.JSX.Element {
  const dirty = isDirty(tab)
  const gone = (tab as ContainerTab).baseline === '__gone__'
  return (
    <div className="editor-actions">
      {children}
      {gone && <span className="error-text small">This item was deleted (for example by a sync). Your edits are kept until you close the tab.</span>}
      <button className="btn primary" data-testid="save-button" disabled={!dirty || gone} onClick={() => void saveTab(tab.id)}>
        <Icon name="save" /> Save
      </button>
    </div>
  )
}

export function ContainerEditor({ tab }: { tab: ContainerTab }): React.JSX.Element {
  const updateTab = useApp((s) => s.updateTab)
  const entry = useApp((s) => s.snapshot?.collections.find((c) => c.collection.id === tab.collectionId))
  const isCollection = !tab.folderId
  const [section, setSection] = useState<'overview' | 'auth' | 'variables' | 'scripts'>('overview')
  useEffect(() => {
    if (tab.focusVaultAccess) setSection('overview')
  }, [tab.focusVaultAccess])
  const d = tab.draft
  const patch = (p: Partial<ContainerDraft>): void => updateTab(tab.id, (t) => ({ ...t, draft: { ...(t as ContainerTab).draft, ...p } }) as ContainerTab)
  const parents = tab.folderId ? (locate(tab.collectionId, tab.folderId)?.parents ?? []) : []
  const parentRef = isCollection ? null : { collectionId: tab.collectionId, itemId: parents.length ? parents[parents.length - 1].id : null }
  const sections = [
    { id: 'overview' as const, label: 'Overview' },
    { id: 'auth' as const, label: 'Authorization', badge: d.auth.type !== 'inherit' && d.auth.type !== 'none' ? '●' : undefined },
    ...(isCollection ? [{ id: 'variables' as const, label: 'Variables', badge: d.variables.length || undefined }] : []),
    { id: 'scripts' as const, label: 'Scripts', badge: d.preRequestScript.trim() || d.testScript.trim() ? '●' : undefined }
  ]
  return (
    <div className="doc-editor" data-testid="container-editor">
      <div className="doc-header">
        <Icon name={isCollection ? 'box' : 'folder'} size={16} />
        <input className="title-input" aria-label={isCollection ? 'Collection name' : 'Folder name'} value={d.name} onChange={(e) => patch({ name: e.target.value })} />
        {entry && isCollection && (
          <span className="doc-meta">
            <LocationBadge teamId={entry.sync.teamId} /> {locationLabel(entry.sync.teamId)}
            {entry.collection.updatedBy && (
              <span className="muted small">
                {' '}
                · updated by {entry.collection.updatedBy} {timeAgo(entry.collection.updatedAt)}
              </span>
            )}
          </span>
        )}
        <div className="grow" />
        <SaveBar tab={tab}>
          <button className="btn" onClick={() => openRunner(tab.collectionId, tab.folderId)}>
            <Icon name="play" size={12} /> Run
          </button>
        </SaveBar>
      </div>
      <SubTabs value={section} onChange={setSection} tabs={sections} />
      <div className="section-body">
        {section === 'overview' && (
          <div className="scroll-pad">
            <label className="field-label" htmlFor="desc">
              Description
            </label>
            <textarea id="desc" className="desc-text" aria-label="Description" placeholder="What is this for? Markdown is fine." value={d.description} onChange={(e) => patch({ description: e.target.value })} />
            {isCollection && entry && entry.sync.teamId && (
              <p className="muted small">
                This collection belongs to team “{locationLabel(entry.sync.teamId)}”: everyone with access to the team&apos;s storage container can read it. Saves mark it as changed; use Sync to upload.
              </p>
            )}
            {isCollection && entry && !entry.sync.teamId && (
              <p className="muted small">Personal — stored on this machine only and never uploaded. Right-click the collection → Move to… to share it with a team.</p>
            )}
            {isCollection && entry && <ScriptVaultAccessToggle collectionId={tab.collectionId} refreshKey={entry} focus={tab.focusVaultAccess} />}
          </div>
        )}
        {section === 'auth' && (
          <div className="scroll-pad">
            <p className="muted small">{isCollection ? 'Requests and folders set to "Inherit" use this auth.' : 'Requests in this folder set to "Inherit" use this auth.'}</p>
            <AuthEditor auth={d.auth} onChange={(auth) => patch({ auth })} collectionId={tab.collectionId} parentRef={parentRef} allowInherit={!isCollection} />
          </div>
        )}
        {section === 'variables' && isCollection && (
          <div className="scroll-pad">
            <p className="muted small">Collection variables apply to every request in this collection. Environment variables override them.</p>
            <VariablesGrid testId="collection-vars" rows={d.variables} onChange={(variables) => patch({ variables })} />
          </div>
        )}
        {section === 'scripts' && <ScriptEditor pre={d.preRequestScript} test={d.testScript} onChange={(p) => patch(p)} />}
      </div>
    </div>
  )
}

/**
 * This machine's permission for the collection's scripts to read Key Vault secrets. Stored in userData
 * by main (never synced); it turns itself off when the scripts change through sync.
 */
function ScriptVaultAccessToggle({ collectionId, refreshKey, focus }: { collectionId: string; refreshKey: unknown; focus?: number }): React.JSX.Element {
  const [access, setAccess] = useState<ScriptVaultAccess | null>(null)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let live = true
    void attempt(courier().collections.getScriptVaultAccess(collectionId), { quiet: true }).then((a) => live && a && setAccess(a))
    return () => {
      live = false
    }
  }, [collectionId, refreshKey])
  useEffect(() => {
    if (!focus || !ref.current) return
    ref.current.scrollIntoView({ block: 'center' })
    ref.current.querySelector('input')?.focus()
  }, [focus, access !== null])
  const toggle = async (allowed: boolean): Promise<void> => {
    const previous = access
    setBusy(true)
    setAccess({ allowed }) // optimistic; reverted if main refuses
    const a = await attempt(courier().collections.setScriptVaultAccess({ id: collectionId, allowed }))
    setBusy(false)
    setAccess(a ?? previous)
  }
  return (
    <div className={`vault-access${focus ? ' focused' : ''}`} ref={ref} data-testid="script-vault-access" data-allowed={access?.allowed === true}>
      <div className="section-title">Scripts and Key Vault (this machine)</div>
      <label className="check">
        <input type="checkbox" data-testid="script-vault-toggle" checked={access?.allowed === true} disabled={!access || busy} onChange={(e) => void toggle(e.target.checked)} /> Allow this collection&apos;s scripts to read Key Vault secrets
      </label>
      <p className="muted small">
        Scripts run with your Azure identity, so anyone who can edit this collection (for example through sync) could write a script that reads your secrets and sends them elsewhere — only allow it if you trust every script in it.
      </p>
      <p className="muted small">
        This choice is stored on this machine only and is never synced. It turns off by itself when the scripts change in a sync; your own saves keep it. <code>{'{{vault:…}}'}</code> references in requests work either way.
      </p>
      {access && !access.allowed && access.lapsed && (
        <div className="warn-box small" data-testid="script-vault-lapsed">
          Turned off {timeAgo(access.lapsed.at)} because the scripts changed in a sync{access.lapsed.updatedBy ? ` (last updated by ${access.lapsed.updatedBy})` : ''}. Review the scripts before allowing it again.
        </div>
      )}
    </div>
  )
}

/** Action shown next to a VAULT_NOT_APPROVED error: review the team's Key Vault hosts and approve them. */
export function ReviewTeamVaultsButton({ collectionId }: { collectionId: string | null | undefined }): React.JSX.Element | null {
  const teamId = useApp((s) => s.snapshot?.collections.find((c) => c.collection.id === collectionId)?.sync.teamId)
  const openDialog = useApp((s) => s.openDialog)
  if (!teamId) return null
  return (
    <button className="btn small" data-testid="review-team-vaults" onClick={() => openDialog({ type: 'teamVaults', teamId })}>
      Review team Key Vault…
    </button>
  )
}

/** Action shown next to a VAULT_SCRIPT_BLOCKED error. */
export function OpenScriptVaultSettingButton({ collectionId }: { collectionId: string | null | undefined }): React.JSX.Element | null {
  const exists = useApp((s) => Boolean(collectionId && s.snapshot?.collections.some((c) => c.collection.id === collectionId)))
  if (!collectionId || !exists) return null
  return (
    <button className="btn small" data-testid="open-script-vault-setting" onClick={() => openScriptVaultSetting(collectionId)}>
      Open collection settings
    </button>
  )
}

export function EnvironmentEditor({ tab }: { tab: EnvironmentTab }): React.JSX.Element {
  const updateTab = useApp((s) => s.updateTab)
  const snapshot = useApp((s) => s.snapshot)
  const entry = snapshot?.environments.find((e) => e.environment.id === tab.environmentId)
  const isActive = snapshot?.activeEnvironmentId === tab.environmentId
  const d = tab.draft
  const current = snapshot?.currentValues.environments[tab.environmentId] ?? {}
  const declared = new Set(d.variables.map((v) => v.key))
  const scriptOnly = Object.entries(current).filter(([k]) => !declared.has(k))
  return (
    <div className="doc-editor" data-testid="environment-editor">
      <div className="doc-header">
        <Icon name="layers" size={16} />
        <input className="title-input" aria-label="Environment name" value={d.name} onChange={(e) => updateTab(tab.id, (t) => ({ ...t, draft: { ...(t as EnvironmentTab).draft, name: e.target.value } }) as EnvironmentTab)} />
        {entry && (
          <span className="doc-meta">
            <LocationBadge teamId={entry.sync.teamId} /> {locationLabel(entry.sync.teamId)}
            {isActive && <span className="pill">active</span>}
          </span>
        )}
        <div className="grow" />
        <SaveBar tab={tab} />
      </div>
      <div className="section-body">
        <div className="scroll-pad">
          <p className="muted small">
            <strong>Shared value</strong> is what gets synced{entry?.sync.teamId ? ` to team “${locationLabel(entry.sync.teamId)}”` : ' when the environment is moved to a team'}. <strong>Current value</strong> overrides it on this machine only and is never uploaded. Use type <em>secret</em> for credentials, or <em>Key Vault</em> to reference a secret (e.g. <code>main/api-key</code>).
          </p>
          <VariablesGrid testId="env-vars" rows={d.variables} onChange={(variables) => updateTab(tab.id, (t) => ({ ...t, draft: { ...(t as EnvironmentTab).draft, variables } }) as EnvironmentTab)} />
          {scriptOnly.length > 0 && (
            <>
              <div className="section-title">Set by scripts (this machine only)</div>
              <table className="data-table">
                <tbody>
                  {scriptOnly.map(([k, v]) => (
                    <tr key={k}>
                      <td className="mono">{k}</td>
                      <td className="mono break">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export function GlobalsEditor({ tab }: { tab: GlobalsTab }): React.JSX.Element {
  const updateTab = useApp((s) => s.updateTab)
  return (
    <div className="doc-editor" data-testid="globals-editor">
      <div className="doc-header">
        <Icon name="globe" size={16} />
        <h2 className="title-static">Globals</h2>
        <div className="grow" />
        <SaveBar tab={tab} />
      </div>
      <div className="section-body">
        <div className="scroll-pad">
          <p className="muted small">Globals apply to every request and are stored on this machine only (never synced). Narrower scopes — environment, collection, data, local — override them.</p>
          <VariablesGrid testId="globals-vars" showCurrent={false} sharedLabel="Value" rows={globalsToRows(tab.draft)} onChange={(rows) => updateTab(tab.id, (t) => ({ ...t, draft: rowsToGlobals(rows) }) as GlobalsTab)} />
        </div>
      </div>
    </div>
  )
}
