import type { Context, Next } from 'hono'
import {
  PUBLIC_RESPONSE_WITHHELD,
  safeguardPublicPayload,
  sanitizePublicValue,
} from './credential-safety.ts'
import { IDENTITY_JSON_DOOR_PATHS } from './identity-api.ts'
import { PAIR_DOOR_PATH } from './pair.ts'

const PRIVATE_API_READS = new Set(['/api/me'])
// Derived from the same constants identity-api.ts and pair.ts mount their
// one-time-reveal JSON doors at (register, rotate, recovery, pair), so a new
// door added there is never silently missing from this allow-list -- a gap
// here previously let the response-safety middleware redact /api/recovery's
// one-time reveal out of every successful response after the store had
// already committed the replacement credential.
const IDENTITY_DELIVERY_WRITES = new Set<string>([...IDENTITY_JSON_DOOR_PATHS, PAIR_DOOR_PATH])

function shouldSafeguard(c: Context): boolean {
  const path = c.req.path
  if (path === '/') return true
  if (!path.startsWith('/api/')) return false
  if (PRIVATE_API_READS.has(path)) return false
  if (
    c.req.method === 'POST' &&
    IDENTITY_DELIVERY_WRITES.has(path) &&
    c.res.status >= 200 &&
    c.res.status < 300
  ) return false
  return true
}

function readablePublicContentType(value: string): boolean {
  return /(?:^|\s|;)(?:application\/(?:[^;]+\+)?json|text\/plain)(?:\s|;|$)/i.test(value)
}

/**
 * Last response boundary for public HTTP APIs. It preserves status and headers
 * when field-level redaction succeeds and returns a generic 500 only when a
 * credential-bearing payload cannot be parsed and checked safely.
 */
export async function publicResponseSafety(c: Context, next: Next): Promise<void> {
  await next()
  if (!shouldSafeguard(c) || c.req.method === 'HEAD' || c.res.body === null) return

  const contentType = c.res.headers.get('content-type') ?? ''
  if (!readablePublicContentType(contentType)) return

  const rawText = await c.res.clone().text()
  const guarded = safeguardPublicPayload(rawText, contentType)
  if (!guarded.changed) return

  const headers = new Headers(c.res.headers)
  headers.delete('content-length')
  c.res = new Response(guarded.text, {
    status: guarded.withheld ? 500 : c.res.status,
    headers,
  })
}

/** Use when a public route module is mounted without the main app middleware. */
export function publicJson(c: Context, value: unknown) {
  const sanitized = sanitizePublicValue(value)
  return sanitized.withheld
    ? c.json({ error: PUBLIC_RESPONSE_WITHHELD }, 500)
    : c.json(sanitized.value)
}
