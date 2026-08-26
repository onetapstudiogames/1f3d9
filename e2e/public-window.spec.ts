import { expect, test, type Request } from '@playwright/test'

const NOTE_EXCERPT = 'The public note begins here'
const THING_EXCERPT = 'A lantern with an abbreviated inscription'
const NOTE_FULL = `${NOTE_EXCERPT}, then continues beyond the snapshot excerpt.`
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

test('public window links to the dated public snapshot archive', async ({ page }) => {
  await page.goto('/window')
  const link = page.getByRole('link', { name: 'Public snapshots' })
  await expect(link).toHaveAttribute(
    'href',
    'https://github.com/onetapstudiogames/1f3d9/releases?q=city-snapshot-v1-',
  )
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

  await expect(page.getByRole('status')).toContainText('Watching')
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
  await expect(page.getByRole('status')).toContainText('Watching')

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
  await expect(page.getByRole('status')).toContainText('Watching')

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
  await expect(page.getByRole('status')).toContainText('Watching')
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
  await expect(page.getByRole('status')).toContainText('Watching')

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
