import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'
import { missingActiveThingRefusal } from '../../src/refusal-text.ts'


export function registerPlaceReadingTests(): void {
  const {
    app,
    fixtureState,
    reset,
    sqlCalls,
    test,
  } = getRoutesTestContext()

  test('the missing-thing recovery address resolves to the mounted place reader', async () => {
    const refusal = missingActiveThingRefusal('thing_id 42')
    const route = /GET (\/api\/place\/:id)/u.exec(refusal)?.[1]
    assert.equal(route, '/api/place/:id')

    reset({ scenario: 'public pagination' })
    const response = await app.request(route.replace(':id', '2'))
    assert.equal(response.status, 200)
    assert.equal((await response.json() as { place?: { id?: number } }).place?.id, 2)
  })


  test('events keep the public contract while paging stably by kind and id', async () => {
    reset({ scenario: 'public pagination' })
    const firstResponse = await app.request('/api/events?kind=note_created&before_id=65&limit=3')
    assert.equal(firstResponse.status, 200)
    const first = await firstResponse.json() as {
      events: Array<{ id: number }>
      has_more: boolean
      next_before_id: number | null
    }
    assert.deepEqual(first.events.map(event => event.id), [64, 62, 60])
    assert.equal(first.has_more, true)
    assert.equal(first.next_before_id, 60)
    const firstRead = sqlCalls().find(call => /from\s+events/i.test(call.query ?? ''))
    assert.deepEqual(
      firstRead?.params?.map((value, index) => index >= 3 ? Number(value) : value),
      ['note_created', null, null, 65, 4, 0],
      'the database fetches one lookahead row',
    )
    assert.match(firstRead?.query ?? '', /id\s*<\s*\$4::integer/i)
    assert.match(firstRead?.query ?? '', /order\s+by\s+event\.id\s+desc/i)

    fixtureState.current = { ...fixtureState.current, calls: [] }
    const secondResponse = await app.request('/api/events?kind=note_created&before_id=60&limit=3')
    assert.equal(secondResponse.status, 200)
    const second = await secondResponse.json() as typeof first
    assert.deepEqual(second.events.map(event => event.id), [58, 56, 54])
    assert.equal(second.events.some(event => first.events.some(previous => previous.id === event.id)), false)
  })

  test('place reads return newest bounded slices and independent continuation cursors', async () => {
    reset({ scenario: 'public pagination' })
    const firstResponse = await app.request('/api/place/2?view=full')
    assert.equal(firstResponse.status, 200)
    const first = await firstResponse.json() as {
      subplaces: Array<{ id: number }>
      things: Array<{ id: number }>
      notes: Array<{ id: number }>
      subplaces_page: { has_more: boolean; next_before_subplace_id: number | null; returned_items: number; returned_text_bytes: number }
      things_page: { has_more: boolean; next_before_thing_id: number | null; returned_items: number; returned_text_bytes: number }
      notes_page: { has_more: boolean; next_before_note_id: number | null; returned_items: number; returned_text_bytes: number }
    }
    assert.deepEqual(first.subplaces.map(row => row.id), Array.from({ length: 10 }, (_, index) => 160 - index))
    assert.deepEqual(first.things.map(row => row.id), Array.from({ length: 10 }, (_, index) => 260 - index))
    assert.deepEqual(first.notes.map(row => row.id), Array.from({ length: 10 }, (_, index) => 360 - index))
    assert.equal(first.subplaces_page.returned_items, 10)
    assert.equal(first.things_page.returned_items, 10)
    assert.equal(first.notes_page.returned_items, 10)
    assert.ok(first.subplaces_page.returned_text_bytes > 0)
    assert.ok(first.things_page.returned_text_bytes > 0)
    assert.ok(first.notes_page.returned_text_bytes > 0)
    assert.equal(first.subplaces_page.has_more, true)
    assert.equal(first.subplaces_page.next_before_subplace_id, 151)
    assert.equal(first.things_page.has_more, true)
    assert.equal(first.things_page.next_before_thing_id, 251)
    assert.equal(first.notes_page.has_more, true)
    assert.equal(first.notes_page.next_before_note_id, 351)

    const collectionReads = sqlCalls().filter(call => /\/\* public:place-collections \*\//i.test(call.query ?? ''))
    assert.equal(collectionReads.length, 1, 'all room pages and totals share one database snapshot')
    assert.deepEqual(
      collectionReads[0]?.params?.map(value => value == null ? null : Number(value)),
      [2, null, 11, null, 11, null, 11],
    )
    assert.match(collectionReads[0]?.query ?? '', /from\s+place_reading_totals/i)
    assert.doesNotMatch(collectionReads[0]?.query ?? '', /count\s*\(\s*\*\s*\)/i)

    fixtureState.current = { ...fixtureState.current, calls: [] }
    const secondResponse = await app.request(
      '/api/place/2?view=full&before_subplace_id=151&subplace_limit=5' +
        '&before_thing_id=251&thing_limit=5&before_note_id=351&note_limit=5',
    )
    assert.equal(secondResponse.status, 200)
    const second = await secondResponse.json() as typeof first
    assert.deepEqual(second.subplaces.map(row => row.id), [150, 149, 148, 147, 146])
    assert.deepEqual(second.things.map(row => row.id), [250, 249, 248, 247, 246])
    assert.deepEqual(second.notes.map(row => row.id), [350, 349, 348, 347, 346])
    assert.equal(second.subplaces_page.next_before_subplace_id, 146)
    assert.equal(second.things_page.next_before_thing_id, 246)
    assert.equal(second.notes_page.next_before_note_id, 346)
    assert.equal(second.subplaces.some(row => first.subplaces.some(previous => previous.id === row.id)), false)
    assert.equal(second.things.some(row => first.things.some(previous => previous.id === row.id)), false)
    assert.equal(second.notes.some(row => first.notes.some(previous => previous.id === row.id)), false)
  })

  test('outline place reads keep truthful headings and sizes without returning authored collection text', async () => {
    reset({ scenario: 'public pagination' })
    const response = await app.request('/api/place/2?view=outline&limit=2')
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json() as {
      view: string
      subplaces: Array<{
        id: number
        name: string
        description?: string
        description_text_bytes: number
      }>
      things: Array<{ id: number; name: string; body?: string; body_text_bytes: number }>
      notes: Array<{ id: number; author: string; body?: string; body_text_bytes: number }>
      subplaces_page: { returned_text_bytes: number }
      things_page: {
        total_items: number
        total_text_bytes: number
        returned_items: number
        returned_text_bytes: number
      }
      notes_page: { returned_text_bytes: number }
    }
    assert.equal(body.view, 'outline')
    assert.deepEqual(body.subplaces.map(place => place.id), [160, 159])
    assert.equal(body.subplaces.every(place => typeof place.name === 'string'), true)
    assert.equal(body.subplaces.every(place => !Object.hasOwn(place, 'description')), true)
    assert.equal(body.subplaces.every(place => place.description_text_bytes > 0), true)
    assert.deepEqual(body.things.map(thing => thing.id), [260, 259])
    assert.equal(body.things.every(thing => typeof thing.name === 'string'), true)
    assert.equal(body.things.every(thing => !Object.hasOwn(thing, 'body')), true)
    assert.equal(body.things.every(thing => thing.body_text_bytes > 0), true)
    assert.deepEqual(body.notes.map(note => note.id), [360, 359])
    assert.equal(body.notes.every(note => typeof note.author === 'string'), true)
    assert.equal(body.notes.every(note => !Object.hasOwn(note, 'body')), true)
    assert.equal(body.notes.every(note => note.body_text_bytes > 0), true)
    assert.equal(body.subplaces_page.returned_text_bytes, 0)
    assert.equal(body.things_page.total_items, 260)
    assert.equal(body.things_page.total_text_bytes, 2600)
    assert.equal(body.things_page.returned_items, 2)
    assert.equal(body.things_page.returned_text_bytes, 0)
    assert.equal(body.notes_page.returned_text_bytes, 0)
    const read = sqlCalls().find(call => /\/\* public:place-collections \*\//i.test(call.query ?? ''))
    assert.doesNotMatch(read?.query ?? '', /\bp\.description\s*,/i, 'outline SQL must not return child descriptions')
    assert.doesNotMatch(read?.query ?? '', /\bt\.body\s*,/i, 'outline SQL must not return large thing bodies')
    assert.doesNotMatch(read?.query ?? '', /\bn\.body\s*,/i, 'outline SQL must not return note bodies')
  })

  test('place reads default to the body-free outline and return bodies only when full is explicit', async () => {
    for (const path of ['/api/place/2?thing_limit=1', '/api/place/2?view=full&thing_limit=1']) {
      reset({ scenario: 'public pagination' })
      const response = await app.request(path)
      assert.equal(response.status, 200, path)
      const body = await response.json() as {
        view: string
        things: Array<{ body?: string; body_text_bytes?: number }>
        things_page: { returned_text_bytes: number }
      }
      if (path.includes('view=full')) {
        assert.equal(body.view, 'full')
        assert.equal(typeof body.things[0]?.body, 'string')
        assert.equal(body.things[0]?.body_text_bytes, undefined)
        assert.ok(body.things_page.returned_text_bytes > 0)
      } else {
        assert.equal(body.view, 'outline')
        assert.equal(body.things[0]?.body, undefined)
        assert.ok((body.things[0]?.body_text_bytes ?? 0) > 0)
        assert.equal(body.things_page.returned_text_bytes, 0)
      }
    }
  })

  test('large full-room pages receive a hard server text ceiling without changing ordinary reads', async () => {
    const serverCollectionTextLimit = 655_360

    reset({ scenario: 'public pagination' })
    const response = await app.request('/api/place/2?view=full&limit=200')
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json() as Record<string, unknown>
    for (const pageName of ['subplaces_page', 'things_page', 'notes_page']) {
      const page = body[pageName] as Record<string, unknown>
      assert.equal(page.text_limit_bytes, serverCollectionTextLimit, pageName)
      assert.equal(page.server_text_limit_applied, true, pageName)
    }
    const bulkRead = sqlCalls().find(call =>
      /\/\* public:place-collections-budgeted \*\//i.test(call.query ?? ''))
    assert.deepEqual(
      bulkRead?.params?.map(value => value == null ? null : Number(value)),
      [
        2,
        null, 201,
        null, 201,
        null, 201,
        serverCollectionTextLimit,
        serverCollectionTextLimit,
        serverCollectionTextLimit,
      ],
      'a 200-row bulk request must not bypass the server-authored-text ceiling',
    )

    reset({ scenario: 'public pagination' })
    const mixed = await app.request('/api/place/2?view=full&limit=10&thing_limit=200')
    assert.equal(mixed.status, 200, await mixed.clone().text())
    const mixedBody = await mixed.json() as Record<string, Record<string, unknown>>
    assert.equal(mixedBody.subplaces_page?.server_text_limit_applied, undefined)
    assert.equal(mixedBody.things_page?.server_text_limit_applied, true)
    assert.equal(mixedBody.notes_page?.server_text_limit_applied, undefined)
    const mixedRead = sqlCalls().find(call =>
      /\/\* public:place-collections-budgeted \*\//i.test(call.query ?? ''))
    assert.deepEqual(
      mixedRead?.params?.map(value => value == null ? null : Number(value)),
      [2, null, 11, null, 201, null, 11, null, serverCollectionTextLimit, null],
      'only the oversized specific collection needs the automatic ceiling',
    )
  })
}
