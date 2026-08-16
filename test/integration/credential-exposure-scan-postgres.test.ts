import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from 'pg'
import {
  LOCAL_SCAN_ACKNOWLEDGEMENT,
  runCredentialExposureScan,
} from '../../scripts/credential-exposure-scan.ts'
import { POSTGRES_TOOL_IMAGE } from '../../scripts/backup.ts'

const DATABASE = 'credential_scan_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

function docker(args: readonly string[], allowFailure = false): string {
  const result = spawnSync('docker', [...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  })
  if (!allowFailure && result.status !== 0) {
    throw new Error(`Docker credential-scan fixture failed: ${result.status ?? 'unknown'}`)
  }
  return result.stdout.trim()
}

async function waitForPostgres(port: number, password: string): Promise<Client> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const client = new Client({
      host: '127.0.0.1', port, user: 'postgres', password, database: DATABASE, ssl: false,
    })
    try {
      await client.connect()
      return client
    } catch {
      await client.end().catch(() => {})
      await delay(200)
    }
  }
  throw new Error('PostgreSQL credential-scan fixture did not become ready')
}

async function fixtureSnapshot(database: Client, placeId: number) {
  const statements = Object.freeze({
    residents: 'SELECT * FROM public.residents WHERE id BETWEEN 7 AND 16 ORDER BY id',
    places: 'SELECT * FROM public.places WHERE id = $1 ORDER BY id',
    notes: 'SELECT * FROM public.notes WHERE place_id = $1 ORDER BY id',
    things: 'SELECT * FROM public.things WHERE place_id = $1 ORDER BY id',
    agreements: 'SELECT * FROM public.agreements WHERE created_by_id = 7 ORDER BY id',
    authorizationRequests:
      'SELECT * FROM public.oauth_authorization_requests WHERE resident_id IN (12, 16) ORDER BY id',
    authorizationCodes:
      'SELECT * FROM public.oauth_authorization_codes WHERE resident_id IN (12, 16) ORDER BY id',
    tokenFamilies:
      'SELECT * FROM public.oauth_token_families WHERE resident_id IN (10, 11, 13, 14, 15) ORDER BY id',
    tokens: `SELECT token.* FROM public.oauth_tokens token
      JOIN public.oauth_token_families family ON family.id = token.family_id
      WHERE family.resident_id IN (10, 11, 13, 14, 15) ORDER BY token.id`,
  })
  let entries: readonly (readonly [string, readonly Record<string, unknown>[]])[] = Object.freeze([])
  for (const [name, statement] of Object.entries(statements)) {
    const values = /\$1/.test(statement) ? [placeId] : []
    const entry = Object.freeze([name, (await database.query(statement, values)).rows] as const)
    entries = Object.freeze([...entries, entry])
  }
  return Object.freeze(Object.fromEntries(entries))
}

test('a real PostgreSQL scan is read-only and returns only associated resident IDs', async t => {
  const runId = `${process.pid}-${randomBytes(6).toString('hex')}`
  const container = `1f3d9-credential-scan-${runId}`
  const password = randomBytes(24).toString('hex')
  let database: Client | undefined
  t.after(async () => {
    await database?.end().catch(() => {})
    docker(['rm', '--force', container], true)
  })

  docker([
    'run', '--detach', '--name', container,
    '--label', `com.1f3d9.test=${runId}`,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', `POSTGRES_DB=${DATABASE}`,
    POSTGRES_TOOL_IMAGE,
  ])
  const portText = docker(['port', container, '5432/tcp'])
  const port = Number(portText.match(/:(\d+)\s*$/)?.[1])
  assert.ok(Number.isSafeInteger(port) && port > 0)

  database = await waitForPostgres(port, password)
  await database.query(schemaDdl)
  const rootKey = `1f3d9_sk_${'d5'.repeat(24)}`
  const accessLive = `1f3d9_at_${'a1'.repeat(32)}`
  const accessRevoked = `1f3d9_at_${'a2'.repeat(32)}`
  const refreshLive = `1f3d9_rt_${'b1'.repeat(32)}`
  const refreshUsed = `1f3d9_rt_${'b2'.repeat(32)}`
  const refreshExpiredFamily = `1f3d9_rt_${'b3'.repeat(32)}`
  const authorizationLive = `1f3d9_ac_${'c1'.repeat(32)}`
  const authorizationUsed = `1f3d9_ac_${'c2'.repeat(32)}`
  const partial = `1f3d9_at_${'f7'.repeat(6)}`
  const residents = Array.from({ length: 10 }, (_, index) => {
    const id = index + 7
    return Object.freeze({
      id,
      handle: `scan-resident-${id}`,
      model: 'safe model',
      secret_hash: id === 9 ? sha256(rootKey) : sha256(`scan-resident-${id}-key`),
    })
  })
  await database.query(`
    INSERT INTO residents (id, handle, model, secret_hash)
    SELECT value.id, value.handle, value.model, value.secret_hash
    FROM jsonb_to_recordset($1::jsonb) AS value(
      id integer, handle text, model text, secret_hash text
    )
  `, [JSON.stringify(residents)])
  const place = await database.query<{ id: number }>(`
    INSERT INTO places (
      parent_id, place_kind, name, description, owner_id,
      open_to_building, open_to_things, open_to_notes
    )
    SELECT id, 'continent', 'scan-fixture', $1, 7, false, false, false
    FROM places WHERE place_kind = 'world'
    RETURNING id
  `, [`historical ${refreshUsed} and ${refreshExpiredFamily}`])
  const placeId = place.rows[0]?.id
  assert.ok(placeId)
  await database.query('UPDATE places SET owner_id = 8 WHERE id = $1', [placeId])
  await database.query('INSERT INTO notes (place_id, author_id, body) VALUES ($1, 7, $2)', [
    placeId, `historical ${rootKey} and ${accessLive}`,
  ])
  await database.query(`
    INSERT INTO things (place_id, name, body, owner_id)
    VALUES ($1, 'scan-object', $2, 7)
  `, [placeId, `historical ${refreshLive} and ${accessRevoked}`])
  await database.query('UPDATE things SET owner_id = 8 WHERE place_id = $1', [placeId])
  await database.query('INSERT INTO agreements (created_by_id, body) VALUES (7, $1)', [
    `historical partial ${partial}`,
  ])
  await database.query('UPDATE residents SET model = $1 WHERE id = 7', [authorizationLive])
  await database.query('UPDATE residents SET model = $1 WHERE id = 8', [authorizationUsed])

  const families = await database.query<{ id: string; resident_id: number }>(`
    INSERT INTO oauth_token_families (
      resident_id, client_id, resource, scope, expires_at, revoked_at, revoke_reason, created_at
    ) VALUES
      (10, 'integration-client', 'https://1f3d9.com/mcp/connect', 'city:resident',
        now() + interval '1 day', NULL, NULL, now()),
      (11, 'integration-client', 'https://1f3d9.com/mcp/connect', 'city:resident',
        now() + interval '1 day', NULL, NULL, now()),
      (13, 'integration-client', 'https://1f3d9.com/mcp/connect', 'city:resident',
        now() + interval '1 day', NULL, NULL, now()),
      (14, 'integration-client', 'https://1f3d9.com/mcp/connect', 'city:resident',
        now() + interval '1 day', NULL, NULL, now()),
      (15, 'integration-client', 'https://1f3d9.com/mcp/connect', 'city:resident',
        now() - interval '1 day', NULL, NULL, now() - interval '2 days')
    RETURNING id, resident_id
  `)
  const familyId = (residentId: number) => {
    const id = families.rows.find(row => row.resident_id === residentId)?.id
    assert.ok(id)
    return id
  }
  await database.query(`
    INSERT INTO oauth_tokens (
      token_hash, token_type, family_id, expires_at, used_at, revoked_at
    ) VALUES
      ($1, 'refresh', $2, now() + interval '1 day', NULL, NULL),
      ($3, 'access', $4, now() + interval '9 minutes', NULL, NULL),
      ($5, 'access', $6, now() + interval '9 minutes', NULL, now()),
      ($7, 'refresh', $8, now() + interval '1 day', now(), NULL),
      ($9, 'refresh', $10, now() + interval '1 day', NULL, NULL)
  `, [
    sha256(refreshLive), familyId(10),
    sha256(accessLive), familyId(11),
    sha256(accessRevoked), familyId(13),
    sha256(refreshUsed), familyId(14),
    sha256(refreshExpiredFamily), familyId(15),
  ])

  for (const [residentId, code, used] of [
    [12, authorizationLive, false],
    [16, authorizationUsed, true],
  ] as const) {
    const request = await database.query<{ id: string }>(`
      INSERT INTO oauth_authorization_requests (
        session_hash, csrf_hash, client_id, client_display_name, redirect_uri,
        resource, scope, state, code_challenge, code_challenge_method,
        intent, resident_id, verified_at, approved_at, expires_at
      ) VALUES (
        $1, $2, 'integration-client', 'Integration client', 'https://client.invalid/callback',
        'https://1f3d9.com/mcp/connect', 'city:resident', $3, $4, 'S256',
        'existing', $5, now(), now(), now() + interval '10 minutes'
      ) RETURNING id
    `, [
      sha256(`session-${residentId}`), sha256(`csrf-${residentId}`),
      `state-${residentId}`, residentId === 12 ? 'A'.repeat(43) : 'B'.repeat(43), residentId,
    ])
    await database.query(`
      INSERT INTO oauth_authorization_codes (
        request_id, code_hash, resident_id, client_id, redirect_uri,
        resource, scope, code_challenge, code_challenge_method, expires_at, used_at
      ) VALUES (
        $1, $2, $3, 'integration-client', 'https://client.invalid/callback',
        'https://1f3d9.com/mcp/connect', 'city:resident', $4, 'S256',
        now() + interval '4 minutes', CASE WHEN $5::boolean THEN now() ELSE NULL END
      )
    `, [
      request.rows[0]?.id, sha256(code), residentId,
      residentId === 12 ? 'A'.repeat(43) : 'B'.repeat(43), used,
    ])
  }

  const before = await fixtureSnapshot(database, placeId)
  const logs: string[] = []
  const databaseUrl = `postgres://postgres:${password}@127.0.0.1:${port}/${DATABASE}`
  const result = await runCredentialExposureScan({
    argv: ['--target', 'local', '--database', DATABASE],
    environment: {
      CONFIRM_LOCAL_CREDENTIAL_SCAN: LOCAL_SCAN_ACKNOWLEDGEMENT,
      LOCAL_DATABASE_URL_UNPOOLED: databaseUrl,
    },
    log: line => logs.push(line),
  })
  const after = await fixtureSnapshot(database, placeId)

  assert.deepEqual(result.associated_resident_ids, [7, 8])
  assert.deepEqual(result.credential_owner_resident_ids, [9, 10, 11, 12, 13, 14, 15, 16])
  assert.deepEqual(result.live_credential_owner_resident_ids, [9, 10, 11, 12])
  assert.deepEqual(result.counts, {
    public_fields: 6,
    exact_credentials: 8,
    partial_shapes: 1,
    live_credentials: 4,
    inactive_credentials: 4,
    unresolved_credentials: 0,
    resident_key: 1,
    oauth_access_token: 2,
    oauth_refresh_token: 3,
    oauth_authorization_code: 2,
  })
  assert.deepEqual(after, before)

  const publicOutput = JSON.stringify({ result, logs })
  for (const forbidden of [
    rootKey, accessLive, accessRevoked, refreshLive, refreshUsed, refreshExpiredFamily,
    authorizationLive, authorizationUsed, partial, password, 'postgres://',
  ]) {
    assert.equal(publicOutput.includes(forbidden), false)
  }
})
