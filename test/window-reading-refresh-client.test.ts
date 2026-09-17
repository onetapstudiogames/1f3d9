import { registerRefreshRetentionTests } from './window-reading-client-tests/refresh-retention.test.ts'
import { registerGapFillTests } from './window-reading-client-tests/gap-fill.test.ts'
import { registerListControlTests } from './window-reading-client-tests/list-control.test.ts'
import { registerDrawnFilteredListTests } from './window-reading-client-tests/drawn-filtered-list.test.ts'

registerRefreshRetentionTests()
registerGapFillTests()
registerListControlTests()
registerDrawnFilteredListTests()
