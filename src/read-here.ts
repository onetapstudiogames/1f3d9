// The one passive signed-in read that opens a walk-to-read body (decision #102):
// to a resident standing in that note's place, and to founder resident #1 holding
// its root key, so moderation reaches these notes as before.
import { sql } from './db.ts'
import { moderatePublicRows } from './moderation-store.ts'
import type { PublicQueryExecutor } from './public-pagination.ts'
import { noteBodyWithheldSql, publicNoteRow, readHereRefusal } from './walk-to-read.ts'

export type NoteHereRead =
  | Readonly<{ ok: true; note: Readonly<Record<string, unknown>> }>
  | Readonly<{ ok: false; status: 403; error: string }>

const executeNoteHereQuery: PublicQueryExecutor = async (text, params) =>
  await sql.query(text, [...params]) as readonly Record<string, unknown>[]

/**
 * The one read that opens a walk-to-read body. It is passive: one SELECT that
 * never creates presence, wakes a timer, or records the read. Returns null when
 * the note does not exist.
 */
export async function readNoteHere(
  noteId: number,
  residentId: number,
  founderRead: boolean,
  query: PublicQueryExecutor = executeNoteHereQuery,
): Promise<NoteHereRead | null> {
  const rows = await query(`
    /* public:note-here */
    SELECT note.id, note.place_id, author.handle AS author, note.body, note.created_at,
      note.walk_to_read, ${noteBodyWithheldSql('note')} AS body_withheld,
      (SELECT presence.current_place_id FROM resident_presence presence
        WHERE presence.resident_id = $2::integer) AS standing_place_id
    FROM notes note
    JOIN residents author ON author.id = note.author_id
    WHERE note.id = $1::integer
  `, [noteId, residentId])
  const row = rows[0]
  if (!row) return null
  const { standing_place_id: standing, ...note } = row
  const standingPlaceId = standing == null ? null : Number(standing)
  const placeId = Number(note.place_id)
  if (note.body_withheld === true && !founderRead && standingPlaceId !== placeId) {
    return Object.freeze({ ok: false, status: 403, error: readHereRefusal(noteId, placeId, standingPlaceId) })
  }
  const [shown] = await moderatePublicRows('note', [publicNoteRow({ ...note, body_withheld: false })])
  return Object.freeze({ ok: true, note: shown! })
}
