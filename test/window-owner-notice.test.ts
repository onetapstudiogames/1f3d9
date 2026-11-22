import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { OWNER_NOTICE, ownerNoticeFor } from '../src/window-client/owner-notice.ts'
import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'
import { WINDOW_CSS } from '../src/window-style.ts'

// Keep the owner's approved text and store address here independently of the source.
const TEXT = '1F3D9 is now on Android. Pick a resident and follow them from room to room, see what they make and say, or catch up with the weekly Gazette. Get it on Google Play'
const LINK_TEXT = 'Get it on Google Play'
const PLAY = 'https://play.google.com/store/apps/details?id=com.twamd.city_observatory'
const SECOND_MS = 1000
const SHOW_AT_MS = Date.parse('2026-11-21T23:15:00.000Z')
const HIDE_AT_MS = Date.parse('2026-11-28T23:15:00.000Z')

test('the notice holds the approved text and one Google Play link for exactly one week', () => {
  assert.equal(OWNER_NOTICE.text, TEXT)
  assert.equal(OWNER_NOTICE.linkText, LINK_TEXT)
  assert.equal(OWNER_NOTICE.url, PLAY)
  assert.equal(Date.parse(OWNER_NOTICE.showAt), SHOW_AT_MS)
  assert.equal(Date.parse(OWNER_NOTICE.hideAt), HIDE_AT_MS)
  assert.equal(HIDE_AT_MS - SHOW_AT_MS, 7 * 24 * 60 * 60 * SECOND_MS)
  assert.ok(TEXT.endsWith(LINK_TEXT))
  assert.ok(Object.isFrozen(OWNER_NOTICE))
})

test('the text shows from the show instant until the hide instant and never outside it', () => {
  const at = (ms: number) => ownerNoticeFor(ms, OWNER_NOTICE)
  assert.equal(at(SHOW_AT_MS - SECOND_MS), null)
  assert.equal(at(SHOW_AT_MS), TEXT)
  assert.equal(at(SHOW_AT_MS + SECOND_MS), TEXT)
  assert.equal(at(HIDE_AT_MS - SECOND_MS), TEXT)
  assert.equal(at(HIDE_AT_MS), null)
  assert.equal(at(HIDE_AT_MS + SECOND_MS), null)
  assert.equal(at(Number.NaN), null)
  assert.equal(at(Number.POSITIVE_INFINITY), null)
  assert.equal(ownerNoticeFor(SHOW_AT_MS, { ...OWNER_NOTICE, hideAt: 'not a time' }), null)
  assert.equal(ownerNoticeFor(SHOW_AT_MS, { ...OWNER_NOTICE, showAt: 'not a time' }), null)
})

test('the browser program carries the rule and the notice as injected constants', () => {
  assert.ok(WINDOW_JS.includes('const ownerNoticeFor = '), 'the rule is injected')
  assert.ok(
    WINDOW_JS.includes('const OWNER_NOTICE = Object.freeze(' + JSON.stringify(OWNER_NOTICE) + ')\n'),
    'the notice constant is injected as JSON',
  )
  assert.equal(WINDOW_JS.split(JSON.stringify(TEXT).slice(1, -1)).length, 2, 'the text appears once in the program')
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
  assert.ok(!WINDOW_HTML.includes(TEXT))
  const guide = WINDOW_HTML.split('<nav class="window-guide-links"')[1]?.split('</nav>')[0] ?? ''
  assert.ok(guide.indexOf('>Tools</a>') < guide.indexOf('>Android app</a>'))
  assert.ok(guide.indexOf('>Android app</a>') < guide.indexOf('Visual Wiki'))
  assert.ok(guide.includes('href="' + PLAY + '"'))
  assert.match(WINDOW_CSS, /\.owner-notice \{[^}]*background-image: linear-gradient\(100deg, var\(--signal\) 0%, var\(--paper-light\) 100%\);/u)
  assert.match(WINDOW_CSS, /\.owner-notice \{[^}]*border-inline-start: 0\.6rem solid var\(--brick\);/u)
})

test('the program renders the notice at start and after every city refresh, with one plain link', () => {
  assert.match(WINDOW_JS, /\n  function renderOwnerNotice\(\) \{\n/u)
  assert.match(WINDOW_JS, /ownerNoticeFor\(Date\.now\(\), OWNER_NOTICE\)/u)
  const refreshStart = WINDOW_JS.indexOf('  async function refreshCity()')
  const refreshEnd = WINDOW_JS.indexOf('  for (const tab of tabs) {', refreshStart)
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart)
  assert.match(WINDOW_JS.slice(refreshStart, refreshEnd),
    /finally \{[\s\S]*settleOvertakenFocusedPlaces\(\)\n\s+scheduleRefresh\(nextDelay\)[\s\S]*?\n {6}renderOwnerNotice\(\)\n\s+void refreshSeasonIfDayChanged\(\)\n\s+\}/u)
  const ownerNoticeStart = WINDOW_JS.lastIndexOf('\n  renderOwnerNotice()\n')
  const moveInStart = WINDOW_JS.indexOf('  const moveDialog = ', ownerNoticeStart)
  const announcementStart = WINDOW_JS.indexOf('  const announcementBox = ', ownerNoticeStart)
  assert.ok(ownerNoticeStart >= 0 && moveInStart > ownerNoticeStart && announcementStart > moveInStart)
  assert.match(WINDOW_JS, /text\.indexOf\(OWNER_NOTICE\.linkText\)/u)
  assert.match(WINDOW_JS, /link\.href = OWNER_NOTICE\.url\n\s+link\.target = '_blank'\n\s+link\.rel = 'noopener'\n\s+link\.textContent = OWNER_NOTICE\.linkText/u)
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
    assert.doesNotMatch(read(path), /Get it on Google Play|play\.google\.com\/store\/apps\/details/iu, path)
  }
})
