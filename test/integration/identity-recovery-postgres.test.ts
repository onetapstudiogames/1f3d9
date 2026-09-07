import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Client, Pool } from 'pg'
import { sha256 } from '../helpers/identity-recovery-fixtures/credentials.ts'
import { registerMigrationsTests } from './identity-recovery-tests/migrations.ts'
import { registerStagingAndCodeValidationTests } from './identity-recovery-tests/staging-and-code-validation.ts'
import { registerRegistrationConfirmationTests } from './identity-recovery-tests/registration-confirmation.ts'
import { registerCancellationAndExpiryTests } from './identity-recovery-tests/cancellation-and-expiry.ts'
import { registerRegistrationConcurrencyTests } from './identity-recovery-tests/registration-concurrency.ts'
import { registerRecoveryTests } from './identity-recovery-tests/recovery.ts'
import { registerRootRotationTests } from './identity-recovery-tests/root-rotation.ts'
import { registerRotationRecoveryBoundariesTests } from './identity-recovery-tests/rotation-recovery-boundaries.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'identity_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const recoveryMigrationDdl = await readFile(
  new URL('../../db/migrations/20260816_identity_recovery.sql', import.meta.url),
  'utf8',
)
const rotationMigrationDdl = await readFile(
  new URL('../../db/migrations/20260816_identity_rotation.sql', import.meta.url),
  'utf8',
)
const initialRecoveryCodesMigrationDdl = await readFile(
  new URL('../../db/migrations/20260817_initial_recovery_codes.sql', import.meta.url),
  'utf8',
)
const resumableRegistrationMigrationDdl = await readFile(
  new URL('../../db/migrations/20260826_resumable_registration.sql', import.meta.url),
  'utf8',
)

let database: Pool | null = null

const sql = async (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): Promise<Record<string, unknown>[]> => {
  assert.ok(database, 'the PostgreSQL test client must be connected before the identity store runs')
  const text = strings.reduce(
    (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ''),
    '',
  )
  const result = await database.query(text, [...values])
  return result.rows as Record<string, unknown>[]
}

mock.module(new URL('../../src/db.ts', import.meta.url).href, { namedExports: { sql } })

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ client: Pool; containerName: string }> {
  const containerName = `1f3d9-identity-test-${process.pid}-${randomBytes(4).toString('hex')}`
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
    assert.ok(Number.isInteger(port) && port > 0)
    const deadline = Date.now() + 30_000
    let lastError: unknown = null
    const connection = {
      host: '127.0.0.1', port, user: 'postgres', password,
      database: POSTGRES_DATABASE, ssl: false,
    } as const
    while (Date.now() < deadline) {
      const client = new Client(connection)
      try {
        await client.connect()
        await client.end()
        return { client: new Pool(connection), containerName }
      } catch (error) {
        lastError = error
        await client.end().catch(() => undefined)
        await delay(200)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
  } catch (error) {
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8' })
    throw error
  }
}

async function resetDatabase(): Promise<void> {
  assert.ok(database)
  await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await database.query(schemaDdl)
  await database.query(
    `INSERT INTO residents (id, handle, model, secret_hash)
     VALUES (1, 'existing-agent', 'integration-test', $1)`,
    [sha256('existing-root-key')],
  )
  await database.query('UPDATE resident_id_allocator SET last_id = 1 WHERE singleton')
}

test('identity registration and recovery are atomic in PostgreSQL', async t => {
  const postgres = await startPostgres()
  database = postgres.client
  try {
    const store = await import('../../src/identity-store.ts')

    await registerMigrationsTests(
      t, database, store, resetDatabase,
      recoveryMigrationDdl, rotationMigrationDdl,
      initialRecoveryCodesMigrationDdl, resumableRegistrationMigrationDdl,
    )
    await registerStagingAndCodeValidationTests(t, database, store, resetDatabase)
    await registerRegistrationConfirmationTests(t, database, store, resetDatabase)
    await registerCancellationAndExpiryTests(t, database, store, resetDatabase)
    await registerRegistrationConcurrencyTests(t, database, store, resetDatabase)
    await registerRecoveryTests(t, database, store, resetDatabase)
    await registerRootRotationTests(t, database, store, resetDatabase)
    await registerRotationRecoveryBoundariesTests(t, database, store, resetDatabase)
  } finally {
    await database.end().catch(() => undefined)
    database = null
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
