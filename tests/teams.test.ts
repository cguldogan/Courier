/**
 * Personal + Teams: isolation between teams, per-team failures, moves, team manifests, team Key
 * Vault resolution with the host-approval gate, and the migration from the old spaces layout.
 * Azurite (`--oauth basic`, HTTPS) with one container per team, local HTTPS fakes for RBAC failures,
 * mock Key Vaults with the 401 challenge. No real Azure.
 */
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ContainerClient } from '@azure/storage-blob'
import { FakeCredential } from '../src/main/azure'
import { createContainerClient } from '../src/main/blobsync'
import { CourierCore } from '../src/main/core'
import { serializeCollection } from '../src/shared/serialize'
import { newCollection, newRequest, type Collection } from '../src/shared/types'
import { ID_A, ID_B, cleanupTempDirs, echoServer, httpsServer, listen, makeCore, readTree, seedManifest, teamClient, tempDir, type Listening } from './helpers'

const ACCOUNT = process.env.COURIER_TEST_AZURITE as string

afterAll(cleanupTempDirs)

async function newContainer(manifest?: { name: string; vaults?: { alias: string; url: string }[] }): Promise<{ name: string; admin: ContainerClient }> {
  const name = `t${Math.random().toString(36).slice(2, 12)}`
  const admin = createContainerClient(ACCOUNT, name, new FakeCredential(ID_A))
  await admin.create()
  if (manifest) await seedManifest(ACCOUNT, name, manifest)
  return { name, admin }
}
async function blobs(admin: ContainerClient): Promise<string[]> {
  const out: string[] = []
  for await (const b of admin.listBlobsFlat()) out.push(b.name)
  return out.sort()
}
async function names(core: CourierCore): Promise<string[]> {
  const s = await core.load()
  return [...s.collections.map((c) => c.collection.name), ...s.environments.map((e) => e.environment.name)].sort()
}
const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : [])

// ---------------------------------------------------------------------------------------------

describe('isolation between teams', () => {
  it('two teams never see each other’s items: blobs, cache directories, sync state', async () => {
    const alpha = await newContainer({ name: 'Alpha' })
    const beta = await newContainer({ name: 'Beta' })
    const a = await makeCore({ identity: ID_A })
    const ta = await a.joinTeam({ accountUrl: ACCOUNT, container: alpha.name })
    const tb = await a.joinTeam({ accountUrl: ACCOUNT, container: beta.name })
    expect([ta.name, tb.name]).toEqual(['Alpha', 'Beta'])
    const ca = (await a.createCollection({ name: 'Alpha API', teamId: ta.id })).collection
    const cb = (await a.createCollection({ name: 'Beta Secret Project', teamId: tb.id })).collection
    const eb = (await a.createEnvironment({ name: 'Beta Env', teamId: tb.id })).environment
    const personal = (await a.createCollection({ name: 'Mine' })).collection
    const r = await a.runSync()
    expect(r.errors).toEqual([])
    expect(r.teams.map((t) => [t.name, t.ok])).toEqual([['Alpha', true], ['Beta', true]])
    expect(r.uploaded.map((x) => [x.name, x.teamId]).sort()).toEqual([['Alpha API', ta.id], ['Beta Env', tb.id], ['Beta Secret Project', tb.id]])

    expect(await blobs(alpha.admin)).toEqual(['courier-team.json', `shared/collections/${ca.id}.json`])
    expect(await blobs(beta.admin)).toEqual(['courier-team.json', `shared/collections/${cb.id}.json`, `shared/environments/${eb.id}.json`])
    // cache: one directory per team, Personal at the root
    const data = join(a.store.root, 'data')
    expect(files(join(data, 'collections'))).toEqual([`${personal.id}.json`])
    expect(files(join(data, 'teams', ta.id, 'collections'))).toEqual([`${ca.id}.json`])
    expect(files(join(data, 'teams', tb.id, 'collections'))).toEqual([`${cb.id}.json`])
    expect(readFileSync(join(data, 'teams', ta.id, 'state.json'), 'utf8')).not.toContain(cb.id)
    const status = await a.syncStatus()
    expect(status.teams.map((t) => [t.name, t.pending, t.lastError])).toEqual([['Alpha', 0, undefined], ['Beta', 0, undefined]])

    // B is only in Alpha: nothing of Beta reaches B, not even its cache
    const { core: b } = await teamClient({ identity: ID_B, accountUrl: ACCOUNT, container: alpha.name })
    const rb = await b.runSync()
    expect(rb.downloaded.map((x) => x.name)).toEqual(['Alpha API'])
    expect(await names(b)).toEqual(['Alpha API'])
    for (const f of readTree(b.store.root)) {
      expect(f.content.includes(cb.id) || f.content.includes('Beta Secret Project') || f.content.includes(eb.id), f.path).toBe(false)
      expect(f.content.includes(personal.id), f.path).toBe(false)
    }

    // a blob in Beta reusing Alpha's id is not mixed into Alpha's item
    const clash = serializeCollection({ ...newCollection({ id: ca.id, name: 'Impostor' }) })
    await beta.admin.getBlockBlobClient(`shared/collections/${ca.id}.json`).upload(clash, Buffer.byteLength(clash))
    const r2 = await a.runSync()
    expect(r2.downloaded).toEqual([])
    expect(r2.notices.find((n) => n.teamId === tb.id)?.message).toMatch(/same id already exists in another team/)
    expect((await a.load()).collections.find((c) => c.collection.id === ca.id)).toMatchObject({ collection: { name: 'Alpha API' }, sync: { teamId: ta.id } })

    // leaving Beta drops its cache, never its blobs
    const left = await a.leaveTeam({ id: tb.id })
    expect(left).toEqual({ left: true, unsynced: [] })
    expect(existsSync(join(data, 'teams', tb.id))).toBe(false)
    expect(await names(a)).toEqual(['Alpha API', 'Mine'])
    expect((await blobs(beta.admin)).length).toBe(4)
    expect((await a.runSync()).teams.map((t) => t.name)).toEqual(['Alpha'])
  })

  it('leaving a team with unsynced changes needs confirmation', async () => {
    const t = await newContainer({ name: 'Gamma' })
    const { core: a, teamId } = await teamClient({ accountUrl: ACCOUNT, container: t.name })
    const c = (await a.createCollection({ name: 'Unsent', teamId })).collection
    await a.setCurrentValues({ scope: 'collection', id: c.id, values: { token: 'local' } })
    const first = await a.leaveTeam({ id: teamId })
    expect(first.left).toBe(false)
    expect(first.unsynced.map((x) => x.name)).toEqual(['Unsent'])
    expect(await names(a)).toEqual(['Unsent'])
    expect((await a.leaveTeam({ id: teamId, discardUnsynced: true })).left).toBe(true)
    expect(await names(a)).toEqual([])
    expect((await a.load()).currentValues.collections[c.id]).toBeUndefined()
    expect(a.listTeams()).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------

/** Fake storage endpoint: serves a manifest (or 404) and answers everything else with `status`. */
async function fakeStorage(opts: { manifest?: object; status: number; errorCode: string; putStatus?: number }): Promise<Listening & { hits: { method: string; url: string }[] }> {
  const hits: { method: string; url: string }[] = []
  const srv = await listen(
    httpsServer((req: IncomingMessage, res: ServerResponse) => {
      hits.push({ method: req.method ?? '', url: req.url ?? '' })
      req.resume()
      const isManifest = (req.url ?? '').split('?')[0].endsWith('/courier-team.json')
      const fail = (status: number, code: string): void => {
        res.statusCode = status
        res.setHeader('x-ms-error-code', code)
        res.setHeader('content-type', 'application/xml')
        res.end(`<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`)
      }
      if (isManifest && req.method === 'GET') {
        if (!opts.manifest) return fail(404, 'BlobNotFound')
        const body = JSON.stringify(opts.manifest)
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.setHeader('content-length', Buffer.byteLength(body))
        res.setHeader('etag', '"0x8DD0000FAKE0001"')
        res.setHeader('last-modified', new Date().toUTCString())
        res.setHeader('x-ms-blob-type', 'BlockBlob')
        res.end(body)
        return
      }
      if (isManifest && req.method === 'PUT' && opts.putStatus) return fail(opts.putStatus, 'AuthorizationPermissionMismatch')
      fail(opts.status, opts.errorCode)
    }),
    'https'
  )
  return Object.assign(srv, { hits })
}

describe('per-team failures', () => {
  it('a team answering 403 or a team whose container is gone does not stop the other teams', async () => {
    const denied = await fakeStorage({ manifest: { version: 1, name: 'Locked', vaults: [] }, status: 403, errorCode: 'AuthorizationPermissionMismatch' })
    try {
      const gone = await newContainer({ name: 'Gone' })
      const ok = await newContainer({ name: 'Works' })
      const a = await makeCore({ identity: ID_A })
      const locked = await a.joinTeam({ accountUrl: `${denied.url}/acct`, container: 'locked' })
      const tg = await a.joinTeam({ accountUrl: ACCOUNT, container: gone.name })
      const tw = await a.joinTeam({ accountUrl: ACCOUNT, container: ok.name })
      await a.createCollection({ name: 'Blocked item', teamId: locked.id })
      await a.createCollection({ name: 'Lost item', teamId: tg.id })
      const fine = (await a.createCollection({ name: 'Fine item', teamId: tw.id })).collection
      await gone.admin.delete()
      const r = await a.runSync()
      expect(r.teams.map((t) => [t.name, t.ok, t.error?.code ?? null])).toEqual([
        ['Locked', false, 'FORBIDDEN'],
        ['Gone', false, 'CONTAINER_NOT_FOUND'],
        ['Works', true, null]
      ])
      expect(r.errors.map((e) => [e.teamId, e.code])).toEqual([
        [locked.id, 'FORBIDDEN'],
        [tg.id, 'CONTAINER_NOT_FOUND']
      ])
      expect(r.errors[0].message).toMatch(/Storage Blob Data Contributor/)
      expect(r.uploaded.map((x) => x.id)).toEqual([fine.id])
      const status = await a.syncStatus()
      expect(status.teams.map((t) => [t.name, t.lastError?.code ?? null, t.pending])).toEqual([
        ['Locked', 'FORBIDDEN', 1],
        ['Gone', 'CONTAINER_NOT_FOUND', 1],
        ['Works', null, 0]
      ])
      // syncing a single team only touches that team
      const only = await a.runSync({ teamId: tw.id })
      expect(only.teams.map((t) => t.name)).toEqual(['Works'])
    } finally {
      await denied.close()
    }
  })
})

// ---------------------------------------------------------------------------------------------

describe('moving between Personal and teams', () => {
  it('Personal → team → Personal, team → team; old blobs go only after the new upload (If-Match)', async () => {
    const one = await newContainer({ name: 'One' })
    const two = await newContainer({ name: 'Two' })
    const a = await makeCore({ identity: ID_A })
    const t1 = await a.joinTeam({ accountUrl: ACCOUNT, container: one.name })
    const t2 = await a.joinTeam({ accountUrl: ACCOUNT, container: two.name })
    const c = (await a.createCollection({ name: 'Wanderer' })).collection
    expect((await a.runSync()).uploaded).toEqual([])
    expect(await blobs(one.admin)).toEqual(['courier-team.json'])

    // Personal → team One
    expect((await a.move('collection', { id: c.id, teamId: t1.id })).moved).toBe(true)
    let entry = (await a.load()).collections[0]
    expect(entry.sync).toMatchObject({ teamId: t1.id, dirty: true })
    await a.runSync()
    entry = (await a.load()).collections[0]
    expect(await blobs(one.admin)).toEqual(['courier-team.json', `shared/collections/${c.id}.json`])
    const etag1 = (await one.admin.getBlockBlobClient(`shared/collections/${c.id}.json`).getProperties()).etag!.replace(/"/g, '')
    expect(entry.sync).toMatchObject({ teamId: t1.id, dirty: false, etag: etag1 })

    // team One → team Two: upload to Two, then delete from One
    await a.move('collection', { id: c.id, teamId: t2.id })
    expect((await a.syncStatus()).teams.find((t) => t.teamId === t1.id)?.pendingDeletes.map((d) => d.id)).toEqual([c.id])
    const r = await a.runSync()
    expect(r.uploaded.map((x) => [x.id, x.teamId])).toEqual([[c.id, t2.id]])
    expect(r.deletedRemotely.map((x) => [x.id, x.teamId])).toEqual([[c.id, t1.id]])
    expect(await blobs(one.admin)).toEqual(['courier-team.json'])
    expect(await blobs(two.admin)).toEqual(['courier-team.json', `shared/collections/${c.id}.json`])

    // team Two → Personal: the blob is deleted (If-Match), the item stays here with no sync state
    await a.move('collection', { id: c.id, teamId: null })
    entry = (await a.load()).collections[0]
    expect(entry.sync).toEqual({ dirty: false })
    expect((await a.runSync()).deletedRemotely.map((x) => x.teamId)).toEqual([t2.id])
    expect(await blobs(two.admin)).toEqual(['courier-team.json'])
    expect(files(join(a.store.root, 'data', 'collections'))).toEqual([`${c.id}.json`])
  })

  it('a blocked upload to the new team keeps the old blob; secret warnings apply to every team destination', async () => {
    const one = await newContainer({ name: 'One' })
    const two = await newContainer({ name: 'Two' })
    const a = await makeCore({ identity: ID_A })
    const t1 = await a.joinTeam({ accountUrl: ACCOUNT, container: one.name })
    const t2 = await a.joinTeam({ accountUrl: ACCOUNT, container: two.name })
    const c = (await a.createCollection({ name: 'Leaky', teamId: t1.id })).collection
    await a.runSync()
    await a.saveCollection({ ...c, auth: { type: 'bearer', token: 'literal-token-value-123' } })
    await a.runSync({ acknowledgeWarnings: true })
    const m = await a.move('collection', { id: c.id, teamId: t2.id })
    expect(m.moved).toBe(false)
    expect(m.warnings.map((w) => w.field)).toEqual(['bearer.token'])
    expect((await a.move('collection', { id: c.id, teamId: t2.id, acknowledgeWarnings: true })).moved).toBe(true)
    // the sync scans again: upload held back → the old blob must stay
    const r = await a.runSync()
    expect(r.blocked.map((b) => b.ref.teamId)).toEqual([t2.id])
    expect(r.deletedRemotely).toEqual([])
    expect(await blobs(one.admin)).toEqual(['courier-team.json', `shared/collections/${c.id}.json`])
    const r2 = await a.runSync({ acknowledgeWarnings: true })
    expect(r2.uploaded.map((x) => x.teamId)).toEqual([t2.id])
    expect(r2.deletedRemotely.map((x) => x.teamId)).toEqual([t1.id])
    expect(await blobs(one.admin)).toEqual(['courier-team.json'])
    // moving to Personal never warns
    expect((await a.move('collection', { id: c.id, teamId: null })).warnings).toEqual([])
  })

  it('leaving the destination team before the upload never deletes the old team’s blob', async () => {
    const one = await newContainer({ name: 'One' })
    const two = await newContainer({ name: 'Two' })
    const a = await makeCore({ identity: ID_A })
    const t1 = await a.joinTeam({ accountUrl: ACCOUNT, container: one.name })
    const t2 = await a.joinTeam({ accountUrl: ACCOUNT, container: two.name })
    const c = (await a.createCollection({ name: 'Traveller', teamId: t1.id })).collection
    await a.runSync()
    await a.move('collection', { id: c.id, teamId: t2.id })
    expect((await a.leaveTeam({ id: t2.id, discardUnsynced: true })).left).toBe(true)
    const r = await a.runSync()
    expect(r.deletedRemotely).toEqual([])
    expect(r.downloaded.map((x) => [x.id, x.teamId])).toEqual([[c.id, t1.id]])
    expect(await blobs(one.admin)).toContain(`shared/collections/${c.id}.json`)
  })

  it('a teammate’s change after the move keeps the old team’s copy (412 on the If-Match delete)', async () => {
    const one = await newContainer({ name: 'One' })
    const a = await makeCore({ identity: ID_A })
    const t1 = await a.joinTeam({ accountUrl: ACCOUNT, container: one.name })
    const { core: b } = await teamClient({ identity: ID_B, accountUrl: ACCOUNT, container: one.name })
    const c = (await a.createCollection({ name: 'Shared once', teamId: t1.id })).collection
    await a.runSync()
    await b.runSync()
    await b.saveCollection({ ...(await b.load()).collections[0].collection, description: 'bob was here' })
    await b.runSync()
    await a.move('collection', { id: c.id, teamId: null })
    const r = await a.runSync()
    expect(r.deletedRemotely).toEqual([])
    expect(r.notices.map((n) => n.message).join('\n')).toMatch(/changed in this team after you moved it|changed remotely after you deleted it/)
    expect(await blobs(one.admin)).toContain(`shared/collections/${c.id}.json`)
    expect((await a.load()).collections.find((x) => x.collection.id === c.id)?.sync).toEqual({ dirty: false })
  })
})

// ---------------------------------------------------------------------------------------------

describe('Personal items never reach storage', () => {
  it('no blob request mentions a Personal item, and Personal work issues no request at all', async () => {
    const t = await newContainer({ name: 'Watched' })
    const target = new URL(ACCOUNT)
    const seen: string[] = []
    const proxy = await listen(
      httpsServer((req, res) => {
        seen.push(`${req.method} ${req.url}`)
        const up = httpsRequest({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: { ...req.headers, host: target.host } }, (r) => {
          res.writeHead(r.statusCode ?? 500, r.headers)
          r.pipe(res)
        })
        up.on('error', () => res.destroy())
        req.pipe(up)
      }),
      'https'
    )
    try {
      const a = await makeCore({ identity: ID_A })
      const team = await a.joinTeam({ accountUrl: `${proxy.url}${target.pathname}`, container: t.name })
      const teamItem = (await a.createCollection({ name: 'Team item', teamId: team.id })).collection
      const before = seen.length
      const p = (await a.createCollection({ name: 'Private notes' })).collection
      await a.saveCollection({ ...p, description: 'edited', items: [newRequest({ id: 'r1', url: 'https://api.example.com' })] })
      const env = (await a.createEnvironment({ name: 'Private env' })).environment
      const copy = await a.duplicate('collection', p.id)
      await a.deleteDoc('collection', copy.doc.id)
      await a.importText(JSON.stringify({ schema: 'courier.collection/v1', name: 'Imported privately', items: [] }))
      expect(seen.slice(before)).toEqual([])
      const r = await a.runSync()
      expect(r.uploaded.map((x) => x.id)).toEqual([teamItem.id])
      const all = seen.join('\n')
      for (const id of [p.id, env.id, copy.doc.id]) expect(all).not.toContain(id)
      expect(seen.every((s) => s.includes(`/${t.name}`))).toBe(true)
    } finally {
      await proxy.close()
    }
  })
})

// ---------------------------------------------------------------------------------------------

describe('conflicts stay within their team', () => {
  it('a conflict in one team does not affect another; resolving syncs only that team', async () => {
    const one = await newContainer({ name: 'One' })
    const two = await newContainer({ name: 'Two' })
    const a = await makeCore({ identity: ID_A })
    const b = await makeCore({ identity: ID_B })
    const a1 = await a.joinTeam({ accountUrl: ACCOUNT, container: one.name })
    const a2 = await a.joinTeam({ accountUrl: ACCOUNT, container: two.name })
    await b.joinTeam({ accountUrl: ACCOUNT, container: one.name })
    await b.joinTeam({ accountUrl: ACCOUNT, container: two.name })
    const x = (await a.createCollection({ name: 'Calm', teamId: a1.id })).collection
    const y = (await a.createCollection({ name: 'Contested', teamId: a2.id })).collection
    await a.runSync()
    await b.runSync()
    const col = async (core: CourierCore, id: string): Promise<Collection> => (await core.load()).collections.find((e) => e.collection.id === id)!.collection
    await b.saveCollection({ ...(await col(b, y.id)), description: 'B' })
    await b.runSync()
    await a.saveCollection({ ...(await col(a, y.id)), description: 'A' })
    await a.saveCollection({ ...(await col(a, x.id)), description: 'calm edit' })
    const r = await a.runSync()
    expect(r.conflicts.map((c) => [c.id, c.teamId])).toEqual([[y.id, a2.id]])
    expect(r.uploaded.map((c) => c.id)).toEqual([x.id])
    const status = await a.syncStatus()
    expect(status.teams.map((t) => [t.name, t.conflicts.length])).toEqual([['One', 0], ['Two', 1]])
    const res = await a.resolveConflict({ kind: 'collection', id: y.id, resolution: 'mine' })
    expect(res.report.teams.map((t) => t.name)).toEqual(['Two'])
    expect(res.report.uploaded.map((c) => c.id)).toEqual([y.id])
    expect(JSON.parse((await two.admin.getBlockBlobClient(`shared/collections/${y.id}.json`).downloadToBuffer()).toString()).description).toBe('A')
  })
})

// ---------------------------------------------------------------------------------------------

describe('team manifest', () => {
  it('create writes courier-team.json once (If-None-Match), join reads it, edits are ETag-protected', async () => {
    const t = await newContainer()
    const a = await makeCore({ identity: ID_A, insecureKv: true })
    const created = await a.createTeam({ accountUrl: ACCOUNT, container: t.name, name: '  Payments   Team ', vaults: [{ alias: 'pay', url: 'https://payments-kv.vault.azure.net/' }] })
    expect(created).toMatchObject({ name: 'Payments Team', vaults: [{ alias: 'pay', url: 'https://payments-kv.vault.azure.net', host: 'payments-kv.vault.azure.net', approved: true }] })
    const blob = JSON.parse((await t.admin.getBlockBlobClient('courier-team.json').downloadToBuffer()).toString())
    expect(blob).toEqual({ version: 1, name: 'Payments Team', vaults: [{ alias: 'pay', url: 'https://payments-kv.vault.azure.net' }] })

    const b = await makeCore({ identity: ID_B, insecureKv: true })
    await expect(b.createTeam({ accountUrl: ACCOUNT, container: t.name, name: 'Hijack' })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(JSON.parse((await t.admin.getBlockBlobClient('courier-team.json').downloadToBuffer()).toString()).name).toBe('Payments Team')
    const probe = await b.probeTeam({ accountUrl: ACCOUNT, container: t.name })
    expect(probe.manifest).toEqual({ version: 1, name: 'Payments Team', vaults: [{ alias: 'pay', url: 'https://payments-kv.vault.azure.net' }] })
    const joined = await b.joinTeam({ accountUrl: ACCOUNT, container: t.name, name: 'ignored when there is a manifest' })
    expect(joined.name).toBe('Payments Team')
    expect(joined.vaults).toMatchObject([{ alias: 'pay', approved: false }]) // a teammate's vault: not approved for B
    expect((await b.joinTeam({ accountUrl: ACCOUNT, container: t.name })).id).toBe(joined.id) // idempotent

    // A renames; B edits with the stale ETag → CONFLICT, and B now holds A's version
    const renamed = await a.updateTeam({ id: created.id, name: 'Payments', etag: created.manifestEtag! })
    expect(renamed.name).toBe('Payments')
    await expect(b.updateTeam({ id: joined.id, vaults: [], etag: joined.manifestEtag! })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(b.listTeams()[0].name).toBe('Payments')
    const fresh = b.listTeams()[0]
    const b2 = await b.updateTeam({ id: joined.id, vaults: [{ alias: 'pay', url: 'https://payments-kv.vault.azure.net' }, { alias: 'ops', url: 'https://ops-kv.vault.azure.net' }], etag: fresh.manifestEtag! })
    // only what B added is approved for B; re-saving a teammate's entry does not approve it
    expect(b2.vaults.map((v) => [v.alias, v.approved])).toEqual([['pay', false], ['ops', true]])
    const ra = await a.runSync()
    expect(ra.notices.map((n) => n.message).join('\n')).toMatch(/lists Key Vault "ops" on host ops-kv\.vault\.azure\.net/)
    expect(a.listTeams()[0].vaults.map((v) => [v.alias, v.approved])).toEqual([['pay', true], ['ops', false]])

    // own edits are validated strictly
    await expect(a.updateTeam({ id: created.id, vaults: [{ alias: 'x', url: 'http://plain.vault.azure.net' }] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/not https/) })
    await expect(a.updateTeam({ id: created.id, vaults: [{ alias: 'x', url: 'https://user:pw@x.vault.azure.net' }] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(a.updateTeam({ id: created.id, name: '   ' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('outside the test hook, manifest vaults must be Azure Key Vault hosts; bad entries are rejected, not used', async () => {
    const t = await newContainer({
      name: 'Mixed',
      vaults: [
        { alias: 'good', url: 'https://good-kv.vault.azure.net' },
        { alias: 'plain', url: 'http://plain-kv.vault.azure.net' },
        { alias: 'elsewhere', url: 'https://collector.example.com' },
        { alias: 'sneaky', url: 'https://good-kv.vault.azure.net@collector.example.com' }
      ]
    })
    const a = await makeCore({ identity: ID_A }) // no insecure hook
    const team = await a.joinTeam({ accountUrl: ACCOUNT, container: t.name })
    expect(team.vaults.map((v) => v.alias)).toEqual(['good'])
    expect(team.rejectedVaults.map((r) => [r.alias, r.reason.split(' ')[0]])).toEqual([
      ['plain', 'not'],
      ['elsewhere', 'host'],
      ['sneaky', 'contains']
    ])
    await expect(a.createTeam({ accountUrl: ACCOUNT, container: (await newContainer()).name, name: 'X', vaults: [{ alias: 'm', url: 'https://127.0.0.1:8443' }] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    const col = (await a.createCollection({ name: 'Uses rejected', teamId: team.id })).collection
    await a.upsertItem({ collectionId: col.id, item: newRequest({ id: 'r', url: 'https://api.example.com/x', headers: [{ key: 'K', value: '{{vault:elsewhere/s}}', enabled: true }] }) })
    const res = await a.send({ collectionId: col.id, requestId: 'r' })
    expect(res.error).toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/unusable URL/) })
  })

  it('a container without a manifest: read-only members join with a name; writers can create the team', async () => {
    const readOnly = await fakeStorage({ status: 403, errorCode: 'AuthorizationPermissionMismatch', putStatus: 403 })
    try {
      const a = await makeCore({ identity: ID_A })
      const loc = { accountUrl: `${readOnly.url}/acct`, container: 'nomanifest' }
      expect((await a.probeTeam(loc)).manifest).toBeNull()
      await expect(a.createTeam({ ...loc, name: 'Wanted' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(a.joinTeam(loc)).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringMatching(/enter a name to join it read-only/) })
      const team = await a.joinTeam({ ...loc, name: 'Readers' })
      expect(team).toMatchObject({ name: 'Readers', manifestEtag: null, vaults: [] })
      expect((await a.updateTeam({ id: team.id, name: 'Readers (renamed)' })).name).toBe('Readers (renamed)')
      // creating the team settings later needs write access too
      await expect(a.updateTeam({ id: team.id, vaults: [] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(readOnly.hits.filter((h) => h.method === 'PUT').length).toBe(2)
      expect(a.listTeams()[0]).toMatchObject({ name: 'Readers (renamed)', manifestEtag: null })
    } finally {
      await readOnly.close()
    }
    // with write access the same flow creates the manifest
    const t = await newContainer()
    const b = await makeCore({ identity: ID_B })
    expect((await b.probeTeam({ accountUrl: ACCOUNT, container: t.name })).manifest).toBeNull()
    expect((await b.createTeam({ accountUrl: ACCOUNT, container: t.name, name: 'Writers' })).manifestEtag).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------------------------

/** Mock Key Vault (secrets GET/list) with the 401 bearer challenge; counts authorized hits. */
async function mockVault(secrets: Record<string, string>): Promise<Listening & { hits: () => number }> {
  let hits = 0
  const srv = await listen(
    httpsServer((req, res) => {
      res.setHeader('content-type', 'application/json; charset=utf-8')
      if (!req.headers.authorization?.startsWith('Bearer ')) {
        res.statusCode = 401
        res.setHeader('www-authenticate', `Bearer authorization="https://login.microsoftonline.com/${ID_A.tid}", resource="https://vault.azure.net"`)
        res.end(JSON.stringify({ error: { code: 'Unauthorized', message: 'missing token' } }))
        return
      }
      hits++
      const parts = new URL(req.url ?? '/', 'https://x').pathname.split('/').filter(Boolean)
      if (!parts[1]) {
        res.end(JSON.stringify({ value: Object.keys(secrets).map((n) => ({ id: `https://${req.headers.host}/secrets/${n}`, attributes: { enabled: true } })), nextLink: null }))
        return
      }
      const value = secrets[parts[1]]
      if (value === undefined) {
        res.statusCode = 404
        res.end(JSON.stringify({ error: { code: 'SecretNotFound', message: 'not found' } }))
        return
      }
      res.end(JSON.stringify({ value, id: `https://${req.headers.host}/secrets/${parts[1]}/v1`, attributes: { enabled: true } }))
    }),
    'https'
  )
  return Object.assign(srv, { hits: () => hits })
}

describe('team Key Vaults: resolution order and host approval', () => {
  let teamVault: Awaited<ReturnType<typeof mockVault>>
  let teamVault2: Awaited<ReturnType<typeof mockVault>>
  let userVault: Awaited<ReturnType<typeof mockVault>>
  let echo: Awaited<ReturnType<typeof echoServer>>
  beforeAll(async () => {
    teamVault = await mockVault({ 'api-key': 'team-value', 'only-team': 'team-only-value' })
    teamVault2 = await mockVault({ 'api-key': 'redirected-value' })
    userVault = await mockVault({ 'api-key': 'user-value', 'only-mine': 'my-value' })
    echo = await echoServer()
  })
  afterAll(async () => {
    for (const s of [teamVault, teamVault2, userVault, echo]) await s.close()
  })

  async function sendWith(core: CourierCore, collectionId: string | null, header: string): Promise<{ code?: string; value?: string }> {
    const req = newRequest({ id: `r${Math.random().toString(36).slice(2, 8)}`, url: `${echo.url}/kv`, headers: [{ key: 'X-V', value: header, enabled: true }] })
    if (collectionId) await core.upsertItem({ collectionId, item: req })
    const n = echo.requests.length
    const res = collectionId ? await core.send({ collectionId, requestId: req.id }) : await core.send({ draft: req })
    if (res.error) {
      expect(echo.requests.length).toBe(n) // never sent
      return { code: res.error.code }
    }
    return { value: echo.requests.at(-1)!.headers['x-v'] as string }
  }

  it('team vaults first for team items, user vaults otherwise; unapproved hosts are blocked before any vault call', async () => {
    const t = await newContainer({ name: 'Keyed', vaults: [{ alias: 'main', url: teamVault.url }, { alias: 'teamonly', url: teamVault.url }] })
    const a = await makeCore({ identity: ID_A, insecureKv: true, settings: { keyVault: { vaults: [{ alias: 'main', url: userVault.url }, { alias: 'mine', url: userVault.url }], cacheTtlSeconds: 0 } } })
    const team = await a.joinTeam({ accountUrl: ACCOUNT, container: t.name })
    const teamCol = (await a.createCollection({ name: 'Team col', teamId: team.id })).collection.id
    const personalCol = (await a.createCollection({ name: 'Personal col' })).collection.id

    // not approved yet: every reference that lands on a team vault is blocked with a stable code
    const before = teamVault.hits()
    expect(await sendWith(a, teamCol, '{{vault:main/api-key}}')).toEqual({ code: 'VAULT_NOT_APPROVED' })
    expect(await sendWith(a, teamCol, '{{vault:api-key}}')).toEqual({ code: 'VAULT_NOT_APPROVED' })
    await expect(a.vaultList({ teamId: team.id })).rejects.toMatchObject({ code: 'VAULT_NOT_APPROVED' })
    expect(teamVault.hits()).toBe(before)
    // …while the user's own vaults keep working in the team context
    expect(await sendWith(a, teamCol, '{{vault:mine/api-key}}')).toEqual({ value: 'user-value' })

    await a.approveTeamVault({ id: team.id, url: new URL(teamVault.url).origin })
    expect(a.listTeams()[0].vaults.every((v) => v.approved)).toBe(true)
    // team collection: alias → team first; bare → the team's first vault; user-only alias → user vault
    expect(await sendWith(a, teamCol, '{{vault:main/api-key}}')).toEqual({ value: 'team-value' })
    expect(await sendWith(a, teamCol, '{{vault:api-key}}')).toEqual({ value: 'team-value' })
    expect(await sendWith(a, teamCol, '{{vault:teamonly/only-team}}')).toEqual({ value: 'team-only-value' })
    expect(await sendWith(a, teamCol, '{{vault:mine/only-mine}}')).toEqual({ value: 'my-value' })
    // Personal collection and scratch requests: user vaults only
    expect(await sendWith(a, personalCol, '{{vault:main/api-key}}')).toEqual({ value: 'user-value' })
    expect(await sendWith(a, personalCol, '{{vault:api-key}}')).toEqual({ value: 'user-value' })
    expect(await sendWith(a, personalCol, '{{vault:teamonly/only-team}}')).toEqual({ code: 'NOT_CONFIGURED' })
    expect(await sendWith(a, null, '{{vault:api-key}}')).toEqual({ value: 'user-value' })
    expect((await a.vaultList({ teamId: team.id })).map((s) => s.name)).toEqual(['api-key', 'only-team'])
    expect((await a.vaultList()).map((s) => s.name)).toEqual(['api-key', 'only-mine'])

    // a teammate re-points "main" to another host: needs a new approval, nothing reaches the new host
    await seedManifest(ACCOUNT, t.name, { name: 'Keyed', vaults: [{ alias: 'main', url: teamVault2.url }, { alias: 'teamonly', url: teamVault.url }] }, ID_B)
    const r = await a.runSync()
    expect(r.notices.map((n) => n.message).join('\n')).toMatch(new RegExp(`lists Key Vault "main" on host ${new URL(teamVault2.url).host.replace(/\./g, '\\.')}`))
    expect(await sendWith(a, teamCol, '{{vault:main/api-key}}')).toEqual({ code: 'VAULT_NOT_APPROVED' })
    expect(teamVault2.hits()).toBe(0)
    expect(await sendWith(a, teamCol, '{{vault:teamonly/only-team}}')).toEqual({ value: 'team-only-value' })
    // approvals are per team: the same host in another team is not approved
    const other = await newContainer({ name: 'Other', vaults: [{ alias: 'main', url: teamVault.url }] })
    const t2 = await a.joinTeam({ accountUrl: ACCOUNT, container: other.name })
    expect(t2.vaults[0].approved).toBe(false)
    await expect(a.approveTeamVault({ id: t2.id, url: 'https://not-listed.vault.azure.net' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

// ---------------------------------------------------------------------------------------------

describe('migration from the spaces layout', () => {
  it('turns the storage setting into a team, keeps shared sync state, makes personal items Personal; idempotent', async () => {
    const fixture = join(__dirname, 'fixtures/userdata-v1')
    const ud = tempDir('courier-migrate-')
    cpSync(fixture, ud, { recursive: true })
    const t = await newContainer()
    const data = join(ud, 'data')
    // the cloud side as it was: blobs for the shared items (and a personal one that must survive)
    const put = async (name: string, text: string): Promise<string> => (await t.admin.getBlockBlobClient(name).upload(text, Buffer.byteLength(text))).etag!.replace(/"/g, '')
    const docText = (dir: string, id: string): string => readFileSync(join(data, dir, `${id}.json`), 'utf8')
    const clean = await put('shared/collections/col-shared-clean.json', docText('collections', 'col-shared-clean'))
    const dirtyBase = JSON.parse(docText('collections', 'col-shared-dirty'))
    const dirty = await put('shared/collections/col-shared-dirty.json', serializeCollection({ ...dirtyBase, description: '' }))
    const theirs = await put('shared/collections/col-shared-conflict.json', readFileSync(join(data, 'conflicts', 'collection-col-shared-conflict.json'), 'utf8'))
    const env = await put('shared/environments/env-shared.json', docText('environments', 'env-shared'))
    const deleted = await put('shared/collections/col-shared-deleted.json', serializeCollection(newCollection({ id: 'col-shared-deleted', name: 'Deleted Team Item' })))
    await put(`users/${ID_A.oid}/collections/col-personal.json`, docText('collections', 'col-personal'))
    const statePath = join(data, 'state.json')
    writeFileSync(
      statePath,
      readFileSync(statePath, 'utf8').replace('ETAG_CLEAN', clean).replace('ETAG_DIRTY', dirty).replace('ETAG_CONFLICT_REMOTE', theirs).replace('ETAG_ENV', env).replace('ETAG_DELETED', deleted)
    )
    const settingsPath = join(ud, 'settings.json')
    writeFileSync(settingsPath, readFileSync(settingsPath, 'utf8').replace('https://contosocourier.blob.core.windows.net', ACCOUNT).replace('"container": "courier"', `"container": "${t.name}"`))

    const a = new CourierCore({ userDataDir: ud, fakeIdentity: ID_A })
    await a.init()
    const teams = a.listTeams()
    expect(teams.map((x) => [x.name, x.accountUrl, x.container])).toEqual([['Team', ACCOUNT, t.name]])
    const tid = teams[0].id
    const snap = await a.load()
    const syncOf = (id: string): object | undefined => [...snap.collections.map((c) => [c.collection.id, c.sync] as const), ...snap.environments.map((e) => [e.environment.id, e.sync] as const)].find(([x]) => x === id)?.[1]
    expect(syncOf('col-local')).toEqual({ dirty: false })
    expect(syncOf('col-personal')).toEqual({ dirty: false })
    expect(syncOf('col-personal-conflict')).toEqual({ dirty: false })
    expect(syncOf('env-local')).toEqual({ dirty: false })
    expect(syncOf('col-shared-clean')).toMatchObject({ teamId: tid, etag: clean, dirty: false })
    expect(syncOf('col-shared-dirty')).toMatchObject({ teamId: tid, etag: dirty, dirty: true })
    expect(syncOf('col-shared-new')).toEqual({ teamId: tid, dirty: true })
    expect(syncOf('col-shared-conflict')).toMatchObject({ teamId: tid, dirty: true, conflict: { remoteEtag: theirs, remoteUpdatedBy: 'bob@contoso.test' } })
    expect(syncOf('env-shared')).toMatchObject({ teamId: tid, etag: env, dirty: false })
    expect((await a.getConflict({ kind: 'collection', id: 'col-shared-conflict' })).theirs).toMatchObject({ description: 'theirs' })
    expect(existsSync(join(data, 'conflicts', 'collection-col-personal-conflict.json'))).toBe(false)
    expect((await a.syncStatus()).teams[0].pendingDeletes.map((d) => d.id)).toEqual(['col-shared-deleted'])
    // settings: storage gone, everything else kept; variables and the script grant keep working
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(settings.storage).toBeUndefined()
    expect(a.getSettings().keyVault.vaults).toEqual([{ alias: 'main', url: 'https://contoso-kv.vault.azure.net' }])
    expect(snap.activeEnvironmentId).toBe('env-shared')
    expect(snap.currentValues.collections['col-shared-clean']).toEqual({ token: 'local-only-value' })
    expect((await a.getScriptVaultAccess('col-shared-clean')).allowed).toBe(true)

    // idempotent: a second start changes nothing
    const tree = readTree(ud).map((f) => [f.path, f.content])
    const again = new CourierCore({ userDataDir: ud, fakeIdentity: ID_A })
    await again.init()
    expect(readTree(ud).map((f) => [f.path, f.content])).toEqual(tree)
    expect(again.listTeams().map((x) => x.id)).toEqual([tid])

    // the first sync proves the etags were kept: nothing is re-downloaded, the dirty item uploads with If-Match
    await a.signIn({ mode: 'azure-cli' })
    const r = await a.runSync()
    expect(r.errors).toEqual([])
    expect(r.downloaded).toEqual([])
    expect(r.uploaded.map((x) => x.id).sort()).toEqual(['col-shared-dirty', 'col-shared-new'])
    expect(r.conflicts.map((x) => x.id)).toEqual(['col-shared-conflict'])
    expect(r.deletedRemotely.map((x) => x.id)).toEqual(['col-shared-deleted'])
    expect(a.listTeams()[0]).toMatchObject({ name: 'Team', manifestEtag: null })
    // the old container has no team settings yet: a writer can create them (If-None-Match) and name the team
    const named = await a.updateTeam({ id: tid, name: 'Platform', vaults: [] })
    expect(named).toMatchObject({ name: 'Platform', manifestEtag: expect.any(String) })
    expect(JSON.parse((await t.admin.getBlockBlobClient('courier-team.json').downloadToBuffer()).toString())).toEqual({ version: 1, name: 'Platform', vaults: [] })
    expect(await blobs(t.admin)).toContain(`users/${ID_A.oid}/collections/col-personal.json`)
    expect((await blobs(t.admin)).filter((b) => b.includes('col-personal')).length).toBe(1)
    expect((await a.getScriptVaultAccess('col-shared-clean')).allowed).toBe(true)
  })

  it('takes the team name from the container’s courier-team.json on the first sync', async () => {
    const ud = tempDir('courier-migrate-')
    cpSync(join(__dirname, 'fixtures/userdata-v1'), ud, { recursive: true })
    const t = await newContainer({ name: 'Payments' })
    const settingsPath = join(ud, 'settings.json')
    writeFileSync(settingsPath, readFileSync(settingsPath, 'utf8').replace('https://contosocourier.blob.core.windows.net', ACCOUNT).replace('"container": "courier"', `"container": "${t.name}"`))
    const a = new CourierCore({ userDataDir: ud, fakeIdentity: ID_A })
    await a.init()
    expect(a.listTeams()[0].name).toBe('Team')
    await a.signIn({ mode: 'azure-cli' })
    const r = await a.runSync()
    expect(r.teams.map((x) => [x.name, x.ok])).toEqual([['Payments', true]])
    expect(a.listTeams()[0].name).toBe('Payments')
  })

  it('without a storage account, old shared items become Personal', async () => {
    const ud = tempDir('courier-migrate-')
    cpSync(join(__dirname, 'fixtures/userdata-v1'), ud, { recursive: true })
    const settingsPath = join(ud, 'settings.json')
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'))
    s.storage.accountUrl = ''
    writeFileSync(settingsPath, JSON.stringify(s))
    const a = new CourierCore({ userDataDir: ud })
    await a.init()
    expect(a.listTeams()).toEqual([])
    const snap = await a.load()
    expect(snap.collections.length).toBe(7)
    expect(snap.collections.every((c) => !c.sync.teamId && !c.sync.dirty && !c.sync.etag)).toBe(true)
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).storage).toBeUndefined()
  })
})
