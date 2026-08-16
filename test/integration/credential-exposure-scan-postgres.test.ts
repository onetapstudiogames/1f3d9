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

test('a real PostgreSQL scan is read-only and returns only affected resident IDs', async t => {
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
  const refreshToken = `1f3d9_rt_${'e6'.repeat(32)}`
  const partial = `1f3d9_at_${'f7'.repeat(6)}`
  await database.query(`
    INSERT INTO residents (id, handle, model, secret_hash) VALUES
      (7, 'publisher-seven', 'safe model', $1),
      (8, 'publisher-eight', 'safe model', $2),
      (9, 'credential-owner', 'safe model', $3),
      (10, 'delegated-owner', 'safe model', $4);
  `, [sha256('publisher-seven-key'), sha256('publisher-eight-key'), sha256(rootKey), sha256('owner-ten-key')])
  const place = await database.query<{ id: number }>(`
    INSERT INTO places (
      parent_id, place_kind, name, description, owner_id,
      open_to_building, open_to_things, open_to_notes
    )
    SELECT id, 'continent', 'scan-fixture', 'safe description', 7, false, false, false
    FROM places WHERE place_kind = 'world'
    RETURNING id
  `)
  const placeId = place.rows[0]?.id
  assert.ok(placeId)
  await database.query('INSERT INTO notes (place_id, author_id, body) VALUES ($1, 7, $2)', [
    placeId, `historical ${rootKey}`,
  ])
  await database.query(`
    INSERT INTO things (place_id, name, body, owner_id)
    VALUES ($1, 'scan-object', $2, 8)
  `, [placeId, `historical ${refreshToken}`])
  await database.query('INSERT INTO agreements (created_by_id, body) VALUES (7, $1)', [
    `historical partial ${partial}`,
  ])
  const family = await database.query<{ id: string }>(`
    INSERT INTO oauth_token_families (
      resident_id, client_id, resource, scope, expires_at, revoked_at, revoke_reason
    ) VALUES (
      10, 'integration-client', 'https://1f3d9.com/mcp/connect', 'city:resident',
      now() + interval '1 day', now(), 'integration inactive fixture'
    ) RETURNING id
  `)
  await database.query(`
    INSERT INTO oauth_tokens (token_hash, token_type, family_id, expires_at)
    VALUES ($1, 'refresh', $2, now() + interval '1 day')
  `, [sha256(refreshToken), family.rows[0]?.id])

  const before = await database.query<{ count: string }>(`
    SELECT (
      (SELECT count(*) FROM notes) +
      (SELECT count(*) FROM things) +
      (SELECT count(*) FROM agreements) +
      (SELECT count(*) FROM oauth_tokens)
    )::text AS count
  `)
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
  const after = await database.query<{ count: string }>(`
    SELECT (
      (SELECT count(*) FROM notes) +
      (SELECT count(*) FROM things) +
      (SELECT count(*) FROM agreements) +
      (SELECT count(*) FROM oauth_tokens)
    )::text AS count
  `)

  assert.deepEqual(result.affected_resident_ids, [7, 8])
  assert.deepEqual(result.credential_owner_resident_ids, [9, 10])
  assert.deepEqual(result.live_credential_owner_resident_ids, [9])
  assert.deepEqual(result.counts, {
    public_fields: 3,
    exact_credentials: 2,
    partial_shapes: 1,
    live_credentials: 1,
    inactive_credentials: 1,
    unresolved_credentials: 0,
    resident_key: 1,
    oauth_access_token: 0,
    oauth_refresh_token: 1,
    oauth_authorization_code: 0,
  })
  assert.deepEqual(after.rows, before.rows)

  const publicOutput = JSON.stringify({ result, logs })
  for (const forbidden of [rootKey, refreshToken, partial, password, 'postgres://']) {
    assert.equal(publicOutput.includes(forbidden), false)
  }
  const stored = await database.query<{ body: string }>('SELECT body FROM notes ORDER BY id LIMIT 1')
  assert.equal(sha256(stored.rows[0]?.body ?? ''), sha256(`historical ${rootKey}`))
})
