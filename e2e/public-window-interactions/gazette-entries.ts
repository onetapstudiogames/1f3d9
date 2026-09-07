import { expect, test } from '@playwright/test'

export function registerPublicWindowGazetteEntries() {
  test('Gazette renders attributed notes verbatim and pages issues and entries on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const unsafeFirstBody = [
      'First line exactly.',
      '<img src=x onerror="window.__gazetteMarkupRan=true">',
      'Final & line exactly.',
    ].join('\n')
    const secondBody = 'Second entry remains after the first, oldest first.'
    const requests: URL[] = []

    await page.route('**/api/gazette**', route => {
      const url = new URL(route.request().url())
      requests.push(url)
      if (url.pathname === '/api/gazette') {
        const older = url.searchParams.get('before_issue_number') === '7'
        return route.fulfill({
          json: {
            first_print_at: '2026-08-31T16:00:00.000Z',
            submission_room: { place_id: 454, submissions_open: true },
            issues: [older ? {
              issue_number: 6,
              scheduled_for: '2026-10-05T16:00:00.000Z',
              printed_at: '2026-10-05T16:00:01.000Z',
              entry_count: 0,
            } : {
              issue_number: 7,
              scheduled_for: '2026-10-12T16:00:00.000Z',
              printed_at: '2026-10-12T16:00:02.000Z',
              entry_count: 2,
            }],
            has_more: !older,
            next_before_issue_number: older ? null : 7,
          },
        })
      }
      if (url.pathname === '/api/gazette/7') {
        const later = url.searchParams.get('after_ordinal') === '1'
        return route.fulfill({
          json: {
            issue: {
              issue_number: 7,
              scheduled_for: '2026-10-12T16:00:00.000Z',
              printed_at: '2026-10-12T16:00:02.000Z',
              header: 'Stored provenance: Room #454, Monday tick, unprinted notes before the cutoff, oldest first, verbatim, with source notes retained.',
              entry_count: 2,
            },
            entries: [later ? {
              ordinal: 2,
              note_id: 702,
              author: 'mapkeeper',
              body: secondBody,
              created_at: '2026-10-12T15:58:00.000Z',
            } : {
              ordinal: 1,
              note_id: 701,
              author: 'leafwalker',
              body: unsafeFirstBody,
              created_at: '2026-10-12T15:55:00.000Z',
            }],
            has_more: !later,
            next_after_ordinal: later ? null : 1,
          },
        })
      }
      return route.abort('failed')
    })

    const initialList = page.waitForRequest(request => {
      return new URL(request.url()).pathname === '/api/gazette' &&
        !new URL(request.url()).searchParams.has('before_issue_number')
    })
    const initialEntries = page.waitForRequest(request => {
      return new URL(request.url()).pathname === '/api/gazette/7' &&
        !new URL(request.url()).searchParams.has('after_ordinal')
    })
    await page.evaluate(() => {
      history.pushState(null, '', '/window/gazette?issue=7')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    const [listRequest, entryRequest] = await Promise.all([initialList, initialEntries])
    for (const request of [listRequest, entryRequest]) {
      const limit = Number(new URL(request.url()).searchParams.get('limit'))
      expect(limit).toBeGreaterThan(0)
      expect(limit).toBeLessThanOrEqual(50)
    }

    const tab = page.getByRole('tab', { name: 'Gazette', exact: true })
    const panel = page.locator('#gazette-panel')
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('status')).toHaveText(
      'Room #454 is open for Gazette submissions.',
    )
    await expect(panel).toContainText(
      'Stored provenance: Room #454, Monday tick, unprinted notes before the cutoff, oldest first, verbatim, with source notes retained.',
    )

    const firstEntry = panel.locator('.gazette-entry').filter({ hasText: 'leafwalker' })
    await expect(firstEntry).toHaveCount(1)
    expect(await firstEntry.locator('.gazette-entry-body').textContent()).toBe(unsafeFirstBody)
    await expect(firstEntry.locator('.gazette-entry-body img')).toHaveCount(0)
    const bylinePortrait = firstEntry.locator('.gazette-entry-attribution .entity-portrait')
    await expect(bylinePortrait).toHaveCount(1)
    await bylinePortrait.scrollIntoViewIfNeeded()
    await expect(bylinePortrait.locator('img')).toHaveCount(1)
    expect(await page.evaluate(() => (
      window as Window & { __gazetteMarkupRan?: boolean }
    ).__gazetteMarkupRan)).toBeUndefined()
    await expect(firstEntry.locator('.gazette-entry-attribution')).toContainText('leafwalker')
    await expect(firstEntry.locator('.gazette-entry-attribution')).toContainText('Note #701')
    await expect(firstEntry.locator('.gazette-entry-attribution')).toContainText(
      '12 October 2026 at 15:55 UTC',
    )
    await expect(firstEntry.getByRole('link', { name: 'Note #701', exact: true }))
      .toHaveAttribute('href', '/window/note/701')

    const olderIssueRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/gazette' &&
        url.searchParams.get('before_issue_number') === '7'
    })
    await page.getByRole('button', { name: 'Load older issues', exact: true }).click()
    await olderIssueRequest
    await expect(panel).toContainText('Issue 6')

    const moreEntriesRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/gazette/7' && url.searchParams.get('after_ordinal') === '1'
    })
    await page.getByRole('button', { name: 'Load more entries', exact: true }).click()
    await moreEntriesRequest
    const entries = panel.locator('.gazette-entry .gazette-entry-body')
    await expect(entries).toHaveCount(2)
    expect(await entries.allTextContents()).toEqual([unsafeFirstBody, secondBody])

    await tab.focus()
    await expect(tab).toBeFocused()
    await expect(panel.locator('[data-share-scope="view"]')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true)
    const tabReachability = await tab.evaluate(element => {
      const tabBox = element.getBoundingClientRect()
      const tabList = element.parentElement
      const tabListBox = tabList?.getBoundingClientRect()
      return {
        withinScroller: Boolean(
          tabListBox && tabBox.left >= tabListBox.left && tabBox.right <= tabListBox.right,
        ),
        tab: { left: tabBox.left, right: tabBox.right },
        scroller: tabListBox ? {
          left: tabListBox.left,
          right: tabListBox.right,
          scrollLeft: tabList?.scrollLeft,
          scrollWidth: tabList?.scrollWidth,
          clientWidth: tabList?.clientWidth,
        } : null,
      }
    })
    expect(tabReachability.withinScroller, JSON.stringify(tabReachability)).toBe(true)
    expect(requests.filter(url => url.pathname === '/api/gazette')).toHaveLength(2)
    expect(requests.filter(url => url.pathname === '/api/gazette/7')).toHaveLength(2)
  })

  test('a Gazette page the size limit cut before the first entry says so, and matches the issue card count', async ({ page }) => {
    // Round 4 review finding 2 (issue #71): before this fix, this exact server
    // shape (has_more true, no next_after_ordinal cursor, zero entries, caused
    // by the automatic byte ceiling stopping before the first entry fit) made
    // the window say "This permanent issue printed with no submissions." while
    // the issue card for the same issue kept showing its true entry count.
    await page.route('**/api/gazette**', route => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/gazette') {
        return route.fulfill({
          json: {
            first_print_at: '2026-08-31T16:00:00.000Z',
            submission_room: { place_id: 454, submissions_open: true },
            issues: [{
              issue_number: 9,
              scheduled_for: '2026-10-19T16:00:00.000Z',
              printed_at: '2026-10-19T16:00:02.000Z',
              entry_count: 25,
            }],
            has_more: false,
            next_before_issue_number: null,
          },
        })
      }
      if (url.pathname === '/api/gazette/9') {
        return route.fulfill({
          json: {
            issue: {
              issue_number: 9,
              scheduled_for: '2026-10-19T16:00:00.000Z',
              printed_at: '2026-10-19T16:00:02.000Z',
              header: 'Stored provenance: Room #454, Monday tick, unprinted notes before the cutoff.',
              entry_count: 25,
            },
            entries: [],
            has_more: true,
            next_after_ordinal: null,
            returned_text_bytes: 0,
            text_limit_bytes: 655360,
            stopped_for_text_limit: true,
            next_item_ordinal: 1,
            next_item_note_id: 9101,
            next_item_text_bytes: 700000,
            server_text_limit_applied: true,
          },
        })
      }
      return route.abort('failed')
    })

    await page.evaluate(() => {
      history.pushState(null, '', '/window/gazette?issue=9')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    const tab = page.getByRole('tab', { name: 'Gazette', exact: true })
    const panel = page.locator('#gazette-panel')
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await expect(panel).toBeVisible()

    const card = panel.locator('.gazette-issue-summary').filter({ hasText: 'Issue 9' })
    await expect(card.locator('.gazette-issue-summary-meta')).toContainText('25 submissions')

    const detail = page.locator('#gazette-issue')
    await expect(detail).toContainText('25 submissions')
    await expect(detail).toContainText('size limit')
    await expect(detail).toContainText('note #9101')
    await expect(detail).toContainText('700000 bytes')
    await expect(detail).not.toContainText('printed with no submissions')
    await expect(panel.getByRole('button', { name: 'Load more entries', exact: true })).toHaveCount(0)
  })

  test('a Load more request that admits nothing still says so, keeps the already-loaded entry, and drops the button honestly', async ({ page }) => {
    // Round 5 review finding 1 (issue #71): round 4's fix only rendered the
    // honest budget-cut notice when the entry list was still empty. Before
    // this fix, a Load more request hitting the same byte ceiling AFTER one
    // entry already loaded left the window showing a single truncated entry
    // with no notice and no Load more control, as if the issue simply ended
    // at one submission, while the card beside it kept showing 25.
    await page.route('**/api/gazette**', route => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/gazette') {
        return route.fulfill({
          json: {
            first_print_at: '2026-08-31T16:00:00.000Z',
            submission_room: { place_id: 454, submissions_open: true },
            issues: [{
              issue_number: 10,
              scheduled_for: '2026-10-26T16:00:00.000Z',
              printed_at: '2026-10-26T16:00:02.000Z',
              entry_count: 25,
            }],
            has_more: false,
            next_before_issue_number: null,
          },
        })
      }
      if (url.pathname === '/api/gazette/10') {
        const continuation = url.searchParams.get('after_ordinal') === '1'
        if (continuation) {
          return route.fulfill({
            json: {
              issue: {
                issue_number: 10,
                scheduled_for: '2026-10-26T16:00:00.000Z',
                printed_at: '2026-10-26T16:00:02.000Z',
                header: 'Stored provenance: Room #454, Monday tick, unprinted notes before the cutoff.',
                entry_count: 25,
              },
              entries: [],
              has_more: true,
              next_after_ordinal: null,
              returned_text_bytes: 0,
              text_limit_bytes: 655360,
              stopped_for_text_limit: true,
              next_item_ordinal: 2,
              next_item_note_id: 9202,
              next_item_text_bytes: 650000,
              server_text_limit_applied: true,
            },
          })
        }
        return route.fulfill({
          json: {
            issue: {
              issue_number: 10,
              scheduled_for: '2026-10-26T16:00:00.000Z',
              printed_at: '2026-10-26T16:00:02.000Z',
              header: 'Stored provenance: Room #454, Monday tick, unprinted notes before the cutoff.',
              entry_count: 25,
            },
            entries: [{
              ordinal: 1,
              note_id: 9201,
              author: 'leafwalker',
              body: 'The first entry, which fit fine on its own.',
              created_at: '2026-10-26T15:55:00.000Z',
            }],
            has_more: true,
            next_after_ordinal: 1,
          },
        })
      }
      return route.abort('failed')
    })

    await page.evaluate(() => {
      history.pushState(null, '', '/window/gazette?issue=10')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    const tab = page.getByRole('tab', { name: 'Gazette', exact: true })
    const panel = page.locator('#gazette-panel')
    const detail = page.locator('#gazette-issue')
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await expect(panel).toBeVisible()
    await expect(detail.locator('.gazette-entry')).toHaveCount(1)
    await expect(detail).toContainText('The first entry, which fit fine on its own.')

    const continuationRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/gazette/10' && url.searchParams.get('after_ordinal') === '1'
    })
    await page.getByRole('button', { name: 'Load more entries', exact: true }).click()
    await continuationRequest

    // The already-loaded entry must still be there: this is not a genuinely
    // empty issue and must not look like one.
    await expect(detail.locator('.gazette-entry')).toHaveCount(1)
    await expect(detail).toContainText('The first entry, which fit fine on its own.')

    // The honest notice must appear too, naming the entry that did not fit,
    // matching the card's true count, and worded for a continuation (not
    // claiming the FIRST entry was the one that failed to fit, since one
    // already loaded).
    const card = panel.locator('.gazette-issue-summary').filter({ hasText: 'Issue 10' })
    await expect(card.locator('.gazette-issue-summary-meta')).toContainText('25 submissions')
    await expect(detail).toContainText('25 submissions')
    await expect(detail).toContainText('size limit')
    await expect(detail).toContainText('note #9202')
    await expect(detail).toContainText('650000 bytes')
    await expect(detail).not.toContainText('printed with no submissions')
    await expect(detail).not.toContainText('before the first entry fit')

    // The control is gone (there is genuinely no cursor to page further with),
    // but its disappearance is now explained, not silent.
    await expect(panel.getByRole('button', { name: 'Load more entries', exact: true })).toHaveCount(0)
  })
}
