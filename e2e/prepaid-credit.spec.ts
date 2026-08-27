import { expect, test } from '@playwright/test'

const GIFT_ID = `city_gift_${'ab'.repeat(16)}`
const CLAIM_TOKEN = `gift_claim_${'cd'.repeat(32)}`
const PURCHASE_ID = `city_paypal_${'ef'.repeat(16)}`
const PAYPAL_ORDER_ID = 'ORDER-E2E-CREDIT-0001'

test('gift purchase confirms the resident before exposing the one-time redirect key', async ({ page }) => {
  await page.goto('/buy')

  await expect(page.getByRole('heading', { name: 'Put exact credit on a resident.' })).toBeVisible()
  await expect(page.locator('input[autocomplete="cc-number"], input[name*="card" i]')).toHaveCount(0)

  await page.getByLabel('Resident number').fill('193')
  await page.getByRole('button', { name: 'Find this resident' }).click()
  await expect(page.locator('#confirmed-number')).toHaveText('#193')
  await expect(page.locator('#confirmed-handle')).toHaveText('@keeps-the-maybe')

  await page.getByLabel('Whole US dollars').fill('3')
  await page.getByLabel("This is for someone else's resident").check()
  await page.getByRole('button', { name: 'Continue to PayPal' }).click()

  await expect(page.getByRole('heading', { name: 'Save the private redirect key now.' })).toBeVisible()
  await expect(page.locator('#claim-token')).toHaveText(CLAIM_TOKEN)
  await expect(page.getByRole('button', { name: 'Continue to PayPal' })).toBeDisabled()
  await expect(page.getByText('/gift-redirect', { exact: true })).toBeVisible()
})

test('standalone redirect confirms the new handle and clears the private key on success', async ({ page }) => {
  await page.goto('/gift-redirect')

  await expect(page.getByRole('heading', { name: 'Redirect an unaccepted fee-credit gift.' })).toBeVisible()
  await expect(page.getByLabel('Gift receipt ID')).toBeVisible()
  await page.getByLabel('Gift receipt ID').fill(GIFT_ID)
  await page.getByLabel('Private claim key').fill(CLAIM_TOKEN)
  await page.getByLabel('New resident number').fill('194')
  await page.getByRole('button', { name: 'Find the destination' }).click()

  await expect(page.locator('#redirect-confirmed-number')).toHaveText('#194')
  await expect(page.locator('#redirect-confirmed-handle')).toHaveText('@devnull')
  await page.getByRole('button', { name: 'Redirect this gift' }).click()

  await expect(page.locator('#gift-redirect-result')).toContainText('Gift redirected to @devnull')
  await expect(page.getByLabel('Private claim key')).toHaveValue('')
})

test('PayPal return confirms the pending gift before offering a fresh purchase', async ({ page }) => {
  let markCaptureRequested: (() => void) | undefined
  const captureRequested = new Promise<void>(resolve => {
    markCaptureRequested = resolve
  })
  let releaseCapture: (() => void) | undefined
  const captureReleased = new Promise<void>(resolve => {
    releaseCapture = resolve
  })

  await page.route('**/api/city-credit/paypal/orders/*/capture', async route => {
    const response = await route.fetch()
    markCaptureRequested?.()
    await captureReleased
    await route.fulfill({ response })
  })

  await page.goto(`/buy?paypal=return&purchase_id=${PURCHASE_ID}&token=${PAYPAL_ORDER_ID}`)
  await captureRequested

  const freshPurchase = page.getByRole('link', { name: 'Start another purchase' })
  try {
    await expect(page.getByRole('heading', { name: 'Checking the PayPal return.' })).toBeVisible()
    await expect(freshPurchase).toBeHidden()
  } finally {
    releaseCapture?.()
  }

  await expect(page.getByRole('heading', { name: 'Gift purchase captured.' })).toBeVisible()
  await expect(page.locator('#result-gift-id')).toHaveText(GIFT_ID)
  await expect(page.locator('#result-message')).toContainText(
    'The 3-credit gift for @keeps-the-maybe is pending.',
  )
  await expect(page.locator('#result-message')).toContainText(
    'It adds nothing until that resident accepts it in /api/me.',
  )
  await expect(freshPurchase).toBeVisible()
  await expect(freshPurchase).toHaveAttribute('href', '/buy')
})
