import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'


export function registerGazetteNotesTests(): void {
  const {
    CommitOutcomeUnknownError,
    app,
    assertPhaseAwareGazetteReplayReads,
    authHeaders,
    fixtureState,
    inserted,
    reset,
    setEngineTransactionRunnerForTests,
    sqlCalls,
    test,
  } = getRoutesTestContext()


  test('a Gazette same-body replay survives the print boundary gates without a new submission', async () => {
    reset({
      scenario: 'note retry',
      currentPlaceId: 454,
      placeOwnerId: 1,
      openToNotes: true,
      gazetteActivated: true,
      gazetteWithdrawalsOpen: true,
    })
    const post = (body: string) => app.request('/api/note', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ place_id: 454, body }),
    })

    const first = await post('Exact Gazette submission. 🗞️')
    assert.equal(first.status, 201)
    const firstBody = await first.json() as { note: Record<string, unknown> }

    fixtureState.current = {
      ...fixtureState.current,
      calls: [],
      currentPlaceId: 2,
      placeOwnerId: 8,
      openToNotes: false,
      quota: { ...fixtureState.current.quota, notes: false },
    }
    const replay = await post('Exact Gazette submission. 🗞️')
    assert.equal(replay.status, 200)
    assert.deepEqual((await replay.json() as { note: Record<string, unknown> }).note, firstBody.note)
    assert.equal(inserted('notes'), 0)
    assert.equal(inserted('events'), 0)
    assert.equal(inserted('action_runs'), 0)
    assert.equal(
      sqlCalls().some(call => /\/\* note-action:create \*\//iu.test(call.query ?? '')),
      false,
    )

    const changed = await post('Exact Gazette submission. 🗞️ ')
    assert.equal(changed.status, 409)
    assert.deepEqual(await changed.json(), {
      error: 'Gazette submission room #454 is not open; call browse with view gazette and no issue_number, or use GET /api/gazette if your client can open URLs, and submit only when submission_room.submissions_open is true',
    })
  })

  test('a Gazette withdrawal uses the ordinary note route and replays its public facts', async () => {
    reset({
      scenario: 'note retry',
      currentPlaceId: 454,
      placeOwnerId: 1,
      openToNotes: true,
      gazetteActivated: true,
      gazetteWithdrawalsOpen: true,
    })
    const request = () => app.request('/api/note', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ place_id: 454, body: 'WITHDRAW #8101' }),
    })

    const first = await request()
    assert.equal(first.status, 201)
    const firstBody = await first.json() as {
      note: { id: number; created_at: string }
      gazette_withdrawal: Record<string, unknown>
    }
    assert.deepEqual(firstBody.gazette_withdrawal, {
      target_note_id: 8101,
      command_note_id: firstBody.note.id,
      withdrawn_at: new Date(firstBody.note.created_at).toISOString(),
      notice: 'note #8101, withdrawn by its author before the tick',
    })

    fixtureState.current = { ...fixtureState.current, calls: [], quota: { ...fixtureState.current.quota, notes: false } }
    const replay = await request()
    assert.equal(replay.status, 200)
    assert.deepEqual(
      (await replay.json() as { gazette_withdrawal: unknown }).gazette_withdrawal,
      firstBody.gazette_withdrawal,
    )
    assert.equal(inserted('notes'), 0)
    assert.equal(inserted('events'), 0)
    assert.equal(inserted('action_runs'), 0)
    assertPhaseAwareGazetteReplayReads()
  })

  test('dormant Gazette command shapes replay as ordinary notes without new refusals', async () => {
    for (const commandBody of ['WITHDRAW #8101', 'WITHDRAW#8101', 'WITHDRAW #12x']) {
      reset({
        scenario: 'note retry',
        currentPlaceId: 2,
        openToNotes: false,
        gazetteActivated: true,
        gazetteWithdrawalsOpen: false,
        quota: { things: true, notes: false, agreements: true },
        recentNote: {
          id: 51,
          place_id: 454,
          author_id: 7,
          author: 'tiny-lantern',
          body: commandBody,
          created_at: '2026-08-11T00:00:00.000Z',
        },
      })

      const response = await app.request('/api/note', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ place_id: 454, body: commandBody }),
      })

      assert.equal(response.status, 200, commandBody)
      const body = await response.json() as Record<string, unknown>
      assert.equal(Object.hasOwn(body, 'gazette_withdrawal'), false, commandBody)
      assert.equal(inserted('notes'), 0, commandBody)
      assert.equal(inserted('events'), 0, commandBody)
      assert.equal(inserted('action_runs'), 0, commandBody)
    }
  })

  test('a dormant Gazette commit crossing activation never calls an identical retry safe', async () => {
    reset({
      scenario: 'note retry',
      currentPlaceId: 454,
      placeOwnerId: 1,
      openToNotes: true,
      gazetteActivated: true,
      gazetteWithdrawalsOpen: false,
    })
    let outerTransactions = 0
    setEngineTransactionRunnerForTests(async (database, work) => {
      outerTransactions += 1
      const result = await work(database, true)
      if (outerTransactions === 2) {
        fixtureState.current = { ...fixtureState.current, gazetteWithdrawalsOpen: true }
        throw new CommitOutcomeUnknownError(new Error('commit reply was lost during activation'))
      }
      return result
    })

    try {
      const response = await app.request('/api/note', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ place_id: 454, body: 'WITHDRAW #8101' }),
      })

      assert.equal(response.status, 500)
      const body = await response.json() as { error: string }
      assert.doesNotMatch(body.error, /identical[^.]*retry|retrying the identical|is safe/iu)
      assert.match(body.error, /Call browse with view gazette/iu)
      assert.match(body.error, /recent notes/iu)
      assert.equal(outerTransactions, 3, 'preflight, uncertain write, and canonical recovery all ran')
    } finally {
      setEngineTransactionRunnerForTests(async (database, work) => work(database, false))
    }
  })

  test('activation stops an unledgered exact command-shaped note from replaying as ordinary', async () => {
    reset({
      scenario: 'note retry',
      currentPlaceId: 454,
      placeOwnerId: 1,
      openToNotes: true,
      gazetteActivated: true,
      gazetteWithdrawalsOpen: true,
      recentNote: {
        id: 51,
        place_id: 454,
        author_id: 7,
        author: 'tiny-lantern',
        body: 'WITHDRAW #8101',
        created_at: '2026-08-11T00:00:00.000Z',
      },
    })

    const response = await app.request('/api/note', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ place_id: 454, body: 'WITHDRAW #8101' }),
    })

    assert.equal(response.status, 201)
    const body = await response.json() as {
      note: { id: number }
      gazette_withdrawal: { target_note_id: number; command_note_id: number }
    }
    assert.notEqual(body.note.id, 51)
    assert.deepEqual(body.gazette_withdrawal, {
      target_note_id: 8101,
      command_note_id: body.note.id,
      withdrawn_at: '2026-08-11T00:00:00.000Z',
      notice: 'note #8101, withdrawn by its author before the tick',
    })
    assert.equal(inserted('notes'), 1)
    assertPhaseAwareGazetteReplayReads()
  })

  test('activation refuses unledgered withdrawal near-miss replays in caller words', async () => {
    for (const commandBody of ['WITHDRAW#8101', 'WITHDRAW #12x']) {
      reset({
        scenario: 'note retry',
        currentPlaceId: 454,
        placeOwnerId: 1,
        openToNotes: true,
        gazetteActivated: true,
        gazetteWithdrawalsOpen: true,
        recentNote: {
          id: 51,
          place_id: 454,
          author_id: 7,
          author: 'tiny-lantern',
          body: commandBody,
          created_at: '2026-08-11T00:00:00.000Z',
        },
      })

      const response = await app.request('/api/note', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ place_id: 454, body: commandBody }),
      })

      assert.equal(response.status, 400, commandBody)
      assert.deepEqual(await response.json(), {
        error: 'Gazette withdrawal must be exactly WITHDRAW #<your-note-id>',
      }, commandBody)
      assert.equal(inserted('notes'), 1, commandBody)
      assertPhaseAwareGazetteReplayReads()
    }
  })

  test('the founder cannot submit to the closed Gazette shell before its canonical activation', async () => {
    reset({
      scenario: 'closed Gazette shell',
      actorId: 1,
      actorHandle: 'founder',
      currentPlaceId: 454,
      placeOwnerId: 1,
      openToNotes: false,
      gazetteActivated: false,
    })

    const response = await app.request('/api/note', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ place_id: 454, body: 'Must wait for activation.' }),
    })

    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), {
      error: 'Gazette submission room #454 is not open; call browse with view gazette and no issue_number, or use GET /api/gazette if your client can open URLs, and submit only when submission_room.submissions_open is true',
    })
    assert.equal(inserted('notes'), 0)
    assert.equal(inserted('events'), 0)
    assert.equal(inserted('action_runs'), 0)
  })

  test('a one-byte body difference creates a separate append-only note', async () => {
    reset({ scenario: 'note retry', openToNotes: true })
    const post = (body: string) => app.request('/api/note', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ place_id: 2, body }),
    })

    const first = await post('One durable thought.')
    assert.equal(first.status, 201)
    const firstBody = await first.json() as { note: { id: number } }

    fixtureState.current = { ...fixtureState.current, calls: [] }
    const second = await post('One durable thought. ')
    assert.equal(second.status, 201)
    const secondBody = await second.json() as { note: { id: number; body: string } }

    assert.notEqual(secondBody.note.id, firstBody.note.id)
    assert.equal(secondBody.note.body, 'One durable thought. ')
    assert.equal(inserted('notes'), 1)
    assert.equal(inserted('action_runs'), 1)
  })

  test('a meter read failure never turns a committed note into a retryable write failure', async () => {
    reset({ scenario: 'reading cost unavailable' })
    const response = await app.request('/api/note', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ place_id: 2, body: 'already committed' }),
    })
    assert.equal(response.status, 201)
    const body = await response.json() as { reading_cost: Record<string, unknown> }
    assert.deepEqual(body.reading_cost, {
      available: false,
      reason: 'measurement_failed',
      measurement_timeout_ms: 1500,
      size_unit: 'utf8_bytes',
      counted_text: 'place descriptions and purposes, active thing bodies, and note bodies',
      new_item_text_bytes: Buffer.byteLength('already committed', 'utf8'),
      room_stored_text_bytes: null,
      current_first_read_text_bytes: null,
      note: 'the write succeeded; only this informational meter is unavailable; do not retry',
    })
  })

  test('a hung meter read stops its loader and reports a bounded database timeout', async () => {
    const { safeReadingCostMeter } = await import('../../src/reading-cost.ts')
    let queryOptions: {
      readonly signal: AbortSignal
      readonly statementTimeoutMs: number
    } | undefined
    let loaderStopped = false
    const startedAt = Date.now()
    const meter = await safeReadingCostMeter(2, 'already committed', {
      timeoutMs: 20,
      load: (_placeId, _newItemText, options) => {
        queryOptions = options
        return new Promise((_resolve, reject) => {
          options?.signal.addEventListener('abort', () => {
            loaderStopped = true
            reject(new Error('loader stopped'))
          }, { once: true })
        })
      },
    })
    assert.deepEqual(meter, {
      available: false,
      reason: 'measurement_timeout',
      measurement_timeout_ms: 20,
      size_unit: 'utf8_bytes',
      counted_text: 'place descriptions and purposes, active thing bodies, and note bodies',
      new_item_text_bytes: Buffer.byteLength('already committed', 'utf8'),
      room_stored_text_bytes: null,
      current_first_read_text_bytes: null,
      note: 'the write succeeded; the reading-cost measurement timed out and its database query has a bounded deadline; do not retry',
    })
    assert.ok(queryOptions, 'the loader must receive cancellation controls')
    assert.ok(queryOptions.statementTimeoutMs > 0)
    assert.ok(queryOptions.statementTimeoutMs < 20)
    assert.equal(queryOptions.signal.aborted, true)
    assert.equal(loaderStopped, true)
    assert.ok(Date.now() - startedAt < 500, 'a meter must not hold a successful write open')
  })

  test('the reading-cost query installs its database deadline before measuring', async () => {
    const { safeReadingCostMeter } = await import('../../src/reading-cost.ts')
    reset({ scenario: 'validation' })

    const meter = await safeReadingCostMeter(2, 'already committed')

    assert.equal(meter.available, true)
    const calls = sqlCalls()
    const timeoutIndex = calls.findIndex(call => /^\s*SET\s+LOCAL\s+statement_timeout/iu.test(
      call.query ?? '',
    ))
    const meterIndex = calls.findIndex(call => /\/\* public:reading_cost \*\//iu.test(
      call.query ?? '',
    ))
    assert.ok(timeoutIndex >= 0, 'the database must receive a statement timeout')
    assert.ok(meterIndex > timeoutIndex, 'the database deadline must precede the meter query')
    assert.match(calls[timeoutIndex]?.query ?? '', /'\d+ms'/u)
  })
}
