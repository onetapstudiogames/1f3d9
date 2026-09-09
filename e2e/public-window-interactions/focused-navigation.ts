import { expect, test } from '@playwright/test'
import { SNAPSHOT, FOCUSED_PLACE } from '../helpers/public-window-snapshot-fixtures.ts'
import { API_REQUESTS, FAR_WALKER_NOTE, OLDER_FAR_WALKER_NOTE, FAR_WALKER_ROOM_CONTEXT } from '../helpers/public-window-pagination-fixtures.ts'

export function registerPublicWindowFocusedNavigation() {
  test('out-of-snapshot resident history defaults to what they said and pages to exhaustion', async ({ page }) => {
    await page.route('**/api/window**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('collection') !== 'notes' ||
          url.searchParams.get('resident') !== 'far-walker') {
        return route.fallback()
      }
      if (url.searchParams.get('context') === 'place') {
        return route.fulfill({
          json: {
            notes: [FAR_WALKER_NOTE, FAR_WALKER_ROOM_CONTEXT],
            has_more: false,
            next_before_id: null,
            change_marker: '20',
          },
        })
      }
      if (url.searchParams.get('before_id') === String(FAR_WALKER_NOTE.id)) {
        return route.fulfill({
          json: {
            notes: [OLDER_FAR_WALKER_NOTE],
            has_more: false,
            next_before_id: null,
            change_marker: '20',
          },
        })
      }
      return route.fulfill({
        json: {
          notes: [FAR_WALKER_NOTE],
          has_more: true,
          next_before_id: FAR_WALKER_NOTE.id,
          change_marker: '20',
        },
      })
    })

    await page.locator('#resident-filter').selectOption('far-walker')
    const firstPageRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/window' && url.searchParams.get('collection') === 'notes' &&
        url.searchParams.get('resident') === 'far-walker' && !url.searchParams.has('before_id') &&
        !url.searchParams.has('context')
    }, { timeout: 5_000 })
    await page.getByRole('tab', { name: 'Conversations' }).click()
    const firstPageUrl = new URL((await firstPageRequest).url())
    expect(firstPageUrl.searchParams.get('limit')).toBe('50')
    expect(firstPageUrl.searchParams.has('within_place_id')).toBe(false)
    expect(firstPageUrl.searchParams.has('context')).toBe(false)

    const question = page.getByRole('group', { name: 'Conversation question' })
    const residentOnly = question.getByRole('button', { name: 'What far-walker said', exact: true })
    const roomContext = question.getByRole('button', {
      name: 'What was said around far-walker', exact: true,
    })
    await expect(residentOnly).toHaveAttribute('aria-pressed', 'true')
    await expect(roomContext).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('#conversation-stream')).toContainText(FAR_WALKER_NOTE.body)
    await expect(page.locator('#conversation-stream')).not.toContainText(FAR_WALKER_ROOM_CONTEXT.body)
    await expect(page.locator('#conversation-stream .note-author')).toHaveText(['far-walker'])

    const olderRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/window' && url.searchParams.get('collection') === 'notes' &&
        url.searchParams.get('resident') === 'far-walker' &&
        url.searchParams.get('before_id') === String(FAR_WALKER_NOTE.id) &&
        !url.searchParams.has('context')
    }, { timeout: 5_000 })
    await page.getByRole('button', { name: 'Load older conversations' }).click()
    await olderRequest
    await expect(page.locator('#conversation-stream')).toContainText(OLDER_FAR_WALKER_NOTE.body)
    await expect(page.locator('#conversation-stream .note-author')).toHaveText([
      'far-walker', 'far-walker',
    ])
    await expect(page.getByRole('button', { name: 'Load older conversations' })).toHaveCount(0)

    const contextRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/window' && url.searchParams.get('collection') === 'notes' &&
        url.searchParams.get('resident') === 'far-walker' &&
        url.searchParams.get('context') === 'place' && !url.searchParams.has('before_id')
    }, { timeout: 5_000 })
    await roomContext.click()
    const contextUrl = new URL((await contextRequest).url())
    expect(contextUrl.searchParams.get('limit')).toBe('25')
    await expect(roomContext).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#conversation-stream')).toContainText(FAR_WALKER_NOTE.body)
    await expect(page.locator('#conversation-stream')).toContainText(FAR_WALKER_ROOM_CONTEXT.body)

    await page.goBack()
    await expect(residentOnly).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#conversation-stream')).toContainText(OLDER_FAR_WALKER_NOTE.body)
    await expect(page.locator('#conversation-stream')).not.toContainText(FAR_WALKER_ROOM_CONTEXT.body)
    await page.goForward()
    await expect(roomContext).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#conversation-stream')).toContainText(FAR_WALKER_ROOM_CONTEXT.body)

    await residentOnly.click()
    await expect(residentOnly).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#conversation-stream')).toContainText(OLDER_FAR_WALKER_NOTE.body)
    await expect(page.locator('#conversation-stream')).not.toContainText(FAR_WALKER_ROOM_CONTEXT.body)
  })

  test('stale resident and chained place replies never paint under the next selection', async ({ page }) => {
    let releaseResident!: () => void
    const heldResident = new Promise<void>(resolve => { releaseResident = resolve })
    let farWalkerAttempts = 0
    await page.route('**/api/residents**', async route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('handle') !== 'far-walker') return route.fallback()
      farWalkerAttempts += 1
      if (farWalkerAttempts === 1) await heldResident
      return route.fallback()
    })

    let releasePlace!: () => void
    const heldPlace = new Promise<void>(resolve => { releasePlace = resolve })
    await page.route('**/api/map**', async route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('parent_id') !== '77') return route.fallback()
      await heldPlace
      return route.fallback()
    })

    const staleResidentRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/residents' && url.searchParams.get('handle') === 'far-walker'
    }, { timeout: 5_000 })
    await page.locator('#resident-filter').selectOption('far-walker')
    await staleResidentRequest
    await page.locator('#resident-filter').selectOption('leafwalker')
    releaseResident()
    await expect(page).toHaveURL(/resident=leafwalker/)
    await page.waitForTimeout(100)
    expect((API_REQUESTS.get(page) ?? []).filter(value => {
      const url = new URL(value)
      return url.pathname === '/api/map' && url.searchParams.get('parent_id') === '77'
    })).toHaveLength(0)

    const stalePlaceRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/map' && url.searchParams.get('parent_id') === '77'
    }, { timeout: 5_000 })
    await page.locator('#resident-filter').selectOption('far-walker')
    await stalePlaceRequest
    await page.locator('#resident-filter').selectOption('leafwalker')
    releasePlace()

    await expect(page).toHaveURL(/resident=leafwalker/)
    await page.getByRole('tab', { name: 'Place' }).click()
    await expect(page.locator('#place-focus-title')).toHaveText('inner_hall')
    await expect(page.locator('#place-focus-summary')).not.toContainText('quiet_annex')
  })

  test('a directory-known note author is followable before their presence has been fetched', async ({ page }) => {
    await page.route('**/api/window**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.has('collection') || url.searchParams.get('view') === 'directory') {
        return route.fallback()
      }
      return route.fulfill({
        json: {
          ...SNAPSHOT,
          notes: [FAR_WALKER_NOTE],
          totals: { ...SNAPSHOT.totals, conversations: 1 },
          shown: { ...SNAPSHOT.shown, conversations: 1 },
          pages: {
            ...SNAPSHOT.pages,
            notes: { has_more: false, next_before_id: null },
          },
        },
      })
    })
    await page.goto('/window#view=conversations')

    const author = page.locator('#conversation-stream').getByRole('button', {
      name: 'far-walker', exact: true,
    })
    await expect(author).toBeVisible()
    const presenceRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/residents' && url.searchParams.get('handle') === 'far-walker'
    }, { timeout: 5_000 })
    await author.click()
    await presenceRequest
    await expect(page).toHaveURL(/resident=far-walker/)
  })

  test('cold deep link replaces its numbered fallback when the directory arrives later', async ({ page }) => {
    await expect.poll(() => {
      const focusedRead = (API_REQUESTS.get(page) ?? []).map(value => new URL(value)).find(url => {
        return url.pathname === '/api/map' && url.searchParams.get('parent_id') === '77'
      })
      return focusedRead?.searchParams.get('after_change_marker')
    }).toBe('20')
    await expect(page.locator('#directory-status')).toContainText('Complete city directory')
    await expect(page.locator('#place-focus-title')).toHaveText('quiet_annex')
    await expect(page.locator('#place-focus-summary')).toContainText(
      'root_plaza / inner_hall / quiet_annex · kept by far-walker · showing this place and everything inside it',
    )
  })

  test('focused name source keeps fresh card and path wording together', async ({ page }) => {
    await page.locator('#place-filter').selectOption('77')
    await page.getByRole('tab', { name: 'Place' }).click()
    await expect(page.locator('#place-focus-title')).toHaveText('focus_fresh_annex')
    await expect(page.locator('#place-focus-summary')).toContainText(
      'root_plaza / inner_hall / focus_fresh_annex · kept by far-walker',
    )
    await expect(page.locator('#place-focus-summary')).not.toContainText('quiet_annex')

    const selectedOption = page.locator('#place-filter option[value="77"]')
    await expect(selectedOption).toContainText('focus_fresh_annex')
    await expect(selectedOption).not.toContainText('quiet_annex')

    const search = page.locator('#directory-search')
    await search.fill('focus_fresh_annex')
    await expect(page.locator('#directory-search-results').getByRole('option', {
      name: /focus_fresh_annex/,
    })).toBeVisible()
    await search.fill('quiet_annex')
    await expect(page.locator('#directory-search-results')).toHaveText(
      'No places, residents, or things match this search.',
    )
  })

  test('scope forgets an older focused place when a new focused place becomes active', async ({ page }) => {
    await page.locator('#place-filter').selectOption('77')
    await expect(page.locator('#city-facts #view-scope')).toContainText('currently loaded 3 of 5 places')

    await page.route('**/api/map**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('parent_id') !== '78') return route.fallback()
      return route.fulfill({
        json: {
          ...FOCUSED_PLACE,
          place: {
            ...FOCUSED_PLACE.place,
            id: 78,
            name: 'active_gallery',
          },
        },
      })
    })
    const activeFocus = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/map' && url.searchParams.get('parent_id') === '78' &&
        response.status() === 200
    })
    await page.evaluate(() => { window.location.hash = '#view=map&place=78' })
    await activeFocus

    await expect(page.getByRole('button', { name: 'active_gallery', exact: true })).toBeVisible()
    await expect(page.locator('#place-filter option[value="78"]')).toContainText('active_gallery')
    await expect(page.locator('#city-facts #view-scope')).toContainText('currently loaded 3 of 5 places')
    await expect(page.locator('#city-facts #view-scope')).not.toContainText('currently loaded 4 of 5 places')
  })

  test('explicit place scope excludes the followed resident previous focused place', async ({ page }) => {
    const residentFocus = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/residents' && url.searchParams.get('handle') === 'far-walker' &&
        response.status() === 200
    })
    await page.locator('#resident-filter').selectOption('far-walker')
    await residentFocus
    await expect(page.locator('#city-facts #view-scope')).toContainText('currently loaded 3 of 5 places')

    await page.route('**/api/map**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('parent_id') !== '78') return route.fallback()
      return route.fulfill({
        json: {
          ...FOCUSED_PLACE,
          place: {
            ...FOCUSED_PLACE.place,
            id: 78,
            name: 'active_gallery',
          },
        },
      })
    })
    const explicitPlaceFocus = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/map' && url.searchParams.get('parent_id') === '78' &&
        response.status() === 200
    })
    await page.evaluate(() => {
      window.location.hash = '#view=map&place=78&resident=far-walker'
    })
    await explicitPlaceFocus

    await expect(page.locator('#resident-filter')).toHaveValue('far-walker')
    await expect(page.getByRole('button', { name: 'active_gallery', exact: true })).toBeVisible()
    await expect(page.locator('#city-facts #view-scope')).toContainText('currently loaded 3 of 5 places')
    await expect(page.locator('#city-facts #view-scope')).not.toContainText('currently loaded 4 of 5 places')
  })

  test('scope counts the active filtered history instead of hidden earlier filters', async ({ page }) => {
    await page.route('**/api/window**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('collection') !== 'notes' || url.searchParams.has('context')) {
        return route.fallback()
      }
      const resident = url.searchParams.get('resident')
      if (resident !== 'leafwalker' && resident !== 'far-walker') return route.fallback()
      const note = resident === 'leafwalker'
        ? {
            id: 901,
            place_id: 12,
            author: 'leafwalker',
            body: 'Only the first selected resident said this.',
            created_at: '2026-08-16T10:01:00.000Z',
          }
        : {
            id: 902,
            place_id: 77,
            author: 'far-walker',
            body: 'Only the active selected resident said this.',
            created_at: '2026-08-16T10:02:00.000Z',
          }
      return route.fulfill({
        json: { notes: [note], has_more: false, next_before_id: null, change_marker: '20' },
      })
    })

    const firstHistory = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/window' && url.searchParams.get('collection') === 'notes' &&
        url.searchParams.get('resident') === 'leafwalker' && response.status() === 200
    })
    await page.locator('#resident-filter').selectOption('leafwalker')
    await page.getByRole('tab', { name: 'Conversations' }).click()
    await firstHistory
    await expect(page.locator('#conversation-stream')).toContainText(
      'Only the first selected resident said this.',
    )

    const activeHistory = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/window' && url.searchParams.get('collection') === 'notes' &&
        url.searchParams.get('resident') === 'far-walker' && response.status() === 200
    })
    await page.locator('#resident-filter').selectOption('far-walker')
    await activeHistory

    const stream = page.locator('#conversation-stream')
    await expect(stream).toContainText('Only the active selected resident said this.')
    await expect(stream).not.toContainText('Only the first selected resident said this.')
    await expect(page.locator('#city-facts #view-scope')).toContainText('Showing 1 fetched note')
    await expect(page.locator('#city-facts #view-scope')).not.toContainText(/\b\d+ of 3 conversations\b/)
  })
}
