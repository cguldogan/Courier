/** Left sidebar: Collections tree, Environments list, History. */
import { useMemo, useState } from 'react'
import type { CollectionEntry, EnvironmentEntry, HistoryEntry, Id, Item, SyncState, Team } from '../../../shared/types'
import { attempt, courier, succeeded } from '../api'
import {
  addFolder,
  addRequest,
  createCollection,
  deleteItem,
  duplicateItem,
  moveItem,
  moveItemToCollection,
  moveTo,
  openContainer,
  openDraft,
  openEnvironment,
  openGlobals,
  openRequest,
  openRunner,
  reloadHistory,
  reloadWorkspace,
  locationLabel,
  renameCollection,
  renameItem,
  runSync
} from '../actions'
import { useApp } from '../store'
import { Icon, LocationBadge, type MenuItem, MethodBadge, openMenuAt, openMenuBelow, statusClass, timeAgo } from './ui'

function syncIndicator(sync: SyncState): React.JSX.Element | null {
  if (sync.conflict)
    return (
      <span className="sync-ind conflict" title="Sync conflict — open Sync to resolve" data-testid="conflict-indicator">
        !
      </span>
    )
  if (sync.teamId && sync.dirty) return <span className="sync-ind dirty" title="Local changes not synced yet" data-testid="dirty-indicator" />
  if (sync.notice) return <span className="sync-ind notice" title={sync.notice}>i</span>
  return null
}

function matches(item: Item, q: string): boolean {
  if (!q) return true
  if (item.name.toLowerCase().includes(q)) return true
  if (item.type === 'request') return item.url.toLowerCase().includes(q)
  return item.items.some((i) => matches(i, q))
}

export function Sidebar(): React.JSX.Element {
  const tab = useApp((s) => s.sidebarTab)
  const set = useApp((s) => s.set)
  return (
    <aside className="sidebar" aria-label="Sidebar">
      <div className="sidebar-tabs" role="tablist">
        {(['collections', 'environments', 'history'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} data-testid={`sidebar-tab-${t}`} className={`sidebar-tab ${tab === t ? 'active' : ''}`} onClick={() => set({ sidebarTab: t })}>
            <Icon name={t === 'collections' ? 'box' : t === 'environments' ? 'layers' : 'clock'} />
            <span>{t[0].toUpperCase() + t.slice(1)}</span>
          </button>
        ))}
      </div>
      {tab === 'collections' && <CollectionsPanel />}
      {tab === 'environments' && <EnvironmentsPanel />}
      {tab === 'history' && <HistoryPanel />}
    </aside>
  )
}

function newCollectionDialog(teamId?: Id | null): void {
  const hasTeams = (useApp.getState().snapshot?.teams.length ?? 0) > 0
  useApp.getState().openDialog({
    type: 'prompt',
    title: teamId ? `New collection in ${locationLabel(teamId)}` : 'New collection',
    label: 'Name',
    initial: 'New Collection',
    confirmLabel: 'Create',
    locationChoice: hasTeams && teamId === undefined,
    onSubmit: (name, chosen) => createCollection(name, teamId ?? chosen ?? null)
  })
}

/** Groups for the sidebar: Personal, then every joined team (shown even when empty). */
function groupsOf<T extends { sync: SyncState }>(entries: T[], teams: Team[]): { teamId: Id | null; team?: Team; items: T[] }[] {
  return [
    { teamId: null, items: entries.filter((e) => !e.sync.teamId) },
    ...teams.map((t) => ({ teamId: t.id, team: t, items: entries.filter((e) => e.sync.teamId === t.id) }))
  ]
}

/** Group header: name, item count, pending/conflict indicators and the team's last sync error. */
function GroupHeader({ teamId, team, count }: { teamId: Id | null; team?: Team; count: number }): React.JSX.Element {
  const status = useApp((s) => (teamId ? s.sync?.teams.find((t) => t.teamId === teamId) : undefined))
  const openDialog = useApp((s) => s.openDialog)
  if (!teamId)
    return (
      <div className="space-header" title="Stored on this machine only — never uploaded, works offline with no sign-in.">
        <LocationBadge teamId={null} /> Personal <span className="hint muted">this machine only</span>
        <span className="count">{count}</span>
      </div>
    )
  const err = status?.lastError
  const hint = err?.code === 'FORBIDDEN' ? ' Ask an administrator for "Storage Blob Data Contributor" (or "Storage Blob Data Reader" for read-only) on this team\'s container.' : ''
  const menu = (): MenuItem[] => [
    { label: 'New collection in this team', onClick: () => newCollectionDialog(teamId) },
    { label: 'Sync this team', onClick: () => void runSync(false, teamId) },
    { label: 'Team settings…', onClick: () => openDialog({ type: 'settings', section: 'teams' }) },
    ...((team?.vaults.length ?? 0) > 0 ? [{ label: 'Team Key Vaults…', onClick: () => openDialog({ type: 'teamVaults', teamId }) }] : [])
  ]
  return (
    <div className="space-header" title={`${team?.accountUrl ?? ''}/${team?.container ?? ''}`} onContextMenu={(e) => openMenuAt(e, menu())} data-testid="team-header">
      <LocationBadge teamId={teamId} /> <span className="team-name">{team?.name ?? 'Team'}</span>
      <span className="team-state">
        {(status?.conflicts.length ?? 0) > 0 && (
          <span className="sync-ind conflict" title={`${status!.conflicts.length} conflict(s) — open Sync to resolve`} data-testid="team-conflicts">
            !
          </span>
        )}
        {(status?.pending ?? 0) > 0 && (
          <span className="team-pending" title={`${status!.pending} change(s) not synced yet`} data-testid="team-pending">
            ●{status!.pending}
          </span>
        )}
        {err && (
          <span className="team-error-badge" data-testid="team-error-badge" data-code={err.code} title={`Last sync failed: ${err.message}${hint}`} onClick={() => openDialog({ type: 'sync' })}>
            !
          </span>
        )}
        <span className="count">{count}</span>
      </span>
      <button
        className="icon-btn row-menu"
        aria-label={`Actions for team ${team?.name ?? ''}`}
        onClick={(e) => {
          e.stopPropagation()
          openMenuBelow(e.currentTarget, menu())
        }}
      >
        <Icon name="dots" />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------------------------

interface DragData {
  collectionId: string
  itemId: string
}
let dragging: DragData | null = null

function CollectionsPanel(): React.JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const openDialog = useApp((s) => s.openDialog)
  const [filter, setFilter] = useState('')
  const q = filter.trim().toLowerCase()
  const cols = snapshot?.collections ?? []
  const shown = cols.filter((c) => !q || c.collection.name.toLowerCase().includes(q) || c.collection.items.some((i) => matches(i, q)))
  const groups = groupsOf(shown, snapshot?.teams ?? []).filter((g) => g.items.length || (!q && g.teamId !== null))
  return (
    <div className="panel">
      <div className="panel-toolbar">
        <button className="icon-btn" aria-label="New collection" data-testid="new-collection" title="New collection" onClick={() => newCollectionDialog()}>
          <Icon name="plus" />
        </button>
        <div className="search-box grow">
          <Icon name="search" size={12} />
          <input aria-label="Filter collections" data-testid="collection-filter" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <button className="btn small" data-testid="import-button" onClick={() => openDialog({ type: 'import' })} title="Import Postman, OpenAPI, cURL">
          <Icon name="import" size={12} /> Import
        </button>
      </div>
      <div className="tree" role="tree" aria-label="Collections">
        {cols.length === 0 && !snapshot?.teams.length && (
          <div className="panel-empty">
            <p>No collections yet.</p>
            <button className="btn small" onClick={() => newCollectionDialog()}>
              Create collection
            </button>
            <button className="btn small" onClick={() => openDialog({ type: 'import' })}>
              Import
            </button>
          </div>
        )}
        {cols.length > 0 && groups.length === 0 && <p className="panel-empty muted">No matches.</p>}
        {groups.map((g) => (
          <div key={g.teamId ?? 'personal'} className="space-group" data-testid={g.teamId ? 'team-group' : 'personal-group'} data-team-id={g.teamId ?? undefined} data-team-name={g.team?.name}>
            <GroupHeader teamId={g.teamId} team={g.team} count={g.items.length} />
            {g.items.map((c) => (
              <CollectionNode key={c.collection.id} entry={c} q={q} />
            ))}
            {g.teamId && !g.items.length && (
              <div className="tree-empty muted small" style={{ paddingLeft: 34 }}>
                No collections yet — use “Move to…” or{' '}
                <button className="link-btn small" onClick={() => newCollectionDialog(g.teamId)}>
                  create one
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function moveMenu(kind: 'collection' | 'environment', id: string, name: string, current: Id | null): MenuItem {
  const teams = useApp.getState().snapshot?.teams ?? []
  const targets: (Id | null)[] = [null, ...teams.map((t) => t.id)]
  return {
    label: 'Move to…',
    submenu: [
      ...targets.map((t) => ({
        label: `${t ? `Team: ${locationLabel(t)}` : 'Personal'}${t === current ? ' (current)' : ''}`,
        disabled: t === current,
        hint: t === null ? 'this machine' : undefined,
        onClick: () => void moveTo(kind, id, name, t)
      })),
      ...(teams.length ? [] : [{ label: 'Join a team…', onClick: () => useApp.getState().openDialog({ type: 'settings', section: 'teams' }) }])
    ]
  }
}

function syncMenu(kind: 'collection' | 'environment', sync: SyncState, id: string, name: string): MenuItem[] {
  const out: MenuItem[] = []
  if (sync.conflict) out.push({ label: 'Resolve conflict…', onClick: () => useApp.getState().openDialog({ type: 'conflict', kind, id }) })
  if (sync.teamId && (sync.dirty || sync.conflict) && sync.etag)
    out.push({
      label: 'Discard local changes',
      onClick: () =>
        useApp.getState().openDialog({
          type: 'confirm',
          title: 'Discard local changes?',
          message: `Your unsynced changes to "${name}" are dropped and the cloud version is downloaded again.`,
          confirmLabel: 'Discard',
          danger: true,
          onConfirm: async () => {
            const r = await attempt(courier().sync.discardLocalChanges({ kind, id }))
            if (r) {
              useApp.getState().toast('success', `Re-downloaded "${name}"`)
              await reloadWorkspace()
            }
          }
        })
    })
  return out
}

function CollectionNode({ entry, q }: { entry: CollectionEntry; q: string }): React.JSX.Element {
  const c = entry.collection
  const expanded = useApp((s) => s.expanded[c.id] ?? false) || !!q
  const renaming = useApp((s) => s.renaming === c.id)
  const set = useApp((s) => s.set)
  const openDialog = useApp((s) => s.openDialog)
  const [dropHint, setDropHint] = useState(false)
  const toggle = (): void => set({ expanded: { ...useApp.getState().expanded, [c.id]: !expanded } })
  const menu = (): MenuItem[] => [
    { label: 'Add request', onClick: () => void addRequest(c.id, null) },
    { label: 'Add folder', onClick: () => openDialog({ type: 'prompt', title: 'New folder', label: 'Folder name', initial: 'New Folder', confirmLabel: 'Create', onSubmit: (n) => addFolder(c.id, null, n) }) },
    { separator: true, label: '' },
    { label: 'Settings, auth & variables', onClick: () => openContainer(c.id, null) },
    { label: 'Run collection', onClick: () => openRunner(c.id, null) },
    { separator: true, label: '' },
    { label: 'Rename', hint: 'F2', onClick: () => set({ renaming: c.id }) },
    {
      label: 'Duplicate',
      onClick: async () => {
        if (await attempt(courier().collections.duplicate(c.id))) await reloadWorkspace()
      }
    },
    moveMenu('collection', c.id, c.name, entry.sync.teamId ?? null),
    ...syncMenu('collection', entry.sync, c.id, c.name),
    { label: 'Export…', onClick: () => openDialog({ type: 'export', kind: 'collection', id: c.id, name: c.name }) },
    { separator: true, label: '' },
    {
      label: 'Delete',
      danger: true,
      onClick: () =>
        openDialog({
          type: 'confirm',
          title: 'Delete collection?',
          message: !entry.sync.teamId ? `"${c.name}" and all its requests will be deleted from this machine.` : `"${c.name}" will be deleted here and from team "${locationLabel(entry.sync.teamId)}" for everyone.`,
          confirmLabel: 'Delete',
          danger: true,
          onConfirm: async () => {
            if (await succeeded(courier().collections.delete(c.id))) await reloadWorkspace()
          }
        })
    }
  ]
  return (
    <div className="tree-group" role="treeitem" aria-expanded={expanded} aria-label={c.name}>
      <div
        className={`tree-row collection-row ${dropHint ? 'drop-into' : ''}`}
        data-testid="tree-node"
        data-kind="collection"
        data-name={c.name}
        tabIndex={0}
        onClick={toggle}
        onDoubleClick={() => openContainer(c.id, null)}
        onContextMenu={(e) => openMenuAt(e, menu())}
        onKeyDown={(e) => {
          if (e.key === 'F2') set({ renaming: c.id })
          if (e.key === 'Enter') toggle()
        }}
        onDragOver={(e) => {
          if (dragging?.collectionId === c.id || dragging) {
            e.preventDefault()
            setDropHint(true)
          }
        }}
        onDragLeave={() => setDropHint(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDropHint(false)
          const d = dragging
          dragging = null
          if (!d) return
          if (d.collectionId === c.id) void moveItem(c.id, d.itemId, null, c.items.length)
          else void moveItemToCollection(d.collectionId, d.itemId, c.id, null)
        }}
      >
        <Icon name="chevron" size={11} className={`twisty ${expanded ? 'open' : ''}`} />
        <Icon name="box" size={13} className="node-icon" />
        {renaming ? <InlineRename initial={c.name} onDone={(n) => void (n ? renameCollection(c.id, n) : null)} /> : <span className="node-name">{c.name}</span>}
        {syncIndicator(entry.sync)}
        <button
          className="icon-btn row-menu"
          aria-label={`Actions for ${c.name}`}
          onClick={(e) => {
            e.stopPropagation()
            openMenuBelow(e.currentTarget, menu())
          }}
        >
          <Icon name="dots" />
        </button>
      </div>
      {expanded && (
        <div role="group">
          {c.items.filter((i) => matches(i, q)).map((it) => (
            <ItemNode key={it.id} item={it} collectionId={c.id} depth={1} q={q} />
          ))}
          {c.items.length === 0 && (
            <div className="tree-empty" style={{ paddingLeft: 34 }}>
              <button className="link-btn small" onClick={() => void addRequest(c.id, null)}>
                Add a request
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function InlineRename({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }): React.JSX.Element {
  const set = useApp((s) => s.set)
  let finished = false
  const finish = (v: string | null): void => {
    if (finished) return
    finished = true
    set({ renaming: null })
    onDone(v && v.trim() && v.trim() !== initial ? v.trim() : null)
  }
  return (
    <input
      className="inline-rename"
      aria-label="New name"
      data-testid="inline-rename"
      autoFocus
      defaultValue={initial}
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish((e.target as HTMLInputElement).value)
        if (e.key === 'Escape') finish(null)
      }}
    />
  )
}

function ItemNode({ item, collectionId, depth, q }: { item: Item; collectionId: string; depth: number; q: string }): React.JSX.Element {
  const expanded = useApp((s) => s.expanded[item.id] ?? false) || !!q
  const renaming = useApp((s) => s.renaming === item.id)
  const active = useApp((s) => {
    const t = s.tabs.find((x) => x.id === s.activeTabId)
    return (t?.kind === 'request' && t.requestId === item.id) || (t?.kind === 'container' && t.folderId === item.id)
  })
  const set = useApp((s) => s.set)
  const openDialog = useApp((s) => s.openDialog)
  const [drop, setDrop] = useState<'before' | 'into' | null>(null)
  const pad = 12 + depth * 14
  const isFolder = item.type === 'folder'
  const toggle = (): void => set({ expanded: { ...useApp.getState().expanded, [item.id]: !expanded } })

  const menu = (): MenuItem[] => [
    ...(isFolder
      ? [
          { label: 'Add request', onClick: () => void addRequest(collectionId, item.id) },
          { label: 'Add folder', onClick: () => openDialog({ type: 'prompt', title: 'New folder', label: 'Folder name', initial: 'New Folder', confirmLabel: 'Create', onSubmit: (n) => addFolder(collectionId, item.id, n) }) },
          { separator: true, label: '' },
          { label: 'Settings, auth & scripts', onClick: () => openContainer(collectionId, item.id) },
          { label: 'Run folder', onClick: () => openRunner(collectionId, item.id) },
          { separator: true, label: '' }
        ]
      : [{ label: 'Open', onClick: () => openRequest(collectionId, item.id) }]),
    { label: 'Rename', hint: 'F2', onClick: () => set({ renaming: item.id }) },
    { label: 'Duplicate', onClick: () => void duplicateItem(collectionId, item.id) },
    { separator: true, label: '' },
    {
      label: 'Delete',
      danger: true,
      onClick: () =>
        openDialog({
          type: 'confirm',
          title: `Delete ${isFolder ? 'folder' : 'request'}?`,
          message: isFolder ? `"${item.name}" and everything inside it will be deleted.` : `"${item.name}" will be deleted.`,
          confirmLabel: 'Delete',
          danger: true,
          onConfirm: () => deleteItem(collectionId, item.id)
        })
    }
  ]

  return (
    <div role="treeitem" aria-expanded={isFolder ? expanded : undefined} aria-label={item.name} aria-selected={active}>
      <div
        className={`tree-row ${active ? 'active' : ''} ${drop === 'before' ? 'drop-before' : ''} ${drop === 'into' ? 'drop-into' : ''}`}
        style={{ paddingLeft: pad }}
        data-testid="tree-node"
        data-kind={item.type}
        data-name={item.name}
        tabIndex={0}
        draggable={!renaming}
        onDragStart={(e) => {
          dragging = { collectionId, itemId: item.id }
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', item.name)
        }}
        onDragEnd={() => {
          dragging = null
          setDrop(null)
        }}
        onDragOver={(e) => {
          if (!dragging || dragging.itemId === item.id) return
          e.preventDefault()
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          setDrop(isFolder && e.clientY > r.top + r.height * 0.35 ? 'into' : 'before')
        }}
        onDragLeave={() => setDrop(null)}
        onDrop={(e) => {
          e.preventDefault()
          const mode = drop
          setDrop(null)
          const d = dragging
          dragging = null
          if (!d || d.itemId === item.id) return
          const col = useApp.getState().snapshot?.collections.find((x) => x.collection.id === collectionId)?.collection
          if (!col) return
          if (mode === 'into') {
            if (d.collectionId === collectionId) void moveItem(collectionId, d.itemId, item.id, isFolder ? item.items.length : 0)
            else void moveItemToCollection(d.collectionId, d.itemId, collectionId, item.id)
            set({ expanded: { ...useApp.getState().expanded, [item.id]: true } })
            return
          }
          // before: find this item's parent + index
          const findParent = (items: Item[], parent: string | null): { parent: string | null; index: number } | null => {
            for (let i = 0; i < items.length; i++) {
              if (items[i].id === item.id) return { parent, index: i }
              const it = items[i]
              if (it.type === 'folder') {
                const r = findParent(it.items, it.id)
                if (r) return r
              }
            }
            return null
          }
          const pos = findParent(col.items, null)
          if (!pos) return
          if (d.collectionId === collectionId) {
            // account for removal shifting the index when moving down within the same list
            const srcPos = (() => {
              const walk = (items: Item[], parent: string | null): { parent: string | null; index: number } | null => {
                for (let i = 0; i < items.length; i++) {
                  if (items[i].id === d.itemId) return { parent, index: i }
                  const it = items[i]
                  if (it.type === 'folder') {
                    const r = walk(it.items, it.id)
                    if (r) return r
                  }
                }
                return null
              }
              return walk(col.items, null)
            })()
            const index = srcPos && srcPos.parent === pos.parent && srcPos.index < pos.index ? pos.index - 1 : pos.index
            void moveItem(collectionId, d.itemId, pos.parent, index)
          } else void moveItemToCollection(d.collectionId, d.itemId, collectionId, pos.parent)
        }}
        onClick={() => (isFolder ? toggle() : openRequest(collectionId, item.id))}
        onDoubleClick={() => (isFolder ? openContainer(collectionId, item.id) : undefined)}
        onContextMenu={(e) => openMenuAt(e, menu())}
        onKeyDown={(e) => {
          if (e.key === 'F2') set({ renaming: item.id })
          if (e.key === 'Enter') (isFolder ? toggle() : openRequest(collectionId, item.id))
        }}
      >
        {isFolder ? <Icon name="chevron" size={11} className={`twisty ${expanded ? 'open' : ''}`} /> : <span className="twisty-space" />}
        {isFolder ? <Icon name="folder" size={13} className="node-icon" /> : <MethodBadge method={item.method} short />}
        {renaming ? <InlineRename initial={item.name} onDone={(n) => void (n ? renameItem(collectionId, item.id, n) : null)} /> : <span className="node-name">{item.name}</span>}
        <button
          className="icon-btn row-menu"
          aria-label={`Actions for ${item.name}`}
          onClick={(e) => {
            e.stopPropagation()
            openMenuBelow(e.currentTarget, menu())
          }}
        >
          <Icon name="dots" />
        </button>
      </div>
      {isFolder && expanded && (
        <div role="group">
          {item.items.filter((i) => matches(i, q)).map((it) => (
            <ItemNode key={it.id} item={it} collectionId={collectionId} depth={depth + 1} q={q} />
          ))}
          {item.items.length === 0 && (
            <div className="tree-empty muted small" style={{ paddingLeft: pad + 34 }}>
              Empty folder
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------------------------

function EnvironmentsPanel(): React.JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const openDialog = useApp((s) => s.openDialog)
  const activeTab = useApp((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const envs = snapshot?.environments ?? []
  const create = (): void => {
    openDialog({
      type: 'prompt',
      title: 'New environment',
      label: 'Name',
      initial: 'New Environment',
      confirmLabel: 'Create',
      locationChoice: (useApp.getState().snapshot?.teams.length ?? 0) > 0,
      onSubmit: async (name, teamId) => {
        const e = await attempt(courier().environments.create({ name, teamId: teamId ?? null }))
        if (e) {
          await reloadWorkspace()
          openEnvironment(e.environment.id)
        }
      }
    })
  }
  return (
    <div className="panel">
      <div className="panel-toolbar">
        <button className="icon-btn" aria-label="New environment" data-testid="new-environment" title="New environment" onClick={create}>
          <Icon name="plus" />
        </button>
        <div className="grow" />
        <button className="btn small" onClick={() => openDialog({ type: 'import' })}>
          <Icon name="import" size={12} /> Import
        </button>
      </div>
      <div className="list">
        <div className={`list-row ${activeTab?.kind === 'globals' ? 'active' : ''}`} data-testid="globals-row" tabIndex={0} onClick={openGlobals} onKeyDown={(e) => e.key === 'Enter' && openGlobals()}>
          <Icon name="globe" size={13} className="node-icon" />
          <span className="node-name">Globals</span>
          <span className="muted small">{snapshot?.globals.length ?? 0}</span>
        </div>
        <div className="list-sep" />
        {envs.length === 0 && <p className="panel-empty muted">No environments yet. Environments hold variables like {'{{baseUrl}}'} per stage.</p>}
        {envs.length > 0 &&
          groupsOf(envs, snapshot?.teams ?? [])
            .filter((g) => g.items.length)
            .map((g) => (
              <div key={g.teamId ?? 'personal'} className="space-group" data-testid={g.teamId ? 'team-env-group' : 'personal-env-group'} data-team-name={g.team?.name}>
                <GroupHeader teamId={g.teamId} team={g.team} count={g.items.length} />
                {g.items.map((e) => (
                  <EnvRow key={e.environment.id} entry={e} active={snapshot?.activeEnvironmentId === e.environment.id} selected={activeTab?.kind === 'environment' && activeTab.environmentId === e.environment.id} />
                ))}
              </div>
            ))}
      </div>
    </div>
  )
}

function EnvRow({ entry, active, selected }: { entry: EnvironmentEntry; active: boolean; selected: boolean }): React.JSX.Element {
  const e = entry.environment
  const openDialog = useApp((s) => s.openDialog)
  const renaming = useApp((s) => s.renaming === e.id)
  const set = useApp((s) => s.set)
  const setActive = async (id: string | null): Promise<void> => {
    if (await succeeded(courier().environments.setActive(id))) await reloadWorkspace()
  }
  const menu = (): MenuItem[] => [
    { label: active ? 'Deactivate' : 'Set active', onClick: () => void setActive(active ? null : e.id) },
    { label: 'Edit', onClick: () => openEnvironment(e.id) },
    { label: 'Rename', onClick: () => set({ renaming: e.id }) },
    {
      label: 'Duplicate',
      onClick: async () => {
        if (await attempt(courier().environments.duplicate(e.id))) await reloadWorkspace()
      }
    },
    moveMenu('environment', e.id, e.name, entry.sync.teamId ?? null),
    ...syncMenu('environment', entry.sync, e.id, e.name),
    { label: 'Export…', onClick: () => openDialog({ type: 'export', kind: 'environment', id: e.id, name: e.name }) },
    { separator: true, label: '' },
    {
      label: 'Delete',
      danger: true,
      onClick: () =>
        openDialog({
          type: 'confirm',
          title: 'Delete environment?',
          message: `"${e.name}" will be deleted${entry.sync.teamId ? ` here and from team "${locationLabel(entry.sync.teamId)}" for everyone` : ' from this machine'}.`,
          confirmLabel: 'Delete',
          danger: true,
          onConfirm: async () => {
            if (await succeeded(courier().environments.delete(e.id))) await reloadWorkspace()
          }
        })
    }
  ]
  return (
    <div className={`list-row ${selected ? 'active' : ''}`} data-testid="env-row" data-name={e.name} tabIndex={0} onClick={() => openEnvironment(e.id)} onContextMenu={(ev) => openMenuAt(ev, menu())} onKeyDown={(ev) => ev.key === 'Enter' && openEnvironment(e.id)}>
      <button
        className={`env-active ${active ? 'on' : ''}`}
        aria-label={active ? `Deactivate ${e.name}` : `Activate ${e.name}`}
        title={active ? 'Active environment' : 'Set as active environment'}
        onClick={(ev) => {
          ev.stopPropagation()
          void setActive(active ? null : e.id)
        }}
      >
        {active ? <Icon name="check" size={11} /> : null}
      </button>
      <LocationBadge teamId={entry.sync.teamId} />
      {renaming ? (
        <InlineRename
          initial={e.name}
          onDone={async (n) => {
            if (!n) return
            if (await attempt(courier().environments.save({ ...e, name: n }))) await reloadWorkspace()
          }}
        />
      ) : (
        <span className="node-name">{e.name}</span>
      )}
      {syncIndicator(entry.sync)}
      <button
        className="icon-btn row-menu"
        aria-label={`Actions for ${e.name}`}
        onClick={(ev) => {
          ev.stopPropagation()
          openMenuBelow(ev.currentTarget, menu())
        }}
      >
        <Icon name="dots" />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const y = new Date()
  y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function HistoryPanel(): React.JSX.Element {
  const history = useApp((s) => s.history)
  const openDialog = useApp((s) => s.openDialog)
  const [filter, setFilter] = useState('')
  const q = filter.trim().toLowerCase()
  const groups = useMemo(() => {
    const out: { day: string; items: HistoryEntry[] }[] = []
    for (const h of history) {
      if (q && !h.url.toLowerCase().includes(q) && !h.name.toLowerCase().includes(q)) continue
      const day = dayLabel(h.at)
      const g = out[out.length - 1]
      if (g && g.day === day) g.items.push(h)
      else out.push({ day, items: [h] })
    }
    return out
  }, [history, q])
  return (
    <div className="panel">
      <div className="panel-toolbar">
        <div className="search-box grow">
          <Icon name="search" size={12} />
          <input aria-label="Filter history" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <button
          className="btn small"
          disabled={!history.length}
          onClick={() =>
            openDialog({
              type: 'confirm',
              title: 'Clear history?',
              message: 'All history entries on this machine will be removed.',
              confirmLabel: 'Clear',
              danger: true,
              onConfirm: async () => {
                if (await succeeded(courier().history.clear())) await reloadHistory()
              }
            })
          }
        >
          Clear
        </button>
      </div>
      <div className="list" data-testid="history-list">
        {history.length === 0 && <p className="panel-empty muted">Requests you send appear here.</p>}
        {groups.map((g) => (
          <div key={g.day}>
            <div className="space-header">{g.day}</div>
            {g.items.map((h) => (
              <div
                key={h.id}
                className="list-row history-row"
                data-testid="history-row"
                tabIndex={0}
                title={`${h.method} ${h.url}\n${new Date(h.at).toLocaleString()}${h.error ? `\n${h.error}` : ''}`}
                onClick={() => openDraft(h.request, h.collectionId && useApp.getState().snapshot?.collections.some((c) => c.collection.id === h.collectionId) ? h.collectionId : null)}
                onKeyDown={(e) => e.key === 'Enter' && openDraft(h.request, null)}
                onContextMenu={(e) =>
                  openMenuAt(e, [
                    { label: 'Open as new tab', onClick: () => openDraft(h.request, null) },
                    {
                      label: 'Delete',
                      danger: true,
                      onClick: async () => {
                        if (await succeeded(courier().history.delete(h.id))) await reloadHistory()
                      }
                    }
                  ])
                }
              >
                <MethodBadge method={h.method} short />
                <div className="history-main">
                  <span className="node-name mono small">{h.url}</span>
                  <span className="muted small">
                    {h.name} · {timeAgo(h.at)}
                  </span>
                </div>
                {h.status ? <span className={`status-mini ${statusClass(h.status)}`}>{h.status}</span> : h.error ? <span className="status-mini st-server">ERR</span> : null}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
