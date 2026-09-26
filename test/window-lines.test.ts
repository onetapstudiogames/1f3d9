import assert from 'node:assert/strict'
import test from 'node:test'
import { parseWindowHistoryQuery, publicWindowLines, windowCollectionStatement } from '../src/window.ts'

const one = (query: Record<string, string>): Record<string, string[]> =>
  Object.fromEntries(Object.entries(query).map(([key, value]) => [key, [value]]))

test('the window history read accepts collection lines with the note filters', () => {
  const parsed = parseWindowHistoryQuery(one({
    collection: 'lines', within_place_id: '7', resident: 'smokecheck', before_id: '90', limit: '50',
  }))
  assert.equal(parsed?.collection, 'lines')
  assert.equal(parsed?.placeId, 7)
  assert.equal(parsed?.includeDescendants, true)
  assert.equal(parsed?.resident, 'smokecheck')
  assert.equal(parsed?.beforeId, 90)
  assert.equal(parsed?.limit, 50)
})

test('collection lines refuses the note context, thing headings, and find', () => {
  assert.equal(parseWindowHistoryQuery(one({ collection: 'lines', resident: 'smokecheck', context: 'place' })), null)
  assert.equal(parseWindowHistoryQuery(one({ collection: 'lines', presentation: 'headings' })), null)
  assert.equal(parseWindowHistoryQuery(one({ collection: 'lines', find: 'hello' })), null)
})

test('the lines statement reads room_lines newest first and a resident filter skips removed lines', () => {
  const plain = windowCollectionStatement(parseWindowHistoryQuery(one({ collection: 'lines', place_id: '7' }))!)
  assert.match(plain.text, /FROM room_lines line JOIN residents author ON author\.id = line\.resident_id/u)
  assert.match(plain.text, /ORDER BY line\.id DESC/u)
  const filtered = windowCollectionStatement(parseWindowHistoryQuery(one({ collection: 'lines', resident: 'smokecheck' }))!)
  assert.match(filtered.text, /\$3::text IS NULL OR \(author\.handle = \$3::text AND/u)
  assert.match(filtered.text, /moderation\.target_type = 'line' AND moderation\.target_id = line\.id/u)
})

test('publicWindowLines keeps a whole visible line and turns a removed one into its id alone', () => {
  assert.deepEqual(publicWindowLines([
    { id: 5, place_id: 7, author: 'smokecheck', body: 'hello there', created_at: '2026-09-26T10:00:00.000Z' },
    { id: 4, moderated: true },
    { id: 3, place_id: 7, author: 'Not A Handle', body: 'x', created_at: '2026-09-26T10:00:00.000Z' },
    { id: 2, place_id: 7, author: 'smokecheck', body: '', created_at: '2026-09-26T10:00:00.000Z' },
    { id: 1, place_id: 7, author: 'smokecheck', body: 'no time' },
  ]), [
    { id: 5, place_id: 7, author: 'smokecheck', body: 'hello there', created_at: '2026-09-26T10:00:00.000Z' },
    { id: 4, moderated: true },
  ])
})
