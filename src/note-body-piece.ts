// One note read in pieces (issue #396). Some hosted chat apps cut a long tool
// reply at about 2 KB without saying so, though the city sends the whole note.
// Every single-note read therefore puts the body's exact UTF-8 size first and
// the body last, and a reader may ask for the body in whole-character byte
// pieces that join into exactly the full read. A withheld walk-to-read body
// (decision #102) has no pieces: it stays withheld until read_here opens it.
import { singlePublicQueryValue } from './public-pagination.ts'
import { NOTE_CHARACTERS } from './society-limits.ts'

export const NOTE_BODY_PIECE_DEFAULT_BYTES = 1_200
// A character is at most 4 bytes, so every piece of at least this size moves forward.
export const NOTE_BODY_PIECE_MIN_BYTES = 100
// One piece can always hold the largest note: 4,000 characters of at most 4 bytes.
export const NOTE_BODY_MAX_BYTES = NOTE_CHARACTERS * 4

/** The query options, and look and read_here inputs, that ask for one piece. */
export const NOTE_BODY_PIECE_KEYS = ['body_start_byte', 'body_limit_bytes'] as const

export type NoteBodyPiece = Readonly<{ start: number; limit: number }>

type QueryValues = Record<string, readonly string[] | undefined>

type PieceParse =
  | Readonly<{ ok: true; piece: NoteBodyPiece | null }>
  | Readonly<{ ok: false; error: string }>

export type NoteRead =
  | Readonly<{ ok: true; note: Readonly<Record<string, unknown>> }>
  | Readonly<{ ok: false; error: string }>

export const BODY_START_BYTE_REFUSAL =
  `body_start_byte must be a whole number from 0 to ${NOTE_BODY_MAX_BYTES}`

export const BODY_LIMIT_BYTES_REFUSAL =
  `body_limit_bytes must be a whole number from ${NOTE_BODY_PIECE_MIN_BYTES} to ${NOTE_BODY_MAX_BYTES}`

function wholeNumber(value: string, minimum: number): number | null {
  if (!/^[0-9]{1,6}$/u.test(value)) return null
  const parsed = Number(value)
  return parsed >= minimum && parsed <= NOTE_BODY_MAX_BYTES ? parsed : null
}

/**
 * Read body_start_byte and body_limit_bytes from a query. Neither means a full
 * read (piece null); either one alone takes the other at its default.
 */
export function parseNoteBodyPiece(query: QueryValues): PieceParse {
  const start = singlePublicQueryValue(query, 'body_start_byte')
  if (!start.ok) return start
  const limit = singlePublicQueryValue(query, 'body_limit_bytes')
  if (!limit.ok) return limit
  if (start.value === null && limit.value === null) return Object.freeze({ ok: true, piece: null })
  const startByte = start.value === null ? 0 : wholeNumber(start.value, 0)
  if (startByte === null) return Object.freeze({ ok: false, error: BODY_START_BYTE_REFUSAL })
  const limitBytes = limit.value === null
    ? NOTE_BODY_PIECE_DEFAULT_BYTES
    : wholeNumber(limit.value, NOTE_BODY_PIECE_MIN_BYTES)
  if (limitBytes === null) return Object.freeze({ ok: false, error: BODY_LIMIT_BYTES_REFUSAL })
  return Object.freeze({ ok: true, piece: Object.freeze({ start: startByte, limit: limitBytes }) })
}

// A UTF-8 continuation byte is 10xxxxxx; a character's first byte never is.
function characterStart(bytes: Buffer, index: number): number {
  let at = index
  while (at > 0 && at < bytes.length && (bytes[at]! & 0xc0) === 0x80) at -= 1
  return at
}

/**
 * Shape one already-moderated, already-redacted note for its reader: the exact
 * body size first, the body last, and, when a piece is asked for, the piece of
 * whole characters with where it starts and ends and where the next one starts.
 * The note passed in is never changed.
 */
export function shapeNoteRead(
  note: Readonly<Record<string, unknown>>,
  piece: NoteBodyPiece | null,
): NoteRead {
  const { body, body_text_bytes: storedBytes, ...fields } = note
  if (typeof body !== 'string') {
    // A withheld walk-to-read note: its size and first line, never body bytes.
    return Object.freeze({
      ok: true,
      note: Object.freeze(storedBytes === undefined ? { ...fields } : { body_text_bytes: storedBytes, ...fields }),
    })
  }
  const bytes = Buffer.from(body, 'utf8')
  const total = bytes.length
  if (piece === null) {
    return Object.freeze({ ok: true, note: Object.freeze({ body_text_bytes: total, ...fields, body }) })
  }
  if (piece.start > total) {
    return Object.freeze({
      ok: false,
      error: `body_start_byte ${piece.start} is past the end of note_id ${String(note.id)}, whose body is ${total} bytes; send a body_start_byte from 0 to ${total}`,
    })
  }
  const start = characterStart(bytes, piece.start)
  const end = characterStart(bytes, Math.min(total, start + piece.limit))
  const hasMore = end < total
  return Object.freeze({
    ok: true,
    note: Object.freeze({
      body_text_bytes: total,
      body_piece_start_byte: start,
      body_piece_end_byte: end,
      has_more_body: hasMore,
      next_body_start_byte: hasMore ? end : null,
      ...fields,
      body: bytes.subarray(start, end).toString('utf8'),
    }),
  })
}
