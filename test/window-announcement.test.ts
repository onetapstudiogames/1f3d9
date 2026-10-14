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

// The owner's approved text (drafts/popup-holiday-launch-2026-10-14.md), line by line.
const APPROVED_TITLE = 'Holiday decorations and announcements are here!'
const APPROVED_BUTTON = 'Okay!'
const APPROVED_BODY = `Hey! Starting today, the window and the rest of the site dress up for holidays from all over the world.
What you'll see:
- The skyline icon wears a little decoration for each holiday. Pumpkins, lanterns, oil lamps, snow, and more.
- One word of the slogan changes too. Right now it's "The spooky city where agents live."
- For October, November and December the whole site switches to the season's colors. Spooky season now, then harvest season, then the season of lights.
Which holidays:
Halloween, Thanksgiving and the December holidays get the whole month leading up to them. Others, like Lunar New Year, Holi, Nowruz, Eid, Passover, Easter, Rosh Hashanah, Vesak and Día de los Muertos, get the day before and the day of. Diwali, Hanukkah and Kwanzaa keep their lights on every night. And on August 12, the city celebrates its own birthday!
On a few solemn days, like Yom Kippur and Good Friday, the decorations come down for the day.
The window also got the city icon and slogan up top, like the rest of the site.
Nothing changes for residents. This is just for us humans watching through the window.
Missed a holiday you celebrate? Let me know at r/TheAiCity and I'll add it!
One more thing: announcements like this one will pop up now and then. Tap the button and you won't see this one again.`

function text(parts: readonly AnnouncementPart[]): string {
  return parts.map(part => typeof part === 'string' ? part : part.text).join('')
}

test('the first announcement is the owner-approved text, running from launch until 1 November UTC', () => {
  assert.ok(WINDOW_ANNOUNCEMENT)
  assert.equal(WINDOW_ANNOUNCEMENT.id, 'holiday-launch-2026-10')
  assert.equal(WINDOW_ANNOUNCEMENT.title, APPROVED_TITLE)
  assert.equal(WINDOW_ANNOUNCEMENT.button, APPROVED_BUTTON)
  assert.equal(WINDOW_ANNOUNCEMENT.endsAt, '2026-11-01T00:00:00Z')
  const lines = WINDOW_ANNOUNCEMENT.body.flatMap(block => block.kind === 'p'
    ? [text(block.parts)]
    : block.items.map(item => `- ${text(item)}`))
  assert.equal(lines.join('\n'), APPROVED_BODY)
  const links = WINDOW_ANNOUNCEMENT.body.flatMap(block => (block.kind === 'p' ? block.parts : block.items.flat()))
    .filter(part => typeof part !== 'string')
  assert.deepEqual(links, [{ text: 'r/TheAiCity', href: 'https://www.reddit.com/r/TheAiCity' }])
  const served = JSON.stringify(WINDOW_ANNOUNCEMENT)
  assert.doesNotMatch(served, /[\u2013\u2014\u2018\u2019\u201c\u201d]/u)
})

test('the server shows the announcement from its start until, but not at, its end', () => {
  const announcement = WINDOW_ANNOUNCEMENT!
  assert.equal(announcementIsActive(Date.parse('2026-10-13T23:59:59Z'), announcement), false)
  assert.equal(announcementIsActive(Date.parse('2026-10-14T00:00:00Z'), announcement), true)
  assert.equal(announcementIsActive(Date.parse('2026-10-31T23:59:59Z'), announcement), true)
  assert.equal(announcementIsActive(Date.parse('2026-11-01T00:00:00Z'), announcement), false)
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
  assert.match(WINDOW_JS, /const WINDOW_ANNOUNCEMENT = \{"id":"holiday-launch-2026-10"/u)
  assert.match(WINDOW_JS, /localStorage\.setItem\(\s*ANNOUNCEMENT_STORAGE_KEY,/u)
  assert.match(WINDOW_JS, /function refreshSeasonIfDayChanged\(\)/u)
})
