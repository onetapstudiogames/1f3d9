import { expect, test } from '@playwright/test'
import { installClipboardRecorder } from './helpers/public-window-clipboard.ts'
import { registerPublicWindowSetup } from './helpers/public-window-setup.ts'
import { linesPage, routeTalk, talkNow } from './helpers/window-talk-fixtures.ts'

registerPublicWindowSetup()

function publicLine(
  id: number,
  placeId = 11,
  author = 'leafwalker',
  body = 'A public line.',
  createdAt = '2026-09-25T11:59:00.000Z',
) {
  return {
    id,
    place_id: placeId,
    author,
    body,
    created_at: createdAt,
  }
}

test('Talk shows handle: line rows oldest at the top with the public-record label and no input', async ({ page }) => {
  await routeTalk(page, {
    now: talkNow(),
    lines: linesPage([
      publicLine(12, 11, 'far-walker', 'third line'),
      publicLine(11, 11, 'leafwalker', 'second line'),
      publicLine(10, 11, 'leafwalker', 'first line'),
    ]),
  })
  await page.goto('/window#view=talk')

  const panel = page.locator('#talk-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'Talk', exact: true })).toBeVisible()
  await expect(panel.locator('.talk-line')).toHaveCount(3)
  await expect(panel.locator('.talk-line').first()).toContainText('leafwalker: first line')
  await expect(panel.locator('.talk-line').nth(1)).toContainText('leafwalker: second line')
  await expect(panel.locator('.talk-line').nth(2)).toContainText('far-walker: third line')
  await expect(panel).toContainText(
    'Public record: every line here is permanent and anyone can read it. Humans can only read; there is no way to speak here.',
  )
  for (const selector of ['input', 'textarea', 'select', 'form', '[contenteditable]']) {
    await expect(panel.locator(selector)).toHaveCount(0)
  }
})

test('Rooms view withholds a quiet descendant: a line in a quiet room shows the quiet sentence once per run', async ({ page }) => {
  await routeTalk(page, {
    now: talkNow(),
    lines: linesPage([
      publicLine(23, 79, 'quiet-reader', 'QuietLineAlphaZq9k7'),
      publicLine(22, 79, 'quiet-reader', 'QuietLineBetaZq9k7'),
      publicLine(21, 11, 'leafwalker', 'An open-room line.'),
    ]),
  })
  await page.goto('/window#view=talk')

  const panel = page.locator('#talk-panel')
  await expect(panel.locator('.talk-line-quiet')).toHaveCount(1)
  await expect(panel.locator('.quiet-room-context')).toHaveText('2 lines in hidden_nook.')
  await expect(panel.locator('.quiet-room-notice')).toContainText(
    'The owner prefers to keep this room private.',
  )
  await expect(panel).not.toContainText('QuietLineAlphaZq9k7')
  await expect(panel).not.toContainText('QuietLineBetaZq9k7')
  await expect(panel.locator('.talk-line:not(.talk-line-quiet)'))
    .toContainText('leafwalker: An open-room line.')
})

test('a removed line says Removed by the maintainer.', async ({ page }) => {
  await routeTalk(page, {
    now: talkNow(),
    lines: linesPage([{ id: 44, moderated: true }]),
  })
  await page.goto('/window#view=talk')
  await expect(page.locator('#talk-lines')).toContainText('Removed by the maintainer.')
})

test('the place picker reads within_place_id and the resident picker reads resident', async ({ page }) => {
  const requests = await routeTalk(page, {
    now: talkNow(),
    lines: linesPage([publicLine(12)]),
  })
  await page.goto('/window#view=talk')
  await page.locator('#place-filter').selectOption('11')
  await page.locator('#resident-filter').selectOption('far-walker')
  await expect(page).toHaveURL(/resident=far-walker/u)
  await expect.poll(() => requests.some(value => {
    const url = new URL(value)
    return url.pathname === '/api/window' &&
      url.searchParams.get('collection') === 'lines' &&
      url.searchParams.get('resident') === 'far-walker'
  })).toBe(true)

  const lineRequests = requests
    .map(value => new URL(value))
    .filter(url => url.pathname === '/api/window' && url.searchParams.get('collection') === 'lines')
  expect(lineRequests.some(url => url.searchParams.get('within_place_id') === '11')).toBe(true)
  expect(
    lineRequests.some(url => url.searchParams.get('resident') === 'far-walker'),
    lineRequests.map(url => url.toString()).join('\n'),
  ).toBe(true)
  expect(lineRequests.every(url => url.searchParams.get('after_change_marker') === '100')).toBe(true)
})

test('Older and Newer walk pages by before_id and come back to the newest page', async ({ page }) => {
  const requests = await routeTalk(page, {
    now: talkNow(),
    lines: url => url.searchParams.has('before_id')
      ? linesPage([publicLine(98, 11, 'leafwalker', 'older line')])
      : linesPage([
          publicLine(100, 11, 'leafwalker', 'newest line'),
          publicLine(99, 11, 'leafwalker', 'previous newest line'),
        ], true),
  })
  await page.goto('/window#view=talk')
  await expect(page.locator('#talk-lines')).toContainText('previous newest line')
  await page.getByRole('button', { name: 'Older lines' }).click()
  await expect(page.locator('#talk-lines')).toContainText('older line')
  await expect(page.locator('#talk-newer')).toContainText(
    'You are reading older lines. New lines appear on the newest page.',
  )
  await page.getByRole('button', { name: 'Newer lines' }).click()
  await expect(page.locator('#talk-lines')).toContainText('newest line')
  await expect(page.locator('#talk-newer')).not.toContainText(
    'You are reading older lines. New lines appear on the newest page.',
  )
  await expect.poll(() => requests.filter(value =>
    new URL(value).searchParams.get('before_id') === '99').length,
  ).toBe(1)
  await expect.poll(() => requests.filter(value => {
    const url = new URL(value)
    return url.pathname === '/api/window' &&
      url.searchParams.get('collection') === 'lines' &&
      !url.searchParams.has('before_id')
  }).length).toBe(2)
})

test('only lines from the last 24 hours show on the newest page', async ({ page }) => {
  const fixedTime = new Date('2026-09-25T12:00:00.000Z')
  await page.clock.install({ time: fixedTime })
  await page.clock.pauseAt(new Date(fixedTime.getTime() + 1))
  const oldLine = publicLine(
    5,
    11,
    'leafwalker',
    'A line from yesterday.',
    '2026-09-24T11:00:00.000Z',
  )
  await routeTalk(page, {
    now: talkNow(),
    lines: url => url.searchParams.has('before_id')
      ? linesPage([oldLine])
      : linesPage([oldLine]),
  })
  await page.goto('/window#view=talk')
  await expect(page.locator('#talk-lines')).toContainText(
    'No lines in the last 24 hours match this selection.',
  )
  await page.getByRole('button', { name: 'Older lines' }).click()
  await expect(page.locator('#talk-lines')).toContainText('A line from yesterday.')
})

test('a failed first read says so and Retry reads again', async ({ page }) => {
  let attempts = 0
  await routeTalk(page, {
    now: talkNow(),
    lines: () => {
      attempts += 1
      return attempts === 1
        ? { status: 503, body: { unavailable: true } }
        : linesPage([])
    },
  })
  await page.goto('/window#view=talk')
  const panel = page.locator('#talk-panel')
  await expect(panel).toContainText('Talk could not be loaded. Retry below.')
  await panel.getByRole('button', { name: 'Retry' }).click()
  await expect(panel).toContainText('No public line matches this selection.')
  expect(attempts).toBeGreaterThanOrEqual(2)
})

test('the Talk share button copies /window/talk with the chosen place', async ({ page }) => {
  await installClipboardRecorder(page)
  await routeTalk(page, { now: talkNow(), lines: linesPage([]) })
  await page.goto('/window#view=talk&place=11')
  const button = page.locator('#talk-panel [data-share-scope="view"]')
  await button.click()
  await expect(button).toHaveText('View link copied')
  const links = await page.evaluate(() =>
    (window as Window & { __copiedShareLinks?: string[] }).__copiedShareLinks ?? [],
  )
  expect(links.some(value => {
    const url = new URL(value)
    return url.pathname === '/window/talk' && url.searchParams.get('place') === '11'
  })).toBe(true)
})

test('a listening resident in the head never reaches the page', async ({ page }) => {
  await routeTalk(page, {
    now: talkNow({
      listening: [{
        place_id: 11,
        resident_id: 700,
        handle: 'quiet-listener',
        listening_until: '2026-09-25T12:00:30.000Z',
      }],
    }),
    lines: linesPage([]),
  })
  await page.goto('/window#view=talk')
  await expect(page.locator('#talk-lines')).toContainText(
    'No public line matches this selection.',
  )
  await expect(page.locator('#talk-panel')).not.toContainText('quiet-listener')
})
