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
const { rollCommitment, rollValue, wakePickKey } = await import('../../src/engine-chance.ts')
const { settleRoom } = await import('../../src/engine-settle.ts')

const migrationDdl = await readFile(
  new URL('../../db/migrations/20260922_abilities_wake_chance_write.sql', import.meta.url),
  'utf8',
)

const FOUNDER = Object.freeze({ id: 1, handle: 'founder', secret: `1f3d9_sk_${'1'.repeat(48)}` })
const MAKER = Object.freeze({ id: 2, handle: 'bell-maker', secret: `1f3d9_sk_${'2'.repeat(48)}` })
const VISITOR = Object.freeze({ id: 3, handle: 'far-walker', secret: `1f3d9_sk_${'3'.repeat(48)}` })

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


/**
 * Move a room's recent settles and its things' last tries into the past, so a
 * test can step past the ten-second quiet and "not more often than" without
 * waiting. The append-only guard is paused only for this test-time shift.
 */
async function ageRoom(placeId: number, seconds: number): Promise<void> {
  const db = connectedDatabase()
  await db.query('ALTER TABLE wake_settles DISABLE TRIGGER wake_settles_append_only')
  try {
    await db.query(
      'UPDATE wake_settles SET created_at = created_at - make_interval(secs => $2) WHERE place_id = $1',
      [placeId, seconds],
    )
  } finally {
    await db.query('ALTER TABLE wake_settles ENABLE TRIGGER wake_settles_append_only')
  }
  await db.query(`
    UPDATE thing_wake_state SET last_try_at = last_try_at - make_interval(secs => $2)
    WHERE thing_id IN (SELECT id FROM things WHERE place_id = $1)
  `, [placeId, seconds])
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

    await t.test("write changes only its own thing's box, bumps its version, and never its words", async () => {
      const rooms = await resetCity([FOUNDER, MAKER, VISITOR])
      await standIn(MAKER.id, rooms.eastRoomId)
      await standIn(VISITOR.id, rooms.eastRoomId)
      assert.equal((await coin(app, MAKER.secret, 'guestbook', {
        use: [
          { effect: 'write', key: 'visits', op: 'add' },
          { effect: 'write', key: 'guests', op: 'append', value: { from: 'actor' } },
          { effect: 'chance', percent: 99, then: [], else: [] },
          { effect: 'write', key: 'last-roll', value: { from: 'roll' } },
          { effect: 'write', key: 'open', value: true },
        ],
      })).status, 201)
      const bookTraitId = await traitId('guestbook')
      const kindId = await seedKind(MAKER.id, 'books', [bookTraitId])
      const bookId = await seedThing(MAKER.id, rooms.eastRoomId, kindId, 'the guestbook')
      const neighbourId = await seedThing(MAKER.id, rooms.eastRoomId, kindId, 'another book')
      const db = connectedDatabase()
      await db.query('UPDATE things SET body = $2, open_to_use = TRUE WHERE id = $1', [bookId, 'sign here, please'])

      const own = await call(app, MAKER.secret, 'POST', '/api/action', { action: 'use', thing_id: bookId })
      assert.equal(own.status, 200, JSON.stringify(own.json))
      assert.equal((own.json.action as Json).effects_applied, 5)
      const shared = await call(app, VISITOR.secret, 'POST', '/api/action', { action: 'use', thing_id: bookId })
      assert.equal(shared.status, 200, JSON.stringify(shared.json))
      const lastRoll = ((shared.json.action as Json).rolls as Json[])[0]!.roll

      const read = await call(app, null, 'GET', `/api/thing/${bookId}`)
      assert.equal(read.status, 200)
      const thing = read.json.thing as Json
      assert.equal(thing.name, 'the guestbook')
      assert.equal(thing.body, 'sign here, please', "the owner's words are never touched")
      const state = thing.state as Json
      assert.equal(state.version, 8)
      assert.deepEqual(state.values, {
        visits: 2, guests: ['bell-maker', 'far-walker'], 'last-roll': lastRoll, open: true,
      })
      const lastWrite = state.last_write as Json
      assert.deepEqual({ ...lastWrite, at: undefined }, {
        version: 8, key: 'open', op: 'set', trimmed: 0, source_trait: 'guestbook',
        source_trait_id: bookTraitId, trigger: 'use', by: 'far-walker', at: undefined,
      })
      assert.match(String(lastWrite.at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
      const neighbour = (await call(app, null, 'GET', `/api/thing/${neighbourId}`)).json.thing as Json
      assert.deepEqual(neighbour.state, { version: 0, values: {}, last_write: null })

      const history = (await db.query(`
        SELECT version, key, op, trigger, resident_id, authority_id FROM thing_state_changes
        WHERE thing_id = $1 ORDER BY version
      `, [bookId])).rows
      assert.equal(history.length, 8)
      assert.deepEqual(history[5], {
        version: 6, key: 'guests', op: 'append', trigger: 'use', resident_id: VISITOR.id, authority_id: VISITOR.id,
      })
      const stateEvents = (await db.query(`
        SELECT count(*)::int AS events FROM events
        WHERE kind = 'thing_edited' AND detail->>'mode' = 'state' AND (detail->>'thing_id')::int = $1
      `, [bookId])).rows[0]!.events
      assert.equal(stateEvents, 8)
    })

    await t.test('write refuses in caller words, and the owner may empty the box', async () => {
      const rooms = await resetCity([FOUNDER, MAKER])
      await standIn(MAKER.id, rooms.eastRoomId)
      assert.equal((await coin(app, MAKER.secret, 'rollless', {
        use: [{ effect: 'write', key: 'luck', value: { from: 'roll' } }],
      })).status, 201)
      assert.equal((await coin(app, MAKER.secret, 'namer', {
        use: [{ effect: 'write', key: 'visits', value: 'many' }],
      })).status, 201)
      assert.equal((await coin(app, MAKER.secret, 'counter', {
        use: [{ effect: 'write', key: 'visits', op: 'add' }],
      })).status, 201)
      const rolllessKind = await seedKind(MAKER.id, 'rollless-kind', [await traitId('rollless')])
      const rolllessId = await seedThing(MAKER.id, rooms.eastRoomId, rolllessKind, 'no dice')
      const noRoll = await call(app, MAKER.secret, 'POST', '/api/action', { action: 'use', thing_id: rolllessId })
      assert.equal(noRoll.status, 409)
      assert.equal(noRoll.json.error, 'write from roll needs a chance roll earlier in this same run; put the write after or inside a chance')

      const namedKind = await seedKind(MAKER.id, 'named', [await traitId('namer')])
      const countKind = await seedKind(MAKER.id, 'counted', [await traitId('counter')])
      const boxId = await seedThing(MAKER.id, rooms.eastRoomId, namedKind, 'a box')
      assert.equal((await call(app, MAKER.secret, 'POST', '/api/action', { action: 'use', thing_id: boxId })).status, 200)
      const counterId = await seedThing(MAKER.id, rooms.eastRoomId, countKind, 'a counter')
      await connectedDatabase().query(`UPDATE things SET state = '{"visits": "many"}'::jsonb WHERE id = $1`, [counterId])
      const mismatch = await call(app, MAKER.secret, 'POST', '/api/action', { action: 'use', thing_id: counterId })
      assert.equal(mismatch.status, 409)
      assert.equal(mismatch.json.error, 'write add needs key visits to hold a whole number; it holds text; use set to replace it first')

      const refusedClear = await call(app, MAKER.secret, 'PATCH', `/api/thing/${boxId}`, { state_clear: false })
      assert.equal(refusedClear.status, 400)
      assert.equal(refusedClear.json.error, 'state_clear must be true when present')
      const cleared = await call(app, MAKER.secret, 'PATCH', `/api/thing/${boxId}`, { state_clear: true })
      assert.equal(cleared.status, 200, JSON.stringify(cleared.json))
      const after = (await call(app, null, 'GET', `/api/thing/${boxId}`)).json.thing as Json
      const state = after.state as Json
      assert.equal(state.version, 2)
      assert.deepEqual(state.values, {})
      assert.deepEqual({ ...(state.last_write as Json), at: undefined }, {
        version: 2, key: null, op: 'clear', trimmed: 0, source_trait: null, source_trait_id: null,
        trigger: 'owner', by: 'bell-maker', at: undefined,
      })
    })

    await t.test("wake on arrival: the room owner's things wake, a visitor's thing waits for the room's word", async () => {
      const rooms = await resetCity([FOUNDER, MAKER, VISITOR])
      const db = connectedDatabase()
      await standIn(FOUNDER.id, rooms.eastRoomId)
      await standIn(VISITOR.id, rooms.continentId)
      assert.equal((await coin(app, FOUNDER.secret, 'greeter', {
        wake: { then: [
          { effect: 'label', target: 'actor', label: 'greeted' },
          { effect: 'write', key: 'guests', op: 'append', value: { from: 'actor' } },
        ] },
      })).status, 201)
      const kindId = await seedKind(FOUNDER.id, 'bells', [await traitId('greeter')])
      const ownBell = await seedThing(FOUNDER.id, rooms.eastRoomId, kindId, 'the door bell', { wakeEnabled: true })
      const visitorBell = await seedThing(MAKER.id, rooms.eastRoomId, kindId, 'a guest bell', { wakeEnabled: true })

      const arrived = await call(app, VISITOR.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.eastRoomId })
      assert.equal(arrived.status, 200, JSON.stringify(arrived.json))
      const settle = (arrived.json.action as Json).settle as Json
      assert.deepEqual({ ...settle, settle_id: undefined }, { settle_id: undefined, tried: 1, woke: 1, forfeited: 0 })
      const owned = (await call(app, null, 'GET', `/api/thing/${ownBell}`)).json.thing as Json
      assert.deepEqual((owned.state as Json).values, { guests: ['far-walker'] })
      assert.equal(((owned.state as Json).last_write as Json).trigger, 'wake_arrive')
      assert.equal(((owned.state as Json).last_write as Json).by, 'far-walker')
      assert.equal(owned.wake_enabled, true)
      const wake = owned.wake as Json
      assert.deepEqual({ ...wake, last_try_at: undefined }, {
        trait_id: await traitId('greeter'), on: ['arrive'], every_seconds: 60,
        last_try_at: undefined, clock_at: null,
      })
      assert.match(String(wake.last_try_at), /^\d{4}-\d{2}-\d{2}T/u)
      const visitors = (await call(app, null, 'GET', `/api/thing/${visitorBell}`)).json.thing as Json
      assert.deepEqual((visitors.state as Json).values, {}, "a visitor's thing does not wake unless the room allows it")

      const sticker = (await db.query(`
        SELECT actor_id, source_thing_id, extract(epoch FROM expires_at - created_at)::int AS lasts
        FROM active_labels WHERE target_type = 'resident' AND target_id = $1 AND label = 'greeted'
      `, [VISITOR.id])).rows
      assert.deepEqual(sticker, [{ actor_id: FOUNDER.id, source_thing_id: ownBell, lasts: 86_400 }],
        "the effects answer to the thing's owner, and a sticker on a resident expires after a day")
      const event = (await db.query(`SELECT actor, detail FROM events WHERE kind = 'room_settled'`)).rows
      assert.equal(event.length, 1)
      assert.equal(event[0]!.actor, 'far-walker')
      assert.deepEqual({ ...event[0]!.detail, settle_id: undefined }, {
        settle_id: undefined, place_id: rooms.eastRoomId, mode: 'arrive', status: 'woke',
        tried: 1, woke: 1, forfeited: 0, budget: 8,
      })

      // The room owner lets visitors' things wake; the owner's bell is inside "not more often than".
      await db.query('UPDATE places SET wake_visitors = TRUE WHERE id = $1', [rooms.eastRoomId])
      await ageRoom(rooms.eastRoomId, 30)
      await standIn(VISITOR.id, rooms.continentId)
      const again = await call(app, VISITOR.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.eastRoomId })
      assert.deepEqual({ ...((again.json.action as Json).settle as Json), settle_id: undefined }, {
        settle_id: undefined, tried: 1, woke: 1, forfeited: 0,
      })
      const guestBell = (await call(app, null, 'GET', `/api/thing/${visitorBell}`)).json.thing as Json
      assert.deepEqual((guestBell.state as Json).values, { guests: ['far-walker'] })
      const ownerBellAgain = (await call(app, null, 'GET', `/api/thing/${ownBell}`)).json.thing as Json
      assert.equal((ownerBellAgain.state as Json).version, 1, 'not more often than every_seconds')
    })

    await t.test('pins try outside the random cap, a block beats a pin, and a sleeping thing never wakes', async () => {
      const rooms = await resetCity([FOUNDER, MAKER, VISITOR])
      const db = connectedDatabase()
      await standIn(VISITOR.id, rooms.continentId)
      assert.equal((await coin(app, MAKER.secret, 'chime', {
        wake: { then: [{ effect: 'write', key: 'rings', op: 'add' }] },
      })).status, 201)
      const kindId = await seedKind(MAKER.id, 'chimes', [await traitId('chime')])
      const pinned = await seedThing(MAKER.id, rooms.eastRoomId, kindId, 'pinned chime', { wakeEnabled: true })
      const blocked = await seedThing(MAKER.id, rooms.eastRoomId, kindId, 'blocked chime', { wakeEnabled: true })
      const asleep = await seedThing(MAKER.id, rooms.eastRoomId, kindId, 'sleeping chime')
      await db.query(`
        UPDATE places SET wake_random_cap = 0, wake_pins = $2::int[], wake_block_thing_ids = $3::int[]
        WHERE id = $1
      `, [rooms.eastRoomId, [pinned, blocked, asleep], [blocked]])

      const arrived = await call(app, VISITOR.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.eastRoomId })
      assert.deepEqual({ ...((arrived.json.action as Json).settle as Json), settle_id: undefined }, {
        settle_id: undefined, tried: 1, woke: 1, forfeited: 0,
      })
      const rings = (await db.query(`SELECT id, state FROM things WHERE id = ANY($1::int[]) ORDER BY id`, [[pinned, blocked, asleep]])).rows
      assert.deepEqual(rings.map(row => row.state), [{ rings: 1 }, {}, {}])
    })

    await t.test('the random pick is reproducible from the settle roll', async () => {
      const rooms = await resetCity([FOUNDER, MAKER, VISITOR])
      const db = connectedDatabase()
      await standIn(VISITOR.id, rooms.continentId)
      assert.equal((await coin(app, FOUNDER.secret, 'chirp', {
        wake: { then: [{ effect: 'write', key: 'chirps', op: 'add' }] },
      })).status, 201)
      const kindId = await seedKind(FOUNDER.id, 'crickets', [await traitId('chirp')])
      const crickets = [
        await seedThing(FOUNDER.id, rooms.eastRoomId, kindId, 'cricket one', { wakeEnabled: true }),
        await seedThing(FOUNDER.id, rooms.eastRoomId, kindId, 'cricket two', { wakeEnabled: true }),
        await seedThing(FOUNDER.id, rooms.eastRoomId, kindId, 'cricket three', { wakeEnabled: true }),
      ]
      await db.query('UPDATE places SET wake_random_cap = 1 WHERE id = $1', [rooms.eastRoomId])
      const arrived = await call(app, VISITOR.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.eastRoomId })
      const settle = (arrived.json.action as Json).settle as Json
      assert.equal(settle.tried, 1)
      const roll = (await db.query(`
        SELECT roll.id::int AS id, encode(day.secret, 'hex') AS secret FROM chance_rolls roll
        JOIN chance_days day ON day.day = roll.day
        WHERE roll.purpose = 'wake_pick' AND roll.settle_id = $1
      `, [settle.settle_id])).rows[0]!
      const expected = crickets
        .map(thingId => ({ thingId, key: wakePickKey(String(roll.secret), Number(settle.settle_id), thingId, 0) }))
        .sort((a, b) => (a.key < b.key ? -1 : 1))[0]!.thingId
      const woke = (await db.query(`SELECT thing_id FROM wake_tries WHERE settle_id = $1`, [settle.settle_id])).rows
      assert.deepEqual(woke, [{ thing_id: expected }])
      const read = (await call(app, null, 'GET', `/api/physics?roll_id=${roll.id}`)).json.roll as Json
      assert.equal(read.purpose, 'wake_pick')
      assert.equal(read.sides, 3)
      assert.equal((read.units as Json[]).length, 3)
      assert.deepEqual((read.picked as Json[]).map(unit => unit.thing_id), [expected])
    })

    await t.test('a clock settles at most eight owed tries per thing, forfeits the rest, and has no actor', async () => {
      const rooms = await resetCity([FOUNDER, MAKER])
      const db = connectedDatabase()
      await standIn(FOUNDER.id, rooms.eastRoomId)
      assert.equal((await coin(app, FOUNDER.secret, 'ticker', {
        wake: { on: ['clock'], every_seconds: 10, then: [{ effect: 'write', key: 'ticks', op: 'add' }] },
      })).status, 201)
      assert.equal((await coin(app, FOUNDER.secret, 'sticker-clock', {
        wake: { on: ['clock'], every_seconds: 10, then: [{ effect: 'label', target: 'actor', label: 'late' }] },
      })).status, 201)
      const ticker = await seedThing(FOUNDER.id, rooms.eastRoomId, await seedKind(FOUNDER.id, 'tickers', [await traitId('ticker')]), 'a clock', { wakeEnabled: true })
      const stickerClock = await seedThing(FOUNDER.id, rooms.eastRoomId, await seedKind(FOUNDER.id, 'sticker-clocks', [await traitId('sticker-clock')]), 'a sticker clock', { wakeEnabled: true })
      await db.query('UPDATE places SET wake_random_cap = 32 WHERE id = $1', [rooms.eastRoomId])

      const first = await call(app, FOUNDER.secret, 'GET', '/api/me')
      assert.equal(first.status, 200)
      const anchors = (await db.query(`SELECT thing_id, last_try_at FROM thing_wake_state ORDER BY thing_id`)).rows
      assert.deepEqual(anchors.map(row => [row.thing_id, row.last_try_at]), [[ticker, null], [stickerClock, null]],
        'the first settle only sets each clock anchor; nothing is owed yet')
      assert.equal((await db.query(`SELECT count(*)::int AS settles FROM wake_settles`)).rows[0]!.settles, 0)

      await db.query(`UPDATE thing_wake_state SET clock_at = clock_at - interval '205 seconds'`)
      const before = (await db.query(`SELECT clock_at FROM thing_wake_state WHERE thing_id = $1`, [ticker])).rows[0]!.clock_at as Date
      await call(app, FOUNDER.secret, 'GET', '/api/me')
      const tries = (await db.query(`
        SELECT thing_id, status, error FROM wake_tries ORDER BY thing_id, unit_index
      `)).rows
      const tickerTries = tries.filter(row => row.thing_id === ticker)
      assert.equal(tickerTries.length, 8)
      assert.ok(tickerTries.every(row => row.status === 'woke'))
      const ticks = (await db.query(`SELECT state FROM things WHERE id = $1`, [ticker])).rows[0]!.state
      assert.deepEqual(ticks, { ticks: 8 })
      const stickerTries = tries.filter(row => row.thing_id === stickerClock)
      assert.equal(stickerTries.length, 8)
      assert.ok(stickerTries.every(row => (
        row.status === 'failed'
        && row.error === "this wake try came from the thing's clock, so there is no actor; name source or place instead"
      )))
      const settled = (await db.query(`SELECT detail FROM events WHERE kind = 'room_settled'`)).rows[0]!.detail
      assert.equal(settled.forfeited, 24, 'twenty owed tries each, eight run, twelve forfeited each')
      assert.equal(settled.mode, 'me')
      const after = (await db.query(`SELECT clock_at FROM thing_wake_state WHERE thing_id = $1`, [ticker])).rows[0]!.clock_at as Date
      assert.equal(after.getTime() - before.getTime(), 200_000, 'the clock advances by whole owed intervals and the remainder carries')
    })

    await t.test('speech wakes things that listen for talk; going home and a quiet room wake nothing', async () => {
      const rooms = await resetCity([FOUNDER, MAKER, VISITOR])
      const db = connectedDatabase()
      await standIn(VISITOR.id, rooms.eastRoomId)
      await db.query(`
        INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
        VALUES ($1, $2, $2)
        ON CONFLICT (resident_id) DO UPDATE SET current_place_id = EXCLUDED.current_place_id, home_place_id = EXCLUDED.home_place_id
      `, [FOUNDER.id, rooms.continentId])
      assert.equal((await coin(app, FOUNDER.secret, 'listener', {
        wake: { on: ['talk', 'arrive'], every_seconds: 10, then: [{ effect: 'write', key: 'heard', op: 'add' }] },
      })).status, 201)
      const ear = await seedThing(FOUNDER.id, rooms.eastRoomId, await seedKind(FOUNDER.id, 'ears', [await traitId('listener')]), 'an ear', { wakeEnabled: true })

      const said = await call(app, VISITOR.secret, 'POST', '/api/note', { place_id: rooms.eastRoomId, body: 'hello, room' })
      assert.equal(said.status, 201, JSON.stringify(said.json))
      assert.deepEqual({ ...(said.json.settle as Json), settle_id: undefined }, { settle_id: undefined, tried: 1, woke: 1, forfeited: 0 })
      assert.equal(((await db.query('SELECT state FROM things WHERE id = $1', [ear])).rows[0]!.state as Json).heard, 1)

      // Inside the room's ten-second quiet the wake part is skipped, and nothing is queued.
      const second = await call(app, VISITOR.secret, 'POST', '/api/note', { place_id: rooms.eastRoomId, body: 'hello again' })
      assert.equal(second.status, 201)
      assert.equal(second.json.settle, undefined)

      // Going home into the room settles timers and clock tries only; it is not an arrival.
      await ageRoom(rooms.eastRoomId, 60)
      await db.query(`UPDATE resident_presence SET home_place_id = $2 WHERE resident_id = $1`, [FOUNDER.id, rooms.eastRoomId])
      await standIn(FOUNDER.id, rooms.westRoomId)
      const home = await call(app, FOUNDER.secret, 'POST', '/api/go-home', {})
      assert.equal(home.status, 200, JSON.stringify(home.json))
      assert.equal(((await db.query('SELECT state FROM things WHERE id = $1', [ear])).rows[0]!.state as Json).heard, 1)
    })

    await t.test('a rough room lets a waking thing hold or send home a visitor; elsewhere the try is refused and the move stands', async () => {
      const rooms = await resetCity([FOUNDER, MAKER, VISITOR])
      const db = connectedDatabase()
      await db.query(`
        INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
        VALUES ($1, $2, $2)
        ON CONFLICT (resident_id) DO UPDATE SET current_place_id = EXCLUDED.current_place_id, home_place_id = EXCLUDED.home_place_id
      `, [VISITOR.id, rooms.continentId])
      await db.query(`UPDATE places SET owner_id = $1 WHERE id = $2`, [VISITOR.id, rooms.continentId])
      assert.equal((await coin(app, FOUNDER.secret, 'gatekeeper', {
        wake: { then: [
          { effect: 'label', target: 'actor', label: 'held' },
          { effect: 'block', target: 'actor', action: 'move', seconds: 600 },
        ] },
      })).status, 201)
      await seedThing(FOUNDER.id, rooms.eastRoomId, await seedKind(FOUNDER.id, 'gates', [await traitId('gatekeeper')]), 'a gate', { wakeEnabled: true })

      const refused = await call(app, VISITOR.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.eastRoomId })
      assert.equal(refused.status, 200, 'the move stands even though the wake try was refused')
      const refusedAction = refused.json.action as Json
      assert.equal(refusedAction.place_id, rooms.eastRoomId)
      assert.deepEqual({ ...(refusedAction.settle as Json), settle_id: undefined }, { settle_id: undefined, tried: 1, woke: 0, forfeited: 0 })
      const failed = (await db.query(`SELECT status, error FROM wake_tries`)).rows
      assert.deepEqual(failed, [{
        status: 'failed',
        error: 'this room is not marked rough, so a thing waking here may only label, check, roll, or write about the resident who arrived or spoke',
      }])
      assert.equal((await db.query(`SELECT count(*)::int AS labels FROM active_labels WHERE target_type = 'resident'`)).rows[0]!.labels, 0,
        'the refused try rolls back its sticker too')

      await db.query('UPDATE places SET rough_room = TRUE WHERE id = $1', [rooms.eastRoomId])
      await ageRoom(rooms.eastRoomId, 120)
      await standIn(VISITOR.id, rooms.continentId)
      const held = await call(app, VISITOR.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.eastRoomId })
      assert.deepEqual({ ...((held.json.action as Json).settle as Json), settle_id: undefined }, { settle_id: undefined, tried: 1, woke: 1, forfeited: 0 })
      const blockedMove = await call(app, VISITOR.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.continentId })
      assert.equal(blockedMove.status, 403, 'in a rough room the waking gate may hold the visitor')
      assert.match(String(blockedMove.json.error), /^move is temporarily blocked by thing trait "gatekeeper" from thing_id \d+/u)
      const home = await call(app, VISITOR.secret, 'POST', '/api/go-home', {})
      assert.equal(home.status, 200, 'going home is never blocked, even by a rough room')
      assert.equal((home.json.action as Json).place_id, rooms.continentId)
    })

    await t.test('a place read never settles, and concurrent settles claim each owed try once', async () => {
      const rooms = await resetCity([FOUNDER, MAKER])
      const db = connectedDatabase()
      await standIn(FOUNDER.id, rooms.eastRoomId)
      assert.equal((await coin(app, FOUNDER.secret, 'slow-clock', {
        wake: { on: ['clock'], every_seconds: 10, then: [{ effect: 'write', key: 'ticks', op: 'add' }] },
      })).status, 201)
      const clock = await seedThing(FOUNDER.id, rooms.eastRoomId, await seedKind(FOUNDER.id, 'slow-clocks', [await traitId('slow-clock')]), 'a slow clock', { wakeEnabled: true })
      await db.query(`INSERT INTO thing_wake_state (thing_id, clock_at) VALUES ($1, now() - interval '35 seconds')`, [clock])

      assert.equal((await call(app, null, 'GET', `/api/place/${rooms.eastRoomId}`)).status, 200)
      assert.equal((await call(app, FOUNDER.secret, 'GET', `/api/place/${rooms.eastRoomId}`)).status, 200)
      assert.equal((await db.query(`SELECT count(*)::int AS settles FROM wake_settles`)).rows[0]!.settles, 0, 'place reads never settle')

      // Hold the thing row the way an action does; the claim still commits.
      const holder = await db.connect()
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT id FROM things WHERE id = $1 FOR UPDATE', [clock])
        const settling = Promise.all([
          settleRoom(rooms.eastRoomId, 'me', FOUNDER.id),
          settleRoom(rooms.eastRoomId, 'me', FOUNDER.id),
        ])
        let claimed = 0
        for (let attempt = 0; attempt < 50 && claimed === 0; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 100))
          claimed = (await db.query(`SELECT count(*)::int AS settles FROM wake_settles`)).rows[0]!.settles
        }
        assert.equal(claimed, 1, "a settle's claim never waits on an action's lock of the thing's row")
        await holder.query('COMMIT')
        const results = await settling
        assert.equal(results.filter(result => result !== null).length, 1, 'the second settle is inside the quiet')
      } finally {
        holder.release()
      }
      const tries = (await db.query(`SELECT count(*)::int AS tries FROM wake_tries`)).rows[0]!.tries
      assert.equal(tries, 3, 'three owed intervals are claimed exactly once')
      assert.deepEqual((await db.query('SELECT state FROM things WHERE id = $1', [clock])).rows[0]!.state, { ticks: 3 })
    })
  } finally {
    await postgres.stop()
  }
})
