/**
 * Team sync against Azurite (`--oauth basic`, HTTPS with a test-generated self-signed cert, fake
 * unsigned-JWT credential). Independent clients = separate userData dirs; one container = one team.
 * Multi-team behaviour (isolation, moves, manifests, migration) is in teams.test.ts.
 */
import { AnonymousCredential, BlobServiceClient, type ContainerClient } from '@azure/storage-blob'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeCredential } from '../src/main/azure'
import { createContainerClient } from '../src/main/blobsync'
import type { CourierCore } from '../src/main/core'
import { serializeCollection } from '../src/shared/serialize'
import type { Collection } from '../src/shared/types'
import { ID_A, ID_B, cleanupTempDirs, httpsServer, listen, makeCore, seedManifest, teamClient } from './helpers'

const ACCOUNT = process.env.COURIER_TEST_AZURITE as string
let container = ''
let admin: ContainerClient

beforeEach(async () => {
  container = `c${Math.random().toString(36).slice(2, 12)}`
  admin = createContainerClient(ACCOUNT, container, new FakeCredential(ID_A))
  await admin.create()
  await seedManifest(ACCOUNT, container, { name: 'Platform' })
})
afterAll(cleanupTempDirs)

async function client(id = ID_A): Promise<CourierCore & { teamId: string }> {
  const { core, teamId } = await teamClient({ identity: id, accountUrl: ACCOUNT, container })
  return Object.assign(core, { teamId })
}
async function blobNames(): Promise<string[]> {
  const out: string[] = []
  for await (const b of admin.listBlobsFlat({ prefix: 'shared/' })) out.push(b.name)
  return out.sort()
}
async function blobText(name: string): Promise<string> {
  return (await admin.getBlockBlobClient(name).downloadToBuffer()).toString('utf8')
}
async function col(core: CourierCore, id: string): Promise<Collection | undefined> {
  return (await core.load()).collections.find((e) => e.collection.id === id)?.collection
}

describe('Azurite OAuth', () => {
  it('rejects requests without a bearer token (no keys/SAS anywhere)', async () => {
    const anon = new BlobServiceClient(ACCOUNT, new AnonymousCredential(), { retryOptions: { maxTries: 1 } }).getContainerClient(container)
    await expect(anon.listBlobsFlat().next()).rejects.toMatchObject({ statusCode: expect.any(Number) })
  })
})

describe('team sync', () => {
  it('uploads from client A and syncs into client B (different identity)', async () => {
    const a = await client(ID_A)
    const { collection } = await a.createCollection({ name: 'Orders', teamId: a.teamId })
    await a.saveCollection({ ...collection, description: 'from A', variables: [{ key: 'token', value: 'secret-value', enabled: true, type: 'secret' }] })
    const { environment } = await a.createEnvironment({ name: 'Staging', teamId: a.teamId })
    const r = await a.runSync()
    expect(r.errors).toEqual([])
    expect(r.teams).toEqual([{ teamId: a.teamId, name: 'Platform', ok: true }])
    expect(r.uploaded.map((x) => x.name).sort()).toEqual(['Orders', 'Staging'])
    expect(r.uploaded.every((x) => x.teamId === a.teamId)).toBe(true)
    expect(await blobNames()).toEqual([`shared/collections/${collection.id}.json`, `shared/environments/${environment.id}.json`])
    const text = await blobText(`shared/collections/${collection.id}.json`)
    expect(text).not.toContain('secret-value')
    const doc = JSON.parse(text)
    expect(doc.updatedBy).toBe('alice@contoso.test')
    expect(text).toBe(serializeCollection(doc)) // canonical bytes

    const b = await client(ID_B)
    const rb = await b.runSync()
    expect(rb.downloaded.map((x) => x.name).sort()).toEqual(['Orders', 'Staging'])
    const got = await col(b, collection.id)
    expect(got?.description).toBe('from A')
    expect((await b.load()).collections[0].sync).toMatchObject({ teamId: b.teamId, dirty: false })
    // second sync is a no-op
    const again = await b.runSync()
    expect([...again.uploaded, ...again.downloaded, ...again.conflicts]).toEqual([])
  })
})

async function conflictSetup(): Promise<{ a: CourierCore & { teamId: string }; b: CourierCore & { teamId: string }; id: string }> {
  const a = await client(ID_A)
  const b = await client(ID_B)
  const { collection } = await a.createCollection({ name: 'Contested', teamId: a.teamId })
  await a.runSync()
  await b.runSync()
  await a.saveCollection({ ...(await col(a, collection.id))!, description: 'A wins?' })
  expect((await a.runSync()).uploaded).toHaveLength(1)
  await b.saveCollection({ ...(await col(b, collection.id))!, description: 'B wins?' })
  const rb = await b.runSync()
  expect(rb.conflicts.map((x) => x.id)).toEqual([collection.id])
  const detail = await b.getConflict({ kind: 'collection', id: collection.id })
  expect((detail.mine as Collection).description).toBe('B wins?')
  expect((detail.theirs as Collection).description).toBe('A wins?')
  expect(detail.remoteUpdatedBy).toBe('alice@contoso.test')
  expect(detail.ref.teamId).toBe(b.teamId)
  expect((await b.syncStatus()).conflicts).toHaveLength(1)
  expect((await b.syncStatus()).teams[0].conflicts).toHaveLength(1)
  return { a, b, id: collection.id }
}

describe('conflicts', () => {
  it('resolve "theirs" takes the remote version', async () => {
    const { b, id } = await conflictSetup()
    const res = await b.resolveConflict({ kind: 'collection', id, resolution: 'theirs' })
    expect(res.report.errors).toEqual([])
    expect((await col(b, id))!.description).toBe('A wins?')
    expect((await b.syncStatus()).conflicts).toEqual([])
    expect((await b.syncStatus()).pending).toBe(0)
  })

  it('resolve "mine" overwrites the remote (If-Match on the remote etag)', async () => {
    const { a, b, id } = await conflictSetup()
    const res = await b.resolveConflict({ kind: 'collection', id, resolution: 'mine' })
    expect(res.report.uploaded.map((x) => x.id)).toEqual([id])
    expect(JSON.parse(await blobText(`shared/collections/${id}.json`)).description).toBe('B wins?')
    expect((await a.runSync()).downloaded.map((x) => x.id)).toEqual([id])
    expect((await col(a, id))!.description).toBe('B wins?')
  })

  it('resolve "both" keeps mine as a copy and takes theirs for the original', async () => {
    const { a, b, id } = await conflictSetup()
    const res = await b.resolveConflict({ kind: 'collection', id, resolution: 'both' })
    expect(res.copy?.name).toBe('Contested (my copy)')
    expect(res.copy?.teamId).toBe(b.teamId)
    expect(res.report.uploaded.map((x) => x.id)).toEqual([res.copy!.id])
    expect((await col(b, id))!.description).toBe('A wins?')
    expect((await col(b, res.copy!.id))!.description).toBe('B wins?')
    const ra = await a.runSync()
    expect(ra.downloaded.map((x) => x.name)).toEqual(['Contested (my copy)'])
  })
})

describe('remote deletes', () => {
  it('drops a clean local copy; keeps a dirty one as new and re-uploads it on the next sync', async () => {
    const a = await client(ID_A)
    const b = await client(ID_B)
    const one = (await a.createCollection({ name: 'Clean', teamId: a.teamId })).collection
    const two = (await a.createCollection({ name: 'Dirty', teamId: a.teamId })).collection
    await a.runSync()
    await b.runSync()
    await b.saveCollection({ ...(await col(b, two.id))!, description: 'local edit' })

    await a.deleteDoc('collection', one.id)
    await a.deleteDoc('collection', two.id)
    expect(await blobNames()).toEqual([]) // deleted immediately with If-Match

    const rb = await b.runSync()
    expect(rb.removedLocally.map((x) => x.id)).toEqual([one.id])
    expect(rb.notices.map((n) => n.ref?.id)).toEqual([two.id])
    expect(rb.notices[0].message).toMatch(/deleted remotely/)
    const kept = (await b.load()).collections.find((e) => e.collection.id === two.id)!
    expect(kept.sync).toMatchObject({ dirty: true })
    expect(kept.sync.etag).toBeUndefined()
    const rb2 = await b.runSync()
    expect(rb2.uploaded.map((x) => x.id)).toEqual([two.id])
  })

  it('a delete based on a stale etag does not delete newer remote changes', async () => {
    const a = await client(ID_A)
    const b = await client(ID_B)
    const { collection } = await a.createCollection({ name: 'Racy', teamId: a.teamId })
    await a.runSync()
    await b.runSync()
    await b.saveCollection({ ...(await col(b, collection.id))!, description: 'newer' })
    await b.runSync()
    await a.deleteDoc('collection', collection.id) // If-Match with A's old etag → 412, stays queued
    expect(await blobNames()).toEqual([`shared/collections/${collection.id}.json`])
    const ra = await a.runSync()
    expect(ra.notices[0].message).toMatch(/changed remotely after you deleted it/)
    expect((await col(a, collection.id))!.description).toBe('newer')
  })
})

describe('secret scan before a team upload', () => {
  it('holds back team items with literal credentials until acknowledged', async () => {
    const a = await client(ID_A)
    const { collection } = await a.createCollection({ name: 'Leaky', teamId: a.teamId })
    await a.saveCollection({ ...collection, auth: { type: 'bearer', token: 'eyJliteral.token.value' } })
    const r = await a.runSync()
    expect(r.uploaded).toEqual([])
    expect(r.blocked).toHaveLength(1)
    expect(r.blocked[0].findings[0]).toMatchObject({ field: 'bearer.token', preview: 'eyJ…ue' })
    expect(await blobNames()).toEqual([])
    const r2 = await a.runSync({ acknowledgeWarnings: true })
    expect(r2.uploaded.map((x) => x.id)).toEqual([collection.id])

    const local = (await a.createCollection({ name: 'Local leaky' })).collection
    await a.saveCollection({ ...local, auth: { type: 'basic', username: 'u', password: 'literal' } })
    const m = await a.move('collection', { id: local.id, teamId: a.teamId })
    expect(m.moved).toBe(false)
    expect(m.warnings[0].field).toBe('basic.password')
    expect((await a.move('collection', { id: local.id, teamId: a.teamId, acknowledgeWarnings: true })).moved).toBe(true)
  })
})

describe('error mapping', () => {
  it('missing container → CONTAINER_NOT_FOUND (join, and a sync after the container is gone)', async () => {
    const a = await makeCore({ identity: ID_A })
    await expect(a.probeTeam({ accountUrl: ACCOUNT, container: 'does-not-exist' })).rejects.toMatchObject({ code: 'CONTAINER_NOT_FOUND' })
    await expect(a.joinTeam({ accountUrl: ACCOUNT, container: 'does-not-exist', name: 'Ghost' })).rejects.toMatchObject({ code: 'CONTAINER_NOT_FOUND' })
    const b = await client(ID_A)
    await b.createCollection({ name: 'x', teamId: b.teamId })
    await admin.delete()
    expect(await b.testTeamConnection(b.teamId)).toMatchObject({ ok: false, code: 'CONTAINER_NOT_FOUND' })
    const r = await b.runSync()
    expect(r.teams).toMatchObject([{ teamId: b.teamId, ok: false, error: { code: 'CONTAINER_NOT_FOUND' } }])
    expect(r.errors[0]).toMatchObject({ teamId: b.teamId, code: 'CONTAINER_NOT_FOUND' })
    expect(r.errors[0].message).toMatch(new RegExp(`Container "${container}" was not found`))
    expect((await b.syncStatus()).teams[0].lastError?.code).toBe('CONTAINER_NOT_FOUND')
  })

  it('403 → FORBIDDEN naming the RBAC roles (simulated storage endpoint)', async () => {
    const srv = await listen(
      httpsServer((_req, res) => {
        res.statusCode = 403
        res.setHeader('x-ms-error-code', 'AuthorizationPermissionMismatch')
        res.setHeader('content-type', 'application/xml')
        res.end('<?xml version="1.0" encoding="utf-8"?><Error><Code>AuthorizationPermissionMismatch</Code><Message>This request is not authorized to perform this operation using this permission.</Message></Error>')
      }),
      'https'
    )
    try {
      const a = await makeCore({ identity: ID_A })
      const err = await a.probeTeam({ accountUrl: `${srv.url}/acct`, container: 'ccc' }).then(() => null, (e: { code: string; message: string }) => e)
      expect(err?.code).toBe('FORBIDDEN')
      expect(err?.message).toMatch(/Storage Blob Data Contributor/)
      expect(err?.message).toMatch(/Storage Blob Data Reader/)
    } finally {
      await srv.close()
    }
  })

  it('network failure, not signed in, no team, invalid locations', async () => {
    const a = await makeCore({ identity: ID_A })
    await expect(a.probeTeam({ accountUrl: 'https://127.0.0.1:1/acct', container: 'ccc' })).rejects.toMatchObject({ code: 'NETWORK' })
    await expect(a.probeTeam({ accountUrl: 'http://example.com', container: 'ccc' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(a.probeTeam({ accountUrl: ACCOUNT, container: 'Bad_Name' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(a.runSync()).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
    const anon = await makeCore()
    await expect(anon.probeTeam({ accountUrl: ACCOUNT, container })).rejects.toMatchObject({ code: 'NOT_SIGNED_IN' })
    const b = await client(ID_A)
    await b.signOut()
    await expect(b.runSync()).rejects.toMatchObject({ code: 'NOT_SIGNED_IN' })
    expect(await b.testTeamConnection(b.teamId)).toMatchObject({ ok: false, code: 'NOT_SIGNED_IN' })
  })
})

describe('races during sync (upload intercepted)', () => {
  type Upload = (...args: unknown[]) => Promise<unknown>
  function hookUpload(core: CourierCore & { teamId: string }, before: (doc: { id: string }) => Promise<void>): void {
    const engine = core.engine(core.teamId) as unknown as { upload: Upload }
    const orig = engine.upload.bind(engine)
    engine.upload = async (...args: unknown[]) => {
      await before(args[2] as { id: string })
      return orig(...args)
    }
  }

  it('an upload rejected by If-Match (412) becomes a precondition-failed conflict', async () => {
    const a = await client(ID_A)
    const b = await client(ID_B)
    const { collection } = await a.createCollection({ name: 'Race', teamId: a.teamId })
    await a.runSync()
    await b.runSync()
    await b.saveCollection({ ...(await col(b, collection.id))!, description: 'b' })
    hookUpload(b, async () => {
      // someone else writes between B's listing and B's upload
      const sneaky = serializeCollection({ ...(await col(a, collection.id))!, description: 'sneaky', updatedBy: 'carol@contoso.test' })
      await admin.getBlockBlobClient(`shared/collections/${collection.id}.json`).upload(sneaky, Buffer.byteLength(sneaky))
    })
    const r = await b.runSync()
    expect(r.uploaded).toEqual([])
    expect(r.conflicts.map((x) => x.id)).toEqual([collection.id])
    const entry = (await b.load()).collections[0]
    expect(entry.sync.conflict?.reason).toBe('precondition-failed')
    expect(entry.collection.description).toBe('b')
    const detail = await b.getConflict({ kind: 'collection', id: collection.id })
    expect((detail.theirs as Collection).description).toBe('sneaky')
    expect(detail.remoteUpdatedBy).toBe('carol@contoso.test')
  })

  it('edits saved while an upload is in flight are kept (still dirty, rebased on the new etag)', async () => {
    const a = await client(ID_A)
    const { collection } = await a.createCollection({ name: 'Busy', teamId: a.teamId })
    await a.runSync()
    await a.saveCollection({ ...(await col(a, collection.id))!, description: 'v2' })
    let once = false
    hookUpload(a, async () => {
      if (once) return
      once = true
      await a.saveCollection({ ...(await col(a, collection.id))!, description: 'v3' })
    })
    const r = await a.runSync()
    expect(r.uploaded.map((x) => x.id)).toEqual([collection.id])
    expect(JSON.parse(await blobText(`shared/collections/${collection.id}.json`)).description).toBe('v2')
    const entry = (await a.load()).collections[0]
    expect(entry.collection.description).toBe('v3')
    expect(entry.sync.dirty).toBe(true)
    const props = await admin.getBlockBlobClient(`shared/collections/${collection.id}.json`).getProperties()
    expect(entry.sync.etag).toBe(props.etag!.replace(/"/g, ''))
    const r2 = await a.runSync()
    expect(r2.conflicts).toEqual([])
    expect(r2.uploaded.map((x) => x.id)).toEqual([collection.id])
    expect(JSON.parse(await blobText(`shared/collections/${collection.id}.json`)).description).toBe('v3')
  })

  it('a write 403 on one item is reported per item and does not stop downloads; discard restores the remote version', async () => {
    const a = await client(ID_A)
    const b = await client(ID_B)
    const x = (await a.createCollection({ name: 'X', teamId: a.teamId })).collection
    await a.runSync()
    await b.runSync()
    const y = (await a.createCollection({ name: 'Y', teamId: a.teamId })).collection
    await a.runSync()
    await b.saveCollection({ ...(await col(b, x.id))!, description: 'reader edit' })
    hookUpload(b, async () => {
      throw Object.assign(new Error('This request is not authorized to perform this operation using this permission.'), { statusCode: 403, code: 'AuthorizationPermissionMismatch' })
    })
    const r = await b.runSync()
    expect(r.errors.map((e) => [e.ref?.id, e.code, e.teamId])).toEqual([[x.id, 'FORBIDDEN', b.teamId]])
    expect(r.errors[0].message).toMatch(/Storage Blob Data Contributor/)
    expect(r.downloaded.map((d) => d.id)).toEqual([y.id])
    const d = await b.discardLocalChanges({ kind: 'collection', id: x.id })
    expect(d.downloaded.map((e) => e.id)).toEqual([x.id])
    const back = (await b.load()).collections.find((e) => e.collection.id === x.id)!
    expect(back.collection.description).toBe('')
    expect(back.sync.dirty).toBe(false)
  })
})
