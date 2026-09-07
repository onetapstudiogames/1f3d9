import assert from 'node:assert/strict'
import { Hono } from 'hono'

export const ORIGIN = 'https://city.test'

export function assertSecretsAbsent(surface: string, secrets: readonly string[]): void {
  for (const secret of secrets) assert.equal(surface.includes(secret), false)
}

export async function pageState(
  app: Hono,
  path: '/join' | '/rotate' | '/recovery',
): Promise<{ cookie: string; csrf: string; html: string; setCookie: string }> {
  const response = await app.request(path)
  const html = await response.text()
  const setCookie = response.headers.get('set-cookie') ?? ''
  const cookie = setCookie.split(';', 1)[0]!
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1]
  assert.equal(response.status, 200)
  assert.ok(csrf)
  assert.ok(cookie)
  assert.match(html, /<form/iu)
  assert.doesNotMatch(html, /name="session_cookie"/iu)
  assert.equal(response.headers.get('location'), null)
  return { cookie, csrf, html, setCookie }
}

export function postForm(
  app: Hono,
  path: string,
  cookie: string,
  values: Record<string, string>,
  origin: string | null = ORIGIN,
  referer?: string,
  extraHeaders: Record<string, string> = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    cookie,
    ...extraHeaders,
  }
  if (origin !== null) headers.origin = origin
  if (referer !== undefined) headers.referer = referer
  return app.request(path, {
    method: 'POST',
    headers,
    body: new URLSearchParams(values),
  })
}

export async function assertRetryableCredentialRefusal(
  response: Response,
  path: '/join' | '/rotate' | '/recovery',
  csrf: string,
  expectedMessage: RegExp,
): Promise<string> {
  assert.equal(response.status, 403)
  assert.equal(response.headers.get('x-1f3d9-reason'), 'credential_rejected')
  assert.equal(response.headers.get('set-cookie'), null, 'the staged browser session must remain unchanged')
  const body = await response.text()
  assert.match(body, expectedMessage)
  assert.match(body, /try again on this page/iu)
  assert.match(body, /name="action" value="confirm"/u)
  assert.match(body, /name="resident_key"[^>]*type="password"/iu)
  assert.match(body, new RegExp(`name="csrf" value="${csrf}"`, 'u'))
  assert.doesNotMatch(body, /Start again/iu)
  assert.doesNotMatch(body, new RegExp(`href="${path}"`, 'u'))
  return body
}

export async function assertUnavailableStageRefusal(
  response: Response,
  path: '/join' | '/rotate' | '/recovery',
): Promise<string> {
  assert.equal(response.status, 403)
  assert.equal(response.headers.get('x-1f3d9-reason'), 'request_unavailable')
  const body = await response.text()
  assert.match(body, /expired|already used/iu)
  assert.match(body, /Start again/iu)
  assert.match(body, new RegExp(`href="${path}"`, 'u'))
  assert.doesNotMatch(body, /name="action" value="confirm"/u)
  return body
}

export function refusalMessage(body: string): string {
  const message = body.match(/<h1>[^<]+<\/h1><p>([^<]+)<\/p>/u)?.[1]
  assert.ok(message)
  return message
}
