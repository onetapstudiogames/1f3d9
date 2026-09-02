import { randomBytes } from 'node:crypto'
import type { Context } from 'hono'

const COOKIE_VALUE = /^([0-9a-f]{64})\.([0-9a-f]{64})$/u

export interface BrowserSessionCookie {
  raw: string
  session: string
  csrf: string
}

export type BrowserSessionCookieState =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'valid'; cookie: BrowserSessionCookie }

export function newBrowserSessionCookie(): BrowserSessionCookie {
  const session = randomBytes(32).toString('hex')
  const csrf = randomBytes(32).toString('hex')
  return { raw: `${session}.${csrf}`, session, csrf }
}

/**
 * Parse the same "session.csrf" shape a browser session cookie uses. A JSON
 * identity door (src/identity-api.ts) reuses this to correlate its own
 * stage/confirm calls with a stage_token instead of a cookie, without
 * duplicating the random-pair format or its validation.
 */
export function parseSessionToken(raw: string): BrowserSessionCookie | null {
  const parsed = COOKIE_VALUE.exec(raw)
  return parsed ? { raw, session: parsed[1]!, csrf: parsed[2]! } : null
}

export function inspectBrowserSessionCookie(
  c: Context,
  name: string,
): BrowserSessionCookieState {
  const values: string[] = []
  for (const part of (c.req.header('cookie') ?? '').split(';')) {
    const [candidate, ...value] = part.trim().split('=')
    if (candidate === name) values.push(value.join('='))
  }
  if (values.length === 0) return { kind: 'missing' }
  if (values.length !== 1) return { kind: 'invalid' }
  const cookie = parseSessionToken(values[0]!)
  return cookie ? { kind: 'valid', cookie } : { kind: 'invalid' }
}

export function setBrowserSessionCookie(
  c: Context,
  name: string,
  value: string,
  maxAgeSeconds = 900,
): void {
  c.header('Set-Cookie', `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`)
}

export function clearBrowserSessionCookie(c: Context, name: string): void {
  c.header('Set-Cookie', `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`)
}
