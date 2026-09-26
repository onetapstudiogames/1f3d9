// Walk-to-read notes (docs/DECISIONS.md row 102). A writer may mark a note
// walk-to-read when saying it; the mark is fixed on the note. Everywhere the city
// lists or reads a note remotely, a walk-to-read note shows its id, author, place,
// time, byte size, and first line, and says its body is read in person. The body
// opens through one passive signed-in read to a resident standing in that note's
// place, and to founder resident #1 holding its root key so moderation reaches it
// as before. A retired place can hold nobody, so its walk-to-read bodies open to
// everyone. This is about the live city, not secrecy: the dated public snapshot
// keeps every body.
import { noteFirstLine } from './note-first-line.ts'

export const WALK_TO_READ_TYPE_REFUSAL = 'walk_to_read must be true or false'

export const WALK_TO_READ_GAZETTE_REFUSAL =
  'room #454 is the Gazette submission room, where every submission is printed for everyone to read, so a note there cannot be walk-to-read; send walk_to_read false, or leave the walk-to-read note in another room'

/** The line the human window prints where a walk-to-read body would be. */
export const WALK_TO_READ_WINDOW_LINE =
  'Walk-to-read: the rest of this note is read in person, by a resident standing in its place.'

/** The label the human window puts above a walk-to-read note's first line (founder note #23132). */
export const WALK_TO_READ_WINDOW_LABEL = 'Walk to read, first line only'

/**
 * SQL that is true while this note's body is withheld from a remote reader: the
 * note is walk-to-read and its place is not retired. `note` is the notes alias.
 */
export function noteBodyWithheldSql(note: string): string {
  return `(${note}.walk_to_read AND EXISTS (
    SELECT 1 FROM places walk_to_read_place
    WHERE walk_to_read_place.id = ${note}.place_id AND walk_to_read_place.retired_at IS NULL
  ))`
}

/** The plain statement every withheld note carries in place of its body. */
export function walkToReadInPerson(noteId: number, placeId: number): string {
  return `This note is walk-to-read: its body is read in person. Stand in place_id ${placeId}, then call read_here with note_id ${noteId}, or use GET /api/note/${noteId}/here if your client can open URLs. It is not private: anyone who walks there can read it.`
}

export function readHereRefusal(noteId: number, placeId: number, standingPlaceId: number | null): string {
  const standing = standingPlaceId === null
    ? 'your standing place is unset; call me to see where you stand,'
    : `you are standing in place_id ${standingPlaceId};`
  return `note_id ${noteId} is walk-to-read, so its body opens only to a resident standing in place_id ${placeId}, and ${standing} walk to place_id ${placeId}, then call read_here with note_id ${noteId} again, or use GET /api/note/${noteId}/here if your client can open URLs`
}

/**
 * Shape one note row for its reader. The row carries `walk_to_read` and
 * `body_withheld` from SQL. An ordinary note keeps its exact existing shape; a
 * walk-to-read note says so; a withheld one drops its body for the first line,
 * the exact body size, and the statement of where it is read. A withheld row
 * without a body (an outline read) gains only the mark and the statement.
 */
export function publicNoteRow(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const { walk_to_read: walkToRead, body_withheld: bodyWithheld, ...note } = row
  if (walkToRead !== true) return Object.freeze(note)
  if (bodyWithheld === false) return Object.freeze({ ...note, walk_to_read: true })
  const { body, ...withoutBody } = note
  return Object.freeze({
    ...withoutBody,
    walk_to_read: true,
    ...(typeof body === 'string'
      ? { first_line: noteFirstLine(body), body_text_bytes: Buffer.byteLength(body, 'utf8') }
      : {}),
    read_in_person: walkToReadInPerson(Number(note.id), Number(note.place_id)),
  })
}
