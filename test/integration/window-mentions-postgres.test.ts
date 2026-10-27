import assert from 'node:assert/strict'
import test from 'node:test'
import {
  connectedDatabase,
  resetCity,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const RESIDENTS = Object.freeze([
  Object.freeze({ id: 1, handle: 'founder', secret: `1f3d9_sk_${'1'.repeat(48)}` }),
  Object.freeze({ id: 2, handle: 'selene', secret: `1f3d9_sk_${'2'.repeat(48)}` }),
  Object.freeze({ id: 3, handle: 'moon-reader', secret: `1f3d9_sk_${'3'.repeat(48)}` }),
  Object.freeze({ id: 6, handle: 'rare-reader', secret: `1f3d9_sk_${'6'.repeat(48)}` }),
  Object.freeze({ id: 5, handle: 'absent-reader', secret: `1f3d9_sk_${'5'.repeat(48)}` }),
])

type Note = Readonly<{ id: number; place_id: number; author: string; body: string }>
type Page = Readonly<{ notes: readonly Note[]; has_more: boolean; next_before_id: number | null }>

async function writeNote(placeId: number, body: string, authorId = 3, walkToRead = false): Promise<number> {
  return (await connectedDatabase().query<{ id: number }>(`
    INSERT INTO notes (place_id, author_id, body, walk_to_read)
    VALUES ($1, $2, $3, $4) RETURNING id
  `, [placeId, authorId, body, walkToRead])).rows[0]!.id
}

async function removeNote(id: number): Promise<void> {
  await connectedDatabase().query(`
    INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
    VALUES ('note', $1, 'remove', 1, 'test removed note')
  `, [id])
}

test('public window mentions use whole handles, public exclusions and bounded newest-first pages', {
  timeout: 180_000,
}, async t => {
  const postgres = await startNoteSuiteDatabase('window-mentions')
  try {
    const { default: cityApp } = await import('../../src/index.ts')
    const readPage = async (query = 'mentions=selene&limit=25'): Promise<Page> => {
      const response = await cityApp.request(`http://city.test/api/window?collection=notes&${query}`)
      assert.equal(response.status, 200, await response.clone().text())
      return response.json() as Promise<Page>
    }

    await t.test('the requested mentions route returns public notes naming one resident', async () => {
      const rooms = await resetCity(RESIDENTS)
      const self = await writeNote(rooms.eastRoomId, 'I am selene.', 2)
      const other = await writeNote(rooms.westRoomId, '@SeLeNe, moon-reader and selene.', 3)
      await writeNote(rooms.eastRoomId, 'selene-sky sky-selene selene2')
      assert.deepEqual((await readPage()).notes.map(note => note.id), [other, self])
      const authored = await readPage('resident=selene')
      assert.deepEqual(authored.notes.map(note => note.id), [self])
      assert.deepEqual((await readPage('mentions=unknown-reader')).notes, [])
      assert.equal((await readPage('mentions=unknown-reader')).has_more, false)
    })

    await t.test('SQL and browser tokens agree across case, punctuation and non-ASCII neighbors', async () => {
      const { HANDLE_MENTION_TOKEN_SOURCE, wholeHandleMentionSql } = await import('../../src/handle-mentions.ts')
      const bodies = [
        'selene', '@SeLeNe', '(selene),selene', 'selene-sky', 'sky-selene', 'selene2',
        '_selene_', '\u00e9selene\u96e8', '@moon-reader', 'moon-reader-more', '-selene',
        'selene,selene', 'SELENE\n@selene', 'unknown-reader',
        '\u212Aselene', 'selene\u212A', '\u212Aelvin', '\u017Fselene', '\u017Felene', '\u017Felenes',
      ]
      for (const handle of ['selene', 'moon-reader', 'kelvin', 'selenes']) {
        for (const body of bodies) {
          const browserMatch = [...body.matchAll(new RegExp(HANDLE_MENTION_TOKEN_SOURCE, 'gi'))]
            .some(match => match[0].toLowerCase() === handle)
          const rows = await connectedDatabase().query<{ matches: boolean }>(
            `SELECT ${wholeHandleMentionSql('$1::text', '$2::text')} AS matches`, [body, handle],
          )
          assert.equal(rows.rows[0]!.matches, browserMatch, `${handle}: ${body}`)
        }
      }
    })

    await t.test('feed, walk-to-read, removed and credential-shaped notes stay out before paging', async () => {
      const rooms = await resetCity(RESIDENTS)
      await connectedDatabase().query('UPDATE places SET quiet = true, feed = true WHERE id = $1', [rooms.westRoomId])
      const publicId = await writeNote(rooms.eastRoomId, 'hello selene')
      await writeNote(rooms.westRoomId, 'selene in the feed')
      await writeNote(rooms.eastRoomId, 'selene read in person', 3, true)
      const removed = await writeNote(rooms.eastRoomId, 'selene removed')
      await removeNote(removed)
      await writeNote(rooms.eastRoomId, `selene 1f3d9_sk_${'a'.repeat(48)}`)
      const retired = (await connectedDatabase().query<{ id: number }>(`
        INSERT INTO places (parent_id, place_kind, name, description, owner_id)
        VALUES ($1, 'place', 'Retired Room', 'old room', 1) RETURNING id
      `, [rooms.continentId])).rows[0]!.id
      await writeNote(retired, 'selene old walk note', 3, true)
      await connectedDatabase().query('UPDATE places SET retired_at = now() WHERE id = $1', [retired])
      const page = await readPage('mentions=selene&limit=1')
      assert.deepEqual(page.notes.map(note => note.id), [publicId])
      assert.equal(page.has_more, false)
      assert.equal(page.next_before_id, null)
      await connectedDatabase().query(`
        INSERT INTO resident_mutes (resident_id, target_type, target_id, choice)
        VALUES (2, 'resident', 3, 'mute'), (2, 'place', $1, 'mute'), (2, 'note', $2, 'mute')
      `, [rooms.eastRoomId, publicId])
      assert.deepEqual(await readPage('mentions=selene&limit=1'), page)
      await connectedDatabase().query('UPDATE places SET quiet = true WHERE id = $1', [rooms.eastRoomId])
      assert.deepEqual((await readPage()).notes.map(note => note.id), [publicId])
    })

    await t.test('paging stays newest-first across rooms, new writes, moderation and exclusive bounds', async () => {
      const rooms = await resetCity(RESIDENTS)
      const ids: number[] = []
      for (let index = 0; index < 61; index += 1) {
        const placeId = index % 2 === 0 ? rooms.eastRoomId : rooms.westRoomId
        const id = await writeNote(placeId, index % 3 === 0 ? 'unrelated note' : 'selene, moon-reader, selene')
        if (index % 3 !== 0) ids.push(id)
      }
      const expected = [...ids].reverse()
      assert.equal((await readPage('mentions=selene')).notes.length, 10)
      const first = await readPage()
      assert.deepEqual(first.notes.map(note => note.id), expected.slice(0, 25))
      assert.equal(first.has_more, true)
      assert.equal(first.next_before_id, expected[24])
      await writeNote(rooms.westRoomId, 'selene new arrival')
      await removeNote(expected[28]!)
      const older = await readPage(`mentions=selene&limit=25&before_id=${first.next_before_id}`)
      assert.deepEqual(older.notes.map(note => note.id), expected.slice(25).filter(id => id !== expected[28]))
      assert.equal(older.has_more, false)
      assert.equal(older.next_before_id, null)
      const range = await readPage(`mentions=selene&before_id=${expected[10]}&after_id=${expected[20]}`)
      assert.deepEqual(range.notes.map(note => note.id), expected.slice(11, 20))
      const exact = await readPage(`mentions=selene&place_id=${rooms.eastRoomId}&limit=200`)
      assert.ok(exact.notes.every(note => note.place_id === rooms.eastRoomId))
      const nested = await readPage(`mentions=selene&within_place_id=${rooms.continentId}&limit=200`)
      assert.equal(nested.notes.length, expected.length)
    })

    await t.test('malformed, duplicate and incompatible mentions parameters use the existing refusal', async () => {
      const invalid = [
        'collection=notes&mentions=', 'collection=notes&mentions=SeLeNe',
        'collection=notes&mentions=@selene', 'collection=notes&mentions=se',
        'collection=notes&mentions=selene&mentions=selene',
        'collection=things&mentions=selene', 'collection=lines&mentions=selene',
        'collection=agreements&mentions=selene',
        'collection=notes&mentions=selene&resident=selene',
        'collection=notes&mentions=selene&context=place',
        'collection=notes&mentions=selene&find=selene',
        'collection=notes&mentions=selene&presentation=headings',
        'collection=notes&mentions=selene&limit=201',
      ]
      for (const query of invalid) {
        const response = await cityApp.request(`http://city.test/api/window?${query}`)
        assert.equal(response.status, 400, query)
        assert.match((await response.json() as { error: string }).error, /^public window history query was rejected/u)
      }
    })

    await t.test('30,000 notes keep rare, absent and common matching under the existing query budget', async () => {
      const { parseWindowHistoryQuery, windowCollectionStatement } = await import('../../src/window.ts')
      const rooms = await resetCity(RESIDENTS)
      await connectedDatabase().query(`
        INSERT INTO notes (place_id, author_id, body)
        SELECT CASE WHEN n % 2 = 0 THEN $1::integer ELSE $2::integer END, 3,
          repeat('ordinary city text ', 30) || ' selene' || CASE WHEN n = 1 THEN ' rare-reader' ELSE '' END
        FROM generate_series(1, 30000) AS n
      `, [rooms.eastRoomId, rooms.westRoomId])
      await connectedDatabase().query('ANALYZE notes')
      for (const handle of ['rare-reader', 'absent-reader', 'selene']) {
        const options = parseWindowHistoryQuery({ collection: ['notes'], mentions: [handle], limit: ['25'] })
        assert.ok(options)
        const statement = windowCollectionStatement(options)
        const plan = (await connectedDatabase().query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`, [...statement.values],
        )).rows[0]!['QUERY PLAN'][0]
        t.diagnostic(`30000 notes ${handle}: ${JSON.stringify(plan)}`)
        assert.ok(plan['Execution Time'] < 1500, `${handle} exceeded the 1500 ms budget`)
        const started = performance.now()
        const page = await readPage(`mentions=${handle}&limit=25`)
        t.diagnostic(`30000 notes ${handle}: route elapsed ${(performance.now() - started).toFixed(3)} ms`)
        assert.equal(page.notes.length, handle === 'selene' ? 25 : handle === 'rare-reader' ? 1 : 0)
      }
    })

    await t.test('an exhausted statement budget returns a retryable failure instead of an empty list', async () => {
      const blocker = await connectedDatabase().connect()
      try {
        await blocker.query('BEGIN')
        await blocker.query('LOCK TABLE notes IN ACCESS EXCLUSIVE MODE')
        const response = await cityApp.request('http://city.test/api/window?collection=notes&mentions=selene')
        assert.equal(response.status, 503, await response.clone().text())
        assert.equal(response.headers.get('Retry-After'), '1')
        const body = await response.json() as Record<string, unknown>
        assert.equal(body.error, 'public notes naming this resident are temporarily busy; retry')
        assert.equal(body.notes, undefined)
      } finally {
        await blocker.query('ROLLBACK')
        blocker.release()
      }
    })

    await t.test('busy admission does not start an unbounded mention read', async () => {
      const blockers = await Promise.all([connectedDatabase().connect(), connectedDatabase().connect()])
      try {
        for (const [slot, blocker] of blockers.entries()) {
          await blocker.query('BEGIN')
          await blocker.query('SELECT pg_advisory_xact_lock(524128259, $1)', [slot])
        }
        const response = await cityApp.request('http://city.test/api/window?collection=notes&mentions=selene')
        assert.equal(response.status, 503, await response.clone().text())
        assert.equal(response.headers.get('Retry-After'), '1')
        assert.equal((await response.json() as { error: string }).error,
          'public notes naming this resident are temporarily busy; retry')
      } finally {
        for (const blocker of blockers) {
          await blocker.query('ROLLBACK')
          blocker.release()
        }
      }
    })
  } finally {
    await postgres.stop()
  }
})
