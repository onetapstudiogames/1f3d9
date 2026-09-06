import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'


export function registerMapAndMarkersTests(): void {
  const {
    app,
    fixtureState,
    mapOutlineRows,
    recentIds,
    reset,
    sqlCalls,
    test,
  } = getRoutesTestContext()


  test('the legacy full public map stays exact and explicit full shares its short cache', async () => {
    const originalNow = Date.now
    try {
      // Backdate the clock so the map cache this test warms is already expired
      // for every later test.
      const realNow = originalNow()
      Date.now = () => realNow - 180_000
      reset({ scenario: 'map' })
      const response = await app.request('/api/map')
      assert.equal(response.status, 200)
      assert.equal(
        response.headers.get('cache-control'),
        'public, max-age=15, s-maxage=60, stale-while-revalidate=300',
      )
      const body = await response.json() as { places: { id: number; owner: string; children: { id: number }[] }[] }
      assert.equal(Object.hasOwn(body, 'view'), false, 'the no-query compatibility response stays exact')
      assert.equal(body.places[0]?.id, 1)
      assert.equal(body.places[0]?.owner, 'founder')
      assert.equal(body.places[0]?.children[0]?.id, 2)
      assert.ok(sqlCalls().some(call => /with\s+recursive/i.test(call.query ?? '')))

      const queriesAfterFirst = sqlCalls().length
      const cached = await app.request('/api/map')
      assert.equal(cached.status, 200)
      assert.equal(sqlCalls().length, queriesAfterFirst, 'a map within the TTL reuses the shared build')

      const explicit = await app.request('/api/map?view=full')
      assert.equal(explicit.status, 200)
      const explicitBody = await explicit.json() as { view: string; places: typeof body.places }
      assert.equal(explicitBody.view, 'full')
      assert.deepEqual(explicitBody.places, body.places)
      assert.equal(
        sqlCalls().length,
        queriesAfterFirst,
        'explicit and compatibility full reads share one full-map cache entry',
      )
    } finally {
      Date.now = originalNow
    }
  })

  test('the outline map pages one flat branch newest-first and caches its hot root page', async () => {
    const originalNow = Date.now
    try {
      const realNow = originalNow()
      Date.now = () => realNow - 140_000
      reset({ scenario: 'map outline' })
      const firstPath = '/api/map?view=outline'
      const firstResponse = await app.request(firstPath)
      assert.equal(firstResponse.status, 200)
      assert.equal(
        firstResponse.headers.get('cache-control'),
        'public, max-age=15, s-maxage=60, stale-while-revalidate=300',
      )
      const first = await firstResponse.json() as {
        view: string
        place: { id: number; name: string; parent_id: number | null; children: unknown[] }
        subplaces: Array<{ id: number; name: string; parent_id: number; description?: string; children: unknown[]; places: number }>
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
      assert.equal(first.view, 'outline')
      assert.equal(first.place.id, 1)
      assert.equal(first.place.name, 'the world')
      assert.equal(first.place.parent_id, null, 'world has no upward edge')
      assert.deepEqual(first.place.children, [])
      assert.deepEqual(first.subplaces.map(place => place.id), recentIds(160).slice(0, 10))
      assert.deepEqual(first.subplaces.map(({ id, name, parent_id }) => ({ id, name, parent_id })),
        recentIds(160).slice(0, 10).map(id => ({ id, name: `Map place ${id}`, parent_id: 1 })))
      assert.equal(first.subplaces.every(place => !Object.hasOwn(place, 'description')), true)
      assert.equal(first.subplaces.every(place => Array.isArray(place.children) && place.children.length === 0), true)
      assert.equal(first.subplaces[0]?.places, 2)
      assert.deepEqual(first.subplaces_page, {
        total_items: 60,
        total_text_bytes: mapOutlineRows().reduce(
          (total, row) => total + Buffer.byteLength(row.description, 'utf8'),
          0,
        ),
        returned_items: 10,
        returned_text_bytes: 0,
        has_more: true,
        next_before_subplace_id: 151,
      })
      assert.equal(first.map_complete, false)
      assert.equal(
        sqlCalls().some(call => /with\s+recursive\s+place_tree/i.test(call.query ?? '')),
        false,
        'an outline branch must not materialize the complete recursive map',
      )

      const callsAfterFirst = sqlCalls().length
      const cached = await app.request(firstPath)
      assert.equal(cached.status, 200)
      assert.deepEqual(await cached.json(), first)
      assert.equal(sqlCalls().length, callsAfterFirst, 'the initial root outline reuses its cache entry')

      const secondResponse = await app.request(
        '/api/map?view=outline&parent_id=1&before_subplace_id=151&subplace_limit=3',
      )
      assert.equal(secondResponse.status, 200)
      const second = await secondResponse.json() as typeof first
      assert.deepEqual(second.subplaces.map(place => place.id), [150, 149, 148])
      assert.equal(
        second.subplaces.some(place => first.subplaces.some(previous => previous.id === place.id)),
        false,
      )
      assert.equal(second.subplaces_page.next_before_subplace_id, 148)

      const read = sqlCalls().find(call => /\/\* public:map-outline \*\//i.test(call.query ?? ''))
      assert.deepEqual(
        read?.params?.map((value, index) => index === 1
          ? String(value)
          : value == null ? null : Number(value)),
        [null, 'the world', null, 11],
        'one statement selects the root and fetches one lookahead row',
      )
      assert.equal(
        sqlCalls().some(call => /\/\* public:map-parent \*\//i.test(call.query ?? '')),
        false,
        'the parent, totals, and page share one database snapshot',
      )
      const currentResponse = await app.request('/api/map?view=outline&parent_id=160&limit=1')
      assert.equal(currentResponse.status, 200, 'a non-root branch is anonymous to read')
      const current = await currentResponse.json() as typeof first
      assert.equal(current.place.id, 160)
      assert.equal(current.place.parent_id, 1, 'the current place names the upward edge ID')
      const upwardResponse = await app.request(`/api/map?view=outline&parent_id=${current.place.parent_id}&limit=1`)
      assert.equal(upwardResponse.status, 200)
      const upward = await upwardResponse.json() as typeof first
      assert.equal(upward.place.id, current.place.parent_id)
      assert.equal(upward.place.name, 'the world', 'the second bounded read names the upward neighbor')
      assert.equal(upward.subplaces.length, 1, 'limit=1 bounds children without dropping the selected parent')
    } finally {
      Date.now = originalNow
    }
  })

  test('map modes reject ambiguous, unsupported, and cross-mode options before PostgreSQL', async () => {
    for (const path of [
      '/api/map?view=outline&view=full',
      '/api/map?view=sideways',
      '/api/map?parent_id=1',
      '/api/map?view=full&parent_id=1',
      '/api/map?view=full&before_subplace_id=2',
      '/api/map?view=full&subplace_limit=2',
      '/api/map?view=outline&parent_id=0',
      '/api/map?view=outline&parent_id=2147483648',
      '/api/map?view=outline&before_subplace_id=1.5',
      '/api/map?view=outline&subplace_limit=0',
      '/api/map?view=outline&subplace_limit=201',
      '/api/map?view=outline&subplace_limit=2&subplace_limit=3',
      '/api/map?view=outline&after_change_marker=-1',
      '/api/map?view=outline&after_change_marker=01',
      '/api/map?view=outline&after_change_marker=9&after_change_marker=10',
      '/api/map?after_change_marker=9',
      '/api/map?view=outline&unknown=1',
    ]) {
      reset({ scenario: 'map outline' })
      const response = await app.request(path)
      assert.equal(response.status, 400, path)
      assert.equal(sqlCalls().length, 0, `${path} must fail before PostgreSQL work`)
    }
  })

  test('lazy map and history pages prove they cover the caller-held change marker', async () => {
    reset({ scenario: 'map outline', publicChangeMarker: '9' })
    const map = await app.request(
      '/api/map?view=outline&parent_id=1&subplace_limit=3&after_change_marker=9',
    )
    assert.equal(map.status, 200)
    assert.equal(map.headers.get('cache-control'), 'no-store')
    assert.equal((await map.json() as { change_marker: string }).change_marker, '9')
    assert.ok(sqlCalls().some(call => /\/\* public:changes-checkpoint \*\//iu.test(call.query ?? '')))
    assert.ok(sqlCalls().some(call => /\/\* public:map-outline \*\//iu.test(call.query ?? '')))

    reset({ scenario: 'public pagination', publicChangeMarker: '9' })
    const history = await app.request(
      '/api/window?collection=things&limit=2&after_change_marker=9',
    )
    assert.equal(history.status, 200)
    assert.equal(history.headers.get('cache-control'), 'no-store')
    assert.equal((await history.json() as { change_marker: string }).change_marker, '9')

    reset({ scenario: 'public pagination', publicChangeMarker: '9' })
    const events = await app.request('/api/events?limit=2&after_change_marker=9')
    assert.equal(events.status, 200)
    assert.equal(events.headers.get('cache-control'), 'no-store')
    assert.equal((await events.json() as { change_marker: string }).change_marker, '9')

    for (const path of [
      '/api/map?view=outline&parent_id=1&after_change_marker=10',
      '/api/window?collection=things&after_change_marker=10',
      '/api/events?after_change_marker=10',
      '/api/residents?view=presence&after_change_marker=10',
      '/api/residents?view=presence&handle=tiny-lantern&after_change_marker=10',
    ]) {
      reset({ scenario: 'public pagination', publicChangeMarker: '9' })
      const response = await app.request(path)
      assert.equal(response.status, 409, path)
      assert.deepEqual(await response.json(), {
        error: 'after_change_marker 10 is ahead of checkpoint 9',
      })
      assert.equal(
        sqlCalls().filter(call => !/\/\* public:changes-checkpoint \*\//iu.test(call.query ?? '')).length,
        0,
        `${path} stops before its page read`,
      )
    }
  })

  test('an events change marker proves coverage without filtering rows', async () => {
    reset({ scenario: 'public pagination', publicChangeMarker: '69' })
    const ordinaryResponse = await app.request('/api/events?limit=3')
    assert.equal(ordinaryResponse.status, 200)
    const ordinary = await ordinaryResponse.json() as {
      events: Array<{ id: number; change_id: string }>
    }
    const ordinaryRead = sqlCalls().find(call => /\/\* public:events \*\//iu.test(call.query ?? ''))
    assert.ok(ordinaryRead)

    reset({ scenario: 'public pagination', publicChangeMarker: '69' })
    const coveredResponse = await app.request('/api/events?limit=3&after_change_marker=69')
    assert.equal(coveredResponse.status, 200)
    const covered = await coveredResponse.json() as {
      events: Array<{ id: number; change_id: string }>
    }
    const coveredRead = sqlCalls().find(call => /\/\* public:events \*\//iu.test(call.query ?? ''))
    assert.ok(coveredRead)

    assert.deepEqual(covered.events, ordinary.events)
    assert.equal(coveredRead.query, ordinaryRead.query)
    assert.deepEqual(coveredRead.params, ordinaryRead.params)
    assert.ok(
      covered.events.some(event => BigInt(event.change_id) <= 69n),
      'after_change_marker is a coverage barrier, not an event-row filter',
    )
  })

  test('window reads retry an interleaved public commit instead of labeling newer rows with an older marker', async () => {
    const originalNow = Date.now
    const frozenNow = originalNow() - 120_000
    Date.now = () => frozenNow
    const cases = [
      {
        name: 'outline snapshot',
        scenario: 'window outline',
        path: '/api/window?view=outline&after_change_marker=20',
        dataPattern: /\/\* public:window-live-survey \*\//iu,
        raceNeedle: '/* public:window-live-survey */',
      },
      {
        name: 'focused or paged map',
        scenario: 'map outline',
        path: '/api/map?view=outline&parent_id=1&subplace_limit=3&after_change_marker=20',
        dataPattern: /\/\* public:map-outline \*\//iu,
      },
      {
        name: 'window history',
        scenario: 'public pagination',
        path: '/api/window?collection=things&limit=2&after_change_marker=20',
        dataPattern: /from things thing/iu,
      },
      {
        name: 'happenings',
        scenario: 'public pagination',
        path: '/api/events?limit=2&after_change_marker=20',
        dataPattern: /\/\* public:events \*\//iu,
      },
      {
        name: 'paged resident presence',
        scenario: 'remaining pagination',
        path: '/api/residents?view=presence&limit=2&after_change_marker=20',
        dataPattern: /\/\* public:residents \*\//iu,
      },
      {
        name: 'focused resident presence',
        scenario: '',
        path: '/api/residents?view=presence&handle=tiny-lantern&after_change_marker=20',
        dataPattern: /\/\* public:resident-presence \*\//iu,
      },
    ] as const

    try {
      for (const entry of cases) {
        reset({
          scenario: entry.scenario,
          publicChangeMarker: '20',
          publicReadMarkerRaces: 1,
          publicReadMarkerRaceNeedle: 'raceNeedle' in entry ? entry.raceNeedle : null,
        })
        const response = await app.request(entry.path)
        assert.equal(response.status, 200, entry.name)
        assert.equal(
          (await response.json() as { change_marker?: string }).change_marker,
          '21',
          `${entry.name} returns the checkpoint proven around its accepted rows`,
        )
        assert.equal(
          fixtureState.current.publicReadMarkerRaces,
          0,
          `${entry.name} crosses its named data read rather than an earlier neighbor`,
        )
        assert.ok(
          sqlCalls().filter(call => entry.dataPattern.test(call.query ?? '')).length >= 2,
          `${entry.name} discards and rereads the page crossed by the commit`,
        )
      }
    } finally {
      Date.now = originalNow
    }
  })

  test('a window read that crosses both attempts returns one explicit retryable conflict', async () => {
    reset({
      scenario: 'public pagination',
      publicChangeMarker: '20',
      publicReadMarkerRaces: 2,
    })

    const response = await app.request('/api/events?limit=2&after_change_marker=20')

    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), {
      error: 'public view changed from marker 21 to 22 while it was being read; retry',
    })
    assert.equal(
      sqlCalls().filter(call => /\/\* public:events \*\//iu.test(call.query ?? '')).length,
      2,
      'both crossed event reads are discarded',
    )
    assert.equal(
      sqlCalls().filter(call => /\/\* public:changes-checkpoint \*\//iu.test(call.query ?? '')).length,
      4,
      'each attempt checks the checkpoint before and after its event rows',
    )
  })

  test('a large, deep, credential-free map is served instead of withheld', async () => {
    const originalNow = Date.now
    try {
      // A different backdate than the previous map test so its cache entry is
      // already stale here, and this test's own entry is stale for later ones.
      const realNow = originalNow()
      Date.now = () => realNow - 120_000
      reset({ scenario: 'large map' })
      const response = await app.request('/api/map')
      assert.equal(response.status, 200)
      const body = await response.json() as { places: Array<{ id: number; children: Array<{ id: number }> }> }
      assert.equal(body.places[0]?.id, 1)
      assert.ok((body.places[0]?.children.length ?? 0) >= 1400)
      let depth = 0
      let cursor = body.places[0]?.children.find(child => child.id === 3000) as
        { id: number; children: { id: number; children: unknown[] }[] } | undefined
      while (cursor) {
        depth += 1
        cursor = cursor.children[0] as typeof cursor
      }
      assert.equal(depth, 16)
    } finally {
      Date.now = originalNow
    }
  })
}
