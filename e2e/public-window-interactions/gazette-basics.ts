import { expect, test } from '@playwright/test'

export function registerPublicWindowGazetteBasics() {
  test('Gazette names the exact first print when no permanent issue exists yet', async ({ page }) => {
    await page.route('**/api/gazette**', route => route.fulfill({
      json: {
        first_print_at: '2026-08-31T16:00:00.000Z',
        submission_room: { place_id: 454, submissions_open: false },
        issues: [],
        has_more: false,
        next_before_issue_number: null,
      },
    }))

    const listRequest = page.waitForRequest(request => {
      return new URL(request.url()).pathname === '/api/gazette'
    })
    await page.getByRole('tab', { name: 'Gazette', exact: true }).click()
    const requestUrl = new URL((await listRequest).url())
    const limit = Number(requestUrl.searchParams.get('limit'))
    expect(limit).toBeGreaterThan(0)
    expect(limit).toBeLessThanOrEqual(50)
    expect(requestUrl.searchParams.has('before_issue_number')).toBe(false)

    const panel = page.locator('#gazette-panel')
    await expect(panel.getByRole('status')).toHaveText(
      'Room #454 is closed for Gazette submissions. Wait until this notice says open before submitting.',
    )
    await expect(panel.getByText(
      'No Gazette issues have printed yet. The first print is scheduled for Monday, 31 August 2026 at 16:00 UTC.',
      { exact: true },
    )).toBeVisible()
    await expect(panel).toContainText('Every Monday at 16:00 UTC')
    await expect(panel.getByRole('link', { name: 'Room #454', exact: true }))
      .toHaveAttribute('href', '/window/place/454')
    await expect(panel).toContainText('permanent public archive')
    await expect(panel.locator('[data-share-scope="view"]')).toHaveCount(1)
  })

  test('the live Gazette refreshes its first page without dropping loaded older issues', async ({ page }) => {
    let firstPageReads = 0
    await page.route('**/api/gazette**', route => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/gazette/7') {
        return route.fulfill({
          json: {
            issue: {
              issue_number: 7,
              scheduled_for: '2026-10-12T16:00:00.000Z',
              printed_at: '2026-10-12T16:00:02.000Z',
              header: 'Permanent issue 7.',
              entry_count: 0,
            },
            entries: [],
            has_more: false,
            next_after_ordinal: null,
          },
        })
      }
      if (url.pathname !== '/api/gazette') return route.abort('failed')
      if (url.searchParams.get('before_issue_number') === '7') {
        return route.fulfill({
          json: {
            first_print_at: '2026-08-31T16:00:00.000Z',
            submission_room: { place_id: 454, submissions_open: false },
            issues: [{
              issue_number: 6,
              scheduled_for: '2026-10-05T16:00:00.000Z',
              printed_at: '2026-10-05T16:00:01.000Z',
              entry_count: 0,
            }],
            has_more: false,
            next_before_issue_number: null,
          },
        })
      }
      firstPageReads += 1
      const refreshed = firstPageReads > 1
      return route.fulfill({
        json: {
          first_print_at: '2026-08-31T16:00:00.000Z',
          submission_room: { place_id: 454, submissions_open: refreshed },
          issues: [{
            issue_number: refreshed ? 8 : 7,
            scheduled_for: refreshed
              ? '2026-10-19T16:00:00.000Z'
              : '2026-10-12T16:00:00.000Z',
            printed_at: refreshed
              ? '2026-10-19T16:00:02.000Z'
              : '2026-10-12T16:00:02.000Z',
            entry_count: 0,
          }],
          has_more: true,
          next_before_issue_number: refreshed ? 8 : 7,
        },
      })
    })

    await expect(page.locator('#window-status')).toContainText('Watching')
    const firstPage = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/gazette' && !url.searchParams.has('before_issue_number')
    })
    await page.getByRole('tab', { name: 'Gazette', exact: true }).click()
    await firstPage
    const panel = page.locator('#gazette-panel')
    await expect(panel).toContainText('Issue 7')

    const olderPage = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/gazette' && url.searchParams.get('before_issue_number') === '7'
    })
    await page.getByRole('button', { name: 'Load older issues', exact: true }).click()
    await olderPage
    await expect(panel).toContainText('Issue 6')
    await expect(panel.getByRole('status')).toContainText('closed for Gazette submissions')

    const refreshedPage = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/gazette' && !url.searchParams.has('before_issue_number')
    })
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await refreshedPage

    await expect(panel.getByRole('status')).toHaveText(
      'Room #454 is open for Gazette submissions.',
    )
    for (const issueNumber of [8, 7, 6]) {
      await expect(panel).toContainText(`Issue ${issueNumber}`)
    }
    await expect(page.getByRole('button', { name: 'Load older issues', exact: true })).toHaveCount(0)
    expect(firstPageReads).toBe(2)
  })
}
