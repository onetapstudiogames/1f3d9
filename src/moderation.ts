import { publicText } from './input.ts'

export const MODERATION_TARGET_TYPES = Object.freeze([
  'place',
  'thing',
  'kind',
  'trait',
  'note',
  'agreement',
] as const)

export const MODERATION_ACTIONS = Object.freeze(['remove', 'restore'] as const)
export const MODERATION_REASON_MAX_BYTES = 4_000
export const MODERATED_TEXT = '[removed by maintainer]'

export type ModerationTargetType = typeof MODERATION_TARGET_TYPES[number]
export type ModerationAction = typeof MODERATION_ACTIONS[number]
export type ModerationActionId = number | bigint | `${bigint}`

export interface ModerationInput {
  readonly target_type: ModerationTargetType
  readonly target_id: number
  readonly action: ModerationAction
  readonly reason: string
}

export interface ModerationActionRow extends ModerationInput {
  readonly id: ModerationActionId
  readonly actor_id: 1
  readonly created_at: string | Date
}

export interface ModerationState {
  readonly target_type: ModerationTargetType
  readonly target_id: number
  readonly moderated: boolean
  readonly latest_action: ModerationActionRow | null
}

type PublicRecord = Readonly<object>
type UnknownRecord = Record<PropertyKey, unknown>

export type ModeratedRecord<T extends PublicRecord> = Readonly<
  Omit<T, 'moderated'> & { readonly moderated: true }
>

const TARGET_TYPE_SET: ReadonlySet<string> = new Set(MODERATION_TARGET_TYPES)
const ACTION_SET: ReadonlySet<string> = new Set(MODERATION_ACTIONS)
const INPUT_FIELDS: ReadonlySet<string> = new Set([
  'target_type', 'target_id', 'action', 'reason',
])

const DISPLAY_FIELDS = Object.freeze({
  place: Object.freeze(['name', 'description', 'purpose'] as const),
  thing: Object.freeze(['name', 'body'] as const),
  kind: Object.freeze(['name', 'description'] as const),
  trait: Object.freeze(['name', 'description'] as const),
  note: Object.freeze(['body'] as const),
  agreement: Object.freeze(['body'] as const),
} satisfies Readonly<Record<ModerationTargetType, readonly string[]>>)

const CONTENT_TOMBSTONES = Object.freeze({
  place: Object.freeze({}),
  thing: Object.freeze({}),
  kind: Object.freeze({ traits: Object.freeze([]), recipe: null }),
  trait: Object.freeze({ recipe: null, mechanical: false }),
  note: Object.freeze({}),
  agreement: Object.freeze({}),
} satisfies Readonly<Record<ModerationTargetType, Readonly<Record<string, unknown>>>>)

export function moderationTargetType(value: unknown): ModerationTargetType | null {
  return typeof value === 'string' && TARGET_TYPE_SET.has(value)
    ? value as ModerationTargetType
    : null
}

export function moderationAction(value: unknown): ModerationAction | null {
  return typeof value === 'string' && ACTION_SET.has(value)
    ? value as ModerationAction
    : null
}

export function moderationReason(value: unknown): string | null {
  return publicText(value, { maximumBytes: MODERATION_REASON_MAX_BYTES })
}

function exactDataRecord(value: unknown, fields: ReadonlySet<string>): UnknownRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null

  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    if (keys.length !== fields.size) return null
    if (!keys.every(key => typeof key === 'string' && fields.has(key))) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, 'value'))) return null
    return value as UnknownRecord
  } catch {
    return null
  }
}

export function moderationInput(value: unknown): ModerationInput | null {
  const record = exactDataRecord(value, INPUT_FIELDS)
  if (!record) return null
  const targetType = moderationTargetType(record.target_type)
  const action = moderationAction(record.action)
  const reason = moderationReason(record.reason)
  const targetId = record.target_id
  if (!targetType || !action || reason === null) return null
  if (typeof targetId !== 'number' || !Number.isSafeInteger(targetId) || targetId < 1) return null

  return Object.freeze({
    target_type: targetType,
    target_id: targetId,
    action,
    reason,
  })
}

function redactFields<T extends PublicRecord>(
  record: T,
  fields: readonly string[],
  tombstones: Readonly<Record<string, unknown>> = {},
): ModeratedRecord<T> {
  const cloned = structuredClone(record)
  const replacements = Object.fromEntries(
    fields.filter(field => Object.hasOwn(record, field)).map(field => [field, MODERATED_TEXT]),
  )
  return deepFreeze({
    ...cloned,
    ...replacements,
    ...tombstones,
    moderated: true as const,
  }) as ModeratedRecord<T>
}

function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) deepFreeze(child, seen)
  return Object.freeze(value)
}

export function redactPlace<T extends PublicRecord>(record: T): ModeratedRecord<T> {
  return redactFields(record, DISPLAY_FIELDS.place)
}

export function redactThing<T extends PublicRecord>(record: T): ModeratedRecord<T> {
  return redactFields(record, DISPLAY_FIELDS.thing)
}

export function redactKind<T extends PublicRecord>(record: T): ModeratedRecord<T> {
  return redactFields(record, DISPLAY_FIELDS.kind, CONTENT_TOMBSTONES.kind)
}

export function redactTrait<T extends PublicRecord>(record: T): ModeratedRecord<T> {
  return redactFields(record, DISPLAY_FIELDS.trait, CONTENT_TOMBSTONES.trait)
}

export function redactNote<T extends PublicRecord>(record: T): ModeratedRecord<T> {
  return redactFields(record, DISPLAY_FIELDS.note)
}

export function redactAgreement<T extends PublicRecord>(record: T): ModeratedRecord<T> {
  return redactFields(record, DISPLAY_FIELDS.agreement)
}

export function redactModeratedTarget<T extends PublicRecord>(
  targetType: ModerationTargetType,
  record: T,
): ModeratedRecord<T> {
  return redactFields(record, DISPLAY_FIELDS[targetType], CONTENT_TOMBSTONES[targetType])
}

function timestamp(value: string | Date): number {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(milliseconds) ? milliseconds : Number.NEGATIVE_INFINITY
}

function serial(value: ModerationActionId): bigint | null {
  try {
    if (typeof value === 'bigint') return value > 0n ? value : null
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value > 0 ? BigInt(value) : null
    }
    return /^[1-9][0-9]*$/u.test(value) ? BigInt(value) : null
  } catch {
    return null
  }
}

function isLater(candidate: ModerationActionRow, current: ModerationActionRow): boolean {
  const candidateTime = timestamp(candidate.created_at)
  const currentTime = timestamp(current.created_at)
  if (candidateTime !== currentTime) return candidateTime > currentTime

  const candidateId = serial(candidate.id)
  const currentId = serial(current.id)
  if (candidateId === null) return false
  return currentId === null || candidateId > currentId
}

export function latestModerationAction(
  rows: readonly ModerationActionRow[],
  targetType: ModerationTargetType,
  targetId: number,
): ModerationActionRow | null {
  return rows.reduce<ModerationActionRow | null>((latest, row) => {
    if (row.target_type !== targetType || row.target_id !== targetId) return latest
    return latest === null || isLater(row, latest) ? row : latest
  }, null)
}

export function moderationStateFromActions(
  rows: readonly ModerationActionRow[],
  targetType: ModerationTargetType,
  targetId: number,
): ModerationState {
  const latestAction = latestModerationAction(rows, targetType, targetId)
  return Object.freeze({
    target_type: targetType,
    target_id: targetId,
    moderated: latestAction?.action === 'remove',
    latest_action: latestAction,
  })
}

export function isModerated(
  rows: readonly ModerationActionRow[],
  targetType: ModerationTargetType,
  targetId: number,
): boolean {
  return moderationStateFromActions(rows, targetType, targetId).moderated
}

export function deriveModerationStates(
  rows: readonly ModerationActionRow[],
): readonly ModerationState[] {
  const targets = rows.reduce<readonly Readonly<{
    targetType: ModerationTargetType
    targetId: number
  }>[]>((known, row) => (
    known.some(target => target.targetType === row.target_type && target.targetId === row.target_id)
      ? known
      : [...known, Object.freeze({ targetType: row.target_type, targetId: row.target_id })]
  ), [])

  return Object.freeze(targets.map(target => (
    moderationStateFromActions(rows, target.targetType, target.targetId)
  )))
}
