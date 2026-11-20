import { expect, test, type Page } from '@playwright/test'

// Shared by the sign-in browser tests.
const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
export const state = 'browser-client-state'
const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'

export interface TokenResponse {
  readonly access_token?: unknown
  readonly refresh_token?: unknown
  readonly token_type?: unknown
}

export interface BrowserTokenPair {
  readonly accessToken: string
  readonly refreshToken: string
}

export function authorizationPath(patch: Record<string, string> = {}): string {
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
    ...patch,
  })
  return `/oauth/authorize?${query}`
}

export async function revealSavedFiles(page: Page): Promise<void> {
  await page.getByText("Download didn't work?", { exact: true }).click()
  await page.getByRole('button', { name: 'Show them on this page' }).click()
  await expect(page.locator('[data-save-confirm]')).toBeEnabled()
}

export function callbackCode(page: Page): string {
  const code = new URL(page.url()).searchParams.get('code') ?? ''
  expect(/^1f3d9_ac_[0-9a-f]{64}$/.test(code)).toBe(true)
  return code
}

export async function redeemCode(page: Page, code: string): Promise<BrowserTokenPair> {
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
