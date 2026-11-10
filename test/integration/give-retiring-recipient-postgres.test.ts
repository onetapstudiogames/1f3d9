// A give to a retiring or retired resident is refused in caller words, against real
// PostgreSQL. The retirement guard on things once refused the ownership write and the
// action answered 500 "internal failure" (PR #492 diagnosis). The refusal also writes
// no due end first, is never held as a waiting gift, and a held gift whose giver is now
// frozen ends when its recipient tries to accept it.
import assert from 'node:assert/strict'
import test from 'node:test'
import { coin, seedKind, seedThing, traitId } from '../helpers/abilities-fixtures.ts'
import {
  bearer,
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const FOUNDER = Object.freeze({ id: 1, handle: 'founder', secret: `1f3d9_sk_${'1'.repeat(48)}` })
const GIVER = Object.freeze({ id: 2, handle: 'kind-giver', secret: `1f3d9_sk_${'2'.repeat(48)}` })
const RETIRING = Object.freeze({ id: 3, handle: 'slow-goodbye', secret: `1f3d9_sk_${'3'.repeat(48)}` })
const RETIRED = Object.freeze({ id: 6, handle: 'long-gone', secret: `1f3d9_sk_${'6'.repeat(48)}` })
const ACTIVE = Object.freeze({ id: 5, handle: 'glad-getter', secret: `1f3d9_sk_${'5'.repeat(48)}` })
// Not a founder, so a mute holds its gifts.
const PLAIN_GIVER = Object.freeze({ id: 7, handle: 'plain-giver', secret: `1f3d9_sk_${'7'.repeat(48)}` })
// Muted the plain giver, then began retiring.
const MUTED_FROZEN = Object.freeze({ id: 8, handle: 'quiet-goodbye', secret: `1f3d9_sk_${'8'.repeat(48)}` })
// Muted the plain giver and stays active.
const ACCEPTOR = Object.freeze({ id: 9, handle: 'late-taker', secret: `1f3d9_sk_${'9'.repeat(48)}` })

const KINDLESS_GRANT = Object.freeze({
  kindless: true,
  allowed: ['at', 'after_setting_seconds', 'uses', 'idle_seconds', 'label_added'],
  limits: { max_seconds: 31_622_400, max_uses: 10_000, labels: null },
  city_limits_version: 1,
})

const frozenRecipient = (state: string) =>
  `That resident is ${state} and cannot receive things, land or kinds. Nothing moved. Choose an active resident in to_handle.`
const FROZEN_ACTION = 'A resident this action touches is retiring or retired, so it cannot act and its land and things stay frozen. Nothing was applied. Choose an active resident, or check your own retirement at /delete.'
const frozenGiver = (state: string) =>
  `This gift can no longer be accepted because its giver is ${state}. It stays with the giver.`

type CityApp = Readonly<{ request: (input: string, init?: RequestInit) => Response | Promise<Response> }>

async function call(app: CityApp, path: string, body: unknown, secret: string = GIVER.secret) {
  const response = await app.request(`http://city.test${path}`, {
    method: 'POST', headers: bearer(secret), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return Object.freeze({ status: response.status, json: await response.json() as Record<string, unknown> })
}

async function counts(thingId: number) {
  return (await connectedDatabase().query(`SELECT
    (SELECT owner_id FROM things WHERE id = $1) AS owner,
    (SELECT count(*)::int FROM transfers) AS transfers,
    (SELECT count(*)::int FROM action_runs) AS action_runs,
    (SELECT count(*)::int FROM events) AS events`, [thingId])).rows[0]
}

async function number(text: string, values: readonly unknown[] = []): Promise<number> {
  return Number(Object.values((await connectedDatabase().query(text, [...values])).rows[0] ?? {})[0])
}

const waitingRows = (thingId: number) =>
  number(`SELECT count(*) FROM waiting_transfers WHERE asset_type = 'thing' AND asset_id = $1`, [thingId])

test('a give to a retiring or retired resident is a plain refusal, never an internal failure', { timeout: 900_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('give-retiring')
  try {
    const db = connectedDatabase()
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const { runAction } = await import('../../src/engine.ts')
    const { holdTransferIfWaiting } = await import('../../src/engine-effects.ts')
    const { waitingAcceptFailed } = await import('../../src/waiting-transfers.ts')
    const rooms = await resetCity([FOUNDER, GIVER, RETIRING, RETIRED, ACTIVE, PLAIN_GIVER, MUTED_FROZEN, ACCEPTOR])
    for (const resident of [GIVER, RETIRING, RETIRED, ACTIVE, PLAIN_GIVER, MUTED_FROZEN, ACCEPTOR]) {
      await standIn(resident.id, rooms.eastRoomId)
    }
    const thingOf = async (ownerId: number, name: string) => Number((await db.query<{ id: number }>(`
      INSERT INTO things (place_id, name, body, owner_id, maker_id)
      VALUES ($1, $2, 'a small lamp', $3, $3) RETURNING id
    `, [rooms.eastRoomId, name, ownerId])).rows[0]!.id)
    const thingId = await thingOf(GIVER.id, 'pocket lamp')
    // Both mutes are written while their residents are active; the retirement guard covers mutes.
    for (const muter of [MUTED_FROZEN, ACCEPTOR]) {
      await db.query(`INSERT INTO resident_mutes (resident_id, target_type, target_id, choice) VALUES ($1, 'resident', $2, 'mute')`,
        [muter.id, PLAIN_GIVER.id])
    }
    const retire = (id: number) => db.query("UPDATE residents SET retirement_state='retiring',retirement_requested_at=clock_timestamp() WHERE id=$1", [id])
    await retire(RETIRING.id)
    await retire(MUTED_FROZEN.id)
    await db.query("UPDATE residents SET retirement_state='retiring',retirement_requested_at=clock_timestamp()-interval '31 days' WHERE id=$1", [RETIRED.id])
    await db.query('SELECT complete_resident_retirement(1, $1)', [RETIRED.id])

    // Both give doors refuse before anything is written.
    const before = await counts(thingId)
    for (const [recipient, state] of [[RETIRING, 'retiring'], [RETIRED, 'retired']] as const) {
      const act = await call(app, '/api/action', { action: 'give', thing_id: thingId, to_handle: recipient.handle })
      assert.equal(act.status, 409, JSON.stringify(act.json))
      assert.equal(act.json.error, frozenRecipient(state))
      const transfer = await call(app, '/api/transfer', { type: 'thing', id: thingId, to_handle: recipient.handle })
      assert.equal(transfer.status, 409, JSON.stringify(transfer.json))
      assert.equal(transfer.json.error, frozenRecipient(state))
    }
    assert.deepEqual(await counts(thingId), before)

    await t.test('a due but unrecorded end is not recorded by the refusal', async () => {
      // A thing whose end is due but not yet recorded: the refusal still writes nothing, no
      // recorded end, no ending change and no thing_ended event, at either door.
      const dueLamp = await thingOf(GIVER.id, 'due lamp')
      const dueAt = String((await db.query<{ at: string }>(
        `SELECT to_char((now() - interval '1 minute') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`,
      )).rows[0]!.at)
      await db.query(`
        UPDATE things SET ending_rule = $2::jsonb, ending_grant = $3::jsonb, ending_set_by = owner_id,
          ending_set_at = now() - interval '1 hour', ending_deadline = $4::timestamptz
        WHERE id = $1
      `, [dueLamp, JSON.stringify({ any: [{ at: dueAt }] }), JSON.stringify(KINDLESS_GRANT), dueAt])
      const dueBefore = await counts(dueLamp)
      for (const [path, body] of [
        ['/api/action', { action: 'give', thing_id: dueLamp, to_handle: RETIRING.handle }],
        ['/api/transfer', { type: 'thing', id: dueLamp, to_handle: RETIRING.handle }],
      ] as const) {
        const refused = await call(app, path, body)
        assert.equal(refused.status, 409, `${path} ${JSON.stringify(refused.json)}`)
        assert.equal(refused.json.error, frozenRecipient('retiring'))
        assert.equal(await number('SELECT count(*) FROM things WHERE id = $1 AND ended_at IS NOT NULL', [dueLamp]), 0, path)
        assert.equal(await number('SELECT count(*) FROM thing_ending_changes WHERE thing_id = $1', [dueLamp]), 0, path)
        assert.equal(await number(`SELECT count(*) FROM events WHERE kind = 'thing_ended'`), 0, path)
      }
      assert.deepEqual(await counts(dueLamp), dueBefore)
    })

    await t.test('a frozen recipient that muted the giver is never held', async () => {
      // A frozen recipient that muted the giver: never held as a waiting gift. The door refuses
      // first, and the shared hold refuses too, as when the retirement commits after the door's read.
      const mutedLamp = await thingOf(PLAIN_GIVER.id, 'muted lamp')
      const door = await call(app, '/api/transfer', { type: 'thing', id: mutedLamp, to_handle: MUTED_FROZEN.handle }, PLAIN_GIVER.secret)
      assert.equal(door.status, 409, JSON.stringify(door.json))
      assert.equal(door.json.error, frozenRecipient('retiring'))
      await assert.rejects(
        holdTransferIfWaiting({ type: 'thing', id: mutedLamp }, PLAIN_GIVER.id, MUTED_FROZEN.id),
        (error: unknown) => {
          assert.equal((error as { status?: unknown }).status, 409)
          assert.equal((error as Error).message, frozenRecipient('retiring'))
          return true
        },
      )
      assert.equal(await waitingRows(mutedLamp), 0)
    })

    await t.test('a use recipe transfer step to a frozen recipient that muted the giver is refused, not held', async () => {
      // The recipe's step reaches the shared hold with no door read before it.
      const coined = await coin(app, PLAIN_GIVER.secret, 'hand-over', { use: [{ effect: 'transfer', target: 'source', to: 'recipient' }] })
      assert.equal(coined.status, 201, JSON.stringify(coined.json))
      const parcel = await seedThing(PLAIN_GIVER.id, rooms.eastRoomId,
        await seedKind(PLAIN_GIVER.id, 'parcels', [await traitId('hand-over')]), 'a parcel')
      const used = await call(app, '/api/action', { action: 'use', thing_id: parcel, to_handle: MUTED_FROZEN.handle }, PLAIN_GIVER.secret)
      assert.equal(used.status, 409, JSON.stringify(used.json))
      assert.equal(used.json.error, frozenRecipient('retiring'))
      assert.equal(await waitingRows(parcel), 0)
      assert.equal((await counts(parcel)).owner, PLAIN_GIVER.id)
    })

    await t.test('accepting a held gift from a now frozen giver ends it', async () => {
      // A held gift whose giver is now retiring: the recipient's accept is a plain refusal
      // aimed at it, and the waiting row ends as failed, like any other failed recheck.
      const heldLamp = await thingOf(PLAIN_GIVER.id, 'held lamp')
      const held = await call(app, '/api/transfer', { type: 'thing', id: heldLamp, to_handle: ACCEPTOR.handle }, PLAIN_GIVER.secret)
      assert.equal(held.status, 200, JSON.stringify(held.json))
      const waitingId = await number(`SELECT id FROM waiting_transfers WHERE asset_type = 'thing' AND asset_id = $1 AND answer IS NULL`, [heldLamp])
      await retire(PLAIN_GIVER.id)
      const accepted = await call(app, `/api/transfer/waiting/${waitingId}/accept`, undefined, ACCEPTOR.secret)
      assert.equal(accepted.status, 409, JSON.stringify(accepted.json))
      assert.equal(accepted.json.error, waitingAcceptFailed(waitingId, frozenGiver('retiring')))
      assert.deepEqual((await db.query('SELECT answer, answer_detail FROM waiting_transfers WHERE id = $1', [waitingId])).rows[0], {
        answer: 'failed', answer_detail: frozenGiver('retiring'),
      })
      assert.equal((await counts(heldLamp)).owner, PLAIN_GIVER.id)
    })

    // A late database refusal (the retirement committed after the door's read) is plain too,
    // in the answer and in the recorded failed action.
    const sql = Object.assign(async (parts: TemplateStringsArray, ...values: unknown[]) => (await db.query(
      parts.reduce((text, part, index) => text + part + (index < values.length ? `$${index + 1}` : ''), ''), values,
    )).rows, { query: async (text: string, values: readonly unknown[] = []) => (await db.query(text, [...values])).rows })
    const late = await runAction({ actorId: GIVER.id, actorHandle: GIVER.handle, action: 'give',
      sourceThingId: thingId, recipientId: RETIRING.id, placeId: rooms.eastRoomId }, sql)
    assert.equal(late.httpStatus, 409, JSON.stringify(late))
    assert.equal(late.error, FROZEN_ACTION)
    const recorded = (await db.query('SELECT detail FROM action_resolutions WHERE action_run_id = $1', [late.actionId])).rows[0]
    assert.deepEqual(recorded?.detail, { error: FROZEN_ACTION })
    assert.equal((await counts(thingId)).owner, GIVER.id)

    // An active recipient still receives the thing.
    const given = await call(app, '/api/action', { action: 'give', thing_id: thingId, to_handle: ACTIVE.handle })
    assert.equal(given.status, 200, JSON.stringify(given.json))
    assert.equal((await counts(thingId)).owner, ACTIVE.id)
  } finally {
    await postgres.stop()
  }
})
