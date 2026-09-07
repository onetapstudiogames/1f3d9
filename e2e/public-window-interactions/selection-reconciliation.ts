import { expect, test } from '@playwright/test'
import { SNAPSHOT, DIRECTORY_REFRESHED, FOCUSED_PLACE, FOCUSED_PLACE_REFRESHED, FOCUSED_RESIDENT } from '../helpers/public-window-snapshot-fixtures.ts'
import { FIRST_BRANCH_PAGE, SECOND_BRANCH_PAGE, OLDER_NOTE, OLDER_THING, OLDER_AGREEMENT } from '../helpers/public-window-pagination-fixtures.ts'

export function registerPublicWindowSelectionReconciliation() {
  test('a focused resident completes presence without a false bounded warning', async ({ page }) => {
    await page.locator('#resident-filter').selectOption('far-walker')
    await page.getByRole('tab', { name: 'Place' }).click()
    const occupants = page.locator('#place-occupants')
    await expect(occupants).toContainText('far-walker')
    await expect(occupants).not.toContainText('Other occupants may be omitted')
  })

  test('the town Rooms view withholds a quiet descendant place instead of naming its resident', async ({ page }) => {
    // Second review pass on row 75: root_plaza (place #11, not quiet) recurses
    // through every descendant when it lists occupants, including hidden_nook
    // (place #79, quiet), where nook-keeper stands. The Occupants panel must
    // withhold nook-keeper behind the honest sentence while still naming
    // leafwalker, whose place (inner_hall, #12) is not quiet.
    await page.getByRole('tab', { name: 'Place' }).click()
    await expect(page).toHaveURL(/\/window\/place\/11$/u)

    const occupants = page.locator('#place-occupants')
    await expect(occupants).toContainText('leafwalker')
    await expect(occupants.locator('.quiet-room-notice')).toContainText(
      'The owner prefers to keep this room private.',
    )
    await expect(occupants).not.toContainText('nook-keeper')
    await expect(occupants.locator('.person-card').filter({ hasText: 'nook-keeper' })).toHaveCount(0)
  })

  test('missing directory selection stays selected under a confirmed-absence label', async ({ page }) => {
    const fallbackOption = page.locator('#place-filter option[value="999"]')
    await expect(fallbackOption).toHaveText(/Place #999.*no public place was found/i)
    await expect(fallbackOption).toHaveAttribute('value', '999')
    await expect(page.locator('#place-filter')).toHaveValue('999')
  })

  test('focused selection retry retains a useful keyboard focus target', async ({ page }) => {
    const retry = page.getByRole('button', { name: 'Retry loading this place' })
    await expect(retry).toBeVisible()
    await retry.focus()
    await retry.click()

    await expect(page.locator('#place-focus-title')).toHaveText('quiet_annex')
    await expect(page.locator('#place-focus-title')).toBeFocused()
  })

  test('conversation selection retry keeps focus in the active panel', async ({ page }) => {
    let attempts = 0
    await page.route('**/api/residents**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('handle') !== 'far-walker') return route.fallback()
      attempts += 1
      return attempts === 1
        ? route.fulfill({ status: 503, json: { error: 'test focused resident failure' } })
        : route.fallback()
    })

    await page.goto('/window#view=conversations&resident=far-walker')
    const stream = page.locator('#conversation-stream')
    const retry = page.getByRole('button', { name: 'Retry loading this resident' })
    await expect(retry).toBeVisible()
    const recovered = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/residents' && url.searchParams.get('handle') === 'far-walker' &&
        response.status() === 200
    }, { timeout: 5_000 })
    await retry.focus()
    await retry.click()
    await recovered
    await expect(stream).toBeFocused()
  })

  test('directory failure is accessible and retryable without hiding the loaded fallback', async ({ page }) => {
    const alert = page.locator('#directory-status[role="alert"]')
    await expect(alert).toContainText(/complete city directory could not be loaded/i)
    expect(await page.locator('#place-filter option').allTextContents()).toEqual([
      'All places',
      'root_plaza · Place #11',
      'inner_hall · Place #12',
    ])

    await alert.getByRole('button', { name: 'Retry loading the complete directory' }).click()
    await expect(page.locator('#directory-status')).toContainText(
      'Complete city directory: 3 places and 2 residents',
    )
    await expect(page.locator('#place-filter')).toContainText('quiet_annex')
  })

  test('directory failure labels bounded fallback search as incomplete', async ({ page }) => {
    await expect(page.locator('#directory-status[role="alert"]')).toContainText(
      /complete city directory could not be loaded/i,
    )
    await page.locator('#directory-search').fill('fallback')

    const status = page.locator('#directory-search-status')
    await expect(status).toContainText('Showing the first 20 of 21')
    await expect(status).toContainText('currently loaded fallback')
    await expect(status).toContainText('more citywide matches may exist')
    await expect(status).not.toContainText(/exact|complete selectors/i)
  })

  test('refresh reloads the complete directory and a focused unloaded place after authored changes', async ({ page }) => {
    await page.locator('#place-filter').selectOption('77')
    await page.getByRole('tab', { name: 'Place' }).click()
    await expect(page.locator('#place-focus-title')).toHaveText('quiet_annex')
    await expect(page.locator('#place-focus-summary')).toContainText(
      'root_plaza / inner_hall / quiet_annex · kept by far-walker · showing this place and everything inside it',
    )

    await page.unroute('**/api/changes**')
    await page.route('**/api/changes**', route => {
      const since = new URL(route.request().url()).searchParams.get('since')
      return route.fulfill({
        json: since === '20'
          ? {
            change_marker: '21', changes: [{ change_id: '21' }], returned_items: 1,
            unchanged: false, has_more: false, next_since: '21',
          }
          : {
            change_marker: '21', changes: [], returned_items: 0,
            unchanged: true, has_more: false, next_since: '21',
          },
      })
    })
    await page.unroute('**/api/window**')
    await page.route('**/api/window**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('view') === 'directory') {
        return route.fulfill({ json: DIRECTORY_REFRESHED })
      }
      const collection = url.searchParams.get('collection')
      if (collection === 'notes') {
        return route.fulfill({
          json: { notes: [OLDER_NOTE], has_more: false, next_before_id: null, change_marker: '21' },
        })
      }
      if (collection === 'things') {
        return route.fulfill({
          json: { things: [OLDER_THING], has_more: false, next_before_id: null, change_marker: '21' },
        })
      }
      if (collection === 'agreements') {
        return route.fulfill({
          json: {
            agreements: [OLDER_AGREEMENT], has_more: false, next_before_id: null,
            change_marker: '21',
          },
        })
      }
      if (url.searchParams.get('after_change_marker') === '21') {
        return route.fulfill({ json: { ...SNAPSHOT, change_marker: '21' } })
      }
      return route.fulfill({ json: SNAPSHOT })
    })
    await page.unroute('**/api/map**')
    let refreshedFocusedAttempts = 0
    await page.route('**/api/map**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('parent_id') === '77') {
        refreshedFocusedAttempts += 1
        if (refreshedFocusedAttempts === 1) {
          return route.fulfill({ status: 503, json: { error: 'test refreshed focus failure' } })
        }
        return route.fulfill({ json: FOCUSED_PLACE_REFRESHED })
      }
      if (url.searchParams.get('parent_id') !== '12') {
        return route.fulfill({
          status: 404,
          json: {
            error: 'unknown test branch',
            change_marker: url.searchParams.get('after_change_marker') ?? '20',
          },
        })
      }
      return route.fulfill({
        json: url.searchParams.get('before_subplace_id') === '14'
          ? SECOND_BRANCH_PAGE
          : FIRST_BRANCH_PAGE,
      })
    })

    const coveredSnapshot = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/window' && url.searchParams.get('after_change_marker') === '21'
    })
    const refreshedDirectory = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/window' && url.searchParams.get('view') === 'directory'
    })
    const refreshedFocusedPlace = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/map' && url.searchParams.get('parent_id') === '77' &&
        url.searchParams.get('after_change_marker') === '21'
    })
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await Promise.all([coveredSnapshot, refreshedDirectory, refreshedFocusedPlace])

    const focusRetry = page.getByRole('button', { name: 'Retry loading this place' })
    await expect(focusRetry).toBeVisible()
    await expect(page.locator('#place-panel')).not.toContainText('Loading public place…')
    const focusedSuccess = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/map' && url.searchParams.get('parent_id') === '77' &&
        url.searchParams.get('after_change_marker') === '21' && response.status() === 200
    })
    await focusRetry.click()
    await focusedSuccess

    await expect(page.locator('#directory-status')).toContainText(
      'Complete city directory: 4 places and 2 residents',
    )
    expect(await page.locator('#place-filter option').allTextContents()).toEqual([
      'All places',
      'root_plaza · Place #11',
      'inner_hall · Place #12',
      '\u00a0\u00a0renamed_annex · Place #77',
      '\u00a0\u00a0fresh_gallery · Place #78',
    ])
    await expect(page.locator('#place-focus-title')).toHaveText('renamed_annex')
    await expect(page.locator('#place-focus-summary')).toContainText(
      'root_plaza / inner_hall / renamed_annex · kept by far-walker · showing this place and everything inside it',
    )
    await expect(page.locator('#place-purpose')).toContainText(
      'A renamed room proved by a refreshed focused map read.',
    )
  })

  test('a focused place reply overtaken by a newer snapshot fails with retry instead of fake loading', async ({ page }) => {
    let releaseOlderPlace!: () => void
    const heldOlderPlace = new Promise<void>(resolve => { releaseOlderPlace = resolve })
    let focusedAttempts = 0
    await page.route('**/api/map**', async route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('parent_id') !== '77') return route.fallback()
      focusedAttempts += 1
      if (focusedAttempts === 1) {
        await heldOlderPlace
        return route.fulfill({ json: FOCUSED_PLACE })
      }
      return route.fulfill({ json: FOCUSED_PLACE_REFRESHED })
    })
    await page.route('**/api/changes**', route => route.fulfill({
      json: {
        change_marker: '21', changes: [{ change_id: '21' }], returned_items: 1,
        unchanged: false, has_more: false, next_since: '21',
      },
    }))
    await page.route('**/api/window**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('after_change_marker') !== '21') return route.fallback()
      return route.fulfill({ json: { ...SNAPSHOT, change_marker: '21' } })
    })

    const olderFocus = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/map' && url.searchParams.get('parent_id') === '77' &&
        url.searchParams.get('after_change_marker') === '20'
    })
    await page.locator('#place-filter').selectOption('77')
    await olderFocus

    const newerSnapshot = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/window' &&
        url.searchParams.get('after_change_marker') === '21' && response.status() === 200
    })
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await newerSnapshot

    const olderFocusResponse = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/map' && url.searchParams.get('parent_id') === '77' &&
        url.searchParams.get('after_change_marker') === '20'
    })
    releaseOlderPlace()
    await olderFocusResponse

    const retry = page.getByRole('button', { name: 'Retry loading this place' })
    await expect(retry).toBeVisible()
    await expect(page.locator('#place-panel')).not.toContainText('Loading public place…')

    const recovered = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/map' && url.searchParams.get('parent_id') === '77' &&
        url.searchParams.get('after_change_marker') === '21' && response.status() === 200
    })
    await retry.click()
    await recovered
    await expect(page.locator('#place-map').getByRole('button', {
      name: 'renamed_annex', exact: true,
    })).toBeVisible()
    await expect(retry).toHaveCount(0)
  })

  test('a focused resident reply overtaken by a newer snapshot fails with retry instead of fake loading', async ({ page }) => {
    let releaseOlderResident!: () => void
    const heldOlderResident = new Promise<void>(resolve => { releaseOlderResident = resolve })
    let focusedAttempts = 0
    await page.route('**/api/residents**', async route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('handle') !== 'far-walker') return route.fallback()
      focusedAttempts += 1
      if (focusedAttempts === 1) await heldOlderResident
      return route.fulfill({
        json: {
          ...FOCUSED_RESIDENT,
          change_marker: url.searchParams.get('after_change_marker') ?? '20',
        },
      })
    })
    await page.route('**/api/changes**', route => route.fulfill({
      json: {
        change_marker: '21', changes: [{ change_id: '21' }], returned_items: 1,
        unchanged: false, has_more: false, next_since: '21',
      },
    }))
    await page.route('**/api/window**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('after_change_marker') !== '21') return route.fallback()
      return route.fulfill({ json: { ...SNAPSHOT, change_marker: '21' } })
    })

    const olderFocus = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/residents' && url.searchParams.get('handle') === 'far-walker'
    })
    await page.locator('#resident-filter').selectOption('far-walker')
    await olderFocus

    const newerSnapshot = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/window' &&
        url.searchParams.get('after_change_marker') === '21' && response.status() === 200
    })
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await newerSnapshot

    const olderFocusResponse = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/residents' && url.searchParams.get('handle') === 'far-walker'
    })
    releaseOlderResident()
    await olderFocusResponse

    const retry = page.locator('#place-map').getByRole('button', {
      name: 'Retry loading this resident',
    })
    await expect(retry).toBeVisible()
    await expect(page.locator('#place-map')).not.toContainText('Loading public resident…')

    const recovered = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/residents' && url.searchParams.get('handle') === 'far-walker' &&
        response.status() === 200
    })
    await retry.click()
    await recovered
    await expect(page.locator('#resident-roster').getByRole('button', {
      name: 'far-walker', exact: true,
    })).toBeVisible()
    await expect(page.locator('#place-map').getByRole('button', {
      name: 'Retry loading this resident',
    })).toHaveCount(0)
  })
}
