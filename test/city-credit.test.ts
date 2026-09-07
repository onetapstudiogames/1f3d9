import { registerPreflightAndMeReadsTests } from './city-credit-tests/preflight-and-me-reads.test.ts'
import { registerFeeUnitsAndRequestIdsTests } from './city-credit-tests/fee-units-and-request-ids.test.ts'
import { registerFounderIssuanceTests } from './city-credit-tests/founder-issuance.test.ts'
import { registerSpendAttemptsTests } from './city-credit-tests/spend-attempts.test.ts'
import { registerSpendReturnsTests } from './city-credit-tests/spend-returns.test.ts'
import { registerDeadlineRecoveryTests } from './city-credit-tests/deadline-recovery.test.ts'
import { registerAccountReceiptsTests } from './city-credit-tests/account-receipts.test.ts'

registerPreflightAndMeReadsTests()
registerFeeUnitsAndRequestIdsTests()
registerFounderIssuanceTests()
registerSpendAttemptsTests()
registerSpendReturnsTests()
registerDeadlineRecoveryTests()
registerAccountReceiptsTests()
