// End-to-end run of the BUILT command-line runner (out/cli/courier.cjs). `npm run e2e` builds first and
// runs this after drive.mjs:
//   arch -arm64 node e2e/cli.mjs
// Starts the same local infrastructure as drive.mjs (echo server, Azurite over HTTPS with --oauth basic,
// mock Key Vault), seeds a team container over REST with a fake bearer token, and spawns the CLI with
// the fake identity. Nothing touches a real Azure resource. Exits non-zero on any failed check.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT, createContainer, fakeJwt, listBlobs, makeCert, startAzurite, startEcho, startMockVault } from './infra.mjs'

const CLI = join(ROOT, 'out', 'cli', 'courier.cjs')
const ALICE = { name: 'Alice Example', upn: 'alice@contoso.test', oid: 'aaaaaaaa-0000-0000-0000-000000000001', tid: '7e57e57e-0000-0000-0000-000000000001' }
const KV_SECRET = 'cli-e2e-Kv-Secret-5d1e'
const ENV_SECRET = 'cli-e2e-Env-Secret-a9f0'
const CONTAINER = 'courier-cli-e2e'

const failures = []
let current = ''
function check(name, cond, detail) {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${!cond && detail ? `  — ${String(detail).slice(0, 600)}` : ''}`)
  if (!cond) failures.push(`${current}: ${name}`)
  return cond
}
function section(name) {
  current = name
  console.log(`\n== ${name}`)
}

/** Upload a block blob over REST with a fake bearer token (no keys, no SDK). */
async function putBlob(accountUrl, container, name, text, caFile) {
  const url = new URL(`${accountUrl}/${container}/${name}`)
  const body = Buffer.from(text)
  await new Promise((res, rej) => {
    const req = request(url, {
      method: 'PUT',
      ca: readFileSync(caFile),
      headers: {
        authorization: `Bearer ${fakeJwt(ALICE, 'https://storage.azure.com/.default')}`,
        'x-ms-version': '2021-12-02',
        'x-ms-date': new Date().toUTCString(),
        'x-ms-blob-type': 'BlockBlob',
        'content-type': 'application/json',
        'content-length': body.length
      }
    }, (r) => {
      r.resume()
      r.on('end', () => (r.statusCode === 201 ? res() : rej(new Error(`put blob ${name}: HTTP ${r.statusCode}`))))
    })
    req.on('error', rej)
    req.end(body)
  })
}

function runCli(args, env = {}, cwd = work) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...baseEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function walk(dir) {
  const out = []
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

const pki = makeCert()
const echo = await startEcho()
const azurite = await startAzurite(pki)
const vault = await startMockVault(pki, ALICE.tid, { 'api-key': KV_SECRET })
const vaultHost = new URL(vault.url).host
const work = mkdtempSync(join(tmpdir(), 'courier-cli-e2e-'))
const home = mkdtempSync(join(tmpdir(), 'courier-cli-e2e-home-'))
const baseEnv = {
  NODE_EXTRA_CA_CERTS: pki.cert,
  COURIER_FAKE_IDENTITY: JSON.stringify(ALICE),
  COURIER_KV_INSECURE_CHALLENGE: '1',
  HOME: home,
  USERPROFILE: home,
  COURIER_USER_DATA: join(home, 'userdata')
}

try {
  section('1. help and version')
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const v = await runCli(['--version'])
  check('--version prints the package version, exit 0', v.code === 0 && v.stdout === `${pkg.version}\n`, JSON.stringify(v))
  const h = await runCli(['help', 'run'])
  check('help run documents --approve-vault and the exit codes', h.code === 0 && h.stdout.includes('--approve-vault <host>') && h.stdout.includes('Exit codes:'), h.stdout.slice(0, 200))
  const u = await runCli(['run'])
  check('missing collection: exit 2 with a usage message on stderr', u.code === 2 && u.stderr.startsWith('courier: Missing <collection>'), JSON.stringify(u))

  section('2. Postman collection file with a secret environment variable; JSON and JUnit exports')
  writeFileSync(join(work, 'shop.postman_collection.json'), JSON.stringify({
    info: { name: 'E2E Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      { name: 'Products', item: [
        { name: 'List', request: { method: 'GET', url: '{{base}}/products?key={{apiKey}}' },
          event: [{ listen: 'test', script: { exec: ["pm.test('status 200', () => pm.response.to.have.status(200))", "console.log(pm.response.text())"] } }] }
      ] },
      { name: 'Create', request: { method: 'POST', url: '{{base}}/products', header: [{ key: 'X-Key', value: '{{apiKey}}' }], body: { mode: 'raw', raw: '{"name":"{{name}}"}' } },
        event: [{ listen: 'test', script: { exec: ["pm.test('echoes ' + pm.iterationData.get('name'), () => pm.expect(pm.response.json().body).to.include(pm.iterationData.get('name')))"] } }] }
    ]
  }))
  writeFileSync(join(work, 'local.postman_environment.json'), JSON.stringify({ name: 'Local', values: [{ key: 'base', value: echo.url, enabled: true }, { key: 'apiKey', value: ENV_SECRET, type: 'secret', enabled: true }] }))
  writeFileSync(join(work, 'rows.csv'), 'name\nWidget\n"Gadget, deluxe"\n')
  const n0 = echo.requests.length
  const p = await runCli(['run', 'shop.postman_collection.json', '-e', 'local.postman_environment.json', '-d', 'rows.csv', '-r', 'console,json,junit', '--reporter-json-export', 'reports/run.json', '--reporter-junit-export', 'reports/junit.xml'])
  check('exit 0, nothing on stderr', p.code === 0 && p.stderr === '', JSON.stringify({ code: p.code, stderr: p.stderr }))
  check('2 data rows × 2 requests were sent in order', echo.requests.slice(n0).map((r) => `${r.method} ${r.url.split('?')[0]}`).join(',') === 'GET /products,POST /products,GET /products,POST /products')
  check('the secret went on the wire', echo.requests[n0]?.url.includes(ENV_SECRET) && echo.requests[n0 + 1]?.headers['x-key'] === ENV_SECRET)
  const runJson = JSON.parse(readFileSync(join(work, 'reports/run.json'), 'utf8'))
  check('JSON report: format, 4 executions, 4 tests passed', runJson.format === 'courier.run-report/v1' && runJson.executions.length === 4 && runJson.stats.tests.passed === 4 && runJson.result === 'passed', JSON.stringify(runJson.stats))
  const junit = readFileSync(join(work, 'reports/junit.xml'), 'utf8')
  check('JUnit report: 4 suites, escaped data-row test name', (junit.match(/<testsuite /g) ?? []).length === 4 && junit.includes('name="echoes Gadget, deluxe"') && junit.startsWith('<?xml version="1.0" encoding="UTF-8"?>'))
  check('console: summary table and result', /│ +requests │ +4 │ +0 │/.test(p.stdout) && p.stdout.endsWith('Result: passed\n'), p.stdout.slice(-400))
  const leaks = [p.stdout, p.stderr, JSON.stringify(runJson), junit].filter((s) => s.includes(ENV_SECRET)).length
  check('the secret variable value is in no output or export file (masked as ••••)', leaks === 0 && p.stdout.includes('key=••••'))

  section('3. exit codes 1 and 2')
  writeFileSync(join(work, 'bad.postman_collection.json'), JSON.stringify({
    info: { name: 'Bad', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{ name: 'Wrong', request: { method: 'GET', url: `${echo.url}/x` }, event: [{ listen: 'test', script: { exec: ["pm.test('is 201', () => pm.response.to.have.status(201))"] } }] }]
  }))
  const f = await runCli(['run', 'bad.postman_collection.json', '--bail'])
  check('a failed test: exit 1, listed under Failures', f.code === 1 && f.stdout.includes('1. Wrong · test "is 201"'), f.stdout.slice(-300))
  const m = await runCli(['run', 'nope.json'])
  check('a missing file: exit 2, NOT_FOUND on stderr', m.code === 2 && m.stderr.includes('error [NOT_FOUND]: Collection file not found: nope.json'), m.stderr)

  section('4. team collection from Azurite (read-only), team environment, team Key Vault approval, script gate')
  await createContainer(azurite.url, CONTAINER, ALICE, pki.cert)
  await putBlob(azurite.url, CONTAINER, 'courier-team.json', JSON.stringify({ version: 1, name: 'E2E Team', vaults: [{ alias: 'teamkv', url: vault.url }] }), pki.cert)
  const teamCollection = {
    schema: 'courier.collection/v1', id: 'cli-e2e-orders', name: 'Orders', description: '', auth: { type: 'none' }, variables: [], preRequestScript: '', testScript: '',
    items: [
      { type: 'request', id: 'r-list', name: 'List orders', description: '', method: 'GET', url: '{{base}}/orders', params: [], pathVariables: [], headers: [{ key: 'X-Key', value: '{{vault:teamkv/api-key}}', enabled: true }], body: { mode: 'none' }, auth: { type: 'inherit' }, preRequestScript: '', testScript: "pm.test('ok', () => pm.response.to.have.status(200))", settings: {} },
      { type: 'request', id: 'r-script', name: 'Script reads vault', description: '', method: 'GET', url: '{{base}}/script', params: [], pathVariables: [], headers: [], body: { mode: 'none' }, auth: { type: 'inherit' }, preRequestScript: "pm.vault.get('teamkv/api-key').then((v) => console.log('got', v))", testScript: '', settings: {} }
    ]
  }
  await putBlob(azurite.url, CONTAINER, 'shared/collections/cli-e2e-orders.json', JSON.stringify(teamCollection), pki.cert)
  await putBlob(azurite.url, CONTAINER, 'shared/environments/cli-e2e-env.json', JSON.stringify({ schema: 'courier.environment/v1', id: 'cli-e2e-env', name: 'Team Env', variables: [{ key: 'base', value: echo.url, enabled: true, type: 'default' }] }), pki.cert)
  const blobsBefore = await listBlobs(azurite.url, CONTAINER, ALICE, pki.cert)
  const team = ['--team-url', azurite.url, '--team-container', CONTAINER, '-e', 'Team Env']
  const refused = await runCli(['run', 'Orders', ...team, '-r', 'json'])
  const rj = JSON.parse(refused.stdout || '{}')
  check('without --approve-vault: VAULT_NOT_APPROVED naming the host and the flag, exit 1', refused.code === 1 && rj.executions?.[0]?.error?.code === 'VAULT_NOT_APPROVED' && rj.executions[0].error.message.includes(`--approve-vault ${vaultHost}`), refused.stdout.slice(0, 600) + refused.stderr)
  check('no Key Vault call was made for the unapproved vault', vault.hits.length === 0, JSON.stringify(vault.hits))
  const v0 = echo.requests.length
  const approved = await runCli(['run', 'cli-e2e-orders', ...team, '--approve-vault', vaultHost, '-r', 'json'])
  const aj = JSON.parse(approved.stdout || '{}')
  check('with --approve-vault: the vault value is sent', echo.requests.slice(v0).find((r) => r.url === '/orders')?.headers['x-key'] === KV_SECRET)
  check('the team collection came from the team (by id) with the team environment (by name)', aj.collection?.source === 'team' && aj.collection.team?.name === 'E2E Team' && aj.environment?.name === 'Team Env', JSON.stringify(aj.collection))
  check('the script reading Key Vault is blocked without --allow-script-vault (VAULT_SCRIPT_BLOCKED, exit 1)', approved.code === 1 && aj.executions?.[1]?.error?.code === 'VAULT_SCRIPT_BLOCKED' && aj.executions[1].error.message.includes('--allow-script-vault'), JSON.stringify(aj.executions?.[1]))
  const allowed = await runCli(['run', 'Orders', ...team, '--approve-vault', vaultHost, '--allow-script-vault', '--scripts-sha256', aj.collection?.scriptsSha256 ?? '', '-r', 'console,junit', '--reporter-junit-export', 'reports/team.xml'])
  check('with --allow-script-vault pinned to the scripts hash: exit 0', allowed.code === 0 && allowed.stderr === '', allowed.stdout.slice(-500) + allowed.stderr)
  check('the script saw the value, but the console shows it masked', allowed.stdout.includes('┊ log: got ••••'), allowed.stdout.slice(0, 800))
  const teamOutputs = [refused.stdout, refused.stderr, approved.stdout, approved.stderr, allowed.stdout, allowed.stderr, readFileSync(join(work, 'reports/team.xml'), 'utf8')]
  check('the Key Vault value is in no output or export file', teamOutputs.every((s) => !s.includes(KV_SECRET)))
  const blobsAfter = await listBlobs(azurite.url, CONTAINER, ALICE, pki.cert)
  check('nothing was uploaded to the team container', JSON.stringify(blobsAfter) === JSON.stringify(blobsBefore), JSON.stringify(blobsAfter))
  const amb = await runCli(['run', 'Nope', ...team])
  check('an unknown team collection: exit 2 listing what is available', amb.code === 2 && amb.stderr.includes('- "Orders" (id cli-e2e-orders)'), amb.stderr)

  section('5. nothing written outside the working directory')
  check('the temporary HOME and COURIER_USER_DATA stayed empty', walk(home).length === 0, walk(home).join(', '))
  const files = walk(work).map((x) => x.slice(work.length + 1)).sort()
  check('the working directory holds only the inputs and the requested reports', JSON.stringify(files) === JSON.stringify(['bad.postman_collection.json', 'local.postman_environment.json', 'reports/junit.xml', 'reports/run.json', 'reports/team.xml', 'rows.csv', 'shop.postman_collection.json']), files.join(', '))
} catch (err) {
  failures.push(`${current}: exception ${err?.message ?? err}`)
  console.error(err)
} finally {
  azurite.stop()
  await echo.stop()
  await vault.stop()
  pki.cleanup()
  rmSync(work, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\n${failures.length} CLI check(s) failed:\n - ${failures.join('\n - ')}`)
  process.exit(1)
}
console.log('\ne2e cli: all checks passed')
process.exit(0)
