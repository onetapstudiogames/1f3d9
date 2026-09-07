import type { PoolClient } from 'pg'

export async function captureLock(client: PoolClient, captureId: string): Promise<void> {
  await client.query('BEGIN')
  await client.query(`
    SELECT pg_advisory_xact_lock(hashtextextended(
      '1f3d9/paypal-credit/dispute-reconciliation', 0
    ))
  `)
  await client.query(`
    SELECT pg_advisory_xact_lock(hashtextextended(
      '1f3d9/paypal-credit/capture/' || $1::text, 0
    ))
  `, [captureId])
}
