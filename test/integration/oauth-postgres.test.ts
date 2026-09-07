import test from 'node:test'
import { withOAuthPostgres } from '../helpers/oauth-postgres-fixtures/postgres.ts'
import { registerRegistrationStagingTests } from './oauth-tests/registration-staging.ts'
import { registerCredentialRefusalsTests } from './oauth-tests/credential-refusals.ts'
import { registerRequestLifecycleTests } from './oauth-tests/request-lifecycle.ts'
import { registerRegistrationRollbackTests } from './oauth-tests/registration-rollback.ts'
import { registerRegistrationConfirmationTests } from './oauth-tests/registration-confirmation.ts'
import { registerAuthorizationCodeAndAccessTests } from './oauth-tests/authorization-code-and-access.ts'
import { registerRefreshAndRevocationTests } from './oauth-tests/refresh-and-revocation.ts'
import { registerRateLimitsAndRetentionTests } from './oauth-tests/rate-limits-and-retention.ts'

test('OAuth authorization writes roll back atomically in PostgreSQL', async t => {
  await withOAuthPostgres(async store => {
    await registerRegistrationStagingTests(t, store)
    await registerCredentialRefusalsTests(t, store)
    await registerRequestLifecycleTests(t, store)
    await registerRegistrationRollbackTests(t, store)
    await registerRegistrationConfirmationTests(t, store)
    await registerAuthorizationCodeAndAccessTests(t, store)
    await registerRefreshAndRevocationTests(t, store)
    await registerRateLimitsAndRetentionTests(t, store)
  })
})
