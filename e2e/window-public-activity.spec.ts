import { expect, test, type Page, type Route } from '@playwright/test'
import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'
import { WINDOW_CSS } from '../src/window-style.ts'
import { DIRECTORY, SNAPSHOT } from './helpers/public-window-snapshot-fixtures.ts'

const NOW = new Date('2026-10-28T12:00:00.000Z')
const BANDS = ['active now', 'today', 'this week', 'longer'] as const
type Band = typeof BANDS[number]
type ActivityCity = {
  residents: number
  band: Band | undefined
  roomBand: Band | undefined
  failPresence: boolean
  failPlace: boolean
  failSnapshot: boolean
  quiet: boolean
  moderated: boolean
  feed: boolean
  presence: URL[]
  places: URL[]
  heldPresence: Route | null
  holdPresence: boolean
}

function residentRows(city: ActivityCity, activity: boolean) {
  return Array.from({ length: city.residents }, (_, index) => ({
    id: 500 + city.residents - index,
    handle: 'marker-' + String(index + 1),
    current_place_id: 11,
    joined_at: new Date(NOW.getTime() - index * 1000).toISOString(),
    asleep: index === 1,
    has_drawing: false,
    ...(activity && city.band ? { last_active: city.band } : {}),
  }))
}

function presenceBody(city: ActivityCity, url: URL) {
  const rows = residentRows(city, true)
  const before = Number(url.searchParams.get('before_id') || Number.MAX_SAFE_INTEGER)
  const eligible = rows.filter(row => row.id < before)
  const limit = Number(url.searchParams.get('limit') || 200)
  const residents = eligible.slice(0, limit)
  return { residents, total: city.residents, has_more: eligible.length > residents.length,
    next_before_id: residents.at(-1)?.id ?? null, change_marker: '20' }
}

async function mount(page: Page, count = 4) {
  const city: ActivityCity = { residents: count, band: 'active now', roomBand: 'today',
    failPresence: false, failPlace: false, failSnapshot: false, quiet: false,
    moderated: false, feed: false, presence: [], places: [], heldPresence: null,
    holdPresence: false }
  await page.clock.install({ time: NOW })
  await page.clock.pauseAt(new Date(NOW.getTime() + 1))
  await page.goto('/__e2e/health')
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/window') {
      if (url.searchParams.get('view') === 'directory') {
        return route.fulfill({ json: { ...DIRECTORY, residents: [
          ...residentRows(city, false), { id: 9900, handle: 'marker-far' },
        ] } })
      }
      if (city.failSnapshot) return route.fulfill({ status: 503, json: { error: 'City read failed.' } })
      const collection = url.searchParams.get('collection')
      if (collection) return route.fulfill({ json: { [collection]: [], has_more: false,
        next_before_id: null, change_marker: '20' } })
      const residents = residentRows(city, false)
      return route.fulfill({ json: { ...SNAPSHOT, residents,
        places: SNAPSHOT.places.map(place => ({ ...place, owner: 'marker-1', quiet: city.quiet,
          moderated: city.moderated })),
        totals: { ...SNAPSHOT.totals, residents: count },
        shown: { ...SNAPSHOT.shown, residents: count },
        pages: { ...SNAPSHOT.pages, residents: { has_more: false, next_before_id: null } } } })
    }
    if (url.pathname === '/api/changes') return route.fulfill({ json: {
      change_marker: '20', changes: [], returned_items: 0, unchanged: true,
      has_more: false, next_since: '20' } })
    if (url.pathname === '/api/residents') {
      city.presence.push(url)
      if (city.holdPresence) { city.heldPresence = route; return }
      if (city.failPresence) return route.fulfill({ status: 503, json: { error: 'Residents could not be read.' } })
      if (url.searchParams.has('handle')) return route.fulfill({ json: {
        resident: { ...residentRows(city, true)[0], id: 9900, handle: 'marker-far' },
        change_marker: '20' } })
      return route.fulfill({ json: presenceBody(city, url) })
    }
    if (/^\/api\/place\/\d+$/u.test(url.pathname)) {
      city.places.push(url)
      if (city.failPlace) return route.fulfill({ status: 503, json: { error: 'Place could not be read.' } })
      return route.fulfill({ json: { place: { id: Number(url.pathname.split('/').at(-1)),
        description: 'Room words stay readable.', labels: [], laws: [], quiet: city.quiet,
        moderated: city.moderated, feed: city.feed,
        ...(city.roomBand ? { last_active: city.roomBand } : {}) }, change_marker: '20' } })
    }
    if (url.pathname === '/api/events') return route.fulfill({ json: {
      events: [], has_more: false, next_before_id: null, change_marker: '20' } })
    return route.fulfill({ status: 404, json: { error: 'No public record was found.' } })
  })
  await page.setContent(WINDOW_HTML.replace(/\s*<script src="\/window\.js" defer><\/script>/u, ''))
  await page.addStyleTag({ content: WINDOW_CSS })
  await page.addScriptTag({ content: WINDOW_JS })
  await expect(page.locator('#window-status')).toContainText('Watching')
  return city
}

async function refresh(page: Page, city: ActivityCity) {
  const before = city.presence.length
  await page.clock.fastForward(60_000)
  await expect.poll(() => city.presence.length).toBeGreaterThan(before)
  await expect(page.locator('#window-status')).toContainText('Watching')
}

test('453 residents use three presence pages and keep asleep beside the band', async ({ page }) => {
  const city = await mount(page, 453)
  await expect(page.locator('#resident-roster .public-activity')).toHaveCount(453)
  expect(city.presence).toHaveLength(3)
  expect(city.presence.map(url => Number(url.searchParams.get('limit')))).toEqual([200, 200, 53])
  expect(city.presence.every(url => url.searchParams.get('view') === 'presence' &&
    !url.searchParams.has('handle'))).toBe(true)
  const asleep = page.locator('#resident-roster .resident-row.asleep')
  await expect(asleep).toContainText('asleep')
  await expect(asleep.locator('.public-activity')).toHaveText('active now')
  city.band = 'longer'
  await refresh(page, city)
  await expect(asleep.locator('.public-activity')).toHaveText('longer')
  expect(city.presence).toHaveLength(6)
})

test('all four bands refresh without a new event and omission leaves no marker element', async ({ page }) => {
  const city = await mount(page)
  for (const band of BANDS) {
    city.band = band
    await refresh(page, city)
    await expect(page.locator('#resident-roster .public-activity').first()).toHaveText(band)
  }
  city.band = undefined
  await refresh(page, city)
  await expect(page.locator('.public-activity')).toHaveCount(0)
  await expect(page.locator('#resident-roster')).not.toContainText(/hidden|unavailable|no history|off/u)
  await expect(page.locator('#resident-roster .asleep')).toContainText('asleep')
})

test('selected room gets its band from one outline read and replaces absence', async ({ page }) => {
  const city = await mount(page)
  await page.evaluate(() => { window.location.hash = '#view=place&place=11' })
  await expect(page.locator('#place-focus-summary .public-activity')).toHaveText('today')
  expect(city.places).toHaveLength(1)
  expect(city.places[0]?.searchParams.get('view')).toBe('outline')
  city.roomBand = undefined
  await refresh(page, city)
  await expect(page.locator('#place-focus-summary .public-activity')).toHaveCount(0)
  await expect(page.locator('#place-description')).toContainText('Room words stay readable.')
})

test('failed presence and room reads clear bands while cached prose stays readable', async ({ page }) => {
  const city = await mount(page)
  await page.evaluate(() => { window.location.hash = '#view=place&place=11' })
  await expect(page.locator('#place-focus-summary .public-activity')).toHaveText('today')
  city.failPresence = true
  city.failPlace = true
  city.failSnapshot = true
  await page.clock.fastForward(60_000)
  await expect(page.locator('#window-status')).toContainText('previous completed view')
  await expect(page.locator('.public-activity')).toHaveCount(0)
  await expect(page.locator('#place-description')).toContainText('Room words stay readable.')
})

test('hidden and resumed tabs clear markers and a late old presence reply cannot restore them', async ({ page }) => {
  const city = await mount(page)
  await expect(page.locator('#resident-roster .public-activity')).toHaveCount(4)
  city.holdPresence = true
  await page.clock.fastForward(60_000)
  await expect.poll(() => city.heldPresence !== null).toBe(true)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page.locator('.public-activity')).toHaveCount(0)
  const held = city.heldPresence!
  await held.fulfill({ json: presenceBody(city, new URL(held.request().url())) })
  await expect(page.locator('.public-activity')).toHaveCount(0)
  city.holdPresence = false
  city.band = undefined
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page.locator('#window-status')).toContainText('Watching')
  await expect(page.locator('.public-activity')).toHaveCount(0)
})

test('quiet moderated and feed rooms never show a room band', async ({ page }) => {
  const city = await mount(page)
  city.feed = true
  await page.evaluate(() => { window.location.hash = '#view=place&place=11' })
  await expect(page.locator('#place-description')).toContainText('Room words stay readable.')
  await expect(page.locator('#place-focus-summary .public-activity')).toHaveCount(0)
  city.feed = false
  city.quiet = true
  await refresh(page, city)
  await expect(page.locator('#place-focus-summary .public-activity')).toHaveCount(0)
  city.quiet = false
  city.moderated = true
  await refresh(page, city)
  await expect(page.locator('#place-focus-summary .public-activity')).toHaveCount(0)
})

test('focused resident overlays refresh omission even when the roster and event marker stay equal', async ({ page }) => {
  const city = await mount(page)
  await page.evaluate(() => { window.location.hash = '#view=map&resident=marker-far' })
  await expect(page.locator('#resident-roster .public-activity')).toHaveText('active now')
  const count = city.presence.filter(url => url.searchParams.has('handle')).length
  city.band = undefined
  await refresh(page, city)
  await expect.poll(() => city.presence.filter(url => url.searchParams.has('handle')).length)
    .toBeGreaterThan(count)
  await expect(page.locator('#resident-roster .public-activity')).toHaveCount(0)
  city.band = 'this week'
  await refresh(page, city)
  await expect(page.locator('#resident-roster .public-activity')).toHaveText('this week')
  city.failPresence = true
  city.failSnapshot = true
  await page.clock.fastForward(60_000)
  await expect(page.locator('#window-status')).toContainText('previous completed view')
  await expect(page.locator('.public-activity')).toHaveCount(0)
})

test('selection changes discard late room bands and never reuse a cached marker', async ({ page }) => {
  const city = await mount(page)
  let held: Route | null = null
  let shouldHold = true
  await page.route('**/api/place/11**', async route => {
    if (shouldHold) { held = route; return }
    return route.fulfill({ status: 503, json: { error: 'Place could not be read.' } })
  })
  await page.evaluate(() => { window.location.hash = '#view=place&place=11' })
  await expect.poll(() => held !== null).toBe(true)
  await page.locator('#place-filter').selectOption('12')
  await expect(page.locator('#place-focus-summary .public-activity')).toHaveText('today')
  await held!.fulfill({ json: { place: { id: 11, description: 'Older room reply.',
    labels: [], laws: [], last_active: 'longer' } } })
  await expect(page.locator('#place-focus-summary .public-activity')).toHaveText('today')
  shouldHold = false
  await page.locator('#place-filter').selectOption('11')
  await expect(page.locator('#place-focus-summary .public-activity')).toHaveCount(0)
  await expect(page.locator('#place-description')).not.toContainText('Older room reply.')
  expect(city.places.filter(url => url.pathname === '/api/place/12')).toHaveLength(1)
})

test('muting the selected room removes both room and resident markers', async ({ page }) => {
  await mount(page)
  await page.evaluate(() => { window.location.hash = '#view=place&place=11' })
  await expect(page.locator('#place-focus-summary .public-activity')).toHaveText('today')
  await page.locator('#place-focus-summary .mute-menu summary').click()
  await page.locator('#place-focus-summary').getByRole('button', { name: /^Mute place /u }).click()
  await expect(page.locator('#place-focus-summary .public-activity')).toHaveCount(0)
  await expect(page.locator('#place-occupants .public-activity')).toHaveCount(0)
})

test('returning to a cached room keeps its prose but requires a fresh band', async ({ page }) => {
  const city = await mount(page)
  await page.evaluate(() => { window.location.hash = '#view=place&place=11' })
  await expect(page.locator('#place-focus-summary .public-activity')).toHaveText('today')
  await page.locator('#place-filter').selectOption('12')
  await expect(page.locator('#place-focus-title')).toHaveText('inner_hall')
  await expect(page.locator('#place-focus-summary .public-activity')).toHaveText('today')
  city.failPlace = true
  await page.locator('#place-filter').selectOption('11')
  await expect.poll(() => city.places.filter(url => url.pathname === '/api/place/11').length)
    .toBe(2)
  await expect(page.locator('#place-focus-summary .public-activity')).toHaveCount(0)
  await expect(page.locator('#place-description')).toContainText('Room words stay readable.')
})

test('a room reply from a hidden tab cannot restore its band before a fresh read', async ({ page }) => {
  const city = await mount(page)
  let held: Route | null = null
  await page.route('**/api/place/11**', async route => {
    if (!held) { held = route; return }
    return route.fallback()
  })
  await page.evaluate(() => { window.location.hash = '#view=place&place=11' })
  await expect.poll(() => held !== null).toBe(true)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await held!.fulfill({ json: { place: { id: 11, description: 'Older room reply.',
    labels: [], laws: [], last_active: 'longer' } } })
  await expect(page.locator('.public-activity')).toHaveCount(0)
  city.roomBand = 'this week'
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page.locator('#place-focus-summary .public-activity')).toHaveText('this week')
  await expect(page.locator('#place-description')).not.toContainText('Older room reply.')
})

test('a late focused resident reply cannot replace fresh omission after a tab resumes', async ({ page }) => {
  const city = await mount(page)
  let held: Route | null = null
  await page.route('**/api/residents?**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('handle') === 'marker-far' && !held) { held = route; return }
    return route.fallback()
  })
  await page.locator('#resident-filter').selectOption('marker-far')
  await expect.poll(() => held !== null).toBe(true)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  city.band = undefined
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page.locator('#resident-roster .resident-follow')).toHaveText('marker-far')
  await expect.poll(() => city.presence.filter(url => url.searchParams.has('handle')).length).toBe(1)
  await held!.fulfill({ json: { resident: { ...residentRows(city, false)[0],
    id: 9900, handle: 'marker-far', last_active: 'active now' }, change_marker: '20' } })
  await expect(page.locator('.public-activity')).toHaveCount(0)
})

test('selecting a known resident clears retained bands and rejects a held roster reply', async ({ page }) => {
  const city = await mount(page)
  await expect(page.locator('#resident-roster .public-activity')).toHaveCount(4)
  city.holdPresence = true
  await page.clock.fastForward(60_000)
  await expect.poll(() => city.heldPresence !== null).toBe(true)
  const held = city.heldPresence!
  await page.locator('#resident-filter').selectOption('marker-1')
  await expect.poll(() => city.heldPresence !== held).toBe(true)
  await expect(page.locator('.public-activity')).toHaveCount(0)
  await held.fulfill({ json: presenceBody(city, new URL(held.request().url())) })
  await expect(page.locator('.public-activity')).toHaveCount(0)
  city.holdPresence = false
  city.band = undefined
  const selectedRead = city.heldPresence!
  await selectedRead.fulfill({ json: presenceBody(city, new URL(selectedRead.request().url())) })
  await expect(page.locator('#window-status')).toContainText('Watching')
  await expect(page.locator('.public-activity')).toHaveCount(0)
})
