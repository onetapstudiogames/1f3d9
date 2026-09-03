import { expect, test, type Page, type Request } from '@playwright/test'

const NOTE_EXCERPT = 'The public note begins here'
const THING_EXCERPT = 'A lantern with an abbreviated inscription'
const NOTE_FULL = `${NOTE_EXCERPT}, then continues beyond the snapshot excerpt.`
const THING_FULL = `${THING_EXCERPT}; the complete inscription is readable without signing in.`
const SYNTHETIC_RESIDENT_KEY = `1f3d9_sk_${'12'.repeat(24)}`
const CREDENTIAL_RECOVERY_INSTRUCTION =
  'That looks like a credential. Never put it in a public URL. If it is a resident key, replace it now; if it is a recovery code, create a fresh recovery set.'

interface PublicWindowTestState {
  readonly write_requests?: Array<{ readonly method?: unknown; readonly path?: unknown }>
  readonly detail_requests?: Array<{
    readonly path?: unknown
    readonly has_authorization?: unknown
    readonly has_cookie?: unknown
  }>
  readonly event_queries?: Array<{
    readonly before_id?: unknown
    readonly limit?: unknown
    readonly within_place_id?: unknown
  }>
}

function isWrite(request: Request): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(request.method())
}

async function installClipboardRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const copiedShareLinks: string[] = []
    Object.defineProperty(window, '__copiedShareLinks', {
      configurable: true,
      value: copiedShareLinks,
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(value: string) {
          copiedShareLinks.push(value)
          return Promise.resolve()
        },
      },
    })
  })
}

async function copiedShareLinks(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => [
    ...((window as Window & { __copiedShareLinks?: string[] }).__copiedShareLinks ?? []),
  ])
}

function boxesIntersect(
  left: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  right: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x &&
    left.y < right.y + right.height && left.y + left.height > right.y
}

test('public window links to the dated public snapshot archive', async ({ page }) => {
  await page.goto('/window')
  const link = page.getByRole('link', { name: 'Public snapshots' })
  await expect(link).toHaveAttribute(
    'href',
    'https://github.com/onetapstudiogames/1f3d9/releases?q=city-snapshot-',
  )
})

test('public window shows lazy thumbnail portraits beside roster and room names', async ({ page }) => {
  const thumbnailPaths: string[] = []
  const transparentPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAGklEQVR42u3BAQEAAACCIP+vbkhAAQAAAO8GECAAAcm1w7EAAAAASUVORK5CYII=',
    'base64',
  )
  const eventOnlyAt = new Date().toISOString()
  const eventOnlyReferences = [
    {
      id: 9_401, at: eventOnlyAt, kind: 'thing_created', actor: 'browser-resident',
      detail: { thing_id: 9_401, place_id: 11 }, thing_has_drawing: true,
    },
    {
      id: 9_402, at: eventOnlyAt, kind: 'thing_created', actor: 'browser-resident',
      detail: { thing_id: 9_402, place_id: 11 }, thing_has_drawing: false,
    },
  ]
  await page.route('**/api/drawing/*/*/thumb.png*', async route => {
    const url = new URL(route.request().url())
    thumbnailPaths.push(url.pathname + url.search)
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'cache-control': 'public, max-age=31536000, immutable' },
      body: transparentPng,
    })
  })
  await page.route('**/api/events**', async route => {
    const response = await route.fetch()
    const body = await response.json() as Record<string, unknown>
    const events = Array.isArray(body.events) ? body.events : []
    await route.fulfill({ response, json: {
      ...body,
      events: [
        ...eventOnlyReferences,
        ...events,
      ],
    } })
  })
  await page.route('**/api/window**', async route => {
    const response = await route.fetch()
    const body = await response.json() as Record<string, unknown>
    const markResidents = (value: unknown) => Array.isArray(value)
      ? value.map(resident => resident && typeof resident === 'object'
        ? { ...resident, has_drawing: Number((resident as { id?: unknown }).id) === 49 }
        : resident)
      : value
    const markThings = (value: unknown) => Array.isArray(value)
      ? value.map(thing => thing && typeof thing === 'object'
        ? { ...thing, has_drawing: Number((thing as { id?: unknown }).id) === 401 }
        : thing)
      : value
    await route.fulfill({ response, json: {
      ...body,
      residents: markResidents(body.residents),
      things: markThings(body.things),
      events: [...eventOnlyReferences, ...(Array.isArray(body.events) ? body.events : [])],
    } })
  })

  await page.goto('/window/map')
  await expect(page.locator('#window-status')).toContainText('Watching')
  const rosterRow = page.locator('#resident-roster .resident-row')
    .filter({ hasText: 'browser-resident' })
  await rosterRow.scrollIntoViewIfNeeded()
  const rosterPortrait = rosterRow.locator('.entity-portrait img')
  await expect(rosterPortrait).toHaveAttribute('loading', 'lazy')
  await expect(rosterPortrait).toHaveAttribute('width', '32')
  await expect(rosterPortrait).toHaveAttribute('height', '32')
  await expect(rosterPortrait).toHaveAttribute(
    'src',
    /\/api\/drawing\/resident\/49\/thumb\.png\?rev=9$/u,
  )
  const rosterPortraitShell = rosterRow.locator('.entity-portrait')
  await expect(rosterPortraitShell).toBeVisible()
  await expect(rosterPortraitShell).toHaveAttribute('data-portrait-state', 'loaded')
  expect(await rosterPortraitShell.evaluate(shell => {
    const shellStyle = getComputedStyle(shell)
    const placeholder = shell.querySelector('.entity-portrait-placeholder')
    const placeholderStyle = placeholder ? getComputedStyle(placeholder) : null
    return {
      shellBackgroundColor: shellStyle.backgroundColor,
      shellBackgroundImage: shellStyle.backgroundImage,
      shellBorderStyle: shellStyle.borderStyle,
      placeholderBackgroundColor: placeholderStyle?.backgroundColor ?? null,
      placeholderBackgroundImage: placeholderStyle?.backgroundImage ?? null,
    }
  })).toEqual({
    shellBackgroundColor: 'rgba(0, 0, 0, 0)',
    shellBackgroundImage: 'none',
    shellBorderStyle: 'none',
    placeholderBackgroundColor: 'rgba(0, 0, 0, 0)',
    placeholderBackgroundImage: 'none',
  })

  await page.getByRole('tab', { name: 'Place', exact: true }).click()
  await expect(page).toHaveURL(/\/window\/place\/11$/u)
  const occupant = page.locator('#place-occupants .person-card')
    .filter({ hasText: 'browser-resident' })
  await occupant.scrollIntoViewIfNeeded()
  await expect(occupant.locator('.entity-portrait img')).toHaveAttribute(
    'src',
    /\/api\/drawing\/resident\/49\/thumb\.png\?rev=9$/u,
  )
  const thing = page.locator('#place-things .thing-card').filter({ hasText: 'field_lantern' })
  await thing.scrollIntoViewIfNeeded()
  await expect(thing.locator('.entity-portrait img[data-portrait-type="thing"]')).toHaveAttribute(
    'src',
    /\/api\/drawing\/thing\/401\/thumb\.png\?rev=9$/u,
  )
  await expect(thing.locator('.kind-portrait img[data-portrait-type="kind"]')).toHaveAttribute(
    'src',
    /\/api\/drawing\/kind\/77\/thumb\.png\?rev=9$/u,
  )
  await expect(page.locator(
    '#place-notes .note-card .entity-portrait[data-portrait-type="note"]',
  )).toHaveCount(0)

  const happeningsResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/events' && url.searchParams.get('within_place_id') === '11' &&
      !url.searchParams.has('before_id') && response.status() === 200
  })
  await page.getByRole('tab', { name: 'Happenings', exact: true }).click()
  await happeningsResponse
  const madeThing = page.locator('#activity-list .activity-row').filter({ hasText: 'field_lantern' })
  await expect(madeThing).toBeVisible()
  const madeThingPortrait = madeThing.locator(
    '.entity-portrait[data-portrait-type="thing"]',
  )
  await expect(madeThingPortrait).toHaveCount(1)
  await madeThingPortrait.scrollIntoViewIfNeeded()
  const madeThingPortraitImage = madeThingPortrait.locator('img')
  await expect(madeThingPortraitImage).toHaveCount(1)
  await expect(madeThingPortraitImage).toHaveAttribute(
    'src',
    /\/api\/drawing\/thing\/401\/thumb\.png\?rev=9$/u,
  )
  const eventOnlyDrawn = page.locator('#activity-list .activity-thing-reference')
    .filter({ hasText: 'Thing #9401' })
  const eventOnlyUndrawn = page.locator('#activity-list .activity-thing-reference')
    .filter({ hasText: 'Thing #9402' })
  await expect(eventOnlyDrawn.locator('.entity-portrait[data-portrait-type="thing"]')).toHaveCount(1)
  await expect(eventOnlyUndrawn.locator('.entity-portrait[data-portrait-type="thing"]')).toHaveCount(0)

  expect(thumbnailPaths).toContain('/api/drawing/resident/49/thumb.png?rev=9')
  expect(thumbnailPaths).toContain('/api/drawing/thing/401/thumb.png?rev=9')
  expect(thumbnailPaths).toContain('/api/drawing/kind/77/thumb.png?rev=9')
})

test('THINGS stays bounded by choice and transparent at desktop and phone widths', async ({ page }) => {
  const mostlyTransparentPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAALklEQVR4nO3OMQ0AMAgAQQzVBiLw74M6YCMdepf8/nGyeiq2GTBg4PkAAADwvQtDNHMBnss7igAAAABJRU5ErkJggg==',
    'base64',
  )
  const headings = Array.from({ length: 27 }, (_, index) => {
    const id = 427 - index
    return {
      id,
      place_id: id % 2 === 0 ? 12 : 11,
      name: id === 427 ? 'transparent-beacon' : `Public thing ${id}`,
      kind_id: 77,
      kind: 'artifact',
      maker_id: 49,
      made_by: 'browser-resident',
      current_owner_id: 49,
      current_owner: 'browser-resident',
      has_drawing: id === 427,
      body_text_bytes: id === 427 ? 37 : id,
      created_at: `2026-08-13T19:${String(59 - index).padStart(2, '0')}:00.000Z`,
    }
  })
  const frontMatter = [{
    type: 'thing', id: 427, name: 'transparent-beacon', body_text_bytes: 37,
    maker_id: 49, made_by: 'browser-resident', current_owner_id: 49,
    current_owner: 'browser-resident', owner_id: 49, owner: 'browser-resident',
    has_drawing: true,
  }]
  let indexRequests = 0
  let holdNextCitywidePage = false
  let releaseHeldCitywidePage = () => {}
  let markHeldCitywideStarted = () => {}
  const heldCitywidePage = new Promise<void>(resolve => { releaseHeldCitywidePage = resolve })
  const heldCitywideStarted = new Promise<void>(resolve => { markHeldCitywideStarted = resolve })
  await page.route('**/api/drawing/thing/427/thumb.png*', route => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: mostlyTransparentPng,
  }))
  await page.route('**/api/window**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('view') === 'directory') {
      await route.fulfill({ json: {
        view: 'directory',
        places: [
          { id: 11, parent_id: null, name: 'test_square' },
          { id: 12, parent_id: 11, name: 'side_room' },
        ],
        residents: [
          { id: 49, handle: 'browser-resident', has_drawing: true },
          { id: 48, handle: 'oldwalker', has_drawing: false },
          ...Array.from({ length: 20 }, (_, index) => ({
            id: 100 + index,
            handle: `transparent-beacon-${index + 1}`,
          })),
        ],
      } })
      return
    }
    if (url.searchParams.get('collection') === 'things' &&
        url.searchParams.get('presentation') === 'headings') {
      const find = url.searchParams.get('find')
      const withinPlaceId = url.searchParams.get('within_place_id')
      if (
        holdNextCitywidePage && !find && !withinPlaceId &&
        !url.searchParams.has('before_id')
      ) {
        holdNextCitywidePage = false
        markHeldCitywideStarted()
        await heldCitywidePage
      }
      const scopedHeadings = withinPlaceId === '12'
        ? headings.filter(thing => thing.place_id === 12)
        : headings
      const rows = find
        ? headings.filter(thing => find.startsWith('#')
          ? `#${thing.id}` === find
          : thing.name.toLocaleLowerCase().includes(find.toLocaleLowerCase()))
        : url.searchParams.has('before_id')
          ? scopedHeadings.slice(25)
          : scopedHeadings.slice(0, 25)
      if (!find) indexRequests += 1
      const hasMore = !find && !url.searchParams.has('before_id') && scopedHeadings.length > 25
      await route.fulfill({ json: {
        change_marker: '9',
        things: rows,
        has_more: hasMore,
        next_before_id: hasMore ? 403 : null,
      } })
      return
    }
    const response = await route.fetch()
    const snapshot = await response.json()
    const [square, sideRoom] = snapshot.places
    const residents = [
      ...snapshot.residents.filter((resident: { id: number }) => ![48, 49].includes(resident.id)),
      {
        id: 49, handle: 'browser-resident', current_place_id: 11,
        joined_at: '2026-08-13T20:00:00.000Z', asleep: false, has_drawing: true,
      },
      {
        id: 48, handle: 'oldwalker', current_place_id: 11,
        joined_at: '2026-08-12T20:00:00.000Z', asleep: false, has_drawing: false,
      },
    ]
    await route.fulfill({ response, json: {
      ...snapshot,
      residents,
      totals: { ...snapshot.totals, things: 27 },
      places: [{
        ...square,
        places: 1,
        things: 14,
        front_matter: frontMatter,
        children: [{ ...sideRoom, parent_id: 11, things: 13, children: [] }],
      }],
      live_survey: [
        // notes mirrors the place tree above: things is deliberately
        // overridden for this test, but notes is left at whatever the
        // fetched snapshot's square/sideRoom already carried.
        { id: 11, parent_id: null, things: 14, notes: square.notes },
        { id: 12, parent_id: 11, things: 13, notes: sideRoom.notes },
      ],
    } })
  })

  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    indexRequests = 0
    await page.setViewportSize(viewport)
    await page.goto('/window/things')
    await expect(page.locator('#window-status')).toContainText('Watching')
    await expect(page.locator('#things-summary')).toHaveText(
      '25 of 27 public things shown. Bodies stay closed until you choose one.',
    )
    await expect(page.locator('#things-list .thing-index-row')).toHaveCount(25)
    await expect(page.getByRole('button', { name: 'Continue things' })).toBeVisible()
    expect(indexRequests).toBe(1)
    await page.waitForTimeout(150)
    expect(indexRequests).toBe(1)

    const firstRow = page.locator('#things-list .thing-index-row').first()
    const undrawnRow = page.locator('#things-list .thing-index-row').nth(1)
    await expect(firstRow).toContainText('transparent-beacon')
    await expect(firstRow).toContainText('37 UTF-8 body bytes')
    await expect(firstRow).not.toContainText('must not cross')
    const portrait = firstRow.locator('.entity-portrait[data-portrait-type="thing"]')
    await expect(portrait).toHaveCount(1)
    await expect(undrawnRow.locator('.entity-portrait[data-portrait-type="thing"]')).toHaveCount(0)
    const drawnTitleBeforeLoad = await firstRow.locator('.thing-index-link').boundingBox()
    const undrawnTitle = await undrawnRow.locator('.thing-index-link').boundingBox()
    const drawnRow = await firstRow.boundingBox()
    const undrawnRowBox = await undrawnRow.boundingBox()
    expect(drawnTitleBeforeLoad).not.toBeNull()
    expect(undrawnTitle).not.toBeNull()
    expect(drawnRow).not.toBeNull()
    expect(undrawnRowBox).not.toBeNull()
    expect(undrawnTitle!.x - undrawnRowBox!.x).toBeLessThan(
      drawnTitleBeforeLoad!.x - drawnRow!.x,
    )
    await portrait.scrollIntoViewIfNeeded()
    await expect(portrait).toHaveAttribute('data-portrait-state', 'loaded')
    const drawnTitleAfterLoad = await firstRow.locator('.thing-index-link').boundingBox()
    expect(drawnTitleAfterLoad?.x).toBe(drawnTitleBeforeLoad?.x)
    expect(await portrait.evaluate(shell => {
      const image = shell.querySelector('img')
      const canvas = document.createElement('canvas')
      canvas.width = 32
      canvas.height = 32
      const context = canvas.getContext('2d')
      if (!image || !context) return null
      context.drawImage(image, 0, 0, 32, 32)
      return {
        inkAlpha: context.getImageData(2, 2, 1, 1).data[3],
        centerAlpha: context.getImageData(16, 16, 1, 1).data[3],
        shellBackground: getComputedStyle(shell).backgroundColor,
        rowBackground: getComputedStyle(shell.closest('.thing-index-row')!).backgroundColor,
      }
    })).toEqual({
      inkAlpha: 255,
      centerAlpha: 0,
      shellBackground: 'rgba(0, 0, 0, 0)',
      rowBackground: 'rgb(255, 249, 232)',
    })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

    await page.getByRole('button', { name: 'Continue things' }).click()
    await expect(page.locator('#things-summary')).toHaveText(
      '27 of 27 public things shown. Bodies stay closed until you choose one.',
    )
    await expect(page.locator('#things-list .thing-index-row')).toHaveCount(27)
    expect(indexRequests).toBe(2)

    await page.getByRole('tab', { name: 'Map', exact: true }).click()
    const drawnResident = page.locator('#resident-roster .resident-row')
      .filter({ hasText: 'browser-resident' })
    const undrawnResident = page.locator('#resident-roster .resident-row')
      .filter({ hasText: 'oldwalker' })
    await expect(drawnResident.locator('.entity-portrait')).toHaveCount(1)
    await expect(undrawnResident.locator('.entity-portrait')).toHaveCount(0)
    const [drawnHandle, undrawnHandle, drawnResidentBox, undrawnResidentBox] = await Promise.all([
      drawnResident.locator('.resident-follow').boundingBox(),
      undrawnResident.locator('.resident-follow').boundingBox(),
      drawnResident.boundingBox(),
      undrawnResident.boundingBox(),
    ])
    expect(drawnHandle).not.toBeNull()
    expect(undrawnHandle).not.toBeNull()
    expect(drawnResidentBox).not.toBeNull()
    expect(undrawnResidentBox).not.toBeNull()
    expect(undrawnHandle!.x - undrawnResidentBox!.x).toBeLessThan(
      drawnHandle!.x - drawnResidentBox!.x,
    )
    if (viewport.width <= 390) {
      const [drawnMeta, undrawnMeta] = await Promise.all([
        drawnResident.locator('.resident-number').boundingBox(),
        undrawnResident.locator('.resident-number').boundingBox(),
      ])
      expect(drawnMeta).not.toBeNull()
      expect(undrawnMeta).not.toBeNull()
      expect(boxesIntersect(drawnHandle!, drawnMeta!)).toBe(false)
      expect(boxesIntersect(undrawnHandle!, undrawnMeta!)).toBe(false)
    }
  }

  await page.goto('/window/map')
  const mapHeading = page.locator('#place-map .place-card-thing')
    .filter({ hasText: 'transparent-beacon' })
  await mapHeading.scrollIntoViewIfNeeded()
  await expect(mapHeading.locator(
    '.entity-portrait[data-portrait-type="thing"] img',
  )).toHaveAttribute(
    'src',
    /\/api\/drawing\/thing\/427\/thumb\.png\?rev=9$/u,
  )

  const search = page.getByRole('combobox', { name: 'Search places, residents, and things' })
  await search.fill('transparent-beacon')
  await expect(page.getByRole('option', { name: /transparent-beacon · Thing #427/u })).toBeVisible()
  await expect(page.locator('#directory-search-status')).toContainText(
    'Showing the first 20 of 21 exact matches',
  )
  await search.fill('#427')
  await expect(page.getByRole('option', { name: /transparent-beacon · Thing #427/u })).toBeVisible()

  await page.goto('/window/things?place=11')
  await expect(page.locator('#things-list .thing-index-row')).toHaveCount(25)
  holdNextCitywidePage = true
  await page.locator('#place-filter').selectOption('')
  await heldCitywideStarted
  await page.locator('#place-filter').selectOption('12')
  await expect(page).toHaveURL(/\/window\/things\?place=12$/u)
  await expect(page.locator('#things-summary')).toHaveText(
    '13 of 13 public things shown. Bodies stay closed until you choose one.',
  )
  releaseHeldCitywidePage()
  await page.waitForTimeout(100)
  await expect(page.locator('#things-summary')).toHaveText(
    '13 of 13 public things shown. Bodies stay closed until you choose one.',
  )
})

test('presence rows keep handles and long locations separate at phone and desktop widths', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route('**/api/window*', async route => {
    const response = await route.fetch()
    const body = await response.json() as {
      readonly places?: ReadonlyArray<Record<string, unknown>>
      readonly [key: string]: unknown
    }
    if (!body.places) {
      await route.fulfill({ response })
      return
    }
    const residents = Array.isArray(body.residents)
      ? body.residents.map(resident => resident && typeof resident === 'object'
        ? {
            ...resident,
            handle: Number((resident as { id?: unknown }).id) === 49
              ? 'fable-lyrebird'
              : Number((resident as { id?: unknown }).id) === 48
                ? 'off-by-one'
                : (resident as { handle?: unknown }).handle,
            current_place_id: Number((resident as { id?: unknown }).id) === 48
              ? 11
              : (resident as { current_place_id?: unknown }).current_place_id,
            has_drawing: Number((resident as { id?: unknown }).id) === 49,
          }
        : resident)
      : []
    await route.fulfill({
      response,
      json: {
        ...body,
        residents,
        things: Array.isArray(body.things)
          ? body.things.map(thing => thing && typeof thing === 'object'
            ? { ...thing, has_drawing: Number((thing as { id?: unknown }).id) === 401 }
            : thing)
          : body.things,
        places: body.places.map(place => place.id === 11 ? {
          ...place,
          name: 'frontier valley / the corrigenda room / the long lantern gallery',
        } : place),
      },
    })
  })

  await page.goto('/window/place/11')
  await expect(page.locator('#window-status')).toContainText('Watching')

  const placeRow = page.locator('#place-occupants .person-card')
    .filter({ hasText: 'fable-lyrebird' })
  const placeHandle = placeRow.locator('.resident-follow')
  const placeMeta = placeRow.locator('.resident-number')
  await expect(placeRow).toBeVisible()
  const [placeHandleBox, placeMetaBox] = await Promise.all([
    placeHandle.boundingBox(),
    placeMeta.boundingBox(),
  ])
  expect(placeHandleBox).not.toBeNull()
  expect(placeMetaBox).not.toBeNull()
  expect(boxesIntersect(placeHandleBox!, placeMetaBox!)).toBe(false)
  expect(placeMetaBox!.y).toBeGreaterThanOrEqual(
    placeHandleBox!.y + placeHandleBox!.height - 0.5,
  )
  expect(await placeMeta.evaluate(element => {
    const range = document.createRange()
    range.selectNodeContents(element)
    return range.getClientRects().length
  })).toBeGreaterThanOrEqual(2)

  const placePortraitBox = await placeRow.locator('.entity-portrait').boundingBox()
  expect(placePortraitBox).not.toBeNull()
  expect(placePortraitBox!.y).toBeLessThan(placeHandleBox!.y + placeHandleBox!.height)
  expect(placePortraitBox!.y + placePortraitBox!.height).toBeGreaterThan(placeHandleBox!.y)

  const undrawnPlaceRow = page.locator('#place-occupants .person-card')
    .filter({ hasText: 'off-by-one' })
  await expect(undrawnPlaceRow).toHaveCount(1)
  await expect(undrawnPlaceRow.locator('.entity-portrait')).toHaveCount(0)
  const [phoneUndrawnHandleBox, phoneUndrawnMetaBox] = await Promise.all([
    undrawnPlaceRow.locator('.resident-follow').boundingBox(),
    undrawnPlaceRow.locator('.resident-number').boundingBox(),
  ])
  expect(phoneUndrawnHandleBox).not.toBeNull()
  expect(phoneUndrawnMetaBox).not.toBeNull()
  expect(boxesIntersect(phoneUndrawnHandleBox!, phoneUndrawnMetaBox!)).toBe(false)
  expect(phoneUndrawnMetaBox!.y).toBeGreaterThanOrEqual(
    phoneUndrawnHandleBox!.y + phoneUndrawnHandleBox!.height - 0.5,
  )
  expect(phoneUndrawnHandleBox!.x).toBeLessThan(placeHandleBox!.x)

  await page.setViewportSize({ width: 1280, height: 900 })
  for (const row of [placeRow, undrawnPlaceRow]) {
    const [handleBox, metaBox] = await Promise.all([
      row.locator('.resident-follow').boundingBox(),
      row.locator('.resident-number').boundingBox(),
    ])
    expect(handleBox).not.toBeNull()
    expect(metaBox).not.toBeNull()
    expect(boxesIntersect(handleBox!, metaBox!)).toBe(false)
  }
  const [desktopDrawnHandleBox, desktopUndrawnHandleBox] = await Promise.all([
    placeRow.locator('.resident-follow').boundingBox(),
    undrawnPlaceRow.locator('.resident-follow').boundingBox(),
  ])
  expect(desktopDrawnHandleBox).not.toBeNull()
  expect(desktopUndrawnHandleBox).not.toBeNull()
  expect(desktopUndrawnHandleBox!.x).toBeLessThan(desktopDrawnHandleBox!.x)

  await page.setViewportSize({ width: 390, height: 844 })

  const thing = page.locator('#place-things .thing-card').filter({ hasText: 'field_lantern' })
  const [thingNameBox, thingMetaBox] = await Promise.all([
    thing.locator('h4').boundingBox(),
    thing.locator('.thing-meta').boundingBox(),
  ])
  expect(thingNameBox).not.toBeNull()
  expect(thingMetaBox).not.toBeNull()
  expect(boxesIntersect(thingNameBox!, thingMetaBox!)).toBe(false)
  expect(thingMetaBox!.y).toBeGreaterThanOrEqual(thingNameBox!.y + thingNameBox!.height - 0.5)

  await page.getByRole('tab', { name: 'Map', exact: true }).click()
  const rosterRow = page.locator('#resident-roster .resident-row')
    .filter({ hasText: 'fable-lyrebird' })
  await expect(rosterRow).toBeVisible()
  const rosterMeta = rosterRow.locator('.resident-number')
  await rosterMeta.evaluate(element => {
    element.textContent =
      'resident #49 · at frontier valley / the corrigenda room / the long lantern gallery'
  })
  const [rosterHandleBox, rosterMetaBox] = await Promise.all([
    rosterRow.locator('.resident-follow').boundingBox(),
    rosterMeta.boundingBox(),
  ])
  expect(rosterHandleBox).not.toBeNull()
  expect(rosterMetaBox).not.toBeNull()
  expect(boxesIntersect(rosterHandleBox!, rosterMetaBox!)).toBe(false)
  expect(rosterMetaBox!.y).toBeGreaterThanOrEqual(
    rosterHandleBox!.y + rosterHandleBox!.height - 0.5,
  )
  expect(await rosterMeta.evaluate(element => {
    const range = document.createRange()
    range.selectNodeContents(element)
    return range.getClientRects().length
  })).toBeGreaterThanOrEqual(2)

  await page.setViewportSize({ width: 1280, height: 900 })
  const [desktopRosterHandleBox, desktopRosterMetaBox] = await Promise.all([
    rosterRow.locator('.resident-follow').boundingBox(),
    rosterMeta.boundingBox(),
  ])
  expect(desktopRosterHandleBox).not.toBeNull()
  expect(desktopRosterMetaBox).not.toBeNull()
  expect(boxesIntersect(desktopRosterHandleBox!, desktopRosterMetaBox!)).toBe(false)
})

test('each visible view has one share button that copies its absolute clean URL', async ({ page }) => {
  await installClipboardRecorder(page)
  await page.goto('/window')
  await expect(page.locator('#window-status')).toContainText('Watching')

  const views = [
    { tab: 'Map', path: '/window/map' },
    { tab: 'Things', path: '/window/things' },
    { tab: 'Place', path: '/window/place/11' },
    { tab: 'Conversations', path: '/window/conversations?place=11' },
    { tab: 'Happenings', path: '/window/happenings?place=11' },
    { tab: 'Agreements', path: '/window/agreements?place=11' },
    { tab: 'Archive', path: '/window/archive?place=11' },
    { tab: 'Gazette', path: '/window/gazette' },
  ] as const
  const expectedLinks: string[] = []

  for (const view of views) {
    await page.getByRole('tab', { name: view.tab, exact: true }).click()
    const currentUrl = new URL(page.url())
    expect(currentUrl.pathname + currentUrl.search).toBe(view.path)
    expect(currentUrl.hash).toBe('')

    const visiblePanel = page.locator('[role="tabpanel"]:visible')
    await expect(visiblePanel).toHaveCount(1)
    const shareButton = visiblePanel.locator('[data-share-scope="view"]')
    await expect(shareButton).toHaveCount(1)
    await expect(page.locator('[data-share-scope="view"]:visible')).toHaveCount(1)

    await shareButton.click()
    expectedLinks.push(currentUrl.origin + view.path)
    await expect.poll(() => copiedShareLinks(page)).toEqual(expectedLinks)
  }
})

test('an unproven Gazette issue restores and shares without claiming it exists in metadata', async ({ page }) => {
  const residentBody = 'This resident body belongs in the page, never in an unfurl.'
  await page.route('**/api/gazette**', route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/gazette') {
      return route.fulfill({
        json: {
          first_print_at: '2026-08-31T16:00:00.000Z',
          submission_room: { place_id: 454, submissions_open: true },
          issues: [{
            issue_number: 7,
            scheduled_for: '2026-10-12T16:00:00.000Z',
            printed_at: '2026-10-12T16:00:02.000Z',
            entry_count: 1,
          }],
          has_more: false,
          next_before_issue_number: null,
        },
      })
    }
    if (url.pathname === '/api/gazette/7') {
      return route.fulfill({
        json: {
          issue: {
            issue_number: 7,
            scheduled_for: '2026-10-12T16:00:00.000Z',
            printed_at: '2026-10-12T16:00:02.000Z',
            header: 'Permanent issue 7 provenance from Room #454.',
            entry_count: 1,
          },
          entries: [{
            ordinal: 1,
            note_id: 701,
            author: 'leafwalker',
            body: residentBody,
            created_at: '2026-10-12T15:55:00.000Z',
          }],
          has_more: false,
          next_after_ordinal: null,
        },
      })
    }
    return route.abort('failed')
  })
  await installClipboardRecorder(page)

  const navigation = await page.goto('/window/gazette?issue=7')
  expect(navigation?.status()).toBe(200)
  await expect(page).toHaveTitle('The Gazette · Issue 7 could not be checked — 1F3D9')
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    'content',
    'The Gazette · Issue 7 could not be checked — 1F3D9',
  )
  const unfurlDescription = await page.locator('meta[property="og:description"]')
    .getAttribute('content')
  expect(unfurlDescription).toContain('public availability could not be checked right now')
  expect(unfurlDescription).not.toContain(residentBody)
  expect(unfurlDescription).not.toContain('leafwalker')
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    new URL('/gazette/7', page.url()).href,
  )
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    'content',
    new URL('/gazette/7/card.png', page.url()).href,
  )

  await expect(page.getByRole('tab', { name: 'Gazette', exact: true }))
    .toHaveAttribute('aria-selected', 'true')
  const panel = page.locator('#gazette-panel')
  await expect(panel.getByRole('status')).toHaveText(
    'Room #454 is open for Gazette submissions.',
  )
  await expect(panel).toContainText('Issue 7')
  await expect(panel).toContainText(residentBody)
  const readIssue = panel.getByRole('link', { name: 'Read issue 7', exact: true })
  const shareIssue = panel.getByRole('button', { name: 'Share issue 7', exact: true })
  await expect(readIssue).toHaveAttribute('href', '/gazette/7')
  await expect(shareIssue).toBeVisible()
  const [readBox, shareBox] = await Promise.all([readIssue.boundingBox(), shareIssue.boundingBox()])
  expect(readBox).not.toBeNull()
  expect(shareBox).not.toBeNull()
  expect(Math.abs((readBox?.y ?? 0) - (shareBox?.y ?? 0))).toBeLessThan(1)
  expect(Math.abs((readBox?.height ?? 0) - (shareBox?.height ?? 0))).toBeLessThan(1)
  await expect(panel.locator('.gazette-issue-summary button')).toHaveCount(0)
  await shareIssue.click()
  await expect.poll(() => copiedShareLinks(page)).toEqual([
    new URL('/gazette/7', page.url()).href,
  ])
})

test('a filtered Place URL survives server render and browser restoration exactly', async ({ page }) => {
  const path = '/window/place/11?resident=browser-resident&context=place&find=field&sleepers=11'
  const navigation = await page.goto(path)
  expect(navigation?.status()).toBe(200)
  await expect(page.locator('#window-status')).toContainText('Watching')
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(path)
  await expect(page.locator('#resident-filter')).toHaveValue('browser-resident')
  await expect(page.locator('#directory-search')).toHaveValue('field')

  await page.reload()

  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(path)
  await expect(page.locator('#resident-filter')).toHaveValue('browser-resident')
  await expect(page.locator('#directory-search')).toHaveValue('field')
})

test('place, thing, and note details each copy one absolute clean live-record URL', async ({ page, context }) => {
  await installClipboardRecorder(page)
  const navigation = await page.goto('/window/place/11')
  expect(navigation?.status()).toBe(200)
  await expect(page.locator('#window-status')).toContainText('Watching')

  const origin = new URL(page.url()).origin
  const expectedLinks = [`${origin}/window/place/11`]
  const placePanel = page.locator('#place-panel')
  await expect(placePanel).toBeVisible()
  await expect(page.locator('#record-detail')).toBeHidden()
  await expect(placePanel.locator('[data-share-scope="view"]')).toHaveCount(1)
  await placePanel.locator('[data-share-scope="view"]').click()
  await expect.poll(() => copiedShareLinks(page)).toEqual(expectedLinks)

  await page.locator('#place-things .thing-detail-link', { hasText: 'field_lantern' }).click()
  await expect(page).toHaveURL(`${origin}/window/thing/401`)
  const detail = page.locator('#record-detail')
  await expect(detail).toBeVisible()
  await expect(detail.locator('[data-share-scope="detail"]')).toHaveCount(1)
  await expect(detail.locator('#record-detail-title')).toHaveText('field_lantern')
  await expect(detail.locator(
    '#record-detail-title .entity-portrait[data-portrait-type="thing"] img',
  )).toHaveAttribute('src', /\/api\/drawing\/thing\/401\/thumb\.png/u)
  await detail.locator('[data-share-scope="detail"]').click()
  expectedLinks.push(`${origin}/window/thing/401`)
  await expect.poll(() => copiedShareLinks(page)).toEqual(expectedLinks)
  const thingRecipient = await context.newPage()
  await thingRecipient.goto(`${origin}/window/thing/401`)
  await expect(thingRecipient.locator('#record-detail')).toBeVisible()
  await expect(thingRecipient.locator('#record-detail-title')).toHaveText('field_lantern')
  await thingRecipient.close()

  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page).toHaveURL(`${origin}/window/place/11`)
  await page.getByRole('link', { name: 'Open note #301', exact: true }).click()
  await expect(page).toHaveURL(`${origin}/window/note/301`)
  await expect(detail).toBeVisible()
  await expect(detail.locator('[data-share-scope="detail"]')).toHaveCount(1)
  await expect(detail.locator('#record-detail-body')).toContainText(NOTE_FULL)
  await expect(detail.locator('[data-portrait-type="note"]')).toHaveCount(0)
  await detail.locator('[data-share-scope="detail"]').click()
  expectedLinks.push(`${origin}/window/note/301`)
  await expect.poll(() => copiedShareLinks(page)).toEqual(expectedLinks)

  const shareImage = await page.request.get('/share/thing.png')
  expect(shareImage.status()).toBe(200)
  expect(shareImage.headers()['content-type']).toContain('image/png')
})

test('clipboard denial leaves the clean absolute URL visibly available', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText() {
          return Promise.reject(new DOMException('clipboard denied', 'NotAllowedError'))
        },
      },
    })
  })
  await page.goto('/window/map')
  await expect(page.locator('#window-status')).toContainText('Watching')

  await page.locator('[role="tabpanel"]:visible [data-share-scope="view"]').click()
  const expectedUrl = `${new URL(page.url()).origin}/window/map`
  await expect(page.locator('#share-status')).toHaveText(
    `The link could not copy. Copy this URL: ${expectedUrl}`,
  )
  await expect(page.locator('#share-status')).toHaveAttribute('data-tone', 'error')
})

test('Archive refuses a credential without searching or changing its address', async ({ page }) => {
  const searchRequests: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname === '/api/search') searchRequests.push(url.href)
  })
  await page.goto('/window/archive')
  await expect(page.locator('#window-status')).toContainText('Watching')
  const addressBeforeSearch = page.url()

  await page.locator('#archive-query').fill(`where ${SYNTHETIC_RESIDENT_KEY} appeared`)
  await page.locator('#archive-search').click()

  await expect(page.locator('#archive-results .error-row')).toHaveText(
    CREDENTIAL_RECOVERY_INSTRUCTION,
  )
  expect(page.url()).toBe(addressBeforeSearch)
  expect(searchRequests).toEqual([])
})

test('closing an in-window detail prevents Back from reopening that detail', async ({ page }) => {
  await page.goto('/window/map')
  await expect(page.locator('#window-status')).toContainText('Watching')
  await page.getByRole('tab', { name: 'Place', exact: true }).click()
  await expect(page).toHaveURL(/\/window\/place\/11$/u)

  await page.locator('#place-things .thing-detail-link', { hasText: 'field_lantern' }).click()
  const detail = page.locator('#record-detail')
  await expect(page).toHaveURL(/\/window\/thing\/401$/u)
  await expect(detail.locator('#record-detail-title')).toHaveText('field_lantern')

  await page.evaluate(() => {
    const heldBack = history.back.bind(history)
    const heldShowModal = HTMLDialogElement.prototype.showModal
    const trackedWindow = window as Window & {
      __detailShowModalCalls?: number
      __releaseHeldBack?: () => void
      __restoreDetailShowModal?: () => void
    }
    trackedWindow.__detailShowModalCalls = 0
    HTMLDialogElement.prototype.showModal = function showModal() {
      trackedWindow.__detailShowModalCalls = (trackedWindow.__detailShowModalCalls || 0) + 1
      return heldShowModal.call(this)
    }
    history.back = () => {}
    trackedWindow.__releaseHeldBack = () => {
      history.back = heldBack
      heldBack()
    }
    trackedWindow.__restoreDetailShowModal = () => {
      HTMLDialogElement.prototype.showModal = heldShowModal
    }
  })
  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(detail).toBeHidden()
  await expect(page).toHaveURL(/\/window\/thing\/401$/u)
  expect(await page.evaluate(() => history.state?.windowDetailEntry)).toBe(true)
  expect(await page.evaluate(() => (
    window as Window & { __detailShowModalCalls?: number }
  ).__detailShowModalCalls)).toBe(0)
  await page.evaluate(() => (
    window as Window & { __releaseHeldBack?: () => void }
  ).__releaseHeldBack?.())
  await expect(page).toHaveURL(/\/window\/place\/11$/u)
  await expect(detail).toBeHidden()

  await page.goForward()
  await expect(page).toHaveURL(/\/window\/thing\/401$/u)
  await expect(detail.locator('#record-detail-title')).toHaveText('field_lantern')
  await expect(detail).toBeVisible()
  expect(await page.evaluate(() => history.state?.windowDetailEntry)).toBe(true)
  expect(await page.evaluate(() => (
    window as Window & { __detailShowModalCalls?: number }
  ).__detailShowModalCalls)).toBe(1)

  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page).toHaveURL(/\/window\/place\/11$/u)
  await expect(detail).toBeHidden()
  expect(await page.evaluate(() => (
    window as Window & { __detailShowModalCalls?: number }
  ).__detailShowModalCalls)).toBe(1)
  await page.evaluate(() => (
    window as Window & { __restoreDetailShowModal?: () => void }
  ).__restoreDetailShowModal?.())
})

test('closing a directly loaded detail falls back to the map deterministically', async ({ page }) => {
  await page.goto('/window/thing/401')
  const detail = page.locator('#record-detail')
  await expect(detail.locator('#record-detail-title')).toHaveText('field_lantern')

  await detail.getByRole('button', { name: 'Close', exact: true }).click()

  await expect(page).toHaveURL(/\/window\/map$/u)
  await expect(detail).toBeHidden()
  await expect(page.getByRole('tab', { name: 'Map', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
})

test('share copy feedback resets whenever the canonical target changes', async ({ page }) => {
  await installClipboardRecorder(page)
  await page.goto('/window/place/11')
  await expect(page.locator('#window-status')).toContainText('Watching')
  const origin = new URL(page.url()).origin
  const placeShare = page.locator('#place-panel [data-share-scope="view"]')

  await placeShare.click()
  await expect(placeShare).toHaveText('View link copied')
  await expect(page.locator('#share-status')).toHaveText(
    `Link copied: ${origin}/window/place/11`,
  )

  await page.locator('#place-things .thing-detail-link', { hasText: 'field_lantern' }).click()
  const detail = page.locator('#record-detail')
  const detailShare = detail.locator('[data-share-scope="detail"]')
  const detailShareStatus = detail.locator('#record-detail-share-status')
  await expect(detail.locator('#record-detail-title')).toHaveText('field_lantern')
  await expect(placeShare).toHaveText('Share this view')
  await expect(page.locator('#share-status')).toBeEmpty()
  await expect(detailShare).toHaveText('Share this detail')
  await expect(detailShareStatus).toBeEmpty()

  await detailShare.click()
  await expect(detailShare).toHaveText('Detail link copied')
  await expect(detailShareStatus).toHaveText(
    `Link copied: ${origin}/window/thing/401`,
  )

  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page).toHaveURL(/\/window\/place\/11$/u)
  await page.getByRole('link', { name: 'Open note #301', exact: true }).click()
  await expect(detail.locator('#record-detail-title')).toHaveText('Public note #301')
  await expect(detailShare).toHaveText('Share this detail')
  await expect(detailShareStatus).toBeEmpty()
})

test('an invalid public filter clears old share success before another share attempt', async ({ page }) => {
  await installClipboardRecorder(page)
  await page.goto('/window/map')
  await expect(page.locator('#window-status')).toContainText('Watching')
  const mapShare = page.locator('#map-panel [data-share-scope="view"]')

  await mapShare.click()
  await expect(mapShare).toHaveText('View link copied')
  await expect(page.locator('#share-status')).toContainText('Link copied:')

  await page.locator('#directory-search').fill(SYNTHETIC_RESIDENT_KEY)

  await expect(mapShare).toHaveText('Share this view')
  await expect(page.locator('#share-status')).toBeEmpty()
  await expect(page).toHaveURL(/\/window\/map$/u)
})

test('a delayed clipboard completion cannot repaint feedback for a newer detail', async ({ page }) => {
  await page.addInitScript(() => {
    let finishClipboardWrite: (() => void) | null = null
    Object.defineProperty(window, '__finishClipboardWrite', {
      configurable: true,
      value: () => finishClipboardWrite?.(),
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText() {
          return new Promise<void>(resolve => { finishClipboardWrite = resolve })
        },
      },
    })
  })
  await page.goto('/window/place/11')
  await expect(page.locator('#window-status')).toContainText('Watching')
  await page.locator('#place-things .thing-detail-link', { hasText: 'field_lantern' }).click()
  const detail = page.locator('#record-detail')
  const detailShare = detail.locator('[data-share-scope="detail"]')
  const detailShareStatus = detail.locator('#record-detail-share-status')
  await expect(detail.locator('#record-detail-title')).toHaveText('field_lantern')

  await detailShare.click()
  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('link', { name: 'Open note #301', exact: true }).click()
  await expect(detail.locator('#record-detail-title')).toHaveText('Public note #301')

  await page.evaluate(() => {
    (window as Window & { __finishClipboardWrite?: () => void }).__finishClipboardWrite?.()
  })
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))

  await expect(detailShare).toHaveText('Share this detail')
  await expect(detailShareStatus).toBeEmpty()
})

test('detail clipboard denial reports its fallback URL inside the dialog', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText() {
          return Promise.reject(new DOMException('clipboard denied', 'NotAllowedError'))
        },
      },
    })
  })
  await page.goto('/window/thing/401')
  const detail = page.locator('#record-detail')
  await expect(detail.locator('#record-detail-title')).toHaveText('field_lantern')
  const expectedUrl = `${new URL(page.url()).origin}/window/thing/401`

  await detail.locator('[data-share-scope="detail"]').click()

  const detailShareStatus = detail.locator('#record-detail-share-status')
  await expect(detailShareStatus).toHaveText(
    `The link could not copy. Copy this URL: ${expectedUrl}`,
  )
  await expect(detailShareStatus).toHaveAttribute('data-tone', 'error')
  await expect(page.locator('#share-status')).toBeEmpty()
})

test('public window completes deliberate excerpts and loads older happenings without writing', async ({ page }) => {
  const browserWrites: Array<{ method: string; url: string }> = []
  page.on('request', request => {
    if (isWrite(request)) browserWrites.push({ method: request.method(), url: request.url() })
  })

  const baselineResponse = await page.request.get('/__e2e/public-window-state')
  expect(baselineResponse.status()).toBe(200)
  const baselineState = await baselineResponse.json() as PublicWindowTestState
  const baselineEventCount = baselineState.event_queries?.length ?? 0
  const baselineDetailCount = baselineState.detail_requests?.length ?? 0
  const baselineWriteCount = baselineState.write_requests?.length ?? 0

  await page.goto('/window#view=place&place=11')
  await expect(page).toHaveURL(/\/window\/place\/11$/u)

  await expect(page.locator('#window-status')).toContainText('Watching')
  await expect(page.locator('#view-scope')).toContainText(
    'Excerpt limits are 2,000 characters for notes, 1,000 for things, and 4,000 for agreements.',
  )

  const thingCard = page.locator('#place-things .thing-card').filter({ hasText: 'field_lantern' })
  await expect(thingCard.locator('.thing-body')).toHaveText(`${THING_EXCERPT}…`)
  await expect(thingCard).toContainText('Excerpt only — the full text is not included in this bounded view.')
  await thingCard.getByRole('button', { name: 'Show more' }).click()
  const thingDetail = page.waitForResponse(response => {
    return new URL(response.url()).pathname === '/api/thing/401' && response.status() === 200
  })
  await thingCard.getByRole('button', { name: 'Read the whole thing' }).click()
  await thingDetail
  await expect(thingCard.locator('.thing-body')).toHaveText(THING_FULL)

  const noteCard = page.locator('#place-conversation .note-card').filter({ hasText: NOTE_EXCERPT })
  await expect(noteCard.locator('.note-body')).toHaveText(`${NOTE_EXCERPT}…`)
  await expect(noteCard).toContainText('Excerpt only — the full text is not included in this bounded view.')
  await noteCard.getByRole('button', { name: 'Show more' }).click()
  const noteDetail = page.waitForResponse(response => {
    return new URL(response.url()).pathname === '/api/note/301' && response.status() === 200
  })
  await noteCard.getByRole('button', { name: 'Read the whole note' }).click()
  await noteDetail
  await expect(noteCard.locator('.note-body')).toHaveText(NOTE_FULL)

  // Watching one place: opening Happenings fetches the place-filtered slice
  // from the server by itself instead of leaving the view falsely quiet.
  const filteredResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/events' && url.searchParams.get('within_place_id') === '11' &&
      !url.searchParams.has('before_id') &&
      url.searchParams.get('limit') === '50' && response.status() === 200
  })
  await page.getByRole('tab', { name: 'Happenings' }).click()
  await filteredResponse
  await expect(page.locator('#activity-list .activity-row')).toHaveCount(2)
  const olderResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/events' && url.searchParams.get('before_id') === '502' &&
      url.searchParams.get('within_place_id') === '11' &&
      url.searchParams.get('limit') === '50' && response.status() === 200
  })
  await page.getByRole('button', { name: 'Load older happenings' }).click()
  await olderResponse

  await expect(page.locator('#activity-list .activity-row')).toHaveCount(4)
  await expect(page.locator('#activity-list')).toContainText('oldwalker changed a place.')
  await expect(page.locator('#activity-list')).toContainText('oldwalker set their home.')
  await expect(page.getByRole('button', { name: 'Load older happenings' })).toBeHidden()

  const stateResponse = await page.request.get('/__e2e/public-window-state')
  expect(stateResponse.status()).toBe(200)
  const state = await stateResponse.json() as PublicWindowTestState
  expect((state.event_queries ?? []).slice(baselineEventCount)).toEqual([
    { before_id: null, limit: 50, within_place_id: 11 },
    { before_id: 502, limit: 50, within_place_id: 11 },
  ])
  expect((state.detail_requests ?? []).slice(baselineDetailCount)).toEqual([
    { path: '/api/thing/401', has_authorization: false, has_cookie: false },
    { path: '/api/note/301', has_authorization: false, has_cookie: false },
  ])
  expect((state.write_requests ?? []).slice(baselineWriteCount)).toEqual([])
  expect(browserWrites).toEqual([])
})

test('unfiltered happenings still page older history on demand', async ({ page }) => {
  await page.goto('/window#view=happenings')
  await expect(page.locator('#window-status')).toContainText('Watching')

  // No filter is active, so nothing fetches by itself; the snapshot slice
  // renders and the reader pages backward deliberately.
  await expect(page.locator('#activity-list .activity-row')).toHaveCount(2)
  const olderResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/events' && url.searchParams.get('before_id') === '502' &&
      !url.searchParams.has('within_place_id') &&
      url.searchParams.get('limit') === '50' && response.status() === 200
  })
  await page.getByRole('button', { name: 'Load older happenings' }).click()
  await olderResponse
  await expect(page.locator('#activity-list .activity-row')).toHaveCount(4)
  await expect(page.getByRole('button', { name: 'Load older happenings' })).toBeHidden()
})

test('all-place conversations stay newest-first and name each room', async ({ page }) => {
  await page.goto('/window#view=conversations')
  await expect(page.locator('#window-status')).toContainText('Watching')

  const cards = page.locator('#conversation-stream .note-card')
  await expect(cards).toHaveCount(3)
  expect(await cards.locator('.note-body').allTextContents()).toEqual([
    'Newest in test square',
    'Middle in side room',
    `${NOTE_EXCERPT}…`,
  ])
  await expect(cards.nth(0).locator('.note-meta')).toContainText('test_square')
  await expect(cards.nth(1).locator('.note-meta')).toContainText('side_room')
})

test('the city-wide Things and Conversations feeds withhold a quiet place while naming the rest', async ({ page }) => {
  // Second review pass on row 75: neither city-wide feed scopes to any one
  // place, so a note or thing recorded in a quiet place must withhold by
  // its own place_id even though nothing about the request names that
  // place at all.
  const quietThingHeading = Object.freeze({
    id: 402,
    place_id: 13,
    name: 'hidden_lantern',
    kind_id: null,
    kind: null,
    maker_id: 48,
    made_by: 'oldwalker',
    current_owner_id: 48,
    current_owner: 'oldwalker',
    body_text_bytes: 30,
    created_at: '2026-08-13T19:06:30.000Z',
    has_drawing: false,
  })
  const ordinaryThingHeading = Object.freeze({
    id: 401,
    place_id: 11,
    name: 'field_lantern',
    kind_id: 77,
    kind: 'artifact',
    maker_id: 49,
    made_by: 'browser-resident',
    current_owner_id: 49,
    current_owner: 'browser-resident',
    body_text_bytes: THING_EXCERPT.length,
    created_at: '2026-08-13T19:02:00.000Z',
    has_drawing: true,
  })
  await page.route('**/api/window**', async route => {
    const url = new URL(route.request().url())
    const collection = url.searchParams.get('collection')
    if (collection === 'things' && url.searchParams.get('presentation') === 'headings') {
      return route.fulfill({
        json: {
          things: [quietThingHeading, ordinaryThingHeading],
          has_more: false,
          next_before_id: null,
          change_marker: '9',
        },
      })
    }
    if (collection) return route.continue()
    const response = await route.fetch()
    const body = await response.json() as Record<string, unknown>
    await route.fulfill({ response, json: {
      ...body,
      places: [...(body.places as unknown[]), {
        id: 13, parent_id: null, name: 'back_room',
        description: 'A quiet room kept out of the ordinary rooms.',
        owner: 'oldwalker', places: 0, things: 1, notes: 1,
        moderated: false, quiet: true, children: [],
      }],
      notes: [{
        id: 304, place_id: 13, author: 'oldwalker',
        body: 'Said quietly in the back room', created_at: '2026-08-13T19:06:00.000Z',
        moderated: false,
      }, ...(body.notes as unknown[])],
      totals: { ...(body.totals as Record<string, unknown>), conversations: 4, things: 2 },
    } })
  })

  await page.goto('/window#view=conversations')
  await expect(page.locator('#window-status')).toContainText('Watching')
  const conversationStream = page.locator('#conversation-stream')
  const conversationCards = conversationStream.locator('.note-card')
  await expect(conversationCards).toHaveCount(4)
  await expect(conversationCards.first().locator('.quiet-room-notice')).toContainText(
    'oldwalker prefers to keep this room private.',
  )
  await expect(conversationStream).not.toContainText('Said quietly in the back room')
  // The unrelated, non-quiet room keeps naming its own author normally on
  // the very same feed.
  await expect(conversationStream).toContainText('side_room')

  await page.getByRole('tab', { name: 'Things' }).click()
  await expect(page).toHaveURL(/\/window\/things$/u)
  const thingsList = page.locator('#things-list')
  const thingRows = thingsList.locator('.thing-index-row')
  await expect(thingRows).toHaveCount(2)
  await expect(thingRows.first().locator('.quiet-room-notice')).toContainText(
    'oldwalker prefers to keep this room private.',
  )
  await expect(thingsList).not.toContainText('hidden_lantern')
  await expect(thingsList).toContainText('field_lantern')
})

test('a followed resident defaults to their words and keeps room context as a second question', async ({ page }) => {
  await page.route('**/api/window**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('collection') !== 'notes' ||
        url.searchParams.get('resident') !== 'oldwalker' || url.searchParams.has('context')) {
      return route.fallback()
    }
    return route.fulfill({
      json: {
        notes: [{
          id: 302,
          place_id: 12,
          author: 'oldwalker',
          body: 'Middle in side room',
          created_at: '2026-08-13T19:04:00.000Z',
          moderated: false,
        }, {
          id: 300,
          place_id: 12,
          author: 'oldwalker',
          body: 'An earlier thought in the side room.',
          created_at: '2026-08-13T18:58:00.000Z',
          moderated: false,
        }],
        has_more: false,
        next_before_id: null,
        change_marker: '9',
      },
    })
  })
  const residentOnlyResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/window' && url.searchParams.get('collection') === 'notes' &&
      url.searchParams.get('resident') === 'oldwalker' &&
      !url.searchParams.has('context') && url.searchParams.get('limit') === '50' &&
      response.status() === 200
  })
  await page.goto('/window#view=conversations&resident=oldwalker')
  await expect(page.locator('#window-status')).toContainText('Watching')
  await residentOnlyResponse

  const cards = page.locator('#conversation-stream .note-card')
  await expect(cards).toHaveCount(2)
  expect(await cards.locator('.note-body').allTextContents()).toEqual([
    'Middle in side room',
    'An earlier thought in the side room.',
  ])
  await expect(page.locator('#conversation-stream .context-note')).toHaveCount(0)

  const question = page.getByRole('group', { name: 'Conversation question' })
  const residentOnly = question.getByRole('button', { name: 'What oldwalker said', exact: true })
  const roomContext = question.getByRole('button', {
    name: 'What was said around oldwalker', exact: true,
  })
  await expect(residentOnly).toHaveAttribute('aria-pressed', 'true')
  await expect(roomContext).toHaveAttribute('aria-pressed', 'false')

  const contextResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/window' && url.searchParams.get('collection') === 'notes' &&
      url.searchParams.get('resident') === 'oldwalker' &&
      url.searchParams.get('context') === 'place' && url.searchParams.get('limit') === '25' &&
      response.status() === 200
  })
  await roomContext.click()
  await contextResponse

  await expect(cards).toHaveCount(3)
  expect(await cards.locator('.note-body').allTextContents()).toEqual([
    'Middle in side room',
    'An earlier thought in the side room.',
    'A neighbor answers in the side room.',
  ])
  const contextCard = page.locator('#conversation-stream .note-card.context-note')
  await expect(contextCard).toHaveCount(1)
  await expect(contextCard).toContainText('A neighbor answers in the side room.')
  await expect(contextCard).toContainText('same room · 1m earlier')
  await expect(contextCard.locator('.note-meta')).toContainText('side_room')
  await expect(roomContext).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: /Load .*conversations/ })).toBeHidden()
})

test('agreements show author consent and distinguish later signers', async ({ page }) => {
  await page.goto('/window#view=agreements')
  await expect(page.locator('#window-status')).toContainText('Watching')

  const opened = page.locator('#agreement-list .agreement-card')
    .filter({ hasText: 'A public agreement opened by its author.' })
  await expect(opened).toContainText('Open to later signers')
  await expect(opened).toContainText('Awaiting signatures')
  await expect(opened.locator('.signature-chip')).toHaveText([
    '✓ browser-resident',
    '○ oldwalker',
    '+ late-signer',
  ])

  const closed = page.locator('#agreement-list .agreement-card')
    .filter({ hasText: 'An older agreement that remains closed.' })
  await expect(closed).toContainText('Closed to later signers')

})
