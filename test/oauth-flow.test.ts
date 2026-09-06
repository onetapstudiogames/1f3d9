import { registerAuthorizationRequestTests } from './oauth-flow-tests/authorization-requests.test.ts'
import { registerBoundedFailureTests } from './oauth-flow-tests/bounded-failures.test.ts'
import { registerConnectorTokenTests } from './oauth-flow-tests/connector-tokens.test.ts'
import { registerResidentLinkingTests } from './oauth-flow-tests/resident-linking.test.ts'
import { registerSignupConfirmationTests } from './oauth-flow-tests/signup-confirmation.test.ts'
import { registerSignupResilienceTests } from './oauth-flow-tests/signup-resilience.test.ts'
import { registerRefreshReuseTests } from './oauth-flow-tests/refresh-reuse.test.ts'
import { registerBrowserSecurityTests } from './oauth-flow-tests/browser-security.test.ts'
import { registerAuthorizationLifecycleTests } from './oauth-flow-tests/authorization-lifecycle.test.ts'
import { registerPairingTests } from './oauth-flow-tests/pairing.test.ts'

// Nested registrars preserve the original OAuth flow test order.
registerAuthorizationRequestTests()
registerBoundedFailureTests()
registerConnectorTokenTests()
registerResidentLinkingTests()
registerSignupConfirmationTests()
registerSignupResilienceTests()
registerRefreshReuseTests()
registerBrowserSecurityTests()
registerAuthorizationLifecycleTests()
registerPairingTests()
