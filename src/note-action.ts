import { QUOTAS } from './core.ts'
import { EngineError, runAction, type TaggedSql } from './engine.ts'

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
  | { readonly ok: true; readonly note: TalkNote }
  | { readonly ok: false; readonly status: TalkNoteStatus; readonly error: string }

async function createTalkNote(
  transaction: TaggedSql,
  input: TalkNoteActionInput,
): Promise<TalkNote> {
  if (!transaction.query) throw new EngineError(500, 'transaction query support is unavailable')
  const rows = await transaction.query(`
    WITH permitted_place AS (
      SELECT id FROM places
      WHERE id = $1 AND (owner_id = $2 OR open_to_notes)
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

export async function runTalkNoteAction(input: TalkNoteActionInput): Promise<TalkNoteActionResult> {
  let note: TalkNote | undefined
  try {
    const action = await runAction({
      actorId: input.residentId,
      actorHandle: input.residentHandle,
      action: 'talk',
      placeId: input.placeId,
      primitiveHandledByCaller: true,
      performPrimitive: async transaction => {
        note = await createTalkNote(transaction, input)
      },
    })
    if (action.error) {
      return { ok: false, status: action.httpStatus as TalkNoteStatus, error: action.error }
    }
  } catch (error) {
    if (error instanceof EngineError) {
      return { ok: false, status: error.status, error: error.message }
    }
    throw error
  }
  return note
    ? { ok: true, note }
    : { ok: false, status: 500, error: 'note result is unavailable' }
}
