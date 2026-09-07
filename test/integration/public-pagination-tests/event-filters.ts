import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { eventDetailTextBytes, finalizePublicPage, loadPublicEventCollectionRows, loadPublicEventRows, parsePublicPage, type PublicPage, type PublicQueryExecutor } from '../../../src/public-pagination.ts'
import { sql } from '../../helpers/public-pagination-fixtures/postgres.ts'
import { page, rowIds } from '../../helpers/public-pagination-fixtures/pagination.ts'
import type { WindowModule } from '../../helpers/public-pagination-fixtures/window.ts'
import type { TestContext } from 'node:test'
import type { PostgresInstance } from '../../helpers/public-pagination-fixtures/postgres.ts'
import type { SeededCity } from '../../helpers/public-pagination-fixtures/seed-city.ts'

export async function registerEventFiltersTests(
  t: TestContext,
  postgres: PostgresInstance,
  city: SeededCity,
): Promise<void> {
  await t.test('event filters narrow by actor and by observed place', async () => {
    const client = postgres.client
    const otherPlace = (await client.query<{ id: number }>(
      `SELECT id FROM places WHERE name = 'Map sibling 1'`,
    )).rows[0]!.id
    const watchedThing = (await client.query<{ id: number }>(
      `SELECT id FROM things WHERE place_id = $1 ORDER BY id LIMIT 1`,
      [city.targetPlaceId],
    )).rows[0]!.id
    const watchedNote = (await client.query<{ id: number }>(
      `SELECT id FROM notes WHERE place_id = $1 ORDER BY id LIMIT 1`,
      [city.targetPlaceId],
    )).rows[0]!.id

    const withdrawnThing = (await client.query<{ id: number }>(
      `INSERT INTO things (place_id, name, body, owner_id, maker_id, withdrawn_at)
         VALUES ($1, 'withdrawn-lantern', 'no longer here', 1, 1, now())
         RETURNING id`,
      [city.targetPlaceId],
    )).rows[0]!.id
    const offerId = (await client.query<{ id: number }>(
      `INSERT INTO transfer_offers (
           channel, asset_type, asset_id, seller_id, buyer_id, price_usdc, seller_wallet
         ) VALUES ('direct', 'thing', $1, 1, 2, 1, '0x' || repeat('a', 40))
         RETURNING id`,
      [watchedThing],
    )).rows[0]!.id

    const seed = async (kind: string, actor: string, detail: object) => (
      await client.query<{ id: number }>(
        `INSERT INTO events (kind, actor, detail) VALUES ($1, $2, $3::jsonb) RETURNING id`,
        [kind, actor, JSON.stringify(detail)],
      )
    ).rows[0]!.id
    const lawHere = await seed('laws_changed', 'resident-2', { place_id: city.targetPlaceId })
    const lawElsewhere = await seed('laws_changed', 'resident-2', { place_id: otherPlace })
    const thingEdit = await seed('thing_edited', 'resident-3', { thing_id: watchedThing })
    const noteEcho = await seed('note', 'resident-2', { note_id: watchedNote })
    const malformed = await seed('thing_edited', 'resident-3', { thing_id: 'not-a-number' })
    const giftHere = await seed('transfer', 'resident-3', {
      asset_type: 'thing', asset_id: watchedThing, transfer_id: 90, mode: 'gift',
    })
    const placeSale = await seed('sale', 'resident-3', {
      asset_type: 'place', asset_id: city.targetPlaceId, transfer_id: 91,
    })
    const effectMove = await seed('transfer', 'resident-3', {
      type: 'thing', id: watchedThing, mode: 'effect',
    })
    const offerCancel = await seed('transfer_cancel', 'resident-3', { offer_id: offerId })
    const withdrawnEdit = await seed('thing_edited', 'resident-3', { thing_id: withdrawnThing })
    const marketSale = await seed('world_sale', 'resident-3', {
      thing_id: watchedThing, offer_id: offerId, transfer_id: 1,
    })

    const firstPage = (cursor: number | null = null): PublicPage => {
      const parsed = parsePublicPage(
        cursor == null ? {} : { before_id: [String(cursor)] }, 'before_id', 'limit',
      )
      assert.ok(parsed.ok)
      return parsed
    }
    const executePublicQuery: PublicQueryExecutor = async (text, params) =>
      sql.query(text, params)

    const byActor = await loadPublicEventRows(
      executePublicQuery,
      { kind: null, actor: 'resident-2', placeId: null },
      firstPage(),
    )
    assert.deepEqual(rowIds(byActor), [noteEcho, lawElsewhere, lawHere])

    // The place filter must see every shape of place evidence — the place
    // named directly, a thing standing there, a note written there, a
    // traded asset there (sale/gift asset_type+asset_id, effect transfer
    // type+id, offer events by offer_id) — and must skip the same actor's
    // act at a different place, a permanently withdrawn thing, and a
    // malformed string id (ignored, never a cast error).
    const byPlace = await loadPublicEventRows(
      executePublicQuery,
      { kind: null, actor: null, placeId: city.targetPlaceId },
      firstPage(),
    )
    const byPlaceIds = rowIds(byPlace)
    assert.deepEqual(
      byPlaceIds.slice(0, 8),
      [marketSale, offerCancel, effectMove, placeSale, giftHere, noteEcho, thingEdit, lawHere],
    )
    assert.ok(!byPlaceIds.includes(lawElsewhere))
    assert.ok(!byPlaceIds.includes(malformed))
    assert.ok(!byPlaceIds.includes(withdrawnEdit))

    const combined = await loadPublicEventRows(
      executePublicQuery,
      { kind: 'laws_changed', actor: 'resident-2', placeId: city.targetPlaceId },
      firstPage(),
    )
    assert.deepEqual(rowIds(combined), [lawHere])

    const completePage = Object.freeze({
      ok: true as const,
      cursor: null,
      limit: 200,
      fetchLimit: 201,
    })
    for (const kind of [null, 'laws_changed']) {
      for (const actor of [null, 'resident-2']) {
        for (const placeId of [null, city.targetPlaceId]) {
          const collection = await loadPublicEventCollectionRows(
            executePublicQuery,
            { kind, actor, placeId },
            completePage,
          )
          const label = JSON.stringify({ kind, actor, placeId })
          assert.equal(collection.total.items, collection.rows.length, `${label}:items`)
          assert.equal(
            collection.total.textBytes,
            eventDetailTextBytes(collection.rows),
            `${label}:bytes`,
          )
        }
      }
    }

    const expiredNote = await client.query<{ id: number }>(
      `INSERT INTO events (kind, actor, detail, at)
         VALUES ('note', 'resident-2', '{}'::jsonb, now() - interval '31 minutes')
         RETURNING id`,
    )
    const recentEvents = await loadPublicEventCollectionRows(
      executePublicQuery,
      { kind: 'note', actor: 'resident-2', placeId: null, withinSeconds: 1_800 },
      completePage,
    )
    assert.ok(recentEvents.rows.some(row => row.id === noteEcho))
    assert.ok(!recentEvents.rows.some(row => row.id === expiredNote.rows[0]!.id))
    assert.ok(recentEvents.rows.every(row => typeof row.change_id === 'string'))

    // Market-bridge kinds are public window life: the snapshot must carry
    // them once its 30-second module cache expires.
    const windowModule: WindowModule = await import('../../../src/window.ts')
    const app = new Hono()
    app.get('/api/window', windowModule.windowSnapshot)
    const realDateNow = Date.now
    Date.now = () => realDateNow() + 31_000
    try {
      const response = await app.request('http://city.test/api/window')
      assert.equal(response.status, 200)
      const snapshot = await response.json() as {
        events: Array<{ id: number; kind: string; actor: string }>
      }
      const sale = snapshot.events.find(event => event.id === marketSale)
      assert.ok(sale, 'a world market sale must appear in the public window')
      assert.equal(sale.kind, 'world_sale')
      assert.equal(sale.actor, 'resident-3')
    } finally {
      Date.now = realDateNow
    }
  })

}
