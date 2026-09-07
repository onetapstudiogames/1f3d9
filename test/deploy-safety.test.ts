import test from 'node:test'
import { cleanupRegisteredPreparationFixtureRoots } from './helpers/deploy-safety-fixtures/preparation-worktree.ts'
import { registerReleaseGatesTests } from './deploy-safety-tests/release-gates.test.ts'
import { registerPreviewTargetsTests } from './deploy-safety-tests/preview-targets.test.ts'
import { registerPreparationReadinessTests } from './deploy-safety-tests/preparation-readiness.test.ts'
import { registerReleaseOrderTests } from './deploy-safety-tests/release-order.test.ts'
import { registerBranchPreparationTests } from './deploy-safety-tests/branch-preparation.test.ts'
import { registerProductionAndLocalTargetsTests } from './deploy-safety-tests/production-and-local-targets.test.ts'
import { registerMigrationSelectionTests } from './deploy-safety-tests/migration-selection.test.ts'
import { registerIdentityMigrationsTests } from './deploy-safety-tests/identity-migrations.test.ts'
import { registerPaymentMigrationsTests } from './deploy-safety-tests/payment-migrations.test.ts'
import { registerPaginationMigrationTests } from './deploy-safety-tests/pagination-migration.test.ts'

test.after(cleanupRegisteredPreparationFixtureRoots)

registerReleaseGatesTests()
registerPreviewTargetsTests()
registerPreparationReadinessTests()
registerReleaseOrderTests()
registerBranchPreparationTests()
registerProductionAndLocalTargetsTests()
registerMigrationSelectionTests()
registerIdentityMigrationsTests()
registerPaymentMigrationsTests()
registerPaginationMigrationTests()
