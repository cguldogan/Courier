/** Key/value table with enable checkbox, description, trailing "new row", delete and bulk edit. */
import { useLayoutEffect, useRef, useState } from 'react'
import type { FormDataField, KeyValue } from '../../../shared/types'
import { attempt, courier } from '../api'
import { Icon, VarInput } from './ui'

type Row = KeyValue & Partial<Pick<FormDataField, 'kind' | 'filePath' | 'contentType'>>

function toBulk(rows: Row[]): string {
  return rows.map((r) => `${r.enabled ? '' : '//'}${r.key}:${r.value}`).join('\n')
}

function fromBulk(text: string, prev: Row[]): Row[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((line) => {
      let enabled = true
      let l = line
      if (l.startsWith('//')) {
        enabled = false
        l = l.slice(2)
      }
      const i = l.indexOf(':')
      const key = (i >= 0 ? l.slice(0, i) : l).trim()
      const value = i >= 0 ? l.slice(i + 1).trim() : ''
      const old = prev.find((p) => p.key === key)
      return { ...(old ?? {}), key, value, enabled, ...(old?.description ? { description: old.description } : {}) }
    })
}

export function KeyValueGrid<T extends Row>({
  rows,
  onChange,
  collectionId,
  testId,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
  formData,
  allowBulk = true,
  keySuggestions
}: {
  rows: T[]
  onChange: (rows: T[]) => void
  collectionId?: string | null
  testId: string
  keyPlaceholder?: string
  valuePlaceholder?: string
  formData?: boolean
  allowBulk?: boolean
  keySuggestions?: string[]
}): React.JSX.Element {
  const [bulk, setBulk] = useState<string | null>(null)
  const tableRef = useRef<HTMLTableElement>(null)
  const focusNext = useRef<string | null>(null)
  useLayoutEffect(() => {
    const label = focusNext.current
    if (!label) return
    focusNext.current = null
    const rowsEl = tableRef.current?.querySelectorAll('tr[data-testid="kv-row"]')
    const el = rowsEl?.[rowsEl.length - 1]?.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
    if (el) {
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
  }, [rows])
  const update = (i: number, patch: Partial<T>): void => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const remove = (i: number): void => onChange(rows.filter((_, j) => j !== i))
  const add = (patch: Partial<T>): void => {
    focusNext.current = 'key' in patch ? 'Key' : 'value' in patch ? 'Value' : 'Description'
    addRow(patch)
  }
  const addRow = (patch: Partial<T>): void => onChange([...rows, { key: '', value: '', enabled: true, ...(formData ? { kind: 'text' } : {}), ...patch } as T])
  const listId = keySuggestions ? `${testId}-keys` : undefined
  const allOn = rows.length > 0 && rows.every((r) => r.enabled)

  if (bulk !== null) {
    return (
      <div className="kv-bulk" data-testid={testId}>
        <div className="kv-toolbar">
          <span className="muted small">One per line: key:value — prefix with // to disable</span>
          <button className="link-btn" onClick={() => {
            onChange(fromBulk(bulk, rows) as T[])
            setBulk(null)
          }}>
            Key-value edit
          </button>
        </div>
        <textarea className="bulk-text mono" aria-label="Bulk edit" value={bulk} onChange={(e) => setBulk(e.target.value)} spellCheck={false} />
      </div>
    )
  }

  return (
    <div className="kv" data-testid={testId}>
      {listId && (
        <datalist id={listId}>
          {keySuggestions?.map((k) => <option key={k} value={k} />)}
        </datalist>
      )}
      <table className="kv-table" ref={tableRef}>
        <thead>
          <tr>
            <th className="kv-check">
              <input type="checkbox" aria-label="Toggle all" checked={allOn} disabled={!rows.length} onChange={(e) => onChange(rows.map((r) => ({ ...r, enabled: e.target.checked })))} />
            </th>
            <th>Key</th>
            {formData && <th className="kv-kind">Type</th>}
            <th>Value</th>
            <th>Description</th>
            <th className="kv-actions">
              {allowBulk && (
                <button className="link-btn small" onClick={() => setBulk(toBulk(rows))}>
                  Bulk edit
                </button>
              )}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={r.enabled ? '' : 'disabled'} data-testid="kv-row">
              <td className="kv-check">
                <input type="checkbox" aria-label={`Enable ${r.key || 'row'}`} checked={r.enabled} onChange={(e) => update(i, { enabled: e.target.checked } as Partial<T>)} />
              </td>
              <td>
                {listId ? (
                  <input className="cell" list={listId} aria-label="Key" value={r.key} placeholder={keyPlaceholder} spellCheck={false} onChange={(e) => update(i, { key: e.target.value } as Partial<T>)} />
                ) : (
                  <VarInput className="cell" ariaLabel="Key" value={r.key} placeholder={keyPlaceholder} collectionId={collectionId} onChange={(v) => update(i, { key: v } as Partial<T>)} />
                )}
              </td>
              {formData && (
                <td className="kv-kind">
                  <select className="cell" aria-label="Field type" value={r.kind ?? 'text'} onChange={(e) => update(i, { kind: e.target.value as 'text' | 'file', value: '', filePath: undefined } as Partial<T>)}>
                    <option value="text">Text</option>
                    <option value="file">File</option>
                  </select>
                </td>
              )}
              <td>
                {formData && r.kind === 'file' ? (
                  <div className="file-cell">
                    <button
                      className="btn small"
                      onClick={async () => {
                        const f = await attempt(courier().files.pickFile({ title: 'Choose file for form field' }))
                        if (f) update(i, { filePath: f.path, value: f.name } as Partial<T>)
                      }}
                    >
                      Choose file
                    </button>
                    <span className="muted ellipsis" title={r.filePath}>
                      {r.filePath ? r.value || r.filePath : 'No file selected'}
                    </span>
                  </div>
                ) : (
                  <VarInput className="cell" ariaLabel="Value" value={r.value} placeholder={valuePlaceholder} collectionId={collectionId} onChange={(v) => update(i, { value: v } as Partial<T>)} />
                )}
              </td>
              <td>
                <input className="cell" aria-label="Description" value={r.description ?? ''} placeholder="Description" onChange={(e) => update(i, { description: e.target.value } as Partial<T>)} />
              </td>
              <td className="kv-actions">
                <button className="icon-btn subtle" aria-label={`Delete ${r.key || 'row'}`} onClick={() => remove(i)}>
                  <Icon name="trash" size={13} />
                </button>
              </td>
            </tr>
          ))}
          <tr className="kv-new">
            <td className="kv-check" />
            <td>
              <input className="cell" aria-label="New key" list={listId} placeholder={keyPlaceholder} value="" spellCheck={false} onChange={(e) => add({ key: e.target.value } as Partial<T>)} />
            </td>
            {formData && <td className="kv-kind" />}
            <td>
              <input className="cell" aria-label="New value" placeholder={valuePlaceholder} value="" spellCheck={false} onChange={(e) => add({ value: e.target.value } as Partial<T>)} />
            </td>
            <td>
              <input className="cell" aria-label="New description" placeholder="Description" value="" onChange={(e) => add({ description: e.target.value } as Partial<T>)} />
            </td>
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  )
}
