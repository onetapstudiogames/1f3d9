import type { Resident } from './core.ts'
import { missingActiveThingRefusal } from './refusal-text.ts'
import { sql } from './db.ts'
import { THING_REMNANT_REFUSAL } from './thing-ending-refusals.ts'

export type WithdrawalFailure = Readonly<{
  error: string
  status: 403 | 404 | 409
}>

export type WithdrawnThing = Readonly<{
  id: number
  withdrawn_at: string
}>

interface ThingState {
  id: number
  name: string
  owner_id: number
  withdrawn_at: string | null
  active_offer_id: number | null
  has_open_offer: boolean
  ended_at?: string | null
  end_reached?: boolean
}

/**
 * One-way, owner-only withdrawal with the public event in the same transaction. A thing
 * in recordedThingIds (its end was recorded by this request a moment ago), or whose end
 * came unrecorded, refuses E7; an older remnant is withdrawn under its withdraw writer,
 * and an end try still waiting is skipped in the same write.
 */
export async function withdrawThing(
  actor: Resident,
  thingId: number,
  reason: 'withdrawn' | 'consumed' | 'destroyed' = 'withdrawn',
  expectedName?: string,
  recordedThingIds: readonly number[] = [],
): Promise<WithdrawnThing | WithdrawalFailure> {
  const states = await sql`
    SELECT thing.id, thing.name, thing.owner_id, thing.withdrawn_at, thing.active_offer_id,
      thing.ended_at, thing_end_reached(thing.id) AS end_reached,
      (offer.id IS NOT NULL) AS has_open_offer
    FROM things thing
    LEFT JOIN transfer_offers offer ON offer.asset_type = 'thing'
      AND offer.asset_id = thing.id AND offer.status = 'open'
    WHERE thing.id = ${thingId}
  ` as ThingState[]
  const thing = states[0]
  if (!thing) {
    return Object.freeze({
      error: missingActiveThingRefusal(`thing_id ${thingId}`),
      status: 404,
    })
  }
  if (thing.owner_id !== actor.id) {
    return Object.freeze({ error: 'only the thing owner may withdraw it', status: 403 })
  }
  if (thing.withdrawn_at) {
    return Object.freeze({
      error: `thing_id ${thingId} is already withdrawn; choose another active thing because withdrawal is permanent`,
      status: 409,
    })
  }
  if (recordedThingIds.includes(thingId) || (thing.end_reached === true && thing.ended_at == null)) {
    return Object.freeze({ error: THING_REMNANT_REFUSAL, status: 409 })
  }
  if (thing.active_offer_id != null || thing.has_open_offer) {
    return Object.freeze({
      error: 'thing cannot be withdrawn while it has an open sale offer; close that offer before withdrawing the thing',
      status: 409,
    })
  }
  if (reason === 'withdrawn' && thing.name !== expectedName) {
    return Object.freeze({
      error: `thing_name does not exactly match the current name of thing_id ${thingId}; re-read the thing and send its exact current name`,
      status: 409,
    })
  }

  const confirmedName = reason === 'withdrawn' ? expectedName! : thing.name

  const rows = await sql`
    WITH activity_actor AS MATERIALIZED (
      SELECT id FROM residents WHERE id = ${actor.id} FOR NO KEY UPDATE
    ), activity_room AS MATERIALIZED (
      SELECT place.id FROM places place JOIN things thing ON thing.place_id = place.id
      WHERE thing.id = ${thingId} AND EXISTS (SELECT 1 FROM activity_actor)
      FOR NO KEY UPDATE OF place
    ), withdrawable AS (
      SELECT thing.id, thing.end_program_state
      FROM things thing
      LEFT JOIN transfer_offers offer ON offer.asset_type = 'thing'
        AND offer.asset_id = thing.id AND offer.status = 'open'
      WHERE thing.id = ${thingId} AND thing.owner_id = ${actor.id}
        AND thing.place_id = (SELECT id FROM activity_room)
        AND thing.name = ${confirmedName}
        AND thing.withdrawn_at IS NULL AND thing.active_offer_id IS NULL
        AND offer.id IS NULL
      FOR UPDATE OF thing
    ), changed AS (
      -- The withdraw writer lets a remnant pass the ending guard, set in this same
      -- statement; an end try still waiting is skipped, and any other result is kept.
      UPDATE things SET withdrawn_at = clock_timestamp(), held_by = NULL,
        end_program_state = CASE WHEN things.end_program_state = 'pending'
          THEN 'skipped' ELSE things.end_program_state END,
        end_program_result = CASE WHEN things.end_program_state = 'pending'
          THEN '{"skipped": "withdrawn"}'::jsonb ELSE things.end_program_result END
      WHERE id IN (SELECT id FROM withdrawable)
        AND (SELECT set_config('city.ending_writer', 'withdraw:' || ${thingId}::text, true)) IS NOT NULL
      RETURNING id, place_id, withdrawn_at
    ), program_change AS (
      INSERT INTO thing_ending_changes (thing_id, change, actor_id, result)
      SELECT changed.id, 'program', ${actor.id}::integer, '{"skipped": "withdrawn"}'::jsonb
      FROM changed JOIN withdrawable ON withdrawable.id = changed.id
      WHERE withdrawable.end_program_state = 'pending'
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'thing_withdrawn', ${actor.handle}, jsonb_build_object(
        'thing_id', id, 'place_id', place_id, 'reason', ${reason}::text
      )
      FROM changed
    )
    SELECT id, withdrawn_at FROM changed
  ` as WithdrawnThing[]
  return rows[0] ?? Object.freeze({
    error: 'thing ownership, withdrawal, or offer state changed; re-read it',
    status: 409,
  })
}
