// One note read in pieces (issue #396): whole UTF-8 characters, the full size
// first and the body last, pieces that join into exactly the full read, and a
// walk-to-read body that stays withheld from afar.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NOTE_BODY_MAX_BYTES,
  NOTE_BODY_PIECE_DEFAULT_BYTES,
  NOTE_BODY_PIECE_MIN_BYTES,
  BODY_LIMIT_BYTES_REFUSAL,
  BODY_START_BYTE_REFUSAL,
  parseNoteBodyPiece,
  shapeNoteRead,
} from '../src/note-body-piece.ts'
import { publicNoteRow } from '../src/walk-to-read.ts'
import { sanitizePublicValue } from '../src/credential-safety.ts'

// ASCII, a 2-byte e acute, a 3-byte CJK character and a 4-byte emoji, repeated
// so every piece boundary lands inside some character sooner or later.
const MIXED = Array.from(
  { length: 120 },
  (_, index) => `line ${index}: café 漢字 🏮.\n`,
).join('')

const NOTE = Object.freeze({
  id: 24504,
  place_id: 780,
  author: 'tiny-lantern',
  body: MIXED,
  created_at: '2026-10-01T00:00:00.000Z',
})

type Shaped = Record<string, unknown> & { body?: string }

function read(note: Readonly<Record<string, unknown>>, start: number | null, limit: number | null): Shaped {
  const query: Record<string, string[]> = {}
  if (start !== null) query.body_start_byte = [String(start)]
  if (limit !== null) query.body_limit_bytes = [String(limit)]
  const parsed = parseNoteBodyPiece(query)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) throw new Error('unreachable')
  const shaped = shapeNoteRead(note, parsed.piece)
  assert.equal(shaped.ok, true, shaped.ok ? '' : shaped.error)
  if (!shaped.ok) throw new Error('unreachable')
  return shaped.note as Shaped
}

function readAll(note: Readonly<Record<string, unknown>>, limit: number): Shaped[] {
  const pieces: Shaped[] = []
  let start: number | null = 0
  while (start !== null) {
    const piece = read(note, start, limit)
    pieces.push(piece)
    start = piece.next_body_start_byte as number | null
    assert.ok(pieces.length < 10_000, 'pieces must make progress')
  }
  return pieces
}

test('the piece limits cover the largest note and guarantee progress', () => {
  assert.equal(NOTE_BODY_MAX_BYTES, 16_000)
  assert.equal(NOTE_BODY_PIECE_DEFAULT_BYTES, 1_200)
  assert.equal(NOTE_BODY_PIECE_MIN_BYTES, 100)
})

test('a full read puts body_text_bytes first and the body last, byte-identical', () => {
  const full = read(NOTE, null, null)
  const keys = Object.keys(full)
  assert.deepEqual(keys, ['body_text_bytes', 'id', 'place_id', 'author', 'created_at', 'body'])
  assert.equal(full.body, MIXED)
  assert.equal(full.body_text_bytes, Buffer.byteLength(MIXED, 'utf8'))
  assert.equal('has_more_body' in full, false)
  assert.equal(Object.isFrozen(full), true)
  assert.equal(Object.keys(NOTE)[0], 'id', 'the stored row is never changed in place')
})

test('pieces at every limit are whole characters, within the limit, and join into the full body', () => {
  const total = Buffer.byteLength(MIXED, 'utf8')
  const limits = [...Array.from({ length: 201 }, (_, index) => 100 + index), 1_200, 16_000]
  for (const limit of limits) {
    const pieces = readAll(NOTE, limit)
    const joined = Buffer.concat(pieces.map(piece => Buffer.from(piece.body!, 'utf8')))
    assert.equal(joined.equals(Buffer.from(MIXED, 'utf8')), true, `limit ${limit} joined`)
    for (const [index, piece] of pieces.entries()) {
      const bytes = Buffer.from(piece.body!, 'utf8')
      assert.ok(bytes.length <= limit, `limit ${limit} piece ${index} is ${bytes.length}`)
      assert.equal(bytes.toString('utf8'), piece.body, 'a piece is valid UTF-8')
      assert.equal(piece.body!.includes('�'), false, 'no broken character')
      assert.equal(piece.body_text_bytes, total)
      assert.equal(Number(piece.body_piece_end_byte) - Number(piece.body_piece_start_byte), bytes.length)
      const last = index === pieces.length - 1
      assert.equal(piece.has_more_body, !last)
      assert.equal(piece.next_body_start_byte, last ? null : piece.body_piece_end_byte)
      const keys = Object.keys(piece)
      assert.deepEqual(keys.slice(0, 5), [
        'body_text_bytes', 'body_piece_start_byte', 'body_piece_end_byte', 'has_more_body', 'next_body_start_byte',
      ])
      assert.equal(keys.at(-1), 'body')
    }
  }
})

test('a start inside a character moves back to its first byte and says so', () => {
  const body = 'ab漢cd🏮ef'
  const note = { ...NOTE, body }
  // 'ab' is bytes 0-1, the CJK character 2-4, 'cd' 5-6, the emoji 7-10.
  for (const inside of [3, 4]) {
    const piece = read(note, inside, 100)
    assert.equal(piece.body_piece_start_byte, 2)
    assert.equal(piece.body, '漢cd🏮ef')
  }
  for (const inside of [8, 9, 10]) {
    const piece = read(note, inside, 100)
    assert.equal(piece.body_piece_start_byte, 7)
    assert.equal(piece.body, '🏮ef')
  }
})

test('a piece ends before a character that would not fit', () => {
  const body = `${'a'.repeat(99)}🏮${'b'.repeat(10)}`
  const piece = read({ ...NOTE, body }, 0, 100)
  assert.equal(piece.body, 'a'.repeat(99))
  assert.equal(piece.body_piece_end_byte, 99)
  assert.equal(piece.next_body_start_byte, 99)
  const rest = read({ ...NOTE, body }, 99, 100)
  assert.equal(rest.body, `🏮${'b'.repeat(10)}`)
  assert.equal(rest.has_more_body, false)
  assert.equal(rest.next_body_start_byte, null)
})

test('a start equal to the size returns an empty last piece, and past the end is refused with the size', () => {
  const total = Buffer.byteLength(MIXED, 'utf8')
  const end = read(NOTE, total, null)
  assert.equal(end.body, '')
  assert.equal(end.body_piece_start_byte, total)
  assert.equal(end.body_piece_end_byte, total)
  assert.equal(end.has_more_body, false)
  assert.equal(end.next_body_start_byte, null)

  const parsed = parseNoteBodyPiece({ body_start_byte: [String(total + 1)] })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(shapeNoteRead(NOTE, parsed.piece), {
    ok: false,
    error: `body_start_byte ${total + 1} is past the end of note_id 24504, whose body is ${total} bytes; send a body_start_byte from 0 to ${total}`,
  })
})

test('either input alone makes a piece with the other at its default', () => {
  const onlyStart = read(NOTE, 5, null)
  assert.equal(onlyStart.body_piece_start_byte, 5)
  assert.ok(Number(onlyStart.body_piece_end_byte) - 5 <= 1_200)
  assert.ok(Number(onlyStart.body_piece_end_byte) - 5 > 1_190)
  const onlyLimit = read(NOTE, null, 300)
  assert.equal(onlyLimit.body_piece_start_byte, 0)
  assert.ok(Number(onlyLimit.body_piece_end_byte) <= 300)
  assert.deepEqual(parseNoteBodyPiece({}), { ok: true, piece: null })
})

test('bad piece values are refused in caller words', () => {
  assert.equal(BODY_START_BYTE_REFUSAL, 'body_start_byte must be a whole number from 0 to 16000')
  assert.equal(BODY_LIMIT_BYTES_REFUSAL, 'body_limit_bytes must be a whole number from 100 to 16000')
  for (const value of ['-1', '1.5', 'abc', '', '16001', '1e3', ' 5']) {
    assert.deepEqual(parseNoteBodyPiece({ body_start_byte: [value] }), {
      ok: false, error: 'body_start_byte must be a whole number from 0 to 16000',
    }, value)
  }
  for (const value of ['-1', '1.5', 'abc', '99', '0', '16001']) {
    assert.deepEqual(parseNoteBodyPiece({ body_limit_bytes: [value] }), {
      ok: false, error: 'body_limit_bytes must be a whole number from 100 to 16000',
    }, value)
  }
  assert.deepEqual(parseNoteBodyPiece({ body_start_byte: ['0', '5'] }), {
    ok: false, error: 'body_start_byte must appear at most once',
  })
  assert.deepEqual(parseNoteBodyPiece({ body_limit_bytes: ['100', '200'] }), {
    ok: false, error: 'body_limit_bytes must appear at most once',
  })
  assert.deepEqual(parseNoteBodyPiece({ body_start_byte: ['0'], body_limit_bytes: ['16000'] }), {
    ok: true, piece: { start: 0, limit: 16_000 },
  })
})

test('a withheld walk-to-read note gives no body and no piece fields, size first', () => {
  const withheld = publicNoteRow({ ...NOTE, walk_to_read: true, body_withheld: true })
  for (const [start, limit] of [[null, null], [60, 100], [0, 16_000]] as const) {
    const shaped = read(withheld, start, limit)
    assert.equal('body' in shaped, false)
    assert.equal('has_more_body' in shaped, false)
    assert.equal('body_piece_start_byte' in shaped, false)
    assert.equal(Object.keys(shaped)[0], 'body_text_bytes')
    assert.equal(shaped.body_text_bytes, Buffer.byteLength(MIXED, 'utf8'))
    assert.equal(shaped.first_line, withheld.first_line)
    assert.equal(shaped.read_in_person, withheld.read_in_person)
    assert.equal(JSON.stringify(shaped).includes('line 1:'), false, 'no body past the first line')
  }
})

test('an opened walk-to-read body reads in pieces with its mark kept', () => {
  const opened = publicNoteRow({ ...NOTE, walk_to_read: true, body_withheld: false })
  const pieces = readAll(opened, 500)
  assert.equal(pieces.map(piece => piece.body).join(''), MIXED)
  assert.equal(pieces[0]!.walk_to_read, true)
})

test('a credential across a piece boundary is redacted before slicing', () => {
  const secret = `1f3d9_sk_${'7'.repeat(48)}`
  const body = `${'x'.repeat(90)}${secret}${'y'.repeat(200)}`
  const sanitized = sanitizePublicValue({ ...NOTE, body })
  assert.equal(sanitized.withheld, false)
  const safeNote = sanitized.value as Record<string, unknown>
  assert.notEqual(safeNote.body, body, 'the fixture body must hold a redactable credential')
  const pieces = readAll(safeNote, 100)
  assert.equal(pieces.map(piece => piece.body).join(''), safeNote.body)
  for (const piece of pieces) {
    assert.equal(piece.body!.includes('1f3d9_sk_'), false)
    assert.equal(piece.body!.includes('7'.repeat(20)), false)
  }
})
