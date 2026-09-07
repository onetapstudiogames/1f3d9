import type { Pool, PoolClient } from 'pg'
import type { PayPalCreditStoreDatabase } from '../../../src/paypal-credit-store.ts'

export function database(client: Pool | PoolClient): PayPalCreditStoreDatabase {
  return {
    query: async (text, params = []) => (await client.query(text, [...params])).rows,
  }
}
