import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { OWNER_NOTICE, ownerNoticeFor } from '../src/window-client/owner-notice.ts'
import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'
import { WINDOW_CSS } from '../src/window-style.ts'

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

function read(path: string): string {
  return readFileSync(new URL('../' + path, import.meta.url), 'utf8')
}

test('the page holds one empty hidden notice right above the tab bar, and the page itself carries no owner text', () => {
  const betweenSignAndTabs = WINDOW_HTML.split('</header>')[1]?.split('<section class="view-console"')[0] ?? ''
  assert.match(
    betweenSignAndTabs,
    /<div id="owner-notice" class="owner-notice" role="note" aria-label="Notice from the builder" hidden>\n\s*<p id="owner-notice-text" class="owner-notice-text"><\/p>\n\s*<button id="owner-notice-hide" class="owner-notice-hide" type="button" aria-label="Hide this notice">Hide<\/button>\n\s*<\/div>/u,
  )
  assert.equal(WINDOW_HTML.match(/id="owner-notice"/gu)?.length, 1)
  assert.doesNotMatch(WINDOW_HTML, /ofstory|Story of the Internet/iu)
  assert.match(WINDOW_CSS, /\.owner-notice \{[^}]*background-image: linear-gradient\(100deg, var\(--signal\) 0%, var\(--paper-light\) 100%\);/u)
  assert.match(WINDOW_CSS, /\.owner-notice \{[^}]*border-inline-start: 0\.6rem solid var\(--brick\);/u)
})

test('the program renders the notice at start and after every city refresh, with one plain link and no storage', () => {
  assert.match(WINDOW_JS, /\n  function renderOwnerNotice\(\) \{\n/u)
  assert.match(WINDOW_JS, /ownerNoticeFor\(Date\.now\(\), OWNER_NOTICE\)/u)
  assert.match(WINDOW_JS, /settleOvertakenFocusedPlaces\(\)\n\s+scheduleRefresh\(nextDelay\)\n\s+renderOwnerNotice\(\)\n\s+\}/u)
  assert.match(WINDOW_JS, /\n  renderOwnerNotice\(\)\n\n  for \(const tab of tabs\) \{/u)
  assert.match(WINDOW_JS, /link\.href = OWNER_NOTICE\.url\n\s+link\.target = '_blank'\n\s+link\.rel = 'noopener'/u)
  assert.doesNotMatch(WINDOW_JS, /sessionStorage|document\.cookie/u)
})

test('no surface an agent reads carries the notice', () => {
  for (const path of [
    'src/frontdoor.txt',
    'src/reference.txt',
    'src/llms.txt',
    'src/door.ts',
    'docs/published/FRONTDOOR.md',
    'src/mcp.ts',
    'src/city-help.ts',
    'src/city-facts.ts',
    'CHANGELOG.md',
    'src/changelog-source.ts',
  ]) {
    assert.doesNotMatch(read(path), /ofstory|Story of the Internet/iu, path)
  }
})
