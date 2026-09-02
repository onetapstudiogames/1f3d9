// Decision row 74: POST /api/pair mints a short-lived, single-use pairing
// code for an already-authenticated coding client. A human enters that code
// on the hosted OAuth sign-in page (POST /oauth/authorize action "pair", see
// oauth.ts) instead of typing the resident key, linking the connector grant
// to this same resident without the key ever entering that browser page or
// the chat it configures.
import { randomBytes } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { RESIDENT_AUTH_REFUSAL, sha256 } from './core.ts'
import { jsonError, withIdentityApiStorageErrors } from './identity-api.ts'
import { type OAuthAttemptKind, postgresOAuthStore } from './oauth-store.ts'

export const PAIRING_CODE_PREFIX = '1f3d9_pc_'
export const PAIRING_CODE_RE = /^1f3d9_pc_[0-9a-f]{64}$/u

/**
 * The path this module mounts its one-time-reveal pairing-code door at.
 * Exported so public-output.ts's response-safety middleware derives its
 * delivery allow-list from this same constant instead of a second literal
 * that could drift -- see identity-api.ts's IDENTITY_JSON_DOOR_PATHS for the
 * matching register/rotate/recovery paths.
 */
export const PAIR_DOOR_PATH = '/api/pair'

const PAIR_MINTS_PER_RESIDENT_PER_HOUR = 20
const MAX_PAIR_JSON_BYTES = 4_096

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

/**
 * This door carries no fields of its own -- the credential is the caller's
 * Authorization: Bearer header, never the body. A caller may still omit the
 * body entirely (the door's original, still-supported contract), but a body
 * that is present must parse as exactly `{}`.
 */
async function rejectNonEmptyBody(c: Context): Promise<Response | null> {
  const raw = await c.req.text()
  if (raw.length === 0) return null
  if (Buffer.byteLength(raw, 'utf8') > MAX_PAIR_JSON_BYTES) {
    return jsonError(
      c, 400, 'unexpected_form_fields',
      `pairing bodies are limited to ${MAX_PAIR_JSON_BYTES} bytes`,
      'Retry with no body, or with exactly {}.',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return jsonError(
      c, 400, 'unexpected_form_fields',
      'POST /api/pair takes an empty body, or {}',
      'Retry with no body, or with exactly {}.',
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length > 0) {
    return jsonError(
      c, 400, 'unexpected_form_fields',
      'POST /api/pair takes an empty body, or {}',
      'Retry with no body, or with exactly {}.',
    )
  }
  return null
}

/** Mount decision-74's pairing-code mint door. */
export function mountPairRoutes(app: Hono, options: PairRouteOptions): void {
  const store = options.store ?? postgresOAuthStore

  app.post(PAIR_DOOR_PATH, c => withIdentityApiStorageErrors(c, async () => {
    privateHeaders(c)
    if (Object.keys(c.req.queries()).length > 0) {
      return jsonError(
        c, 400, 'unexpected_form_fields',
        'pairing-code minting accepts no query options',
        'Retry POST /api/pair with no query string.',
      )
    }
    const resident = await options.authenticate(c)
    if (!resident) {
      return jsonError(
        c, 401, 'resident_key_rejected',
        RESIDENT_AUTH_REFUSAL,
        'Send your saved current resident key as Authorization: Bearer <key>, then retry.',
      )
    }
    const bodyError = await rejectNonEmptyBody(c)
    if (bodyError) return bodyError
    const admission = await store.consumeOAuthRateLimit({
      bucketHash: sha256(`pair_mint:resident:${resident.id}`),
      attemptKind: 'pair_mint' satisfies OAuthAttemptKind,
      maximum: PAIR_MINTS_PER_RESIDENT_PER_HOUR,
    })
    if (!admission.admitted) {
      c.header('Retry-After', String(admission.retryAfterSeconds))
      return jsonError(
        c, 429, 'rate_limited',
        `too many pairing codes minted; you may mint ${PAIR_MINTS_PER_RESIDENT_PER_HOUR} per resident per UTC hour`,
        `Wait ${admission.retryAfterSeconds} seconds, then retry POST /api/pair.`,
      )
    }
    const pairingCode = newPairingCode()
    const minted = await store.mintPairingCode({ residentId: resident.id, codeHash: sha256(pairingCode) })
    return c.json({
      status: 'minted',
      pairing_code: pairingCode,
      expires_at: minted.expiresAt,
      next_step: 'This code is shown once, expires in ten minutes, and works once. Give it to the human completing hosted-chat sign-in; they enter it on the sign-in page in place of the resident key. It never reveals the key.',
    }, 200)
  }))
}

/**
 * Decision row 74 security fix: mounted instead of mountPairRoutes when
 * hosted-chat sign-in is configured but CODING_IDENTITY_DOORS_ENABLED is not
 * -- see identity-api.ts's mountCodingIdentityDoorsDisabled for why this
 * separate flag exists. Answers the same documented 503 shape as every other
 * JSON identity door, never a generic 500, through the same jsonError path.
 */
export function mountPairDisabledRoute(app: Hono): void {
  app.post(PAIR_DOOR_PATH, c => {
    privateHeaders(c)
    return jsonError(
      c, 503, 'request_unavailable',
      'POST /api/pair is unavailable on this deployment because its capability is not enabled; ask the city operator to enable it',
      'Ask the city operator to enable this capability, or complete hosted-chat sign-in with the resident key directly if that page is enabled on this deployment.',
    )
  })
}
