import assert from 'node:assert/strict'
import type { Pool } from 'pg'

export const CREDIT_UNITS = '1000000'

export function postgresCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : null
}

export async function rejectsWithCode(promise: Promise<unknown>, expected: string): Promise<void> {
  await assert.rejects(promise, error => postgresCode(error) === expected)
}

export async function issueCredit(
  database: Pool,
  residentId: number,
  sourceKey: string,
  founderId = 1,
  amountUnits = CREDIT_UNITS,
): Promise<string> {
  const issued = await database.query<{ id: string }>(`
    INSERT INTO city_credit_entries (
      resident_id, entry_kind, amount_units, founder_id, source_key, reason
    ) VALUES ($1, 'founder_issue', $2, $3, $4, 'PostgreSQL integration-test issuance')
    RETURNING id::text
  `, [residentId, amountUnits, founderId, sourceKey])
  return issued.rows[0]!.id
}

export async function insertCreditAttempt(
  database: Pool,
  publicId: string,
  residentId: number,
  operation: 'frontier' | 'kind_invention' | 'kind_revision',
  targetKey: string,
  leaseOwner = `credit-lease-${publicId}`,
): Promise<void> {
  await database.query(`
    INSERT INTO payment_attempts (
      public_id, actor_id, operation, target_key,
      request_hash, request_json, method, amount_units, asset_type, asset_id,
      status, lease_owner, lease_expires_at
    ) VALUES (
      $1, $2, $3, $4,
      repeat('a', 64), jsonb_build_object('target', $4::text), 'credit', $5,
      CASE WHEN $3 = 'kind_revision' THEN 'kind' END,
      CASE WHEN $3 = 'kind_revision' THEN 3 END,
      'settling', $6, clock_timestamp() + interval '1 minute'
    )
  `, [publicId, residentId, operation, targetKey, CREDIT_UNITS, leaseOwner])
}

export async function spendCredit(
  database: Pool,
  residentId: number,
  attemptId: string,
  requestId: string,
  amountUnits = CREDIT_UNITS,
): Promise<string> {
  const spent = await database.query<{ id: string }>(`
    INSERT INTO city_credit_entries (
      resident_id, entry_kind, amount_units, payment_attempt_id, request_id
    ) VALUES ($1, 'spend', $2, $3, $4)
    RETURNING id::text
  `, [residentId, amountUnits, attemptId, requestId])
  return spent.rows[0]!.id
}

export async function accountAndLedger(database: Pool, residentId: number): Promise<{
  balance_units: string
  ledger_units: string
}> {
  const result = await database.query<{
    balance_units: string
    ledger_units: string
  }>(`
    SELECT account.balance_units::text,
      COALESCE(sum(CASE
        WHEN entry.entry_kind IN ('founder_issue', 'return', 'admin_credit')
          THEN entry.amount_units
        ELSE -entry.amount_units
      END), 0)::text AS ledger_units
    FROM city_credit_accounts AS account
    LEFT JOIN city_credit_entries AS entry
      ON entry.resident_id = account.resident_id
    WHERE account.resident_id = $1
    GROUP BY account.resident_id, account.balance_units
  `, [residentId])
  assert.ok(result.rows[0], `resident ${residentId} must have a credit account`)
  return result.rows[0]
}
