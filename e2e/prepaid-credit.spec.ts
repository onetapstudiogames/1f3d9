import { expect, test, type Page } from '@playwright/test'

const GIFT_ID = `city_gift_${'ab'.repeat(16)}`
const CLAIM_TOKEN = `gift_claim_${'cd'.repeat(32)}`
const KEY = ['1f3d9', 'sk', 'a'.repeat(48)].join('_')
const PURCHASE_ID = `city_paypal_${'ef'.repeat(16)}`
const PAYPAL_ORDER_ID = 'ORDER-E2E-CREDIT-0001'

async function chooseResident(page: Page, gift = true) {
  await page.goto('/buy')
  await page.locator('[data-path="' + (gift ? 'gift' : 'own') + '"]').click()
  await expect(page.locator('#next')).toBeDisabled()
  await page.locator('input[aria-describedby="who-help"]:visible, input[aria-describedby="to-help"]:visible').fill('keeps-the-maybe')
  await page.getByRole('button', { name: 'Find', exact: true }).click()
  await expect(page.locator('#who-handle')).toHaveText('@keeps-the-maybe')
  await expect(page.locator('#who-number')).toHaveText('Resident #193')
  await page.locator('#next').click()
  await page.getByLabel('Other', { exact: true }).fill('3')
}

async function findGift(page: Page) {
  await page.goto('/gift-redirect')
  await expect(page.getByRole('heading', { name: 'Find your gift' })).toBeVisible()
  await page.locator('#move-claim_file').setInputFiles({ name: 'claim.txt', mimeType: 'text/plain', buffer: Buffer.from(CLAIM_TOKEN + '\n') })
  await page.getByRole('button', { name: 'Find', exact: true }).click()
  await expect(page.locator('#gift-summary')).toHaveText('3 credits for @keeps-the-maybe')
}

test('gift carousel downloads its browser-made key and reuses it after Back', async ({ page }) => {
  let orders = 0
  page.on('request', request => { if (request.url().endsWith('/paypal/orders')) orders++ })
  await chooseResident(page)
  await page.locator('#next').click()
  await expect(page.getByRole('heading', { name: 'Save your claim key' })).toBeVisible()
  await expect(page.locator('#claim-key')).toHaveText(CLAIM_TOKEN)
  await expect(page.locator('#next')).toBeDisabled()
  const pendingDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download', exact: true }).click()
  const download = await pendingDownload
  expect(download.suggestedFilename()).toBe('1f3d9-gift-claim-key.txt')
  const stream = await download.createReadStream()
  const chunks = []
  for await (const chunk of stream!) chunks.push(chunk)
  expect(Buffer.concat(chunks).toString()).toBe(CLAIM_TOKEN + '\n')
  await download.delete()
  await page.getByLabel('I saved it, not in chat').check()
  await page.locator('#back').click()
  await page.locator('#next').click()
  await expect(page.locator('#claim-key')).toHaveText(CLAIM_TOKEN)
  await expect(page.locator('#next')).toBeEnabled()
  expect(orders).toBe(1)
})

test('resident file loads locally and wrong resident offers a one-time gift', async ({ page }) => {
  await page.route('**/api/city-credit/paypal/allowances', async route => {
    expect(route.request().headers().authorization).toBe('Bearer ' + KEY)
    await route.fulfill({ status: 403, json: { error: 'The key does not match.' } })
  })
  await chooseResident(page, false)
  await page.getByRole('button', { name: 'Every week', exact: true }).click()
  await page.locator('#next').click()
  await page.locator('#key-input_file').setInputFiles({ name: '1f3d9-resident-key.txt', mimeType: 'text/plain', buffer: Buffer.from(KEY + '\n') })
  await expect(page.locator('#key-input')).toHaveValue(KEY)
  await page.locator('#next').click()
  await expect(page.locator('#key-wrong')).toBeVisible()
  await expect(page.locator('#key-input')).toHaveValue('')
  await page.getByRole('button', { name: 'Make it a gift' }).click()
  await expect(page.getByText('Gifts are one time.', { exact: true })).toBeVisible()
  await expect(page.locator('#claim-key')).toHaveText(CLAIM_TOKEN)
})

test('standalone key-only move confirms name, retains exact retry, and clears key', async ({ page }) => {
  const attempts: unknown[] = []
  await page.route('**/api/city-credit/gifts/redirect', async route => {
    attempts.push(route.request().postDataJSON())
    if (attempts.length === 1) await route.fulfill({ status: 503, json: { error: 'Try again' } })
    else await route.fulfill({ status: 200, json: { gift_id: GIFT_ID, status: 'pending', amount_units: 3_000_000 } })
  })
  await findGift(page)
  await page.locator('#next').click()
  await page.locator('input[aria-describedby="who-help"]:visible, input[aria-describedby="to-help"]:visible').fill('devnull')
  await page.getByRole('button', { name: 'Find', exact: true }).click()
  await expect(page.locator('#to-handle')).toHaveText('@devnull')
  await page.locator('#next').click()
  await expect(page.locator('#buy-error')).toContainText('not confirmed')
  await expect(page.locator('#to-input')).toBeDisabled()
  await expect(page.locator('#back')).toBeDisabled()
  await page.locator('#next').click()
  expect(attempts[1]).toEqual(attempts[0])
  await expect(page.locator('#result-message')).toHaveText('3 credits now for @devnull')
  await expect(page.locator('#move-claim')).toHaveValue('')
  await expect(page.locator('#result-relay')).toBeVisible()
})

test('gift status handles every terminal and unpaid state without offering a move', async ({ page }) => {
  for (const status of ['accepted','frozen','revoked','unpaid']) {
    await page.route('**/api/city-credit/gifts/status', route => route.fulfill({ json: { amount_usd: '3.00', recipient_handle: 'keeps-the-maybe', status } }))
    await findGift(page)
    await expect(page.locator('#next')).toBeDisabled()
    await expect(page.locator('#gift-status')).not.toHaveText('Not accepted yet')
    await page.unroute('**/api/city-credit/gifts/status')
  }
})

test('PayPal return keeps exact retry and weekly Done never offers another purchase', async ({ page }) => {
  let captures = 0
  await page.route('**/api/city-credit/paypal/orders/*/capture', async route => {
    captures++
    if (captures === 1) await route.fulfill({ status: 503, json: { error: 'Not ready' } })
    else await route.fulfill({ json: { resident_handle: 'keeps-the-maybe', amount_dollars: '3', delivery: 'gift', status: 'pending', gift_id: GIFT_ID } })
  })
  await page.goto(`/buy?paypal=return&purchase_id=${PURCHASE_ID}&token=${PAYPAL_ORDER_ID}`)
  await expect(page.locator('#next')).toBeHidden()
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.locator('#result-gift-id')).toHaveText('Receipt ' + GIFT_ID)
  await expect(page.locator('#next')).toHaveText('Buy more')
  await page.goto(`/buy?paypal=allowance-return&purchase_id=${PURCHASE_ID}`)
  await expect(page.locator('#result-status')).toHaveText('Starts at first payment')
  await expect(page.getByRole('button', { name: 'Buy more' })).toHaveCount(0)
  await expect(page.locator('#result-done')).toHaveAttribute('href', '/window')
})

test('missing resident recovery and numeric-handle lookup stay explicit', async ({ page }) => {
  await page.route('**/api/city-credit/paypal/residents/*', route => {
    const query = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!)
    return route.fulfill({ status: query === '@431' ? 200 : 404, json: query === '@431' ? { resident_number: 200, resident_handle: '431' } : { error: 'Resident not found', human_href: '/window' } })
  })
  await page.goto('/buy')
  await page.locator('[data-path="own"]').click()
  await page.locator('input[aria-describedby="who-help"]:visible, input[aria-describedby="to-help"]:visible').fill('999')
  await page.getByRole('button', { name: 'Find', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Open the city window.' })).toHaveAttribute('href', '/window')
  await page.locator('input[aria-describedby="who-help"]:visible, input[aria-describedby="to-help"]:visible').fill('@431')
  await page.getByRole('button', { name: 'Find', exact: true }).click()
  await expect(page.locator('#who-handle')).toHaveText('@431')
  await expect(page.locator('#who-number')).toHaveText('Resident #200')
})

test('approved carousel fits phone screens at 375 and 320 pixels', async ({ browser }, testInfo) => {
  for (const width of [375, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, ignoreHTTPSErrors: true, baseURL: testInfo.project.use.baseURL })
    await context.request.post('/__e2e/season-date', { data: { date: '2026-11-08' } })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/buy')
    await page.screenshot({ path: testInfo.outputPath('buy-' + width + '.png'), fullPage: true, animations: 'disabled' })
    await page.locator('[data-path="own"]').click()
    await page.locator('#who-input').fill('193')
    await page.getByRole('button', { name: 'Find', exact: true }).click()
    await page.locator('#next').click()
    await page.getByRole('button', { name: 'Every week', exact: true }).click()
    await page.screenshot({ path: testInfo.outputPath('amount-' + width + '.png'), fullPage: true, animations: 'disabled' })
    expect(await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))).toEqual({ width, scroll: width })
    await page.getByRole('link', { name: 'Help', exact: true }).click()
    await page.locator('summary').evaluateAll(elements => elements.forEach(el => { (el.parentElement as HTMLDetailsElement).open = true }))
    await page.screenshot({ path: testInfo.outputPath('help-' + width + '.png'), fullPage: true, animations: 'disabled' })
    expect(await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))).toEqual({ width, scroll: width })
    expect(errors).toEqual([])
    await context.request.post('/__e2e/season-date', { data: { date: null } })
    await context.close()
  }
})
