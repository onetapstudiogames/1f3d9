import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { PostgresInstance } from '../../helpers/public-pagination-fixtures/postgres.ts'
import type { SeededCity } from '../../helpers/public-pagination-fixtures/seed-city.ts'

export async function registerZeroFitRoomTests(
  t: TestContext,
  postgres: PostgresInstance,
  city: SeededCity,
): Promise<void> {
  await t.test('zero-fit pages support direct reads and cursor continuation for every room collection', async testContext => {
    const { default: cityApp } = await import('../../../src/index.ts')
    const stalledResponse = await cityApp.request(
      `http://city.test/api/place/${city.targetPlaceId}` +
        '?view=full&limit=200&subplace_text_limit_bytes=1' +
        '&thing_text_limit_bytes=1&note_text_limit_bytes=1',
    )
    const stalledText = await stalledResponse.text()
    assert.equal(stalledResponse.status, 200, stalledText)
    const stalled = JSON.parse(stalledText) as {
      subplaces: Array<{ id: number; description: string }>
      things: Array<{ id: number; body: string }>
      notes: Array<{ id: number; body: string }>
      subplaces_page: {
        returned_items: number
        returned_text_bytes: number
        has_more: boolean
        next_before_subplace_id: number | null
        text_limit_bytes: number
        stopped_for_text_limit: boolean
        next_item_id: number | null
        next_item_text_bytes: number | null
      }
      things_page: {
        returned_items: number
        returned_text_bytes: number
        has_more: boolean
        next_before_thing_id: number | null
        text_limit_bytes: number
        stopped_for_text_limit: boolean
        next_item_id: number | null
        next_item_text_bytes: number | null
      }
      notes_page: {
        returned_items: number
        returned_text_bytes: number
        has_more: boolean
        next_before_note_id: number | null
        text_limit_bytes: number
        stopped_for_text_limit: boolean
        next_item_id: number | null
        next_item_text_bytes: number | null
      }
    }

    const stalledCollections = [
      {
        name: 'subplaces',
        rows: stalled.subplaces,
        page: stalled.subplaces_page,
        nextBefore: stalled.subplaces_page.next_before_subplace_id,
        expectedIds: city.expected.subplaces,
        directPath: `/api/place/${stalled.subplaces_page.next_item_id}?view=full&limit=1`,
        directKey: 'place',
        textField: 'description',
      },
      {
        name: 'things',
        rows: stalled.things,
        page: stalled.things_page,
        nextBefore: stalled.things_page.next_before_thing_id,
        expectedIds: city.expected.things,
        directPath: `/api/thing/${stalled.things_page.next_item_id}`,
        directKey: 'thing',
        textField: 'body',
      },
      {
        name: 'notes',
        rows: stalled.notes,
        page: stalled.notes_page,
        nextBefore: stalled.notes_page.next_before_note_id,
        expectedIds: city.expected.notes,
        directPath: `/api/note/${stalled.notes_page.next_item_id}`,
        directKey: 'note',
        textField: 'body',
      },
    ] as const
    for (const entry of stalledCollections) {
      assert.deepEqual(entry.rows, [], entry.name)
      assert.equal(entry.page.returned_items, 0, entry.name)
      assert.equal(entry.page.returned_text_bytes, 0, entry.name)
      assert.equal(entry.page.has_more, true, entry.name)
      assert.equal(entry.nextBefore, null, entry.name)
      assert.equal(entry.page.text_limit_bytes, 1, entry.name)
      assert.equal(entry.page.stopped_for_text_limit, true, entry.name)
      assert.equal(entry.page.next_item_id, entry.expectedIds[0], entry.name)
      assert.ok((entry.page.next_item_text_bytes ?? 0) > 1, entry.name)

      const directResponse = await cityApp.request(`http://city.test${entry.directPath}`)
      const directText = await directResponse.text()
      assert.equal(directResponse.status, 200, `${entry.name}: ${directText}`)
      const directBody = JSON.parse(directText) as Record<string, Record<string, unknown>>
      const directRecord = directBody[entry.directKey]
      assert.equal(Number(directRecord?.id), entry.page.next_item_id, entry.name)
      const authoredText = String(directRecord?.[entry.textField])
      assert.equal(
        Buffer.byteLength(authoredText, 'utf8'),
        entry.page.next_item_text_bytes,
        entry.name,
      )
      assert.equal(authoredText.endsWith(' 🏙'), true, `${entry.name}: direct read stays whole`)
    }

    const stalledSubplaceId = stalled.subplaces_page.next_item_id
    const stalledThingId = stalled.things_page.next_item_id
    const stalledNoteId = stalled.notes_page.next_item_id
    const subplaceBudget = stalled.subplaces_page.next_item_text_bytes
    const thingBudget = stalled.things_page.next_item_text_bytes
    const noteBudget = stalled.notes_page.next_item_text_bytes
    assert.ok(stalledSubplaceId && stalledThingId && stalledNoteId)
    assert.ok(subplaceBudget && thingBudget && noteBudget)
    const continuationQuery = new URLSearchParams({
      view: 'full',
      limit: '200',
      subplace_text_limit_bytes: String(subplaceBudget),
      thing_text_limit_bytes: String(thingBudget),
      note_text_limit_bytes: String(noteBudget),
      before_subplace_id: String(stalledSubplaceId),
      before_thing_id: String(stalledThingId),
      before_note_id: String(stalledNoteId),
    })
    const continuedResponse = await cityApp.request(
      `http://city.test/api/place/${city.targetPlaceId}?${continuationQuery}`,
    )
    const continuedText = await continuedResponse.text()
    assert.equal(continuedResponse.status, 200, continuedText)
    const continued = JSON.parse(continuedText) as typeof stalled
    for (const entry of [
      {
        name: 'subplaces',
        rows: continued.subplaces,
        page: continued.subplaces_page,
        nextBefore: continued.subplaces_page.next_before_subplace_id,
        expectedIds: city.expected.subplaces,
      },
      {
        name: 'things',
        rows: continued.things,
        page: continued.things_page,
        nextBefore: continued.things_page.next_before_thing_id,
        expectedIds: city.expected.things,
      },
      {
        name: 'notes',
        rows: continued.notes,
        page: continued.notes_page,
        nextBefore: continued.notes_page.next_before_note_id,
        expectedIds: city.expected.notes,
      },
    ] as const) {
      assert.deepEqual(entry.rows.map(row => row.id), [entry.expectedIds[1]], entry.name)
      assert.equal(entry.nextBefore, entry.expectedIds[1], entry.name)
      assert.equal(entry.page.returned_items, 1, entry.name)
      assert.equal(entry.page.returned_text_bytes, entry.page.text_limit_bytes, entry.name)
      assert.equal(entry.page.stopped_for_text_limit, true, entry.name)
      assert.equal(entry.page.next_item_id, entry.expectedIds[2], entry.name)
    }
    testContext.diagnostic(
      `zero-fit next bytes: child=${subplaceBudget}, thing=${thingBudget}, note=${noteBudget}; ` +
        `stalled response=${Buffer.byteLength(stalledText, 'utf8')}, ` +
        `continued response=${Buffer.byteLength(continuedText, 'utf8')}`,
    )
  })

}
