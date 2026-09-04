// Issue #177: every place_edit field on the protected Gazette room #454 must
// answer the one named refusal (GAZETTE_ROOM_PROTECTED_ERROR), the same way
// every other protected-room act refuses -- never a raw database constraint
// or a misleading "front matter eligibility changed; retry" substitute. The
// unit suite (test/routes.test.ts) proves this against a faked driver; this
// exercises the real place_edit CTE, the real protect_gazette_submission_room
// trigger, and the real error shape a live `pg` connection raises.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'

const POSTGRES_IMAGE =
  'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'place_edit_gazette_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')

let database: Pool | null = null

function connectedDatabase(): Pool {
  assert.ok(database, 'the PostgreSQL test client must be connected')
  return database
}

const sql = (async (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): Promise<Record<string, unknown>[]> => {
  const text = strings.reduce(
    (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ''),
    '',
  )
  return (await connectedDatabase().query(text, [...values])).rows as Record<string, unknown>[]
}) as unknown as {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<Record<string, unknown>[]>
  query: (text: string, values?: readonly unknown[]) => Promise<Record<string, unknown>[]>
}
sql.query = async (text, values = []) => (
  (await connectedDatabase().query(text, [...values])).rows as Record<string, unknown>[]
)

mock.module(new URL('../../src/db.ts', import.meta.url).href, {
  namedExports: {
    sql,
    runtimeDatabaseUrl: () => 'postgresql://integration-test.invalid/place-edit-gazette',
  },
})

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ client: Pool; containerName: string }> {
  const containerName = `1f3d9-place-edit-gazette-${process.pid}-${randomBytes(4).toString('hex')}`
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
    assert.ok(Number.isSafeInteger(port) && port > 0, `could not read PostgreSQL port from ${portOutput}`)
    const client = new Pool({
      host: '127.0.0.1', port, user: 'postgres', password,
      database: POSTGRES_DATABASE, ssl: false, max: 10,
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
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8', windowsHide: true })
    throw error
  }
}

const ownerSecret = `1f3d9_sk_${'7'.repeat(48)}`

function secretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }
}

const GAZETTE_ROOM_CLOSED_DESCRIPTION =
  'The Gazette submission room is being prepared. Notes are closed until the weekly printer, ' +
  'per-resident submission limit, and permanent archive are live. Nothing left elsewhere is ' +
  'waiting for print.'

// Matches gazette_submission_room_state()'s exact "closed" branch in
// db/schema.sql: id 454, parent 2, owner 1, that literal name and
// description, empty purpose, no front matter, no open offer, every
// building/things/notes switch off. Anything else fails the INSERT-time
// lifecycle guard before this test even gets to place_edit.
async function resetDatabase(): Promise<void> {
  const client = connectedDatabase()
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await client.query(schemaDdl)
  await client.query(
    `INSERT INTO residents (id, handle, model, secret_hash) VALUES (1, 'gazette-owner', 'place-edit-gazette-test', $1)`,
    [secretHash(ownerSecret)],
  )
  const worldId = Number((await client.query<{ id: number }>(
    `SELECT id FROM places WHERE place_kind = 'world'`,
  )).rows[0]!.id)
  await client.query(`
    INSERT INTO places (
      id, parent_id, place_kind, name, founding_name, description, owner_id,
      open_to_building, open_to_things, open_to_notes
    ) VALUES (
      2, $1, 'continent', 'Gazette test continent', 'Gazette test continent',
      'Integration-only parent for the Gazette room.', 1, FALSE, FALSE, FALSE
    )
  `, [worldId])
  await client.query(`
    INSERT INTO places (
      id, parent_id, place_kind, name, founding_name, description, purpose, owner_id,
      open_to_building, open_to_things, open_to_notes
    ) VALUES (
      454, 2, 'place', 'the gazette submission room', NULL,
      $1, '', 1, FALSE, FALSE, FALSE
    )
  `, [GAZETTE_ROOM_CLOSED_DESCRIPTION])
}

test('place_edit on the protected Gazette room answers the named refusal, in PostgreSQL', {
  timeout: 120_000,
}, async t => {
  const postgres = await startPostgres()
  database = postgres.client
  try {
    const { Hono } = await import('hono')
    const { err } = await import('../../src/core.ts')
    const { mountWorldRoutes } = await import('../../src/world.ts')
    const { GAZETTE_ROOM_PROTECTED_ERROR, gazetteRoomLifecycleRefusal } =
      await import('../../src/gazette-room.ts')
    const app = new Hono()
    mountWorldRoutes(app)
    // Mirror src/index.ts:441-447's global onError fallback for the Gazette
    // constraint. Production always has this net under every route, so a
    // bare-Hono harness without it would report 500 for a case production
    // never actually surfaces that way -- see issue #177 round-2 review
    // finding 3. With this installed, a 500 here means a route rethrew past
    // both its own catch and this fallback, i.e. a real production 500.
    app.onError((error, c) => {
      const gazetteRoomError = gazetteRoomLifecycleRefusal(error)
      if (gazetteRoomError) return err(c, 409, gazetteRoomError)
      throw error
    })

    const bodies: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['description', { description: 'a forbidden Gazette description' }],
      ['quiet', { quiet: true }],
      ['purpose', { purpose: 'a forbidden Gazette purpose' }],
      // front_matter_thing_ids alone against an already-empty room is a
      // legitimate no-op (200); paired with a field that actually changes,
      // it exercises world.ts's other catch branch -- the one that used to
      // mistake this exact Gazette-lifecycle failure for a front-matter
      // eligibility race and answer the wrong 409.
      ['quiet + front_matter_thing_ids', { quiet: true, front_matter_thing_ids: [] }],
    ]

    for (const [label, body] of bodies) {
      await t.test(`PATCH /api/place/454 {"${label}": ...} refuses cleanly`, async () => {
        await resetDatabase()
        const before = await connectedDatabase().query(
          'SELECT description, purpose, quiet, front_matter_thing_ids FROM places WHERE id = 454',
        )
        const response = await app.request('/api/place/454', {
          method: 'PATCH', headers: bearer(ownerSecret), body: JSON.stringify(body),
        })
        const text = await response.clone().text()
        assert.equal(response.status, 409, text)
        assert.deepEqual(JSON.parse(text), { error: GAZETTE_ROOM_PROTECTED_ERROR })
        const after = await connectedDatabase().query(
          'SELECT description, purpose, quiet, front_matter_thing_ids FROM places WHERE id = 454',
        )
        assert.deepEqual(after.rows, before.rows, 'the room must be completely unchanged')
      })
    }

    // Issue #177 round-2 review finding 2: the door text used to claim PATCH
    // /api/place/454 refuses "on any field", which is false -- a
    // value-identical edit never reaches the UPDATE's WHERE clause (it
    // requires an IS DISTINCT FROM change; see src/world.ts around the
    // `editable` CTE), so it short-circuits to the ordinary 200 no-op before
    // the protection trigger is ever consulted. This pins the corrected
    // "that would change any field" wording in both directions: refuses a
    // real change, but a no-op on the room's exact seeded values stays 200.
    await t.test('a value-identical edit is an ordinary 200 no-op, not a refusal', async () => {
      await resetDatabase()
      const before = await connectedDatabase().query(
        'SELECT description, purpose, quiet, front_matter_thing_ids FROM places WHERE id = 454',
      )
      const response = await app.request('/api/place/454', {
        method: 'PATCH',
        headers: bearer(ownerSecret),
        body: JSON.stringify({
          description: GAZETTE_ROOM_CLOSED_DESCRIPTION,
          purpose: '',
          quiet: false,
          front_matter_thing_ids: [],
        }),
      })
      const text = await response.clone().text()
      assert.equal(response.status, 200, text)
      const after = await connectedDatabase().query(
        'SELECT description, purpose, quiet, front_matter_thing_ids FROM places WHERE id = 454',
      )
      assert.deepEqual(after.rows, before.rows, 'a value-identical edit must change nothing')
    })

    await t.test('the underlying trigger really is what fires (23514 / gazette_submission_room_lifecycle)', async () => {
      await resetDatabase()
      await assert.rejects(
        connectedDatabase().query(`UPDATE places SET description = 'x' WHERE id = 454`),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, '23514')
          assert.equal((error as { constraint?: string }).constraint, 'gazette_submission_room_lifecycle')
          return true
        },
      )
    })
  } finally {
    await database?.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8', windowsHide: true })
  }
})
