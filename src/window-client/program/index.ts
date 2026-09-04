// Ordered client-JS program parts that assemble WINDOW_JS in src/window-client.ts.
//
// BYTE-IDENTITY CONTRACT (Phase 1 of issue #79; see docs/DRAWING_AND_LIVE_VIEW.md):
// R1 - PART FILE SHAPE. Every part file is exactly:
//        export const PART_NN_NAME = `<first source line>
//        <...>
//        <last source line>
//        `
//      The opening backtick is immediately followed by the FIRST BYTE of the
//      part's first source line (no newline between them). The closing
//      backtick sits ALONE at column 0 on the line after the part's last
//      source line. A part's value is its source lines joined by "\n" plus
//      one trailing "\n".
// R2 - NO TRANSFORMATION. No .trim(), .slice(), .replace(), reindentation, or
//      backslash line continuation anywhere. Every part is copied line-for-line
//      out of the original src/window-client.ts at commit d195c5b.
// R3 - JOIN SEPARATOR IS THE EMPTY STRING. Each part already carries its own
//      trailing newline, so .join('') reproduces the original exactly.
// R4 - INTERPOLATIONS STAY PUT, WITH THEIR IMPORTS. All ${...} occurrences in
//      the client program live in part 01 (lines 1379-1463 of the original
//      file) except one, the first line of part 05 (line 2339).
// R5 - HEAD AND FOOT. Part 01's value begins with "(() => {"; part 39's value
//      ends with "})()" plus one trailing newline. Nothing else contributes.
//
// Order here is the authority; the NN- filename prefix exists only so `ls`
// shows ship order.
import { PART_01_PRELUDE } from './01-prelude.ts'
import { PART_02_STATE_AND_NODES } from './02-state-and-nodes.ts'
import { PART_03_ELEMENTS_PORTRAITS_DRAWINGS } from './03-elements-portraits-drawings.ts'
import { PART_04_LIVE_PROOF_SCENE } from './04-live-proof-scene.ts'
import { PART_05_SAFETY_AND_LIVE_FOCUS } from './05-safety-and-live-focus.ts'
import { PART_06_LIVE_CAMERA_AND_POINTERS } from './06-live-camera-and-pointers.ts'
import { PART_07_SHARE_AND_ROOM_NOTICES } from './07-share-and-room-notices.ts'
import { PART_08_ARCHIVE } from './08-archive.ts'
import { PART_09_GAZETTE } from './09-gazette.ts'
import { PART_10_SNAPSHOT_NORMALIZERS } from './10-snapshot-normalizers.ts'
import { PART_11_LIVE_RECORDS_ANCHORS_AND_NOTES } from './11-live-records-anchors-and-notes.ts'
import { PART_12_SNAPSHOT_MERGE_AND_NAVIGATION } from './12-snapshot-merge-and-navigation.ts'
import { PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES } from './13-branch-cache-and-history-entries.ts'
import { PART_14_LOCATION_AND_NAVIGATION } from './14-location-and-navigation.ts'
import { PART_15_DIRECTORY_SEARCH } from './15-directory-search.ts'
import { PART_16_FILTERS_AND_REFERENCES } from './16-filters-and-references.ts'
import { PART_17_PLACE_BRANCHES_AND_MAP } from './17-place-branches-and-map.ts'
import { PART_18_RESIDENTS_PAGING_AND_ROSTER } from './18-residents-paging-and-roster.ts'
import { PART_19_THING_INDEX } from './19-thing-index.ts'
import { PART_20_LIVE_BREADCRUMBS_AND_RESIDENT_LAYOUT } from './20-live-breadcrumbs-and-resident-layout.ts'
import { PART_21_LIVE_PINNING_AND_PORTRAIT_GRID } from './21-live-pinning-and-portrait-grid.ts'
import { PART_22_LIVE_THINGS_AND_PLOTS } from './22-live-things-and-plots.ts'
import { PART_23_LIVE_ROSTER_AND_INTERACTIONS } from './23-live-roster-and-interactions.ts'
import { PART_24_LIVE_REPLAY_MOTION } from './24-live-replay-motion.ts'
import { PART_25_LIVE_TRACES_AND_LEDGER } from './25-live-traces-and-ledger.ts'
import { PART_26_LIVE_HISTORY_CLOCK_AND_QUIET } from './26-live-history-clock-and-quiet.ts'
import { PART_27_LIVE_RENDER } from './27-live-render.ts'
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
import { PART_39_WIRING_AND_BOOT } from './39-wiring-and-boot.ts'

export const WINDOW_CLIENT_PARTS: readonly string[] = Object.freeze([
  PART_01_PRELUDE,
  PART_02_STATE_AND_NODES,
  PART_03_ELEMENTS_PORTRAITS_DRAWINGS,
  PART_04_LIVE_PROOF_SCENE,
  PART_05_SAFETY_AND_LIVE_FOCUS,
  PART_06_LIVE_CAMERA_AND_POINTERS,
  PART_07_SHARE_AND_ROOM_NOTICES,
  PART_08_ARCHIVE,
  PART_09_GAZETTE,
  PART_10_SNAPSHOT_NORMALIZERS,
  PART_11_LIVE_RECORDS_ANCHORS_AND_NOTES,
  PART_12_SNAPSHOT_MERGE_AND_NAVIGATION,
  PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES,
  PART_14_LOCATION_AND_NAVIGATION,
  PART_15_DIRECTORY_SEARCH,
  PART_16_FILTERS_AND_REFERENCES,
  PART_17_PLACE_BRANCHES_AND_MAP,
  PART_18_RESIDENTS_PAGING_AND_ROSTER,
  PART_19_THING_INDEX,
  PART_20_LIVE_BREADCRUMBS_AND_RESIDENT_LAYOUT,
  PART_21_LIVE_PINNING_AND_PORTRAIT_GRID,
  PART_22_LIVE_THINGS_AND_PLOTS,
  PART_23_LIVE_ROSTER_AND_INTERACTIONS,
  PART_24_LIVE_REPLAY_MOTION,
  PART_25_LIVE_TRACES_AND_LEDGER,
  PART_26_LIVE_HISTORY_CLOCK_AND_QUIET,
  PART_27_LIVE_RENDER,
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
  PART_39_WIRING_AND_BOOT,
])
