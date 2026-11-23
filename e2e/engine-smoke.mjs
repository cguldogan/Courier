// Engine smoke test: launches the BUILT app (run `npm run build` first) with a temp userData and a
// fake identity, then round-trips real calls through window.courier.
//   arch -arm64 node e2e/engine-smoke.mjs
import { _electron as electron } from 'playwright-core'
import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'courier-smoke-'))
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    res.setHeader('set-cookie', 'smoke=1; Path=/')
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const app = await electron.launch({
  args: ['.'],
  cwd: process.cwd(),
  env: { ...process.env, COURIER_USER_DATA: userData, COURIER_FAKE_IDENTITY: JSON.stringify({ name: 'Smoke Tester', upn: 'smoke@example.com', oid: '11111111-1111-1111-1111-111111111111', tid: '22222222-2222-2222-2222-222222222222' }) }
})
const failures = []
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!cond) failures.push(name)
}
try {
  const win = await app.firstWindow()
  await win.waitForSelector('#bridge-status')
  await win.waitForFunction(() => !document.querySelector('#bridge-status').textContent.startsWith('checking'))
  const status = await win.textContent('#bridge-status')
  check('window opens and preload bridge answers', status.startsWith('window.courier ready'), status)

  const security = await win.evaluate(() => ({ process: typeof process, require: typeof require, courierKeys: Object.keys(window.courier).sort() }))
  await win.bringToFront()
  const clip = await win.evaluate(async () => {
    try {
      await navigator.clipboard.writeText('courier-clipboard-check')
      return 'ok'
    } catch (e) {
      return String(e)
    }
  })
  check('clipboard write allowed (copy buttons)', clip === 'ok', clip)
  const camera = await win.evaluate(async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ video: true })
      return 'granted'
    } catch (e) {
      return 'denied'
    }
  })
  check('other permissions denied (camera)', camera === 'denied', camera)
  check('renderer has no Node globals', security.process === 'undefined' && security.require === 'undefined', JSON.stringify(security))

  const result = await win.evaluate(async (port) => {
    const c = window.courier
    const events = []
    const off = c.on('history:changed', () => events.push('history:changed'))
    const before = await c.workspace.load()
    const created = await c.collections.create({ name: 'Smoke' })
    const colId = created.value.collection.id
    await c.collections.upsertItem({
      collectionId: colId,
      item: { type: 'request', id: 'req-1', name: 'Echo', description: '', method: 'POST', url: `http://127.0.0.1:${port}/echo`, params: [{ key: 'q', value: '{{greeting}}', enabled: true }], pathVariables: [], headers: [], body: { mode: 'raw', language: 'json', raw: '{"hello":"{{greeting}}"}' }, auth: { type: 'bearer', token: 'abc' }, preRequestScript: "pm.variables.set('greeting','world')", testScript: "pm.test('status 200', () => pm.response.to.have.status(200)); pm.test('echo', () => pm.expect(pm.response.json().body).to.include('world'))", settings: {} }
    })
    const sent = await c.requests.send({ collectionId: colId, requestId: 'req-1' })
    const after = await c.workspace.load()
    const history = await c.history.list()
    const cookies = await c.cookies.list()
    const signIn = await c.identity.signIn({ mode: 'auto' })
    const bad = await c.collections.delete('../../etc')
    off()
    return { before, created: created.ok, sent, after, history, cookies, signIn, bad, events }
  }, port)
  check('workspace.load ok', result.before.ok && Array.isArray(result.before.value.collections), JSON.stringify(result.before).slice(0, 120))
  check('collections.create ok', result.created)
  check('requests.send reached the local server', result.sent.ok && result.sent.value.response?.status === 200, JSON.stringify(result.sent).slice(0, 200))
  const echoed = result.sent.ok ? JSON.parse(result.sent.value.response.bodyText) : {}
  check('variables, query param and bearer auth applied', echoed.url === '/echo?q=world' && echoed.headers?.authorization === 'Bearer abc' && echoed.body === '{"hello":"world"}', JSON.stringify(echoed).slice(0, 200))
  check('tests ran in sandbox', result.sent.ok && result.sent.value.tests.length === 2 && result.sent.value.tests.every((t) => t.passed), JSON.stringify(result.sent.value?.tests))
  check('history recorded', result.history.ok && result.history.value.length === 1)
  check('cookie jar persisted', result.cookies.ok && result.cookies.value.some((c) => c.key === 'smoke'))
  check('fake identity sign-in', result.signIn.ok && result.signIn.value.account?.upn === 'smoke@example.com', JSON.stringify(result.signIn).slice(0, 200))
  check('invalid id rejected with clean error envelope', !result.bad.ok && result.bad.error.code === 'INVALID_ARGUMENT', JSON.stringify(result.bad))
  check('events delivered (history:changed)', result.events.includes('history:changed'))
  const files = readdirSync(join(userData, 'data', 'collections'))
  check('collection cached in userData/data', files.length === 1 && readFileSync(join(userData, 'data', 'collections', files[0]), 'utf8').includes('"schema": "courier.collection/v1"'))
} finally {
  await app.close()
  server.close()
  rmSync(userData, { recursive: true, force: true })
}
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nengine smoke: all checks passed')
