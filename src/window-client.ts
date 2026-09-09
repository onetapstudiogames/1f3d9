import { PUBLIC_EVENT_KINDS, PUBLIC_EVENT_LABELS } from './public-events.ts'
import { WINDOW_CLIENT_PARTS } from './window-client/program/index.ts'

export { PUBLIC_EVENT_KINDS, PUBLIC_EVENT_LABELS }

// The browser program is assembled from the ordered fragments in
// window-client/program/index.ts. This facade exports the shared helpers used
// outside the assembled program and exposes the final script.

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

export { normalizeWindowResidentLooking } from './window-client/resident-looking.ts'
export type { WindowResidentLooking } from './window-client/resident-looking.ts'

export {
  WINDOW_VIEWER_OPEN_STORAGE_KEY,
  parseWindowViewerOpenKeys,
} from './window-client/viewer-state.ts'

export const WINDOW_JS = WINDOW_CLIENT_PARTS.join('')
