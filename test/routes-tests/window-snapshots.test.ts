import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'


export function registerWindowSnapshotsTests(): void {
  const {
    SECRET,
    app,
    recentIds,
    reset,
    sqlCalls,
    test,
  } = getRoutesTestContext()


  test('the window snapshot marks residents asleep from their last public act', async () => {
    const originalNow = Date.now
    try {
      // Backdate the clock so the snapshot cache this test warms is already
      // expired for every later test.
      const realNow = originalNow()
      Date.now = () => realNow - 120_000
      reset({ scenario: 'window roster' })
      const response = await app.request('/api/window')
      assert.equal(response.status, 200)
      const body = await response.json() as { residents: Array<{ handle: string; asleep: boolean }> }
      assert.deepEqual(body.residents.map(resident => [resident.handle, resident.asleep]), [
        ['long-gone', true],
        ['tiny-lantern', false],
      ])
      const roster = sqlCalls().find(call => /left join resident_presence/i.test(call.query ?? ''))
      assert.match(roster?.query ?? '', /recent_public_act/i)
      assert.match(roster?.query ?? '', /interval '1 day'/i)
    } finally {
      Date.now = originalNow
    }
  })

  test('the legacy full window stays exact and explicit full shares its snapshot cache', async () => {
    const originalNow = Date.now
    try {
      const realNow = originalNow()
      Date.now = () => realNow - 80_000
      reset({ scenario: 'window roster' })

      const legacyResponse = await app.request('/api/window')
      assert.equal(legacyResponse.status, 200)
      const legacy = await legacyResponse.json() as Record<string, unknown>
      assert.equal(Object.hasOwn(legacy, 'view'), false)
      assert.equal(Object.hasOwn(legacy, 'live_survey'), false)
      assert.equal(legacy.map_complete, false)
      const callsAfterLegacy = sqlCalls().length

      const explicitResponse = await app.request('/api/window?view=full')
      assert.equal(explicitResponse.status, 200)
      const explicit = await explicitResponse.json() as Record<string, unknown>
      assert.equal(explicit.view, 'full')
      assert.equal(Object.hasOwn(explicit, 'live_survey'), false)
      assert.deepEqual(
        Object.fromEntries(Object.entries(explicit).filter(([key]) => key !== 'view')),
        legacy,
      )
      assert.equal(
        sqlCalls().length,
        callsAfterLegacy,
        'compatibility and explicit full reads share one full-snapshot cache entry',
      )
    } finally {
      Date.now = originalNow
    }
  })

  test('the outline window bounds its map and presence pages without changing recent histories', async () => {
    const originalNow = Date.now
    try {
      const realNow = originalNow()
      Date.now = () => realNow - 40_000
      reset({ scenario: 'window outline' })
      const response = await app.request('/api/window?view=outline')
      assert.equal(response.status, 200)
      assert.equal(
        response.headers.get('cache-control'),
        'public, max-age=15, s-maxage=60, stale-while-revalidate=300',
      )
      const body = await response.json() as {
        view: string
        places: Array<{
          id: number
          children: Array<{ id: number; description?: string; children: unknown[] }>
        }>
        residents: Array<{ id: number; current_place_id: number | null; asleep: boolean }>
        notes: Array<{ id: number }>
        things: Array<{ id: number }>
        agreements: Array<{ id: number }>
        events: Array<{
          id: number
          kind: string
          detail: Record<string, number | string>
        }>
        live_survey: Array<{ id: number; parent_id: number | null; things: number; notes: number }>
        pages: {
          places: { has_more: boolean; next_before_subplace_id: number | null }
          residents: { has_more: boolean; next_before_id: number | null }
        }
        totals: Record<string, number>
        shown: Record<string, number>
        limits: Record<string, number | null>
        change_marker: string
      }
      assert.equal(body.view, 'outline')
      assert.equal(body.change_marker, '9')
      assert.deepEqual(
        body.live_survey.map(place => place.id),
        [1, ...recentIds(160).reverse()],
        'the marker-covered survey carries every place, not only the bounded map page',
      )
      assert.equal(body.live_survey.every(place => (
        Object.keys(place).sort().join(',') === 'id,notes,parent_id,things' &&
        Number.isSafeInteger(place.things) && place.things >= 0 &&
        Number.isSafeInteger(place.notes) && place.notes >= 0
      )), true, 'the compact survey exposes only topology and direct thing/note counts')
      assert.deepEqual(body.places.map(place => place.id), [1])
      assert.deepEqual(body.places[0]?.children.map(place => place.id), recentIds(160).slice(0, 10))
      assert.equal(body.places[0]?.children.every(place => (
        place.children.length === 0 && !Object.hasOwn(place, 'description')
      )), true)
      assert.deepEqual(body.residents.map(resident => resident.id), recentIds(1070).slice(0, 25))
      assert.equal(body.residents.every(resident => (
        Object.hasOwn(resident, 'current_place_id') && Object.hasOwn(resident, 'asleep')
      )), true)
      assert.deepEqual(
        [body.notes.length, body.things.length, body.agreements.length, body.events.length],
        [10, 10, 10, 10],
        'the four already-bounded histories stay at ten rows',
      )
      assert.doesNotMatch(
        JSON.stringify({
          places: body.places,
          residents: body.residents,
          notes: body.notes,
          things: body.things,
          agreements: body.agreements,
          events: body.events,
        }),
        /"(?:drawing[^" ]*|thumb[^" ]*)"\s*:/iu,
        'ordinary window list rows remain drawing-payload-free',
      )
      assert.deepEqual(body.events[0]?.detail, {
        from_place_id: 1,
        to_place_id: 2,
        action_id: 170,
        action: 'move',
        status: 'applied',
      })
      assert.deepEqual(body.totals, {
        places: 61,
        residents: 60,
        conversations: 60,
        things: 60,
        agreements: 60,
        events: 70,
      })
      assert.deepEqual(body.shown, {
        places: 11,
        residents: 25,
        conversations: 10,
        things: 10,
        agreements: 10,
        events: 10,
      })
      assert.deepEqual(body.limits, {
        places: 10,
        residents: 25,
        conversations: 10,
        things: 10,
        agreements: 10,
        events: 10,
      })
      assert.deepEqual(body.pages.places, {
        has_more: true,
        next_before_subplace_id: 151,
      })
      assert.deepEqual(body.pages.residents, {
        has_more: true,
        next_before_id: 1046,
      })
      assert.equal(
        sqlCalls().some(call => /with\s+recursive\s+world/i.test(call.query ?? '')),
        false,
        'the outline window must not materialize the complete map',
      )
    } finally {
      Date.now = originalNow
    }
  })

  test('window modes reject mixed, duplicate, and unknown options before PostgreSQL', async () => {
    for (const path of [
      '/api/window?view=outline&view=full',
      '/api/window?view=sideways',
      '/api/window?view=full&collection=notes',
      '/api/window?view=outline&before_id=2',
      '/api/window?view=outline&unknown=1',
      '/api/window?view=full&after_change_marker=9',
      '/api/window?after_change_marker=9',
      '/api/window?view=outline&after_change_marker=-1',
      '/api/window?view=outline&after_change_marker=01',
      '/api/window?view=outline&after_change_marker=9223372036854775808',
      '/api/window?view=outline&after_change_marker=9&after_change_marker=10',
    ]) {
      reset({ scenario: 'window outline' })
      const response = await app.request(path)
      assert.equal(response.status, 400, path)
      assert.equal(sqlCalls().length, 0, `${path} must fail before PostgreSQL work`)
    }
  })

  test('the directory window is one cached, moderated, body-free statement with exact keys', async () => {
    const originalNow = Date.now
    try {
      const frozenNow = originalNow() - 120_000
      Date.now = () => frozenNow
      reset({ scenario: 'window directory' })

      const firstResponse = await app.request('/api/window?view=directory')
      assert.equal(firstResponse.status, 200)
      assert.equal(
        firstResponse.headers.get('cache-control'),
        'public, max-age=15, s-maxage=60, stale-while-revalidate=300',
      )
      const directory = await firstResponse.json() as Record<string, unknown> & {
        places: Array<Record<string, unknown>>
        residents: Array<Record<string, unknown>>
      }
      assert.deepEqual(Object.keys(directory).sort(), ['places', 'residents', 'view'])
      assert.equal(Object.hasOwn(directory, 'live_survey'), false)
      assert.equal(directory.view, 'directory')
      assert.deepEqual(
        Object.keys(directory.places[0] ?? {}).sort(),
        ['id', 'name', 'parent_id', 'quiet', 'type'],
      )
      assert.deepEqual(Object.keys(directory.residents[0] ?? {}).sort(), [
        'handle', 'has_drawing', 'id', 'type',
      ])
      assert.deepEqual(directory.places, [
        { type: 'place', id: 1, parent_id: null, name: 'the world', quiet: false },
        { type: 'place', id: 2, parent_id: 1, name: '[removed by maintainer]', quiet: false },
      ])
      assert.deepEqual(directory.residents, [{
        type: 'resident', id: 7, handle: 'tiny-lantern', has_drawing: false,
      }])

      const directoryCalls = sqlCalls().filter(call =>
        /\/\* public:window-directory \*\//iu.test(call.query ?? ''))
      assert.equal(directoryCalls.length, 1)
      assert.match(directoryCalls[0]?.query ?? '', /moderation_actions/iu)
      assert.doesNotMatch(
        directoryCalls[0]?.query ?? '',
        /\b(?:description|purpose|owner_id|secret_hash|model|joined_at|current_place_id|asleep)\b/iu,
      )

      const callsAfterFirst = sqlCalls().length
      const cachedResponse = await app.request('/api/window?view=directory')
      assert.equal(cachedResponse.status, 200)
      assert.deepEqual(await cachedResponse.json(), directory)
      assert.equal(sqlCalls().length, callsAfterFirst)
    } finally {
      Date.now = originalNow
    }
  })

  test('the directory window rejects mixed, duplicate, unknown, and credentialed input before PostgreSQL', async () => {
    const cases: Array<{ path: string; headers?: Record<string, string> }> = [
      { path: '/api/window?view=directory&view=outline' },
      { path: '/api/window?view=directory&after_change_marker=9' },
      { path: '/api/window?view=directory&collection=places' },
      { path: '/api/window?view=directory&unknown=1' },
      { path: '/api/window?view=directory', headers: { Authorization: `Bearer ${SECRET}` } },
      { path: '/api/window?view=directory', headers: { Cookie: 'session=private' } },
    ]
    for (const entry of cases) {
      reset({ scenario: 'window directory' })
      const response = await app.request(
        entry.path,
        entry.headers === undefined ? undefined : { headers: entry.headers },
      )
      assert.equal(response.status, 400, entry.path)
      assert.equal(sqlCalls().length, 0, `${entry.path} must fail before PostgreSQL work`)
    }
  })

  test('a marker-covered outline bypasses stale caches and rejects a future marker', async () => {
    reset({ scenario: 'window outline', publicChangeMarker: '10' })
    const covered = await app.request('/api/window?view=outline&after_change_marker=10')
    assert.equal(covered.status, 200)
    assert.equal(covered.headers.get('cache-control'), 'no-store')
    const body = await covered.json() as { change_marker: string }
    assert.equal(body.change_marker, '10')
    assert.ok(
      sqlCalls().some(call => /\/\* public:map-outline \*\//iu.test(call.query ?? '')),
      'a covered snapshot reads the map directly instead of accepting a nested stale cache',
    )
    const callsAfterCoveredRead = sqlCalls().length
    const repeated = await app.request('/api/window?view=outline&after_change_marker=10')
    assert.equal(repeated.status, 200)
    assert.equal(repeated.headers.get('cache-control'), 'no-store')
    assert.equal(
      sqlCalls().length,
      callsAfterCoveredRead,
      'the same covered marker shares its proven in-process snapshot',
    )

    reset({ scenario: 'window outline', publicChangeMarker: '10' })
    const future = await app.request('/api/window?view=outline&after_change_marker=11')
    assert.equal(future.status, 409)
    assert.deepEqual(await future.json(), {
      error: 'after_change_marker 11 is ahead of checkpoint 10',
    })
    assert.equal(
      sqlCalls().some(call => /\/\* public:map-outline \*\//iu.test(call.query ?? '')),
      false,
      'a future marker stops before the snapshot fanout',
    )
    const callsAfterFuture = sqlCalls().length
    const ordinary = await app.request('/api/window?view=outline')
    assert.equal(ordinary.status, 200)
    assert.equal(
      sqlCalls().length,
      callsAfterFuture,
      'a rejected future marker does not poison or evict the valid shared snapshot',
    )
  })

  test('a busy outline-window census starts no secondary public reads', async () => {
    const originalNow = Date.now
    try {
      const now = originalNow()
      Date.now = () => now + 40_000
      reset({ scenario: 'window outline', exactTotalsBusy: true })
      const response = await app.request('/api/window?view=outline')
      assert.equal(response.status, 503)
      assert.equal(response.headers.get('retry-after'), '1')
      assert.deepEqual(await response.json(), {
        error: 'exact public totals are temporarily busy; retry',
      })
      const secondaryRead = sqlCalls().find(call => /public:map-(?:parent|outline)|public:window-live-survey|from notes note|from things thing|from agreements agreement|select id, at, kind, actor, detail|select count\(\*\)::int from places/iu.test(call.query ?? ''))
      assert.equal(
        secondaryRead,
        undefined,
        'admission must reject before map, history, or global-total work starts',
      )
    } finally {
      Date.now = originalNow
    }
  })

  test('busy outline-window global totals stop before map or history reads', async () => {
    const originalNow = Date.now
    try {
      const now = originalNow()
      Date.now = () => now + 80_000
      reset({
        scenario: 'window outline',
        exactTotalsBusyAfter: 1,
      })
      const response = await app.request('/api/window?view=outline')
      assert.equal(response.status, 503)
      assert.equal(response.headers.get('retry-after'), '1')
      assert.deepEqual(await response.json(), {
        error: 'exact public totals are temporarily busy; retry',
      })
      const budgetedReads = sqlCalls().filter(call =>
        call.query?.includes('/* public:budgeted-exact */'))
      assert.equal(budgetedReads.length, 2, 'census passes before global totals reject')
      const secondaryRead = sqlCalls().find(call =>
        /public:map-(?:parent|outline)|public:window-live-survey|from notes note|from things thing|from agreements agreement|select id, at, kind, actor, detail/iu.test(call.query ?? ''))
      assert.equal(
        secondaryRead,
        undefined,
        'global-total admission must reject before map or history work starts',
      )
    } finally {
      Date.now = originalNow
    }
  })
}
