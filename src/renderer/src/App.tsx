/** Application shell: top bar, sidebar, tabs, workbench, dialogs, toasts, shortcuts, engine events. */
import { useEffect, useRef, useState } from 'react'
import { courier } from './api'
import { loadAll, openDraft, reloadHistory, reloadWorkspace, requestCloseTab, saveTab, sendTab, signIn, tabTitle, updateUi } from './actions'
import { type DialogSpec, NO_TEAMS, type Tab, isDirty, useApp } from './store'
import { ContainerEditor, EnvironmentEditor, GlobalsEditor } from './components/Editors'
import { ConfirmDialog, CookiesDialog, ExportDialog, ImportDialog, PromptDialog, SaveAsDialog, SnippetDialog, TeamVaultsDialog, WarningsDialog } from './components/Dialogs'
import { GrpcEditor } from './components/GrpcEditor'
import { RequestEditor } from './components/RequestEditor'
import { WebSocketEditor } from './components/WebSocketEditor'
import { startRealtimeEvents } from './realtime'
import { Runner } from './components/Runner'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { ConflictDialog, SyncPanel } from './components/SyncDialogs'
import { TopBar } from './components/TopBar'
import { ContextMenuHost, Icon, KindBadge, MethodBadge, Splitter, openMenuAt, openMenuBelow } from './components/ui'
import type { GrpcRequestDef, RequestDef, RequestItem, WebSocketRequestDef } from '../../shared/types'
import type { TabOf } from './store'
import { VaultBrowser } from './components/VaultBrowser'

function useTheme(): void {
  const theme = useApp((s) => (s.settings?.ui.theme as string) ?? 'system')
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
}

function useEngineEvents(): void {
  useEffect(() => {
    const c = courier()
    const set = useApp.getState().set
    const offs = [
      c.on('workspace:changed', () => void reloadWorkspace()),
      c.on('variables:changed', () => void reloadWorkspace()),
      c.on('settings:changed', (s) => set({ settings: s })),
      c.on('auth:changed', (s) => set({ identity: s })),
      c.on('sync:state', (s) => set({ sync: s, ...(s.lastReport ? { lastReport: s.lastReport } : {}) })),
      c.on('history:changed', () => void reloadHistory()),
      c.on('runner:progress', (p) =>
        useApp.setState((s) => {
          const prev = s.runs[p.runId] ?? { runId: p.runId, total: p.total, completed: 0, results: [] }
          return { runs: { ...s.runs, [p.runId]: { ...prev, total: p.total, completed: p.completed, results: [...prev.results, p.result] } } }
        })
      ),
      c.on('runner:finished', (sum) =>
        useApp.setState((s) => {
          const prev = s.runs[sum.runId] ?? { runId: sum.runId, total: sum.totalRequests, completed: sum.totalRequests, results: sum.results }
          return { runs: { ...s.runs, [sum.runId]: { ...prev, completed: Math.max(prev.completed, sum.results.length), total: Math.max(prev.completed, sum.results.length), results: sum.results, summary: sum } } }
        })
      )
    ]
    const offRealtime = startRealtimeEvents()
    return () => {
      offs.forEach((off) => off())
      offRealtime()
    }
  }, [])
}

function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.altKey) return
      const s = useApp.getState()
      if (s.dialogs.length && e.key.toLowerCase() !== 'enter') return
      const k = e.key.toLowerCase()
      if (k === 't' && !e.shiftKey) {
        e.preventDefault()
        openDraft()
      } else if (k === 'w' && !e.shiftKey) {
        e.preventDefault()
        if (s.activeTabId) requestCloseTab(s.activeTabId)
      } else if (k === 's' && !e.shiftKey) {
        e.preventDefault()
        if (s.activeTabId) void saveTab(s.activeTabId)
      } else if (k === 's' && e.shiftKey) {
        e.preventDefault()
        const t = s.tabs.find((x) => x.id === s.activeTabId)
        if (t?.kind === 'request') s.openDialog({ type: 'saveAs', tabId: t.id })
      } else if (k === 'enter') {
        if (s.dialogs.length) return
        const t = s.tabs.find((x) => x.id === s.activeTabId)
        if (t?.kind === 'request') {
          e.preventDefault()
          e.stopPropagation()
          void sendTab(t.id)
        }
      } else if ((k === ']' || k === 'tab') && s.tabs.length > 1 && (k === ']' ? e.shiftKey : !e.shiftKey)) {
        e.preventDefault()
        const i = s.tabs.findIndex((x) => x.id === s.activeTabId)
        s.activate(s.tabs[(i + 1) % s.tabs.length].id)
      } else if ((k === '[' && e.shiftKey) || (k === 'tab' && e.shiftKey)) {
        if (s.tabs.length > 1) {
          e.preventDefault()
          const i = s.tabs.findIndex((x) => x.id === s.activeTabId)
          s.activate(s.tabs[(i - 1 + s.tabs.length) % s.tabs.length].id)
        }
      } else if (k === ',') {
        e.preventDefault()
        s.openDialog({ type: 'settings' })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

function TabIcon({ tab }: { tab: Tab }): React.JSX.Element {
  switch (tab.kind) {
    case 'request':
      return tab.draft.type === 'request' ? <MethodBadge method={tab.draft.method} short /> : <KindBadge kind={tab.draft.type} />
    case 'container':
      return <Icon name={tab.folderId ? 'folder' : 'box'} size={12} />
    case 'environment':
      return <Icon name="layers" size={12} />
    case 'globals':
      return <Icon name="globe" size={12} />
    case 'runner':
      return <Icon name="play" size={11} />
  }
}

function requestSummary(d: RequestItem): string {
  if (d.type === 'websocket') return `WebSocket ${d.url || '(no URL)'}`
  if (d.type === 'grpc') return `gRPC ${d.address || '(no address)'}${d.service ? ` ${d.service}/${d.method}` : ''}`
  return `${d.method} ${d.url || '(no URL)'}`
}

const newMenu = (): { label: string; onClick: () => void; hint?: string }[] => [
  { label: 'HTTP request', hint: '⌘T', onClick: () => openDraft() },
  { label: 'WebSocket request', onClick: () => openDraft(undefined, null, 'websocket') },
  { label: 'gRPC request', onClick: () => openDraft(undefined, null, 'grpc') }
]

function TabBar(): React.JSX.Element {
  const tabs = useApp((s) => s.tabs)
  const active = useApp((s) => s.activeTabId)
  const activate = useApp((s) => s.activate)
  useEffect(() => {
    document.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active, tabs.length])
  return (
    <div className="tabbar" role="tablist" aria-label="Open tabs">
      <div className="tabs-scroll">
        {tabs.map((t) => {
          const dirty = isDirty(t)
          const title = tabTitle(t)
          return (
            <div
              key={t.id}
              role="tab"
              tabIndex={0}
              aria-selected={t.id === active}
              data-testid="tab"
              data-title={title}
              className={`tab ${t.id === active ? 'active' : ''} ${t.kind === 'request' && !t.requestId ? 'draft' : ''}`}
              title={t.kind === 'request' ? `${requestSummary(t.draft)}${!t.requestId ? '\nUnsaved draft' : ''}` : title}
              onClick={() => activate(t.id)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  requestCloseTab(t.id)
                }
              }}
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault()
              }}
              onKeyDown={(e) => e.key === 'Enter' && activate(t.id)}
              onContextMenu={(e) =>
                openMenuAt(e, [
                  { label: 'Close', hint: '⌘W', onClick: () => requestCloseTab(t.id) },
                  { label: 'Close others', onClick: () => useApp.getState().tabs.filter((x) => x.id !== t.id && !isDirty(x)).forEach((x) => useApp.getState().closeTab(x.id)) },
                  ...(t.kind === 'request' ? [{ label: 'Duplicate as draft', onClick: () => openDraft({ ...t.draft, name: `${t.draft.name} Copy` }, t.collectionId, t.draft.type) }] : [])
                ])
              }
            >
              <TabIcon tab={t} />
              <span className="tab-title">{title}</span>
              {t.kind === 'request' && t.sending && <span className="spinner" style={{ width: 10, height: 10 }} />}
              <button
                className={`tab-close ${dirty ? 'dirty' : ''}`}
                aria-label={`Close ${title}`}
                data-testid="tab-close"
                onClick={(e) => {
                  e.stopPropagation()
                  requestCloseTab(t.id)
                }}
              >
                <span className="dot" />
                <Icon name="x" size={11} />
              </button>
            </div>
          )
        })}
      </div>
      <button className="icon-btn new-tab" aria-label="New request tab" data-testid="new-tab" title="New request (⌘/Ctrl+T)" onClick={() => openDraft()}>
        <Icon name="plus" />
      </button>
      <button className="icon-btn new-tab-kind" aria-label="New request of another kind" data-testid="new-tab-menu" title="New HTTP, WebSocket or gRPC request" onClick={(e) => openMenuBelow(e.currentTarget, newMenu())}>
        <Icon name="down" size={12} />
      </button>
    </div>
  )
}

function Onboarding(): React.JSX.Element {
  const identity = useApp((s) => s.identity)
  const sync = useApp((s) => s.sync)
  const teams = useApp((s) => s.snapshot?.teams ?? NO_TEAMS)
  const openDialog = useApp((s) => s.openDialog)
  const signedIn = !!identity?.signedIn
  const joined = teams.length > 0
  const synced = !!(sync?.lastReport || useApp.getState().lastReport)
  return (
    <div className="onboarding" data-testid="onboarding">
      <h1>Courier</h1>
      <p className="lead">An API client for your team — requests, collections, environments and scripts, shared through your own Azure Storage account and secrets from Azure Key Vault.</p>
      <div className="quick-actions">
        <button className="btn primary" onClick={() => openDraft()}>
          <Icon name="plus" /> New request
        </button>
        <button className="btn" aria-label="New WebSocket request" data-testid="onboarding-new-ws" onClick={() => openDraft(undefined, null, 'websocket')}>
          WebSocket
        </button>
        <button className="btn" aria-label="New gRPC request" data-testid="onboarding-new-grpc" onClick={() => openDraft(undefined, null, 'grpc')}>
          gRPC
        </button>
        <button className="btn" onClick={() => openDialog({ type: 'import' })}>
          <Icon name="import" /> Import
        </button>
        <span className="muted small">⌘/Ctrl+T new tab · ⌘/Ctrl+Enter send / connect / invoke · ⌘/Ctrl+S save</span>
      </div>
      <ol className="steps">
        <li className={signedIn ? 'done' : ''}>
          <span className="step-num">{signedIn ? <Icon name="check" size={12} /> : 1}</span>
          <div>
            <div className="strong">Sign in with your Azure identity</div>
            <div className="muted small">Azure CLI, browser sign-in or managed identity (on Azure-hosted machines). Used for team storage, Key Vault and “Azure identity” auth.</div>
            {!signedIn && (
              <div className="row-gap">
                <button className="btn small primary" onClick={() => void signIn()}>
                  Sign in
                </button>
                <button className="link-btn small" onClick={() => openDialog({ type: 'settings', section: 'account' })}>
                  Choose sign-in mode
                </button>
              </div>
            )}
            {signedIn && <div className="small good-text">Signed in as {identity?.account?.upn ?? identity?.account?.name}</div>}
          </div>
        </li>
        <li className={joined ? 'done' : ''}>
          <span className="step-num">{joined ? <Icon name="check" size={12} /> : 2}</span>
          <div>
            <div className="strong">Join or create a team</div>
            <div className="muted small">
              A team is an Azure Storage container your team can access. Every team you join gets its own group in the sidebar; people only see the teams whose containers they have access to.
            </div>
            <button className="btn small" data-testid="onboarding-teams" onClick={() => openDialog({ type: 'settings', section: 'teams' })}>
              {joined ? `Teams (${teams.length})` : 'Join or create a team'}
            </button>
          </div>
        </li>
        <li className={synced ? 'done' : ''}>
          <span className="step-num">{synced ? <Icon name="check" size={12} /> : 3}</span>
          <div>
            <div className="strong">Sync</div>
            <div className="muted small">Move a collection to a team (right-click → Move to…), then press Sync to upload it and download your teams’ collections.</div>
            <button className="btn small" disabled={!signedIn || !joined} onClick={() => openDialog({ type: 'sync' })}>
              Open sync
            </button>
          </div>
        </li>
      </ol>
      <p className="muted small">Everything in Personal works offline with no sign-in — it is stored on this machine only and never uploaded.</p>
    </div>
  )
}

function Workbench(): React.JSX.Element {
  const tab = useApp((s) => s.tabs.find((t) => t.id === s.activeTabId))
  if (!tab) return <Onboarding />
  switch (tab.kind) {
    case 'request':
      if (tab.draft.type === 'websocket') return <WebSocketEditor key={tab.id} tab={tab as TabOf<WebSocketRequestDef>} />
      if (tab.draft.type === 'grpc') return <GrpcEditor key={tab.id} tab={tab as TabOf<GrpcRequestDef>} />
      return <RequestEditor key={tab.id} tab={tab as TabOf<RequestDef>} />
    case 'container':
      return <ContainerEditor key={tab.id} tab={tab} />
    case 'environment':
      return <EnvironmentEditor key={tab.id} tab={tab} />
    case 'globals':
      return <GlobalsEditor key={tab.id} tab={tab} />
    case 'runner':
      return <Runner key={tab.id} tab={tab} />
  }
}

function DialogHost(): React.JSX.Element {
  const dialogs = useApp((s) => s.dialogs)
  const close = useApp((s) => s.closeDialog)
  const render = (d: DialogSpec & { key: number }): React.JSX.Element => {
    switch (d.type) {
      case 'settings':
        return <SettingsDialog key={d.key} section={d.section} onClose={close} />
      case 'sync':
        return <SyncPanel key={d.key} onClose={close} />
      case 'conflict':
        return <ConflictDialog key={d.key} kind={d.kind} id={d.id} onClose={close} />
      case 'vault':
        return <VaultBrowser key={d.key} onClose={close} />
      case 'cookies':
        return <CookiesDialog key={d.key} onClose={close} />
      case 'import':
        return <ImportDialog key={d.key} onClose={close} />
      case 'export':
        return <ExportDialog key={d.key} spec={d} onClose={close} />
      case 'snippet':
        return <SnippetDialog key={d.key} spec={d} onClose={close} />
      case 'saveAs':
        return <SaveAsDialog key={d.key} spec={d} onClose={close} />
      case 'warnings':
        return <WarningsDialog key={d.key} spec={d} onClose={close} />
      case 'prompt':
        return <PromptDialog key={d.key} spec={d} onClose={close} />
      case 'confirm':
        return <ConfirmDialog key={d.key} spec={d} onClose={close} />
      case 'teamVaults':
        return <TeamVaultsDialog key={d.key} spec={d} onClose={close} />
    }
  }
  return <>{dialogs.map(render)}</>
}

function Toasts(): React.JSX.Element {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'} data-testid="toast" data-kind={t.kind}>
          <Icon name={t.kind === 'error' ? 'warn' : t.kind === 'success' ? 'check' : 'eye'} size={13} />
          <span className="toast-msg">{t.message}</span>
          <button className="icon-btn subtle" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <Icon name="x" size={11} />
          </button>
        </div>
      ))}
    </div>
  )
}

export function App(): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const info = useApp((s) => s.info)
  const [width, setWidth] = useState<number>(300)
  const widthRef = useRef(width)
  widthRef.current = width
  const loadedWidth = useRef(false)
  useTheme()
  useEngineEvents()
  useShortcuts()
  useEffect(() => {
    void loadAll()
  }, [])
  useEffect(() => {
    if (!loadedWidth.current && typeof settings?.ui.sidebarWidth === 'number') {
      loadedWidth.current = true
      setWidth(settings.ui.sidebarWidth as number)
    }
  }, [settings])
  return (
    <div className="app" style={{ ['--sidebar-w' as string]: `${width}px` }}>
      <span id="bridge-status" className="sr-only">
        {info ? `window.courier ready — v${info.version} on ${info.platform}/${info.arch}` : 'checking window.courier…'}
      </span>
      <TopBar />
      <div className="main">
        <Sidebar />
        <Splitter direction="x" label="Resize sidebar" onDrag={(d) => setWidth((w) => Math.min(560, Math.max(200, w + d)))} onEnd={() => void updateUi({ sidebarWidth: widthRef.current })} />
        <section className="workspace">
          <TabBar />
          <div className="workbench">
            <Workbench />
          </div>
        </section>
      </div>
      <DialogHost />
      <ContextMenuHost />
      <Toasts />
    </div>
  )
}
