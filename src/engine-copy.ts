/**
 * Copy (decisions #111 and #112): the thing whose own kind traits run it makes
 * one more of its kind, owned by its current owner, one generation down, inside
 * the family, generation, and place limits. A copy that a limit stops is
 * skipped and recorded, never a failed action.
 *
 * A copy is born with its parent's remaining end, fixed at copy time (decision #174):
 * copyRuleFrom writes it, with the parent's grant and one thing_ending_changes 'copy'
 * row. A parent whose end has come is skipped with its reason, except by its own end
 * try (the end_try:<id> writer), whose copy starts with no end.
 */
import { EngineError, type TaggedSql } from './engine.ts'
import { drawCopyPlaceRoll } from './engine-chance.ts'
import { ownThingOf } from './engine-state.ts'
import { GAZETTE_ROOM_ID } from './gazette.ts'
import { MAX_EFFECT_GENERATIONS, type CopyEffect } from './physics.ts'
import type { EffectExecutionContext, GrowthCap, SkippedEffect } from './engine-effects.ts'
import { requireReservedEffectPlace } from './engine-place-plan.ts'
import { COLLISION_CONFLICT_MESSAGE } from './core.ts'
import { THING_ENDED_SKIP_REASON } from './thing-ending-refusals.ts'
import { copyRuleFrom, type CopyEndingColumns, type EndingCopyParent } from './thing-endings.ts'

/** One advisory lock per destination, so two copies landing at once never both pass its cap. */
const COPY_PLACE_LOCK_CLASS = 0x1f3d9006

interface Parent {
  readonly id: number
  readonly ownerId: number
  readonly placeId: number
  readonly name: string
  readonly body: string
  readonly kindId: number
  readonly revision: number
  readonly converted: boolean
  readonly variantName: string | null
  readonly openToUse: boolean
  readonly sharedUseMayDestroy: boolean
  readonly openToReach: boolean
  readonly openToConvert: boolean
  readonly wakeEnabled: boolean
  readonly generation: number
  readonly familyId: number
  readonly copiesMade: number
  readonly state: Readonly<Record<string, unknown>>
  /** Whether the parent's end has come (recorded, or due now), judged at this step. */
  readonly endReached: boolean
  /** Whether this transaction is the parent's own end try (the end_try:<id> writer). */
  readonly ownEndTry: boolean
  /** The end its copy is born with, or null for none. */
  readonly copyEnding: CopyEndingColumns | null
}

interface CapHit {
  readonly cap: GrowthCap
  readonly limit: number
  readonly overBy: number
  readonly placeId: number
}

export type CopyOutcome =
  | Readonly<{ copiedThingId: number }>
  | Readonly<{ skipped: SkippedEffect }>

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {}
}

async function lockParent(thingId: number, db: TaggedSql): Promise<Parent> {
  const rows = await db`
    SELECT thing.id, thing.owner_id, thing.place_id, thing.name, thing.body,
      coalesce(thing.as_kind_id, thing.kind_id) AS kind_id,
      coalesce(thing.as_revision, thing.current_revision) AS revision,
      thing.as_kind_id IS NOT NULL AS converted, thing.drawing_variant_name,
      thing.open_to_use, thing.shared_use_may_destroy, thing.open_to_reach,
      thing.open_to_convert, thing.wake_enabled, thing.generation,
      coalesce(thing.family_id, thing.id) AS family_id, thing.copies_made, thing.state,
      thing.withdrawn_at,
      thing.ending_rule, thing.ending_grant, thing.ending_set_at, thing.ending_deadline,
      thing.ending_idle_seconds, thing.ending_idle_anchor, thing.ending_uses_left,
      thing.ending_uses_spent_at, thing.ending_label, thing.ending_copied_from, thing.ended_at,
      (thing.ended_at IS NOT NULL
        OR coalesce(thing_end_due_at_row(thing) <= transaction_timestamp(), false)) AS end_reached,
      thing_ending_writer(thing.id) = 'end_try' AS own_end_try,
      transaction_timestamp() AS copied_at
    FROM things thing WHERE thing.id = ${thingId}
    FOR NO KEY UPDATE OF thing
  ` as Array<Record<string, unknown>>
  const row = rows[0]
  if (!row || row.withdrawn_at != null || row.kind_id == null) {
    throw new EngineError(409, `thing ${thingId} is gone, so it cannot make a copy`)
  }
  // The copy's family_id key needs this share lock on the family's first thing.
  // Taking it now, before the destination lock, means a family member copying
  // at the same moment waits here instead of deadlocking under that lock.
  if (Number(row.family_id) !== thingId) {
    await db`SELECT 1 FROM things WHERE id = ${Number(row.family_id)} FOR KEY SHARE`
  }
  const endReached = row.end_reached === true
  return Object.freeze({
    id: thingId,
    ownerId: Number(row.owner_id),
    placeId: Number(row.place_id),
    name: String(row.name),
    body: String(row.body ?? ''),
    kindId: Number(row.kind_id),
    revision: Number(row.revision),
    converted: row.converted === true,
    variantName: typeof row.drawing_variant_name === 'string' ? row.drawing_variant_name : null,
    openToUse: row.open_to_use === true,
    sharedUseMayDestroy: row.shared_use_may_destroy === true,
    openToReach: row.open_to_reach === true,
    openToConvert: row.open_to_convert === true,
    wakeEnabled: row.wake_enabled === true,
    generation: Number(row.generation),
    familyId: Number(row.family_id),
    copiesMade: Number(row.copies_made),
    state: record(row.state),
    endReached,
    ownEndTry: row.own_end_try === true,
    copyEnding: endReached ? null : copyEndingOf(thingId, Number(row.owner_id), row),
  })
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value)
}

function storedTime(value: unknown): EndingCopyParent['ending_set_at'] {
  return value instanceof Date || typeof value === 'string' ? value : null
}

/**
 * The parent's remaining end for its copy, set by the copy's owner (the parent's owner)
 * at the transaction time, cut to milliseconds as every set time is. A row without
 * ending columns (an older reader or a fake) gives no end. The caller has already found
 * that the parent's end has not come, so the label rows copyRuleFrom would read cannot
 * change its answer and are not loaded.
 */
function copyEndingOf(thingId: number, ownerId: number, row: Record<string, unknown>): CopyEndingColumns | null {
  if (row.ending_rule == null) return null
  const copiedAt = row.copied_at instanceof Date ? row.copied_at : new Date(String(row.copied_at))
  if (Number.isNaN(copiedAt.getTime())) {
    throw new EngineError(500, 'database returned an invalid result; retry once, then contact the city operator')
  }
  return copyRuleFrom({
    id: thingId,
    ending_rule: row.ending_rule,
    ending_grant: row.ending_grant,
    ending_set_at: storedTime(row.ending_set_at),
    ending_deadline: storedTime(row.ending_deadline),
    ending_idle_seconds: nullableNumber(row.ending_idle_seconds),
    ending_idle_anchor: storedTime(row.ending_idle_anchor),
    ending_uses_left: nullableNumber(row.ending_uses_left),
    ending_uses_spent_at: storedTime(row.ending_uses_spent_at),
    ending_label: row.ending_label == null ? null : String(row.ending_label),
    ending_copied_from: nullableNumber(row.ending_copied_from),
    first_label_at: null,
    ended_at: storedTime(row.ended_at),
  }, copiedAt, ownerId)
}

/** The copy step on a parent whose end has come, outside its own end try: skipped, never written. */
function endedParentSkip(context: EffectExecutionContext): SkippedEffect {
  return Object.freeze({
    effect: 'copy',
    target: 'source',
    sourceTrait: context.sourceTraitName ?? null,
    sourceTraitId: context.sourceTraitId,
    sourcePlaceId: context.originPlaceId ?? null,
    reason: THING_ENDED_SKIP_REASON,
  })
}

/** The copy's own room, when it is still its owner's own or open to things. */
async function hereDestination(parent: Parent, db: TaggedSql): Promise<number | null> {
  const rows = await db`
    SELECT place.id FROM places place
    WHERE place.id = ${parent.placeId} AND place.retired_at IS NULL
      AND place.owner_id IS NOT NULL AND place.place_kind <> 'world'
      AND place.id <> ${GAZETTE_ROOM_ID}
      AND (place.owner_id = ${parent.ownerId} OR place.open_to_things)
  ` as Array<{ id?: unknown }>
  return rows[0] ? Number(rows[0].id) : null
}

/**
 * One place one parent-child edge away whose owner allows arriving copies; when
 * several do, a public roll in place-id order picks one.
 */
async function adjacentDestination(
  parent: Parent,
  context: EffectExecutionContext,
  db: TaggedSql,
): Promise<number | null> {
  const rows = await db`
    SELECT neighbour.id FROM places neighbour
    WHERE (
        neighbour.id = (SELECT here.parent_id FROM places here WHERE here.id = ${parent.placeId})
        OR neighbour.parent_id = ${parent.placeId}
      )
      AND neighbour.allow_arriving_copies AND neighbour.retired_at IS NULL
      AND neighbour.owner_id IS NOT NULL AND neighbour.place_kind <> 'world'
      AND neighbour.id <> ${GAZETTE_ROOM_ID}
    ORDER BY neighbour.id
  ` as Array<{ id?: unknown }>
  const ids = rows.map(row => Number(row.id))
  for (const id of ids) requireReservedEffectPlace(id, context)
  if (ids.length <= 1) return ids[0] ?? null
  const drawn = await drawCopyPlaceRoll(ids.length, {
    placeId: parent.placeId,
    sourceThingId: parent.id,
    sourceTraitId: context.sourceTraitId,
    actorId: parent.ownerId,
    actionId: context.actionId,
    settleId: context.settleId ?? null,
    ...(context.rollLog === undefined ? {} : { rollLog: context.rollLog }),
  }, db)
  return ids[(drawn.roll ?? 1) - 1] ?? null
}

/** Under the destination's lock: the place's daily cap, then the family's share of it. */
async function placeCapHit(destinationId: number, familyId: number, db: TaggedSql): Promise<CapHit | null> {
  await db`SELECT pg_advisory_xact_lock(${COPY_PLACE_LOCK_CLASS}::int, ${destinationId}::int)`
  const rows = await db`
    SELECT place.growth_cap_per_day, place.growth_share_per_family,
      coalesce((
        SELECT sum(count.copies) FROM place_copy_counts count
        WHERE count.place_id = place.id AND count.utc_day = (now() AT TIME ZONE 'UTC')::date
      ), 0)::int AS today,
      coalesce((
        SELECT count.copies FROM place_copy_counts count
        WHERE count.place_id = place.id AND count.utc_day = (now() AT TIME ZONE 'UTC')::date
          AND count.family_id = ${familyId}
      ), 0)::int AS family_today
    FROM places place WHERE place.id = ${destinationId}
  ` as Array<Record<string, unknown>>
  const row = rows[0]
  const cap = Number(row?.growth_cap_per_day ?? 0)
  const share = Number(row?.growth_share_per_family ?? 0)
  const today = Number(row?.today ?? 0)
  const familyToday = Number(row?.family_today ?? 0)
  if (today + 1 > cap) {
    return { cap: 'place_daily', limit: cap, overBy: today + 1 - cap, placeId: destinationId }
  }
  if (familyToday + 1 > share) {
    return { cap: 'family_share', limit: share, overBy: familyToday + 1 - share, placeId: destinationId }
  }
  return null
}

/**
 * Mark the family where a cap bit, one open mark per family and place updated in
 * place, and record the skip as a public copy_skipped event by the thing's owner.
 */
async function markFamily(parent: Parent, hit: CapHit, context: EffectExecutionContext, db: TaggedSql) {
  await db`
    WITH marked AS (
      INSERT INTO family_growth_marks (
        family_id, place_id, source_thing_id, cap, cap_limit, over_by, action_id, settle_id
      ) VALUES (
        ${parent.familyId}, ${hit.placeId}, ${parent.id}, ${hit.cap}, ${hit.limit}, ${hit.overBy},
        ${context.actionId}, ${context.settleId ?? null}
      )
      ON CONFLICT (place_id, family_id) WHERE cleared_at IS NULL DO UPDATE SET
        source_thing_id = EXCLUDED.source_thing_id, cap = EXCLUDED.cap,
        cap_limit = EXCLUDED.cap_limit, over_by = EXCLUDED.over_by,
        action_id = EXCLUDED.action_id, settle_id = EXCLUDED.settle_id, created_at = now()
      RETURNING id
    )
    INSERT INTO events (kind, actor, detail)
    SELECT 'copy_skipped', owner.handle, jsonb_build_object(
      'thing_id', ${parent.id}::integer,
      'trait_id', ${context.sourceTraitId}::integer,
      'place_id', ${hit.placeId}::integer,
      'family_id', ${parent.familyId}::integer,
      'cap', ${hit.cap}::text,
      'limit', ${hit.limit}::integer,
      'over_by', ${hit.overBy}::integer,
      'action_id', ${context.actionId}::bigint,
      'settle_id', ${context.settleId ?? null}::bigint
    )
    FROM marked JOIN residents owner ON owner.id = ${parent.ownerId}
  `
}

function skippedCopy(hit: CapHit, context: EffectExecutionContext): SkippedEffect {
  const lineage = hit.cap === 'generations' || hit.cap === 'copies'
  return Object.freeze({
    effect: 'copy',
    target: 'source',
    sourceTrait: context.sourceTraitName ?? null,
    sourceTraitId: context.sourceTraitId,
    sourcePlaceId: context.originPlaceId ?? null,
    reason: lineage
      ? 'the family reached its generation or copy limit' as const
      : 'a growth cap refused the copy' as const,
    cap: hit.cap,
    limit: hit.limit,
    overBy: hit.overBy,
  })
}

/** The first limit the copy meets, in the order the reference states them. */
async function firstCapHit(
  effect: CopyEffect,
  parent: Parent,
  context: EffectExecutionContext,
  db: TaggedSql,
): Promise<CapHit | number> {
  const deepest = Math.min(effect.generations, MAX_EFFECT_GENERATIONS)
  if (parent.generation + 1 > deepest) {
    return { cap: 'generations', limit: deepest, overBy: 1, placeId: parent.placeId }
  }
  if (effect.copies !== 'unlimited' && parent.copiesMade >= effect.copies) {
    return { cap: 'copies', limit: effect.copies, overBy: 1, placeId: parent.placeId }
  }
  const destinationId = effect.to === 'here'
    ? await hereDestination(parent, db)
    : await adjacentDestination(parent, context, db)
  if (destinationId === null) {
    return { cap: 'no_arrivals', limit: 0, overBy: 1, placeId: parent.placeId }
  }
  requireReservedEffectPlace(destinationId, context)
  return await placeCapHit(destinationId, parent.familyId, db) ?? destinationId
}

async function insertCopy(
  parent: Parent,
  destinationId: number,
  inherit: CopyEffect['inherit'],
  context: EffectExecutionContext,
  db: TaggedSql,
): Promise<number> {
  const body = inherit.includes('body') ? parent.body : ''
  const state = inherit.includes('state') ? parent.state : {}
  const inheritsState = Object.keys(state).length > 0
  const residentId = context.fromWake === true
    ? (context.actorSymbolId ?? null)
    : (context.actorSymbolId ?? context.actorId)
  // A copy made by its parent's own end try starts with no end.
  const end = parent.ownEndTry ? null : parent.copyEnding
  const rows = await db`
    WITH new_thing AS (
      INSERT INTO things (
        place_id, name, body, owner_id, maker_id, open_to_use, shared_use_may_destroy,
        open_to_reach, open_to_convert, wake_enabled, kind_id, birth_revision, current_revision,
        drawing_variant_name, generation, parent_thing_id, family_id, state, state_version,
        ending_rule, ending_grant, ending_set_by, ending_set_at, ending_deadline,
        ending_idle_seconds, ending_idle_anchor, ending_uses_left, ending_label,
        ending_copied_from, ending_copied_at
      ) VALUES (
        ${destinationId}, ${parent.name}, ${body}, ${parent.ownerId}, ${parent.ownerId},
        ${parent.openToUse}, ${parent.sharedUseMayDestroy}, ${parent.openToReach},
        ${parent.openToConvert}, ${parent.wakeEnabled}, ${parent.kindId}, ${parent.revision},
        ${parent.revision}, ${parent.converted ? null : parent.variantName},
        ${parent.generation + 1}, ${parent.id}, ${parent.familyId},
        ${JSON.stringify(state)}::jsonb, ${inheritsState ? 1 : 0},
        ${end ? JSON.stringify(end.ending_rule) : null}::jsonb,
        ${end ? JSON.stringify(end.ending_grant) : null}::jsonb,
        ${end?.ending_set_by ?? null}::integer, ${end?.ending_set_at ?? null}::timestamptz,
        ${end?.ending_deadline ?? null}::timestamptz, ${end?.ending_idle_seconds ?? null}::integer,
        ${end?.ending_idle_anchor ?? null}::timestamptz, ${end?.ending_uses_left ?? null}::integer,
        ${end?.ending_label ?? null}::text, ${end?.ending_copied_from ?? null}::integer,
        ${end?.ending_copied_at ?? null}::timestamptz
      )
      RETURNING id, place_id, name, kind_id, birth_revision, generation, family_id, owner_id,
        ending_rule, ending_grant, ending_copied_at
    ), ending_change AS (
      INSERT INTO thing_ending_changes (thing_id, change, actor_id, rule, "grant", result, action_id, settle_id)
      SELECT new_thing.id, 'copy', new_thing.owner_id, new_thing.ending_rule, new_thing.ending_grant,
        jsonb_build_object('source_thing_id', ${parent.id}::integer, 'copied_at', new_thing.ending_copied_at),
        ${context.actionId}::bigint, ${context.settleId ?? null}::bigint
      FROM new_thing WHERE new_thing.ending_rule IS NOT NULL
    ), parent_count AS (
      UPDATE things SET copies_made = copies_made + 1 WHERE id = ${parent.id} RETURNING id
    ), counted AS (
      INSERT INTO place_copy_counts (place_id, utc_day, family_id, copies)
      VALUES (${destinationId}, (now() AT TIME ZONE 'UTC')::date, ${parent.familyId}, 1)
      ON CONFLICT (place_id, utc_day, family_id)
        DO UPDATE SET copies = place_copy_counts.copies + 1
      RETURNING copies
    ), cleared AS (
      UPDATE family_growth_marks SET cleared_at = now(), cleared_reason = 'copy_succeeded'
      WHERE family_id = ${parent.familyId} AND cleared_at IS NULL
        AND (
          place_id = ${destinationId}
          OR (place_id = ${parent.placeId} AND cap = 'no_arrivals')
        )
      RETURNING id
    ), inherited AS (
      INSERT INTO thing_state_changes (
        thing_id, version, key, op, value, trimmed, source_trait_id, trigger,
        resident_id, authority_id, action_id, settle_id
      )
      SELECT new_thing.id, 1, NULL, 'inherit', ${JSON.stringify(state)}::jsonb, 0,
        ${context.sourceTraitId}, 'copy', ${residentId}, ${parent.ownerId},
        ${context.actionId}, ${context.settleId ?? null}
      FROM new_thing WHERE ${inheritsState}::boolean
      RETURNING id
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'thing_created', owner.handle, jsonb_build_object(
        'thing_id', new_thing.id,
        'place_id', new_thing.place_id,
        'name', new_thing.name,
        'kind_id', new_thing.kind_id,
        'birth_revision', new_thing.birth_revision,
        'mode', 'copy',
        'source_thing_id', ${parent.id}::integer,
        'generation', new_thing.generation,
        'family_id', new_thing.family_id
      )
      FROM new_thing JOIN residents owner ON owner.id = ${parent.ownerId}
    )
    SELECT new_thing.id FROM new_thing
      CROSS JOIN parent_count CROSS JOIN counted
  ` as Array<{ id?: unknown }>
  const copiedId = Number(rows[0]?.id)
  if (!Number.isSafeInteger(copiedId) || copiedId <= 0) {
    throw new EngineError(409, `thing ${parent.id} is gone, so it cannot make a copy`)
  }
  return copiedId
}

/** Make one copy, or skip it and mark the family with the limit it met and by how much. */
export async function makeCopy(
  effect: CopyEffect,
  context: EffectExecutionContext,
  db: TaggedSql,
): Promise<CopyOutcome> {
  const parent = await lockParent(ownThingOf(context), db)
  if (context.reservedResidentIds !== undefined && !context.reservedResidentIds.includes(parent.ownerId)) {
    throw new EngineError(409, COLLISION_CONFLICT_MESSAGE)
  }
  // Judged at this step, from the database: a parent whose end came, even earlier in this
  // transaction, is left as it is unless this is its own end try.
  if (parent.endReached && !parent.ownEndTry) return Object.freeze({ skipped: endedParentSkip(context) })
  const hit = await firstCapHit(effect, parent, context, db)
  if (typeof hit !== 'number') {
    await markFamily(parent, hit, context, db)
    return Object.freeze({ skipped: skippedCopy(hit, context) })
  }
  const copiedThingId = await insertCopy(parent, hit, effect.inherit, context, db)
  context.abilityLog?.copied.push(copiedThingId)
  return Object.freeze({ copiedThingId })
}
