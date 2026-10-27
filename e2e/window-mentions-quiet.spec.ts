import { expect, test } from '@playwright/test'
import { publicWindowFixture } from './helpers/oauth-test-server/public-window-fixtures.ts'
import { installMentionsFixture, mentionCard, mentionNote, mentionResidents, readyMentions } from './helpers/window-mentions.ts'

test('inline unknown rooms wait for the directory before any quiet note markup appears', async ({ page }) => {
  await installMentionsFixture(page, { hiddenPlaceIds: [99],
    notes: [mentionNote(301, 'DELAYED_QUIET_NOTE @SELENE', { place_id: 99 })] })
  let release = () => {}
  const waiting = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/window**', async route => {
    if (new URL(route.request().url()).searchParams.get('view') !== 'directory') return route.fallback()
    await waiting
    return route.fulfill({ json: { view: 'directory', residents: mentionResidents,
      places: [...publicWindowFixture.places,
        { ...publicWindowFixture.places[1], id: 99, name: 'distant_room', quiet: true }],
    } })
  })
  await readyMentions(page)
  await expect(mentionCard(page)).toContainText('Reading the room names before showing this note...')
  expect(await mentionCard(page).evaluate(node => node.outerHTML))
    .not.toMatch(/DELAYED_QUIET_NOTE|SELENE|resident=selene/)
  release()
  await expect(mentionCard(page).locator('.quiet-room-notice')).toBeVisible()
  expect(await mentionCard(page).evaluate(node => node.outerHTML))
    .not.toMatch(/DELAYED_QUIET_NOTE|SELENE|resident=selene/)
})

test('inline public first lines link complete tokens and leave the capped final token plain', async ({ page }) => {
  const fixture = await installMentionsFixture(page)
  const firstLines = ['@SELENE', 'selene ' + 'x'.repeat(186) + ' selene']
  const notes = firstLines.map((first_line, index) => {
    const { body: _body, ...heading } = mentionNote(301 + index, '')
    return { ...heading, walk_to_read: true, first_line, body_text_bytes: 5_000 }
  })
  await page.route('**/api/window**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('view') === 'directory') return route.fallback()
    if (url.searchParams.get('collection') === 'notes') return route.fulfill({ json: {
      notes, has_more: false, next_before_id: null, change_marker: '9',
    } })
    return route.fulfill({ json: { ...publicWindowFixture, notes, residents: mentionResidents } })
  })
  await page.route('**/api/note/*', route => {
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1))
    return route.fulfill({ json: { note: notes.find(note => note.id === id) } })
  })
  await readyMentions(page)
  await expect(mentionCard(page, 301).locator('.note-first-line a')).toHaveText(['@SELENE'])
  await expect(mentionCard(page, 302).locator('.note-first-line a')).toHaveText(['selene'])
  await expect(mentionCard(page, 302).locator('.note-first-line')).toHaveText(firstLines[1]!)
  await mentionCard(page, 301).getByRole('link', { name: 'Open note #301', exact: true }).click()
  await expect(page.locator('#record-detail-body .note-first-line a')).toHaveText(['@SELENE'])
  await page.locator('#record-detail-close').click()
  await mentionCard(page, 302).getByRole('link', { name: 'Open note #302', exact: true }).click()
  await expect(page.locator('#record-detail-body .note-first-line a')).toHaveText(['selene'])
  await expect(page.locator('#record-detail-body .body-disclosure, #record-detail-body .note-decode')).toHaveCount(0)
  expect(fixture.requests.filter(path => /^\/api\/note\//.test(path))).toEqual([
    '/api/note/301', '/api/note/302',
  ])
})

test('inline focus stays on its source handle when earlier directory links arrive', async ({ page }) => {
  const fixture = await installMentionsFixture(page, {
    rosterHandles: ['browser-resident', 'selene'],
    notes: [mentionNote(301, 'north-star selene')],
  })
  const release = fixture.delayDirectory()
  await readyMentions(page)
  const body = mentionCard(page).locator('.note-body')
  await expect(body.locator('a')).toHaveText(['selene'])
  const selene = body.getByRole('link', { name: 'selene', exact: true })
  await selene.focus()
  await expect(selene).toBeFocused()
  release()
  await expect(body.locator('a')).toHaveText(['north-star', 'selene'])
  await expect(selene).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/window\/conversations\?resident=selene$/)
})

for (const change of ['mute', 'quiet'] as const) {
  test('inline closed note detail drops retained words after a ' + change + ' change', async ({ page }) => {
    const fixture = await installMentionsFixture(page, {
      notes: [mentionNote(301, 'CLOSED_NOTE_TEXT @SELENE')],
    })
    await readyMentions(page)
    await mentionCard(page).getByRole('link', { name: 'Open note #301', exact: true }).click()
    await expect(page.locator('#record-detail-body .note-mention')).toHaveText('@SELENE')
    await page.locator('#record-detail-close').click()
    await expect(page.locator('#record-detail')).not.toBeVisible()
    if (change === 'mute') {
      await page.evaluate(() => {
        const key = '1f3d9:mutes:v1'
        const newValue = JSON.stringify({ version: 1,
          items: [{ type: 'resident', id: 901, choice: 'mute' }] })
        localStorage.setItem(key, newValue)
        window.dispatchEvent(new StorageEvent('storage', { key, newValue }))
      })
    } else {
      fixture.setQuiet(11)
      await fixture.refresh()
    }
    await expect.poll(() => page.locator('#record-detail-body').evaluate(node => node.outerHTML))
      .not.toMatch(/CLOSED_NOTE_TEXT|SELENE|resident=selene/)
  })
}
