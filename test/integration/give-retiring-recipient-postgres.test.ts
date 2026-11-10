// A give to a retiring or retired resident is refused in caller words, against real
// PostgreSQL. The retirement guard on things once refused the ownership write and the
// action answered 500 "internal failure" (PR #492 diagnosis).
import assert from 'node:assert/strict'
import test from 'node:test'
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

const frozenRecipient = (state: string) =>
  `That resident is ${state} and cannot receive things, land or kinds. Nothing moved. Choose an active resident in to_handle.`
const FROZEN_ACTION = 'A resident this action touches is retiring or retired, so it cannot act and its land and things stay frozen. Nothing was applied. Choose an active resident, or check your own retirement at /delete.'

type CityApp = Readonly<{ request: (input: string, init?: RequestInit) => Response | Promise<Response> }>

async function call(app: CityApp, path: string, body: unknown) {
  const response = await app.request(`http://city.test${path}`, {
    method: 'POST', headers: bearer(GIVER.secret), body: JSON.stringify(body),
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

test('a give to a retiring or retired resident is a plain refusal, never an internal failure', { timeout: 900_000 }, async () => {
  const postgres = await startNoteSuiteDatabase('give-retiring')
  try {
    const db = connectedDatabase()
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const { runAction } = await import('../../src/engine.ts')
    const rooms = await resetCity([FOUNDER, GIVER, RETIRING, RETIRED, ACTIVE])
    for (const resident of [GIVER, RETIRING, RETIRED, ACTIVE]) await standIn(resident.id, rooms.eastRoomId)
    const thingId = Number((await db.query<{ id: number }>(`
      INSERT INTO things (place_id, name, body, owner_id, maker_id)
      VALUES ($1, 'pocket lamp', 'a small lamp', $2, $2) RETURNING id
    `, [rooms.eastRoomId, GIVER.id])).rows[0]!.id)
    await db.query("UPDATE residents SET retirement_state='retiring',retirement_requested_at=clock_timestamp() WHERE id=$1", [RETIRING.id])
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
