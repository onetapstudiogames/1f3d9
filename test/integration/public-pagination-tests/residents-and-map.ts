import assert from 'node:assert/strict'
import { statementCount } from '../../helpers/public-pagination-fixtures/postgres.ts'
import { placeTreeCount } from '../../helpers/public-pagination-fixtures/map.ts'
import type { TestContext } from 'node:test'
import type { PostgresInstance } from '../../helpers/public-pagination-fixtures/postgres.ts'
import type { SeededCity } from '../../helpers/public-pagination-fixtures/seed-city.ts'

export async function registerResidentsAndMapTests(
  t: TestContext,
  postgres: PostgresInstance,
  city: SeededCity,
): Promise<void> {
  await t.test('resident census follows arrival time across every tie-safe page', async (t) => {
    await postgres.client.query(`
        UPDATE residents
        SET joined_at = '2026-08-01T00:00:00Z'::timestamptz
          + (2007 - id) * interval '1 second'
      `)
    await postgres.client.query(`
        UPDATE residents
        SET joined_at = '2026-09-01T00:00:00Z'::timestamptz
        WHERE id IN (2, 3)
      `)
    const expected = (
      await postgres.client.query<{ id: number }>(
        'SELECT id FROM residents ORDER BY joined_at DESC, id DESC',
      )
    ).rows.map(row => row.id)

    const { default: cityApp } = await import('../../../src/index.ts')
    const statementsBeforeDefaultCensus = statementCount
    const defaultResponse = await cityApp.request('http://city.test/api/residents')
    assert.equal(defaultResponse.status, 200)
    assert.equal(
      statementCount - statementsBeforeDefaultCensus,
      3,
      'two local safety settings and one exact census statement share one transaction',
    )
    const defaultBody = await defaultResponse.json() as {
      residents: Array<{ id: number }>
      count: number
      total: number
      returned: number
      page_size: number
      has_more: boolean
      next_before_id: number | null
    }
    assert.equal(defaultBody.residents.length, 200)
    assert.equal(defaultBody.count, expected.length)
    assert.equal(defaultBody.total, expected.length)
    assert.equal(defaultBody.returned, 200)
    assert.equal(defaultBody.page_size, 200)
    assert.equal(defaultBody.has_more, true)
    assert.equal(defaultBody.next_before_id, expected[199])
    assert.equal(Object.hasOwn(defaultBody, 'view'), false)
    assert.deepEqual(
      Object.keys(defaultBody.residents[0] ?? {}).sort(),
      ['handle', 'id', 'joined_at', 'model'],
      'the no-query census must retain its exact legacy resident fields',
    )

    const actual: number[] = []
    let cursor: number | null = null
    do {
      const query = new URLSearchParams({ limit: '37' })
      if (cursor !== null) query.set('before_id', String(cursor))
      const response = await cityApp.request(`http://city.test/api/residents?${query}`)
      assert.equal(response.status, 200)
      const body = await response.json() as {
        residents: Array<{ id: number }>
        count: number
        total: number
        returned: number
        page_size: number
        has_more: boolean
        next_before_id: number | null
      }
      assert.equal(body.count, expected.length)
      assert.equal(body.total, expected.length)
      assert.equal(body.returned, body.residents.length)
      assert.equal(body.page_size, 37)
      actual.push(...body.residents.map(row => row.id))
      cursor = body.has_more ? body.next_before_id : null
    } while (cursor !== null)

    assert.deepEqual(actual, expected)
    assert.deepEqual(actual.slice(0, 3), [3, 2, 1], 'joined_at wins; id only breaks ties')
    assert.equal(new Set(actual).size, actual.length, 'page boundaries must not repeat residents')

    const exhaustedResponse = await cityApp.request(
      `http://city.test/api/residents?limit=37&before_id=${expected.at(-1)}`,
    )
    assert.equal(exhaustedResponse.status, 200)
    const exhausted = await exhaustedResponse.json() as typeof defaultBody
    assert.deepEqual(exhausted.residents, [])
    assert.equal(exhausted.count, expected.length)
    assert.equal(exhausted.total, expected.length)
    assert.equal(exhausted.returned, 0)
    assert.equal(exhausted.page_size, 37)
    assert.equal(exhausted.has_more, false)
    assert.equal(exhausted.next_before_id, null)

    const presenceIds: number[] = []
    let presenceCursor: number | null = null
    let firstPresenceBytes: number | null = null
    do {
      const query = new URLSearchParams({ view: 'presence', limit: '37' })
      if (presenceCursor !== null) query.set('before_id', String(presenceCursor))
      const response = await cityApp.request(`http://city.test/api/residents?${query}`)
      assert.equal(response.status, 200)
      const body = await response.json() as {
        residents: Array<{
          id: number
          handle: string
          model: string
          joined_at: string
          current_place_id: number | null
          asleep: boolean
        }>
        count: number
        total: number
        returned: number
        page_size: number
        total_items: number
        has_more: boolean
        next_before_id: number | null
      }
      firstPresenceBytes ??= Buffer.byteLength(JSON.stringify(body), 'utf8')
      assert.equal(body.count, expected.length)
      assert.equal(body.total, expected.length)
      assert.equal(body.total_items, expected.length)
      assert.equal(body.returned, body.residents.length)
      assert.equal(body.page_size, 37)
      assert.equal(
        body.residents.every(resident => (
          resident.current_place_id === city.targetPlaceId && typeof resident.asleep === 'boolean'
        )),
        true,
        'presence pages add location and sleep state without dropping census fields',
      )
      presenceIds.push(...body.residents.map(resident => resident.id))
      presenceCursor = body.has_more ? body.next_before_id : null
    } while (presenceCursor !== null)

    assert.deepEqual(presenceIds, expected)
    assert.equal(
      new Set(presenceIds).size,
      presenceIds.length,
      'presence cursor pages must neither repeat nor skip residents',
    )
    t.diagnostic(`Wave 4 presence first-page bytes (37 residents): ${firstPresenceBytes}`)
  })

  await t.test('the public map keeps full compatibility and outlines every branch child once', async (t) => {
    const { default: cityApp } = await import('../../../src/index.ts')

    const legacyResponse = await cityApp.request('http://city.test/api/map')
    assert.equal(legacyResponse.status, 200)
    const legacy = await legacyResponse.json() as { places: unknown[] }
    assert.deepEqual(Object.keys(legacy), ['places'])
    assert.equal(placeTreeCount(legacy.places), city.placeCount)

    const explicitFullResponse = await cityApp.request('http://city.test/api/map?view=full')
    assert.equal(explicitFullResponse.status, 200)
    const explicitFull = await explicitFullResponse.json() as {
      view: string
      places: unknown[]
    }
    assert.equal(explicitFull.view, 'full')
    assert.deepEqual(explicitFull.places, legacy.places)

    type OutlinePlace = {
      id: number
      parent_id: number | null
      places: number
      things: number
      notes: number
      children: unknown[]
    }
    type OutlineBody = {
      view: string
      place: OutlinePlace
      subplaces: OutlinePlace[]
      subplaces_page: {
        total_items: number
        total_text_bytes: number
        returned_items: number
        returned_text_bytes: number
        has_more: boolean
        next_before_subplace_id: number | null
      }
      map_complete: boolean
    }

    const worldResponse = await cityApp.request(
      'http://city.test/api/map?view=outline&subplace_limit=10',
    )
    assert.equal(worldResponse.status, 200)
    const world = await worldResponse.json() as OutlineBody
    assert.equal(world.view, 'outline')
    assert.equal(world.place.id, city.worldPlaceId)
    assert.equal(world.place.parent_id, null)
    assert.deepEqual(world.place.children, [])
    assert.deepEqual(
      world.subplaces.map(place => place.id),
      city.expected.worldSubplaces.slice(0, 10),
    )
    assert.equal(
      world.subplaces.every(place => (
        place.parent_id === city.worldPlaceId &&
        Array.isArray(place.children) &&
        place.children.length === 0
      )),
      true,
      'outline rows stay flat even when their child counts are nonzero',
    )
    assert.equal(world.subplaces_page.total_items, city.expected.worldSubplaces.length)
    assert.equal(world.subplaces_page.returned_items, 10)
    assert.equal(world.subplaces_page.returned_text_bytes, 0)
    assert.equal(world.subplaces_page.has_more, true)
    assert.equal(
      world.subplaces_page.next_before_subplace_id,
      city.expected.worldSubplaces[9],
    )
    assert.ok(Number.isSafeInteger(world.subplaces_page.total_text_bytes))
    assert.equal(world.map_complete, false)

    const actual: number[] = []
    let cursor: number | null = null
    let firstBranchBytes: number | null = null
    do {
      const query = new URLSearchParams({
        view: 'outline',
        parent_id: String(city.mapBranchPlaceId),
        subplace_limit: '37',
      })
      if (cursor !== null) query.set('before_subplace_id', String(cursor))
      const response = await cityApp.request(`http://city.test/api/map?${query}`)
      assert.equal(response.status, 200)
      const body = await response.json() as OutlineBody
      firstBranchBytes ??= Buffer.byteLength(JSON.stringify(body), 'utf8')
      assert.equal(body.place.id, city.mapBranchPlaceId)
      assert.deepEqual(body.place.children, [])
      assert.equal(body.subplaces_page.total_items, city.expected.mapSubplaces.length)
      assert.equal(body.subplaces_page.returned_items, body.subplaces.length)
      assert.equal(body.subplaces_page.returned_text_bytes, 0)
      assert.equal(body.subplaces.length <= 37, true)
      assert.equal(
        body.subplaces.every(place => (
          place.parent_id === city.mapBranchPlaceId &&
          Array.isArray(place.children) &&
          place.children.length === 0
        )),
        true,
      )
      actual.push(...body.subplaces.map(place => place.id))
      if (body.subplaces_page.has_more) {
        assert.ok(body.subplaces_page.next_before_subplace_id)
        cursor = body.subplaces_page.next_before_subplace_id
      } else {
        assert.equal(body.subplaces_page.next_before_subplace_id, null)
        cursor = null
      }
    } while (cursor !== null)

    assert.deepEqual(actual, city.expected.mapSubplaces)
    assert.equal(
      new Set(actual).size,
      actual.length,
      'outline cursor pages must neither repeat nor skip direct children',
    )
    t.diagnostic(
      `Wave 4 map bytes: legacy=${Buffer.byteLength(JSON.stringify(legacy), 'utf8')}, ` +
      `root-outline=${Buffer.byteLength(JSON.stringify(world), 'utf8')}, ` +
      `branch-page-37=${firstBranchBytes}`,
    )
  })

}
