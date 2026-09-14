import { expect, test, type Page } from '@playwright/test'

const port = Number(process.env.E2E_PORT ?? 41_739)
const residentKey = `1f3d9_sk_${'ab'.repeat(24)}`
const state = 'openai-browser-return-state'
const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

test.use({
  launchOptions: {
    args: [
      '--no-proxy-server',
      `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${port}, MAP platform.openai.com 127.0.0.1:${port}, MAP unapproved.example 127.0.0.1:${port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
    ],
  },
})

test.afterEach(async ({ page }) => {
  // Close before Playwright can copy disposable credentials into a failure artifact.
  await page.close().catch(() => undefined)
})

function authorizationPath(origin: string, callback: string): string {
  return `/oauth/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: 'openai-browser-e2e-client',
    redirect_uri: callback,
    resource: `${origin}/mcp/connect`,
    scope: 'city:resident',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`
}

async function submitConsent(page: Page, origin: string, callback: string, action: 'approve' | 'cancel') {
  if (action === 'approve') await page.getByLabel('Current resident key').fill(residentKey)
  const cityResponse = page.waitForResponse(response => (
    response.url() === `${origin}/oauth/authorize` && response.request().method() === 'POST'
  ))
  const callbackResponse = page.waitForResponse(response => response.url().startsWith(`${callback}?`))
  const button = action === 'approve'
    ? page.getByRole('group', { name: 'I already live here' })
      .getByRole('button', { name: 'Approve and connect this resident' })
    : page.getByRole('button', { name: 'Cancel', exact: true })
  await button.click()
  const city = await cityResponse
  const returned = await callbackResponse
  const returnedUrl = new URL(returned.url())
  expect(city.status()).toBe(303)
  expect(city.headers().location).toBe(returnedUrl.href)
  expect(returned.request().method()).toBe('GET')
  expect(returned.request().postData()).toBeNull()
  expect(returnedUrl.searchParams.get('state')).toBe(state)
  if (action === 'approve') {
    expect(returnedUrl.searchParams.get('code')).toMatch(/^1f3d9_ac_[0-9a-f]{64}$/u)
    expect(returnedUrl.searchParams.has('error')).toBe(false)
  } else {
    expect(returnedUrl.searchParams.get('error')).toBe('access_denied')
    expect(returnedUrl.searchParams.has('code')).toBe(false)
  }
  expect((await page.context().cookies()).some(cookie => cookie.name === '__Host-1f3d9_oauth')).toBe(false)
  return returned
}

for (const action of ['approve', 'cancel'] as const) {
  for (const destination of ['direct', 'platform'] as const) {
    test(`OpenAI ${action} preserves the city 303 and completes the ${destination} return`, async ({ page, baseURL }) => {
      const callback = `https://chatgpt.com/connector/oauth/e2e-${destination}`
      const cspBlocked = new Promise<never>((_resolve, reject) => {
        page.on('console', message => {
          if (/content security policy|form-action/iu.test(message.text())) {
            reject(new Error(`Chromium blocked the OpenAI return: ${message.text()}`))
          }
        })
      })
      await page.goto(authorizationPath(baseURL!, callback))
      const returned = await Promise.race([submitConsent(page, baseURL!, callback, action), cspBlocked])
      expect(returned.status()).toBe(destination === 'direct' ? 200 : 302)
      const heading = destination === 'direct' ? 'ChatGPT callback reached' : 'OpenAI app return completed'
      await expect(page.getByRole('heading', { name: heading })).toBeVisible()
      if (destination === 'platform') await expect(page).toHaveURL('https://platform.openai.com/apps-manage/oauth')
      else expect(new URL(page.url()).origin).toBe('https://chatgpt.com')
    })
  }
}

test('OpenAI return blocks an unapproved third origin after the permitted platform hop', async ({ page, baseURL }) => {
  const callback = 'https://chatgpt.com/connector/oauth/e2e-unapproved-hop'
  await page.request.post('/__e2e/reset-openai-return-requests')
  await page.goto(authorizationPath(baseURL!, callback))
  await page.getByLabel('Current resident key').fill(residentKey)
  const cityResponse = page.waitForResponse(response => (
    response.url() === `${baseURL}/oauth/authorize` && response.request().method() === 'POST'
  ))
  // Chromium names the original form URL in this error, even when the blocked
  // destination is a later redirect. Check the local server's receipts as well.
  const cspViolation = page.waitForEvent('console', {
    predicate: message => /form-action/iu.test(message.text()),
  })
  await page.getByRole('group', { name: 'I already live here' })
    .getByRole('button', { name: 'Approve and connect this resident' }).click()
  expect((await cityResponse).status()).toBe(303)
  expect((await cspViolation).text()).toContain("form-action 'self' https://chatgpt.com https://platform.openai.com")
  expect((await page.context().cookies()).some(cookie => cookie.name === '__Host-1f3d9_oauth')).toBe(false)
  const receipts = await page.request.get('/__e2e/openai-return-requests')
  expect(await receipts.json()).toEqual([
    { method: 'GET', origin: 'https://chatgpt.com', path: '/connector/oauth/e2e-unapproved-hop', status: 302 },
    { method: 'GET', origin: 'https://platform.openai.com', path: '/apps-manage/oauth', status: 302 },
  ])
  await expect(page.getByRole('heading', { name: 'Unapproved return reached' })).toHaveCount(0)
})
