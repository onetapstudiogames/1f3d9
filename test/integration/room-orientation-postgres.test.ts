import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'room_orientation_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const migrationDdl = await readFile(
  new URL('../../db/migrations/20260822_room_orientation.sql', import.meta.url),
  'utf8',
)

const ownerSecret = `1f3d9_sk_${'1'.repeat(48)}`
const neighborSecret = `1f3d9_sk_${'2'.repeat(48)}`
let database: Pool | null = null
let afterOrientationEligibilityRead: (() => Promise<void>) | null = null
let orientationWriteObserved = false

function connectedDatabase(): Pool {
  assert.ok(database, 'the PostgreSQL test client must be connected')
  return database
}

function queryText(strings: TemplateStringsArray): string {
  return strings.reduce(
    (statement, part, index) => statement + part + (index < strings.length - 1 ? `$${index + 1}` : ''),
    '',
  )
}

function isOrientationEligibilityRead(text: string): boolean {
  return /\b(?:from|join)\s+things\b/iu.test(text)
    && /\bplace_id\b/iu.test(text)
    && /\bwithdrawn_at\b/iu.test(text)
    && !/\b(?:insert|update|delete)\b/iu.test(text)
    && !/public:place-collections/iu.test(text)
}

function isOrientationWrite(text: string): boolean {
  return /\bupdate\s+places\b/iu.test(text)
    && /\b(?:purpose|front_matter_thing_ids)\b/iu.test(text)
}

async function runQuery(text: string, values: readonly unknown[]) {
  const result = await connectedDatabase().query(text, [...values])
  if (afterOrientationEligibilityRead
      && !orientationWriteObserved
      && isOrientationEligibilityRead(text)) {
    await afterOrientationEligibilityRead()
  }
  if (isOrientationWrite(text)) orientationWriteObserved = true
  return result
}

const taggedSql = async (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): Promise<Record<string, unknown>[]> => (
  (await runQuery(queryText(strings), values)).rows as Record<string, unknown>[]
)

const sql = Object.assign(taggedSql, {
  query: async (text: string, values: readonly unknown[] = []) => (
    (await runQuery(text, values)).rows as Record<string, unknown>[]
  ),
})

mock.module(new URL('../../src/db.ts', import.meta.url).href, {
  namedExports: {
    sql,
    runtimeDatabaseUrl: () => 'postgresql://integration-test.invalid/room-orientation',
  },
})

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ client: Pool; containerName: string }> {
  const containerName = `1f3d9-room-orientation-${process.pid}-${randomBytes(4).toString('hex')}`
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
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8' })
    throw error
  }
}

function secretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

function bearer(secret: string): Record<string, string> {
  return {
    authorization: `Bearer ${secret}`,
    'content-type': 'application/json',
  }
}

type SeededRoom = Readonly<{
  roomId: number
  otherRoomId: number
  selectedIds: readonly [number, number, number]
  unselectedId: number
}>

async function resetDatabase(): Promise<SeededRoom> {
  const client = connectedDatabase()
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await client.query(schemaDdl)
  await client.query(`
    INSERT INTO residents (id, handle, model, secret_hash) VALUES
      (1, 'room-owner', 'room-orientation-test', $1),
      (2, 'neighbor', 'room-orientation-test', $2),
      (3, 'later-owner', 'room-orientation-test', repeat('3', 64))
  `, [secretHash(ownerSecret), secretHash(neighborSecret)])
  const worldId = Number((await client.query<{ id: number }>(
    `SELECT id FROM places WHERE place_kind = 'world'`,
  )).rows[0]!.id)
  const continentId = Number((await client.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, description, owner_id)
    VALUES ($1, 'continent', 'Orientation Continent', 'test continent', 1)
    RETURNING id
  `, [worldId])).rows[0]!.id)
  const roomId = Number((await client.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, description, owner_id)
    VALUES ($1, 'place', 'Reading Room', 'existing room description', 1)
    RETURNING id
  `, [continentId])).rows[0]!.id)
  const otherRoomId = Number((await client.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, description, owner_id)
    VALUES ($1, 'place', 'Other Room', 'another room', 1)
    RETURNING id
  `, [continentId])).rows[0]!.id)
  const things = await client.query<{ id: number; name: string }>(`
    INSERT INTO things (place_id, name, body, maker_id, owner_id, created_at) VALUES
      ($1, 'First heading', 'first body', 1, 1, '2026-08-22T00:00:01Z'),
      ($1, 'Second heading', 'second body 🏙', 2, 2, '2026-08-22T00:00:02Z'),
      ($1, 'Third heading', 'third body', 1, 1, '2026-08-22T00:00:03Z'),
      ($1, 'Never selected', 'must never backfill', 2, 2, '2026-08-22T00:00:04Z')
    RETURNING id, name
  `, [roomId])
  await client.query(`
    UPDATE things SET owner_id = CASE name
      WHEN 'Second heading' THEN 1
      WHEN 'Third heading' THEN 3
      ELSE owner_id
    END
    WHERE name IN ('Second heading', 'Third heading')
  `)
  const ids = Object.fromEntries(things.rows.map(row => [row.name, Number(row.id)]))
  return Object.freeze({
    roomId,
    otherRoomId,
    selectedIds: [
      ids['First heading']!,
      ids['Second heading']!,
      ids['Third heading']!,
    ] as const,
    unselectedId: ids['Never selected']!,
  })
}

type FrontMatterHeading = Readonly<{
  id: number
  type: string
  name: string
  body_text_bytes: number
  maker_id: number
  made_by: string
  current_owner_id: number
  current_owner: string
  owner_id: number
  owner: string
  body?: unknown
  body_snippet?: unknown
  snippet?: unknown
}>

function assertBodyFreeHeadings(
  headings: readonly FrontMatterHeading[],
  expectedIds: readonly number[],
): void {
  assert.deepEqual(headings.map(heading => heading.id), expectedIds)
  for (const heading of headings) {
    assert.equal(heading.type, 'thing')
    assert.ok(heading.name.length > 0)
    assert.ok(heading.body_text_bytes > 0)
    assert.ok(heading.maker_id > 0)
    assert.ok(heading.made_by.length > 0)
    assert.ok(heading.current_owner_id > 0)
    assert.ok(heading.current_owner.length > 0)
    assert.equal(heading.owner_id, heading.current_owner_id)
    assert.equal(heading.owner, heading.current_owner)
    assert.equal(Object.hasOwn(heading, 'body'), false)
    assert.equal(Object.hasOwn(heading, 'body_snippet'), false)
    assert.equal(Object.hasOwn(heading, 'snippet'), false)
  }
}

async function responseBody(response: Response) {
  return await response.json() as {
    error?: string
    place: { purpose: string; description: string }
    front_matter: FrontMatterHeading[]
  }
}

async function assertStoredOrientation(
  roomId: number,
  expected: Readonly<{ purpose?: string; frontMatterThingIds?: readonly number[] }> = {},
): Promise<void> {
  assert.deepEqual((await connectedDatabase().query(`
    SELECT purpose, front_matter_thing_ids, description
    FROM places WHERE id = $1
  `, [roomId])).rows, [{
    purpose: expected.purpose ?? '',
    front_matter_thing_ids: expected.frontMatterThingIds ?? [],
    description: 'existing room description',
  }])
}

test('room orientation remains ordered, body-free, owner-authored, and race-safe in PostgreSQL', {
  timeout: 120_000,
}, async t => {
  const postgres = await startPostgres()
  database = postgres.client
  try {
    const { Hono } = await import('hono')
    const { mountWorldRoutes } = await import('../../src/world.ts')
    const app = new Hono()
    mountWorldRoutes(app)

    await t.test('the additive migration upgrades a legacy-shaped schema and reruns safely', async () => {
      const seeded = await resetDatabase()
      await connectedDatabase().query(`
        ALTER TABLE places DROP COLUMN front_matter_thing_ids CASCADE;
        ALTER TABLE places DROP COLUMN purpose CASCADE;
      `)
      await connectedDatabase().query(migrationDdl)
      await connectedDatabase().query(migrationDdl)
      const response = await app.request(`/api/place/${seeded.roomId}`, {
        method: 'PATCH', headers: bearer(ownerSecret),
        body: JSON.stringify({
          purpose: 'Upgraded room orientation.',
          front_matter_thing_ids: seeded.selectedIds.slice(0, 2),
        }),
      })
      assert.equal(response.status, 200, await response.clone().text())
      const body = await responseBody(response)
      assert.equal(body.place.description, 'existing room description')
      assert.equal(body.place.purpose, 'Upgraded room orientation.')
      assertBodyFreeHeadings(body.front_matter, seeded.selectedIds.slice(0, 2))
    })

    await t.test('only the owner may edit and malformed or ineligible selections are rejected', async () => {
      const seeded = await resetDatabase()
      const [firstId, secondId, thirdId] = seeded.selectedIds
      const forbidden = await app.request(`/api/place/${seeded.roomId}`, {
        method: 'PATCH', headers: bearer(neighborSecret),
        body: JSON.stringify({
          purpose: 'Neighbor must not orient this room.',
          front_matter_thing_ids: [firstId, secondId],
        }),
      })
      assert.equal(forbidden.status, 403, await forbidden.text())
      await assertStoredOrientation(seeded.roomId)

      const malformedBodies: readonly Record<string, unknown>[] = [
        { purpose: 'safe', unsupported: true },
        { purpose: 42 },
        { purpose: 'two\nlines' },
        { purpose: 'x'.repeat(281) },
        { front_matter_thing_ids: 'not-an-array' },
        { front_matter_thing_ids: [firstId] },
        { front_matter_thing_ids: [firstId, secondId, thirdId, seeded.unselectedId] },
        { front_matter_thing_ids: [firstId, firstId] },
        { front_matter_thing_ids: [0, secondId] },
      ]
      for (const malformed of malformedBodies) {
        const response = await app.request(`/api/place/${seeded.roomId}`, {
          method: 'PATCH', headers: bearer(ownerSecret), body: JSON.stringify(malformed),
        })
        assert.equal(response.status, 400, JSON.stringify({ malformed, body: await response.text() }))
        await assertStoredOrientation(seeded.roomId)
      }

      await connectedDatabase().query('UPDATE things SET place_id = $2 WHERE id = $1', [secondId, seeded.otherRoomId])
      await connectedDatabase().query('UPDATE things SET withdrawn_at = clock_timestamp() WHERE id = $1', [thirdId])
      await connectedDatabase().query(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
        VALUES ('thing', $1, 'remove', 1, 'orientation eligibility test')
      `, [firstId])
      for (const ids of [[firstId, seeded.unselectedId], [secondId, seeded.unselectedId], [thirdId, seeded.unselectedId]]) {
        const response = await app.request(`/api/place/${seeded.roomId}`, {
          method: 'PATCH', headers: bearer(ownerSecret),
          body: JSON.stringify({ front_matter_thing_ids: ids }),
        })
        assert.equal(response.status, 400, await response.text())
        await assertStoredOrientation(seeded.roomId)
      }
    })

    await t.test('the database rejects directly written ineligible front matter', async () => {
      const seeded = await resetDatabase()
      const [foreignId, withdrawnId, hiddenId] = seeded.selectedIds
      await connectedDatabase().query(
        'UPDATE things SET place_id = $2 WHERE id = $1',
        [foreignId, seeded.otherRoomId],
      )
      await connectedDatabase().query(
        'UPDATE things SET withdrawn_at = clock_timestamp() WHERE id = $1',
        [withdrawnId],
      )
      await connectedDatabase().query(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
        VALUES ('thing', $1, 'remove', 1, 'direct orientation invariant test')
      `, [hiddenId])

      for (const [label, thingId] of [
        ['foreign-room', foreignId],
        ['withdrawn', withdrawnId],
        ['hidden', hiddenId],
      ] as const) {
        await assert.rejects(
          connectedDatabase().query(`
            UPDATE places SET front_matter_thing_ids = ARRAY[$1, $2]::integer[]
            WHERE id = $3
          `, [thingId, seeded.unselectedId, seeded.roomId]),
          { code: '23514' },
          label,
        )
      }
      await assertStoredOrientation(seeded.roomId)
    })

    await t.test('a direct rewrite cannot retain an unavailable selected thing', async () => {
      const seeded = await resetDatabase()
      const [hiddenId, retainedId, replacementId] = seeded.selectedIds
      await connectedDatabase().query(`
        UPDATE places SET front_matter_thing_ids = ARRAY[$1, $2]::integer[]
        WHERE id = $3
      `, [hiddenId, retainedId, seeded.roomId])
      await connectedDatabase().query(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
        VALUES ('thing', $1, 'remove', 1, 'direct rewrite invariant test')
      `, [hiddenId])

      await assert.rejects(
        connectedDatabase().query(`
          UPDATE places SET front_matter_thing_ids = ARRAY[$1, $2]::integer[]
          WHERE id = $3
        `, [hiddenId, replacementId, seeded.roomId]),
        { code: '23514' },
      )
      await assertStoredOrientation(seeded.roomId, {
        frontMatterThingIds: [hiddenId, retainedId],
      })
    })

    await t.test('two and three selected things retain caller order, provenance, and the existing description', async () => {
      const seeded = await resetDatabase()
      const [firstId, secondId, thirdId] = seeded.selectedIds
      const orderedIds = [thirdId, firstId, secondId]
      const created = await app.request(`/api/place/${seeded.roomId}`, {
        method: 'PATCH', headers: bearer(ownerSecret),
        body: JSON.stringify({
          purpose: 'A small room for deliberate reading.',
          front_matter_thing_ids: orderedIds,
        }),
      })
      assert.equal(created.status, 200, await created.clone().text())
      const createdBody = await responseBody(created)
      assert.equal(createdBody.place.purpose, 'A small room for deliberate reading.')
      assert.equal(createdBody.place.description, 'existing room description')
      assert.equal(Object.hasOwn(createdBody.place, 'front_matter_thing_ids'), false)
      assertBodyFreeHeadings(createdBody.front_matter, orderedIds)
      assert.deepEqual(createdBody.front_matter[1], {
        ...createdBody.front_matter[1],
        id: firstId,
        type: 'thing',
        name: 'First heading',
        body_text_bytes: Buffer.byteLength('first body', 'utf8'),
        maker_id: 1,
        made_by: 'room-owner',
        current_owner_id: 1,
        current_owner: 'room-owner',
        owner_id: 1,
        owner: 'room-owner',
      })
      assert.deepEqual((await connectedDatabase().query(`
        SELECT front_matter_thing_ids FROM places WHERE id = $1
      `, [seeded.roomId])).rows, [{ front_matter_thing_ids: orderedIds }])
      assert.deepEqual((await connectedDatabase().query(
        'SELECT purpose, description FROM places WHERE id = $1', [seeded.roomId],
      )).rows, [{
        purpose: 'A small room for deliberate reading.',
        description: 'existing room description',
      }])

      const two = await app.request(`/api/place/${seeded.roomId}`, {
        method: 'PATCH', headers: bearer(ownerSecret),
        body: JSON.stringify({ front_matter_thing_ids: [secondId, firstId] }),
      })
      assert.equal(two.status, 200, await two.clone().text())
      const twoBody = await responseBody(two)
      assert.equal(twoBody.place.purpose, 'A small room for deliberate reading.')
      assert.equal(twoBody.place.description, 'existing room description')
      assertBodyFreeHeadings(twoBody.front_matter, [secondId, firstId])
    })

    await t.test('outline and full reads omit bodies and never replace moved, withdrawn, or hidden selections', async () => {
      const seeded = await resetDatabase()
      const [firstId, secondId, thirdId] = seeded.selectedIds
      const selectedIds = [firstId, secondId, thirdId]
      const patch = await app.request(`/api/place/${seeded.roomId}`, {
        method: 'PATCH', headers: bearer(ownerSecret),
        body: JSON.stringify({
          purpose: 'A public orientation line.',
          front_matter_thing_ids: selectedIds,
        }),
      })
      assert.equal(patch.status, 200, await patch.text())

      for (const view of ['outline', 'full'] as const) {
        const response = await app.request(`/api/place/${seeded.roomId}?view=${view}`)
        assert.equal(response.status, 200, await response.clone().text())
        const body = await responseBody(response)
        assert.equal(body.place.purpose, 'A public orientation line.')
        assertBodyFreeHeadings(body.front_matter, selectedIds)
      }

      await connectedDatabase().query(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
        VALUES ('thing', $1, 'remove', 1, 'hide one retained selection')
      `, [thirdId])
      await connectedDatabase().query('UPDATE things SET place_id = $2 WHERE id = $1', [firstId, seeded.otherRoomId])
      let read = await app.request(`/api/place/${seeded.roomId}?view=outline`)
      assertBodyFreeHeadings((await responseBody(read)).front_matter, [secondId])
      assert.deepEqual((await connectedDatabase().query(
        'SELECT front_matter_thing_ids FROM places WHERE id = $1', [seeded.roomId],
      )).rows, [{ front_matter_thing_ids: [secondId, thirdId] }])

      await connectedDatabase().query('UPDATE things SET withdrawn_at = clock_timestamp() WHERE id = $1', [secondId])
      read = await app.request(`/api/place/${seeded.roomId}?view=full`)
      const hiddenBody = await responseBody(read)
      assertBodyFreeHeadings(hiddenBody.front_matter, [])
      assert.equal(hiddenBody.front_matter.some(heading => heading.id === seeded.unselectedId), false)

      await connectedDatabase().query(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
        VALUES ('thing', $1, 'restore', 1, 'restore selected heading'),
          ('place', $2, 'remove', 1, 'hide oriented place')
      `, [thirdId, seeded.roomId])
      read = await app.request(`/api/place/${seeded.roomId}?view=outline`)
      const hiddenPlaceBody = await responseBody(read)
      assert.equal(hiddenPlaceBody.place.purpose, '[removed by maintainer]')
      assertBodyFreeHeadings(hiddenPlaceBody.front_matter, [])
    })

    await t.test('identical concurrent retries leave one ordered array and an empty array clears it', async () => {
      const seeded = await resetDatabase()
      const [firstId, secondId, thirdId] = seeded.selectedIds
      const payload = {
        purpose: 'A retry-safe reading room.',
        front_matter_thing_ids: [thirdId, firstId, secondId],
      }
      const concurrent = await Promise.all([
        app.request(`/api/place/${seeded.roomId}`, {
          method: 'PATCH', headers: bearer(ownerSecret), body: JSON.stringify(payload),
        }),
        app.request(`/api/place/${seeded.roomId}`, {
          method: 'PATCH', headers: bearer(ownerSecret), body: JSON.stringify(payload),
        }),
      ])
      const statuses = concurrent.map(response => response.status)
      assert.equal(statuses.every(status => status === 200 || status === 409), true, statuses.join(','))
      assert.equal(statuses.includes(200), true, statuses.join(','))

      const retry = await app.request(`/api/place/${seeded.roomId}`, {
        method: 'PATCH', headers: bearer(ownerSecret), body: JSON.stringify(payload),
      })
      assert.equal(retry.status, 200, await retry.clone().text())
      assertBodyFreeHeadings((await responseBody(retry)).front_matter, payload.front_matter_thing_ids)
      assert.equal(Number((await connectedDatabase().query(`
        SELECT count(*)::integer AS count
        FROM events
        WHERE kind = 'place_edited' AND (detail->>'place_id')::integer = $1
      `, [seeded.roomId])).rows[0]?.count), 1)
      assert.deepEqual((await connectedDatabase().query(`
        SELECT front_matter_thing_ids FROM places WHERE id = $1
      `, [seeded.roomId])).rows, [{
        front_matter_thing_ids: payload.front_matter_thing_ids,
      }])

      const cleared = await app.request(`/api/place/${seeded.roomId}`, {
        method: 'PATCH', headers: bearer(ownerSecret),
        body: JSON.stringify({ front_matter_thing_ids: [] }),
      })
      assert.equal(cleared.status, 200, await cleared.clone().text())
      const clearedBody = await responseBody(cleared)
      assert.equal(clearedBody.place.purpose, payload.purpose)
      assert.equal(clearedBody.place.description, 'existing room description')
      assertBodyFreeHeadings(clearedBody.front_matter, [])
      assert.deepEqual((await connectedDatabase().query(
        'SELECT front_matter_thing_ids FROM places WHERE id = $1', [seeded.roomId],
      )).rows, [{ front_matter_thing_ids: [] }])
    })

    await t.test('a place transfer preserves inherited orientation and gives edit authority to the new owner', async () => {
      const seeded = await resetDatabase()
      const selected = seeded.selectedIds.slice(0, 2)
      const oriented = await app.request(`/api/place/${seeded.roomId}`, {
        method: 'PATCH', headers: bearer(ownerSecret),
        body: JSON.stringify({
          purpose: 'Inherited room configuration.',
          front_matter_thing_ids: selected,
        }),
      })
      assert.equal(oriented.status, 200, await oriented.clone().text())
      await connectedDatabase().query(
        'UPDATE places SET owner_id = 2 WHERE id = $1', [seeded.roomId],
      )

      const inherited = await responseBody(await app.request(`/api/place/${seeded.roomId}?view=outline`))
      assert.equal(inherited.place.purpose, 'Inherited room configuration.')
      assertBodyFreeHeadings(inherited.front_matter, selected)
      assert.equal((await app.request(`/api/place/${seeded.roomId}`, {
        method: 'PATCH', headers: bearer(ownerSecret),
        body: JSON.stringify({ purpose: 'Old owner cannot rewrite this.' }),
      })).status, 403)

      const replaced = await app.request(`/api/place/${seeded.roomId}`, {
        method: 'PATCH', headers: bearer(neighborSecret),
        body: JSON.stringify({ purpose: 'New owner configuration.' }),
      })
      assert.equal(replaced.status, 200, await replaced.clone().text())
      const replacedBody = await responseBody(replaced)
      assert.equal(replacedBody.place.purpose, 'New owner configuration.')
      assert.equal(replacedBody.place.description, 'existing room description')
    })

    await t.test('a candidate moved after eligibility is checked causes a 409 and leaves the room unchanged', async () => {
      const seeded = await resetDatabase()
      const [firstId, secondId] = seeded.selectedIds
      let signalEligibilityRead = (): void => undefined
      const eligibilityRead = new Promise<void>(resolve => {
        signalEligibilityRead = resolve
      })
      let resumePatch = (): void => undefined
      const resume = new Promise<void>(resolve => {
        resumePatch = resolve
      })
      afterOrientationEligibilityRead = async () => {
        signalEligibilityRead()
        await resume
      }
      orientationWriteObserved = false
      const responsePromise = Promise.resolve(app.request(`/api/place/${seeded.roomId}`, {
        method: 'PATCH', headers: bearer(ownerSecret),
        body: JSON.stringify({
          purpose: 'Must commit all or nothing.',
          front_matter_thing_ids: [firstId, secondId],
        }),
      }))
      try {
        const reachedEligibility = await Promise.race([
          eligibilityRead.then(() => true),
          responsePromise.then(() => false),
          delay(3_000, false),
        ])
        if (reachedEligibility) {
          await connectedDatabase().query(
            'UPDATE things SET place_id = $2 WHERE id = $1',
            [secondId, seeded.otherRoomId],
          )
        }
        resumePatch()
        const response = await responsePromise
        assert.equal(
          reachedEligibility,
          true,
          'PATCH must finish its eligibility preflight before the test moves a selected thing',
        )
        assert.equal(response.status, 409, await response.clone().text())
        assert.match((await response.json() as { error: string }).error, /retry/iu)
        assert.deepEqual((await connectedDatabase().query(
          'SELECT purpose, description FROM places WHERE id = $1', [seeded.roomId],
        )).rows, [{ purpose: '', description: 'existing room description' }])
        assert.deepEqual((await connectedDatabase().query(
          'SELECT front_matter_thing_ids FROM places WHERE id = $1', [seeded.roomId],
        )).rows, [{ front_matter_thing_ids: [] }])
      } finally {
        resumePatch()
        afterOrientationEligibilityRead = null
        orientationWriteObserved = false
      }
    })
  } finally {
    afterOrientationEligibilityRead = null
    orientationWriteObserved = false
    database = null
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
