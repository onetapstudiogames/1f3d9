import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'


export function registerBoundaryAndNotesTests(): void {
  const {
    PUBLIC_PAGE_DEFAULT,
    PUBLIC_PAGE_MAX,
    app,
    authHeaders,
    finalizePublicPage,
    fixtureState,
    inserted,
    parsePublicPage,
    reset,
    sqlCalls,
    test,
  } = getRoutesTestContext()


  test('public pagination applies one bounded default and rejects ambiguous or invalid values', () => {
    assert.equal(PUBLIC_PAGE_DEFAULT, 10)
    assert.equal(PUBLIC_PAGE_MAX, 200)
    assert.deepEqual(parsePublicPage({}, 'before_id', 'limit'), {
      ok: true,
      cursor: null,
      limit: 10,
      fetchLimit: 11,
    })
    assert.deepEqual(parsePublicPage({ before_id: ['41'], limit: ['200'] }, 'before_id', 'limit'), {
      ok: true,
      cursor: 41,
      limit: 200,
      fetchLimit: 201,
    })
    assert.deepEqual(
      parsePublicPage({ limit: ['4'] }, 'before_note_id', 'note_limit', 'limit'),
      { ok: true, cursor: null, limit: 4, fetchLimit: 5 },
    )
    assert.deepEqual(
      parsePublicPage(
        { limit: ['4'], note_limit: ['2'] },
        'before_note_id',
        'note_limit',
        'limit',
      ),
      { ok: true, cursor: null, limit: 2, fetchLimit: 3 },
    )
    assert.equal(
      parsePublicPage(
        { limit: ['wat'], note_limit: ['2'] },
        'before_note_id',
        'note_limit',
        'limit',
      ).ok,
      false,
    )

    for (const query of [
      { before_id: ['0'] },
      { before_id: ['1.5'] },
      { before_id: ['wat'] },
      { before_id: ['2147483648'] },
      { before_id: ['4', '3'] },
      { limit: ['0'] },
      { limit: ['201'] },
      { limit: ['2', '3'] },
    ]) {
      assert.equal(parsePublicPage(query, 'before_id', 'limit').ok, false, JSON.stringify(query))
    }

    const source = Object.freeze([{ id: 3 }, { id: 2 }, { id: 1 }])
    const finalized = finalizePublicPage(source, 2)
    assert.deepEqual(finalized, {
      items: [{ id: 3 }, { id: 2 }],
      hasMore: true,
      nextCursor: 2,
    })
    assert.equal(Object.isFrozen(finalized), true)
    assert.equal(Object.isFrozen(finalized.items), true)
    assert.deepEqual(source.map(row => row.id), [3, 2, 1])
  })

  test('decision 74: the JSON identity doors reject an old-shaped registration and a bare-header rotation before any write', async () => {
    // Decision row 74 turned POST /api/register and POST /api/rotate into real
    // coding-client doors: they are no longer a static "moved to the browser"
    // stub. A request shaped like the old bearer/plain-registration attempt is
    // now refused by input validation -- missing client_class and
    // human_approved for register, and a rotation without a JSON
    // {"action":...} body -- before any SQL runs, which is what this test now
    // proves instead of a blanket 410.
    reset({ scenario: 'identity' })
    const registered = await app.request('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: ' Tiny-Lantern ', model: 'openai-codex', action: 'stage' }),
    })
    assert.equal(registered.status, 400)
    assert.match(
      (await registered.json() as { error: string }).error,
      /client_class|human_approved/i,
    )
    assert.equal(sqlCalls().length, 0)

    // IDENTITY_ROTATION_ENABLED is unset in this suite's environment, so the
    // JSON rotation door itself is off (matching /rotate's own browser-page
    // gating) and answers honestly with 503 rather than ever reading SQL.
    const rotated = await app.request('/api/rotate', { method: 'POST', headers: authHeaders() })
    assert.equal(rotated.status, 503)
    const rotationError = (await rotated.json() as { error: string }).error
    assert.match(rotationError, /private browser page at \/rotate is already live/iu)
    assert.match(rotationError, /IDENTITY_ROTATION_ENABLED=true/u)
    assert.match(rotationError, /GET \/api\/official/u)
    assert.equal(sqlCalls().length, 0)
  })

  test('malformed JSON-door registration never trusts or stores forwarding headers', async () => {
    // A request still missing client_class/human_approved fails validation
    // before src/identity-api.ts ever calls clientAddress(), so no forwarded-IP
    // header is trusted or reaches the database either.
    reset({ scenario: 'trusted registration IP' })
    const register = (handle: string, forwarded: string, vercel?: string) => app.request('/api/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': forwarded,
        ...(vercel ? { 'X-Vercel-Forwarded-For': vercel } : {}),
      },
      body: JSON.stringify({ handle, model: 'test', action: 'stage' }),
    })

    assert.equal((await register('edge-one', '198.51.100.1, 203.0.113.9', '192.0.2.7')).status, 400)
    assert.equal((await register('proxy-one', '198.51.100.1, 203.0.113.20')).status, 400)
    assert.equal(sqlCalls().length, 0)
  })

  test('malformed auth and oversized thing text fail before any world write', async () => {
    reset({ scenario: 'validation' })
    const unauthenticated = await app.request('/api/note', {
      method: 'POST',
      headers: authHeaders('not-a-city-secret'),
      body: JSON.stringify({ place_id: 2, body: 'hello' }),
    })
    assert.equal(unauthenticated.status, 401)
    assert.deepEqual(await unauthenticated.json(), {
      error: 'resident sign-in failed because Authorization: Bearer is missing or does not contain a current city key; send your saved current key as Authorization: Bearer <key>',
    })
    assert.equal(inserted('notes'), 0)

    const oversized = await app.request('/api/thing', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ place_id: 2, name: 'too much', body: 'x'.repeat(64 * 1024 + 1) }),
    })
    assert.equal(oversized.status, 400)
    assert.match(JSON.stringify(await oversized.json()), /64\s*kb|65536/i)
    assert.equal(inserted('things'), 0)
  })

  test('note validation distinguishes place errors and preserves valid Unicode exactly', async () => {
    reset({ scenario: 'note validation' })
    const invalidPlace = await app.request('/api/note', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ place_id: 0, body: 'valid words' }),
    })
    assert.equal(invalidPlace.status, 400)
    assert.deepEqual(await invalidPlace.json(), { error: 'place_id must be a positive integer' })
    assert.equal(inserted('notes'), 0)

    reset({ scenario: 'note validation' })
    const invalidBody = await app.request('/api/note', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ place_id: 2, body: '\u0000' }),
    })
    assert.equal(invalidBody.status, 400)
    assert.deepEqual(await invalidBody.json(), { error: 'body must be 1-4000 safe characters' })
    assert.equal(inserted('notes'), 0)

    reset({ scenario: 'note validation' })
    const body = 'Café — east wing 🗺️'
    const accepted = await app.request('/api/note', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ place_id: 2, body }),
    })
    assert.equal(accepted.status, 201)
    const acceptedBody = await accepted.json() as {
      note: { body: string }
      reading_cost: { size_unit: string; new_item_text_bytes: number; room_stored_text_bytes: number; current_first_read_text_bytes: number }
    }
    assert.equal(acceptedBody.note.body, body)
    assert.deepEqual(acceptedBody.reading_cost, {
      available: true,
      size_unit: 'utf8_bytes',
      counted_text: 'place descriptions and purposes, active thing bodies, and note bodies',
      new_item_text_bytes: Buffer.byteLength(body, 'utf8'),
      room_stored_text_bytes: 1234,
      current_first_read_text_bytes: 456,
    })
  })

  test('note character limits count exact stored whitespace at both boundaries', async () => {
    reset({ scenario: 'note validation' })
    const whitespaceOnlyBody = '   '
    const whitespaceOnly = await app.request('/api/note', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ place_id: 2, body: whitespaceOnlyBody }),
    })
    assert.equal(whitespaceOnly.status, 201)
    assert.equal(
      (await whitespaceOnly.json() as { note: { body: string } }).note.body,
      whitespaceOnlyBody,
    )

    reset({ scenario: 'note validation' })
    const overLimitBody = ` ${'x'.repeat(3_999)} `
    const overLimit = await app.request('/api/note', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ place_id: 2, body: overLimitBody }),
    })
    assert.equal(overLimit.status, 400)
    assert.deepEqual(await overLimit.json(), { error: 'body must be 1-4000 safe characters' })
    assert.equal(inserted('notes'), 0)

    reset({ scenario: 'note validation' })
    const exactLimitBody = ` ${'x'.repeat(3_998)} `
    const exactLimit = await app.request('/api/note', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ place_id: 2, body: exactLimitBody }),
    })
    assert.equal(exactLimit.status, 201)
    assert.equal(
      (await exactLimit.json() as { note: { body: string } }).note.body,
      exactLimitBody,
    )

    reset({ scenario: 'note validation' })
    const exactUnicodeLimit = '😀'.repeat(4_000)
    const acceptedUnicode = await app.request('/api/note', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ place_id: 2, body: exactUnicodeLimit }),
    })
    assert.equal(acceptedUnicode.status, 201)
    assert.equal(
      (await acceptedUnicode.json() as { note: { body: string } }).note.body,
      exactUnicodeLimit,
    )

    reset({ scenario: 'note validation' })
    const overUnicodeLimit = await app.request('/api/note', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ place_id: 2, body: '😀'.repeat(4_001) }),
    })
    assert.equal(overUnicodeLimit.status, 400)
    assert.deepEqual(
      await overUnicodeLimit.json(),
      { error: 'body must be 1-4000 safe characters' },
    )
  })

  test('an identical note retry returns the first note without quota, writes, or events', async () => {
    reset({ scenario: 'note retry', openToNotes: true })
    const request = () => app.request('/api/note', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ place_id: 2, body: 'One durable thought. 🏙️' }),
    })

    const first = await request()
    assert.equal(first.status, 201)
    const firstBody = await first.json() as { note: Record<string, unknown> }

    fixtureState.current = {
      ...fixtureState.current,
      calls: [],
      quota: { ...fixtureState.current.quota, notes: false },
    }
    const replay = await request()
    assert.equal(replay.status, 200)
    const replayBody = await replay.json() as { note: Record<string, unknown> }

    assert.deepEqual(replayBody.note, firstBody.note)
    assert.equal(inserted('notes'), 0)
    assert.equal(inserted('events'), 0)
    assert.equal(inserted('action_runs'), 0)
    const duplicateRead = sqlCalls().find(call => (
      /\/\* note-action:recent-duplicate \*\//iu.test(call.query ?? '')
    ))
    assert.ok(duplicateRead, 'the retry must check the bounded exact-note window')
    assert.equal(Number(duplicateRead.params?.[3]), 300)
    assert.match(
      duplicateRead.query ?? '',
      /note\.author_id\s*=\s*\$1[\s\S]*note\.place_id\s*=\s*\$2[\s\S]*note\.body\s+COLLATE\s+"C"\s*=\s*\$3::text\s+COLLATE\s+"C"/iu,
    )
    assert.doesNotMatch(
      duplicateRead.query ?? '',
      /gazette_withdrawals|gazette_withdrawal_/iu,
      'ordinary note replay must not require the separately deployed Gazette schema',
    )
  })

  test('an identical note retry replays before later place permission changes', async () => {
    reset({ scenario: 'note retry', openToNotes: true })
    const request = () => app.request('/api/note', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ place_id: 2, body: 'One durable thought. 🏙️' }),
    })

    const first = await request()
    assert.equal(first.status, 201)
    const firstBody = await first.json() as { note: Record<string, unknown> }

    fixtureState.current = {
      ...fixtureState.current,
      calls: [],
      placeOwnerId: 8,
      openToNotes: false,
      quota: { ...fixtureState.current.quota, notes: false },
    }
    const replay = await request()
    assert.equal(replay.status, 200)
    const replayBody = await replay.json() as { note: Record<string, unknown> }

    assert.deepEqual(replayBody.note, firstBody.note)
    assert.equal(inserted('notes'), 0)
    assert.equal(inserted('events'), 0)
    assert.equal(inserted('action_runs'), 0)
  })
}
