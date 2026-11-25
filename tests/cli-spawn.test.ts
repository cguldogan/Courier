/**
 * The BUILT command-line bundle (out/cli/courier.cjs, rebuilt by the global setup) spawned as a child
 * process with this Node: exit codes, stdout/stderr, a large JSON report through a pipe, nothing
 * written to any userData or home directory, and a sign-in failure (exit 2) with no Azure CLI on PATH.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { VERSION } from '../src/cli/main'
import { serializeCollection } from '../src/shared/serialize'
import { newCollection, newRequest } from '../src/shared/types'
import { cleanupTempDirs, echoServer, posixRelative, readTree, tempDir } from './helpers'
import { CLI_BIN, FAKE_ENV, spawnCli } from './cli-helpers'

let srv: Awaited<ReturnType<typeof echoServer>>
let dir: string
beforeAll(async () => {
  srv = await echoServer({
    '/cookie': (_req, res) => {
      res.setHeader('set-cookie', 'session=abc123; Path=/')
      res.end('{}')
    }
  })
  dir = tempDir('courier-cli-spawn-')
})
afterAll(async () => {
  await srv.close()
  cleanupTempDirs()
})

const ok = "pm.test('ok', () => pm.response.to.have.status(200))"
function collectionFile(name: string, items: ReturnType<typeof newRequest>[]): string {
  const p = join(dir, `${name}.courier.json`)
  writeFileSync(p, serializeCollection(newCollection({ name, items })))
  return p
}

describe('the built courier bundle', () => {
  it('is plain Node: starts with a shebang and never requires electron', () => {
    const src = readFileSync(CLI_BIN, 'utf8')
    expect(src.startsWith('#!/usr/bin/env node\n')).toBe(true)
    expect(src).not.toMatch(/require\(["']electron["']\)/)
  })

  it('--version, --help: exit 0', async () => {
    expect(await spawnCli(['--version'])).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: '' })
    const help = await spawnCli(['run', '--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('Usage: courier run <collection> [options]')
  })

  it('a passing run exits 0, a failing run exits 1, a usage error exits 2 (no colour through a pipe)', async () => {
    const pass = await spawnCli(['run', collectionFile('Pass', [newRequest({ name: 'A', url: `${srv.url}/a`, testScript: ok })])])
    expect(pass.stderr).toBe('')
    expect(pass.code).toBe(0)
    expect(pass.stdout).toContain('✓ ok')
    expect(pass.stdout).toMatch(/Result: passed\n$/)
    expect(pass.stdout).not.toContain('\x1b[')

    const fail = await spawnCli(['run', collectionFile('Fail', [newRequest({ name: 'B', url: `${srv.url}/b`, testScript: "pm.test('nope', () => pm.expect(1).to.equal(2))" })])])
    expect(fail.code).toBe(1)
    expect(fail.stdout).toContain('✗ nope — expected 1 to equal 2')

    const usage = await spawnCli(['run', '--iterations', 'many', 'x.json'])
    expect(usage).toEqual({ code: 2, stdout: '', stderr: 'courier: --iterations expects a whole number, got "many".\nRun "courier help run" for usage.\n' })
    const missing = await spawnCli(['run', join(dir, 'missing.json')])
    expect(missing.code).toBe(2)
    expect(missing.stderr).toMatch(/^courier: error \[NOT_FOUND\]: Collection file not found: /)
  })

  it('writes a large JSON report to a pipe completely before exiting', async () => {
    const p = collectionFile('Big', [newRequest({ name: 'Echo', url: `${srv.url}/echo?pad=${'x'.repeat(2000)}`, testScript: `${ok}; console.log(pm.response.text())` })])
    const r = await spawnCli(['run', p, '-n', '150', '-r', 'json'])
    expect(r.code).toBe(0)
    expect(r.stdout.length).toBeGreaterThan(500_000)
    const j = JSON.parse(r.stdout)
    expect(j.executions).toHaveLength(150)
    expect(j.result).toBe('passed')
  })

  it('reads and writes nothing under userData or the home directory (cookies, variables, history stay in memory)', async () => {
    const home = tempDir('courier-cli-home-')
    const ud = tempDir('courier-cli-ud-')
    const work = tempDir('courier-cli-work-')
    const p = join(work, 'state.courier.json')
    writeFileSync(
      p,
      serializeCollection(
        newCollection({
          name: 'State',
          items: [
            newRequest({ name: 'Cookie', url: `${srv.url}/cookie`, testScript: `pm.environment.set('seen', 'yes'); pm.globals.set('g', '1'); ${ok}` }),
            newRequest({ name: 'Jar', url: `${srv.url}/jar`, testScript: `pm.test('cookie sent', () => pm.expect(pm.response.json().headers.cookie).to.eql('session=abc123')); pm.cookies.jar().set('${srv.url}', 'fromScript', 'v', () => {})` })
          ]
        })
      )
    )
    const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData'), LOCALAPPDATA: join(home, 'Local'), XDG_CONFIG_HOME: join(home, '.config'), COURIER_USER_DATA: ud }
    const r = await spawnCli(['run', p, '--reporter-junit-export', 'out/junit.xml'], { env, cwd: work })
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(readTree(home)).toEqual([])
    expect(readTree(ud)).toEqual([])
    expect(readTree(work).map((f) => posixRelative(work, f.path)).sort()).toEqual(['out/junit.xml', 'state.courier.json'])
  })

  it('a sign-in failure is a configuration error (exit 2); nothing is sent', async () => {
    const empty = tempDir('courier-cli-nopath-')
    mkdirSync(join(empty, 'bin'))
    const home = tempDir('courier-cli-home-')
    const p = collectionFile('NeedsKv', [newRequest({ name: 'Kv', url: `${srv.url}/kv`, headers: [{ key: 'X-Key', value: '{{vault:api-key}}', enabled: true }] })])
    const i = srv.requests.length
    // No fake identity, and no `az` reachable: the Azure CLI credential must fail fast.
    const env = { COURIER_FAKE_IDENTITY: undefined, PATH: join(empty, 'bin'), HOME: home, AZURE_CONFIG_DIR: join(home, '.azure'), COURIER_KV_INSECURE_CHALLENGE: FAKE_ENV.COURIER_KV_INSECURE_CHALLENGE }
    const r = await spawnCli(['run', p, '--identity', 'azure-cli', '--vault', 'main=https://example-kv.vault.azure.net'], { env })
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/courier: error \[AUTH_FAILED\]: Azure sign-in \(azure-cli\) failed: /)
    expect(r.stdout).toMatch(/Run stopped: Azure sign-in \(azure-cli\) failed/)
    expect(srv.requests.length).toBe(i)
  })
})
