/**
 * Thin helpers around `window.courier`. Every engine call returns a `Result<T>`; `call()` unwraps it
 * and surfaces failures as a toast (unless `quiet`), then rethrows so callers can stop their flow.
 */
import { CourierError, type CourierApi, type Result } from '../../shared/api'
import { useApp } from './store'

export const courier = (): CourierApi => window.courier

export function errorMessage(err: unknown): string {
  if (err instanceof CourierError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

export function errorCode(err: unknown): string | undefined {
  return err instanceof CourierError ? err.code : undefined
}

export async function call<T>(p: Promise<Result<T>>, opts: { quiet?: boolean; context?: string } = {}): Promise<T> {
  let r: Result<T>
  try {
    r = await p
  } catch (err) {
    r = { ok: false, error: { code: 'INTERNAL', message: errorMessage(err) } }
  }
  if (r.ok) return r.value
  if (!opts.quiet) useApp.getState().toast('error', opts.context ? `${opts.context}: ${r.error.message}` : r.error.message)
  throw new CourierError(r.error.code, r.error.message)
}

/** Like `call` but returns `undefined` instead of throwing (error already toasted). */
export async function attempt<T>(p: Promise<Result<T>>, opts: { quiet?: boolean; context?: string } = {}): Promise<T | undefined> {
  try {
    return await call(p, opts)
  } catch {
    return undefined
  }
}

/** For `Result<void>` methods: true on success (error already toasted). */
export async function succeeded(p: Promise<Result<unknown>>, opts: { quiet?: boolean; context?: string } = {}): Promise<boolean> {
  try {
    await call(p, opts)
    return true
  } catch {
    return false
  }
}
