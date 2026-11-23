/**
 * Script → Key Vault trust gate.
 *
 * Team collections sync through a team's blob container, so anyone with write access to it can put a
 * script into a collection that the next person to press Send runs with *their* identity. Scripts
 * therefore only get Key Vault values when this machine explicitly allows it for that collection.
 *
 * - The allow-list lives in userData (`script-vault-access.json`), keyed by collection id. It is never
 *   part of a collection document, so it is never uploaded and a teammate cannot switch it on.
 * - A grant is bound to a SHA-256 of all script text in the collection (collection, folder and request
 *   pre-request/test scripts, with item ids). It is honoured only while the hash matches the
 *   collection being executed. Local saves move a *matching* grant forward; any other change to the
 *   scripts (sync download, conflict "take theirs") makes it lapse.
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ScriptVaultAccess } from '../shared/api'
import type { Collection, Id, Item } from '../shared/types'
import { JsonFile } from './store'

export const VAULT_SCRIPT_BLOCKED = 'VAULT_SCRIPT_BLOCKED'
export const SETTING_LABEL = "Allow this collection's scripts to read Key Vault secrets"

/** Why scripts in an execution may not obtain Key Vault values. */
export type ScriptVaultDenial = 'no-collection' | 'not-allowed' | 'lapsed' | 'unsaved-scripts'

export interface ScriptVaultGate {
  allowed: boolean
  reason?: ScriptVaultDenial
  collectionId?: Id
  collectionName?: string
}

export function blockedMessage(gate: ScriptVaultGate | undefined): string {
  const name = gate?.collectionName ? `"${gate.collectionName}"` : 'this collection'
  switch (gate?.reason) {
    case 'no-collection':
      return `Scripts in an unsaved request cannot read Key Vault secrets. Save the request to a collection, then turn on "${SETTING_LABEL}" in that collection's settings.`
    case 'unsaved-scripts':
      return `This request has unsaved script changes, and only saved scripts may read Key Vault secrets. Save the request and send again.`
    case 'lapsed':
      return `Scripts in collection ${name} may no longer read Key Vault secrets on this machine because its scripts changed in a sync. Review the scripts, then turn on "${SETTING_LABEL}" again in the collection's settings.`
    default:
      return `Scripts in collection ${name} are not allowed to read Key Vault secrets on this machine. To allow it, open the collection's settings and turn on "${SETTING_LABEL}".`
  }
}

/** Hash of every script in the collection, in tree order. Any edit to any script changes it. */
export function collectionScriptsHash(c: Collection): string {
  const parts: [string, string, string][] = [['', c.preRequestScript ?? '', c.testScript ?? '']]
  const walk = (items: Item[]): void => {
    for (const it of items) {
      if ((it.preRequestScript ?? '') || (it.testScript ?? '')) parts.push([it.id, it.preRequestScript ?? '', it.testScript ?? ''])
      if (it.type === 'folder') walk(it.items)
    }
  }
  walk(c.items)
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

interface Grant {
  scriptsHash: string
  grantedAt: string
}
interface Lapse {
  at: string
  updatedBy?: string
}
interface TrustFile {
  grants: Record<Id, Grant>
  lapsed: Record<Id, Lapse>
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function clean(raw: unknown): TrustFile {
  const out: TrustFile = { grants: {}, lapsed: {} }
  if (!isObj(raw)) return out
  if (isObj(raw.grants))
    for (const [id, g] of Object.entries(raw.grants))
      if (isObj(g) && typeof g.scriptsHash === 'string' && typeof g.grantedAt === 'string') out.grants[id] = { scriptsHash: g.scriptsHash, grantedAt: g.grantedAt }
  if (isObj(raw.lapsed))
    for (const [id, l] of Object.entries(raw.lapsed))
      if (isObj(l) && typeof l.at === 'string') out.lapsed[id] = { at: l.at, ...(typeof l.updatedBy === 'string' ? { updatedBy: l.updatedBy } : {}) }
  return out
}

export class ScriptTrustStore {
  private readonly file: JsonFile<TrustFile>

  constructor(userDataDir: string) {
    this.file = new JsonFile(join(userDataDir, 'script-vault-access.json'), () => ({ grants: {}, lapsed: {} }))
  }

  private async read(): Promise<TrustFile> {
    return clean(await this.file.read())
  }

  private update(fn: (t: TrustFile) => void): Promise<TrustFile> {
    return this.file.update((raw) => {
      const t = clean(raw)
      fn(t)
      return t
    })
  }

  /** Public view for the UI. A grant whose hash no longer matches is reported as not allowed. */
  async access(c: Collection): Promise<ScriptVaultAccess> {
    const t = await this.read()
    const g = t.grants[c.id]
    if (g && g.scriptsHash === collectionScriptsHash(c)) return { allowed: true, grantedAt: g.grantedAt }
    const l = t.lapsed[c.id] ?? (g ? { at: new Date().toISOString(), ...(c.updatedBy ? { updatedBy: c.updatedBy } : {}) } : undefined)
    return { allowed: false, ...(l ? { lapsed: l } : {}) }
  }

  async grant(c: Collection): Promise<void> {
    await this.update((t) => {
      t.grants[c.id] = { scriptsHash: collectionScriptsHash(c), grantedAt: new Date().toISOString() }
      delete t.lapsed[c.id]
    })
  }

  async revoke(id: Id): Promise<void> {
    await this.update((t) => {
      delete t.grants[id]
      delete t.lapsed[id]
    })
  }

  /**
   * The authoritative check at send/run time, against the exact collection object being executed.
   * A mismatching grant is withdrawn (and recorded as lapsed) on the spot.
   */
  async check(c: Collection): Promise<{ allowed: boolean; lapsed: boolean }> {
    const t = await this.read()
    const g = t.grants[c.id]
    if (g && g.scriptsHash === collectionScriptsHash(c)) return { allowed: true, lapsed: false }
    if (g) await this.lapse(c)
    return { allowed: false, lapsed: Boolean(g || t.lapsed[c.id]) }
  }

  /**
   * A local save replaced `before` with `after`: move the grant forward only if it matched `before`
   * (so a lapsed grant is never revived by an unrelated local edit).
   */
  async rebind(before: Collection, after: Collection): Promise<void> {
    const t = await this.read()
    const g = t.grants[before.id]
    if (!g) return
    const beforeHash = collectionScriptsHash(before)
    if (g.scriptsHash !== beforeHash) {
      await this.lapse(before)
      return
    }
    const afterHash = collectionScriptsHash(after)
    if (afterHash === beforeHash) return
    await this.update((x) => {
      if (x.grants[before.id]?.scriptsHash === beforeHash) x.grants[before.id] = { ...x.grants[before.id], scriptsHash: afterHash }
    })
  }

  /** After content arrived from elsewhere (sync, conflict resolution): withdraw grants that no longer match. */
  async reconcile(collections: Map<Id, Collection>): Promise<void> {
    const t = await this.read()
    for (const [id, g] of Object.entries(t.grants)) {
      const c = collections.get(id)
      if (!c) await this.revoke(id)
      else if (g.scriptsHash !== collectionScriptsHash(c)) await this.lapse(c)
    }
  }

  private async lapse(c: Collection): Promise<void> {
    await this.update((t) => {
      if (!t.grants[c.id]) return
      delete t.grants[c.id]
      t.lapsed[c.id] = { at: new Date().toISOString(), ...(c.updatedBy ? { updatedBy: c.updatedBy } : {}) }
    })
  }
}
