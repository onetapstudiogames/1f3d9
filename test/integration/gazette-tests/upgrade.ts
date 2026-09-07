import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import { runTalkNoteAction } from '../../../src/note-action.ts'
import { activationDdl, gazetteRuntime, migrationDdl, preGazetteSchemaDdl, taggedFor, withdrawalActivationDdl, withdrawalMigrationDdl } from '../../helpers/gazette-fixtures/postgres.ts'

export async function registerUpgradeTests(
  database: Pool,
): Promise<void> {
  await database.query(preGazetteSchemaDdl)
  await database.query(`
    INSERT INTO residents (id, handle, model, secret_hash)
    VALUES
      (1, 'gazette-founder', 'integration-test', repeat('1', 64)),
      (2, 'gazette-upgrade-author', 'integration-test', repeat('2', 64)),
      (6, 'gazette-upgrade-near-miss', 'integration-test', repeat('6', 64)),
      (7, 'gazette-upgrade-prose', 'integration-test', repeat('7', 64)),
      (8, 'gazette-upgrade-active', 'integration-test', repeat('8', 64));

    INSERT INTO places (
      id, parent_id, place_kind, name, description, owner_id,
      open_to_building, open_to_things, open_to_notes
    )
    SELECT
      2, world.id, 'continent', 'gazette test continent',
      'Integration-only parent for the Gazette room.', 1,
      FALSE, FALSE, FALSE
    FROM places world
    WHERE world.place_kind = 'world';

    INSERT INTO places (
      id, parent_id, place_kind, name, description, purpose, owner_id,
      open_to_building, open_to_things, open_to_notes
    ) VALUES (
      454, 2, 'place', 'the gazette submission room',
      'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
      '', 1, FALSE, FALSE, FALSE
    );

    INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
    VALUES
      (1, 454, 454),
      (2, 454, 454),
      (6, 454, 454),
      (7, 454, 454),
      (8, 454, 454);
  `)

  const roomStateQuery = `
    SELECT gazette_submission_room_state(place) AS state,
      gazette_submission_room_is_open() AS submissions_open
    FROM places place
    WHERE place.id = 454
  `
  await database.query(migrationDdl)
  const installedRoomState = (await database.query(roomStateQuery)).rows[0]
  assert.deepEqual(installedRoomState, { state: 'closed', submissions_open: false })

  await database.query(migrationDdl)
  assert.deepEqual((await database.query(roomStateQuery)).rows[0], installedRoomState)
  assert.deepEqual((await database.query(`
    SELECT trigger.tgname AS trigger_name
    FROM pg_trigger trigger
    WHERE trigger.tgrelid = 'notes'::regclass
      AND trigger.tgname = 'gazette_note_submission_limit'
      AND trigger.tgenabled IN ('O', 'A')
      AND NOT trigger.tgisinternal
  `)).rows, [{ trigger_name: 'gazette_note_submission_limit' }])

  await database.query(activationDdl)
  const target = (await database.query<{ id: number; created_at: Date }>(`
    INSERT INTO notes (place_id, author_id, body)
    VALUES (454, 2, 'Submission filed before withdrawal support.')
    RETURNING id, created_at
  `)).rows[0]!
  const cycle = gazetteRuntime.gazetteCycleFor(target.created_at)
  const sql = taggedFor(database)
  const submit = (residentId: number, residentHandle: string, text: string) => (
    runTalkNoteAction({ placeId: 454, residentId, residentHandle, text }, sql)
  )

  await database.query(withdrawalMigrationDdl)
  assert.deepEqual((await database.query(`
    SELECT gazette_submission_room_state(place) AS state,
      gazette_submission_room_is_open() AS submissions_open,
      gazette_withdrawals_are_open() AS withdrawals_open
    FROM places place WHERE id = 454
  `)).rows[0], { state: 'open', submissions_open: true, withdrawals_open: false })
  const dormantExact = await submit(
    2,
    'gazette-upgrade-author',
    `WITHDRAW #${target.id}`,
  )
  const dormantNearMiss = await submit(
    6,
    'gazette-upgrade-near-miss',
    'WITHDRAW #12x',
  )
  const dormantProse = await submit(
    7,
    'gazette-upgrade-prose',
    'WITHDRAW my nomination for mayor, a poem',
  )
  for (const result of [dormantExact, dormantNearMiss, dormantProse]) {
    assert.equal(result.ok, true, 'every body is an ordinary submission while dormant')
    if (!result.ok) return
    assert.equal(result.replayed, false)
    assert.equal(result.gazetteWithdrawal, undefined)
  }
  if (!dormantExact.ok || !dormantNearMiss.ok || !dormantProse.ok) return
  const dormantPrinted = await gazetteRuntime.printGazetteIssuesDue!(
    sql,
    cycle.startsAt,
  )
  assert.ok(dormantPrinted.length >= 1, 'the already-open printer remains live')
  assert.deepEqual((await database.query(`
    SELECT
      (SELECT count(*)::integer FROM gazette_issue_entries
        WHERE note_id = ANY($1::integer[])) AS current_entries,
      (SELECT count(*)::integer FROM gazette_withdrawals) AS withdrawals
  `, [[target.id, dormantExact.note.id, dormantNearMiss.note.id, dormantProse.note.id]])).rows[0], {
    current_entries: 0,
    withdrawals: 0,
  })

  await database.query(
    'ALTER TABLE gazette_issue_entries ENABLE REPLICA TRIGGER gazette_issue_entry_source',
  )
  try {
    await assert.rejects(
      database.query(withdrawalActivationDdl),
      /withdrawal ledger and guards must be installed before withdrawals can open/iu,
    )
  } finally {
    await database.query(
      'ALTER TABLE gazette_issue_entries ENABLE TRIGGER gazette_issue_entry_source',
    )
  }
  await database.query(withdrawalActivationDdl)
  assert.deepEqual((await database.query(`
    SELECT gazette_submission_room_state(place) AS state,
      gazette_submission_room_is_open() AS submissions_open,
      gazette_withdrawals_are_open() AS withdrawals_open
    FROM places place WHERE id = 454
  `)).rows[0], {
    state: 'withdrawals_open',
    submissions_open: true,
    withdrawals_open: true,
  })

  await assert.rejects(
    database.query(`
      INSERT INTO gazette_withdrawals (target_note_id, command_note_id, withdrawn_at)
      SELECT $1, command.id, command.created_at
      FROM notes command
      WHERE command.id = $2
    `, [target.id, dormantExact.note.id]),
    (error: unknown) => {
      assert.equal(
        (error as { constraint?: string }).constraint,
        'gazette_withdrawal_command_not_note_insert',
      )
      return true
    },
    'a dormant ordinary note can never be retroactively reclassified as a command',
  )

  assert.deepEqual(
    await submit(6, 'gazette-upgrade-near-miss', 'WITHDRAW #12x'),
    {
      ok: false,
      status: 400,
      error: 'Gazette withdrawal must be exactly WITHDRAW #<your-note-id>',
    },
    'a dormant near-miss replay must be reclassified after activation',
  )
  assert.deepEqual(
    await submit(8, 'gazette-upgrade-active', `WITHDRAW#${target.id}`),
    {
      ok: false,
      status: 400,
      error: 'Gazette withdrawal must be exactly WITHDRAW #<your-note-id>',
    },
  )
  assert.deepEqual(
    await submit(7, 'gazette-upgrade-prose', 'WITHDRAW my nomination for mayor, a poem'),
    { ...dormantProse, replayed: true },
    'ordinary prose keeps the normal five-minute replay rule after activation',
  )
  const activeProse = await submit(
    8,
    'gazette-upgrade-active',
    'WITHDRAW my nomination for mayor, a poem in a second voice',
  )
  assert.equal(activeProse.ok, true)
  if (!activeProse.ok) return
  assert.equal(activeProse.replayed, false)
  assert.equal(activeProse.gazetteWithdrawal, undefined)

  const commandResult = await submit(2, 'gazette-upgrade-author', `WITHDRAW #${target.id}`)
  assert.equal(commandResult.ok, true)
  if (!commandResult.ok) return
  assert.equal(commandResult.replayed, false)
  assert.notEqual(commandResult.note.id, dormantExact.note.id)
  const command = commandResult.note
  assert.deepEqual((await database.query(`
    SELECT target_note_id, command_note_id
    FROM gazette_withdrawals
    WHERE target_note_id = $1
  `, [target.id])).rows[0], {
    target_note_id: target.id,
    command_note_id: command.id,
  })
  await gazetteRuntime.printGazetteIssuesDue!(sql, cycle.endsAt)
  const printedIssue = (await database.query<{ issue_number: number }>(`
    SELECT issue_number FROM gazette_issues WHERE scheduled_for = $1
  `, [cycle.endsAt])).rows[0]!
  assert.deepEqual((await database.query(`
    SELECT entry.ordinal, entry.note_id
    FROM gazette_issue_entries entry
    WHERE entry.note_id = ANY($1::integer[])
    ORDER BY entry.ordinal
  `, [[
    target.id,
    dormantExact.note.id,
    dormantNearMiss.note.id,
    dormantProse.note.id,
    activeProse.note.id,
  ]])).rows, [
    { ordinal: 1, note_id: target.id },
    { ordinal: 2, note_id: dormantExact.note.id },
    { ordinal: 3, note_id: dormantNearMiss.note.id },
    { ordinal: 4, note_id: dormantProse.note.id },
    { ordinal: 5, note_id: activeProse.note.id },
  ])
  assert.deepEqual(
    await submit(2, 'gazette-upgrade-author', `WITHDRAW #${dormantExact.note.id}`),
    {
      ok: false,
      status: 409,
      error: `Gazette submission note #${dormantExact.note.id} already printed in issue #${printedIssue.issue_number} and cannot be withdrawn; choose another active submission because printing is permanent`,
    },
    'the dormant exact-looking note remained a printable ordinary submission',
  )
}
