/**
 * The state box (decision #108): a small typed box of values on a thing, written
 * only by that thing's own kind traits and never touching its name or body.
 */
import { EngineError, type TaggedSql } from './engine.ts'
import { lastRoll, type RollLog } from './engine-chance.ts'
import {
  STATE_BOX_MAX_BYTES,
  STATE_BOX_MAX_KEYS,
  STATE_INTEGER_LIMIT,
  STATE_LIST_MAX_ITEMS,
  type WriteEffect,
  type WriteOp,
} from './physics.ts'
import { requireWakeActor } from './wake-guard.ts'

export type StateValue = number | boolean | string | readonly string[]
export type StateValues = Readonly<Record<string, StateValue>>

export const KIND_ONLY_BRICK_ERROR =
  "a kind-only brick reached a program that is not a thing's own kind traits; the city could not complete this effect"

const STATE_TRIGGERS = new Set([
  'use', 'consume', 'give', 'timer', 'wake_arrive', 'wake_talk', 'wake_clock',
])

export function stateBoxBytes(values: StateValues): number {
  return Buffer.byteLength(JSON.stringify(values), 'utf8')
}

function typeName(value: StateValue): string {
  if (Array.isArray(value)) return 'a list of lines'
  if (typeof value === 'number') return 'a whole number'
  if (typeof value === 'boolean') return 'true or false'
  return 'text'
}

function fullBoxError(thingId: number): EngineError {
  return new EngineError(409, `the state box of thing ${thingId} would pass ${STATE_BOX_MAX_BYTES} bytes; write a shorter value, or its owner can clear the box with thing_edit state_clear`)
}

/**
 * Apply one write to a box and return the new box and how many old lines an
 * append dropped. Append drops a list's oldest lines, one at a time, until the
 * list holds at most 20 lines and the whole box fits.
 */
export function applyStateWrite(
  thingId: number,
  values: StateValues,
  key: string,
  op: WriteOp,
  value: number | boolean | string,
): Readonly<{ values: StateValues; trimmed: number }> {
  const present = Object.hasOwn(values, key)
  if (!present && Object.keys(values).length >= STATE_BOX_MAX_KEYS) {
    throw new EngineError(409, `the state box of thing ${thingId} already holds ${STATE_BOX_MAX_KEYS} keys; write to a key it has, or its owner can clear the box with thing_edit state_clear`)
  }
  const current = present ? values[key] : undefined
  if (op === 'add') {
    if (current !== undefined && typeof current !== 'number') {
      throw new EngineError(409, `write add needs key ${key} to hold a whole number; it holds ${typeName(current)}; use set to replace it first`)
    }
    const total = (current ?? 0) + (value as number)
    if (Math.abs(total) > STATE_INTEGER_LIMIT) {
      throw new EngineError(409, `write add would move key ${key} past ${STATE_INTEGER_LIMIT} or below -${STATE_INTEGER_LIMIT}; add a smaller amount or set a new value`)
    }
    const next = Object.freeze({ ...values, [key]: total })
    if (stateBoxBytes(next) > STATE_BOX_MAX_BYTES) throw fullBoxError(thingId)
    return Object.freeze({ values: next, trimmed: 0 })
  }
  if (op === 'append') {
    if (current !== undefined && !Array.isArray(current)) {
      throw new EngineError(409, `write append needs key ${key} to hold a list of lines; it holds ${typeName(current)}; use set to replace it first`)
    }
    const lines = [...((current as readonly string[] | undefined) ?? []), String(value)]
    let trimmed = 0
    const boxWith = (list: readonly string[]) => Object.freeze({ ...values, [key]: Object.freeze([...list]) })
    while (
      lines.length > 1
      && (lines.length > STATE_LIST_MAX_ITEMS || stateBoxBytes(boxWith(lines)) > STATE_BOX_MAX_BYTES)
    ) {
      lines.shift()
      trimmed += 1
    }
    const next = boxWith(lines)
    if (stateBoxBytes(next) > STATE_BOX_MAX_BYTES) throw fullBoxError(thingId)
    return Object.freeze({ values: next, trimmed })
  }
  const next = Object.freeze({ ...values, [key]: value })
  if (stateBoxBytes(next) > STATE_BOX_MAX_BYTES) throw fullBoxError(thingId)
  return Object.freeze({ values: next, trimmed: 0 })
}

interface WriteContext {
  readonly actionId: number | null
  readonly actorId: number
  readonly actorHandle: string
  readonly actorSymbolId?: number | null
  readonly fromWake?: boolean
  readonly originThingId?: number | null
  readonly placeId: number | null
  readonly sourceTraitId: number | null
  readonly trigger?: string
  readonly rollLog?: RollLog
  readonly settleId?: number | null
  readonly logicalAt: Date
}

async function residentHandle(id: number, db: TaggedSql): Promise<string> {
  const rows = await db`SELECT handle FROM residents WHERE id = ${id}` as Array<{ handle?: unknown }>
  const handle = rows[0]?.handle
  if (typeof handle !== 'string') throw new EngineError(500, KIND_ONLY_BRICK_ERROR)
  return handle
}

async function resolvedValue(
  effect: WriteEffect,
  context: WriteContext,
  db: TaggedSql,
): Promise<number | boolean | string> {
  const written = effect.value
  if (typeof written !== 'object') return written
  if (written.from === 'time') return context.logicalAt.toISOString()
  if (written.from === 'roll') {
    const roll = lastRoll(context.rollLog)
    if (roll === null) {
      throw new EngineError(409, 'write from roll needs a chance roll earlier in this same run; put the write after or inside a chance')
    }
    return roll
  }
  requireWakeActor(context)
  const residentId = context.actorSymbolId ?? context.actorId
  return residentId === context.actorId && context.actorHandle !== ''
    ? context.actorHandle
    : residentHandle(residentId, db)
}

/**
 * Write the state box of the thing whose own kind traits run this program, then
 * record the change and one public thing_edited event with mode state.
 */
export async function writeStateBox(
  effect: WriteEffect,
  context: WriteContext,
  db: TaggedSql,
): Promise<void> {
  const thingId = context.originThingId
  if (thingId == null || !STATE_TRIGGERS.has(context.trigger ?? '')) {
    throw new EngineError(500, KIND_ONLY_BRICK_ERROR)
  }
  const rows = await db`
    SELECT state, place_id, withdrawn_at FROM things WHERE id = ${thingId} FOR UPDATE
  ` as Array<{ state?: unknown; place_id?: unknown; withdrawn_at?: unknown }>
  const thing = rows[0]
  if (!thing || thing.withdrawn_at != null) {
    throw new EngineError(409, `the state box of thing ${thingId} cannot change because the thing is gone`)
  }
  const value = await resolvedValue(effect, context, db)
  const stored = (thing.state ?? {}) as StateValues
  const next = applyStateWrite(thingId, stored, effect.key, effect.op, value)
  const residentId = context.fromWake === true
    ? (context.actorSymbolId ?? null)
    : (context.actorSymbolId ?? context.actorId)
  const written = effect.op === 'append' ? String(value) : value
  await db`
    WITH changed AS (
      UPDATE things SET state = ${JSON.stringify(next.values)}::jsonb,
        state_version = state_version + 1
      WHERE id = ${thingId}
      RETURNING id, place_id, state_version
    ), history AS (
      INSERT INTO thing_state_changes (
        thing_id, version, key, op, value, trimmed, source_trait_id, trigger,
        resident_id, authority_id, action_id, settle_id
      )
      SELECT changed.id, changed.state_version, ${effect.key}, ${effect.op},
        ${JSON.stringify(written)}::jsonb, ${next.trimmed}, ${context.sourceTraitId},
        ${context.trigger ?? null}, ${residentId}, ${context.actorId}, ${context.actionId},
        ${context.settleId ?? null}
      FROM changed
      RETURNING version
    )
    INSERT INTO events (kind, actor, detail)
    SELECT 'thing_edited', resident.handle, jsonb_build_object(
      'thing_id', changed.id,
      'place_id', changed.place_id,
      'mode', 'state',
      'version', changed.state_version,
      'key', ${effect.key}::text,
      'op', ${effect.op}::text,
      'trimmed', ${next.trimmed}::integer
    )
    FROM changed JOIN residents resident ON resident.id = ${context.actorId}
  `
}

/** The owner empties the box; the clear is recorded like any write. */
export async function clearStateBox(
  thingId: number,
  ownerId: number,
  db: TaggedSql,
): Promise<number> {
  const rows = await db`
    WITH changed AS (
      UPDATE things SET state = '{}'::jsonb, state_version = state_version + 1
      WHERE id = ${thingId} AND owner_id = ${ownerId} AND withdrawn_at IS NULL
      RETURNING id, place_id, state_version
    ), history AS (
      INSERT INTO thing_state_changes (
        thing_id, version, key, op, value, trimmed, trigger, resident_id, authority_id
      )
      SELECT changed.id, changed.state_version, NULL, 'clear', NULL, 0, 'owner',
        ${ownerId}, ${ownerId}
      FROM changed
      RETURNING version
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'thing_edited', resident.handle, jsonb_build_object(
        'thing_id', changed.id,
        'place_id', changed.place_id,
        'mode', 'state',
        'version', changed.state_version,
        'op', 'clear'
      )
      FROM changed JOIN residents resident ON resident.id = ${ownerId}
    )
    SELECT state_version FROM changed
  ` as Array<{ state_version?: unknown }>
  const version = Number(rows[0]?.state_version)
  if (!Number.isSafeInteger(version)) {
    throw new EngineError(409, 'thing changed before its state box could be cleared; re-read the thing before retrying')
  }
  return version
}
