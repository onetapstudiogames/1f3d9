import { devices, test, expect } from '@playwright/test'

for (const [client, device] of [
  ['desktop', devices['Desktop Chrome']],
  ['phone', devices['Pixel 5']],
] as const) {
  test.describe(`resumable onboarding on ${client}`, () => {
    test.use({
      userAgent: device.userAgent,
      viewport: device.viewport,
      screen: device.screen,
      deviceScaleFactor: device.deviceScaleFactor,
      isMobile: device.isMobile,
      hasTouch: device.hasTouch,
    })

    test('setup and join render all five client paths without hiding a next step', async ({ page }) => {
      await page.goto('/setup')
      for (const id of [
        'hosted-connector',
        'hosted-browser',
        'coding-persistent',
        'coding-ephemeral',
        'oauth-refused',
      ]) {
        await expect(page.locator(`#${id}`)).toBeVisible()
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

      await page.locator('#hosted-browser').getByRole('link', { name: /watch the window/iu }).click()
      await expect(page).toHaveURL(/\/window\/map$/u)
      await page.goto('/join')
      for (const clientClass of [
        'hosted_connector',
        'hosted_browser',
        'coding_persistent',
        'coding_ephemeral',
        'oauth_refused',
      ]) {
        await expect(page.locator(`[data-client-class="${clientClass}"]`)).toBeVisible()
      }
      for (const value of [
        'hosted_browser',
        'coding_persistent',
        'coding_ephemeral',
        'oauth_refused',
      ]) {
        await page.locator(`input[name="client_class"][value="${value}"]`).check()
        await expect(page.locator(`input[value="${value}"]`)).toBeChecked()
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

      await page.locator('[data-client-class="oauth_refused"]').getByRole('link', { name: /setup details/iu }).click()
      await expect(page).toHaveURL(/\/setup#oauth-refused$/u)
      await expect(page.locator('#oauth-refused')).toBeVisible()
    })

    test('feature-off setup gives hosted chats only working paths', async ({ page }) => {
      const response = await page.goto('/feature-off/setup')
      expect(response?.status()).toBe(200)

      const chatGptGuide = page.locator('#chatgpt')
      const claudeGuide = page.locator('#claude')
      await expect(chatGptGuide).not.toContainText('turn on Developer mode')
      await expect(chatGptGuide).not.toContainText('Open the Plugins tab')
      await expect(claudeGuide).not.toContainText('Add custom connector')

      for (const guide of [chatGptGuide, claudeGuide]) {
        await expect(guide).toContainText('unavailable on this deployment today')
        await expect(guide.getByRole('link', { name: /hosted-chat-without-Developer-Mode path/iu })).toHaveAttribute('href', '#hosted-browser')
        await expect(guide.getByRole('link', { name: /plain-text front door/iu })).toHaveAttribute('href', '/')
        await expect(guide.getByRole('link', { name: /watch the window/iu })).toHaveAttribute('href', '/window')
        await expect(guide.getByRole('link', { name: /browser join/iu })).toHaveAttribute('href', '/join')
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })
  })
}

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

  await page.getByRole('link', { name: 'Tools', exact: true }).click()
  await expect(page).toHaveURL(/\/tools$/u)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('tools')
  await expect(page.getByRole('link', { name: /1F3D9 city skill/iu })).toHaveAttribute(
    'href',
    'https://github.com/onetapstudiogames/1f3d9-citylife',
  )
  await expect(page.getByRole('link', { name: /1F3EA market skill/iu })).toHaveAttribute(
    'href',
    'https://github.com/onetapstudiogames/1f3ea-marketplace',
  )
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await page.getByRole('link', { name: 'About', exact: true }).click()
  await expect(page).toHaveURL(/\/about$/u)
  await page.getByRole('link', { name: 'Connect your agent', exact: true }).click()
  await expect(page).toHaveURL(/\/setup$/u)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Connect your agent to 1F3D9.')
  await expect(page.locator('#permanent-facts')).toContainText('https://1f3d9.com/mcp/connect')
  await expect(page.locator('#permanent-facts')).toContainText('https://1f3d9.com/mcp')
  await expect(page.locator('.trouble-list')).toContainText('look is public')
  await expect(page.locator('.trouble-list')).toContainText('me is the real check')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await page.getByRole('link', { name: 'Window', exact: true }).click()
  await expect(page).toHaveURL(/\/window\/map$/u)
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
