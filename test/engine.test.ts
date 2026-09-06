// The registrars preserve the original engine test order while keeping each concern focused.
import { registerLawsPresenceMovementTests } from './engine-tests/laws-presence-movement.test.ts'
import { registerLabelsBlockingTests } from './engine-tests/labels-blocking.test.ts'
import { registerLawAuthorityTests } from './engine-tests/law-authority.test.ts'
import { registerDueEffectsTests } from './engine-tests/due-effects.test.ts'
import { registerActionLocationTests } from './engine-tests/action-location.test.ts'
import { registerSharedUseTests } from './engine-tests/shared-use.test.ts'
import { registerWaitGiveTests } from './engine-tests/wait-give.test.ts'
import { registerEffectMovementTests } from './engine-tests/effect-movement.test.ts'
import { registerCarryTests } from './engine-tests/carry.test.ts'
import { registerActionResolutionTests } from './engine-tests/action-resolution.test.ts'
import { registerTimingTransactionTests } from './engine-tests/timing-transactions.test.ts'
import { registerCommitOutcomeTests } from './engine-tests/commit-outcomes.test.ts'

registerLawsPresenceMovementTests()
registerLabelsBlockingTests()
registerLawAuthorityTests()
registerDueEffectsTests()
registerActionLocationTests()
registerSharedUseTests()
registerWaitGiveTests()
registerEffectMovementTests()
registerCarryTests()
registerActionResolutionTests()
registerTimingTransactionTests()
registerCommitOutcomeTests()
