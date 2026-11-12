// Guards for the kept events tally (decision #196). The tally runs in the background
// only: no read path uses it yet, the feed rule keeps one home, a change to that rule
// forces a new tally rule version, and a migration that could rewrite event history
// must reset the tally. The tally's real-PostgreSQL behaviour is in
// test/integration/events-totals-tally-postgres.test.ts.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { feedRoomEventLateralSql, feedRoomIdsSql } from '../src/feed-rooms.ts'
import {
  loadPublicEventCollectionRows,
  loadPublicEventPageRows,
  PUBLIC_EVENT_TOTALS_COLUMNS_SQL,
} from '../src/public-pagination.ts'
import { EVENTS_TOTALS_RULE_VERSION, eventTallyKeysSql } from '../src/events-totals-tally.ts'
import { EVENTS_TOTALS_SWITCH, eventsTotalsTallyOn } from '../src/events-totals-maintenance.ts'

const root = new URL('../', import.meta.url)
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8')
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

// The tally's grouping, today's feed-room join and the list's totals columns, as one
// text. Change any of them and this hash changes: bump EVENTS_TOTALS_RULE_VERSION in
// src/events-totals-tally.ts (a tally built under the old rule is then rebuilt), and
// pin the new hash beside the new version here.
const RULE_TEXT_BY_VERSION: Readonly<Record<number, string>> = Object.freeze({
  1: '9971ddf9bf56a16512760757e7bb0e1bfd6ea852935ba818e17e78b3276d317d',
})

test('a change to the feed rule or the tally grouping needs a new tally rule version', () => {
  const ruleText = [
    eventTallyKeysSql('event'),
    feedRoomEventLateralSql('event', 'feed_room_ids'),
    PUBLIC_EVENT_TOTALS_COLUMNS_SQL,
  ].join('\n')
  assert.equal(
    sha(ruleText),
    RULE_TEXT_BY_VERSION[EVENTS_TOTALS_RULE_VERSION],
    'the feed rule or the tally grouping changed: bump EVENTS_TOTALS_RULE_VERSION and pin the new text hash',
  )
})

// The events list's statements and the feed-room join every city-wide list uses, as
// main served them at ae3e3d5 before the tally existed (decision #196 adds the tally
// in the background only). A change here is a read change and needs its own review.
const READS_AT_MAIN = Object.freeze({
  lateral_events_place: '6f2038cbe3482755cf088016b79396b1d4040b1c91577f9a2534229c2fb452a6',
  lateral_changes: '3bcf32c95dbda2bb86b721798b2b608518103680c0aace1b715bb296804e407f',
  lateral_front_door: 'd091eeb4477d45cc6f9d74e49400008725d8018a8ec9829f921e8e50922df202',
  events_counted_desc_false: '4d6b4d28024300ff1a6c9a8d294b23a40b006284913e2e117ebcb0b4479c73ee',
  events_fill_desc_false: 'f124e086c9492a741c8f112ce6ebbff76396c223e4545d4e1f78f74e73b1a761',
  events_counted_desc_true: '36ca74df5a55bceeeb8f04876ce736c77bd531e38ee3824b38ef1119c05b49d9',
  events_fill_desc_true: '96bf2af7e90d66652303a221350a0aa8eca4577ccb48cc393dbfb327f4174bf8',
})

test('the events list and the feed-room join send the same SQL text as before the tally', async () => {
  const seen: Record<string, string> = {
    lateral_events_place: sha(feedRoomEventLateralSql('event', feedRoomIdsSql('$3::integer'))),
    lateral_changes: sha(feedRoomEventLateralSql('e', feedRoomIdsSql())),
    lateral_front_door: sha(feedRoomEventLateralSql('event', feedRoomIdsSql())),
  }
  const empty = [{ id: null, total_items: 0, total_text_bytes: 0, left_out_feed_rooms: 0, left_out_feed_room_ids: null }]
  const page = { ok: true, cursor: null, limit: 10, fetchLimit: 11 } as const
  for (const includeDescendants of [false, true]) {
    const filters = { kind: null, actor: null, placeId: null, includeDescendants }
    let counted = ''
    await loadPublicEventCollectionRows(async text => { counted = text; return empty }, filters, page)
    let fill = ''
    await loadPublicEventPageRows(async text => { fill = text; return empty }, filters, page)
    seen[`events_counted_desc_${includeDescendants}`] = sha(counted)
    seen[`events_fill_desc_${includeDescendants}`] = sha(fill)
  }
  assert.deepEqual(seen, READS_AT_MAIN)
})

const TALLY_FILES = new Set(['src/events-totals-tally.ts', 'src/events-totals-check.ts', 'src/events-totals-maintenance.ts'])

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(new URL(directory, root), { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:ts|js|mjs)$/u.test(entry.name) ? [path] : []
  })
}

test('no read path, route, tool or page reads the tally: only the maintenance step reaches it', () => {
  const files = sourceFiles('src')
  assert.ok(files.length > 100)
  const namingTables = files.filter(path => /events_totals_(?:tally|state)/u.test(read(path)))
  assert.deepEqual(new Set(namingTables), TALLY_FILES, 'only the tally modules name its tables')
  const importing = (module: string) => files.filter(path => read(path).includes(`from './${module}'`)).sort()
  assert.deepEqual(importing('events-totals-tally.ts'), ['src/events-totals-check.ts', 'src/events-totals-maintenance.ts'])
  assert.deepEqual(importing('events-totals-check.ts'), ['src/events-totals-maintenance.ts'])
  assert.deepEqual(importing('events-totals-maintenance.ts'), ['src/index.ts'])
  const index = read('src/index.ts')
  const uses = index.split('\n').filter(line => /runEventsTotalsMaintenance|reportEventsTotalsFailure/u.test(line))
  assert.equal(uses.length, 2, 'the import and the one maintenance step')
  assert.match(uses[1]!, /^\s+\{ run: \(\) => runEventsTotalsMaintenance\(runtimeDatabase, process\.env\), report: reportEventsTotalsFailure \},$/u)
  assert.match(index, /runMaintenance: async \(\) => await runEachRetention\(\[[^\]]*runMcpCallLogRetention[^\]]*runEventsTotalsMaintenance[^\]]*\]\)/u)
})

test('the step rides the existing five-minute maintenance cron; no timed job is added', () => {
  const vercel = JSON.parse(read('vercel.json')) as { crons: ReadonlyArray<{ path: string; schedule: string }> }
  assert.deepEqual(vercel.crons.map(cron => `${cron.path} ${cron.schedule}`), [
    '/api/internal/payment-recovery */5 * * * *',
    '/api/internal/gazette-print 0 16 * * 1',
    '/api/internal/showing-room-close 0,10,20,30,40,50 15 * * 1',
  ])
})

const HISTORY_TRIGGER_OFF = /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?(?:events|public_change_log)\s+DISABLE\s+TRIGGER/iu
const TALLY_RESET = /UPDATE\s+events_totals_state\s+SET[^;]*kept_change_id\s*=\s*0/iu
// Migrations before the tally existed; the tally is built after all of them.
const TALLY_MIGRATION = '20261112_events_totals_tally.sql'

test('a migration that turns off an event history guard also resets the tally', () => {
  assert.match('ALTER TABLE events DISABLE TRIGGER events_append_only;', HISTORY_TRIGGER_OFF)
  assert.match('alter table public.public_change_log disable trigger all', HISTORY_TRIGGER_OFF)
  assert.doesNotMatch('ALTER TABLE events_totals_state DISABLE TRIGGER x', HISTORY_TRIGGER_OFF)
  assert.match("UPDATE events_totals_state SET trusted = FALSE, kept_change_id = 0, generation = generation + 1", TALLY_RESET)
  const later = readdirSync(new URL('db/migrations/', root)).filter(name => name.endsWith('.sql') && name > TALLY_MIGRATION)
  for (const name of later) {
    const text = read(`db/migrations/${name}`)
    if (HISTORY_TRIGGER_OFF.test(text)) {
      assert.match(text, TALLY_RESET, `${name} turns off an event history guard, so it must reset events_totals_state`)
    }
  }
  assert.doesNotMatch(read(`db/migrations/${TALLY_MIGRATION}`), HISTORY_TRIGGER_OFF)
})

test('the environment switch is on unless set to something other than on', () => {
  assert.equal(EVENTS_TOTALS_SWITCH, 'EVENTS_TOTALS_TALLY')
  for (const value of [undefined, '', ' ', 'on', ' on ']) {
    assert.equal(eventsTotalsTallyOn({ EVENTS_TOTALS_TALLY: value }), true, `value ${String(value)}`)
  }
  for (const value of ['off', 'OFF', 'On', '0', 'false', 'no']) {
    assert.equal(eventsTotalsTallyOn({ EVENTS_TOTALS_TALLY: value }), false, `value ${value}`)
  }
})
