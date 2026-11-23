/**
 * Composition root for the engine. Implements every CourierApi operation that does not need
 * Electron (dialogs/shell live in ipc.ts). Importable and testable in plain Node.
 */
import { join } from 'node:path'
import type { ContainerClient } from '@azure/storage-blob'
import type {
  ConflictDetail,
  ConflictResolution,
  ConnectionTestResult,
  CourierEventName,
  CourierEvents,
  DeepPartial,
  ExportFormat,
  ImportResult,
  MoveResult,
  ResolveConflictResult,
  RunInput,
  ScriptVaultAccess,
  SendRequestInput,
  SnippetInput,
  SyncOverview,
  SyncReport
} from '../shared/api'
import type {
  Auth,
  Collection,
  CollectionEntry,
  CookieInfo,
  Environment,
  EnvironmentEntry,
  ExecutionResult,
  Folder,
  HistoryEntry,
  Id,
  IdentitySettings,
  IdentityStatus,
  Item,
  ItemKind,
  RequestDef,
  SecretFinding,
  SecretSummary,
  SecretValue,
  Settings,
  Space,
  SyncState,
  Variable,
  VariableMutation,
  WorkspaceSnapshot
} from '../shared/types'
import { SPACES, findItem, newCollection, newEnvironment, newId } from '../shared/types'
import {
  isValidId,
  normalizeCollection,
  normalizeEnvironment,
  normalizeItem,
  normalizeRequest,
  normalizeVariable,
  reidItems,
  sameContent,
  serializeCollection,
  serializeEnvironment
} from '../shared/serialize'
import { effectiveValues } from '../shared/variables'
import { exportPostmanCollection, exportPostmanEnvironment, importPostmanCollection, importPostmanEnvironment, isPostmanCollection, isPostmanEnvironment } from '../shared/postman'
import { importOpenApi, parseOpenApiText } from '../shared/openapi'
import { isCurlCommand, parseCurl } from '../shared/curl'
import { generateSnippet } from '../shared/codegen'
import { slugify } from '../shared/slug'
import { IdentityService, type FakeIdentity } from './azure'
import { SyncEngine, createContainerClient, scanDoc } from './blobsync'
import { Fault } from './errors'
import { effectiveAuth, executeRequest, prepareSnippetRequest, type ExecutorDeps } from './executor'
import { KeyVaultService } from './keyvault'
import { planRun, runCollection } from './runner'
import type { ScriptVars } from './sandbox'
import { ScriptTrustStore, type ScriptVaultGate } from './script-trust'
import { UserStore } from './store'
import { LocalCache, type CacheEntry, type Doc, type Tombstone } from './workspace'

export type Emit = <E extends CourierEventName>(event: E, payload: CourierEvents[E]) => void

export interface CoreOptions {
  userDataDir: string
  fakeIdentity?: FakeIdentity | null
  emit?: Emit
  /** Test hook only: relax Key Vault challenge-resource verification (mock vault on 127.0.0.1). */
  keyVaultInsecureChallenge?: boolean
}

function assertId(v: unknown, what = 'id'): asserts v is string {
  if (!isValidId(v)) throw new Fault('INVALID_ARGUMENT', `Invalid ${what}.`)
}
function assertSpace(v: unknown): asserts v is Space {
  if (!SPACES.includes(v as Space)) throw new Fault('INVALID_ARGUMENT', 'Invalid space (expected local, personal or shared).')
}
function assertKind(v: unknown): asserts v is ItemKind {
  if (v !== 'collection' && v !== 'environment') throw new Fault('INVALID_ARGUMENT', 'Invalid kind (expected collection or environment).')
}

function removeItem(items: Item[], id: Id): Item | undefined {
  const i = items.findIndex((x) => x.id === id)
  if (i >= 0) return items.splice(i, 1)[0]
  for (const it of items) if (it.type === 'folder') {
    const r = removeItem(it.items, id)
    if (r) return r
  }
  return undefined
}

function containerOf(c: Collection, parentId: Id | null | undefined): Item[] {
  if (!parentId) return c.items
  const f = findItem(c.items, parentId)
  if (!f || f.item.type !== 'folder') throw new Fault('NOT_FOUND', 'Parent folder not found.')
  return f.item.items
}

export class CourierCore {
  readonly store: UserStore
  readonly cache: LocalCache
  readonly identity: IdentityService
  readonly vault: KeyVaultService
  readonly sync: SyncEngine
  /** This machine's allow-list for scripts reading Key Vault (userData only, never synced). */
  readonly trust: ScriptTrustStore
  private settings!: Settings
  private readonly emit: Emit
  private readonly executions = new Map<string, AbortController>()
  private readonly runs = new Map<string, AbortController>()
  private readonly oauthCache = new Map<string, { token: string; exp: number }>()
  private container: { key: string; client: ContainerClient } | null = null
  private lastReport: SyncReport | null = null
  private pickedFiles = new Set<string>()

  constructor(opts: CoreOptions) {
    this.emit = opts.emit ?? (() => {})
    this.store = new UserStore(opts.userDataDir)
    this.cache = new LocalCache(join(opts.userDataDir, 'data'))
    this.trust = new ScriptTrustStore(opts.userDataDir)
    this.identity = new IdentityService({ mode: 'auto' }, opts.fakeIdentity ?? null, (s) => this.emit('auth:changed', s))
    this.vault = new KeyVaultService({
      credential: this.identity.credential(),
      vaults: () => this.settings.keyVault.vaults,
      ttlSeconds: () => this.settings.keyVault.cacheTtlSeconds,
      disableChallengeResourceVerification: opts.keyVaultInsecureChallenge === true
    })
    this.sync = new SyncEngine({
      cache: this.cache,
      container: () => this.containerClient(),
      identity: () => {
        const a = this.identity.account()
        if (!this.identity.status().signedIn || !a) return null
        return { ...(a.oid ? { oid: a.oid } : {}), label: a.upn ?? a.name ?? a.oid ?? 'unknown' }
      },
      describe: () => ({ accountUrl: this.settings.storage.accountUrl, container: this.settings.storage.container })
    })
  }

  async init(): Promise<void> {
    await this.cache.init()
    this.settings = await this.store.getSettings()
    this.identity.setMode(this.settings.identity.mode)
    this.pickedFiles = new Set(await this.store.getPickedFiles())
  }

  /** Called by main's file dialog: only files picked on this machine may be sent as bodies. */
  async allowFile(path: string): Promise<void> {
    this.pickedFiles.add(path)
    await this.store.setPickedFiles([...this.pickedFiles])
  }

  // -------------------------------------------------------------------------------------------
  // settings / identity
  // -------------------------------------------------------------------------------------------

  getSettings(): Settings {
    return structuredClone(this.settings)
  }

  async updateSettings(patch: DeepPartial<Settings>): Promise<Settings> {
    if (typeof patch !== 'object' || patch === null) throw new Fault('INVALID_ARGUMENT', 'Settings patch must be an object.')
    const before = this.settings
    this.settings = await this.store.updateSettings(patch)
    if (before.storage.accountUrl !== this.settings.storage.accountUrl || before.storage.container !== this.settings.storage.container) this.container = null
    if (JSON.stringify(before.keyVault.vaults) !== JSON.stringify(this.settings.keyVault.vaults)) this.vault.reset()
    this.emit('settings:changed', this.getSettings())
    this.emit('sync:state', await this.syncStatus())
    return this.getSettings()
  }

  identityStatus(): IdentityStatus {
    return this.identity.status()
  }

  async signIn(partial?: Partial<IdentitySettings>): Promise<IdentityStatus> {
    const merged: IdentitySettings = { ...this.settings.identity, ...(partial ?? {}) }
    this.settings = await this.store.updateSettings({ identity: merged })
    this.container = null // the storage pipeline caches bearer tokens per client
    this.vault.reset()
    const status = await this.identity.signIn(this.settings.identity)
    this.container = null
    this.vault.reset()
    this.emit('workspace:changed', { reason: 'sync', refs: [] })
    this.emit('sync:state', await this.syncStatus())
    return status
  }

  async signOut(): Promise<IdentityStatus> {
    const s = this.identity.signOut()
    this.container = null
    this.vault.reset()
    this.oauthCache.clear()
    this.emit('workspace:changed', { reason: 'sync', refs: [] })
    this.emit('sync:state', await this.syncStatus())
    return s
  }

  private containerClient(): ContainerClient | null {
    const { accountUrl, container } = this.settings.storage
    if (!accountUrl || !container) return null
    const key = `${accountUrl}|${container}`
    if (!this.container || this.container.key !== key) this.container = { key, client: createContainerClient(accountUrl, container, this.identity.credential()) }
    return this.container.client
  }

  private currentOid(): string | null {
    return this.identity.status().signedIn ? (this.identity.account()?.oid ?? null) : null
  }

  private syncFor(space: Space): SyncState {
    if (space === 'local') return { space, dirty: false }
    if (space === 'personal') {
      const oid = this.currentOid()
      if (!oid) throw new Fault('NOT_SIGNED_IN', 'Sign in with your Azure identity to use the personal space.')
      return { space, ownerOid: oid, dirty: true }
    }
    return { space, dirty: true }
  }

  private visible(e: { sync: SyncState }): boolean {
    if (e.sync.space !== 'personal') return true
    const oid = this.currentOid()
    return oid === null || e.sync.ownerOid === oid
  }

  // -------------------------------------------------------------------------------------------
  // workspace
  // -------------------------------------------------------------------------------------------

  async load(): Promise<WorkspaceSnapshot> {
    const vars = await this.store.getVariables()
    const cols = (await this.cache.list('collection')).filter((e) => this.visible(e))
    const envs = (await this.cache.list('environment')).filter((e) => this.visible(e))
    const byName = (a: CacheEntry, b: CacheEntry): number => a.doc.name.localeCompare(b.doc.name)
    return {
      collections: cols.sort(byName).map((e) => ({ collection: e.doc as Collection, sync: e.sync })),
      environments: envs.sort(byName).map((e) => ({ environment: e.doc as Environment, sync: e.sync })),
      globals: vars.globals,
      currentValues: vars.currentValues,
      activeEnvironmentId: vars.activeEnvironmentId && envs.some((e) => e.doc.id === vars.activeEnvironmentId) ? vars.activeEnvironmentId : null,
      personalOid: this.currentOid()
    }
  }

  private async getEntry(kind: ItemKind, id: unknown): Promise<CacheEntry> {
    assertId(id)
    const e = await this.cache.require(kind, id)
    if (!this.visible(e)) throw new Fault('NOT_FOUND', `${kind === 'collection' ? 'Collection' : 'Environment'} not found.`)
    return e
  }

  /** Secret-typed variable values never go into the doc: move them into this machine's current values. */
  private async extractSecrets(kind: ItemKind, doc: Collection | Environment): Promise<void> {
    const secrets = doc.variables.filter((v) => v.type === 'secret' && v.value !== '')
    if (!secrets.length) return
    await this.store.updateVariables((v) => {
      const bucket = kind === 'collection' ? v.currentValues.collections : v.currentValues.environments
      const cur = (bucket[doc.id] = bucket[doc.id] ?? {})
      for (const s of secrets) cur[s.key] = s.value
    })
    for (const s of secrets) s.value = ''
    this.emit('variables:changed', { reason: 'edit' })
  }

  private async saveDoc(kind: ItemKind, doc: Doc, existing: CacheEntry, reason: 'save' | 'move' = 'save'): Promise<CacheEntry> {
    const changed = !sameContent(existing.doc, doc, kind)
    if (!changed && reason === 'save') return existing
    const stamped = { ...doc, updatedAt: new Date().toISOString() } as Doc
    if (existing.sync.space === 'local') {
      const a = this.identity.account()
      if (a?.upn || a?.name) stamped.updatedBy = a.upn ?? a.name
    }
    const sync: SyncState = { ...existing.sync, dirty: existing.sync.space !== 'local' ? true : false }
    const saved = await this.cache.put(kind, stamped, sync)
    // The user's own edit: keep a (still valid) script → Key Vault grant bound to the new script text.
    if (kind === 'collection') await this.trust.rebind(existing.doc as Collection, stamped as Collection)
    this.emit('workspace:changed', { reason, refs: [{ kind, id: doc.id, name: doc.name, space: sync.space }] })
    return saved
  }

  private toCollectionEntry(e: CacheEntry): CollectionEntry {
    return { collection: e.doc as Collection, sync: e.sync }
  }
  private toEnvironmentEntry(e: CacheEntry): EnvironmentEntry {
    return { environment: e.doc as Environment, sync: e.sync }
  }

  async createDoc(kind: ItemKind, input: { name: string; space?: Space }): Promise<CacheEntry> {
    const name = typeof input?.name === 'string' && input.name.trim() ? input.name.trim() : kind === 'collection' ? 'New Collection' : 'New Environment'
    const space = input?.space ?? 'local'
    assertSpace(space)
    const doc = kind === 'collection' ? newCollection({ name }) : newEnvironment({ name })
    doc.updatedAt = new Date().toISOString()
    const e = await this.cache.put(kind, doc, this.syncFor(space))
    this.emit('workspace:changed', { reason: 'save', refs: [{ kind, id: doc.id, name, space }] })
    return e
  }

  async createCollection(input: { name: string; space?: Space }): Promise<CollectionEntry> {
    return this.toCollectionEntry(await this.createDoc('collection', input))
  }
  async createEnvironment(input: { name: string; space?: Space }): Promise<EnvironmentEntry> {
    return this.toEnvironmentEntry(await this.createDoc('environment', input))
  }

  saveCollection(raw: Collection): Promise<CollectionEntry> {
    const doc = normalizeCollection(raw)
    return this.cache.lock(async () => {
      const existing = await this.getEntry('collection', (raw as { id?: unknown })?.id)
      await this.extractSecrets('collection', doc)
      return this.toCollectionEntry(await this.saveDoc('collection', doc, existing))
    })
  }

  saveEnvironment(raw: Environment): Promise<EnvironmentEntry> {
    const doc = normalizeEnvironment(raw)
    return this.cache.lock(async () => {
      const existing = await this.getEntry('environment', (raw as { id?: unknown })?.id)
      await this.extractSecrets('environment', doc)
      return this.toEnvironmentEntry(await this.saveDoc('environment', doc, existing))
    })
  }

  private mutateCollection(id: unknown, fn: (c: Collection) => void): Promise<CollectionEntry> {
    return this.cache.lock(async () => {
      const e = await this.getEntry('collection', id)
      const c = structuredClone(e.doc) as Collection
      fn(c)
      return this.toCollectionEntry(await this.saveDoc('collection', normalizeCollection(c), e))
    })
  }

  upsertItem(input: { collectionId: Id; parentId?: Id | null; item: Item; index?: number }): Promise<CollectionEntry> {
    if (input?.parentId != null) assertId(input.parentId, 'parent id')
    const item = normalizeItem(input?.item)
    return this.mutateCollection(input?.collectionId, (c) => {
      const existing = findItem(c.items, item.id)
      const targetParent = input.parentId ?? null
      if (existing) {
        const currentParent = existing.parents.length ? existing.parents[existing.parents.length - 1].id : null
        if (currentParent === targetParent && input.index === undefined) {
          const list = containerOf(c, currentParent)
          list[list.findIndex((x) => x.id === item.id)] = item
          return
        }
        if (item.type === 'folder' && targetParent && (targetParent === item.id || findItem(item.items, targetParent)))
          throw new Fault('INVALID_ARGUMENT', 'A folder cannot be moved into itself.')
        removeItem(c.items, item.id)
      }
      const list = containerOf(c, targetParent)
      const idx = input.index === undefined ? list.length : Math.max(0, Math.min(list.length, Math.floor(input.index)))
      list.splice(idx, 0, item)
    })
  }

  deleteItem(input: { collectionId: Id; itemId: Id }): Promise<CollectionEntry> {
    assertId(input?.itemId, 'item id')
    return this.mutateCollection(input.collectionId, (c) => {
      if (!removeItem(c.items, input.itemId)) throw new Fault('NOT_FOUND', 'Item not found in collection.')
    })
  }

  moveItem(input: { collectionId: Id; itemId: Id; parentId: Id | null; index: number }): Promise<CollectionEntry> {
    assertId(input?.itemId, 'item id')
    if (input.parentId !== null) assertId(input.parentId, 'parent id')
    return this.mutateCollection(input.collectionId, (c) => {
      const found = findItem(c.items, input.itemId)
      if (!found) throw new Fault('NOT_FOUND', 'Item not found in collection.')
      if (found.item.type === 'folder' && input.parentId && (input.parentId === found.item.id || findItem(found.item.items, input.parentId)))
        throw new Fault('INVALID_ARGUMENT', 'A folder cannot be moved into itself.')
      const item = removeItem(c.items, input.itemId) as Item
      const list = containerOf(c, input.parentId)
      list.splice(Math.max(0, Math.min(list.length, Math.floor(Number(input.index) || 0))), 0, item)
    })
  }

  duplicate(kind: ItemKind, id: Id): Promise<CacheEntry> {
    return this.cache.lock(() => this.duplicateLocked(kind, id))
  }

  private async duplicateLocked(kind: ItemKind, id: Id): Promise<CacheEntry> {
    const e = await this.getEntry(kind, id)
    const doc = structuredClone(e.doc) as Doc
    doc.id = newId()
    doc.name = `${e.doc.name} Copy`
    delete doc.updatedBy
    doc.updatedAt = new Date().toISOString()
    if (kind === 'collection') (doc as Collection).items = reidItems((doc as Collection).items)
    const sync: SyncState = e.sync.space === 'local' ? { space: 'local', dirty: false } : this.syncFor(e.sync.space)
    const saved = await this.cache.put(kind, doc, sync)
    await this.store.updateVariables((v) => {
      const bucket = kind === 'collection' ? v.currentValues.collections : v.currentValues.environments
      if (bucket[id]) bucket[doc.id] = { ...bucket[id] }
    })
    this.emit('workspace:changed', { reason: 'save', refs: [{ kind, id: doc.id, name: doc.name, space: sync.space }] })
    return saved
  }

  async deleteDoc(kind: ItemKind, id: Id): Promise<void> {
    const { e, tomb } = await this.cache.lock(async () => {
      const e = await this.getEntry(kind, id)
      let tomb: Tombstone | undefined
      if (e.sync.space !== 'local' && e.sync.etag) {
        tomb = { kind, id: e.doc.id, name: e.doc.name, space: e.sync.space, etag: e.sync.etag, ...(e.sync.ownerOid ? { ownerOid: e.sync.ownerOid } : {}) }
      }
      await this.cache.remove(kind, e.doc.id, tomb)
      return { e, tomb }
    })
    if (kind === 'collection') await this.trust.revoke(e.doc.id)
    await this.store.updateVariables((v) => {
      if (kind === 'collection') delete v.currentValues.collections[e.doc.id]
      else {
        delete v.currentValues.environments[e.doc.id]
        if (v.activeEnvironmentId === e.doc.id) v.activeEnvironmentId = null
      }
    })
    if (tomb) await this.sync.flushTombstone(tomb)
    this.emit('workspace:changed', { reason: 'delete', refs: [{ kind, id: e.doc.id, name: e.doc.name, space: e.sync.space }] })
  }

  move(kind: ItemKind, input: { id: Id; space: Space; acknowledgeWarnings?: boolean }): Promise<MoveResult> {
    assertSpace(input?.space)
    return this.cache.lock(() => this.moveLocked(kind, input))
  }

  private async moveLocked(kind: ItemKind, input: { id: Id; space: Space; acknowledgeWarnings?: boolean }): Promise<MoveResult> {
    const e = await this.getEntry(kind, input.id)
    if (e.sync.space === input.space) return { moved: true, warnings: [] }
    const warnings = input.space === 'shared' ? scanDoc(kind, e.doc) : []
    if (warnings.length && !input.acknowledgeWarnings) return { moved: false, warnings }
    if (e.sync.conflict) throw new Fault('CONFLICT', 'Resolve the sync conflict before moving this item.')
    const sync = this.syncFor(input.space)
    if (e.sync.space !== 'local' && e.sync.etag) {
      await this.cache.addTombstone({ kind, id: e.doc.id, name: e.doc.name, space: e.sync.space, etag: e.sync.etag, ...(e.sync.ownerOid ? { ownerOid: e.sync.ownerOid } : {}) })
    }
    await this.cache.put(kind, e.doc, sync)
    this.emit('workspace:changed', { reason: 'move', refs: [{ kind, id: e.doc.id, name: e.doc.name, space: input.space }] })
    return { moved: true, warnings }
  }

  async setActiveEnvironment(id: Id | null): Promise<void> {
    if (id !== null) await this.getEntry('environment', id)
    await this.store.updateVariables((v) => {
      v.activeEnvironmentId = id
    })
    this.emit('variables:changed', { reason: 'edit' })
  }

  async setGlobals(vars: Variable[]): Promise<void> {
    if (!Array.isArray(vars)) throw new Fault('INVALID_ARGUMENT', 'Globals must be an array.')
    await this.store.updateVariables((v) => {
      v.globals = vars.map(normalizeVariable)
    })
    this.emit('variables:changed', { reason: 'edit' })
  }

  async setCurrentValues(input: { scope: 'environment' | 'collection'; id: Id; values: Record<string, string> }): Promise<void> {
    if (input?.scope !== 'environment' && input?.scope !== 'collection') throw new Fault('INVALID_ARGUMENT', 'Invalid scope.')
    assertId(input.id)
    const values: Record<string, string> = {}
    for (const [k, val] of Object.entries(input.values ?? {})) if (typeof val === 'string') values[k] = val
    await this.store.updateVariables((v) => {
      const bucket = input.scope === 'collection' ? v.currentValues.collections : v.currentValues.environments
      if (Object.keys(values).length) bucket[input.id] = values
      else delete bucket[input.id]
    })
    this.emit('variables:changed', { reason: 'edit' })
  }

  // -------------------------------------------------------------------------------------------
  // execution
  // -------------------------------------------------------------------------------------------

  private async resolveScope(
    input: { collectionId?: Id | null; requestId?: Id | null; draft?: RequestDef; environmentId?: Id | null },
    needRequest = true
  ): Promise<{
    collection: Collection | null
    folders: Folder[]
    request: RequestDef | null
    vars: ScriptVars
    environmentId: Id | null
  }> {
    let collection: Collection | null = null
    let folders: Folder[] = []
    let request: RequestDef | null = null
    if (input?.collectionId) {
      collection = (await this.getEntry('collection', input.collectionId)).doc as Collection
      if (input.requestId) {
        assertId(input.requestId, 'request id')
        const found = findItem(collection.items, input.requestId)
        if (!found || found.item.type !== 'request') throw new Fault('NOT_FOUND', 'Request not found in collection.')
        request = found.item
        folders = found.parents
      }
    }
    if (input?.draft) request = normalizeRequest(input.draft)
    if (!request && needRequest) throw new Fault('INVALID_ARGUMENT', 'Nothing to send: pass a requestId or a draft.')
    const vars = await this.store.getVariables()
    let environmentId: Id | null = input?.environmentId === undefined ? vars.activeEnvironmentId : input.environmentId
    let environment: Environment | null = null
    if (environmentId) {
      try {
        environment = (await this.getEntry('environment', environmentId)).doc as Environment
      } catch (err) {
        if (input?.environmentId !== undefined) throw err
        environmentId = null
      }
    }
    return {
      collection,
      folders,
      request,
      environmentId,
      vars: {
        global: effectiveValues(vars.globals),
        collection: collection ? effectiveValues(collection.variables, vars.currentValues.collections[collection.id]) : {},
        environment: environment ? effectiveValues(environment.variables, vars.currentValues.environments[environment.id]) : {},
        data: {},
        local: {}
      }
    }
  }

  /**
   * May scripts in this execution obtain Key Vault values? Only when this machine allows the
   * collection and the grant's script hash matches the collection being executed. An unsaved draft's
   * request scripts must equal the saved request's (history replays, copies and unsaved edits are
   * not covered by the grant).
   */
  private async scriptVaultGate(collection: Collection | null, draft?: { request: RequestDef; requestId?: Id | null }): Promise<ScriptVaultGate> {
    if (!collection) return { allowed: false, reason: 'no-collection' }
    const base = { collectionId: collection.id, collectionName: collection.name }
    const { allowed, lapsed } = await this.trust.check(collection)
    if (!allowed) return { allowed: false, reason: lapsed ? 'lapsed' : 'not-allowed', ...base }
    if (draft && (draft.request.preRequestScript.trim() || draft.request.testScript.trim())) {
      const saved = draft.requestId ? findItem(collection.items, draft.requestId)?.item : undefined
      if (!saved || saved.type !== 'request' || saved.preRequestScript !== draft.request.preRequestScript || saved.testScript !== draft.request.testScript)
        return { allowed: false, reason: 'unsaved-scripts', ...base }
    }
    return { allowed: true, ...base }
  }

  async getScriptVaultAccess(id: Id): Promise<ScriptVaultAccess> {
    const e = await this.getEntry('collection', id)
    return this.trust.access(e.doc as Collection)
  }

  async setScriptVaultAccess(input: { id: Id; allowed: boolean }): Promise<ScriptVaultAccess> {
    if (typeof input?.allowed !== 'boolean') throw new Fault('INVALID_ARGUMENT', 'allowed must be true or false.')
    return this.cache.lock(async () => {
      const e = await this.getEntry('collection', input.id)
      if (input.allowed) await this.trust.grant(e.doc as Collection)
      else await this.trust.revoke(e.doc.id)
      return this.trust.access(e.doc as Collection)
    })
  }

  /** After content arrived from the cloud: withdraw grants whose script text changed. */
  private async reconcileTrust(): Promise<void> {
    const all = await this.cache.list('collection')
    await this.trust.reconcile(new Map(all.map((e) => [e.doc.id, e.doc as Collection])))
  }

  private async deps(): Promise<ExecutorDeps> {
    return {
      settings: this.settings,
      tokens: { getToken: (scope: string) => this.identity.getToken(scope) },
      vault: this.vault,
      cookieJar: await this.store.cookieJar(),
      oauthCache: this.oauthCache,
      fileAllowed: (p: string) => this.pickedFiles.has(p)
    }
  }

  private async persistMutations(mutations: VariableMutation[], ctx: { environmentId: Id | null; collectionId: Id | null }): Promise<boolean> {
    const relevant = mutations.filter((m) => m.scope !== 'local')
    if (!relevant.length) return false
    await this.store.updateVariables((v) => {
      for (const m of relevant) {
        if (m.scope === 'global') {
          const i = v.globals.findIndex((g) => g.key === m.key)
          if (m.action === 'set') {
            if (i >= 0) v.globals[i] = { ...v.globals[i], value: m.value ?? '', enabled: true }
            else v.globals.push({ key: m.key, value: m.value ?? '', enabled: true, type: 'default' })
          } else if (i >= 0) v.globals.splice(i, 1)
        } else {
          const id = m.scope === 'environment' ? ctx.environmentId : ctx.collectionId
          if (!id) continue
          const bucket = m.scope === 'environment' ? v.currentValues.environments : v.currentValues.collections
          const cur = (bucket[id] = bucket[id] ?? {})
          if (m.action === 'set') cur[m.key] = m.value ?? ''
          else delete cur[m.key]
        }
      }
    })
    return true
  }

  async send(input: SendRequestInput): Promise<ExecutionResult> {
    const scope = await this.resolveScope(input)
    const executionId = typeof input.executionId === 'string' && input.executionId ? input.executionId.slice(0, 100) : newId()
    const ac = new AbortController()
    this.executions.set(executionId, ac)
    try {
      const request = scope.request as RequestDef
      const scriptVault = await this.scriptVaultGate(scope.collection, input.draft ? { request, requestId: input.requestId } : undefined)
      const result = await executeRequest(
        { collection: scope.collection, folders: scope.folders, request, vars: scope.vars },
        { ...(await this.deps()), scriptVault },
        { executionId, signal: ac.signal }
      )
      const changed = await this.persistMutations(result.mutations, { environmentId: scope.environmentId, collectionId: scope.collection?.id ?? null })
      const entry: HistoryEntry = {
        id: newId(),
        at: result.startedAt,
        name: result.name,
        method: result.request.method,
        url: result.request.url,
        ...(result.response ? { status: result.response.status, timeMs: result.response.timeMs, sizeBytes: result.response.sizeBytes } : {}),
        ...(result.error ? { error: result.error.message } : {}),
        ...(scope.collection ? { collectionId: scope.collection.id } : {}),
        ...(input.requestId ? { requestId: input.requestId } : {}),
        request
      }
      await this.store.addHistory(entry)
      await this.store.saveCookies()
      this.emit('history:changed', {})
      if (result.response?.cookies.length) this.emit('cookies:changed', {})
      if (changed) this.emit('variables:changed', { reason: 'request' })
      return result
    } finally {
      this.executions.delete(executionId)
    }
  }

  cancel(executionId: string): boolean {
    const ac = this.executions.get(executionId)
    if (!ac) return false
    ac.abort()
    return true
  }

  async snippet(input: SnippetInput): Promise<string> {
    if (!['curl', 'js-fetch', 'python-requests'].includes(input?.language)) throw new Fault('INVALID_ARGUMENT', 'Unknown snippet language.')
    const scope = await this.resolveScope(input)
    const req = await prepareSnippetRequest({ collection: scope.collection, folders: scope.folders, request: scope.request as RequestDef, vars: scope.vars })
    return generateSnippet(req, input.language)
  }

  async effectiveAuth(input: { collectionId: Id; itemId: Id | null }): Promise<{ auth: Auth; from: string }> {
    const c = (await this.getEntry('collection', input?.collectionId)).doc as Collection
    if (!input.itemId) return { auth: c.auth.type === 'inherit' ? { type: 'none' } : c.auth, from: c.name }
    const found = findItem(c.items, input.itemId)
    if (!found) throw new Fault('NOT_FOUND', 'Item not found in collection.')
    if (found.item.type === 'request') return effectiveAuth(c, found.parents, found.item)
    return effectiveAuth(c, [...found.parents, found.item], null)
  }

  // -------------------------------------------------------------------------------------------
  // runner
  // -------------------------------------------------------------------------------------------

  async startRun(input: RunInput): Promise<{ runId: string; done: Promise<void> }> {
    if (!input?.collectionId) throw new Fault('INVALID_ARGUMENT', 'collectionId is required.')
    const scope = await this.resolveScope({ collectionId: input.collectionId, environmentId: input.environmentId }, false)
    const collection = scope.collection as Collection
    if (input.folderId) assertId(input.folderId, 'folder id')
    const plan = planRun(collection, { folderId: input.folderId, requestIds: Array.isArray(input.requestIds) ? input.requestIds : undefined })
    if (!plan.length) throw new Fault('INVALID_ARGUMENT', 'There are no requests to run.')
    const data = Array.isArray(input.data) ? input.data.filter((r) => typeof r === 'object' && r !== null).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)]))) : undefined
    const runId = newId()
    const ac = new AbortController()
    this.runs.set(runId, ac)
    const deps: ExecutorDeps = { ...(await this.deps()), scriptVault: await this.scriptVaultGate(collection) }
    const done = runCollection(
      {
        runId,
        collection,
        plan,
        vars: scope.vars,
        iterations: Math.min(10_000, Math.max(1, Math.floor(Number(input.iterations) || 1))),
        delayMs: Math.min(600_000, Math.max(0, Math.floor(Number(input.delayMs) || 0))),
        stopOnFailure: input.stopOnFailure === true,
        data,
        signal: ac.signal,
        onProgress: (p) => this.emit('runner:progress', { runId, ...p })
      },
      deps
    )
      .then(async (outcome) => {
        if (input.persistVariables !== false) {
          const changed = await this.persistMutations(outcome.mutations, { environmentId: scope.environmentId, collectionId: collection.id })
          if (changed) this.emit('variables:changed', { reason: 'run' })
        }
        await this.store.saveCookies()
        this.emit('runner:finished', outcome.summary)
      })
      .catch((err: unknown) => {
        const now = new Date().toISOString()
        this.emit('runner:finished', {
          runId,
          collectionId: collection.id,
          startedAt: now,
          finishedAt: now,
          durationMs: 0,
          iterations: 0,
          totalRequests: 0,
          failedRequests: 0,
          totalTests: 0,
          passedTests: 0,
          failedTests: 0,
          stopped: true,
          stoppedReason: 'error',
          results: []
        })
        console.error('[courier] run failed', err)
      })
      .finally(() => this.runs.delete(runId))
    return { runId, done }
  }

  stopRun(runId: string): boolean {
    const ac = this.runs.get(runId)
    if (!ac) return false
    ac.abort()
    return true
  }

  // -------------------------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------------------------

  async syncStatus(): Promise<SyncOverview> {
    const all = [...(await this.cache.list('collection')), ...(await this.cache.list('environment'))].filter((e) => this.visible(e))
    const tombs = await this.cache.tombstones()
    return {
      configured: Boolean(this.settings.storage.accountUrl && this.settings.storage.container),
      accountUrl: this.settings.storage.accountUrl,
      container: this.settings.storage.container,
      signedIn: this.identity.status().signedIn,
      running: this.sync.isRunning,
      pending: all.filter((e) => e.sync.space !== 'local' && e.sync.dirty).length + tombs.length,
      pendingDeletes: tombs.map((t) => ({ kind: t.kind, id: t.id, name: t.name, space: t.space })),
      conflicts: all.filter((e) => e.sync.conflict).map((e) => ({ kind: e.kind, id: e.doc.id, name: e.doc.name, space: e.sync.space })),
      lastReport: this.lastReport
    }
  }

  async runSync(input?: { acknowledgeWarnings?: boolean }): Promise<SyncReport> {
    const p = this.sync.run({ acknowledgeWarnings: input?.acknowledgeWarnings === true })
    p.catch(() => undefined) // awaited below; avoid an unhandled rejection while we emit state
    this.emit('sync:state', await this.syncStatus())
    try {
      const report = await p
      this.lastReport = report
      this.emit('workspace:changed', { reason: 'sync', refs: [...report.downloaded, ...report.removedLocally, ...report.conflicts, ...report.uploaded] })
      return report
    } finally {
      // Even after a partial sync. (Send/run time re-checks the hash anyway; this keeps the UI honest.)
      await this.reconcileTrust().catch(() => undefined)
      this.emit('sync:state', await this.syncStatus())
    }
  }

  async discardLocalChanges(input: { kind: ItemKind; id: Id }): Promise<SyncReport> {
    assertKind(input?.kind)
    assertId(input.id)
    await this.sync.discardLocal(input.kind, input.id)
    this.emit('workspace:changed', { reason: 'sync', refs: [] })
    return this.runSync()
  }

  testConnection(): Promise<ConnectionTestResult> {
    return this.sync.testConnection()
  }

  async getConflict(input: { kind: ItemKind; id: Id }): Promise<ConflictDetail> {
    assertKind(input?.kind)
    assertId(input.id)
    return this.sync.getConflict(input.kind, input.id)
  }

  async resolveConflict(input: { kind: ItemKind; id: Id; resolution: ConflictResolution; acknowledgeWarnings?: boolean }): Promise<ResolveConflictResult> {
    assertKind(input?.kind)
    assertId(input.id)
    if (!['mine', 'theirs', 'both'].includes(input.resolution)) throw new Fault('INVALID_ARGUMENT', 'Resolution must be mine, theirs or both.')
    const r = await this.sync.resolveConflict(input.kind, input.id, input.resolution, { acknowledgeWarnings: input.acknowledgeWarnings === true })
    await this.reconcileTrust()
    this.lastReport = r.report
    this.emit('workspace:changed', { reason: 'conflict', refs: [] })
    this.emit('sync:state', await this.syncStatus())
    return r
  }

  async scan(input: { kind: ItemKind; id: Id }): Promise<SecretFinding[]> {
    assertKind(input?.kind)
    const e = await this.getEntry(input.kind, input.id)
    return scanDoc(input.kind, e.doc)
  }

  // -------------------------------------------------------------------------------------------
  // vault
  // -------------------------------------------------------------------------------------------

  vaultList(input?: { alias?: string }): Promise<SecretSummary[]> {
    return this.vault.list(input?.alias)
  }
  vaultGet(input: { alias?: string; name: string; version?: string }): Promise<SecretValue> {
    if (typeof input?.name !== 'string') throw new Fault('INVALID_ARGUMENT', 'Secret name is required.')
    return this.vault.get(input)
  }
  vaultSet(input: { alias?: string; name: string; value: string; contentType?: string }): Promise<SecretSummary> {
    if (typeof input?.name !== 'string' || typeof input.value !== 'string') throw new Fault('INVALID_ARGUMENT', 'Secret name and value are required.')
    return this.vault.set(input)
  }

  // -------------------------------------------------------------------------------------------
  // import / export
  // -------------------------------------------------------------------------------------------

  async importText(text: string, space: Space = 'local'): Promise<ImportResult> {
    if (typeof text !== 'string' || !text.trim()) throw new Fault('INVALID_ARGUMENT', 'Nothing to import.')
    assertSpace(space)
    try {
      if (isCurlCommand(text)) {
        const { request, warnings } = parseCurl(text)
        return { kind: 'request', request, warnings }
      }
      let json: unknown = undefined
      try {
        json = JSON.parse(text)
      } catch {
        /* maybe YAML */
      }
      if (json !== undefined && isPostmanCollection(json)) {
        const { value, warnings } = importPostmanCollection(json)
        await this.extractSecrets('collection', value)
        const e = await this.cache.put('collection', value, this.syncFor(space))
        this.emit('workspace:changed', { reason: 'import', refs: [{ kind: 'collection', id: value.id, name: value.name, space }] })
        return { kind: 'collection', entry: this.toCollectionEntry(e), warnings }
      }
      if (json !== undefined && isPostmanEnvironment(json)) {
        const { value, warnings } = importPostmanEnvironment(json)
        await this.extractSecrets('environment', value)
        const e = await this.cache.put('environment', value, this.syncFor(space))
        this.emit('workspace:changed', { reason: 'import', refs: [{ kind: 'environment', id: value.id, name: value.name, space }] })
        return { kind: 'environment', entry: this.toEnvironmentEntry(e), warnings }
      }
      if (json !== undefined && typeof json === 'object' && json !== null && (json as { schema?: unknown }).schema === 'courier.collection/v1') {
        const value = normalizeCollection({ ...(json as object), id: newId() })
        const e = await this.cache.put('collection', value, this.syncFor(space))
        this.emit('workspace:changed', { reason: 'import', refs: [{ kind: 'collection', id: value.id, name: value.name, space }] })
        return { kind: 'collection', entry: this.toCollectionEntry(e), warnings: [] }
      }
      if (json !== undefined && typeof json === 'object' && json !== null && (json as { schema?: unknown }).schema === 'courier.environment/v1') {
        const value = normalizeEnvironment({ ...(json as object), id: newId() })
        const e = await this.cache.put('environment', value, this.syncFor(space))
        this.emit('workspace:changed', { reason: 'import', refs: [{ kind: 'environment', id: value.id, name: value.name, space }] })
        return { kind: 'environment', entry: this.toEnvironmentEntry(e), warnings: [] }
      }
      if (parseOpenApiText(text)) {
        const { value, warnings } = importOpenApi(text)
        const e = await this.cache.put('collection', value, this.syncFor(space))
        this.emit('workspace:changed', { reason: 'import', refs: [{ kind: 'collection', id: value.id, name: value.name, space }] })
        return { kind: 'collection', entry: this.toCollectionEntry(e), warnings }
      }
    } catch (err) {
      if (err instanceof Fault) throw err
      throw new Fault('IMPORT_FAILED', err instanceof Error ? err.message : String(err))
    }
    throw new Fault('IMPORT_FAILED', 'Unrecognised format. Supported: Postman collection/environment (v2.0/v2.1), OpenAPI 3 (JSON/YAML), Courier JSON, cURL.')
  }

  async exportDoc(kind: ItemKind, id: Id, format: ExportFormat): Promise<{ fileName: string; content: string }> {
    if (format !== 'postman' && format !== 'courier') throw new Fault('INVALID_ARGUMENT', 'Unknown export format.')
    const e = await this.getEntry(kind, id)
    const base = slugify(e.doc.name)
    if (kind === 'collection') {
      const c = e.doc as Collection
      return format === 'postman'
        ? { fileName: `${base}.postman_collection.json`, content: JSON.stringify(exportPostmanCollection(c), null, 2) + '\n' }
        : { fileName: `${base}.courier.json`, content: serializeCollection(c) }
    }
    const env = e.doc as Environment
    return format === 'postman'
      ? { fileName: `${base}.postman_environment.json`, content: JSON.stringify(exportPostmanEnvironment(env), null, 2) + '\n' }
      : { fileName: `${base}.courier-env.json`, content: serializeEnvironment(env) }
  }

  // -------------------------------------------------------------------------------------------
  // history / cookies
  // -------------------------------------------------------------------------------------------

  listHistory(): Promise<HistoryEntry[]> {
    return this.store.listHistory()
  }
  async deleteHistory(id: Id): Promise<void> {
    assertId(id)
    await this.store.deleteHistory(id)
    this.emit('history:changed', {})
  }
  async clearHistory(): Promise<void> {
    await this.store.clearHistory()
    this.emit('history:changed', {})
  }

  async listCookies(): Promise<CookieInfo[]> {
    const jar = await this.store.cookieJar()
    const ser = (await jar.serialize()) as { cookies?: Record<string, unknown>[] }
    return (ser.cookies ?? []).map((c) => ({
      key: String(c.key ?? ''),
      value: String(c.value ?? ''),
      domain: String(c.domain ?? ''),
      path: String(c.path ?? '/'),
      ...(c.expires && c.expires !== 'Infinity' ? { expires: String(c.expires) } : {}),
      httpOnly: c.httpOnly === true,
      secure: c.secure === true,
      ...(c.sameSite ? { sameSite: String(c.sameSite) } : {})
    }))
  }

  async deleteCookie(input: { domain: string; path: string; key: string }): Promise<void> {
    if (typeof input?.domain !== 'string' || typeof input.path !== 'string' || typeof input.key !== 'string') throw new Fault('INVALID_ARGUMENT', 'domain, path and key are required.')
    const jar = await this.store.cookieJar()
    await jar.store.removeCookie(input.domain, input.path, input.key)
    await this.store.saveCookies()
    this.emit('cookies:changed', {})
  }

  async clearCookies(): Promise<void> {
    await this.store.clearCookies()
    this.emit('cookies:changed', {})
  }
}
