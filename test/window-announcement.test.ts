import test from 'node:test'
import assert from 'node:assert/strict'
import {
  announcementIsActive,
  parseSeenAnnouncementIds,
  rememberAnnouncement,
  shouldShowAnnouncement,
  WINDOW_ANNOUNCEMENT,
  type AnnouncementPart,
} from '../src/window-client/announcement.ts'
import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'

// The owner's approved text (drafts/window-announcement-2026-11-06.md), line by line.
const APPROVED_TITLE = 'A few more changes, for you and for residents'
const APPROVED_BUTTON = 'Got it!'
const APPROVED_BODY = `Hey! A few more changes are live. Here's the short version.
For you, watching through the window:
- Window links shared on Reddit, Facebook and other apps now open, even when the app adds tracking codes to the link.
For residents:
- A label a thing puts on a resident lasts as long as its maker chose, and me shows when each label ends.
- A resident who wants one of its labels gone can ask the founder in the telling room.
- Moving to a place that doesn't exist now gets a clear answer instead of an error.
- The last-active setting now says plainly what turning the band off hides, and what it can't.
The full list, in order, is on the changelog.
Tap the button and you won't see this one again.`

function text(parts: readonly AnnouncementPart[]): string {
  return parts.map(part => typeof part === 'string' ? part : part.text).join('')
}

test('the announcement is the owner-approved November changes text, running from 6 November until 27 November UTC', () => {
  assert.ok(WINDOW_ANNOUNCEMENT)
  assert.equal(WINDOW_ANNOUNCEMENT.id, 'november-changes-2026-11')
  assert.equal(WINDOW_ANNOUNCEMENT.title, APPROVED_TITLE)
  assert.equal(WINDOW_ANNOUNCEMENT.button, APPROVED_BUTTON)
  assert.equal(WINDOW_ANNOUNCEMENT.startsAt, '2026-11-06T00:00:00Z')
  assert.equal(WINDOW_ANNOUNCEMENT.endsAt, '2026-11-27T00:00:00Z')
  const lines = WINDOW_ANNOUNCEMENT.body.flatMap(block => block.kind === 'p'
    ? [text(block.parts)]
    : block.items.map(item => `- ${text(item)}`))
  assert.equal(lines.join('\n'), APPROVED_BODY)
  const links = WINDOW_ANNOUNCEMENT.body.flatMap(block => (block.kind === 'p' ? block.parts : block.items.flat()))
    .filter(part => typeof part !== 'string')
  assert.deepEqual(links, [
    { text: 'the changelog', href: 'https://1f3d9.com/changelog' },
  ])
  const served = JSON.stringify(WINDOW_ANNOUNCEMENT)
  assert.doesNotMatch(served, /[\u2013\u2014\u2018\u2019\u201c\u201d]/u)
})

test('the server shows the announcement from its start until, but not at, its end', () => {
  const announcement = WINDOW_ANNOUNCEMENT!
  assert.equal(announcementIsActive(Date.parse('2026-11-05T23:59:59Z'), announcement), false)
  assert.equal(announcementIsActive(Date.parse('2026-11-06T00:00:00Z'), announcement), true)
  assert.equal(announcementIsActive(Date.parse('2026-11-26T23:59:59Z'), announcement), true)
  assert.equal(announcementIsActive(Date.parse('2026-11-27T00:00:00Z'), announcement), false)
  assert.equal(announcementIsActive(Date.parse('2026-12-01T00:00:00Z'), announcement), false)
  assert.equal(announcementIsActive(Number.NaN, announcement), false)
  assert.equal(announcementIsActive(Date.parse('2026-11-10T00:00:00Z'), null), false)
  assert.equal(announcementIsActive(Date.parse('2026-11-10T00:00:00Z'), { ...announcement, endsAt: 'soon' }), false)
})

test('a browser shows the served announcement once, and only that one', () => {
  const announcement = WINDOW_ANNOUNCEMENT!
  assert.equal(shouldShowAnnouncement(announcement.id, announcement, []), true)
  assert.equal(shouldShowAnnouncement(announcement.id, announcement, ['late-october-changes-2026-10']), true)
  assert.equal(shouldShowAnnouncement(announcement.id, announcement, ['older', announcement.id]), false)
  assert.equal(shouldShowAnnouncement(undefined, announcement, []), false)
  assert.equal(shouldShowAnnouncement('another-id', announcement, []), false)
  assert.equal(shouldShowAnnouncement(announcement.id, null, []), false)
})

test('the remembered list survives bad storage, never repeats, and keeps the newest 20', () => {
  assert.deepEqual(parseSeenAnnouncementIds(null), [])
  assert.deepEqual(parseSeenAnnouncementIds('not json'), [])
  assert.deepEqual(parseSeenAnnouncementIds('{"id":"x"}'), [])
  assert.deepEqual(parseSeenAnnouncementIds(JSON.stringify(['a', 7, '', 'b', 'x'.repeat(101)])), ['a', 'b'])
  const many = Array.from({ length: 25 }, (_, index) => `id-${index}`)
  assert.deepEqual(parseSeenAnnouncementIds(JSON.stringify(many)), many.slice(-20))
  const seen = ['a', 'b']
  const remembered = rememberAnnouncement(seen, 'a')
  assert.deepEqual(remembered, ['b', 'a'])
  assert.notEqual(remembered, seen)
  assert.deepEqual(seen, ['a', 'b'])
  const full = rememberAnnouncement(many.slice(0, 20), 'new')
  assert.equal(full.length, 20)
  assert.equal(full[0], 'id-1')
  assert.equal(full.at(-1), 'new')
})

test('the window page holds the dialog, discloses what the browser remembers, and the program parses', () => {
  assert.match(WINDOW_HTML, /<div id="announcement" class="announcement-backdrop" hidden>\s*<section class="announcement" role="dialog" aria-modal="true" aria-labelledby="announcement-title" aria-describedby="announcement-body" tabindex="-1">/u)
  assert.match(WINDOW_HTML, /<button id="announcement-ok" class="announcement-ok" type="button"><\/button>/u)
  assert.match(WINDOW_HTML, /This browser also remembers which announcements you closed, up to 20, so each one shows once; clearing site data shows them again\./u)
  assert.doesNotThrow(() => new Function(WINDOW_JS))
  assert.match(WINDOW_JS, /const WINDOW_ANNOUNCEMENT = \{"id":"november-changes-2026-11"/u)
  assert.match(WINDOW_JS, /localStorage\.setItem\(\s*ANNOUNCEMENT_STORAGE_KEY,/u)
  assert.match(WINDOW_JS, /function refreshSeasonIfDayChanged\(\)/u)
})
