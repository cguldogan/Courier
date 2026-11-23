/** Breadcrumb, editable name and Save / Save As (and Code for HTTP) above every request editor. */
import { useState } from 'react'
import { saveTab } from '../actions'
import { type RequestTab, isDirty, locate, useApp } from '../store'
import { Icon } from './ui'

export function RequestHeader({ tab, code }: { tab: RequestTab; code?: boolean }): React.JSX.Element {
  const updateTab = useApp((s) => s.updateTab)
  const openDialog = useApp((s) => s.openDialog)
  const snapshot = useApp((s) => s.snapshot)
  const [editingName, setEditingName] = useState(false)
  const d = tab.draft
  const found = tab.collectionId && tab.requestId ? locate(tab.collectionId, tab.requestId) : undefined
  const parents = found?.parents ?? []
  const collection = snapshot?.collections.find((c) => c.collection.id === tab.collectionId)?.collection
  const dirty = isDirty(tab)
  const rename = (name: string): void => updateTab(tab.id, (t) => ({ ...t, draft: { ...(t as RequestTab).draft, name } }) as RequestTab)
  return (
    <div className="req-header">
      <div className="breadcrumb">
        {collection ? (
          <>
            <span className="crumb">{collection.name}</span>
            {parents.map((p) => (
              <span key={p.id} className="crumb">
                {p.name}
              </span>
            ))}
          </>
        ) : (
          <span className="crumb muted">{tab.requestId ? '' : 'Unsaved request'}</span>
        )}
        {editingName ? (
          <input
            className="name-input"
            aria-label="Request name"
            data-testid="request-name-input"
            autoFocus
            defaultValue={d.name}
            onBlur={(e) => {
              rename(e.target.value.trim() || d.name)
              setEditingName(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setEditingName(false)
            }}
          />
        ) : (
          <button className="crumb crumb-name" title="Rename" aria-label="Rename request" data-testid="request-name" onClick={() => setEditingName(true)}>
            {d.name}
          </button>
        )}
        {dirty && <span className="dirty-dot" title="Unsaved changes" />}
      </div>
      <div className="req-header-actions">
        <button className="btn" data-testid="save-button" aria-label="Save" onClick={() => void saveTab(tab.id)} title="Save (⌘/Ctrl+S)">
          <Icon name="save" /> Save
        </button>
        <button className="btn" aria-label="Save as" onClick={() => openDialog({ type: 'saveAs', tabId: tab.id })} data-testid="save-as-button">
          Save As…
        </button>
        {code && (
          <button className="btn" data-testid="code-button" aria-label="Generate code" onClick={() => openDialog({ type: 'snippet', tabId: tab.id })} title="Generate code">
            <Icon name="code" /> Code
          </button>
        )}
      </div>
    </div>
  )
}
