import {
  EngineError,
  effectiveLaws,
  engineSql,
  ensurePresence,
  goHome,
  logUnrecognizedExecutionFailure,
  moveResident,
  resolveSymbolicTarget,
  withEngineTransaction,
  type RuntimeTarget,
  type TaggedSql,
} from './engine.ts'
import {
  MAX_EFFECT_GENERATIONS,
  MAX_TIMER_SECONDS,
  MIN_TIMER_SECONDS,
  parseTraitRecipe,
  type Effect,
  type SymbolicTarget,
} from './physics.ts'
import {
  requireCallerTargetScope,
  requireResidentAtActionPlace,
} from './engine-target-scope.ts'
import {
  MAX_PENDING_EFFECTS_PER_PLACE,
  insertPendingEffect,
} from './engine-timer-store.ts'
import { isWorldRootRow, WORLD_TRANSIT_ONLY_ERROR } from './world-root.ts'
import { placePermission, withPlacePermission } from './place-permission.ts'
import { isoTimestamp } from './timestamp.ts'
const MAX_JSON_BYTES = 65_536
const DUE_BATCH_SIZE = 64
const UNKNOWN_STORED_EFFECT_ERROR = 'the city could not complete this stored effect'
export const MAX_DUE_EFFECTS_PER_OBSERVATION = MAX_PENDING_EFFECTS_PER_PLACE
export const SHARED_SOURCE_MUTATION_ERROR =
  'shared use cannot change its source thing; only the owner may destroy, move, or transfer it'
export interface LawAuthority {
  readonly traitId: number
  readonly sourcePlaceId: number
}
export interface EffectExecutionContext {
  readonly actionId: number | null
  readonly actorId: number
  readonly actorHandle: string
  readonly placeId: number | null
  readonly sourceThingId: number | null
  readonly sharedSourceThingId: number | null
  readonly target: RuntimeTarget | null
  readonly destinationPlaceId: number | null
  readonly recipientId: number | null
  readonly sourceTraitId: number | null
  readonly lawAuthority: LawAuthority | null
  /** Stable recipe origin; unlike lawAuthority, check_label never replaces it. */
  readonly originThingId?: number | null
  readonly originPlaceId?: number | null
  readonly parentEffectId: number | null
  readonly generation: number
  readonly logicalAt: Date
}
export interface EffectExecutionOutcome {
  readonly effectsApplied: number
  readonly emittedTypedPublicEvent: boolean
}
export interface ThingState {
  readonly id: number
  readonly ownerId: number
  readonly placeId: number
  readonly withdrawnAt: string | null
  readonly activeOfferId: number | null
  readonly hasOpenOffer: boolean
  readonly openToUse: boolean
}
interface PendingRow {
  readonly id: number
  readonly actionId: number | null
  readonly placeId: number
  readonly actorId: number
  readonly sourceTraitId: number | null
  readonly sourceThingId: number | null
  readonly sharedSourceThingId: number | null
  readonly target: RuntimeTarget | null
  readonly destinationPlaceId: number | null
  readonly recipientId: number | null
  readonly effects: readonly Effect[]
  readonly repeatRemaining: number
  readonly repeatSeconds: number | null
  readonly lawAuthority: LawAuthority | null
  readonly originThingId: number | null | undefined
  readonly originPlaceId: number | null | undefined
  readonly dueAt: Date
  readonly logicalDueAt: Date
  readonly generation: number
}
function objectRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}
function integer(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}
function rowId(value: unknown, field: string): number {
  const parsed = integer(value)
  if (parsed === null || parsed <= 0) throw new EngineError(500, `database returned an invalid ${field}; retry once, then contact the city operator`)
  return parsed
}
function nullableRowId(value: unknown, field: string): number | null {
  return value == null ? null : rowId(value, field)
}
function json(value: unknown): string {
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new EngineError(400, 'payload must be valid JSON')
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_JSON_BYTES) {
    throw new EngineError(400, `payload exceeds ${MAX_JSON_BYTES} UTF-8 bytes; send a smaller payload`)
  }
  return encoded
}
async function queryRows<T>(promise: Promise<unknown>): Promise<T[]> {
  const value = await promise
  if (!Array.isArray(value)) throw new EngineError(500, 'database returned an invalid result; retry once, then contact the city operator')
  return value as T[]
}

function targetType(value: unknown): RuntimeTarget['type'] | null {
  return value === 'resident' || value === 'place' || value === 'thing' || value === 'kind'
    ? value
    : null
}

async function targetExists(target: RuntimeTarget, db: TaggedSql): Promise<boolean> {
  let rows: Array<{ exists?: unknown }>
  if (target.type === 'resident') {
    rows = await queryRows(db`SELECT EXISTS (SELECT 1 FROM residents WHERE id = ${target.id}) AS exists`)
  } else if (target.type === 'place') {
    rows = await queryRows(db`SELECT EXISTS (SELECT 1 FROM places WHERE id = ${target.id}) AS exists`)
  } else if (target.type === 'kind') {
    rows = await queryRows(db`SELECT EXISTS (SELECT 1 FROM kinds WHERE id = ${target.id}) AS exists`)
  } else {
    rows = await queryRows(db`
      SELECT EXISTS (
        SELECT 1 FROM things WHERE id = ${target.id} AND withdrawn_at IS NULL
      ) AS exists
    `)
  }
  return rows[0]?.exists === true
}

async function requireTarget(target: RuntimeTarget | null, db: TaggedSql): Promise<RuntimeTarget> {
  if (!target) throw new EngineError(400, 'effect target is unavailable because its type or id is missing; send one documented target_type and target_id')
  if (!await targetExists(target, db)) throw new EngineError(404, `${target.type} target was not found; choose a current public target before retrying`)
  return target
}

async function requireScopedBrickTarget(
  symbol: SymbolicTarget,
  context: EffectExecutionContext,
  db: TaggedSql,
): Promise<RuntimeTarget> {
  const target = await requireTarget(resolveSymbolicTarget(symbol, context), db)
  if (symbol === 'target') {
    await requireCallerTargetScope(target, context.actorId, context.placeId, db)
  }
  return target
}

export async function thingState(
  thingId: number,
  db: TaggedSql,
  options: Readonly<{ forUpdate?: boolean }> = {},
): Promise<ThingState | null> {
  const rows = await queryRows<Record<string, unknown>>(options.forUpdate === true
    ? db`
      SELECT thing.id, thing.owner_id, thing.place_id,
        thing.withdrawn_at, thing.active_offer_id, thing.open_to_use,
        EXISTS (
          SELECT 1 FROM transfer_offers offer
          WHERE offer.asset_type = 'thing' AND offer.asset_id = thing.id
            AND offer.status = 'open'
        ) AS has_open_offer
      FROM things thing
      WHERE thing.id = ${thingId}
      FOR UPDATE OF thing
    `
    : db`
      SELECT thing.id, thing.owner_id, thing.place_id,
        thing.withdrawn_at, thing.active_offer_id, thing.open_to_use,
        EXISTS (
          SELECT 1 FROM transfer_offers offer
          WHERE offer.asset_type = 'thing' AND offer.asset_id = thing.id
            AND offer.status = 'open'
        ) AS has_open_offer
      FROM things thing
      WHERE thing.id = ${thingId}
    `)
  const row = rows[0]
  if (!row) return null
  return {
    id: rowId(row.id, 'thing id'),
    ownerId: rowId(row.owner_id, 'thing owner id'),
    placeId: rowId(row.place_id, 'thing place id'),
    withdrawnAt: row.withdrawn_at == null ? null : isoTimestamp(row.withdrawn_at),
    activeOfferId: nullableRowId(row.active_offer_id, 'thing offer id'),
    hasOpenOffer: row.has_open_offer === true,
    openToUse: row.open_to_use === true,
  }
}

async function activeLabel(target: RuntimeTarget, label: string, db: TaggedSql): Promise<boolean> {
  const rows = await queryRows<{ present?: unknown }>(db`
    SELECT EXISTS (
      SELECT 1 FROM active_labels
      WHERE target_type = ${target.type} AND target_id = ${target.id}
        AND label = ${label} AND (expires_at IS NULL OR expires_at > now())
    ) AS present
  `)
  return rows[0]?.present === true
}

async function matchingLaw(
  target: RuntimeTarget,
  label: string,
  db: TaggedSql,
) {
  if (target.type !== 'place') return null
  return (await effectiveLaws(target.id, db)).find(law => law.name === label) ?? null
}

function effectExecutionOutcome(
  effectsApplied: number,
  emittedTypedPublicEvent: boolean,
): EffectExecutionOutcome {
  return Object.freeze({ effectsApplied, emittedTypedPublicEvent })
}

function effectOrigin(context: EffectExecutionContext): Readonly<{
  thingId: number | null
  placeId: number | null
}> {
  if (context.originThingId !== undefined || context.originPlaceId !== undefined) {
    const thingId = context.originThingId ?? null
    return Object.freeze({
      thingId,
      placeId: thingId === null ? (context.originPlaceId ?? null) : null,
    })
  }
  if (context.lawAuthority?.traitId === context.sourceTraitId) {
    return Object.freeze({ thingId: null, placeId: context.lawAuthority.sourcePlaceId })
  }
  if (context.lawAuthority !== null) {
    return Object.freeze({ thingId: null, placeId: null })
  }
  return Object.freeze({ thingId: context.sourceThingId, placeId: null })
}

export async function executeEffectsWithOutcome(
  effects: readonly Effect[],
  context: EffectExecutionContext,
  db: TaggedSql,
): Promise<EffectExecutionOutcome> {
  let effectsApplied = 0
  let emittedTypedPublicEvent = false
  for (const effect of effects) {
    const outcome = await executeEffectWithOutcome(effect, context, db)
    effectsApplied += outcome.effectsApplied
    emittedTypedPublicEvent ||= outcome.emittedTypedPublicEvent
  }
  return effectExecutionOutcome(effectsApplied, emittedTypedPublicEvent)
}

export async function executeEffects(
  effects: readonly Effect[],
  context: EffectExecutionContext,
  db: TaggedSql,
): Promise<number> {
  return (await executeEffectsWithOutcome(effects, context, db)).effectsApplied
}

async function executeEffectWithOutcome(
  effect: Effect,
  context: EffectExecutionContext,
  db: TaggedSql,
): Promise<EffectExecutionOutcome> {
  if (effect.effect === 'label') {
    const target = await requireScopedBrickTarget(effect.target, context, db)
    const origin = effectOrigin(context)
    if (target.type === 'place') {
      const places = await queryRows<Record<string, unknown>>(db`
        SELECT id, parent_id, place_kind, owner_id FROM places WHERE id = ${target.id}
      `)
      if (isWorldRootRow(places[0])) throw new EngineError(403, WORLD_TRANSIT_ONLY_ERROR)
    }
    await queryRows(db`
      INSERT INTO active_labels (
        target_type, target_id, label, actor_id,
        source_trait_id, source_place_id, source_thing_id
      ) VALUES (
        ${target.type}, ${target.id}, ${effect.label}, ${context.actorId},
        ${context.sourceTraitId}, ${origin.placeId}, ${origin.thingId}
      ) RETURNING id
    `)
    return effectExecutionOutcome(1, false)
  }
  if (effect.effect === 'block') {
    const target = await requireScopedBrickTarget(effect.target, context, db)
    if (target.type !== 'resident') throw new EngineError(400, 'block target must be a resident')
    const origin = effectOrigin(context)
    await queryRows(db`
      INSERT INTO active_blocks (
        resident_id, action_name, actor_id, source_trait_id,
        source_place_id, source_thing_id, expires_at
      ) VALUES (
        ${target.id}, ${effect.action}, ${context.actorId}, ${context.sourceTraitId},
        ${origin.placeId}, ${origin.thingId},
        now() + make_interval(secs => ${effect.seconds})
      ) RETURNING id
    `)
    return effectExecutionOutcome(1, false)
  }
  if (effect.effect === 'destroy') {
    const target = resolveSymbolicTarget(effect.target, context)
    if (!target || target.type !== 'thing') {
      throw new EngineError(403, 'agents and non-thing targets cannot be destroyed; choose an active thing target instead')
    }
    if (target.id === context.sharedSourceThingId) {
      throw new EngineError(403, SHARED_SOURCE_MUTATION_ERROR)
    }
    await destroyThing(target.id, context, db)
    return effectExecutionOutcome(1, true)
  }
  if (effect.effect === 'move') {
    const resolved = resolveSymbolicTarget(effect.target, context)
    if (resolved?.type === 'thing' && resolved.id === context.sharedSourceThingId) {
      throw new EngineError(403, SHARED_SOURCE_MUTATION_ERROR)
    }
    const target = await requireTarget(resolved, db)
    const emittedTypedPublicEvent = await moveEffectTarget(target, effect.to, context, db)
    return effectExecutionOutcome(1, emittedTypedPublicEvent)
  }
  if (effect.effect === 'transfer') {
    const resolved = resolveSymbolicTarget(effect.target, context)
    if (resolved?.type === 'thing' && resolved.id === context.sharedSourceThingId) {
      throw new EngineError(403, SHARED_SOURCE_MUTATION_ERROR)
    }
    const target = await requireTarget(resolved, db)
    const recipientId = effect.to === 'actor' ? context.actorId : context.recipientId
    if (recipientId === null) throw new EngineError(400, 'transfer effect needs a recipient; send one current resident in to_handle')
    const emittedTypedPublicEvent = await transferAsset(target, context.actorId, recipientId, db)
    return effectExecutionOutcome(1, emittedTypedPublicEvent)
  }
  if (effect.effect === 'wait') {
    const scheduled = await scheduleEffect(effect, context, db)
    return effectExecutionOutcome(scheduled ? 1 : 0, scheduled)
  }

  const target = await requireScopedBrickTarget(effect.target, context, db)
  const law = await matchingLaw(target, effect.label, db)
  const matched = law !== null || await activeLabel(target, effect.label, db)
  const branch = matched ? effect.then : (effect.else ?? [])
  const origin = effectOrigin(context)
  const branchContext: EffectExecutionContext = law === null ? context : {
    ...context,
    originThingId: origin.thingId,
    originPlaceId: origin.placeId,
    lawAuthority: { traitId: law.traitId, sourcePlaceId: law.sourcePlaceId },
  }
  return executeEffectsWithOutcome(branch, branchContext, db)
}

async function destroyThing(
  thingId: number,
  context: EffectExecutionContext,
  db: TaggedSql,
): Promise<void> {
  const thing = await thingState(thingId, db)
  if (!thing || thing.withdrawnAt !== null) throw new EngineError(404, 'thing target was not found; choose a current active thing_id')
  if (thing.activeOfferId !== null || thing.hasOpenOffer) {
    throw new EngineError(409, 'thing has an open sale offer; cancel the offer or choose another active thing')
  }
  const ownedByActor = thing.ownerId === context.actorId
  let rows: unknown[]
  if (ownedByActor) {
    rows = await queryRows(db`
      WITH changed AS (
        UPDATE things SET withdrawn_at = now()
        WHERE id = ${thing.id} AND owner_id = ${context.actorId}
          AND withdrawn_at IS NULL AND active_offer_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM transfer_offers offer
            WHERE offer.asset_type = 'thing' AND offer.asset_id = things.id
              AND offer.status = 'open'
          )
        RETURNING id
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'thing_withdrawn', resident.handle,
          jsonb_build_object('thing_id', changed.id, 'reason', 'destroyed')
        FROM changed JOIN residents resident ON resident.id = ${context.actorId}
      ) SELECT id FROM changed
    `)
  } else {
    const authority = context.lawAuthority
    if (context.placeId === null || thing.placeId !== context.placeId || authority === null) {
      throw new EngineError(403, 'damage to another resident property requires an effective local law')
    }
    rows = await queryRows(db`
      WITH RECURSIVE ancestry AS (
        SELECT place.id, place.parent_id, place.owner_id,
          place.owner_id AS sovereign_owner
        FROM places place WHERE place.id = ${context.placeId}
        UNION ALL
        SELECT parent.id, parent.parent_id, parent.owner_id, ancestry.sovereign_owner
        FROM places parent JOIN ancestry ON parent.id = ancestry.parent_id
        WHERE parent.owner_id = ancestry.sovereign_owner
          AND parent.place_kind <> 'world'
      ), latest AS (
        SELECT DISTINCT ON (change.place_id, change.trait_id)
          change.place_id, change.trait_id, change.change_type
        FROM place_law_changes change JOIN ancestry ON ancestry.id = change.place_id
        ORDER BY change.place_id, change.trait_id, change.id DESC
      ), changed AS (
        UPDATE things SET withdrawn_at = now()
        WHERE id = ${thing.id} AND place_id = ${context.placeId}
          AND withdrawn_at IS NULL AND active_offer_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM transfer_offers offer
            WHERE offer.asset_type = 'thing' AND offer.asset_id = things.id
              AND offer.status = 'open'
          )
          AND EXISTS (
            SELECT 1 FROM latest WHERE place_id = ${authority.sourcePlaceId}
              AND trait_id = ${authority.traitId} AND change_type = 'add'
          ) RETURNING id
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'thing_withdrawn', resident.handle,
          jsonb_build_object('thing_id', changed.id, 'reason', 'destroyed')
        FROM changed JOIN residents resident ON resident.id = ${context.actorId}
      ) SELECT id FROM changed
    `)
  }
  if (rows[0]) return
  if (ownedByActor) throw new EngineError(409, 'thing changed before it could be destroyed; re-read the thing before retrying')
  const current = await thingState(thing.id, db)
  if (!current || current.withdrawnAt !== null || current.placeId !== context.placeId
    || current.activeOfferId !== null || current.hasOpenOffer) {
    throw new EngineError(409, 'thing changed before it could be destroyed; re-read the thing before retrying')
  }
  const authority = context.lawAuthority
  const stillEffective = authority !== null && context.placeId !== null
    && (await effectiveLaws(context.placeId, db)).some(law => (
      law.traitId === authority.traitId && law.sourcePlaceId === authority.sourcePlaceId
    ))
  if (!stillEffective) {
    throw new EngineError(403, 'damage to another resident property requires an effective local law')
  }
  throw new EngineError(409, 'thing changed before it could be destroyed; re-read the thing before retrying')
}

export async function withdrawOwnedThing(
  thingId: number,
  actorId: number,
  actorHandle: string,
  db: TaggedSql,
): Promise<void> {
  const existing = await thingState(thingId, db)
  if (existing?.withdrawnAt !== null && existing?.ownerId === actorId) return
  const rows = await queryRows(db`
    WITH changed AS (
      UPDATE things SET withdrawn_at = now()
      WHERE id = ${thingId} AND owner_id = ${actorId}
        AND withdrawn_at IS NULL AND active_offer_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM transfer_offers offer
          WHERE offer.asset_type = 'thing' AND offer.asset_id = things.id
            AND offer.status = 'open'
        )
      RETURNING id
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'thing_withdrawn', ${actorHandle},
        jsonb_build_object('thing_id', id, 'reason', 'consumed')
      FROM changed
    ) SELECT id FROM changed
  `)
  if (!rows[0]) throw new EngineError(409, 'thing cannot be consumed because its state changed; re-read the thing before retrying')
}

async function moveEffectTarget(
  target: RuntimeTarget,
  destination: 'destination' | 'home',
  context: EffectExecutionContext,
  db: TaggedSql,
): Promise<boolean> {
  if (target.type === 'resident') {
    await requireResidentAtActionPlace(target.id, context.placeId, db)
    if (destination === 'home') {
      await goHome(target.id, db)
      return false
    }
    if (context.destinationPlaceId === null) throw new EngineError(400, 'move effect needs a destination')
    await moveResident(target.id, context.destinationPlaceId, db)
    return false
  }
  if (target.type !== 'thing') throw new EngineError(400, 'move effect target must be a resident or thing')
  const destinationId = destination === 'home'
    ? (await ensurePresence(context.actorId, db)).homePlaceId
    : context.destinationPlaceId
  if (destinationId === null) throw new EngineError(409, 'move destination is unavailable because the effect has no resolved destination; send to_place_id for move and retry')
  return moveThing(target.id, destinationId, context.actorId, db)
}

async function moveThing(
  thingId: number,
  destinationId: number,
  actorId: number,
  db: TaggedSql,
): Promise<boolean> {
  const thing = await thingState(thingId, db)
  if (!thing || thing.withdrawnAt !== null) throw new EngineError(404, 'thing target was not found; choose a current active thing_id')
  if (thing.ownerId !== actorId) throw new EngineError(403, 'only the owner can move a thing')
  if (thing.activeOfferId !== null || thing.hasOpenOffer) {
    throw new EngineError(409, 'thing has an open sale offer; cancel the offer or choose another active thing')
  }
  if (thing.placeId === destinationId) return false
  const places = await queryRows<Record<string, unknown>>(withPlacePermission(db)`
    SELECT place.id, place.parent_id, place.owner_id, place.open_to_things,
      place.retired_at,
      ${placePermission('place', 'open_to_things', actorId)} AS place_permits_things
    FROM places place WHERE place.id = ANY (${[thing.placeId, destinationId]}::int[])
    FOR SHARE OF place
  `)
  const oldPlace = places.find(row => integer(row.id) === thing.placeId)
  const destination = places.find(row => integer(row.id) === destinationId)
  if (!destination) throw new EngineError(404, 'destination place was not found; choose a current place_id from the public map outline')
  if (destination.retired_at != null) {
    throw new EngineError(409, 'destination place is retired; restore it before moving a thing there')
  }
  integer(destination.owner_id)
  if (destination.place_permits_things !== true) {
    throw new EngineError(403, 'destination does not allow visitor things; its owner can enable open_to_things, or choose another open place')
  }
  const adjacent = nullableRowId(destination.parent_id, 'destination parent id') === thing.placeId
    || (oldPlace !== undefined && nullableRowId(oldPlace.parent_id, 'current parent id') === destinationId)
  if (!adjacent) throw new EngineError(403, 'thing move must cross one parent-child edge')
  const rows = await queryRows(withPlacePermission(db)`
    WITH moved AS (
      UPDATE things moving SET place_id = destination.id
    FROM places destination
    WHERE moving.id = ${thing.id} AND moving.owner_id = ${actorId}
      AND moving.place_id = ${thing.placeId}
      AND moving.withdrawn_at IS NULL AND moving.active_offer_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM transfer_offers offer
        WHERE offer.asset_type = 'thing' AND offer.asset_id = moving.id
          AND offer.status = 'open'
      )
      AND destination.id = ${destinationId}
      AND destination.retired_at IS NULL
      AND ${placePermission('destination', 'open_to_things', actorId)}
      RETURNING moving.id, moving.place_id
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'thing_moved', resident.handle, jsonb_build_object(
        'thing_id', moved.id,
        'from_place_id', ${thing.placeId}::integer,
        'place_id', moved.place_id
      )
      FROM moved
      JOIN residents resident ON resident.id = ${actorId}
    )
    SELECT id FROM moved
  `)
  if (!rows[0]) throw new EngineError(409, 'thing or destination changed before the move; re-read both and retry')
  return true
}

async function transferAsset(
  target: RuntimeTarget,
  actorId: number,
  recipientId: number,
  db: TaggedSql,
): Promise<boolean> {
  if (target.type === 'resident') throw new EngineError(403, 'an agent is never property; transfer only a place, thing, or kind you own')
  if (actorId === recipientId) return false
  const conditions = target.type === 'thing'
    ? db`
      WITH recipient AS (SELECT id FROM residents WHERE id = ${recipientId}), moved AS (
        UPDATE things SET owner_id = ${recipientId} FROM recipient
        WHERE things.id = ${target.id} AND things.owner_id = ${actorId}
          AND things.withdrawn_at IS NULL AND things.active_offer_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM transfer_offers offer
            WHERE offer.asset_type = 'thing' AND offer.asset_id = things.id
              AND offer.status = 'open'
          )
        RETURNING things.id
      ), transfer AS (
        INSERT INTO transfers (asset_type, asset_id, from_id, to_id)
        SELECT 'thing', id, ${actorId}, ${recipientId} FROM moved
        RETURNING id, asset_type, asset_id, from_id, to_id
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'transfer', resident.handle, jsonb_build_object(
          'type', asset_type, 'id', asset_id, 'from_id', from_id,
          'to_id', to_id, 'mode', 'effect', 'resident_id', ${recipientId}::integer,
          'place_id', presence.current_place_id
        ) FROM transfer JOIN residents resident ON resident.id = ${actorId}
        JOIN resident_presence presence ON presence.resident_id = resident.id
      ) SELECT id FROM transfer
    `
    : target.type === 'place'
      ? db`
        WITH recipient AS (SELECT id FROM residents WHERE id = ${recipientId}), moved AS (
          UPDATE places SET owner_id = ${recipientId} FROM recipient
          WHERE places.id = ${target.id} AND places.owner_id = ${actorId}
            AND places.active_offer_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM transfer_offers offer
              WHERE offer.asset_type = 'place' AND offer.asset_id = places.id
                AND offer.status = 'open'
            ) RETURNING places.id
        ), transfer AS (
          INSERT INTO transfers (asset_type, asset_id, from_id, to_id)
          SELECT 'place', id, ${actorId}, ${recipientId} FROM moved
          RETURNING id, asset_type, asset_id, from_id, to_id
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'transfer', resident.handle, jsonb_build_object(
            'type', asset_type, 'id', asset_id, 'from_id', from_id,
            'to_id', to_id, 'mode', 'effect', 'resident_id', ${recipientId}::integer,
            'place_id', presence.current_place_id
          ) FROM transfer JOIN residents resident ON resident.id = ${actorId}
          JOIN resident_presence presence ON presence.resident_id = resident.id
        ) SELECT id FROM transfer
      `
      : db`
        WITH recipient AS (SELECT id FROM residents WHERE id = ${recipientId}), moved AS (
          UPDATE kinds SET owner_id = ${recipientId} FROM recipient
          WHERE kinds.id = ${target.id} AND kinds.owner_id = ${actorId}
            AND kinds.active_offer_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM transfer_offers offer
              WHERE offer.asset_type = 'kind' AND offer.asset_id = kinds.id
                AND offer.status = 'open'
            ) RETURNING kinds.id
        ), transfer AS (
          INSERT INTO transfers (asset_type, asset_id, from_id, to_id)
          SELECT 'kind', id, ${actorId}, ${recipientId} FROM moved
          RETURNING id, asset_type, asset_id, from_id, to_id
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'transfer', resident.handle, jsonb_build_object(
            'type', asset_type, 'id', asset_id, 'from_id', from_id,
            'to_id', to_id, 'mode', 'effect', 'resident_id', ${recipientId}::integer,
            'place_id', presence.current_place_id
          ) FROM transfer JOIN residents resident ON resident.id = ${actorId}
          JOIN resident_presence presence ON presence.resident_id = resident.id
        ) SELECT id FROM transfer
      `
  if ((await queryRows(conditions)).length === 0) await throwTransferFailure(target, actorId, db)
  return true
}

async function throwTransferFailure(target: RuntimeTarget, actorId: number, db: TaggedSql): Promise<never> {
  if (target.type === 'thing') {
    const thing = await thingState(target.id, db)
    if (!thing || thing.withdrawnAt !== null) throw new EngineError(404, 'thing target was not found; choose a current active thing_id')
    if (thing.ownerId !== actorId) throw new EngineError(403, 'you cannot transfer this asset because you do not own it; choose an asset you own')
    if (thing.activeOfferId !== null || thing.hasOpenOffer) {
      throw new EngineError(409, 'asset has an open transfer offer; cancel the offer or choose another owned asset')
    }
    throw new EngineError(409, 'asset changed before it could transfer; re-read its owner and offer state before retrying')
  }
  const rows = target.type === 'place'
    ? await queryRows<Record<string, unknown>>(db`
      SELECT asset.owner_id, asset.active_offer_id,
        EXISTS (
          SELECT 1 FROM transfer_offers offer
          WHERE offer.asset_type = 'place' AND offer.asset_id = asset.id
            AND offer.status = 'open'
        ) AS has_open_offer
      FROM places asset WHERE asset.id = ${target.id}
    `)
    : await queryRows<Record<string, unknown>>(db`
      SELECT asset.owner_id, asset.active_offer_id,
        EXISTS (
          SELECT 1 FROM transfer_offers offer
          WHERE offer.asset_type = 'kind' AND offer.asset_id = asset.id
            AND offer.status = 'open'
        ) AS has_open_offer
      FROM kinds asset WHERE asset.id = ${target.id}
    `)
  const asset = rows[0]
  if (!asset) throw new EngineError(404, `${target.type} target was not found; choose a current public target before retrying`)
  if (integer(asset.owner_id) !== actorId) throw new EngineError(403, 'you cannot transfer this asset because you do not own it; choose an asset you own')
  if (asset.active_offer_id != null || asset.has_open_offer === true) {
    throw new EngineError(409, 'asset has an open transfer offer; cancel the offer or choose another owned asset')
  }
  throw new EngineError(409, 'asset changed before it could transfer; re-read its owner and offer state before retrying')
}

async function scheduleEffect(
  effect: Extract<Effect, { effect: 'wait' }>,
  context: EffectExecutionContext,
  db: TaggedSql,
): Promise<boolean> {
  if (!Number.isSafeInteger(effect.seconds)
    || effect.seconds < MIN_TIMER_SECONDS || effect.seconds > MAX_TIMER_SECONDS) {
    throw new EngineError(400, `wait duration must be ${MIN_TIMER_SECONDS}-${MAX_TIMER_SECONDS} seconds`)
  }
  const generation = context.parentEffectId === null ? 0 : context.generation + 1
  if (generation > MAX_EFFECT_GENERATIONS) return false
  if (context.placeId === null) throw new EngineError(400, 'wait effect needs a place')
  const logicalDueAt = new Date(context.logicalAt.getTime() + effect.seconds * 1_000)
  const origin = effectOrigin(context)
  const payload = {
    effects: effect.then,
    repeat_remaining: effect.repeat ?? 0,
    repeat_seconds: effect.seconds,
    logical_due_at: logicalDueAt.toISOString(),
    law_authority: context.lawAuthority === null ? null : {
      trait_id: context.lawAuthority.traitId,
      source_place_id: context.lawAuthority.sourcePlaceId,
    },
    shared_source_thing_id: context.sharedSourceThingId,
    effect_origin: {
      source_thing_id: origin.thingId,
      source_place_id: origin.placeId,
    },
  }
  await insertPendingEffect({
    actionId: context.actionId,
    parentEffectId: context.parentEffectId,
    placeId: context.placeId,
    actorId: context.actorId,
    sourceTraitId: context.sourceTraitId,
    sourceThingId: context.sourceThingId,
    targetType: context.target?.type ?? null,
    targetId: context.target?.id ?? null,
    destinationPlaceId: context.destinationPlaceId,
    recipientId: context.recipientId,
    payloadJson: json(payload),
    logicalDueAt: logicalDueAt.toISOString(),
    generation,
  }, db)
  return true
}

function pendingFromRow(row: Record<string, unknown>): PendingRow | null {
  const payload = objectRecord(row.payload)
  if (!payload || !Array.isArray(payload.effects)) return null
  const recipe = parseTraitRecipe({ use: payload.effects })
  if (!recipe?.use) return null
  const type = row.target_type == null ? null : targetType(row.target_type)
  const id = row.target_id == null ? null : integer(row.target_id)
  if ((type === null) !== (id === null) || (id !== null && id <= 0)) return null
  const repeatRemaining = payload.repeat_remaining == null ? 0 : integer(payload.repeat_remaining)
  const repeatSeconds = payload.repeat_seconds == null ? null : integer(payload.repeat_seconds)
  if (repeatRemaining === null || repeatRemaining < 0 || repeatRemaining > MAX_EFFECT_GENERATIONS) return null
  if (repeatRemaining > 0 && (repeatSeconds === null
    || repeatSeconds < MIN_TIMER_SECONDS || repeatSeconds > MAX_TIMER_SECONDS)) return null
  const rawAuthority = objectRecord(payload.law_authority)
  const authorityTrait = rawAuthority ? integer(rawAuthority.trait_id) : null
  const authorityPlace = rawAuthority ? integer(rawAuthority.source_place_id) : null
  const lawAuthority = authorityTrait && authorityPlace
    ? { traitId: authorityTrait, sourcePlaceId: authorityPlace }
    : null
  const hasOrigin = Object.hasOwn(payload, 'effect_origin')
  const rawOrigin = hasOrigin ? objectRecord(payload.effect_origin) : null
  if (
    hasOrigin
    && (
      rawOrigin === null
      || !Object.hasOwn(rawOrigin, 'source_thing_id')
      || !Object.hasOwn(rawOrigin, 'source_place_id')
    )
  ) return null
  const rawOriginThingId = rawOrigin?.source_thing_id
  const rawOriginPlaceId = rawOrigin?.source_place_id
  const originThingId = !hasOrigin || rawOriginThingId == null
    ? null
    : integer(rawOriginThingId)
  const originPlaceId = !hasOrigin || rawOriginPlaceId == null
    ? null
    : integer(rawOriginPlaceId)
  if (
    (rawOriginThingId != null && originThingId === null)
    || (rawOriginPlaceId != null && originPlaceId === null)
    || (originThingId !== null && originThingId <= 0)
    || (originPlaceId !== null && originPlaceId <= 0)
    || (originThingId !== null && originPlaceId !== null)
  ) return null
  const dueAt = new Date(isoTimestamp(row.due_at)!)
  const logicalDueAt = new Date(isoTimestamp(payload.logical_due_at ?? row.due_at)!)
  const generation = integer(row.generation)
  if (!Number.isFinite(dueAt.getTime()) || !Number.isFinite(logicalDueAt.getTime())
    || generation === null || generation < 0 || generation > MAX_EFFECT_GENERATIONS) return null
  const sourceThingId = nullableRowId(row.source_thing_id, 'pending source thing id')
  const hasSharedSourceThingId = payload.shared_source_thing_id != null
  const sharedSourceThingId = !hasSharedSourceThingId
    ? null
    : integer(payload.shared_source_thing_id)
  if (
    hasSharedSourceThingId
    && (
      sharedSourceThingId === null
      || sharedSourceThingId <= 0
      || sharedSourceThingId !== sourceThingId
    )
  ) return null
  return {
    id: rowId(row.id, 'pending effect id'),
    actionId: nullableRowId(row.action_id, 'pending action id'),
    placeId: rowId(row.place_id, 'pending place id'),
    actorId: rowId(row.actor_id, 'pending actor id'),
    sourceTraitId: nullableRowId(row.source_trait_id, 'pending source trait id'),
    sourceThingId,
    sharedSourceThingId,
    target: type && id ? { type, id } : null,
    destinationPlaceId: nullableRowId(row.destination_place_id, 'pending destination id'),
    recipientId: nullableRowId(row.recipient_id, 'pending recipient id'),
    effects: recipe.use,
    repeatRemaining,
    repeatSeconds,
    lawAuthority,
    originThingId: hasOrigin ? originThingId : undefined,
    originPlaceId: hasOrigin ? originPlaceId : undefined,
    dueAt,
    logicalDueAt,
    generation,
  }
}

async function dueRows(placeId: number, db: TaggedSql): Promise<Record<string, unknown>[]> {
  return queryRows(db`
    SELECT pending.id, pending.action_id, pending.parent_effect_id, pending.place_id,
      pending.actor_id, pending.source_trait_id, pending.source_thing_id,
      pending.target_type, pending.target_id, pending.destination_place_id,
      pending.recipient_id, pending.payload, pending.due_at, pending.generation
    FROM pending_effects pending
    LEFT JOIN effect_resolutions resolution ON resolution.pending_effect_id = pending.id
    WHERE pending.place_id = ${placeId} AND pending.due_at <= now() AND resolution.id IS NULL
    ORDER BY pending.due_at ASC, pending.id ASC LIMIT ${DUE_BATCH_SIZE}
  `)
}

async function lockAndLoadPending(
  pendingId: number,
  placeId: number,
  db: TaggedSql,
): Promise<Record<string, unknown> | null> {
  await queryRows(db`SELECT pg_advisory_xact_lock(${pendingId}::bigint)`)
  const rows = await queryRows<Record<string, unknown>>(db`
    SELECT pending.id, pending.action_id, pending.parent_effect_id, pending.place_id,
      pending.actor_id, pending.source_trait_id, pending.source_thing_id,
      pending.target_type, pending.target_id, pending.destination_place_id,
      pending.recipient_id, pending.payload, pending.due_at, pending.generation
    FROM pending_effects pending
    LEFT JOIN effect_resolutions resolution ON resolution.pending_effect_id = pending.id
    WHERE pending.id = ${pendingId} AND pending.place_id = ${placeId}
      AND pending.due_at <= now() AND resolution.id IS NULL
    FOR UPDATE OF pending
  `)
  return rows[0] ?? null
}

async function recordEffectResolution(
  pendingId: number,
  status: 'applied' | 'skipped' | 'failed',
  detail: Readonly<Record<string, unknown>>,
  db: TaggedSql,
) {
  const error = typeof detail.error === 'string' ? detail.error : null
  const publicDetail = Object.freeze({
    effect_id: pendingId,
    status,
    ...(error === null ? {} : { error }),
  })
  await queryRows(db`
    WITH resolution AS (
      INSERT INTO effect_resolutions (pending_effect_id, status, detail)
      VALUES (${pendingId}, ${status}, ${json(detail)}::jsonb)
      ON CONFLICT (pending_effect_id) DO NOTHING RETURNING id, pending_effect_id
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'effect_resolved', resident.handle,
        ${json(publicDetail)}::jsonb
      FROM resolution
      JOIN pending_effects pending ON pending.id = resolution.pending_effect_id
      JOIN residents resident ON resident.id = pending.actor_id
    ) SELECT id FROM resolution
  `)
}

async function repeatPending(row: PendingRow, context: EffectExecutionContext, db: TaggedSql) {
  if (row.repeatRemaining <= 0 || row.repeatSeconds === null
    || row.generation >= MAX_EFFECT_GENERATIONS) return
  await scheduleEffect({
    effect: 'wait', seconds: row.repeatSeconds, then: row.effects,
    repeat: row.repeatRemaining - 1,
  }, context, db)
}

async function resolveOne(
  raw: Record<string, unknown>,
  placeId: number,
  db: TaggedSql,
  atomic: boolean,
): Promise<'resolved' | 'failed' | 'already-resolved'> {
  const pendingId = rowId(raw.id, 'pending effect id')
  const fresh = atomic ? await lockAndLoadPending(pendingId, placeId, db) : raw
  if (!fresh) return 'already-resolved'
  const row = pendingFromRow(fresh)
  if (!row) {
    await recordEffectResolution(pendingId, 'skipped', { error: 'invalid stored effect payload' }, db)
    return 'failed'
  }
  const context: EffectExecutionContext = {
    actionId: row.actionId,
    actorId: row.actorId,
    actorHandle: '',
    placeId: row.placeId,
    sourceThingId: row.sourceThingId,
    sharedSourceThingId: row.sharedSourceThingId,
    target: row.target,
    destinationPlaceId: row.destinationPlaceId,
    recipientId: row.recipientId,
    sourceTraitId: row.sourceTraitId,
    lawAuthority: row.lawAuthority,
    ...(row.originThingId === undefined ? {} : { originThingId: row.originThingId }),
    ...(row.originPlaceId === undefined ? {} : { originPlaceId: row.originPlaceId }),
    parentEffectId: row.id,
    generation: row.generation,
    logicalAt: row.logicalDueAt,
  }
  const effectsApplied = await executeEffects(row.effects, context, db)
  await repeatPending(row, context, db)
  await recordEffectResolution(row.id, 'applied', { effects_applied: effectsApplied }, db)
  return 'resolved'
}

async function recordFailedEffect(
  pendingId: number,
  placeId: number,
  message: string,
  db: TaggedSql,
  atomic: boolean,
): Promise<boolean> {
  if (atomic && !await lockAndLoadPending(pendingId, placeId, db)) return false
  await recordEffectResolution(pendingId, 'failed', { error: message }, db)
  return true
}

export async function resolveDueEffects(
  placeId: number,
  db: TaggedSql = engineSql,
): Promise<{ resolved: number; failed: number; capped: boolean }> {
  if (!Number.isSafeInteger(placeId) || placeId <= 0) throw new EngineError(400, 'place id must be positive')
  let resolved = 0
  let failed = 0
  while (resolved + failed < MAX_DUE_EFFECTS_PER_OBSERVATION) {
    const batch = await dueRows(placeId, db)
    if (batch.length === 0) break
    let progressed = false
    for (const raw of batch) {
      if (resolved + failed >= MAX_DUE_EFFECTS_PER_OBSERVATION) break
      let outcome: 'resolved' | 'failed' | 'already-resolved'
      try {
        outcome = await withEngineTransaction(db, (transaction, atomic) => (
          resolveOne(raw, placeId, transaction, atomic)
        ))
      } catch (error) {
        const pendingId = rowId(raw.id, 'pending effect id')
        if (!(error instanceof EngineError) || error.status >= 500) {
          logUnrecognizedExecutionFailure('stored effect', pendingId, error)
        }
        const message = error instanceof EngineError && error.status < 500
          ? error.message
          : UNKNOWN_STORED_EFFECT_ERROR
        const recorded = await withEngineTransaction(db, (transaction, atomic) => (
          recordFailedEffect(pendingId, placeId, message, transaction, atomic)
        ))
        outcome = recorded ? 'failed' : 'already-resolved'
      }
      if (outcome === 'resolved') {
        resolved += 1
        progressed = true
      } else if (outcome === 'failed') {
        failed += 1
        progressed = true
      }
    }
    if (db !== engineSql && (!progressed || batch.length < DUE_BATCH_SIZE)) break
  }
  return { resolved, failed, capped: resolved + failed >= MAX_DUE_EFFECTS_PER_OBSERVATION }
}
