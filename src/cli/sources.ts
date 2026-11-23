/**
 * Where a command-line run gets its documents: local files (Courier or Postman JSON) or a team
 * container, downloaded read-only with the run's identity. Nothing is written locally and nothing is
 * uploaded; there is no team cache.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ContainerClient } from '@azure/storage-blob'
import { createContainerClient, downloadTeamDoc, listTeamDocs, readManifest, type ManifestRead } from '../main/blobsync'
import { Fault, messageOf } from '../main/errors'
import { normalizeAccountUrl, normalizeContainer } from '../main/teams'
import { importPostmanCollection, importPostmanEnvironment, isPostmanCollection, isPostmanEnvironment } from '../shared/postman'
import { COLLECTION_SCHEMA, ENVIRONMENT_SCHEMA, normalizeCollection, normalizeEnvironment } from '../shared/serialize'
import type { Collection, Environment, ItemKind } from '../shared/types'
import type { CliIdentity } from './identity'

export interface Loaded<T> {
  doc: T
  warnings: string[]
}

export async function readJsonFile(path: string, cwd: string, what: string): Promise<unknown> {
  const full = resolve(cwd, path)
  let text: string
  try {
    text = await readFile(full, 'utf8')
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'ENOENT') throw new Fault('NOT_FOUND', `${what} file not found: ${path}`)
    if (code === 'EISDIR') throw new Fault('INVALID_ARGUMENT', `${what} path is a directory, not a file: ${path}`)
    throw new Fault('INVALID_ARGUMENT', `Cannot read ${what.toLowerCase()} file ${path}: ${messageOf(err)}`)
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''))
  } catch (err) {
    throw new Fault('INVALID_ARGUMENT', `${what} file ${path} is not valid JSON: ${messageOf(err)}`)
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A Courier collection (`courier.collection/v1`) or a Postman v2.0/v2.1 collection. */
export function collectionFromJson(json: unknown, label: string): Loaded<Collection> {
  if (isObj(json) && json.schema === COLLECTION_SCHEMA) return { doc: normalizeCollection(json), warnings: [] }
  if (isPostmanCollection(json)) {
    const { value, warnings } = importPostmanCollection(json)
    return { doc: value, warnings }
  }
  throw new Fault('IMPORT_FAILED', `${label} is not a Courier collection (schema "${COLLECTION_SCHEMA}") or a Postman v2.0/v2.1 collection.`)
}

/** A Courier environment, a Postman environment, or a Postman globals export. */
export function environmentFromJson(json: unknown, label: string): Loaded<Environment> {
  if (isObj(json) && json.schema === ENVIRONMENT_SCHEMA) return { doc: normalizeEnvironment(json), warnings: [] }
  if (isPostmanEnvironment(json)) {
    const { value, warnings } = importPostmanEnvironment(json)
    return { doc: value, warnings }
  }
  throw new Fault('IMPORT_FAILED', `${label} is not a Courier environment (schema "${ENVIRONMENT_SCHEMA}") or a Postman environment/globals file.`)
}

export interface TeamLocation {
  accountUrl: string
  container: string
}

/** A team container, read with the run's identity. */
export class TeamSource {
  readonly where: TeamLocation
  private client: ContainerClient | null = null
  private manifest: ManifestRead | null | undefined

  constructor(
    raw: { accountUrl: string; container: string },
    private readonly identity: CliIdentity,
    private readonly anyVaultHost: boolean
  ) {
    this.where = { accountUrl: normalizeAccountUrl(raw.accountUrl), container: normalizeContainer(raw.container) }
  }

  private async container(): Promise<ContainerClient> {
    await this.identity.ensure()
    this.client ??= createContainerClient(this.where.accountUrl, this.where.container, this.identity.credential())
    return this.client
  }

  /** `courier-team.json` (null when the container has none). Untrusted: vaults still need `--approve-vault`. */
  async readManifest(): Promise<ManifestRead | null> {
    if (this.manifest === undefined) this.manifest = await readManifest(await this.container(), this.where, this.anyVaultHost)
    return this.manifest
  }

  /**
   * A team collection or environment by id, else by name (exact, then case-insensitive). Ambiguous
   * names and misses are errors that list the candidates.
   */
  async find<T extends Collection | Environment>(kind: ItemKind, wanted: string): Promise<T> {
    const c = await this.container()
    const label = kind === 'collection' ? 'collection' : 'environment'
    const listed = await listTeamDocs(c, this.where, kind)
    if (listed.some((x) => x.id === wanted)) return (await downloadTeamDoc(c, this.where, kind, wanted)).doc as T
    const docs: T[] = []
    for (const x of listed) docs.push((await downloadTeamDoc(c, this.where, kind, x.id)).doc as T)
    let hits = docs.filter((d) => d.name === wanted)
    if (!hits.length) hits = docs.filter((d) => d.name.toLowerCase() === wanted.toLowerCase())
    if (hits.length === 1) return hits[0]
    const list = (ds: T[]): string =>
      [...ds]
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
        .slice(0, 25)
        .map((d) => `\n  - "${d.name}" (id ${d.id})`)
        .join('') + (ds.length > 25 ? `\n  … and ${ds.length - 25} more` : '')
    if (hits.length > 1) throw new Fault('INVALID_ARGUMENT', `${hits.length} team ${label}s are named "${wanted}". Pass the id instead:${list(hits)}`)
    throw new Fault(
      'NOT_FOUND',
      `No ${label} named or with id "${wanted}" in container "${this.where.container}" (${this.where.accountUrl}).${docs.length ? ` Available:${list(docs)}` : ` The container has no ${label}s.`}`
    )
  }
}
