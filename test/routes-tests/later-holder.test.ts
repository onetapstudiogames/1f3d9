import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'


export function registerLaterHolderTests(): void {
  const {
    LATER_HOLDER_CURSOR_KEY,
    PUBLIC_CREDENTIAL_REDACTION,
    SECRET,
    app,
    authHeaders,
    createLaterHolderCursorCodec,
    fixtureState,
    initialState,
    inserted,
    isLaterHolderCursor,
    reset,
    sqlCalls,
    test,
  } = getRoutesTestContext()


  test('passive /api/me notice is exact, live, private, and SELECT-only', async () => {
    const base = initialState().laterHolderItems[0]!
    for (const [count, expected] of [
      [0, { count: 0 }],
      [1, {
        count: 1,
        question:
          'An earlier holder of this resident identity marked 1 public item for later holders. View the index?',
      }],
      [2, {
        count: 2,
        question:
          'An earlier holder of this resident identity marked 2 public items for later holders. View the index?',
      }],
    ] as const) {
      reset({
        laterHolderItems: Array.from({ length: count }, (_, index) => ({
          ...base, mark_id: String(index + 1), id: 41 + index,
        })),
      })
      const response = await app.request('/api/me', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ mode: 'later_holder_notice' }),
      })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), expected)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(response.headers.get('pragma'), 'no-cache')
      assert.match(response.headers.get('vary') ?? '', /authorization/iu)
      const statements = sqlCalls().map(call => call.query ?? '')
      assert.ok(statements.some(query => /private:later-holder-notice/iu.test(query)))
      assert.equal(statements.every(query => /^\s*select\b/iu.test(query)), true)
      assert.equal(statements.some(query => /resident_presence|pending_effects|events|public_change/iu.test(query)), false)
    }
  })

  test('passive /api/me index returns only current headings and one chosen direct read returns the body', async () => {
    const base = initialState().laterHolderItems[0]!
    reset({
      laterHolderItems: [
        { ...base, mark_id: '3', id: 41, title: 'Current lantern title' },
        { ...base, mark_id: '2', id: 31, title: 'Buried old thing', body_text_bytes: 4096 },
      ],
    })
    const response = await app.request('/api/me', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ mode: 'later_holder_index', limit: 1 }),
    })
    assert.equal(response.status, 200)
    const payload = await response.json() as {
      count: number
      items: Array<Record<string, unknown>>
      has_more: boolean
      next_before: string | null
    }
    const { next_before: nextBefore, ...bodyWithoutCursor } = payload
    assert.deepEqual(bodyWithoutCursor, {
      count: 2,
      items: [{
        id: 41,
        type: 'thing',
        title: 'Current lantern title',
        place: { id: 2, title: 'Lantern Town' },
        date: '2026-08-11T00:00:00.000000Z',
        body_text_bytes: Buffer.byteLength('warm light'),
      }],
      has_more: true,
    })
    assert.equal(isLaterHolderCursor(nextBefore), true)
    assert.equal(createLaterHolderCursorCodec(LATER_HOLDER_CURSOR_KEY, 7).decode(nextBefore!), '3')
    const indexQuery = sqlCalls().find(call => /private:later-holder-index/iu.test(call.query ?? ''))
    assert.match(indexQuery?.query ?? '', /octet_length\s*\(\s*thing\.body\s*\)/iu)
    assert.doesNotMatch(indexQuery?.query ?? '', /thing\.body\s+(?:as\s+)?body\b/iu)

    const chosen = await app.request('/api/thing/41')
    assert.equal(chosen.status, 200)
    const chosenBody = await chosen.json() as { thing?: { body?: string } }
    assert.equal(chosenBody.thing?.body, 'warm light')
  })

  test('passive /api/me index redacts credential-shaped headings and rejects foreign cursors', async () => {
    const base = initialState().laterHolderItems[0]!
    reset({
      laterHolderItems: [{
        ...base,
        title: `unsafe ${SECRET}`,
        place_title: `unsafe ${SECRET}`,
      }],
    })
    const response = await app.request('/api/me', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ mode: 'later_holder_index' }),
    })
    assert.equal(response.status, 200)
    const payload = await response.json() as {
      items: Array<{ title: string; place: { title: string } }>
    }
    assert.deepEqual(payload.items[0], {
      id: 41,
      type: 'thing',
      title: PUBLIC_CREDENTIAL_REDACTION,
      place: { id: 2, title: PUBLIC_CREDENTIAL_REDACTION },
      date: '2026-08-11T00:00:00.000000Z',
      body_text_bytes: Buffer.byteLength('warm light'),
    })
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(SECRET, 'iu'))

    const foreignCursor = createLaterHolderCursorCodec(LATER_HOLDER_CURSOR_KEY, 8).encode('99')
    const invalid = await app.request('/api/me', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ mode: 'later_holder_index', before: foreignCursor }),
    })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.headers.get('cache-control'), 'no-store')
  })

  test('passive index fails closed when its cursor key is missing while notice stays available', async () => {
    reset()
    const previous = process.env.LATER_HOLDER_CURSOR_KEY
    delete process.env.LATER_HOLDER_CURSOR_KEY
    try {
      const index = await app.request('/api/me', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ mode: 'later_holder_index' }),
      })
      assert.equal(index.status, 503)
      assert.deepEqual(await index.json(), {
        error: 'later-holder index is unavailable because its private cursor key is not configured; ask the city owner to configure it before retrying',
      })
      assert.equal(index.headers.get('cache-control'), 'no-store')
      assert.equal(
        sqlCalls().some(call => /private:later-holder-index/iu.test(call.query ?? '')),
        false,
      )

      const notice = await app.request('/api/me', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ mode: 'later_holder_notice' }),
      })
      assert.equal(notice.status, 200)
    } finally {
      if (previous === undefined) delete process.env.LATER_HOLDER_CURSOR_KEY
      else process.env.LATER_HOLDER_CURSOR_KEY = previous
    }
  })

  test('passive /api/me rejects query options and unsupported fields before reading marks', async () => {
    for (const [path, body] of [
      ['/api/me?mode=later_holder_notice', { mode: 'later_holder_notice' }],
      ['/api/me', { mode: 'later_holder_notice', opened: false }],
      ['/api/me', { mode: 'later_holder_index', thing_id: 41 }],
      ['/api/me', { mode: 'later_holder_index', before: 3 }],
    ] as const) {
      reset()
      const response = await app.request(path, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify(body),
      })
      assert.equal(response.status, 400, `${path} ${JSON.stringify(body)}`)
      assert.equal(
        sqlCalls().some(call => /private:later-holder-(?:notice|index)/iu.test(call.query ?? '')),
        false,
      )
      assert.equal(response.headers.get('cache-control'), 'no-store')
    }
  })

  test('private mark and unmark are retry-safe and emit no public event or change', async () => {
    reset({ laterHolderItems: [] })
    const beforeMarker = fixtureState.current.publicChangeMarker
    const first = await app.request('/api/thing/41/mark', {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'mark' }),
    })
    assert.equal(first.status, 200)
    assert.deepEqual(await first.json(), { thing_id: 41, marked: true, changed: true })
    const repeated = await app.request('/api/thing/41/mark', {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'mark' }),
    })
    assert.deepEqual(await repeated.json(), { thing_id: 41, marked: true, changed: false })
    assert.equal(fixtureState.current.laterHolderItems.length, 1)

    const removed = await app.request('/api/thing/41/mark', {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'unmark' }),
    })
    assert.deepEqual(await removed.json(), { thing_id: 41, marked: false, changed: true })
    const absent = await app.request('/api/thing/41/mark', {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'unmark' }),
    })
    assert.deepEqual(await absent.json(), { thing_id: 41, marked: false, changed: false })
    assert.equal(fixtureState.current.laterHolderItems.length, 0)
    assert.equal(fixtureState.current.publicChangeMarker, beforeMarker)
    assert.equal(inserted('events'), 0)
    assert.equal(sqlCalls().some(call => /public_change/iu.test(call.query ?? '')), false)
    for (const response of [first, repeated, removed, absent]) {
      assert.equal(response.headers.get('cache-control'), 'no-store')
    }
  })

  test('passive discovery leaves timers asleep while ordinary GET /api/me still wakes them', async () => {
    reset({ pendingResolved: false })
    const passive = await app.request('/api/me', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ mode: 'later_holder_notice' }),
    })
    assert.equal(passive.status, 200)
    assert.equal(sqlCalls().some(call => /resident_presence|pending_effects/iu.test(call.query ?? '')), false)

    fixtureState.current = { ...fixtureState.current, calls: [] }
    const ordinary = await app.request('/api/me', { headers: authHeaders() })
    assert.equal(ordinary.status, 200)
    assert.equal(sqlCalls().some(call => /resident_presence/iu.test(call.query ?? '')), true)
  })
}
