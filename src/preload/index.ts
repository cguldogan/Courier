/**
 * Preload (sandboxed, CommonJS, bundled): exposes `window.courier: CourierApi`.
 * Built from API_METHODS so it cannot drift from the main-process handler table.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { API_METHODS, EVENT_NAMES, IPC_EVENT, IPC_INVOKE, type CourierApi, type CourierEventName } from '../shared/api'

const api: Record<string, unknown> = {}
for (const [ns, methods] of Object.entries(API_METHODS)) {
  const group: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  for (const m of methods) group[m] = (...args: unknown[]) => ipcRenderer.invoke(IPC_INVOKE, `${ns}.${m}`, args)
  api[ns] = group
}

api.on = (event: CourierEventName, callback: (payload: unknown) => void): (() => void) => {
  if (!EVENT_NAMES.includes(event)) throw new Error(`Unknown event "${String(event)}"`)
  if (typeof callback !== 'function') throw new Error('callback must be a function')
  const listener = (_e: IpcRendererEvent, name: string, payload: unknown): void => {
    if (name === event) callback(payload)
  }
  ipcRenderer.on(IPC_EVENT, listener)
  return () => {
    ipcRenderer.removeListener(IPC_EVENT, listener)
  }
}

contextBridge.exposeInMainWorld('courier', api as unknown as CourierApi)
