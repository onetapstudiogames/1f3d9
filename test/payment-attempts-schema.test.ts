import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { splitSqlStatements } from '../scripts/migrate.ts'

const schemaDdl = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8')
const migrationDdl = readFileSync(
  new URL('../db/migrations/20260816_payment_attempts.sql', import.meta.url),
  'utf8',
)

function createPaymentAttemptsStatement(ddl: string): string {
  const statement = splitSqlStatements(ddl).find(candidate =>
    /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+payment_attempts\b/iu.test(candidate),
  )
  assert.ok(statement, 'missing idempotent payment_attempts table')
  return statement.replace(/^\s*--.*$/gmu, '').replace(/\s+/gu, ' ').trim()
}

function worldPaymentValidationStatement(ddl: string): string {
  const statement = splitSqlStatements(ddl).find(candidate =>
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+validate_world_sale_payment\s*\(\s*\)/iu.test(candidate),
  )
  assert.ok(statement, 'missing world-sale payment validation function')
  return statement.replace(/^\s*--.*$/gmu, '').replace(/\s+/gu, ' ').trim()
}

function completionFunctionStatement(ddl: string): string {
  const statement = splitSqlStatements(ddl).find(candidate =>
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+complete_payment_attempt\s*\(/iu.test(candidate),
  )
  assert.ok(statement, 'missing atomic payment-attempt completion function')
  return statement.replace(/^\s*--.*$/gmu, '').replace(/\s+/gu, ' ').trim()
}

function offerHistoryFunctionStatement(ddl: string): string {
  const statement = splitSqlStatements(ddl).find(candidate =>
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+protect_transfer_offer_history\s*\(\s*\)/iu.test(candidate),
  )
  assert.ok(statement, 'missing transfer-offer history function')
  return statement.replace(/^\s*--.*$/gmu, '').replace(/\s+/gu, ' ').trim()
}

test('fresh installs and additive upgrades use the same payment-attempt row', () => {
  const fresh = createPaymentAttemptsStatement(schemaDdl)
  const upgrade = createPaymentAttemptsStatement(migrationDdl)

  assert.equal(upgrade, fresh)

  for (const column of [
    'public_id',
    'actor_id',
    'counterparty_id',
    'operation',
    'target_key',
    'offer_id',
    'asset_type',
    'asset_id',
    'request_hash',
    'request_json',
    'method',
    'network',
    'token',
    'payer_wallet',
    'payee_wallet',
    'amount_units',
    'x402_nonce',
    'x402_payload_digest',
    'x402_valid_after',
    'x402_valid_before',
    'start_block',
    'start_time',
    'end_time',
    'status',
    'lease_owner',
    'lease_expires_at',
    'tx_hash',
    'finalized_block_number',
    'finalized_block_hash',
    'finalized_block_time',
    'finalized_at',
    'invalid_reason',
    'result_json',
    'response_status',
    'response_json',
    'created_at',
    'updated_at',
    'completed_at',
  ]) {
    assert.match(fresh, new RegExp(`\\b${column}\\b`, 'iu'), `missing ${column}`)
  }
})

test('attempt identity and lifecycle are bounded without storing signed payment material', () => {
  const attempts = createPaymentAttemptsStatement(schemaDdl)

  assert.match(attempts, /public_id\s+TEXT\s+PRIMARY\s+KEY/iu)
  assert.match(
    attempts,
    /actor_id\s+INTEGER\s+NOT\s+NULL\s+REFERENCES\s+residents\s*\(id\)\s+ON\s+DELETE\s+RESTRICT/iu,
  )
  assert.match(
    attempts,
    /counterparty_id\s+INTEGER\s+REFERENCES\s+residents\s*\(id\)\s+ON\s+DELETE\s+RESTRICT/iu,
  )
  assert.match(
    attempts,
    /operation\s+TEXT\s+NOT\s+NULL[\s\S]*operation\s+IN\s*\(\s*'frontier'\s*,\s*'kind_invention'\s*,\s*'kind_revision'\s*,\s*'direct_sale'\s*,\s*'world_sale'\s*,\s*'legacy'\s*\)/iu,
  )
  assert.match(
    attempts,
    /status\s+TEXT\s+NOT\s+NULL[\s\S]*status\s+IN\s*\(\s*'settling'\s*,\s*'payment_pending'\s*,\s*'completed'\s*,\s*'invalid'\s*,\s*'expired'\s*,\s*'needs_review'\s*,\s*'legacy_completed'\s*\)/iu,
  )
  assert.match(attempts, /network\s+TEXT[\s\S]*network\s*=\s*'base'/iu)
  assert.match(
    attempts,
    /token\s+TEXT[\s\S]*token\s*=\s*'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'/iu,
  )
  assert.match(attempts, /amount_units\s+BIGINT[\s\S]*amount_units\s+BETWEEN\s+1\s+AND/iu)
  assert.match(attempts, /tx_hash\s+TEXT\s+UNIQUE/iu)
  assert.match(attempts, /payer_wallet[\s\S]*\^0x\[0-9a-f\]\{40\}\$/iu)
  assert.match(attempts, /tx_hash[\s\S]*\^0x\[0-9a-f\]\{64\}\$/iu)
  assert.match(
    attempts,
    /status\s+NOT\s+IN\s*\(\s*'settling'\s*,\s*'payment_pending'\s*,\s*'needs_review'\s*\)\s+OR\s+target_key\s+IS\s+NOT\s+NULL/iu,
  )
  assert.match(attempts, /end_time\s+IS\s+NULL[\s\S]*start_time\s+IS\s+NULL[\s\S]*end_time\s*>\s*start_time/iu)
  assert.doesNotMatch(attempts, /payment_header|signed_header|signature|raw_payment/iu)
})

test('terminal results and finality facts are complete, and immutable transitions are database-enforced', () => {
  const attempts = createPaymentAttemptsStatement(schemaDdl)

  assert.match(attempts, /finalized_block_time\s+TIMESTAMPTZ/iu)
  assert.match(
    attempts,
    /status\s*<>\s*'completed'\s+OR[\s\S]*tx_hash\s+IS\s+NOT\s+NULL[\s\S]*finalized_block_number\s+IS\s+NOT\s+NULL[\s\S]*finalized_block_hash\s+IS\s+NOT\s+NULL[\s\S]*finalized_block_time\s+IS\s+NOT\s+NULL[\s\S]*result_json\s+IS\s+NOT\s+NULL[\s\S]*response_json\s+IS\s+NOT\s+NULL/iu,
  )
  for (const ddl of [schemaDdl, migrationDdl]) {
    assert.match(ddl, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+protect_payment_attempt_history/iu)
    assert.match(ddl, /payment attempt terms are immutable/iu)
    assert.match(ddl, /CREATE\s+TRIGGER\s+payment_attempts_keep_history/iu)
  }
})

test('business writes can complete exactly one finalized attempt inside the same SQL statement', () => {
  const fresh = completionFunctionStatement(schemaDdl)
  const upgrade = completionFunctionStatement(migrationDdl)

  assert.equal(upgrade, fresh)
  assert.match(fresh, /RETURNS\s+payment_attempts/iu)
  assert.match(fresh, /UPDATE\s+payment_attempts/iu)
  assert.match(fresh, /status\s*=\s*'completed'/iu)
  assert.match(fresh, /WHERE\s+public_id\s*=\s*attempt_id/iu)
  assert.match(fresh, /lease_owner\s*=\s*expected_lease_owner/iu)
  assert.match(fresh, /status\s*=\s*'payment_pending'/iu)
  assert.match(fresh, /tx_hash\s+IS\s+NOT\s+NULL/iu)
  assert.match(fresh, /finalized_block_number\s+IS\s+NOT\s+NULL/iu)
  assert.match(fresh, /finalized_block_hash\s+IS\s+NOT\s+NULL/iu)
  assert.match(fresh, /finalized_block_time\s+IS\s+NOT\s+NULL/iu)
  assert.match(fresh, /finalized_at\s+IS\s+NOT\s+NULL/iu)
  assert.match(fresh, /IF\s+NOT\s+FOUND[\s\S]*RAISE\s+EXCEPTION/iu)
})

test('the global payment-use ledger is owned by one exact attempt and validates effects', () => {
  for (const ddl of [schemaDdl, migrationDdl]) {
    assert.match(ddl, /payment_attempt_id\s+TEXT/iu)
    assert.match(
      ddl,
      /FOREIGN\s+KEY\s*\(payment_attempt_id,\s*tx_hash\)[\s\S]*REFERENCES\s+payment_attempts\s*\(public_id,\s*tx_hash\)/iu,
    )
    assert.match(ddl, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+validate_payment_use_attempt/iu)
    assert.match(ddl, /payment use does not match its finalized attempt/iu)
    assert.match(ddl, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+validate_fee_payment_attempt/iu)
    assert.match(ddl, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+validate_sale_payment_attempt/iu)
  }
})

test('nonce identity and live target ownership are globally unique', () => {
  for (const ddl of [schemaDdl, migrationDdl]) {
    assert.match(
      ddl,
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+payment_attempts_x402_nonce[\s\S]*\(network,\s*token,\s*payer_wallet,\s*x402_nonce\)[\s\S]*x402_nonce\s+IS\s+NOT\s+NULL/iu,
    )
    assert.match(
      ddl,
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+payment_attempts_one_live_target[\s\S]*\(operation,\s*target_key\)[\s\S]*status\s+IN\s*\(\s*'settling'\s*,\s*'payment_pending'\s*,\s*'needs_review'\s*\)/iu,
    )
    assert.doesNotMatch(
      ddl,
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+payment_attempts_target\b/iu,
    )
  }
})

test('upgrade backfills only known legacy payment-use facts', () => {
  const backfill = splitSqlStatements(migrationDdl).find(statement =>
    /INSERT\s+INTO\s+payment_attempts/iu.test(statement)
      && /FROM\s+payment_uses/iu.test(statement),
  )
  assert.ok(backfill, 'missing payment_uses backfill')

  assert.match(backfill, /'legacy_completed'/iu)
  assert.match(backfill, /payment_uses\.actor_id/iu)
  assert.match(backfill, /payment_uses\.purpose/iu)
  assert.match(backfill, /payment_uses\.payer_wallet/iu)
  assert.match(backfill, /payment_uses\.payee_wallet/iu)
  assert.match(backfill, /payment_uses\.tx_hash/iu)
  assert.match(backfill, /payment_uses\.created_at/iu)
  assert.match(backfill, /transfer_offers\.seller_id/iu)
  assert.doesNotMatch(backfill, /sale_payments\.buyer_id/iu)
  assert.doesNotMatch(backfill, /COALESCE\s*\(\s*payment_uses\.(?:payer_wallet|payee_wallet|amount_usdc)/iu)
  assert.doesNotMatch(backfill, /ON\s+CONFLICT/iu)
  assert.match(backfill, /NOT\s+EXISTS[\s\S]*existing\.public_id/iu)
  assert.match(backfill, /existing\.tx_hash\s*=\s*payment_uses\.tx_hash/iu)
  assert.match(backfill, /existing\.status\s+IN\s*\(\s*'completed'\s*,\s*'legacy_completed'\s*\)/iu)
  for (const fact of ['actor_id', 'operation', 'payer_wallet', 'payee_wallet', 'amount_units']) {
    assert.match(backfill, new RegExp(`existing\\.${fact}\\b`, 'iu'), `missing exact ${fact} rerun match`)
  }
})

test('upgrade imports world pending and invalid evidence without hiding hash collisions', () => {
  const backfill = splitSqlStatements(migrationDdl).find(statement =>
    /INSERT\s+INTO\s+payment_attempts/iu.test(statement)
      && /transfer_offers\.pending_x402_tx_hash/iu.test(statement),
  )
  assert.ok(backfill, 'missing world x402 evidence backfill')

  assert.match(backfill, /x402_evidence_state\s+IN\s*\(\s*'pending'\s*,\s*'invalid'\s*\)/iu)
  assert.match(backfill, /pending_x402_tx_hash\s+IS\s+NOT\s+NULL/iu)
  assert.match(backfill, /CASE[\s\S]*'invalid'[\s\S]*'payment_pending'/iu)
  assert.match(backfill, /'world_sale'/iu)
  assert.match(backfill, /transfer_offers\.seller_id/iu)
  assert.match(
    backfill,
    /'legacy_world_'\s*\|\|[\s\S]*?,\s*transfer_offers\.buyer_id\s*,\s*transfer_offers\.seller_id\s*,\s*'world_sale'/iu,
  )
  assert.doesNotMatch(backfill, /ON\s+CONFLICT/iu)
  assert.match(backfill, /NOT\s+EXISTS[\s\S]*existing\.public_id/iu)
  assert.doesNotMatch(backfill, /existing\.tx_hash/iu)

  for (const ddl of [schemaDdl, migrationDdl]) {
    assert.match(ddl, /pending_payment_attempt_id\s+TEXT/iu)
    assert.match(
      ddl,
      /FOREIGN\s+KEY\s*\(pending_payment_attempt_id\)[\s\S]*REFERENCES\s+payment_attempts\s*\(public_id\)/iu,
    )
    assert.match(ddl, /pending_x402_tx_hash\s+IS\s+NULL[\s\S]*pending_payment_attempt_id\s+IS\s+NULL/iu)
  }
  assert.match(
    migrationDdl,
    /SET\s+pending_payment_attempt_id\s*=\s*'legacy_world_'\s*\|\|\s*substr\s*\(\s*pending_x402_tx_hash/iu,
  )
})

test('world-sale payment evidence normalizes fractional reservations to whole Base seconds', () => {
  const fresh = worldPaymentValidationStatement(schemaDdl)
  const upgrade = worldPaymentValidationStatement(migrationDdl)

  assert.equal(upgrade, fresh)
  assert.match(
    fresh,
    /NEW\.block_time\s*<\s*\(\s*date_trunc\s*\(\s*'second'\s*,\s*world_offer\.reserved_at\s*\)\s*\+\s*CASE\s+WHEN\s+world_offer\.reserved_at\s*>\s*date_trunc\s*\(\s*'second'\s*,\s*world_offer\.reserved_at\s*\)\s+THEN\s+interval\s*'1 second'\s+ELSE\s+interval\s*'0 seconds'\s+END\s*\)/iu,
  )
  assert.match(
    fresh,
    /NEW\.block_time\s*>=\s*date_trunc\s*\(\s*'second'\s*,\s*world_offer\.reserved_until\s*\)/iu,
  )
  assert.doesNotMatch(fresh, /NEW\.block_time\s*<\s*world_offer\.reserved_at/iu)
  assert.doesNotMatch(fresh, /NEW\.block_time\s*>=?\s*world_offer\.reserved_until/iu)
})

test('an issued world payment attempt can park after expiry and blocks rebinding or cancellation', () => {
  const fresh = offerHistoryFunctionStatement(schemaDdl)
  const upgrade = offerHistoryFunctionStatement(migrationDdl)
  assert.equal(upgrade, fresh)

  const parkingStart = fresh.indexOf('IF OLD.pending_x402_tx_hash IS NULL')
  const parkingEnd = fresh.indexOf('reservation_changed :=', parkingStart)
  assert.ok(parkingStart >= 0 && parkingEnd > parkingStart)
  const parking = fresh.slice(parkingStart, parkingEnd)
  assert.match(parking, /attempt\.public_id\s*=\s*NEW\.pending_payment_attempt_id/iu)
  assert.match(parking, /attempt\.status\s*=\s*'payment_pending'/iu)
  assert.match(parking, /attempt\.start_time\s*>=/iu)
  assert.match(parking, /attempt\.end_time\s*<=/iu)
  assert.doesNotMatch(
    parking,
    /OLD\.(?:reserved_at|reserved_until)\s*[<>]=?\s*clock_timestamp\s*\(\s*\)/iu,
  )

  assert.match(fresh, /a live payment attempt keeps its transfer reservation/iu)
  assert.match(
    fresh,
    /NEW\.status\s*=\s*'canceled'[\s\S]*attempt\.status\s+IN\s*\(\s*'settling'\s*,\s*'payment_pending'\s*,\s*'needs_review'\s*\)/iu,
  )
})
