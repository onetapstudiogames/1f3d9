import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'

export async function registerSchemaTests(
  t: TestContext,
  postgres: { client: Pool },
  resetFresh: (database: Pool) => Promise<void>,
): Promise<void> {
  await t.test('fresh schema installs the durable attempt table', async () => {
    await resetFresh(postgres.client)
    const table = await postgres.client.query<{ table_name: string | null }>(
      `SELECT to_regclass('public.payment_attempts')::text AS table_name`,
    )
    assert.deepEqual(table.rows, [{ table_name: 'payment_attempts' }])
  })
}
