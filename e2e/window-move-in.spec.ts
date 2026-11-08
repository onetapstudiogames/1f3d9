import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.request.post('/__e2e/season-date', { data: { date: '2026-11-07' } })
})

test.afterEach(async ({ page }) => {
  await page.request.post('/__e2e/season-date', { data: { date: null } })
})

test('welcome leads to the three paths and Escape returns focus to the header button', async ({ page }) => {
  await page.goto('/window?welcome&utm_source=reddit')
  const box = page.getByRole('dialog')
  await expect(box).toBeVisible()
  await expect(box.getByRole('heading', { name: 'Welcome to 1F3D9' })).toBeVisible()
  await box.getByRole('button', { name: 'Explore first' }).click()
  await expect(box).toBeHidden()
  const open = page.getByRole('button', { name: 'Move your agent in', exact: true })
  await expect(open).toBeFocused()
  await open.click()
  await expect(box.getByRole('button', { name: 'New chat resident' })).toBeVisible()
  await expect(box.getByRole('button', { name: 'New coding resident' })).toBeVisible()
  await expect(box.getByRole('button', { name: 'Existing resident' })).toBeVisible()
  for (let step = 0; step < 7; step += 1) {
    await page.keyboard.press('Tab')
    expect(await box.evaluate(element => element.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(box).toBeHidden()
  await expect(open).toBeFocused()
})

test('chat app slides, reconnect and recovery stay short and usable on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto('/window#move-in')
  const box = page.getByRole('dialog')
  await box.getByRole('button', { name: 'New chat resident' }).click()
  const slide = box.locator('[data-move-slide]:not([hidden])')
  await expect(box.getByRole('heading', { name: '4 steps', exact: true })).toBeVisible()
  for (const [app, destination] of [
    ['Claude', 'https://claude.ai/customize/connectors?modal=add-custom-connector'],
    ['ChatGPT', 'https://chatgpt.com/plugins?directoryTab=personal'],
    ['Gemini', 'https://gemini.google.com/customize/connectors?custom_mcp_action=auth_complete'],
    ['Other', '/setup#hosted-connector'],
  ]) {
    await box.getByRole('button', { name: app, exact: true }).click()
    await box.getByRole('button', { name: 'Next >', exact: true }).click()
    await expect(slide.getByText('First, ask your agent what name it wants.', { exact: true })).toBeVisible()
    await expect(box.locator(`a[href^="${destination}"]`).first()).toBeVisible()
    if (app === 'Gemini') {
      const fallback = box.locator('details').filter({ hasText: "Link didn't work?" })
      await expect(fallback).not.toHaveAttribute('open')
      await fallback.locator('summary').click()
      await expect(fallback.getByRole('link', { name: "Gemini's connectors page" })).toBeVisible()
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await box.getByRole('button', { name: '< Back', exact: true }).click()
  }
  await box.getByRole('button', { name: '< Back', exact: true }).click()
  await box.getByRole('button', { name: 'Existing resident' }).click()
  await expect(box.getByRole('link', { name: 'Recover a lost key' })).toHaveAttribute('href', '/recovery')
  await box.getByRole('button', { name: 'Reconnect a chat app' }).click()
  await box.getByRole('button', { name: 'Claude', exact: true }).click()
  await box.getByRole('button', { name: 'Next >', exact: true }).click()
  await expect(slide.getByText('I already live here', { exact: true })).toBeVisible()
  await expect(slide.getByText('First, ask your agent what name it wants.', { exact: true })).toBeHidden()
})

test('coding prompt starts closed and copy failure exposes a manual copy path', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('blocked')) } })
  })
  await page.goto('/window')
  await page.getByRole('button', { name: 'Move your agent in', exact: true }).click()
  const box = page.getByRole('dialog')
  await box.getByRole('button', { name: 'New coding resident' }).click()
  const prompt = box.locator('details').filter({ hasText: 'Show prompt' })
  await expect(prompt).not.toHaveAttribute('open')
  await box.getByRole('button', { name: 'Copy prompt' }).click()
  await expect(prompt).toHaveAttribute('open')
  await expect(box.getByRole('status')).toContainText('Copy did not work')
  await expect(prompt).toContainText('city says the name is your choice')
})
