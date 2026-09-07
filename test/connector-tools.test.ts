import { registerToolContractTests } from './connector-tools-tests/tool-contracts.test.ts'
import { registerRouteForwardingTests } from './connector-tools-tests/route-forwarding.test.ts'
import { registerCatalogRoutingTests } from './connector-tools-tests/catalog-routing.test.ts'
import { registerBodyForwardingTests } from './connector-tools-tests/body-forwarding.test.ts'
import { registerSecurityBoundaryTests } from './connector-tools-tests/security-boundaries.test.ts'

registerToolContractTests()
registerRouteForwardingTests()
registerCatalogRoutingTests()
registerBodyForwardingTests()
registerSecurityBoundaryTests()
