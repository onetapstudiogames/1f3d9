import assert from 'node:assert/strict'
import { loadPublicEventCollectionRows, loadPublicEventRows, type PublicQueryExecutor } from '../../../src/public-pagination.ts'
import { page, rowIds } from '../../helpers/public-pagination-fixtures/pagination.ts'
import type { WindowModule } from '../../helpers/public-pagination-fixtures/window.ts'
import type { TestContext } from 'node:test'
import type { PostgresInstance } from '../../helpers/public-pagination-fixtures/postgres.ts'
import type { SeededCity } from '../../helpers/public-pagination-fixtures/seed-city.ts'

export async function registerInsidePlaceHistoryTests(
  t: TestContext,
  postgres: PostgresInstance,
  city: SeededCity,
): Promise<void> {
  await t.test('inside-place history includes the selected place and nested rooms while exact history stays exact', async () => {
    const client = await postgres.client.connect()
    try {
      await client.query('BEGIN')
      const nestedPlaceId = (await client.query<{ id: number }>(
        `INSERT INTO places (parent_id, place_kind, name, owner_id)
           VALUES ($1, 'place', 'Inside-history child', 1)
           RETURNING id`,
        [city.targetPlaceId],
      )).rows[0]!.id

      const rootNoteId = (await client.query<{ id: number }>(
        `INSERT INTO notes (place_id, author_id, body)
           VALUES ($1, 1, 'inside-history root note') RETURNING id`,
        [city.targetPlaceId],
      )).rows[0]!.id
      const nestedNoteId = (await client.query<{ id: number }>(
        `INSERT INTO notes (place_id, author_id, body)
           VALUES ($1, 1, 'inside-history nested note') RETURNING id`,
        [nestedPlaceId],
      )).rows[0]!.id
      const outsideNoteId = (await client.query<{ id: number }>(
        `INSERT INTO notes (place_id, author_id, body)
           VALUES ($1, 1, 'inside-history outside note') RETURNING id`,
        [city.smallPlaceId],
      )).rows[0]!.id

      const rootThingId = (await client.query<{ id: number }>(
        `INSERT INTO things (place_id, name, body, owner_id, maker_id)
           VALUES ($1, 'inside-history-root-thing', 'root thing', 1, 1) RETURNING id`,
        [city.targetPlaceId],
      )).rows[0]!.id
      const nestedThingId = (await client.query<{ id: number }>(
        `INSERT INTO things (place_id, name, body, owner_id, maker_id)
           VALUES ($1, 'inside-history-nested-thing', 'nested thing', 1, 1) RETURNING id`,
        [nestedPlaceId],
      )).rows[0]!.id
      const outsideThingId = (await client.query<{ id: number }>(
        `INSERT INTO things (place_id, name, body, owner_id, maker_id)
           VALUES ($1, 'inside-history-outside-thing', 'outside thing', 1, 1) RETURNING id`,
        [city.smallPlaceId],
      )).rows[0]!.id

      const rootEventId = (await client.query<{ id: number }>(
        `INSERT INTO events (kind, actor, detail)
           VALUES ('laws_changed', 'resident-1', jsonb_build_object('place_id', $1::integer))
           RETURNING id`,
        [city.targetPlaceId],
      )).rows[0]!.id
      const nestedEventId = (await client.query<{ id: number }>(
        `INSERT INTO events (kind, actor, detail)
           VALUES ('laws_changed', 'resident-1', jsonb_build_object('place_id', $1::integer))
           RETURNING id`,
        [nestedPlaceId],
      )).rows[0]!.id
      const outsideEventId = (await client.query<{ id: number }>(
        `INSERT INTO events (kind, actor, detail)
           VALUES ('laws_changed', 'resident-1', jsonb_build_object('place_id', $1::integer))
           RETURNING id`,
        [city.smallPlaceId],
      )).rows[0]!.id

      const transactionQuery: PublicQueryExecutor = async (text, values) => (
        await client.query(text, [...values])
      ).rows as Record<string, unknown>[]
      const windowModule: WindowModule = await import('../../../src/window.ts')
      const historyQuery = (
        collection: 'notes' | 'things',
        includeDescendants: boolean,
      ) => Object.freeze({
        collection,
        beforeId: null,
        limit: 200,
        placeId: city.targetPlaceId,
        includeDescendants,
        resident: null,
        context: false,
      })

      const exactNotes = await windowModule.readWindowCollectionPage(
        historyQuery('notes', false), transactionQuery,
      )
      const insideNotes = await windowModule.readWindowCollectionPage(
        historyQuery('notes', true), transactionQuery,
      )
      const exactThings = await windowModule.readWindowCollectionPage(
        historyQuery('things', false), transactionQuery,
      )
      const insideThings = await windowModule.readWindowCollectionPage(
        historyQuery('things', true), transactionQuery,
      )

      const assertExactAndInside = (
        exactIds: readonly number[],
        insideIds: readonly number[],
        rootId: number,
        nestedId: number,
        outsideId: number,
      ) => {
        assert.ok(exactIds.includes(rootId))
        assert.ok(!exactIds.includes(nestedId))
        assert.ok(!exactIds.includes(outsideId))
        assert.ok(insideIds.includes(rootId))
        assert.ok(insideIds.includes(nestedId))
        assert.ok(!insideIds.includes(outsideId))
      }
      assertExactAndInside(
        exactNotes.items.map(item => item.id), insideNotes.items.map(item => item.id),
        rootNoteId, nestedNoteId, outsideNoteId,
      )
      assertExactAndInside(
        exactThings.items.map(item => item.id), insideThings.items.map(item => item.id),
        rootThingId, nestedThingId, outsideThingId,
      )

      const exactEvents = await loadPublicEventRows(
        transactionQuery,
        { kind: 'laws_changed', actor: 'resident-1', placeId: city.targetPlaceId },
        page(null, 200),
      )
      const insideEvents = await loadPublicEventRows(
        transactionQuery,
        {
          kind: 'laws_changed', actor: 'resident-1', placeId: city.targetPlaceId,
          includeDescendants: true,
        },
        page(null, 200),
      )
      assertExactAndInside(
        rowIds(exactEvents), rowIds(insideEvents),
        rootEventId, nestedEventId, outsideEventId,
      )
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })

  await t.test('event place filter matches a move or go_home at either endpoint, not only place_id', async () => {
    const client = await postgres.client.connect()
    try {
      await client.query('BEGIN')
      const originId = city.targetPlaceId
      const destinationId = city.smallPlaceId
      const worldId = (await client.query<{ id: number }>(
        `SELECT id FROM places WHERE place_kind = 'world'`,
      )).rows[0]!.id
      const thirdPlaceId = (await client.query<{ id: number }>(
        `INSERT INTO places (parent_id, place_kind, name, owner_id)
           VALUES ($1, 'continent', 'Move-drift third place', 1)
           RETURNING id`,
        [worldId],
      )).rows[0]!.id
      const nestedUnderDestination = (await client.query<{ id: number }>(
        `INSERT INTO places (parent_id, place_kind, name, owner_id)
           VALUES ($1, 'place', 'Move-drift nested child', 1)
           RETURNING id`,
        [destinationId],
      )).rows[0]!.id
      const carriedThingId = (await client.query<{ id: number }>(
        `INSERT INTO things (place_id, name, body, owner_id, maker_id)
           VALUES ($1, 'move-drift-lantern', 'a carried thing', 1, 1) RETURNING id`,
        [originId],
      )).rows[0]!.id

      const seed = async (kind: string, actor: string, detail: object) => (
        await client.query<{ id: number }>(
          `INSERT INTO events (kind, actor, detail) VALUES ($1, $2, $3::jsonb) RETURNING id`,
          [kind, actor, JSON.stringify(detail)],
        )
      ).rows[0]!.id

      const appliedMoveId = await seed('action', 'resident-1', {
        action: 'move', status: 'applied', from_place_id: originId, to_place_id: destinationId,
      })
      const appliedGoHomeId = await seed('action', 'resident-1', {
        action: 'go_home', status: 'applied', from_place_id: originId, to_place_id: destinationId,
      })
      const failedMoveId = await seed('action', 'resident-1', {
        action: 'move', status: 'failed',
      })
      const appliedCarryId = await seed('action', 'resident-1', {
        action: 'move', status: 'applied', mode: 'carry',
        thing_id: carriedThingId, from_place_id: originId, to_place_id: destinationId,
      })
      const nestedMoveId = await seed('action', 'resident-1', {
        action: 'move', status: 'applied', from_place_id: originId, to_place_id: nestedUnderDestination,
      })

      const query: PublicQueryExecutor = async (text, values) => (
        await client.query(text, [...values])
      ).rows as Record<string, unknown>[]

      const atOrigin = rowIds(await loadPublicEventRows(
        query, { kind: 'action', actor: null, placeId: originId }, page(null, 200),
      ))
      assert.ok(atOrigin.includes(appliedMoveId), 'a move must be visible at its origin (departure)')
      assert.ok(atOrigin.includes(appliedGoHomeId), 'a go_home must be visible at its origin')
      assert.ok(atOrigin.includes(appliedCarryId), 'a carry must be visible at its origin')
      assert.ok(!atOrigin.includes(failedMoveId), 'a failed move stores no place and matches nowhere')

      const atDestination = rowIds(await loadPublicEventRows(
        query, { kind: 'action', actor: null, placeId: destinationId }, page(null, 200),
      ))
      assert.ok(atDestination.includes(appliedMoveId), 'a move must be visible at its destination (arrival)')
      assert.ok(atDestination.includes(appliedGoHomeId), 'a go_home must be visible at its destination')
      assert.ok(atDestination.includes(appliedCarryId), 'a carry must be visible at its destination')

      const exactDestination = rowIds(await loadPublicEventRows(
        query, { kind: 'action', actor: null, placeId: destinationId }, page(null, 200),
      ))
      assert.ok(
        !exactDestination.includes(nestedMoveId),
        'exact place_id must not reach a move landing in a nested child place',
      )
      const insideDestination = rowIds(await loadPublicEventRows(
        query,
        { kind: 'action', actor: null, placeId: destinationId, includeDescendants: true },
        page(null, 200),
      ))
      assert.ok(
        insideDestination.includes(appliedMoveId),
        'within_place_id must reach a move landing on the selected place itself',
      )
      assert.ok(
        insideDestination.includes(nestedMoveId),
        'within_place_id must reach a move landing on a nested child place (recursive endpoint match)',
      )

      // Negative control: the failed action never shows up under any place read,
      // but still appears unfiltered and under its actor — it did happen.
      const failedByActor = rowIds(await loadPublicEventRows(
        query, { kind: 'action', actor: 'resident-1', placeId: null }, page(null, 200),
      ))
      assert.ok(failedByActor.includes(failedMoveId))
      const failedAtDestination = rowIds(await loadPublicEventRows(
        query, { kind: 'action', actor: null, placeId: destinationId }, page(null, 200),
      ))
      assert.ok(!failedAtDestination.includes(failedMoveId))

      // total_items must count each matched row exactly once, even though the
      // OR chain now offers multiple ways for a carry to match (its own
      // endpoints AND, independently, its thing's current place).
      const completePage = Object.freeze({ ok: true as const, cursor: null, limit: 200, fetchLimit: 201 })
      const originCollection = await loadPublicEventCollectionRows(
        query, { kind: 'action', actor: null, placeId: originId }, completePage,
      )
      assert.equal(
        originCollection.total.items,
        new Set(originCollection.rows.map(row => row.id)).size,
        'no event row may be counted twice by the widened OR chain',
      )

      // Carry-drift: once the carried thing itself moves on to a third
      // place, the same historical carry event still matches at BOTH of
      // its own recorded endpoints (origin and destination), because those
      // are where the move happened — not wherever the thing drifts to
      // afterward. This is the semantic the widened filter commits to.
      await client.query(
        `UPDATE things SET place_id = $1 WHERE id = $2`,
        [thirdPlaceId, carriedThingId],
      )
      const originAfterDrift = rowIds(await loadPublicEventRows(
        query, { kind: 'action', actor: null, placeId: originId }, page(null, 200),
      ))
      const destinationAfterDrift = rowIds(await loadPublicEventRows(
        query, { kind: 'action', actor: null, placeId: destinationId }, page(null, 200),
      ))
      assert.ok(originAfterDrift.includes(appliedCarryId), 'carry stays visible at its recorded origin after drift')
      assert.ok(
        destinationAfterDrift.includes(appliedCarryId),
        'carry stays visible at its recorded destination after drift',
      )
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })

}
