import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FOCUSED_READ_OVERTAKEN_LIMIT,
  focusedReadOvertaken,
  overtakenReadIsDue,
} from '../src/window-client/focused-read.ts'
import { WINDOW_JS } from '../src/window-client.ts'

test('a selected-activity refresh preserves residents loaded while its read is pending', async () => {
  const loader = WINDOW_JS.slice(WINDOW_JS.indexOf('  async function refreshSelectedActivity('),
    WINDOW_JS.indexOf('  function scheduleRefresh('))
  let complete: (rows: unknown[]) => void = () => {}
  const harness = new Function('refreshUnchangedPresence', `
    let state = { changeMarker: '20', snapshot: { residents: [{ id: 3 }, { id: 2 }] },
      residentPaging: { nextBeforeId: 2, hasMore: true } }
    let publicActivityRevision = 0, navigationRevision = 0
    let residentActivity = new Map()
    const document = { hidden: false }
    const window = { setTimeout, clearTimeout }
    const REQUEST_TIMEOUT_MS = 5000
    const renderAll = () => {}
    ${loader}
    return { read: refreshSelectedActivity, state: () => state, loadMore: () => {
      navigationRevision += 1
      state = { ...state, snapshot: { ...state.snapshot,
        residents: [...state.snapshot.residents, { id: 1 }] },
        residentPaging: { nextBeforeId: 1, hasMore: false } }
    } }
  `)(() => new Promise(resolve => { complete = resolve }))
  const pending = harness.read()
  harness.loadMore()
  complete([{ id: 3 }, { id: 2 }])
  await pending
  assert.deepEqual(harness.state().snapshot.residents.map((row: { id: number }) => row.id), [3, 2, 1])
  assert.deepEqual(harness.state().residentPaging, { nextBeforeId: 1, hasMore: false })
})

test('selected-place background reads retain prose and release cancelled pending entries', async () => {
  const loader = WINDOW_JS.slice(WINDOW_JS.indexOf('  async function ensureDetail('),
    WINDOW_JS.indexOf('  function detailDrawingKey('))
  const record = { description: 'kept prose', labels: ['old'], laws: [] }
  let complete: (response: unknown) => void = () => {}
  let fetches = 0
  const harness = new Function('fetch', 'record', `
    let state = { placeId: 11, view: 'place', details: { 'place:11': { record } } }
    let authoredRevision = 0, navigationRevision = 0, detailRequestRevision = 0
    let publicActivityRevision = 0, publicActivitySelectionRevision = 0
    let placeActivity = new Map()
    const document = { hidden: false }
    const activityBand = value => value
    const activeSelectionKey = () => state.view + ':' + state.placeId
    const window = { location: { origin: 'https://127.0.0.1' }, setTimeout, clearTimeout }
    const REQUEST_TIMEOUT_MS = 5000
    const renderAll = () => {}, renderDetail = () => {}, renderSelectedPlaceDetail = () => {}
    const normalizeDetailRecord = (_kind, _id, payload) => payload.place
    ${loader}
    return { read: () => ensureDetail(true, 11, true), state: () => state,
      navigate: () => { state = { ...state, placeId: 12 } } }
  `)(() => { fetches += 1; return new Promise(resolve => { complete = resolve }) }, record)
  const pending = harness.read()
  assert.equal(harness.state().details['place:11'].record, record)
  assert.equal(harness.state().details['place:11'].loading, true)
  await harness.read()
  assert.equal(fetches, 1, 'a pending refresh is not duplicated')
  harness.navigate()
  complete({ ok: true, status: 200, json: async () => ({ place: { ...record, labels: ['late'] } }) })
  await pending
  assert.equal(harness.state().placeId, 12)
  assert.equal(harness.state().details['place:11'].loading, false)
  assert.equal(harness.state().details['place:11'].error, true)
  assert.equal(harness.state().details['place:11'].record, record)
})

test('cancelled background reads render unavailable facts after leaving and returning before reply', async () => {
  const loader = WINDOW_JS.slice(WINDOW_JS.indexOf('  async function ensureDetail('),
    WINDOW_JS.indexOf('  function detailDrawingKey('))
  const record = { description: 'kept prose', labels: ['rain_now'], laws: [] }
  let complete: (response: unknown) => void = () => {}
  let responseReads = 0
  const harness = new Function('fetch', 'record', `
    let state = { placeId: 11, view: 'place', details: { 'place:11': { record } } }
    let authoredRevision = 0, navigationRevision = 0, detailRequestRevision = 0
    let publicActivityRevision = 0, publicActivitySelectionRevision = 0
    let placeActivity = new Map()
    const document = { hidden: false }
    const activityBand = value => value
    const activeSelectionKey = () => String(state.placeId) + '|resident:'
    const window = { location: { origin: 'https://127.0.0.1' }, setTimeout, clearTimeout }
    const REQUEST_TIMEOUT_MS = 5000
    let rendered = null
    const renderSelectedPlaceDetail = () => { rendered = state.details['place:' + state.placeId] }
    const renderAll = renderSelectedPlaceDetail, renderDetail = () => {}
    const normalizeDetailRecord = (_kind, _id, payload) => payload.place
    ${loader}
    return { read: () => ensureDetail(true, 11, true), state: () => state, rendered: () => rendered,
      navigate: id => { detailRequestRevision += 1; state = { ...state, placeId: id }; renderAll() } }
  `)(() => new Promise(resolve => { complete = resolve }), record)
  const pending = harness.read()
  harness.navigate(12)
  harness.navigate(11)
  complete({ ok: true, status: 200, json: async () => {
    responseReads += 1
    return { place: { ...record, labels: [] } }
  } })
  await pending
  assert.equal(harness.state().details['place:11'].error, true, 'discarded read marks the cache unavailable')
  assert.equal(harness.rendered().error, true, 'visible facts must reflect unavailable cache after cancelled refresh')
  assert.equal(harness.rendered().loading, false, 'completed refresh must not leave checking status')
  assert.equal(harness.rendered().record, record, 'the original prose is retained')
  assert.equal(responseReads, 0, 'the stale response is never read or applied')
})

test('a focused read is overtaken when its reply is newer or the city view moved during the read', () => {
  // The live case: the first city view is an edge copy at 20 and the room read answers 21.
  assert.equal(focusedReadOvertaken({ requestMarker: '20', replyMarker: '21', viewMarker: '20' }), true)
  // A city refresh landed while the read was in flight.
  assert.equal(focusedReadOvertaken({ requestMarker: '20', replyMarker: '20', viewMarker: '21' }), true)
  assert.equal(focusedReadOvertaken({ requestMarker: '20', replyMarker: null, viewMarker: '21' }), true)
  // Markers compare as numbers, not text.
  assert.equal(focusedReadOvertaken({ requestMarker: '9', replyMarker: '10', viewMarker: '9' }), true)
  assert.equal(focusedReadOvertaken({
    requestMarker: '9223372036854775806',
    replyMarker: '9223372036854775807',
    viewMarker: '9223372036854775806',
  }), true)
  // Not overtaken: an exact reply, an older reply, no usable reply marker, or no marker asked.
  assert.equal(focusedReadOvertaken({ requestMarker: '20', replyMarker: '20', viewMarker: '20' }), false)
  assert.equal(focusedReadOvertaken({ requestMarker: '20', replyMarker: '19', viewMarker: '20' }), false)
  assert.equal(focusedReadOvertaken({ requestMarker: '20', replyMarker: null, viewMarker: '20' }), false)
  assert.equal(focusedReadOvertaken({ requestMarker: '20', replyMarker: '021', viewMarker: '20' }), false)
  assert.equal(focusedReadOvertaken({ requestMarker: null, replyMarker: '21', viewMarker: '20' }), false)
})

test('an overtaken read is read again only once the city view passes the marker it asked at', () => {
  assert.equal(overtakenReadIsDue({ entry: { loading: false, overtakenAt: '20' }, viewMarker: '21' }), true)
  assert.equal(overtakenReadIsDue({ entry: { loading: false, overtakenAt: '9' }, viewMarker: '10' }), true)
  assert.equal(overtakenReadIsDue({ entry: { loading: false, overtakenAt: '20' }, viewMarker: '20' }), false)
  assert.equal(overtakenReadIsDue({ entry: { loading: true, overtakenAt: '20' }, viewMarker: '21' }), false)
  assert.equal(overtakenReadIsDue({ entry: { loading: false, overtakenAt: null }, viewMarker: '21' }), false)
  assert.equal(overtakenReadIsDue({ entry: { loading: false }, viewMarker: '21' }), false)
  assert.equal(overtakenReadIsDue({ entry: undefined, viewMarker: '21' }), false)
  assert.equal(overtakenReadIsDue({ entry: null, viewMarker: '21' }), false)
  assert.equal(overtakenReadIsDue({ entry: { loading: false, overtakenAt: '20' }, viewMarker: null }), false)
})

test('the browser program carries both rules and the limit', () => {
  assert.equal(FOCUSED_READ_OVERTAKEN_LIMIT, 3)
  assert.ok(WINDOW_JS.includes('const focusedReadOvertaken = '), 'the overtaken rule is injected')
  assert.ok(WINDOW_JS.includes('const overtakenReadIsDue = '), 'the due rule is injected')
  assert.match(WINDOW_JS, /const FOCUSED_READ_OVERTAKEN_LIMIT = 3\n/u)
})

test('the browser program reads an overtaken place again and never leaves it loading with nothing in flight', () => {
  assert.match(WINDOW_JS, /focusedReadOvertaken\(\{\s*requestMarker, replyMarker, viewMarker: state\.changeMarker,\s*\}\)/u)
  assert.match(WINDOW_JS, /overtakenReads > 0 && overtakenReads <= FOCUSED_READ_OVERTAKEN_LIMIT/u)
  assert.match(WINDOW_JS, /error: !overtakenWaiting && !retainedCovers,/u)
  assert.match(WINDOW_JS, /if \(overtakenWaiting\) void ensureFocusedSelection\(\)/u)
  assert.equal(
    WINDOW_JS.match(/if \(!entry \|\| overtakenDue \|\| staleDue \|\| \(forcePlace && Boolean\(entry\.place\)\)\) \{/gu)?.length,
    2,
    'both focused place paths read a due overtaken place, or a stale held read, again',
  )
  assert.doesNotMatch(WINDOW_JS, /if \(!entry \|\| \(forcePlace && Boolean\(entry\.place\)\)\)/u)
  assert.match(WINDOW_JS, /refreshing: false \}\s+settleOvertakenFocusedPlaces\(\)/u)
  // Residents keep their own rule: every forced refresh reads a focused resident again.
  assert.match(WINDOW_JS, /if \(!entry \|\| forceResident \|\|\s+entry\.activitySelectionRevision !== publicActivitySelectionRevision\) \{/u)
})
