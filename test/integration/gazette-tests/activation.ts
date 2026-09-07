import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import type { TaggedSql } from '../../../src/engine.ts'
import { runTalkNoteAction } from '../../../src/note-action.ts'
import { activationDdl, assertGazetteRoomWriteRejected, gazetteRuntime, gazetteStoreRuntime, migrationDdl, withdrawalMigrationDdl } from '../../helpers/gazette-fixtures/postgres.ts'

export async function registerActivationTests(
  t: TestContext,
  database: Pool,
  sql: TaggedSql,
  publicDatabase: Readonly<{ query(text: string, params?: readonly unknown[]): Promise<unknown> }>,
): Promise<void> {
  await t.test('dormant migration and activation refuse every pre-feature dependency', async () => {
    await database.query(`
      INSERT INTO traits (name, description, coiner_id)
      VALUES ('gazette-dormant-guard', 'Dormant dependency refusal fixture.', 1)
    `)
    const cases = [
      {
        table: 'place_law_changes',
        trigger: 'gazette_submission_room_reject_laws',
        constraint: 'gazette_submission_room_laws',
        insert: `INSERT INTO place_law_changes
          (place_id, trait_id, actor_id, change_type, position)
          SELECT 454, id, 1, 'add', 0 FROM traits WHERE name = 'gazette-dormant-guard'`,
        cleanup: `DELETE FROM place_law_changes
          WHERE trait_id = (SELECT id FROM traits WHERE name = 'gazette-dormant-guard')`,
        extraCleanupTrigger: 'place_law_changes_append_only',
      },
      {
        table: 'places',
        trigger: 'gazette_submission_room_reject_child_places',
        constraint: 'gazette_submission_room_children',
        insert: `INSERT INTO places
          (id, parent_id, place_kind, name, description, owner_id,
            open_to_building, open_to_things, open_to_notes)
          VALUES (6100, 454, 'place', 'dormant Gazette child', '', 1, FALSE, FALSE, FALSE)`,
        cleanup: 'UPDATE places SET parent_id = 2 WHERE id = 6100',
        extraCleanupTrigger: null,
      },
      {
        table: 'things',
        trigger: 'gazette_submission_room_reject_things',
        constraint: 'gazette_submission_room_things',
        insert: `INSERT INTO things (id, place_id, name, body, owner_id, maker_id)
          VALUES (6100, 454, 'dormant Gazette thing', '', 1, 1)`,
        cleanup: 'UPDATE things SET place_id = 2 WHERE id = 6100',
        extraCleanupTrigger: null,
      },
    ] as const

    for (const fixture of cases) {
      await database.query(
        `ALTER TABLE ${fixture.table} DISABLE TRIGGER ${fixture.trigger}`,
      )
      await database.query(fixture.insert)
      await database.query(
        `ALTER TABLE ${fixture.table} ENABLE TRIGGER ${fixture.trigger}`,
      )

      await assert.rejects(database.query(activationDdl), /cannot open while it has local laws, child places, or things/iu)
      await assert.rejects(
        database.query(migrationDdl),
        (error: unknown) => {
          assert.equal((error as { constraint?: string }).constraint, fixture.constraint)
          return true
        },
      )

      await database.query(
        `ALTER TABLE ${fixture.table} DISABLE TRIGGER ${fixture.trigger}`,
      )
      if (fixture.extraCleanupTrigger) {
        await database.query(
          `ALTER TABLE ${fixture.table} DISABLE TRIGGER ${fixture.extraCleanupTrigger}`,
        )
      }
      await database.query(fixture.cleanup)
      if (fixture.extraCleanupTrigger) {
        await database.query(
          `ALTER TABLE ${fixture.table} ENABLE TRIGGER ${fixture.extraCleanupTrigger}`,
        )
      }
      await database.query(
        `ALTER TABLE ${fixture.table} ENABLE TRIGGER ${fixture.trigger}`,
      )
    }
  })

  await database.query(migrationDdl)
  await database.query(withdrawalMigrationDdl)
  await database.query(`
    WITH new_trait AS (
      INSERT INTO traits (name, description, recipe, coiner_id)
      VALUES (
        'gazette-race-marker',
        'Integration proof that rejected Gazette submissions roll back talk-law effects.',
        '{"talk":[{"effect":"label","target":"actor","label":"gazette-race-leak"}]}'::jsonb,
        1
      )
      RETURNING id
    )
    INSERT INTO place_law_changes (
      place_id, trait_id, actor_id, change_type, position
    )
    SELECT 2, id, 1, 'add', 0 FROM new_trait
  `)
  assert.deepEqual((await database.query(`
    SELECT
      has_table_privilege(
        'city_snapshot_export', 'city_snapshot.public_records', 'SELECT'
      ) AS v1,
      has_table_privilege(
        'city_snapshot_export', 'city_snapshot.public_records_v2', 'SELECT'
      ) AS v2
  `)).rows[0], { v1: true, v2: true }, 'dormant rollout must keep old and new exporters readable')
  const readSubmissionRoomState = gazetteStoreRuntime.readGazetteSubmissionRoomState
  assert.equal(typeof readSubmissionRoomState, 'function')
  if (!readSubmissionRoomState) assert.fail('implement the public Gazette submission-room state')
  assert.deepEqual(
    await readSubmissionRoomState(publicDatabase),
    { submissionsOpen: false, withdrawalsOpen: false },
  )
  const stillClosed = (await database.query(`
    SELECT description, purpose, open_to_building, open_to_things, open_to_notes
    FROM places WHERE id = 454
  `)).rows[0]
  assert.deepEqual(stillClosed, {
    description: 'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
    purpose: '',
    open_to_building: false,
    open_to_things: false,
    open_to_notes: false,
  })
  assert.equal((await database.query(`
    SELECT count(*)::integer AS count
    FROM events
    WHERE kind = 'place_edited'
      AND detail @> '{"place_id":454,"gazette_submission_room_opened":true}'::jsonb
  `)).rows[0].count, 0, 'schema installation must not open submissions')

  await t.test('generic writes cannot edit, trade, transfer, delete, or prematurely open the closed shell', async () => {
    for (const statement of [
      "UPDATE places SET description = 'generic place edit' WHERE id = 454",
      "UPDATE places SET purpose = 'generic repurpose' WHERE id = 454",
      'UPDATE places SET open_to_notes = TRUE WHERE id = 454',
      'UPDATE places SET open_to_building = TRUE WHERE id = 454',
      'UPDATE places SET open_to_things = TRUE WHERE id = 454',
      "UPDATE places SET name = 'renamed submission room' WHERE id = 454",
      'UPDATE places SET parent_id = 1 WHERE id = 454',
      'UPDATE places SET owner_id = 2 WHERE id = 454',
      'UPDATE places SET active_offer_id = 900 WHERE id = 454',
      'UPDATE places SET front_matter_thing_ids = ARRAY[1]::integer[] WHERE id = 454',
      'DELETE FROM places WHERE id = 454',
    ]) await assertGazetteRoomWriteRejected(database, statement)

    await database.query('UPDATE places SET description = description WHERE id = 454')
    assert.deepEqual((await database.query(`
      SELECT gazette_submission_room_state(place) AS state,
        gazette_submission_room_is_open() AS submissions_open
      FROM places place WHERE id = 454
    `)).rows[0], { state: 'closed', submissions_open: false })
  })

  assert.equal(typeof gazetteRuntime.printGazetteIssuesDue, 'function')
  await assert.rejects(
    gazetteRuntime.printGazetteIssuesDue!(sql, '2026-08-31T16:00:00.000Z'),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 409)
      assert.match((error as Error).message, /room #454 is not in its verified open state/iu)
      return true
    },
  )
  assert.deepEqual((await database.query(`
    SELECT
      (SELECT count(*)::integer FROM gazette_issues) AS issues,
      (SELECT count(*)::integer FROM gazette_issue_entries) AS entries,
      (SELECT count(*)::integer FROM events WHERE kind = 'gazette_printed') AS print_events
  `)).rows[0], { issues: 0, entries: 0, print_events: 0 })

  await database.query('ALTER TABLE notes DISABLE TRIGGER gazette_note_submission_limit')
  let preFeatureNoteId = 0
  try {
    preFeatureNoteId = (await database.query<{ id: number }>(`
      INSERT INTO notes (place_id, author_id, body, created_at)
      VALUES (454, 1, 'note left before Gazette rules existed', TIMESTAMPTZ '2026-08-20 12:00:00+00')
      RETURNING id
    `)).rows[0]!.id
  } finally {
    await database.query('ALTER TABLE notes ENABLE TRIGGER gazette_note_submission_limit')
  }
  await assert.rejects(
    database.query(activationDdl),
    /contains notes from before the verified submission rules/iu,
  )
  assert.deepEqual((await database.query(`
    SELECT open_to_notes,
      (SELECT count(*)::integer FROM events
        WHERE kind = 'place_edited'
          AND detail @> '{"place_id":454,"gazette_submission_room_opened":true}'::jsonb
      ) AS opening_events
    FROM places WHERE id = 454
  `)).rows[0], { open_to_notes: false, opening_events: 0 })
  await database.query('ALTER TABLE notes DISABLE TRIGGER notes_append_only')
  try {
    await database.query('DELETE FROM notes WHERE id = $1', [preFeatureNoteId])
  } finally {
    await database.query('ALTER TABLE notes ENABLE TRIGGER notes_append_only')
  }

  await assert.rejects(
    database.query(`
      INSERT INTO notes (place_id, author_id, body)
      VALUES (454, 1, 'raw founder write before activation')
    `),
    (error: unknown) => {
      assert.equal(
        (error as { constraint?: string }).constraint,
        'gazette_submission_room_closed',
      )
      return true
    },
  )

  assert.deepEqual(
    await runTalkNoteAction({
      placeId: 454,
      residentId: 1,
      residentHandle: 'gazette-founder',
      text: 'The founder must also wait.',
    }, sql),
    {
      ok: false,
      status: 409,
      error: 'Gazette submission room #454 is not open; read GET /api/gazette and submit only when submission_room.submissions_open is true',
    },
  )
  assert.deepEqual((await database.query(`
    SELECT resident.notes_today,
      (SELECT count(*)::integer FROM notes WHERE place_id = 454) AS notes,
      (SELECT count(*)::integer
        FROM active_labels
        WHERE target_type = 'resident'
          AND target_id = resident.id
          AND label = 'gazette-race-leak'
      ) AS leaked_law_effects
    FROM residents resident
    WHERE resident.id = 1
  `)).rows[0], { notes_today: 0, notes: 0, leaked_law_effects: 0 })

  await Promise.all([
    database.query(activationDdl),
    database.query(activationDdl),
  ])
  assert.deepEqual((await database.query(`
    SELECT
      has_table_privilege(
        'city_snapshot_export', 'city_snapshot.public_records', 'SELECT'
      ) AS v1,
      has_table_privilege(
        'city_snapshot_export', 'city_snapshot.public_records_v2', 'SELECT'
      ) AS v2
  `)).rows[0], { v1: false, v2: true }, 'exact-commit activation completes the v2 cutover')
  const opened = (await database.query(`
    SELECT description, purpose, open_to_building, open_to_things, open_to_notes
    FROM places WHERE id = 454
  `)).rows[0]
  assert.deepEqual(opened, {
    description: 'Leave a note here for The Gazette. Every Monday at 16:00 UTC, the automatic printer permanently assigns every unprinted note made before the cutoff to the next issue, verbatim with its author, note ID, and time. Printing never deletes, edits, moves, or copies the source note.',
    purpose: 'Residents may submit up to three notes per Gazette week (Monday 16:00 UTC to Monday 16:00 UTC); each submission also uses the ordinary daily note quota.',
    open_to_building: false,
    open_to_things: false,
    open_to_notes: true,
  })
  assert.deepEqual(
    await readSubmissionRoomState(publicDatabase),
    { submissionsOpen: true, withdrawalsOpen: false },
  )
  assert.equal((await database.query(`
    SELECT count(*)::integer AS count
    FROM events
    WHERE kind = 'place_edited'
      AND detail @> '{"place_id":454,"gazette_submission_room_opened":true}'::jsonb
  `)).rows[0].count, 1)

  await t.test('replica-only critical triggers close the live gate and block activation', async () => {
    const criticalTriggers = [
      ['notes', 'gazette_note_submission_limit'],
      ['places', 'gazette_submission_room_lifecycle'],
      ['places', 'gazette_submission_room_reject_child_places'],
      ['place_law_changes', 'gazette_submission_room_reject_laws'],
      ['things', 'gazette_submission_room_reject_things'],
    ] as const

    for (const [table, trigger] of criticalTriggers) {
      await database.query(`ALTER TABLE ${table} ENABLE REPLICA TRIGGER ${trigger}`)
      try {
        assert.equal((await database.query(
          'SELECT gazette_submission_room_is_open() AS submissions_open',
        )).rows[0].submissions_open, false, trigger)
        await assert.rejects(
          database.query(activationDdl),
          /must be installed before room #454 can open/iu,
          trigger,
        )
      } finally {
        await database.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
      }
      assert.equal((await database.query(
        'SELECT gazette_submission_room_is_open() AS submissions_open',
      )).rows[0].submissions_open, true, `${trigger}: restored`)
    }
  })

  await t.test('generic writes cannot change the verified-open room and the public gate proves every field', async () => {
    for (const statement of [
      "UPDATE places SET description = 'generic place edit' WHERE id = 454",
      "UPDATE places SET purpose = 'generic repurpose' WHERE id = 454",
      'UPDATE places SET open_to_notes = FALSE WHERE id = 454',
      'UPDATE places SET open_to_building = TRUE WHERE id = 454',
      'UPDATE places SET open_to_things = TRUE WHERE id = 454',
      "UPDATE places SET name = 'renamed submission room' WHERE id = 454",
      'UPDATE places SET parent_id = 1 WHERE id = 454',
      'UPDATE places SET owner_id = 2 WHERE id = 454',
      'UPDATE places SET active_offer_id = 901 WHERE id = 454',
      'UPDATE places SET front_matter_thing_ids = ARRAY[1]::integer[] WHERE id = 454',
      'DELETE FROM places WHERE id = 454',
    ]) await assertGazetteRoomWriteRejected(database, statement)

    await database.query('UPDATE places SET purpose = purpose WHERE id = 454')
    assert.deepEqual((await database.query(`
      SELECT gazette_submission_room_state(place) AS state,
        gazette_submission_room_is_open() AS submissions_open
      FROM places place WHERE id = 454
    `)).rows[0], { state: 'open', submissions_open: true })

    await database.query('ALTER TABLE places DISABLE TRIGGER gazette_submission_room_lifecycle')
    try {
      await database.query("UPDATE places SET description = 'forced drift proof' WHERE id = 454")
      assert.equal((await database.query(
        'SELECT gazette_submission_room_is_open() AS submissions_open',
      )).rows[0].submissions_open, false)
      assert.deepEqual(
        await readSubmissionRoomState(publicDatabase),
        { submissionsOpen: false, withdrawalsOpen: false },
      )
      await database.query(`
        UPDATE places SET description =
          'Leave a note here for The Gazette. Every Monday at 16:00 UTC, the automatic printer permanently assigns every unprinted note made before the cutoff to the next issue, verbatim with its author, note ID, and time. Printing never deletes, edits, moves, or copies the source note.'
        WHERE id = 454
      `)
    } finally {
      await database.query('ALTER TABLE places ENABLE TRIGGER gazette_submission_room_lifecycle')
    }
    assert.equal((await database.query(
      'SELECT gazette_submission_room_is_open() AS submissions_open',
    )).rows[0].submissions_open, true)
  })

  await database.query(`
    CREATE OR REPLACE FUNCTION enforce_gazette_submission_limit()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.place_id = 454 THEN
        RAISE EXCEPTION 'simulated closed-room enforcement race'
          USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_closed';
      END IF;
      RETURN NEW;
    END
    $$;
  `)
  assert.deepEqual(
    await runTalkNoteAction({
      placeId: 454,
      residentId: 1,
      residentHandle: 'gazette-founder',
      text: 'A trigger race must stay caller-safe.',
    }, sql),
    {
      ok: false,
      status: 409,
      error: 'Gazette submission room #454 is not open; read GET /api/gazette and submit only when submission_room.submissions_open is true',
    },
  )
  assert.deepEqual((await database.query(`
    SELECT resident.notes_today,
      (SELECT count(*)::integer FROM notes WHERE place_id = 454) AS notes,
      (SELECT count(*)::integer
        FROM active_labels
        WHERE target_type = 'resident'
          AND target_id = resident.id
          AND label = 'gazette-race-leak'
      ) AS leaked_law_effects
    FROM residents resident
    WHERE resident.id = 1
  `)).rows[0], { notes_today: 0, notes: 0, leaked_law_effects: 0 })

  assert.deepEqual((await database.query(`
    SELECT resolution.status, resolution.detail
    FROM action_runs run
    JOIN action_resolutions resolution ON resolution.action_run_id = run.id
    WHERE run.actor_id = 1
      AND run.action_name = 'talk'
      AND run.place_id = 454
    ORDER BY run.id DESC
    LIMIT 1
  `)).rows[0], {
    status: 'failed',
    detail: {
      error: 'Gazette submission room #454 is not open; read GET /api/gazette and submit only when submission_room.submissions_open is true',
    },
  })

  await database.query(`
    INSERT INTO place_law_changes (
      place_id, trait_id, actor_id, change_type, position
    )
    SELECT 2, id, 1, 'remove', NULL
    FROM traits
    WHERE name = 'gazette-race-marker'
  `)

  await database.query(withdrawalMigrationDdl)

  const openedSubmission = await runTalkNoteAction({
    placeId: 454,
    residentId: 1,
    residentHandle: 'gazette-founder',
    text: 'The room is now open.',
  }, sql)
  assert.equal(openedSubmission.ok, true)

  await database.query(activationDdl)
  assert.equal((await database.query(`
    SELECT count(*)::integer AS count
    FROM events
    WHERE kind = 'place_edited'
      AND detail @> '{"place_id":454,"gazette_submission_room_opened":true}'::jsonb
  `)).rows[0].count, 1, 'an idempotent rerun emits no second opening event')
}
