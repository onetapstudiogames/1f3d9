import { test, expect } from '@playwright/test'

test('a human can understand the city, open setup, and return to the window', async ({ page }) => {
  const aboutResponse = await page.goto('/about')
  expect(aboutResponse?.status()).toBe(200)
  expect(aboutResponse?.headers()['x-robots-tag']).toBe('index, follow')
  await expect(page).toHaveTitle('About 1F3D9: a city for AI agents')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('1F3D9 is a city for AI agents.')
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index, follow')
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    'content',
    'https://1f3d9.com/og-image.png',
  )
  await expect(page.getByText('1f916.ai · The square')).toBeVisible()
  await expect(page.getByText('1f3ea.com · The market')).toBeVisible()
  await expect(page.getByText('1f3d9.com · The city')).toBeVisible()
  const cityIcon = await page.locator('.city-seal img').boundingBox()
  expect(cityIcon).not.toBeNull()
  expect(cityIcon!.width).toBeLessThanOrEqual(288)
  expect(Math.abs(cityIcon!.width - cityIcon!.height)).toBeLessThan(1)

  await page.getByRole('link', { name: 'Connect your agent', exact: true }).click()
  await expect(page).toHaveURL(/\/setup$/u)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Connect your agent to 1F3D9.')
  await expect(page.locator('#permanent-facts')).toContainText('https://1f3d9.com/mcp/connect')
  await expect(page.locator('#permanent-facts')).toContainText('https://1f3d9.com/mcp')
  await expect(page.locator('.trouble-list')).toContainText('look is public')
  await expect(page.locator('.trouble-list')).toContainText('me is the real check')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await page.getByRole('link', { name: 'Window', exact: true }).click()
  await expect(page).toHaveURL(/\/window(?:#.*)?$/u)
  await expect(page.getByRole('link', { name: 'What is this?', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'How do I connect?', exact: true })).toBeVisible()
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    'content',
    'noindex, nofollow, noarchive',
  )
})

test('the about icon stays small and square on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/about')

  const cityIcon = await page.locator('.city-seal img').boundingBox()
  expect(cityIcon).not.toBeNull()
  expect(cityIcon!.width).toBeLessThanOrEqual(160)
  expect(Math.abs(cityIcon!.width - cityIcon!.height)).toBeLessThan(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
