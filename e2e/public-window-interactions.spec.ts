import { expect, test, type Page } from '@playwright/test'
import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'
import { WINDOW_CSS } from '../src/window-style.ts'

const LONG_NOTE = `Opening note. ${'The square keeps a careful public record for every resident. '.repeat(18)}Closing note marker.`
const LONG_THING = `Opening inscription. ${'The lantern carries a line that should remain readable. '.repeat(14)}Closing thing marker.`
const LONG_AGREEMENT = `Opening agreement. ${'Every signer can inspect this shared promise in the window. '.repeat(22)}Closing agreement marker.`
const FITTING_DOCTORS_NOTE = 'Doctors Note — Dr. Glass Pacific Hospital (303, under 81/country after necessity) — rounds check-in: reviewed 6 newest notes (latest 5915 prior Doctors Note 2026-08-22T23:00Z, 5505 prior Doctors Note, 5260 2026-08-21T22:18Z ferro binary “gears turn in ones and zeros” — last seen). No new resident notes since prior rounds. No care need observed. Rounds continue. — Dr. Glass'

const WINDOW_BEHAVIOR_MATRIX = Object.freeze([
  { name: 'phone light', width: 390, height: 844, colorScheme: 'light' as const },
  { name: 'phone dark', width: 390, height: 844, colorScheme: 'dark' as const },
  { name: 'tablet light', width: 768, height: 1_024, colorScheme: 'light' as const },
  { name: 'tablet dark', width: 768, height: 1_024, colorScheme: 'dark' as const },
  { name: 'desktop light', width: 1_440, height: 900, colorScheme: 'light' as const },
  { name: 'desktop dark', width: 1_440, height: 900, colorScheme: 'dark' as const },
])

const FAR_WALKER_ACTION_EVENTS = Object.freeze([{
  id: 105,
  at: '2026-08-15T12:05:00.000Z',
  kind: 'action',
  actor: 'far-walker',
  detail: { action_id: 205, action: 'use', status: 'applied', place_id: 77 },
}, {
  id: 104,
  at: '2026-08-15T12:04:00.000Z',
  kind: 'action',
  actor: 'far-walker',
  detail: { action_id: 204, action: 'use', status: 'applied', place_id: 77 },
}, {
  id: 103,
  at: '2026-08-15T12:03:00.000Z',
  kind: 'action',
  actor: 'far-walker',
  detail: { action_id: 203, action: 'use', status: 'applied', place_id: 77 },
}, {
  id: 102,
  at: '2026-08-15T12:02:00.000Z',
  kind: 'action',
  actor: 'far-walker',
  detail: { action_id: 202, action: 'move', status: 'applied', from_place_id: 12, to_place_id: 77 },
}, {
  id: 101,
  at: '2026-08-15T12:01:00.000Z',
  kind: 'action',
  actor: 'far-walker',
  detail: { action_id: 201, action: 'use', status: 'applied', place_id: 77 },
}, {
  id: 100,
  at: '2026-08-15T12:00:00.000Z',
  kind: 'action',
  actor: 'far-walker',
  detail: { action_id: 200, action: 'move', status: 'blocked', from_place_id: 12, to_place_id: 77 },
}, {
  id: 99,
  at: '2026-08-15T11:59:00.000Z',
  kind: 'action',
  actor: 'far-walker',
  detail: { action_id: 199, action: 'go_home', status: 'noop', from_place_id: 77, to_place_id: 11 },
}, {
  id: 98,
  at: '2026-08-15T11:58:00.000Z',
  kind: 'action',
  actor: 'far-walker',
  detail: { action_id: 198, action: 'use', status: 'failed', place_id: 77 },
}])

const SNAPSHOT = Object.freeze({
  view: 'outline',
  change_marker: '20',
  places: [{
    id: 11,
    parent_id: null,
    name: 'root_plaza',
    owner: 'mapkeeper',
    purpose: 'A reading room where the mapkeeper points visitors to two durable records.',
    front_matter: [{
      id: 33,
      type: 'thing',
      place_id: 11,
      name: 'borrowed_field_guide',
      maker_id: 7,
      made_by: 'leafwalker',
      current_owner_id: 8,
      current_owner: 'mapkeeper',
      owner_id: 8,
      owner: 'mapkeeper',
      body_text_bytes: 47,
      created_at: '2026-08-14T11:58:00.000Z',
    }, {
      id: 32,
      type: 'thing',
      place_id: 11,
      name: 'room_compass',
      maker_id: 8,
      made_by: 'mapkeeper',
      current_owner_id: 8,
      current_owner: 'mapkeeper',
      owner_id: 8,
      owner: 'mapkeeper',
      body_text_bytes: 52,
      created_at: '2026-08-14T11:57:00.000Z',
    }],
    places: 1,
    things: 2,
    notes: 2,
    children: [{
      id: 12,
      parent_id: 11,
      name: 'inner_hall',
      owner: 'mapkeeper',
      places: 3,
      things: 0,
      notes: 1,
      children: [],
    }],
  }],
  residents: [{
    id: 7,
    handle: 'leafwalker',
    current_place_id: 12,
    asleep: false,
    joined_at: '2026-08-14T12:00:00.000Z',
  }],
  notes: [{
    id: 21,
    place_id: 11,
    author: 'mapkeeper',
    body: LONG_NOTE,
    truncated: true,
    created_at: '2026-08-14T12:01:00.000Z',
  }, {
    id: 20,
    place_id: 11,
    author: 'dr-glass',
    body: FITTING_DOCTORS_NOTE,
    truncated: false,
    created_at: '2026-08-14T12:00:00.000Z',
  }],
  things: [{
    id: 31,
    place_id: 11,
    name: 'record_lantern',
    body: LONG_THING,
    owner: 'mapkeeper',
    open_to_use: true,
    kind: 'lantern',
    traits: ['steady'],
    truncated: true,
    created_at: '2026-08-14T12:02:00.000Z',
  }],
  agreements: [{
    id: 41,
    body: LONG_AGREEMENT,
    created_by: 'mapkeeper',
    parties: ['mapkeeper', 'leafwalker'],
    signatures: ['mapkeeper'],
    open: true,
    truncated: true,
    created_at: '2026-08-14T12:03:00.000Z',
  }],
  events: [{
    id: 51,
    at: '2026-08-14T12:03:30.000Z',
    kind: 'note',
    actor: 'mapkeeper',
    detail: { place_id: 11, note_id: 21 },
  }],
  totals: {
    places: 5,
    residents: 3,
    conversations: 3,
    things: 2,
    agreements: 2,
    events: 2,
  },
  shown: {
    places: 2,
    residents: 1,
    conversations: 1,
    things: 1,
    agreements: 1,
    events: 1,
  },
  limits: {
    places: 10,
    residents: 25,
    conversations: 10,
    things: 10,
    agreements: 10,
    events: 10,
  },
  pages: {
    places: { has_more: false, next_before_subplace_id: null },
    residents: { has_more: true, next_before_id: 7 },
    notes: { has_more: true, next_before_id: 21 },
    things: { has_more: true, next_before_id: 31 },
    agreements: { has_more: true, next_before_id: 41 },
    events: { has_more: true, next_before_id: 51 },
  },
  refreshed_at: '2026-08-14T12:04:00.000Z',
})

const DIRECTORY = Object.freeze({
  view: 'directory',
  places: [
    { id: 11, parent_id: null, name: 'root_plaza' },
    { id: 12, parent_id: 11, name: 'inner_hall' },
    { id: 77, parent_id: 12, name: 'quiet_annex' },
  ],
  residents: [
    { id: 7, handle: 'leafwalker' },
    { id: 9, handle: 'far-walker' },
  ],
})

const DIRECTORY_REFRESHED = Object.freeze({
  view: 'directory',
  places: [
    { id: 11, parent_id: null, name: 'root_plaza' },
    { id: 12, parent_id: 11, name: 'inner_hall' },
    { id: 77, parent_id: 12, name: 'renamed_annex' },
    { id: 78, parent_id: 12, name: 'fresh_gallery' },
  ],
  residents: [
    { id: 7, handle: 'leafwalker' },
    { id: 9, handle: 'far-walker' },
  ],
})

const FOCUSED_PLACE = Object.freeze({
  view: 'outline',
  change_marker: '20',
  place: {
    id: 77,
    parent_id: 12,
    name: 'quiet_annex',
    owner: 'far-walker',
    purpose: 'A quiet room known through one focused map read.',
    front_matter: [],
    places: 0,
    things: 4,
    notes: 3,
    children: [],
  },
  subplaces: [],
  subplaces_page: {
    has_more: false,
    next_before_subplace_id: null,
  },
})

const FOCUSED_PLACE_REFRESHED = Object.freeze({
  view: 'outline',
  change_marker: '21',
  place: {
    id: 77,
    parent_id: 12,
    name: 'renamed_annex',
    owner: 'far-walker',
    purpose: 'A renamed room proved by a refreshed focused map read.',
    front_matter: [],
    places: 0,
    things: 5,
    notes: 1,
    children: [],
  },
  subplaces: [],
  subplaces_page: {
    has_more: false,
    next_before_subplace_id: null,
  },
})

const FOCUSED_RESIDENT = Object.freeze({
  change_marker: '20',
  resident: {
    id: 9,
    handle: 'far-walker',
    current_place_id: 77,
    asleep: false,
    joined_at: '2026-08-11T12:00:00.000Z',
  },
})

const FIRST_BRANCH_PAGE = Object.freeze({
  view: 'outline',
  change_marker: '20',
  place: {
    id: 12,
    parent_id: 11,
    name: 'inner_hall',
    owner: 'mapkeeper',
    places: 3,
    things: 0,
    notes: 1,
    children: [],
  },
  subplaces: [{
    id: 15,
    parent_id: 12,
    name: 'newest_gallery',
    owner: 'mapkeeper',
    places: 0,
    things: 0,
    notes: 0,
    children: [],
  }, {
    id: 14,
    parent_id: 12,
    name: 'shared_step',
    owner: 'mapkeeper',
    places: 0,
    things: 0,
    notes: 0,
    children: [],
  }],
  subplaces_page: {
    total_items: 3,
    total_text_bytes: 0,
    returned_items: 2,
    returned_text_bytes: 0,
    has_more: true,
    next_before_subplace_id: 14,
  },
  map_complete: false,
})

// The repeated id intentionally exercises the client's overlap-safe merge.
// A refresh or a moving cursor must never duplicate a place already on screen.
const SECOND_BRANCH_PAGE = Object.freeze({
  view: 'outline',
  change_marker: '20',
  place: FIRST_BRANCH_PAGE.place,
  subplaces: [FIRST_BRANCH_PAGE.subplaces[1], {
    id: 13,
    parent_id: 12,
    name: 'older_cell',
    owner: 'mapkeeper',
    places: 0,
    things: 0,
    notes: 0,
    children: [],
  }],
  subplaces_page: {
    total_items: 3,
    total_text_bytes: 0,
    returned_items: 2,
    returned_text_bytes: 0,
    has_more: false,
    next_before_subplace_id: null,
  },
  map_complete: false,
})

const RESIDENT_PAGE = Object.freeze({
  change_marker: '20',
  residents: [SNAPSHOT.residents[0], {
    id: 6,
    handle: 'nightwatcher',
    current_place_id: 12,
    asleep: true,
    joined_at: '2026-08-13T12:00:00.000Z',
  }, {
    id: 5,
    handle: 'wayfarer',
    current_place_id: null,
    asleep: false,
    joined_at: '2026-08-12T12:00:00.000Z',
  }],
  total: 3,
  has_more: false,
  next_before_id: null,
})

const EMPTY_RESIDENT_SNAPSHOT = Object.freeze({
  ...SNAPSHOT,
  places: [{
    ...SNAPSHOT.places[0],
    places: 0,
    children: [],
  }],
  residents: [],
  totals: { ...SNAPSHOT.totals, places: 1, residents: 0 },
  shown: { ...SNAPSHOT.shown, places: 1, residents: 0 },
  pages: {
    ...SNAPSHOT.pages,
    places: { has_more: false, next_before_subplace_id: null },
    residents: { has_more: false, next_before_id: null },
  },
})

const API_REQUESTS = new WeakMap<Page, string[]>()

const OLDER_NOTE = Object.freeze({
  id: 20,
  place_id: 77,
  author: 'leafwalker',
  body: 'An older conversation remains readable.',
  created_at: '2026-08-13T12:01:00.000Z',
})

const OLDER_GLOBAL_NOTE = Object.freeze({
  id: 19,
  place_id: 12,
  author: 'leafwalker',
  body: 'An older conversation remains readable.',
  created_at: '2026-08-13T11:01:00.000Z',
})

const FAR_WALKER_NOTE = Object.freeze({
  id: 91,
  place_id: 77,
  author: 'far-walker',
  body: 'Far Walker speaks from the quiet annex.',
  created_at: '2026-08-15T12:01:00.000Z',
})

const OLDER_FAR_WALKER_NOTE = Object.freeze({
  id: 82,
  place_id: 12,
  author: 'far-walker',
  body: 'Far Walker spoke here earlier.',
  created_at: '2026-08-12T12:01:00.000Z',
})

const FAR_WALKER_ROOM_CONTEXT = Object.freeze({
  id: 90,
  place_id: 77,
  author: 'mapkeeper',
  body: 'A neighboring voice supplies room context.',
  created_at: '2026-08-15T12:00:00.000Z',
})

const OLDER_THING = Object.freeze({
  id: 30,
  place_id: 77,
  name: 'old_bench',
  body: 'An older object remains visible.',
  owner: 'leafwalker',
  kind: null,
  traits: [],
  created_at: '2026-08-13T12:02:00.000Z',
})

const OLDER_AGREEMENT = Object.freeze({
  id: 40,
  body: 'An older promise remains public.',
  created_by: 'leafwalker',
  parties: ['leafwalker'],
  signatures: ['leafwalker'],
  open: false,
  created_at: '2026-08-13T12:03:00.000Z',
})

const OLDER_EVENT = Object.freeze({
  id: 50,
  at: '2026-08-13T12:03:30.000Z',
  kind: 'thing_created',
  actor: 'leafwalker',
  detail: { place_id: 11, thing_id: 30 },
})

test.beforeEach(async ({ page }, testInfo) => {
  API_REQUESTS.set(page, [])
  if (testInfo.title.includes('fully visible long note')) {
    await page.setViewportSize({ width: 1080, height: 1000 })
  }
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/')) API_REQUESTS.get(page)?.push(url.toString())
  })
  await page.goto('/__e2e/health')
  if (testInfo.title.includes('cold deep link') || testInfo.title.includes('focused selection retry')) {
    await page.evaluate(() => { window.location.hash = '#view=place&place=77' })
  }
  if (testInfo.title.includes('missing directory selection')) {
    await page.evaluate(() => { window.location.hash = '#view=place&place=999' })
  }
  let directoryAttempts = 0
  await page.route('**/api/window**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('view') === 'directory') {
      directoryAttempts += 1
      if (testInfo.title.includes('cold deep link')) {
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      if (testInfo.title.includes('directory failure') && directoryAttempts === 1) {
        return route.fulfill({ status: 503, json: { error: 'test directory failure' } })
      }
      return route.fulfill({ json: DIRECTORY })
    }
    const collection = url.searchParams.get('collection')
    if (!collection) {
      const snapshot = testInfo.title.includes('focused resident completes presence')
        ? { ...SNAPSHOT, totals: { ...SNAPSHOT.totals, residents: 2 } }
        : SNAPSHOT
      return route.fulfill({ json: snapshot })
    }
    if (collection === 'notes') {
      const note = url.searchParams.has('within_place_id') ? OLDER_NOTE : OLDER_GLOBAL_NOTE
      return route.fulfill({
        json: {
          notes: [note], has_more: false, next_before_id: null, change_marker: '20',
        },
      })
    }
    if (collection === 'things') {
      return route.fulfill({
        json: {
          things: [OLDER_THING], has_more: false, next_before_id: null, change_marker: '20',
        },
      })
    }
    return route.fulfill({
      json: {
        agreements: [OLDER_AGREEMENT], has_more: false, next_before_id: null,
        change_marker: '20',
      },
    })
  })
  let focusedPlaceAttempts = 0
  await page.route('**/api/map**', route => {
    const url = new URL(route.request().url())
    const changeMarker = url.searchParams.get('after_change_marker') ?? '20'
    if (url.searchParams.get('parent_id') === '998') {
      return route.fulfill({ status: 503, json: { error: 'test focused place failure' } })
    }
    if (url.searchParams.get('parent_id') === '77') {
      focusedPlaceAttempts += 1
      if (testInfo.title.includes('focused selection retry') && focusedPlaceAttempts === 1) {
        return route.fulfill({ status: 503, json: { error: 'test focused place failure' } })
      }
      if (testInfo.title.includes('focused name source')) {
        return route.fulfill({
          json: {
            ...FOCUSED_PLACE,
            place: { ...FOCUSED_PLACE.place, name: 'focus_fresh_annex' },
          },
        })
      }
      return route.fulfill({ json: FOCUSED_PLACE })
    }
    if (url.searchParams.get('parent_id') !== '12') {
      return route.fulfill({
        status: 404,
        json: { error: 'unknown test branch', change_marker: changeMarker },
      })
    }
    return route.fulfill({
      json: url.searchParams.get('before_subplace_id') === '14'
        ? SECOND_BRANCH_PAGE
        : FIRST_BRANCH_PAGE,
    })
  })
  await page.route('**/api/residents**', route => {
    const url = new URL(route.request().url())
    const changeMarker = url.searchParams.get('after_change_marker') ?? '20'
    if (url.searchParams.get('handle') === 'missing-reader') {
      return route.fulfill({
        status: 404,
        json: { error: 'unknown resident', change_marker: changeMarker },
      })
    }
    if (url.searchParams.get('handle') === 'failing-reader') {
      return route.fulfill({ status: 503, json: { error: 'test focused resident failure' } })
    }
    if (url.searchParams.get('handle') === 'far-walker') {
      return route.fulfill({ json: { ...FOCUSED_RESIDENT, change_marker: changeMarker } })
    }
    return route.fulfill({ json: { ...RESIDENT_PAGE, change_marker: changeMarker } })
  })
  await page.route('**/api/events**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('before_id') === '51') {
      return route.fulfill({
        json: {
          events: [OLDER_EVENT], has_more: false, next_before_id: null, change_marker: '20',
        },
      })
    }
    return route.fulfill({
      json: {
        events: SNAPSHOT.events, has_more: true, next_before_id: 51, change_marker: '20',
      },
    })
  })

  const htmlWithoutAutomaticClient = WINDOW_HTML.replace(
    /\s*<script src="\/window\.js" defer><\/script>/,
    '',
  )
  await page.setContent(htmlWithoutAutomaticClient)
  await page.addStyleTag({ content: WINDOW_CSS })
  await page.addScriptTag({ content: WINDOW_JS })
  await expect(page.getByRole('status')).toContainText('Watching')
})

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
  await expect(page.getByRole('status')).toContainText('Watching')
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
})

test('selected Place labels and preserves owner-chosen body-free front matter without reading things', async ({ page }) => {
  expect(SNAPSHOT.places[0].front_matter.every(heading => !Object.hasOwn(heading, 'body'))).toBe(true)
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
  await expect(readLinks.nth(0)).toHaveAttribute('href', '/api/thing/33')
  await expect(readLinks.nth(1)).toContainText('room_compass')
  await expect(readLinks.nth(1)).toHaveAttribute('href', '/api/thing/32')
  expect(await readLinks.evaluateAll(links => links.map(link => link.getAttribute('href')))).toEqual([
    '/api/thing/33',
    '/api/thing/32',
  ])

  const automaticThingReads = (API_REQUESTS.get(page) ?? []).filter(value => {
    return /^\/api\/thing(?:\/|$)/u.test(new URL(value).pathname)
  })
  expect(automaticThingReads).toEqual([])
})

test('bounded note and thing excerpts offer completion while agreements remain collapsible', async ({ page }) => {

  await page.getByRole('tab', { name: 'Place' }).click()

  const thingCard = page.locator('.thing-card').filter({ hasText: 'record_lantern' })
  await expect(thingCard).toContainText('open to shared use')
  const thingBody = thingCard.locator('.thing-body')
  const thingToggle = thingCard.getByRole('button', { name: 'Show more' })
  await expect(thingBody).toHaveAttribute('data-expanded', 'false')
  await expect(thingToggle).toHaveAttribute('aria-controls', await thingBody.getAttribute('id') ?? '')
  await thingToggle.click()
  await expect(thingBody).toHaveAttribute('data-expanded', 'true')
  await expect(thingCard.getByRole('button', { name: 'Read the whole thing' })).toBeVisible()

  const placeNote = page.locator('#place-conversation .note-card')
    .filter({ hasText: 'Opening note.' })
  await expect(placeNote).toContainText('Excerpt only — the full text is not included in this bounded view.')
  await placeNote.getByRole('button', { name: 'Show more' }).click()
  await expect(placeNote.locator('.note-body')).toHaveAttribute('data-expanded', 'true')

  await page.getByRole('tab', { name: 'Conversations' }).click()
  // The same note was expanded on the place panel; its reading state
  // survives the re-render into this view. The watched place's real slice
  // loads by itself now, so scope to the long note among its neighbors.
  const conversationNote = page.locator('#conversation-stream .note-card')
    .filter({ hasText: 'Opening note.' })
  await expect(conversationNote.locator('.note-body')).toHaveAttribute('data-expanded', 'true')
  await expect(conversationNote.getByRole('button', { name: 'Read the whole note' })).toBeVisible()

  await page.getByRole('tab', { name: 'Agreements' }).click()
  const agreement = page.locator('.agreement-card')
  await expect(agreement).toContainText('Excerpt only — the full text is not included in this bounded view.')
  await agreement.getByRole('button', { name: 'Show more' }).click()
  await expect(agreement.locator('.agreement-body')).toHaveAttribute('data-expanded', 'true')
  await agreement.getByRole('button', { name: 'Show less' }).click()
  await expect(agreement.locator('.agreement-body')).toHaveAttribute('data-expanded', 'false')
  await expect(agreement.getByRole('button', { name: /Read the whole agreement/u })).toHaveCount(0)
})

test('the second note expansion completes the bounded excerpt in place', async ({ page }) => {
  const completeNote = `${LONG_NOTE} Complete note remainder marker.`
  let releaseFailedRead!: () => void
  const heldFailedRead = new Promise<void>(resolve => { releaseFailedRead = resolve })
  let detailAttempts = 0
  await page.route('**/api/note/21', async route => {
    detailAttempts += 1
    if (detailAttempts === 1) {
      await heldFailedRead
      return route.fulfill({ status: 503, json: { error: 'test complete note failure' } })
    }
    return route.fulfill({ json: { note: { id: 21, body: completeNote } } })
  })

  await page.getByRole('tab', { name: 'Place' }).click()
  const noteCard = page.locator('#place-conversation .note-card')
    .filter({ hasText: 'Opening note.' })
  await noteCard.getByRole('button', { name: 'Show more' }).click()
  await expect(noteCard.getByRole('button', { name: 'Read the whole note' })).toBeVisible()

  const failedDetail = page.waitForResponse(response => {
    return new URL(response.url()).pathname === '/api/note/21' && response.status() === 503
  })
  await noteCard.getByRole('button', { name: 'Read the whole note' }).click()
  await expect(noteCard).toContainText('Loading the complete public note…')
  releaseFailedRead()
  await failedDetail
  await expect(noteCard).toContainText('The complete public note could not be read.')

  const successfulDetail = page.waitForResponse(response => {
    return new URL(response.url()).pathname === '/api/note/21' && response.status() === 200
  })
  await noteCard.getByRole('button', { name: 'Retry reading the whole note' }).click()
  await successfulDetail

  await expect(noteCard.locator('.note-body')).toHaveText(completeNote)
  await expect(noteCard).not.toContainText(/Excerpt only/u)
  expect((API_REQUESTS.get(page) ?? []).filter(value => {
    return new URL(value).pathname === '/api/note/21'
  })).toHaveLength(2)

  await page.getByRole('tab', { name: 'Conversations' }).click()
  const repeatedNote = page.locator('#conversation-stream .note-card')
    .filter({ hasText: 'Opening note.' })
  await expect(repeatedNote.locator('.note-body')).toHaveText(completeNote)
  expect((API_REQUESTS.get(page) ?? []).filter(value => {
    return new URL(value).pathname === '/api/note/21'
  })).toHaveLength(2)
})

test('the second thing expansion completes the bounded excerpt in place', async ({ page }) => {
  const completeThing = `${LONG_THING} Complete thing remainder marker.`
  await page.route('**/api/thing/31', route => route.fulfill({
    json: { thing: { id: 31, body: completeThing } },
  }))

  await page.getByRole('tab', { name: 'Place' }).click()
  const thingCard = page.locator('#place-things .thing-card').filter({ hasText: 'record_lantern' })
  await thingCard.getByRole('button', { name: 'Show more' }).click()
  await expect(thingCard.getByRole('button', { name: 'Read the whole thing' })).toBeVisible()

  const detailRequest = page.waitForRequest(request => {
    return new URL(request.url()).pathname === '/api/thing/31'
  })
  await thingCard.getByRole('button', { name: 'Read the whole thing' }).click()
  await detailRequest

  await expect(thingCard.locator('.thing-body')).toHaveText(completeThing)
  await expect(thingCard).not.toContainText(/Excerpt only/u)
  expect((API_REQUESTS.get(page) ?? []).filter(value => {
    return new URL(value).pathname === '/api/thing/31'
  })).toHaveLength(1)
})

test('a fully visible long note does not offer a useless Show more button', async ({ page }) => {
  await page.getByRole('tab', { name: 'Conversations' }).click()

  const doctorsNote = page.locator('#conversation-stream .note-card')
    .filter({ hasText: 'Doctors Note — Dr. Glass Pacific Hospital' })
  const body = doctorsNote.locator('.note-body')

  await expect(body).toBeVisible()
  expect(await body.evaluate(element => element.scrollHeight > element.clientHeight + 1)).toBe(false)
  await expect(doctorsNote.getByRole('button', { name: /Show (?:more|less)/u })).toHaveCount(0)
  await expect(body).toHaveAttribute('data-expanded', 'true')

  await page.setViewportSize({ width: 390, height: 851 })
  await expect(doctorsNote.getByRole('button', { name: 'Show more' })).toBeVisible()
  await expect(body).toHaveAttribute('data-expanded', 'false')
  expect(await body.evaluate(element => element.scrollHeight > element.clientHeight + 1)).toBe(true)
})

test('outline snapshot loads, pages, deduplicates, and preserves one map branch', async ({ page }) => {
  const initialRequest = API_REQUESTS.get(page)?.map(value => new URL(value)).find(url => {
    return url.pathname === '/api/window' && url.searchParams.get('view') === 'outline' &&
      !url.searchParams.has('collection')
  })
  expect(initialRequest?.searchParams.get('view')).toBe('outline')
  expect([...initialRequest?.searchParams.keys() ?? []]).toEqual(['view'])

  const scope = page.locator('#view-scope')
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
  await expect(page).toHaveURL(/#view=place&place=13$/)
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
  await expect(page.locator('#view-scope')).toContainText(/currently loaded 2 of 5 places/i)

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
  await expect(page.getByRole('tab', { name: 'Place' })).toBeFocused()
  await expect(page.getByRole('tab', { name: 'Place' })).toHaveAttribute('aria-selected', 'true')
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
    name: 'Search places and residents', exact: true,
  })).toBeVisible()
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
  const resultsBox = await results.boundingBox()
  expect(resultsBox?.y ?? 0).toBeGreaterThanOrEqual((searchBox?.y ?? 0) + (searchBox?.height ?? 0))
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
  await expect.soft(page.locator('#view-scope')).toContainText('currently loaded 3 of 5 places')
  await expect.soft(page.locator('#view-scope')).toContainText('currently loaded 2 of 3 residents')
  const requests = (API_REQUESTS.get(page) ?? []).map(value => new URL(value))
  expect(requests.filter(url =>
    url.pathname === '/api/residents' && url.searchParams.get('handle') === 'far-walker'))
    .toHaveLength(1)
  expect(requests.filter(url =>
    url.pathname === '/api/map' && url.searchParams.get('parent_id') === '77'))
    .toHaveLength(1)
})

for (const environment of WINDOW_BEHAVIOR_MATRIX) {
  test(`all four observation fixes hold in the window behavior matrix: ${environment.name}`, async ({ page }) => {
    await page.setViewportSize({ width: environment.width, height: environment.height })
    await page.emulateMedia({ colorScheme: environment.colorScheme })

    let releaseAgreements!: () => void
    const heldAgreements = new Promise<void>(resolve => { releaseAgreements = resolve })
    let agreementAttempts = 0
    await page.route('**/api/window**', async route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('collection') !== 'agreements' ||
          url.searchParams.get('resident') !== 'far-walker') {
        return route.fallback()
      }
      agreementAttempts += 1
      if (agreementAttempts === 1) {
        await heldAgreements
        return route.fulfill({ status: 503, json: { error: 'matrix agreement failure' } })
      }
      return route.fulfill({
        json: { agreements: [], has_more: false, next_before_id: null, change_marker: '20' },
      })
    })
    await page.route('**/api/events**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('actor') !== 'far-walker') return route.fallback()
      return route.fulfill({
        json: {
          events: FAR_WALKER_ACTION_EVENTS,
          has_more: false,
          next_before_id: null,
          change_marker: '20',
        },
      })
    })
    const completeNote = `${LONG_NOTE} Matrix complete note remainder.`
    await page.route('**/api/note/21', route => route.fulfill({
      json: { note: { id: 21, body: completeNote } },
    }))

    await page.locator('#resident-filter').selectOption('far-walker')
    const quietAnnex = page.locator('.place-card').filter({
      has: page.getByRole('button', { name: 'quiet_annex', exact: true }),
    })
    await expect(quietAnnex).toBeVisible()
    const shownResidents = quietAnnex.locator('.occupant-chip')
    await expect(shownResidents).toHaveCount(1)
    await expect(shownResidents).toContainText('far-walker')
    const quietAnnexFacts = quietAnnex.locator('.place-facts')
    await expect.soft(quietAnnexFacts).toContainText(/\b0 places inside\b/u)
    await expect.soft(quietAnnexFacts).toContainText(/\b1 resident shown inside\b/u)

    await page.getByRole('tab', { name: 'Happenings' }).click()
    const activity = page.locator('#activity-list')
    await expect(activity).toContainText(/far-walker.*\buse(?:d)?\b.*(?:3\s+times|×\s*3)/i)
    await expect(activity).toContainText(
      /far-walker.*\bmove(?:d)?\b.*from .*inner_hall.*to .*quiet_annex/i,
    )
    await expect(activity.locator('.activity-row')).toHaveCount(6)

    const agreementRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/window' && url.searchParams.get('collection') === 'agreements' &&
        url.searchParams.get('resident') === 'far-walker'
    })
    await page.getByRole('tab', { name: 'Agreements' }).click()
    await agreementRequest
    await expect(page.locator('#agreement-list')).toHaveText(
      'Fetching agreements that match this resident…',
    )
    releaseAgreements()
    await expect(page.locator('#agreement-list')).toHaveText(
      'Agreements could not be loaded. Retry below.',
    )
    const agreementRetry = page.getByRole('button', {
      name: 'Retry loading agreements', exact: true,
    })
    await agreementRetry.click()
    await expect(page.locator('#agreement-list')).toHaveText(
      'No public agreement matches this resident selection.',
    )

    await page.locator('#resident-filter').selectOption('')
    await page.locator('#place-filter').selectOption('11')
    await page.getByRole('tab', { name: 'Place' }).click()
    const note = page.locator('#place-conversation .note-card').filter({ hasText: 'Opening note.' })
    await note.getByRole('button', { name: 'Show more' }).click()
    await expect(note.getByRole('button', { name: 'Read the whole note' })).toBeVisible()
    await note.getByRole('button', { name: 'Read the whole note' }).click()
    await expect(note).toContainText('Matrix complete note remainder.')

    expect(await page.evaluate(() => (
      document.documentElement.scrollWidth <= window.innerWidth
    ))).toBe(true)
  })
}

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
  const focusedRead = (API_REQUESTS.get(page) ?? []).map(value => new URL(value)).find(url => {
    return url.pathname === '/api/map' && url.searchParams.get('parent_id') === '77'
  })
  expect(focusedRead?.searchParams.get('after_change_marker')).toBe('20')
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
    'No places or residents match this search.',
  )
})

test('scope forgets an older focused place when a new focused place becomes active', async ({ page }) => {
  await page.locator('#place-filter').selectOption('77')
  await expect(page.locator('#view-scope')).toContainText('currently loaded 3 of 5 places')

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
  await expect(page.locator('#view-scope')).toContainText('currently loaded 3 of 5 places')
  await expect(page.locator('#view-scope')).not.toContainText('currently loaded 4 of 5 places')
})

test('explicit place scope excludes the followed resident previous focused place', async ({ page }) => {
  const residentFocus = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/residents' && url.searchParams.get('handle') === 'far-walker' &&
      response.status() === 200
  })
  await page.locator('#resident-filter').selectOption('far-walker')
  await residentFocus
  await expect(page.locator('#view-scope')).toContainText('currently loaded 3 of 5 places')

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
  await expect(page.locator('#view-scope')).toContainText('currently loaded 3 of 5 places')
  await expect(page.locator('#view-scope')).not.toContainText('currently loaded 4 of 5 places')
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
  await expect(page.locator('#view-scope')).toContainText('Showing 1 fetched note')
  await expect(page.locator('#view-scope')).not.toContainText(/\b\d+ of 3 conversations\b/)
})

test('a focused resident completes presence without a false bounded warning', async ({ page }) => {
  await page.locator('#resident-filter').selectOption('far-walker')
  await page.getByRole('tab', { name: 'Place' }).click()
  const occupants = page.locator('#place-occupants')
  await expect(occupants).toContainText('far-walker')
  await expect(occupants).not.toContainText('Other occupants may be omitted')
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

test('resident presence pages load once, deduplicate, and keep honest roster scope', async ({ page }) => {
  const loadResidents = page.getByRole('button', { name: 'Load more residents' })
  await expect(loadResidents).toHaveAttribute('aria-busy', 'false')
  await expect(loadResidents).toHaveAttribute('aria-controls', 'resident-roster')

  const residentRequest = page.waitForRequest(request => {
    return new URL(request.url()).pathname === '/api/residents'
  })
  await loadResidents.focus()
  await loadResidents.click()
  const residentUrl = new URL((await residentRequest).url())
  expect(Object.fromEntries(residentUrl.searchParams)).toEqual({
    view: 'presence',
    limit: '25',
    before_id: '7',
    after_change_marker: '20',
  })

  const roster = page.locator('#resident-roster')
  await expect(roster.getByRole('button', { name: 'leafwalker', exact: true })).toHaveCount(1)
  await expect(roster.getByRole('button', { name: 'nightwatcher', exact: true })).toBeVisible()
  await expect(roster.locator('.resident-row.asleep')).toContainText('nightwatcher')
  await expect(roster.getByRole('button', { name: 'wayfarer', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Load more residents' })).toHaveCount(0)
  await expect(page.locator('#view-scope')).not.toContainText(/loaded 1 of 3 residents/i)

  const residentOptions = await page.locator('#resident-filter option').allTextContents()
  expect(residentOptions).toEqual([
    'All residents',
    'leafwalker · Resident #7',
    'far-walker · Resident #9',
  ])
  await expect(roster.getByRole('button', { name: 'leafwalker', exact: true })).toBeFocused()
})

test('a failed branch page exposes an accessible retry that succeeds in place', async ({ page }) => {
  await page.unroute('**/api/map**')
  let attempts = 0
  await page.route('**/api/map**', route => {
    attempts += 1
    return attempts === 1
      ? route.fulfill({ status: 503, json: { error: 'temporary test outage' } })
      : route.fulfill({ json: FIRST_BRANCH_PAGE })
  })

  const initialBranchLoad = page.getByRole('button', { name: 'Show places inside inner_hall' })
  await expect(initialBranchLoad).toBeVisible()
  await initialBranchLoad.click()
  const branchAlert = page.locator('#place-children-12').getByRole('alert')
  await expect(branchAlert).toContainText(/could not load places inside inner_hall/i)

  const retry = page.getByRole('button', { name: 'Retry loading places inside inner_hall' })
  await expect(retry).toHaveAttribute('aria-busy', 'false')
  await expect(retry).toHaveAttribute('aria-controls', 'place-children-12')
  const retryResponse = page.waitForResponse(response => {
    return new URL(response.url()).pathname === '/api/map' && response.status() === 200
  })
  await retry.click()
  await retryResponse
  await expect(page.getByRole('button', { name: 'newest_gallery', exact: true })).toBeVisible()
  await expect(branchAlert).toHaveCount(0)
})

test('an empty presence page says what is empty and offers no dead load control', async ({ page }) => {
  await page.unroute('**/api/window**')
  await page.route('**/api/window**', route => route.fulfill({ json: EMPTY_RESIDENT_SNAPSHOT }))

  await page.goto('/window')
  await expect(page.locator('#window-status[role="status"]')).toContainText('Watching')
  const emptyRoster = page.locator('#resident-roster').getByRole('status')
  await expect(emptyRoster).toContainText(/no residents (?:are )?(?:loaded|shown|in the city)/i)
  await expect(page.getByRole('button', { name: 'Load more residents' })).toHaveCount(0)

  const rootCard = page.locator('.place-card').filter({
    has: page.getByRole('button', { name: 'root_plaza', exact: true }),
  })
  await expect(rootCard.locator('.place-disclosure')).toHaveCount(0)
})

test('residents at a confirmed missing address stay visible under an honest label', async ({ page }) => {
  await page.unroute('**/api/window**')
  await page.route('**/api/window**', route => route.fulfill({
    json: {
      ...SNAPSHOT,
      residents: [{ ...SNAPSHOT.residents[0], current_place_id: 999 }],
    },
  }))

  await page.goto('/window#view=map&place=999')
  const roster = page.locator('#resident-roster')
  await expect(roster.getByRole('button', { name: 'leafwalker', exact: true })).toBeVisible()
  await expect(roster).toContainText(/Place #999.*no public place was found/i)
  await expect(page.locator('#window-status')).toHaveAttribute('role', 'status')
})

test('confirmed missing selections differ from retryable focused-read failures', async ({ page }) => {
  await page.goto('/window#view=place&place=999')
  await expect(page.locator('#place-panel')).toContainText(/no public place was found/i)
  await expect(page.getByRole('button', { name: 'Retry loading this place' })).toHaveCount(0)
  await expect(page.locator('#place-panel')).not.toContainText(/could not be (?:loaded|read)/i)

  const requestsBeforePlaceConversation = API_REQUESTS.get(page)?.length ?? 0
  await page.goto('/window#view=conversations&place=999')
  await expect(page.locator('#conversations-panel')).toContainText(/no public place was found/i)
  const placeConversationRequests = (API_REQUESTS.get(page) ?? [])
    .slice(requestsBeforePlaceConversation)
    .map(value => new URL(value))
    .filter(url => url.searchParams.get('collection') === 'notes' &&
      url.searchParams.get('within_place_id') === '999')
  expect(placeConversationRequests).toHaveLength(0)

  await page.goto('/window#view=conversations&resident=missing-reader')
  await expect(page.locator('#conversations-panel')).toContainText(/no public resident was found/i)
  await expect(page.getByRole('button', { name: 'Retry loading this resident' })).toHaveCount(0)
  await expect(page.locator('#conversation-stream')).not.toContainText(/no conversation .*matches/i)

  await page.goto('/window#view=place&place=998')
  await expect(page.locator('#place-panel')).toContainText(/could not be (?:loaded|read)/i)
  await expect(page.getByRole('button', { name: 'Retry loading this place' })).toBeVisible()
  await expect(page.locator('#place-panel')).not.toContainText(/no public place was found/i)

  await page.goto('/window#view=conversations&resident=failing-reader')
  await expect(page.locator('#conversations-panel')).toContainText(/could not be (?:loaded|read)/i)
  await expect(page.getByRole('button', { name: 'Retry loading this resident' })).toBeVisible()
  await expect(page.locator('#conversation-stream')).not.toContainText(/no conversation .*matches/i)
  await expect(page.locator('#conversations-panel')).not.toContainText(/no public resident was found/i)
})

test('unchanged branch and resident cursors become retryable errors instead of loops', async ({ page }) => {
  await page.unroute('**/api/map**')
  await page.route('**/api/map**', route => {
    const url = new URL(route.request().url())
    return route.fulfill({
      json: url.searchParams.has('before_subplace_id')
        ? {
            ...SECOND_BRANCH_PAGE,
            subplaces_page: {
              ...SECOND_BRANCH_PAGE.subplaces_page,
              has_more: true,
              next_before_subplace_id: 14,
            },
          }
        : FIRST_BRANCH_PAGE,
    })
  })
  await page.unroute('**/api/residents**')
  await page.route('**/api/residents**', route => route.fulfill({
    json: {
      ...RESIDENT_PAGE,
      has_more: true,
      next_before_id: 7,
    },
  }))

  await page.getByRole('button', { name: 'Show places inside inner_hall' }).click()
  await page.getByRole('button', { name: 'Load more places inside inner_hall' }).click()
  await expect(page.getByRole('button', {
    name: 'Retry loading places inside inner_hall',
  })).toBeVisible()

  await page.getByRole('button', { name: 'Load more residents' }).click()
  await expect(page.getByRole('button', { name: 'Retry loading residents' })).toBeVisible()
})

test('refresh forward-reconciles multi-page bursts without gaps and refreshes branch facts', async ({ page }) => {
  await page.getByRole('button', { name: 'Show places inside inner_hall' }).click()
  await expect(page.getByRole('button', { name: 'newest_gallery', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Load more places inside inner_hall' }).click()
  await expect(page.getByRole('button', { name: 'older_cell', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Load more residents' }).click()
  await expect(page.getByRole('button', { name: 'nightwatcher', exact: true })).toBeVisible()

  let refreshed = false
  const refreshedSnapshot = {
    ...SNAPSHOT,
    residents: [{
      id: 2,
      handle: 'newcomer-two',
      current_place_id: 12,
      asleep: false,
      joined_at: '2026-08-16T12:00:00.000Z',
    }, {
      id: 100,
      handle: 'newcomer-hundred',
      current_place_id: 12,
      asleep: false,
      joined_at: '2026-08-15T12:00:00.000Z',
    }],
    totals: { ...SNAPSHOT.totals, residents: 6 },
    shown: { ...SNAPSHOT.shown, residents: 2 },
    pages: {
      ...SNAPSHOT.pages,
      residents: { has_more: true, next_before_id: 100 },
    },
  }
  await page.unroute('**/api/window**')
  await page.route('**/api/window**', route => {
    const url = new URL(route.request().url())
    if (!url.searchParams.has('collection')) {
      return route.fulfill({ json: refreshed ? refreshedSnapshot : SNAPSHOT })
    }
    return route.fulfill({
      json: { notes: [], has_more: false, next_before_id: null, change_marker: '20' },
    })
  })
  await page.unroute('**/api/map**')
  await page.route('**/api/map**', route => {
    const url = new URL(route.request().url())
    const before = url.searchParams.get('before_subplace_id')
    if (!refreshed) {
      return route.fulfill({ json: before === '14' ? SECOND_BRANCH_PAGE : FIRST_BRANCH_PAGE })
    }
    const parent = {
      ...FIRST_BRANCH_PAGE.place,
      places: 6,
      things: 4,
      notes: 2,
    }
    if (!before) {
      return route.fulfill({ json: {
        ...FIRST_BRANCH_PAGE,
        place: parent,
        subplaces: [{
          ...FIRST_BRANCH_PAGE.subplaces[0], id: 18, name: 'burst_eighteen',
        }, {
          ...FIRST_BRANCH_PAGE.subplaces[0], id: 17, name: 'burst_seventeen',
        }],
        subplaces_page: { ...FIRST_BRANCH_PAGE.subplaces_page, next_before_subplace_id: 17 },
      } })
    }
    return route.fulfill({ json: {
      ...FIRST_BRANCH_PAGE,
      place: parent,
      subplaces: [{
        ...FIRST_BRANCH_PAGE.subplaces[0], id: 16, name: 'burst_sixteen',
      }, FIRST_BRANCH_PAGE.subplaces[0]],
      subplaces_page: { ...FIRST_BRANCH_PAGE.subplaces_page, next_before_subplace_id: 15 },
    } })
  })
  await page.unroute('**/api/residents**')
  await page.route('**/api/residents**', route => {
    const url = new URL(route.request().url())
    const before = url.searchParams.get('before_id')
    const changeMarker = url.searchParams.get('after_change_marker') ?? '20'
    if (!refreshed) {
      return route.fulfill({ json: { ...RESIDENT_PAGE, change_marker: changeMarker } })
    }
    expect(before).toBe('100')
    return route.fulfill({ json: {
      change_marker: changeMarker,
      residents: [{
        id: 1,
        handle: 'newcomer-one',
        current_place_id: 12,
        asleep: false,
        joined_at: '2026-08-14T12:30:00.000Z',
      }, SNAPSHOT.residents[0]],
      total: 6,
      has_more: true,
      next_before_id: 7,
    } })
  })

  refreshed = true
  const branchContinuation = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/map' && url.searchParams.get('before_subplace_id') === '17'
  })
  const residentContinuation = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/residents' && url.searchParams.get('before_id') === '100'
  })
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await Promise.all([branchContinuation, residentContinuation])

  const branch = page.locator('#place-children-12')
  await expect(branch.getByRole('button', { name: 'burst_eighteen', exact: true })).toBeVisible()
  expect(await branch.locator('.place-name').allTextContents()).toEqual([
    'burst_eighteen',
    'burst_seventeen',
    'burst_sixteen',
    'newest_gallery',
    'shared_step',
    'older_cell',
  ])
  const branchCard = page.locator('.place-card').filter({
    has: page.getByRole('button', { name: 'inner_hall', exact: true }),
  })
  await expect(branchCard.locator('.place-facts')).toContainText(
    '6 places inside · 5 residents shown inside · 4 things · 2 notes',
  )

  expect(await page.locator('#resident-filter option').allTextContents()).toEqual([
    'All residents',
    'leafwalker · Resident #7',
    'far-walker · Resident #9',
  ])
})

test('a reconciliation budget exposes a contiguous continuation and stays stable next refresh', async ({ page }) => {
  await page.getByRole('button', { name: 'Show places inside inner_hall' }).click()
  await expect(page.getByRole('button', { name: 'newest_gallery', exact: true })).toBeVisible()
  await page.unroute('**/api/map**')
  let mapReads = 0
  await page.route('**/api/map**', route => {
    mapReads += 1
    const before = Number(new URL(route.request().url()).searchParams.get('before_subplace_id')) || null
    const newest = before ? before - 1 : 100
    const rows = [newest, newest - 1].map(id => ({
      ...FIRST_BRANCH_PAGE.subplaces[0],
      id,
      name: 'burst_' + String(id),
    }))
    return route.fulfill({ json: {
      ...FIRST_BRANCH_PAGE,
      place: { ...FIRST_BRANCH_PAGE.place, places: 100 },
      subplaces: rows,
      subplaces_page: {
        ...FIRST_BRANCH_PAGE.subplaces_page,
        total_items: 100,
        has_more: true,
        next_before_subplace_id: newest - 1,
      },
    } })
  })

  const refreshRequest = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/window' && url.searchParams.get('view') === 'outline'
  })
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await refreshRequest
  await expect(page.getByRole('button', { name: 'burst_100', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Load more places inside inner_hall' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'newest_gallery', exact: true })).toHaveCount(0)
  expect(mapReads).toBe(8)

  const secondRefresh = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/window' && url.searchParams.get('view') === 'outline'
  })
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await secondRefresh
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  }))
  expect(mapReads).toBe(8)
  await expect(page.getByRole('button', { name: 'newest_gallery', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Load more places inside inner_hall' })).toBeVisible()
})

test('a slower refresh cannot overwrite a manual resident page that finishes first', async ({ page }) => {
  await page.getByRole('button', { name: 'Show places inside inner_hall' }).click()

  await page.unroute('**/api/residents**')
  let releaseResidents: (() => void) | null = null
  await page.route('**/api/residents**', async route => {
    await new Promise<void>(resolve => {
      releaseResidents = () => {
        void route.fulfill({ json: RESIDENT_PAGE }).then(() => resolve())
      }
    })
  })
  await page.unroute('**/api/map**')
  let releaseBranch: (() => void) | null = null
  await page.route('**/api/map**', async route => {
    await new Promise<void>(resolve => {
      releaseBranch = () => {
        void route.fulfill({ json: FIRST_BRANCH_PAGE }).then(() => resolve())
      }
    })
  })

  const residentRequest = page.waitForRequest(request =>
    new URL(request.url()).pathname === '/api/residents')
  await page.getByRole('button', { name: 'Load more residents' }).click()
  await residentRequest

  const branchRefresh = page.waitForRequest(request =>
    new URL(request.url()).pathname === '/api/map')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await branchRefresh

  expect(releaseResidents).not.toBeNull()
  releaseResidents?.()
  await expect(page.getByRole('button', { name: 'nightwatcher', exact: true })).toBeVisible()
  expect(releaseBranch).not.toBeNull()
  releaseBranch?.()
  await expect(page.locator('#window-status')).toContainText('Watching')
  await expect(page.getByRole('button', { name: 'nightwatcher', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'wayfarer', exact: true })).toBeVisible()
})

test('an initial failed read names the failure and offers an immediate retry', async ({ page }) => {
  let releaseFirstRead!: () => void
  const heldFirstRead = new Promise<void>(resolve => { releaseFirstRead = resolve })
  let outlineAttempts = 0
  await page.route('**/api/window**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('view') !== 'outline' || url.searchParams.has('collection')) {
      return route.fallback()
    }
    outlineAttempts += 1
    if (outlineAttempts === 1) {
      await heldFirstRead
      return route.fulfill({ status: 503, json: { error: 'test initial window failure' } })
    }
    return route.fulfill({ json: SNAPSHOT })
  })

  const firstRead = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/window' && url.searchParams.get('view') === 'outline' &&
      !url.searchParams.has('collection')
  })
  await page.goto('/window')
  await firstRead
  await expect(page.locator('#window-status')).toContainText(/loading/i)
  releaseFirstRead()

  await expect(page.locator('#window-status')).toContainText(
    'The current public city view could not be read.',
  )
  await expect(page.locator('#city-counts')).toHaveText(
    'The current public city view could not be read.',
  )
  await expect(page.locator('#view-scope')).toHaveText(
    'The current public city view could not be read.',
  )
  const retry = page.getByRole('button', { name: /retry.*(?:public )?city view/i })
  await expect(retry).toBeVisible()

  const successfulRetry = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/window' && url.searchParams.get('view') === 'outline' &&
      !url.searchParams.has('collection') && response.status() === 200
  })
  await retry.click()
  await successfulRetry
  await expect(page.locator('#window-status')).toContainText('Watching')
})

test('action happenings keep their verb and movement and collapse only consecutive copies', async ({ page }) => {
  await page.route('**/api/events**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('actor') !== 'far-walker') return route.fallback()
    return route.fulfill({
      json: {
        events: FAR_WALKER_ACTION_EVENTS,
        has_more: false,
        next_before_id: null,
        change_marker: '20',
      },
    })
  })

  await page.locator('#resident-filter').selectOption('far-walker')
  const happeningsRequest = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/events' && url.searchParams.get('actor') === 'far-walker' &&
      response.status() === 200
  })
  await page.getByRole('tab', { name: 'Happenings' }).click()
  await happeningsRequest

  const activity = page.locator('#activity-list')
  await expect.soft(activity).toContainText(
    /far-walker.*\buse(?:d)?\b.*(?:3\s+times|×\s*3)/i,
  )
  await expect.soft(activity).toContainText(
    /far-walker.*\bmove(?:d)?\b.*from .*inner_hall.*to .*quiet_annex/i,
  )
  await expect.soft(activity).toContainText(
    /far-walker.*tried to move from .*inner_hall.*to .*quiet_annex.*blocked/i,
  )
  await expect.soft(activity).toContainText(
    /far-walker.*tried to go home from .*quiet_annex.*to .*root_plaza.*no change/i,
  )
  await expect.soft(activity).toContainText(/far-walker.*tried to use.*failed/i)
  await expect.soft(activity).not.toContainText('acted in the city')
  await expect.soft(activity.locator('.activity-row')).toHaveCount(6)
})

test('Decision 46 separates loading, retryable failure, and completed empty reads', async ({ page }) => {
  let releaseHappenings!: () => void
  const heldHappenings = new Promise<void>(resolve => { releaseHappenings = resolve })
  let happeningAttempts = 0
  await page.route('**/api/events**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('actor') !== 'far-walker') return route.fallback()
    happeningAttempts += 1
    if (happeningAttempts === 1) {
      await heldHappenings
      return route.fulfill({ status: 503, json: { error: 'test filtered happenings failure' } })
    }
    return route.fulfill({
      json: { events: [], has_more: false, next_before_id: null, change_marker: '20' },
    })
  })

  let releaseAgreements!: () => void
  const heldAgreements = new Promise<void>(resolve => { releaseAgreements = resolve })
  let agreementAttempts = 0
  await page.route('**/api/window**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('collection') !== 'agreements' ||
        url.searchParams.get('resident') !== 'far-walker') {
      return route.fallback()
    }
    agreementAttempts += 1
    if (agreementAttempts === 1) {
      await heldAgreements
      return route.fulfill({ status: 503, json: { error: 'test filtered agreements failure' } })
    }
    return route.fulfill({
      json: { agreements: [], has_more: false, next_before_id: null, change_marker: '20' },
    })
  })

  await page.locator('#resident-filter').selectOption('far-walker')

  const happeningRequest = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/events' && url.searchParams.get('actor') === 'far-walker'
  }, { timeout: 5_000 })
  await page.getByRole('tab', { name: 'Happenings' }).click()
  await happeningRequest
  await expect(page.locator('#activity-list')).toHaveText('Fetching happenings that match this view…')
  releaseHappenings()

  const happeningsPanel = page.locator('#happenings-panel')
  await expect(page.locator('#activity-list')).toHaveText('Happenings could not be loaded. Retry below.')
  await expect(page.locator('#activity-list')).not.toContainText(/no happening .*matches/i)
  const happeningsRetry = happeningsPanel.getByRole('button', {
    name: 'Retry loading happenings', exact: true,
  })
  await expect(happeningsRetry).toBeVisible()
  const successfulHappenings = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/events' && url.searchParams.get('actor') === 'far-walker' &&
      response.status() === 200
  }, { timeout: 5_000 })
  await happeningsRetry.click()
  await successfulHappenings
  await expect(page.locator('#activity-list')).toHaveText('No public happening matches this selection.')
  await expect(page.locator('#activity-list')).not.toContainText(/bounded|currently loaded|may be omitted/i)

  const agreementRequest = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/window' && url.searchParams.get('collection') === 'agreements' &&
      url.searchParams.get('resident') === 'far-walker'
  }, { timeout: 5_000 })
  await page.getByRole('tab', { name: 'Agreements' }).click()
  await agreementRequest
  await expect(page.locator('#agreement-list')).toHaveText('Fetching agreements that match this resident…')
  releaseAgreements()

  const agreementsPanel = page.locator('#agreements-panel')
  await expect(page.locator('#agreement-list')).toHaveText('Agreements could not be loaded. Retry below.')
  await expect(page.locator('#agreement-list')).not.toContainText(/no agreement .*matches/i)
  const agreementsRetry = agreementsPanel.getByRole('button', {
    name: 'Retry loading agreements', exact: true,
  })
  await expect(agreementsRetry).toBeVisible()
  const successfulAgreements = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/window' && url.searchParams.get('collection') === 'agreements' &&
      url.searchParams.get('resident') === 'far-walker' && response.status() === 200
  }, { timeout: 5_000 })
  await agreementsRetry.click()
  await successfulAgreements
  await expect(page.locator('#agreement-list')).toHaveText(
    'No public agreement matches this resident selection.',
  )
  await expect(page.locator('#agreement-list')).not.toContainText(/bounded|currently loaded|may be omitted/i)
})

test('conversation scope names loading, failure, and completed empty without inventing zero', async ({ page }) => {
  let releaseConversation!: () => void
  const heldConversation = new Promise<void>(resolve => { releaseConversation = resolve })
  let attempts = 0
  await page.route('**/api/window**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('collection') !== 'notes' ||
        url.searchParams.get('resident') !== 'far-walker') {
      return route.fallback()
    }
    attempts += 1
    if (attempts === 1) {
      await heldConversation
      return route.fulfill({ status: 503, json: { error: 'test conversation failure' } })
    }
    return route.fulfill({
      json: { notes: [], has_more: false, next_before_id: null, change_marker: '20' },
    })
  })

  await page.locator('#resident-filter').selectOption('far-walker')
  await page.getByRole('tab', { name: 'Conversations' }).click()
  const scope = page.locator('#view-scope')
  await expect(scope).toContainText('Loading that public read.')
  await expect(scope).not.toContainText('Showing 0 fetched notes')
  await expect(scope).not.toContainText('0 of 3 conversations')
  releaseConversation()
  await expect(scope).toContainText('That public read failed')
  await expect(scope).not.toContainText('Showing 0 fetched notes')
  await expect(scope).not.toContainText('0 of 3 conversations')

  const successfulRetry = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/window' && url.searchParams.get('collection') === 'notes' &&
      url.searchParams.get('resident') === 'far-walker' && response.status() === 200
  })
  await page.getByRole('button', { name: 'Retry loading conversations', exact: true }).click()
  await successfulRetry
  await expect(scope).toContainText('Nothing was found.')
  await expect(scope).not.toContainText(
    /Nothing was found[^.]{0,80}(?:bounded|currently loaded)|Showing 0 fetched notes/i,
  )
  await expect(scope).not.toContainText('0 of 3 conversations')
})

test('a history page newer than its neighboring totals fails instead of mixing markers', async ({ page }) => {
  let releaseChangeCheck!: () => void
  const heldChangeCheck = new Promise<void>(resolve => { releaseChangeCheck = resolve })
  await page.route('**/api/changes**', async route => {
    await heldChangeCheck
    return route.fulfill({
      json: {
        change_marker: '20', changes: [], returned_items: 0,
        unchanged: true, has_more: false, next_since: '20',
      },
    })
  })
  await page.route('**/api/window**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('collection') !== 'notes' ||
        url.searchParams.get('resident') !== 'leafwalker') {
      return route.fallback()
    }
    return route.fulfill({
      json: {
        notes: [{
          id: 903,
          place_id: 12,
          author: 'leafwalker',
          body: 'This marker-21 note must not neighbor marker-20 totals.',
          created_at: '2026-08-16T10:03:00.000Z',
        }],
        has_more: false,
        next_before_id: null,
        change_marker: '21',
      },
    })
  })

  const historyResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/window' && url.searchParams.get('collection') === 'notes' &&
      url.searchParams.get('resident') === 'leafwalker' && response.status() === 200
  })
  await page.locator('#resident-filter').selectOption('leafwalker')
  await page.getByRole('tab', { name: 'Conversations' }).click()
  await historyResponse

  const stream = page.locator('#conversation-stream')
  await expect(stream).toHaveText('Conversation could not be loaded. Retry below.')
  await expect(stream).not.toContainText('This marker-21 note')
  await expect(page.getByRole('button', {
    name: 'Retry loading conversations', exact: true,
  })).toBeVisible()
  releaseChangeCheck()
})

test('a filtered forward refresh newer than its neighboring totals keeps the completed rows', async ({ page }) => {
  let phase: 'initial' | 'ahead' = 'initial'
  await page.route('**/api/events**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('actor') !== 'far-walker') return route.fallback()
    return route.fulfill({
      json: {
        events: phase === 'initial'
          ? [FAR_WALKER_ACTION_EVENTS[0]]
          : FAR_WALKER_ACTION_EVENTS.slice(0, 2),
        has_more: false,
        next_before_id: null,
        change_marker: phase === 'initial' ? '20' : '21',
      },
    })
  })
  await page.route('**/api/changes**', route => route.fulfill({
    status: 503,
    json: { error: 'test change check unavailable' },
  }))

  await page.locator('#resident-filter').selectOption('far-walker')
  await page.getByRole('tab', { name: 'Happenings' }).click()
  await expect(page.locator('#activity-list')).toContainText('far-walker used')

  phase = 'ahead'
  const aheadResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/events' && url.searchParams.get('actor') === 'far-walker' &&
      url.searchParams.get('after_change_marker') === '20' && response.status() === 200
  })
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await aheadResponse

  await expect(page.locator('#happenings-page')).toContainText(
    'Updated happenings could not be loaded. Showing the previous completed results.',
  )
  await expect(page.locator('#activity-list')).not.toContainText('2 times')
  await expect(page.getByRole('button', { name: 'Retry refreshing happenings' })).toBeVisible()
})

test('a filtered refresh names loading and failure, preserves rows, and retries itself', async ({ page }) => {
  let phase: 'initial' | 'refresh' = 'initial'
  let refreshAttempts = 0
  let releaseRefresh!: () => void
  const heldRefresh = new Promise<void>(resolve => { releaseRefresh = resolve })
  await page.route('**/api/events**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('actor') !== 'far-walker') return route.fallback()
    if (phase === 'initial') {
      return route.fulfill({
        json: {
          events: [FAR_WALKER_ACTION_EVENTS[0]], has_more: false,
          next_before_id: null, change_marker: '20',
        },
      })
    }
    refreshAttempts += 1
    if (refreshAttempts === 1) {
      await heldRefresh
      return route.fulfill({ status: 503, json: { error: 'test forward refresh failure' } })
    }
    return route.fulfill({
      json: {
        events: FAR_WALKER_ACTION_EVENTS.slice(0, 2), has_more: false,
        next_before_id: null, change_marker: '20',
      },
    })
  })
  await page.route('**/api/changes**', route => route.fulfill({
    status: 503,
    json: { error: 'test change check unavailable' },
  }))

  await page.locator('#resident-filter').selectOption('far-walker')
  await page.getByRole('tab', { name: 'Happenings' }).click()
  await expect(page.locator('#activity-list')).toContainText('far-walker')
  phase = 'refresh'
  const refreshRequest = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/events' && url.searchParams.get('actor') === 'far-walker' &&
      url.searchParams.get('after_change_marker') === '20'
  })
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await refreshRequest
  await expect(page.locator('#happenings-page')).toContainText('Loading updated happenings…')
  await expect(page.locator('#activity-list')).toContainText('far-walker')
  releaseRefresh()
  await expect(page.locator('#happenings-page')).toContainText(
    'Updated happenings could not be loaded. Showing the previous completed results.',
  )
  const retry = page.getByRole('button', { name: 'Retry refreshing happenings' })
  await expect(retry).toBeVisible()
  const success = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/events' && url.searchParams.get('actor') === 'far-walker' &&
      response.status() === 200
  })
  await retry.click()
  await success
  await expect(page.locator('#happenings-page')).not.toContainText('could not be loaded')
})

test('recent window slices can be extended independently in every public view', async ({ page }) => {
  await page.getByRole('tab', { name: 'Conversations' }).click()
  const olderConversationRequest = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/window' && url.searchParams.get('collection') === 'notes' &&
      url.searchParams.get('before_id') === '21' && !url.searchParams.has('within_place_id')
  })
  await page.getByRole('button', { name: 'Load older conversations' }).click()
  await olderConversationRequest
  await expect(page.locator('#conversation-stream')).toContainText('An older conversation remains readable.')
  await expect(page.getByRole('button', { name: 'Load older conversations' })).toHaveCount(0)

  const insideThingRequest = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/window' && url.searchParams.get('collection') === 'things' &&
      url.searchParams.get('within_place_id') === '11' && !url.searchParams.has('before_id')
  })
  const insideNoteRequest = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/window' && url.searchParams.get('collection') === 'notes' &&
      url.searchParams.get('within_place_id') === '11' && !url.searchParams.has('before_id')
  })
  await page.getByRole('tab', { name: 'Place' }).click()
  await Promise.all([insideThingRequest, insideNoteRequest])
  await expect(page.locator('#place-things')).toContainText('old_bench')
  await expect(page.locator('#place-conversation')).toContainText('An older conversation remains readable.')

  // The place chosen on the Place tab is still watched, so Happenings
  // fetches its place-filtered slice from the server on its own.
  const filteredEventRequest = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/events' && url.searchParams.get('within_place_id') === '11' &&
      !url.searchParams.has('before_id')
  })
  await page.getByRole('tab', { name: 'Happenings' }).click()
  await filteredEventRequest
  const olderEventRequest = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/events' && url.searchParams.get('before_id') === '51' &&
      url.searchParams.get('within_place_id') === '11'
  })
  await page.getByRole('button', { name: 'Load older happenings' }).click()
  await olderEventRequest
  await expect(page.locator('#activity-list')).toContainText('leafwalker made a thing')

  await page.getByRole('tab', { name: 'Agreements' }).click()
  const olderAgreementRequest = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/window' && url.searchParams.get('collection') === 'agreements' &&
      url.searchParams.get('before_id') === '41'
  })
  await page.getByRole('button', { name: 'Load older agreements' }).click()
  await olderAgreementRequest
  await expect(page.locator('#agreement-list')).toContainText('An older promise remains public.')
})

test('Archive finds an old body-free result and follows its opaque continuation', async ({ page }) => {
  const requests: URL[] = []
  await page.route('**/api/search**', route => {
    const url = new URL(route.request().url())
    requests.push(url)
    const older = url.searchParams.get('before') === 'older-search-page'
    return route.fulfill({
      json: {
        query: 'hush lantern',
        mode: 'phrase',
        type: 'thing',
        results: [older ? {
          type: 'thing', id: 30, place_id: 11, name: 'old_hush_lantern',
          owner_id: 7, owner: 'leafwalker', open_to_use: false,
          body_text_bytes: 47, created_at: '2026-08-13T10:00:00.000000Z',
          href: '/api/thing/30',
        } : {
          type: 'thing', id: 31, place_id: 11, name: 'new_hush_lantern',
          owner_id: 7, owner: 'leafwalker', open_to_use: true,
          body_text_bytes: 52, created_at: '2026-08-14T10:00:00.000000Z',
          href: '/api/thing/31',
        }],
        total_items: 2,
        total_text_bytes: 99,
        returned_items: 1,
        returned_text_bytes: 0,
        has_more: !older,
        next_before: older ? null : 'older-search-page',
        change_marker: '7',
      },
    })
  })

  await page.getByRole('tab', { name: 'Archive' }).click()
  await page.locator('#archive-query').fill('hush lantern')
  await page.locator('#archive-mode').selectOption('phrase')
  await page.locator('#archive-type').selectOption('thing')
  await page.locator('#archive-search').click()

  await expect(page.locator('#archive-results')).toContainText('new_hush_lantern')
  await expect(page.locator('#archive-results')).not.toContainText('secret body text')
  await expect(page.locator('#archive-results').getByRole('link', { name: 'Open original' }))
    .toHaveAttribute('href', '/api/thing/31')
  expect(requests[0]?.searchParams.get('q')).toBe('hush lantern')
  expect(requests[0]?.searchParams.get('mode')).toBe('phrase')
  expect(requests[0]?.searchParams.get('type')).toBe('thing')
  expect(requests[0]?.searchParams.get('limit')).toBe('25')

  await page.getByRole('button', { name: 'Load older matches' }).click()
  await expect(page.locator('#archive-results')).toContainText('old_hush_lantern')
  expect(requests[1]?.searchParams.get('before')).toBe('older-search-page')
  await expect(page.locator('#archive-results').getByRole('link', { name: 'Open original' }))
    .toHaveCount(2)
})

test('a confirmed unchanged return refreshes presence without reloading authored text', async ({ page }) => {
  await page.getByRole('tab', { name: 'Place' }).click()
  await expect(page.locator('#place-conversation')).toContainText('Opening note.')
  await page.route('**/api/changes**', route => {
    const since = new URL(route.request().url()).searchParams.get('since')
    return route.fulfill({
      json: since === '20'
        ? {
          change_marker: '20', changes: [], returned_items: 0,
          unchanged: true, has_more: false, next_since: '20',
        }
        : { change_marker: '20' },
    })
  })

  const windowReadsBeforeUnchanged = (API_REQUESTS.get(page) ?? [])
    .filter(value => new URL(value).pathname === '/api/window').length
  const unchangedRequest = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/changes' && url.searchParams.get('since') === '20'
  })
  const presenceRequest = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/residents' && url.searchParams.get('view') === 'presence'
  })
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await Promise.all([unchangedRequest, presenceRequest])
  await expect(page.locator('#window-status')).toContainText('no persisted changes')

  const windowReadsAfterUnchanged = (API_REQUESTS.get(page) ?? [])
    .filter(value => new URL(value).pathname === '/api/window').length
  expect(windowReadsAfterUnchanged).toBe(windowReadsBeforeUnchanged)
  await expect(page.locator('#place-conversation')).toContainText('Opening note.')
})

test('an unavailable unchanged-presence read falls back to a bounded authored snapshot', async ({ page }) => {
  await page.getByRole('tab', { name: 'Place' }).click()
  await expect(page.locator('#place-conversation')).toContainText('Opening note.')
  await page.route('**/api/changes**', route => {
    const since = new URL(route.request().url()).searchParams.get('since')
    return route.fulfill({
      json: since === '20'
        ? {
          change_marker: '20', changes: [], returned_items: 0,
          unchanged: true, has_more: false, next_since: '20',
        }
        : { change_marker: '20' },
    })
  })

  await page.route('**/api/residents**', route => route.fulfill({
    status: 503,
    json: { error: 'test presence failure' },
  }))
  const unchangedRequest = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/changes' && url.searchParams.get('since') === '20'
  })
  const failedPresence = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/residents' && url.searchParams.get('view') === 'presence'
  })
  const fallbackSnapshot = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/window' && url.searchParams.get('view') === 'outline' &&
      url.searchParams.get('after_change_marker') === '20'
  })
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await Promise.all([unchangedRequest, failedPresence, fallbackSnapshot])

  await expect(page.locator('#window-status')).toContainText('Watching')
  await expect(page.locator('#window-status')).not.toContainText('older view')
  await expect(page.locator('#place-conversation')).toContainText('Opening note.')
})

test('a failed changed snapshot keeps the old marker and retries the same change', async ({ page }) => {
  await page.route('**/api/changes**', route => {
    const since = new URL(route.request().url()).searchParams.get('since')
    return route.fulfill({
      json: since === '20'
        ? {
          change_marker: '21', changes: [{ change_id: '21' }], returned_items: 1,
          unchanged: false, has_more: false, next_since: '21',
        }
        : { change_marker: '21' },
    })
  })
  let snapshotAttempts = 0
  await page.route('**/api/window**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('after_change_marker') !== '21') return route.fallback()
    snapshotAttempts += 1
    if (snapshotAttempts === 1) {
      return route.fulfill({ status: 503, json: { error: 'test snapshot failure' } })
    }
    return route.fulfill({ json: { ...SNAPSHOT, change_marker: '21' } })
  })

  const firstChange = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/changes' && url.searchParams.get('since') === '20'
  })
  const firstFailure = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/window' &&
      url.searchParams.get('after_change_marker') === '21' && response.status() === 503
  })
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await Promise.all([firstChange, firstFailure])
  await expect(page.locator('#window-status')).toContainText('previous completed view')
  await expect(page.getByRole('button', { name: 'Retry reading the public city view' })).toBeVisible()

  const retriedOldMarker = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/changes' && url.searchParams.get('since') === '20'
  })
  const successfulRetry = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/window' &&
      url.searchParams.get('after_change_marker') === '21' && response.status() === 200
  })
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await Promise.all([retriedOldMarker, successfulRetry])
  expect(snapshotAttempts).toBe(2)
})

test('a changed snapshot drops previously loaded authored content before saving its marker', async ({ page }) => {
  await page.getByRole('tab', { name: 'Place' }).click()
  await expect(page.locator('.thing-card').filter({ hasText: 'record_lantern' })).toBeVisible()
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
  await page.route('**/api/window**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('after_change_marker') !== '21') return route.fallback()
    return route.fulfill({
      json: {
        ...SNAPSHOT,
        change_marker: '21',
        things: [],
        totals: { ...SNAPSHOT.totals, things: 0 },
        shown: { ...SNAPSHOT.shown, things: 0 },
        pages: { ...SNAPSHOT.pages, things: { has_more: false, next_before_id: null } },
      },
    })
  })

  const coveredSnapshot = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/window' &&
      url.searchParams.get('after_change_marker') === '21'
  })
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await coveredSnapshot
  await expect(page.locator('.thing-card').filter({ hasText: 'record_lantern' })).toHaveCount(0)

  const committedMarker = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/changes' && url.searchParams.get('since') === '21'
  })
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await committedMarker
})

test('an older history response already in flight cannot repopulate a newer marker snapshot', async ({ page }) => {
  let releaseOlderHistory: (() => void) | null = null
  await page.route('**/api/window**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('collection') !== 'things') return route.fallback()
    await new Promise<void>(resolve => {
      releaseOlderHistory = () => {
        void route.fulfill({
          json: {
            things: [OLDER_THING], has_more: false, next_before_id: null,
            change_marker: '20',
          },
        }).then(() => resolve())
      }
    })
  })
  const olderRequest = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/window' && url.searchParams.get('collection') === 'things'
  })
  await page.getByRole('tab', { name: 'Place' }).click()
  await olderRequest

  await page.route('**/api/changes**', route => route.fulfill({
    json: {
      change_marker: '21', changes: [{ change_id: '21' }], returned_items: 1,
      unchanged: false, has_more: false, next_since: '21',
    },
  }))
  await page.route('**/api/window**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('after_change_marker') !== '21') return route.fallback()
    return route.fulfill({
      json: {
        ...SNAPSHOT,
        change_marker: '21',
        things: [],
        totals: { ...SNAPSHOT.totals, things: 0 },
        shown: { ...SNAPSHOT.shown, things: 0 },
        pages: { ...SNAPSHOT.pages, things: { has_more: false, next_before_id: null } },
      },
    })
  })
  const coveredSnapshot = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/window' && url.searchParams.get('after_change_marker') === '21'
  })
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await coveredSnapshot

  expect(releaseOlderHistory).not.toBeNull()
  releaseOlderHistory?.()
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  }))
  await expect(page.locator('.thing-card').filter({ hasText: 'record_lantern' })).toHaveCount(0)
  await expect(page.locator('.thing-card').filter({ hasText: 'old_bench' })).toHaveCount(0)
})
