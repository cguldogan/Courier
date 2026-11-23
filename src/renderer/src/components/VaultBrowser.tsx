/** Key Vault browser: list names, reveal on demand (auto-hide), copy reference, new version, clear cache. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SecretSummary } from '../../../shared/types'
import { CourierError } from '../../../shared/api'
import { call, courier, errorCode, errorMessage, succeeded } from '../api'
import { useApp } from '../store'
import { Icon, Modal, Spinner, copyText, timeAgo } from './ui'

const REVEAL_SECONDS = 20

function explain(code: string | undefined, message: string): string {
  if (code === 'FORBIDDEN' && !/Key Vault Secrets/i.test(message)) return `${message} Ask an admin for the “Key Vault Secrets User” role (read) or “Key Vault Secrets Officer” (create versions) on this vault.`
  if (code === 'NOT_SIGNED_IN') return `${message} Sign in first (top right).`
  return message
}

export function VaultBrowser({ onClose }: { onClose: () => void }): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const openDialog = useApp((s) => s.openDialog)
  const vaults = settings?.keyVault.vaults ?? []
  const [alias, setAlias] = useState(vaults[0]?.alias ?? '')
  const [list, setList] = useState<SecretSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [revealed, setRevealed] = useState<Record<string, { value: string; until: number }>>({})
  const [editing, setEditing] = useState<string | null>(null)
  const [newValue, setNewValue] = useState('')
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [, tick] = useState(0)
  const timer = useRef<number | undefined>(undefined)

  const load = useCallback(async () => {
    if (!alias) return
    setLoading(true)
    setError(null)
    try {
      setList(await call(courier().vault.list({ alias }), { quiet: true }))
    } catch (err) {
      setList(null)
      setError(explain(errorCode(err), errorMessage(err)))
    } finally {
      setLoading(false)
    }
  }, [alias])

  useEffect(() => {
    void load()
  }, [load])

  // auto-hide revealed values
  useEffect(() => {
    timer.current = window.setInterval(() => {
      const now = Date.now()
      setRevealed((r) => {
        const next = Object.fromEntries(Object.entries(r).filter(([, v]) => v.until > now))
        return Object.keys(next).length === Object.keys(r).length ? r : next
      })
      tick((t) => t + 1)
    }, 1000)
    return () => window.clearInterval(timer.current)
  }, [])
  useEffect(() => () => setRevealed({}), [])

  const reveal = async (name: string): Promise<void> => {
    try {
      const v = await call(courier().vault.get({ alias, name }), { quiet: true })
      setRevealed((r) => ({ ...r, [name]: { value: v.value, until: Date.now() + REVEAL_SECONDS * 1000 } }))
    } catch (err) {
      useApp.getState().toast('error', explain(errorCode(err), errorMessage(err)))
    }
  }

  const setSecret = async (name: string, value: string): Promise<boolean> => {
    setBusy(true)
    try {
      await call(courier().vault.set({ alias, name, value }), { quiet: true })
      useApp.getState().toast('success', `Saved a new version of "${name}"`)
      await load()
      return true
    } catch (err) {
      useApp.getState().toast('error', explain(err instanceof CourierError ? err.code : undefined, errorMessage(err)))
      return false
    } finally {
      setBusy(false)
    }
  }

  const ref = (name: string): string => `{{vault:${alias === vaults[0]?.alias ? '' : alias + '/'}${name}}}`
  const shown = (list ?? []).filter((s) => !filter || s.name.toLowerCase().includes(filter.toLowerCase()))

  return (
    <Modal
      title="Key Vault secrets"
      onClose={() => {
        setRevealed({})
        onClose()
      }}
      width={820}
      testId="vault-browser"
      footer={
        <>
          <span className="muted small grow">Revealed values hide after {REVEAL_SECONDS} s and are never stored. References are resolved at send time.</span>
          <button
            className="btn"
            data-testid="vault-clear-cache"
            onClick={async () => {
              if (await succeeded(courier().vault.clearCache())) useApp.getState().toast('success', 'Key Vault cache cleared')
            }}
          >
            Clear cache
          </button>
        </>
      }
    >
      {vaults.length === 0 ? (
        <div className="onboard-inline">
          <p>No Key Vault configured. Add a vault (alias + URL) to reference secrets as {'{{vault:alias/secret-name}}'}.</p>
          <button className="btn primary" onClick={() => openDialog({ type: 'settings', section: 'vault' })}>
            Configure Key Vault
          </button>
        </div>
      ) : (
        <>
          <div className="row-gap">
            <select aria-label="Vault" data-testid="vault-select" value={alias} onChange={(e) => setAlias(e.target.value)}>
              {vaults.map((v) => (
                <option key={v.alias} value={v.alias}>
                  {v.alias} — {v.url.replace(/^https:\/\//, '')}
                </option>
              ))}
            </select>
            <div className="search-box grow">
              <Icon name="search" size={12} />
              <input aria-label="Filter secrets" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <button className="icon-btn" aria-label="Refresh" onClick={() => void load()}>
              <Icon name="sync" />
            </button>
          </div>
          {error && (
            <div className="error-box small" data-testid="vault-error">
              <Icon name="warn" /> <div>{error}</div>
            </div>
          )}
          {loading && !list && <Spinner />}
          {list && (
            <table className="data-table vault-table" data-testid="vault-secrets">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Value</th>
                  <th>Updated</th>
                  <th className="kv-actions" />
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => {
                  const rv = revealed[s.name]
                  return (
                    <tr key={s.name} data-testid="vault-secret" data-name={s.name} className={s.enabled ? '' : 'disabled'}>
                      <td className="mono">
                        {s.name}
                        {!s.enabled && <span className="muted small"> (disabled)</span>}
                      </td>
                      <td className="mono">
                        {editing === s.name ? (
                          <div className="row-gap">
                            <input className="cell grow" type="password" aria-label={`New value for ${s.name}`} autoFocus value={newValue} onChange={(e) => setNewValue(e.target.value)} />
                            <button
                              className="btn small primary"
                              disabled={busy || !newValue}
                              onClick={async () => {
                                if (await setSecret(s.name, newValue)) {
                                  setEditing(null)
                                  setNewValue('')
                                }
                              }}
                            >
                              Save version
                            </button>
                            <button className="btn small" onClick={() => setEditing(null)}>
                              Cancel
                            </button>
                          </div>
                        ) : rv ? (
                          <span className="revealed" data-testid="revealed-value">
                            <span className="break">{rv.value}</span>
                            <span className="muted small"> · hides in {Math.max(0, Math.ceil((rv.until - Date.now()) / 1000))} s</span>
                          </span>
                        ) : (
                          <span className="muted">••••••••</span>
                        )}
                      </td>
                      <td className="small muted">{timeAgo(s.updatedOn)}</td>
                      <td className="kv-actions nowrap">
                        <div className="vault-actions">
                        {rv ? (
                          <>
                            <button className="icon-btn subtle" aria-label={`Copy value of ${s.name}`} title="Copy value" onClick={() => void copyText(rv.value, 'Secret value copied')}>
                              <Icon name="copy" size={13} />
                            </button>
                            <button className="icon-btn subtle" aria-label={`Hide ${s.name}`} onClick={() => setRevealed(({ [s.name]: _x, ...rest }) => rest)}>
                              <Icon name="eyeOff" size={13} />
                            </button>
                          </>
                        ) : (
                          <button className="icon-btn subtle" aria-label={`Reveal ${s.name}`} title="Reveal" onClick={() => void reveal(s.name)}>
                            <Icon name="eye" size={13} />
                          </button>
                        )}
                        <button className="btn small" title={ref(s.name)} onClick={() => void copyText(ref(s.name), `Copied ${ref(s.name)}`)}>
                          Copy reference
                        </button>
                        <button
                          className="btn small"
                          onClick={() => {
                            setEditing(s.name)
                            setNewValue('')
                          }}
                        >
                          New version
                        </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      No secrets{filter ? ' match' : ' in this vault'}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
          <div className="section-title">Add a secret</div>
          <div className="row-gap">
            <input aria-label="Secret name" placeholder="secret-name" className="mono" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <input aria-label="Secret value" placeholder="value" type="password" className="grow" value={editing === null ? newValue : ''} disabled={editing !== null} onChange={(e) => setNewValue(e.target.value)} />
            <button
              className="btn primary"
              disabled={busy || !newName.trim() || !newValue || editing !== null}
              onClick={async () => {
                if (await setSecret(newName.trim(), newValue)) {
                  setNewName('')
                  setNewValue('')
                }
              }}
            >
              Add
            </button>
          </div>
          <p className="muted small">Names may contain letters, digits and dashes. Creating or updating needs the “Key Vault Secrets Officer” role.</p>
        </>
      )}
    </Modal>
  )
}
