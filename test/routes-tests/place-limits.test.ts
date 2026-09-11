import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'


export function registerPlaceLimitsTests(): void {
  const {
    app,
    fixtureState,
    reset,
    sqlCalls,
    test,
  } = getRoutesTestContext()


  test('full place reads stop on whole records at each reader-chosen UTF-8 byte limit', async () => {
    reset({ scenario: 'public pagination' })
    const response = await app.request(
      '/api/place/2?view=full&limit=10' +
        '&subplace_text_limit_bytes=20&thing_text_limit_bytes=20&note_text_limit_bytes=20',
    )
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json() as {
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
        next_step: string
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
        next_step: string
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
        next_step: string
      }
    }

    assert.deepEqual(body.subplaces, [])
    assert.deepEqual(body.things.map(thing => thing.id), [260])
    assert.deepEqual(body.notes.map(note => note.id), [360, 359])
    for (const [name, page] of [
      ['subplaces', body.subplaces_page],
      ['things', body.things_page],
      ['notes', body.notes_page],
    ] as const) {
      assert.equal(page.text_limit_bytes, 20, name)
      assert.equal(page.stopped_for_text_limit, true, name)
      assert.equal(page.has_more, true, name)
      assert.ok(page.returned_text_bytes <= page.text_limit_bytes, name)
      assert.ok((page.next_item_id ?? 0) > 0, name)
      assert.ok((page.next_item_text_bytes ?? 0) > 0, name)
    }
    assert.equal(body.subplaces_page.next_before_subplace_id, null)
    assert.equal(body.subplaces_page.next_item_id, 160)
    assert.equal(body.things_page.next_before_thing_id, 260)
    assert.equal(body.things_page.next_item_id, 259)
    assert.equal(body.notes_page.next_before_note_id, 359)
    assert.equal(body.notes_page.next_item_id, 358)
    assert.match(body.subplaces_page.next_step, /place_id 160|\/api\/place\/160/iu)
    assert.match(body.things_page.next_step, /thing_id 259|\/api\/thing\/259/iu)
    assert.match(body.notes_page.next_step, /note_id 358|\/api\/note\/358/iu)
    assert.equal(
      body.things_page.returned_text_bytes,
      body.things.reduce((total, thing) => total + Buffer.byteLength(thing.body, 'utf8'), 0),
    )
    assert.equal(
      body.notes_page.returned_text_bytes,
      body.notes.reduce((total, note) => total + Buffer.byteLength(note.body, 'utf8'), 0),
    )
    const budgetedRead = sqlCalls().find(call =>
      /\/\* public:place-collections-budgeted \*\//i.test(call.query ?? ''))
    for (const [source, candidates, fetchParameter] of [
      ['subplace_source', 'subplace_candidates', 3],
      ['thing_source', 'thing_candidates', 5],
      ['note_source', 'note_candidates', 7],
    ] as const) {
      assert.match(
        budgetedRead?.query ?? '',
        new RegExp(
          `${source}\\s+AS\\s+MATERIALIZED[\\s\\S]*?LIMIT\\s+\\$${fetchParameter}::integer` +
            `[\\s\\S]*?${candidates}\\s+AS\\s+MATERIALIZED[\\s\\S]*?FROM\\s+${source}`,
          'iu',
        ),
        `${source} must apply the item bound before its cumulative-byte window`,
      )
    }

    fixtureState.current = { ...fixtureState.current, calls: [] }
    const continued = await app.request(
      '/api/place/2?view=full&limit=10' +
        '&subplace_text_limit_bytes=50&thing_text_limit_bytes=20&note_text_limit_bytes=20' +
        '&before_thing_id=260&before_note_id=359',
    )
    assert.equal(continued.status, 200, await continued.clone().text())
    const next = await continued.json() as typeof body
    assert.deepEqual(next.subplaces.map(place => place.id), [160, 159])
    assert.deepEqual(next.things.map(thing => thing.id), [259])
    assert.deepEqual(next.notes.map(note => note.id), [358, 357])
    assert.equal(next.subplaces_page.text_limit_bytes, 50)
    assert.equal(next.things.some(thing => body.things.some(previous => previous.id === thing.id)), false)
    assert.equal(next.notes.some(note => body.notes.some(previous => previous.id === note.id)), false)
  })

  test('place text limits accept zero and reject duplicates or unsafe integers before PostgreSQL', async () => {
    reset({ scenario: 'public pagination' })
    const zero = await app.request(
      '/api/place/2?view=full' +
        '&subplace_text_limit_bytes=0&thing_text_limit_bytes=0&note_text_limit_bytes=0',
    )
    assert.equal(zero.status, 200, await zero.clone().text())
    const zeroBody = await zero.json() as {
      subplaces: unknown[]
      things: unknown[]
      notes: unknown[]
      subplaces_page: { stopped_for_text_limit: boolean }
    }
    assert.deepEqual([zeroBody.subplaces, zeroBody.things, zeroBody.notes], [[], [], []])
    assert.equal(zeroBody.subplaces_page.stopped_for_text_limit, true)

    for (const path of [
      '/api/place/2?subplace_text_limit_bytes=-1',
      '/api/place/2?thing_text_limit_bytes=1.5',
      '/api/place/2?thing_text_limit_bytes=655361',
      '/api/place/2?note_text_limit_bytes=9007199254740992',
      '/api/place/2?note_text_limit_bytes=1&note_text_limit_bytes=2',
      '/api/place/2?note_text_limit_bytes=nope',
      '/api/place/2?view=outline&note_text_limit_bytes=10',
    ]) {
      reset({ scenario: 'public pagination' })
      const response = await app.request(path)
      assert.equal(response.status, 400, path)
      assert.equal(sqlCalls().length, 0, path)
    }
  })

  test('place view rejects duplicates and unknown values before reading PostgreSQL', async () => {
    for (const path of [
      '/api/place/2?view=compact',
      '/api/place/2?view=outline&view=full',
    ]) {
      reset({ scenario: 'public pagination' })
      const response = await app.request(path)
      assert.equal(response.status, 400, path)
      assert.equal(sqlCalls().length, 0, path)
    }
  })

  test('place reads apply the common limit to every embedded collection', async () => {
    reset({ scenario: 'public pagination' })
    const response = await app.request('/api/place/2?limit=4')
    assert.equal(response.status, 200)
    const body = await response.json() as {
      subplaces: Array<{ id: number }>
      things: Array<{ id: number }>
      notes: Array<{ id: number }>
      subplaces_page: { has_more: boolean; next_before_subplace_id: number | null }
      things_page: { has_more: boolean; next_before_thing_id: number | null }
      notes_page: { has_more: boolean; next_before_note_id: number | null }
    }
    assert.deepEqual(body.subplaces.map(row => row.id), [160, 159, 158, 157])
    assert.deepEqual(body.things.map(row => row.id), [260, 259, 258, 257])
    assert.deepEqual(body.notes.map(row => row.id), [360, 359, 358, 357])
    assert.equal(body.subplaces_page.next_before_subplace_id, 157)
    assert.equal(body.things_page.next_before_thing_id, 257)
    assert.equal(body.notes_page.next_before_note_id, 357)

    const read = sqlCalls().find(call => /\/\* public:place-collections \*\//i.test(call.query ?? ''))
    assert.deepEqual(
      read?.params?.map(value => value == null ? null : Number(value)),
      [2, null, 5, null, 5, null, 5],
      'the common limit applies one lookahead to all three bounded page CTEs',
    )
  })

  test('place collection-specific limits override the common limit', async () => {
    reset({ scenario: 'public pagination' })
    const response = await app.request(
      '/api/place/2?limit=4&subplace_limit=2&thing_limit=3&note_limit=5',
    )
    assert.equal(response.status, 200)
    const body = await response.json() as {
      subplaces: Array<{ id: number }>
      things: Array<{ id: number }>
      notes: Array<{ id: number }>
    }
    assert.deepEqual(body.subplaces.map(row => row.id), [160, 159])
    assert.deepEqual(body.things.map(row => row.id), [260, 259, 258])
    assert.deepEqual(body.notes.map(row => row.id), [360, 359, 358, 357, 356])
  })

  test('public listing routes reject invalid and duplicate pagination parameters', async () => {
    const paths = [
      '/api/events?before_id=nope',
      '/api/events?limit=2&limit=3',
      '/api/events?kind=note_created&kind=thing_created',
      '/api/events?within_seconds=0',
      '/api/events?within_seconds=1801',
      '/api/events?within_seconds=1800&within_seconds=10',
      '/api/place/2?subplace_limit=201',
      '/api/place/2?before_thing_id=0',
      '/api/place/2?note_limit=2&note_limit=3',
      '/api/place/2?limit=nope',
      '/api/place/2?limit=nope&subplace_limit=2&thing_limit=2&note_limit=2',
      '/api/place/2?limit=2&limit=3',
      '/api/place/2?q=pretend-search',
      '/api/map?q=pretend-search',
      '/api/thing/41?q=pretend-search',
      '/api/note/51?q=pretend-search',
      '/api/residents?q=pretend-search',
      '/api/events?q=pretend-search',
      '/api/kinds?q=pretend-search',
      '/api/traits?q=pretend-search',
      '/api/agreements?q=pretend-search',
      '/api/moderation?q=pretend-search',
      '/api/official?q=pretend-search',
      '/api/physics?q=pretend-search',
      '/api/world/resident/tiny-lantern?q=pretend-search',
      '/api/world/offer/90?q=pretend-search',
      '/treasury?q=pretend-search',
      '/api/search',
      '/api/search?q=',
      '/api/search?q=moss&q=fern',
      '/api/search?q=moss&mode=ranked',
      '/api/search?q=moss&maker=First-Maker',
      '/api/search?q=moss&maker=first-maker&maker=second-maker',
      '/api/search?q=moss&maker=first-maker&type=note',
      '/api/search?q=moss&before=not-a-cursor',
      '/api/search?q=moss&unknown=true',
      '/api/changes?since=-1',
      '/api/changes?since=1&limit=01',
      '/api/changes?since=1&limit=1e2',
      '/api/changes?since=1&limit=0x10',
      '/api/changes?since=1&limit=1.0',
      '/api/changes?since=1&limit=%2B1',
      '/api/changes?since=1&limit=%201',
      '/api/changes?since=1&since=2',
      '/api/changes?since=1&kind=NOTE',
      '/api/changes?since=1&kind=note&kind=action',
      '/api/changes?since=1&id=3',
      '/api/changes?since=1&action_id=3',
      '/api/changes?unknown=true',
    ]
    for (const path of paths) {
      reset({ scenario: 'public pagination' })
      const response = await app.request(path)
      assert.equal(response.status, 400, path)
      assert.equal(sqlCalls().length, 0, `${path} should fail before reading PostgreSQL`)
    }
  })
}
