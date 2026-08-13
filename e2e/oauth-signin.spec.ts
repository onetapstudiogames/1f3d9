import { expect, test, type Page } from '@playwright/test'

const existingResidentKey = `1f3d9_sk_${'ab'.repeat(24)}`
const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
const state = 'browser-client-state'
const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'

interface TokenResponse {
  readonly access_token?: unknown
  readonly refresh_token?: unknown
  readonly token_type?: unknown
}

interface McpResponse {
  readonly result?: {
    readonly content?: Array<{ readonly type?: unknown; readonly text?: unknown }>
    readonly isError?: unknown
  }
}

test.afterEach(async ({ page }) => {
  // Playwright writes an accessibility snapshot for a failed open page even
  // when traces and screenshots are disabled. Close first so a one-time key
  // can never be copied into a failure artifact.
  await page.close().catch(() => undefined)
})

function authorizationPath(): string {
  const origin = test.info().project.use.baseURL as string
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: 'browser-e2e-client',
    redirect_uri: `${origin}/oauth/callback`,
    resource: `${origin}/mcp/connect`,
    scope: 'city:resident',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  return `/oauth/authorize?${query}`
}

async function browserStorage(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify({
    local: { ...localStorage },
    session: { ...sessionStorage },
  }))
}

async function expectNoResidentKeyOutsidePage(page: Page, key?: string): Promise<void> {
  const cookies = JSON.stringify(await page.context().cookies())
  const storage = await browserStorage(page)
  const forbidden = key ?? '1f3d9_sk_'
  expect(page.url().includes(forbidden)).toBe(false)
  expect(cookies.includes(forbidden)).toBe(false)
  expect(storage.includes(forbidden)).toBe(false)
}

function callbackCode(page: Page): string {
  const code = new URL(page.url()).searchParams.get('code') ?? ''
  expect(/^1f3d9_ac_[0-9a-f]{64}$/.test(code)).toBe(true)
  return code
}

async function redeemCode(page: Page, code: string): Promise<string> {
  const origin = test.info().project.use.baseURL as string
  const response = await page.request.post('/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      client_id: 'browser-e2e-client',
      redirect_uri: `${origin}/oauth/callback`,
      resource: `${origin}/mcp/connect`,
      scope: 'city:resident',
      code,
      code_verifier: verifier,
    },
  })
  if (response.status() !== 200) {
    throw new Error(`The disposable token exchange returned HTTP ${response.status()}`)
  }
  const tokens = await response.json() as TokenResponse
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : ''
  expect(/^1f3d9_at_[0-9a-f]{64}$/.test(accessToken)).toBe(true)
  expect(
    typeof tokens.refresh_token === 'string' &&
    /^1f3d9_rt_[0-9a-f]{64}$/.test(tokens.refresh_token),
  ).toBe(true)
  expect(tokens.token_type).toBe('Bearer')
  return accessToken
}

async function callMeTool(page: Page, endpoint: '/mcp' | '/mcp/connect', accessToken: string) {
  return page.request.post(endpoint, {
    headers: { authorization: `Bearer ${accessToken}` },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'me', arguments: {} },
    },
  })
}

test('shows a clear consent page without exposing a resident key', async ({ page }) => {
  const response = await page.goto(authorizationPath())

  await expect(page.getByRole('heading', { name: 'Let this chat enter 1F3D9?' })).toBeVisible()
  await expect(page.getByText('Hosted Chat Browser Test')).toBeVisible()
  await expect(page.getByLabel('Current resident key')).toBeVisible()
  await expect(page.getByLabel('Agent-chosen city name')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve and connect this resident' })).toBeVisible()
  expect(response?.headers()['cache-control']).toContain('no-store')
  expect(response?.headers()['x-frame-options']).toBe('DENY')
  await expectNoResidentKeyOutsidePage(page)

  const sessionCookie = (await page.context().cookies()).find(cookie => cookie.name === '__Host-1f3d9_oauth')
  expect(sessionCookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' })
})

test('signs in, redeems the callback code, and enters through the protected connector', async ({ page }) => {
  const requestUrls: string[] = []
  page.on('request', request => requestUrls.push(request.url()))
  await page.goto(authorizationPath())

  await page.getByLabel('Current resident key').fill(existingResidentKey)
  await page.getByRole('button', { name: 'Approve and connect this resident' }).click()

  await expect(page.getByRole('heading', { name: 'Chat callback reached' })).toBeVisible()
  const callback = new URL(page.url())
  expect(callback.pathname).toBe('/oauth/callback')
  expect(callback.searchParams.get('state')).toBe(state)
  const accessToken = await redeemCode(page, callbackCode(page))

  const connectorResponse = await callMeTool(page, '/mcp/connect', accessToken)
  expect(connectorResponse.status()).toBe(200)
  const connectorBody = await connectorResponse.json() as McpResponse
  expect(connectorBody.result?.isError).toBe(false)
  const protectedText = connectorBody.result?.content?.[0]?.text
  const protectedResult = typeof protectedText === 'string'
    ? JSON.parse(protectedText) as Record<string, unknown>
    : {}
  expect(protectedResult).toMatchObject({
    resident_id: 49,
    handle: 'browser-resident',
    protected: true,
  })

  const rawResponse = await page.request.get('/api/me', {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  expect(rawResponse.status()).toBe(401)

  const legacyResponse = await callMeTool(page, '/mcp', accessToken)
  expect(legacyResponse.status()).toBe(200)
  const legacyBody = await legacyResponse.json() as McpResponse
  expect(legacyBody.result?.isError).toBe(true)

  expect(requestUrls.join('\n')).not.toContain(existingResidentKey)
  expect((await page.content()).includes(existingResidentKey)).toBe(false)
  await expectNoResidentKeyOutsidePage(page, existingResidentKey)
})

test('shows a new resident key once and waits for saved confirmation', async ({ page }) => {
  await page.goto(authorizationPath())
  await page.getByLabel('Agent-chosen city name').fill('goldfish-browser')
  await page.getByLabel('Model label (optional)').fill('browser-test-model')
  await page.getByRole('button', { name: 'Prepare resident and show its key' }).click()

  expect(await page.getByRole('heading', { name: "Save goldfish-browser's resident key" }).isVisible()).toBe(true)
  const residentKey = (await page.locator('code').textContent())?.trim() ?? ''
  expect(/^1f3d9_sk_[0-9a-f]{48}$/.test(residentKey)).toBe(true)
  expect(await page.getByText('It is shown once').isVisible()).toBe(true)
  expect(await page.getByText('This resident has not been created yet.').isVisible()).toBe(true)
  await expectNoResidentKeyOutsidePage(page, residentKey)

  await page.getByRole('button', { name: 'Create resident and continue' }).click()
  expect(await page.getByRole('heading', { name: "Save goldfish-browser's resident key" }).isVisible()).toBe(true)

  await page.getByLabel('I saved the key somewhere private.').check()
  await page.getByRole('button', { name: 'Create resident and continue' }).click()
  await expect(page.getByRole('heading', { name: 'Chat callback reached' })).toBeVisible()

  const callback = new URL(page.url())
  expect(callback.searchParams.get('state')).toBe(state)
  callbackCode(page)
  expect((await page.content()).includes(residentKey)).toBe(false)
  await expectNoResidentKeyOutsidePage(page, residentKey)
})

test('stops a form whose CSRF proof was changed in the browser', async ({ page }) => {
  await page.goto(authorizationPath())
  await page.getByLabel('Current resident key').fill(existingResidentKey)
  await page.locator('form').first().evaluate(element => {
    const form = element as HTMLFormElement
    const csrf = form.querySelector<HTMLInputElement>('input[name="csrf"]')
    if (csrf) csrf.value = 'tampered-proof'
    form.requestSubmit()
  })

  await expect(page.getByRole('heading', { name: 'Sign-in stopped' })).toBeVisible()
  await expect(page.getByText('could not be verified')).toBeVisible()
  expect(page.url().includes(existingResidentKey)).toBe(false)
  expect((await page.content()).includes(existingResidentKey)).toBe(false)
})

test('stops approval submitted from a different browser origin', async ({ page, baseURL }) => {
  const foreignOrigin = baseURL!.replace('127.0.0.1', 'localhost')
  await page.goto(`${foreignOrigin}${authorizationPath()}`)
  await page.getByLabel('Current resident key').fill(existingResidentKey)
  await page.getByRole('button', { name: 'Approve and connect this resident' }).click()

  await expect(page.getByRole('heading', { name: 'Sign-in stopped' })).toBeVisible()
  await expect(page.getByText('did not come from the 1F3D9 sign-in page')).toBeVisible()
  expect((await page.content()).includes(existingResidentKey)).toBe(false)
})
