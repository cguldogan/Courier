/**
 * `courier run <collection>`: runs a collection without a window, with the app's engine (executor,
 * runner, QuickJS sandbox, auth types, Key Vault, blob download). Everything lives in memory for the
 * run: no userData, no settings, history, cookies or OAuth token files are read or written.
 *
 * Security rules carried over from the app:
 *  - a team's `courier-team.json` vaults are used only when their host is approved, here with
 *    `--approve-vault <host>` (otherwise VAULT_NOT_APPROVED);
 *  - scripts get no Key Vault values (VAULT_SCRIPT_BLOCKED) unless `--allow-script-vault`, which can
 *    be pinned to the collection's script hash with `--scripts-sha256`;
 *  - OAuth 2.0 authorization code needs a browser and fails with AUTH_REQUIRED;
 *  - reporters only see masked data: the engine masks per execution, and the run masks again with
 *    every Key Vault value, acquired token and `secret`-typed variable value it handled.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { CookieJar } from 'tough-cookie'
import { parseFakeIdentity } from '../main/azure'
import type { ManifestRead } from '../main/blobsync'
import { Fault, messageOf } from '../main/errors'
import { Masker, type ExecutorDeps, type VaultResolver } from '../main/executor'
import { KeyVaultService, teamVaultCandidates } from '../main/keyvault'
import { planRun, runCollection } from '../main/runner'
import type { ScriptVaultGate } from '../main/script-trust'
import { defaultSettings } from '../main/store'
import { validateOwnVaults } from '../main/teams'
import { parseDataFile } from '../shared/datafile'
import { effectiveValues } from '../shared/variables'
import { newId, walkItems, type Collection, type Environment, type Item, type Settings, type VaultConfig } from '../shared/types'
import { UsageError, intOption, keyValue, type CommandSpec, type ParsedCommand } from './args'
import { CliIdentity, type CliIdentityMode } from './identity'
import { ConsoleReporter, jsonReport, junitReport, runPassed, type ExecutionReport, type RunReport } from './reporters'
import { TeamSource, collectionFromJson, environmentFromJson, readJsonFile } from './sources'

export const RUN_SPEC: CommandSpec = {
  name: 'run',
  brief: 'Run a collection file or a team collection, with console, JSON and JUnit reports.',
  usage: 'run <collection> [options]',
  summary:
    'Runs a collection: every request in tree order (or the --folder selection), its scripts and tests, for each iteration or data row. Uses the same engine as the app. Nothing is read from or written to the desktop app\'s data.',
  positionals: [
    {
      name: '<collection>',
      description: 'A collection file (Courier JSON or Postman v2.0/v2.1). With --team-url and --team-container: the name or id of a team collection, downloaded read-only.'
    }
  ],
  options: {
    environment: { type: 'string', short: 'e', arg: '<file|name>', description: 'Environment file (Courier or Postman). With a team, also the name or id of a team environment (an existing file wins).' },
    globals: { type: 'string', short: 'g', arg: '<file>', description: 'Globals file (Postman globals export, or a Courier/Postman environment).' },
    data: { type: 'string', short: 'd', arg: '<file>', description: 'CSV or JSON data file: one iteration per row.' },
    iterations: { type: 'string', short: 'n', arg: '<n>', description: 'Number of iterations (default 1; with --data, the number of rows; with both, rows are cut off or the last row is repeated).' },
    delay: { type: 'string', arg: '<ms>', description: 'Delay between requests.' },
    bail: { type: 'boolean', description: 'Stop the run at the first failed request.' },
    folder: { type: 'string', multiple: true, arg: '<name|id>', description: 'Run only the requests in this folder (and its sub-folders).' },
    'env-var': { type: 'string', multiple: true, arg: '<key=value>', description: 'Set an environment variable (overrides the environment file).' },
    timeout: { type: 'string', arg: '<ms>', description: 'Timeout of each HTTP request (default 30000).' },
    insecure: { type: 'boolean', short: 'k', description: 'Do not verify TLS certificates of the requests (Azure Storage and Key Vault are always verified).' },
    'max-jumps': { type: 'string', arg: '<n>', description: 'Loop guard: most pm.execution.setNextRequest jumps per iteration (default 1000).' },
    'team-url': { type: 'string', arg: '<url>', description: 'Team storage account URL, e.g. https://myaccount.blob.core.windows.net.' },
    'team-container': { type: 'string', arg: '<name>', description: 'Team container name.' },
    identity: { type: 'string', arg: '<mode>', description: 'Azure identity: auto (managed identity, then Azure CLI; default), managed-identity or azure-cli. Signs in only when needed.' },
    'client-id': { type: 'string', arg: '<id>', description: 'Client id of a user-assigned managed identity.' },
    tenant: { type: 'string', arg: '<id>', description: 'Tenant for the Azure CLI identity.' },
    vault: { type: 'string', multiple: true, arg: '<alias=url>', description: 'A Key Vault for {{vault:…}} references, e.g. main=https://my-kv.vault.azure.net. The first is the default.' },
    'approve-vault': { type: 'string', multiple: true, arg: '<host>', description: 'Approve a Key Vault host listed in the team\'s courier-team.json for this run.' },
    'allow-script-vault': { type: 'boolean', description: 'Let the collection\'s scripts read Key Vault secrets (pm.vault.get). Off by default.' },
    'scripts-sha256': { type: 'string', arg: '<hash>', description: 'With --allow-script-vault: only allow it while the collection\'s scripts have this SHA-256 (shown in the JSON report).' },
    reporter: { type: 'string', short: 'r', arg: '<list>', description: 'Comma-separated: console, json, junit (default console).' },
    'reporter-json-export': { type: 'string', arg: '<file>', description: 'Write the JSON report to this file (implies the json reporter).' },
    'reporter-junit-export': { type: 'string', arg: '<file>', description: 'Write the JUnit XML report to this file (implies the junit reporter).' },
    'no-color': { type: 'boolean', description: 'No colours in console output (colour is only used when standard output is a terminal).' },
    help: { type: 'boolean', short: 'h', description: 'Show this help.' }
  },
  notes: [
    'Exit codes:\n  0  every request and test passed\n  1  a test failed, a request or script failed, or the run was stopped by an error\n  2  usage or configuration error (bad arguments, file not found, sign-in or download failure)',
    'Examples:\n  courier run api.postman_collection.json -e staging.postman_environment.json -r console,junit --reporter-junit-export junit.xml\n  courier run "Orders API" --team-url https://myaccount.blob.core.windows.net --team-container payments \\\n    -e Staging --identity managed-identity --approve-vault payments-kv.vault.azure.net'
  ]
}

export type ReporterName = 'console' | 'json' | 'junit'

export interface RunConfig {
  collection: string
  environment?: string
  globals?: string
  data?: string
  iterations?: number
  delayMs: number
  bail: boolean
  folders: string[]
  envVars: [string, string][]
  timeoutMs?: number
  insecure: boolean
  maxJumps?: number
  team?: { accountUrl: string; container: string }
  identity: { mode: CliIdentityMode; clientId?: string; tenant?: string }
  vaults: { alias: string; url: string }[]
  approveVaults: string[]
  allowScriptVault: boolean
  scriptsSha256?: string
  reporters: ReporterName[]
  jsonExport?: string
  junitExport?: string
  noColor: boolean
}

const str = (v: ParsedCommand['values'][string]): string | undefined => (typeof v === 'string' ? v : undefined)
const list = (v: ParsedCommand['values'][string]): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : [])

/** Validates the parsed command line (UsageError on anything wrong). */
export function runConfig(p: ParsedCommand): RunConfig {
  if (p.positionals.length === 0) throw new UsageError('Missing <collection>: a collection file, or a team collection name/id with --team-url and --team-container.', 'run')
  if (p.positionals.length > 1) throw new UsageError(`Expected one collection, got ${p.positionals.length}: ${p.positionals.map((x) => `"${x}"`).join(' ')}.`, 'run')
  const v = p.values
  const teamUrl = str(v['team-url'])
  const teamContainer = str(v['team-container'])
  if (Boolean(teamUrl) !== Boolean(teamContainer)) throw new UsageError('--team-url and --team-container go together.', 'run')
  const mode = str(v.identity) ?? 'auto'
  if (mode === 'browser') throw new UsageError('Browser sign-in is not available in the command-line runner. Use --identity managed-identity, azure-cli or auto.', 'run')
  if (!['auto', 'managed-identity', 'azure-cli'].includes(mode)) throw new UsageError(`--identity must be auto, managed-identity or azure-cli, not "${mode}".`, 'run')
  const reporters = new Set<ReporterName>()
  for (const r of (str(v.reporter) ?? 'console').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    if (r !== 'console' && r !== 'json' && r !== 'junit') throw new UsageError(`Unknown reporter "${r}" (console, json, junit).`, 'run')
    reporters.add(r)
  }
  const jsonExport = str(v['reporter-json-export'])
  const junitExport = str(v['reporter-junit-export'])
  if (jsonExport) reporters.add('json')
  if (junitExport) reporters.add('junit')
  if (!reporters.size) reporters.add('console')
  const toStdout = [...reporters].filter((r) => r === 'console' || (r === 'json' && !jsonExport) || (r === 'junit' && !junitExport))
  if (toStdout.length > 1)
    throw new UsageError(`The ${toStdout.join(' and ')} reporters would all write to standard output. Give --reporter-json-export / --reporter-junit-export a file.`, 'run')
  const vaults = list(v.vault).map((x) => {
    const [alias, url] = keyValue(x, 'vault')
    return { alias: alias.trim(), url: url.trim() }
  })
  const sha = str(v['scripts-sha256'])
  if (sha !== undefined && !v['allow-script-vault']) throw new UsageError('--scripts-sha256 only applies together with --allow-script-vault.', 'run')
  if (sha !== undefined && !/^[0-9a-fA-F]{64}$/.test(sha)) throw new UsageError('--scripts-sha256 expects a 64-character hex SHA-256.', 'run')
  const clientId = str(v['client-id'])
  if (clientId !== undefined && mode === 'azure-cli') throw new UsageError('--client-id selects a user-assigned managed identity; it does not apply to --identity azure-cli.', 'run')
  const iterations = intOption(str(v.iterations), 'iterations', 1, 10_000)
  return {
    collection: p.positionals[0],
    ...(str(v.environment) !== undefined ? { environment: str(v.environment) } : {}),
    ...(str(v.globals) !== undefined ? { globals: str(v.globals) } : {}),
    ...(str(v.data) !== undefined ? { data: str(v.data) } : {}),
    ...(iterations !== undefined ? { iterations } : {}),
    delayMs: intOption(str(v.delay), 'delay', 0, 600_000) ?? 0,
    bail: v.bail === true,
    folders: list(v.folder),
    envVars: list(v['env-var']).map((x) => keyValue(x, 'env-var')),
    ...(str(v.timeout) !== undefined ? { timeoutMs: intOption(str(v.timeout), 'timeout', 1, 3_600_000) } : {}),
    insecure: v.insecure === true,
    ...(str(v['max-jumps']) !== undefined ? { maxJumps: intOption(str(v['max-jumps']), 'max-jumps', 1, 1_000_000) } : {}),
    ...(teamUrl && teamContainer ? { team: { accountUrl: teamUrl, container: teamContainer } } : {}),
    identity: { mode: mode as CliIdentityMode, ...(clientId ? { clientId } : {}), ...(str(v.tenant) ? { tenant: str(v.tenant) } : {}) },
    vaults,
    approveVaults: list(v['approve-vault']),
    allowScriptVault: v['allow-script-vault'] === true,
    ...(sha ? { scriptsSha256: sha.toLowerCase() } : {}),
    reporters: [...reporters],
    ...(jsonExport ? { jsonExport } : {}),
    ...(junitExport ? { junitExport } : {}),
    noColor: v['no-color'] === true
  }
}

export interface CliIO {
  stdout: { write(s: string): unknown }
  stderr: { write(s: string): unknown }
  env: Record<string, string | undefined>
  cwd: string
  /** Standard output is a terminal (colour). */
  isTTY: boolean
  /** Aborts the run (Ctrl-C). */
  signal?: AbortSignal
}

/** `host`, `host:port` or a URL → lower-case `host[:port]` as `new URL(vaultUrl).host` writes it. */
export function approvalHost(raw: string): string {
  const s = raw.trim()
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).host.toLowerCase()
  } catch {
    throw new UsageError(`--approve-vault expects a host such as my-kv.vault.azure.net, got "${raw}".`, 'run')
  }
}

function folderIds(c: Collection, wanted: string[]): string[] {
  const folders = [...walkItems(c.items)].filter((e) => e.item.type === 'folder')
  return wanted.map((w) => {
    const byId = folders.find((f) => f.item.id === w)
    if (byId) return byId.item.id
    let hits = folders.filter((f) => f.item.name === w)
    if (!hits.length) hits = folders.filter((f) => f.item.name.toLowerCase() === w.toLowerCase())
    const path = (f: (typeof folders)[number]): string => [...f.parents.map((x) => x.name), f.item.name].join(' / ')
    if (hits.length === 1) return hits[0].item.id
    if (hits.length > 1) throw new Fault('INVALID_ARGUMENT', `${hits.length} folders are named "${w}". Pass the id instead:${hits.map((f) => `\n  - ${path(f)} (id ${f.item.id})`).join('')}`)
    throw new Fault('NOT_FOUND', `No folder named or with id "${w}" in collection "${c.name}".${folders.length ? ` Folders:${folders.map((f) => `\n  - ${path(f)} (id ${f.item.id})`).join('')}` : ' It has no folders.'}`)
  })
}

/**
 * SHA-256 of every script in the collection (collection, folder and request pre-request and test
 * scripts) keyed by position in the tree, for `--scripts-sha256`. Unlike the app's grant hash it
 * leaves item ids out, because a Postman file gets new ids every time it is imported; any change
 * to any script text, or moving a scripted item, changes it.
 */
export function scriptsDigest(c: Collection): string {
  const parts: [string, string, string][] = [['', c.preRequestScript ?? '', c.testScript ?? '']]
  const walk = (items: Item[], path: string): void =>
    items.forEach((it, i) => {
      const at = path ? `${path}/${i}` : String(i)
      if ((it.preRequestScript ?? '') || (it.testScript ?? '')) parts.push([at, it.preRequestScript ?? '', it.testScript ?? ''])
      if (it.type === 'folder') walk(it.items, at)
    })
  walk(c.items, '')
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/**
 * Fields of the run report that are identifiers, codes or enums, never free text: left as they are,
 * so a secret that happens to equal `test`, `user` or `error` cannot corrupt the report's structure.
 */
const STRUCTURAL = new Set(['id', 'requestId', 'code', 'level', 'phase', 'method', 'stoppedReason', 'startedAt', 'finishedAt', 'scriptsSha256'])

/** Deep copy with every free-text string passed through the masker (numbers, booleans and STRUCTURAL fields untouched). */
function maskDeep<T>(value: T, m: Masker, key = ''): T {
  if (typeof value === 'string') return (STRUCTURAL.has(key) || (key === 'source' && (value === 'file' || value === 'team')) ? value : m.mask(value)) as T
  if (Array.isArray(value)) return value.map((x) => maskDeep(x, m, key)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v, m, k)])) as T
  return value
}

/** An OAuth client-credentials token cache that registers every token with the masker. */
class MaskingTokenCache extends Map<string, { token: string; exp: number }> {
  constructor(private readonly masker: Masker) {
    super()
  }
  override set(key: string, value: { token: string; exp: number }): this {
    this.masker?.add(value.token)
    return super.set(key, value)
  }
}

export const OAUTH_CODE_UNAVAILABLE =
  'OAuth 2.0 authorization code needs an interactive browser sign-in, which the command-line runner does not offer (and it reads no token files). Use client credentials, JWT bearer or Azure identity auth for unattended runs.'

/** Runs `courier run`. Returns the exit code. */
export async function runCommand(cfg: RunConfig, io: CliIO, version: string): Promise<number> {
  const masker = new Masker()
  const err = (s: string): void => void io.stderr.write(masker.mask(s) + '\n')
  const warn = (s: string): void => err(`courier: warning: ${s}`)
  const anyVaultHost = io.env.COURIER_KV_INSECURE_CHALLENGE === '1'
  let fake = null
  try {
    fake = parseFakeIdentity(io.env.COURIER_FAKE_IDENTITY)
  } catch (e) {
    throw new Fault('INVALID_ARGUMENT', messageOf(e))
  }
  const identity = new CliIdentity(cfg.identity, fake, (t) => masker.add(t))

  // --- documents ---------------------------------------------------------------------------
  let team: TeamSource | null = null
  let manifest: ManifestRead | null = null
  let collection: Collection
  let collectionFile: string | undefined
  if (cfg.team) {
    team = new TeamSource(cfg.team, identity, anyVaultHost)
    manifest = await team.readManifest()
    collection = await team.find<Collection>('collection', cfg.collection)
  } else {
    const loaded = collectionFromJson(await readJsonFile(cfg.collection, io.cwd, 'Collection'), `Collection file ${cfg.collection}`)
    for (const w of loaded.warnings) warn(w)
    collection = loaded.doc
    collectionFile = cfg.collection
  }
  let environment: Environment | null = null
  if (cfg.environment !== undefined) {
    const asFile = resolve(io.cwd, cfg.environment)
    if (team && !(existsSync(asFile) && statSync(asFile).isFile())) environment = await team.find<Environment>('environment', cfg.environment)
    else {
      const loaded = environmentFromJson(await readJsonFile(cfg.environment, io.cwd, 'Environment'), `Environment file ${cfg.environment}`)
      for (const w of loaded.warnings) warn(w)
      environment = loaded.doc
    }
  }
  let globals: Environment | null = null
  if (cfg.globals !== undefined) globals = environmentFromJson(await readJsonFile(cfg.globals, io.cwd, 'Globals'), `Globals file ${cfg.globals}`).doc
  let data: Record<string, string>[] | undefined
  if (cfg.data !== undefined) {
    let text: string
    try {
      text = await readFile(resolve(io.cwd, cfg.data), 'utf8')
    } catch (e) {
      throw new Fault((e as { code?: string }).code === 'ENOENT' ? 'NOT_FOUND' : 'INVALID_ARGUMENT', `Data file ${(e as { code?: string }).code === 'ENOENT' ? 'not found' : 'unreadable'}: ${cfg.data}`)
    }
    try {
      data = parseDataFile(cfg.data, text).rows
    } catch (e) {
      throw new Fault('INVALID_ARGUMENT', `Data file ${cfg.data}: ${messageOf(e)}`)
    }
    if (!data.length) throw new Fault('INVALID_ARGUMENT', `Data file ${cfg.data} has no rows.`)
    if (cfg.iterations !== undefined) {
      const rows = data
      data = Array.from({ length: cfg.iterations }, (_, i) => rows[Math.min(i, rows.length - 1)])
    }
  }

  // --- variables (secret-typed values are masked in every output) ----------------------------
  const secretKeys = new Set<string>()
  for (const doc of [collection, environment, globals])
    for (const v of doc?.variables ?? [])
      if (v.type === 'secret') {
        secretKeys.add(v.key)
        masker.add(v.value)
      }
  const envValues = environment ? effectiveValues(environment.variables) : {}
  for (const [k, val] of cfg.envVars) {
    envValues[k] = val
    if (secretKeys.has(k)) masker.add(val)
  }
  const vars = {
    global: globals ? effectiveValues(globals.variables) : {},
    collection: effectiveValues(collection.variables),
    environment: envValues,
    data: {},
    local: {}
  }

  // --- plan ---------------------------------------------------------------------------------
  const plan = planRun(collection, cfg.folders.length ? { folderIds: folderIds(collection, cfg.folders) } : {})
  if (!plan.length) throw new Fault('INVALID_ARGUMENT', cfg.folders.length ? 'The selected folders contain no requests.' : `Collection "${collection.name}" has no requests.`)

  // --- Key Vault ------------------------------------------------------------------------------
  const own: VaultConfig[] = validateOwnVaults(cfg.vaults, anyVaultHost)
  const approved = new Set(cfg.approveVaults.map(approvalHost))
  const teamName = manifest?.manifest.name ?? cfg.team?.container ?? ''
  if (approved.size) {
    const listed = new Set((manifest?.manifest.vaults ?? []).map((v) => new URL(v.url).host.toLowerCase()))
    for (const h of approved)
      if (!listed.has(h)) warn(team ? `--approve-vault ${h}: the team's courier-team.json lists no Key Vault on that host.` : `--approve-vault ${h} is ignored: it only applies to Key Vaults listed by a team (courier-team.json).`)
  }
  if (team && manifest?.rejected.length) for (const r of manifest.rejected) warn(`The team lists Key Vault "${r.alias}" with an unusable URL (${r.reason}); it is ignored.`)
  const candidates = teamVaultCandidates({
    team: { id: cfg.team?.container ?? '', name: teamName },
    manifest: team && manifest ? { vaults: manifest.manifest.vaults, rejected: manifest.rejected } : null,
    own,
    isApproved: (url) => approved.has(new URL(url).host.toLowerCase()),
    approveHint: (host) => `Pass --approve-vault ${host} if you trust it.`
  })
  const kv = new KeyVaultService({
    credential: identity.credential(),
    vaults: () => candidates,
    ttlSeconds: () => 300,
    disableChallengeResourceVerification: anyVaultHost
  })
  const inner = kv.resolver(null)
  const vault: VaultResolver = {
    resolve: async (ref) => {
      const value = await inner.resolve(ref)
      masker.add(value)
      return value
    }
  }

  // --- script → Key Vault gate ----------------------------------------------------------------
  const scriptsSha256 = scriptsDigest(collection)
  if (cfg.allowScriptVault && cfg.scriptsSha256 && cfg.scriptsSha256 !== scriptsSha256)
    throw new Fault(
      'VAULT_SCRIPT_BLOCKED',
      `The scripts of collection "${collection.name}" changed: their SHA-256 is ${scriptsSha256}, not the ${cfg.scriptsSha256} given with --scripts-sha256. Review the scripts, then update --scripts-sha256.`
    )
  const gate: ScriptVaultGate = cfg.allowScriptVault
    ? { allowed: true, collectionId: collection.id, collectionName: collection.name }
    : { allowed: false, reason: 'cli', collectionId: collection.id, collectionName: collection.name }

  // --- engine dependencies (all in memory) ---------------------------------------------------
  const base = defaultSettings()
  const settings: Settings = {
    ...base,
    http: { ...base.http, ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}), ...(cfg.insecure ? { verifyTls: false } : {}) }
  }
  const deps: ExecutorDeps = {
    settings,
    tokens: identity.tokens,
    vault,
    cookieJar: new CookieJar(),
    oauthCache: new MaskingTokenCache(masker),
    digestCache: new Map(),
    // Body files are only sent when picked in the app's file dialog; a command-line run has none.
    fileAllowed: () => false,
    scriptVault: gate,
    oauth: {
      accessToken: async () => {
        throw new Fault('AUTH_REQUIRED', OAUTH_CODE_UNAVAILABLE)
      }
    }
  }

  // --- run --------------------------------------------------------------------------------------
  const ac = new AbortController()
  const stop = (): void => ac.abort()
  io.signal?.addEventListener('abort', stop)
  identity.onFailure = stop
  const header = {
    courierVersion: version,
    collection: {
      id: collection.id,
      name: collection.name,
      source: team ? ('team' as const) : ('file' as const),
      ...(collectionFile ? { file: collectionFile } : {}),
      ...(team ? { team: { accountUrl: team.where.accountUrl, container: team.where.container, name: teamName } } : {}),
      scriptsSha256
    },
    environment: environment ? { id: environment.id, name: environment.name } : null
  }
  const consoleOut = cfg.reporters.includes('console') ? new ConsoleReporter(io.stdout, { color: io.isTTY && !cfg.noColor && !io.env.NO_COLOR }) : null
  consoleOut?.start(maskDeep(header, masker))
  const iterations = data ? data.length : (cfg.iterations ?? 1)
  const folderPath = new Map(plan.map((p) => [p.request.id, p.folders.map((f) => f.name)]))
  const executions: ExecutionReport[] = []
  const outcome = await runCollection(
    {
      runId: newId(),
      collection,
      plan,
      vars,
      iterations,
      delayMs: cfg.delayMs,
      stopOnFailure: cfg.bail,
      ...(data ? { data } : {}),
      ...(cfg.maxJumps !== undefined ? { maxJumps: cfg.maxJumps } : {}),
      signal: ac.signal,
      onExecution: (exec, item) => {
        // A script that stores a value in a variable declared `secret` (a login token, say) makes it a secret too.
        for (const mu of exec.mutations) if (mu.action === 'set' && mu.value && secretKeys.has(mu.key)) masker.add(mu.value)
        const e: ExecutionReport = maskDeep(
          {
            iteration: item.iteration,
            index: item.index,
            requestId: item.requestId,
            name: item.name,
            folders: folderPath.get(item.requestId) ?? [],
            method: item.method,
            url: item.url,
            ...(item.status !== undefined ? { status: item.status } : {}),
            ...(exec.response ? { statusText: exec.response.statusText, sizeBytes: exec.response.sizeBytes } : {}),
            ...(item.timeMs !== undefined ? { timeMs: item.timeMs } : {}),
            skipped: item.skipped === true,
            passed: item.passed,
            ...(item.error ? { error: item.error } : {}),
            tests: item.tests,
            scriptErrors: item.scriptErrors,
            console: exec.console.map((c) => ({ level: c.level, message: c.message, source: c.source }))
          },
          masker
        )
        executions.push(e)
        consoleOut?.execution(e, iterations)
      }
    },
    deps
  )
  io.signal?.removeEventListener('abort', stop)

  const s = outcome.summary
  const signInFailed = identity.failure
  const raw: RunReport = {
    ...header,
    run: {
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      durationMs: s.durationMs,
      iterations: s.iterations,
      stopped: s.stopped || signInFailed !== null,
      ...(signInFailed ? { stoppedReason: 'error' as const, stopMessage: signInFailed.message } : s.stoppedReason ? { stoppedReason: s.stoppedReason } : {}),
      ...(!signInFailed && s.stopMessage ? { stopMessage: s.stopMessage } : {})
    },
    executions
  }
  // Decided on the unmasked report; reporters only get the masked one.
  let code = runPassed(raw) ? 0 : 1
  const report = maskDeep(raw, masker)
  consoleOut?.finish(report)

  // Reports are written even for a failed run; a file that cannot be written is a configuration error.
  const emit = async (text: string, file: string | undefined, what: string): Promise<void> => {
    if (!file) {
      io.stdout.write(text)
      return
    }
    const full = resolve(io.cwd, file)
    try {
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, text, 'utf8')
    } catch (e) {
      err(`courier: error [INVALID_ARGUMENT]: Cannot write the ${what} report to ${file}: ${messageOf(e)}`)
      code = 2
    }
  }
  if (cfg.reporters.includes('json')) await emit(jsonReport(report), cfg.jsonExport, 'JSON')
  if (cfg.reporters.includes('junit')) await emit(junitReport(report), cfg.junitExport, 'JUnit')
  if (signInFailed) {
    err(`courier: error [${signInFailed.code}]: ${signInFailed.message}`)
    return 2
  }
  return code
}
