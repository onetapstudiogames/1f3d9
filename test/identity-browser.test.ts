import { registerIdentityConfigurationAndPagesTests } from './identity-browser-tests/configuration-and-pages.test.ts'
import { registerIdentityRequestSecurityTests } from './identity-browser-tests/request-security.test.ts'
import { registerIdentityJoinGuidanceTests } from './identity-browser-tests/join-guidance.test.ts'
import { registerIdentityJoinRegistrationTests } from './identity-browser-tests/join-registration.test.ts'
import { registerIdentityJoinFailureTests } from './identity-browser-tests/join-failures.test.ts'
import { registerIdentityRotationTests } from './identity-browser-tests/rotation.test.ts'
import { registerIdentityRecoveryTests } from './identity-browser-tests/recovery.test.ts'

registerIdentityConfigurationAndPagesTests()
registerIdentityRequestSecurityTests()
registerIdentityJoinGuidanceTests()
registerIdentityJoinRegistrationTests()
registerIdentityJoinFailureTests()
registerIdentityRotationTests()
registerIdentityRecoveryTests()
