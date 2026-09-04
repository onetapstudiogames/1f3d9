// Fourth review pass on row 75 (docs/DECISIONS.md row 75): three prior
// review passes each fixed the specific rows a human reviewer happened to
// spot; both the directory search box and the Live roster's dataset markers
// shipped, were reviewed twice more, and still leaked. Rather than adding
// another pair of spot assertions, this file drives the whole shipped window
// client — every tab, the directory search box, the live focus/follow state,
// a resident-filtered deep link, and every share button — against a fixture
// with one quiet grandchild place holding a resident, a thing, and a note
// each carrying a unique sentinel value. After every step it scans the
// entire live DOM (outerHTML text and every element's own attributes,
// including dataset) for those three sentinels. A hit anywhere fails the
// test with the exact step and element that produced it, so a future leak
// anywhere in the client — not just at the two rows this round's report
// named — is caught the same way.
import { expect, test, type Page } from '@playwright/test'
import { WINDOW_CSS } from '../src/window-style.ts'
import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'

// Sentinels are deliberately not real words, so an accidental substring
// match inside ordinary window chrome (labels, CSS class names, help text)
// cannot produce a false pass.
const RESIDENT_SENTINEL = 'sentinel-res-zq9k7'
const THING_SENTINEL = 'SentinelThingZq9k7'
const NOTE_SENTINEL = 'SentinelNoteBodyZq9k7'
const SENTINELS = Object.freeze([RESIDENT_SENTINEL, THING_SENTINEL, NOTE_SENTINEL])

const CONTROL_RESIDENT = 'lantern-keeper'

// harbor_district (401, root) -> lantern_row (402, ordinary) -> hushed_cellar
// (403, quiet: true) — a grandchild two levels down, matching the shape the
// third review's own "nested two levels below the plotted place" fix
// targeted, so this fixture also re-covers that ground under the new scan.
const ROOT_PLACE_ID = 401
const CHILD_PLACE_ID = 402
const QUIET_PLACE_ID = 403

const SENTINEL_THING_HEADING = Object.freeze({
  id: 9101,
  place_id: QUIET_PLACE_ID,
  name: THING_SENTINEL,
  maker_id: 9001,
  made_by: RESIDENT_SENTINEL,
  current_owner_id: 9001,
  current_owner: RESIDENT_SENTINEL,
  body_text_bytes: 42,
  created_at: '2026-08-20T12:00:00.000Z',
  has_drawing: false,
})

const SENTINEL_FRONT_MATTER_HEADING = Object.freeze({
  id: 9102,
  type: 'thing',
  name: THING_SENTINEL,
  maker_id: 9001,
  made_by: RESIDENT_SENTINEL,
  current_owner_id: 9001,
  current_owner: RESIDENT_SENTINEL,
  owner_id: 9001,
  owner: RESIDENT_SENTINEL,
  body_text_bytes: 42,
  created_at: '2026-08-20T12:00:00.000Z',
  has_drawing: false,
})

const SENTINEL_NOTE = Object.freeze({
  id: 9201,
  place_id: QUIET_PLACE_ID,
  author: RESIDENT_SENTINEL,
  body: 'A resident wrote a private line here: ' + NOTE_SENTINEL + ' before the room turned quiet.',
  truncated: false,
  created_at: '2026-08-20T12:01:00.000Z',
})

const QUIET_PLACE = Object.freeze({
  id: QUIET_PLACE_ID,
  parent_id: CHILD_PLACE_ID,
  name: 'hushed_cellar',
  owner: 'archivist',
  purpose: 'A room its owner asked the window to keep quiet.',
  front_matter: [SENTINEL_FRONT_MATTER_HEADING],
  places: 0,
  things: 1,
  notes: 1,
  quiet: true,
  children: [],
})

const SNAPSHOT = Object.freeze({
  view: 'outline',
  change_marker: '30',
  places: [{
    id: ROOT_PLACE_ID,
    parent_id: null,
    name: 'harbor_district',
    owner: 'archivist',
    purpose: '',
    front_matter: [],
    places: 1,
    things: 0,
    notes: 0,
    children: [{
      id: CHILD_PLACE_ID,
      parent_id: ROOT_PLACE_ID,
      name: 'lantern_row',
      owner: 'archivist',
      places: 1,
      things: 0,
      notes: 0,
      children: [QUIET_PLACE],
    }],
  }],
  residents: [{
    id: 9001,
    handle: RESIDENT_SENTINEL,
    current_place_id: QUIET_PLACE_ID,
    asleep: false,
    has_drawing: false,
    joined_at: '2026-08-14T12:00:00.000Z',
  }, {
    id: 8001,
    handle: CONTROL_RESIDENT,
    current_place_id: CHILD_PLACE_ID,
    asleep: false,
    has_drawing: false,
    joined_at: '2026-08-14T12:00:00.000Z',
  }],
  notes: [SENTINEL_NOTE],
  things: [{
    id: SENTINEL_THING_HEADING.id,
    place_id: QUIET_PLACE_ID,
    name: THING_SENTINEL,
    body: 'a private thing body',
    owner: RESIDENT_SENTINEL,
    open_to_use: false,
    truncated: false,
    created_at: '2026-08-20T12:00:00.000Z',
  }],
  agreements: [],
  events: [],
  live_survey: [
    { id: ROOT_PLACE_ID, parent_id: null, things: 0, notes: 0 },
    { id: CHILD_PLACE_ID, parent_id: ROOT_PLACE_ID, things: 0, notes: 0 },
    { id: QUIET_PLACE_ID, parent_id: CHILD_PLACE_ID, things: 1, notes: 1 },
  ],
  totals: { places: 3, residents: 2, conversations: 1, things: 1, agreements: 0, events: 0 },
  shown: { places: 3, residents: 2, conversations: 1, things: 1, agreements: 0, events: 0 },
  limits: { places: 10, residents: 25, conversations: 10, things: 10, agreements: 10, events: 10 },
  pages: {
    places: { has_more: false, next_before_subplace_id: null },
    residents: { has_more: false, next_before_id: null },
    notes: { has_more: false, next_before_id: null },
    things: { has_more: false, next_before_id: null },
    agreements: { has_more: false, next_before_id: null },
    events: { has_more: false, next_before_id: null },
  },
  refreshed_at: '2026-08-20T12:02:00.000Z',
})

const DIRECTORY = Object.freeze({
  view: 'directory',
  places: [
    { id: ROOT_PLACE_ID, parent_id: null, name: 'harbor_district' },
    { id: CHILD_PLACE_ID, parent_id: ROOT_PLACE_ID, name: 'lantern_row' },
    { id: QUIET_PLACE_ID, parent_id: CHILD_PLACE_ID, name: 'hushed_cellar', quiet: true },
  ],
  residents: [
    { id: 9001, handle: RESIDENT_SENTINEL, has_drawing: false },
    { id: 8001, handle: CONTROL_RESIDENT, has_drawing: false },
  ],
})

const FOCUSED_QUIET_PLACE = Object.freeze({
  view: 'outline',
  change_marker: '30',
  place: QUIET_PLACE,
  subplaces: [],
  subplaces_page: { has_more: false, next_before_subplace_id: null },
})

function collectionEnvelope(collectionName: string) {
  if (collectionName === 'things') {
    return { things: [SENTINEL_THING_HEADING], has_more: false, next_before_id: null, change_marker: '30' }
  }
  if (collectionName === 'notes') {
    return { notes: [SENTINEL_NOTE], has_more: false, next_before_id: null, change_marker: '30' }
  }
  if (collectionName === 'residents') {
    return { residents: SNAPSHOT.residents, has_more: false, next_before_id: null, change_marker: '30' }
  }
  if (collectionName === 'agreements') {
    return { agreements: [], has_more: false, next_before_id: null, change_marker: '30' }
  }
  return { events: [], has_more: false, next_before_id: null, change_marker: '30' }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/__e2e/health')
  await page.route('**/api/window**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('view') === 'directory') {
      return route.fulfill({ json: DIRECTORY })
    }
    const collectionName = url.searchParams.get('collection')
    if (!collectionName) return route.fulfill({ json: SNAPSHOT })
    return route.fulfill({ json: collectionEnvelope(collectionName) })
  })
  await page.route('**/api/map**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('parent_id') === String(QUIET_PLACE_ID)) {
      return route.fulfill({ json: FOCUSED_QUIET_PLACE })
    }
    return route.fulfill({ status: 404, json: { error: 'unmapped test branch', change_marker: '30' } })
  })
  await page.route('**/api/residents**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('handle') === RESIDENT_SENTINEL) {
      return route.fulfill({
        json: {
          change_marker: '30',
          resident: {
            id: 9001, handle: RESIDENT_SENTINEL, current_place_id: QUIET_PLACE_ID,
            asleep: false, joined_at: '2026-08-14T12:00:00.000Z',
          },
        },
      })
    }
    return route.fulfill({
      json: { residents: SNAPSHOT.residents, has_more: false, next_before_id: null, change_marker: '30' },
    })
  })
  await page.route('**/api/events**', route => route.fulfill({
    json: { events: [], has_more: false, next_before_id: null, change_marker: '30' },
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

type Leak = Readonly<{ sentinel: string; path: string; detail: string }>

// The resident directory filter (#resident-filter) and the directory search
// box's own results (#directory-search-results) both list a matching handle
// with no location text at all — decision #75 withholds only where a
// resident currently stands, never their existence in the citywide
// directory — so the sentinel handle legitimately appears there. The
// already-followed-resident card is the one other place a handle may
// legitimately survive quiet: decision #75 lets an already identified,
// viewer-chosen handle keep naming itself once the viewer has explicitly
// selected it, while still withholding its location. #view-scope and
// #conversation-mode echo that same viewer-chosen state.resident filter
// back as plain status text ("resident <handle>" / "what <handle> said"),
// and #share-status echoes it again inside the shared URL itself — every
// field windowSharePath serializes (view/place/resident/search) is the
// viewer's own chosen state, per windowSharePath's own WindowShareState
// contract, never ambient room content. Every exemption here covers the
// resident handle only — a thing name or note body must never appear
// inside them either, so this scan still checks them.
const RESIDENT_HANDLE_ALLOWED_CONTAINERS =
  '#resident-filter, #directory-search-results, .live-focus-resident-card, ' +
  '#view-scope, #conversation-mode, #share-status, #record-detail-share-status'

async function scanForSentinels(page: Page): Promise<readonly Leak[]> {
  return page.evaluate(({ sentinels, residentSentinel, allowedSelector }) => {
    const hits: { sentinel: string; path: string; detail: string }[] = []
    const describe = (element: Element): string => {
      const id = element.id ? '#' + element.id : ''
      const classes = typeof element.className === 'string' && element.className
        ? '.' + element.className.trim().split(/\s+/u).join('.')
        : ''
      return element.tagName.toLowerCase() + id + classes
    }
    const walk = (element: Element) => {
      const inAllowedContainer = element.closest(allowedSelector) !== null
      for (const attribute of Array.from(element.attributes)) {
        for (const sentinel of sentinels) {
          if (sentinel === residentSentinel && inAllowedContainer) continue
          if (attribute.value.includes(sentinel)) {
            hits.push({
              sentinel,
              path: describe(element),
              detail: attribute.name + '="' + attribute.value + '"',
            })
          }
        }
      }
      for (const node of Array.from(element.childNodes)) {
        if (node.nodeType !== Node.TEXT_NODE) continue
        const text = node.textContent || ''
        for (const sentinel of sentinels) {
          if (sentinel === residentSentinel && inAllowedContainer) continue
          if (text.includes(sentinel)) {
            hits.push({ sentinel, path: describe(element), detail: 'text="' + text.trim().slice(0, 120) + '"' })
          }
        }
      }
      for (const child of Array.from(element.children)) walk(child)
    }
    walk(document.documentElement)
    return hits
  }, { sentinels: SENTINELS, residentSentinel: RESIDENT_SENTINEL, allowedSelector: RESIDENT_HANDLE_ALLOWED_CONTAINERS })
}

async function assertNoLeak(page: Page, step: string): Promise<void> {
  const leaks = await scanForSentinels(page)
  expect(leaks, 'sentinel leaked during step: ' + step + '\n' +
    leaks.map(leak => '  ' + leak.sentinel + ' via ' + leak.path + ' ' + leak.detail).join('\n')).toEqual([])
}

test('no view, search, focus, deep link, or share action ever renders the quiet grandchild resident, thing, or note', async ({ page }) => {
  // Map tab is the default landing view: exercises placeList's occupant line
  // and its owner-chosen front matter, and the Map tab's #resident-roster.
  await expect(page.getByRole('button', { name: 'harbor_district', exact: true })).toBeVisible()
  await assertNoLeak(page, 'Map tab, default load')

  // Drill the Map tree open so the quiet grandchild's own card mounts.
  const rootDisclosure = page.locator('.place-card', { hasText: 'harbor_district' })
    .getByRole('button', { name: 'Show inside' })
  if (await rootDisclosure.count()) await rootDisclosure.first().click()
  const childDisclosure = page.locator('.place-card', { hasText: 'lantern_row' })
    .getByRole('button', { name: 'Show inside' })
  if (await childDisclosure.count()) await childDisclosure.first().click()
  await assertNoLeak(page, 'Map tab, quiet grandchild card expanded')

  // Live tab: the roster, the plates (livePortraitGrid / liveThingShelf),
  // the trail/replay layer, and the ledger all recurse through the quiet
  // grandchild two levels below the focused root.
  await page.getByRole('tab', { name: 'Live' }).click()
  await expect(page.locator('#live-plates')).toBeVisible()
  await assertNoLeak(page, 'Live tab, default load')

  // Step 4: the single reusable Live item popover. Drill to lantern_row so
  // the quiet grandchild (hushed_cellar) renders as one of its own direct
  // plots -- the only anchor a quiet room offers on the plate, since its
  // residents and things never render at all -- and open the popover on
  // its nameplate. liveItemPopoverFacts resolves this place's own quiet
  // mark and must print only its name, owner, and counts (all public per
  // decision #75) plus the locked quiet sentence, never the sentinel
  // resident, thing, or note this fixture would otherwise leak.
  await page.evaluate(placeId => { window.location.hash = '#view=live&place=' + String(placeId) }, CHILD_PLACE_ID)
  const quietPlot = page.locator('.live-plot[data-place-id="' + String(QUIET_PLACE_ID) + '"]')
  await expect(quietPlot).toBeVisible()
  await quietPlot.locator('.live-plot-open').hover()
  await expect(page.locator('#live-item-popover')).toBeVisible()
  await expect(page.locator('#live-item-popover')).toContainText('hushed_cellar')
  await expect(page.locator('#live-item-popover .quiet-room-notice')).toContainText(
    'archivist prefers to keep this room private.',
  )
  await assertNoLeak(page, 'Live item popover on the quiet grandchild plot')
  await page.keyboard.press('Escape')

  // Step 6: the exact count remains public, but opening the quiet room's
  // notes panel must show only the locked quiet sentence and no note body.
  await quietPlot.getByRole('button', { name: 'Open 1 notes in hushed_cellar' }).click()
  await expect(page.locator('#live-notes-panel')).toBeVisible()
  await expect(page.locator('#live-notes-panel .quiet-room-notice')).toContainText(
    'archivist prefers to keep this room private.',
  )
  await expect(page.locator('#live-notes-panel .live-note-body')).toHaveCount(0)
  await assertNoLeak(page, 'Live notes panel on the quiet grandchild plot')
  await page.keyboard.press('Escape')

  // Things tab: the city-wide heading list (renderThingIndex) and its own
  // history-page control.
  await page.getByRole('tab', { name: 'Things' }).click()
  await expect(page.locator('#things-list')).toBeVisible()
  await assertNoLeak(page, 'Things tab, default load')

  // Directory search: type each sentinel in turn. thingLookupSearchResults
  // must never resolve the quiet thing into a result, and the resident
  // search never carries location at all.
  const search = page.locator('#directory-search')
  for (const sentinel of [RESIDENT_SENTINEL, THING_SENTINEL, NOTE_SENTINEL]) {
    await search.fill(sentinel)
    await page.waitForTimeout(250) // clears the debounce on the thing lookup fetch
    await assertNoLeak(page, 'directory search for "' + sentinel + '"')
  }
  await search.fill('')

  // Place tab, navigated directly at the quiet grandchild: renderPlaceOrientation
  // (front matter), and the occupants/things/conversation quiet-notice panels.
  await page.evaluate(placeId => { window.location.hash = '#view=place&place=' + String(placeId) }, QUIET_PLACE_ID)
  await expect(page.locator('#place-focus-title')).toHaveText('hushed_cellar')
  await assertNoLeak(page, 'Place tab, watching the quiet grandchild directly')

  // Conversations tab: the city-wide note stream must withhold the quiet
  // note behind its own notice.
  await page.evaluate(() => { window.location.hash = '#view=conversations' })
  await expect(page.locator('#conversation-stream')).toBeVisible()
  await assertNoLeak(page, 'Conversations tab, default load')

  // A resident-filtered deep link: the viewer explicitly names the sentinel
  // resident by handle (which decision #75 allows to keep naming — the
  // viewer already typed the exact handle), but their current room's
  // contents — their own row's location, the thing, and the note — must
  // still never surface. Every default focus scope here already contains
  // the quiet grandchild, so this filter must resolve through the same
  // per-row isQuietPlace checks as ambient browsing, not the separate
  // "already an identified, viewer-chosen handle" exemption that only
  // applies once a followed resident falls outside the focused plate.
  for (const view of ['map', 'live', 'things', 'conversations']) {
    await page.evaluate(({ view: nextView, resident }) => {
      window.location.hash = '#view=' + nextView + '&resident=' + resident
    }, { view, resident: RESIDENT_SENTINEL })
    await page.waitForTimeout(150)
    await assertNoLeak(page, 'resident-filtered deep link on ' + view)
  }

  // No follow control exists anywhere for the quiet resident: there is no
  // click path to focus them from the UI at all.
  await page.evaluate(() => { window.location.hash = '#view=live' })
  await expect(page.locator('[data-live-resident-handle="' + RESIDENT_SENTINEL + '"]')).toHaveCount(0)
  await expect(page.locator('.resident-follow', { hasText: RESIDENT_SENTINEL })).toHaveCount(0)

  // Share links: every view's share button serializes only the viewer's own
  // chosen filters (view/place/resident/search), never ambient room content
  // — click each one while the quiet grandchild and the sentinel resident
  // filter are in scope and confirm the resulting status text stays clean.
  for (const view of ['map', 'live', 'things', 'place', 'conversations']) {
    await page.evaluate(({ view: nextView, place, resident }) => {
      window.location.hash = '#view=' + nextView + '&place=' + String(place) + '&resident=' + resident
    }, { view, place: QUIET_PLACE_ID, resident: RESIDENT_SENTINEL })
    await page.waitForTimeout(150)
    const shareButton = page.locator('.view-panel:not([hidden]) .share-button[data-share-scope="view"]').first()
    if (await shareButton.count()) await shareButton.click()
    await page.waitForTimeout(50)
    await assertNoLeak(page, 'share button on ' + view)
  }
})
