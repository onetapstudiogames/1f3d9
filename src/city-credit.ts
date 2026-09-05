import { randomUUID } from 'node:crypto'
import { containsCredentialLikeInput } from './credential-safety.ts'
import { canonicalPaymentRequest } from './payment-attempts.ts'
import { isoTimestamp } from './timestamp.ts'
import {
  CITY_FEE_CREDIT_UNITS,
  CITY_FEE_CREDIT_USDC,
  CityCreditConflictError,
  returnCityCreditSpend,
  returnExpiredCityCreditSpend,
} from './city-credit-recovery.ts'

export {
  CITY_FEE_CREDIT_UNITS,
  CITY_FEE_CREDIT_USDC,
  CityCreditConflictError,
  returnCityCreditSpend,
  returnExpiredCityCreditSpend,
}
export const CITY_CREDIT_HISTORY_DEFAULT = 20
export const CITY_CREDIT_HISTORY_MAX = 50
if (CITY_FEE_CREDIT_UNITS !== 1_000_000n) throw new Error('city fee credit unit invariant changed')

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u
const SAFE_REASON_RE = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+$/u
const MAX_BIGINT_ID = 9_223_372_036_854_775_807n
const LEASE_MILLISECONDS = 30_000

export type CityFeeCreditOperation =
  | 'frontier'
  | 'kind_invention'
  | 'kind_revision'
  | 'place_rename'
  | 'place_retire'
  | 'place_restore'
export type CityCreditEntryKind =
  | 'founder_issue'
  | 'purchase'
  | 'gift_pending'
  | 'gift_accept'
  | 'gift_refuse'
  | 'gift_redirect'
  | 'spend'
  | 'return'
  | 'admin_credit'
  | 'admin_debit'
  | 'paypal_dispute_created'
  | 'paypal_dispute_updated'
  | 'paypal_dispute_resolved'
  | 'paypal_dispute_reviewed'
export type CityCreditPurchaseKind = 'paypal' | 'allowance' | 'x402'
export type CityCreditReceiptOperation = CityFeeCreditOperation | 'credit_purchase'

type QueryRow = Record<string, unknown>

export interface CityCreditDatabase {
  query(text: string, params?: readonly unknown[] | any[]): Promise<readonly QueryRow[]>
}

export interface CityCreditHistoryEntry {
  id: string
  kind: CityCreditEntryKind
  amount: string
  amount_units: string
  credit_amount: string
  credit_amount_units: string
  source_key: string | null
  purchase_kind: CityCreditPurchaseKind | null
  gift_id: string | null
  request_id: string | null
  operation: CityCreditReceiptOperation | null
  target_key: string | null
  related_spend_id: string | null
  reason: string | null
  created_at: string
}

export interface CityCreditAccount {
  resident_id: number
  balance: string
  balance_usdc: string
  balance_units: string
  history: CityCreditHistoryEntry[]
  page: {
    has_more: boolean
    next_before_credit_id: string | null
  }
}

export type CityCreditAttentionState = Readonly<{
  pending_gifts_count: number
  frozen_gifts_count: number
  credit_change: Readonly<{
    amount: string
    amount_units: string
    changed_at: string
  }> | null
}>

function runQuery(
  database: CityCreditDatabase,
  text: string,
  params: readonly unknown[],
): Promise<readonly QueryRow[]> {
  return database.query(text, [...params])
}

function positiveResidentId(value: unknown, label = 'resident id'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new TypeError(`${label} must be a positive integer`)
  }
  return value
}

function parseIdentifier(value: unknown, label: string, maximumBytes: number): string {
  if (
    typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') < 8
    || Buffer.byteLength(value, 'utf8') > maximumBytes
    || !IDENTIFIER_RE.test(value)
    || containsCredentialLikeInput(value)
  ) {
    throw new TypeError(`${label} must be a non-secret ASCII identifier of 8 to ${maximumBytes} bytes`)
  }
  return value
}

export function parseCityCreditRequestId(value: unknown): string | null {
  if (value == null) return null
  return parseIdentifier(value, 'city credit request id', 128)
}

export function parseCityCreditSourceKey(value: unknown): string {
  return parseIdentifier(value, 'city credit source key', 300)
}

export function parseCityCreditHistoryCursor(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(value)) {
    throw new TypeError('before_credit_id must be a positive bigint identifier')
  }
  const parsed = BigInt(value)
  if (parsed > MAX_BIGINT_ID) throw new TypeError('before_credit_id must be a positive bigint identifier')
  return value
}

export function parseCityCreditHistoryLimit(value: unknown): number {
  if (value == null) return CITY_CREDIT_HISTORY_DEFAULT
  const parsed = typeof value === 'string' && /^[0-9]+$/u.test(value) ? Number(value) : value
  if (
    typeof parsed !== 'number'
    || !Number.isSafeInteger(parsed)
    || parsed < 1
    || parsed > CITY_CREDIT_HISTORY_MAX
  ) throw new TypeError(`credit_limit must be an integer from 1 to ${CITY_CREDIT_HISTORY_MAX}`)
  return parsed
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

function safeTargetKey(value: unknown): string {
  if (
    typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') < 1
    || Buffer.byteLength(value, 'utf8') > 240
    || /[\u0000-\u001f\u007f]/u.test(value)
    || containsCredentialLikeInput(value)
  ) throw new TypeError('city credit target key must be 1 to 240 safe non-secret bytes')
  return value
}

function eligibleOperation(value: unknown): CityFeeCreditOperation {
  if (![
    'frontier', 'kind_invention', 'kind_revision',
    'place_rename', 'place_retire', 'place_restore',
  ].includes(String(value))) {
    throw new TypeError('operation is not eligible for city fee credit; use frontier, kind_invention, kind_revision, place_rename, place_retire, or place_restore')
  }
  return value as CityFeeCreditOperation
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

function booleanValue(value: unknown): boolean {
  return value === true || value === 't'
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`${label} is not a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function optionalJsonObject(value: unknown, label: string): Record<string, unknown> | null {
  return value == null ? null : jsonObject(value, label)
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const candidate = error as { code?: unknown; sourceError?: unknown }
  if (typeof candidate.code === 'string') return candidate.code
  return candidate.sourceError === error ? null : errorCode(candidate.sourceError)
}

export function formatUsdcUnits(units: bigint): string {
  if (typeof units !== 'bigint') throw new TypeError('USDC integer units must be a bigint')
  const negative = units < 0n
  const absolute = negative ? -units : units
  const whole = absolute / CITY_FEE_CREDIT_UNITS
  const fraction = (absolute % CITY_FEE_CREDIT_UNITS).toString().padStart(6, '0')
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`
}

export async function issueCityFeeCredit(
  database: CityCreditDatabase,
  input: {
    founderId: number
    residentId: number
    sourceKey: string
    reason: string
  },
) {
  if (input.founderId !== 1) throw new TypeError('only founder resident 1 may issue city fee credit')
  const residentId = positiveResidentId(input.residentId)
  const sourceKey = parseCityCreditSourceKey(input.sourceKey)
  const reason = safeReason(input.reason)
  const rows = await runQuery(database, `
    /* city-credit:issue */
    WITH inserted AS MATERIALIZED (
      INSERT INTO city_credit_entries (
        resident_id, entry_kind, amount_units, founder_id, source_key, reason
      )
      SELECT $2::integer, 'founder_issue', $5::bigint, $1::integer, $3::text, $4::text
      WHERE EXISTS (SELECT 1 FROM residents WHERE id = $2::integer)
      ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO NOTHING
      RETURNING *, true AS created
    ), selected AS MATERIALIZED (
      SELECT * FROM inserted
      UNION ALL
      SELECT existing.*, false AS created
      FROM city_credit_entries existing
      WHERE existing.source_key = $3::text AND NOT EXISTS (SELECT 1 FROM inserted)
      LIMIT 1
    )
    SELECT * FROM selected
  `, [input.founderId, residentId, sourceKey, reason, CITY_FEE_CREDIT_UNITS.toString()])
  let row = rows[0]
  if (!row) {
    // ON CONFLICT may wait for a concurrent source-key winner that the current
    // statement snapshot cannot read. Re-open only that immutable source fact.
    const replayRows = await runQuery(database, `
      /* city-credit:issue-replay */
      SELECT entry.*, entry.id AS entry_id, false AS created
      FROM city_credit_entries entry
      WHERE entry.source_key = $1::text
      LIMIT 1
    `, [sourceKey])
    row = replayRows[0]
  }
  if (!row) throw new CityCreditConflictError('resident was not found or city credit issuance conflicted; re-read GET /api/residents and retry with a current resident and the original source terms')
  if (
    String(row.entry_kind) !== 'founder_issue'
    || integerValue(row.resident_id, 'credit resident') !== residentId
    || integerValue(row.founder_id, 'credit founder') !== 1
    || bigintString(row.amount_units, 'credit amount') !== CITY_FEE_CREDIT_UNITS.toString()
    || String(row.source_key) !== sourceKey
    || String(row.reason) !== reason
  ) throw new CityCreditConflictError('city credit source key is already bound to different resident or reason terms; retry with the original terms or use a new source key')

  // The balance projection is maintained by an AFTER INSERT trigger. PostgreSQL
  // intentionally does not expose that trigger write to the outer query in the
  // same statement, so read it in a fresh statement after issuance commits.
  const balanceRows = await runQuery(database, `
    /* city-credit:issue-balance */
    SELECT balance_units::text AS balance_units
    FROM city_credit_accounts
    WHERE resident_id = $1::integer
  `, [residentId])
  const balanceRow = balanceRows[0]
  if (!balanceRow) throw new CityCreditConflictError('city credit balance projection was not created because the balance record is missing; retry once, then contact the city operator')

  const amountUnits = bigintString(row.amount_units, 'credit amount')
  const balanceUnits = bigintString(balanceRow.balance_units, 'credit balance')
  return {
    disposition: booleanValue(row.created) ? 'created' as const : 'existing' as const,
    entry_id: idString(row.entry_id ?? row.id, 'credit entry id'),
    resident_id: residentId,
    amount: formatUsdcUnits(BigInt(amountUnits)),
    amount_units: amountUnits,
    balance: formatUsdcUnits(BigInt(balanceUnits)),
    balance_usdc: formatUsdcUnits(BigInt(balanceUnits)),
    balance_units: balanceUnits,
    reason,
    created_at: isoTimestamp(row.created_at) ?? '',
  }
}

interface BeginCityCreditSpendInput {
  actorId: number
  operation: CityFeeCreditOperation
  targetKey: string
  request: Record<string, unknown>
  requestId: string
  assetType?: 'place' | 'thing' | 'kind' | null
  assetId?: number | null
}

function normalizeCreditAsset(
  operation: CityFeeCreditOperation,
  assetType: BeginCityCreditSpendInput['assetType'],
  assetId: BeginCityCreditSpendInput['assetId'],
): { assetType: 'place' | 'kind' | null; assetId: number | null } {
  if (operation === 'kind_revision') {
    if (
      assetType !== 'kind'
      || typeof assetId !== 'number'
      || !Number.isSafeInteger(assetId)
      || assetId < 1
    ) throw new TypeError('kind revision city credit must bind one positive kind asset id')
    return { assetType: 'kind', assetId }
  }
  if (operation === 'place_rename' || operation === 'place_retire' || operation === 'place_restore') {
    if (
      assetType !== 'place'
      || typeof assetId !== 'number'
      || !Number.isSafeInteger(assetId)
      || assetId < 1
    ) throw new TypeError('place lifecycle city credit must bind one positive place asset id')
    return { assetType: 'place', assetId }
  }
  if (assetType != null || assetId != null) {
    throw new TypeError('this city credit operation cannot bind an asset')
  }
  return { assetType: null, assetId: null }
}

function newPublicId(prefix: 'credit_attempt' | 'credit_lease'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

function verifySpendTerms(
  row: QueryRow,
  input: BeginCityCreditSpendInput,
  requestId: string,
  request: { hash: string; json: string },
): void {
  const storedRequest = typeof row.request_json === 'string'
    ? JSON.parse(row.request_json) as unknown
    : row.request_json
  const storedAssetType = row.asset_type == null ? null : String(row.asset_type)
  const storedAssetId = row.asset_id == null ? null : integerValue(row.asset_id, 'credit asset id')
  if (
    integerValue(row.actor_id, 'credit actor') !== input.actorId
    || String(row.operation) !== input.operation
    || String(row.target_key) !== input.targetKey
    || String(row.request_id) !== requestId
    || String(row.request_hash) !== request.hash
    || canonicalPaymentRequest(storedRequest).json !== request.json
    || bigintString(row.amount_units, 'credit amount') !== CITY_FEE_CREDIT_UNITS.toString()
    || storedAssetType !== (input.assetType ?? null)
    || storedAssetId !== (input.assetId ?? null)
    || (row.method != null && String(row.method) !== 'credit')
  ) throw new CityCreditConflictError('city credit request conflicts with changed immutable credit terms; use the original terms with this request id, or use a new request id')
}

async function executeBeginSpend(
  database: CityCreditDatabase,
  input: BeginCityCreditSpendInput,
  requestId: string,
  request: { hash: string; json: string },
): Promise<readonly QueryRow[]> {
  const attemptId = newPublicId('credit_attempt')
  const leaseOwner = newPublicId('credit_lease')
  return runQuery(database, `
    /* city-credit:begin-spend */
    WITH recovery_clock AS MATERIALIZED (
      SELECT clock_timestamp() AS checked_at
    ), request_candidate AS MATERIALIZED (
      SELECT attempt.public_id, spend.id AS spend_entry_id, 1 AS priority
      FROM city_credit_entries spend
      JOIN payment_attempts attempt ON attempt.public_id = spend.payment_attempt_id
      WHERE spend.entry_kind = 'spend'
        AND spend.resident_id = $1::integer AND spend.request_id = $4::text
      LIMIT 1
    ), target_candidate AS MATERIALIZED (
      SELECT attempt.public_id, spend.id AS spend_entry_id, 2 AS priority
      FROM payment_attempts attempt
      LEFT JOIN city_credit_entries spend
        ON spend.payment_attempt_id = attempt.public_id AND spend.entry_kind = 'spend'
      WHERE attempt.operation = $2::text AND attempt.target_key = $3::text
        AND attempt.status IN ('settling', 'payment_pending', 'needs_review', 'completed')
        AND NOT EXISTS (SELECT 1 FROM request_candidate)
      ORDER BY attempt.created_at DESC, attempt.public_id DESC
      LIMIT 1
    ), new_attempt AS MATERIALIZED (
      INSERT INTO payment_attempts (
        public_id, actor_id, operation, target_key,
        request_hash, request_json, method, amount_units, asset_type, asset_id, status,
        lease_owner, lease_expires_at
      )
      SELECT $8::text, $1::integer, $2::text, $3::text,
        $5::text, $6::jsonb, 'credit', $7::bigint, $11::text, $12::bigint, 'payment_pending',
        $9::text, clock_timestamp() + ($10::bigint * interval '1 millisecond')
      WHERE NOT EXISTS (SELECT 1 FROM request_candidate)
        AND NOT EXISTS (SELECT 1 FROM target_candidate)
      ON CONFLICT DO NOTHING
      RETURNING *
    ), new_spend AS MATERIALIZED (
      INSERT INTO city_credit_entries (
        resident_id, entry_kind, amount_units, request_id, payment_attempt_id
      )
      SELECT $1::integer, 'spend', $7::bigint, $4::text, public_id
      FROM new_attempt
      RETURNING id AS spend_entry_id, payment_attempt_id AS public_id
    ), existing_candidate AS MATERIALIZED (
      SELECT public_id, spend_entry_id, priority FROM request_candidate
      UNION ALL SELECT public_id, spend_entry_id, priority FROM target_candidate
      ORDER BY priority
      LIMIT 1
    ), existing_leased AS MATERIALIZED (
      UPDATE payment_attempts attempt
      SET lease_owner = $9::text,
        lease_expires_at = clock_timestamp() + ($10::bigint * interval '1 millisecond'),
        updated_at = clock_timestamp()
      WHERE attempt.public_id = (SELECT public_id FROM existing_candidate)
        AND attempt.actor_id = $1::integer
        AND attempt.method = 'credit' AND attempt.status = 'payment_pending'
        AND attempt.recovery_deadline_at > (SELECT checked_at FROM recovery_clock)
        AND (
          attempt.lease_expires_at IS NULL
          OR attempt.lease_expires_at <= (SELECT checked_at FROM recovery_clock)
        )
      RETURNING attempt.public_id
    )
    SELECT CASE
        WHEN attempt.status = 'completed' THEN 'completed'
        WHEN attempt.status = 'credit_returned' THEN 'returned'
        WHEN existing_leased.public_id IS NOT NULL THEN 'ready'
        ELSE 'busy'
      END AS state,
      attempt.public_id AS attempt_id, attempt.actor_id, attempt.operation,
      attempt.target_key, attempt.method, attempt.asset_type, attempt.asset_id,
      spend.request_id, attempt.request_hash,
      attempt.request_json, attempt.amount_units::text AS amount_units,
      spend.id::text AS spend_entry_id, returned.id::text AS return_entry_id,
      attempt.response_status, attempt.response_json,
      CASE WHEN attempt.response_body_bytes IS NULL THEN NULL
        ELSE convert_from(attempt.response_body_bytes, 'UTF8') END AS response_body,
      (existing_leased.public_id IS NOT NULL) AS lease_acquired,
      CASE WHEN existing_leased.public_id IS NOT NULL THEN $9::text ELSE NULL END AS lease_owner,
      attempt.status IN ('settling', 'payment_pending')
        AND attempt.recovery_deadline_at <= (SELECT checked_at FROM recovery_clock) AS recovery_due
    FROM existing_candidate
    JOIN payment_attempts attempt ON attempt.public_id = existing_candidate.public_id
    LEFT JOIN city_credit_entries spend
      ON spend.id = existing_candidate.spend_entry_id AND spend.entry_kind = 'spend'
    LEFT JOIN city_credit_entries returned
      ON returned.related_spend_id = spend.id AND returned.entry_kind = 'return'
    LEFT JOIN existing_leased ON existing_leased.public_id = attempt.public_id
    UNION ALL
    SELECT 'ready'::text AS state,
      attempt.public_id AS attempt_id, attempt.actor_id, attempt.operation,
      attempt.target_key, attempt.method, attempt.asset_type, attempt.asset_id,
      $4::text AS request_id,
      attempt.request_hash, attempt.request_json,
      attempt.amount_units::text AS amount_units,
      spend.spend_entry_id::text, NULL::text AS return_entry_id,
      NULL::smallint AS response_status, NULL::jsonb AS response_json,
      NULL::text AS response_body, true AS lease_acquired,
      attempt.lease_owner, false AS recovery_due
    FROM new_attempt attempt
    JOIN new_spend spend ON spend.public_id = attempt.public_id
  `, [
    input.actorId,
    input.operation,
    input.targetKey,
    requestId,
    request.hash,
    request.json,
    CITY_FEE_CREDIT_UNITS.toString(),
    attemptId,
    leaseOwner,
    LEASE_MILLISECONDS,
    input.assetType ?? null,
    input.assetId ?? null,
  ])
}

export async function beginCityCreditSpend(
  database: CityCreditDatabase,
  input: BeginCityCreditSpendInput,
) {
  positiveResidentId(input.actorId, 'credit actor id')
  const operation = eligibleOperation(input.operation)
  const targetKey = safeTargetKey(input.targetKey)
  const requestId = parseCityCreditRequestId(input.requestId)
  if (!requestId) throw new TypeError('city credit request id is required')
  const request = canonicalPaymentRequest(input.request)
  const asset = normalizeCreditAsset(operation, input.assetType, input.assetId)
  const normalized = { ...input, operation, targetKey, ...asset }

  let rows: readonly QueryRow[]
  try {
    rows = await executeBeginSpend(database, normalized, requestId, request)
  } catch (error) {
    if (errorCode(error) !== '23505') throw error
    rows = await executeBeginSpend(database, normalized, requestId, request)
  }
  // ON CONFLICT can observe a concurrent winner that this statement's snapshot
  // cannot read. One fresh statement makes that winner visible for exact replay.
  if (rows.length === 0) {
    rows = await executeBeginSpend(database, normalized, requestId, request)
  }
  let row = rows[0]
  if (!row) throw new CityCreditConflictError('city credit request or target changed; retry the same request id')
  if (booleanValue(row.recovery_due)) {
    const deadlineReturn = await returnExpiredCityCreditSpend(database, {
      actorId: integerValue(row.actor_id, 'credit actor'),
      attemptId: String(row.attempt_id),
      ...(row.lease_owner == null ? {} : { leaseOwner: String(row.lease_owner) }),
    })
    if (deadlineReturn.state === 'busy') {
      throw new CityCreditConflictError('city credit deadline return is busy; retry the same request id')
    }
    if (deadlineReturn.state === 'not_due') {
      throw new CityCreditConflictError('city credit deadline return is not yet available; wait until the payment deadline, then retry the same request id')
    }
    rows = await executeBeginSpend(database, normalized, requestId, request)
    row = rows[0]
    if (!row) throw new CityCreditConflictError('city credit target changed after its deadline return; retry')
  }
  verifySpendTerms(row, normalized, requestId, request)
  const state = String(row.state)
  const attemptId = String(row.attempt_id)
  if (!attemptId) throw new TypeError('city credit attempt is unavailable because its stored attempt id is missing; retry once, then contact the city operator')
  if (state === 'completed') {
    const response = optionalJsonObject(row.response_json, 'credit response')
    if (!response) throw new CityCreditConflictError('completed city credit response is unavailable because its stored response is missing; retry once, then contact the city operator')
    return {
      state: 'completed' as const,
      attempt_id: attemptId,
      response_status: integerValue(row.response_status, 'credit response status'),
      response,
      ...(row.response_body == null ? {} : { response_body: String(row.response_body) }),
    }
  }
  if (state === 'busy') return { state: 'busy' as const, attempt_id: attemptId }
  if (state === 'returned') {
    const response = optionalJsonObject(row.response_json, 'credit return response')
    if (!response || row.return_entry_id == null) {
      throw new CityCreditConflictError('returned city credit response is unavailable because its stored response is missing; retry once, then contact the city operator')
    }
    return {
      state: 'returned' as const,
      attempt_id: attemptId,
      return_entry_id: idString(row.return_entry_id, 'credit return entry id'),
      response_status: integerValue(row.response_status, 'credit response status'),
      response,
      ...(row.response_body == null ? {} : { response_body: String(row.response_body) }),
    }
  }
  if (state !== 'ready' || !booleanValue(row.lease_acquired) || !row.lease_owner) {
    throw new CityCreditConflictError('city credit spend is not ready for this request; retry the same request id after its current lease clears')
  }
  return {
    state: 'ready' as const,
    attempt_id: attemptId,
    spend_entry_id: idString(row.spend_entry_id, 'credit spend entry id'),
    lease_owner: String(row.lease_owner),
    amount: CITY_FEE_CREDIT_USDC,
    amount_units: CITY_FEE_CREDIT_UNITS.toString(),
  }
}

export async function completeCityCreditAttempt(
  database: CityCreditDatabase,
  input: {
    actorId: number
    attemptId: string
    leaseOwner: string
    result: Record<string, unknown>
    responseStatus: number
    response: Record<string, unknown>
    responseBody?: string
  },
) {
  const actorId = positiveResidentId(input.actorId, 'credit actor id')
  const responseBody = input.responseBody ?? JSON.stringify(input.response)
  const rows = await runQuery(database, `
    /* city-credit:complete-attempt */
    SELECT completed.*
    FROM payment_attempts owned
    CROSS JOIN LATERAL complete_city_credit_attempt(
      owned.public_id, $3::text, $4::jsonb, $5::smallint, $6::jsonb, decode($7::text, 'base64')
    ) completed
    WHERE owned.public_id = $2::text AND owned.actor_id = $1::integer
      AND owned.method = 'credit' AND owned.lease_owner = $3::text
  `, [
    actorId,
    input.attemptId,
    input.leaseOwner,
    JSON.stringify(input.result),
    input.responseStatus,
    JSON.stringify(input.response),
    Buffer.from(responseBody, 'utf8').toString('base64'),
  ])
  const row = rows[0]
  if (!row || String(row.status) !== 'completed' || integerValue(row.actor_id, 'credit actor') !== actorId) {
    throw new CityCreditConflictError('city credit completion no longer owns this exact spend; retry the same request id without paying again')
  }
  return row
}

function historyArray(value: unknown): QueryRow[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
  if (!Array.isArray(parsed)) throw new TypeError('city credit history is unavailable')
  return parsed.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError('city credit history entry is invalid')
    }
    return item as QueryRow
  })
}

function mapHistoryEntry(row: QueryRow): CityCreditHistoryEntry {
  const kind = String(row.entry_kind ?? row.kind) as CityCreditEntryKind
  if (![
    'founder_issue', 'purchase', 'gift_pending', 'gift_accept', 'gift_refuse',
    'gift_redirect', 'spend', 'return', 'admin_credit', 'admin_debit',
    'paypal_dispute_created', 'paypal_dispute_updated', 'paypal_dispute_resolved',
    'paypal_dispute_reviewed',
  ].includes(kind)) {
    throw new TypeError('city credit history kind is invalid')
  }
  const unsignedUnits = BigInt(bigintString(row.amount_units, 'city credit history amount'))
  const giftPublicId = row.gift_public_id == null ? null : String(row.gift_public_id)
  if (giftPublicId != null && !/^city_gift_[0-9a-f]{32}$/u.test(giftPublicId)) {
    throw new TypeError('city credit gift receipt id is invalid')
  }
  const zeroBalanceEvent = ['gift_pending', 'gift_refuse', 'gift_redirect'].includes(kind)
    || [
      'paypal_dispute_created', 'paypal_dispute_updated',
      'paypal_dispute_resolved', 'paypal_dispute_reviewed',
    ]
      .includes(kind)
    || (kind === 'purchase' && giftPublicId != null)
  const signedUnits = zeroBalanceEvent
    ? 0n
    : ['spend', 'admin_debit'].includes(kind) ? -unsignedUnits : unsignedUnits
  const purchaseKind = row.purchase_kind == null ? null : String(row.purchase_kind)
  if (purchaseKind != null && !['paypal', 'allowance', 'x402'].includes(purchaseKind)) {
    throw new TypeError('city credit purchase receipt kind is invalid')
  }
  const operation = row.operation == null
    ? null
    : row.operation === 'credit_purchase' ? 'credit_purchase' as const : eligibleOperation(row.operation)
  const privateFundingEvent = [
    'purchase', 'gift_pending', 'gift_accept', 'gift_refuse', 'gift_redirect',
    'paypal_dispute_created', 'paypal_dispute_updated', 'paypal_dispute_resolved',
    'paypal_dispute_reviewed',
  ].includes(kind)
  const sourceKey = privateFundingEvent
    ? null
    : row.source_key == null ? null : String(row.source_key)
  return {
    id: idString(row.id, 'city credit history id'),
    kind,
    amount: formatUsdcUnits(signedUnits),
    amount_units: signedUnits.toString(),
    credit_amount: formatUsdcUnits(unsignedUnits),
    credit_amount_units: unsignedUnits.toString(),
    source_key: sourceKey,
    purchase_kind: purchaseKind as CityCreditPurchaseKind | null,
    gift_id: giftPublicId,
    // Gift and funding dedupe identifiers originate outside the recipient's account.
    // Hiding them prevents a purchaser from smuggling identifying text into /api/me.
    request_id: privateFundingEvent || row.request_id == null ? null : String(row.request_id),
    operation,
    target_key: row.target_key == null ? null : String(row.target_key),
    related_spend_id: row.related_spend_id == null
      ? null
      : idString(row.related_spend_id, 'related city credit spend id'),
    reason: row.reason == null ? null : String(row.reason),
    created_at: isoTimestamp(row.created_at) ?? '',
  }
}

export async function readCityCreditAccount(
  database: CityCreditDatabase,
  residentIdInput: number,
  options?: { beforeId?: string | null; limit?: number },
): Promise<CityCreditAccount> {
  const residentId = positiveResidentId(residentIdInput)
  const beforeId = parseCityCreditHistoryCursor(options?.beforeId ?? null)
  const limit = parseCityCreditHistoryLimit(options?.limit)
  const paged = options !== undefined
  const params: readonly unknown[] = paged
    ? [residentId, beforeId, limit, limit + 1]
    : [residentId]
  const beforeExpression = paged ? '$2::bigint' : 'NULL::bigint'
  const limitExpression = paged ? '$4::integer' : `${CITY_CREDIT_HISTORY_DEFAULT + 1}::integer`
  const visibleLimitExpression = paged ? '$3::integer' : `${CITY_CREDIT_HISTORY_DEFAULT}::integer`
  const rows = await runQuery(database, `
    /* city-credit:read-account */
    WITH fetched AS MATERIALIZED (
      SELECT entry.id::text AS id, entry.entry_kind, entry.amount_units::text AS amount_units,
        entry.source_key, entry.purchase_kind, gift.public_id AS gift_public_id,
        entry.request_id, attempt.operation, attempt.target_key,
        entry.related_spend_id::text AS related_spend_id, entry.reason, entry.created_at,
        row_number() OVER (ORDER BY entry.id DESC) AS position
      FROM city_credit_entries entry
      LEFT JOIN payment_attempts attempt ON attempt.public_id = entry.payment_attempt_id
      LEFT JOIN city_credit_gifts gift ON gift.id = entry.gift_id
      WHERE entry.resident_id = $1::integer
        AND (${beforeExpression} IS NULL OR entry.id < ${beforeExpression})
      ORDER BY entry.id DESC
      LIMIT ${limitExpression}
    ), visible AS (
      SELECT * FROM fetched WHERE position <= ${visibleLimitExpression}
    )
    SELECT $1::integer AS resident_id,
      coalesce(account.balance_units, 0)::text AS balance_units,
      coalesce((
        SELECT jsonb_agg(to_jsonb(visible) - 'position' ORDER BY position)
        FROM visible
      ), '[]'::jsonb) AS history,
      (SELECT count(*) > ${visibleLimitExpression} FROM fetched) AS has_more
    FROM (SELECT 1) singleton
    LEFT JOIN city_credit_accounts account ON account.resident_id = $1::integer
  `, params)
  const row = rows[0]
  if (!row || integerValue(row.resident_id, 'credit resident') !== residentId) {
    throw new TypeError('city credit account is unavailable')
  }
  const balanceUnits = bigintString(row.balance_units, 'city credit balance')
  if (BigInt(balanceUnits) < 0n) throw new TypeError('city credit balance is invalid')
  const history = historyArray(row.history).map(mapHistoryEntry)
  const hasMore = booleanValue(row.has_more)
  const nextBefore = hasMore && history.length > 0 ? history.at(-1)!.id : null
  const balance = formatUsdcUnits(BigInt(balanceUnits))
  return {
    resident_id: residentId,
    balance,
    balance_usdc: balance,
    balance_units: balanceUnits,
    history,
    page: { has_more: hasMore, next_before_credit_id: nextBefore },
  }
}

export async function readCityCreditAttention(
  database: CityCreditDatabase,
  residentIdInput: number,
): Promise<CityCreditAttentionState> {
  const residentId = positiveResidentId(residentIdInput)
  // Ledger IDs are allocation-, not commit-ordered; closing the rare late-lower-ID window requires a per-resident cursor allocated under the account lock.
  const rows = await runQuery(database, `
    /* city-credit:read-attention */
    WITH cutoff AS MATERIALIZED (
      SELECT coalesce(max(entry.id), 0)::bigint AS entry_id
      FROM city_credit_entries entry
      WHERE entry.resident_id = $1::integer
    ), advanced AS MATERIALIZED (
      INSERT INTO city_credit_last_me_reads (
        resident_id, previous_credit_entry_id, last_credit_entry_id, read_at
      )
      SELECT $1::integer, NULL, cutoff.entry_id, clock_timestamp()
      FROM cutoff
      ON CONFLICT (resident_id) DO UPDATE
      SET previous_credit_entry_id = city_credit_last_me_reads.last_credit_entry_id,
        last_credit_entry_id = greatest(
          city_credit_last_me_reads.last_credit_entry_id,
          excluded.last_credit_entry_id
        ),
        read_at = excluded.read_at
      RETURNING previous_credit_entry_id, last_credit_entry_id
    ), balance_changes AS MATERIALIZED (
      SELECT count(*)::integer AS change_count,
        coalesce(sum(CASE
          WHEN entry.entry_kind IN ('founder_issue', 'return', 'admin_credit', 'gift_accept')
            THEN entry.amount_units
          WHEN entry.entry_kind = 'purchase' AND entry.gift_id IS NULL
            THEN entry.amount_units
          WHEN entry.entry_kind IN ('spend', 'admin_debit')
            THEN -entry.amount_units
          ELSE 0
        END), 0)::text AS change_units,
        max(entry.created_at) AS changed_at
      FROM city_credit_entries entry
      CROSS JOIN advanced
      WHERE advanced.previous_credit_entry_id IS NOT NULL
        AND entry.resident_id = $1::integer
        AND entry.id > advanced.previous_credit_entry_id
        AND entry.id <= advanced.last_credit_entry_id
        AND (
          entry.entry_kind IN (
            'founder_issue', 'return', 'admin_credit', 'gift_accept',
            'spend', 'admin_debit'
          )
          OR (entry.entry_kind = 'purchase' AND entry.gift_id IS NULL)
        )
    ), gift_counts AS MATERIALIZED (
      SELECT count(*) FILTER (
          WHERE gift.status IN ('pending', 'frozen')
        )::integer AS pending_count,
        count(*) FILTER (WHERE gift.status = 'frozen')::integer AS frozen_count
      FROM city_credit_gifts gift
      WHERE gift.recipient_id = $1::integer
        AND gift.status IN ('pending', 'frozen')
    )
    SELECT advanced.previous_credit_entry_id IS NOT NULL AS had_previous_read,
      CASE WHEN balance_changes.change_count > 0 THEN balance_changes.change_units END AS change_units,
      CASE WHEN balance_changes.change_count > 0 THEN balance_changes.changed_at END AS changed_at,
      gift_counts.pending_count,
      gift_counts.frozen_count
    FROM advanced
    CROSS JOIN balance_changes
    CROSS JOIN gift_counts
  `, [residentId])
  const row = rows[0]
  if (!row) throw new TypeError('city credit attention is unavailable')
  const pendingCount = integerValue(row.pending_count, 'pending city credit gift count')
  if (pendingCount < 0) throw new TypeError('city credit gift count is invalid')
  const frozenCount = integerValue(row.frozen_count, 'frozen city credit gift count')
  if (frozenCount < 0 || frozenCount > pendingCount) {
    throw new TypeError('frozen city credit gift count is invalid')
  }
  const hadPreviousRead = booleanValue(row.had_previous_read)
  if (!hadPreviousRead || row.change_units == null) {
    return Object.freeze({
      pending_gifts_count: pendingCount,
      frozen_gifts_count: frozenCount,
      credit_change: null,
    })
  }
  const changeUnits = bigintString(row.change_units, 'city credit attention change')
  const changed = row.changed_at instanceof Date
    ? row.changed_at
    : new Date(String(row.changed_at ?? ''))
  if (Number.isNaN(changed.getTime())) throw new TypeError('city credit attention time is invalid')
  return Object.freeze({
    pending_gifts_count: pendingCount,
    frozen_gifts_count: frozenCount,
    credit_change: Object.freeze({
      amount: formatUsdcUnits(BigInt(changeUnits)),
      amount_units: changeUnits,
      changed_at: changed.toISOString(),
    }),
  })
}

export function cityCreditAttentionLines(state: CityCreditAttentionState): string[] {
  const lines: string[] = []
  const ordinaryGiftCount = state.pending_gifts_count - state.frozen_gifts_count
  if (ordinaryGiftCount > 0) {
    const gifts = ordinaryGiftCount === 1 ? 'gift' : 'gifts'
    lines.push(
      `You have ${ordinaryGiftCount} pending 1F3D9 fee-credit ${gifts} awaiting accept or refuse; see city_fee_credit.pending_gifts.`,
    )
  }
  if (state.frozen_gifts_count > 0) {
    const gifts = state.frozen_gifts_count === 1 ? 'gift' : 'gifts'
    lines.push(
      `You have ${state.frozen_gifts_count} dispute-frozen 1F3D9 fee-credit ${gifts} awaiting refuse; see city_fee_credit.pending_gifts.`,
    )
  }
  if (state.credit_change) {
    lines.push(
      `Your 1F3D9 fee-credit balance changed by ${state.credit_change.amount} since your previous me read; the latest change was on ${state.credit_change.changed_at}.`,
    )
  }
  return lines
}

export async function readCityCreditPreflight(
  database: CityCreditDatabase,
  residentIdInput: number,
) {
  const residentId = positiveResidentId(residentIdInput)
  const rows = await runQuery(database, `
    /* city-credit:preflight */
    SELECT coalesce(account.balance_units, 0)::text AS balance_units,
      (SELECT count(*)::text FROM city_credit_gifts gift
        WHERE gift.recipient_id = resident.id
          AND gift.status IN ('pending', 'frozen')) AS pending_gifts_count,
      statement_timestamp() AS observed_at
    FROM residents resident
    LEFT JOIN city_credit_accounts account ON account.resident_id = resident.id
    WHERE resident.id = $1::integer
  `, [residentId])
  const row = rows[0]
  if (!row) throw new TypeError('city credit preflight resident is unavailable')
  const balanceBefore = BigInt(bigintString(row.balance_units, 'city credit preflight balance'))
  if (balanceBefore < 0n) throw new TypeError('city credit preflight balance is invalid')
  const canConfirm = balanceBefore >= CITY_FEE_CREDIT_UNITS
  const pendingGiftsCount = integerValue(row.pending_gifts_count, 'pending city credit gift count')
  if (pendingGiftsCount < 0) throw new TypeError('pending city credit gift count is invalid')
  const balanceAfter = canConfirm ? balanceBefore - CITY_FEE_CREDIT_UNITS : null
  const observed = row.observed_at instanceof Date
    ? row.observed_at
    : new Date(String(row.observed_at ?? ''))
  if (Number.isNaN(observed.getTime())) throw new TypeError('city credit preflight time is invalid')
  return Object.freeze({
    resident_id: residentId,
    fee_cost: formatUsdcUnits(CITY_FEE_CREDIT_UNITS),
    fee_cost_units: CITY_FEE_CREDIT_UNITS.toString(),
    balance_before: formatUsdcUnits(balanceBefore),
    balance_before_units: balanceBefore.toString(),
    balance_after: balanceAfter === null ? null : formatUsdcUnits(balanceAfter),
    balance_after_units: balanceAfter === null ? null : balanceAfter.toString(),
    pending_gifts_count: pendingGiftsCount,
    can_confirm: canConfirm,
    observed_at: observed.toISOString(),
    applies_to: Object.freeze([
      'frontier', 'kind_invention', 'kind_revision',
      'place_rename', 'place_retire', 'place_restore',
    ] as const),
    freshness: 'read_only_snapshot' as const,
  })
}
