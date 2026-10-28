import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { OWNER_NOTICE, ownerNoticeFor } from '../src/window-client/owner-notice.ts'
import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'
import { WINDOW_CSS } from '../src/window-style.ts'

// The owner's text, byte for byte (asked for 2026-10-20). This test keeps its own copy on purpose.
const TEXT = 'ChatGPT user getting "blocked by OpenAI\'s safety checks"? Post the time, the connector and the exact message on the OpenAI forum thread so OpenAI sees it.'
const LINK_TEXT = 'the OpenAI forum thread'
// The topic itself, so a visitor lands on the first post.
const THREAD = 'https://community.openai.com/t/custom-mcp-connector-valid-tool-calls-blocked-by-safety-checks-server-logs-confirm-they-never-arrive/1407832'
const SECOND_MS = 1000
const SHOW_AT_MS = Date.parse('2026-10-20T00:00:00.000Z')
const HIDE_AT_MS = Date.parse('2026-11-20T00:00:00.000Z')

test('the notice holds the owner text byte for byte, one link to the thread, and two instants a month apart', () => {
  assert.equal(OWNER_NOTICE.text, TEXT)
  assert.equal(OWNER_NOTICE.linkText, LINK_TEXT)
  assert.equal(OWNER_NOTICE.url, THREAD)
  assert.equal(OWNER_NOTICE.showAt, '2026-10-20T00:00:00.000Z')
  assert.equal(OWNER_NOTICE.hideAt, '2026-11-20T00:00:00.000Z')
  assert.equal(HIDE_AT_MS - SHOW_AT_MS, 31 * 24 * 60 * 60 * SECOND_MS)
  assert.equal(TEXT.split(LINK_TEXT).length, 2, 'the link text appears exactly once')
  assert.doesNotMatch(TEXT, /[\u2013\u2014\u2018\u2019\u201C\u201D]/u, 'no long dash or curly quote')
  assert.ok(THREAD.endsWith('/1407832'), 'the topic itself, not a reply number')
  assert.ok(Object.isFrozen(OWNER_NOTICE))
})

test('the text shows from the show instant until the hide instant and never outside it', () => {
  const at = (ms: number) => ownerNoticeFor(ms, OWNER_NOTICE)
  assert.equal(at(Date.parse('2026-10-19T12:00:00.000Z')), null)
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
  assert.doesNotMatch(WINDOW_HTML, /1407832|forum thread/iu)
  assert.match(WINDOW_CSS, /\.owner-notice \{[^}]*background-image: linear-gradient\(100deg, var\(--signal\) 0%, var\(--paper-light\) 100%\);/u)
  assert.match(WINDOW_CSS, /\.owner-notice \{[^}]*border-inline-start: 0\.6rem solid var\(--brick\);/u)
})

test('the program renders the notice at start and after every city refresh, with one plain link and no storage', () => {
  assert.match(WINDOW_JS, /\n  function renderOwnerNotice\(\) \{\n/u)
  assert.match(WINDOW_JS, /ownerNoticeFor\(Date\.now\(\), OWNER_NOTICE\)/u)
  const refreshStart = WINDOW_JS.indexOf('  async function refreshCity()')
  const refreshEnd = WINDOW_JS.indexOf('  for (const tab of tabs) {', refreshStart)
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart)
  assert.match(WINDOW_JS.slice(refreshStart, refreshEnd),
    /finally \{[\s\S]*settleOvertakenFocusedPlaces\(\)\n\s+scheduleRefresh\(nextDelay\)[\s\S]*?\n {6}renderOwnerNotice\(\)\n\s+void refreshSeasonIfDayChanged\(\)\n\s+\}/u)
  assert.match(WINDOW_JS, /\n  renderOwnerNotice\(\)\n\n  const announcementBox = /u)
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
    assert.doesNotMatch(read(path), /1407832|ofstory|Story of the Internet/iu, path)
  }
})
