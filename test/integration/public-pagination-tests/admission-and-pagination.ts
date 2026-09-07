import assert from 'node:assert/strict'
import { finalizePublicPage, loadPublicEventRows, loadPublicPlaceCollectionRows, type PublicPlacePageRequests } from '../../../src/public-pagination.ts'
import { executePublicQuery } from '../../helpers/public-pagination-fixtures/postgres.ts'
import { page, rowIds } from '../../helpers/public-pagination-fixtures/pagination.ts'
import type { TestContext } from 'node:test'
import type { PostgresInstance } from '../../helpers/public-pagination-fixtures/postgres.ts'
import type { SeededCity } from '../../helpers/public-pagination-fixtures/seed-city.ts'

export async function registerAdmissionAndPaginationTests(
  t: TestContext,
  postgres: PostgresInstance,
  city: SeededCity,
): Promise<void> {
  async function allEventIds(): Promise<number[]> {
    const ids: number[] = []
    let cursor: number | null = null
    do {
      const request = page(cursor)
      const rows = await loadPublicEventRows(
        executePublicQuery,
        { kind: 'note', actor: null, placeId: null },
        request,
      )
      const result = finalizePublicPage(
        rows as readonly (Record<string, unknown> & { id: number })[],
        request.limit,
      )
      ids.push(...rowIds(result.items))
      cursor = result.hasMore ? result.nextCursor : null
    } while (cursor !== null)
    return ids
  }

  function placeRequests(
    collection: keyof PublicPlacePageRequests,
    cursor: number | null,
  ): PublicPlacePageRequests {
    const defaultPage = page(null, 1)
    return Object.freeze({
      subplaces: collection === 'subplaces' ? page(cursor) : defaultPage,
      things: collection === 'things' ? page(cursor) : defaultPage,
      notes: collection === 'notes' ? page(cursor) : defaultPage,
    })
  }

  async function allPlaceCollectionIds(
    placeId: number,
    collection: keyof PublicPlacePageRequests,
  ): Promise<number[]> {
    const ids: number[] = []
    let cursor: number | null = null
    do {
      const requests = placeRequests(collection, cursor)
      const rows = await loadPublicPlaceCollectionRows(executePublicQuery, placeId, requests)
      const result = finalizePublicPage(
        rows[collection] as readonly (Record<string, unknown> & { id: number })[],
        requests[collection].limit,
      )
      ids.push(...rowIds(result.items))
      cursor = result.hasMore ? result.nextCursor : null
    } while (cursor !== null)
    return ids
  }

  await t.test('exact-total admission rejects excess work before scanning events', async () => {
    const {
      budgetedExactStatement,
      executeBudgetedExactQuery,
      isPublicExactReadBusy,
    } = await import('../../../src/public-exact-query.ts')
    const first = await postgres.client.connect()
    const second = await postgres.client.connect()
    try {
      await first.query('BEGIN')
      await second.query('BEGIN')
      await first.query('SELECT pg_advisory_xact_lock(524128259, 0)')
      await second.query('SELECT pg_advisory_xact_lock(524128259, 1)')

      const explained = await postgres.client.query(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${budgetedExactStatement(`
            SELECT NULL::integer AS id, count(*)::integer AS total_items,
              coalesce(sum(octet_length(detail::text)), 0)::bigint AS total_text_bytes
            FROM events
          `)}`,
      )
      const nestedValues = (value: unknown): unknown[] => value && typeof value === 'object'
        ? [value, ...Object.values(value).flatMap(nestedValues)]
        : []
      const eventScans = nestedValues(explained.rows[0]?.['QUERY PLAN'])
        .filter(value => (value as Record<string, unknown>)['Relation Name'] === 'events')
        .map(value => Number((value as Record<string, unknown>)['Actual Loops']))
      assert.ok(eventScans.length > 0, 'the plan must retain the guarded event source')
      assert.equal(eventScans.every(loops => loops === 0), true, 'busy admission must skip source scans')

      const { default: cityApp } = await import('../../../src/index.ts')
      const startedAt = Date.now()
      const response = await cityApp.request('http://city.test/api/events?limit=1')
      assert.equal(response.status, 503)
      assert.equal(response.headers.get('retry-after'), '1')
      assert.ok(Date.now() - startedAt < 500, 'capacity rejection must be cheap')
      assert.deepEqual(await response.json(), {
        error: 'exact public totals are temporarily busy; retry',
      })

      await assert.rejects(
        executeBudgetedExactQuery(
          `SELECT NULL::integer AS id, pg_sleep(3) AS delayed,
              0::integer AS total_items, 0::bigint AS total_text_bytes`,
          [],
        ),
        isPublicExactReadBusy,
      )
    } finally {
      await first.query('ROLLBACK').catch(() => undefined)
      await second.query('ROLLBACK').catch(() => undefined)
      first.release()
      second.release()
    }
  })

  await t.test('an admitted exact-total query is canceled at its database deadline', async () => {
    const { executeBudgetedExactQuery, isPublicExactReadBusy } = await import(
      '../../../src/public-exact-query.ts'
    )
    const startedAt = Date.now()
    await assert.rejects(
      executeBudgetedExactQuery(
        `SELECT NULL::integer AS id, pg_sleep(3) AS delayed,
            0::integer AS total_items, 0::bigint AS total_text_bytes`,
        [],
      ),
      isPublicExactReadBusy,
    )
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed >= 1_000, `deadline fired implausibly early at ${elapsed}ms`)
    assert.ok(elapsed < 2_500, `deadline failed to bound database work at ${elapsed}ms`)
  })

  await t.test('events default to 10 and every older row remains reachable once', async () => {
    const request = page()
    const firstRows = await loadPublicEventRows(
      executePublicQuery,
      { kind: 'note', actor: null, placeId: null },
      request,
    )
    assert.equal(firstRows.length, 11, 'the production query must fetch one lookahead row')
    const first = finalizePublicPage(
      firstRows as readonly (Record<string, unknown> & { id: number })[],
      request.limit,
    )
    assert.equal(first.items.length, 10)
    assert.equal(first.hasMore, true)
    assert.equal(first.nextCursor, city.expected.events[9])

    const allIds = await allEventIds()
    assert.deepEqual(allIds, city.expected.events)
    assert.equal(new Set(allIds).size, allIds.length, 'page boundaries must not duplicate events')
  })

  await t.test('place collections have independent cursors and retain complete history', async () => {
    const initialRequests = Object.freeze({
      subplaces: page(),
      things: page(),
      notes: page(),
    })
    const firstRows = await loadPublicPlaceCollectionRows(
      executePublicQuery,
      city.targetPlaceId,
      initialRequests,
    )
    assert.deepEqual(
      {
        subplaces: firstRows.subplaces.length,
        things: firstRows.things.length,
        notes: firstRows.notes.length,
      },
      { subplaces: 11, things: 11, notes: 11 },
      'each production query must fetch its own lookahead row',
    )
    assert.deepEqual(
      Object.fromEntries(Object.entries(firstRows.totals).map(([name, total]) => [name, total.items])),
      { subplaces: 75, things: 75, notes: 75 },
    )
    const exactBytes = (await postgres.client.query<{
      subplace_text_bytes: string
      thing_text_bytes: string
      note_text_bytes: string
    }>(`
        SELECT
          coalesce((SELECT sum(octet_length(description)) FROM places WHERE parent_id = $1), 0) AS subplace_text_bytes,
          coalesce((SELECT sum(octet_length(body)) FROM things WHERE place_id = $1 AND withdrawn_at IS NULL), 0) AS thing_text_bytes,
          coalesce((SELECT sum(octet_length(body)) FROM notes WHERE place_id = $1), 0) AS note_text_bytes
      `, [city.targetPlaceId])).rows[0]!
    assert.deepEqual(
      Object.fromEntries(Object.entries(firstRows.totals).map(([name, total]) => [name, total.textBytes])),
      {
        subplaces: Number(exactBytes.subplace_text_bytes),
        things: Number(exactBytes.thing_text_bytes),
        notes: Number(exactBytes.note_text_bytes),
      },
    )
    assert.ok(firstRows.totals.things.textBytes > 2_000_000, 'fixture must stay realistically dense')

    const outlineRows = await loadPublicPlaceCollectionRows(
      executePublicQuery,
      city.targetPlaceId,
      initialRequests,
      false,
    )
    assert.equal(outlineRows.things.length, 11)
    assert.equal(outlineRows.things.every(thing => !Object.hasOwn(thing, 'body')), true)
    assert.equal(outlineRows.things.every(thing => Number(thing.body_text_bytes) > 25_000), true)
    assert.equal(outlineRows.totals.things.textBytes, firstRows.totals.things.textBytes)

    const noteCursor = Number(firstRows.notes[9]!.id)
    const noteOnlyAdvance = await loadPublicPlaceCollectionRows(
      executePublicQuery,
      city.targetPlaceId,
      Object.freeze({ ...initialRequests, notes: page(noteCursor) }),
    )
    assert.deepEqual(rowIds(noteOnlyAdvance.subplaces), rowIds(firstRows.subplaces))
    assert.deepEqual(rowIds(noteOnlyAdvance.things), rowIds(firstRows.things))
    assert.notDeepEqual(rowIds(noteOnlyAdvance.notes), rowIds(firstRows.notes))

    for (const collection of ['subplaces', 'things', 'notes'] as const) {
      const allIds = await allPlaceCollectionIds(city.targetPlaceId, collection)
      assert.deepEqual(allIds, city.expected[collection])
      assert.equal(
        new Set(allIds).size,
        allIds.length,
        `${collection} page boundaries must not duplicate rows`,
      )
    }
  })

}
