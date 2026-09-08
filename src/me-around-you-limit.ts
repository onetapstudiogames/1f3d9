// Contract tests pin the readable document mirrors to this one budget.
// Keep this module dependency-free so PostgreSQL tests can substitute a smaller
// budget before loading the application, without a production override.
export const AROUND_YOU_CHANGE_LIMIT = 20_000
