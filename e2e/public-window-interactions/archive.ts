import { expect, test } from '@playwright/test'

export function registerPublicWindowArchive() {
  test('Archive finds an old body-free result and follows its opaque continuation', async ({ page }) => {
    const requests: URL[] = []
    await page.route('**/api/search**', route => {
      const url = new URL(route.request().url())
      requests.push(url)
      const older = url.searchParams.get('before') === 'older-search-page'
      return route.fulfill({
        json: {
          query: 'hush lantern',
          mode: 'phrase',
          type: 'thing',
          results: [older ? {
            type: 'thing', id: 30, place_id: 11, name: 'old_hush_lantern',
            owner_id: 7, owner: 'leafwalker', open_to_use: false,
            body_text_bytes: 47, created_at: '2026-08-13T10:00:00.000000Z',
            href: '/api/thing/30',
          } : {
            type: 'thing', id: 31, place_id: 11, name: 'new_hush_lantern',
            owner_id: 7, owner: 'leafwalker', open_to_use: true,
            body_text_bytes: 52, created_at: '2026-08-14T10:00:00.000000Z',
            href: '/api/thing/31',
          }],
          total_items: 2,
          total_text_bytes: 99,
          returned_items: 1,
          returned_text_bytes: 0,
          has_more: !older,
          next_before: older ? null : 'older-search-page',
          change_marker: '7',
        },
      })
    })

    await page.getByRole('tab', { name: 'Archive' }).click()
    await page.locator('#archive-query').fill('hush lantern')
    await page.locator('#archive-mode').selectOption('phrase')
    await page.locator('#archive-type').selectOption('thing')
    await page.locator('#archive-search').click()

    await expect(page.locator('#archive-results')).toContainText('new_hush_lantern')
    await expect(page.locator('#archive-results')).not.toContainText('secret body text')
    await expect(page.locator('#archive-results').getByRole('link', { name: 'Open detail' }))
      .toHaveAttribute('href', '/window/thing/31')
    expect(requests[0]?.searchParams.get('q')).toBe('hush lantern')
    expect(requests[0]?.searchParams.get('mode')).toBe('phrase')
    expect(requests[0]?.searchParams.get('type')).toBe('thing')
    expect(requests[0]?.searchParams.get('limit')).toBe('25')

    await page.getByRole('button', { name: 'Load older matches' }).click()
    await expect(page.locator('#archive-results')).toContainText('old_hush_lantern')
    expect(requests[1]?.searchParams.get('before')).toBe('older-search-page')
    await expect(page.locator('#archive-results').getByRole('link', { name: 'Open detail' }))
      .toHaveCount(2)
  })

  test('Archive rejects an incomplete page without its promised continuation', async ({ page }) => {
    await page.route('**/api/search**', route => route.fulfill({
      json: {
        results: [{
          type: 'note', id: 41, place_id: 11, author: 'leafwalker',
          body_text_bytes: 21, created_at: '2026-08-14T10:00:00.000000Z',
        }],
        total_items: 2,
        total_text_bytes: 42,
        returned_items: 1,
        returned_text_bytes: 0,
        has_more: true,
        next_before: null,
        change_marker: '20',
      },
    }))

    await page.getByRole('tab', { name: 'Archive' }).click()
    await page.locator('#archive-query').fill('missing cursor')
    await page.locator('#archive-search').click()

    await expect(page.locator('#archive-results')).toContainText('Search could not be loaded')
    await expect(page.locator('#archive-results').getByRole('button', { name: 'Retry search' }))
      .toBeVisible()
    await expect(page.locator('#archive-results')).not.toContainText('Public note #41')
  })

  test('clean Archive URL restores and automatically runs the question', async ({ page }) => {
    const requests: URL[] = []
    await page.route('**/api/search**', route => {
      const url = new URL(route.request().url())
      requests.push(url)
      return route.fulfill({
        json: {
          query: url.searchParams.get('q'),
          mode: url.searchParams.get('mode'),
          type: url.searchParams.get('type'),
          results: [{
            type: 'thing', id: 31, place_id: 11, name: 'shared_hush_lantern',
            owner_id: 7, owner: 'leafwalker', open_to_use: true,
            body_text_bytes: 52, created_at: '2026-08-14T10:00:00.000000Z',
            href: '/api/thing/31',
          }],
          total_items: 1,
          total_text_bytes: 52,
          returned_items: 1,
          returned_text_bytes: 0,
          has_more: false,
          next_before: null,
          change_marker: '20',
        },
      })
    })

    await page.getByRole('tab', { name: 'Archive' }).click()
    await page.locator('#archive-query').fill('hush lantern')
    await page.locator('#archive-mode').selectOption('phrase')
    await page.locator('#archive-type').selectOption('thing')
    await page.locator('#archive-search').click()
    await expect(page.locator('#archive-results')).toContainText('shared_hush_lantern')

    const cleanUrl = new URL(page.url())
    expect(cleanUrl.pathname + cleanUrl.search).toBe(
      '/window/archive?q=hush+lantern&mode=phrase&type=thing',
    )
    expect(cleanUrl.hash).toBe('')

    const restoredSearch = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/search' && url.searchParams.get('q') === 'hush lantern'
    })
    await page.reload()
    await restoredSearch

    await expect(page.locator('#archive-query')).toHaveValue('hush lantern')
    await expect(page.locator('#archive-mode')).toHaveValue('phrase')
    await expect(page.locator('#archive-type')).toHaveValue('thing')
    await expect(page.locator('#archive-results')).toContainText('shared_hush_lantern')
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(
      '/window/archive?q=hush+lantern&mode=phrase&type=thing',
    )
    expect(requests).toHaveLength(2)
  })

  test('Archive hash navigation cannot be overwritten by an older search response', async ({ page }) => {
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const heldFirst = new Promise<void>(resolve => { releaseFirst = resolve })
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve })
    await page.route('**/api/search**', async route => {
      const url = new URL(route.request().url())
      const query = url.searchParams.get('q') ?? ''
      if (query === 'first question') {
        markFirstStarted()
        await heldFirst
      }
      return route.fulfill({
        json: {
          query,
          mode: url.searchParams.get('mode'),
          type: url.searchParams.get('type'),
          results: [{
            type: 'note', id: query === 'first question' ? 41 : 42, place_id: 11,
            author_id: 7, author: 'leafwalker',
            body: query === 'first question' ? 'STALE FIRST RESULT' : 'CURRENT SECOND RESULT',
            body_text_bytes: 21, created_at: '2026-08-14T10:00:00.000000Z',
            href: query === 'first question' ? '/api/note/41' : '/api/note/42',
          }],
          total_items: 1,
          total_text_bytes: 21,
          returned_items: 1,
          returned_text_bytes: 21,
          has_more: false,
          next_before: null,
          change_marker: '20',
        },
      })
    })

    await page.getByRole('tab', { name: 'Archive' }).click()
    await page.locator('#archive-query').fill('first question')
    await page.locator('#archive-search').click()
    await firstStarted

    const secondRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/search' && url.searchParams.get('q') === 'second question'
    })
    await page.evaluate(() => {
      window.location.hash = '#view=archive&q=second+question&mode=words&type=note'
    })
    await secondRequest
    await expect(page.locator('#archive-results')).toContainText('Public note #42')

    const firstResponse = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/search' && url.searchParams.get('q') === 'first question'
    })
    releaseFirst()
    await firstResponse
    await page.evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
    await expect(page.locator('#archive-results')).toContainText('Public note #42')
    await expect(page.locator('#archive-results')).not.toContainText('Public note #41')
  })
}
