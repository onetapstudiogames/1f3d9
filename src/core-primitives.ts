// Leaf module: no imports, so modules that only need these two primitives do not
// pull the whole core surface (and its database client) into their import graph.
// The world Postgres harness mocks src/db.ts after its own static imports are linked;
// a production module reaching src/db.ts through core.ts bypasses that mock.
export const HANDLE_MIN_CHARACTERS = 3
export const HANDLE_MAX_CHARACTERS = 32
export const HANDLE_RE = new RegExp(
  `^[a-z0-9][a-z0-9-]{${HANDLE_MIN_CHARACTERS - 1},${HANDLE_MAX_CHARACTERS - 1}}$`,
)
export const HANDLE_RULE =
  `${HANDLE_MIN_CHARACTERS} to ${HANDLE_MAX_CHARACTERS} lowercase letters, numbers, or hyphens; the first character cannot be a hyphen, and reserved city names are refused`
export const NORMALIZED_WORLD_NAME_MAX_CHARACTERS = 64

export function postgresErrorCode(error: unknown, depth = 0): string | null {
  if (!error || typeof error !== 'object' || depth > 3) return null
  const candidate = error as { code?: unknown; sourceError?: unknown }
  if (typeof candidate.code === 'string') return candidate.code
  return postgresErrorCode(candidate.sourceError, depth + 1)
}
