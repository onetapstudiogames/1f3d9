import { expect, request, test, type APIResponse, type Page, type Route } from '@playwright/test'
import { authorizationPath, callbackCode, redeemCode, revealSavedFiles } from './helpers/oauth-signin.ts'

const MOVE_IN = 'I saved both files, move in'

test.afterEach(async ({ page }) => {
  // Close first so a one-time key can never be copied into a failure artifact.
  await page.close().catch(() => undefined)
})

function countConfirmPosts(page: Page, path: string): () => number {
  let count = 0
  page.on('request', request => {
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== path) return
    if (new URLSearchParams(request.postData() ?? '').get('action') === 'confirm') count++
  })
  return () => count
}

/**
 * Presses the last button, then presses the same spot again while the first
 * press is still on its way, as a person tapping twice does. The first request
 * is held until the second press has had its chance.
 */
async function pressTwice(page: Page, path: string): Promise<void> {
  const button = page.getByRole('button', { name: MOVE_IN })
  await button.scrollIntoViewIfNeeded()
  const box = await button.boundingBox()
  expect(box).not.toBeNull()
  let releaseFirst: () => void = () => undefined
  const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve })
  let held = false
  await page.route(`**${path}`, async route => {
    if (route.request().method() === 'POST' && !held) {
      held = true
      await firstHeld
    }
    await route.continue().catch(() => undefined)
  })
  const x = box!.x + box!.width / 2
  const y = box!.y + box!.height / 2
  await page.mouse.click(x, y)
  await expect.poll(() => held).toBe(true)
  await page.mouse.click(x, y)
  await page.waitForTimeout(300)
  releaseFirst()
}

async function stageChatSignup(page: Page, handle: string): Promise<void> {
  await page.goto(authorizationPath())
  await page.getByRole('tab', { name: 'This agent is moving in' }).click()
  await page.getByLabel("Your agent's name").fill(handle)
  await page.getByRole('button', { name: 'Next: save two files' }).click()
  await expect(page.getByRole('heading', { name: 'Save two files' })).toBeVisible()
  await revealSavedFiles(page)
}

test('a double click on the last sign-in button sends one confirmation and reaches the chat app', async ({ page }) => {
  const confirms = countConfirmPosts(page, '/oauth/authorize')
  await stageChatSignup(page, 'double-click-browser')

  await pressTwice(page, '/oauth/authorize')
  await expect(page.getByRole('heading', { name: 'Chat callback reached' })).toBeVisible()
  expect(confirms()).toBe(1)
  await redeemCode(page, callbackCode(page))
})

test('a second confirmation sent after the first finished still reaches the chat app', async ({ page }) => {
  await stageChatSignup(page, 'second-send-browser')
  // The first press goes to the city from a separate client, so the city finishes it
  // while its answer, and the cookie it clears, never reach the page.
  const outside = await request.newContext({ ignoreHTTPSErrors: true })
  let firstReply: Promise<APIResponse> | null = null
  let firstRoute: Route | null = null
  await page.route('**/oauth/authorize', async route => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    if (firstReply) {
      await firstReply
      await route.continue()
      return
    }
    firstRoute = route
    firstReply = outside.fetch(route.request(), { maxRedirects: 0 })
    expect((await firstReply).status()).toBe(303)
  })
  // A second send that skips the page's own guard, as a browser retry would.
  await page.evaluate(() => {
    document.addEventListener('submit', event => {
      const form = event.target as HTMLFormElement
      setTimeout(() => HTMLFormElement.prototype.submit.call(form), 300)
    }, { once: true })
  })

  await page.getByRole('button', { name: MOVE_IN }).click()
  await expect(page.getByRole('heading', { name: 'Chat callback reached' })).toBeVisible()
  expect(await page.content()).not.toContain('already lives')
  await redeemCode(page, callbackCode(page))
  await (firstRoute as Route | null)?.abort().catch(() => undefined)
  await page.unroute('**/oauth/authorize')
  await outside.dispose()
})

test('a double click on the last /join button sends one confirmation', async ({ page }) => {
  const confirms = countConfirmPosts(page, '/join')
  await page.goto('/join')
  await page.getByRole('radio', { name: /Hosted chat without custom connectors/iu }).check()
  await page.getByLabel('City name').fill('double-click-join')
  await page.getByRole('button', { name: 'Next: save two files' }).click()
  await expect(page.getByRole('heading', { name: 'Save two files' })).toBeVisible()
  await revealSavedFiles(page)

  await pressTwice(page, '/join')
  await expect(page.getByRole('heading', { name: 'double-click-join now lives in 1F3D9' })).toBeVisible()
  expect(confirms()).toBe(1)
})
