import { neon, type NeonQueryFunction } from '@neondatabase/serverless'

type Sql = NeonQueryFunction<false, false>
type DatabaseEnvironment = Readonly<Record<string, string | undefined>>
const DATABASE_UNAVAILABLE = 'database is temporarily unavailable'

let activeClient: Sql | null = null

export function runtimeDatabaseUrl(environment: DatabaseEnvironment = process.env): string {
  const previewOverride = environment.HOSTED_CHAT_PREVIEW_DATABASE_URL?.trim()
  if (environment.VERCEL_ENV === 'preview') {
    if (previewOverride) return previewOverride
    throw new Error(DATABASE_UNAVAILABLE)
  }
  const url = environment.DATABASE_URL?.trim()
  if (!url) throw new Error(DATABASE_UNAVAILABLE)
  return url
}

function client(): Sql {
  if (!activeClient) {
    activeClient = neon(runtimeDatabaseUrl())
  }
  return activeClient
}

export const sql: Sql = new Proxy((() => {}) as unknown as Sql, {
  apply: (_target, _this, args) => (client() as unknown as (...values: unknown[]) => unknown)(...args),
  get: (_target, property) => (client() as unknown as Record<PropertyKey, unknown>)[property],
}) as Sql
