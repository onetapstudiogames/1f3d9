import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Client } from 'pg'

type IdentityStore = typeof import('../../src/identity-store.ts')

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'identity_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const recoveryMigrationDdl = await readFile(
  new URL('../../db/migrations/20260816_identity_recovery.sql', import.meta.url),
  'utf8',
)

let database: Client | null = null

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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ client: Client; containerName: string }> {
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
    while (Date.now() < deadline) {
      const client = new Client({
        host: '127.0.0.1', port, user: 'postgres', password,
        database: POSTGRES_DATABASE, ssl: false,
      })
      try {
        await client.connect()
        return { client, containerName }
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

function registration(label: string, handle = 'new-resident') {
  return {
    sessionHash: sha256(`${label}:session`),
    csrfHash: sha256(`${label}:csrf`),
    ipHash: sha256(`${label}:ip`),
    handle,
    model: 'postgres-test',
    residentSecretHash: sha256(`${label}:root-key`),
  }
}

async function generateCodes(store: IdentityStore, label: string) {
  const raw = Array.from({ length: 8 }, (_, index) => `1f3d9_rc_${sha256(`${label}:${index}`)}`)
  const result = await store.generateRecoveryCodes({
    residentSecretHash: sha256('existing-root-key'),
    codeHashes: raw.map(sha256),
  })
  assert.deepEqual(result, { residentId: 1, handle: 'existing-agent', generation: 1 })
  return raw
}

test('identity registration and recovery are atomic in PostgreSQL', async t => {
  const postgres = await startPostgres()
  database = postgres.client
  try {
    const store = await import('../../src/identity-store.ts')

    await t.test('the recovery migration can be reapplied without changing existing identity state', async () => {
      await resetDatabase()
      await database!.query(recoveryMigrationDdl)
      await database!.query(recoveryMigrationDdl)
      const state = await database!.query(
        `SELECT
           (SELECT count(*) FROM residents) AS residents,
           (SELECT recovery_generation FROM residents WHERE id = 1) AS generation,
           (SELECT count(*) FROM pending_resident_registrations) AS pending,
           (SELECT count(*) FROM resident_recovery_codes) AS recovery_codes`,
      )
      assert.deepEqual(state.rows, [{
        residents: '1', generation: '0', pending: '0', recovery_codes: '0',
      }])
    })

    await t.test('registration stores only hashes and creates nothing before exact key confirmation', async () => {
      await resetDatabase()
      const pending = registration('staged')
      assert.deepEqual(await store.stageResidentRegistration(pending), {
        status: 'staged', handle: 'new-resident',
      })
      const before = await database!.query(
        `SELECT handle, model, secret_hash, ip_hash, resident_id, confirmed_at, canceled_at
         FROM pending_resident_registrations WHERE session_hash = $1`,
        [pending.sessionHash],
      )
      assert.deepEqual(before.rows, [{
        handle: pending.handle,
        model: pending.model,
        secret_hash: pending.residentSecretHash,
        ip_hash: pending.ipHash,
        resident_id: null,
        confirmed_at: null,
        canceled_at: null,
      }])
      assert.equal((await database!.query("SELECT count(*) FROM residents WHERE handle = 'new-resident'")).rows[0]!.count, '0')
      assert.equal((await database!.query("SELECT count(*) FROM events WHERE actor = 'new-resident'")).rows[0]!.count, '0')

      assert.equal(await store.confirmResidentRegistration({
        sessionHash: pending.sessionHash,
        csrfHash: pending.csrfHash,
        residentSecretHash: sha256('wrong-key'),
      }), null)
      assert.deepEqual(await store.confirmResidentRegistration({
        sessionHash: pending.sessionHash,
        csrfHash: pending.csrfHash,
        residentSecretHash: pending.residentSecretHash,
      }), { residentId: 2, handle: 'new-resident' })
      assert.equal(await store.confirmResidentRegistration({
        sessionHash: pending.sessionHash,
        csrfHash: pending.csrfHash,
        residentSecretHash: pending.residentSecretHash,
      }), null)

      const after = await database!.query(
        `SELECT handle, model, secret_hash, ip_hash, resident_id, confirmed_at IS NOT NULL AS confirmed
         FROM pending_resident_registrations WHERE session_hash = $1`,
        [pending.sessionHash],
      )
      assert.deepEqual(after.rows, [{
        handle: null, model: null, secret_hash: null, ip_hash: null,
        resident_id: 2, confirmed: true,
      }])
      assert.equal((await database!.query("SELECT count(*) FROM events WHERE kind = 'register' AND actor = 'new-resident'")).rows[0]!.count, '1')
      assert.equal((await database!.query('SELECT last_id FROM resident_id_allocator WHERE singleton')).rows[0]!.last_id, 2)
    })

    await t.test('two pending claims for one handle have one winner and no leaked ID', async () => {
      await resetDatabase()
      const first = registration('race-first', 'raced-name')
      const second = registration('race-second', 'raced-name')
      assert.equal((await store.stageResidentRegistration(first))?.status, 'staged')
      assert.equal((await store.stageResidentRegistration(second))?.status, 'staged')
      const results = await Promise.all([
        store.confirmResidentRegistration({
          sessionHash: first.sessionHash, csrfHash: first.csrfHash,
          residentSecretHash: first.residentSecretHash,
        }),
        store.confirmResidentRegistration({
          sessionHash: second.sessionHash, csrfHash: second.csrfHash,
          residentSecretHash: second.residentSecretHash,
        }),
      ])
      assert.equal(results.filter(Boolean).length, 1)
      assert.equal((await database!.query("SELECT count(*) FROM residents WHERE handle = 'raced-name'")).rows[0]!.count, '1')
      assert.equal((await database!.query("SELECT count(*) FROM events WHERE actor = 'raced-name'")).rows[0]!.count, '1')
      assert.equal((await database!.query('SELECT last_id FROM resident_id_allocator WHERE singleton')).rows[0]!.last_id, 2)
    })

    await t.test('abandoned or canceled recovery preserves the old key, code, and connector grant', async () => {
      await resetDatabase()
      const codes = await generateCodes(store, 'abandon')
      await database!.query(
        `WITH family AS (
           INSERT INTO oauth_token_families (resident_id, client_id, resource, scope, expires_at)
           VALUES (1, 'test-client', 'https://city.test/mcp/connect', 'city:resident', now() + interval '1 day')
           RETURNING id
         )
         INSERT INTO oauth_tokens (token_hash, token_type, family_id, expires_at)
         SELECT $1, 'access', id, now() + interval '5 minutes' FROM family`,
        [sha256('active-access-token')],
      )
      const stage = {
        sessionHash: sha256('abandon:session'),
        csrfHash: sha256('abandon:csrf'),
        recoveryCodeHash: sha256(codes[0]!),
        replacementSecretHash: sha256('replacement-root-key'),
      }
      assert.deepEqual(await store.stageRootRecovery(stage), { handle: 'existing-agent' })
      assert.equal(await store.confirmRootRecovery({
        sessionHash: stage.sessionHash,
        csrfHash: stage.csrfHash,
        replacementSecretHash: sha256('wrong-replacement'),
      }), null)
      assert.equal(await store.cancelRootRecovery(stage), true)
      const state = await database!.query(
        `SELECT
           (SELECT secret_hash FROM residents WHERE id = 1) AS secret_hash,
           (SELECT used_at FROM resident_recovery_codes WHERE code_hash = $1) AS used_at,
           (SELECT revoked_at FROM oauth_token_families LIMIT 1) AS revoked_at`,
        [sha256(codes[0]!)],
      )
      assert.deepEqual(state.rows[0], {
        secret_hash: sha256('existing-root-key'), used_at: null, revoked_at: null,
      })
    })

    await t.test('one recovery wins, rotates the root, invalidates siblings, and revokes OAuth', async () => {
      await resetDatabase()
      const codes = await generateCodes(store, 'winner')
      await database!.query(
        `WITH family AS (
           INSERT INTO oauth_token_families (resident_id, client_id, resource, scope, expires_at)
           VALUES (1, 'test-client', 'https://city.test/mcp/connect', 'city:resident', now() + interval '1 day')
           RETURNING id
         )
         INSERT INTO oauth_tokens (token_hash, token_type, family_id, expires_at)
         SELECT $1, 'access', id, now() + interval '5 minutes' FROM family`,
        [sha256('active-access-token')],
      )
      const first = {
        sessionHash: sha256('winner:first-session'), csrfHash: sha256('winner:first-csrf'),
        recoveryCodeHash: sha256(codes[0]!), replacementSecretHash: sha256('replacement-one'),
      }
      const second = {
        sessionHash: sha256('winner:second-session'), csrfHash: sha256('winner:second-csrf'),
        recoveryCodeHash: sha256(codes[1]!), replacementSecretHash: sha256('replacement-two'),
      }
      assert.ok(await store.stageRootRecovery(first))
      assert.ok(await store.stageRootRecovery(second))
      const results = await Promise.all([
        store.confirmRootRecovery({
          sessionHash: first.sessionHash, csrfHash: first.csrfHash,
          replacementSecretHash: first.replacementSecretHash,
        }),
        store.confirmRootRecovery({
          sessionHash: second.sessionHash, csrfHash: second.csrfHash,
          replacementSecretHash: second.replacementSecretHash,
        }),
      ])
      assert.equal(results.filter(Boolean).length, 1)
      const winner = results[0] ? first : second
      const state = await database!.query(
        `SELECT
           (SELECT secret_hash FROM residents WHERE id = 1) AS secret_hash,
           (SELECT recovery_generation FROM residents WHERE id = 1) AS generation,
           (SELECT count(*) FROM resident_recovery_codes WHERE used_at IS NOT NULL) AS used,
           (SELECT count(*) FROM resident_recovery_codes WHERE invalidated_at IS NOT NULL) AS invalidated,
           (SELECT count(*) FROM oauth_token_families WHERE revoked_at IS NOT NULL) AS revoked_families,
           (SELECT count(*) FROM oauth_tokens WHERE revoked_at IS NOT NULL) AS revoked_tokens,
           (SELECT count(*) FROM events WHERE kind = 'rotate' AND actor = 'existing-agent') AS rotate_events`,
      )
      assert.deepEqual(state.rows[0], {
        secret_hash: winner.replacementSecretHash,
        generation: '2', used: '1', invalidated: '7',
        revoked_families: '1', revoked_tokens: '1', rotate_events: '1',
      })
    })
  } finally {
    await database.end().catch(() => undefined)
    database = null
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
