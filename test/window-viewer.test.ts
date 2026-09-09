import { registerWindowOpeningTests } from './window-viewer-tests/opening.test.ts'
import { registerWindowPublicUiTests } from './window-viewer-tests/public-ui.test.ts'
import { registerWindowOperationsTests } from './window-viewer-tests/operations.test.ts'
import { registerWindowRouteAndPaginationTests } from './window-viewer-tests/route-and-pagination.test.ts'
import { registerWindowCollectionsAndFollowTests } from './window-viewer-tests/collections-and-follow.test.ts'
import { registerWindowDirectoryAndPlaceTests } from './window-viewer-tests/directory-and-place.test.ts'
import { registerWindowSnapshotShapersTests } from './window-viewer-tests/snapshot-shapers.test.ts'
import { registerWindowNavigationAndCountsTests } from './window-viewer-tests/navigation-and-counts.test.ts'
import { registerWindowPagesTests } from './window-viewer-tests/pages.test.ts'

registerWindowOpeningTests()
registerWindowPublicUiTests()
registerWindowOperationsTests()
registerWindowRouteAndPaginationTests()
registerWindowCollectionsAndFollowTests()
registerWindowDirectoryAndPlaceTests()
registerWindowSnapshotShapersTests()
registerWindowNavigationAndCountsTests()
registerWindowPagesTests()
