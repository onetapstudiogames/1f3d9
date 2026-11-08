// Waiting on the database clock instead of the test process clock. A fixed sleep after a
// wait step can wake before PostgreSQL's now() has passed the step's due_at on a slow or
// skewed runner; these helpers poll PostgreSQL itself, so the step is due when they return.
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import type { Pool } from 'pg'

type ClockDatabase = Pick<Pool, 'query'>

const POLL_MS = 25
const MAX_WAIT_MS = 30_000

/**
 * Returns once PostgreSQL's clock_timestamp() is more than one millisecond past the boundary.
 * The driver cuts times to milliseconds, so the extra millisecond keeps a later comparison
 * strictly greater. Any transaction started after this returns reads now() past it too.
 */
export async function waitPastDatabaseTime(database: ClockDatabase, boundary: Date): Promise<Date> {
  const startedAt = Date.now()
  for (;;) {
    const { rows } = await database.query<{ observed_at: Date; passed: boolean }>(`
      SELECT clock_timestamp() AS observed_at,
        clock_timestamp() > $1::timestamptz + interval '1 millisecond' AS passed
    `, [boundary.toISOString()])
    const row = rows[0]!
    if (row.passed) return row.observed_at
    assert.ok(Date.now() - startedAt < MAX_WAIT_MS, `the database clock did not pass ${boundary.toISOString()}`)
    await delay(POLL_MS)
  }
}

/**
 * Waits until every unresolved waiting step is due on the database clock, optionally only
 * those whose source is one of the named things. Fails when there is none to wait for, so a
 * test cannot pass by waiting on nothing.
 */
export async function waitPastPendingEffects(
  database: ClockDatabase,
  sourceThingIds: readonly number[] | null = null,
): Promise<Date> {
  const { rows } = await database.query<{ due_at: Date | null }>(`
    SELECT max(pending.due_at) AS due_at
    FROM pending_effects pending
    LEFT JOIN effect_resolutions resolution ON resolution.pending_effect_id = pending.id
    WHERE resolution.id IS NULL
      AND ($1::int[] IS NULL OR pending.source_thing_id = ANY($1::int[]))
  `, [sourceThingIds === null ? null : [...sourceThingIds]])
  const dueAt = rows[0]?.due_at ?? null
  assert.ok(dueAt !== null, 'there is no unresolved waiting step to wait for')
  return waitPastDatabaseTime(database, dueAt)
}
