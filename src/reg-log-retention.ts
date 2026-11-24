// Sign-up network records (reg_log) are kept for 24 hours, as db/schema.sql says.
// The only writer is the sign-up insert in src/identity-store.ts, and nothing reads
// the rows back. This purge rides the existing five-minute maintenance cron
// (/api/internal/payment-recovery, vercel.json) beside the log purges of decision
// #141, so old rows go even on a day with no sign-up. It advances nothing in the
// city: it only deletes private rows.

export const REG_LOG_RETENTION_MS = 24 * 60 * 60 * 1_000
/** At most this many rows per tick; a backlog drains over the next ticks. */
export const REG_LOG_RETENTION_PAGE_LIMIT = 5_000

export interface RegLogDatabase {
  query(
    text: string,
    params?: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]>
}

export type RegLogRetentionResult = Readonly<{ deleted: number }>

/**
 * reg_log has no id column, so a page is picked by row address (ctid) through the
 * created_at index, oldest first. Rows are only ever inserted and deleted, never
 * updated, so an address cannot move under the statement. SKIP LOCKED lets two
 * overlapping ticks share the work without waiting or deleting a row twice.
 */
export const REG_LOG_RETENTION_SQL = `
    /* reg-log:retention */
    WITH expired AS MATERIALIZED (
      SELECT log.ctid AS row_address
      FROM reg_log AS log
      WHERE log.created_at < $1::timestamptz
      ORDER BY log.created_at
      LIMIT $2
      FOR UPDATE OF log SKIP LOCKED
    ), deleted AS (
      DELETE FROM reg_log AS log
      WHERE log.ctid = ANY (ARRAY(SELECT expired.row_address FROM expired))
      RETURNING 1 AS one
    )
    SELECT count(*)::integer AS deleted FROM deleted
  `

/** Delete one page of sign-up network records older than 24 hours. */
export async function runRegLogRetention(
  database: RegLogDatabase,
  now = new Date(),
): Promise<RegLogRetentionResult> {
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError('reg log retention requires a valid current time')
  }
  const cutoff = new Date(now.getTime() - REG_LOG_RETENTION_MS)
  const rows = await database.query(REG_LOG_RETENTION_SQL, [cutoff.toISOString(), REG_LOG_RETENTION_PAGE_LIMIT])
  const deleted = rows[0]?.deleted
  if (
    typeof deleted !== 'number'
    || !Number.isSafeInteger(deleted)
    || deleted < 0
    || deleted > REG_LOG_RETENTION_PAGE_LIMIT
  ) {
    throw new Error('reg log retention returned an invalid result')
  }
  return Object.freeze({ deleted })
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && /^[0-9A-Z]{5}$/u.test(code) ? code : undefined
}

/** The purge's own fixed failure line: the error name and PostgreSQL code, never a row or message. */
export function reportRegLogRetentionFailure(error: unknown): void {
  try {
    const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(error.name)
      ? error.name
      : 'Error'
    const errorCode = postgresErrorCode(error)
    console.error('reg_log_retention_failure', JSON.stringify({
      event: 'reg_log_retention_failure',
      error_name: errorName,
      ...(errorCode ? { error_code: errorCode } : {}),
    }))
  } catch {
    // Reporting must never stop the maintenance tick.
  }
}
