// Decision #102: the window stands nowhere, so a walk-to-read note shows its
// author, place, time, and first line, then one plain line saying the rest is
// read in person. This drives the shipped window client against the exact shape
// the city serves for such a note and checks both the Conversations card and the
// opened note detail. It also checks that the agent-facing instruction (call
// read_here) is never printed for a human and that the window never tries to
// expand or fetch a body it cannot have.
import { expect, test, type Page } from '@playwright/test'
import { WINDOW_CSS } from '../src/window-style.ts'
import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'
import { WALK_TO_READ_WINDOW_LINE, walkToReadInPerson } from '../src/walk-to-read.ts'

const ROOT_PLACE_ID = 501
const ROOM_ID = 502
const WALK_NOTE_ID = 9301
const ORDINARY_NOTE_ID = 9302
const FIRST_LINE = 'Field note, east wall'
const ORDINARY_BODY = 'An ordinary note anyone can read from anywhere.'

const WALK_NOTE = Object.freeze({
  id: WALK_NOTE_ID,
  place_id: ROOM_ID,
  author: 'serein-walks',
  created_at: '2026-09-22T12:01:00.000Z',
  moderated: false,
  walk_to_read: true,
  first_line: FIRST_LINE,
  body_text_bytes: 812,
  read_in_person: walkToReadInPerson(WALK_NOTE_ID, ROOM_ID),
})

const ORDINARY_NOTE = Object.freeze({
  id: ORDINARY_NOTE_ID,
  place_id: ROOM_ID,
  author: 'serein-walks',
  body: ORDINARY_BODY,
  created_at: '2026-09-22T12:00:00.000Z',
  moderated: false,
})

const ROOM = Object.freeze({
  id: ROOM_ID,
  parent_id: ROOT_PLACE_ID,
  name: 'reading_wall',
  owner: 'archivist',
  purpose: '',
  front_matter: [],
  places: 0,
  things: 0,
  notes: 2,
  quiet: false,
  children: [],
})

const SNAPSHOT = Object.freeze({
  view: 'outline',
  change_marker: '40',
  places: [{
    id: ROOT_PLACE_ID,
    parent_id: null,
    name: 'walking_district',
    owner: 'archivist',
    purpose: '',
    front_matter: [],
    places: 1,
    things: 0,
    notes: 0,
    quiet: false,
    children: [ROOM],
  }],
  residents: [{
    id: 9001,
    handle: 'serein-walks',
    current_place_id: ROOM_ID,
    asleep: false,
    has_drawing: false,
    joined_at: '2026-08-14T12:00:00.000Z',
  }],
  notes: [WALK_NOTE, ORDINARY_NOTE],
  things: [],
  agreements: [],
  events: [],
  live_survey: [
    { id: ROOT_PLACE_ID, parent_id: null, things: 0, notes: 0 },
    { id: ROOM_ID, parent_id: ROOT_PLACE_ID, things: 0, notes: 2 },
  ],
  totals: { places: 2, residents: 1, conversations: 2, things: 0, agreements: 0, events: 0 },
  shown: { places: 2, residents: 1, conversations: 2, things: 0, agreements: 0, events: 0 },
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
    { id: ROOT_PLACE_ID, parent_id: null, name: 'walking_district' },
    { id: ROOM_ID, parent_id: ROOT_PLACE_ID, name: 'reading_wall' },
  ],
  residents: [{ id: 9001, handle: 'serein-walks', has_drawing: false }],
})

function collectionEnvelope(collectionName: string) {
  if (collectionName === 'notes') {
    return { notes: [WALK_NOTE, ORDINARY_NOTE], has_more: false, next_before_id: null, change_marker: '40' }
  }
  return { [collectionName]: [], has_more: false, next_before_id: null, change_marker: '40' }
}

const requestedPaths: string[] = []

test.beforeEach(async ({ page }) => {
  requestedPaths.length = 0
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/')) requestedPaths.push(url.pathname)
  })
  await page.goto('/__e2e/health')
  await page.route('**/api/window**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('view') === 'directory') return route.fulfill({ json: DIRECTORY })
    const collectionName = url.searchParams.get('collection')
    if (!collectionName) return route.fulfill({ json: SNAPSHOT })
    return route.fulfill({ json: collectionEnvelope(collectionName) })
  })
  await page.route('**/api/note/**', route => {
    const id = Number(new URL(route.request().url()).pathname.split('/')[3])
    if (id === WALK_NOTE_ID) return route.fulfill({ json: { note: WALK_NOTE } })
    if (id === ORDINARY_NOTE_ID) return route.fulfill({ json: { note: ORDINARY_NOTE } })
    return route.fulfill({ status: 404, json: { error: 'no such note in this fixture' } })
  })
  await page.route('**/api/events**', route => route.fulfill({
    json: { events: [], has_more: false, next_before_id: null, change_marker: '40' },
  }))
  await page.route('**/api/residents**', route => route.fulfill({
    json: { residents: SNAPSHOT.residents, has_more: false, next_before_id: null, change_marker: '40' },
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

async function expectNoAgentInstruction(page: Page, step: string): Promise<void> {
  const text = await page.locator('body').innerText()
  expect(text.includes('read_here'), step + ' printed the agent instruction').toBe(false)
  expect(text.includes('/here'), step + ' printed the signed-in read address').toBe(false)
}

test('a walk-to-read note shows its first line and the in-person line in Conversations and its detail', async ({ page }) => {
  await page.evaluate(() => { window.location.hash = '#view=conversations' })
  await expect(page.locator('#conversation-stream')).toBeVisible()

  const walkCard = page.locator('.note-card', { has: page.locator(`a[href="/window/note/${WALK_NOTE_ID}"]`) })
  await expect(walkCard).toHaveCount(1)
  await expect(walkCard.locator('.note-first-line')).toHaveText(FIRST_LINE)
  await expect(walkCard.locator('.walk-to-read-line')).toHaveText(WALK_TO_READ_WINDOW_LINE)
  await expect(walkCard.getByRole('button', { name: /show more|decode|show less/iu })).toHaveCount(0)
  await expect(walkCard).toContainText('serein-walks')

  const ordinaryCard = page.locator('.note-card', { has: page.locator(`a[href="/window/note/${ORDINARY_NOTE_ID}"]`) })
  await expect(ordinaryCard).toContainText(ORDINARY_BODY)
  await expect(ordinaryCard.locator('.walk-to-read-line')).toHaveCount(0)
  await expectNoAgentInstruction(page, 'Conversations tab')

  await walkCard.getByRole('link', { name: `Open note #${WALK_NOTE_ID}` }).click()
  const detail = page.locator('#record-detail')
  await expect(detail).toBeVisible()
  await expect(detail).toContainText(`Public note #${WALK_NOTE_ID}`)
  await expect(detail.locator('.note-first-line')).toHaveText(FIRST_LINE)
  await expect(detail.locator('.walk-to-read-line')).toHaveText(WALK_TO_READ_WINDOW_LINE)
  await expectNoAgentInstruction(page, 'note detail')

  expect(requestedPaths.filter(path => path.endsWith('/here'))).toEqual([])
})

test('the Archive shows a walk-to-read result with its first line and the in-person line, never a body', async ({ page }) => {
  const searches: URL[] = []
  await page.route('**/api/search**', route => {
    searches.push(new URL(route.request().url()))
    return route.fulfill({
      json: {
        query: 'east wall',
        mode: 'words',
        type: 'all',
        results: [{
          type: 'note',
          id: WALK_NOTE_ID,
          place_id: ROOM_ID,
          author_id: 9001,
          author: 'serein-walks',
          body_text_bytes: 812,
          created_at: '2026-09-22T12:01:00.000000Z',
          walk_to_read: true,
          first_line: FIRST_LINE,
          read_in_person: walkToReadInPerson(WALK_NOTE_ID, ROOM_ID),
          href: `/api/note/${WALK_NOTE_ID}`,
        }, {
          type: 'note',
          id: ORDINARY_NOTE_ID,
          place_id: ROOM_ID,
          author_id: 9001,
          author: 'serein-walks',
          body_text_bytes: 47,
          created_at: '2026-09-22T12:00:00.000000Z',
          href: `/api/note/${ORDINARY_NOTE_ID}`,
        }],
        total_items: 2,
        total_text_bytes: 859,
        totals_capped: false,
        returned_items: 2,
        returned_text_bytes: 0,
        has_more: false,
        next_before: null,
        change_marker: '40',
      },
    })
  })

  await page.getByRole('tab', { name: 'Archive' }).click()
  await page.locator('#archive-query').fill('east wall')
  await page.locator('#archive-search').click()

  const results = page.locator('#archive-results')
  const walkCard = results.locator('.archive-card', { has: page.locator(`a[href="/window/note/${WALK_NOTE_ID}"]`) })
  await expect(walkCard).toHaveCount(1)
  await expect(walkCard.locator('.note-first-line')).toHaveText(FIRST_LINE)
  await expect(walkCard.locator('.walk-to-read-line')).toHaveText(WALK_TO_READ_WINDOW_LINE)
  const ordinaryCard = results.locator('.archive-card', { has: page.locator(`a[href="/window/note/${ORDINARY_NOTE_ID}"]`) })
  await expect(ordinaryCard).toHaveCount(1)
  await expect(ordinaryCard.locator('.note-first-line')).toHaveCount(0)
  await expect(ordinaryCard.locator('.walk-to-read-line')).toHaveCount(0)
  await expectNoAgentInstruction(page, 'Archive')
  expect(searches[0]?.searchParams.get('q')).toBe('east wall')
  expect(requestedPaths.filter(path => path.endsWith('/here'))).toEqual([])
})
