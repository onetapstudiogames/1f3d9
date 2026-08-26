const INSERT_BATCH_LIMIT = 500
const RETENTION_PAGE_LIMIT = 1_000
const RETENTION_DAYS_MS = 30 * 24 * 60 * 60 * 1_000

export interface RuntimeLogDatabase {
  query(
    text: string,
    params?: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]>
}

export type RuntimeLogRecord = Readonly<{
  id: string
  timestamp: string
  project: string
  source: string
  level: string
  requestPath: string | null
  requestMethod: string | null
  statusCode: number | null
  durationMs: number | null
  userAgent: string | null
  message: string | null
  deploymentId: string
}>

export type RuntimeLogRetentionResult = Readonly<{
  ran: boolean
  deleted: number
}>

/** Insert one authenticated Vercel delivery without duplicating retried log IDs. */
export async function insertRuntimeLogs(
  database: RuntimeLogDatabase,
  records: readonly RuntimeLogRecord[],
): Promise<number> {
  if (records.length === 0) return 0
  if (records.length > INSERT_BATCH_LIMIT) {
    throw new RangeError(`runtime log insert accepts at most ${INSERT_BATCH_LIMIT} records`)
  }

  const params: unknown[] = []
  const valueGroups = records.map(record => {
    const first = params.length + 1
    params.push(
      record.id,
      record.project,
      record.timestamp,
      record.source,
      record.level,
      record.requestPath,
      record.requestMethod,
      record.statusCode,
      record.durationMs,
      record.userAgent,
      record.message,
      record.deploymentId,
    )
    return `(${Array.from({ length: 12 }, (_, index) => `$${first + index}`).join(', ')})`
  })

  const inserted = await database.query(`
    INSERT INTO runtime_logs (
      id, project, timestamp, source, level, request_path, request_method,
      status_code, duration_ms, user_agent, message, deployment_id
    )
    VALUES ${valueGroups.join(',\n')}
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `, params)
  return inserted.length
}

/** Claim one UTC hour durably, then delete one small page during that hour's cron window. */
export async function runRuntimeLogRetention(
  database: RuntimeLogDatabase,
  now = new Date(),
): Promise<RuntimeLogRetentionResult> {
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError('runtime log retention requires a valid current time')
  }
  if (now.getUTCMinutes() >= 5) return Object.freeze({ ran: false, deleted: 0 })

  const cutoff = new Date(now.getTime() - RETENTION_DAYS_MS)
  const rows = await database.query(`
    WITH requested AS (
      SELECT (
        date_trunc('hour', $1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      ) AS retention_hour
    ), claimed AS (
      INSERT INTO runtime_log_retention_state (singleton, last_hour)
      SELECT TRUE, requested.retention_hour
      FROM requested
      ON CONFLICT (singleton) DO UPDATE
      SET last_hour = EXCLUDED.last_hour
      WHERE runtime_log_retention_state.last_hour < EXCLUDED.last_hour
      RETURNING singleton
    ), expired AS MATERIALIZED (
      SELECT log.id
      FROM runtime_logs AS log
      WHERE EXISTS (SELECT 1 FROM claimed)
        AND log.received_at < $2::timestamptz
      ORDER BY log.received_at, log.id
      LIMIT $3
      FOR UPDATE OF log SKIP LOCKED
    ), deleted AS (
      DELETE FROM runtime_logs AS log
      USING expired
      WHERE log.id = expired.id
      RETURNING log.id
    )
    SELECT
      EXISTS (SELECT 1 FROM claimed) AS ran,
      count(deleted.id)::integer AS deleted
    FROM deleted
  `, [now.toISOString(), cutoff.toISOString(), RETENTION_PAGE_LIMIT])

  const ran = rows[0]?.ran
  const deleted = Number(rows[0]?.deleted ?? Number.NaN)
  if (
    typeof ran !== 'boolean'
    || !Number.isSafeInteger(deleted)
    || deleted < 0
    || deleted > RETENTION_PAGE_LIMIT
    || (!ran && deleted !== 0)
  ) {
    throw new Error('runtime log hourly retention returned an invalid result')
  }
  return Object.freeze({ ran, deleted })
}
