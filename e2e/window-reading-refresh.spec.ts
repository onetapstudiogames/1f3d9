import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  installReadingFixture,
  READING_NOTE,
  READING_OLDER_NOTE,
} from '../test/helpers/window-reading-fixture.ts'
import { publicWindowFixture } from './helpers/oauth-test-server/public-window-fixtures.ts'

const violationsByPage = new WeakMap<Page, readonly string[]>()

test.afterEach(async ({ page }) => {
  expect(violationsByPage.get(page) ?? [], 'unexpected network operations compared with []').toEqual([])
})

async function holdNodes(page: Page, selectors: readonly string[]) {
  await page.evaluate(selectors => {
    const held = selectors.map(selector => document.querySelector(selector))
    Object.defineProperty(window, '__heldReadingNodes', { configurable: true, value: held })
    const ancestors = new Set<Node>()
    for (const node of held) {
      for (let ancestor: Node | null = node; ancestor; ancestor = ancestor.parentNode) {
        ancestors.add(ancestor)
      }
    }
    const detachments: string[] = []
    Object.defineProperty(window, '__readingDetachments', { configurable: true, value: detachments })
    const observer = new MutationObserver(records => {
      for (const record of records) {
        for (const removed of record.removedNodes) {
          if (ancestors.has(removed)) detachments.push(removed.nodeName)
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }, selectors)
}

async function expectHeldNodes(page: Page, selectors: readonly string[]) {
  await expect.poll(() => page.evaluate(selectors => {
    const held = (window as Window & { __heldReadingNodes?: (Element | null)[] }).__heldReadingNodes
    return selectors.map((selector, index) => ({
      selector,
      attached: held?.[index]?.isConnected === true,
      sameNode: held?.[index] === document.querySelector(selector),
    }))
  }, selectors), {
    message: `reading node identities compared before/after refresh: ${selectors.join(', ')}`,
  }).toEqual(selectors.map(selector => ({ selector, attached: true, sameNode: true })))
  const detachments = await page.evaluate(() =>
    (window as Window & { __readingDetachments?: string[] }).__readingDetachments)
  expect(detachments, 'temporary reading-node detachments compared with []').toEqual([])
}

async function openBody(body: Locator) {
  const disclosure = body.locator('..').locator('.body-disclosure')
  await expect(disclosure, 'disclosure visibility compared with visible').toBeVisible()
  await disclosure.click()
  await expect(body, 'body expanded value compared with true').toHaveAttribute('data-expanded', 'true')
}

async function ready(page: Page, path: string) {
  await page.goto(path)
  await expect(page.locator('#window-status'), 'initial status compared with Watching')
    .toContainText('Watching', { timeout: 15_000 })
}

async function visibleTop(page: Page, selector: string, label: string) {
  let observedTop: number | null = null
  await expect.poll(() => page.evaluate(selector => {
    const node = document.querySelector(selector)
    if (!node) return null
    const box = node.getBoundingClientRect()
    return { top: box.top, bottom: box.bottom, viewport: innerHeight }
  }, selector).then(box => {
    observedTop = box?.top ?? null
    return {
      top: observedTop,
      attached: box !== null,
      visible: !!box && box.bottom > 0 && box.top < box.viewport,
    }
  }), { message: `${label} top/attached/visible operands compared with attached and visible` })
    .toMatchObject({ attached: true, visible: true })
  if (observedTop === null) throw new Error(`${label} had no visible top after polling`)
  return observedTop
}

async function expectTopUnchanged(page: Page, selector: string, beforeTop: number, label: string) {
  await expect.poll(() => page.evaluate(selector => {
    const node = document.querySelector(selector)
    return node ? node.getBoundingClientRect().top : null
  }, selector).then(afterTop => ({
    beforeTop,
    afterTop,
    difference: afterTop === null ? null : Math.abs(beforeTop - afterTop),
    stayed: afterTop !== null && Math.abs(beforeTop - afterTop) <= 1,
  })), { message: `${label} before/after/difference operands compared within one pixel` })
    .toMatchObject({ stayed: true })
}

async function loadOlderNote(page: Page) {
  const load = page.getByRole('button', { name: 'Load older conversations', exact: true })
  await expect(load, 'older-note load control visibility compared with visible').toBeVisible()
  await load.click()
  const selector = '#conversation-stream [data-viewer-record-key="note:299"]'
  await expect(page.locator(selector), 'loaded older-note body compared with fixture body')
    .toContainText(READING_OLDER_NOTE.trim())
  return selector
}

async function installPlaceConditions(page: Page, baseURL: string | undefined,
  sourceState: 'public' | 'quiet' | 'moderated' | 'muted' | 'unknown' = 'public') {
  const fixture = await installReadingFixture(page, baseURL)
  violationsByPage.set(page, fixture.networkViolations)
  const child = { ...publicWindowFixture.places[1], parent_id: 11, owner: 'browser-resident',
    quiet: false, labels: ['child_only'], laws: [
      { traitId: 71, name: 'shared_rain', sourcePlaceId: 11 },
      { traitId: 72, name: 'shared_wind', sourcePlaceId: 11 },
      { traitId: 73, name: 'old_secret_name', sourcePlaceId: 11, moderated: true,
        recipe: { use: ['old_secret_recipe'] } },
    ] }
  const parent = { ...publicWindowFixture.places[0], quiet: sourceState === 'quiet',
    moderated: sourceState === 'moderated', places: 1, children: [child] }
  if (sourceState === 'muted') await page.addInitScript(() => {
    localStorage.setItem('1f3d9:mutes:v1', JSON.stringify({ version: 1, items: [
      { type: 'place', id: 11, choice: 'mute' }, { type: 'place', id: 12, choice: 'allow' },
    ] }))
  })
  let now = 0
  const expiresAt = 1_000
  let laws = child.laws
  let fail = false
  let presenceUnavailable = false
  let delayed: Promise<void> | null = null
  const requests: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/')) requests.push(url.pathname + url.search)
  })
  await page.route('**/api/window**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.has('collection')) return route.fallback()
    return route.fulfill({ json: url.searchParams.get('view') === 'directory'
      ? { view: 'directory', places: [parent, child], residents: publicWindowFixture.residents }
      : { ...publicWindowFixture, places: sourceState === 'unknown' ? [child] : [parent],
        notes: publicWindowFixture.notes.map(note => note.id === 301
          ? { ...note, body: READING_NOTE, truncated: false } : note) } })
  })
  await page.route('**/api/residents**', route => route.fulfill(presenceUnavailable
    ? { status: 503, json: { error: 'presence unavailable' } } : { json: {
    residents: publicWindowFixture.residents, change_marker: '9', has_more: false,
  } }))
  await page.route('**/api/place/*', async route => {
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1))
    const place = id === 11
      ? { ...parent, labels: now < expiresAt ? ['rain_now'] : [], laws: [] } : { ...child, laws }
    const waiting = delayed
    delayed = null
    if (waiting) await waiting
    await route.fulfill(fail ? { status: 503, json: { error: 'unavailable' } }
      : { json: { place, subplaces: id === 11 ? [child] : [], change_marker: '9' } })
  })
  return {
    requests,
    expire() { now = expiresAt },
    clearLaws() { laws = [] },
    fail() { fail = true },
    failPresence() { presenceUnavailable = true },
    delay() {
      let release = () => {}
      delayed = new Promise<void>(resolve => { release = resolve })
      return release
    },
    async refresh(waitForDetail = true) {
      const presence = page.waitForResponse(response =>
        new URL(response.url()).pathname === '/api/residents')
      const detail = waitForDetail ? page.waitForResponse(response =>
        new URL(response.url()).pathname.startsWith('/api/place/')) : Promise.resolve()
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
      await presence
      await detail
      if (waitForDetail) await page.evaluate(() => new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    },
  }
}

test('place conditions expire on an unchanged marker without disturbing reading', async ({ page, baseURL }) => {
  const fixture = await installPlaceConditions(page, baseURL)
  await ready(page, '/window/place/12')
  await page.locator('#place-description').getByRole('link',
    { name: 'Defining place: test_square (place 11)', exact: true }).click()
  await expect(page.locator('#place-description')).toContainText('rain_now')
  const description = '#place-description .place-description-text'
  await expect(page.locator(description)).toContainText('brass observatory')
  const body = '#place-conversation [data-body-key="note:301"]'
  await openBody(page.locator(body))
  await page.locator(description).scrollIntoViewIfNeeded()
  await holdNodes(page, [description, body, '#place-conversation .note-list'])
  const selected = await page.locator(description).evaluate(node => {
    const range = document.createRange()
    range.selectNodeContents(node)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    return window.getSelection()?.toString()
  })
  await page.locator(body).scrollIntoViewIfNeeded()
  const beforeTop = await visibleTop(page, body, 'open note before expiry')
  const before = fixture.requests.length
  fixture.expire()
  await fixture.refresh()
  await expect.poll(() => fixture.requests.slice(before).filter(path => path.startsWith('/api/place/')))
    .toEqual(['/api/place/11?view=outline&limit=1'])
  await expect(page.locator('#place-description')).toContainText('Labels here')
  await expect(page.locator('#place-description')).not.toContainText('rain_now')
  await expectHeldNodes(page, [description, body, '#place-conversation .note-list'])
  await expectTopUnchanged(page, body, beforeTop, 'open note after expiry')
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selected)
  await expect(page.locator(body)).toHaveAttribute('data-expanded', 'true')
  expect(fixture.requests.slice(before).map(path => path.split('?')[0]).sort())
    .toEqual(['/api/changes', '/api/place/11', '/api/residents'])
})

test('place conditions retain unchanged facts and replace laws after a fresh read', async ({ page, baseURL }) => {
  const fixture = await installPlaceConditions(page, baseURL)
  await ready(page, '/window/place/12')
  const selectors = ['#place-description .place-description-text',
    '#place-description .place-labels', '#place-description .place-laws a']
  await expect(page.locator(selectors[2]!)).toHaveCount(1)
  await holdNodes(page, selectors)
  await fixture.refresh()
  await expectHeldNodes(page, selectors)
  await holdNodes(page, selectors.slice(0, 2))
  fixture.clearLaws()
  await fixture.refresh()
  await expect(page.locator('#place-description')).toContainText('No current laws here.')
  await expect(page.locator('#place-description')).not.toContainText('shared_rain')
  await expect(page.locator('#place-description')).toContainText('child_only')
  await expectHeldNodes(page, selectors.slice(0, 2))
})

test('place conditions refresh the room shown while following a resident', async ({ page, baseURL }) => {
  const fixture = await installPlaceConditions(page, baseURL)
  await ready(page, '/window/place?resident=browser-resident')
  await expect(page.locator('#place-description')).toContainText('rain_now')
  fixture.expire()
  await fixture.refresh()
  await expect(page.locator('#place-description')).not.toContainText('rain_now')
})

for (const fallback of ['default room', 'failed presence'] as const) {
  test(`place conditions expire with a ${fallback}`, async ({ page, baseURL }) => {
    const fixture = await installPlaceConditions(page, baseURL)
    await ready(page, fallback === 'default room' ? '/window/place' : '/window/place/11')
    await expect(page.locator('#place-description')).toContainText('rain_now')
    const before = fixture.requests.length
    if (fallback === 'failed presence') fixture.failPresence()
    fixture.expire()
    await fixture.refresh(false)
    await expect(page.locator('#place-description')).not.toContainText('rain_now')
    expect(fixture.requests.slice(before).filter(path => path.startsWith('/api/place/')))
      .toEqual(['/api/place/11?view=outline&limit=1'])
  })
}

test('place conditions link inherited laws to their defining place by keyboard on a narrow screen', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const fixture = await installPlaceConditions(page, baseURL)
  await ready(page, '/window/place/12')
  const panel = page.locator('#place-description')
  await expect(panel).toContainText('Labels here')
  await expect(panel).toContainText('child_only')
  await expect(panel).not.toContainText('rain_now')
  await expect(panel).toContainText('Laws and defining places')
  await expect(panel).toContainText('[removed by maintainer]')
  await expect(panel).not.toContainText('old_secret')
  const links = panel.getByRole('link', { name: 'Defining place: test_square (place 11)', exact: true })
  await expect(links).toHaveCount(1)
  await links.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/window\/place\/11$/u)
  await expect(panel).toContainText('rain_now')
  await expect(panel).not.toContainText('child_only')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(fixture.requests.filter(path => path.startsWith('/api/place/')).map(path => path.split('?')[0]))
    .toEqual(['/api/place/12', '/api/place/11'])
})

test('place conditions show unavailable after a failed background read and keep prose', async ({ page, baseURL }) => {
  const fixture = await installPlaceConditions(page, baseURL)
  await ready(page, '/window/place/11')
  await expect(page.locator('#place-description')).toContainText('rain_now')
  const description = '#place-description .place-description-text'
  await holdNodes(page, [description])
  fixture.fail()
  await fixture.refresh()
  await expect(page.locator('#place-description')).toContainText('Current labels and laws are unavailable')
  await expect(page.locator('#place-description')).not.toContainText('rain_now')
  await expectHeldNodes(page, [description])
})

for (const sourceState of ['quiet', 'moderated', 'muted', 'unknown'] as const) {
  test(`place conditions hide resident law text for a ${sourceState} defining source`, async ({ page, baseURL }) => {
    const fixture = await installPlaceConditions(page, baseURL, sourceState)
    await ready(page, '/window/place/12')
    const panel = page.locator('#place-description')
    await expect(panel).toContainText('child_only')
    await expect(panel).not.toContainText('shared_rain')
    await expect(panel).not.toContainText('shared_wind')
    await expect(panel).not.toContainText('old_secret')
    await expect(panel).not.toContainText('test_square')
    if (sourceState === 'unknown') {
      await expect(panel.getByRole('link', { name: 'Defining place: place 11', exact: true })).toHaveCount(1)
    } else {
      await expect(panel).toContainText('This public place is not available now.')
      await expect(panel.locator('a[href="/window/place/11"]')).toHaveCount(0)
    }
    expect(fixture.requests.filter(path => path.startsWith('/api/place/')).map(path => path.split('?')[0]))
      .toEqual(['/api/place/12'])
  })
}

test('place conditions ignore a background reply after navigation', async ({ page, baseURL }) => {
  const fixture = await installPlaceConditions(page, baseURL)
  await ready(page, '/window/place/11')
  await expect(page.locator('#place-description')).toContainText('rain_now')
  const release = fixture.delay()
  const read = page.waitForRequest(request => new URL(request.url()).pathname === '/api/place/11')
  try {
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await read
    await page.locator('#place-filter').selectOption('12')
    await expect(page.locator('#place-description')).toContainText('child_only')
    const completed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/place/11')
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/residents')
    release()
    await completed
    await refreshed
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    await expect(page.locator('#place-description')).not.toContainText('rain_now')
    await page.locator('#place-filter').selectOption('11')
    fixture.expire()
    await fixture.refresh()
    await expect(page.locator('#place-description')).not.toContainText('rain_now')
  } finally {
    release()
  }
})

test('reading notice stays inside the closed City facts drop-down until opened', async ({ page, baseURL }) => {
  const fixture = await installReadingFixture(page, baseURL)
  violationsByPage.set(page, fixture.networkViolations)
  await ready(page, '/window/conversations')
  const facts = page.locator('#city-facts')
  const notice = facts.locator('#window-reading-notice')
  await expect(notice, 'reading notice inside City facts compared with one node').toHaveCount(1)
  await expect(facts, 'City facts compared with closed').not.toHaveAttribute('open', '')
  await expect(notice, 'reading notice with City facts closed compared with hidden').toBeHidden()
  await facts.locator('summary').click()
  await expect(notice, 'reading notice with City facts open compared with visible').toBeVisible()
  await expect(notice).toContainText('expanded text stays open through refresh.')
})

test('Conversations keeps the open note and list attached while adding new notes', async ({ page, baseURL }) => {
  const fixture = await installReadingFixture(page, baseURL)
  violationsByPage.set(page, fixture.networkViolations)
  await ready(page, '/window/conversations')
  const body = '#conversation-stream [data-body-key="note:301"]'
  await openBody(page.locator(body))
  const beforeTop = await visibleTop(page, body, 'open conversation body before refresh')
  const selectors = ['#conversation-stream .note-list', body]
  await holdNodes(page, selectors)
  await fixture.refresh()
  await expect(page.locator('#conversation-stream'), 'new note compared with its fixture text')
    .toContainText('A newly arrived note.')
  await expectHeldNodes(page, selectors)
  await expectTopUnchanged(page, body, beforeTop, 'open conversation body after refresh')
  await expect(page.locator(body), 'expanded note after refresh compared with true')
    .toHaveAttribute('data-expanded', 'true')
  expect(fixture.networkViolations, 'unexpected network operations compared with []').toEqual([])
})

test('refresh accepts a new snapshot from an already-started old-marker read', async ({ page, baseURL }) => {
  const fixture = await installReadingFixture(page, baseURL)
  violationsByPage.set(page, fixture.networkViolations)
  await ready(page, '/window/conversations')
  const delayed = await fixture.beginOldMarkerOutlineRead()
  try {
    const refreshed = fixture.refresh()
    delayed.release()
    const nextMarker = await refreshed
    expect({ minimumMarker: delayed.minimumMarker, nextMarker },
      'old request minimum and new response marker operands compared in increasing order')
      .toEqual({ minimumMarker: '9', nextMarker: '10' })
    await expect(page.locator('#city-counts'),
      'committed old-query/new-response note count compared with 4 notes').toContainText('4 notes')
    await expect(page.locator('#window-status'),
      'committed old-query/new-response status compared with Watching').toContainText('Watching')
  } finally {
    delayed.release()
  }
})

test('Place keeps its open conversation attached across refresh', async ({ page, baseURL }) => {
  const fixture = await installReadingFixture(page, baseURL)
  violationsByPage.set(page, fixture.networkViolations)
  await ready(page, '/window/place/11')
  const body = '#place-conversation [data-body-key="note:301"]'
  await openBody(page.locator(body))
  const selectors = ['#place-conversation .note-list', body]
  await holdNodes(page, selectors)
  await fixture.refresh()
  await expect(page.locator('#place-conversation'), 'new room note compared with fixture text')
    .toContainText('A newly arrived note.')
  await expectHeldNodes(page, selectors)
  await expect(page.locator(body), 'room note expansion compared with true')
    .toHaveAttribute('data-expanded', 'true')
})

test('Agreements keeps the expanded agreement attached across refresh', async ({ page, baseURL }) => {
  const fixture = await installReadingFixture(page, baseURL)
  violationsByPage.set(page, fixture.networkViolations)
  await ready(page, '/window/agreements')
  const body = '#agreement-list [data-body-key="agreement:601"]'
  await openBody(page.locator(body))
  await holdNodes(page, [body])
  await fixture.refresh()
  await expect(page.locator('#agreement-list'), 'new agreement compared with fixture text')
    .toContainText('A newly arrived agreement.')
  await expectHeldNodes(page, [body])
  await expect(page.locator(body), 'agreement expansion compared with true')
    .toHaveAttribute('data-expanded', 'true')
})

for (const view of ['things', 'happenings'] as const) {
  test(`${view === 'things' ? 'Things' : 'Happenings'} keeps its chosen row and open detail attached`,
    async ({ page, baseURL }) => {
      const fixture = await installReadingFixture(page, baseURL)
      violationsByPage.set(page, fixture.networkViolations)
      await ready(page, `/window/${view}`)
      const row = view === 'things'
        ? '#things-list [data-thing-id="401"]'
        : '#activity-list [data-viewer-record-key="event:502"]'
      await page.locator(row).getByRole('link', { name: 'field_lantern', exact: true }).click()
      const detail = '#record-detail .record-detail-text'
      await expect(page.locator(detail), 'opened detail text compared with complete inscription')
        .toContainText('complete inscription')
      const selectors = [row, detail]
      await holdNodes(page, selectors)
      await fixture.refresh()
      await expect(page.locator(view === 'things' ? '#things-list' : '#activity-list'),
        'fresh tab record compared with the new fixture row')
        .toContainText(view === 'things' ? 'new_lantern' : 'oldwalker changed a place')
      await expectHeldNodes(page, selectors)
      await expect(page.locator('#record-detail'), 'detail open attribute compared with present')
        .toHaveAttribute('open', '')
    })
}

test('opening choices survive reload and a deliberate collapse is remembered', async ({ page, baseURL }) => {
  const fixture = await installReadingFixture(page, baseURL)
  violationsByPage.set(page, fixture.networkViolations)
  await ready(page, '/window/conversations')
  const body = page.locator('#conversation-stream [data-body-key="note:301"]')
  await openBody(body)
  await page.reload()
  await expect(body, 'reloaded opening choice compared with true').toHaveAttribute('data-expanded', 'true')
  await body.locator('..').locator('.body-disclosure').click()
  await page.reload()
  await expect(body, 'reloaded collapse choice compared with false').toHaveAttribute('data-expanded', 'false')
})

test('blocked browser storage still lets a reader open text and survive refresh', async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { configurable: true, get() {
      throw new DOMException('Storage disabled for this fixture', 'SecurityError')
    } })
  })
  const fixture = await installReadingFixture(page, baseURL)
  violationsByPage.set(page, fixture.networkViolations)
  await ready(page, '/window/conversations')
  const body = '#conversation-stream [data-body-key="note:301"]'
  await openBody(page.locator(body))
  await holdNodes(page, [body])
  await fixture.refresh()
  await expectHeldNodes(page, [body])
  await expect(page.locator(body), 'in-page expansion without storage compared with true')
    .toHaveAttribute('data-expanded', 'true')
})

test('a visible closed note keeps its node and reading position when a new row arrives', async ({ page, baseURL }) => {
  const fixture = await installReadingFixture(page, baseURL)
  violationsByPage.set(page, fixture.networkViolations)
  await ready(page, '/window/conversations')
  const selector = '#conversation-stream [data-body-key="note:301"]'
  await page.locator(selector).scrollIntoViewIfNeeded()
  let beforeTop: number | null = null
  await expect.poll(() => page.evaluate(selector => {
    const node = document.querySelector(selector)
    if (!node) return null
    const box = node.getBoundingClientRect()
    return { top: box.top, bottom: box.bottom, viewport: innerHeight }
  }, selector).then(box => {
    beforeTop = box?.top ?? null
    return { attached: box !== null, visible: !!box && box.bottom > 0 && box.top < box.viewport }
  }), { message: 'closed note attached/visible operands compared with true/true' })
    .toEqual({ attached: true, visible: true })
  await holdNodes(page, [selector])
  await fixture.refresh()
  await expectHeldNodes(page, [selector])
  await expect.poll(() => page.evaluate(selector => {
    const node = document.querySelector(selector)
    return node ? node.getBoundingClientRect().top : null
  }, selector).then(afterTop => ({
    beforeTop, afterTop,
    stayed: beforeTop !== null && afterTop !== null && Math.abs(beforeTop - afterTop) <= 1,
  })), { message: 'before/after top operands must differ by at most one pixel' }).toMatchObject({ stayed: true })
})

test('keeping a note open never keeps text that a completed refresh removes', async ({ page, baseURL }) => {
  const fixture = await installReadingFixture(page, baseURL)
  violationsByPage.set(page, fixture.networkViolations)
  await ready(page, '/window/conversations')
  await openBody(page.locator('#conversation-stream [data-body-key="note:301"]'))
  await fixture.refresh({ moderated: true })
  await expect(page.locator('#conversation-stream'), 'removed note text compared with absent')
    .not.toContainText(READING_NOTE.trim())
  await expect(page.locator('#conversation-stream'), 'moderation marker compared with present')
    .toContainText('Removed by the maintainer.')
})

test('a deliberately loaded complete body stays attached through an unrelated refresh', async ({ page, baseURL }) => {
  const fixture = await installReadingFixture(page, baseURL)
  violationsByPage.set(page, fixture.networkViolations)
  await ready(page, '/window/place/11')
  const selector = '#place-things [data-body-key="thing:401"]'
  await openBody(page.locator(selector))
  await page.locator(selector).locator('..').getByRole('button', { name: 'Read the whole thing' }).click()
  await expect(page.locator(selector), 'complete body compared with complete inscription')
    .toContainText('complete inscription')
  await holdNodes(page, [selector])
  await fixture.refresh()
  await expect(page.locator(selector), 'complete body retained compared with complete inscription')
    .toContainText('complete inscription')
  await expectHeldNodes(page, [selector])
})

test('complete-body revalidation replaces changed text and drops a missing full record', async ({ page, baseURL }) => {
  const fixture = await installReadingFixture(page, baseURL)
  violationsByPage.set(page, fixture.networkViolations)
  await ready(page, '/window/place/11')
  const body = page.locator('#place-things [data-body-key="thing:401"]')
  await openBody(body)
  await body.locator('..').getByRole('button', { name: 'Read the whole thing' }).click()
  await expect(body, 'initial complete body compared with complete inscription').toContainText('complete inscription')
  const replacement = 'The inscription now records a changed public text.'
  await fixture.refresh({ thingBody: replacement })
  await expect(body, 'revalidated complete body compared with replacement').toHaveText(replacement)
  await fixture.refresh({ thingMissing: true })
  await expect(body, 'missing complete record compared with absent previous body').not.toContainText(replacement)
  await expect(body.locator('..'), 'missing complete-record read compared with explicit retry').toContainText('could not be read')
})

test('a hidden Things heading never prevents the visible complete body from updating', async ({ page, baseURL }) => {
  const fixture = await installReadingFixture(page, baseURL)
  violationsByPage.set(page, fixture.networkViolations)
  await ready(page, '/window/things')
  await expect(page.locator('#things-list [data-thing-id="401"]'),
    'first copy of thing 401 compared with visible heading').toBeVisible()
  await page.getByRole('tab', { name: 'Place', exact: true }).click()
  const body = page.locator('#place-things [data-body-key="thing:401"]')
  await openBody(body)
  await body.locator('..').getByRole('button', { name: 'Read the whole thing' }).click()
  await expect(body, 'loaded complete body compared with complete inscription').toContainText('complete inscription')
  const replacement = 'The visible complete text was revised beyond its unchanged excerpt.'
  await fixture.refresh({ thingBody: replacement })
  await expect(body, 'visible complete body despite hidden heading compared with replacement').toHaveText(replacement)
})

for (const returnBeforeCompletion of [false, true]) {
test(returnBeforeCompletion
  ? 'returning before a pending body check finishes still shows the completed current text'
  : 'leaving a pending body check cannot restore obsolete text when returning', async ({ page, baseURL }) => {
  const fixture = await installReadingFixture(page, baseURL)
  violationsByPage.set(page, fixture.networkViolations)
  await ready(page, '/window/place/11')
  const body = page.locator('#place-things [data-body-key="thing:401"]')
  await openBody(body)
  await body.locator('..').getByRole('button', { name: 'Read the whole thing' }).click()
  await expect(body, 'initial complete body compared with complete inscription').toContainText('complete inscription')
  const delayed = fixture.delayNextThingRead()
  try {
    const replacement = 'The completed check has the current public inscription.'
    await fixture.refresh({ thingBody: replacement })
    await expect.poll(() => fixture.thingReadCount,
      { message: 'body reads compared with initial plus pending current read' }).toBe(2)
    await page.getByRole('tab', { name: 'Map', exact: true }).click()
    if (returnBeforeCompletion) await page.getByRole('tab', { name: 'Place', exact: true }).click()
    const completed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/thing/401')
    delayed.release()
    await completed
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    if (!returnBeforeCompletion) await page.getByRole('tab', { name: 'Place', exact: true }).click()
    await expect(body, 'returning reader text compared with completed current inscription').toHaveText(replacement)
  } finally {
    delayed.release()
  }
})
}

test('a newer refresh finishes its full-body read while an older response is delayed', async ({ page, baseURL }) => {
  const fixture = await installReadingFixture(page, baseURL)
  violationsByPage.set(page, fixture.networkViolations)
  await ready(page, '/window/place/11')
  const body = page.locator('#place-things [data-body-key="thing:401"]')
  await openBody(body)
  await body.locator('..').getByRole('button', { name: 'Read the whole thing' }).click()
  await expect(body, 'initial complete body compared with complete inscription').toContainText('complete inscription')
  const delayed = fixture.delayNextThingRead()
  try {
    await fixture.refresh()
    await expect.poll(() => fixture.thingReadCount,
      { message: 'full-record read count compared with the first pending refresh read' }).toBe(2)
    await delayed.started
    const replacement = 'The latest completed refresh owns this revised inscription.'
    await fixture.refresh({ thingBody: replacement })
    await expect.poll(() => fixture.thingReadCount,
      { message: 'full-record read count compared with initial plus two refresh reads' }).toBe(3)
    await expect(body, 'latest response compared with revised inscription').toHaveText(replacement)
    const obsoleteResponse = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/thing/401')
    delayed.release()
    await obsoleteResponse
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    await expect(body, 'late obsolete response compared with preserved latest inscription').toHaveText(replacement)
    const disclosure = body.locator('..').locator('.body-disclosure')
    await expect(disclosure, 'latest read busy state compared with false').toHaveAttribute('aria-busy', 'false')
    await expect(disclosure, 'complete short body needs no disclosure').toBeHidden()
  } finally {
    delayed.release()
  }
})

test('closing complete text while it is being rechecked stays closed', async ({ page, baseURL }) => {
  const fixture = await installReadingFixture(page, baseURL)
  violationsByPage.set(page, fixture.networkViolations)
  await ready(page, '/window/place/11')
  const longBody = 'A deliberately loaded inscription remains under the reader control. '.repeat(30)
  await fixture.refresh({ thingBody: longBody })
  const body = page.locator('#place-things [data-body-key="thing:401"]')
  await openBody(body)
  await body.locator('..').getByRole('button', { name: 'Read the whole thing' }).click()
  await expect(body, 'loaded long body compared with fixture text').toHaveText(longBody.trim())
  const delayed = fixture.delayNextThingRead()
  try {
    await fixture.refresh()
    await expect.poll(() => fixture.thingReadCount,
      { message: 'full-record reads compared with the initial and pending checks' }).toBe(2)
    await body.locator('..').getByRole('button', { name: 'Show less' }).click()
    await expect(body, 'deliberate collapse compared with false').toHaveAttribute('data-expanded', 'false')
    delayed.release()
    await expect(body.locator('..').locator('.body-disclosure'),
      'completed recheck busy state compared with false').toHaveAttribute('aria-busy', 'false')
    await expect(body, 'collapse after completed recheck compared with false').toHaveAttribute('data-expanded', 'false')
    const remembered = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('1f3d9:window:open-records') ?? '[]') as string[])
    expect(remembered, 'remembered opening keys compared with absence of thing:401').not.toContain('thing:401')
  } finally {
    delayed.release()
  }
})

test('an older note loaded by the reader stays continuously attached on unrelated refresh',
  async ({ page, baseURL }) => {
    const fixture = await installReadingFixture(page, baseURL, { olderNote: true })
    violationsByPage.set(page, fixture.networkViolations)
    await ready(page, '/window/conversations')
    const selector = await loadOlderNote(page)
    await page.locator(selector).scrollIntoViewIfNeeded()
    await visibleTop(page, selector, 'loaded older note before unrelated refresh')
    await holdNodes(page, [selector])
    await fixture.refresh()
    await expect(page.locator(selector), 'older-note body after unrelated refresh compared with fixture body')
      .toContainText(READING_OLDER_NOTE.trim())
    await expectHeldNodes(page, [selector])
    await expect(page.locator('#conversation-page'), 'joined retained list compared with no gap')
      .not.toContainText('between here and the newest')
  })

test('a loaded older page survives when it finishes before the changed refresh commits',
  async ({ page, baseURL }) => {
    const fixture = await installReadingFixture(page, baseURL, { olderNote: true })
    violationsByPage.set(page, fixture.networkViolations)
    await ready(page, '/window/conversations')
    const delayedRefresh = await fixture.beginOldMarkerOutlineRead()
    try {
      const selector = await loadOlderNote(page)
      delayedRefresh.release()
      await expect(page.locator('#window-status'), 'changed refresh completion compared with Watching')
        .toContainText('Watching', { timeout: 15_000 })
      await expect(page.locator(selector), 'page completed before refresh commit compared with retained')
        .toContainText(READING_OLDER_NOTE.trim())
    } finally {
      delayedRefresh.release()
    }
  })

test('a load older request that finishes after a changed refresh still completes',
  async ({ page, baseURL }) => {
    const fixture = await installReadingFixture(page, baseURL, { olderNote: true })
    violationsByPage.set(page, fixture.networkViolations)
    await ready(page, '/window/conversations')
    const delayedPage = fixture.delayNextHistoryRead()
    try {
      const load = page.getByRole('button', { name: 'Load older conversations', exact: true })
      await load.click()
      await delayedPage.started
      await fixture.refresh()
      delayedPage.release()
      const selector = '#conversation-stream [data-viewer-record-key="note:299"]'
      await expect(page.locator(selector), 'page completed after refresh commit compared with retained')
        .toContainText(READING_OLDER_NOTE.trim(), { timeout: 15_000 })
    } finally {
      delayedPage.release()
    }
  })

test('a second refresh overtaking the one bounded page retry leaves an honest retry control',
  async ({ page, baseURL }) => {
    const fixture = await installReadingFixture(page, baseURL, { olderNote: true })
    violationsByPage.set(page, fixture.networkViolations)
    await ready(page, '/window/conversations')
    const firstPage = fixture.delayNextHistoryRead()
    let retriedPage: ReturnType<typeof fixture.delayNextHistoryRead> | null = null
    try {
      await page.getByRole('button', { name: 'Load older conversations', exact: true }).click()
      await firstPage.started
      await fixture.refresh()
      retriedPage = fixture.delayNextHistoryRead()
      firstPage.release()
      await retriedPage.started
      await fixture.refresh()
      retriedPage.release()
      await expect(page.locator('#conversation-page'),
        'twice-overtaken page compared with an explicit loading failure')
        .toContainText('Older conversations could not be loaded')
      await expect(page.getByRole('button', { name: 'Retry loading older conversations', exact: true }),
        'twice-overtaken page compared with a usable retry control').toBeVisible()
    } finally {
      firstPage.release()
      retriedPage?.release()
    }
  })

test('the window closes a bounded gap on its own from the same list', async ({ page, baseURL }) => {
  const fixture = await installReadingFixture(page, baseURL, { olderNote: true })
  violationsByPage.set(page, fixture.networkViolations)
  await ready(page, '/window/conversations')
  await loadOlderNote(page)
  await fixture.refresh({ arrivingNotes: 6 })
  const loadedIds = () => page.evaluate(() => [...document.querySelectorAll(
    '#conversation-stream [data-viewer-record-key]')].map(node =>
    Number(node.getAttribute('data-viewer-record-key')?.split(':').at(-1))))
  await expect.poll(async () => (await loadedIds()).includes(304),
    { message: 'record inside the closed gap compared with loaded' }).toBe(true)
  expect(await loadedIds(), 'ids after automatic fill compared with every id in this list')
    .toEqual(fixture.servedNoteIds)
  await expect(page.locator('#conversation-page'), 'closed gap compared with no seam line')
    .not.toContainText('between here and the newest')
})

test('a newer gap page waits for its matching snapshot instead of mixing markers', async ({ page, baseURL }) => {
  const fixture = await installReadingFixture(page, baseURL, { olderNote: true })
  violationsByPage.set(page, fixture.networkViolations)
  await ready(page, '/window/conversations')
  const older = await loadOlderNote(page)

  await fixture.refresh({ arrivingNotes: 4, gapMarkerAhead: true })

  await expect(page.locator('#conversation-stream'),
    'newer gap row compared with absent beneath the older snapshot')
    .not.toContainText('An arriving note 0.')
  await expect(page.locator(older), 'completed old-snapshot row compared with retained')
    .toContainText(READING_OLDER_NOTE.trim())
  await expect(page.locator('#conversation-page'),
    'marker mismatch compared with an honest retry seam')
    .toContainText('Older conversations could not be rechecked')
  await expect(page.getByRole('button', { name: 'Load the conversations missing here', exact: true }),
    'marker mismatch seam control compared with visible').toBeVisible()
})

test('moderation removes or tombstones an older note loaded by the reader', async ({ page, baseURL }) => {
  const fixture = await installReadingFixture(page, baseURL, { olderNote: true })
  violationsByPage.set(page, fixture.networkViolations)
  await ready(page, '/window/conversations')
  const selector = await loadOlderNote(page)
  await fixture.refresh({ moderateOlderNote: true })
  await expect.poll(async () => {
    const olderNote = page.locator(selector)
    const count = await olderNote.count()
    const text = count ? await olderNote.textContent() : null
    return {
      count,
      text,
      originalPresent: text?.includes(READING_OLDER_NOTE.trim()) === true,
      goneOrTombstoned: count === 0 || /removed|moderated/iu.test(text ?? ''),
    }
  }, { message: 'older-note count/text/removal operands compared after moderation' })
    .toMatchObject({ originalPresent: false, goneOrTombstoned: true })
})

test('a failed older-history check keeps its held copy while the city and detail refresh', async ({ page, baseURL }) => {
  const fixture = await installReadingFixture(page, baseURL, { olderNote: true })
  violationsByPage.set(page, fixture.networkViolations)
  await ready(page, '/window/conversations')
  const selector = await loadOlderNote(page)
  await holdNodes(page, [selector])
  const delayed = fixture.delayNextNoteRead()
  try {
    const request = page.waitForRequest(request => new URL(request.url()).pathname === '/api/note/299')
    await page.locator(selector).getByRole('link', { name: 'Open note #299', exact: true }).click()
    await request
    await delayed.started
    await expect(page.locator('#record-detail-body'), 'pending note detail compared with explicit loading')
      .toContainText('Reading the live public record')
    await fixture.refresh({ historyUnavailable: true, arrivingNotes: 6 })
    await expectHeldNodes(page, [selector])
    await expect(page.locator(selector), 'failed history check retains the held older note')
      .toContainText(READING_OLDER_NOTE.trim())
    await expect(page.locator('#conversation-stream [data-viewer-record-key="note:405"]'),
      'newly arrived notes appear despite the failed gap read').toContainText('An arriving note')
    await expect(page.locator('#conversation-page'),
      'failed history check names the gap instead of joining the list silently')
      .toContainText('Older conversations could not be rechecked')
    await expect(page.getByRole('button', { name: 'Load the conversations missing here', exact: true }),
      'seam control visibility compared with visible').toBeVisible()
    delayed.release()
    await expect(page.locator('#record-detail .record-detail-text'),
      'detail after partial history failure compared with the complete note').toHaveText(READING_OLDER_NOTE.trim())
  } finally {
    delayed.release()
  }
})

test('the seam left by an unchecked older note loads from its own control', async ({ page, baseURL }) => {
  const fixture = await installReadingFixture(page, baseURL, { olderNote: true })
  violationsByPage.set(page, fixture.networkViolations)
  await ready(page, '/window/conversations')
  const selector = await loadOlderNote(page)
  await openBody(page.locator('#conversation-stream [data-body-key="note:299"]'))
  await fixture.refresh({ historyUnavailable: true, arrivingNotes: 6 })
  await expect(page.locator(selector), 'kept older note compared with its fixture body')
    .toContainText(READING_OLDER_NOTE.trim())
  const loadedIds = () => page.evaluate(() => [...document.querySelectorAll(
    '#conversation-stream [data-viewer-record-key]')].map(node =>
    Number(node.getAttribute('data-viewer-record-key')?.split(':').at(-1))))
  const gapped = await loadedIds()
  expect(gapped, 'held older note stays in the list across the failed check').toContain(299)
  expect(gapped, 'the reader loaded pages stay across the failed check').toContain(301)
  expect(gapped, 'newest notes arrive across the failed check').toContain(405)
  expect(gapped, 'records inside the gap are not loaded yet').not.toContain(304)
  const seam = page.getByRole('button', { name: 'Load the conversations missing here', exact: true })
  await expect(page.locator('#conversation-page'),
    'unchecked list states its gap rather than joining silently')
    .toContainText('between here and the newest')
  await expect(seam, 'seam control visibility compared with visible').toBeVisible()

  fixture.allowHistoryReads()
  await seam.click()
  await expect(page.locator('#conversation-page'), 'loaded seam compared with no remaining gap notice')
    .not.toContainText('between here and the newest')
  await expect(seam, 'seam control after loading compared with hidden').toBeHidden()
  const joined = await loadedIds()
  expect(joined, 'ids after the seam is loaded compared with every id the fixture serves')
    .toEqual(fixture.servedNoteIds)
})

for (const view of ['Map'] as const) {
  test(`${view} refresh never rechecks a complete body in a hidden reading tab`, async ({ page, baseURL }) => {
    const fixture = await installReadingFixture(page, baseURL, { olderNote: true })
    violationsByPage.set(page, fixture.networkViolations)
    await ready(page, '/window/place/11')
    const body = page.locator('#place-things [data-body-key="thing:401"]')
    await openBody(body)
    await body.locator('..').getByRole('button', { name: 'Read the whole thing' }).click()
    await expect(body, 'loaded full body compared with complete inscription').toContainText('complete inscription')
    await page.getByRole('tab', { name: 'Conversations', exact: true }).click()
    await loadOlderNote(page)
    await page.getByRole('tab', { name: view, exact: true }).click()
    await expect(page.getByRole('tab', { name: view, exact: true }),
      'selected non-reading tab compared with true').toHaveAttribute('aria-selected', 'true')
    await fixture.refresh()
    await page.evaluate(() => new Promise<void>(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(fixture.thingReadCount, 'full-body requests compared with only the earlier deliberate read').toBe(1)
    await expect(page.locator('#window-reading-notice'), 'reading notice in non-reading view compared with hidden')
      .toBeHidden()
  })
}

test('note moderation sharing thing 401 id never detaches thing 401', async ({ page, baseURL }) => {
  const fixture = await installReadingFixture(page, baseURL)
  violationsByPage.set(page, fixture.networkViolations)
  await ready(page, '/window/things')
  const selector = '#things-list [data-thing-id="401"]'
  await page.locator(selector).scrollIntoViewIfNeeded()
  await visibleTop(page, selector, 'thing 401 before unrelated note moderation')
  await holdNodes(page, [selector])
  await fixture.refresh({ noteModerationTargetId: 401 })
  await expect(page.locator('#things-list'), 'new thing compared with fixture row after note moderation')
    .toContainText('new_lantern')
  await expectHeldNodes(page, [selector])
})

test('resident portrait changes appear inside a continuously retained note', async ({ page, baseURL }) => {
  const fixture = await installReadingFixture(page, baseURL)
  violationsByPage.set(page, fixture.networkViolations)
  await ready(page, '/window/conversations')
  const selector = '#conversation-stream [data-viewer-record-key="note:301"]'
  const note = page.locator(selector)
  const portrait = note.locator(
    '.entity-portrait[data-portrait-type="resident"][data-portrait-id="49"]',
  )
  await expect(portrait, 'resident portrait before appearance update compared with absent').toHaveCount(0)
  await note.scrollIntoViewIfNeeded()
  await visibleTop(page, selector, 'resident note before portrait appearance update')
  await holdNodes(page, [selector])

  const firstMarker = await fixture.refresh({ residentDrawingAppeared: true })
  await expectHeldNodes(page, [selector])
  await expect(portrait, 'resident portrait after appearance update compared with present').toHaveCount(1)
  const image = portrait.locator('img')
  await expect(image, `resident portrait source compared with first refresh marker ${firstMarker}`)
    .toHaveAttribute('src', new RegExp(
      `/api/drawing/resident/49/thumb\\.png\\?rev=${firstMarker}$`, 'u',
    ))
  await expect(portrait, 'first portrait load state compared with loaded before the next refresh')
    .toHaveAttribute('data-portrait-state', 'loaded')

  const secondMarker = await fixture.refresh({ residentDrawingAppeared: true })
  await expectHeldNodes(page, [selector])
  await expect(image, `retained portrait source compared with second refresh marker ${secondMarker}`)
    .toHaveAttribute('src', new RegExp(
      `/api/drawing/resident/49/thumb\\.png\\?rev=${secondMarker}$`, 'u',
    ))
  await expect.poll(() => fixture.portraitRequests,
    { message: `portrait request paths compared with refresh markers ${firstMarker} and ${secondMarker}` })
    .toEqual(expect.arrayContaining([
      `/api/drawing/resident/49/thumb.png?rev=${firstMarker}`,
      `/api/drawing/resident/49/thumb.png?rev=${secondMarker}`,
    ]))
})
