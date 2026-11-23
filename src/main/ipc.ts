/**
 * IPC bridge: one invoke channel, method names checked against API_METHODS, every result wrapped
 * in the `Result<T>` envelope (see src/shared/api.ts). Dialog/shell methods live here; everything
 * else delegates to CourierCore. Paths never come from the renderer except via main's own dialogs
 * (and request body file paths, which are user content).
 */
import { BrowserWindow, app, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { API_METHODS, IPC_EVENT, IPC_INVOKE, type ApiHandlers, type CourierEventName, type CourierEvents, type Result } from '../shared/api'
import { parseDataFile } from '../shared/datafile'
import type { CourierCore } from './core'
import { Fault, toErrorInfo } from './errors'

const MAX_IMPORT_BYTES = 50 * 1024 * 1024

export function broadcast<E extends CourierEventName>(event: E, payload: CourierEvents[E]): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC_EVENT, event, payload)
}

async function readLimited(path: string): Promise<string> {
  const s = await stat(path)
  if (s.size > MAX_IMPORT_BYTES) throw new Fault('INVALID_ARGUMENT', `File is too large (${Math.round(s.size / 1048576)} MB, max 50 MB).`)
  return readFile(path, 'utf8')
}

export function buildHandlers(core: CourierCore, opts: { fakeIdentity: boolean; userDataDir: string }): ApiHandlers {
  const win = (): BrowserWindow | undefined => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const openDialog = async (o: Electron.OpenDialogOptions): Promise<string | null> => {
    const w = win()
    const r = w ? await dialog.showOpenDialog(w, o) : await dialog.showOpenDialog(o)
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
  }
  const saveDialog = async (defaultPath: string): Promise<string | null> => {
    const w = win()
    const o: Electron.SaveDialogOptions = { defaultPath, filters: [{ name: 'JSON', extensions: ['json'] }] }
    const r = w ? await dialog.showSaveDialog(w, o) : await dialog.showSaveDialog(o)
    return r.canceled || !r.filePath ? null : r.filePath
  }

  return {
    app: {
      info: () => ({
        name: app.getName(),
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron ?? '',
        userDataDir: opts.userDataDir,
        fakeIdentity: opts.fakeIdentity
      }),
      openExternal: async (url: string) => {
        let u: URL
        try {
          u = new URL(String(url))
        } catch {
          throw new Fault('INVALID_ARGUMENT', 'Invalid URL.')
        }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Fault('INVALID_ARGUMENT', 'Only http(s) links can be opened.')
        await shell.openExternal(u.toString())
      }
    },
    settings: {
      get: () => core.getSettings(),
      update: (patch) => core.updateSettings(patch)
    },
    identity: {
      status: () => core.identityStatus(),
      signIn: (s) => core.signIn(s),
      signOut: () => core.signOut()
    },
    workspace: {
      load: () => core.load()
    },
    collections: {
      create: (i) => core.createCollection(i),
      save: (c) => core.saveCollection(c),
      upsertItem: (i) => core.upsertItem(i),
      deleteItem: (i) => core.deleteItem(i),
      moveItem: (i) => core.moveItem(i),
      duplicate: async (id) => {
        const e = await core.duplicate('collection', id)
        return { collection: e.doc as never, sync: e.sync }
      },
      delete: (id) => core.deleteDoc('collection', id),
      move: (i) => core.move('collection', i),
      getScriptVaultAccess: (id) => core.getScriptVaultAccess(id),
      setScriptVaultAccess: (i) => core.setScriptVaultAccess(i)
    },
    environments: {
      create: (i) => core.createEnvironment(i),
      save: (e) => core.saveEnvironment(e),
      duplicate: async (id) => {
        const e = await core.duplicate('environment', id)
        return { environment: e.doc as never, sync: e.sync }
      },
      delete: (id) => core.deleteDoc('environment', id),
      move: (i) => core.move('environment', i),
      setActive: (id) => core.setActiveEnvironment(id)
    },
    variables: {
      setGlobals: (v) => core.setGlobals(v),
      setCurrentValues: (i) => core.setCurrentValues(i)
    },
    requests: {
      send: (i) => core.send(i ?? {}),
      cancel: (id) => core.cancel(String(id)),
      snippet: (i) => core.snippet(i),
      effectiveAuth: (i) => core.effectiveAuth(i)
    },
    oauth: {
      status: (i) => core.oauthStatus(i),
      getNewToken: (i) => core.oauthGetNewToken(i),
      cancel: () => core.oauth.cancel(),
      clearToken: (i) => core.oauthClearToken(i)
    },
    runner: {
      start: async (i) => {
        const { runId } = await core.startRun(i)
        return { runId }
      },
      stop: (id) => core.stopRun(String(id))
    },
    sync: {
      status: () => core.syncStatus(),
      run: (i) => core.runSync(i),
      getConflict: (i) => core.getConflict(i),
      resolveConflict: (i) => core.resolveConflict(i),
      scan: (i) => core.scan(i),
      discardLocalChanges: (i) => core.discardLocalChanges(i)
    },
    teams: {
      list: () => core.listTeams(),
      probe: (i) => core.probeTeam(i),
      join: (i) => core.joinTeam(i),
      create: (i) => core.createTeam(i),
      refresh: (id) => core.refreshTeam(id),
      update: (i) => core.updateTeam(i),
      approveVault: (i) => core.approveTeamVault(i),
      leave: (i) => core.leaveTeam(i),
      testConnection: (id) => core.testTeamConnection(id)
    },
    vault: {
      list: (i) => core.vaultList(i),
      get: (i) => core.vaultGet(i),
      set: (i) => core.vaultSet(i),
      clearCache: () => core.vault.clearCache()
    },
    files: {
      pickFile: async (i) => {
        const p = await openDialog({ title: i?.title ?? 'Choose file', properties: ['openFile'] })
        if (!p) return null
        const s = await stat(p)
        await core.allowFile(p)
        return { path: p, name: basename(p), size: s.size }
      },
      pickDataFile: async () => {
        const p = await openDialog({ title: 'Choose data file', properties: ['openFile'], filters: [{ name: 'CSV or JSON', extensions: ['csv', 'json', 'txt'] }] })
        if (!p) return null
        try {
          const parsed = parseDataFile(basename(p), await readLimited(p))
          return { name: basename(p), ...parsed }
        } catch (err) {
          throw err instanceof Fault ? err : new Fault('IMPORT_FAILED', `Could not parse data file: ${err instanceof Error ? err.message : String(err)}`)
        }
      },
      importFile: async (i) => {
        const p = await openDialog({ title: 'Import', properties: ['openFile'], filters: [{ name: 'Postman / OpenAPI / Courier', extensions: ['json', 'yaml', 'yml'] }] })
        if (!p) return null
        return core.importText(await readLimited(p), i?.teamId ?? null)
      },
      importText: (i) => core.importText(i?.text, i?.teamId ?? null),
      exportCollection: async (i) => {
        const { fileName, content } = await core.exportDoc('collection', i?.id, i?.format)
        const p = await saveDialog(fileName)
        if (!p) return null
        await writeFile(p, content, 'utf8')
        return p
      },
      exportEnvironment: async (i) => {
        const { fileName, content } = await core.exportDoc('environment', i?.id, i?.format)
        const p = await saveDialog(fileName)
        if (!p) return null
        await writeFile(p, content, 'utf8')
        return p
      }
    },
    history: {
      list: () => core.listHistory(),
      delete: (id) => core.deleteHistory(id),
      clear: () => core.clearHistory()
    },
    cookies: {
      list: () => core.listCookies(),
      delete: (i) => core.deleteCookie(i),
      clear: () => core.clearCookies()
    }
  }
}

function isTrustedSender(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? ''
  const dev = process.env['ELECTRON_RENDERER_URL']
  return url.startsWith('file://') || (dev !== undefined && url.startsWith(dev))
}

export function registerIpc(handlers: ApiHandlers): void {
  const table = new Map<string, (...args: unknown[]) => unknown>()
  for (const [ns, methods] of Object.entries(API_METHODS)) {
    const group = handlers[ns as keyof ApiHandlers] as Record<string, (...args: unknown[]) => unknown>
    for (const m of methods) table.set(`${ns}.${m}`, group[m].bind(group))
  }
  ipcMain.handle(IPC_INVOKE, async (event, method: unknown, args: unknown): Promise<Result<unknown>> => {
    try {
      if (!isTrustedSender(event)) throw new Fault('INVALID_ARGUMENT', 'Untrusted sender.')
      const fn = typeof method === 'string' ? table.get(method) : undefined
      if (!fn) throw new Fault('INVALID_ARGUMENT', `Unknown method "${String(method)}".`)
      const value = await fn(...(Array.isArray(args) ? args : []))
      return { ok: true, value }
    } catch (err) {
      const info = toErrorInfo(err)
      if (info.code === 'INTERNAL') console.error(`[courier] ${String(method)} failed:`, err)
      return { ok: false, error: info }
    }
  })
}
