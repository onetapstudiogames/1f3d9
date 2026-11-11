// Staged sign-in and join holds report when their stored hold ends, so the browser save
// page can state it. The value is UTC to the whole second; these tests compare the rest
// of a result exactly and check that value separately.
import assert from 'node:assert/strict'

const UTC_WHOLE_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u

export function withoutStoredExpiry<T extends object>(value: T): Omit<T, 'expiresAt' | 'expires_at'> {
  const { expiresAt, expires_at: expiresAtColumn, ...rest } = value as T & { expiresAt?: unknown; expires_at?: unknown }
  const expiry = expiresAt ?? expiresAtColumn
  assert.equal(typeof expiry, 'string', 'a staged hold reports its stored end')
  assert.match(expiry as string, UTC_WHOLE_SECOND)
  return rest as Omit<T, 'expiresAt' | 'expires_at'>
}
