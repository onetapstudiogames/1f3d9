import { expect, test } from '@playwright/test'
import { SNAPSHOT } from '../helpers/public-window-snapshot-fixtures.ts'
import { API_REQUESTS, OLDER_THING } from '../helpers/public-window-pagination-fixtures.ts'

export function registerPublicWindowSnapshotRefresh() {
  test('a confirmed unchanged return refreshes presence without reloading authored text', async ({ page }) => {
    await page.getByRole('tab', { name: 'Place' }).click()
    await expect(page.locator('#place-conversation')).toContainText('Opening note.')
    await page.route('**/api/changes**', route => {
      const since = new URL(route.request().url()).searchParams.get('since')
      return route.fulfill({
        json: since === '20'
          ? {
            change_marker: '20', changes: [], returned_items: 0,
            unchanged: true, has_more: false, next_since: '20',
          }
          : { change_marker: '20' },
      })
    })

    const windowReadsBeforeUnchanged = (API_REQUESTS.get(page) ?? [])
      .filter(value => new URL(value).pathname === '/api/window').length
    const unchangedResponse = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/changes' && url.searchParams.get('since') === '20'
    })
    const presenceResponse = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/residents' && url.searchParams.get('view') === 'presence'
    })
    await page.evaluate(() => {
      const liveRegions = [...document.querySelectorAll('[aria-live], [role="status"]')]
      if (!liveRegions.length) throw new Error('window live regions are missing')
      const tracked = window as typeof window & { __windowLiveMutations?: Record<string, number> }
      tracked.__windowLiveMutations = Object.fromEntries(liveRegions.map((region, index) => [
        region.id || `live-region-${index}`,
        0,
      ]))
      for (const [index, region] of liveRegions.entries()) {
        const key = region.id || `live-region-${index}`
        new MutationObserver(records => {
          const counts = tracked.__windowLiveMutations ?? {}
          counts[key] = (counts[key] ?? 0) + records.length
        }).observe(region, { attributes: true, childList: true, characterData: true, subtree: true })
      }
    })
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await Promise.all([unchangedResponse, presenceResponse])
    await page.evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
    await expect(page.locator('#window-status')).toHaveText('Watching the public streets')
    expect(await page.evaluate(() => Object.entries((
      window as typeof window & { __windowLiveMutations?: Record<string, number> }
    ).__windowLiveMutations ?? {}).filter(([, count]) => count !== 0))).toEqual([])

    const windowReadsAfterUnchanged = (API_REQUESTS.get(page) ?? [])
      .filter(value => new URL(value).pathname === '/api/window').length
    expect(windowReadsAfterUnchanged).toBe(windowReadsBeforeUnchanged)
    await expect(page.locator('#place-conversation')).toContainText('Opening note.')
  })

  test('an unavailable unchanged-presence read falls back to a bounded authored snapshot', async ({ page }) => {
    await page.getByRole('tab', { name: 'Place' }).click()
    await expect(page.locator('#place-conversation')).toContainText('Opening note.')
    await page.route('**/api/changes**', route => {
      const since = new URL(route.request().url()).searchParams.get('since')
      return route.fulfill({
        json: since === '20'
          ? {
            change_marker: '20', changes: [], returned_items: 0,
            unchanged: true, has_more: false, next_since: '20',
          }
          : { change_marker: '20' },
      })
    })

    await page.route('**/api/residents**', route => route.fulfill({
      status: 503,
      json: { error: 'test presence failure' },
    }))
    const unchangedRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/changes' && url.searchParams.get('since') === '20'
    })
    const failedPresence = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/residents' && url.searchParams.get('view') === 'presence'
    })
    const fallbackSnapshot = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/window' && url.searchParams.get('view') === 'outline' &&
        url.searchParams.get('after_change_marker') === '20'
    })
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await Promise.all([unchangedRequest, failedPresence, fallbackSnapshot])

    await expect(page.locator('#window-status')).toContainText('Watching')
    await expect(page.locator('#window-status')).not.toContainText('older view')
    await expect(page.locator('#place-conversation')).toContainText('Opening note.')
  })

  test('a failed changed snapshot keeps the old marker and retries the same change', async ({ page }) => {
    await page.route('**/api/changes**', route => {
      const since = new URL(route.request().url()).searchParams.get('since')
      return route.fulfill({
        json: since === '20'
          ? {
            change_marker: '21', changes: [{ change_id: '21' }], returned_items: 1,
            unchanged: false, has_more: false, next_since: '21',
          }
          : { change_marker: '21' },
      })
    })
    let snapshotAttempts = 0
    await page.route('**/api/window**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('after_change_marker') !== '21') return route.fallback()
      snapshotAttempts += 1
      if (snapshotAttempts === 1) {
        return route.fulfill({ status: 503, json: { error: 'test snapshot failure' } })
      }
      return route.fulfill({ json: { ...SNAPSHOT, change_marker: '21' } })
    })

    const firstChange = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/changes' && url.searchParams.get('since') === '20'
    })
    const firstFailure = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/window' &&
        url.searchParams.get('after_change_marker') === '21' && response.status() === 503
    })
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await Promise.all([firstChange, firstFailure])
    const staleStatus = page.locator('#window-status')
    await expect(staleStatus).toContainText('previous completed view')
    await expect(staleStatus).toHaveAttribute('data-tone', 'stale')
    const retry = page.getByRole('button', { name: 'Retry reading the public city view' })
    await expect(retry).toBeVisible()
    await expect(retry).toHaveClass('global-read-retry')

    const retriedOldMarker = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/changes' && url.searchParams.get('since') === '20'
    })
    const successfulRetry = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/window' &&
        url.searchParams.get('after_change_marker') === '21' && response.status() === 200
    })
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await Promise.all([retriedOldMarker, successfulRetry])
    expect(snapshotAttempts).toBe(2)
  })

  test('a changed snapshot drops previously loaded authored content before saving its marker', async ({ page }) => {
    await page.getByRole('tab', { name: 'Place' }).click()
    await expect(page.locator('.thing-card').filter({ hasText: 'record_lantern' })).toBeVisible()
    await page.route('**/api/changes**', route => {
      const since = new URL(route.request().url()).searchParams.get('since')
      return route.fulfill({
        json: since === '20'
          ? {
            change_marker: '21', changes: [{ change_id: '21' }], returned_items: 1,
            unchanged: false, has_more: false, next_since: '21',
          }
          : {
            change_marker: '21', changes: [], returned_items: 0,
            unchanged: true, has_more: false, next_since: '21',
          },
      })
    })
    await page.route('**/api/window**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('after_change_marker') !== '21') return route.fallback()
      return route.fulfill({
        json: {
          ...SNAPSHOT,
          change_marker: '21',
          things: [],
          totals: { ...SNAPSHOT.totals, things: 0 },
          shown: { ...SNAPSHOT.shown, things: 0 },
          pages: { ...SNAPSHOT.pages, things: { has_more: false, next_before_id: null } },
        },
      })
    })

    const coveredSnapshot = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/window' &&
        url.searchParams.get('after_change_marker') === '21'
    })
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await coveredSnapshot
    await expect(page.locator('.thing-card').filter({ hasText: 'record_lantern' })).toHaveCount(0)

    const committedMarker = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/changes' && url.searchParams.get('since') === '21'
    })
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await committedMarker
  })

  test('an older history response already in flight cannot repopulate a newer marker snapshot', async ({ page }) => {
    let releaseOlderHistory: (() => void) | null = null
    await page.route('**/api/window**', async route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('collection') !== 'things') return route.fallback()
      await new Promise<void>(resolve => {
        releaseOlderHistory = () => {
          void route.fulfill({
            json: {
              things: [OLDER_THING], has_more: false, next_before_id: null,
              change_marker: '20',
            },
          }).then(() => resolve())
        }
      })
    })
    const olderRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/window' && url.searchParams.get('collection') === 'things'
    })
    await page.getByRole('tab', { name: 'Place' }).click()
    await olderRequest

    await page.route('**/api/changes**', route => route.fulfill({
      json: {
        change_marker: '21', changes: [{ change_id: '21' }], returned_items: 1,
        unchanged: false, has_more: false, next_since: '21',
      },
    }))
    await page.route('**/api/window**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('after_change_marker') !== '21') return route.fallback()
      return route.fulfill({
        json: {
          ...SNAPSHOT,
          change_marker: '21',
          things: [],
          totals: { ...SNAPSHOT.totals, things: 0 },
          shown: { ...SNAPSHOT.shown, things: 0 },
          pages: { ...SNAPSHOT.pages, things: { has_more: false, next_before_id: null } },
        },
      })
    })
    const coveredSnapshot = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/window' && url.searchParams.get('after_change_marker') === '21'
    })
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await coveredSnapshot

    expect(releaseOlderHistory).not.toBeNull()
    releaseOlderHistory?.()
    await page.evaluate(() => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    }))
    await expect(page.locator('.thing-card').filter({ hasText: 'record_lantern' })).toHaveCount(0)
    await expect(page.locator('.thing-card').filter({ hasText: 'old_bench' })).toHaveCount(0)
  })

  test('a delayed thing detail cannot overwrite its reread after an authored refresh', async ({ page }) => {
    const staleBody = 'Stale inscription returned after the authored refresh.'
    const refreshedBody = 'Fresh inscription read after the authored refresh.'
    let detailAttempts = 0
    let markStaleDetailStarted!: () => void
    const staleDetailStarted = new Promise<void>(resolve => { markStaleDetailStarted = resolve })
    let releaseStaleDetail: (() => void) | null = null

    await page.route('**/api/thing/31', async route => {
      detailAttempts += 1
      const body = detailAttempts === 1 ? staleBody : refreshedBody
      const payload = {
        thing: {
          id: 31,
          place_id: 11,
          name: 'record_lantern',
          made_by: 'mapkeeper',
          current_owner: 'mapkeeper',
          body,
          moderated: false,
        },
      }
      if (detailAttempts !== 1) return route.fulfill({ json: payload })
      markStaleDetailStarted()
      await new Promise<void>(resolve => {
        releaseStaleDetail = () => {
          void route.fulfill({ json: payload }).then(() => resolve())
        }
      })
    })

    await page.getByRole('tab', { name: 'Place', exact: true }).click()
    await page.locator('#place-things .thing-detail-link', { hasText: 'record_lantern' }).click()
    await staleDetailStarted
    const detailBody = page.locator('#record-detail-body')
    const detailText = detailBody.locator('.record-detail-text')
    await expect(detailBody).toContainText('Reading the live public record')

    await page.route('**/api/changes**', route => route.fulfill({
      json: {
        change_marker: '21', changes: [{ change_id: '21' }], returned_items: 1,
        unchanged: false, has_more: false, next_since: '21',
      },
    }))
    await page.route('**/api/window**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('after_change_marker') !== '21') return route.fallback()
      return route.fulfill({ json: { ...SNAPSHOT, change_marker: '21' } })
    })

    const coveredSnapshot = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/window' &&
        url.searchParams.get('after_change_marker') === '21' && response.status() === 200
    })
    const refreshedDetail = page.waitForResponse(response => {
      return new URL(response.url()).pathname === '/api/thing/31' && response.status() === 200
    })
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await Promise.all([coveredSnapshot, refreshedDetail])
    expect(detailAttempts).toBe(2)
    await expect(detailText).toHaveText(refreshedBody)

    const staleDetailResponse = page.waitForResponse(response => {
      return new URL(response.url()).pathname === '/api/thing/31' && response.status() === 200
    })
    expect(releaseStaleDetail).not.toBeNull()
    releaseStaleDetail?.()
    await staleDetailResponse
    await page.evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))

    await expect(detailText).toHaveText(refreshedBody)
    await expect(detailText).not.toContainText(staleBody)
  })
}
