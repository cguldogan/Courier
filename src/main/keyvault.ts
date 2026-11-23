/**
 * Azure Key Vault secrets, accessed only with the signed-in credential (SecretClient handles the
 * 401 bearer challenge). Values are cached in memory with a short TTL and never written to disk.
 *
 * Which vaults a reference can reach depends on its context (`teamId`): for a team's items the
 * team manifest's vaults come first, then your own vaults from settings; Personal items and
 * requests outside a collection only see your own vaults. A bare `{{vault:name}}` uses the first
 * vault of that list. Team vaults that are not approved on this machine (or were rejected when the
 * manifest was read) carry a `denied` error that is thrown BEFORE any cache lookup or network call.
 *
 * `disableChallengeResourceVerification` exists ONLY for the test hook
 * (`COURIER_KV_INSECURE_CHALLENGE=1`, used against the local mock vault on 127.0.0.1); production
 * keeps the SDK's verification that the challenge resource matches the vault host.
 */
import type { TokenCredential } from '@azure/core-auth'
import { SecretClient, type SecretProperties } from '@azure/keyvault-secrets'
import type { Id, SecretSummary, SecretValue, VaultConfig } from '../shared/types'
import { formatVaultRef, parseVaultRef } from '../shared/variables'
import { Fault, isNetworkError, messageOf } from './errors'
import type { VaultResolver } from './executor'

export interface VaultCandidate extends VaultConfig {
  /** Set for team manifest vaults. */
  team?: { id: Id; name: string }
  /** Using this vault fails with this error (unapproved host, rejected manifest entry). */
  denied?: Fault
  /** Rejected manifest entry: only reachable by its alias, never the default vault. */
  rejected?: boolean
}

/**
 * Vaults for a team context, in resolution order: the team manifest's vaults, its rejected entries
 * (reachable only by alias, always failing), then the caller's own vaults. A manifest vault whose URL
 * is not approved carries a VAULT_NOT_APPROVED error, so an alias never silently falls through to
 * another vault. Shared by the app (approvals in userData) and the command-line runner (approvals
 * given with `--approve-vault`); only the wording of the hint differs.
 */
export function teamVaultCandidates(input: {
  team: { id: Id; name: string }
  manifest: { vaults: VaultConfig[]; rejected: { alias: string; reason: string }[] } | null
  own: VaultConfig[]
  isApproved: (url: string) => boolean
  /** How to approve a host, appended to the VAULT_NOT_APPROVED message. */
  approveHint: (host: string) => string
}): VaultCandidate[] {
  const own: VaultCandidate[] = input.own.map((v) => ({ ...v }))
  const m = input.manifest
  if (!m) return own
  const team = input.team
  const listed: VaultCandidate[] = m.vaults.map((v) => {
    if (input.isApproved(v.url)) return { ...v, team }
    const host = new URL(v.url).host
    return {
      ...v,
      team,
      denied: new Fault('VAULT_NOT_APPROVED', `Team "${team.name}" lists Key Vault "${v.alias}" on host ${host}, which is not approved on this machine. ${input.approveHint(host)}`)
    }
  })
  const rejected: VaultCandidate[] = m.rejected.map((r) => ({
    alias: r.alias,
    url: '',
    team,
    rejected: true,
    denied: new Fault('INVALID_ARGUMENT', `Team "${team.name}" lists Key Vault "${r.alias}" with an unusable URL (${r.reason}), so it is ignored.`)
  }))
  return [...listed, ...rejected, ...own]
}

export interface KeyVaultOptions {
  credential: TokenCredential
  /** Vaults in resolution order for a context (null = Personal / no collection). */
  vaults: (teamId: Id | null) => VaultCandidate[]
  ttlSeconds: () => number
  disableChallengeResourceVerification?: boolean
  maxRetries?: number
}

function summary(p: SecretProperties): SecretSummary {
  const s: SecretSummary = { name: p.name, enabled: p.enabled !== false }
  if (p.contentType) s.contentType = p.contentType
  if (p.createdOn) s.createdOn = p.createdOn.toISOString()
  if (p.updatedOn) s.updatedOn = p.updatedOn.toISOString()
  if (p.version) s.version = p.version
  return s
}

export class KeyVaultService implements VaultResolver {
  private readonly clients = new Map<string, SecretClient>()
  private readonly cache = new Map<string, { value: string; exp: number }>()

  constructor(private readonly opts: KeyVaultOptions) {}

  private vault(alias: string | undefined, teamId: Id | null): VaultConfig {
    const all = this.opts.vaults(teamId)
    const usable = all.filter((x) => !x.rejected)
    if (!all.length) throw new Fault('NOT_CONFIGURED', 'No Key Vault is configured. Add one in Settings → Key Vault (or in the team\'s settings).')
    const v = alias ? all.find((x) => x.alias.toLowerCase() === alias.toLowerCase()) : usable[0]
    if (!v) {
      if (!alias) throw new Fault('NOT_CONFIGURED', 'No usable Key Vault is configured. Add one in Settings → Key Vault.')
      throw new Fault('NOT_CONFIGURED', `Unknown Key Vault alias "${alias}". Configured: ${[...new Set(all.map((x) => x.alias))].join(', ')}.`)
    }
    if (v.denied) throw v.denied
    return v
  }

  /** A resolver bound to one context, for an execution (send / run). */
  resolver(teamId: Id | null): VaultResolver {
    return { resolve: (ref) => this.resolve(ref, teamId) }
  }

  private client(v: VaultConfig): SecretClient {
    let c = this.clients.get(v.url)
    if (!c) {
      c = new SecretClient(v.url, this.opts.credential, {
        disableChallengeResourceVerification: this.opts.disableChallengeResourceVerification === true,
        retryOptions: { maxRetries: this.opts.maxRetries ?? 2 }
      })
      this.clients.set(v.url, c)
    }
    return c
  }

  private fail(err: unknown, v: VaultConfig, what: string, write = false): Fault {
    if (err instanceof Fault) return err
    const status = (err as { statusCode?: number }).statusCode
    const code = (err as { code?: string }).code
    const where = `vault "${v.alias}" (${v.url})`
    if (status === 403)
      return new Fault(
        'FORBIDDEN',
        `Access denied to ${what} in ${where}. Your identity needs the "${write ? 'Key Vault Secrets Officer' : 'Key Vault Secrets User'}" role on the vault (or an access policy allowing ${write ? 'Set' : 'Get/List'}).`
      )
    if (status === 404 || code === 'SecretNotFound') return new Fault('NOT_FOUND', `${what[0].toUpperCase()}${what.slice(1)} was not found in ${where}.`)
    if (status === 401) return new Fault('AUTH_FAILED', `Key Vault rejected the token for ${where}: ${messageOf(err).split('\n')[0]}`)
    if (/sign in/i.test(messageOf(err))) return new Fault('NOT_SIGNED_IN', 'Sign in with your Azure identity to use Key Vault.')
    if (isNetworkError(err)) return new Fault('NETWORK', `Could not reach ${where}: ${messageOf(err)}`)
    return new Fault('VAULT_ERROR', `Key Vault error for ${what} in ${where}: ${messageOf(err).split('\n')[0]}`)
  }

  /** Resolve a reference (`name`, `alias/name`, `name@version`) in a context. Cached for `ttlSeconds`. */
  async resolve(ref: string, teamId: Id | null = null): Promise<string> {
    const parsed = parseVaultRef(ref)
    if (!parsed) throw new Fault('INVALID_ARGUMENT', `Invalid Key Vault reference "${ref}" (expected name, alias/name or name@version).`)
    const v = this.vault(parsed.alias, teamId)
    const key = `${v.url}|${parsed.name.toLowerCase()}|${parsed.version ?? ''}`
    const hit = this.cache.get(key)
    if (hit && hit.exp > Date.now()) return hit.value
    let value: string
    try {
      const s = await this.client(v).getSecret(parsed.name, parsed.version ? { version: parsed.version } : {})
      value = s.value ?? ''
    } catch (err) {
      throw this.fail(err, v, `secret "${formatVaultRef(parsed)}"`)
    }
    const ttl = this.opts.ttlSeconds()
    if (ttl > 0) this.cache.set(key, { value, exp: Date.now() + ttl * 1000 })
    return value
  }

  async list(alias?: string, teamId: Id | null = null): Promise<SecretSummary[]> {
    const v = this.vault(alias, teamId)
    const out: SecretSummary[] = []
    try {
      for await (const p of this.client(v).listPropertiesOfSecrets()) {
        if (p.managed) continue
        out.push(summary(p))
        if (out.length >= 5000) break
      }
    } catch (err) {
      throw this.fail(err, v, 'the secret list')
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  async get(input: { alias?: string; teamId?: Id | null; name: string; version?: string }): Promise<SecretValue> {
    const v = this.vault(input.alias, input.teamId ?? null)
    if (!parseVaultRef(input.name)) throw new Fault('INVALID_ARGUMENT', `Invalid secret name "${input.name}".`)
    try {
      const s = await this.client(v).getSecret(input.name, input.version ? { version: input.version } : {})
      return { ...summary(s.properties), value: s.value ?? '' }
    } catch (err) {
      throw this.fail(err, v, `secret "${input.name}"`)
    }
  }

  async set(input: { alias?: string; teamId?: Id | null; name: string; value: string; contentType?: string }): Promise<SecretSummary> {
    const v = this.vault(input.alias, input.teamId ?? null)
    if (!/^[0-9A-Za-z-]{1,127}$/.test(input.name)) throw new Fault('INVALID_ARGUMENT', 'Secret names may contain only letters, digits and dashes (max 127).')
    try {
      const s = await this.client(v).setSecret(input.name, input.value, input.contentType ? { contentType: input.contentType } : {})
      // Drop cached unversioned value so the next send uses the new version.
      for (const k of [...this.cache.keys()]) if (k.startsWith(`${v.url}|${input.name.toLowerCase()}|`)) this.cache.delete(k)
      return summary(s.properties)
    } catch (err) {
      throw this.fail(err, v, `secret "${input.name}"`, true)
    }
  }

  clearCache(): void {
    this.cache.clear()
  }

  /** Drop clients (e.g. after sign-in changes) and cached values. */
  reset(): void {
    this.cache.clear()
    this.clients.clear()
  }
}
