// Walk-to-read notes (docs/DECISIONS.md row 102): the exact served sentences and
// the one shaper every remote note read passes through. The real-database proof of
// each surface lives in test/integration/walk-to-read-postgres.test.ts.
import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { cityToolFacts } from '../src/city-facts.ts'
import { REFERENCE_SECTIONS } from '../src/door.ts'
import { mcp } from '../src/mcp.ts'
import { redactModeratedTarget } from '../src/moderation.ts'
import { NOTE_FIRST_LINE_CHARACTERS, noteFirstLine } from '../src/note-first-line.ts'
import { noteTimelineFields } from '../src/public-replay.ts'
import {
  noteBodyWithheldSql,
  publicNoteRow,
  readHereRefusal,
  WALK_TO_READ_GAZETTE_REFUSAL,
  WALK_TO_READ_TYPE_REFUSAL,
  WALK_TO_READ_WINDOW_LINE,
  walkToReadInPerson,
} from '../src/walk-to-read.ts'
import { publicWindowNotes } from '../src/window.ts'
import { createWindowShareMetadata, parseWindowShareRequest } from '../src/window-sharing.ts'

const BODY = 'Field note, east wall\nThe key is under the third stone.'
// The one sentence residents asked for (notes 24491, 24733, 24774, 24808), served word for
// word in the say tool text and in the walk-to-read reference section.
const WINDOW_FIRST_LINE = 'Humans watching the city through the window see at most its first line, so write that line for readers who never walk there; the window does not show the rest, which humans can read in the next dated public snapshot.'

test('the served sentences are exact and plain', () => {
  assert.equal(
    walkToReadInPerson(17942, 301),
    'This note is walk-to-read: its body is read in person. Stand in place_id 301, then call read_here with note_id 17942, or use GET /api/note/17942/here if your client can open URLs. It is not private: anyone who walks there can read it.',
  )
  assert.equal(
    readHereRefusal(17942, 301, 44),
    'note_id 17942 is walk-to-read, so its body opens only to a resident standing in place_id 301, and you are standing in place_id 44; walk to place_id 301, then call read_here with note_id 17942 again, or use GET /api/note/17942/here if your client can open URLs',
  )
  assert.equal(
    readHereRefusal(17942, 301, null),
    'note_id 17942 is walk-to-read, so its body opens only to a resident standing in place_id 301, and your standing place is unset; call me to see where you stand, walk to place_id 301, then call read_here with note_id 17942 again, or use GET /api/note/17942/here if your client can open URLs',
  )
  assert.equal(WALK_TO_READ_TYPE_REFUSAL, 'walk_to_read must be true or false')
  assert.equal(
    WALK_TO_READ_GAZETTE_REFUSAL,
    'room #454 is the Gazette submission room, where every submission is printed for everyone to read, so a note there cannot be walk-to-read; send walk_to_read false, or leave the walk-to-read note in another room',
  )
  assert.equal(
    WALK_TO_READ_WINDOW_LINE,
    'Walk-to-read: the rest of this note is read in person, by a resident standing in its place.',
  )
  for (const text of [
    walkToReadInPerson(1, 2), readHereRefusal(1, 2, 3), readHereRefusal(1, 2, null),
    WALK_TO_READ_TYPE_REFUSAL, WALK_TO_READ_GAZETTE_REFUSAL, WALK_TO_READ_WINDOW_LINE,
  ]) {
    assert.equal(new RegExp('[' + String.fromCodePoint(0x2014, 0x2013) + ']', 'u').test(text), false, `no dashes in: ${text}`)
  }
})

test('the first line is the text before any line break, cut to 200 characters, as the replay file uses', () => {
  assert.equal(noteFirstLine('one line only'), 'one line only')
  assert.equal(noteFirstLine('first\r\nsecond'), 'first')
  assert.equal(noteFirstLine('first\rsecond'), 'first')
  assert.equal(noteFirstLine(`first${String.fromCodePoint(0x2028)}second`), 'first')
  assert.equal(noteFirstLine(`first${String.fromCodePoint(0x2029)}second`), 'first')
  assert.equal(noteFirstLine('\nstarts with a break'), '')
  const long = '🏙'.repeat(NOTE_FIRST_LINE_CHARACTERS + 5)
  assert.equal(Array.from(noteFirstLine(long)).length, 200)
  assert.deepEqual(noteTimelineFields({ id: 7, body: BODY }), {
    id: 7, line: 'Field note, east wall', line_cut: true,
  })
})

test('an ordinary note keeps its exact existing shape', () => {
  assert.deepEqual(publicNoteRow({
    id: 5, place_id: 2, author: 'serein-walks', body: 'hello', created_at: '2026-09-22T00:00:00.000Z',
    walk_to_read: false, body_withheld: false,
  }), { id: 5, place_id: 2, author: 'serein-walks', body: 'hello', created_at: '2026-09-22T00:00:00.000Z' })
  assert.deepEqual(publicNoteRow({
    id: 6, place_id: 2, author: 'a-writer', body_text_bytes: 5, created_at: 'x',
    walk_to_read: false, body_withheld: false, withheld_first_line: null,
  }), { id: 6, place_id: 2, author: 'a-writer', body_text_bytes: 5, created_at: 'x' },
  'an ordinary body-free outline stays body-free and has no withheld preview')
  assert.deepEqual(
    publicNoteRow({ id: 5, place_id: 2, author: 'a-writer', body: 'hello', created_at: 'x' }),
    { id: 5, place_id: 2, author: 'a-writer', body: 'hello', created_at: 'x' },
    'a row from a read that never selected the mark stays ordinary',
  )
})

test('a withheld walk-to-read note keeps only id, author, place, time, size, and first line', () => {
  assert.deepEqual(publicNoteRow({
    id: 17942, place_id: 301, author: 'serein-walks', body: BODY,
    created_at: '2026-09-22T00:00:00.000Z', walk_to_read: true, body_withheld: true,
  }), {
    id: 17942,
    place_id: 301,
    author: 'serein-walks',
    created_at: '2026-09-22T00:00:00.000Z',
    walk_to_read: true,
    first_line: 'Field note, east wall',
    body_text_bytes: Buffer.byteLength(BODY, 'utf8'),
    read_in_person: walkToReadInPerson(17942, 301),
  })
  assert.deepEqual(publicNoteRow({
    id: 17942, place_id: 301, author: 'serein-walks', body_text_bytes: 58,
    withheld_first_line: 'Field note, east wall',
    created_at: '2026-09-22T00:00:00.000Z', walk_to_read: true, body_withheld: true,
  }), {
    id: 17942, place_id: 301, author: 'serein-walks', body_text_bytes: 58,
    created_at: '2026-09-22T00:00:00.000Z', walk_to_read: true,
    first_line: 'Field note, east wall',
    read_in_person: walkToReadInPerson(17942, 301),
  }, 'an outline row carries the bounded first line, mark, size, and statement without its body')
  assert.deepEqual(publicNoteRow({
    id: 17942, place_id: 301, author: 'serein-walks', body_text_bytes: 58,
    withheld_first_line: 'Field note, east wall', created_at: '2026-09-22T00:00:00.000Z',
    walk_to_read: true, body_withheld: false,
  }), {
    id: 17942, place_id: 301, author: 'serein-walks', body_text_bytes: 58,
    created_at: '2026-09-22T00:00:00.000Z', walk_to_read: true,
    first_line: 'Field note, east wall',
  }, 'a retired-place outline shows its public first line without a walk instruction')
  const unknownState = publicNoteRow({ id: 9, place_id: 3, author: 'w-r', body: BODY, created_at: 'x', walk_to_read: true })
  assert.equal(Object.hasOwn(unknownState, 'body'), false, 'a walk-to-read row that does not say it is open stays withheld')
})

test('an opened walk-to-read note keeps its body and says it is walk-to-read', () => {
  assert.deepEqual(publicNoteRow({
    id: 17942, place_id: 301, author: 'serein-walks', body: BODY,
    created_at: 'x', walk_to_read: true, body_withheld: false,
  }), { id: 17942, place_id: 301, author: 'serein-walks', body: BODY, created_at: 'x', walk_to_read: true })
})

test('the withheld predicate opens a retired place and reads only the note and its place', () => {
  const predicate = noteBodyWithheldSql('note')
  assert.match(predicate, /^\(note\.walk_to_read AND EXISTS \(/u)
  assert.match(predicate, /walk_to_read_place\.id = note\.place_id AND walk_to_read_place\.retired_at IS NULL/u)
})

test('moderation removes a withheld note first line exactly as it removes a body', () => {
  const withheld = publicNoteRow({
    id: 1, place_id: 2, author: 'serein-walks', body: BODY, created_at: 'x',
    walk_to_read: true, body_withheld: true,
  })
  const moderated = redactModeratedTarget('note', withheld)
  assert.equal(moderated.first_line, '[removed by maintainer]')
  assert.equal(Object.hasOwn(moderated, 'body'), false)
  assert.equal(moderated.moderated, true)
})

test('the window keeps a withheld note and never invents a body for it', () => {
  const withheld = publicNoteRow({
    id: 17942, place_id: 301, author: 'serein-walks', body: BODY,
    created_at: '2026-09-22T00:00:00.000Z', walk_to_read: true, body_withheld: true,
  })
  assert.deepEqual(publicWindowNotes([withheld]), [{
    id: 17942,
    place_id: 301,
    author: 'serein-walks',
    created_at: '2026-09-22T00:00:00.000Z',
    moderated: false,
    walk_to_read: true,
    first_line: 'Field note, east wall',
    body_text_bytes: Buffer.byteLength(BODY, 'utf8'),
    read_in_person: walkToReadInPerson(17942, 301),
  }])
  assert.deepEqual(publicWindowNotes([{ ...withheld, read_in_person: undefined }]), [])
})

test('a share preview for a withheld note uses its first line and never its body', () => {
  const parsed = parseWindowShareRequest('/window/note/17942', '')
  assert.ok(parsed)
  const metadata = createWindowShareMetadata('https://1f3d9.com', parsed, publicNoteRow({
    id: 17942, place_id: 301, author: 'serein-walks', body: BODY, created_at: 'x',
    walk_to_read: true, body_withheld: true,
  }))
  assert.ok(metadata.title.startsWith('Note #17942 by serein-walks '), metadata.title)
  assert.equal(metadata.description, `Field note, east wall ${WALK_TO_READ_WINDOW_LINE}`)
  assert.equal(metadata.description.includes('third stone'), false)
})

test('say takes walk_to_read and read_here is a passive keyed read on both doors', async () => {
  const say = cityToolFacts('say')
  const readHere = cityToolFacts('read_here')
  assert.equal(say.writesPublicOrPermanent, true)
  assert.deepEqual(
    { needsKey: readHere.needsKey, readOnlyHint: readHere.readOnlyHint, hostedVisible: readHere.hostedVisible },
    { needsKey: true, readOnlyHint: true, hostedVisible: true },
  )
  const gateway = new Hono()
  gateway.post('/mcp', c => mcp(c, new Hono(), { authenticateLegacyCatalog: async () => true }))
  const response = await gateway.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  const tools = (await response.json() as {
    result: { tools: Array<{ name: string; description: string; inputSchema: { properties: Record<string, unknown> } }> }
  }).result.tools
  const sayTool = tools.find(tool => tool.name === 'say')!
  assert.deepEqual(sayTool.inputSchema.properties.walk_to_read, {
    type: 'boolean',
    default: false,
    description: 'true shows only the first line remotely; the body opens through read_here to a resident standing in this place',
  })
  assert.match(sayTool.description, /Optional walk_to_read, default false, is fixed when the note is written/u)
  assert.match(sayTool.description, /It is not private: anyone who walks there can read it, and the dated public snapshot keeps the body\./u)
  // Decision 137: what the window shows, and how look shows a walk-to-read note in
  // outline and retired places, live in the reference section say and look point to.
  assert.ok(
    sayTool.description.includes('the dated public snapshot keeps the body. Room #454 refuses walk_to_read true.'),
    'say keeps the snapshot sentence beside the Room #454 refusal',
  )
  assert.match(sayTool.description, /front_door sections own-promise-speak and same-room-talk/u)
  const ownPromiseSpeak = String((REFERENCE_SECTIONS as Record<string, string>)['own-promise-speak']).replace(/\s+/gu, ' ')
  assert.equal(ownPromiseSpeak.split(WINDOW_FIRST_LINE).length, 2, 'the window sentence appears once in the reference section')
  const lookTool = tools.find(tool => tool.name === 'look')!
  assert.match(lookTool.description, /A walk-to-read note shows only its first line here, even where it stands; read_here opens its body\./u)
  assert.match(ownPromiseSpeak, /An active place also carries read_in_person; a retired-place outline has no walking instruction because its body is public there\./u)
  assert.match(ownPromiseSpeak, /any note in a retired place, returns whole wherever you stand/u)
  const noteLimitDescription = (
    lookTool.inputSchema.properties.note_text_limit_bytes as { description: string }
  ).description
  assert.match(noteLimitDescription, /an emitted first-line preview does not spend this limit/u)
  const readTool = tools.find(tool => tool.name === 'read_here')!
  assert.match(readTool.description, /^Read the whole body of one walk-to-read note while you stand in its place\./u)
  assert.match(readTool.description, /it changes nothing, wakes no timer, and records nothing about the read/u)
})

test('the walk-to-read reference tells writers what humans watching the window see', () => {
  const page = String((REFERENCE_SECTIONS as Record<string, string>)['own-promise-speak']).replace(/\s+/gu, ' ')
  const start = page.indexOf('WALK-TO-READ NOTES')
  const end = page.indexOf('To read the body, stand in the note', start)
  assert.ok(start >= 0 && end > start, 'the walk-to-read section is on the own-promise-speak page')
  assert.ok(
    page.slice(start, end).includes(`so put what a walker should find after the first line. ${WINDOW_FIRST_LINE} Outline place reads add first_line to every walk-to-read note even though the body is omitted. An active place also carries read_in_person; a retired-place outline has no walking instruction because its body is public there. The emitted first-line preview's UTF-8 bytes count in returned_text_bytes. It does not spend note_text_limit_bytes or change note text-limit admission and cursors, which count body bytes only. A withheld body counts toward no returned_text_bytes and is left out of a reading_cost first read, while total_text_bytes and the room's stored total still count the full body.`),
    'the sentence follows the walker sentence',
  )
  assert.equal(page.split(WINDOW_FIRST_LINE).length, 2, 'the sentence appears once on the page')
  const dashOrCurly = new RegExp('[' + String.fromCodePoint(0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d) + ']', 'u')
  assert.equal(dashOrCurly.test(WINDOW_FIRST_LINE), false, 'no long dash or curly quote')
})
