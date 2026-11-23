import type { CourierErrorInfo, ErrorCode } from '../shared/api'

/** An expected failure with a stable code and a user-presentable message. */
export class Fault extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'Fault'
    this.code = code
  }
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'])

export function errorCodeOf(err: unknown): string | undefined {
  let e: unknown = err
  for (let i = 0; i < 4 && e; i++) {
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string' && code) return code
    e = (e as { cause?: unknown }).cause
  }
  return undefined
}

export function isNetworkError(err: unknown): boolean {
  const code = errorCodeOf(err)
  return (code !== undefined && NETWORK_CODES.has(code)) || code === 'REQUEST_SEND_ERROR'
}

/** Converts anything thrown into the wire error shape. */
export function toErrorInfo(err: unknown): CourierErrorInfo {
  if (err instanceof Fault) return { code: err.code, message: err.message }
  if (isNetworkError(err)) return { code: 'NETWORK', message: messageOf(err) }
  return { code: 'INTERNAL', message: messageOf(err) }
}

export function messageOf(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause
    if (err.message === 'fetch failed' && cause instanceof Error) return cause.message
    return err.message || String(err)
  }
  return String(err)
}
