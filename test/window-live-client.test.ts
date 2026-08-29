import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as windowClientModule from '../src/window-client.ts'
import {
  normalizeWindowDrawing,
  windowLiveClampZoomScale,
  windowLivePlateChildren,
  windowLivePollDelay,
  windowLiveReplayDuration,
  windowLiveReplayOrder,
  windowLiveReplayPace,
  windowLiveReplayStartOffsets,
  windowLivePruneTrailStarts,
  windowLiveScatterSurfaceHeight,
  windowLiveSeparatedPoints,
  windowLiveScatteredPoint,
  windowLiveScatteredPoints,
  windowLiveSpeechLine,
  windowLiveTouchActivation,
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

type LiveViewportBounds = Readonly<{
  left: number
  top: number
  right: number
  bottom: number
}>

type LiveClientExports = Readonly<{
  windowDrawingStateLabel?: (
    state: 'undrawn' | 'refused' | 'in_progress' | 'complete',
    drawing: Readonly<{ palette: readonly string[]; indices: readonly (number | null)[] }> | null,
  ) => 'Undrawn' | 'Refused' | 'In progress' | 'Blank' | 'Complete'
  windowDrawingSourceLabel?: (source: Readonly<{
    source: 'none' | 'resident' | 'place' | 'thing' | 'kind_base' | 'kind_variant'
    kind_id?: number
    kind_name?: string
    revision?: number
    variant_name?: string
  }> | null) => string
  windowLiveCenterCamera?: (
    viewportWidth: number,
    viewportHeight: number,
    targetX: number,
    targetY: number,
    preferredScale: number,
    minimumScale: number,
    maximumScale: number,
  ) => Readonly<{ scale: number; offsetX: number; offsetY: number }> | null
  windowLiveDirectGroundWidth?: (
    stageWidth: number,
    readableWidth: number,
  ) => number
  windowLiveResidentLabelMode?: (
    scale: number,
    readableThreshold: number,
  ) => 'far' | 'readable'
  windowLiveSurveyedPlots?: (
    places: readonly SurveyedPlace[],
    parentId: number,
  ) => readonly SurveyedPlot[]
  windowLiveVisiblePlots?: (
    plots: readonly SurveyedPlot[],
    viewport: LiveViewportBounds,
    overscan: number,
  ) => readonly SurveyedPlot[]
  windowLiveCapacitySelection?: (
    rows: readonly CapacityRow[],
    capacity: number,
    pinnedIds: readonly number[],
    exactTotal?: number,
    preferredIds?: readonly number[],
  ) => Readonly<{
    visible: readonly CapacityRow[]
    overflowCount: number
  }>
  windowLiveSelectTrailKeys?: (
    keys: readonly string[],
    capacity: number,
    protectedKeys: readonly string[],
  ) => readonly string[]
}>

const liveClientExports = windowClientModule as unknown as LiveClientExports

test('drawing presentation labels all five owner-chosen states without inferring progress', () => {
  const stateLabel = liveClientExports.windowDrawingStateLabel
  assert.equal(typeof stateLabel, 'function')
  if (!stateLabel) return

  const blank = Object.freeze({
    palette: Object.freeze([]),
    indices: Object.freeze(Array(64).fill(null) as null[]),
  })
  const pixels = Object.freeze({
    palette: Object.freeze(['#102030']),
    indices: Object.freeze(Array.from({ length: 64 }, (_, index) => index === 0 ? 0 : null)),
  })

  assert.equal(stateLabel('undrawn', null), 'Undrawn')
  assert.equal(stateLabel('refused', null), 'Refused')
  assert.equal(stateLabel('in_progress', blank), 'In progress')
  assert.equal(stateLabel('in_progress', pixels), 'In progress')
  assert.equal(stateLabel('complete', blank), 'Blank')
  assert.equal(stateLabel('complete', pixels), 'Complete')
})

test('drawing provenance labels own work and the exact pinned kind source', () => {
  const sourceLabel = liveClientExports.windowDrawingSourceLabel
  assert.equal(typeof sourceLabel, 'function')
  if (!sourceLabel) return

  assert.equal(sourceLabel(null), '')
  assert.equal(sourceLabel(Object.freeze({ source: 'thing' })), 'Own drawing')
  assert.equal(sourceLabel(Object.freeze({
    source: 'kind_base', kind_id: 7, kind_name: 'lantern', revision: 3,
  })), 'Kind lantern · revision 3 · base')
  assert.equal(sourceLabel(Object.freeze({
    source: 'kind_variant', kind_id: 7, kind_name: 'lantern', revision: 3,
    variant_name: 'ember glow',
  })), 'Kind lantern · revision 3 · variant ember glow')
})

test('typed thing refusal projections clear a pinned variant before Live parses provenance', () => {
  const compact = (value: string) => value.replace(/\s+/gu, ' ')
  const drawingRoute = compact(readFileSync(
    new URL('../src/drawings.ts', import.meta.url),
    'utf8',
  ))
  const freshSchema = compact(readFileSync(
    new URL('../db/schema.sql', import.meta.url),
    'utf8',
  ))
  const migration = compact(readFileSync(
    new URL('../db/migrations/20260828_drawing_contract.sql', import.meta.url),
    'utf8',
  ))

  assert.match(
    windowClientModule.WINDOW_JS,
    /else if \(variantName\) return null/u,
    'Live must reject variant provenance outside an effective kind variant',
  )
  assert.match(
    drawingRoute,
    /CASE WHEN thing\.drawing_state = 'undrawn' AND selected\.variant IS NOT NULL AND coalesce\(kind_moderation\.action, 'restore'\) <> 'remove' THEN thing\.drawing_variant_name ELSE NULL END AS variant_name/u,
    'the HTTP drawing projection must emit a variant only for inherited kind-variant state',
  )
  for (const [label, sql] of [
    ['fresh schema', freshSchema],
    ['drawing-contract migration', migration],
  ] as const) {
    assert.match(
      sql,
      /CASE WHEN thing\.drawing_state = 'undrawn' AND selected_variant\.value IS NOT NULL AND coalesce\(thing_kind_hidden\.action, 'restore'\) <> 'remove' THEN thing\.drawing_variant_name ELSE NULL END AS variant_name/u,
      `${label} snapshot projection must emit a variant only for effective kind-variant state`,
    )
  }
})

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
    ...Array.from({ length: 9 }, (_, index) => Object.freeze({
      id: 40 + index,
      parent_id: 1,
      name: `new ground ${index + 1}`,
    })),
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
  assert.deepEqual(expanded.filter(plot => plot.id < 40), original)
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

  const distinctLefts = new Set(expanded.map(plot => plot.x))
  const distinctTops = new Set(expanded.map(plot => plot.y))
  assert.ok(distinctLefts.size > 4, 'the survey must not collapse into four rigid columns')
  assert.ok(distinctTops.size > 4, 'the survey must use naturally varied vertical positions')
})

test('direct residents and things receive stable scattered points across the available room', () => {
  const first = windowLiveScatteredPoints(18, 1_100, 680, 73, 56)
  const repeated = windowLiveScatteredPoints(18, 1_100, 680, 73, 56)
  const appended = windowLiveScatteredPoints(24, 1_100, 680, 73, 56)

  assert.deepEqual(repeated, first)
  assert.deepEqual(appended.slice(0, first.length), first)
  assert.ok(new Set(first.map(point => point.x)).size > 8)
  assert.ok(new Set(first.map(point => point.y)).size > 8)
  for (const point of first) {
    assert.ok(point.x >= 56 && point.x <= 1_100 - 56)
    assert.ok(point.y >= 56 && point.y <= 680 - 56)
  }
})

test('direct residents and things stay on readable ground when the surveyed stage grows', () => {
  const directGroundWidth = liveClientExports.windowLiveDirectGroundWidth
  assert.equal(typeof directGroundWidth, 'function')
  if (!directGroundWidth) return

  assert.equal(directGroundWidth(720, 1_100), 720)
  assert.equal(directGroundWidth(1_100, 1_100), 1_100)
  assert.equal(directGroundWidth(20_000, 1_100), 1_100)
  assert.equal(directGroundWidth(Number.NaN, 1_100), 0)
  assert.equal(directGroundWidth(20_000, -1), 0)

  const stageWidth = 20_000
  const groundWidth = directGroundWidth(stageWidth, 1_100)
  const residentPoints = windowLiveSeparatedPoints(
    Array.from({ length: 18 }, (_, index) => index + 1),
    groundWidth,
    680,
    73,
    50,
    50,
    12,
    1,
  )
  const thingPoints = windowLiveSeparatedPoints(
    Array.from({ length: 10 }, (_, index) => index + 1),
    groundWidth,
    680,
    97,
    94,
    32,
    12,
    0.5,
  )

  assert.equal(Object.keys(residentPoints).length, 18)
  assert.equal(Object.keys(thingPoints).length, 10)
  assert.ok(Math.max(...Object.values(residentPoints).map(point => point.x)) < 1_100)
  assert.ok(Math.max(...Object.values(thingPoints).map(point => point.x)) < 1_100)
})

test('a resident or thing keeps the same point when the visible set changes', () => {
  const original = windowLiveScatteredPoint(21, 220, 148, 73, 26)
  const repeated = windowLiveScatteredPoint(21, 220, 148, 73, 26)
  const neighbour = windowLiveScatteredPoint(22, 220, 148, 73, 26)

  assert.deepEqual(repeated, original)
  assert.notDeepEqual(neighbour, original)
  assert.ok(original.x >= 26 && original.x <= 220 - 26)
  assert.ok(original.y >= 26 && original.y <= 148 - 26)
})

test('crowded residents keep append-stable separated points away from control ground', () => {
  const reserved = Object.freeze([
    Object.freeze({ x: 116, y: 104, width: 104, height: 44 }),
  ])
  const first = windowLiveSeparatedPoints(
    Object.freeze([21, 22, 23, 24]),
    220,
    148,
    73,
    40,
    40,
    8,
    1,
    reserved,
  )
  const appended = windowLiveSeparatedPoints(
    Object.freeze([5, 20, 21, 22, 23, 24]),
    220,
    148,
    73,
    40,
    40,
    8,
    1,
    reserved,
    first,
  )
  const rectangle = (point: Readonly<{ x: number; y: number }>) => ({
    left: point.x - 20,
    right: point.x + 20,
    top: point.y - 40,
    bottom: point.y,
  })

  for (const id of [21, 22, 23, 24]) {
    assert.deepEqual(appended[String(id)], first[String(id)])
  }
  const rectangles = Object.values(appended).map(rectangle)
  for (const [index, left] of rectangles.entries()) {
    for (const right of rectangles.slice(index + 1)) {
      assert.equal(
        left.left < right.right && left.right > right.left &&
          left.top < right.bottom && left.bottom > right.top,
        false,
      )
    }
    assert.equal(
      left.left < 220 && left.right > 116 && left.top < 148 && left.bottom > 104,
      false,
    )
  }
})

test('crowded things use the whole plot without covering Show more', () => {
  const reserved = Object.freeze([
    Object.freeze({ x: 116, y: 104, width: 104, height: 44 }),
  ])
  const points = windowLiveSeparatedPoints(
    Object.freeze([20, 21, 22, 23, 24]),
    220,
    148,
    97,
    94,
    32,
    6,
    0.5,
    reserved,
  )
  const rectangles = Object.values(points).map(point => ({
    left: point.x - 47,
    right: point.x + 47,
    top: point.y - 16,
    bottom: point.y + 16,
  }))

  assert.equal(rectangles.length, 5)
  for (const [index, left] of rectangles.entries()) {
    for (const right of rectangles.slice(index + 1)) {
      assert.equal(
        left.left < right.right && left.right > right.left &&
          left.top < right.bottom && left.bottom > right.top,
        false,
      )
    }
    assert.equal(
      left.left < 220 && left.right > 116 && left.top < 148 && left.bottom > 104,
      false,
    )
  }
})

test('expanded root crowds reserve enough new ground for every loaded item', () => {
  const residentHeight = windowLiveScatterSurfaceHeight(680, 1_100, 1_600, 50, 50, 12)
  const thingHeight = windowLiveScatterSurfaceHeight(680, 1_100, 400, 144, 48, 12, true)

  assert.ok(residentHeight > 680)
  assert.ok(thingHeight > 680)
  assert.equal(Object.keys(windowLiveSeparatedPoints(
    Array.from({ length: 1_600 }, (_, index) => index + 1),
    1_100,
    residentHeight,
    20,
    50,
    50,
    12,
    1,
    [{ x: 0, y: 0, width: 1_100, height: 680 }],
  )).length, 1_600)
  assert.equal(Object.keys(windowLiveSeparatedPoints(
    Array.from({ length: 400 }, (_, index) => index + 1),
    1_100,
    thingHeight,
    40,
    144,
    48,
    12,
    0.5,
    [
      { x: 0, y: 0, width: 1_100, height: 680 },
      { x: 1_100 - 116, y: thingHeight - 52, width: 116, height: 52 },
    ],
  )).length, 400)
})

test('touch activation brings a covered item forward before a second tap opens it', () => {
  assert.equal(windowLiveTouchActivation('mouse', null, 'resident:7'), 'open')
  assert.equal(windowLiveTouchActivation('pen', null, 'resident:7'), 'open')
  assert.equal(windowLiveTouchActivation('touch', null, 'resident:7'), 'bring-forward')
  assert.equal(windowLiveTouchActivation('touch', 'resident:7', 'resident:7'), 'open')
  assert.equal(windowLiveTouchActivation('touch', 'thing:9', 'resident:7'), 'bring-forward')
})

test('live plot detail stays camera-bounded while distant plots remain marker candidates', () => {
  const visiblePlots = liveClientExports.windowLiveVisiblePlots
  assert.equal(typeof visiblePlots, 'function')
  if (!visiblePlots) return

  const plots = Object.freeze([
    Object.freeze({ id: 1, x: -30, y: 20, width: 15, height: 15 }),
    Object.freeze({ id: 2, x: 10, y: 10, width: 20, height: 20 }),
    Object.freeze({ id: 3, x: 106, y: 25, width: 20, height: 20 }),
    Object.freeze({ id: 4, x: 130, y: 25, width: 20, height: 20 }),
    Object.freeze({ id: 5, x: 20, y: 108, width: 20, height: 20 }),
  ])
  const viewport = Object.freeze({ left: 0, top: 0, right: 100, bottom: 100 })

  const detailed = visiblePlots(plots, viewport, 12)
  const legacySurveyAttempt = (visiblePlots as unknown as (
    candidates: readonly SurveyedPlot[],
    bounds: LiveViewportBounds,
    overscan: number,
    includeAll: boolean,
  ) => readonly SurveyedPlot[])(plots, viewport, 12, true)
  const detailedIds = new Set(detailed.map(plot => plot.id))
  const markerIds = plots.filter(plot => !detailedIds.has(plot.id)).map(plot => plot.id)

  assert.deepEqual(detailed.map(plot => plot.id), [2, 3, 5])
  assert.deepEqual(markerIds, [1, 4])
  assert.deepEqual(legacySurveyAttempt, detailed, 'no camera mode may draw every detailed plot')
  assert.deepEqual(plots.map(plot => plot.id), [1, 2, 3, 4, 5])
})

test('Live uses the locked empty-room sentence on every empty-room surface', () => {
  const lockedCopy = 'Nobody is here right now. The room keeps its things.'
  const occurrences = windowClientModule.WINDOW_JS.split(lockedCopy).length - 1

  assert.equal(occurrences, 2)
  assert.doesNotMatch(
    windowClientModule.WINDOW_JS,
    /Nobody is here right now\. The fixed ground stays ready\./u,
  )
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

test('Center keeps a readable scale around its target without fitting the whole survey', () => {
  const centerCamera = liveClientExports.windowLiveCenterCamera
  assert.equal(typeof centerCamera, 'function')
  if (!centerCamera) return

  assert.deepEqual(
    centerCamera(320, 352, 19_000, 12_000, 1, 0.8, 2.2),
    Object.freeze({ scale: 1, offsetX: -18_840, offsetY: -11_824 }),
  )
  assert.deepEqual(
    centerCamera(320, 352, 550, 340, 0.01, 0.8, 2.2),
    Object.freeze({ scale: 0.8, offsetX: -280, offsetY: -96 }),
  )
  assert.equal(centerCamera(0, 352, 550, 340, 1, 0.8, 2.2), null)
  assert.equal(centerCamera(320, 352, Number.NaN, 340, 1, 0.8, 2.2), null)
})

test('zoom has a fixed readable floor independent of surveyed stage bounds', () => {
  assert.equal(windowLiveClampZoomScale(0.01, 0.8, 2.2), 0.8)
  assert.equal(windowLiveClampZoomScale(0.8, 0.8, 2.2), 0.8)
  assert.equal(windowLiveClampZoomScale(1.4, 0.8, 2.2), 1.4)
  assert.equal(windowLiveClampZoomScale(9, 0.8, 2.2), 2.2)
  assert.equal(windowLiveClampZoomScale(Number.NaN, 0.8, 2.2), 0.8)
})

test('resident label mode changes only at the readable zoom threshold and fails closed', () => {
  const labelMode = liveClientExports.windowLiveResidentLabelMode
  assert.equal(typeof labelMode, 'function')
  if (!labelMode) return

  const readableThreshold = 1.6
  assert.equal(labelMode(readableThreshold - Number.EPSILON, readableThreshold), 'far')
  assert.equal(labelMode(readableThreshold, readableThreshold), 'readable')
  assert.equal(labelMode(2.2, readableThreshold), 'readable')

  for (const invalidScale of [Number.NaN, Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY, 0, -0.01]) {
    assert.equal(labelMode(invalidScale, readableThreshold), 'far')
  }
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

test('trail selection stays hard-capped and keeps active keys ahead of older ink', () => {
  const selectTrailKeys = liveClientExports.windowLiveSelectTrailKeys
  assert.equal(typeof selectTrailKeys, 'function')
  if (!selectTrailKeys) return

  const keys = Object.freeze([
    'change:120',
    'change:119',
    'change:118',
    'change:5',
    'change:4',
  ])
  const protectedKeys = Object.freeze(['change:5'])
  const selected = selectTrailKeys(keys, 3, protectedKeys)

  assert.deepEqual(selected, ['change:120', 'change:119', 'change:5'])
  assert.equal(selected.length, 3)
  assert.ok(selected.includes('change:5'))
  assert.equal(Object.isFrozen(selected), true)
  assert.deepEqual(keys, ['change:120', 'change:119', 'change:118', 'change:5', 'change:4'])
  assert.deepEqual(protectedKeys, ['change:5'])
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

test('replay pacing spreads normal activity and catches busy scenes up before the next read', () => {
  const normal = windowLiveReplayPace(4, 24_000)
  const busy = windowLiveReplayPace(40, 24_000)

  assert.ok(normal.startGapMs >= 1_000)
  assert.ok(normal.actionDurationMs >= 600)
  assert.ok(busy.startGapMs < normal.startGapMs)
  assert.ok(busy.actionDurationMs < normal.actionDurationMs)
  assert.ok(busy.startGapMs * 39 + busy.actionDurationMs <= 24_000)
  assert.deepEqual(windowLiveReplayPace(0, 24_000), {
    startGapMs: 0,
    actionDurationMs: 0,
  })
})

test('replay start offsets keep recorded-together actors together and spread later groups', () => {
  const at = new Date('2026-08-28T12:00:00.000Z')
  const later = new Date('2026-08-28T12:00:02.000Z')
  const offsets = windowLiveReplayStartOffsets([
    { actor: 'first', at },
    { actor: 'second', at },
    { actor: 'first', at: later },
    { actor: 'third', at: later },
  ], 25_000)
  const third = offsets.third ?? -1

  assert.equal(offsets.first, 0)
  assert.equal(offsets.second, 0)
  assert.ok(third >= 1_000)
  assert.ok(third < 25_000)
  assert.deepEqual(windowLiveReplayStartOffsets([], 25_000), {})
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

test('capacity can preserve preferred visible IDs without mutating either page', () => {
  const selectCapacity = liveClientExports.windowLiveCapacitySelection
  assert.equal(typeof selectCapacity, 'function')
  if (!selectCapacity) return

  const first = Object.freeze([
    Object.freeze({ id: 7, label: 'seven' }),
    Object.freeze({ id: 3, label: 'three' }),
    Object.freeze({ id: 11, label: 'eleven' }),
  ])
  const appended = Object.freeze([
    Object.freeze({ id: 19, label: 'nineteen' }),
    ...first,
  ])

  const initial = selectCapacity(first, 2, Object.freeze([]))
  const next = selectCapacity(
    appended,
    2,
    Object.freeze([]),
    appended.length,
    Object.freeze(initial.visible.map(row => row.id)),
  )

  assert.deepEqual(initial.visible.map(row => row.id), [7, 3])
  assert.deepEqual(next.visible.map(row => row.id), [7, 3])
  assert.equal(next.overflowCount, 2)
  assert.deepEqual(first.map(row => row.id), [7, 3, 11])
  assert.deepEqual(appended.map(row => row.id), [19, 7, 3, 11])
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
