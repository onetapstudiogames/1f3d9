import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import type { PayPalCreditStoreDatabase } from '../../src/paypal-credit-store.ts'
import { database } from '../helpers/paypal-credit-dispute-fixtures/paypal-dispute-environment.ts'
import { registerGuardedMigrationTests } from './paypal-credit-dispute-tests/guarded-migration.ts'
import { registerMultiCaptureReceiptsTests } from './paypal-credit-dispute-tests/multi-capture-receipts.ts'
import { registerRefusalAttentionTests } from './paypal-credit-dispute-tests/refusal-attention.ts'
import { registerEvolvingCaptureSetsTests } from './paypal-credit-dispute-tests/evolving-capture-sets.ts'
import { registerOutcomeClassificationTests } from './paypal-credit-dispute-tests/outcome-classification.ts'
import { registerEqualTimestampGuardsTests } from './paypal-credit-dispute-tests/equal-timestamp-guards.ts'
import { registerAdverseProjectionTests } from './paypal-credit-dispute-tests/adverse-projection.ts'
import { registerFounderReviewTests } from './paypal-credit-dispute-tests/founder-review.ts'
import { registerSellerReviewRevokedGiftTests } from './paypal-credit-dispute-tests/seller-review-revoked-gift.ts'
import { registerRefusedGiftLockingTests } from './paypal-credit-dispute-tests/refused-gift-locking.ts'
import { registerCaptureRacesTests } from './paypal-credit-dispute-tests/capture-races.ts'
import { registerDatabaseBoundariesTests } from './paypal-credit-dispute-tests/database-boundaries.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'paypal_dispute_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const disputeMigrationDdl = await readFile(
  new URL('../../db/migrations/20260827_paypal_credit_disputes.sql', import.meta.url),
  'utf8',
)
const disputeSchemaMarker = '\n-- PayPal dispute custody (2026-08-27; migration mirror).'
const disputeSchemaOffset = schemaDdl.indexOf(disputeSchemaMarker)
assert.ok(disputeSchemaOffset > 0, 'fresh schema must mark the PayPal dispute migration mirror')
const preDisputeSchemaDdl = schemaDdl.slice(0, disputeSchemaOffset)

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
      || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ pool: Pool; containerName: string }> {
  const containerName = `1f3d9-paypal-dispute-${process.pid}-${randomBytes(4).toString('hex')}`
  const password = randomBytes(24).toString('hex')
  runDocker([
    'run', '--detach', '--rm', '--name', containerName,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', `POSTGRES_DB=${POSTGRES_DATABASE}`,
    POSTGRES_IMAGE,
  ])
  try {
    const port = Number(runDocker(['port', containerName, '5432/tcp'])
      .match(/:(\d+)\s*$/u)?.[1])
    assert.ok(Number.isInteger(port) && port > 0)
    const pool = new Pool({
      host: '127.0.0.1', port, user: 'postgres', password,
      database: POSTGRES_DATABASE, ssl: false, max: 6,
    })
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      try {
        await pool.query('SELECT 1')
        return { pool, containerName }
      } catch {
        await delay(200)
      }
    }
    await pool.end().catch(() => undefined)
    throw new Error('PostgreSQL did not become ready')
  } catch (error) {
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8' })
    throw error
  }
}

async function reset(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await pool.query(schemaDdl)
  await pool.query(disputeMigrationDdl)
  await pool.query(disputeMigrationDdl)
  await pool.query(`
    INSERT INTO residents (id, handle, model, secret_hash) VALUES
      (1, 'founder', 'paypal-dispute-test', repeat('1', 64)),
      (2, 'recipient-two', 'paypal-dispute-test', repeat('2', 64)),
      (3, 'recipient-three', 'paypal-dispute-test', repeat('3', 64))
  `)
}

async function withPostgres(
  run: (pool: Pool, db: PayPalCreditStoreDatabase) => Promise<void>,
): Promise<void> {
  const postgres = await startPostgres()
  try {
    await reset(postgres.pool)
    await run(postgres.pool, database(postgres.pool))
  } finally {
    await postgres.pool.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
}

test('the guarded migration upgrades populated gift custody and reapplies exactly', {
  timeout: 120_000,
}, async () => {
  const postgres = await startPostgres()
  try {
    await registerGuardedMigrationTests(postgres, preDisputeSchemaDdl, disputeMigrationDdl)
  } finally {
    await postgres.pool.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})

test('multi-capture disputes stage unknown captures and produce the full event-purchase receipt matrix', {
  timeout: 120_000,
}, async () => {
  await withPostgres(async (pool, db) => {
    await registerMultiCaptureReceiptsTests(pool, db)
  })
})

test('a dispute-frozen gift is the only gift and still receives refusal attention', {
  timeout: 120_000,
}, async () => {
  await withPostgres(async (pool, db) => {
    await registerRefusalAttentionTests(pool, db)
  })
})

test('evolving dispute capture sets reconcile every durable capture through resolution', {
  timeout: 120_000,
}, async () => {
  await withPostgres(async (pool, db) => {
    await registerEvolvingCaptureSetsTests(pool, db)
  })
})

test('disputes reconcile before capture, honor latest time, and classify every official outcome', {
  timeout: 120_000,
}, async () => {
  await withPostgres(async (pool, db) => {
    await registerOutcomeClassificationTests(pool, db)
  })
})

test('equal dispute timestamps advance lifecycle without weakening stale or conflict guards', {
  timeout: 120_000,
}, async () => {
  await withPostgres(async (pool, db) => {
    await registerEqualTimestampGuardsTests(pool, db)
  })
})

test('only current adverse evidence or prior adverse custody can support an adverse projection', {
  timeout: 120_000,
}, async () => {
  await withPostgres(async (pool, db) => {
    await registerAdverseProjectionTests(pool, db)
  })
})

test('founder review decisions resolve ambiguous custody once and leave a redacted public record', {
  timeout: 120_000,
}, async () => {
  await withPostgres(async (pool, db) => {
    await registerFounderReviewTests(pool, db)
  })
})

test('seller-favour review states when another dispute already revoked the gift', {
  timeout: 120_000,
}, async () => {
  await withPostgres(async (pool, db) => {
    await registerSellerReviewRevokedGiftTests(pool, db)
  })
})

test('refused gifts keep their refusal while open disputes block redirect in both row-lock orderings', {
  timeout: 120_000,
}, async () => {
  await withPostgres(async (pool, db) => {
    await registerRefusedGiftLockingTests(pool, db)
  })
})

test('exact replay and dispute-versus-capture races converge across real connections', {
  timeout: 120_000,
}, async () => {
  await withPostgres(async (pool, db) => {
    await registerCaptureRacesTests(pool, db)
  })
})

test('database boundaries reject noncanonical arrays and accept 255-character capture and dispute ids', {
  timeout: 120_000,
}, async () => {
  await withPostgres(async (pool, db) => {
    await registerDatabaseBoundariesTests(pool, db)
  })
})
