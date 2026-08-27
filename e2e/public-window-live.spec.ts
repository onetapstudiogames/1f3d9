import { expect, test, type Page, type Request } from '@playwright/test'

function isWrite(request: Request): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(request.method())
}

const replayPlaces = [{ id: 1, parent_id: null, name: 'the world' },
  { id: 2, parent_id: 1, name: 'Cinder lane' },
  { id: 3, parent_id: 1, name: 'Harbor room' }]

function replaySnapshot(now: number, published: boolean, marker: string) {
  const placeId = published ? 3 : 2
  return {
    view: 'outline', change_marker: marker,
    places: [{
      id: 1, parent_id: null, name: 'the world', owner: null,
      purpose: '', front_matter: [], places: 2, things: 0, notes: 0,
      moderated: false, children: replayPlaces.slice(1).map(place => ({
        ...place, owner: place.id === 2 ? 'cinder-owner' : 'harbor-owner',
        purpose: '', front_matter: [], places: 0,
        things: place.id === placeId ? 1 : 0, notes: 0,
        moderated: false, children: [],
      })),
    }],
    residents: [{ id: 5, handle: 'map-walker', current_place_id: placeId,
      joined_at: new Date(now - 86_400_000).toISOString(), asleep: false }],
    notes: [],
    things: [{
      id: 9, place_id: placeId, name: 'field lantern', body: 'a steady mark',
      maker_id: 5, made_by: 'map-walker', current_owner_id: 5,
      current_owner: 'map-walker', owner: 'map-walker', open_to_use: true,
      kind: 'lantern', traits: [], created_at: new Date(now - 120_000).toISOString(),
      moderated: false, kind_moderated: false,
    }],
    agreements: [], events: [],
    totals: { places: 3, residents: 1, conversations: 0, things: 1,
      agreements: 0, events: published ? 6 : 0 },
    pages: {
      places: { has_more: false }, residents: { has_more: false },
      notes: { has_more: false }, things: { has_more: false },
      agreements: { has_more: false }, events: { has_more: false },
    },
    refreshed_at: new Date(now).toISOString(),
  }
}

async function installReplayRoutes(page: Page, now: number) {
  let published = false
  const currentMarker = () => published ? '16' : '10'
  await page.route('**/api/window**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('view') === 'directory') {
      await route.fulfill({ json: {
        view: 'directory', places: replayPlaces,
        residents: [{ id: 5, handle: 'map-walker' }],
      } })
      return
    }
    const requested = url.searchParams.get('after_change_marker')
    const marker = requested ?? currentMarker()
    await route.fulfill({ json: replaySnapshot(now, marker === '16', marker) })
  })
  await page.route('**/api/changes**', async route => {
    const since = new URL(route.request().url()).searchParams.get('since')
    if (since === null) {
      await route.fulfill({ json: { change_marker: currentMarker() } })
      return
    }
    if (since === '10' && published) {
      await route.fulfill({ json: {
        change_marker: '16', unchanged: false, has_more: false, next_since: '16',
        changes: [{
          change_id: '11', created_at: new Date(now).toISOString(), kind: 'action',
          actor: 'map-walker', detail: {
            action: 'move', status: 'applied', from_place_id: 2, to_place_id: 3,
          },
        }, {
          change_id: '12', created_at: new Date(now).toISOString(), kind: 'note',
          actor: 'map-walker', detail: { place_id: 3, note_id: 77 },
        }, {
          change_id: '13', created_at: new Date(now).toISOString(), kind: 'note',
          actor: 'map-walker', detail: { place_id: 3, note_id: 78 },
        }, {
          change_id: '14', created_at: new Date(now).toISOString(), kind: 'action',
          actor: 'map-walker', detail: {
            action: 'use', status: 'applied', place_id: 3, source_thing_id: 9,
          },
        }, {
          change_id: '15', created_at: new Date(now).toISOString(), kind: 'action',
          actor: 'map-walker', detail: {
            action: 'move', from_place_id: 3, to_place_id: 2,
          },
        }, {
          change_id: '16', created_at: new Date(now - 600_001).toISOString(), kind: 'note',
          actor: 'map-walker', detail: { place_id: 3, note_id: 79 },
        }],
      } })
      return
    }
    await route.fulfill({ json: {
      change_marker: currentMarker(), unchanged: true, has_more: false,
      next_since: currentMarker(), changes: [],
    } })
  })
  await page.route('**/api/events**', async route => {
    await route.fulfill({ json: {
      change_marker: currentMarker(), has_more: false, next_before_id: null, events: [],
    } })
  })
  await page.route('**/api/residents**', async route => {
    const marker = new URL(route.request().url()).searchParams.get('after_change_marker')
      ?? currentMarker()
    await route.fulfill({ json: {
      change_marker: marker,
      residents: replaySnapshot(now, marker === '16', marker).residents,
      total: 1, has_more: false, next_before_id: null,
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
  await page.route('**/api/drawing/**', async route => {
    const match = /^\/api\/drawing\/(place|resident|thing)\/(\d+)$/u.exec(
      new URL(route.request().url()).pathname,
    )
    await route.fulfill(match ? { json: {
      type: match[1], id: Number(match[2]), source: null, drawing: null,
    } } : { status: 404, json: { error: 'drawing not found' } })
  })
  return { publish: () => { published = true } }
}

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
  expect(duration).toBeGreaterThanOrEqual(1_000)
  expect(duration).toBeLessThanOrEqual(3_000)
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
    const ground = node.closest('.live-plate-ground')!.getBoundingClientRect()
    const box = node.getBoundingClientRect()
    return {
      x: ((box.left + box.width / 2 - ground.left) / ground.width) * 100,
      y: ((box.top + box.height / 2 - ground.top) / ground.height) * 100,
    }
  })
  await expect.poll(async () => (await replayPosition()).x, { timeout: duration })
    .toBeGreaterThan(35)
  const midpoint = await replayPosition()
  expect(midpoint.x).toBeGreaterThan(35)
  expect(midpoint.x).toBeLessThan(65)
  expect(Math.abs(midpoint.y - 67)).toBeLessThan(2)

  await page.clock.fastForward(duration)
  await expect(page.locator('.live-footnote-mark')).toHaveCount(1)
  await expect(page.locator('.live-speech-bubble')).toHaveText('Earlier line')
  await expect(page.locator('.live-thing-specimen.live-pulse')).toHaveCount(0)

  await page.clock.fastForward(650)
  await expect(page.locator('.live-footnote-mark')).toHaveCount(2)
  await expect(page.locator('.live-speech-bubble')).toHaveText('L'.repeat(59) + '…')
  await expect(page.locator('.live-speech-bubble')).toHaveCount(1)
  await expect(page.locator('#live-ledger')).toContainText('Latest detail stays in the ledger.')

  await page.clock.fastForward(650)
  const pulsedThing = page.locator('.live-thing-specimen.live-pulse')
  await expect(pulsedThing).toHaveCount(1)
  await expect(pulsedThing).toHaveAttribute('data-live-thing-id', '9')
  await expect(pulsedThing).toHaveAttribute('data-live-thing-place-id', '3')
  await expect(pulsedThing).toHaveAttribute('data-live-pulse-for', 'change:14')
  await expect(page.locator('.live-action-mark')).toHaveCount(0)

  await page.clock.fastForward(600)
  await expect(replay).toHaveCount(0)
  await expect(page.locator('.live-thing-specimen.live-pulse')).toHaveCount(0)
  await expect(trail).toHaveCount(1)
  await expect(page.locator('.live-footnote-mark')).toHaveCount(2)
  await expect(page.locator('#live-ledger')).not.toContainText('Too old to replay')
  await expect(page.locator('#live-ledger')).not.toContainText('moved: Harbor room → Cinder lane')
  const platePortrait = page.locator('#live-plates .live-portrait')
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
  await expect(trail).toHaveCount(1)
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

test('the Live tab draws verified recent marks, drills through plates, and never draws the world root', async ({ page }) => {
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
        change_marker: '13', unchanged: false, has_more: false, next_since: '13',
        changes: [{
          change_id: '12', created_at: new Date(now - 60_000).toISOString(), kind: 'note',
          actor: 'map-walker', detail: { place_id: 3, note_id: 77 },
        }, {
          change_id: '13', created_at: new Date(now - 30_000).toISOString(), kind: 'action',
          actor: 'map-walker', detail: {
            action: 'use', status: 'applied', place_id: 3, source_thing_id: 9,
          },
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
    const authored = (type === 'place' && id === 2) || type === 'thing'
    await route.fulfill({ json: {
      type, id, source: authored ? type : null,
      drawing: authored
        ? { palette: ['#174d3c', '#f0c95f'], indices: Array.from({ length: 64 }, (_, index) => index % 2) }
        : null,
    } })
  })

  await page.goto('/window#view=map')
  await expect(page.getByRole('status')).toContainText('Watching')
  await expect(page.locator('#live-beta')).toBeHidden()
  await page.getByRole('tab', { name: 'Live' }).click()
  await expect(page.locator('#live-beta')).toBeVisible()
  await expect(page.locator('#live-beta-note')).toContainText('if it disagrees with them, they are right')
  await expect(page.locator('#live-history-status')).toContainText('history is complete')
  await expect(page.locator('.live-plate-title')).toHaveText('the world')
  await expect(page.locator('#live-plates .live-island')).toHaveCount(2)
  await expect(page.locator('.live-trail')).toHaveCount(1)
  const openingReplay = page.locator('.live-replay-portrait')
  await expect(openingReplay).toHaveCount(1)
  await expect(openingReplay).toHaveAttribute('data-live-replay-key', 'change:11')
  await expect(page.locator('.live-footnote-mark')).toHaveCount(1)
  const openingDuration = Number(await openingReplay.getAttribute('data-replay-duration'))
  expect(openingDuration).toBeGreaterThanOrEqual(1_000)
  expect(openingDuration).toBeLessThanOrEqual(3_000)
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
  await expect(page.locator('.live-plate-ground .live-terrain > .drawing-grid').first()
    .locator('.drawing-undrawn-label')).toBeVisible()
  await expect(page.locator('.live-plate-ground .live-terrain > .drawing-grid').first()
    .locator('.drawing-undrawn-label')).toHaveText('world stand-in')
  const harbor = page.locator('.live-island').filter({ hasText: 'Harbor room' })
  await expect(harbor.locator('.live-island-owner')).toHaveText('undrawn · kept by harbor-owner')
  const cinderTerrain = page.locator('.live-island').filter({ hasText: 'Cinder lane' })
    .locator('.live-island-terrain')
  await expect(cinderTerrain.locator('.drawing-authored')).toHaveCount(8)
  expect(changeCursors.slice(0, 3)).toEqual([null, '10', '11'])
  expect(eventWindows).toEqual(['1800'])
  await expect.poll(() => snapshotMarkers).toContain('13')
  expect(worldDrawingRequests).toEqual([])

  await page.locator('.live-trail').focus()
  await expect(page.locator('.live-trail')).toBeFocused()
  await page.clock.fastForward(11_000)
  await expect(page.locator('.live-footnote-mark')).toHaveCount(1)
  await expect(page.locator('#live-ledger')).not.toContainText('An older mark')
  await expect(page.locator('.live-trail')).toBeFocused()

  moderationPublished = true
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(cinderTerrain.locator('.drawing-authored')).toHaveCount(0)
  await expect(cinderTerrain.locator('.drawing-unavailable')).toHaveCount(8)
  await expect(page.locator('#live-ledger')).toContainText("map-walker's note #77 could not be read.")
  await expect(page.locator('#live-ledger')).not.toContainText('A bell answers')
  await expect(page.locator('#live-plates .live-island')).toHaveCount(3)
  await expect(page.locator('#live-plates')).toContainText('New observatory')
  await expect(page.locator('.live-trail')).toBeFocused()

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
  await expect(page.locator('.live-island-terrain')).toHaveCount(3)
  await expect(page.locator('.live-island-terrain .drawing-grid')).toHaveCount(24)
  await expect(page.locator('.live-trail')).toHaveAttribute('x1', '50')
  await expect(page.locator('.live-trail')).toHaveAttribute('x2', '50')
  await expect(page.locator('.live-footnote-mark')).toHaveAttribute('style', /left:\s*50%/u)
  const stackedGeometry = await page.locator('.live-layout').evaluate(layout => {
    const stage = layout.querySelector('.live-stage')?.getBoundingClientRect()
    const roster = layout.querySelector('.live-roster-board')?.getBoundingClientRect()
    return stage && roster
      ? { stageBottom: stage.bottom, rosterTop: roster.top }
      : null
  })
  expect(stackedGeometry).not.toBeNull()
  expect(stackedGeometry!.rosterTop).toBeGreaterThanOrEqual(stackedGeometry!.stageBottom - 1)

  await page.locator('.live-island').filter({ hasText: 'Cinder lane' })
    .locator('.live-island-open').click()
  await expect(page).toHaveURL(/#view=live&place=2$/u)
  await expect(page.locator('.live-breadcrumb[aria-current="location"]')).toHaveText('Cinder lane')
  const thingSpecimen = page.locator('.live-thing-specimen')
  await expect(thingSpecimen).toContainText('field lantern')
  await thingSpecimen.focus()
  await page.setViewportSize({ width: 701, height: 900 })
  await expect(thingSpecimen).toBeFocused()
  expect(writes).toEqual([])
})
