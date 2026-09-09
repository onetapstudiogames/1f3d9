import { expect, test } from '@playwright/test'
import { SNAPSHOT } from '../helpers/public-window-snapshot-fixtures.ts'

export function registerPublicWindowInitialReadFailure() {
  test('an initial failed read names the failure and offers an immediate retry', async ({ page }) => {
    let releaseFirstRead!: () => void
    const heldFirstRead = new Promise<void>(resolve => { releaseFirstRead = resolve })
    let outlineAttempts = 0
    await page.route('**/api/window**', async route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('view') !== 'outline' || url.searchParams.has('collection')) {
        return route.fallback()
      }
      outlineAttempts += 1
      if (outlineAttempts === 1) {
        await heldFirstRead
        return route.fulfill({ status: 503, json: { error: 'test initial window failure' } })
      }
      return route.fulfill({ json: SNAPSHOT })
    })

    const firstRead = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/window' && url.searchParams.get('view') === 'outline' &&
        !url.searchParams.has('collection')
    })
    await page.goto('/window')
    await firstRead
    await expect(page.locator('#window-status')).toContainText(/loading/i)
    releaseFirstRead()

    const status = page.locator('#window-status')
    await expect(status).toContainText(
      'The current public city view could not be read.',
    )
    await expect(status).toHaveAttribute('data-tone', 'error')
    await expect(page.locator('#city-counts')).toHaveText(
      'The current public city view could not be read.',
    )
    await expect(page.locator('#city-facts #view-scope')).toHaveText(
      'The current public city view could not be read.',
    )
    await expect(page.locator('#city-facts')).not.toHaveAttribute('open', '')
    await expect(page.locator('#city-facts-status')).toBeVisible()
    await expect(page.locator('#city-facts-status')).toHaveText(
      'The current public city view could not be read.',
    )
    const retry = page.getByRole('button', { name: /retry.*(?:public )?city view/i })
    await expect(retry).toBeVisible()
    await expect(retry).toHaveClass('global-read-retry')
    expect(await retry.evaluate(button => {
      const style = getComputedStyle(button)
      return {
        backgroundColor: style.backgroundColor,
        borderTopStyle: style.borderTopStyle,
        textDecorationLine: style.textDecorationLine,
      }
    })).toEqual({
      backgroundColor: 'rgba(0, 0, 0, 0)',
      borderTopStyle: 'none',
      textDecorationLine: 'underline',
    })

    const successfulRetry = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/window' && url.searchParams.get('view') === 'outline' &&
        !url.searchParams.has('collection') && response.status() === 200
    })
    await retry.click()
    await successfulRetry
    await expect(page.locator('#window-status')).toContainText('Watching')
    await expect(page.locator('#city-facts-status')).toBeHidden()
  })
}
