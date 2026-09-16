import { expect, test } from '@playwright/test'

import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'
import { WINDOW_CSS } from '../src/window-style.ts'
import { WORLD_ROOT_PURPOSE } from '../src/world-root.ts'

const LOCATION_SNAPSHOT = Object.freeze({
  view: 'outline',
  change_marker: '80',
  places: [{
    id: 1,
    parent_id: null,
    name: 'the world',
    owner: null,
    purpose: WORLD_ROOT_PURPOSE,
    places: 1,
    things: 0,
    notes: 0,
    children: [{
      id: 12,
      parent_id: 1,
      name: 'loaded_square',
      owner: 'mapkeeper',
      places: 0,
      things: 0,
      notes: 1,
      children: [],
    }],
  }],
  residents: [],
  notes: [{
    id: 82,
    place_id: 123,
    author: 'far-walker',
    body: 'A note from beyond the bounded map.',
    created_at: '2026-08-22T15:02:00.000Z',
  }, {
    id: 81,
    place_id: 12,
    author: 'mapkeeper',
    body: 'A note from the loaded square.',
    created_at: '2026-08-22T15:01:00.000Z',
  }],
  things: [],
  agreements: [],
  events: [{
    id: 92,
    at: '2026-08-22T15:04:00.000Z',
    kind: 'note',
    actor: 'far-walker',
    detail: { place_id: 123, note_id: 82 },
  }, {
    id: 91,
    at: '2026-08-22T15:03:00.000Z',
    kind: 'note',
    actor: 'mapkeeper',
    detail: { place_id: 12, note_id: 81 },
  }],
  totals: {
    places: 351,
    residents: 0,
    conversations: 2,
    things: 0,
    agreements: 0,
    events: 2,
  },
  pages: {
    places: { has_more: false, next_before_subplace_id: null },
    residents: { has_more: false, next_before_id: null },
    notes: { has_more: false, next_before_id: null },
    things: { has_more: false, next_before_id: null },
    agreements: { has_more: false, next_before_id: null },
    events: { has_more: false, next_before_id: null },
  },
  refreshed_at: '2026-08-22T15:05:00.000Z',
})

const LOCATION_DIRECTORY = Object.freeze({
  view: 'directory',
  places: [
    { id: 1, parent_id: null, name: 'the world' },
    { id: 12, parent_id: 1, name: 'loaded_square' },
    { id: 123, parent_id: 1, name: 'far_reach' },
  ],
  residents: [],
})

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto('/__e2e/health')
  await page.route('**/api/window**', route => {
    const url = new URL(route.request().url())
    return route.fulfill({
      json: url.searchParams.get('view') === 'directory'
        ? LOCATION_DIRECTORY
        : LOCATION_SNAPSHOT,
    })
  })

  const htmlWithoutAutomaticClient = WINDOW_HTML.replace(
    /\s*<script src="\/window\.js" defer><\/script>/,
    '',
  )
  await page.setContent(htmlWithoutAutomaticClient)
  await page.addStyleTag({ content: WINDOW_CSS })
  await page.addScriptTag({ content: WINDOW_JS })
  await expect(page.locator('#window-status')).toContainText('Watching')
})

test('the Place tab shows the world line as the city\'s own, not as an owner-written purpose', async ({ page }) => {
  await page.locator('#place-filter').selectOption('1')
  await page.getByRole('tab', { name: 'Place' }).click()

  const placePanel = page.locator('#place-panel')
  await expect(placePanel.getByText('City-written line', { exact: true })).toBeVisible()
  await expect(page.locator('#place-purpose-eyebrow')).toHaveText('CITY / LINE')
  await expect(placePanel.getByText('Owner-written purpose', { exact: true })).toHaveCount(0)
  await expect(page.locator('#place-purpose')).toHaveText(WORLD_ROOT_PURPOSE)

  await page.locator('#place-filter').selectOption('12')
  await expect(placePanel.getByText('Owner-written purpose', { exact: true })).toBeVisible()
  await expect(page.locator('#place-purpose-eyebrow')).toHaveText('OWNER / PURPOSE')
  await expect(placePanel.getByText('City-written line', { exact: true })).toHaveCount(0)
})

test('notes and happenings keep loaded and unloaded locations as visible accessible text', async ({ page }) => {
  await page.getByRole('tab', { name: 'Conversations' }).click()

  const loadedNote = page.locator('.note-card').filter({ hasText: 'A note from the loaded square.' })
  const unloadedNote = page.locator('.note-card').filter({ hasText: 'A note from beyond the bounded map.' })
  await expect(loadedNote.locator('.note-location')).toHaveText('the world / loaded_square')
  await expect(unloadedNote.locator('.note-location')).toHaveText(
    'the world / far_reach',
  )

  const noteAccessibility = await unloadedNote.locator('.note-meta').ariaSnapshot()
  expect(noteAccessibility).toContain('the world / far_reach')
  await expect(unloadedNote.locator('.note-location')).toBeVisible()
  expect(await unloadedNote.locator('.note-location').evaluate(node => {
    const bounds = node.getBoundingClientRect()
    return bounds.left >= 0 && bounds.right <= document.documentElement.clientWidth
  })).toBe(true)

  await page.locator('#place-filter').selectOption('12')
  await page.getByRole('tab', { name: 'Place' }).click()
  const placePanelNote = page.locator('#place-conversation .note-card')
    .filter({ hasText: 'A note from the loaded square.' })
  await expect(placePanelNote.locator('.note-location')).toHaveText(
    'the world / loaded_square',
  )

  await page.locator('#place-filter').selectOption('')
  await page.getByRole('tab', { name: 'Happenings' }).click()
  const loadedHappening = page.locator('.activity-row').filter({ hasText: 'mapkeeper left a note.' })
  const unloadedHappening = page.locator('.activity-row').filter({ hasText: 'far-walker left a note.' })
  await expect(loadedHappening.locator('.activity-context')).toHaveText(
    'Observed at the world / loaded_square',
  )
  await expect(unloadedHappening.locator('.activity-context')).toHaveText(
    'Observed at the world / far_reach',
  )

  const happeningAccessibility = await unloadedHappening.ariaSnapshot()
  expect(happeningAccessibility).toContain('Observed at the world / far_reach')
  await expect(unloadedHappening.locator('.activity-context')).toBeVisible()
  expect(await unloadedHappening.locator('.activity-context').evaluate(node => {
    const bounds = node.getBoundingClientRect()
    return bounds.left >= 0 && bounds.right <= document.documentElement.clientWidth
  })).toBe(true)
})
