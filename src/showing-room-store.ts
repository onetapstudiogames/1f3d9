import type { ShowingRoomOperationResult } from './showing-room-routes.ts'
import { createHash } from 'node:crypto'
import { isoTimestamp } from './timestamp.ts'
import { renderShowingRules } from './showing-room-copy.ts'
import { showingRoomSchedule } from './showing-room-schedule.ts'

export interface ShowingRoomDatabase {
  query(text: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>
  transaction<T>(work: (database: Pick<ShowingRoomDatabase, 'query'>) => Promise<T>): Promise<T>
}

type QueryDatabase = Pick<ShowingRoomDatabase, 'query'>
type Row = Readonly<Record<string, unknown>>
type Add = Readonly<{ request_id: string; title: string; prompt: string }>
type Edit = Readonly<{ expected_revision: number; title?: string; prompt?: string; state?: 'cancelled' }>
const Q10_CLOSE = '2026-11-02T15:00:00.000Z'

function failure(status: 400 | 404 | 409 | 429 | 503, error: string): ShowingRoomOperationResult {
  return { ok: false, status, error }
}

function fingerprint(input: Readonly<Record<string, unknown>>): string {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)])) : value
  return createHash('sha256').update(JSON.stringify(stable(input))).digest('hex')
}

function contest(row: Row): Row {
  return { id: Number(row.id), title: row.title, prompt: row.prompt, state: row.state,
    revision: Number(row.revision), created_at: isoTimestamp(row.created_at),
    question_number: row.question_number == null ? null : Number(row.question_number),
    rules_note_id: row.rules_note_id == null ? null : Number(row.rules_note_id),
    entry_closes_at: isoTimestamp(row.entry_closes_at), vote_closes_at: isoTimestamp(row.vote_closes_at) }
}

export async function listShowingRoom(database: ShowingRoomDatabase, input: Readonly<{ before_id: number | null; before_run_id: number | null; limit: number }>): Promise<ShowingRoomOperationResult> {
  const [questions, runs] = await Promise.all([
    database.query(`/* showing:list-contests */ SELECT * FROM showing_room_contests
      WHERE ($1::bigint IS NULL OR id<$1) ORDER BY id DESC LIMIT $2`, [input.before_id, input.limit + 1]),
    database.query(`/* showing:list-runs */ SELECT run.id,run.slot_at,run.completed_at,run.late,run.skipped,
      run.contest_id,run.next_contest_id,run.recovery_run_id,
      (SELECT note_id FROM showing_room_publications WHERE run_id=run.id AND purpose='count' AND part=1) AS count_note_id
      FROM showing_room_runs run WHERE completed_at IS NOT NULL AND ($1::bigint IS NULL OR id<$1)
      ORDER BY id DESC LIMIT $2`, [input.before_run_id, input.limit + 1]),
  ])
  const selected = questions.slice(0, input.limit).map(contest)
  const selectedRuns = runs.slice(0, input.limit).map(row => ({ id: Number(row.id),
    slot_at: isoTimestamp(row.slot_at), completed_at: isoTimestamp(row.completed_at),
    late: row.late, skipped: row.skipped, contest_id: row.contest_id == null ? null : Number(row.contest_id),
    next_contest_id: row.next_contest_id == null ? null : Number(row.next_contest_id),
    recovery_run_id: row.recovery_run_id == null ? null : Number(row.recovery_run_id),
    count_note_id: row.count_note_id == null ? null : Number(row.count_note_id) }))
  return { ok: true, value: { contests: selected, runs: selectedRuns,
    has_more: questions.length > input.limit, next_before_id: questions.length > input.limit ? selected.at(-1)!.id : null,
    runs_have_more: runs.length > input.limit, next_before_run_id: runs.length > input.limit ? selectedRuns.at(-1)!.id : null } }
}

async function lockManagement(database: QueryDatabase): Promise<Row> {
  await database.query("SET LOCAL lock_timeout='2s'")
  await database.query("SET LOCAL statement_timeout='10s'")
  await database.query('SELECT pg_advisory_xact_lock($1::integer,$2::integer)', [524128265, 438])
  await database.query('SELECT id FROM residents WHERE id=1 FOR NO KEY UPDATE')
  for (const [namespace, key] of [[524128260, 1], [524128266, 438], [524128261, 454]]) {
    await database.query('SELECT pg_advisory_xact_lock($1::integer,$2::integer)', [namespace, key])
  }
  const rows = await database.query(`SELECT control.*,clock_timestamp() AS now,
    showing_room_guards_ready() AS ready FROM showing_room_control control WHERE id=1 FOR UPDATE`)
  if (!rows[0] || rows[0].ready !== true) throw new Error('showing room stores are not ready')
  return rows[0]
}

function limited(control: Row): ShowingRoomOperationResult | null {
  const start = isoTimestamp(control.management_window_start)
  const now = isoTimestamp(control.now)!
  const seconds = start === null ? 0 : Math.ceil((Date.parse(start) + 3_600_000 - Date.parse(now)) / 1000)
  return seconds > 0 && Number(control.management_writes) >= 60
    ? { ok: false, status: 429, retry_after: seconds, error: `60 showing room changes are allowed per hour; retry in ${seconds} seconds` } : null
}

async function recordWrite(database: QueryDatabase): Promise<void> {
  await database.query(`UPDATE showing_room_control SET
    management_writes=CASE WHEN management_window_start>clock_timestamp()-interval '1 hour' THEN management_writes+1 ELSE 1 END,
    management_window_start=CASE WHEN management_window_start>clock_timestamp()-interval '1 hour' THEN management_window_start ELSE clock_timestamp() END WHERE id=1`)
}

function rulesFit(title: string, prompt: string): boolean {
  try {
    // Reserve the longest grouped ordinal heading within the positive integer range.
    const text = renderShowingRules({ questionNumber: 1_777_777_777, title, prompt,
      entryClosesAt: '2026-11-07T15:00:00.000Z', voteClosesAt: '2026-11-09T15:00:00.000Z' })
    return text.length > 0 && Array.from(text).length <= 4000
  } catch {
    return false
  }
}

export async function addShowingRoomContest(database: ShowingRoomDatabase, input: Add): Promise<ShowingRoomOperationResult> {
  return database.transaction(async transaction => {
    const control = await lockManagement(transaction)
    const hash = fingerprint(input)
    const existing = (await transaction.query('SELECT * FROM showing_room_contests WHERE request_id=$1', [input.request_id]))[0]
    if (existing) return existing.request_hash === hash
      ? { ok: true, value: { contest: contest(existing), disposition: 'replayed' } }
      : failure(409, 'request_id already names different question text; use a new request_id')
    if (Object.hasOwn(control.control_requests as object, input.request_id)) return failure(409, 'request_id already names a showing room control request; use a new request_id')
    if (!rulesFit(input.title, input.prompt)) return failure(400, 'title and prompt make the published rules longer than 4000 characters; shorten the prompt')
    const limit = limited(control)
    if (limit) return limit
    const rows = await transaction.query(`INSERT INTO showing_room_contests(request_id,request_hash,title,prompt)
      VALUES($1,$2,$3,$4) RETURNING *`, [input.request_id, hash, input.title, input.prompt])
    await recordWrite(transaction)
    return { ok: true, created: true, value: { contest: contest(rows[0]!), disposition: 'created' } }
  })
}

export async function editShowingRoomContest(database: ShowingRoomDatabase, id: number, input: Edit): Promise<ShowingRoomOperationResult> {
  return database.transaction(async transaction => {
    const control = await lockManagement(transaction)
    const row = (await transaction.query('SELECT * FROM showing_room_contests WHERE id=$1 FOR UPDATE', [id]))[0]
    if (!row) return failure(404, 'the queued question was not found; read the backlog for its current id')
    if (row.state !== 'queued' || Number(row.revision) !== input.expected_revision) return failure(409, 'this question changed or opened; read the backlog before editing again')
    const title = input.title ?? String(row.title)
    const prompt = input.prompt ?? String(row.prompt)
    if (!rulesFit(title, prompt)) return failure(400, 'title and prompt make the published rules longer than 4000 characters; shorten the prompt')
    const limit = limited(control)
    if (limit) return limit
    const changed = await transaction.query(`UPDATE showing_room_contests SET title=$2,prompt=$3,
      state=$4,revision=revision+1 WHERE id=$1 RETURNING *`, [id, title, prompt, input.state ?? 'queued'])
    await recordWrite(transaction)
    return { ok: true, value: { contest: contest(changed[0]!) } }
  })
}

async function roomsReady(database: QueryDatabase): Promise<boolean> {
  const rows = await database.query(`SELECT gazette_submission_room_is_open() AND EXISTS(
    SELECT 1 FROM places place WHERE id=438 AND owner_id=1 AND open_to_notes AND NOT quiet AND retired_at IS NULL
    AND coalesce((SELECT action FROM moderation_actions WHERE target_type='place' AND target_id=438
      ORDER BY created_at DESC,id DESC LIMIT 1),'restore')<>'remove') AS ready`)
  return rows[0]?.ready === true
}

async function legacyVerified(database: QueryDatabase, legacy: Row, now: string): Promise<boolean> {
  if (now < Q10_CLOSE || legacy.count_note_id === 40225 || (legacy.winner_note_ids as number[]).includes(40225)) return false
  const ids = [...new Set([40225, Number(legacy.count_note_id), ...(legacy.winner_note_ids as number[])])]
  const rows = await database.query(`SELECT id,created_at FROM notes WHERE id=ANY($1::integer[])
    AND place_id=438 AND author_id=1 AND NOT walk_to_read
    AND coalesce((SELECT action FROM moderation_actions WHERE target_type='note' AND target_id=notes.id
      ORDER BY created_at DESC,id DESC LIMIT 1),'restore')<>'remove'`, [ids])
  if (rows.length !== ids.length || rows.some(row => Number(row.id) !== 40225
    && (isoTimestamp(row.created_at)! < Q10_CLOSE || isoTimestamp(row.created_at)! > now))) return false
  const rules = rows.find(row => Number(row.id) === 40225)
  if (isoTimestamp(rules?.created_at) !== '2026-10-26T16:00:42.833Z') return false
  const keys = legacy.credit_source_keys as string[]
  const credits = await database.query(`SELECT source_key FROM city_credit_entries WHERE source_key=ANY($1::text[])
    AND entry_kind='founder_issue' AND founder_id=1 AND amount_units=1000000
    AND created_at>=$2::timestamptz AND created_at<=$3::timestamptz`, [keys, Q10_CLOSE, now])
  return credits.length === keys.length
}

async function activate(database: QueryDatabase, control: Row, input: Row): Promise<ShowingRoomOperationResult | null> {
  if (control.enabled || control.activated_at == null || typeof control.activation_commit !== 'string') return failure(409, 'complete the verified deployment activation before choosing the first managed slot; an enabled service cannot be activated again')
  const schedule = showingRoomSchedule(String(input.first_slot))
  const now = isoTimestamp(control.now)!
  if (!schedule || schedule.gazette_cutoff_at <= now || schedule.slot < Q10_CLOSE) return failure(409, 'choose an upcoming Monday 15:00 UTC slot or the current Monday slot before its 16:00 UTC print cutoff')
  if (!await roomsReady(database)) return failure(409, 'the showing room and Gazette room must both be open public founder rooms before activation or resume')
  if (!await legacyVerified(database, input.manual_legacy as Row, now)) return failure(409, 'manual question ten needs its public founder count, winner notes and existing one-credit receipts before activation')
  await database.query(`INSERT INTO showing_room_contests(request_id,request_hash,title,prompt,state,rule_version,
    question_number,rules_note_id,opened_at,entry_closes_at,vote_closes_at)
    VALUES('manual-legacy/q10',$1,'THE HAUNTED NOTICEBOARD','Question ten remained a manual contest.',
      'manual-legacy','manual-q10',10,40225,'2026-10-26T16:00:42.833Z','2026-10-31T15:00:00Z','2026-11-02T15:00:00Z')`, [fingerprint(input.manual_legacy as Row)])
  await database.query(`UPDATE showing_room_control SET enabled=TRUE,paused=FALSE,first_slot_at=$1,
    first_question_number=$2,manual_legacy=$3::jsonb WHERE id=1`, [schedule.slot, input.first_question_number, JSON.stringify(input.manual_legacy)])
  return null
}

export async function controlShowingRoom(database: ShowingRoomDatabase, input: Row): Promise<ShowingRoomOperationResult> {
  return database.transaction(async transaction => {
    const control = await lockManagement(transaction)
    const requestId = String(input.request_id)
    const hash = fingerprint(input)
    const requests = control.control_requests as Record<string, { request_hash: string; result: ShowingRoomOperationResult }>
    const stored = Object.hasOwn(requests, requestId) ? requests[requestId] : undefined
    if (stored) return stored.request_hash === hash ? stored.result : failure(409, 'request_id already names different control choices; use a new request_id')
    if ((await transaction.query('SELECT id FROM showing_room_contests WHERE request_id=$1', [requestId])).length) return failure(409, 'request_id already names a showing room question; use a new request_id')
    const limit = limited(control)
    if (limit) return limit
    if (input.action === 'activate') {
      const rejection = await activate(transaction, control, input)
      if (rejection) return rejection
    } else if (input.action === 'square') {
      await transaction.query('UPDATE showing_room_control SET square_announcement=$1 WHERE id=1', [input.enabled])
    } else {
      if (!control.enabled || control.paused === (input.action === 'pause')) return failure(409, 'the showing room must be active and in the opposite pause state; read its current status before retrying')
      if (input.action === 'resume' && !await roomsReady(transaction)) return failure(409, 'the showing room and Gazette room must both be open public founder rooms before activation or resume')
      await transaction.query('UPDATE showing_room_control SET paused=$1 WHERE id=1', [input.action === 'pause'])
    }
    await recordWrite(transaction)
    const state = (await transaction.query('SELECT enabled,paused,square_announcement,first_slot_at,first_question_number FROM showing_room_control WHERE id=1'))[0]!
    const result: ShowingRoomOperationResult = { ok: true, value: { disposition: 'accepted', ...state, first_slot_at: isoTimestamp(state.first_slot_at) } }
    await transaction.query(`UPDATE showing_room_control SET control_requests=control_requests||jsonb_build_object($1::text,$2::jsonb) WHERE id=1`, [requestId, JSON.stringify({ request_hash: hash, result })])
    return result
  })
}
