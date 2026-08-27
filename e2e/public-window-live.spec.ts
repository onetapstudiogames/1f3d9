import { expect, test, type Request } from '@playwright/test'

function isWrite(request: Request): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(request.method())
}

test('the Live tab draws verified recent marks, drills through plates, and never draws the world root', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const worldDrawingRequests: string[] = []
  const changeCursors: Array<string | null> = []
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
    await route.fulfill({ json: {
      change_marker: '13', has_more: false, next_before_id: null,
      events: [{
        id: 103, at: new Date(now - 30_000).toISOString(), kind: 'action',
        actor: 'map-walker', detail: {
          action: 'use', status: 'applied', place_id: 3, source_thing_id: 9,
        },
      }, {
        id: 102, at: new Date(now - 60_000).toISOString(), kind: 'note',
        actor: 'map-walker', detail: { place_id: 3, note_id: 77 },
      }, {
        id: 101, at: new Date(now - 120_000).toISOString(), kind: 'action',
        actor: 'map-walker', detail: {
          action: 'move', status: 'applied', from_place_id: 2, to_place_id: 3,
        },
      }, {
        id: 100, at: new Date(now - 590_000).toISOString(), kind: 'note',
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
  await expect(page.locator('.live-footnote-mark')).toHaveCount(2)
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
