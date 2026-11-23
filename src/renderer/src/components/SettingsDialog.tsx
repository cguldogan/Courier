/** Settings: account (sign-in mode), teams, Key Vault, request defaults, appearance. */
import { useState } from 'react'
import type { DeepPartial } from '../../../shared/api'
import type { IdentityMode, IdentitySettings, Settings, VaultConfig } from '../../../shared/types'
import { attempt, courier } from '../api'
import { reloadWorkspace, signOut } from '../actions'
import { useApp } from '../store'
import { TeamsSettings } from './TeamsSettings'
import { Icon, Modal, Spinner } from './ui'

type Section = 'account' | 'teams' | 'vault' | 'requests' | 'appearance'

const MODES: { id: IdentityMode; label: string; help: string }[] = [
  { id: 'auto', label: 'Automatic', help: 'Tries managed identity first, then the Azure CLI login.' },
  { id: 'azure-cli', label: 'Azure CLI', help: 'Uses your existing “az login” session on this machine.' },
  { id: 'browser', label: 'Browser sign-in', help: 'Opens the system browser to sign in interactively.' },
  { id: 'managed-identity', label: 'Managed identity', help: 'Only works when Courier runs on Azure-hosted compute (VM, AVD session host, Arc-enabled server).' }
]

export function SettingsDialog({ section: initial, onClose }: { section?: string; onClose: () => void }): React.JSX.Element {
  const saved = useApp((s) => s.settings)
  const identity = useApp((s) => s.identity)
  const [section, setSection] = useState<Section>((initial as Section) ?? 'account')
  const [draft, setDraft] = useState<Settings | null>(() => (saved ? structuredClone(saved) : null))
  const [busy, setBusy] = useState(false)
  if (!draft) return <Modal title="Settings" onClose={onClose}><Spinner /></Modal>
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const patch = <K extends keyof Settings>(k: K, v: Partial<Settings[K]>): void => setDraft({ ...draft, [k]: { ...draft[k], ...v } })
  const setIdentity = (v: Partial<IdentitySettings>): void => {
    const next = { ...draft.identity, ...v }
    for (const k of ['tenantId', 'clientId', 'managedIdentityClientId'] as const) if (next[k] === '') delete next[k]
    setDraft({ ...draft, identity: next })
  }

  const save = async (): Promise<boolean> => {
    if (!dirty) return true
    setBusy(true)
    const p: DeepPartial<Settings> = {
      http: draft.http,
      scripts: draft.scripts,
      keyVault: { vaults: draft.keyVault.vaults.filter((v) => v.alias.trim() && v.url.trim()), cacheTtlSeconds: draft.keyVault.cacheTtlSeconds },
      ui: draft.ui,
      identity: { mode: draft.identity.mode, tenantId: draft.identity.tenantId ?? '', clientId: draft.identity.clientId ?? '', managedIdentityClientId: draft.identity.managedIdentityClientId ?? '' }
    }
    const r = await attempt(courier().settings.update(p))
    setBusy(false)
    if (!r) return false
    useApp.getState().set({ settings: r })
    setDraft(structuredClone(r))
    useApp.getState().toast('success', 'Settings saved')
    return true
  }

  const doSignIn = async (): Promise<void> => {
    setBusy(true)
    useApp.getState().set({ identity: identity ? { ...identity, busy: true } : identity })
    const r = await attempt(courier().identity.signIn(draft.identity), { context: 'Sign-in failed' })
    setBusy(false)
    if (r) {
      useApp.getState().set({ identity: r })
      if (r.signedIn) useApp.getState().toast('success', `Signed in as ${r.account?.upn ?? r.account?.name ?? 'Azure identity'}`)
      const s = await attempt(courier().settings.get())
      if (s) useApp.getState().set({ settings: s })
      await reloadWorkspace()
    } else {
      const st = await attempt(courier().identity.status(), { quiet: true })
      if (st) useApp.getState().set({ identity: st })
    }
  }

  const nav: { id: Section; label: string; icon: string }[] = [
    { id: 'account', label: 'Account', icon: 'user' },
    { id: 'teams', label: 'Teams', icon: 'users' },
    { id: 'vault', label: 'Key Vault', icon: 'key' },
    { id: 'requests', label: 'Requests', icon: 'globe' },
    { id: 'appearance', label: 'Appearance', icon: 'sun' }
  ]
  const vaults = draft.keyVault.vaults
  const setVaults = (v: VaultConfig[]): void => setDraft({ ...draft, keyVault: { ...draft.keyVault, vaults: v } })

  return (
    <Modal
      title="Settings"
      onClose={onClose}
      width={820}
      testId="settings-dialog"
      className="settings-modal"
      footer={
        <>
          {dirty && <span className="muted small grow">Unsaved changes</span>}
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" data-testid="settings-save" disabled={!dirty || busy} onClick={() => void save()}>
            {busy && <Spinner />} Save
          </button>
        </>
      }
    >
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {nav.map((n) => (
            <button key={n.id} className={`settings-nav-item ${section === n.id ? 'active' : ''}`} data-testid={`settings-nav-${n.id}`} aria-current={section === n.id} onClick={() => setSection(n.id)}>
              <Icon name={n.icon} size={13} /> {n.label}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {section === 'account' && (
            <div className="form-stack">
              <h3>Azure sign-in</h3>
              <p className="muted small">Courier uses your Azure (Entra ID) identity for cloud storage, Key Vault references and “Azure identity” request auth. Tokens never leave the main process.</p>
              <div className="radio-stack" role="radiogroup" aria-label="Sign-in mode">
                {MODES.map((m) => (
                  <label key={m.id} className="radio radio-card">
                    <input type="radio" name="mode" value={m.id} checked={draft.identity.mode === m.id} onChange={() => setIdentity({ mode: m.id })} />
                    <div>
                      <div className="strong">{m.label}</div>
                      <div className="muted small">{m.help}</div>
                    </div>
                  </label>
                ))}
              </div>
              {(draft.identity.mode === 'browser' || draft.identity.mode === 'azure-cli') && (
                <div className="form-grid">
                  <label htmlFor="tenant">Tenant ID</label>
                  <input id="tenant" placeholder={draft.identity.mode === 'browser' ? 'organizations' : 'default from az login'} value={draft.identity.tenantId ?? ''} onChange={(e) => setIdentity({ tenantId: e.target.value })} />
                  {draft.identity.mode === 'browser' && (
                    <>
                      <label htmlFor="client">Client ID</label>
                      <input id="client" placeholder="default: Azure CLI public client" value={draft.identity.clientId ?? ''} onChange={(e) => setIdentity({ clientId: e.target.value })} />
                    </>
                  )}
                </div>
              )}
              {(draft.identity.mode === 'managed-identity' || draft.identity.mode === 'auto') && (
                <div className="form-grid">
                  <label htmlFor="mi">User-assigned client ID</label>
                  <input id="mi" placeholder="empty = system-assigned identity" value={draft.identity.managedIdentityClientId ?? ''} onChange={(e) => setIdentity({ managedIdentityClientId: e.target.value })} />
                </div>
              )}
              <div className="status-card">
                {identity?.signedIn ? (
                  <>
                    <Icon name="check" className="good-text" />
                    <div className="grow">
                      Signed in as <strong>{identity.account?.upn ?? identity.account?.name}</strong> <span className="muted">({identity.mode}{identity.fake ? ', test identity' : ''})</span>
                    </div>
                    <button className="btn small" onClick={() => void signOut()}>
                      Sign out
                    </button>
                    <button className="btn small" disabled={busy} onClick={() => void doSignIn()}>
                      Sign in again
                    </button>
                  </>
                ) : (
                  <>
                    <Icon name="user" />
                    <div className="grow">
                      Not signed in{identity?.error ? <div className="error-text small">{identity.error}</div> : null}
                    </div>
                    <button className="btn primary small" data-testid="settings-sign-in" disabled={busy || identity?.busy} onClick={() => void doSignIn()}>
                      {(busy || identity?.busy) && <Spinner />} Sign in
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
          {section === 'teams' && <TeamsSettings />}
          {section === 'vault' && (
            <div className="form-stack">
              <h3>Azure Key Vault</h3>
              <p className="muted small">
                Your own vaults. Reference secrets anywhere variables work: <code>{'{{vault:secret-name}}'}</code> uses the first vault, <code>{'{{vault:alias/secret-name}}'}</code> a specific one, and <code>@version</code> pins a version. In a team&apos;s collections the team&apos;s vaults (Settings → Teams) are looked up first, then these; a bare <code>{'{{vault:name}}'}</code> uses the team&apos;s first vault there. Values are fetched at send time with your identity, cached in memory only, and masked in history and logs.
              </p>
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
                    <tr key={i} data-testid="vault-config-row">
                      <td>
                        <input className="cell mono" aria-label="Vault alias" value={v.alias} onChange={(e) => setVaults(vaults.map((x, j) => (j === i ? { ...x, alias: e.target.value } : x)))} />
                      </td>
                      <td>
                        <input className="cell mono" aria-label="Vault URL" placeholder="https://my-vault.vault.azure.net" value={v.url} onChange={(e) => setVaults(vaults.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} />
                      </td>
                      <td className="kv-actions">
                        <button className="icon-btn subtle" aria-label={`Remove vault ${v.alias}`} onClick={() => setVaults(vaults.filter((_, j) => j !== i))}>
                          <Icon name="trash" size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="row-gap">
                <button className="btn small" data-testid="add-vault" onClick={() => setVaults([...vaults, { alias: vaults.length ? `vault${vaults.length + 1}` : 'main', url: '' }])}>
                  <Icon name="plus" size={12} /> Add vault
                </button>
                {vaults.length > 0 && <span className="muted small">“{vaults[0].alias || '…'}” is the default vault.</span>}
              </div>
              <div className="form-grid">
                <label htmlFor="ttl">Cache lifetime (seconds)</label>
                <input id="ttl" type="number" min={0} value={draft.keyVault.cacheTtlSeconds} onChange={(e) => patch('keyVault', { cacheTtlSeconds: Math.max(0, Number(e.target.value) || 0) })} />
              </div>
              <div className="info-box small">
                <strong>Roles needed on the vault:</strong> “Key Vault Secrets User” to read secrets, “Key Vault Secrets Officer” to create new versions from the Key Vault browser.
              </div>
            </div>
          )}
          {section === 'requests' && (
            <div className="form-stack">
              <h3>Request defaults</h3>
              <div className="form-grid">
                <label htmlFor="to">Timeout (ms, 0 = none)</label>
                <input id="to" type="number" min={0} value={draft.http.timeoutMs} onChange={(e) => patch('http', { timeoutMs: Math.max(0, Number(e.target.value) || 0) })} />
                <span />
                <label className="check">
                  <input type="checkbox" checked={draft.http.followRedirects} onChange={(e) => patch('http', { followRedirects: e.target.checked })} /> Follow redirects
                </label>
                <label htmlFor="mr">Max redirects</label>
                <input id="mr" type="number" min={0} max={50} value={draft.http.maxRedirects} onChange={(e) => patch('http', { maxRedirects: Math.max(0, Number(e.target.value) || 0) })} />
                <span />
                <label className="check">
                  <input type="checkbox" checked={draft.http.verifyTls} onChange={(e) => patch('http', { verifyTls: e.target.checked })} /> Verify TLS certificates
                </label>
                <label htmlFor="mx">Max response size shown (MB)</label>
                <input id="mx" type="number" min={1} value={Math.round(draft.http.maxResponseBytes / 1048576)} onChange={(e) => patch('http', { maxResponseBytes: Math.max(1, Number(e.target.value) || 1) * 1048576 })} />
              </div>
              <h3>Scripts</h3>
              <div className="form-grid">
                <label htmlFor="sto">Script timeout (ms)</label>
                <input id="sto" type="number" min={100} value={draft.scripts.timeoutMs} onChange={(e) => patch('scripts', { timeoutMs: Math.max(100, Number(e.target.value) || 100) })} />
                <label htmlFor="smem">Script memory limit (MB)</label>
                <input id="smem" type="number" min={8} value={draft.scripts.memoryLimitMb} onChange={(e) => patch('scripts', { memoryLimitMb: Math.max(8, Number(e.target.value) || 8) })} />
              </div>
            </div>
          )}
          {section === 'appearance' && (
            <div className="form-stack">
              <h3>Appearance</h3>
              <div className="form-grid">
                <label htmlFor="theme">Theme</label>
                <select id="theme" data-testid="theme-select" value={(draft.ui.theme as string) ?? 'system'} onChange={(e) => setDraft({ ...draft, ui: { ...draft.ui, theme: e.target.value } })}>
                  <option value="system">Follow system</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
                <label htmlFor="layout">Response layout</label>
                <select id="layout" value={(draft.ui.layout as string) ?? 'vertical'} onChange={(e) => setDraft({ ...draft, ui: { ...draft.ui, layout: e.target.value } })}>
                  <option value="vertical">Response below request</option>
                  <option value="horizontal">Side by side</option>
                </select>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
