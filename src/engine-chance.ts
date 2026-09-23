/**
 * The public roll (decision #107): one secret per UTC day, committed a day
 * ahead, and every roll written down before anything it decides happens.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { EngineError, engineSql, withEngineTransaction, type TaggedSql } from './engine.ts'

const CHANCE_DAYS_LOCK_CLASS = 0x1f3d9007
export const CHANCE_SIDES = 100
export const ROLL_RECORD_ERROR =
  'the city could not record this roll; retry once, then contact the city operator'

export type RollPurpose = 'chance' | 'wake_pick'
export type RollOutcome = 'counted' | 'action_failed'

/** Every input of one drawn roll, kept so a failed run can still record it exactly. */
export interface DrawnRoll {
  readonly rollId: number
  readonly day: string
  readonly commitment: string
  readonly purpose: RollPurpose
  readonly placeId: number
  readonly sourceThingId: number | null
  readonly sourceTraitId: number | null
  readonly authorityId: number
  readonly actionId: number | null
  readonly settleId: number | null
  readonly percent: number | null
  readonly sides: number
  readonly roll: number | null
  readonly branch: 'then' | 'else' | null
}

/** The rolls drawn in one run: an action, a timer resolution, or a wake try. */
export interface RollLog {
  readonly rolls: DrawnRoll[]
}

export function newRollLog(): RollLog {
  return { rolls: [] }
}

export function lastRoll(log: RollLog | undefined): number | null {
  const rolls = log?.rolls.filter(roll => roll.roll !== null) ?? []
  return rolls.at(-1)?.roll ?? null
}

export function rollCommitment(secretHex: string): string {
  return createHash('sha256').update(Buffer.from(secretHex, 'hex')).digest('hex')
}

/** roll = (first 4 bytes of HMAC-SHA256(secret, message) as unsigned big-endian) mod sides + 1 */
export function rollValue(
  secretHex: string,
  input: Readonly<{
    rollId: number
    purpose: RollPurpose
    placeId: number
    sourceThingId: number | null
    sourceTraitId: number | null
    sides: number
  }>,
): number {
  const message = `1f3d9-roll|v1|${input.rollId}|${input.purpose}|${input.placeId}|${input.sourceThingId ?? 0}|${input.sourceTraitId ?? 0}`
  const digest = createHmac('sha256', Buffer.from(secretHex, 'hex')).update(message).digest()
  return (digest.readUInt32BE(0) % input.sides) + 1
}

/** The key that orders a room's waiting wake tries; the smallest keys run first. */
export function wakePickKey(
  secretHex: string,
  settleId: number,
  thingId: number,
  unitIndex: number,
): string {
  return createHmac('sha256', Buffer.from(secretHex, 'hex'))
    .update(`1f3d9-wake|v1|${settleId}|${thingId}|${unitIndex}`)
    .digest('hex')
}

/**
 * Make sure today's and tomorrow's day secrets exist, in a short transaction of
 * their own, so tomorrow's fingerprint is public before tomorrow begins.
 */
export async function ensureChanceDays(db: TaggedSql = engineSql): Promise<void> {
  const rows = await db`
    SELECT count(*)::int AS present FROM chance_days
    WHERE day BETWEEN (now() AT TIME ZONE 'UTC')::date AND (now() AT TIME ZONE 'UTC')::date + 1
  ` as Array<{ present?: unknown }>
  if (Number(rows[0]?.present) < 2) {
    const todaySecret = randomBytes(32).toString('hex')
    const tomorrowSecret = randomBytes(32).toString('hex')
    await withEngineTransaction(db, async transaction => {
      await transaction`SELECT pg_advisory_xact_lock(${CHANCE_DAYS_LOCK_CLASS}::int, 0)`
      await transaction`
        INSERT INTO chance_days (day, secret, commitment)
        VALUES
          ((now() AT TIME ZONE 'UTC')::date, decode(${todaySecret}, 'hex'), ${rollCommitment(todaySecret)}),
          ((now() AT TIME ZONE 'UTC')::date + 1, decode(${tomorrowSecret}, 'hex'), ${rollCommitment(tomorrowSecret)})
        ON CONFLICT (day) DO NOTHING
      `
    })
  }
}

/** Today's secret, read inside the run's own transaction. */
export async function currentDaySecret(db: TaggedSql): Promise<Readonly<{
  day: string
  secret: string
  commitment: string
}>> {
  const rows = await db`
    SELECT day::text AS day, encode(secret, 'hex') AS secret, commitment FROM chance_days
    WHERE day = (now() AT TIME ZONE 'UTC')::date
  ` as Array<{ day?: unknown; secret?: unknown; commitment?: unknown }>
  const row = rows[0]
  if (!row || typeof row.secret !== 'string' || typeof row.commitment !== 'string') {
    throw new EngineError(500, ROLL_RECORD_ERROR)
  }
  return Object.freeze({ day: String(row.day), secret: row.secret, commitment: row.commitment })
}

export async function nextRollId(db: TaggedSql): Promise<number> {
  const rows = await db`SELECT nextval('chance_rolls_id_seq')::bigint AS id` as Array<{ id?: unknown }>
  const id = Number(rows[0]?.id)
  if (!Number.isSafeInteger(id) || id <= 0) throw new EngineError(500, ROLL_RECORD_ERROR)
  return id
}

/** Write one roll row and its chance_rolled event; a repeated roll id writes nothing. */
export async function recordRoll(
  roll: DrawnRoll,
  outcome: RollOutcome,
  db: TaggedSql,
): Promise<void> {
  await db`
    WITH recorded AS (
      INSERT INTO chance_rolls (
        id, day, purpose, outcome, place_id, source_thing_id, source_trait_id,
        authority_id, action_id, settle_id, percent, sides, roll, branch
      ) VALUES (
        ${roll.rollId}, ${roll.day}::date, ${roll.purpose}, ${outcome}, ${roll.placeId},
        ${roll.sourceThingId}, ${roll.sourceTraitId}, ${roll.authorityId}, ${roll.actionId},
        ${roll.settleId}, ${roll.percent}, ${roll.sides}, ${roll.roll}, ${roll.branch}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    )
    INSERT INTO events (kind, actor, detail)
    SELECT 'chance_rolled', resident.handle, jsonb_build_object(
      'roll_id', ${roll.rollId}::bigint,
      'purpose', ${roll.purpose}::text,
      'thing_id', ${roll.sourceThingId}::integer,
      'place_id', ${roll.placeId}::integer,
      'action_id', ${roll.actionId}::bigint,
      'settle_id', ${roll.settleId}::bigint,
      'status', ${roll.branch}::text,
      'percent', ${roll.percent}::integer,
      'roll', ${roll.roll}::integer,
      'sides', ${roll.sides}::integer,
      'day', ${roll.day}::text,
      'commitment', ${roll.commitment}::text,
      'outcome', ${outcome}::text
    )
    FROM recorded JOIN residents resident ON resident.id = ${roll.authorityId}
  `
}

/**
 * Draw one public chance roll inside the run's transaction and write it down
 * before its branch runs. The roll also stays in the run's log, so a run that
 * later refuses can still record it as failed.
 */
export async function drawChanceRoll(
  percent: number,
  context: Readonly<{
    placeId: number | null
    sourceThingId: number | null
    sourceTraitId: number | null
    actorId: number
    actionId: number | null
    settleId?: number | null
    rollLog?: RollLog
  }>,
  db: TaggedSql,
): Promise<DrawnRoll> {
  if (context.placeId === null) {
    throw new EngineError(409, 'a chance roll needs the place where it happens; stand in a place and retry')
  }
  const day = await currentDaySecret(db)
  const rollId = await nextRollId(db)
  const input = {
    rollId,
    purpose: 'chance' as const,
    placeId: context.placeId,
    sourceThingId: context.sourceThingId,
    sourceTraitId: context.sourceTraitId,
    sides: CHANCE_SIDES,
  }
  const roll = rollValue(day.secret, input)
  const drawn: DrawnRoll = Object.freeze({
    ...input,
    day: day.day,
    commitment: day.commitment,
    authorityId: context.actorId,
    actionId: context.actionId,
    settleId: context.settleId ?? null,
    percent,
    roll,
    branch: roll <= percent ? 'then' : 'else',
  })
  context.rollLog?.rolls.push(drawn)
  await recordRoll(drawn, 'counted', db)
  return drawn
}

/** After a run refuses, keep every roll it drew public, marked as failed. */
export async function recordFailedRolls(log: RollLog, db: TaggedSql): Promise<void> {
  for (const roll of log.rolls) await recordRoll(roll, 'action_failed', db)
}

export function publicRolls(log: RollLog, outcome: RollOutcome) {
  return log.rolls.map(roll => Object.freeze({
    roll_id: roll.rollId,
    percent: roll.percent,
    roll: roll.roll,
    branch: roll.branch,
    outcome,
  }))
}

export const ROLL_ID_ERROR = 'roll_id must be a positive whole number'

/** Parse a roll_id query value, or null when it is not a positive whole number. */
export function parseRollId(value: string): number | null {
  if (!/^[1-9][0-9]{0,15}$/u.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : null
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value)
}

function isoOrNull(value: unknown): string | null {
  if (value == null) return null
  return new Date(value as string | Date).toISOString()
}

/**
 * One public roll with every input, the day fingerprint, and, once its UTC day
 * has ended, the day secret that lets anyone recompute it. Null when unknown.
 */
export async function readPublicRoll(
  rollId: number,
  db: TaggedSql = engineSql,
): Promise<Readonly<Record<string, unknown>> | null> {
  const rows = await db`
    SELECT roll.id, roll.purpose, roll.outcome, roll.day::text AS day, day.commitment,
      day.created_at < (roll.day::timestamp AT TIME ZONE 'UTC') AS committed_before_day,
      CASE WHEN roll.day < (now() AT TIME ZONE 'UTC')::date
        THEN encode(day.secret, 'hex') END AS secret,
      ((roll.day + 1)::timestamp AT TIME ZONE 'UTC') AS secret_revealed_after,
      roll.place_id, roll.source_thing_id, roll.source_trait_id, roll.authority_id,
      roll.action_id, roll.settle_id, roll.percent, roll.sides, roll.roll, roll.branch,
      roll.created_at, settle.units, settle.picked
    FROM chance_rolls roll
    JOIN chance_days day ON day.day = roll.day
    LEFT JOIN wake_settles settle ON settle.id = roll.settle_id AND roll.purpose = 'wake_pick'
    WHERE roll.id = ${rollId}
  ` as Array<Record<string, unknown>>
  const row = rows[0]
  if (!row) return null
  const secret = typeof row.secret === 'string' ? row.secret : null
  return Object.freeze({
    roll_id: Number(row.id),
    purpose: row.purpose,
    outcome: row.outcome,
    day: row.day,
    commitment: row.commitment,
    committed_before_day: row.committed_before_day === true,
    secret,
    ...(secret === null ? { secret_revealed_after: isoOrNull(row.secret_revealed_after) } : {}),
    place_id: nullableNumber(row.place_id),
    source_thing_id: nullableNumber(row.source_thing_id),
    source_trait_id: nullableNumber(row.source_trait_id),
    action_id: nullableNumber(row.action_id),
    settle_id: nullableNumber(row.settle_id),
    percent: nullableNumber(row.percent),
    sides: nullableNumber(row.sides),
    roll: nullableNumber(row.roll),
    branch: row.branch ?? null,
    created_at: isoOrNull(row.created_at),
    ...(row.purpose === 'wake_pick' ? { units: row.units ?? [], picked: row.picked ?? [] } : {}),
  })
}

/** Today's and tomorrow's public day fingerprints; the secrets stay private. */
export async function readChanceDays(
  db: TaggedSql = engineSql,
): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>> {
  const rows = await db`
    SELECT day::text AS day, commitment, created_at FROM chance_days
    WHERE day BETWEEN (now() AT TIME ZONE 'UTC')::date AND (now() AT TIME ZONE 'UTC')::date + 1
    ORDER BY day
  ` as Array<Record<string, unknown>>
  return rows.map(row => Object.freeze({
    day: row.day,
    commitment: row.commitment,
    created_at: isoOrNull(row.created_at),
  }))
}
