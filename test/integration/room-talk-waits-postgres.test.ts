import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
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
  waitAlreadyOpenRefusal,
  WAIT_NO_PLACE_REFUSAL,
} from '../../src/room-talk-contract.ts'

const RESIDENTS = [FOUNDER, GROWER, NEIGHBOUR] as const
const SECONDS = leaseSeconds(30)!

async function waitForPresenceLockWait(): Promise<void> {
  const db = connectedDatabase()
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const waiting = await db.query<{ waiting: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query LIKE '%FOR SHARE OF presence%'
      ) AS waiting
    `)
    if (waiting.rows[0]!.waiting) return
    await delay(10)
  }
  assert.fail('openWait did not wait for the move lock')
}

test('room waits use temporary leases against real PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('room-talk-waits')
  try {
    let rooms = await resetCity(RESIDENTS)
    await standIn(FOUNDER.id, rooms.eastRoomId)
    await standIn(GROWER.id, rooms.westRoomId)
    await standIn(NEIGHBOUR.id, rooms.westRoomId)

    const { openWait, readListening, readWaitChanges, releaseWait } = await import('../../src/room-wait-store.ts')
    const { sayLine } = await import('../../src/room-line-store.ts')
    const { answerPing, invitePing } = await import('../../src/room-ping-store.ts')
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
    const checkpoint = async () => String((await db.query<{ checkpoint: string }>(`
      SELECT current_change_id::text AS checkpoint
      FROM public_change_state WHERE singleton = true
    `)).rows[0]!.checkpoint)
    const cursorsAtCheckpoint = async () => {
      const marker = await checkpoint()
      return { line: marker, ping: marker }
    }
    const openLease = async (resident: Readonly<{ id: number }> = FOUNDER) => {
      const result = await open(resident)
      if (!result.ok) assert.fail(result.refusal.error)
      return result.answer.lease
    }

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

    await t.test('a move that commits while openWait waits gives the lease to the new place', async () => {
      await prepare()
      const holder = await db.connect()
      try {
        await holder.query('BEGIN')
        await holder.query(
          'UPDATE resident_presence SET current_place_id = $2 WHERE resident_id = $1',
          [FOUNDER.id, rooms.westRoomId],
        )
        const opening = open()
        await waitForPresenceLockWait()
        await holder.query('COMMIT')
        const result = await opening
        assert.equal(result.ok, true)
        if (!result.ok) return
        assert.equal(result.answer.lease.place_id, rooms.westRoomId)
        const stored = (await db.query<{ place_id: number }>(
          'SELECT place_id FROM wait_leases WHERE resident_id = $1', [FOUNDER.id],
        )).rows[0]!
        assert.equal(stored.place_id, rooms.westRoomId)
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined)
        holder.release()
      }
    })

    await t.test("a second open wait is refused with the open lease's end time in open_until and in the sentence", async () => {
      await prepare()
      const first = await open()
      assert.equal(first.ok, true)
      if (!first.ok) return
      const second = await open()
      assert.equal(second.ok, false)
      if (!second.ok) assert.deepEqual(second.refusal, waitAlreadyOpenRefusal(first.answer.lease.expires_at))
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

    await t.test('wait changes return new lines oldest first by change, capped at fifty with has_more and the cursor of the fiftieth', async () => {
      await prepare()
      await standIn(GROWER.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      const lease = await openLease()
      const cursors = await cursorsAtCheckpoint()
      const lineIds: number[] = []
      const bodies: string[] = []
      const writers = [FOUNDER, GROWER, NEIGHBOUR] as const

      for (let index = 0; index < 51; index += 1) {
        const writer = writers[index % writers.length]!
        const body = `wait-line-${String(index + 1).padStart(2, '0')}`
        const inserted = (await db.query<{ id: number }>(`
          INSERT INTO room_lines (place_id, resident_id, body, body_bytes, request_id)
          VALUES ($1, $2, $3, $4, $5::uuid)
          RETURNING id
        `, [rooms.eastRoomId, writer.id, body, Buffer.byteLength(body, 'utf8'), randomUUID()])).rows[0]!
        const lineId = Number(inserted.id)
        await db.query(`
          INSERT INTO events (at, kind, actor, detail)
          VALUES (clock_timestamp(), 'line_said', $1,
            jsonb_build_object('line_id', $2::int, 'place_id', $3::int))
        `, [writer.handle, lineId, rooms.eastRoomId])
        lineIds.push(lineId)
        bodies.push(body)
      }

      const markers = (await db.query<{ line_id: string; change_id: string }>(`
        SELECT e.detail->>'line_id' AS line_id, pcl.change_id::text AS change_id
        FROM public_change_log pcl
        JOIN events e ON e.id = pcl.event_id
        WHERE e.kind = 'line_said' AND e.detail->>'line_id' = ANY($1::text[])
        ORDER BY pcl.change_id ASC
      `, [lineIds.map(String)])).rows
      const result = await readWaitChanges({
        residentId: FOUNDER.id,
        leaseId: lease.lease_id,
        placeId: rooms.eastRoomId,
        cursors,
      })

      assert.equal(result.linesHasMore, true)
      assert.equal(result.lines.length, 50)
      assert.deepEqual(result.lines.map(line => line.body), bodies.slice(0, 50))
      assert.deepEqual(result.lines.map(line => line.id), markers.slice(0, 50).map(row => Number(row.line_id)))
      assert.equal(result.next.line, markers[49]!.change_id)
      assert.equal(result.pingsHasMore, false)

      const remaining = await readWaitChanges({
        residentId: FOUNDER.id,
        leaseId: lease.lease_id,
        placeId: rooms.eastRoomId,
        cursors: result.next,
      })
      assert.deepEqual(remaining.lines.map(line => line.id), [lineIds[50]])
      assert.equal(remaining.linesHasMore, false)
    })

    await t.test('an empty wait read advances both cursors to the change checkpoint', async () => {
      await prepare()
      const lease = await openLease()
      const cursors = await cursorsAtCheckpoint()
      const line = await sayLine({
        residentId: GROWER.id,
        residentHandle: GROWER.handle,
        placeId: rooms.westRoomId,
        body: 'a line in another place',
        requestId: randomUUID(),
      })
      if (!line.ok) assert.fail(line.refusal.error)
      const ping = await invitePing({
        residentId: GROWER.id,
        residentHandle: GROWER.handle,
        toHandle: NEIGHBOUR.handle,
        requestId: randomUUID(),
      })
      if (!ping.ok) assert.fail(ping.refusal.error)
      const marker = await checkpoint()
      assert.ok(BigInt(marker) > BigInt(cursors.line))
      const result = await readWaitChanges({
        residentId: FOUNDER.id,
        leaseId: lease.lease_id,
        placeId: rooms.eastRoomId,
        cursors,
      })

      assert.deepEqual(result.lines, [])
      assert.deepEqual(result.pings, [])
      assert.deepEqual(result.next, { line: marker, ping: marker })
      assert.equal(result.still, 'here')
    })

    await t.test('a line committed out of id order is still returned by the next wait', async () => {
      await prepare()
      await standIn(GROWER.id, rooms.eastRoomId)
      const lease = await openLease()
      const cursors = await cursorsAtCheckpoint()
      const firstWriter = await db.connect()
      try {
        await firstWriter.query('BEGIN')
        const lowerBody = 'lower id committed later'
        const lower = (await firstWriter.query<{ id: number }>(`
          INSERT INTO room_lines (place_id, resident_id, body, body_bytes, request_id)
          VALUES ($1, $2, $3, $4, $5::uuid)
          RETURNING id
        `, [rooms.eastRoomId, FOUNDER.id, lowerBody, Buffer.byteLength(lowerBody, 'utf8'), randomUUID()])).rows[0]!
        const higher = await sayLine({
          residentId: GROWER.id,
          residentHandle: GROWER.handle,
          placeId: rooms.eastRoomId,
          body: 'higher id committed first',
          requestId: randomUUID(),
        })
        if (!higher.ok) assert.fail(higher.refusal.error)
        assert.ok(Number(lower.id) < higher.answer.line.id)

        const firstRead = await readWaitChanges({
          residentId: FOUNDER.id,
          leaseId: lease.lease_id,
          placeId: rooms.eastRoomId,
          cursors,
        })
        assert.deepEqual(firstRead.lines.map(line => line.id), [higher.answer.line.id])

        await firstWriter.query(`
          INSERT INTO events (at, kind, actor, detail)
          VALUES (clock_timestamp(), 'line_said', $1,
            jsonb_build_object('line_id', $2::int, 'place_id', $3::int))
        `, [FOUNDER.handle, lower.id, rooms.eastRoomId])
        await firstWriter.query('COMMIT')

        const secondRead = await readWaitChanges({
          residentId: FOUNDER.id,
          leaseId: lease.lease_id,
          placeId: rooms.eastRoomId,
          cursors: firstRead.next,
        })
        assert.deepEqual(secondRead.lines.map(line => line.id), [Number(lower.id)])
      } finally {
        await firstWriter.query('ROLLBACK').catch(() => undefined)
        firstWriter.release()
      }
    })

    await t.test('wait changes return the pings that name the resident, an invitation or an answer, and no others', async () => {
      await prepare()
      await standIn(GROWER.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      const lease = await openLease()
      const cursors = await cursorsAtCheckpoint()
      const invite = async (
        resident: Readonly<{ id: number; handle: string }>,
        target: Readonly<{ handle: string }>,
      ) => {
        const result = await invitePing({
          residentId: resident.id,
          residentHandle: resident.handle,
          toHandle: target.handle,
          requestId: randomUUID(),
        })
        if (!result.ok) assert.fail(result.refusal.error)
        return result.answer.ping
      }
      const founderInvite = await invite(FOUNDER, GROWER)
      await invite(GROWER, NEIGHBOUR)
      const neighbourInvite = await invite(NEIGHBOUR, FOUNDER)
      const answer = await answerPing({
        residentId: GROWER.id,
        residentHandle: GROWER.handle,
        pingId: founderInvite.id,
        answer: 'yes',
        requestId: randomUUID(),
      })
      if (!answer.ok) assert.fail(answer.refusal.error)

      const result = await readWaitChanges({
        residentId: FOUNDER.id,
        leaseId: lease.lease_id,
        placeId: rooms.eastRoomId,
        cursors,
      })

      assert.deepEqual(result.pings.map(entry => entry.kind), ['ping_sent', 'ping_answered'])
      assert.deepEqual(result.pings.map(entry => entry.ping.id), [neighbourInvite.id, founderInvite.id])
      assert.equal(result.pings[0]!.ping.status, 'offered')
      assert.equal(result.pings[1]!.ping.status, 'answered')
      assert.equal(result.pingsHasMore, false)
    })

    await t.test('a resident who moved reads moved', async () => {
      await prepare()
      const lease = await openLease()
      const cursors = await cursorsAtCheckpoint()
      await standIn(FOUNDER.id, rooms.westRoomId)

      const result = await readWaitChanges({
        residentId: FOUNDER.id,
        leaseId: lease.lease_id,
        placeId: rooms.eastRoomId,
        cursors,
      })
      assert.equal(result.still, 'moved')
    })

    await t.test('a released lease reads moved', async () => {
      await prepare()
      const lease = await openLease()
      const cursors = await cursorsAtCheckpoint()
      assert.deepEqual(await releaseWait({ residentId: FOUNDER.id, leaseId: lease.lease_id }), { released: true })

      const result = await readWaitChanges({
        residentId: FOUNDER.id,
        leaseId: lease.lease_id,
        placeId: rooms.eastRoomId,
        cursors,
      })
      assert.equal(result.still, 'moved')
    })
  } finally {
    await postgres.stop()
  }
})
