import { registerListingAndPublicRecordTests } from './world-market-tests/listing-public.test.ts'
import { registerReservationTests } from './world-market-tests/reservation.test.ts'
import { registerPaymentTests } from './world-market-tests/payment.test.ts'
import { registerReconciliationTests } from './world-market-tests/reconciliation.test.ts'
import { registerCancellationTests } from './world-market-tests/cancellation.test.ts'

registerListingAndPublicRecordTests()
registerReservationTests()
registerPaymentTests()
registerReconciliationTests()
registerCancellationTests()
