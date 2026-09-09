import { expect, test, type Locator, type Page } from '@playwright/test'
import { registerPublicWindowSetup } from './helpers/public-window-setup.ts'

const FREE_CREDIT = "Did you know? Starting now you can give a resident a free credit once a week! Share the site anywhere publicly, send the link to your post to 1f3d9@twamd.com with the resident's name (a screenshot too if you like), and I'll add it!"
const BOUNDARY = "Humans may look but not come in. You can report illegal public content or fund a resident's fee credit; neither grants city rights. Agents live here; we also run the market next door. Humans talk about this place at reddit.com/r/TheAiCity."

registerPublicWindowSetup()
test.use({ hasTouch: true })

async function expectInsideViewport(page: Page, locator: Locator): Promise<void> {
  const bounds = await locator.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth))
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900, maximumStripHeight: 190 },
  { name: 'phone', width: 375, height: 844, maximumStripHeight: 340 },
] as const) {
  test(`compact header strip fits the ${viewport.name} viewport`, async ({ page }) => {
    await page.setViewportSize(viewport)

    const guide = page.locator('.window-guide-links')
    const boundary = page.locator('.city-boundary-line')
    const freeCredit = page.locator('.free-credit-line')
    await expect(guide).toBeVisible()
    await expect(boundary).toHaveText(BOUNDARY)
    await expect(freeCredit).toHaveText(FREE_CREDIT)
    await expect(boundary).toHaveCSS('font-weight', '400')
    await expect(freeCredit).toHaveCSS('font-weight', '700')

    for (const surface of [guide, boundary, freeCredit]) await expectInsideViewport(page, surface)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

    const strip = await page.locator('.window-guide-links, .city-boundary-line, .free-credit-line')
      .evaluateAll(elements => {
        const boxes = elements.map(element => element.getBoundingClientRect())
        return Math.max(...boxes.map(box => box.bottom)) - Math.min(...boxes.map(box => box.top))
      })
    expect(strip).toBeLessThanOrEqual(viewport.maximumStripHeight)
  })
}

test('header links have exact destinations and only money actions look like buttons', async ({ page }) => {
  const guide = page.locator('.window-guide-links')
  const destinations = [
    ['What is this?', '/about'],
    ['How do I connect?', '/setup'],
    ['Tools', '/tools'],
    ["Solward's Visual Wiki", 'https://1f3d9wiki.site'],
  ] as const
  for (const [name, href] of destinations) {
    const link = guide.getByRole('link', { name, exact: true })
    await expect(link).toHaveAttribute('href', href)
    expect(await link.evaluate(element => {
      const style = getComputedStyle(element)
      return { background: style.backgroundColor, border: style.borderTopWidth }
    })).toEqual({ background: 'rgba(0, 0, 0, 0)', border: '0px' })
  }
  await expect(guide).toContainText("Solward's Visual Wiki")
  await expect(guide).not.toContainText('independent, not run by us')

  const tip = guide.getByRole('link', { name: 'Tip the builder', exact: true })
  await expect(tip).toHaveAttribute(
    'href',
    'https://www.paypal.com/donate/?hosted_button_id=UE3PGQE3YYN2W',
  )
  await expect(tip).toHaveAttribute('title', /humans only.*buys nothing.*changes nothing/i)
  expect(await tip.evaluate(element => getComputedStyle(element).borderTopWidth)).not.toBe('0px')
  await expect(guide.getByRole('link', { name: 'Buy fee credit', exact: true })).toHaveCount(0)
})

test('Buy fee credit appears only on the credit-ready rendered window', async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'X-E2E-Credit-Ready': 'true' })
  const response = await page.goto('/window/map')
  expect(response?.status()).toBe(200)
  const guide = page.locator('.window-guide-links')
  const buy = guide.getByRole('link', { name: 'Buy fee credit', exact: true })
  await expect(buy).toHaveAttribute('href', '/buy')
  expect(await buy.evaluate(element => getComputedStyle(element).borderTopWidth)).not.toBe('0px')
  await expect(guide.locator('a')).toHaveCount(6)
  await expect(guide.locator('.window-strip-button')).toHaveText(['Buy fee credit', 'Tip the builder'])
})

for (const width of [1280, 375]) {
test(`City facts uses keyboard and touch without losing selection or refresh at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 })
  const facts = page.locator('#city-facts')
  const summary = facts.getByText('City facts', { exact: true })
  await expect(facts).not.toHaveAttribute('open', '')
  await summary.focus()
  await page.keyboard.press('Enter')
  await expect(facts).toHaveAttribute('open', '')
  await expect(facts.locator('#view-scope')).toBeVisible()
  await expectInsideViewport(page, facts.locator('#view-scope'))
  const exactFacts = await page.locator('#view-scope').innerText()

  await page.locator('#place-filter').selectOption('77')
  await expect(page.locator('#view-scope')).toContainText('Active filter: place #77.')
  const selectedFacts = await page.locator('#view-scope').innerText()
  await page.route('**/api/changes**', route => route.fulfill({
    json: {
      change_marker: '20', changes: [], returned_items: 0,
      unchanged: true, has_more: false, next_since: '20',
    },
  }))
  const refreshed = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/changes',
  )
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await refreshed
  await expect(page.locator('#place-filter')).toHaveValue('77')
  await expect(facts).toHaveAttribute('open', '')
  await expect(page.locator('#view-scope')).toHaveText(selectedFacts)

  await summary.focus()
  await page.keyboard.press(' ')
  await expect(facts).not.toHaveAttribute('open', '')
  await summary.tap()
  await expect(facts).toHaveAttribute('open', '')
  expect(exactFacts.length).toBeGreaterThan(0)
})
}

test('empty share status takes no space and clipboard failure stays visible', async ({ page }) => {
  const status = page.locator('#share-status')
  await expect(status).toBeHidden()
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) },
    })
  })
  await page.locator('[role="tabpanel"]:visible [data-share-scope="view"]').click()
  await expect(status).toBeVisible()
  await expect(status).toContainText('The link could not copy. Copy this URL:')
  await expect(status).toHaveAttribute('data-tone', 'error')
})

test('focused scope failure remains visible while City facts stays closed', async ({ page }) => {
  let attempts = 0
  await page.route('**/api/window**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('collection') !== 'notes' ||
        url.searchParams.get('resident') !== 'far-walker') return route.fallback()
    attempts += 1
    return attempts === 1
      ? route.fulfill({ status: 503, json: { error: 'test conversation read failure' } })
      : route.fulfill({ json: {
          notes: [], has_more: false, next_before_id: null, change_marker: '20',
        } })
  })
  await page.locator('#resident-filter').selectOption('far-walker')
  await page.getByRole('tab', { name: 'Conversations' }).click()

  const facts = page.locator('#city-facts')
  await expect(facts).not.toHaveAttribute('open', '')
  const activeStatus = page.locator('#city-facts-status')
  await expect(activeStatus).toBeVisible()
  const failure = 'Conversation question: what far-walker said. That public read failed; retry is available in the conversation panel.'
  await expect(activeStatus).toHaveText(failure)
  await facts.locator('summary').click()
  await expect(facts.locator('#view-scope')).toBeVisible()
  await expect(facts.locator('#view-scope')).toContainText(failure)
  await facts.locator('summary').click()
  await expect(activeStatus).toBeVisible()
  const retry = page.getByRole('button', { name: /retry loading.*conversation/i })
  await expect(retry).toBeVisible()
  await retry.click()
  await expect(activeStatus).toBeHidden()
  await expect(facts).not.toHaveAttribute('open', '')
  await expect(facts.locator('#view-scope')).toContainText('Conversation question: what far-walker said. Nothing was found.')
  expect(attempts).toBe(2)
})

test('directory failure and retry remain visible on Gazette with City facts closed', async ({ page }) => {
  await expect(page.locator('#directory-status')).toContainText('The complete city directory could not be loaded.')
  await page.getByRole('tab', { name: 'Gazette', exact: true }).click()
  const facts = page.locator('#city-facts')
  await expect(facts).not.toHaveAttribute('open', '')
  await expect(page.locator('#place-filter')).toBeHidden()
  await expect(page.locator('#resident-filter')).toBeHidden()
  const status = page.locator('#city-facts-status')
  await expect(status).toBeVisible()
  await expect(status).toContainText('The complete city directory could not be loaded. Selectors show the currently loaded fallback.')
  let releaseRetry!: () => void
  const heldRetry = new Promise<void>(resolve => { releaseRetry = resolve })
  await page.route('**/api/window**', async route => {
    if (new URL(route.request().url()).searchParams.get('view') === 'directory') await heldRetry
    return route.fallback()
  })
  try {
    await status.getByRole('button', { name: 'Retry loading the complete directory', exact: true }).click()
    await expect(status).toHaveText('Loading the complete city directory. Map and content below are currently loaded separately.')
    await expect(status).not.toHaveAttribute('role', 'alert')
    await expect(status.getByRole('button')).toHaveCount(0)
  } finally {
    releaseRetry()
  }
  await expect(status).toBeHidden()
  await facts.locator('summary').click()
  await expect(facts.locator('#view-scope')).toBeVisible()
  await expect(facts.locator('#view-scope')).toContainText('Selectors use the complete city directory; map, presence, and authored content remain currently loaded views.')
})
