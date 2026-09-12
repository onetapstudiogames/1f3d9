import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { PostgresInstance } from '../../helpers/public-pagination-fixtures/postgres.ts'
import type { SeededCity } from '../../helpers/public-pagination-fixtures/seed-city.ts'

export async function registerDenseRoomTests(
  t: TestContext,
  postgres: PostgresInstance,
  city: SeededCity,
): Promise<void> {
  await t.test('dense room explicit full reads keep whole records and smaller requests stay cheaper', async testContext => {
    const { default: cityApp } = await import('../../../src/index.ts')
    const ordinaryResponse = await cityApp.request(
      `http://city.test/api/place/${city.targetPlaceId}?view=full`,
    )
    const ordinaryText = await ordinaryResponse.text()
    assert.equal(ordinaryResponse.status, 200)
    const ordinary = JSON.parse(ordinaryText) as {
      subplaces: Array<{ description: string; created_at: string }>
      things: Array<{ body: string; created_at: string }>
      notes: Array<{ body: string; created_at: string }>
      subplaces_page: Record<string, number | boolean | null>
      things_page: Record<string, number | boolean | null>
      notes_page: Record<string, number | boolean | null>
    }
    assert.equal(ordinary.things.length, 10)
    assert.ok(Buffer.byteLength(ordinaryText, 'utf8') > 300_000)
    assert.equal(
      ordinary.things_page.returned_text_bytes,
      ordinary.things.reduce((sum, row) => sum + Buffer.byteLength(row.body, 'utf8'), 0),
    )
    assert.equal(ordinary.things_page.total_items, 75)
    assert.ok(Number(ordinary.things_page.total_text_bytes) > Number(ordinary.things_page.returned_text_bytes))
    assert.equal(ordinary.things.every(row => row.body.endsWith(' 🏙')), true, 'bodies stay whole')
    for (const [name, rows] of [
      ['subplaces', ordinary.subplaces],
      ['things', ordinary.things],
      ['notes', ordinary.notes],
    ] as const) {
      assert.equal(
        rows.every(row => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(row.created_at)),
        true,
        `${name} timestamps keep the existing ISO wire shape`,
      )
    }

    const smallResponse = await cityApp.request(
      `http://city.test/api/place/${city.targetPlaceId}?view=full&limit=1`,
    )
    const smallText = await smallResponse.text()
    assert.equal(smallResponse.status, 200)
    const small = JSON.parse(smallText) as typeof ordinary
    assert.equal(small.subplaces.length, 1)
    assert.equal(small.things.length, 1)
    assert.equal(small.notes.length, 1)
    assert.equal(small.things_page.total_items, ordinary.things_page.total_items)
    assert.equal(small.things_page.total_text_bytes, ordinary.things_page.total_text_bytes)
    assert.ok(Buffer.byteLength(smallText, 'utf8') < Buffer.byteLength(ordinaryText, 'utf8') / 5)

    const outlineResponse = await cityApp.request(
      `http://city.test/api/place/${city.targetPlaceId}?view=outline&limit=10`,
    )
    const outlineText = await outlineResponse.text()
    assert.equal(outlineResponse.status, 200, outlineText)
    const outline = JSON.parse(outlineText) as {
      subplaces: Array<{ description?: string; description_text_bytes: number }>
      things: Array<{ body?: string; body_text_bytes: number }>
      notes: Array<{ body?: string; body_text_bytes: number }>
      subplaces_page: { returned_text_bytes: number }
      things_page: { returned_text_bytes: number }
      notes_page: { returned_text_bytes: number }
    }
    assert.equal(outline.subplaces.length, 10)
    assert.equal(outline.things.length, 10)
    assert.equal(outline.notes.length, 10)
    assert.equal(outline.subplaces.every(row => !Object.hasOwn(row, 'description')), true)
    assert.equal(outline.things.every(row => !Object.hasOwn(row, 'body')), true)
    assert.equal(outline.notes.every(row => !Object.hasOwn(row, 'body')), true)
    assert.equal(outline.subplaces.every(row => row.description_text_bytes > 2_000), true)
    assert.equal(outline.things.every(row => row.body_text_bytes > 25_000), true)
    assert.equal(outline.notes.every(row => row.body_text_bytes > 2_000), true)
    const defaultResponse = await cityApp.request(
      `http://city.test/api/place/${city.targetPlaceId}?limit=10`,
    )
    assert.equal(defaultResponse.status, 200)
    assert.deepEqual(await defaultResponse.json(), outline, 'omitting view returns the same body-free outline')
    assert.deepEqual(
      [
        outline.subplaces_page.returned_text_bytes,
        outline.things_page.returned_text_bytes,
        outline.notes_page.returned_text_bytes,
      ],
      [0, 0, 0],
    )
    assert.ok(
      Buffer.byteLength(outlineText, 'utf8') < Buffer.byteLength(ordinaryText, 'utf8') / 20,
      'outline entry must stay cheap when children, things, and notes are all heavy',
    )
    testContext.diagnostic(
      `representative dense room bytes: full=${Buffer.byteLength(ordinaryText, 'utf8')}, ` +
        `limit1=${Buffer.byteLength(smallText, 'utf8')}, outline=${Buffer.byteLength(outlineText, 'utf8')}`,
    )

    const serverCollectionTextLimit = 655_360
    const bulkThingIds: number[] = []
    let bulkThingCursor: number | null = null
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const cursorQuery = bulkThingCursor == null
        ? ''
        : `&before_thing_id=${bulkThingCursor}`
      const cappedResponse = await cityApp.request(
        `http://city.test/api/place/${city.targetPlaceId}` +
          '?view=full&subplace_limit=1&thing_limit=200&note_limit=1' + cursorQuery,
      )
      const cappedText = await cappedResponse.text()
      assert.equal(cappedResponse.status, 200, cappedText)
      const capped = JSON.parse(cappedText) as {
        things: Array<{ id: number; body: string }>
        things_page: {
          returned_text_bytes: number
          has_more: boolean
          next_before_thing_id: number | null
          text_limit_bytes?: number
          stopped_for_text_limit?: boolean
          next_item_id?: number | null
          server_text_limit_applied?: boolean
        }
      }
      assert.equal(
        capped.things.some(thing => bulkThingIds.includes(thing.id)),
        false,
        'server-capped bulk pages must not repeat things',
      )
      bulkThingIds.push(...capped.things.map(thing => thing.id))
      assert.ok(capped.things_page.returned_text_bytes <= serverCollectionTextLimit)
      assert.equal(capped.things_page.text_limit_bytes, serverCollectionTextLimit)
      assert.equal(capped.things_page.server_text_limit_applied, true)
      if (!capped.things_page.has_more) break
      assert.equal(capped.things_page.stopped_for_text_limit, true)
      assert.ok(capped.things_page.next_item_id)
      assert.ok(capped.things_page.next_before_thing_id)
      bulkThingCursor = capped.things_page.next_before_thing_id
      if (pageNumber === 9) assert.fail('server-capped bulk paging did not terminate')
    }
    assert.deepEqual(bulkThingIds, city.expected.things)

    const budget = 6_500
    const budgetedResponse = await cityApp.request(
      `http://city.test/api/place/${city.targetPlaceId}` +
        `?view=full&limit=200&subplace_text_limit_bytes=${budget}` +
        `&thing_text_limit_bytes=65000&note_text_limit_bytes=${budget}`,
    )
    const budgetedText = await budgetedResponse.text()
    assert.equal(budgetedResponse.status, 200, budgetedText)
    const budgeted = JSON.parse(budgetedText) as {
      subplaces: Array<{ id: number; description: string }>
      things: Array<{ id: number; body: string }>
      notes: Array<{ id: number; body: string }>
      subplaces_page: {
        returned_text_bytes: number
        has_more: boolean
        next_before_subplace_id: number | null
        text_limit_bytes: number
        stopped_for_text_limit: boolean
        next_item_id: number | null
      }
      things_page: {
        returned_text_bytes: number
        has_more: boolean
        next_before_thing_id: number | null
        text_limit_bytes: number
        stopped_for_text_limit: boolean
        next_item_id: number | null
      }
      notes_page: {
        returned_text_bytes: number
        has_more: boolean
        next_before_note_id: number | null
        text_limit_bytes: number
        stopped_for_text_limit: boolean
        next_item_id: number | null
      }
    }
    assert.equal(budgeted.subplaces.length, 2)
    assert.equal(budgeted.things.length, 2)
    assert.equal(budgeted.notes.length, 2)
    assert.equal(budgeted.subplaces_page.text_limit_bytes, budget)
    assert.equal(budgeted.things_page.text_limit_bytes, 65_000)
    assert.equal(budgeted.notes_page.text_limit_bytes, budget)
    assert.ok(budgeted.subplaces_page.next_before_subplace_id)
    assert.ok(budgeted.things_page.next_before_thing_id)
    assert.ok(budgeted.notes_page.next_before_note_id)
    for (const [name, rows, page, field] of [
      ['subplaces', budgeted.subplaces, budgeted.subplaces_page, 'description'],
      ['things', budgeted.things, budgeted.things_page, 'body'],
      ['notes', budgeted.notes, budgeted.notes_page, 'body'],
    ] as const) {
      assert.equal(page.stopped_for_text_limit, true, name)
      assert.equal(page.has_more, true, name)
      assert.ok(page.next_item_id)
      assert.equal(
        page.returned_text_bytes,
        rows.reduce((sum, row) => sum + Buffer.byteLength(
          String((row as unknown as Record<string, unknown>)[field]),
          'utf8',
        ), 0),
        name,
      )
      assert.ok(page.returned_text_bytes <= page.text_limit_bytes, name)
      assert.equal(rows.every(row => String(
        (row as unknown as Record<string, unknown>)[field],
      ).endsWith(' 🏙')), true, `${name} stay whole`)
    }

    const nextResponse = await cityApp.request(
      `http://city.test/api/place/${city.targetPlaceId}` +
        `?view=full&limit=200&subplace_text_limit_bytes=${budget}` +
        `&thing_text_limit_bytes=65000&note_text_limit_bytes=${budget}` +
        `&before_subplace_id=${budgeted.subplaces_page.next_before_subplace_id}` +
        `&before_thing_id=${budgeted.things_page.next_before_thing_id}` +
        `&before_note_id=${budgeted.notes_page.next_before_note_id}`,
    )
    assert.equal(nextResponse.status, 200, await nextResponse.clone().text())
    const next = await nextResponse.json() as typeof budgeted
    for (const [name, firstRows, nextRows] of [
      ['subplaces', budgeted.subplaces, next.subplaces],
      ['things', budgeted.things, next.things],
      ['notes', budgeted.notes, next.notes],
    ] as const) {
      assert.equal(
        nextRows.some(row => firstRows.some(previous => previous.id === row.id)),
        false,
        `${name} pages must not repeat records`,
      )
    }

    const complete = { subplaces: [] as number[], things: [] as number[], notes: [] as number[] }
    let cursors: { subplaces: number | null; things: number | null; notes: number | null } = {
      subplaces: null,
      things: null,
      notes: null,
    }
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const cursorQuery = [
        cursors.subplaces == null ? '' : `&before_subplace_id=${cursors.subplaces}`,
        cursors.things == null ? '' : `&before_thing_id=${cursors.things}`,
        cursors.notes == null ? '' : `&before_note_id=${cursors.notes}`,
      ].join('')
      const response = await cityApp.request(
        `http://city.test/api/place/${city.targetPlaceId}` +
          `?view=full&limit=200&subplace_text_limit_bytes=${budget}` +
          `&thing_text_limit_bytes=65000&note_text_limit_bytes=${budget}${cursorQuery}`,
      )
      assert.equal(response.status, 200, await response.clone().text())
      const body = await response.json() as typeof budgeted
      complete.subplaces.push(...body.subplaces.map(row => row.id))
      complete.things.push(...body.things.map(row => row.id))
      complete.notes.push(...body.notes.map(row => row.id))
      const nextCursors = {
        subplaces: body.subplaces_page.has_more
          ? body.subplaces_page.next_before_subplace_id
          : null,
        things: body.things_page.has_more ? body.things_page.next_before_thing_id : null,
        notes: body.notes_page.has_more ? body.notes_page.next_before_note_id : null,
      }
      for (const [name, page, cursor] of [
        ['subplaces', body.subplaces_page, nextCursors.subplaces],
        ['things', body.things_page, nextCursors.things],
        ['notes', body.notes_page, nextCursors.notes],
      ] as const) {
        if (page.has_more) assert.ok(cursor, `${name} continuation must advance`)
      }
      cursors = nextCursors
      if (Object.values(cursors).every(cursor => cursor == null)) break
      if (pageNumber === 99) assert.fail('budgeted room paging did not terminate')
    }
    assert.deepEqual(complete.subplaces, city.expected.subplaces)
    assert.deepEqual(complete.things, city.expected.things)
    assert.deepEqual(complete.notes, city.expected.notes)
    assert.equal(new Set(complete.subplaces).size, complete.subplaces.length)
    assert.equal(new Set(complete.things).size, complete.things.length)
    assert.equal(new Set(complete.notes).size, complete.notes.length)
  })

}
