import { expect, test, type Page } from '@playwright/test'

import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'
import { WINDOW_CSS } from '../src/window-style.ts'

const EMPTY_PAGES = Object.freeze(Object.fromEntries(
  ['places', 'residents', 'notes', 'things', 'agreements', 'events'].map(key => [
    key,
    { has_more: false, next_before_id: null, next_before_subplace_id: null },
  ]),
))

function snapshot(places: readonly Record<string, unknown>[], notes: readonly Record<string, unknown>[] = []) {
  return {
    view: 'outline',
    change_marker: '90',
    places,
    residents: [],
    notes,
    things: [],
    agreements: [],
    events: [],
    totals: {
      places: places.length,
      residents: 0,
      conversations: notes.length,
      things: 0,
      agreements: 0,
      events: 0,
    },
    pages: EMPTY_PAGES,
    refreshed_at: '2026-09-01T12:05:00.000Z',
  }
}

async function mountWindow(page: Page, path: string): Promise<void> {
  await page.goto('/__e2e/health')
  const html = WINDOW_HTML.replace(/\s*<script src="\/window\.js" defer><\/script>/u, '')
  await page.setContent(html)
  await page.evaluate(nextPath => history.replaceState({}, '', nextPath), path)
  await page.addStyleTag({ content: WINDOW_CSS })
  await page.addScriptTag({ content: WINDOW_JS })
  await expect(page.locator('#window-status')).toContainText('Watching')
}

test('the window prints a renamed place by its current display name', async ({ page }) => {
  const places = [{
    id: 1,
    parent_id: null,
    name: 'the world',
    owner: null,
    places: 1,
    things: 0,
    notes: 0,
    children: [{
      id: 12,
      parent_id: 1,
      name: 'The quiet porch',
      founding_name: 'test town',
      owner: 'porchkeeper',
      places: 0,
      things: 0,
      notes: 0,
      children: [],
    }],
  }]
  await page.route('**/api/window**', route => {
    const url = new URL(route.request().url())
    return route.fulfill({
      json: url.searchParams.get('view') === 'directory'
        ? {
            view: 'directory',
            places: [
              { id: 1, parent_id: null, name: 'the world' },
              { id: 12, parent_id: 1, name: 'The quiet porch' },
            ],
            residents: [],
          }
        : snapshot(places),
    })
  })

  await mountWindow(page, '/window/place/12')

  await expect(page.locator('#place-panel')).toContainText('The quiet porch')
  await expect(page.locator('#place-panel')).not.toContainText('test town')
})

test('the old numeric address shows a retired-place tombstone and its note', async ({ page }) => {
  const world = [{
    id: 1,
    parent_id: null,
    name: 'the world',
    owner: null,
    places: 0,
    things: 0,
    notes: 0,
    children: [],
  }]
  await page.route('**/api/window**', route => route.fulfill({
    json: snapshot(world, [{
      id: 301,
      place_id: 77,
      author: 'archivekeeper',
      body: 'This note remains at the old address.',
      created_at: '2026-08-31T11:00:00.000Z',
    }]),
  }))
  await page.route('**/api/map**', route => route.fulfill({ json: {
    view: 'outline',
    change_marker: '90',
    place: {
      id: 77,
      parent_id: 1,
      name: 'The quiet porch',
      founding_name: 'test town',
      retired_at: '2026-09-01T12:00:00.000Z',
      status: 'retired',
      owner: 'archivekeeper',
      places: 0,
      things: 0,
      notes: 1,
      name_history: [{
        name: 'test town',
        started_at: '2026-08-01T12:00:00.000Z',
        ended_at: '2026-08-15T12:00:00.000Z',
      }, {
        name: 'The quiet porch',
        started_at: '2026-08-15T12:00:00.000Z',
        ended_at: null,
      }],
      children: [],
    },
  } }))

  await mountWindow(page, '/window/place/77')

  const place = page.locator('#place-panel')
  await expect(place).toContainText('The quiet porch')
  await expect(place).toContainText('retired')
  await expect(place).toContainText('Founding name: test town')
  await expect(place).toContainText('stable address is place #77')
  await expect(place).toContainText('This note remains at the old address.')
})
