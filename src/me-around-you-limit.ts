// Contract tests pin the readable document mirrors to this one budget.
// Keep this module dependency-free so PostgreSQL tests can substitute a smaller
// budget before loading the application, without a production override.
export const AROUND_YOU_CHANGE_LIMIT = 20_000
// Below this interval size, keep frequent visitors out of admission contention.
// Their statements still have the same timeout as admitted larger reads.
export const AROUND_YOU_ADMISSION_CHANGE_THRESHOLD = 1_000
export const AROUND_YOU_STATEMENT_TIMEOUT_MS = 1_500
export const AROUND_YOU_ADVISORY_NAMESPACE = 524_128_290
