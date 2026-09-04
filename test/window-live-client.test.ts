import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as windowClientModule from '../src/window-client.ts'
import {
  WINDOW_LIVE_PLOT_DRAWING_DETAIL_RECT,
  normalizeWindowDrawing,
  windowLiveClampZoomScale,
  windowLiveExpandedGroundLayout,
  windowLiveFloorAccessibleLabel,
  windowLiveFloorTiling,
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
  windowLiveSurveyedPlots,
  windowLiveSpeechLine,
  windowLiveTouchActivation,
  windowLiveTraceOpacity,
  windowLiveItemFacts,
  windowLiveItemLastAction,
  windowLiveItemPopoverPlacement,
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

type LivePointMap = Readonly<Record<string, Readonly<{ x: number; y: number }>>>

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
  windowLiveRevealCamera?: (
    viewportWidth: number,
    viewportHeight: number,
    targetX: number,
    targetY: number,
    targetWidth: number,
    targetHeight: number,
    scale: number,
    offsetX: number,
    offsetY: number,
    safeInset: number,
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
  windowLiveVisiblePlotIds?: (
    plots: readonly SurveyedPlot[],
    expandedGrounds: Readonly<Record<string, Readonly<{
      x: number
      residentTop: number | null
      thingTop: number | null
      width: number
      bottom: number
    }>>>,
    viewport: LiveViewportBounds,
    overscan: number,
    controlRailDepth?: number,
  ) => readonly number[]
  windowLiveThingPointsAroundResidents?: (
    keys: readonly number[],
    width: number,
    height: number,
    seed: number,
    itemWidth: number,
    itemHeight: number,
    margin: number,
    residentPoints: Readonly<Record<string, Readonly<{ x: number; y: number }>>>,
    reserved?: readonly Readonly<{ x: number; y: number; width: number; height: number }>[],
    previous?: Readonly<Record<string, Readonly<{ x: number; y: number }>>>,
    sharesResidentSurface?: boolean,
  ) => Readonly<Record<string, Readonly<{ x: number; y: number }>>>
  windowLiveResidentPointsAroundThings?: (
    keys: readonly number[],
    width: number,
    height: number,
    seed: number,
    itemWidth: number,
    itemHeight: number,
    margin: number,
    thingPoints: Readonly<Record<string, Readonly<{ x: number; y: number }>>>,
    thingItemWidth: number,
    reserved?: readonly Readonly<{ x: number; y: number; width: number; height: number }>[],
    previous?: Readonly<Record<string, Readonly<{ x: number; y: number }>>>,
    sharesThingSurface?: boolean,
  ) => Readonly<Record<string, Readonly<{ x: number; y: number }>>>
  windowLiveRootReservations?: (
    width: number,
    height: number,
  ) => readonly Readonly<{ x: number; y: number; width: number; height: number }>[]
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

test('spatial arbitration stays stable when focus changes pinned input order', () => {
  const original = windowLiveSeparatedPoints(
    Object.freeze([21, 22, 23, 24, 25, 26]),
    440,
    280,
    73,
    56,
    56,
    6,
    1,
  )
  const focusReordered = windowLiveSeparatedPoints(
    Object.freeze([25, 23, 21, 22, 24, 26]),
    440,
    280,
    73,
    56,
    56,
    6,
    1,
  )

  assert.deepEqual(focusReordered, original)
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

test('ordinary child ground keeps 6 residents and 6 things naturally scattered for 100 seeds', () => {
  const thingPointsAroundResidents = liveClientExports.windowLiveThingPointsAroundResidents
  assert.equal(typeof thingPointsAroundResidents, 'function')
  if (!thingPointsAroundResidents) return
  const [plot] = windowLiveSurveyedPlots([
    Object.freeze({ id: 1, parent_id: null }),
    Object.freeze({ id: 2, parent_id: 1 }),
  ], 1)
  assert.ok(plot)
  if (!plot) return
  assert.deepEqual({ width: plot.width, height: plot.height }, { width: 440, height: 280 })
  assert.ok(WINDOW_LIVE_PLOT_DRAWING_DETAIL_RECT.y >= plot.height + 6)

  const overlaps = (
    left: Readonly<{ x: number; y: number; width: number; height: number }>,
    right: Readonly<{ x: number; y: number; width: number; height: number }>,
  ) => left.x < right.x + right.width + 6 && left.x + left.width + 6 > right.x &&
    left.y < right.y + right.height + 6 && left.y + left.height + 6 > right.y

  for (let placeId = 2; placeId < 102; placeId += 1) {
    const residentIds = Object.freeze(Array.from({ length: 6 }, (_, index) => 20 + index))
    const thingIds = Object.freeze(Array.from({ length: 6 }, (_, index) => 90 + index))
    const residents = windowLiveSeparatedPoints(
      residentIds,
      plot.width,
      plot.height,
      placeId * 17 + 3,
      56,
      56,
      6,
      1,
    )
    const things: Readonly<Record<string, Readonly<{ x: number; y: number }>>> =
      thingPointsAroundResidents(
        thingIds,
        plot.width,
        plot.height,
        placeId * 29 + 11,
        94,
        56,
        6,
        residents,
      )
    assert.equal(Object.keys(residents).length, 6, `resident seed ${placeId}`)
    assert.equal(Object.keys(things).length, 6, `thing seed ${placeId}`)
    assert.deepEqual(windowLiveSeparatedPoints(
      residentIds,
      plot.width,
      plot.height,
      placeId * 17 + 3,
      56,
      56,
      6,
      1,
      [],
      residents,
    ), residents)

    const rectangles = [
      ...Object.values(residents).map(point => ({
        x: point.x - 28, y: point.y - 56, width: 56, height: 56,
      })),
      ...Object.values(things).map(point => ({
        x: point.x - 47, y: point.y - 28, width: 94, height: 56,
      })),
    ]
    for (const [index, left] of rectangles.entries()) {
      for (const right of rectangles.slice(index + 1)) assert.equal(overlaps(left, right), false)
    }
    const allPoints = [...Object.values(residents), ...Object.values(things)]
    assert.ok(new Set(allPoints.map(point => Math.round(point.x))).size >= 8)
    assert.ok(new Set(allPoints.map(point => Math.round(point.y))).size >= 8)
  }
})

test('direct root ground uses the production combined resident and thing placement', () => {
  const thingPointsAroundResidents = liveClientExports.windowLiveThingPointsAroundResidents
  assert.equal(typeof thingPointsAroundResidents, 'function')
  if (!thingPointsAroundResidents) return

  const residents = windowLiveSeparatedPoints(
    Object.freeze([20, 21, 22, 23, 24, 25]),
    1_100,
    680,
    20,
    56,
    56,
    12,
    1,
  )
  const things: Readonly<Record<string, Readonly<{ x: number; y: number }>>> =
    thingPointsAroundResidents(
      Object.freeze([90, 91, 92, 93, 94, 95]),
      1_100,
      680,
      40,
      144,
      56,
      12,
      residents,
    )
  assert.equal(Object.keys(residents).length, 6)
  assert.equal(Object.keys(things).length, 6)

  for (const resident of Object.values(residents)) {
    const residentRect = { x: resident.x - 28, y: resident.y - 56, width: 56, height: 56 }
    for (const thing of Object.values(things)) {
      const thingRect = { x: thing.x - 72, y: thing.y - 28, width: 144, height: 56 }
      assert.equal(
        residentRect.x < thingRect.x + thingRect.width + 6 &&
          residentRect.x + residentRect.width + 6 > thingRect.x &&
          residentRect.y < thingRect.y + thingRect.height + 6 &&
          residentRect.y + residentRect.height + 6 > thingRect.y,
        false,
      )
    }
  }
})

test('expanded child thing ground places every selected thing outside resident coordinates', () => {
  const thingPointsAroundResidents = liveClientExports.windowLiveThingPointsAroundResidents
  assert.equal(typeof thingPointsAroundResidents, 'function')
  if (!thingPointsAroundResidents) return

  for (const count of [8, 12, 20, 80]) {
    const residentIds = Object.freeze(Array.from({ length: count }, (_, index) => 20 + index))
    const thingIds = Object.freeze(Array.from({ length: count }, (_, index) => 200 + index))
    const width = 480
    const residentHeight = Math.max(
      320,
      windowLiveScatterSurfaceHeight(0, width, count, 56, 56, 6),
    )
    const thingHeight = Math.max(
      320,
      windowLiveScatterSurfaceHeight(0, width, count, 94, 56, 6),
    )
    const residents = windowLiveSeparatedPoints(
      residentIds,
      width,
      residentHeight,
      47,
      56,
      56,
      6,
      1,
    )
    const things = thingPointsAroundResidents(
      thingIds,
      width,
      thingHeight,
      53,
      94,
      56,
      6,
      residents,
      [],
      {},
      false,
    )

    assert.equal(Object.keys(residents).length, count, `${count} expanded residents`)
    assert.equal(Object.keys(things).length, count, `${count} expanded things`)
  }
})

test('shared root ground keeps retained residents and things fixed when either type arrives', () => {
  const residentPointsAroundThings = liveClientExports.windowLiveResidentPointsAroundThings
  const thingPointsAroundResidents = liveClientExports.windowLiveThingPointsAroundResidents
  const rootReservations = liveClientExports.windowLiveRootReservations
  assert.equal(typeof residentPointsAroundThings, 'function')
  assert.equal(typeof thingPointsAroundResidents, 'function')
  assert.equal(typeof rootReservations, 'function')
  if (!residentPointsAroundThings || !thingPointsAroundResidents || !rootReservations) return

  const residentIds = Object.freeze([20, 21, 22, 23, 24, 25])
  const thingIds = Object.freeze([90, 91, 92, 93, 94, 95])
  const retained = (
    points: Readonly<Record<string, Readonly<{ x: number; y: number }>>>,
    ids: readonly number[],
  ) => Object.fromEntries(ids.map(id => [String(id), points[String(id)]]))

  for (let placeId = 1; placeId <= 250; placeId += 1) {
    const reserved = rootReservations(1_100, 680)
    const residentsBefore: LivePointMap = residentPointsAroundThings(
      residentIds, 1_100, 680, placeId * 17 + 3, 56, 56, 12, {}, 144, reserved,
    )
    const thingsBefore: LivePointMap = thingPointsAroundResidents(
      thingIds, 1_100, 680, placeId * 29 + 11, 144, 56, 12,
      residentsBefore, reserved, {}, true,
    )
    const residentsAfter: LivePointMap = residentPointsAroundThings(
      Object.freeze([...residentIds, 26]),
      1_100,
      680,
      placeId * 17 + 3,
      56,
      56,
      12,
      thingsBefore,
      144,
      reserved,
      residentsBefore,
      true,
    )
    const thingsAfterResident: LivePointMap = thingPointsAroundResidents(
      thingIds, 1_100, 680, placeId * 29 + 11, 144, 56, 12,
      residentsAfter, reserved, thingsBefore, true,
    )
    assert.deepEqual(retained(residentsAfter, residentIds), residentsBefore, `resident seed ${placeId}`)
    assert.deepEqual(thingsAfterResident, thingsBefore, `thing seed ${placeId}`)

    const residentsAfterThing: LivePointMap = residentPointsAroundThings(
      residentIds, 1_100, 680, placeId * 17 + 3, 56, 56, 12,
      thingsBefore, 144, reserved, residentsBefore, true,
    )
    const thingsAfterThing: LivePointMap = thingPointsAroundResidents(
      Object.freeze([...thingIds, 96]),
      1_100,
      680,
      placeId * 29 + 11,
      144,
      56,
      12,
      residentsAfterThing,
      reserved,
      thingsBefore,
      true,
    )
    assert.deepEqual(residentsAfterThing, residentsBefore, `resident thing-arrival seed ${placeId}`)
    assert.deepEqual(retained(thingsAfterThing, thingIds), thingsBefore, `new thing seed ${placeId}`)
  }
})

test('root overflow controls reserve the same ground before and after the 6 to 7 threshold', () => {
  const residentPointsAroundThings = liveClientExports.windowLiveResidentPointsAroundThings
  const thingPointsAroundResidents = liveClientExports.windowLiveThingPointsAroundResidents
  const rootReservations = liveClientExports.windowLiveRootReservations
  assert.equal(typeof residentPointsAroundThings, 'function')
  assert.equal(typeof thingPointsAroundResidents, 'function')
  assert.equal(typeof rootReservations, 'function')
  if (!residentPointsAroundThings || !thingPointsAroundResidents || !rootReservations) return

  const placeId = 17
  const residentIds = Object.freeze([20, 21, 22, 23, 24, 25])
  const thingIds = Object.freeze([90, 91, 92, 93, 94, 95])
  const reserved = rootReservations(1_100, 680)
  assert.deepEqual(reserved, [Object.freeze({ x: 984, y: 536, width: 116, height: 144 })])
  const residentsBefore: LivePointMap = residentPointsAroundThings(
    residentIds, 1_100, 680, placeId * 17 + 3, 56, 56, 12, {}, 144, reserved,
  )
  const thingsBefore: LivePointMap = thingPointsAroundResidents(
    thingIds, 1_100, 680, placeId * 29 + 11, 144, 56, 12,
    residentsBefore, reserved, {}, true,
  )
  const retainedResidentIds = residentIds.slice(0, 4)
  const residentsAfterThreshold: LivePointMap = residentPointsAroundThings(
    retainedResidentIds,
    1_100,
    680,
    placeId * 17 + 3,
    56,
    56,
    12,
    thingsBefore,
    144,
    reserved,
    residentsBefore,
    true,
  )
  const retainedThingIds = thingIds.slice(0, 5)
  const thingsAfterThreshold: LivePointMap = thingPointsAroundResidents(
    retainedThingIds,
    1_100,
    680,
    placeId * 29 + 11,
    144,
    56,
    12,
    residentsAfterThreshold,
    reserved,
    thingsBefore,
    true,
  )
  assert.deepEqual(
    residentsAfterThreshold,
    Object.fromEntries(retainedResidentIds.map(id => [String(id), residentsBefore[String(id)]])),
  )
  assert.deepEqual(
    thingsAfterThreshold,
    Object.fromEntries(retainedThingIds.map(id => [String(id), thingsBefore[String(id)]])),
  )
})

test('resident-only and thing-only root expansion keep one shared collision-free rail', () => {
  const residentPointsAroundThings = liveClientExports.windowLiveResidentPointsAroundThings
  const thingPointsAroundResidents = liveClientExports.windowLiveThingPointsAroundResidents
  const rootReservations = liveClientExports.windowLiveRootReservations
  assert.equal(typeof residentPointsAroundThings, 'function')
  assert.equal(typeof thingPointsAroundResidents, 'function')
  assert.equal(typeof rootReservations, 'function')
  if (!residentPointsAroundThings || !thingPointsAroundResidents || !rootReservations) return

  const rootExpandedDeclarations = windowClientModule.WINDOW_JS.match(
    /const rootExpanded = isRoot && \(\s*state\.live\.expandedResidentPlaceIds\.includes\([^)]+\) \|\|\s*state\.live\.expandedThingPlaceIds\.includes\([^)]+\)\s*\)/gu,
  ) || []
  assert.equal(rootExpandedDeclarations.length, 2)
  assert.equal((windowClientModule.WINDOW_JS.match(
    /rootExpanded \? liveDirectGroundHeight\(/gu,
  ) || []).length, 2)

  const width = 1_100
  const baseHeight = 680
  const placeId = 1
  const initialResidentIds = Object.freeze([20, 21, 22, 23])
  const initialThingIds = Object.freeze([90, 91, 92, 93, 94])
  const initialReserved = rootReservations(width, baseHeight)
  const initialResidents: LivePointMap = residentPointsAroundThings(
    initialResidentIds, width, baseHeight, placeId * 17 + 3, 56, 56, 12,
    {}, 144, initialReserved,
  )
  const initialThings: LivePointMap = thingPointsAroundResidents(
    initialThingIds, width, baseHeight, placeId * 29 + 11, 144, 56, 12,
    initialResidents, initialReserved,
  )
  const overlaps = (
    left: Readonly<{ x: number; y: number; width: number; height: number }>,
    right: Readonly<{ x: number; y: number; width: number; height: number }>,
  ) => left.x < right.x + right.width && left.x + left.width > right.x &&
    left.y < right.y + right.height && left.y + left.height > right.y
  const footprint = (
    point: Readonly<{ x: number; y: number }>,
    width: number,
    height: number,
    anchorY: number,
  ) => Object.freeze({
    x: point.x - width / 2,
    y: point.y - height * anchorY,
    width,
    height,
  })
  const assertClearOfControl = (
    points: LivePointMap,
    itemWidth: number,
    anchorY: number,
    control: Readonly<{ x: number; y: number; width: number; height: number }>,
  ) => {
    for (const point of Object.values(points)) {
      assert.equal(overlaps(footprint(point, itemWidth, 56, anchorY), control), false)
    }
  }
  const intersectionCount = (
    points: LivePointMap,
    itemWidth: number,
    anchorY: number,
    control: Readonly<{ x: number; y: number; width: number; height: number }>,
  ) => Object.values(points).filter(point =>
    overlaps(footprint(point, itemWidth, 56, anchorY), control)).length
  const controlRect = (
    rail: Readonly<{ x: number; y: number; width: number; height: number }>,
    slot: 'resident' | 'thing',
  ) => {
    const inset = 6
    const gap = 8
    const height = (rail.height - inset * 2 - gap) / 2
    return Object.freeze({
      x: rail.x + inset,
      y: rail.y + inset + (slot === 'thing' ? height + gap : 0),
      width: rail.width - inset * 2,
      height,
    })
  }

  const expandedResidentIds = Object.freeze(Array.from({ length: 800 }, (_, index) => 20 + index))
  const residentOnlyHeight = windowLiveScatterSurfaceHeight(
    baseHeight, width, expandedResidentIds.length, 56, 56, 12,
  )
  assert.equal(residentOnlyHeight, 3_744)
  const residentOnlyReserved = rootReservations(width, residentOnlyHeight)
  const residentOnlyResidents: LivePointMap = residentPointsAroundThings(
    expandedResidentIds, width, residentOnlyHeight, placeId * 17 + 3, 56, 56, 12,
    initialThings, 144, residentOnlyReserved, initialResidents, true,
  )
  const residentOnlyThings: LivePointMap = thingPointsAroundResidents(
    initialThingIds, width, residentOnlyHeight, placeId * 29 + 11, 144, 56, 12,
    residentOnlyResidents, residentOnlyReserved, initialThings, true,
  )
  assert.deepEqual(
    Object.fromEntries(initialResidentIds.map(id =>
      [String(id), residentOnlyResidents[String(id)]])),
    initialResidents,
  )
  assert.deepEqual(residentOnlyThings, initialThings)
  assert.equal(intersectionCount(
    residentOnlyResidents, 56, 1,
    controlRect(initialReserved[0]!, 'thing'),
  ), 2, 'the prior independent-height rail is a deterministic counterexample')
  assertClearOfControl(
    residentOnlyResidents, 56, 1,
    controlRect(residentOnlyReserved[0]!, 'thing'),
  )

  const expandedThingIds = Object.freeze(Array.from({ length: 400 }, (_, index) => 90 + index))
  const thingOnlyHeight = windowLiveScatterSurfaceHeight(
    baseHeight, width, expandedThingIds.length, 144, 56, 12, true,
  )
  assert.equal(thingOnlyHeight, 4_488)
  const thingOnlyReserved = rootReservations(width, thingOnlyHeight)
  const thingOnlyResidents: LivePointMap = residentPointsAroundThings(
    initialResidentIds, width, thingOnlyHeight, placeId * 17 + 3, 56, 56, 12,
    initialThings, 144, thingOnlyReserved, initialResidents, true,
  )
  const thingOnlyThings: LivePointMap = thingPointsAroundResidents(
    expandedThingIds, width, thingOnlyHeight, placeId * 29 + 11, 144, 56, 12,
    thingOnlyResidents, thingOnlyReserved, initialThings, true,
  )
  assert.deepEqual(thingOnlyResidents, initialResidents)
  assert.deepEqual(
    Object.fromEntries(initialThingIds.map(id => [String(id), thingOnlyThings[String(id)]])),
    initialThings,
  )
  assert.equal(intersectionCount(
    thingOnlyThings, 144, 0.5,
    controlRect(initialReserved[0]!, 'resident'),
  ), 2, 'the prior independent-height rail is a deterministic counterexample')
  assertClearOfControl(
    thingOnlyThings, 144, 0.5,
    controlRect(thingOnlyReserved[0]!, 'resident'),
  )
})

test('permanent direct commons stays disjoint and stable across 1,000 child arrivals', () => {
  const residentPointsAroundThings = liveClientExports.windowLiveResidentPointsAroundThings
  const thingPointsAroundResidents = liveClientExports.windowLiveThingPointsAroundResidents
  const rootReservations = liveClientExports.windowLiveRootReservations
  assert.equal(typeof residentPointsAroundThings, 'function')
  assert.equal(typeof thingPointsAroundResidents, 'function')
  assert.equal(typeof rootReservations, 'function')
  if (!residentPointsAroundThings || !thingPointsAroundResidents || !rootReservations) return

  const commonsWidth = 1_100
  const commonsHeight = 680
  const childGroundGap = 80
  const expandedCommonsHeight = windowLiveScatterSurfaceHeight(
    commonsHeight,
    commonsWidth,
    1_600,
    56,
    56,
    12,
  )
  assert.ok(expandedCommonsHeight > commonsHeight)
  const reserved = rootReservations(commonsWidth, commonsHeight)
  assert.deepEqual(reserved, [Object.freeze({ x: 984, y: 536, width: 116, height: 144 })])
  const residentIds = Object.freeze([20, 21, 22, 23, 24, 25])
  const thingIds = Object.freeze([90, 91, 92, 93, 94, 95])
  let commonsIntrusions = 0
  let movedResidents = 0
  let movedThings = 0

  for (let parentId = 1; parentId <= 1_000; parentId += 1) {
    const parent = Object.freeze({ id: parentId, parent_id: null, name: `parent ${parentId}` })
    const firstChild = Object.freeze({
      id: 10_000 + parentId * 2,
      parent_id: parentId,
      name: `first child ${parentId}`,
    })
    const laterChild = Object.freeze({
      id: firstChild.id + 1,
      parent_id: parentId,
      name: `later child ${parentId}`,
    })
    const beforePlots = windowLiveSurveyedPlots(Object.freeze([parent, firstChild]), parentId)
    const afterPlots = windowLiveSurveyedPlots(
      Object.freeze([parent, firstChild, laterChild]),
      parentId,
    )
    assert.deepEqual(afterPlots.find(plot => plot.id === firstChild.id), beforePlots[0])
    commonsIntrusions += afterPlots.filter(plot => plot.x < commonsWidth + childGroundGap).length

    const residentsBefore: LivePointMap = residentPointsAroundThings(
      residentIds,
      commonsWidth,
      commonsHeight,
      parentId * 17 + 3,
      56,
      56,
      12,
      {},
      144,
      reserved,
    )
    const thingsBefore: LivePointMap = thingPointsAroundResidents(
      thingIds,
      commonsWidth,
      commonsHeight,
      parentId * 29 + 11,
      144,
      56,
      12,
      residentsBefore,
      reserved,
    )
    const residentsAfter: LivePointMap = residentPointsAroundThings(
      residentIds,
      commonsWidth,
      commonsHeight,
      parentId * 17 + 3,
      56,
      56,
      12,
      thingsBefore,
      144,
      reserved,
      residentsBefore,
    )
    const thingsAfter: LivePointMap = thingPointsAroundResidents(
      thingIds,
      commonsWidth,
      commonsHeight,
      parentId * 29 + 11,
      144,
      56,
      12,
      residentsAfter,
      reserved,
      thingsBefore,
    )
    if (!Object.is(JSON.stringify(residentsAfter), JSON.stringify(residentsBefore))) movedResidents += 1
    if (!Object.is(JSON.stringify(thingsAfter), JSON.stringify(thingsBefore))) movedThings += 1
  }

  assert.equal(commonsIntrusions, 0)
  assert.equal(movedResidents, 0)
  assert.equal(movedThings, 0)
})

test('expanded natural grounds keep fixed plots still and reserve separate reachable clearings', () => {
  const plots = windowLiveSurveyedPlots([
    Object.freeze({ id: 1, parent_id: null }),
    Object.freeze({ id: 2, parent_id: 1 }),
    Object.freeze({ id: 3, parent_id: 1 }),
    Object.freeze({ id: 4, parent_id: 1 }),
  ], 1)
  const before = structuredClone(plots)
  const layout = windowLiveExpandedGroundLayout(plots, Object.freeze([
    Object.freeze({ id: 2, residentHeight: 320, thingHeight: 382 }),
    Object.freeze({ id: 3, residentHeight: 320, thingHeight: 0 }),
  ]))

  assert.deepEqual(plots, before)
  assert.deepEqual(Object.keys(layout.grounds).sort(), ['2', '3'])
  const grounds = Object.values(layout.grounds).map(ground => ({
    x: ground.x,
    y: ground.residentTop ?? ground.thingTop!,
    width: ground.width,
    height: ground.bottom - (ground.residentTop ?? ground.thingTop!),
  }))
  const fixed = plots.map(plot => ({
    x: plot.x,
    y: plot.y,
    width: plot.width,
    height: plot.height + 64,
  }))
  const overlaps = (
    left: Readonly<{ x: number; y: number; width: number; height: number }>,
    right: Readonly<{ x: number; y: number; width: number; height: number }>,
  ) => left.x < right.x + right.width + 16 && left.x + left.width + 16 > right.x &&
    left.y < right.y + right.height + 16 && left.y + left.height + 16 > right.y
  for (const ground of grounds) {
    for (const plot of fixed) assert.equal(overlaps(ground, plot), false)
  }
  assert.equal(overlaps(grounds[0]!, grounds[1]!), false)
  assert.ok(layout.height >= Math.max(...grounds.map(ground => ground.y + ground.height)))
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

test('expanded plot ground stays detailed while its fixed card is off camera', () => {
  const visiblePlotIds = liveClientExports.windowLiveVisiblePlotIds
  assert.equal(typeof visiblePlotIds, 'function')
  if (!visiblePlotIds) return

  const plots = Object.freeze(Array.from({ length: 80 }, (_, index) => Object.freeze({
    id: index + 1,
    x: index * 600,
    y: 100,
    width: 440,
    height: 280,
  })))
  const expandedGrounds = Object.freeze({
    '1': Object.freeze({
      x: 0,
      residentTop: 900,
      thingTop: 1_240,
      width: 480,
      bottom: 1_620,
    }),
  })

  assert.deepEqual(visiblePlotIds(
    plots,
    expandedGrounds,
    Object.freeze({ left: 0, top: 1_300, right: 480, bottom: 1_620 }),
    0,
  ), [1])
  assert.deepEqual(visiblePlotIds(
    plots,
    expandedGrounds,
    Object.freeze({ left: 600, top: 380, right: 1_040, bottom: 444 }),
    0,
  ), [2], 'the control rail remains part of its owner detail region')
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

test('floor tiling derives exact, stable column and row counts from a plot\'s real size', () => {
  assert.deepEqual(windowLiveFloorTiling(320, 200, 32), { columns: 10, rows: 7 })
  // Not an exact multiple of the tile size: rounds up so the tiled ground
  // never leaves a gap at the plot's far edge.
  assert.deepEqual(windowLiveFloorTiling(321, 201, 32), { columns: 11, rows: 7 })
  // Append-stable plot sizes across many different, non-round dimensions
  // stay deterministic, integer, and never zero.
  const sizes: readonly (readonly [number, number])[] =
    [[1, 1], [8_192, 6_144], [97, 53], [56, 56]]
  for (const [width, height] of sizes) {
    const tiling = windowLiveFloorTiling(width, height, 32)
    assert.ok(Number.isInteger(tiling.columns) && tiling.columns > 0)
    assert.ok(Number.isInteger(tiling.rows) && tiling.rows > 0)
  }
  // Malformed input never produces zero or a fraction either.
  for (const bad of [0, -5, NaN, Infinity]) {
    const tiling = windowLiveFloorTiling(bad, bad, 32)
    assert.ok(Number.isInteger(tiling.columns) && tiling.columns > 0)
    assert.ok(Number.isInteger(tiling.rows) && tiling.rows > 0)
  }
  assert.match(
    windowClientModule.WINDOW_JS,
    /const windowLiveFloorTiling = function windowLiveFloorTiling/u,
  )
})

test('a place floor keeps an accessible name carrying its name, drawn state, and source', () => {
  // Round-1 review finding 1: the JSON drawing node's role="img" name
  // (name, state, maker/source) went away with the JSON fetch it was
  // built from. The non-proof path never re-adds that fetch -- state 3's
  // whole point -- so it only ever knows the drawn/undrawn binary the
  // thumb probe resolves; a place's own floor is always its own drawing.
  assert.equal(
    windowLiveFloorAccessibleLabel('Cinder lane', false),
    'Cinder lane · Complete · Own drawing',
  )
  assert.equal(
    windowLiveFloorAccessibleLabel('Harbor room', true),
    'Harbor room · Undrawn',
  )
  // The proof path already holds the full synthetic drawing entry, so it
  // reuses the exact state/source vocabulary the deleted drawingNode did,
  // including a case the binary non-proof path cannot distinguish (Blank).
  assert.equal(
    windowLiveFloorAccessibleLabel('workshop', false, Object.freeze({
      state: 'complete',
      drawing: Object.freeze({
        palette: Object.freeze(['#102030']),
        indices: Object.freeze(Array.from({ length: 64 }, (_, index) => index === 0 ? 0 : null)),
      }),
      source: 'place',
    })),
    'workshop · Complete · Own drawing',
  )
  assert.equal(
    windowLiveFloorAccessibleLabel('garden', true, Object.freeze({
      state: 'complete',
      drawing: Object.freeze({
        palette: Object.freeze([]),
        indices: Object.freeze(Array(64).fill(null) as null[]),
      }),
      source: 'place',
    })),
    'garden · Blank · Own drawing',
  )
  assert.match(
    windowClientModule.WINDOW_JS,
    /const windowLiveFloorAccessibleLabel = function windowLiveFloorAccessibleLabel/u,
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

test('every programmatic Live target is revealed inside the interactive safe viewport', () => {
  const revealCamera = liveClientExports.windowLiveRevealCamera
  assert.equal(typeof revealCamera, 'function')
  if (!revealCamera) return

  const viewports = Object.freeze([
    Object.freeze({ width: 320, height: 352 }),
    Object.freeze({ width: 824, height: 576 }),
    Object.freeze({ width: 1_280, height: 720 }),
  ])
  const targets = Object.freeze([
    Object.freeze({ kind: 'resident', width: 56, height: 56 }),
    Object.freeze({ kind: 'thing', width: 144, height: 56 }),
    Object.freeze({ kind: 'overflow rail', width: 268, height: 44 }),
    Object.freeze({ kind: 'Retry', width: 192, height: 132 }),
  ])
  const scales = Object.freeze([0.8, 1, 2.2])
  const safeInset = 16

  for (const viewport of viewports) {
    for (const target of targets) {
      for (const scale of scales) {
        for (const screenPoint of [
          Object.freeze({ x: -240, y: viewport.height / 2 }),
          Object.freeze({ x: viewport.width + 240, y: viewport.height / 2 }),
          Object.freeze({ x: viewport.width / 2, y: -240 }),
          Object.freeze({ x: viewport.width / 2, y: viewport.height + 240 }),
        ]) {
          const targetX = 2_000
          const targetY = 1_000
          const offsetX = screenPoint.x - targetX * scale
          const offsetY = screenPoint.y - targetY * scale
          const revealed = revealCamera(
            viewport.width, viewport.height, targetX, targetY,
            target.width, target.height, scale, offsetX, offsetY, safeInset,
          )
          assert.ok(revealed, `${target.kind} ${viewport.width}x${viewport.height}`)
          const centerX = targetX * scale + revealed.offsetX
          const centerY = targetY * scale + revealed.offsetY
          assert.ok(centerX >= safeInset && centerX <= viewport.width - safeInset,
            `${target.kind} x center in ${viewport.width}x${viewport.height}`)
          assert.ok(centerY >= safeInset && centerY <= viewport.height - safeInset,
            `${target.kind} y center in ${viewport.width}x${viewport.height}`)
          if (target.width * scale <= viewport.width - safeInset * 2) {
            assert.ok(centerX - target.width * scale / 2 >= safeInset)
            assert.ok(centerX + target.width * scale / 2 <= viewport.width - safeInset)
          }
          if (target.height * scale <= viewport.height - safeInset * 2) {
            assert.ok(centerY - target.height * scale / 2 >= safeInset)
            assert.ok(centerY + target.height * scale / 2 <= viewport.height - safeInset)
          }
        }
      }
    }
  }
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

// Step 4: the single reusable Live item popover. windowLiveItemFacts,
// windowLiveItemLastAction, and windowLiveItemPopoverPlacement are the
// pure, stringified-into-the-client helpers behind it
// (src/window-client/live-popover.ts).

test('windowLiveItemFacts builds the same fact-row shape for a resident, a thing, and a place, and marks an unknown fact absent rather than guessing', () => {
  const residentFacts = windowLiveItemFacts('resident', { asleep: false, has_drawing: false }, {})
  assert.deepEqual(residentFacts.facts, ['no drawing yet'])
  assert.equal(residentFacts.quiet, false)

  const thingWithoutMaker = windowLiveItemFacts('thing', {
    made_by: null, current_owner: 'proof-alex', body: 'hi', truncated: false,
    open_to_use: false, kind: null, has_drawing: false,
  }, {})
  assert.ok(!thingWithoutMaker.facts.some(fact => fact.startsWith('made by')))
  assert.deepEqual(thingWithoutMaker.facts, ['kept by proof-alex', 'body 2 bytes', 'no drawing yet'])

  const residentWithNoResolvedLocation = windowLiveItemFacts(
    'resident', { asleep: false, has_drawing: false }, { locationName: null },
  )
  assert.ok(!residentWithNoResolvedLocation.facts.some(fact => fact.startsWith('in ')))

  assert.match(
    windowClientModule.WINDOW_JS,
    /const windowLiveItemFacts = function windowLiveItemFacts/u,
  )
})

test('windowLiveItemFacts reports an exact body size as UTF-8 byte length, and omits it entirely for a truncated thing', () => {
  const multiByte = windowLiveItemFacts('thing', {
    made_by: 'proof-alex', current_owner: 'proof-alex', body: 'éé', truncated: false,
    open_to_use: false, kind: null, has_drawing: false,
  }, {})
  assert.ok(multiByte.facts.includes('body 4 bytes'))

  const truncated = windowLiveItemFacts('thing', {
    made_by: 'proof-alex', current_owner: 'proof-alex', body: 'x'.repeat(1000), truncated: true,
    open_to_use: false, kind: null, has_drawing: false,
  }, {})
  assert.ok(!truncated.facts.some(fact => /^body \d+ bytes$/.test(fact)))
  assert.ok(truncated.facts.includes(
    'body continues past the loaded head — open the record for the whole body',
  ))
})

test('windowLiveItemFacts on a quiet place returns the name, owner, and both counts with quiet true and zero content facts', () => {
  const quiet = windowLiveItemFacts('place', {
    owner: 'proof-alex', purpose: 'A private workshop.', places: 2, notes: 3, quiet: true,
  }, { exactThingTotal: 7 })
  assert.equal(quiet.quiet, true)
  assert.deepEqual(quiet.facts, ['kept by proof-alex', '2 places · 3 notes', '7 things'])
  assert.ok(!quiet.facts.some(fact => fact === 'A private workshop.'))
})

test('windowLiveItemFacts on a resident whose current place is quiet omits the location name entirely', () => {
  const result = windowLiveItemFacts(
    'resident',
    { asleep: false, has_drawing: false },
    { locationName: 'Quiet porch', locationQuiet: true },
  )
  assert.ok(!result.facts.some(fact => fact.includes('Quiet porch')))
})

test('windowLiveItemFacts degrades the drawing fact honestly: exact label when cached, else only has/no drawing yet', () => {
  const cachedComplete = windowLiveItemFacts('resident', { asleep: false, has_drawing: true }, {
    cachedDrawing: {
      state: 'complete',
      drawing: Object.freeze({
        palette: Object.freeze(['#102030']),
        indices: Object.freeze(Array.from({ length: 64 }, (_, index) => index === 0 ? 0 : null)),
      }),
      source: 'resident',
    },
  })
  assert.ok(cachedComplete.facts.includes('Complete · Own drawing'))

  const cachedBlank = windowLiveItemFacts('resident', { asleep: false, has_drawing: true }, {
    cachedDrawing: {
      state: 'complete',
      drawing: Object.freeze({ palette: Object.freeze([]), indices: Array(64).fill(null) }),
      source: 'resident',
    },
  })
  assert.ok(cachedBlank.facts.includes('Blank · Own drawing'))

  const uncachedDrawn = windowLiveItemFacts('resident', { asleep: false, has_drawing: true }, {})
  assert.ok(uncachedDrawn.facts.includes('has a drawing'))
  const uncachedUndrawn = windowLiveItemFacts('resident', { asleep: false, has_drawing: false }, {})
  assert.ok(uncachedUndrawn.facts.includes('no drawing yet'))
})

test('windowLiveItemFacts omits the exact thing count only when the survey total is null, never a loaded-row count dressed as exact', () => {
  const unavailable = windowLiveItemFacts('place', {
    owner: 'proof-alex', places: 0, notes: 0,
  }, { exactThingTotal: null })
  assert.ok(unavailable.facts.includes('exact thing count unavailable'))

  const exact = windowLiveItemFacts('place', {
    owner: 'proof-alex', places: 0, notes: 0,
  }, { exactThingTotal: 7 })
  assert.ok(exact.facts.includes('7 things'))
})

test('windowLiveItemFacts on the ownerless world root prints "nobody owns it", and an empty purpose yields no purpose row', () => {
  const root = windowLiveItemFacts('place', { owner: null, purpose: '', places: 3, notes: 0 }, {
    exactThingTotal: 0,
  })
  assert.ok(root.facts.includes('nobody owns it'))
  assert.ok(!root.facts.some(fact => fact === ''))
  assert.equal(root.facts.filter(fact => fact === 'nobody owns it').length, 1)
})

test('windowLiveItemLastAction returns a body-free phrase for move, note, make, and use, and null when nothing covers the item', () => {
  const at = new Date('2026-01-01T00:00:00.000Z')
  const moveRecord = Object.freeze({
    actor: 'proof-alex', kind: 'action', at,
    detail: Object.freeze({ action: 'move', status: 'applied', from_place_id: 1, to_place_id: 2 }),
  })
  assert.equal(
    windowLiveItemLastAction([moveRecord], 'resident', 'proof-alex', () => 'Movement garden'),
    'moved in from Movement garden',
  )

  const noteRecord = Object.freeze({
    actor: 'proof-alex', kind: 'note', at,
    detail: Object.freeze({ note_id: 9301, place_id: 2 }),
  })
  assert.equal(windowLiveItemLastAction([noteRecord], 'resident', 'proof-alex'), 'spoke here')

  const makeRecord = Object.freeze({
    actor: 'proof-alex', kind: 'thing_created', at,
    detail: Object.freeze({ place_id: 2, thing_id: 9401 }),
  })
  assert.equal(
    windowLiveItemLastAction([makeRecord], 'resident', 'proof-alex'),
    'made thing #9401',
  )

  const useRecord = Object.freeze({
    actor: 'proof-alex', kind: 'action', at,
    detail: Object.freeze({
      action: 'use', status: 'applied', place_id: 2, source_thing_id: 9401,
    }),
  })
  assert.equal(
    windowLiveItemLastAction([useRecord], 'resident', 'proof-alex'),
    'used thing #9401',
  )

  assert.equal(windowLiveItemLastAction([], 'resident', 'proof-alex'), null)
  assert.equal(windowLiveItemLastAction([moveRecord], 'place', '2'), null)

  const usedByThing = windowLiveItemLastAction([useRecord], 'thing', 9401)
  assert.equal(usedByThing, 'used by proof-alex')
  const madeByThing = windowLiveItemLastAction([makeRecord], 'thing', 9401)
  assert.equal(madeByThing, 'made by proof-alex here')
  const carriedThing = windowLiveItemLastAction([Object.freeze({
    actor: 'proof-bea', kind: 'action', at,
    detail: Object.freeze({
      action: 'move', status: 'applied', from_place_id: 1, to_place_id: 2,
      mode: 'carry', thing_id: 9401,
    }),
  })], 'thing', 9401)
  assert.equal(carriedThing, 'carried in by proof-bea')

  assert.match(
    windowClientModule.WINDOW_JS,
    /const windowLiveItemLastAction = function windowLiveItemLastAction/u,
  )
})

test('windowLiveItemLastAction withholds a place name when that place is quiet, for both endpoints of a move', () => {
  const at = new Date('2026-01-01T00:00:00.000Z')
  const moveRecord = Object.freeze({
    actor: 'proof-alex', kind: 'action', at,
    detail: Object.freeze({ action: 'move', status: 'applied', from_place_id: 1, to_place_id: 2 }),
  })
  const withheld = windowLiveItemLastAction([moveRecord], 'resident', 'proof-alex', () => null)
  assert.equal(withheld, 'moved in')
  assert.ok(!withheld.includes('from'))
})

test('windowLiveItemPopoverPlacement never returns a rectangle intersecting the anchor rect', () => {
  const viewport = Object.freeze({ left: 0, top: 0, right: 800, bottom: 600 })
  const size = Object.freeze({ width: 200, height: 100 })
  const anchors = [
    Object.freeze({ left: 400, top: 300, right: 420, bottom: 320 }), // centre
    Object.freeze({ left: 0, top: 0, right: 20, bottom: 20 }), // top-left corner
    Object.freeze({ left: 780, top: 0, right: 800, bottom: 20 }), // top-right corner
    Object.freeze({ left: 0, top: 580, right: 20, bottom: 600 }), // bottom-left corner
    Object.freeze({ left: 780, top: 580, right: 800, bottom: 600 }), // bottom-right corner
  ]
  for (const anchor of anchors) {
    const placement = windowLiveItemPopoverPlacement(anchor, size, viewport, 10, 8)
    if (!placement) continue
    const intersects = placement.left < anchor.right && placement.left + size.width > anchor.left &&
      placement.top < anchor.bottom && placement.top + size.height > anchor.top
    assert.equal(intersects, false, JSON.stringify(anchor))
  }
})

test('windowLiveItemPopoverPlacement keeps the popover fully inside the viewport with margin whenever any side fits, and clamps without covering the anchor otherwise', () => {
  const viewport = Object.freeze({ left: 0, top: 0, right: 800, bottom: 600 })
  const size = Object.freeze({ width: 200, height: 100 })
  const anchor = Object.freeze({ left: 400, top: 300, right: 420, bottom: 320 })
  const placement = windowLiveItemPopoverPlacement(anchor, size, viewport, 10, 8)
  assert.ok(placement)
  assert.ok(placement.left >= 8)
  assert.ok(placement.left + size.width <= 800 - 8)
  assert.ok(placement.top >= 8)
  assert.ok(placement.top + size.height <= 600 - 8)

  // A 375x812 phone viewport with a 320-wide popover, anchored near the edge.
  const phoneViewport = Object.freeze({ left: 0, top: 0, right: 375, bottom: 812 })
  const phoneSize = Object.freeze({ width: 320, height: 160 })
  const edgeAnchor = Object.freeze({ left: 2, top: 2, right: 22, bottom: 22 })
  const phonePlacement = windowLiveItemPopoverPlacement(edgeAnchor, phoneSize, phoneViewport, 10, 8)
  assert.ok(phonePlacement)
  assert.ok(phonePlacement.left >= 0)
  assert.ok(phonePlacement.left + phoneSize.width <= 375)
})

test('windowLiveItemPopoverPlacement is deterministic and fails closed on invalid input', () => {
  const viewport = Object.freeze({ left: 0, top: 0, right: 800, bottom: 600 })
  const size = Object.freeze({ width: 200, height: 100 })
  const anchor = Object.freeze({ left: 400, top: 300, right: 420, bottom: 320 })
  const first = windowLiveItemPopoverPlacement(anchor, size, viewport, 10, 8)
  const second = windowLiveItemPopoverPlacement(anchor, size, viewport, 10, 8)
  assert.deepEqual(first, second)

  assert.equal(windowLiveItemPopoverPlacement(
    Object.freeze({ left: NaN, top: 0, right: 20, bottom: 20 }), size, viewport, 10, 8,
  ), null)
  assert.equal(windowLiveItemPopoverPlacement(
    Object.freeze({ left: 10, top: 10, right: 10, bottom: 10 }), size, viewport, 10, 8,
  ), null)

  assert.match(
    windowClientModule.WINDOW_JS,
    /const windowLiveItemPopoverPlacement = function windowLiveItemPopoverPlacement/u,
  )
})
