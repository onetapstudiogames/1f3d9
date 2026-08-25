import { devices, expect, test, type Page } from '@playwright/test'

const existingResidentKey = `1f3d9_sk_${'ab'.repeat(24)}`
const recoveryResidentKey = `1f3d9_sk_${'cd'.repeat(24)}`
const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
const state = 'browser-client-state'
const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'

interface TokenResponse {
  readonly access_token?: unknown
  readonly refresh_token?: unknown
  readonly token_type?: unknown
}

interface BrowserTokenPair {
  readonly accessToken: string
  readonly refreshToken: string
}

interface McpResponse {
  readonly result?: {
    readonly content?: Array<{ readonly type?: unknown; readonly text?: unknown }>
    readonly isError?: unknown
  }
}

interface SecretSurfaceObservations {
  readonly requestUrls: string[]
  readonly browserLogs: string[]
  readonly browserErrors: string[]
}

test.afterEach(async ({ page }) => {
  // Playwright writes an accessibility snapshot for a failed open page even
  // when traces and screenshots are disabled. Close first so a one-time key
  // can never be copied into a failure artifact.
  await page.close().catch(() => undefined)
})

function authorizationPath(): string {
  const origin = test.info().project.use.baseURL as string
  const callback = `${origin.replace('127.0.0.1', 'localhost')}/oauth/callback`
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: 'browser-e2e-client',
    redirect_uri: callback,
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

function observeSecretSurfaces(page: Page): SecretSurfaceObservations {
  const observations: SecretSurfaceObservations = {
    requestUrls: [],
    browserLogs: [],
    browserErrors: [],
  }
  page.on('request', request => observations.requestUrls.push(request.url()))
  page.on('console', message => observations.browserLogs.push(`${message.type()}: ${message.text()}`))
  page.on('pageerror', error => observations.browserErrors.push(error.message))
  return observations
}

async function expectNoResidentKeyOutsidePage(
  page: Page,
  secretOrSecrets?: string | readonly string[],
  observations?: SecretSurfaceObservations,
): Promise<void> {
  const cookies = JSON.stringify(await page.context().cookies())
  const storage = await browserStorage(page)
  const forbidden = typeof secretOrSecrets === 'string'
    ? [secretOrSecrets]
    : (secretOrSecrets ?? ['1f3d9_sk_', '1f3d9_rc_'])
  const surfaces = [
    page.url(),
    cookies,
    storage,
    observations?.requestUrls.join('\n') ?? '',
    observations?.browserLogs.join('\n') ?? '',
    observations?.browserErrors.join('\n') ?? '',
  ]
  for (const surface of surfaces) {
    for (const secret of forbidden) expect(surface.includes(secret)).toBe(false)
  }
}

function callbackCode(page: Page): string {
  const code = new URL(page.url()).searchParams.get('code') ?? ''
  expect(/^1f3d9_ac_[0-9a-f]{64}$/.test(code)).toBe(true)
  return code
}

async function redeemCode(page: Page, code: string): Promise<BrowserTokenPair> {
  const origin = test.info().project.use.baseURL as string
  const callback = `${origin.replace('127.0.0.1', 'localhost')}/oauth/callback`
  const response = await page.request.post('/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      client_id: 'browser-e2e-client',
      redirect_uri: callback,
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
  const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : ''
  expect(/^1f3d9_at_[0-9a-f]{64}$/.test(accessToken)).toBe(true)
  expect(/^1f3d9_rt_[0-9a-f]{64}$/.test(refreshToken)).toBe(true)
  expect(tokens.token_type).toBe('Bearer')
  return { accessToken, refreshToken }
}

async function refreshAccess(page: Page, presentedRefreshToken: string): Promise<BrowserTokenPair> {
  const origin = test.info().project.use.baseURL as string
  const response = await page.request.post('/oauth/token', {
    form: {
      grant_type: 'refresh_token',
      client_id: 'browser-e2e-client',
      resource: `${origin}/mcp/connect`,
      scope: 'city:resident',
      refresh_token: presentedRefreshToken,
    },
  })
  expect(response.status()).toBe(200)
  const tokens = await response.json() as TokenResponse
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : ''
  const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : ''
  expect(/^1f3d9_at_[0-9a-f]{64}$/.test(accessToken)).toBe(true)
  expect(/^1f3d9_rt_[0-9a-f]{64}$/.test(refreshToken)).toBe(true)
  expect(accessToken).not.toBe('')
  expect(refreshToken).not.toBe(presentedRefreshToken)
  return { accessToken, refreshToken }
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

async function withStrippedBrowserHeaders(page: Page, path: string, action: () => Promise<void>) {
  await page.route(`**${path}`, async route => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    const headers = { ...route.request().headers() }
    delete headers.origin
    delete headers.referer
    await route.continue({ headers })
  })
  try {
    await action()
  } finally {
    await page.unroute(`**${path}`)
  }
}

test('shows a clear consent page without exposing a resident key', async ({ page }) => {
  const response = await page.goto(authorizationPath())

  expect(response?.request().redirectedFrom()).toBeNull()
  expect([...new URL(page.url()).searchParams.keys()].some(name => name.startsWith('_1f3d9_cookie_'))).toBe(false)
  await expect(page.getByRole('heading', { name: 'Let this chat enter 1F3D9?' })).toBeVisible()
  await expect(page.getByText('Hosted Chat Browser Test')).toBeVisible()
  await expect(page.getByLabel('Current resident key')).toBeVisible()
  await expect(page.getByLabel('Agent-chosen city name')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve and connect this resident' })).toBeVisible()
  expect(response?.headers()['cache-control']).toContain('no-store')
  expect(response?.headers()['x-frame-options']).toBe('DENY')
  await expectNoResidentKeyOutsidePage(page)

  const sessionCookie = (await page.context().cookies()).find(cookie => (
    cookie.name === '__Host-1f3d9_oauth'
  ))
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
  const initialTokens = await redeemCode(page, callbackCode(page))
  const refreshedTokens = await refreshAccess(page, initialTokens.refreshToken)

  const connectorResponse = await callMeTool(page, '/mcp/connect', refreshedTokens.accessToken)
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
    headers: { authorization: `Bearer ${refreshedTokens.accessToken}` },
  })
  expect(rawResponse.status()).toBe(401)

  const legacyResponse = await callMeTool(page, '/mcp', refreshedTokens.accessToken)
  expect(legacyResponse.status()).toBe(200)
  const legacyBody = await legacyResponse.json() as McpResponse
  expect(legacyBody.result?.isError).toBe(true)
  expect(legacyBody.result?.content?.[0]?.text).toContain('/mcp/connect')
  expect(legacyBody.result?.content?.[0]?.text).toMatch(/remove.*connection|wrong.*address/i)

  expect(requestUrls.join('\n')).not.toContain(existingResidentKey)
  expect((await page.content()).includes(existingResidentKey)).toBe(false)
  await expectNoResidentKeyOutsidePage(page, existingResidentKey)
})

test('shows a new resident key once and waits for saved confirmation', async ({ page }) => {
  const observations = observeSecretSurfaces(page)
  await page.goto(authorizationPath())
  await page.getByLabel('Agent-chosen city name').fill('goldfish-browser')
  await page.getByLabel('Model label (optional)').fill('browser-test-model')
  await page.getByRole('button', { name: 'Prepare resident and show its key' }).click()

  expect(await page.getByRole('heading', { name: "Save goldfish-browser's resident key" }).isVisible()).toBe(true)
  const codeValues = (await page.locator('code').allTextContents()).map(text => text.trim())
  const residentKey = codeValues.find(text => /^1f3d9_sk_[0-9a-f]{48}$/.test(text)) ?? ''
  const recoveryCodes = codeValues.filter(text => /^1f3d9_rc_[0-9a-f]{64}$/.test(text))
  expect(/^1f3d9_sk_[0-9a-f]{48}$/.test(residentKey)).toBe(true)
  expect(recoveryCodes).toHaveLength(8)
  expect(new Set(recoveryCodes).size).toBe(8)
  const initialSecrets = [residentKey, ...recoveryCodes]
  expect(await page.getByText('It is shown once').isVisible()).toBe(true)
  expect(await page.getByText('This resident has not been created yet.').isVisible()).toBe(true)
  await expectNoResidentKeyOutsidePage(page, initialSecrets, observations)

  await page.getByRole('button', { name: 'Create resident and continue' }).click()
  expect(await page.getByRole('heading', { name: "Save goldfish-browser's resident key" }).isVisible()).toBe(true)
  await page.getByLabel('Re-enter the saved resident key').fill(residentKey)
  await page.getByRole('button', { name: 'Create resident and continue' }).click()
  await expect(page.getByRole('heading', { name: 'Chat callback reached' })).toBeVisible()

  const callback = new URL(page.url())
  expect(callback.searchParams.get('state')).toBe(state)
  callbackCode(page)
  const callbackPage = await page.content()
  for (const secret of initialSecrets) expect(callbackPage.includes(secret)).toBe(false)
  await expectNoResidentKeyOutsidePage(page, initialSecrets, observations)

  await page.goto('/recovery')
  await page.getByLabel('Unused recovery code').fill(recoveryCodes[0]!)
  await page.getByRole('button', { name: 'Show a replacement key' }).click()
  await expect(page.getByRole('heading', { name: "Save goldfish-browser's replacement key" })).toBeVisible()
  const replacementKey = (await page.locator('code').textContent())?.trim() ?? ''
  expect(/^1f3d9_sk_[0-9a-f]{48}$/.test(replacementKey)).toBe(true)
  initialSecrets.push(replacementKey)
  await page.getByLabel('Re-enter the replacement resident key').fill(replacementKey)
  await page.getByRole('button', { name: 'Replace the lost key' }).click()
  await expect(page.getByRole('heading', { name: 'goldfish-browser is recovered' })).toBeVisible()

  await page.goto('/rotate')
  await page.getByLabel('Current resident key').fill(residentKey)
  await page.getByRole('button', { name: 'Show a replacement key' }).click()
  await expect(page.getByRole('heading', { name: 'Request stopped' })).toBeVisible()

  await page.goto('/rotate')
  await page.getByLabel('Current resident key').fill(replacementKey)
  await page.getByRole('button', { name: 'Show a replacement key' }).click()
  await expect(page.getByRole('heading', { name: "Save goldfish-browser's replacement key" })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel and keep the current key' }).click()
  await expect(page.getByRole('heading', { name: 'Rotation canceled' })).toBeVisible()

  await page.goto('/recovery')
  await page.getByLabel('Unused recovery code').fill(recoveryCodes[1]!)
  await page.getByRole('button', { name: 'Show a replacement key' }).click()
  await expect(page.getByRole('heading', { name: 'Request stopped' })).toBeVisible()
  await expectNoResidentKeyOutsidePage(page, initialSecrets, observations)
})

test('rejects a different well-formed key during new-resident confirmation', async ({ page }) => {
  const observations = observeSecretSurfaces(page)
  await page.goto(authorizationPath())
  await page.getByLabel('Agent-chosen city name').fill('wrong-confirmation-browser')
  await page.getByLabel('Model label (optional)').fill('browser-test-model')
  await page.getByRole('button', { name: 'Prepare resident and show its key' }).click()
  const initialSecrets = (await page.locator('code').allTextContents()).map(text => text.trim())
  expect(initialSecrets).toHaveLength(9)
  const residentKey = initialSecrets.find(secret => /^1f3d9_sk_[0-9a-f]{48}$/.test(secret)) ?? ''
  expect(residentKey).toMatch(/^1f3d9_sk_[0-9a-f]{48}$/)

  await page.getByLabel('Re-enter the saved resident key').fill(existingResidentKey)
  const rejectionPromise = page.waitForResponse(response => (
    response.url().endsWith('/oauth/authorize') &&
    response.request().method() === 'POST' &&
    response.status() === 403
  ))
  await page.getByRole('button', { name: 'Create resident and continue' }).click()
  const rejection = await rejectionPromise

  await expect(page.getByRole('heading', { name: 'Sign-in stopped' })).toBeVisible()
  expect(rejection.headers()['x-1f3d9-reason']).toBe('confirmation_rejected')
  await expect(page.getByText('confirmation_rejected', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Re-enter the saved resident key')).toBeVisible()
  const errorPage = await page.content()
  for (const secret of initialSecrets) expect(errorPage.includes(secret)).toBe(false)
  await expectNoResidentKeyOutsidePage(page, initialSecrets, observations)

  const retryInput = page.getByLabel('Re-enter the saved resident key')
  await retryInput.fill(residentKey)
  const retryPromise = page.waitForResponse(response => (
    response.url().endsWith('/oauth/authorize') && response.request().method() === 'POST'
  ))
  await page.getByRole('button', { name: 'Try this key' }).click()
  const retry = await retryPromise
  expect(retry.status()).toBe(303)
  await expect(page.getByRole('heading', { name: 'Chat callback reached' })).toBeVisible()
  await expectNoResidentKeyOutsidePage(page, initialSecrets, observations)
})

test('joins through the first-party page and an initial recovery code works', async ({ page }) => {
  const observations = observeSecretSurfaces(page)
  const response = await page.goto('/join')
  await expect(page.getByRole('heading', { name: 'Move into 1F3D9' })).toBeVisible()
  expect(response?.headers()['cache-control']).toContain('no-store')
  expect(response?.headers()['referrer-policy']).toBe('same-origin')

  await page.getByLabel('City name').fill('standalone-browser')
  await page.getByLabel('Model label (optional)').fill('browser-test-model')
  await page.getByRole('button', { name: 'Show the new resident key' }).click()
  await expect(page.getByRole('heading', { name: "Save standalone-browser's resident key" })).toBeVisible()
  const codeValues = (await page.locator('code').allTextContents()).map(code => code.trim())
  const residentKey = codeValues.find(code => /^1f3d9_sk_[0-9a-f]{48}$/.test(code)) ?? ''
  const recoveryCodes = codeValues.filter(code => /^1f3d9_rc_[0-9a-f]{64}$/.test(code))
  expect(/^1f3d9_sk_[0-9a-f]{48}$/.test(residentKey)).toBe(true)
  expect(recoveryCodes).toHaveLength(8)
  expect(new Set(recoveryCodes).size).toBe(8)
  const initialSecrets = [residentKey, ...recoveryCodes]
  await expectNoResidentKeyOutsidePage(page, initialSecrets, observations)

  await page.getByLabel('Re-enter the saved resident key').fill(residentKey)
  await page.getByRole('button', { name: 'Create this resident' }).click()
  await expect(page.getByRole('heading', { name: 'standalone-browser now lives in 1F3D9' })).toBeVisible()
  const successPage = await page.content()
  for (const secret of initialSecrets) expect(successPage.includes(secret)).toBe(false)
  await expectNoResidentKeyOutsidePage(page, initialSecrets, observations)

  await page.goto('/recovery')
  await page.getByLabel('Unused recovery code').fill(recoveryCodes[0]!)
  await page.getByRole('button', { name: 'Show a replacement key' }).click()
  await expect(page.getByRole('heading', { name: "Save standalone-browser's replacement key" })).toBeVisible()
  const replacementKey = (await page.locator('code').textContent())?.trim() ?? ''
  expect(/^1f3d9_sk_[0-9a-f]{48}$/.test(replacementKey)).toBe(true)
  initialSecrets.push(replacementKey)
  await expectNoResidentKeyOutsidePage(page, initialSecrets, observations)
  await page.getByLabel('Re-enter the replacement resident key').fill(replacementKey)
  await page.getByRole('button', { name: 'Replace the lost key' }).click()
  await expect(page.getByRole('heading', { name: 'standalone-browser is recovered' })).toBeVisible()
  const recoverySuccess = await page.content()
  for (const secret of initialSecrets) expect(recoverySuccess.includes(secret)).toBe(false)
  await expectNoResidentKeyOutsidePage(page, initialSecrets, observations)

  await page.goto('/rotate')
  await page.getByLabel('Current resident key').fill(residentKey)
  await page.getByRole('button', { name: 'Show a replacement key' }).click()
  await expect(page.getByRole('heading', { name: 'Request stopped' })).toBeVisible()

  await page.goto('/rotate')
  await page.getByLabel('Current resident key').fill(replacementKey)
  await page.getByRole('button', { name: 'Show a replacement key' }).click()
  await expect(page.getByRole('heading', { name: "Save standalone-browser's replacement key" })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel and keep the current key' }).click()
  await expect(page.getByRole('heading', { name: 'Rotation canceled' })).toBeVisible()

  await page.goto('/recovery')
  await page.getByLabel('Unused recovery code').fill(recoveryCodes[1]!)
  await page.getByRole('button', { name: 'Show a replacement key' }).click()
  await expect(page.getByRole('heading', { name: 'Request stopped' })).toBeVisible()
  await expectNoResidentKeyOutsidePage(page, initialSecrets, observations)
})

for (const profile of [
  { label: 'desktop', device: devices['Desktop Chrome'] },
  { label: 'mobile', device: devices['Pixel 5'] },
] as const) {
  test(`${profile.label} signup works when the browser strips Origin and Referer`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({
      ...profile.device,
      baseURL,
      ignoreHTTPSErrors: true,
    })
    const page = await context.newPage()
    const observations = observeSecretSurfaces(page)
    const observedSecrets: string[] = []

    try {
      const joinHandle = `${profile.label}-header-join`
      await page.goto('/join')
      await page.getByLabel('City name').fill(joinHandle)
      await page.getByLabel('Model label (optional)').fill('browser-test-model')
      await withStrippedBrowserHeaders(page, '/join', async () => {
        await page.getByRole('button', { name: 'Show the new resident key' }).click()
      })
      await expect(page.getByRole('heading', { name: `Save ${joinHandle}'s resident key` })).toBeVisible()
      const joinedSecrets = (await page.locator('code').allTextContents()).map(code => code.trim())
      expect(joinedSecrets.filter(code => /^1f3d9_sk_[0-9a-f]{48}$/.test(code))).toHaveLength(1)
      expect(joinedSecrets.filter(code => /^1f3d9_rc_[0-9a-f]{64}$/.test(code))).toHaveLength(8)
      expect(new Set(joinedSecrets).size).toBe(9)
      observedSecrets.push(...joinedSecrets)
      await expectNoResidentKeyOutsidePage(page, observedSecrets, observations)
      const joinedKey = joinedSecrets.find(code => /^1f3d9_sk_[0-9a-f]{48}$/.test(code)) ?? ''
      await page.getByLabel('Re-enter the saved resident key').fill(joinedKey)
      await withStrippedBrowserHeaders(page, '/join', async () => {
        await page.getByRole('button', { name: 'Create this resident' }).click()
      })
      await expect(page.getByRole('heading', { name: `${joinHandle} now lives in 1F3D9` })).toBeVisible()
      const joinSuccess = await page.content()
      for (const secret of joinedSecrets) expect(joinSuccess.includes(secret)).toBe(false)
      await expectNoResidentKeyOutsidePage(page, observedSecrets, observations)

      await page.goto('/rotate')
      await page.getByLabel('Current resident key').fill(existingResidentKey)
      await withStrippedBrowserHeaders(page, '/rotate', async () => {
        await page.getByRole('button', { name: 'Show a replacement key' }).click()
      })
      await expect(page.getByRole('heading', { name: "Save browser-resident's replacement key" })).toBeVisible()

      await page.goto('/recovery')
      await page.getByLabel('Current resident key').fill(recoveryResidentKey)
      await withStrippedBrowserHeaders(page, '/recovery', async () => {
        await page.getByRole('button', { name: 'Create recovery codes' }).click()
      })
      await expect(page.getByRole('heading', { name: "Save recovery-browser's recovery codes" })).toBeVisible()

      const oauthHandle = `${profile.label}-header-oauth`
      await page.goto(authorizationPath())
      await page.getByLabel('Agent-chosen city name').fill(oauthHandle)
      await page.getByLabel('Model label (optional)').fill('browser-test-model')
      await withStrippedBrowserHeaders(page, '/oauth/authorize', async () => {
        await page.getByRole('button', { name: 'Prepare resident and show its key' }).click()
      })
      await expect(page.getByRole('heading', { name: `Save ${oauthHandle}'s resident key` })).toBeVisible()
      const oauthSecrets = (await page.locator('code').allTextContents()).map(code => code.trim())
      expect(oauthSecrets.filter(code => /^1f3d9_sk_[0-9a-f]{48}$/.test(code))).toHaveLength(1)
      expect(oauthSecrets.filter(code => /^1f3d9_rc_[0-9a-f]{64}$/.test(code))).toHaveLength(8)
      expect(new Set(oauthSecrets).size).toBe(9)
      observedSecrets.push(...oauthSecrets)
      await expectNoResidentKeyOutsidePage(page, observedSecrets, observations)
      const oauthKey = oauthSecrets.find(code => /^1f3d9_sk_[0-9a-f]{48}$/.test(code)) ?? ''
      await page.getByLabel('Re-enter the saved resident key').fill(oauthKey)
      await withStrippedBrowserHeaders(page, '/oauth/authorize', async () => {
        await page.getByRole('button', { name: 'Create resident and continue' }).click()
      })
      await expect(page.getByRole('heading', { name: 'Chat callback reached' })).toBeVisible()
      const oauthSuccess = await page.content()
      for (const secret of oauthSecrets) expect(oauthSuccess.includes(secret)).toBe(false)
      await expectNoResidentKeyOutsidePage(page, observedSecrets, observations)

      await page.goto(authorizationPath())
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.getByLabel('Current resident key').fill(existingResidentKey)
      await withStrippedBrowserHeaders(page, '/oauth/authorize', async () => {
        await page.getByRole('button', { name: 'Approve and connect this resident' }).click()
      })
      await expect(page.getByRole('heading', { name: 'Chat callback reached' })).toBeVisible()
      observedSecrets.push(existingResidentKey)
      await expectNoResidentKeyOutsidePage(page, observedSecrets, observations)
    } finally {
      await context.close()
    }
  })
}

test('rotates a resident key only after the private replacement is re-entered', async ({ page }) => {
  const response = await page.goto('/rotate')
  await expect(page.getByRole('heading', { name: 'Rotate a resident key' })).toBeVisible()
  expect(response?.headers()['cache-control']).toContain('no-store')
  expect(response?.headers()['x-frame-options']).toBe('DENY')

  await page.getByLabel('Current resident key').fill(existingResidentKey)
  await page.getByRole('button', { name: 'Show a replacement key' }).click()
  await expect(page.getByRole('heading', { name: "Save browser-resident's replacement key" })).toBeVisible()
  const replacementKey = (await page.locator('code').textContent())?.trim() ?? ''
  expect(/^1f3d9_sk_[0-9a-f]{48}$/.test(replacementKey)).toBe(true)
  expect(replacementKey).not.toBe(existingResidentKey)
  await expectNoResidentKeyOutsidePage(page, replacementKey)

  await page.getByLabel('Re-enter the replacement resident key').fill(replacementKey)
  await page.getByRole('button', { name: 'Activate the replacement key' }).click()
  await expect(page.getByRole('heading', { name: "browser-resident's key is rotated" })).toBeVisible()
  expect((await page.content()).includes(replacementKey)).toBe(false)
  await expectNoResidentKeyOutsidePage(page, replacementKey)
})

test('generated recovery codes replace a lost key once and revoke the old key and siblings', async ({ page }) => {
  const response = await page.goto('/recovery')
  await expect(page.getByRole('heading', { name: 'Resident-key recovery' })).toBeVisible()
  expect(response?.headers()['cache-control']).toContain('no-store')
  expect(response?.headers()['referrer-policy']).toBe('same-origin')

  await page.getByLabel('Current resident key').fill(recoveryResidentKey)
  await page.getByRole('button', { name: 'Create recovery codes' }).click()
  await expect(page.getByRole('heading', { name: "Save recovery-browser's recovery codes" })).toBeVisible()
  const codes = (await page.locator('code').allTextContents()).map(code => code.trim())
  expect(codes).toHaveLength(8)
  expect(new Set(codes).size).toBe(8)
  expect(codes.every(code => /^1f3d9_rc_[0-9a-f]{64}$/.test(code))).toBe(true)

  await page.goto('/recovery')
  await page.getByLabel('Unused recovery code').fill(codes[0]!)
  await page.getByRole('button', { name: 'Show a replacement key' }).click()
  await expect(page.getByRole('heading', { name: "Save recovery-browser's replacement key" })).toBeVisible()
  const replacementKey = (await page.locator('code').textContent())?.trim() ?? ''
  expect(/^1f3d9_sk_[0-9a-f]{48}$/.test(replacementKey)).toBe(true)
  await page.getByLabel('Re-enter the replacement resident key').fill(replacementKey)
  await page.getByRole('button', { name: 'Replace the lost key' }).click()
  await expect(page.getByRole('heading', { name: 'recovery-browser is recovered' })).toBeVisible()

  await page.goto('/rotate')
  await page.getByLabel('Current resident key').fill(recoveryResidentKey)
  await page.getByRole('button', { name: 'Show a replacement key' }).click()
  await expect(page.getByRole('heading', { name: 'Request stopped' })).toBeVisible()

  await page.goto('/rotate')
  await page.getByLabel('Current resident key').fill(replacementKey)
  await page.getByRole('button', { name: 'Show a replacement key' }).click()
  await expect(page.getByRole('heading', { name: "Save recovery-browser's replacement key" })).toBeVisible()

  await page.goto('/recovery')
  await page.getByLabel('Unused recovery code').fill(codes[1]!)
  await page.getByRole('button', { name: 'Show a replacement key' }).click()
  await expect(page.getByRole('heading', { name: 'Request stopped' })).toBeVisible()
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
  await expect(page.getByText('This sign-in form and its private browser cookie did not match.')).toBeVisible()
  await expect(page.getByText('browser_cookie_mismatch', { exact: true })).toBeVisible()
  await expect(page.locator('p', { hasText: 'Request ID:' }).locator('code')).toHaveText(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  )
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
