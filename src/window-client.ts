import { PUBLIC_EVENT_KINDS, PUBLIC_EVENT_LABELS } from './public-events.ts'
import { WINDOW_CLIENT_PARTS } from './window-client/program/index.ts'

export { PUBLIC_EVENT_KINDS, PUBLIC_EVENT_LABELS }

// The human window's client program was split out of this file in Phase 1 of
// issue #79 (see docs/DRAWING_AND_LIVE_VIEW.md for the fragment layout and
// the byte-identity proof). This file survives as a facade: it re-exports
// every helper under its original name so every existing import path keeps
// working, and assembles WINDOW_JS from the ordered program parts.

export {
  normalizeWindowDrawing,
  windowDrawingStateLabel,
  windowDrawingSourceLabel,
} from './window-client/drawing.ts'
export type {
  WindowDrawing,
  WindowDrawingState,
  WindowDrawingSource,
} from './window-client/drawing.ts'

export {
  stageAssignCells,
  stageBuildCorridorGraph,
  stageCellRoomHeight,
  stageChildPlaces,
  stageExpandedGroundLayout,
  stageQuietRoom,
  stageRoomLayout,
  stageShortestPath,
  STAGE_PARENT_ROOM_HEIGHT,
  STAGE_ROOM_DRAWING_CONTROL_RECT,
} from './window-client/stage-ground.ts'
export type {
  StageCell,
  StageCellEntry,
  StageCorridorGraph,
  StageCorridorNode,
  StageExpandedGround,
  StageGroundPlace,
  StageRoomBox,
} from './window-client/stage-ground.ts'

export {
  windowLiveTouchActivation,
  windowLiveVisiblePlots,
  windowLiveVisiblePlotIds,
  windowLiveFloorTiling,
  windowLiveFloorAccessibleLabel,
  windowLiveDirectGroundWidth,
  windowLiveCapacitySelection,
} from './window-client/live-visibility.ts'
export type { WindowLiveFloorDrawingEntry } from './window-client/live-visibility.ts'

export {
  windowLiveCenterCamera,
  windowLiveRevealCamera,
  windowLiveClampZoomScale,
  windowLiveResidentLabelMode,
} from './window-client/live-camera.ts'

export {
  windowLivePollDelay,
  windowLiveTraceOpacity,
  windowLivePruneTrailStarts,
  windowLiveDetailMoverSelection,
  windowLiveRouteVisibilityIntervals,
  windowLiveShouldScheduleRedraw,
  windowLiveFootstepBeat,
  windowLiveReplayDuration,
  windowLiveReplayPace,
  windowLiveReplayStartOffsets,
  windowLiveReplayOrder,
  windowLiveSpeechLine,
} from './window-client/live-replay.ts'

export {
  parseWindowSleeperPlaceIds,
  mergeWindowRows,
  mergeResidentRows,
  windowPlaceLabel,
} from './window-client/rows.ts'

export {
  windowDirectoryPlaceScopeIds,
  deriveWindowDirectoryPlaces,
  listWindowDirectoryPlaces,
  searchWindowDirectory,
  pageWindowDirectorySearch,
} from './window-client/directory.ts'
export type {
  WindowDirectoryPlace,
  WindowDirectoryPlaceWithPath,
  WindowDirectoryPlaceOption,
  WindowDirectoryResident,
  WindowDirectorySearchResult,
  WindowDirectorySearchPage,
} from './window-client/directory.ts'

export {
  windowLiveItemFacts,
  windowLiveItemLastAction,
  windowLiveItemPopoverPlacement,
} from './window-client/live-popover.ts'
export type {
  WindowLiveItemKind,
  WindowLiveCachedDrawing,
  WindowLiveItemFactsResident,
  WindowLiveItemFactsThing,
  WindowLiveItemFactsPlace,
  WindowLiveItemFactsContext,
  WindowLiveItemFactsResult,
  WindowLiveItemRecord,
  WindowLiveRect,
  WindowLiveSize,
  WindowLiveItemPopoverSide,
  WindowLiveItemPopoverPlacement,
} from './window-client/live-popover.ts'

export { normalizeLiveNotesPage } from './window-client/live-notes.ts'
export type { WindowLiveNote, WindowLiveNotesPage } from './window-client/live-notes.ts'

export {
  stageNodeKey,
  reconcileStageNodeKeys,
  stageDrawnNodeKeys,
  stageFacing,
  stageTransform,
} from './window-client/stage-nodes.ts'
export type { StageNodeKind, StageNodeDiff } from './window-client/stage-nodes.ts'

export const WINDOW_JS = WINDOW_CLIENT_PARTS.join('')
