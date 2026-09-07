import test from 'node:test'

import { registerWorldPostgresTests } from '../helpers/world-postgres-fixtures/harness.ts'

test('world mutations plan and commit atomically in PostgreSQL', async t => {
  await registerWorldPostgresTests(t)
})
