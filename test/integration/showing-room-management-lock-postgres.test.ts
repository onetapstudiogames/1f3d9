import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { setEngineTransactionRunnerForTests, type TaggedSql } from '../../src/engine.ts'
import { printGazetteIssuesDue } from '../../src/gazette.ts'
import { runTalkNoteAction } from '../../src/note-action.ts'
import { parseTraitRecipe } from '../../src/physics.ts'
import { controlShowingRoom, type ShowingRoomDatabase } from '../../src/showing-room-store.ts'
import { createShowingRoomFixture } from '../helpers/showing-room-fixtures.ts'

test('showing room management, a talk law and Gazette printing share one admission order', { timeout: 60_000 }, async t => {
  const { database, sql, reset, transaction } = await createShowingRoomFixture(t)
  await reset()
  const recipe = { talk: [
    { effect: 'reach', over: 'residents', max: 1, then: [{ effect: 'label', target: 'target', label: 'heard-note' }] },
    { effect: 'move', target: 'actor', to: 'home' },
  ] }
  assert.ok(parseTraitRecipe(recipe), 'the race must use a supported room law')
  await database.query(`UPDATE resident_presence SET home_place_id=454 WHERE resident_id=1;
    INSERT INTO places(id,parent_id,place_kind,name,description,owner_id)
      VALUES(500,2,'place','voter home','An owned test home.',13);
    UPDATE resident_presence SET home_place_id=500 WHERE resident_id=13`)
  await database.query(`INSERT INTO traits(id,name,description,recipe,coiner_id)
    VALUES(90,'showing-home-law','Mark a listener and send the speaker home.',$1::jsonb,1)`, [JSON.stringify(recipe)])
  await database.query(`
    INSERT INTO place_law_changes(place_id,trait_id,actor_id,change_type,position)
      VALUES(438,90,1,'add',0)`)
  const printerRoomHeld = Promise.withResolvers<void>()
  const continuePrinter = Promise.withResolvers<void>()
  const noteRoomsAttempted = Promise.withResolvers<void>()
  const managementAdmissionAttempted = Promise.withResolvers<void>()
  let databaseErrors: readonly string[] = []
  const observed = (source: TaggedSql): TaggedSql => {
    const query = async (text: string, values: readonly unknown[] = []) => {
      if (text.includes('WITH RECURSIVE tree')) noteRoomsAttempted.resolve()
      if (text.includes('$1::integer,$2::integer') && values[0] === 524128266) managementAdmissionAttempted.resolve()
      const rows = await source.query!(text, values).catch(error => {
        databaseErrors = [...databaseErrors, String(error.code)]
        throw error
      })
      if (text.includes('SELECT id FROM places WHERE id = $1::integer FOR NO KEY UPDATE')) {
        printerRoomHeld.resolve()
        await continuePrinter.promise
      }
      return rows
    }
    const wrapped = (async (strings: TemplateStringsArray, ...values: readonly unknown[]) => query(
      strings.reduce((text, part, index) => text + part + (index < values.length ? `$${index + 1}` : ''), ''), values,
    )) as TaggedSql
    wrapped.query = query
    return wrapped
  }
  setEngineTransactionRunnerForTests((_database, work) => transaction(tx => work(observed(tx), true)))
  const management: ShowingRoomDatabase = {
    query: async (text, values = []) => observed(sql).query!(text, values) as Promise<readonly Record<string, unknown>[]>,
    transaction: work => transaction(tx => work({
      query: async (text, values = []) => observed(tx).query!(text, values) as Promise<readonly Record<string, unknown>[]>,
    })),
  }
  const printing = printGazetteIssuesDue(sql).then(value => ({ value }), error => ({ error }))
  let note: Promise<unknown> | undefined
  let pause: Promise<unknown> | undefined
  try {
    await printerRoomHeld.promise
    const pendingNote = runTalkNoteAction({ placeId: 438, residentId: 13, residentHandle: 'voter',
      text: 'An ordinary note before returning home.' }, sql)
      .then(value => ({ value }), error => ({ error }))
    note = pendingNote
    await noteRoomsAttempted.promise
    const pendingPause = controlShowingRoom(management, { action: 'pause', request_id: 'pause-with-law-and-print' })
      .then(value => ({ value }), error => ({ error }))
    pause = pendingPause
    await managementAdmissionAttempted.promise
    let waiting = false
    for (let tries = 0; tries < 100 && !waiting; tries += 1) {
      waiting = (await database.query(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory'
        AND classid=524128266 AND objid=438 AND NOT granted) AS waiting`)).rows[0].waiting
      if (!waiting) await delay(10)
    }
    assert.equal(waiting, true, 'management must reach admission while the note waits for Gazette room 454')
    continuePrinter.resolve()
    const [printed, talked, paused] = await Promise.all([printing, pendingNote, pendingPause])
    t.diagnostic(JSON.stringify({ managementAdmissionRace: true, databaseErrors }))
    assert.ok('value' in printed && printed.value.length > 0, 'the Gazette printer must commit')
    assert.ok('value' in talked && talked.value.ok, 'the note, its law and its activity stamp must commit')
    assert.ok('value' in paused && paused.value.ok, 'the founder pause must commit after ordinary admission')
    assert.deepEqual(databaseErrors, [])
    assert.equal((await database.query('SELECT current_place_id FROM resident_presence WHERE resident_id=13')).rows[0].current_place_id, 500)
    assert.equal((await database.query("SELECT count(*)::integer AS count FROM active_labels WHERE target_type='resident' AND target_id=1 AND label='heard-note'")).rows[0].count, 1)
    assert.equal((await database.query('SELECT paused FROM showing_room_control WHERE id=1')).rows[0].paused, true)
  } finally {
    continuePrinter.resolve()
    await Promise.all([printing, note, pause])
  }
})
