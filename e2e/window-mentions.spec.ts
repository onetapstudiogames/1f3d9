import { expect, test } from '@playwright/test'
import { installMentionsFixture, mentionCard, mentionNote, readyMentions } from './helpers/window-mentions.ts'

test('inline handles use whole tokens and canonical keyboard and modified links', async ({ page, context }) => {
  const body = 'selene, @SELENE; (selene)! selene/selene _selene_ éseleneé north-star ' +
    'north-star-more xselene selene-x unknown <img src=x onerror=alert(1)>'
  await installMentionsFixture(page, { notes: [mentionNote(301, body)] })
  await readyMentions(page, '/window/conversations?place=11')
  const text = mentionCard(page).locator('.note-body')
  await expect(text).toHaveText(body)
  await expect(text.locator('a')).toHaveText([
    'selene', '@SELENE', 'selene', 'selene', 'selene', 'selene', 'selene', 'north-star',
  ])
  await expect(text.locator('img, script')).toHaveCount(0)
  const link = text.getByRole('link', { name: '@SELENE', exact: true })
  await expect(link).toHaveAttribute('href', '/window/conversations?resident=selene')
  const popupPromise = context.waitForEvent('page')
  await link.click({ modifiers: ['Control'] })
  const popup = await popupPromise
  await expect(popup).toHaveURL(/\/window\/conversations\?resident=selene$/)
  await popup.close()
  await expect(page).toHaveURL(/\/window\/conversations\?place=11$/)
  await link.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/window\/conversations\?resident=selene$/)
  await expect(page.locator('#place-filter')).toHaveValue('')
  await page.goBack()
  await expect(text).toHaveText(body)
  await expect(page).toHaveURL(/\/window\/conversations\?place=11$/)
})

test('inline handles appear after the complete directory arrives beyond the roster', async ({ page }) => {
  const fixture = await installMentionsFixture(page, { rosterHandles: ['browser-resident'] })
  const release = fixture.delayDirectory()
  await readyMentions(page)
  const body = mentionCard(page).locator('.note-body')
  await expect(body).toHaveText('Hello selene.')
  await expect(body.locator('a')).toHaveCount(0)
  release()
  await expect(body.getByRole('link', { name: 'selene', exact: true })).toBeVisible()
  await body.getByRole('link', { name: 'selene', exact: true }).click()
  await expect(page).toHaveURL(/resident=selene$/)
  await expect.poll(() => fixture.requests.filter(path => path.includes('handle=selene')).length)
    .toBe(1)
})

test('inline waits for unresolved muted resident names before painting note text', async ({ page }) => {
  const fixture = await installMentionsFixture(page, { rosterHandles: ['browser-resident'],
    notes: [mentionNote(301, 'MUTED_NAME_WAIT @SELENE')] })
  await page.addInitScript(() => localStorage.setItem('1f3d9:mutes:v1', JSON.stringify({
    version: 1, items: [{ type: 'resident', id: 901, choice: 'mute' }],
  })))
  const release = fixture.delayDirectory()
  await readyMentions(page)
  await expect(mentionCard(page).locator('.note-body')).toHaveText(
    'Reading resident names before showing this note...')
  expect(await mentionCard(page).evaluate(node => node.outerHTML)).not.toMatch(/MUTED_NAME_WAIT|selene/i)
  await mentionCard(page).getByRole('link', { name: 'Open note #301', exact: true }).click()
  await expect(page.locator('#record-detail-body .public-body')).toHaveText(
    'Reading resident names before showing this note...')
  release()
  await expect(page.locator('#record-detail-body .public-body')).toHaveText(
    'MUTED_NAME_WAIT a resident you muted')
  expect(await page.locator('#record-detail-body').evaluate(node => node.outerHTML)).not.toMatch(/selene/i)
})

test('inline cut tokens stay text until a deliberate complete body read', async ({ page }) => {
  const fixture = await installMentionsFixture(page, {
    notes: [mentionNote(301, 'A cut name selene', { truncated: true })],
    fullBodies: { 301: 'A cut name selene-longer and a whole @SELENE.' },
  })
  await readyMentions(page)
  const card = mentionCard(page)
  await expect(card.locator('.note-body a')).toHaveCount(0)
  await card.getByRole('button', { name: 'Show more', exact: true }).click()
  await card.getByRole('button', { name: 'Read the whole note', exact: true }).click()
  await expect(card.locator('.note-body')).toHaveText('A cut name selene-longer and a whole @SELENE.')
  await expect(card.locator('.note-body a')).toHaveText(['@SELENE'])
  expect(fixture.requests.filter(path => path === '/api/note/301')).toHaveLength(1)
  await card.getByRole('link', { name: 'Open note #301', exact: true }).click()
  await expect(page.locator('#record-detail-body .public-body a')).toHaveText(['@SELENE'])
})

test('inline Decode stays plain and muted handles leave no note markup', async ({ page }) => {
  await installMentionsFixture(page, { notes: [
    mentionNote(302, 'c2VsZW5l'), mentionNote(301, 'Hello @SELENE and selene.'),
  ] })
  await readyMentions(page)
  await mentionCard(page, 302).getByRole('button', { name: 'Decode', exact: true }).click()
  await expect(mentionCard(page, 302).locator('.note-decoded-text')).toHaveText('selene')
  await expect(mentionCard(page, 302).locator('.note-decoded a')).toHaveCount(0)
  await page.evaluate(() => {
    const key = '1f3d9:mutes:v1'
    const newValue = JSON.stringify({ version: 1,
      items: [{ type: 'resident', id: 901, choice: 'mute' }] })
    localStorage.setItem(key, newValue)
    window.dispatchEvent(new StorageEvent('storage', { key, newValue }))
  })
  await expect(mentionCard(page).locator('.note-body')).toHaveText(
    'Hello a resident you muted and a resident you muted.')
  expect(await mentionCard(page).evaluate(node => node.outerHTML)).not.toMatch(/selene/i)
  await mentionCard(page).getByRole('link', { name: 'Open note #301', exact: true }).click()
  await expect(page.locator('#record-detail-body .public-body')).toHaveText(
    'Hello a resident you muted and a resident you muted.')
  expect(await page.locator('#record-detail-body').evaluate(node => node.outerHTML)).not.toMatch(/selene/i)
})

test('inline full detail resolves an unloaded quiet room before showing note words', async ({ page }) => {
  const fixture = await installMentionsFixture(page, { hiddenPlaceIds: [99],
    notes: [mentionNote(301, 'UNSEEN_QUIET_NOTE selene', { place_id: 99 })] })
  const release = fixture.delayPlace()
  await readyMentions(page, '/window/note/301')
  await expect.poll(() => fixture.requests.filter(path => path.includes('/api/map?') &&
    path.includes('parent_id=99')).length).toBe(1)
  expect(await page.locator('#record-detail-body').evaluate(node => node.outerHTML))
    .not.toContain('UNSEEN_QUIET_NOTE')
  release()
  await expect(page.locator('#record-detail-body .quiet-room-notice')).toBeVisible()
  expect(await page.locator('#record-detail-body').evaluate(node => node.outerHTML))
    .not.toMatch(/UNSEEN_QUIET_NOTE|resident=selene/)
})

test('inline retained cards and full detail lose words and links when their room turns quiet', async ({ page }) => {
  const fixture = await installMentionsFixture(page, {
    notes: [mentionNote(301, 'QUIET_AFTER_REFRESH selene')],
  })
  await readyMentions(page)
  await mentionCard(page).getByRole('link', { name: 'Open note #301', exact: true }).click()
  await expect(page.locator('#record-detail-body .public-body a')).toHaveText(['selene'])
  const release = fixture.delayNote()
  fixture.setQuiet(11)
  await fixture.refresh()
  await expect(page.locator('#record-detail-body .quiet-room-notice')).toBeVisible()
  expect(await page.locator('#record-detail-body').evaluate(node => node.outerHTML))
    .not.toMatch(/QUIET_AFTER_REFRESH|resident=selene/)
  expect(await page.locator('#conversation-stream').evaluate(node => node.outerHTML))
    .not.toMatch(/QUIET_AFTER_REFRESH|resident=selene/)
  release()
  await expect(page.locator('#record-detail-body .quiet-room-notice')).toBeVisible()
})

test('inline quiet refresh also clears words and links from a retained hidden panel', async ({ page }) => {
  const fixture = await installMentionsFixture(page, {
    notes: [mentionNote(301, 'HIDDEN_PANEL_NOTE selene')],
  })
  await readyMentions(page)
  await expect(mentionCard(page).locator('.note-body a')).toHaveText(['selene'])
  await page.getByRole('tab', { name: 'Things', exact: true }).click()
  fixture.setQuiet(11)
  await fixture.refresh()
  await expect.poll(() => page.locator('#conversation-stream').evaluate(node => node.outerHTML))
    .not.toMatch(/HIDDEN_PANEL_NOTE|resident=selene/)
})

test('Named in shows one newest page independently from authored notes and keeps full-body matches', async ({ page }) => {
  const notes = Array.from({ length: 31 }, (_, index) => mentionNote(500 - index, 'selene match ' + index))
  const fixture = await installMentionsFixture(page, { rosterHandles: ['browser-resident'],
    notes: [...notes, mentionNote(600, 'AUTHORED_ONLY', { author: 'selene' }),
      mentionNote(601, 'UNRELATED'), mentionNote(602, 'PREVIEW_WITHOUT_NAME', { truncated: true })],
    fullBodies: { 602: 'PREVIEW_WITHOUT_NAME followed much later by selene.' } })
  await readyMentions(page, '/window/conversations?resident=selene')
  const list = page.locator('#mentions-list')
  await expect(list.locator('[data-viewer-record-key]')).toHaveCount(25)
  await expect(list).toContainText('PREVIEW_WITHOUT_NAME')
  await expect(list).not.toContainText('AUTHORED_ONLY')
  await expect(list).not.toContainText('UNRELATED')
  await expect(page.locator('#conversation-stream')).toContainText('AUTHORED_ONLY')
  const reads = fixture.requests.filter(path => path.includes('mentions='))
  expect(reads).toHaveLength(1)
  expect(new URL(reads[0], 'http://localhost').searchParams.get('limit')).toBe('25')
  expect(reads[0]).not.toContain('resident=')
  expect(fixture.requests.filter(path => path.includes('/api/residents?') && path.includes('after_id')))
    .toHaveLength(0)
  await expect(list.locator('[data-viewer-record-key]').first()).toHaveAttribute('data-viewer-record-key', 'note:602')
  await expect(list.locator('[data-viewer-record-key]').last()).toHaveAttribute('data-viewer-record-key', 'note:477')
  await expect(page.locator('#resident-mentions .history-load')).toHaveCount(0)
  await page.getByRole('tab', { name: 'Things', exact: true }).click()
  await expect(page.locator('#resident-mentions')).not.toContainText('PREVIEW_WITHOUT_NAME')
})

test('Named in distinguishes loading, failure, retry and an empty result', async ({ page }) => {
  const fixture = await installMentionsFixture(page)
  fixture.failMentions()
  const release = fixture.delayMentions()
  await readyMentions(page, '/window/conversations?resident=north-star')
  await expect(page.locator('#mentions-summary')).toHaveText('Fetching public notes naming this resident...')
  release()
  await expect(page.locator('#mentions-summary')).toHaveText('Named in notes could not be loaded. Retry below.')
  fixture.failMentions(false)
  const retry = page.getByRole('button', { name: 'Retry loading named notes', exact: true })
  await expect(retry).toHaveCount(1)
  expect(await retry.evaluate(node => [...node.attributes].map(attribute => attribute.value).join(' ')))
    .not.toMatch(/north-star|selene/)
  await retry.click()
  await expect(page.locator('#mentions-summary')).toHaveText('No public notes are shown for this resident.')
  await expect(page.locator('#mentions-list [data-viewer-record-key]')).toHaveCount(0)
})

test('Named in discards a delayed result after selecting another resident', async ({ page }) => {
  const fixture = await installMentionsFixture(page, { notes: [mentionNote(301, 'OLD_SELECTION selene')] })
  const release = fixture.delayMentions()
  await readyMentions(page, '/window/conversations?resident=selene')
  await expect(page.locator('#mentions-summary')).toContainText('Fetching')
  await page.locator('#resident-filter').selectOption('north-star')
  await expect(page.locator('#mentions-summary')).toHaveText('No public notes are shown for this resident.')
  release()
  await expect.poll(() => page.locator('#resident-mentions').evaluate(node => node.outerHTML))
    .not.toContain('OLD_SELECTION')
})

test('Named in omits quiet and unknown room membership including counts and hidden markup', async ({ page }) => {
  const fixture = await installMentionsFixture(page, { hiddenPlaceIds: [99], notes: [
    mentionNote(303, 'KNOWN_QUIET selene', { place_id: 12 }),
    mentionNote(302, 'UNKNOWN_QUIET selene', { place_id: 99 }),
    mentionNote(301, 'VISIBLE_THEN_QUIET selene'),
  ] })
  fixture.setQuiet(12)
  await readyMentions(page, '/window/conversations?resident=selene')
  await expect(page.locator('#mentions-list [data-viewer-record-key]')).toHaveCount(1)
  await expect(page.locator('#mentions-summary')).toContainText('1 shown')
  expect(await page.locator('#resident-mentions').evaluate(node => node.outerHTML))
    .not.toMatch(/KNOWN_QUIET|UNKNOWN_QUIET|note:30[23]|note\/30[23]/)
  fixture.setQuiet(11)
  await fixture.refresh()
  await expect(page.locator('#mentions-summary')).toHaveText('No public notes are shown for this resident.')
  expect(await page.locator('#resident-mentions').evaluate(node => node.outerHTML))
    .not.toMatch(/VISIBLE_THEN_QUIET|note:301|note\/301/)
  await page.getByRole('tab', { name: 'Things', exact: true }).click()
  expect(await page.locator('#resident-mentions').evaluate(node => node.outerHTML))
    .not.toMatch(/KNOWN_QUIET|UNKNOWN_QUIET|VISIBLE_THEN_QUIET|resident=selene/)
})

test('Named in reuses browser mute counts and outlines without showing note bodies', async ({ page }) => {
  await installMentionsFixture(page, { notes: [mentionNote(301, 'MUTED_NOTE_BODY selene')] })
  await page.addInitScript(() => localStorage.setItem('1f3d9:mutes:v1', JSON.stringify({
    version: 1, items: [{ type: 'note', id: 301, choice: 'mute' }],
  })))
  await readyMentions(page, '/window/conversations?resident=selene')
  await expect(page.locator('#mentions-list .mute-count')).toContainText('1 hidden by your mutes in this browser.')
  await page.locator('#mentions-list').getByRole('button', { name: 'Unhide', exact: true }).click()
  await expect(page.locator('#mentions-list .mute-outline')).toHaveCount(1)
  expect(await page.locator('#mentions-list').evaluate(node => node.outerHTML)).not.toContain('MUTED_NOTE_BODY')
  await page.evaluate(() => {
    const key = '1f3d9:mutes:v1'
    const newValue = JSON.stringify({ version: 1, items: [{ type: 'resident', id: 901, choice: 'mute' }] })
    localStorage.setItem(key, newValue)
    window.dispatchEvent(new StorageEvent('storage', { key, newValue }))
  })
  expect(await page.locator('#resident-mentions').evaluate(node => node.outerHTML)).not.toMatch(/selene|MUTED_NOTE_BODY/i)
})

test('Named in replaces its newest page on refresh even when changes cannot be checked', async ({ page }) => {
  const notes = Array.from({ length: 31 }, (_, index) => mentionNote(500 - index, 'selene match ' + index))
  const fixture = await installMentionsFixture(page, { notes })
  await readyMentions(page, '/window/conversations?resident=selene')
  const rows = page.locator('#mentions-list [data-viewer-record-key]')
  await expect(rows).toHaveCount(25)
  fixture.setNotes([mentionNote(600, 'selene NEW_HEAD'), ...notes])
  fixture.removeNote(500)
  await fixture.refresh()
  await expect(rows).toHaveCount(25)
  await expect(rows.first()).toContainText('NEW_HEAD')
  await expect(page.locator('#mentions-list [data-viewer-record-key="note:500"]')).toHaveCount(0)
  fixture.failChanges()
  fixture.setNotes([mentionNote(601, 'selene UNCHECKED_HEAD'), ...notes])
  await fixture.refresh()
  await expect(rows).toHaveCount(25)
  await expect(rows.first()).toContainText('UNCHECKED_HEAD')
  await expect(page.locator('#mentions-list [data-viewer-record-key="note:476"]')).toHaveCount(0)
  expect(fixture.requests.filter(path => path.includes('mentions=') && path.includes('before_id=')))
    .toHaveLength(0)
})
