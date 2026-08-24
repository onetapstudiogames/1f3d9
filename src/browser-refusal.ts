import { randomUUID } from 'node:crypto'
import type { Context } from 'hono'
import { errorClassForStatus, type ErrorClass } from './error-class.ts'

export interface BrowserRefusalReference {
  errorClass: ErrorClass
  reason: BrowserRefusalReason
  requestId: string
}

export const BROWSER_REFUSAL_REASONS = [
  'browser_cookie_mismatch',
  'browser_cookie_missing',
  'client_not_approved',
  'confirmation_not_ready',
  'confirmation_rejected',
  'credential_rejected',
  'handle_taken',
  'invalid_form',
  'invalid_identity',
  'invalid_request',
  'rate_limited',
  'request_expired',
  'request_unavailable',
  'reserved_handle',
  'resident_key_rejected',
  'storage_unavailable',
  'unexpected_form_fields',
  'untrusted_browser_request',
] as const

export type BrowserRefusalReason = typeof BROWSER_REFUSAL_REASONS[number]

export function markBrowserRefusal(
  c: Context,
  status: number,
  reason: BrowserRefusalReason,
  requestId = c.res.headers.get('X-Request-ID') ?? randomUUID(),
): BrowserRefusalReference {
  const errorClass = errorClassForStatus(status)
  c.header('X-Request-ID', requestId)
  c.header('X-1F3D9-Error-Class', errorClass)
  c.header('X-1F3D9-Reason', reason)
  return { errorClass, reason, requestId }
}
