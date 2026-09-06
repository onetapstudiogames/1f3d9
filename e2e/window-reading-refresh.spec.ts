import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  installReadingFixture,
  READING_NOTE,
  READING_OLDER_NOTE,
} from '../test/helpers/window-reading-fixture.ts'

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
    .toContainText('Removed text retained as a tombstone')
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
    await fixture.refresh({ historyUnavailable: true })
    await expectHeldNodes(page, [selector])
    await expect(page.locator(selector), 'failed history check retains the held older note')
      .toContainText(READING_OLDER_NOTE.trim())
    await expect(page.locator('#conversation-stream [data-viewer-record-key="note:304"]'),
      'new note arrives despite the failed older-history check').toContainText('A newly arrived note.')
    delayed.release()
    await expect(page.locator('#record-detail .record-detail-text'),
      'detail after partial history failure compared with the complete note').toHaveText(READING_OLDER_NOTE.trim())
  } finally {
    delayed.release()
  }
})

for (const view of ['Map', 'Live'] as const) {
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
