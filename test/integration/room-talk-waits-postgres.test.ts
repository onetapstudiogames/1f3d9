import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import {
  FOUNDER,
  GROWER,
  NEIGHBOUR,
} from '../helpers/abilities-fixtures.ts'
import {
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'
import {
  leaseSeconds,
  WAIT_ALREADY_OPEN_REFUSAL,
  WAIT_NO_PLACE_REFUSAL,
} from '../../src/room-talk-contract.ts'

const RESIDENTS = [FOUNDER, GROWER, NEIGHBOUR] as const
const SECONDS = leaseSeconds(30)!

test('room waits use temporary leases against real PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('room-talk-waits')
  try {
    let rooms = await resetCity(RESIDENTS)
    await standIn(FOUNDER.id, rooms.eastRoomId)
    await standIn(GROWER.id, rooms.westRoomId)
    await standIn(NEIGHBOUR.id, rooms.westRoomId)

    const { openWait, readListening, releaseWait } = await import('../../src/room-wait-store.ts')
    const db = connectedDatabase()
    const prepare = async () => {
      rooms = await resetCity(RESIDENTS)
      await standIn(FOUNDER.id, rooms.eastRoomId)
      await standIn(GROWER.id, rooms.westRoomId)
      await standIn(NEIGHBOUR.id, rooms.westRoomId)
      return rooms
    }
    const open = (
      resident: Readonly<{ id: number }> = FOUNDER,
      seconds = SECONDS,
    ) => openWait({ residentId: resident.id, seconds })
    const count = async (sql: string, values: readonly unknown[] = []) => Number(
      (await db.query<{ count: number }>(sql, [...values])).rows[0]!.count,
    )

    await t.test('a resident standing in a place opens one wait lease there', async () => {
      await prepare()
      const result = await open()
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.status, 201)
      assert.equal(result.answer.lease.place_id, rooms.eastRoomId)
      assert.match(result.answer.lease.lease_id, /^[0-9a-f-]{36}$/u)
      assert.equal(typeof result.answer.lease.started_at, 'string')
      assert.equal(typeof result.answer.lease.expires_at, 'string')
      const stored = (await db.query<{ arrived_at: Date; lease_id: string }>(
        'SELECT arrived_at, lease_id FROM wait_leases WHERE resident_id = $1', [FOUNDER.id],
      )).rows[0]!
      assert.equal(stored.lease_id, result.answer.lease.lease_id)
      assert.ok(stored.arrived_at instanceof Date)
    })

    await t.test('a second open while one is live is refused with the exact sentence', async () => {
      await prepare()
      const first = await open()
      assert.equal(first.ok, true)
      const second = await open()
      assert.equal(second.ok, false)
      if (!second.ok) assert.deepEqual(second.refusal, WAIT_ALREADY_OPEN_REFUSAL)
    })

    await t.test('ten concurrent opens from separate connections admit exactly one lease', async () => {
      await prepare()
      const results = await Promise.all(Array.from({ length: 10 }, () => open()))
      assert.equal(results.filter(result => result.ok && result.status === 201).length, 1)
      assert.equal(results.filter(result => !result.ok).length, 9)
      assert.equal(await count('SELECT count(*)::int AS count FROM wait_leases'), 1)
    })

    await t.test('release by lease id happens exactly once and a wrong lease id releases nothing', async () => {
      await prepare()
      const opened = await open()
      assert.equal(opened.ok, true)
      if (!opened.ok) return
      const wrong = await releaseWait({ residentId: FOUNDER.id, leaseId: randomUUID() })
      assert.deepEqual(wrong, { released: false })
      assert.equal(await count('SELECT count(*)::int AS count FROM wait_leases'), 1)
      const released = await releaseWait({
        residentId: FOUNDER.id,
        leaseId: opened.answer.lease.lease_id,
      })
      assert.deepEqual(released, { released: true })
      const repeated = await releaseWait({
        residentId: FOUNDER.id,
        leaseId: opened.answer.lease.lease_id,
      })
      assert.deepEqual(repeated, { released: false })
    })

    await t.test('an expired lease is reclaimed at the next open with a new lease id', async () => {
      await prepare()
      const first = await open()
      assert.equal(first.ok, true)
      if (!first.ok) return
      await db.query(
        `WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS now)
         UPDATE wait_leases SET started_at = stamp.now - interval '2 seconds',
           expires_at = stamp.now - interval '1 second'
         FROM stamp WHERE resident_id = $1`,
        [FOUNDER.id],
      )
      const next = await open()
      assert.equal(next.ok, true)
      if (next.ok) assert.notEqual(next.answer.lease.lease_id, first.answer.lease.lease_id)
    })

    await t.test('a lease left in a place the resident has left is reclaimed at the next open', async () => {
      await prepare()
      const first = await open()
      assert.equal(first.ok, true)
      if (!first.ok) return
      await standIn(FOUNDER.id, rooms.westRoomId)
      const next = await open()
      assert.equal(next.ok, true)
      if (!next.ok) return
      assert.notEqual(next.answer.lease.lease_id, first.answer.lease.lease_id)
      assert.equal(next.answer.lease.place_id, rooms.westRoomId)
    })

    await t.test('a lease whose resident moved away and came back is reclaimed and shows no cue', async () => {
      await prepare()
      const first = await open()
      assert.equal(first.ok, true)
      if (!first.ok) return
      await standIn(FOUNDER.id, rooms.westRoomId)
      await standIn(FOUNDER.id, rooms.eastRoomId)
      const staleCue = await readListening({ placeId: rooms.eastRoomId, limit: 10 })
      assert.deepEqual(staleCue, { residents: [], total: 0 })
      const next = await open()
      assert.equal(next.ok, true)
      if (next.ok) assert.notEqual(next.answer.lease.lease_id, first.answer.lease.lease_id)
    })

    await t.test('the listening cue shows only a live lease whose resident has not moved since it opened, with an exact total past the page size', async () => {
      await prepare()
      await standIn(GROWER.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      for (const resident of RESIDENTS) {
        const result = await open(resident)
        assert.equal(result.ok, true)
      }
      const result = await readListening({ placeId: rooms.eastRoomId, limit: 2 })
      assert.deepEqual(result.residents.map(resident => resident.resident_id),
        RESIDENTS.map(resident => resident.id).sort((left, right) => left - right).slice(0, 2))
      assert.deepEqual(result.residents.map(resident => resident.handle),
        RESIDENTS.map(resident => resident.id).sort((left, right) => left - right)
          .slice(0, 2).map(id => RESIDENTS.find(resident => resident.id === id)!.handle))
      assert.equal(result.residents.length, 2)
      assert.equal(result.total, 3)
    })

    await t.test('a resident with no place cannot open a wait', async () => {
      await resetCity(RESIDENTS)
      const result = await open()
      assert.equal(result.ok, false)
      if (!result.ok) assert.deepEqual(result.refusal, WAIT_NO_PLACE_REFUSAL)
    })

    await t.test('opening, reading, and releasing a wait write no event, line, or ping', async () => {
      await prepare()
      const before = await Promise.all([
        count('SELECT count(*)::int AS count FROM events'),
        count('SELECT count(*)::int AS count FROM room_lines'),
        count('SELECT count(*)::int AS count FROM pings'),
      ])
      const opened = await open()
      assert.equal(opened.ok, true)
      if (!opened.ok) return
      await readListening({ placeId: rooms.eastRoomId, limit: 10 })
      await releaseWait({ residentId: FOUNDER.id, leaseId: opened.answer.lease.lease_id })
      const after = await Promise.all([
        count('SELECT count(*)::int AS count FROM events'),
        count('SELECT count(*)::int AS count FROM room_lines'),
        count('SELECT count(*)::int AS count FROM pings'),
      ])
      assert.deepEqual(after, before)
    })

    await t.test('a quiet room still records a wait lease', async () => {
      await prepare()
      await db.query('UPDATE places SET quiet = TRUE WHERE id = $1', [rooms.eastRoomId])
      const result = await open()
      assert.equal(result.ok, true)
      assert.equal(await count('SELECT count(*)::int AS count FROM wait_leases WHERE place_id = $1', [rooms.eastRoomId]), 1)
    })
  } finally {
    await postgres.stop()
  }
})
