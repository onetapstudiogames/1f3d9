import { createHash, randomBytes } from 'node:crypto'
import { containsCredentialLikeInput } from './credential-safety.ts'
import {
  CITY_FEE_CREDIT_UNITS,
  formatUsdcUnits,
  parseCityCreditRequestId,
  type CityCreditDatabase,
} from './city-credit.ts'

const MAX_CREDIT_DOLLARS = 10_000n
const GIFT_TOKEN_RE = /^gift_claim_[0-9a-f]{64}$/u
const GIFT_PUBLIC_ID_RE = /^city_gift_[0-9a-f]{32}$/u
const PENDING_GIFT_PAGE_DEFAULT = 50
const PENDING_GIFT_PAGE_MAX = 50

type QueryRow = Record<string, unknown>
export class PrepaidCreditConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrepaidCreditConflictError'
  }
}

function positiveResidentId(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1
    || value > 2_147_483_647
  ) throw new TypeError('credit resident id must be a positive integer')
  return value
}

function giftId(value: unknown): string {
  const text = String(value ?? '')
  if (!GIFT_PUBLIC_ID_RE.test(text)) throw new TypeError('gift id is invalid')
  return text
}

function exactCreditUnits(value: unknown): bigint {
  const text = typeof value === 'bigint' ? value.toString() : String(value ?? '')
  if (!/^[1-9][0-9]*$/u.test(text)) {
    throw new TypeError('credit amount must be exact positive whole dollars')
  }
  const units = BigInt(text)
  if (
    units < CITY_FEE_CREDIT_UNITS
    || units > MAX_CREDIT_DOLLARS * CITY_FEE_CREDIT_UNITS
    || units % CITY_FEE_CREDIT_UNITS !== 0n
  ) throw new TypeError('credit amount must be exact positive whole dollars from 1 to 10000')
  return units
}

function resultStatus(value: unknown): 'pending' | 'accepted' | 'refused' | 'frozen' | 'revoked' {
  if (!['pending', 'accepted', 'refused', 'frozen', 'revoked'].includes(String(value))) {
    throw new TypeError('gift status is invalid')
  }
  return value as ReturnType<typeof resultStatus>
}

function disputeBlockedGift(
  status: 'frozen' | 'revoked',
  action: 'accepted' | 'refused' | 'redirected',
): never {
  if (status === 'frozen') {
    throw new PrepaidCreditConflictError(
      `This gift cannot be ${action} because a payment dispute is open on the purchase that funded it, or PayPal resolved it ambiguously and founder review is pending.`,
    )
  }
  throw new PrepaidCreditConflictError(
    `This gift cannot be ${action} because either PayPal resolved the funding dispute against the city seller, or founder resident #1 chose buyer favour after PayPal returned an ambiguous outcome. The gift was permanently revoked and can never add credit.`,
  )
}

function rowId(value: unknown, label: string): string {
  const text = String(value ?? '')
  if (!/^[1-9][0-9]{0,18}$/u.test(text) || BigInt(text) > 9_223_372_036_854_775_807n) {
    throw new TypeError(`${label} is invalid`)
  }
  return text
}

export function parseCreditDollars(value: unknown): bigint {
  let whole: string
  if (typeof value === 'string') {
    if (!/^[1-9][0-9]{0,4}$/u.test(value)) {
      throw new TypeError('credit amount must be positive exact whole dollars')
    }
    whole = value
  } else if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    whole = String(value)
  } else {
    throw new TypeError('credit amount must be positive exact whole dollars')
  }
  const dollars = BigInt(whole)
  if (dollars > MAX_CREDIT_DOLLARS) {
    throw new TypeError('credit amount must be exact whole dollars from 1 to 10000')
  }
  return dollars * CITY_FEE_CREDIT_UNITS
}

export function parseGiftClaimToken(value: unknown): string {
  if (
    typeof value !== 'string'
    || !GIFT_TOKEN_RE.test(value)
    || containsCredentialLikeInput(value)
  ) throw new TypeError('gift claim token is invalid')
  return value
}

export function parsePendingGiftCursor(value: string | null | undefined): string | null {
  if (value == null || value === '') return null
  return rowId(value, 'before_gift_id')
}

export function parsePendingGiftLimit(value: string | number | null | undefined): number {
  if (value == null || value === '') return PENDING_GIFT_PAGE_DEFAULT
  const text = typeof value === 'number' ? String(value) : value
  if (!/^[1-9][0-9]*$/u.test(text)) {
    throw new TypeError(`gift_limit must be an integer from 1 to ${PENDING_GIFT_PAGE_MAX}`)
  }
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed) || parsed > PENDING_GIFT_PAGE_MAX) {
    throw new TypeError(`gift_limit must be an integer from 1 to ${PENDING_GIFT_PAGE_MAX}`)
  }
  return parsed
}

export function createGiftClaimToken(): string {
  return `gift_claim_${cryptoRandomHex()}`
}

function cryptoRandomHex(): string {
  return randomBytes(32).toString('hex')
}

export function hashGiftClaimToken(value: unknown): string {
  return createHash('sha256').update(parseGiftClaimToken(value), 'utf8').digest('hex')
}

async function giftAction(
  database: CityCreditDatabase,
  input: Readonly<{ residentId: number; giftId: string }>,
  action: 'accept' | 'refuse',
) {
  const residentId = positiveResidentId(input.residentId)
  const id = giftId(input.giftId)
  const terminalStatus = action === 'accept' ? 'accepted' : 'refused'
  const entryKind = action === 'accept' ? 'gift_accept' : 'gift_refuse'
  const timestampColumn = action === 'accept' ? 'accepted_at' : 'refused_at'
  const changeableStatus = action === 'accept'
    ? `prior.status = 'pending' AND prior.frozen_at IS NULL`
    : `prior.status IN ('pending', 'frozen')`
  const replayableStatus = action === 'accept'
    ? `prior.status = $3::text AND prior.frozen_at IS NULL`
    : `prior.status = $3::text`
  const blockedStatus = action === 'accept'
    ? `(prior.status IN ('frozen', 'revoked') OR prior.frozen_at IS NOT NULL)`
    : `prior.status = 'revoked'`
  const rows = await database.query(`
    /* prepaid-credit:gift-${action} */
    WITH prior AS MATERIALIZED (
      SELECT gift.* FROM city_credit_gifts gift
      WHERE gift.public_id = $1::text AND gift.recipient_id = $2::integer
      FOR UPDATE
    ), changed AS MATERIALIZED (
      UPDATE city_credit_gifts gift
      SET status = $3::text,
        ${timestampColumn} = clock_timestamp(),
        updated_at = clock_timestamp()
      FROM prior
      WHERE gift.id = prior.id AND ${changeableStatus}
      RETURNING gift.*
    ), receipt AS MATERIALIZED (
      INSERT INTO city_credit_entries (
        resident_id, entry_kind, amount_units, source_key, gift_id
      )
      SELECT changed.recipient_id, $4::text, changed.amount_units,
        'gift:' || changed.public_id || ':${action}:' || changed.version::text, changed.id
      FROM changed
      ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO NOTHING
      RETURNING id
    ), selected AS (
      SELECT gift.* FROM changed gift
      UNION ALL
      SELECT prior.* FROM prior
      WHERE ${replayableStatus}
        AND NOT EXISTS (SELECT 1 FROM changed)
      UNION ALL
      SELECT prior.* FROM prior
      WHERE ${blockedStatus}
        AND NOT EXISTS (SELECT 1 FROM changed)
      LIMIT 1
    )
    SELECT selected.public_id AS gift_id, selected.status,
      selected.amount_units::text AS amount_units, selected.frozen_at
    FROM selected
  `, [id, residentId, terminalStatus, entryKind]) as readonly QueryRow[]
  const row = rows[0]
  if (!row) throw new PrepaidCreditConflictError(`gift is not pending for this recipient or was not found`)
  const storedStatus = resultStatus(row.status)
  if (storedStatus === 'revoked'
    || (action === 'accept' && (storedStatus === 'frozen' || row.frozen_at != null))) {
    disputeBlockedGift(
      storedStatus === 'revoked' ? 'revoked' : 'frozen',
      action === 'accept' ? 'accepted' : 'refused',
    )
  }
  return Object.freeze({
    gift_id: giftId(row.gift_id),
    status: storedStatus,
    amount_units: exactCreditUnits(row.amount_units).toString(),
  })
}

export async function acceptCreditGift(
  database: CityCreditDatabase,
  input: Readonly<{ residentId: number; giftId: string }>,
) {
  return await giftAction(database, input, 'accept')
}

export async function refuseCreditGift(
  database: CityCreditDatabase,
  input: Readonly<{ residentId: number; giftId: string }>,
) {
  return await giftAction(database, input, 'refuse')
}

export async function redirectCreditGift(
  database: CityCreditDatabase,
  input: Readonly<{
    giftId: string
    claimToken: string
    residentId: number
    requestId: string
  }>,
) {
  const id = giftId(input.giftId)
  const targetResidentId = positiveResidentId(input.residentId)
  const claimHash = hashGiftClaimToken(input.claimToken)
  const requestId = parseCityCreditRequestId(input.requestId)
  if (!requestId) throw new TypeError('gift redirect request id is required')
  const rows = await database.query(`
    /* prepaid-credit:gift-redirect */
    WITH prior AS MATERIALIZED (
      SELECT gift.*
      FROM city_credit_gifts gift
      WHERE gift.public_id = $1::text AND gift.claim_token_hash = $2::text
      FOR UPDATE
    ), existing_redirect AS MATERIALIZED (
      SELECT receipt.gift_id, receipt.counterparty_id
      FROM city_credit_entries receipt
      JOIN prior ON prior.id = receipt.gift_id
      WHERE receipt.entry_kind = 'gift_redirect' AND receipt.request_id = $4::text
    ), replay AS MATERIALIZED (
      SELECT prior.* FROM prior
      JOIN existing_redirect ON existing_redirect.gift_id = prior.id
      WHERE existing_redirect.counterparty_id = $3::integer
        AND prior.recipient_id = $3::integer
        AND prior.status = 'pending'
        AND prior.frozen_at IS NULL
    ), changed AS MATERIALIZED (
      UPDATE city_credit_gifts gift
      SET recipient_id = $3::integer, status = 'pending',
        version = prior.version + 1,
        accepted_at = NULL, refused_at = NULL, updated_at = clock_timestamp()
      FROM prior
      WHERE gift.id = prior.id
        AND prior.status IN ('pending', 'refused')
        AND prior.frozen_at IS NULL
        AND prior.recipient_id <> $3::integer
        AND NOT EXISTS (SELECT 1 FROM existing_redirect)
        AND EXISTS (SELECT 1 FROM residents WHERE id = $3::integer)
      RETURNING gift.*, prior.recipient_id AS previous_recipient_id
    ), departure AS MATERIALIZED (
      INSERT INTO city_credit_entries (
        resident_id, entry_kind, amount_units, source_key, gift_id, counterparty_id,
        request_id
      )
      SELECT changed.previous_recipient_id, 'gift_redirect', changed.amount_units,
        'gift:' || changed.public_id || ':redirect:' || changed.version::text,
        changed.id, changed.recipient_id, $4::text
      FROM changed
      RETURNING id
    ), arrival AS MATERIALIZED (
      INSERT INTO city_credit_entries (
        resident_id, entry_kind, amount_units, source_key, gift_id
      )
      SELECT changed.recipient_id, 'gift_pending', changed.amount_units,
        'gift:' || changed.public_id || ':pending:' || changed.version::text, changed.id
      FROM changed
      RETURNING id
    ), selected AS (
      SELECT changed.public_id, changed.status, changed.amount_units,
        changed.frozen_at FROM changed
      UNION ALL
      SELECT replay.public_id, 'pending'::text AS status, replay.amount_units,
        replay.frozen_at FROM replay
      UNION ALL
      SELECT prior.public_id, prior.status, prior.amount_units, prior.frozen_at FROM prior
      WHERE (prior.status IN ('frozen', 'revoked') OR prior.frozen_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM changed)
        AND NOT EXISTS (SELECT 1 FROM replay)
      LIMIT 1
    )
    SELECT public_id AS gift_id, status, amount_units::text AS amount_units,
      frozen_at FROM selected
  `, [id, claimHash, targetResidentId, requestId]) as readonly QueryRow[]
  const row = rows[0]
  if (!row) {
    throw new PrepaidCreditConflictError('gift redirect claim or recipient changed, or the gift is no longer redirectable')
  }
  const storedStatus = resultStatus(row.status)
  if (storedStatus === 'revoked' || storedStatus === 'frozen' || row.frozen_at != null) {
    disputeBlockedGift(storedStatus === 'revoked' ? 'revoked' : 'frozen', 'redirected')
  }
  return Object.freeze({
    gift_id: giftId(row.gift_id),
    status: storedStatus,
    amount_units: exactCreditUnits(row.amount_units).toString(),
  })
}

export async function readPendingCreditGifts(
  database: CityCreditDatabase,
  residentIdInput: number,
  options: Readonly<{ beforeId?: string | null; limit?: number }> = {},
) {
  const residentId = positiveResidentId(residentIdInput)
  const beforeId = parsePendingGiftCursor(options.beforeId)
  const limit = parsePendingGiftLimit(options.limit)
  const rows = await database.query(`
    /* prepaid-credit:read-pending-gifts */
    SELECT gift.id::text AS row_id, gift.public_id AS gift_id,
      gift.amount_units::text AS amount_units,
      gift.status, gift.created_at
    FROM city_credit_gifts gift
    WHERE gift.recipient_id = $1::integer AND gift.status IN ('pending', 'frozen')
      AND ($2::bigint IS NULL OR gift.id < $2::bigint)
    ORDER BY gift.id DESC
    LIMIT $3::integer
  `, [residentId, beforeId, limit + 1]) as readonly QueryRow[]
  const hasMore = rows.length > limit
  const visible = rows.slice(0, limit)
  const items = visible.map(row => {
    const units = exactCreditUnits(row.amount_units)
    const publicId = giftId(row.gift_id)
    const status = resultStatus(row.status)
    return Object.freeze({
      gift_id: publicId,
      status,
      amount: formatUsdcUnits(units),
      amount_units: units.toString(),
      source: 'purchase' as const,
      buyer: 'private' as const,
      created_at: String(row.created_at),
      ...(status === 'frozen'
        ? {
            blocked_reason: 'A payment dispute is open on the purchase that funded this gift, or PayPal resolved it ambiguously and founder review is pending. It cannot be accepted or redirected while frozen; the recipient may still refuse it.',
            next_actions: Object.freeze({
              refuse: `POST /api/city-credit/gifts/${publicId}/refuse`,
            }),
          }
        : {
            next_actions: Object.freeze({
              accept: `POST /api/city-credit/gifts/${publicId}/accept`,
              refuse: `POST /api/city-credit/gifts/${publicId}/refuse`,
            }),
          }),
    })
  })
  return Object.freeze({
    items: Object.freeze(items),
    page: Object.freeze({
      has_more: hasMore,
      next_before_gift_id: hasMore
        ? rowId(visible.at(-1)?.row_id, 'pending gift page cursor')
        : null,
    }),
  })
}
