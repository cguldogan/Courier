/**
 * `courier run` against local servers, in-process: Courier and Postman files, environments, globals,
 * data files and iterations, --folder, --bail, setNextRequest and its loop guard, auth types, Key
 * Vault references through the mock vault, the script → Key Vault gate, and secret masking in every
 * output. No real Azure: the fake identity and the Key Vault test hook are always set.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scriptsDigest } from '../src/cli/run'
import { serializeCollection, serializeEnvironment } from '../src/shared/serialize'
import { newCollection, newEnvironment, newFolder, newRequest, type Auth, type Collection, type RequestDef } from '../src/shared/types'
import { cleanupTempDirs, echoServer, mockVault, tempDir } from './helpers'
import { runCli } from './cli-helpers'

const KV_SECRET = 'kv-Cli-S3cret-4b1d'
const ENV_SECRET = 'env-Secret-Value-77c2'
const CC_TOKEN = 'cc-Access-Token-9e3f'

let srv: Awaited<ReturnType<typeof echoServer>>
let vault: Awaited<ReturnType<typeof mockVault>>
let dir: string

beforeAll(async () => {
  srv = await echoServer({
    '/token': (_req, res, body) => {
      res.setHeader('content-type', 'application/json')
      const form = new URLSearchParams(body.toString('utf8'))
      if (form.get('client_secret') !== 'cc-secret') {
        res.statusCode = 401
        res.end(JSON.stringify({ error: 'invalid_client' }))
        return
      }
      res.end(JSON.stringify({ access_token: CC_TOKEN, expires_in: 3600, token_type: 'Bearer' }))
    },
    '/status/500': (_req, res) => {
      res.statusCode = 500
      res.end('boom')
    }
  })
  vault = await mockVault({ 'api-key': KV_SECRET })
  dir = tempDir('courier-cli-')
})
afterAll(async () => {
  await srv.close()
  await vault.close()
  cleanupTempDirs()
})

let n = 0
function file(name: string, content: string | object): string {
  const p = join(dir, `${++n}-${name}`)
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  return p
}
const courierFile = (c: Collection): string => file('collection.courier.json', serializeCollection(c))
const req = (name: string, path: string, testScript = '', extra: Partial<Parameters<typeof newRequest>[0]> = {}) =>
  newRequest({ name, url: `${srv.url}${path}`, testScript, ...extra })
const ok = (label = 'ok') => `pm.test('${label}', () => pm.response.to.have.status(200))`
const sentSince = (i: number) => srv.requests.slice(i).map((r) => `${r.method} ${r.url}`)

describe('courier run: collection files', () => {
  it('runs a Courier collection with an environment, globals and --env-var; exit 0', async () => {
    const c = newCollection({
      name: 'Shop',
      variables: [{ key: 'base', value: srv.url, enabled: true, type: 'default' }],
      items: [
        newRequest({ name: 'List', url: '{{base}}/orders/{{region}}?g={{gv}}', testScript: `${ok()}; pm.test('region', () => pm.expect(pm.response.json().url).to.include('/orders/eu'))` }),
        newFolder({ name: 'Admin', items: [newRequest({ name: 'Stats', url: '{{base}}/stats?who={{who}}', testScript: ok() })] })
      ]
    })
    const env = file('env.courier.json', serializeEnvironment(newEnvironment({ name: 'Staging', variables: [{ key: 'region', value: 'us', enabled: true, type: 'default' }, { key: 'who', value: 'env', enabled: true, type: 'default' }] })))
    const globals = file('globals.json', { name: 'Globals', values: [{ key: 'gv', value: 'G1', enabled: true }], _postman_variable_scope: 'globals' })
    const i = srv.requests.length
    const r = await runCli(['run', courierFile(c), '-e', env, '-g', globals, '--env-var', 'region=eu'])
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(sentSince(i)).toEqual(['GET /orders/eu?g=G1', 'GET /stats?who=env'])
    expect(r.stdout).toMatch(/^Courier \d+\.\d+\.\d+ · Shop {2}environment "Staging"\n/)
    expect(r.stdout).toContain(`→ List\n  GET ${srv.url}/orders/eu?g=G1  200 OK`)
    expect(r.stdout).toContain('  ✓ ok\n  ✓ region\n')
    expect(r.stdout).toContain('→ Admin / Stats')
    expect(r.stdout).toMatch(/│ +requests │ +2 │ +0 │/)
    expect(r.stdout).toMatch(/│ +tests │ +3 │ +0 │/)
    expect(r.stdout).toMatch(/total run duration: \d+ ms\n/)
    expect(r.stdout).toMatch(/Result: passed\n$/)
    expect(r.stdout).not.toContain('\x1b[')
  })

  it('a failing test or a request error exits 1 and is listed under Failures', async () => {
    const c = newCollection({ name: 'Fails', items: [req('Boom', '/status/500', ok('is 200')), newRequest({ name: 'Down', url: 'http://127.0.0.1:1/nothing' })] })
    const r = await runCli(['run', courierFile(c)])
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('  ✗ is 200 — expected response to have status code 200 but got 500')
    expect(r.stdout).toMatch(/Failures:\n {2}1\. Boom · test "is 200": .*\n {2}2\. Down · NETWORK: /)
    expect(r.stdout).toMatch(/Result: failed\n$/)
  })

  it('runs a Postman v2.1 collection with a Postman environment; secret values are masked everywhere', async () => {
    const col = file('shop.postman_collection.json', {
      info: { name: 'Postman Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [
        {
          name: 'Echo',
          request: { method: 'POST', url: '{{base}}/echo?key={{apiKey}}', header: [{ key: 'X-Key', value: '{{apiKey}}' }], body: { mode: 'raw', raw: '{"k":"{{apiKey}}"}' } },
          event: [{ listen: 'test', script: { exec: ["console.log('body', pm.response.text())", "pm.test('key ' + pm.environment.get('apiKey'), () => pm.expect(pm.response.json().headers['x-key']).to.eql('nope'))"] } }]
        }
      ]
    })
    const env = file('local.postman_environment.json', { name: 'Local', values: [{ key: 'base', value: srv.url, enabled: true }, { key: 'apiKey', value: ENV_SECRET, type: 'secret', enabled: true }] })
    const json = join(dir, 'pm-report.json')
    const junit = join(dir, 'pm-junit.xml')
    const i = srv.requests.length
    const r = await runCli(['run', col, '-e', env, '-r', 'console,json,junit', '--reporter-json-export', json, '--reporter-junit-export', junit])
    expect(r.code).toBe(1)
    expect(srv.requests[i].headers['x-key']).toBe(ENV_SECRET) // the real value went on the wire
    const outputs = { stdout: r.stdout, stderr: r.stderr, json: readFileSync(json, 'utf8'), junit: readFileSync(junit, 'utf8') }
    for (const [k, v] of Object.entries(outputs)) expect(v.includes(ENV_SECRET), k).toBe(false)
    expect(outputs.stdout).toContain('key=••••')
    expect(outputs.stdout).toContain('✗ key ••••')
    expect(JSON.parse(outputs.json).executions[0].console[0].message).toContain('"x-key":"••••"')
    expect(outputs.junit).toContain('<testcase name="key ••••"')
  })

  it('rejects files that are neither Courier nor Postman, and missing files, with exit 2', async () => {
    const bad = await runCli(['run', file('x.json', { hello: 1 })])
    expect(bad).toMatchObject({ code: 2, stdout: '' })
    expect(bad.stderr).toMatch(/^courier: error \[IMPORT_FAILED\]: Collection file .* is not a Courier collection/)
    const missing = await runCli(['run', join(dir, 'nope.json')])
    expect(missing.code).toBe(2)
    expect(missing.stderr).toMatch(/error \[NOT_FOUND\]: Collection file not found: /)
    const notJson = await runCli(['run', file('broken.json', '{ nope')])
    expect(notJson.stderr).toMatch(/error \[INVALID_ARGUMENT\]: Collection file .* is not valid JSON/)
    const c = courierFile(newCollection({ name: 'C', items: [req('A', '/a')] }))
    const env = await runCli(['run', c, '-e', join(dir, 'no-env.json')])
    expect(env).toMatchObject({ code: 2 })
    expect(env.stderr).toMatch(/Environment file not found/)
  })
})

describe('courier run: data files, iterations, folders, bail, setNextRequest', () => {
  const dataCollection = () =>
    newCollection({ name: 'Data', items: [req('User', '/user/{{user}}', `pm.test('row ' + pm.info.iteration, () => pm.expect(pm.iterationData.get('user')).to.be.a('string'))`)] })

  it('one iteration per CSV row; --iterations cuts rows off or repeats the last row', async () => {
    const c = courierFile(dataCollection())
    const csv = file('rows.csv', 'user\nann\nbob\ncid\n')
    let i = srv.requests.length
    const all = await runCli(['run', c, '-d', csv, '-r', 'json'])
    expect(all.code).toBe(0)
    expect(sentSince(i)).toEqual(['GET /user/ann', 'GET /user/bob', 'GET /user/cid'])
    expect(JSON.parse(all.stdout).run.iterations).toBe(3)
    i = srv.requests.length
    await runCli(['run', c, '-d', csv, '-n', '2'])
    expect(sentSince(i)).toEqual(['GET /user/ann', 'GET /user/bob'])
    i = srv.requests.length
    const five = await runCli(['run', c, '-d', file('rows.json', [{ user: 'x' }, { user: 'y' }]), '-n', '4'])
    expect(sentSince(i)).toEqual(['GET /user/x', 'GET /user/y', 'GET /user/y', 'GET /user/y'])
    expect(five.stdout).toContain('Iteration 4/4')
    i = srv.requests.length
    await runCli(['run', c, '-n', '2', '--env-var', 'user=plain'])
    expect(sentSince(i)).toEqual(['GET /user/plain', 'GET /user/plain'])
    expect((await runCli(['run', c, '-d', file('empty.csv', 'user\n')])).stderr).toMatch(/has no rows/)
    expect((await runCli(['run', c, '-d', join(dir, 'gone.csv')])).stderr).toMatch(/\[NOT_FOUND\]: Data file not found/)
  })

  it('--folder by name or id (repeatable, tree order); ambiguous or unknown folders exit 2', async () => {
    const c = newCollection({
      name: 'Folders',
      items: [
        req('Root', '/root'),
        newFolder({ id: 'fa', name: 'A', items: [req('A1', '/a1'), newFolder({ id: 'fsub', name: 'Sub', items: [req('A2', '/a2')] })] }),
        newFolder({ id: 'fb', name: 'B', items: [req('B1', '/b1'), newFolder({ id: 'fsub2', name: 'Sub', items: [req('B2', '/b2')] })] })
      ]
    })
    const p = courierFile(c)
    let i = srv.requests.length
    expect((await runCli(['run', p, '--folder', 'b'])).code).toBe(0)
    expect(sentSince(i)).toEqual(['GET /b1', 'GET /b2'])
    i = srv.requests.length
    await runCli(['run', p, '--folder', 'fb', '--folder', 'fsub'])
    expect(sentSince(i)).toEqual(['GET /a2', 'GET /b1', 'GET /b2'])
    const amb = await runCli(['run', p, '--folder', 'Sub'])
    expect(amb.code).toBe(2)
    expect(amb.stderr).toContain('2 folders are named "Sub". Pass the id instead:\n  - A / Sub (id fsub)\n  - B / Sub (id fsub2)')
    const none = await runCli(['run', p, '--folder', 'Zed'])
    expect(none.code).toBe(2)
    expect(none.stderr).toMatch(/\[NOT_FOUND\]: No folder named or with id "Zed" in collection "Folders"\. Folders:\n {2}- A \(id fa\)/)
  })

  it('--bail stops at the first failed request (exit 1, stoppedReason failure)', async () => {
    const c = newCollection({ name: 'Bail', items: [req('One', '/one', ok()), req('Two', '/status/500', ok()), req('Three', '/three', ok())] })
    const i = srv.requests.length
    const r = await runCli(['run', courierFile(c), '--bail', '-n', '3', '-r', 'json'])
    expect(r.code).toBe(1)
    expect(sentSince(i)).toEqual(['GET /one', 'GET /status/500'])
    const j = JSON.parse(r.stdout)
    expect(j.run).toMatchObject({ stopped: true, stoppedReason: 'failure' })
    expect(j.result).toBe('failed')
  })

  it('follows setNextRequest, stops on setNextRequest(null), and the loop guard (--max-jumps) exits 1', async () => {
    const c = newCollection({
      name: 'Flow',
      items: [
        req('Start', '/start', `pm.execution.setNextRequest('Finish')`),
        req('Skipped', '/never'),
        req('Finish', '/finish', `${ok()}; pm.execution.setNextRequest(null)`),
        req('After', '/after')
      ]
    })
    const i = srv.requests.length
    const r = await runCli(['run', courierFile(c), '--no-color'])
    expect(r.code).toBe(0)
    expect(sentSince(i)).toEqual(['GET /start', 'GET /finish'])
    expect(r.stdout).toContain('Run stopped: Stopped by setNextRequest(null) in "Finish".')

    const loop = newCollection({ name: 'Loop', items: [req('Ping', '/ping', `pm.execution.setNextRequest('Ping')`)] })
    const junit = join(dir, 'loop.xml')
    const l = await runCli(['run', courierFile(loop), '--max-jumps', '3', '--reporter-junit-export', junit])
    expect(l.code).toBe(1)
    expect(l.stdout).toMatch(/Run stopped: Stopped after 3 setNextRequest jumps in iteration 1/)
    expect(readFileSync(junit, 'utf8')).toMatch(/<error type="LOOP_GUARD" message="Stopped after 3 setNextRequest jumps/)
    const unknown = await runCli(['run', courierFile(newCollection({ name: 'U', items: [req('Go', '/go', `pm.execution.setNextRequest('Nowhere')`)] }))])
    expect(unknown.code).toBe(1)
    expect(unknown.stdout).toContain('setNextRequest("Nowhere") in "Go": no request with that name or id in this run.')
  })
})

describe('courier run: auth', () => {
  const withAuth = (auth: Auth, path = '/auth') => courierFile(newCollection({ name: 'Auth', items: [req('Call', path, ok(), { auth })] }))
  const oauth = (grantType: 'client_credentials' | 'authorization_code'): Auth => ({
    type: 'oauth2',
    grantType,
    accessTokenUrl: `${srv.url}/token`,
    clientId: 'cli',
    clientSecret: 'cc-secret',
    scope: 'api',
    audience: '',
    clientAuthentication: 'body',
    authUrl: `${srv.url}/authorize`
  })

  it('OAuth 2.0 authorization code fails with AUTH_REQUIRED and says why (no browser, no token file)', async () => {
    const i = srv.requests.length
    const r = await runCli(['run', withAuth(oauth('authorization_code')), '-r', 'json'])
    expect(r.code).toBe(1)
    const e = JSON.parse(r.stdout).executions[0]
    expect(e.error.code).toBe('AUTH_REQUIRED')
    expect(e.error.message).toMatch(/needs an interactive browser sign-in, which the command-line runner does not offer/)
    expect(sentSince(i)).toEqual([])
  })

  it('client credentials, Basic, Bearer, API key and Azure identity work; acquired tokens are masked', async () => {
    const i = srv.requests.length
    const json = join(dir, 'auth.json')
    const c = newCollection({
      name: 'Auths',
      items: [
        req('CC', '/cc', `${ok()}; console.log(pm.response.json().headers.authorization)`, { auth: oauth('client_credentials') }),
        req('Basic', '/basic', ok(), { auth: { type: 'basic', username: 'u', password: 'p' } }),
        req('Bearer', '/bearer', ok(), { auth: { type: 'bearer', token: 'static-bearer' } }),
        req('Key', '/key', ok(), { auth: { type: 'apikey', key: 'X-Api-Key', value: 'k1', in: 'header' } }),
        req('Entra', '/entra', `${ok()}; console.log(pm.response.json().headers.authorization)`, { auth: { type: 'entra', scope: 'https://graph.microsoft.com/.default' } })
      ]
    })
    const junit = join(dir, 'auth.xml')
    const r = await runCli(['run', courierFile(c), '--reporter-json-export', json, '--reporter-junit-export', junit])
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    const sent = srv.requests.slice(i).filter((x) => x.url !== '/token')
    expect(sent.map((x) => x.headers.authorization ?? x.headers['x-api-key'])).toEqual([`Bearer ${CC_TOKEN}`, `Basic ${Buffer.from('u:p').toString('base64')}`, 'Bearer static-bearer', 'k1', expect.stringMatching(/^Bearer ey/)])
    const entraToken = (sent[4].headers.authorization as string).slice(7)
    const report = readFileSync(json, 'utf8')
    for (const out of [r.stdout, r.stderr, report, readFileSync(junit, 'utf8')]) {
      expect(out).not.toContain(CC_TOKEN)
      expect(out).not.toContain(entraToken)
    }
    expect(JSON.parse(report).executions[0].console[0].message).toBe('Bearer ••••')
  })
})

describe('courier run: Key Vault', () => {
  const kvCollection = (testScript = '', pre = '') =>
    newCollection({ name: 'Vaulted', items: [req('Secret', '/kv?k={{vault:main/api-key}}', testScript, { headers: [{ key: 'X-Key', value: '{{vault:api-key}}', enabled: true }], preRequestScript: pre })] })

  it('resolves {{vault:…}} with --vault (first vault is the default) and masks the value in every output', async () => {
    const json = join(dir, 'kv.json')
    const junit = join(dir, 'kv.xml')
    const i = srv.requests.length
    const r = await runCli(['run', courierFile(kvCollection(`${ok()}; console.log(pm.response.text()); pm.test('echo ' + pm.response.json().headers['x-key'], () => {})`)), '--vault', `main=${vault.url}`, '-r', 'console,json,junit', '--reporter-json-export', json, '--reporter-junit-export', junit])
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(srv.requests[i].headers['x-key']).toBe(KV_SECRET)
    expect(srv.requests[i].url).toBe(`/kv?k=${KV_SECRET}`)
    for (const out of [r.stdout, r.stderr, readFileSync(json, 'utf8'), readFileSync(junit, 'utf8')]) expect(out).not.toContain(KV_SECRET)
    expect(r.stdout).toContain('/kv?k=••••')
    expect(r.stdout).toContain('✓ echo ••••')
  })

  it('without --vault the reference fails (exit 1); a --vault that is not a Key Vault host is a usage error without the test hook', async () => {
    const p = courierFile(kvCollection())
    const none = await runCli(['run', p, '-r', 'json'])
    expect(none.code).toBe(1)
    expect(JSON.parse(none.stdout).executions[0].error).toMatchObject({ code: 'NOT_CONFIGURED', message: expect.stringMatching(/No Key Vault is configured/) })
    const strict = await runCli(['run', p, '--vault', `main=${vault.url}`], { env: { COURIER_KV_INSECURE_CHALLENGE: undefined } })
    expect(strict.code).toBe(2)
    expect(strict.stderr).toMatch(/error \[INVALID_ARGUMENT\]: Vault "main": host 127\.0\.0\.1:\d+ is not an Azure Key Vault host/)
    const http = await runCli(['run', p, '--vault', 'main=http://kv.vault.azure.net'])
    expect(http.stderr).toMatch(/Vault "main": not https/)
  })

  it('scripts cannot read Key Vault unless --allow-script-vault (optionally pinned with --scripts-sha256)', async () => {
    const pre = "pm.vault.get('api-key').then((v) => pm.variables.set('fromScript', v))"
    const c = kvCollection(`${ok()}; console.log('seen', pm.variables.get('fromScript'))`, pre)
    const p = courierFile(c)
    const i = srv.requests.length
    const blocked = await runCli(['run', p, '--vault', `main=${vault.url}`, '-r', 'json'])
    expect(blocked.code).toBe(1)
    const e = JSON.parse(blocked.stdout).executions[0]
    expect(e.error.code).toBe('VAULT_SCRIPT_BLOCKED')
    expect(e.error.message).toMatch(/may not read Key Vault secrets in this run\. Review the collection's scripts, then pass --allow-script-vault/)
    expect(sentSince(i)).toEqual([]) // a blocked pre-request script stops the request

    const json = join(dir, 'gate.json')
    const allowed = await runCli(['run', p, '--vault', `main=${vault.url}`, '--allow-script-vault', '--reporter-json-export', json])
    expect(allowed.stderr).toBe('')
    expect(allowed.code).toBe(0)
    const report = JSON.parse(readFileSync(json, 'utf8'))
    expect(report.executions[0].console[0].message).toBe('seen ••••')
    expect(JSON.stringify(report)).not.toContain(KV_SECRET)
    expect(report.collection.scriptsSha256).toBe(scriptsDigest(c))

    const pinned = await runCli(['run', p, '--vault', `main=${vault.url}`, '--allow-script-vault', '--scripts-sha256', report.collection.scriptsSha256])
    expect(pinned.code).toBe(0)
    const changed = courierFile({ ...c, testScript: '// edited by a teammate' })
    const stale = await runCli(['run', changed, '--vault', `main=${vault.url}`, '--allow-script-vault', '--scripts-sha256', report.collection.scriptsSha256])
    expect(stale.code).toBe(2)
    expect(stale.stderr).toMatch(/error \[VAULT_SCRIPT_BLOCKED\]: The scripts of collection "Vaulted" changed: their SHA-256 is [0-9a-f]{64}, not the [0-9a-f]{64} given/)
  })

  it('the scripts digest ignores item ids, so a re-imported Postman file keeps its hash', () => {
    const a = kvCollection('x', 'y')
    const b = structuredClone(a)
    b.id = 'other'
    b.items[0].id = 'other-item'
    expect(scriptsDigest(b)).toBe(scriptsDigest(a))
    ;(b.items[0] as RequestDef).testScript = 'x2'
    expect(scriptsDigest(b)).not.toBe(scriptsDigest(a))
  })
})

describe('courier run: masking edge cases', () => {
  it('a secret that equals a report word ("test", "failure", "error") never corrupts the reports or the exit code', async () => {
    const c = newCollection({
      name: 'Words',
      variables: [
        { key: 'a', value: 'test', enabled: true, type: 'secret' },
        { key: 'b', value: 'failure', enabled: true, type: 'secret' },
        { key: 'c', value: 'error', enabled: true, type: 'secret' }
      ],
      items: [req('One', '/one', ok('tests ok')), req('Two', '/status/500', ok())]
    })
    // serializeCollection blanks secret values, so write the document by hand.
    const doc = JSON.parse(serializeCollection(c))
    doc.variables = c.variables
    const json = join(dir, 'words.json')
    const junit = join(dir, 'words.xml')
    const r = await runCli(['run', file('words.courier.json', doc), '--bail', '--reporter-json-export', json, '--reporter-junit-export', junit])
    expect(r.code).toBe(1)
    const j = JSON.parse(readFileSync(json, 'utf8'))
    expect(j.run.stoppedReason).toBe('failure')
    expect(j.stats.tests).toEqual({ total: 2, passed: 1, failed: 1 })
    expect(j.executions[1]).toMatchObject({ status: 500, passed: false })
    expect(j.executions[1]).not.toHaveProperty('error')
    expect(j.executions[0].tests[0]).toMatchObject({ name: '••••s ok', source: { level: 'request', phase: 'test' } })
    const xml = readFileSync(junit, 'utf8')
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n<testsuites name="Words" tests="2" failures="1" errors="0"/)
    expect((xml.match(/<testsuite /g) ?? []).length).toBe(2)
    expect(xml).toContain('<testcase name="••••s ok"')
  })

  it('a value a script stores in a variable declared secret is masked from then on (login token flow)', async () => {
    const token = 'login-Token-From-Response-8c21'
    const c = newCollection({
      name: 'Login',
      items: [
        req('Login', `/login?issued=${token}`, `pm.environment.set('token', pm.response.json().url.split('=')[1]); console.log('got', pm.environment.get('token'))`),
        req('Use', '/use?t={{token}}', `${ok()}; console.log('using', pm.environment.get('token'))`)
      ]
    })
    const env = file('login.postman_environment.json', { name: 'Auth', values: [{ key: 'token', value: '', type: 'secret', enabled: true }] })
    const json = join(dir, 'login.json')
    const junit = join(dir, 'login.xml')
    const i = srv.requests.length
    const r = await runCli(['run', courierFile(c), '-e', env, '-r', 'console,json,junit', '--reporter-json-export', json, '--reporter-junit-export', junit])
    expect(r.code).toBe(0)
    expect(srv.requests[i + 1].url).toBe(`/use?t=${token}`)
    const outs = [r.stdout, r.stderr, readFileSync(json, 'utf8'), readFileSync(junit, 'utf8')]
    expect(outs.filter((o) => o.includes(token))).toEqual([])
    expect(r.stdout).toContain('┊ log: got ••••')
    expect(r.stdout).toContain('/use?t=••••')
  })

  it('colour only on a terminal, and never with --no-color or NO_COLOR', async () => {
    const p = courierFile(newCollection({ name: 'Colour', items: [req('A', '/a', ok())] }))
    expect((await runCli(['run', p], { isTTY: true })).stdout).toContain('\x1b[32m✓\x1b[39m')
    expect((await runCli(['run', p, '--no-color'], { isTTY: true })).stdout).not.toContain('\x1b[')
    expect((await runCli(['run', p], { isTTY: true, env: { NO_COLOR: '1' } })).stdout).not.toContain('\x1b[')
    expect((await runCli(['run', p], { isTTY: false })).stdout).not.toContain('\x1b[')
  })
})

describe('courier run: report files', () => {
  it('creates missing directories for export files; an unwritable export path exits 2', async () => {
    const p = courierFile(newCollection({ name: 'Out', items: [req('A', '/a', ok())] }))
    const nested = join(dir, 'reports', 'deep', 'r.json')
    expect((await runCli(['run', p, '--reporter-json-export', nested])).code).toBe(0)
    expect(JSON.parse(readFileSync(nested, 'utf8')).result).toBe('passed')
    const blocker = join(dir, 'blocker')
    mkdirSync(blocker)
    writeFileSync(join(blocker, 'file'), 'x')
    const bad = await runCli(['run', p, '--reporter-junit-export', join(blocker, 'file', 'j.xml')])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toMatch(/Cannot write the JUnit report to /)
  })
})
