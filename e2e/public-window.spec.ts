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

test('public window links to the dated public snapshot archive', async ({ page }) => {
  await page.goto('/window')
  const link = page.getByRole('link', { name: 'Public snapshots' })
  await expect(link).toHaveAttribute(
    'href',
    'https://github.com/onetapstudiogames/1f3d9/releases?q=city-snapshot-',
  )
})

test('each visible view has one share button that copies its absolute clean URL', async ({ page }) => {
  await installClipboardRecorder(page)
  await page.goto('/window')
  await expect(page.locator('#window-status')).toContainText('Watching')

  const views = [
    { tab: 'Map', path: '/window/map' },
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
