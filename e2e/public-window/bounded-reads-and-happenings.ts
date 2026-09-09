import { expect, test, type Request } from '@playwright/test'
import { NOTE_EXCERPT, THING_EXCERPT, NOTE_FULL } from '../helpers/public-window-reading-fixtures.ts'

const THING_FULL = `${THING_EXCERPT}; the complete inscription is readable without signing in.`

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

export function registerPublicWindowBoundedReadsAndHappenings() {
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
    await page.locator('#city-facts > summary').click()
    await expect(page.locator('#city-facts #view-scope')).toBeVisible()
    await expect(page.locator('#city-facts #view-scope')).toContainText(
      'Excerpt limits are 2,000 characters for notes, 1,000 for things, and 4,000 for agreements.',
    )
    await page.locator('#city-facts > summary').click()

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
    await expect.poll(
      async () => await page.locator('#window-status').textContent() ?? '<missing>',
      {
        message: 'observed window status while waiting for unfiltered happenings',
        timeout: 10_000,
      },
    ).toContain('Watching')

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
}
