import { randomUUID } from 'node:crypto'
import { containsCredentialLikeInput } from './credential-safety.ts'
import { canonicalPaymentRequest } from './payment-attempts.ts'

export const CITY_FEE_CREDIT_UNITS = 1_000_000n
export const CITY_FEE_CREDIT_USDC = '1.000000'

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u
const SAFE_REASON_RE = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+$/u
const LEASE_MILLISECONDS = 30_000
const DEADLINE_RETURN_REASON = 'automatic recovery deadline reached'
const DEADLINE_RETURN_RESPONSE = Object.freeze({
  error: 'automatic recovery deadline reached; city fee credit returned',
  city_fee_credit: 'credit_returned',
  returned_usdc: CITY_FEE_CREDIT_USDC,
})

type QueryRow = Record<string, unknown>

export interface CityCreditRecoveryDatabase {
  query(text: string, params?: readonly unknown[] | any[]): Promise<readonly QueryRow[]>
}

export class CityCreditConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CityCreditConflictError'
  }
}

function runQuery(
  database: CityCreditRecoveryDatabase,
  text: string,
  params: readonly unknown[],
): Promise<readonly QueryRow[]> {
  return database.query(text, [...params])
}

function positiveResidentId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new TypeError('credit actor id must be a positive integer')
  }
  return value
}

function safeIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') < 8
    || Buffer.byteLength(value, 'utf8') > 160
    || !IDENTIFIER_RE.test(value)
    || containsCredentialLikeInput(value)
  ) throw new TypeError(`${label} must be a bounded non-secret ASCII identifier`)
  return value
}

function safeReason(value: unknown): string {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') < 1
    || Buffer.byteLength(value, 'utf8') > 240
    || !SAFE_REASON_RE.test(value)
    || containsCredentialLikeInput(value)
  ) throw new TypeError('city credit reason must be 1 to 240 safe non-secret bytes')
  return value
}

function bigintString(value: unknown, label: string): string {
  const text = typeof value === 'bigint' ? value.toString() : String(value ?? '')
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(text)) throw new TypeError(`${label} is not an integer`)
  return text
}

function idString(value: unknown, label: string): string {
  const text = bigintString(value, label)
  if (BigInt(text) < 1n) throw new TypeError(`${label} is not positive`)
  return text
}

function integerValue(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`${label} is not an integer`)
  return parsed
}

function optionalJsonObject(value: unknown, label: string): Record<string, unknown> | null {
  if (value == null) return null
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`${label} is not a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalPaymentRequest(left).json === canonicalPaymentRequest(right).json
  } catch {
    return false
  }
}

export async function returnCityCreditSpend(
  database: CityCreditRecoveryDatabase,
  input: {
    actorId: number
    attemptId: string
    leaseOwner: string
    reason: string
    responseStatus: number
    response: Record<string, unknown>
  },
) {
  const actorId = positiveResidentId(input.actorId)
  const reason = safeReason(input.reason)
  if (!Number.isSafeInteger(input.responseStatus) || input.responseStatus < 400 || input.responseStatus > 599) {
    throw new TypeError('city credit return response status must be an error status')
  }
  const responseBody = JSON.stringify(input.response)
  const rows = await runQuery(database, `
    /* city-credit:return-spend */
    WITH locked_attempt AS MATERIALIZED (
      SELECT owned.*
      FROM payment_attempts owned
      WHERE owned.public_id = $2::text AND owned.actor_id = $1::integer
        AND owned.method = 'credit' AND owned.amount_units = $8::bigint
      FOR UPDATE
    ), returned_attempt AS MATERIALIZED (
      SELECT returned.*
      FROM locked_attempt owned
      CROSS JOIN LATERAL return_city_credit_spend(
        owned.public_id, $3::text, $4::text, $5::smallint,
        $6::jsonb, decode($7::text, 'base64')
      ) returned
    )
    SELECT returned_attempt.*, locked_attempt.status AS prior_status
    FROM returned_attempt
    JOIN locked_attempt ON locked_attempt.public_id = returned_attempt.public_id
  `, [
    actorId,
    input.attemptId,
    input.leaseOwner,
    reason,
    input.responseStatus,
    responseBody,
    Buffer.from(responseBody, 'utf8').toString('base64'),
    CITY_FEE_CREDIT_UNITS.toString(),
  ])
  const returnedAttempt = rows[0]
  const returnedResponse = returnedAttempt
    ? optionalJsonObject(returnedAttempt.response_json, 'credit return response')
    : null
  if (
    !returnedAttempt
    || String(returnedAttempt.status) !== 'credit_returned'
    || integerValue(returnedAttempt.actor_id, 'credit actor') !== actorId
    || bigintString(returnedAttempt.amount_units, 'credit return amount') !== CITY_FEE_CREDIT_UNITS.toString()
    || !returnedResponse
    || !sameJson(returnedResponse, input.response)
    || integerValue(returnedAttempt.response_status, 'credit response status') !== input.responseStatus
  ) throw new CityCreditConflictError('matching exact city credit spend could not be returned')

  const resultRows = await runQuery(database, `
    /* city-credit:return-result */
    SELECT 'returned' AS state, attempt.public_id AS attempt_id,
      attempt.actor_id, attempt.operation, attempt.target_key,
      spend.request_id, attempt.request_hash, attempt.request_json,
      attempt.amount_units::text AS amount_units, spend.id::text AS spend_entry_id,
      returned_entry.id::text AS return_entry_id,
      attempt.response_status, attempt.response_json
    FROM payment_attempts attempt
    JOIN city_credit_entries spend
      ON spend.payment_attempt_id = attempt.public_id AND spend.entry_kind = 'spend'
    JOIN city_credit_entries returned_entry
      ON returned_entry.related_spend_id = spend.id AND returned_entry.entry_kind = 'return'
    WHERE attempt.public_id = $2::text AND attempt.actor_id = $1::integer
      AND attempt.method = 'credit' AND attempt.amount_units = $3::bigint
  `, [actorId, input.attemptId, CITY_FEE_CREDIT_UNITS.toString()])
  const row = resultRows[0]
  const response = row ? optionalJsonObject(row.response_json, 'credit return response') : null
  if (
    !row
    || String(row.state) !== 'returned'
    || integerValue(row.actor_id, 'credit actor') !== actorId
    || bigintString(row.amount_units, 'credit return amount') !== CITY_FEE_CREDIT_UNITS.toString()
    || row.return_entry_id == null
    || !response
    || !sameJson(response, input.response)
    || integerValue(row.response_status, 'credit response status') !== input.responseStatus
  ) throw new CityCreditConflictError('matching exact city credit spend could not be returned')

  return {
    disposition: String(returnedAttempt.prior_status) === 'credit_returned'
      ? 'existing' as const
      : 'created' as const,
    state: 'returned' as const,
    attempt_id: String(row.attempt_id),
    spend_entry_id: idString(row.spend_entry_id, 'credit spend entry id'),
    return_entry_id: idString(row.return_entry_id, 'credit return entry id'),
    amount: CITY_FEE_CREDIT_USDC,
    amount_units: CITY_FEE_CREDIT_UNITS.toString(),
    response_status: input.responseStatus,
    response,
  }
}

async function readExistingDeadlineReturn(
  database: CityCreditRecoveryDatabase,
  actorId: number,
  attemptId: string,
) {
  const row = (await runQuery(database, `
    /* city-credit:expired-return-result */
    SELECT attempt.public_id AS attempt_id, attempt.actor_id,
      attempt.amount_units::text AS amount_units,
      spend.id::text AS spend_entry_id, returned.id::text AS return_entry_id,
      attempt.response_status, attempt.response_json
    FROM payment_attempts attempt
    JOIN city_credit_entries spend
      ON spend.payment_attempt_id = attempt.public_id AND spend.entry_kind = 'spend'
    JOIN city_credit_entries returned
      ON returned.related_spend_id = spend.id AND returned.entry_kind = 'return'
    WHERE attempt.public_id = $2::text AND attempt.actor_id = $1::integer
      AND attempt.method = 'credit' AND attempt.status = 'credit_returned'
      AND attempt.amount_units = $3::bigint
      AND spend.amount_units = $3::bigint AND returned.amount_units = $3::bigint
    LIMIT 1
  `, [actorId, attemptId, CITY_FEE_CREDIT_UNITS.toString()]))[0]
  const response = row ? optionalJsonObject(row.response_json, 'credit return response') : null
  if (!row || row.return_entry_id == null || !response) {
    throw new CityCreditConflictError('matching exact city credit deadline return is unavailable')
  }
  return {
    disposition: 'existing' as const,
    state: 'credit_returned' as const,
    attempt_id: String(row.attempt_id),
    spend_entry_id: idString(row.spend_entry_id, 'credit spend entry id'),
    return_entry_id: idString(row.return_entry_id, 'credit return entry id'),
    amount: CITY_FEE_CREDIT_USDC,
    amount_units: CITY_FEE_CREDIT_UNITS.toString(),
    response_status: integerValue(row.response_status, 'credit response status'),
    response,
  }
}

export async function returnExpiredCityCreditSpend(
  database: CityCreditRecoveryDatabase,
  input: { actorId: number; attemptId: string; leaseOwner?: string },
) {
  const actorId = positiveResidentId(input.actorId)
  const attemptId = safeIdentifier(input.attemptId, 'credit attempt id')
  const leaseOwner = input.leaseOwner == null
    ? `credit_lease_${randomUUID().replaceAll('-', '')}`
    : safeIdentifier(input.leaseOwner, 'credit lease owner')
  const row = (await runQuery(database, `
    /* city-credit:claim-expired-spend */
    WITH candidate AS MATERIALIZED (
      SELECT attempt.public_id, attempt.actor_id, attempt.status,
        attempt.recovery_deadline_at
      FROM payment_attempts attempt
      WHERE attempt.public_id = $1::text AND attempt.actor_id = $2::integer
        AND attempt.method = 'credit'
      LIMIT 1
    ), claimed AS MATERIALIZED (
      UPDATE payment_attempts attempt
      SET lease_owner = $3::text,
        lease_expires_at = clock_timestamp() + ($4::bigint * interval '1 millisecond'),
        updated_at = clock_timestamp()
      FROM candidate
      WHERE attempt.public_id = candidate.public_id
        AND attempt.method = 'credit'
        AND attempt.status IN ('settling', 'payment_pending')
        AND attempt.recovery_deadline_at IS NOT NULL
        AND attempt.recovery_deadline_at <= clock_timestamp()
        AND (
          attempt.lease_owner = $3::text
          OR attempt.lease_expires_at IS NULL
          OR attempt.lease_expires_at <= clock_timestamp()
        )
      RETURNING attempt.public_id, attempt.actor_id, attempt.status,
        attempt.lease_owner, attempt.recovery_deadline_at
    )
    SELECT 'ready'::text AS state, claimed.* FROM claimed
    UNION ALL
    SELECT CASE
        WHEN candidate.status = 'credit_returned' THEN 'credit_returned'
        WHEN candidate.status IN ('settling', 'payment_pending')
          AND candidate.recovery_deadline_at > clock_timestamp() THEN 'not_due'
        WHEN candidate.status IN ('settling', 'payment_pending') THEN 'busy'
        ELSE 'unavailable'
      END AS state,
      candidate.public_id, candidate.actor_id, candidate.status,
      NULL::text AS lease_owner, candidate.recovery_deadline_at
    FROM candidate
    WHERE NOT EXISTS (SELECT 1 FROM claimed)
  `, [attemptId, actorId, leaseOwner, LEASE_MILLISECONDS]))[0]

  if (!row) return { state: 'unavailable' as const, attempt_id: attemptId }
  const state = String(row.state)
  if (state === 'credit_returned') {
    return readExistingDeadlineReturn(database, actorId, attemptId)
  }
  if (state === 'busy' || state === 'not_due' || state === 'unavailable') {
    return { state, attempt_id: attemptId } as const
  }
  if (state !== 'ready' || String(row.lease_owner) !== leaseOwner) {
    throw new CityCreditConflictError('expired city credit spend was not safely leased')
  }
  const returned = await returnCityCreditSpend(database, {
    actorId,
    attemptId,
    leaseOwner,
    reason: DEADLINE_RETURN_REASON,
    responseStatus: 409,
    response: { ...DEADLINE_RETURN_RESPONSE },
  })
  return { ...returned, state: 'credit_returned' as const }
}
