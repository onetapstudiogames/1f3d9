import { expect, test, type Page } from '@playwright/test'

const viewports = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: '390px phone', width: 390, height: 844 },
] as const

async function reset(page: Page): Promise<void> {
  const response = await page.request.post('/__e2e/community-tools-reset')
  expect(response.ok()).toBe(true)
  await page.goto('/tools')
}

async function fillValid(page: Page, operator = 'Lantern Workshop'): Promise<void> {
  await page.getByLabel('Title').fill('Pocket city atlas')
  await page.getByLabel('Tool link').fill('https://tools.example/atlas')
  await page.getByLabel('Who runs it').fill(operator)
  await page.getByLabel('One line about it').fill('Finds public places by their street names.')
  await page.getByLabel('Resident attribution (optional)').selectOption('46')
  await page.getByLabel('Category', { exact: true }).selectOption('Browse')
  await page.getByLabel('Tags').fill('maps, streets')
  await page.getByLabel(/I confirm this tool is safe/iu).check()
}

async function submit(page: Page): Promise<number> {
  const response = page.waitForResponse(candidate =>
    candidate.request().method() === 'POST' && new URL(candidate.url()).pathname === '/tools')
  await page.getByRole('button', { name: 'Send for review' }).click()
  return (await response).status()
}

for (const viewport of viewports) {
  test.describe(`community tools at ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test.beforeEach(async ({ page }) => reset(page))

    test('searches locally and submits without publishing the pending content', async ({ page }) => {
      await expect(page.locator('[data-waiting-count]')).toHaveText('7 submissions are waiting for review.')
      await page.getByLabel('Search tools').fill('portraits')
      await expect(page.locator('.community-tool')).toBeVisible()
      await page.getByLabel('Search tools').fill('nothing-here')
      await expect(page.locator('.community-tool')).toBeHidden()
      await expect(page.getByText('No community tools match that search.')).toBeVisible()
      await page.getByLabel('Search tools').fill('')
      await page.getByRole('button', { name: 'Create', exact: true }).click()
      await expect(page.locator('.community-tool')).toBeHidden()
      await page.getByRole('button', { name: 'All', exact: true }).click()

      await fillValid(page)
      expect(await submit(page)).toBe(201)
      await expect(page.getByRole('status')).toContainText('submission is waiting for review')
      await expect(page.locator('[data-waiting-count]')).toHaveText('8 submissions are waiting for review.')
      await expect(page.locator('body')).not.toContainText('Pocket city atlas')
      await expect(page.locator('body')).not.toContainText('tools.example')
      await expect(page.locator('body')).not.toContainText('maps, streets')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })

    test('explains every browser refusal and keeps the exact count', async ({ page }) => {
      const refusal = async (
        prepare: () => Promise<void>,
        status: number,
        message: RegExp,
      ) => {
        await prepare()
        expect(await submit(page)).toBe(status)
        await expect(page.getByRole('alert')).toContainText(message)
        await expect(page.locator('[data-waiting-count]')).toHaveText('7 submissions are waiting for review.')
        await reset(page)
      }

      await refusal(async () => {
        await fillValid(page)
        await page.locator('form').evaluate(form => {
          form.noValidate = true
          const extra = document.createElement('input')
          extra.name = 'email'
          extra.value = 'not-wanted@example.com'
          form.append(extra)
        })
      }, 400, /unexpected information/iu)

      await refusal(async () => {
        await fillValid(page)
        await page.locator('form').evaluate(form => { form.noValidate = true })
        await page.getByLabel('Tool link').fill('http://unsafe.example')
      }, 400, /https link/iu)

      await refusal(async () => {
        await fillValid(page)
        await page.locator('#website').evaluate((input: HTMLInputElement) => { input.value = 'spam' })
      }, 400, /looked automated/iu)

      await refusal(async () => {
        await fillValid(page)
        await page.locator('input[name="csrf"]').evaluate((input: HTMLInputElement) => { input.value = '0'.repeat(64) })
      }, 403, /private browser cookie did not match/iu)

      await refusal(async () => {
        await fillValid(page)
        await page.locator('#tool-resident').evaluate((select: HTMLSelectElement) => {
          select.add(new Option('vanished resident', '999'))
          select.value = '999'
        })
      }, 409, /resident list changed/iu)

      await fillValid(page, 'Force storage refusal')
      expect(await submit(page)).toBe(503)
      await expect(page.getByRole('alert')).toContainText(/could not save.*not in the queue/iu)
      await expect(page.locator('[data-waiting-count]')).toHaveText('The waiting count is unavailable right now.')
      await reset(page)

      const csrf = await page.locator('input[name="csrf"]').inputValue()
      const body = new URLSearchParams({
        csrf,
        title: 'Pocket city atlas',
        url: 'https://tools.example/atlas',
        operator: 'Lantern Workshop',
        description: 'Finds public places by their street names.',
        resident_id: '46',
        category: 'Browse',
        tags: 'maps, streets',
        confirmation: 'confirmed',
        website: '',
      })
      const originRefusal = await page.request.post('/tools', {
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://other.example',
        },
        data: body.toString(),
      })
      expect(originRefusal.status()).toBe(403)
      expect(await originRefusal.text()).toMatch(/did not come from 1F3D9/iu)
      await expect(page.locator('[data-waiting-count]')).toHaveText('7 submissions are waiting for review.')

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await fillValid(page)
        expect(await submit(page)).toBe(attempt <= 3 ? 201 : 429)
      }
      await expect(page.getByRole('alert')).toContainText(/3 submissions.*UTC day.*Try again/iu)
      await expect(page.locator('[data-waiting-count]')).toHaveText('10 submissions are waiting for review.')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })
  })
}
