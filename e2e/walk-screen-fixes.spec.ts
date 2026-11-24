import { expect, test } from '@playwright/test'

// Faults a live walk found on 2026-11-20 (city-ops fixes/live-walk-2026-11-20.md).

for (const [label, width, height] of [['desktop', 1366, 900], ['phone', 390, 844]] as const) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`join draws the picked client as picked on ${label} with a ${colorScheme} system theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme })
      await page.setViewportSize({ width, height })
      await page.goto('/join')
      await page.locator('input[name="client_class"][value="coding_persistent"]').check()
      // The page is light paper, so its native radios must be drawn for a light page.
      // A dark-drawn radio fills unpicked circles solid and hollows out the picked one.
      const radios = await page.locator('input[name="client_class"]').evaluateAll(inputs =>
        inputs.map(input => ({
          value: (input as HTMLInputElement).value,
          checked: (input as HTMLInputElement).checked,
          colorScheme: getComputedStyle(input).colorScheme,
        })))
      expect(radios.filter(radio => radio.checked).map(radio => radio.value)).toEqual(['coding_persistent'])
      for (const radio of radios) expect(radio.colorScheme, radio.value).toBe('light')
    })
  }
}

for (const path of ['/about', '/setup', '/privacy']) {
  test(`${path} keeps the site name and a short header on a phone`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(path)
    const name = await page.locator('.guide-brand strong').boundingBox()
    expect(name, 'site name box').not.toBeNull()
    expect(name!.width).toBeGreaterThan(0)
    expect(name!.height).toBeGreaterThan(0)
    const header = await page.locator('.guide-masthead').boundingBox()
    expect(header).not.toBeNull()
    expect(header!.height, 'header height on an 844 tall phone').toBeLessThanOrEqual(844 / 5)
    for (const link of await page.locator('.guide-nav a').all()) {
      const box = await link.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.y + box!.height).toBeLessThanOrEqual(header!.y + header!.height)
      expect(box!.height, 'tap target height').toBeGreaterThanOrEqual(32)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}

test('the window asks for a place thumbnail only when the place has a drawing', async ({ page }) => {
  const placeThumbnails: string[] = []
  const transparentPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAGklEQVR42u3BAQEAAACCIP+vbkhAAQAAAO8GECAAAcm1w7EAAAAASUVORK5CYII=',
    'base64',
  )
  await page.route('**/api/drawing/place/*/thumb.png*', async route => {
    placeThumbnails.push(new URL(route.request().url()).pathname)
    await route.fulfill({ status: 200, contentType: 'image/png', body: transparentPng })
  })
  const markPlaces = (value: unknown): unknown => Array.isArray(value)
    ? value.map(place => place && typeof place === 'object'
      ? {
          ...place,
          has_drawing: Number((place as { id?: unknown }).id) === 11,
          children: markPlaces((place as { children?: unknown }).children ?? []),
        }
      : place)
    : value
  await page.route('**/api/window**', async route => {
    const response = await route.fetch()
    const body = await response.json() as Record<string, unknown>
    await route.fulfill({ response, json: { ...body, places: markPlaces(body.places) } })
  })

  await page.goto('/window/map')
  await expect(page.locator('#window-status')).toContainText('Watching')
  const drawn = page.locator('.place-card').filter({ hasText: 'test_square' })
  const undrawn = page.locator('.place-card').filter({ hasText: 'side_room' })
  await drawn.scrollIntoViewIfNeeded()
  await undrawn.scrollIntoViewIfNeeded()
  await expect(drawn.locator('.place-portrait img')).toHaveAttribute('src', /\/api\/drawing\/place\/11\/thumb\.png/u)
  await expect(undrawn.locator('.place-portrait')).toHaveCount(0)
  expect(placeThumbnails.filter(path => path === '/api/drawing/place/12/thumb.png')).toEqual([])
})

test('the window name search asks for a place thumbnail only when the place has a drawing', async ({ page }) => {
  const placeThumbnails: string[] = []
  const transparentPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAGklEQVR42u3BAQEAAACCIP+vbkhAAQAAAO8GECAAAcm1w7EAAAAASUVORK5CYII=',
    'base64',
  )
  await page.route('**/api/drawing/place/*/thumb.png*', async route => {
    const url = new URL(route.request().url())
    placeThumbnails.push(url.pathname + url.search)
    await route.fulfill({ status: 200, contentType: 'image/png', body: transparentPng })
  })
  let marker = '9'
  await page.route('**/api/changes**', route => route.fulfill({ json: {
    change_marker: marker, changes: [], returned_items: 0,
    unchanged: marker === '9', has_more: false, next_since: marker,
  } }))
  // Places 21 and 22 are deeper than the loaded outline, so only the complete
  // directory knows them and whether each one has a drawing.
  const directory = {
    view: 'directory',
    places: [
      { type: 'place', id: 11, parent_id: null, name: 'test_square', quiet: false, has_drawing: true },
      { type: 'place', id: 12, parent_id: null, name: 'side_room', quiet: false, has_drawing: false },
      { type: 'place', id: 21, parent_id: 11, name: 'drawn den', quiet: false, has_drawing: true },
      { type: 'place', id: 22, parent_id: 11, name: 'undrawn den', quiet: false, has_drawing: false },
    ],
    residents: [],
  }
  await page.route('**/api/window**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('view') === 'directory') return route.fulfill({ json: directory })
    if (url.searchParams.get('collection') === 'things') {
      return route.fulfill({ json: {
        things: [], has_more: false, next_before_id: null, change_marker: marker,
      } })
    }
    const response = await route.fetch()
    const body = await response.json() as Record<string, unknown>
    await route.fulfill({ response, json: { ...body, change_marker: marker } })
  })

  await page.goto('/window/map')
  await expect(page.locator('#window-status')).toContainText('Watching')
  const search = page.locator('#directory-search')
  await search.fill('den')
  const drawnOption = page.locator('#directory-search-results .directory-search-option')
    .filter({ hasText: 'drawn den · Place #21' })
  const undrawnOption = page.locator('#directory-search-results .directory-search-option')
    .filter({ hasText: 'undrawn den · Place #22' })
  await expect(undrawnOption).toHaveCount(1)
  await expect(drawnOption.locator('.entity-portrait img')).toHaveAttribute(
    'src', '/api/drawing/place/21/thumb.png?rev=9')
  await expect(drawnOption.locator('.entity-portrait')).toHaveAttribute('data-portrait-state', 'loaded')
  await expect(undrawnOption.locator('.entity-portrait')).toHaveCount(0)

  // A new change marker re-renders the open search; the undrawn place still costs no request.
  marker = '10'
  const refreshed = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/window' && url.searchParams.get('after_change_marker') === '10'
  })
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await refreshed
  await search.fill('')
  await search.fill('den')
  await expect(drawnOption.locator('.entity-portrait img')).toHaveAttribute(
    'src', '/api/drawing/place/21/thumb.png?rev=10')
  await expect(undrawnOption).toHaveCount(1)
  await expect(undrawnOption.locator('.entity-portrait')).toHaveCount(0)
  expect(placeThumbnails.filter(path => path.startsWith('/api/drawing/place/22/'))).toEqual([])
  expect(placeThumbnails).toContain('/api/drawing/place/21/thumb.png?rev=10')
})
