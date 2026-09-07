import { expect, test, type Page } from '@playwright/test'
import { installClipboardRecorder } from '../helpers/public-window-clipboard.ts'
import { measureRebuildableBoxes, comparedOperands } from '../helpers/public-window-layout.ts'
import { NOTE_FULL } from '../helpers/public-window-reading-fixtures.ts'

async function copiedShareLinks(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => [
    ...((window as Window & { __copiedShareLinks?: string[] }).__copiedShareLinks ?? []),
  ])
}

export function registerPublicWindowSharingAndPublicRoutes() {
  test('each visible view has one share button that copies its absolute clean URL', async ({ page }) => {
    await installClipboardRecorder(page)
    await page.goto('/window')
    await expect(page.locator('#window-status')).toContainText('Watching')

    const views = [
      { tab: 'Map', path: '/window/map' },
      { tab: 'Things', path: '/window/things' },
      { tab: 'Place', path: '/window/place/11' },
      { tab: 'Conversations', path: '/window/conversations?place=11' },
      { tab: 'Happenings', path: '/window/happenings?place=11' },
      { tab: 'Agreements', path: '/window/agreements?place=11' },
      { tab: 'Archive', path: '/window/archive?place=11' },
      { tab: 'Gazette', path: '/window/gazette' },
    ] as const
    const expectedLinks: string[] = []

    for (const view of views) {
      await page.getByRole('tab', { name: view.tab, exact: true }).click()
      const currentUrl = new URL(page.url())
      expect(currentUrl.pathname + currentUrl.search).toBe(view.path)
      expect(currentUrl.hash).toBe('')

      const visiblePanel = page.locator('[role="tabpanel"]:visible')
      await expect(visiblePanel).toHaveCount(1)
      const shareButton = visiblePanel.locator('[data-share-scope="view"]')
      await expect(shareButton).toHaveCount(1)
      await expect(page.locator('[data-share-scope="view"]:visible')).toHaveCount(1)

      await shareButton.click()
      expectedLinks.push(currentUrl.origin + view.path)
      await expect.poll(() => copiedShareLinks(page)).toEqual(expectedLinks)
    }
  })

  test('an unproven Gazette issue restores and shares without claiming it exists in metadata', async ({ page }) => {
    const residentBody = 'This resident body belongs in the page, never in an unfurl.'
    await page.route('**/api/gazette**', route => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/gazette') {
        return route.fulfill({
          json: {
            first_print_at: '2026-08-31T16:00:00.000Z',
            submission_room: { place_id: 454, submissions_open: true },
            issues: [{
              issue_number: 7,
              scheduled_for: '2026-10-12T16:00:00.000Z',
              printed_at: '2026-10-12T16:00:02.000Z',
              entry_count: 1,
            }],
            has_more: false,
            next_before_issue_number: null,
          },
        })
      }
      if (url.pathname === '/api/gazette/7') {
        return route.fulfill({
          json: {
            issue: {
              issue_number: 7,
              scheduled_for: '2026-10-12T16:00:00.000Z',
              printed_at: '2026-10-12T16:00:02.000Z',
              header: 'Permanent issue 7 provenance from Room #454.',
              entry_count: 1,
            },
            entries: [{
              ordinal: 1,
              note_id: 701,
              author: 'leafwalker',
              body: residentBody,
              created_at: '2026-10-12T15:55:00.000Z',
            }],
            has_more: false,
            next_after_ordinal: null,
          },
        })
      }
      return route.abort('failed')
    })
    await installClipboardRecorder(page)

    const navigation = await page.goto('/window/gazette?issue=7')
    expect(navigation?.status()).toBe(200)
    await expect(page).toHaveTitle('The Gazette · Issue 7 could not be checked — 1F3D9')
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      'content',
      'The Gazette · Issue 7 could not be checked — 1F3D9',
    )
    const unfurlDescription = await page.locator('meta[property="og:description"]')
      .getAttribute('content')
    expect(unfurlDescription).toContain('public availability could not be checked right now')
    expect(unfurlDescription).not.toContain(residentBody)
    expect(unfurlDescription).not.toContain('leafwalker')
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      new URL('/gazette/7', page.url()).href,
    )
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      new URL('/gazette/7/card.png', page.url()).href,
    )

    await expect(page.getByRole('tab', { name: 'Gazette', exact: true }))
      .toHaveAttribute('aria-selected', 'true')
    const panel = page.locator('#gazette-panel')
    await expect(panel.getByRole('status')).toHaveText(
      'Room #454 is open for Gazette submissions.',
    )
    await expect(panel).toContainText('Issue 7')
    await expect(panel).toContainText(residentBody)
    const readIssue = panel.getByRole('link', { name: 'Read issue 7', exact: true })
    const shareIssue = panel.getByRole('button', { name: 'Share issue 7', exact: true })
    await expect(readIssue).toHaveAttribute('href', '/gazette/7')
    await expect(shareIssue).toBeVisible()
    const [readBox, shareBox] = await measureRebuildableBoxes(() => [
      page.locator('#gazette-panel').getByRole('link', { name: 'Read issue 7', exact: true }),
      page.locator('#gazette-panel').getByRole('button', { name: 'Share issue 7', exact: true }),
    ], 'Gazette issue actions')
    expect(
      Math.abs(readBox.y - shareBox.y),
      comparedOperands({ readY: readBox.y, shareY: shareBox.y }),
    ).toBeLessThan(1)
    expect(
      Math.abs(readBox.height - shareBox.height),
      comparedOperands({ readHeight: readBox.height, shareHeight: shareBox.height }),
    ).toBeLessThan(1)
    await expect(panel.locator('.gazette-issue-summary button')).toHaveCount(0)
    await shareIssue.click()
    await expect.poll(() => copiedShareLinks(page)).toEqual([
      new URL('/gazette/7', page.url()).href,
    ])
  })

  test('a filtered Place URL survives server render and browser restoration exactly', async ({ page }) => {
    const path = '/window/place/11?resident=browser-resident&context=place&find=field&sleepers=11'
    const navigation = await page.goto(path)
    expect(navigation?.status()).toBe(200)
    await expect(page.locator('#window-status')).toContainText('Watching')
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(path)
    await expect(page.locator('#resident-filter')).toHaveValue('browser-resident')
    await expect(page.locator('#directory-search')).toHaveValue('field')

    await page.reload()

    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(path)
    await expect(page.locator('#resident-filter')).toHaveValue('browser-resident')
    await expect(page.locator('#directory-search')).toHaveValue('field')
  })

  test('place, thing, and note details each copy one absolute clean live-record URL', async ({ page, context }) => {
    await installClipboardRecorder(page)
    const navigation = await page.goto('/window/place/11')
    expect(navigation?.status()).toBe(200)
    await expect(page.locator('#window-status')).toContainText('Watching')

    const origin = new URL(page.url()).origin
    const expectedLinks = [`${origin}/window/place/11`]
    const placePanel = page.locator('#place-panel')
    await expect(placePanel).toBeVisible()
    await expect(page.locator('#record-detail')).toBeHidden()
    await expect(placePanel.locator('[data-share-scope="view"]')).toHaveCount(1)
    await placePanel.locator('[data-share-scope="view"]').click()
    await expect.poll(() => copiedShareLinks(page)).toEqual(expectedLinks)

    await page.locator('#place-things .thing-detail-link', { hasText: 'field_lantern' }).click()
    await expect(page).toHaveURL(`${origin}/window/thing/401`)
    const detail = page.locator('#record-detail')
    await expect(detail).toBeVisible()
    await expect(detail.locator('[data-share-scope="detail"]')).toHaveCount(1)
    await expect(detail.locator('#record-detail-title')).toHaveText('field_lantern')
    await expect(detail.locator(
      '#record-detail-title .entity-portrait[data-portrait-type="thing"] img',
    )).toHaveAttribute('src', /\/api\/drawing\/thing\/401\/thumb\.png/u)
    await detail.locator('[data-share-scope="detail"]').click()
    expectedLinks.push(`${origin}/window/thing/401`)
    await expect.poll(() => copiedShareLinks(page)).toEqual(expectedLinks)
    const thingRecipient = await context.newPage()
    await thingRecipient.goto(`${origin}/window/thing/401`)
    await expect(thingRecipient.locator('#record-detail')).toBeVisible()
    await expect(thingRecipient.locator('#record-detail-title')).toHaveText('field_lantern')
    await thingRecipient.close()

    await detail.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page).toHaveURL(`${origin}/window/place/11`)
    await page.getByRole('link', { name: 'Open note #301', exact: true }).click()
    await expect(page).toHaveURL(`${origin}/window/note/301`)
    await expect(detail).toBeVisible()
    await expect(detail.locator('[data-share-scope="detail"]')).toHaveCount(1)
    await expect(detail.locator('#record-detail-body')).toContainText(NOTE_FULL)
    await expect(detail.locator('[data-portrait-type="note"]')).toHaveCount(0)
    await detail.locator('[data-share-scope="detail"]').click()
    expectedLinks.push(`${origin}/window/note/301`)
    await expect.poll(() => copiedShareLinks(page)).toEqual(expectedLinks)

    const shareImage = await page.request.get('/share/thing.png')
    expect(shareImage.status()).toBe(200)
    expect(shareImage.headers()['content-type']).toContain('image/png')
  })

  test('clipboard denial leaves the clean absolute URL visibly available', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText() {
            return Promise.reject(new DOMException('clipboard denied', 'NotAllowedError'))
          },
        },
      })
    })
    await page.goto('/window/map')
    await expect(page.locator('#window-status')).toContainText('Watching')

    await page.locator('[role="tabpanel"]:visible [data-share-scope="view"]').click()
    const expectedUrl = `${new URL(page.url()).origin}/window/map`
    await expect(page.locator('#share-status')).toHaveText(
      `The link could not copy. Copy this URL: ${expectedUrl}`,
    )
    await expect(page.locator('#share-status')).toHaveAttribute('data-tone', 'error')
  })
}
