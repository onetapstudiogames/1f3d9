import { expect, test, type Page } from '@playwright/test'
import { OWNER_NOTICE } from '../src/window-client/owner-notice.ts'
import { registerPublicWindowSetup } from './helpers/public-window-setup.ts'
import { contrastRatio } from './helpers/public-window-snapshot-fixtures.ts'
import { MINUTE_MS, routeTalk } from './helpers/window-talk-fixtures.ts'

const WAITLIST = OWNER_NOTICE.waitlistText
const LAUNCHED = OWNER_NOTICE.launchedText
const LAUNCH_AT_MS = Date.parse(OWNER_NOTICE.launchAt)
const HIDE_AT_MS = Date.parse(OWNER_NOTICE.hideAt)
const OPENED_AT_HIDE = 'a window opened at the hide instant renders no notice'

// The page clock is installed before the shared setup loads the window, then paused, so no
// timer runs until a test jumps the clock with fastForward (never stepped).
test.beforeEach(async ({ page }, testInfo) => {
  const start = testInfo.title === OPENED_AT_HIDE ? HIDE_AT_MS : LAUNCH_AT_MS - 2 * MINUTE_MS
  await page.clock.install({ time: start })
  await page.clock.pauseAt(start + 1)
})

registerPublicWindowSetup()

function noticeText(page: Page) {
  return page.locator('#owner-notice-text').evaluate(element => element.textContent)
}

test('the notice shows the waitlist text on every tab, switches to the launch text without a reload, and is gone after two weeks', async ({ page }) => {
  await routeTalk(page)
  const notice = page.locator('#owner-notice')
  await expect(notice).toBeVisible()
  expect(await noticeText(page)).toBe(WAITLIST)
  const link = notice.getByRole('link', { name: OWNER_NOTICE.url, exact: true })
  await expect(link).toHaveAttribute('href', OWNER_NOTICE.url)
  await expect(link).toHaveAttribute('rel', 'noopener')
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(notice.locator('a')).toHaveCount(1)
  for (const name of ['Conversations', 'Talk', 'Happenings', 'Map']) {
    const tab = page.getByRole('tab', { name, exact: true })
    await tab.click()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await expect(notice).toBeVisible()
    expect(await noticeText(page)).toBe(WAITLIST)
  }

  await page.clock.fastForward(3 * MINUTE_MS)
  await expect.poll(() => noticeText(page)).toBe(LAUNCHED)
  await expect(notice).toBeVisible()
  await expect(notice.getByRole('link', { name: OWNER_NOTICE.url, exact: true }))
    .toHaveAttribute('href', OWNER_NOTICE.url)

  await page.clock.fastForward(HIDE_AT_MS - LAUNCH_AT_MS)
  await expect(notice).toBeHidden()
  await expect.poll(() => noticeText(page)).toBe('')
  await expect(page.locator('a[href="https://ofstory.net"]')).toHaveCount(0)
})

test(OPENED_AT_HIDE, async ({ page }) => {
  await expect(page.locator('#owner-notice')).toBeHidden()
  expect(await noticeText(page)).toBe('')
  await expect(page.locator('a[href="https://ofstory.net"]')).toHaveCount(0)
  await expect(page.getByText('The Story of the Internet')).toHaveCount(0)
})

test('Hide removes the notice for this page on every tab, and the launch text still shows once it is new', async ({ page }) => {
  const notice = page.locator('#owner-notice')
  await expect(notice).toBeVisible()
  await page.getByRole('button', { name: 'Hide this notice', exact: true }).click()
  await expect(notice).toBeHidden()
  await expect(page.getByRole('tab', { name: 'Map', exact: true })).toBeFocused()
  await page.getByRole('tab', { name: 'Conversations', exact: true }).click()
  await expect(notice).toBeHidden()

  await page.clock.fastForward(3 * MINUTE_MS)
  await expect.poll(() => noticeText(page)).toBe(LAUNCHED)
  await expect(notice).toBeVisible()
})

for (const width of [320, 375, 1440]) {
  test(`the notice sits between the sign and the tab bar at ${width} with no sideways scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const notice = page.locator('#owner-notice')
    await expect(notice).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const [noticeBox, signBox, tabsBox, hideBox] = await Promise.all([
      notice.boundingBox(),
      page.locator('.city-sign').boundingBox(),
      page.locator('.view-tabs').boundingBox(),
      page.getByRole('button', { name: 'Hide this notice', exact: true }).boundingBox(),
    ])
    expect(noticeBox && signBox && tabsBox && hideBox).toBeTruthy()
    expect(noticeBox!.x).toBeGreaterThanOrEqual(0)
    expect(noticeBox!.x + noticeBox!.width).toBeLessThanOrEqual(width)
    expect(noticeBox!.y).toBeGreaterThanOrEqual(signBox!.y + signBox!.height)
    expect(noticeBox!.y + noticeBox!.height).toBeLessThanOrEqual(tabsBox!.y)
    expect(hideBox!.width).toBeGreaterThanOrEqual(24)
    expect(hideBox!.height).toBeGreaterThanOrEqual(24)
  })
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`the notice text and link read clearly on both ends of its band with a ${colorScheme} preference`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    await expect(page.locator('#owner-notice')).toBeVisible()
    const colors = await page.evaluate(() => {
      const probe = document.createElement('span')
      document.getElementById('owner-notice')?.append(probe)
      const tokenColor = (token: string) => {
        probe.style.color = 'var(' + token + ')'
        return getComputedStyle(probe).color
      }
      const result = {
        text: getComputedStyle(document.getElementById('owner-notice-text') as Element).color,
        link: getComputedStyle(document.querySelector('#owner-notice-text a') as Element).color,
        start: tokenColor('--signal'),
        end: tokenColor('--paper-light'),
      }
      probe.remove()
      return result
    })
    for (const surface of [colors.start, colors.end]) {
      expect(contrastRatio(colors.text, surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(colors.link, surface)).toBeGreaterThanOrEqual(4.5)
    }
  })
}
