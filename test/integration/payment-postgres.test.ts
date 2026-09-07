import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { registerSchemaTests } from './payment-tests/schema.ts'
import { registerSaleRecoveryTests } from './payment-tests/sale-recovery.ts'
import { registerReplayRolloutTests } from './payment-tests/replay-rollout.ts'
import { registerCustodyConstraintsTests } from './payment-tests/custody-constraints.ts'
import { registerCompletionReplayTests } from './payment-tests/completion-replay.ts'
import { registerLegacyUpgradeTests } from './payment-tests/legacy-upgrade.ts'
import { registerWorldReceiptBoundaryTests } from './payment-tests/world-receipt-boundary.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'payment_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const migrationDdl = await readFile(
  new URL('../../db/migrations/20260816_payment_attempts.sql', import.meta.url),
  'utf8',
)
const replayMigrationDdl = await readFile(
  new URL('../../db/migrations/20260816_payment_response_replay.sql', import.meta.url),
  'utf8',
)
const responseBodyMigrationDdl = await readFile(
  new URL('../../db/migrations/20260817_payment_response_body_replay.sql', import.meta.url),
  'utf8',
)
const responseBodyRolloutMigrationDdl = await readFile(
  new URL('../../db/migrations/20260818_payment_response_body_rollout.sql', import.meta.url),
  'utf8',
)
const responseBodyValidationMigrationDdl = await readFile(
  new URL('../../db/migrations/20260818_payment_response_body_validate.sql', import.meta.url),
  'utf8',
)

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ client: Pool; containerName: string }> {
  const containerName = `1f3d9-payment-test-${process.pid}-${randomBytes(4).toString('hex')}`
  const password = randomBytes(24).toString('hex')
  runDocker([
    'run', '--detach', '--rm', '--name', containerName,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', `POSTGRES_DB=${POSTGRES_DATABASE}`,
    POSTGRES_IMAGE,
  ])

  try {
    const portOutput = runDocker(['port', containerName, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/)?.[1])
    assert.ok(Number.isInteger(port) && port > 0, `could not read PostgreSQL port from ${portOutput}`)
    const client = new Pool({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password,
      database: POSTGRES_DATABASE,
      ssl: false,
      max: 8,
    })
    const deadline = Date.now() + 30_000
    let lastError: unknown = null
    while (Date.now() < deadline) {
      try {
        await client.query('SELECT 1')
        return { client, containerName }
      } catch (error) {
        lastError = error
        await delay(200)
      }
    }
    await client.end().catch(() => undefined)
    throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
  } catch (error) {
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8' })
    throw error
  }
}

async function resetFresh(database: Pool): Promise<void> {
  await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await database.query(schemaDdl)
  await database.query(`
    INSERT INTO residents (id, handle, model, secret_hash) VALUES
      (1, 'seller', 'integration-test', repeat('1', 64)),
      (2, 'buyer', 'integration-test', repeat('2', 64)),
      (3, 'other', 'integration-test', repeat('3', 64))
  `)
}

async function resetLegacy(database: Pool): Promise<void> {
  await resetFresh(database)
  await database.query(`
    DROP TRIGGER IF EXISTS payment_uses_match_attempt ON payment_uses;
    DROP TRIGGER IF EXISTS fees_match_payment_attempt ON fees;
    DROP TRIGGER IF EXISTS sale_payments_match_attempt ON sale_payments;
    DROP TRIGGER IF EXISTS payment_attempts_keep_history ON payment_attempts;
    DROP TRIGGER IF EXISTS transfer_offers_keep_pending_attempt ON transfer_offers;
    DROP TRIGGER IF EXISTS payment_attempts_validate_response_body ON payment_attempts;
    DROP FUNCTION IF EXISTS complete_payment_attempt(TEXT, TEXT, JSONB, SMALLINT, JSONB, BYTEA);
    DROP FUNCTION IF EXISTS complete_payment_attempt(TEXT, TEXT, JSONB, SMALLINT, JSONB);
    DROP FUNCTION IF EXISTS validate_payment_response_body();
    DROP FUNCTION IF EXISTS protect_pending_payment_attempt_link();
    DROP FUNCTION IF EXISTS complete_city_credit_attempt(TEXT, TEXT, JSONB, SMALLINT, JSONB, BYTEA);
    DROP FUNCTION IF EXISTS return_city_credit_spend(TEXT, TEXT, TEXT, SMALLINT, JSONB, BYTEA);
    DROP TABLE IF EXISTS paypal_credit_events;
    DROP TABLE IF EXISTS paypal_credit_intents;
    DROP TABLE IF EXISTS paypal_credit_catalog;
    DROP TABLE IF EXISTS credit_purchase_rate_limits;
    ALTER TABLE city_credit_entries DROP CONSTRAINT IF EXISTS city_credit_entries_gift_id_fkey;
    DROP TABLE IF EXISTS city_credit_gifts;
    DROP TABLE IF EXISTS city_credit_entries;
    DROP TABLE IF EXISTS city_credit_accounts;
    DROP FUNCTION IF EXISTS validate_city_credit_entry();
    DROP FUNCTION IF EXISTS apply_city_credit_entry();
    DROP FUNCTION IF EXISTS protect_city_credit_account();
    DROP FUNCTION IF EXISTS protect_payment_attempt_history();
    ALTER TABLE payment_uses DROP CONSTRAINT IF EXISTS payment_uses_exact_attempt;
    ALTER TABLE transfer_offers DROP CONSTRAINT IF EXISTS transfer_offers_pending_attempt_owner;
    ALTER TABLE transfer_offers DROP CONSTRAINT IF EXISTS transfer_offers_pending_attempt_state;
    DROP INDEX IF EXISTS transfer_offers_pending_payment_attempt;
    ALTER TABLE transfer_offers DROP COLUMN IF EXISTS pending_payment_attempt_id;
    ALTER TABLE payment_uses DROP COLUMN IF EXISTS payment_attempt_id;
    DROP TABLE payment_attempts;
  `)
}

test('payment custody invariants hold in PostgreSQL', async t => {
  const postgres = await startPostgres()
  try {
    await registerSchemaTests(t, postgres, resetFresh)
    await registerSaleRecoveryTests(t, postgres, resetFresh)
    await registerReplayRolloutTests(
      t, postgres, resetFresh, responseBodyRolloutMigrationDdl, responseBodyValidationMigrationDdl,
    )
    await registerCustodyConstraintsTests(t, postgres, resetFresh)
    await registerCompletionReplayTests(t, postgres, resetFresh, replayMigrationDdl, responseBodyMigrationDdl)
    await registerLegacyUpgradeTests(t, postgres, resetLegacy, migrationDdl)
    await registerWorldReceiptBoundaryTests(t, postgres, resetFresh)
  } finally {
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
