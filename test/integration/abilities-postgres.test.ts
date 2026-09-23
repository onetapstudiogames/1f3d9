// Wake on arrival, chance, and write (docs/DECISIONS.md rows 104 to 110) against real
// PostgreSQL: the additive migration, the real routes through src/index.ts, and one
// interactive transaction per engine action, settle claim, and wake try.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  bearer,
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'
// Loaded only after the fixture points src/db.ts at the test container.
const { rollCommitment, rollValue } = await import('../../src/engine-chance.ts')

const migrationDdl = await readFile(
  new URL('../../db/migrations/20260922_abilities_wake_chance_write.sql', import.meta.url),
  'utf8',
)

const FOUNDER = Object.freeze({ id: 1, handle: 'founder', secret: `1f3d9_sk_${'1'.repeat(48)}` })
const MAKER = Object.freeze({ id: 2, handle: 'bell-maker', secret: `1f3d9_sk_${'2'.repeat(48)}` })

type CityApp = Readonly<{ request: (input: string, init?: RequestInit) => Response | Promise<Response> }>
type Json = Record<string, unknown>

async function call(
  app: CityApp,
  secret: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Readonly<{ status: number; json: Json }>> {
  const response = await app.request(`http://city.test${path}`, {
    method,
    headers: secret === null ? {} : bearer(secret),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return Object.freeze({ status: response.status, json: text ? JSON.parse(text) as Json : {} })
}

async function coin(app: CityApp, secret: string, name: string, recipe: unknown) {
  return call(app, secret, 'POST', '/api/trait', { name, description: `${name} for the abilities suite`, recipe })
}

/** A kind at revision 1 listing the given traits, owned by `ownerId`, without a fee. */
async function seedKind(ownerId: number, name: string, traitIds: readonly number[]): Promise<number> {
  const db = connectedDatabase()
  const kindId = Number((await db.query<{ id: number }>(
    `INSERT INTO kinds (name, owner_id) VALUES ($1, $2) RETURNING id`, [name, ownerId],
  )).rows[0]!.id)
  const names = (await db.query<{ name: string }>(
    `SELECT name FROM traits WHERE id = ANY($1::int[]) ORDER BY array_position($1::int[], id)`, [traitIds],
  )).rows.map(row => row.name)
  // The kind_revision_trait_links trigger links each named trait in order.
  await db.query(
    `INSERT INTO kind_revisions (kind_id, revision, traits) VALUES ($1, 1, $2::text[])`, [kindId, names],
  )
  return kindId
}

/** One thing of the kind, owned and made by `ownerId`, standing in `placeId`. */
async function seedThing(
  ownerId: number,
  placeId: number,
  kindId: number | null,
  name: string,
  options: Readonly<{ wakeEnabled?: boolean }> = {},
): Promise<number> {
  return Number((await connectedDatabase().query<{ id: number }>(`
    INSERT INTO things (place_id, name, body, owner_id, maker_id, kind_id, birth_revision, current_revision, wake_enabled)
    VALUES ($1, $2, '', $3, $3, $4, $5, $5, $6) RETURNING id
  `, [placeId, name, ownerId, kindId, kindId === null ? null : 1, options.wakeEnabled === true])).rows[0]!.id)
}

async function traitId(name: string): Promise<number> {
  return Number((await connectedDatabase().query<{ id: number }>(
    'SELECT id FROM traits WHERE name = $1', [name],
  )).rows[0]!.id)
}

// Put the database back to how it stood before this change, so the migration meets
// existing rows exactly as production will.
const PRE_ABILITIES_DDL = `
  DROP TABLE thing_state_changes, chance_rolls, chance_days, wake_tries, wake_settles, thing_wake_state;
  DROP SEQUENCE chance_rolls_id_seq;
  DROP TRIGGER things_sleep_on_owner_change ON things;
  DROP FUNCTION sleep_thing_on_owner_change();
  ALTER TABLE things DROP COLUMN wake_enabled, DROP COLUMN state, DROP COLUMN state_version;
  ALTER TABLE places DROP COLUMN wake_visitors, DROP COLUMN wake_pins,
    DROP COLUMN wake_block_thing_ids, DROP COLUMN wake_block_resident_ids,
    DROP COLUMN wake_random_cap, DROP COLUMN rough_room;
`

test('things wake, roll, and write against real PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('abilities')
  try {
    await t.test('the abilities migration is additive and repeatable', async () => {
      const rooms = await resetCity([FOUNDER, MAKER])
      const db = connectedDatabase()
      await db.query(PRE_ABILITIES_DDL)
      const thingId = Number((await db.query<{ id: number }>(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id)
        VALUES ($1, 'old bell', 'made before abilities', 2, 2) RETURNING id
      `, [rooms.eastRoomId])).rows[0]!.id)

      await db.query(migrationDdl)
      await db.query(migrationDdl)

      const thing = (await db.query(`
        SELECT wake_enabled, state, state_version FROM things WHERE id = $1
      `, [thingId])).rows[0]
      assert.deepEqual(thing, { wake_enabled: false, state: {}, state_version: 0 })
      const place = (await db.query(`
        SELECT wake_visitors, wake_pins, wake_block_thing_ids, wake_block_resident_ids,
          wake_random_cap, rough_room
        FROM places WHERE id = $1
      `, [rooms.eastRoomId])).rows[0]
      assert.deepEqual(place, {
        wake_visitors: false,
        wake_pins: [],
        wake_block_thing_ids: [],
        wake_block_resident_ids: [],
        wake_random_cap: 8,
        rough_room: false,
      })
      const columns = (await db.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(`
        SELECT table_name, column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND ((table_name = 'things' AND column_name IN ('wake_enabled', 'state', 'state_version'))
            OR (table_name = 'places' AND column_name IN ('wake_visitors', 'wake_random_cap', 'rough_room')))
        ORDER BY table_name, column_name
      `)).rows
      assert.deepEqual(columns, [
        { table_name: 'places', column_name: 'rough_room', data_type: 'boolean', is_nullable: 'NO' },
        { table_name: 'places', column_name: 'wake_random_cap', data_type: 'smallint', is_nullable: 'NO' },
        { table_name: 'places', column_name: 'wake_visitors', data_type: 'boolean', is_nullable: 'NO' },
        { table_name: 'things', column_name: 'state', data_type: 'jsonb', is_nullable: 'NO' },
        { table_name: 'things', column_name: 'state_version', data_type: 'integer', is_nullable: 'NO' },
        { table_name: 'things', column_name: 'wake_enabled', data_type: 'boolean', is_nullable: 'NO' },
      ])

      // The owner-change trigger puts a received thing to sleep in every path that changes an owner.
      await db.query('UPDATE things SET wake_enabled = TRUE WHERE id = $1', [thingId])
      await db.query('UPDATE things SET owner_id = 1 WHERE id = $1', [thingId])
      assert.equal((await db.query('SELECT wake_enabled FROM things WHERE id = $1', [thingId])).rows[0]!.wake_enabled, false)

      // History tables refuse edits like the rest of the public record.
      await db.query(`INSERT INTO chance_days (day, secret, commitment) VALUES ('2026-01-01', decode(repeat('ab', 32), 'hex'), repeat('0', 64))`)
      await assert.rejects(db.query(`DELETE FROM chance_days`), /append-only/)
    })

    const { default: app } = await import('../../src/index.ts') as { default: CityApp }

    await t.test('the doors refuse what a wake program or a law may never carry', async () => {
      const rooms = await resetCity([FOUNDER, MAKER])
      await standIn(MAKER.id, rooms.eastRoomId)

      const handOver = await coin(app, MAKER.secret, 'gift-giver', {
        wake: { then: [{ effect: 'chance', percent: 50, then: [{ effect: 'transfer', target: 'source', to: 'actor' }] }] },
      })
      assert.equal(handOver.status, 400)
      assert.equal(handOver.json.error, 'a wake program may never hand a thing over, because nobody who arrives or speaks asked for it; drop the transfer step')

      const outside = await coin(app, MAKER.secret, 'far-reacher', {
        wake: { then: [{ effect: 'label', target: 'target', label: 'touched' }] },
      })
      assert.equal(outside.status, 400)
      assert.equal(outside.json.error, 'a wake try has no target or destination of its own; name actor, source, or place, and move only to home')

      const outOfRange = await coin(app, MAKER.secret, 'sure-thing', {
        use: [{ effect: 'chance', percent: 100, then: [] }],
      })
      assert.equal(outOfRange.status, 400)
      assert.equal(outOfRange.json.error, "recipe must use only the frozen actions, the wake key, and the effect bricks, each within its stated range; call physics for every brick's fields, defaults, and limits")

      const counter = await coin(app, MAKER.secret, 'counter', { use: [{ effect: 'write', key: 'visits', op: 'add' }] })
      assert.equal(counter.status, 201, JSON.stringify(counter.json))
      const greeter = await coin(app, MAKER.secret, 'greeter', {
        wake: { then: [{ effect: 'label', target: 'actor', label: 'greeted' }] },
      })
      assert.equal(greeter.status, 201, JSON.stringify(greeter.json))
      assert.deepEqual((greeter.json.trait as Json).recipe, {
        wake: { on: ['arrive'], every_seconds: 60, then: [{ effect: 'label', target: 'actor', label: 'greeted' }] },
      })
      const doorman = await coin(app, MAKER.secret, 'doorman', {
        wake: { on: ['talk'], then: [{ effect: 'block', target: 'actor', action: 'talk', seconds: 30 }] },
      })
      assert.equal(doorman.status, 201, 'coining allows a hold; the room decides when it runs')
      const lucky = await coin(app, MAKER.secret, 'lucky-floor', {
        talk: [{ effect: 'chance', percent: 50, then: [{ effect: 'label', target: 'actor', label: 'lucky' }] }],
      })
      assert.equal(lucky.status, 201)

      await connectedDatabase().query('UPDATE places SET owner_id = $1 WHERE id = $2', [MAKER.id, rooms.eastRoomId])
      for (const name of ['counter', 'greeter']) {
        const law = await call(app, MAKER.secret, 'PUT', `/api/place/${rooms.eastRoomId}/laws`, { traits: [name] })
        assert.equal(law.status, 400, name)
        assert.equal(law.json.error, `trait ${name} carries write or a wake key, which work only in a kind's traits; put it on a kind, or adopt a law trait without them`)
      }
      const chanceLaw = await call(app, MAKER.secret, 'PUT', `/api/place/${rooms.eastRoomId}/laws`, { traits: ['lucky-floor'] })
      assert.equal(chanceLaw.status, 200, 'chance works as a law')

      const twoClocks = await call(app, MAKER.secret, 'POST', '/api/kind', {
        name: 'two-clocks', description: 'two wake keys', traits: ['greeter', 'counter', 'doorman'],
      })
      assert.equal(twoClocks.status, 400)
      assert.equal(twoClocks.json.error, 'a kind may list only one trait with a wake key; greeter and doorman both carry one, so keep one of them')
    })

    await t.test('chance writes its roll before its branch and counts one effect', async () => {
      const rooms = await resetCity([FOUNDER, MAKER])
      await standIn(MAKER.id, rooms.eastRoomId)
      const flip = await coin(app, MAKER.secret, 'coin-flip', {
        use: [{
          effect: 'chance', percent: 50,
          then: [{ effect: 'label', target: 'source', label: 'heads' }],
          else: [{ effect: 'label', target: 'source', label: 'tails' }],
        }],
      })
      assert.equal(flip.status, 201)
      const flipTraitId = await traitId('coin-flip')
      const kindId = await seedKind(MAKER.id, 'coins', [flipTraitId])
      const thingId = await seedThing(MAKER.id, rooms.eastRoomId, kindId, 'a coin')

      const used = await call(app, MAKER.secret, 'POST', '/api/action', { action: 'use', thing_id: thingId })
      assert.equal(used.status, 200, JSON.stringify(used.json))
      const action = used.json.action as Json
      assert.equal(action.effects_applied, 2, 'the roll counts one application and its branch another')
      const rolls = action.rolls as Json[]
      assert.equal(rolls.length, 1)
      const [answer] = rolls as [Json]
      assert.equal(answer.percent, 50)
      assert.equal(answer.outcome, 'counted')
      assert.equal(answer.branch, Number(answer.roll) <= 50 ? 'then' : 'else')

      const db = connectedDatabase()
      const stored = (await db.query(`
        SELECT roll.id::int AS id, roll.purpose, roll.outcome, roll.place_id, roll.source_thing_id,
          roll.source_trait_id, roll.authority_id, roll.action_id::int AS action_id, roll.percent,
          roll.sides, roll.roll, roll.branch, encode(day.secret, 'hex') AS secret, day.commitment
        FROM chance_rolls roll JOIN chance_days day ON day.day = roll.day
        WHERE roll.id = $1
      `, [answer.roll_id])).rows[0]!
      assert.deepEqual({ ...stored, secret: undefined, commitment: undefined }, {
        id: answer.roll_id, purpose: 'chance', outcome: 'counted', place_id: rooms.eastRoomId,
        source_thing_id: thingId, source_trait_id: flipTraitId, authority_id: MAKER.id,
        action_id: action.id, percent: 50, sides: 100, roll: answer.roll, branch: answer.branch,
        secret: undefined, commitment: undefined,
      })
      assert.equal(rollValue(String(stored.secret), {
        rollId: Number(answer.roll_id), purpose: 'chance', placeId: rooms.eastRoomId,
        sourceThingId: thingId, sourceTraitId: flipTraitId, sides: 100,
      }), answer.roll, 'the stored roll is exactly the published formula')
      assert.equal(rollCommitment(String(stored.secret)), stored.commitment)
      const label = (await db.query(
        `SELECT label FROM active_labels WHERE target_type = 'thing' AND target_id = $1`, [thingId],
      )).rows.map(row => row.label)
      assert.deepEqual(label, [answer.branch === 'then' ? 'heads' : 'tails'])

      // The roll is written down before its branch runs, and before the action resolves.
      const events = (await db.query(`
        SELECT id::int AS id, kind, detail FROM events
        WHERE kind IN ('chance_rolled', 'action') ORDER BY id
      `)).rows
      assert.deepEqual(events.map(event => event.kind), ['chance_rolled', 'action'])
      assert.deepEqual(events[0]!.detail, {
        roll_id: answer.roll_id, purpose: 'chance', thing_id: thingId, place_id: rooms.eastRoomId,
        action_id: action.id, settle_id: null, status: answer.branch, percent: 50, roll: answer.roll,
        sides: 100, day: events[0]!.detail.day, commitment: stored.commitment, outcome: 'counted',
      })

      const read = await call(app, null, 'GET', `/api/physics?roll_id=${answer.roll_id}`)
      assert.equal(read.status, 200)
      const roll = read.json.roll as Json
      assert.equal(roll.secret, null, "today's secret stays private until the day ends")
      assert.equal(roll.commitment, stored.commitment)
      assert.equal(roll.roll, answer.roll)
      assert.equal(roll.outcome, 'counted')
      assert.equal(typeof roll.secret_revealed_after, 'string')

      const physics = await call(app, null, 'GET', '/api/physics')
      const days = physics.json.chance_days as Json[]
      assert.equal(days.length, 2, "today's and tomorrow's fingerprints are both public")
      assert.equal(days.some(day => 'secret' in day), false)
      assert.equal(days[0]!.commitment, stored.commitment)
    })

    await t.test('a roll drawn in a failed action is still public and verifiable', async () => {
      const rooms = await resetCity([FOUNDER, MAKER])
      await standIn(MAKER.id, rooms.eastRoomId)
      assert.equal((await coin(app, MAKER.secret, 'dud-flip', {
        use: [{
          effect: 'chance', percent: 50,
          then: [{ effect: 'destroy', target: 'target' }],
          else: [{ effect: 'destroy', target: 'target' }],
        }],
      })).status, 201)
      const kindId = await seedKind(MAKER.id, 'duds', [await traitId('dud-flip')])
      const thingId = await seedThing(MAKER.id, rooms.eastRoomId, kindId, 'a dud')

      const used = await call(app, MAKER.secret, 'POST', '/api/action', { action: 'use', thing_id: thingId })
      assert.equal(used.status, 403, JSON.stringify(used.json))
      const action = used.json.action as Json
      assert.equal(action.status, 'failed')
      const [answer] = action.rolls as [Json]
      assert.equal(answer.outcome, 'action_failed')

      const db = connectedDatabase()
      const stored = (await db.query(
        `SELECT outcome, roll, action_id::int AS action_id FROM chance_rolls WHERE id = $1`, [answer.roll_id],
      )).rows[0]
      assert.deepEqual(stored, { outcome: 'action_failed', roll: answer.roll, action_id: action.id })
      const event = (await db.query(
        `SELECT detail FROM events WHERE kind = 'chance_rolled' AND (detail->>'roll_id')::bigint = $1`,
        [answer.roll_id],
      )).rows
      assert.equal(event.length, 1)
      assert.equal(event[0]!.detail.outcome, 'action_failed')
      const read = await call(app, null, 'GET', `/api/physics?roll_id=${answer.roll_id}`)
      assert.equal(read.status, 200)
      assert.equal((read.json.roll as Json).outcome, 'action_failed')
    })

    await t.test("the day secret stays private until its UTC day ends, then proves every roll", async () => {
      const rooms = await resetCity([FOUNDER, MAKER])
      const db = connectedDatabase()
      const secret = 'cd'.repeat(32)
      await db.query(`
        INSERT INTO chance_days (day, secret, commitment, created_at)
        VALUES ((now() AT TIME ZONE 'UTC')::date - 1, decode($1, 'hex'), $2, now() - interval '2 days')
      `, [secret, rollCommitment(secret)])
      const rollId = Number((await db.query(`SELECT nextval('chance_rolls_id_seq')::int AS id`)).rows[0]!.id)
      const roll = rollValue(secret, {
        rollId, purpose: 'chance', placeId: rooms.eastRoomId, sourceThingId: null, sourceTraitId: null, sides: 100,
      })
      await db.query(`
        INSERT INTO chance_rolls (id, day, purpose, place_id, authority_id, percent, sides, roll, branch)
        VALUES ($1, (now() AT TIME ZONE 'UTC')::date - 1, 'chance', $2, 2, 40, 100, $3, $4)
      `, [rollId, rooms.eastRoomId, roll, roll <= 40 ? 'then' : 'else'])

      const read = await call(app, null, 'GET', `/api/physics?roll_id=${rollId}`)
      assert.equal(read.status, 200)
      const published = read.json.roll as Json
      assert.equal(published.secret, secret)
      assert.equal(published.committed_before_day, true)
      assert.equal(rollCommitment(String(published.secret)), published.commitment)
      assert.equal(published.roll, roll)

      const zero = await call(app, null, 'GET', '/api/physics?roll_id=0')
      assert.equal(zero.status, 400)
      assert.equal(zero.json.error, 'roll_id must be a positive whole number')
      const missing = await call(app, null, 'GET', '/api/physics?roll_id=999999')
      assert.equal(missing.status, 404)
      assert.equal(missing.json.error, 'roll 999999 was not found; read a roll_id from a chance_rolled event, a room settle, or an action answer')
    })
  } finally {
    await postgres.stop()
  }
})
