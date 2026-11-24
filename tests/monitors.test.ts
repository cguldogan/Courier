/**
 * Monitors: schedule math (intervals, daily and weekday local times across daylight-saving changes),
 * the scheduler on a fake clock (no overlap, one catch-up after a long gap, no replay at start,
 * disable), notification decisions, and real runs through the core: history bounded and masked (a Key
 * Vault value never lands on disk), the script → Key Vault gate applies, a missing collection is a
 * recorded failure. Local echo server + mock Key Vault only.
 */
process.env.TZ = 'America/New_York'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Monitor } from '../src/shared/api'
import { nextOccurrence } from '../src/shared/monitor-schedule'
import { MONITOR_HISTORY_LIMIT, MonitorScheduler, notificationFor, validateSchedule, type Clock, type MonitorNotification } from '../src/main/monitors'
import { newRequest } from '../src/shared/types'
import { ID_A, cleanupTempDirs, echoServer, makeCore, mockVault, readTree, tempDir } from './helpers'
import { CourierCore } from '../src/main/core'

const SECRET = 'monitor-Kv-S3cret-77'
let vault: Awaited<ReturnType<typeof mockVault>>
let echo: Awaited<ReturnType<typeof echoServer>>
beforeAll(async () => {
  vault = await mockVault({ 'api-key': SECRET })
  echo = await echoServer({
    '/fail': (_req, res) => {
      res.statusCode = 500
      res.end('{}')
    }
  })
})
afterAll(async () => {
  await vault.close()
  await echo.close()
  cleanupTempDirs()
})

const local = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()
const fmt = (t: number): string => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

describe('schedule math', () => {
  it('runs in the America/New_York time zone (TZ took effect in this worker)', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/New_York')
    expect(new Date(Date.UTC(2026, 0, 15, 12)).getHours()).toBe(7)
  })

  it('interval: plain elapsed time', () => {
    const t = Date.UTC(2026, 2, 8, 6, 0)
    expect(nextOccurrence({ kind: 'interval', every: 5, unit: 'minutes' }, t) - t).toBe(5 * 60_000)
    expect(nextOccurrence({ kind: 'interval', every: 2, unit: 'hours' }, t) - t).toBe(2 * 3_600_000)
  })

  it('daily: the next local HH:MM strictly after', () => {
    const s = { kind: 'daily' as const, time: '09:00' }
    expect(fmt(nextOccurrence(s, local(2026, 11, 23, 8, 59)))).toBe('2026-11-23 09:00')
    expect(fmt(nextOccurrence(s, local(2026, 11, 23, 9, 0)))).toBe('2026-11-24 09:00')
  })

  it('weekdays: skips Saturday and Sunday', () => {
    const s = { kind: 'weekdays' as const, time: '09:00' }
    // Friday 2026-11-27 10:00 → Monday 2026-11-30 09:00
    expect(fmt(nextOccurrence(s, local(2026, 11, 27, 10, 0)))).toBe('2026-11-30 09:00')
    expect(fmt(nextOccurrence(s, local(2026, 11, 28, 8, 0)))).toBe('2026-11-30 09:00')
  })

  it('DST-safe: 09:00 stays 09:00 local across spring forward and fall back', () => {
    const s = { kind: 'daily' as const, time: '09:00' }
    // 2026-03-08 is spring-forward day in New York (23-hour day).
    const before = nextOccurrence(s, local(2026, 3, 7, 10))
    const after = nextOccurrence(s, before)
    expect([fmt(before), fmt(after)]).toEqual(['2026-03-08 09:00', '2026-03-09 09:00'])
    expect(after - before).toBe(24 * 3_600_000)
    expect(before - nextOccurrence(s, local(2026, 3, 6, 10))).toBe(23 * 3_600_000)
    // 2026-11-01 is fall-back day (25-hour day).
    const fb = nextOccurrence(s, local(2026, 10, 31, 10))
    expect(fmt(fb)).toBe('2026-11-01 09:00')
    expect(nextOccurrence(s, fb) - fb).toBe(24 * 3_600_000)
    expect(fb - nextOccurrence(s, local(2026, 10, 30, 10))).toBe(25 * 3_600_000)
  })

  it('DST edge times: a skipped time runs at the shifted time, a repeated time runs once', () => {
    const gap = nextOccurrence({ kind: 'daily', time: '02:30' }, local(2026, 3, 8, 0))
    expect(fmt(gap)).toBe('2026-03-08 03:30')
    const dup = nextOccurrence({ kind: 'daily', time: '01:30' }, local(2026, 11, 1, 0))
    expect(fmt(dup)).toBe('2026-11-01 01:30')
    const next = nextOccurrence({ kind: 'daily', time: '01:30' }, dup)
    expect(fmt(next)).toBe('2026-11-02 01:30')
    // Even asked from the second 01:30 (one hour later), it does not run again that day.
    expect(fmt(nextOccurrence({ kind: 'daily', time: '01:30' }, dup + 3_600_000))).toBe('2026-11-02 01:30')
  })

  it('validates schedules; seconds only with the test hook', () => {
    expect(() => validateSchedule({ kind: 'interval', every: 5, unit: 'seconds' }, false)).toThrow(/only available in tests/)
    expect(validateSchedule({ kind: 'interval', every: 5, unit: 'seconds' }, true)).toEqual({ kind: 'interval', every: 5, unit: 'seconds' })
    expect(validateSchedule({ kind: 'daily', time: '7:05' }, false)).toEqual({ kind: 'daily', time: '07:05' })
    expect(() => validateSchedule({ kind: 'daily', time: '25:00' }, false)).toThrow(/HH:MM/)
    expect(() => validateSchedule({ kind: 'interval', every: 0, unit: 'minutes' }, false)).toThrow()
  })
})

class FakeClock implements Clock {
  t = local(2026, 11, 23, 12, 0)
  fns: (() => void)[] = []
  now(): number {
    return this.t
  }
  setInterval(fn: () => void): unknown {
    this.fns.push(fn)
    return fn
  }
  clearInterval(h: unknown): void {
    this.fns = this.fns.filter((f) => f !== h)
  }
  advance(ms: number): void {
    this.t += ms
    for (const f of this.fns) f()
  }
}

function monitor(partial: Partial<Monitor> = {}): Monitor {
  return { id: 'm1', name: 'M', collectionId: 'c1', folderIds: [], environmentId: null, iterations: 1, schedule: { kind: 'interval', every: 5, unit: 'minutes' }, enabled: true, notifyOnFailure: true, createdAt: '', ...partial }
}

describe('scheduler (fake clock)', () => {
  function setup(runMs = 0): { clock: FakeClock; sched: MonitorScheduler; runs: { id: string; at: number }[]; finish: () => void } {
    const clock = new FakeClock()
    const runs: { id: string; at: number }[] = []
    let pending: (() => void)[] = []
    const sched = new MonitorScheduler({
      clock,
      tickMs: 1000,
      run: (m) => {
        runs.push({ id: m.id, at: clock.now() })
        return runMs ? new Promise<void>((r) => pending.push(r)) : Promise.resolve()
      }
    })
    sched.start()
    return {
      clock,
      sched,
      runs,
      finish: () => {
        for (const p of pending) p()
        pending = []
      }
    }
  }
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it('interval: no run at start (nothing replayed), then every 5 minutes', async () => {
    const { clock, sched, runs } = setup()
    sched.update([monitor()])
    clock.advance(4 * 60_000)
    expect(runs).toHaveLength(0)
    clock.advance(60_000)
    await flush()
    clock.advance(5 * 60_000)
    await flush()
    expect(runs.map((r) => (r.at - local(2026, 11, 23, 12, 0)) / 60_000)).toEqual([5, 10])
  })

  it('a long gap (sleep) gives exactly one catch-up run, then the schedule continues from then', async () => {
    const { clock, sched, runs } = setup()
    sched.update([monitor()])
    clock.t += 3 * 3_600_000 // asleep: no ticks for 3 hours
    clock.advance(0)
    await flush()
    clock.advance(1000)
    await flush()
    expect(runs).toHaveLength(1)
    clock.advance(5 * 60_000)
    await flush()
    expect(runs).toHaveLength(2)
  })

  it('never overlaps: an occurrence due while the previous run is still going is skipped', async () => {
    const { clock, sched, runs, finish } = setup(1)
    sched.update([monitor({ schedule: { kind: 'interval', every: 1, unit: 'minutes' } })])
    clock.advance(60_000)
    await flush()
    expect(runs).toHaveLength(1)
    expect(sched.isRunning('m1')).toBe(true)
    clock.advance(60_000)
    clock.advance(60_000)
    await flush()
    expect(runs).toHaveLength(1)
    expect(() => sched.runNow(monitor())).toThrow(/is running/)
    finish()
    await flush()
    clock.advance(60_000)
    await flush()
    expect(runs).toHaveLength(2)
    finish()
  })

  it('disable stops scheduling; re-enabling schedules from now; daily runs at its local time', async () => {
    const { clock, sched, runs } = setup()
    sched.update([monitor({ enabled: false })])
    clock.advance(10 * 60_000)
    await flush()
    expect(runs).toHaveLength(0)
    expect(sched.nextRunAt('m1')).toBeUndefined()
    sched.update([monitor()])
    expect(sched.nextRunAt('m1')).toBe(clock.now() + 5 * 60_000)
    sched.update([monitor({ id: 'd', schedule: { kind: 'daily', time: '13:00' } })])
    expect(fmt(sched.nextRunAt('d')!)).toBe('2026-11-23 13:00')
    clock.advance(50 * 60_000)
    await flush()
    expect(runs).toHaveLength(1)
    expect(fmt(sched.nextRunAt('d')!)).toBe('2026-11-24 13:00')
    sched.stop()
    clock.advance(24 * 3_600_000)
    await flush()
    expect(runs).toHaveLength(1)
  })
})

describe('notification decisions', () => {
  it.each([
    ['first run fails', undefined, false, 'failure'],
    ['pass → fail', true, false, 'failure'],
    ['fail → fail (repeat) stays quiet', false, false, null],
    ['fail → pass (recovery) once', false, true, 'recovery'],
    ['pass → pass', true, true, null],
    ['first run passes', undefined, true, null]
  ] as const)('%s', (_n, prev, passed, want) => {
    expect(notificationFor(prev, passed, true)).toBe(want)
    expect(notificationFor(prev, passed, false)).toBe(null)
  })
})

describe('monitor runs through the core', () => {
  it('records passing and failing runs, notifies on failure and recovery, masks Key Vault values everywhere on disk', async () => {
    const ud = tempDir('courier-mon-ud-')
    const notes: MonitorNotification[] = []
    const core = new CourierCore({ userDataDir: ud, fakeIdentity: ID_A, keyVaultInsecureChallenge: true, notify: (n) => notes.push(n) })
    await core.init()
    await core.updateSettings({ keyVault: { vaults: [{ alias: 'main', url: vault.url }], cacheTtlSeconds: 300 } })
    await core.signIn({ mode: 'azure-cli' })
    const { collection } = await core.createCollection({ name: 'Monitored' })
    const ok = newRequest({
      name: 'Health',
      url: `${echo.url}/health`,
      headers: [{ key: 'X-Key', value: '{{vault:main/api-key}}', enabled: true }],
      testScript: "pm.test('status 200', () => pm.response.to.have.status(200)); pm.test('echo ' + pm.response.text(), () => pm.expect(pm.response.text()).to.include('NEVER'))"
    })
    await core.upsertItem({ collectionId: collection.id, item: ok })
    const m = await core.monitorSave({ name: 'Health check', collectionId: collection.id, folderIds: [], environmentId: null, iterations: 1, schedule: { kind: 'interval', every: 5, unit: 'minutes' }, enabled: true, notifyOnFailure: true })
    const first = await core.monitorRunNow(m.id)
    expect(echo.requests.at(-1)?.headers['x-key']).toBe(SECRET)
    expect(first).toMatchObject({ passed: false, totalRequests: 1, failedTests: 1, trigger: 'manual' })
    const run = await core.monitorGetRun({ monitorId: m.id, runId: first.id })
    expect(run.results[0].failedTests[0].name).toContain('••••')
    expect(JSON.stringify(run)).not.toContain(SECRET)
    expect(notes.map((n) => n.kind)).toEqual(['failure'])
    // repeat failure: no second notification
    await core.monitorRunNow(m.id)
    expect(notes).toHaveLength(1)
    // fix the test → recovery notifies once
    await core.upsertItem({ collectionId: collection.id, item: { ...ok, testScript: "pm.test('status 200', () => pm.response.to.have.status(200))" } })
    const third = await core.monitorRunNow(m.id)
    expect(third.passed).toBe(true)
    expect(notes.map((n) => n.kind)).toEqual(['failure', 'recovery'])
    await core.monitorRunNow(m.id)
    expect(notes).toHaveLength(2)
    expect((await core.monitorHistory(m.id)).map((h) => h.passed)).toEqual([true, true, false, false])
    expect((await core.monitorsList())[0]).toMatchObject({ id: m.id, collectionName: 'Monitored', lastRun: { passed: true }, running: false })
    for (const f of readTree(ud)) expect(f.content.includes(SECRET), f.path).toBe(false)
    expect(readTree(ud).some((f) => f.path.includes('monitor-runs'))).toBe(true)
  })

  it('no extra privileges: a script reading Key Vault fails with the existing error unless the collection is allowed', async () => {
    const core = await makeCore({ identity: ID_A, insecureKv: true, settings: { keyVault: { vaults: [{ alias: 'main', url: vault.url }], cacheTtlSeconds: 300 } } })
    const { collection } = await core.createCollection({ name: 'Gated' })
    await core.upsertItem({ collectionId: collection.id, item: newRequest({ name: 'Peek', url: `${echo.url}/peek`, preRequestScript: "pm.vault.get('api-key').then((v) => pm.environment.set('x', v))" }) })
    const m = await core.monitorSave({ name: 'Gate', collectionId: collection.id, folderIds: [], environmentId: null, iterations: 1, schedule: { kind: 'daily', time: '09:00' }, enabled: true, notifyOnFailure: false })
    const r = await core.monitorRunNow(m.id)
    expect(r.passed).toBe(false)
    const run = await core.monitorGetRun({ monitorId: m.id, runId: r.id })
    expect(run.results[0].error?.code).toBe('VAULT_SCRIPT_BLOCKED')
    expect(run.results[0].error?.message).toMatch(/turn on "Allow this collection's scripts to read Key Vault secrets"/)
    await core.setScriptVaultAccess({ id: collection.id, allowed: true })
    expect((await core.monitorRunNow(m.id)).passed).toBe(true)
  })

  it('a missing collection is a recorded failure; history is bounded; delete removes the history file', async () => {
    const ud = tempDir('courier-mon-ud2-')
    const core = await makeCore({ userDataDir: ud })
    const { collection } = await core.createCollection({ name: 'Doomed' })
    await core.upsertItem({ collectionId: collection.id, item: newRequest({ name: 'A', url: `${echo.url}/a` }) })
    const m = await core.monitorSave({ name: 'Doomed', collectionId: collection.id, folderIds: [], environmentId: null, iterations: 1, schedule: { kind: 'interval', every: 1, unit: 'hours' }, enabled: true, notifyOnFailure: false })
    await core.deleteDoc('collection', collection.id)
    const r = await core.monitorRunNow(m.id)
    expect(r).toMatchObject({ passed: false, error: { code: 'NOT_FOUND', message: expect.stringMatching(/no longer exists/) } })
    for (let i = 0; i < MONITOR_HISTORY_LIMIT + 3; i++) await core.monitorRunNow(m.id)
    expect(await core.monitorHistory(m.id)).toHaveLength(MONITOR_HISTORY_LIMIT)
    await core.monitorDelete(m.id)
    expect(readTree(ud).some((f) => f.path.includes(`monitor-runs`) && f.path.includes(m.id))).toBe(false)
    await expect(core.monitorHistory(m.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('scheduled runs fire on the fake clock through the core', async () => {
    const clock = new FakeClock()
    const core = new CourierCore({ userDataDir: tempDir('courier-mon-ud3-'), monitorClock: clock, monitorTickMs: 1000, monitorSeconds: true })
    await core.init()
    await core.startMonitors()
    const { collection } = await core.createCollection({ name: 'Ticked' })
    await core.upsertItem({ collectionId: collection.id, item: newRequest({ name: 'Tick', url: `${echo.url}/tick` }) })
    const m = await core.monitorSave({ name: 'Ticker', collectionId: collection.id, folderIds: [], environmentId: null, iterations: 2, schedule: { kind: 'interval', every: 10, unit: 'seconds' }, enabled: true, notifyOnFailure: false })
    const before = echo.requests.filter((r) => r.url === '/tick').length
    clock.advance(10_000)
    for (let i = 0; i < 50 && !(await core.monitorHistory(m.id)).length; i++) await new Promise((r) => setTimeout(r, 20))
    const h = await core.monitorHistory(m.id)
    expect(h[0]).toMatchObject({ trigger: 'schedule', passed: true, totalRequests: 2 })
    expect(echo.requests.filter((r) => r.url === '/tick').length - before).toBe(2)
    await core.monitorSetEnabled({ id: m.id, enabled: false })
    clock.advance(60_000)
    await new Promise((r) => setTimeout(r, 50))
    expect(await core.monitorHistory(m.id)).toHaveLength(1)
    await core.shutdown()
  })
})
