/**
 * Monitor schedules (pure; main schedules with it, the renderer describes it).
 *
 * Daily and weekday times are local wall-clock times, built per calendar day with the local `Date`
 * constructor (never by adding 24 hours), so a run stays at 09:00 across daylight-saving changes. A
 * time that does not exist on a spring-forward day runs at the shifted time JavaScript gives it
 * (02:30 → 03:30); a time that occurs twice on a fall-back day runs once (the first occurrence).
 * Intervals are plain elapsed time.
 */
import type { MonitorSchedule } from './api'

export const MIN_INTERVAL_MINUTES = 1
export const MAX_INTERVAL_HOURS = 24 * 7

export function parseTime(t: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  return h <= 23 && min <= 59 ? { h, m: min } : null
}

export function intervalMs(s: Extract<MonitorSchedule, { kind: 'interval' }>): number {
  const unit = s.unit === 'seconds' ? 1000 : s.unit === 'minutes' ? 60_000 : 3_600_000
  return Math.max(1, s.every) * unit
}

/** The first scheduled time strictly after `after` (epoch ms). */
export function nextOccurrence(s: MonitorSchedule, after: number): number {
  if (s.kind === 'interval') return after + intervalMs(s)
  const t = parseTime(s.time) ?? { h: 9, m: 0 }
  const base = new Date(after)
  for (let i = 0; i < 10; i++) {
    const cand = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, t.h, t.m, 0, 0)
    if (s.kind === 'weekdays' && (cand.getDay() === 0 || cand.getDay() === 6)) continue
    if (cand.getTime() > after) return cand.getTime()
  }
  return after + 24 * 3_600_000
}

export function describeSchedule(s: MonitorSchedule): string {
  if (s.kind === 'interval') return `Every ${s.every} ${s.every === 1 ? s.unit.replace(/s$/, '') : s.unit}`
  return `${s.kind === 'daily' ? 'Every day' : 'Weekdays (Mon–Fri)'} at ${s.time}`
}
