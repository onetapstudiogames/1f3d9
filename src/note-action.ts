import { postgresErrorConstraint, QUOTAS } from './core.ts'
import {
  CommitOutcomeUnknownError,
  EngineError,
  engineSql,
  runAction,
  withEngineTransaction,
  type TaggedSql,
} from './engine.ts'
import {
  GAZETTE_LOCK_NAMESPACE,
  GAZETTE_ROOM_ID,
  GAZETTE_SUBMISSIONS_CLOSED_ERROR,
  GAZETTE_WITHDRAWAL_COMMAND,
  GAZETTE_WITHDRAWALS_CLOSED_ERROR,
  gazetteWithdrawalNotice,
} from './gazette.ts'
import { placePermission, withPlacePermission } from './place-permission.ts'

export const NOTE_IDEMPOTENCY_WINDOW_SECONDS = 5 * 60
const NOTE_RETRY_LOCK_NAMESPACE = 0x1f3d9004
const NOTE_COMMIT_UNCONFIRMED_ERROR =
  'note outcome could not be confirmed; retrying the identical body in the same place is safe'
const GAZETTE_NOTE_COMMIT_UNCONFIRMED_ERROR =
  'Gazette note outcome could not be confirmed; withdrawal command interpretation may have changed. Re-read GET /api/gazette and your recent notes in room #454 before deciding whether to submit again'
const GAZETTE_QUOTA_RULE =
  `${QUOTAS.gazetteSubmissions} Gazette submissions per resident are allowed from ` +
  'Monday 16:00 UTC inclusive to the next Monday 16:00 UTC exclusive'

interface TalkNote {
  readonly id: number
  readonly place_id?: number
  readonly author?: string
  readonly body?: string
  readonly created_at?: string
}

export type GazetteWithdrawalResult = Readonly<{
  target_note_id: number
  command_note_id: number
  withdrawn_at: string
  notice: string
}>

export type TalkNoteReplay = Readonly<{
  note: TalkNote
  gazetteWithdrawal?: GazetteWithdrawalResult
}>

interface TalkNoteActionInput {
  readonly placeId: number
  readonly residentId: number
  readonly residentHandle: string
  readonly text: string
}

interface TalkNoteCreationRow {
  readonly id: number | null
  readonly place_id?: number
  readonly author?: string
  readonly body?: string
  readonly created_at?: string
  readonly place_exists?: boolean
  readonly place_permits_notes?: boolean
  readonly gazette_activated?: boolean
  readonly note_quota_spent?: boolean
}

type TalkNoteStatus = 400 | 403 | 404 | 409 | 429 | 500

interface GazetteWithdrawalRow {
  readonly target_note_id?: unknown
  readonly command_note_id?: unknown
  readonly withdrawn_at?: unknown
}

interface GazetteCommandReservedRow {
  readonly command_reserved?: unknown
}

export type TalkNoteActionResult =
  | {
      readonly ok: true
      readonly note: TalkNote
      readonly replayed: boolean
      readonly gazetteWithdrawal?: GazetteWithdrawalResult
    }
  | { readonly ok: false; readonly status: TalkNoteStatus; readonly error: string }

function noteFacingError(message: string): string {
  const standingMismatch = /^you must be standing in place_id (\d+); your current place_id is (unset|\d+)$/u.exec(message)
  if (standingMismatch) {
    const [, requestedPlaceId, currentPlaceId] = standingMismatch
    return currentPlaceId === 'unset'
      ? `you must be standing in place_id ${requestedPlaceId} to leave a note there; your standing place is unset`
      : `you must be standing in place_id ${requestedPlaceId} to leave a note there; you are standing in place_id ${currentPlaceId}`
  }
  const standingChanged = /^your current place_id changed to (\d+); retry with place_id \1$/u.exec(message)
  if (standingChanged) {
    const [, currentPlaceId] = standingChanged
    return `your standing place changed to place_id ${currentPlaceId} before the note was left; retry with place_id ${currentPlaceId}`
  }
  if (message === 'your current place_id is now unset; check where you are standing before retrying') {
    return 'your standing place became unset before the note was left; check where you are standing, then retry with that place_id'
  }
  return message
}

function databaseInstant(value: unknown, field: string): string {
  const milliseconds = value instanceof Date
    ? value.getTime()
    : typeof value === 'string'
      ? Date.parse(value)
      : Number.NaN
  if (!Number.isFinite(milliseconds)) {
    throw new EngineError(500, `database returned an invalid ${field}`)
  }
  return new Date(milliseconds).toISOString()
}

function gazetteQuotaError(retryAt: string): string {
  return `${GAZETTE_QUOTA_RULE}; this Gazette week's ` +
    `${QUOTAS.gazetteSubmissions} submissions are used; retry at ${retryAt}`
}

function gazetteConstraintQuotaError(error: unknown): string {
  const retryAt = error instanceof Error
    ? /retry at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/u.exec(error.message)?.[1]
    : undefined
  if (retryAt) {
    try {
      return gazetteQuotaError(databaseInstant(retryAt, 'Gazette retry time'))
    } catch {
      // Keep the bounded caller recovery below when old or malformed trigger text appears.
    }
  }
  return `${GAZETTE_QUOTA_RULE}; this Gazette week's ` +
    `${QUOTAS.gazetteSubmissions} submissions are used; retry at the next Monday 16:00 UTC boundary`
}

function gazetteConstraintEngineError(error: unknown): EngineError | null {
  const constraint = postgresErrorConstraint(error)
  if (constraint === 'gazette_submission_room_closed') {
    return new EngineError(409, GAZETTE_SUBMISSIONS_CLOSED_ERROR)
  }
  if (constraint === 'gazette_submission_weekly_limit') {
    return new EngineError(429, gazetteConstraintQuotaError(error))
  }
  if (constraint === 'gazette_withdrawals_closed') {
    return new EngineError(409, GAZETTE_WITHDRAWALS_CLOSED_ERROR)
  }
  if (constraint === 'gazette_withdrawal_command_invalid') {
    return new EngineError(400, `Gazette withdrawal must be exactly ${GAZETTE_WITHDRAWAL_COMMAND}`)
  }
  const message = error instanceof Error ? error.message : ''
  const target = /Gazette submission note #(\d+)/u.exec(message)?.[1]
  if (constraint === 'gazette_withdrawal_no_such_submission') {
    return new EngineError(
      404,
      target
        ? `Gazette submission note #${target} was not found in room #454`
        : 'Gazette submission was not found in room #454',
    )
  }
  if (constraint === 'gazette_withdrawal_author_mismatch') {
    return new EngineError(
      403,
      target
        ? `only the author may withdraw Gazette submission note #${target}; you are not its author`
        : 'only the author may withdraw a Gazette submission; you are not its author',
    )
  }
  if (constraint === 'gazette_withdrawal_already_printed') {
    const printed = /Gazette submission note #(\d+) already printed in issue #(\d+)/u.exec(message)
    return new EngineError(
      409,
      printed
        ? `Gazette submission note #${printed[1]} already printed in issue #${printed[2]} and cannot be withdrawn`
        : 'Gazette submission already printed and cannot be withdrawn',
    )
  }
  if (constraint === 'gazette_withdrawal_tick_passed') {
    const passed = /Gazette submission note #(\d+) can be withdrawn only strictly before (\S+);/u.exec(message)
    return new EngineError(
      409,
      passed
        ? `Gazette submission note #${passed[1]} can be withdrawn only strictly before ${databaseInstant(passed[2], 'Gazette print tick')}; that print tick has passed`
        : 'Gazette submission reached its Monday 16:00 UTC print tick and can no longer be withdrawn',
    )
  }
  if (constraint === 'gazette_withdrawal_already_withdrawn') {
    return new EngineError(
      409,
      target
        ? `Gazette submission note #${target} was already withdrawn by its author`
        : 'Gazette submission was already withdrawn by its author',
    )
  }
  return null
}

function gazetteWithdrawalTarget(
  input: Pick<TalkNoteActionInput, 'placeId' | 'text'>,
): number | null {
  if (input.placeId !== GAZETTE_ROOM_ID) return null
  const command = /^WITHDRAW #([1-9][0-9]*)$/u.exec(input.text)
  if (!command) return null
  const targetNoteId = Number(command[1])
  return Number.isSafeInteger(targetNoteId) && targetNoteId <= 2_147_483_647
    ? targetNoteId
    : null
}

function gazetteWithdrawalOpeningReserved(
  input: Pick<TalkNoteActionInput, 'placeId' | 'text'>,
): boolean {
  return input.placeId === GAZETTE_ROOM_ID && /^WITHDRAW\s*#/u.test(input.text)
}

async function queryRows<T>(promise: Promise<unknown>): Promise<T[]> {
  const value = await promise
  if (!Array.isArray(value)) throw new EngineError(500, 'database returned an invalid result')
  return value as T[]
}

function databasePositiveInteger(value: unknown, field: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) {
    throw new EngineError(500, `database returned an invalid ${field}`)
  }
  return parsed
}

export async function readGazetteWithdrawalForNote(
  input: Pick<TalkNoteActionInput, 'placeId' | 'text'>,
  note: TalkNote,
  database: TaggedSql = engineSql,
): Promise<GazetteWithdrawalResult | undefined> {
  const targetNoteId = gazetteWithdrawalTarget(input)
  if (targetNoteId === null) return undefined
  const commandNoteId = databasePositiveInteger(note.id, 'Gazette withdrawal command note ID')
  const found = await queryRows<GazetteWithdrawalRow>(database`
    /* note-action:gazette-withdrawal */
    SELECT target_note_id, command_note_id, withdrawn_at
    FROM gazette_withdrawals
    WHERE command_note_id = ${commandNoteId}
  `)
  if (found.length === 0) return undefined
  if (found.length !== 1) {
    throw new EngineError(500, 'database returned ambiguous Gazette withdrawal facts')
  }
  const row = found[0]!
  const storedTargetNoteId = databasePositiveInteger(
    row.target_note_id,
    'Gazette withdrawal target note ID',
  )
  const storedCommandNoteId = databasePositiveInteger(
    row.command_note_id,
    'Gazette withdrawal command note ID',
  )
  if (storedTargetNoteId !== targetNoteId || storedCommandNoteId !== commandNoteId) {
    throw new EngineError(500, 'database returned mismatched Gazette withdrawal facts')
  }
  return Object.freeze({
    target_note_id: storedTargetNoteId,
    command_note_id: storedCommandNoteId,
    withdrawn_at: databaseInstant(row.withdrawn_at, 'Gazette withdrawal time'),
    notice: gazetteWithdrawalNotice(storedTargetNoteId),
  })
}

async function lockResidentNoteRetries(
  transaction: TaggedSql,
  residentId: number,
): Promise<void> {
  await queryRows(transaction`
    SELECT pg_advisory_xact_lock(${NOTE_RETRY_LOCK_NAMESPACE}, ${residentId})
  `)
}

async function lockGazettePrintCycle(transaction: TaggedSql): Promise<void> {
  await queryRows(transaction`
    SELECT pg_advisory_xact_lock(${GAZETTE_LOCK_NAMESPACE}, ${GAZETTE_ROOM_ID})
  `)
}

async function findRecentDuplicate(
  database: TaggedSql,
  input: TalkNoteActionInput,
): Promise<TalkNote | null> {
  if (!database.query) throw new EngineError(500, 'transaction query support is unavailable')
  const gazetteReplayRule = input.placeId === GAZETTE_ROOM_ID
    ? `AND (
        NOT gazette_withdrawals_are_open()
        OR NOT gazette_withdrawal_command_reserved(note.body)
        OR EXISTS (
          SELECT 1
          FROM gazette_withdrawals withdrawal
          WHERE withdrawal.command_note_id = note.id
        )
      )`
    : ''
  const rows = await database.query(`
    /* note-action:recent-duplicate */
    SELECT note.id, note.place_id, author.handle AS author, note.body, note.created_at
    FROM notes note
    JOIN residents author ON author.id = note.author_id
    WHERE note.author_id = $1
      AND note.place_id = $2
      AND note.body COLLATE "C" = $3::text COLLATE "C"
      AND note.created_at >= statement_timestamp()
        - ($4::integer * interval '1 second')
      ${gazetteReplayRule}
    ORDER BY note.created_at DESC, note.id DESC
    LIMIT 1
  `, [
    input.residentId,
    input.placeId,
    input.text,
    NOTE_IDEMPOTENCY_WINDOW_SECONDS,
  ]) as TalkNote[]
  return rows[0] ?? null
}

async function findRecentTalkNoteReplayInTransaction(
  input: TalkNoteActionInput,
  transaction: TaggedSql,
): Promise<TalkNoteReplay | null> {
  await lockResidentNoteRetries(transaction, input.residentId)
  if (input.placeId === GAZETTE_ROOM_ID) await lockGazettePrintCycle(transaction)
  const note = await findRecentDuplicate(transaction, input)
  if (!note) return null
  const gazetteWithdrawal = await readGazetteWithdrawalForNote(input, note, transaction)
  return Object.freeze({
    note,
    ...(gazetteWithdrawal ? { gazetteWithdrawal } : {}),
  })
}

export async function findRecentTalkNoteReplay(
  input: TalkNoteActionInput,
  database: TaggedSql = engineSql,
): Promise<TalkNoteReplay | null> {
  return withEngineTransaction(database, transaction => (
    findRecentTalkNoteReplayInTransaction(input, transaction)
  ))
}

async function gazetteWithdrawalCommandIsReserved(
  transaction: TaggedSql,
  input: Pick<TalkNoteActionInput, 'placeId' | 'text'>,
): Promise<boolean> {
  if (input.placeId !== GAZETTE_ROOM_ID) return false
  const rows = await queryRows<GazetteCommandReservedRow>(transaction`
    /* note-action:gazette-command-reserved */
    SELECT gazette_withdrawals_are_open()
      AND gazette_withdrawal_command_reserved(${input.text}) AS command_reserved
  `)
  if (rows.length !== 1 || typeof rows[0]?.command_reserved !== 'boolean') {
    throw new EngineError(500, 'database returned an invalid Gazette command state')
  }
  return rows[0].command_reserved
}

async function createTalkNote(
  transaction: TaggedSql,
  input: TalkNoteActionInput,
): Promise<TalkNote> {
  if (!transaction.query) throw new EngineError(500, 'transaction query support is unavailable')
  const rows = await withPlacePermission(transaction)`
    /* note-action:create */
    WITH place_state AS (
      SELECT place.id,
        place.owner_id IS NOT NULL AS ordinary_place,
        ${placePermission('place', 'open_to_notes', input.residentId)} AS permits_notes,
        CASE
          WHEN place.id <> ${GAZETTE_ROOM_ID} THEN TRUE
          ELSE gazette_submission_room_is_open()
        END AS gazette_activated
      FROM places place
      WHERE place.id = ${input.placeId}
    ), permitted_place AS (
      SELECT state.id
      FROM place_state state
      WHERE state.ordinary_place AND state.permits_notes AND state.gazette_activated
    ), spent_quota AS (
      UPDATE residents SET notes_today = notes_today + 1
      WHERE id = ${input.residentId} AND notes_today < ${QUOTAS.notes}
        AND EXISTS (SELECT 1 FROM permitted_place)
      RETURNING id
    ), new_note AS (
      INSERT INTO notes (place_id, author_id, body, created_at)
      SELECT p.id, q.id, ${input.text}, statement_timestamp()
      FROM permitted_place p CROSS JOIN spent_quota q
      RETURNING id, place_id, author_id, body, created_at
    ), new_event AS (
      INSERT INTO events (at, kind, actor, detail)
      SELECT created_at, 'note', ${input.residentHandle},
        jsonb_build_object('note_id', id, 'place_id', place_id)
      FROM new_note
    )
    SELECT n.id, n.place_id, ${input.residentHandle}::text AS author, n.body, n.created_at,
      EXISTS (SELECT 1 FROM place_state) AS place_exists,
      coalesce((SELECT state.ordinary_place AND state.permits_notes FROM place_state state), FALSE)
        AS place_permits_notes,
      coalesce((SELECT state.gazette_activated FROM place_state state), FALSE)
        AS gazette_activated,
      EXISTS (SELECT 1 FROM spent_quota) AS note_quota_spent
    FROM (VALUES (TRUE)) AS result(singleton)
    LEFT JOIN new_note n ON TRUE
  ` as TalkNoteCreationRow[]
  const outcome = rows[0]
  if (!outcome) throw new EngineError(500, 'note result is unavailable')
  if (outcome.id !== null && outcome.id !== undefined) {
    return {
      id: outcome.id,
      ...(outcome.place_id === undefined ? {} : { place_id: outcome.place_id }),
      ...(outcome.author === undefined ? {} : { author: outcome.author }),
      ...(outcome.body === undefined ? {} : { body: outcome.body }),
      ...(outcome.created_at === undefined ? {} : { created_at: outcome.created_at }),
    }
  }
  if (outcome.place_exists === false) {
    throw new EngineError(404, `place_id ${input.placeId} no longer exists; read the place before retrying`)
  }
  if (input.placeId === GAZETTE_ROOM_ID && outcome.gazette_activated === false) {
    throw new EngineError(409, GAZETTE_SUBMISSIONS_CLOSED_ERROR)
  }
  if (outcome.place_permits_notes === false) {
    throw new EngineError(
      409,
      `place_id ${input.placeId} closed to notes before the note was left; check its note permission before retrying`,
    )
  }
  if (outcome.note_quota_spent === false) {
    throw new EngineError(429, `${QUOTAS.notes} notes per UTC day`)
  }
  throw new EngineError(500, 'note result is unavailable')
}

async function createTalkNoteForAction(
  transaction: TaggedSql,
  input: TalkNoteActionInput,
): Promise<TalkNote> {
  try {
    return await createTalkNote(transaction, input)
  } catch (error) {
    throw gazetteConstraintEngineError(error) ?? error
  }
}

async function attemptTalkNoteAction(
  input: TalkNoteActionInput,
  database: TaggedSql,
): Promise<TalkNoteActionResult> {
  return withEngineTransaction(database, async transaction => {
    const replay = await findRecentTalkNoteReplayInTransaction(input, transaction)
    if (replay) {
      return {
        ok: true,
        note: replay.note,
        replayed: true,
        ...(replay.gazetteWithdrawal
          ? { gazetteWithdrawal: replay.gazetteWithdrawal }
          : {}),
      }
    }

    let note: TalkNote | undefined
    const action = await runAction({
      actorId: input.residentId,
      actorHandle: input.residentHandle,
      action: 'talk',
      placeId: input.placeId,
      primitiveHandledByCaller: true,
      primitiveEmitsTypedEvent: true,
      performPrimitive: async transaction => {
        note = await createTalkNoteForAction(transaction, input)
      },
    }, transaction)
    if (action.error) {
      return {
        ok: false,
        status: action.httpStatus as TalkNoteStatus,
        error: noteFacingError(action.error),
      }
    }
    const gazetteWithdrawal = note
      ? await readGazetteWithdrawalForNote(input, note, transaction)
      : undefined
    if (
      note
      && gazetteWithdrawalTarget(input) !== null
      && !gazetteWithdrawal
      && await gazetteWithdrawalCommandIsReserved(transaction, input)
    ) {
      throw new EngineError(500, 'database did not record the Gazette withdrawal')
    }
    return note
      ? {
          ok: true,
          note,
          replayed: false,
          ...(gazetteWithdrawal ? { gazetteWithdrawal } : {}),
        }
      : { ok: false, status: 500, error: 'note result is unavailable' }
  })
}

export async function runTalkNoteAction(
  input: TalkNoteActionInput,
  database: TaggedSql = engineSql,
): Promise<TalkNoteActionResult> {
  try {
    return await attemptTalkNoteAction(input, database)
  } catch (error) {
    const gazetteError = gazetteConstraintEngineError(error)
    if (gazetteError) {
      return {
        ok: false,
        status: gazetteError.status,
        error: gazetteError.message,
      }
    }
    if (error instanceof CommitOutcomeUnknownError) {
      try {
        const replay = await findRecentTalkNoteReplay(input, database)
        if (replay) {
          return {
            ok: true,
            note: replay.note,
            replayed: true,
            ...(replay.gazetteWithdrawal
              ? { gazetteWithdrawal: replay.gazetteWithdrawal }
              : {}),
          }
        }
      } catch {
        // The bounded response below does not assume which side of activation committed.
      }
      return {
        ok: false,
        status: 500,
        error: gazetteWithdrawalOpeningReserved(input)
          ? GAZETTE_NOTE_COMMIT_UNCONFIRMED_ERROR
          : NOTE_COMMIT_UNCONFIRMED_ERROR,
      }
    }
    if (error instanceof EngineError) {
      return { ok: false, status: error.status, error: noteFacingError(error.message) }
    }
    throw error
  }
}
