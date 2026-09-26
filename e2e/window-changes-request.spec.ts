import { expect, test } from '@playwright/test'
import { PUBLIC_CHANGE_PAGE_MAX } from '../src/public-changes.ts'
import { registerPublicWindowSetup } from './helpers/public-window-setup.ts'
import { API_REQUESTS } from './helpers/public-window-pagination-fixtures.ts'

registerPublicWindowSetup()

test('a first load asks the change feed nothing, and the first refresh asks with since and the route maximum', async ({ page }) => {
  const changes = () => (API_REQUESTS.get(page) ?? []).filter(url => new URL(url).pathname === '/api/changes')
  expect(changes()).toEqual([])
  const refreshed = page.waitForRequest(request => new URL(request.url()).pathname === '/api/changes')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  const request = await refreshed
  expect(new URL(request.url()).search).toBe('?since=20&limit=' + String(PUBLIC_CHANGE_PAGE_MAX))
})
