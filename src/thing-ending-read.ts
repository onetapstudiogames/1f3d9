import { MODERATED_TEXT } from './moderation.ts'
import {
  endingDueAt,
  endingReached,
  endingStatus,
  endTryGates,
  THING_FIRST_LABEL_AT_SQL,
  type EndingObject,
  type EndingTime,
  type EndProgramState,
  type ResidentRef,
  type ThingEndingRow,
} from './thing-endings.ts'
import { endProgramStatement } from './use-labels.ts'

// The live read of a thing's end, for every read that carries the full ending object:
// one SQL fragment a read joins under the alias `thing`, and one tolerant mapper. The end
// is judged at the database's transaction time, the same clock and the same expression as
// thing_end_reached, never at the server's clock. A read never records an end (#37). A
// stored end that cannot be read gives ending null and never hides the row it rides on,
// because offer reads feed claims and payment recovery.

type QueryRow = Record<string, unknown>
type UnknownRecord = Record<string, unknown>

/**
 * The columns a read selects with THING_ENDING_READ_JOIN. The things row must be aliased
 * `thing`; the names are prefixed so they never meet a column of the row they ride on.
 */
export const THING_ENDING_READ_COLUMNS = `
      thing_ending.facts AS thing_ending_facts,
      thing_ending.reached AS thing_ending_reached,
      thing.withdrawn_at IS NOT NULL AS thing_ending_withdrawn,
      transaction_timestamp() AS thing_ending_checked_at`

/**
 * Everything the full ending object needs, read in the same statement as the row: the
 * stored end, the ending_policy and traits of the effective kind revision, whether that
 * kind is maintainer-hidden, each trait's own hidden mark, and the end try's gate inputs
 * (the owner's waking, carried, in a sale on any channel, the room's dials).
 */
export const THING_ENDING_READ_JOIN = `
    LEFT JOIN LATERAL (
      SELECT
        thing.ended_at IS NOT NULL
          OR coalesce(thing_end_due_at_row(thing) <= transaction_timestamp(), false) AS reached,
        jsonb_build_object(
          'id', thing.id,
          'kind_id', thing.kind_id,
          'current_revision', thing.current_revision,
          'as_kind_id', thing.as_kind_id,
          'as_revision', thing.as_revision,
          'owner_id', thing.owner_id,
          'maker_id', thing.maker_id,
          'parent_thing_id', thing.parent_thing_id,
          'ending_rule', thing.ending_rule,
          'ending_grant', thing.ending_grant,
          'ending_set_by', thing.ending_set_by,
          'ending_set_at', thing.ending_set_at,
          'ending_deadline', thing.ending_deadline,
          'ending_idle_seconds', thing.ending_idle_seconds,
          'ending_idle_anchor', thing.ending_idle_anchor,
          'ending_uses_left', thing.ending_uses_left,
          'ending_uses_spent_at', thing.ending_uses_spent_at,
          'ending_label', thing.ending_label,
          'ending_copied_from', thing.ending_copied_from,
          'ending_copied_at', thing.ending_copied_at,
          'ended_at', thing.ended_at,
          'ended_cause', thing.ended_cause,
          'end_program_state', thing.end_program_state,
          'end_program_result', thing.end_program_result,
          'first_label_at', CASE WHEN thing.ending_rule IS NOT NULL THEN ${THING_FIRST_LABEL_AT_SQL} END,
          'set_by', (
            SELECT jsonb_build_object('id', setter.id, 'handle', setter.handle)
            FROM residents setter WHERE setter.id = thing.ending_set_by
          ),
          'owner_at_end', (
            SELECT jsonb_build_object('id', end_owner.id, 'handle', end_owner.handle)
            FROM residents end_owner WHERE end_owner.id = thing.ended_owner_id
          ),
          'policy', (
            SELECT revision.ending_policy
            FROM kind_revisions revision
            WHERE revision.kind_id = coalesce(thing.as_kind_id, thing.kind_id)
              AND revision.revision = coalesce(thing.as_revision, thing.current_revision)
          ),
          'kind_hidden', coalesce((
            SELECT moderation.action
            FROM moderation_actions moderation
            WHERE moderation.target_type = 'kind'
              AND moderation.target_id = coalesce(thing.as_kind_id, thing.kind_id)
            ORDER BY moderation.created_at DESC, moderation.id DESC
            LIMIT 1
          ), 'restore') = 'remove',
          'has_end_trait', EXISTS (
            SELECT 1
            FROM kind_revision_traits link
            JOIN traits trait ON trait.id = link.trait_id
            WHERE link.kind_id = coalesce(thing.as_kind_id, thing.kind_id)
              AND link.revision = coalesce(thing.as_revision, thing.current_revision)
              AND trait.recipe ? 'end'
          ),
          'traits', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
              'name', trait.name,
              'recipe', trait.recipe,
              'hidden', coalesce((
                SELECT moderation.action
                FROM moderation_actions moderation
                WHERE moderation.target_type = 'trait' AND moderation.target_id = trait.id
                ORDER BY moderation.created_at DESC, moderation.id DESC
                LIMIT 1
              ), 'restore') = 'remove'
            ) ORDER BY link.position)
            FROM kind_revision_traits link
            JOIN traits trait ON trait.id = link.trait_id
            WHERE link.kind_id = coalesce(thing.as_kind_id, thing.kind_id)
              AND link.revision = coalesce(thing.as_revision, thing.current_revision)
          ), '[]'::jsonb),
          'wake_enabled', thing.wake_enabled,
          'held_by', thing.held_by,
          'in_sale', thing.active_offer_id IS NOT NULL OR EXISTS (
            SELECT 1 FROM transfer_offers sale
            WHERE sale.asset_type = 'thing' AND sale.asset_id = thing.id AND sale.status = 'open'
          ),
          'room', (
            SELECT jsonb_build_object(
              'owner_id', room.owner_id,
              'wake_visitors', room.wake_visitors,
              'wake_pins', room.wake_pins,
              'wake_block_thing_ids', room.wake_block_thing_ids,
              'wake_block_resident_ids', room.wake_block_resident_ids,
              'retired_at', room.retired_at
            )
            FROM places room WHERE room.id = thing.place_id
          )
        ) AS facts
    ) thing_ending ON true`

export type AssetState = 'active' | 'remnant' | 'withdrawn'

/** The fields a thing's offer read carries beside the offer. */
export interface ThingEndingFields {
  readonly asset_state: AssetState
  readonly ending: EndingObject | null
  readonly end_program_summary: string | null
  readonly ending_checked_at: string | null
}

/** The fields, plus whether the end has come by the database's own judgement. */
export interface ThingEndingRead extends ThingEndingFields {
  readonly reached: boolean
}

const PROGRAM_STATES: ReadonlySet<string> = new Set(['none', 'pending', 'ran', 'skipped'])

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function time(value: unknown): EndingTime | null {
  return typeof value === 'string' || value instanceof Date ? value : null
}

function integers(value: unknown): readonly number[] | null {
  return Array.isArray(value) ? value.filter((item): item is number => integer(item) !== null) : null
}

function residentRef(value: unknown): ResidentRef | null {
  if (!isRecord(value)) return null
  const id = integer(value.id)
  const handle = text(value.handle)
  return id !== null && handle !== null ? { id, handle } : null
}

function checkedDate(value: unknown): Date | null {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? date : null
}

function endingRow(facts: UnknownRecord): ThingEndingRow | null {
  const id = integer(facts.id)
  const ownerId = integer(facts.owner_id)
  const makerId = integer(facts.maker_id)
  if (id === null || ownerId === null || makerId === null) return null
  const state = text(facts.end_program_state)
  return {
    id,
    kind_id: integer(facts.kind_id),
    current_revision: integer(facts.current_revision),
    as_kind_id: integer(facts.as_kind_id),
    as_revision: integer(facts.as_revision),
    owner_id: ownerId,
    maker_id: makerId,
    parent_thing_id: integer(facts.parent_thing_id),
    ending_rule: facts.ending_rule ?? null,
    ending_grant: facts.ending_grant ?? null,
    ending_set_by: integer(facts.ending_set_by),
    ending_set_at: time(facts.ending_set_at),
    ending_deadline: time(facts.ending_deadline),
    ending_idle_seconds: integer(facts.ending_idle_seconds),
    ending_idle_anchor: time(facts.ending_idle_anchor),
    ending_uses_left: integer(facts.ending_uses_left),
    ending_uses_spent_at: time(facts.ending_uses_spent_at),
    ending_label: text(facts.ending_label),
    ending_copied_from: integer(facts.ending_copied_from),
    ending_copied_at: time(facts.ending_copied_at),
    ended_at: time(facts.ended_at),
    ended_cause: text(facts.ended_cause),
    end_program_state: (state !== null && PROGRAM_STATES.has(state) ? state : 'none') as EndProgramState,
    end_program_result: facts.end_program_result ?? null,
    first_label_at: time(facts.first_label_at),
    set_by: residentRef(facts.set_by),
    owner_at_end: residentRef(facts.owner_at_end),
    has_end_trait: facts.has_end_trait === true,
    kind_hidden: facts.kind_hidden === true,
  }
}

/**
 * The moment endingStatus judges at. The database compares microseconds and the row
 * arrives in milliseconds, so within one millisecond of the due time the two could
 * disagree; the database's answer wins, and the object reads as it does.
 */
function judgedAt(row: ThingEndingRow, reached: boolean, checkedAt: Date): Date {
  if (endingReached(row, checkedAt) === reached) return checkedAt
  const due = endingDueAt(row)
  if (!due) return checkedAt
  return reached ? new Date(Math.max(due.getTime(), checkedAt.getTime())) : new Date(due.getTime() - 1)
}

function traitsOf(value: unknown): readonly Readonly<{ name: string; recipe: unknown }>[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map(trait => ({
    name: trait.hidden === true ? MODERATED_TEXT : text(trait.name) ?? MODERATED_TEXT,
    recipe: trait.recipe ?? null,
  }))
}

function endingObject(facts: UnknownRecord, reached: boolean, checkedAt: Date): EndingObject | null {
  const row = endingRow(facts)
  if (!row) return null
  const room = isRecord(facts.room) ? facts.room : {}
  const gates = endTryGates({
    id: row.id,
    owner_id: row.owner_id,
    wake_enabled: facts.wake_enabled === true,
    held_by: integer(facts.held_by),
    in_sale: facts.in_sale === true,
    end_program_state: row.end_program_state,
    has_end_trait: row.has_end_trait,
  }, {
    owner_id: integer(room.owner_id),
    wake_visitors: typeof room.wake_visitors === 'boolean' ? room.wake_visitors : null,
    wake_pins: integers(room.wake_pins),
    wake_block_thing_ids: integers(room.wake_block_thing_ids),
    wake_block_resident_ids: integers(room.wake_block_resident_ids),
    retired_at: time(room.retired_at),
  })
  return {
    ...endingStatus(row, facts.policy ?? null, gates, judgedAt(row, reached, checkedAt)),
    checked_at: checkedAt.toISOString(),
  }
}

/**
 * The end fields of a row read with THING_ENDING_READ_COLUMNS. asset_state comes from
 * the two database booleans; a withdrawn thing carries no ending and no summary. It never
 * throws: an end it cannot read gives ending and end_program_summary null.
 */
export function thingEndingRead(row: QueryRow | undefined): ThingEndingRead {
  const reached = row?.thing_ending_reached === true
  const withdrawn = row?.thing_ending_withdrawn === true
  const checkedAt = checkedDate(row?.thing_ending_checked_at)
  const assetState: AssetState = withdrawn ? 'withdrawn' : reached ? 'remnant' : 'active'
  const facts = row?.thing_ending_facts
  let ending: EndingObject | null = null
  let summary: string | null = null
  if (!withdrawn && isRecord(facts) && checkedAt) {
    try {
      ending = endingObject(facts, reached, checkedAt)
      summary = ending ? endProgramStatement(traitsOf(facts.traits)) : null
    } catch {
      ending = null
      summary = null
    }
  }
  return {
    reached,
    asset_state: assetState,
    ending,
    end_program_summary: summary,
    ending_checked_at: checkedAt?.toISOString() ?? null,
  }
}

/** The answer fields alone, without the reached flag the offer phase reads. */
export function thingEndingFields(read: ThingEndingRead): ThingEndingFields {
  return {
    asset_state: read.asset_state,
    ending: read.ending,
    end_program_summary: read.end_program_summary,
    ending_checked_at: read.ending_checked_at,
  }
}

/** One thing's end fields by id, for an answer that names a thing; null when no such thing. */
export async function readThingEnding(
  query: (text: string, params: readonly unknown[]) => Promise<readonly QueryRow[]>,
  thingId: number,
): Promise<ThingEndingFields | null> {
  const rows = await query(`
    /* thing-endings:read */
    SELECT ${THING_ENDING_READ_COLUMNS}
    FROM things thing
    ${THING_ENDING_READ_JOIN}
    WHERE thing.id = $1
  `, [thingId])
  return rows[0] ? thingEndingFields(thingEndingRead(rows[0])) : null
}
