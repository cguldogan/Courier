/**
 * Saved response examples: canonical format (existing files byte-identical), saving a response from
 * a send (masked Key Vault values, sensitive headers left out unless kept, caps), request saves that
 * keep examples, history without examples, the secret scan, and Postman v2.1 response[] import/export.
 * Local echo server + mock Key Vault only.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EXAMPLE_BODY_MAX_CHARS, buildExample } from '../src/shared/examples'
import { exportPostmanCollection, importPostmanCollection } from '../src/shared/postman'
import { normalizeCollection, serializeCollection } from '../src/shared/serialize'
import { MASK } from '../src/shared/variables'
import { newCollection, newRequest, type HttpResponseData, type RequestDef, type ResponseExample } from '../src/shared/types'
import { scanCollection } from '../src/main/secrets-scan'
import type { CourierCore } from '../src/main/core'
import { ID_A, cleanupTempDirs, echoServer, makeCore, mockVault, readTree, tempDir } from './helpers'

const SECRET = 'example-Kv-S3cret-4242'
let vault: Awaited<ReturnType<typeof mockVault>>
let echo: Awaited<ReturnType<typeof echoServer>>

beforeAll(async () => {
  vault = await mockVault({ 'api-key': SECRET })
  echo = await echoServer({
    '/login': (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.setHeader('set-cookie', 'session=abc123; Path=/; HttpOnly')
      res.setHeader('x-request-id', 'r-1')
      res.end(JSON.stringify({ ok: true }))
    },
    '/big': (_req, res) => {
      res.setHeader('content-type', 'text/plain')
      res.end('x'.repeat(EXAMPLE_BODY_MAX_CHARS + 10))
    },
    '/png': (_req, res) => {
      res.setHeader('content-type', 'image/png')
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    }
  })
})
afterAll(async () => {
  await vault.close()
  await echo.close()
  cleanupTempDirs()
})

function response(partial: Partial<HttpResponseData> = {}): HttpResponseData {
  return {
    status: 200,
    statusText: 'OK',
    headers: [['content-type', 'application/json']],
    cookies: [],
    timeMs: 5,
    sizeBytes: 10,
    headersSizeBytes: 10,
    contentType: 'application/json',
    bodyText: '{"a":1}',
    truncated: false,
    finalUrl: 'http://x/a',
    redirects: [],
    ...partial
  }
}

async function vaultCore(userDataDir?: string): Promise<CourierCore> {
  return makeCore({ identity: ID_A, insecureKv: true, userDataDir, settings: { keyVault: { vaults: [{ alias: 'main', url: vault.url }], cacheTtlSeconds: 300 } } })
}

async function withRequest(core: CourierCore, r: RequestDef): Promise<string> {
  const { collection } = await core.createCollection({ name: 'Examples' })
  await core.upsertItem({ collectionId: collection.id, item: r })
  return collection.id
}

async function requestOf(core: CourierCore, collectionId: string, requestId: string): Promise<RequestDef> {
  const c = (await core.load()).collections.find((e) => e.collection.id === collectionId)!.collection
  return c.items.find((i) => i.id === requestId) as RequestDef
}

describe('canonical format', () => {
  it('existing collection files without examples load unchanged and re-serialise byte-identically', () => {
    const dir = join(__dirname, 'fixtures/userdata-v1/data/collections')
    for (const f of readdirSync(dir)) {
      const text = readFileSync(join(dir, f), 'utf8')
      const c = normalizeCollection(JSON.parse(text))
      expect(JSON.stringify(c)).not.toContain('"examples"')
      expect(serializeCollection(c), f).toBe(text)
    }
  })

  it('examples round-trip with a fixed key order, after settings, and are omitted when empty', () => {
    const ex = buildExample(newRequest({ url: '{{baseUrl}}/users/:id', params: [{ key: 'q', value: '1', enabled: true }] }), response(), { name: 'OK' }).example
    const c = newCollection({ id: 'c1', name: 'C', items: [newRequest({ id: 'r1', name: 'Get', examples: [ex] }), newRequest({ id: 'r2', name: 'None' })] })
    const text = serializeCollection(c)
    expect(serializeCollection(normalizeCollection(JSON.parse(text)))).toBe(text)
    const doc = JSON.parse(text)
    expect(Object.keys(doc.items[0]).slice(-2)).toEqual(['settings', 'examples'])
    expect(Object.keys(doc.items[0].examples[0])).toEqual(['id', 'name', 'request', 'response'])
    expect(Object.keys(doc.items[0].examples[0].response)).toEqual(['status', 'statusText', 'headers', 'language', 'body'])
    expect('examples' in doc.items[1]).toBe(false)
  })

  it('normalises hostile examples: caps, bad status, binary paths, duplicate ids across the collection', () => {
    const c = normalizeCollection({
      items: [
        { type: 'request', id: 'a', examples: [{ id: 'x', response: { status: 9999, statusText: 'bad\r\nInjected: 1', body: 'y'.repeat(EXAMPLE_BODY_MAX_CHARS + 5), bodyBase64: '!!notbase64' }, request: { body: { mode: 'binary', filePath: '/private/key.pem' } } }] },
        { type: 'request', id: 'b', examples: Array.from({ length: 150 }, () => ({ id: 'x' })) }
      ]
    })
    const a = c.items[0] as RequestDef
    const ex = a.examples![0]
    expect(ex.response.status).toBe(200)
    expect(ex.response.statusText).not.toMatch(/[\r\n]/)
    expect(ex.response.body.length).toBe(EXAMPLE_BODY_MAX_CHARS)
    expect(ex.response.truncated).toBe(true)
    expect(ex.response.bodyBase64).toBeUndefined()
    expect(ex.request.body).toEqual({ mode: 'binary', filePath: '' })
    const b = c.items[1] as RequestDef
    expect(b.examples).toHaveLength(100)
    const ids = [ex.id, ...b.examples!.map((e) => e.id)]
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('saving a response as an example', () => {
  it('stores the request template and the masked response; Key Vault values never reach the example or any file', async () => {
    const ud = tempDir('courier-ex-ud-')
    const core = await vaultCore(ud)
    const req = newRequest({ name: 'Vaulted', method: 'POST', url: `${echo.url}/echo`, headers: [{ key: 'X-Key', value: '{{vault:main/api-key}}', enabled: true }], body: { mode: 'raw', raw: '{"k":"{{vault:main/api-key}}"}', language: 'json' } })
    const cid = await withRequest(core, req)
    const sent = await core.send({ executionId: 'exec-1', collectionId: cid, requestId: req.id })
    expect(echo.requests.at(-1)?.headers['x-key']).toBe(SECRET)
    expect(sent.response?.bodyText).toContain(MASK)
    const saved = await core.exampleSaveResponse({ executionId: 'exec-1', collectionId: cid, requestId: req.id, name: 'Echoed' })
    expect(saved.example.request.headers[0]).toMatchObject({ key: 'X-Key', value: '{{vault:main/api-key}}' })
    expect(saved.example.request.body).toEqual({ mode: 'raw', language: 'json', raw: '{"k":"{{vault:main/api-key}}"}' })
    expect(saved.example.response.body).toContain(MASK)
    expect(JSON.stringify(saved)).not.toContain(SECRET)
    const r = await requestOf(core, cid, req.id)
    expect(r.examples?.map((e) => e.name)).toEqual(['Echoed'])
    for (const f of readTree(ud)) expect(f.content.includes(SECRET), f.path).toBe(false)
    // History entries never carry examples.
    expect(JSON.stringify(await core.listHistory())).not.toContain('"examples"')
  })

  it('leaves Set-Cookie and other credential headers out unless kept, and says which', async () => {
    const core = await makeCore()
    const req = newRequest({ name: 'Login', url: `${echo.url}/login` })
    const cid = await withRequest(core, req)
    await core.send({ executionId: 'login-1', collectionId: cid, requestId: req.id })
    const a = await core.exampleSaveResponse({ executionId: 'login-1', collectionId: cid, requestId: req.id, name: 'Default' })
    expect(a.stripped.map((h) => h.toLowerCase())).toEqual(['set-cookie'])
    expect(a.example.response.headers.some((h) => h.key.toLowerCase() === 'set-cookie')).toBe(false)
    expect(a.example.response.headers.some((h) => h.key.toLowerCase() === 'x-request-id')).toBe(true)
    const b = await core.exampleSaveResponse({ executionId: 'login-1', collectionId: cid, requestId: req.id, name: 'Kept', keepHeaders: ['Set-Cookie'] })
    expect(b.stripped).toEqual([])
    expect(b.example.response.headers.find((h) => h.key.toLowerCase() === 'set-cookie')?.value).toContain('session=abc123')
    // A kept credential header is a secret-scan finding before upload to a team.
    const c = (await core.load()).collections.find((e) => e.collection.id === cid)!.collection
    const findings = scanCollection(c)
    expect(findings.filter((f) => f.field === 'example.header').map((f) => f.location)).toEqual([expect.stringContaining('example "Kept" › response header "set-cookie"')])
  })

  it('secret-typed collection and environment values echoed by the server are masked in the example', async () => {
    const ud = tempDir('courier-ex-sec-')
    const core = await makeCore({ userDataDir: ud })
    const { collection } = await core.createCollection({ name: 'Secretive' })
    await core.saveCollection({ ...collection, variables: [{ key: 'colPw', value: '', enabled: true, type: 'secret' }] })
    await core.setCurrentValues({ scope: 'collection', id: collection.id, values: { colPw: 'col-Secret-Pw-31337' } })
    const env = (await core.createEnvironment({ name: 'Env' })).environment
    await core.saveEnvironment({ ...env, variables: [{ key: 'envTok', value: '', enabled: true, type: 'secret' }] })
    await core.setCurrentValues({ scope: 'environment', id: env.id, values: { envTok: 'env-Secret-Tok-4711' } })
    const req = newRequest({ name: 'Echo', url: `${echo.url}/echo`, headers: [{ key: 'X-A', value: '{{colPw}}', enabled: true }, { key: 'X-B', value: '{{envTok}}', enabled: true }] })
    await core.upsertItem({ collectionId: collection.id, item: req })
    await core.send({ executionId: 'sec-1', collectionId: collection.id, requestId: req.id, environmentId: env.id })
    expect(echo.requests.at(-1)?.headers['x-a']).toBe('col-Secret-Pw-31337')
    const saved = await core.exampleSaveResponse({ executionId: 'sec-1', collectionId: collection.id, requestId: req.id, name: 'Masked' })
    const text = JSON.stringify(saved.example)
    expect(text).not.toContain('col-Secret-Pw-31337')
    expect(text).not.toContain('env-Secret-Tok-4711')
    expect(saved.example.response.body).toContain(MASK)
    const docs = readTree(join(ud, 'data')).map((f) => f.content).join('\n')
    expect(docs).not.toContain('col-Secret-Pw-31337')
    expect(docs).not.toContain('env-Secret-Tok-4711')
  })

  it('caps large text bodies, keeps small binary bodies as base64, refuses unknown executions', async () => {
    const core = await makeCore()
    const big = newRequest({ name: 'Big', url: `${echo.url}/big` })
    const png = newRequest({ name: 'Png', url: `${echo.url}/png` })
    const cid = await withRequest(core, big)
    await core.upsertItem({ collectionId: cid, item: png })
    await core.send({ executionId: 'big-1', collectionId: cid, requestId: big.id })
    await core.send({ executionId: 'png-1', collectionId: cid, requestId: png.id })
    const b = await core.exampleSaveResponse({ executionId: 'big-1', collectionId: cid, requestId: big.id, name: 'Big' })
    expect(b.example.response.body.length).toBe(EXAMPLE_BODY_MAX_CHARS)
    expect(b.example.response.truncated).toBe(true)
    expect(b.truncatedNote).toMatch(/cut to/)
    const p = await core.exampleSaveResponse({ executionId: 'png-1', collectionId: cid, requestId: png.id, name: 'Image' })
    expect(Buffer.from(p.example.response.bodyBase64!, 'base64')).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    expect(p.example.response.body).toBe('')
    await expect(core.exampleSaveResponse({ executionId: 'nope', collectionId: cid, requestId: png.id, name: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('a request save without examples (an editor tab) keeps them; edit, duplicate, delete work by id', async () => {
    const core = await makeCore()
    const req = newRequest({ name: 'Get', url: `${echo.url}/a` })
    const cid = await withRequest(core, req)
    await core.send({ executionId: 'e-a', collectionId: cid, requestId: req.id })
    const { example } = await core.exampleSaveResponse({ executionId: 'e-a', collectionId: cid, requestId: req.id, name: 'One' })
    // The tab's draft (no `examples`) is saved: examples stay.
    await core.upsertItem({ collectionId: cid, item: { ...req, name: 'Renamed' } })
    expect((await requestOf(core, cid, req.id)).examples?.map((e) => e.id)).toEqual([example.id])
    const edited = await core.exampleSave({ collectionId: cid, requestId: req.id, example: { ...example, name: 'Edited', response: { ...example.response, status: 201, body: '{"edited":true}' } } })
    expect(edited).toMatchObject({ id: example.id, name: 'Edited', response: { status: 201, body: '{"edited":true}' } })
    const copy = await core.exampleDuplicate({ collectionId: cid, requestId: req.id, exampleId: example.id })
    expect(copy.name).toBe('Edited Copy')
    expect(copy.id).not.toBe(example.id)
    await core.exampleDelete({ collectionId: cid, requestId: req.id, exampleId: example.id })
    expect((await requestOf(core, cid, req.id)).examples?.map((e) => e.id)).toEqual([copy.id])
    await core.exampleDelete({ collectionId: cid, requestId: req.id, exampleId: copy.id })
    expect('examples' in (await requestOf(core, cid, req.id))).toBe(false)
    // Duplicating the collection re-ids examples.
    await core.exampleSave({ collectionId: cid, requestId: req.id, example: { ...example, id: 'ex-fixed' } })
    const dup = await core.duplicate('collection', cid)
    const dupReq = (dup.doc as { items: RequestDef[] }).items[0]
    expect(dupReq.examples?.[0].id).not.toBe('ex-fixed')
  })
})

describe('Postman v2.1 response[]', () => {
  const pm = {
    info: { name: 'PM', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      {
        name: 'Get user',
        request: { method: 'GET', url: { raw: '{{baseUrl}}/users/:id', host: ['{{baseUrl}}'], path: ['users', ':id'], variable: [{ key: 'id', value: '1' }] } },
        response: [
          {
            id: 'pm-ex-1',
            name: 'Found',
            originalRequest: { method: 'GET', header: [{ key: 'Accept', value: 'application/json' }], url: { raw: '{{baseUrl}}/users/1?verbose=true', host: ['{{baseUrl}}'], path: ['users', '1'], query: [{ key: 'verbose', value: 'true' }] } },
            status: 'OK',
            code: 200,
            _postman_previewlanguage: 'json',
            header: [{ key: 'Content-Type', value: 'application/json' }],
            cookie: [],
            body: '{"id":1}'
          },
          { name: 'Missing', status: 'Not Found', code: 404, header: 'Content-Type: text/plain\nX-Trace: t1', body: 'nope' }
        ]
      }
    ]
  }

  it('imports examples (with or without originalRequest) and exports them back', () => {
    const c = importPostmanCollection(pm).value
    const r = c.items[0] as RequestDef
    expect(r.examples).toHaveLength(2)
    const [found, missing] = r.examples as ResponseExample[]
    expect(found).toMatchObject({ id: 'pm-ex-1', name: 'Found', request: { method: 'GET', url: '{{baseUrl}}/users/1', params: [{ key: 'verbose', value: 'true', enabled: true }] }, response: { status: 200, statusText: 'OK', language: 'json', body: '{"id":1}' } })
    expect(missing.request.url).toBe('{{baseUrl}}/users/:id')
    expect(missing.response.headers.map((h) => h.key)).toEqual(['Content-Type', 'X-Trace'])
    const out = exportPostmanCollection(c) as { item: { response: Record<string, unknown>[] }[] }
    const res = out.item[0].response
    expect(res).toHaveLength(2)
    expect(res[0]).toMatchObject({ id: 'pm-ex-1', name: 'Found', status: 'OK', code: 200, _postman_previewlanguage: 'json', body: '{"id":1}', header: [{ key: 'Content-Type', value: 'application/json' }] })
    expect((res[0].originalRequest as { url: { raw: string } }).url.raw).toBe('{{baseUrl}}/users/1?verbose=true')
    // Round trip through Postman format keeps the examples' content.
    const again = importPostmanCollection(JSON.parse(JSON.stringify(out))).value.items[0] as RequestDef
    expect(again.examples?.map((e) => [e.name, e.response.status, e.response.body])).toEqual([
      ['Found', 200, '{"id":1}'],
      ['Missing', 404, 'nope']
    ])
  })

  it('binary examples travel in _courier_bodyBase64', () => {
    const ex = buildExample(newRequest({ url: 'http://x/img' }), response({ contentType: 'image/png', bodyText: '', bodyBase64: 'iVBORw==' }), { name: 'Img' }).example
    const out = exportPostmanCollection(newCollection({ items: [newRequest({ examples: [ex] })] })) as { item: { response: Record<string, unknown>[] }[] }
    expect(out.item[0].response[0]).toMatchObject({ body: '', _courier_bodyBase64: 'iVBORw==' })
    const back = importPostmanCollection(JSON.parse(JSON.stringify(out))).value.items[0] as RequestDef
    expect(back.examples?.[0].response.bodyBase64).toBe('iVBORw==')
  })
})
