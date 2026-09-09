import { expect, test } from '@playwright/test'
import { installClipboardRecorder } from '../helpers/public-window-clipboard.ts'

const SYNTHETIC_RESIDENT_KEY = `1f3d9_sk_${'12'.repeat(24)}`

const CREDENTIAL_RECOVERY_INSTRUCTION =
  'That looks like a credential. Never put it in a public URL. If it is a resident key, replace it now; if it is a recovery code, create a fresh recovery set.'

export function registerPublicWindowDetailHistoryAndSafety() {
  test('record detail stays open for content clicks and closes on its backdrop', async ({ page }) => {
    await page.goto('/window/thing/401')
    const detail = page.locator('#record-detail')
    await expect(detail.locator('#record-detail-title')).toHaveText('field_lantern')

    await detail.locator('article').click()
    await expect(detail).toBeVisible()

    await page.mouse.click(1, 1)
    await expect(detail).toBeHidden()
  })

  test('thing drawing readback is exact and history loads only when requested', async ({ page }) => {
    const drawing = { palette: ['#174d3c'], indices: Array.from({ length: 64 }, () => 0) }
    const snapshot = {
      state: 'complete', presentation_state: 'complete', description: 'A green lantern.',
      drawing, rows: Array.from({ length: 8 }, () => '0 0 0 0 0 0 0 0'), source: 'thing',
    }
    let currentReads = 0
    let historyReads = 0
    await page.route('**/api/drawing/thing/401', route => {
      currentReads += 1
      return route.fulfill({ json: { type: 'thing', id: 401, ...snapshot } })
    })
    await page.route('**/api/drawing/thing/401/history**', route => {
      historyReads += 1
      return route.fulfill({ json: {
        type: 'thing', id: 401,
        revisions: [{
          id: 18, slot_variant_name: null,
          previous: { ...snapshot, state: 'undrawn', presentation_state: 'undrawn',
            description: null, drawing: null, rows: null, source: 'none' },
          current: snapshot,
          author: { id: 49, handle: 'browser-resident', relation: 'self' },
          created_at: '2026-08-28T15:04:05.000Z',
        }],
        page: { limit: 20, has_more: false, next_before: null },
      } })
    })

    await page.goto('/window/place/11')
    await expect(page.locator('#window-status')).toContainText('Watching')
    await page.locator('#place-things .thing-detail-link', { hasText: 'field_lantern' }).click()
    const detail = page.locator('#record-detail')
    await expect(detail.locator('.drawing-exact-readback')).toBeVisible()
    await expect(detail.locator('[data-drawing-palette="true"]')).toHaveText('#174d3c')
    await expect(detail.locator('[data-drawing-indices="true"]')).toHaveText(
      JSON.stringify(drawing.indices),
    )
    const rows = detail.locator('[data-drawing-row="true"]')
    await expect(rows).toHaveCount(8)
    expect(await rows.allTextContents()).toEqual(snapshot.rows)
    const canvas = detail.locator('.drawing-detail-canvas canvas').first()
    await expect(canvas).toBeVisible()
    expect(await canvas.evaluate(node => {
      const drawingCanvas = node as HTMLCanvasElement
      const context = drawingCanvas.getContext('2d')
      return {
        width: drawingCanvas.width,
        height: drawingCanvas.height,
        pixel: context ? [...context.getImageData(0, 0, 1, 1).data] : [],
      }
    })).toEqual({ width: 8, height: 8, pixel: [23, 77, 60, 255] })
    expect(currentReads).toBe(1)
    expect(historyReads).toBe(0)

    await detail.getByRole('button', { name: 'Show drawing history' }).click()
    const revision = detail.locator('.drawing-history-revision')
    await expect(revision).toHaveCount(1)
    await expect(revision.getByRole('heading', { name: 'Revision #18' })).toBeVisible()
    await expect(revision.locator('.drawing-history-meta')).toContainText(
      'by browser-resident · self',
    )
    await expect(revision.getByRole('heading', { name: 'Before' })).toBeVisible()
    await expect(revision.getByRole('heading', { name: 'After' })).toBeVisible()
    expect(historyReads).toBe(1)
  })

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
