// Thing endings, the guards, against real PostgreSQL 17 on the full db/schema.sql: a thing
// whose end has come keeps what it had, changes hands only as its owner may, takes no new
// label, mark or offer, and only the three named writers pass more, each for its own thing
// and only inside its own transaction. The real sale completion and terminalization
// statements run through the guards unchanged.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import {
  closeSalePaymentTarget,
  completeDirectSalePayment,
  completeWorldSalePayment,
  invalidateSalePaymentTarget,
} from '../../src/payment-sale-operations.ts'
import { saleDatabase, seedRecoverableSale } from '../helpers/payment-postgres-fixtures/sales.ts'
import { waitPastDatabaseTime } from '../helpers/database-clock.ts'
import {
  connectedDatabase,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const SELLER = 1
const BUYER = 2
const WALLET = `0x${'ab'.repeat(20)}`

type EndState = 'active' | 'due' | 'recorded'

async function resetCity(db: Pool): Promise<number> {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await db.query(schemaDdl)
  await db.query(`
    INSERT INTO residents (id, handle, model, secret_hash) VALUES
      (1, 'seller', 'thing-endings', repeat('1', 64)),
      (2, 'buyer', 'thing-endings', repeat('2', 64)),
      (3, 'other', 'thing-endings', repeat('3', 64))
  `)
  await db.query('UPDATE resident_id_allocator SET last_id = 3 WHERE singleton')
  return roomIn(db, 'Ending Room')
}

async function roomIn(db: Pool, name: string): Promise<number> {
  const continentId = Number((await db.query(`
    INSERT INTO places (parent_id, place_kind, name, owner_id)
    SELECT id, 'continent', $1 || ' land', 1 FROM places WHERE place_kind = 'world' RETURNING id
  `, [name])).rows[0]!.id)
  return Number((await db.query(`
    INSERT INTO places (parent_id, place_kind, name, owner_id) VALUES ($1, 'place', $2, 1) RETURNING id
  `, [continentId, name])).rows[0]!.id)
}

async function newThing(db: Pool, roomId: number, ownerId = SELLER): Promise<number> {
  return Number((await db.query(`
    INSERT INTO things (place_id, name, body, owner_id) VALUES ($1, 'ending thing', 'a body', $2) RETURNING id
  `, [roomId, ownerId])).rows[0]!.id)
}

/** Gives a thing with no end an end that is far off or already due, with its switches on. */
async function setEnd(db: Pool, thingId: number, due: boolean): Promise<void> {
  await db.query(`
    UPDATE things SET ending_rule = '{"any": [{"at": "2099-01-01T00:00:00Z"}]}',
      ending_grant = '{"kindless": true, "allowed": ["at"], "limits": {}, "city_limits_version": 1}',
      ending_set_by = owner_id, ending_set_at = now() - interval '1 hour',
      ending_deadline = CASE WHEN $2::boolean THEN now() - interval '1 minute' ELSE '2099-01-01T00:00:00Z' END,
      wake_enabled = TRUE, open_to_reach = TRUE, open_to_convert = TRUE
    WHERE id = $1
  `, [thingId, due])
}

async function inTransaction<T>(db: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/** Runs one statement after setting the writer, inside one transaction. */
async function asWriter(db: Pool, writer: string, text: string, values: readonly unknown[] = []): Promise<void> {
  await inTransaction(db, async client => {
    await client.query(`SELECT set_config('city.ending_writer', $1, true)`, [writer])
    await client.query(text, [...values])
  })
}

async function record(db: Pool, thingId: number, programState: 'none' | 'pending' = 'none'): Promise<void> {
  await asWriter(db, `record:${thingId}`, `
    UPDATE things SET ended_at = thing_end_due_at(id), ended_cause = 'at', ended_owner_id = owner_id,
      end_program_state = $2
    WHERE id = $1
  `, [thingId, programState])
}

async function thingIn(db: Pool, roomId: number, state: EndState, programState: 'none' | 'pending' = 'none'): Promise<number> {
  const thingId = await newThing(db, roomId)
  await setEnd(db, thingId, state !== 'active')
  if (state === 'recorded') await record(db, thingId, programState)
  return thingId
}

function refusedByGuard(error: unknown): boolean {
  const failure = error as { code?: string; constraint?: string }
  assert.equal(failure.constraint, 'thing_ending_guard', String(error))
  assert.equal(failure.code, '23514')
  return true
}

async function row(db: Pool, thingId: number): Promise<Record<string, unknown>> {
  return (await db.query(`
    SELECT owner_id, active_offer_id, held_by, place_id, wake_enabled, open_to_reach, open_to_convert,
      state, copies_made, withdrawn_at IS NOT NULL AS withdrawn, ended_at IS NOT NULL AS ended,
      end_program_state, end_program_result
    FROM things WHERE id = $1
  `, [thingId])).rows[0]!
}

async function assertRow(db: Pool, thingId: number, expected: Record<string, unknown>): Promise<void> {
  const actual = await row(db, thingId)
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, actual[key]])), expected)
}

/** The gift and act give shape: src/society.ts and src/engine-effects.ts. */
const GIFT_SQL = `UPDATE things SET owner_id = $2 WHERE id = $1 AND owner_id = $3 AND active_offer_id IS NULL`

test('thing endings guards against real PostgreSQL 17', { timeout: 900_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('thing-endings-guards')
  try {
    const db = connectedDatabase()
    let roomId = await resetCity(db)

    await t.test('the guards are present, enabled and fire in the stated order', async () => {
      assert.deepEqual((await db.query(`
        SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'things'::regclass AND NOT tgisinternal AND tgtype & 3 = 3 AND tgtype & 16 = 16
        ORDER BY tgname::text COLLATE "C"
      `)).rows.map(trigger => trigger.tgname), [
        'gazette_submission_room_reject_things',
        'things_aa_ending_owner_change',
        'things_close_consent_on_owner_change',
        'things_keep_birth_history',
        'things_reject_retired_place',
        'things_reject_world_place',
        'things_sleep_on_owner_change',
        'things_validate_drawing_variant',
        'things_zz_ending_freeze',
      ], 'a later BEFORE UPDATE trigger on things must sort before things_zz_ending_freeze')
      assert.deepEqual((await db.query(`
        SELECT trigger_row.tgrelid::regclass::text AS table_name, trigger_row.tgname, trigger_row.tgenabled,
          trigger_row.tgtype, trigger_row.tgfoid::regproc::text AS function_name
        FROM pg_trigger AS trigger_row
        WHERE NOT trigger_row.tgisinternal AND trigger_row.tgname IN ('things_aa_ending_owner_change',
          'things_zz_ending_freeze', 'things_ending_parent_guard', 'active_labels_ending_guard',
          'thing_later_holder_marks_ending_guard', 'transfer_offers_ending_guard')
        ORDER BY trigger_row.tgname
      `)).rows, [
        { table_name: 'active_labels', tgname: 'active_labels_ending_guard', tgenabled: 'O', tgtype: 7, function_name: 'guard_thing_ending_label' },
        { table_name: 'thing_later_holder_marks', tgname: 'thing_later_holder_marks_ending_guard', tgenabled: 'O', tgtype: 7, function_name: 'guard_thing_ending_mark' },
        { table_name: 'things', tgname: 'things_aa_ending_owner_change', tgenabled: 'O', tgtype: 19, function_name: 'guard_thing_ending_owner_change' },
        { table_name: 'things', tgname: 'things_ending_parent_guard', tgenabled: 'O', tgtype: 7, function_name: 'guard_thing_ending_insert' },
        { table_name: 'things', tgname: 'things_zz_ending_freeze', tgenabled: 'O', tgtype: 19, function_name: 'guard_thing_ending_freeze' },
        { table_name: 'transfer_offers', tgname: 'transfer_offers_ending_guard', tgenabled: 'O', tgtype: 7, function_name: 'guard_thing_ending_offer' },
      ])
    })

    await t.test('a thing with no end, or an end not yet due, is not frozen', async () => {
      const plain = await newThing(db, roomId)
      await db.query(`UPDATE things SET name = 'renamed', state = '{"lit": true}', state_version = 1 WHERE id = $1`, [plain])
      await db.query(GIFT_SQL, [plain, BUYER, SELLER])
      await db.query('UPDATE things SET withdrawn_at = clock_timestamp() WHERE id = $1', [plain])

      const active = await thingIn(db, roomId, 'active')
      await db.query(`UPDATE things SET name = 'still mine', copies_made = 2, open_to_use = TRUE WHERE id = $1`, [active])
      await db.query('UPDATE things SET owner_id = owner_id WHERE id = $1', [active])
      await assert.rejects(db.query(GIFT_SQL, [active, BUYER, SELLER]), refusedByGuard)
      // A clear is an ordinary write while the end has not come.
      await db.query(`
        UPDATE things SET ending_rule = NULL, ending_grant = NULL, ending_set_by = NULL, ending_set_at = NULL,
          ending_deadline = NULL WHERE id = $1
      `, [active])
      await db.query(GIFT_SQL, [active, BUYER, SELLER])
    })

    await t.test('a due or recorded thing keeps every column its owner may not change', async () => {
      const otherRoom = await roomIn(db, 'Other Room')
      for (const state of ['due', 'recorded'] as const) {
        const thingId = await thingIn(db, roomId, state)
        for (const change of [
          `name = 'new name'`, `body = 'new body'`, `state = '{"lit": true}'`, 'state_version = state_version + 1',
          'copies_made = copies_made + 1', 'open_to_use = TRUE', 'shared_use_may_destroy = TRUE', 'generation = 1',
          `ending_deadline = '2099-01-01T00:00:00Z'`, `ending_label = 'lit'`,
          'ending_rule = NULL, ending_grant = NULL, ending_set_by = NULL, ending_set_at = NULL, ending_deadline = NULL',
          `ending_copied_at = now()`, 'withdrawn_at = clock_timestamp()', `end_program_result = '{"ran": true}'`,
          'wake_enabled = FALSE', 'open_to_reach = FALSE', `drawing_description = 'new look'`,
        ]) {
          await assert.rejects(db.query(`UPDATE things SET ${change} WHERE id = $1`, [thingId]), refusedByGuard, `${state}: ${change}`)
        }
        // Values are compared, never the SET list, so an unchanged full-row write passes.
        await db.query(`
          UPDATE things SET name = coalesce(NULL, name), body = coalesce(NULL, body), state = state,
            drawing = drawing, open_to_use = open_to_use, ending_rule = ending_rule, ending_deadline = ending_deadline,
            owner_id = owner_id, end_program_state = end_program_state
          WHERE id = $1
        `, [thingId])
        // Carrying and setting down stay with the owner.
        await db.query('UPDATE things SET held_by = owner_id WHERE id = $1', [thingId])
        await db.query('UPDATE things SET place_id = $2 WHERE id = $1', [thingId, otherRoom])
        await db.query('UPDATE things SET held_by = NULL, place_id = $2 WHERE id = $1', [thingId, roomId])
        assert.equal((await row(db, thingId)).place_id, roomId)
      }
    })

    await t.test('only the recorder writes an end, once, at the moment it fell due', async () => {
      const due = await thingIn(db, roomId, 'due')
      const recordSql = `UPDATE things SET ended_at = thing_end_due_at(id), ended_cause = 'at', ended_owner_id = owner_id WHERE id = $1`
      await assert.rejects(db.query(recordSql, [due]), refusedByGuard)
      await assert.rejects(asWriter(db, `record:${due + 1000}`, recordSql, [due]), refusedByGuard)
      await assert.rejects(asWriter(db, `end_try:${due}`, recordSql, [due]), refusedByGuard)
      await assert.rejects(asWriter(db, `record:${due}`,
        `UPDATE things SET ended_at = transaction_timestamp(), ended_cause = 'at', ended_owner_id = owner_id WHERE id = $1`,
        [due]), refusedByGuard, 'the end is recorded at the moment it fell due')
      await assert.rejects(asWriter(db, `record:${due}`,
        `UPDATE things SET ended_at = thing_end_due_at(id), ended_cause = 'at', ended_owner_id = owner_id, name = 'x' WHERE id = $1`,
        [due]), refusedByGuard, 'the recorder writes only the end')
      await assert.rejects(asWriter(db, `record:${due}`,
        `UPDATE things SET ended_at = thing_end_due_at(id), ended_cause = 'at', ended_owner_id = owner_id, end_program_state = 'ran' WHERE id = $1`,
        [due]), refusedByGuard, 'the recorder sets pending or leaves none')
      await record(db, due, 'pending')
      assert.equal((await row(db, due)).end_program_state, 'pending')
      await assert.rejects(asWriter(db, `record:${due}`,
        `UPDATE things SET ended_at = ended_at - interval '1 second' WHERE id = $1`, [due]), refusedByGuard, 'once')

      const active = await thingIn(db, roomId, 'active')
      await assert.rejects(asWriter(db, `record:${active}`, `UPDATE things SET ended_at = now(), ended_cause = 'at', ended_owner_id = owner_id WHERE id = $1`, [active]),
        refusedByGuard, 'an end not yet due is never recorded')
      await assert.rejects(asWriter(db, `record:${active}`, recordSql, [active]), refusedByGuard)
      const plain = await newThing(db, roomId)
      await assert.rejects(db.query(`
        UPDATE things SET ending_rule = '{"any": [{"uses": 1}]}', ending_grant = '{"kindless": true}', ending_set_by = 1,
          ending_set_at = now(), ended_at = now(), ended_cause = 'uses', ended_owner_id = 1 WHERE id = $1
      `, [plain]), refusedByGuard, 'an end is never set and recorded in one write')
      for (const columns of [
        `ended_at, ended_cause, ended_owner_id) VALUES ($1, 'born ended', 1, '{"any": [{"uses": 1}]}', '{"kindless": true}', 1, now(), now(), 'uses', 1)`,
        `end_program_state) VALUES ($1, 'born pending', 1, '{"any": [{"uses": 1}]}', '{"kindless": true}', 1, now(), 'pending')`,
      ]) {
        await assert.rejects(db.query(`
          INSERT INTO things (place_id, name, owner_id, ending_rule, ending_grant, ending_set_by, ending_set_at, ${columns}
        `, [roomId]), refusedByGuard)
      }
    })

    await t.test('the end try writer passes its own columns while the program is pending', async () => {
      const remnant = await thingIn(db, roomId, 'recorded', 'pending')
      const other = await thingIn(db, roomId, 'recorded', 'pending')
      await inTransaction(db, async client => {
        await client.query(`SELECT set_config('city.ending_writer', $1, true)`, [`end_try:${remnant}`])
        await client.query(`UPDATE things SET state = '{"last": "word"}', state_version = state_version + 1 WHERE id = $1`, [remnant])
        await client.query('UPDATE things SET copies_made = copies_made + 1 WHERE id = $1', [remnant])
        await client.query(`UPDATE things SET end_program_state = 'ran', end_program_result = '{"try_id": 7}' WHERE id = $1`, [remnant])
      })
      await assertRow(db, remnant, { state: { last: 'word' }, copies_made: 1, end_program_state: 'ran', end_program_result: { try_id: 7 } })
      // A gate-closed skip and the failure path write only the program columns.
      await asWriter(db, `end_try:${other}`,
        `UPDATE things SET end_program_state = 'skipped', end_program_result = '{"skipped": "waking is off for this thing"}' WHERE id = $1`, [other])
      // One try ever: once ran or skipped, the writer passes nothing more.
      await assert.rejects(asWriter(db, `end_try:${remnant}`, `UPDATE things SET state = '{}' WHERE id = $1`, [remnant]), refusedByGuard)
      await assert.rejects(asWriter(db, `end_try:${other}`, `UPDATE things SET end_program_state = 'ran' WHERE id = $1`, [other]), refusedByGuard)

      const pending = await thingIn(db, roomId, 'recorded', 'pending')
      await assert.rejects(asWriter(db, `end_try:${pending}`, `UPDATE things SET name = 'x' WHERE id = $1`, [pending]), refusedByGuard)
      await assert.rejects(asWriter(db, `end_try:${pending}`, `UPDATE things SET end_program_state = 'none' WHERE id = $1`, [pending]), refusedByGuard)
      await assert.rejects(asWriter(db, `end_try:${remnant}`, `UPDATE things SET state = '{"x": 1}' WHERE id = $1`, [pending]), refusedByGuard,
        'a writer for another thing passes nothing')
      await assert.rejects(asWriter(db, `withdraw:${pending}`, `UPDATE things SET state = '{"x": 1}' WHERE id = $1`, [pending]), refusedByGuard)

      // A copy of a remnant only inside its own pending end try.
      const copySql = `INSERT INTO things (place_id, name, owner_id, parent_thing_id, family_id, generation) VALUES ($1, 'copy', 1, $2, $2, 1)`
      await assert.rejects(db.query(copySql, [roomId, pending]), refusedByGuard)
      await assert.rejects(asWriter(db, `end_try:${remnant}`, copySql, [roomId, pending]), refusedByGuard)
      await asWriter(db, `end_try:${pending}`, copySql, [roomId, pending])
      await assert.rejects(asWriter(db, `end_try:${remnant}`, copySql, [roomId, remnant]), refusedByGuard, 'not after its try ran')
      const dueParent = await thingIn(db, roomId, 'due')
      await assert.rejects(asWriter(db, `end_try:${dueParent}`, copySql, [roomId, dueParent]), refusedByGuard, 'not before its end is recorded')
      const activeParent = await thingIn(db, roomId, 'active')
      await db.query(copySql, [roomId, activeParent])
    })

    await t.test('the withdraw writer withdraws only a recorded remnant', async () => {
      const withdrawSql = `
        UPDATE things SET withdrawn_at = clock_timestamp(), held_by = NULL, end_program_state = 'skipped',
          end_program_result = '{"skipped": "withdrawn"}' WHERE id = $1
      `
      const pending = await thingIn(db, roomId, 'recorded', 'pending')
      await db.query('UPDATE things SET held_by = owner_id WHERE id = $1', [pending])
      await assert.rejects(db.query(withdrawSql, [pending]), refusedByGuard)
      await assert.rejects(asWriter(db, `withdraw:${pending + 1000}`, withdrawSql, [pending]), refusedByGuard)
      await assert.rejects(asWriter(db, `withdraw:${pending}`, `UPDATE things SET withdrawn_at = clock_timestamp(), name = 'x' WHERE id = $1`, [pending]),
        refusedByGuard)
      await asWriter(db, `withdraw:${pending}`, withdrawSql, [pending])
      await assertRow(db, pending, { withdrawn: true, held_by: null, end_program_state: 'skipped' })

      const quiet = await thingIn(db, roomId, 'recorded')
      await asWriter(db, `withdraw:${quiet}`, 'UPDATE things SET withdrawn_at = clock_timestamp() WHERE id = $1', [quiet])

      // The result changes only in the write that moves a pending program to skipped; a
      // program that already ran or was skipped keeps its result, and so does a pending one
      // that is withdrawn without being skipped.
      const resultSql = `UPDATE things SET withdrawn_at = clock_timestamp(), end_program_result = '{"overwritten": true}' WHERE id = $1`
      const ran = await thingIn(db, roomId, 'recorded', 'pending')
      await asWriter(db, `end_try:${ran}`, `UPDATE things SET end_program_state = 'ran', end_program_result = '{"try_id": 7}' WHERE id = $1`, [ran])
      const skipped = await thingIn(db, roomId, 'recorded', 'pending')
      await asWriter(db, `end_try:${skipped}`,
        `UPDATE things SET end_program_state = 'skipped', end_program_result = '{"skipped": "waking is off for this thing"}' WHERE id = $1`, [skipped])
      const stillPending = await thingIn(db, roomId, 'recorded', 'pending')
      const none = await thingIn(db, roomId, 'recorded')
      for (const [thingId, name] of [[ran, 'ran'], [skipped, 'skipped'], [stillPending, 'pending'], [none, 'none']] as const) {
        await assert.rejects(asWriter(db, `withdraw:${thingId}`, resultSql, [thingId]), refusedByGuard, name)
      }
      await asWriter(db, `withdraw:${ran}`, 'UPDATE things SET withdrawn_at = clock_timestamp() WHERE id = $1', [ran])
      await assertRow(db, ran, { withdrawn: true, end_program_state: 'ran', end_program_result: { try_id: 7 } })
      await asWriter(db, `withdraw:${skipped}`, 'UPDATE things SET withdrawn_at = clock_timestamp() WHERE id = $1', [skipped])
      await assertRow(db, skipped, {
        withdrawn: true, end_program_state: 'skipped', end_program_result: { skipped: 'waking is off for this thing' },
      })
      await asWriter(db, `withdraw:${stillPending}`, withdrawSql, [stillPending])
      await assertRow(db, stillPending, { withdrawn: true, end_program_state: 'skipped', end_program_result: { skipped: 'withdrawn' } })

      // A due thing is recorded before it is withdrawn, so a missed recorder call fails loudly.
      const due = await thingIn(db, roomId, 'due')
      await assert.rejects(asWriter(db, `withdraw:${due}`, 'UPDATE things SET withdrawn_at = clock_timestamp() WHERE id = $1', [due]),
        refusedByGuard)
    })

    await t.test('an end set and not recorded keeps a thing with its owner except by closing an open sale', async () => {
      for (const state of ['active', 'due'] as const) {
        const thingId = await thingIn(db, roomId, state)
        await assert.rejects(db.query(GIFT_SQL, [thingId, BUYER, SELLER]), refusedByGuard, state)
      }
      // Sale completion clears the offer with the owner in one write.
      const sold = await newThing(db, roomId)
      await db.query('UPDATE things SET active_offer_id = 900 WHERE id = $1', [sold])
      await setEnd(db, sold, false)
      await db.query('UPDATE things SET owner_id = $2, active_offer_id = NULL WHERE id = $1 AND active_offer_id = 900', [sold, BUYER])
      await assertRow(db, sold, { owner_id: BUYER, active_offer_id: null, wake_enabled: false, open_to_reach: false, open_to_convert: false })

      const remnant = await thingIn(db, roomId, 'recorded')
      await db.query(GIFT_SQL, [remnant, BUYER, SELLER])
      await assertRow(db, remnant, { owner_id: BUYER, wake_enabled: false, open_to_reach: false, open_to_convert: false })
      await assert.rejects(db.query('UPDATE things SET wake_enabled = TRUE WHERE id = $1', [remnant]), refusedByGuard)

      // A due thing with an offer still open may lose the offer, never gain one.
      const offered = await newThing(db, roomId)
      await db.query('UPDATE things SET active_offer_id = 901 WHERE id = $1', [offered])
      await setEnd(db, offered, true)
      await assert.rejects(db.query('UPDATE things SET active_offer_id = 902 WHERE id = $1', [offered]), refusedByGuard)
      await db.query('UPDATE things SET active_offer_id = NULL WHERE id = $1', [offered])
      await record(db, offered)
      await assert.rejects(db.query('UPDATE things SET active_offer_id = 903 WHERE id = $1', [offered]), refusedByGuard)
      const offeredRemnant = await newThing(db, roomId)
      await db.query('UPDATE things SET active_offer_id = 904 WHERE id = $1', [offeredRemnant])
      await setEnd(db, offeredRemnant, true)
      await record(db, offeredRemnant)
      await db.query('UPDATE things SET active_offer_id = NULL WHERE id = $1', [offeredRemnant])
    })

    await t.test('no new label, mark or offer lands on a thing whose end has come', async () => {
      const labelSql = `INSERT INTO active_labels (target_type, target_id, label, actor_id, source_thing_id) VALUES ($1, $2, 'lit', 1, $3)`
      const markSql = 'INSERT INTO thing_later_holder_marks (resident_id, thing_id) VALUES (1, $1)'
      const offerSql = `INSERT INTO transfer_offers (asset_type, asset_id, seller_id, buyer_id, price_usdc, seller_wallet) VALUES ($1, $2, 1, 2, 2, '${WALLET}')`
      const active = await thingIn(db, roomId, 'active')
      for (const state of ['due', 'recorded'] as const) {
        const thingId = await thingIn(db, roomId, state)
        await assert.rejects(db.query(labelSql, ['thing', thingId, null]), refusedByGuard, `${state} label`)
        await assert.rejects(db.query(markSql, [thingId]), refusedByGuard, `${state} mark`)
        await assert.rejects(db.query(offerSql, ['thing', thingId]), refusedByGuard, `${state} offer`)
        // The target is what counts: a remnant may label others, and other assets are untouched.
        await db.query(labelSql, ['thing', active, thingId])
        await db.query(labelSql, ['place', roomId, thingId])
        for (const assetType of ['place', 'kind']) {
          await db.query(offerSql, [assetType, thingId])
        }
      }
      const fresh = await thingIn(db, roomId, 'active')
      await db.query(markSql, [fresh])
      const offerable = await thingIn(db, roomId, 'active')
      await db.query(offerSql, ['thing', offerable])
    })

    await t.test('a remnant held as luggage is released when its room opens to things', async () => {
      const luggageRoom = await roomIn(db, 'Luggage Room')
      const remnant = await newThing(db, luggageRoom)
      await db.query('UPDATE things SET held_by = owner_id WHERE id = $1', [remnant])
      await setEnd(db, remnant, true)
      await record(db, remnant)
      await db.query('UPDATE places SET open_to_things = TRUE WHERE id = $1', [luggageRoom])
      assert.equal((await row(db, remnant)).held_by, null)
    })

    await t.test('the writer setting lasts one transaction and passes only its own thing', async () => {
      const remnant = await thingIn(db, roomId, 'recorded', 'pending')
      const other = await thingIn(db, roomId, 'recorded', 'pending')
      const stateSql = `UPDATE things SET state = '{"n": 1}' WHERE id = $1`
      // On a client with no transaction, set the writer in the same statement.
      await db.query(`
        UPDATE things SET state = '{"n": 1}' WHERE id = $1
          AND (SELECT set_config('city.ending_writer', 'end_try:' || $1, true)) IS NOT NULL
      `, [remnant])
      const client = await db.connect()
      try {
        await assert.rejects(client.query(stateSql, [other]), refusedByGuard, 'never set, or empty')
        await client.query(`SELECT set_config('city.ending_writer', $1, true)`, [`end_try:${other}`])
        await assert.rejects(client.query(stateSql, [other]), refusedByGuard, 'a writer set by a previous statement is gone')
        assert.deepEqual((await client.query(`SELECT current_setting('city.ending_writer', true) AS writer`)).rows, [{ writer: '' }])
        await client.query('BEGIN')
        await client.query('SAVEPOINT member')
        await client.query(`SELECT set_config('city.ending_writer', $1, true)`, [`end_try:${other}`])
        await client.query('ROLLBACK TO SAVEPOINT member')
        await assert.rejects(client.query(stateSql, [other]), refusedByGuard, 'a writer set under a rolled-back savepoint is gone')
        await client.query('ROLLBACK')
        await client.query('BEGIN')
        await client.query(`SELECT set_config('city.ending_writer', '', true)`)
        await assert.rejects(client.query(stateSql, [other]), refusedByGuard, 'an empty writer passes nothing')
        await client.query('ROLLBACK')
        await client.query('BEGIN')
        await client.query(`SELECT set_config('city.ending_writer', $1, true)`, [`end_try:${other}`])
        await client.query(`UPDATE things SET state = '{"n": 2}' WHERE id = $1`, [other])
        await client.query(`UPDATE things SET state = '{"n": 3}' WHERE id = $1`, [other])
        await assert.rejects(client.query(`UPDATE things SET state = '{"n": 4}' WHERE id = $1`, [remnant]), refusedByGuard, 'only its own thing')
        await client.query('ROLLBACK')
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
      assert.deepEqual((await row(db, remnant)).state, { n: 1 })
      assert.deepEqual((await row(db, other)).state, {})
    })

    await t.test('the guards judge at the transaction time, never the clock', async () => {
      const thingId = await newThing(db, roomId)
      await db.query(`
        UPDATE things SET ending_rule = '{"any": [{"at": "2099-01-01T00:00:00Z"}]}', ending_grant = '{"kindless": true}',
          ending_set_by = 1, ending_set_at = now(), ending_deadline = clock_timestamp() + interval '1500 milliseconds'
        WHERE id = $1
      `, [thingId])
      const deadline = (await db.query<{ d: Date }>('SELECT ending_deadline AS d FROM things WHERE id = $1', [thingId])).rows[0]!.d
      await inTransaction(db, async client => {
        await client.query('SELECT transaction_timestamp()')
        await waitPastDatabaseTime(db, deadline)
        assert.deepEqual((await client.query('SELECT clock_timestamp() > ending_deadline AS passed FROM things WHERE id = $1', [thingId])).rows,
          [{ passed: true }])
        await client.query(`UPDATE things SET name = 'begun before the end' WHERE id = $1`, [thingId])
      })
      await assert.rejects(db.query(`UPDATE things SET name = 'after the end' WHERE id = $1`, [thingId]), refusedByGuard)
    })

    await t.test('the real sale completions close an open sale on an active, due or recorded thing', async () => {
      for (const state of ['active', 'due', 'recorded'] as const) {
        for (const operation of ['direct_sale', 'world_sale'] as const) {
          await resetCity(db)
          const seed = await seedRecoverableSale(db, operation, operation === 'direct_sale' ? '5' : '6')
          await setEnd(db, seed.assetId, state !== 'active')
          if (state === 'recorded') await record(db, seed.assetId)
          const sales = saleDatabase(db)
          const input = { attemptId: seed.attemptId, leaseOwner: seed.leaseOwner }
          const completed = operation === 'direct_sale'
            ? await completeDirectSalePayment(sales, input)
            : await completeWorldSalePayment(sales, input)
          assert.equal(completed.state, 'completed', `${state} ${operation}`)
          assert.deepEqual((await db.query(`
            SELECT thing.owner_id, thing.active_offer_id, thing.wake_enabled, thing.open_to_reach, thing.open_to_convert,
              thing.ended_at IS NOT NULL AS ended, offer.status AS offer_status,
              (SELECT count(*)::int FROM transfers WHERE offer_id = $2) AS transfers,
              (SELECT count(*)::int FROM events WHERE kind IN ('sale', 'world_sale') AND detail->>'offer_id' = $2::text) AS sale_events
            FROM things thing JOIN transfer_offers offer ON offer.id = $2 WHERE thing.id = $1
          `, [seed.assetId, seed.offerId])).rows, [{
            owner_id: BUYER, active_offer_id: null, wake_enabled: false, open_to_reach: false, open_to_convert: false,
            ended: state === 'recorded', offer_status: 'claimed', transfers: 1, sale_events: 1,
          }], `${state} ${operation}`)
        }
      }
    })

    await t.test('the real terminalizations release a due or recorded thing from its sale', async () => {
      for (const state of ['due', 'recorded'] as const) {
        for (const close of [true, false]) {
          await resetCity(db)
          const seed = await seedRecoverableSale(db, 'direct_sale', close ? '4' : '3', { activeReservation: true })
          await setEnd(db, seed.assetId, true)
          if (state === 'recorded') await record(db, seed.assetId)
          const sales = saleDatabase(db)
          const result = close
            ? await closeSalePaymentTarget(sales, {
              attemptId: seed.attemptId, leaseOwner: seed.leaseOwner,
              reason: 'automatic completion found changed direct sale facts', state: 'founder_review',
            })
            : await invalidateSalePaymentTarget(sales, {
              attemptId: seed.attemptId, leaseOwner: seed.leaseOwner, reason: 'confirmed_mismatch',
            })
          assert.equal(result.targetReleased, true, `${state} ${close ? 'close' : 'invalidate'}`)
          assert.deepEqual((await db.query(`
            SELECT thing.owner_id, thing.active_offer_id, offer.status FROM things thing
            JOIN transfer_offers offer ON offer.id = $2 WHERE thing.id = $1
          `, [seed.assetId, seed.offerId])).rows, [{ owner_id: SELLER, active_offer_id: null, status: 'canceled' }])
        }
      }
      roomId = await resetCity(db)
    })
  } finally {
    await postgres.stop()
  }
})
