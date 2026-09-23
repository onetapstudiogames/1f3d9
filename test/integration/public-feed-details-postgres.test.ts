// What abilities did, in the public change feed and the dated public snapshots,
// against real PostgreSQL and the real routes: each ability event carries its public
// details, a reach and a growth-limited copy get events of their own, every older
// event keeps exactly the feed shape it had, resident stickers stay private, and the
// snapshot's things carry their current labels.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  FOUNDER, GROWER, NEIGHBOUR, call, coin, seedKind, seedThing, traitId, use,
  type CityApp, type Json,
} from '../helpers/abilities-fixtures.ts'
import {
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const previousSnapshotViewDdl = await readFile(
  new URL('../../db/migrations/20260922_public_snapshot_walk_to_read.sql', import.meta.url),
  'utf8',
)
const snapshotLabelsMigrationDdl = await readFile(
  new URL('../../db/migrations/20260923_public_snapshot_thing_labels.sql', import.meta.url),
  'utf8',
)

// The feed's detail allowlist exactly as it stood before this change. Every kind that
// gains nothing here must keep exactly these fields.
const FEED_FIELDS_BEFORE = Object.freeze([
  'resident_id', 'place_id', 'from_place_id', 'to_place_id', 'thing_id', 'source_thing_id',
  'kind_id', 'trait_id', 'agreement_id', 'note_id', 'transfer_id', 'offer_id', 'flag_id',
  'target_id', 'asset_id', 'parent_id', 'action_id', 'effect_id', 'pending_effect_id',
  'moderation_id', 'id', 'type', 'target_type', 'asset_type', 'action', 'mode', 'status',
  'error', 'channel', 'issue_number', 'entry_count', 'name', 'former_name',
])

// Every detail name any ability event stores, public or not; none may reach an older kind.
const ABILITY_DETAIL_NAMES = Object.freeze([
  'roll_id', 'purpose', 'roll', 'sides', 'percent', 'outcome', 'day', 'commitment',
  'settle_id', 'tried', 'woke', 'forfeited', 'budget', 'version', 'key', 'op', 'trimmed',
  'generation', 'family_id', 'from_kind_id', 'law_trait_id', 'cap', 'limit', 'over_by',
  'over', 'reached', 'more', 'skipped', 'stopped', 'birth_revision',
])

const OLDER_KINDS = Object.freeze([
  'register', 'rotate', 'resident_edited', 'home_set', 'place_created', 'place_edited',
  'place_renamed', 'place_retired', 'place_restored', 'kind_invented', 'kind_revised',
  'trait_coined', 'thing_crafted', 'thing_moved', 'thing_upgraded', 'thing_withdrawn',
  'laws_changed', 'action', 'effect_scheduled', 'effect_resolved', 'note', 'gazette_printed',
  'agreement', 'agreement_accession', 'agreement_sign', 'transfer', 'transfer_offer', 'sale',
  'transfer_cancel', 'world_listed', 'world_sale', 'world_cancel', 'payment_repair', 'flag',
  'moderation',
])

function pick(detail: Json, fields: readonly string[]): Json {
  return Object.fromEntries(Object.entries(detail).filter(([key, value]) => (
    fields.includes(key) && (value === null || ['string', 'number', 'boolean'].includes(typeof value))
  )))
}

/** Every public change after marker 0, following next_since. */
async function feed(app: CityApp, kind?: string): Promise<Json[]> {
  const changes: Json[] = []
  let since = '0'
  for (;;) {
    const page = await call(app, null, 'GET', `/api/changes?since=${since}&limit=200${kind ? `&kind=${kind}` : ''}`)
    assert.equal(page.status, 200, JSON.stringify(page.json))
    changes.push(...page.json.changes as Json[])
    if (page.json.has_more !== true) return changes
    since = String(page.json.next_since)
  }
}

/** The stored detail of every event of a kind, oldest first. */
async function stored(kind: string): Promise<Json[]> {
  return (await connectedDatabase().query<{ detail: Json }>(
    'SELECT detail FROM events WHERE kind = $1 ORDER BY id', [kind],
  )).rows.map(row => row.detail)
}

test('the public feed and snapshots show what abilities did', { timeout: 900_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('public-feed-details')
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }

    await t.test('the change feed carries the public details of every ability event', async () => {
      const rooms = await resetCity([FOUNDER, GROWER, NEIGHBOUR])
      const db = connectedDatabase()
      await db.query('UPDATE places SET owner_id = $1, open_to_things = TRUE WHERE id = $2', [GROWER.id, rooms.eastRoomId])
      await standIn(GROWER.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.continentId)

      assert.equal((await coin(app, GROWER.secret, 'coin-toss', {
        use: [{
          effect: 'chance', percent: 50,
          then: [{ effect: 'write', key: 'heads', op: 'add' }],
          else: [{ effect: 'write', key: 'tails', op: 'add' }],
        }],
      })).status, 201)
      assert.equal((await coin(app, GROWER.secret, 'one-sprout', { use: [{ effect: 'copy', generations: 1 }] })).status, 201)
      assert.equal((await coin(app, GROWER.secret, 'soak-room', {
        use: [{ effect: 'reach', then: [{ effect: 'label', target: 'target', label: 'soaked' }] }],
      })).status, 201)
      assert.equal((await coin(app, GROWER.secret, 'mist-people', {
        use: [{ effect: 'reach', over: 'residents', then: [{ effect: 'label', target: 'target', label: 'private-mist' }] }],
      })).status, 201)
      assert.equal((await coin(app, GROWER.secret, 'ash-touch', { use: [{ effect: 'convert', target: 'target' }] })).status, 201)
      assert.equal((await coin(app, GROWER.secret, 'door-greeter', {
        wake: { then: [
          { effect: 'label', target: 'actor', label: 'private-greeting' },
          { effect: 'write', key: 'visits', op: 'add' },
        ] },
      })).status, 201)

      const coins = await seedKind(GROWER.id, 'toss-coin', [await traitId('coin-toss')])
      const moss = await seedKind(GROWER.id, 'feed-moss', [await traitId('one-sprout')])
      const clouds = await seedKind(GROWER.id, 'feed-cloud', [await traitId('soak-room'), await traitId('mist-people')])
      const ash = await seedKind(GROWER.id, 'feed-ash', [await traitId('ash-touch')])
      const oak = await seedKind(NEIGHBOUR.id, 'feed-oak', [])
      const bells = await seedKind(GROWER.id, 'feed-bell', [await traitId('door-greeter')])
      const coinId = await seedThing(GROWER.id, rooms.eastRoomId, coins, 'a coin')
      const mossId = await seedThing(GROWER.id, rooms.eastRoomId, moss, 'moss')
      const cloudId = await seedThing(GROWER.id, rooms.eastRoomId, clouds, 'a cloud')
      const emberId = await seedThing(GROWER.id, rooms.eastRoomId, ash, 'an ember')
      const oakId = await seedThing(NEIGHBOUR.id, rooms.eastRoomId, oak, 'an open oak', { openToConvert: true })
      const bellId = await seedThing(GROWER.id, rooms.eastRoomId, bells, 'a bell')
      await db.query('UPDATE things SET wake_enabled = TRUE WHERE id = $1', [bellId])

      const tossed = await use(app, GROWER.secret, coinId)
      assert.equal(tossed.status, 200, JSON.stringify(tossed.json))
      const [roll] = (tossed.json.action as Json).rolls as [Json]
      const firstCopy = await use(app, GROWER.secret, mossId)
      const [copyId] = (firstCopy.json.action as Json).copied_thing_ids as [number]
      const skipped = await use(app, GROWER.secret, mossId)
      assert.equal(skipped.status, 200, JSON.stringify(skipped.json))
      const reached = await use(app, GROWER.secret, cloudId)
      assert.equal(reached.status, 200, JSON.stringify(reached.json))
      const converted = await use(app, GROWER.secret, emberId, { target_type: 'thing', target_id: oakId })
      assert.equal(converted.status, 200, JSON.stringify(converted.json))
      const arrived = await call(app, NEIGHBOUR.secret, 'POST', '/api/action', { action: 'move', to_place_id: rooms.eastRoomId })
      assert.equal(arrived.status, 200, JSON.stringify(arrived.json))
      const settle = (arrived.json.action as Json).settle as Json

      const changes = await feed(app)
      const of = (kind: string) => changes.filter(change => change.kind === kind).map(change => change.detail as Json)

      // A roll: the number, its sides and percent, its purpose and outcome; not the day secret's fingerprint.
      const [rolled] = of('chance_rolled') as [Json]
      assert.deepEqual(rolled, {
        roll_id: roll.roll_id, purpose: 'chance', thing_id: coinId, place_id: rooms.eastRoomId,
        action_id: (tossed.json.action as Json).id, settle_id: null, status: roll.branch,
        percent: 50, roll: roll.roll, sides: 100, outcome: 'counted',
      })

      // A write: which key, how, and the box's new version.
      const writes = of('thing_edited').filter(detail => detail.mode === 'state')
      const tossWrite = writes.find(detail => detail.thing_id === coinId)!
      assert.deepEqual(tossWrite, {
        thing_id: coinId, place_id: rooms.eastRoomId, mode: 'state', version: 1,
        key: roll.branch === 'then' ? 'heads' : 'tails', op: 'add',
      })

      // A copy: its generation and family beside the parent it came from.
      const [copied] = of('thing_created').filter(detail => detail.mode === 'copy') as [Json]
      assert.deepEqual(copied, {
        thing_id: copyId, place_id: rooms.eastRoomId, name: 'moss', kind_id: moss, mode: 'copy',
        source_thing_id: mossId, generation: 1, family_id: mossId,
      })

      // A copy a limit stopped: which limit, its value, and how far over, where it bit.
      const [capped] = of('copy_skipped') as [Json]
      assert.deepEqual(capped, {
        thing_id: mossId, trait_id: await traitId('one-sprout'), place_id: rooms.eastRoomId,
        family_id: mossId, cap: 'copies', limit: 1, over_by: 1,
        action_id: (skipped.json.action as Json).id, settle_id: null,
      })
      assert.equal(changes.find(change => change.kind === 'copy_skipped')!.actor, GROWER.handle)

      // A reach: over what, how many it reached, how many more there were, skipped, and why it stopped.
      const reaches = of('room_reached')
      const reachAction = (reached.json.action as Json).id
      assert.deepEqual(reaches, [
        {
          thing_id: cloudId, trait_id: await traitId('soak-room'), place_id: rooms.eastRoomId,
          over: 'things', reached: 6, more: 0, skipped: 0, stopped: null, action_id: reachAction, settle_id: null,
        },
        {
          thing_id: cloudId, trait_id: await traitId('mist-people'), place_id: rooms.eastRoomId,
          over: 'residents', reached: 1, more: 0, skipped: 0, stopped: null, action_id: reachAction, settle_id: null,
        },
      ])
      assert.deepEqual(
        ((reached.json.action as Json).reaches as Json[]).map(entry => [entry.over, entry.reached, entry.more, entry.stopped]),
        reaches.map(entry => [entry.over, entry.reached, entry.more, entry.stopped]),
        'the feed says what the action answer said',
      )

      // A conversion: the kind it was and the kind it is now.
      const [turned] = of('thing_edited').filter(detail => detail.mode === 'converted') as [Json]
      assert.deepEqual(turned, {
        thing_id: oakId, place_id: rooms.eastRoomId, mode: 'converted', source_thing_id: emberId,
        law_trait_id: null, kind_id: ash, from_kind_id: oak,
      })

      // A settle: how many tried, woke, and were dropped.
      const [settled] = of('room_settled').filter(detail => detail.mode === 'arrive') as [Json]
      assert.deepEqual(settled, {
        settle_id: settle.settle_id, place_id: rooms.eastRoomId, mode: 'arrive', status: 'woke',
        tried: settle.tried, woke: settle.woke, forfeited: settle.forfeited,
      })

      // Stickers on residents stay private: no event, no label name, anywhere in the feed.
      const feedText = JSON.stringify(changes)
      assert.doesNotMatch(feedText, /private-mist|private-greeting/u)
      assert.equal(
        Number((await db.query(`SELECT count(*)::int AS count FROM active_labels WHERE target_type = 'resident'`)).rows[0]!.count),
        2,
        'the stickers exist; the feed simply never names them',
      )
      assert.doesNotMatch(feedText, /"(?:day|commitment|budget|trimmed|birth_revision)":/u)
    })

    await t.test('every older event kind keeps exactly the feed shape it had', async () => {
      await resetCity([FOUNDER, GROWER])
      const db = connectedDatabase()
      const everything: Json = Object.fromEntries([
        ...FEED_FIELDS_BEFORE.map((field, index) => [field, field.endsWith('_id') ? index + 1 : `${field}-value`]),
        ...ABILITY_DETAIL_NAMES.map((field, index) => [field, field === 'key' ? 'box-key' : index + 100]),
        ['body', 'authored words stay out'],
        ['reason', 'a private reason'],
        ['nested', { place_id: 9 }],
      ])
      for (const kind of OLDER_KINDS) {
        await db.query(`INSERT INTO events (kind, actor, detail) VALUES ($1, $2, $3::jsonb)`, [
          kind, GROWER.handle, JSON.stringify(everything),
        ])
      }
      // The older shapes of the two kinds abilities reuse, exactly as their writers store them.
      const olderReuse: ReadonlyArray<readonly [string, Json]> = [
        ['thing_created', { thing_id: 7, place_id: 3, name: 'a lamp', kind_id: 2, birth_revision: 1 }],
        ['thing_edited', { thing_id: 7 }],
      ]
      for (const [kind, detail] of olderReuse) {
        await db.query(`INSERT INTO events (kind, actor, detail) VALUES ($1, $2, $3::jsonb)`, [
          kind, GROWER.handle, JSON.stringify(detail),
        ])
      }

      const changes = await feed(app)
      assert.equal(changes.length, OLDER_KINDS.length + olderReuse.length)
      for (const change of changes.slice(0, OLDER_KINDS.length)) {
        assert.deepEqual(change.detail, pick(everything, FEED_FIELDS_BEFORE), String(change.kind))
      }
      assert.deepEqual(changes.slice(OLDER_KINDS.length).map(change => change.detail), [
        { thing_id: 7, place_id: 3, name: 'a lamp', kind_id: 2 },
        { thing_id: 7 },
      ])
      for (const kind of ['chance_rolled', 'room_settled', 'copy_skipped', 'room_reached']) {
        assert.deepEqual(await stored(kind), [], `${kind} was not written by this subtest`)
      }
    })

    await t.test('a filtered feed pages the new kinds like any other', async () => {
      await resetCity([FOUNDER, GROWER])
      const db = connectedDatabase()
      for (let index = 0; index < 3; index += 1) {
        await db.query(`INSERT INTO events (kind, actor, detail) VALUES ('room_reached', $1, $2::jsonb)`, [
          GROWER.handle, JSON.stringify({ place_id: 5, over: 'things', reached: index, more: 0, skipped: 0, stopped: null }),
        ])
        await db.query(`INSERT INTO events (kind, actor, detail) VALUES ('note', $1, $2::jsonb)`, [
          GROWER.handle, JSON.stringify({ note_id: index + 1, place_id: 5 }),
        ])
      }
      const reaches = await feed(app, 'room_reached')
      assert.deepEqual(reaches.map(change => (change.detail as Json).reached), [0, 1, 2])
    })

    await t.test("the dated public snapshot carries each thing's current labels as the thing read shows them", async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      const db = connectedDatabase()
      const lampId = await seedThing(GROWER.id, rooms.eastRoomId, null, 'a lamp')
      const bareId = await seedThing(GROWER.id, rooms.eastRoomId, null, 'a bare stone')
      // 34 current labels (32 listed, oldest two left out), one expired, one set twice.
      for (let index = 1; index <= 34; index += 1) {
        await db.query(`
          INSERT INTO active_labels (target_type, target_id, label, actor_id, created_at, expires_at)
          VALUES ('thing', $1, $2, $3, now() - make_interval(secs => 100 - $4::int), NULL)
        `, [lampId, `mark-${String(index).padStart(2, '0')}`, index % 2 === 0 ? GROWER.id : FOUNDER.id, index])
      }
      await db.query(`
        INSERT INTO active_labels (target_type, target_id, label, actor_id, created_at, expires_at)
        VALUES ('thing', $1, 'faded', $2, now() - interval '2 days', now() - interval '1 day')
      `, [lampId, GROWER.id])
      await db.query(`
        INSERT INTO active_labels (target_type, target_id, label, actor_id, created_at, expires_at)
        VALUES ('resident', $1, 'resident-private', $1, now(), now() + interval '1 day')
      `, [GROWER.id])

      const snapshotThings = async (): Promise<Map<number, Json>> => new Map(
        (await db.query<{ payload: Json }>(`
          SELECT payload FROM city_snapshot.public_records_v2
          WHERE class_name = 'things' AND payload->>'status' = 'exported'
        `)).rows.map(row => [Number(row.payload.id), row.payload]),
      )
      const current = await snapshotThings()
      const read = (await call(app, null, 'GET', `/api/thing/${lampId}`)).json.thing as Json
      assert.deepEqual(current.get(lampId)?.labels, read.labels, 'the same entries the thing read shows')
      assert.equal(current.get(lampId)?.labels_total, 34)
      assert.equal(read.labels_total, 34)
      const listed = current.get(lampId)!.labels as Json[]
      assert.equal(listed.length, 32)
      assert.equal(listed[0]!.label, 'mark-34', 'newest first')
      assert.equal(listed.at(-1)!.label, 'mark-03')
      assert.deepEqual(Object.keys(listed[0]!).sort(), ['expires_at', 'label', 'set_at', 'set_by'])
      assert.equal(listed.some(entry => entry.label === 'faded'), false, 'an expired label never shows')
      assert.deepEqual(current.get(bareId)?.labels, [])
      assert.equal(current.get(bareId)?.labels_total, 0)
      const everyRecord = JSON.stringify((await db.query('SELECT payload FROM city_snapshot.public_records_v2')).rows)
      assert.doesNotMatch(everyRecord, /resident-private/u, 'resident stickers stay out of every snapshot class')

      // A database still on the earlier view gains the labels from the migration, and a
      // second run changes nothing.
      await db.query(previousSnapshotViewDdl)
      const before = await snapshotThings()
      assert.equal(Object.hasOwn(before.get(lampId)!, 'labels'), false)
      await db.query(snapshotLabelsMigrationDdl)
      await db.query(snapshotLabelsMigrationDdl)
      assert.deepEqual(await snapshotThings(), current)
    })
  } finally {
    await postgres.stop()
  }
})
