// The founder's moderate request: a remove, a restore, or a hold (decisions #145
// and #151). Every new removal and hold names the word that applied or the at-once
// case, and may name the smaller step tried. A hold also carries its end date, its
// daily numbers and its two stops; a restore on target_type hold ends one early.
import { publicText } from './input.ts'
import {
  MODERATION_ACTIONS,
  MODERATION_TARGET_TYPES,
  moderationReason,
  type ModerationAction,
  type ModerationTargetType,
} from './moderation.ts'
import {
  CITY_DAILY_CAPS,
  HOLD_AT_ONCE_CASES,
  HOLD_MAX_DAYS,
  HOLD_RULE_WORDS,
  type HoldLimitKey,
} from './resident-hold.ts'

export const MODERATION_REQUEST_TARGET_TYPES = Object.freeze([...MODERATION_TARGET_TYPES, 'hold'] as const)
export const MODERATION_SMALLER_STEP_MAX_BYTES = 500

export type ModerationRequestTargetType = ModerationTargetType | 'hold'
export type HoldRuleWord = typeof HOLD_RULE_WORDS[number]
export type HoldAtOnceCase = typeof HOLD_AT_ONCE_CASES[number]

export type HoldTerms = Readonly<{
  ends_at: string
  hold_notes: number | null
  hold_lines: number | null
  hold_things: number | null
  hold_agreements: number | null
  hold_stops_pings: boolean
  hold_stops_building: boolean
}>

export type ModerationRequest = Readonly<{
  action: ModerationAction
  target_type: ModerationRequestTargetType
  target_id: number
  reason: string
  rule_word: HoldRuleWord | null
  at_once_for: HoldAtOnceCase | null
  smaller_step: string | null
  smaller_step_record_id: number | null
  hold: HoldTerms | null
}>

export type ModerationRequestFailure = Readonly<{ ok: false; status: 400; error: string }>
export type ModerationRequestResult =
  | Readonly<{ ok: true; request: ModerationRequest }>
  | ModerationRequestFailure

const REQUIRED_FIELDS = Object.freeze(['action', 'target_type', 'target_id', 'reason'] as const)
const RECORD_FIELDS = Object.freeze([
  'rule_word', 'at_once_for', 'smaller_step', 'smaller_step_record_id',
] as const)
const HOLD_NUMBER_FIELDS = Object.freeze({
  hold_notes: 'notes',
  hold_lines: 'lines',
  hold_things: 'things',
  hold_agreements: 'agreements',
} as const satisfies Readonly<Record<string, HoldLimitKey>>)
const HOLD_FIELDS = Object.freeze([
  'ends_at', ...Object.keys(HOLD_NUMBER_FIELDS), 'hold_stops_pings', 'hold_stops_building',
])
const ALLOWED_FIELDS: ReadonlySet<string> = new Set([...REQUIRED_FIELDS, ...RECORD_FIELDS, ...HOLD_FIELDS])

export const MODERATION_FOUNDER_ONLY_REFUSAL =
  "only founder resident #1 may remove or restore public content or hold a resident's writes"
export const MODERATION_REQUEST_FIELDS_REFUSAL =
  'moderate takes action, target_type, target_id and reason, and may add rule_word, at_once_for, smaller_step and smaller_step_record_id, and for a hold ends_at, hold_notes, hold_lines, hold_things, hold_agreements, hold_stops_pings and hold_stops_building; send only those fields'
export const MODERATION_REQUEST_BASE_REFUSAL =
  'need action (remove, restore or hold), target_type, a positive whole target_id and a safe reason of 1 to 4000 bytes'
export const MODERATION_HOLD_TARGET_REFUSAL =
  "a hold uses target_type hold with target_id the resident's id, and target_type hold takes only a hold or a restore that ends one early"
export const MODERATION_HOLD_FIELDS_REFUSAL =
  'ends_at and the hold_ fields belong to action hold only'
export const MODERATION_RESTORE_FIELDS_REFUSAL =
  'a restore takes only action, target_type, target_id and reason'
export const MODERATION_RECORD_WORD_REFUSAL =
  'a remove names exactly one of rule_word (disruptive, harmful or detrimental) or at_once_for (illegal, doxxing, fraud or flooding), and a hold names rule_word'
export const MODERATION_SMALLER_STEP_REFUSAL =
  'smaller_step must be safe text of 1 to 500 bytes, and smaller_step_record_id a positive whole number naming an earlier moderation record'
export const MODERATION_HOLD_END_REFUSAL =
  `ends_at must be a time after now and at most ${HOLD_MAX_DAYS} days away, written like 2026-11-01T00:00:00Z`
export const MODERATION_HOLD_STOPS_REFUSAL =
  'hold_stops_pings and hold_stops_building must be true or false when present'
export const MODERATION_HOLD_EMPTY_REFUSAL =
  `a hold must lower at least one daily number below the city cap (notes ${CITY_DAILY_CAPS.notes}, lines ${CITY_DAILY_CAPS.lines}, things ${CITY_DAILY_CAPS.things}, agreement actions ${CITY_DAILY_CAPS.agreements}) or stop pings or building`

const HOLD_MAX_MILLISECONDS = HOLD_MAX_DAYS * 24 * 60 * 60 * 1_000
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u

type UnknownRecord = Record<string, unknown>

function plainRecord(value: unknown): UnknownRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    if (!keys.every(key => typeof key === 'string' && ALLOWED_FIELDS.has(key))) return null
    if (!REQUIRED_FIELDS.every(field => Object.hasOwn(value, field))) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, 'value'))) return null
    return value as UnknownRecord
  } catch {
    return null
  }
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? value as T : null
}

const positiveWhole = (value: unknown): number | null => (
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
)

function failure(status: 400, error: string): ModerationRequestFailure {
  return Object.freeze({ ok: false, status, error })
}

function holdTerms(record: UnknownRecord, now: Date): HoldTerms | ModerationRequestFailure {
  const endsAtText = record.ends_at
  const endsAt = typeof endsAtText === 'string' && ISO_TIME.test(endsAtText)
    ? new Date(endsAtText)
    : null
  if (endsAt === null || Number.isNaN(endsAt.getTime())) return failure(400, MODERATION_HOLD_END_REFUSAL)
  const ahead = endsAt.getTime() - now.getTime()
  if (ahead <= 0 || ahead > HOLD_MAX_MILLISECONDS) return failure(400, MODERATION_HOLD_END_REFUSAL)

  const numberFields = Object.entries(HOLD_NUMBER_FIELDS) as Array<[keyof typeof HOLD_NUMBER_FIELDS, HoldLimitKey]>
  const outOfRange = numberFields.find(([field, key]) => {
    const value = record[field]
    return value !== undefined && value !== null && !(
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= CITY_DAILY_CAPS[key]
    )
  })
  if (outOfRange) {
    return failure(400, `${outOfRange[0]} must be a whole number from 0 to ${CITY_DAILY_CAPS[outOfRange[1]]}`)
  }
  const held = (field: keyof typeof HOLD_NUMBER_FIELDS): number | null => (
    typeof record[field] === 'number' ? record[field] as number : null
  )
  const stops = [record.hold_stops_pings, record.hold_stops_building]
  if (stops.some(value => value !== undefined && typeof value !== 'boolean')) {
    return failure(400, MODERATION_HOLD_STOPS_REFUSAL)
  }
  const terms: HoldTerms = Object.freeze({
    ends_at: endsAt.toISOString(),
    hold_notes: held('hold_notes'),
    hold_lines: held('hold_lines'),
    hold_things: held('hold_things'),
    hold_agreements: held('hold_agreements'),
    hold_stops_pings: record.hold_stops_pings === true,
    hold_stops_building: record.hold_stops_building === true,
  })
  const lowers = numberFields.some(([field, key]) => terms[field] !== null && terms[field] < CITY_DAILY_CAPS[key])
  if (!lowers && !terms.hold_stops_pings && !terms.hold_stops_building) return failure(400, MODERATION_HOLD_EMPTY_REFUSAL)
  return terms
}

/** Validate one founder moderate request, refusing in the caller's words. */
export function parseModerationRequest(value: unknown, now: Date = new Date()): ModerationRequestResult {
  const record = plainRecord(value)
  if (!record) return failure(400, MODERATION_REQUEST_FIELDS_REFUSAL)
  const action = oneOf(MODERATION_ACTIONS, record.action)
  const targetType = oneOf(MODERATION_REQUEST_TARGET_TYPES, record.target_type)
  const targetId = positiveWhole(record.target_id)
  const reason = moderationReason(record.reason)
  if (!action || !targetType || targetId === null || reason === null) {
    return failure(400, MODERATION_REQUEST_BASE_REFUSAL)
  }
  if ((action === 'hold') !== (targetType === 'hold') && !(action === 'restore' && targetType === 'hold')) {
    return failure(400, MODERATION_HOLD_TARGET_REFUSAL)
  }
  const sentHoldFields = HOLD_FIELDS.some(field => Object.hasOwn(record, field))
  if (action !== 'hold' && sentHoldFields) return failure(400, MODERATION_HOLD_FIELDS_REFUSAL)
  const sentRecordFields = RECORD_FIELDS.some(field => Object.hasOwn(record, field))
  if (action === 'restore') {
    if (sentRecordFields) return failure(400, MODERATION_RESTORE_FIELDS_REFUSAL)
    return Object.freeze({
      ok: true,
      request: Object.freeze({
        action, target_type: targetType, target_id: targetId, reason,
        rule_word: null, at_once_for: null, smaller_step: null, smaller_step_record_id: null, hold: null,
      }),
    })
  }

  const ruleWord = record.rule_word === undefined ? null : oneOf(HOLD_RULE_WORDS, record.rule_word)
  const atOnceFor = record.at_once_for === undefined ? null : oneOf(HOLD_AT_ONCE_CASES, record.at_once_for)
  if ((record.rule_word !== undefined && ruleWord === null)
    || (record.at_once_for !== undefined && atOnceFor === null)
    || (ruleWord === null) === (atOnceFor === null)
    || (action === 'hold' && ruleWord === null)) {
    return failure(400, MODERATION_RECORD_WORD_REFUSAL)
  }
  const smallerStep = record.smaller_step === undefined
    ? null
    : publicText(record.smaller_step, { maximumBytes: MODERATION_SMALLER_STEP_MAX_BYTES })
  const smallerStepRecordId = record.smaller_step_record_id === undefined
    ? null
    : positiveWhole(record.smaller_step_record_id)
  if ((record.smaller_step !== undefined && smallerStep === null)
    || (record.smaller_step_record_id !== undefined && smallerStepRecordId === null)) {
    return failure(400, MODERATION_SMALLER_STEP_REFUSAL)
  }
  const hold = action === 'hold' ? holdTerms(record, now) : null
  if (hold !== null && 'ok' in hold) return hold
  return Object.freeze({
    ok: true,
    request: Object.freeze({
      action,
      target_type: targetType,
      target_id: targetId,
      reason,
      rule_word: ruleWord,
      at_once_for: atOnceFor,
      smaller_step: smallerStep,
      smaller_step_record_id: smallerStepRecordId,
      hold,
    }),
  })
}
