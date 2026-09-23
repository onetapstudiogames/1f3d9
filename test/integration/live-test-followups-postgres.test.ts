// Follow-ups from the 2026-09-23 live test of the abilities release, against real
// PostgreSQL through the real routes in src/index.ts.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import {
  FOUNDER, GROWER, call, coin, seedKind, seedThing, traitId, use, type CityApp, type Json,
} from '../helpers/abilities-fixtures.ts'
import {
  bearer,
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

// Loaded only after the fixture points src/db.ts at the test container.
const { issueCityFeeCredit } = await import('../../src/city-credit.ts')
const { PUBLIC_THING_LABELS_MAX } = await import('../../src/read-limits.ts')

function creditRequestId(): string {
  return `fee-${randomBytes(16).toString('hex')}`
}

async function fundOneCredit(residentId: number): Promise<void> {
  const db = connectedDatabase()
  const issued = await issueCityFeeCredit({
    query: async (text, params = []) => (await db.query(text, [...params])).rows,
  }, {
    founderId: FOUNDER.id,
    residentId,
    sourceKey: `live-test-followups-${randomBytes(6).toString('hex')}`,
    reason: 'fund one kind revision in the live-test follow-up suite',
  })
  assert.equal(issued.disposition, 'created')
}

async function creditUnits(residentId: number): Promise<string> {
  return String((await connectedDatabase().query(
    `SELECT coalesce((SELECT balance_units::text FROM city_credit_accounts WHERE resident_id = $1), '0') AS units`,
    [residentId],
  )).rows[0]!.units)
}

async function revise(
  app: CityApp,
  kindId: number,
  body: Json,
  requestId: string | null,
): Promise<Readonly<{ status: number; json: Json }>> {
  const response = await app.request(`http://city.test/api/kind/${kindId}/revise`, {
    method: 'POST',
    headers: {
      ...bearer(GROWER.secret),
      ...(requestId === null ? {} : { 'x-1f3d9-fee-credit': requestId }),
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return Object.freeze({ status: response.status, json: text ? JSON.parse(text) as Json : {} })
}

test('live-test follow-ups against real PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('live-test-followups')
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }

    await t.test('a revision identical to the current one is refused before any fee', async () => {
      await resetCity([FOUNDER, GROWER])
      for (const name of ['moss', 'fern']) {
        assert.equal((await coin(app, GROWER.secret, name, null)).status, 201, name)
      }
      const lichen = await seedKind(GROWER.id, 'lichen', [await traitId('moss')])
      await fundOneCredit(GROWER.id)

      for (const [body, requestId] of [
        [{ traits: ['moss'] }, creditRequestId()],
        [{}, creditRequestId()],
        [{ traits: ['moss'], description: '', recipe: [] }, null],
      ] as const) {
        const refused = await revise(app, lichen, body, requestId)
        assert.equal(refused.status, 409, JSON.stringify(refused.json))
        assert.equal(
          refused.json.error,
          `this revision is identical to the current revision 1 of kind ${lichen}, so there is nothing to pay for and nothing was charged; change the description, traits, recipe, drawing, or drawing_variants before revising`,
        )
      }
      const db = connectedDatabase()
      assert.equal(await creditUnits(GROWER.id), '1000000', 'no credit was spent')
      assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM payment_attempts')).rows[0]!.n), 0, 'no payment was opened')
      assert.equal(Number((await db.query('SELECT current_revision FROM kinds WHERE id = $1', [lichen])).rows[0]!.current_revision), 1)

      // The same traits in another order are a change, and a real change is still paid.
      const changed = await revise(app, lichen, { traits: ['fern', 'moss'] }, creditRequestId())
      assert.equal(changed.status, 200, JSON.stringify(changed.json))
      assert.equal((changed.json.kind as Json).revision, 2)
      assert.equal(await creditUnits(GROWER.id), '0', 'the change spent its one credit')
    })

    await t.test('a revision names the traits its new list left out', async () => {
      await resetCity([FOUNDER, GROWER])
      for (const name of ['moss', 'fern', 'ivy', 'oak-bark']) {
        assert.equal((await coin(app, GROWER.secret, name, null)).status, 201, name)
      }
      const lichen = await seedKind(GROWER.id, 'lichen', [
        await traitId('moss'), await traitId('fern'), await traitId('ivy'),
      ])
      await fundOneCredit(GROWER.id)
      await fundOneCredit(GROWER.id)

      // traits replaces the whole list: sending [fern, oak-bark] drops moss and ivy.
      const replaced = await revise(app, lichen, { traits: ['fern', 'oak-bark'] }, creditRequestId())
      assert.equal(replaced.status, 200, JSON.stringify(replaced.json))
      assert.deepEqual((replaced.json.kind as Json).traits, ['fern', 'oak-bark'])
      assert.deepEqual(replaced.json.dropped_traits, ['moss', 'ivy'])
      assert.equal(
        replaced.json.dropped_traits_note,
        'traits replaces the whole list, so revision 2 left out moss, ivy that revision 1 had; to keep a trait, send it in traits with the rest',
      )

      // Keeping every trait and adding one drops nothing, and says nothing about it.
      const kept = await revise(app, lichen, { traits: ['fern', 'oak-bark', 'moss'] }, creditRequestId())
      assert.equal(kept.status, 200, JSON.stringify(kept.json))
      assert.deepEqual(kept.json.dropped_traits, [])
      assert.equal('dropped_traits_note' in kept.json, false)
    })

    await t.test('a public thing read shows its current labels, newest first and capped', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      await standIn(GROWER.id, rooms.eastRoomId)
      const db = connectedDatabase()
      await db.query('UPDATE places SET owner_id = $1 WHERE id = $2', [GROWER.id, rooms.eastRoomId])
      assert.equal((await coin(app, GROWER.secret, 'soaking', {
        use: [{ effect: 'label', target: 'source', label: 'wet' }],
      })).status, 201)
      const sponge = await seedKind(GROWER.id, 'sponge', [await traitId('soaking')])
      const thingId = await seedThing(GROWER.id, rooms.eastRoomId, sponge, 'a sponge')
      // An expired label never shows.
      await db.query(`
        INSERT INTO active_labels (target_type, target_id, label, actor_id, created_at, expires_at)
        VALUES ('thing', $1, 'dried', $2, now() - interval '2 hours', now() - interval '1 hour')
      `, [thingId, GROWER.id])
      const used = await use(app, GROWER.secret, thingId)
      assert.equal(used.status, 200, JSON.stringify(used.json))

      const read = await call(app, null, 'GET', `/api/thing/${thingId}`)
      assert.equal(read.status, 200, JSON.stringify(read.json))
      const thing = read.json.thing as Json
      const labels = thing.labels as Json[]
      assert.equal(labels.length, 1, JSON.stringify(labels))
      assert.equal(labels[0]!.label, 'wet')
      assert.equal(labels[0]!.set_by, GROWER.handle)
      assert.match(String(labels[0]!.set_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
      assert.equal(labels[0]!.expires_at, null)
      assert.equal(thing.labels_total, 1)

      // Past the cap, the read keeps the newest 32 and counts every current label.
      for (let index = 0; index < 33; index += 1) {
        await db.query(`
          INSERT INTO active_labels (target_type, target_id, label, actor_id, expires_at)
          VALUES ('thing', $1, $2, $3, now() + interval '1 day')
        `, [thingId, `mark-${index}`, GROWER.id])
      }
      const capped = (await call(app, null, 'GET', `/api/thing/${thingId}`)).json.thing as Json
      const shown = (capped.labels as Json[]).map(entry => entry.label)
      assert.equal(PUBLIC_THING_LABELS_MAX, 32)
      assert.equal(shown.length, PUBLIC_THING_LABELS_MAX, 'the read and the stated cap agree')
      assert.equal(shown[0], 'mark-32', 'newest first')
      assert.equal(shown.includes('wet'), false, 'the oldest current label falls past the cap')
      assert.equal(capped.labels_total, 34)
      assert.notEqual((capped.labels as Json[])[0]!.expires_at, null)
    })

    await t.test('me reports the settle it caused, in the shape a move uses', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      await standIn(GROWER.id, rooms.eastRoomId)
      const db = connectedDatabase()
      await db.query('UPDATE places SET owner_id = $1 WHERE id = $2', [GROWER.id, rooms.eastRoomId])
      assert.equal((await coin(app, GROWER.secret, 'ticking', {
        wake: { on: ['clock'], every_seconds: 10, then: [{ effect: 'write', key: 'ticks', op: 'add' }] },
      })).status, 201)
      const clock = await seedKind(GROWER.id, 'clock', [await traitId('ticking')])
      const clockThing = await seedThing(GROWER.id, rooms.eastRoomId, clock, 'a clock')
      await db.query('UPDATE things SET wake_enabled = TRUE WHERE id = $1', [clockThing])

      // The first visit only anchors the clock; nothing is owed, so no settle is reported.
      const first = await call(app, GROWER.secret, 'GET', '/api/me')
      assert.equal(first.status, 200, JSON.stringify(first.json))
      assert.equal('settle' in first.json, false)

      await db.query(`UPDATE thing_wake_state SET clock_at = clock_at - interval '25 seconds'`)
      const second = await call(app, GROWER.secret, 'GET', '/api/me')
      assert.equal(second.status, 200, JSON.stringify(second.json))
      const settled = (await db.query(
        `SELECT detail FROM events WHERE kind = 'room_settled' ORDER BY id DESC LIMIT 1`,
      )).rows[0]!.detail as Json
      assert.equal(settled.mode, 'me')
      assert.deepEqual(second.json.settle, {
        settle_id: settled.settle_id,
        tried: settled.tried,
        woke: settled.woke,
        forfeited: settled.forfeited,
      })
      assert.equal(settled.tried, 2)
      assert.equal(settled.woke, 2)
    })

    await t.test('an applied use that waits keeps its public action row; a destroy still stands in for it', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      await standIn(GROWER.id, rooms.eastRoomId)
      const db = connectedDatabase()
      await db.query('UPDATE places SET owner_id = $1 WHERE id = $2', [GROWER.id, rooms.eastRoomId])
      const recipes: ReadonlyArray<readonly [string, Json, string, number]> = [
        ['dripping', { use: [{ effect: 'wait', seconds: 60, then: [{ effect: 'label', target: 'source', label: 'dry' }] }] }, 'effect_scheduled', 1],
        ['spreading', { use: [{ effect: 'reach', then: [{ effect: 'wait', seconds: 60, then: [{ effect: 'label', target: 'target', label: 'dried' }] }] }] }, 'effect_scheduled', 1],
        // Decision #117 keeps the documented exception: a destroy's thing_withdrawn stands in.
        ['crumbling', { use: [{ effect: 'destroy', target: 'source' }] }, 'thing_withdrawn', 0],
      ]
      // One plain thing of the owner's own for the reach to find.
      await seedThing(GROWER.id, rooms.eastRoomId, null, 'a plain stone')
      for (const [name, recipe, typedEvent, actionRows] of recipes) {
        assert.equal((await coin(app, GROWER.secret, name, recipe)).status, 201, name)
        const kind = await seedKind(GROWER.id, `${name}-kind`, [await traitId(name)])
        const thingId = await seedThing(GROWER.id, rooms.eastRoomId, kind, `a ${name} thing`)
        const used = await use(app, GROWER.secret, thingId)
        assert.equal(used.status, 200, `${name}: ${JSON.stringify(used.json)}`)
        const actionId = Number((await db.query('SELECT max(id)::int AS id FROM action_runs')).rows[0]!.id)
        const rows = (await db.query(
          `SELECT detail FROM events WHERE kind = 'action' AND (detail->>'action_id')::int = $1`,
          [actionId],
        )).rows
        assert.equal(rows.length, actionRows, `${name}: ${actionRows} public action row`)
        if (actionRows === 1) {
          const detail = rows[0]!.detail as Json
          assert.equal(detail.status, 'applied', name)
          assert.equal(detail.source_thing_id, thingId, name)
          assert.equal(detail.place_id, rooms.eastRoomId, name)
          assert.ok(Number(detail.effects_applied) >= 1, name)
        }
        const typed = Number((await db.query(
          'SELECT count(*)::int AS n FROM events WHERE kind = $1', [typedEvent],
        )).rows[0]!.n)
        assert.ok(typed >= 1, `${name}: its ${typedEvent} event is still written beside the row`)
      }
    })
  } finally {
    await postgres.stop()
  }
})
