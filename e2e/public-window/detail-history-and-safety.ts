import { expect, test } from '@playwright/test'
import { installClipboardRecorder } from '../helpers/public-window-clipboard.ts'

const SYNTHETIC_RESIDENT_KEY = `1f3d9_sk_${'12'.repeat(24)}`

const CREDENTIAL_RECOVERY_INSTRUCTION =
  'That looks like a credential. Never put it in a public URL. If it is a resident key, replace it now; if it is a recovery code, create a fresh recovery set.'

export function registerPublicWindowDetailHistoryAndSafety() {
  test('Archive refuses a credential without searching or changing its address', async ({ page }) => {
    const searchRequests: string[] = []
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.pathname === '/api/search') searchRequests.push(url.href)
    })
    await page.goto('/window/archive')
    await expect(page.locator('#window-status')).toContainText('Watching')
    const addressBeforeSearch = page.url()

    await page.locator('#archive-query').fill(`where ${SYNTHETIC_RESIDENT_KEY} appeared`)
    await page.locator('#archive-search').click()

    await expect(page.locator('#archive-results .error-row')).toHaveText(
      CREDENTIAL_RECOVERY_INSTRUCTION,
    )
    expect(page.url()).toBe(addressBeforeSearch)
    expect(searchRequests).toEqual([])
  })

  test('closing an in-window detail prevents Back from reopening that detail', async ({ page }) => {
    await page.goto('/window/map')
    await expect(page.locator('#window-status')).toContainText('Watching')
    await page.getByRole('tab', { name: 'Place', exact: true }).click()
    await expect(page).toHaveURL(/\/window\/place\/11$/u)

    await page.locator('#place-things .thing-detail-link', { hasText: 'field_lantern' }).click()
    const detail = page.locator('#record-detail')
    await expect(page).toHaveURL(/\/window\/thing\/401$/u)
    await expect(detail.locator('#record-detail-title')).toHaveText('field_lantern')

    await page.evaluate(() => {
      const heldBack = history.back.bind(history)
      const heldShowModal = HTMLDialogElement.prototype.showModal
      const trackedWindow = window as Window & {
        __detailShowModalCalls?: number
        __releaseHeldBack?: () => void
        __restoreDetailShowModal?: () => void
      }
      trackedWindow.__detailShowModalCalls = 0
      HTMLDialogElement.prototype.showModal = function showModal() {
        trackedWindow.__detailShowModalCalls = (trackedWindow.__detailShowModalCalls || 0) + 1
        return heldShowModal.call(this)
      }
      history.back = () => {}
      trackedWindow.__releaseHeldBack = () => {
        history.back = heldBack
        heldBack()
      }
      trackedWindow.__restoreDetailShowModal = () => {
        HTMLDialogElement.prototype.showModal = heldShowModal
      }
    })
    await detail.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(detail).toBeHidden()
    await expect(page).toHaveURL(/\/window\/thing\/401$/u)
    expect(await page.evaluate(() => history.state?.windowDetailEntry)).toBe(true)
    expect(await page.evaluate(() => (
      window as Window & { __detailShowModalCalls?: number }
    ).__detailShowModalCalls)).toBe(0)
    await page.evaluate(() => (
      window as Window & { __releaseHeldBack?: () => void }
    ).__releaseHeldBack?.())
    await expect(page).toHaveURL(/\/window\/place\/11$/u)
    await expect(detail).toBeHidden()

    await page.goForward()
    await expect(page).toHaveURL(/\/window\/thing\/401$/u)
    await expect(detail.locator('#record-detail-title')).toHaveText('field_lantern')
    await expect(detail).toBeVisible()
    expect(await page.evaluate(() => history.state?.windowDetailEntry)).toBe(true)
    expect(await page.evaluate(() => (
      window as Window & { __detailShowModalCalls?: number }
    ).__detailShowModalCalls)).toBe(1)

    await detail.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page).toHaveURL(/\/window\/place\/11$/u)
    await expect(detail).toBeHidden()
    expect(await page.evaluate(() => (
      window as Window & { __detailShowModalCalls?: number }
    ).__detailShowModalCalls)).toBe(1)
    await page.evaluate(() => (
      window as Window & { __restoreDetailShowModal?: () => void }
    ).__restoreDetailShowModal?.())
  })

  test('closing a directly loaded detail falls back to the map deterministically', async ({ page }) => {
    await page.goto('/window/thing/401')
    const detail = page.locator('#record-detail')
    await expect(detail.locator('#record-detail-title')).toHaveText('field_lantern')

    await detail.getByRole('button', { name: 'Close', exact: true }).click()

    await expect(page).toHaveURL(/\/window\/map$/u)
    await expect(detail).toBeHidden()
    await expect(page.getByRole('tab', { name: 'Map', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  test('share copy feedback resets whenever the canonical target changes', async ({ page }) => {
    await installClipboardRecorder(page)
    await page.goto('/window/place/11')
    await expect(page.locator('#window-status')).toContainText('Watching')
    const origin = new URL(page.url()).origin
    const placeShare = page.locator('#place-panel [data-share-scope="view"]')

    await placeShare.click()
    await expect(placeShare).toHaveText('View link copied')
    await expect(page.locator('#share-status')).toHaveText(
      `Link copied: ${origin}/window/place/11`,
    )

    await page.locator('#place-things .thing-detail-link', { hasText: 'field_lantern' }).click()
    const detail = page.locator('#record-detail')
    const detailShare = detail.locator('[data-share-scope="detail"]')
    const detailShareStatus = detail.locator('#record-detail-share-status')
    await expect(detail.locator('#record-detail-title')).toHaveText('field_lantern')
    await expect(placeShare).toHaveText('Share this view')
    await expect(page.locator('#share-status')).toBeEmpty()
    await expect(detailShare).toHaveText('Share this detail')
    await expect(detailShareStatus).toBeEmpty()

    await detailShare.click()
    await expect(detailShare).toHaveText('Detail link copied')
    await expect(detailShareStatus).toHaveText(
      `Link copied: ${origin}/window/thing/401`,
    )

    await detail.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page).toHaveURL(/\/window\/place\/11$/u)
    await page.getByRole('link', { name: 'Open note #301', exact: true }).click()
    await expect(detail.locator('#record-detail-title')).toHaveText('Public note #301')
    await expect(detailShare).toHaveText('Share this detail')
    await expect(detailShareStatus).toBeEmpty()
  })

  test('an invalid public filter clears old share success before another share attempt', async ({ page }) => {
    await installClipboardRecorder(page)
    await page.goto('/window/map')
    await expect(page.locator('#window-status')).toContainText('Watching')
    const mapShare = page.locator('#map-panel [data-share-scope="view"]')

    await mapShare.click()
    await expect(mapShare).toHaveText('View link copied')
    await expect(page.locator('#share-status')).toContainText('Link copied:')

    await page.locator('#directory-search').fill(SYNTHETIC_RESIDENT_KEY)

    await expect(mapShare).toHaveText('Share this view')
    await expect(page.locator('#share-status')).toBeEmpty()
    await expect(page).toHaveURL(/\/window\/map$/u)
  })

  test('a delayed clipboard completion cannot repaint feedback for a newer detail', async ({ page }) => {
    await page.addInitScript(() => {
      let finishClipboardWrite: (() => void) | null = null
      Object.defineProperty(window, '__finishClipboardWrite', {
        configurable: true,
        value: () => finishClipboardWrite?.(),
      })
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText() {
            return new Promise<void>(resolve => { finishClipboardWrite = resolve })
          },
        },
      })
    })
    await page.goto('/window/place/11')
    await expect(page.locator('#window-status')).toContainText('Watching')
    await page.locator('#place-things .thing-detail-link', { hasText: 'field_lantern' }).click()
    const detail = page.locator('#record-detail')
    const detailShare = detail.locator('[data-share-scope="detail"]')
    const detailShareStatus = detail.locator('#record-detail-share-status')
    await expect(detail.locator('#record-detail-title')).toHaveText('field_lantern')

    await detailShare.click()
    await detail.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('link', { name: 'Open note #301', exact: true }).click()
    await expect(detail.locator('#record-detail-title')).toHaveText('Public note #301')

    await page.evaluate(() => {
      (window as Window & { __finishClipboardWrite?: () => void }).__finishClipboardWrite?.()
    })
    await page.evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))

    await expect(detailShare).toHaveText('Share this detail')
    await expect(detailShareStatus).toBeEmpty()
  })

  test('detail clipboard denial reports its fallback URL inside the dialog', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText() {
            return Promise.reject(new DOMException('clipboard denied', 'NotAllowedError'))
          },
        },
      })
    })
    await page.goto('/window/thing/401')
    const detail = page.locator('#record-detail')
    await expect(detail.locator('#record-detail-title')).toHaveText('field_lantern')
    const expectedUrl = `${new URL(page.url()).origin}/window/thing/401`

    await detail.locator('[data-share-scope="detail"]').click()

    const detailShareStatus = detail.locator('#record-detail-share-status')
    await expect(detailShareStatus).toHaveText(
      `The link could not copy. Copy this URL: ${expectedUrl}`,
    )
    await expect(detailShareStatus).toHaveAttribute('data-tone', 'error')
    await expect(page.locator('#share-status')).toBeEmpty()
  })
}
