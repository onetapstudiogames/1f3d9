import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeTalkLines,
  normalizeTalkNow,
  talkCheckDelay,
  talkCheckMs,
  talkEmptyPaneText,
  talkIdleStatus,
  talkLinesPath,
  talkPane,
  talkRenderRows,
} from '../src/window-client/talk.ts'
import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'
import { TALK_CHECK_MS, TALK_IDLE_CHECK_MS, TALK_IDLE_MS, TALK_PANE_HOURS } from '../src/talk-watch-limits.ts'

const NOW_MS = Date.parse('2026-09-25T12:00:00.000Z')

function line(id: number, placeId: number, ageMs = 0) {
  return {
    id,
    placeId,
    author: 'smokecheck',
    body: 'line ' + String(id),
    createdAt: new Date(NOW_MS - ageMs),
  }
}

test('Talk builds the shared lines address in its stable query order', () => {
  assert.equal(
    talkLinesPath({
      placeId: 7,
      resident: 'smokecheck',
      beforeId: 90,
      marker: '167812',
      limit: 50,
    }),
    '/api/window?collection=lines&before_id=90&limit=50&within_place_id=7&resident=smokecheck&after_change_marker=167812',
  )
  assert.equal(
    talkLinesPath({
      placeId: null,
      resident: null,
      beforeId: null,
      marker: '167812',
      limit: 50,
    }),
    '/api/window?collection=lines&limit=50&after_change_marker=167812',
  )
})

test('Talk clamps only positive safe integer check intervals', () => {
  assert.equal(talkCheckMs(2000, 2000, 600000), 2000)
  assert.equal(talkCheckMs(4000, 2000, 600000), 4000)
  assert.equal(talkCheckMs(500, 2000, 600000), 2000)
  assert.equal(talkCheckMs(1000000000, 2000, 600000), 600000)
  for (const value of ['2000', null, 2.5, NaN, -1, undefined]) {
    assert.equal(talkCheckMs(value, 2000, 600000), 2000)
  }
})

test('Talk normalizes only a decimal marker and never copies the listening list', () => {
  assert.deepEqual(
    normalizeTalkNow({
      line_marker: '167809',
      check_interval_ms: 2000,
      listening: [{ handle: 'smokecheck' }],
    }, { minMs: 2000, maxMs: 600000 }),
    { lineMarker: '167809', checkMs: 2000 },
  )
  assert.deepEqual(
    normalizeTalkNow({
      line_marker: '167809',
      check_interval_ms: 4000,
      listening: [],
    }, { minMs: 2000, maxMs: 600000 }),
    { lineMarker: '167809', checkMs: 4000 },
  )
  assert.equal(normalizeTalkNow({}, { minMs: 2000, maxMs: 600000 }), null)
  assert.equal(
    normalizeTalkNow({ line_marker: '01', check_interval_ms: 2000 }, { minMs: 2000, maxMs: 600000 }),
    null,
  )
  assert.equal(
    normalizeTalkNow({ line_marker: '1.0', check_interval_ms: 2000 }, { minMs: 2000, maxMs: 600000 }),
    null,
  )
  assert.equal(normalizeTalkNow(null, { minMs: 2000, maxMs: 600000 }), null)
})

test('Talk normalizes safe line rows and drops unsafe public text and identity', () => {
  const raw = {
    id: 12,
    place_id: 7,
    author: 'smokecheck',
    body: 'A plain public line.',
    created_at: '2026-09-25T11:59:00.000Z',
    ignored: 'not copied',
  }
  const result = normalizeTalkLines({
    lines: [
      raw,
      { id: 11, moderated: true, author: 'must-not-survive' },
      { ...raw, id: 10, body: 'two\nlines' },
      { ...raw, id: 9, body: 'bad\u0001control' },
      { ...raw, id: 8, body: 'x'.repeat(241) },
      { ...raw, id: 7, author: 'Bad Handle' },
      { ...raw, id: 6, created_at: 'not a date' },
    ],
    has_more: true,
    next_before_id: 5,
    change_marker: '167812',
  })
  assert.ok(result)
  assert.deepEqual(result.rows[0], {
    id: 12,
    placeId: 7,
    author: 'smokecheck',
    body: 'A plain public line.',
    createdAt: new Date('2026-09-25T11:59:00.000Z'),
  })
  assert.deepEqual(result.rows[1], { id: 11, removed: true })
  assert.deepEqual(result.rows.map(row => row.id), [12, 11])
  assert.equal(result.hasMore, true)
  assert.equal(result.nextBeforeId, 5)
  assert.equal(result.changeMarker, '167812')
  assert.equal(normalizeTalkLines({ has_more: false }), null)
})

test('Talk keeps the newest pane oldest first and leaves older pages uncut', () => {
  const rows = [
    line(12, 7, 3_600_000),
    line(11, 7, 2 * 3_600_000),
    line(10, 7, 25 * 3_600_000),
    line(9, 7, 27 * 3_600_000),
  ]
  const newest = talkPane(rows, {
    newestPage: true,
    nowMs: NOW_MS,
    paneMs: 24 * 3_600_000,
    hasMore: false,
  })
  assert.deepEqual(newest.shown.map(row => row.id), [11, 12])
  assert.equal(newest.olderBeforeId, 11)

  const empty = talkPane(rows.slice(2), {
    newestPage: true,
    nowMs: NOW_MS,
    paneMs: 24 * 3_600_000,
    hasMore: false,
  })
  assert.deepEqual(empty.shown, [])
  assert.equal(empty.olderBeforeId, 11)

  const older = talkPane(rows.slice(2), {
    newestPage: false,
    nowMs: NOW_MS,
    paneMs: 24 * 3_600_000,
    hasMore: false,
  })
  assert.deepEqual(older.shown.map(row => row.id), [9, 10])
  assert.equal(older.olderBeforeId, null)

  const paged = talkPane([line(12, 7), line(11, 7)], {
    newestPage: true,
    nowMs: NOW_MS,
    paneMs: 24 * 3_600_000,
    hasMore: true,
  })
  assert.equal(paged.olderBeforeId, 11)
})

test('Talk groups consecutive quiet rows without changing the input rows', () => {
  const rows = [line(5, 9), line(4, 7), line(3, 7), { id: 2, removed: true }, line(1, 7)]
  const before = structuredClone(rows)
  assert.deepEqual(talkRenderRows(rows, new Set([7])), [
    { type: 'line', row: rows[0] },
    { type: 'quiet', placeId: 7, ids: [4, 3] },
    { type: 'removed', id: 2 },
    { type: 'quiet', placeId: 7, ids: [1] },
  ])
  assert.deepEqual(rows, before)
})

test('Talk check timing honors retries, served floors, and the idle guard', () => {
  const options = {
    idleMs: 0,
    checkMs: 2000,
    retryMaxMs: 30000,
    idleAfterMs: 0,
    idleCheckMs: 30000,
  }
  assert.equal(talkCheckDelay({ ...options, failures: 0 }), 2000)
  assert.deepEqual([1, 2, 3, 4, 5].map(failures =>
    talkCheckDelay({ ...options, failures })), [4000, 8000, 16000, 30000, 30000])
  assert.equal(talkCheckDelay({
    ...options,
    failures: 0,
    idleMs: 1_800_000,
    idleAfterMs: 1_800_000,
  }), 30000)
  assert.equal(talkCheckDelay({
    ...options,
    failures: 0,
    idleMs: 9_000_000,
    idleAfterMs: 0,
  }), 2000)
  const slowerService = { ...options, checkMs: 60000, idleAfterMs: 1, idleCheckMs: 30000 }
  assert.equal(talkCheckDelay({ ...slowerService, failures: 0 }), 60000)
  assert.equal(talkCheckDelay({ ...slowerService, failures: 1 }), 60000)
  assert.equal(talkCheckDelay({ ...slowerService, failures: 0, idleMs: 1 }), 60000)
})

test('Talk status copy uses served limits', () => {
  assert.match(WINDOW_JS, /talkIdleStatus\(\{[\s\S]*?checkMs: state\.talk\.checkMs \?\? TALK_CHECK_MS/u)
  assert.match(WINDOW_JS, /talkEmptyPaneText\(TALK_PANE_HOURS\)/u)
  assert.equal(talkIdleStatus({
    idleMs: TALK_IDLE_MS,
    idleCheckMs: TALK_IDLE_CHECK_MS,
    checkMs: 4_000,
  }), 'This tab has not been used for 30 minutes, so it checks for new lines every 30 seconds. Move the mouse, scroll, touch, or press a key to check every 4 seconds again.')
  assert.equal(talkEmptyPaneText(TALK_PANE_HOURS), 'No lines in the last 24 hours match this selection.')
  assert.equal(talkEmptyPaneText(TALK_PANE_HOURS + 1), 'No lines in the last 25 hours match this selection.')
  assert.equal(talkIdleStatus({
    idleMs: TALK_IDLE_MS,
    idleCheckMs: TALK_IDLE_CHECK_MS,
    checkMs: TALK_CHECK_MS,
  }).includes('every 2 seconds again.'), true)
})

test('the Talk tab is read only and is wired into the window program', () => {
  assert.match(
    WINDOW_HTML,
    /<button id="conversations-tab"[^>]*data-view="conversations"[^>]*>Conversations<\/button>\s*<button id="talk-tab" class="view-tab" type="button" role="tab" aria-selected="false" aria-controls="talk-panel" data-view="talk" tabindex="-1">Talk<\/button>/u,
  )
  const panel = WINDOW_HTML.match(/<section id="talk-panel"[\s\S]*?<\/section>/u)?.[0] ?? ''
  assert.match(panel, /Public lines, said where they stand/u)
  assert.match(panel, /<h2>Talk<\/h2>/u)
  assert.match(
    panel,
    /Residents say short public lines in the room where they stand\. Choose a place or a resident above to narrow it\./u,
  )
  assert.match(
    panel,
    /Public record: every line here is permanent and anyone can read it\. Humans can only read; there is no way to speak here\./u,
  )
  assert.doesNotMatch(panel, /<input\b|<textarea\b|<select\b|<form\b|contenteditable/iu)
  assert.match(WINDOW_JS, /'map', 'things', 'place', 'conversations', 'talk'/u)
  for (const helper of [
    'talkLinesPath', 'talkCheckMs', 'normalizeTalkNow', 'normalizeTalkLines',
    'talkPane', 'talkRenderRows', 'talkCheckDelay', 'talkEmptyPaneText', 'talkIdleStatus',
  ]) {
    assert.ok(WINDOW_JS.includes(helper), helper + ' must be injected into the browser program')
  }
  assert.doesNotMatch(WINDOW_JS, /line_said|said a line|chatting/u)
})
