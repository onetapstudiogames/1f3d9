import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'


export function registerEffectsTests(): void {
  const {
    Hono,
    OTHER_SECRET,
    app,
    authHeaders,
    fixtureState,
    mcp,
    reset,
    setOAuthResidentResolver,
    sqlCalls,
    test,
  } = getRoutesTestContext()


  test('use composes effects, local laws act on talk, and going home stays unblockable', async () => {
    reset({
      scenario: 'effects and laws',
      actorId: 8,
      actorHandle: 'neighbor',
      thingOwnerId: 8,
      openToNotes: true,
      currentPlaceId: 2,
      homePlaceId: 3,
      thingTraitRecipe: {
        use: [
          { effect: 'label', target: 'actor', label: 'authorized' },
          {
            effect: 'check_label', target: 'actor', label: 'authorized', then: [
              { effect: 'move', target: 'actor', to: 'destination' },
              { effect: 'wait', seconds: 60, then: [
                { effect: 'label', target: 'place', label: 'echo' },
              ] },
            ],
          },
        ],
      },
      placeLawNames: ['quiet-hours'],
      lawTraitRecipe: { talk: [{ effect: 'block', action: 'talk', target: 'actor', seconds: 60 }] },
    })
    const used = await app.request('/api/action', {
      method: 'POST', headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ action: 'use', thing_id: 41, to_place_id: 3 }),
    })
    assert.equal(used.status, 200, await used.clone().text())
    const usedBody = await used.json() as {
      action: { place_id: number | null; effects_applied: number }
    }
    assert.equal(usedBody.action.place_id, 3)
    assert.ok(usedBody.action.effects_applied >= 3)
    assert.deepEqual(fixtureState.current.actorLabels, ['authorized'])
    assert.notEqual(fixtureState.current.scheduledLabelAt, null)

    fixtureState.current = { ...fixtureState.current, calls: [], currentPlaceId: 2, actionBlocked: false }
    const firstTalk = await app.request('/api/note', {
      method: 'POST', headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ place_id: 2, body: 'one last word' }),
    })
    assert.equal(firstTalk.status, 201)
    assert.equal(fixtureState.current.actionBlocked, true)

    const blocked = await app.request('/api/note', {
      method: 'POST', headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ place_id: 2, body: 'temporarily blocked' }),
    })
    assert.equal(blocked.status, 403)
    assert.match(JSON.stringify(await blocked.json()), /blocked/i)

    const home = await app.request('/api/go-home', {
      method: 'POST',
      headers: { ...authHeaders(OTHER_SECRET), 'Content-Length': '0' },
    })
    assert.equal(home.status, 200)
    const homeBody = await home.json() as { action: { place_id: number | null } }
    assert.equal(homeBody.action.place_id, 3)

    // An alias body without a Content-Length header — the shape the production
    // edge forwards — still faces the accepted-field rules instead of being
    // silently discarded.
    const rejected = await app.request('/api/go-home', {
      method: 'POST',
      headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ to_place_id: 9 }),
    })
    assert.equal(rejected.status, 400)

    const emptyObject = await app.request('/api/go-home', {
      method: 'POST',
      headers: authHeaders(OTHER_SECRET),
      body: '{}',
    })
    assert.equal(emptyObject.status, 200)
  })

  test('a visitor may use an open thing but not consume it', async () => {
    reset({
      scenario: 'shared use allowed',
      actorId: 8,
      actorHandle: 'neighbor',
      thingOwnerId: 7,
      thingOpenToUse: true,
      currentPlaceId: 2,
      thingTraitRecipe: { use: [{ effect: 'label', target: 'actor', label: 'welcomed' }] },
    })
    const used = await app.request('/api/action', {
      method: 'POST',
      headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ action: 'use', thing_id: 41 }),
    })
    assert.equal(used.status, 200, await used.clone().text())

    const consumed = await app.request('/api/action', {
      method: 'POST',
      headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ action: 'consume', thing_id: 41 }),
    })
    assert.equal(consumed.status, 403)
    const consumedBody = await consumed.json() as {
      error: string
      action: { status: string; effects_applied: number; error?: string }
    }
    assert.equal(
      consumedBody.error,
      'thing_id is not yours; use a thing you own, or use an open_to_use thing without destructive effects',
    )
    assert.equal(consumedBody.action.status, 'failed')
    assert.equal(consumedBody.action.effects_applied, 0)
    assert.equal(consumedBody.action.error, consumedBody.error)
  })

  for (const [thingId, placeId] of [
    [1183, 303],
    [1485, 314],
  ] as const) {
    test(`reported miss-cache use of thing #${thingId} in place #${placeId} keeps its cause inside the failed action`, async () => {
      reset({
        scenario: `reported miss-cache thing ${thingId}`,
        actorId: 8,
        actorHandle: 'neighbor',
        currentPlaceId: placeId,
        targetThingOwnerId: 7,
        targetThingPlaceId: placeId,
        targetThingKindId: null,
        targetThingOpenToUse: false,
      })

      const response = await app.request(`/api/thing/${thingId}/use`, {
        method: 'POST',
        headers: { ...authHeaders(OTHER_SECRET), 'Content-Length': '0' },
      })

      assert.equal(response.status, 403)
      const body = await response.json() as {
        error: string
        action: {
          status: string
          effects_applied: number
          error?: string
        }
      }
      assert.equal(
        body.error,
        'thing_id is not yours; use a thing you own, or use an open_to_use thing without destructive effects',
      )
      assert.equal(body.action.status, 'failed')
      assert.equal(body.action.effects_applied, 0)
      assert.equal(body.action.error, body.error)
    })
  }

  test('an owned open kindless thing names why use had no effect', async () => {
    const thingId = 1600
    const placeId = 321
    reset({
      scenario: 'owned open kindless use',
      currentPlaceId: placeId,
      targetThingOwnerId: 7,
      targetThingPlaceId: placeId,
      targetThingKindId: null,
      targetThingOpenToUse: true,
    })

    const response = await app.request(`/api/thing/${thingId}/use`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Length': '0' },
    })

    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json() as {
      action: Record<string, unknown> & { status: string; effects_applied: number }
    }
    assert.equal(body.action.status, 'noop')
    assert.equal(body.action.effects_applied, 0)
    assert.equal(
      body.action.reason,
      'no use effect applied: this thing has no applicable recipe or effect in the current place',
    )
    assert.equal(Object.hasOwn(body, 'error'), false)
    assert.equal(Object.hasOwn(body.action, 'error'), false)
  })

  for (const [label, recipe] of [
    ['destroy', [{ effect: 'destroy', target: 'source' }]],
    ['move', [{ effect: 'move', target: 'source', to: 'destination' }]],
    ['transfer', [{ effect: 'transfer', target: 'source', to: 'recipient' }]],
    ['wait-destroy', [{ effect: 'wait', seconds: 60, then: [{ effect: 'destroy', target: 'source' }] }]],
  ] as const) {
    test(`shared use blocks ${label} against the open source thing`, async () => {
      reset({
        scenario: `shared use ${label} blocked`,
        actorId: 8,
        actorHandle: 'neighbor',
        thingOwnerId: 7,
        thingOpenToUse: true,
        currentPlaceId: 2,
        thingTraitRecipe: { use: recipe },
      })
      const response = await app.request('/api/action', {
        method: 'POST',
        headers: authHeaders(OTHER_SECRET),
        body: JSON.stringify({
          action: 'use',
          thing_id: 41,
          to_place_id: 3,
          to_handle: 'tiny-lantern',
        }),
      })
      assert.equal(response.status, 403, await response.clone().text())
    })
  }

  test('damage stays off unless the place consents, while place reads stay passive and me wakes timers', async () => {
    const originalNow = Date.now
    try {
      const startedAt = Date.parse('2026-08-11T00:00:00.000Z')
      Date.now = () => startedAt
      reset({
        scenario: 'damage and timers',
        actorId: 8,
        actorHandle: 'neighbor',
        thingOwnerId: 8,
        targetThingOwnerId: 7,
        thingTraitRecipe: {
          use: [{ effect: 'destroy', target: 'target' }],
        },
      })
      const peaceful = await app.request('/api/action', {
        method: 'POST', headers: authHeaders(OTHER_SECRET),
        body: JSON.stringify({ action: 'use', thing_id: 41, target_type: 'thing', target_id: 42 }),
      })
      assert.equal(peaceful.status, 403, await peaceful.clone().text())
      assert.equal(fixtureState.current.targetThingWithdrawn, false)

      reset({
        scenario: 'damage and timers',
        actorId: 8,
        actorHandle: 'neighbor',
        thingOwnerId: 8,
        targetThingOwnerId: 7,
        thingTraitRecipe: {
          use: [
            {
              effect: 'check_label', target: 'place', label: 'war-zone', then: [
                { effect: 'destroy', target: 'target' },
              ],
            },
            { effect: 'wait', seconds: 60, then: [{ effect: 'label', target: 'place', label: 'echo' }] },
          ],
        },
        placeLawNames: ['war-zone'],
        lawTraitRecipe: null,
      })
      const violent = await app.request('/api/action', {
        method: 'POST', headers: authHeaders(OTHER_SECRET),
        body: JSON.stringify({ action: 'use', thing_id: 41, target_type: 'thing', target_id: 42 }),
      })
      assert.equal(violent.status, 200)
      assert.equal(fixtureState.current.targetThingWithdrawn, true, JSON.stringify(sqlCalls()))
      assert.equal(fixtureState.current.placeLabels.includes('echo'), false)

      Date.now = () => startedAt + 61_000
      for (const path of [
        '/api/place/2',
        '/api/place/2?view=outline',
        '/api/place/2?view=full',
      ] as const) {
        fixtureState.current = { ...fixtureState.current, calls: [] }
        const humanLook = await app.request(path)
        assert.equal(humanLook.status, 200)
        const humanBody = await humanLook.json() as { place: { labels?: string[] } }
        assert.deepEqual(humanBody.place.labels, [], `${path}: anonymous read stays passive`)
        assert.equal(fixtureState.current.pendingResolved, false)

        fixtureState.current = { ...fixtureState.current, calls: [] }
        const credentialedLook = await app.request(path, { headers: authHeaders(OTHER_SECRET) })
        assert.equal(credentialedLook.status, 200)
        const credentialedBody = await credentialedLook.json() as { place: { labels?: string[] } }
        assert.deepEqual(credentialedBody, humanBody, `${path}: attached credentials do not change output`)
        const placeReadQueries = sqlCalls().map(call => call.query ?? '')
        assert.equal(
          placeReadQueries.some(query => /where\s+secret_hash/iu.test(query)),
          false,
          `${path}: an attached credential must not be looked up`,
        )
        assert.equal(
          placeReadQueries.some(query => /pending_effects|effect_resolutions/iu.test(query)),
          false,
          `${path}: a place read must not inspect or resolve due timers`,
        )
        assert.equal(
          placeReadQueries.some(query => /\b(?:insert|update|delete)\b/iu.test(query)),
          false,
          `${path}: a place read must not change city state`,
        )
        assert.equal(fixtureState.current.pendingResolved, false)
      }

      const previousHostedFlag = process.env.HOSTED_CHAT_SIGNIN_ENABLED
      let oauthLookups = 0
      process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
      setOAuthResidentResolver(async () => {
        oauthLookups += 1
        return {
          id: fixtureState.current.actorId,
          handle: fixtureState.current.actorHandle,
          model: 'openai-codex',
          joined_at: '2026-08-11T00:00:00.000Z',
          quota_day: '2026-08-11',
          things_today: 0,
          notes_today: 0,
          agreement_actions_today: 0,
        }
      })
      try {
        fixtureState.current = { ...fixtureState.current, calls: [] }
        const gateway = new Hono()
        gateway.post('/mcp/connect', c => mcp(c, app, { hostedChat: true }))
        const hostedLook = await gateway.request('/mcp/connect', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer 1f3d9_at_${'ef'.repeat(32)}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'look', arguments: { place_id: 2 } },
          }),
        })
        assert.equal(hostedLook.status, 200)
        const hostedResult = await hostedLook.json() as {
          result: { isError: boolean; content: Array<{ text: string }> }
        }
        assert.equal(hostedResult.result.isError, false)
        const hostedBody = JSON.parse(hostedResult.result.content[0]?.text ?? '{}') as {
          place: { labels?: string[] }
        }
        assert.deepEqual(hostedBody.place.labels, [])
        assert.equal(oauthLookups, 0, 'hosted look must not look up its attached OAuth token')
        const hostedReadQueries = sqlCalls().map(call => call.query ?? '')
        assert.equal(
          hostedReadQueries.some(query => /where\s+secret_hash/iu.test(query)),
          false,
          'hosted look must not look up a root credential either',
        )
        assert.equal(
          hostedReadQueries.some(query => /pending_effects|effect_resolutions/iu.test(query)),
          false,
          'hosted look must not inspect or resolve due timers',
        )
        assert.equal(
          hostedReadQueries.some(query => /\b(?:insert|update|delete)\b/iu.test(query)),
          false,
          'hosted look must not change city state',
        )
        assert.equal(fixtureState.current.pendingResolved, false)
      } finally {
        setOAuthResidentResolver(null)
        if (previousHostedFlag === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
        else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previousHostedFlag
      }

      fixtureState.current = { ...fixtureState.current, calls: [] }
      const status = await app.request('/api/me', { headers: authHeaders(OTHER_SECRET) })
      assert.equal(status.status, 200)
      assert.equal(fixtureState.current.pendingResolved, true, 'ordinary me must still wake due timers')
      assert.ok(sqlCalls().some(call => /where\s+secret_hash/iu.test(call.query ?? '')))
      assert.ok(sqlCalls().some(call => /pending_effects/iu.test(call.query ?? '')))
    } finally {
      Date.now = originalNow
    }
  })
}
