import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { registerDeadlinesTests } from './payment-recovery-tests/deadlines.ts'
import { registerTargetLookupTests } from './payment-recovery-tests/target-lookup.ts'
import { registerFinalityTests } from './payment-recovery-tests/finality.ts'
import { registerExplicitRecheckTests } from './payment-recovery-tests/explicit-recheck.ts'
import { registerMigrationsTests } from './payment-recovery-tests/migrations.ts'
import { registerDirectSalesTests } from './payment-recovery-tests/direct-sales.ts'
import { registerBobRepairTests } from './payment-recovery-tests/bob-repair.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'payment_recovery_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const recoveryMigrationDdl = await readFile(
  new URL('../../db/migrations/20260822_payment_recovery.sql', import.meta.url),
  'utf8',
)
const cityCreditMigrationDdl = await readFile(
  new URL('../../db/migrations/20260822_city_credit.sql', import.meta.url),
  'utf8',
)
const recoveryTriggerRepairMigrationDdl = await readFile(
  new URL('../../db/migrations/20260823_payment_recovery_trigger_repair.sql', import.meta.url),
  'utf8',
)
const lateFinalityRecheckMigrationDdl = await readFile(
  new URL('../../db/migrations/20260825_payment_late_finality_recheck.sql', import.meta.url),
  'utf8',
)

process.env.BASE_RPC_URL = 'https://payment-recovery-rpc.test'
const { createPaymentRecoveryRuntime } = await import('../../src/payment-recovery-runtime.ts')

function previousLateFinalityGuardDdl(): string {
  const matchingEvidence = `      AND (
        (
          OLD.finalized_block_number IS NULL
          AND OLD.finalized_block_hash IS NULL
          AND OLD.finalized_block_time IS NULL
          AND OLD.finalized_at IS NULL
        )
        OR ROW(
          NEW.finalized_block_number, NEW.finalized_block_hash,
          NEW.finalized_block_time, NEW.finalized_at
        ) IS NOT DISTINCT FROM ROW(
          OLD.finalized_block_number, OLD.finalized_block_hash,
          OLD.finalized_block_time, OLD.finalized_at
        )
      )`
  const emptyEvidenceOnly = `      AND OLD.finalized_block_number IS NULL
      AND OLD.finalized_block_hash IS NULL
      AND OLD.finalized_block_time IS NULL
      AND OLD.finalized_at IS NULL`
  const previous = lateFinalityRecheckMigrationDdl.replace(matchingEvidence, emptyEvidenceOnly)
  assert.notEqual(previous, lateFinalityRecheckMigrationDdl, 'late-finality guard fixture drifted')
  return previous
}

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ database: Pool; containerName: string }> {
  const containerName = `1f3d9-payment-recovery-${process.pid}-${randomBytes(4).toString('hex')}`
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
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(Number.isInteger(port) && port > 0)
    const database = new Pool({
      host: '127.0.0.1', port, user: 'postgres', password,
      database: POSTGRES_DATABASE, ssl: false, max: 8,
    })
    const deadline = Date.now() + 30_000
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        await database.query('SELECT 1')
        return { database, containerName }
      } catch (error) {
        lastError = error
        await delay(200)
      }
    }
    await database.end().catch(() => undefined)
    throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
  } catch (error) {
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8' })
    throw error
  }
}

async function reset(database: Pool): Promise<void> {
  await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await database.query(schemaDdl)
  await database.query(`
    INSERT INTO residents (id, handle, model, secret_hash) VALUES
      (1, 'founder', 'integration-test', repeat('1', 64)),
      (2, 'payer', 'integration-test', repeat('2', 64))
  `)
}

test('payment recovery migration and primitives preserve exact deadline and terminal history', async t => {
  const postgres = await startPostgres()
  const { database, containerName } = postgres
  t.after(async () => {
    await database.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8' })
  })

  await registerDeadlinesTests(
    t, database, reset, cityCreditMigrationDdl, recoveryTriggerRepairMigrationDdl,
  )
  await registerTargetLookupTests(t, database, reset)
  await registerFinalityTests(t, database, reset)
  await registerExplicitRecheckTests(
    t, database, reset, previousLateFinalityGuardDdl,
    lateFinalityRecheckMigrationDdl, createPaymentRecoveryRuntime,
  )
  await registerMigrationsTests(
    t, database, reset, recoveryMigrationDdl, recoveryTriggerRepairMigrationDdl,
  )
  await registerDirectSalesTests(t, database, reset)
  await registerBobRepairTests(t, database, reset)
})
