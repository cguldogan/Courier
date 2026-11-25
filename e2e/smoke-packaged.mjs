// Smoke test for a PACKAGED app (electron-builder output under release/), run by the build workflow
// on every runner whose arch matches the package, and usable locally:
//   node e2e/smoke-packaged.mjs [--release <dir>] [--arch x64|arm64] [--no-window]
// 1. The bundled command-line runner works from inside the app archive:
//    ELECTRON_RUN_AS_NODE=1 <app binary> <resources>/app.asar/out/cli/courier.cjs --version
// 2. Unless --no-window: the app starts and opens its window (playwright-core's Electron driver) with a
//    temporary COURIER_USER_DATA and --use-mock-keychain, reports app.isPackaged, and quits.
// Needs only the unpacked app directory that electron-builder leaves next to the installers.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { _electron as electron } from 'playwright-core'

const ROOT = resolve(import.meta.dirname, '..')
const { values: opts } = parseArgs({
  options: {
    release: { type: 'string', default: join(ROOT, 'release') },
    arch: { type: 'string', default: process.arch },
    'no-window': { type: 'boolean', default: false }
  }
})
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const release = resolve(opts.release)

/** The unpacked app for this platform and arch: { binary, asar }. */
function findApp() {
  const dirs = existsSync(release) ? readdirSync(release, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []
  // electron-builder names: mac (x64) / mac-arm64 / mac-universal; win-unpacked / win-arm64-unpacked;
  // linux-unpacked / linux-arm64-unpacked. x64 has no suffix.
  const suffix = opts.arch === 'x64' ? '' : `-${opts.arch}`
  if (process.platform === 'darwin') {
    const dir = dirs.find((d) => d === `mac${suffix}`)
    const app = dir && join(release, dir, `${pkg.productName}.app`)
    return app && { binary: join(app, 'Contents', 'MacOS', pkg.productName), asar: join(app, 'Contents', 'Resources', 'app.asar') }
  }
  const os = process.platform === 'win32' ? 'win' : 'linux'
  const dir = dirs.find((d) => d === `${os}${suffix}-unpacked`)
  if (!dir) return null
  const exe = process.platform === 'win32' ? `${pkg.productName}.exe` : 'courier'
  return { binary: join(release, dir, exe), asar: join(release, dir, 'resources', 'app.asar') }
}

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

function run(binary, args, env) {
  return new Promise((done, fail) => {
    const child = spawn(binary, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => child.kill(), 60_000)
    child.on('error', fail)
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code, stdout, stderr })
    })
  })
}

const app = findApp()
console.log(`packaged smoke: ${process.platform}-${opts.arch} in ${release}`)
if (!app || !existsSync(app.binary) || !existsSync(app.asar)) {
  console.error(`No unpacked ${process.platform}-${opts.arch} app under ${release} (looked for ${app?.binary ?? 'a matching directory'}).`)
  process.exit(1)
}
console.log(`  binary ${app.binary}`)

// 1. The command-line runner from inside app.asar, with the app's own Electron acting as Node.
const cli = join(app.asar, 'out', 'cli', 'courier.cjs')
const v = await run(app.binary, [cli, '--version'], { ELECTRON_RUN_AS_NODE: '1' })
check(`bundled CLI: courier --version prints ${pkg.version}`, v.code === 0 && v.stdout.trim() === pkg.version, JSON.stringify(v))
const h = await run(app.binary, [cli, '--help'], { ELECTRON_RUN_AS_NODE: '1' })
check('bundled CLI: courier --help lists the run command', h.code === 0 && /\brun\b/.test(h.stdout), JSON.stringify(h).slice(0, 400))

// 2. The app window.
if (!opts['no-window']) {
  const userData = mkdtempSync(join(tmpdir(), 'courier-smoke-packaged-'))
  let electronApp
  try {
    electronApp = await electron.launch({
      executablePath: app.binary,
      // Test-only switches (never set by the shipped app): mock keychain on macOS; on Linux CI the
      // sandbox helper is not set up, so the test launch runs unsandboxed.
      args: ['--use-mock-keychain', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
      env: { ...process.env, COURIER_USER_DATA: userData },
      timeout: 60_000
    })
    const win = await electronApp.firstWindow({ timeout: 60_000 })
    await win.waitForLoadState('domcontentloaded')
    const info = await electronApp.evaluate(({ app: a }) => ({ packaged: a.isPackaged, version: a.getVersion(), name: a.getName() }))
    check('app reports isPackaged and the package version', info.packaged === true && info.version === pkg.version, JSON.stringify(info))
    const title = await win.title()
    check('window opens with the Courier title', /Courier/.test(title), title)
    const bodyText = await win.locator('body').innerText({ timeout: 30_000 })
    check('renderer rendered content', bodyText.trim().length > 0)
  } catch (err) {
    check('app window starts', false, err instanceof Error ? err.message : String(err))
  } finally {
    await electronApp?.close().catch(() => {})
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

if (failures.length) {
  console.error(`\n${failures.length} packaged smoke check(s) failed`)
  process.exit(1)
}
console.log('\npackaged smoke: all checks passed')
