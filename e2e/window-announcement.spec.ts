import { expect, test, type Page } from '@playwright/test'
import { ANNOUNCEMENT_STORAGE_KEY, WINDOW_ANNOUNCEMENT } from '../src/window-client/announcement.ts'

// The server decides by its UTC day whether the announcement runs; these tests
// move the browser test server inside its window and back to its ordinary day.
const ANNOUNCEMENT = WINDOW_ANNOUNCEMENT!

async function serverDay(page: Page, date: string | null): Promise<void> {
  const response = await page.request.post('/__e2e/season-date', { data: { date } })
  expect(response.ok()).toBe(true)
}

function dialog(page: Page) {
  return page.getByRole('dialog', { name: ANNOUNCEMENT.title })
}

test.beforeEach(async ({ page }) => {
  await serverDay(page, '2026-10-20')
})

test.afterEach(async ({ page }) => {
  await serverDay(page, null)
})

test('the announcement opens once with focus inside, keeps Tab inside, and Escape returns focus', async ({ page }) => {
  await page.goto('/window')
  const box = dialog(page)
  await expect(box).toBeVisible()
  await expect(box).toHaveAttribute('aria-modal', 'true')
  await expect(box).toBeFocused()
  await expect(box.getByRole('heading', { level: 2 })).toHaveText(ANNOUNCEMENT.title)
  await expect(box.locator('li')).toHaveCount(9)
  const link = box.getByRole('link', { name: 'the changelog', exact: true })
  await expect(link).toHaveAttribute('href', 'https://1f3d9.com/changelog')
  await expect(link).toHaveAttribute('rel', 'external noopener')

  const body = page.locator('#announcement-body')
  const button = box.getByRole('button', { name: ANNOUNCEMENT.button, exact: true })
  await page.keyboard.press('Tab')
  await expect(body).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(link).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(button).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(body).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(button).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(box).toBeHidden()
  await expect(page.getByRole('tab', { name: 'Map', exact: true })).toBeFocused()
  expect(await page.evaluate(key => localStorage.getItem(key), ANNOUNCEMENT_STORAGE_KEY)).toBe(JSON.stringify([ANNOUNCEMENT.id]))

  await page.reload()
  await expect(page.locator('#announcement')).toBeHidden()
})

test('the button closes it too, and a long text scrolls while the button stays in view', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 500 })
  await page.goto('/window')
  const box = dialog(page)
  await expect(box).toBeVisible()
  const button = box.getByRole('button', { name: ANNOUNCEMENT.button, exact: true })
  await expect(button).toBeInViewport()
  const scrolls = await page.locator('#announcement-body').evaluate(element => element.scrollHeight > element.clientHeight)
  expect(scrolls).toBe(true)
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
  expect(sideways).toBe(false)
  await button.click()
  await expect(box).toBeHidden()
  await page.reload()
  await expect(page.locator('#announcement')).toBeHidden()
})

test('without browser storage it shows once per page load', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage is blocked') } })
  })
  await page.goto('/window')
  const box = dialog(page)
  await expect(box).toBeVisible()
  await box.getByRole('button', { name: ANNOUNCEMENT.button, exact: true }).click()
  await expect(box).toBeHidden()
  await page.reload()
  await expect(box).toBeVisible()
})

test('nothing shows before the start day or from the end day on', async ({ page }) => {
  for (const date of ['2026-10-18', '2026-11-09']) {
    await serverDay(page, date)
    await page.goto('/window')
    await expect(page.locator('#announcement')).toBeHidden()
    await expect(page.locator('#announcement')).not.toHaveAttribute('data-announcement', /./u)
  }
})
