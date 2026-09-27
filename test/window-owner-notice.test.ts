import assert from 'node:assert/strict'
import test from 'node:test'
import { OWNER_NOTICE, ownerNoticeFor } from '../src/window-client/owner-notice.ts'
import { WINDOW_JS } from '../src/window-client.ts'

// The owner's two texts, byte for byte (2026-09-27). This test keeps its own copy on purpose.
const WAITLIST = "Just a temporary little notice: my other project, The Story of the Internet, opens in Alpha this Saturday at 8am Central! I've been working on it for awhile! There's a waitlist up now if you want in early: https://ofstory.net :)"
const LAUNCHED = "Just a temporary little notice that my other project, The Story of the Internet, has launched in Alpha! I've been working on it for awhile! Feel free to check it out at https://ofstory.net :)"
const SECOND_MS = 1000
const LAUNCH_AT_MS = Date.parse('2026-10-03T13:00:00.000Z')
const HIDE_AT_MS = Date.parse('2026-10-17T13:00:00.000Z')

function centralParts(ms: number): readonly string[] {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'long',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(ms)
  const part = (type: string) => parts.find(entry => entry.type === type)?.value ?? ''
  return [part('weekday'), part('year'), part('month'), part('day'), part('hour'), part('minute')]
}

test('the notice holds the owner texts byte for byte, one link, and two instants two weeks apart', () => {
  assert.equal(OWNER_NOTICE.waitlistText, WAITLIST)
  assert.equal(OWNER_NOTICE.launchedText, LAUNCHED)
  assert.equal(OWNER_NOTICE.url, 'https://ofstory.net')
  assert.equal(OWNER_NOTICE.launchAt, '2026-10-03T13:00:00.000Z')
  assert.equal(OWNER_NOTICE.hideAt, '2026-10-17T13:00:00.000Z')
  assert.equal(HIDE_AT_MS - LAUNCH_AT_MS, 14 * 24 * 60 * 60 * SECOND_MS)
  // The owner said 8am Central on Saturday; both instants are 8:00 in Chicago on a Saturday.
  assert.deepEqual(centralParts(LAUNCH_AT_MS), ['Saturday', '2026', '10', '3', '08', '00'])
  assert.deepEqual(centralParts(HIDE_AT_MS), ['Saturday', '2026', '10', '17', '08', '00'])
  for (const text of [WAITLIST, LAUNCHED]) {
    assert.equal(text.split(OWNER_NOTICE.url).length, 2, 'the link appears exactly once')
    assert.doesNotMatch(text, /[\u2013\u2014\u2018\u2019\u201C\u201D]/u, 'no long dash or curly quote')
  }
  assert.ok(Object.isFrozen(OWNER_NOTICE))
})

test('the waitlist text shows before the launch instant, the launch text from it, and nothing from the hide instant', () => {
  const at = (ms: number) => ownerNoticeFor(ms, OWNER_NOTICE)
  assert.equal(at(Date.parse('2026-09-28T00:00:00.000Z')), WAITLIST)
  assert.equal(at(LAUNCH_AT_MS - SECOND_MS), WAITLIST)
  assert.equal(at(LAUNCH_AT_MS), LAUNCHED)
  assert.equal(at(LAUNCH_AT_MS + SECOND_MS), LAUNCHED)
  assert.equal(at(HIDE_AT_MS - SECOND_MS), LAUNCHED)
  assert.equal(at(HIDE_AT_MS), null)
  assert.equal(at(HIDE_AT_MS + SECOND_MS), null)
  assert.equal(at(Number.NaN), null)
  assert.equal(at(Number.POSITIVE_INFINITY), null)
  assert.equal(ownerNoticeFor(LAUNCH_AT_MS, { ...OWNER_NOTICE, hideAt: 'not a time' }), null)
})

test('the browser program carries the rule and the notice as injected constants', () => {
  assert.ok(WINDOW_JS.includes('const ownerNoticeFor = '), 'the rule is injected')
  assert.ok(
    WINDOW_JS.includes('const OWNER_NOTICE = Object.freeze(' + JSON.stringify(OWNER_NOTICE) + ')\n'),
    'the notice constant is injected as JSON',
  )
  assert.equal(WINDOW_JS.split(WAITLIST).length, 2, 'the waitlist text appears once in the program')
  assert.equal(WINDOW_JS.split(LAUNCHED).length, 2, 'the launch text appears once in the program')
})
