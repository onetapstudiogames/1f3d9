// Decision row 74: POST /api/pair mints a short-lived, single-use pairing
// code for an already-authenticated coding client. A human enters that code
// on the hosted OAuth sign-in page (POST /oauth/authorize action "pair", see
// oauth.ts) instead of typing the resident key, linking the connector grant
// to this same resident without the key ever entering that browser page or
// the chat it configures.
import { randomBytes } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { RESIDENT_AUTH_REFUSAL, sha256 } from './core.ts'
import { type OAuthAttemptKind, postgresOAuthStore } from './oauth-store.ts'

export const PAIRING_CODE_PREFIX = '1f3d9_pc_'
export const PAIRING_CODE_RE = /^1f3d9_pc_[0-9a-f]{64}$/u

const PAIR_MINTS_PER_RESIDENT_PER_HOUR = 20

export interface PairAuthenticatedResident {
  id: number
}

type PairingStore = Pick<typeof postgresOAuthStore, 'mintPairingCode' | 'consumeOAuthRateLimit'>

export interface PairRouteOptions {
  authenticate(c: Context): Promise<PairAuthenticatedResident | null>
  store?: PairingStore
}

function newPairingCode(): string {
  return PAIRING_CODE_PREFIX + randomBytes(32).toString('hex')
}

function privateHeaders(c: Context): void {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
  c.header('Vary', 'Authorization')
}

/** Mount decision-74's pairing-code mint door. */
export function mountPairRoutes(app: Hono, options: PairRouteOptions): void {
  const store = options.store ?? postgresOAuthStore

  app.post('/api/pair', async c => {
    privateHeaders(c)
    if (Object.keys(c.req.queries()).length > 0) {
      return c.json({ error: 'pairing-code minting accepts no query options' }, 400)
    }
    const resident = await options.authenticate(c)
    if (!resident) return c.json({ error: RESIDENT_AUTH_REFUSAL }, 401)
    const raw = await c.req.text()
    if (raw.length > 0) {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw) as unknown
      } catch {
        return c.json({ error: 'POST /api/pair takes an empty body, or {}' }, 400)
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length > 0) {
        return c.json({ error: 'POST /api/pair takes an empty body, or {}' }, 400)
      }
    }
    const admission = await store.consumeOAuthRateLimit({
      bucketHash: sha256(`pair_mint:resident:${resident.id}`),
      attemptKind: 'pair_mint' satisfies OAuthAttemptKind,
      maximum: PAIR_MINTS_PER_RESIDENT_PER_HOUR,
    })
    if (!admission.admitted) {
      c.header('Retry-After', String(admission.retryAfterSeconds))
      return c.json({
        error: `too many pairing codes minted; you may mint ${PAIR_MINTS_PER_RESIDENT_PER_HOUR} per resident per UTC hour`,
        next_step: `Wait ${admission.retryAfterSeconds} seconds, then retry POST /api/pair.`,
      }, 429)
    }
    const pairingCode = newPairingCode()
    const minted = await store.mintPairingCode({ residentId: resident.id, codeHash: sha256(pairingCode) })
    return c.json({
      status: 'minted',
      pairing_code: pairingCode,
      expires_at: minted.expiresAt,
      next_step: 'This code is shown once, expires in ten minutes, and works once. Give it to the human completing hosted-chat sign-in; they enter it on the sign-in page in place of the resident key. It never reveals the key.',
    }, 200)
  })
}
