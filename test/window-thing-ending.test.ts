// The window's thing view (T15): beside on_use it shows when the thing ends, or that it
// ended, and the end program sentence, read from the thing read's ending and
// end_program_summary. Exercised through the shipped client source.
import assert from 'node:assert/strict'
import test from 'node:test'
import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_CLIENT_SAFETY_JS } from '../src/window-client-safety.ts'

type ThingRecord = Readonly<Record<string, unknown>> | null

const SAFE_HANDLE_LINE = /^ {2}const SAFE_HANDLE = .*$/mu.exec(WINDOW_JS)?.[0] ?? ''
const normalize = new Function('MODERATED_TEXT', 'normalizeHinge', SAFE_HANDLE_LINE + '\n' + WINDOW_CLIENT_SAFETY_JS +
  WINDOW_JS.slice(WINDOW_JS.indexOf('  function normalizeDetailRecord('),
    WINDOW_JS.indexOf('  async function loadDrawingHistory(')) +
  '\nreturn normalizeDetailRecord')('Removed by the maintainer.', () => null) as
  (kind: string, id: number, payload: unknown) => ThingRecord

const SUMMARY = "When this ends it becomes a remnant, then, if waking is on for it and its room lets it wake, the next time a resident is in its room it runs end-glow's end steps once."

function thing(extra: Record<string, unknown>): ThingRecord {
  return normalize('thing', 41, { thing: {
    id: 41, place_id: 2, name: 'counting lamp', body: 'warm', made_by: 'ending-maker',
    current_owner: 'ending-maker', on_use: 'Using it puts nothing on you.', ...extra,
  } })
}

test('the client source this test slices is present', () => {
  assert.notEqual(SAFE_HANDLE_LINE, '')
})

const local = (iso: string) => new Date(iso).toLocaleString()

test('an active end reads Ends with each condition the thing read computed', () => {
  const record = thing({
    ending: {
      status: 'active',
      conditions: [
        { at: '2026-11-20T10:00:00.000Z' },
        { uses: 5, uses_left: 3 },
        { idle_seconds: 3600, unused_deadline: '2026-11-08T09:00:00.000Z' },
        { label_added: 'spent' },
        { after_setting_seconds: 86400, ends_at: '2026-11-09T09:00:00.000Z' },
      ],
      soonest_known_end: '2026-11-08T09:00:00.000Z',
    },
    end_program_summary: SUMMARY,
  })
  assert.ok(record)
  assert.equal(record.endLine, 'Ends on ' + local('2026-11-20T10:00:00.000Z') +
    ' or after 3 more uses or if unused until ' + local('2026-11-08T09:00:00.000Z') +
    ' or when labeled spent or on ' + local('2026-11-09T09:00:00.000Z'))
  assert.equal(record.endProgram, SUMMARY)
  assert.equal(record.onUse, 'Using it puts nothing on you.')
  assert.equal(thing({ ending: { status: 'active', conditions: [{ uses: 1, uses_left: 1 }] } })?.endLine,
    'Ends after 1 more use')
})

test('a due or recorded end reads Ended at its time', () => {
  assert.equal(thing({
    ending: { status: 'due_waiting_settle', ended_at: null, soonest_known_end: '2026-11-07T08:00:00.000Z' },
    end_program_summary: SUMMARY,
  })?.endLine, 'Ended on ' + local('2026-11-07T08:00:00.000Z'))
  const ended = thing({
    ending: { status: 'ended', ended_at: '2026-11-06T08:00:00.000Z', soonest_known_end: '2026-11-06T08:00:00.000Z' },
    end_program_summary: SUMMARY,
  })
  assert.equal(ended?.endLine, 'Ended on ' + local('2026-11-06T08:00:00.000Z'))
  assert.equal(ended?.endProgram, SUMMARY)
})

test('a thing with no end set shows no end line and no end sentence', () => {
  for (const ending of [undefined, null, 'ended', { status: 'permitted_but_unset' }, { status: 'not_permitted_by_kind' }]) {
    const record = thing({ ending, end_program_summary: SUMMARY })
    assert.ok(record)
    assert.equal(record.endLine, null, JSON.stringify(ending))
    assert.equal(record.endProgram, null, JSON.stringify(ending))
  }
  // Unsafe or missing words are left out, never shown.
  const unsafe = thing({
    ending: { status: 'active', conditions: [{ label_added: '\u202Espent' }, { at: 'not a time' }] },
    end_program_summary: '\u202Ehidden',
  })
  assert.equal(unsafe?.endLine, 'Ends')
  assert.equal(unsafe?.endProgram, null)
})

test('the thing detail renders the end line and sentence after on_use', () => {
  assert.match(WINDOW_JS, /if \(record\.kind === 'thing' && record\.endLine\) \{/u)
  assert.match(WINDOW_JS, /element\('p', 'record-detail-meta', record\.endLine\)/u)
  assert.match(WINDOW_JS, /element\('p', 'record-detail-meta', record\.endProgram\)/u)
  const onUse = WINDOW_JS.indexOf("if (record.kind === 'thing' && record.onUse) {")
  const endLine = WINDOW_JS.indexOf("if (record.kind === 'thing' && record.endLine) {")
  assert.ok(onUse > 0 && endLine > onUse, 'the end line is placed after on_use is')
})
