// End-to-end drive of the REAL UI (playwright-core `_electron`). `npm run e2e` builds first.
//   arch -arm64 npm run e2e
// Starts a local echo server, Azurite (HTTPS + --oauth basic) and a mock Key Vault, launches the built
// app with a temp userData + fake identity, and drives it by clicking/typing. window.courier is only
// used for assertions. Screenshots go to e2e/screenshots/. Exits non-zero on any failed check.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ECHO_PROTO, PROTO_ROOT, startGrpcServer, startWsServer } from '../tests/fixtures/realtime-servers.mjs'
import { ROOT, createContainer, deleteContainer, launchApp, listBlobs, makeCert, setDialogPaths, startAuthServers, startAzurite, startEcho, startMockVault, stubBrowser, stubDialogs } from './infra.mjs'

const SHOTS = join(ROOT, 'e2e', 'screenshots')
mkdirSync(SHOTS, { recursive: true })
for (const f of readdirSync(SHOTS)) if (f.endsWith('.png')) rmSync(join(SHOTS, f))

const ALICE = { name: 'Alice Example', upn: 'alice@contoso.test', oid: 'aaaaaaaa-0000-0000-0000-000000000001', tid: '7e57e57e-0000-0000-0000-000000000001' }
const BOB = { name: 'Bob Builder', upn: 'bob@contoso.test', oid: 'bbbbbbbb-0000-0000-0000-000000000002', tid: ALICE.tid }
const SECRET = 'kv-S3cret-Value-9f2c'
/** Sent over WebSocket and never saved anywhere: must not reach any file (message logs are memory only). */
const LOG_ONLY = 'ws-log-only-7f3a91e2'
const DB_SECRET = 'db-Passw0rd-77aa'
const CONTAINER = 'courier'
const CONTAINER2 = 'courier-research'
const CONTAINER3 = 'courier-scratch'
const MOD = 'ControlOrMeta'

const failures = []
let current = ''
function check(name, cond, detail) {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${!cond && detail ? `  — ${String(detail).slice(0, 400)}` : ''}`)
  if (!cond) failures.push(`${current}: ${name}`)
  return cond
}
function section(name) {
  current = name
  console.log(`\n== ${name}`)
}
async function shot(win, name) {
  await win.waitForTimeout(150)
  await win.screenshot({ path: join(SHOTS, `${name}.png`) })
  console.log(`  shot  e2e/screenshots/${name}.png`)
}
function watchErrors(win, label, sink) {
  win.on('pageerror', (e) => sink.push(`${label} pageerror: ${e.message}`))
  win.on('console', (m) => {
    const t = m.text()
    // The HTML preview iframe is sandboxed without allow-scripts: Chromium reporting the blocked script is the expected outcome.
    if (/Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed/.test(t)) {
      sandboxBlocked.push(t)
      return
    }
    // The Visualize frame's own CSP refusing the template's loads from the canary server is the expected outcome.
    // Clicking the template's outbound link: the app CSP refuses to frame the canary server's origin.
    if (/\/canary\//.test(t) || (typeof authSrv !== 'undefined' && t.includes(`Framing '${authSrv.url}/' violates`)) || /Refused to execute the redirect specified via '<meta http-equiv='refresh'.*The document is sandboxed/.test(t)) {
      visualizerBlocked.push(t)
      return
    }
    if (/Content Security Policy|Refused to/i.test(t) || m.type() === 'error') sink.push(`${label} console.${m.type()}: ${t}`)
  })
}
const sandboxBlocked = []
const visualizerBlocked = []
const JWT_SECRET = 'e2e-Jwt-Secret-0123456789abcdef'
const AWS_KEYS = { accessKey: 'AKIDE2EEXAMPLE', secretKey: 'e2e/Aws+Secret+Key/EXAMPLE' }
const AUTH_USER = { name: 'digest-e2e', password: 'Dig3st-e2e-pw' }
let oauthToken = ''
const toast = (win, re) => win.getByTestId('toast').filter({ hasText: re }).first()
const node = (win, name) => win.locator(`[data-testid="tree-node"][data-name="${name}"]`).first()
async function menu(win, target, ...path) {
  await target.click({ button: 'right' })
  for (let i = 0; i < path.length; i++) {
    const item = win.getByRole('menuitem', { name: path[i], exact: true })
    if (i < path.length - 1) await item.hover()
    else await item.click()
  }
}
async function typeInEditor(win, scope, text) {
  const content = win.locator(`${scope} .cm-content`).first()
  await content.click()
  await win.keyboard.press(`${MOD}+a`)
  await win.keyboard.insertText(text)
}
async function addRow(win, grid, key, value) {
  await win.locator(`[data-testid="${grid}"]`).getByLabel('New key').fill(key)
  await win.locator(`[data-testid="${grid}"] tr[data-testid="kv-row"]`).last().getByLabel('Value', { exact: true }).fill(value)
}
async function section_(win, name) {
  await win.locator('[data-testid="request-sections"]').getByRole('tab', { name: new RegExp(`^${name}`) }).click()
}
async function responseTab(win, name) {
  await win.locator('[data-testid="response-tabs"]').getByRole('tab', { name: new RegExp(`^${name}`) }).click()
}
async function closeModal(win) {
  await win.keyboard.press('Escape')
  await win.locator('.modal-backdrop').last().waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined)
}
/** Click Sync and handle the secret-warning dialog. Returns 'conflict' | 'ok'. */
async function dismissToasts(win) {
  for (const b of await win.locator('[data-testid="toast"] button[aria-label="Dismiss"]').all()) await b.click().catch(() => undefined)
  await win.getByTestId('toast').first().waitFor({ state: 'detached', timeout: 3000 }).catch(() => undefined)
}
async function syncVia(win, label) {
  await dismissToasts(win)
  await win.getByTestId('sync-button').click()
  for (let i = 0; i < 100; i++) {
    if (await win.getByTestId('conflict-dialog').isVisible()) return 'conflict'
    if (await win.getByTestId('warnings-dialog').isVisible()) {
      await shot(win, `${label}-secret-warnings`)
      await win.getByTestId('warnings-proceed').click()
      continue
    }
    if (await toast(win, /^Synced|Everything is up to date/).isVisible()) return 'ok'
    if (await toast(win, /Sync failed/).isVisible()) return `error: ${await toast(win, /Sync failed/).innerText()}`
    await win.waitForTimeout(100)
  }
  return 'timeout'
}
async function openSettings(win, sectionId) {
  await win.getByTestId('settings-button').click()
  await win.getByTestId(`settings-nav-${sectionId}`).click()
}
const teamGroup = (win, name) => win.locator(`[data-testid="team-group"][data-team-name="${name}"]`)
/** Settings → Teams → Join or create: look the container up, then create the team (`create`) or join it. Returns what the lookup showed. */
async function teamVia(win, accountUrl, container, { create, readOnly } = {}) {
  await openSettings(win, 'teams')
  if (!(await win.getByTestId('join-team-form').isVisible())) await win.getByTestId('add-team').click()
  await win.getByTestId('team-account').fill(accountUrl)
  await win.getByTestId('team-container').fill(container)
  await win.getByTestId('team-lookup').click()
  const found = win.getByTestId('team-found')
  const missing = win.getByTestId('team-missing')
  await found.or(missing).waitFor({ timeout: 15000 })
  if (readOnly) {
    if (!(await missing.isVisible())) return { result: 'unexpected manifest' }
    await win.getByTestId('team-name').fill(readOnly)
    await win.getByTestId('team-join-readonly').click()
    await toast(win, new RegExp(`Joined team "${readOnly}"`)).waitFor()
    return { result: 'joined read-only', name: readOnly }
  }
  if (create) {
    if (!(await missing.isVisible())) return { result: 'unexpected manifest', name: await win.getByTestId('team-found-name').innerText() }
    await win.getByTestId('team-name').fill(create)
    await win.getByTestId('team-create').click()
    await toast(win, new RegExp(`Created team "${create}"`)).waitFor()
    return { result: 'created', name: create }
  }
  if (!(await found.isVisible())) return { result: 'no manifest' }
  const name = await win.getByTestId('team-found-name').innerText()
  await win.getByTestId('team-join').click()
  await toast(win, new RegExp(`Joined team "${name}"`)).waitFor()
  return { result: 'joined', name }
}
async function signInVia(win, upn) {
  await win.getByTestId('sign-in').click()
  await win.getByTestId('identity-chip').waitFor({ timeout: 15000 })
  const s = await win.evaluate(() => window.courier.identity.status())
  return s.ok && s.value.account?.upn === upn
}

/** Every file under dir (recursive), raw bytes. */
function walkFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(p)
      else if (st.isFile()) out.push(p)
    }
  }
  walk(dir)
  return out
}
function filesContaining(dir, secret) {
  const needles = [Buffer.from(secret, 'utf8'), Buffer.from(secret, 'utf16le'), Buffer.from(encodeURIComponent(secret), 'utf8'), Buffer.from(Buffer.from(secret).toString('base64'), 'utf8')]
  return walkFiles(dir).filter((p) => {
    const b = readFileSync(p)
    return needles.some((n) => b.includes(n))
  })
}

// ---------------------------------------------------------------------------------------------

const errors = []
const pki = makeCert()
const echo = await startEcho()
const azurite = await startAzurite(pki)
const vault = await startMockVault(pki, ALICE.tid, { 'api-key': SECRET, 'db-password': DB_SECRET })
const authSrv = await startAuthServers({ jwtSecret: JWT_SECRET, aws: AWS_KEYS, user: AUTH_USER })
const wsSrv = await startWsServer()
const grpcSrv = await startGrpcServer()
await createContainer(azurite.url, CONTAINER, ALICE, pki.cert)
await createContainer(azurite.url, CONTAINER2, ALICE, pki.cert)
await createContainer(azurite.url, CONTAINER3, ALICE, pki.cert)
const udA = mkdtempSync(join(tmpdir(), 'courier-e2e-a-'))
const udB = mkdtempSync(join(tmpdir(), 'courier-e2e-b-'))
const exportDir = mkdtempSync(join(tmpdir(), 'courier-e2e-export-'))
let A = null
let B = null

try {
  A = await launchApp({ userData: udA, identity: ALICE, cert: pki.cert, colorScheme: 'light' })
  const win = A.win
  watchErrors(win, 'A', errors)
  await stubDialogs(A.app, {})
  await win.getByTestId('onboarding').waitFor()
  await shot(win, '00-onboarding-light')

  // -------------------------------------------------------------------------------------------
  section('a. collection + request + env var + header + JSON body + test script → Send')
  await win.getByTestId('sidebar-tab-environments').click()
  await win.getByTestId('new-environment').click()
  await win.getByTestId('prompt-input').fill('E2E Env')
  await win.getByTestId('prompt-confirm').click()
  await win.getByTestId('environment-editor').waitFor()
  const envVars = win.locator('[data-testid="env-vars"]')
  await envVars.getByLabel('New variable name').fill('baseUrl')
  await envVars.locator('tr[data-testid="var-row"]').last().getByLabel('Shared value').fill(echo.url)
  await envVars.getByLabel('New variable name').fill('greeting')
  await envVars.locator('tr[data-testid="var-row"]').last().getByLabel('Shared value').fill('hello')
  await envVars.locator('tr[data-testid="var-row"]').last().getByLabel('Current value').fill('world')
  await win.getByTestId('save-button').click()
  await toast(win, /Saved "E2E Env"/).waitFor()
  await win.getByTestId('env-select').selectOption({ label: 'E2E Env' })
  await win.waitForFunction(() => window.courier.workspace.load().then((r) => r.value.activeEnvironmentId !== null))
  const snapEnv = await win.evaluate(() => window.courier.workspace.load())
  const env = snapEnv.value.environments[0]
  check('environment saved with shared value, current value stays local', env?.environment.variables.find((v) => v.key === 'greeting')?.value === 'hello' && snapEnv.value.currentValues.environments[env.environment.id]?.greeting === 'world', JSON.stringify(snapEnv.value.currentValues))

  await win.getByTestId('sidebar-tab-collections').click()
  await win.getByTestId('new-collection').click()
  await win.getByTestId('prompt-input').fill('E2E API')
  await win.getByTestId('prompt-confirm').click()
  await node(win, 'E2E API').waitFor()
  await menu(win, node(win, 'E2E API'), 'Add request')
  await win.getByTestId('request-editor').waitFor()
  await win.getByTestId('request-name').click()
  await win.getByLabel('Request name').fill('Echo')
  await win.getByLabel('Request name').press('Enter')
  await win.getByTestId('method-select').selectOption('POST')
  await win.getByTestId('url-input').fill('{{baseUrl}}/echo?x=1')
  const paramKeys = await win.locator('[data-testid="params-grid"] tr[data-testid="kv-row"] input[aria-label="Key"]').evaluateAll((els) => els.map((e) => e.value))
  check('typing a query string fills the Params grid', JSON.stringify(paramKeys) === '["x"]', JSON.stringify(paramKeys))
  await addRow(win, 'params-grid', 'y', '2')
  check('adding a param updates the URL bar', (await win.getByTestId('url-input').inputValue()) === '{{baseUrl}}/echo?x=1&y=2', await win.getByTestId('url-input').inputValue())
  await section_(win, 'Headers')
  await addRow(win, 'headers-grid', 'X-Api-Key', 'literal-key-123')
  await addRow(win, 'headers-grid', 'X-Greeting', '{{greeting}}')
  await section_(win, 'Body')
  await win.getByRole('radio', { name: 'raw' }).check()
  await typeInEditor(win, '[data-testid="body-editor"]', '{"hello":"{{greeting}}","n":1}')
  await win.getByRole('button', { name: 'Beautify' }).click()
  await section_(win, 'Scripts')
  await win.locator('[data-testid="script-phase"]').getByRole('tab', { name: /Post-response/ }).click()
  await typeInEditor(win, '[data-testid="test-script"]', "pm.test('status is 200', () => pm.response.to.have.status(200));\npm.test('echoes greeting', () => pm.expect(pm.response.json().headers['x-greeting']).to.eql('world'));\nconsole.log('done', pm.response.code);")
  check('tab shows unsaved changes', await win.locator('[data-testid="tab"][data-title="Echo"] .tab-close.dirty').isVisible())
  await win.getByTestId('send-button').click()
  await win.getByTestId('response-status').waitFor()
  const status = await win.getByTestId('response-status').innerText()
  check('status 200 shown', status.startsWith('200'), status)
  const wire = echo.requests.at(-1)
  check('request reached echo server with resolved {{baseUrl}}, params, header and body', wire?.method === 'POST' && wire.url === '/echo?x=1&y=2' && wire.headers['x-greeting'] === 'world' && JSON.parse(wire.body).hello === 'world', JSON.stringify(wire))
  const bodyText = await win.getByTestId('response-body').innerText()
  check('response body rendered (pretty JSON)', bodyText.includes('"x-greeting": "world"'), bodyText.slice(0, 200))
  check('time and size shown', /\d/.test(await win.getByTestId('response-time').innerText()) && /B/.test(await win.getByTestId('response-size').innerText()))
  await win.getByTestId('body-search').fill('greeting')
  check('search within body highlights matches', (await win.locator('.cm-body-match').count()) > 0)
  await shot(win, '01-request-response-light')
  await responseTab(win, 'Tests')
  const tests = await win.getByTestId('test-result').evaluateAll((els) => els.map((e) => e.getAttribute('data-passed')))
  check('test results shown: 2 passed', JSON.stringify(tests) === '["true","true"]', JSON.stringify(tests))
  await shot(win, '02-tests')
  await win.keyboard.press(`${MOD}+s`)
  await toast(win, /Saved "Echo"/).waitFor()
  check('Cmd/Ctrl+S saved (dirty dot gone)', !(await win.locator('[data-testid="tab"][data-title="Echo"] .tab-close.dirty').isVisible()))
  const saved = await win.evaluate(() => window.courier.workspace.load())
  const savedReq = saved.value.collections[0].collection.items[0]
  check('saved request persisted (url base + params, headers, body, script)', savedReq.url === '{{baseUrl}}/echo' && savedReq.params.length === 2 && savedReq.headers.length === 2 && savedReq.body.mode === 'raw' && savedReq.testScript.includes('status is 200'), JSON.stringify(savedReq).slice(0, 300))
  // keyboard: new tab + send with Cmd/Ctrl+Enter, close with Cmd/Ctrl+W
  await win.keyboard.press(`${MOD}+t`)
  await win.getByTestId('url-input').fill(`${echo.url}/html`)
  const before = echo.requests.length
  await win.keyboard.press(`${MOD}+Enter`)
  await win.getByTestId('response-status').waitFor()
  check('Cmd/Ctrl+Enter sends', echo.requests.length === before + 1)
  await win.getByRole('radio', { name: 'Preview' }).click()
  await win.locator('iframe.html-preview').waitFor()
  check('HTML preview renders in a sandboxed iframe', (await win.frameLocator('iframe.html-preview').locator('h1').innerText()) === 'Hello preview')
  await win.waitForTimeout(200)
  check('preview iframe does not run the response\'s scripts', sandboxBlocked.length > 0 && (await win.frameLocator('iframe.html-preview').locator('html').evaluate((el) => el.ownerDocument.title)) !== 'scripts must not run')
  const tabsBefore = await win.getByTestId('tab').count()
  await win.keyboard.press(`${MOD}+w`)
  const closeDialog = win.getByTestId('confirm-dialog')
  if (await closeDialog.isVisible().catch(() => false)) await closeDialog.getByRole('button', { name: "Don't save" }).click()
  check('Cmd/Ctrl+W closes the tab', (await win.getByTestId('tab').count()) === tabsBefore - 1)

  // -------------------------------------------------------------------------------------------
  section('b. {{vault:…}} header resolves via mock Key Vault; secret masked in UI and absent from userData')
  check('sign in with (fake) Azure identity', await signInVia(win, ALICE.upn))
  await openSettings(win, 'vault')
  await win.getByTestId('add-vault').click()
  const vrow = win.getByTestId('vault-config-row').last()
  await vrow.getByLabel('Vault alias').fill('main')
  await vrow.getByLabel('Vault URL').fill(vault.url)
  await win.getByTestId('settings-save').click()
  await toast(win, /Settings saved/).waitFor()
  await closeModal(win)
  await win.getByTestId('new-tab').click()
  await win.getByTestId('request-name').click()
  await win.getByLabel('Request name').fill('Vaulted')
  await win.getByLabel('Request name').press('Enter')
  await win.getByTestId('url-input').fill('{{baseUrl}}/vault')
  await section_(win, 'Headers')
  await addRow(win, 'headers-grid', 'X-Secret', '{{vault:main/api-key}}')
  await section_(win, 'Scripts')
  await typeInEditor(win, '[data-testid="pre-script"]', "pm.vault.get('api-key').then((v) => console.log('pre sees', v));")
  await win.locator('[data-testid="script-phase"]').getByRole('tab', { name: /Post-response/ }).click()
  await typeInEditor(win, '[data-testid="test-script"]', "console.log('body', pm.response.text());\npm.test('ok', () => pm.response.to.have.status(200));")
  // scripts get Key Vault values only when this machine allows the collection: blocked first
  const vaultFetched = () => vault.hits.some((h) => h.path.startsWith('/secrets/api-key') && h.authorized)
  await win.getByTestId('send-button').click()
  await win.getByTestId('response-error').waitFor()
  check(
    'unsaved draft: pm.vault.get is blocked (VAULT_SCRIPT_BLOCKED), nothing sent or fetched',
    (await win.getByTestId('response-error').getAttribute('data-code')) === 'VAULT_SCRIPT_BLOCKED' && /Save the request to a collection/.test(await win.getByTestId('response-error').innerText()) && !echo.requests.some((r) => r.url === '/vault') && !vaultFetched(),
    await win.getByTestId('response-error').innerText()
  )
  await win.keyboard.press(`${MOD}+s`)
  await win.getByTestId('save-as-dialog').waitFor()
  await win.getByTestId('save-as-collection').selectOption('')
  await win.getByLabel('New collection name').fill('Saved Drafts')
  await win.getByTestId('save-as-confirm').click()
  await toast(win, /Saved "Vaulted"/).waitFor()
  await node(win, 'Saved Drafts').waitFor()
  check('Save As of an unsaved draft into a new collection', await node(win, 'Vaulted').isVisible())
  await win.locator('[data-testid="tab"][data-title="Vaulted"]').first().click()
  await win.getByTestId('send-button').click()
  const blockedBox = win.locator('[data-testid="response-error"]', { hasText: 'Saved Drafts' })
  await blockedBox.waitFor()
  check(
    'saved in a collection that is not allowed: still blocked, error names the setting and offers to open it',
    (await blockedBox.getAttribute('data-code')) === 'VAULT_SCRIPT_BLOCKED' && /Allow this collection's scripts to read Key Vault secrets/.test(await blockedBox.innerText()) && (await win.getByTestId('open-script-vault-setting').isVisible()) && !echo.requests.some((r) => r.url === '/vault') && !vaultFetched(),
    await blockedBox.innerText()
  )
  await shot(win, '03a-vault-script-blocked')
  await win.getByTestId('open-script-vault-setting').click()
  await win.getByTestId('script-vault-access').waitFor()
  check('the action opens the collection settings at the (unchecked) toggle', (await win.getByTestId('container-editor').isVisible()) && !(await win.getByTestId('script-vault-toggle').isChecked()))
  await win.getByTestId('script-vault-toggle').check()
  await win.locator('[data-testid="script-vault-access"][data-allowed="true"]').waitFor()
  const access = await win.evaluate(async () => {
    const snap = await window.courier.workspace.load()
    const c = snap.value.collections.find((x) => x.collection.name === 'Saved Drafts')
    return window.courier.collections.getScriptVaultAccess(c.collection.id)
  })
  check('toggle grants the permission on this machine', access.ok && access.value.allowed === true, JSON.stringify(access))
  await shot(win, '03b-vault-script-setting')
  await win.locator('[data-testid="tab"][data-title="Vaulted"]').first().click()
  await win.getByTestId('send-button').click()
  await win.locator('[data-testid="response-status"]', { hasText: /^200/ }).waitFor()
  const vwire = echo.requests.at(-1)
  check('live request carried the real Key Vault secret', vwire?.headers['x-secret'] === SECRET, JSON.stringify(vwire?.headers))
  check('mock vault was called with a bearer token (after the 401 challenge)', vault.hits.some((h) => h.path.startsWith('/secrets/api-key') && h.authorized) && vault.hits.some((h) => !h.authorized))
  const vbody = await win.getByTestId('response-body').innerText()
  check('response body shows the secret masked', vbody.includes('••••') && !vbody.includes(SECRET), vbody.slice(0, 300))
  await responseTab(win, 'Console')
  const consoleText = await win.getByTestId('console').innerText()
  check('console shows masked secret, not the value', consoleText.includes('pre sees ••••') && !consoleText.includes(SECRET), consoleText.slice(0, 300))
  await shot(win, '03-vault-console-masked')
  await responseTab(win, 'Request')
  const sentText = await win.getByTestId('sent-headers').innerText()
  check('"Request" view masks the header', sentText.includes('••••') && !sentText.includes(SECRET))
  await win.getByTestId('sidebar-tab-history').click()
  const histText = await win.getByTestId('history-list').innerText()
  check('history lists the request without the secret', histText.includes('/vault') && !histText.includes(SECRET), histText.slice(0, 300))
  await shot(win, '04-history')
  await win.getByTestId('history-row').first().click()
  check('history click reopens as a draft tab', (await win.locator('[data-testid="tab"].draft').count()) >= 1)
  const domAll = await win.evaluate(() => document.body.innerText)
  check('secret value appears nowhere in the window', !domAll.includes(SECRET))
  // error state: missing secret
  await win.keyboard.press(`${MOD}+t`)
  await win.getByTestId('url-input').fill('{{baseUrl}}/nope')
  await section_(win, 'Headers')
  await addRow(win, 'headers-grid', 'X-Missing', '{{vault:does-not-exist}}')
  await win.getByTestId('send-button').click()
  await win.getByTestId('response-error').waitFor()
  const errText = await win.getByTestId('response-error').innerText()
  check('unresolved vault ref shows a clear error (request not sent)', /not found/i.test(errText) && !echo.requests.some((r) => r.url === '/nope'), errText)
  await shot(win, '05-vault-error')
  // Key Vault browser
  await win.getByTestId('vault-button').click()
  await win.locator('[data-testid="vault-secret"][data-name="db-password"]').waitFor()
  await win.getByRole('button', { name: 'Reveal db-password' }).click()
  await win.getByTestId('revealed-value').waitFor()
  check('Key Vault browser lists names and reveals on demand', (await win.getByTestId('revealed-value').innerText()).includes(DB_SECRET))
  await shot(win, '06-vault-browser')
  await closeModal(win)

  // -------------------------------------------------------------------------------------------
  section('c. create a team, move to it (secret warning), sync; a second instance joins the team')
  await win.getByTestId('sidebar-tab-collections').click()
  const createdA = await teamVia(win, azurite.url, CONTAINER, { create: 'Platform' })
  check('A: Settings → Teams: lookup finds no manifest, "Create team" writes it', createdA.result === 'created', JSON.stringify(createdA))
  const platformCard = win.locator('[data-testid="team-card"][data-team-name="Platform"]')
  await platformCard.waitFor()
  await platformCard.getByTestId('team-test-connection').click()
  const conn = await platformCard.getByTestId('team-connection-result').innerText()
  check('Test connection succeeds against Azurite', /Connected to container/.test(conn), conn)
  const manifestBlob = await listBlobs(azurite.url, CONTAINER, ALICE, pki.cert)
  check('team manifest courier-team.json written at the container root', manifestBlob.includes('courier-team.json'), manifestBlob.join(', '))
  await closeModal(win)
  await teamGroup(win, 'Platform').waitFor()
  check('sidebar shows the Personal group and a group for the new team', (await win.getByTestId('personal-group').isVisible()) && (await teamGroup(win, 'Platform').isVisible()))
  await menu(win, node(win, 'E2E API'), 'Move to…', 'Team: Platform')
  await win.getByTestId('warnings-dialog').waitFor()
  const findings = await win.getByTestId('findings').innerText()
  check('moving to a team shows the secret-scan warning for the literal X-Api-Key', /X-Api-Key/.test(findings), findings)
  check('warning suggests Key Vault references', /vault:/.test(await win.getByTestId('warnings-dialog').innerText()))
  await shot(win, '07-move-team-warnings')
  await win.getByTestId('warnings-proceed').click()
  await teamGroup(win, 'Platform').locator('[data-name="E2E API"]').waitFor()
  check('collection is now in the team group with a pending-change dot', await teamGroup(win, 'Platform').getByTestId('dirty-indicator').isVisible())
  const s1 = await syncVia(win, '08a')
  check('first sync uploads (after acknowledging the warning)', s1 === 'ok', s1)
  const ov = await win.evaluate(() => window.courier.sync.status())
  check('nothing pending after sync', ov.value.pending === 0 && ov.value.lastReport?.uploaded.some((r) => r.name === 'E2E API'), JSON.stringify(ov.value).slice(0, 300))
  await win.getByTestId('sync-panel-button').click()
  await win.locator('[data-testid="sync-team"][data-team-name="Platform"] [data-testid="sync-item"]').first().waitFor()
  await shot(win, '08-sync-panel')
  await closeModal(win)

  B = await launchApp({ userData: udB, identity: BOB, cert: pki.cert, colorScheme: 'light' })
  const winB = B.win
  watchErrors(winB, 'B', errors)
  await winB.getByTestId('onboarding').waitFor()
  check('B: sign in as a different identity', await signInVia(winB, BOB.upn))
  const joinedB = await teamVia(winB, azurite.url, CONTAINER)
  check('B: Join team reads the name from the manifest', joinedB.result === 'joined' && joinedB.name === 'Platform', JSON.stringify(joinedB))
  await closeModal(winB)
  const sB = await syncVia(winB, '09b')
  check('B: sync downloads the team collection', sB === 'ok', sB)
  await teamGroup(winB, 'Platform').locator('[data-name="E2E API"]').waitFor()
  check('B: collection appears under the team', true)
  await node(winB, 'E2E API').click()
  await node(winB, 'Echo').click()
  await winB.getByTestId('url-input').waitFor()
  check('B: downloaded request content is intact', (await winB.getByTestId('url-input').inputValue()) === '{{baseUrl}}/echo?x=1&y=2')
  await shot(winB, '09-second-instance')

  // A edits: replace the literal key with a Key Vault reference (the hint from the warning), save, sync
  await node(win, 'Echo').click()
  await section_(win, 'Headers')
  const keyRow = win.locator('[data-testid="headers-grid"] tr[data-testid="kv-row"]').first()
  await keyRow.getByLabel('Value', { exact: true }).fill('{{vault:main/api-key}}')
  await win.keyboard.press(`${MOD}+s`)
  await toast(win, /Saved "Echo"/).waitFor()
  const sA2 = await syncVia(win, '10a')
  check('A: edit uploads without warnings (literal replaced by vault ref)', sA2 === 'ok', sA2)
  // B edits the same request concurrently
  await section_(winB, 'Params')
  await addRow(winB, 'params-grid', 'from', 'bob')
  await winB.keyboard.press(`${MOD}+s`)
  await toast(winB, /Saved "Echo"/).waitFor()
  const sB2 = await syncVia(winB, '10b')
  check('B: sync detects the conflict and opens the conflict dialog', sB2 === 'conflict', sB2)
  if (sB2 === 'conflict') {
    await winB.getByTestId('conflict-summary').waitFor()
    const summary = await winB.getByTestId('conflict-summary').innerText()
    check('conflict dialog shows mine vs theirs', /Mine/.test(summary) && /Theirs/.test(summary) && /alice@contoso\.test/.test(await winB.getByTestId('conflict-dialog').innerText()), summary.slice(0, 300))
    await shot(winB, '11-conflict-dialog')
    await winB.getByTestId('conflict-mine').click()
    // keeping B's version re-uploads the literal key → secret warning → proceed
    for (let i = 0; i < 60; i++) {
      if (await winB.getByTestId('warnings-dialog').isVisible()) {
        await winB.getByTestId('warnings-proceed').click()
        break
      }
      if (await toast(winB, /^Synced/).isVisible()) break
      await winB.waitForTimeout(100)
    }
    await winB.waitForFunction(() => window.courier.sync.status().then((r) => r.value.conflicts.length === 0 && r.value.pending === 0), null, { timeout: 15000 })
    check('B: conflict resolved with "Keep mine" and uploaded', true)
  }
  const sA3 = await syncVia(win, '12a')
  check('A: next sync downloads the resolved version', sA3 === 'ok', sA3)
  await win.waitForFunction(() => document.querySelector('[data-testid="url-input"]')?.value.includes('from=bob'), null, { timeout: 10000 })
  check('A: open clean tab follows the downloaded version', (await win.getByTestId('url-input').inputValue()).includes('from=bob'))

  // -------------------------------------------------------------------------------------------
  section('c2. a second team proves isolation')
  const research = await teamVia(win, azurite.url, CONTAINER2, { create: 'Research' })
  check('A: creates a second team in another container', research.result === 'created', JSON.stringify(research))
  await closeModal(win)
  await win.getByTestId('new-collection').click()
  await win.getByTestId('prompt-input').fill('Research Notes')
  await win.getByTestId('location-select').selectOption({ label: 'Team: Research' })
  await win.getByTestId('prompt-confirm').click()
  await teamGroup(win, 'Research').locator('[data-name="Research Notes"]').waitFor()
  check('A: new collection created straight into the second team', true)
  const sR = await syncVia(win, '12r')
  check('A: sync uploads to the second team', sR === 'ok', sR)
  const researchId = await win.evaluate(() => window.courier.workspace.load().then((r) => r.value.collections.find((c) => c.collection.name === 'Research Notes').collection.id))
  const blobs1 = await listBlobs(azurite.url, CONTAINER, ALICE, pki.cert)
  const blobs2 = await listBlobs(azurite.url, CONTAINER2, ALICE, pki.cert)
  check('each team container holds only its own items', blobs2.includes(`shared/collections/${researchId}.json`) && !blobs1.some((b) => b.includes(researchId)), `${blobs1.join(',')} | ${blobs2.join(',')}`)
  await win.getByTestId('sync-panel-button').click()
  check('sync panel is grouped by team', (await win.getByTestId('sync-team').count()) === 2)
  await closeModal(win)
  const sB3 = await syncVia(winB, '12b')
  const snapB = await winB.evaluate(() => window.courier.workspace.load())
  check('B (member of Platform only) never sees the other team', sB3 === 'ok' && !snapB.value.collections.some((c) => c.collection.name === 'Research Notes') && snapB.value.teams.length === 1 && !(await teamGroup(winB, 'Research').count()), JSON.stringify(snapB.value.teams.map((t) => t.name)))

  // -------------------------------------------------------------------------------------------
  section('c3. team Key Vault from the team manifest, with the approval prompt on another machine')
  await openSettings(win, 'teams')
  await platformCard.getByTestId('team-edit-vaults').click()
  await platformCard.getByTestId('team-add-vault').click()
  const tvRow = platformCard.getByTestId('team-vault-edit-row').last()
  await tvRow.getByLabel('Team vault alias').fill('teamkv')
  await tvRow.getByLabel('Team vault URL').fill(vault.url)
  await platformCard.getByTestId('team-vaults-save').click()
  await toast(win, /Saved the Key Vaults of team "Platform"/).waitFor()
  await platformCard.locator('[data-testid="team-vault-row"][data-alias="teamkv"][data-approved="true"]').waitFor()
  check('A: team vault saved to the manifest (approved for the editor)', true)
  await shot(win, '28-teams-settings')
  await closeModal(win)
  await menu(win, node(win, 'E2E API'), 'Add request')
  await win.getByTestId('request-editor').waitFor()
  await win.getByTestId('request-name').click()
  await win.getByLabel('Request name').fill('Team Vault')
  await win.getByLabel('Request name').press('Enter')
  await win.getByTestId('url-input').fill(`${echo.url}/team-vault`)
  await section_(win, 'Headers')
  await addRow(win, 'headers-grid', 'X-Team-Secret', '{{vault:teamkv/api-key}}')
  await win.keyboard.press(`${MOD}+s`)
  await toast(win, /Saved "Team Vault"/).waitFor()
  await win.getByTestId('send-button').click()
  await win.locator('[data-testid="response-status"]', { hasText: /^200/ }).waitFor()
  check('A: {{vault:teamkv/…}} resolves through the team vault', echo.requests.at(-1)?.headers['x-team-secret'] === SECRET)
  const sA4 = await syncVia(win, '13a')
  check('A: request uploaded to the team', sA4 === 'ok', sA4)
  const sB4 = await syncVia(winB, '13b')
  check('B: sync picks up the request and the new team vault', sB4 === 'ok', sB4)
  await node(winB, 'Team Vault').click()
  const hitsBefore = vault.hits.length
  const teamVaultSends = () => echo.requests.filter((r) => r.url === '/team-vault').length
  const sendsBefore = teamVaultSends()
  await winB.getByTestId('send-button').click()
  const notApproved = winB.locator('[data-testid="response-error"][data-code="VAULT_NOT_APPROVED"]')
  await notApproved.waitFor()
  check('B: unapproved team vault host blocks the request (VAULT_NOT_APPROVED), nothing sent, vault not contacted', teamVaultSends() === sendsBefore && vault.hits.length === hitsBefore && new RegExp(new URL(vault.url).host.replace(/\./g, '\\.')).test(await notApproved.innerText()), await notApproved.innerText())
  await notApproved.getByTestId('review-team-vaults').click()
  await winB.getByTestId('team-vaults-dialog').waitFor()
  const hostShown = await winB.locator('[data-testid="team-vault-row"][data-alias="teamkv"] [data-testid="team-vault-host"]').innerText()
  check('B: approval prompt shows the vault host', hostShown === new URL(vault.url).host, hostShown)
  await shot(winB, '29-team-vault-approval')
  await winB.getByTestId('approve-team-vault').click()
  await winB.locator('[data-testid="team-vault-row"][data-alias="teamkv"][data-approved="true"]').waitFor()
  await closeModal(winB)
  await winB.getByTestId('send-button').click()
  await winB.locator('[data-testid="response-status"]', { hasText: /^200/ }).waitFor()
  check('B: after approval the team vault reference resolves (B configured no vault of its own)', echo.requests.at(-1)?.headers['x-team-secret'] === SECRET && !(await winB.evaluate(() => document.body.innerText)).includes(SECRET))

  // -------------------------------------------------------------------------------------------
  section('c4. read-only join, a failing team does not block the others, rename, leave with unsynced changes')
  const scratch = await teamVia(win, azurite.url, CONTAINER3, { readOnly: 'Scratch' })
  check('A: a container without team settings can be joined read-only under a chosen name', scratch.result === 'joined read-only', JSON.stringify(scratch))
  const scratchCard = win.locator('[data-testid="team-card"][data-team-name="Scratch"]')
  check('A: the card offers to create the team settings', await scratchCard.getByTestId('team-create-settings').isVisible())
  await closeModal(win)
  await win.getByTestId('new-collection').click()
  await win.getByTestId('prompt-input').fill('Scratch Pad')
  await win.getByTestId('location-select').selectOption({ label: 'Team: Scratch' })
  await win.getByTestId('prompt-confirm').click()
  await teamGroup(win, 'Scratch').locator('[data-name="Scratch Pad"]').waitFor()
  await deleteContainer(azurite.url, CONTAINER3, ALICE, pki.cert)
  await dismissToasts(win)
  await win.getByTestId('sync-button').click()
  const badge = teamGroup(win, 'Scratch').getByTestId('team-error-badge')
  await badge.waitFor({ timeout: 15000 })
  const afterFail = await win.evaluate(() => window.courier.sync.status())
  const byName = Object.fromEntries((afterFail.value.lastReport?.teams ?? []).map((t) => [t.name, t.ok]))
  check('the failing team gets an error badge (CONTAINER_NOT_FOUND) while the other teams sync', (await badge.getAttribute('data-code')) === 'CONTAINER_NOT_FOUND' && byName.Platform === true && byName.Research === true && byName.Scratch === false, JSON.stringify(byName))
  await shot(win, '30-team-error-badge')
  await openSettings(win, 'teams')
  const researchCard = win.locator('[data-testid="team-card"][data-team-name="Research"]')
  await researchCard.getByTestId('team-rename').click()
  await researchCard.getByTestId('team-rename-input').fill('Research Lab')
  await researchCard.getByTestId('team-rename-save').click()
  await win.locator('[data-testid="team-card"][data-team-name="Research Lab"]').waitFor()
  const probed = await win.evaluate((u) => window.courier.teams.probe({ accountUrl: u, container: 'courier-research' }), azurite.url)
  check('rename writes the new name to the team settings in the container', probed.ok && probed.value.manifest?.name === 'Research Lab', JSON.stringify(probed).slice(0, 200))
  await scratchCard.getByTestId('team-leave').click()
  await win.getByTestId('confirm-button').click()
  const second = win.locator('[data-testid="confirm-dialog"]', { hasText: 'Discard unsynced changes?' })
  await second.waitFor()
  check('leaving with unsynced changes asks again and lists them', /Scratch Pad/.test(await second.innerText()))
  await second.getByTestId('confirm-button').click()
  await toast(win, /Left team "Scratch"/).waitFor()
  await closeModal(win)
  const afterLeave = await win.evaluate(() => window.courier.workspace.load())
  check('after leaving, the team and its items are gone from this machine', !afterLeave.value.teams.some((t) => t.name === 'Scratch') && !afterLeave.value.collections.some((c) => c.collection.name === 'Scratch Pad') && (await teamGroup(win, 'Scratch').count()) === 0)
  check('A: Research is listed under its new name', await teamGroup(win, 'Research Lab').isVisible())

  // -------------------------------------------------------------------------------------------
  section('r. WebSocket and gRPC requests through the UI; sync to the team; the runner skips them')
  await dismissToasts(win)
  await win.getByTestId('sidebar-tab-collections').click()
  await win.getByTestId('new-collection').click()
  await win.getByTestId('prompt-input').fill('Realtime E2E')
  await win.getByTestId('prompt-confirm').click()
  await node(win, 'Realtime E2E').waitFor()
  await menu(win, node(win, 'Realtime E2E'), 'Add WebSocket request')
  await win.getByTestId('ws-editor').waitFor()
  await win.getByTestId('request-name').click()
  await win.getByLabel('Request name').fill('Live Echo')
  await win.getByLabel('Request name').press('Enter')
  await win.getByTestId('ws-url').fill(`${wsSrv.url}/live?room={{greeting}}`)
  await win.getByTestId('ws-connect').click()
  await win.locator('[data-testid="ws-status"][data-status="open"]').waitFor()
  const hsWs = wsSrv.handshakes.at(-1)
  check('WS: connects through the UI; {{variables}} in the URL resolve in main', hsWs?.path === '/live' && hsWs?.query.room === 'world', JSON.stringify(hsWs?.query))
  const wsMsg = '{"greet":"{{greeting}}","key":"{{vault:main/api-key}}"}'
  await typeInEditor(win, '[data-testid="ws-message-editor"]', wsMsg)
  await win.getByTestId('ws-send').click()
  await win.locator('[data-testid="ws-log"] [data-testid="log-row"][data-direction="in"]').first().waitFor()
  const wsReceived = wsSrv.received.at(-1)?.data.toString('utf8')
  check('WS: the server received the variable and the real Key Vault value', wsReceived === `{"greet":"world","key":"${SECRET}"}`, wsReceived)
  const wsPreviews = await win.locator('[data-testid="ws-log"] [data-testid="log-row"]:not([data-direction="info"]) [data-testid="log-preview"]').allInnerTexts()
  check('WS: the log shows both directions with the secret masked', wsPreviews.length === 2 && wsPreviews.every((t) => t === '{"greet":"world","key":"••••"}'), JSON.stringify(wsPreviews))
  check('WS: the secret appears nowhere in the window', !(await win.evaluate(() => document.body.innerText)).includes(SECRET))
  await win.getByTestId('ws-save-message').click()
  await win.getByTestId('prompt-input').fill('Greeting')
  await win.getByTestId('prompt-confirm').click()
  await win.locator('[data-testid="ws-sections"]').getByRole('tab', { name: /^Saved messages/ }).click()
  await win.locator('[data-testid="ws-saved-row"][data-name="Greeting"]').waitFor()
  await win.keyboard.press(`${MOD}+s`)
  await toast(win, /Saved "Live Echo"/).waitFor()
  check('the sidebar shows a WS badge for the WebSocket request', (await node(win, 'Live Echo').getByTestId('kind-badge').innerText()) === 'WS')
  const savedWs = await win.evaluate(() => window.courier.workspace.load().then((r) => r.value.collections.find((c) => c.collection.name === 'Realtime E2E').collection.items.find((i) => i.name === 'Live Echo')))
  check('WS: the saved message is stored on the request', savedWs?.type === 'websocket' && savedWs.savedMessages.length === 1 && savedWs.savedMessages[0].name === 'Greeting' && savedWs.savedMessages[0].body === wsMsg, JSON.stringify(savedWs?.savedMessages))
  // A message that is sent but never saved: only the in-memory log holds it.
  await win.locator('[data-testid="ws-sections"]').getByRole('tab', { name: /^Message$/ }).click()
  await typeInEditor(win, '[data-testid="ws-message-editor"]', LOG_ONLY)
  await win.getByTestId('ws-send').click()
  await win.locator('[data-testid="ws-log"] [data-testid="log-preview"]', { hasText: LOG_ONLY }).nth(1).waitFor()
  await typeInEditor(win, '[data-testid="ws-message-editor"]', wsMsg)
  check('WS: restoring the saved message leaves the tab clean', !(await win.locator('[data-testid="tab"][data-title="Live Echo"] .tab-close.dirty').isVisible()))
  await win.locator('[data-testid="ws-sections"]').getByRole('tab', { name: /^Saved messages/ }).click()
  await win.getByTestId('ws-saved-send').click()
  await win.waitForFunction(() => document.querySelectorAll('[data-testid="ws-log"] [data-testid="log-row"][data-direction="in"]').length === 3)
  check('WS: one click sends a saved message', wsSrv.received.length >= 2 && wsSrv.received.at(-1).data.toString('utf8').includes(SECRET))
  await win.locator('[data-testid="ws-sections"]').getByRole('tab', { name: /^Message$/ }).click()
  await win.locator('[data-testid="ws-log"] [data-testid="log-row"][data-direction="in"] .log-line').first().click()
  await shot(win, '40-websocket-light')
  await win.locator('[data-testid="ws-pane-tabs"]').getByRole('tab', { name: /^Handshake/ }).click()
  check('WS: the handshake tab shows 101 and the request headers', /101/.test(await win.getByTestId('ws-handshake-status').innerText()) && (await win.getByTestId('ws-request-headers').innerText()).toLowerCase().includes('sec-websocket-key'))
  await shot(win, '41-websocket-handshake')
  await win.locator('[data-testid="ws-sections"]').getByRole('tab', { name: /^Settings/ }).click()
  await shot(win, '41a-websocket-settings')
  await win.locator('[data-testid="ws-sections"]').getByRole('tab', { name: /^Message$/ }).click()
  await win.locator('[data-testid="ws-pane-tabs"]').getByRole('tab', { name: /^Messages/ }).click()
  await win.getByTestId('ws-disconnect').click()
  await win.locator('[data-testid="ws-status"][data-status="closed"]').waitFor()
  check('WS: disconnect shows closed 1000', /1000/.test(await win.getByTestId('ws-status').innerText()))
  // ⌘/Ctrl+Enter connects; closing the tab closes the connection.
  await win.keyboard.press(`${MOD}+Enter`)
  await win.locator('[data-testid="ws-status"][data-status="open"]').waitFor()
  check('WS: ⌘/Ctrl+Enter connects', wsSrv.clients() === 1, String(wsSrv.clients()))
  await win.locator('[data-testid="tab"][data-title="Live Echo"] [data-testid="tab-close"]').click()
  const t0 = Date.now()
  while (wsSrv.clients() > 0 && Date.now() - t0 < 5000) await win.waitForTimeout(50)
  check('WS: closing the tab closes the connection', wsSrv.clients() === 0, String(wsSrv.clients()))

  await menu(win, node(win, 'Realtime E2E'), 'Add gRPC request')
  await win.getByTestId('grpc-editor').waitFor()
  await win.getByTestId('request-name').click()
  await win.getByLabel('Request name').fill('Say Hello')
  await win.getByLabel('Request name').press('Enter')
  await win.getByTestId('grpc-address').fill(grpcSrv.address)
  await win.getByTestId('grpc-reflect').click()
  await win.locator('[data-testid="grpc-descriptor-info"][data-source="reflection"]').waitFor()
  check('gRPC: server reflection loads the service definition', /1 service, 7 methods/.test(await win.getByTestId('grpc-descriptor-info').innerText()))
  const pickMethod = async (name) => {
    await win.getByTestId('grpc-method-picker').click()
    await win.getByTestId('grpc-method-search').fill(name)
    await win.locator(`[data-testid="grpc-method-option"][data-path="/courier.test.v1.Echo/${name}"]`).click()
  }
  await pickMethod('Say')
  await win.waitForFunction(() => document.querySelector('[data-testid="grpc-message"]')?.textContent?.includes('"sentAt"'))
  check('gRPC: picking a method fills in a generated example message', true)
  await typeInEditor(win, '[data-testid="grpc-message"]', '{"text":"{{greeting}}-{{vault:main/api-key}}","times":2}')
  await win.getByTestId('grpc-invoke').click()
  await win.locator('[data-testid="grpc-status"][data-name="OK"]').waitFor()
  const unaryIn = await win.locator('[data-testid="grpc-log"] [data-testid="log-row"][data-direction="in"] [data-testid="log-preview"]').first().innerText()
  check('gRPC: unary call through the UI; variables and the vault value resolve in main and are masked', unaryIn.includes('"text": "world-••••world-••••"') && !(await win.evaluate(() => document.body.innerText)).includes(SECRET), unaryIn.slice(0, 200))
  await win.locator('[data-testid="grpc-log"] [data-testid="log-row"][data-direction="in"] .log-line').first().click()
  await shot(win, '42-grpc-unary-light')
  // .proto import with an import directory (native dialogs stubbed).
  await win.locator('[data-testid="grpc-sections"]').getByRole('tab', { name: /^Service definition/ }).click()
  await setDialogPaths(A.app, { open: ECHO_PROTO })
  await win.getByTestId('grpc-pick-protos').click()
  await setDialogPaths(A.app, { open: PROTO_ROOT })
  await win.getByTestId('grpc-add-import-dir').click()
  await win.getByTestId('grpc-load-protos').click()
  await win.locator('[data-testid="grpc-descriptor-info"][data-source="proto"]').waitFor()
  const protoInfo = await win.getByTestId('grpc-descriptor-info').innerText()
  check('gRPC: .proto import with an import directory (well-known types built in); only file names are kept', /courier\/test\/v1\/echo\.proto, courier\/test\/v1\/common\.proto/.test(protoInfo) && !protoInfo.includes(PROTO_ROOT), protoInfo)
  await setDialogPaths(A.app, { open: null })
  await shot(win, '43-grpc-proto-import')
  await win.locator('[data-testid="grpc-sections"]').getByRole('tab', { name: /^Message/ }).click()
  await pickMethod('Count')
  await typeInEditor(win, '[data-testid="grpc-message"]', '{"from":1,"to":4,"delayMs":20}')
  await win.getByTestId('grpc-invoke').click()
  await win.locator('[data-testid="grpc-status"][data-name="OK"]').waitFor()
  const streamed = (await win.locator('[data-testid="grpc-log"] [data-testid="log-row"][data-direction="in"] [data-testid="log-preview"]').allInnerTexts()).map((t) => JSON.parse(t).value)
  check('gRPC: server streaming shows each message in order', JSON.stringify(streamed) === '["1","2","3","4"]', JSON.stringify(streamed))
  await pickMethod('Chat')
  await typeInEditor(win, '[data-testid="grpc-message"]', '{"text":"one"}')
  await win.getByTestId('grpc-invoke').click()
  await win.locator('[data-testid="grpc-status"][data-name="RUNNING"]').waitFor()
  await win.getByTestId('grpc-send').click()
  await typeInEditor(win, '[data-testid="grpc-message"]', '{"text":"two"}')
  await win.keyboard.press(`${MOD}+Enter`)
  await win.waitForFunction(() => document.querySelectorAll('[data-testid="grpc-log"] [data-testid="log-row"][data-direction="in"]').length === 2)
  await win.getByTestId('grpc-end').click()
  await win.locator('[data-testid="grpc-status"][data-name="OK"]').waitFor()
  const chat = (await win.locator('[data-testid="grpc-log"] [data-testid="log-row"][data-direction="in"] [data-testid="log-preview"]').allInnerTexts()).map((t) => JSON.parse(t).text)
  check('gRPC: bidirectional exchange (Send, ⌘/Ctrl+Enter, End stream)', JSON.stringify(chat) === '["echo: one","echo: two"]', JSON.stringify(chat))
  await shot(win, '44-grpc-bidi')
  await pickMethod('Fail')
  await typeInEditor(win, '[data-testid="grpc-message"]', '{"code":16,"message":"token expired"}')
  await win.getByTestId('grpc-invoke').click()
  await win.locator('[data-testid="grpc-error"][data-code="UNAUTHENTICATED"]').waitFor()
  check('gRPC: an error status is shown with its name, message and a hint', /UNAUTHENTICATED: token expired[\s\S]*Authorization tab/.test(await win.getByTestId('grpc-error').innerText()))
  await shot(win, '45-grpc-error')
  await win.locator('[data-testid="grpc-sections"]').getByRole('tab', { name: /^Settings/ }).click()
  await shot(win, '45a-grpc-settings')
  await win.locator('[data-testid="grpc-sections"]').getByRole('tab', { name: /^Message/ }).click()
  await typeInEditor(win, '[data-testid="grpc-message"]', '{"cod":1}')
  await win.getByTestId('grpc-invoke').click()
  await win.locator('[data-testid="grpc-error"][data-code="PREPARE"]').waitFor()
  check('gRPC: JSON that does not match the message names the field', /Field "cod": courier\.test\.v1\.FailRequest has no field "cod"/.test(await win.getByTestId('grpc-error').innerText()))
  await pickMethod('Say')
  await typeInEditor(win, '[data-testid="grpc-message"]', '{"text":"hello from the team"}')
  await win.keyboard.press(`${MOD}+s`)
  await toast(win, /Saved "Say Hello"/).waitFor()
  // An HTTP request too, so the runner has something to run.
  await menu(win, node(win, 'Realtime E2E'), 'Add request')
  await win.getByTestId('request-editor').waitFor()
  await win.getByTestId('request-name').click()
  await win.getByLabel('Request name').fill('Realtime Ping')
  await win.getByLabel('Request name').press('Enter')
  await win.getByTestId('url-input').fill('{{baseUrl}}/realtime-ping')
  await win.keyboard.press(`${MOD}+s`)
  await toast(win, /Saved "Realtime Ping"/).waitFor()
  await win.getByTestId('runner-button').click()
  await win.getByTestId('runner').waitFor()
  await win.getByTestId('runner-collection').selectOption({ label: 'Realtime E2E' })
  check('runner: notes before the run that WebSocket/gRPC requests are not run', /2 WebSocket\/gRPC requests are not run.*"Live Echo" \(WebSocket\), "Say Hello" \(gRPC\)/.test(await win.getByTestId('runner-skipped-note').innerText()))
  await win.getByTestId('runner-iterations').fill('1')
  await win.getByTestId('runner-start').click()
  await win.getByTestId('runner-summary').waitFor({ timeout: 30000 })
  check('runner: runs the HTTP request only and lists the skipped ones in the summary', (await win.locator('[data-testid="run-result"]').count()) === 1 && /Skipped: 2 WebSocket\/gRPC requests/.test(await win.getByTestId('runner-skipped').innerText()) && echo.requests.some((r) => r.url === '/realtime-ping'))
  await shot(win, '46-runner-skips-realtime')
  // To the team; B gets both items and invokes with the synced definition (no .proto files there).
  await menu(win, node(win, 'Realtime E2E'), 'Move to…', 'Team: Platform')
  if (await win.getByTestId('warnings-dialog').isVisible().catch(() => false)) await win.getByTestId('warnings-proceed').click()
  await teamGroup(win, 'Platform').locator('[data-name="Realtime E2E"]').waitFor()
  const sRt = await syncVia(win, '47a')
  check('A: the collection with WebSocket/gRPC items uploads to the team', sRt === 'ok', sRt)
  await winB.bringToFront()
  const sRB = await syncVia(winB, '47b')
  check('B: sync downloads it', sRB === 'ok', sRB)
  await teamGroup(winB, 'Platform').locator('[data-name="Realtime E2E"]').waitFor()
  await node(winB, 'Realtime E2E').click()
  check('B: the WebSocket and gRPC items appear with their kind badges', (await node(winB, 'Live Echo').getByTestId('kind-badge').innerText()) === 'WS' && (await node(winB, 'Say Hello').getByTestId('kind-badge').innerText()) === 'gRPC')
  await node(winB, 'Say Hello').click()
  await winB.getByTestId('grpc-editor').waitFor()
  await winB.getByTestId('grpc-invoke').click()
  await winB.locator('[data-testid="grpc-status"][data-name="OK"]').waitFor()
  check('B: invokes with the synced service definition', (await winB.locator('[data-testid="grpc-log"] [data-testid="log-row"][data-direction="in"] [data-testid="log-preview"]').first().innerText()).includes('hello from the team'))
  await shot(winB, '48-grpc-second-instance')
  await win.bringToFront()

  // -------------------------------------------------------------------------------------------
  section('d. runner over the collection, 2 iterations')
  await win.getByTestId('runner-button').click()
  await win.getByTestId('runner').waitFor()
  await win.getByTestId('runner-collection').selectOption({ label: 'E2E API' })
  await win.getByTestId('runner-iterations').fill('2')
  await win.getByTestId('runner-start').click()
  await win.getByTestId('runner-summary').waitFor({ timeout: 30000 })
  const runRows = await win.getByTestId('run-result').evaluateAll((els) => els.map((e) => e.getAttribute('data-passed')))
  check('runner shows 4 results (2 requests × 2 iterations, incl. the team-vault request), all passed', JSON.stringify(runRows) === '["true","true","true","true"]', JSON.stringify(runRows))
  check('runner summary counts tests', (await win.getByTestId('runner-passed').innerText()) === '4')
  await shot(win, '13-runner')

  // -------------------------------------------------------------------------------------------
  section('e. import Postman v2.1 sample, send one of its requests; export; cURL paste')
  await setDialogPaths(A.app, { open: join(ROOT, 'tests/fixtures/postman-sample.postman_collection.json') })
  await win.getByTestId('import-button').click()
  await win.getByTestId('import-file').click()
  await toast(win, /Imported collection "Contoso Orders API"/).waitFor()
  if (await win.getByTestId('import-dialog').isVisible()) await win.getByTestId('import-dialog').getByRole('button', { name: 'Done' }).click()
  await node(win, 'Orders').click()
  await node(win, 'List orders').click()
  await win.getByTestId('send-button').click()
  await win.getByTestId('response-status').waitFor()
  const iwire = echo.requests.at(-1)
  check('imported request sent (env baseUrl overrides the collection var)', iwire?.url.startsWith('/orders?status=open') && (await win.getByTestId('response-status').innerText()).startsWith('200'), JSON.stringify(iwire?.url))
  await responseTab(win, 'Tests')
  check('imported collection/request tests ran and passed', (await win.getByTestId('test-result').count()) >= 2 && (await win.locator('[data-testid="test-result"][data-passed="false"]').count()) === 0)
  await shot(win, '14-imported-request')
  const exportPath = join(exportDir, 'contoso.postman_collection.json')
  await setDialogPaths(A.app, { save: exportPath })
  await menu(win, node(win, 'Contoso Orders API'), 'Export…')
  await win.getByTestId('export-confirm').click()
  await toast(win, /Exported to/).waitFor()
  const exported = existsSync(exportPath) ? JSON.parse(readFileSync(exportPath, 'utf8')) : null
  check('export wrote a Postman v2.1 collection', exported?.info?.schema?.includes('v2.1.0') && exported.item?.some((i) => i.name === 'Orders'), JSON.stringify(exported?.info))
  await win.getByTestId('import-button').click()
  await win.getByTestId('import-mode-text').click()
  await win.getByTestId('import-text').fill(`curl -X PUT '${echo.url}/from-curl' -H 'X-From: curl' --data 'a=1'`)
  await win.getByTestId('import-text-confirm').click()
  await toast(win, /as a new request/).waitFor()
  await win.getByTestId('send-button').click()
  await win.getByTestId('response-status').waitFor()
  const cwire = echo.requests.at(-1)
  check('cURL paste opens a draft tab that sends', cwire?.method === 'PUT' && cwire.url === '/from-curl' && cwire.headers['x-from'] === 'curl', JSON.stringify(cwire).slice(0, 200))

  // -------------------------------------------------------------------------------------------
  section('g. smoke: Save As, drag-and-drop, folder/collection settings, dialogs, auth/body modes, layout, menu')
  await menu(win, node(win, 'Saved Drafts'), 'Add request')
  await node(win, 'New Request').waitFor()
  await node(win, 'New Request').dragTo(node(win, 'Vaulted'), { targetPosition: { x: 40, y: 3 } })
  await win.waitForFunction(() => window.courier.workspace.load().then((r) => r.value.collections.find((c) => c.collection.name === 'Saved Drafts')?.collection.items[0]?.name === 'New Request'), null, { timeout: 5000 }).catch(() => undefined)
  const order = await win.evaluate(() => window.courier.workspace.load().then((r) => r.value.collections.find((c) => c.collection.name === 'Saved Drafts').collection.items.map((i) => i.name)))
  check('drag-and-drop reorders requests', JSON.stringify(order) === '["New Request","Vaulted"]', JSON.stringify(order))
  await menu(win, node(win, 'Saved Drafts'), 'Add folder')
  await win.getByTestId('prompt-input').fill('Folder A')
  await win.getByTestId('prompt-confirm').click()
  await node(win, 'Folder A').dblclick()
  await win.getByTestId('container-editor').waitFor()
  await win.locator('[data-testid="container-editor"]').getByRole('tab', { name: /^Authorization/ }).click()
  await win.getByTestId('auth-type').selectOption('bearer')
  await win.getByLabel('Token').fill('{{folderToken}}')
  await win.getByTestId('save-button').click()
  await toast(win, /Saved "Folder A"/).waitFor()
  const folderAuth = await win.evaluate(() => window.courier.workspace.load().then((r) => r.value.collections.find((c) => c.collection.name === 'Saved Drafts').collection.items.find((i) => i.name === 'Folder A').auth))
  check('folder auth saved from the folder settings tab', folderAuth.type === 'bearer' && folderAuth.token === '{{folderToken}}', JSON.stringify(folderAuth))
  await node(win, 'Saved Drafts').dblclick()
  await win.locator('[data-testid="container-editor"]').getByRole('tab', { name: /^Variables/ }).click()
  const cvars = win.locator('[data-testid="collection-vars"]')
  await cvars.getByLabel('New variable name').fill('colVar')
  await cvars.locator('tr[data-testid="var-row"]').last().getByLabel('Shared value').fill('one')
  await win.getByTestId('save-button').click()
  await toast(win, /Saved "Saved Drafts"/).waitFor()
  const cv = await win.evaluate(() => window.courier.workspace.load().then((r) => r.value.collections.find((c) => c.collection.name === 'Saved Drafts').collection.variables))
  check('collection variable saved', cv.some((v) => v.key === 'colVar' && v.value === 'one'), JSON.stringify(cv))
  // request in a folder with inherited auth shows the source
  await menu(win, node(win, 'Folder A'), 'Add request')
  await win.getByTestId('request-editor').waitFor()
  await section_(win, 'Authorization')
  await win.getByTestId('inherited-auth').waitFor()
  await win.waitForFunction(() => !document.querySelector('[data-testid="inherited-auth"]')?.textContent?.includes('Resolving'), null, { timeout: 5000 }).catch(() => undefined)
  check('inherit shows the effective auth source', /Bearer token.*Folder A/.test(await win.getByTestId('inherited-auth').innerText()), await win.getByTestId('inherited-auth').innerText())
  for (const t of ['none', 'basic', 'bearer', 'apikey', 'oauth2', 'entra', 'inherit']) await win.getByTestId('auth-type').selectOption(t)
  await win.getByTestId('auth-type').selectOption('entra')
  await win.getByTestId('entra-scope').fill('https://graph.microsoft.com/.default')
  await shot(win, '15-auth-entra')
  await section_(win, 'Body')
  for (const m of ['raw', 'x-www-form-urlencoded', 'form-data', 'GraphQL', 'binary', 'none']) await win.getByRole('radio', { name: m, exact: true }).check()
  await win.getByRole('radio', { name: 'form-data', exact: true }).check()
  await win.locator('[data-testid="formdata-grid"]').getByLabel('New key').fill('upload')
  await win.locator('[data-testid="formdata-grid"] tr[data-testid="kv-row"]').last().getByLabel('Field type').selectOption('file')
  await shot(win, '16-body-formdata')
  check('auth types and body modes render without errors', errors.length === 0, errors.join('\n'))
  // middle-click closes a tab
  const tabCount = await win.getByTestId('tab').count()
  await win.getByTestId('tab').last().click({ button: 'middle' })
  const confirmClose = win.getByTestId('confirm-dialog')
  if (await confirmClose.isVisible().catch(() => false)) await confirmClose.getByRole('button', { name: "Don't save" }).click()
  check('middle-click closes the tab', (await win.getByTestId('tab').count()) === tabCount - 1)
  // code snippets (the saved "Vaulted" request has a Key Vault header → masked)
  await node(win, 'Vaulted').click()
  await win.getByTestId('code-button').click()
  await win.locator('[data-testid="snippet-code"] .cm-content').waitFor()
  const curl = await win.getByTestId('snippet-code').innerText()
  await win.getByRole('radio', { name: 'JavaScript fetch' }).click()
  await win.waitForFunction(() => document.querySelector('[data-testid="snippet-code"]')?.textContent?.includes('fetch('))
  await win.getByRole('radio', { name: 'Python requests' }).click()
  await win.waitForFunction(() => document.querySelector('[data-testid="snippet-code"]')?.textContent?.includes('requests.'))
  check('code snippets: cURL / fetch / Python, secrets masked', curl.includes('curl') && curl.includes('••••') && !curl.includes(SECRET), curl.slice(0, 200))
  await shot(win, '17-code-snippet')
  await closeModal(win)
  // cookies
  await win.getByTestId('cookies-button').click()
  await win.getByTestId('cookie-row').first().waitFor()
  check('cookie manager lists the jar', (await win.getByTestId('cookie-row').count()) >= 1)
  await win.getByRole('button', { name: /^Delete cookie e2e/ }).first().click()
  await win.waitForFunction(() => window.courier.cookies.list().then((r) => !r.value.some((c) => c.key === 'e2e')))
  check('cookie deleted', true)
  await closeModal(win)
  // globals
  await win.getByTestId('sidebar-tab-environments').click()
  await win.getByTestId('globals-row').click()
  await win.locator('[data-testid="globals-vars"]').getByLabel('New variable name').fill('gVar')
  await win.locator('[data-testid="globals-vars"] tr[data-testid="var-row"]').last().getByLabel('Shared value').fill('g1')
  await win.getByTestId('save-button').click()
  await win.waitForFunction(() => window.courier.workspace.load().then((r) => r.value.globals.some((g) => g.key === 'gVar' && g.value === 'g1')))
  check('globals editor saves', true)
  await win.getByTestId('sidebar-tab-collections').click()
  // vault: copy reference + clear cache
  await win.getByTestId('vault-button').click()
  await win.locator('[data-testid="vault-secret"][data-name="api-key"]').getByRole('button', { name: 'Copy reference' }).click()
  await toast(win, /Copied \{\{vault:api-key\}\}/).waitFor()
  await win.getByTestId('vault-clear-cache').click()
  await toast(win, /cache cleared/).waitFor()
  check('vault: copy reference + clear cache', true)
  await closeModal(win)
  // layout toggle
  await node(win, 'Echo').click()
  await win.getByRole('button', { name: 'Toggle response layout' }).click()
  await win.locator('.req-split.horizontal').waitFor()
  await shot(win, '18-layout-side-by-side')
  await win.getByRole('button', { name: 'Toggle response layout' }).click()
  await win.locator('.req-split.vertical').waitFor()
  // native menu must not bind Cmd+W / Cmd+R (would close/reload the window and lose drafts)
  const roles = await A.app.evaluate(({ Menu }) => {
    const out = []
    const walk = (items) => {
      for (const i of items) {
        out.push(`${i.role ?? ''}|${i.accelerator ?? ''}`)
        if (i.submenu) walk(i.submenu.items)
      }
    }
    walk(Menu.getApplicationMenu()?.items ?? [])
    return out
  })
  check('application menu has no close/reload items or Cmd+W/Cmd+R accelerators', !roles.some((r) => /^(close|reload|forcereload)\|/i.test(r) || /\|(CmdOrCtrl|CommandOrControl|Cmd|Command)\+(W|R)$/i.test(r)), roles.join(', '))

  // -------------------------------------------------------------------------------------------
  section('h. auth types against local fake servers: Digest, AWS SigV4, NTLM, JWT, OAuth 2.0 code + PKCE')
  const addRequestVia = async (collection, name, url) => {
    await menu(win, node(win, collection), 'Add request')
    await win.getByTestId('request-editor').waitFor()
    await win.getByTestId('request-name').click()
    await win.getByLabel('Request name').fill(name)
    await win.getByLabel('Request name').press('Enter')
    await win.getByTestId('url-input').fill(url)
    await section_(win, 'Authorization')
  }
  const sendNow = async () => {
    await win.getByTestId('send-button').click()
    await win.getByTestId('response-status').waitFor()
    return win.getByTestId('response-status').innerText()
  }
  const sentAuthHeader = async () => {
    await responseTab(win, 'Request')
    return win.getByTestId('sent-headers').innerText()
  }
  await win.getByTestId('sidebar-tab-collections').click()
  await win.getByTestId('new-collection').click()
  await win.getByTestId('prompt-input').fill('Auth Types')
  await win.getByTestId('prompt-confirm').click()
  await node(win, 'Auth Types').waitFor()

  await addRequestVia('Auth Types', 'Digest', `${authSrv.url}/digest/res?x=1`)
  await win.getByTestId('auth-type').selectOption('digest')
  await win.getByTestId('digest-username').fill(AUTH_USER.name)
  await win.getByTestId('digest-password').fill(AUTH_USER.password)
  let st = await sendNow()
  check('Digest: the 401 challenge is answered and the server verifies the MD5 response', st.startsWith('200') && authSrv.hits.digest.at(-1)?.ok === true, `${st} ${JSON.stringify(authSrv.hits.digest)}`)
  let shown = await sentAuthHeader()
  check('Digest: the Authorization value is masked in the Request view', /Authorization\s+••••/.test(shown) && !shown.includes(AUTH_USER.password), shown)

  await addRequestVia('Auth Types', 'AWS', `${authSrv.url}/aws/functions/arn:aws:lambda:eu-west-1:000000000000:function:e2e/invoke?b=2&a=1`)
  await win.getByTestId('auth-type').selectOption('awsv4')
  await win.getByTestId('aws-access-key').fill(AWS_KEYS.accessKey)
  await win.getByTestId('aws-secret-key').fill(AWS_KEYS.secretKey)
  await win.getByTestId('aws-region').fill('eu-west-1')
  await win.getByTestId('aws-service').fill('execute-api')
  st = await sendNow()
  check('AWS SigV4: an independent verifier on the server accepts the signature', st.startsWith('200') && authSrv.hits.aws.at(-1)?.ok === true, `${st} ${JSON.stringify(authSrv.hits.aws)}`)

  await addRequestVia('Auth Types', 'NTLM', `${authSrv.url}/ntlm/whoami`)
  await win.getByTestId('auth-type').selectOption('ntlm')
  await win.getByTestId('ntlm-username').fill('alice')
  await win.getByTestId('ntlm-password').fill('Password')
  await win.getByTestId('ntlm-domain').fill('CONTOSO')
  const ntlmBefore = authSrv.hits.ntlm.length
  st = await sendNow()
  const legs = authSrv.hits.ntlm.slice(ntlmBefore)
  check('NTLM: NEGOTIATE and AUTHENTICATE on one socket, NTLMv2 proof verified', st.startsWith('200') && legs.length === 2 && legs[0].socket === legs[1].socket && legs[1].ok === true && legs[1].user === 'CONTOSO\\alice', `${st} ${JSON.stringify(legs)}`)

  await addRequestVia('Auth Types', 'JWT', `${authSrv.url}/jwt/me`)
  await win.getByTestId('auth-type').selectOption('jwt')
  await win.getByTestId('jwt-secret').fill(JWT_SECRET)
  await win.getByTestId('jwt-payload').fill('{"sub":"e2e-user","scope":"orders"}')
  st = await sendNow()
  check('JWT bearer: HS256 signature verified by the server, payload as typed', st.startsWith('200') && authSrv.hits.jwt.at(-1)?.ok === true && authSrv.hits.jwt.at(-1)?.payload?.sub === 'e2e-user', `${st} ${JSON.stringify(authSrv.hits.jwt.at(-1))}`)
  shown = await sentAuthHeader()
  check('JWT: the token is masked in the Request view', /Bearer ••••/.test(shown), shown)
  await section_(win, 'Authorization')
  await shot(win, '31-auth-jwt')

  // OAuth 2.0 authorization code + PKCE. The system browser is stubbed in the main process
  // (stubBrowser: GET the authorize URL, follow the IdP's redirect to Courier's loopback listener).
  await stubBrowser(A.app)
  await addRequestVia('Auth Types', 'OAuth Code', `${authSrv.url}/api/orders`)
  await win.getByTestId('auth-type').selectOption('oauth2')
  await win.getByTestId('oauth-grant').selectOption('authorization_code')
  await win.getByTestId('oauth-auth-url').fill(`${authSrv.url}/idp/authorize`)
  await win.getByTestId('oauth-token-url').fill(`${authSrv.url}/idp/token`)
  await win.getByTestId('oauth-client-id').fill('courier-e2e')
  await win.getByTestId('oauth-scope').fill('orders.read')
  await win.getByTestId('send-button').click()
  await win.getByTestId('response-error').waitFor()
  const openedBefore = await A.app.evaluate(() => globalThis.__e2eOpened.length)
  check('OAuth: Send without a token fails with AUTH_REQUIRED and opens no browser', (await win.getByTestId('response-error').getAttribute('data-code')) === 'AUTH_REQUIRED' && openedBefore === 0)
  await section_(win, 'Authorization')
  await win.getByTestId('oauth-get-token').click()
  await win.locator('[data-testid="oauth-token-status"][data-has-token="true"]').waitFor({ timeout: 15000 })
  const tokenStatus = await win.getByTestId('oauth-token-status').innerText()
  const opened = await A.app.evaluate(() => globalThis.__e2eOpened)
  const authorize = opened[0] ? new URL(opened[0]) : null
  check('OAuth: "Get new token" opened the system browser (stub) at the IdP with PKCE S256 and state', authorize?.origin === authSrv.url && authorize.searchParams.get('code_challenge_method') === 'S256' && !!authorize.searchParams.get('state') && /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(authorize.searchParams.get('redirect_uri') ?? ''), opened[0])
  check('OAuth: the IdP verified the PKCE code_verifier', authSrv.hits.token.at(-1)?.pkceOk === true, JSON.stringify(authSrv.hits.token))
  check('OAuth: the token panel shows a masked preview and the expiry, never the token', /Token e2e…[0-9a-f]{3}/.test(tokenStatus) && /expires/.test(tokenStatus) && ![...authSrv.issued].some((t) => tokenStatus.includes(t)), tokenStatus)
  await shot(win, '32-oauth-token')
  st = await sendNow()
  oauthToken = authSrv.hits.api.at(-1)?.token ?? ''
  check('OAuth: the request carries the acquired token and the API accepts it', st.startsWith('200') && authSrv.hits.api.at(-1)?.ok === true, st)
  shown = await sentAuthHeader()
  check('OAuth: the token is masked in the Request view and absent from the window', /Bearer ••••/.test(shown) && !(await win.evaluate(() => document.body.innerText)).includes(oauthToken), shown)

  // A team collection's OAuth URLs come from teammates: the hosts are shown for approval first.
  await addRequestVia('Research Notes', 'Team OAuth', `${authSrv.url}/api/team`)
  await win.getByTestId('auth-type').selectOption('oauth2')
  await win.getByTestId('oauth-grant').selectOption('authorization_code')
  await win.getByTestId('oauth-auth-url').fill(`${authSrv.url}/idp/authorize`)
  await win.getByTestId('oauth-token-url').fill(`${authSrv.url}/idp/token`)
  await win.getByTestId('oauth-client-id').fill('courier-e2e')
  const openedTeam = await A.app.evaluate(() => globalThis.__e2eOpened.length)
  await win.getByTestId('oauth-get-token').click()
  const hostDialog = win.locator('[data-testid="confirm-dialog"]', { hasText: 'Review OAuth 2.0 hosts' })
  await hostDialog.waitFor()
  const authHost = new URL(authSrv.url).host
  const dialogText = await hostDialog.innerText()
  check('OAuth (team collection): before the first token the dialog names the browser host and the token host; no browser yet', dialogText.includes(`open ${authHost}`) && dialogText.includes(`sent to ${authHost}`) && (await A.app.evaluate(() => globalThis.__e2eOpened.length)) === openedTeam, dialogText)
  await shot(win, '32a-oauth-team-hosts')
  await hostDialog.getByTestId('confirm-button').click()
  await win.locator('[data-testid="oauth-token-status"][data-has-token="true"]').waitFor({ timeout: 15000 })
  check('OAuth (team collection): after approval the browser opens once and the token arrives; the dialog is gone', (await A.app.evaluate(() => globalThis.__e2eOpened.length)) === openedTeam + 1 && (await hostDialog.count()) === 0)

  // -------------------------------------------------------------------------------------------
  section('i. scripting: setNextRequest in the runner, pm.visualizer, pm.cookies.jar()')
  const CANARY = `${authSrv.url}/canary`
  const visTemplate = `<h2>Orders</h2><table>{{#each rows}}<tr><td>{{@index}}</td><td>{{name}}</td><td>{{status}}</td></tr>{{/each}}</table><p id="note">{{note}}</p><a id="out" href="${CANARY}/link">outbound link</a><img src="${CANARY}/img.png"><link rel="stylesheet" href="${CANARY}/style.css"><meta http-equiv="refresh" content="0;url=${CANARY}/refresh"><script>document.title = "visualizer script ran"; fetch("${CANARY}/fetch")</script>`
  const flow = {
    info: { name: 'Flow E2E', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      { name: 'Start', event: [{ listen: 'test', script: { exec: ["pm.execution.setNextRequest('Finish');"] } }], request: { method: 'GET', url: `${echo.url}/flow/start` } },
      { name: 'Jumped over', request: { method: 'GET', url: `${echo.url}/flow/jumped` } },
      { name: 'Finish', event: [{ listen: 'test', script: { exec: ["pm.test('finish ran', () => pm.response.to.have.status(200));", 'postman.setNextRequest(null);'] } }], request: { method: 'GET', url: `${echo.url}/flow/finish` } },
      { name: 'After stop', request: { method: 'GET', url: `${echo.url}/flow/after` } },
      {
        name: 'Visualize',
        event: [{ listen: 'test', script: { exec: [`pm.visualizer.set(${JSON.stringify(visTemplate)}, { rows: [{ name: 'Widget', status: 'open' }, { name: 'Gadget', status: 'shipped' }, { name: 'Gizmo', status: 'open' }], note: '<b>escaped</b>' });`] } }],
        request: { method: 'GET', url: `${echo.url}/vis` }
      },
      {
        name: 'Cookie script',
        event: [{ listen: 'test', script: { exec: ["pm.cookies.jar().set(pm.request.url.toString(), 'fromScript', 'set-by-e2e', function (err) { pm.test('cookie set', function () { pm.expect(err).to.equal(null); }); });"] } }],
        request: { method: 'GET', url: `${echo.url}/cookie-script` }
      }
    ]
  }
  await win.getByTestId('import-button').click()
  await win.getByTestId('import-mode-text').click()
  await win.getByTestId('import-text').fill(JSON.stringify(flow))
  await win.getByTestId('import-text-confirm').click()
  await toast(win, /Imported collection "Flow E2E"/).waitFor()
  if (await win.getByTestId('import-dialog').isVisible()) await win.getByTestId('import-dialog').getByRole('button', { name: 'Done' }).click()
  await node(win, 'Flow E2E').waitFor()
  const flowBefore = echo.requests.length
  await win.getByTestId('runner-button').click()
  await win.getByTestId('runner').waitFor()
  await win.getByTestId('runner-collection').selectOption({ label: 'Flow E2E' })
  await win.getByTestId('runner-iterations').fill('1')
  await win.getByTestId('runner-start').click()
  await win.getByTestId('runner-summary').waitFor({ timeout: 30000 })
  const ran = await win.getByTestId('run-result').evaluateAll((els) => els.map((e) => e.children[1]?.textContent?.replace(/^\s*GET\s*/, '').trim()))
  const flowPaths = echo.requests.slice(flowBefore).map((r) => r.url)
  check('runner follows setNextRequest (Start → Finish) and stops at setNextRequest(null)', JSON.stringify(ran) === '["Start","Finish"]' && JSON.stringify(flowPaths) === '["/flow/start","/flow/finish"]', `${JSON.stringify(ran)} ${JSON.stringify(flowPaths)}`)
  const stoppedText = await win.getByTestId('runner-stopped').innerText()
  check('the runner says why it stopped', /setNextRequest\(null\) in "Finish"/.test(stoppedText), stoppedText)
  await shot(win, '33-runner-setnextrequest')

  if (!(await node(win, 'Visualize').isVisible())) await node(win, 'Flow E2E').click()
  await node(win, 'Visualize').click()
  await win.getByTestId('send-button').click()
  await win.getByTestId('response-status').waitFor()
  await responseTab(win, 'Visualize')
  const vframe = win.frameLocator('[data-testid="visualizer-frame"]')
  await vframe.locator('table').waitFor()
  check('Visualize tab renders the template (rows, @index) in a frame', (await vframe.locator('table tr').count()) === 3 && (await vframe.locator('table tr').nth(1).innerText()).includes('Gadget'))
  check('Visualize: data is HTML-escaped', (await vframe.locator('#note').innerText()) === '<b>escaped</b>')
  await win.waitForTimeout(1500)
  check('Visualize: the template\'s <script> did not run', (await vframe.locator('html').evaluate((el) => el.ownerDocument.title)) !== 'visualizer script ran')
  check('Visualize: no network access (image, stylesheet, meta refresh and fetch never reached the canary)', authSrv.hits.canary.length === 0, JSON.stringify(authSrv.hits.canary))
  check('Visualize frame is sandboxed without scripts', (await win.locator('[data-testid="visualizer-frame"]').getAttribute('sandbox')) === '')
  await shot(win, '34-visualize')
  await vframe.locator('#out').click()
  await win.waitForTimeout(1000)
  check('Visualize: clicking a link in the frame sends nothing to the network (the app CSP refuses to frame it)', authSrv.hits.canary.length === 0 && visualizerBlocked.some((t) => t.includes(`Framing '${authSrv.url}/'`)), JSON.stringify(authSrv.hits.canary))

  await node(win, 'Cookie script').click()
  await win.getByTestId('send-button').click()
  await win.getByTestId('response-status').waitFor()
  await responseTab(win, 'Tests')
  check('cookie jar set from a test script (callback ran)', (await win.locator('[data-testid="test-result"][data-passed="true"]').count()) === 1)
  await win.getByTestId('cookies-button').click()
  await win.getByTestId('cookie-row').first().waitFor()
  const cookieRows = await win.getByTestId('cookie-row').allInnerTexts()
  check('the cookie set by the script is listed in the cookie manager', cookieRows.some((t) => t.includes('fromScript') && t.includes('set-by-e2e')), cookieRows.join(' | '))
  await shot(win, '35-cookies-from-script')
  await closeModal(win)
  check('no unexpected page errors or CSP violations in sections h–i', errors.length === 0, errors.join('\n'))
  // Collapse the collections added here so the tree looks as the later sections expect.
  for (const name of ['Flow E2E', 'Auth Types', 'Research Notes'])
    if ((await win.locator(`[role="treeitem"][aria-label="${name}"]`).first().getAttribute('aria-expanded')) === 'true') await node(win, name).click()

  // -------------------------------------------------------------------------------------------
  section('f. light and dark screenshots')
  await node(win, 'Echo').click()
  await win.getByTestId('send-button').click()
  await win.getByTestId('response-status').waitFor()
  await shot(win, '20-main-light')
  await openSettings(win, 'appearance')
  await win.getByTestId('theme-select').selectOption('dark')
  await win.getByTestId('settings-save').click()
  await toast(win, /Settings saved/).waitFor()
  await closeModal(win)
  check('dark theme applied', (await win.evaluate(() => document.documentElement.dataset.theme)) === 'dark')
  await shot(win, '21-main-dark')
  await win.getByTestId('env-peek').click()
  await win.getByTestId('env-peek-popover').waitFor()
  await shot(win, '22-env-peek-dark')
  await win.keyboard.press('Escape')
  await win.getByTestId('sync-panel-button').click()
  await shot(win, '23-sync-panel-dark')
  await closeModal(win)
  await node(win, 'E2E API').dblclick()
  await win.getByTestId('container-editor').waitFor()
  await win.getByRole('tab', { name: /^Variables/ }).click()
  await shot(win, '24-collection-settings-dark')
  await win.getByTestId('runner-button').click()
  await shot(win, '25-runner-dark')
  await openSettings(win, 'account')
  await shot(win, '26-settings-dark')
  await closeModal(win)
  await node(win, 'Live Echo').click()
  await win.getByTestId('ws-editor').waitFor()
  await shot(win, '49-websocket-dark')
  await node(win, 'Say Hello').click()
  await win.getByTestId('grpc-editor').waitFor()
  await shot(win, '50-grpc-dark')
  await openSettings(win, 'account')
  await win.getByTestId('theme-select').waitFor({ state: 'detached' }).catch(() => undefined)
  await win.getByTestId('settings-nav-appearance').click()
  await win.getByTestId('theme-select').selectOption('light')
  await win.getByTestId('settings-save').click()
  await closeModal(win)
  check('light theme restored', (await win.evaluate(() => document.documentElement.dataset.theme)) === 'light')
  await winB.bringToFront()
  await shot(winB, '27-second-instance-light')

  check('no page errors or CSP violations', errors.length === 0, errors.join('\n'))
} catch (err) {
  failures.push(`${current}: exception ${err?.message ?? err}`)
  console.error(err)
  for (const [w, n] of [[A?.win, 'A'], [B?.win, 'B']]) if (w) await w.screenshot({ path: join(SHOTS, `zz-failure-${n}.png`) }).catch(() => undefined)
} finally {
  await A?.app.close().catch(() => undefined)
  await B?.app.close().catch(() => undefined)
}

section('b (cont). secret never written under userData (all files, incl. Chromium stores; UTF-8/UTF-16)')
for (const [ud, label] of [[udA, 'A'], [udB, 'B']]) {
  const hits = [...filesContaining(ud, SECRET), ...filesContaining(ud, DB_SECRET)]
  check(`${label}: no file under userData contains a Key Vault secret (${walkFiles(ud).length} files scanned)`, hits.length === 0, hits.join(', '))
}
check('A: history file exists and was scanned', walkFiles(udA).some((p) => p.endsWith('history.json')))
const logOnly = [...filesContaining(udA, LOG_ONLY), ...filesContaining(udB, LOG_ONLY)]
check(`A: a WebSocket message that was sent but never saved is in no file under userData (message logs stay in memory)`, logOnly.length === 0, logOnly.join(', '))
const tokenHits = oauthToken ? filesContaining(udA, oauthToken) : ['(no token captured)']
const tokenFile = existsSync(join(udA, 'oauth-tokens.bin'))
check(`A: the OAuth access token is in no file under userData (${tokenFile ? 'encrypted token file present' : 'memory only'})`, tokenHits.length === 0, tokenHits.join(', '))
const researchLeak = filesContaining(udB, 'Research Notes')
check('B: nothing of the other team reached B\'s userData', researchLeak.length === 0, researchLeak.join(', '))

azurite.stop()
await wsSrv.stop()
await grpcSrv.stop()
await authSrv.stop()
await echo.stop()
await vault.stop()
pki.cleanup()
for (const d of [udA, udB, exportDir]) rmSync(d, { recursive: true, force: true })
writeFileSync(join(SHOTS, '.gitkeep'), '')

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n - ${failures.join('\n - ')}`)
  process.exit(1)
}
console.log('\ne2e: all checks passed')
process.exit(0)
