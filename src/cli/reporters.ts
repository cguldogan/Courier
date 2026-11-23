/**
 * Reporters for `courier run`: console (streamed), JSON and JUnit XML. They only ever see the run
 * report below, which is built from the engine's already-masked results and then masked once more
 * with every secret the run handled (see run.ts), so a reporter cannot print a secret it never had.
 *
 * JSON format (`courier.run-report/v1`, stable; fields are only ever added):
 *
 *   {
 *     "format": "courier.run-report/v1",
 *     "courier": { "version": "0.1.0" },
 *     "collection": { "id", "name", "source": "file" | "team", "file"?, "team"?: { "accountUrl", "container", "name" }, "scriptsSha256" },
 *     "environment": { "id", "name" } | null,
 *     "run": { "startedAt", "finishedAt", "durationMs", "iterations", "stopped", "stoppedReason"?, "stopMessage"?,
 *              "skipped"?: [ { "id", "name", "type": "websocket" | "grpc", "path" } ] },
 *     "stats": { "requests": { "total", "failed", "errors", "skipped" }, "tests": { "total", "passed", "failed" }, "scriptErrors" },
 *     "result": "passed" | "failed",
 *     "executions": [ {
 *       "iteration", "index", "requestId", "name", "folders": [..], "method", "url",
 *       "status"?, "statusText"?, "timeMs"?, "sizeBytes"?, "skipped", "passed",
 *       "error"?: { "code", "message" },
 *       "tests": [ { "name", "passed", "error"?, "source": { "level", "name", "phase" } } ],
 *       "scriptErrors": [ { "source", "message", "code"? } ],
 *       "console": [ { "level", "message", "source" } ]
 *     } ]
 *   }
 *
 * `iteration` and `index` are 0-based; `stoppedReason` is `failure` (--bail), `script`
 * (setNextRequest(null)), `error` (setNextRequest to an unknown request), `loop-guard` or `user`.
 */
import type { ConsoleEntry, RunSummary, ScriptError, ScriptSource, SkippedItem, TestResult } from '../shared/types'

export interface ExecutionReport {
  iteration: number
  index: number
  requestId: string
  name: string
  /** Folder names from the collection root down to the request. */
  folders: string[]
  method: string
  url: string
  status?: number
  statusText?: string
  timeMs?: number
  sizeBytes?: number
  skipped: boolean
  passed: boolean
  error?: { code: string; message: string }
  tests: TestResult[]
  scriptErrors: ScriptError[]
  console: Pick<ConsoleEntry, 'level' | 'message' | 'source'>[]
}

export interface RunReport {
  courierVersion: string
  collection: {
    id: string
    name: string
    source: 'file' | 'team'
    file?: string
    team?: { accountUrl: string; container: string; name: string }
    scriptsSha256: string
  }
  environment: { id: string; name: string } | null
  run: {
    startedAt: string
    finishedAt: string
    durationMs: number
    iterations: number
    stopped: boolean
    stoppedReason?: RunSummary['stoppedReason']
    stopMessage?: string
    /** WebSocket / gRPC requests in scope that the runner does not send (absent when none). */
    skipped?: SkippedItem[]
  }
  executions: ExecutionReport[]
}

export interface RunStats {
  requests: { total: number; failed: number; errors: number; skipped: number }
  tests: { total: number; passed: number; failed: number }
  scriptErrors: number
  /** Iterations with at least one failed request. */
  failedIterations: number
}

export function stats(r: RunReport): RunStats {
  const tests = r.executions.flatMap((e) => e.tests)
  return {
    requests: {
      total: r.executions.length,
      failed: r.executions.filter((e) => !e.passed).length,
      errors: r.executions.filter((e) => e.error).length,
      skipped: r.executions.filter((e) => e.skipped).length
    },
    tests: { total: tests.length, passed: tests.filter((t) => t.passed).length, failed: tests.filter((t) => !t.passed).length },
    scriptErrors: r.executions.reduce((n, e) => n + e.scriptErrors.length, 0),
    failedIterations: new Set(r.executions.filter((e) => !e.passed).map((e) => e.iteration)).size
  }
}

/** A stop that is itself a failure: an unknown setNextRequest target, the loop guard, or an interrupt. */
export function stoppedByError(r: RunReport): boolean {
  return r.run.stoppedReason === 'error' || r.run.stoppedReason === 'loop-guard' || r.run.stoppedReason === 'user'
}

export function runPassed(r: RunReport): boolean {
  return stats(r).requests.failed === 0 && !stoppedByError(r)
}

const sourceLabel = (s: ScriptSource): string => `${s.phase} script (${s.level} "${s.name}")`
const requestPath = (e: ExecutionReport): string => [...e.folders, e.name].join(' / ')

// ---------------------------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------------------------

export function jsonReport(r: RunReport): string {
  const s = stats(r)
  const out = {
    format: 'courier.run-report/v1',
    courier: { version: r.courierVersion },
    collection: r.collection,
    environment: r.environment,
    run: r.run,
    stats: { requests: s.requests, tests: s.tests, scriptErrors: s.scriptErrors },
    result: runPassed(r) ? 'passed' : 'failed',
    executions: r.executions.map((e) => ({
      iteration: e.iteration,
      index: e.index,
      requestId: e.requestId,
      name: e.name,
      folders: e.folders,
      method: e.method,
      url: e.url,
      ...(e.status !== undefined ? { status: e.status } : {}),
      ...(e.statusText !== undefined ? { statusText: e.statusText } : {}),
      ...(e.timeMs !== undefined ? { timeMs: e.timeMs } : {}),
      ...(e.sizeBytes !== undefined ? { sizeBytes: e.sizeBytes } : {}),
      skipped: e.skipped,
      passed: e.passed,
      ...(e.error ? { error: { code: e.error.code, message: e.error.message } } : {}),
      tests: e.tests.map((t) => ({ name: t.name, passed: t.passed, ...(t.error ? { error: t.error } : {}), source: t.source })),
      scriptErrors: e.scriptErrors.map((x) => ({ source: x.source, message: x.message, ...(x.code ? { code: x.code } : {}) })),
      console: e.console.map((c) => ({ level: c.level, message: c.message, source: c.source }))
    }))
  }
  return JSON.stringify(out, null, 2) + '\n'
}

// ---------------------------------------------------------------------------------------------
// JUnit XML
// ---------------------------------------------------------------------------------------------

// Characters XML 1.0 cannot carry at all (even escaped): dropped.
const XML_INVALID = new RegExp('[^\\t\\n\\r\\u0020-\\uD7FF\\uE000-\\uFFFD\\u{10000}-\\u{10FFFF}]', 'gu')

export function xmlEscape(s: string): string {
  return s.replace(XML_INVALID, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

const secs = (ms: number | undefined): string => ((ms ?? 0) / 1000).toFixed(3)

interface Case {
  name: string
  time?: number
  failure?: { type: string; message: string }
  error?: { type: string; message: string }
  skipped?: string
}

/**
 * One `<testsuite>` per executed request (and iteration, when there are several), one `<testcase>`
 * per `pm.test`. Failed assertions are `<failure>`; request errors (network, auth, Key Vault…), script
 * errors and a run stopped by an error are `<error>`, each in a test case of its own.
 */
export function junitReport(r: RunReport): string {
  const suites: { name: string; classname: string; time: number; props: [string, string][]; cases: Case[] }[] = []
  for (const e of r.executions) {
    const path = requestPath(e)
    const cases: Case[] = e.tests.map((t) => ({ name: t.name, ...(t.passed ? {} : { failure: { type: 'AssertionFailure', message: t.error ?? 'Test failed.' } }) }))
    if (e.error) cases.push({ name: `${e.name} (request)`, time: e.timeMs, error: { type: e.error.code, message: e.error.message } })
    for (const x of e.scriptErrors) cases.push({ name: sourceLabel(x.source), error: { type: x.code ?? 'SCRIPT_ERROR', message: x.message } })
    if (e.skipped) cases.push({ name: `${e.name} (request)`, skipped: 'Skipped by pm.execution.skipRequest().' })
    const props: [string, string][] = [
      ['method', e.method],
      ['url', e.url],
      ...(e.status !== undefined ? ([['status', `${e.status}${e.statusText ? ` ${e.statusText}` : ''}`]] as [string, string][]) : []),
      ['iteration', String(e.iteration + 1)]
    ]
    suites.push({ name: r.run.iterations > 1 ? `${path} [iteration ${e.iteration + 1}]` : path, classname: [r.collection.name, ...e.folders, e.name].join('.'), time: e.timeMs ?? 0, props, cases })
  }
  if (stoppedByError(r)) {
    const type = r.run.stoppedReason === 'loop-guard' ? 'LOOP_GUARD' : r.run.stoppedReason === 'user' ? 'CANCELLED' : 'RUN_STOPPED'
    suites.push({ name: 'Run', classname: r.collection.name, time: 0, props: [], cases: [{ name: 'run', error: { type, message: r.run.stopMessage ?? 'The run was stopped.' } }] })
  }
  const count = (cs: Case[], k: 'failure' | 'error' | 'skipped'): number => cs.filter((c) => c[k] !== undefined).length
  const all = suites.flatMap((s) => s.cases)
  const a = (v: string): string => `"${xmlEscape(v)}"`
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name=${a(r.collection.name)} tests="${all.length}" failures="${count(all, 'failure')}" errors="${count(all, 'error')}" skipped="${count(all, 'skipped')}" time="${secs(r.run.durationMs)}">`
  ]
  suites.forEach((s, i) => {
    lines.push(
      `  <testsuite name=${a(s.name)} id="${i}" tests="${s.cases.length}" failures="${count(s.cases, 'failure')}" errors="${count(s.cases, 'error')}" skipped="${count(s.cases, 'skipped')}" time="${secs(s.time)}" timestamp=${a(r.run.startedAt)}>`
    )
    if (s.props.length) {
      lines.push('    <properties>')
      for (const [k, v] of s.props) lines.push(`      <property name=${a(k)} value=${a(v)}/>`)
      lines.push('    </properties>')
    }
    for (const c of s.cases) {
      const open = `    <testcase name=${a(c.name)} classname=${a(s.classname)} time="${secs(c.time)}"`
      const body = c.failure
        ? `      <failure type=${a(c.failure.type)} message=${a(c.failure.message)}>${xmlEscape(c.failure.message)}</failure>`
        : c.error
          ? `      <error type=${a(c.error.type)} message=${a(c.error.message)}>${xmlEscape(c.error.message)}</error>`
          : c.skipped !== undefined
            ? `      <skipped message=${a(c.skipped)}/>`
            : null
      lines.push(body ? `${open}>\n${body}\n    </testcase>` : `${open}/>`)
    }
    lines.push('  </testsuite>')
  })
  lines.push('</testsuites>')
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------------------------

export interface Writer {
  write(s: string): unknown
}

type Paint = (s: string) => string
interface Palette {
  green: Paint
  red: Paint
  yellow: Paint
  dim: Paint
  bold: Paint
}

function palette(color: boolean): Palette {
  const c =
    (open: number, close: number): Paint =>
    (s) =>
      color ? `\x1b[${open}m${s}\x1b[${close}m` : s
  return { green: c(32, 39), red: c(31, 39), yellow: c(33, 39), dim: c(2, 22), bold: c(1, 22) }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const m = Math.floor(ms / 60_000)
  return `${m} min ${Math.round((ms - m * 60_000) / 1000)} s`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Streams one block per request as the run progresses, then the summary table and the failures. */
export class ConsoleReporter {
  private readonly p: Palette
  private iteration = -1

  constructor(
    private readonly out: Writer,
    opts: { color: boolean }
  ) {
    this.p = palette(opts.color)
  }

  start(r: Pick<RunReport, 'courierVersion' | 'collection' | 'environment'>): void {
    const env = r.environment ? `  ${this.p.dim(`environment "${r.environment.name}"`)}` : ''
    const from = r.collection.team ? `  ${this.p.dim(`team "${r.collection.team.name}"`)}` : ''
    this.out.write(`${this.p.bold(`Courier ${r.courierVersion}`)} · ${this.p.bold(r.collection.name)}${from}${env}\n`)
  }

  execution(e: ExecutionReport, iterations: number): void {
    const p = this.p
    if (iterations > 1 && e.iteration !== this.iteration) this.out.write(`\n${p.dim(`Iteration ${e.iteration + 1}/${iterations}`)}\n`)
    this.iteration = e.iteration
    let outcome: string
    if (e.skipped) outcome = p.yellow('skipped')
    else if (e.error) outcome = p.red(`error ${e.error.code}`)
    else {
      const st = `${e.status ?? ''}${e.statusText ? ` ${e.statusText}` : ''}`
      const meta = [e.timeMs !== undefined ? formatDuration(e.timeMs) : '', e.sizeBytes !== undefined ? formatBytes(e.sizeBytes) : ''].filter(Boolean).join(', ')
      outcome = `${e.status !== undefined && e.status >= 400 ? p.yellow(st) : st}${meta ? p.dim(`  ${meta}`) : ''}`
    }
    this.out.write(`\n${e.passed ? p.green('→') : p.red('→')} ${p.bold(requestPath(e))}\n  ${e.method} ${p.dim(e.url)}  ${outcome}\n`)
    for (const c of e.console) this.out.write(`  ${p.dim(`┊ ${c.level}: ${c.message.replace(/\n/g, '\n  ┊   ')}`)}\n`)
    for (const t of e.tests) this.out.write(t.passed ? `  ${p.green('✓')} ${t.name}\n` : `  ${p.red('✗')} ${t.name}${t.error ? p.dim(` — ${t.error}`) : ''}\n`)
    if (e.error) this.out.write(`  ${p.red('!')} ${e.error.message}\n`)
    for (const x of e.scriptErrors) this.out.write(`  ${p.red('!')} ${sourceLabel(x.source)}: ${x.message}${x.code ? p.dim(` [${x.code}]`) : ''}\n`)
  }

  finish(r: RunReport): void {
    const p = this.p
    const s = stats(r)
    const rows: [string, string, string][] = [
      ['', 'executed', 'failed'],
      ['iterations', String(r.run.iterations), String(s.failedIterations)],
      ['requests', String(s.requests.total), String(s.requests.failed)],
      ['tests', String(s.tests.total), String(s.tests.failed)],
      ['script errors', String(s.scriptErrors), '']
    ]
    const w = [Math.max(...rows.map((x) => x[0].length)), Math.max(...rows.map((x) => x[1].length)), Math.max(...rows.map((x) => x[2].length))]
    const line = (l: string, m: string, rr: string): string => `${l}${'─'.repeat(w[0] + 2)}${m}${'─'.repeat(w[1] + 2)}${m}${'─'.repeat(w[2] + 2)}${rr}`
    const out: string[] = ['', line('┌', '┬', '┐')]
    rows.forEach((x, i) => {
      const failed = i > 0 && x[2] !== '' && x[2] !== '0' ? p.red(x[2].padStart(w[2])) : x[2].padStart(w[2])
      out.push(`│ ${x[0].padStart(w[0])} │ ${x[1].padStart(w[1])} │ ${failed} │`)
      if (i === 0) out.push(line('├', '┼', '┤'))
    })
    out.push(line('└', '┴', '┘'))
    out.push(`total run duration: ${formatDuration(r.run.durationMs)}`)
    const failures: string[] = []
    for (const e of r.executions) {
      const where = `${requestPath(e)}${r.run.iterations > 1 ? ` (iteration ${e.iteration + 1})` : ''}`
      if (e.error) failures.push(`${where} · ${e.error.code}: ${e.error.message}`)
      for (const x of e.scriptErrors) failures.push(`${where} · ${sourceLabel(x.source)}: ${x.message}`)
      for (const t of e.tests) if (!t.passed) failures.push(`${where} · test "${t.name}"${t.error ? `: ${t.error}` : ''}`)
    }
    if (failures.length) {
      out.push('', p.red(p.bold('Failures:')))
      failures.forEach((f, i) => out.push(`  ${i + 1}. ${f}`))
    }
    if (r.run.stopped) {
      const why =
        r.run.stopMessage ??
        (r.run.stoppedReason === 'failure' ? 'Stopped after the first failure (--bail).' : r.run.stoppedReason === 'user' ? 'Interrupted.' : 'The run was stopped.')
      out.push('', stoppedByError(r) ? p.red(`Run stopped: ${why}`) : p.yellow(`Run stopped: ${why}`))
    }
    out.push('', runPassed(r) ? p.green('Result: passed') : p.red('Result: failed'))
    this.out.write(out.join('\n') + '\n')
  }
}
