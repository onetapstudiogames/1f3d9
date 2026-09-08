// Leaf module: no imports, so modules that only need these two primitives do not
// pull the whole core surface (and its database client) into their import graph.
// The world Postgres harness mocks src/db.ts after its own static imports are linked;
// a production module reaching src/db.ts through core.ts bypasses that mock.
export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,31}$/

export function postgresErrorCode(error: unknown, depth = 0): string | null {
  if (!error || typeof error !== 'object' || depth > 3) return null
  const candidate = error as { code?: unknown; sourceError?: unknown }
  if (typeof candidate.code === 'string') return candidate.code
  return postgresErrorCode(candidate.sourceError, depth + 1)
}
