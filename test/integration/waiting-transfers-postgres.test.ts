// Held gifts (decision #158) against real PostgreSQL: the real schema, the real routes, the
// real migration. A give to a resident that muted the giver, or a transfer effect in the
// giver's use, waits for the recipient's yes: nothing moves, no event is written, no law
// runs, and the giver is told in plain words. Accepting makes the ordinary give then, with
// every rule checked again; declining moves nothing. Credit gifts are never held, and
// anonymous reads never change.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  call,
  coin,
  FOUNDER,
  GROWER,
  NEIGHBOUR,
  seedKind,
  seedThing,
  traitId,
  type CityApp,
  type Json,
} from '../helpers/abilities-fixtures.ts'
import {
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

// GIVER gives; NEIGHBOUR muted GIVER; FAR_SHORE muted nobody. GROWER is resident #2, the
// second founder account (decision #159): it cannot be muted, so its gifts are never held.
const GIVER = Object.freeze({ id: 6, handle: 'lamp-giver', secret: `1f3d9_sk_${'6'.repeat(48)}` })
const FAR_SHORE = Object.freeze({ id: 5, handle: 'far-shore', secret: `1f3d9_sk_${'5'.repeat(48)}` })
const RESIDENTS = [FOUNDER, GROWER, NEIGHBOUR, FAR_SHORE, GIVER] as const

// What the giver is told, in the owner's accepted words (choice 3, 2026-10-15). Written out
// here, not imported, so this suite reads the same on the code before held gifts.
const HELD_FOR_NEIGHBOUR = 'Held until next-door accepts; it stays yours meanwhile.'
const HOME_LINE = 'If accepted, your home will be cleared then.'

const migration = await readFile(
  new URL('../../db/migrations/20261018_waiting_transfers.sql', import.meta.url),
  'utf8',
)

type Read = Readonly<{ status: number; text: string; json: Json; headers: Readonly<Record<string, string>> }>

async function read(app: CityApp, path: string, secret: string | null = null): Promise<Read> {
  const response = await app.request(`http://city.test${path}`, {
    headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
  })
  const text = await response.text()
  return Object.freeze({
    status: response.status,
    text,
    // The front door answers plain text; every other read here answers JSON.
    json: response.headers.get('content-type')?.includes('json') === true ? JSON.parse(text) as Json : {},
    headers: Object.fromEntries(response.headers.entries()),
  })
}

async function muteGrower(app: CityApp, extra: Json = {}): Promise<void> {
  const muted = await call(app, NEIGHBOUR.secret, 'PATCH', '/api/me/settings', {
    mute: { type: 'resident', id: GIVER.id, ...extra },
  })
  assert.equal(muted.status, 200, JSON.stringify(muted.json))
}

async function give(app: CityApp, type: string, id: number, toHandle: string = NEIGHBOUR.handle) {
  return call(app, GIVER.secret, 'POST', '/api/transfer', { type, id, to_handle: toHandle })
}

async function count(text: string, values: readonly unknown[] = []): Promise<number> {
  return Number((await connectedDatabase().query<{ count: string }>(text, [...values])).rows[0]!.count)
}

async function ownerOf(table: 'things' | 'places' | 'kinds', id: number): Promise<number> {
  return Number((await connectedDatabase().query<{ owner_id: number }>(
    `SELECT owner_id FROM ${table} WHERE id = $1`, [id],
  )).rows[0]!.owner_id)
}

async function insertId(text: string, values: readonly unknown[]): Promise<number> {
  return Number((await connectedDatabase().query<{ id: number }>(text, [...values])).rows[0]!.id)
}

async function seedPlace(parentId: number, name: string, ownerId: number): Promise<number> {
  return insertId(`
    INSERT INTO places (parent_id, place_kind, name, description, owner_id, open_to_notes, open_to_things)
    VALUES ($1, 'place', $2, $3, $4, TRUE, TRUE) RETURNING id
  `, [parentId, name, `the ${name}`, ownerId])
}

async function eventCounts(): Promise<Readonly<{ all: number; transfers: number; actions: number }>> {
  return Object.freeze({
    all: await count('SELECT count(*) FROM events'),
    transfers: await count(`SELECT count(*) FROM events WHERE kind = 'transfer'`),
    actions: await count('SELECT count(*) FROM action_runs'),
  })
}

function waitingOf(answer: Json): Json {
  const listed = answer.waiting_transfers as Json[] | undefined
  assert.ok(Array.isArray(listed) && listed.length === 1, JSON.stringify(answer))
  return listed[0]!
}

test('held gifts against real PostgreSQL', { timeout: 900_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('waiting-transfers')
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const db = connectedDatabase()

    await t.test('the migration applies twice, changes no resident or mute, and its checks hold', async () => {
      await resetCity(RESIDENTS)
      await db.query(`INSERT INTO resident_mutes (resident_id, target_type, target_id, choice) VALUES (3, 'resident', 2, 'mute')`)
      const catalog = async () => (await db.query(
        `SELECT conrelid::regclass::text AS table_name, conname, contype, convalidated, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint WHERE conrelid IN ('waiting_transfers'::regclass, 'resident_mutes'::regclass) ORDER BY 1, 2`,
      )).rows
      const indexes = async () => (await db.query(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'waiting_transfers' ORDER BY indexname`,
      )).rows
      const fresh = await catalog()
      const freshIndexes = await indexes()
      assert.ok(fresh.every(row => row.convalidated === true))
      assert.equal(fresh.filter(row => row.table_name === 'waiting_transfers').length, 9)
      const mutesBefore = (await db.query('SELECT id, resident_id, target_type, target_id, choice, show_anyway FROM resident_mutes ORDER BY id')).rows
      const residentsBefore = (await db.query('SELECT * FROM residents ORDER BY id')).rows
      await db.query('DROP TABLE waiting_transfers')
      await db.query('ALTER TABLE resident_mutes DROP COLUMN let_gifts_through')
      await db.query(migration)
      await db.query(migration)
      assert.deepEqual(await catalog(), fresh)
      assert.deepEqual(await indexes(), freshIndexes)
      assert.deepEqual((await db.query('SELECT id, resident_id, target_type, target_id, choice, show_anyway FROM resident_mutes ORDER BY id')).rows, mutesBefore)
      assert.deepEqual((await db.query('SELECT let_gifts_through FROM resident_mutes')).rows, [{ let_gifts_through: false }])
      assert.deepEqual((await db.query('SELECT * FROM residents ORDER BY id')).rows, residentsBefore)
      const refused = async (sql: string) => {
        await assert.rejects(db.query(sql), /violates/u, sql)
      }
      const insert = 'INSERT INTO waiting_transfers (giver_id, recipient_id, asset_type, asset_id, answer, answer_detail, answered_at)'
      await refused(`${insert} VALUES (2, 2, 'thing', 1, NULL, NULL, NULL)`)
      await refused(`${insert} VALUES (2, 3, 'note', 1, NULL, NULL, NULL)`)
      await refused(`${insert} VALUES (2, 3, 'thing', 0, NULL, NULL, NULL)`)
      await refused(`${insert} VALUES (2, 3, 'thing', 1, 'maybe', 'x', now())`)
      await refused(`${insert} VALUES (2, 3, 'thing', 1, 'accepted', NULL, now())`)
      await refused(`${insert} VALUES (2, 3, 'thing', 1, 'accepted', 'x', NULL)`)
      await refused(`${insert} VALUES (2, 3, 'thing', 1, NULL, 'x', NULL)`)
      await refused(`${insert} VALUES (2, 3, 'thing', 1, 'declined', '', now())`)
      await db.query(`${insert} VALUES (2, 3, 'thing', 1, NULL, NULL, NULL)`)
      await assert.rejects(db.query(`${insert} VALUES (2, 3, 'thing', 1, NULL, NULL, NULL)`), /duplicate key/u)
      await db.query(`${insert} VALUES (2, 3, 'thing', 1, 'declined', 'declined; nothing moved', now())`)
      await refused(`UPDATE resident_mutes SET choice = 'allow', target_type = 'place', let_gifts_through = TRUE`)
      await refused(`INSERT INTO resident_mutes (resident_id, target_type, target_id, choice, let_gifts_through) VALUES (3, 'place', 1, 'mute', TRUE)`)
      await db.query('UPDATE resident_mutes SET let_gifts_through = TRUE')
    })

    await t.test('a give to a resident that muted the giver waits: nothing moves, no event, no law, and the giver is told', async () => {
      const rooms = await resetCity(RESIDENTS)
      await standIn(GIVER.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      await standIn(FAR_SHORE.id, rooms.eastRoomId)
      const lantern = await seedThing(GIVER.id, rooms.eastRoomId, null, 'a lantern')
      const kind = await insertId('INSERT INTO kinds (name, owner_id) VALUES ($1, $2) RETURNING id', ['held-kind', GIVER.id])
      await muteGrower(app)
      const before = await eventCounts()

      const held = await give(app, 'thing', lantern)
      assert.equal(held.status, 200, JSON.stringify(held.json))
      assert.equal(Object.hasOwn(held.json, 'transfer'), false)
      const waiting = waitingOf(held.json)
      assert.equal(waiting.note, HELD_FOR_NEIGHBOUR)
      assert.equal(waiting.to, NEIGHBOUR.handle)
      assert.equal(waiting.type, 'thing')
      assert.equal(waiting.asset_id, lantern)
      assert.equal(await ownerOf('things', lantern), GIVER.id)
      assert.deepEqual(await eventCounts(), before)
      // Giving the same thing again finds the same waiting transfer.
      const again = await give(app, 'thing', lantern)
      assert.equal(waitingOf(again.json).waiting_id, waiting.waiting_id)
      const heldKind = await give(app, 'kind', kind)
      assert.equal(waitingOf(heldKind.json).note, HELD_FOR_NEIGHBOUR)
      assert.equal(await ownerOf('kinds', kind), GIVER.id)
      assert.deepEqual(await eventCounts(), before)

      // The recipient sees a count in its own settings and nothing anywhere else.
      const shown = await read(app, '/api/me/settings', NEIGHBOUR.secret)
      const listed = shown.json.waiting_transfers as Json
      assert.equal(listed.count, 2)
      assert.deepEqual((listed.oldest as Json[]).map(row => [row.type, row.asset_id, row.from]), [
        ['thing', lantern, GIVER.handle], ['kind', kind, GIVER.handle],
      ])
      assert.doesNotMatch(shown.text, /gift/iu)
      const me = await read(app, '/api/me', NEIGHBOUR.secret)
      assert.equal(me.status, 200, me.text)
      assert.doesNotMatch(me.text, /waiting/iu)

      // Nothing is locked: the giver may still give the thing to anyone else.
      const elsewhere = await give(app, 'thing', lantern, FAR_SHORE.handle)
      assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.json))
      assert.equal(await ownerOf('things', lantern), FAR_SHORE.id)
      // Accepting now fails with the ownership sentence, ends it, and moves nothing.
      const late = await call(app, NEIGHBOUR.secret, 'POST', `/api/transfer/waiting/${waiting.waiting_id}/accept`)
      assert.equal(late.status, 409, JSON.stringify(late.json))
      assert.equal(late.json.error, `waiting_id ${waiting.waiting_id} could not be accepted, so it has ended and nothing moved: only the thing owner may transfer it`)
      assert.equal(await ownerOf('things', lantern), FAR_SHORE.id)
      assert.deepEqual((await db.query('SELECT answer, answer_detail FROM waiting_transfers WHERE id = $1', [waiting.waiting_id])).rows, [
        { answer: 'failed', answer_detail: 'only the thing owner may transfer it' },
      ])
    })

    await t.test('accept makes the ordinary give with its event; decline moves nothing; only the recipient may answer', async () => {
      const rooms = await resetCity(RESIDENTS)
      await standIn(GIVER.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.westRoomId)
      const first = await seedThing(GIVER.id, rooms.eastRoomId, null, 'a first lantern')
      const second = await seedThing(GIVER.id, rooms.eastRoomId, null, 'a second lantern')
      await muteGrower(app)
      const firstWaiting = waitingOf((await give(app, 'thing', first)).json)
      const secondWaiting = waitingOf((await give(app, 'thing', second)).json)

      const stranger = await call(app, FAR_SHORE.secret, 'POST', `/api/transfer/waiting/${firstWaiting.waiting_id}/accept`)
      assert.equal(stranger.status, 404)
      assert.match(String(stranger.json.error), new RegExp(`^waiting_id ${firstWaiting.waiting_id} is not waiting for you`, 'u'))
      const badId = await call(app, NEIGHBOUR.secret, 'POST', '/api/transfer/waiting/abc/accept')
      assert.equal(badId.status, 400)
      assert.match(String(badId.json.error), /^waiting_id must be a positive whole number/u)

      const accepted = await call(app, NEIGHBOUR.secret, 'POST', `/api/transfer/waiting/${firstWaiting.waiting_id}/accept`)
      assert.equal(accepted.status, 200, JSON.stringify(accepted.json))
      assert.equal((accepted.json.waiting_transfer as Json).answer, 'accepted')
      const transfer = accepted.json.transfer as Json
      assert.deepEqual([transfer.type, transfer.asset_id, transfer.from, transfer.to, transfer.mode], [
        'thing', first, GIVER.handle, NEIGHBOUR.handle, 'gift',
      ])
      assert.equal(await ownerOf('things', first), NEIGHBOUR.id)
      const events = (await db.query(`SELECT actor, detail FROM events WHERE kind = 'transfer'`)).rows
      assert.equal(events.length, 1)
      assert.equal(events[0]!.actor, GIVER.handle)
      assert.equal(events[0]!.detail.mode, 'gift')
      assert.equal(events[0]!.detail.to, NEIGHBOUR.handle)
      assert.deepEqual((await db.query('SELECT answer, answer_detail FROM waiting_transfers WHERE id = $1', [firstWaiting.waiting_id])).rows, [
        { answer: 'accepted', answer_detail: `moved as transfer_id ${transfer.id}` },
      ])
      const twice = await call(app, NEIGHBOUR.secret, 'POST', `/api/transfer/waiting/${firstWaiting.waiting_id}/accept`)
      assert.equal(twice.status, 409)
      assert.equal(twice.json.error, `waiting_id ${firstWaiting.waiting_id} was already accepted; nothing changed`)

      const declined = await call(app, NEIGHBOUR.secret, 'POST', `/api/transfer/waiting/${secondWaiting.waiting_id}/decline`)
      assert.equal(declined.status, 200, JSON.stringify(declined.json))
      assert.equal((declined.json.waiting_transfer as Json).answer, 'declined')
      assert.equal(await ownerOf('things', second), GIVER.id)
      assert.equal(await count(`SELECT count(*) FROM events WHERE kind = 'transfer'`), 1)
      const afterDecline = await call(app, NEIGHBOUR.secret, 'POST', `/api/transfer/waiting/${secondWaiting.waiting_id}/accept`)
      assert.equal(afterDecline.status, 409)
      assert.equal(afterDecline.json.error, `waiting_id ${secondWaiting.waiting_id} was already declined; nothing changed`)
      assert.equal(((await read(app, '/api/me/settings', NEIGHBOUR.secret)).json.waiting_transfers as Json).count, 0)
    })

    await t.test('a gift from the second founder account, resident #2, is never held, even under a mute saved before #159', async () => {
      const rooms = await resetCity(RESIDENTS)
      await standIn(GROWER.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      const refused = await call(app, NEIGHBOUR.secret, 'PATCH', '/api/me/settings', { mute: { type: 'resident', id: GROWER.id } })
      assert.equal(refused.status, 400)
      assert.ok(String(refused.json.error).startsWith(
        'the founders, residents #1 and #2, cannot be muted, and the notes and things either founder writes, makes or owns always show; mute something else',
      ), String(refused.json.error))
      // A mute row saved on resident #2 before the rule, as production may still hold.
      await db.query(`INSERT INTO resident_mutes (resident_id, target_type, target_id, choice) VALUES ($1, 'resident', $2, 'mute')`, [NEIGHBOUR.id, GROWER.id])
      const lantern = await seedThing(GROWER.id, rooms.eastRoomId, null, 'a founder lantern')
      const plot = await seedPlace(rooms.continentId, 'Founder Plot', GROWER.id)
      for (const [type, id] of [['thing', lantern], ['place', plot]] as const) {
        const moved = await call(app, GROWER.secret, 'POST', '/api/transfer', { type, id, to_handle: NEIGHBOUR.handle })
        assert.equal(moved.status, 200, JSON.stringify(moved.json))
        assert.equal(moved.json.waiting_transfers, undefined, JSON.stringify(moved.json))
        assert.equal(await ownerOf(type === 'thing' ? 'things' : 'places', id), NEIGHBOUR.id)
      }
      assert.equal(await count('SELECT count(*) FROM waiting_transfers'), 0)
    })

    await t.test('let_transfers_through lets the next give move at once, and a mute without it holds again', async () => {
      const rooms = await resetCity(RESIDENTS)
      await standIn(GIVER.id, rooms.eastRoomId)
      const lantern = await seedThing(GIVER.id, rooms.eastRoomId, null, 'a lantern')
      const other = await seedThing(GIVER.id, rooms.eastRoomId, null, 'another lantern')
      await muteGrower(app, { let_transfers_through: true })
      const mutes = ((await read(app, '/api/me/settings', NEIGHBOUR.secret)).json.settings as Json).mutes as Json[]
      assert.deepEqual(mutes.map(row => [row.type, row.id, row.let_transfers_through]), [['resident', GIVER.id, true]])
      const moved = await give(app, 'thing', lantern)
      assert.equal(moved.status, 200, JSON.stringify(moved.json))
      assert.equal((moved.json.transfer as Json).to, NEIGHBOUR.handle)
      assert.equal(await ownerOf('things', lantern), NEIGHBOUR.id)

      const { LET_TRANSFERS_THROUGH_REFUSAL } = await import('../../src/resident-mutes.ts')
      for (const change of [
        { mute: { type: 'place', id: rooms.westRoomId, let_transfers_through: true } },
        { mute: { type: 'resident', id: GIVER.id, let_transfers_through: 'yes' } },
        { unmute: { type: 'resident', id: GIVER.id, let_transfers_through: true } },
      ]) {
        const refused = await call(app, NEIGHBOUR.secret, 'PATCH', '/api/me/settings', change)
        assert.equal(refused.status, 400, JSON.stringify(change))
        assert.ok(String(refused.json.error).startsWith(LET_TRANSFERS_THROUGH_REFUSAL), String(refused.json.error))
      }
      await muteGrower(app)
      const held = await give(app, 'thing', other)
      assert.equal(waitingOf(held.json).note, HELD_FOR_NEIGHBOUR)
      assert.equal(await ownerOf('things', other), GIVER.id)
    })

    await t.test('a place gift holding the giver\'s home says so to the giver alone, and clears the home only on accept', async () => {
      const rooms = await resetCity(RESIDENTS)
      await standIn(GIVER.id, rooms.eastRoomId)
      const plot = await seedPlace(rooms.continentId, 'Grower Plot', GIVER.id)
      const shed = await seedPlace(plot, 'Grower Shed', GIVER.id)
      const field = await seedPlace(rooms.continentId, 'Grower Field', GIVER.id)
      await db.query('UPDATE resident_presence SET home_place_id = $2 WHERE resident_id = $1', [GIVER.id, shed])
      await muteGrower(app)

      const held = await give(app, 'place', plot)
      assert.equal(held.status, 200, JSON.stringify(held.json))
      assert.deepEqual(held.json.attention, [HOME_LINE])
      assert.equal(waitingOf(held.json).note, HELD_FOR_NEIGHBOUR)
      const noHome = await give(app, 'place', field)
      assert.deepEqual(noHome.json.attention, [])
      assert.equal(await ownerOf('places', plot), GIVER.id)
      const home = async () => (await db.query('SELECT home_place_id FROM resident_presence WHERE resident_id = $1', [GIVER.id])).rows[0]!.home_place_id
      assert.equal(await home(), shed)

      // The recipient's answers never carry the giver's home.
      const shown = await read(app, '/api/me/settings', NEIGHBOUR.secret)
      assert.doesNotMatch(shown.text, /home/iu)
      const accepted = await call(app, NEIGHBOUR.secret, 'POST', `/api/transfer/waiting/${waitingOf(held.json).waiting_id}/accept`)
      assert.equal(accepted.status, 200, JSON.stringify(accepted.json))
      assert.doesNotMatch(JSON.stringify(accepted.json), /home|attention/iu)
      assert.equal(await ownerOf('places', plot), NEIGHBOUR.id)
      assert.equal(await ownerOf('places', shed), NEIGHBOUR.id)
      assert.equal(await home(), null)
    })

    await t.test('a use with to_handle holds its transfer and runs the rest; an act give holds; the engine path holds', async () => {
      const rooms = await resetCity(RESIDENTS)
      await standIn(GIVER.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      const coined = await coin(app, GIVER.secret, 'hand-over', {
        use: [
          { effect: 'label', target: 'source', label: 'offered' },
          { effect: 'transfer', target: 'source', to: 'recipient' },
        ],
      })
      assert.equal(coined.status, 201, JSON.stringify(coined.json))
      const kind = await seedKind(GIVER.id, 'parcel', [await traitId('hand-over')])
      const parcel = await seedThing(GIVER.id, rooms.eastRoomId, kind, 'a parcel')
      const plain = await seedThing(GIVER.id, rooms.eastRoomId, null, 'a plain lantern')
      const engineThing = await seedThing(GIVER.id, rooms.eastRoomId, null, 'an engine lantern')
      await muteGrower(app)
      const before = await count(`SELECT count(*) FROM events WHERE kind = 'transfer'`)

      const used = await call(app, GIVER.secret, 'POST', '/api/action', { action: 'use', thing_id: parcel, to_handle: NEIGHBOUR.handle })
      assert.equal(used.status, 200, JSON.stringify(used.json))
      const usedAction = used.json.action as Json
      assert.equal(usedAction.status, 'applied')
      assert.equal(usedAction.effects_applied, 2)
      assert.equal(waitingOf(usedAction).note, HELD_FOR_NEIGHBOUR)
      assert.equal(await ownerOf('things', parcel), GIVER.id)
      assert.equal(await count(`SELECT count(*) FROM active_labels WHERE target_type = 'thing' AND target_id = $1 AND label = 'offered'`, [parcel]), 1)
      assert.equal(await count('SELECT count(*) FROM waiting_transfers WHERE asset_id = $1 AND answer IS NULL', [parcel]), 1)
      assert.equal(await count(`SELECT count(*) FROM events WHERE kind = 'transfer'`), before)

      const actionsBefore = await count('SELECT count(*) FROM action_runs')
      const acted = await call(app, GIVER.secret, 'POST', '/api/action', { action: 'give', thing_id: plain, to_handle: NEIGHBOUR.handle })
      assert.equal(acted.status, 200, JSON.stringify(acted.json))
      assert.equal((acted.json.action as Json).status, 'held')
      assert.equal(waitingOf(acted.json.action as Json).note, HELD_FOR_NEIGHBOUR)
      assert.equal(await ownerOf('things', plain), GIVER.id)
      assert.equal(await count('SELECT count(*) FROM action_runs'), actionsBefore)
      assert.equal(await count(`SELECT count(*) FROM events WHERE kind = 'transfer'`), before)

      // The same transfer effect a timer resolves later, run through the engine directly.
      const { executeEffectsWithOutcome, newAbilityLog } = await import('../../src/engine-effects.ts')
      const { sql } = await import('../../src/db.ts')
      const abilityLog = newAbilityLog()
      await executeEffectsWithOutcome([{ effect: 'transfer', target: 'source', to: 'recipient' }], {
        actionId: null, actorId: GIVER.id, actorHandle: GIVER.handle, placeId: rooms.eastRoomId,
        sourceThingId: engineThing, sharedSourceThingId: null, target: null, destinationPlaceId: null,
        recipientId: NEIGHBOUR.id, sourceTraitId: null, lawAuthority: null, parentEffectId: null,
        generation: 1, logicalAt: new Date(), trigger: 'timer', abilityLog,
      }, sql as never)
      assert.equal(abilityLog.waiting.length, 1)
      assert.equal(abilityLog.waiting[0]!.note, HELD_FOR_NEIGHBOUR)
      assert.equal(await ownerOf('things', engineThing), GIVER.id)
      assert.equal(await count(`SELECT count(*) FROM events WHERE kind = 'transfer'`), before)
    })

    await t.test('a credit gift is never held, even from a purchase while the recipient keeps mutes', async () => {
      await resetCity(RESIDENTS)
      await muteGrower(app)
      const { sql } = await import('../../src/db.ts')
      const { deliverPayPalCredit } = await import('../../src/paypal-credit-delivery.ts')
      const { attachPayPalOrder, beginPayPalCreditIntent } = await import('../../src/paypal-credit-store.ts')
      const intent = await beginPayPalCreditIntent(sql as never, {
        requestId: 'held-gifts-credit-0001',
        intentKind: 'order',
        delivery: 'gift',
        recipientId: NEIGHBOUR.id,
        amountUnits: 1_000_000n,
        paypalEnvironment: 'sandbox',
      })
      const order = await attachPayPalOrder(sql as never, { purchaseId: intent.purchaseId, orderId: 'HELD-GIFTS-ORDER-0001' })
      const pending = await deliverPayPalCredit(sql as never, {
        intent: Object.freeze({ ...intent, remoteOrderId: order.orderId, status: order.status }),
        sourceKey: 'paypal:capture:HELD-GIFTS-CAPTURE-0001',
        purchaseKind: 'paypal',
        eventId: 'HELD-GIFTS-EVENT-0001',
        eventKind: 'PAYMENT.CAPTURE.COMPLETED',
        remoteResourceId: 'HELD-GIFTS-CAPTURE-0001',
      })
      assert.equal(pending.status, 'pending')
      const accepted = await call(app, NEIGHBOUR.secret, 'POST', `/api/city-credit/gifts/${pending.gift_id}/accept`)
      assert.equal(accepted.status, 200, JSON.stringify(accepted.json))
      assert.equal(await count('SELECT count(*) FROM waiting_transfers'), 0)
      assert.equal(((await read(app, '/api/me/settings', NEIGHBOUR.secret)).json.waiting_transfers as Json).count, 0)
    })

    await t.test('anonymous reads are byte-identical before and after a held give and its decline', async () => {
      const rooms = await resetCity(RESIDENTS)
      await standIn(GIVER.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      const lantern = await seedThing(GIVER.id, rooms.eastRoomId, null, 'a lantern')
      const plot = await seedPlace(rooms.continentId, 'Grower Plot', GIVER.id)
      const note = await insertId('INSERT INTO notes (place_id, author_id, body) VALUES ($1, $2, $3) RETURNING id', [rooms.eastRoomId, GIVER.id, 'a lantern for the neighbour'])
      const removed = await insertId('INSERT INTO notes (place_id, author_id, body) VALUES ($1, $2, $3) RETURNING id', [rooms.eastRoomId, GIVER.id, 'a removed note'])
      await db.query(`INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason) VALUES ('note', $1, 'remove', 1, 'fixture removal')`, [removed])
      await muteGrower(app)
      const paths = [
        '/',
        `/api/place/${rooms.eastRoomId}`,
        `/api/place/${rooms.eastRoomId}?view=full&note_text_limit_bytes=10&thing_text_limit_bytes=5`,
        `/api/place/${plot}?view=full`,
        '/api/map',
        `/api/map?view=outline&parent_id=${rooms.continentId}`,
        `/api/thing/${lantern}`,
        `/api/note/${note}`,
        `/api/note/${removed}`,
        '/api/search?q=lantern',
        '/api/changes',
        '/api/events',
        '/api/residents',
        '/api/kinds',
        '/api/agreements',
      ]
      const before = new Map<string, Read>()
      for (const path of paths) before.set(path, await read(app, path))
      const heldThing = waitingOf((await give(app, 'thing', lantern)).json)
      const heldPlace = waitingOf((await give(app, 'place', plot)).json)
      for (const path of paths) {
        const after = await read(app, path)
        assert.equal(after.status, before.get(path)!.status, path)
        assert.equal(after.text, before.get(path)!.text, `anonymous ${path} after a held give`)
      }
      for (const held of [heldThing, heldPlace]) {
        const declined = await call(app, NEIGHBOUR.secret, 'POST', `/api/transfer/waiting/${held.waiting_id}/decline`)
        assert.equal(declined.status, 200)
      }
      for (const path of paths) {
        const after = await read(app, path)
        assert.equal(after.text, before.get(path)!.text, `anonymous ${path} after a decline`)
      }
    })
  } finally {
    await postgres.stop()
  }
})
