// Decision row 74 security fix: with CODING_IDENTITY_DOORS_ENABLED off (the
// default), every path reachable through the already-live browser identity
// pages -- /join, /rotate, /recovery -- must run byte-for-byte the same as
// main against the CURRENT production schema, with no new column, table, or
// constraint required. This test proves that against a real PostgreSQL
// database built from main's own db/schema.sql (commit 0b38d98, captured
// before this branch's db/migrations/20260902_identity_json_doors.sql
// existed) -- never this branch's schema.sql, which already carries that
// migration's additions.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { gunzipSync } from 'node:zlib'
import { Client, Pool } from 'pg'

type IdentityStore = typeof import('../../src/identity-store.ts')

const POSTGRES_IMAGE =
  'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'identity_flag_off_integration'
const PRE_IDENTITY_DOORS_SCHEMA_COMMIT = '0b38d98328f8af1d3e82c184030cea147262d4fc'
const PRE_IDENTITY_DOORS_SCHEMA_SHA256 =
  '1112e30352904fa7e74702fadb6770ca518bcab3cb31498320e9abcc7b7448f9'
const preIdentityDoorsSchemaDdl = gunzipSync(Buffer.from((await readFile(
  new URL('../fixtures/production-pre-identity-doors-schema-0b38d98.sql.gz.base64', import.meta.url),
  'utf8',
)).replace(/\s/gu, ''), 'base64')).toString('utf8')

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
  const containerName = `1f3d9-identity-flag-off-${process.pid}-${randomBytes(4).toString('hex')}`
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

test('the browser join, rotate, and recovery flows run unchanged with the flag off on the current production schema', async t => {
  assert.equal(
    createHash('sha256').update(preIdentityDoorsSchemaDdl).digest('hex'),
    PRE_IDENTITY_DOORS_SCHEMA_SHA256,
    `fixture must remain the exact db/schema.sql from ${PRE_IDENTITY_DOORS_SCHEMA_COMMIT}`,
  )
  assert.doesNotMatch(
    preIdentityDoorsSchemaDdl,
    /human_approved|pairing_codes|pair_mint/u,
    'the production baseline must not already carry decision 74\'s additions',
  )

  const postgres = await startPostgres()
  database = postgres.client
  t.after(async () => {
    await database?.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  })

  await database.query(preIdentityDoorsSchemaDdl)
  await database.query(
    `INSERT INTO residents (id, handle, model, secret_hash)
     VALUES (1, 'existing-agent', 'integration-test', $1)`,
    [sha256('existing-root-key')],
  )
  await database.query('UPDATE resident_id_allocator SET last_id = 1 WHERE singleton')

  const store = await import('../../src/identity-store.ts')

  await t.test('registration succeeds and records an event detail byte-identical to main\'s shape, with no pairing_codes, human_approved, or json_door_human_approval_declared column ever referenced', async () => {
    const sessionHash = sha256('flag-off-join:session')
    const csrfHash = sha256('flag-off-join:csrf')
    const recoveryCodeHashes = Array.from(
      { length: 8 },
      (_, index) => sha256(`flag-off-join:recovery:${index}`),
    )
    const staged = await store.stageResidentRegistration({
      sessionHash,
      csrfHash,
      ipHash: sha256('flag-off-join:ip'),
      handle: 'flag-off-resident',
      model: 'flag-off-test',
      clientClass: 'hosted_browser',
      residentSecretHash: sha256('flag-off-join:root-key'),
      recoveryCodeHashes,
    })
    assert.deepEqual(staged, { status: 'staged', handle: 'flag-off-resident' })

    const confirmed = await store.confirmResidentRegistration({
      sessionHash,
      csrfHash,
      residentSecretHash: sha256('flag-off-join:root-key'),
      // Exactly what identity-browser.ts's /join page always passes.
      jsonDoorHumanApprovalDeclared: null,
    })
    assert.deepEqual(confirmed, { status: 'confirmed', residentId: 2, handle: 'flag-off-resident' })

    const event = await database!.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM events WHERE kind = 'register' AND actor = 'flag-off-resident'`,
    )
    assert.equal(event.rows.length, 1)
    // main's confirmResidentRegistration has only ever written
    // {resident_id, model} into this event's jsonb detail; the browser
    // /join path must keep writing exactly that shape, with no
    // client_class, human_approved, or json_door_human_approval_declared
    // key added just because decision row 74's JSON door now exists.
    const detail = event.rows[0]!.detail
    assert.deepEqual(Object.keys(detail).sort(), ['model', 'resident_id'])
    assert.equal(detail.model, 'flag-off-test')
  })

  await t.test('voluntary rotation succeeds with invalidatePairingCodes false and never references pairing_codes', async () => {
    const sessionHash = sha256('flag-off-rotate:session')
    const csrfHash = sha256('flag-off-rotate:csrf')
    const staged = await store.stageRootRotation({
      sessionHash,
      csrfHash,
      residentSecretHash: sha256('existing-root-key'),
      replacementSecretHash: sha256('flag-off-rotate:replacement-key'),
    })
    assert.equal(staged.status, 'staged')

    const confirmed = await store.confirmRootRotation({
      sessionHash,
      csrfHash,
      replacementSecretHash: sha256('flag-off-rotate:replacement-key'),
      // Exactly what identity-browser.ts's /rotate page passes when
      // CODING_IDENTITY_DOORS_ENABLED is off.
      invalidatePairingCodes: false,
    })
    assert.deepEqual(confirmed, { status: 'rotated', residentId: 1, handle: 'existing-agent' })
  })

  await t.test('lost-key recovery succeeds with invalidatePairingCodes false and never references pairing_codes', async () => {
    const codes = Array.from({ length: 8 }, (_, index) => `flag-off-recovery:${index}`)
    const generated = await store.generateRecoveryCodes({
      residentSecretHash: sha256('flag-off-rotate:replacement-key'),
      codeHashes: codes.map(sha256),
    })
    assert.ok(generated)

    const sessionHash = sha256('flag-off-recovery:session')
    const csrfHash = sha256('flag-off-recovery:csrf')
    const staged = await store.stageRootRecovery({
      sessionHash,
      csrfHash,
      recoveryCodeHash: sha256(codes[0]!),
      replacementSecretHash: sha256('flag-off-recovery:replacement-key'),
    })
    assert.equal(staged.status, 'staged')

    const confirmed = await store.confirmRootRecovery({
      sessionHash,
      csrfHash,
      replacementSecretHash: sha256('flag-off-recovery:replacement-key'),
      // Exactly what identity-browser.ts's /recovery page passes when
      // CODING_IDENTITY_DOORS_ENABLED is off.
      invalidatePairingCodes: false,
    })
    assert.deepEqual(confirmed, { status: 'recovered', residentId: 1, handle: 'existing-agent' })
  })

  const stillMissing = await database.query(
    `SELECT to_regclass('pairing_codes') AS pairing_codes,
       (SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'pending_resident_registrations'
          AND column_name = 'human_approved') AS human_approved_column`,
  )
  assert.deepEqual(stillMissing.rows, [{ pairing_codes: null, human_approved_column: '0' }])
})
