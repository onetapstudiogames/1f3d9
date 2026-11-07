// Thing endings against real PostgreSQL 17 on the full db/schema.sql and the real routes
// (T7 onward; later tasks add to this file). The recorder writes a due end once, as the
// city, naming the owner as of the end; a resident's request records first and then
// refuses or proceeds; a use counts its uses and moves the unused clock; a thing that
// falls due during its own use never fails that use; and a guard refusal answers 409.
// T8: owners set, renew and clear ends through make, thing_edit and thing_upgrade.
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import type { PoolClient } from 'pg'
import { completeDirectSalePayment } from '../../src/payment-sale-operations.ts'
import { saleDatabase, seedRecoverableSale } from '../helpers/payment-postgres-fixtures/sales.ts'
import {
  bearer,
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const FOUNDER = Object.freeze({ id: 1, handle: 'founder', secret: `1f3d9_sk_${'1'.repeat(48)}` })
const OWNER = Object.freeze({ id: 2, handle: 'lamp-keeper', secret: `1f3d9_sk_${'2'.repeat(48)}` })
const VISITOR = Object.freeze({ id: 3, handle: 'lamp-guest', secret: `1f3d9_sk_${'3'.repeat(48)}` })
const WALLET = `0x${'ab'.repeat(20)}`
const KINDLESS_GRANT = Object.freeze({
  kindless: true,
  allowed: ['at', 'after_setting_seconds', 'uses', 'idle_seconds', 'label_added'],
  limits: { max_seconds: 31_622_400, max_uses: 10_000, labels: null },
  city_limits_version: 1,
})
const ENDED_DETAIL_KEYS = ['cause', 'ended_at', 'owner', 'owner_id', 'place_id', 'program_state', 'thing_id']

type CityApp = Readonly<{ request: (input: string, init?: RequestInit) => Response | Promise<Response> }>
type Json = Record<string, unknown>
type Answer = Readonly<{ status: number; json: Json }>

async function call(app: CityApp, secret: string | null, method: string, path: string, body?: unknown): Promise<Answer> {
  const response = await app.request(`http://city.test${path}`, {
    method,
    headers: secret === null ? {} : bearer(secret),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return Object.freeze({ status: response.status, json: text ? JSON.parse(text) as Json : {} })
}

async function one<T = Json>(text: string, values: readonly unknown[] = []): Promise<T> {
  return (await connectedDatabase().query(text, [...values])).rows[0] as T
}

async function count(text: string, values: readonly unknown[] = []): Promise<number> {
  return Number((await one<{ n: unknown }>(text, values)).n)
}

/** A room under this parent, owned by the lamp keeper, that takes things. */
async function ownerRoom(parentId: number, name: string): Promise<number> {
  return Number((await one<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, description, owner_id, open_to_things)
    VALUES ($1, 'place', $2, 'a room for endings', $3, TRUE) RETURNING id
  `, [parentId, name, OWNER.id])).id)
}

async function seedKind(name: string, traitNames: readonly string[]): Promise<number> {
  const kindId = Number((await one<{ id: number }>(
    'INSERT INTO kinds (name, owner_id) VALUES ($1, $2) RETURNING id', [name, OWNER.id],
  )).id)
  // The kind_revision_trait_links trigger links each named trait in order.
  await connectedDatabase().query(
    'INSERT INTO kind_revisions (kind_id, revision, traits) VALUES ($1, 1, $2::text[])', [kindId, [...traitNames]],
  )
  return kindId
}

async function seedThing(placeId: number, options: Readonly<{
  kindId?: number | null
  openToUse?: boolean
  wakeEnabled?: boolean
  name?: string
}> = {}): Promise<number> {
  const kindId = options.kindId ?? null
  return Number((await one<{ id: number }>(`
    INSERT INTO things (
      place_id, name, body, owner_id, maker_id, kind_id, birth_revision, current_revision, open_to_use, wake_enabled
    ) VALUES ($1, $2, '', $3, $3, $4, $5, $5, $6, $7) RETURNING id
  `, [
    placeId, options.name ?? 'an ending lamp', OWNER.id, kindId, kindId === null ? null : 1,
    options.openToUse === true, options.wakeEnabled === true,
  ])).id)
}

type EndSpec = Readonly<{
  /** A date this far from the database clock (negative is past), as a Postgres interval. */
  at?: string
  afterSettingSeconds?: number
  uses?: number
  usesLeft?: number
  usesSpentAgo?: string
  idleSeconds?: number
  idleAnchorAgo?: string
  label?: string
  /** A copy's absolute unused-for end this far from now, with its source thing. */
  copyIdleUntil?: string
  copiedFrom?: number
}>

/** Give a thing with no end the stored shape of an owner's end, set an hour ago. */
async function setEnd(thingId: number, spec: EndSpec): Promise<void> {
  const times = await one<{ at: string | null; until: string | null }>(`
    SELECT CASE WHEN $1::text IS NULL THEN NULL
        ELSE to_char((now() + $1::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS at,
      CASE WHEN $2::text IS NULL THEN NULL
        ELSE to_char((now() + $2::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS until
  `, [spec.at ?? null, spec.copyIdleUntil ?? null])
  const conditions: Json[] = []
  if (times.at !== null) conditions.push({ at: times.at })
  if (spec.afterSettingSeconds !== undefined) conditions.push({ after_setting_seconds: spec.afterSettingSeconds })
  if (spec.uses !== undefined) conditions.push({ uses: spec.uses })
  if (spec.idleSeconds !== undefined) conditions.push({ idle_seconds: spec.idleSeconds })
  if (times.until !== null) conditions.push({ idle_seconds: 3_600, until: times.until })
  if (spec.label !== undefined) conditions.push({ label_added: spec.label })
  await connectedDatabase().query(`
    UPDATE things SET
      ending_rule = $2::jsonb,
      ending_grant = $3::jsonb,
      ending_set_by = owner_id,
      ending_set_at = now() - interval '1 hour',
      ending_deadline = (SELECT min(deadline) FROM unnest(ARRAY[
        $4::timestamptz,
        CASE WHEN $5::integer IS NULL THEN NULL ELSE now() - interval '1 hour' + make_interval(secs => $5::integer) END,
        $10::timestamptz
      ]) deadline),
      ending_idle_seconds = $6::integer,
      ending_idle_anchor = CASE WHEN $6::integer IS NULL THEN NULL
        ELSE now() - coalesce($7::interval, interval '1 hour') END,
      ending_uses_left = $8::integer,
      ending_uses_spent_at = CASE WHEN $9::text IS NULL THEN NULL ELSE now() - $9::interval END,
      ending_label = $11::text,
      ending_copied_from = $12::integer,
      ending_copied_at = CASE WHEN $12::integer IS NULL THEN NULL ELSE now() - interval '1 hour' END
    WHERE id = $1
  `, [
    thingId, JSON.stringify({ any: conditions }), JSON.stringify(KINDLESS_GRANT), times.at,
    spec.afterSettingSeconds ?? null, spec.idleSeconds ?? null, spec.idleAnchorAgo ?? null,
    spec.usesLeft ?? spec.uses ?? null, spec.usesSpentAgo ?? null, times.until, spec.label ?? null,
    spec.copiedFrom ?? null,
  ])
}

async function ending(thingId: number): Promise<Json> {
  return one(`
    SELECT owner_id, ended_at, ended_cause, ended_owner_id, end_program_state, end_program_result,
      ending_uses_left, ending_uses_spent_at, ending_idle_anchor, state,
      ended_at = thing_end_due_at(id) AS ended_at_due, thing_end_due(id, now()) AS due
    FROM things WHERE id = $1
  `, [thingId])
}

async function endedEvents(thingId: number): Promise<Json[]> {
  return (await connectedDatabase().query(`
    SELECT id, actor, detail FROM events WHERE kind = 'thing_ended' AND detail->>'thing_id' = $1::text ORDER BY id
  `, [thingId])).rows
}

async function changeMarker(app: CityApp): Promise<string> {
  const read = await call(app, null, 'GET', '/api/changes')
  assert.equal(read.status, 200, JSON.stringify(read.json))
  return String(read.json.change_marker)
}

test('thing endings, the recorder and the use path, against PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('thing-endings')
  try {
    // Loaded only after the fixture points src/db.ts at the test container.
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const { recordDueEnd } = await import('../../src/thing-ending-record.ts')
    const { runAction, setEngineTransactionRunnerForTests } = await import('../../src/engine.ts')
    const {
      THING_ENDED_SKIP_REASON,
      THING_ENDING_CHANGED_REFUSAL,
      THING_REMNANT_REFUSAL,
    } = await import('../../src/thing-ending-refusals.ts')
    const db = connectedDatabase()

    let room = 0
    let otherRoom = 0
    let continentId = 0
    const reset = async () => {
      const rooms = await resetCity([FOUNDER, OWNER, VISITOR])
      continentId = rooms.continentId
      room = await ownerRoom(rooms.continentId, 'Ending Room')
      // Inside the ending room, so a resident can walk between the two.
      otherRoom = await ownerRoom(room, 'Inner Ending Room')
      await standIn(OWNER.id, room)
      await standIn(VISITOR.id, room)
    }
    const coin = async (name: string, recipe: unknown) => {
      const coined = await call(app, OWNER.secret, 'POST', '/api/trait', {
        name, description: `${name} for the thing endings suite`, recipe,
      })
      assert.equal(coined.status, 201, JSON.stringify(coined.json))
    }
    const act = (secret: string, body: Json) => call(app, secret, 'POST', '/api/action', body)

    await t.test('the recorder writes an end once, as the city, and a second call records nothing', async () => {
      await reset()
      await coin('end-glow', { end: { then: [] } })
      const stampedBefore = (await one<Json>('SELECT last_public_action_at FROM residents WHERE id = $1', [OWNER.id])).last_public_action_at
      const lamp = await seedKind('ending-lamps', ['end-glow'])
      const thingId = await seedThing(room, { kindId: lamp })
      const kindless = await seedThing(room)
      const notDue = await seedThing(room)
      const noEnd = await seedThing(room)
      await setEnd(thingId, { at: '-10 minutes' })
      await setEnd(kindless, { at: '-5 minutes' })
      await setEnd(notDue, { at: '10 days' })

      assert.deepEqual(await recordDueEnd([thingId, thingId, notDue, noEnd, kindless]), [thingId, kindless])
      const row = await ending(thingId)
      assert.equal(row.ended_at_due, true)
      assert.equal(row.ended_cause, 'at')
      assert.equal(row.ended_owner_id, OWNER.id)
      assert.equal(row.end_program_state, 'pending', 'its kind lists an end-key trait')
      assert.equal(row.end_program_result, null, 'the recorder never writes a result')
      assert.equal((await ending(kindless)).end_program_state, 'none')
      assert.equal((await ending(notDue)).ended_at, null)
      assert.equal((await ending(noEnd)).ended_at, null)

      const events = await endedEvents(thingId)
      assert.equal(events.length, 1)
      assert.equal(events[0]!.actor, 'the city')
      const detail = events[0]!.detail as Json
      assert.deepEqual(Object.keys(detail).sort(), ENDED_DETAIL_KEYS)
      assert.equal(detail.thing_id, thingId)
      assert.equal(detail.place_id, room)
      assert.equal(detail.cause, 'at')
      assert.equal(detail.owner_id, OWNER.id)
      assert.equal(detail.owner, OWNER.handle)
      assert.equal(detail.program_state, 'pending')
      assert.equal(await count(`SELECT count(*) AS n FROM thing_ending_changes WHERE thing_id = $1 AND change = 'end'`, [thingId]), 1)
      const change = await one<Json>(`SELECT actor_id, rule, "grant", result FROM thing_ending_changes WHERE thing_id = $1`, [thingId])
      assert.equal(change.actor_id, null)
      assert.deepEqual(Object.keys(change.result as Json).sort(), ['cause', 'ended_at', 'owner_id', 'program_state'])

      assert.deepEqual(await recordDueEnd([thingId, kindless]), [])
      assert.equal((await endedEvents(thingId)).length, 1)
      assert.equal(await count(`SELECT count(*) AS n FROM thing_ending_changes WHERE thing_id = $1`, [thingId]), 1)
      // Bookkeeping: the city's record stamps nobody's public activity (#173).
      assert.equal((await one<Json>(`SELECT public_activity_potential_kind('thing_ended') AS potential`)).potential, false)
      assert.deepEqual((await one<Json>('SELECT last_public_action_at FROM residents WHERE id = $1', [OWNER.id])).last_public_action_at, stampedBefore)
    })

    await t.test('a thing withdrawn before its end came is never recorded, and a use of it answers 404', async sub => {
      await reset()
      const thingId = await seedThing(room, { openToUse: true })
      await setEnd(thingId, { at: '1 day' })
      await db.query(`UPDATE things SET ending_deadline = clock_timestamp() + interval '1500 milliseconds' WHERE id = $1`, [thingId])
      await db.query('UPDATE things SET withdrawn_at = clock_timestamp() WHERE id = $1', [thingId])
      await delay(2_000)
      assert.equal((await one<Json>('SELECT thing_end_due(id, now()) AS due FROM things WHERE id = $1', [thingId])).due, true)
      const logged = sub.mock.method(console, 'error', () => undefined)
      assert.deepEqual(await recordDueEnd([thingId]), [])
      const used = await act(VISITOR.secret, { action: 'use', thing_id: thingId })
      assert.equal(used.status, 404, JSON.stringify(used.json))
      const failures = logged.mock.calls.filter(entry => String(entry.arguments[0]).includes('record failed'))
      assert.equal(failures.length, 0, 'no failing record transaction')
      assert.equal((await ending(thingId)).ended_at, null)
      assert.equal((await endedEvents(thingId)).length, 0)
    })

    await t.test('ended_cause names the condition met first, for each mode and a copy', async () => {
      await reset()
      const cases: Array<readonly [string, EndSpec]> = [
        ['at', { at: '-1 minute', uses: 9 }],
        ['after_setting_seconds', { afterSettingSeconds: 60, at: '5 days' }],
        ['uses', { uses: 3, usesLeft: 0, usesSpentAgo: '2 minutes', at: '5 days' }],
        ['idle_seconds', { idleSeconds: 60, idleAnchorAgo: '1 hour', at: '5 days' }],
        ['label_added', { label: 'spent', at: '5 days' }],
      ]
      for (const [cause, spec] of cases) {
        const thingId = await seedThing(room)
        await setEnd(thingId, spec)
        if (cause === 'label_added') {
          await db.query(`INSERT INTO active_labels (target_type, target_id, label, actor_id) VALUES ('thing', $1, 'spent', $2)`, [thingId, OWNER.id])
        }
        assert.deepEqual(await recordDueEnd([thingId]), [thingId], cause)
        assert.equal((await ending(thingId)).ended_cause, cause, cause)
        assert.equal((await ending(thingId)).ended_at_due, true, cause)
      }
      // A copy's unused-for end is an absolute time, and it still records idle_seconds.
      const parent = await seedThing(room)
      const copy = Number((await one<{ id: number }>(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id, parent_thing_id, family_id, generation)
        VALUES ($1, 'a copied lamp', '', $2, $2, $3, $3, 1) RETURNING id
      `, [room, OWNER.id, parent])).id)
      await setEnd(copy, { copyIdleUntil: '-3 minutes', at: '5 days', copiedFrom: parent })
      assert.deepEqual(await recordDueEnd([copy]), [copy])
      assert.equal((await ending(copy)).ended_cause, 'idle_seconds')
    })

    await t.test('the owner at the end is the seller when recovery closed the sale after the end came', async () => {
      await reset()
      const seed = await seedRecoverableSale(db, 'direct_sale', '7')
      await setEnd(seed.assetId, { at: '-1 minute' })
      const completed = await completeDirectSalePayment(saleDatabase(db), { attemptId: seed.attemptId, leaseOwner: seed.leaseOwner })
      assert.equal(completed.state, 'completed')
      assert.equal((await ending(seed.assetId)).owner_id, OWNER.id, 'the buyer owns it now')
      assert.deepEqual(await recordDueEnd([seed.assetId]), [seed.assetId])
      assert.equal((await ending(seed.assetId)).ended_owner_id, FOUNDER.id)
      assert.equal(((await endedEvents(seed.assetId))[0]!.detail as Json).owner, FOUNDER.handle)

      // A gift made before the end names its recipient.
      const given = await seedThing(room)
      await db.query(`UPDATE things SET owner_id = $2 WHERE id = $1`, [given, VISITOR.id])
      await db.query(`
        INSERT INTO transfers (asset_type, asset_id, from_id, to_id, created_at)
        VALUES ('thing', $1, $2, $3, now() - interval '2 hours')
      `, [given, OWNER.id, VISITOR.id])
      await setEnd(given, { at: '-1 minute' })
      assert.deepEqual(await recordDueEnd([given]), [given])
      assert.equal((await ending(given)).ended_owner_id, VISITOR.id)
    })

    await t.test('a visitor using a due thing records it as the city and is refused E7', async () => {
      await reset()
      const thingId = await seedThing(room, { openToUse: true })
      await setEnd(thingId, { at: '-1 minute' })
      const used = await act(VISITOR.secret, { action: 'use', thing_id: thingId })
      assert.equal(used.status, 409, JSON.stringify(used.json))
      assert.equal(used.json.error, THING_REMNANT_REFUSAL)
      const events = await endedEvents(thingId)
      assert.equal(events.length, 1)
      assert.equal(events[0]!.actor, 'the city', 'never the resident whose request recorded it')
      assert.equal((events[0]!.detail as Json).owner, OWNER.handle)
      const again = await act(VISITOR.secret, { action: 'use', thing_id: thingId })
      assert.equal(again.status, 409)
      // A repeated refusal adds the city's "same refusal again" line after the words.
      assert.ok(String(again.json.error).startsWith(THING_REMNANT_REFUSAL))
      assert.equal((await endedEvents(thingId)).length, 1, 'a second request records nothing')
      const consumed = await act(OWNER.secret, { action: 'consume', thing_id: thingId })
      assert.equal(consumed.status, 409)
      assert.equal(consumed.json.error, THING_REMNANT_REFUSAL)
    })

    await t.test('a give of a thing recorded by this request refuses E7; an older remnant can be given', async () => {
      await reset()
      await coin('glad-giver', { give: [{ effect: 'write', key: 'given', op: 'add' }] })
      const kindId = await seedKind('given-lamps', ['glad-giver'])
      const actGiven = await seedThing(room, { kindId, wakeEnabled: true })
      await setEnd(actGiven, { at: '-1 minute' })
      const first = await act(OWNER.secret, { action: 'give', thing_id: actGiven, to_handle: VISITOR.handle })
      assert.equal(first.status, 409, JSON.stringify(first.json))
      assert.equal(first.json.error, THING_REMNANT_REFUSAL)
      assert.equal((await ending(actGiven)).owner_id, OWNER.id)
      assert.notEqual((await ending(actGiven)).ended_at, null)

      const second = await act(OWNER.secret, { action: 'give', thing_id: actGiven, to_handle: VISITOR.handle })
      assert.equal(second.status, 200, JSON.stringify(second.json))
      const action = second.json.action as Json
      assert.equal(action.status, 'applied')
      assert.deepEqual((action.skipped_effects as Json[]).map(skip => [skip.effect, skip.source_trait, skip.reason]), [
        ['write', 'glad-giver', THING_ENDED_SKIP_REASON],
      ])
      const after = await one<Json>('SELECT owner_id, state, wake_enabled FROM things WHERE id = $1', [actGiven])
      assert.deepEqual(after, { owner_id: VISITOR.id, state: {}, wake_enabled: false })
      assert.equal((await endedEvents(actGiven)).length, 1)

      // The transfer route's gift follows the same rule.
      const transferGiven = await seedThing(room)
      await setEnd(transferGiven, { at: '-1 minute' })
      const refused = await call(app, OWNER.secret, 'POST', '/api/transfer', { type: 'thing', id: transferGiven, to_handle: VISITOR.handle })
      assert.equal(refused.status, 409, JSON.stringify(refused.json))
      assert.equal(refused.json.error, THING_REMNANT_REFUSAL)
      const passed = await call(app, OWNER.secret, 'POST', '/api/transfer', { type: 'thing', id: transferGiven, to_handle: VISITOR.handle })
      assert.equal(passed.status, 200, JSON.stringify(passed.json))
      assert.equal((await ending(transferGiven)).owner_id, VISITOR.id)

      // A sale offer runs as a give too, and an older remnant still refuses E7 there, not E16.
      const offered = await seedThing(room)
      await setEnd(offered, { at: '-1 minute' })
      assert.deepEqual(await recordDueEnd([offered]), [offered])
      const offer = await call(app, OWNER.secret, 'POST', '/api/transfer/offer', {
        type: 'thing', id: offered, to_handle: VISITOR.handle, price_usdc: 1, seller_wallet: WALLET,
      })
      assert.equal(offer.status, 409, JSON.stringify(offer.json))
      assert.equal(offer.json.error, THING_REMNANT_REFUSAL)
      assert.equal(await count(`SELECT count(*) AS n FROM transfer_offers WHERE asset_id = $1`, [offered]), 0)
    })

    await t.test('a use counts its uses and moves the unused clock; reads, visits, waking and moving do not', async () => {
      await reset()
      const shared = await seedThing(room, { openToUse: true })
      await setEnd(shared, { uses: 3, at: '5 days' })
      const used = await act(VISITOR.secret, { action: 'use', thing_id: shared })
      assert.equal(used.status, 200, JSON.stringify(used.json))
      assert.equal((used.json.action as Json).status, 'noop', 'a use that changed nothing still happened')
      assert.equal((await ending(shared)).ending_uses_left, 2)
      await db.query('UPDATE things SET open_to_use = FALSE WHERE id = $1', [shared])
      const refused = await act(VISITOR.secret, { action: 'use', thing_id: shared })
      assert.equal(refused.status, 403, JSON.stringify(refused.json))
      assert.equal((await ending(shared)).ending_uses_left, 2, 'a refused use counts nothing')

      await coin('wake-counter', { wake: { then: [{ effect: 'write', key: 'woke', op: 'add' }] } })
      const kindId = await seedKind('waking-lamps', ['wake-counter'])
      const idle = await seedThing(room, { kindId, wakeEnabled: true })
      const carried = await seedThing(room)
      await setEnd(idle, { idleSeconds: 86_400, idleAnchorAgo: '10 minutes' })
      await setEnd(carried, { idleSeconds: 86_400, idleAnchorAgo: '10 minutes' })
      const anchor = (await ending(idle)).ending_idle_anchor as Date
      const carriedAnchor = (await ending(carried)).ending_idle_anchor as Date
      assert.equal((await call(app, null, 'GET', `/api/thing/${idle}`)).status, 200)
      await standIn(VISITOR.id, otherRoom)
      const visit = await act(VISITOR.secret, { action: 'move', to_place_id: room })
      assert.equal(visit.status, 200, JSON.stringify(visit.json))
      assert.deepEqual((await ending(idle)).state, { woke: 1 }, 'the visit woke it')
      const moved = await act(OWNER.secret, { action: 'move', to_place_id: otherRoom, carry_thing_id: carried })
      assert.equal(moved.status, 200, JSON.stringify(moved.json))
      assert.equal(((await ending(idle)).ending_idle_anchor as Date).getTime(), anchor.getTime())
      assert.equal(((await ending(carried)).ending_idle_anchor as Date).getTime(), carriedAnchor.getTime())

      await standIn(OWNER.id, room)
      const usedIdle = await act(OWNER.secret, { action: 'use', thing_id: idle })
      assert.equal(usedIdle.status, 200, JSON.stringify(usedIdle.json))
      assert.ok(((await ending(idle)).ending_idle_anchor as Date).getTime() > anchor.getTime())
    })

    await t.test('a use that labels its own source with its end label finishes, and the thing reads due', async () => {
      await reset()
      await coin('self-spender', {
        use: [
          { effect: 'label', target: 'source', label: 'spent' },
          { effect: 'write', key: 'n', op: 'add' },
        ],
      })
      await coin('self-spender-copy', {
        use: [
          { effect: 'label', target: 'source', label: 'spent' },
          { effect: 'copy' },
        ],
      })
      const writer = await seedThing(room, { kindId: await seedKind('spending-lamps', ['self-spender']) })
      const copier = await seedThing(room, { kindId: await seedKind('spending-seeds', ['self-spender-copy']) })
      for (const thingId of [writer, copier]) {
        await setEnd(thingId, { label: 'spent', uses: 5 })
        const used = await act(OWNER.secret, { action: 'use', thing_id: thingId })
        assert.equal(used.status, 200, JSON.stringify(used.json))
        const action = used.json.action as Json
        assert.equal(action.status, 'applied')
        assert.equal(action.effects_applied, 1)
        assert.deepEqual((action.skipped_effects as Json[]).map(skip => [skip.effect, skip.reason]), [
          [thingId === writer ? 'write' : 'copy', THING_ENDED_SKIP_REASON],
        ])
        const row = await ending(thingId)
        assert.deepEqual(row.state, {})
        assert.equal(row.ending_uses_left, 5, 'the count does not move on a thing that fell due during the use')
        assert.equal(row.ended_cause, 'label_added', 'recorded right after the use')
        assert.equal(row.ended_at_due, true)
      }
      assert.equal(await count('SELECT count(*) AS n FROM things WHERE parent_thing_id = $1', [copier]), 0)
    })

    await t.test('a use that spends its last use runs its copy step and reads due afterwards', async () => {
      await reset()
      await coin('last-sprout', { use: [{ effect: 'copy' }] })
      const thingId = await seedThing(room, { kindId: await seedKind('last-sprouts', ['last-sprout']) })
      await setEnd(thingId, { uses: 1, at: '5 days' })
      const used = await act(OWNER.secret, { action: 'use', thing_id: thingId })
      assert.equal(used.status, 200, JSON.stringify(used.json))
      assert.equal((used.json.action as Json).effects_applied, 1)
      assert.equal(await count('SELECT count(*) AS n FROM things WHERE parent_thing_id = $1', [thingId]), 1)
      const row = await ending(thingId)
      assert.equal(row.ending_uses_left, 0)
      const spent = await one<Json>('SELECT ending_uses_spent_at = ended_at AS same FROM things WHERE id = $1', [thingId])
      assert.equal(spent.same, true, 'spent at the use transaction time, which the end records')
      assert.equal(row.ended_cause, 'uses')
      const again = await act(OWNER.secret, { action: 'use', thing_id: thingId })
      assert.equal(again.status, 409)
      assert.equal(again.json.error, THING_REMNANT_REFUSAL)
    })

    await t.test('one clock: a use begun before the end treats the thing as not due and never ends in E16', async () => {
      await reset()
      const thingId = await seedThing(room)
      await setEnd(thingId, { uses: 5, at: '1 day' })
      await db.query(`UPDATE things SET ending_deadline = clock_timestamp() + interval '1500 milliseconds' WHERE id = $1`, [thingId])
      let delayed = false
      setEngineTransactionRunnerForTests(async (_ignored, work) => {
        const client: PoolClient = await db.connect()
        try {
          await client.query('BEGIN')
          await client.query('SELECT transaction_timestamp()')
          if (!delayed) {
            delayed = true
            await delay(2_000)
          }
          const tagged = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const text = strings.reduce((sql, part, index) => sql + part + (index < values.length ? `$${index + 1}` : ''), '')
            return (await client.query(text, values)).rows
          }, { query: async (text: string, values: readonly unknown[] = []) => (await client.query(text, [...values])).rows })
          const result = await work(tagged, true)
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined)
          throw error
        } finally {
          client.release()
        }
      })
      try {
        const result = await runAction({
          actorId: OWNER.id, actorHandle: OWNER.handle, action: 'use', placeId: room, sourceThingId: thingId, payload: {},
        })
        assert.equal(result.error, null)
        assert.equal(result.status, 'noop')
      } finally {
        // The runner stays: after its one delay it opens plain transactions on this
        // database, as the fixture's own runner does, and the fixture removes it at stop.
        delayed = true
      }
      assert.equal(delayed, true)
      const row = await ending(thingId)
      assert.equal(row.ending_uses_left, 4, 'counted at the transaction time, before the end')
      assert.equal(row.ended_cause, 'at', 'recorded after the use committed')
    })

    await t.test('the change feed carries thing_ended with its details, and leaves out feed rooms', async () => {
      await reset()
      const before = await changeMarker(app)
      const thingId = await seedThing(room)
      await setEnd(thingId, { at: '-1 minute' })
      await recordDueEnd([thingId])
      const changes = await call(app, null, 'GET', `/api/changes?since=${before}&limit=200`)
      assert.equal(changes.status, 200, JSON.stringify(changes.json))
      const ended = (changes.json.changes as Json[]).filter(row => row.kind === 'thing_ended')
      assert.equal(ended.length, 1)
      const detail = ended[0]!.detail as Json
      for (const key of ENDED_DETAIL_KEYS) assert.ok(Object.hasOwn(detail, key), key)
      assert.equal(detail.owner, OWNER.handle)
      assert.equal(ended[0]!.actor, 'the city')

      const feedRoom = await ownerRoom(continentId, 'Ending Feed Room')
      await db.query('UPDATE places SET quiet = TRUE, feed = TRUE WHERE id = $1', [feedRoom])
      const marker = await changeMarker(app)
      const inFeed = await seedThing(feedRoom)
      await setEnd(inFeed, { at: '-1 minute' })
      assert.deepEqual(await recordDueEnd([inFeed]), [inFeed])
      const feed = await call(app, null, 'GET', `/api/changes?since=${marker}&limit=200`)
      assert.equal(feed.status, 200, JSON.stringify(feed.json))
      assert.equal((feed.json.changes as Json[]).some(row => row.kind === 'thing_ended'), false)
      assert.equal((feed.json.left_out_feed_rooms as Json).count, 1)
    })

    // T8: the owner sets, renews and clears an end through make, thing_edit and thing_upgrade.
    const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()
    const edit = (secret: string, thingId: number, body: Json) => call(app, secret, 'PATCH', `/api/thing/${thingId}`, body)
    const upgrade = (secret: string, thingId: number, body: Json = {}) => call(app, secret, 'POST', `/api/thing/${thingId}/upgrade`, body)
    const endColumns = (thingId: number) => one<Json>(`
      SELECT ending_rule, ending_grant, ending_set_by, ending_set_at, ending_deadline, ending_idle_seconds,
        ending_idle_anchor, ending_uses_left, ending_uses_spent_at, ending_label, ending_copied_from,
        ending_copied_at, ended_at, current_revision, name
      FROM things WHERE id = $1
    `, [thingId])
    const endChanges = async (thingId: number) => (await db.query(`
      SELECT change, actor_id, rule, "grant" FROM thing_ending_changes WHERE thing_id = $1 ORDER BY id
    `, [thingId])).rows as Json[]
    const editedEvents = (thingId: number) => count(
      `SELECT count(*) AS n FROM events WHERE kind = 'thing_edited' AND detail->>'thing_id' = $1::text`, [thingId],
    )
    /** A kind whose revisions 1..n carry these ending policies; its current revision is the last. */
    const seedPolicyKind = async (name: string, policies: readonly Json[]): Promise<number> => {
      const kindId = Number((await one<{ id: number }>(
        'INSERT INTO kinds (name, owner_id) VALUES ($1, $2) RETURNING id', [name, OWNER.id],
      )).id)
      for (const [index, policy] of policies.entries()) {
        await db.query(
          'INSERT INTO kind_revisions (kind_id, revision, ending_policy) VALUES ($1, $2, $3::jsonb)',
          [kindId, index + 1, JSON.stringify(policy)],
        )
      }
      await db.query('UPDATE kinds SET current_revision = $2 WHERE id = $1', [kindId, policies.length])
      return kindId
    }
    const {
      ENDING_COPY_FIXED_REFUSAL,
      ENDING_MARKED_REFUSAL,
      ENDING_NOT_ALLOWED_REFUSAL,
      ENDING_REMNANT_CHANGE_REFUSAL,
      ENDING_SHAPE_REFUSAL,
      KINDLESS_ENDING_REFUSAL,
    } = await import('../../src/thing-ending-refusals.ts')

    await t.test('make sets an end on a kindless or a crafted thing inside its grant, and refuses outside it', async () => {
      await reset()
      const made = await call(app, OWNER.secret, 'POST', '/api/thing', {
        place_id: room, name: 'a timed lamp', body: '',
        ending: { any: [{ uses: 3 }, { after_setting_seconds: 3_600 }] },
      })
      assert.equal(made.status, 201, JSON.stringify(made.json))
      const madeId = Number((made.json.thing as Json).id)
      const row = await endColumns(madeId)
      assert.deepEqual(row.ending_rule, { any: [{ after_setting_seconds: 3_600 }, { uses: 3 }] }, 'stored in canonical order')
      assert.deepEqual(row.ending_grant, KINDLESS_GRANT)
      assert.equal(row.ending_set_by, OWNER.id)
      assert.equal(row.ending_uses_left, 3)
      assert.equal((row.ending_deadline as Date).getTime() - (row.ending_set_at as Date).getTime(), 3_600_000)
      const setAt = (await one<Json>(`
        SELECT ending_set_at = date_trunc('milliseconds', created_at) AS same FROM things WHERE id = $1
      `, [madeId])).same
      assert.equal(setAt, true, 'set at the make transaction time, to the millisecond')
      assert.deepEqual((await endChanges(madeId)).map(change => [change.change, change.actor_id]), [['set', OWNER.id]])

      const plain = await call(app, OWNER.secret, 'POST', '/api/thing', { place_id: room, name: 'a plain lamp', body: '', ending: null })
      assert.equal(plain.status, 201, JSON.stringify(plain.json))
      assert.equal((await endColumns(Number((plain.json.thing as Json).id))).ending_rule, null)

      const thingsBefore = await count('SELECT count(*) AS n FROM things')
      const malformed = await call(app, OWNER.secret, 'POST', '/api/thing', {
        place_id: room, name: 'a broken lamp', body: '', ending: { any: [{ uses: 0 }] },
      })
      assert.equal(malformed.status, 400, JSON.stringify(malformed.json))
      assert.equal(malformed.json.error, ENDING_SHAPE_REFUSAL)
      const past = await call(app, OWNER.secret, 'POST', '/api/thing', {
        place_id: room, name: 'a late lamp', body: '', ending: { any: [{ at: inDays(-1) }] },
      })
      assert.equal(past.status, 400, JSON.stringify(past.json))

      const candles = await seedPolicyKind('timed-candles', [{ allowed: ['uses', 'label_added'], labels: ['snuffed'], max_uses: 5 }])
      const crafted = await call(app, OWNER.secret, 'POST', '/api/thing', {
        place_id: room, name: 'a timed candle', body: '', kind_id: candles, ingredient_ids: [],
        ending: { any: [{ uses: 4 }, { label_added: 'snuffed' }] },
      })
      assert.equal(crafted.status, 201, JSON.stringify(crafted.json))
      const craftedId = Number((crafted.json.thing as Json).id)
      const grant = (await endColumns(craftedId)).ending_grant as Json
      assert.equal(grant.kind_id, candles)
      assert.equal(grant.revision, 1)
      assert.deepEqual(grant.allowed, ['uses', 'label_added'])
      assert.deepEqual(grant.limits, { max_seconds: 31_622_400, max_uses: 5, labels: ['snuffed'] })
      assert.equal((await endColumns(craftedId)).ending_label, 'snuffed')
      assert.deepEqual((await endChanges(craftedId)).map(change => change.change), ['set'])

      const notAllowed = await call(app, OWNER.secret, 'POST', '/api/thing', {
        place_id: room, name: 'a dated candle', body: '', kind_id: candles, ingredient_ids: [],
        ending: { any: [{ at: inDays(2) }] },
      })
      assert.equal(notAllowed.status, 403, JSON.stringify(notAllowed.json))
      assert.equal(notAllowed.json.error, ENDING_NOT_ALLOWED_REFUSAL)
      const overLimit = await call(app, OWNER.secret, 'POST', '/api/thing', {
        place_id: room, name: 'a long candle', body: '', kind_id: candles, ingredient_ids: [],
        ending: { any: [{ uses: 6 }] },
      })
      assert.equal(overLimit.status, 400, JSON.stringify(overLimit.json))
      assert.equal(overLimit.json.error, ENDING_SHAPE_REFUSAL)
      const otherLabel = await call(app, OWNER.secret, 'POST', '/api/thing', {
        place_id: room, name: 'a labelled candle', body: '', kind_id: candles, ingredient_ids: [],
        ending: { any: [{ label_added: 'melted' }] },
      })
      assert.equal(otherLabel.status, 400, JSON.stringify(otherLabel.json))
      assert.equal(await count('SELECT count(*) AS n FROM things'), thingsBefore + 1, 'only the allowed craft made a thing')
      const unknownField = await call(app, OWNER.secret, 'POST', '/api/thing', { place_id: room, name: 'x', body: '', endings: null })
      assert.equal(unknownField.status, 400)
      assert.match(String(unknownField.json.error), /optional kind_id, ingredient_ids, and optional ending$/u)
    })

    await t.test('thing_edit sets, renews and clears an end, and an exact repeat writes nothing', async () => {
      await reset()
      const thingId = await seedThing(room)
      const date = inDays(3)
      const set = await edit(OWNER.secret, thingId, { ending: { any: [{ at: date }] } })
      assert.equal(set.status, 200, JSON.stringify(set.json))
      const first = await endColumns(thingId)
      assert.deepEqual(first.ending_rule, { any: [{ at: date }] })
      assert.deepEqual(first.ending_grant, KINDLESS_GRANT)
      assert.equal((first.ending_deadline as Date).toISOString(), date)
      assert.equal(await editedEvents(thingId), 1)

      const repeat = await edit(OWNER.secret, thingId, { ending: { any: [{ at: date }] } })
      assert.equal(repeat.status, 200, JSON.stringify(repeat.json))
      assert.equal(((await endColumns(thingId)).ending_set_at as Date).getTime(), (first.ending_set_at as Date).getTime())
      assert.equal((await endChanges(thingId)).length, 1, 'an exact repeat writes nothing')
      assert.equal(await editedEvents(thingId), 1)

      const renewed = await edit(OWNER.secret, thingId, { ending: { any: [{ at: date }, { idle_seconds: 600 }] } })
      assert.equal(renewed.status, 200, JSON.stringify(renewed.json))
      const second = await endColumns(thingId)
      assert.equal(second.ending_idle_seconds, 600)
      assert.equal((second.ending_idle_anchor as Date).getTime(), (second.ending_set_at as Date).getTime())
      assert.deepEqual(second.ending_grant, KINDLESS_GRANT)
      // Resending an unused-for rule moves its clock, so it renews.
      const again = await edit(OWNER.secret, thingId, { ending: { any: [{ at: date }, { idle_seconds: 600 }] } })
      assert.equal(again.status, 200, JSON.stringify(again.json))

      const cleared = await edit(OWNER.secret, thingId, { ending: null })
      assert.equal(cleared.status, 200, JSON.stringify(cleared.json))
      const third = await endColumns(thingId)
      for (const column of ['ending_rule', 'ending_grant', 'ending_set_by', 'ending_set_at', 'ending_deadline',
        'ending_idle_seconds', 'ending_idle_anchor', 'ending_uses_left', 'ending_label']) {
        assert.equal(third[column], null, column)
      }
      const clearedAgain = await edit(OWNER.secret, thingId, { ending: null })
      assert.equal(clearedAgain.status, 200, JSON.stringify(clearedAgain.json))
      const changes = await endChanges(thingId)
      assert.deepEqual(changes.map(change => [change.change, change.actor_id]), [
        ['set', OWNER.id], ['renew', OWNER.id], ['renew', OWNER.id], ['clear', OWNER.id],
      ])
      assert.deepEqual(changes[3]!.rule, { any: [{ at: date }, { idle_seconds: 600 }] }, 'a clear records the rule it ended')
      assert.equal(await editedEvents(thingId), 4)

      const both = await edit(OWNER.secret, thingId, { name: 'a renamed lamp', ending: { any: [{ uses: 2 }] } })
      assert.equal(both.status, 200, JSON.stringify(both.json))
      assert.equal((await endColumns(thingId)).name, 'a renamed lamp')
      assert.equal((await endColumns(thingId)).ending_uses_left, 2)
      assert.equal(await editedEvents(thingId), 5, 'one request, one edit event')

      const stranger = await edit(VISITOR.secret, thingId, { ending: null })
      assert.equal(stranger.status, 403, JSON.stringify(stranger.json))
      const malformed = await edit(OWNER.secret, thingId, { ending: { any: [{ uses: 2 }, { uses: 3 }] } })
      assert.equal(malformed.status, 400, JSON.stringify(malformed.json))
      assert.equal(malformed.json.error, ENDING_SHAPE_REFUSAL)
      assert.equal((await endColumns(thingId)).ending_uses_left, 2)
      const unknownField = await edit(OWNER.secret, thingId, { endings: null })
      assert.equal(unknownField.status, 400)
      assert.match(String(unknownField.json.error), /wake_enabled, state_clear, and ending are editable/u)
    })

    await t.test('a renewal fits its grant after an upgrade or a conversion; a new setting takes the current revision', async () => {
      await reset()
      const lamps = await seedPolicyKind('grant-lamps', [{ allowed: ['at', 'uses'], max_seconds: 172_800 }, { allowed: ['uses'] }])
      const thingId = await seedThing(room, { kindId: lamps })
      const set = await edit(OWNER.secret, thingId, { ending: { any: [{ at: inDays(1) }] } })
      assert.equal(set.status, 200, JSON.stringify(set.json))
      const grant = (await endColumns(thingId)).ending_grant as Json
      assert.equal(grant.revision, 1)

      const upgraded = await upgrade(OWNER.secret, thingId)
      assert.equal(upgraded.status, 200, JSON.stringify(upgraded.json))
      assert.equal((await endColumns(thingId)).current_revision, 2)
      assert.deepEqual((await endColumns(thingId)).ending_grant, grant, 'an active end keeps its grant across the upgrade')
      const renewed = await edit(OWNER.secret, thingId, { ending: { any: [{ at: inDays(1.5) }] } })
      assert.equal(renewed.status, 200, JSON.stringify(renewed.json))
      assert.deepEqual((await endColumns(thingId)).ending_grant, grant)
      const tooFar = await edit(OWNER.secret, thingId, { ending: { any: [{ at: inDays(3) }] } })
      assert.equal(tooFar.status, 400, JSON.stringify(tooFar.json))
      assert.equal(tooFar.json.error, ENDING_SHAPE_REFUSAL)

      assert.equal((await edit(OWNER.secret, thingId, { ending: null })).status, 200)
      const refused = await edit(OWNER.secret, thingId, { ending: { any: [{ at: inDays(1) }] } })
      assert.equal(refused.status, 403, JSON.stringify(refused.json))
      assert.equal(refused.json.error, ENDING_NOT_ALLOWED_REFUSAL)
      const fresh = await edit(OWNER.secret, thingId, { ending: { any: [{ uses: 3 }] } })
      assert.equal(fresh.status, 200, JSON.stringify(fresh.json))
      assert.equal(((await endColumns(thingId)).ending_grant as Json).revision, 2, 'a new setting takes a new grant')

      // A conversion keeps the stored grant for renewals; clearing then reads the new kind.
      const stones = await seedPolicyKind('plain-stones', [{ allowed: [] }])
      const converted = await seedThing(room, { kindId: lamps })
      assert.equal((await edit(OWNER.secret, converted, { ending: { any: [{ at: inDays(1) }] } })).status, 200)
      await db.query('UPDATE things SET as_kind_id = $2, as_revision = 1 WHERE id = $1', [converted, stones])
      const renewedConverted = await edit(OWNER.secret, converted, { ending: { any: [{ at: inDays(1.2) }] } })
      assert.equal(renewedConverted.status, 200, JSON.stringify(renewedConverted.json))
      assert.equal(((await endColumns(converted)).ending_grant as Json).kind_id, lamps)
      assert.equal((await edit(OWNER.secret, converted, { ending: null })).status, 200)
      const convertedRefused = await edit(OWNER.secret, converted, { ending: { any: [{ uses: 1 }] } })
      assert.equal(convertedRefused.status, 403, JSON.stringify(convertedRefused.json))
      assert.equal(convertedRefused.json.error, ENDING_NOT_ALLOWED_REFUSAL)
    })

    await t.test('upgrade sets an end in the same request, all or nothing; a newer revision changes no existing thing', async () => {
      await reset()
      const lamps = await seedPolicyKind('later-lamps', [{ allowed: [] }, { allowed: ['at'] }])
      const thingId = await seedThing(room, { kindId: lamps })
      const tooEarly = await edit(OWNER.secret, thingId, { ending: { any: [{ at: inDays(2) }] } })
      assert.equal(tooEarly.status, 403, JSON.stringify(tooEarly.json))
      assert.equal(tooEarly.json.error, ENDING_NOT_ALLOWED_REFUSAL)
      const date = inDays(2)
      const upgraded = await upgrade(OWNER.secret, thingId, { ending: { any: [{ at: date }] } })
      assert.equal(upgraded.status, 200, JSON.stringify(upgraded.json))
      const row = await endColumns(thingId)
      assert.equal(row.current_revision, 2)
      assert.deepEqual(row.ending_rule, { any: [{ at: date }] })
      assert.equal((row.ending_grant as Json).revision, 2)
      assert.deepEqual((await endChanges(thingId)).map(change => change.change), ['set'])

      const never = await seedPolicyKind('never-lamps', [{ allowed: [] }, { allowed: [] }])
      const stuck = await seedThing(room, { kindId: never })
      const refused = await upgrade(OWNER.secret, stuck, { ending: { any: [{ at: date }] } })
      assert.equal(refused.status, 403, JSON.stringify(refused.json))
      assert.equal(refused.json.error, ENDING_NOT_ALLOWED_REFUSAL)
      assert.equal((await endColumns(stuck)).current_revision, 1, 'the upgrade rolled back with the refused end')
      const malformed = await upgrade(OWNER.secret, stuck, { ending: { any: [] } })
      assert.equal(malformed.status, 400, JSON.stringify(malformed.json))
      const unknownField = await upgrade(OWNER.secret, stuck, { endings: null })
      assert.equal(unknownField.status, 400)
      assert.match(String(unknownField.json.error), /send only optional drawing_variant_name and optional ending$/u)

      // A converted thing upgrades to its new kind's newest revision and may take an end then.
      const stone = await seedPolicyKind('ending-stones', [{ allowed: [] }, { allowed: ['uses'] }])
      const convertedId = await seedThing(room, { kindId: never })
      await db.query('UPDATE things SET as_kind_id = $2, as_revision = 1 WHERE id = $1', [convertedId, stone])
      const convertedUpgrade = await upgrade(OWNER.secret, convertedId, { ending: { any: [{ uses: 2 }] } })
      assert.equal(convertedUpgrade.status, 200, JSON.stringify(convertedUpgrade.json))
      const convertedRow = await one<Json>('SELECT as_revision, ending_uses_left, ending_grant FROM things WHERE id = $1', [convertedId])
      assert.equal(convertedRow.as_revision, 2)
      assert.equal(convertedRow.ending_uses_left, 2)
      assert.equal((convertedRow.ending_grant as Json).kind_id, stone)

      const quiet = await seedPolicyKind('quiet-lamps', [{ allowed: [] }])
      const untouched = await seedThing(room, { kindId: quiet })
      await db.query(`INSERT INTO kind_revisions (kind_id, revision, ending_policy) VALUES ($1, 2, '{"allowed": ["at", "uses"]}'::jsonb)`, [quiet])
      await db.query('UPDATE kinds SET current_revision = 2 WHERE id = $1', [quiet])
      const after = await endColumns(untouched)
      assert.equal(after.ending_rule, null, 'a revision that allows endings gives no existing thing a clock')
      assert.equal(after.current_revision, 1)
      assert.equal((await endChanges(untouched)).length, 0)
    })

    await t.test('E14 after a kindless thing was given, and E4 on a marked thing on thing_edit and upgrade', async () => {
      await reset()
      const given = await seedThing(room)
      const transferred = await call(app, OWNER.secret, 'POST', '/api/transfer', { type: 'thing', id: given, to_handle: VISITOR.handle })
      assert.equal(transferred.status, 200, JSON.stringify(transferred.json))
      const refused = await edit(VISITOR.secret, given, { ending: { any: [{ uses: 2 }] } })
      assert.equal(refused.status, 403, JSON.stringify(refused.json))
      assert.equal(refused.json.error, KINDLESS_ENDING_REFUSAL)
      assert.equal((await endColumns(given)).ending_rule, null)

      const marked = await seedThing(room)
      const mark = await call(app, OWNER.secret, 'POST', `/api/thing/${marked}/mark`, { action: 'mark' })
      assert.equal(mark.status, 200, JSON.stringify(mark.json))
      const markedEdit = await edit(OWNER.secret, marked, { ending: { any: [{ uses: 2 }] } })
      assert.equal(markedEdit.status, 409, JSON.stringify(markedEdit.json))
      assert.equal(markedEdit.json.error, ENDING_MARKED_REFUSAL)
      const lamps = await seedPolicyKind('marked-lamps', [{ allowed: [] }, { allowed: ['uses'] }])
      const markedKind = await seedThing(room, { kindId: lamps })
      assert.equal((await call(app, OWNER.secret, 'POST', `/api/thing/${markedKind}/mark`, { action: 'mark' })).status, 200)
      const markedUpgrade = await upgrade(OWNER.secret, markedKind, { ending: { any: [{ uses: 2 }] } })
      assert.equal(markedUpgrade.status, 409, JSON.stringify(markedUpgrade.json))
      assert.equal(markedUpgrade.json.error, ENDING_MARKED_REFUSAL)
      assert.equal((await endColumns(markedKind)).current_revision, 1)
      // Clearing a marked thing's (absent) end is a no-op, and unmarking lets the end be set.
      assert.equal((await edit(OWNER.secret, marked, { ending: null })).status, 200)
      assert.equal((await call(app, OWNER.secret, 'POST', `/api/thing/${marked}/mark`, { action: 'unmark' })).status, 200)
      const unmarked = await edit(OWNER.secret, marked, { ending: { any: [{ uses: 2 }] } })
      assert.equal(unmarked.status, 200, JSON.stringify(unmarked.json))
      assert.equal((await endColumns(marked)).ending_uses_left, 2)
    })

    await t.test('a copy may only clear its end: an older copy cannot gain one, and a cleared copy keeps its origin', async () => {
      await reset()
      const parent = await seedThing(room)
      const copyOf = async () => Number((await one<{ id: number }>(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id, parent_thing_id, family_id, generation)
        VALUES ($1, 'a copied lamp', '', $2, $2, $3, $3, 1) RETURNING id
      `, [room, OWNER.id, parent])).id)
      const older = await copyOf()
      const gain = await edit(OWNER.secret, older, { ending: { any: [{ uses: 2 }] } })
      assert.equal(gain.status, 409, JSON.stringify(gain.json))
      assert.equal(gain.json.error, ENDING_COPY_FIXED_REFUSAL)
      assert.equal((await edit(OWNER.secret, older, { ending: null })).status, 200)
      assert.equal((await endChanges(older)).length, 0)

      const ended = await copyOf()
      await setEnd(ended, { at: '2 days', copiedFrom: parent })
      const later = await edit(OWNER.secret, ended, { ending: { any: [{ at: inDays(1) }] } })
      assert.equal(later.status, 409, JSON.stringify(later.json))
      // The same refusal a second time adds the city's "same refusal again" line.
      assert.ok(String(later.json.error).startsWith(ENDING_COPY_FIXED_REFUSAL))
      const cleared = await edit(OWNER.secret, ended, { ending: null })
      assert.equal(cleared.status, 200, JSON.stringify(cleared.json))
      const row = await endColumns(ended)
      assert.equal(row.ending_rule, null)
      assert.equal(row.ending_copied_from, parent, 'the copy origin stays after a clear')
      assert.notEqual(row.ending_copied_at, null)
      const setAgain = await edit(OWNER.secret, ended, { ending: { any: [{ uses: 2 }] } })
      assert.equal(setAgain.status, 409, JSON.stringify(setAgain.json))
      assert.ok(String(setAgain.json.error).startsWith(ENDING_COPY_FIXED_REFUSAL))
    })

    await t.test('a due thing: thing_edit records it and refuses E5 for its end and E7 otherwise; upgrade refuses E7', async () => {
      await reset()
      const thingId = await seedThing(room)
      await setEnd(thingId, { at: '-1 minute' })
      const clear = await edit(OWNER.secret, thingId, { ending: null })
      assert.equal(clear.status, 409, JSON.stringify(clear.json))
      assert.equal(clear.json.error, ENDING_REMNANT_CHANGE_REFUSAL)
      assert.notEqual((await endColumns(thingId)).ended_at, null, 'recorded first')
      assert.equal((await endedEvents(thingId)).length, 1)
      const renamed = await edit(OWNER.secret, thingId, { name: 'a renamed remnant' })
      assert.equal(renamed.status, 409, JSON.stringify(renamed.json))
      assert.equal(renamed.json.error, THING_REMNANT_REFUSAL)
      const again = await edit(OWNER.secret, thingId, { ending: { any: [{ uses: 2 }] } })
      assert.equal(again.status, 409)
      assert.ok(String(again.json.error).startsWith(ENDING_REMNANT_CHANGE_REFUSAL))
      assert.equal((await endColumns(thingId)).name, 'an ending lamp')
      assert.equal((await endedEvents(thingId)).length, 1)

      const lamps = await seedPolicyKind('due-lamps', [{ allowed: ['at'] }, { allowed: ['at'] }])
      const kindThing = await seedThing(room, { kindId: lamps })
      await setEnd(kindThing, { at: '-1 minute' })
      const upgraded = await upgrade(OWNER.secret, kindThing)
      assert.equal(upgraded.status, 409, JSON.stringify(upgraded.json))
      assert.equal(upgraded.json.error, THING_REMNANT_REFUSAL)
      assert.equal((await endColumns(kindThing)).current_revision, 1)
      assert.notEqual((await endColumns(kindThing)).ended_at, null)
    })

    await t.test('a guard refusal on a door answers 409 with E16, never 500', async () => {
      await reset()
      const thingId = await seedThing(room)
      await setEnd(thingId, { at: '-1 minute' })
      // thing_edit records a due thing first and refuses E7 (T8), so the guard is forced here
      // on an active thing to prove that the door still maps it to E16.
      const active = await seedThing(room)
      await db.query(`
        CREATE FUNCTION test_force_thing_ending_guard() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.name = 'a forced name' THEN
            RAISE EXCEPTION 'forced' USING ERRCODE = '23514', CONSTRAINT = 'thing_ending_guard';
          END IF;
          RETURN NEW;
        END
        $$
      `)
      await db.query('CREATE TRIGGER test_force_thing_ending_guard BEFORE UPDATE ON things FOR EACH ROW EXECUTE FUNCTION test_force_thing_ending_guard()')
      // The mark route refuses a remnant itself (T9), so its guard mapping is forced the same way.
      await db.query(`
        CREATE FUNCTION test_force_mark_ending_guard() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'forced' USING ERRCODE = '23514', CONSTRAINT = 'thing_ending_guard';
        END
        $$
      `)
      await db.query('CREATE TRIGGER test_force_mark_ending_guard BEFORE INSERT ON thing_later_holder_marks FOR EACH ROW EXECUTE FUNCTION test_force_mark_ending_guard()')
      try {
        const edited = await call(app, OWNER.secret, 'PATCH', `/api/thing/${active}`, { name: 'a forced name' })
        assert.equal(edited.status, 409, JSON.stringify(edited.json))
        assert.equal(edited.json.error, THING_ENDING_CHANGED_REFUSAL)
        const forcedMark = await call(app, OWNER.secret, 'POST', `/api/thing/${active}/mark`, { action: 'mark' })
        assert.equal(forcedMark.status, 409, JSON.stringify(forcedMark.json))
        assert.equal(forcedMark.json.error, THING_ENDING_CHANGED_REFUSAL)
      } finally {
        await db.query('DROP TRIGGER test_force_thing_ending_guard ON things')
        await db.query('DROP FUNCTION test_force_thing_ending_guard()')
        await db.query('DROP TRIGGER test_force_mark_ending_guard ON thing_later_holder_marks')
        await db.query('DROP FUNCTION test_force_mark_ending_guard()')
      }
      const remnantEdit = await call(app, OWNER.secret, 'PATCH', `/api/thing/${thingId}`, { name: 'a renamed lamp' })
      assert.equal(remnantEdit.status, 409, JSON.stringify(remnantEdit.json))
      assert.equal(remnantEdit.json.error, THING_REMNANT_REFUSAL)
      const marked = await call(app, OWNER.secret, 'POST', `/api/thing/${thingId}/mark`, { action: 'mark' })
      assert.equal(marked.status, 409, JSON.stringify(marked.json))
      assert.equal(marked.json.error, THING_REMNANT_REFUSAL)
      assert.equal((await one<Json>('SELECT name FROM things WHERE id = $1', [thingId])).name, 'an ending lamp')
    })
  } finally {
    await postgres.stop()
  }
})
