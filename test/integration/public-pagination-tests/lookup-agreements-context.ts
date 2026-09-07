import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { statementCount } from '../../helpers/public-pagination-fixtures/postgres.ts'
import type { WindowModule } from '../../helpers/public-pagination-fixtures/window.ts'
import type { TestContext } from 'node:test'
import type { PostgresInstance } from '../../helpers/public-pagination-fixtures/postgres.ts'
import type { SeededCity } from '../../helpers/public-pagination-fixtures/seed-city.ts'

export async function registerLookupAgreementsContextTests(
  t: TestContext,
  postgres: PostgresInstance,
  city: SeededCity,
): Promise<void> {
  await t.test('thing heading lookup filters the latest moderation action before matching names', async () => {
    const client = await postgres.client.connect()
    try {
      await client.query('BEGIN')
      const storedCredentialName = `1f3d9_sk_${'ab'.repeat(24)}`
      const thingId = (await client.query<{ id: number }>(`
          INSERT INTO things (place_id, name, body, owner_id, maker_id)
          VALUES ($1, $2, 'legacy stored credential fixture', 1, 1)
          RETURNING id
        `, [city.targetPlaceId, storedCredentialName])).rows[0]!.id
      const ordinaryThingId = (await client.query<{ id: number }>(`
          INSERT INTO things (place_id, name, body, owner_id, maker_id)
          VALUES ($1, 'abababab public marker', 'ordinary fixture', 1, 1)
          RETURNING id
        `, [city.targetPlaceId])).rows[0]!.id
      const bodyOnlyThingId = (await client.query<{ id: number }>(`
          INSERT INTO things (place_id, name, body, owner_id, maker_id)
          VALUES ($1, 'quiet fixture', 'abababab appears only in this body', 1, 1)
          RETURNING id
        `, [city.targetPlaceId])).rows[0]!.id
      const windowModule: WindowModule = await import('../../../src/window.ts')
      const statement = () => windowModule.windowCollectionStatement({
        collection: 'things', beforeId: null, limit: 20, placeId: null,
        includeDescendants: false, resident: null, context: false,
        presentation: 'headings', find: 'abababab',
      })
      const selectedIds = async () => {
        const query = statement()
        return (await client.query<{ id: number }>(query.text, [...query.values]))
          .rows.map(row => row.id)
      }

      assert.ok(!(await selectedIds()).includes(thingId),
        'a raw credential-like name must never act as a substring oracle')
      assert.ok((await selectedIds()).includes(ordinaryThingId))
      assert.ok(!(await selectedIds()).includes(bodyOnlyThingId),
        'thing heading search must not match body-only text')
      await client.query(`
          INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
          VALUES ('thing', $1, 'remove', 1, 'integration removal')
        `, [ordinaryThingId])
      assert.ok(!(await selectedIds()).includes(thingId),
        'a removed raw name must not act as a substring oracle')
      assert.ok(!(await selectedIds()).includes(ordinaryThingId))
      await client.query(`
          INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
          VALUES ('thing', $1, 'restore', 1, 'integration restoration')
        `, [ordinaryThingId])
      assert.ok(!(await selectedIds()).includes(thingId),
        'restoring a credential-like name must not make it searchable')
      assert.ok((await selectedIds()).includes(ordinaryThingId))
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })

  await t.test('agreement party and open filters keep exact totals in every combination', async () => {
    const { default: cityApp } = await import('../../../src/index.ts')
    for (const party of [null, 'resident-1']) {
      for (const open of [true, false]) {
        const query = new URLSearchParams({ limit: '200', open: String(open) })
        if (party !== null) query.set('party', party)
        const response = await cityApp.request(`http://city.test/api/agreements?${query}`)
        assert.equal(response.status, 200)
        const body = await response.json() as {
          agreements: Array<{ body: string }>
          total_items: number
          total_text_bytes: number
          returned_items: number
          returned_text_bytes: number
        }
        const returnedBytes = body.agreements.reduce(
          (total, agreement) => total + Buffer.byteLength(agreement.body, 'utf8'),
          0,
        )
        const label = JSON.stringify({ party, open })
        assert.equal(body.total_items, body.agreements.length, `${label}:items`)
        assert.equal(body.returned_items, body.agreements.length, `${label}:returned items`)
        assert.equal(body.total_text_bytes, returnedBytes, `${label}:bytes`)
        assert.equal(body.returned_text_bytes, returnedBytes, `${label}:returned bytes`)
      }
    }
  })

  await t.test('a followed resident view carries same-place context', async () => {
    const client = postgres.client
    const room = (await client.query<{ id: number }>(
      `INSERT INTO places (parent_id, place_kind, name, owner_id)
         SELECT id, 'place', 'Context Room', 1
         FROM places WHERE name = 'Pagination Continent'
         RETURNING id`,
    )).rows[0]!.id
    const quietRoom = (await client.query<{ id: number }>(
      `INSERT INTO places (parent_id, place_kind, name, owner_id)
         SELECT id, 'place', 'Quiet Room', 1
         FROM places WHERE name = 'Pagination Continent'
         RETURNING id`,
    )).rows[0]!.id
    const say = async (placeId: number, residentId: number, body: string) => (
      await client.query<{ id: number }>(
        `INSERT INTO notes (place_id, author_id, body) VALUES ($1, $2, $3) RETURNING id`,
        [placeId, residentId, body],
      )
    ).rows[0]!.id
    // resident-5 speaks twice in the room and once in a second room; others
    // answer around them; an unrelated room stays out of the slice.
    const before = await say(room, 6, 'the question before')
    const own1 = await say(room, 5, 'first own note')
    const reply1 = await say(room, 7, 'an answer right after')
    const drift = await say(room, 7, 'the room drifts on')
    const own2 = await say(room, 5, 'second own note')
    const reply2 = await say(room, 6, 'a late answer')
    const unrelated = await say(quietRoom, 6, 'somewhere else entirely')
    const own3 = await say(quietRoom, 5, 'own note in the quiet room')

    const windowModule: WindowModule = await import('../../../src/window.ts')
    const contextQuery = (limit: number, beforeId: number | null) => Object.freeze({
      collection: 'notes' as const,
      beforeId,
      limit,
      placeId: null,
      resident: 'resident-5',
      context: true,
    })
    const firstPage = await windowModule.readWindowCollectionPage(contextQuery(10, null))
    const firstIds = firstPage.items.map(item => item.id)
    // Own notes and their neighbors, newest first; the unrelated quiet-room
    // note only appears because resident-5 later spoke there (it is a
    // same-place neighbor of own3), which is exactly the intended context.
    assert.deepEqual(
      firstIds,
      [own3, unrelated, reply2, own2, drift, reply1, own1, before],
    )
    assert.equal(firstPage.hasMore, false)
    const authors = new Map(firstPage.items.map(item => [
      item.id, (item as { author: string }).author,
    ]))
    assert.equal(authors.get(own1), 'resident-5')
    assert.equal(authors.get(reply1), 'resident-7')

    // The cursor pages over the resident's own notes alone: limit 1 shows
    // the newest own note with its context and points at it for the next
    // older page.
    const paged = await windowModule.readWindowCollectionPage(contextQuery(1, null))
    assert.equal(paged.hasMore, true)
    assert.equal(paged.nextBeforeId, own3)
    assert.ok(paged.items.some(item => item.id === own3))
    assert.ok(!paged.items.some(item => item.id === own1))
    const olderPage = await windowModule.readWindowCollectionPage(contextQuery(1, paged.nextBeforeId))
    assert.ok(olderPage.items.some(item => item.id === own2))
    assert.equal(olderPage.nextBeforeId, own2)

    // Context never carries the followed resident, and no page shows a
    // context note whose own note was trimmed to the next page.
    const anchored = await windowModule.readWindowCollectionPage(Object.freeze({
      collection: 'notes' as const,
      beforeId: null,
      limit: 1,
      placeId: room,
      resident: 'resident-5',
      context: true,
    }))
    // own2 is the only kept own note: it brings its two neighbors below
    // (drift, reply1) and one above (reply2). `before` belongs to own1,
    // which was trimmed to the next page, so it must not appear.
    assert.deepEqual(
      anchored.items.map(item => item.id),
      [reply2, own2, drift, reply1],
      'only the kept own note anchors context',
    )
    assert.ok(!anchored.items.some(item => item.id === before))
    assert.ok(!anchored.items.some(item => (item as { author: string }).author === 'resident-5'
      && item.id !== own2))

    // The route bounds a context page so the whole page fits the row cap.
    const bounded = windowModule.parseWindowHistoryQuery({
      collection: ['notes'], resident: ['resident-5'], context: ['place'], limit: ['200'],
    })
    assert.equal(bounded?.limit, windowModule.NOTE_CONTEXT_PAGE_MAX)

    // The route rejects context without a resident before touching SQL.
    const app = new Hono()
    app.get('/api/window', windowModule.windowSnapshot)
    const statementsBefore = statementCount
    const invalid = await app.request(
      'http://city.test/api/window?collection=notes&context=place',
    )
    assert.equal(invalid.status, 400)
    assert.equal(statementCount, statementsBefore)
    const valid = await app.request(
      'http://city.test/api/window?collection=notes&resident=resident-5&context=place&limit=25',
    )
    assert.equal(valid.status, 200)
    const payload = await valid.json() as { notes: Array<{ id: number }>; has_more: boolean }
    assert.deepEqual(
      payload.notes.map(note => note.id),
      [own3, unrelated, reply2, own2, drift, reply1, own1, before],
    )

    // Regression: consecutive own notes straddling a page boundary. The
    // resident's own note from the previous page must never return as a
    // context row — counting it again froze the cursor and buried the note
    // underneath it, the exact "falsely silent" failure this view fixes.
    const monologue = (await client.query<{ id: number }>(
      `INSERT INTO places (parent_id, place_kind, name, owner_id)
         SELECT id, 'place', 'Monologue Room', 1
         FROM places WHERE name = 'Pagination Continent'
         RETURNING id`,
    )).rows[0]!.id
    const solo1 = await say(monologue, 5, 'first of three in a row')
    const solo2 = await say(monologue, 5, 'second of three in a row')
    const solo3 = await say(monologue, 5, 'third of three in a row')
    const soloQuery = (beforeId: number | null) => Object.freeze({
      collection: 'notes' as const,
      beforeId,
      limit: 1,
      placeId: monologue,
      resident: 'resident-5',
      context: true,
    })
    const soloFirst = await windowModule.readWindowCollectionPage(soloQuery(null))
    assert.deepEqual(soloFirst.items.map(item => item.id), [solo3])
    assert.equal(soloFirst.nextBeforeId, solo3)
    const soloSecond = await windowModule.readWindowCollectionPage(soloQuery(soloFirst.nextBeforeId))
    assert.deepEqual(soloSecond.items.map(item => item.id), [solo2])
    assert.equal(soloSecond.nextBeforeId, solo2, 'the cursor must advance past every own note')
    const soloThird = await windowModule.readWindowCollectionPage(soloQuery(soloSecond.nextBeforeId))
    assert.deepEqual(soloThird.items.map(item => item.id), [solo1])
    assert.equal(soloThird.hasMore, false)
    assert.equal(soloThird.nextBeforeId, null)
  })
}
