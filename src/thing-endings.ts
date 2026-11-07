import { EngineError } from './engine.ts'
import {
  ENDING_MAX_CONDITIONS,
  ENDING_MAX_SECONDS,
  ENDING_MAX_USES,
  ENDING_MIN_SECONDS,
  ENDING_MIN_USES,
  ENDING_POLICY_MAX_LABELS,
  ENDING_POLICY_MIN_LABELS,
} from './engine-limits.ts'
import { worldName } from './input.ts'
import {
  ENDING_NOT_ALLOWED_REFUSAL,
  ENDING_POLICY_REFUSAL,
  ENDING_SHAPE_REFUSAL,
  KINDLESS_ENDING_REFUSAL,
} from './thing-ending-refusals.ts'

// The pure rules of a thing's end: parsing the owner's rule and a kind's policy, the
// grant, the copy rule, when an end falls due, the end try's gates, and the public status
// objects. Every door calls these, so no rule is written twice. The database writes the
// same due rule once in thing_end_due_from and the same gates in thing_end_try_blocked_by;
// snapshot format 4 builds the same full object in SQL, field for field.

/** The version of the city limits a grant was taken under. */
export const THING_ENDING_LIMITS_VERSION = 1

/** The five ways an end can come, in the one canonical order every list uses. */
export const ENDING_MODES = Object.freeze([
  'at',
  'after_setting_seconds',
  'uses',
  'idle_seconds',
  'label_added',
] as const)
export type EndingMode = typeof ENDING_MODES[number]

export type EndingCondition =
  | Readonly<{ at: string }>
  | Readonly<{ after_setting_seconds: number; until?: string }>
  | Readonly<{ uses: number }>
  | Readonly<{ idle_seconds: number; until?: string }>
  | Readonly<{ label_added: string }>

export interface EndingRule {
  readonly any: readonly EndingCondition[]
}

export interface EndingPolicy {
  readonly allowed: readonly EndingMode[]
  readonly labels?: readonly string[]
  readonly max_seconds?: number
  readonly max_uses?: number
}

export const DEFAULT_ENDING_POLICY: EndingPolicy = Object.freeze({ allowed: Object.freeze([]) })

export interface EndingLimits {
  readonly max_seconds: number
  readonly max_uses: number
  /** The labels a label_added end may watch; null means any world name. */
  readonly labels: readonly string[] | null
}

export interface KindEndingGrant {
  readonly kind_id: number
  readonly revision: number
  readonly allowed: readonly EndingMode[]
  readonly limits: EndingLimits
  readonly city_limits_version: number
}

export interface KindlessEndingGrant {
  readonly kindless: true
  readonly allowed: readonly EndingMode[]
  readonly limits: EndingLimits
  readonly city_limits_version: number
}

export type EndingGrant = KindEndingGrant | KindlessEndingGrant

export type EndingTime = Date | string
export type EndProgramState = 'none' | 'pending' | 'ran' | 'skipped'
export type EndingStatusName =
  | 'not_permitted_by_kind'
  | 'permitted_but_unset'
  | 'active'
  | 'due_waiting_settle'
  | 'ended'

export interface ResidentRef {
  readonly id: number
  readonly handle: string
}

const MODE_SET: ReadonlySet<string> = new Set(ENDING_MODES)
const CITY_LIMITS: EndingLimits = Object.freeze({
  max_seconds: ENDING_MAX_SECONDS,
  max_uses: ENDING_MAX_USES,
  labels: null,
})

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false
  }
  return true
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : null
}

function canonicalModes(modes: Iterable<string>): EndingMode[] {
  const chosen = new Set(modes)
  return ENDING_MODES.filter(mode => chosen.has(mode))
}

function toDate(value: EndingTime | null | undefined): Date | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function toIso(value: EndingTime | null | undefined): string | null {
  return toDate(value)?.toISOString() ?? null
}

function plusSeconds(value: EndingTime | null | undefined, seconds: number | null | undefined): Date | null {
  const date = toDate(value)
  if (!date || typeof seconds !== 'number' || !Number.isFinite(seconds)) return null
  return new Date(date.getTime() + seconds * 1000)
}

function soonest(times: readonly (Date | null)[]): Date | null {
  let least: Date | null = null
  for (const time of times) {
    if (time && (!least || time.getTime() < least.getTime())) least = time
  }
  return least
}

/** The mode a condition names: the first canonical mode it has as a key. */
export function conditionMode(condition: unknown): EndingMode | null {
  if (!isRecord(condition)) return null
  return ENDING_MODES.find(mode => Object.hasOwn(condition, mode)) ?? null
}

// ---------------------------------------------------------------------------
// The owner's rule
// ---------------------------------------------------------------------------

const UTC_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|\+00:00)$/u

/** A UTC time, exactly as written: a real date and time, Z or +00:00, at most milliseconds. */
function utcTime(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const match = UTC_TIME.exec(value)
  if (!match) return null
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0] = match.slice(1, 6).map(Number)
  const second = Number(match[6] ?? 0)
  const millisecond = Number((match[7] ?? '0').padEnd(3, '0'))
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second
    ? date
    : null
}

function parseCondition(value: unknown, now: Date): EndingCondition | null {
  if (!isRecord(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 1) return null
  const mode = keys[0] ?? ''
  const raw = value[mode]
  switch (mode) {
    case 'at': {
      const date = utcTime(raw)
      const ahead = date ? (date.getTime() - now.getTime()) / 1000 : 0
      return date && ahead > 0 && ahead <= ENDING_MAX_SECONDS ? { at: date.toISOString() } : null
    }
    case 'after_setting_seconds': {
      const seconds = boundedInteger(raw, ENDING_MIN_SECONDS, ENDING_MAX_SECONDS)
      return seconds === null ? null : { after_setting_seconds: seconds }
    }
    case 'idle_seconds': {
      const seconds = boundedInteger(raw, ENDING_MIN_SECONDS, ENDING_MAX_SECONDS)
      return seconds === null ? null : { idle_seconds: seconds }
    }
    case 'uses': {
      const uses = boundedInteger(raw, ENDING_MIN_USES, ENDING_MAX_USES)
      return uses === null ? null : { uses }
    }
    case 'label_added': {
      const label = worldName(raw)
      return label === null ? null : { label_added: label }
    }
    default:
      return null
  }
}

function sortConditions(conditions: readonly EndingCondition[]): EndingCondition[] {
  return [...conditions].sort((left, right) => (
    ENDING_MODES.indexOf(conditionMode(left) as EndingMode) - ENDING_MODES.indexOf(conditionMode(right) as EndingMode)
  ))
}

/**
 * Read the ending an owner sent to make, crafted make, thing_edit or thing_upgrade:
 * {"any": [...]}, 1 to 4 conditions of different modes, inside the city limits as of now.
 * null clears and returns null; an omitted field is the caller's to treat as no change.
 * The answer is canonical: conditions in mode order, dates as ISO UTC, labels lowered.
 * Anything else refuses with E3.
 */
export function parseEndingInput(value: unknown, now: Date): EndingRule | null {
  if (value === null) return null
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isDenseArray(value.any)) {
    throw new EngineError(400, ENDING_SHAPE_REFUSAL)
  }
  const list = value.any
  if (list.length < 1 || list.length > ENDING_MAX_CONDITIONS) throw new EngineError(400, ENDING_SHAPE_REFUSAL)
  const conditions = list.map(item => parseCondition(item, now))
  if (conditions.some(condition => condition === null)) throw new EngineError(400, ENDING_SHAPE_REFUSAL)
  const parsed = conditions as EndingCondition[]
  if (new Set(parsed.map(conditionMode)).size !== parsed.length) throw new EngineError(400, ENDING_SHAPE_REFUSAL)
  return Object.freeze({ any: Object.freeze(sortConditions(parsed).map(condition => Object.freeze(condition))) })
}

/**
 * Read a stored ending_rule without judging it, keeping a copy's until: the object
 * conditions in their stored order, or null when there is no rule. Never throws.
 */
export function parseStoredEndingRule(value: unknown): EndingRule | null {
  if (!isRecord(value) || !Array.isArray(value.any)) return null
  return { any: value.any.filter(isRecord) as unknown as EndingCondition[] }
}

// ---------------------------------------------------------------------------
// A kind's ending_policy
// ---------------------------------------------------------------------------

/**
 * Read the ending_policy sent to invent_kind or revise_kind, the shapes
 * valid_ending_policy accepts: allowed modes each once, 1 to 8 labels exactly when
 * label_added is allowed, and optional max_seconds and max_uses inside the city limits,
 * so they can only narrow. Modes come back in canonical order and labels lowered.
 * Anything else refuses with E1. An omitted field is the caller's to keep.
 */
export function parseEndingPolicy(value: unknown): EndingPolicy {
  const refuse = (): never => { throw new EngineError(400, ENDING_POLICY_REFUSAL) }
  if (!isRecord(value)) return refuse()
  if (Object.keys(value).some(key => !['allowed', 'labels', 'max_seconds', 'max_uses'].includes(key))) refuse()
  const allowed = value.allowed
  if (!isDenseArray(allowed) || allowed.some(mode => typeof mode !== 'string' || !MODE_SET.has(mode))) refuse()
  const modes = allowed as string[]
  if (new Set(modes).size !== modes.length) refuse()
  const wantsLabels = modes.includes('label_added')
  if (wantsLabels !== Object.hasOwn(value, 'labels')) refuse()
  const policy: { allowed: readonly EndingMode[]; labels?: readonly string[]; max_seconds?: number; max_uses?: number } = {
    allowed: Object.freeze(canonicalModes(modes)),
  }
  if (wantsLabels) {
    const raw = value.labels
    if (!isDenseArray(raw) || raw.length < ENDING_POLICY_MIN_LABELS || raw.length > ENDING_POLICY_MAX_LABELS) refuse()
    const labels = (raw as unknown[]).map(worldName)
    if (labels.some(label => label === null) || new Set(labels).size !== labels.length) refuse()
    policy.labels = Object.freeze(labels as string[])
  }
  if (Object.hasOwn(value, 'max_seconds')) {
    const seconds = boundedInteger(value.max_seconds, ENDING_MIN_SECONDS, ENDING_MAX_SECONDS)
    if (seconds === null) refuse()
    policy.max_seconds = seconds as number
  }
  if (Object.hasOwn(value, 'max_uses')) {
    const uses = boundedInteger(value.max_uses, ENDING_MIN_USES, ENDING_MAX_USES)
    if (uses === null) refuse()
    policy.max_uses = uses as number
  }
  return Object.freeze(policy)
}

/**
 * Read a stored kind_revisions.ending_policy for reads and grants: the known modes in
 * canonical order, its labels and limits; anything unreadable is the default, which
 * allows no ending. Never throws.
 */
export function storedEndingPolicy(value: unknown): EndingPolicy {
  if (!isRecord(value) || !Array.isArray(value.allowed)) return DEFAULT_ENDING_POLICY
  const policy: { allowed: readonly EndingMode[]; labels?: readonly string[]; max_seconds?: number; max_uses?: number } = {
    allowed: canonicalModes(value.allowed.filter((mode): mode is string => typeof mode === 'string')),
  }
  if (Array.isArray(value.labels)) policy.labels = value.labels.filter((label): label is string => typeof label === 'string')
  if (typeof value.max_seconds === 'number') policy.max_seconds = value.max_seconds
  if (typeof value.max_uses === 'number') policy.max_uses = value.max_uses
  return policy
}

/** The stored default, {"allowed": []}, which a kind fee request leaves out of its hash. */
export function isDefaultEndingPolicy(policy: EndingPolicy): boolean {
  return policy.allowed.length === 0
    && policy.labels === undefined
    && policy.max_seconds === undefined
    && policy.max_uses === undefined
}

function policyLimits(policy: EndingPolicy): EndingLimits {
  return {
    max_seconds: policy.max_seconds ?? ENDING_MAX_SECONDS,
    max_uses: policy.max_uses ?? ENDING_MAX_USES,
    labels: policy.labels ? [...policy.labels] : null,
  }
}

/** The modes max_seconds limits; max_uses limits uses. */
const TIMED_MODES: ReadonlySet<string> = new Set(['at', 'after_setting_seconds', 'idle_seconds'])

/**
 * Whether a new revision's policy lets owners do more than the old one: a mode added, a
 * label added, or a higher max_seconds or max_uses (an omitted limit is the city's) on a
 * mode the new policy still allows.
 * Only the kind's inventor, while owning it, may widen (E19).
 */
export function policyWidens(old: EndingPolicy, next: EndingPolicy): boolean {
  if (next.allowed.some(mode => !old.allowed.includes(mode))) return true
  const oldLabels = new Set(old.labels ?? [])
  if ((next.labels ?? []).some(label => !oldLabels.has(label))) return true
  const oldLimits = policyLimits(old)
  const nextLimits = policyLimits(next)
  const timed = next.allowed.some(mode => TIMED_MODES.has(mode))
  return (timed && nextLimits.max_seconds > oldLimits.max_seconds)
    || (next.allowed.includes('uses') && nextLimits.max_uses > oldLimits.max_uses)
}

/** The other side of policyWidens: the new policy keeps or narrows every permission. */
export function policyNarrowsOrKeeps(old: EndingPolicy, next: EndingPolicy): boolean {
  return !policyWidens(old, next)
}

// ---------------------------------------------------------------------------
// Permission and the grant
// ---------------------------------------------------------------------------

export interface EndingPermissionThing {
  readonly kind_id: number | null
  readonly current_revision: number | null
  readonly as_kind_id?: number | null
  readonly as_revision?: number | null
  readonly owner_id: number
  readonly maker_id: number
}

/**
 * The thing's effective kind and revision, coalesce(as_kind_id, kind_id) and
 * coalesce(as_revision, current_revision); null for a thing with no kind.
 */
export function effectiveKind(thing: EndingPermissionThing): Readonly<{ kind_id: number; revision: number | null }> | null {
  const kindId = thing.as_kind_id ?? thing.kind_id
  return kindId != null ? { kind_id: kindId, revision: thing.as_revision ?? thing.current_revision } : null
}

export type EndingPermission =
  | Readonly<{ source: 'kind'; kind_id: number; revision: number; policy: EndingPolicy }>
  | Readonly<{ source: 'kindless_owner' }>
  | Readonly<{ source: null; refusal: string }>

/**
 * Who lets this thing have an end now: the ending_policy of its effective kind revision
 * (passed in as stored), or, for a thing with no kind, its maker while owning it.
 * The refusal says why not: E2 for a kind that allows none, E14 for a kindless thing.
 */
export function endingPermission(thing: EndingPermissionThing, policy: unknown): EndingPermission {
  const kind = effectiveKind(thing)
  if (!kind) {
    return thing.owner_id === thing.maker_id
      ? { source: 'kindless_owner' }
      : { source: null, refusal: KINDLESS_ENDING_REFUSAL }
  }
  const stored = storedEndingPolicy(policy)
  return stored.allowed.length > 0 && kind.revision != null
    ? { source: 'kind', kind_id: kind.kind_id, revision: kind.revision, policy: stored }
    : { source: null, refusal: ENDING_NOT_ALLOWED_REFUSAL }
}

/** The modes a permission lets an owner choose now, in canonical order. */
export function permittedModes(permission: EndingPermission): readonly EndingMode[] {
  if (permission.source === 'kindless_owner') return ENDING_MODES
  if (permission.source === 'kind') return canonicalModes(permission.policy.allowed)
  return []
}

/**
 * The immutable grant a setting stores: the kind and revision (or kindless), the allowed
 * modes, the effective limits and the city limit version. null when nothing permits an end.
 */
export function buildGrant(permission: EndingPermission): EndingGrant | null {
  if (permission.source === 'kindless_owner') {
    return {
      kindless: true,
      allowed: ENDING_MODES,
      limits: CITY_LIMITS,
      city_limits_version: THING_ENDING_LIMITS_VERSION,
    }
  }
  if (permission.source === 'kind') {
    return {
      kind_id: permission.kind_id,
      revision: permission.revision,
      allowed: canonicalModes(permission.policy.allowed),
      limits: policyLimits(permission.policy),
      city_limits_version: THING_ENDING_LIMITS_VERSION,
    }
  }
  return null
}

function grantLimits(grant: unknown): Readonly<{ allowed: readonly string[]; limits: EndingLimits }> | null {
  if (!isRecord(grant) || !Array.isArray(grant.allowed) || !isRecord(grant.limits)) return null
  const limits = grant.limits
  if (typeof limits.max_seconds !== 'number' || typeof limits.max_uses !== 'number') return null
  if (limits.labels !== null && !Array.isArray(limits.labels)) return null
  return {
    allowed: grant.allowed.filter((mode): mode is string => typeof mode === 'string'),
    limits: {
      max_seconds: limits.max_seconds,
      max_uses: limits.max_uses,
      labels: limits.labels === null ? null : (limits.labels as unknown[]).filter((label): label is string => typeof label === 'string'),
    },
  }
}

/**
 * Whether a parsed rule fits a grant as of now: E2 when a mode is not allowed, E3 when
 * a date, a time, a count or a label is outside the grant's limits, else null. A grant
 * that cannot be read fits nothing.
 */
export function endingFitRefusal(rule: EndingRule, grant: EndingGrant | unknown, now: Date): string | null {
  const read = grantLimits(grant)
  if (!read) return ENDING_NOT_ALLOWED_REFUSAL
  for (const condition of rule.any) {
    const mode = conditionMode(condition)
    if (!mode || !read.allowed.includes(mode)) return ENDING_NOT_ALLOWED_REFUSAL
  }
  const { limits } = read
  for (const condition of rule.any) {
    const fits = 'at' in condition
      ? (toDate(condition.at)?.getTime() ?? Infinity) - now.getTime() <= limits.max_seconds * 1000
      : 'after_setting_seconds' in condition
        ? condition.after_setting_seconds <= limits.max_seconds
        : 'idle_seconds' in condition
          ? condition.idle_seconds <= limits.max_seconds
          : 'uses' in condition
            ? condition.uses <= limits.max_uses
            : limits.labels === null || limits.labels.includes(condition.label_added)
    if (!fits) return ENDING_SHAPE_REFUSAL
  }
  return null
}

/** Whether a renewal fits the stored grant, even after an upgrade or conversion. */
export function renewalFitsGrant(rule: EndingRule, grant: EndingGrant | unknown, now: Date): boolean {
  return endingFitRefusal(rule, grant, now) === null
}

/** The error for a fit or permission refusal: E3 is 400, E14 and E2 are 403. */
function refusalError(refusal: string): EngineError {
  if (refusal === ENDING_SHAPE_REFUSAL) return new EngineError(400, ENDING_SHAPE_REFUSAL)
  if (refusal === KINDLESS_ENDING_REFUSAL) return new EngineError(403, KINDLESS_ENDING_REFUSAL)
  return new EngineError(403, ENDING_NOT_ALLOWED_REFUSAL)
}

/** Refuse a renewal that does not fit the stored grant: E2 (403) or E3 (400). */
export function assertRenewalFits(rule: EndingRule, grant: EndingGrant | unknown, now: Date): void {
  const refusal = endingFitRefusal(rule, grant, now)
  if (refusal) throw refusalError(refusal)
}

/**
 * The grant for a new end on a thing with none: taken from its effective kind revision's
 * policy, or the kindless maker rule, and the rule must fit it. Refuses with E14 (403)
 * for a kindless thing its maker does not own, E2 (403) for a mode the kind does not
 * allow, and E3 (400) for a limit.
 */
export function grantForNewEnding(
  thing: EndingPermissionThing,
  policy: unknown,
  rule: EndingRule,
  now: Date,
): EndingGrant {
  const permission = endingPermission(thing, policy)
  const grant = buildGrant(permission)
  if (!grant) throw refusalError(permission.source === null ? permission.refusal : ENDING_NOT_ALLOWED_REFUSAL)
  assertRenewalFits(rule, grant, now)
  return grant
}

// ---------------------------------------------------------------------------
// The stored columns
// ---------------------------------------------------------------------------

export interface EndingColumns {
  readonly ending_rule: EndingRule
  readonly ending_grant: EndingGrant | unknown
  readonly ending_set_by: number
  readonly ending_set_at: string
  readonly ending_deadline: string | null
  readonly ending_idle_seconds: number | null
  readonly ending_idle_anchor: string | null
  readonly ending_uses_left: number | null
  readonly ending_uses_spent_at: null
  readonly ending_label: string | null
}

export interface CopyEndingColumns extends EndingColumns {
  readonly ending_copied_from: number
  readonly ending_copied_at: string
}

function firstOf<T>(rule: EndingRule, pick: (condition: EndingCondition) => T | undefined): T | null {
  for (const condition of rule.any) {
    const value = pick(condition)
    if (value !== undefined) return value
  }
  return null
}

/**
 * The columns an owner's setting or renewal writes, at set time: the soonest fixed time
 * (the date, or set time plus the time after setting), the unused length with its anchor
 * at set time, the uses, and the watched label. Copy origin columns are never touched.
 */
export function endingColumnsFor(rule: EndingRule, grant: EndingGrant, setById: number, setAt: Date): EndingColumns {
  const deadline = soonest(rule.any.map(condition => (
    'at' in condition ? toDate(condition.at)
      : 'after_setting_seconds' in condition ? plusSeconds(setAt, condition.after_setting_seconds)
        : null
  )))
  const idleSeconds = firstOf(rule, condition => ('idle_seconds' in condition ? condition.idle_seconds : undefined))
  return {
    ending_rule: rule,
    ending_grant: grant,
    ending_set_by: setById,
    ending_set_at: setAt.toISOString(),
    ending_deadline: deadline?.toISOString() ?? null,
    ending_idle_seconds: idleSeconds,
    ending_idle_anchor: idleSeconds === null ? null : setAt.toISOString(),
    ending_uses_left: firstOf(rule, condition => ('uses' in condition ? condition.uses : undefined)),
    ending_uses_spent_at: null,
    ending_label: firstOf(rule, condition => ('label_added' in condition ? condition.label_added : undefined)),
  }
}

/** The stored columns the due rule and the copy rule read. */
export interface EndingDueRow {
  readonly ending_rule: unknown
  readonly ending_set_at: EndingTime | null
  readonly ending_deadline: EndingTime | null
  readonly ending_idle_seconds: number | null
  readonly ending_idle_anchor: EndingTime | null
  readonly ending_uses_left?: number | null
  readonly ending_uses_spent_at: EndingTime | null
  readonly ending_label?: string | null
  /** The created_at of the first label row on the thing with its watched label, expired or not. */
  readonly first_label_at: EndingTime | null
  readonly ended_at?: EndingTime | null
}

/** The first watched label row counts only when it was created after the end was set. */
function countedLabelAt(row: EndingDueRow): Date | null {
  const labelAt = toDate(row.first_label_at)
  const setAt = toDate(row.ending_set_at)
  return labelAt && (!setAt || labelAt.getTime() > setAt.getTime()) ? labelAt : null
}

/**
 * When the end falls due, as thing_end_due_from computes it: the soonest of the fixed
 * deadline, the unused deadline, the moment the uses ran out, and the first watched label
 * row created after the end was set; null when no end is set or nothing applies.
 */
export function endingDueAt(row: EndingDueRow): Date | null {
  if (row.ending_rule == null) return null
  return soonest([
    toDate(row.ending_deadline),
    plusSeconds(row.ending_idle_anchor, row.ending_idle_seconds),
    toDate(row.ending_uses_spent_at),
    countedLabelAt(row),
  ])
}

/** Whether the end has come at this moment: recorded, or due. */
export function endingReached(row: EndingDueRow, now: Date): boolean {
  if (row.ended_at != null) return true
  const due = endingDueAt(row)
  return due !== null && due.getTime() <= now.getTime()
}

function conditionTime(condition: EndingCondition, row: EndingDueRow, isCopy: boolean): Date | null {
  if ('at' in condition) return toDate(condition.at)
  if ('after_setting_seconds' in condition) {
    if (typeof condition.until === 'string') return toDate(condition.until)
    return isCopy ? null : plusSeconds(row.ending_set_at, condition.after_setting_seconds)
  }
  if ('idle_seconds' in condition) {
    if (typeof condition.until === 'string') return toDate(condition.until)
    return isCopy ? null : plusSeconds(row.ending_idle_anchor, row.ending_idle_seconds)
  }
  if ('uses' in condition) return toDate(row.ending_uses_spent_at)
  return countedLabelAt(row)
}

/**
 * The condition that is met first, for ended_cause: the soonest condition's mode, the
 * earlier in canonical order on a tie, null when none has a time yet. A copy's absolute
 * ends keep their own mode, so a copied unused-for end records idle_seconds.
 */
export function dueCause(row: EndingDueRow & Readonly<{ ending_copied_from?: number | null }>): EndingMode | null {
  const rule = parseStoredEndingRule(row.ending_rule)
  if (!rule) return null
  const isCopy = row.ending_copied_from != null
  let best: Readonly<{ mode: EndingMode; time: number }> | null = null
  for (const condition of sortConditions(rule.any.filter(item => conditionMode(item) !== null))) {
    const time = conditionTime(condition, row, isCopy)
    if (time && (!best || time.getTime() < best.time)) best = { mode: conditionMode(condition) as EndingMode, time: time.getTime() }
  }
  return best?.mode ?? null
}

export interface EndingCopyParent extends EndingDueRow {
  readonly id: number
  readonly ending_grant: unknown
  readonly ending_copied_from?: number | null
}

/**
 * The end a copy is born with (decision #174): the parent's remaining rule. A date stays;
 * uses start at the parent's uses left; a time after setting and a time unused become an
 * absolute until, the parent's end for that condition at copy time, keeping their mode;
 * a label condition carries over. The copy keeps the parent's grant, is set by the copy's
 * owner at the copy time (so label rows count from its birth), and stores only absolute
 * deadlines. A parent with no end, or whose end has come (only its own end try can copy
 * it), gives its copy no end: null.
 */
export function copyRuleFrom(parent: EndingCopyParent, copiedAt: Date, copyOwnerId: number): CopyEndingColumns | null {
  const rule = parseStoredEndingRule(parent.ending_rule)
  if (!rule || endingReached(parent, copiedAt)) return null
  const isCopy = parent.ending_copied_from != null
  const conditions: EndingCondition[] = []
  for (const condition of rule.any) {
    if ('at' in condition) conditions.push({ at: condition.at })
    else if ('after_setting_seconds' in condition) {
      const until = toIso(conditionTime(condition, parent, isCopy))
      conditions.push(until ? { after_setting_seconds: condition.after_setting_seconds, until } : { after_setting_seconds: condition.after_setting_seconds })
    } else if ('idle_seconds' in condition) {
      const until = toIso(conditionTime(condition, parent, isCopy))
      conditions.push(until ? { idle_seconds: condition.idle_seconds, until } : { idle_seconds: condition.idle_seconds })
    } else if ('uses' in condition) conditions.push({ uses: parent.ending_uses_left ?? condition.uses })
    else if ('label_added' in condition) conditions.push({ label_added: condition.label_added })
  }
  const copyRule: EndingRule = { any: conditions }
  const deadline = soonest(conditions.map(condition => (
    'at' in condition ? toDate(condition.at)
      : ('after_setting_seconds' in condition || 'idle_seconds' in condition) && typeof condition.until === 'string'
        ? toDate(condition.until)
        : null
  )))
  return {
    ending_rule: copyRule,
    ending_grant: parent.ending_grant,
    ending_set_by: copyOwnerId,
    ending_set_at: copiedAt.toISOString(),
    ending_deadline: deadline?.toISOString() ?? null,
    ending_idle_seconds: null,
    ending_idle_anchor: null,
    ending_uses_left: firstOf(copyRule, condition => ('uses' in condition ? condition.uses : undefined)),
    ending_uses_spent_at: null,
    ending_label: firstOf(copyRule, condition => ('label_added' in condition ? condition.label_added : undefined)),
    ending_copied_from: parent.id,
    ending_copied_at: copiedAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// The end try's gates
// ---------------------------------------------------------------------------

export const END_TRY_GATES = Object.freeze([
  'wake_off',
  'visitors_not_waking',
  'carried',
  'in_sale',
  'room_retired',
] as const)
export type EndTryGate = typeof END_TRY_GATES[number]

export interface EndTryGateInput {
  readonly wake_enabled: boolean | null
  readonly carried: boolean | null
  readonly in_sale: boolean | null
  readonly room_retired: boolean | null
  readonly thing_id: number
  readonly owner_id: number
  readonly room_owner_id: number | null
  readonly wake_visitors: boolean | null
  readonly wake_pins: readonly number[] | null
  readonly blocked_thing_ids: readonly number[] | null
  readonly blocked_resident_ids: readonly number[] | null
}

/**
 * The closed gates of an end try, in fixed order, exactly as the SQL function
 * thing_end_try_blocked_by: waking off, the room's dials not letting it wake (its owner
 * is not the room's owner, the room does not wake visitors' things and has not pinned it,
 * or the thing or its owner is blocked), carried, in a sale, the room retired.
 */
export function endTryBlockedBy(input: EndTryGateInput): EndTryGate[] {
  const blocked: EndTryGate[] = []
  if (input.wake_enabled !== true) blocked.push('wake_off')
  const listed = (list: readonly number[] | null, id: number) => Boolean(list?.includes(id))
  const roomBlocks = listed(input.blocked_thing_ids, input.thing_id) || listed(input.blocked_resident_ids, input.owner_id)
  const roomWakes = input.owner_id === input.room_owner_id
    || input.wake_visitors === true
    || listed(input.wake_pins, input.thing_id)
  if (roomBlocks || !roomWakes) blocked.push('visitors_not_waking')
  if (input.carried === true) blocked.push('carried')
  if (input.in_sale === true) blocked.push('in_sale')
  if (input.room_retired === true) blocked.push('room_retired')
  return blocked
}

export interface EndTryThing {
  readonly id: number
  readonly owner_id: number
  readonly wake_enabled: boolean
  readonly held_by: number | null
  /** active_offer_id is set, or an open transfer offer names the thing on any channel. */
  readonly in_sale: boolean
  readonly end_program_state: EndProgramState
  readonly has_end_trait: boolean
}

export interface EndTryRoom {
  readonly owner_id: number | null
  readonly wake_visitors: boolean | null
  readonly wake_pins: readonly number[] | null
  readonly wake_block_thing_ids: readonly number[] | null
  readonly wake_block_resident_ids: readonly number[] | null
  readonly retired_at: EndingTime | null
}

export interface EndTryGates {
  readonly would_run: boolean | null
  readonly blocked_by: readonly EndTryGate[] | null
}

/**
 * Whether the end try would run now, and which gates are closed. Both are null when the
 * thing's effective revision has no end trait or its try already ran or was skipped; they
 * are computed for state none too. The settle step's end try uses the same gates.
 */
export function endTryGates(thing: EndTryThing, room: EndTryRoom): EndTryGates {
  if (!thing.has_end_trait || (thing.end_program_state !== 'none' && thing.end_program_state !== 'pending')) {
    return { would_run: null, blocked_by: null }
  }
  const blocked = endTryBlockedBy({
    wake_enabled: thing.wake_enabled,
    carried: thing.held_by != null,
    in_sale: thing.in_sale,
    room_retired: room.retired_at != null,
    thing_id: thing.id,
    owner_id: thing.owner_id,
    room_owner_id: room.owner_id,
    wake_visitors: room.wake_visitors,
    wake_pins: room.wake_pins,
    blocked_thing_ids: room.wake_block_thing_ids,
    blocked_resident_ids: room.wake_block_resident_ids,
  })
  return { would_run: blocked.length === 0, blocked_by: blocked }
}

// ---------------------------------------------------------------------------
// The public objects
// ---------------------------------------------------------------------------

export interface ThingEndingRow extends EndingPermissionThing, EndingDueRow {
  readonly id: number
  readonly parent_thing_id: number | null
  readonly ending_grant: unknown
  readonly ending_set_by: number | null
  readonly ending_uses_left: number | null
  readonly ending_label: string | null
  readonly ending_copied_from: number | null
  readonly ending_copied_at: EndingTime | null
  readonly ended_at: EndingTime | null
  readonly ended_cause: string | null
  readonly end_program_state: EndProgramState
  readonly end_program_result: unknown
  /** The resident named by ending_set_by. */
  readonly set_by: ResidentRef | null
  /** The resident named by ended_owner_id. */
  readonly owner_at_end: ResidentRef | null
  /** A trait with an end key is linked to the effective kind revision. */
  readonly has_end_trait: boolean
}

export interface EndingProgramObject {
  readonly state: EndProgramState
  readonly result: unknown
  readonly has_end_trait: boolean
  readonly would_run: boolean | null
  readonly blocked_by: readonly EndTryGate[] | null
}

/** The full ending object, key ending, on the thing read and offer reads (no summary). */
export interface EndingObject {
  readonly status: EndingStatusName
  readonly permission_source: 'kind' | 'kindless_owner' | null
  readonly permitted_modes: readonly EndingMode[]
  readonly conditions: readonly Readonly<Record<string, unknown>>[]
  readonly soonest_known_end: string | null
  readonly uses_left: number | null
  readonly unused_deadline: string | null
  readonly label: string | null
  readonly grant: unknown
  readonly still_permitted: Readonly<Record<string, boolean>> | null
  readonly copy_origin: Readonly<{ source_thing_id: number; copied_at: string | null }> | null
  readonly set_by: ResidentRef | null
  readonly set_at: string | null
  readonly renewable_before_end: boolean | null
  readonly remains: 'remnant'
  readonly ended_at: string | null
  readonly ended_cause: string | null
  readonly owner_at_end: ResidentRef | null
  readonly program: EndingProgramObject
  readonly checked_at: string
}

/** The modes the current permission would let an owner choose, for status and still_permitted. */
function currentAllowed(row: ThingEndingRow, policy: unknown): readonly string[] {
  if (!effectiveKind(row)) return row.owner_id === row.maker_id ? ENDING_MODES : []
  return storedEndingPolicy(policy).allowed
}

function computedCondition(condition: EndingCondition, row: ThingEndingRow): Readonly<Record<string, unknown>> {
  const isCopy = row.ending_copied_from != null
  if ('after_setting_seconds' in condition) {
    return { ...condition, ends_at: toIso(conditionTime(condition, row, isCopy)) }
  }
  if ('uses' in condition) return { ...condition, uses_left: row.ending_uses_left }
  if ('idle_seconds' in condition) {
    return { ...condition, unused_deadline: toIso(conditionTime(condition, row, isCopy)) }
  }
  return { ...condition }
}

function endingStatusName(row: ThingEndingRow, reached: boolean, allowed: readonly string[]): EndingStatusName {
  if (row.ended_at != null) return 'ended'
  if (row.ending_rule != null && reached) return 'due_waiting_settle'
  if (row.ending_rule != null) return 'active'
  if (row.parent_thing_id != null) return 'not_permitted_by_kind'
  return allowed.length > 0 ? 'permitted_but_unset' : 'not_permitted_by_kind'
}

/**
 * The full ending object as of now, from the stored row, the ending_policy of the thing's
 * effective revision as stored, and the end try's gates (endTryGates). It writes nothing
 * and matches snapshot format 4's ending field for field; end_program_summary is added
 * by the read beside on_use.
 */
export function endingStatus(row: ThingEndingRow, policy: unknown, gates: EndTryGates, now: Date): EndingObject {
  const rule = parseStoredEndingRule(row.ending_rule)
  const hasRule = row.ending_rule != null
  const reached = endingReached(row, now)
  const allowed = currentAllowed(row, policy)
  const status = endingStatusName(row, reached, allowed)
  const permissionSource = hasRule
    ? (isRecord(row.ending_grant) && Object.hasOwn(row.ending_grant, 'kindless') ? 'kindless_owner' : 'kind')
    : status === 'permitted_but_unset'
      ? (effectiveKind(row) ? 'kind' : 'kindless_owner')
      : null
  const conditions = (rule?.any ?? []).map(condition => computedCondition(condition, row))
  const modes = (rule?.any ?? []).map(conditionMode).filter((mode): mode is EndingMode => mode !== null)
  const idleCondition = conditions.find(condition => Object.hasOwn(condition, 'unused_deadline'))
  return {
    status,
    permission_source: permissionSource,
    permitted_modes: row.parent_thing_id != null || reached ? [] : canonicalModes(allowed),
    conditions,
    soonest_known_end: toIso(endingDueAt(row)),
    uses_left: row.ending_uses_left,
    unused_deadline: (idleCondition?.unused_deadline as string | null | undefined) ?? null,
    label: row.ending_label,
    grant: row.ending_grant,
    still_permitted: modes.length > 0
      ? Object.fromEntries(modes.map(mode => [mode, allowed.includes(mode)]))
      : null,
    copy_origin: row.ending_copied_from != null
      ? { source_thing_id: row.ending_copied_from, copied_at: toIso(row.ending_copied_at) }
      : null,
    set_by: row.set_by,
    set_at: toIso(row.ending_set_at),
    renewable_before_end: hasRule ? !reached && row.parent_thing_id == null : null,
    remains: 'remnant',
    ended_at: toIso(row.ended_at),
    ended_cause: row.ended_cause,
    owner_at_end: row.owner_at_end,
    program: {
      state: row.end_program_state,
      result: row.end_program_result,
      has_end_trait: row.has_end_trait,
      would_run: gates.would_run,
      blocked_by: gates.blocked_by,
    },
    checked_at: now.toISOString(),
  }
}

/** The short status, key ends, on every row that names a thing. */
export type ShortEndingStatus = Readonly<{ state: 'set' | 'ended'; at: string | null }>

/**
 * The short status as of now: null (leave the key out) when no end is set and the thing
 * never ended; ended at ended_at, or at the due time when the end has come but is not yet
 * recorded, so every list shows the end at once; otherwise set, at the soonest known end.
 */
export function shortEndingStatus(row: EndingDueRow, now: Date): ShortEndingStatus | null {
  if (row.ended_at != null) return { state: 'ended', at: toIso(row.ended_at) }
  if (row.ending_rule == null) return null
  const due = endingDueAt(row)
  const at = due?.toISOString() ?? null
  return due && due.getTime() <= now.getTime() ? { state: 'ended', at } : { state: 'set', at }
}
