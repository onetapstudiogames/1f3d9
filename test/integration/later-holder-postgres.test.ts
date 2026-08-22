import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import {
  createLaterHolderCursorCodec,
  isLaterHolderCursor,
  LaterHolderCursorError,
  LaterHolderMarkEligibilityError,
  readLaterHolderIndex,
  readLaterHolderNotice,
  setLaterHolderMark,
  type LaterHolderQueryExecutor,
} from '../../src/later-holder.ts'
import { MODERATED_TEXT } from '../../src/moderation.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'later_holder_integration'
const CURSOR_KEY = '11'.repeat(32)
const cursorFor = (residentId: number) => createLaterHolderCursorCodec(CURSOR_KEY, residentId)
const MIGRATION_URL = new URL('../../db/migrations/20260822_later_holder_marks.sql', import.meta.url)
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const preWave3SchemaDdl = schemaDdl.replace(
  /-- A deliberate private pointer[\s\S]*?(?=CREATE OR REPLACE FUNCTION set_thing_maker_on_insert)/u,
  '',
)

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ client: Pool; containerName: string }> {
  const containerName = `1f3d9-later-holder-test-${process.pid}-${randomBytes(4).toString('hex')}`
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
    assert.ok(Number.isInteger(port) && port > 0)
    const client = new Pool({
      host: '127.0.0.1', port, user: 'postgres', password,
      database: POSTGRES_DATABASE, ssl: false,
    })
    const deadline = Date.now() + 30_000
    let lastError: unknown
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

function postgresCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : null
}

async function seed(database: Pool): Promise<{ roomId: number; otherRoomId: number }> {
  await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await database.query(schemaDdl)
  await database.query(`
    INSERT INTO residents (id, handle, model, secret_hash, joined_at) VALUES
      (1, 'maker-one', 'later-holder-test', repeat('1', 64), '2026-08-01T00:00:00Z'),
      (2, 'owner-two', 'later-holder-test', repeat('2', 64), '2026-08-01T00:00:00Z')
  `)
  const worldId = Number((await database.query<{ id: number }>(
    `SELECT id FROM places WHERE place_kind = 'world'`,
  )).rows[0]!.id)
  const continentId = Number((await database.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, owner_id)
    VALUES ($1, 'continent', 'Later Holder Continent', 1)
    RETURNING id
  `, [worldId])).rows[0]!.id)
  const roomId = Number((await database.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, owner_id)
    VALUES ($1, 'place', 'Archive Room', 1)
    RETURNING id
  `, [continentId])).rows[0]!.id)
  const otherRoomId = Number((await database.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, owner_id)
    VALUES ($1, 'place', 'Moved Room', 1)
    RETURNING id
  `, [continentId])).rows[0]!.id)
  return { roomId, otherRoomId }
}

async function addThing(
  database: Pool,
  roomId: number,
  name: string,
  ownerId = 1,
  makerId = ownerId,
  createdAt = '2026-08-20T00:00:00Z',
): Promise<number> {
  return Number((await database.query<{ id: number }>(`
    INSERT INTO things (place_id, name, body, owner_id, maker_id, created_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id
  `, [roomId, name, `${name} body 🏙`, ownerId, makerId, createdAt])).rows[0]!.id)
}

test('later-holder marks keep deliberate order and end exactly with ownership', {
  timeout: 120_000,
}, async t => {
  assert.equal(existsSync(MIGRATION_URL), true, 'add the later-holder migration before this gate')
  const migrationDdl = await readFile(MIGRATION_URL, 'utf8')
  const postgres = await startPostgres()
  const execute: LaterHolderQueryExecutor = async (query, params) =>
    (await postgres.client.query(query, [...params])).rows as Record<string, unknown>[]
  try {
    await t.test('fresh schema and migration are repeatable and store no opening state', async () => {
      assert.doesNotMatch(preWave3SchemaDdl, /thing_later_holder_marks/iu)
      await postgres.client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
      await postgres.client.query(preWave3SchemaDdl)
      assert.equal((await postgres.client.query(
        `SELECT to_regclass('public.thing_later_holder_marks')::text AS table_name`,
      )).rows[0]!.table_name, null)
      await postgres.client.query(migrationDdl)
      await postgres.client.query(migrationDdl)
      const columns = (await postgres.client.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'thing_later_holder_marks'
        ORDER BY ordinal_position
      `)).rows.map(row => row.column_name)
      assert.deepEqual(columns, ['id', 'resident_id', 'thing_id', 'marked_at'])
    })

    await t.test('an old marked thing survives later activity, edits, moves, and safe paging', async () => {
      const cursorCodec = cursorFor(1)
      const { roomId, otherRoomId } = await seed(postgres.client)
      const buried = await addThing(
        postgres.client, roomId, 'Buried copper lantern', 1, 1, '2020-01-01T00:00:00Z',
      )
      await setLaterHolderMark(execute, 1, buried, true)
      const otherResidentThing = await addThing(postgres.client, roomId, 'Other resident mark', 2, 2)
      await setLaterHolderMark(execute, 2, otherResidentThing, true)
      for (let index = 0; index < 12; index += 1) {
        const id = await addThing(postgres.client, roomId, `Later item ${index}`)
        await setLaterHolderMark(execute, 1, id, true)
      }
      const originalMark = (await postgres.client.query<{ id: string }>(
        'SELECT id::text FROM thing_later_holder_marks WHERE thing_id = $1', [buried],
      )).rows[0]!.id
      await postgres.client.query(`
        UPDATE things SET name = 'Current copper title', body = 'é🏙', place_id = $2
        WHERE id = $1
      `, [buried, otherRoomId])
      const stableMark = (await postgres.client.query<{ id: string }>(
        'SELECT id::text FROM thing_later_holder_marks WHERE thing_id = $1', [buried],
      )).rows[0]!.id
      assert.equal(stableMark, originalMark)

      const found: Array<Record<string, unknown>> = []
      const cursors: string[] = []
      let before: string | null = null
      do {
        const page = await readLaterHolderIndex(execute, 1, {
          mode: 'later_holder_index', before, limit: 5,
        }, cursorCodec)
        found.push(...page.items)
        before = page.next_before
        if (before !== null) {
          cursors.push(before)
          assert.equal(isLaterHolderCursor(before), true)
          const boundaryThingId = page.items.at(-1)!.id
          const boundaryMarkId = (await postgres.client.query<{ id: string }>(
            'SELECT id::text FROM thing_later_holder_marks WHERE thing_id = $1',
            [boundaryThingId],
          )).rows[0]!.id
          assert.equal(cursorCodec.decode(before), boundaryMarkId)
          assert.notEqual(before, String(boundaryThingId))
        }
      } while (before !== null)
      const item = found.find(candidate => candidate.id === buried)
      assert.deepEqual(item, {
        id: buried,
        type: 'thing',
        title: 'Current copper title',
        place: { id: otherRoomId, title: 'Moved Room' },
        date: '2020-01-01T00:00:00.000000Z',
        body_text_bytes: Buffer.byteLength('é🏙', 'utf8'),
      })
      assert.equal(found.filter(candidate => candidate.id === buried).length, 1)
      assert.ok(cursors.length > 1)
      const otherResidentMarkId = (await postgres.client.query<{ id: string }>(
        'SELECT id::text FROM thing_later_holder_marks WHERE thing_id = $1',
        [otherResidentThing],
      )).rows[0]!.id
      await assert.rejects(
        readLaterHolderIndex(execute, 1, {
          mode: 'later_holder_index', before: cursorFor(2).encode(otherResidentMarkId), limit: 5,
        }, cursorCodec),
        LaterHolderCursorError,
      )
    })

    await t.test('a saved cursor survives boundary unmarking and re-marking without repeats', async () => {
      const { roomId } = await seed(postgres.client)
      const cursorCodec = cursorFor(1)
      for (let index = 0; index < 7; index += 1) {
        const thingId = await addThing(postgres.client, roomId, `Cursor item ${index}`)
        await setLaterHolderMark(execute, 1, thingId, true)
      }

      const first = await readLaterHolderIndex(execute, 1, {
        mode: 'later_holder_index', before: null, limit: 3,
      }, cursorCodec)
      assert.equal(first.has_more, true)
      assert.equal(isLaterHolderCursor(first.next_before), true)
      const savedCursor = first.next_before!
      const boundaryThingId = first.items.at(-1)!.id
      const firstIds = first.items.map(item => item.id)

      const beforeMutation = await readLaterHolderIndex(execute, 1, {
        mode: 'later_holder_index', before: savedCursor, limit: 3,
      }, cursorCodec)
      await setLaterHolderMark(execute, 1, boundaryThingId, false)
      const afterUnmark = await readLaterHolderIndex(execute, 1, {
        mode: 'later_holder_index', before: savedCursor, limit: 3,
      }, cursorCodec)
      await setLaterHolderMark(execute, 1, boundaryThingId, true)
      const afterRemark = await readLaterHolderIndex(execute, 1, {
        mode: 'later_holder_index', before: savedCursor, limit: 3,
      }, cursorCodec)

      const expectedOlderIds = beforeMutation.items.map(item => item.id)
      assert.deepEqual(afterUnmark.items.map(item => item.id), expectedOlderIds)
      assert.deepEqual(afterRemark.items.map(item => item.id), expectedOlderIds)
      assert.equal(expectedOlderIds.some(id => firstIds.includes(id)), false)
    })

    await t.test('maker, owner, active, duplicate, transfer, and withdrawal rules are enforced', async () => {
      const { roomId } = await seed(postgres.client)
      const valid = await addThing(postgres.client, roomId, 'Valid mark')
      const otherMaker = await addThing(postgres.client, roomId, 'Other maker', 2, 2)
      const transferredBack = await addThing(postgres.client, roomId, 'Transferred back')
      await setLaterHolderMark(execute, 1, transferredBack, true)
      await postgres.client.query('UPDATE things SET owner_id = 2 WHERE id = $1', [transferredBack])
      await postgres.client.query('UPDATE things SET owner_id = 1 WHERE id = $1', [transferredBack])
      const withdrawn = await addThing(postgres.client, roomId, 'Already withdrawn')
      await postgres.client.query('UPDATE things SET withdrawn_at = clock_timestamp() WHERE id = $1', [withdrawn])

      await assert.rejects(
        postgres.client.query(
          'INSERT INTO thing_later_holder_marks (resident_id, thing_id) VALUES (1, $1)',
          [otherMaker],
        ),
        error => postgresCode(error) === '23514',
      )
      assert.equal((await postgres.client.query(
        'SELECT count(*)::int AS count FROM thing_later_holder_marks WHERE thing_id = $1',
        [transferredBack],
      )).rows[0]!.count, 0, 'transfer away and back must not restore the ended mark')
      assert.equal((await setLaterHolderMark(execute, 1, transferredBack, true)).changed, true)
      await setLaterHolderMark(execute, 1, transferredBack, false)
      await assert.rejects(
        postgres.client.query(
          'INSERT INTO thing_later_holder_marks (resident_id, thing_id) VALUES (1, $1)',
          [withdrawn],
        ),
        error => postgresCode(error) === '23514',
      )

      const first = await setLaterHolderMark(execute, 1, valid, true)
      const repeated = await setLaterHolderMark(execute, 1, valid, true)
      assert.deepEqual([first.changed, repeated.changed], [true, false])
      await postgres.client.query('UPDATE things SET owner_id = 2 WHERE id = $1', [valid])
      assert.equal((await readLaterHolderNotice(execute, 1)).count, 0)
      await postgres.client.query('UPDATE things SET owner_id = 1 WHERE id = $1', [valid])
      assert.equal((await readLaterHolderNotice(execute, 1)).count, 0)

      const toWithdraw = await addThing(postgres.client, roomId, 'Withdraw after mark')
      await setLaterHolderMark(execute, 1, toWithdraw, true)
      await postgres.client.query('UPDATE things SET withdrawn_at = clock_timestamp() WHERE id = $1', [toWithdraw])
      assert.equal((await readLaterHolderNotice(execute, 1)).count, 0)
    })

    await t.test('moderation hides without deleting and restore reveals the same private mark', async () => {
      const { roomId } = await seed(postgres.client)
      const thingId = await addThing(postgres.client, roomId, 'Restorable item')
      const hiddenBeforeMark = await addThing(postgres.client, roomId, 'Hidden before mark')
      await setLaterHolderMark(execute, 1, thingId, true)
      const markId = (await postgres.client.query<{ id: string }>(
        'SELECT id::text FROM thing_later_holder_marks WHERE thing_id = $1', [thingId],
      )).rows[0]!.id
      await postgres.client.query(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
        VALUES ('thing', $1, 'remove', 1, 'integration test')
      `, [thingId])
      await postgres.client.query(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
        VALUES ('thing', $1, 'remove', 1, 'hidden before mark')
      `, [hiddenBeforeMark])
      await assert.rejects(
        setLaterHolderMark(execute, 1, hiddenBeforeMark, true),
        /only an active public thing/iu,
      )
      await assert.rejects(
        postgres.client.query(
          'INSERT INTO thing_later_holder_marks (resident_id, thing_id) VALUES (1, $1)',
          [hiddenBeforeMark],
        ),
        error => postgresCode(error) === '23514',
      )
      assert.deepEqual(await readLaterHolderNotice(execute, 1), { count: 0 })
      assert.equal((await postgres.client.query(
        'SELECT count(*)::int AS count FROM thing_later_holder_marks WHERE thing_id = $1', [thingId],
      )).rows[0]!.count, 1)
      await postgres.client.query(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
        VALUES ('thing', $1, 'restore', 1, 'integration test restore')
      `, [thingId])
      assert.equal((await readLaterHolderNotice(execute, 1)).count, 1)
      assert.equal((await postgres.client.query<{ id: string }>(
        'SELECT id::text FROM thing_later_holder_marks WHERE thing_id = $1', [thingId],
      )).rows[0]!.id, markId)
      await postgres.client.query(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
        VALUES ('place', $1, 'remove', 1, 'hide the place title')
      `, [roomId])
      const hiddenPlace = await readLaterHolderIndex(execute, 1, {
        mode: 'later_holder_index', before: null, limit: 10,
      }, cursorFor(1))
      assert.equal(hiddenPlace.items[0]!.place.title, MODERATED_TEXT)
    })

    await t.test('concurrent branches share one row and reads create no event or change record', async () => {
      const { roomId } = await seed(postgres.client)
      const thingId = await addThing(postgres.client, roomId, 'Concurrent item')
      const eventCount = Number((await postgres.client.query(
        'SELECT count(*)::int AS count FROM events',
      )).rows[0]!.count)
      const changeId = String((await postgres.client.query(
        'SELECT current_change_id::text FROM public_change_state WHERE singleton = true',
      )).rows[0]!.current_change_id)

      const marked = await Promise.all([
        setLaterHolderMark(execute, 1, thingId, true),
        setLaterHolderMark(execute, 1, thingId, true),
      ])
      assert.deepEqual(marked.map(result => result.changed).sort(), [false, true])
      const [firstRead, secondRead] = await Promise.all([
        readLaterHolderNotice(execute, 1),
        readLaterHolderNotice(execute, 1),
      ])
      assert.deepEqual(firstRead, secondRead)
      assert.equal(firstRead.count, 1)

      const unmarked = await Promise.all([
        setLaterHolderMark(execute, 1, thingId, false),
        setLaterHolderMark(execute, 1, thingId, false),
      ])
      assert.deepEqual(unmarked.map(result => result.changed).sort(), [false, true])

      const crossing = await Promise.all([
        setLaterHolderMark(execute, 1, thingId, true),
        setLaterHolderMark(execute, 1, thingId, false),
      ])
      const crossingCount = Number((await postgres.client.query(
        'SELECT count(*)::int AS count FROM thing_later_holder_marks WHERE thing_id = $1',
        [thingId],
      )).rows[0]!.count)
      assert.equal(crossing[0].changed, true)
      assert.equal(crossing[1].changed, crossingCount === 0)
      assert.ok(crossingCount === 0 || crossingCount === 1)

      await setLaterHolderMark(execute, 1, thingId, false)
      const markVsTransfer = await Promise.allSettled([
        setLaterHolderMark(execute, 1, thingId, true),
        postgres.client.query('UPDATE things SET owner_id = 2 WHERE id = $1', [thingId]),
      ])
      assert.equal(markVsTransfer[1]!.status, 'fulfilled')
      if (markVsTransfer[0]!.status === 'rejected') {
        assert.ok(markVsTransfer[0]!.reason instanceof LaterHolderMarkEligibilityError)
      } else {
        assert.equal(markVsTransfer[0]!.value.changed, true)
      }
      assert.equal((await postgres.client.query(
        'SELECT count(*)::int AS count FROM thing_later_holder_marks WHERE thing_id = $1',
        [thingId],
      )).rows[0]!.count, 0)

      const withdrawRace = await addThing(postgres.client, roomId, 'Withdraw race')
      const markVsWithdraw = await Promise.allSettled([
        setLaterHolderMark(execute, 1, withdrawRace, true),
        postgres.client.query(
          'UPDATE things SET withdrawn_at = clock_timestamp() WHERE id = $1', [withdrawRace],
        ),
      ])
      assert.equal(markVsWithdraw[1]!.status, 'fulfilled')
      if (markVsWithdraw[0]!.status === 'rejected') {
        assert.ok(markVsWithdraw[0]!.reason instanceof LaterHolderMarkEligibilityError)
      } else {
        assert.equal(markVsWithdraw[0]!.value.changed, true)
      }
      assert.equal((await postgres.client.query(
        'SELECT count(*)::int AS count FROM thing_later_holder_marks WHERE thing_id = $1',
        [withdrawRace],
      )).rows[0]!.count, 0)
      assert.equal(Number((await postgres.client.query(
        'SELECT count(*)::int AS count FROM events',
      )).rows[0]!.count), eventCount)
      assert.equal(String((await postgres.client.query(
        'SELECT current_change_id::text FROM public_change_state WHERE singleton = true',
      )).rows[0]!.current_change_id), changeId)
    })
  } finally {
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
