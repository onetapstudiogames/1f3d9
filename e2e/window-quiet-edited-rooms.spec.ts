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

// Decision 129 in the two views that learn of a place edit without reading the room they
// show: Talk with no place picked, and Conversations open on its own. Room 77 (quiet_annex,
// 11 > 12 > 77) is outside the outline, and the names directory says it is open for the
// whole test, as an edge copy a minute or more old does. Only the room's own read at the new
// marker knows it turned quiet.

const fixedTime = new Date('2026-09-25T12:00:00.000Z')
const DEEP_LINE = 'DeepRoomLineVk3p8'
const OPEN_LINE = 'OpenRoomLineVk3p8'
const DEEP_NOTE = 'DeepRoomNoteVk3p8'

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: fixedTime })
  await page.clock.pauseAt(new Date(fixedTime.getTime() + 1))
  await page.addInitScript(() => { Math.random = () => 0 })
})

registerPublicWindowSetup()

type CityChange = Readonly<{ kind: 'place_edited' | 'note'; placeId: number }>

// The city after the page loaded. Change n (from 0) has id 21 + n, so the city's marker is
// 20 plus the number of changes. Room 77's own read says quiet at a marker quietAt accepts,
// and answers 503 at a marker in mapFails. Place 11, in the outline, is named
// plaza_at_<marker>, so the place a Talk row names shows which refresh the window drew last.
// The outline answers at the city's newest marker, as the server may. The next change list
// read leaves out the newest feedBehindOnce changes, as a read that landed just before them
// does, and changeReads records the since of every change list read.
type City = {
  changes: CityChange[]
  quietAt: (marker: bigint) => boolean
  mapFails: Set<string>
  feedBehindOnce?: number
  changeReads?: string[]
}

function cityMarker(city: City): string {
  return String(20 + city.changes.length)
}

async function routeCity(page: Page, city: City): Promise<{ maps: string[] }> {
  const maps: string[] = []
  const changedAt = new Date(fixedTime.getTime() - MINUTE_MS).toISOString()
  const notesAt = (marker: string) => city.changes
    .slice(0, Number(marker) - 20)
    .some(change => change.kind === 'note')
    ? [{ id: 22, place_id: 77, author: 'leafwalker', body: DEEP_NOTE, truncated: false, created_at: changedAt }]
    : []
  const outline = (marker: string) => ({
    ...SNAPSHOT,
    change_marker: marker,
    places: SNAPSHOT.places.map(place => place.id === 11
      ? { ...place, name: 'plaza_at_' + marker }
      : { ...place }),
    notes: [...notesAt(marker), ...SNAPSHOT.notes],
  })
  await page.unroute('**/api/changes**')
  await page.route('**/api/changes**', async route => {
    const since = new URL(route.request().url()).searchParams.get('since')
    if (!since) return route.fulfill({ status: 503, json: { error: 'no marker in this test' } })
    city.changeReads = [...(city.changeReads ?? []), since]
    const visible = city.changes.slice(0, city.changes.length - (city.feedBehindOnce ?? 0))
    city.feedBehindOnce = 0
    const marker = String(20 + visible.length)
    const changes = visible.flatMap((change, index) => {
      const id = String(21 + index)
      if (BigInt(id) <= BigInt(since)) return []
      const detail = change.kind === 'note'
        ? { place_id: change.placeId, note_id: 22 }
        : { place_id: change.placeId }
      return [{ change_id: id, kind: change.kind, actor: 'far-walker', detail, created_at: changedAt }]
    }).reverse()
    return route.fulfill({ json: {
      change_marker: marker, changes, returned_items: changes.length,
      unchanged: changes.length === 0, has_more: false, next_since: marker,
    } })
  })
  await page.route('**/api/window**', async route => {
    const url = new URL(route.request().url())
    const collection = url.searchParams.get('collection')
    const marker = url.searchParams.get('after_change_marker')
    if (collection === 'lines' || url.searchParams.get('view') === 'directory' || !marker) {
      return route.fallback()
    }
    if (!collection) return route.fulfill({ json: outline(cityMarker(city)) })
    const page = { has_more: false, next_before_id: null, change_marker: marker }
    if (collection === 'notes') return route.fulfill({ json: { ...page, notes: notesAt(marker) } })
    if (collection === 'things') return route.fulfill({ json: { ...page, things: [] } })
    if (collection === 'agreements') return route.fulfill({ json: { ...page, agreements: [] } })
    return route.fallback()
  })
  await page.route('**/api/events**', async route => {
    const marker = new URL(route.request().url()).searchParams.get('after_change_marker')
    if (!marker) return route.fallback()
    return route.fulfill({ json: { events: [], has_more: false, next_before_id: null, change_marker: marker } })
  })
  await page.route('**/api/map**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('parent_id') !== '77') return route.fallback()
    maps.push(url.toString())
    const marker = url.searchParams.get('after_change_marker') ?? '20'
    if (city.mapFails.has(marker)) {
      return route.fulfill({ status: 503, json: { error: 'test place read failure' } })
    }
    return route.fulfill({ json: {
      ...FOCUSED_PLACE,
      change_marker: marker,
      place: { ...FOCUSED_PLACE.place, quiet: city.quietAt(BigInt(marker)) },
    } })
  })
  return { maps }
}

function mapReadsAt(maps: readonly string[], marker: string): number {
  return maps.filter(value => new URL(value).searchParams.get('after_change_marker') === marker).length
}

function talkLines() {
  return linesPage([
    { id: 102, place_id: 77, author: 'leafwalker', body: DEEP_LINE, created_at: talkLineTime(MINUTE_MS, fixedTime.getTime()) },
    { id: 101, place_id: 11, author: 'leafwalker', body: OPEN_LINE, created_at: talkLineTime(2 * MINUTE_MS, fixedTime.getTime()) },
  ])
}

async function openTalkWithNoPlace(page: Page, requests: TalkRequests) {
  await page.locator('#talk-tab').click()
  await expect(page.locator('#talk-panel')).toBeVisible()
  await expect.poll(() => requests.talkNow.length).toBe(1)
  await expect(page.locator('#talk-lines')).toContainText(DEEP_LINE)
  await expect(page.locator('#talk-lines')).toContainText(OPEN_LINE)
}

test('Talk with no place picked hides a deep room\'s lines one check after it turns quiet, while the names directory still says it is open', async ({ page }) => {
  const city: City = { changes: [], quietAt: marker => marker >= 21n, mapFails: new Set() }
  const { maps } = await routeCity(page, city)
  const requests = await routeTalk(page, {
    now: () => talkNow({ placeMarker: cityMarker(city) }),
    lines: talkLines(),
  })
  await openTalkWithNoPlace(page, requests)
  expect(maps).toHaveLength(0)

  city.changes.push({ kind: 'place_edited', placeId: 77 })
  await stepTalk(page, 2_000, requests, { talkNow: 2, checks: 2 })
  await expect(page.locator('#talk-lines')).toContainText('in plaza_at_21')
  await expect(page.locator('#talk-lines .talk-line-quiet')).toHaveCount(1)
  await expect(page.locator('#talk-lines .talk-line-quiet')).toContainText('1 line in quiet_annex.')
  await expect(page.locator('#talk-lines')).not.toContainText(DEEP_LINE)
  await expect(page.locator('#talk-lines')).toContainText(OPEN_LINE)
  expect(mapReadsAt(maps, '21')).toBe(1)
  expect(maps).toHaveLength(1)
  expect(requests.lines).toHaveLength(1)
})

test('a Conversations tab open on its own hides a deep room\'s note at its next minute refresh, while the names directory still says it is open', async ({ page }) => {
  const city: City = { changes: [], quietAt: marker => marker >= 22n, mapFails: new Set() }
  const { maps } = await routeCity(page, city)
  const requests = await routeTalk(page)
  await page.locator('[data-view="conversations"]').click()
  await expect(page.locator('#conversation-stream')).toBeVisible()

  city.changes.push({ kind: 'note', placeId: 77 })
  await page.clock.fastForward(MINUTE_MS)
  await expect(page.locator('#conversation-stream')).toContainText(DEEP_NOTE)
  expect(maps).toHaveLength(0)

  city.changes.push({ kind: 'place_edited', placeId: 77 })
  await page.clock.fastForward(MINUTE_MS)
  await expect(page.locator('#conversation-stream .note-card-quiet')).toHaveCount(1)
  await expect(page.locator('#conversation-stream .note-card-quiet')).toContainText('A note in quiet_annex.')
  await expect(page.locator('#conversation-stream')).not.toContainText(DEEP_NOTE)
  expect(mapReadsAt(maps, '22')).toBe(1)
  expect(maps).toHaveLength(1)
  expect(requests.talkNow).toHaveLength(0)
  expect(requests.lines).toHaveLength(0)
})

test('an edited room whose own read fails is read again at the next refresh that moves the marker', async ({ page }) => {
  const city: City = { changes: [], quietAt: marker => marker >= 21n, mapFails: new Set(['21']) }
  const { maps } = await routeCity(page, city)
  const requests = await routeTalk(page, {
    now: () => talkNow({ placeMarker: cityMarker(city) }),
    lines: talkLines(),
  })
  await openTalkWithNoPlace(page, requests)

  city.changes.push({ kind: 'place_edited', placeId: 77 })
  await stepTalk(page, 2_000, requests, { talkNow: 2, checks: 2 })
  await expect(page.locator('#talk-lines')).toContainText('in plaza_at_21')
  expect(mapReadsAt(maps, '21')).toBe(1)

  city.changes.push({ kind: 'place_edited', placeId: 11 })
  await stepTalk(page, 2_000, requests, { talkNow: 3, checks: 3 })
  await expect(page.locator('#talk-lines')).toContainText('in plaza_at_22')
  await expect(page.locator('#talk-lines .talk-line-quiet')).toHaveCount(1)
  await expect(page.locator('#talk-lines')).not.toContainText(DEEP_LINE)
  expect(mapReadsAt(maps, '22')).toBe(1)
  expect(maps).toHaveLength(2)
})

test('picking a room a refresh read earlier, after the city moved on, reads it again at once instead of saying it is loading', async ({ page }) => {
  const city: City = { changes: [], quietAt: () => false, mapFails: new Set() }
  const { maps } = await routeCity(page, city)
  const requests = await routeTalk(page, {
    now: () => talkNow({ placeMarker: cityMarker(city) }),
    lines: talkLines(),
  })
  await openTalkWithNoPlace(page, requests)

  city.changes.push({ kind: 'place_edited', placeId: 77 })
  await stepTalk(page, 2_000, requests, { talkNow: 2, checks: 2 })
  await expect(page.locator('#talk-lines')).toContainText('in plaza_at_21')
  expect(mapReadsAt(maps, '21')).toBe(1)

  city.changes.push({ kind: 'place_edited', placeId: 11 })
  await stepTalk(page, 2_000, requests, { talkNow: 3, checks: 3 })
  await expect(page.locator('#talk-lines')).toContainText('in plaza_at_22')
  expect(maps).toHaveLength(1)

  await page.evaluate(() => { window.location.hash = '#view=talk&place=77' })
  await expect.poll(() => mapReadsAt(maps, '22')).toBe(1)
  await expect(page.locator('#talk-lines')).toContainText(DEEP_LINE)
  await expect(page.locator('#talk-panel')).not.toContainText('Loading public place')
  expect(maps).toHaveLength(2)
})

test('a picked room whose read failed at the edit that opened it is read again once it is unpicked', async ({ page }) => {
  const city: City = { changes: [], quietAt: marker => marker === 21n, mapFails: new Set(['22']) }
  const { maps } = await routeCity(page, city)
  const requests = await routeTalk(page, {
    now: () => talkNow({ placeMarker: cityMarker(city) }),
    lines: talkLines(),
  })
  await page.evaluate(() => { window.location.hash = '#view=talk&place=77' })
  await expect(page.locator('#talk-panel')).toBeVisible()
  await expect.poll(() => requests.talkNow.length).toBe(1)
  await expect(page.locator('#talk-lines')).toContainText(DEEP_LINE)

  city.changes.push({ kind: 'place_edited', placeId: 77 })
  await stepTalk(page, 2_000, requests, { talkNow: 2, checks: 2 })
  await expect(page.locator('#talk-lines .talk-line-quiet')).toHaveCount(1)
  expect(mapReadsAt(maps, '21')).toBe(1)

  city.changes.push({ kind: 'place_edited', placeId: 77 })
  await stepTalk(page, 2_000, requests, { talkNow: 3, checks: 3 })
  await expect.poll(() => mapReadsAt(maps, '22')).toBe(1)

  await page.evaluate(() => { window.location.hash = '#view=talk' })
  city.changes.push({ kind: 'place_edited', placeId: 11 })
  await expect.poll(async () => {
    await page.clock.runFor(2_000)
    return mapReadsAt(maps, '23')
  }).toBe(1)
  await expect(page.locator('#talk-lines')).toContainText('in plaza_at_23')
  await expect(page.locator('#talk-lines')).toContainText(DEEP_LINE)
  await expect(page.locator('#talk-lines .talk-line-quiet')).toHaveCount(0)
  expect(mapReadsAt(maps, '22')).toBe(1)
})

test('a place edit that lands between the change list and a newer outline is still read', async ({ page }) => {
  const city: City = { changes: [], quietAt: marker => marker >= 22n, mapFails: new Set() }
  const { maps } = await routeCity(page, city)
  const requests = await routeTalk(page, {
    now: () => talkNow({ placeMarker: cityMarker(city) }),
    lines: talkLines(),
  })
  await openTalkWithNoPlace(page, requests)

  city.changes.push({ kind: 'place_edited', placeId: 11 }, { kind: 'place_edited', placeId: 77 })
  city.feedBehindOnce = 1
  await stepTalk(page, 2_000, requests, { talkNow: 2, checks: 2 })
  await expect(page.locator('#talk-lines')).toContainText('in plaza_at_22')
  await expect(page.locator('#talk-lines .talk-line-quiet')).toHaveCount(1)
  await expect(page.locator('#talk-lines')).not.toContainText(DEEP_LINE)
  expect(mapReadsAt(maps, '22')).toBe(1)
  expect(maps).toHaveLength(1)
  expect(city.changeReads).toEqual(['20', '21'])
})

test('a deep room that turned quiet stays hidden when a later change moves the marker, and shows again after the edit that opens it', async ({ page }) => {
  const city: City = { changes: [], quietAt: marker => marker === 21n || marker === 22n, mapFails: new Set() }
  const { maps } = await routeCity(page, city)
  const requests = await routeTalk(page, {
    now: () => talkNow({ placeMarker: cityMarker(city) }),
    lines: talkLines(),
  })
  await openTalkWithNoPlace(page, requests)

  city.changes.push({ kind: 'place_edited', placeId: 77 })
  await stepTalk(page, 2_000, requests, { talkNow: 2, checks: 2 })
  await expect(page.locator('#talk-lines')).toContainText('in plaza_at_21')
  await expect(page.locator('#talk-lines .talk-line-quiet')).toHaveCount(1)

  city.changes.push({ kind: 'place_edited', placeId: 11 })
  await stepTalk(page, 2_000, requests, { talkNow: 3, checks: 3 })
  await expect(page.locator('#talk-lines')).toContainText('in plaza_at_22')
  await expect(page.locator('#talk-lines .talk-line-quiet')).toHaveCount(1)
  await expect(page.locator('#talk-lines')).not.toContainText(DEEP_LINE)
  expect(mapReadsAt(maps, '22')).toBe(0)

  city.changes.push({ kind: 'place_edited', placeId: 77 })
  await stepTalk(page, 2_000, requests, { talkNow: 4, checks: 4 })
  await expect(page.locator('#talk-lines')).toContainText('in plaza_at_23')
  await expect(page.locator('#talk-lines')).toContainText(DEEP_LINE)
  await expect(page.locator('#talk-lines .talk-line-quiet')).toHaveCount(0)
  expect(mapReadsAt(maps, '23')).toBe(1)
  expect(maps).toHaveLength(2)
  expect(requests.lines).toHaveLength(1)
})
