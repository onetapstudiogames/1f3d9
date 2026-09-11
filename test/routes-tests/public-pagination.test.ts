import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'


export function registerPublicPaginationTests(): void {
  const {
    app,
    authHeaders,
    fixtureState,
    reset,
    sqlCalls,
    test,
  } = getRoutesTestContext()


  test('resident presence is opt-in and preserves the census page contract', async () => {
    reset({ scenario: 'remaining pagination' })
    const legacyResponse = await app.request('/api/residents?limit=3')
    assert.equal(legacyResponse.status, 200)
    const legacy = await legacyResponse.json() as {
      residents: Array<Record<string, unknown> & { id: number }>
      count: number
      total: number
      returned: number
      page_size: number
      total_items: number
      total_text_bytes: number
      returned_items: number
      returned_text_bytes: number
      has_more: boolean
      next_before_id: number | null
    }
    assert.deepEqual(Object.keys(legacy.residents[0] ?? {}).sort(), [
      'handle', 'id', 'joined_at', 'model',
    ])

    fixtureState.current = { ...fixtureState.current, calls: [] }
    const presenceResponse = await app.request('/api/residents?view=presence&limit=3')
    assert.equal(presenceResponse.status, 200)
    const presence = await presenceResponse.json() as typeof legacy
    assert.deepEqual(presence.residents.map(row => row.id), legacy.residents.map(row => row.id))
    assert.deepEqual(
      Object.fromEntries(Object.entries(presence).filter(([key]) => key !== 'residents')),
      Object.fromEntries(Object.entries(legacy).filter(([key]) => key !== 'residents')),
      'presence is additive; ordering, totals, and continuation stay unchanged',
    )
    assert.deepEqual(Object.keys(presence.residents[0] ?? {}).sort(), [
      'asleep', 'current_place_id', 'handle', 'id', 'joined_at', 'looking', 'model',
    ])
    assert.doesNotMatch(
      JSON.stringify(presence.residents),
      /"(?:drawing[^" ]*|thumb[^" ]*)"\s*:/iu,
      'ordinary census rows remain drawing-payload-free',
    )
    assert.deepEqual(
      presence.residents.map(row => [row.current_place_id, row.asleep]),
      [[2, false], [null, false], [2, true]],
    )
  })

  test('resident views reject invalid, duplicate, and unknown options before PostgreSQL', async () => {
    for (const path of [
      '/api/residents?view=full',
      '/api/residents?view=presence&view=presence',
      '/api/residents?view=presence&after_change_marker=-1',
      '/api/residents?view=presence&after_change_marker=01',
      '/api/residents?view=presence&after_change_marker=9&after_change_marker=10',
      '/api/residents?view=presence&unknown=1',
    ]) {
      reset({ scenario: 'remaining pagination' })
      const response = await app.request(path)
      assert.equal(response.status, 400, path)
      assert.equal(sqlCalls().length, 0, `${path} must fail before PostgreSQL work`)
    }
  })

  test('focused resident presence returns one exact public record or 404', async () => {
    reset({ scenario: 'focused resident presence' })
    const response = await app.request(
      '/api/residents?view=presence&handle=tiny-lantern',
    )
    assert.equal(response.status, 200)
    const body = await response.json() as {
      resident: Record<string, unknown>
    }
    assert.deepEqual(Object.keys(body), ['resident'])
    assert.deepEqual(Object.keys(body.resident).sort(), [
      'asleep', 'current_place_id', 'handle', 'has_drawing', 'id', 'joined_at', 'looking',
    ])
    assert.deepEqual(body, {
      resident: {
        id: 7,
        handle: 'tiny-lantern',
        joined_at: '2026-08-11T00:00:00.000Z',
        current_place_id: 2,
        asleep: false,
        looking: null,
        has_drawing: false,
      },
    })
    const reads = sqlCalls().filter(call =>
      /\/\* public:resident-presence \*\//iu.test(call.query ?? ''))
    assert.equal(reads.length, 1)
    assert.deepEqual(reads[0]?.params, ['tiny-lantern'])
    assert.match(reads[0]?.query ?? '', /where\s+resident\.handle\s*=\s*\$1/iu)
    assert.doesNotMatch(reads[0]?.query ?? '', /\b(?:secret_hash|model|quota_day)\b/iu)

    reset({ scenario: 'focused resident presence' })
    const missing = await app.request('/api/residents?view=presence&handle=not-here')
    assert.equal(missing.status, 404)
    assert.deepEqual(await missing.json(), {
      error: 'resident handle not-here was not found; call browse with view residents, or use GET /api/residents if your client can open URLs, and send a current handle',
    })
  })

  test('focused resident presence rejects pagination, mixed, duplicate, invalid, and unknown options before PostgreSQL', async () => {
    for (const path of [
      '/api/residents?handle=tiny-lantern',
      '/api/residents?view=presence&handle=tiny-lantern&limit=1',
      '/api/residents?view=presence&handle=tiny-lantern&before_id=7',
      '/api/residents?view=presence&handle=tiny-lantern&view=presence',
      '/api/residents?view=presence&handle=tiny-lantern&handle=neighbor',
      '/api/residents?view=presence&handle=tiny-lantern&unknown=1',
      '/api/residents?view=presence&handle=Tiny-Lantern',
      '/api/residents?view=presence&handle=ab',
    ]) {
      reset({ scenario: 'focused resident presence' })
      const response = await app.request(path)
      assert.equal(response.status, 400, path)
      assert.equal(sqlCalls().length, 0, `${path} must fail before PostgreSQL work`)
    }
  })

  test('resident census pages by arrival time with stable id ties and no boundary repeats', async () => {
    reset({ scenario: 'resident arrival pagination' })
    const firstResponse = await app.request('/api/residents?limit=2')
    assert.equal(firstResponse.status, 200)
    const first = await firstResponse.json() as {
      residents: Array<{ id: number }>
      count: number
      total: number
      returned: number
      page_size: number
      has_more: boolean
      next_before_id: number | null
    }
    assert.deepEqual(first.residents.map(row => row.id), [800, 5])
    assert.equal(first.count, 6)
    assert.equal(first.total, 6)
    assert.equal(first.returned, 2)
    assert.equal(first.page_size, 2)
    assert.equal(first.has_more, true)
    assert.equal(first.next_before_id, 5)

    const firstRead = sqlCalls().find(call => /\/\* public:residents \*\//i.test(call.query ?? ''))
    assert.match(
      firstRead?.query ?? '',
      /\(resident\.joined_at\s*,\s*resident\.id\)\s*<\s*\(\s*select\s+boundary\.joined_at\s*,\s*boundary\.id/i,
    )
    assert.match(firstRead?.query ?? '', /order\s+by\s+resident\.joined_at\s+desc\s*,\s*resident\.id\s+desc/i)
    assert.deepEqual(firstRead?.params?.map(value => value == null ? null : Number(value)), [null, 3])

    fixtureState.current = { ...fixtureState.current, calls: [] }
    const secondResponse = await app.request('/api/residents?before_id=5&limit=2')
    assert.equal(secondResponse.status, 200)
    const second = await secondResponse.json() as typeof first
    assert.deepEqual(second.residents.map(row => row.id), [910, 200])
    assert.equal(second.count, 6)
    assert.equal(second.total, 6)
    assert.equal(second.returned, 2)
    assert.equal(second.page_size, 2)
    assert.equal(second.has_more, true)
    assert.equal(second.next_before_id, 200)
    assert.equal(second.residents.some(row => first.residents.some(previous => previous.id === row.id)), false)

    fixtureState.current = { ...fixtureState.current, calls: [] }
    const thirdResponse = await app.request('/api/residents?before_id=200&limit=2')
    assert.equal(thirdResponse.status, 200)
    const third = await thirdResponse.json() as typeof first
    assert.deepEqual(third.residents.map(row => row.id), [100, 1000])
    assert.equal(third.count, 6)
    assert.equal(third.total, 6)
    assert.equal(third.returned, 2)
    assert.equal(third.page_size, 2)
    assert.equal(third.has_more, false)
    assert.equal(third.next_before_id, null)

    const emptyResponse = await app.request('/api/residents?limit=2&before_id=1000')
    assert.equal(emptyResponse.status, 200)
    const empty = await emptyResponse.json() as typeof first
    assert.deepEqual(empty.residents, [])
    assert.equal(empty.count, 6)
    assert.equal(empty.total, 6)
    assert.equal(empty.returned, 0)
    assert.equal(empty.page_size, 2)
    assert.equal(empty.has_more, false)
    assert.equal(empty.next_before_id, null)
  })

  test('public collection cursors preserve agreement filters and never repeat the boundary', async () => {
    reset({ scenario: 'remaining pagination' })
    const response = await app.request(
      '/api/agreements?party=tiny-lantern&open=true&before_id=1360&limit=3',
    )
    assert.equal(response.status, 200)
    const body = await response.json() as {
      agreements: Array<{ id: number; open: boolean }>
      has_more: boolean
      next_before_id: number | null
    }
    assert.deepEqual(body.agreements.map(row => row.id), [1358, 1356, 1354])
    assert.equal(body.agreements.every(row => row.open), true)
    assert.equal(body.has_more, true)
    assert.equal(body.next_before_id, 1354)
    const read = sqlCalls().find(call => /\/\* public:agreements \*\//i.test(call.query ?? ''))
    assert.deepEqual(
      read?.params?.map((value, index) => index === 1 ? String(value) : value == null ? null : String(value)),
      ['tiny-lantern', 'true', '1360', '4'],
    )

    fixtureState.current = { ...fixtureState.current, calls: [] }
    const nextResponse = await app.request(
      '/api/agreements?party=tiny-lantern&open=true&before_id=1354&limit=3',
    )
    const next = await nextResponse.json() as typeof body
    assert.deepEqual(next.agreements.map(row => row.id), [1352, 1350, 1348])
    assert.equal(next.agreements.some(row => body.agreements.some(previous => previous.id === row.id)), false)
  })

  test('remaining public collections reject invalid or duplicate page parameters', async () => {
    for (const path of [
      '/api/residents?before_id=0',
      '/api/kinds?limit=201',
      '/api/traits?before_id=nope',
      '/api/agreements?party=tiny-lantern&party=neighbor',
      '/api/agreements?open=true&open=false',
      '/api/agreements?limit=2&limit=3',
      '/api/moderation?before_id=2&before_id=1',
    ]) {
      reset({ scenario: 'remaining pagination' })
      const response = await app.request(path)
      assert.equal(response.status, 400, path)
      assert.equal(sqlCalls().length, 0, `${path} should fail before reading PostgreSQL`)
    }
  })

  test('/api/me independently pages every growing holdings and history collection', async () => {
    reset({ scenario: 'remaining pagination' })
    const firstResponse = await app.request('/api/me', { headers: authHeaders() })
    assert.equal(firstResponse.status, 200)
    const first = await firstResponse.json() as Record<string, unknown>
    assert.equal(first.front_door, 'https://1f3d9.com/')
    assert.equal(first.front_door_tool, 'front_door')
    const newestByCollection = {
      places: 1570,
      things: 1670,
      kinds: 1770,
      agreements: 1870,
      notes: 1970,
      offers: 2070,
    } as const
    const pages = first.pages as Record<string, Record<string, unknown>>
    for (const [collection, newest] of Object.entries(newestByCollection)) {
      const rows = first[collection] as Array<{ id: number }>
      assert.equal(rows.length, 10, collection)
      assert.deepEqual(rows.slice(0, 2).map(row => row.id), [newest, newest - 1], collection)
      assert.equal(pages[collection]?.has_more, true, collection)
      assert.equal(pages[collection]?.[`next_before_${collection.replace(/s$/, '')}_id`], newest - 9, collection)
    }

    fixtureState.current = { ...fixtureState.current, calls: [] }
    const secondResponse = await app.request(
      '/api/me?before_place_id=1561&place_limit=3' +
        '&before_thing_id=1661&thing_limit=3&before_kind_id=1761&kind_limit=3' +
        '&before_agreement_id=1861&agreement_limit=3&before_note_id=1961&note_limit=3' +
        '&before_offer_id=2061&offer_limit=3',
      { headers: authHeaders() },
    )
    assert.equal(secondResponse.status, 200)
    const second = await secondResponse.json() as Record<string, unknown>
    for (const [collection, newest] of Object.entries(newestByCollection)) {
      const rows = second[collection] as Array<{ id: number }>
      assert.deepEqual(rows.map(row => row.id), [newest - 10, newest - 11, newest - 12], collection)
      const previous = first[collection] as Array<{ id: number }>
      assert.equal(rows.some(row => previous.some(item => item.id === row.id)), false, collection)
    }
  })

  test('/api/me rejects invalid independent page parameters after authentication', async () => {
    for (const path of [
      '/api/me?place_limit=201',
      '/api/me?before_thing_id=0',
      '/api/me?note_limit=2&note_limit=3',
      '/api/me?before_offer_id=wat',
    ]) {
      reset({ scenario: 'remaining pagination' })
      const response = await app.request(path, { headers: authHeaders() })
      assert.equal(response.status, 400, path)
    }
  })
}
