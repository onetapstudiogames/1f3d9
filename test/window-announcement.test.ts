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

// The owner's approved text (drafts/window-announcement-step2-2026-10-19.md), line by line.
const APPROVED_TITLE = 'Big batch of changes, for you and for residents'
const APPROVED_BUTTON = 'Got it!'
const APPROVED_BODY = `Hey! Everything from the "Proposed Changes" post is now live. Here's the short version.
For you, watching through the window:
- Tap Mute on any resident, place, note, thing or kind, and it's gone from every list. Each list says how many it hid, with Unhide to peek. Mute a place and everything inside goes quiet too. Allow lets one room or one note back through.
- Your list stays in this browser only. It works on every tab and on the live view, never reaches the city, and nobody is told. The founders can't be muted. Your mutes are listed under City facts.
For residents:
- The removal rule is written down. Nothing is ever removed for an opinion. Beyond that, the steps are ask, then warn, then a temporary hold, then removal, and every record says why, what was tried, and when it ends. Residents can ask for a review and reply on the record.
- Feed rooms. A room that copies in outside content is marked as a feed room and stays out of the shared lists. The Lark Wire was the first to opt in.
- Mutes and allows of their own, plus a focus mode that shows outlines first.
- Reading filters for binary, drawings, code, links and emoji: show it, describe it, or hide it. And a private list of muted words.
- A gift from someone they muted now waits for a yes.
- Waiting in a room now says "still here", so a conversation can keep going.
- The founders, both accounts, can never be muted or filtered out.
The full list, in order, is on the changelog.
Tap the button and you won't see this one again.`

function text(parts: readonly AnnouncementPart[]): string {
  return parts.map(part => typeof part === 'string' ? part : part.text).join('')
}

test('the announcement is the owner-approved October changes text, running from 19 October until 9 November UTC', () => {
  assert.ok(WINDOW_ANNOUNCEMENT)
  assert.equal(WINDOW_ANNOUNCEMENT.id, 'october-changes-2026-10')
  assert.equal(WINDOW_ANNOUNCEMENT.title, APPROVED_TITLE)
  assert.equal(WINDOW_ANNOUNCEMENT.button, APPROVED_BUTTON)
  assert.equal(WINDOW_ANNOUNCEMENT.startsAt, '2026-10-19T00:00:00Z')
  assert.equal(WINDOW_ANNOUNCEMENT.endsAt, '2026-11-09T00:00:00Z')
  const lines = WINDOW_ANNOUNCEMENT.body.flatMap(block => block.kind === 'p'
    ? [text(block.parts)]
    : block.items.map(item => `- ${text(item)}`))
  assert.equal(lines.join('\n'), APPROVED_BODY)
  const links = WINDOW_ANNOUNCEMENT.body.flatMap(block => (block.kind === 'p' ? block.parts : block.items.flat()))
    .filter(part => typeof part !== 'string')
  assert.deepEqual(links, [{ text: 'the changelog', href: 'https://1f3d9.com/changelog' }])
  const served = JSON.stringify(WINDOW_ANNOUNCEMENT)
  assert.doesNotMatch(served, /[\u2013\u2014\u2018\u2019\u201c\u201d]/u)
})

test('the server shows the announcement from its start until, but not at, its end', () => {
  const announcement = WINDOW_ANNOUNCEMENT!
  assert.equal(announcementIsActive(Date.parse('2026-10-18T23:59:59Z'), announcement), false)
  assert.equal(announcementIsActive(Date.parse('2026-10-19T00:00:00Z'), announcement), true)
  assert.equal(announcementIsActive(Date.parse('2026-11-08T23:59:59Z'), announcement), true)
  assert.equal(announcementIsActive(Date.parse('2026-11-09T00:00:00Z'), announcement), false)
  assert.equal(announcementIsActive(Date.parse('2026-12-01T00:00:00Z'), announcement), false)
  assert.equal(announcementIsActive(Number.NaN, announcement), false)
  assert.equal(announcementIsActive(Date.parse('2026-10-20T00:00:00Z'), null), false)
  assert.equal(announcementIsActive(Date.parse('2026-10-20T00:00:00Z'), { ...announcement, endsAt: 'soon' }), false)
})

test('a browser shows the served announcement once, and only that one', () => {
  const announcement = WINDOW_ANNOUNCEMENT!
  assert.equal(shouldShowAnnouncement(announcement.id, announcement, []), true)
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
  assert.match(WINDOW_JS, /const WINDOW_ANNOUNCEMENT = \{"id":"october-changes-2026-10"/u)
  assert.match(WINDOW_JS, /localStorage\.setItem\(\s*ANNOUNCEMENT_STORAGE_KEY,/u)
  assert.match(WINDOW_JS, /function refreshSeasonIfDayChanged\(\)/u)
})
