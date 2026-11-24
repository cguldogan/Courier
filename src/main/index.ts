/**
 * Electron main entry. Security: contextIsolation, sandboxed renderer, no node integration,
 * navigation/new windows blocked, all permissions denied, narrow typed preload API.
 *
 * Test hooks: COURIER_USER_DATA (userData dir), COURIER_FAKE_IDENTITY (fake credential),
 * COURIER_KV_INSECURE_CHALLENGE=1 (mock Key Vault on 127.0.0.1 — tests only),
 * COURIER_MONITOR_SECONDS=1 (monitors may run every N seconds; 1 s scheduler tick — tests only),
 * NODE_EXTRA_CA_CERTS (self-signed test certs).
 */
import * as electron from 'electron'
import { BrowserWindow, Menu, app, safeStorage, session, shell, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { parseFakeIdentity } from './azure'
import { CourierCore } from './core'
import { broadcast, buildHandlers, registerIpc } from './ipc'
import type { SecretBox } from './oauth'

if (process.env['COURIER_USER_DATA']) app.setPath('userData', process.env['COURIER_USER_DATA'])

let core: CourierCore | null = null

function createWindow(): BrowserWindow {
  if (!app.isPackaged && process.platform === 'darwin') app.dock?.setIcon(join(__dirname, '../../build/icon.png'))
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Courier',
    // Packaged builds take their icon from build/icon.* via electron-builder; this covers dev runs on Windows/Linux.
    ...(app.isPackaged ? {} : { icon: join(__dirname, '../../build/icon.png') }),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false
    }
  })
  win.once('ready-to-show', () => win.show())
  // WebSocket connections and gRPC calls belong to the window that opened them (also on reload).
  const owner = win.webContents.id
  win.webContents.on('destroyed', () => core?.closeRealtime(owner))
  win.webContents.on('did-start-navigation', (e) => {
    if (e.isMainFrame && !e.isSameDocument) core?.closeRealtime(owner)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (!(dev && url.startsWith(dev))) e.preventDefault()
  })
  // Sub-frames (HTML preview, Visualize) render srcdoc only: no meta refresh, link click or script
  // may navigate them anywhere (that would be a network request carrying data out).
  win.webContents.on('will-frame-navigate', (e) => {
    if (e.isMainFrame) return
    if (e.url !== 'about:srcdoc' && e.url !== 'about:blank') e.preventDefault()
  })
  if (process.env['ELECTRON_RENDERER_URL']) void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

/**
 * Application menu. Electron's default menu binds ⌘W (close window) and ⌘R (reload), which would
 * discard unsaved request tabs; the renderer handles ⌘T/⌘W/⌘S/⌘↩ itself, so those accelerators are
 * left out here. The Edit menu keeps clipboard shortcuts working in text fields on macOS.
 */
function buildMenu(): void {
  const mac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }]
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(mac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [])] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function main(): Promise<void> {
  await app.whenReady()
  buildMenu()
  // Deny everything except writing to the clipboard (copy response / snippet buttons).
  const allowed = new Set(['clipboard-sanitized-write'])
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(allowed.has(perm)))
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => allowed.has(perm))

  const fake = parseFakeIdentity(process.env['COURIER_FAKE_IDENTITY'])
  // OAuth tokens at rest: only with real OS-keystore encryption (Linux "basic_text" is a fixed key).
  const encrypted = safeStorage.isEncryptionAvailable() && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
  const secretBox: SecretBox | null = encrypted
    ? { encrypt: (plain) => safeStorage.encryptString(plain), decrypt: (data) => safeStorage.decryptString(data) }
    : null
  const userDataDir = app.getPath('userData')
  const monitorSeconds = process.env['COURIER_MONITOR_SECONDS'] === '1'
  core = new CourierCore({
    userDataDir,
    fakeIdentity: fake,
    emit: broadcast,
    keyVaultInsecureChallenge: process.env['COURIER_KV_INSECURE_CHALLENGE'] === '1',
    secretBox,
    // Looked up at call time so the e2e run can stub `shell.openExternal` (a fake browser).
    openExternal: async (url) => {
      const u = new URL(url)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http(s) URLs can be opened.')
      await shell.openExternal(u.toString())
    },
    // Monitor failure / recovery: an OS notification; clicking it shows that run. `Notification` is
    // looked up at call time so the e2e run can stub it.
    notify: (n) => {
      const N = electron.Notification
      if (!N.isSupported()) return
      const note = new N({ title: n.title, body: n.body })
      note.on('click', () => {
        const w = BrowserWindow.getAllWindows()[0]
        if (w) {
          if (w.isMinimized()) w.restore()
          w.focus()
        }
        broadcast('monitor:open', { monitorId: n.monitorId, runId: n.runId })
      })
      note.show()
    },
    monitorSeconds,
    ...(monitorSeconds ? { monitorTickMs: 500 } : {})
  })
  await core.init()
  registerIpc(buildHandlers(core, { fakeIdentity: fake !== null, userDataDir, monitorSeconds }))
  await core.startMonitors()
  app.on('will-quit', () => {
    core?.closeRealtime()
    void core?.shutdown()
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

main().catch((err) => {
  console.error('[courier] fatal startup error', err)
  app.exit(1)
})
