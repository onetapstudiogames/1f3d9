import { expect, test } from '@playwright/test'
import { FAR_WALKER_ACTION_EVENTS } from '../helpers/public-window-snapshot-fixtures.ts'

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

  test('a filtered forward refresh newer than its neighboring totals keeps the completed rows', async ({ page }) => {
    let phase: 'initial' | 'ahead' = 'initial'
    await page.route('**/api/events**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('actor') !== 'far-walker') return route.fallback()
      return route.fulfill({
        json: {
          events: phase === 'initial'
            ? [FAR_WALKER_ACTION_EVENTS[0]]
            : FAR_WALKER_ACTION_EVENTS.slice(0, 2),
          has_more: false,
          next_before_id: null,
          change_marker: phase === 'initial' ? '20' : '21',
        },
      })
    })
    await page.route('**/api/changes**', route => route.fulfill({
      status: 503,
      json: { error: 'test change check unavailable' },
    }))

    await page.locator('#resident-filter').selectOption('far-walker')
    await page.getByRole('tab', { name: 'Happenings' }).click()
    await expect(page.locator('#activity-list')).toContainText('far-walker used')

    phase = 'ahead'
    const aheadResponse = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/events' && url.searchParams.get('actor') === 'far-walker' &&
        url.searchParams.get('after_change_marker') === '20' && response.status() === 200
    })
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await aheadResponse

    await expect(page.locator('#happenings-page')).toContainText(
      'Updated happenings could not be loaded. Showing the previous completed results.',
    )
    await expect(page.locator('#activity-list')).not.toContainText('2 times')
    await expect(page.getByRole('button', { name: 'Retry refreshing happenings' })).toBeVisible()
  })

  test('a filtered refresh names loading and failure, preserves rows, and retries itself', async ({ page }) => {
    let phase: 'initial' | 'refresh' = 'initial'
    let refreshAttempts = 0
    let releaseRefresh!: () => void
    const heldRefresh = new Promise<void>(resolve => { releaseRefresh = resolve })
    await page.route('**/api/events**', async route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('actor') !== 'far-walker') return route.fallback()
      if (phase === 'initial') {
        return route.fulfill({
          json: {
            events: [FAR_WALKER_ACTION_EVENTS[0]], has_more: false,
            next_before_id: null, change_marker: '20',
          },
        })
      }
      refreshAttempts += 1
      if (refreshAttempts === 1) {
        await heldRefresh
        return route.fulfill({ status: 503, json: { error: 'test forward refresh failure' } })
      }
      return route.fulfill({
        json: {
          events: FAR_WALKER_ACTION_EVENTS.slice(0, 2), has_more: false,
          next_before_id: null, change_marker: '20',
        },
      })
    })
    await page.route('**/api/changes**', route => route.fulfill({
      status: 503,
      json: { error: 'test change check unavailable' },
    }))

    await page.locator('#resident-filter').selectOption('far-walker')
    await page.getByRole('tab', { name: 'Happenings' }).click()
    await expect(page.locator('#activity-list')).toContainText('far-walker')
    phase = 'refresh'
    const refreshRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/events' && url.searchParams.get('actor') === 'far-walker' &&
        url.searchParams.get('after_change_marker') === '20'
    })
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await refreshRequest
    await expect(page.locator('#happenings-page')).toContainText('Loading updated happenings…')
    await expect(page.locator('#activity-list')).toContainText('far-walker')
    releaseRefresh()
    await expect(page.locator('#happenings-page')).toContainText(
      'Updated happenings could not be loaded. Showing the previous completed results.',
    )
    const retry = page.getByRole('button', { name: 'Retry refreshing happenings' })
    await expect(retry).toBeVisible()
    const success = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/events' && url.searchParams.get('actor') === 'far-walker' &&
        response.status() === 200
    })
    await retry.click()
    await success
    await expect(page.locator('#happenings-page')).not.toContainText('could not be loaded')
  })

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
