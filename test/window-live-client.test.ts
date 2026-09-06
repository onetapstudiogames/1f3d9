import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as windowClientModule from '../src/window-client.ts'
import { PART_42_STAGE_NODES } from '../src/window-client/program/42-stage-nodes.ts'
import { PART_43_STAGE_GROUND } from '../src/window-client/program/43-stage-ground.ts'
import { PART_24_LIVE_REPLAY_MOTION } from '../src/window-client/program/24-live-replay-motion.ts'
import { PART_39_WIRING_AND_BOOT } from '../src/window-client/program/39-wiring-and-boot.ts'
import {
  normalizeWindowDrawing,
  normalizeLiveNotesPage,
  windowLiveClampZoomScale,
  windowLiveDetailMoverSelection,
  windowLiveFloorAccessibleLabel,
  windowLiveFloorTiling,
  windowLiveFootstepBeat,
  windowLivePollDelay,
  windowLiveReplayDuration,
  windowLiveReplayOrder,
  windowLiveReplayPace,
  windowLiveReplayStartOffsets,
  windowLiveRouteVisibilityIntervals,
  windowLivePruneTrailStarts,
  windowLiveSpeechLine,
  windowLiveShouldScheduleRedraw,
  windowLiveTouchActivation,
  windowLiveTraceOpacity,
  windowLiveItemFacts,
  windowLiveItemLastAction,
  windowLiveItemPopoverPlacement,
  stageNodeKey,
  reconcileStageNodeKeys,
  stageDrawnNodeKeys,
  stageFacing,
  stageTransform,
  stageFindFreeSpots,
  stageBuildCorridorGraph,
  stageChildPlaces,
  stageExpandedGroundLayout,
  stageQuietRoom,
  stageRoomLayout,
  stageStandingRoomHeight,
  stageShortestPath,
} from '../src/window-client.ts'

const LIVE_NOTES_PAGE = Object.freeze({
  change_marker: '25',
  notes: Object.freeze([
    Object.freeze({
      id: 52,
      place_id: 422,
      author: 'tinylantern',
      body: 'The newest note.',
      created_at: '2026-09-04T12:00:00.000Z',
      moderated: false,
      truncated: false,
    }),
  ]),
  has_more: true,
  next_before_id: 52,
})

test('normalizeLiveNotesPage accepts one bounded direct-place page', () => {
  const page = normalizeLiveNotesPage(LIVE_NOTES_PAGE, 422, null)
  assert.ok(page)
  assert.equal(page.rows.length, 1)
  assert.equal(page.rows[0]?.place_id, 422)
  assert.equal(page.nextBeforeId, 52)
})

test('normalizeLiveNotesPage rejects malformed pages, repeated cursors, and another place row', () => {
  assert.equal(normalizeLiveNotesPage({ ...LIVE_NOTES_PAGE, notes: null }, 422, null), null)
  assert.equal(normalizeLiveNotesPage(LIVE_NOTES_PAGE, 422, 52), null)
  assert.equal(normalizeLiveNotesPage({
    ...LIVE_NOTES_PAGE,
    notes: LIVE_NOTES_PAGE.notes.map(note => ({ ...note, place_id: 438 })),
  }, 422, null), null)
})

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
}>

const liveClientExports = windowClientModule as unknown as LiveClientExports

type FakeStageNode = {
  dataset: Record<string, string>
  removed: number
  remove(): void
  querySelectorAll(): readonly never[]
}

type StageRegistryRuntime = Readonly<{
  beginStageNodeReconcile(): void
  drawnStageNodeKeys(root: Readonly<{
    querySelectorAll(): readonly FakeStageNode[]
  }>): readonly string[]
  ensureStageNode(kind: string, id: number, factory: () => FakeStageNode): FakeStageNode
  finishStageNodeReconcile(drawnKeys?: readonly string[]): void
  retireAllStageNodes(): void
  stageNodeReconcileOpen(): boolean
  stageNode(kind: string, id: number): FakeStageNode | null
}>

function createStageRegistryRuntime(): StageRegistryRuntime {
  return new Function(
    'stageNodeKey',
    'reconcileStageNodeKeys',
    'stageDrawnNodeKeys',
    'stageTransform',
    `const liveStageNodes = new Map()
let liveStageNextNodeKeys = null
let portraitObserver = null
const observedPortraitShells = new Set()
const pendingPortraitShells = new Set()
${PART_42_STAGE_NODES}
return {
  beginStageNodeReconcile,
  drawnStageNodeKeys,
  ensureStageNode,
  finishStageNodeReconcile,
  retireAllStageNodes,
  stageNodeReconcileOpen,
  stageNode,
}`,
  )(stageNodeKey, reconcileStageNodeKeys, stageDrawnNodeKeys, stageTransform) as StageRegistryRuntime
}

function fakeDrawnStage(nodes: readonly FakeStageNode[]) {
  return Object.freeze({ querySelectorAll: () => nodes })
}

function fakeStageNodeFactory(creations: Map<number, number>, id: number) {
  return () => {
    creations.set(id, (creations.get(id) || 0) + 1)
    return {
      dataset: {},
      removed: 0,
      remove() { this.removed += 1 },
      querySelectorAll: () => [],
    }
  }
}

test('stage node reconciliation keeps survivors, creates newcomers once, and retires departures', () => {
  const runtime = createStageRegistryRuntime()
  const creations = new Map<number, number>()

  assert.equal(runtime.stageNodeReconcileOpen(), false)
  runtime.beginStageNodeReconcile()
  assert.equal(runtime.stageNodeReconcileOpen(), true)
  const departed = runtime.ensureStageNode('resident', 11, fakeStageNodeFactory(creations, 11))
  const survivor = runtime.ensureStageNode('resident', 12, fakeStageNodeFactory(creations, 12))
  runtime.finishStageNodeReconcile()
  assert.equal(runtime.stageNodeReconcileOpen(), false)
  runtime.beginStageNodeReconcile()
  const repaintedSurvivor = runtime.ensureStageNode(
    'resident', 12, fakeStageNodeFactory(creations, 12))
  const newcomer = runtime.ensureStageNode('resident', 13, fakeStageNodeFactory(creations, 13))
  runtime.finishStageNodeReconcile()

  assert.strictEqual(repaintedSurvivor, survivor, 'resident:12 keeps its node object')
  assert.strictEqual(runtime.stageNode('resident', 13), newcomer)
  assert.equal(creations.get(12), 1, 'resident:12 factory runs exactly once')
  assert.equal(creations.get(13), 1, 'resident:13 factory runs exactly once')
  assert.equal(departed.removed, 1, 'only resident:11 is removed')
  assert.equal(survivor.removed, 0)
  assert.equal(runtime.stageNode('resident', 11), null)
})

test('stage reconcile keeps every node and custom data when the drawn set is unchanged', () => {
  const runtime = createStageRegistryRuntime()
  const creations = new Map<number, number>()
  const records = Object.freeze([
    Object.freeze({ kind: 'place', id: 3 }),
    Object.freeze({ kind: 'resident', id: 21 }),
    Object.freeze({ kind: 'thing', id: 9 }),
  ])
  const firstPaint = new Map<string, FakeStageNode>()
  const secondPaint = new Map<string, FakeStageNode>()

  runtime.beginStageNodeReconcile()
  for (const record of records) {
    const node = runtime.ensureStageNode(
      record.kind, record.id, fakeStageNodeFactory(creations, record.id))
    firstPaint.set(`${record.kind}:${String(record.id)}`, node)
  }
  runtime.finishStageNodeReconcile(runtime.drawnStageNodeKeys(
    fakeDrawnStage([...firstPaint.values()])))
  for (const record of records) {
    firstPaint.get(`${record.kind}:${String(record.id)}`)!.dataset.identityMarker =
      `${record.kind}-${String(record.id)}`
  }

  runtime.beginStageNodeReconcile()
  for (const record of records) {
    secondPaint.set(`${record.kind}:${String(record.id)}`, runtime.ensureStageNode(
      record.kind, record.id, fakeStageNodeFactory(creations, record.id)))
  }
  runtime.finishStageNodeReconcile(runtime.drawnStageNodeKeys(
    fakeDrawnStage([...secondPaint.values()])))

  for (const record of records) {
    const key = `${record.kind}:${String(record.id)}`
    const node = secondPaint.get(key)
    assert.strictEqual(node, firstPaint.get(key), `${key} keeps its node object`)
    assert.strictEqual(runtime.stageNode(record.kind, record.id), node)
    assert.equal(node?.dataset.identityMarker, `${record.kind}-${String(record.id)}`)
    assert.equal(creations.get(record.id), 1, `${key} factory runs exactly once`)
  }
})

test('stage reconcile retires exactly the residents dropped by overflow and keeps survivors', () => {
  const runtime = createStageRegistryRuntime()
  const creations = new Map<number, number>()
  const firstFrame = new Map<number, FakeStageNode>()

  for (let id = 1; id <= 8; id += 1) {
    firstFrame.set(id, runtime.ensureStageNode(
      'resident', id, fakeStageNodeFactory(creations, id)))
  }

  runtime.beginStageNodeReconcile()
  for (let id = 1; id <= 8; id += 1) {
    runtime.ensureStageNode('resident', id, fakeStageNodeFactory(creations, id))
  }
  const drawnNodes = [1, 2, 3, 4, 5, 6].map(id => firstFrame.get(id)!)
  runtime.finishStageNodeReconcile(runtime.drawnStageNodeKeys(fakeDrawnStage(drawnNodes)))

  for (let id = 1; id <= 6; id += 1) {
    assert.strictEqual(runtime.stageNode('resident', id), firstFrame.get(id))
    assert.equal(firstFrame.get(id)?.removed, 0)
    assert.equal(creations.get(id), 1)
  }
  assert.equal(firstFrame.get(7)?.removed, 1)
  assert.equal(firstFrame.get(8)?.removed, 1)
  assert.equal(runtime.stageNode('resident', 7), null)
  assert.equal(runtime.stageNode('resident', 8), null)
  assert.equal([...firstFrame.values()].reduce((total, node) => total + node.removed, 0), 2)
})

test('stage reconcile retires a stale walker without duplicating its id', () => {
  const runtime = createStageRegistryRuntime()
  const creations = new Map<number, number>()

  const walker = runtime.ensureStageNode(
    'resident', 21, fakeStageNodeFactory(creations, 21))

  runtime.beginStageNodeReconcile()
  const staleWalker = runtime.ensureStageNode(
    'resident', 21, fakeStageNodeFactory(creations, 21))
  const repeatedEntry = runtime.ensureStageNode(
    'resident', 21, fakeStageNodeFactory(creations, 21))
  runtime.finishStageNodeReconcile(runtime.drawnStageNodeKeys(fakeDrawnStage([])))

  assert.strictEqual(staleWalker, walker)
  assert.strictEqual(repeatedEntry, walker)
  assert.equal(creations.get(21), 1)
  assert.equal(walker.removed, 1)
  assert.equal(runtime.stageNode('resident', 21), null)
})

test('stage reconcile retires a stale node still attached inside a kept container', () => {
  const runtime = createStageRegistryRuntime()
  const creations = new Map<number, number>()
  const stale = runtime.ensureStageNode(
    'resident', 21, fakeStageNodeFactory(creations, 21))
  const survivor = runtime.ensureStageNode(
    'resident', 22, fakeStageNodeFactory(creations, 22))

  runtime.beginStageNodeReconcile()
  runtime.ensureStageNode('resident', 22, fakeStageNodeFactory(creations, 22))
  runtime.finishStageNodeReconcile(runtime.drawnStageNodeKeys(
    fakeDrawnStage([stale, survivor])))

  assert.strictEqual(runtime.stageNode('resident', 22), survivor)
  assert.equal(survivor.removed, 0)
  assert.equal(stale.removed, 1)
  assert.equal(runtime.stageNode('resident', 21), null)
})

test('bare finish preserves the registry and permanent gates retire every stage node explicitly', () => {
  for (const gate of ['issue', 'no-plate', 'quiet']) {
    const runtime = createStageRegistryRuntime()
    const creations = new Map<number, number>()
    const resident = runtime.ensureStageNode(
      'resident', 21, fakeStageNodeFactory(creations, 21))
    const thing = runtime.ensureStageNode('thing', 9, fakeStageNodeFactory(creations, 9))

    runtime.finishStageNodeReconcile()

    assert.strictEqual(runtime.stageNode('resident', 21), resident, `${gate} bare finish keeps resident`)
    assert.strictEqual(runtime.stageNode('thing', 9), thing, `${gate} bare finish keeps thing`)

    runtime.retireAllStageNodes()

    assert.equal(resident.removed, 1, `${gate} explicitly retires resident`)
    assert.equal(thing.removed, 1, `${gate} explicitly retires thing`)
    assert.equal(runtime.stageNode('resident', 21), null)
    assert.equal(runtime.stageNode('thing', 9), null)
  }
})

test('stage sprite transforms flip only through --facing and never rotate', () => {
  assert.equal(stageFacing(20, 10, 1), -1)
  assert.equal(stageFacing(10, 20, -1), 1)
  assert.equal(stageFacing(10, 10, -1), -1)
  assert.equal(stageTransform(24, 36), 'translate(24px, 36px) translate(-50%, -100%)')
  assert.doesNotMatch(stageTransform(24, 36), /rotate\s*\(/u)
  assert.doesNotMatch(windowClientModule.WINDOW_JS, /rotate\s*\(/u)

  const stylesheet = readFileSync(new URL('../src/window-style.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(stylesheet, /rotate\s*\(/u)
  const stageStylesheet = readFileSync(
    new URL('../src/window-style-stage.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(stageStylesheet, /rotate\s*\(/u)
})

test('stage ground ships as exact part 43 before the legacy tail', () => {
  const source = readFileSync(
    new URL('../src/window-client/program/43-stage-ground.ts', import.meta.url), 'utf8')
  assert.match(source, /^export const PART_43_STAGE_GROUND = `  function/u)
  assert.match(source, /\n`\r?\n$/u)
  assert.ok(windowClientModule.WINDOW_JS.includes(PART_43_STAGE_GROUND))
  assert.ok(windowClientModule.WINDOW_JS.indexOf(PART_43_STAGE_GROUND) <
    windowClientModule.WINDOW_JS.indexOf(PART_39_WIRING_AND_BOOT))
  assert.match(windowClientModule.WINDOW_JS, /const canonical = movement\.geometry\.points/u)
  assert.match(windowClientModule.WINDOW_JS, /const distance = geometry\.distance/u)
  assert.match(windowClientModule.WINDOW_JS,
    /shell\.style\.animationName = 'live-recorded-route'/u)
  assert.doesNotMatch(windowClientModule.WINDOW_JS, /live-recorded-glide/u)
})

test('replay marks use the drawn room after growth reserves its former ground', () => {
  const children = Object.freeze([{ id: 8, parent_id: 1 }])
  const drawnRoom = Object.freeze({ id: 8, x: 1180, y: 1320, width: 440, height: 280 })
  const survey = Object.freeze({ plots: Object.freeze([drawnRoom]) })
  let surveyReads = 0
  const anchor = new Function(
    'stageRoomLayout', 'liveStageSurvey', 'livePlaceRows', 'state',
    `${PART_24_LIVE_REPLAY_MOTION}\nreturn liveAnchorPoint`,
  )(
    stageRoomLayout,
    () => { surveyReads += 1; return survey },
    () => children,
    { snapshot: { places: children } },
  ) as (id: number, focusId: number, rows: typeof children,
    context?: { survey: typeof survey }) => { x: number; y: number } | null
  const expected = { x: drawnRoom.x + drawnRoom.width / 2,
    y: drawnRoom.y + drawnRoom.height - 18 }
  assert.deepEqual(anchor(8, 1, children, { survey }), expected,
    'replay mark must use the drawn room rectangle after expansion')
  assert.equal(surveyReads, 0, 'a render context must reuse its existing survey')
  assert.deepEqual(anchor(8, 1, children), expected,
    'a replay started between paints must use the authoritative survey too')
  assert.equal(surveyReads, 1, 'the fallback must read one authoritative survey')
  assert.equal(anchor(99, 1, children, { survey }), null,
    'a missing room must not invent an anchor')
})

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

test('room ground is append-stable and a founded room takes fresh parent-edge ground', () => {
  const places = Object.freeze([
    Object.freeze({ id: 1, parent_id: null, name: 'the square' }),
    Object.freeze({ id: 4, parent_id: 1, name: 'first room' }),
    Object.freeze({ id: 9, parent_id: 1, name: 'second room' }),
  ])
  const founded = Object.freeze([...places,
    Object.freeze({ id: 21, parent_id: 1, name: 'founded room' })])
  const before = stageRoomLayout(places, 1)
  const after = stageRoomLayout(founded, 1)

  assert.deepEqual(stageChildPlaces(places, 1).map(place => place.id), [4, 9])
  assert.deepEqual(after.rooms['4'], before.rooms['4'], 'room 4 rectangle must not move')
  assert.deepEqual(after.rooms['9'], before.rooms['9'], 'room 9 rectangle must not move')
  assert.ok(after.rooms['21'], 'founded room 21 must receive a rectangle')
  assert.equal(after.rooms['21']?.door.side, 'left', 'founded room door faces its parent corridor')
  assert.deepEqual(places.map(place => place.id), [1, 4, 9], 'layout must not mutate the map seed')
})

test('room ground retains coordinates through removal, return, and lower-id founding', () => {
  const parent = Object.freeze({ id: 1, parent_id: null, name: 'the square' })
  const room4 = Object.freeze({ id: 4, parent_id: 1, name: 'first room' })
  const room9 = Object.freeze({ id: 9, parent_id: 1, name: 'second room' })
  const opening = stageRoomLayout(Object.freeze([parent, room4, room9]), 1)
  assert.deepEqual(stageRoomLayout(Object.freeze([room9, parent, room4]), 1), opening,
    'the first survey must be deterministic regardless of input order')
  const afterRemoval = stageRoomLayout(
    Object.freeze([parent, room9]), 1, Object.freeze([]), opening.rooms)

  assert.deepEqual(afterRemoval.rooms['9'], opening.rooms['9'],
    'removing an earlier room must not shift a surviving room')

  const lateRoom = Object.freeze({ id: 2, parent_id: 1, name: 'late lower-id room' })
  const afterFounding = stageRoomLayout(
    Object.freeze([parent, lateRoom, room9]), 1, Object.freeze([]), opening.rooms)
  assert.deepEqual(afterFounding.rooms['9'], opening.rooms['9'],
    'a late lower id must not shift an existing room')
  assert.notDeepEqual(afterFounding.rooms['2'], opening.rooms['4'],
    'a new room must not reuse a missing room coordinate')

  const roomHistory = Object.freeze({ ...opening.rooms, ...afterFounding.rooms })
  const afterReturn = stageRoomLayout(
    Object.freeze([parent, lateRoom, room4, room9]), 1, Object.freeze([]), roomHistory)
  assert.deepEqual(afterReturn.rooms['4'], opening.rooms['4'],
    'a returning room must reclaim its historical coordinate')
  assert.deepEqual(afterReturn.rooms['9'], opening.rooms['9'])
  assert.deepEqual(afterReturn.rooms['2'], afterFounding.rooms['2'])
})

test('a full room takes fresh parent-edge standing ground without moving room boxes', () => {
  const places = Object.freeze([
    Object.freeze({ id: 1, parent_id: null, name: 'the square' }),
    Object.freeze({ id: 4, parent_id: 1, name: 'first room' }),
    Object.freeze({ id: 9, parent_id: 1, name: 'second room' }),
  ])
  const layout = stageRoomLayout(places, 1)
  const before = structuredClone(layout.rooms)
  const expansions = Object.freeze([
    Object.freeze({ id: 4, residentHeight: 896, thingHeight: 320 }),
    Object.freeze({ id: 9, residentHeight: 0, thingHeight: 320 }),
  ])
  const expanded = stageExpandedGroundLayout(Object.values(layout.rooms), expansions)

  assert.deepEqual(layout.rooms, before, 'allocating standing ground must not move a room box')
  const fixed = Object.values(layout.rooms).map(room => ({
    id: String(room.id), x: room.x, y: room.y, width: room.width, height: room.height + 64,
  }))
  const regions = Object.entries(expanded.grounds).flatMap(([id, ground]) =>
    ground.regions.map((region, index) => ({ id: `${id}:${index}`, ...region })))
  for (const region of regions) {
    assert.ok(region.y + region.height <= expanded.height,
      `${region.id} must fit inside height ${expanded.height}: ${JSON.stringify(region)}`)
    for (const obstacle of [...fixed, ...regions.filter(other => other.id < region.id)]) {
      const overlaps = region.x < obstacle.x + obstacle.width &&
        region.x + region.width > obstacle.x &&
        region.y < obstacle.y + obstacle.height &&
        region.y + region.height > obstacle.y
      assert.equal(overlaps, false,
        `${region.id} ${JSON.stringify(region)} must clear ${obstacle.id} ${JSON.stringify(obstacle)}`)
    }
  }

  const founded = stageRoomLayout(Object.freeze([
    ...places,
    Object.freeze({ id: 21, parent_id: 1, name: 'founded room' }),
  ]), 1, Object.freeze(regions))
  assert.deepEqual(founded.rooms['4'], layout.rooms['4'])
  assert.deepEqual(founded.rooms['9'], layout.rooms['9'])
  const foundedRoom = founded.rooms['21']!
  for (const region of regions) {
    const overlaps = foundedRoom.x < region.x + region.width &&
      foundedRoom.x + foundedRoom.width > region.x &&
      foundedRoom.y < region.y + region.height &&
      foundedRoom.y + foundedRoom.height > region.y
    assert.equal(overlaps, false,
      `founded room ${JSON.stringify(foundedRoom)} must not move ${region.id} ${JSON.stringify(region)}`)
  }
  const retained = stageExpandedGroundLayout(
    Object.values(founded.rooms), expansions, expanded.grounds)
  assert.deepEqual(retained.grounds, expanded.grounds,
    'founding must retain every allocated extension rectangle')
})

test('hidden room extensions stay reserved through founding, growth, and return', () => {
  const parent = Object.freeze({ id: 1, parent_id: null, name: 'the square' })
  const room4 = Object.freeze({ id: 4, parent_id: 1, name: 'first room' })
  const room9 = Object.freeze({ id: 9, parent_id: 1, name: 'second room' })
  const opening = stageRoomLayout(Object.freeze([parent, room4, room9]), 1)
  const openingGround = stageExpandedGroundLayout(Object.values(opening.rooms), Object.freeze([
    Object.freeze({ id: 4, residentHeight: 160, thingHeight: 0 }),
  ]))
  const afterRemoval = stageRoomLayout(
    Object.freeze([parent, room9]), 1, Object.freeze([]), opening.rooms)
  const hiddenGround = stageExpandedGroundLayout(
    Object.values(afterRemoval.rooms), Object.freeze([]), openingGround.grounds)

  assert.equal(afterRemoval.rooms['4'], undefined, 'a hidden room must not become a visible plot')
  assert.deepEqual(hiddenGround.grounds['4'], openingGround.grounds['4'],
    'a hidden room must retain its extension history')

  const lateRoom = Object.freeze({ id: 2, parent_id: 1, name: 'late room' })
  const reservedRegions = Object.freeze(Object.values(hiddenGround.grounds)
    .flatMap(ground => ground.regions))
  const founded = stageRoomLayout(
    Object.freeze([parent, lateRoom, room9]), 1, reservedRegions, opening.rooms)
  const roomHistory = Object.freeze({ ...opening.rooms, ...founded.rooms })
  const grown = stageExpandedGroundLayout(Object.values(roomHistory), Object.freeze([
    Object.freeze({ id: 9, residentHeight: 160, thingHeight: 0 }),
  ]), hiddenGround.grounds)

  const overlaps = (
    left: Readonly<{ x: number; y: number; width: number; height: number }>,
    right: Readonly<{ x: number; y: number; width: number; height: number }>,
  ): boolean => left.x < right.x + right.width && left.x + left.width > right.x &&
    left.y < right.y + right.height && left.y + left.height > right.y
  assert.ok(!reservedRegions.some(region => overlaps(founded.rooms['2']!, region)),
    'a founded room must avoid a hidden room extension')
  assert.deepEqual(grown.grounds['4'], openingGround.grounds['4'])
  assert.ok(grown.grounds['9']?.regions.length, 'the visible room must receive new ground')
  for (const region of grown.grounds['9']?.regions || []) {
    assert.equal(overlaps(region, opening.rooms['4']!), false,
      'new ground must avoid the hidden room box')
    assert.equal(overlaps(region, openingGround.grounds['4']!.regions[0]!), false,
      'new ground must avoid the hidden room extension')
  }

  const returned = stageRoomLayout(
    Object.freeze([parent, lateRoom, room4, room9]), 1, reservedRegions, roomHistory)
  const returnedGround = stageExpandedGroundLayout(
    Object.values(roomHistory), Object.freeze([]), grown.grounds)
  assert.deepEqual(returned.rooms['4'], opening.rooms['4'])
  assert.deepEqual(returnedGround.grounds, grown.grounds)
})

test('resident arrivals choose id-deterministic free standing spots without a cell assignment', () => {
  const room = Object.freeze({ x: 0, y: 0, width: 220, height: 180 })
  const entries = Object.freeze([
    Object.freeze({ key: 'resident:19', kind: 'resident' as const }),
    Object.freeze({ key: 'thing:7', kind: 'thing' as const }),
    Object.freeze({ key: 'resident:2', kind: 'resident' as const }),
  ])
  const opening = stageFindFreeSpots(entries, room)
  const reloaded = stageFindFreeSpots(Object.freeze([...entries].reverse()), room)
  const arrivedWithHistory = stageFindFreeSpots(Object.freeze([
    ...entries,
    Object.freeze({ key: 'resident:11', kind: 'resident' as const }),
  ]), room, opening)
  const otherIdWithSameFreeSpots = stageFindFreeSpots(Object.freeze([
    ...entries,
    Object.freeze({ key: 'resident:12', kind: 'resident' as const }),
  ]), room, opening)
  const movedPresentation = Object.freeze({
    ...opening,
    'resident:19': Object.freeze({ ...opening['resident:19']!, x: 90, y: 100 }),
  })
  const retainedPresentation = stageFindFreeSpots(entries, room, movedPresentation)
  const edgeSpot = Object.freeze({
    key: 'resident:1', kind: 'resident' as const, x: 16, y: 16, width: 32, height: 32,
  })
  const retainedEdgeSpot = stageFindFreeSpots(Object.freeze([
    Object.freeze({ key: 'resident:1', kind: 'resident' as const }),
  ]), room, Object.freeze({ 'resident:1': edgeSpot }))

  assert.deepEqual(reloaded, opening, 'reload placement must depend on ids, not input order')
  assert.notDeepEqual(arrivedWithHistory['resident:11'], otherIdWithSameFreeSpots['resident:12'],
    'different arriving ids must choose from the same free spots differently')
  assert.deepEqual(retainedPresentation['resident:19'], movedPresentation['resident:19'],
    'a free presentation position must not snap back to a hidden cell')
  assert.deepEqual(retainedEdgeSpot['resident:1'], edgeSpot,
    'half a sprite of edge clearance is a valid occupied position')
  for (const key of Object.keys(opening)) {
    assert.deepEqual(arrivedWithHistory[key], opening[key],
      `${key} must remain occupied while resident 11 arrives`)
  }
  assert.deepEqual(entries.map(entry => entry.key), ['resident:19', 'thing:7', 'resident:2'])
  assert.ok(Object.values(arrivedWithHistory).every(spot =>
    !('row' in spot) && !('column' in spot)), 'standing spots must not expose a cell grid')

  const spots = Object.values(arrivedWithHistory)
  for (const [index, left] of spots.entries()) {
    assert.ok(left.x >= room.x && left.y >= room.y &&
      left.x + left.width <= room.x + room.width &&
      left.y + left.height <= room.y + room.height,
    `${left.key} ${JSON.stringify(left)} must stay inside ${JSON.stringify(room)}`)
    for (const right of spots.slice(index + 1)) {
      const overlapsWithClearance = left.x < right.x + right.width + 16 &&
        left.x + left.width + 16 > right.x &&
        left.y < right.y + right.height + 16 &&
        left.y + left.height + 16 > right.y
      assert.equal(overlapsWithClearance, false,
        `${left.key} ${JSON.stringify(left)} must clear ${right.key} ${JSON.stringify(right)}`)
    }
  }
})

test('thing spots stay fixed while residents leave and arrive', () => {
  const room = Object.freeze({ x: 12, y: 20, width: 220, height: 180 })
  const opening = stageFindFreeSpots(Object.freeze([
    Object.freeze({ key: 'resident:2', kind: 'resident' as const }),
    Object.freeze({ key: 'thing:7', kind: 'thing' as const }),
    Object.freeze({ key: 'resident:19', kind: 'resident' as const }),
  ]), room)
  const changed = stageFindFreeSpots(Object.freeze([
    Object.freeze({ key: 'thing:7', kind: 'thing' as const }),
    Object.freeze({ key: 'resident:31', kind: 'resident' as const }),
  ]), room, opening)

  assert.deepEqual(changed['thing:7'], opening['thing:7'])
  assert.ok(changed['resident:31'])
  assert.equal(changed['resident:2'], undefined)
  assert.equal(changed['resident:19'], undefined)

  const extension = Object.freeze({ x: 12, y: 240, width: 220, height: 180 })
  const extendedThing = Object.freeze({
    key: 'thing:7', kind: 'thing' as const, x: 40, y: 268, width: 32, height: 32,
  })
  const extended = stageFindFreeSpots(Object.freeze([
    Object.freeze({ key: 'thing:7', kind: 'thing' as const }),
    Object.freeze({ key: 'resident:31', kind: 'resident' as const }),
  ]), room, Object.freeze({ 'thing:7': extendedThing }), Object.freeze([extension]))
  assert.deepEqual(extended['thing:7'], extendedThing,
    'a thing on prior extension ground must not move when the room grows')
})

test('a genuinely full room grows enough for every free standing spot', () => {
  const entries = Object.freeze(Array.from({ length: 167 }, (_, index) => Object.freeze({
    key: `resident:${String(index + 1)}`,
    kind: 'resident' as const,
  })))
  const width = 440
  const height = stageStandingRoomHeight(width, entries.length, 280)
  const movedResident = Object.freeze({
    key: 'resident:1', kind: 'resident' as const, x: 50, y: 52, width: 32, height: 32,
  })
  const spots = stageFindFreeSpots(
    entries,
    Object.freeze({ x: 0, y: 0, width, height }),
    Object.freeze({ 'resident:1': movedResident }),
  )
  const ordinaryEntries = Object.freeze(entries.slice(0, 25))
  const ordinaryRoom = Object.freeze({ x: 0, y: 0, width, height: 280 })
  const ordinarySpots = stageFindFreeSpots(ordinaryEntries, ordinaryRoom)
  const crowdedEntries = Object.freeze(entries.slice(0, 30))
  const crowdedBase = stageFindFreeSpots(crowdedEntries, ordinaryRoom)
  const missingCount = crowdedEntries.length - Object.keys(crowdedBase).length
  const extensionHeight = stageStandingRoomHeight(width, missingCount, 64) + 64
  const grownSpots = stageFindFreeSpots(crowdedEntries, ordinaryRoom, Object.freeze({}),
    Object.freeze([{ x: 0, y: 360, width, height: extensionHeight }]))

  assert.equal(stageStandingRoomHeight(width, 15, 280), 280,
    'eight residents and seven things must fit the ordinary room')
  assert.equal(Object.keys(ordinarySpots).length, ordinaryEntries.length,
    'a room with actual free coordinates must not grow from a conservative count estimate')
  assert.ok(missingCount > 0, 'the crowded room must exhaust its actual free coordinates')
  assert.equal(Object.keys(grownSpots).length, crowdedEntries.length,
    'the missing occupants must fit the appended ground')
  assert.ok(height > 280, `full room height stayed ${String(height)}`)
  assert.equal(Object.keys(spots).length, entries.length)
  assert.deepEqual(spots['resident:1'], movedResident)
  assert.ok(Object.values(spots).every(spot =>
    spot.x >= 0 && spot.y >= 0 &&
    spot.x + spot.width <= width && spot.y + spot.height <= height))
})

test('corridor shortest paths use door and corner nodes and avoid a third room', () => {
  const layout = stageRoomLayout(Object.freeze([
    Object.freeze({ id: 1, parent_id: null, name: 'parent' }),
    Object.freeze({ id: 2, parent_id: 1, name: 'north' }),
    Object.freeze({ id: 3, parent_id: 1, name: 'middle' }),
    Object.freeze({ id: 4, parent_id: 1, name: 'founded south' }),
  ]), 1)
  const graph = stageBuildCorridorGraph(Object.values(layout.rooms))
  const route = stageShortestPath(graph, '2', '4')

  assert.equal(graph.roomDoors['4'], 'door:4', 'the founded room door must join the graph')
  assert.equal(route[0]?.id, 'door:2', `route start was ${JSON.stringify(route[0])}`)
  assert.equal(route.at(-1)?.id, 'door:4', `route end was ${JSON.stringify(route.at(-1))}`)
  assert.ok(route.every(node => node.kind === 'door' || node.kind === 'corner'),
    `route used only corridor nodes: ${JSON.stringify(route)}`)
  const middle = layout.rooms['3']!
  for (const [index, from] of route.entries()) {
    const to = route[index + 1]
    if (!to) continue
    const verticalCrossing = from.x > middle.x && from.x < middle.x + middle.width &&
      to.x > middle.x && to.x < middle.x + middle.width &&
      Math.min(from.y, to.y) < middle.y + middle.height &&
      Math.max(from.y, to.y) > middle.y
    const horizontalCrossing = from.y > middle.y && from.y < middle.y + middle.height &&
      to.y > middle.y && to.y < middle.y + middle.height &&
      Math.min(from.x, to.x) < middle.x + middle.width &&
      Math.max(from.x, to.x) > middle.x
    assert.equal(verticalCrossing || horizontalCrossing, false,
      `${from.id} ${JSON.stringify(from)} -> ${to.id} ${JSON.stringify(to)} crossed room 3 ${JSON.stringify(middle)}`)
  }
})

test('quiet room ground exposes identity and exact counts but no occupied spots', () => {
  const box = Object.freeze({
    id: '7', parentId: '1', x: 20, y: 30, width: 220, height: 180,
    door: Object.freeze({ x: 20, y: 120, side: 'left' as const }),
  })
  const quiet = stageQuietRoom(Object.freeze({
    id: 7, name: 'the library', owner: 'mira', quiet: true,
    counts: Object.freeze({ residents: 12, things: 8 }),
  }), box)

  assert.deepEqual(quiet, Object.freeze({
    box,
    name: 'the library',
    owner: 'mira',
    counts: Object.freeze({ residents: 12, things: 8 }),
    spots: Object.freeze([]),
  }))
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

test('detail budget keeps attention residents plus the nearest six movers with stable ties', () => {
  const movers = Object.freeze([
    Object.freeze({ actor: 'far-followed', x: 100, y: 100, order: 0 }),
    Object.freeze({ actor: 'far-hovered', x: 90, y: 90, order: 1 }),
    ...Array.from({ length: 8 }, (_, index) => Object.freeze({
      actor: `near-${String(index + 1)}`,
      x: index < 2 ? 1 : index,
      y: 0,
      order: index + 2,
    })),
  ])
  const selected = windowLiveDetailMoverSelection(
    movers,
    Object.freeze(['far-followed', 'far-hovered']),
    Object.freeze({ x: 0, y: 0 }),
    6,
  )

  assert.deepEqual(selected.detailed, [
    'far-followed', 'far-hovered',
    'near-1', 'near-2', 'near-3', 'near-4', 'near-5', 'near-6',
  ])
  assert.deepEqual(selected.simple, ['near-7', 'near-8'])
  assert.deepEqual(windowLiveDetailMoverSelection(
    [...movers].reverse(),
    Object.freeze([]),
    Object.freeze({ x: 0, y: 0 }),
    6,
  ).detailed, windowLiveDetailMoverSelection(
    movers,
    Object.freeze([]),
    Object.freeze({ x: 0, y: 0 }),
    6,
  ).detailed)
  assert.deepEqual(windowLiveDetailMoverSelection(
    movers.slice(0, 5),
    Object.freeze(['far-followed', 'far-hovered']),
    Object.freeze({ x: 0, y: 0 }),
    6,
  ).simple, [])
})

test('detail budget caps oversized attention so footsteps stay within 18 marks', () => {
  const movers = Object.freeze(Array.from({ length: 12 }, (_, index) => Object.freeze({
    actor: `resident-${String(index + 1)}`,
    x: index,
    y: 0,
    order: index,
  })))
  const selected = windowLiveDetailMoverSelection(
    movers,
    Object.freeze(movers.slice(6).map(mover => mover.actor)),
    Object.freeze({ x: 0, y: 0 }),
    6,
  )

  assert.deepEqual(selected.detailed, [
    'resident-7', 'resident-8', 'resident-9',
    'resident-1', 'resident-2', 'resident-3',
    'resident-4', 'resident-5', 'resident-6',
  ])
  assert.equal(selected.detailed.length * 2, 18)
})

test('detail budget keeps the followed resident when attention is oversized', () => {
  const movers = Object.freeze(Array.from({ length: 5 }, (_, index) => Object.freeze({
    actor: `attention-${String(index + 1)}`,
    x: index,
    y: 0,
    order: index,
  })))
  const selected = windowLiveDetailMoverSelection(
    movers,
    Object.freeze(movers.map(mover => mover.actor)),
    Object.freeze({ x: 0, y: 0 }),
    0,
  )

  assert.equal(selected.detailed.includes('attention-1'), true)
})

test('stage loop keeps scheduling while visible and stops when hidden or inactive', () => {
  const visibleStage = Object.freeze({
    liveViewActive: true,
    documentVisible: true,
    panelVisible: true,
    framePending: false,
  })

  assert.equal(windowLiveShouldScheduleRedraw(visibleStage), true)
  assert.equal(windowLiveShouldScheduleRedraw({ ...visibleStage, documentVisible: false }), false)
  assert.equal(windowLiveShouldScheduleRedraw({ ...visibleStage, panelVisible: false }), false)
  assert.equal(windowLiveShouldScheduleRedraw({ ...visibleStage, liveViewActive: false }), false)
  assert.equal(windowLiveShouldScheduleRedraw({ ...visibleStage, framePending: true }), false)
})

test('route visibility returns exact progress windows for camera crossings', () => {
  const viewport = Object.freeze({ left: 0, top: 0, right: 100, bottom: 100 })
  assert.deepEqual(windowLiveRouteVisibilityIntervals(Object.freeze([
    Object.freeze({ x: -100, y: 50 }),
    Object.freeze({ x: 200, y: 50 }),
  ]), viewport), [Object.freeze({ start: 1 / 3, end: 2 / 3 })])
  assert.deepEqual(windowLiveRouteVisibilityIntervals(Object.freeze([
    Object.freeze({ x: -20, y: -20 }),
    Object.freeze({ x: -10, y: -10 }),
  ]), viewport), [])
})

test('footstep beat emits at cadence and its two-second lifetime expires exactly', () => {
  assert.deepEqual(windowLiveFootstepBeat(1_000, 0, 3_100), {
    due: true,
    first: true,
    nextAt: 3_100,
  })
  assert.deepEqual(windowLiveFootstepBeat(3_000, 2, 3_100), {
    due: false,
    first: false,
    nextAt: 3_650,
  })
  assert.equal(windowLiveTraceOpacity(1_000, 2_999, 2_000) > 0, true)
  assert.equal(windowLiveTraceOpacity(1_000, 3_000, 2_000), 0)
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

// Round 1 review, finding #1 (HIGH): windowLiveItemPopoverPlacement could
// render the popover entirely outside #live-viewport for an anchor the
// camera has left off-screen -- reproduced live on the deployed preview at
// 375x812 by hovering/focusing a resident not currently framed by the
// camera, which is the normal state for most residents on any plate wider
// than the viewport. Pinned here with the exact shape of that reproduction
// (anchor.left far past viewport.right) and with the containment invariant
// checked explicitly rather than only the never-covers-anchor one, since a
// null primary axis passed that check while still rendering off-screen.
test('windowLiveItemPopoverPlacement stays fully inside the viewport for an anchor the camera has left entirely off-screen', () => {
  const viewport = Object.freeze({ left: 0, top: 0, right: 349, bottom: 812 })
  const size = Object.freeze({ width: 260, height: 96 })
  const offCameraAnchors = [
    Object.freeze({ left: 608, top: 300, right: 706, bottom: 320 }), // right of viewport
    Object.freeze({ left: -700, top: 300, right: -600, bottom: 320 }), // left of viewport
    Object.freeze({ left: 100, top: -900, right: 120, bottom: -880 }), // above viewport
    Object.freeze({ left: 100, top: 1800, right: 120, bottom: 1820 }), // below viewport
    Object.freeze({ left: -700, top: -900, right: -680, bottom: -880 }), // above-left, diagonal
  ]
  for (const anchor of offCameraAnchors) {
    const placement = windowLiveItemPopoverPlacement(anchor, size, viewport, 10, 8)
    assert.ok(placement, JSON.stringify(anchor))
    assert.ok(placement!.left >= 8, JSON.stringify(anchor))
    assert.ok(placement!.left + size.width <= 349 - 8, JSON.stringify(anchor))
    assert.ok(placement!.top >= 8, JSON.stringify(anchor))
    assert.ok(placement!.top + size.height <= 812 - 8, JSON.stringify(anchor))
    // An anchor entirely outside the viewport can never be reached by a
    // placement fully contained inside it, so containment and
    // never-covers-anchor both hold at once here, not just containment.
    const absoluteLeft = placement!.left + viewport.left
    const absoluteTop = placement!.top + viewport.top
    const intersects = absoluteLeft < anchor.right && absoluteLeft + size.width > anchor.left &&
      absoluteTop < anchor.bottom && absoluteTop + size.height > anchor.top
    assert.equal(intersects, false, JSON.stringify(anchor))
  }
})

test('windowLiveItemPopoverPlacement keeps a 320px popover inside a 375x812 viewport for anchors at every corner and edge, on camera and off', () => {
  const viewport = Object.freeze({ left: 0, top: 0, right: 375, bottom: 812 })
  const size = Object.freeze({ width: 320, height: 160 })
  const anchors = [
    Object.freeze({ left: 0, top: 0, right: 20, bottom: 20 }), // top-left
    Object.freeze({ left: 355, top: 0, right: 375, bottom: 20 }), // top-right
    Object.freeze({ left: 0, top: 792, right: 20, bottom: 812 }), // bottom-left
    Object.freeze({ left: 355, top: 792, right: 375, bottom: 812 }), // bottom-right
    Object.freeze({ left: 177, top: 396, right: 197, bottom: 416 }), // centre
    Object.freeze({ left: 175, top: 0, right: 195, bottom: 20 }), // top edge, mid
    Object.freeze({ left: 175, top: 792, right: 195, bottom: 812 }), // bottom edge, mid
    Object.freeze({ left: -600, top: -600, right: -580, bottom: -580 }), // off top-left
    Object.freeze({ left: 900, top: -600, right: 920, bottom: -580 }), // off top-right
    Object.freeze({ left: -600, top: 1400, right: -580, bottom: 1420 }), // off bottom-left
    Object.freeze({ left: 900, top: 1400, right: 920, bottom: 1420 }), // off bottom-right
  ]
  for (const anchor of anchors) {
    const placement = windowLiveItemPopoverPlacement(anchor, size, viewport, 10, 8)
    assert.ok(placement, JSON.stringify(anchor))
    assert.ok(placement!.left >= 8, JSON.stringify(anchor))
    assert.ok(placement!.left + size.width <= 375 - 8, JSON.stringify(anchor))
    assert.ok(placement!.top >= 8, JSON.stringify(anchor))
    assert.ok(placement!.top + size.height <= 812 - 8, JSON.stringify(anchor))
  }
})

test('windowLiveItemPopoverPlacement prefers containment over avoiding the anchor when both cannot hold, and never returns NaN', () => {
  // A tiny viewport almost entirely covered by its own anchor leaves no
  // position that is both fully contained and anchor-free. The rule
  // documented on the function is that containment wins: the placement
  // must still land inside the viewport even though it may then overlap
  // the anchor a little.
  const viewport = Object.freeze({ left: 0, top: 0, right: 100, bottom: 100 })
  const size = Object.freeze({ width: 60, height: 60 })
  const anchor = Object.freeze({ left: 10, top: 10, right: 90, bottom: 90 })
  const placement = windowLiveItemPopoverPlacement(anchor, size, viewport, 5, 2)
  assert.ok(placement)
  assert.ok(placement!.left >= 2)
  assert.ok(placement!.left + size.width <= 100 - 2)
  assert.ok(placement!.top >= 2)
  assert.ok(placement!.top + size.height <= 100 - 2)

  // A popover wider than the whole viewport is a degenerate but valid
  // input (never non-finite, never zero-area) -- it must still fail closed
  // to a deterministic, finite position rather than throwing or landing at
  // NaN.
  const wideSize = Object.freeze({ width: 500, height: 160 })
  const narrowViewport = Object.freeze({ left: 0, top: 0, right: 375, bottom: 812 })
  const smallAnchor = Object.freeze({ left: 150, top: 300, right: 170, bottom: 320 })
  const widePlacement = windowLiveItemPopoverPlacement(smallAnchor, wideSize, narrowViewport, 10, 8)
  assert.ok(widePlacement)
  assert.ok(Number.isFinite(widePlacement!.left))
  assert.ok(Number.isFinite(widePlacement!.top))
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
