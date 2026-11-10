import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'

test('key file proof, exact name confirmation and cancellation use only POST bodies', async ({ page }) => {
  const key = ['1f3d9', 'sk', randomBytes(24).toString('hex')].join('_')
  const actions: string[] = []
  let state = 'active'
  await page.route('**/api/resident-retirement', async route => {
    const request = route.request()
    expect(request.method()).toBe('POST')
    expect(new URL(request.url()).search).toBe('')
    const body = request.postDataJSON()
    expect(body.key === key).toBe(true)
    actions.push(body.action)
    if (body.action === 'retire') {
      expect(body.handle).toBe('browser_retirement')
      state = 'retiring'
    } else if (body.action === 'cancel') state = 'active'
    await route.fulfill({ json: { ok: true, resident: {
      id: 7, handle: 'browser_retirement', retirement_state: state,
      can_cancel: state === 'retiring', cancel_until: '2026-12-09T12:00:00.000Z',
    }, message: body.action === 'cancel' ? 'Retirement canceled. Your resident can act again.' : 'Resident checked.' } })
  })
  await page.setViewportSize({ width: 320, height: 640 })
  const served = await page.goto('/delete')
  expect(served?.headers()['content-security-policy']).toContain("connect-src 'self'")
  await page.getByLabel('Pick key file').setInputFiles({ name: 'city-key.txt', mimeType: 'text/plain', buffer: Buffer.from(key) })
  await expect(page.getByText('Key ready.', { exact: true })).toBeVisible()
  expect(actions).toEqual([])
  await page.getByRole('button', { name: 'Check my resident' }).click()
  await expect(page.getByLabel('Confirm resident name')).toBeVisible()
  await page.getByLabel('Confirm resident name').fill('wrong_name')
  await page.getByRole('button', { name: 'Retire my resident', exact: true }).click()
  await expect(page.getByText('Type the resident name exactly as shown.')).toBeVisible()
  expect(actions).toEqual(['status'])
  await page.getByLabel('Confirm resident name').fill('browser_retirement')
  await page.getByRole('button', { name: 'Retire my resident', exact: true }).click()
  await expect(page.getByText('browser_retirement (retiring)', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('Or type your key')).toHaveValue('')
  await page.getByLabel('Or type your key').fill(key)
  await page.getByRole('button', { name: 'Check my resident' }).click()
  await page.getByRole('button', { name: 'Cancel retirement' }).click()
  await expect(page.getByText('Retirement canceled. Your resident can act again.', { exact: true })).toBeVisible()
  expect(actions).toEqual(['status', 'retire', 'status', 'cancel'])
  expect(new URL(page.url()).search).toBe('')
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
})

test('support and setup keep optional detail closed and link to retirement', async ({ page }) => {
  await page.goto('/support')
  await expect(page.getByText('Email adam@twamd.com for help or to report a problem.', { exact: false })).toBeVisible()
  const video = page.locator('details').filter({ hasText: 'Video permission and removal' })
  await expect(video).not.toHaveAttribute('open')
  await video.locator('summary').click()
  await expect(video).toContainText('Terms date 2026-09-21')
  await page.goto('/setup')
  const retirement = page.locator('#retirement')
  await expect(retirement).not.toHaveAttribute('open')
  await retirement.locator('summary').click()
  await expect(retirement.getByRole('link', { name: 'Delete or retire' })).toHaveAttribute('href', '/delete')
})
