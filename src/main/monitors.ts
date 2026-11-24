/**
 * Monitors: scheduled collection runs while the app is open (no Electron here; testable with a fake
 * clock). Definitions and run history are stored on this machine only (userData), never synced.
 *
 * Scheduling: a short tick (default 15 s) compares the clock with each enabled monitor's next run time.
 * A due monitor runs once and its next time is computed from *now*, so a long gap (sleep, a busy
 * machine) gives at most one catch-up run. When the app starts, next times are computed from the start:
 * runs missed while the app was closed are not replayed. A monitor never overlaps itself: an
 * occurrence that falls due while its previous run is still going is skipped.
 *
 * Runs go through the same engine as the collection runner, with the same Key Vault rules (core decides
 * the script → Key Vault gate and team vault approvals at run time; a monitor has no extra privileges).
 */
import { join } from 'node:path'
import type { Monitor, MonitorInfo, MonitorRun, MonitorRunSummary, MonitorSchedule } from '../shared/api'
import { MAX_INTERVAL_HOURS, MIN_INTERVAL_MINUTES, nextOccurrence, parseTime } from '../shared/monitor-schedule'
import { isValidId } from '../shared/serialize'
import { newId, type Id } from '../shared/types'
import { Fault } from './errors'
import { JsonFile } from './store'

export const MONITOR_HISTORY_LIMIT = 100
/** Per-request results kept for one run (the totals always count every request). */
export const MONITOR_RESULTS_LIMIT = 500
export const MAX_MONITORS = 200

export interface Clock {
  now(): number
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms)
    h.unref?.()
    return h
  },
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout)
}

export type NotificationKind = 'failure' | 'recovery'

/**
 * Whether a finished run should raise an OS notification: on the first failure after a pass (or the
 * very first run), and once when a failing monitor passes again. Repeated failures stay silent (the
 * in-app badge shows them).
 */
export function notificationFor(previousPassed: boolean | undefined, passed: boolean, notifyOnFailure: boolean): NotificationKind | null {
  if (!notifyOnFailure) return null
  if (!passed && previousPassed !== false) return 'failure'
  if (passed && previousPassed === false) return 'recovery'
  return null
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export function validateSchedule(v: unknown, allowSeconds: boolean): MonitorSchedule {
  if (!isObj(v)) throw new Fault('INVALID_ARGUMENT', 'A monitor needs a schedule.')
  if (v.kind === 'interval') {
    const every = Math.floor(Number(v.every))
    const unit = v.unit
    if (unit === 'seconds') {
      if (!allowSeconds) throw new Fault('INVALID_ARGUMENT', 'Intervals in seconds are only available in tests.')
      if (!(every >= 1 && every <= 3600)) throw new Fault('INVALID_ARGUMENT', 'Every 1 to 3600 seconds.')
      return { kind: 'interval', every, unit }
    }
    if (unit === 'minutes') {
      if (!(every >= MIN_INTERVAL_MINUTES && every <= MAX_INTERVAL_HOURS * 60)) throw new Fault('INVALID_ARGUMENT', `Every ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_HOURS * 60} minutes.`)
      return { kind: 'interval', every, unit }
    }
    if (unit === 'hours') {
      if (!(every >= 1 && every <= MAX_INTERVAL_HOURS)) throw new Fault('INVALID_ARGUMENT', `Every 1 to ${MAX_INTERVAL_HOURS} hours.`)
      return { kind: 'interval', every, unit }
    }
    throw new Fault('INVALID_ARGUMENT', 'Interval unit must be minutes or hours.')
  }
  if (v.kind === 'daily' || v.kind === 'weekdays') {
    const t = parseTime(String(v.time ?? ''))
    if (!t) throw new Fault('INVALID_ARGUMENT', 'The time must be HH:MM (24-hour).')
    return { kind: v.kind, time: `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}` }
  }
  throw new Fault('INVALID_ARGUMENT', 'Unknown schedule (interval, daily or weekdays).')
}

export function validateMonitor(v: unknown, opts: { allowSeconds: boolean; existing?: Monitor; now: number }): Monitor {
  if (!isObj(v)) throw new Fault('INVALID_ARGUMENT', 'A monitor must be an object.')
  const name = typeof v.name === 'string' ? v.name.trim().replace(/\s+/g, ' ').slice(0, 100) : ''
  if (!name) throw new Fault('INVALID_ARGUMENT', 'A monitor needs a name.')
  if (!isValidId(v.collectionId)) throw new Fault('INVALID_ARGUMENT', 'Choose a collection.')
  const folderIds = Array.isArray(v.folderIds) ? v.folderIds.filter(isValidId).slice(0, 50) : []
  const environmentId = v.environmentId === null || v.environmentId === undefined || v.environmentId === '' ? null : isValidId(v.environmentId) ? v.environmentId : null
  const iterations = Math.min(100, Math.max(1, Math.floor(Number(v.iterations) || 1)))
  return {
    id: opts.existing?.id ?? newId(),
    name,
    collectionId: v.collectionId,
    folderIds,
    environmentId,
    iterations,
    schedule: validateSchedule(v.schedule, opts.allowSeconds),
    enabled: v.enabled !== false,
    notifyOnFailure: v.notifyOnFailure !== false,
    createdAt: opts.existing?.createdAt ?? new Date(opts.now).toISOString()
  }
}

// ---------------------------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------------------------

export class MonitorScheduler {
  private readonly next = new Map<Id, number>()
  private readonly keys = new Map<Id, string>()
  private readonly running = new Set<Id>()
  private monitors: Monitor[] = []
  private handle: unknown = null

  constructor(
    private readonly opts: {
      clock: Clock
      /** Runs one monitor; the scheduler only tracks that it is running. */
      run: (m: Monitor, trigger: 'schedule' | 'manual') => Promise<unknown>
      tickMs?: number
      /** After a run started or the schedule changed (UI refresh). */
      changed?: () => void
    }
  ) {}

  start(): void {
    if (this.handle !== null) return
    this.handle = this.opts.clock.setInterval(() => this.tick(), this.opts.tickMs ?? 15_000)
  }

  stop(): void {
    if (this.handle !== null) this.opts.clock.clearInterval(this.handle)
    this.handle = null
  }

  /** Replace the monitor list. New, re-enabled or re-scheduled monitors get a next time from now. */
  update(list: Monitor[]): void {
    const now = this.opts.clock.now()
    this.monitors = list
    const ids = new Set(list.map((m) => m.id))
    for (const id of [...this.next.keys()]) if (!ids.has(id)) this.next.delete(id)
    for (const m of list) {
      const key = JSON.stringify([m.enabled, m.schedule])
      if (!m.enabled) {
        this.next.delete(m.id)
      } else if (this.keys.get(m.id) !== key || !this.next.has(m.id)) {
        this.next.set(m.id, nextOccurrence(m.schedule, now))
      }
      this.keys.set(m.id, key)
    }
  }

  nextRunAt(id: Id): number | undefined {
    return this.next.get(id)
  }

  isRunning(id: Id): boolean {
    return this.running.has(id)
  }

  /** One scheduling pass (called by the timer; tests call it directly). */
  tick(): void {
    const now = this.opts.clock.now()
    let changed = false
    for (const m of this.monitors) {
      if (!m.enabled) continue
      const due = this.next.get(m.id)
      if (due === undefined || due > now) continue
      this.next.set(m.id, nextOccurrence(m.schedule, now))
      changed = true
      if (this.running.has(m.id)) continue // never overlap: this occurrence is skipped
      this.launch(m, 'schedule')
    }
    if (changed) this.opts.changed?.()
  }

  runNow(m: Monitor): Promise<unknown> {
    if (this.running.has(m.id)) throw new Fault('BUSY', `Monitor "${m.name}" is running; wait for it to finish.`)
    return this.launch(m, 'manual')
  }

  private launch(m: Monitor, trigger: 'schedule' | 'manual'): Promise<unknown> {
    this.running.add(m.id)
    const p = Promise.resolve()
      .then(() => this.opts.run(m, trigger))
      .finally(() => {
        this.running.delete(m.id)
        this.opts.changed?.()
      })
    p.catch(() => undefined)
    return p
  }
}

// ---------------------------------------------------------------------------------------------
// Service: storage + scheduler + notifications
// ---------------------------------------------------------------------------------------------

interface MonitorsFile {
  monitors: Monitor[]
  /** Last run summary per monitor (for the list and notification decisions). */
  last: Record<Id, MonitorRunSummary>
}

export interface MonitorNotification {
  kind: NotificationKind
  monitorId: Id
  runId: Id
  title: string
  body: string
}

export function summaryOf(r: MonitorRun): MonitorRunSummary {
  const { results: _r, resultsOmitted: _o, ...rest } = r
  return rest
}

export class MonitorService {
  readonly scheduler: MonitorScheduler
  private readonly file: JsonFile<MonitorsFile>
  private readonly dir: string
  private cache: MonitorsFile | null = null

  constructor(
    private readonly opts: {
      userDataDir: string
      clock?: Clock
      tickMs?: number
      allowSeconds: boolean
      /** Runs the collection for a monitor and returns the (masked) run record. Must not throw. */
      execute: (m: Monitor, trigger: 'schedule' | 'manual') => Promise<MonitorRun>
      notify?: (n: MonitorNotification) => void
      changed?: () => void
      collectionName?: (id: Id) => Promise<string | undefined>
    }
  ) {
    this.file = new JsonFile(join(opts.userDataDir, 'monitors.json'), () => ({ monitors: [], last: {} }))
    this.dir = join(opts.userDataDir, 'monitor-runs')
    this.scheduler = new MonitorScheduler({
      clock: this.clock,
      tickMs: opts.tickMs,
      run: (m, trigger) => this.runAndRecord(m, trigger),
      changed: () => opts.changed?.()
    })
  }

  private get clock(): Clock {
    return this.opts.clock ?? systemClock
  }

  private async data(): Promise<MonitorsFile> {
    if (!this.cache) {
      const raw = await this.file.read()
      const monitors: Monitor[] = []
      for (const m of Array.isArray(raw.monitors) ? raw.monitors : []) {
        try {
          monitors.push(validateMonitor(m, { allowSeconds: true, existing: isObj(m) && isValidId(m.id) ? (m as Monitor) : undefined, now: this.clock.now() }))
        } catch {
          /* a broken entry is dropped */
        }
      }
      this.cache = { monitors: monitors.slice(0, MAX_MONITORS), last: isObj(raw.last) ? (raw.last as Record<Id, MonitorRunSummary>) : {} }
    }
    return this.cache
  }

  private async write(fn: (d: MonitorsFile) => void): Promise<MonitorsFile> {
    const d = await this.data()
    fn(d)
    await this.file.write(d)
    this.scheduler.update(d.monitors)
    this.opts.changed?.()
    return d
  }

  async start(): Promise<void> {
    this.scheduler.update((await this.data()).monitors)
    this.scheduler.start()
  }

  stop(): void {
    this.scheduler.stop()
  }

  async list(): Promise<MonitorInfo[]> {
    const d = await this.data()
    const out: MonitorInfo[] = []
    for (const m of d.monitors) {
      const next = this.scheduler.nextRunAt(m.id)
      const name = await this.opts.collectionName?.(m.collectionId)
      out.push({
        ...m,
        running: this.scheduler.isRunning(m.id),
        ...(m.enabled && next !== undefined ? { nextRunAt: new Date(next).toISOString() } : {}),
        ...(d.last[m.id] ? { lastRun: d.last[m.id] } : {}),
        ...(name !== undefined ? { collectionName: name } : {})
      })
    }
    return out
  }

  async get(id: unknown): Promise<Monitor> {
    if (!isValidId(id)) throw new Fault('INVALID_ARGUMENT', 'Invalid monitor id.')
    const m = (await this.data()).monitors.find((x) => x.id === id)
    if (!m) throw new Fault('NOT_FOUND', 'Monitor not found.')
    return m
  }

  async info(id: Id): Promise<MonitorInfo> {
    const m = (await this.list()).find((x) => x.id === id)
    if (!m) throw new Fault('NOT_FOUND', 'Monitor not found.')
    return m
  }

  async save(input: unknown): Promise<MonitorInfo> {
    const d = await this.data()
    const id = isObj(input) ? input.id : undefined
    const existing = isValidId(id) ? d.monitors.find((m) => m.id === id) : undefined
    const m = validateMonitor(input, { allowSeconds: this.opts.allowSeconds, existing, now: this.clock.now() })
    if (!existing && d.monitors.length >= MAX_MONITORS) throw new Fault('INVALID_ARGUMENT', `At most ${MAX_MONITORS} monitors.`)
    await this.write((x) => {
      const i = x.monitors.findIndex((y) => y.id === m.id)
      if (i >= 0) x.monitors[i] = m
      else x.monitors.push(m)
    })
    return this.info(m.id)
  }

  async remove(id: Id): Promise<void> {
    await this.get(id)
    await this.write((x) => {
      x.monitors = x.monitors.filter((m) => m.id !== id)
      delete x.last[id]
    })
    const { rm } = await import('node:fs/promises')
    await rm(this.runsFile(id).path, { force: true })
  }

  async setEnabled(id: Id, enabled: boolean): Promise<MonitorInfo> {
    if (typeof enabled !== 'boolean') throw new Fault('INVALID_ARGUMENT', 'enabled must be true or false.')
    await this.get(id)
    await this.write((x) => {
      const m = x.monitors.find((y) => y.id === id)
      if (m) m.enabled = enabled
    })
    return this.info(id)
  }

  async runNow(id: Id): Promise<MonitorRunSummary> {
    const m = await this.get(id)
    await this.scheduler.runNow(m)
    const last = (await this.data()).last[id]
    if (!last) throw new Fault('INTERNAL', 'The run left no record.')
    return last
  }

  private runsFile(id: Id): JsonFile<MonitorRun[]> {
    return new JsonFile(join(this.dir, `${id}.json`), () => [])
  }

  async history(id: Id): Promise<MonitorRunSummary[]> {
    await this.get(id)
    const runs = await this.runsFile(id).read()
    return (Array.isArray(runs) ? runs : []).map(summaryOf)
  }

  async getRun(monitorId: Id, runId: Id): Promise<MonitorRun> {
    await this.get(monitorId)
    const runs = await this.runsFile(monitorId).read()
    const r = (Array.isArray(runs) ? runs : []).find((x) => x.id === runId)
    if (!r) throw new Fault('NOT_FOUND', 'That run is no longer in the history.')
    return r
  }

  /** Executes, stores (bounded) and decides on a notification. */
  private async runAndRecord(m: Monitor, trigger: 'schedule' | 'manual'): Promise<void> {
    this.opts.changed?.()
    const run = await this.opts.execute(m, trigger)
    if (run.results.length > MONITOR_RESULTS_LIMIT) {
      run.resultsOmitted = run.results.length - MONITOR_RESULTS_LIMIT
      run.results = run.results.slice(0, MONITOR_RESULTS_LIMIT)
    }
    await this.runsFile(m.id).update((cur) => [run, ...(Array.isArray(cur) ? cur : [])].slice(0, MONITOR_HISTORY_LIMIT))
    const d = await this.data()
    // Deleted while running: keep nothing.
    if (!d.monitors.some((x) => x.id === m.id)) {
      const { rm } = await import('node:fs/promises')
      await rm(this.runsFile(m.id).path, { force: true })
      return
    }
    const previous = d.last[m.id]?.passed
    await this.write((x) => {
      x.last[m.id] = summaryOf(run)
    })
    const kind = notificationFor(previous, run.passed, m.notifyOnFailure)
    if (kind && this.opts.notify) {
      const counts = run.error ? run.error.message : `${run.failedRequests} of ${run.totalRequests} request(s) failed, ${run.failedTests} test(s) failed`
      this.opts.notify({
        kind,
        monitorId: m.id,
        runId: run.id,
        title: kind === 'failure' ? `Monitor failed: ${m.name}` : `Monitor passing again: ${m.name}`,
        body: kind === 'failure' ? counts : `${run.totalRequests} request(s), ${run.passedTests} test(s) passed.`
      })
    }
  }
}
