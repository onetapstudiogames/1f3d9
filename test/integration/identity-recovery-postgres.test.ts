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
    clientClass: 'coding_ephemeral' as const,
    residentSecretHash: sha256(`${label}:root-key`),
    recoveryCodeHashes: Array.from(
      { length: 8 },
      (_, index) => sha256(`${label}:recovery:${index}`),
    ),
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

    await t.test('the initial-code migration is idempotent and old staged rows remain writable but fail closed', async () => {
      await resetDatabase()
      await database!.query(initialRecoveryCodesMigrationDdl)
      await database!.query(initialRecoveryCodesMigrationDdl)
      const legacy = registration('legacy-no-codes', 'legacy-no-codes')
      await database!.query(
        `INSERT INTO pending_resident_registrations (
           session_hash, csrf_hash, ip_hash, handle, model, client_class, secret_hash, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '15 minutes')`,
        [
          legacy.sessionHash, legacy.csrfHash, legacy.ipHash, legacy.handle,
          legacy.model, legacy.clientClass, legacy.residentSecretHash,
        ],
      )

      await assert.rejects(
        store.confirmResidentRegistration({
          sessionHash: legacy.sessionHash,
          csrfHash: legacy.csrfHash,
          residentSecretHash: legacy.residentSecretHash,
          jsonDoorHumanApprovalDeclared: true,
        }),
        /registration confirmation produced no outcome/i,
      )
      const state = await database!.query(
        `SELECT
           (SELECT count(*) FROM residents WHERE handle = $1) AS residents,
           (SELECT count(*) FROM resident_presence WHERE resident_id <> 1) AS presences,
           (SELECT count(*) FROM resident_recovery_codes WHERE resident_id <> 1) AS active_codes,
           (SELECT count(*) FROM pending_resident_registration_recovery_codes
             WHERE registration_session_hash = $2) AS pending_codes,
           (SELECT last_id FROM resident_id_allocator WHERE singleton) AS last_id`,
        [legacy.handle, legacy.sessionHash],
      )
      assert.deepEqual(state.rows, [{
        residents: '0', presences: '0', active_codes: '0', pending_codes: '0', last_id: 1,
      }])

      await database!.query(
        `UPDATE pending_resident_registrations
         SET created_at = now() - interval '16 minutes',
             expires_at = now() - interval '1 minute'
         WHERE session_hash = $1`,
        [legacy.sessionHash],
      )
      assert.equal(
        (await store.stageResidentRegistration(registration('legacy-cleanup-trigger', 'legacy-cleanup-trigger')))?.status,
        'staged',
      )
      const expired = await database!.query(
        `SELECT handle, model, client_class, secret_hash, ip_hash, canceled_at IS NOT NULL AS canceled
         FROM pending_resident_registrations WHERE session_hash = $1`,
        [legacy.sessionHash],
      )
      assert.deepEqual(expired.rows, [{
        handle: null, model: null, client_class: null, secret_hash: null, ip_hash: null, canceled: true,
      }])
    })

    await t.test('the resumable-registration migration upgrades an old staged join and is idempotent', async () => {
      await resetDatabase()
      await database!.query(`
        ALTER TABLE pending_resident_registrations
          DROP CONSTRAINT pending_resident_registrations_client_class_valid;
        ALTER TABLE pending_resident_registrations DROP COLUMN client_class;
      `)
      const legacy = registration('resumable-legacy', 'resumable-legacy')
      await database!.query(
        `INSERT INTO pending_resident_registrations (
           session_hash, csrf_hash, ip_hash, handle, model, secret_hash, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, now() + interval '15 minutes')`,
        [
          legacy.sessionHash, legacy.csrfHash, legacy.ipHash, legacy.handle,
          legacy.model, legacy.residentSecretHash,
        ],
      )
      await database!.query(
        `INSERT INTO pending_resident_registration_recovery_codes (
           registration_session_hash, ordinal, code_hash
         ) SELECT $1, code.ordinality::smallint, code.code_hash
           FROM unnest($2::text[]) WITH ORDINALITY AS code(code_hash, ordinality)`,
        [legacy.sessionHash, legacy.recoveryCodeHashes],
      )
      assert.equal((await database!.query(
        `SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'pending_resident_registrations'
           AND column_name = 'client_class'`,
      )).rows[0]!.count, '0')

      await database!.query(resumableRegistrationMigrationDdl)
      const upgraded = await database!.query(
        `SELECT
           (SELECT count(*) FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'pending_resident_registrations'
              AND column_name = 'client_class') AS columns,
           (SELECT convalidated FROM pg_constraint
            WHERE conrelid = 'pending_resident_registrations'::regclass
              AND conname = 'pending_resident_registrations_client_class_valid') AS validated`,
      )
      assert.deepEqual(upgraded.rows, [{ columns: '1', validated: true }])
      assert.deepEqual(await store.getResidentRegistrationProgress({
        sessionHash: legacy.sessionHash,
        csrfHash: legacy.csrfHash,
      }), {
        status: 'staged', handle: legacy.handle, clientClass: 'legacy_unknown',
      })

      const pending = registration('resumable-migration', 'resumable-migration')
      assert.equal((await store.stageResidentRegistration(pending)).status, 'staged')
      await database!.query(resumableRegistrationMigrationDdl)
      const state = await database!.query(
        `SELECT client_class, secret_hash,
           (SELECT count(*) FROM pending_resident_registration_recovery_codes
            WHERE registration_session_hash = $1) AS pending_codes
         FROM pending_resident_registrations WHERE session_hash = $1`,
        [pending.sessionHash],
      )
      assert.deepEqual(state.rows, [{
        client_class: 'coding_ephemeral',
        secret_hash: pending.residentSecretHash,
        pending_codes: '8',
      }])
      assert.deepEqual(await store.confirmResidentRegistration({
        sessionHash: legacy.sessionHash,
        csrfHash: legacy.csrfHash,
        residentSecretHash: legacy.residentSecretHash,
        jsonDoorHumanApprovalDeclared: true,
      }), {
        status: 'confirmed', residentId: 2, handle: legacy.handle,
      })
    })

    await t.test('registration rejects every non-exact, malformed, or duplicate initial-code set', async () => {
      await resetDatabase()
      const valid = registration('invalid-code-set')
      const attempts = [
        { ...valid, recoveryCodeHashes: valid.recoveryCodeHashes.slice(0, 7) },
        { ...valid, recoveryCodeHashes: [...valid.recoveryCodeHashes, sha256('ninth-code')] },
        { ...valid, recoveryCodeHashes: valid.recoveryCodeHashes.map((hash, index) => index === 7 ? valid.recoveryCodeHashes[0]! : hash) },
        { ...valid, recoveryCodeHashes: valid.recoveryCodeHashes.map((hash, index) => index === 7 ? 'A'.repeat(64) : hash) },
      ]
      for (const attempt of attempts) {
        await assert.rejects(
          store.stageResidentRegistration(attempt),
          /exactly eight unique sha256 recovery-code hashes are required/i,
        )
      }
      assert.equal((await database!.query('SELECT count(*) FROM pending_resident_registrations')).rows[0]!.count, '0')
      assert.equal((await database!.query('SELECT count(*) FROM pending_resident_registration_recovery_codes')).rows[0]!.count, '0')
    })

    await t.test('concurrent duplicate registration staging keeps one resumable credential set', async () => {
      await resetDatabase()
      const first = registration('concurrent-stage:first', 'concurrent-stage')
      const secondCredentials = registration('concurrent-stage:second', 'concurrent-stage')
      const second = {
        ...secondCredentials,
        sessionHash: first.sessionHash,
        csrfHash: first.csrfHash,
        ipHash: first.ipHash,
      }
      const attempts = [first, second] as const

      const results = await Promise.all(
        attempts.map(attempt => store.stageResidentRegistration(attempt)),
      )

      assert.deepEqual(
        results.map(result => result.status).sort(),
        ['request_unavailable', 'staged'],
      )
      const winnerIndex = results.findIndex(result => result.status === 'staged')
      const winner = winnerIndex === 0 ? first : second
      const loser = winnerIndex === 0 ? second : first
      const persisted = await database!.query<{
        handle: string
        model: string
        client_class: string
        secret_hash: string
        pending_codes: string
        code_hashes: string[]
      }>(
        `SELECT pending.handle, pending.model, pending.client_class, pending.secret_hash,
           count(code.*) AS pending_codes,
           array_agg(code.code_hash ORDER BY code.ordinal) AS code_hashes
         FROM pending_resident_registrations pending
         JOIN pending_resident_registration_recovery_codes code
           ON code.registration_session_hash = pending.session_hash
         WHERE pending.session_hash = $1
         GROUP BY pending.handle, pending.model, pending.client_class, pending.secret_hash`,
        [first.sessionHash],
      )

      assert.deepEqual(persisted.rows, [{
        handle: winner.handle,
        model: winner.model,
        client_class: winner.clientClass,
        secret_hash: winner.residentSecretHash,
        pending_codes: '8',
        code_hashes: winner.recoveryCodeHashes,
      }])
      assert.equal(
        loser.recoveryCodeHashes.some(hash => persisted.rows[0]!.code_hashes.includes(hash)),
        false,
      )
      assert.deepEqual(await store.getResidentRegistrationProgress({
        sessionHash: first.sessionHash,
        csrfHash: first.csrfHash,
      }), {
        status: 'staged', handle: winner.handle, clientClass: winner.clientClass,
      })
    })

    await t.test('recovery-set generation rejects every non-exact, malformed, or duplicate hash set', async () => {
      await resetDatabase()
      const valid = Array.from({ length: 8 }, (_, index) => sha256(`generated-set:${index}`))
      const attempts = [
        valid.slice(0, 7),
        [...valid, sha256('generated-set:ninth')],
        valid.map((hash, index) => index === 7 ? valid[0]! : hash),
        valid.map((hash, index) => index === 7 ? 'A'.repeat(64) : hash),
      ]
      for (const codeHashes of attempts) {
        await assert.rejects(
          store.generateRecoveryCodes({
            residentSecretHash: sha256('existing-root-key'),
            codeHashes,
          }),
          /exactly eight unique sha256 recovery-code hashes are required/i,
        )
      }
      assert.equal((await database!.query('SELECT count(*) FROM resident_recovery_codes')).rows[0]!.count, '0')
    })

    await t.test('registration stores only hashes and creates nothing before exact key confirmation', async () => {
      await resetDatabase()
      const pending = registration('staged')
      assert.deepEqual(await store.stageResidentRegistration(pending), {
        status: 'staged', handle: 'new-resident',
      })
      assert.deepEqual(await store.getResidentRegistrationProgress({
        sessionHash: pending.sessionHash,
        csrfHash: pending.csrfHash,
      }), {
        status: 'staged', handle: 'new-resident', clientClass: 'coding_ephemeral',
      })
      const before = await database!.query(
        `SELECT handle, model, client_class, secret_hash, ip_hash, resident_id, confirmed_at, canceled_at
         FROM pending_resident_registrations WHERE session_hash = $1`,
        [pending.sessionHash],
      )
      assert.deepEqual(before.rows, [{
        handle: pending.handle,
        model: pending.model,
        client_class: pending.clientClass,
        secret_hash: pending.residentSecretHash,
        ip_hash: pending.ipHash,
        resident_id: null,
        confirmed_at: null,
        canceled_at: null,
      }])
      const pendingCodes = await database!.query(
        `SELECT ordinal, code_hash
         FROM pending_resident_registration_recovery_codes
         WHERE registration_session_hash = $1
         ORDER BY ordinal`,
        [pending.sessionHash],
      )
      assert.deepEqual(
        pendingCodes.rows,
        pending.recoveryCodeHashes.map((code_hash, index) => ({ ordinal: index + 1, code_hash })),
      )
      assert.equal((await database!.query("SELECT count(*) FROM residents WHERE handle = 'new-resident'")).rows[0]!.count, '0')
      assert.equal((await database!.query("SELECT count(*) FROM events WHERE actor = 'new-resident'")).rows[0]!.count, '0')

      assert.deepEqual(await store.confirmResidentRegistration({
        sessionHash: pending.sessionHash,
        csrfHash: pending.csrfHash,
        residentSecretHash: sha256('wrong-key'),
        jsonDoorHumanApprovalDeclared: true,
      }), { status: 'credential_rejected' })
      const afterWrongKey = await database!.query(
        `SELECT confirmed_at, canceled_at, secret_hash,
           (SELECT count(*) FROM pending_resident_registration_recovery_codes
            WHERE registration_session_hash = $1) AS pending_codes
         FROM pending_resident_registrations WHERE session_hash = $1`,
        [pending.sessionHash],
      )
      assert.deepEqual(afterWrongKey.rows, [{
        confirmed_at: null,
        canceled_at: null,
        secret_hash: pending.residentSecretHash,
        pending_codes: '8',
      }])
      assert.deepEqual(await store.confirmResidentRegistration({
        sessionHash: pending.sessionHash,
        csrfHash: pending.csrfHash,
        residentSecretHash: pending.residentSecretHash,
        jsonDoorHumanApprovalDeclared: true,
      }), { status: 'confirmed', residentId: 2, handle: 'new-resident' })
      assert.deepEqual(await store.confirmResidentRegistration({
        sessionHash: pending.sessionHash,
        csrfHash: pending.csrfHash,
        residentSecretHash: pending.residentSecretHash,
        jsonDoorHumanApprovalDeclared: true,
      }), { status: 'confirmed', residentId: 2, handle: 'new-resident' })
      assert.deepEqual(await store.getResidentRegistrationProgress({
        sessionHash: pending.sessionHash,
        csrfHash: pending.csrfHash,
      }), { status: 'confirmed', residentId: 2, handle: 'new-resident' })

      const after = await database!.query(
        `SELECT handle, model, client_class, secret_hash, ip_hash, resident_id, confirmed_at IS NOT NULL AS confirmed
         FROM pending_resident_registrations WHERE session_hash = $1`,
        [pending.sessionHash],
      )
      assert.deepEqual(after.rows, [{
        handle: null, model: null, client_class: null, secret_hash: null, ip_hash: null,
        resident_id: 2, confirmed: true,
      }])
      const recoveryState = await database!.query(
        `SELECT resident.recovery_generation,
           array_agg(code.code_hash ORDER BY code.code_hash) AS code_hashes,
           (SELECT count(*) FROM pending_resident_registration_recovery_codes
             WHERE registration_session_hash = $1) AS pending_codes
         FROM residents resident
         JOIN resident_recovery_codes code ON code.resident_id = resident.id
         WHERE resident.id = 2 AND code.generation = 1
           AND code.used_at IS NULL AND code.invalidated_at IS NULL
         GROUP BY resident.recovery_generation`,
        [pending.sessionHash],
      )
      assert.deepEqual(recoveryState.rows, [{
        recovery_generation: '1',
        code_hashes: [...pending.recoveryCodeHashes].sort(),
        pending_codes: '0',
      }])
      assert.equal((await database!.query("SELECT count(*) FROM events WHERE kind = 'register' AND actor = 'new-resident'")).rows[0]!.count, '1')
      assert.equal((await database!.query('SELECT last_id FROM resident_id_allocator WHERE singleton')).rows[0]!.last_id, 2)
      // Decision row 74 security fix: json_door_human_approval_declared has
      // no column of its own on pending_resident_registrations -- it is
      // bound in directly from confirmResidentRegistration's own
      // jsonDoorHumanApprovalDeclared input parameter, supplied here
      // exactly like identity-api.ts (the JSON door) always supplies it:
      // true.
      const registerEvent = await database!.query<{
        detail: { json_door_human_approval_declared: boolean; client_class: string }
      }>(
        "SELECT detail FROM events WHERE kind = 'register' AND actor = 'new-resident'",
      )
      assert.deepEqual(registerEvent.rows[0]!.detail.json_door_human_approval_declared, true)
      assert.deepEqual(registerEvent.rows[0]!.detail.client_class, 'coding_ephemeral')
    })

    await t.test('a browser-shaped registration keeps its register event byte-identical to main, never client_class or a human-approval key', async () => {
      // Complements the JSON-shaped assertion above: identity-browser.ts's
      // /join page always calls confirmResidentRegistration with
      // jsonDoorHumanApprovalDeclared: null, even when it stages
      // client_class coding_persistent/coding_ephemeral, so the browser
      // path's event detail stays exactly what main has always written --
      // {resident_id, model} -- and never gains client_class or any
      // human-approval key it never declared.
      await resetDatabase()
      const pending = registration('browser-shape', 'browser-shape-resident')
      assert.equal((await store.stageResidentRegistration(pending))?.status, 'staged')
      assert.deepEqual(await store.confirmResidentRegistration({
        sessionHash: pending.sessionHash,
        csrfHash: pending.csrfHash,
        residentSecretHash: pending.residentSecretHash,
        jsonDoorHumanApprovalDeclared: null,
      }), { status: 'confirmed', residentId: 2, handle: 'browser-shape-resident' })
      const registerEvent = await database!.query<{ detail: Record<string, unknown> }>(
        "SELECT detail FROM events WHERE kind = 'register' AND actor = 'browser-shape-resident'",
      )
      assert.equal(registerEvent.rows.length, 1)
      const detail = registerEvent.rows[0]!.detail
      assert.deepEqual(Object.keys(detail).sort(), ['model', 'resident_id'])
      assert.equal(detail.model, 'postgres-test')
      // Neither human_approved nor json_door_human_approval_declared is
      // ever persisted anywhere but the JSON door's confirmed register
      // event's jsonb detail -- confirm no such column exists.
      assert.equal(
        (await database!.query(
          `SELECT count(*) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'pending_resident_registrations'
             AND column_name IN ('human_approved', 'json_door_human_approval_declared')`,
        )).rows[0]!.count,
        '0',
      )
    })

    await t.test('a missing world root leaves the whole registration pending and unchanged', async () => {
      await resetDatabase()
      await database!.query('DROP TRIGGER places_protect_topology_write ON places')
      await database!.query("DELETE FROM places WHERE place_kind = 'world'")
      const pending = registration('missing-world', 'unplaced-resident')
      assert.equal((await store.stageResidentRegistration(pending))?.status, 'staged')

      await assert.rejects(
        store.confirmResidentRegistration({
          sessionHash: pending.sessionHash,
          csrfHash: pending.csrfHash,
          residentSecretHash: pending.residentSecretHash,
          jsonDoorHumanApprovalDeclared: true,
        }),
        /registration confirmation produced no outcome/i,
      )

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
      assert.equal(
        (await database!.query(
          `SELECT count(*) FROM pending_resident_registration_recovery_codes
           WHERE registration_session_hash = $1`,
          [pending.sessionHash],
        )).rows[0]!.count,
        '8',
      )
    })

    await t.test('registration cancellation and expiry scrub every pending recovery hash', async () => {
      await resetDatabase()
      const canceled = registration('canceled-registration', 'canceled-registration')
      assert.equal((await store.stageResidentRegistration(canceled))?.status, 'staged')
      assert.equal(await store.cancelResidentRegistration({
        sessionHash: canceled.sessionHash,
        csrfHash: canceled.csrfHash,
      }), true)
      assert.deepEqual(await store.getResidentRegistrationProgress({
        sessionHash: canceled.sessionHash,
        csrfHash: canceled.csrfHash,
      }), { status: 'canceled' })
      assert.equal(await store.cancelResidentRegistration({
        sessionHash: canceled.sessionHash,
        csrfHash: canceled.csrfHash,
      }), false)
      await database!.query(
        `UPDATE pending_resident_registrations
         SET created_at = now() - interval '3 minutes',
             canceled_at = now() - interval '2 minutes',
             expires_at = now() - interval '1 minute'
         WHERE session_hash = $1`,
        [canceled.sessionHash],
      )
      assert.deepEqual(await store.getResidentRegistrationProgress({
        sessionHash: canceled.sessionHash,
        csrfHash: canceled.csrfHash,
      }), { status: 'canceled' })

      const expired = registration('expired-registration', 'expired-registration')
      assert.equal((await store.stageResidentRegistration(expired))?.status, 'staged')
      await database!.query(
        `UPDATE pending_resident_registrations
         SET created_at = now() - interval '16 minutes',
             expires_at = now() - interval '1 minute'
         WHERE session_hash = $1`,
        [expired.sessionHash],
      )
      assert.deepEqual(await store.getResidentRegistrationProgress({
        sessionHash: expired.sessionHash,
        csrfHash: expired.csrfHash,
      }), { status: 'expired' })
      assert.equal(
        (await store.stageResidentRegistration(registration('cleanup-trigger', 'cleanup-trigger')))?.status,
        'staged',
      )
      assert.deepEqual(await store.getResidentRegistrationProgress({
        sessionHash: expired.sessionHash,
        csrfHash: expired.csrfHash,
      }), { status: 'expired' })

      const state = await database!.query(
        `SELECT pending.session_hash, pending.handle, pending.model, pending.client_class, pending.secret_hash,
           pending.ip_hash, pending.canceled_at IS NOT NULL AS canceled,
           count(code.code_hash) AS pending_codes
         FROM pending_resident_registrations pending
         LEFT JOIN pending_resident_registration_recovery_codes code
           ON code.registration_session_hash = pending.session_hash
         WHERE pending.session_hash IN ($1, $2)
         GROUP BY pending.session_hash, pending.handle, pending.model, pending.client_class, pending.secret_hash,
           pending.ip_hash, pending.canceled_at
         ORDER BY pending.session_hash`,
        [canceled.sessionHash, expired.sessionHash],
      )
      assert.equal(state.rows.length, 2)
      for (const row of state.rows) {
        assert.deepEqual({
          handle: row.handle,
          model: row.model,
          client_class: row.client_class,
          secret_hash: row.secret_hash,
          ip_hash: row.ip_hash,
          canceled: row.canceled,
          pending_codes: row.pending_codes,
        }, {
          handle: null,
          model: null,
          client_class: null,
          secret_hash: null,
          ip_hash: null,
          canceled: true,
          pending_codes: '0',
        })
      }
      assert.deepEqual(await store.confirmResidentRegistration({
        sessionHash: canceled.sessionHash,
        csrfHash: canceled.csrfHash,
        residentSecretHash: canceled.residentSecretHash,
        jsonDoorHumanApprovalDeclared: true,
      }), { status: 'request_unavailable' })
      assert.deepEqual(await store.confirmResidentRegistration({
        sessionHash: expired.sessionHash,
        csrfHash: expired.csrfHash,
        residentSecretHash: expired.residentSecretHash,
        jsonDoorHumanApprovalDeclared: true,
      }), { status: 'request_unavailable' })
    })

    await t.test('concurrent correct and wrong confirmations preserve exact saved-key truth', async () => {
      await resetDatabase()
      const pending = registration('race-exact-key', 'race-exact-key')
      assert.equal((await store.stageResidentRegistration(pending)).status, 'staged')
      await database!.query(`
        CREATE OR REPLACE FUNCTION delay_race_registration_event() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.kind = 'register' AND NEW.actor = 'race-exact-key' THEN
            PERFORM pg_sleep(0.25);
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER delay_race_registration_event
        BEFORE INSERT ON events
        FOR EACH ROW EXECUTE FUNCTION delay_race_registration_event();
      `)

      const correct = store.confirmResidentRegistration({
        sessionHash: pending.sessionHash,
        csrfHash: pending.csrfHash,
        residentSecretHash: pending.residentSecretHash,
        jsonDoorHumanApprovalDeclared: true,
      })
      await new Promise(resolve => setTimeout(resolve, 50))
      const wrong = store.confirmResidentRegistration({
        sessionHash: pending.sessionHash,
        csrfHash: pending.csrfHash,
        residentSecretHash: sha256('wrong-racing-key'),
        jsonDoorHumanApprovalDeclared: true,
      })
      assert.deepEqual(await Promise.all([correct, wrong]), [
        { status: 'confirmed', residentId: 2, handle: 'race-exact-key' },
        { status: 'credential_rejected' },
      ])
      assert.equal((await database!.query(
        `SELECT count(*) FROM residents WHERE handle = 'race-exact-key'`,
      )).rows[0]!.count, '1')
      assert.equal((await database!.query(
        `SELECT count(*) FROM events WHERE kind = 'register' AND actor = 'race-exact-key'`,
      )).rows[0]!.count, '1')
      assert.equal((await database!.query(
        `SELECT count(*) FROM resident_recovery_codes WHERE resident_id = 2`,
      )).rows[0]!.count, '8')
    })

    await t.test('an active-code collision rolls back resident creation and keeps the pending set retryable', async () => {
      await resetDatabase()
      const pending = registration('active-code-collision', 'collision-resident')
      await database!.query('UPDATE residents SET recovery_generation = 1 WHERE id = 1')
      await database!.query(
        `INSERT INTO resident_recovery_codes (resident_id, generation, code_hash)
         VALUES (1, 1, $1)`,
        [pending.recoveryCodeHashes[3]],
      )
      assert.equal((await store.stageResidentRegistration(pending))?.status, 'staged')

      await assert.rejects(
        store.confirmResidentRegistration({
          sessionHash: pending.sessionHash,
          csrfHash: pending.csrfHash,
          residentSecretHash: pending.residentSecretHash,
          jsonDoorHumanApprovalDeclared: true,
        }),
        { code: '23505', constraint: 'resident_recovery_codes_code_hash_key' },
      )
      const state = await database!.query(
        `SELECT
           (SELECT last_id FROM resident_id_allocator WHERE singleton) AS last_id,
           (SELECT count(*) FROM residents WHERE handle = $1) AS residents,
           (SELECT count(*) FROM resident_presence WHERE resident_id <> 1) AS presences,
           (SELECT count(*) FROM events WHERE actor = $1) AS events,
           (SELECT count(*) FROM resident_recovery_codes WHERE resident_id <> 1) AS active_codes,
           (SELECT count(*) FROM pending_resident_registration_recovery_codes
             WHERE registration_session_hash = $2) AS pending_codes,
           (SELECT secret_hash FROM pending_resident_registrations
             WHERE session_hash = $2) AS pending_secret_hash`,
        [pending.handle, pending.sessionHash],
      )
      assert.deepEqual(state.rows, [{
        last_id: 1,
        residents: '0',
        presences: '0',
        events: '0',
        active_codes: '0',
        pending_codes: '8',
        pending_secret_hash: pending.residentSecretHash,
      }])
    })

    await t.test('a downstream event failure rolls the allocator, resident, presence, and initial codes back', async () => {
      await resetDatabase()
      const pending = registration('event-rollback', 'event-rollback')
      assert.equal((await store.stageResidentRegistration(pending))?.status, 'staged')
      await database!.query(`
        CREATE FUNCTION fail_registration_event() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.kind = 'register' AND NEW.actor = 'event-rollback' THEN
            RAISE EXCEPTION 'injected registration event failure';
          END IF;
          RETURN NEW;
        END
        $$;
        CREATE TRIGGER events_fail_registration
          BEFORE INSERT ON events
          FOR EACH ROW EXECUTE FUNCTION fail_registration_event();
      `)

      await assert.rejects(
        store.confirmResidentRegistration({
          sessionHash: pending.sessionHash,
          csrfHash: pending.csrfHash,
          residentSecretHash: pending.residentSecretHash,
          jsonDoorHumanApprovalDeclared: true,
        }),
        /injected registration event failure/i,
      )
      const state = await database!.query(
        `SELECT
           (SELECT last_id FROM resident_id_allocator WHERE singleton) AS last_id,
           (SELECT count(*) FROM residents WHERE handle = $1) AS residents,
           (SELECT count(*) FROM resident_presence WHERE resident_id <> 1) AS presences,
           (SELECT count(*) FROM events WHERE actor = $1) AS events,
           (SELECT count(*) FROM resident_recovery_codes WHERE resident_id <> 1) AS active_codes,
           (SELECT count(*) FROM pending_resident_registration_recovery_codes
             WHERE registration_session_hash = $2) AS pending_codes`,
        [pending.handle, pending.sessionHash],
      )
      assert.deepEqual(state.rows, [{
        last_id: 1, residents: '0', presences: '0', events: '0',
        active_codes: '0', pending_codes: '8',
      }])
    })

    await t.test('two pending claims for one handle have one confirmed and one handle-taken outcome', async () => {
      await resetDatabase()
      const first = registration('race-first', 'raced-name')
      const second = registration('race-second', 'raced-name')
      assert.equal((await store.stageResidentRegistration(first))?.status, 'staged')
      assert.equal((await store.stageResidentRegistration(second))?.status, 'staged')
      const results = await Promise.all([
        store.confirmResidentRegistration({
          sessionHash: first.sessionHash, csrfHash: first.csrfHash,
          residentSecretHash: first.residentSecretHash,
          jsonDoorHumanApprovalDeclared: true,
        }),
        store.confirmResidentRegistration({
          sessionHash: second.sessionHash, csrfHash: second.csrfHash,
          residentSecretHash: second.residentSecretHash,
          jsonDoorHumanApprovalDeclared: true,
        }),
      ])
      assert.equal(results.filter(result => result.status === 'confirmed').length, 1)
      assert.equal(results.filter(result => result.status === 'handle_taken').length, 1)
      assert.equal((await database!.query("SELECT count(*) FROM residents WHERE handle = 'raced-name'")).rows[0]!.count, '1')
      assert.equal((await database!.query("SELECT count(*) FROM events WHERE actor = 'raced-name'")).rows[0]!.count, '1')
      assert.equal((await database!.query('SELECT last_id FROM resident_id_allocator WHERE singleton')).rows[0]!.last_id, 2)
      const winner = results[0].status === 'confirmed' ? first : second
      const loser = results[0].status === 'confirmed' ? second : first
      const codes = await database!.query(
        `SELECT
           (SELECT count(*) FROM resident_recovery_codes code
             JOIN residents resident ON resident.id = code.resident_id
             WHERE resident.handle = 'raced-name' AND code.generation = 1
               AND code.used_at IS NULL AND code.invalidated_at IS NULL) AS active_codes,
           (SELECT count(*) FROM pending_resident_registration_recovery_codes
             WHERE registration_session_hash = $1) AS winner_pending_codes,
           (SELECT count(*) FROM pending_resident_registration_recovery_codes
             WHERE registration_session_hash = $2) AS loser_pending_codes`,
        [winner.sessionHash, loser.sessionHash],
      )
      assert.deepEqual(codes.rows, [{
        active_codes: '8', winner_pending_codes: '0', loser_pending_codes: '0',
      }])
      assert.deepEqual(await store.getResidentRegistrationProgress({
        sessionHash: loser.sessionHash,
        csrfHash: loser.csrfHash,
      }), { status: 'canceled' })
    })

    await t.test('a cancel waiting behind confirmation reports that it lost', async () => {
      await resetDatabase()
      const pending = registration('cancel-confirm-race', 'cancel-confirm-race')
      assert.equal((await store.stageResidentRegistration(pending)).status, 'staged')
      await database!.query(`
        CREATE OR REPLACE FUNCTION delay_cancel_race_event() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.kind = 'register' AND NEW.actor = 'cancel-confirm-race' THEN
            PERFORM pg_sleep(0.25);
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER delay_cancel_race_event
        BEFORE INSERT ON events
        FOR EACH ROW EXECUTE FUNCTION delay_cancel_race_event();
      `)

      const confirmation = store.confirmResidentRegistration({
        sessionHash: pending.sessionHash,
        csrfHash: pending.csrfHash,
        residentSecretHash: pending.residentSecretHash,
        jsonDoorHumanApprovalDeclared: true,
      })
      await new Promise(resolve => setTimeout(resolve, 25))
      const cancellation = store.cancelResidentRegistration({
        sessionHash: pending.sessionHash,
        csrfHash: pending.csrfHash,
      })
      assert.deepEqual(await confirmation, {
        status: 'confirmed', residentId: 2, handle: pending.handle,
      })
      assert.equal(await cancellation, false)
      assert.deepEqual(await store.getResidentRegistrationProgress({
        sessionHash: pending.sessionHash,
        csrfHash: pending.csrfHash,
      }), {
        status: 'confirmed', residentId: 2, handle: pending.handle,
      })
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
      assert.deepEqual(await store.stageRootRecovery(stage), {
        status: 'staged', handle: 'existing-agent',
      })
      assert.deepEqual(await store.confirmRootRecovery({
        sessionHash: stage.sessionHash,
        csrfHash: stage.csrfHash,
        replacementSecretHash: sha256('wrong-replacement'),
        invalidatePairingCodes: true,
      }), { status: 'credential_rejected' })
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
      // A pairing code minted under the pre-recovery key must not survive
      // recovery when invalidatePairingCodes is true.
      await database!.query(
        `INSERT INTO pairing_codes (resident_id, code_hash, secret_hash_at_mint, expires_at)
         VALUES (1, $1, $2, now() + interval '9 minutes')`,
        [sha256('winner:pairing-code'), sha256('existing-root-key')],
      )
      const first = {
        sessionHash: sha256('winner:first-session'), csrfHash: sha256('winner:first-csrf'),
        recoveryCodeHash: sha256(codes[0]!), replacementSecretHash: sha256('replacement-one'),
      }
      const second = {
        sessionHash: sha256('winner:second-session'), csrfHash: sha256('winner:second-csrf'),
        recoveryCodeHash: sha256(codes[1]!), replacementSecretHash: sha256('replacement-two'),
      }
      assert.equal((await store.stageRootRecovery(first)).status, 'staged')
      assert.equal((await store.stageRootRecovery(second)).status, 'staged')
      const results = await Promise.all([
        store.confirmRootRecovery({
          sessionHash: first.sessionHash, csrfHash: first.csrfHash,
          replacementSecretHash: first.replacementSecretHash,
          invalidatePairingCodes: true,
        }),
        store.confirmRootRecovery({
          sessionHash: second.sessionHash, csrfHash: second.csrfHash,
          replacementSecretHash: second.replacementSecretHash,
          invalidatePairingCodes: true,
        }),
      ])
      assert.equal(results.filter(result => result.status === 'recovered').length, 1)
      assert.equal(results.filter(result => result.status === 'request_unavailable').length, 1)
      const winner = results[0].status === 'recovered' ? first : second
      const state = await database!.query(
        `SELECT
           (SELECT secret_hash FROM residents WHERE id = 1) AS secret_hash,
           (SELECT recovery_generation FROM residents WHERE id = 1) AS generation,
           (SELECT count(*) FROM resident_recovery_codes WHERE used_at IS NOT NULL) AS used,
           (SELECT count(*) FROM resident_recovery_codes WHERE invalidated_at IS NOT NULL) AS invalidated,
           (SELECT count(*) FROM oauth_token_families WHERE revoked_at IS NOT NULL) AS revoked_families,
           (SELECT count(*) FROM oauth_tokens WHERE revoked_at IS NOT NULL) AS revoked_tokens,
           (SELECT count(*) FROM events WHERE kind = 'rotate' AND actor = 'existing-agent') AS rotate_events,
           (SELECT invalidated_at IS NOT NULL FROM pairing_codes WHERE resident_id = 1) AS pairing_code_invalidated`,
      )
      assert.deepEqual(state.rows[0], {
        secret_hash: winner.replacementSecretHash,
        generation: '2', used: '1', invalidated: '7',
        revoked_families: '2', revoked_tokens: '2', rotate_events: '1',
        pairing_code_invalidated: true,
      })

      const usedCode = await store.stageRootRecovery({
        sessionHash: sha256('used-code:session'),
        csrfHash: sha256('used-code:csrf'),
        recoveryCodeHash: winner.recoveryCodeHash,
        replacementSecretHash: sha256('used-code:replacement'),
      })
      const unknownCode = await store.stageRootRecovery({
        sessionHash: sha256('unknown-code:session'),
        csrfHash: sha256('unknown-code:csrf'),
        recoveryCodeHash: sha256('unknown-code'),
        replacementSecretHash: sha256('unknown-code:replacement'),
      })
      assert.deepEqual(usedCode, { status: 'credential_rejected' })
      assert.deepEqual(unknownCode, usedCode)
    })

    await t.test('root rotation stages hashes only and cancel or expiry preserves the old key', async () => {
      await resetDatabase()
      const canceled = rotation('rotation-cancel')
      assert.deepEqual(await store.stageRootRotation(canceled), {
        status: 'staged', residentId: 1, handle: 'existing-agent',
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
      assert.deepEqual(await store.confirmRootRotation({
        sessionHash: canceled.sessionHash,
        csrfHash: canceled.csrfHash,
        replacementSecretHash: sha256('wrong-replacement'),
        invalidatePairingCodes: true,
      }), { status: 'credential_rejected' })
      assert.equal(await store.cancelRootRotation(canceled), true)

      const expired = rotation('rotation-expired')
      assert.equal((await store.stageRootRotation(expired)).status, 'staged')
      await database!.query(
        `UPDATE resident_key_rotations
         SET created_at = now() - interval '20 minutes',
             expires_at = now() - interval '5 minutes'
         WHERE session_hash = $1`,
        [expired.sessionHash],
      )
      assert.deepEqual(await store.confirmRootRotation({
        sessionHash: expired.sessionHash,
        csrfHash: expired.csrfHash,
        replacementSecretHash: expired.replacementSecretHash,
        invalidatePairingCodes: true,
      }), { status: 'request_unavailable' })
      assert.equal((await store.stageRootRotation(rotation('rotation-cleanup'))).status, 'staged')

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

      // A pairing code minted under the pre-rotation key must not survive
      // rotation for its own resident, but a different resident's pairing
      // code must be untouched.
      await database!.query(
        `INSERT INTO pairing_codes (resident_id, code_hash, secret_hash_at_mint, expires_at)
         VALUES
           (1, $1, $2, now() + interval '9 minutes'),
           (2, $3, $4, now() + interval '9 minutes')`,
        [
          sha256('rotation-winner:pairing-code'), sha256('existing-root-key'),
          sha256('rotation-winner:unrelated-pairing-code'), sha256('unrelated-root-key'),
        ],
      )

      const first = rotation('rotation-first')
      const second = rotation('rotation-second')
      assert.equal((await store.stageRootRotation(first)).status, 'staged')
      assert.equal((await store.stageRootRotation(second)).status, 'staged')
      const rotationResults = await Promise.all([
        store.confirmRootRotation({
          sessionHash: first.sessionHash,
          csrfHash: first.csrfHash,
          replacementSecretHash: first.replacementSecretHash,
          invalidatePairingCodes: true,
        }),
        store.confirmRootRotation({
          sessionHash: second.sessionHash,
          csrfHash: second.csrfHash,
          replacementSecretHash: second.replacementSecretHash,
          invalidatePairingCodes: true,
        }),
      ])
      assert.equal(rotationResults.filter(result => result?.status === 'rotated').length, 1)
      assert.equal(
        rotationResults.filter(result => result.status === 'request_unavailable').length,
        1,
      )
      const rotationWinner = rotationResults[0]?.status === 'rotated' ? first : second
      const oldKey = await store.stageRootRotation(rotation(
        'old-key-rejected', 'existing-root-key', 'unused-replacement',
      ))
      const unknownKey = await store.stageRootRotation(rotation(
        'unknown-key-rejected', 'never-issued-root-key', 'other-unused-replacement',
      ))
      assert.deepEqual(oldKey, { status: 'credential_rejected' })
      assert.deepEqual(unknownKey, oldKey)

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
             WHERE kind = 'rotate' AND actor = 'existing-agent') AS rotate_events,
           (SELECT invalidated_at IS NOT NULL FROM pairing_codes WHERE resident_id = 1)
             AS resident_pairing_code_invalidated,
           (SELECT invalidated_at IS NOT NULL FROM pairing_codes WHERE resident_id = 2)
             AS unrelated_pairing_code_invalidated`,
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
        resident_pairing_code_invalidated: true,
        unrelated_pairing_code_invalidated: false,
        rotate_events: '1',
      })
      assert.equal(recoveryCodes.length, 8)
    })

    await t.test('invalidatePairingCodes false leaves a resident\'s pairing code untouched even after rotation and recovery succeed', async () => {
      // Decision row 74 security fix: CODING_IDENTITY_DOORS_ENABLED off (the
      // default) means identity-browser.ts passes invalidatePairingCodes:
      // false to both confirmRootRotation and confirmRootRecovery. This
      // must never fail the rotation or recovery itself, and must leave any
      // pairing code exactly as it was -- the redundant secret_hash_at_mint
      // recheck at redemption (oauth-store.ts) is what keeps this fail-closed.
      await resetDatabase()
      await database!.query(
        `INSERT INTO pairing_codes (resident_id, code_hash, secret_hash_at_mint, expires_at)
         VALUES (1, $1, $2, now() + interval '9 minutes')`,
        [sha256('untouched:pairing-code'), sha256('existing-root-key')],
      )
      const staged = rotation('untouched-rotation')
      assert.equal((await store.stageRootRotation(staged)).status, 'staged')
      assert.deepEqual(await store.confirmRootRotation({
        sessionHash: staged.sessionHash,
        csrfHash: staged.csrfHash,
        replacementSecretHash: staged.replacementSecretHash,
        invalidatePairingCodes: false,
      }), { status: 'rotated', residentId: 1, handle: 'existing-agent' })
      const afterRotation = await database!.query(
        `SELECT invalidated_at IS NOT NULL AS invalidated FROM pairing_codes WHERE resident_id = 1`,
      )
      assert.deepEqual(afterRotation.rows, [{ invalidated: false }])

      // Insert a fresh recovery code directly at resident 1's post-rotation
      // recovery_generation (rotation already invalidated the original set).
      await database!.query(
        `INSERT INTO resident_recovery_codes (resident_id, generation, code_hash)
         SELECT id, recovery_generation, $1 FROM residents WHERE id = 1`,
        [sha256('untouched-recovery-code')],
      )
      const stagedRecovery = await store.stageRootRecovery({
        sessionHash: sha256('untouched-recovery:session'),
        csrfHash: sha256('untouched-recovery:csrf'),
        recoveryCodeHash: sha256('untouched-recovery-code'),
        replacementSecretHash: sha256('untouched-recovery:replacement'),
      })
      assert.equal(stagedRecovery.status, 'staged')
      assert.deepEqual(await store.confirmRootRecovery({
        sessionHash: sha256('untouched-recovery:session'),
        csrfHash: sha256('untouched-recovery:csrf'),
        replacementSecretHash: sha256('untouched-recovery:replacement'),
        invalidatePairingCodes: false,
      }), { status: 'recovered', residentId: 1, handle: 'existing-agent' })
      const afterRecovery = await database!.query(
        `SELECT invalidated_at IS NOT NULL AS invalidated FROM pairing_codes WHERE resident_id = 1`,
      )
      assert.deepEqual(afterRecovery.rows, [{ invalidated: false }])
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
      assert.equal((await store.stageRootRecovery(recovery)).status, 'staged')
      assert.equal((await store.stageRootRotation(rootRotation)).status, 'staged')
      const recoveryRace = await Promise.all([
        store.confirmRootRecovery({
          sessionHash: recovery.sessionHash,
          csrfHash: recovery.csrfHash,
          replacementSecretHash: recovery.replacementSecretHash,
          invalidatePairingCodes: true,
        }),
        store.confirmRootRotation({
          sessionHash: rootRotation.sessionHash,
          csrfHash: rootRotation.csrfHash,
          replacementSecretHash: rootRotation.replacementSecretHash,
          invalidatePairingCodes: true,
        }),
      ])
      assert.deepEqual(recoveryRace[0], {
        status: 'recovered', residentId: 1, handle: 'existing-agent',
      })
      assert.deepEqual(recoveryRace[1], { status: 'request_unavailable' })
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
      assert.equal((await store.stageRootRecovery(otherRecovery)).status, 'staged')
      assert.equal((await store.stageRootRotation(otherRotation)).status, 'staged')
      assert.equal((await store.confirmRootRotation({
        sessionHash: otherRotation.sessionHash,
        csrfHash: otherRotation.csrfHash,
        replacementSecretHash: otherRotation.replacementSecretHash,
        invalidatePairingCodes: true,
      }))?.status, 'rotated')
      assert.deepEqual(await store.confirmRootRecovery({
        sessionHash: otherRecovery.sessionHash,
        csrfHash: otherRecovery.csrfHash,
        replacementSecretHash: otherRecovery.replacementSecretHash,
        invalidatePairingCodes: true,
      }), { status: 'request_unavailable' })
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
        assert.equal((await store.stageRootRotation(intent)).status, 'staged')
        assert.equal((await store.confirmRootRotation({
          sessionHash: intent.sessionHash,
          csrfHash: intent.csrfHash,
          replacementSecretHash: intent.replacementSecretHash,
          invalidatePairingCodes: true,
        }))?.status, 'rotated')
        currentSecret = nextSecret
      }
      const limited = rotation('daily-limited', currentSecret, 'daily-rejected')
      assert.equal((await store.stageRootRotation(limited)).status, 'staged')
      assert.deepEqual(await store.confirmRootRotation({
        sessionHash: limited.sessionHash,
        csrfHash: limited.csrfHash,
        replacementSecretHash: limited.replacementSecretHash,
        invalidatePairingCodes: true,
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
