import { expect, test } from '@playwright/test'
import { LONG_PLACE_NAME } from '../helpers/public-window-snapshot-fixtures.ts'
import { API_REQUESTS } from '../helpers/public-window-pagination-fixtures.ts'

export function registerPublicWindowOutlineDirectory() {
  test('outline snapshot loads, pages, deduplicates, and preserves one map branch', async ({ page }) => {
    const initialRequest = API_REQUESTS.get(page)?.map(value => new URL(value)).find(url => {
      return url.pathname === '/api/window' && url.searchParams.get('view') === 'outline' &&
        !url.searchParams.has('collection')
    })
    expect(initialRequest?.searchParams.get('view')).toBe('outline')
    expect([...initialRequest?.searchParams.keys() ?? []]).toEqual(['view'])

    const scope = page.locator('#city-facts #view-scope')
    await expect(scope).toContainText(/loaded 2 of 5 places/i)
    await expect(scope).toContainText(/loaded 1 of 3 residents/i)
    await expect(scope).not.toContainText(/complete map|complete resident|everyone is shown/i)

    const rootCard = page.locator('.place-card').filter({
      has: page.getByRole('button', { name: 'root_plaza', exact: true }),
    })
    await expect(rootCard.getByRole('button', { name: 'Collapse places inside root_plaza' }))
      .toHaveAttribute('aria-controls', 'place-children-11')

    const branchCard = page.locator('.place-card').filter({
      has: page.getByRole('button', { name: 'inner_hall', exact: true }),
    })
    const branchToggle = branchCard.getByRole('button', { name: 'Show places inside inner_hall' })
    await expect(branchToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(branchToggle).toHaveAttribute('aria-busy', 'false')
    await expect(branchToggle).toHaveAttribute('aria-controls', 'place-children-12')

    const firstRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/map' && url.searchParams.get('parent_id') === '12' &&
        !url.searchParams.has('before_subplace_id')
    })
    await branchToggle.click()
    const firstUrl = new URL((await firstRequest).url())
    expect(Object.fromEntries(firstUrl.searchParams)).toEqual({
      view: 'outline',
      parent_id: '12',
      subplace_limit: '25',
      after_change_marker: '20',
    })
    await expect(page.getByRole('button', { name: 'newest_gallery', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'shared_step', exact: true })).toBeVisible()

    const loadMore = page.getByRole('button', { name: 'Load more places inside inner_hall' })
    await expect(loadMore).toHaveAttribute('aria-busy', 'false')
    await expect(loadMore).toHaveAttribute('aria-controls', 'place-children-12')
    const secondRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/map' && url.searchParams.get('before_subplace_id') === '14'
    })
    await loadMore.focus()
    await loadMore.click()
    const secondUrl = new URL((await secondRequest).url())
    expect(Object.fromEntries(secondUrl.searchParams)).toEqual({
      view: 'outline',
      parent_id: '12',
      before_subplace_id: '14',
      subplace_limit: '25',
      after_change_marker: '20',
    })

    const loadedBranch = page.locator('#place-children-12')
    await expect(loadedBranch.getByRole('button', { name: 'shared_step', exact: true })).toHaveCount(1)
    await expect(loadedBranch.getByRole('button', { name: 'older_cell', exact: true })).toBeVisible()
    expect(await loadedBranch.locator('.place-name').allTextContents()).toEqual([
      'newest_gallery',
      'shared_step',
      'older_cell',
    ])
    await expect(branchCard.getByRole('button', {
      name: 'Collapse places inside inner_hall',
    })).toBeFocused()

    const expandedToggle = branchCard.getByRole('button', {
      name: 'Collapse places inside inner_hall',
    })
    await expandedToggle.focus()
    const refreshRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/window' && url.searchParams.get('view') === 'outline' &&
        !url.searchParams.has('collection')
    })
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await refreshRequest

    const restoredToggle = page.getByRole('button', { name: 'Collapse places inside inner_hall' })
    await expect(restoredToggle).toBeFocused()
    await expect(page.getByRole('button', { name: 'older_cell', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'shared_step', exact: true })).toHaveCount(1)

    await page.getByRole('button', { name: 'older_cell', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Place' })).toHaveAttribute('aria-selected', 'true')
    await expect(page).toHaveURL(/\/window\/place\/13$/u)
    await page.goBack()
    await expect(page.getByRole('tab', { name: 'Map' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('button', { name: 'older_cell', exact: true })).toBeVisible()
  })

  test('complete directory selection loads one focused place and its inside contents', async ({ page }) => {
    await expect(page.locator('#directory-status')).toContainText(
      'Complete city directory: 3 places and 2 residents',
    )
    expect(await page.locator('#place-filter option').allTextContents()).toEqual([
      'All places',
      'root_plaza · Place #11',
      'inner_hall · Place #12',
      '\u00a0\u00a0quiet_annex · Place #77',
    ])
    await expect(page.locator('#place-filter optgroup')).toHaveCount(0)
    const placeFilterBox = await page.locator('#place-filter').boundingBox()
    expect(placeFilterBox?.width ?? 0).toBeGreaterThan(220)
    await expect(page.locator('#city-facts #view-scope')).toContainText(/currently loaded 2 of 5 places/i)

    const focusedRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/map' && url.searchParams.get('parent_id') === '77'
    })
    await page.locator('#place-filter').selectOption('77')
    const focusedUrl = new URL((await focusedRequest).url())
    expect(Object.fromEntries(focusedUrl.searchParams)).toEqual({
      view: 'outline',
      parent_id: '77',
      after_change_marker: '20',
    })

    const insideThings = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/window' && url.searchParams.get('collection') === 'things' &&
        url.searchParams.get('within_place_id') === '77'
    })
    const insideNotes = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/window' && url.searchParams.get('collection') === 'notes' &&
        url.searchParams.get('within_place_id') === '77'
    })
    await page.getByRole('tab', { name: 'Place' }).click()
    await Promise.all([insideThings, insideNotes])
    await expect(page.locator('#place-focus-title')).toHaveText('quiet_annex')
    await expect(page.locator('#place-focus-summary')).toContainText(
      'root_plaza / inner_hall / quiet_annex · kept by far-walker · showing this place and everything inside it',
    )
    await expect(page.locator('#place-things')).toContainText('old_bench')
    await expect(page.locator('#place-things')).toContainText('at root_plaza / inner_hall / quiet_annex')
    await expect(page.locator('#place-conversation')).toContainText('An older conversation remains readable.')
    await expect(page.locator('#place-conversation')).toContainText(
      'root_plaza / inner_hall / quiet_annex',
    )

    const requests = (API_REQUESTS.get(page) ?? []).map(value => new URL(value))
    expect(requests.filter(url =>
      url.pathname === '/api/map' && url.searchParams.get('parent_id') === '77')).toHaveLength(1)
    expect(requests.filter(url =>
      url.pathname === '/api/window' && url.searchParams.get('within_place_id') === '77'))
      .toHaveLength(2)

    await page.getByRole('tab', { name: 'Map' }).focus()
    await page.getByRole('tab', { name: 'Map' }).press('ArrowRight')
    await expect(page.getByRole('tab', { name: 'Live' })).toBeFocused()
    await expect(page.getByRole('tab', { name: 'Live' })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('tab', { name: 'Live' }).press('ArrowRight')
    await expect(page.getByRole('tab', { name: 'Things' })).toBeFocused()
    await expect(page.getByRole('tab', { name: 'Things' })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('tab', { name: 'Things' }).press('ArrowRight')
    await expect(page.getByRole('tab', { name: 'Place' })).toBeFocused()
    await expect(page.getByRole('tab', { name: 'Place' })).toHaveAttribute('aria-selected', 'true')
  })

  test('long selected place heading wraps inside its existing panel', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('#place-filter').selectOption('77')
    await page.getByRole('tab', { name: 'Place' }).click()

    const title = page.locator('#place-focus-title')
    await expect(title).toHaveText(LONG_PLACE_NAME)
    const dimensions = await title.evaluate(node => ({
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      title: node.getBoundingClientRect().toJSON(),
      panel: node.closest('.panel-heading')?.getBoundingClientRect().toJSON(),
    }))
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth)
    expect(dimensions.panel).toBeTruthy()
    expect(dimensions.title.left).toBeGreaterThanOrEqual(dimensions.panel!.left)
    expect(dimensions.title.right).toBeLessThanOrEqual(dimensions.panel!.right)
  })

  test('focused place occupants name the missing narrow presence read without widening it', async ({ page }) => {
    await page.locator('#place-filter').selectOption('77')
    await page.getByRole('tab', { name: 'Place' }).click()
    await expect(page.locator('#place-focus-title')).toHaveText('quiet_annex')
    await expect(page.locator('#place-occupants')).toContainText(/no narrow place-specific presence read/i)
    await expect(page.locator('#place-occupants')).not.toContainText(/no residents? (?:were )?found/i)

    const presenceReads = (API_REQUESTS.get(page) ?? [])
      .map(value => new URL(value))
      .filter(url => url.pathname === '/api/residents')
    expect(presenceReads).toHaveLength(0)
  })

  test('directory search owns a dropdown and finds both places and residents', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 851 })
    const search = page.locator('#directory-search')
    await expect(page.getByRole('combobox', {
      name: 'Search places, residents, and things', exact: true,
    })).toBeVisible()
    await expect(search).toHaveAttribute('aria-controls', 'directory-search-results')
    expect(await search.evaluate(node => node.closest('.view-filters'))).toBeNull()
    const selector = page.locator('#place-filter')
    const searchBox = await search.boundingBox()
    const selectorBox = await selector.boundingBox()
    expect(searchBox?.x ?? -1).toBeGreaterThanOrEqual(0)
    expect((searchBox?.x ?? 391) + (searchBox?.width ?? 0)).toBeLessThanOrEqual(390)
    expect(selectorBox?.width ?? 0).toBeGreaterThan(300)
    expect((selectorBox?.x ?? 391) + (selectorBox?.width ?? 0)).toBeLessThanOrEqual(390)
    await search.fill('quiet')

    await expect(page.locator('#directory-search-status')).toHaveText('1 result: 1 place and 0 residents.')
    const results = page.locator('#directory-search-results')
    await expect(results).toBeVisible()
    await expect(search).toHaveAttribute('aria-expanded', 'true')
    const quietResult = results.getByRole('option')
    await expect(quietResult).toHaveText(/quiet_annex · Place #77/)
    await expect(quietResult).toHaveAttribute('aria-selected', 'true')
    await expect(search).toHaveAttribute('aria-activedescendant', 'directory-search-option-0')
    const [cursorColor, chosenColor] = await Promise.all([
      quietResult.evaluate(node => getComputedStyle(node).backgroundColor),
      page.locator('.view-tab[aria-selected="true"]').evaluate(node => getComputedStyle(node).backgroundColor),
    ])
    expect(cursorColor).not.toBe(chosenColor)
    const dropdownLayout = await results.evaluate(node => {
      const searchNode = document.querySelector<HTMLElement>('#directory-search')
      const searchRect = searchNode?.getBoundingClientRect()
      const resultsRect = node.getBoundingClientRect()
      return {
        sharesSearchShell: node.parentElement === searchNode?.parentElement,
        search: searchRect?.toJSON(),
        results: resultsRect.toJSON(),
      }
    })
    expect(dropdownLayout.sharesSearchShell).toBe(true)
    expect(dropdownLayout.search).toBeTruthy()
    expect(dropdownLayout.results.left).toBeGreaterThanOrEqual(dropdownLayout.search!.left)
    expect(dropdownLayout.results.right).toBeLessThanOrEqual(dropdownLayout.search!.right)
    expect(dropdownLayout.results.top).toBeGreaterThanOrEqual(dropdownLayout.search!.bottom)
    await quietResult.scrollIntoViewIfNeeded()
    expect(await results.evaluate(node => {
      const content = document.querySelector<HTMLElement>('.view-filters')
      if (!content) return false
      const resultsRect = node.getBoundingClientRect()
      const contentRect = content.getBoundingClientRect()
      const overlapTop = Math.max(resultsRect.top, contentRect.top)
      const overlapBottom = Math.min(resultsRect.bottom, contentRect.bottom, window.innerHeight)
      if (overlapTop >= overlapBottom) return false
      const stack = document.elementsFromPoint(
        resultsRect.left + resultsRect.width / 2,
        overlapTop + (overlapBottom - overlapTop) / 2,
      )
      const resultsIndex = stack.findIndex(candidate => candidate === node || node.contains(candidate))
      const contentIndex = stack.findIndex(candidate => candidate === content || content.contains(candidate))
      return resultsIndex >= 0 && contentIndex > resultsIndex
    })).toBe(true)
    expect(await page.locator('#place-filter option').allTextContents()).toEqual([
      'All places',
      'root_plaza · Place #11',
      'inner_hall · Place #12',
      '\u00a0\u00a0quiet_annex · Place #77',
    ])

    const focusedRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/map' && url.searchParams.get('parent_id') === '77'
    })
    await search.press('Enter')
    await focusedRequest
    await expect(search).toHaveValue('')
    await expect(results).toBeHidden()

    const residentRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/residents' && url.searchParams.get('handle') === 'far-walker'
    })
    await search.fill('walker')
    await expect(page.locator('#directory-search-status')).toHaveText('2 results: 0 places and 2 residents.')
    const residentResults = results.getByRole('option')
    await expect(residentResults).toHaveCount(2)
    await expect(residentResults.first()).toHaveAttribute('aria-selected', 'true')
    await search.press('ArrowDown')
    await expect(search).toHaveAttribute('aria-activedescendant', 'directory-search-option-1')
    await expect(residentResults.nth(1)).toHaveAttribute('aria-selected', 'true')

    await residentResults.first().hover()
    await expect(search).toHaveAttribute('aria-activedescendant', 'directory-search-option-0')
    await expect(residentResults.first()).toHaveAttribute('aria-selected', 'true')
    await expect(residentResults.nth(1)).toHaveAttribute('aria-selected', 'false')
    const hoveredColors = await residentResults.evaluateAll(options => (
      options.map(option => getComputedStyle(option).backgroundColor)
    ))
    expect(new Set(hoveredColors).size).toBe(2)

    await residentResults.nth(1).hover()
    await expect(search).toHaveAttribute('aria-activedescendant', 'directory-search-option-1')
    await expect(residentResults.nth(1)).toHaveAttribute('aria-selected', 'true')
    await search.press('Enter')
    await residentRequest
    await expect(page).toHaveURL(/resident=far-walker/)
    await expect(page.locator('#directory-search-status')).toHaveText('3 places and 2 residents available.')
  })

  test('complete resident selection uses one focused presence read and a directory path', async ({ page }) => {
    const focusedRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/residents' && url.searchParams.get('handle') === 'far-walker'
    }, { timeout: 5_000 })
    const currentPlaceRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/map' && url.searchParams.get('parent_id') === '77'
    }, { timeout: 5_000 })
    await page.locator('#resident-filter').selectOption('far-walker')
    const focusedUrl = new URL((await focusedRequest).url())
    expect(Object.fromEntries(focusedUrl.searchParams)).toEqual({
      view: 'presence',
      handle: 'far-walker',
      after_change_marker: '20',
    })
    const currentPlaceUrl = new URL((await currentPlaceRequest).url())
    expect(Object.fromEntries(currentPlaceUrl.searchParams)).toEqual({
      view: 'outline',
      parent_id: '77',
      after_change_marker: '20',
    })

    const roster = page.locator('#resident-roster')
    await expect(roster.getByRole('button', { name: 'far-walker', exact: true })).toBeVisible()
    await expect(roster).toContainText('root_plaza / inner_hall / quiet_annex')
    const quietAnnex = page.locator('.place-card').filter({
      has: page.getByRole('button', { name: 'quiet_annex', exact: true }),
    })
    const shownResidents = quietAnnex.locator('.occupant-chip')
    await expect(shownResidents).toHaveCount(1)
    await expect(shownResidents).toContainText('far-walker')
    const quietAnnexFacts = quietAnnex.locator('.place-facts')
    await expect.soft(quietAnnexFacts).toContainText(/\b0 places inside\b/u)
    await expect.soft(quietAnnexFacts).toContainText(/\b1 resident shown inside\b/u)
    await expect.soft(page.locator('#city-facts #view-scope')).toContainText('currently loaded 3 of 5 places')
    await expect.soft(page.locator('#city-facts #view-scope')).toContainText('currently loaded 2 of 3 residents')
    const requests = (API_REQUESTS.get(page) ?? []).map(value => new URL(value))
    expect(requests.filter(url =>
      url.pathname === '/api/residents' && url.searchParams.get('handle') === 'far-walker'))
      .toHaveLength(1)
    expect(requests.filter(url =>
      url.pathname === '/api/map' && url.searchParams.get('parent_id') === '77'))
      .toHaveLength(1)
  })
}
