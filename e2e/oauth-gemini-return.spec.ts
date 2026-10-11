import { expect, test } from '@playwright/test'

const port = Number(process.env.E2E_PORT ?? 41_739)
const residentKey = `1f3d9_sk_${'ab'.repeat(24)}`
const state = 'gemini-browser-return-state'
const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
const callbackPath = '/r/user_bound_custom-mcp-456789-127_0_0_1'

test.use({
  launchOptions: {
    args: [
      '--no-proxy-server',
      `--host-resolver-rules=MAP oauth-redirect.googleusercontent.com 127.0.0.1:${port}, MAP gemini-return.example 127.0.0.1:${port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
    ],
  },
})

test.afterEach(async ({ page }) => {
  await page.close().catch(() => undefined)
})

test('Gemini finishes from the city ready page through its exact callback link', async ({ page, baseURL }) => {
  const origin = baseURL!
  const callback = `https://oauth-redirect.googleusercontent.com${callbackPath}`
  const violations: string[] = []
  page.on('console', message => {
    if (/content security policy|form-action/iu.test(message.text())) violations.push('blocked navigation')
  })
  await page.request.post('/__e2e/reset-gemini-return-requests')

  const registered = await page.request.post('/oauth/register', {
    data: { redirect_uris: [callback] },
  })
  expect(registered.status()).toBe(201)
  const clientId = String((await registered.json()).client_id)
  const authorization = `${origin}/oauth/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: callback,
    resource: `${origin}/mcp/connect`,
    scope: 'city:resident',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`
  await page.goto(authorization)
  await page.getByLabel('Current resident key').fill(residentKey)

  const cityResponse = page.waitForResponse(response => (
    response.url() === `${origin}/oauth/authorize` && response.request().method() === 'POST'
  ))
  await page.getByRole('group', { name: 'I already live here' })
    .getByRole('button', { name: 'Approve and connect this resident' }).click()
  const response = await cityResponse
  expect(response.status()).toBe(200)
  const contentSecurityPolicy = response.headers()['content-security-policy']
  expect(contentSecurityPolicy).toContain(
    "form-action 'self' https://oauth-redirect.googleusercontent.com;",
  )
  expect(contentSecurityPolicy).not.toContain('gemini-return.example')
  expect(contentSecurityPolicy).not.toContain('*')
  expect(violations).toEqual([])
  await expect(page.getByRole('heading', { name: 'Your resident is ready' })).toBeVisible()
  await expect(page).toHaveURL(`${origin}/oauth/authorize`)

  const href = await page.getByRole('link', { name: 'Return to Gemini' }).getAttribute('href')
  expect(Boolean(href)).toBe(true)
  const returnUrl = new URL(href!, origin)
  expect(`${returnUrl.origin}${returnUrl.pathname}`).toBe(callback)
  expect(returnUrl.searchParams.get('state')).toBe(state)
  expect(/^1f3d9_ac_[0-9a-f]{64}$/u.test(returnUrl.searchParams.get('code') ?? '')).toBe(true)
  expect([...returnUrl.searchParams.keys()].sort()).toEqual(['code', 'state'])

  await page.getByRole('link', { name: 'Return to Gemini' }).click()
  await expect(page.getByRole('heading', { name: 'Gemini return destination reached' })).toBeVisible()
  expect(new URL(page.url()).origin).toBe('https://gemini-return.example')
  expect(violations).toEqual([])
  expect(await (await page.request.get('/__e2e/gemini-return-requests')).json()).toEqual([
    {
      method: 'GET', origin: 'https://oauth-redirect.googleusercontent.com',
      path: callbackPath, status: 302, has_referer: false,
    },
    {
      method: 'GET', origin: 'https://gemini-return.example',
      path: '/finish', status: 200, has_referer: false,
    },
  ])
  expect((await page.context().cookies()).some(cookie => cookie.name === '__Host-1f3d9_oauth')).toBe(false)
})
