import { expect, test, type Locator, type Page } from '@playwright/test'
import { registerPublicWindowSetup } from './helpers/public-window-setup.ts'
import { DIRECTORY } from './helpers/public-window-snapshot-fixtures.ts'
import { linesPage, routeTalk, talkNow } from './helpers/window-talk-fixtures.ts'

registerPublicWindowSetup()

// Talk is a ledger on paper at every width: no sideways page scroll, every line
// wraps whole inside its own box, the transcript scrolls inside itself, and the
// Older and Newer buttons are full touch targets on a phone.

const QUIET_PLACE = Object.freeze({ id: 79, parent_id: 11, name: 'hidden_nook', quiet: true })
const UNBROKEN_WORD = 'lanternlight'.repeat(20)
const FIRST_LINE_ID = 301
const MINUTE_MS = 60_000
const TOUCH_TARGET_PX = 44
const PHONE_VISIBLE_LINES = 10

type Spoken = Readonly<{ placeId: number; author: string; body: string }> | 'removed'

// Thirty rows, oldest first: ten short lines at the top, then mixed lengths, a
// 240-byte unbroken word, a quiet run of three, one removed row, and a 32-character handle.
const SPOKEN: readonly Spoken[] = Object.freeze([
  { placeId: 11, author: 'leafwalker', body: 'Morning, all.' },
  { placeId: 11, author: 'far-walker', body: 'Map by the steps.' },
  { placeId: 12, author: 'tin-lantern', body: 'Lamps: twelve?' },
  { placeId: 12, author: 'leafwalker', body: 'Twelve, yes.' },
  { placeId: 11, author: 'marsh-reader', body: 'ok' },
  { placeId: 12, author: 'tin-lantern', body: 'Thirteen now.' },
  { placeId: 11, author: 'far-walker', body: 'Noted.' },
  { placeId: 11, author: 'leafwalker', body: 'East door stuck?' },
  { placeId: 11, author: 'marsh-reader', body: 'Not for me.' },
  { placeId: 12, author: 'tin-lantern', body: 'Only when full.' },
  {
    placeId: 11,
    author: 'far-walker',
    body: 'I walked the whole ring road this morning and wrote down every sign, bench, and dark lamp I passed, so the next walker can check my list against what they see and tell me where I went wrong.',
  },
  { placeId: 79, author: 'nook-keeper', body: 'QuietTalkOneZq9k7' },
  { placeId: 79, author: 'nook-keeper', body: 'QuietTalkTwoZq9k7' },
  { placeId: 79, author: 'moss-sister', body: 'QuietTalkThreeZq9k7' },
  { placeId: 11, author: 'leafwalker', body: 'Something is going on in the nook. I will not repeat it here.' },
  'removed',
  { placeId: 11, author: 'marsh-reader', body: UNBROKEN_WORD },
  { placeId: 12, author: 'tin-lantern', body: 'That is a very long lantern.' },
  { placeId: 11, author: 'far-walker', body: 'Agreed.' },
  { placeId: 12, author: 'the-resident-with-a-long-handle1', body: 'Long names wrap too.' },
  {
    placeId: 11,
    author: 'leafwalker',
    body: 'The plaza clock is two minutes slow again. I set it by the fountain, which is never wrong.',
  },
  { placeId: 77, author: 'far-walker', body: 'The annex is warm today.' },
  { placeId: 11, author: 'tin-lantern', body: 'Anyone want to trade a compass for a lantern?' },
  { placeId: 11, author: 'marsh-reader', body: 'Maybe. What kind of compass?' },
  { placeId: 11, author: 'tin-lantern', body: 'Brass. It points at the plaza no matter where you stand.' },
  { placeId: 11, author: 'marsh-reader', body: 'Then it is broken.' },
  { placeId: 11, author: 'tin-lantern', body: 'Or very loyal.' },
  { placeId: 12, author: 'leafwalker', body: 'Heading into the inner hall now.' },
  { placeId: 12, author: 'far-walker', body: 'See you there.' },
  { placeId: 12, author: 'leafwalker', body: 'Here.' },
])

const RENDERED_ROWS = SPOKEN.length - 2
const BODY_ROWS = SPOKEN.length - 4

function newestRows(nowMs: number): readonly unknown[] {
  return SPOKEN.map((spoken, index) => {
    const id = FIRST_LINE_ID + index
    if (spoken === 'removed') return { id, moderated: true }
    return {
      id,
      place_id: spoken.placeId,
      author: spoken.author,
      body: spoken.body,
      created_at: new Date(nowMs - (SPOKEN.length - index) * 9 * MINUTE_MS).toISOString(),
    }
  }).reverse()
}

function olderRows(nowMs: number): readonly unknown[] {
  return [3, 2, 1].map(step => ({
    id: FIRST_LINE_ID - step,
    place_id: 11,
    author: 'leafwalker',
    body: 'An older line from two days ago.',
    created_at: new Date(nowMs - 2 * 24 * 60 * MINUTE_MS - step * MINUTE_MS).toISOString(),
  }))
}

async function routeQuietDirectory(page: Page) {
  await page.route('**/api/window**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('view') !== 'directory') return route.fallback()
    await route.fulfill({ json: { ...DIRECTORY, places: [...DIRECTORY.places, QUIET_PLACE] } })
  })
}

async function expectNoSidewaysScroll(page: Page, label: string) {
  const widths = await page.evaluate(() => ({
    scrollWidth: document.scrollingElement?.scrollWidth ?? Number.POSITIVE_INFINITY,
    innerWidth: window.innerWidth,
  }))
  expect(widths.scrollWidth, `${label}: ${JSON.stringify(widths)}`).toBeLessThanOrEqual(widths.innerWidth)
}

async function expectLinesWrapWhole(page: Page) {
  const bodies = await page.locator('#talk-lines .talk-body').evaluateAll(nodes => nodes.map(node => ({
    text: (node.textContent ?? '').slice(0, 24),
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  })))
  expect(bodies).toHaveLength(BODY_ROWS)
  for (const body of bodies) {
    expect(body.clientWidth, JSON.stringify(body)).toBeGreaterThan(0)
    expect(body.scrollWidth, JSON.stringify(body)).toBeLessThanOrEqual(body.clientWidth + 1)
  }
  const rows = await page.locator('#talk-lines > li').evaluateAll(nodes => nodes.map(node => ({
    text: (node.textContent ?? '').slice(0, 24),
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  })))
  expect(rows).toHaveLength(RENDERED_ROWS)
  for (const row of rows) {
    expect(row.scrollWidth, JSON.stringify(row)).toBeLessThanOrEqual(row.clientWidth + 1)
  }
}

async function expectTranscriptScrollsInside(page: Page) {
  const scroll = await page.locator('#talk-lines').evaluate(node => {
    const pageTop = document.scrollingElement?.scrollTop ?? 0
    node.scrollTop = 0
    const top = node.scrollTop
    node.scrollTop = node.scrollHeight
    return {
      overflowY: getComputedStyle(node).overflowY,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      top,
      bottom: node.scrollTop,
      pageMoved: (document.scrollingElement?.scrollTop ?? 0) !== pageTop,
    }
  })
  const operands = JSON.stringify(scroll)
  expect(['auto', 'scroll'], operands).toContain(scroll.overflowY)
  expect(scroll.scrollHeight, operands).toBeGreaterThan(scroll.clientHeight)
  expect(scroll.top, operands).toBe(0)
  expect(scroll.bottom, operands).toBeGreaterThan(0)
  expect(scroll.pageMoved, operands).toBe(false)
}

async function expectTouchTarget(button: Locator, label: string) {
  await expect(button).toBeVisible()
  const box = await button.boundingBox()
  expect(box?.height ?? 0, `${label}: ${JSON.stringify(box)}`).toBeGreaterThanOrEqual(TOUCH_TARGET_PX)
}

// The top of the transcript holds ten short lines; all ten fit inside the box at
// once, and the box itself fits on the screen.
async function expectTenShortLinesVisible(page: Page) {
  const seen = await page.locator('#talk-lines').evaluate(node => {
    node.scrollTop = 0
    const frame = node.getBoundingClientRect()
    const top = frame.top + node.clientTop
    const bottom = top + node.clientHeight
    const inside = [...node.children].filter(child => {
      const box = child.getBoundingClientRect()
      return box.top >= top - 0.5 && box.bottom <= bottom + 0.5
    }).length
    return { inside, boxHeight: frame.height, innerHeight: window.innerHeight }
  })
  const operands = JSON.stringify(seen)
  expect(seen.inside, operands).toBeGreaterThanOrEqual(PHONE_VISIBLE_LINES)
  expect(seen.boxHeight, operands).toBeLessThanOrEqual(seen.innerHeight)
}

const SIZES = Object.freeze([
  { width: 320, height: 640, phone: true },
  { width: 375, height: 812, phone: true },
  { width: 1_440, height: 900, phone: false },
])

for (const size of SIZES) {
  test(`Talk at ${size.width}x${size.height} never scrolls sideways, wraps every line whole, and scrolls the transcript inside itself`, async ({ page }) => {
    expect(new TextEncoder().encode(UNBROKEN_WORD).byteLength).toBe(240)
    await page.setViewportSize({ width: size.width, height: size.height })
    const nowMs = Date.now()
    await routeTalk(page, {
      now: talkNow(),
      lines: url => url.searchParams.has('before_id')
        ? linesPage(olderRows(nowMs))
        : linesPage(newestRows(nowMs), true),
    })
    await routeQuietDirectory(page)
    await page.goto('/window#view=talk')

    const panel = page.locator('#talk-panel')
    await expect(panel.locator('#talk-lines > li')).toHaveCount(RENDERED_ROWS)
    await expect(panel.locator('.talk-line-quiet .quiet-room-context')).toHaveText('3 lines in hidden_nook.')
    await expect(panel.locator('.talk-line-removed')).toHaveText('Removed by the maintainer.')
    await expect(panel.locator('.talk-body').filter({ hasText: UNBROKEN_WORD })).toHaveCount(1)

    const label = `${size.width}x${size.height}`
    await expectNoSidewaysScroll(page, `${label} newest page`)
    await expectLinesWrapWhole(page)
    await expectTranscriptScrollsInside(page)
    if (size.phone) {
      await expectTouchTarget(panel.getByRole('button', { name: 'Older lines' }), `${label} Older`)
    }
    if (size.phone && size.height >= 812) await expectTenShortLinesVisible(page)

    await panel.getByRole('button', { name: 'Older lines' }).click()
    await expect(panel.locator('#talk-newer')).toContainText(
      'You are reading older lines. New lines appear on the newest page.',
    )
    await expect(panel.locator('#talk-lines')).toContainText('An older line from two days ago.')
    await expectNoSidewaysScroll(page, `${label} older page`)
    if (size.phone) {
      await expectTouchTarget(panel.getByRole('button', { name: 'Newer lines' }), `${label} Newer`)
    }
  })
}
