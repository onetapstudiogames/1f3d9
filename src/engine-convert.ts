/**
 * Convert (decision #114): change a thing's effective kind with its owner's
 * consent. Birth history never changes; the new kind is an overlay beside it,
 * and every conversion is remembered.
 */
import { EngineError, type TaggedSql } from './engine.ts'
import { ownThingOf } from './engine-state.ts'
import type { EffectExecutionContext } from './engine-effects.ts'
import { HELD_THING_ERROR } from './refusal-text.ts'
import { MAX_EFFECT_GENERATIONS, type ConvertEffect } from './physics.ts'
import { appendThingPresentationRevision, readThingPresentation } from './thing-presentation.ts'

export const CONVERT_ONLY_THINGS_ERROR =
  'convert changes only things; residents and places are never converted'
const CONVERT_SELF_ERROR =
  'convert cannot change the thing running it; choose another target thing'
const OFFERED_THING_ERROR =
  'thing has an open sale offer; cancel the offer or choose another active thing'

export function lawIntoKindRefusal(name: string): string {
  return `a law may convert only into a kind its place owner owns; kind ${name} is missing or belongs to someone else`
}

export function convertedVariantRefusal(thingId: number): string {
  return `thing ${thingId} was converted, so it shows its new kind's base drawing; send no drawing_variant_name`
}

interface KindAt {
  readonly kindId: number
  readonly revision: number
  /** The kind's owner, whose drawing the converted thing now shows. */
  readonly ownerId: number
}

/** What the thing becomes, where the change came from, and the generation it lands at. */
interface Conversion {
  readonly into: KindAt
  readonly byThingId: number | null
  readonly byLawTraitId: number | null
  readonly byPlaceId: number | null
  readonly familyId: number | null
  readonly generationFloor: number
}

async function kindTraitConversion(context: EffectExecutionContext, db: TaggedSql): Promise<Conversion> {
  const converterId = ownThingOf(context)
  const rows = await db`
    SELECT coalesce(thing.as_kind_id, thing.kind_id) AS kind_id,
      coalesce(thing.as_revision, thing.current_revision) AS revision,
      kind.owner_id AS kind_owner_id,
      thing.generation, coalesce(thing.family_id, thing.id) AS family_id
    FROM things thing
    LEFT JOIN kinds kind ON kind.id = coalesce(thing.as_kind_id, thing.kind_id)
    WHERE thing.id = ${converterId} AND thing.withdrawn_at IS NULL
  ` as Array<Record<string, unknown>>
  const row = rows[0]
  if (!row || row.kind_id == null) {
    throw new EngineError(409, `thing ${converterId} is gone, so it cannot convert anything`)
  }
  return Object.freeze({
    into: { kindId: Number(row.kind_id), revision: Number(row.revision), ownerId: Number(row.kind_owner_id) },
    byThingId: converterId,
    byLawTraitId: null,
    byPlaceId: null,
    familyId: Number(row.family_id),
    generationFloor: Number(row.generation) + 1,
  })
}

/** A law converts only into a kind its place's owner owns, at that kind's current revision. */
async function lawConversion(
  intoKind: string,
  context: EffectExecutionContext,
  db: TaggedSql,
): Promise<Conversion> {
  const lawPlaceId = context.originPlaceId ?? context.placeId
  const rows = await db`
    SELECT kind.id, kind.current_revision, kind.owner_id
    FROM kinds kind JOIN places place ON place.id = ${lawPlaceId}
    WHERE kind.name = ${intoKind} AND kind.owner_id = place.owner_id
  ` as Array<{ id?: unknown; current_revision?: unknown; owner_id?: unknown }>
  const row = rows[0]
  if (!row || lawPlaceId === null) throw new EngineError(409, lawIntoKindRefusal(intoKind))
  return Object.freeze({
    into: { kindId: Number(row.id), revision: Number(row.current_revision), ownerId: Number(row.owner_id) },
    byThingId: null,
    byLawTraitId: context.sourceTraitId,
    byPlaceId: lawPlaceId,
    familyId: null,
    generationFloor: 1,
  })
}

/**
 * Convert one target thing. Returns false when it already is that kind at that
 * revision, which changes nothing and counts no application.
 */
export async function convertThing(
  effect: ConvertEffect,
  thingId: number,
  context: EffectExecutionContext,
  db: TaggedSql,
): Promise<boolean> {
  if (thingId === context.sourceThingId || thingId === context.originThingId) {
    throw new EngineError(400, CONVERT_SELF_ERROR)
  }
  const conversion = effect.into_kind === undefined
    ? await kindTraitConversion(context, db)
    : await lawConversion(effect.into_kind, context, db)
  const rows = await db`
    SELECT thing.owner_id, thing.place_id, thing.held_by, thing.active_offer_id, thing.kind_id,
      coalesce(thing.as_kind_id, thing.kind_id) AS kind_id_now,
      coalesce(thing.as_revision, thing.current_revision) AS revision_now,
      thing.drawing_variant_name, thing.generation, coalesce(thing.family_id, thing.id) AS family_id,
      thing.wake_enabled, thing.open_to_convert,
      EXISTS (
        SELECT 1 FROM transfer_offers offer
        WHERE offer.asset_type = 'thing' AND offer.asset_id = thing.id AND offer.status = 'open'
      ) AS has_open_offer
    FROM things thing WHERE thing.id = ${thingId} AND thing.withdrawn_at IS NULL
    FOR UPDATE OF thing
  ` as Array<Record<string, unknown>>
  const target = rows[0]
  if (!target) throw new EngineError(404, 'thing target was not found; choose a current active thing_id')
  if (target.held_by != null) throw new EngineError(409, HELD_THING_ERROR)
  if (target.active_offer_id != null || target.has_open_offer === true) {
    throw new EngineError(409, OFFERED_THING_ERROR)
  }
  if (target.kind_id == null) {
    throw new EngineError(409, `convert changes only things made from a kind; thing ${thingId} has no kind, so it stays as its owner made it`)
  }
  const ownersOwn = Number(target.owner_id) === context.actorId && context.ownProgram === true
  if (target.open_to_convert !== true && !ownersOwn) {
    throw new EngineError(403, `thing ${thingId} has not agreed to be converted; its owner can set open_to_convert with thing_edit`)
  }
  const generation = Math.max(Number(target.generation), conversion.generationFloor)
  if (generation > MAX_EFFECT_GENERATIONS) {
    throw new EngineError(409, `convert would take thing ${thingId} past generation ${MAX_EFFECT_GENERATIONS}; this family cannot spread further`)
  }
  if (Number(target.kind_id_now) === conversion.into.kindId
    && Number(target.revision_now) === conversion.into.revision) return false
  const residentId = context.fromWake === true
    ? (context.actorSymbolId ?? null)
    : (context.actorSymbolId ?? context.actorId)
  const shownBefore = await readThingPresentation(thingId, db)
  await db`
    WITH changed AS (
      UPDATE things SET
        as_kind_id = ${conversion.into.kindId}, as_revision = ${conversion.into.revision},
        drawing_variant_name = NULL, wake_enabled = FALSE, generation = ${generation},
        family_id = coalesce(${conversion.familyId}::integer, family_id)
      WHERE id = ${thingId}
      RETURNING id, place_id
    ), remembered AS (
      INSERT INTO thing_conversions (
        thing_id, from_kind_id, from_revision, from_variant_name, from_family_id,
        from_generation, from_wake_enabled, to_kind_id, to_revision, to_generation,
        by_thing_id, by_law_trait_id, by_place_id, authority_id, resident_id, action_id, settle_id
      )
      SELECT changed.id, ${Number(target.kind_id_now)}, ${Number(target.revision_now)},
        ${typeof target.drawing_variant_name === 'string' ? target.drawing_variant_name : null},
        ${Number(target.family_id)}, ${Number(target.generation)}, ${target.wake_enabled === true},
        ${conversion.into.kindId}, ${conversion.into.revision}, ${generation},
        ${conversion.byThingId}, ${conversion.byLawTraitId}, ${conversion.byPlaceId},
        ${context.actorId}, ${residentId}, ${context.actionId}, ${context.settleId ?? null}
      FROM changed
      RETURNING id
    ), cleared_marks AS (
      UPDATE family_growth_marks mark
      SET cleared_at = now(), cleared_reason = 'kind_revision_changed'
      FROM changed
      WHERE mark.family_id = ${Number(target.family_id)} AND mark.cleared_at IS NULL
    )
    INSERT INTO events (kind, actor, detail)
    SELECT 'thing_edited', resident.handle, jsonb_build_object(
      'thing_id', changed.id,
      'place_id', changed.place_id,
      'mode', 'converted',
      'source_thing_id', ${conversion.byThingId}::integer,
      'law_trait_id', ${conversion.byLawTraitId}::integer,
      'kind_id', ${conversion.into.kindId}::integer,
      'from_kind_id', ${Number(target.kind_id_now)}::integer
    )
    FROM changed CROSS JOIN remembered JOIN residents resident ON resident.id = ${context.actorId}
  `
  // The thing now shows its new kind's drawing, which that kind's owner made.
  if (shownBefore) {
    await appendThingPresentationRevision(thingId, shownBefore, {
      id: conversion.into.ownerId, relation: 'kind_owner',
    }, db)
  }
  context.abilityLog?.converted.push(thingId)
  return true
}
