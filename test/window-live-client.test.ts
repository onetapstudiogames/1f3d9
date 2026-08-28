import test from 'node:test'
import assert from 'node:assert/strict'
import * as windowClientModule from '../src/window-client.ts'
import {
  normalizeWindowDrawing,
  windowLiveClampZoomScale,
  windowLiveFitScale,
  windowLivePlateChildren,
  windowLivePollDelay,
  windowLiveReplayDuration,
  windowLiveReplayOrder,
  windowLivePruneTrailStarts,
  windowLiveSpeechLine,
  windowLiveTraceOpacity,
} from '../src/window-client.ts'

type SurveyedPlace = Readonly<{
  id: number
  parent_id: number | null
  name: string
}>

type SurveyedPlot = Readonly<{
  id: number
  x: number
  y: number
  width: number
  height: number
}>

type CapacityRow = Readonly<{
  id: number
  label: string
}>

type LiveClientExports = Readonly<{
  windowLiveSurveyedPlots?: (
    places: readonly SurveyedPlace[],
    parentId: number,
  ) => readonly SurveyedPlot[]
  windowLiveCapacitySelection?: (
    rows: readonly CapacityRow[],
    capacity: number,
    pinnedIds: readonly number[],
    exactTotal?: number,
  ) => Readonly<{
    visible: readonly CapacityRow[]
    overflowCount: number
  }>
}>

const liveClientExports = windowClientModule as unknown as LiveClientExports

test('drawing normalization preserves exact colours and distinguishes blank from undrawn', () => {
  const drawing = normalizeWindowDrawing({
    palette: ['#102030', '#102031'],
    indices: Array.from({ length: 64 }, (_, index) => index % 3 === 0 ? null : index % 2),
  })
  assert.deepEqual(drawing?.palette, ['#102030', '#102031'])
  assert.equal(drawing?.indices.length, 64)
  assert.equal(normalizeWindowDrawing(null), null)

  const blank = normalizeWindowDrawing({ palette: [], indices: Array(64).fill(null) })
  assert.ok(blank)
  assert.ok(blank.indices.every(index => index === null))
})

test('drawing normalization refuses unsafe colours, bad square counts, and missing palette entries', () => {
  assert.equal(normalizeWindowDrawing({ palette: ['red'], indices: Array(64).fill(0) }), null)
  assert.equal(normalizeWindowDrawing({ palette: ['#123456;display:none'], indices: Array(64).fill(0) }), null)
  assert.equal(normalizeWindowDrawing({ palette: ['#123456'], indices: Array(63).fill(0) }), null)
  assert.equal(normalizeWindowDrawing({ palette: ['#123456'], indices: Array(64).fill(1) }), null)
  assert.equal(normalizeWindowDrawing({ palette: Array(65).fill('#123456'), indices: Array(64).fill(0) }), null)
})

test('live plate placement is stable by public id and never mutates the directory', () => {
  const directory = Object.freeze([
    Object.freeze({ id: 9, parent_id: 1, name: 'later' }),
    Object.freeze({ id: 4, parent_id: 1, name: 'first' }),
    Object.freeze({ id: 7, parent_id: 4, name: 'inside' }),
  ])
  assert.deepEqual(windowLivePlateChildren(directory, 1).map(place => place.id), [4, 9])
  assert.deepEqual(directory.map(place => place.id), [9, 4, 7])
})

test('surveyed plots keep every existing rectangle when later-created places take new ground', () => {
  const surveyedPlots = liveClientExports.windowLiveSurveyedPlots
  assert.equal(typeof surveyedPlots, 'function')
  if (!surveyedPlots) return

  const places = Object.freeze([
    Object.freeze({ id: 21, parent_id: 1, name: 'third plot' }),
    Object.freeze({ id: 4, parent_id: 1, name: 'first plot' }),
    Object.freeze({ id: 9, parent_id: 1, name: 'second plot' }),
    Object.freeze({ id: 7, parent_id: 4, name: 'inside first plot' }),
  ])
  const appended = Object.freeze([
    ...places,
    Object.freeze({ id: 40, parent_id: 1, name: 'new ground' }),
  ])
  const normalize = (plots: readonly SurveyedPlot[]) => [...plots]
    .sort((left, right) => left.id - right.id)
    .map(plot => ({
      id: plot.id,
      x: plot.x,
      y: plot.y,
      width: plot.width,
      height: plot.height,
    }))

  const original = normalize(surveyedPlots(places, 1))
  const reordered = normalize(surveyedPlots(Object.freeze([...places].reverse()), 1))
  const expanded = normalize(surveyedPlots(appended, 1))
  assert.deepEqual(original.map(plot => plot.id), [4, 9, 21])
  assert.deepEqual(reordered, original)
  assert.deepEqual(expanded.filter(plot => plot.id !== 40), original)
  assert.deepEqual(places.map(place => place.id), [21, 4, 9, 7])

  for (const plot of expanded) {
    assert.ok(Number.isFinite(plot.x) && Number.isFinite(plot.y))
    assert.ok(Number.isFinite(plot.width) && plot.width > 0)
    assert.ok(Number.isFinite(plot.height) && plot.height > 0)
  }
  for (const [index, left] of expanded.entries()) {
    for (const right of expanded.slice(index + 1)) {
      const overlaps = left.x < right.x + right.width &&
        left.x + left.width > right.x &&
        left.y < right.y + right.height &&
        left.y + left.height > right.y
      assert.equal(overlaps, false, `plots ${left.id} and ${right.id} overlap`)
    }
  }
})

test('live polling follows activity and backs off through quiet without exceeding five minutes', () => {
  assert.equal(windowLivePollDelay(true, 99), 25_000)
  assert.equal(windowLivePollDelay(false, 0), 60_000)
  assert.equal(windowLivePollDelay(false, 1), 120_000)
  assert.equal(windowLivePollDelay(false, 2), 240_000)
  assert.equal(windowLivePollDelay(false, 3), 300_000)
  assert.equal(windowLivePollDelay(false, 20), 300_000)
})

test('trace opacity ages honestly and expires at its stated lifetime', () => {
  assert.equal(windowLiveTraceOpacity(1_000, 1_000, 10_000), 1)
  assert.equal(windowLiveTraceOpacity(1_000, 6_000, 10_000), 0.5)
  assert.equal(windowLiveTraceOpacity(1_000, 11_000, 10_000), 0)
  assert.equal(windowLiveTraceOpacity(2_000, 1_000, 10_000), 1)
})

test('dynamic Fit scale follows the whole unbounded survey', () => {
  const hugeSurvey = windowLiveFitScale(320, 352, 1_100, 20_000, 2.2)
  assert.equal(hugeSurvey, 328 / 20_000)
  assert.ok(hugeSurvey! < 0.05)
  assert.equal(
    windowLiveFitScale(1_200, 800, 1_100, 680, 2.2),
    Math.min(2.2, 1_176 / 1_100, 776 / 680),
  )
  assert.equal(windowLiveFitScale(320, 352, 0, 20_000, 2.2), null)
})

test('zoom-out never raises the camera above its current or full-survey floor', () => {
  assert.equal(windowLiveClampZoomScale(0.01, 0.0164, 0.0164, 2.2), 0.0164)
  assert.equal(windowLiveClampZoomScale(0.004, 0.005, 0.02, 2.2), 0.005)
  assert.equal(windowLiveClampZoomScale(0.5, 0.25, 0.1, 2.2), 0.5)
  assert.equal(windowLiveClampZoomScale(9, 1, 0.1, 2.2), 2.2)
})

test('expired trail starts are pruned without mutation', () => {
  const expired = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [
    `expired:${index}`, index,
  ]))
  const starts = Object.freeze({ ...expired, edge: 5_500, fresh: 5_501, active: 0 })
  const pruned = windowLivePruneTrailStarts(starts, 10_000, 4_500, ['active'])

  assert.deepEqual(pruned, { fresh: 5_501, active: 0 })
  assert.equal(Object.keys(starts).length, 1_003)
  assert.equal(Object.isFrozen(pruned), true)
  assert.equal(windowLivePruneTrailStarts(pruned, 10_000, 4_500, ['active']), pruned)
})

test('recorded movement is visibly slower than the mockup and still scales with distance', () => {
  const shortest = windowLiveReplayDuration(0)
  const middle = windowLiveReplayDuration(50)
  const longest = windowLiveReplayDuration(10_000)

  assert.ok(shortest >= 3_200)
  assert.ok(middle > shortest)
  assert.ok(longest > middle)
  assert.ok(longest <= 8_000)
  assert.equal(windowLiveReplayDuration(Number.NaN), shortest)
  assert.equal(windowLiveReplayDuration(50, shortest - 1), 0)
  assert.equal(windowLiveReplayDuration(50, middle + 1_000), middle)
})

test('resident capacity reserves the focused resident and interaction partner with an exact count', () => {
  const selectCapacity = liveClientExports.windowLiveCapacitySelection
  assert.equal(typeof selectCapacity, 'function')
  if (!selectCapacity) return

  const residents = Object.freeze([
    Object.freeze({ id: 1, label: 'first resident' }),
    Object.freeze({ id: 2, label: 'second resident' }),
    Object.freeze({ id: 3, label: 'third resident' }),
    Object.freeze({ id: 7, label: 'interaction partner' }),
    Object.freeze({ id: 8, label: 'focused resident' }),
  ])
  const selection = selectCapacity(residents, 3, Object.freeze([8, 7, 8, 999]))

  assert.deepEqual(selection.visible.map(row => row.id).sort((a, b) => a - b), [1, 7, 8])
  assert.equal(selection.overflowCount, 2)
  assert.deepEqual(residents.map(row => row.id), [1, 2, 3, 7, 8])
})

test('capacity remains physically bounded when focus has more pins than slots', () => {
  const selectCapacity = liveClientExports.windowLiveCapacitySelection
  assert.equal(typeof selectCapacity, 'function')
  if (!selectCapacity) return

  const rows = Object.freeze([1, 2, 3, 4].map(id => Object.freeze({ id, label: String(id) })))
  const selection = selectCapacity(rows, 2, Object.freeze([4, 3, 2]))

  assert.deepEqual(selection.visible.map(row => row.id), [3, 4])
  assert.equal(selection.overflowCount, 2)
})

test('thing capacity reserves the focused interaction thing with an exact count', () => {
  const selectCapacity = liveClientExports.windowLiveCapacitySelection
  assert.equal(typeof selectCapacity, 'function')
  if (!selectCapacity) return

  const things = Object.freeze([
    Object.freeze({ id: 10, label: 'first thing' }),
    Object.freeze({ id: 11, label: 'second thing' }),
    Object.freeze({ id: 12, label: 'third thing' }),
    Object.freeze({ id: 13, label: 'fourth thing' }),
    Object.freeze({ id: 14, label: 'interacted thing' }),
  ])
  const selection = selectCapacity(things, 2, Object.freeze([14]))

  assert.deepEqual(selection.visible.map(row => row.id).sort((a, b) => a - b), [10, 14])
  assert.equal(selection.overflowCount, 3)
  assert.deepEqual(things.map(row => row.id), [10, 11, 12, 13, 14])
})

test('thing capacity counts unloaded survey rows without inventing specimens', () => {
  const selectCapacity = liveClientExports.windowLiveCapacitySelection
  assert.equal(typeof selectCapacity, 'function')
  if (!selectCapacity) return

  const loaded = Object.freeze([
    Object.freeze({ id: 20, label: 'loaded twenty' }),
    Object.freeze({ id: 21, label: 'loaded twenty-one' }),
  ])
  const selection = selectCapacity(loaded, 5, Object.freeze([]), 8)

  assert.deepEqual(selection.visible.map(row => row.id), [20, 21])
  assert.equal(selection.overflowCount, 6)
  assert.deepEqual(loaded.map(row => row.id), [20, 21])
})

test('capacity stays bounded when focus pins exceed the ordinary slot count', () => {
  const selectCapacity = liveClientExports.windowLiveCapacitySelection
  assert.equal(typeof selectCapacity, 'function')
  if (!selectCapacity) return

  const rows = Object.freeze([
    Object.freeze({ id: 1, label: 'ordinary row' }),
    Object.freeze({ id: 2, label: 'first pin' }),
    Object.freeze({ id: 3, label: 'second pin' }),
    Object.freeze({ id: 4, label: 'third pin' }),
  ])
  const overPinned = selectCapacity(rows, 2, Object.freeze([4, 3, 2]))
  const noSlots = selectCapacity(rows, 0, Object.freeze([]))

  assert.deepEqual(overPinned.visible.map(row => row.id), [3, 4])
  assert.equal(overPinned.overflowCount, 2)
  assert.deepEqual(noSlots.visible, [])
  assert.equal(noSlots.overflowCount, 4)
})

test('replay keeps recorded order and refuses records beyond the trace edge', () => {
  const records = Object.freeze([
    Object.freeze({ change_id: '13', at: new Date(13_000), label: 'use' }),
    Object.freeze({ change_id: '11', at: new Date(11_000), label: 'move' }),
    Object.freeze({ change_id: '12', at: new Date(12_000), label: 'note' }),
    Object.freeze({ change_id: '10', at: new Date(9_999), label: 'outside' }),
  ])

  assert.deepEqual(
    windowLiveReplayOrder(records, 10_000).map(record => record.label),
    ['move', 'note', 'use'],
  )
  assert.deepEqual(records.map(record => record.label), ['use', 'move', 'note', 'outside'])

  const openingRows = Object.freeze([
    Object.freeze({ id: 103, at: new Date(12_000), label: 'later event id' }),
    Object.freeze({ id: 101, at: new Date(12_000), label: 'earlier event id' }),
  ])
  assert.deepEqual(
    windowLiveReplayOrder(openingRows, 10_000).map(record => record.label),
    ['earlier event id', 'later event id'],
  )

  const mixedRows = Object.freeze([
    Object.freeze({ change_id: '12', at: new Date(10_500), label: 'second change' }),
    Object.freeze({ id: 102, at: new Date(12_000), label: 'second opening event' }),
    Object.freeze({ change_id: '11', at: new Date(13_000), label: 'first change' }),
    Object.freeze({ id: 101, at: new Date(11_000), label: 'first opening event' }),
  ])
  const expected = ['first opening event', 'second opening event', 'first change', 'second change']
  for (const permutation of [mixedRows, [...mixedRows].reverse(), [
    mixedRows[1]!, mixedRows[3]!, mixedRows[0]!, mixedRows[2]!,
  ]]) {
    assert.deepEqual(windowLiveReplayOrder(permutation, 10_000).map(record => record.label), expected)
  }
})

test('speech bubbles keep only the first line and use an honest 60-character ellipsis cap', () => {
  assert.equal(windowLiveSpeechLine('first line\nsecond line'), 'first line')
  assert.equal(windowLiveSpeechLine('first line\r\nsecond line'), 'first line')
  assert.equal(windowLiveSpeechLine('short line'), 'short line')

  const exactLine = 'x'.repeat(60)
  assert.equal(windowLiveSpeechLine(exactLine), exactLine)
  assert.equal(windowLiveSpeechLine(exactLine + 'x'), 'x'.repeat(59) + '…')

  const longLine = '🙂'.repeat(60) + 'tail that is not shown'
  const bubble = windowLiveSpeechLine(longLine)
  assert.equal(Array.from(bubble).length, 60)
  assert.equal(bubble, '🙂'.repeat(59) + '…')
})
