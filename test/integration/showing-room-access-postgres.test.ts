import assert from 'node:assert/strict'
import test from 'node:test'
import { createShowingRoomFixture } from '../helpers/showing-room-fixtures.ts'

test('the private backlog serializes replay, revision edits and founder controls in PostgreSQL', { timeout: 180_000 }, async t => {
  const { addShowingRoomContest, editShowingRoomContest, listShowingRoom, controlShowingRoom } = await import('../../src/showing-room-store.ts')
  const { readShowingRoomAttention } = await import('../../src/showing-room-attention.ts')
  const fixture = await createShowingRoomFixture(t)
  await fixture.reset('2026-11-02T15:05:00.000Z')
  const query = async (text: string, params: readonly unknown[] = []) => await fixture.sql.query!(text, params) as Record<string, unknown>[]
  const database = { query, transaction: async <T>(work: (tx: { query: typeof query }) => Promise<T>) => fixture.transaction(async sql => work({ query: async (text, params = []) => await sql.query!(text, params) as Record<string, unknown>[] })) }
  await query('UPDATE showing_room_control SET enabled=FALSE,paused=TRUE,first_slot_at=NULL,first_question_number=NULL')
  const input = { request_id: 'synthetic-private-question', title: 'Synthetic question', prompt: 'PRIVATE_SHOWING_ACCESS_CANARY' }
  const added = await addShowingRoomContest(database, input)
  assert.equal(added.ok, true, 'a founder question must be stored rather than reported unavailable')
  if (!added.ok) return
  const id = Number((added.value as { contest: { id: number } }).contest.id)

  await t.test('a bounded prompt still refuses when its complete rules would overflow', async () => {
    const overflow = await addShowingRoomContest(database, { ...input, request_id: 'complete-rules-too-long', prompt: 'x'.repeat(1800) })
    assert.equal(overflow.ok, false)
    if (!overflow.ok) assert.equal(overflow.status, 400)
    assert.equal((await query('SELECT count(*)::integer AS count FROM showing_room_contests'))[0]!.count, 1)
  })

  await t.test('same request races keep one question and changed payload conflicts', async () => {
    const copies = await Promise.all([addShowingRoomContest(database, input), addShowingRoomContest(database, input)])
    assert.equal(copies.every(result => result.ok), true)
    assert.equal((await query('SELECT count(*)::integer AS count FROM showing_room_contests'))[0]!.count, 1)
    const changed = await addShowingRoomContest(database, { ...input, prompt: 'Changed' })
    assert.equal(changed.ok, false)
    if (!changed.ok) assert.equal(changed.status, 409)
  })

  await t.test('only one concurrent revision edit wins', async () => {
    const edits = await Promise.all([
      editShowingRoomContest(database, id, { expected_revision: 1, title: 'First edit' }),
      editShowingRoomContest(database, id, { expected_revision: 1, title: 'Second edit' }),
    ])
    assert.equal(edits.filter(result => result.ok).length, 1)
    assert.equal(edits.filter(result => !result.ok && result.status === 409).length, 1)
  })

  await t.test('reads preserve private text and do not update control or presence', async () => {
    const before = await query('SELECT row_to_json(control) AS row FROM showing_room_control control')
    const events = await query('SELECT count(*)::integer AS count FROM events')
    const listed = await listShowingRoom(database, { before_id: null, before_run_id: null, limit: 20 })
    assert.equal(listed.ok, true)
    assert.match(JSON.stringify(listed), /PRIVATE_SHOWING_ACCESS_CANARY/u)
    const attention = await readShowingRoomAttention(database)
    assert.equal(attention.queue_count, 1)
    assert.equal(JSON.stringify(attention).includes('PRIVATE_SHOWING_ACCESS_CANARY'), false)
    assert.deepEqual(await query('SELECT row_to_json(control) AS row FROM showing_room_control control'), before)
    assert.deepEqual(await query('SELECT count(*)::integer AS count FROM events'), events)
    const exported = await query("SELECT count(*)::integer AS count FROM city_snapshot.public_records_v3 record WHERE row_to_json(record)::text LIKE '%PRIVATE_SHOWING_ACCESS_CANARY%'")
    assert.equal(exported[0]!.count, 0)
  })

  await t.test('activation requires recorded manual question ten and a verified deployment', async () => {
    const ordinaryName = await addShowingRoomContest(database, { ...input, request_id: 'manual-legacy-q10' })
    assert.equal(ordinaryName.ok, true, 'an allowed founder request name must not collide with the internal manual record')
    await query(`INSERT INTO notes(id,place_id,author_id,body,created_at) VALUES
      (40225,438,1,'Synthetic manual rules','2026-10-26T16:00:42.833Z'),
      (42001,438,1,'Synthetic manual count with no prize','2026-11-02T15:01:00Z')`)
    const activation = { request_id: 'synthetic-activation', action: 'activate', first_slot: '2026-11-02T15:00:00.000Z', first_question_number: 11,
      manual_legacy: { rules_note_id: 40225, count_note_id: 42001, winner_note_ids: [], credit_source_keys: [] } }
    const proof = (await query('SELECT activation_commit,activated_at FROM showing_room_control'))[0]!
    await query('UPDATE showing_room_control SET activation_commit=NULL,activated_at=NULL')
    const premature = await controlShowingRoom(database, activation)
    assert.equal(premature.ok, false)
    if (!premature.ok) assert.equal(premature.status, 409)
    await query('UPDATE showing_room_control SET activation_commit=$1,activated_at=$2', [proof.activation_commit, proof.activated_at])
    const missing = await controlShowingRoom(database, { ...activation, manual_legacy: { ...activation.manual_legacy, count_note_id: 99999 } })
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.equal(missing.status, 409)
    const activated = await controlShowingRoom(database, activation)
    assert.equal(activated.ok, true)
    assert.deepEqual(await controlShowingRoom(database, activation), activated)
    assert.equal((await query('SELECT count(*)::integer AS count FROM showing_room_contests WHERE state=$1', ['manual-legacy']))[0]!.count, 1)
    assert.equal((await query('SELECT enabled FROM showing_room_control'))[0]!.enabled, true)
    assert.equal((await query('SELECT count(*)::integer AS count FROM city_credit_entries'))[0]!.count, 0)
  })

  await t.test('pause, resume and square requests replay and changed terms conflict', async () => {
    for (const input of [{ request_id: 'pause-once', action: 'pause' }, { request_id: 'resume-once', action: 'resume' }, { request_id: 'square-once', action: 'square', enabled: true }, { request_id: 'constructor', action: 'square', enabled: false }]) {
      const first = await controlShowingRoom(database, input)
      assert.equal(first.ok, true)
      assert.deepEqual(await controlShowingRoom(database, input), first)
    }
    const conflict = await controlShowingRoom(database, { request_id: 'square-once', action: 'square', enabled: false })
    assert.equal(conflict.ok, false)
    if (!conflict.ok) assert.equal(conflict.status, 409)
  })

  await t.test('the hourly bound refuses a new write but allows a replay', async () => {
    await query('UPDATE showing_room_control SET management_window_start=clock_timestamp(), management_writes=60')
    const refused = await addShowingRoomContest(database, { ...input, request_id: 'over-limit' })
    assert.equal(refused.ok, false)
    if (!refused.ok) { assert.equal(refused.status, 429); assert.ok((refused.retry_after ?? 0) > 0) }
    assert.equal((await addShowingRoomContest(database, input)).ok, true)
  })

  await t.test('an opened question cannot be edited even with its last queued revision', async () => {
    await query("INSERT INTO notes(id,place_id,author_id,body) VALUES(43000,438,1,'Synthetic managed rules')")
    await query(`UPDATE showing_room_contests SET state='open',question_number=11,rules_note_id=43000,
      opened_at='2026-11-02T15:05:00Z',entry_closes_at='2026-11-07T15:00:00Z',vote_closes_at='2026-11-09T15:00:00Z' WHERE id=$1`, [id])
    const edit = await editShowingRoomContest(database, id, { expected_revision: 2, prompt: 'Changed after opening' })
    assert.equal(edit.ok, false)
    if (!edit.ok) assert.equal(edit.status, 409)
    assert.equal((await query('SELECT prompt FROM showing_room_contests WHERE id=$1', [id]))[0]!.prompt, input.prompt)
  })
})
