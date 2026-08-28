import { expect, test, type Page, type Request } from '@playwright/test'

function isWrite(request: Request): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(request.method())
}

const replayPlaces = [{ id: 1, parent_id: null, name: 'the world' },
  { id: 2, parent_id: 1, name: 'Cinder lane' },
  { id: 3, parent_id: 1, name: 'Harbor room' },
  { id: 4, parent_id: 3, name: 'Lantern nook' }]
const maximumReplayHandle = 'a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-aa'
const replayCrowd = Array.from({ length: 7 }, (_, index) => ({
  id: 20 + index,
  handle: `harbor-${index + 1}`,
}))
const replayThings = [20, 21, 22, 23, 24, 25, 26, 9].map(id => ({
  id,
  name: id === 9 ? 'field lantern' : `harbor keepsake ${id}`,
}))

function replayPlaceScopeIds(rootId: number) {
  return new Set(replayPlaces.filter(place => {
    if (place.id === rootId) return true
    let parentId: number | null = place.parent_id
    while (parentId !== null) {
      if (parentId === rootId) return true
      parentId = replayPlaces.find(candidate => candidate.id === parentId)?.parent_id ?? null
    }
    return false
  }).map(place => place.id))
}

function replayResidentRows(now: number, placeId: number) {
  return [{ id: 5, handle: 'map-walker', current_place_id: placeId,
    joined_at: new Date(now - 86_400_000).toISOString(), asleep: false },
  ...replayCrowd.map((resident, index) => ({
    ...resident,
    current_place_id: 3,
    joined_at: new Date(now - 86_400_000 - index).toISOString(),
    asleep: false,
  }))]
}

function replayThingRows(now: number, placeId: number) {
  return replayThings.map(thing => ({
    ...thing, place_id: thing.id === 9 ? 4 : placeId, body: 'a steady mark',
    maker_id: 5, made_by: 'map-walker', current_owner_id: 5,
    current_owner: 'map-walker', owner: 'map-walker', open_to_use: true,
    kind: 'lantern', traits: [], created_at: new Date(now - 120_000).toISOString(),
    moderated: false, kind_moderated: false,
  }))
}

function replaySnapshot(now: number, published: boolean, marker: string) {
  const residentPlaceId = published ? 4 : 2
  const thingPlaceId = published ? 3 : 2
  const residents = replayResidentRows(now, residentPlaceId)
  const things = replayThingRows(now, thingPlaceId)
  return {
    view: 'outline', change_marker: marker,
    places: [{
      id: 1, parent_id: null, name: 'the world', owner: null,
      purpose: '', front_matter: [], places: 3, things: 0, notes: 0,
      moderated: false, children: replayPlaces.filter(place => place.parent_id === 1).map(place => ({
        ...place, owner: place.id === 2 ? 'cinder-owner' : 'harbor-owner',
        purpose: '', front_matter: [], places: place.id === 3 ? 1 : 0,
        things: things.filter(thing => thing.place_id === place.id).length, notes: 0,
        moderated: false, children: place.id === 3 ? [{
          id: 4, parent_id: 3, name: 'Lantern nook', owner: 'harbor-owner',
          purpose: '', front_matter: [], places: 0,
          things: things.filter(thing => thing.place_id === 4).length, notes: 0,
          moderated: false, children: [],
        }] : [],
      })),
    }],
    // The ordinary outline is deliberately bounded. Live uses the compact
    // fixed survey for exact +N while one scoped named-card page loads.
    residents: residents.slice(0, 3),
    notes: [],
    things: things.slice(0, 2),
    agreements: [], events: [],
    totals: { places: 4, residents: residents.length, conversations: 0, things: 8,
      agreements: 0, events: published ? 6 : 0 },
    pages: {
      places: { has_more: false },
      residents: { has_more: true, next_before_id: residents[2]!.id },
      notes: { has_more: false }, things: { has_more: true, next_before_id: things[1]!.id },
      agreements: { has_more: false }, events: { has_more: false },
    },
    live_survey: replayPlaces.map(place => ({
      id: place.id,
      parent_id: place.parent_id,
      things: things.filter(thing => thing.place_id === place.id).length,
    })),
    refreshed_at: new Date(now).toISOString(),
  }
}

async function installReplayRoutes(
  page: Page,
  now: number,
  thingPaging: 'complete' | 'stale' | 'long' = 'complete',
  noteBurst = 0,
  controls: Readonly<{
    residentPaging?: 'complete' | 'long'
    openingPaging?: 'complete' | 'long'
    openingMarker?: string
    secondArrival?: boolean
    movementOnly?: boolean
    drawingDelayMs?: number
    openingDelayMs?: number
    residentDelayMs?: number
    thingDelayMs?: number
    useThingId?: number
    manyFocusInteractions?: boolean
    openingMovement?: boolean
    maximumHandle?: string
    staggeredArrivalDeadlines?: boolean
    holdThingPage?: boolean
    surveyTotalMismatch?: boolean
    coercibleSurveyThing?: false | null | '' | '0'
    thingFailure?: boolean
  }> = {},
) {
  let published = false
  let thingPageRequests = 0
  let residentPageRequests = 0
  let openingEventRequests = 0
  let windowRequests = 0
  let changeRequests = 0
  const openingBeforeIds: Array<string | null> = []
  const thingWithinPlaceIds: Array<string | null> = []
  const thingLimits: Array<string | null> = []
  let activeNoteRequests = 0
  let maximumNoteRequests = 0
  let activeDrawingRequests = 0
  let maximumDrawingRequests = 0
  let releaseHeldThingPage = () => {}
  const heldThingPage = new Promise<void>(resolve => {
    releaseHeldThingPage = resolve
  })
  const currentMarker = () => published ? controls.secondArrival ? '17' : '16' : '10'
  const controlledResidentRows = (marker: string) => replayResidentRows(
    now,
    marker === '10' ? controls.openingMovement ? 3 : 2 : 4,
  ).map(resident => {
    const placed = controls.secondArrival && resident.id === replayCrowd[0]!.id
      ? { ...resident, current_place_id: marker === '10' ? 2 : 4 }
      : resident
    return controls.maximumHandle && resident.id === replayCrowd[3]!.id
      ? { ...placed, handle: controls.maximumHandle }
      : placed
  })
  await page.route('**/api/window**', async route => {
    windowRequests += 1
    const url = new URL(route.request().url())
    if (url.searchParams.get('view') === 'directory') {
      await route.fulfill({ json: {
        view: 'directory', places: replayPlaces,
        residents: controlledResidentRows(currentMarker()).map(resident => ({
          id: resident.id, handle: resident.handle,
        })),
      } })
      return
    }
    const requested = url.searchParams.get('after_change_marker')
    const marker = requested ?? currentMarker()
    if (url.searchParams.get('collection') === 'things') {
      thingPageRequests += 1
      const withinPlaceId = url.searchParams.get('within_place_id')
      thingWithinPlaceIds.push(withinPlaceId)
      thingLimits.push(url.searchParams.get('limit'))
      if (controls.holdThingPage) await heldThingPage
      if (controls.thingDelayMs) {
        await new Promise(resolve => setTimeout(resolve, controls.thingDelayMs))
      }
      if (controls.thingFailure) {
        await route.fulfill({ status: 503, json: { error: 'named things unavailable' } })
        return
      }
      if (thingPaging !== 'complete') {
        if (thingPaging === 'stale' && thingPageRequests <= 2) {
          const [thing] = replayThingRows(now, 2).filter(candidate => candidate.id === 9)
          await route.fulfill({ json: {
            change_marker: marker, things: [thing], total: replayThings.length,
            has_more: true, next_before_id: 9,
          } })
          return
        }
        if (thingPaging === 'long' && thingPageRequests <= 8) {
          const [template] = replayThingRows(now, 2)
          const id = 101 - thingPageRequests
          await route.fulfill({ json: {
            change_marker: marker, things: [{ ...template, id, name: `paged thing ${id}` }],
            total: 100, has_more: true, next_before_id: id,
          } })
          return
        }
        await route.fulfill({ status: 503, json: { error: 'test request limit reached' } })
        return
      }
      const placeId = marker === '10' ? 2 : 3
      const scope = replayPlaceScopeIds(Number(withinPlaceId))
      const things = replayThingRows(now, placeId)
        .filter(thing => scope.has(thing.place_id))
      await route.fulfill({ json: {
        change_marker: marker,
        things,
        total: things.length,
        has_more: false,
        next_before_id: null,
      } })
      return
    }
    const baseSnapshot = replaySnapshot(now, marker !== '10', marker)
    const surveyedSnapshot = controls.surveyTotalMismatch
      ? {
          ...baseSnapshot,
          live_survey: baseSnapshot.live_survey.map(place => place.id === 2
            ? { ...place, things: Math.max(0, place.things - 1) }
            : place),
        }
      : baseSnapshot
    const snapshot = Object.hasOwn(controls, 'coercibleSurveyThing')
      ? {
          ...surveyedSnapshot,
          live_survey: surveyedSnapshot.live_survey.map(place => place.id === 1
            ? { ...place, things: controls.coercibleSurveyThing }
            : place),
        }
      : surveyedSnapshot
    const residents = controlledResidentRows(marker)
    await route.fulfill({ json: {
      ...snapshot,
      residents: residents.slice(0, 3),
      totals: { ...snapshot.totals, residents: residents.length },
      pages: {
        ...snapshot.pages,
        residents: {
          has_more: true,
          next_before_id: residents[2]!.id,
        },
      },
    } })
  })
  await page.route('**/api/changes**', async route => {
    changeRequests += 1
    const since = new URL(route.request().url()).searchParams.get('since')
    if (since === null) {
      await route.fulfill({ json: { change_marker: currentMarker() } })
      return
    }
    if (since === '10' && published) {
      const publishedMarker = currentMarker()
      await route.fulfill({ json: {
        change_marker: publishedMarker, unchanged: false, has_more: false,
        next_since: publishedMarker,
        changes: [{
          change_id: '11', created_at: new Date(now - (
            controls.staggeredArrivalDeadlines ? 1_792_300 : 0
          )).toISOString(), kind: 'action',
          actor: 'map-walker', detail: {
            action: 'move', status: 'applied', from_place_id: 2, to_place_id: 4,
          },
        }, ...(controls.movementOnly ? [] : [{
          change_id: '12', created_at: new Date(now).toISOString(), kind: 'note',
          actor: 'map-walker', detail: { place_id: 3, note_id: 77 },
        }, {
          change_id: '13', created_at: new Date(now).toISOString(), kind: 'note',
          actor: 'map-walker', detail: { place_id: 3, note_id: 78 },
        }, {
          change_id: '14', created_at: new Date(now).toISOString(), kind: 'action',
          actor: 'map-walker', detail: {
            action: 'use', status: 'applied',
            place_id: controls.useThingId ? 3 : 4,
            source_thing_id: controls.useThingId ?? 9,
          },
        }, {
          change_id: '15', created_at: new Date(now).toISOString(), kind: 'action',
          actor: 'map-walker', detail: {
            action: 'move', from_place_id: 3, to_place_id: 2,
          },
        }, {
          change_id: '16', created_at: new Date(now - 600_001).toISOString(), kind: 'note',
          actor: 'map-walker', detail: { place_id: 3, note_id: 79 },
        }]), ...(controls.secondArrival ? [{
          change_id: '17', created_at: new Date(now).toISOString(), kind: 'action',
          actor: replayCrowd[0]!.handle, detail: {
            action: 'move', status: 'applied', from_place_id: 2, to_place_id: 4,
          },
        }] : [])],
      } })
      return
    }
    await route.fulfill({ json: {
      change_marker: currentMarker(), unchanged: true, has_more: false,
      next_since: currentMarker(), changes: [],
    } })
  })
  await page.route('**/api/events**', async route => {
    openingEventRequests += 1
    openingBeforeIds.push(new URL(route.request().url()).searchParams.get('before_id'))
    if (controls.openingDelayMs) {
      await new Promise(resolve => setTimeout(resolve, controls.openingDelayMs))
    }
    if (controls.openingPaging === 'long') {
      if (openingEventRequests <= 8) {
        const id = 901 - openingEventRequests
        await route.fulfill({ json: {
          change_marker: controls.openingMarker ?? currentMarker(),
          has_more: true, next_before_id: id,
          events: [{
            id, change_id: String(11 - openingEventRequests),
            at: new Date(now - openingEventRequests).toISOString(), kind: 'action',
            actor: 'history-walker', detail: {
              action: 'move', status: 'applied', from_place_id: 2, to_place_id: 3,
            },
          }],
        } })
        return
      }
      if (openingEventRequests === 9) {
        await route.fulfill({ json: {
          change_marker: controls.openingMarker ?? currentMarker(),
          has_more: false, next_before_id: null,
          events: [{
            id: 892, change_id: '2', at: new Date(now - 9).toISOString(), kind: 'action',
            actor: 'history-walker', detail: {
              action: 'move', status: 'applied', from_place_id: 2, to_place_id: 3,
            },
          }],
        } })
        return
      }
      await route.fulfill({ status: 503, json: { error: 'test request limit reached' } })
      return
    }
    await route.fulfill({ json: {
      change_marker: currentMarker(), has_more: false, next_before_id: null,
      events: noteBurst ? Array.from({ length: noteBurst }, (_, index) => ({
        id: 300 + index, change_id: String(index + 1),
        at: new Date(now - index).toISOString(), kind: 'note',
        actor: `burst-${index + 1}`,
        detail: { place_id: 3, note_id: 1_000 + index },
      })) : controls.manyFocusInteractions ? [
        ...replayCrowd.map((resident, index) => ({
          id: 400 + index, change_id: String(index + 2),
          at: new Date(now - 30_000 - index).toISOString(), kind: 'transfer',
          actor: index === 0 ? resident.handle : 'map-walker', detail: {
            transfer_id: 100 + index, asset_type: 'thing', asset_id: replayThings[index]!.id,
            resident_id: index === 0 ? 5 : resident.id, place_id: 3,
          },
        })),
        {
          id: 408, change_id: '9', at: new Date(now - 29_000).toISOString(), kind: 'action',
          actor: 'map-walker', detail: {
            action: 'use', status: 'applied', place_id: 3, source_thing_id: 90,
          },
        },
        {
          id: 409, change_id: '10', at: new Date(now - 28_000).toISOString(),
          kind: 'thing_created', actor: 'map-walker', detail: { thing_id: 91, place_id: 3 },
        },
        {
          id: 399, change_id: '1', at: new Date(now - 30_000).toISOString(), kind: 'note',
          actor: controls.maximumHandle ?? replayCrowd[3]!.handle,
          detail: { place_id: 3, note_id: 77 },
        },
      ] : controls.openingMovement ? [{
        id: 398, change_id: '9', at: new Date(now - 120_000).toISOString(), kind: 'action',
        actor: 'map-walker', detail: {
          action: 'move', status: 'applied', from_place_id: 2, to_place_id: 3,
        },
      }] : [{
        id: 99, change_id: '9', at: new Date(now - 30_000).toISOString(), kind: 'transfer',
        actor: 'map-walker', detail: {
          transfer_id: 44, asset_type: 'thing', asset_id: 26,
          resident_id: replayCrowd.at(-1)!.id, place_id: 2,
        },
      }],
    } })
  })
  await page.route('**/api/residents**', async route => {
    residentPageRequests += 1
    const url = new URL(route.request().url())
    const marker = url.searchParams.get('after_change_marker') ?? currentMarker()
    if (controls.residentDelayMs) {
      await new Promise(resolve => setTimeout(resolve, controls.residentDelayMs))
    }
    if (controls.residentPaging === 'long') {
      if (residentPageRequests <= 8) {
        const id = 20 - residentPageRequests
        await route.fulfill({ json: {
          change_marker: marker,
          residents: [{
            id, handle: `paged-${id}`, current_place_id: 2,
            joined_at: new Date(now - 172_800_000 - residentPageRequests * 1_000).toISOString(),
            asleep: false,
          }],
          total: 2_000, has_more: true, next_before_id: id,
        } })
        return
      }
      await route.fulfill({ status: 503, json: { error: 'test request limit reached' } })
      return
    }
    const residents = controlledResidentRows(marker)
    const requestedCursor = url.searchParams.get('before_id')
    await route.fulfill({ json: {
      change_marker: marker,
      residents: requestedCursor ? residents.slice(3) : residents,
      total: residents.length, has_more: false, next_before_id: null,
    } })
  })
  await page.route('**/api/note/77', route => route.fulfill({ json: {
    note: { id: 77, body: 'Earlier line\nEarlier detail stays in the ledger.' },
  } }))
  await page.route('**/api/note/78', route => route.fulfill({ json: {
    note: { id: 78, body: 'L'.repeat(61) + '\nLatest detail stays in the ledger.' },
  } }))
  await page.route('**/api/note/79', route => route.fulfill({ json: {
    note: { id: 79, body: 'Too old to replay' },
  } }))
  for (let index = 0; index < noteBurst; index += 1) {
    const noteId = 1_000 + index
    await page.route(`**/api/note/${noteId}`, async route => {
      activeNoteRequests += 1
      maximumNoteRequests = Math.max(maximumNoteRequests, activeNoteRequests)
      await new Promise(resolve => setTimeout(resolve, 80))
      activeNoteRequests -= 1
      await route.fulfill({ json: { note: { id: noteId, body: `burst note ${noteId}` } } })
    })
  }
  await page.route('**/api/drawing/**', async route => {
    const match = /^\/api\/drawing\/(place|resident|thing)\/(\d+)$/u.exec(
      new URL(route.request().url()).pathname,
    )
    if (!match) {
      await route.fulfill({ status: 404, json: { error: 'drawing not found' } })
      return
    }
    activeDrawingRequests += 1
    maximumDrawingRequests = Math.max(maximumDrawingRequests, activeDrawingRequests)
    try {
      if (controls.drawingDelayMs) {
        await new Promise(resolve => setTimeout(resolve, controls.drawingDelayMs))
      }
      await route.fulfill({ json: {
        type: match[1], id: Number(match[2]), source: null, drawing: null,
      } })
    } finally {
      activeDrawingRequests -= 1
    }
  })
  return {
    publish: () => { published = true },
    thingPageRequests: () => thingPageRequests,
    thingWithinPlaceIds: () => [...thingWithinPlaceIds],
    thingLimits: () => [...thingLimits],
    residentPageRequests: () => residentPageRequests,
    openingEventRequests: () => openingEventRequests,
    openingBeforeIds: () => [...openingBeforeIds],
    windowRequests: () => windowRequests,
    changeRequests: () => changeRequests,
    activeNoteRequests: () => activeNoteRequests,
    maximumNoteRequests: () => maximumNoteRequests,
    activeDrawingRequests: () => activeDrawingRequests,
    maximumDrawingRequests: () => maximumDrawingRequests,
    releaseHeldThingPage,
  }
}

test('Live paints exact surveyed counts and Focus ids while named thing cards load', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    holdThingPage: true,
    manyFocusInteractions: true,
  })
  try {
    await page.goto('/window#view=live')
    await expect.poll(fixture.thingPageRequests).toBe(1)
    expect(fixture.thingWithinPlaceIds()).toEqual(['1'])
    expect(fixture.thingLimits()).toEqual(['50'])

    await expect(page.locator('#live-plates .live-plot')).toHaveCount(2)
    await expect(page.locator('.live-plot[data-place-id="2"] .live-thing-more'))
      .toHaveText('+5 more')
    await expect(page.locator('.live-plot[data-place-id="2"] .live-thing-more'))
      .toHaveAttribute('data-live-overflow-count', '5')
    await expect(page.locator('#live-history-status')).toContainText(
      'Exact +N thing counts come from the fixed survey while newest named cards load',
    )

    await expect(page.locator('#live-history-status')).toContainText('history is complete')
    await page.locator('[data-live-resident-handle="map-walker"]').first().click()
    await expect(page.locator('#live-focus-status')).toContainText('Focused on map-walker')
    await expect(page.locator('#live-focus-interactions [data-live-focus-thing]')).toHaveCount(9)
    await expect(page.locator('#live-focus-interactions [data-live-focus-thing="23"]'))
      .toContainText('Thing #23 · recorded in Harbor room')
    await expect(page.locator('#live-focus-interactions [data-live-focus-thing="90"]'))
      .toContainText('Thing #90 · recorded in Harbor room')
    await expect(page.locator('#live-focus-interactions [data-live-focus-thing="91"]'))
      .toContainText('Thing #91 · recorded in Harbor room')
  } finally {
    fixture.releaseHeldThingPage()
  }

  await expect(page.locator('.live-plot[data-place-id="2"] .live-thing-more'))
    .toHaveText('+2 more')
  await expect(page.locator('#live-focus-status')).toContainText('Focused on map-walker')
  await expect(page.locator('#live-focus-interactions [data-live-focus-thing="23"]'))
    .toContainText('harbor keepsake 23 · now in Cinder lane · recorded in Harbor room')

  await page.locator('[data-place-id="3"] .live-plot-open').click()
  await expect.poll(fixture.thingPageRequests).toBe(2)
  expect(fixture.thingWithinPlaceIds()).toEqual(['1', '3'])
  expect(fixture.thingLimits()).toEqual(['50', '50'])
  await expect(page.locator('#live-focus-interactions [data-live-focus-thing]')).toHaveCount(9)
  await expect(page.locator('#live-focus-interactions [data-live-focus-thing="23"]'))
    .toContainText('Thing #23 · recorded in Harbor room')
  await expect(page.locator('#live-focus-interactions [data-live-focus-thing="90"]'))
    .toContainText('Thing #90 · recorded in Harbor room')
  await expect(page.locator('#live-focus-interactions [data-live-focus-thing="91"]'))
    .toContainText('Thing #91 · recorded in Harbor room')
})

test('Live refuses exact thing badges when the fixed survey disagrees', async ({ page }) => {
  await installReplayRoutes(page, Date.now(), 'complete', 0, {
    surveyTotalMismatch: true,
  })
  await page.goto('/window#view=live')

  await expect(page.locator('#live-plates .live-plot')).toHaveCount(2)
  await expect(page.locator('#live-history-status')).toContainText(
    'Exact +N thing counts are unavailable',
  )
  await expect(page.locator('.live-thing-more')).toContainText('count unavailable')
  await expect(page.locator('.live-thing-more[data-live-overflow-count]')).toHaveCount(0)
})

test('Live rejects a coercible nonnumeric survey count instead of printing exact badges', async ({ page }) => {
  await installReplayRoutes(page, Date.now(), 'complete', 0, {
    coercibleSurveyThing: false,
  })
  await page.goto('/window#view=live')

  await expect(page.getByRole('button', { name: 'Retry reading the public city view' }))
    .toBeVisible()
  await expect(page.locator('#live-plates')).toContainText(
    'The current public city view could not be read.',
  )
  await expect(page.locator('.live-thing-more[data-live-overflow-count]')).toHaveCount(0)
})

test('Live keeps exact surveyed counts when newest thing names fail', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    thingFailure: true,
  })
  await page.goto('/window#view=live')

  await expect(page.locator('#live-plates .live-plot')).toHaveCount(2)
  await expect(page.locator('.live-plot[data-place-id="2"] .live-thing-more'))
    .toHaveText('+5 more')
  await expect(page.locator('#live-history-status')).toContainText(
    'Exact +N thing counts stay verified, but newest named thing cards could not be read',
  )
  await page.getByRole('button', { name: 'Retry named thing cards' }).click()
  await expect.poll(fixture.thingPageRequests).toBe(2)
  await expect(page.locator('.live-plot[data-place-id="2"] .live-thing-more'))
    .toHaveText('+5 more')
})

test('Live does not chase a repeated cursor after its bounded named thing page', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'stale')
  await page.goto('/window#view=live')

  await expect(page.locator('#live-plates .live-plot')).toHaveCount(2)
  await expect(page.locator('#live-history-status')).toContainText('one-page limit of 50')
  await expect.poll(fixture.thingPageRequests).toBe(1)
  await page.waitForTimeout(250)
  expect(fixture.thingPageRequests()).toBe(1)
})

test('Live stops after one named thing page while the fixed survey keeps exact counts', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'long')
  await page.goto('/window#view=live')

  await expect(page.locator('#live-plates .live-plot')).toHaveCount(2)
  await expect(page.locator('#live-history-status')).toContainText(
    'exact +N includes every other public thing in this plate',
  )
  await expect.poll(fixture.thingPageRequests).toBe(1)
  await page.waitForTimeout(250)
  expect(fixture.thingPageRequests()).toBe(1)
})

test('Live pauses automatic resident paging after eight valid pages', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    residentPaging: 'long',
  })
  await page.goto('/window#view=live')

  await expect(page.locator('#live-plates')).toContainText(
    'Automatic census reading pauses after 1,600 public residents',
  )
  await expect(page.getByRole('button', { name: 'Continue the exact resident census' }))
    .toBeVisible()
  await expect.poll(fixture.residentPageRequests).toBe(8)
})

test('Live pauses automatic opening-history paging after eight valid pages', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    openingPaging: 'long',
  })
  await page.goto('/window#view=live')

  await expect(page.locator('#live-history-status')).toContainText(
    'Automatic recent-history reading pauses after 1,600 public events',
  )
  await expect(page.getByRole('button', { name: 'Continue recent history' })).toBeVisible()
  await expect.poll(fixture.openingEventRequests).toBe(8)
  await page.getByRole('button', { name: 'Continue recent history' }).click()
  await expect.poll(fixture.openingEventRequests).toBe(9)
  expect(fixture.openingBeforeIds().at(-1)).toBe('893')
  await expect(page.locator('#live-history-status')).toContainText(
    'Recent history is complete through the 30-minute trace edge',
  )
})

test('Live does not continue resident census reads while hidden and resumes when visible', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    residentPaging: 'long', residentDelayMs: 500,
  })
  await page.goto('/window#view=live')
  await expect.poll(fixture.residentPageRequests).toBe(1)

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(650)
  expect(fixture.residentPageRequests()).toBe(1)

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(fixture.residentPageRequests).toBeGreaterThan(1)
})

test('Live does not continue opening-history reads while hidden and resumes when visible', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    openingPaging: 'long', openingMarker: '12', openingDelayMs: 500,
  })
  await page.goto('/window#view=live')
  await expect.poll(fixture.openingEventRequests).toBe(1)

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const hiddenReadCounts = {
    windows: fixture.windowRequests(),
    changes: fixture.changeRequests(),
  }
  await page.waitForTimeout(650)
  expect(fixture.openingEventRequests()).toBe(1)
  expect({
    windows: fixture.windowRequests(),
    changes: fixture.changeRequests(),
  }).toEqual(hiddenReadCounts)

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(fixture.openingEventRequests).toBeGreaterThan(1)
})

test('Live finishes one named thing page while hidden and does not start another', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'long', 0, {
    thingDelayMs: 500,
  })
  await page.goto('/window#view=live')
  await expect.poll(fixture.thingPageRequests).toBe(1)

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(650)
  expect(fixture.thingPageRequests()).toBe(1)

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(650)
  expect(fixture.thingPageRequests()).toBe(1)
})

test('Live bounds concurrent note detail reads during a visible burst', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 8)
  await page.goto('/window#view=live')

  await expect(page.locator('#live-ledger')).toContainText('note #1000')
  await expect.poll(fixture.activeNoteRequests).toBe(0)
  expect(fixture.maximumNoteRequests()).toBeGreaterThan(0)
  expect(fixture.maximumNoteRequests()).toBeLessThanOrEqual(4)
})

test('Live bounds concurrent drawing reads during a visible plate render', async ({ page }) => {
  const fixture = await installReplayRoutes(page, Date.now(), 'complete', 0, {
    drawingDelayMs: 80,
  })
  await page.goto('/window#view=live')

  await expect.poll(fixture.maximumDrawingRequests).toBeGreaterThan(0)
  await expect.poll(fixture.activeDrawingRequests).toBe(0)
  expect(fixture.maximumDrawingRequests()).toBeLessThanOrEqual(4)
})

test('new change rows replay once in recorded order and leave truthful residue', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now)
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  fixture.publish()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  const replay = page.locator('.live-replay-portrait')
  await expect(replay).toHaveCount(1)
  await expect(replay).toHaveAttribute('data-live-replay-key', 'change:11')
  const duration = Number(await replay.getAttribute('data-replay-duration'))
  expect(duration).toBeGreaterThanOrEqual(3_200)
  expect(duration).toBeLessThanOrEqual(8_000)
  const trail = page.locator('.live-trail')
  await expect(trail).toHaveCount(1)
  await expect(page.locator('.live-footnote-mark')).toHaveCount(0)
  await expect(page.locator('.live-speech-bubble')).toHaveCount(0)
  await expect(page.locator('.live-thing-specimen.live-pulse')).toHaveCount(0)
  const start = await replay.evaluate((node, line) => ({
    left: Number.parseFloat((node as HTMLElement).style.left),
    top: Number.parseFloat((node as HTMLElement).style.top),
    x1: Number(line.getAttribute('x1')),
    y1: Number(line.getAttribute('y1')),
  }), await trail.elementHandle())
  expect(Math.abs(start.left - start.x1)).toBeLessThan(1)
  expect(Math.abs(start.top - start.y1)).toBeLessThan(1)

  const replayPosition = () => replay.evaluate(node => {
    const stage = node.closest('.live-stage') as HTMLElement
    const ground = stage.getBoundingClientRect()
    const box = node.getBoundingClientRect()
    const scale = ground.width / Number(stage.dataset.liveStageWidth)
    return {
      x: (box.left + box.width / 2 - ground.left) / scale,
      y: (box.bottom - ground.top) / scale,
    }
  })
  const minimumX = Math.min(start.x1, Number(await trail.getAttribute('x2')))
  const maximumX = Math.max(start.x1, Number(await trail.getAttribute('x2')))
  await expect.poll(async () => (await replayPosition()).x, { timeout: duration })
    .toBeGreaterThan(minimumX + (maximumX - minimumX) * 0.2)
  const midpoint = await replayPosition()
  expect(midpoint.x).toBeGreaterThan(minimumX)
  expect(midpoint.x).toBeLessThan(maximumX)
  expect(midpoint.y).toBeGreaterThan(0)

  await page.clock.fastForward(duration + 1)
  const absorbedResidents = page.locator('[data-place-id="3"] .live-resident-more')
  await expect(absorbedResidents).toHaveText('+4 more')
  await expect(absorbedResidents).toHaveClass(/live-overflow-absorbing/u)
  await expect(absorbedResidents).toHaveAttribute('data-live-overflow-count', '4')
  await expect(absorbedResidents).toHaveCSS('opacity', '1')
  const thingOverflow = page.locator('[data-place-id="3"] .live-thing-more')
  await expect(thingOverflow).toHaveText('+3 more')
  await expect(thingOverflow).toHaveAttribute('data-live-overflow-count', '3')
  await expect(page.locator('.live-footnote-mark')).toHaveCount(1)
  await expect(page.locator('.live-speech-bubble')).toHaveText('Earlier line')
  await expect(page.locator('.live-thing-specimen.live-pulse')).toHaveCount(0)

  await page.clock.fastForward(651)
  await expect(page.locator('.live-footnote-mark')).toHaveCount(2)
  await expect(page.locator('.live-speech-bubble')).toHaveText('L'.repeat(59) + '…')
  await expect(page.locator('.live-speech-bubble')).toHaveCount(1)
  await expect(page.locator('#live-ledger')).toContainText('Latest detail stays in the ledger.')

  await page.clock.fastForward(651)
  const pulsedThing = page.locator('.live-thing-specimen.live-pulse')
  await expect(pulsedThing).toHaveCount(0)
  await expect(page.locator('[data-place-id="3"] [data-live-thing-id="9"]')).toHaveCount(0)
  await expect(page.locator('.live-action-mark')).toHaveCount(0)

  await page.clock.fastForward(600)
  await expect(replay).toHaveCount(0)
  await expect(page.locator('.live-thing-specimen.live-pulse')).toHaveCount(0)
  await expect(trail).toHaveCount(1)
  const settledWalker = page.locator(
    '[data-place-id="3"] [data-live-resident-handle="map-walker"]',
  ).first()
  const settledPoint = await settledWalker.evaluate(node => {
    const shell = node.closest('.live-walker') as HTMLElement
    const stage = node.closest('.live-stage') as HTMLElement
    const ground = stage.getBoundingClientRect()
    const box = shell.getBoundingClientRect()
    const scale = ground.width / Number(stage.dataset.liveStageWidth)
    return {
      x: (box.left + box.width / 2 - ground.left) / scale,
      y: (box.bottom - ground.top) / scale,
    }
  })
  expect(Math.abs(settledPoint.x - Number(await trail.getAttribute('x2')))).toBeLessThan(1)
  expect(Math.abs(settledPoint.y - Number(await trail.getAttribute('y2')))).toBeLessThan(1)
  await expect(page.locator('.live-footnote-mark')).toHaveCount(2)
  await expect(page.locator('#live-ledger')).not.toContainText('Too old to replay')
  await expect(page.locator('#live-ledger')).not.toContainText('moved: Harbor room → Cinder lane')
  const platePortrait = page.locator('#live-plates [data-live-resident-handle="map-walker"]')
  await expect(platePortrait).toHaveAccessibleName(/map-walker/u)
  await expect(platePortrait).not.toHaveAccessibleName(/Earlier|L{10}/u)

  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await page.clock.fastForward(100)
  await expect(replay).toHaveCount(0)
  await expect(page.locator('.live-thing-specimen.live-pulse')).toHaveCount(0)
  await expect(trail).toHaveCount(1)
  await page.clock.fastForward(600_001)
  await expect(page.locator('.live-footnote-mark')).toHaveCount(0)
  await expect(page.locator('.live-speech-bubble')).toHaveCount(0)
  await expect(trail).toHaveCount(0)
})

test('two arrivals into one crowded plot settle on their own trail endpoints', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    secondArrival: true,
    movementOnly: true,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect(page.locator('#live-plates .live-walker')).toHaveCount(8)

  fixture.publish()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  const replays = page.locator('.live-replay-portrait[data-replay-duration]')
  await expect(replays).toHaveCount(2)
  const durations = await replays.evaluateAll(nodes => nodes.map(node =>
    Number((node as HTMLElement).dataset.replayDuration)))
  expect(durations.every(duration => duration >= 3_200 && duration <= 8_000)).toBe(true)
  await page.clock.runFor(9_000)
  await expect(replays).toHaveCount(0)

  for (const handle of ['map-walker', replayCrowd[0]!.handle]) {
    const walker = page.locator(
      `[data-place-id="3"] [data-live-resident-handle="${handle}"]`,
    ).first()
    const trail = page.locator(`.live-trail[aria-label^="${handle} moved"]`)
    await expect(walker).toHaveCount(1)
    await expect(trail).toHaveCount(1)
    const point = await walker.evaluate(node => {
      const shell = node.closest('.live-walker') as HTMLElement
      const stage = node.closest('.live-stage') as HTMLElement
      const ground = stage.getBoundingClientRect()
      const box = shell.getBoundingClientRect()
      const scale = ground.width / Number(stage.dataset.liveStageWidth)
      return {
        x: (box.left + box.width / 2 - ground.left) / scale,
        y: (box.bottom - ground.top) / scale,
      }
    })
    expect(Math.abs(point.x - Number(await trail.getAttribute('x2')))).toBeLessThan(1)
    expect(Math.abs(point.y - Number(await trail.getAttribute('y2')))).toBeLessThan(1)
  }
})

test('a later crowded arrival keeps its full absorption window', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now, 'complete', 0, {
    secondArrival: true,
    movementOnly: true,
    staggeredArrivalDeadlines: true,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect(page.locator('#live-plates .live-walker')).toHaveCount(8)

  fixture.publish()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  const replays = page.locator('.live-replay-portrait[data-replay-duration]')
  let durations: number[] = []
  await expect.poll(async () => {
    durations = await replays.evaluateAll(nodes => nodes.map(node =>
      Number((node as HTMLElement).dataset.replayDuration)))
    return durations.length
  }).toBe(2)
  const [firstDuration, lastDuration] = [...durations].sort((left, right) => left - right)
  expect(lastDuration).toBe(8_000)
  expect(lastDuration! - firstDuration!).toBeGreaterThanOrEqual(400)
  expect(lastDuration! - firstDuration!).toBeLessThan(900)

  await page.clock.runFor(lastDuration! + 1)
  const absorptionBadge = page.locator('[data-place-id="3"] .live-resident-more')
  await expect(absorptionBadge).toHaveClass(/live-overflow-absorbing/u)
  await page.clock.runFor(450)
  await expect(absorptionBadge).toHaveClass(/live-overflow-absorbing/u)
  await page.clock.runFor(450)
  await expect(absorptionBadge).not.toHaveClass(/live-overflow-absorbing/u)
})

test('focused use pulses the exact pinned nested thing', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now)
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await page.locator('[data-live-resident-handle="map-walker"]').first().click()

  fixture.publish()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  const replay = page.locator('.live-replay-portrait')
  await expect(replay).toHaveAttribute('data-live-replay-key', 'change:11')
  await page.clock.runFor(9_500)
  await expect(replay).toHaveAttribute('data-live-replay-key', 'change:14')
  const pinnedThing = page.locator('[data-place-id="3"] [data-live-thing-id="9"]')
  await expect(pinnedThing).toHaveAttribute('data-live-focus-thing', '9')
  await expect(pinnedThing).toHaveClass(/live-pulse/u)
})

test('an unshown sixth thing never consumes visible replay time', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now, 'complete', 0, { useThingId: 21 })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  fixture.publish()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(page.locator('[data-place-id="3"] .live-thing-more')).toHaveText('+3 more')
  await expect(page.locator('[data-place-id="3"] [data-live-thing-id="21"]')).toHaveCount(0)
  const movement = page.locator('.live-replay-portrait[data-live-replay-key="change:11"]')
  const movementDuration = Number(await movement.getAttribute('data-replay-duration'))
  await page.clock.runFor(movementDuration + 1 + 650 + 1 + 650 + 1)
  await expect(page.locator('.live-replay-portrait[data-live-replay-key="change:14"]'))
    .toHaveCount(0)
  await expect(page.locator('#live-ledger')).toContainText('used thing #21')
})

test('focus keeps every exact interaction visible outside finite plate slots', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  await installReplayRoutes(page, now, 'complete', 0, {
    manyFocusInteractions: true,
    maximumHandle: maximumReplayHandle,
  })
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  await page.locator('[data-live-resident-handle="map-walker"]').first().click()
  await expect(page.locator('#live-roster [data-live-focus-partner]')).toHaveCount(7)
  await expect(page.locator('#live-focus-interactions [data-live-focus-thing]')).toHaveCount(9)
  const thingIds = await page.locator('#live-focus-interactions [data-live-focus-thing]')
    .evaluateAll(nodes => nodes.map(node => Number((node as HTMLElement).dataset.liveFocusThing)))
  expect([...thingIds].sort((left, right) => left - right))
    .toEqual([20, 21, 22, 23, 24, 25, 26, 90, 91])
  await expect(page.locator('#live-focus-interactions [data-live-focus-thing="90"]'))
    .toContainText('Thing #90 · recorded in Harbor room')
  await expect(page.locator('#live-focus-interactions [data-live-focus-thing="91"]'))
    .toContainText('Thing #91 · recorded in Harbor room')
  const focusedThingLink = page.locator(
    '#live-focus-interactions [data-live-focus-thing="21"]',
  )
  await focusedThingLink.focus()
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await expect(focusedThingLink).toBeFocused()

  const plotWalkersOverlap = await page.locator('[data-place-id="3"] .live-walker')
    .evaluateAll(nodes => nodes.some((node, index) => {
      const first = node.getBoundingClientRect()
      return nodes.slice(index + 1).some(other => {
        const second = other.getBoundingClientRect()
        return first.left < second.right && first.right > second.left &&
          first.top < second.bottom && first.bottom > second.top
      })
    }))
  expect(plotWalkersOverlap).toBe(false)

  await page.locator('[data-place-id="3"] .live-plot-open').click()
  const rootWalkersOverlap = await page.locator('.live-root-walkers .live-walker')
    .evaluateAll(nodes => nodes.some((node, index) => {
      const first = node.getBoundingClientRect()
      return nodes.slice(index + 1).some(other => {
        const second = other.getBoundingClientRect()
        return first.left < second.right && first.right > second.left &&
          first.top < second.bottom && first.bottom > second.top
      })
    }))
  expect(rootWalkersOverlap).toBe(false)
  const maximumHandleName = page.locator(
    `.live-root-walkers [data-live-resident-handle="${maximumReplayHandle}"] .live-portrait-name`,
  )
  await expect(maximumHandleName).toHaveCSS('white-space', 'nowrap')
  const maximumHandleShellHeight = await maximumHandleName.evaluate(node =>
    node.closest('.live-walker')!.getBoundingClientRect().height)
  const shortHandleShellHeight = await page.locator(
    '.live-root-walkers [data-live-resident-handle="harbor-5"] .live-portrait-name',
  ).evaluate(node => node.closest('.live-walker')!.getBoundingClientRect().height)
  expect(Math.abs(maximumHandleShellHeight - shortHandleShellHeight)).toBeLessThanOrEqual(1)
  const rootBubbleBounds = await page.locator('.live-root-walkers .live-speech-bubble')
    .first().evaluate(node => {
      const bubble = node.getBoundingClientRect()
      const viewport = document.querySelector('#live-viewport')!.getBoundingClientRect()
      return {
        top: bubble.top >= viewport.top - 1,
        bottom: bubble.bottom <= viewport.bottom + 1,
      }
    })
  expect(rootBubbleBounds).toEqual({ top: true, bottom: true })

  await page.locator('#resident-filter').selectOption('harbor-7')
  await expect(page.locator('#live-focus-status')).toContainText('No resident focused')
  expect(await page.evaluate(() => localStorage.getItem('1f3d9:window:live-focus'))).toBeNull()
  await page.locator('[data-live-resident-handle="harbor-7"]').first().click()
  await expect(page.locator('#live-focus-status')).toContainText('Focused on harbor-7')
  await expect(page).toHaveURL(/\/window\/live\?place=3$/u)
})

test('focus keeps a truthful specimen visible after its resident leaves the drilled plate', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now)
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  await page.locator('.live-plot[data-place-id="2"] .live-plot-open').click()
  await page.locator('[data-live-resident-handle="map-walker"]').first().click()
  fixture.publish()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))

  await expect(page.locator('#live-focus-status')).toContainText('Focused on map-walker')
  const outsideFocus = page.locator(
    '#live-focus-interactions [data-live-focus-resident="map-walker"]' +
    '[data-live-resident-scope="outside"]',
  )
  await expect(outsideFocus).toContainText('Outside this plate · Lantern nook')
  await expect(page.locator('#live-plates [data-live-focus-resident="map-walker"]')).toHaveCount(0)
  await expect(page).toHaveURL(/\/window\/live\?place=2$/u)
})

test('resident focus persists locally, pins exact interactions, and camera zoom stays viewer-only', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now)
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  const walker = page.locator('[data-live-resident-handle="map-walker"]').first()
  await walker.click()
  await expect(page.locator('#live-focus-status')).toContainText('map-walker')
  await expect(page.locator(
    '#live-plates [data-live-focus-resident="map-walker"]',
  )).toHaveCount(1)
  await expect(page.locator(
    '#live-roster [data-live-focus-resident="map-walker"]',
  )).toHaveCount(1)
  const interactionPartner = page.locator(
    '#live-plates [data-live-focus-partner="harbor-7"]',
  )
  await expect(interactionPartner).toHaveCount(1)
  await expect(page.locator(
    '#live-roster [data-live-focus-partner="harbor-7"]',
  )).toHaveCount(1)
  await expect(page.locator(
    '[data-place-id="2"] [data-live-focus-thing="26"]',
  )).toHaveCount(1)
  const residentBadge = page.locator('[data-place-id="3"] .live-resident-more')
  const residentOverlap = await page.locator(
    '[data-place-id="3"] .live-walker',
  ).evaluateAll((nodes, badge) => {
    const count = badge.getBoundingClientRect()
    return nodes.some(node => {
      const pin = node.getBoundingClientRect()
      return pin.left < count.right && pin.right > count.left &&
        pin.top < count.bottom && pin.bottom > count.top
    })
  }, await residentBadge.elementHandle())
  expect(residentOverlap).toBe(false)
  const residentPairOverlap = await page.locator(
    '[data-place-id="3"] .live-walker',
  ).evaluateAll(nodes => nodes.some((node, index) => {
    const first = node.getBoundingClientRect()
    return nodes.slice(index + 1).some(other => {
      const second = other.getBoundingClientRect()
      return first.left < second.right && first.right > second.left &&
        first.top < second.bottom && first.bottom > second.top
    })
  }))
  expect(residentPairOverlap).toBe(false)
  await expect(page).toHaveURL(/\/window\/live$/u)

  const stage = page.locator('#live-stage')
  const startingScale = Number(await stage.getAttribute('data-live-scale'))
  await page.locator('#live-viewport').dispatchEvent('wheel', {
    clientX: 320, clientY: 220, deltaY: -240,
  })
  await expect.poll(async () => Number(await stage.getAttribute('data-live-scale')))
    .toBeGreaterThan(startingScale)
  const wheelScale = Number(await stage.getAttribute('data-live-scale'))
  const viewport = page.locator('#live-viewport')
  await viewport.focus()
  const keyboardStartX = Number(await stage.getAttribute('data-live-offset-x'))
  await viewport.press('ArrowRight')
  await expect.poll(async () => Number(await stage.getAttribute('data-live-offset-x')))
    .toBeLessThan(keyboardStartX)
  await viewport.press('+')
  await expect.poll(async () => Number(await stage.getAttribute('data-live-scale')))
    .toBeGreaterThan(wheelScale)
  await viewport.dispatchEvent('pointerdown', {
    pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 240, clientY: 220,
  })
  await viewport.dispatchEvent('pointerdown', {
    pointerId: 2, pointerType: 'touch', isPrimary: false, clientX: 360, clientY: 220,
  })
  await viewport.dispatchEvent('pointermove', {
    pointerId: 2, pointerType: 'touch', isPrimary: false, clientX: 430, clientY: 220,
  })
  await expect.poll(async () => Number(await stage.getAttribute('data-live-scale')))
    .toBeGreaterThan(wheelScale)
  await viewport.dispatchEvent('pointerup', {
    pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 240, clientY: 220,
  })
  await viewport.dispatchEvent('pointerup', {
    pointerId: 2, pointerType: 'touch', isPrimary: false, clientX: 430, clientY: 220,
  })
  await page.getByRole('button', { name: 'Fit live plate' }).click()

  fixture.publish()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  const replay = page.locator('.live-replay-portrait')
  await expect(replay).toHaveCount(1)
  const pinnedThing = page.locator('[data-place-id="3"] [data-live-thing-id="9"]')
  await expect(pinnedThing).toHaveCount(1)
  await expect(pinnedThing).toHaveAttribute('data-live-focus-thing', '9')
  const pinnedThingBounds = await pinnedThing.evaluate(node => {
    const thing = node.getBoundingClientRect()
    const plot = node.closest('.live-plot')!.getBoundingClientRect()
    return {
      left: thing.left >= plot.left - 1,
      right: thing.right <= plot.right + 1,
      top: thing.top >= plot.top - 1,
      bottom: thing.bottom <= plot.bottom + 1,
    }
  })
  expect(pinnedThingBounds).toEqual({ left: true, right: true, top: true, bottom: true })
  const thingBadge = page.locator('[data-place-id="3"] .live-thing-more')
  await expect(thingBadge).toHaveText('+3 more')
  const thingOverlaps = await page.locator(
    '[data-place-id="3"] .live-thing-specimen',
  ).evaluateAll((nodes, badge) => {
    const count = badge.getBoundingClientRect()
    return nodes.some(node => {
      const thing = node.getBoundingClientRect()
      return thing.left < count.right && thing.right > count.left &&
        thing.top < count.bottom && thing.bottom > count.top
    })
  }, await thingBadge.elementHandle())
  expect(thingOverlaps).toBe(false)

  await page.reload()
  await expect(page.locator('#live-focus-status')).toContainText('map-walker')
  await expect(page.locator(
    '#live-plates [data-live-focus-resident="map-walker"]',
  )).toHaveCount(1)
  const focusedWalker = page.locator('[data-live-resident-handle="map-walker"]').first()
  await focusedWalker.click()
  await expect(page.locator('#live-focus-status')).toContainText('No resident focused')
  expect(await page.evaluate(() => localStorage.getItem('1f3d9:window:live-focus'))).toBeNull()
  await focusedWalker.click()
  await expect(page.locator('#live-focus-status')).toContainText('map-walker')

  await page.getByRole('button', { name: 'Clear resident focus' }).click()
  await expect(page.locator('#live-focus-status')).toContainText('No resident focused')
  await page.reload()
  await expect(page.locator('[data-live-focus-resident]')).toHaveCount(0)
})

test('reduced motion shows new records statically without replay animation', async ({ page }) => {
  const now = Date.now()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.clock.install({ time: new Date(now) })
  const fixture = await installReplayRoutes(page, now)
  await page.goto('/window#view=live')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')

  fixture.publish()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(page.locator('.live-trail')).toHaveCount(1)
  await expect(page.locator('.live-footnote-mark')).toHaveCount(2)
  await expect(page.locator('.live-speech-bubble')).toHaveText('L'.repeat(59) + '…')
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
  await expect(page.locator('.live-thing-specimen.live-pulse')).toHaveCount(0)
  await expect(page.locator('.live-speech-bubble')).toHaveCSS('animation-name', 'none')
})

test('turning on reduced motion mid-walk preserves the final fading trail', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  await installReplayRoutes(page, now, 'complete', 0, { openingMovement: true })
  await page.goto('/window#view=live')
  await expect(page.locator('.live-replay-portrait')).toHaveAttribute(
    'data-live-replay-key',
    'change:9',
  )

  await page.clock.runFor(2_000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('.live-replay-portrait')).toHaveCount(0)
  await expect(page.locator('.live-trail')).toHaveCount(1)
  await page.clock.runFor(4_400)
  await expect(page.locator('.live-trail')).toHaveCount(1)
  await page.clock.runFor(101)
  await expect(page.locator('.live-trail')).toHaveCount(0)
})

test('the Live tab draws stored world ground and keeps surveyed plots fixed through new places', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const worldDrawingRequests: string[] = []
  const changeCursors: Array<string | null> = []
  const eventWindows: Array<string | null> = []
  const snapshotMarkers: Array<string | null> = []
  const writes: string[] = []
  let moderationPublished = false
  let latestReadUnavailable = false
  page.on('request', request => {
    if (isWrite(request)) writes.push(request.method() + ' ' + request.url())
  })

  const places = [{ id: 1, parent_id: null, name: 'the world' },
    { id: 2, parent_id: 1, name: 'Cinder lane' },
    { id: 3, parent_id: 1, name: 'Harbor room' },
    { id: 4, parent_id: 2, name: 'Lantern nook' }]
  const residents = [{ id: 5, handle: 'map-walker', current_place_id: 3,
    joined_at: new Date(now - 86_400_000).toISOString(), asleep: false }]

  await page.route('**/api/window**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('view') === 'directory') {
      await route.fulfill({ json: {
        view: 'directory', places,
        residents: residents.map(({ id, handle }) => ({ id, handle })),
      } })
      return
    }
    snapshotMarkers.push(url.searchParams.get('after_change_marker'))
    await route.fulfill({ json: {
      view: 'outline',
      change_marker: url.searchParams.get('after_change_marker') ?? '10',
      places: [{
        id: 1, parent_id: null, name: 'the world', owner: null,
        purpose: '', front_matter: [], places: moderationPublished ? 3 : 2,
        things: 0, notes: 0, moderated: false,
        children: [{
          id: 2, parent_id: 1, name: 'Cinder lane', owner: 'cinder-owner',
          purpose: '', front_matter: [], places: 1, things: 1, notes: 1,
          moderated: false, children: [{
            id: 4, parent_id: 2, name: 'Lantern nook', owner: 'cinder-owner',
            purpose: '', front_matter: [], places: 0, things: 0, notes: 0,
            moderated: false, children: [],
          }],
        }, {
          id: 3, parent_id: 1, name: 'Harbor room', owner: 'harbor-owner',
          purpose: '', front_matter: [], places: 0, things: 0, notes: 0,
          moderated: false, children: [],
        }, ...(moderationPublished ? [{
          id: 5, parent_id: 1, name: 'New observatory', owner: 'new-owner',
          purpose: '', front_matter: [], places: 0, things: 0, notes: 0,
          moderated: false, children: [],
        }] : [])],
      }],
      residents,
      notes: [],
      things: [{
        id: 9, place_id: 2, name: 'field lantern', body: 'a steady mark',
        maker_id: 5, made_by: 'map-walker', current_owner_id: 5,
        current_owner: 'map-walker', owner: 'map-walker', open_to_use: true,
        kind: 'lantern', traits: [], created_at: new Date(now - 120_000).toISOString(),
        moderated: false, kind_moderated: false,
      }],
      agreements: [], events: [],
      totals: { places: moderationPublished ? 5 : 4, residents: 1, conversations: 0,
        things: 1, agreements: 0, events: 2 },
      pages: {
        places: { has_more: false }, residents: { has_more: false },
        notes: { has_more: false }, things: { has_more: false },
        agreements: { has_more: false }, events: { has_more: false },
      },
      refreshed_at: new Date(now).toISOString(),
    } })
  })

  await page.route('**/api/changes**', async route => {
    const url = new URL(route.request().url())
    const since = url.searchParams.get('since')
    changeCursors.push(since)
    if (latestReadUnavailable && since === '16') {
      await route.fulfill({ status: 503, json: { error: 'public changes unavailable' } })
      return
    }
    if (since === null) {
      await route.fulfill({ json: { change_marker: '10' } })
      return
    }
    if (since === '10') {
      await route.fulfill({ json: {
        change_marker: '13', unchanged: false, has_more: true, next_since: '11',
        changes: [{
          change_id: '11', created_at: new Date(now - 120_000).toISOString(), kind: 'action',
          actor: 'map-walker', detail: {
            action: 'move', status: 'applied', from_place_id: 2, to_place_id: 3,
          },
        }],
      } })
      return
    }
    if (since === '11') {
      await route.fulfill({ json: {
        // A write lands while the client is paging. The first page's marker
        // remains the held boundary; #14 belongs to the next poll.
        change_marker: '16', unchanged: false, has_more: false, next_since: '16',
        changes: [{
          change_id: '12', created_at: new Date(now - 60_000).toISOString(), kind: 'note',
          actor: 'map-walker', detail: { place_id: 3, note_id: 77 },
        }, {
          change_id: '13', created_at: new Date(now - 30_000).toISOString(), kind: 'action',
          actor: 'map-walker', detail: {
            action: 'use', status: 'applied', place_id: 3, source_thing_id: 9,
          },
        }, {
          change_id: '14', created_at: new Date(now).toISOString(), kind: 'place_created',
          actor: 'new-owner', detail: { place_id: 5, parent_id: 1 },
        }],
      } })
      return
    }
    if (since === '13' && moderationPublished) {
      await route.fulfill({ json: {
        change_marker: '16', unchanged: false, has_more: false, next_since: '16',
        changes: [{
          change_id: '14', created_at: new Date(now).toISOString(), kind: 'place_created',
          actor: 'new-owner', detail: { place_id: 5, parent_id: 1 },
        }, {
          change_id: '15', created_at: new Date(now).toISOString(), kind: 'moderation',
          actor: 'founder', detail: { target_type: 'place', target_id: 2 },
        }, {
          change_id: '16', created_at: new Date(now).toISOString(), kind: 'moderation',
          actor: 'founder', detail: { target_type: 'note', target_id: 77 },
        }],
      } })
      return
    }
    await route.fulfill({ json: {
      change_marker: since || '13', unchanged: true, has_more: false,
      next_since: since || '13', changes: [],
    } })
  })
  await page.route('**/api/events**', async route => {
    eventWindows.push(new URL(route.request().url()).searchParams.get('within_seconds'))
    await route.fulfill({ json: {
      change_marker: '13', has_more: false, next_before_id: null,
      events: [{
        id: 103, change_id: '13', at: new Date(now - 30_000).toISOString(), kind: 'action',
        actor: 'map-walker', detail: {
          action: 'use', status: 'applied', place_id: 3, source_thing_id: 9,
        },
      }, {
        id: 102, change_id: '12', at: new Date(now - 60_000).toISOString(), kind: 'note',
        actor: 'map-walker', detail: { place_id: 3, note_id: 77 },
      }, {
        id: 101, change_id: '11', at: new Date(now - 120_000).toISOString(), kind: 'action',
        actor: 'map-walker', detail: {
          action: 'move', status: 'applied', from_place_id: 2, to_place_id: 3,
        },
      }, {
        id: 100, change_id: '10', at: new Date(now - 590_000).toISOString(), kind: 'note',
        actor: 'archive-walker', detail: { place_id: 2, note_id: 78 },
      }],
    } })
  })
  await page.route('**/api/residents**', async route => {
    const url = new URL(route.request().url())
    await route.fulfill({ json: {
      change_marker: url.searchParams.get('after_change_marker') ?? '16',
      residents,
      total: residents.length,
      has_more: false,
      next_before_id: null,
    } })
  })
  await page.route('**/api/note/77', async route => {
    if (moderationPublished) {
      await route.fulfill({ status: 404, json: { error: 'note not found' } })
      return
    }
    await route.fulfill({ json: { note: { id: 77, body: 'A bell answers\nThe second line stays below.' } } })
  })
  await page.route('**/api/note/78', async route => {
    await route.fulfill({ json: { note: { id: 78, body: 'An older mark' } } })
  })
  await page.route('**/api/drawing/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === '/api/drawing/place/1') worldDrawingRequests.push(pathname)
    const match = /^\/api\/drawing\/(place|resident|thing)\/(\d+)$/u.exec(pathname)
    if (!match) {
      await route.fulfill({ status: 404, json: { error: 'drawing not found' } })
      return
    }
    const type = match[1]
    const id = Number(match[2])
    if (moderationPublished && type === 'place' && id === 2) {
      await route.fulfill({ status: 404, json: { error: 'drawing not found' } })
      return
    }
    const authored = (type === 'place' && (id === 1 || id === 2)) || type === 'thing'
    await route.fulfill({ json: {
      type, id, source: authored ? type : null,
      drawing: authored
        ? { palette: ['#174d3c', '#f0c95f'], indices: Array.from({ length: 64 }, (_, index) => index % 2) }
        : null,
    } })
  })

  await page.goto('/window#view=map')
  await expect(page.locator('#window-status')).toContainText('Watching')
  await expect(page.locator('#live-beta')).toBeHidden()
  await page.getByRole('tab', { name: 'Live' }).click()
  await expect(page.locator('#live-beta')).toBeVisible()
  await expect(page.locator('#live-beta-note')).toContainText('if it disagrees with them, they are right')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect(page.locator('.live-plate-title')).toHaveText('the world')
  const captionClearOfViewport = await page.locator('#live-map-caption').evaluate(node => {
    const caption = node.getBoundingClientRect()
    const viewport = document.querySelector('#live-viewport')!.getBoundingClientRect()
    return caption.bottom <= viewport.top + 1
  })
  expect(captionClearOfViewport).toBe(true)
  await expect(page.locator('#live-plates .live-plot')).toHaveCount(2)
  await expect(page.locator('.live-trail')).toHaveCount(1)
  const openingReplay = page.locator('.live-replay-portrait')
  await expect(openingReplay).toHaveCount(1)
  await expect(openingReplay).toHaveAttribute('data-live-replay-key', 'change:11')
  await expect(page.locator('.live-footnote-mark')).toHaveCount(1)
  const openingDuration = Number(await openingReplay.getAttribute('data-replay-duration'))
  expect(openingDuration).toBeGreaterThanOrEqual(3_200)
  expect(openingDuration).toBeLessThanOrEqual(8_000)
  await page.clock.fastForward(openingDuration)
  await expect(page.locator('.live-footnote-mark')).toHaveCount(2)
  await page.clock.fastForward(650)
  await expect(openingReplay).toHaveCount(0)
  await expect(page.locator('.live-thing-specimen.live-pulse')).toHaveCount(0)
  await expect(page.locator('.live-speech-bubble')).toHaveCount(1)
  await expect(page.locator('.live-speech-bubble')).toHaveText('A bell answers')
  await expect(page.locator('#live-ledger')).toContainText('A bell answers')
  await expect(page.locator('#live-ledger')).toContainText('moved: Cinder lane → Harbor room')
  await expect(page.locator('#live-ledger')).toContainText('used thing #9 in Harbor room')
  await expect(page.locator('#live-ledger')).not.toContainText('used thing #9 in Cinder lane')
  await expect(page.locator('.live-world-ground .drawing-authored').first()).toBeVisible()
  const harbor = page.locator('.live-plot[data-place-id="3"]')
  await expect(harbor).toHaveAttribute('data-undrawn', 'true')
  await expect(harbor).toHaveAttribute('data-place-kind', 'continent')
  await expect(harbor.locator('.live-plot-owner')).toHaveText('undrawn · kept by harbor-owner')
  const cinderTerrain = page.locator('.live-plot[data-place-id="2"] .live-plot-terrain')
  await expect(cinderTerrain.locator('.drawing-authored').first()).toBeVisible()
  expect(changeCursors.slice(0, 3)).toEqual([null, '10', '11'])
  expect(eventWindows).toEqual(['1800'])
  await expect.poll(() => snapshotMarkers).toContain('13')
  expect(worldDrawingRequests).toEqual(['/api/drawing/place/1'])

  const originalPlots = await page.locator('.live-plot').evaluateAll(plots => plots.map(plot => ({
    id: plot.getAttribute('data-place-id'),
    left: (plot as HTMLElement).style.left,
    top: (plot as HTMLElement).style.top,
    width: (plot as HTMLElement).style.width,
    height: (plot as HTMLElement).style.height,
  })))
  const trailCoordinates = await page.locator('.live-trail').evaluate(line => ({
    x1: Number(line.getAttribute('x1')),
    x2: Number(line.getAttribute('x2')),
  }))
  expect(trailCoordinates.x1).not.toBe(trailCoordinates.x2)

  await page.locator('.live-trail').focus()
  await expect(page.locator('.live-trail')).toBeFocused()
  await page.locator('.live-trail').evaluate(node => {
    const lifetime = Number((node as HTMLElement).dataset.liveLifetime)
    ;(node as HTMLElement).dataset.liveAt = String(Date.now() - lifetime - 1)
  })
  await page.clock.runFor(1_001)
  await expect(page.locator('.live-trail')).toHaveCount(0)
  const pairedLedgerRow = page.locator('#live-ledger [data-live-key="change:11"]')
  await expect(pairedLedgerRow).toBeFocused()
  await pairedLedgerRow.evaluate(node => {
    const lifetime = Number((node as HTMLElement).dataset.liveLifetime)
    ;(node as HTMLElement).dataset.liveAt = String(Date.now() - lifetime - 1)
  })
  await page.clock.runFor(1_001)
  await expect(page.locator('#live-viewport')).toBeFocused()
  await page.clock.fastForward(6_000)
  await expect(page.locator('.live-footnote-mark')).toHaveCount(1)
  await expect(page.locator('#live-ledger')).not.toContainText('An older mark')

  moderationPublished = true
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(cinderTerrain.locator('.drawing-authored')).toHaveCount(0)
  await expect(cinderTerrain.locator('.drawing-unavailable').first()).toBeVisible()
  await expect(page.locator('#live-ledger')).toContainText("map-walker's note #77 could not be read.")
  await expect(page.locator('#live-ledger')).not.toContainText('A bell answers')
  await expect(page.locator('#live-plates .live-plot')).toHaveCount(3)
  await expect(page.locator('#live-plates')).toContainText('New observatory')
  const expandedPlots = await page.locator('.live-plot').evaluateAll(plots => plots.map(plot => ({
    id: plot.getAttribute('data-place-id'),
    left: (plot as HTMLElement).style.left,
    top: (plot as HTMLElement).style.top,
    width: (plot as HTMLElement).style.width,
    height: (plot as HTMLElement).style.height,
  })))
  expect(expandedPlots.filter(plot => plot.id !== '5')).toEqual(originalPlots)

  latestReadUnavailable = true
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  const latestReadRetry = page.getByRole('button', { name: 'Retry the latest read' })
  await expect(latestReadRetry).toBeVisible()
  latestReadUnavailable = false
  await latestReadRetry.click()
  await expect(latestReadRetry).toHaveCount(0)
  await expect(page.locator('#live-history-status')).not.toContainText(
    'The latest change pages could not be completed',
  )

  await page.setViewportSize({ width: 700, height: 900 })
  await expect(page.locator('.live-plot-terrain')).toHaveCount(3)
  const stackedGeometry = await page.locator('.live-layout').evaluate(layout => {
    const stage = layout.querySelector('.live-stage-shell')?.getBoundingClientRect()
    const roster = layout.querySelector('.live-roster-board')?.getBoundingClientRect()
    return stage && roster
      ? { stageBottom: stage.bottom, rosterTop: roster.top }
      : null
  })
  expect(stackedGeometry).not.toBeNull()
  expect(stackedGeometry!.rosterTop).toBeGreaterThanOrEqual(stackedGeometry!.stageBottom - 1)

  await page.setViewportSize({ width: 320, height: 720 })
  const narrowStage = page.locator('#live-stage')
  const naturalStageHeight = await narrowStage.evaluate(stage => ({
    style: (stage as HTMLElement).style.getPropertyValue('--live-stage-height'),
    data: (stage as HTMLElement).dataset.liveStageHeight ?? '',
  }))
  await narrowStage.evaluate(stage => {
    ;(stage as HTMLElement).style.setProperty('--live-stage-height', '20000px')
    ;(stage as HTMLElement).dataset.liveStageHeight = '20000'
  })
  await page.getByRole('button', { name: 'Fit live plate' }).click()
  const narrowFit = await narrowStage.evaluate(stage => {
    const plate = stage.getBoundingClientRect()
    const viewport = stage.closest('#live-viewport')!.getBoundingClientRect()
    return {
      left: plate.left >= viewport.left - 1,
      right: plate.right <= viewport.right + 1,
      top: plate.top >= viewport.top - 1,
      bottom: plate.bottom <= viewport.bottom + 1,
    }
  })
  expect(narrowFit).toEqual({ left: true, right: true, top: true, bottom: true })
  const narrowViewport = page.locator('#live-viewport')
  const readNarrowScale = async () => Number(await narrowStage.getAttribute('data-live-scale'))
  const refitNarrowPlate = async () => {
    await page.getByRole('button', { name: 'Fit live plate' }).click()
    const scale = await readNarrowScale()
    expect(scale).toBeLessThan(0.05)
    return scale
  }

  let fitScale = await refitNarrowPlate()
  await narrowViewport.dispatchEvent('wheel', { clientX: 160, clientY: 240, deltaY: 240 })
  expect(await readNarrowScale()).toBeLessThanOrEqual(fitScale)

  fitScale = await refitNarrowPlate()
  await narrowViewport.focus()
  await narrowViewport.press('-')
  expect(await readNarrowScale()).toBeLessThanOrEqual(fitScale)

  fitScale = await refitNarrowPlate()
  await narrowViewport.dispatchEvent('pointerdown', {
    pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 80, clientY: 240,
  })
  await narrowViewport.dispatchEvent('pointerdown', {
    pointerId: 2, pointerType: 'touch', isPrimary: false, clientX: 240, clientY: 240,
  })
  await narrowViewport.dispatchEvent('pointermove', {
    pointerId: 2, pointerType: 'touch', isPrimary: false, clientX: 200, clientY: 240,
  })
  expect(await readNarrowScale()).toBeLessThanOrEqual(fitScale)
  await narrowViewport.dispatchEvent('pointerup', {
    pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 80, clientY: 240,
  })
  await narrowViewport.dispatchEvent('pointerup', {
    pointerId: 2, pointerType: 'touch', isPrimary: false, clientX: 200, clientY: 240,
  })

  const cinderOwner = page.locator('.live-plot[data-place-id="2"] .live-plot-owner')
  await expect(cinderOwner).toHaveCSS('pointer-events', 'none')
  await narrowStage.evaluate((stage, naturalHeight) => {
    const liveStage = stage as HTMLElement
    if (naturalHeight.style) {
      liveStage.style.setProperty('--live-stage-height', naturalHeight.style)
    } else {
      liveStage.style.removeProperty('--live-stage-height')
    }
    if (naturalHeight.data) {
      liveStage.dataset.liveStageHeight = naturalHeight.data
    } else {
      delete liveStage.dataset.liveStageHeight
    }
  }, naturalStageHeight)
  await page.getByRole('button', { name: 'Fit live plate' }).click()
  await page.locator('.live-plot[data-place-id="2"] .live-plot-open').click()
  await expect(page).toHaveURL(/\/window\/live\?place=2$/u)
  await expect(page.locator('.live-breadcrumb[aria-current="location"]')).toHaveText('Cinder lane')
  const thingSpecimen = page.locator('.live-thing-specimen')
  await expect(thingSpecimen).toContainText('field lantern')
  await thingSpecimen.focus()
  await page.setViewportSize({ width: 701, height: 900 })
  await expect(thingSpecimen).toBeFocused()
  expect(writes).toEqual([])
})
