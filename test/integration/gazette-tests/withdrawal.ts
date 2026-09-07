import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import type { TaggedSql } from '../../../src/engine.ts'
import { setEngineTransactionRunnerForTests } from '../../../src/engine.ts'
import { gazetteRuntime, gazetteStoreRuntime, iso } from '../../helpers/gazette-fixtures/postgres.ts'

export async function registerWithdrawalTests(
  database: Pool,
  sql: TaggedSql,
  publicDatabase: Readonly<{ query(text: string, params?: readonly unknown[]): Promise<unknown> }>,
  submit: (residentId: number, residentHandle: string, text: string) => ReturnType<typeof import('../../../src/note-action.ts').runTalkNoteAction>,
  transactionRunner: NonNullable<Parameters<typeof setEngineTransactionRunnerForTests>[0]>,
): Promise<void> {
  assert.deepEqual(
    await gazetteStoreRuntime.readGazetteSubmissionRoomState!(publicDatabase),
    { submissionsOpen: true, withdrawalsOpen: true },
  )
  const target = await submit(2, 'gazette-author', 'Draft that needs one correction.')
  assert.equal(target.ok, true)
  if (!target.ok) return
  const targetId = target.note.id

  const selfTargetId = Number((await database.query<{ id: number }>(`
    SELECT last_value::integer + 1 AS id FROM notes_id_seq
  `)).rows[0]!.id)
  const selfTargetBody = `WITHDRAW #${selfTargetId}`
  assert.deepEqual(await submit(2, 'gazette-author', selfTargetBody), {
    ok: false,
    status: 404,
    error: `Gazette submission note #${selfTargetId} was not found in room #454; freshly browse view=gazette and use a current note id from submission room #454`,
  })
  assert.deepEqual((await database.query(`
    SELECT
      (SELECT count(*)::integer FROM notes WHERE id = $1) AS command_notes,
      (SELECT count(*)::integer FROM gazette_withdrawals
        WHERE target_note_id = $1 OR command_note_id = $1) AS withdrawals
  `, [selfTargetId])).rows[0], { command_notes: 0, withdrawals: 0 })

  assert.deepEqual(await submit(2, 'gazette-author', 'WITHDRAW #0'), {
    ok: false,
    status: 400,
    error: 'Gazette withdrawal must be exactly WITHDRAW #<your-note-id>',
  })
  assert.deepEqual(await submit(2, 'gazette-author', `WITHDRAW#${targetId}`), {
    ok: false,
    status: 400,
    error: 'Gazette withdrawal must be exactly WITHDRAW #<your-note-id>',
  })
  assert.deepEqual(await submit(2, 'gazette-author', 'WITHDRAW #2147483647'), {
    ok: false,
    status: 404,
    error: 'Gazette submission note #2147483647 was not found in room #454; freshly browse view=gazette and use a current note id from submission room #454',
  })
  assert.deepEqual(await submit(1, 'gazette-founder', `WITHDRAW #${targetId}`), {
    ok: false,
    status: 403,
    error: `only the author may withdraw Gazette submission note #${targetId}; you are not its author`,
  })

  const withdrawn = await submit(2, 'gazette-author', `WITHDRAW #${targetId}`)
  assert.equal(withdrawn.ok, true)
  if (!withdrawn.ok) return
  const withdrawal = (withdrawn as typeof withdrawn & {
    gazetteWithdrawal?: Readonly<{
      target_note_id: number
      command_note_id: number
      withdrawn_at: string
      notice: string
    }>
  }).gazetteWithdrawal
  assert.deepEqual(withdrawal, {
    target_note_id: targetId,
    command_note_id: withdrawn.note.id,
    withdrawn_at: iso(withdrawn.note.created_at),
    notice: `note #${targetId}, withdrawn by its author before the tick`,
  })
  assert.deepEqual(
    await submit(2, 'gazette-author', `WITHDRAW #${targetId}`),
    { ...withdrawn, replayed: true },
  )
  let alreadyWithdrawnError: unknown
  try {
    await database.query(`
      INSERT INTO notes (place_id, author_id, body)
      VALUES (454, 2, $1)
    `, [`WITHDRAW #${targetId}`])
    assert.fail('a second withdrawal must be refused')
  } catch (error) {
    assert.equal(
      (error as { constraint?: string }).constraint,
      'gazette_withdrawal_already_withdrawn',
    )
    alreadyWithdrawnError = error
  }
  setEngineTransactionRunnerForTests(async () => { throw alreadyWithdrawnError })
  try {
    assert.deepEqual(await submit(2, 'gazette-author', `WITHDRAW #${targetId}`), {
      ok: false,
      status: 409,
      error: `Gazette submission note #${targetId} was already withdrawn by its author; choose another active submission because withdrawal is permanent`,
    })
  } finally {
    setEngineTransactionRunnerForTests(transactionRunner)
  }

  const second = await submit(2, 'gazette-author', 'Second kept submission.')
  const third = await submit(2, 'gazette-author', 'Third kept submission.')
  assert.equal(second.ok, true)
  assert.equal(third.ok, true)
  assert.equal((await submit(2, 'gazette-author', 'Fourth submission must stay refused.')).ok, false)
  const cycle = gazetteRuntime.gazetteCycleFor(new Date())
  assert.deepEqual((await database.query(`
    SELECT resident.notes_today,
      count(note.id) FILTER (
        WHERE note.place_id = 454
          AND note.created_at >= $1
          AND note.created_at < $2
          AND NOT EXISTS (
            SELECT 1 FROM gazette_withdrawals withdrawal
            WHERE withdrawal.command_note_id = note.id
          )
      )::integer AS weekly_submissions,
      count(note.id) FILTER (WHERE note.place_id = 454)::integer AS room_notes,
      (SELECT count(*)::integer FROM gazette_withdrawals) AS withdrawals
    FROM residents resident
    LEFT JOIN notes note ON note.author_id = resident.id
    WHERE resident.id = 2
    GROUP BY resident.id
  `, [cycle.startsAt, cycle.endsAt])).rows[0], {
    notes_today: 4,
    weekly_submissions: 3,
    room_notes: 4,
    withdrawals: 1,
  })

  assert.equal(typeof gazetteRuntime.printGazetteIssuesDue, 'function')
  await gazetteRuntime.printGazetteIssuesDue!(sql, cycle.endsAt)
  const stored = (await database.query<{
    issue_number: number
    ordinal: number
    note_id: number
  }>(`
    SELECT entry.issue_number, entry.ordinal, entry.note_id
    FROM gazette_issue_entries entry
    WHERE entry.note_id = $1
  `, [targetId])).rows[0]!
  assert.equal(stored.ordinal, 1)
  assert.equal((await database.query(`
    SELECT count(*)::integer AS count
    FROM gazette_issue_entries
    WHERE note_id = $1
  `, [withdrawn.note.id])).rows[0].count, 0)

  const publicIssue = await gazetteStoreRuntime.readGazetteIssue!(publicDatabase, {
    issueNumber: stored.issue_number,
    afterOrdinal: null,
    limit: 200,
  })
  assert.deepEqual(publicIssue?.entries[0], {
    ordinal: 1,
    note_id: targetId,
    author_id: 2,
    author: 'gazette-author',
    body: `note #${targetId}, withdrawn by its author before the tick`,
    created_at: iso(target.note.created_at),
    withdrawn: true,
    withdrawal_note_id: withdrawn.note.id,
    withdrawn_at: iso(withdrawn.note.created_at),
  })

  await database.query(`
    INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
    VALUES ('note', $1, 'remove', 1, 'withdrawal notice precedence')
  `, [targetId])
  assert.equal(
    (await gazetteStoreRuntime.readGazetteIssue!(publicDatabase, {
      issueNumber: stored.issue_number, afterOrdinal: null, limit: 200,
    }))?.entries[0]?.body,
    `note #${targetId}, withdrawn by its author before the tick`,
  )
  await database.query(`
    INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
    VALUES ('note', $1, 'restore', 1, 'withdrawal notice remains permanent')
  `, [targetId])
  assert.equal(
    (await gazetteStoreRuntime.readGazetteIssue!(publicDatabase, {
      issueNumber: stored.issue_number, afterOrdinal: null, limit: 200,
    }))?.entries[0]?.body,
    `note #${targetId}, withdrawn by its author before the tick`,
  )

  await assert.rejects(
    database.query('UPDATE gazette_withdrawals SET withdrawn_at = withdrawn_at WHERE target_note_id = $1', [targetId]),
    /append-only|history/iu,
  )
  await assert.rejects(
    database.query('DELETE FROM gazette_withdrawals WHERE target_note_id = $1', [targetId]),
    /append-only|history/iu,
  )
  await assert.rejects(
    database.query('TRUNCATE gazette_withdrawals'),
    /append-only|history/iu,
  )
  await assert.rejects(
    database.query('TRUNCATE gazette_issue_entries'),
    /append-only|history/iu,
  )
  await assert.rejects(
    database.query('TRUNCATE gazette_issues CASCADE'),
    /append-only|history/iu,
  )
  assert.equal(
    (await gazetteStoreRuntime.readGazetteIssue!(publicDatabase, {
      issueNumber: stored.issue_number, afterOrdinal: null, limit: 200,
    }))?.entries[0]?.body,
    `note #${targetId}, withdrawn by its author before the tick`,
  )
  if (!second.ok) return
  assert.deepEqual(await submit(2, 'gazette-author', `WITHDRAW #${second.note.id}`), {
    ok: false,
    status: 409,
    error: `Gazette submission note #${second.note.id} already printed in issue #${stored.issue_number} and cannot be withdrawn; choose another active submission because printing is permanent`,
  })

  await database.query('ALTER TABLE notes DISABLE TRIGGER gazette_note_submission_limit')
  let passedTickTargetId = 0
  try {
    passedTickTargetId = (await database.query<{ id: number }>(`
      INSERT INTO notes (place_id, author_id, body, created_at)
      VALUES (454, 2, 'Printer-delayed historical submission.', $1::timestamptz - interval '1 second')
      RETURNING id
    `, [cycle.startsAt])).rows[0]!.id
  } finally {
    await database.query('ALTER TABLE notes ENABLE TRIGGER gazette_note_submission_limit')
  }
  assert.deepEqual(await submit(2, 'gazette-author', `WITHDRAW #${passedTickTargetId}`), {
    ok: false,
    status: 409,
    error: `Gazette submission note #${passedTickTargetId} can be withdrawn only strictly before ${cycle.startsAt}; that print tick has passed, so choose another active submission`,
  })
}
