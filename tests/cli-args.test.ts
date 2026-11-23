/** Command-line parsing and validation: `runConfig`, help/version and usage errors (exit code 2). */
import { describe, expect, it } from 'vitest'
import { UsageError, parseCommand } from '../src/cli/args'
import { identitySettings } from '../src/cli/identity'
import { VERSION } from '../src/cli/main'
import { RUN_SPEC, approvalHost, runConfig } from '../src/cli/run'
import { runCli } from './cli-helpers'

const cfg = (...argv: string[]) => runConfig(parseCommand(RUN_SPEC, argv))
const usage = (...argv: string[]): string => {
  try {
    cfg(...argv)
  } catch (e) {
    expect(e).toBeInstanceOf(UsageError)
    return (e as Error).message
  }
  throw new Error('expected a usage error')
}

describe('courier run: arguments', () => {
  it('defaults', () => {
    expect(cfg('c.json')).toEqual({
      collection: 'c.json',
      delayMs: 0,
      bail: false,
      folders: [],
      envVars: [],
      insecure: false,
      identity: { mode: 'auto' },
      vaults: [],
      approveVaults: [],
      allowScriptVault: false,
      reporters: ['console'],
      noColor: false
    })
  })

  it('every option, short flags, repeatable options and key=value with "=" in the value', () => {
    const c = cfg(
      'Orders API', '-e', 'Staging', '-g', 'g.json', '-d', 'rows.csv', '-n', '3', '--delay', '50', '--bail',
      '--folder', 'A', '--folder', 'b-id', '--env-var', 'token=abc==', '--env-var', 'x=', '--timeout', '1500', '-k', '--max-jumps', '7',
      '--team-url', 'https://acct.blob.core.windows.net', '--team-container', 'payments', '--identity', 'managed-identity', '--client-id', 'mi-client',
      '--vault', 'main=https://a.vault.azure.net', '--vault', 'b=https://b.vault.azure.net/', '--approve-vault', 'team-kv.vault.azure.net',
      '--allow-script-vault', '--scripts-sha256', 'AB'.repeat(32), '-r', 'console,junit', '--reporter-junit-export', 'out/j.xml', '--reporter-json-export', 'out/r.json', '--no-color'
    )
    expect(c).toMatchObject({
      collection: 'Orders API',
      environment: 'Staging',
      globals: 'g.json',
      data: 'rows.csv',
      iterations: 3,
      delayMs: 50,
      bail: true,
      folders: ['A', 'b-id'],
      envVars: [['token', 'abc=='], ['x', '']],
      timeoutMs: 1500,
      insecure: true,
      maxJumps: 7,
      team: { accountUrl: 'https://acct.blob.core.windows.net', container: 'payments' },
      identity: { mode: 'managed-identity', clientId: 'mi-client' },
      vaults: [{ alias: 'main', url: 'https://a.vault.azure.net' }, { alias: 'b', url: 'https://b.vault.azure.net/' }],
      approveVaults: ['team-kv.vault.azure.net'],
      allowScriptVault: true,
      scriptsSha256: 'ab'.repeat(32),
      jsonExport: 'out/r.json',
      junitExport: 'out/j.xml',
      noColor: true
    })
    expect([...c.reporters].sort()).toEqual(['console', 'json', 'junit'])
    expect(cfg('c.json', '--identity', 'azure-cli', '--tenant', 'contoso.test').identity).toEqual({ mode: 'azure-cli', tenant: 'contoso.test' })
  })

  it('rejects bad values with a usage error', () => {
    expect(usage()).toMatch(/Missing <collection>/)
    expect(usage('a.json', 'b.json')).toMatch(/Expected one collection/)
    expect(usage('c.json', '--identity', 'browser')).toMatch(/Browser sign-in is not available/)
    expect(usage('c.json', '--identity', 'magic')).toMatch(/auto, managed-identity or azure-cli/)
    expect(usage('c.json', '--identity', 'azure-cli', '--client-id', 'x')).toMatch(/user-assigned managed identity/)
    expect(usage('c.json', '-n', '0')).toMatch(/--iterations must be between 1 and 10000/)
    expect(usage('c.json', '--delay', '-5')).toMatch(/--delay/)
    expect(usage('c.json', '--timeout', '1.5')).toMatch(/whole number/)
    expect(usage('c.json', '--env-var', 'novalue')).toMatch(/key=value/)
    expect(usage('c.json', '--vault', '=https://x')).toMatch(/key=value/)
    expect(usage('c.json', '--team-url', 'https://a.blob.core.windows.net')).toMatch(/go together/)
    expect(usage('c.json', '-r', 'html')).toMatch(/Unknown reporter "html"/)
    expect(usage('c.json', '-r', 'console,json')).toMatch(/console and json reporters would all write to standard output/)
    expect(usage('c.json', '--scripts-sha256', 'ab'.repeat(32))).toMatch(/only applies together with --allow-script-vault/)
    expect(usage('c.json', '--allow-script-vault', '--scripts-sha256', 'xyz')).toMatch(/64-character hex/)
    expect(() => parseCommand(RUN_SPEC, ['c.json', '--nope'])).toThrow(/Unknown option '--nope'/)
    expect(() => parseCommand(RUN_SPEC, ['c.json', '--delay'])).toThrow(UsageError)
  })

  it('a reporter alone may write to standard output', () => {
    expect(cfg('c.json', '-r', 'json').reporters).toEqual(['json'])
    expect(cfg('c.json', '-r', 'junit,json', '--reporter-json-export', 'r.json').reporters.sort()).toEqual(['json', 'junit'])
  })

  it('identity options map onto the app\'s identity settings (--client-id = user-assigned managed identity)', () => {
    expect(identitySettings(cfg('c.json', '--identity', 'managed-identity', '--client-id', 'mi-client').identity)).toEqual({ mode: 'managed-identity', managedIdentityClientId: 'mi-client' })
    expect(identitySettings(cfg('c.json', '--identity', 'azure-cli', '--tenant', 'contoso.test').identity)).toEqual({ mode: 'azure-cli', tenantId: 'contoso.test' })
    expect(identitySettings(cfg('c.json').identity)).toEqual({ mode: 'auto' })
  })

  it('--approve-vault takes a host, host:port or URL and compares like new URL(url).host', () => {
    expect(approvalHost('Team-KV.vault.azure.net')).toBe('team-kv.vault.azure.net')
    expect(approvalHost('https://team-kv.vault.azure.net/')).toBe('team-kv.vault.azure.net')
    expect(approvalHost('127.0.0.1:8443')).toBe('127.0.0.1:8443')
    expect(approvalHost('https://team-kv.vault.azure.net:443')).toBe('team-kv.vault.azure.net')
  })
})

describe('courier: help, version, usage errors', () => {
  it('--version and --help exit 0; no arguments prints help and exits 2', async () => {
    expect(await runCli(['--version'])).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: '' })
    const help = await runCli(['--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toMatch(/Usage: courier <command>/)
    expect(help.stdout).toMatch(/run {4}Run a collection/)
    for (const name of Object.keys(RUN_SPEC.options)) expect(help.stdout).toContain(`--${name}`)
    expect(help.stdout).toContain('Exit codes:')
    const none = await runCli([])
    expect(none.code).toBe(2)
    expect(none.stdout).toMatch(/Usage: courier <command>/)
  })

  it('run --help and help run document every option', async () => {
    const a = await runCli(['run', '--help'])
    const b = await runCli(['help', 'run'])
    expect(a).toEqual(b)
    expect(a.code).toBe(0)
    for (const name of Object.keys(RUN_SPEC.options)) expect(a.stdout).toContain(`--${name}`)
    expect(a.stdout).toMatch(/Exit codes:\n {2}0 {2}every request and test passed\n {2}1 .*\n {2}2 {2}usage or configuration error/)
  })

  it('unknown commands and options exit 2 with a pointer to help on stderr', async () => {
    expect(await runCli(['launch'])).toEqual({ code: 2, stdout: '', stderr: 'courier: Unknown command "launch".\nRun "courier --help" for usage.\n' })
    expect(await runCli(['help', 'launch'])).toMatchObject({ code: 2 })
    const bad = await runCli(['run', 'c.json', '--colour'])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toBe(`courier: Unknown option '--colour'.\nRun "courier help run" for usage.\n`)
  })
})
