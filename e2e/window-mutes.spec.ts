// Decision #160: a human's mutes in this browser. The window keeps the list under one
// storage key, applies it on every view and every tab, counts what each list hid, can
// show the hidden rows as outlines, and never names or hides either founder account.
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import {
  ALLOWED_NOOK, CELLAR, FOUNDER, FOUNDER_HALL, KEEPER, LANTERN_ROW, MUTED, MUTED_CELLAR,
  SECOND_FOUNDER, SENTINELS, routeMutesCity,
} from './helpers/window-mutes-fixtures.ts'

const KEY = '1f3d9:mutes:v1'
// Screenshots for the pull request: set MUTE_SHOTS_DIR (and MUTE_SHOTS_WIDTH) to save them.
const SCREENSHOT_DIR = process.env.MUTE_SHOTS_DIR ?? ''
const SCREENSHOT_WIDTH = Number(process.env.MUTE_SHOTS_WIDTH ?? 0)

async function openWindow(page: Page, hash: string, stored: string | null = null): Promise<string[]> {
  const requests = await routeMutesCity(page)
  if (SCREENSHOT_WIDTH) await page.setViewportSize({ width: SCREENSHOT_WIDTH, height: 900 })
  if (stored !== null) {
    await page.addInitScript(([key, value]) => {
      if (!sessionStorage.getItem('mute-test-seeded')) {
        localStorage.setItem(key, value)
        sessionStorage.setItem('mute-test-seeded', 'yes')
      }
    }, [KEY, stored] as const)
  }
  await page.goto('/window' + hash)
  await expect(page.locator('#window-status')).toContainText('Watching')
  await expect(page.locator('#directory-status')).not.toContainText('Loading the complete city directory')
  return requests
}

function list(items: readonly Readonly<{ type: string; id: number; choice: string }>[]): string {
  return JSON.stringify({ version: 1, items })
}

async function stored(page: Page): Promise<string | null> {
  return page.evaluate(key => localStorage.getItem(key), KEY)
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SCREENSHOT_DIR) return
  // A full-page picture draws fixed elements against the scrolled viewport; start at the top.
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(800)
  await page.screenshot({ path: SCREENSHOT_DIR + '/' + name + '.png', fullPage: true, animations: 'disabled' })
}

function noteCard(page: Page, id: number) {
  return page.locator('#conversation-stream [data-viewer-record-key="note:' + String(id) + '"]')
}

test('muting a resident from Conversations hides their notes everywhere, counts them, keeps them on reload and in a second tab, and Unhide, Allow and Unmute work', async ({ page, context }) => {
  const requests = await openWindow(page, '#view=conversations')
  await expect(noteCard(page, 9201)).toContainText(SENTINELS.note)
  await expect(page.locator('.mute-notice')).toHaveCount(0)
  await shot(page, 'conversations-no-list-' + String(page.viewportSize()?.width))

  await noteCard(page, 9201).locator('.mute-menu > summary').click()
  await noteCard(page, 9201).getByRole('button', { name: 'Mute ' + MUTED.handle }).click()

  await expect(page.locator('#conversation-stream .mute-count'))
    .toHaveText('2 hidden by your mutes in this browser. Unhide')
  await expect(noteCard(page, 9201)).toHaveCount(0)
  await expect(noteCard(page, 9203)).toHaveCount(0)
  await expect(noteCard(page, 9202)).toBeVisible()
  // The chosen control is gone, so the reader lands on the list's count.
  await expect(page.locator('#conversation-stream .mute-unhide')).toBeFocused()
  expect(await stored(page)).toBe(list([{ type: 'resident', id: MUTED.id, choice: 'mute' }]))
  await shot(page, 'conversations-one-resident-muted-' + String(page.viewportSize()?.width))

  // Unhide shows outlines: number, author, size and date, never the body.
  await page.locator('#conversation-stream').getByRole('button', { name: 'Unhide' }).click()
  const outlines = page.locator('#conversation-stream .mute-outline')
  await expect(outlines).toHaveCount(2)
  await expect(outlines.nth(0)).toContainText('note #9203 · by ' + MUTED.handle + ' · ')
  await expect(outlines.nth(1)).toContainText('note #9201 · by ' + MUTED.handle + ' · ')
  await expect(page.locator('#conversation-stream')).not.toContainText(SENTINELS.note)
  await expect(page.locator('#conversation-stream')).not.toContainText(SENTINELS.allowNote)

  // Allow one note under the muted author: it shows again and the count drops by one.
  await outlines.nth(0).getByRole('button', { name: 'Allow' }).click()
  await expect(noteCard(page, 9203)).toContainText(SENTINELS.allowNote)
  await expect(noteCard(page, 9201)).toHaveCount(0)
  await expect(page.locator('#conversation-stream .mute-count'))
    .toHaveText('1 hidden by your mutes in this browser. Hide again')
  expect(await stored(page)).toBe(list([
    { type: 'resident', id: MUTED.id, choice: 'mute' }, { type: 'note', id: 9203, choice: 'allow' },
  ]))

  // A reload keeps the list.
  await page.reload()
  await expect(page.locator('#window-status')).toContainText('Watching')
  await expect(page.locator('#conversation-stream .mute-count'))
    .toHaveText('1 hidden by your mutes in this browser. Unhide')
  await expect(noteCard(page, 9201)).toHaveCount(0)

  // A second tab in the same browser follows a change made in the first.
  const second = await context.newPage()
  await openWindow(second, '#view=conversations')
  await expect(second.locator('#conversation-stream .mute-count')).toHaveText('1 hidden by your mutes in this browser. Unhide')
  await page.locator('#city-facts > summary').click()
  const mutesList = page.locator('#window-mutes-list')
  await expect(mutesList.locator('.window-mutes-row')).toHaveCount(2)
  await expect(mutesList).toContainText(MUTED.handle + ' (resident #9001) · muted')
  await expect(mutesList).toContainText('note #9203 · allowed')
  await mutesList.locator('.window-mutes-row', { hasText: 'resident #9001' }).getByRole('button', { name: 'Unmute' }).click()
  await expect(noteCard(page, 9201)).toBeVisible()
  await expect(noteCard(second, 9201)).toBeVisible()
  await expect(second.locator('#conversation-stream .mute-notice')).toHaveCount(0)
  expect(await stored(second)).toBe(list([{ type: 'note', id: 9203, choice: 'allow' }]))
  await mutesList.getByRole('button', { name: 'Undo allow' }).click()
  await expect(mutesList).toHaveText('Nothing is muted in this browser.')
  expect(await stored(page)).toBeNull()
  await second.close()

  // The list never left the browser: no request carried it.
  for (const request of requests) {
    expect(request).not.toMatch(/mute/iu)
    expect(request).not.toContain(KEY)
  }
})

test('a muted resident leaves no handle, note body, line or thing name in the page on any view', async ({ page }) => {
  const requests = await openWindow(page, '#view=map', list([{ type: 'resident', id: MUTED.id, choice: 'mute' }]))
  const forbidden = [SENTINELS.handle, SENTINELS.thing, SENTINELS.note, SENTINELS.allowNote, SENTINELS.line]
  // The human's own list in City facts names the resident it mutes; nothing else may.
  const scan = async (step: string) => {
    const html = await page.evaluate(() => {
      const copy = document.documentElement.cloneNode(true) as HTMLElement
      copy.querySelector('#window-mutes')?.remove()
      return copy.outerHTML
    })
    for (const word of forbidden) expect(html, step + ' carried ' + word).not.toContain(word)
  }

  await expect(page.locator('#resident-roster .mute-count')).toHaveText('1 hidden by your mutes in this browser. Unhide')
  await expect(page.locator('#place-map > .mute-notice .mute-count')).toHaveText('1 hidden by your mutes in this browser. Unhide')
  await scan('Map')

  await page.getByRole('tab', { name: 'Things' }).click()
  await expect(page.locator('#things-list .mute-count')).toHaveText('1 hidden by your mutes in this browser. Unhide')
  await expect(page.locator('#things-summary')).toContainText('3 of 4 public things shown.')
  await expect(page.locator('#things-list')).toContainText('control_lamp')
  await expect(page.locator('#things-list')).toContainText('currently owned by a resident you muted')
  await scan('Things')

  await page.evaluate(id => { window.location.hash = '#view=place&place=' + String(id) }, LANTERN_ROW)
  await expect(page.locator('#place-focus-title')).toHaveText('lantern_row')
  await expect(page.locator('#place-occupants .mute-count')).toHaveText('1 hidden by your mutes in this browser. Unhide')
  await expect(page.locator('#place-things .mute-count')).toHaveText('1 hidden by your mutes in this browser. Unhide')
  await expect(page.locator('#place-conversation .mute-count')).toHaveText('2 hidden by your mutes in this browser. Unhide')
  await scan('Place')

  await page.evaluate(() => { window.location.hash = '#view=conversations' })
  await expect(page.locator('#conversation-stream .mute-count')).toHaveText('2 hidden by your mutes in this browser. Unhide')
  await scan('Conversations')

  await page.getByRole('tab', { name: 'Talk', exact: true }).click()
  await expect(page.locator('#talk-lines .mute-count')).toHaveText('1 hidden by your mutes in this browser. Unhide')
  await expect(page.locator('#talk-lines')).toContainText('A control line.')
  await scan('Talk')

  await page.getByRole('tab', { name: 'Happenings', exact: true }).click()
  await expect(page.locator('#activity-list .mute-count')).toHaveText('1 hidden by your mutes in this browser. Unhide')
  // A shown happening that used the muted resident's thing says "a thing you muted".
  await expect(page.locator('#activity-list [data-viewer-record-key="event:7005"]')).toContainText('a thing you muted')
  await expect(page.locator('#activity-list [data-viewer-record-key="event:7006"]')).toContainText('control_lamp')
  await scan('Happenings')

  await page.getByRole('tab', { name: 'Agreements', exact: true }).click()
  await expect(page.locator('#agreement-list')).toContainText('a resident you muted')
  await scan('Agreements')

  await page.getByRole('tab', { name: 'Archive', exact: true }).click()
  await page.locator('#archive-query').fill('lamp')
  await page.locator('#archive-search').click()
  await expect(page.locator('#archive-results .mute-count')).toHaveText('2 hidden by your mutes in this browser. Unhide')
  await scan('Archive')

  await page.evaluate(() => { history.pushState(null, '', '/window/gazette?issue=7'); dispatchEvent(new PopStateEvent('popstate')) })
  await expect(page.locator('#gazette-issue .mute-count')).toHaveText('1 hidden by your mutes in this browser. Unhide')
  await expect(page.locator('#gazette-issue')).toContainText('A printed control entry.')
  await scan('Gazette')

  await page.getByRole('tab', { name: 'Map', exact: true }).click()
  const search = page.locator('#directory-search')
  await search.fill('sentinel')
  await expect(page.locator('#directory-search-status')).toContainText('1 hidden by your mutes in this browser.')
  await scan('directory search')
  await search.fill('')

  for (const [path, title, pageTitle] of [
    ['/window/note/9201', 'Public note #9201', 'Public note #9201 in the city window · 1F3D9'],
    ['/window/thing/9101', 'Thing #9101', 'Public thing #9101 in the city window · 1F3D9'],
  ] as const) {
    await page.goto(path)
    await expect(page.locator('#record-detail-title')).toHaveText(title)
    await expect(page.locator('#record-detail-body .mute-count')).toContainText('hidden by your mutes in this browser.')
    await scan('detail ' + path)
    // The server's own title and preview text for this link are replaced in this browser.
    expect(await page.title()).toBe(pageTitle)
    await expect(page.locator('meta[property="og:description"]'))
      .toHaveAttribute('content', pageTitle.replace(' · 1F3D9', '.'))
  }

  for (const request of requests) expect(request).not.toMatch(/mute/iu)
})

test('a muted place hides what is inside it, an allowed place inside it shows, and both founders stay', async ({ page }) => {
  await openWindow(page, '#view=map', list([
    { type: 'place', id: MUTED_CELLAR, choice: 'mute' }, { type: 'place', id: ALLOWED_NOOK, choice: 'allow' },
  ]))
  const map = page.locator('#place-map')
  await expect(map.locator('.place-card', { hasText: 'muted_cellar' })).toHaveCount(0)
  await expect(map.locator('.place-card', { hasText: 'allowed_nook' })).toHaveCount(1)
  await expect(map.locator(':scope > .mute-notice .mute-count')).toHaveText('2 hidden by your mutes in this browser. Unhide')
  const roster = page.locator('#resident-roster')
  await expect(roster.locator('.mute-count')).toHaveText('1 hidden by your mutes in this browser. Unhide')
  await expect(roster).not.toContainText(CELLAR.handle)
  await expect(roster).toContainText(FOUNDER.handle)
  await expect(roster).toContainText('nook-sitter')
  await shot(page, 'map-place-muted-' + String(page.viewportSize()?.width))

  await page.evaluate(() => { window.location.hash = '#view=conversations' })
  await expect(page.locator('#conversation-stream .mute-count')).toHaveText('1 hidden by your mutes in this browser. Unhide')
  await expect(noteCard(page, 9205)).toHaveCount(0)
  await expect(noteCard(page, 9206)).toBeVisible()
  await expect(noteCard(page, 9207)).toBeVisible()
  await expect(page.locator('#conversation-stream')).not.toContainText(SENTINELS.cellarNote)

  await page.getByRole('tab', { name: 'Talk', exact: true }).click()
  await expect(page.locator('#talk-lines .mute-count')).toHaveText('1 hidden by your mutes in this browser. Unhide')
  await expect(page.locator('#talk-lines')).not.toContainText(SENTINELS.cellarLine)

  await page.getByRole('tab', { name: 'Things' }).click()
  await expect(page.locator('#things-list .mute-count')).toHaveText('1 hidden by your mutes in this browser. Unhide')
  await expect(page.locator('#things-list')).not.toContainText(SENTINELS.cellarThing)

  await page.getByRole('tab', { name: 'Happenings', exact: true }).click()
  await expect(page.locator('#activity-list .mute-count')).toHaveText('1 hidden by your mutes in this browser. Unhide')
  await expect(page.locator('#activity-list')).toContainText(FOUNDER.handle)
  // Rows that stay (a move out of the cellar, a chance on a cellar thing, the founder's own
  // happening there) say "a place you muted" and "a thing you muted", never the names.
  const activity = page.locator('#activity-list')
  await expect(activity).toContainText('moved from a place you muted to harbor_district / lantern_row')
  await expect(activity.locator('[data-viewer-record-key="event:7007"]')).toContainText('a thing you muted')
  await expect(activity.locator('[data-viewer-record-key="event:7007"]')).toContainText('Observed at a place you muted')
  const happeningsHtml = await activity.evaluate(node => node.outerHTML)
  for (const word of ['muted_cellar', SENTINELS.cellarThing, '/window/thing/9104']) {
    expect(happeningsHtml, 'Happenings carried ' + word).not.toContain(word)
  }
  await shot(page, 'happenings-place-muted-' + String(page.viewportSize()?.width))

  // Watching the muted place itself: its own words stay out, and the place can be shown again.
  await page.evaluate(id => { window.location.hash = '#view=place&place=' + String(id) }, MUTED_CELLAR)
  await expect(page.locator('#place-description')).toContainText('This place is hidden by your mutes in this browser.')
  await expect(page.locator('#place-conversation .mute-count')).toHaveText('1 hidden by your mutes in this browser. Unhide')
  await expect(page.locator('#place-conversation')).toContainText('The second founder writes inside the muted cellar.')
  await page.locator('#place-description').getByRole('button', { name: 'Unmute' }).click()
  await expect(page.locator('#place-description')).toContainText('Described muted_cellar.')
  await expect(page.locator('#place-conversation')).toContainText(SENTINELS.cellarNote)
})

test('no Mute control is offered for either founder or anything either founder wrote, made or owns, and a stored founder mute changes nothing', async ({ page }) => {
  await openWindow(page, '#view=map', list([
    { type: 'resident', id: FOUNDER.id, choice: 'mute' }, { type: 'resident', id: SECOND_FOUNDER.id, choice: 'mute' },
  ]))
  await expect(page.locator('.mute-notice')).toHaveCount(0)
  const roster = page.locator('#resident-roster')
  for (const handle of [FOUNDER.handle, SECOND_FOUNDER.handle]) {
    const row = roster.locator('.resident-row', { has: page.getByRole('button', { name: handle, exact: true }) })
    await expect(row).toHaveCount(1)
    await expect(row.locator('.mute-menu')).toHaveCount(0)
  }
  await expect(roster.locator('.resident-row', { hasText: KEEPER.handle }).locator('.mute-menu')).toHaveCount(1)
  const hall = page.locator('#place-map .place-card', { hasText: 'founder_hall' })
  await expect(hall.locator('.mute-menu')).toHaveCount(0)
  await expect(page.locator('#place-map .place-card', { hasText: 'lantern_row' }).locator('.mute-menu')).toHaveCount(1)

  await page.evaluate(() => { window.location.hash = '#view=conversations' })
  await expect(noteCard(page, 9204)).toBeVisible()
  await expect(noteCard(page, 9204).locator('.mute-menu')).toHaveCount(0)
  await expect(noteCard(page, 9207).locator('.mute-menu')).toHaveCount(0)
  await expect(noteCard(page, 9202).locator('.mute-menu')).toHaveCount(1)

  await page.evaluate(id => { window.location.hash = '#view=place&place=' + String(id) }, LANTERN_ROW)
  const bell = page.locator('#place-things [data-viewer-record-key="thing:9103"]')
  await expect(bell).toContainText('founder_bell')
  await expect(bell.locator('.mute-menu')).toHaveCount(0)
  await page.locator('#city-facts > summary').click()
  await expect(page.locator('#window-mutes-list')).toHaveText('Nothing is muted in this browser.')
  void FOUNDER_HALL
})

test('a bad stored value or blocked storage leaves the window as it is with no list', async ({ page, context }) => {
  for (const value of ['not json', '{"version":2,"items":[{"type":"resident","id":9001,"choice":"mute"}]}',
    list(Array.from({ length: 1001 }, (_, index) => ({ type: 'note', id: index + 1, choice: 'mute' }))),
    list([{ type: 'resident', id: MUTED.id, choice: 'mute' }, { type: 'line', id: 1, choice: 'mute' }])]) {
    const tab = await context.newPage()
    await openWindow(tab, '#view=conversations', value)
    await expect(noteCard(tab, 9201)).toBeVisible()
    await expect(tab.locator('.mute-notice')).toHaveCount(0)
    expect(await stored(tab)).toBe(value)
    await tab.close()
  }

  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage is blocked') } })
  })
  await openWindow(page, '#view=conversations')
  await expect(noteCard(page, 9201)).toBeVisible()
  await expect(page.locator('.mute-notice')).toHaveCount(0)
  // A choice still works for this page without storage.
  await noteCard(page, 9201).locator('.mute-menu > summary').click()
  await noteCard(page, 9201).getByRole('button', { name: 'Mute this note' }).click()
  await expect(page.locator('#conversation-stream .mute-count')).toHaveText('1 hidden by your mutes in this browser. Unhide')
})

test('the window writes the list only when the human chooses, in the shape the live view reads', async ({ page }) => {
  await openWindow(page, '#view=things')
  expect(await stored(page)).toBeNull()
  const row = page.locator('#things-list [data-viewer-record-key="thing:9102"]')
  await row.locator('.mute-menu > summary').click()
  await row.getByRole('button', { name: 'Mute kind lamp' }).click()
  expect(await stored(page)).toBe(list([{ type: 'kind', id: 39, choice: 'mute' }]))
  await expect(page.locator('#things-list .mute-count')).toHaveText('2 hidden by your mutes in this browser. Unhide')
  // Happenings that touched a thing of the muted kind stay, but never name it.
  await page.getByRole('tab', { name: 'Happenings', exact: true }).click()
  const edited = page.locator('#activity-list [data-viewer-record-key="event:7006"]')
  await expect(edited).toContainText('a thing you muted')
  await expect(page.locator('#activity-list [data-viewer-record-key="event:7005"]')).toContainText('a thing you muted')
  const happeningsHtml = await page.locator('#activity-list').evaluate(node => node.outerHTML)
  for (const word of ['control_lamp', SENTINELS.thing, '/window/thing/9102', '/window/thing/9101']) {
    expect(happeningsHtml, 'Happenings carried ' + word).not.toContain(word)
  }
  const fixture = JSON.parse(readFileSync(new URL('../test/fixtures/browser-mutes-fixture.json', import.meta.url), 'utf8')) as { key: string }
  expect(fixture.key).toBe(KEY)
})

test('a muted kind hides a thing of that kind from an Archive search, though the search does not name its kind', async ({ page }) => {
  await openWindow(page, '#view=things', list([{ type: 'kind', id: 39, choice: 'mute' }]))
  await expect(page.locator('#things-list .mute-count')).toHaveText('2 hidden by your mutes in this browser. Unhide')
  await page.getByRole('tab', { name: 'Archive', exact: true }).click()
  await page.locator('#archive-query').fill('lamp')
  await page.locator('#archive-search').click()
  const count = page.locator('#archive-results .mute-count')
  await expect(count).toHaveText('2 hidden by your mutes in this browser. Unhide')
  const html = await page.locator('#archive-results').evaluate(node => node.outerHTML)
  for (const word of ['control_lamp', SENTINELS.thing, '/window/thing/9102', '/window/thing/9101']) {
    expect(html, 'Archive carried ' + word).not.toContain(word)
  }
  // The notes in the same search stay.
  await expect(page.locator('#archive-results')).toContainText('Public note #9202')
  await shot(page, 'archive-kind-muted-' + String(page.viewportSize()?.width))
  // Unhide shows outlines with no name, each offering to unmute the kind.
  await count.getByRole('button', { name: 'Unhide' }).click()
  const outlines = page.locator('#archive-results .mute-outline')
  await expect(outlines).toHaveCount(2)
  await expect(outlines.first()).toContainText('thing #9101')
  await expect(page.locator('#archive-results .mute-outline').getByRole('button', { name: 'Allow' })).toHaveCount(2)
  expect(await page.locator('#archive-results').evaluate(node => node.outerHTML)).not.toContain('control_lamp')
})
