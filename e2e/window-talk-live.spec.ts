import { expect, test } from '@playwright/test'
import { registerPublicWindowSetup } from './helpers/public-window-setup.ts'
import {
  linesPage,
  routeTalk,
  stepTalk,
  talkNow,
  type TalkRequests,
} from './helpers/window-talk-fixtures.ts'

const fixedTime = new Date('2026-09-25T12:00:00.000Z')

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: fixedTime })
  await page.clock.pauseAt(new Date(fixedTime.getTime() + 1))
})

registerPublicWindowSetup()

function publicLine(id: number, body: string) {
  return {
    id,
    place_id: 11,
    author: 'leafwalker',
    body,
    created_at: '2026-09-25T11:59:00.000Z',
  }
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

test('a tab nobody uses for 30 minutes checks every 30 seconds, and a key press brings back 2 seconds', async ({ page }) => {
  const requests = await routeTalk(page, { now: talkNow(), lines: linesPage([]) })
  await openTalk(page, requests)
  await expect.poll(() => requests.lines.length).toBe(1)
  await expect(page.locator('#talk-lines')).toContainText('No public line matches this selection.')

  await page.clock.fastForward(30 * 60_000)
  await expect.poll(() => requests.talkNow.length).toBe(2)
  await expect.poll(() => page.evaluate(() => document.body.dataset.talkChecks)).toBe('2')
  await expect(page.locator('#talk-status')).toHaveText(
    'This tab has not been used for 30 minutes, so it checks for new lines every 30 seconds. Move the mouse, scroll, touch, or press a key to check every 2 seconds again.',
  )

  await stepTalk(page, 30_000, requests, { talkNow: 3, checks: 3 })
  await page.keyboard.press('x')
  await expect(page.locator('#talk-status')).toBeHidden()
  await page.clock.runFor(1_000)
  await expectNoNewTalkRequests(page, requests)
  await stepTalk(page, 1_000, requests, { talkNow: 4, checks: 4 })
})
