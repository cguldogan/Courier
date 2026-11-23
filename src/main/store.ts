/**
 * userData store: settings, globals, current values, active environment, history, cookies.
 * Everything here stays on this machine. Writes are atomic (temp file + rename) and serialised per file.
 */
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CookieJar } from 'tough-cookie'
import type { DeepPartial } from '../shared/api'
import type { CurrentValues, HistoryEntry, Id, Settings, Variable } from '../shared/types'
import { normalizeRequest, normalizeVariable } from '../shared/serialize'

export const HISTORY_LIMIT = 200

export function defaultSettings(): Settings {
  return {
    http: { timeoutMs: 30_000, followRedirects: true, maxRedirects: 10, verifyTls: true, maxResponseBytes: 10 * 1024 * 1024 },
    scripts: { timeoutMs: 5_000, memoryLimitMb: 64 },
    identity: { mode: 'auto' },
    storage: { accountUrl: '', container: 'courier' },
    keyVault: { vaults: [], cacheTtlSeconds: 300 },
    ui: {}
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Deep merge for settings patches: objects merged, arrays and scalars replaced (`ui` is merged one
 * level deep). The result is re-validated, which also drops unknown keys.
 */
export function mergeSettings(base: Settings, patch: DeepPartial<Settings> | unknown): Settings {
  const merge = (b: unknown, p: unknown): unknown => {
    if (!isObj(b) || !isObj(p)) return p === undefined ? b : p
    const out: Obj = { ...b }
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) continue
      out[k] = isObj(b[k]) && isObj(v) ? merge(b[k], v) : v
    }
    return out
  }
  return validateSettings(merge(base, patch) as Settings)
}

function validateSettings(s: Settings): Settings {
  const d = defaultSettings()
  const num = (v: unknown, def: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def
  const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def)
  const str = (v: unknown, def: string): string => (typeof v === 'string' ? v : def)
  const modes = ['auto', 'managed-identity', 'azure-cli', 'browser']
  const identity: Settings['identity'] = { mode: modes.includes(s.identity?.mode) ? s.identity.mode : 'auto' }
  for (const k of ['tenantId', 'clientId', 'managedIdentityClientId'] as const) {
    const v = s.identity?.[k]
    if (typeof v === 'string' && v.trim()) identity[k] = v.trim()
  }
  const vaults = Array.isArray(s.keyVault?.vaults)
    ? s.keyVault.vaults
        .filter((v) => isObj(v) && typeof v.alias === 'string' && typeof v.url === 'string')
        .map((v) => ({ alias: v.alias.trim(), url: v.url.trim().replace(/\/+$/, '') }))
        .filter((v) => v.alias && /^https:\/\//i.test(v.url))
    : []
  return {
    http: {
      timeoutMs: num(s.http?.timeoutMs, d.http.timeoutMs, 0, 3_600_000),
      followRedirects: bool(s.http?.followRedirects, d.http.followRedirects),
      maxRedirects: num(s.http?.maxRedirects, d.http.maxRedirects, 0, 50),
      verifyTls: bool(s.http?.verifyTls, d.http.verifyTls),
      maxResponseBytes: num(s.http?.maxResponseBytes, d.http.maxResponseBytes, 1024, 512 * 1024 * 1024)
    },
    scripts: {
      timeoutMs: num(s.scripts?.timeoutMs, d.scripts.timeoutMs, 100, 600_000),
      memoryLimitMb: num(s.scripts?.memoryLimitMb, d.scripts.memoryLimitMb, 8, 1024)
    },
    identity,
    storage: {
      accountUrl: str(s.storage?.accountUrl, '').trim().replace(/\/+$/, ''),
      container: str(s.storage?.container, d.storage.container).trim() || d.storage.container
    },
    keyVault: { vaults, cacheTtlSeconds: num(s.keyVault?.cacheTtlSeconds, d.keyVault.cacheTtlSeconds, 0, 86_400) },
    ui: isObj(s.ui) ? s.ui : {}
  }
}

/** Atomic JSON file helper with per-file write serialisation. */
export class JsonFile<T> {
  private chain: Promise<unknown> = Promise.resolve()
  constructor(
    readonly path: string,
    private readonly fallback: () => T
  ) {}

  async read(): Promise<T> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as T
    } catch {
      return this.fallback()
    }
  }

  write(value: T): Promise<void> {
    const run = async (): Promise<void> => {
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
      await rename(tmp, this.path)
    }
    const p = this.chain.then(run, run)
    this.chain = p.catch(() => undefined)
    return p
  }

  /** Read-modify-write under the file's write lock. */
  update(fn: (current: T) => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const next = await fn(await this.read())
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
      await rename(tmp, this.path)
      return next
    }
    const p = this.chain.then(run, run)
    this.chain = p.catch(() => undefined)
    return p
  }
}

export interface VariablesFile {
  globals: Variable[]
  currentValues: CurrentValues
  activeEnvironmentId: Id | null
}

export class UserStore {
  readonly settingsFile: JsonFile<Settings>
  readonly varsFile: JsonFile<VariablesFile>
  readonly historyFile: JsonFile<HistoryEntry[]>
  readonly cookiesFile: JsonFile<unknown>
  readonly pickedFilesFile: JsonFile<string[]>
  private settingsCache: Settings | null = null
  private jar: CookieJar | null = null

  constructor(readonly root: string) {
    this.settingsFile = new JsonFile(join(root, 'settings.json'), defaultSettings)
    this.varsFile = new JsonFile(join(root, 'variables.json'), () => ({
      globals: [],
      currentValues: { environments: {}, collections: {} },
      activeEnvironmentId: null
    }))
    this.historyFile = new JsonFile(join(root, 'history.json'), () => [])
    this.cookiesFile = new JsonFile(join(root, 'cookies.json'), () => null)
    this.pickedFilesFile = new JsonFile(join(root, 'picked-files.json'), () => [])
  }

  async getPickedFiles(): Promise<string[]> {
    const v = await this.pickedFilesFile.read()
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  }

  async setPickedFiles(paths: string[]): Promise<void> {
    await this.pickedFilesFile.write(paths.slice(-1000))
  }

  async getSettings(): Promise<Settings> {
    if (!this.settingsCache) this.settingsCache = mergeSettings(defaultSettings(), await this.settingsFile.read())
    return structuredClone(this.settingsCache)
  }

  async updateSettings(patch: DeepPartial<Settings>): Promise<Settings> {
    const next = mergeSettings(await this.getSettings(), patch)
    await this.settingsFile.write(next)
    this.settingsCache = next
    return structuredClone(next)
  }

  async getVariables(): Promise<VariablesFile> {
    const v = await this.varsFile.read()
    return {
      globals: Array.isArray(v.globals) ? v.globals.map(normalizeVariable) : [],
      currentValues: {
        environments: isObj(v.currentValues?.environments) ? v.currentValues.environments : {},
        collections: isObj(v.currentValues?.collections) ? v.currentValues.collections : {}
      },
      activeEnvironmentId: typeof v.activeEnvironmentId === 'string' ? v.activeEnvironmentId : null
    }
  }

  updateVariables(fn: (v: VariablesFile) => void): Promise<VariablesFile> {
    return this.varsFile.update(async (raw) => {
      const v: VariablesFile = {
        globals: Array.isArray(raw.globals) ? raw.globals.map(normalizeVariable) : [],
        currentValues: {
          environments: isObj(raw.currentValues?.environments) ? raw.currentValues.environments : {},
          collections: isObj(raw.currentValues?.collections) ? raw.currentValues.collections : {}
        },
        activeEnvironmentId: typeof raw.activeEnvironmentId === 'string' ? raw.activeEnvironmentId : null
      }
      fn(v)
      return v
    })
  }

  async listHistory(): Promise<HistoryEntry[]> {
    const h = await this.historyFile.read()
    return Array.isArray(h) ? h : []
  }

  async addHistory(entry: HistoryEntry): Promise<void> {
    await this.historyFile.update((h) => [{ ...entry, request: normalizeRequest(entry.request) }, ...(Array.isArray(h) ? h : [])].slice(0, HISTORY_LIMIT))
  }

  async deleteHistory(id: Id): Promise<void> {
    await this.historyFile.update((h) => (Array.isArray(h) ? h.filter((e) => e.id !== id) : []))
  }

  async clearHistory(): Promise<void> {
    await this.historyFile.write([])
  }

  async cookieJar(): Promise<CookieJar> {
    if (this.jar) return this.jar
    const raw = await this.cookiesFile.read()
    try {
      this.jar = raw ? await CookieJar.deserialize(raw as never) : new CookieJar()
    } catch {
      this.jar = new CookieJar()
    }
    return this.jar
  }

  async saveCookies(): Promise<void> {
    if (!this.jar) return
    await this.cookiesFile.write(await this.jar.serialize())
  }

  async clearCookies(): Promise<void> {
    this.jar = new CookieJar()
    await rm(this.cookiesFile.path, { force: true })
  }
}
