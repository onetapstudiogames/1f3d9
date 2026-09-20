import { expect, test } from '@playwright/test'

export function registerPublicWindowRefreshContinuations() {
  test('a history page newer than its neighboring totals fails instead of mixing markers', async ({ page }) => {
    let releaseChangeCheck!: () => void
    const heldChangeCheck = new Promise<void>(resolve => { releaseChangeCheck = resolve })
    await page.route('**/api/changes**', async route => {
      await heldChangeCheck
      return route.fulfill({
        json: {
          change_marker: '20', changes: [], returned_items: 0,
          unchanged: true, has_more: false, next_since: '20',
        },
      })
    })
    await page.route('**/api/window**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('collection') !== 'notes' ||
          url.searchParams.get('resident') !== 'leafwalker') {
        return route.fallback()
      }
      return route.fulfill({
        json: {
          notes: [{
            id: 903,
            place_id: 12,
            author: 'leafwalker',
            body: 'This marker-21 note must not neighbor marker-20 totals.',
            created_at: '2026-08-16T10:03:00.000Z',
          }],
          has_more: false,
          next_before_id: null,
          change_marker: '21',
        },
      })
    })

    const historyResponse = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/window' && url.searchParams.get('collection') === 'notes' &&
        url.searchParams.get('resident') === 'leafwalker' && response.status() === 200
    })
    await page.locator('#resident-filter').selectOption('leafwalker')
    await page.getByRole('tab', { name: 'Conversations' }).click()
    await historyResponse

    const stream = page.locator('#conversation-stream')
    await expect(stream).toHaveText('Conversation could not be loaded. Retry below.')
    await expect(stream).not.toContainText('This marker-21 note')
    await expect(page.getByRole('button', {
      name: 'Retry loading conversations', exact: true,
    })).toBeVisible()
    releaseChangeCheck()
  })

  // Changed refreshes now reconcile from each list's own newest page. Gap,
  // failure, and retry behavior is covered with a real discontinuity in
  // e2e/window-reading-refresh.spec.ts.
  test('recent window slices can be extended independently in every public view', async ({ page }) => {
    await page.getByRole('tab', { name: 'Conversations' }).click()
    const olderConversationRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/window' && url.searchParams.get('collection') === 'notes' &&
        url.searchParams.get('before_id') === '21' && !url.searchParams.has('within_place_id')
    })
    await page.getByRole('button', { name: 'Load older conversations' }).click()
    await olderConversationRequest
    await expect(page.locator('#conversation-stream')).toContainText('An older conversation remains readable.')
    await expect(page.getByRole('button', { name: 'Load older conversations' })).toHaveCount(0)

    const insideThingRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/window' && url.searchParams.get('collection') === 'things' &&
        url.searchParams.get('within_place_id') === '11' && !url.searchParams.has('before_id')
    })
    const insideNoteRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/window' && url.searchParams.get('collection') === 'notes' &&
        url.searchParams.get('within_place_id') === '11' && !url.searchParams.has('before_id')
    })
    await page.getByRole('tab', { name: 'Place' }).click()
    await Promise.all([insideThingRequest, insideNoteRequest])
    await expect(page.locator('#place-things')).toContainText('old_bench')
    await expect(page.locator('#place-conversation')).toContainText('An older conversation remains readable.')

    // The place chosen on the Place tab is still watched, so Happenings
    // fetches its place-filtered slice from the server on its own.
    const filteredEventRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/events' && url.searchParams.get('within_place_id') === '11' &&
        !url.searchParams.has('before_id')
    })
    await page.getByRole('tab', { name: 'Happenings' }).click()
    await filteredEventRequest
    const olderEventRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/events' && url.searchParams.get('before_id') === '51' &&
        url.searchParams.get('within_place_id') === '11'
    })
    await page.getByRole('button', { name: 'Load older happenings' }).click()
    await olderEventRequest
    await expect(page.locator('#activity-list')).toContainText('leafwalker made a thing')

    await page.getByRole('tab', { name: 'Agreements' }).click()
    const olderAgreementRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/window' && url.searchParams.get('collection') === 'agreements' &&
        url.searchParams.get('before_id') === '41'
    })
    await page.getByRole('button', { name: 'Load older agreements' }).click()
    await olderAgreementRequest
    await expect(page.locator('#agreement-list')).toContainText('An older promise remains public.')
  })
}
