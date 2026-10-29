import { CommitOutcomeUnknownError, lockPlaceRowsTopDown, withEngineTransaction, type TaggedSql } from './engine.ts'
import { countShowingRoom, type ShowingRoomCount, type ShowingRoomNote } from './showing-room-count.ts'
import { issueShowingRoomAwards, ShowingRoomAwardError } from './showing-room-awards.ts'
import { publishShowingRoomNotes, type ShowingRoomPublication } from './showing-room-publications.ts'
import { latestShowingRoomSlot, parseShowingRoomSlot, showingRoomSchedule } from './showing-room-schedule.ts'
import type { ShowingResultCopy } from './showing-room-copy.ts'
import { isoTimestamp } from './timestamp.ts'

export type ShowingRoomRunResult = Readonly<{
  status: 'disabled' | 'paused' | 'waiting' | 'opened' | 'completed' | 'empty' | 'late'
  runId: number | null
  slot?: string | null
  countNoteId?: number | null
  nextRulesNoteId?: number | null
  gazetteNoteId?: number | null
}>

export class ShowingRoomRunError extends Error {
  readonly code: string
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ShowingRoomRunError'
    this.code = code
  }
}

class DeadlineCrossed extends Error {}
type Row = Readonly<Record<string, unknown>>
type Query = (text: string, values?: readonly unknown[]) => Promise<readonly Row[]>
const SERVICE_LOCK = 524128265
const LOCKS = [[524128260, 1], [524128266, 438]] as const
const UNAVAILABLE = 'the showing room count could not finish; retry the same Monday slot or ask founder #1 to review showing room status'

function queryFor(database: TaggedSql): Query {
  if (!database.query) throw new ShowingRoomRunError('unavailable', UNAVAILABLE)
  return database.query as Query
}

function instant(value: unknown): string {
  const text = isoTimestamp(value)
  if (!text) throw new ShowingRoomRunError('unavailable', UNAVAILABLE)
  return text
}

async function clock(query: Query): Promise<string> {
  return instant((await query('SELECT clock_timestamp() AS now'))[0]?.now)
}

async function lockedControl(query: Query): Promise<Row> {
  await query("SET LOCAL lock_timeout='2s'")
  await query("SET LOCAL statement_timeout='15s'")
  await query('SELECT pg_advisory_xact_lock($1::integer,$2::integer)', [SERVICE_LOCK, 438])
  await query('SELECT id FROM residents WHERE id=1 FOR NO KEY UPDATE')
  for (const [namespace, key] of LOCKS) {
    await query('SELECT pg_advisory_xact_lock($1::integer,$2::integer)', [namespace, key])
  }
  const rows = await query(`SELECT control.*,showing_room_guards_ready() AS ready
    FROM showing_room_control control WHERE id=1 FOR UPDATE`)
  if (!rows[0] || rows[0].ready !== true) throw new ShowingRoomRunError('unavailable', UNAVAILABLE)
  return rows[0]
}

async function replay(query: Query, slot: string): Promise<ShowingRoomRunResult | null> {
  const row = (await query(`SELECT result FROM showing_room_runs
    WHERE slot_at=$1 AND completed_at IS NOT NULL`, [slot]))[0]
  if (!row) return null
  const result = row.result as { outcome?: ShowingRoomRunResult }
  if (!result?.outcome || !result.outcome.runId) throw new ShowingRoomRunError('unavailable', UNAVAILABLE)
  return result.outcome
}

async function lockRooms(database: TaggedSql, query: Query, square: boolean): Promise<void> {
  const ids = square ? [3, 438, 454] : [438, 454]
  await lockPlaceRowsTopDown(database, { placeIds: ids, lawChainFrom: null, carryDestinationId: null })
  await query('SELECT pg_advisory_xact_lock($1::integer,$2::integer)', [524128261, 454])
  const rooms = await query(`SELECT place.id,place.owner_id,place.open_to_notes,place.quiet,place.retired_at,
    coalesce((SELECT action FROM moderation_actions WHERE target_type='place' AND target_id=place.id
      ORDER BY created_at DESC,id DESC LIMIT 1),'restore')='remove' AS removed
    FROM places place WHERE id=ANY($1::integer[]) ORDER BY place.id`, [ids])
  const showing = rooms.find(room => Number(room.id) === 438)
  const open = (room: Row | undefined) => room && room.open_to_notes === true
    && room.quiet === false && room.retired_at == null && room.removed === false
  if (!open(showing) || Number(showing!.owner_id) !== 1) {
    throw new ShowingRoomRunError('room_unavailable',
      'the showing room must be an open public room owned by founder #1; restore its room state before retrying this count')
  }
  if (!open(rooms.find(room => Number(room.id) === 454))
    || (await query('SELECT gazette_submission_room_is_open() AS open'))[0]?.open !== true) {
    throw new ShowingRoomRunError('gazette_unavailable',
      'the Gazette submission room must be open before the showing room can publish its report; restore it before retrying this count')
  }
  if (square && !open(rooms.find(room => Number(room.id) === 3))) {
    throw new ShowingRoomRunError('square_unavailable',
      'the square must be an open public room for the requested announcement; restore it or turn off the showing room square announcement')
  }
  await query('SELECT place_id FROM place_reading_totals WHERE place_id=ANY($1::integer[]) ORDER BY place_id FOR UPDATE', [ids])
}

async function readContest(query: Query): Promise<Row | null> {
  return (await query(`SELECT contest.*,
    to_char(opened_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact_opened_at
    FROM showing_room_contests contest WHERE state='open' FOR UPDATE`))[0] ?? null
}

async function freezeCount(query: Query, contest: Row): Promise<ShowingRoomCount> {
  if (contest.rule_version !== 'showing-room-v1' || Number(contest.question_number) < 11
    || Number(contest.rules_note_id) === 40225) {
    throw new ShowingRoomRunError('manual_contest',
      'only a managed showing room contest can be counted here; question ten and other manual contests stay with the founder')
  }
  const rows = await query(`SELECT note.id,note.place_id,note.author_id,author.handle AS author,note.body,
    to_char(note.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
    note.walk_to_read,coalesce((SELECT action FROM moderation_actions
      WHERE target_type='note' AND target_id=note.id ORDER BY created_at DESC,id DESC LIMIT 1),'restore')='remove' AS removed
    FROM notes note JOIN residents author ON author.id=note.author_id
    WHERE note.place_id=438 AND note.created_at>=$1 AND note.created_at<$2
    ORDER BY note.created_at,note.id`, [contest.opened_at, contest.vote_closes_at])
  return countShowingRoom({ rule_version: 'showing-room-v1', rules_note_id: Number(contest.rules_note_id),
    opens_at: String(contest.exact_opened_at), entries_close_at: instant(contest.entry_closes_at),
    votes_close_at: instant(contest.vote_closes_at) }, rows as unknown as ShowingRoomNote[])
}

function publicResult(contest: Row, count: ShowingRoomCount, late: boolean): ShowingResultCopy {
  const entry = (item: ShowingRoomCount['entries'][number]) => ({ noteId: item.id,
    residentId: item.author_id, handle: item.author, votes: item.votes })
  return { questionNumber: Number(contest.question_number), rulesNoteId: Number(contest.rules_note_id),
    entryCount: count.entries.length, ballotCount: count.valid_ballots.length,
    selectionCount: count.selection_count, entries: count.entries.map(entry), winners: count.winners.map(entry),
    excludedBallots: count.ballot_records.filter(item => item.selected && item.reason !== null)
      .map(item => ({ noteId: item.id, reason: item.reason! })),
    withdrawals: count.withdrawals.filter(item => item.accepted && item.entry_id !== null)
      .map(item => ({ noteId: item.id, entryNoteId: item.entry_id! })), late }
}

function publicationId(publications: readonly ShowingRoomPublication[], purpose: ShowingRoomPublication['purpose']): number | null {
  return publications.find(item => item.purpose === purpose && item.part === 1)?.noteId ?? null
}

async function nextQuestionNumber(query: Query, control: Row): Promise<number> {
  return Number((await query(`SELECT greatest(coalesce(max(question_number),0),$1::integer-1)+1 AS number
    FROM showing_room_contests`, [control.first_question_number]))[0]!.number)
}

async function completeRun(query: Query, input: Readonly<{
  runId: number; slot: string; attemptSlot: string; contest: Row | null; queued: Row | null;
  count: ShowingRoomCount | null; credits: unknown; publications: readonly ShowingRoomPublication[];
  status: ShowingRoomRunResult['status']; late: boolean;
}>): Promise<ShowingRoomRunResult> {
  const outcome: ShowingRoomRunResult = { status: input.status, runId: input.runId, slot: input.slot,
    countNoteId: publicationId(input.publications, 'count'), nextRulesNoteId: publicationId(input.publications, 'next_rules'),
    gazetteNoteId: publicationId(input.publications, 'gazette') }
  const result = JSON.stringify({ outcome, count: input.count, credits: input.credits, publications: input.publications })
  await query(`UPDATE showing_room_runs SET result=$2::jsonb,next_contest_id=$3,late=$4,skipped=$5,
    completed_at=clock_timestamp() WHERE id=$1`, [input.runId, result, input.queued?.id ?? null, input.late, input.queued === null])
  if (input.slot !== input.attemptSlot) {
    await query(`INSERT INTO showing_room_runs(slot_at,recovery_run_id,result,late,skipped,completed_at)
      VALUES($1,$2,$3::jsonb,TRUE,TRUE,clock_timestamp())`, [input.attemptSlot, input.runId, result])
  }
  await query('UPDATE showing_room_control SET last_attempted_slot=$1,failure_code=NULL WHERE id=1', [input.attemptSlot])
  return outcome
}

async function performRun(database: TaggedSql, query: Query, control: Row, slot: string,
  now: string, forceLate: boolean): Promise<ShowingRoomRunResult> {
  if (!parseShowingRoomSlot(slot)) throw new ShowingRoomRunError('unavailable', UNAVAILABLE)
  const cutoff = new Date(Date.parse(slot) + 3_600_000).toISOString()
  await lockRooms(database, query, control.square_announcement === true)
  const contest = await readContest(query)
  if (contest && instant(contest.vote_closes_at) > slot) return { status: 'waiting', runId: null, slot }
  const older = contest !== null && instant(contest.vote_closes_at) < slot
  const late = forceLate || older || now >= cutoff
  const next = (await query(`SELECT * FROM showing_room_contests WHERE state='queued'
    ORDER BY created_at,id LIMIT 1 FOR UPDATE`))[0] ?? null
  const queued = late ? null : next
  const schedule = queued ? showingRoomSchedule(slot) : null
  if (queued && !schedule) throw new ShowingRoomRunError('unavailable', UNAVAILABLE)
  const count = contest ? await freezeCount(query, contest) : null
  const questionNumber = queued ? await nextQuestionNumber(query, control) : null
  if (!late && await clock(query) >= cutoff) throw new DeadlineCrossed()
  const originalSlot = contest ? instant(contest.vote_closes_at) : slot
  const runId = Number((await query(`INSERT INTO showing_room_runs(slot_at,contest_id,contest_slot_at)
    VALUES($1,$2,$3) RETURNING id`, [originalSlot, contest?.id ?? null, contest ? originalSlot : null]))[0]!.id)
  const credits = contest && count ? await issueShowingRoomAwards({ query }, {
    state: String(contest.state), question_number: Number(contest.question_number), vote_closes_at: originalSlot,
  }, count) : []
  if (contest) await query("UPDATE showing_room_contests SET state='completed' WHERE id=$1", [contest.id])
  const publications = contest || queued ? await publishShowingRoomNotes(database, {
    runId, result: contest && count ? publicResult(contest, count, late) : null,
    nextQuestion: queued ? { questionNumber: questionNumber!, title: String(queued.title), prompt: String(queued.prompt),
      entryClosesAt: schedule!.entries_close_at, voteClosesAt: schedule!.votes_close_at } : null,
    square: control.square_announcement === true,
  }) : []
  const gazette = publications.find(item => item.purpose === 'gazette')
  if (!late && gazette && Date.parse(gazette.createdAt) >= Date.parse(cutoff)) throw new DeadlineCrossed()
  if (queued) {
    const rules = publications.find(item => item.purpose === 'next_rules')!
    await query(`UPDATE showing_room_contests SET state='open',rule_version='showing-room-v1',question_number=$2,
      rules_note_id=$3,opened_at=$4,entry_closes_at=$5,vote_closes_at=$6 WHERE id=$1`,
    [queued.id, questionNumber, rules.noteId, rules.createdAt, schedule!.entries_close_at, schedule!.votes_close_at])
  }
  const status = contest ? late ? 'late' : 'completed' : queued ? 'opened' : next ? 'late' : 'empty'
  const outcome = await completeRun(query, { runId, slot: originalSlot, attemptSlot: slot, contest, queued, count,
    credits, publications, status, late: status === 'empty' ? false : late })
  if (!late && await clock(query) >= cutoff) throw new DeadlineCrossed()
  return outcome
}

async function attempt(database: TaggedSql, forceLate: boolean,
  rememberSlot: (slot: string) => void): Promise<ShowingRoomRunResult> {
  return withEngineTransaction(database, async (transaction, atomic) => {
    if (!atomic) throw new ShowingRoomRunError('unavailable', UNAVAILABLE)
    const query = queryFor(transaction)
    const control = await lockedControl(query)
    if (control.enabled !== true) return { status: 'disabled', runId: null }
    const now = await clock(query)
    const slot = latestShowingRoomSlot(now)
    if (!slot || slot < instant(control.first_slot_at)) return { status: 'waiting', runId: null, slot }
    rememberSlot(slot)
    const completed = await replay(query, slot)
    if (completed) return completed
    if (control.paused === true) return { status: 'paused', runId: null, slot }
    return performRun(transaction, query, control, slot, now, forceLate)
  })
}

async function recordFailure(database: TaggedSql, slot: string | null, code: string): Promise<void> {
  if (!slot) return
  await withEngineTransaction(database, async transaction => {
    const query = queryFor(transaction)
    const locked = (await query('SELECT pg_try_advisory_xact_lock($1::integer,438) AS locked', [SERVICE_LOCK]))[0]?.locked
    if (locked !== true || await replay(query, slot)) return
    await query('UPDATE showing_room_control SET last_attempted_slot=$1,failure_code=$2 WHERE id=1', [slot, code])
  })
}

export async function runShowingRoomClose(database: TaggedSql): Promise<ShowingRoomRunResult> {
  let slot: string | null = null
  let forceLate = false
  for (let retry = 0; retry < 3; retry += 1) {
    try {
      return await attempt(database, forceLate, value => { slot = value })
    } catch (error) {
      if (error instanceof DeadlineCrossed && !forceLate) { forceLate = true; continue }
      if (error instanceof CommitOutcomeUnknownError && retry < 2) continue
      const failure = error instanceof ShowingRoomRunError ? error
        : error instanceof ShowingRoomAwardError ? new ShowingRoomRunError(error.code, error.message, { cause: error })
          : new ShowingRoomRunError('unavailable', UNAVAILABLE, { cause: error })
      try { await recordFailure(database, slot, failure.code) }
      catch (attentionError) {
        throw new ShowingRoomRunError(failure.code, failure.message, { cause: attentionError })
      }
      throw failure
    }
  }
  throw new ShowingRoomRunError('unavailable', UNAVAILABLE)
}
