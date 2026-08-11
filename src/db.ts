import { neon, type NeonQueryFunction } from '@neondatabase/serverless'

type Sql = NeonQueryFunction<false, false>

let activeClient: Sql | null = null

function client(): Sql {
  if (!activeClient) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is not set')
    activeClient = neon(url)
  }
  return activeClient
}

export const sql: Sql = new Proxy((() => {}) as unknown as Sql, {
  apply: (_target, _this, args) => (client() as unknown as (...values: unknown[]) => unknown)(...args),
  get: (_target, property) => (client() as unknown as Record<PropertyKey, unknown>)[property],
}) as Sql
