/** Variables table: key, type (default/secret/vault), shared value (synced) and current value (this machine). */
import { useLayoutEffect, useRef, useState } from 'react'
import type { Variable, VariableType } from '../../../shared/types'
import { parseVaultRef } from '../../../shared/variables'
import type { VarRow } from '../store'
import { Icon } from './ui'

const TYPE_HELP: Record<VariableType, string> = {
  default: 'Plain value. The shared value is synced; the current value stays on this machine.',
  secret: 'Secret: never written to synced documents. The value lives only on this machine (current value).',
  vault: 'Key Vault reference (alias/secret-name[@version]). Resolved at send time through your Azure identity.'
}

export function VariablesGrid({ rows, onChange, showCurrent = true, testId, sharedLabel = 'Shared value' }: { rows: VarRow[]; onChange: (rows: VarRow[]) => void; showCurrent?: boolean; testId: string; sharedLabel?: string }): React.JSX.Element {
  const [reveal, setReveal] = useState<Record<number, boolean>>({})
  const tableRef = useRef<HTMLTableElement>(null)
  const focusNew = useRef(false)
  useLayoutEffect(() => {
    if (!focusNew.current) return
    focusNew.current = false
    const all = tableRef.current?.querySelectorAll<HTMLInputElement>('tr[data-testid="var-row"] input[aria-label="Variable name"]')
    const el = all?.[all.length - 1]
    if (el) {
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
  }, [rows])
  const update = (i: number, patch: Partial<VarRow>): void => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <table className="kv-table var-table" data-testid={testId} ref={tableRef}>
      <thead>
        <tr>
          <th className="kv-check" />
          <th>Variable</th>
          <th className="var-type">Type</th>
          <th>{sharedLabel}</th>
          {showCurrent && <th title="Overrides the shared value on this machine only; never synced">Current value</th>}
          <th className="kv-actions" />
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const vaultBad = r.type === 'vault' && r.value !== '' && !parseVaultRef(r.value)
          return (
            <tr key={i} className={r.enabled ? '' : 'disabled'} data-testid="var-row">
              <td className="kv-check">
                <input type="checkbox" aria-label={`Enable ${r.key || 'variable'}`} checked={r.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} />
              </td>
              <td>
                <input className="cell mono" aria-label="Variable name" value={r.key} placeholder="name" spellCheck={false} onChange={(e) => update(i, { key: e.target.value })} />
              </td>
              <td className="var-type">
                <select className="cell" aria-label="Variable type" title={TYPE_HELP[r.type]} value={r.type} onChange={(e) => update(i, { type: e.target.value as VariableType })}>
                  <option value="default">default</option>
                  <option value="secret">secret</option>
                  <option value="vault">Key Vault</option>
                </select>
              </td>
              <td>
                {r.type === 'secret' && showCurrent ? (
                  <span className="cell-note" title={TYPE_HELP.secret}>
                    not synced
                  </span>
                ) : (
                  <input
                    className={`cell mono ${vaultBad ? 'invalid' : ''}`}
                    aria-label="Shared value"
                    type={r.type === 'secret' ? 'password' : 'text'}
                    value={r.value}
                    placeholder={r.type === 'vault' ? 'alias/secret-name' : 'value'}
                    title={vaultBad ? 'Not a valid Key Vault reference (alias/secret-name[@version])' : r.type === 'vault' ? TYPE_HELP.vault : undefined}
                    spellCheck={false}
                    onChange={(e) => update(i, { value: e.target.value })}
                  />
                )}
              </td>
              {showCurrent && (
                <td>
                  <div className="cell-with-btn">
                    <input
                      className="cell mono"
                      aria-label="Current value"
                      type={r.type === 'secret' && !reveal[i] ? 'password' : 'text'}
                      value={r.current}
                      placeholder={r.type === 'secret' ? 'secret value (this machine only)' : r.value ? 'same as shared' : ''}
                      spellCheck={false}
                      onChange={(e) => update(i, { current: e.target.value })}
                    />
                    {r.type === 'secret' && (
                      <button className="icon-btn subtle" aria-label={reveal[i] ? 'Hide value' : 'Show value'} onClick={() => setReveal({ ...reveal, [i]: !reveal[i] })}>
                        <Icon name={reveal[i] ? 'eyeOff' : 'eye'} size={13} />
                      </button>
                    )}
                  </div>
                </td>
              )}
              <td className="kv-actions">
                <button className="icon-btn subtle" aria-label={`Delete ${r.key || 'variable'}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                  <Icon name="trash" size={13} />
                </button>
              </td>
            </tr>
          )
        })}
        <tr className="kv-new">
          <td className="kv-check" />
          <td>
            <input
              className="cell mono"
              aria-label="New variable name"
              placeholder="Add variable"
              value=""
              onChange={(e) => {
                focusNew.current = true
                onChange([...rows, { key: e.target.value, value: '', current: '', enabled: true, type: 'default' }])
              }}
            />
          </td>
          <td colSpan={showCurrent ? 4 : 3} />
        </tr>
      </tbody>
    </table>
  )
}

/** Globals have no separate current value: edit `value` directly (they never leave this machine). */
export function globalsToRows(vars: Variable[]): VarRow[] {
  return vars.map((v) => ({ ...v, current: '' }))
}
export function rowsToGlobals(rows: VarRow[]): Variable[] {
  return rows.map(({ current: _c, ...v }) => v)
}
