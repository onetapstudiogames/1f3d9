import { expect, test } from '@playwright/test'
import { SNAPSHOT } from '../helpers/public-window-snapshot-fixtures.ts'
import { FIRST_BRANCH_PAGE, SECOND_BRANCH_PAGE, RESIDENT_PAGE, EMPTY_RESIDENT_SNAPSHOT, API_REQUESTS } from '../helpers/public-window-pagination-fixtures.ts'

export function registerPublicWindowPaginationControls() {
  test('resident presence pages load once, deduplicate, and keep honest roster scope', async ({ page }) => {
    const loadResidents = page.getByRole('button', { name: 'Load more residents' })
    await expect(loadResidents).toHaveAttribute('aria-busy', 'false')
    await expect(loadResidents).toHaveAttribute('aria-controls', 'resident-roster')

    const residentRequest = page.waitForRequest(request => {
      return new URL(request.url()).pathname === '/api/residents'
    })
    await loadResidents.focus()
    await loadResidents.click()
    const residentUrl = new URL((await residentRequest).url())
    expect(Object.fromEntries(residentUrl.searchParams)).toEqual({
      view: 'presence',
      limit: '25',
      before_id: '7',
      after_change_marker: '20',
    })

    const roster = page.locator('#resident-roster')
    await expect(roster.getByRole('button', { name: 'leafwalker', exact: true })).toHaveCount(1)
    await expect(roster.getByRole('button', { name: 'nightwatcher', exact: true })).toBeVisible()
    await expect(roster.locator('.resident-row.asleep')).toContainText('nightwatcher')
    await expect(roster.getByRole('button', { name: 'wayfarer', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Load more residents' })).toHaveCount(0)
    await expect(page.locator('#city-facts #view-scope')).not.toContainText(/loaded 1 of 3 residents/i)

    const residentOptions = await page.locator('#resident-filter option').allTextContents()
    expect(residentOptions).toEqual([
      'All residents',
      'leafwalker · Resident #7',
      'far-walker · Resident #9',
    ])
    await expect(roster.getByRole('button', { name: 'leafwalker', exact: true })).toBeFocused()
  })

  test('a failed branch page exposes an accessible retry that succeeds in place', async ({ page }) => {
    await page.unroute('**/api/map**')
    let attempts = 0
    await page.route('**/api/map**', route => {
      attempts += 1
      return attempts === 1
        ? route.fulfill({ status: 503, json: { error: 'temporary test outage' } })
        : route.fulfill({ json: FIRST_BRANCH_PAGE })
    })

    const initialBranchLoad = page.getByRole('button', { name: 'Show places inside inner_hall' })
    await expect(initialBranchLoad).toBeVisible()
    await initialBranchLoad.click()
    const branchAlert = page.locator('#place-children-12').getByRole('alert')
    await expect(branchAlert).toContainText(/could not load places inside inner_hall/i)

    const retry = page.getByRole('button', { name: 'Retry loading places inside inner_hall' })
    await expect(retry).toHaveAttribute('aria-busy', 'false')
    await expect(retry).toHaveAttribute('aria-controls', 'place-children-12')
    const retryResponse = page.waitForResponse(response => {
      return new URL(response.url()).pathname === '/api/map' && response.status() === 200
    })
    await retry.click()
    await retryResponse
    await expect(page.getByRole('button', { name: 'newest_gallery', exact: true })).toBeVisible()
    await expect(branchAlert).toHaveCount(0)
  })

  test('an empty presence page says what is empty and offers no dead load control', async ({ page }) => {
    await page.unroute('**/api/window**')
    await page.route('**/api/window**', route => route.fulfill({ json: EMPTY_RESIDENT_SNAPSHOT }))

    await page.goto('/window')
    await expect(page.locator('#window-status[role="status"]')).toContainText('Watching')
    const emptyRoster = page.locator('#resident-roster').getByRole('status')
    await expect(emptyRoster).toContainText(/no residents (?:are )?(?:loaded|shown|in the city)/i)
    await expect(page.getByRole('button', { name: 'Load more residents' })).toHaveCount(0)

    const rootCard = page.locator('.place-card').filter({
      has: page.getByRole('button', { name: 'root_plaza', exact: true }),
    })
    await expect(rootCard.locator('.place-disclosure')).toHaveCount(0)
  })

  test('residents at a confirmed missing address stay visible under an honest label', async ({ page }) => {
    await page.unroute('**/api/window**')
    await page.route('**/api/window**', route => route.fulfill({
      json: {
        ...SNAPSHOT,
        residents: [{ ...SNAPSHOT.residents[0], current_place_id: 999 }],
      },
    }))

    await page.goto('/window#view=map&place=999')
    const roster = page.locator('#resident-roster')
    await expect(roster.getByRole('button', { name: 'leafwalker', exact: true })).toBeVisible()
    await expect(roster).toContainText(/Place #999.*no public place was found/i)
    await expect(page.locator('#window-status')).toHaveAttribute('role', 'status')
  })

  test('confirmed missing selections differ from retryable focused-read failures', async ({ page }) => {
    await page.goto('/window#view=place&place=999')
    await expect(page.locator('#place-panel')).toContainText(/no public place was found/i)
    await expect(page.getByRole('button', { name: 'Retry loading this place' })).toHaveCount(0)
    await expect(page.locator('#place-panel')).not.toContainText(/could not be (?:loaded|read)/i)

    const requestsBeforePlaceConversation = API_REQUESTS.get(page)?.length ?? 0
    await page.goto('/window#view=conversations&place=999')
    await expect(page.locator('#conversations-panel')).toContainText(/no public place was found/i)
    const placeConversationRequests = (API_REQUESTS.get(page) ?? [])
      .slice(requestsBeforePlaceConversation)
      .map(value => new URL(value))
      .filter(url => url.searchParams.get('collection') === 'notes' &&
        url.searchParams.get('within_place_id') === '999')
    expect(placeConversationRequests).toHaveLength(0)

    await page.goto('/window#view=conversations&resident=missing-reader')
    await expect(page.locator('#conversations-panel')).toContainText(/no public resident was found/i)
    await expect(page.getByRole('button', { name: 'Retry loading this resident' })).toHaveCount(0)
    await expect(page.locator('#conversation-stream')).not.toContainText(/no conversation .*matches/i)

    await page.goto('/window#view=place&place=998')
    await expect(page.locator('#place-panel')).toContainText(/could not be (?:loaded|read)/i)
    await expect(page.getByRole('button', { name: 'Retry loading this place' })).toBeVisible()
    await expect(page.locator('#place-panel')).not.toContainText(/no public place was found/i)

    await page.goto('/window#view=conversations&resident=failing-reader')
    await expect(page.locator('#conversations-panel')).toContainText(/could not be (?:loaded|read)/i)
    await expect(page.getByRole('button', { name: 'Retry loading this resident' })).toBeVisible()
    await expect(page.locator('#conversation-stream')).not.toContainText(/no conversation .*matches/i)
    await expect(page.locator('#conversations-panel')).not.toContainText(/no public resident was found/i)
  })

  test('unchanged branch and resident cursors become retryable errors instead of loops', async ({ page }) => {
    await page.unroute('**/api/map**')
    await page.route('**/api/map**', route => {
      const url = new URL(route.request().url())
      return route.fulfill({
        json: url.searchParams.has('before_subplace_id')
          ? {
              ...SECOND_BRANCH_PAGE,
              subplaces_page: {
                ...SECOND_BRANCH_PAGE.subplaces_page,
                has_more: true,
                next_before_subplace_id: 14,
              },
            }
          : FIRST_BRANCH_PAGE,
      })
    })
    await page.unroute('**/api/residents**')
    await page.route('**/api/residents**', route => route.fulfill({
      json: {
        ...RESIDENT_PAGE,
        has_more: true,
        next_before_id: 7,
      },
    }))

    await page.getByRole('button', { name: 'Show places inside inner_hall' }).click()
    await page.getByRole('button', { name: 'Load more places inside inner_hall' }).click()
    await expect(page.getByRole('button', {
      name: 'Retry loading places inside inner_hall',
    })).toBeVisible()

    await page.getByRole('button', { name: 'Load more residents' }).click()
    await expect(page.getByRole('button', { name: 'Retry loading residents' })).toBeVisible()
  })
}
