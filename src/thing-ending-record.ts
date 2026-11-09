import { postgresErrorCode } from './core-primitives.ts'
import { EngineError, engineSql, withEngineTransaction, type TaggedSql } from './engine.ts'
import { PUBLIC_SYSTEM_EVENT_ACTORS } from './public-events.ts'
import { THING_FIRST_LABEL_AT_SQL } from './thing-ending-sql.ts'
import { dueCause, type EndingDueRow } from './thing-endings.ts'

// The one recorder of a thing's end. A door calls it before a resident-triggered write
// that names a thing; the write then proceeds or refuses by what this call returned.
// Each end is written in its own short transaction under the thing's row lock and the
// record:<id> writer, with one thing_ending_changes row and one thing_ended event whose
// actor is the city. Due is judged in the database at transaction time, never against
// this process's clock, so the recorder and the guard always agree.

type Row = Record<string, unknown>

async function rows(promise: Promise<unknown>): Promise<Row[]> {
  const value = await promise
  if (!Array.isArray(value)) {
    throw new EngineError(500, 'database returned an invalid result; retry once, then contact the city operator')
  }
  return value as Row[]
}

function thingIdList(thingIds: readonly number[]): number[] {
  return [...new Set(thingIds.filter(id => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b)
}

/** The ids among these whose end has come and is not yet recorded. A withdrawn thing is never recorded. */
async function dueUnrecorded(ids: readonly number[], db: TaggedSql): Promise<number[]> {
  const found = await rows(db`
    /* thing-endings:due-ids */
    SELECT id FROM things
    WHERE id = ANY(${ids}::int[]) AND ending_rule IS NOT NULL AND ended_at IS NULL
      AND EXISTS (SELECT 1 FROM residents owner WHERE owner.id = things.owner_id AND owner.retirement_state = 'active')
      AND withdrawn_at IS NULL AND thing_end_due(id, transaction_timestamp())
    ORDER BY id
  `)
  return found.map(row => Number(row.id)).filter(id => Number.isSafeInteger(id) && id > 0)
}

const LOCK_SQL = `
  /* thing-endings:record-lock */
  SELECT thing.ending_rule, thing.ending_set_at, thing.ending_deadline, thing.ending_idle_seconds,
    thing.ending_idle_anchor, thing.ending_uses_left, thing.ending_uses_spent_at, thing.ending_label,
    thing.ending_copied_from, thing.ended_at, thing.withdrawn_at,
    ${THING_FIRST_LABEL_AT_SQL} AS first_label_at,
    thing_end_due(thing.id, transaction_timestamp()) AS due
  FROM things thing
  WHERE thing.id = $1::integer
    AND EXISTS (SELECT 1 FROM residents owner WHERE owner.id = thing.owner_id AND owner.retirement_state = 'active')
  FOR UPDATE OF thing
`

// One UPDATE of one thing (the writer covers one thing at a time). The owner at the end is
// the recipient of the latest transfer at or before the end, else the maker. The program
// waits when the effective kind revision lists a trait with an end key, the same test the
// snapshot's has_end_trait uses. The result column is never written here.
const RECORD_SQL = `
  /* thing-endings:record */
  WITH ended AS (
    UPDATE things thing SET
      ended_at = thing_end_due_at(thing.id),
      ended_cause = $2::text,
      ended_owner_id = coalesce((
        SELECT transfer.to_id FROM transfers transfer
        WHERE transfer.asset_type = 'thing' AND transfer.asset_id = thing.id
          AND transfer.created_at <= thing_end_due_at(thing.id)
        ORDER BY transfer.created_at DESC, transfer.id DESC
        LIMIT 1
      ), thing.maker_id),
      end_program_state = CASE WHEN EXISTS (
        SELECT 1
        FROM kind_revision_traits link
        JOIN traits trait ON trait.id = link.trait_id
        WHERE link.kind_id = coalesce(thing.as_kind_id, thing.kind_id)
          AND link.revision = coalesce(thing.as_revision, thing.current_revision)
          AND trait.recipe ? 'end'
      ) THEN 'pending' ELSE 'none' END
    WHERE thing.id = $1::integer
      AND thing.ended_at IS NULL
      AND thing.withdrawn_at IS NULL
      AND thing_end_due(thing.id, transaction_timestamp())
      AND (SELECT set_config('city.ending_writer', 'record:' || $1::text, true)) IS NOT NULL
    RETURNING thing.id, thing.place_id, thing.ended_at, thing.ended_cause, thing.ended_owner_id,
      thing.end_program_state, thing.ending_rule, thing.ending_grant
  ), change AS (
    INSERT INTO thing_ending_changes (thing_id, change, rule, "grant", result)
    SELECT ended.id, 'end', ended.ending_rule, ended.ending_grant, jsonb_build_object(
      'cause', ended.ended_cause, 'ended_at', ended.ended_at,
      'owner_id', ended.ended_owner_id, 'program_state', ended.end_program_state
    )
    FROM ended
    RETURNING id
  ), notice AS (
    INSERT INTO events (kind, actor, detail)
    SELECT 'thing_ended', $3::text, jsonb_build_object(
      'thing_id', ended.id, 'place_id', ended.place_id, 'cause', ended.ended_cause,
      'ended_at', ended.ended_at, 'owner_id', owner.id, 'owner', owner.handle,
      'program_state', ended.end_program_state
    )
    FROM ended JOIN residents owner ON owner.id = ended.ended_owner_id
    RETURNING id
  )
  SELECT ended.id, (SELECT count(*) FROM change)::int AS changes, (SELECT count(*) FROM notice)::int AS notices
  FROM ended
`

async function recordOne(thingId: number, db: TaggedSql): Promise<boolean> {
  return withEngineTransaction(db, async transaction => {
    if (!transaction.query) {
      throw new EngineError(500, 'transaction query support is unavailable; contact the city operator to restore transaction support before retrying')
    }
    const owners = await rows(transaction`
      SELECT owner.retirement_state FROM residents owner
      JOIN things thing ON thing.owner_id = owner.id
      WHERE thing.id = ${thingId} FOR KEY SHARE OF owner
    `)
    if (owners.some(owner => owner.retirement_state === 'retiring' || owner.retirement_state === 'retired')) return false
    const locked = (await rows(transaction.query(LOCK_SQL, [thingId])))[0]
    if (!locked || locked.due !== true || locked.ended_at != null || locked.withdrawn_at != null) return false
    const cause = dueCause(locked as unknown as EndingDueRow & Readonly<{ ending_copied_from?: number | null }>)
    if (cause === null) {
      // SQL says due but no condition names a time: the stored rule is unreadable.
      // Writing nothing keeps things_ended_consistent from failing the caller's door.
      console.error('thing ending not recorded: no condition was met', { thing_id: thingId })
      return false
    }
    const written = await rows(transaction.query(RECORD_SQL, [thingId, cause, PUBLIC_SYSTEM_EVENT_ACTORS.city]))
    return written.length === 1
  })
}

/**
 * Record each due end among these things, one short transaction per thing. Returns the
 * ids recorded in this call: none when nothing was due, each was already recorded, or the
 * thing was withdrawn (a withdrawn thing is never recorded and returns no id). A
 * door tells a thing that just became a remnant (refuse E7) from one that already was
 * only by this value. Pass engineSql or the request's sql, never a wrapped executor.
 */
export async function recordDueEnd(thingIds: readonly number[], db: TaggedSql = engineSql): Promise<readonly number[]> {
  const ids = thingIdList(thingIds)
  if (ids.length === 0) return Object.freeze([])
  const recorded: number[] = []
  for (const thingId of await dueUnrecorded(ids, db)) {
    if (await recordOne(thingId, db)) recorded.push(thingId)
  }
  return Object.freeze(recorded)
}

/**
 * The recorder for a door that must not fail because recording failed: the error is
 * logged without detail and the door goes on. Its own due check at transaction time
 * still refuses a thing whose end has come, which the next request records.
 */
export async function recordDueEndQuietly(thingIds: readonly number[], db: TaggedSql = engineSql): Promise<readonly number[]> {
  try {
    return await recordDueEnd(thingIds, db)
  } catch (error) {
    const code = postgresErrorCode(error)
    console.error('thing ending record failed', {
      thing_ids: thingIdList(thingIds),
      ...(code && /^[0-9A-Z]{5}$/u.test(code) ? { error_code: code } : {}),
    })
    return Object.freeze([])
  }
}
