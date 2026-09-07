import { registerPublicWindowSetup } from './helpers/public-window-setup.ts'
import { registerPublicWindowRouteAndPlace } from './public-window-interactions/route-and-place.ts'
import { registerPublicWindowBoundedExcerpts } from './public-window-interactions/bounded-excerpts.ts'
import { registerPublicWindowOutlineDirectory } from './public-window-interactions/outline-directory.ts'
import { registerPublicWindowViewportMatrix } from './public-window-interactions/viewport-matrix.ts'
import { registerPublicWindowFocusedNavigation } from './public-window-interactions/focused-navigation.ts'
import { registerPublicWindowSelectionReconciliation } from './public-window-interactions/selection-reconciliation.ts'
import { registerPublicWindowPaginationControls } from './public-window-interactions/pagination-controls.ts'
import { registerPublicWindowPaginationRefresh } from './public-window-interactions/pagination-refresh.ts'
import { registerPublicWindowInitialReadFailure } from './public-window-interactions/initial-read-failure.ts'
import { registerPublicWindowHappenings } from './public-window-interactions/happenings.ts'
import { registerPublicWindowRefreshContinuations } from './public-window-interactions/refresh-continuations.ts'
import { registerPublicWindowArchive } from './public-window-interactions/archive.ts'
import { registerPublicWindowSnapshotRefresh } from './public-window-interactions/snapshot-refresh.ts'
import { registerPublicWindowGazetteBasics } from './public-window-interactions/gazette-basics.ts'
import { registerPublicWindowGazetteEntries } from './public-window-interactions/gazette-entries.ts'

registerPublicWindowSetup()
registerPublicWindowRouteAndPlace()
registerPublicWindowBoundedExcerpts()
registerPublicWindowOutlineDirectory()
registerPublicWindowViewportMatrix()
registerPublicWindowFocusedNavigation()
registerPublicWindowSelectionReconciliation()
registerPublicWindowPaginationControls()
registerPublicWindowPaginationRefresh()
registerPublicWindowInitialReadFailure()
registerPublicWindowHappenings()
registerPublicWindowRefreshContinuations()
registerPublicWindowArchive()
registerPublicWindowSnapshotRefresh()
registerPublicWindowGazetteBasics()
registerPublicWindowGazetteEntries()
