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
  WINDOW_VIEWER_OPEN_STORAGE_KEY,
  parseWindowViewerOpenKeys,
} from '../viewer-state.ts'
import { createNoteDecodingHelpers } from '../note-decoding.ts'
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
const WINDOW_VIEWER_OPEN_STORAGE_KEY_JSON = JSON.stringify(WINDOW_VIEWER_OPEN_STORAGE_KEY)
const PARSE_WINDOW_VIEWER_OPEN_KEYS_JS = parseWindowViewerOpenKeys.toString()
const CREATE_NOTE_DECODING_HELPERS_JS = createNoteDecodingHelpers.toString()


export const PART_01_PRELUDE = `(() => {
  'use strict'

  const BASE_REFRESH_MS = 60000
  const MAX_REFRESH_MS = 300000
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
    'map', 'things', 'place', 'conversations', 'happenings', 'agreements', 'archive', 'gazette',
  ])
  const SAFE_EVENT_KINDS = new Map(Object.entries(${PUBLIC_EVENT_LABELS_JSON}))
  const SAFE_EVENT_DETAIL_IDS = Object.freeze(${PUBLIC_EVENT_DETAIL_ID_FIELDS_JSON})
  const SAFE_SYSTEM_EVENT_ACTORS = new Set(${PUBLIC_SYSTEM_EVENT_ACTORS_JSON})
  const SAFE_ACTIONS = new Set(${BASIC_ACTIONS_JSON})
  const SAFE_ACTION_STATUSES = new Set(['applied', 'blocked', 'noop', 'failed'])
  const SAFE_EFFECT_STATUSES = new Set(['applied', 'skipped', 'failed'])
  const EVENT_ERROR_LIMIT = 500
  const UNSAFE_EVENT_ERROR = 'the recorded cause could not be shown safely'
  const mergeWindowRows = ${MERGE_WINDOW_ROWS_JS}
  const mergeResidentRows = ${MERGE_RESIDENT_ROWS_JS}
  const windowPlaceLabel = ${WINDOW_PLACE_LABEL_JS}
  const deriveWindowDirectoryPlaces = ${DERIVE_WINDOW_DIRECTORY_PLACES_JS}
  const listWindowDirectoryPlaces = ${LIST_WINDOW_DIRECTORY_PLACES_JS}
  const searchWindowDirectory = ${SEARCH_WINDOW_DIRECTORY_JS}
  const pageWindowDirectorySearch = ${PAGE_WINDOW_DIRECTORY_SEARCH_JS}
  const windowDirectoryPlaceScopeIds = ${WINDOW_DIRECTORY_PLACE_SCOPE_IDS_JS}
  const parseWindowSleeperPlaceIds = ${PARSE_WINDOW_SLEEPER_PLACE_IDS_JS}
  const WINDOW_VIEWER_OPEN_STORAGE_KEY = ${WINDOW_VIEWER_OPEN_STORAGE_KEY_JSON}
  const parseWindowViewerOpenKeys = ${PARSE_WINDOW_VIEWER_OPEN_KEYS_JS}
  const { decodeNoteText, detectNoteLanguage } = (${CREATE_NOTE_DECODING_HELPERS_JS})()
  const containsMalformedPublicText = ${CONTAINS_MALFORMED_PUBLIC_TEXT_JS}
  const validateWindowArchiveQuery = ${VALIDATE_WINDOW_ARCHIVE_QUERY_JS}
  const validateWindowDirectorySearch = ${VALIDATE_WINDOW_DIRECTORY_SEARCH_JS}
  const windowDetailShareState = ${WINDOW_DETAIL_SHARE_STATE_JS}
  const windowSharePath = ${WINDOW_SHARE_PATH_JS}
  const windowShareTargetPath = ${WINDOW_SHARE_TARGET_PATH_JS}
  const normalizeWindowDrawing = ${NORMALIZE_WINDOW_DRAWING_JS}
  const windowDrawingStateLabel = ${WINDOW_DRAWING_STATE_LABEL_JS}
  const windowDrawingSourceLabel = ${WINDOW_DRAWING_SOURCE_LABEL_JS}

`
