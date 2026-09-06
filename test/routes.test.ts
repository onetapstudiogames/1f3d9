// One fake isolates Neon, Base JSON-RPC, and the x402 facilitator.
// No live database, wallet, payment, deployment, or network service is touched.
import test from 'node:test'
import { installFakeEnvironment } from './helpers/routes-fixtures/environment.ts'
import { installFakeFetch } from './helpers/routes-fixtures/fake-fetch.ts'
import { initializeRoutesTestContext } from './helpers/routes-fixtures/context.ts'
import { registerBoundaryAndNotesTests } from './routes-tests/boundary-and-notes.test.ts'
import { registerGazetteNotesTests } from './routes-tests/gazette-notes.test.ts'
import { registerMapAndMarkersTests } from './routes-tests/map-and-markers.test.ts'
import { registerWindowSnapshotsTests } from './routes-tests/window-snapshots.test.ts'
import { registerPublicRecordsTests } from './routes-tests/public-records.test.ts'
import { registerRoomOrientationTests } from './routes-tests/room-orientation.test.ts'
import { registerDrawingsTests } from './routes-tests/drawings.test.ts'
import { registerKindsAndUpgradesTests } from './routes-tests/kinds-and-upgrades.test.ts'
import { registerAgreementsTests } from './routes-tests/agreements.test.ts'
import { registerDirectSalesTests } from './routes-tests/direct-sales.test.ts'
import { registerPaymentCustodyTests } from './routes-tests/payment-custody.test.ts'
import { registerPaymentRecoveryTests } from './routes-tests/payment-recovery.test.ts'
import { registerFounderOperationsTests } from './routes-tests/founder-operations.test.ts'
import { registerCityCreditAccountTests } from './routes-tests/city-credit-account.test.ts'
import { registerCityCreditSpendTests } from './routes-tests/city-credit-spend.test.ts'
import { registerCityCreditFailuresTests } from './routes-tests/city-credit-failures.test.ts'
import { registerPlaceReadingTests } from './routes-tests/place-reading.test.ts'
import { registerPlaceLimitsTests } from './routes-tests/place-limits.test.ts'
import { registerSearchTests } from './routes-tests/search.test.ts'
import { registerLaterHolderTests } from './routes-tests/later-holder.test.ts'
import { registerPublicReadContractsTests } from './routes-tests/public-read-contracts.test.ts'
import { registerPublicPaginationTests } from './routes-tests/public-pagination.test.ts'
import { registerOfficialAndFlagsTests } from './routes-tests/official-and-flags.test.ts'
import { registerMcpTests } from './routes-tests/mcp.test.ts'
import { registerFrontDoorAndPhysicsTests } from './routes-tests/front-door-and-physics.test.ts'
import { registerActionsTests } from './routes-tests/actions.test.ts'
import { registerThingUseTests } from './routes-tests/thing-use.test.ts'
import { registerEffectsTests } from './routes-tests/effects.test.ts'
import { registerModerationAndHistoryTests } from './routes-tests/moderation-and-history.test.ts'

installFakeEnvironment()
installFakeFetch()
const { default: app } = await import('../src/index.ts')
const {
  loadPublicNoteRecord,
  loadPublicPlaceRecord,
  loadPublicThingRecord,
} = await import('../src/public-records.ts')
const {
  CommitOutcomeUnknownError,
  setEngineTransactionRunnerForTests,
} = await import('../src/engine.ts')
setEngineTransactionRunnerForTests(async (db, work) => work(db, false))
test.after(() => setEngineTransactionRunnerForTests(null))
initializeRoutesTestContext({
  app,
  loadPublicNoteRecord,
  loadPublicPlaceRecord,
  loadPublicThingRecord,
  CommitOutcomeUnknownError,
  setEngineTransactionRunnerForTests,
})

// Nested registrars use this bootstrap and are called explicitly in their original order.
registerBoundaryAndNotesTests()
registerGazetteNotesTests()
registerMapAndMarkersTests()
registerWindowSnapshotsTests()
registerPublicRecordsTests()
registerRoomOrientationTests()
registerDrawingsTests()
registerKindsAndUpgradesTests()
registerAgreementsTests()
registerDirectSalesTests()
registerPaymentCustodyTests()
registerPaymentRecoveryTests()
registerFounderOperationsTests()
registerCityCreditAccountTests()
registerCityCreditSpendTests()
registerCityCreditFailuresTests()
registerPlaceReadingTests()
registerPlaceLimitsTests()
registerSearchTests()
registerLaterHolderTests()
registerPublicReadContractsTests()
registerPublicPaginationTests()
registerOfficialAndFlagsTests()
registerMcpTests()
registerFrontDoorAndPhysicsTests()
registerActionsTests()
registerThingUseTests()
registerEffectsTests()
registerModerationAndHistoryTests()
