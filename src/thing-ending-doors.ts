import { engineSql, type TaggedSql } from './engine.ts'
import {
  ENDING_GIFT_ACCEPT_REFUSAL,
  ENDING_GIVE_REFUSAL,
  THING_REMNANT_REFUSAL,
} from './thing-ending-refusals.ts'

// What a door that hands a thing over reads about its end, after it recorded a due end
// and after its own missing and not-yours answers. Due is judged in the database at
// transaction time, so the door, the engine and the guard agree.

export interface DoorEndFacts {
  readonly ownerId: number
  readonly endingSet: boolean
  readonly endReached: boolean
  readonly endedAt: string | null
}

export interface GiveEndingCheck {
  readonly thingId: number
  readonly actorId: number
  readonly recipientId: number | null
  /** The ids this request's recorder returned: each just became a remnant. */
  readonly recorded: readonly number[]
  /** True when the give is the accept of a held gift (decision #158). */
  readonly accepting?: boolean
}

/** The end facts of an active thing, or null when no such active thing exists. */
export async function readDoorEndFacts(thingId: number, db: TaggedSql = engineSql): Promise<DoorEndFacts | null> {
  const found = await db`
    /* thing-endings:door-facts */
    SELECT owner_id, ending_rule IS NOT NULL AS ending_set, ended_at,
      thing_end_reached(id) AS end_reached
    FROM things WHERE id = ${thingId} AND withdrawn_at IS NULL
  ` as unknown
  const row = Array.isArray(found) ? found[0] as Record<string, unknown> | undefined : undefined
  if (!row) return null
  return Object.freeze({
    ownerId: Number(row.owner_id),
    endingSet: row.ending_set === true,
    endReached: row.end_reached === true,
    endedAt: row.ended_at == null ? null : String(row.ended_at),
  })
}

/** True when the thing just became a remnant: this request recorded it, or its end came unrecorded. */
export function justEnded(facts: DoorEndFacts, thingId: number, recorded: readonly number[]): boolean {
  return recorded.includes(thingId) || (facts.endReached && facts.endedAt === null)
}

/**
 * The end refusal for a give, or null when the give may go on. A thing that is missing or
 * not the giver's is left to the door's own 404 and 403. E7 for a thing that just became a
 * remnant; E9 (E9b when accepting a held gift) while an end is set and has not come; an
 * older remnant has no clock left and may be given. A give to yourself changes no hands,
 * so it never refuses E9.
 */
export function giveEndingRefusal(facts: DoorEndFacts | null, check: GiveEndingCheck): string | null {
  if (!facts || facts.ownerId !== check.actorId) return null
  if (justEnded(facts, check.thingId, check.recorded)) return THING_REMNANT_REFUSAL
  if (!facts.endingSet || facts.endReached || check.recipientId === check.actorId) return null
  return check.accepting === true ? ENDING_GIFT_ACCEPT_REFUSAL : ENDING_GIVE_REFUSAL
}

/** What a claim door reads about a thing's end before it opens a reservation or takes a payment. */
export interface ClaimEndFacts {
  /** The end has come: recorded, or due at the transaction time. */
  readonly reached: boolean
  /** The end has come, or comes before this many seconds pass on the database clock. */
  readonly withinWindow: boolean
}

type PositionalQuery = (text: string, params: readonly unknown[]) => Promise<unknown>

// The clock is the one the reservation UPDATE uses for its window, so a claim refused here
// is the claim the UPDATE's own end clause would refuse.
const CLAIM_END_SQL = `
  /* thing-endings:claim-window */
  SELECT thing_end_reached($1::integer) AS reached,
    coalesce(thing_end_due_at($1::integer) <= clock_timestamp() + make_interval(secs => $2::integer), false)
      AS within_window
`

/**
 * The end facts a claim door judges by. A thing with no end, or no such thing, reads neither.
 * Pass the window the door's reservation would open for.
 */
export async function readClaimEndFacts(
  query: PositionalQuery,
  thingId: number,
  windowSeconds: number,
): Promise<ClaimEndFacts> {
  const found = await query(CLAIM_END_SQL, [thingId, windowSeconds])
  const row = Array.isArray(found) ? found[0] as Record<string, unknown> | undefined : undefined
  const reached = row?.reached === true
  return Object.freeze({ reached, withinWindow: reached || row?.within_window === true })
}

/** Payment attempt statuses that hold no evidence: a new payment would start from nothing. */
const SPENT_ATTEMPT_STATUSES: ReadonlySet<string> = new Set(['invalid', 'expired'])

/**
 * True when a claim may still answer E8: no payment attempt, or only one that holds no
 * evidence. A claim with a settling, pending, review or completed attempt, or with payment
 * evidence on its offer, never answers E8, so accepted evidence keeps its sale (#32).
 */
export function claimMayRefuseForEnd(attemptStatus: string | null | undefined, evidencePending = false): boolean {
  if (evidencePending) return false
  return attemptStatus == null || SPENT_ATTEMPT_STATUSES.has(attemptStatus)
}
