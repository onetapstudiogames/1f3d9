import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'


export function registerFrontDoorAndPhysicsTests(): void {
  const {
    OTHER_SECRET,
    SECRET,
    app,
    authHeaders,
    fixtureState,
    inserted,
    reset,
    setActor,
    sqlCalls,
    test,
  } = getRoutesTestContext()


  test('missing HTTP routes give connector-first front-door recovery', async () => {
    const response = await app.request('/definitely-not-a-city-route')
    assert.equal(response.status, 404)
    const body = await response.json() as {
      error?: string
      front_door_tool?: string
      front_door?: string
    }
    assert.equal(body.front_door_tool, 'front_door')
    assert.equal(body.front_door, 'https://1f3d9.com/')
    assert.match(body.error ?? '', /front_door[\s\S]*GET \/[\s\S]*if your client can open URLs/iu)
  })

  test('front door and human window surface the event names the world actually emits', async () => {
    reset({ scenario: 'activity surfaces' })
    const front = await app.request('/')
    assert.equal(front.status, 200)
    const frontText = await front.text()
    assert.match(frontText, /founded a place/i)
    assert.match(frontText, /bought property/i)
    assert.match(frontText, /canceled a sale offer/i)
    assert.match(frontText, /bought a thing through the world market/i)

    fixtureState.current = { ...fixtureState.current, calls: [] }
    const snapshot = await app.request('/api/window')
    assert.equal(snapshot.status, 200)
    const payload = await snapshot.json() as {
      events: { kind: string }[]
      body_limits: { notes: number; things: number; agreements: number }
    }
    assert.deepEqual(
      payload.events.map(event => event.kind),
      ['place_created', 'sale', 'transfer_cancel', 'world_sale'],
    )
    assert.deepEqual(payload.body_limits, { notes: 2_000, things: 1_000, agreements: 4_000 })
    const eventKindParams = JSON.stringify(sqlCalls().flatMap(call => call.params ?? []))
    for (const kind of ['place_created', 'thing_created', 'kind_invented', 'kind_revised', 'trait_coined', 'sale', 'transfer_cancel', 'world_listed', 'world_sale', 'world_cancel']) {
      assert.ok(eventKindParams.includes(kind), `public event query should include ${kind}`)
    }

    const script = await app.request('/window.js')
    const source = await script.text()
    assert.match(source, /place_created[^\n]*founded a place/i)
    assert.match(source, /sale[^\n]*bought property/i)
    assert.match(source, /transfer_cancel[^\n]*canceled a sale offer/i)
    assert.match(source, /world_sale[^\n]*bought a thing through the world market/i)
    assert.match(source, /world_listed[^\n]*listed a thing on the world market/i)
    assert.match(source, /world_cancel[^\n]*canceled a world market listing/i)
  })

  test('the human window is hardened, query-blind, credential-blind, and read-only', async () => {
    reset({ scenario: 'window' })
    const query = await app.request('/api/window?nonce=cache-bust')
    assert.equal(query.status, 400)
    assert.equal(sqlCalls().length, 0)

    const credentialed = await app.request('/api/window', { headers: { Authorization: `Bearer ${SECRET}` } })
    assert.equal(credentialed.status, 400)
    assert.equal(sqlCalls().length, 0)

    const page = await app.request('/window')
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/)
    assert.equal(page.headers.get('x-frame-options'), 'DENY')
    assert.match(page.headers.get('permissions-policy') ?? '', /payment=\(\)/)

    const attemptedWrite = await app.request('/window', { method: 'POST', body: 'human action' })
    assert.equal(attemptedWrite.status, 404)
  })

  test('physics publishes one frozen mechanism vocabulary with hard safety ceilings', async () => {
    reset({ scenario: 'physics contract' })
    const response = await app.request('/api/physics')
    assert.equal(response.status, 200)
    const body = await response.json() as {
      act_actions: string[]
      other_basic_actions: Record<string, string>
      effect_bricks: string[]
      limits: {
        max_block_seconds: number
        max_generation: number
        max_timer_seconds: number
        max_craft_ingredients: number
        max_pending_effects_per_place: number
        max_pending_effects_per_actor: number
        max_due_effects_per_observation: number
      }
    }
    assert.deepEqual(body.act_actions, ['move', 'use', 'give', 'consume', 'go_home'])
    assert.deepEqual(body.other_basic_actions, { talk: 'say', make: 'make' })
    assert.deepEqual(body.effect_bricks, ['destroy', 'move', 'transfer', 'label', 'block', 'wait', 'check_label'])
    assert.equal(body.limits.max_block_seconds, 86_400)
    assert.equal(body.limits.max_generation, 8)
    assert.equal(body.limits.max_timer_seconds, 86_400)
    assert.equal(body.limits.max_craft_ingredients, 1_024)
    assert.equal(body.limits.max_pending_effects_per_place, 512)
    assert.equal(body.limits.max_pending_effects_per_actor, 1_024)
    assert.equal(body.limits.max_due_effects_per_observation, 512)
  })

  test('a place owner replaces local laws while a visitor cannot legislate there', async () => {
    reset({ scenario: 'place laws', placeOwnerId: 7 })
    const changed = await app.request('/api/place/2/laws', {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify({ traits: ['war-zone'] }),
    })
    assert.equal(changed.status, 200)
    const body = await changed.json() as { laws: { name: string }[] }
    assert.deepEqual(body.laws.map(law => law.name), ['war-zone'])
    assert.ok(inserted('place_law_changes') > 0)
    const lawWrite = sqlCalls().find(call => /insert\s+into\s+place_law_changes/i.test(call.query ?? ''))
    assert.match(lawWrite?.query ?? '', /\$\d+::integer\s+as\s+actor_id/i)
    assert.match(lawWrite?.query ?? '', /union\s+all[\s\S]*\$\d+::integer\s*,\s*'add'/i)

    setActor(8, 'neighbor')
    const rejected = await app.request('/api/place/2/laws', {
      method: 'PUT', headers: authHeaders(OTHER_SECRET), body: JSON.stringify({ traits: [] }),
    })
    assert.equal(rejected.status, 403)
    assert.deepEqual(await rejected.json(), { error: 'only the place owner may change its laws' })
  })

  test('all Gazette room dependency writes return one protected-service refusal', async () => {
    const expected = {
      error: 'Gazette room #454 is a protected city service; it cannot be edited, transferred, traded, deleted, repurposed, given local laws, contain child places, or hold things',
    }
    const requests = [
      ['/api/place/454/laws', 'PUT', { traits: ['war-zone'] }],
      ['/api/place', 'POST', {
        parent_id: 454,
        name: 'forbidden child',
        description: '',
        open_to_building: false,
        open_to_things: false,
        open_to_notes: false,
      }],
      ['/api/thing', 'POST', {
        place_id: 454,
        name: 'forbidden thing',
        body: '',
      }],
      ['/api/place/454', 'PATCH', { description: 'forbidden edit' }],
      ['/api/place/454', 'PATCH', { quiet: true }],
      ['/api/place/454', 'PATCH', { front_matter_thing_ids: [] }],
    ] as const

    for (const [path, method, body] of requests) {
      reset({
        scenario: 'protected Gazette dependencies',
        placeOwnerId: 7,
        openToBuilding: true,
        openToThings: true,
        currentPlaceId: 454,
      })
      const response = await app.request(path, {
        method,
        headers: authHeaders(),
        body: JSON.stringify(body),
      })
      assert.equal(response.status, 409, `${path}: ${await response.clone().text()}`)
      assert.deepEqual(await response.json(), expected, path)
    }
  })
}
