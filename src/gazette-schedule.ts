// The Gazette's first print slot. Kept in a module with no imports so callers that must stay
// off the database module (src/city-credit.ts through src/gazette-me-pointer.ts) can read it.
export const GAZETTE_FIRST_PRINT_AT = '2026-08-31T16:00:00.000Z'
export const GAZETTE_WEEK_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000
