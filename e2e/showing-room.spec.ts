import { expect, test } from '@playwright/test'
import { WINDOW_CSS } from '../src/window-style.ts'
import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'
import { renderShowingRules, renderShowingResult } from '../src/showing-room-copy.ts'

for (const width of [375, 1280]) {
  test(`showing room founder rules and counts remain ordinary readable notes at ${width}px`, async ({ page }, testInfo) => {
    const rules = renderShowingRules({ questionNumber: 21, title: 'A synthetic public question',
      prompt: 'Write one short notice for a doorway.', entryClosesAt: '2026-11-07T15:00:00.000Z',
      voteClosesAt: '2026-11-09T15:00:00.000Z' })
    const winners = [{ noteId: 901, residentId: 11, handle: 'elm', votes: 3 },
      { noteId: 902, residentId: 12, handle: 'reed', votes: 3 }]
    const result = renderShowingResult({ questionNumber: 20, rulesNoteId: 899,
      entryCount: 2, ballotCount: 3, selectionCount: 6, entries: winners, winners,
      excludedBallots: [], withdrawals: [], late: false },
    { count: 910, winners: 911, details: [], nextRules: 912 })
    const notes = [
      { id: 912, body: rules }, { id: 911, body: result.winners }, { id: 910, body: result.count },
    ].map(note => ({ ...note, place_id: 438, author_id: 1, author: 'founder',
      created_at: '2026-11-02T15:00:01.000Z', body_text_bytes: Buffer.byteLength(note.body),
      walk_to_read: false, truncated: false }))
    const place = { id: 438, parent_id: null, name: 'the showing room', owner_id: 1,
      owner: 'founder', purpose: 'Public entries and votes under each question.',
      description: 'Read the current founder question before entering.', quiet: false,
      status: 'active', places: 0, things: 0, notes: 3, children: [], front_matter: [] }
    const emptyPage = { has_more: false, next_before_id: null }
    const snapshot = { view: 'outline', change_marker: '50', places: [place], residents: [],
      notes, things: [], agreements: [], events: [],
      totals: { places: 1, residents: 0, conversations: 3, things: 0, agreements: 0, events: 0 },
      pages: { places: { has_more: false, next_before_subplace_id: null }, residents: emptyPage,
        notes: emptyPage, things: emptyPage, agreements: emptyPage, events: emptyPage },
      refreshed_at: '2026-11-02T15:00:02.000Z' }
    const writes: string[] = []
    const privateReads: string[] = []
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/__e2e/health')
    await page.route('**/api/**', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (request.method() !== 'GET') writes.push(request.method() + ' ' + url.pathname)
      if (url.pathname.includes('/founder/')) privateReads.push(url.pathname)
      if (url.pathname === '/api/window') {
        return route.fulfill({ json: url.searchParams.get('view') === 'directory'
          ? { view: 'directory', places: [{ id: 438, parent_id: null, name: place.name }], residents: [] }
          : snapshot })
      }
      if (url.pathname === '/api/place/438') return route.fulfill({ json: {
        view: 'outline', place, notes, things: [], subplaces: [], residents: [], front_matter: [],
        notes_page: { total_items: 3, returned_items: 3, has_more: false },
      } })
      if (url.pathname.startsWith('/api/note/')) return route.fulfill({ json: {
        note: notes.find(note => note.id === Number(url.pathname.split('/').at(-1))),
      } })
      return route.fulfill({ json: { events: [], residents: [], changes: [], issues: [],
        has_more: false, change_marker: '50', through_change_marker: '50' } })
    })
    await page.setContent(WINDOW_HTML.replace(/\s*<script src="\/window\.js" defer><\/script>/u, ''))
    await page.addStyleTag({ content: WINDOW_CSS })
    await page.addScriptTag({ content: WINDOW_JS })
    await expect(page.locator('#window-status')).toContainText('Watching')
    await page.evaluate(() => { window.location.hash = '#view=place&place=438' })
    await expect(page.locator('#place-focus-title')).toHaveText('the showing room')
    const cards = page.locator('#place-conversation')
    await expect(cards.locator('[data-viewer-record-key="note:912"]')).toContainText('THE TWENTY-FIRST QUESTION')
    await expect(cards.locator('[data-viewer-record-key="note:912"]')).toContainText('15:00:00 UTC')
    await expect(cards.locator('[data-viewer-record-key="note:912"] time')).toHaveAttribute('datetime', '2026-11-02T15:00:01.000Z')
    await expect(cards.locator('[data-viewer-record-key="note:911"]')).toContainText('elm')
    await expect(cards.locator('[data-viewer-record-key="note:911"]')).toContainText('reed')
    await expect(cards).toContainText('founder')
    await expect(page.locator('a[href="/live/?place=438"]')).toBeVisible()
    expect(writes).toEqual([])
    expect(privateReads).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await cards.locator('[data-viewer-record-key="note:911"]').scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`showing-room-${width}.png`) })
  })
}
