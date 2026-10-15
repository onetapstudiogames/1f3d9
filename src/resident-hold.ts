// The founder's hold on one resident's writes (decisions #149, #150 and #151).
//
// A hold is a moderation_actions row with action 'hold' on target_type 'hold',
// target_id the resident. The newest hold or hold restore for a resident is its
// current hold; it is active while it is a hold whose end is still ahead. No clock
// acts: expiry is read here, on every write that checks it.
//
// Every daily counter and the four building doors read the hold through this one
// module. A resident's daily cap is the lower of the city cap and the hold's
// number, and zero means none. Going home, moving, editing your own places and
// things, building inside your own places, giving, reading, flags, waits and the one
// reply note to each record (decision #152) never read it, so a hold can never stop
// them.
import { engineSql, type TaggedSql } from './engine.ts'
import { QUOTAS } from './quota-limits.ts'
import { LINES_PER_UTC_DAY, type TalkRefusal } from './room-talk-contract.ts'
import { isoTimestamp } from './timestamp.ts'

export type HoldLimitKey = 'notes' | 'lines' | 'things' | 'agreements'

export const CITY_DAILY_CAPS: Readonly<Record<HoldLimitKey, number>> = Object.freeze({
  notes: QUOTAS.notes,
  lines: LINES_PER_UTC_DAY,
  things: QUOTAS.things,
  agreements: QUOTAS.agreements,
})

export const HOLD_MAX_DAYS = 90
export const HOLD_RULE_WORDS = Object.freeze(['disruptive', 'harmful', 'detrimental'] as const)
export const HOLD_AT_ONCE_CASES = Object.freeze(['illegal', 'doxxing', 'fraud', 'flooding'] as const)

/** What every hold leaves open, in the words me and each refusal use. */
export const HOLD_STILL_WORKS =
  'Going home, moving, editing your own places and things, building inside your own places, giving, reading, waits and one reply note to each record about you still work.'

export type ResidentHold = Readonly<{
  id: number
  reason: string
  rule_word: string | null
  at_once_for: string | null
  set_at: string
  ends_at: string
  daily_limits: Readonly<Record<HoldLimitKey, number | null>>
  stops_pings: boolean
  stops_building: boolean
}>

export type DailyLimit = Readonly<{
  limit: number
  /** The hold that lowers this limit below the city cap, or null when the city cap applies. */
  hold: ResidentHold | null
}>

type HoldRow = Readonly<{
  id: number | string
  reason: string
  rule_word: string | null
  at_once_for: string | null
  created_at: Date | string
  ends_at: Date | string | null
  hold_notes: number | string | null
  hold_lines: number | string | null
  hold_things: number | string | null
  hold_agreements: number | string | null
  hold_stops_pings: boolean | null
  hold_stops_building: boolean | null
  active: boolean
}>

const HOLD_NOUNS: Readonly<Record<HoldLimitKey, string>> = Object.freeze({
  notes: 'notes',
  lines: 'lines',
  things: 'new things',
  agreements: 'agreement actions',
})

function holdNumber(value: number | string | null): number | null {
  if (value === null) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

function holdFromRow(row: HoldRow): ResidentHold | null {
  if (row.active !== true) return null
  const setAt = isoTimestamp(row.created_at)
  const endsAt = isoTimestamp(row.ends_at)
  if (setAt === null || endsAt === null) return null
  return Object.freeze({
    id: Number(row.id),
    reason: row.reason,
    rule_word: row.rule_word,
    at_once_for: row.at_once_for,
    set_at: setAt,
    ends_at: endsAt,
    daily_limits: Object.freeze({
      notes: holdNumber(row.hold_notes),
      lines: holdNumber(row.hold_lines),
      things: holdNumber(row.hold_things),
      agreements: holdNumber(row.hold_agreements),
    }),
    stops_pings: row.hold_stops_pings === true,
    stops_building: row.hold_stops_building === true,
  })
}

/** The resident's active hold, or null. The newest hold or hold restore decides. */
export async function activeHold(
  residentId: number,
  database: TaggedSql = engineSql,
): Promise<ResidentHold | null> {
  const rows = await database`
    /* resident-hold:current */
    SELECT hold.id::text AS id, hold.reason, hold.rule_word, hold.at_once_for,
      hold.created_at, hold.ends_at, hold.hold_notes, hold.hold_lines, hold.hold_things,
      hold.hold_agreements, hold.hold_stops_pings, hold.hold_stops_building,
      (hold.action = 'hold' AND hold.ends_at > clock_timestamp()) AS active
    FROM moderation_actions hold
    WHERE hold.target_type = 'hold' AND hold.target_id = ${residentId}
    ORDER BY hold.created_at DESC, hold.id DESC
    LIMIT 1
  ` as HoldRow[]
  const row = rows[0]
  return row ? holdFromRow(row) : null
}

/** The lower of the city cap and the hold's number for each daily count. */
export function effectiveDailyLimits(
  hold: ResidentHold | null,
): Readonly<Record<HoldLimitKey, number>> {
  const limit = (key: HoldLimitKey): number => {
    const held = hold?.daily_limits[key] ?? null
    return held === null ? CITY_DAILY_CAPS[key] : Math.min(CITY_DAILY_CAPS[key], held)
  }
  return Object.freeze({
    notes: limit('notes'),
    lines: limit('lines'),
    things: limit('things'),
    agreements: limit('agreements'),
  })
}

export function dailyLimitUnder(hold: ResidentHold | null, key: HoldLimitKey): DailyLimit {
  const limit = effectiveDailyLimits(hold)[key]
  return Object.freeze({ limit, hold: hold !== null && limit < CITY_DAILY_CAPS[key] ? hold : null })
}

/** One daily count's limit for this resident right now. */
export async function dailyLimit(
  residentId: number,
  key: HoldLimitKey,
  database: TaggedSql = engineSql,
): Promise<DailyLimit> {
  return dailyLimitUnder(await activeHold(residentId, database), key)
}

/** The resident's active hold when it stops pings or building, else null. */
export async function holdStopping(
  residentId: number,
  stop: 'pings' | 'building',
  database: TaggedSql = engineSql,
): Promise<ResidentHold | null> {
  const hold = await activeHold(residentId, database)
  if (hold === null) return null
  return (stop === 'pings' ? hold.stops_pings : hold.stops_building) ? hold : null
}

/**
 * The active building hold that stops this new place, or null. A place inside one
 * of the resident's own places is its own land and always allowed; the frontier,
 * the world root, and a place inside anyone else's place are not.
 */
export async function holdStoppingPlace(
  residentId: number,
  parentId: number | null,
  database: TaggedSql = engineSql,
): Promise<ResidentHold | null> {
  const hold = await holdStopping(residentId, 'building', database)
  if (hold === null || parentId === null) return hold
  const rows = await database`
    /* resident-hold:own-parent */
    SELECT coalesce(owner_id = ${residentId}, false) AS own FROM places WHERE id = ${parentId}
  ` as Array<{ own: boolean }>
  // A parent that does not exist is refused by the place door's own not-found answer.
  return rows.length === 0 || rows[0]!.own === true ? null : hold
}

export function holdLimitRefusal(hold: ResidentHold, key: HoldLimitKey): string {
  const limit = effectiveDailyLimits(hold)[key]
  return `Founder hold #${hold.id} limits your ${HOLD_NOUNS[key]} to ${limit} a day until ${hold.ends_at}, and you have reached that limit today. Read its public reason in me (hold) or with browse view=moderation. ${HOLD_STILL_WORKS}`
}

export function holdPingRefusal(hold: ResidentHold): string {
  return `Founder hold #${hold.id} stops new pings until ${hold.ends_at}. Answering a ping still works. Read its public reason in me (hold) or with browse view=moderation. ${HOLD_STILL_WORKS}`
}

export function holdBuildingRefusal(hold: ResidentHold): string {
  return `Founder hold #${hold.id} stops new places outside your own land, new traits, and new or revised kinds until ${hold.ends_at}. Nothing was spent. Read its public reason in me (hold) or with browse view=moderation. ${HOLD_STILL_WORKS}`
}

/** The line refusal in the talk contract's shape, past a hold's day limit. */
export function holdLineTalkRefusal(hold: ResidentHold): TalkRefusal {
  return Object.freeze({ status: 429, error: holdLimitRefusal(hold, 'lines') })
}

/** The ping invite refusal in the talk contract's shape, while a hold stops pings. */
export function holdPingTalkRefusal(hold: ResidentHold): TalkRefusal {
  return Object.freeze({ status: 403, error: holdPingRefusal(hold) })
}

/** The hold as me shows it to its own resident. */
export function publicHold(hold: ResidentHold): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: hold.id,
    reason: hold.reason,
    rule_word: hold.rule_word,
    at_once_for: hold.at_once_for,
    set_at: hold.set_at,
    ends_at: hold.ends_at,
    daily_limits: Object.freeze({ ...effectiveDailyLimits(hold) }),
    stops_pings: hold.stops_pings,
    stops_building: hold.stops_building,
    still_works: HOLD_STILL_WORKS,
  })
}
