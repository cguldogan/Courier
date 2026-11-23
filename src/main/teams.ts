/**
 * Teams joined on this machine, their cached manifests, and approvals for team Key Vault hosts.
 *
 *   userData/teams.json                 { teams: StoredTeam[] }
 *   userData/team-vault-approvals.json  { approvals: { "<teamId>": { "<vault url>": { approvedAt, host } } } }
 *
 * A team is one storage location: `accountUrl` + `container`. Its `courier-team.json` manifest
 * (`{ version, name, vaults }`) is written by teammates, so everything in it is untrusted input:
 *  - vault URLs must be https origins (no credentials, path, query or fragment) and, outside the
 *    Key Vault test hook, on an Azure Key Vault DNS suffix; other entries are rejected and listed;
 *  - a team vault is only used after the user approved its host on this machine, keyed by team id
 *    + canonical vault URL — so a teammate who points an alias at a new host needs a new approval.
 * Nothing here is ever uploaded except the manifest itself (by `teams.create` / `teams.update`).
 */
import { join } from 'node:path'
import type { Id, Team, TeamManifest, TeamVault, VaultConfig } from '../shared/types'
import { isValidId } from '../shared/serialize'
import { Fault } from './errors'
import { JsonFile } from './store'

/** DNS suffixes of Azure Key Vault (public cloud, China, US Gov, Germany). */
export const KEY_VAULT_SUFFIXES = ['.vault.azure.net', '.vault.azure.cn', '.vault.usgovcloudapi.net', '.vault.microsoftazure.de']

const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const MAX_VAULTS = 50
const MAX_NAME = 100

export interface RejectedVault {
  alias: string
  url: string
  reason: string
}

export interface StoredManifest {
  etag: string
  readAt: string
  name: string
  vaults: VaultConfig[]
  rejected: RejectedVault[]
}

export interface StoredTeam {
  id: Id
  /** Name given when joining; the manifest name wins while there is a manifest. */
  name: string
  accountUrl: string
  container: string
  joinedAt: string
  manifest: StoredManifest | null
}

interface TeamsFile {
  teams: StoredTeam[]
}

interface Approval {
  approvedAt: string
  host: string
}
interface ApprovalsFile {
  approvals: Record<Id, Record<string, Approval>>
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** `https://account.blob.core.windows.net` (no trailing slash). Throws INVALID_ARGUMENT. */
export function normalizeAccountUrl(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : ''
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw new Fault('INVALID_ARGUMENT', 'Enter the storage account URL, e.g. https://myaccount.blob.core.windows.net.')
  }
  if (u.protocol !== 'https:') throw new Fault('INVALID_ARGUMENT', 'The storage account URL must start with https://.')
  if (u.username || u.password || u.search || u.hash) throw new Fault('INVALID_ARGUMENT', 'The storage account URL must not contain credentials, a query or a fragment.')
  return s
}

/** Azure container naming rules: 3–63 chars, lowercase letters, digits and single dashes. */
export function normalizeContainer(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/.test(s)) throw new Fault('INVALID_ARGUMENT', 'Container names are 3–63 lowercase letters, digits or single dashes.')
  return s
}

export function sameLocation(a: { accountUrl: string; container: string }, b: { accountUrl: string; container: string }): boolean {
  return a.accountUrl.toLowerCase() === b.accountUrl.toLowerCase() && a.container === b.container
}

/**
 * Canonical team vault URL (its origin) and the host to show, or the reason it is refused.
 * `anyHost` is only set by the Key Vault test hook (mock vault on 127.0.0.1).
 */
export function checkTeamVaultUrl(raw: unknown, anyHost: boolean): { url: string; host: string } | { reason: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { reason: 'no URL' }
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return { reason: 'not a valid URL' }
  }
  if (u.protocol !== 'https:') return { reason: 'not https' }
  if (u.username || u.password) return { reason: 'contains credentials' }
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return { reason: 'must be just https://<vault-name>.vault.azure.net' }
  const host = u.hostname.toLowerCase()
  if (!anyHost && !KEY_VAULT_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length)) return { reason: `host ${u.host} is not an Azure Key Vault host (${KEY_VAULT_SUFFIXES.map((s) => `*${s}`).join(', ')})` }
  return { url: u.origin, host: u.host }
}

function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : ''
  if (!name) throw new Fault('INVALID_ARGUMENT', 'A team needs a name.')
  return name.slice(0, MAX_NAME)
}

/** Validate vaults supplied by this user (create/update): any problem is an error, nothing is dropped silently. */
export function validateOwnVaults(raw: unknown, anyHost: boolean): VaultConfig[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Fault('INVALID_ARGUMENT', 'vaults must be a list.')
  if (raw.length > MAX_VAULTS) throw new Fault('INVALID_ARGUMENT', `A team can list at most ${MAX_VAULTS} vaults.`)
  const out: VaultConfig[] = []
  for (const v of raw) {
    const alias = isObj(v) && typeof v.alias === 'string' ? v.alias.trim() : ''
    if (!ALIAS_RE.test(alias)) throw new Fault('INVALID_ARGUMENT', `Invalid vault alias "${alias.slice(0, 64)}" (letters, digits, ".", "_" and "-").`)
    if (out.some((x) => x.alias.toLowerCase() === alias.toLowerCase())) throw new Fault('INVALID_ARGUMENT', `Duplicate vault alias "${alias}".`)
    const checked = checkTeamVaultUrl(isObj(v) ? v.url : undefined, anyHost)
    if ('reason' in checked) throw new Fault('INVALID_ARGUMENT', `Vault "${alias}": ${checked.reason}.`)
    out.push({ alias, url: checked.url })
  }
  return out
}

/** Parse a manifest blob (untrusted). Bad vault entries are rejected individually; a bad document throws. */
export function parseManifest(text: string, anyHost: boolean): { manifest: TeamManifest; rejected: RejectedVault[] } {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Fault('INVALID_ARGUMENT', 'courier-team.json is not valid JSON.')
  }
  if (!isObj(json)) throw new Fault('INVALID_ARGUMENT', 'courier-team.json must be a JSON object.')
  if (json.version !== 1) throw new Fault('INVALID_ARGUMENT', `courier-team.json has unsupported version ${JSON.stringify(json.version)} (this Courier reads version 1).`)
  const name = cleanName(json.name)
  const vaults: VaultConfig[] = []
  const rejected: RejectedVault[] = []
  const list = Array.isArray(json.vaults) ? json.vaults : []
  for (const v of list.slice(0, MAX_VAULTS)) {
    const alias = isObj(v) && typeof v.alias === 'string' ? v.alias.trim().slice(0, 64) : ''
    const url = isObj(v) && typeof v.url === 'string' ? v.url.trim().slice(0, 300) : ''
    if (!ALIAS_RE.test(alias)) {
      rejected.push({ alias, url, reason: 'invalid alias' })
      continue
    }
    if (vaults.some((x) => x.alias.toLowerCase() === alias.toLowerCase()) || rejected.some((x) => x.alias.toLowerCase() === alias.toLowerCase())) {
      rejected.push({ alias, url, reason: 'duplicate alias' })
      continue
    }
    const checked = checkTeamVaultUrl(url, anyHost)
    if ('reason' in checked) rejected.push({ alias, url, reason: checked.reason })
    else vaults.push({ alias, url: checked.url })
  }
  return { manifest: { version: 1, name, vaults }, rejected }
}

/** Canonical bytes of a manifest. */
export function serializeManifest(m: { name: string; vaults: VaultConfig[] }): string {
  return JSON.stringify({ version: 1, name: m.name, vaults: m.vaults.map((v) => ({ alias: v.alias, url: v.url })) }, null, 2) + '\n'
}

function cleanTeams(raw: unknown): StoredTeam[] {
  if (!isObj(raw) || !Array.isArray(raw.teams)) return []
  const out: StoredTeam[] = []
  for (const t of raw.teams) {
    if (!isObj(t) || !isValidId(t.id) || typeof t.accountUrl !== 'string' || typeof t.container !== 'string') continue
    const m = isObj(t.manifest) ? t.manifest : null
    out.push({
      id: t.id as string,
      name: typeof t.name === 'string' && t.name.trim() ? t.name : 'Team',
      accountUrl: t.accountUrl,
      container: t.container,
      joinedAt: typeof t.joinedAt === 'string' ? t.joinedAt : new Date(0).toISOString(),
      manifest:
        m && typeof m.etag === 'string' && typeof m.name === 'string'
          ? {
              etag: m.etag,
              readAt: typeof m.readAt === 'string' ? m.readAt : new Date(0).toISOString(),
              name: m.name,
              vaults: Array.isArray(m.vaults) ? (m.vaults.filter((v) => isObj(v) && typeof v.alias === 'string' && typeof v.url === 'string') as VaultConfig[]) : [],
              rejected: Array.isArray(m.rejected) ? (m.rejected.filter((v) => isObj(v) && typeof v.alias === 'string') as RejectedVault[]) : []
            }
          : null
    })
  }
  return out
}

function cleanApprovals(raw: unknown): ApprovalsFile {
  const out: ApprovalsFile = { approvals: {} }
  if (!isObj(raw) || !isObj(raw.approvals)) return out
  for (const [teamId, byUrl] of Object.entries(raw.approvals)) {
    if (!isObj(byUrl)) continue
    for (const [url, a] of Object.entries(byUrl)) if (isObj(a) && typeof a.approvedAt === 'string') (out.approvals[teamId] ??= {})[url] = { approvedAt: a.approvedAt, host: typeof a.host === 'string' ? a.host : '' }
  }
  return out
}

export class TeamStore {
  private readonly file: JsonFile<TeamsFile>
  private readonly approvalsFile: JsonFile<ApprovalsFile>
  private teams: StoredTeam[] = []
  private approvals: ApprovalsFile = { approvals: {} }

  constructor(userDataDir: string) {
    this.file = new JsonFile(join(userDataDir, 'teams.json'), () => ({ teams: [] }))
    this.approvalsFile = new JsonFile(join(userDataDir, 'team-vault-approvals.json'), () => ({ approvals: {} }))
  }

  async load(): Promise<void> {
    this.teams = cleanTeams(await this.file.read())
    this.approvals = cleanApprovals(await this.approvalsFile.read())
  }

  list(): StoredTeam[] {
    return structuredClone(this.teams)
  }

  get(id: Id): StoredTeam | undefined {
    const t = this.teams.find((x) => x.id === id)
    return t ? structuredClone(t) : undefined
  }

  require(id: unknown): StoredTeam {
    const t = typeof id === 'string' ? this.get(id) : undefined
    if (!t) throw new Fault('NOT_FOUND', 'Team not found. It may have been removed from this machine.')
    return t
  }

  findByLocation(loc: { accountUrl: string; container: string }): StoredTeam | undefined {
    const t = this.teams.find((x) => sameLocation(x, loc))
    return t ? structuredClone(t) : undefined
  }

  private async save(): Promise<void> {
    await this.file.write({ teams: this.teams })
  }

  async add(t: StoredTeam): Promise<void> {
    this.teams = [...this.teams.filter((x) => x.id !== t.id), t]
    await this.save()
  }

  async update(id: Id, fn: (t: StoredTeam) => void): Promise<StoredTeam> {
    const t = this.teams.find((x) => x.id === id)
    if (!t) throw new Fault('NOT_FOUND', 'Team not found.')
    fn(t)
    await this.save()
    return structuredClone(t)
  }

  async remove(id: Id): Promise<void> {
    this.teams = this.teams.filter((x) => x.id !== id)
    await this.save()
    delete this.approvals.approvals[id]
    await this.approvalsFile.write(this.approvals)
  }

  isApproved(teamId: Id, url: string): boolean {
    return Boolean(this.approvals.approvals[teamId]?.[url])
  }

  async approve(teamId: Id, vaults: { url: string; host: string }[]): Promise<void> {
    const bucket = (this.approvals.approvals[teamId] ??= {})
    const now = new Date().toISOString()
    for (const v of vaults) if (!bucket[v.url]) bucket[v.url] = { approvedAt: now, host: v.host }
    await this.approvalsFile.write(this.approvals)
  }

  /** Display name: the manifest's while there is one. */
  static displayName(t: StoredTeam): string {
    return t.manifest?.name ?? t.name
  }

  /** Public view for the renderer. */
  toTeam(t: StoredTeam): Team {
    const vaults: TeamVault[] = (t.manifest?.vaults ?? []).map((v) => {
      let host = v.url
      try {
        host = new URL(v.url).host
      } catch {
        /* stored URLs are canonical; keep the raw value */
      }
      return { alias: v.alias, url: v.url, host, approved: this.isApproved(t.id, v.url) }
    })
    return {
      id: t.id,
      name: TeamStore.displayName(t),
      accountUrl: t.accountUrl,
      container: t.container,
      joinedAt: t.joinedAt,
      manifestEtag: t.manifest?.etag ?? null,
      ...(t.manifest ? { manifestReadAt: t.manifest.readAt } : {}),
      vaults,
      rejectedVaults: t.manifest?.rejected ?? []
    }
  }
}
