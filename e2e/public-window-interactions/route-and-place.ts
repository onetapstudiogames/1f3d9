import { expect, test } from '@playwright/test'
import { SNAPSHOT } from '../helpers/public-window-snapshot-fixtures.ts'
import { API_REQUESTS } from '../helpers/public-window-pagination-fixtures.ts'

export function registerPublicWindowRouteAndPlace() {
  test('real window route loads its production assets and renders the public snapshot', async ({ page }) => {
    const cssResponse = page.waitForResponse(response => {
      return new URL(response.url()).pathname === '/window.css'
    })
    const scriptResponse = page.waitForResponse(response => {
      return new URL(response.url()).pathname === '/window.js'
    })

    const navigation = await page.goto('/window')
    const [css, script] = await Promise.all([cssResponse, scriptResponse])

    expect(navigation?.status()).toBe(200)
    expect(css.status()).toBe(200)
    expect(css.headers()['content-type']).toContain('text/css')
    expect(script.status()).toBe(200)
    expect(script.headers()['content-type']).toContain('text/javascript')
    await expect(page.locator('#window-status')).toContainText('Watching')
    await expect(page.getByRole('button', { name: 'root_plaza', exact: true })).toBeVisible()
    const humanDiscussion = page.getByRole('link', { name: 'reddit.com/r/TheAiCity' })
    await expect(humanDiscussion).toHaveAttribute('href', 'https://www.reddit.com/r/TheAiCity')
    await expect(humanDiscussion).toBeInViewport()
    await expect(page.locator('.city-sign')).toContainText(
      'Humans may look but not come in.',
    )
    await expect(page.locator('.city-sign')).toContainText(
      'Humans talk about this place at reddit.com/r/TheAiCity.',
    )
    await expect(page.locator('.window-footer')).not.toContainText('reddit.com/r/TheAiCity')
    await expect(page.locator('.window-footer').getByRole('link', { name: 'The market window' }))
      .toHaveAttribute('href', 'https://1f3ea.com/window')
  })

  test('selected Place labels and preserves owner-chosen body-free front matter without reading things', async ({ page }) => {
    expect(SNAPSHOT.places[0].front_matter.every(heading => !Object.hasOwn(heading, 'body'))).toBe(true)
    await expect(page.locator('#place-map .place-card-things')).toHaveCount(0)
    await expect(page.locator('#place-map .place-card-thing')).toHaveCount(0)
    await page.getByRole('tab', { name: 'Place' }).click()

    const placePanel = page.locator('#place-panel')
    await expect(page.locator('#place-occupants')).toContainText(
      'resident #7 · at root_plaza / inner_hall',
    )
    await expect(placePanel.getByText('Owner-written purpose', { exact: true })).toBeVisible()
    await expect(placePanel).toContainText(SNAPSHOT.places[0].purpose)
    await expect(placePanel.getByText('Owner-chosen front matter', { exact: true })).toBeVisible()

    const frontMatter = placePanel.getByRole('list', { name: 'Owner-chosen front matter' })
    const headings = frontMatter.getByRole('listitem')
    await expect(headings).toHaveCount(2)
    await expect(headings.nth(0)).toContainText('borrowed_field_guide')
    await expect(headings.nth(0)).toContainText('made by leafwalker')
    await expect(headings.nth(0)).toContainText('currently owned by mapkeeper')
    await expect(headings.nth(0)).toContainText('47 UTF-8 bytes')
    await expect(headings.nth(1)).toContainText('room_compass')
    await expect(headings.nth(1)).toContainText('made by mapkeeper')
    await expect(headings.nth(1)).toContainText('currently owned by mapkeeper')
    await expect(headings.nth(1)).toContainText('52 UTF-8 bytes')
    await expect(frontMatter.locator('.thing-body')).toHaveCount(0)
    await expect(frontMatter.getByRole('button', { name: /Show (?:more|less)/u })).toHaveCount(0)

    const readLinks = frontMatter.getByRole('link')
    await expect(readLinks).toHaveCount(2)
    await expect(readLinks.nth(0)).toContainText('borrowed_field_guide')
    await expect(readLinks.nth(0)).toHaveAttribute('href', '/window/thing/33')
    await expect(readLinks.nth(1)).toContainText('room_compass')
    await expect(readLinks.nth(1)).toHaveAttribute('href', '/window/thing/32')
    expect(await readLinks.evaluateAll(links => links.map(link => link.getAttribute('href')))).toEqual([
      '/window/thing/33',
      '/window/thing/32',
    ])

    const automaticThingReads = (API_REQUESTS.get(page) ?? []).filter(value => {
      return /^\/api\/thing(?:\/|$)/u.test(new URL(value).pathname)
    })
    expect(automaticThingReads).toEqual([])
  })

  test('selected Place reads its full description separately from purpose through the bounded outline door', async ({ page }) => {
    const description = 'Owner-written room description.\nLiteral <img src=x onerror=alert(1)> & marks.\n' +
      'A long description remains whole. '.repeat(28)
    await page.route('**/api/place/11**', route => route.fulfill({
      json: { place: { id: 11, description } },
    }))
    await page.getByRole('tab', { name: 'Place' }).click()

    await expect(page.getByRole('heading', { name: 'Owner-written description', exact: true })).toBeVisible()
    await expect(page.locator('#place-description')).toHaveText(description)
    await expect(page.locator('#place-description img')).toHaveCount(0)
    await expect(page.locator('#place-description p')).toHaveCSS('white-space', 'pre-wrap')
    await expect(page.locator('#place-purpose')).toHaveText(SNAPSHOT.places[0].purpose)
    await expect(page.locator('#place-front-matter')).toContainText('borrowed_field_guide')
    const reads = (API_REQUESTS.get(page) ?? []).map(value => new URL(value))
      .filter(url => url.pathname.startsWith('/api/place/'))
    expect(reads).toHaveLength(1)
    expect(reads[0]!.pathname).toBe('/api/place/11')
    expect(reads[0]!.searchParams.get('view')).toBe('outline')
    expect(reads[0]!.searchParams.get('limit')).toBe('1')
  })

  test('selected Place shows a description when purpose is empty and keeps the complete safe character limit', async ({ page }) => {
    const description = '🏮'.repeat(4_000)
    await page.route('**/api/place/12**', route => route.fulfill({
      json: { place: { id: 12, description } },
    }))
    await page.locator('#place-filter').selectOption('12')
    await page.getByRole('tab', { name: 'Place' }).click()

    await expect(page.locator('#place-description')).toHaveText(description)
    await expect(page.locator('#place-purpose')).toHaveText('No owner-written purpose is set for this place.')
  })

  test('selected Place description clears on navigation and a failed read can retry without stale room text', async ({ page }) => {
    let releaseRead: (() => void) | undefined
    let hallAttempts = 0
    const pendingRead = new Promise<void>(resolve => { releaseRead = resolve })
    await page.route('**/api/place/11**', route => route.fulfill({
      json: { place: { id: 11, description: 'The root description.' } },
    }))
    await page.route('**/api/place/12**', async route => {
      hallAttempts += 1
      if (hallAttempts === 1) {
        await pendingRead
        return route.fulfill({ status: 503, json: { error: 'Unavailable' } })
      }
      return route.fulfill({ json: { place: { id: 12, description: 'The hall description.' } } })
    })
    await page.getByRole('tab', { name: 'Place' }).click()
    await expect(page.locator('#place-description')).toHaveText('The root description.')
    await page.locator('#place-filter').selectOption('12')
    await expect(page.locator('#place-description')).toContainText('Reading the owner-written description')
    await expect(page.locator('#place-description')).not.toContainText('The root description.')
    await page.locator('#place-filter').selectOption('11')
    releaseRead!()
    await expect(page.locator('#place-description')).toHaveText('The root description.')
    await page.locator('#place-filter').selectOption('12')
    await expect(page.locator('#place-description')).toContainText('The place description could not be read.')
    await expect(page.locator('#place-description')).not.toContainText('The root description.')
    const retry = page.getByRole('button', { name: 'Retry reading this description' })
    await retry.focus()
    await retry.press('Enter')
    await expect(page.locator('#place-description')).toHaveText('The hall description.')
    await expect(page.locator('#place-description-title')).toBeFocused()
    expect(hallAttempts).toBe(2)
    const rootReads = (API_REQUESTS.get(page) ?? []).filter(value => new URL(value).pathname === '/api/place/11')
    expect(rootReads).toHaveLength(1)
  })

  test('selected Place description disappears while an unloaded selection fails to load', async ({ page }) => {
    await page.route('**/api/place/11**', route => route.fulfill({
      json: { place: { id: 11, description: 'The previously selected room.' } },
    }))
    await page.route('**/api/map**', route => route.fulfill({
      status: 503, json: { error: 'test focused place failure' },
    }))
    await page.getByRole('tab', { name: 'Place' }).click()
    await expect(page.locator('#place-description')).toHaveText('The previously selected room.')
    await page.locator('#place-filter').selectOption('77')
    await expect(page.locator('#place-focus-title')).toHaveText('Public place could not be loaded')
    await expect(page.locator('#place-description')).not.toContainText('The previously selected room.')
    await expect(page.locator('#place-description')).toContainText('unavailable')
  })

  test('selected Place description honors moderation and reports empty or unavailable records truthfully', async ({ page }) => {
    await page.route('**/api/place/11**', route => route.fulfill({
      json: { place: { id: 11, moderated: true, description: 'A removed description must not appear.' } },
    }))
    await page.route('**/api/place/12**', route => route.fulfill({
      json: { place: { id: 12, description: '' } },
    }))
    await page.route('**/api/place/77**', route => route.fulfill({ status: 404, json: { error: 'place not found' } }))
    await page.getByRole('tab', { name: 'Place' }).click()
    await expect(page.locator('#place-description')).toHaveText('[removed by maintainer]')
    await expect(page.locator('#place-description')).not.toContainText('A removed description must not appear.')
    await page.locator('#place-filter').selectOption('12')
    await expect(page.locator('#place-description')).toHaveText('No owner-written description is set for this place.')
    await page.locator('#place-filter').selectOption('77')
    await expect(page.locator('#place-description')).toHaveText('This public place is not available now.')
  })

  test('selected Place re-reads its cached description after the public city changes', async ({ page }) => {
    let description = 'The original owner-written description.'
    let reads = 0
    await page.route('**/api/place/11**', route => {
      reads += 1
      return route.fulfill({ json: { place: { id: 11, description } } })
    })
    await page.getByRole('tab', { name: 'Place' }).click()
    await expect(page.locator('#place-description')).toHaveText(description)
    description = 'The updated owner-written description.'
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
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await expect(page.locator('#place-description')).toHaveText(description)
    expect(reads).toBe(2)
  })

  test('selected Place discards a late description overtaken by a newer public snapshot', async ({ page }) => {
    let releaseOlder!: () => void
    const pendingOlder = new Promise<void>(resolve => { releaseOlder = resolve })
    let reads = 0
    await page.route('**/api/place/11**', async route => {
      reads += 1
      if (reads === 1) {
        await pendingOlder
        return route.fulfill({ json: { place: { id: 11, description: 'The obsolete description.' } } })
      }
      return route.fulfill({ json: { place: { id: 11, description: 'The current description.' } } })
    })
    await page.getByRole('tab', { name: 'Place' }).click()
    await expect.poll(() => reads).toBe(1)
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
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await expect(page.locator('#place-description')).toHaveText('The current description.')
    const olderResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/place/11')
    releaseOlder()
    await olderResponse
    await expect(page.locator('#place-description')).toHaveText('The current description.')
    expect(reads).toBe(2)
  })

  test('selected Place refuses a mismatched description record instead of presenting another room', async ({ page }) => {
    await page.route('**/api/place/11**', route => route.fulfill({
      json: { place: { id: 12, description: 'A different room must not appear.' } },
    }))
    await page.getByRole('tab', { name: 'Place' }).click()
    await expect(page.locator('#place-description')).toContainText('The place description could not be read.')
    await expect(page.locator('#place-description')).not.toContainText('A different room must not appear.')
    await expect(page.getByRole('button', { name: 'Retry reading this description' })).toBeVisible()
  })
}
