/**
 * Key Vault against a local mock HTTPS server that speaks the secrets REST API, including the
 * 401 bearer challenge. Challenge-resource verification is relaxed only via the test hook.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decodeJwtClaims } from '../src/main/azure'
import { CourierCore } from '../src/main/core'
import { MASK, encodeQueryComponent } from '../src/shared/variables'
import { newRequest, type RequestDef } from '../src/shared/types'
import { ID_A, cleanupTempDirs, echoServer, httpsServer, listen, makeCore, readBody, readTree, type Listening } from './helpers'

const NASTY = 'p@ss w/+=&"é'
const API_KEY = 'kv-API-k3y-123'

interface Hit {
  method: string
  path: string
  authorized: boolean
  aud?: string
}
const hits: Hit[] = []
const secrets = new Map<string, { version: string; value: string }[]>([
  ['api-key', [{ version: 'v1', value: API_KEY }]],
  ['db-password', [{ version: 'old1', value: 'old-password' }, { version: 'v2', value: NASTY }]]
])
let vault: Listening
let echo: Awaited<ReturnType<typeof echoServer>>

function bundle(base: string, name: string, s: { version: string; value: string }): object {
  return { value: s.value, id: `${base}/secrets/${name}/${s.version}`, attributes: { enabled: true, created: 1700000000, updated: 1700000000, recoveryLevel: 'Recoverable' } }
}

async function vaultHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'https://vault.local')
  const body = await readBody(req)
  const auth = req.headers.authorization
  const hit: Hit = { method: req.method ?? '', path: url.pathname, authorized: Boolean(auth) }
  hits.push(hit)
  res.setHeader('content-type', 'application/json; charset=utf-8')
  if (!auth?.startsWith('Bearer ')) {
    res.statusCode = 401
    res.setHeader('www-authenticate', `Bearer authorization="https://login.microsoftonline.com/${ID_A.tid}", resource="https://vault.azure.net"`)
    res.end(JSON.stringify({ error: { code: 'Unauthorized', message: 'AKV10000: Request is missing a Bearer or PoP token.' } }))
    return
  }
  hit.aud = String(decodeJwtClaims(auth.slice(7)).aud)
  if (hit.aud !== 'https://vault.azure.net') {
    res.statusCode = 401
    res.end(JSON.stringify({ error: { code: 'Unauthorized', message: 'bad audience' } }))
    return
  }
  const base = `https://${req.headers.host}`
  const parts = url.pathname.split('/').filter(Boolean) // ['secrets', name?, version?]
  if (parts[0] !== 'secrets') {
    res.statusCode = 404
    res.end('{}')
    return
  }
  const name = parts[1]
  if (name === 'forbidden-secret') {
    res.statusCode = 403
    res.end(JSON.stringify({ error: { code: 'Forbidden', message: 'Caller is not authorized to perform action on resource.', innererror: { code: 'ForbiddenByRbac' } } }))
    return
  }
  if (req.method === 'GET' && !name) {
    res.end(JSON.stringify({ value: [...secrets.keys()].map((n) => ({ id: `${base}/secrets/${n}`, attributes: { enabled: true, created: 1700000000, updated: 1700000000 } })), nextLink: null }))
    return
  }
  if (req.method === 'PUT' && name) {
    const { value } = JSON.parse(body.toString('utf8')) as { value: string }
    const list = secrets.get(name) ?? []
    const s = { version: `v${list.length + 1}x`, value }
    secrets.set(name, [...list, s])
    res.end(JSON.stringify(bundle(base, name, s)))
    return
  }
  const versions = secrets.get(name)
  const s = versions && (parts[2] ? versions.find((v) => v.version === parts[2]) : versions.at(-1))
  if (!s) {
    res.statusCode = 404
    res.end(JSON.stringify({ error: { code: 'SecretNotFound', message: `A secret with (name/id) ${name} was not found in this key vault.` } }))
    return
  }
  res.end(JSON.stringify(bundle(base, name, s)))
}

beforeAll(async () => {
  vault = await listen(httpsServer((req, res) => void vaultHandler(req, res)), 'https')
  echo = await echoServer()
})
afterAll(async () => {
  await vault.close()
  await echo.close()
  cleanupTempDirs()
})

async function vaultCore(opts: { insecureKv?: boolean } = {}): Promise<CourierCore> {
  return makeCore({
    identity: ID_A,
    insecureKv: opts.insecureKv ?? true,
    settings: { keyVault: { vaults: [{ alias: 'main', url: vault.url }], cacheTtlSeconds: 300 } }
  })
}
const secretGets = (name: string): number => hits.filter((h) => h.method === 'GET' && h.path.startsWith(`/secrets/${name}`) && h.authorized).length

/** Every encoding a secret could leak in. */
function variants(secret: string): string[] {
  return [secret, encodeURIComponent(secret), encodeQueryComponent(secret), JSON.stringify(secret).slice(1, -1), Buffer.from(`svc:${secret}`).toString('base64')]
}

describe('Key Vault references at send time', () => {
  it('uses the 401 challenge, then a bearer token for https://vault.azure.net', async () => {
    const core = await vaultCore()
    const before = hits.length
    const v = await core.vaultGet({ name: 'api-key' })
    expect(v.value).toBe(API_KEY)
    const mine = hits.slice(before)
    expect(mine[0]).toMatchObject({ authorized: false })
    expect(mine.find((h) => h.authorized)).toMatchObject({ aud: 'https://vault.azure.net' })
  })

  it('without the test hook the SDK refuses a challenge whose resource does not match the vault host', async () => {
    const core = await vaultCore({ insecureKv: false })
    const err = await core.vaultGet({ name: 'api-key' }).then(() => null, (e: unknown) => e as { code: string; message: string })
    expect(err).toMatchObject({ code: 'VAULT_ERROR', message: expect.stringMatching(/challenge resource 'vault.azure.net' does not match/) })
  })

  it('resolves refs in URL, params, path variables, headers, body, basic auth and vault-typed variables; masks everything persisted or returned', async () => {
    const core = await vaultCore()
    const { environment } = await core.createEnvironment({ name: 'Env' })
    await core.saveEnvironment({ ...environment, variables: [{ key: 'apiKey', value: 'main/api-key', enabled: true, type: 'vault' }] })
    await core.setActiveEnvironment(environment.id)
    const { collection } = await core.createCollection({ name: 'Vaulted' })
    const request: RequestDef = newRequest({
      id: 'vaulted',
      name: 'Vaulted request',
      method: 'POST',
      url: `${echo.url}/items/:pw`,
      params: [{ key: 'pw', value: '{{vault:db-password}}', enabled: true }],
      pathVariables: [{ key: 'pw', value: '{{vault:main/db-password}}', enabled: true }],
      headers: [{ key: 'X-Api-Key', value: '{{apiKey}}', enabled: true }],
      body: { mode: 'raw', language: 'json', raw: '{"pw":"{{vault:db-password@v2}}"}' },
      auth: { type: 'basic', username: 'svc', password: '{{vault:db-password}}' },
      preRequestScript: "pm.vault.get('api-key').then(v => { console.log('script sees', v); pm.environment.set('leak', v) })",
      testScript: "console.log(pm.response.text()); pm.test('status', () => pm.response.to.have.status(200))"
    })
    await core.upsertItem({ collectionId: collection.id, item: request })
    // pm.vault.get needs this machine's permission for the collection (see script-vault-gate.test.ts)
    await core.setScriptVaultAccess({ id: collection.id, allowed: true })

    const result = await core.send({ collectionId: collection.id, requestId: 'vaulted' })
    expect(result.error).toBeUndefined()
    expect(result.tests[0].passed).toBe(true)

    // the live request carried the real values
    const wire = echo.requests.at(-1)!
    expect(wire.url).toBe(`/items/${encodeURIComponent(NASTY)}?pw=${encodeQueryComponent(NASTY)}`)
    expect(wire.headers['x-api-key']).toBe(API_KEY)
    expect(wire.headers.authorization).toBe('Basic ' + Buffer.from(`svc:${NASTY}`).toString('base64'))
    expect(wire.body).toBe(`{"pw":"${NASTY}"}`)

    // nothing returned to the renderer contains a secret, in any encoding
    const returned = JSON.stringify(result)
    for (const s of [...variants(NASTY), ...variants(API_KEY)]) expect(returned, s).not.toContain(s)
    expect(result.request.headers.find(([k]) => k === 'X-Api-Key')![1]).toBe(MASK)
    expect(result.request.headers.find(([k]) => k === 'Authorization')![1]).toBe(`Basic ${MASK}`)
    expect(result.console.map((c) => c.message)).toContain(`script sees ${MASK}`)
    expect(result.console.some((c) => c.message.includes(MASK) && c.source.phase === 'test')).toBe(true)

    // nothing written under userData contains a secret (history, variables, cookies, cache…)
    const files = readTree(core.store.root)
    expect(files.some((f) => f.path.endsWith('history.json'))).toBe(true)
    for (const f of files) for (const s of [...variants(NASTY), ...variants(API_KEY)]) expect(f.content.includes(s), `${f.path} contains ${s}`).toBe(false)
    const hist = (await core.listHistory())[0]
    expect(hist.url).toContain(MASK)
    expect((await core.load()).currentValues.environments[environment.id].leak).toBe(MASK)

    // snippets never contain secrets
    const snippet = await core.snippet({ collectionId: collection.id, requestId: 'vaulted', language: 'curl' })
    expect(snippet).toContain(MASK)
    for (const s of [...variants(NASTY), ...variants(API_KEY)]) expect(snippet).not.toContain(s)
  })

  it('caches resolved values in memory for the TTL; clearCache forces a refetch', async () => {
    const core = await vaultCore()
    const req = newRequest({ url: `${echo.url}/cache`, headers: [{ key: 'K', value: '{{vault:api-key}}', enabled: true }] })
    const n = secretGets('api-key')
    await core.send({ draft: req })
    await core.send({ draft: req })
    expect(secretGets('api-key') - n).toBe(1)
    core.vault.clearCache()
    await core.send({ draft: req })
    expect(secretGets('api-key') - n).toBe(2)
  })

  it('not-found and 403 give clear errors and the request is not sent', async () => {
    const core = await vaultCore()
    const n = echo.requests.length
    const missing = await core.send({ draft: newRequest({ url: `${echo.url}/x`, headers: [{ key: 'K', value: '{{vault:nope}}', enabled: true }] }) })
    expect(missing.error?.code).toBe('NOT_FOUND')
    expect(missing.error?.message).toMatch(/secret "nope" was not found in vault "main"/i)
    const denied = await core.send({ draft: newRequest({ url: `${echo.url}/x`, headers: [{ key: 'K', value: '{{vault:forbidden-secret}}', enabled: true }] }) })
    expect(denied.error?.code).toBe('FORBIDDEN')
    expect(denied.error?.message).toMatch(/Key Vault Secrets User/)
    const unknownAlias = await core.send({ draft: newRequest({ url: `${echo.url}/x`, headers: [{ key: 'K', value: '{{vault:other/x}}', enabled: true }] }) })
    expect(unknownAlias.error?.code).toBe('NOT_CONFIGURED')
    expect(echo.requests.length).toBe(n)
  })
})

describe('Key Vault browser API', () => {
  it('lists names, reveals on demand, sets a new version (and invalidates the cache)', async () => {
    const core = await vaultCore()
    const names = (await core.vaultList()).map((s) => s.name)
    expect(names).toEqual(expect.arrayContaining(['api-key', 'db-password']))
    expect((await core.vaultGet({ name: 'db-password', version: 'old1' })).value).toBe('old-password')
    expect(await core.vault.resolve('api-key')).toBe(API_KEY)
    const set = await core.vaultSet({ name: 'api-key', value: 'rotated-value' })
    expect(set.name).toBe('api-key')
    expect(await core.vault.resolve('main/api-key')).toBe('rotated-value')
    await expect(core.vaultGet({ name: 'forbidden-secret' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(core.vaultSet({ name: 'bad name!', value: 'x' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    const noVault = await makeCore({ identity: ID_A })
    await expect(noVault.vaultList()).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
  })
})
