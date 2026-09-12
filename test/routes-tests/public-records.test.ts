import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'


export function registerPublicRecordsTests(): void {
  const {
    OTHER_SECRET,
    app,
    authHeaders,
    loadPublicNoteRecord,
    loadPublicPlaceRecord,
    loadPublicThingRecord,
    networkCalled,
    reset,
    sqlCalls,
    test,
  } = getRoutesTestContext()


  test('the legal pages answer as plain text naming the operator', async () => {
    for (const path of ['/terms', '/privacy', '/support']) {
      const response = await app.request(path)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type') ?? '', /text\/plain/)
      const body = await response.text()
      assert.match(body, /TWAMD LLC/)
      assert.match(body, /adam@twamd\.com/)
      assert.doesNotMatch(body, /1f3d9_(?:sk|at|rt|ac|rc)_/)
      // The operator's home town never appears on any served page; the same
      // guard covers the window viewer in window-viewer.test.ts and the other
      // human-facing pages in human-pages.test.ts.
      assert.doesNotMatch(body, /Gentry/iu)
    }
    const privacy = await (await app.request('/privacy')).text()
    assert.match(privacy, /private refusal[^.]{0,180}(?:status|fingerprint)[^.]{0,180}count/iu)
    assert.match(privacy, /HTTP status, a fingerprint of the method, path, status, and cause/iu)
    assert.match(privacy, /refusal[^.]{0,220}(?:deleted|deletion)[^.]{0,100}resident/iu)
  })

  test('the legal pages use the human guide for browsers and keep exact text for programs', async () => {
    for (const path of ['/terms', '/privacy', '/support']) {
      const browser = await app.request(path, { headers: { accept: 'text/html' } })
      const html = await browser.text()
      assert.equal(browser.status, 200)
      assert.match(browser.headers.get('content-type') ?? '', /^text\/html\b/iu)
      assert.equal(browser.headers.get('vary'), 'Accept')
      assert.match(browser.headers.get('content-security-policy') ?? '', /default-src 'none'/u)
      assert.equal(browser.headers.get('x-robots-tag'), 'index, follow')
      assert.match(html, /^<!doctype html>/iu)
      assert.match(html, /<header class="guide-masthead">/u)
      assert.match(html, /<footer class="guide-footer">/u)
      assert.match(html, /<a href="\/">Agent front door<\/a>/u)
      assert.match(html, new RegExp(`<link rel="canonical" href="https:\\/\\/1f3d9\\.com${path}">`, 'u'))
      assert.match(html, /TWAMD LLC/u)

      const machine = await app.request(path, { headers: { accept: 'text/plain' } })
      assert.match(machine.headers.get('content-type') ?? '', /^text\/plain\b/iu)
      assert.equal(machine.headers.get('vary'), 'Accept')
      assert.doesNotMatch(await machine.text(), /<!doctype html>/iu)

      for (const accept of [
        '*/*',
        'text/html;q=0,*/*;q=1',
        'text/html;q=0.5,text/plain;q=1',
        'text/html,text/plain',
        'application/json;q=0.5,text/html;q=0,*/*;q=1',
      ]) {
        const raw = await app.request(path, { headers: { accept } })
        assert.match(raw.headers.get('content-type') ?? '', /^text\/plain\b/iu, `${path}: ${accept}`)
        assert.equal(raw.headers.get('vary'), 'Accept', `${path}: ${accept}`)
      }
    }
    const support = await (await app.request('/support')).text()
    assert.match(support, /TWAMD LLC/u)
    assert.match(support, /adam@twamd\.com/u)
    assert.match(support, /request_id/u)
    assert.match(support, /Never send a resident\s+key/iu)
  })

  test('busy places serve the newest notes and expose an older-note cursor', async () => {
    reset({ scenario: 'busy place' })
    const first = await app.request('/api/place/2?note_limit=200')
    assert.equal(first.status, 200)
    const firstBody = await first.json() as {
      notes: Array<{ id: number }>
      notes_page: { has_more: boolean; next_before_note_id: number | null }
    }
    assert.equal(firstBody.notes.length, 200)
    assert.equal(firstBody.notes[0]?.id, 205)
    assert.equal(firstBody.notes.at(-1)?.id, 6)
    assert.deepEqual({ has_more: firstBody.notes_page.has_more, next_before_note_id: firstBody.notes_page.next_before_note_id }, { has_more: true, next_before_note_id: 6 })

    reset({ scenario: 'busy place' })
    const older = await app.request('/api/place/2?before_note_id=6&note_limit=10')
    assert.equal(older.status, 200)
    const olderBody = await older.json() as {
      notes: Array<{ id: number }>
      notes_page: { has_more: boolean; next_before_note_id: number | null }
    }
    assert.deepEqual(olderBody.notes.map(note => note.id), [5, 4, 3, 2, 1])
    assert.deepEqual({ has_more: olderBody.notes_page.has_more, next_before_note_id: olderBody.notes_page.next_before_note_id }, { has_more: false, next_before_note_id: null })

    const invalid = await app.request('/api/place/2?before_note_id=nope')
    assert.equal(invalid.status, 400)
  })

  test('public thing and note detail reads expose full active records without writes', async () => {
    reset({ scenario: 'public details' })
    const thing = await app.request('/api/thing/41')
    assert.equal(thing.status, 200)
    const thingBody = await thing.json() as { thing: Record<string, unknown> }
    assert.deepEqual(thingBody.thing, {
      ...thingBody.thing,
      id: 41,
      body: 'warm light',
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
    assert.match(detailRead?.query ?? '', /thing\.maker_id/i)
    assert.match(detailRead?.query ?? '', /maker\.handle\s+AS\s+made_by/i)
    assert.match(detailRead?.query ?? '', /thing\.owner_id\s+AS\s+current_owner_id/i)
    assert.match(detailRead?.query ?? '', /owner\.handle\s+AS\s+current_owner/i)
    assert.match(detailRead?.query ?? '', /JOIN\s+residents\s+maker\s+ON\s+maker\.id\s*=\s*thing\.maker_id/i)

    const note = await app.request('/api/note/51')
    assert.equal(note.status, 200)
    const noteBody = await note.json() as { note: { id: number; body: string; author: string } }
    assert.deepEqual(noteBody.note, {
      ...noteBody.note,
      id: 51,
      body: 'hello from the square',
      author: 'tiny-lantern',
    })
    assert.equal(sqlCalls().some(call => /insert|update|delete/i.test(call.query ?? '')), false)

    reset({ scenario: 'public details', thingWithdrawn: true })
    assert.equal((await app.request('/api/thing/41')).status, 404)
    assert.equal((await app.request('/api/thing/not-an-id')).status, 400)
    assert.equal((await app.request('/api/note/not-an-id')).status, 400)
  })

  test('single-record APIs expose the shared loaders\' exact moderated public truth', async () => {
    reset({
      scenario: 'public details',
      moderatedKindIds: [3],
      moderatedPlaceIds: [2],
      noteRemoved: true,
    })

    const place = await loadPublicPlaceRecord(2)
    const thing = await loadPublicThingRecord(41)
    const note = await loadPublicNoteRecord(51)
    assert.ok(place)
    assert.ok(thing)
    assert.ok(note)
    assert.equal(thing.kind, '[removed by maintainer]')
    assert.equal(note.body, '[removed by maintainer]')

    const placeResponse = await app.request('/api/place/2?view=outline')
    const thingResponse = await app.request('/api/thing/41')
    const noteResponse = await app.request('/api/note/51')
    assert.equal(placeResponse.status, 200)
    assert.equal(thingResponse.status, 200)
    assert.equal(noteResponse.status, 200)

    const placeBody = await placeResponse.json() as {
      place: Record<string, unknown> & { labels: unknown; laws: unknown }
    }
    const thingBody = await thingResponse.json() as { thing: Record<string, unknown> }
    const noteBody = await noteResponse.json() as { note: Record<string, unknown> }
    const { labels: _labels, laws: _laws, ...placeRecord } = placeBody.place
    assert.deepEqual(placeRecord, place)
    assert.deepEqual(thingBody.thing, thing)
    assert.deepEqual(noteBody.note, note)
    assert.equal(sqlCalls().some(call => /insert|update|delete/i.test(call.query ?? '')), false)

    reset({ scenario: 'public details', thingWithdrawn: true })
    assert.equal(await loadPublicThingRecord(41), null)
  })

  test('canonical window routes unfurl one current moderated public record', async () => {
    reset({ scenario: 'public details', moderatedKindIds: [3] })
    const thing = await app.request('/window/thing/41')
    assert.equal(thing.status, 200)
    assert.equal(thing.headers.get('cache-control'), 'no-store')
    const html = await thing.text()
    assert.match(html, /<link rel="canonical" href="https:\/\/1f3d9\.com\/window\/thing\/41">/u)
    assert.match(html, /<meta property="og:title" content="porch lantern · Thing #41 by tiny-lantern — 1F3D9">/u)
    assert.match(html, /<meta property="og:description" content="warm light">/u)
    assert.doesNotMatch(html, /1f3d9_(?:sk|at|rt|ac|rc)_/iu)

    reset({ scenario: 'public details', thingWithdrawn: true })
    const withdrawn = await app.request('/window/thing/41')
    assert.equal(withdrawn.status, 200)
    assert.match(await withdrawn.text(), /not publicly available now/iu)

    reset({ scenario: 'public details' })
    const view = await app.request('/window/happenings')
    assert.equal(view.status, 200)
    assert.match(await view.text(), /Recent public happenings — 1F3D9/u)
    assert.equal(sqlCalls().length, 0, 'a body-free view must not read a detail record')

    const image = await app.request('/share/thing.png')
    assert.equal(image.status, 200)
    assert.equal(image.headers.get('content-type'), 'image/png')
    assert.equal(image.headers.get('cross-origin-resource-policy'), 'cross-origin')
  })

  test('each place permission is independent and an allowed visitor owns what they build', async () => {
    reset({
      scenario: 'place permissions', actorId: 8, actorHandle: 'neighbor', placeOwnerId: 7,
      openToBuilding: true, openToThings: false, openToNotes: true,
    })
    const founded = await app.request('/api/place', {
      method: 'POST', headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({
        parent_id: 2,
        name: 'Neighbor Plot',
        description: 'mine',
        open_to_building: true,
        open_to_things: false,
        open_to_notes: true,
      }),
    })
    assert.equal(founded.status, 201)
    const placeBody = await founded.json() as {
      place: { owner: string; open_to_building: boolean; open_to_things: boolean; open_to_notes: boolean }
    }
    assert.equal(placeBody.place.owner, 'neighbor')
    assert.equal(placeBody.place.open_to_building, true)
    assert.equal(placeBody.place.open_to_things, false)
    assert.equal(placeBody.place.open_to_notes, true)
    assert.equal(networkCalled('base-rpc.test') || networkCalled('facilitator.test'), false)

    const thing = await app.request('/api/thing', {
      method: 'POST', headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ place_id: 2, name: 'uninvited box', body: '' }),
    })
    assert.equal(thing.status, 403)

    const note = await app.request('/api/note', {
      method: 'POST', headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ place_id: 2, body: 'hello from the square' }),
    })
    assert.equal(note.status, 201)
  })
}
