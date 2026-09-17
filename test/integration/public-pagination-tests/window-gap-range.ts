import assert from 'node:assert/strict'
import { loadPublicEventRows, type PublicQueryExecutor } from '../../../src/public-pagination.ts'
import { page, rowIds } from '../../helpers/public-pagination-fixtures/pagination.ts'
import type { WindowModule } from '../../helpers/public-pagination-fixtures/window.ts'
import type { TestContext } from 'node:test'
import type { PostgresInstance } from '../../helpers/public-pagination-fixtures/postgres.ts'
import type { SeededCity } from '../../helpers/public-pagination-fixtures/seed-city.ts'

// The gap read answers one question: every record of this list between two ids,
// under the filters the list already sends. These run against the real schema
// and the real moderation overlay, because a gap that silently keeps or drops a
// record is exactly what the window used to guess at.
export async function registerWindowGapRangeTests(
  t: TestContext,
  postgres: PostgresInstance,
  city: SeededCity,
): Promise<void> {
  await t.test('a bounded range read answers one list between two ids under its own filters', async () => {
    const pool = postgres.client
    const windowModule: WindowModule = await import('../../../src/window.ts')
    const query: PublicQueryExecutor = async (text, values) => (
      await pool.query(text, [...values])
    ).rows as Record<string, unknown>[]

    const placeId = (await pool.query<{ id: number }>(
      `INSERT INTO places (parent_id, place_kind, name, owner_id)
         VALUES ($1, 'place', 'Gap-read room', 1) RETURNING id`,
      [city.targetPlaceId],
    )).rows[0]!.id
    const otherPlaceId = city.smallPlaceId
    const noteIds: number[] = []
    const thingIds: number[] = []
    // What this test writes is public history: events and moderation rows are
    // append-only by design, so it registers last and removes nothing.
    for (let index = 0; index < 12; index += 1) {
      noteIds.push((await pool.query<{ id: number }>(
        `INSERT INTO notes (place_id, author_id, body) VALUES ($1, 1, $2) RETURNING id`,
        [placeId, `gap-read note ${index}`],
      )).rows[0]!.id)
      thingIds.push((await pool.query<{ id: number }>(
        `INSERT INTO things (place_id, name, body, owner_id, maker_id)
           VALUES ($1, $2, 'gap-read thing', 1, 1) RETURNING id`,
        [placeId, `gap-read-thing-${Date.now()}-${index}`],
      )).rows[0]!.id)
    }
    // One note inside the range the city took down, and one thing inside the
    // range its owner withdrew: the two shapes a fill must survive.
    const moderatedNoteId = noteIds[5]!
    const withdrawnThingId = thingIds[5]!
    await pool.query(
      `INSERT INTO moderation_actions (target_type, target_id, action, reason, actor_id)
         VALUES ('note', $1, 'remove', 'gap-read moderation', 1)`,
      [moderatedNoteId],
    )
    await pool.query(
      `UPDATE things SET withdrawn_at = now() WHERE id = $1`, [withdrawnThingId],
    )
    // A note in another room inside the same id range proves the range keeps
    // the list's own filter rather than reading the whole city.
    const outsideNoteId = (await pool.query<{ id: number }>(
      `INSERT INTO notes (place_id, author_id, body) VALUES ($1, 1, 'gap-read outside') RETURNING id`,
      [otherPlaceId],
    )).rows[0]!.id

    const afterId = noteIds[1]!
    const beforeId = noteIds[10]!
    const notes = await windowModule.readWindowCollectionPage(Object.freeze({
      collection: 'notes' as const,
      beforeId,
      afterId,
      limit: 200,
      placeId,
      includeDescendants: false,
      resident: null,
      context: false,
    }), query)
    assert.deepEqual(
      notes.items.map(item => item.id),
      noteIds.slice(2, 10).reverse(),
      'the range answers every record strictly between the two ids, newest first',
    )
    assert.equal(notes.hasMore, false, 'a range the page covered says so')
    assert.equal(notes.nextBeforeId, null)
    assert.equal(
      notes.items.some(item => item.id === outsideNoteId), false,
      'the range keeps the place filter the list already sends',
    )
    const moderated = notes.items.find(item => item.id === moderatedNoteId) as
      undefined | { body: string; moderated?: boolean }
    assert.ok(moderated, 'a record the city took down stays in its place in the range')
    assert.equal(moderated.body, '[removed by maintainer]')
    assert.equal(moderated.moderated, true)

    const things = await windowModule.readWindowCollectionPage(Object.freeze({
      collection: 'things' as const,
      beforeId: thingIds[11]!,
      afterId: thingIds[0]!,
      limit: 200,
      placeId,
      includeDescendants: false,
      resident: null,
      context: false,
    }), query)
    assert.equal(
      things.items.some(item => item.id === withdrawnThingId), false,
      'a withdrawn thing is absent from the range, as it is from every public page',
    )
    assert.equal(things.hasMore, false)

    // Paging the range: each page carries its own next cursor and the last
    // one says the range is covered, so a fill knows when the gap is closed
    // without hunting for any particular id.
    const firstPage = await windowModule.readWindowCollectionPage(Object.freeze({
      collection: 'notes' as const,
      beforeId, afterId, limit: 3, placeId, includeDescendants: false,
      resident: null, context: false,
    }), query)
    assert.equal(firstPage.hasMore, true)
    assert.equal(firstPage.nextBeforeId, noteIds[7]!)
    let cursor: number | null = firstPage.nextBeforeId
    let collected = firstPage.items.map(item => item.id)
    while (cursor !== null) {
      const next: Awaited<ReturnType<typeof windowModule.readWindowCollectionPage>> =
        await windowModule.readWindowCollectionPage(Object.freeze({
          collection: 'notes' as const,
          beforeId: cursor, afterId, limit: 3, placeId, includeDescendants: false,
          resident: null, context: false,
        }), query)
      collected = [...collected, ...next.items.map(item => item.id)]
      cursor = next.nextBeforeId
    }
    assert.deepEqual(collected, noteIds.slice(2, 10).reverse(),
      'paging the range loads it exactly once, with no record read twice')

    const eventIds: number[] = []
    for (let index = 0; index < 6; index += 1) {
      eventIds.push((await pool.query<{ id: number }>(
        `INSERT INTO events (kind, actor, detail)
           VALUES ('laws_changed', 'resident-1', jsonb_build_object('place_id', $1::integer))
           RETURNING id`,
        [placeId],
      )).rows[0]!.id)
    }
    const events = await loadPublicEventRows(
      query,
      { kind: 'laws_changed', actor: 'resident-1', placeId, afterId: eventIds[1]! },
      page(eventIds[4]!, 200),
    )
    assert.deepEqual(rowIds(events), eventIds.slice(2, 4).reverse(),
      'the events read takes the same two ends under the same filters')
  })
}
