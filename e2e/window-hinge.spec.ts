// Decision #132: the window shows an open hinge on its Place and Map views.
import { expect, test, type Page } from '@playwright/test'
import { WINDOW_CSS } from '../src/window-style.ts'
import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'

const ROOT_PLACE_ID = 601
const WEST_HALL_ID = 602
const EAST_HALL_ID = 603
const CLOSED_HALL_ID = 604
const MODERATED_HALL_ID = 605
const MODERATED_NAME = '[removed by maintainer]'
const HINGE_LINE =
  'Hinge: one step to east_hall (place 603), a door open while both places name each other.'

function hinge(placeId: number, name: string) {
  return Object.freeze({ place_id: placeId, name, parent_id: ROOT_PLACE_ID, rough_room: false })
}

function room(id: number, name: string, farHinge: ReturnType<typeof hinge> | null) {
  return Object.freeze({
    id,
    parent_id: ROOT_PLACE_ID,
    name,
    owner: 'gatekeeper-owner',
    purpose: '',
    front_matter: [],
    places: 0,
    things: 0,
    notes: 0,
    quiet: false,
    hinge: farHinge,
    children: [],
  })
}

const SNAPSHOT = Object.freeze({
  view: 'outline',
  change_marker: '50',
  places: [{
    id: ROOT_PLACE_ID,
    parent_id: null,
    name: 'gate_district',
    owner: 'gatekeeper-owner',
    purpose: '',
    front_matter: [],
    places: 4,
    things: 0,
    notes: 0,
    quiet: false,
    hinge: null,
    children: [
      room(WEST_HALL_ID, 'west_hall', hinge(EAST_HALL_ID, 'east_hall')),
      room(EAST_HALL_ID, 'east_hall', hinge(WEST_HALL_ID, 'west_hall')),
      room(CLOSED_HALL_ID, 'closed_hall', null),
      room(MODERATED_HALL_ID, 'moderated_hall', hinge(606, MODERATED_NAME)),
    ],
  }],
  residents: [],
  notes: [],
  things: [],
  agreements: [],
  events: [],
  live_survey: [
    { id: ROOT_PLACE_ID, parent_id: null, things: 0, notes: 0 },
    { id: WEST_HALL_ID, parent_id: ROOT_PLACE_ID, things: 0, notes: 0 },
    { id: EAST_HALL_ID, parent_id: ROOT_PLACE_ID, things: 0, notes: 0 },
    { id: CLOSED_HALL_ID, parent_id: ROOT_PLACE_ID, things: 0, notes: 0 },
    { id: MODERATED_HALL_ID, parent_id: ROOT_PLACE_ID, things: 0, notes: 0 },
  ],
  totals: { places: 5, residents: 0, conversations: 0, things: 0, agreements: 0, events: 0 },
  shown: { places: 5, residents: 0, conversations: 0, things: 0, agreements: 0, events: 0 },
  limits: { places: 10, residents: 25, conversations: 10, things: 10, agreements: 10, events: 10 },
  pages: {
    places: { has_more: false, next_before_subplace_id: null },
    residents: { has_more: false, next_before_id: null },
    notes: { has_more: false, next_before_id: null },
    things: { has_more: false, next_before_id: null },
    agreements: { has_more: false, next_before_id: null },
    events: { has_more: false, next_before_id: null },
  },
  refreshed_at: '2026-09-22T12:02:00.000Z',
})

const DIRECTORY = Object.freeze({
  view: 'directory',
  places: [
    { id: ROOT_PLACE_ID, parent_id: null, name: 'gate_district' },
    { id: WEST_HALL_ID, parent_id: ROOT_PLACE_ID, name: 'west_hall' },
    { id: EAST_HALL_ID, parent_id: ROOT_PLACE_ID, name: 'east_hall' },
    { id: CLOSED_HALL_ID, parent_id: ROOT_PLACE_ID, name: 'closed_hall' },
    { id: MODERATED_HALL_ID, parent_id: ROOT_PLACE_ID, name: 'moderated_hall' },
  ],
  residents: [],
})

function placeRecord(id: number) {
  const farHinge = id === WEST_HALL_ID
    ? hinge(EAST_HALL_ID, 'east_hall')
    : id === EAST_HALL_ID
      ? hinge(WEST_HALL_ID, 'west_hall')
      : id === MODERATED_HALL_ID
        ? hinge(606, MODERATED_NAME)
        : null
  return {
    place: {
      id,
      parent_id: ROOT_PLACE_ID,
      name: id === WEST_HALL_ID ? 'west_hall'
        : id === EAST_HALL_ID ? 'east_hall'
          : id === CLOSED_HALL_ID ? 'closed_hall' : 'moderated_hall',
      description: 'A hall with a gate.',
      purpose: '',
      owner: 'gatekeeper-owner',
      status: 'active',
      quiet: false,
      rough_room: false,
      hinge: farHinge,
    },
    front_matter: [],
    subplaces: [],
    things: [],
    notes: [],
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/__e2e/health')
  await page.route('**/api/window**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('view') === 'directory') return route.fulfill({ json: DIRECTORY })
    const collectionName = url.searchParams.get('collection')
    if (!collectionName) return route.fulfill({ json: SNAPSHOT })
    return route.fulfill({
      json: { [collectionName]: [], has_more: false, next_before_id: null, change_marker: '50' },
    })
  })
  await page.route('**/api/place/**', route => {
    const id = Number(new URL(route.request().url()).pathname.split('/')[3])
    return route.fulfill({ json: placeRecord(id) })
  })
  await page.route('**/api/events**', route => route.fulfill({
    json: { events: [], has_more: false, next_before_id: null, change_marker: '50' },
  }))
  await page.route('**/api/residents**', route => route.fulfill({
    json: { residents: [], has_more: false, next_before_id: null, change_marker: '50' },
  }))
  const htmlWithoutAutomaticClient = WINDOW_HTML.replace(
    /\s*<script src="\/window\.js" defer><\/script>/,
    '',
  )
  await page.setContent(htmlWithoutAutomaticClient)
  await page.addStyleTag({ content: WINDOW_CSS })
  await page.addScriptTag({ content: WINDOW_JS })
  await expect(page.locator('#window-status')).toContainText('Watching')
})

async function openPlace(page: Page, placeId: number): Promise<void> {
  await page.evaluate(id => { window.location.hash = '#view=place&place=' + String(id) }, placeId)
}

test('an open hinge names the next place and opens it from the Place view', async ({ page }) => {
  await openPlace(page, WEST_HALL_ID)
  const placeHinge = page.locator('.place-hinge')
  await expect(placeHinge).toHaveText(HINGE_LINE)
  await placeHinge.getByRole('button', { name: 'east_hall (place 603)', exact: true }).click()
  await expect(page.locator('#place-focus-title')).toHaveText('east_hall')
})

test('a place with no open hinge shows no Place view hinge line', async ({ page }) => {
  await openPlace(page, CLOSED_HALL_ID)
  await expect(page.locator('#place-focus-title')).toHaveText('closed_hall')
  await expect(page.locator('.place-hinge')).toHaveCount(0)
})

test('the Map row links to its open hinge at a 375 pixel viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await openPlace(page, WEST_HALL_ID)
  await page.locator('#map-tab').click()
  const westHallCard = page.locator('.place-card').filter({
    has: page.getByRole('button', { name: 'west_hall', exact: true }),
  })
  const mapHinge = westHallCard.getByRole('button', { name: 'hinge to east_hall', exact: true })
  await expect(mapHinge).toBeVisible()
  await mapHinge.click()
  await expect(page.locator('#place-focus-title')).toHaveText('east_hall')
})

test('a moderated far place name stays moderated in the Place view', async ({ page }) => {
  await openPlace(page, MODERATED_HALL_ID)
  await expect(page.locator('.place-hinge')).toHaveText(
    'Hinge: one step to [removed by maintainer] (place 606), a door open while both places name each other.',
  )
})
