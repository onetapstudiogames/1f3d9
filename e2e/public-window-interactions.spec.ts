import { expect, test, type Page } from '@playwright/test'
import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'
import { WINDOW_CSS } from '../src/window-style.ts'

const LONG_NOTE = `Opening note. ${'The square keeps a careful public record for every resident. '.repeat(18)}Closing note marker.`
const LONG_THING = `Opening inscription. ${'The lantern carries a line that should remain readable. '.repeat(14)}Closing thing marker.`
const LONG_AGREEMENT = `Opening agreement. ${'Every signer can inspect this shared promise in the window. '.repeat(22)}Closing agreement marker.`

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
  place_id: 11,
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

const OLDER_THING = Object.freeze({
  id: 30,
  place_id: 11,
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
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/')) API_REQUESTS.get(page)?.push(url.toString())
  })
  await page.goto('/__e2e/health')
  if (testInfo.title.includes('cold deep link') || testInfo.title.includes('focused selection retry')) {
    await page.evaluate(() => { window.location.hash = '#view=place&place=77' })
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
    if (!collection) return route.fulfill({ json: SNAPSHOT })
    if (collection === 'notes') {
      const note = url.searchParams.has('place_id') ? OLDER_NOTE : OLDER_GLOBAL_NOTE
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
    if (url.searchParams.get('parent_id') === '77') {
      focusedPlaceAttempts += 1
      if (testInfo.title.includes('focused selection retry') && focusedPlaceAttempts === 1) {
        return route.fulfill({ status: 503, json: { error: 'test focused place failure' } })
      }
      return route.fulfill({ json: FOCUSED_PLACE })
    }
    if (url.searchParams.get('parent_id') !== '12') {
      return route.fulfill({ status: 404, json: { error: 'unknown test branch' } })
    }
    return route.fulfill({
      json: url.searchParams.get('before_subplace_id') === '14'
        ? SECOND_BRANCH_PAGE
        : FIRST_BRANCH_PAGE,
    })
  })
  await page.route('**/api/residents**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('handle') === 'far-walker') {
      return route.fulfill({ json: FOCUSED_RESIDENT })
    }
    return route.fulfill({ json: RESIDENT_PAGE })
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

test('long notes, things, and agreements can be expanded and collapsed', async ({ page }) => {

  await page.getByRole('tab', { name: 'Place' }).click()

  const thingCard = page.locator('.thing-card').filter({ hasText: 'record_lantern' })
  await expect(thingCard).toContainText('open to shared use')
  const thingBody = thingCard.locator('.thing-body')
  const thingToggle = thingCard.getByRole('button', { name: 'Show more' })
  await expect(thingBody).toHaveAttribute('data-expanded', 'false')
  await expect(thingToggle).toHaveAttribute('aria-controls', await thingBody.getAttribute('id') ?? '')
  await thingToggle.click()
  await expect(thingBody).toHaveAttribute('data-expanded', 'true')
  await thingCard.getByRole('button', { name: 'Show less' }).click()
  await expect(thingBody).toHaveAttribute('data-expanded', 'false')

  const placeNote = page.locator('#place-conversation .note-card')
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
  await conversationNote.getByRole('button', { name: 'Show less' }).click()
  await expect(conversationNote.locator('.note-body')).toHaveAttribute('data-expanded', 'false')
  await conversationNote.getByRole('button', { name: 'Show more' }).click()
  await expect(conversationNote.locator('.note-body')).toHaveAttribute('data-expanded', 'true')

  await page.getByRole('tab', { name: 'Agreements' }).click()
  const agreement = page.locator('.agreement-card')
  await expect(agreement).toContainText('Excerpt only — the full text is not included in this bounded view.')
  await agreement.getByRole('button', { name: 'Show more' }).click()
  await expect(agreement.locator('.agreement-body')).toHaveAttribute('data-expanded', 'true')
  await agreement.getByRole('button', { name: 'Show less' }).click()
  await expect(agreement.locator('.agreement-body')).toHaveAttribute('data-expanded', 'false')
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

test('complete directory selection uses one focused place read without loading contents', async ({ page }) => {
  await expect(page.locator('#directory-status')).toContainText(
    'Complete city directory: 3 places and 2 residents',
  )
  expect(await page.locator('#place-filter option').allTextContents()).toEqual([
    'All places',
    'root_plaza',
    'root_plaza / inner_hall',
    'root_plaza / inner_hall / quiet_annex',
  ])
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
  })

  await page.getByRole('tab', { name: 'Place' }).click()
  await expect(page.locator('#place-focus-title')).toHaveText('quiet_annex')
  await expect(page.locator('#place-focus-summary')).toContainText(
    'root_plaza / inner_hall / quiet_annex · focused metadata loaded',
  )
  await expect(page.locator('#place-things')).toContainText('not currently loaded')

  const requests = (API_REQUESTS.get(page) ?? []).map(value => new URL(value))
  expect(requests.filter(url =>
    url.pathname === '/api/map' && url.searchParams.get('parent_id') === '77')).toHaveLength(1)
  expect(requests.filter(url =>
    url.pathname === '/api/window' && url.searchParams.get('place_id') === '77')).toHaveLength(0)

  await page.getByRole('tab', { name: 'Map' }).focus()
  await page.getByRole('tab', { name: 'Map' }).press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'Place' })).toBeFocused()
  await expect(page.getByRole('tab', { name: 'Place' })).toHaveAttribute('aria-selected', 'true')
})

test('complete resident selection uses one focused presence read and a directory path', async ({ page }) => {
  const focusedRequest = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/residents' && url.searchParams.get('handle') === 'far-walker'
  })
  await page.locator('#resident-filter').selectOption('far-walker')
  const focusedUrl = new URL((await focusedRequest).url())
  expect(Object.fromEntries(focusedUrl.searchParams)).toEqual({
    view: 'presence',
    handle: 'far-walker',
  })

  const roster = page.locator('#resident-roster')
  await expect(roster.getByRole('button', { name: 'far-walker', exact: true })).toBeVisible()
  await expect(roster).toContainText('root_plaza / inner_hall / quiet_annex')
  const requests = (API_REQUESTS.get(page) ?? []).map(value => new URL(value))
  expect(requests.filter(url =>
    url.pathname === '/api/residents' && url.searchParams.get('handle') === 'far-walker'))
    .toHaveLength(1)
})

test('cold deep link replaces its numbered fallback when the directory arrives later', async ({ page }) => {
  await expect(page.locator('#directory-status')).toContainText('Complete city directory')
  await expect(page.locator('#place-focus-title')).toHaveText('quiet_annex')
  await expect(page.locator('#place-focus-summary')).toContainText(
    'root_plaza / inner_hall / quiet_annex · focused metadata loaded',
  )
})

test('focused selection retry retains a useful keyboard focus target', async ({ page }) => {
  const retry = page.getByRole('button', { name: 'Retry loading this place' })
  await expect(retry).toBeVisible()
  await retry.focus()
  await retry.click()

  await expect(page.locator('#place-focus-title')).toHaveText('quiet_annex')
  await expect(page.locator('#place-focus-title')).toBeFocused()
})

test('directory failure is accessible and retryable without hiding the loaded fallback', async ({ page }) => {
  const alert = page.locator('#directory-status[role="alert"]')
  await expect(alert).toContainText(/complete city directory could not be loaded/i)
  expect(await page.locator('#place-filter option').allTextContents()).toEqual([
    'All places',
    'root_plaza',
    'root_plaza / inner_hall',
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
    'root_plaza / inner_hall / quiet_annex · focused metadata loaded',
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
    if (url.searchParams.get('after_change_marker') === '21') {
      return route.fulfill({ json: { ...SNAPSHOT, change_marker: '21' } })
    }
    return route.fulfill({ json: SNAPSHOT })
  })
  await page.unroute('**/api/map**')
  await page.route('**/api/map**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('parent_id') === '77') {
      return route.fulfill({ json: FOCUSED_PLACE_REFRESHED })
    }
    if (url.searchParams.get('parent_id') !== '12') {
      return route.fulfill({ status: 404, json: { error: 'unknown test branch' } })
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
    return url.pathname === '/api/map' && url.searchParams.get('parent_id') === '77'
  })
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await Promise.all([coveredSnapshot, refreshedDirectory, refreshedFocusedPlace])

  await expect(page.locator('#directory-status')).toContainText(
    'Complete city directory: 4 places and 2 residents',
  )
  expect(await page.locator('#place-filter option').allTextContents()).toEqual([
    'All places',
    'root_plaza',
    'root_plaza / inner_hall',
    'root_plaza / inner_hall / renamed_annex',
    'root_plaza / inner_hall / fresh_gallery',
  ])
  await expect(page.locator('#place-focus-title')).toHaveText('renamed_annex')
  await expect(page.locator('#place-focus-summary')).toContainText(
    'root_plaza / inner_hall / renamed_annex · focused metadata loaded',
  )
  await expect(page.locator('#place-purpose')).toContainText(
    'A renamed room proved by a refreshed focused map read.',
  )
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
    'leafwalker · #7',
    'far-walker · #9',
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

test('residents at an unloaded address stay visible under an honest label', async ({ page }) => {
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
  await expect(roster).toContainText('Place #999 · not currently loaded')
  await expect(page.locator('#window-status')).toHaveAttribute('role', 'status')
})

test('unloaded place and resident deep links describe the bounded gap without false absence', async ({ page }) => {
  await page.goto('/window#view=place&place=999')
  await expect(page.locator('#place-focus-title')).toContainText('Place #999 is not currently loaded')
  await expect(page.locator('#place-focus-summary')).toContainText(/metadata and content are not currently loaded/i)
  await expect(page.locator('#place-panel')).not.toContainText(/no place to watch|frontier has no matching/i)

  const requestsBeforePlaceConversation = API_REQUESTS.get(page)?.length ?? 0
  await page.goto('/window#view=conversations&place=999')
  await expect(page.locator('#conversation-stream')).toContainText(
    /place #999.*metadata and conversation.*not currently loaded/i,
  )
  const placeConversationRequests = (API_REQUESTS.get(page) ?? [])
    .slice(requestsBeforePlaceConversation)
    .map(value => new URL(value))
    .filter(url => url.searchParams.get('collection') === 'notes' &&
      url.searchParams.get('place_id') === '999')
  expect(placeConversationRequests).toHaveLength(0)

  await page.goto('/window#view=conversations&resident=missing-reader')
  await expect(page.locator('#conversation-stream')).toContainText(
    /resident missing-reader.*metadata and conversation.*not currently loaded/i,
  )
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
    const before = new URL(route.request().url()).searchParams.get('before_id')
    if (!refreshed) return route.fulfill({ json: RESIDENT_PAGE })
    expect(before).toBe('100')
    return route.fulfill({ json: {
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
  await expect(branchCard.locator('.place-facts')).toContainText('6 inside · 4 things · 2 notes')

  expect(await page.locator('#resident-filter option').allTextContents()).toEqual([
    'All residents',
    'leafwalker · #7',
    'far-walker · #9',
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

test('recent window slices can be extended independently in every public view', async ({ page }) => {
  await page.getByRole('tab', { name: 'Conversations' }).click()
  const olderConversationRequest = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/window' && url.searchParams.get('collection') === 'notes' &&
      url.searchParams.get('before_id') === '21' && !url.searchParams.has('place_id')
  })
  await page.getByRole('button', { name: 'Load older conversations' }).click()
  await olderConversationRequest
  await expect(page.locator('#conversation-stream')).toContainText('An older conversation remains readable.')
  await expect(page.getByRole('button', { name: 'Load older conversations' })).toHaveCount(0)

  await page.getByRole('tab', { name: 'Place' }).click()
  const olderThingRequest = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/window' && url.searchParams.get('collection') === 'things' &&
      url.searchParams.get('place_id') === '11' && !url.searchParams.has('before_id')
  })
  await page.getByRole('button', { name: 'Load older things' }).click()
  await olderThingRequest
  await expect(page.locator('#place-things')).toContainText('old_bench')

  const olderPlaceNoteRequest = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/window' && url.searchParams.get('collection') === 'notes' &&
      url.searchParams.get('place_id') === '11' && !url.searchParams.has('before_id')
  })
  await page.getByRole('button', { name: 'Load older notes' }).click()
  await olderPlaceNoteRequest
  await expect(page.locator('#place-conversation')).toContainText('An older conversation remains readable.')

  // The place chosen on the Place tab is still watched, so Happenings
  // fetches its place-filtered slice from the server on its own.
  const filteredEventRequest = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/events' && url.searchParams.get('place_id') === '11' &&
      !url.searchParams.has('before_id')
  })
  await page.getByRole('tab', { name: 'Happenings' }).click()
  await filteredEventRequest
  const olderEventRequest = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/events' && url.searchParams.get('before_id') === '51' &&
      url.searchParams.get('place_id') === '11'
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
  await expect(page.locator('#window-status')).toContainText('older view')

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
  await page.getByRole('tab', { name: 'Place' }).click()
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
  await page.getByRole('button', { name: 'Load older things' }).click()
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
