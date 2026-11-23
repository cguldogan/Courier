import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { importPostmanCollection } from '../src/shared/postman'
import { normalizeCollection, serializeCollection, serializeEnvironment } from '../src/shared/serialize'
import { slugify, uniqueSlug } from '../src/shared/slug'
import type { Collection } from '../src/shared/types'
import { LocalCache } from '../src/main/workspace'
import { scanCollection, scanEnvironment } from '../src/main/secrets-scan'
import { cleanupTempDirs, makeCore, readTree, tempDir } from './helpers'

const sample = importPostmanCollection(JSON.parse(readFileSync(join(__dirname, 'fixtures/postman-sample.postman_collection.json'), 'utf8'))).value

afterAll(cleanupTempDirs)

/** Recursively reverse key order — same data, different insertion order. */
function shuffleKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(shuffleKeys)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, shuffleKeys(x)]))
  return v
}

describe('canonical document format', () => {
  it('is deterministic: same doc → byte-identical output, independent of key order', () => {
    const a = serializeCollection(sample)
    const b = serializeCollection(sample)
    const c = serializeCollection(shuffleKeys(sample) as Collection)
    expect(a).toBe(b)
    expect(c).toBe(a)
    expect(a.endsWith('}\n')).toBe(true)
    expect(a.split('\n')[1]).toBe('  "schema": "courier.collection/v1",')
    // fixed key order at the top
    expect(Object.keys(JSON.parse(a))).toEqual(['schema', 'id', 'name', 'description', 'auth', 'variables', 'preRequestScript', 'testScript', 'items'])
  })

  it('round-trips through normalize without changes', () => {
    const text = serializeCollection(sample)
    expect(serializeCollection(normalizeCollection(JSON.parse(text)))).toBe(text)
  })

  it('never writes secret-typed variable values', () => {
    const text = serializeEnvironment({ id: 'env1', name: 'E', variables: [{ key: 'pw', value: 'hunter2', enabled: true, type: 'secret' }] })
    expect(text).not.toContain('hunter2')
  })

  it('tolerates garbage input and re-ids duplicate ids', () => {
    const c = normalizeCollection({ id: '../../etc', name: 7, items: [{ type: 'request', id: 'dup' }, { type: 'folder', id: 'dup', items: [{ id: 'dup' }] }, null] })
    expect(c.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(c.name).toBe('7')
    const ids = [c.items[0].id, c.items[1].id, (c.items[1] as { items: { id: string }[] }).items[0].id]
    expect(new Set(ids).size).toBe(3)
  })

  it('slugs are lowercase, safe and unique case-insensitively', () => {
    expect(slugify('Hello, Wörld! / API')).toBe('hello-world-api')
    expect(slugify('***')).toBe('untitled')
    expect(slugify('CON')).toBe('con-x')
    expect(uniqueSlug('orders', ['Orders', 'orders-2'])).toBe('orders-3')
  })
})

describe('local cache (userData/data)', () => {
  it('writes canonical bytes, writing twice is byte-identical, rename keeps the same file', async () => {
    const dir = tempDir()
    const cache = new LocalCache(dir, null)
    await cache.init()
    await cache.put('collection', sample, { dirty: false })
    const file = join(dir, 'collections', `${sample.id}.json`)
    const first = readFileSync(file, 'utf8')
    await cache.put('collection', sample, { dirty: false })
    expect(readFileSync(file, 'utf8')).toBe(first)
    expect(first).toBe(serializeCollection(sample))
    // Personal items are never dirty, whatever the caller passes
    await cache.put('collection', sample, { dirty: true, teamId: 'someone-else' })
    expect((await cache.require('collection', sample.id)).sync).toEqual({ dirty: false })

    const team = new LocalCache(join(dir, 'teams', 'team-1'), 'team-1')
    await team.init()
    await team.put('collection', { ...sample, name: 'Renamed' }, { dirty: true })
    await team.put('collection', { ...sample, name: 'Renamed again' }, { dirty: true, etag: 'e1', teamId: 'ignored' })
    expect(readdirSync(join(dir, 'teams', 'team-1', 'collections'))).toEqual([`${sample.id}.json`])
    const back = await team.require('collection', sample.id)
    expect(back.doc.name).toBe('Renamed again')
    expect(back.sync).toEqual({ dirty: true, etag: 'e1', teamId: 'team-1' })
    expect(JSON.parse(readFileSync(join(dir, 'teams', 'team-1', 'state.json'), 'utf8')).items[`collection:${sample.id}`]).toEqual({ dirty: true, etag: 'e1' })
  })

  it('skips unreadable files and rejects path-like ids', async () => {
    const dir = tempDir()
    const cache = new LocalCache(dir, null)
    await cache.init()
    writeFileSync(join(dir, 'collections', 'broken.json'), '{not json')
    expect(await cache.list('collection')).toEqual([])
    await expect(cache.get('collection', '../x')).rejects.toThrow(/Invalid id/)
  })

  it('core: save moves secret values to current values, cloud saves mark dirty, upsert/move items', async () => {
    const core = await makeCore()
    const { collection } = await core.createCollection({ name: 'C' })
    collection.variables = [{ key: 'token', value: 'very-secret-token', enabled: true, type: 'secret' }]
    collection.items = sample.items
    const saved = await core.saveCollection(collection)
    expect(saved.collection.variables[0].value).toBe('')
    const snap = await core.load()
    expect(snap.currentValues.collections[collection.id]).toEqual({ token: 'very-secret-token' })
    const files = readTree(core.cache.root).filter((f) => f.content.includes('very-secret-token'))
    expect(files).toEqual([])

    // upsert a request into a folder, then move it to the root at index 0
    const orders = saved.collection.items.find((i) => i.name === 'Orders')!
    const r = await core.upsertItem({ collectionId: collection.id, parentId: orders.id, item: { type: 'request', id: 'new-req', name: 'Added' } as never })
    expect((r.collection.items.find((i) => i.id === orders.id) as { items: { id: string }[] }).items.at(-1)!.id).toBe('new-req')
    const moved = await core.moveItem({ collectionId: collection.id, itemId: 'new-req', parentId: null, index: 0 })
    expect(moved.collection.items[0].id).toBe('new-req')
    await expect(core.moveItem({ collectionId: collection.id, itemId: orders.id, parentId: orders.id, index: 0 })).rejects.toThrow(/itself/)
    const del = await core.deleteItem({ collectionId: collection.id, itemId: 'new-req' })
    expect(del.collection.items.some((i) => i.id === 'new-req')).toBe(false)
    expect(del.sync.dirty).toBe(false) // Personal items are never dirty
  })
})

describe('secret scan (before a team upload)', () => {
  it('flags literal bearer/basic/apikey/oauth secrets and secret headers, ignores {{var}} and vault refs', () => {
    const c: Collection = {
      ...sample,
      auth: { type: 'bearer', token: 'eyJhbGciOiJIUzI1NiJ9.payload.sig' },
      variables: [
        { key: 'apiKey', value: 'abc123literal', enabled: true, type: 'default' },
        { key: 'apiKeyRef', value: 'kv/x', enabled: true, type: 'vault' },
        { key: 'baseUrl', value: 'https://x', enabled: true, type: 'default' }
      ],
      items: [
        { type: 'request', id: 'r1', name: 'basic', description: '', method: 'GET', url: '', params: [], pathVariables: [], headers: [{ key: 'Authorization', value: 'Bearer literal-token-123', enabled: true }, { key: 'X-Api-Key', value: '{{apiKey}}', enabled: true }], body: { mode: 'none' }, auth: { type: 'basic', username: 'u', password: 'P@ssw0rd!' }, preRequestScript: '', testScript: '', settings: {} },
        { type: 'request', id: 'r2', name: 'apikey', description: '', method: 'GET', url: '', params: [], pathVariables: [], headers: [], body: { mode: 'none' }, auth: { type: 'apikey', key: 'k', value: 'sk_live_123', in: 'query' }, preRequestScript: '', testScript: '', settings: {} },
        { type: 'request', id: 'r3', name: 'oauth', description: '', method: 'GET', url: '', params: [], pathVariables: [], headers: [], body: { mode: 'none' }, auth: { type: 'oauth2', grantType: 'client_credentials', accessTokenUrl: 'https://t', clientId: 'id', clientSecret: 'cs-literal', scope: '', audience: '', clientAuthentication: 'header' }, preRequestScript: '', testScript: '', settings: {} },
        { type: 'request', id: 'r4', name: 'templated', description: '', method: 'GET', url: '', params: [], pathVariables: [], headers: [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true }], body: { mode: 'none' }, auth: { type: 'basic', username: 'u', password: '{{vault:kv/pw}}' }, preRequestScript: '', testScript: '', settings: {} }
      ]
    }
    const f = scanCollection(c)
    expect(f.map((x) => x.field).sort()).toEqual(['apikey.value', 'basic.password', 'bearer.token', 'header', 'oauth2.clientSecret', 'variable'])
    expect(f.every((x) => !x.preview.includes('P@ssw0rd!') && x.suggestion.includes('vault'))).toBe(true)
    expect(f.find((x) => x.field === 'basic.password')!.location).toContain('basic')
    expect(scanEnvironment({ id: 'e', name: 'E', variables: [{ key: 'client_secret', value: 'xyz-literal', enabled: true, type: 'default' }, { key: 'password', value: '{{other}}', enabled: true, type: 'default' }] })).toHaveLength(1)
  })
})

describe('shared code purity', () => {
  it('src/shared imports no Node or Electron APIs', () => {
    const dir = join(__dirname, '../src/shared')
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8')
      expect(src, f).not.toMatch(/from ['"](node:|fs|path|os|crypto|child_process|electron)/)
      expect(src, f).not.toMatch(/\b(Buffer|process\.|require\()/)
    }
  })
  // src/main and its sub-folders (e.g. src/main/auth).
  const mainFiles = (): { name: string; src: string }[] =>
    readTree(join(__dirname, '../src/main')).map((f) => ({ name: f.path.slice(f.path.indexOf('src/main/') + 'src/main/'.length), src: f.content }))
  it('engine modules (everything except index.ts/ipc.ts) do not import electron', () => {
    const files = mainFiles()
    expect(files.some((f) => f.name.startsWith('auth/'))).toBe(true)
    for (const f of files.filter((x) => !['index.ts', 'ipc.ts'].includes(x.name))) expect(f.src, f.name).not.toMatch(/from ['"]electron['"]/)
  })
  it('the command-line runner (src/cli) never imports electron', () => {
    const files = readTree(join(__dirname, '../src/cli'))
    expect(files.length).toBeGreaterThan(3)
    for (const f of files) expect(f.content, f.path).not.toMatch(/from ['"]electron['"]|require\(['"]electron['"]\)/)
  })
  it('app code never uses storage keys, SAS or connection strings', () => {
    for (const f of mainFiles()) expect(f.src, f.name).not.toMatch(/StorageSharedKeyCredential|AccountKey=|fromConnectionString|generateSasUrl|SharedAccessSignature=/)
  })
})
