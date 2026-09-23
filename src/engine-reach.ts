/**
 * Reach (decision #113): run a reach's steps once for each member of the room,
 * with target set to that member. Soft steps reach every member; a harder step
 * reaches only things whose owners set open_to_reach, plus the answering
 * resident's own things when the program is that resident's own thing's traits.
 */
import { EngineError, type TaggedSql } from './engine.ts'
import { recordMemberRefusedRolls } from './engine-chance.ts'
import {
  effectOrigin,
  executeEffectsWithOutcome,
  newAbilityLog,
  type EffectExecutionContext,
  type EffectExecutionOutcome,
  type ReachMember,
  type SkippedEffect,
} from './engine-effects.ts'
import { MAX_REACH_APPLICATIONS_PER_ACTION } from './engine-limits.ts'
import { programWeight, reachIsHard, type ReachEffect } from './physics.ts'

export const REACH_MEMBER_REFUSED = 'this reach member refused the step' as const

interface Member {
  readonly id: number
  readonly admittedBy: ReachMember['admittedBy']
}

/** The first max members in id order, and how many members there are in all. */
async function loadMembers(
  effect: ReachEffect,
  context: EffectExecutionContext,
  hard: boolean,
  db: TaggedSql,
): Promise<Readonly<{ members: readonly Member[]; total: number }>> {
  if (context.placeId === null) return Object.freeze({ members: [], total: 0 })
  if (effect.over === 'residents') {
    const rows = await db`
      SELECT presence.resident_id AS id, count(*) OVER () AS total
      FROM resident_presence presence
      WHERE presence.current_place_id = ${context.placeId}
      ORDER BY presence.resident_id
      LIMIT ${effect.max}
    ` as Array<{ id?: unknown; total?: unknown }>
    return Object.freeze({
      members: rows.map(row => Object.freeze({ id: Number(row.id), admittedBy: 'soft' as const })),
      total: Number(rows[0]?.total ?? 0),
    })
  }
  const own = context.ownProgram === true
  const excluded = [context.sourceThingId, context.originThingId ?? null]
    .filter((id): id is number => id !== null)
  const rows = await db`
    SELECT thing.id, thing.owner_id, count(*) OVER () AS total
    FROM things thing
    LEFT JOIN kinds kind ON kind.id = coalesce(thing.as_kind_id, thing.kind_id)
    WHERE thing.place_id = ${context.placeId} AND thing.withdrawn_at IS NULL
      AND thing.held_by IS NULL
      AND NOT (thing.id = ANY(${excluded}::int[]))
      AND (${effect.kind ?? null}::text IS NULL OR kind.name = ${effect.kind ?? null}::text)
      AND coalesce((
        SELECT moderation.action FROM moderation_actions moderation
        WHERE moderation.target_type = 'thing' AND moderation.target_id = thing.id
        ORDER BY moderation.created_at DESC, moderation.id DESC LIMIT 1
      ), 'restore') <> 'remove'
      AND (
        NOT ${hard}::boolean OR thing.open_to_reach
        OR (${own}::boolean AND thing.owner_id = ${context.actorId})
      )
    ORDER BY thing.id
    LIMIT ${effect.max}
  ` as Array<{ id?: unknown; owner_id?: unknown; total?: unknown }>
  return Object.freeze({
    members: rows.map(row => Object.freeze({
      id: Number(row.id),
      admittedBy: !hard ? 'soft' as const
        : own && Number(row.owner_id) === context.actorId ? 'own' as const : 'open' as const,
    })),
    total: Number(rows[0]?.total ?? 0),
  })
}

async function savepoint(db: TaggedSql, statement: 'SAVEPOINT' | 'RELEASE' | 'ROLLBACK'): Promise<void> {
  if (statement === 'SAVEPOINT') await db`SAVEPOINT reach_member`
  else if (statement === 'RELEASE') await db`RELEASE SAVEPOINT reach_member`
  else await db`ROLLBACK TO SAVEPOINT reach_member`
}

/**
 * Run the steps for every member, each inside its own savepoint. A rule
 * refusal skips only that member, names it, and keeps its drawn rolls public;
 * a city fault still fails the whole run.
 */
export async function runReach(
  effect: ReachEffect,
  context: EffectExecutionContext,
  db: TaggedSql,
): Promise<EffectExecutionOutcome> {
  const log = context.abilityLog ?? newAbilityLog()
  const hard = reachIsHard(effect)
  const { members, total } = await loadMembers(effect, context, hard, db)
  const memberType = effect.over === 'residents' ? 'resident' as const : 'thing' as const
  // The most applications one member's steps can make; a member runs only when
  // all of them still fit, so all reaches together never pass the limit.
  const memberWeight = programWeight(effect.then)
  let applied = 0
  let reached = 0
  let emitted = false
  let destroyedThingIds = context.destroyedThingIds
  let skipped: readonly SkippedEffect[] = []
  let refusedMembers = 0
  let stopped: 'action_reach_limit' | null = null
  for (const member of members) {
    if (log.reachApplications + memberWeight > MAX_REACH_APPLICATIONS_PER_ACTION) {
      stopped = 'action_reach_limit'
      break
    }
    const rollsBefore = context.rollLog?.rolls.length ?? 0
    const copiedBefore = log.copied.length
    const convertedBefore = log.converted.length
    reached += 1
    await savepoint(db, 'SAVEPOINT')
    try {
      const outcome = await executeEffectsWithOutcome(effect.then, {
        ...context,
        target: { type: memberType, id: member.id },
        reachMember: { answererId: context.actorId, admittedBy: member.admittedBy },
        abilityLog: log,
        ...(destroyedThingIds === undefined ? {} : { destroyedThingIds }),
      }, db)
      await savepoint(db, 'RELEASE')
      applied += outcome.effectsApplied
      log.reachApplications += outcome.effectsApplied
      emitted ||= outcome.emittedTypedPublicEvent
      destroyedThingIds = outcome.destroyedThingIds ?? destroyedThingIds
      skipped = [...skipped, ...(outcome.skippedEffects ?? [])]
    } catch (error) {
      if (!(error instanceof EngineError) || error.status >= 500) throw error
      await savepoint(db, 'ROLLBACK')
      await savepoint(db, 'RELEASE')
      log.copied.splice(copiedBefore)
      log.converted.splice(convertedBefore)
      if (context.rollLog) await recordMemberRefusedRolls(context.rollLog, rollsBefore, db)
      refusedMembers += 1
      skipped = [...skipped, Object.freeze({
        effect: 'reach',
        target: 'target',
        sourceTrait: context.sourceTraitName ?? null,
        sourceTraitId: context.sourceTraitId,
        sourcePlaceId: context.originPlaceId ?? null,
        reason: REACH_MEMBER_REFUSED,
        memberId: member.id,
        error: error.message,
      })]
    }
  }
  const more = Math.max(0, total - reached)
  log.reaches.push(Object.freeze({
    sourceTrait: context.sourceTraitName ?? null,
    sourceTraitId: context.sourceTraitId,
    over: effect.over,
    reached,
    more,
    stopped,
  }))
  if (context.placeId !== null) {
    await db`
      INSERT INTO events (kind, actor, detail)
      SELECT 'room_reached', resident.handle, jsonb_build_object(
        'thing_id', ${effectOrigin(context).thingId}::integer,
        'trait_id', ${context.sourceTraitId}::integer,
        'place_id', ${context.placeId}::integer,
        'over', ${effect.over}::text,
        'reached', ${reached}::integer,
        'more', ${more}::integer,
        'skipped', ${refusedMembers}::integer,
        'stopped', ${stopped}::text,
        'action_id', ${context.actionId}::bigint,
        'settle_id', ${context.settleId ?? null}::bigint
      )
      FROM residents resident WHERE resident.id = ${context.actorId}
    `
  }
  return Object.freeze({
    effectsApplied: applied,
    emittedTypedPublicEvent: emitted,
    ...(destroyedThingIds === undefined ? {} : { destroyedThingIds: Object.freeze([...destroyedThingIds]) }),
    ...(destroyedThingIds === undefined && skipped.length === 0 ? {} : { skippedEffects: Object.freeze([...skipped]) }),
  })
}

/**
 * A delayed step from a harder reach fires only while its member still
 * consents: an open member must still be open_to_reach, and an own member must
 * still belong to the resident who answered for the reach.
 */
export async function reachMemberStillConsents(
  member: ReachMember,
  thingId: number,
  db: TaggedSql,
): Promise<boolean> {
  const rows = await db`
    SELECT owner_id, open_to_reach FROM things
    WHERE id = ${thingId} AND withdrawn_at IS NULL
  ` as Array<{ owner_id?: unknown; open_to_reach?: unknown }>
  const row = rows[0]
  if (!row) return false
  return member.admittedBy === 'open'
    ? row.open_to_reach === true
    : Number(row.owner_id) === member.answererId
}
