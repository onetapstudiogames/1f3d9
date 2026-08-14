import { expect, test, type Request } from '@playwright/test'

const PLACE_DESCRIPTION = 'A quiet test square with a brass observatory window.'
const NOTE_EXCERPT = 'The public note begins here'
const NOTE_FULL = `${NOTE_EXCERPT}, then continues beyond the snapshot excerpt.`
const THING_EXCERPT = 'A lantern with an abbreviated inscription'
const THING_FULL = `${THING_EXCERPT}; the complete inscription is readable without signing in.`

interface PublicWindowTestState {
  readonly write_requests?: Array<{ readonly method?: unknown; readonly path?: unknown }>
  readonly detail_requests?: Array<{
    readonly path?: unknown
    readonly has_authorization?: unknown
    readonly has_cookie?: unknown
  }>
  readonly event_queries?: Array<{ readonly before_id?: unknown; readonly limit?: unknown }>
}

function isWrite(request: Request): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(request.method())
}

test('public window reveals full excerpts and loads older happenings without writing', async ({ page }) => {
  const browserWrites: Array<{ method: string; url: string }> = []
  page.on('request', request => {
    if (isWrite(request)) browserWrites.push({ method: request.method(), url: request.url() })
  })

  await page.goto('/window#view=place&place=11')

  await expect(page.getByRole('status')).toContainText('Watching')
  await expect(page.locator('#place-focus-description')).toHaveText(PLACE_DESCRIPTION)
  await expect(page.locator('#place-focus-description')).toBeVisible()

  const thingCard = page.locator('#place-things .thing-card').filter({ hasText: 'field_lantern' })
  await expect(thingCard.locator('.thing-body')).toHaveText(`${THING_EXCERPT}…`)
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/thing/401') && response.status() === 200),
    thingCard.getByRole('button', { name: 'Read full' }).click(),
  ])
  await expect(thingCard.locator('.thing-body')).toHaveText(THING_FULL)
  await expect(thingCard.getByRole('button', { name: 'Read full' })).toHaveCount(0)

  const noteCard = page.locator('#place-conversation .note-card').filter({ hasText: NOTE_EXCERPT })
  await expect(noteCard.locator('.note-body')).toHaveText(`${NOTE_EXCERPT}…`)
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/note/301') && response.status() === 200),
    noteCard.getByRole('button', { name: 'Read full' }).click(),
  ])
  await expect(noteCard.locator('.note-body')).toHaveText(NOTE_FULL)
  await expect(noteCard.getByRole('button', { name: 'Read full' })).toHaveCount(0)

  await page.getByRole('tab', { name: 'Happenings' }).click()
  await expect(page.locator('#activity-list .activity-row')).toHaveCount(2)
  const olderResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/events' && url.searchParams.get('before_id') === '502' &&
      url.searchParams.get('limit') === '100' && response.status() === 200
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
  expect(state.event_queries).toEqual([{ before_id: 502, limit: 100 }])
  expect(state.detail_requests).toEqual([
    { path: '/api/thing/401', has_authorization: false, has_cookie: false },
    { path: '/api/note/301', has_authorization: false, has_cookie: false },
  ])
  expect(state.write_requests).toEqual([])
  expect(browserWrites).toEqual([])
})
