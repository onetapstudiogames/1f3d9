import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import type { Pool } from 'pg'
import type { TaggedSql } from '../../src/engine.ts'
import { createShowingRoomFixture, showingSql } from '../helpers/showing-room-fixtures.ts'

const SLOT = '2026-11-09T15:00:00.000Z'
const PREVIOUS_SLOT = '2026-11-02T15:00:00.000Z'
const ADMISSION_LOCK = 0x1f3d900a

async function seedContest(database: Pool, close = SLOT,
  options: Readonly<{ entries?: boolean; ballot?: string }> = {}): Promise<void> {
  await database.query('UPDATE showing_room_control SET enabled=FALSE WHERE id=1')
  await database.query(`
    INSERT INTO notes (id, place_id, author_id, body, created_at) VALUES
      (100, 438, 1, 'THE ELEVENTH QUESTION\nPublished synthetic rules.',
        $1::timestamptz - interval '7 days'),
      (101, 438, 11, $2,
        $1::timestamptz - interval '4 days'),
      (102, 438, 12, $3,
        $1::timestamptz - interval '3 days'),
      (103, 438, 13, $4, $1::timestamptz - interval '1 day')
  `, [close, options.entries === false ? 'First ordinary note.' : 'ENTRY First title\nFirst public entry.',
    options.entries === false ? 'Second ordinary note.' : 'ENTRY Second title\nSecond public entry.',
    options.ballot ?? 'VOTE #101, #102'])
  await database.query(`SELECT setval(pg_get_serial_sequence('notes', 'id'), 103)`)
  await database.query(`
    INSERT INTO showing_room_contests (
      id, request_id, request_hash, title, prompt, state, rule_version, question_number,
      rules_note_id, opened_at, entry_closes_at, vote_closes_at
    ) VALUES (1, 'published-test-contest', 'synthetic-hash', 'Published synthetic question',
      'Already published synthetic prompt.', 'open', 'showing-room-v1', 11,
      100, $1::timestamptz - interval '7 days', $1::timestamptz - interval '2 days', $1)
  `, [close])
  await database.query(`
    INSERT INTO showing_room_contests (id, request_id, request_hash, title, prompt)
    VALUES (2, 'queued-test-contest', 'synthetic-hash', 'Synthetic next question', 'Synthetic private prompt.');
    SELECT setval(pg_get_serial_sequence('showing_room_contests', 'id'), 2);
    UPDATE showing_room_control SET enabled=TRUE WHERE id=1;
  `)
}

async function counts(database: Pool): Promise<Record<string, unknown>> {
  return (await database.query(`
    SELECT
      (SELECT count(*)::integer FROM city_credit_entries) AS credits,
      (SELECT coalesce(sum(amount_units), 0)::text FROM city_credit_entries) AS units,
      (SELECT count(*)::integer FROM showing_room_publications) AS publications,
      (SELECT count(*)::integer FROM events WHERE kind = 'note') AS note_events,
      (SELECT count(*)::integer FROM showing_room_runs) AS runs,
      (SELECT count(*)::integer FROM showing_room_contests WHERE state = 'queued') AS queued,
      (SELECT count(*)::integer FROM showing_room_contests WHERE state = 'open') AS open
  `)).rows[0]!
}

test('showing room runner holds its promises in real PostgreSQL', { timeout: 600_000 }, async t => {
  const { CommitOutcomeUnknownError, setEngineTransactionRunnerForTests, withEngineTransaction } =
    await import('../../src/engine.ts')
  const { runShowingRoomClose } = await import('../../src/showing-room-runner.ts')
  const { runTalkNoteAction } = await import('../../src/note-action.ts')
  const { printGazetteIssuesDue } = await import('../../src/gazette.ts')
  const { settleRoom, settleTimers } = await import('../../src/engine-settle.ts')
  const { executeEffects } = await import('../../src/engine-effects.ts')
  const { controlShowingRoom, addShowingRoomContest } = await import('../../src/showing-room-store.ts')
  const { database, sql, reset, setClock, transaction } = await createShowingRoomFixture(t)
  const management: import('../../src/showing-room-store.ts').ShowingRoomDatabase = {
    query: async (text: string, values: readonly unknown[] = []) => sql.query!(text, values) as Promise<readonly Record<string, unknown>[]>,
    transaction: work => transaction(tx => work({
      query: async (text, values = []) => tx.query!(text, values) as Promise<readonly Record<string, unknown>[]>,
    })),
  }
  let loseCommitResponse = false
  let failBeforeCommit = false
  let beforeQuery: ((text: string, values: readonly unknown[]) => Promise<void>) | undefined
  let afterQuery: ((text: string, values: readonly unknown[]) => Promise<void>) | undefined
  let databaseErrors: readonly Readonly<{ code: string; message: string; detail?: string }>[] = []
  setEngineTransactionRunnerForTests(async (_ignored, work) => {
    const client = await database.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL statement_timeout = '5s'")
      const actual = showingSql(client)
      const query = async (text: string, values: readonly unknown[] = []) => {
        await beforeQuery?.(text, values)
        const rows = await actual.query!(text, values).catch(error => {
          databaseErrors = [...databaseErrors, {
            code: String(error.code), message: String(error.message), detail: error.detail,
          }]
          throw error
        })
        await afterQuery?.(text, values)
        return rows
      }
      const observed = (async (strings: TemplateStringsArray, ...values: readonly unknown[]) => query(
        strings.reduce((text, part, index) => text + part + (index < values.length ? `$${index + 1}` : ''), ''), values,
      )) as TaggedSql
      observed.query = query
      const result = await work(observed, true)
      if (failBeforeCommit) {
        failBeforeCommit = false
        throw new Error('synthetic failure before commit')
      }
      await client.query('COMMIT')
      if (loseCommitResponse) {
        loseCommitResponse = false
        throw new CommitOutcomeUnknownError(new Error('synthetic lost commit response'))
      }
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  })
  await t.test('simultaneous jobs close once, credit both tied winners, and consume one question', async () => {
    await reset()
    await seedContest(database)
    const [first, second] = await Promise.all([runShowingRoomClose(sql), runShowingRoomClose(sql)])
    assert.equal(first.status, 'completed', 'the due contest must complete')
    assert.deepEqual(second, first, 'the second call returns the durable first outcome')
    assert.deepEqual(await counts(database), {
      credits: 2, units: '2000000', publications: 4, note_events: 4,
      runs: 1, queued: 0, open: 1,
    })
    assert.deepEqual((await database.query(`
      SELECT resident_id, amount_units::text, source_key FROM city_credit_entries ORDER BY resident_id
    `)).rows, [
      { resident_id: 11, amount_units: '1000000', source_key: 'showing-room-q11-2026-11-09-r11' },
      { resident_id: 12, amount_units: '1000000', source_key: 'showing-room-q11-2026-11-09-r12' },
    ])
  })

  await t.test('a lost commit response resolves through a fresh connection without another award', async () => {
    await reset()
    await seedContest(database)
    loseCommitResponse = true
    const first = await runShowingRoomClose(sql)
    assert.equal(first.status, 'completed', 'a committed count is recovered after its response is lost')
    const before = await counts(database)
    const replay = await runShowingRoomClose(showingSql(database))
    assert.deepEqual(replay, first)
    assert.deepEqual(await counts(database), before)
  })

  await t.test('N1 old contest recovery replays from the current slot after its open row is gone', async () => {
    loseCommitResponse = false
    await reset()
    await seedContest(database, PREVIOUS_SLOT)
    loseCommitResponse = true
    const first = await runShowingRoomClose(sql)
    assert.equal(first.status, 'late', 'an older contest closes without launching a shortened question')
    assert.equal((await counts(database)).queued, 1)
    assert.equal((await counts(database)).open, 0)
    const before = await counts(database)
    const replay = await runShowingRoomClose(showingSql(database))
    assert.deepEqual(replay, first, 'retry resolves the stored recovery link before looking for an open contest')
    assert.deepEqual(await counts(database), before)
    const links = (await database.query(`
      SELECT current.slot_at::text, original.contest_slot_at::text
      FROM showing_room_runs current
      JOIN showing_room_runs original ON original.id = current.recovery_run_id
      WHERE current.slot_at = $1
    `, [SLOT])).rows
    assert.equal(links.length, 1, 'the current slot keeps its immutable old-contest recovery link')
  })

  await t.test('an edit already holding the queued row is frozen before the question opens', async () => {
    await reset()
    await seedContest(database)
    const editor = await database.connect()
    await editor.query('BEGIN')
    await editor.query(`UPDATE showing_room_contests SET prompt = 'Edited synthetic prompt.',
      revision = revision + 1 WHERE id = 2 AND state = 'queued' AND revision = 1`)
    try {
      const pending = runShowingRoomClose(sql)
      await delay(50)
      await editor.query('COMMIT')
      const result = await pending
      assert.equal(result.status, 'completed', 'the runner must wait for and use the committed queue edit')
      const opened = (await database.query(`
        SELECT contest.prompt, contest.revision, contest.state, note.body
        FROM showing_room_contests contest JOIN notes note ON note.id = contest.rules_note_id
        WHERE contest.id = 2
      `)).rows[0]!
      assert.equal(opened.state, 'open')
      assert.equal(opened.revision, 2)
      assert.match(opened.body, /Edited synthetic prompt\./u)
      assert.equal((await database.query(`UPDATE showing_room_contests SET prompt = 'Too late.'
        WHERE id = 2 AND state = 'queued' AND revision = 2`)).rowCount, 0)
    } finally {
      await editor.query('ROLLBACK')
      editor.release()
    }
  })

  await t.test('full daily and Gazette allowances do not block linked service notes or extend ordinary allowances', async () => {
    await reset()
    await seedContest(database)
    await database.query(`UPDATE residents SET notes_today = 100000 WHERE id = 1`)
    for (const body of ['ordinary founder one', 'ordinary founder two', 'ordinary founder three']) {
      await database.query('INSERT INTO notes (place_id, author_id, body) VALUES (454, 1, $1)', [body])
    }
    const result = await runShowingRoomClose(sql)
    assert.equal(result.status, 'completed', 'the fixed service act completes with ordinary allowances exhausted')
    assert.equal((await database.query('SELECT notes_today FROM residents WHERE id = 1')).rows[0].notes_today, 100000)
    assert.equal((await database.query('SELECT count(*)::integer AS count FROM notes WHERE place_id = 454')).rows[0].count, 4)
    await assert.rejects(database.query(`INSERT INTO notes (place_id, author_id, body)
      VALUES (454, 1, 'ordinary founder fourth')`),
    (error: unknown) => (error as { constraint?: string }).constraint === 'gazette_submission_weekly_limit')
  })

  await t.test('a blocked room insertion receives admission time after the deadline', async () => {
    await reset('2026-11-09T14:59:59.900Z')
    await seedContest(database)
    await setClock('2026-11-09T14:59:59.900Z')
    const holder = await database.connect()
    await holder.query('BEGIN')
    await holder.query('SELECT pg_advisory_xact_lock($1, 438)', [ADMISSION_LOCK])
    const insertion = database.query(`INSERT INTO notes (place_id, author_id, body, created_at)
      VALUES (438, 13, 'VOTE #101', TIMESTAMPTZ '2026-11-09 14:00:00+00')
      RETURNING created_at`)
    try {
      await delay(200)
      await holder.query('COMMIT')
      const admitted = (await insertion).rows[0].created_at as Date
      assert.ok(admitted.getTime() >= Date.parse(SLOT),
        'an insertion waiting across close must use post-lock database time, not its supplied timestamp')
      const result = await runShowingRoomClose(sql)
      assert.equal(result.status, 'completed')
      assert.equal((await counts(database)).credits, 2, 'the late replacement must not displace the counted ballot')
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
    }
  })

  await t.test('service notes leave settlement and presence untouched while ordinary notes still settle', async () => {
    await reset()
    await seedContest(database)
    await database.query(`
      INSERT INTO traits (id, name, description, recipe, coiner_id) VALUES
        (20, 'showing-test-listener', 'Synthetic talk listener.',
          '{"wake":{"on":["talk"],"every_seconds":10,"then":[{"effect":"write","key":"talks","op":"add"}]}}', 1);
      INSERT INTO kinds (id, name, owner_id) VALUES (20, 'showing-test-bell', 1);
      INSERT INTO kind_revisions (kind_id, revision, traits)
        VALUES (20, 1, ARRAY['showing-test-listener']);
      INSERT INTO things (id, place_id, name, body, owner_id, maker_id, kind_id,
        birth_revision, current_revision, wake_enabled)
        VALUES (20, 438, 'Synthetic listener', '', 1, 1, 20, 1, 1, TRUE);
    `)
    const scheduleWait = async (label: string) => {
      const clock = (await database.query('SELECT showing_test_clock() AS at')).rows[0].at as Date
      await executeEffects([{
        effect: 'wait', seconds: 1, then: [{ effect: 'label', target: 'actor', label }],
      }], {
        actionId: null, actorId: 11, actorHandle: 'entry-one', placeId: 438,
        sourceThingId: null, sharedSourceThingId: null, target: null,
        destinationPlaceId: null, recipientId: null, sourceTraitId: null,
        lawAuthority: null, parentEffectId: null, generation: 0,
        logicalAt: new Date(clock.getTime() - 5_000),
      }, sql)
    }
    await scheduleWait('ordinary-note-timer')
    const before = (await database.query(`SELECT * FROM resident_presence WHERE resident_id = 1`)).rows
    // Match the existing note route: due timers, ordinary note, then talk wake.
    await settleTimers(438, sql)
    const ordinary = await runTalkNoteAction({
      placeId: 438, residentId: 11, residentHandle: 'entry-one', text: 'An ordinary room note.',
    }, sql)
    assert.equal(ordinary.ok, true, 'the ordinary note control must be accepted')
    await settleRoom(438, 'talk', 11, sql)
    assert.equal((await database.query(`SELECT count(*)::integer AS count FROM active_labels
      WHERE target_id = 11 AND label = 'ordinary-note-timer'`)).rows[0].count, 1,
    'the ordinary note route resolves its due wait')
    const settledBefore = (await database.query(`SELECT count(*)::integer AS count
      FROM events WHERE kind = 'room_settled'`)).rows[0].count
    assert.ok(settledBefore > 0, 'the ordinary note must retain room settlement')
    assert.deepEqual((await database.query('SELECT state FROM things WHERE id = 20')).rows[0].state,
      { talks: 1 }, 'ordinary talk wakes the room listener')
    await scheduleWait('service-must-not-run-timer')
    await database.query(`UPDATE thing_wake_state SET last_try_at = last_try_at - interval '1 minute'`)
    const result = await runShowingRoomClose(sql)
    assert.equal(result.status, 'completed', 'the service must produce recorded public notes')
    assert.equal((await database.query(`SELECT count(*)::integer AS count FROM active_labels
      WHERE target_id = 11 AND label = 'service-must-not-run-timer'`)).rows[0].count, 0)
    assert.deepEqual((await database.query('SELECT state FROM things WHERE id = 20')).rows[0].state,
      { talks: 1 }, 'service notes do not wake the same listener')
    assert.equal((await database.query(`SELECT count(*)::integer AS count
      FROM events WHERE kind = 'room_settled'`)).rows[0].count, settledBefore)
    assert.deepEqual((await database.query(`SELECT * FROM resident_presence WHERE resident_id = 1`)).rows, before)
    assert.equal((await database.query(`SELECT count(*)::integer AS count
      FROM showing_room_publications publication JOIN notes note ON note.id = publication.note_id
      JOIN events event ON event.kind = 'note' AND event.detail->>'note_id' = note.id::text
      WHERE note.author_id = 1 AND event.actor = 'founder' AND event.at = note.created_at`)).rows[0].count, 4)
  })

  await t.test('an empty slot stays skipped when a question is queued after the first attempt', async () => {
    await reset()
    const first = await runShowingRoomClose(sql)
    assert.equal(first.status, 'empty', 'an empty week receives a durable used-slot record')
    await database.query(`INSERT INTO showing_room_contests (request_id, request_hash, title, prompt)
      VALUES ('added-after-skip', 'synthetic-hash', 'Later synthetic question', 'Synthetic prompt added after skipping.')`)
    assert.deepEqual(await runShowingRoomClose(sql), first)
    assert.deepEqual(await counts(database), {
      credits: 0, units: '0', publications: 0, note_events: 0, runs: 1, queued: 1, open: 0,
    })
  })

  await t.test('bootstrap freezes one queued question and submits one opening report without a prior count', async () => {
    await reset()
    const added = await addShowingRoomContest(management, { request_id: 'bootstrap-question',
      title: 'Bootstrap title', prompt: 'Bootstrap private prompt.' })
    assert.equal(added.ok, true)
    const outcome = await runShowingRoomClose(sql)
    assert.equal(outcome.status, 'opened')
    assert.equal(outcome.countNoteId, null)
    assert.ok(outcome.nextRulesNoteId)
    assert.ok(outcome.gazetteNoteId)
    assert.deepEqual(await counts(database), {
      credits: 0, units: '0', publications: 2, note_events: 2, runs: 1, queued: 0, open: 1,
    })
    const row = (await database.query(`SELECT question_number,opened_at,entry_closes_at,vote_closes_at
      FROM showing_room_contests WHERE state='open'`)).rows[0]
    assert.equal(row.question_number, 11)
    assert.equal(row.entry_closes_at.toISOString(), '2026-11-14T15:00:00.000Z')
    assert.equal(row.vote_closes_at.toISOString(), '2026-11-16T15:00:00.000Z')
    assert.ok(row.opened_at.getTime() >= Date.parse(SLOT))
    assert.deepEqual(await runShowingRoomClose(sql), outcome)
  })

  await t.test('late bootstrap consumes the slot privately and leaves the queued question untouched', async () => {
    await reset('2026-11-09T16:00:00.000Z')
    await addShowingRoomContest(management, { request_id: 'late-bootstrap', title: 'Late title', prompt: 'Later prompt.' })
    const outcome = await runShowingRoomClose(sql)
    assert.equal(outcome.status, 'late')
    assert.deepEqual(await counts(database), {
      credits: 0, units: '0', publications: 0, note_events: 0, runs: 1, queued: 1, open: 0,
    })
    assert.deepEqual((await database.query('SELECT late,skipped FROM showing_room_runs')).rows, [{ late: true, skipped: true }])
    assert.deepEqual(await runShowingRoomClose(sql), outcome)
  })

  await t.test('disabled, paused and future first slots create no run marker', async () => {
    await reset()
    await database.query('UPDATE showing_room_control SET enabled=FALSE WHERE id=1')
    assert.equal((await runShowingRoomClose(sql)).status, 'disabled')
    await database.query('UPDATE showing_room_control SET enabled=TRUE,paused=TRUE WHERE id=1')
    assert.equal((await runShowingRoomClose(sql)).status, 'paused')
    await database.query("UPDATE showing_room_control SET paused=FALSE,first_slot_at='2026-11-16 15:00Z' WHERE id=1")
    assert.equal((await runShowingRoomClose(sql)).status, 'waiting')
    assert.equal((await counts(database)).runs, 0)
  })

  await t.test('a pause holding the service lock wins before counting and resume permits one queued opening', async () => {
    await reset()
    await seedContest(database)
    const holder = await database.connect()
    await holder.query('BEGIN')
    await holder.query('SELECT pg_advisory_xact_lock(524128265,438)')
    const paused = controlShowingRoom(management, { action: 'pause', request_id: 'pause-before-run' })
    await delay(75)
    const pending = runShowingRoomClose(sql)
    try {
      await holder.query('COMMIT')
      assert.equal((await paused).ok, true)
      assert.equal((await pending).status, 'paused')
      assert.equal((await counts(database)).runs, 0)
      assert.equal((await controlShowingRoom(management, { action: 'resume', request_id: 'resume-before-run' })).ok, true)
      assert.equal((await runShowingRoomClose(sql)).status, 'completed')
      assert.equal((await counts(database)).open, 1)
    } finally { await holder.query('ROLLBACK'); holder.release() }
  })

  for (const noPrize of ['no entries', 'invalid ballots'] as const) {
    await t.test(`${noPrize} gives no award and still opens the next queued contest`, async () => {
      await reset()
      await seedContest(database, SLOT, noPrize === 'no entries'
        ? { entries: false, ballot: 'An ordinary observer note.' } : { ballot: 'VOTE #999999' })
      const outcome = await runShowingRoomClose(sql)
      assert.equal(outcome.status, 'completed')
      const state = await counts(database)
      assert.equal(state.credits, 0)
      assert.equal(state.publications, 4)
      assert.equal(state.open, 1)
      const result = (await database.query('SELECT result FROM showing_room_runs')).rows[0].result
      assert.equal(result.count.valid_ballots.length, 0)
      assert.equal(result.count.winners.length, 0)
      assert.match((await database.query('SELECT body FROM notes WHERE id=$1', [outcome.countNoteId])).rows[0].body,
        /no winner and no credit/i)
    })
  }

  await t.test('closing with an empty queue finishes the count and leaves a persistent skipped marker', async () => {
    await reset()
    await seedContest(database)
    await database.query("UPDATE showing_room_contests SET state='cancelled' WHERE id=2")
    assert.equal((await runShowingRoomClose(sql)).status, 'completed')
    assert.deepEqual(await counts(database), {
      credits: 2, units: '2000000', publications: 3, note_events: 3, runs: 1, queued: 0, open: 0,
    })
    assert.deepEqual((await database.query('SELECT late,skipped FROM showing_room_runs')).rows, [{ late: false, skipped: true }])
  })

  await t.test('a progressing database clock crossing after the final run update rolls back and publishes one late report', async () => {
    await reset()
    await seedContest(database)
    await database.query(`CREATE SEQUENCE final_deadline_seen;
      CREATE FUNCTION cross_final_deadline() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.completed_at IS NOT NULL AND NOT NEW.late THEN
          PERFORM nextval('final_deadline_seen');
          PERFORM pg_sleep(greatest(0,extract(epoch FROM TIMESTAMPTZ '2026-11-09 16:00Z'-showing_test_clock()))+0.05);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER cross_final_deadline AFTER UPDATE ON showing_room_runs
        FOR EACH ROW EXECUTE FUNCTION cross_final_deadline()`)
    await setClock('2026-11-09T15:59:55.000Z')
    const outcome = await runShowingRoomClose(sql)
    assert.equal(outcome.status, 'late')
    assert.deepEqual((await database.query('SELECT last_value,is_called FROM final_deadline_seen')).rows,
      [{ last_value: '1', is_called: true }], 'the normal attempt reached its final update before the real clock crossed')
    assert.deepEqual(await counts(database), {
      credits: 2, units: '2000000', publications: 3, note_events: 3, runs: 1, queued: 1, open: 0,
    })
    const gazette = (await database.query('SELECT created_at,body FROM notes WHERE id=$1', [outcome.gazetteNoteId])).rows[0]
    assert.ok(gazette.created_at.getTime() >= Date.parse('2026-11-09T16:00:00.000Z'))
    assert.match(gazette.body, /late/i)
    assert.deepEqual(await runShowingRoomClose(sql), outcome)
  })

  for (const stage of ['credit', 'note', 'event', 'queue', 'completion'] as const) {
    for (const timing of ['BEFORE', 'AFTER'] as const) {
      await t.test(`${timing.toLowerCase()} ${stage} failure rolls back awards, notes, links, events, queue and run`, async () => {
        await reset()
        await seedContest(database)
        const tables = { credit: 'city_credit_entries', note: 'notes', event: 'events',
          queue: 'showing_room_contests', completion: 'showing_room_runs' }
        const operation = stage === 'queue' || stage === 'completion' ? 'UPDATE' : 'INSERT'
        const condition = stage === 'queue' ? "NEW.state='open' AND OLD.state='queued'"
          : stage === 'completion' ? 'NEW.completed_at IS NOT NULL'
            : stage === 'credit' ? 'NEW.resident_id=12' : stage === 'event' ? "NEW.kind='note'" : 'NEW.author_id=1'
        await database.query(`CREATE FUNCTION injected_run_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF ${condition} THEN RAISE EXCEPTION 'synthetic ${stage} failure'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER injected_run_failure ${timing} ${operation} ON ${tables[stage]}
          FOR EACH ROW EXECUTE FUNCTION injected_run_failure()`)
        await assert.rejects(runShowingRoomClose(sql), /retry the same Monday slot/)
        assert.deepEqual(await counts(database), {
          credits: 0, units: '0', publications: 0, note_events: 0, runs: 0, queued: 1, open: 1,
        })
        assert.equal((await database.query('SELECT count(*)::integer AS count FROM notes')).rows[0].count, 4)
        assert.equal((await database.query('SELECT failure_code FROM showing_room_control')).rows[0].failure_code, 'unavailable')
        await database.query(`DROP TRIGGER injected_run_failure ON ${tables[stage]}`)
        assert.equal((await runShowingRoomClose(sql)).status, 'completed')
        assert.equal((await database.query('SELECT failure_code FROM showing_room_control')).rows[0].failure_code, null)
      })
    }
  }

  await t.test('failure before commit leaves the contest retryable with no partial public act', async () => {
    await reset()
    await seedContest(database)
    failBeforeCommit = true
    await assert.rejects(runShowingRoomClose(sql), /retry the same Monday slot/)
    assert.deepEqual(await counts(database), {
      credits: 0, units: '0', publications: 0, note_events: 0, runs: 0, queued: 1, open: 1,
    })
    assert.equal((await runShowingRoomClose(sql)).status, 'completed')
  })

  await t.test('a later closing contest waits without consuming the current slot', async () => {
    await reset()
    await seedContest(database, '2026-11-16T15:00:00.000Z')
    assert.equal((await runShowingRoomClose(sql)).status, 'waiting')
    assert.equal((await counts(database)).runs, 0)
    assert.equal((await counts(database)).open, 1)
  })

  for (const room of [438, 454, 3]) {
    await t.test(`closed publication room ${room} refuses the whole count and records founder attention`, async () => {
      await reset()
      await seedContest(database)
      if (room === 3) await database.query('UPDATE showing_room_control SET square_announcement=TRUE WHERE id=1')
      // Rehearse existing Gazette state drift only in this disposable database.
      // Its ordinary room guard refuses a founder attempting this change.
      if (room === 454) await database.query('ALTER TABLE places DISABLE TRIGGER gazette_submission_room_lifecycle')
      await database.query('UPDATE places SET open_to_notes=FALSE WHERE id=$1', [room])
      if (room === 454) await database.query('ALTER TABLE places ENABLE TRIGGER gazette_submission_room_lifecycle')
      const code = room === 438 ? 'room_unavailable' : room === 454 ? 'gazette_unavailable' : 'square_unavailable'
      await assert.rejects(runShowingRoomClose(sql), (error: unknown) =>
        (error as { code?: string }).code === code)
      assert.deepEqual(await counts(database), {
        credits: 0, units: '0', publications: 0, note_events: 0, runs: 0, queued: 1, open: 1,
      })
      assert.equal((await database.query('SELECT failure_code FROM showing_room_control')).rows[0].failure_code, code)
    })
  }

  await t.test('an enabled square announcement is one linked public founder note', async () => {
    await reset()
    await seedContest(database)
    await database.query('UPDATE showing_room_control SET square_announcement=TRUE WHERE id=1')
    assert.equal((await runShowingRoomClose(sql)).status, 'completed')
    assert.equal((await counts(database)).publications, 5)
    assert.equal((await counts(database)).note_events, 5)
    const square = (await database.query(`SELECT note.author_id,note.walk_to_read
      FROM showing_room_publications publication JOIN notes note ON note.id=publication.note_id
      WHERE publication.purpose='square' AND note.place_id=3`)).rows
    assert.deepEqual(square, [{ author_id: 1, walk_to_read: false }])
  })

  await t.test('an existing award with different terms requires founder review before any public result', async () => {
    await reset()
    await seedContest(database)
    const { issueCityFeeCredit } = await import('../../src/city-credit.ts')
    await issueCityFeeCredit({ query: management.query }, { founderId: 1, residentId: 11,
      sourceKey: 'showing-room-q11-2026-11-09-r11', reason: 'A different original award.' })
    await assert.rejects(runShowingRoomClose(sql), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'award_review')
      assert.match((error as Error).message, /original source key and recipient/)
      return true
    })
    assert.deepEqual(await counts(database), {
      credits: 1, units: '1000000', publications: 0, note_events: 0, runs: 0, queued: 1, open: 1,
    })
    assert.equal((await database.query('SELECT failure_code FROM showing_room_control')).rows[0].failure_code, 'award_review')
  })

  await t.test('the frozen database count preserves submillisecond entry order before note IDs', async () => {
    await reset()
    await seedContest(database, SLOT, { ballot: 'VOTE #106, #102' })
    await database.query(`UPDATE showing_room_control SET enabled=FALSE WHERE id=1;
      INSERT INTO notes(id,place_id,author_id,body,created_at) VALUES
        (106,438,11,'ENTRY Newest title\nNewest entry.', '2026-11-05 15:00:00.000200Z'),
        (107,438,11,'ENTRY Earlier title\nEarlier entry.', '2026-11-05 15:00:00.000100Z');
      SELECT setval(pg_get_serial_sequence('notes','id'),107);
      UPDATE showing_room_control SET enabled=TRUE WHERE id=1`)
    assert.equal((await runShowingRoomClose(sql)).status, 'completed')
    const count = (await database.query('SELECT result FROM showing_room_runs')).rows[0].result.count
    assert.deepEqual(count.entries.map((entry: { id: number }) => entry.id).sort(), [102, 106])
    assert.equal(count.valid_ballots.length, 1)
    assert.equal((await counts(database)).credits, 2)
  })

  await t.test('founder resident reservation precedes retry and room locks for deferred activity writes', async t => {
    await reset()
    await seedContest(database)
    databaseErrors = []
    const residentHeld = Promise.withResolvers<void>()
    const continueOrdinary = Promise.withResolvers<void>()
    const runnerStarted = Promise.withResolvers<void>()
    const continueRunner = Promise.withResolvers<void>()
    let ordinaryStarted = false
    let runnerRetryBeforeOrdinary = false
    beforeQuery = async (text, values) => {
      if (ordinaryStarted && text.includes('pg_advisory_xact_lock')
        && values[0] === 524128260 && !text.includes('$1::integer,$2::integer')) continueRunner.resolve()
    }
    afterQuery = async (text, values) => {
      if (!text.includes('$1::integer,$2::integer')) return
      if (values[0] === 524128265) runnerStarted.resolve()
      if (values[0] === 524128260) {
        runnerRetryBeforeOrdinary = !ordinaryStarted
        await continueRunner.promise
      }
    }
    const ordinary = withEngineTransaction(sql, async transaction => {
      await transaction`SELECT id FROM residents WHERE id=1 FOR NO KEY UPDATE`
      residentHeld.resolve()
      await continueOrdinary.promise
      ordinaryStarted = true
      return runTalkNoteAction({ placeId: 438, residentId: 1, residentHandle: 'founder',
        text: 'An ordinary founder note beside the scheduled count.' }, transaction)
    }).then(value => ({ value }), error => ({ error }))
    let closing: ReturnType<typeof runShowingRoomClose> | undefined
    try {
      await residentHeld.promise
      closing = runShowingRoomClose(sql)
      const observedClosing = closing.then(value => ({ value }), error => ({ error }))
      await runnerStarted.promise
      await delay(75)
      continueOrdinary.resolve()
      const [talk, close] = await Promise.all([ordinary, observedClosing])
      t.diagnostic(JSON.stringify({ runnerRetryBeforeOrdinary, databaseErrors }))
      assert.ok('value' in talk && talk.value.ok, 'the ordinary founder note must commit')
      assert.ok('value' in close && close.value.status === 'completed', 'the count and its deferred resident write must commit')
      assert.equal(runnerRetryBeforeOrdinary, false, 'reserve the founder resident before its retry lock')
      assert.deepEqual(databaseErrors, [])
      assert.equal((await database.query('SELECT notes_today FROM residents WHERE id=1')).rows[0].notes_today, 1)
      assert.equal((await counts(database)).publications, 4)
      assert.equal((await database.query(`SELECT last_public_action_at=
        (SELECT max(at) FROM events WHERE actor='founder' AND kind='note') AS stamped
        FROM residents WHERE id=1`)).rows[0].stamped, true)
    } finally {
      continueOrdinary.resolve()
      continueRunner.resolve()
      beforeQuery = undefined
      afterQuery = undefined
      await ordinary
      await closing?.catch(() => undefined)
    }
  })

  for (const target of ['law_place', 'event_first'] as const) {
    await t.test(`ordinary ${target} talk law and weekly count complete without a reverse lock order`, async t => {
      await reset()
      await seedContest(database)
      databaseErrors = []
      await database.query(`INSERT INTO traits(id,name,description,recipe,coiner_id)
        VALUES(90,'showing-talk-law','Synthetic talk law.',$1::jsonb,1)`,
      [JSON.stringify({ talk: target === 'law_place'
        ? [{ effect: 'label', target, label: 'ordinary-spoken', seconds: 60 }]
        : [{ effect: 'wait', seconds: 60, then: [{ effect: 'label', target: 'actor', label: 'ordinary-later' }] }] })])
      await database.query(`INSERT INTO place_law_changes(place_id,trait_id,actor_id,change_type,position)
        VALUES(438,90,1,'add',0)`)
      const ordinaryLocked = Promise.withResolvers<void>()
      const continueOrdinary = Promise.withResolvers<void>()
      const admissionTaken = Promise.withResolvers<void>()
      const admissionAttempted = Promise.withResolvers<void>()
      let paused = false
      let ordinaryAdmissionFirst = false
      beforeQuery = async (text, values) => {
        if (paused && text.includes('pg_advisory_xact_lock') && values[0] === ADMISSION_LOCK) {
          admissionAttempted.resolve()
        }
      }
      afterQuery = async (text, values) => {
        if (text.includes('pg_advisory_xact_lock') && values[0] === ADMISSION_LOCK) {
          if (paused) admissionTaken.resolve()
          else ordinaryAdmissionFirst = true
        }
        const takesPriorLock = target === 'law_place'
          ? text.includes('WITH RECURSIVE tree') && text.includes('FOR NO KEY UPDATE OF place')
          : text.includes('INSERT INTO events')
        if (!paused && takesPriorLock) {
          paused = true
          ordinaryLocked.resolve()
          await continueOrdinary.promise
        }
      }
      const ordinary = runTalkNoteAction({ placeId: 438, residentId: 13, residentHandle: 'voter',
        text: `An ordinary note under the ${target} law.` }, sql)
        .then(value => ({ value }), error => ({ error }))
      let closing: ReturnType<typeof runShowingRoomClose> | undefined
      try {
        await ordinaryLocked.promise
        closing = runShowingRoomClose(sql)
        const observedClosing = closing.then(value => ({ value }), error => ({ error }))
        await admissionAttempted.promise
        if (ordinaryAdmissionFirst) {
          const deadline = Date.now() + 1_000
          let waiting = false
          while (!waiting && Date.now() < deadline) {
            waiting = (await database.query(`SELECT EXISTS (
              SELECT 1 FROM pg_locks WHERE locktype='advisory'
                AND classid=$1 AND objid=438 AND NOT granted
            ) AS waiting`, [ADMISSION_LOCK])).rows[0].waiting
            if (!waiting) await delay(10)
          }
          assert.equal(waiting, true, 'the runner must reach and wait for ordinary admission')
        } else {
          await admissionTaken.promise
        }
        continueOrdinary.resolve()
        const [talk, close] = await Promise.all([ordinary, observedClosing])
        t.diagnostic(JSON.stringify({ target, databaseErrors }))
        assert.ok('value' in talk && talk.value.ok, 'the ordinary note and its law must commit')
        assert.ok('value' in close && close.value.status === 'completed', 'the scheduled count must commit beside the note')
        assert.deepEqual(databaseErrors, [], 'neither writer may deadlock or time out')
        assert.equal((await counts(database)).credits, 2)
        assert.equal((await counts(database)).publications, 4)
        assert.equal((await database.query("SELECT count(*)::integer AS count FROM notes WHERE body LIKE 'An ordinary note under the %'")).rows[0].count, 1)
      } finally {
        continueOrdinary.resolve()
        beforeQuery = undefined
        afterQuery = undefined
        await ordinary
        await closing?.catch(() => undefined)
      }
    })
  }

  await t.test('a room 438 note commits its deferred activity stamp while the runner waits for admission', async t => {
    await reset()
    await seedContest(database)
    databaseErrors = []
    const noteWritten = Promise.withResolvers<void>()
    const continueNote = Promise.withResolvers<void>()
    afterQuery = async text => {
      if (text.includes('note-action:create')) {
        noteWritten.resolve()
        await continueNote.promise
      }
    }
    const ordinary = runTalkNoteAction({ placeId: 438, residentId: 13, residentHandle: 'voter',
      text: 'An ordinary note with its stored public activity.' }, sql)
      .then(value => ({ value }), error => ({ error }))
    let closing: ReturnType<typeof runShowingRoomClose> | undefined
    try {
      await noteWritten.promise
      assert.equal((await database.query('SELECT last_public_action_at FROM residents WHERE id=13')).rows[0].last_public_action_at, null)
      closing = runShowingRoomClose(sql)
      const observedClosing = closing.then(value => ({ value }), error => ({ error }))
      let waiting = false
      for (let tries = 0; tries < 100 && !waiting; tries += 1) {
        waiting = (await database.query(`SELECT EXISTS (SELECT 1 FROM pg_locks
          WHERE locktype='advisory' AND classid=$1 AND objid=438 AND NOT granted) AS waiting`, [ADMISSION_LOCK])).rows[0].waiting
        if (!waiting) await delay(10)
      }
      assert.equal(waiting, true, 'the runner must wait while the note event and its activity stamp are uncommitted')
      continueNote.resolve()
      const [talk, close] = await Promise.all([ordinary, observedClosing])
      t.diagnostic(JSON.stringify({ activityNoteRace: true, databaseErrors }))
      assert.ok('value' in talk && talk.value.ok, 'the note and its activity stamp must commit')
      assert.ok('value' in close && close.value.status === 'completed', 'the count and its activity stamps must commit')
      assert.deepEqual(databaseErrors, [])
      assert.equal((await database.query(`SELECT resident.last_public_action_at=event.at AS stamped
        FROM residents resident JOIN events event ON event.actor=resident.handle AND event.kind='note'
        WHERE resident.id=13`)).rows[0].stamped, true)
      assert.equal((await database.query(`SELECT place.last_public_action_at=
        (SELECT max(at) FROM events WHERE kind='note' AND (detail->>'place_id')::integer=place.id) AS stamped
        FROM places place WHERE id=438`)).rows[0].stamped, true)
    } finally {
      continueNote.resolve()
      afterQuery = undefined
      await ordinary
      await closing?.catch(() => undefined)
    }
  })

  await t.test('the Gazette printer and runner reserve room 454 before the weekly print lock', async t => {
    await reset()
    await seedContest(database)
    databaseErrors = []
    const printerRoomHeld = Promise.withResolvers<void>()
    const continuePrinter = Promise.withResolvers<void>()
    let runnerWeeklyBeforeRooms = false
    let runnerRoomsHeld = false
    afterQuery = async (text, values) => {
      if (text.includes('SELECT id FROM places WHERE id = $1::integer FOR NO KEY UPDATE')) {
        printerRoomHeld.resolve()
        await continuePrinter.promise
      }
      if (text.includes('WITH RECURSIVE tree') && text.includes('FOR NO KEY UPDATE OF place')) runnerRoomsHeld = true
      if (text.includes('$1::integer,$2::integer') && values[0] === 524128261) {
        runnerWeeklyBeforeRooms = !runnerRoomsHeld
      }
    }
    const printing = printGazetteIssuesDue(sql).then(value => ({ value }), error => ({ error }))
    let closing: ReturnType<typeof runShowingRoomClose> | undefined
    try {
      await printerRoomHeld.promise
      closing = runShowingRoomClose(sql)
      const observedClosing = closing.then(value => ({ value }), error => ({ error }))
      let waiting = false
      for (let tries = 0; tries < 100 && !waiting; tries += 1) {
        waiting = (await database.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE pid<>pg_backend_pid() AND wait_event_type='Lock'
            AND (query LIKE '%WITH RECURSIVE tree%' OR query LIKE '%SELECT place.id,place.owner_id%')) AS waiting`)).rows[0].waiting
        if (!waiting) await delay(10)
      }
      assert.equal(waiting, true, 'the runner must wait for the printer room reservation')
      continuePrinter.resolve()
      const [printed, close] = await Promise.all([printing, observedClosing])
      t.diagnostic(JSON.stringify({ runnerWeeklyBeforeRooms, databaseErrors }))
      assert.ok('value' in printed && printed.value.length > 0, 'the Gazette printer must commit')
      assert.ok('value' in close && close.value.status === 'completed', 'the count must commit after the printer')
      assert.equal(runnerWeeklyBeforeRooms, false, 'room 454 precedes the weekly print lock')
      assert.deepEqual(databaseErrors, [])
      assert.equal((await counts(database)).publications, 4)
    } finally {
      continuePrinter.resolve()
      afterQuery = undefined
      await printing
      await closing?.catch(() => undefined)
    }
  })
})
