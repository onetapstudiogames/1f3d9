import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Client, Pool } from 'pg'

type IdentityStore = typeof import('../../src/identity-store.ts')

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

function rotation(
  label: string,
  residentSecret = 'existing-root-key',
  replacementSecret = `${label}:replacement-root-key`,
) {
  return {
    sessionHash: sha256(`${label}:session`),
    csrfHash: sha256(`${label}:csrf`),
    residentSecretHash: sha256(residentSecret),
    replacementSecretHash: sha256(replacementSecret),
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

    await t.test('the rotation migration is idempotent and preserves staged hashes', async () => {
      await resetDatabase()
      const staged = rotation('migration-preserved')
      await database!.query(
        `INSERT INTO resident_key_rotations (
           resident_id, recovery_generation, session_hash, csrf_hash,
           resident_secret_hash, replacement_secret_hash, expires_at
         ) VALUES (1, 0, $1, $2, $3, $4, now() + interval '15 minutes')`,
        [
          staged.sessionHash, staged.csrfHash,
          staged.residentSecretHash, staged.replacementSecretHash,
        ],
      )
      await database!.query(rotationMigrationDdl)
      await database!.query(rotationMigrationDdl)
      await database!.query(
        `INSERT INTO identity_rate_limits (bucket_hash, attempt_kind, window_start)
         VALUES ($1, 'rotation_begin', date_trunc('hour', now(), 'UTC')),
           ($2, 'rotation_confirm', date_trunc('hour', now(), 'UTC'))`,
        [sha256('migration-begin'), sha256('migration-confirm')],
      )
      const state = await database!.query(
        `SELECT session_hash, csrf_hash, resident_secret_hash, replacement_secret_hash,
           (SELECT count(*) FROM identity_rate_limits
            WHERE attempt_kind IN ('rotation_begin', 'rotation_confirm')) AS rate_kinds
         FROM resident_key_rotations`,
      )
      assert.deepEqual(state.rows, [{
        session_hash: staged.sessionHash,
        csrf_hash: staged.csrfHash,
        resident_secret_hash: staged.residentSecretHash,
        replacement_secret_hash: staged.replacementSecretHash,
        rate_kinds: '2',
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

    await t.test('a missing world root leaves the whole registration pending and unchanged', async () => {
      await resetDatabase()
      await database!.query('DROP TRIGGER places_protect_topology_write ON places')
      await database!.query("DELETE FROM places WHERE place_kind = 'world'")
      const pending = registration('missing-world', 'unplaced-resident')
      assert.equal((await store.stageResidentRegistration(pending))?.status, 'staged')

      assert.equal(await store.confirmResidentRegistration({
        sessionHash: pending.sessionHash,
        csrfHash: pending.csrfHash,
        residentSecretHash: pending.residentSecretHash,
      }), null)

      const state = await database!.query(
        `SELECT
           (SELECT count(*) FROM residents WHERE handle = 'unplaced-resident') AS residents,
           (SELECT count(*) FROM resident_presence WHERE resident_id <> 1) AS presences,
           (SELECT count(*) FROM events WHERE actor = 'unplaced-resident') AS events,
           (SELECT last_id FROM resident_id_allocator WHERE singleton) AS last_id,
           (SELECT resident_id FROM pending_resident_registrations WHERE session_hash = $1) AS resident_id,
           (SELECT confirmed_at FROM pending_resident_registrations WHERE session_hash = $1) AS confirmed_at`,
        [pending.sessionHash],
      )
      assert.deepEqual(state.rows, [{
        residents: '0', presences: '0', events: '0', last_id: 1,
        resident_id: null, confirmed_at: null,
      }])
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
        `WITH families AS (
           INSERT INTO oauth_token_families (
             resident_id, client_id, resource, scope, expires_at, revoked_at, revoke_reason
           ) VALUES
             (1, 'test-client', 'https://city.test/mcp/connect', 'city:resident',
               now() + interval '1 day', NULL, NULL),
             (1, 'already-revoked-client', 'https://city.test/mcp/connect', 'city:resident',
               now() + interval '1 day', now(), 'previous logout')
           RETURNING id, client_id
         )
         INSERT INTO oauth_tokens (token_hash, token_type, family_id, expires_at)
         SELECT CASE client_id
           WHEN 'test-client' THEN $1
           ELSE $2
         END, 'access', id, now() + interval '5 minutes' FROM families`,
        [sha256('active-access-token'), sha256('orphaned-access-token')],
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
        revoked_families: '2', revoked_tokens: '2', rotate_events: '1',
      })
    })

    await t.test('root rotation stages hashes only and cancel or expiry preserves the old key', async () => {
      await resetDatabase()
      const canceled = rotation('rotation-cancel')
      assert.deepEqual(await store.stageRootRotation(canceled), {
        residentId: 1, handle: 'existing-agent',
      })
      const staged = await database!.query(
        `SELECT resident_id, session_hash, csrf_hash, resident_secret_hash,
           replacement_secret_hash, recovery_generation, confirmed_at, canceled_at
         FROM resident_key_rotations WHERE session_hash = $1`,
        [canceled.sessionHash],
      )
      assert.deepEqual(staged.rows, [{
        resident_id: 1,
        session_hash: canceled.sessionHash,
        csrf_hash: canceled.csrfHash,
        resident_secret_hash: canceled.residentSecretHash,
        replacement_secret_hash: canceled.replacementSecretHash,
        recovery_generation: '0',
        confirmed_at: null,
        canceled_at: null,
      }])
      assert.equal(await store.confirmRootRotation({
        sessionHash: canceled.sessionHash,
        csrfHash: canceled.csrfHash,
        replacementSecretHash: sha256('wrong-replacement'),
      }), null)
      assert.equal(await store.cancelRootRotation(canceled), true)

      const expired = rotation('rotation-expired')
      assert.ok(await store.stageRootRotation(expired))
      await database!.query(
        `UPDATE resident_key_rotations
         SET created_at = now() - interval '20 minutes',
             expires_at = now() - interval '5 minutes'
         WHERE session_hash = $1`,
        [expired.sessionHash],
      )
      assert.ok(await store.stageRootRotation(rotation('rotation-cleanup')))

      const state = await database!.query(
        `SELECT
           (SELECT secret_hash FROM residents WHERE id = 1) AS secret_hash,
           (SELECT bool_and(session_hash IS NULL AND csrf_hash IS NULL
             AND resident_secret_hash IS NULL AND replacement_secret_hash IS NULL)
            FROM resident_key_rotations WHERE canceled_at IS NOT NULL) AS terminal_hashes_cleared,
           (SELECT count(*) FROM events WHERE kind = 'rotate') AS rotate_events`,
      )
      assert.deepEqual(state.rows[0], {
        secret_hash: sha256('existing-root-key'),
        terminal_hashes_cleared: true,
        rotate_events: '0',
      })
    })

    await t.test('one root rotation wins and stops every old resident credential only', async () => {
      await resetDatabase()
      const recoveryCodes = await generateCodes(store, 'rotation-winner')
      await database!.query(
        `INSERT INTO residents (id, handle, model, secret_hash)
         VALUES (2, 'unrelated-agent', 'integration-test', $1)`,
        [sha256('unrelated-root-key')],
      )
      await database!.query(
        `WITH resident_request AS (
           INSERT INTO oauth_authorization_requests (
             session_hash, csrf_hash, client_id, redirect_uri, resource, scope,
             state, code_challenge, intent, resident_id, expires_at
           ) VALUES (
             $1, $2, 'resident-client', 'https://client.test/callback',
             'https://city.test/mcp/connect', 'city:resident', 'resident-state',
             'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'existing', 1,
             now() + interval '10 minutes'
           ) RETURNING id
         ), resident_code AS (
           INSERT INTO oauth_authorization_codes (
             request_id, code_hash, resident_id, client_id, redirect_uri, resource,
             scope, code_challenge, expires_at
           ) SELECT id, $3, 1, 'resident-client', 'https://client.test/callback',
             'https://city.test/mcp/connect', 'city:resident',
             'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', now() + interval '4 minutes'
           FROM resident_request
         ), unrelated_request AS (
           INSERT INTO oauth_authorization_requests (
             session_hash, csrf_hash, client_id, redirect_uri, resource, scope,
             state, code_challenge, intent, resident_id, expires_at
           ) VALUES (
             $4, $5, 'unrelated-client', 'https://other.test/callback',
             'https://city.test/mcp/connect', 'city:resident', 'unrelated-state',
             'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'existing', 2,
             now() + interval '10 minutes'
           ) RETURNING id
         )
         INSERT INTO oauth_authorization_codes (
           request_id, code_hash, resident_id, client_id, redirect_uri, resource,
           scope, code_challenge, expires_at
         ) SELECT id, $6, 2, 'unrelated-client', 'https://other.test/callback',
           'https://city.test/mcp/connect', 'city:resident',
           'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', now() + interval '4 minutes'
         FROM unrelated_request`,
        [
          sha256('resident-auth-session'), sha256('resident-auth-csrf'), sha256('resident-auth-code'),
          sha256('unrelated-auth-session'), sha256('unrelated-auth-csrf'), sha256('unrelated-auth-code'),
        ],
      )
      const families = await database!.query(
        `INSERT INTO oauth_token_families (
           resident_id, client_id, resource, scope, expires_at, revoked_at, revoke_reason
         ) VALUES
           (1, 'resident-active', 'https://city.test/mcp/connect', 'city:resident',
             now() + interval '1 day', NULL, NULL),
           (1, 'resident-old-revoked', 'https://city.test/mcp/connect', 'city:resident',
             now() + interval '1 day', now(), 'previous logout'),
           (2, 'unrelated-active', 'https://city.test/mcp/connect', 'city:resident',
             now() + interval '1 day', NULL, NULL)
         RETURNING id, client_id`,
      )
      for (const family of families.rows) {
        await database!.query(
          `INSERT INTO oauth_tokens (token_hash, token_type, family_id, expires_at)
           VALUES ($1, 'access', $3, now() + interval '5 minutes'),
             ($2, 'refresh', $3, now() + interval '1 day')`,
          [sha256(`${family.client_id}:access`), sha256(`${family.client_id}:refresh`), family.id],
        )
      }

      const first = rotation('rotation-first')
      const second = rotation('rotation-second')
      assert.ok(await store.stageRootRotation(first))
      assert.ok(await store.stageRootRotation(second))
      const rotationResults = await Promise.all([
        store.confirmRootRotation({
          sessionHash: first.sessionHash,
          csrfHash: first.csrfHash,
          replacementSecretHash: first.replacementSecretHash,
        }),
        store.confirmRootRotation({
          sessionHash: second.sessionHash,
          csrfHash: second.csrfHash,
          replacementSecretHash: second.replacementSecretHash,
        }),
      ])
      assert.equal(rotationResults.filter(result => result?.status === 'rotated').length, 1)
      assert.equal(rotationResults.filter(result => result === null).length, 1)
      const rotationWinner = rotationResults[0]?.status === 'rotated' ? first : second
      assert.equal(await store.stageRootRotation(rotation(
        'old-key-rejected', 'existing-root-key', 'unused-replacement',
      )), null)

      const state = await database!.query(
        `SELECT
           (SELECT secret_hash FROM residents WHERE id = 1) AS secret_hash,
           (SELECT recovery_generation FROM residents WHERE id = 1) AS generation,
           (SELECT count(*) FROM resident_recovery_codes
             WHERE invalidated_at IS NOT NULL) AS invalidated_recovery,
           (SELECT count(*) FROM resident_key_rotations
             WHERE confirmed_at IS NOT NULL) AS confirmed_rotations,
           (SELECT count(*) FROM resident_key_rotations
             WHERE invalidated_at IS NOT NULL) AS invalidated_rotations,
           (SELECT bool_and(session_hash IS NULL AND csrf_hash IS NULL
             AND resident_secret_hash IS NULL AND replacement_secret_hash IS NULL)
            FROM resident_key_rotations
            WHERE confirmed_at IS NOT NULL OR invalidated_at IS NOT NULL) AS terminal_hashes_cleared,
           (SELECT count(*) FROM oauth_token_families
             WHERE resident_id = 1 AND revoked_at IS NOT NULL) AS resident_revoked_families,
           (SELECT count(*) FROM oauth_tokens token
             JOIN oauth_token_families family ON family.id = token.family_id
             WHERE family.resident_id = 1 AND token.revoked_at IS NOT NULL) AS resident_revoked_tokens,
           (SELECT count(*) FROM oauth_authorization_codes
             WHERE resident_id = 1 AND used_at IS NOT NULL) AS resident_invalidated_codes,
           (SELECT count(*) FROM oauth_token_families
             WHERE resident_id = 2 AND revoked_at IS NOT NULL) AS unrelated_revoked_families,
           (SELECT count(*) FROM oauth_tokens token
             JOIN oauth_token_families family ON family.id = token.family_id
             WHERE family.resident_id = 2 AND token.revoked_at IS NOT NULL) AS unrelated_revoked_tokens,
           (SELECT count(*) FROM oauth_authorization_codes
             WHERE resident_id = 2 AND used_at IS NOT NULL) AS unrelated_invalidated_codes,
           (SELECT secret_hash FROM residents WHERE id = 2) AS unrelated_secret_hash,
           (SELECT count(*) FROM events
             WHERE kind = 'rotate' AND actor = 'existing-agent') AS rotate_events`,
      )
      assert.deepEqual(state.rows[0], {
        secret_hash: rotationWinner.replacementSecretHash,
        generation: '2',
        invalidated_recovery: '8',
        confirmed_rotations: '1',
        invalidated_rotations: '1',
        terminal_hashes_cleared: true,
        resident_revoked_families: '2',
        resident_revoked_tokens: '4',
        resident_invalidated_codes: '1',
        unrelated_revoked_families: '0',
        unrelated_revoked_tokens: '0',
        unrelated_invalidated_codes: '0',
        unrelated_secret_hash: sha256('unrelated-root-key'),
        rotate_events: '1',
      })
      assert.equal(recoveryCodes.length, 8)
    })

    await t.test('root rotation and recovery use one shared generation winner', async () => {
      await resetDatabase()
      const codes = await generateCodes(store, 'rotation-recovery-race')
      const recovery = {
        sessionHash: sha256('rotation-recovery:recovery-session'),
        csrfHash: sha256('rotation-recovery:recovery-csrf'),
        recoveryCodeHash: sha256(codes[0]!),
        replacementSecretHash: sha256('recovery-race-replacement'),
      }
      const rootRotation = rotation('rotation-recovery:rotation')
      assert.ok(await store.stageRootRecovery(recovery))
      assert.ok(await store.stageRootRotation(rootRotation))
      const recoveryRace = await Promise.all([
        store.confirmRootRecovery({
          sessionHash: recovery.sessionHash,
          csrfHash: recovery.csrfHash,
          replacementSecretHash: recovery.replacementSecretHash,
        }),
        store.confirmRootRotation({
          sessionHash: rootRotation.sessionHash,
          csrfHash: rootRotation.csrfHash,
          replacementSecretHash: rootRotation.replacementSecretHash,
        }),
      ])
      assert.equal(recoveryRace.filter(Boolean).length, 1)
      assert.deepEqual(recoveryRace[0], { residentId: 1, handle: 'existing-agent' })
      assert.equal(recoveryRace[1], null)
      const recoveryWon = await database!.query(
        `SELECT secret_hash, recovery_generation,
           (SELECT count(*) FROM resident_key_rotations
            WHERE invalidated_at IS NOT NULL
              AND session_hash IS NULL AND csrf_hash IS NULL
              AND resident_secret_hash IS NULL AND replacement_secret_hash IS NULL) AS invalidated_rotations
         FROM residents WHERE id = 1`,
      )
      assert.deepEqual(recoveryWon.rows, [{
        secret_hash: recovery.replacementSecretHash,
        recovery_generation: '2',
        invalidated_rotations: '1',
      }])

      await resetDatabase()
      const otherCodes = await generateCodes(store, 'rotation-recovery-other-race')
      const otherRecovery = {
        sessionHash: sha256('rotation-other:recovery-session'),
        csrfHash: sha256('rotation-other:recovery-csrf'),
        recoveryCodeHash: sha256(otherCodes[0]!),
        replacementSecretHash: sha256('other-recovery-replacement'),
      }
      const otherRotation = rotation('rotation-other:rotation')
      assert.ok(await store.stageRootRecovery(otherRecovery))
      assert.ok(await store.stageRootRotation(otherRotation))
      assert.equal((await store.confirmRootRotation({
        sessionHash: otherRotation.sessionHash,
        csrfHash: otherRotation.csrfHash,
        replacementSecretHash: otherRotation.replacementSecretHash,
      }))?.status, 'rotated')
      assert.equal(await store.confirmRootRecovery({
        sessionHash: otherRecovery.sessionHash,
        csrfHash: otherRecovery.csrfHash,
        replacementSecretHash: otherRecovery.replacementSecretHash,
      }), null)
      const rotationWon = await database!.query(
        `SELECT secret_hash, recovery_generation,
           (SELECT count(*) FROM resident_recovery_codes
            WHERE invalidated_at IS NOT NULL) AS invalidated_recovery
         FROM residents WHERE id = 1`,
      )
      assert.deepEqual(rotationWon.rows, [{
        secret_hash: otherRotation.replacementSecretHash,
        recovery_generation: '2',
        invalidated_recovery: '8',
      }])
    })

    await t.test('only five successful root rotations are allowed per resident per UTC day', async () => {
      await resetDatabase()
      let currentSecret = 'existing-root-key'
      for (let index = 0; index < 5; index += 1) {
        const nextSecret = `daily-rotation-${index}`
        const intent = rotation(`daily-${index}`, currentSecret, nextSecret)
        assert.ok(await store.stageRootRotation(intent))
        assert.equal((await store.confirmRootRotation({
          sessionHash: intent.sessionHash,
          csrfHash: intent.csrfHash,
          replacementSecretHash: intent.replacementSecretHash,
        }))?.status, 'rotated')
        currentSecret = nextSecret
      }
      const limited = rotation('daily-limited', currentSecret, 'daily-rejected')
      assert.ok(await store.stageRootRotation(limited))
      assert.deepEqual(await store.confirmRootRotation({
        sessionHash: limited.sessionHash,
        csrfHash: limited.csrfHash,
        replacementSecretHash: limited.replacementSecretHash,
      }), { status: 'rate_limited' })
      const state = await database!.query(
        `SELECT secret_hash, recovery_generation,
           (SELECT count(*) FROM resident_key_rotations WHERE confirmed_at IS NOT NULL) AS confirmed,
           (SELECT count(*) FROM resident_key_rotations
             WHERE canceled_at IS NOT NULL AND session_hash IS NULL AND csrf_hash IS NULL
               AND resident_secret_hash IS NULL AND replacement_secret_hash IS NULL) AS scrubbed_canceled,
           (SELECT count(*) FROM events WHERE kind = 'rotate') AS rotate_events
         FROM residents WHERE id = 1`,
      )
      assert.deepEqual(state.rows, [{
        secret_hash: sha256(currentSecret),
        recovery_generation: '5',
        confirmed: '5',
        scrubbed_canceled: '1',
        rotate_events: '5',
      }])
    })
  } finally {
    await database.end().catch(() => undefined)
    database = null
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
