import { WORLD_ROOT_NAME } from '../../world-root.ts'
import { BASIC_ACTIONS } from '../../physics.ts'
import {
  PUBLIC_EVENT_DETAIL_ID_FIELDS,
  PUBLIC_EVENT_LABELS,
  PUBLIC_SYSTEM_EVENT_ACTORS,
} from '../../public-events.ts'
import { containsMalformedPublicText } from '../../input.ts'
import {
  validateWindowArchiveQuery,
  validateWindowDirectorySearch,
  windowDetailShareState,
  windowSharePath,
  windowShareTargetPath,
} from '../../window-sharing.ts'
import {
  normalizeWindowDrawing,
  windowDrawingStateLabel,
  windowDrawingSourceLabel,
} from '../drawing.ts'
import {
  windowLivePlateChildren,
  WINDOW_LIVE_DIRECT_COMMONS_WIDTH,
  WINDOW_LIVE_DIRECT_COMMONS_HEIGHT,
  WINDOW_LIVE_CHILD_GROUND_GAP,
  windowLiveSurveyedPlots,
  windowLiveExpandedGroundLayout,
  windowLiveScatteredPoint,
  windowLiveScatteredPoints,
  windowLiveScatterSurfaceHeight,
} from '../live-ground.ts'
import {
  windowLiveSeparatedPoints,
  WINDOW_LIVE_PLOT_DRAWING_DETAIL_RECT,
  windowLivePointFootprints,
  windowLiveRootReservations,
  windowLiveResidentPointsAroundThings,
  windowLiveThingPointsAroundResidents,
} from '../live-scatter.ts'
import {
  windowLiveTouchActivation,
  windowLiveVisiblePlots,
  windowLiveVisiblePlotIds,
  windowLiveFloorTiling,
  windowLiveFloorAccessibleLabel,
  windowLiveDirectGroundWidth,
  windowLiveCapacitySelection,
} from '../live-visibility.ts'
import {
  windowLiveCenterCamera,
  windowLiveRevealCamera,
  windowLiveClampZoomScale,
  windowLiveResidentLabelMode,
} from '../live-camera.ts'
import {
  windowLivePollDelay,
  windowLiveTraceOpacity,
  windowLivePruneTrailStarts,
  windowLiveSelectTrailKeys,
  windowLiveReplayDuration,
  windowLiveReplayPace,
  windowLiveReplayStartOffsets,
  windowLiveReplayOrder,
  windowLiveSpeechLine,
} from '../live-replay.ts'
import {
  parseWindowSleeperPlaceIds,
  mergeWindowRows,
  mergeResidentRows,
  windowPlaceLabel,
} from '../rows.ts'
import {
  windowDirectoryPlaceScopeIds,
  deriveWindowDirectoryPlaces,
  listWindowDirectoryPlaces,
  searchWindowDirectory,
  pageWindowDirectorySearch,
} from '../directory.ts'
import {
  windowLiveItemFacts,
  windowLiveItemLastAction,
  windowLiveItemPopoverPlacement,
} from '../live-popover.ts'
const PUBLIC_EVENT_LABELS_JSON = JSON.stringify(PUBLIC_EVENT_LABELS)
const PUBLIC_EVENT_DETAIL_ID_FIELDS_JSON = JSON.stringify(PUBLIC_EVENT_DETAIL_ID_FIELDS)
const PUBLIC_SYSTEM_EVENT_ACTORS_JSON = JSON.stringify(Object.values(PUBLIC_SYSTEM_EVENT_ACTORS))
const BASIC_ACTIONS_JSON = JSON.stringify(BASIC_ACTIONS)
const WORLD_ROOT_NAME_JSON = JSON.stringify(WORLD_ROOT_NAME)
const MERGE_WINDOW_ROWS_JS = mergeWindowRows.toString()
const MERGE_RESIDENT_ROWS_JS = mergeResidentRows.toString()
const WINDOW_PLACE_LABEL_JS = windowPlaceLabel.toString()
const DERIVE_WINDOW_DIRECTORY_PLACES_JS = deriveWindowDirectoryPlaces.toString()
const LIST_WINDOW_DIRECTORY_PLACES_JS = listWindowDirectoryPlaces.toString()
const SEARCH_WINDOW_DIRECTORY_JS = searchWindowDirectory.toString()
const PAGE_WINDOW_DIRECTORY_SEARCH_JS = pageWindowDirectorySearch.toString()
const WINDOW_DIRECTORY_PLACE_SCOPE_IDS_JS = windowDirectoryPlaceScopeIds.toString()
const PARSE_WINDOW_SLEEPER_PLACE_IDS_JS = parseWindowSleeperPlaceIds.toString()
const CONTAINS_MALFORMED_PUBLIC_TEXT_JS = containsMalformedPublicText.toString()
const VALIDATE_WINDOW_ARCHIVE_QUERY_JS = validateWindowArchiveQuery.toString()
const VALIDATE_WINDOW_DIRECTORY_SEARCH_JS = validateWindowDirectorySearch.toString()
const WINDOW_DETAIL_SHARE_STATE_JS = windowDetailShareState.toString()
const WINDOW_SHARE_PATH_JS = windowSharePath.toString()
const WINDOW_SHARE_TARGET_PATH_JS = windowShareTargetPath.toString()
const NORMALIZE_WINDOW_DRAWING_JS = normalizeWindowDrawing.toString()
const WINDOW_DRAWING_STATE_LABEL_JS = windowDrawingStateLabel.toString()
const WINDOW_DRAWING_SOURCE_LABEL_JS = windowDrawingSourceLabel.toString()
const WINDOW_LIVE_PLATE_CHILDREN_JS = windowLivePlateChildren.toString()
const WINDOW_LIVE_SURVEYED_PLOTS_JS = windowLiveSurveyedPlots.toString()
const WINDOW_LIVE_EXPANDED_GROUND_LAYOUT_JS = windowLiveExpandedGroundLayout.toString()
const WINDOW_LIVE_SCATTERED_POINT_JS = windowLiveScatteredPoint.toString()
const WINDOW_LIVE_SCATTERED_POINTS_JS = windowLiveScatteredPoints.toString()
const WINDOW_LIVE_SCATTER_SURFACE_HEIGHT_JS = windowLiveScatterSurfaceHeight.toString()
const WINDOW_LIVE_SEPARATED_POINTS_JS = windowLiveSeparatedPoints.toString()
const WINDOW_LIVE_POINT_FOOTPRINTS_JS = windowLivePointFootprints.toString()
const WINDOW_LIVE_ROOT_RESERVATIONS_JS = windowLiveRootReservations.toString()
const WINDOW_LIVE_RESIDENT_POINTS_AROUND_THINGS_JS =
  windowLiveResidentPointsAroundThings.toString()
const WINDOW_LIVE_THING_POINTS_AROUND_RESIDENTS_JS =
  windowLiveThingPointsAroundResidents.toString()
const WINDOW_LIVE_VISIBLE_PLOTS_JS = windowLiveVisiblePlots.toString()
const WINDOW_LIVE_VISIBLE_PLOT_IDS_JS = windowLiveVisiblePlotIds.toString()
const WINDOW_LIVE_FLOOR_TILING_JS = windowLiveFloorTiling.toString()
const WINDOW_LIVE_FLOOR_ACCESSIBLE_LABEL_JS = windowLiveFloorAccessibleLabel.toString()
const WINDOW_LIVE_DIRECT_GROUND_WIDTH_JS = windowLiveDirectGroundWidth.toString()
const WINDOW_LIVE_CAPACITY_SELECTION_JS = windowLiveCapacitySelection.toString()
const WINDOW_LIVE_POLL_DELAY_JS = windowLivePollDelay.toString()
const WINDOW_LIVE_TRACE_OPACITY_JS = windowLiveTraceOpacity.toString()
const WINDOW_LIVE_CENTER_CAMERA_JS = windowLiveCenterCamera.toString()
const WINDOW_LIVE_REVEAL_CAMERA_JS = windowLiveRevealCamera.toString()
const WINDOW_LIVE_CLAMP_ZOOM_SCALE_JS = windowLiveClampZoomScale.toString()
const WINDOW_LIVE_RESIDENT_LABEL_MODE_JS = windowLiveResidentLabelMode.toString()
const WINDOW_LIVE_PRUNE_TRAIL_STARTS_JS = windowLivePruneTrailStarts.toString()
const WINDOW_LIVE_SELECT_TRAIL_KEYS_JS = windowLiveSelectTrailKeys.toString()
const WINDOW_LIVE_REPLAY_DURATION_JS = windowLiveReplayDuration.toString()
const WINDOW_LIVE_REPLAY_PACE_JS = windowLiveReplayPace.toString()
const WINDOW_LIVE_REPLAY_START_OFFSETS_JS = windowLiveReplayStartOffsets.toString()
const WINDOW_LIVE_REPLAY_ORDER_JS = windowLiveReplayOrder.toString()
const WINDOW_LIVE_SPEECH_LINE_JS = windowLiveSpeechLine.toString()
const WINDOW_LIVE_TOUCH_ACTIVATION_JS = windowLiveTouchActivation.toString()
const WINDOW_LIVE_ITEM_FACTS_JS = windowLiveItemFacts.toString()
const WINDOW_LIVE_ITEM_LAST_ACTION_JS = windowLiveItemLastAction.toString()
const WINDOW_LIVE_ITEM_POPOVER_PLACEMENT_JS = windowLiveItemPopoverPlacement.toString()
const WINDOW_LIVE_PLOT_DRAWING_DETAIL_RECT_JSON = JSON.stringify(
  WINDOW_LIVE_PLOT_DRAWING_DETAIL_RECT,
)
const WINDOW_LIVE_DIRECT_COMMONS_WIDTH_JSON = JSON.stringify(WINDOW_LIVE_DIRECT_COMMONS_WIDTH)
const WINDOW_LIVE_DIRECT_COMMONS_HEIGHT_JSON = JSON.stringify(WINDOW_LIVE_DIRECT_COMMONS_HEIGHT)
const WINDOW_LIVE_CHILD_GROUND_GAP_JSON = JSON.stringify(WINDOW_LIVE_CHILD_GROUND_GAP)

export const PART_01_PRELUDE = `(() => {
  'use strict'

  const BASE_REFRESH_MS = 60000
  const MAX_REFRESH_MS = 300000
  const LIVE_MOVE_LIFETIME_MS = 1800000
  const LIVE_NOTE_LIFETIME_MS = 600000
  const LIVE_TRAIL_LIFETIME_MS = 4_500
  const LIVE_ABSORPTION_MS = 900
  const LIVE_PULSE_MS = 600
  const LIVE_NOTE_REPLAY_MS = 650
  const LIVE_NOTE_FETCH_CONCURRENCY = 4
  const LIVE_NOTE_QUEUE_LIMIT = 16
  // The thumb route's native size: an 8x8 grid at 4x nearest-neighbour
  // scaling (docs/DRAWING_AND_LIVE_VIEW.md). Floor tiles repeat this exact
  // cached PNG rather than reading the full JSON drawing and painting a
  // canvas.
  const LIVE_FLOOR_TILE_SIZE = 32
  const LIVE_OPENING_PAGE_LIMIT = 200
  const LIVE_REPLAY_BACKLOG_LIMIT = LIVE_OPENING_PAGE_LIMIT
  const LIVE_PORTRAIT_LIMIT = 6
  const LIVE_THING_LIMIT = 6
  const LIVE_FOCUS_STORAGE_KEY = '1f3d9:window:live-focus'
  const LIVE_CAMERA_MIN_SCALE = 0.8
  const LIVE_CAMERA_CENTER_SCALE = 1
  const LIVE_CAMERA_MAX_SCALE = 2.2
  const LIVE_CAMERA_SAFE_INSET = 16
  const WINDOW_LIVE_DIRECT_COMMONS_WIDTH = ${WINDOW_LIVE_DIRECT_COMMONS_WIDTH_JSON}
  const WINDOW_LIVE_DIRECT_COMMONS_HEIGHT = ${WINDOW_LIVE_DIRECT_COMMONS_HEIGHT_JSON}
  const WINDOW_LIVE_CHILD_GROUND_GAP = ${WINDOW_LIVE_CHILD_GROUND_GAP_JSON}
  const LIVE_DIRECT_GROUND_WIDTH = WINDOW_LIVE_DIRECT_COMMONS_WIDTH
  const LIVE_LABEL_READABLE_SCALE = 1.6
  const LIVE_LABEL_FULL_REFRESH_MS = 250
  const LIVE_LABEL_CONTINUOUS_LIMIT = 12
  const LIVE_PLOT_OVERSCAN = 160
  const LIVE_PLOT_DRAWING_DETAIL_RECT = Object.freeze(
    ${WINDOW_LIVE_PLOT_DRAWING_DETAIL_RECT_JSON})
  const LIVE_TRAIL_DOM_LIMIT = 96
  // Step 4: the single reusable Live item popover's clear space from the
  // sprite it describes, and its minimum inset from the live viewport edge.
  const LIVE_ITEM_POPOVER_GAP = 10
  const LIVE_ITEM_POPOVER_MARGIN = 8
  const REQUEST_TIMEOUT_MS = 10000
  const MAX_FORWARD_RECONCILE_PAGES = 8
  const MAX_AUTO_HISTORY_PAGES = 8
  const GAZETTE_ISSUE_PAGE_LIMIT = 10
  const GAZETTE_ENTRY_PAGE_LIMIT = 25
  const GAZETTE_FIRST_PRINT_AT = '2026-08-31T16:00:00.000Z'
  const GAZETTE_FIRST_PRINT_EMPTY_STATE = 'No Gazette issues have printed yet. The first print is scheduled for Monday, 31 August 2026 at 16:00 UTC.'
  const SAFE_HANDLE = /^[a-z0-9][a-z0-9-]{2,31}$/
  const SAFE_WORLD_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
  const MODERATED_TEXT = '[removed by maintainer]'
  const WORLD_ROOT_NAME = ${WORLD_ROOT_NAME_JSON}
  const VIEWS = Object.freeze([
    'map', 'live', 'things', 'place', 'conversations', 'happenings', 'agreements', 'archive', 'gazette',
  ])
  const SAFE_EVENT_KINDS = new Map(Object.entries(${PUBLIC_EVENT_LABELS_JSON}))
  const SAFE_EVENT_DETAIL_IDS = Object.freeze(${PUBLIC_EVENT_DETAIL_ID_FIELDS_JSON})
  const SAFE_SYSTEM_EVENT_ACTORS = new Set(${PUBLIC_SYSTEM_EVENT_ACTORS_JSON})
  const SAFE_ACTIONS = new Set(${BASIC_ACTIONS_JSON})
  const SAFE_ACTION_STATUSES = new Set(['applied', 'blocked', 'noop', 'failed'])
  const SAFE_EFFECT_STATUSES = new Set(['applied', 'skipped', 'failed'])
  const EVENT_ERROR_LIMIT = 500
  const UNSAFE_EVENT_ERROR = 'the recorded cause could not be shown safely'
  const LIVE_MOTION_PREFERENCE = window.matchMedia('(prefers-reduced-motion: reduce)')
  const mergeWindowRows = ${MERGE_WINDOW_ROWS_JS}
  const mergeResidentRows = ${MERGE_RESIDENT_ROWS_JS}
  const windowPlaceLabel = ${WINDOW_PLACE_LABEL_JS}
  const deriveWindowDirectoryPlaces = ${DERIVE_WINDOW_DIRECTORY_PLACES_JS}
  const listWindowDirectoryPlaces = ${LIST_WINDOW_DIRECTORY_PLACES_JS}
  const searchWindowDirectory = ${SEARCH_WINDOW_DIRECTORY_JS}
  const pageWindowDirectorySearch = ${PAGE_WINDOW_DIRECTORY_SEARCH_JS}
  const windowDirectoryPlaceScopeIds = ${WINDOW_DIRECTORY_PLACE_SCOPE_IDS_JS}
  const parseWindowSleeperPlaceIds = ${PARSE_WINDOW_SLEEPER_PLACE_IDS_JS}
  const containsMalformedPublicText = ${CONTAINS_MALFORMED_PUBLIC_TEXT_JS}
  const validateWindowArchiveQuery = ${VALIDATE_WINDOW_ARCHIVE_QUERY_JS}
  const validateWindowDirectorySearch = ${VALIDATE_WINDOW_DIRECTORY_SEARCH_JS}
  const windowDetailShareState = ${WINDOW_DETAIL_SHARE_STATE_JS}
  const windowSharePath = ${WINDOW_SHARE_PATH_JS}
  const windowShareTargetPath = ${WINDOW_SHARE_TARGET_PATH_JS}
  const normalizeWindowDrawing = ${NORMALIZE_WINDOW_DRAWING_JS}
  const windowDrawingStateLabel = ${WINDOW_DRAWING_STATE_LABEL_JS}
  const windowDrawingSourceLabel = ${WINDOW_DRAWING_SOURCE_LABEL_JS}
  const windowLivePlateChildren = ${WINDOW_LIVE_PLATE_CHILDREN_JS}
  const windowLiveSurveyedPlots = ${WINDOW_LIVE_SURVEYED_PLOTS_JS}
  const windowLiveExpandedGroundLayout = ${WINDOW_LIVE_EXPANDED_GROUND_LAYOUT_JS}
  const windowLiveScatteredPoint = ${WINDOW_LIVE_SCATTERED_POINT_JS}
  const windowLiveScatteredPoints = ${WINDOW_LIVE_SCATTERED_POINTS_JS}
  const windowLiveScatterSurfaceHeight = ${WINDOW_LIVE_SCATTER_SURFACE_HEIGHT_JS}
  const windowLiveSeparatedPoints = ${WINDOW_LIVE_SEPARATED_POINTS_JS}
  const windowLivePointFootprints = ${WINDOW_LIVE_POINT_FOOTPRINTS_JS}
  const windowLiveRootReservations = ${WINDOW_LIVE_ROOT_RESERVATIONS_JS}
  const windowLiveResidentPointsAroundThings =
    ${WINDOW_LIVE_RESIDENT_POINTS_AROUND_THINGS_JS}
  const windowLiveThingPointsAroundResidents =
    ${WINDOW_LIVE_THING_POINTS_AROUND_RESIDENTS_JS}
  const windowLiveVisiblePlots = ${WINDOW_LIVE_VISIBLE_PLOTS_JS}
  const windowLiveVisiblePlotIds = ${WINDOW_LIVE_VISIBLE_PLOT_IDS_JS}
  const windowLiveFloorTiling = ${WINDOW_LIVE_FLOOR_TILING_JS}
  const windowLiveFloorAccessibleLabel = ${WINDOW_LIVE_FLOOR_ACCESSIBLE_LABEL_JS}
  const windowLiveDirectGroundWidth = ${WINDOW_LIVE_DIRECT_GROUND_WIDTH_JS}
  const windowLiveCapacitySelection = ${WINDOW_LIVE_CAPACITY_SELECTION_JS}
  const windowLivePollDelay = ${WINDOW_LIVE_POLL_DELAY_JS}
  const windowLiveTraceOpacity = ${WINDOW_LIVE_TRACE_OPACITY_JS}
  const windowLiveCenterCamera = ${WINDOW_LIVE_CENTER_CAMERA_JS}
  const windowLiveRevealCamera = ${WINDOW_LIVE_REVEAL_CAMERA_JS}
  const windowLiveClampZoomScale = ${WINDOW_LIVE_CLAMP_ZOOM_SCALE_JS}
  const windowLiveResidentLabelMode = ${WINDOW_LIVE_RESIDENT_LABEL_MODE_JS}
  const windowLivePruneTrailStarts = ${WINDOW_LIVE_PRUNE_TRAIL_STARTS_JS}
  const windowLiveSelectTrailKeys = ${WINDOW_LIVE_SELECT_TRAIL_KEYS_JS}
  const windowLiveReplayDuration = ${WINDOW_LIVE_REPLAY_DURATION_JS}
  const windowLiveReplayPace = ${WINDOW_LIVE_REPLAY_PACE_JS}
  const windowLiveReplayStartOffsets = ${WINDOW_LIVE_REPLAY_START_OFFSETS_JS}
  const windowLiveReplayOrder = ${WINDOW_LIVE_REPLAY_ORDER_JS}
  const windowLiveSpeechLine = ${WINDOW_LIVE_SPEECH_LINE_JS}
  const windowLiveTouchActivation = ${WINDOW_LIVE_TOUCH_ACTIVATION_JS}
  const windowLiveItemFacts = ${WINDOW_LIVE_ITEM_FACTS_JS}
  const windowLiveItemLastAction = ${WINDOW_LIVE_ITEM_LAST_ACTION_JS}
  const windowLiveItemPopoverPlacement = ${WINDOW_LIVE_ITEM_POPOVER_PLACEMENT_JS}

`
