import type { Resident } from './core.ts'
import { missingActiveThingRefusal } from './refusal-text.ts'
import { sql } from './db.ts'

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
}

/** One-way, owner-only withdrawal with the public event in the same transaction. */
export async function withdrawThing(
  actor: Resident,
  thingId: number,
  reason: 'withdrawn' | 'consumed' | 'destroyed' = 'withdrawn',
  expectedName?: string,
): Promise<WithdrawnThing | WithdrawalFailure> {
  const states = await sql`
    SELECT thing.id, thing.name, thing.owner_id, thing.withdrawn_at, thing.active_offer_id,
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
    WITH withdrawable AS (
      SELECT thing.id
      FROM things thing
      LEFT JOIN transfer_offers offer ON offer.asset_type = 'thing'
        AND offer.asset_id = thing.id AND offer.status = 'open'
      WHERE thing.id = ${thingId} AND thing.owner_id = ${actor.id}
        AND thing.name = ${confirmedName}
        AND thing.withdrawn_at IS NULL AND thing.active_offer_id IS NULL
        AND offer.id IS NULL
      FOR UPDATE OF thing
    ), changed AS (
      UPDATE things SET withdrawn_at = clock_timestamp()
      WHERE id IN (SELECT id FROM withdrawable)
      RETURNING id, withdrawn_at
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'thing_withdrawn', ${actor.handle}, jsonb_build_object(
        'thing_id', id, 'reason', ${reason}::text
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
