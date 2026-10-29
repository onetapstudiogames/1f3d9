import assert from 'node:assert/strict'
import test from 'node:test'
import type { TaggedSql } from '../../src/engine.ts'
import type { ShowingResultCopy, ShowingRulesCopy } from '../../src/showing-room-copy.ts'
import { createShowingRoomFixture } from '../helpers/showing-room-fixtures.ts'

const nextQuestion: ShowingRulesCopy = {
  questionNumber: 12, title: 'Synthetic next question', prompt: 'Write a synthetic test notice.',
  entryClosesAt: '2026-11-14T15:00:00.000Z', voteClosesAt: '2026-11-16T15:00:00.000Z',
}
const entry = { noteId: 101, residentId: 11, handle: 'entry-one', votes: 1 }
const result: ShowingResultCopy = {
  questionNumber: 11, rulesNoteId: 100, entryCount: 1, ballotCount: 1,
  selectionCount: 1, entries: [entry], winners: [entry], excludedBallots: [],
  withdrawals: [], late: false,
}

async function newRun(sql: TaggedSql, slot = '2026-11-09T15:00:00.000Z'): Promise<number> {
  const rows = await sql.query!('INSERT INTO showing_room_runs(slot_at) VALUES($1) RETURNING id', [slot]) as {id:unknown}[]
  return Number(rows[0]!.id)
}

async function finishRun(sql: TaggedSql, runId: number): Promise<void> {
  await sql.query!('UPDATE showing_room_runs SET completed_at=clock_timestamp() WHERE id=$1', [runId])
}

test('recorded showing room publications are ordinary founder notes in real PostgreSQL', { timeout: 600_000 }, async t => {
  const { publishShowingRoomNotes } = await import('../../src/showing-room-publications.ts')
  const { printGazetteIssuesDue } = await import('../../src/gazette.ts')
  const { runTalkNoteAction } = await import('../../src/note-action.ts')
  const { executeEffects } = await import('../../src/engine-effects.ts')
  const { settleRoom, settleTimers } = await import('../../src/engine-settle.ts')
  const fixture = await createShowingRoomFixture(t)
  const { database, sql, transaction, reset, setClock } = fixture
  const publish = async (input: Readonly<{
    result?: ShowingResultCopy | null
    nextQuestion?: ShowingRulesCopy | null
    square?: boolean
  }> = {}) => transaction(async tx => {
    const runId = await newRun(tx)
    const publications = await publishShowingRoomNotes(tx, {
      runId, result: input.result === undefined ? result : input.result,
      nextQuestion: input.nextQuestion === undefined ? nextQuestion : input.nextQuestion,
      square: input.square ?? false,
    })
    await finishRun(tx, runId)
    return { runId, publications }
  })

  await t.test('all fixed-purpose notes have founder attribution and an event with their actual time', async () => {
    await reset()
    await database.query("UPDATE residents SET handle='founder-current' WHERE id=1")
    const before = (await database.query('SELECT * FROM resident_presence WHERE resident_id=1')).rows
    const written = await publish()
    assert.equal(written.publications.length, 4, 'count, winners, next rules and one Gazette report must be written')
    assert.deepEqual(written.publications.map(note => [note.purpose,note.part,note.placeId]), [
      ['count',1,438], ['winners',1,438], ['next_rules',1,438], ['gazette',1,454],
    ])
    const rows = (await database.query(`
      SELECT note.author_id,note.walk_to_read,event.actor,event.at=note.created_at AS same_time,
        publication.purpose,publication.part,note.body
      FROM showing_room_publications publication JOIN notes note ON note.id=publication.note_id
      JOIN events event ON event.kind='note' AND event.detail->>'note_id'=note.id::text
      WHERE publication.run_id=$1 ORDER BY note.id
    `,[written.runId])).rows
    assert.equal(rows.length,4)
    for (const row of rows) {
      assert.equal(row.author_id,1)
      assert.equal(row.walk_to_read,false)
      assert.equal(row.actor,'founder-current')
      assert.equal(row.same_time,true)
      assert.ok(Array.from(String(row.body)).length<=4000)
    }
    assert.deepEqual((await database.query('SELECT * FROM resident_presence WHERE resident_id=1')).rows,before)
    assert.equal((await database.query("SELECT count(*)::integer AS count FROM action_runs")).rows[0].count,0)
    assert.equal((await database.query("SELECT count(*)::integer AS count FROM events WHERE kind='room_settled'")).rows[0].count,0)
  })

  await t.test('all continuation links exist before any count part is published', async () => {
    await reset()
    await database.query(`
      CREATE FUNCTION assert_showing_links_reserved() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE linked_id TEXT;
      BEGIN
        IF EXISTS(SELECT 1 FROM showing_room_publications WHERE note_id=NEW.id AND purpose='count') THEN
          FOR linked_id IN SELECT match[1] FROM regexp_matches(NEW.body,'/api/note/([0-9]+)','g') AS match LOOP
            IF linked_id::integer<2000 AND linked_id::integer NOT IN (100,101) AND NOT EXISTS(
              SELECT 1 FROM showing_room_publications WHERE note_id=linked_id::integer
            ) THEN RAISE EXCEPTION 'all generated note links must be reserved before the first count insert'; END IF;
          END LOOP;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER z_showing_links_reserved BEFORE INSERT ON notes
        FOR EACH ROW EXECUTE FUNCTION assert_showing_links_reserved();
    `)
    const excludedBallots = Array.from({length: 220}, (_,index) => ({
      noteId: 2000+index,reason: 'The newest ballot names an entry outside this question.',
    }))
    const written = await publish({result:{...result,excludedBallots}})
    const countParts = written.publications.filter(note => note.purpose==='count')
    assert.ok(countParts.length>1,'a complete large count requires linked continuation notes')
    const bodies = (await database.query(`SELECT note.body FROM showing_room_publications publication
      JOIN notes note ON note.id=publication.note_id WHERE publication.run_id=$1
      AND publication.purpose='count' ORDER BY publication.part`,[written.runId])).rows.map(row=>String(row.body))
    for (const ballot of excludedBallots) assert.ok(bodies.join('\n').includes(`#${ballot.noteId}`))
    for (const body of bodies) assert.ok(Array.from(body).length<=4000)
  })

  await t.test('exhausted ordinary allowances admit exactly the linked Gazette service report', async () => {
    await reset()
    await database.query('UPDATE residents SET notes_today=100000 WHERE id=1')
    for (const body of ['ordinary one','ordinary two','ordinary three']) {
      await database.query('INSERT INTO notes(place_id,author_id,body) VALUES(454,1,$1)',[body])
    }
    const written = await publish()
    assert.equal(written.publications.filter(note=>note.purpose==='gazette').length,1,
      'the one linked report must be inserted after three ordinary submissions')
    assert.equal((await database.query('SELECT notes_today FROM residents WHERE id=1')).rows[0].notes_today,100000)
    await assert.rejects(database.query("INSERT INTO notes(place_id,author_id,body) VALUES(454,1,'ordinary fourth')"),
      /3 Gazette submissions/u)
    const report = (await database.query(`SELECT note.body FROM notes note JOIN showing_room_publications p
      ON p.note_id=note.id WHERE p.purpose='gazette'`)).rows[0].body
    await assert.rejects(database.query('INSERT INTO notes(place_id,author_id,body) VALUES(454,1,$1)',[report]),
      /3 Gazette submissions/u,'copying service text grants no exception')
  })

  await t.test('missing notes, duplicate purposes, wrong authors, rooms and oversized bodies cannot obtain an exception', async () => {
    await reset()
    const reserve = async (tx:TaggedSql, runId:number) => {
      const rows=await tx.query!("SELECT nextval(pg_get_serial_sequence('notes','id')) AS id") as {id:unknown}[]
      const noteId=Number(rows[0]!.id)
      await tx.query!("INSERT INTO showing_room_publications(run_id,purpose,part,note_id,place_id) VALUES($1,'gazette',1,$2,454)",[runId,noteId])
      return noteId
    }
    await assert.rejects(transaction(async tx=>{
      const runId=await newRun(tx)
      await reserve(tx,runId)
      await finishRun(tx,runId)
    }),/foreign key/u)
    for (const [author,place,body] of [[2,454,'Synthetic report'],[1,438,'Synthetic report'],[1,454,'x'.repeat(4001)]] as const) {
      await assert.rejects(transaction(async tx=>{
        const runId=await newRun(tx)
        const noteId=await reserve(tx,runId)
        await tx.query!('INSERT INTO notes(id,place_id,author_id,body) VALUES($1,$2,$3,$4)',[noteId,place,author,body])
        await finishRun(tx,runId)
      }),/public founder note|4000/u)
    }
    await assert.rejects(transaction(async tx=>{
      const runId=await newRun(tx)
      await reserve(tx,runId)
      await reserve(tx,runId)
    }),/duplicate key/u)
    assert.equal((await database.query('SELECT count(*)::integer AS count FROM showing_room_publications')).rows[0].count,0)
  })

  await t.test('a note failure rolls back every publication, event and run together', async () => {
    await reset()
    await database.query(`CREATE FUNCTION fail_showing_gazette() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.place_id=454 THEN RAISE EXCEPTION 'synthetic Gazette insert failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER z_showing_failure BEFORE INSERT ON notes FOR EACH ROW EXECUTE FUNCTION fail_showing_gazette();`)
    await assert.rejects(publish(),/synthetic Gazette insert failure/u,
      'the publisher must actually reach the report insertion inside the shared transaction')
    assert.deepEqual((await database.query(`SELECT
      (SELECT count(*)::integer FROM notes) AS notes,
      (SELECT count(*)::integer FROM events WHERE kind='note') AS events,
      (SELECT count(*)::integer FROM showing_room_publications) AS publications,
      (SELECT count(*)::integer FROM showing_room_runs) AS runs`)).rows[0],
    {notes:0,events:0,publications:0,runs:0})
  })

  await t.test('service notes leave due waits and talk listeners alone while a manual founder note settles both', async () => {
    await reset()
    await database.query(`
      INSERT INTO traits(id,name,description,recipe,coiner_id) VALUES(20,'showing-test-listener',
        'Synthetic talk listener.',
        '{"wake":{"on":["talk"],"every_seconds":10,"then":[{"effect":"write","key":"talks","op":"add"}]}}',1);
      INSERT INTO kinds(id,name,owner_id) VALUES(20,'showing-test-bell',1);
      INSERT INTO kind_revisions(kind_id,revision,traits) VALUES(20,1,ARRAY['showing-test-listener']);
      INSERT INTO things(id,place_id,name,body,owner_id,maker_id,kind_id,birth_revision,current_revision,wake_enabled)
        VALUES(20,438,'Synthetic listener','',1,1,20,1,1,TRUE);
    `)
    const clock=(await database.query('SELECT showing_test_clock() AS at')).rows[0].at as Date
    await executeEffects([{
      effect:'wait',seconds:1,then:[{effect:'label',target:'actor',label:'manual-founder-timer'}],
    }],{
      actionId:null,actorId:1,actorHandle:'founder',placeId:438,sourceThingId:null,
      sharedSourceThingId:null,target:null,destinationPlaceId:null,recipientId:null,
      sourceTraitId:null,lawAuthority:null,parentEffectId:null,generation:0,
      logicalAt:new Date(clock.getTime()-5000),
    },sql)
    const written=await publish()
    assert.equal(written.publications.length,4)
    assert.equal((await database.query('SELECT count(*)::integer AS count FROM effect_resolutions')).rows[0].count,0)
    assert.deepEqual((await database.query('SELECT state FROM things WHERE id=20')).rows[0].state,{})
    assert.equal((await database.query("SELECT count(*)::integer AS count FROM events WHERE kind='room_settled'")).rows[0].count,0)
    await settleTimers(438,sql)
    const manual=await runTalkNoteAction({placeId:438,residentId:1,residentHandle:'founder',text:'A manual founder note.'},sql)
    assert.equal(manual.ok,true)
    await settleRoom(438,'talk',1,sql)
    assert.equal((await database.query(`SELECT count(*)::integer AS count FROM active_labels
      WHERE target_id=1 AND label='manual-founder-timer'`)).rows[0].count,1)
    assert.deepEqual((await database.query('SELECT state FROM things WHERE id=20')).rows[0].state,{talks:1})
    assert.ok((await database.query("SELECT count(*)::integer AS count FROM events WHERE kind='room_settled'")).rows[0].count>0)
  })

  await t.test('the optional square note is linked and invalid final copy rolls every note back', async () => {
    await reset()
    const written=await publish({square:true})
    assert.deepEqual(written.publications.filter(note=>note.purpose==='square').map(note=>note.placeId),[3])
    await reset()
    await assert.rejects(publish({nextQuestion:{...nextQuestion,prompt:'Synthetic\u0000invalid prompt'}}),
      /public text|characters|rules/iu)
    assert.equal((await database.query('SELECT count(*)::integer AS count FROM notes')).rows[0].count,0)
    assert.equal((await database.query('SELECT count(*)::integer AS count FROM showing_room_publications')).rows[0].count,0)
  })

  await t.test('the linked report prints in ordinary chronological order and keeps author withdrawal', async () => {
    await reset()
    const first=Number((await database.query("INSERT INTO notes(place_id,author_id,body) VALUES(454,12,'Ordinary earlier report') RETURNING id")).rows[0].id)
    const written=await publish({nextQuestion:null})
    const report=written.publications.find(note=>note.purpose==='gazette')
    assert.ok(report,'the result must submit one report to the Gazette')
    const last=Number((await database.query("INSERT INTO notes(place_id,author_id,body) VALUES(454,13,'Ordinary later report') RETURNING id")).rows[0].id)
    await database.query('UPDATE resident_presence SET current_place_id=454 WHERE resident_id=1')
    const withdrawn=await runTalkNoteAction({placeId:454,residentId:1,residentHandle:'founder',text:`WITHDRAW #${report.noteId}`},sql)
    assert.equal(withdrawn.ok,true,'the founder may withdraw the same service report as its author')
    await setClock('2026-11-09T16:00:01.000Z')
    await printGazetteIssuesDue(sql)
    const membership=(await database.query(`SELECT entry.note_id FROM gazette_issue_entries entry
      JOIN gazette_issues issue ON issue.issue_number=entry.issue_number
      WHERE issue.scheduled_for='2026-11-09 16:00Z' ORDER BY entry.ordinal`)).rows.map(row=>Number(row.note_id))
    assert.deepEqual(membership,[first,report.noteId,last])
    assert.equal((await database.query('SELECT count(*)::integer AS count FROM gazette_withdrawals WHERE target_note_id=$1',[report.noteId])).rows[0].count,1)
  })

  await t.test('bootstrap writes only the next rules and opening report, with the square off by default', async () => {
    await reset()
    const written=await publish({result:null})
    assert.deepEqual(written.publications.map(note=>note.purpose),['next_rules','gazette'],
      'bootstrap does not invent a past count or winners')
  })
})
