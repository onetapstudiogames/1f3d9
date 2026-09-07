import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { placeTreeCount } from '../../helpers/public-pagination-fixtures/map.ts'
import { statementCount } from '../../helpers/public-pagination-fixtures/postgres.ts'
import type { WindowModule } from '../../helpers/public-pagination-fixtures/window.ts'
import type { TestContext } from 'node:test'
import type { PostgresInstance } from '../../helpers/public-pagination-fixtures/postgres.ts'
import type { SeededCity } from '../../helpers/public-pagination-fixtures/seed-city.ts'

export async function registerWindowTests(
  t: TestContext,
  postgres: PostgresInstance,
  city: SeededCity,
): Promise<void> {
  await t.test('the window preserves full snapshots and bounds its explicit outline', async (t) => {
    const windowModule: WindowModule = await import('../../../src/window.ts')
    const app = new Hono()
    app.get('/api/window', windowModule.windowSnapshot)

    type WindowPlace = {
      id: number
      parent_id: number | null
      children: WindowPlace[]
    }
    type WindowResident = {
      id: number
      current_place_id: number | null
      asleep: boolean
    }
    type WindowSnapshotBody = {
      view?: string
      places: WindowPlace[]
      residents: WindowResident[]
      notes: Array<{ id: number }>
      things: Array<{ id: number }>
      agreements: Array<{ id: number }>
      events: Array<{ id: number }>
      live_survey?: Array<{ id: number; parent_id: number | null; things: number; notes: number }>
      pages: {
        places?: { has_more: boolean; next_before_subplace_id: number | null }
        residents?: { has_more: boolean; next_before_id: number | null }
        notes: { has_more: boolean; next_before_id: number | null }
        things: { has_more: boolean; next_before_id: number | null }
        agreements: { has_more: boolean; next_before_id: number | null }
        events: { has_more: boolean; next_before_id: number | null }
      }
      shown: Record<string, number>
      totals: Record<string, number>
      limits: Record<string, number | null>
    }

    const legacyResponse = await app.request('http://city.test/api/window')
    assert.equal(legacyResponse.status, 200)
    const legacy = await legacyResponse.json() as WindowSnapshotBody
    assert.equal(Object.hasOwn(legacy, 'view'), false)
    assert.equal(Object.hasOwn(legacy, 'live_survey'), false)
    assert.equal(placeTreeCount(legacy.places), city.placeCount)
    assert.equal(legacy.residents.length, city.residentCount)

    const explicitFullResponse = await app.request('http://city.test/api/window?view=full')
    assert.equal(explicitFullResponse.status, 200)
    const explicitFull = await explicitFullResponse.json() as WindowSnapshotBody
    assert.equal(explicitFull.view, 'full')
    assert.equal(Object.hasOwn(explicitFull, 'live_survey'), false)
    for (const collection of [
      'places', 'residents', 'notes', 'things', 'agreements', 'events',
    ] as const) {
      assert.deepEqual(explicitFull[collection], legacy[collection], collection)
    }

    const outlineResponse = await app.request('http://city.test/api/window?view=outline')
    assert.equal(outlineResponse.status, 200)
    const snapshot = await outlineResponse.json() as WindowSnapshotBody
    assert.equal(snapshot.view, 'outline')
    const expectedLiveSurvey = (
      await postgres.client.query<
        { id: number; parent_id: number | null; things: number; notes: number }
      >(`
          SELECT place.id, place.parent_id, totals.thing_items AS things, totals.note_items AS notes
          FROM places place
          JOIN place_reading_totals totals ON totals.place_id = place.id
          ORDER BY place.id
        `)
    ).rows
    assert.deepEqual(snapshot.live_survey, expectedLiveSurvey)
    assert.equal(snapshot.live_survey?.every(place =>
      Object.keys(place).sort().join(',') === 'id,notes,parent_id,things'), true)
    assert.equal(snapshot.places.length, 1)
    assert.equal(snapshot.places[0]?.id, city.worldPlaceId)
    assert.deepEqual(
      snapshot.places[0]?.children.map(place => place.id),
      city.expected.worldSubplaces.slice(0, 10),
    )
    assert.equal(placeTreeCount(snapshot.places), 11, 'the root plus ten children are shown')
    assert.equal(snapshot.residents.length, 25)
    const expectedResidentIds = (
      await postgres.client.query<{ id: number }>(
        'SELECT id FROM residents ORDER BY joined_at DESC, id DESC LIMIT 25',
      )
    ).rows.map(row => row.id)
    assert.deepEqual(snapshot.residents.map(resident => resident.id), expectedResidentIds)
    assert.equal(
      snapshot.residents.every(resident => (
        resident.current_place_id === city.targetPlaceId && typeof resident.asleep === 'boolean'
      )),
      true,
    )
    assert.deepEqual(
      {
        notes: snapshot.notes.length,
        things: snapshot.things.length,
        agreements: snapshot.agreements.length,
        events: snapshot.events.length,
      },
      { notes: 10, things: 10, agreements: 10, events: 10 },
    )
    for (const collection of ['notes', 'things', 'agreements', 'events'] as const) {
      assert.deepEqual(snapshot[collection], legacy[collection], `${collection} stays unchanged`)
    }
    for (const collection of ['notes', 'things', 'agreements', 'events'] as const) {
      assert.equal(snapshot.pages[collection].has_more, true, collection)
    }
    assert.equal(snapshot.pages.places?.has_more, true)
    assert.equal(
      snapshot.pages.places?.next_before_subplace_id,
      city.expected.worldSubplaces[9],
    )
    assert.equal(snapshot.pages.residents?.has_more, true)
    assert.equal(
      snapshot.pages.residents?.next_before_id,
      snapshot.residents.at(-1)?.id,
    )
    assert.equal(snapshot.shown.places, 11)
    assert.equal(snapshot.shown.residents, 25)
    assert.equal(snapshot.shown.conversations, 10)
    assert.equal(snapshot.shown.things, 10)
    assert.equal(snapshot.shown.agreements, 10)
    assert.equal(snapshot.shown.events, 10)
    assert.equal(snapshot.totals.places, city.placeCount)
    assert.equal(snapshot.totals.residents, city.residentCount)
    assert.equal(snapshot.limits.places, 10)
    assert.equal(snapshot.limits.residents, 25)
    assert.equal(snapshot.limits.conversations, 10)
    assert.equal(snapshot.limits.things, 10)
    assert.equal(snapshot.limits.agreements, 10)
    assert.equal(snapshot.limits.events, 10)
    t.diagnostic(
      `Wave 4 window bytes: legacy=${Buffer.byteLength(JSON.stringify(legacy), 'utf8')}, ` +
      `outline=${Buffer.byteLength(JSON.stringify(snapshot), 'utf8')}; ` +
      `shown places=${snapshot.shown.places}, residents=${snapshot.shown.residents}; ` +
      `place_cursor=${snapshot.pages.places?.next_before_subplace_id}, ` +
      `resident_cursor=${snapshot.pages.residents?.next_before_id}`,
    )

    const notesPage = snapshot.pages.notes
    assert.ok(notesPage)
    const olderNotesResponse = await app.request(
      `http://city.test/api/window?collection=notes&before_id=${notesPage.next_before_id}&limit=50`,
    )
    assert.equal(olderNotesResponse.status, 200)
    const olderNotes = await olderNotesResponse.json() as {
      notes: Array<{ id: number }>
      has_more: boolean
      next_before_id: number | null
    }
    assert.equal(olderNotes.notes.length, 50)
    assert.equal(olderNotes.has_more, true)

    const oldestNotesResponse = await app.request(
      `http://city.test/api/window?collection=notes&before_id=${olderNotes.next_before_id}&limit=50`,
    )
    assert.equal(oldestNotesResponse.status, 200)
    const oldestNotes = await oldestNotesResponse.json() as {
      notes: Array<{ id: number }>
      has_more: boolean
      next_before_id: number | null
    }
    assert.equal(oldestNotes.notes.length, city.expected.allNotes.length - 60)
    assert.equal(oldestNotes.has_more, false)
    assert.deepEqual(
      [
        ...snapshot.notes.map(row => row.id),
        ...olderNotes.notes.map(row => row.id),
        ...oldestNotes.notes.map(row => row.id),
      ],
      city.expected.allNotes,
    )

    const statementsBeforeInvalidRequest = statementCount
    const invalidResponse = await app.request(
      'http://city.test/api/window?collection=notes&limit=0',
    )
    assert.equal(invalidResponse.status, 400)
    assert.equal(
      statementCount,
      statementsBeforeInvalidRequest,
      'an invalid public page must be rejected before PostgreSQL is queried',
    )
  })

}
