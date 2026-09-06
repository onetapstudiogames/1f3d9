import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'


export function registerActionsTests(): void {
  const {
    app,
    authHeaders,
    fixtureState,
    initialState,
    inserted,
    reset,
    setActor,
    sqlCalls,
    test,
  } = getRoutesTestContext()


  test('go_home remains available when ordinary movement is actively blocked', async () => {
    reset({ scenario: 'bedrock home', actionBlocked: true, currentPlaceId: 2, homePlaceId: 2 })
    const moved = await app.request('/api/action', {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'move', to_place_id: 3 }),
    })
    assert.equal(moved.status, 403)
    const movedBody = await moved.json() as {
      error: string
      action: { status: string; effects_applied: number; error?: string }
    }
    assert.equal(movedBody.error, 'move is temporarily blocked by law "quiet-hours" from place_id 2')
    assert.deepEqual(movedBody.action, {
      id: 101,
      action: 'move',
      status: 'blocked',
      place_id: 2,
      effects_applied: 0,
      error: movedBody.error,
    })

    const home = await app.request('/api/action', {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'go_home' }),
    })
    assert.equal(home.status, 200)
    const body = await home.json() as { action: { action: string; place_id: number } }
    assert.equal(body.action.action, 'go_home')
    assert.equal(body.action.place_id, 2)
  })

  test('/api/action names the dedicated endpoint when asked to talk or make', async () => {
    reset({ scenario: 'bedrock home', currentPlaceId: 2, homePlaceId: 2 })
    for (const [action, endpoint] of [
      ['talk', 'POST /api/note'],
      ['make', 'POST /api/thing'],
    ] as const) {
      const response = await app.request('/api/action', {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ action }),
      })
      assert.equal(response.status, 400)
      const body = await response.json() as { error: string }
      assert.ok(body.error.includes(endpoint), body.error)
    }
  })

  test('/api/action refuses a move that tries to carry more than one thing', async () => {
    reset({ scenario: 'carry shape', currentPlaceId: 2, homePlaceId: 2 })
    const response = await app.request('/api/action', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ action: 'move', to_place_id: 3, carry_thing_id: [41, 42] }),
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: 'carry_thing_id accepts one positive integer, not a list; a move can carry at most one thing',
    })
  })

  test('/api/action refuses each invalid scalar carry_thing_id', async t => {
    for (const carryThingId of [0, -1, 'not-a-number'] as const) {
      await t.test(JSON.stringify(carryThingId), async () => {
        reset({ scenario: 'carry scalar shape', currentPlaceId: 2, homePlaceId: 2 })
        const response = await app.request('/api/action', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            action: 'move',
            to_place_id: 3,
            carry_thing_id: carryThingId,
          }),
        })

        assert.equal(response.status, 400)
        assert.deepEqual(await response.json(), {
          error: 'carry_thing_id must be one positive integer',
        })
      })
    }
  })

  test('a committed action answers success even when the after-action observation fails', async () => {
    reset({ scenario: 'post-action observation failure' })
    const response = await app.request('/api/go-home', { method: 'POST', headers: authHeaders() })
    assert.equal(response.status, 200)
    const body = await response.json() as {
      action: { action: string; status: string; place_id: number | null }
    }
    assert.equal(body.action.action, 'go_home')
    assert.equal(body.action.status, 'applied')
    assert.equal(body.action.place_id, 3)
  })

  test('thing withdrawal is owner-only, one-way, and refused during an open sale', async () => {
    reset({ scenario: 'thing withdrawal' })
    const withdrawn = await app.request('/api/thing/41/withdraw', {
      method: 'POST', headers: authHeaders(),
    })
    assert.equal(withdrawn.status, 200)
    const body = await withdrawn.json() as { thing: { id: number; withdrawn_at: string } }
    assert.equal(body.thing.id, 41)
    assert.ok(Number.isFinite(Date.parse(body.thing.withdrawn_at)))
    assert.ok(sqlCalls().some(call =>
      /update\s+things\s+set\s+withdrawn_at/i.test(call.query ?? '') &&
      /insert\s+into\s+events/i.test(call.query ?? '')))
    const withdrawalWrite = sqlCalls().find(call =>
      /update\s+things\s+set\s+withdrawn_at/i.test(call.query ?? '') &&
      /insert\s+into\s+events/i.test(call.query ?? ''))
    assert.match(
      withdrawalWrite?.query ?? '',
      /jsonb_build_object\(\s*'thing_id'\s*,\s*id\s*,\s*'reason'\s*,\s*\$\d+::text\s*\)/i,
    )
    assert.doesNotMatch(withdrawalWrite?.query ?? '', /SET\s+maker_id\s*=/i)

    reset({ scenario: 'thing withdrawal sale', offer: { ...initialState().offer, status: 'open' } })
    const locked = await app.request('/api/thing/41/withdraw', {
      method: 'POST', headers: authHeaders(),
    })
    assert.equal(locked.status, 409)
  })

  test('only resident one can remove or restore public content and every use is logged', async () => {
    reset({ scenario: 'maintainer moderation' })
    const unauthenticated = await app.request('/api/moderation', { method: 'POST' })
    assert.equal(unauthenticated.status, 401)
    assert.deepEqual(await unauthenticated.json(), {
      error: "founder sign-in failed because Authorization: Bearer is missing or is not founder #1's current root key; founder #1 should retry with the saved current root key",
    })

    const denied = await app.request('/api/moderation', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ action: 'remove', target_type: 'thing', target_id: 41, reason: 'illegal content' }),
    })
    assert.equal(denied.status, 403)
    assert.deepEqual(await denied.json(), {
      error: 'only founder resident #1 may remove or restore illegal public content',
    })
    assert.equal(inserted('moderation_actions'), 0)

    setActor(1, 'founder')
    const removed = await app.request('/api/moderation', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ action: 'remove', target_type: 'thing', target_id: 41, reason: 'illegal content' }),
    })
    assert.equal(removed.status, 201)
    assert.ok(inserted('moderation_actions') > 0)
    assert.ok(sqlCalls().some(call =>
      /insert\s+into\s+events/i.test(call.query ?? '') && /'moderation'/i.test(call.query ?? '')))
  })

  test('withdrawing a thing hides it from the street and freezes further edits', async () => {
    reset({ scenario: 'withdraw thing' })
    const withdrawn = await app.request('/api/thing/41/withdraw', {
      method: 'POST', headers: authHeaders(),
    })
    assert.equal(withdrawn.status, 200)
    const withdrawnBody = await withdrawn.json() as { thing: { id: number; withdrawn_at: string } }
    assert.equal(withdrawnBody.thing.id, 41)
    assert.match(withdrawnBody.thing.withdrawn_at, /2026-08-11T/)

    fixtureState.current = { ...fixtureState.current, calls: [] }
    const place = await app.request('/api/place/2')
    assert.equal(place.status, 200)
    const placeBody = await place.json() as { things: { id: number }[] }
    assert.equal(placeBody.things.some(thing => thing.id === 41), false)

    const edited = await app.request('/api/thing/41', {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ body: 'too late' }),
    })
    assert.equal(edited.status, 404)
  })
}
