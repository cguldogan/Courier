/**
 * Command-line reporters as pure functions over a fixed run report: golden console, JSON and JUnit
 * output, XML escaping and the pass/fail rule behind the exit code.
 */
import { describe, expect, it } from 'vitest'
import { ConsoleReporter, jsonReport, junitReport, runPassed, stats, xmlEscape, type RunReport } from '../src/cli/reporters'

const src = (name: string, phase: 'pre-request' | 'test' = 'test') => ({ level: 'request' as const, name, phase })

function report(over: Partial<RunReport['run']> = {}): RunReport {
  return {
    courierVersion: '9.9.9',
    collection: { id: 'col1', name: 'Shop <API> & "co"', source: 'file', file: 'shop.json', scriptsSha256: 'ab'.repeat(32) },
    environment: { id: 'env1', name: 'Staging' },
    run: { startedAt: '2026-01-02T03:04:05.000Z', finishedAt: '2026-01-02T03:04:06.250Z', durationMs: 1250, iterations: 2, stopped: false, ...over },
    executions: [
      {
        iteration: 0,
        index: 0,
        requestId: 'r1',
        name: 'List',
        folders: ['Orders'],
        method: 'GET',
        url: 'http://127.0.0.1:1/orders?key=••••',
        status: 200,
        statusText: 'OK',
        timeMs: 12,
        sizeBytes: 2048,
        skipped: false,
        passed: true,
        tests: [{ name: 'status is 200', passed: true, source: src('List') }],
        scriptErrors: [],
        console: [{ level: 'log', message: 'count 3', source: src('List') }]
      },
      {
        iteration: 1,
        index: 0,
        requestId: 'r1',
        name: 'List',
        folders: ['Orders'],
        method: 'GET',
        url: 'http://127.0.0.1:1/orders?key=••••',
        status: 500,
        statusText: 'Internal Server Error',
        timeMs: 7,
        sizeBytes: 10,
        skipped: false,
        passed: false,
        tests: [
          { name: 'status is 200', passed: false, error: 'expected 500 to equal 200 & <b>"x"</b>\u0001', source: src('List') },
          { name: 'has <items>', passed: true, source: src('List') }
        ],
        scriptErrors: [{ source: src('List', 'test'), message: "Cannot read 'x'", code: undefined }],
        console: []
      },
      {
        iteration: 1,
        index: 1,
        requestId: 'r2',
        name: 'Health',
        folders: [],
        method: 'POST',
        url: 'http://127.0.0.1:1/health',
        skipped: false,
        passed: false,
        error: { code: 'NETWORK', message: 'connect ECONNREFUSED 127.0.0.1:1' },
        tests: [],
        scriptErrors: [],
        console: []
      },
      {
        iteration: 1,
        index: 2,
        requestId: 'r3',
        name: 'Skip me',
        folders: [],
        method: 'GET',
        url: 'http://127.0.0.1:1/skip',
        skipped: true,
        passed: true,
        tests: [],
        scriptErrors: [],
        console: []
      }
    ]
  }
}

describe('JUnit reporter', () => {
  it('golden output: one suite per iteration + request, failures, errors, skipped, escaping', () => {
    expect(junitReport(report())).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Shop &lt;API&gt; &amp; &quot;co&quot;" tests="6" failures="1" errors="2" skipped="1" time="1.250">
  <testsuite name="Orders / List [iteration 1]" id="0" tests="1" failures="0" errors="0" skipped="0" time="0.012" timestamp="2026-01-02T03:04:05.000Z">
    <properties>
      <property name="method" value="GET"/>
      <property name="url" value="http://127.0.0.1:1/orders?key=••••"/>
      <property name="status" value="200 OK"/>
      <property name="iteration" value="1"/>
    </properties>
    <testcase name="status is 200" classname="Shop &lt;API&gt; &amp; &quot;co&quot;.Orders.List" time="0.000"/>
  </testsuite>
  <testsuite name="Orders / List [iteration 2]" id="1" tests="3" failures="1" errors="1" skipped="0" time="0.007" timestamp="2026-01-02T03:04:05.000Z">
    <properties>
      <property name="method" value="GET"/>
      <property name="url" value="http://127.0.0.1:1/orders?key=••••"/>
      <property name="status" value="500 Internal Server Error"/>
      <property name="iteration" value="2"/>
    </properties>
    <testcase name="status is 200" classname="Shop &lt;API&gt; &amp; &quot;co&quot;.Orders.List" time="0.000">
      <failure type="AssertionFailure" message="expected 500 to equal 200 &amp; &lt;b&gt;&quot;x&quot;&lt;/b&gt;">expected 500 to equal 200 &amp; &lt;b&gt;&quot;x&quot;&lt;/b&gt;</failure>
    </testcase>
    <testcase name="has &lt;items&gt;" classname="Shop &lt;API&gt; &amp; &quot;co&quot;.Orders.List" time="0.000"/>
    <testcase name="test script (request &quot;List&quot;)" classname="Shop &lt;API&gt; &amp; &quot;co&quot;.Orders.List" time="0.000">
      <error type="SCRIPT_ERROR" message="Cannot read &apos;x&apos;">Cannot read &apos;x&apos;</error>
    </testcase>
  </testsuite>
  <testsuite name="Health [iteration 2]" id="2" tests="1" failures="0" errors="1" skipped="0" time="0.000" timestamp="2026-01-02T03:04:05.000Z">
    <properties>
      <property name="method" value="POST"/>
      <property name="url" value="http://127.0.0.1:1/health"/>
      <property name="iteration" value="2"/>
    </properties>
    <testcase name="Health (request)" classname="Shop &lt;API&gt; &amp; &quot;co&quot;.Health" time="0.000">
      <error type="NETWORK" message="connect ECONNREFUSED 127.0.0.1:1">connect ECONNREFUSED 127.0.0.1:1</error>
    </testcase>
  </testsuite>
  <testsuite name="Skip me [iteration 2]" id="3" tests="1" failures="0" errors="0" skipped="1" time="0.000" timestamp="2026-01-02T03:04:05.000Z">
    <properties>
      <property name="method" value="GET"/>
      <property name="url" value="http://127.0.0.1:1/skip"/>
      <property name="iteration" value="2"/>
    </properties>
    <testcase name="Skip me (request)" classname="Shop &lt;API&gt; &amp; &quot;co&quot;.Skip me" time="0.000">
      <skipped message="Skipped by pm.execution.skipRequest()."/>
    </testcase>
  </testsuite>
</testsuites>
`)
  })

  it('a run stopped by an error (loop guard, unknown setNextRequest) adds a Run suite with an <error>', () => {
    const xml = junitReport(report({ stopped: true, stoppedReason: 'loop-guard', stopMessage: 'Stopped after 3 setNextRequest jumps' }))
    expect(xml).toContain('<testsuite name="Run" id="4" tests="1" failures="0" errors="1"')
    expect(xml).toContain('<error type="LOOP_GUARD" message="Stopped after 3 setNextRequest jumps">')
    expect(junitReport(report({ stopped: true, stoppedReason: 'script', stopMessage: 'Stopped by setNextRequest(null)' }))).not.toContain('name="Run"')
  })

  it('escapes the five XML specials and drops characters XML 1.0 cannot carry', () => {
    expect(xmlEscape(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f')
    expect(xmlEscape('x\u0000\u0008\u000b\u001fy\tz\n\r😀￾\uD800')).toBe('xy\tz\n\r😀')
    // Well-formed: no raw "<" or "&" outside markup survives, and no control characters.
    const xml = junitReport(report())
    expect(xml).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/)
    expect(xml.replace(/<[^>]*>/g, '')).not.toMatch(/<|&(?!amp;|lt;|gt;|quot;|apos;)/)
  })
})

describe('JSON reporter', () => {
  it('has the documented, stable top-level structure and per-execution fields', () => {
    const json = JSON.parse(jsonReport(report()))
    expect(Object.keys(json)).toEqual(['format', 'courier', 'collection', 'environment', 'run', 'stats', 'result', 'executions'])
    expect(json.format).toBe('courier.run-report/v1')
    expect(json.courier).toEqual({ version: '9.9.9' })
    expect(json.collection).toEqual({ id: 'col1', name: 'Shop <API> & "co"', source: 'file', file: 'shop.json', scriptsSha256: 'ab'.repeat(32) })
    expect(json.stats).toEqual({ requests: { total: 4, failed: 2, errors: 1, skipped: 1 }, tests: { total: 3, passed: 2, failed: 1 }, scriptErrors: 1 })
    expect(json.result).toBe('failed')
    expect(Object.keys(json.executions[0])).toEqual([
      'iteration', 'index', 'requestId', 'name', 'folders', 'method', 'url', 'status', 'statusText', 'timeMs', 'sizeBytes', 'skipped', 'passed', 'tests', 'scriptErrors', 'console'
    ])
    expect(json.executions[2]).toMatchObject({ name: 'Health', error: { code: 'NETWORK', message: 'connect ECONNREFUSED 127.0.0.1:1' }, passed: false })
    expect(json.executions[2]).not.toHaveProperty('status')
    expect(json.executions[1].scriptErrors[0]).toEqual({ source: { level: 'request', name: 'List', phase: 'test' }, message: "Cannot read 'x'" })
    expect(jsonReport(report()).endsWith('}\n')).toBe(true)
  })
})

describe('console reporter', () => {
  it('golden output without colour: per-request lines with tests, summary table, failures', () => {
    let out = ''
    const c = new ConsoleReporter({ write: (s: string) => (out += s) }, { color: false })
    const r = report()
    c.start(r)
    for (const e of r.executions) c.execution(e, r.run.iterations)
    c.finish(r)
    expect(out).toBe(`Courier 9.9.9 · Shop <API> & "co"  environment "Staging"

Iteration 1/2

→ Orders / List
  GET http://127.0.0.1:1/orders?key=••••  200 OK  12 ms, 2.0 kB
  ┊ log: count 3
  ✓ status is 200

Iteration 2/2

→ Orders / List
  GET http://127.0.0.1:1/orders?key=••••  500 Internal Server Error  7 ms, 10 B
  ✗ status is 200 — expected 500 to equal 200 & <b>"x"</b>\u0001
  ✓ has <items>
  ! test script (request "List"): Cannot read 'x'

→ Health
  POST http://127.0.0.1:1/health  error NETWORK
  ! connect ECONNREFUSED 127.0.0.1:1

→ Skip me
  GET http://127.0.0.1:1/skip  skipped

┌───────────────┬──────────┬────────┐
│               │ executed │ failed │
├───────────────┼──────────┼────────┤
│    iterations │        2 │      1 │
│      requests │        4 │      2 │
│         tests │        3 │      1 │
│ script errors │        1 │        │
└───────────────┴──────────┴────────┘
total run duration: 1.3 s

Failures:
  1. Orders / List (iteration 2) · test script (request "List"): Cannot read 'x'
  2. Orders / List (iteration 2) · test "status is 200": expected 500 to equal 200 & <b>"x"</b>\u0001
  3. Health (iteration 2) · NETWORK: connect ECONNREFUSED 127.0.0.1:1

Result: failed
`)
  })

  it('colours only when asked (TTY), using ANSI codes', () => {
    let out = ''
    const c = new ConsoleReporter({ write: (s: string) => (out += s) }, { color: true })
    c.execution(report().executions[0], 1)
    expect(out).toContain('\x1b[32m✓\x1b[39m')
  })
})

describe('pass/fail rule (exit code 0 vs 1)', () => {
  const passing = (): RunReport => ({ ...report(), executions: [report().executions[0]] })
  it('passes only when every request passed and the run was not stopped by an error', () => {
    expect(runPassed(report())).toBe(false)
    expect(runPassed(passing())).toBe(true)
    expect(stats(passing()).requests.failed).toBe(0)
    for (const stoppedReason of ['error', 'loop-guard', 'user'] as const) expect(runPassed({ ...passing(), run: { ...passing().run, stopped: true, stoppedReason } })).toBe(false)
    expect(runPassed({ ...passing(), run: { ...passing().run, stopped: true, stoppedReason: 'script' } })).toBe(true)
  })
})
