import { expect, test } from '@playwright/test'
import { installMentionsFixture, mentionNote, readyMentions } from './helpers/window-mentions.ts'

test('Named in shows the newest public whole matches, links and changed room visibility', async ({ page }) => {
  const fixture = await installMentionsFixture(page, {
    notes: [], rosterHandles: ['browser-resident'], feedPlaceIds: [99],
  })
  fixture.setQuiet(12)
  await readyMentions(page, '/window/conversations?resident=selene')
  const section = page.locator('#resident-mentions')
  const summary = page.locator('#mentions-summary')
  const rows = page.locator('#mentions-list [data-viewer-record-key]')
  await expect(summary).toHaveText('No public notes are shown for this resident.')
  await expect(rows).toHaveCount(0)
  await expect(section.getByRole('button')).toHaveCount(0)

  const publicNotes = Array.from({ length: 30 }, (_, index) => mentionNote(700 - index,
    index === 0 ? 'PUBLIC_MATCH selene and north-star' : 'PUBLIC_MATCH @SELENE ' + index))
  fixture.setNotes([
    ...publicNotes,
    mentionNote(701, 'QUIET_MATCH selene', { place_id: 12 }),
    mentionNote(800, 'FEED_MATCH selene', { place_id: 99 }),
    mentionNote(801, 'WALK_MATCH selene', { walk_to_read: true }),
    mentionNote(802, 'LONGER_WORD xselene'),
    mentionNote(803, 'LONGER_TOKEN selene-more'),
  ])
  await fixture.refresh()
  await expect(rows).toHaveCount(24)
  await expect(summary).toHaveText('Public notes naming selene. 24 shown, newest first.')
  expect(await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-viewer-record-key'))))
    .toEqual(publicNotes.slice(0, 24).map(note => 'note:' + note.id))
  expect(await section.evaluate(node => node.outerHTML))
    .not.toMatch(/QUIET_MATCH|FEED_MATCH|WALK_MATCH|LONGER_WORD|LONGER_TOKEN|note:701|note\/701/)
  await expect(section.locator('.history-load')).toHaveCount(0)

  await rows.first().locator('.note-body').getByRole('link', { name: 'north-star', exact: true }).click()
  await expect(page).toHaveURL(/\/window\/conversations\?resident=north-star$/)
  await expect(rows).toHaveCount(1)
  await expect(summary).toHaveText('Public notes naming north-star. 1 shown, newest first.')

  await page.locator('#resident-filter').selectOption('selene')
  await expect(rows).toHaveCount(24)
  fixture.setQuiet(12, false)
  await fixture.refresh()
  await expect(rows).toHaveCount(25)
  await expect(rows.first()).toHaveAttribute('data-viewer-record-key', 'note:701')
  await expect(rows.first()).toContainText('QUIET_MATCH selene')
  await expect(summary).toHaveText('Public notes naming selene. 25 shown, newest first.')
  for (const request of fixture.requests.filter(path => path.includes('mentions='))) {
    const url = new URL(request, 'http://localhost')
    expect(url.searchParams.get('limit')).toBe('25')
    expect(url.searchParams.has('before_id')).toBe(false)
    expect(url.searchParams.has('after_id')).toBe(false)
  }
})
