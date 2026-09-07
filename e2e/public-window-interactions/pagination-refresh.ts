import { expect, test } from '@playwright/test'
import { SNAPSHOT } from '../helpers/public-window-snapshot-fixtures.ts'
import { FIRST_BRANCH_PAGE, SECOND_BRANCH_PAGE, RESIDENT_PAGE } from '../helpers/public-window-pagination-fixtures.ts'

export function registerPublicWindowPaginationRefresh() {
  test('refresh forward-reconciles multi-page bursts without gaps and refreshes branch facts', async ({ page }) => {
    await page.getByRole('button', { name: 'Show places inside inner_hall' }).click()
    await expect(page.getByRole('button', { name: 'newest_gallery', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Load more places inside inner_hall' }).click()
    await expect(page.getByRole('button', { name: 'older_cell', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Load more residents' }).click()
    await expect(page.getByRole('button', { name: 'nightwatcher', exact: true })).toBeVisible()

    let refreshed = false
    const refreshedSnapshot = {
      ...SNAPSHOT,
      residents: [{
        id: 2,
        handle: 'newcomer-two',
        current_place_id: 12,
        asleep: false,
        joined_at: '2026-08-16T12:00:00.000Z',
      }, {
        id: 100,
        handle: 'newcomer-hundred',
        current_place_id: 12,
        asleep: false,
        joined_at: '2026-08-15T12:00:00.000Z',
      }],
      totals: { ...SNAPSHOT.totals, residents: 6 },
      shown: { ...SNAPSHOT.shown, residents: 2 },
      pages: {
        ...SNAPSHOT.pages,
        residents: { has_more: true, next_before_id: 100 },
      },
    }
    await page.unroute('**/api/window**')
    await page.route('**/api/window**', route => {
      const url = new URL(route.request().url())
      if (!url.searchParams.has('collection')) {
        return route.fulfill({ json: refreshed ? refreshedSnapshot : SNAPSHOT })
      }
      return route.fulfill({
        json: { notes: [], has_more: false, next_before_id: null, change_marker: '20' },
      })
    })
    await page.unroute('**/api/map**')
    await page.route('**/api/map**', route => {
      const url = new URL(route.request().url())
      const before = url.searchParams.get('before_subplace_id')
      if (!refreshed) {
        return route.fulfill({ json: before === '14' ? SECOND_BRANCH_PAGE : FIRST_BRANCH_PAGE })
      }
      const parent = {
        ...FIRST_BRANCH_PAGE.place,
        places: 6,
        things: 4,
        notes: 2,
      }
      if (!before) {
        return route.fulfill({ json: {
          ...FIRST_BRANCH_PAGE,
          place: parent,
          subplaces: [{
            ...FIRST_BRANCH_PAGE.subplaces[0], id: 18, name: 'burst_eighteen',
          }, {
            ...FIRST_BRANCH_PAGE.subplaces[0], id: 17, name: 'burst_seventeen',
          }],
          subplaces_page: { ...FIRST_BRANCH_PAGE.subplaces_page, next_before_subplace_id: 17 },
        } })
      }
      return route.fulfill({ json: {
        ...FIRST_BRANCH_PAGE,
        place: parent,
        subplaces: [{
          ...FIRST_BRANCH_PAGE.subplaces[0], id: 16, name: 'burst_sixteen',
        }, FIRST_BRANCH_PAGE.subplaces[0]],
        subplaces_page: { ...FIRST_BRANCH_PAGE.subplaces_page, next_before_subplace_id: 15 },
      } })
    })
    await page.unroute('**/api/residents**')
    await page.route('**/api/residents**', route => {
      const url = new URL(route.request().url())
      const before = url.searchParams.get('before_id')
      const changeMarker = url.searchParams.get('after_change_marker') ?? '20'
      if (!refreshed) {
        return route.fulfill({ json: { ...RESIDENT_PAGE, change_marker: changeMarker } })
      }
      expect(before).toBe('100')
      return route.fulfill({ json: {
        change_marker: changeMarker,
        residents: [{
          id: 1,
          handle: 'newcomer-one',
          current_place_id: 12,
          asleep: false,
          joined_at: '2026-08-14T12:30:00.000Z',
        }, SNAPSHOT.residents[0]],
        total: 6,
        has_more: true,
        next_before_id: 7,
      } })
    })

    refreshed = true
    const branchContinuation = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/map' && url.searchParams.get('before_subplace_id') === '17'
    })
    const residentContinuation = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/residents' && url.searchParams.get('before_id') === '100'
    })
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await Promise.all([branchContinuation, residentContinuation])

    const branch = page.locator('#place-children-12')
    await expect(branch.getByRole('button', { name: 'burst_eighteen', exact: true })).toBeVisible()
    expect(await branch.locator('.place-name').allTextContents()).toEqual([
      'burst_eighteen',
      'burst_seventeen',
      'burst_sixteen',
      'newest_gallery',
      'shared_step',
      'older_cell',
    ])
    const branchCard = page.locator('.place-card').filter({
      has: page.getByRole('button', { name: 'inner_hall', exact: true }),
    })
    await expect(branchCard.locator('.place-facts')).toContainText(
      '6 places inside · 5 residents shown inside · 4 things · 2 notes',
    )

    expect(await page.locator('#resident-filter option').allTextContents()).toEqual([
      'All residents',
      'leafwalker · Resident #7',
      'far-walker · Resident #9',
    ])
  })

  test('a reconciliation budget exposes a contiguous continuation and stays stable next refresh', async ({ page }) => {
    await page.getByRole('button', { name: 'Show places inside inner_hall' }).click()
    await expect(page.getByRole('button', { name: 'newest_gallery', exact: true })).toBeVisible()
    await page.unroute('**/api/map**')
    let mapReads = 0
    await page.route('**/api/map**', route => {
      mapReads += 1
      const before = Number(new URL(route.request().url()).searchParams.get('before_subplace_id')) || null
      const newest = before ? before - 1 : 100
      const rows = [newest, newest - 1].map(id => ({
        ...FIRST_BRANCH_PAGE.subplaces[0],
        id,
        name: 'burst_' + String(id),
      }))
      return route.fulfill({ json: {
        ...FIRST_BRANCH_PAGE,
        place: { ...FIRST_BRANCH_PAGE.place, places: 100 },
        subplaces: rows,
        subplaces_page: {
          ...FIRST_BRANCH_PAGE.subplaces_page,
          total_items: 100,
          has_more: true,
          next_before_subplace_id: newest - 1,
        },
      } })
    })

    const refreshRequest = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/window' && url.searchParams.get('view') === 'outline'
    })
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await refreshRequest
    await expect(page.getByRole('button', { name: 'burst_100', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Load more places inside inner_hall' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'newest_gallery', exact: true })).toHaveCount(0)
    expect(mapReads).toBe(8)

    const secondRefresh = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/window' && url.searchParams.get('view') === 'outline'
    })
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await secondRefresh
    await page.evaluate(() => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    }))
    expect(mapReads).toBe(8)
    await expect(page.getByRole('button', { name: 'newest_gallery', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Load more places inside inner_hall' })).toBeVisible()
  })

  test('a slower refresh cannot overwrite a manual resident page that finishes first', async ({ page }) => {
    await page.getByRole('button', { name: 'Show places inside inner_hall' }).click()

    await page.unroute('**/api/residents**')
    let releaseResidents: (() => void) | null = null
    await page.route('**/api/residents**', async route => {
      await new Promise<void>(resolve => {
        releaseResidents = () => {
          void route.fulfill({ json: RESIDENT_PAGE }).then(() => resolve())
        }
      })
    })
    await page.unroute('**/api/map**')
    let releaseBranch: (() => void) | null = null
    await page.route('**/api/map**', async route => {
      await new Promise<void>(resolve => {
        releaseBranch = () => {
          void route.fulfill({ json: FIRST_BRANCH_PAGE }).then(() => resolve())
        }
      })
    })

    const residentRequest = page.waitForRequest(request =>
      new URL(request.url()).pathname === '/api/residents')
    await page.getByRole('button', { name: 'Load more residents' }).click()
    await residentRequest

    const branchRefresh = page.waitForRequest(request =>
      new URL(request.url()).pathname === '/api/map')
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await branchRefresh

    expect(releaseResidents).not.toBeNull()
    releaseResidents?.()
    await expect(page.getByRole('button', { name: 'nightwatcher', exact: true })).toBeVisible()
    expect(releaseBranch).not.toBeNull()
    releaseBranch?.()
    await expect(page.locator('#window-status')).toContainText('Watching')
    await expect(page.getByRole('button', { name: 'nightwatcher', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'wayfarer', exact: true })).toBeVisible()
  })
}
