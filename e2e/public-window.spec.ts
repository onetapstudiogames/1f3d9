import { expect, test, type Request } from '@playwright/test'

const NOTE_EXCERPT = 'The public note begins here'
const THING_EXCERPT = 'A lantern with an abbreviated inscription'

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
    readonly place_id?: unknown
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

test('public window keeps excerpts bounded and loads older happenings without writing', async ({ page }) => {
  const browserWrites: Array<{ method: string; url: string }> = []
  page.on('request', request => {
    if (isWrite(request)) browserWrites.push({ method: request.method(), url: request.url() })
  })

  await page.goto('/window#view=place&place=11')

  await expect(page.getByRole('status')).toContainText('Watching')
  await expect(page.locator('#view-scope')).toContainText(
    'Excerpt limits are 2,000 characters for notes, 1,000 for things, and 4,000 for agreements.',
  )

  const thingCard = page.locator('#place-things .thing-card').filter({ hasText: 'field_lantern' })
  await expect(thingCard.locator('.thing-body')).toHaveText(`${THING_EXCERPT}…`)
  await expect(thingCard).toContainText('Excerpt only — the full text is not included in this snapshot.')
  await expect(thingCard.getByRole('button', { name: 'Read full' })).toHaveCount(0)

  const noteCard = page.locator('#place-conversation .note-card').filter({ hasText: NOTE_EXCERPT })
  await expect(noteCard.locator('.note-body')).toHaveText(`${NOTE_EXCERPT}…`)
  await expect(noteCard).toContainText('Excerpt only — the full text is not included in this snapshot.')
  await expect(noteCard.getByRole('button', { name: 'Read full' })).toHaveCount(0)

  // Watching one place: opening Happenings fetches the place-filtered slice
  // from the server by itself instead of leaving the view falsely quiet.
  const filteredResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/events' && url.searchParams.get('place_id') === '11' &&
      !url.searchParams.has('before_id') &&
      url.searchParams.get('limit') === '50' && response.status() === 200
  })
  await page.getByRole('tab', { name: 'Happenings' }).click()
  await filteredResponse
  await expect(page.locator('#activity-list .activity-row')).toHaveCount(2)
  const olderResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/events' && url.searchParams.get('before_id') === '502' &&
      url.searchParams.get('place_id') === '11' &&
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
  expect(state.event_queries).toEqual([
    { before_id: null, limit: 50, place_id: 11 },
    { before_id: 502, limit: 50, place_id: 11 },
  ])
  expect(state.detail_requests).toEqual([])
  expect(state.write_requests).toEqual([])
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
      !url.searchParams.has('place_id') &&
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

test('a followed resident shows their notes with what others said back', async ({ page }) => {
  const contextResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/window' && url.searchParams.get('collection') === 'notes' &&
      url.searchParams.get('resident') === 'oldwalker' &&
      url.searchParams.get('context') === 'place' && response.status() === 200
  })
  await page.goto('/window#view=conversations&resident=oldwalker')
  await expect(page.getByRole('status')).toContainText('Watching')
  await contextResponse

  const cards = page.locator('#conversation-stream .note-card')
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

  await page.goto('/window#view=agreements&resident=member-34')
  await expect(opened).toBeVisible()
  await expect(opened).toContainText(
    'Party preview is incomplete; this agreement stays visible in filtered views.',
  )
})
