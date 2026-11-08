import { isDeepStrictEqual } from 'node:util'
import { EngineError, type TaggedSql } from './engine.ts'
import {
  ENDING_COPY_FIXED_REFUSAL,
  ENDING_MARKED_REFUSAL,
  ENDING_REMNANT_CHANGE_REFUSAL,
  KINDLESS_ENDING_REFUSAL,
  THING_ENDING_CHANGED_REFUSAL,
} from './thing-ending-refusals.ts'
import {
  assertRenewalFits,
  endingColumnsFor,
  grantForNewEnding,
  parseEndingInput,
  type EndingColumns,
  type EndingGrant,
  type EndingPermissionThing,
  type EndingRule,
  type EndingTime,
} from './thing-endings.ts'

// The owner's own end on a thing: set at make, set, renewed or cleared on thing_edit and
// thing_upgrade. Setting, renewing and clearing are free. A setting takes a new grant from
// the thing's effective kind revision, or the kindless maker rule; a renewal must fit the
// grant stored with the end it replaces, even after an upgrade or a conversion; clearing
// ends the grant. An exact repeat writes nothing. Each change writes one
// thing_ending_changes row in the same transaction as the columns it changed.

/** The ending field of a request body: omitted, or the raw value the owner sent. */
export type EndingField =
  | Readonly<{ supplied: false }>
  | Readonly<{ supplied: true; value: unknown }>

export function endingField(body: Readonly<Record<string, unknown>>): EndingField {
  return Object.hasOwn(body, 'ending')
    ? Object.freeze({ supplied: true, value: body.ending })
    : Object.freeze({ supplied: false })
}

/**
 * The shape refusal (E3) for a sent ending, judged against this process's clock so a door
 * can answer before it writes anything; null when the shape is right. The transaction
 * judges the time limits again against the database clock.
 */
export function endingShapeRefusal(field: EndingField): string | null {
  if (!field.supplied) return null
  try {
    parseEndingInput(field.value, new Date())
    return null
  } catch (error) {
    if (error instanceof EngineError) return error.message
    throw error
  }
}

/** What the owner's door read about the thing, inside its transaction, after the thing's lock. */
export interface OwnerEndingState extends EndingPermissionThing {
  readonly id: number
  readonly parent_thing_id: number | null
  readonly end_reached: boolean
  readonly marked: boolean
  /** The ending_policy of the thing's effective kind revision, null without a kind. */
  readonly ending_policy: unknown
  readonly ending_rule: unknown
  readonly ending_grant: unknown
  readonly ending_set_by: number | null
  readonly ending_set_at: EndingTime | null
  readonly ending_deadline: EndingTime | null
  readonly ending_idle_seconds: number | null
  readonly ending_idle_anchor: EndingTime | null
  readonly ending_uses_left: number | null
  readonly ending_label: string | null
  /** The database's transaction time: the set time, and the clock the time limits use. */
  readonly now: EndingTime
}

export type OwnerEndingDecision =
  | Readonly<{ change: null }>
  | Readonly<{ change: 'set' | 'renew'; rule: EndingRule; grant: EndingGrant; columns: EndingColumns }>
  | Readonly<{ change: 'clear'; rule: unknown; grant: unknown }>

const NO_CHANGE: OwnerEndingDecision = Object.freeze({ change: null })

function toDate(value: EndingTime | null | undefined): Date | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function sameTime(left: EndingTime | null | undefined, right: EndingTime | null | undefined): boolean {
  return (toDate(left)?.getTime() ?? null) === (toDate(right)?.getTime() ?? null)
}

function isKindlessGrant(grant: unknown): boolean {
  return typeof grant === 'object' && grant !== null && (grant as Record<string, unknown>).kindless === true
}

/**
 * Whether new columns would leave every stored ending fact as it is. The set time alone
 * does not count: an at-only end sent again is the same end, while an unused-for or a
 * time-after-setting rule moves its clock and so renews.
 */
function sameEnding(state: OwnerEndingState, columns: EndingColumns): boolean {
  return isDeepStrictEqual(state.ending_rule, columns.ending_rule)
    && isDeepStrictEqual(state.ending_grant, columns.ending_grant)
    && state.ending_set_by === columns.ending_set_by
    && sameTime(state.ending_deadline, columns.ending_deadline)
    && state.ending_idle_seconds === columns.ending_idle_seconds
    && sameTime(state.ending_idle_anchor, columns.ending_idle_anchor)
    && state.ending_uses_left === columns.ending_uses_left
    && state.ending_label === columns.ending_label
}

/**
 * The owner's change to a thing's end. Refuses with E5 once the end has come, E6 for
 * anything but clearing on a copy, E4 on a thing with a later-holder mark, E14 for a
 * kindless thing its maker no longer owns, and E2 or E3 for a rule outside the grant.
 */
export function decideOwnerEnding(state: OwnerEndingState, value: unknown, actorId: number): OwnerEndingDecision {
  if (state.end_reached) throw new EngineError(409, ENDING_REMNANT_CHANGE_REFUSAL)
  const now = toDate(state.now) ?? new Date()
  const rule = parseEndingInput(value, now)
  if (rule === null) {
    return state.ending_rule == null
      ? NO_CHANGE
      : Object.freeze({ change: 'clear' as const, rule: state.ending_rule, grant: state.ending_grant })
  }
  if (state.parent_thing_id != null) throw new EngineError(409, ENDING_COPY_FIXED_REFUSAL)
  if (state.marked) throw new EngineError(409, ENDING_MARKED_REFUSAL)
  if (state.ending_rule == null) {
    const grant = grantForNewEnding(state, state.ending_policy, rule, now)
    return Object.freeze({ change: 'set' as const, rule, grant, columns: endingColumnsFor(rule, grant, actorId, now) })
  }
  if (isKindlessGrant(state.ending_grant) && state.owner_id !== state.maker_id) {
    throw new EngineError(403, KINDLESS_ENDING_REFUSAL)
  }
  assertRenewalFits(rule, state.ending_grant, now)
  const grant = state.ending_grant as EndingGrant
  const columns = endingColumnsFor(rule, grant, actorId, now)
  return sameEnding(state, columns) ? NO_CHANGE : Object.freeze({ change: 'renew' as const, rule, grant, columns })
}

/**
 * The end a new thing starts with: none when the field is omitted or null, otherwise the
 * rule inside the grant its kind's current revision (or the kindless maker rule) gives.
 */
export function newThingEnding(
  field: EndingField,
  thing: EndingPermissionThing,
  policy: unknown,
  now: Date,
): Readonly<{ rule: EndingRule; grant: EndingGrant; columns: EndingColumns }> | null {
  if (!field.supplied) return null
  const rule = parseEndingInput(field.value, now)
  if (rule === null) return null
  const grant = grantForNewEnding(thing, policy, rule, now)
  return Object.freeze({ rule, grant, columns: endingColumnsFor(rule, grant, thing.owner_id, now) })
}

type Row = Record<string, unknown>

async function rowsOf(promise: Promise<unknown>): Promise<Row[]> {
  const value = await promise
  if (!Array.isArray(value)) {
    throw new EngineError(500, 'database returned an invalid result; retry once, then contact the city operator')
  }
  return value as Row[]
}

/** The database's transaction time, the set time of an end written in this transaction. */
export async function transactionNow(transaction: TaggedSql): Promise<Date> {
  const rows = await rowsOf(transaction`/* thing-endings:owner-now */ SELECT transaction_timestamp() AS now`)
  const now = toDate(rows[0]?.now as EndingTime | undefined)
  if (!now) throw new EngineError(500, 'database returned an invalid result; retry once, then contact the city operator')
  return now
}

/**
 * Lock the actor, the thing's room and the thing, in the shared order, so the read that
 * follows sees every mark and change committed before this transaction held the thing.
 */
export async function lockOwnerEnding(transaction: TaggedSql, thingId: number, actorId: number): Promise<void> {
  await transaction`SELECT id FROM residents WHERE id = ${actorId} FOR NO KEY UPDATE`
  await transaction`SELECT place.id FROM places place
    JOIN things thing ON thing.place_id = place.id
    WHERE thing.id = ${thingId} FOR NO KEY UPDATE OF place`
  await transaction`SELECT id FROM things WHERE id = ${thingId} FOR UPDATE`
}

/** The thing's ending facts, read after lockOwnerEnding; null for a missing or withdrawn thing. */
export async function readOwnerEnding(transaction: TaggedSql, thingId: number): Promise<OwnerEndingState | null> {
  const rows = await rowsOf(transaction`
    /* thing-endings:owner-read */
    SELECT thing.id, thing.owner_id, thing.maker_id, thing.kind_id, thing.current_revision,
      thing.as_kind_id, thing.as_revision, thing.parent_thing_id,
      thing.ending_rule, thing.ending_grant, thing.ending_set_by, thing.ending_set_at,
      thing.ending_deadline, thing.ending_idle_seconds, thing.ending_idle_anchor,
      thing.ending_uses_left, thing.ending_label,
      thing_end_reached(thing.id) AS end_reached,
      EXISTS (SELECT 1 FROM thing_later_holder_marks mark WHERE mark.thing_id = thing.id) AS marked,
      revision.ending_policy, transaction_timestamp() AS now
    FROM things thing
    LEFT JOIN kind_revisions revision
      ON revision.kind_id = coalesce(thing.as_kind_id, thing.kind_id)
      AND revision.revision = coalesce(thing.as_revision, thing.current_revision)
    WHERE thing.id = ${thingId} AND thing.withdrawn_at IS NULL
  `)
  const row = rows[0]
  if (!row) return null
  const integer = (value: unknown) => (value == null ? null : Number(value))
  return Object.freeze({
    ...(row as unknown as OwnerEndingState),
    id: Number(row.id),
    owner_id: Number(row.owner_id),
    maker_id: Number(row.maker_id),
    kind_id: integer(row.kind_id),
    current_revision: integer(row.current_revision),
    as_kind_id: integer(row.as_kind_id),
    as_revision: integer(row.as_revision),
    parent_thing_id: integer(row.parent_thing_id),
    ending_set_by: integer(row.ending_set_by),
    ending_idle_seconds: integer(row.ending_idle_seconds),
    ending_uses_left: integer(row.ending_uses_left),
    ending_label: row.ending_label == null ? null : String(row.ending_label),
    end_reached: row.end_reached === true,
    marked: row.marked === true,
  })
}

/**
 * Write the owner's change: the ten ending columns (all null on a clear; the copy origin
 * is never touched) and one thing_ending_changes row. The thing must still be active and
 * not due, which the caller's lock makes certain; otherwise the guard's words answer.
 */
export async function writeOwnerEnding(
  transaction: TaggedSql,
  thingId: number,
  actorId: number,
  decision: Exclude<OwnerEndingDecision, { change: null }>,
): Promise<void> {
  const columns = decision.change === 'clear' ? null : decision.columns
  const rows = await rowsOf(transaction`
    /* thing-endings:owner-write */
    WITH changed AS (
      UPDATE things SET
        ending_rule = ${columns ? JSON.stringify(columns.ending_rule) : null}::jsonb,
        ending_grant = ${columns ? JSON.stringify(columns.ending_grant) : null}::jsonb,
        ending_set_by = ${columns?.ending_set_by ?? null}::integer,
        ending_set_at = ${columns?.ending_set_at ?? null}::timestamptz,
        ending_deadline = ${columns?.ending_deadline ?? null}::timestamptz,
        ending_idle_seconds = ${columns?.ending_idle_seconds ?? null}::integer,
        ending_idle_anchor = ${columns?.ending_idle_anchor ?? null}::timestamptz,
        ending_uses_left = ${columns?.ending_uses_left ?? null}::integer,
        ending_uses_spent_at = NULL,
        ending_label = ${columns?.ending_label ?? null}::text
      WHERE id = ${thingId} AND withdrawn_at IS NULL AND ended_at IS NULL
        AND NOT thing_end_reached(id)
      RETURNING id
    )
    INSERT INTO thing_ending_changes (thing_id, change, actor_id, rule, "grant")
    SELECT changed.id, ${decision.change}::text, ${actorId}::integer,
      ${JSON.stringify(decision.rule ?? null)}::jsonb, ${JSON.stringify(decision.grant ?? null)}::jsonb
    FROM changed
    RETURNING id
  `)
  if (rows.length !== 1) throw new EngineError(409, THING_ENDING_CHANGED_REFUSAL)
}

/**
 * The owner's whole change inside one transaction that already holds the thing (an
 * upgrade) or locks it now: read, decide, write. Returns whether anything changed.
 */
export async function applyOwnerEnding(
  transaction: TaggedSql,
  thingId: number,
  actorId: number,
  value: unknown,
  options: Readonly<{ lock: boolean }>,
): Promise<boolean> {
  if (options.lock) await lockOwnerEnding(transaction, thingId, actorId)
  const state = await readOwnerEnding(transaction, thingId)
  if (!state || state.owner_id !== actorId) throw new EngineError(409, THING_ENDING_CHANGED_REFUSAL)
  const decision = decideOwnerEnding(state, value, actorId)
  if (decision.change === null) return false
  await writeOwnerEnding(transaction, thingId, actorId, decision)
  return true
}
