// docs/TASKS.md asked for this before anyone changes the window's global
// conversation query: the city-wide notes list must stay newest first across
// every room, never grouped by room, and its pages must continue across rooms
// without skipping or repeating a note. The unit suites answer that query from
// a fake, so only real PostgreSQL can prove the ordering.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  connectedDatabase,
  resetCity,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const RESIDENTS = Object.freeze([
  Object.freeze({ id: 1, handle: 'order-keeper', secret: `1f3d9_sk_${'1'.repeat(48)}` }),
  Object.freeze({ id: 2, handle: 'order-writer', secret: `1f3d9_sk_${'2'.repeat(48)}` }),
])

type WindowNote = Readonly<{ id: number; place_id: number; author: string; body: string }>
type NotesPage = Readonly<{
  notes: readonly WindowNote[]
  has_more: boolean
  next_before_id: number | null
}>

test('the window lists recent notes newest first across rooms and pages across them', {
  timeout: 180_000,
}, async t => {
  const postgres = await startNoteSuiteDatabase('window-note-order')
  try {
    const { default: cityApp } = await import('../../src/index.ts')
    const rooms = await resetCity(RESIDENTS)
    // Six notes alternate between two rooms, oldest first, so a list grouped by
    // room or ordered by place would fail the exact order below.
    const written: WindowNote[] = []
    for (let index = 0; index < 6; index += 1) {
      const placeId = index % 2 === 0 ? rooms.eastRoomId : rooms.westRoomId
      const body = `order note ${index + 1} in ${placeId === rooms.eastRoomId ? 'east' : 'west'}`
      const row = (await connectedDatabase().query<{ id: number }>(`
        INSERT INTO notes (place_id, author_id, body, created_at)
        VALUES ($1, 2, $2, '2026-09-01T00:00:00Z'::timestamptz + $3::integer * interval '1 second')
        RETURNING id
      `, [placeId, body, index])).rows[0]!
      written.push(Object.freeze({ id: row.id, place_id: placeId, author: 'order-writer', body }))
    }
    const newestFirst = [...written].reverse()

    await t.test('one city-wide page returns every room interleaved, newest first', async () => {
      const response = await cityApp.request('http://city.test/api/window?collection=notes&limit=10')
      assert.equal(response.status, 200, await response.clone().text())
      const page = await response.json() as NotesPage
      assert.deepEqual(
        page.notes.map(note => ({ id: note.id, place_id: note.place_id, author: note.author, body: note.body })),
        newestFirst,
      )
      assert.equal(page.has_more, false)
      assert.equal(page.next_before_id, null)
    })

    await t.test('small pages continue across rooms without skipping or repeating a note', async () => {
      const seen: number[] = []
      let before: number | null = null
      for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
        const query = new URLSearchParams({ collection: 'notes', limit: '4' })
        if (before !== null) query.set('before_id', String(before))
        const response = await cityApp.request(`http://city.test/api/window?${query}`)
        assert.equal(response.status, 200, await response.clone().text())
        const page = await response.json() as NotesPage
        seen.push(...page.notes.map(note => note.id))
        if (!page.has_more) break
        before = page.next_before_id
        assert.ok(before !== null, 'a page with more notes names its next cursor')
      }
      assert.deepEqual(seen, newestFirst.map(note => note.id))
    })

    await t.test('a place filter keeps the same newest-first order inside one room', async () => {
      const response = await cityApp.request(
        `http://city.test/api/window?collection=notes&place_id=${rooms.westRoomId}`,
      )
      assert.equal(response.status, 200, await response.clone().text())
      const page = await response.json() as NotesPage
      assert.deepEqual(
        page.notes.map(note => note.id),
        newestFirst.filter(note => note.place_id === rooms.westRoomId).map(note => note.id),
      )
    })

    await t.test('the outline window snapshot shows the same interleaved order', async () => {
      const response = await cityApp.request('http://city.test/api/window?view=outline')
      assert.equal(response.status, 200, await response.clone().text())
      const snapshot = await response.json() as Readonly<{ notes: readonly WindowNote[] }>
      assert.deepEqual(snapshot.notes.map(note => note.id), newestFirst.map(note => note.id))
    })
  } finally {
    await postgres.stop()
  }
})
