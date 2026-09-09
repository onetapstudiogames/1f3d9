// Ordered client-JS fragments assembled by src/window-client.ts. This list is
// the authority: part 01 opens the single IIFE, part 39 closes it, and every
// fragment carries its own trailing newline so the join separator stays empty.
import { PART_01_PRELUDE } from './01-prelude.ts'
import { PART_02_STATE_AND_NODES } from './02-state-and-nodes.ts'
import { PART_03_ELEMENTS_PORTRAITS_DRAWINGS } from './03-elements-portraits-drawings.ts'
import { PART_05_SAFETY } from './05-safety.ts'
import { PART_07_SHARE_AND_ROOM_NOTICES } from './07-share-and-room-notices.ts'
import { PART_08_ARCHIVE } from './08-archive.ts'
import { PART_09_GAZETTE } from './09-gazette.ts'
import { PART_10_SNAPSHOT_NORMALIZERS } from './10-snapshot-normalizers.ts'
import { PART_12_SNAPSHOT_MERGE_AND_NAVIGATION } from './12-snapshot-merge-and-navigation.ts'
import { PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES } from './13-branch-cache-and-history-entries.ts'
import { PART_14_LOCATION_AND_NAVIGATION } from './14-location-and-navigation.ts'
import { PART_15_DIRECTORY_SEARCH } from './15-directory-search.ts'
import { PART_16_FILTERS_AND_REFERENCES } from './16-filters-and-references.ts'
import { PART_17_PLACE_BRANCHES_AND_MAP } from './17-place-branches-and-map.ts'
import { PART_18_RESIDENTS_PAGING_AND_ROSTER } from './18-residents-paging-and-roster.ts'
import { PART_19_THING_INDEX } from './19-thing-index.ts'
import { PART_28_PEOPLE_AND_DETAIL_LINKS } from './28-people-and-detail-links.ts'
import { PART_29_DETAIL_LOADING_AND_DRAWINGS } from './29-detail-loading-and-drawings.ts'
import { PART_30_DETAIL_RENDER_AND_BODIES } from './30-detail-render-and-bodies.ts'
import { PART_31_THINGS_NOTES_AND_PLACE } from './31-things-notes-and-place.ts'
import { PART_32_CONVERSATIONS_AND_HAPPENINGS } from './32-conversations-and-happenings.ts'
import { PART_33_AGREEMENTS_AND_HISTORY_CONTROLS } from './33-agreements-and-history-controls.ts'
import { PART_34_HISTORY_LOADING_COUNTS_AND_SCOPE } from './34-history-loading-counts-and-scope.ts'
import { PART_35_VIEW_RENDER_AND_SELECTION } from './35-view-render-and-selection.ts'
import { PART_36_FOCUSED_PLACE_AND_RESIDENT } from './36-focused-place-and-resident.ts'
import { PART_37_SNAPSHOT_FETCH_AND_CACHE_INVALIDATION } from './37-snapshot-fetch-and-cache-invalidation.ts'
import { PART_38_REFRESH_CITY } from './38-refresh-city.ts'
import { PART_44_VIEWER_READING_STATE } from './44-viewer-reading-state.ts'
import { PART_39_WIRING_AND_BOOT } from './39-wiring-and-boot.ts'

export const WINDOW_CLIENT_PARTS: readonly string[] = Object.freeze([
  PART_01_PRELUDE,
  PART_02_STATE_AND_NODES,
  PART_03_ELEMENTS_PORTRAITS_DRAWINGS,
  PART_05_SAFETY,
  PART_07_SHARE_AND_ROOM_NOTICES,
  PART_08_ARCHIVE,
  PART_09_GAZETTE,
  PART_10_SNAPSHOT_NORMALIZERS,
  PART_12_SNAPSHOT_MERGE_AND_NAVIGATION,
  PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES,
  PART_14_LOCATION_AND_NAVIGATION,
  PART_15_DIRECTORY_SEARCH,
  PART_16_FILTERS_AND_REFERENCES,
  PART_17_PLACE_BRANCHES_AND_MAP,
  PART_18_RESIDENTS_PAGING_AND_ROSTER,
  PART_19_THING_INDEX,
  PART_28_PEOPLE_AND_DETAIL_LINKS,
  PART_29_DETAIL_LOADING_AND_DRAWINGS,
  PART_30_DETAIL_RENDER_AND_BODIES,
  PART_31_THINGS_NOTES_AND_PLACE,
  PART_32_CONVERSATIONS_AND_HAPPENINGS,
  PART_33_AGREEMENTS_AND_HISTORY_CONTROLS,
  PART_34_HISTORY_LOADING_COUNTS_AND_SCOPE,
  PART_35_VIEW_RENDER_AND_SELECTION,
  PART_36_FOCUSED_PLACE_AND_RESIDENT,
  PART_37_SNAPSHOT_FETCH_AND_CACHE_INVALIDATION,
  PART_38_REFRESH_CITY,
  PART_44_VIEWER_READING_STATE,
  PART_39_WIRING_AND_BOOT,
])
