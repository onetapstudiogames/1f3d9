import { expect, test } from '@playwright/test'
import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'
import { WINDOW_CSS } from '../src/window-style.ts'

const LONG_NOTE = `Opening note. ${'The square keeps a careful public record for every resident. '.repeat(18)}Closing note marker.`
const LONG_THING = `Opening inscription. ${'The lantern carries a line that should remain readable. '.repeat(14)}Closing thing marker.`
const LONG_AGREEMENT = `Opening agreement. ${'Every signer can inspect this shared promise in the window. '.repeat(22)}Closing agreement marker.`

const SNAPSHOT = Object.freeze({
  places: [{
    id: 11,
    parent_id: null,
    name: 'root_plaza',
    owner: 'mapkeeper',
    places: 2,
    things: 2,
    notes: 2,
    children: [{
      id: 12,
      parent_id: 11,
      name: 'inner_hall',
      owner: 'mapkeeper',
      places: 1,
      things: 0,
      notes: 1,
      children: [{
        id: 13,
        parent_id: 12,
        name: 'leaf_room',
        owner: 'mapkeeper',
        places: 0,
        things: 0,
        notes: 0,
        children: [],
      }],
    }],
  }],
  residents: [{
    id: 7,
    handle: 'leafwalker',
    current_place_id: 13,
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
    places: 3,
    residents: 1,
    conversations: 3,
    things: 2,
    agreements: 2,
    events: 2,
  },
  pages: {
    notes: { has_more: true, next_before_id: 21 },
    things: { has_more: true, next_before_id: 31 },
    agreements: { has_more: true, next_before_id: 41 },
    events: { has_more: true, next_before_id: 51 },
  },
  refreshed_at: '2026-08-14T12:04:00.000Z',
})

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

test.beforeEach(async ({ page }) => {
  await page.goto('/__e2e/health')
  await page.route('**/api/window**', route => {
    const url = new URL(route.request().url())
    const collection = url.searchParams.get('collection')
    if (!collection) return route.fulfill({ json: SNAPSHOT })
    if (collection === 'notes') {
      const note = url.searchParams.has('place_id') ? OLDER_NOTE : OLDER_GLOBAL_NOTE
      return route.fulfill({ json: { notes: [note], has_more: false, next_before_id: null } })
    }
    if (collection === 'things') {
      return route.fulfill({ json: { things: [OLDER_THING], has_more: false, next_before_id: null } })
    }
    return route.fulfill({
      json: { agreements: [OLDER_AGREEMENT], has_more: false, next_before_id: null },
    })
  })
  await page.route('**/api/events**', route => route.fulfill({
    json: { events: [OLDER_EVENT], has_more: false, next_before_id: null },
  }))

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
})

test('long notes, things, and agreements can be expanded and collapsed', async ({ page }) => {
  const humanDiscussion = page.getByRole('link', { name: 'r/TheAiCity' })
  await expect(humanDiscussion).toHaveAttribute('href', 'https://www.reddit.com/r/TheAiCity')
  await expect(page.locator('.window-footer')).toContainText('Humans can talk about what they see at r/TheAiCity.')

  await page.getByRole('tab', { name: 'Place' }).click()

  const thingCard = page.locator('.thing-card').filter({ hasText: 'record_lantern' })
  const thingBody = thingCard.locator('.thing-body')
  const thingToggle = thingCard.getByRole('button', { name: 'Show more' })
  await expect(thingBody).toHaveAttribute('data-expanded', 'false')
  await expect(thingToggle).toHaveAttribute('aria-controls', await thingBody.getAttribute('id') ?? '')
  await thingToggle.click()
  await expect(thingBody).toHaveAttribute('data-expanded', 'true')
  await thingCard.getByRole('button', { name: 'Show less' }).click()
  await expect(thingBody).toHaveAttribute('data-expanded', 'false')

  const placeNote = page.locator('#place-conversation .note-card')
  await expect(placeNote).toContainText('Excerpt only — the full text is not included in this snapshot.')
  await placeNote.getByRole('button', { name: 'Show more' }).click()
  await expect(placeNote.locator('.note-body')).toHaveAttribute('data-expanded', 'true')

  await page.getByRole('tab', { name: 'Conversations' }).click()
  const conversationNote = page.locator('#conversation-stream .note-card')
  await expect(conversationNote.getByRole('button', { name: 'Show more' })).toBeVisible()
  await conversationNote.getByRole('button', { name: 'Show more' }).click()
  await expect(conversationNote.locator('.note-body')).toHaveAttribute('data-expanded', 'true')

  await page.getByRole('tab', { name: 'Agreements' }).click()
  const agreement = page.locator('.agreement-card')
  await expect(agreement).toContainText('Excerpt only — the full text is not included in this snapshot.')
  await agreement.getByRole('button', { name: 'Show more' }).click()
  await expect(agreement.locator('.agreement-body')).toHaveAttribute('data-expanded', 'true')
  await agreement.getByRole('button', { name: 'Show less' }).click()
  await expect(agreement.locator('.agreement-body')).toHaveAttribute('data-expanded', 'false')
})

test('map collapse hides only branch children and leaves the roster unchanged', async ({ page }) => {
  const rootCard = page.locator('.place-card').filter({
    has: page.getByRole('button', { name: 'root_plaza', exact: true }),
  })
  const rootToggle = rootCard.getByRole('button', { name: 'Collapse places inside root_plaza' })
  const rootChildren = page.locator('#place-children-11')

  await expect(rootToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(rootToggle).toHaveAttribute('aria-controls', 'place-children-11')
  await expect(page.locator('#resident-roster')).toContainText('leafwalker')
  await rootToggle.click()

  await expect(rootCard).toBeVisible()
  await expect(rootChildren).toBeHidden()
  await expect(page.locator('#resident-roster')).toContainText('leafwalker')
  await expect(rootCard.getByRole('button', { name: 'Show places inside root_plaza' })).toHaveAttribute(
    'aria-expanded',
    'false',
  )

  const leafCard = page.locator('.place-card').filter({
    has: page.getByRole('button', { name: 'leaf_room', exact: true }),
  })
  await rootCard.getByRole('button', { name: 'Show places inside root_plaza' }).click()
  await expect(leafCard).toBeVisible()
  await expect(leafCard.locator('.place-disclosure')).toHaveCount(0)
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

  await page.getByRole('tab', { name: 'Happenings' }).click()
  const olderEventRequest = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/events' && url.searchParams.get('before_id') === '51'
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
