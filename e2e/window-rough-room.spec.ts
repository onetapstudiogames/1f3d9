// Decision #109: a room its owner marked rough says so before anyone walks in.
// This drives the shipped window client against the exact place shape the city
// serves and checks that the Place view prints the rough-room line for a rough
// room and never for an ordinary one.
import { expect, test, type Page } from '@playwright/test'
import { WINDOW_CSS } from '../src/window-style.ts'
import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'

const ROOT_PLACE_ID = 601
const ROUGH_ROOM_ID = 602
const PLAIN_ROOM_ID = 603
const ROUGH_ROOM_LINE =
  'Rough room: its owner lets things that wake here hold or send home a resident who walks in or speaks. Going home is never blocked.'

function room(id: number, name: string) {
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
    places: 2,
    things: 0,
    notes: 0,
    quiet: false,
    children: [room(ROUGH_ROOM_ID, 'rough_hall'), room(PLAIN_ROOM_ID, 'plain_hall')],
  }],
  residents: [],
  notes: [],
  things: [],
  agreements: [],
  events: [],
  live_survey: [
    { id: ROOT_PLACE_ID, parent_id: null, things: 0, notes: 0 },
    { id: ROUGH_ROOM_ID, parent_id: ROOT_PLACE_ID, things: 0, notes: 0 },
    { id: PLAIN_ROOM_ID, parent_id: ROOT_PLACE_ID, things: 0, notes: 0 },
  ],
  totals: { places: 3, residents: 0, conversations: 0, things: 0, agreements: 0, events: 0 },
  shown: { places: 3, residents: 0, conversations: 0, things: 0, agreements: 0, events: 0 },
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
    { id: ROUGH_ROOM_ID, parent_id: ROOT_PLACE_ID, name: 'rough_hall' },
    { id: PLAIN_ROOM_ID, parent_id: ROOT_PLACE_ID, name: 'plain_hall' },
  ],
  residents: [],
})

function placeRecord(id: number) {
  return {
    place: {
      id,
      parent_id: ROOT_PLACE_ID,
      name: id === ROUGH_ROOM_ID ? 'rough_hall' : 'plain_hall',
      description: 'A hall with a gate.',
      purpose: '',
      owner: 'gatekeeper-owner',
      status: 'active',
      quiet: false,
      rough_room: id === ROUGH_ROOM_ID,
      wake_visitors: false,
      wake_pins: [],
      wake_block_thing_ids: [],
      wake_block_residents: [],
      wake_random_cap: 8,
      last_settle: null,
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

test('a rough room says so on its Place view', async ({ page }) => {
  await openPlace(page, ROUGH_ROOM_ID)
  await expect(page.locator('#place-focus-title')).toHaveText('rough_hall')
  await expect(page.locator('.place-rough-room')).toHaveText(ROUGH_ROOM_LINE)
})

test('an ordinary room shows no rough-room line', async ({ page }) => {
  await openPlace(page, PLAIN_ROOM_ID)
  await expect(page.locator('#place-focus-title')).toHaveText('plain_hall')
  await expect(page.locator('.place-description-text')).toHaveText('A hall with a gate.')
  await expect(page.locator('.place-rough-room')).toHaveCount(0)
})
