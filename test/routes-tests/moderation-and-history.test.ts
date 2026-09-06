import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'


export function registerModerationAndHistoryTests(): void {
  const {
    OTHER_SECRET,
    app,
    authHeaders,
    fixtureState,
    reset,
    setActor,
    sqlCalls,
    test,
  } = getRoutesTestContext()


  test('founder moderation is remove-or-restore tombstoning, never governance', async () => {
    reset({ scenario: 'moderation' })
    setActor(1, 'founder')
    const removed = await app.request('/api/moderation', {
      method: 'POST',
      headers: authHeaders('1f3d9_sk_' + 'ef'.repeat(24)),
      body: JSON.stringify({ action: 'remove', target_type: 'note', target_id: 51, reason: 'illegal content' }),
    })
    assert.equal(removed.status, 201)

    fixtureState.current = { ...fixtureState.current, calls: [] }
    const tombstoned = await app.request('/api/place/2')
    assert.equal(tombstoned.status, 200)
    const tombstonedBody = await tombstoned.json() as {
      notes: Array<{ id: number; body: string; moderated?: boolean; moderation?: { reason: string } }>
    }
    assert.equal(tombstonedBody.notes[0]?.id, 51, JSON.stringify(tombstonedBody))
    assert.equal(tombstonedBody.notes[0]?.body, '[removed by maintainer]')
    assert.equal(tombstonedBody.notes[0]?.moderated, true)
    assert.equal(tombstonedBody.notes[0]?.moderation?.reason, 'illegal content')

    fixtureState.current = { ...fixtureState.current, calls: [] }
    const outline = await app.request('/api/place/2?view=outline')
    assert.equal(outline.status, 200)
    const outlineBody = await outline.json() as {
      notes: Array<{
        id: number
        body?: string
        body_text_bytes: number
        moderated?: boolean
        moderation?: { reason: string }
      }>
    }
    assert.equal(Object.hasOwn(outlineBody.notes[0]!, 'body'), false)
    assert.ok(outlineBody.notes[0]!.body_text_bytes > 0)
    assert.equal(outlineBody.notes[0]!.moderated, true)
    assert.equal(outlineBody.notes[0]!.moderation?.reason, 'illegal content')

    const pinned = await app.request('/api/moderation', {
      method: 'POST',
      headers: authHeaders('1f3d9_sk_' + 'ef'.repeat(24)),
      body: JSON.stringify({ action: 'pin', target_type: 'note', target_id: 51, reason: 'town notice' }),
    })
    assert.equal(pinned.status, 400)

    setActor(8, 'neighbor')
    const forbidden = await app.request('/api/moderation', {
      method: 'POST',
      headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ action: 'restore', target_type: 'note', target_id: 51, reason: 'no power' }),
    })
    assert.equal(forbidden.status, 403)

    setActor(1, 'founder')
    const restored = await app.request('/api/moderation', {
      method: 'POST',
      headers: authHeaders('1f3d9_sk_' + 'ef'.repeat(24)),
      body: JSON.stringify({ action: 'restore', target_type: 'note', target_id: 51, reason: 'restored' }),
    })
    assert.equal(restored.status, 201)
    assert.equal(fixtureState.current.noteRemoved, false)

    const visible = await app.request('/api/place/2')
    const visibleBody = await visible.json() as { notes: Array<{ body: string; moderated?: boolean }> }
    assert.equal(visibleBody.notes[0]?.body, 'hello from the square')
    assert.equal(visibleBody.notes[0]?.moderated, undefined)
  })

  test('removed kind and trait names cannot leak through place laws or nested kind references', async () => {
    const lawRecipe = { talk: [{ effect: 'label', target: 'place', label: 'secret-law-effect' }] }
    reset({
      scenario: 'nested moderation references',
      placeLawNames: ['quiet-hours'],
      lawTraitRecipe: lawRecipe,
      kindTraitNames: ['glowing', 'safe-trait'],
      kindRecipe: [
        { kind: 'banned-material', quantity: 1 },
        { kind: 'safe-material', quantity: 2 },
      ],
      moderatedKindIds: [3],
      moderatedKindNames: ['banned-material'],
      moderatedTraitIds: [4],
      moderatedTraitNames: ['glowing', 'quiet-hours'],
    })

    const placeResponse = await app.request('/api/place/2')
    assert.equal(placeResponse.status, 200)
    const place = await placeResponse.json() as {
      place: { id: number; owner_id: number; laws: Array<Record<string, unknown>> }
      things: Array<Record<string, unknown>>
    }
    assert.equal(place.place.id, 2)
    assert.equal(place.things[0]?.id, 41)
    assert.equal(place.things[0]?.owner_id, fixtureState.current.thingOwnerId)
    assert.equal(place.things[0]?.kind_id, 3)
    assert.equal(place.things[0]?.kind, '[removed by maintainer]')
    assert.equal(place.place.laws[0]?.traitId, 4)
    assert.equal(place.place.laws[0]?.name, '[removed by maintainer]')
    assert.equal(place.place.laws[0]?.recipe, null)
    assert.equal(JSON.stringify(place).includes('secret-law-effect'), false)
    assert.deepEqual(fixtureState.current.lawTraitRecipe, lawRecipe, 'stored law recipe remains unchanged')

    fixtureState.current = { ...fixtureState.current, calls: [], moderatedKindIds: [] }
    const kindsResponse = await app.request('/api/kinds')
    assert.equal(kindsResponse.status, 200)
    const kindsBody = await kindsResponse.json() as { kinds: Array<Record<string, unknown>> }
    const kind = kindsBody.kinds[0]!
    assert.equal(kind.id, 3)
    assert.equal(kind.owner_id, fixtureState.current.kindOwnerId)
    assert.deepEqual(kind.traits, ['[removed by maintainer]', 'safe-trait'])
    assert.deepEqual(kind.recipe, [
      { kind: '[removed by maintainer]', quantity: 1 },
      { kind: 'safe-material', quantity: 2 },
    ])
    const moderationReads = sqlCalls().filter(call => /from moderation_actions/i.test(call.query ?? ''))
    assert.ok(moderationReads.length <= 3, `nested moderation must stay batched: ${moderationReads.length}`)
    assert.equal(sqlCalls().some(call => /insert|update|delete/i.test(call.query ?? '')), false)
  })

  test('event history supports bounded cursor pages without changing the events array', async () => {
    reset({ scenario: 'event pagination' })
    const page = await app.request('/api/events?kind=note&before_id=204&limit=2')
    assert.equal(page.status, 200)
    const body = await page.json() as {
      events: Array<{ id: number }>
      has_more: boolean
      next_before_id: number | null
    }
    assert.deepEqual(body.events.map(event => event.id), [203, 202])
    assert.equal(body.has_more, true)
    assert.equal(body.next_before_id, 202)
    const eventRead = sqlCalls().find(call => /\/\* public:events \*\//i.test(call.query ?? ''))
    assert.match(eventRead?.query ?? '', /\$4::integer\s+is\s+null\s+or\s+event\.id\s*<\s*\$4::integer/i)
    assert.match(eventRead?.query ?? '', /limit\s+\$5::integer/i)
    assert.deepEqual(eventRead?.params, ['note', null, null, '204', '3', null])

    reset({ scenario: 'event pagination' })
    assert.equal((await app.request('/api/events?before_id=nope')).status, 400)
    assert.equal((await app.request('/api/events?limit=0')).status, 400)
    assert.equal((await app.request('/api/events?limit=201')).status, 400)
  })

  test('event history narrows by actor and by observed place', async () => {
    reset({ scenario: 'public pagination' })
    const byActor = await app.request('/api/events?actor=tiny-lantern&limit=3')
    assert.equal(byActor.status, 200)
    const actorBody = await byActor.json() as { events: Array<{ id: number }> }
    assert.deepEqual(actorBody.events.map(event => event.id), [70, 69, 68])
    const actorRead = sqlCalls().find(call => /from\s+events/i.test(call.query ?? ''))
    assert.match(actorRead?.query ?? '', /\$2::text\s+is\s+null\s+or\s+event\.actor\s*=\s*\$2::text/i)
    assert.match(actorRead?.query ?? '', /event\.detail->>'place_id'\s*=\s*\(\$3::integer\)::text/i)
    assert.match(actorRead?.query ?? '', /event\.detail->>'from_place_id'\s*=\s*\(\$3::integer\)::text/i)
    assert.match(actorRead?.query ?? '', /event\.detail->>'to_place_id'\s*=\s*\(\$3::integer\)::text/i)
    assert.match(actorRead?.query ?? '', /event\.detail->>'thing_id'[\s\S]*from\s+things/i)
    assert.match(actorRead?.query ?? '', /event\.detail->>'note_id'[\s\S]*from\s+notes/i)
    assert.match(actorRead?.query ?? '', /event\.detail->>'asset_type'\s*=\s*'thing'/i)
    assert.match(actorRead?.query ?? '', /event\.detail->>'asset_type'\s*=\s*'place'/i)
    assert.match(actorRead?.query ?? '', /event\.detail->>'offer_id'[\s\S]*from\s+transfer_offers/i)
    assert.match(actorRead?.query ?? '', /withdrawn_at\s+is\s+null/i)
    assert.deepEqual(actorRead?.params, [null, 'tiny-lantern', null, null, '4', null])

    reset({ scenario: 'public pagination' })
    const inside = await app.request('/api/events?within_place_id=2&limit=3')
    assert.equal(inside.status, 200)
    const insideRead = sqlCalls().find(call => /from\s+events/i.test(call.query ?? ''))
    assert.match(insideRead?.query ?? '', /WITH RECURSIVE selected_places/i)
    assert.match(insideRead?.query ?? '', /child\.parent_id\s*=\s*selected\.id/i)
    assert.match(insideRead?.query ?? '', /event\.detail->>'place_id'\s*IN\s*\(SELECT id::text FROM selected_places\)/i)
    assert.match(insideRead?.query ?? '', /event\.detail->>'from_place_id'\s*IN\s*\(SELECT id::text FROM selected_places\)/i)
    assert.match(insideRead?.query ?? '', /event\.detail->>'to_place_id'\s*IN\s*\(SELECT id::text FROM selected_places\)/i)
    assert.match(insideRead?.query ?? '', /thing\.place_id IN \(SELECT id FROM selected_places\)/i)
    assert.deepEqual(insideRead?.params, [null, null, '2', null, '4', null])

    const invalid = [
      '/api/events?actor=Not%20A%20Handle',
      '/api/events?actor=x',
      '/api/events?actor=tiny-lantern&actor=neighbor',
      '/api/events?place_id=0',
      '/api/events?place_id=nope',
      '/api/events?place_id=2147483648',
      '/api/events?place_id=2&place_id=3',
      '/api/events?within_place_id=0',
      '/api/events?within_place_id=nope',
      '/api/events?within_place_id=2&within_place_id=3',
      '/api/events?place_id=2&within_place_id=2',
    ]
    for (const path of invalid) {
      reset({ scenario: 'public pagination' })
      const response = await app.request(path)
      assert.equal(response.status, 400, path)
      assert.equal(sqlCalls().length, 0, `${path} should fail before reading PostgreSQL`)
    }
  })

  test('removed authored names are tombstoned inside append-only event details', async () => {
    reset({
      scenario: 'nested moderation events',
      moderatedPlaceIds: [2],
      moderatedKindIds: [3],
      moderatedKindNames: ['banned-material'],
      moderatedTraitNames: ['glowing', 'quiet-hours'],
    })
    const response = await app.request('/api/events')
    assert.equal(response.status, 200)
    const body = await response.json() as { events: Array<Record<string, unknown>> }
    assert.deepEqual(body.events.map(event => event.id), [80, 83, 81, 82])
    assert.deepEqual(body.events.map(event => event.at), [
      '2026-08-11T00:06:00.000Z', '2026-08-11T00:09:00.000Z',
      '2026-08-11T00:07:00.000Z', '2026-08-11T00:08:00.000Z',
    ])
    const details = body.events.map(event => event.detail) as Array<Record<string, unknown>>
    assert.deepEqual(details[0]?.traits, ['[removed by maintainer]', 'safe-trait'])
    assert.equal(details[1]?.name, '[removed by maintainer]')
    assert.equal(details[1]?.former_name, '[removed by maintainer]')
    assert.equal(details[2]?.name, '[removed by maintainer]')
    assert.deepEqual(details[2]?.traits, [])
    assert.equal(details[2]?.recipe, null)
    assert.deepEqual(details[3]?.traits, ['[removed by maintainer]', 'safe-trait'])
    assert.deepEqual(details[3]?.recipe, [
      { kind: '[removed by maintainer]', quantity: 1 },
      { kind: 'safe-material', quantity: 2 },
    ])
    const encodedDetails = JSON.stringify(details)
    for (const removed of [
      'lantern', 'quiet-hours', 'glowing', 'banned-material',
      'new unsafe name', 'old unsafe name',
    ]) {
      assert.equal(encodedDetails.includes(removed), false, `${removed} leaked through event detail`)
    }
    assert.equal(sqlCalls().some(call => /insert|update|delete/i.test(call.query ?? '')), false)
  })

  test('anonymous window batches event moderation without advancing timers', async () => {
    const originalNow = Date.now
    try {
      const realNow = originalNow()
      Date.now = () => realNow + 60_000
      reset({
        scenario: 'nested moderation events',
        scheduledLabelAt: realNow - 1,
        moderatedKindIds: [3],
        moderatedPlaceIds: [2],
        moderatedKindNames: ['banned-material'],
        moderatedTraitNames: ['glowing', 'quiet-hours'],
      })
      const response = await app.request('/api/window')
      assert.equal(response.status, 200)
      const body = await response.json() as { events: Array<Record<string, unknown>> }
      assert.deepEqual(body.events.map(event => event.id), [80, 83, 81, 82])
      const queries = sqlCalls().map(call => call.query ?? '')
      assert.ok(queries.some(query => /from moderation_actions[\s\S]*join traits named/i.test(query)))
      assert.ok(queries.some(query => /from moderation_actions[\s\S]*join kinds named/i.test(query)))
      assert.equal(queries.some(query => /pending_effects|effect_resolutions/i.test(query)), false)
      assert.equal(queries.some(query => /insert|update|delete/i.test(query)), false)
    } finally {
      Date.now = originalNow
    }
  })

  test('removed kind and trait records expose identity and history but no authored mechanics', async () => {
    reset({
      scenario: 'top-level moderation payloads',
      traitHasRecipe: true,
      kindTraitNames: ['glowing'],
      kindRecipe: [{ kind: 'banned-material', quantity: 1 }],
      moderatedKindIds: [3],
      moderatedTraitIds: [4],
    })
    const kindsResponse = await app.request('/api/kinds')
    const kinds = await kindsResponse.json() as { kinds: Array<Record<string, unknown>> }
    assert.equal(kindsResponse.status, 200)
    assert.equal(kinds.kinds[0]?.id, 3)
    assert.equal(kinds.kinds[0]?.owner_id, fixtureState.current.kindOwnerId)
    assert.equal(kinds.kinds[0]?.revision, fixtureState.current.kindRevision)
    assert.equal(kinds.kinds[0]?.name, '[removed by maintainer]')
    assert.equal(kinds.kinds[0]?.description, '[removed by maintainer]')
    assert.deepEqual(kinds.kinds[0]?.traits, [])
    assert.equal(kinds.kinds[0]?.recipe, null)

    const traitsResponse = await app.request('/api/traits')
    const traits = await traitsResponse.json() as { traits: Array<Record<string, unknown>> }
    assert.equal(traitsResponse.status, 200)
    assert.equal(traits.traits[0]?.id, 4)
    assert.equal(traits.traits[0]?.coiner, 'founder')
    assert.equal(traits.traits[0]?.name, '[removed by maintainer]')
    assert.equal(traits.traits[0]?.description, '[removed by maintainer]')
    assert.equal(traits.traits[0]?.recipe, null)
    assert.equal(traits.traits[0]?.mechanical, false)
  })

  test('/api/me refreshes presence and includes agreements the resident authored without joining', async () => {
    reset({
      scenario: 'me timer refresh',
      scheduledLabelAt: Date.now() - 1,
      agreementParties: ['neighbor'],
    })

    const response = await app.request('/api/me', { headers: authHeaders() })
    assert.equal(response.status, 200)
    const body = await response.json() as { agreements: Array<Record<string, unknown>> }
    assert.deepEqual(body.agreements[0], {
      id: 61,
      body: 'we keep the square open',
      created_by_me: true,
      acceded: false,
      accession_open: false,
      signed: false,
      created_at: '2026-08-11T00:00:00.000Z',
    })

    const presenceReads = sqlCalls().filter(call =>
      (call.query ?? '').replace(/\s+/g, ' ').toLowerCase()
        .includes('with first_owned as'))
    assert.equal(presenceReads.length, 2, JSON.stringify(sqlCalls().map(call => call.query)))
    assert.ok(sqlCalls().some(call => {
      const query = (call.query ?? '').replace(/\s+/g, ' ').toLowerCase()
      return query.includes('from agreements a') &&
        query.includes('a.created_by_id =') && query.includes('or p.resident_id is not null')
    }))
  })
}
