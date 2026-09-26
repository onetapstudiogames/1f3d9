import { expect, test, type Page } from '@playwright/test'
import { registerPublicWindowSetup } from './helpers/public-window-setup.ts'
import { FOCUSED_PLACE, SNAPSHOT } from './helpers/public-window-snapshot-fixtures.ts'
import {
  MINUTE_MS,
  linesPage,
  routeTalk,
  stepTalk,
  talkLineTime,
  talkNow,
  type TalkRequests,
} from './helpers/window-talk-fixtures.ts'

const fixedTime = new Date('2026-09-25T12:00:00.000Z')

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: fixedTime })
  await page.clock.pauseAt(new Date(fixedTime.getTime() + 1))
})

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.title === 'Talk opened while hidden makes no reads until shown') {
    await page.addInitScript(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true })
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    })
  }
})

const RANDOM_WAIT_TEST = 'thirty steady checks each wait the served interval plus a fresh random wait of up to half a second'

// Every check that waits the served interval adds a random 0 to TALK_CHECK_JITTER_MS. The other
// tests here step the clock by exact intervals, so they pin that draw to 0. The random wait test
// keeps the real draw and records, on the page's own clock, when each check starts (its
// GET /api/talk/now) and when it ends and picks its next wait (data-talk-checks).
test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.title !== RANDOM_WAIT_TEST) {
    await page.addInitScript(() => { Math.random = () => 0 })
    return
  }
  await page.addInitScript(() => {
    const times = { started: [] as number[], ended: [] as number[] }
    Object.defineProperty(window, 'talkTimes', { value: times })
    const originalFetch = window.fetch.bind(window)
    window.fetch = (input, init) => {
      if (String(input) === '/api/talk/now') times.started.push(Date.now())
      return originalFetch(input, init)
    }
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(records => {
        for (const record of records) {
          if (record.attributeName === 'data-talk-checks') times.ended.push(Date.now())
        }
      }).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-talk-checks'] })
    })
  })
})

registerPublicWindowSetup()

function publicLine(id: number, body: string) {
  return {
    id,
    place_id: 11,
    author: 'leafwalker',
    body,
    created_at: talkLineTime(MINUTE_MS, fixedTime.getTime()),
  }
}

function snapshotAt(marker: string, quietRoot = false) {
  return {
    ...SNAPSHOT,
    change_marker: marker,
    places: SNAPSHOT.places.map(place => place.id === 11 && quietRoot
      ? { ...place, quiet: true }
      : { ...place }),
  }
}

function emptyWindowHistoryPage(collection: string, marker: string) {
  const page = { has_more: false, next_before_id: null, change_marker: marker }
  if (collection === 'notes') return { ...page, notes: [] }
  if (collection === 'things') return { ...page, things: [] }
  if (collection === 'agreements') return { ...page, agreements: [] }
  if (collection === 'events') return { ...page, events: [] }
  return null
}

async function routeDeepRoom(
  page: Page,
  {
    quietAt,
    holdMapAt,
  }: {
    quietAt: (marker: string) => boolean
    holdMapAt: string | null
  },
): Promise<{ changes: string[]; maps: string[]; release: () => void }> {
  const changes: string[] = []
  const maps: string[] = []
  let releaseHeldMap = () => {}
  const heldMap = new Promise<void>(resolve => { releaseHeldMap = resolve })

  await page.unroute('**/api/changes**')
  await page.route('**/api/changes**', async route => {
    const url = new URL(route.request().url())
    changes.push(url.toString())
    const since = url.searchParams.get('since')
    const marker = since ? String(BigInt(since) + 1n) : '20'
    const change = since
      ? [{ change_id: marker, kind: 'place_edited', actor: 'mapkeeper', detail: { place_id: 77 }, created_at: '2026-09-25T11:59:30.000Z' }]
      : []
    await route.fulfill({ json: {
      change_marker: marker,
      changes: change,
      returned_items: change.length,
      unchanged: change.length === 0,
      has_more: false,
      next_since: marker,
    } })
  })
  await page.route('**/api/window**', async route => {
    const url = new URL(route.request().url())
    const marker = url.searchParams.get('after_change_marker')
    const collection = url.searchParams.get('collection')
    if (!collection && url.searchParams.get('view') === 'outline' && marker) {
      return route.fulfill({ json: snapshotAt(marker) })
    }
    if (marker && collection) {
      const body = emptyWindowHistoryPage(collection, marker)
      if (body) return route.fulfill({ json: body })
    }
    return route.fallback()
  })
  await page.route('**/api/events**', async route => {
    const url = new URL(route.request().url())
    const marker = url.searchParams.get('after_change_marker')
    if (marker) {
      return route.fulfill({ json: {
        events: [], has_more: false, next_before_id: null, change_marker: marker,
      } })
    }
    return route.fallback()
  })
  await page.route('**/api/map**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('parent_id') !== '77') return route.fallback()
    maps.push(url.toString())
    const marker = url.searchParams.get('after_change_marker') ?? '20'
    if (marker === holdMapAt) await heldMap
    return route.fulfill({ json: {
      ...FOCUSED_PLACE,
      change_marker: marker,
      place: { ...FOCUSED_PLACE.place, quiet: quietAt(marker) },
    } })
  })
  return { changes, maps, release: releaseHeldMap }
}

async function openTalk(page: import('@playwright/test').Page, requests: TalkRequests) {
  await page.locator('#talk-tab').click()
  await expect(page.locator('#talk-panel')).toBeVisible()
  await expect.poll(() => requests.talkNow.length).toBe(1)
}

async function expectNoNewTalkRequests(page: import('@playwright/test').Page, requests: TalkRequests) {
  const counts = [requests.talkNow.length, requests.lines.length]
  await expect.poll(async () => {
    await new Promise(resolve => setTimeout(resolve, 1_000))
    return [requests.talkNow.length, requests.lines.length]
  }, { timeout: 1_500 }).toEqual(counts)
}

test('Talk opened while hidden makes no reads until shown', async ({ page }) => {
  const requests = await routeTalk(page, { lines: linesPage([]) })
  expect(await page.evaluate(() => document.hidden)).toBe(true)
  await page.locator('#talk-tab').click()
  await expect(page.locator('#talk-panel')).toBeVisible()

  await page.clock.runFor(4_000)
  expect(requests.talkNow).toHaveLength(0)
  expect(requests.lines).toHaveLength(0)

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.clock.runFor(0)
  await expect.poll(() => requests.talkNow.length).toBe(1)
  await expect.poll(() => requests.lines.length).toBe(1)
})

test('a new line appears on the next check', async ({ page }) => {
  const requests = await routeTalk(page, {
    now: (_url, index) => talkNow({ lineMarker: index === 0 ? '100' : '101' }),
    lines: (_url, index) => linesPage(index === 0 ? [] : [publicLine(101, 'A new line.')]),
  })
  await openTalk(page, requests)
  await expect.poll(() => requests.lines.length).toBe(1)
  await expect(page.locator('#talk-lines')).toContainText('No public line matches this selection.')

  await stepTalk(page, 2_000, requests, { talkNow: 2, checks: 2 })

  await expect(page.locator('#talk-lines')).toContainText('leafwalker: A new line.')
  expect(requests.lines.map(value => new URL(value).searchParams.get('after_change_marker')))
    .toEqual(['100', '101'])
})

test('a head whose line marker does not move makes no lines read', async ({ page }) => {
  const requests = await routeTalk(page, { now: talkNow(), lines: linesPage([]) })
  await openTalk(page, requests)
  await expect.poll(() => requests.lines.length).toBe(1)
  await expect(page.locator('#talk-lines')).toContainText('No public line matches this selection.')

  for (let index = 0; index < 5; index += 1) {
    await stepTalk(page, 2_000, requests, {
      talkNow: index + 2,
      checks: index + 2,
    })
  }

  expect(requests.lines).toHaveLength(1)
  expect(requests.talkNow).toHaveLength(6)
})

test('a place edit newer than the city view refreshes it at once, and a room that turned quiet hides its lines', async ({ page }) => {
  const changesRequests: string[] = []
  await page.unroute('**/api/changes**')
  await page.route('**/api/changes**', async route => {
    const url = new URL(route.request().url())
    changesRequests.push(url.toString())
    const since = url.searchParams.get('since')
    if (since === '20') {
      return route.fulfill({ json: {
        change_marker: '21',
        changes: [{
          change_id: '21', kind: 'place_edited', actor: 'mapkeeper',
          detail: { place_id: 11 }, created_at: '2026-09-25T11:59:30.000Z',
        }],
        returned_items: 1, unchanged: false, has_more: false, next_since: '21',
      } })
    }
    return route.fulfill({ json: {
      change_marker: '21', changes: [], returned_items: 0,
      unchanged: true, has_more: false, next_since: '21',
    } })
  })
  await page.route('**/api/window**', async route => {
    const url = new URL(route.request().url())
    const marker = url.searchParams.get('after_change_marker')
    const collection = url.searchParams.get('collection')
    if (!collection && url.searchParams.get('view') === 'outline' && marker === '21') {
      return route.fulfill({ json: snapshotAt('21', true) })
    }
    if (marker === '21' && collection) {
      const body = emptyWindowHistoryPage(collection, marker)
      if (body) return route.fulfill({ json: body })
    }
    return route.fallback()
  })
  await page.route('**/api/events**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('after_change_marker') === '21') {
      return route.fulfill({ json: {
        events: [], has_more: false, next_before_id: null, change_marker: '21',
      } })
    }
    return route.fallback()
  })
  const requests = await routeTalk(page, {
    now: (_url, index) => talkNow({ placeMarker: index === 0 ? '20' : '21' }),
    lines: linesPage([publicLine(101, 'QuietTurnLineZq9k7')]),
  })
  const changesAtTalkOpen = changesRequests.length
  await openTalk(page, requests)
  await expect(page.locator('#talk-lines')).toContainText('QuietTurnLineZq9k7')
  expect(changesRequests.slice(changesAtTalkOpen)).toHaveLength(0)
  expect(changesRequests.some(value => new URL(value).searchParams.get('since') === '21')).toBe(false)

  await stepTalk(page, 2_000, requests, { talkNow: 2, checks: 2 })
  await expect(page.locator('#talk-lines .talk-line-quiet')).toHaveCount(1)
  await expect.poll(() => changesRequests.slice(changesAtTalkOpen)
    .filter(value => new URL(value).searchParams.get('since') === '20').length).toBe(1)
  await expect(page.locator('#talk-lines')).not.toContainText('QuietTurnLineZq9k7')
  await expect(page.locator('#talk-lines .talk-line-quiet')).toHaveCount(1)
  expect(requests.lines).toHaveLength(1)
})

test('a place marker at or below the city view makes no change feed read', async ({ page }) => {
  const changesRequests: string[] = []
  await page.route('**/api/changes**', async route => {
    changesRequests.push(route.request().url())
    return route.fallback()
  })
  const requests = await routeTalk(page, {
    now: (_url, index) => talkNow({ placeMarker: index === 1 ? '19' : '20' }),
    lines: linesPage([]),
  })
  const changesAtTalkOpen = changesRequests.length
  await openTalk(page, requests)
  await expect.poll(() => requests.lines.length).toBe(1)
  await stepTalk(page, 2_000, requests, { talkNow: 2, checks: 2 })
  await stepTalk(page, 2_000, requests, { talkNow: 3, checks: 3 })
  expect(changesRequests.slice(changesAtTalkOpen)).toHaveLength(0)
})

test('a deep room picked in Talk that turns quiet hides its lines after one check', async ({ page }) => {
  const requests = await routeTalk(page, {
    now: (_url, index) => talkNow({ placeMarker: index === 0 ? '20' : '21' }),
    lines: linesPage([{ ...publicLine(102, 'DeepQuietLineRw4m8'), place_id: 77 }]),
  })
  const deepRoom = await routeDeepRoom(page, {
    quietAt: marker => marker === '21',
    holdMapAt: null,
  })
  const changesAtPick = deepRoom.changes.length
  await page.evaluate(() => { window.location.hash = '#view=talk&place=77' })
  await expect(page.locator('#talk-panel')).toBeVisible()
  await expect.poll(() => requests.talkNow.length).toBe(1)
  await expect(page.locator('#talk-lines')).toContainText('DeepQuietLineRw4m8')

  await stepTalk(page, 2_000, requests, { talkNow: 2, checks: 2 })
  await expect(page.locator('#talk-lines .talk-line-quiet')).toHaveCount(1)
  await expect.poll(() => deepRoom.changes.slice(changesAtPick)
    .filter(value => new URL(value).searchParams.get('since') === '20').length).toBe(1)
  await expect.poll(() => deepRoom.maps.filter(value => {
    const url = new URL(value)
    return url.searchParams.get('parent_id') === '77' &&
      url.searchParams.get('after_change_marker') === '21'
  }).length).toBe(1)
  await expect(page.locator('#talk-lines .talk-line-quiet')).toHaveCount(1)
  await expect(page.locator('#talk-lines')).not.toContainText('DeepQuietLineRw4m8')
  expect(requests.lines).toHaveLength(1)
})

test('a hidden tab stops checking and catches up at once when shown', async ({ page }) => {
  const requests = await routeTalk(page, {
    now: (_url, index) => talkNow({ lineMarker: index === 0 ? '100' : '101' }),
    lines: (_url, index) => linesPage(index === 0 ? [] : [publicLine(101, 'A line while hidden.')]),
  })
  await openTalk(page, requests)
  await expect.poll(() => requests.lines.length).toBe(1)
  await expect(page.locator('#talk-lines')).toContainText('No public line matches this selection.')

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  for (let index = 0; index < 5; index += 1) await page.clock.runFor(2_000)
  await expectNoNewTalkRequests(page, requests)
  expect(await page.evaluate(() => document.body.dataset.talkChecks)).toBe('1')

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.clock.runFor(0)
  await expect.poll(() => requests.talkNow.length).toBe(2)
  await expect.poll(() => page.evaluate(() => document.body.dataset.talkChecks)).toBe('2')
  await expect(page.locator('#talk-lines')).toContainText('leafwalker: A line while hidden.')
  expect(new URL(requests.lines[1]).searchParams.get('after_change_marker')).toBe('101')
})

test('a failed check says so and waits longer each time, up to 30 seconds', async ({ page }) => {
  const requests = await routeTalk(page, {
    now: (_url, index) => index < 5
      ? { status: 503, body: { unavailable: true } }
      : talkNow(),
  })
  await openTalk(page, requests)
  await expect(page.locator('#talk-status')).toHaveText(
    'New lines could not be checked just now; the window keeps trying.',
  )

  const gaps = [4_000, 8_000, 16_000, 30_000, 30_000]
  for (const [index, gap] of gaps.entries()) {
    await page.clock.runFor(gap - 1_000)
    await expectNoNewTalkRequests(page, requests)
    await stepTalk(page, 1_000, requests, {
      talkNow: index + 2,
      checks: index + 2,
    })
  }

  await expect(page.locator('#talk-status')).toBeHidden()
  await page.clock.runFor(1_000)
  await expectNoNewTalkRequests(page, requests)
  await stepTalk(page, 1_000, requests, { talkNow: 7, checks: 7 })
})

test('only Talk checks', async ({ page }) => {
  const requests = await routeTalk(page)
  for (const view of ['conversations', 'map', 'happenings']) {
    await page.locator(`[data-view="${view}"]`).click()
    for (let index = 0; index < 5; index += 1) await page.clock.runFor(2_000)
    await expectNoNewTalkRequests(page, requests)
  }
  expect(requests.talkNow).toHaveLength(0)
  expect(requests.lines).toHaveLength(0)
})

test("the city's served interval sets the next check, never faster than 2 seconds", async ({ page }) => {
  const requests = await routeTalk(page, {
    now: (_url, index) => talkNow({ checkIntervalMs: index === 0 ? 4_000 : 500 }),
    lines: linesPage([]),
  })
  await openTalk(page, requests)
  await expect(page.locator('#talk-lines')).toContainText('No public line matches this selection.')

  await page.clock.runFor(2_000)
  await expectNoNewTalkRequests(page, requests)
  await stepTalk(page, 2_000, requests, { talkNow: 2, checks: 2 })
  await page.clock.runFor(1_000)
  await expectNoNewTalkRequests(page, requests)
  await stepTalk(page, 1_000, requests, { talkNow: 3, checks: 3 })
})

test('a tab nobody uses for 30 minutes checks every 30 seconds, and a key press brings back the served interval', async ({ page }) => {
  const requests = await routeTalk(page, {
    now: () => talkNow({ checkIntervalMs: 4_000 }),
    lines: linesPage([]),
  })
  await openTalk(page, requests)
  await expect.poll(() => requests.lines.length).toBe(1)
  await expect(page.locator('#talk-lines')).toContainText('No public line matches this selection.')

  await page.clock.fastForward(30 * 60_000)
  await expect.poll(() => requests.talkNow.length).toBe(2)
  await expect.poll(() => page.evaluate(() => document.body.dataset.talkChecks)).toBe('2')
  await expect(page.locator('#talk-status')).toHaveText(
    'This tab has not been used for 30 minutes, so it checks for new lines every 30 seconds. Move the mouse, scroll, touch, or press a key to check every 4 to 4.5 seconds again.',
  )

  await stepTalk(page, 30_000, requests, { talkNow: 3, checks: 3 })
  await page.keyboard.press('x')
  await expect(page.locator('#talk-status')).toBeHidden()
  await page.clock.runFor(3_000)
  await expectNoNewTalkRequests(page, requests)
  await stepTalk(page, 1_000, requests, { talkNow: 4, checks: 4 })
})

test(RANDOM_WAIT_TEST, async ({ page }) => {
  test.setTimeout(90_000)
  const requests = await routeTalk(page, { now: talkNow(), lines: linesPage([]) })
  await openTalk(page, requests)
  await expect.poll(() => requests.lines.length).toBe(1)
  const readTimes = () => page.evaluate(() =>
    (window as unknown as { talkTimes: { started: number[]; ended: number[] } }).talkTimes)
  await expect.poll(async () => {
    await page.clock.runFor(500)
    const { started, ended } = await readTimes()
    return Math.min(started.length - 1, ended.length)
  }, { timeout: 60_000, intervals: [10] }).toBeGreaterThanOrEqual(30)

  const { started, ended } = await readTimes()
  // Gap k runs from the moment check k ended and picked its wait to the moment check k + 1 began.
  const gaps = started.slice(1, 31).map((at, index) => at - ended[index])
  expect(gaps).toHaveLength(30)
  for (const gap of gaps) {
    expect(gap).toBeGreaterThanOrEqual(2_000)
    expect(gap).toBeLessThanOrEqual(2_500)
  }
  expect(new Set(gaps).size).toBeGreaterThan(1)
})
