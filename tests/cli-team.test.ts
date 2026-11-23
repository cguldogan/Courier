/**
 * `courier run` with a team collection downloaded read-only from Azurite with the fake identity: by
 * name, by id, ambiguous and missing names, team environments, and the team file's Key Vaults, which
 * are used only for hosts approved with --approve-vault. Nothing may be uploaded or changed.
 */
import type { ContainerClient } from '@azure/storage-blob'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeCredential } from '../src/main/azure'
import { createContainerClient } from '../src/main/blobsync'
import { serializeCollection, serializeEnvironment } from '../src/shared/serialize'
import { newCollection, newEnvironment, newRequest, type Collection, type Environment } from '../src/shared/types'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ID_A, cleanupTempDirs, echoServer, mockVault, seedManifest, tempDir } from './helpers'
import { runCli } from './cli-helpers'

const ACCOUNT = process.env.COURIER_TEST_AZURITE as string
const TEAM_SECRET = 'team-Kv-Secret-31d7'

let srv: Awaited<ReturnType<typeof echoServer>>
let vault: Awaited<ReturnType<typeof mockVault>>
let container: string
let admin: ContainerClient
let orders: Collection
let staging: Environment

async function put(path: string, text: string): Promise<void> {
  await admin.getBlockBlobClient(path).upload(text, Buffer.byteLength(text))
}
async function snapshot(): Promise<string[]> {
  const out: string[] = []
  for await (const b of admin.listBlobsFlat()) out.push(`${b.name}@${b.properties.etag}`)
  return out.sort()
}
const ok = "pm.test('ok', () => pm.response.to.have.status(200))"

beforeAll(async () => {
  srv = await echoServer()
  vault = await mockVault({ 'api-key': TEAM_SECRET })
  container = `cli${Math.random().toString(36).slice(2, 12)}`
  admin = createContainerClient(ACCOUNT, container, new FakeCredential(ID_A))
  await admin.create()
  await seedManifest(ACCOUNT, container, { name: 'Payments', vaults: [{ alias: 'teamkv', url: vault.url }] })
  orders = newCollection({
    id: 'col-orders',
    name: 'Orders',
    items: [newRequest({ name: 'List', url: '{{base}}/orders', testScript: ok }), newRequest({ name: 'Secret', url: '{{base}}/kv', headers: [{ key: 'X-Key', value: '{{vault:teamkv/api-key}}', enabled: true }], testScript: ok })]
  })
  await put(`shared/collections/${orders.id}.json`, serializeCollection(orders))
  for (const id of ['col-dup1', 'col-dup2']) await put(`shared/collections/${id}.json`, serializeCollection(newCollection({ id, name: 'Dup', items: [newRequest({ name: 'R', url: '{{base}}/dup' })] })))
  staging = newEnvironment({ id: 'env-staging', name: 'Staging', variables: [{ key: 'base', value: srv.url, enabled: true, type: 'default' }] })
  await put(`shared/environments/${staging.id}.json`, serializeEnvironment(staging))
})
afterAll(async () => {
  await srv.close()
  await vault.close()
  cleanupTempDirs()
})

const team = (): string[] => ['--team-url', ACCOUNT, '--team-container', container]
const host = (): string => new URL(vault.url).host

describe('courier run: team collections (read-only download)', () => {
  it('runs a team collection by name with a team environment by name; nothing in the container changes', async () => {
    const before = await snapshot()
    const i = srv.requests.length
    // Case-insensitive name match. The second request needs the unapproved team vault (checked below).
    const r = await runCli(['run', 'orders', ...team(), '-e', 'Staging', '-r', 'json'])
    expect(r.code).toBe(1)
    const j = JSON.parse(r.stdout)
    expect(j.collection).toMatchObject({ id: 'col-orders', name: 'Orders', source: 'team', team: { accountUrl: ACCOUNT, container, name: 'Payments' } })
    expect(j.environment).toEqual({ id: 'env-staging', name: 'Staging' })
    expect(j.executions[0]).toMatchObject({ name: 'List', status: 200, passed: true })
    expect(srv.requests.slice(i).map((x) => x.url)).toEqual(['/orders'])
    expect(await snapshot()).toEqual(before)
  })

  it('by id; a team vault is refused until its host is approved with --approve-vault', async () => {
    const i = srv.requests.length
    const refused = await runCli(['run', 'col-orders', ...team(), '-e', 'env-staging', '-r', 'json'])
    expect(refused.code).toBe(1)
    const e = JSON.parse(refused.stdout).executions[1]
    expect(e.error.code).toBe('VAULT_NOT_APPROVED')
    expect(e.error.message).toBe(`Team "Payments" lists Key Vault "teamkv" on host ${host()}, which is not approved on this machine. Pass --approve-vault ${host()} if you trust it.`)
    expect(vault.hits.length).toBe(0)
    expect(srv.requests.slice(i).map((x) => x.url)).toEqual(['/orders'])

    const j = srv.requests.length
    const approved = await runCli(['run', 'col-orders', ...team(), '-e', 'Staging', '--approve-vault', host()])
    expect(approved.stderr).toBe('')
    expect(approved.code).toBe(0)
    expect(srv.requests.slice(j).map((x) => [x.url, x.headers['x-key']])).toEqual([['/orders', undefined], ['/kv', TEAM_SECRET]])
    expect(approved.stdout).toContain('Courier ')
    expect(approved.stdout).toContain('team "Payments"')
    expect(approved.stdout).not.toContain(TEAM_SECRET)

    const other = await runCli(['run', 'col-orders', ...team(), '-e', 'Staging', '--approve-vault', 'elsewhere.vault.azure.net'])
    expect(other.code).toBe(1)
    expect(other.stderr).toContain("courier: warning: --approve-vault elsewhere.vault.azure.net: the team's courier-team.json lists no Key Vault on that host.")
  })

  it('-e names an existing local file: the file is used; otherwise it is a team environment name', async () => {
    const work = tempDir('courier-cli-team-env-')
    writeFileSync(join(work, 'Staging'), serializeEnvironment(newEnvironment({ name: 'Local File Env', variables: [{ key: 'base', value: srv.url, enabled: true, type: 'default' }] })))
    const local = await runCli(['run', 'Orders', ...team(), '-e', 'Staging', '-r', 'json'], { cwd: work })
    expect(JSON.parse(local.stdout).environment.name).toBe('Local File Env')
    const r = await runCli(['run', 'Orders', ...team(), '-e', 'tests/fixtures/does-not-exist.json'])
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/\[NOT_FOUND\]: No environment named or with id "tests\/fixtures\/does-not-exist\.json" in container/)
  })

  it('ambiguous and unknown names exit 2 and list the candidates', async () => {
    const amb = await runCli(['run', 'Dup', ...team()])
    expect(amb.code).toBe(2)
    expect(amb.stderr).toContain('courier: error [INVALID_ARGUMENT]: 2 team collections are named "Dup". Pass the id instead:\n  - "Dup" (id col-dup1)\n  - "Dup" (id col-dup2)')
    const missing = await runCli(['run', 'Invoices', ...team()])
    expect(missing.code).toBe(2)
    expect(missing.stderr).toMatch(/\[NOT_FOUND\]: No collection named or with id "Invoices" in container "cli\w+" \(https:\/\/127\.0\.0\.1:\d+\/devstoreaccount1\)\. Available:\n {2}- "Dup" \(id col-dup1\)\n {2}- "Dup" \(id col-dup2\)\n {2}- "Orders" \(id col-orders\)\n$/)
    const env = await runCli(['run', 'Orders', ...team(), '-e', 'Prod'])
    expect(env.code).toBe(2)
    expect(env.stderr).toMatch(/No environment named or with id "Prod".* Available:\n {2}- "Staging" \(id env-staging\)/s)
  })

  it('a missing container or a bad location is a configuration error (exit 2)', async () => {
    const gone = await runCli(['run', 'Orders', '--team-url', ACCOUNT, '--team-container', 'no-such-container'])
    expect(gone.code).toBe(2)
    expect(gone.stderr).toMatch(/error \[CONTAINER_NOT_FOUND\]: Container "no-such-container" was not found/)
    const http = await runCli(['run', 'Orders', '--team-url', 'http://acct.blob.core.windows.net', '--team-container', 'x1y'])
    expect(http).toMatchObject({ code: 2 })
    expect(http.stderr).toMatch(/must start with https/)
  })

  it('a container without courier-team.json still runs (no team vaults)', async () => {
    const name = `cli${Math.random().toString(36).slice(2, 12)}`
    const c = createContainerClient(ACCOUNT, name, new FakeCredential(ID_A))
    await c.create()
    const col = newCollection({ id: 'plain', name: 'Plain', items: [newRequest({ name: 'Ping', url: `${srv.url}/ping`, testScript: ok })] })
    const text = serializeCollection(col)
    await c.getBlockBlobClient('shared/collections/plain.json').upload(text, Buffer.byteLength(text))
    const r = await runCli(['run', 'Plain', '--team-url', ACCOUNT, '--team-container', name])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`team "${name}"`)
  })
})
