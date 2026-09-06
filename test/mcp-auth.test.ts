// The registrars preserve the original MCP auth test order while keeping each concern focused.
import { registerCatalogTests } from './mcp-auth-tests/catalogs.test.ts'
import { registerPointerAndParityTests } from './mcp-auth-tests/pointers-and-parity.test.ts'
import { registerToolSurfaceTests } from './mcp-auth-tests/tool-surfaces.test.ts'
import { registerToolDescriptionTests } from './mcp-auth-tests/tool-descriptions.test.ts'
import { registerStatefulToolTests } from './mcp-auth-tests/stateful-tools.test.ts'
import { registerAuthBoundaryTests } from './mcp-auth-tests/auth-boundaries.test.ts'
import { registerRedactionAndPassivityTests } from './mcp-auth-tests/redaction-and-passivity.test.ts'
import { registerErrorContractTests } from './mcp-auth-tests/error-contracts.test.ts'

registerCatalogTests()
registerPointerAndParityTests()
registerToolSurfaceTests()
registerToolDescriptionTests()
registerStatefulToolTests()
registerAuthBoundaryTests()
registerRedactionAndPassivityTests()
registerErrorContractTests()
