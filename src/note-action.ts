import { QUOTAS } from './core.ts'
import {
  CommitOutcomeUnknownError,
  EngineError,
  engineSql,
  runAction,
  withEngineTransaction,
  type TaggedSql,
} from './engine.ts'

export const NOTE_IDEMPOTENCY_WINDOW_SECONDS = 5 * 60
const NOTE_RETRY_LOCK_NAMESPACE = 0x1f3d9004
const NOTE_COMMIT_UNCONFIRMED_ERROR =
  'note outcome could not be confirmed; retrying the identical body in the same place is safe'

interface TalkNote {
  readonly id: number
  readonly place_id?: number
  readonly author?: string
  readonly body?: string
  readonly created_at?: string
}

interface TalkNoteActionInput {
  readonly placeId: number
  readonly residentId: number
  readonly residentHandle: string
  readonly text: string
}

type TalkNoteStatus = 400 | 403 | 404 | 409 | 429 | 500

export type TalkNoteActionResult =
  | { readonly ok: true; readonly note: TalkNote; readonly replayed: boolean }
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

async function queryRows<T>(promise: Promise<unknown>): Promise<T[]> {
  const value = await promise
  if (!Array.isArray(value)) throw new EngineError(500, 'database returned an invalid result')
  return value as T[]
}

async function lockResidentNoteRetries(
  transaction: TaggedSql,
  residentId: number,
): Promise<void> {
  await queryRows(transaction`
    SELECT pg_advisory_xact_lock(${NOTE_RETRY_LOCK_NAMESPACE}, ${residentId})
  `)
}

async function findRecentDuplicate(
  database: TaggedSql,
  input: TalkNoteActionInput,
): Promise<TalkNote | null> {
  if (!database.query) throw new EngineError(500, 'transaction query support is unavailable')
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

export async function findRecentTalkNoteDuplicate(
  input: TalkNoteActionInput,
  database: TaggedSql = engineSql,
): Promise<TalkNote | null> {
  return findRecentDuplicate(database, input)
}

async function createTalkNote(
  transaction: TaggedSql,
  input: TalkNoteActionInput,
): Promise<TalkNote> {
  if (!transaction.query) throw new EngineError(500, 'transaction query support is unavailable')
  const rows = await transaction.query(`
    /* note-action:create */
    WITH permitted_place AS (
      SELECT id FROM places
      WHERE id = $1 AND (owner_id = $2 OR open_to_notes)
        AND owner_id IS NOT NULL
    ), spent_quota AS (
      UPDATE residents SET notes_today = notes_today + 1
      WHERE id = $2 AND notes_today < $3
        AND EXISTS (SELECT 1 FROM permitted_place)
      RETURNING id
    ), new_note AS (
      INSERT INTO notes (place_id, author_id, body)
      SELECT p.id, q.id, $4 FROM permitted_place p CROSS JOIN spent_quota q
      RETURNING id, place_id, author_id, body, created_at
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'note', $5, jsonb_build_object('note_id', id, 'place_id', place_id)
      FROM new_note
    )
    SELECT n.id, n.place_id, $5::text AS author, n.body, n.created_at
    FROM new_note n
  `, [input.placeId, input.residentId, QUOTAS.notes, input.text, input.residentHandle]) as TalkNote[]
  const note = rows[0]
  if (!note) throw new EngineError(429, `${QUOTAS.notes} notes per UTC day`)
  return note
}

async function attemptTalkNoteAction(
  input: TalkNoteActionInput,
  database: TaggedSql,
): Promise<TalkNoteActionResult> {
  return withEngineTransaction(database, async transaction => {
    await lockResidentNoteRetries(transaction, input.residentId)
    const existing = await findRecentDuplicate(transaction, input)
    if (existing) return { ok: true, note: existing, replayed: true }

    let note: TalkNote | undefined
    const action = await runAction({
      actorId: input.residentId,
      actorHandle: input.residentHandle,
      action: 'talk',
      placeId: input.placeId,
      primitiveHandledByCaller: true,
      primitiveEmitsTypedEvent: true,
      performPrimitive: async transaction => {
        note = await createTalkNote(transaction, input)
      },
    }, transaction)
    if (action.error) {
      return {
        ok: false,
        status: action.httpStatus as TalkNoteStatus,
        error: noteFacingError(action.error),
      }
    }
    return note
      ? { ok: true, note, replayed: false }
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
    if (error instanceof CommitOutcomeUnknownError) {
      try {
        const existing = await findRecentDuplicate(database, input)
        if (existing) return { ok: true, note: existing, replayed: true }
      } catch {
        // A safe identical retry remains available when the canonical read fails.
      }
      return { ok: false, status: 500, error: NOTE_COMMIT_UNCONFIRMED_ERROR }
    }
    if (error instanceof EngineError) {
      return { ok: false, status: error.status, error: noteFacingError(error.message) }
    }
    throw error
  }
}
