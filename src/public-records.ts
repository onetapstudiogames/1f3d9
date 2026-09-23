import { sql } from './db.ts'
import { moderatePlaceDetails, moderatePublicRows } from './moderation-store.ts'
import type { PlaceRow, ThingRow } from './world-support.ts'
import { noteBodyWithheldSql, publicNoteRow } from './walk-to-read.ts'
import { isWorldRootRow, WORLD_ROOT_PURPOSE } from './world-root.ts'

export type PublicPlaceRecord = Readonly<PlaceRow & Record<string, unknown>>
export type PublicThingRecord = Readonly<ThingRow & Record<string, unknown>>
export type PublicNoteRecord = Readonly<{
  id: number
  place_id: number
  author: string
  created_at: string
} & Record<string, unknown>>

/**
 * Read one current place by an already-validated ID from 1 through 2,147,483,647.
 * Returns its moderated public record, or null when that place does not exist.
 */
export type PublicPlaceRecordQuery = (
  text: string,
  params: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>

export type PublicPlaceRecordModerator = (
  rows: readonly PublicPlaceRecord[],
) => Promise<readonly PublicPlaceRecord[]>

const executePublicPlaceRecordQuery: PublicPlaceRecordQuery = async (text, params) =>
  await sql.query(text, [...params]) as readonly Record<string, unknown>[]

const moderatePublicPlaceRecords: PublicPlaceRecordModerator = async rows =>
  await moderatePublicRows('place', rows)

export async function loadPublicPlaceRecord(
  id: number,
  query: PublicPlaceRecordQuery = executePublicPlaceRecordQuery,
  moderate: PublicPlaceRecordModerator = moderatePublicPlaceRecords,
): Promise<PublicPlaceRecord | null> {
  const rows = (await query(`
    SELECT p.id, p.parent_id, p.name, p.founding_name,
      history.name_history,
      p.retired_at,
      CASE WHEN p.retired_at IS NULL THEN 'active'::text ELSE 'retired'::text END AS status,
      p.description, p.purpose,
      p.owner_id, owner.handle AS owner,
      p.open_to_building, p.open_to_things, p.open_to_notes, p.quiet, p.created_at,
      p.rough_room, p.wake_visitors, p.wake_pins, p.wake_block_thing_ids,
      coalesce((
        SELECT jsonb_agg(blocked.handle ORDER BY array_position(p.wake_block_resident_ids, blocked.id))
        FROM residents blocked WHERE blocked.id = ANY(p.wake_block_resident_ids)
      ), '[]'::jsonb) AS wake_block_residents,
      p.wake_random_cap,
      (
        SELECT jsonb_build_object(
          'settle_id', settle.id,
          'at', to_char(settle.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'trigger', settle.trigger,
          'by', settler.handle,
          'budget', settle.budget,
          'tried', tries.tried,
          'woke', tries.woke,
          'stopped', tries.stopped,
          'forfeited', settle.forfeited + tries.stopped_clock,
          'roll_id', (
            SELECT roll.id FROM chance_rolls roll
            WHERE roll.settle_id = settle.id AND roll.purpose = 'wake_pick' LIMIT 1
          )
        )
        FROM wake_settles settle
        JOIN residents settler ON settler.id = settle.resident_id
        CROSS JOIN LATERAL (
          SELECT count(*) FILTER (WHERE attempt.status <> 'stopped')::int AS tried,
            count(*) FILTER (WHERE attempt.status = 'woke')::int AS woke,
            count(*) FILTER (WHERE attempt.status = 'stopped')::int AS stopped,
            count(*) FILTER (WHERE attempt.status = 'stopped' AND attempt.reason = 'clock')::int AS stopped_clock
          FROM wake_tries attempt WHERE attempt.settle_id = settle.id
        ) tries
        WHERE settle.place_id = p.id
        ORDER BY settle.id DESC LIMIT 1
      ) AS last_settle
    FROM places p
    LEFT JOIN residents owner ON owner.id = p.owner_id
    LEFT JOIN LATERAL (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'name', span.name,
        'started_at', to_char(span.started_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'ended_at', CASE WHEN span.ended_at IS NULL THEN NULL ELSE to_char(
          span.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
      ) ORDER BY span.started_at, span.id), '[]'::jsonb) AS name_history
      FROM (
        SELECT history.id, history.name, history.started_at,
          lead(history.started_at) OVER (
            PARTITION BY history.place_id ORDER BY history.started_at, history.id
          ) AS ended_at
        FROM place_name_history history
        WHERE history.place_id = p.id
      ) span
    ) history ON TRUE
    WHERE p.id = $1::integer
  `, [id])) as PublicPlaceRecord[]
  const publicRows = await moderate(rows)
  const record = publicRows[0] ?? null
  return record !== null && isWorldRootRow(record)
    ? { ...record, purpose: WORLD_ROOT_PURPOSE }
    : record
}

/**
 * Read one current active thing by an already-validated ID from 1 through 2,147,483,647.
 * Returns its fully moderated public record, or null when it is absent or withdrawn.
 */
export async function loadPublicThingRecord(id: number): Promise<PublicThingRecord | null> {
  const rows = (await sql`
    SELECT thing.id, thing.place_id, thing.name, thing.body,
      thing.maker_id, maker.handle AS made_by,
      thing.owner_id AS current_owner_id, owner.handle AS current_owner,
      thing.owner_id, owner.handle AS owner, thing.open_to_use,
      thing.shared_use_may_destroy,
      coalesce(thing.as_kind_id, thing.kind_id) AS kind_id, kind.name AS kind,
      thing.birth_revision,
      coalesce(thing.as_revision, thing.current_revision) AS current_revision,
      CASE WHEN thing.kind_id IS NULL THEN NULL ELSE jsonb_build_object(
        'kind', birth_kind.name, 'kind_id', thing.kind_id, 'revision', thing.birth_revision
      ) END AS born_as,
      coalesce((
        SELECT jsonb_agg(conversion.entry ORDER BY conversion.id DESC)
        FROM (
          SELECT memory.id, jsonb_build_object(
            'kind', former.name,
            'kind_id', memory.from_kind_id,
            'revision', memory.from_revision,
            'changed_by_thing_id', memory.by_thing_id,
            'changed_by_law', law.name,
            'changed_by', answering.handle,
            'at', to_char(memory.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          ) AS entry
          FROM thing_conversions memory
          JOIN kinds former ON former.id = memory.from_kind_id
          JOIN residents answering ON answering.id = memory.authority_id
          LEFT JOIN traits law ON law.id = memory.by_law_trait_id
          WHERE memory.thing_id = thing.id
          ORDER BY memory.id DESC LIMIT 8
        ) conversion
      ), '[]'::jsonb) AS was,
      (SELECT count(*)::int FROM thing_conversions memory WHERE memory.thing_id = thing.id) AS was_total,
      thing.open_to_reach, thing.open_to_convert,
      CASE
        WHEN coalesce((
          SELECT moderation.action FROM moderation_actions moderation
          WHERE moderation.target_type = 'thing' AND moderation.target_id = thing.id
          ORDER BY moderation.created_at DESC, moderation.id DESC LIMIT 1
        ), 'restore') = 'remove' THEN false
        WHEN thing.kind_id IS NULL THEN thing.drawing IS NOT NULL
        WHEN thing.drawing_state = 'refused' THEN false
        WHEN coalesce((
          SELECT moderation.action FROM moderation_actions moderation
          WHERE moderation.target_type = 'kind'
            AND moderation.target_id = coalesce(thing.as_kind_id, thing.kind_id)
          ORDER BY moderation.created_at DESC, moderation.id DESC LIMIT 1
        ), 'restore') = 'remove' THEN false
        ELSE coalesce((
          SELECT variant.value -> 'drawing' IS NOT NULL
          FROM kind_revisions drawing_revision
          CROSS JOIN LATERAL jsonb_array_elements(
            coalesce(drawing_revision.drawing_variants, '[]'::jsonb)
          ) variant(value)
          WHERE drawing_revision.kind_id = coalesce(thing.as_kind_id, thing.kind_id)
            AND drawing_revision.revision = coalesce(thing.as_revision, thing.current_revision)
            AND variant.value ->> 'name' = thing.drawing_variant_name
          LIMIT 1
        ), (
          SELECT drawing_revision.drawing IS NOT NULL
          FROM kind_revisions drawing_revision
          WHERE drawing_revision.kind_id = coalesce(thing.as_kind_id, thing.kind_id)
            AND drawing_revision.revision = coalesce(thing.as_revision, thing.current_revision)
        ), false)
      END AS has_drawing,
      thing.wake_enabled,
      thing.generation, thing.parent_thing_id,
      coalesce(thing.family_id, thing.id) AS family_id,
      (
        SELECT root_maker.handle FROM things root
        JOIN residents root_maker ON root_maker.id = root.maker_id
        WHERE root.id = coalesce(thing.family_id, thing.id)
      ) AS family_maker,
      thing.copies_made,
      (
        SELECT jsonb_build_object(
          'family_id', mark.family_id,
          'place_id', mark.place_id,
          'source_thing_id', mark.source_thing_id,
          'cap', mark.cap,
          'limit', mark.cap_limit,
          'over_by', mark.over_by,
          'at', to_char(mark.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
        FROM family_growth_marks mark
        WHERE mark.family_id = coalesce(thing.family_id, thing.id)
          AND mark.place_id = thing.place_id AND mark.cleared_at IS NULL
      ) AS growth_mark,
      (
        SELECT jsonb_build_object(
          'trait_id', trait.id,
          'on', trait.recipe -> 'wake' -> 'on',
          'every_seconds', trait.recipe -> 'wake' -> 'every_seconds',
          'last_try_at', to_char(wake_state.last_try_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'clock_at', to_char(wake_state.clock_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'last_try', (
            SELECT jsonb_build_object(
              'settle_id', attempt.settle_id,
              'reason', attempt.reason,
              'status', attempt.status,
              'effects_applied', attempt.effects_applied,
              'error', attempt.error,
              'at', to_char(attempt.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            )
            FROM wake_tries attempt WHERE attempt.thing_id = thing.id
            ORDER BY attempt.id DESC LIMIT 1
          )
        )
        FROM kind_revision_traits link
        JOIN traits trait ON trait.id = link.trait_id
        LEFT JOIN thing_wake_state wake_state ON wake_state.thing_id = thing.id
        WHERE link.kind_id = coalesce(thing.as_kind_id, thing.kind_id)
          AND link.revision = coalesce(thing.as_revision, thing.current_revision)
          AND trait.recipe ? 'wake'
        ORDER BY link.position LIMIT 1
      ) AS wake,
      jsonb_build_object(
        'version', thing.state_version,
        'values', thing.state,
        'last_write', (
          SELECT jsonb_build_object(
            'version', change.version, 'key', change.key, 'op', change.op,
            'trimmed', change.trimmed,
            'source_trait', CASE WHEN coalesce((
              SELECT moderation.action FROM moderation_actions moderation
              WHERE moderation.target_type = 'trait' AND moderation.target_id = change.source_trait_id
              ORDER BY moderation.created_at DESC, moderation.id DESC LIMIT 1
            ), 'restore') = 'remove' THEN NULL ELSE trait.name END,
            'source_trait_id', change.source_trait_id,
            'trigger', change.trigger,
            'by', writer.handle,
            'at', to_char(change.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          )
          FROM thing_state_changes change
          LEFT JOIN traits trait ON trait.id = change.source_trait_id
          LEFT JOIN residents writer ON writer.id = change.resident_id
          WHERE change.thing_id = thing.id
          ORDER BY change.version DESC LIMIT 1
        )
      ) AS state,
      thing.created_at
    FROM things thing
    JOIN residents maker ON maker.id = thing.maker_id
    JOIN residents owner ON owner.id = thing.owner_id
    LEFT JOIN kinds kind ON kind.id = coalesce(thing.as_kind_id, thing.kind_id)
    LEFT JOIN kinds birth_kind ON birth_kind.id = thing.kind_id
    WHERE thing.id = ${id} AND thing.withdrawn_at IS NULL
  `) as PublicThingRecord[]
  const publicDetails = await moderatePlaceDetails(rows, [])
  return publicDetails.things[0] ?? null
}

/**
 * Read one current note by an already-validated ID from 1 through 2,147,483,647.
 * Returns its moderated public record, or null when that note does not exist. A
 * walk-to-read note in an active place carries its first line instead of its body.
 */
export async function loadPublicNoteRecord(id: number): Promise<PublicNoteRecord | null> {
  const rows = await sql.query(`
    SELECT note.id, note.place_id, author.handle AS author, note.body, note.created_at,
      note.walk_to_read, ${noteBodyWithheldSql('note')} AS body_withheld
    FROM notes note
    JOIN residents author ON author.id = note.author_id
    WHERE note.id = $1::integer
  `, [id]) as readonly Record<string, unknown>[]
  const publicRows = await moderatePublicRows('note', rows.map(publicNoteRow))
  return (publicRows[0] as PublicNoteRecord | undefined) ?? null
}
