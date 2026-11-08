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

    test('setup keeps nine sections closed and opens only the linked topic', async ({ page }) => {
      await page.goto('/setup')
      await expect(page.locator('.help-sec')).toHaveCount(9)
      await expect(page.locator('.help-sec[open]')).toHaveCount(0)
      for (const id of ['claude', 'chatgpt', 'gemini', 'hosted-connector', 'other-local', 'vs-code', 'oauth-refused', 'coding-persistent', 'coding-ephemeral']) {
        await page.goto(`/setup#${id}`)
        await page.reload()
        await expect(page.locator(`#${id}`)).toBeVisible()
        await expect(page.locator('.help-sec[open]')).toHaveCount(1)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.goto('/setup')
      for (const summary of await page.locator('.help-sec > summary').all()) await summary.click()
      await expect(page.locator('.help-sec[open]')).toHaveCount(9)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

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

    test('join enforces the city-name pattern in Chromium', async ({ page }) => {
      await page.goto('/join')
      const handle = page.locator('#handle')
      for (const [value, valid] of [
        ['tiny-lantern', true],
        ['-agent', false],
        ['UPPERCASE', false],
        ['ab', false],
      ] as const) {
        await handle.fill(value)
        const validity = await handle.evaluate(input => ({
          valid: (input as HTMLInputElement).checkValidity(),
          patternMismatch: (input as HTMLInputElement).validity.patternMismatch,
          tooLong: (input as HTMLInputElement).validity.tooLong,
          tooShort: (input as HTMLInputElement).validity.tooShort,
        }))
        expect(validity.valid).toBe(valid)
        if (!valid) expect(validity.patternMismatch || validity.tooLong || validity.tooShort).toBe(true)
      }
    })

    test('feature-off setup gives hosted chats only working paths', async ({ page }) => {
      const response = await page.goto('/feature-off/setup')
      expect(response?.status()).toBe(200)

      const chatGptGuide = page.locator('#chatgpt')
      const claudeGuide = page.locator('#claude')
      for (const guide of [chatGptGuide, claudeGuide]) {
        await guide.locator('summary').click()
        await expect(guide).toContainText('unavailable on this deployment today')
        await expect(guide.getByRole('link', { name: 'the front door', exact: true })).toHaveAttribute('href', '/')
        await expect(guide.getByRole('link', { name: 'the window', exact: true })).toHaveAttribute('href', '/window')
      }
      await expect(page.locator('a[href*="chatgpt.com"], a[href*="claude.ai"]')).toHaveCount(0)
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
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tools made around the city.')
  await expect(page.getByText(/official city doors already live/iu)).toBeVisible()
  await expect(page.getByRole('link', { name: /1F3D9 city skill/iu })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /1F3EA market skill/iu })).toHaveCount(0)
  const communityTools = page.locator('#community-tools')
  await expect(communityTools.getByRole('heading', { level: 2 })).toHaveText('Community tools.')
  await expect(communityTools.getByRole('link', { name: "Solward's Visual Wiki" })).toHaveAttribute(
    'href',
    'https://1f3d9wiki.site',
  )
  await expect(communityTools).toContainText('the wiki is made by resident Solward (#46) · independent, not run by us')
  await expect(communityTools).toContainText('Made by Solward (resident #46).')
  await expect(page.locator('#submit-tool')).toContainText('3 submissions per address per UTC day')
  const residentAttribution = page.getByLabel('Resident attribution (optional)')
  await expect(residentAttribution).toHaveAttribute('name', 'resident_handle')
  await expect(residentAttribution).toHaveAttribute('placeholder', 'resident-handle')
  await expect(page.locator('#submit-tool')).toContainText('Enter the exact resident handle.')
  await expect(residentAttribution.locator('option')).toHaveCount(0)
  await expect(page.getByRole('link', { name: /open the public GitHub issue fallback/iu })).toHaveAttribute(
    'href',
    'https://github.com/onetapstudiogames/1f3d9/issues/new?template=community-tool.md',
  )
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await page.getByRole('link', { name: 'About', exact: true }).click()
  await expect(page).toHaveURL(/\/about$/u)
  await expect(page.getByRole('link', { name: 'Move your agent in', exact: true })).toHaveAttribute('href', '/window#move-in')
  await page.getByRole('link', { name: 'Connect', exact: true }).click()
  await expect(page).toHaveURL(/\/setup$/u)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('How do I connect?')
  await expect(page.locator('.help-sec')).toHaveCount(9)
  await expect(page.locator('.help-sec[open]')).toHaveCount(0)
  await page.locator('#chatgpt > summary').click()
  await expect(page.locator('#chatgpt')).toContainText('save both files')
  await expect(page.locator('#chatgpt a').first()).toHaveAttribute('href', 'https://chatgpt.com/plugins?directoryTab=personal')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await page.getByRole('link', { name: 'Window', exact: true }).click()
  await expect(page).toHaveURL(/\/window\/map$/u)
  await expect(page.getByRole('link', { name: 'What is this?', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'How do I connect?', exact: true })).toBeVisible()
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    'content',
    'index, follow',
  )
  await page.getByRole('link', { name: 'Tools', exact: true }).click()
  await expect(page).toHaveURL(/\/tools$/u)
  await expect(page.locator('#community-tools')).toContainText("Solward's Visual Wiki")
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    'content',
    'index, follow',
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
