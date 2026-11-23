/**
 * Composition root for the engine. Implements every CourierApi operation that does not need
 * Electron (dialogs/shell live in ipc.ts). Importable and testable in plain Node.
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ContainerClient } from '@azure/storage-blob'
import type {
  ConflictDetail,
  ConflictResolution,
  ConnectionTestResult,
  CourierErrorInfo,
  CourierEventName,
  CourierEvents,
  DeepPartial,
  ExportFormat,
  ImportResult,
  LeaveTeamResult,
  MoveResult,
  OAuthAcquireResult,
  OAuthTokenInput,
  OAuthTokenStatus,
  ResolveConflictResult,
  RunInput,
  ScriptVaultAccess,
  SendRequestInput,
  SnippetInput,
  GrpcTlsKind,
  RealtimeTarget,
  WsConnectResult,
  SyncOverview,
  SyncReport,
  TeamProbe,
  TeamSyncStatus
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
  GrpcCallType,
  GrpcDescriptor,
  GrpcRequestDef,
  GrpcServiceInfo,
  GrpcTlsFiles,
  HistoryEntry,
  RealtimeLogEntry,
  WebSocketRequestDef,
  WsMessage,
  Id,
  IdentitySettings,
  IdentityStatus,
  Item,
  ItemKind,
  RequestDef,
  SecretFinding,
  SecretSummary,
  SkippedItem,
  ItemRef,
  SecretValue,
  Settings,
  SyncState,
  Team,
  VaultConfig,
  Variable,
  VariableMutation,
  WorkspaceSnapshot
} from '../shared/types'
import { REQUEST_KIND_LABELS, findItem, newCollection, newEnvironment, newId, type RequestItem } from '../shared/types'
import {
  isValidId,
  normalizeCollection,
  normalizeEnvironment,
  normalizeItem,
  normalizeVariable,
  reidItems,
  sameContent,
  serializeCollection,
  serializeEnvironment
} from '../shared/serialize'
import { effectiveValues, findVaultRefs, replaceVaultRefs, resolveTemplate } from '../shared/variables'
import { isAuthCode, mapAuthStrings } from '../shared/auth'
import { normalizeAuth } from '../shared/serialize'
import { OAuthService, codeConfig, oauthHosts, type OAuthCodeConfig, type Opener, type SecretBox } from './oauth'
import type { DigestCache } from './auth/send-auth'
import { exportPostmanCollection, exportPostmanEnvironment, importPostmanCollection, importPostmanEnvironment, isPostmanCollection, isPostmanEnvironment } from '../shared/postman'
import { importOpenApi, parseOpenApiText } from '../shared/openapi'
import { isCurlCommand, parseCurl } from '../shared/curl'
import { generateSnippet } from '../shared/codegen'
import { collectionNonHttp, skippedNote } from '../shared/realtime'
import { slugify } from '../shared/slug'
import { IdentityService, type FakeIdentity } from './azure'
import { TeamSync, createContainerClient, emptyReport, readManifest, scanDoc, writeManifest, type ManifestRead, type SyncIdentity } from './blobsync'
import { Fault } from './errors'
import { effectiveAuth, executeRequest, prepareSnippetRequest, variableLayers, type ExecutorDeps } from './executor'
import { GrpcManager, reflectDescriptor, type GrpcContext, type GrpcTlsMaterial } from './realtime/grpc'
import { exampleMessage, findMethod, listServices, loadDescriptor, parseProtoFiles } from './realtime/protos'
import { WsManager } from './realtime/websocket'
import { KeyVaultService, teamVaultCandidates, type VaultCandidate } from './keyvault'
import { migrateSpacesToTeams } from './migrate'
import { planRun, runCollection, skippedInScope } from './runner'
import type { ScriptVars } from './sandbox'
import { ScriptTrustStore, type ScriptVaultGate } from './script-trust'
import { JsonFile, UserStore } from './store'
import { TeamStore, normalizeAccountUrl, normalizeContainer, validateOwnVaults, type StoredTeam } from './teams'
import { LocalCache, Mutex, cacheRoot, type CacheEntry, type Doc, type Tombstone } from './workspace'

export type Emit = <E extends CourierEventName>(event: E, payload: CourierEvents[E]) => void

export interface CoreOptions {
  userDataDir: string
  fakeIdentity?: FakeIdentity | null
  emit?: Emit
  /**
   * Test hook only: relax Key Vault challenge-resource verification and accept any https host for
   * team manifest vaults (mock vault on 127.0.0.1).
   */
  keyVaultInsecureChallenge?: boolean
  /**
   * Encrypts OAuth tokens at rest (Electron `safeStorage`). Null/absent = tokens are kept in memory
   * only and never written to disk.
   */
  secretBox?: SecretBox | null
  /** Opens http(s) URLs in the system browser (OAuth authorization code). */
  openExternal?: Opener
  /** OAuth "Get new token" wait for the browser redirect (default 5 minutes). */
  oauthTimeoutMs?: number
}

function assertId(v: unknown, what = 'id'): asserts v is string {
  if (!isValidId(v)) throw new Fault('INVALID_ARGUMENT', `Invalid ${what}.`)
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
  /** The Personal cache (`data/`); team caches live under `data/teams/<teamId>/`. */
  readonly cache: LocalCache
  readonly teams: TeamStore
  readonly identity: IdentityService
  readonly vault: KeyVaultService
  /** This machine's allow-list for scripts reading Key Vault (userData only, never synced). */
  readonly trust: ScriptTrustStore
  /** OAuth 2.0 authorization-code tokens (memory + safeStorage-encrypted file; never synced). */
  readonly oauth: OAuthService
  private readonly digestCache: DigestCache = new Map()
  private settings!: Settings
  private readonly emit: Emit
  private readonly userDataDir: string
  private readonly dataDir: string
  private readonly mutex = new Mutex()
  /** Test hook: any https host for team vaults (see CoreOptions). */
  private readonly anyVaultHost: boolean
  private readonly teamCaches = new Map<Id, LocalCache>()
  private readonly engines = new Map<Id, TeamSync>()
  private readonly containers = new Map<Id, { key: string; client: ContainerClient }>()
  private readonly teamErrors = new Map<Id, CourierErrorInfo>()
  private readonly teamSyncedAt = new Map<Id, string>()
  private readonly executions = new Map<string, AbortController>()
  private readonly runs = new Map<string, AbortController>()
  private readonly oauthCache = new Map<string, { token: string; exp: number }>()
  private syncRunning: Promise<SyncReport> | null = null
  private lastReport: SyncReport | null = null
  private pickedFiles = new Set<string>()
  /** Open WebSocket connections and running gRPC calls (memory only; closed with their window and on quit). */
  readonly websockets = new WsManager()
  readonly grpcCalls = new GrpcManager()
  /** .proto files and import directories picked in this session (the only ones `loadProtos` reads). */
  private readonly protoPicks = new Set<string>()
  /** gRPC CA / client certificate / key paths per request id: this machine only, never synced. */
  private readonly grpcTls: JsonFile<Record<Id, GrpcTlsFiles>>

  constructor(opts: CoreOptions) {
    this.emit = opts.emit ?? (() => {})
    this.userDataDir = opts.userDataDir
    this.dataDir = join(opts.userDataDir, 'data')
    this.anyVaultHost = opts.keyVaultInsecureChallenge === true
    this.store = new UserStore(opts.userDataDir)
    this.cache = new LocalCache(this.dataDir, null, this.mutex)
    this.teams = new TeamStore(opts.userDataDir)
    this.trust = new ScriptTrustStore(opts.userDataDir)
    this.grpcTls = new JsonFile(join(opts.userDataDir, 'grpc-tls.json'), () => ({}))
    this.oauth = new OAuthService({
      userDataDir: opts.userDataDir,
      box: opts.secretBox ?? null,
      open: (url) => (opts.openExternal ? opts.openExternal(url) : Promise.reject(new Error('No system browser is available.'))),
      http: () => ({
        followRedirects: false,
        maxRedirects: 0,
        verifyTls: this.settings.http.verifyTls,
        timeoutMs: this.settings.http.timeoutMs,
        maxResponseBytes: 1024 * 1024
      }),
      ...(opts.oauthTimeoutMs ? { timeoutMs: opts.oauthTimeoutMs } : {})
    })
    this.identity = new IdentityService({ mode: 'auto' }, opts.fakeIdentity ?? null, (s) => this.emit('auth:changed', s))
    this.vault = new KeyVaultService({
      credential: this.identity.credential(),
      vaults: (teamId) => this.vaultCandidates(teamId),
      ttlSeconds: () => this.settings.keyVault.cacheTtlSeconds,
      disableChallengeResourceVerification: opts.keyVaultInsecureChallenge === true
    })
  }

  async init(): Promise<void> {
    await this.teams.load()
    await migrateSpacesToTeams(this.userDataDir, this.teams)
    await this.cache.init()
    for (const t of this.teams.list()) await this.teamCache(t.id).init()
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
    this.containers.clear() // the storage pipeline caches bearer tokens per client
    this.vault.reset()
    const status = await this.identity.signIn(this.settings.identity)
    this.containers.clear()
    this.vault.reset()
    this.emit('workspace:changed', { reason: 'sync', refs: [] })
    this.emit('sync:state', await this.syncStatus())
    return status
  }

  async signOut(): Promise<IdentityStatus> {
    const s = this.identity.signOut()
    this.containers.clear()
    this.vault.reset()
    this.oauthCache.clear()
    this.emit('workspace:changed', { reason: 'sync', refs: [] })
    this.emit('sync:state', await this.syncStatus())
    return s
  }

  // -------------------------------------------------------------------------------------------
  // homes: Personal + one cache / engine / container client per team
  // -------------------------------------------------------------------------------------------

  private teamCache(teamId: Id): LocalCache {
    let c = this.teamCaches.get(teamId)
    if (!c) {
      c = new LocalCache(cacheRoot(this.dataDir, teamId), teamId, this.mutex)
      this.teamCaches.set(teamId, c)
    }
    return c
  }

  /** The cache of a home; throws NOT_FOUND for a team that is not joined. */
  private home(teamId: Id | null | undefined): LocalCache {
    if (teamId === null || teamId === undefined) return this.cache
    this.teams.require(teamId)
    return this.teamCache(teamId)
  }

  /** Personal first, then every joined team. Caches of teams that are not joined are never read. */
  private homes(): LocalCache[] {
    return [this.cache, ...this.teams.list().map((t) => this.teamCache(t.id))]
  }

  private containerClient(teamId: Id): ContainerClient {
    const t = this.teams.require(teamId)
    const key = `${t.accountUrl}|${t.container}`
    const cur = this.containers.get(teamId)
    if (cur && cur.key === key) return cur.client
    const client = createContainerClient(t.accountUrl, t.container, this.identity.credential())
    this.containers.set(teamId, { key, client })
    return client
  }

  private syncIdentity(): SyncIdentity | null {
    const a = this.identity.account()
    if (!this.identity.status().signedIn || !a) return null
    return { label: a.upn ?? a.name ?? a.oid ?? 'unknown' }
  }

  /** The sync engine of a joined team (one per team, kept for the session). */
  engine(teamId: Id): TeamSync {
    this.teams.require(teamId)
    let e = this.engines.get(teamId)
    if (!e) {
      e = new TeamSync({
        team: () => {
          const t = this.teams.require(teamId)
          return { id: t.id, name: TeamStore.displayName(t), accountUrl: t.accountUrl, container: t.container }
        },
        cache: this.teamCache(teamId),
        container: () => this.containerClient(teamId),
        identity: () => this.syncIdentity(),
        locate: async (kind, id) => {
          const f = await this.find(kind, id)
          return f ? { teamId: f.cache.teamId, sync: f.entry.sync } : null
        }
      })
      this.engines.set(teamId, e)
    }
    return e
  }

  private async find(kind: ItemKind, id: Id): Promise<{ cache: LocalCache; entry: CacheEntry } | null> {
    for (const c of this.homes()) {
      const entry = await c.get(kind, id)
      if (entry) return { cache: c, entry }
    }
    return null
  }

  private async listAll(kind: ItemKind): Promise<CacheEntry[]> {
    const out: CacheEntry[] = []
    for (const c of this.homes()) out.push(...(await c.list(kind)))
    return out
  }

  private teamName(teamId: Id | undefined): string {
    if (!teamId) return 'Personal'
    const t = this.teams.get(teamId)
    return t ? TeamStore.displayName(t) : 'a team'
  }

  private ref(kind: ItemKind, doc: { id: Id; name: string }, teamId: Id | null | undefined): ItemRef {
    return { kind, id: doc.id, name: doc.name, ...(teamId ? { teamId } : {}) }
  }

  // -------------------------------------------------------------------------------------------
  // workspace
  // -------------------------------------------------------------------------------------------

  async load(): Promise<WorkspaceSnapshot> {
    const vars = await this.store.getVariables()
    const cols = await this.listAll('collection')
    const envs = await this.listAll('environment')
    const byName = (a: CacheEntry, b: CacheEntry): number => a.doc.name.localeCompare(b.doc.name)
    return {
      collections: cols.sort(byName).map((e) => ({ collection: e.doc as Collection, sync: e.sync })),
      environments: envs.sort(byName).map((e) => ({ environment: e.doc as Environment, sync: e.sync })),
      globals: vars.globals,
      currentValues: vars.currentValues,
      activeEnvironmentId: vars.activeEnvironmentId && envs.some((e) => e.doc.id === vars.activeEnvironmentId) ? vars.activeEnvironmentId : null,
      teams: this.listTeams()
    }
  }

  private async getEntry(kind: ItemKind, id: unknown): Promise<CacheEntry> {
    assertId(id)
    const f = await this.find(kind, id)
    if (!f) throw new Fault('NOT_FOUND', `${kind === 'collection' ? 'Collection' : 'Environment'} not found.`)
    return f.entry
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

  private async saveDoc(kind: ItemKind, doc: Doc, existing: CacheEntry): Promise<CacheEntry> {
    if (sameContent(existing.doc, doc, kind)) return existing
    const teamId = existing.sync.teamId
    const stamped = { ...doc, updatedAt: new Date().toISOString() } as Doc
    if (!teamId) {
      const a = this.identity.account()
      if (a?.upn || a?.name) stamped.updatedBy = a.upn ?? a.name
    }
    const saved = await this.home(teamId).put(kind, stamped, { ...existing.sync, dirty: Boolean(teamId) })
    // The user's own edit: keep a (still valid) script → Key Vault grant bound to the new script text.
    if (kind === 'collection') await this.trust.rebind(existing.doc as Collection, stamped as Collection)
    this.emit('workspace:changed', { reason: 'save', refs: [this.ref(kind, doc, teamId)] })
    return saved
  }

  private toCollectionEntry(e: CacheEntry): CollectionEntry {
    return { collection: e.doc as Collection, sync: e.sync }
  }
  private toEnvironmentEntry(e: CacheEntry): EnvironmentEntry {
    return { environment: e.doc as Environment, sync: e.sync }
  }

  /** Where a new item goes: null/undefined = Personal; otherwise a joined team. */
  private target(teamId: unknown): { cache: LocalCache; teamId: Id | null; sync: SyncState } {
    if (teamId === null || teamId === undefined) return { cache: this.cache, teamId: null, sync: { dirty: false } }
    assertId(teamId, 'team id')
    return { cache: this.home(teamId), teamId, sync: { dirty: true } }
  }

  async createDoc(kind: ItemKind, input: { name: string; teamId?: Id | null }): Promise<CacheEntry> {
    const name = typeof input?.name === 'string' && input.name.trim() ? input.name.trim() : kind === 'collection' ? 'New Collection' : 'New Environment'
    const t = this.target(input?.teamId)
    const doc = kind === 'collection' ? newCollection({ name }) : newEnvironment({ name })
    doc.updatedAt = new Date().toISOString()
    const e = await this.mutex.run(() => t.cache.put(kind, doc, t.sync))
    this.emit('workspace:changed', { reason: 'save', refs: [this.ref(kind, doc, t.teamId)] })
    return e
  }

  async createCollection(input: { name: string; teamId?: Id | null }): Promise<CollectionEntry> {
    return this.toCollectionEntry(await this.createDoc('collection', input))
  }
  async createEnvironment(input: { name: string; teamId?: Id | null }): Promise<EnvironmentEntry> {
    return this.toEnvironmentEntry(await this.createDoc('environment', input))
  }

  saveCollection(raw: Collection): Promise<CollectionEntry> {
    const doc = normalizeCollection(raw)
    return this.mutex.run(async () => {
      const existing = await this.getEntry('collection', (raw as { id?: unknown })?.id)
      await this.extractSecrets('collection', doc)
      return this.toCollectionEntry(await this.saveDoc('collection', doc, existing))
    })
  }

  saveEnvironment(raw: Environment): Promise<EnvironmentEntry> {
    const doc = normalizeEnvironment(raw)
    return this.mutex.run(async () => {
      const existing = await this.getEntry('environment', (raw as { id?: unknown })?.id)
      await this.extractSecrets('environment', doc)
      return this.toEnvironmentEntry(await this.saveDoc('environment', doc, existing))
    })
  }

  private mutateCollection(id: unknown, fn: (c: Collection) => void): Promise<CollectionEntry> {
    return this.mutex.run(async () => {
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
    return this.mutex.run(() => this.duplicateLocked(kind, id))
  }

  private async duplicateLocked(kind: ItemKind, id: Id): Promise<CacheEntry> {
    const e = await this.getEntry(kind, id)
    const doc = structuredClone(e.doc) as Doc
    doc.id = newId()
    doc.name = `${e.doc.name} Copy`
    delete doc.updatedBy
    doc.updatedAt = new Date().toISOString()
    if (kind === 'collection') (doc as Collection).items = reidItems((doc as Collection).items)
    const teamId = e.sync.teamId
    const saved = await this.home(teamId).put(kind, doc, { dirty: Boolean(teamId) })
    await this.store.updateVariables((v) => {
      const bucket = kind === 'collection' ? v.currentValues.collections : v.currentValues.environments
      if (bucket[id]) bucket[doc.id] = { ...bucket[id] }
    })
    this.emit('workspace:changed', { reason: 'save', refs: [this.ref(kind, doc, teamId)] })
    return saved
  }

  async deleteDoc(kind: ItemKind, id: Id): Promise<void> {
    const { e, tomb } = await this.mutex.run(async () => {
      const e = await this.getEntry(kind, id)
      const teamId = e.sync.teamId
      const tomb: Tombstone | undefined = teamId && e.sync.etag ? { kind, id: e.doc.id, name: e.doc.name, etag: e.sync.etag } : undefined
      await this.home(teamId).remove(kind, e.doc.id, tomb)
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
    if (tomb && e.sync.teamId) await this.engine(e.sync.teamId).flushTombstone(tomb)
    this.emit('workspace:changed', { reason: 'delete', refs: [this.ref(kind, e.doc, e.sync.teamId)] })
  }

  move(kind: ItemKind, input: { id: Id; teamId: Id | null; acknowledgeWarnings?: boolean }): Promise<MoveResult> {
    const dest = input?.teamId ?? null
    if (dest !== null) {
      assertId(dest, 'team id')
      this.teams.require(dest)
    }
    return this.mutex.run(() => this.moveLocked(kind, { ...input, teamId: dest }))
  }

  /**
   * Personal ↔ team and team ↔ team. The doc moves between caches right away; the remote part
   * happens on the next sync: the new team uploads it, and only after that upload succeeded is
   * the old team's blob deleted (If-Match on the etag we last saw).
   */
  private async moveLocked(kind: ItemKind, input: { id: Id; teamId: Id | null; acknowledgeWarnings?: boolean }): Promise<MoveResult> {
    const e = await this.getEntry(kind, input.id)
    const from = e.sync.teamId ?? null
    const to = input.teamId
    if (from === to) return { moved: true, warnings: [] }
    const warnings = to !== null ? scanDoc(kind, e.doc) : []
    if (warnings.length && !input.acknowledgeWarnings) return { moved: false, warnings }
    if (e.sync.conflict) throw new Fault('CONFLICT', 'Resolve the sync conflict before moving this item.')
    const src = this.home(from)
    const dst = this.home(to)
    let sync: SyncState = { dirty: to !== null }
    if (to !== null) {
      // Moving back into a team it left before the delete was applied: the blob is still ours.
      const back = (await dst.tombstones()).find((t) => t.kind === kind && t.id === e.doc.id)
      if (back) {
        await dst.removeTombstone(back)
        if (back.etag) sync = { dirty: true, etag: back.etag }
      }
    }
    await dst.put(kind, e.doc, sync)
    const tomb: Tombstone | undefined = from !== null && e.sync.etag ? { kind, id: e.doc.id, name: e.doc.name, etag: e.sync.etag, ...(to !== null ? { movedToTeam: to } : {}) } : undefined
    await src.remove(kind, e.doc.id, tomb)
    this.emit('workspace:changed', { reason: 'move', refs: [this.ref(kind, e.doc, to)] })
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
    input: { collectionId?: Id | null; requestId?: Id | null; draft?: RequestItem; environmentId?: Id | null },
    needRequest = true
  ): Promise<{
    collection: Collection | null
    folders: Folder[]
    /** Any request kind; callers check `type`. */
    request: RequestItem | null
    vars: ScriptVars
    environmentId: Id | null
    /** Key Vault context: the collection's team (null = Personal or no collection). */
    teamId: Id | null
  }> {
    let collection: Collection | null = null
    let teamId: Id | null = null
    let folders: Folder[] = []
    let request: RequestItem | null = null
    if (input?.collectionId) {
      const entry = await this.getEntry('collection', input.collectionId)
      collection = entry.doc as Collection
      teamId = entry.sync.teamId ?? null
      if (input.requestId) {
        assertId(input.requestId, 'request id')
        const found = findItem(collection.items, input.requestId)
        if (!found || found.item.type === 'folder') throw new Fault('NOT_FOUND', 'Request not found in collection.')
        request = found.item
        folders = found.parents
      }
    }
    if (input?.draft) {
      const d = normalizeItem(input.draft)
      if (d.type === 'folder') throw new Fault('INVALID_ARGUMENT', 'A folder cannot be sent.')
      request = d
    }
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
      teamId,
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

  /**
   * After content arrived from the cloud (or a team was left): withdraw grants whose script text
   * changed, and grants of collections that are gone. Always over every home.
   */
  private async reconcileTrust(): Promise<void> {
    const all = await this.listAll('collection')
    await this.trust.reconcile(new Map(all.map((e) => [e.doc.id, e.doc as Collection])))
  }

  private async deps(teamId: Id | null): Promise<ExecutorDeps> {
    const context = teamId ? `team:${teamId}` : 'personal'
    return {
      oauth: { accessToken: (a, signal) => this.oauth.accessToken(codeConfig(a, context), signal) },
      digestCache: this.digestCache,
      settings: this.settings,
      tokens: { getToken: (scope: string) => this.identity.getToken(scope) },
      vault: this.vault.resolver(teamId),
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
      if (scope.request?.type !== 'request') throw new Fault('INVALID_ARGUMENT', `This is a ${REQUEST_KIND_LABELS[scope.request?.type ?? 'request']} request: connect or invoke it from its tab; Send is for HTTP requests.`)
      const request = scope.request
      const scriptVault = await this.scriptVaultGate(scope.collection, input.draft ? { request, requestId: input.requestId } : undefined)
      const result = await executeRequest(
        { collection: scope.collection, folders: scope.folders, request, vars: scope.vars },
        { ...(await this.deps(scope.teamId)), scriptVault },
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
        ...(result.error ? { error: result.error.message } : result.skipped ? { error: 'Skipped by pm.execution.skipRequest()' } : {}),
        ...(scope.collection ? { collectionId: scope.collection.id } : {}),
        ...(input.requestId ? { requestId: input.requestId } : {}),
        request
      }
      await this.store.addHistory(entry)
      await this.store.saveCookies()
      this.emit('history:changed', {})
      if (result.response?.cookies.length || result.cookiesChanged) this.emit('cookies:changed', {})
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
    if (scope.request?.type !== 'request')
      throw new Fault('INVALID_ARGUMENT', `Code snippets are only available for HTTP requests; ${REQUEST_KIND_LABELS[scope.request?.type ?? 'request']} requests have none.`)
    const req = await prepareSnippetRequest({ collection: scope.collection, folders: scope.folders, request: scope.request, vars: scope.vars })
    return generateSnippet(req, input.language)
  }

  async effectiveAuth(input: { collectionId: Id; itemId: Id | null }): Promise<{ auth: Auth; from: string }> {
    const c = (await this.getEntry('collection', input?.collectionId)).doc as Collection
    if (!input.itemId) return { auth: c.auth.type === 'inherit' ? { type: 'none' } : c.auth, from: c.name }
    const found = findItem(c.items, input.itemId)
    if (!found) throw new Fault('NOT_FOUND', 'Item not found in collection.')
    if (found.item.type !== 'folder') return effectiveAuth(c, found.parents, found.item)
    return effectiveAuth(c, [...found.parents, found.item], null)
  }

  // -------------------------------------------------------------------------------------------
  // WebSocket and gRPC
  // -------------------------------------------------------------------------------------------

  /**
   * The request, its effective auth and a context factory. Variables are re-read for every handshake
   * and message (current values may change while a connection is open); the Key Vault context is the
   * collection's team, exactly as for `requests.send`. No scripts run for these requests.
   */
  private async realtime<K extends 'websocket' | 'grpc'>(
    input: RealtimeTarget<WebSocketRequestDef | GrpcRequestDef>,
    kind: K
  ): Promise<{ request: K extends 'websocket' ? WebSocketRequestDef : GrpcRequestDef; auth: Auth; context: () => Promise<GrpcContext>; teamId: Id | null }> {
    const scope = await this.resolveScope(input)
    if (scope.request?.type !== kind) throw new Fault('INVALID_ARGUMENT', `This is not a ${kind === 'websocket' ? 'WebSocket' : 'gRPC'} request.`)
    const collectionId = scope.collection?.id ?? null
    const environmentId = input?.environmentId
    const teamId = scope.teamId
    const context = async (): Promise<GrpcContext> => {
      const fresh = await this.resolveScope({ collectionId, environmentId }, false)
      return { layers: variableLayers(fresh.vars), deps: await this.deps(teamId) }
    }
    return { request: scope.request as never, auth: effectiveAuth(scope.collection, scope.folders, scope.request).auth, context, teamId }
  }

  async wsConnect(input: RealtimeTarget<WebSocketRequestDef> & { connectionId: string }, owner: number | null = null): Promise<WsConnectResult> {
    assertId(input?.connectionId, 'connection id')
    const { request, auth, context } = await this.realtime(input, 'websocket')
    return this.websockets.connect({
      id: input.connectionId,
      owner,
      request,
      auth,
      context,
      emit: (e) => this.emit('ws:event', e),
      cookiesChanged: () => {
        void this.store.saveCookies().then(() => this.emit('cookies:changed', {}))
      },
      defaults: { verifyTls: this.settings.http.verifyTls }
    })
  }

  async wsSend(input: { connectionId: string; message: WsMessage }): Promise<RealtimeLogEntry> {
    assertId(input?.connectionId, 'connection id')
    return this.websockets.get(input.connectionId).send(input.message)
  }

  wsPing(connectionId: string): void {
    assertId(connectionId, 'connection id')
    this.websockets.get(connectionId).ping()
  }

  wsDisconnect(input: { connectionId: string; code?: number; reason?: string }): boolean {
    assertId(input?.connectionId, 'connection id')
    return this.websockets.disconnect(input.connectionId, typeof input.code === 'number' ? input.code : undefined, typeof input.reason === 'string' ? input.reason : undefined)
  }

  /**
   * Reads the CA / client certificate / key chosen for this request. `grpc-tls.json` is written only
   * from main's file dialog, so it is its own allowlist; it is deliberately separate from the body-file
   * allowlist (a picked client key must never become sendable as an HTTP request body).
   */
  private async grpcTlsMaterial(requestId: Id): Promise<GrpcTlsMaterial> {
    const files = (await this.grpcTls.read())[requestId] ?? {}
    const out: GrpcTlsMaterial = {}
    for (const kind of ['ca', 'cert', 'key'] as const) {
      const f = files[kind]
      if (!f) continue
      const st = await stat(f.path).catch(() => null)
      if (!st?.isFile()) throw new Fault('NOT_FOUND', `The TLS file "${f.name}" is gone. Choose it again in the Settings tab.`)
      if (st.size > 1024 * 1024) throw new Fault('INVALID_ARGUMENT', `The TLS file "${f.name}" is too large for a PEM file.`)
      out[kind] = await readFile(f.path)
    }
    return out
  }

  async grpcReflect(input: RealtimeTarget<GrpcRequestDef>): Promise<GrpcDescriptor> {
    const { request, auth, context } = await this.realtime(input, 'grpc')
    return reflectDescriptor({
      request,
      auth,
      context: await context(),
      defaults: { verifyTls: this.settings.http.verifyTls },
      tls: await this.grpcTlsMaterial(request.id),
      timeoutMs: request.settings.deadlineMs ?? (this.settings.http.timeoutMs || 30_000)
    })
  }

  /** Called by main's dialogs: .proto files / import directories the user picked in this session. */
  allowProtoPath(path: string): void {
    this.protoPicks.add(path)
  }

  async grpcLoadProtos(input: { files: string[]; importDirs: string[] }): Promise<GrpcDescriptor> {
    const files = Array.isArray(input?.files) ? input.files.filter((f): f is string => typeof f === 'string') : []
    const dirs = Array.isArray(input?.importDirs) ? input.importDirs.filter((f): f is string => typeof f === 'string') : []
    for (const p of [...files, ...dirs]) if (!this.protoPicks.has(p)) throw new Fault('FORBIDDEN', `Choose "${basename(p)}" with the file dialog first.`)
    return parseProtoFiles({ files, importDirs: dirs })
  }

  grpcDescribe(input: { descriptor: GrpcDescriptor }): GrpcServiceInfo[] {
    return listServices(loadDescriptor(input?.descriptor))
  }

  grpcExample(input: { descriptor: GrpcDescriptor; service: string; method: string }): string {
    const m = findMethod(loadDescriptor(input?.descriptor), String(input?.service ?? ''), String(input?.method ?? ''))
    return JSON.stringify(exampleMessage(m.requestType), null, 2)
  }

  async grpcInvoke(input: RealtimeTarget<GrpcRequestDef> & { callId: string }, owner: number | null = null): Promise<{ callType: GrpcCallType }> {
    assertId(input?.callId, 'call id')
    const { request, auth, context } = await this.realtime(input, 'grpc')
    return this.grpcCalls.start({
      id: input.callId,
      owner,
      request,
      auth,
      context,
      emit: (e) => this.emit('grpc:event', e),
      defaults: { verifyTls: this.settings.http.verifyTls },
      tls: await this.grpcTlsMaterial(request.id)
    })
  }

  async grpcSend(input: { callId: string; message: string }): Promise<RealtimeLogEntry> {
    assertId(input?.callId, 'call id')
    return this.grpcCalls.get(input.callId).send(typeof input.message === 'string' ? input.message : '')
  }

  grpcEnd(callId: string): boolean {
    assertId(callId, 'call id')
    return this.grpcCalls.get(callId).end()
  }

  grpcCancel(callId: string): boolean {
    assertId(callId, 'call id')
    return this.grpcCalls.cancel(callId)
  }

  async grpcTlsFiles(requestId: Id): Promise<GrpcTlsFiles> {
    assertId(requestId, 'request id')
    return (await this.grpcTls.read())[requestId] ?? {}
  }

  /** Stores a file picked in main's dialog as the request's CA / certificate / key on this machine (only ipc.ts calls this with a path). */
  async setGrpcTlsFile(requestId: Id, kind: GrpcTlsKind, path: string | null): Promise<GrpcTlsFiles> {
    assertId(requestId, 'request id')
    if (kind !== 'ca' && kind !== 'cert' && kind !== 'key') throw new Fault('INVALID_ARGUMENT', 'Unknown TLS file kind.')
    const all = await this.grpcTls.update((cur) => {
      const next = { ...cur, [requestId]: { ...(cur[requestId] ?? {}) } }
      if (path === null) delete next[requestId][kind]
      else next[requestId][kind] = { path, name: basename(path) }
      if (!Object.keys(next[requestId]).length) delete next[requestId]
      return next
    })
    return all[requestId] ?? {}
  }

  /** Closes WebSocket connections and gRPC calls (of one window, or all). */
  closeRealtime(owner?: number): void {
    this.websockets.closeAll(owner)
    this.grpcCalls.closeAll(owner)
  }

  // -------------------------------------------------------------------------------------------
  // OAuth 2.0 authorization code
  // -------------------------------------------------------------------------------------------

  /**
   * Resolves an authorization-code config like a send would: `{{variables}}` from the collection and
   * environment, then Key Vault references in the collection's context. The client secret is only
   * resolved when a token is requested (`withSecret`).
   */
  private async oauthConfig(input: OAuthTokenInput, withSecret: boolean): Promise<OAuthCodeConfig> {
    const auth = normalizeAuth(input?.auth, { type: 'none' })
    if (!isAuthCode(auth)) throw new Fault('INVALID_ARGUMENT', 'This is not an OAuth 2.0 authorization code configuration.')
    if (input.collectionId != null) assertId(input.collectionId, 'collection id')
    const scope = await this.resolveScope({ collectionId: input.collectionId ?? null, environmentId: input.environmentId }, false)
    const layers = { ...scope.vars }
    let a = mapAuthStrings(auth, (s) => resolveTemplate(s, layers)) as typeof auth
    const resolver = this.vault.resolver(scope.teamId)
    const values = new Map<string, string>()
    const secret = a.clientSecret
    for (const field of [a.authUrl ?? '', a.accessTokenUrl, a.clientId, a.scope, a.audience, a.redirectUri ?? '', a.extraParams ?? '', ...(withSecret ? [secret] : [])])
      for (const ref of findVaultRefs(field)) if (!values.has(ref)) values.set(ref, await resolver.resolve(ref))
    a = mapAuthStrings(a, (s) => replaceVaultRefs(s, (ref) => values.get(ref) ?? `{{vault:${ref}}}`)) as typeof auth
    if (!withSecret) a = { ...a, clientSecret: secret }
    return codeConfig(a, scope.teamId ? `team:${scope.teamId}` : 'personal')
  }

  private async oauthView(cfg: OAuthCodeConfig): Promise<OAuthTokenStatus> {
    let hosts = { authHost: '', tokenHost: '' }
    let needsApproval = false
    try {
      hosts = oauthHosts(cfg)
      needsApproval = await this.oauth.needsApproval(cfg)
    } catch {
      /* incomplete config: no hosts yet */
    }
    return { ...(await this.oauth.status(cfg)), ...hosts, storage: this.oauth.storage, needsApproval }
  }

  async oauthStatus(input: OAuthTokenInput): Promise<OAuthTokenStatus> {
    return this.oauthView(await this.oauthConfig(input, false))
  }

  async oauthGetNewToken(input: OAuthTokenInput & { approveHosts?: { authHost: string; tokenHost: string } }): Promise<OAuthAcquireResult> {
    const cfg = await this.oauthConfig(input, true)
    const seen = input.approveHosts
    if (seen && typeof seen.authHost === 'string' && typeof seen.tokenHost === 'string') await this.oauth.approve(cfg, seen)
    if (await this.oauth.needsApproval(cfg)) return { status: 'approval-required', ...oauthHosts(cfg) }
    await this.oauth.authorize(cfg)
    return { status: 'ok', token: await this.oauthView(cfg) }
  }

  async oauthClearToken(input: OAuthTokenInput): Promise<void> {
    await this.oauth.clear(await this.oauthConfig(input, false))
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
    const skipped = skippedInScope(collection, input.folderId ? [input.folderId] : [])
    if (!plan.length) throw new Fault('INVALID_ARGUMENT', `There are no HTTP requests to run.${skipped.length ? ` ${skippedNote(skipped, 'run by the collection runner')}` : ''}`)
    const data = Array.isArray(input.data) ? input.data.filter((r) => typeof r === 'object' && r !== null).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)]))) : undefined
    const runId = newId()
    const ac = new AbortController()
    this.runs.set(runId, ac)
    const deps: ExecutorDeps = { ...(await this.deps(scope.teamId)), scriptVault: await this.scriptVaultGate(collection) }
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
        ...(input.maxJumps !== undefined ? { maxJumps: Math.min(1_000_000, Math.max(1, Math.floor(Number(input.maxJumps) || 1))) } : {}),
        signal: ac.signal,
        skipped,
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
        this.emit('cookies:changed', {})
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
  // sync (per team; one team failing never blocks the others)
  // -------------------------------------------------------------------------------------------

  async syncStatus(): Promise<SyncOverview> {
    const teams: TeamSyncStatus[] = []
    for (const t of this.teams.list()) {
      const c = this.teamCache(t.id)
      const all = [...(await c.list('collection')), ...(await c.list('environment'))]
      const tombs = await c.tombstones()
      const err = this.teamErrors.get(t.id)
      const at = this.teamSyncedAt.get(t.id)
      teams.push({
        teamId: t.id,
        name: TeamStore.displayName(t),
        accountUrl: t.accountUrl,
        container: t.container,
        pending: all.filter((e) => e.sync.dirty).length + tombs.length,
        pendingDeletes: tombs.map((x) => ({ kind: x.kind, id: x.id, name: x.name, teamId: t.id })),
        conflicts: all.filter((e) => e.sync.conflict).map((e) => this.ref(e.kind, e.doc, t.id)),
        ...(err ? { lastError: err } : {}),
        ...(at ? { lastSyncedAt: at } : {})
      })
    }
    return {
      configured: teams.length > 0,
      signedIn: this.identity.status().signedIn,
      running: this.syncRunning !== null,
      teams,
      pending: teams.reduce((n, t) => n + t.pending, 0),
      pendingDeletes: teams.flatMap((t) => t.pendingDeletes),
      conflicts: teams.flatMap((t) => t.conflicts),
      lastReport: this.lastReport
    }
  }

  /** Syncs every joined team (or one). Concurrent callers share the running sync. */
  async runSync(input?: { teamId?: Id; acknowledgeWarnings?: boolean }): Promise<SyncReport> {
    if (this.syncRunning) return this.syncRunning
    if (input?.teamId !== undefined) this.teams.require(input.teamId)
    if (!this.teams.list().length) throw new Fault('NOT_CONFIGURED', 'Join or create a team in Settings → Teams to sync.')
    if (!this.syncIdentity()) throw new Fault('NOT_SIGNED_IN', 'Sign in with your Azure identity to sync.')
    const p = this.doSync(input?.teamId, input?.acknowledgeWarnings === true)
    this.syncRunning = p
    p.catch(() => undefined) // awaited below; avoid an unhandled rejection while we emit state
    this.emit('sync:state', await this.syncStatus())
    try {
      const report = await p
      this.lastReport = report
      this.emit('workspace:changed', { reason: 'sync', refs: [...report.downloaded, ...report.removedLocally, ...report.conflicts, ...report.uploaded] })
      return report
    } finally {
      this.syncRunning = null
      // Even after a partial sync. (Send/run time re-checks the hash anyway; this keeps the UI honest.)
      await this.reconcileTrust().catch(() => undefined)
      this.emit('sync:state', await this.syncStatus())
    }
  }

  private async doSync(only: Id | undefined, acknowledgeWarnings: boolean): Promise<SyncReport> {
    const report = emptyReport()
    const teams = this.teams.list().filter((t) => only === undefined || t.id === only)
    const ok: Id[] = []
    for (const t of teams) {
      const engine = this.engine(t.id)
      try {
        await this.syncManifest(t, report)
        await engine.run({ acknowledgeWarnings }, report)
        ok.push(t.id)
        this.teamErrors.delete(t.id)
        this.teamSyncedAt.set(t.id, new Date().toISOString())
        report.teams.push({ teamId: t.id, name: this.teamName(t.id), ok: true })
      } catch (err) {
        const f = engine.fault(err)
        const error = { code: f.code, message: f.message }
        this.teamErrors.set(t.id, error)
        report.errors.push({ teamId: t.id, ...error })
        report.teams.push({ teamId: t.id, name: this.teamName(t.id), ok: false, error })
      }
    }
    // Old blobs of items moved between teams go only after the new team has them.
    for (const id of ok) await this.engine(id).applyMovedDeletes(report)
    report.finishedAt = new Date().toISOString()
    return report
  }

  /** Re-reads the team manifest during a sync. A broken manifest is a notice, not a failed sync. */
  private async syncManifest(t: StoredTeam, report: SyncReport): Promise<void> {
    let read: ManifestRead | null
    try {
      read = await readManifest(this.containerClient(t.id), t, this.anyVaultHost)
    } catch (err) {
      if (err instanceof Fault && err.code === 'INVALID_ARGUMENT') {
        report.notices.push({ teamId: t.id, message: `The team settings (courier-team.json) could not be read: ${err.message} The last known settings are kept.` })
        return
      }
      throw err
    }
    for (const message of await this.applyManifest(t.id, read)) report.notices.push({ teamId: t.id, message })
  }

  /** Stores a manifest read; returns notices about vault hosts that now need approval. */
  private async applyManifest(teamId: Id, read: ManifestRead | null): Promise<string[]> {
    const before = this.teams.require(teamId)
    const known = new Set((before.manifest?.vaults ?? []).map((v) => v.url))
    const now = new Date().toISOString()
    const after = await this.teams.update(teamId, (t) => {
      t.manifest = read ? { etag: read.etag, readAt: now, name: read.manifest.name, vaults: read.manifest.vaults, rejected: read.rejected } : null
      if (read) t.name = read.manifest.name
    })
    if (before.manifest?.etag !== after.manifest?.etag || before.name !== after.name) {
      this.vault.clearCache()
      this.emit('workspace:changed', { reason: 'team', refs: [] })
    }
    const name = TeamStore.displayName(after)
    const notices: string[] = []
    for (const v of after.manifest?.vaults ?? [])
      if (!known.has(v.url) && !this.teams.isApproved(teamId, v.url))
        notices.push(`Team "${name}" lists Key Vault "${v.alias}" on host ${new URL(v.url).host}. Review and approve it in Settings → Teams before this team's requests can use it.`)
    for (const r of after.manifest?.rejected ?? []) if (!(before.manifest?.rejected ?? []).some((x) => x.alias === r.alias && x.url === r.url)) notices.push(`Team "${name}" lists Key Vault "${r.alias}" with an unusable URL (${r.reason}); it is ignored.`)
    return notices
  }

  /** The team (and engine) that holds an item, for conflict / discard operations. */
  private async teamOf(kind: ItemKind, id: Id): Promise<Id> {
    const f = await this.find(kind, id)
    if (f) {
      if (f.cache.teamId === null) throw new Fault('INVALID_ARGUMENT', 'Personal items are stored on this machine only and have no cloud version.')
      return f.cache.teamId
    }
    for (const t of this.teams.list()) if (await this.engine(t.id).hasTombstone(kind, id)) return t.id
    throw new Fault('NOT_FOUND', 'Nothing to discard for this item.')
  }

  async discardLocalChanges(input: { kind: ItemKind; id: Id }): Promise<SyncReport> {
    assertKind(input?.kind)
    assertId(input.id)
    const teamId = await this.teamOf(input.kind, input.id)
    await this.engine(teamId).discardLocal(input.kind, input.id)
    this.emit('workspace:changed', { reason: 'sync', refs: [] })
    return this.runSync({ teamId })
  }

  async getConflict(input: { kind: ItemKind; id: Id }): Promise<ConflictDetail> {
    assertKind(input?.kind)
    assertId(input.id)
    const e = await this.getEntry(input.kind, input.id)
    if (!e.sync.teamId) throw new Fault('NOT_FOUND', 'This item has no open conflict.')
    return this.engine(e.sync.teamId).getConflict(input.kind, input.id)
  }

  async resolveConflict(input: { kind: ItemKind; id: Id; resolution: ConflictResolution; acknowledgeWarnings?: boolean }): Promise<ResolveConflictResult> {
    assertKind(input?.kind)
    assertId(input.id)
    if (!['mine', 'theirs', 'both'].includes(input.resolution)) throw new Fault('INVALID_ARGUMENT', 'Resolution must be mine, theirs or both.')
    const e = await this.getEntry(input.kind, input.id)
    if (!e.sync.teamId) throw new Fault('NOT_FOUND', 'This item has no open conflict.')
    const teamId = e.sync.teamId
    const copy = await this.engine(teamId).resolveLocally(input.kind, input.id, input.resolution)
    await this.reconcileTrust()
    const report = await this.runSync({ teamId, acknowledgeWarnings: input.acknowledgeWarnings === true })
    this.emit('workspace:changed', { reason: 'conflict', refs: [] })
    return { ...(copy ? { copy } : {}), report }
  }

  async scan(input: { kind: ItemKind; id: Id }): Promise<SecretFinding[]> {
    assertKind(input?.kind)
    const e = await this.getEntry(input.kind, input.id)
    return scanDoc(input.kind, e.doc)
  }

  // -------------------------------------------------------------------------------------------
  // teams
  // -------------------------------------------------------------------------------------------

  listTeams(): Team[] {
    return this.teams.list().map((t) => this.teams.toTeam(t))
  }

  private location(input: { accountUrl: unknown; container: unknown }): { accountUrl: string; container: string } {
    return { accountUrl: normalizeAccountUrl(input?.accountUrl), container: normalizeContainer(input?.container) }
  }

  /** A container client for a location that is not (yet) a joined team. */
  private probeClient(loc: { accountUrl: string; container: string }): ContainerClient {
    if (!this.syncIdentity()) throw new Fault('NOT_SIGNED_IN', 'Sign in with your Azure identity first.')
    return createContainerClient(loc.accountUrl, loc.container, this.identity.credential())
  }

  async probeTeam(input: { accountUrl: string; container: string }): Promise<TeamProbe> {
    const loc = this.location(input)
    const read = await readManifest(this.probeClient(loc), loc, this.anyVaultHost)
    const joined = this.teams.findByLocation(loc)
    return { ...loc, manifest: read?.manifest ?? null, rejectedVaults: read?.rejected ?? [], ...(joined ? { joinedTeamId: joined.id } : {}) }
  }

  private async addTeam(t: StoredTeam): Promise<Team> {
    await this.teams.add(t)
    await this.teamCache(t.id).init()
    this.emit('workspace:changed', { reason: 'team', refs: [] })
    this.emit('sync:state', await this.syncStatus())
    return this.teams.toTeam(t)
  }

  async joinTeam(input: { accountUrl: string; container: string; name?: string }): Promise<Team> {
    const loc = this.location(input)
    const existing = this.teams.findByLocation(loc)
    if (existing) return this.teams.toTeam(existing)
    const read = await readManifest(this.probeClient(loc), loc, this.anyVaultHost)
    const given = typeof input?.name === 'string' ? input.name.trim().slice(0, 100) : ''
    if (!read && !given) throw new Fault('NOT_FOUND', `Container "${loc.container}" has no team manifest (courier-team.json) yet. Create the team, or enter a name to join it read-only.`)
    const now = new Date().toISOString()
    return this.addTeam({
      id: newId(),
      name: read?.manifest.name ?? given,
      ...loc,
      joinedAt: now,
      manifest: read ? { etag: read.etag, readAt: now, name: read.manifest.name, vaults: read.manifest.vaults, rejected: read.rejected } : null
    })
  }

  async createTeam(input: { accountUrl: string; container: string; name: string; vaults?: VaultConfig[] }): Promise<Team> {
    const loc = this.location(input)
    const name = typeof input?.name === 'string' ? input.name.trim().replace(/\s+/g, ' ').slice(0, 100) : ''
    if (!name) throw new Fault('INVALID_ARGUMENT', 'A team needs a name.')
    const vaults = validateOwnVaults(input?.vaults, this.anyVaultHost)
    if (this.teams.findByLocation(loc)) throw new Fault('CONFLICT', 'You have already joined the team in this container.')
    const etag = await writeManifest(this.probeClient(loc), loc, { name, vaults }, { ifNoneMatch: '*' })
    const id = newId()
    // Vaults you typed in yourself count as approved on this machine.
    await this.teams.approve(id, vaults.map((v) => ({ url: v.url, host: new URL(v.url).host })))
    const now = new Date().toISOString()
    return this.addTeam({ id, name, ...loc, joinedAt: now, manifest: { etag, readAt: now, name, vaults, rejected: [] } })
  }

  async refreshTeam(id: Id): Promise<Team> {
    const t = this.teams.require(id)
    await this.applyManifest(id, await readManifest(this.containerClient(id), t, this.anyVaultHost))
    this.emit('sync:state', await this.syncStatus())
    return this.teams.toTeam(this.teams.require(id))
  }

  async updateTeam(input: { id: Id; name?: string; vaults?: VaultConfig[]; etag?: string }): Promise<Team> {
    const t = this.teams.require(input?.id)
    const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ').slice(0, 100) : undefined
    if (name === '') throw new Fault('INVALID_ARGUMENT', 'A team needs a name.')
    if (!t.manifest && input.vaults === undefined) {
      // No team settings in the container (read-only join, or a team from the old storage setting): local name only.
      const after = await this.teams.update(t.id, (x) => {
        if (name) x.name = name
      })
      this.emit('workspace:changed', { reason: 'team', refs: [] })
      return this.teams.toTeam(after)
    }
    const vaults = input.vaults !== undefined ? validateOwnVaults(input.vaults, this.anyVaultHost) : (t.manifest?.vaults ?? [])
    const next = { name: name ?? t.manifest?.name ?? t.name, vaults }
    let etag: string
    try {
      // With vaults and no manifest yet: create the team settings (If-None-Match: *); otherwise edit them (If-Match).
      const condition = t.manifest ? { ifMatch: typeof input.etag === 'string' && input.etag ? input.etag : t.manifest.etag } : { ifNoneMatch: '*' as const }
      etag = await writeManifest(this.containerClient(t.id), t, next, condition)
    } catch (err) {
      // Someone else changed (or created) it: load their version so the UI can show it, then report the conflict.
      if (err instanceof Fault && err.code === 'CONFLICT') await this.refreshTeam(t.id).catch(() => undefined)
      throw err
    }
    // Only vault URLs this user added in this edit count as approved; entries that were already
    // listed (by a teammate) keep their approval state.
    const before = new Set((t.manifest?.vaults ?? []).map((v) => v.url))
    await this.teams.approve(t.id, vaults.filter((v) => !before.has(v.url)).map((v) => ({ url: v.url, host: new URL(v.url).host })))
    const now = new Date().toISOString()
    const after = await this.teams.update(t.id, (x) => {
      x.name = next.name
      x.manifest = { etag, readAt: now, name: next.name, vaults, rejected: [] }
    })
    this.vault.clearCache()
    this.emit('workspace:changed', { reason: 'team', refs: [] })
    this.emit('sync:state', await this.syncStatus())
    return this.teams.toTeam(after)
  }

  async approveTeamVault(input: { id: Id; url: string }): Promise<Team> {
    const t = this.teams.require(input?.id)
    const v = t.manifest?.vaults.find((x) => x.url === input.url)
    if (!v) throw new Fault('NOT_FOUND', 'That vault is not listed by this team (any more).')
    await this.teams.approve(t.id, [{ url: v.url, host: new URL(v.url).host }])
    this.emit('workspace:changed', { reason: 'team', refs: [] })
    return this.teams.toTeam(this.teams.require(t.id))
  }

  /** Leaves a team: drops its local cache (never its blobs), approvals and this machine's values for its items. */
  async leaveTeam(input: { id: Id; discardUnsynced?: boolean }): Promise<LeaveTeamResult> {
    const t = this.teams.require(input?.id)
    if (this.syncRunning) throw new Fault('BUSY', 'A sync is running. Try again when it has finished.')
    return this.mutex.run(async () => {
      const c = this.teamCache(t.id)
      const entries = [...(await c.list('collection')), ...(await c.list('environment'))]
      const unsynced: ItemRef[] = [
        ...entries.filter((e) => e.sync.dirty || e.sync.conflict).map((e) => this.ref(e.kind, e.doc, t.id)),
        ...(await c.tombstones()).map((x) => ({ kind: x.kind, id: x.id, name: x.name, teamId: t.id }))
      ]
      if (unsynced.length && input.discardUnsynced !== true) return { left: false, unsynced }
      // Items moved from another team into this one before they were uploaded here: keep their old
      // blobs (the other team downloads them again) instead of deleting them on the next sync.
      for (const other of this.teams.list()) {
        if (other.id === t.id) continue
        const oc = this.teamCache(other.id)
        for (const tomb of await oc.tombstones()) if (tomb.movedToTeam === t.id) await oc.removeTombstone(tomb)
      }
      await this.teams.remove(t.id)
      await c.destroy()
      this.teamCaches.delete(t.id)
      this.engines.delete(t.id)
      this.containers.delete(t.id)
      this.teamErrors.delete(t.id)
      this.teamSyncedAt.delete(t.id)
      this.vault.clearCache()
      await this.store.updateVariables((v) => {
        for (const e of entries) {
          if (e.kind === 'collection') delete v.currentValues.collections[e.doc.id]
          else {
            delete v.currentValues.environments[e.doc.id]
            if (v.activeEnvironmentId === e.doc.id) v.activeEnvironmentId = null
          }
        }
      })
      return { left: true, unsynced }
    }).then(async (r) => {
      if (r.left) {
        await this.reconcileTrust()
        this.emit('workspace:changed', { reason: 'team', refs: [] })
        this.emit('variables:changed', { reason: 'edit' })
        this.emit('sync:state', await this.syncStatus())
      }
      return r
    })
  }

  testTeamConnection(id: Id): Promise<ConnectionTestResult> {
    this.teams.require(id)
    return this.engine(id).testConnection()
  }

  // -------------------------------------------------------------------------------------------
  // vault
  // -------------------------------------------------------------------------------------------

  /**
   * Vaults for a context, in resolution order: the team manifest's vaults (team items only), then
   * the user's own vaults from settings. Unapproved and rejected team vaults are listed with the
   * error that using them raises, so an alias never silently falls through to another vault.
   */
  private vaultCandidates(teamId: Id | null): VaultCandidate[] {
    const t = teamId ? this.teams.get(teamId) : undefined
    return teamVaultCandidates({
      team: { id: t?.id ?? '', name: t ? TeamStore.displayName(t) : '' },
      manifest: t?.manifest ?? null,
      own: this.settings.keyVault.vaults,
      isApproved: (url) => (t ? this.teams.isApproved(t.id, url) : false),
      approveHint: () => 'Review the host in Settings → Teams and approve it if you trust it.'
    })
  }

  private vaultContext(teamId: unknown): Id | null {
    if (teamId === null || teamId === undefined) return null
    assertId(teamId, 'team id')
    this.teams.require(teamId)
    return teamId
  }

  vaultList(input?: { alias?: string; teamId?: Id | null }): Promise<SecretSummary[]> {
    return this.vault.list(input?.alias, this.vaultContext(input?.teamId))
  }
  vaultGet(input: { alias?: string; teamId?: Id | null; name: string; version?: string }): Promise<SecretValue> {
    if (typeof input?.name !== 'string') throw new Fault('INVALID_ARGUMENT', 'Secret name is required.')
    return this.vault.get({ ...input, teamId: this.vaultContext(input.teamId) })
  }
  vaultSet(input: { alias?: string; teamId?: Id | null; name: string; value: string; contentType?: string }): Promise<SecretSummary> {
    if (typeof input?.name !== 'string' || typeof input.value !== 'string') throw new Fault('INVALID_ARGUMENT', 'Secret name and value are required.')
    return this.vault.set({ ...input, teamId: this.vaultContext(input.teamId) })
  }

  // -------------------------------------------------------------------------------------------
  // import / export
  // -------------------------------------------------------------------------------------------

  async importText(text: string, teamId: Id | null = null): Promise<ImportResult> {
    if (typeof text !== 'string' || !text.trim()) throw new Fault('INVALID_ARGUMENT', 'Nothing to import.')
    const t = this.target(teamId)
    const put = (kind: ItemKind, doc: Doc): Promise<CacheEntry> => this.mutex.run(() => t.cache.put(kind, doc, t.sync))
    const imported = (kind: ItemKind, doc: Doc): void => this.emit('workspace:changed', { reason: 'import', refs: [this.ref(kind, doc, t.teamId)] })
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
        const e = await put('collection', value)
        imported('collection', value)
        return { kind: 'collection', entry: this.toCollectionEntry(e), warnings }
      }
      if (json !== undefined && isPostmanEnvironment(json)) {
        const { value, warnings } = importPostmanEnvironment(json)
        await this.extractSecrets('environment', value)
        const e = await put('environment', value)
        imported('environment', value)
        return { kind: 'environment', entry: this.toEnvironmentEntry(e), warnings }
      }
      if (json !== undefined && typeof json === 'object' && json !== null && (json as { schema?: unknown }).schema === 'courier.collection/v1') {
        const value = normalizeCollection({ ...(json as object), id: newId() })
        const e = await put('collection', value)
        imported('collection', value)
        return { kind: 'collection', entry: this.toCollectionEntry(e), warnings: [] }
      }
      if (json !== undefined && typeof json === 'object' && json !== null && (json as { schema?: unknown }).schema === 'courier.environment/v1') {
        const value = normalizeEnvironment({ ...(json as object), id: newId() })
        const e = await put('environment', value)
        imported('environment', value)
        return { kind: 'environment', entry: this.toEnvironmentEntry(e), warnings: [] }
      }
      if (parseOpenApiText(text)) {
        const { value, warnings } = importOpenApi(text)
        const e = await put('collection', value)
        imported('collection', value)
        return { kind: 'collection', entry: this.toCollectionEntry(e), warnings }
      }
    } catch (err) {
      if (err instanceof Fault) throw err
      throw new Fault('IMPORT_FAILED', err instanceof Error ? err.message : String(err))
    }
    throw new Fault('IMPORT_FAILED', 'Unrecognised format. Supported: Postman collection/environment (v2.0/v2.1), OpenAPI 3 (JSON/YAML), Courier JSON, cURL.')
  }

  async exportDoc(kind: ItemKind, id: Id, format: ExportFormat): Promise<{ fileName: string; content: string; skipped: SkippedItem[] }> {
    if (format !== 'postman' && format !== 'courier') throw new Fault('INVALID_ARGUMENT', 'Unknown export format.')
    const e = await this.getEntry(kind, id)
    const base = slugify(e.doc.name)
    if (kind === 'collection') {
      const c = e.doc as Collection
      // Postman v2.1 cannot hold WebSocket / gRPC requests: they are left out and listed.
      return format === 'postman'
        ? { fileName: `${base}.postman_collection.json`, content: JSON.stringify(exportPostmanCollection(c), null, 2) + '\n', skipped: collectionNonHttp(c) }
        : { fileName: `${base}.courier.json`, content: serializeCollection(c), skipped: [] }
    }
    const env = e.doc as Environment
    return format === 'postman'
      ? { fileName: `${base}.postman_environment.json`, content: JSON.stringify(exportPostmanEnvironment(env), null, 2) + '\n', skipped: [] }
      : { fileName: `${base}.courier-env.json`, content: serializeEnvironment(env), skipped: [] }
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
