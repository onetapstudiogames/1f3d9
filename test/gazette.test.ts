import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  GAZETTE_FIRST_PRINT_AT,
  GAZETTE_ROOM_ID,
  GAZETTE_SUBMISSIONS_PER_CYCLE,
  GAZETTE_WITHDRAWAL_COMMAND,
  gazetteCycleFor,
  gazetteIssueHeader,
  gazettePrintSlotsDue,
  gazetteWithdrawalNotice,
} from '../src/gazette.ts'
import {
  GAZETTE_ROOM_PROTECTED_ERROR,
  gazetteRoomLifecycleRefusal,
} from '../src/gazette-room.ts'

test('Gazette policy constants name the approved room, cap, and first print', () => {
  assert.equal(GAZETTE_ROOM_ID, 454)
  assert.equal(GAZETTE_SUBMISSIONS_PER_CYCLE, 3)
  assert.equal(GAZETTE_FIRST_PRINT_AT, '2026-08-31T16:00:00.000Z')
  assert.equal(GAZETTE_WITHDRAWAL_COMMAND, 'WITHDRAW #<your-note-id>')
})

test('withdrawal notices are fixed public records, not resident-controlled copy', () => {
  assert.equal(
    gazetteWithdrawalNotice(9223),
    'note #9223, withdrawn by its author before the tick',
  )
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => gazetteWithdrawalNotice(invalid), /positive integer/iu)
  }
})

test('the protected-room constraint keeps every write path caller-worded', () => {
  for (const constraint of [
    'gazette_submission_room_lifecycle',
    'gazette_submission_room_laws',
    'gazette_submission_room_children',
    'gazette_submission_room_things',
  ]) {
    assert.equal(
      gazetteRoomLifecycleRefusal({ sourceError: { constraint } }),
      GAZETTE_ROOM_PROTECTED_ERROR,
      constraint,
    )
  }
  assert.match(GAZETTE_ROOM_PROTECTED_ERROR, /local laws/iu)
  assert.match(GAZETTE_ROOM_PROTECTED_ERROR, /child places/iu)
  assert.match(GAZETTE_ROOM_PROTECTED_ERROR, /things/iu)
  assert.equal(gazetteRoomLifecycleRefusal({ constraint: 'another_constraint' }), null)
})

test('submission weeks are half-open Monday 16:00 UTC print cycles', () => {
  assert.deepEqual(gazetteCycleFor('2026-08-24T16:00:00.000Z'), {
    startsAt: '2026-08-24T16:00:00.000Z',
    endsAt: '2026-08-31T16:00:00.000Z',
  })
  assert.deepEqual(gazetteCycleFor('2026-08-31T15:59:59.999Z'), {
    startsAt: '2026-08-24T16:00:00.000Z',
    endsAt: '2026-08-31T16:00:00.000Z',
  })
  assert.deepEqual(gazetteCycleFor('2026-08-31T16:00:00.000Z'), {
    startsAt: '2026-08-31T16:00:00.000Z',
    endsAt: '2026-09-07T16:00:00.000Z',
  })
})

test('the printer starts on the exact first tick and catches up every missed week', () => {
  assert.deepEqual(gazettePrintSlotsDue(null, '2026-08-31T15:59:59.999Z'), [])
  assert.deepEqual(gazettePrintSlotsDue(null, '2026-08-31T16:00:00.000Z'), [
    { issueNumber: 1, scheduledFor: '2026-08-31T16:00:00.000Z' },
  ])
  assert.deepEqual(
    gazettePrintSlotsDue('2026-08-31T16:00:00.000Z', '2026-09-14T18:30:00.000Z'),
    [
      { issueNumber: 2, scheduledFor: '2026-09-07T16:00:00.000Z' },
      { issueNumber: 3, scheduledFor: '2026-09-14T16:00:00.000Z' },
    ],
  )
  assert.throws(
    () => gazettePrintSlotsDue('2026-09-07T16:00:00.001Z', '2026-09-14T16:00:00.000Z'),
    /Monday 16:00 UTC print slot/u,
  )
})

test('the printer checks canonical room activation after locking and before any archive write', () => {
  const source = readFileSync(new URL('../src/gazette.ts', import.meta.url), 'utf8')
  assert.match(
    source,
    /pg_advisory_xact_lock[\s\S]*gazette_submission_room_is_open\(\)[\s\S]*INSERT INTO events/iu,
  )
})

test('every issue freezes the verbatim, attribution, and non-deletion provenance promise', () => {
  assert.equal(
    gazetteIssueHeader(1, GAZETTE_FIRST_PRINT_AT),
    [
      'THE GAZETTE — ISSUE 1',
      'Automatic weekly print for Monday, 31 August 2026 at 16:00 UTC.',
      'Source: ordinary notes submitted in the Gazette submission room, place #454.',
      'Entries follow oldest first and preserve each source note verbatim with its resident, note ID, and time, unless its author withdrew it strictly before the print tick.',
      'A withdrawn submission keeps its place and spent weekly slot but prints only: note #<note-id>, withdrawn by its author before the tick.',
      'Printing consumes a submission by permanently assigning its note ID to this issue; the source note is never edited or deleted, and is never moved or copied.',
      'No AI editor, ranking, approval, or selection is used. Moderation may hide public body display but never changes issue membership.',
    ].join('\n'),
  )
})

test('the printer excludes withdrawal command notes without removing their target submissions', () => {
  const source = readFileSync(new URL('../src/gazette.ts', import.meta.url), 'utf8')
  assert.match(
    source,
    /FROM notes note[\s\S]*gazette_withdrawals[\s\S]*command_note_id\s*=\s*note\.id/iu,
  )
  assert.doesNotMatch(
    source,
    /gazette_withdrawals[\s\S]*target_note_id\s*=\s*note\.id[\s\S]*WHERE[\s\S]*IS NULL/iu,
    'a withdrawn target must remain eligible for permanent issue membership',
  )
})
