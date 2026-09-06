import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'


export function registerThingUseTests(): void {
  const {
    OTHER_SECRET,
    app,
    authHeaders,
    reset,
    setActor,
    sqlCalls,
    test,
  } = getRoutesTestContext()


  test('thing detail and place reads expose open_to_use, defaulting to false', async () => {
    reset({ scenario: 'thing open_to_use read', thingOpenToUse: false })

    const [thingResponse, placeResponse] = await Promise.all([
      app.request('/api/thing/41'),
      app.request('/api/place/2'),
    ])
    assert.equal(thingResponse.status, 200)
    assert.equal(placeResponse.status, 200)

    const thingBody = await thingResponse.json() as { thing: { open_to_use: boolean } }
    const placeBody = await placeResponse.json() as {
      things: Array<Record<string, unknown> & { id: number; open_to_use: boolean }>
    }
    assert.equal(thingBody.thing.open_to_use, false)
    assert.equal(placeBody.things.find(thing => thing.id === 41)?.open_to_use, false)
    assert.deepEqual({
      maker_id: placeBody.things[0]?.maker_id,
      made_by: placeBody.things[0]?.made_by,
      current_owner_id: placeBody.things[0]?.current_owner_id,
      current_owner: placeBody.things[0]?.current_owner,
      owner_id: placeBody.things[0]?.owner_id,
      owner: placeBody.things[0]?.owner,
    }, {
      maker_id: 7,
      made_by: 'tiny-lantern',
      current_owner_id: 7,
      current_owner: 'tiny-lantern',
      owner_id: 7,
      owner: 'tiny-lantern',
    })
    const detailRead = sqlCalls().find(call => (
      /from\s+things\s+thing/i.test(call.query ?? '') && /where\s+thing\.id/i.test(call.query ?? '')
    ))
    const placeRead = sqlCalls().find(call => /from\s+things\s+t\b/i.test(call.query ?? ''))
    assert.match(detailRead?.query ?? '', /thing\.open_to_use/i)
    assert.match(placeRead?.query ?? '', /t\.open_to_use/i)
    assert.match(placeRead?.query ?? '', /t\.maker_id/i)
    assert.match(placeRead?.query ?? '', /maker\.handle\s+AS\s+made_by/i)
    assert.match(placeRead?.query ?? '', /t\.owner_id\s+AS\s+current_owner_id/i)
    assert.match(placeRead?.query ?? '', /owner\.handle\s+AS\s+current_owner/i)

    for (const view of ['full', 'outline'] as const) {
      const viewed = await app.request(`/api/place/2?view=${view}`)
      assert.equal(viewed.status, 200)
      const viewedBody = await viewed.json() as { things: Array<Record<string, unknown>> }
      assert.deepEqual({
        maker_id: viewedBody.things[0]?.maker_id,
        made_by: viewedBody.things[0]?.made_by,
        current_owner_id: viewedBody.things[0]?.current_owner_id,
        current_owner: viewedBody.things[0]?.current_owner,
        owner_id: viewedBody.things[0]?.owner_id,
        owner: viewedBody.things[0]?.owner,
      }, {
        maker_id: 7,
        made_by: 'tiny-lantern',
        current_owner_id: 7,
        current_owner: 'tiny-lantern',
        owner_id: 7,
        owner: 'tiny-lantern',
      }, view)
    }

    reset({ scenario: 'remaining pagination' })
    const meResponse = await app.request('/api/me', { headers: authHeaders() })
    assert.equal(meResponse.status, 200)
    const meBody = await meResponse.json() as { things: Array<Record<string, unknown> & { open_to_use: boolean }> }
    assert.equal(meBody.things[0]?.open_to_use, false)
    assert.deepEqual({
      maker_id: meBody.things[0]?.maker_id,
      made_by: meBody.things[0]?.made_by,
      current_owner_id: meBody.things[0]?.current_owner_id,
      current_owner: meBody.things[0]?.current_owner,
      owner_id: meBody.things[0]?.owner_id,
      owner: meBody.things[0]?.owner,
    }, {
      maker_id: 6,
      made_by: 'archive-smith',
      current_owner_id: 7,
      current_owner: 'tiny-lantern',
      owner_id: 7,
      owner: 'tiny-lantern',
    })
    const meRead = sqlCalls().find(call => /\/\*\s*public:me_things\s*\*\//i.test(call.query ?? ''))
    assert.match(meRead?.query ?? '', /\bopen_to_use\b/i)
    assert.match(meRead?.query ?? '', /thing\.maker_id/i)
    assert.match(meRead?.query ?? '', /maker\.handle\s+AS\s+made_by/i)
    assert.match(meRead?.query ?? '', /thing\.owner_id\s+AS\s+current_owner_id/i)
    assert.match(meRead?.query ?? '', /current_owner\.handle\s+AS\s+current_owner/i)
  })

  test('new things default closed and may be opened explicitly by their creator', async () => {
    reset({ scenario: 'thing open_to_use create default', openToThings: true })
    const closed = await app.request('/api/thing', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ place_id: 2, name: 'closed lantern', body: 'owner use only' }),
    })
    assert.equal(closed.status, 201)
    const closedBody = await closed.json() as {
      thing: Record<string, unknown> & { open_to_use: boolean; body: string }
      reading_cost: { new_item_text_bytes: number }
    }
    assert.equal(closedBody.thing.open_to_use, false)
    assert.deepEqual({
      maker_id: closedBody.thing.maker_id,
      made_by: closedBody.thing.made_by,
      current_owner_id: closedBody.thing.current_owner_id,
      current_owner: closedBody.thing.current_owner,
      owner_id: closedBody.thing.owner_id,
      owner: closedBody.thing.owner,
    }, {
      maker_id: 7,
      made_by: 'tiny-lantern',
      current_owner_id: 7,
      current_owner: 'tiny-lantern',
      owner_id: 7,
      owner: 'tiny-lantern',
    })
    assert.equal(closedBody.reading_cost.new_item_text_bytes, Buffer.byteLength(closedBody.thing.body))
    const closedInsert = sqlCalls().find(call => /insert\s+into\s+things/i.test(call.query ?? ''))
    assert.match(closedInsert?.query ?? '', /\bmaker_id\b/i)
    assert.match(closedInsert?.query ?? '', /\bmade_by\b/i)
    assert.match(closedInsert?.query ?? '', /\bcurrent_owner_id\b/i)
    assert.match(closedInsert?.query ?? '', /\bcurrent_owner\b/i)

    reset({ scenario: 'thing open_to_use create explicit', openToThings: true, thingOpenToUse: true })
    const opened = await app.request('/api/thing', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        place_id: 2, name: 'public lantern', body: 'visitors may use this', open_to_use: true,
      }),
    })
    assert.equal(opened.status, 201, await opened.clone().text())
    const openedBody = await opened.json() as { thing: { open_to_use: boolean } }
    assert.equal(openedBody.thing.open_to_use, true)
    const insert = sqlCalls().find(call => /insert\s+into\s+things/i.test(call.query ?? ''))
    assert.match(insert?.query ?? '', /\bopen_to_use\b/i)
    assert.equal(insert?.params?.some(value => value === true || value === 'true'), true)

    for (const invalid of [null, 'yes', 1]) {
      const response = await app.request('/api/thing', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          place_id: 2, name: 'invalid lantern', body: '', open_to_use: invalid,
        }),
      })
      assert.equal(response.status, 400)
    }

    for (const forbidden of [{ maker_id: 8 }, { made_by: 'neighbor' }]) {
      const response = await app.request('/api/thing', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          place_id: 2, name: 'forged provenance', body: '', ...forbidden,
        }),
      })
      assert.equal(response.status, 400)
    }

    const mentionsAnotherResident = await app.request('/api/thing', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        place_id: 2,
        name: 'A lantern for neighbor',
        body: 'Made to answer neighbor without claiming neighbor made it.',
      }),
    })
    assert.equal(mentionsAnotherResident.status, 201)
    const attributed = await mentionsAnotherResident.json() as { thing: Record<string, unknown> }
    assert.equal(attributed.thing.made_by, 'tiny-lantern')
  })

  test('the thing owner can toggle open_to_use and a visitor cannot edit it', async () => {
    reset({ scenario: 'thing open_to_use patch', thingOwnerId: 7, thingOpenToUse: false })

    const changed = await app.request('/api/thing/41', {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ open_to_use: true }),
    })
    assert.equal(changed.status, 200)
    const changedBody = await changed.json() as { thing: { open_to_use: boolean }; reading_cost: { room_stored_text_bytes: number } }
    assert.equal(changedBody.thing.open_to_use, true)
    assert.equal(changedBody.reading_cost.room_stored_text_bytes, 1234)
    const update = sqlCalls().find(call => /update\s+things\s+set/i.test(call.query ?? ''))
    assert.match(update?.query ?? '', /\bopen_to_use\b/i)
    assert.match(update?.query ?? '', /result\.maker_id/i)
    assert.match(update?.query ?? '', /maker\.handle\s+AS\s+made_by/i)
    assert.match(update?.query ?? '', /result\.owner_id\s+AS\s+current_owner_id/i)
    assert.match(update?.query ?? '', /current_owner\.handle\s+AS\s+current_owner/i)
    assert.match(update?.query ?? '', /JOIN\s+residents\s+maker\s+ON\s+maker\.id\s*=\s*result\.maker_id/i)
    assert.match(update?.query ?? '', /JOIN\s+residents\s+current_owner\s+ON\s+current_owner\.id\s*=\s*result\.owner_id/i)

    reset({
      scenario: 'transferred thing edit keeps maker',
      actorId: 8,
      actorHandle: 'neighbor',
      thingOwnerId: 8,
      thingOpenToUse: false,
    })
    const transferred = await app.request('/api/thing/41', {
      method: 'PATCH',
      headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ body: 'kept by a new owner' }),
    })
    assert.equal(transferred.status, 200)
    const transferredBody = await transferred.json() as { thing: Record<string, unknown> }
    assert.deepEqual({
      maker_id: transferredBody.thing.maker_id,
      made_by: transferredBody.thing.made_by,
      current_owner_id: transferredBody.thing.current_owner_id,
      current_owner: transferredBody.thing.current_owner,
      owner_id: transferredBody.thing.owner_id,
      owner: transferredBody.thing.owner,
    }, {
      maker_id: 7,
      made_by: 'tiny-lantern',
      current_owner_id: 8,
      current_owner: 'neighbor',
      owner_id: 8,
      owner: 'neighbor',
    })

    reset({ scenario: 'thing open_to_use patch denied', thingOwnerId: 7, thingOpenToUse: false })
    setActor(8, 'neighbor')
    const denied = await app.request('/api/thing/41', {
      method: 'PATCH',
      headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ open_to_use: true }),
    })
    assert.equal(denied.status, 403)

    reset({ scenario: 'thing open_to_use validation' })
    for (const invalid of [null, 'yes', 1]) {
      const response = await app.request('/api/thing/41', {
        method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ open_to_use: invalid }),
      })
      assert.equal(response.status, 400)
    }

    reset({
      scenario: 'thing open_to_use offer lock',
      offer: { id: 90, status: 'open', reservedAt: null, reservedUntil: null, buyerWallet: null },
    })
    const offered = await app.request('/api/thing/41', {
      method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ open_to_use: true }),
    })
    assert.equal(offered.status, 409)
  })
}
