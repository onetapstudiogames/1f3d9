import { registerRequestIdentityTests } from './payment-attempts-tests/request-identity.test.ts'
import { registerCreationAndReplayTests } from './payment-attempts-tests/creation-and-replay.test.ts'
import { registerSettlementLeasesTests } from './payment-attempts-tests/settlement-leases.test.ts'
import { registerEvidenceAndResponseTests } from './payment-attempts-tests/evidence-and-response.test.ts'
import { registerRecoveryTransitionsTests } from './payment-attempts-tests/recovery-transitions.test.ts'
import { registerViewsAndLookupsTests } from './payment-attempts-tests/views-and-lookups.test.ts'

registerRequestIdentityTests()
registerCreationAndReplayTests()
registerSettlementLeasesTests()
registerEvidenceAndResponseTests()
registerRecoveryTransitionsTests()
registerViewsAndLookupsTests()
