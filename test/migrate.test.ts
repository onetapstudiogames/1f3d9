import { registerCommunitySchemaTests } from './migrate-tests/community-schema.test.ts'
import { registerMigrationReleaseTests } from './migrate-tests/migration-releases.test.ts'
import { registerGazetteInstallationTests } from './migrate-tests/gazette-installation.test.ts'
import { registerGazetteDeploymentTests } from './migrate-tests/gazette-deployment.test.ts'
import { registerResidentDrawingTests } from './migrate-tests/resident-drawings.test.ts'
import { registerExecutionIndexTests } from './migrate-tests/execution-indexes.test.ts'
import { registerWorldPublicTests } from './migrate-tests/world-public.test.ts'

registerCommunitySchemaTests()
registerMigrationReleaseTests()
registerGazetteInstallationTests()
registerGazetteDeploymentTests()
registerResidentDrawingTests()
registerExecutionIndexTests()
registerWorldPublicTests()
