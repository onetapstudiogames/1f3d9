import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'
import type { FakeState } from '../helpers/routes-fixtures/state.ts'


export function registerRoomOrientationTests(): void {
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


  test('only a place owner can edit its description and three permission switches', async () => {
    reset({ scenario: 'place patch', placeOwnerId: 7 })
    const changed = await app.request('/api/place/2', {
      method: 'PATCH', headers: authHeaders(),
      body: JSON.stringify({
        description: 'changed by its owner',
        open_to_building: true,
        open_to_things: true,
        open_to_notes: false,
      }),
    })
    assert.equal(changed.status, 200, await changed.clone().text())

    setActor(8, 'neighbor')
    const rejected = await app.request('/api/place/2', {
      method: 'PATCH', headers: authHeaders(OTHER_SECRET), body: JSON.stringify({ open_to_building: false }),
    })
    assert.equal(rejected.status, 403)
  })

  type RoomFrontMatterHeading = {
    id: number
    type: string
    name: string
    body_text_bytes: number
    maker_id: number
    made_by: string
    current_owner_id: number
    current_owner: string
    owner_id: number
    owner: string
    body?: unknown
    body_snippet?: unknown
    snippet?: unknown
  }

  function assertRoomFrontMatter(
    headings: readonly RoomFrontMatterHeading[],
    expectedIds: readonly number[],
  ) {
    assert.deepEqual(headings.map(heading => heading.id), expectedIds)
    for (const heading of headings) {
      assert.equal(heading.type, 'thing')
      assert.equal(typeof heading.name, 'string')
      assert.ok(heading.body_text_bytes > 0)
      assert.ok(heading.maker_id > 0)
      assert.match(heading.made_by, /^(?:tiny-lantern|neighbor)$/u)
      assert.ok(heading.current_owner_id > 0)
      assert.match(heading.current_owner, /^(?:tiny-lantern|neighbor)$/u)
      assert.equal(heading.owner_id, heading.current_owner_id)
      assert.equal(heading.owner, heading.current_owner)
      assert.equal(Object.hasOwn(heading, 'body'), false)
      assert.equal(Object.hasOwn(heading, 'body_snippet'), false)
      assert.equal(Object.hasOwn(heading, 'snippet'), false)
    }
  }

  test('a place owner sets purpose and two or three ordered front-matter headings without changing description', async () => {
    reset({ scenario: 'room orientation', placeOwnerId: 7 })
    const payload = {
      purpose: 'A small room for deliberate reading.',
      front_matter_thing_ids: [43, 41, 42],
    }
    const changed = await app.request('/api/place/2', {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify(payload),
    })
    assert.equal(changed.status, 200, await changed.clone().text())
    const body = await changed.json() as {
      place: { purpose: string; description: string }
      front_matter: RoomFrontMatterHeading[]
    }
    assert.equal(body.place.purpose, payload.purpose)
    assert.equal(body.place.description, 'a place made from words')
    assert.equal(Object.hasOwn(body.place, 'front_matter_thing_ids'), false)
    assertRoomFrontMatter(body.front_matter, payload.front_matter_thing_ids)
    assert.deepEqual(body.front_matter[0], {
      ...body.front_matter[0],
      id: 43,
      type: 'thing',
      name: 'borrowed field guide',
      body_text_bytes: Buffer.byteLength('three careful routes 🏙', 'utf8'),
      maker_id: 8,
      made_by: 'neighbor',
      current_owner_id: 7,
      current_owner: 'tiny-lantern',
      owner_id: 7,
      owner: 'tiny-lantern',
    })

    const retried = await app.request('/api/place/2', {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify(payload),
    })
    assert.equal(retried.status, 200, await retried.clone().text())
    const retriedBody = await retried.json() as {
      place: { purpose: string; description: string }
      front_matter: RoomFrontMatterHeading[]
    }
    assert.equal(retriedBody.place.purpose, payload.purpose)
    assert.equal(retriedBody.place.description, 'a place made from words')
    assertRoomFrontMatter(retriedBody.front_matter, payload.front_matter_thing_ids)
  })

  test('room orientation is owner-only and rejects malformed or ineligible selections', async () => {
    reset({
      scenario: 'room orientation', placeOwnerId: 7,
      roomPurpose: 'A retry-safe reading room.', frontMatterThingIds: [41, 42],
    })
    setActor(8, 'neighbor')
    const forbidden = await app.request('/api/place/2', {
      method: 'PATCH', headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ purpose: 'Keep the old description.' }),
    })
    assert.equal(forbidden.status, 403, await forbidden.text())
    assert.equal(fixtureState.current.roomPurpose, 'A retry-safe reading room.')
    assert.deepEqual(fixtureState.current.frontMatterThingIds, [41, 42])

    setActor(7, 'tiny-lantern')
    const malformedBodies: readonly Record<string, unknown>[] = [
      { purpose: 'safe', surprise: true },
      { purpose: 42 },
      { purpose: 'two\nlines' },
      { purpose: 'x'.repeat(281) },
      { front_matter_thing_ids: '41,42' },
      { front_matter_thing_ids: [41] },
      { front_matter_thing_ids: [41, 42, 43, 44] },
      { front_matter_thing_ids: [41, 41] },
      { front_matter_thing_ids: [0, 42] },
    ]
    for (const malformed of malformedBodies) {
      const response = await app.request('/api/place/2', {
        method: 'PATCH', headers: authHeaders(), body: JSON.stringify(malformed),
      })
      assert.equal(response.status, 400, JSON.stringify({ malformed, body: await response.text() }))
      assert.equal(fixtureState.current.roomPurpose, 'A retry-safe reading room.')
      assert.deepEqual(fixtureState.current.frontMatterThingIds, [41, 42])
    }

    for (const patch of [
      { frontMatterMovedThingIds: [42] },
      { targetThingWithdrawn: true },
      { frontMatterHiddenThingIds: [42] },
    ] satisfies readonly Partial<FakeState>[]) {
      reset({ scenario: 'room orientation', placeOwnerId: 7, ...patch })
      const response = await app.request('/api/place/2', {
        method: 'PATCH', headers: authHeaders(),
        body: JSON.stringify({ front_matter_thing_ids: [41, 42] }),
      })
      assert.equal(response.status, 400, await response.text())
      assert.equal(fixtureState.current.roomPurpose, '')
      assert.deepEqual(fixtureState.current.frontMatterThingIds, [])
    }
  })

  test('place edit refuses a laws field in every value shape, names it, and points at the laws door', async () => {
    const lawShapedBodies: readonly Record<string, unknown>[] = [
      { laws: [247] },
      { laws: [{ traitId: 247 }] },
      { laws: [{ traitId: 247 }], description: 'unchanged text' },
      { law_trait_ids: [247] },
      { trait_ids: [247] },
      { add_law: 247 },
    ]
    for (const body of lawShapedBodies) {
      reset({
        scenario: 'room orientation', placeOwnerId: 7,
        roomPurpose: 'A retry-safe reading room.', frontMatterThingIds: [41, 42],
      })
      setActor(7, 'tiny-lantern')
      const response = await app.request('/api/place/2', {
        method: 'PATCH', headers: authHeaders(), body: JSON.stringify(body),
      })
      const responseBody = await response.json() as { error?: string }
      assert.equal(response.status, 400, JSON.stringify({ body, responseBody }))
      const rejectedKey = Object.keys(body).find(key => key !== 'description')!
      assert.match(responseBody.error ?? '', new RegExp(rejectedKey), JSON.stringify(body))
      assert.match(responseBody.error ?? '', /PUT \/api\/place\/:id\/laws/u, JSON.stringify(body))
      assert.equal(fixtureState.current.roomPurpose, 'A retry-safe reading room.', JSON.stringify(body))
      assert.deepEqual(fixtureState.current.frontMatterThingIds, [41, 42], JSON.stringify(body))
    }

    // A plain unknown field outside the laws family is refused the same way,
    // by name; the laws-door pointer rides on every place_edit refusal.
    reset({
      scenario: 'room orientation', placeOwnerId: 7,
      roomPurpose: 'A retry-safe reading room.', frontMatterThingIds: [41, 42],
    })
    setActor(7, 'tiny-lantern')
    const plainUnknown = await app.request('/api/place/2', {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ mood: 'cozy' }),
    })
    const plainUnknownBody = await plainUnknown.json() as { error?: string }
    assert.equal(plainUnknown.status, 400)
    assert.match(plainUnknownBody.error ?? '', /mood/u)
  })

  test('public outline and full place reads expose ordered body-free orientation headings only while eligible', async () => {
    reset({
      scenario: 'room orientation',
      roomPurpose: 'A small room for deliberate reading.',
      frontMatterThingIds: [43, 41, 42],
    })
    for (const view of ['outline', 'full'] as const) {
      const response = await app.request(`/api/place/2?view=${view}`)
      assert.equal(response.status, 200, await response.clone().text())
      const body = await response.json() as {
        place: { purpose: string; description?: string }
        front_matter: RoomFrontMatterHeading[]
      }
      assert.equal(body.place.purpose, 'A small room for deliberate reading.')
      assertRoomFrontMatter(body.front_matter, [43, 41, 42])
    }

    fixtureState.current = { ...fixtureState.current, calls: [], frontMatterMovedThingIds: [43] }
    const afterMove = await app.request('/api/place/2?view=outline')
    assert.equal(afterMove.status, 200)
    assertRoomFrontMatter(
      (await afterMove.json() as { front_matter: RoomFrontMatterHeading[] }).front_matter,
      [41, 42],
    )

    fixtureState.current = { ...fixtureState.current, calls: [], thingWithdrawn: true }
    const afterWithdrawal = await app.request('/api/place/2?view=full')
    assert.equal(afterWithdrawal.status, 200)
    assertRoomFrontMatter(
      (await afterWithdrawal.json() as { front_matter: RoomFrontMatterHeading[] }).front_matter,
      [42],
    )

    fixtureState.current = { ...fixtureState.current, calls: [], frontMatterHiddenThingIds: [42] }
    const afterModeration = await app.request('/api/place/2?view=outline')
    assert.equal(afterModeration.status, 200)
    const hiddenBody = await afterModeration.json() as { front_matter: RoomFrontMatterHeading[] }
    assertRoomFrontMatter(hiddenBody.front_matter, [])
    assert.equal(hiddenBody.front_matter.some(heading => heading.id === 44), false)

    const orientationRead = sqlCalls().find(call => {
      const query = call.query ?? ''
      return /front_matter_thing_ids/iu.test(query) && /\bthings\b|\bunnest\s*\(/iu.test(query)
    })
    assert.ok(orientationRead, 'public place reads must load only the selected front-matter rows')
    assert.match(orientationRead.query ?? '', /with\s+ordinality|order\s+by[\s\S]*(?:position|ordinality)/iu)
  })

  test('an empty selection clears front matter and a stale eligibility race returns a retryable conflict', async () => {
    reset({
      scenario: 'room orientation', placeOwnerId: 7,
      roomPurpose: 'A retry-safe reading room.', frontMatterThingIds: [41, 42],
    })
    const cleared = await app.request('/api/place/2', {
      method: 'PATCH', headers: authHeaders(),
      body: JSON.stringify({ front_matter_thing_ids: [] }),
    })
    assert.equal(cleared.status, 200, await cleared.clone().text())
    const clearedBody = await cleared.json() as {
      place: { purpose: string; description: string }
      front_matter: RoomFrontMatterHeading[]
    }
    assert.equal(clearedBody.place.purpose, 'A retry-safe reading room.')
    assert.equal(clearedBody.place.description, 'a place made from words')
    assertRoomFrontMatter(clearedBody.front_matter, [])

    reset({ scenario: 'room orientation', placeOwnerId: 7, frontMatterRaceLost: true })
    const raced = await app.request('/api/place/2', {
      method: 'PATCH', headers: authHeaders(),
      body: JSON.stringify({ front_matter_thing_ids: [41, 42] }),
    })
    assert.equal(raced.status, 409, await raced.clone().text())
    assert.match((await raced.json() as { error: string }).error, /retry/iu)

    fixtureState.current = { ...fixtureState.current, frontMatterRaceLost: false, calls: [] }
    const retry = await app.request('/api/place/2', {
      method: 'PATCH', headers: authHeaders(),
      body: JSON.stringify({ front_matter_thing_ids: [41, 42] }),
    })
    assert.equal(retry.status, 200, await retry.clone().text())
    assertRoomFrontMatter(
      (await retry.json() as { front_matter: RoomFrontMatterHeading[] }).front_matter,
      [41, 42],
    )
  })
}
