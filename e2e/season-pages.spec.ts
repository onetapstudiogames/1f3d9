import { expect, test, type Page } from '@playwright/test'
import { ANNOUNCEMENT_STORAGE_KEY, WINDOW_ANNOUNCEMENT } from '../src/window-client/announcement.ts'
import { PAL } from '../src/season/palettes.ts'

// Pages wear the season the browser test server's UTC day names. Each test
// moves that day and puts it back, so every other browser test keeps its
// ordinary day.
async function serverDay(page: Page, date: string | null): Promise<void> {
  const response = await page.request.post('/__e2e/season-date', { data: { date } })
  expect(response.ok()).toBe(true)
}

async function token(page: Page, name: string): Promise<string> {
  return await page.evaluate(token => getComputedStyle(document.documentElement).getPropertyValue(token).trim(), name)
}

test.beforeEach(async ({ page }) => {
  // The launch announcement would cover the window during October; it has its own spec.
  await page.addInitScript(([key, id]) => {
    try { localStorage.setItem(key!, JSON.stringify([id])) } catch { /* storage blocked */ }
  }, [ANNOUNCEMENT_STORAGE_KEY, WINDOW_ANNOUNCEMENT!.id])
})

test.afterEach(async ({ page }) => {
  await serverDay(page, null)
})

for (const [date, season, words] of [
  ['2026-10-14', 'spooky', ['spooky']],
  ['2026-11-15', 'harvest', ['cozy']],
  ['2026-12-10', 'winter', ['candlelit']],
] as const) {
  test(`${date}: the window sign and the guide masthead wear ${season}`, async ({ page }) => {
    await serverDay(page, date)
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/window')
      const sign = page.locator('.city-mark')
      await expect(sign.locator('img.city-icon')).toHaveAttribute('src', /^\/season\/icon\/[a-z0-9+-]+\.[0-9a-f]{10}\.svg$/u)
      // The icon's tile takes the season's masthead color, never the old green.
      const iconSvg = await (await page.request.get((await sign.locator('img.city-icon').getAttribute('src'))!)).text()
      expect(iconSvg).toContain(`<rect width="512" height="512" rx="112" ry="112" fill="${PAL[season].am.forest}"/>`)
      expect(iconSvg).not.toContain('#183a30')
      await expect(sign.locator('img.city-icon')).toHaveAttribute('alt', /^The 1F3D9 skyline, dressed for /u)
      await expect(sign.locator('.city-slogan img.season-word')).toHaveCount(words.length)
      for (const word of words) await expect(sign.getByRole('img', { name: word, exact: true })).toBeVisible()
      expect(await token(page, '--signal')).toBe(PAL[season].wm['w-signal'])
      expect(await token(page, '--night')).toBe(PAL[season].wm.night)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
      const iconSize = await sign.locator('img.city-icon').evaluate(element => element.getBoundingClientRect().height)
      expect(iconSize).toBeGreaterThan(40)

      await page.goto('/about')
      expect(await token(page, '--forest')).toBe(PAL[season].am.forest)
      expect(await token(page, '--paper')).toBe(PAL[season].am.paper)
      await expect(page.locator('.guide-brand img[data-season-icon]')).toHaveAttribute('src', /^\/season\/icon\//u)
      await expect(page.locator('.city-seal img')).toHaveAttribute('src', /^\/season\/icon\//u)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
      if (width === 1280) {
        for (const word of words) await expect(page.locator('.guide-brand').getByRole('img', { name: word, exact: true })).toBeVisible()
        const wordHeight = await page.locator('.guide-brand img.season-word').first().evaluate(element => element.getBoundingClientRect().height)
        expect(wordHeight).toBeGreaterThan(10)
        expect(wordHeight).toBeLessThan(30)
      }
    }
  })
}

test('an ordinary day keeps the usual colors, icon and slogan', async ({ page }) => {
  await page.goto('/window')
  expect(await token(page, '--signal')).toBe('#f0c95f')
  await expect(page.locator('.city-mark img.city-icon')).toHaveAttribute('src', '/favicon.svg')
  await expect(page.locator('.city-slogan')).toHaveText('The city where agents live')
  await expect(page.locator('#season-style')).toHaveCount(0)
})

test('a window left open past UTC midnight changes into the next day', async ({ page }) => {
  await serverDay(page, '2026-10-31')
  await page.clock.install({ time: Date.parse('2026-10-31T23:58:00Z') })
  await page.goto('/window')
  await expect(page.locator('#season-style')).toHaveAttribute('href', /^\/season\/spooky-window\./u)
  await expect(page.locator('.city-slogan').getByRole('img', { name: 'spooky', exact: true })).toBeVisible()

  await serverDay(page, '2026-11-01')
  await page.clock.fastForward('03:00')
  await expect(page.locator('#season-style')).toHaveAttribute('href', /^\/season\/harvest-window\./u)
  await expect(page.locator('meta[name="1f3d9-season-date"]')).toHaveAttribute('content', '2026-11-01')
  await expect(page.locator('.city-slogan').getByRole('img', { name: 'remembering', exact: true })).toBeVisible()
  await expect(page.locator('.city-mark img.city-icon')).toHaveAttribute('alt', 'The 1F3D9 skyline, dressed for Día de los Muertos')
  await expect(page.locator('.city-mark img.city-icon')).toHaveAttribute('src', /^\/season\/icon\/harvest-muertos\.[0-9a-f]{10}\.svg$/u)
  expect(await token(page, '--signal')).toBe(PAL.harvest.wm['w-signal'])
})
