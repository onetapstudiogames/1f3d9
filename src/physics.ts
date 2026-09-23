/**
 * Pure, reusable boundaries for the world's authored physics.
 *
 * New recipes are rejected as a whole when malformed. Stored recipes use
 * `loadTraitRecipe`, which turns malformed legacy data into an inert program.
 */
import { containsPublicCredential } from './credential-safety.ts'
import { publicLabel } from './input.ts'

export const BASIC_ACTIONS = Object.freeze([
  'talk',
  'move',
  'use',
  'give',
  'consume',
  'make',
  'go_home',
] as const)

export const BLOCKABLE_ACTIONS = Object.freeze([
  'talk',
  'move',
  'use',
  'give',
  'consume',
  'make',
] as const)

export const EFFECT_BRICKS = Object.freeze([
  'destroy',
  'move',
  'transfer',
  'label',
  'block',
  'wait',
  'check_label',
  'chance',
  'write',
  'copy',
  'reach',
  'convert',
] as const)

/** What sets off a thing's wake key: an arrival, a note, or its own clock. */
export const WAKE_EVENTS = Object.freeze(['arrive', 'talk', 'clock'] as const)
export const WRITE_OPS = Object.freeze(['set', 'add', 'append'] as const)
export const WRITE_FROM = Object.freeze(['actor', 'roll', 'time'] as const)
/** Where a copy appears: its own room, or one parent-child edge away. */
export const COPY_DESTINATIONS = Object.freeze(['here', 'adjacent'] as const)
export const COPY_INHERITABLE = Object.freeze(['body', 'state'] as const)
export const REACH_OVER = Object.freeze(['things', 'residents'] as const)
/** Steps a reach may run on every member, residents included. */
export const REACH_SOFT_STEPS = Object.freeze(['label', 'check_label', 'chance', 'write'] as const)
/** Steps that make a reach touch only members whose owners consented. */
export const REACH_HARD_STEPS = Object.freeze(['destroy', 'move', 'transfer', 'convert', 'wait'] as const)
/** Never allowed anywhere inside a reach. */
export const REACH_NEVER_INSIDE = Object.freeze(['block', 'copy', 'reach'] as const)

export const SYMBOLIC_TARGETS = Object.freeze([
  'actor',
  'source',
  'target',
  'place',
] as const)

export const MOVE_DESTINATIONS = Object.freeze(['destination', 'home'] as const)
export const TRANSFER_RECIPIENTS = Object.freeze(['recipient', 'actor'] as const)

export const MAX_RECIPE_BYTES = 65_536
export const MAX_EFFECT_COUNT = 128
export const MAX_EFFECT_DEPTH = 8
export const MAX_BLOCK_SECONDS = 24 * 60 * 60
export const MIN_TIMER_SECONDS = 1
export const MAX_TIMER_SECONDS = 24 * 60 * 60
export const MAX_EFFECT_GENERATIONS = 8
export const MAX_KIND_INGREDIENTS = 64
export const MAX_CRAFT_INGREDIENTS = 1_024
/** Each action key and the wake program may weigh at most this many effect applications. */
export const MAX_APPLICATIONS_PER_PROGRAM = 512
export const CHANCE_PERCENT_MIN = 1
export const CHANCE_PERCENT_MAX = 99
export const WAKE_MIN_EVERY_SECONDS = 10
export const WAKE_DEFAULT_EVERY_SECONDS = 60
export const WAKE_MAX_EVERY_SECONDS = 24 * 60 * 60
export const WAKE_DEFAULT_EVENTS = Object.freeze(['arrive'] as const)
export const STATE_BOX_MAX_KEYS = 16
export const STATE_BOX_MAX_BYTES = 4_096
export const STATE_TEXT_MAX_CHARACTERS = 200
export const STATE_LIST_MAX_ITEMS = 20
export const STATE_INTEGER_LIMIT = 1_000_000_000
export const STATE_ADD_LIMIT = 1_000_000
export const COPY_GENERATIONS_DEFAULT = 3
export const COPY_COPIES_DEFAULT = 1
export const COPY_COPIES_MAX = 10_000
export const REACH_MAX_DEFAULT = 16
export const REACH_MAX_CEILING = 64
/** A sticker a wake try puts on a resident expires after a day, like the longest block. */
export const RESIDENT_ABILITY_LABEL_SECONDS = MAX_BLOCK_SECONDS

export type BasicAction = typeof BASIC_ACTIONS[number]
export type BlockableAction = typeof BLOCKABLE_ACTIONS[number]
export type EffectBrick = typeof EFFECT_BRICKS[number]
export type SymbolicTarget = typeof SYMBOLIC_TARGETS[number]
export type MoveDestination = typeof MOVE_DESTINATIONS[number]
export type TransferRecipient = typeof TRANSFER_RECIPIENTS[number]
export type WakeEvent = typeof WAKE_EVENTS[number]
export type WriteOp = typeof WRITE_OPS[number]
export type WriteFrom = typeof WRITE_FROM[number]
export type CopyDestination = typeof COPY_DESTINATIONS[number]
export type CopyInheritable = typeof COPY_INHERITABLE[number]
export type ReachOver = typeof REACH_OVER[number]

export interface DestroyEffect {
  readonly effect: 'destroy'
  readonly target: 'source' | 'target'
}

export interface MoveEffect {
  readonly effect: 'move'
  readonly target: 'actor' | 'source' | 'target'
  readonly to: MoveDestination
}

export interface TransferEffect {
  readonly effect: 'transfer'
  readonly target: 'source' | 'target'
  readonly to: TransferRecipient
}

export interface LabelEffect {
  readonly effect: 'label'
  readonly target: SymbolicTarget
  readonly label: string
}

export interface BlockEffect {
  readonly effect: 'block'
  readonly target: 'actor' | 'target'
  readonly action: BlockableAction
  readonly seconds: number
}

export interface WaitEffect {
  readonly effect: 'wait'
  readonly seconds: number
  readonly then: readonly Effect[]
  readonly repeat?: number
}

export interface CheckLabelEffect {
  readonly effect: 'check_label'
  readonly target: SymbolicTarget
  readonly label: string
  readonly then: readonly Effect[]
  readonly else?: readonly Effect[]
}

export interface ChanceEffect {
  readonly effect: 'chance'
  readonly percent: number
  readonly then: readonly Effect[]
  readonly else?: readonly Effect[]
}

export type WriteValue = number | boolean | string | Readonly<{ from: WriteFrom }>

/** Writes the state box of the thing whose own kind traits run it; it has no target. */
export interface WriteEffect {
  readonly effect: 'write'
  readonly key: string
  readonly op: WriteOp
  readonly value: WriteValue
}

/** The thing whose own kind traits run it makes one more of its kind. */
export interface CopyEffect {
  readonly effect: 'copy'
  readonly generations: number
  readonly copies: number | 'unlimited'
  readonly to: CopyDestination
  readonly inherit: readonly CopyInheritable[]
}

/** Runs its steps once for each member of the room, with target set to that member. */
export interface ReachEffect {
  readonly effect: 'reach'
  readonly over: ReachOver
  readonly max: number
  readonly kind?: string
  readonly then: readonly Effect[]
}

/**
 * Changes the target thing's kind: in a kind's trait into that kind itself, and
 * in a law into `into_kind`, a kind the law's place owner owns.
 */
export interface ConvertEffect {
  readonly effect: 'convert'
  readonly target: 'target'
  readonly into_kind?: string
}

export type Effect =
  | DestroyEffect
  | MoveEffect
  | TransferEffect
  | LabelEffect
  | BlockEffect
  | WaitEffect
  | CheckLabelEffect
  | ChanceEffect
  | WriteEffect
  | CopyEffect
  | ReachEffect
  | ConvertEffect

export interface WakeProgram {
  readonly on: readonly WakeEvent[]
  readonly every_seconds: number
  readonly then: readonly Effect[]
}

export type TraitRecipe = Readonly<Partial<Record<BasicAction, readonly Effect[]>> & {
  wake?: WakeProgram
}>

/**
 * Why a new recipe was refused: a grammar fault, or one of the wake key's two
 * coining rules (a wake program never hands a thing over, and it has no target
 * or destination of its own outside a reach).
 */
export type RecipeFault = 'grammar' | 'wake_hand_over' | 'wake_scope'

export interface KindIngredient {
  readonly kind: string
  readonly quantity: number
}

export type KindRecipe = readonly KindIngredient[]

export const EMPTY_EFFECTS: readonly Effect[] = Object.freeze([])
export const EMPTY_TRAIT_RECIPE: TraitRecipe = Object.freeze({})

const WORLD_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const BASIC_ACTION_SET: ReadonlySet<string> = new Set(BASIC_ACTIONS)
const BLOCKABLE_ACTION_SET: ReadonlySet<string> = new Set(BLOCKABLE_ACTIONS)
const EFFECT_BRICK_SET: ReadonlySet<string> = new Set(EFFECT_BRICKS)
const SYMBOLIC_TARGET_SET: ReadonlySet<string> = new Set(SYMBOLIC_TARGETS)
const MOVE_DESTINATION_SET: ReadonlySet<string> = new Set(MOVE_DESTINATIONS)
const TRANSFER_RECIPIENT_SET: ReadonlySet<string> = new Set(TRANSFER_RECIPIENTS)
const WAKE_EVENT_SET: ReadonlySet<string> = new Set(WAKE_EVENTS)
const WRITE_OP_SET: ReadonlySet<string> = new Set(WRITE_OPS)
const WRITE_FROM_SET: ReadonlySet<string> = new Set(WRITE_FROM)
const RECIPE_KEY_SET: ReadonlySet<string> = new Set([...BASIC_ACTIONS, 'wake'])
const COPY_DESTINATION_SET: ReadonlySet<string> = new Set(COPY_DESTINATIONS)
const COPY_INHERITABLE_SET: ReadonlySet<string> = new Set(COPY_INHERITABLE)
const REACH_OVER_SET: ReadonlySet<string> = new Set(REACH_OVER)
const REACH_SOFT_STEP_SET: ReadonlySet<string> = new Set(REACH_SOFT_STEPS)
const REACH_HARD_STEP_SET: ReadonlySet<string> = new Set(REACH_HARD_STEPS)
const REACH_NEVER_INSIDE_SET: ReadonlySet<string> = new Set(REACH_NEVER_INSIDE)

type UnknownRecord = Record<PropertyKey, unknown>
type ParseState = { count: number }

function isRecord(value: unknown): value is UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional])
  const keys = Reflect.ownKeys(value)
  return required.every(key => Object.hasOwn(value, key))
    && keys.every(key => typeof key === 'string' && allowed.has(key))
    && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
    })
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key === 'symbol')) return false
  if (keys.some(key => (
    typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))
  ))) return false
  if (keys.length !== value.length + 1) return false
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
  })
}

function isWithinJsonBudget(value: unknown): boolean {
  try {
    const encoded = JSON.stringify(value)
    return encoded !== undefined && Buffer.byteLength(encoded, 'utf8') <= MAX_RECIPE_BYTES
  } catch {
    return false
  }
}

function canonicalToken(value: unknown, choices: ReadonlySet<string>): string | null {
  if (typeof value !== 'string' || value.length > 128) return null
  const normalized = value.toLowerCase().trim()
  return choices.has(normalized) ? normalized : null
}

function canonicalName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 128) return null
  const normalized = value.toLowerCase().trim()
  return WORLD_NAME_RE.test(normalized) && !containsPublicCredential(normalized)
    ? normalized
    : null
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | null {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? value as number
    : null
}

function symbolicTarget(value: unknown): SymbolicTarget | null {
  return canonicalToken(value, SYMBOLIC_TARGET_SET) as SymbolicTarget | null
}

function stateText(value: unknown): string | null {
  return publicLabel(value, STATE_TEXT_MAX_CHARACTERS)
}

function writeFrom(value: unknown): Readonly<{ from: WriteFrom }> | null {
  if (!isRecord(value) || !hasExactKeys(value, ['from'])) return null
  const from = canonicalToken(value.from, WRITE_FROM_SET) as WriteFrom | null
  return from ? Object.freeze({ from }) : null
}

function writeValue(op: WriteOp, value: UnknownRecord): WriteValue | null {
  const present = Object.hasOwn(value, 'value')
  const raw = value.value
  if (op === 'add') {
    return present ? boundedInteger(raw, -STATE_ADD_LIMIT, STATE_ADD_LIMIT) : 1
  }
  if (!present) return null
  if (op === 'append') return writeFrom(raw) ?? stateText(raw)
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') return boundedInteger(raw, -STATE_INTEGER_LIMIT, STATE_INTEGER_LIMIT)
  return writeFrom(raw) ?? stateText(raw)
}

function parseWrite(value: UnknownRecord): WriteEffect | null {
  if (!hasExactKeys(value, ['effect', 'key'], ['op', 'value'])) return null
  const key = canonicalName(value.key)
  const op = Object.hasOwn(value, 'op')
    ? canonicalToken(value.op, WRITE_OP_SET) as WriteOp | null
    : 'set'
  if (!key || !op) return null
  const written = writeValue(op, value)
  return written === null ? null : Object.freeze({ effect: 'write', key, op, value: written })
}

function parseInherit(value: unknown): readonly CopyInheritable[] | null {
  if (!isDenseArray(value) || value.length > COPY_INHERITABLE.length) return null
  const chosen = value.map(part => canonicalToken(part, COPY_INHERITABLE_SET))
  if (chosen.some(part => part === null) || new Set(chosen).size !== chosen.length) return null
  return Object.freeze(COPY_INHERITABLE.filter(part => chosen.includes(part)))
}

function parseCopy(value: UnknownRecord): CopyEffect | null {
  if (!hasExactKeys(value, ['effect'], ['generations', 'copies', 'to', 'inherit'])) return null
  const generations = Object.hasOwn(value, 'generations')
    ? boundedInteger(value.generations, 1, MAX_EFFECT_GENERATIONS)
    : COPY_GENERATIONS_DEFAULT
  const copies = !Object.hasOwn(value, 'copies')
    ? COPY_COPIES_DEFAULT
    : canonicalToken(value.copies, new Set(['unlimited'])) === 'unlimited'
      ? 'unlimited' as const
      : boundedInteger(value.copies, 1, COPY_COPIES_MAX)
  const to = Object.hasOwn(value, 'to')
    ? canonicalToken(value.to, COPY_DESTINATION_SET) as CopyDestination | null
    : 'here'
  const inherit = Object.hasOwn(value, 'inherit')
    ? parseInherit(value.inherit)
    : Object.freeze(['body' as const])
  if (generations === null || copies === null || to === null || inherit === null) return null
  return Object.freeze({ effect: 'copy', generations, copies, to, inherit })
}

/**
 * A reach never holds a block, a copy, or another reach, never moves the
 * resident who acts, and over residents holds only soft steps.
 */
function reachStepsAllowed(over: ReachOver, then: readonly Effect[]): boolean {
  if (someEffect(then, effect => REACH_NEVER_INSIDE_SET.has(effect.effect))) return false
  if (someEffect(then, effect => effect.effect === 'move' && effect.target === 'actor')) return false
  return over === 'things' || !someEffect(then, effect => !REACH_SOFT_STEP_SET.has(effect.effect))
}

function parseReach(value: UnknownRecord, depth: number, state: ParseState): ReachEffect | null {
  if (!hasExactKeys(value, ['effect', 'then'], ['over', 'max', 'kind'])) return null
  const over = Object.hasOwn(value, 'over')
    ? canonicalToken(value.over, REACH_OVER_SET) as ReachOver | null
    : 'things'
  const max = Object.hasOwn(value, 'max')
    ? boundedInteger(value.max, 1, REACH_MAX_CEILING)
    : REACH_MAX_DEFAULT
  const kind = Object.hasOwn(value, 'kind') ? canonicalName(value.kind) : undefined
  if (over === null || max === null || kind === null) return null
  if (kind !== undefined && over !== 'things') return null
  const then = parseEffectList(value.then, depth + 1, state)
  if (!then || !reachStepsAllowed(over, then)) return null
  return kind === undefined
    ? Object.freeze({ effect: 'reach', over, max, then })
    : Object.freeze({ effect: 'reach', over, max, kind, then })
}

function parseConvert(value: UnknownRecord): ConvertEffect | null {
  if (!hasExactKeys(value, ['effect', 'target'], ['into_kind'])) return null
  if (canonicalToken(value.target, new Set(['target'])) !== 'target') return null
  if (!Object.hasOwn(value, 'into_kind')) return Object.freeze({ effect: 'convert', target: 'target' })
  const intoKind = canonicalName(value.into_kind)
  return intoKind === null
    ? null
    : Object.freeze({ effect: 'convert', target: 'target', into_kind: intoKind })
}

function parseEffectList(
  value: unknown,
  depth: number,
  state: ParseState,
): readonly Effect[] | null {
  if (
    !Array.isArray(value)
    || value.length > MAX_EFFECT_COUNT - state.count
    || !isDenseArray(value)
    || depth > MAX_EFFECT_DEPTH
  ) return null
  const effects: Effect[] = []
  for (const candidate of value) {
    state.count += 1
    if (state.count > MAX_EFFECT_COUNT) return null
    const effect = parseEffect(candidate, depth, state)
    if (!effect) return null
    effects.push(effect)
  }
  return Object.freeze(effects)
}

function parseEffect(value: unknown, depth: number, state: ParseState): Effect | null {
  if (!isRecord(value)) return null
  const effectDescriptor = Object.getOwnPropertyDescriptor(value, 'effect')
  if (!effectDescriptor || !Object.hasOwn(effectDescriptor, 'value')) return null
  const discriminator = canonicalToken(value.effect, EFFECT_BRICK_SET) as EffectBrick | null
  if (!discriminator) return null

  if (discriminator === 'destroy') {
    if (!hasExactKeys(value, ['effect', 'target'])) return null
    const target = canonicalToken(value.target, new Set(['source', 'target']))
    return target ? Object.freeze({ effect: 'destroy', target }) as DestroyEffect : null
  }

  if (discriminator === 'move') {
    if (!hasExactKeys(value, ['effect', 'target', 'to'])) return null
    const target = canonicalToken(value.target, new Set(['actor', 'source', 'target']))
    const to = canonicalToken(value.to, MOVE_DESTINATION_SET) as MoveDestination | null
    return target && to ? Object.freeze({ effect: 'move', target, to }) as MoveEffect : null
  }

  if (discriminator === 'transfer') {
    if (!hasExactKeys(value, ['effect', 'target', 'to'])) return null
    const target = canonicalToken(value.target, new Set(['source', 'target']))
    const to = canonicalToken(value.to, TRANSFER_RECIPIENT_SET) as TransferRecipient | null
    return target && to ? Object.freeze({ effect: 'transfer', target, to }) as TransferEffect : null
  }

  if (discriminator === 'label') {
    if (!hasExactKeys(value, ['effect', 'target', 'label'])) return null
    const target = symbolicTarget(value.target)
    const label = canonicalName(value.label)
    return target && label ? Object.freeze({ effect: 'label', target, label }) : null
  }

  if (discriminator === 'block') {
    if (!hasExactKeys(value, ['effect', 'target', 'action', 'seconds'])) return null
    const target = canonicalToken(value.target, new Set(['actor', 'target']))
    const action = canonicalToken(value.action, BLOCKABLE_ACTION_SET) as BlockableAction | null
    const seconds = boundedInteger(value.seconds, 1, MAX_BLOCK_SECONDS)
    return target && action && seconds !== null
      ? Object.freeze({ effect: 'block', target, action, seconds }) as BlockEffect
      : null
  }

  if (discriminator === 'wait') {
    if (!hasExactKeys(value, ['effect', 'seconds', 'then'], ['repeat'])) return null
    const seconds = boundedInteger(value.seconds, MIN_TIMER_SECONDS, MAX_TIMER_SECONDS)
    if (seconds === null) return null
    const then = parseEffectList(value.then, depth + 1, state)
    if (!then) return null
    if (!Object.hasOwn(value, 'repeat')) {
      return Object.freeze({ effect: 'wait', seconds, then })
    }
    const repeat = boundedInteger(value.repeat, 1, MAX_EFFECT_GENERATIONS)
    return repeat === null
      ? null
      : Object.freeze({ effect: 'wait', seconds, then, repeat })
  }

  if (discriminator === 'chance') {
    if (!hasExactKeys(value, ['effect', 'percent', 'then'], ['else'])) return null
    const percent = boundedInteger(value.percent, CHANCE_PERCENT_MIN, CHANCE_PERCENT_MAX)
    if (percent === null) return null
    const then = parseEffectList(value.then, depth + 1, state)
    if (!then) return null
    if (!Object.hasOwn(value, 'else')) return Object.freeze({ effect: 'chance', percent, then })
    const otherwise = parseEffectList(value.else, depth + 1, state)
    return otherwise
      ? Object.freeze({ effect: 'chance', percent, then, else: otherwise })
      : null
  }

  if (discriminator === 'write') return parseWrite(value)
  if (discriminator === 'copy') return parseCopy(value)
  if (discriminator === 'reach') return parseReach(value, depth, state)
  if (discriminator === 'convert') return parseConvert(value)

  if (!hasExactKeys(value, ['effect', 'target', 'label', 'then'], ['else'])) return null
  const target = symbolicTarget(value.target)
  const label = canonicalName(value.label)
  if (!target || !label) return null
  const then = parseEffectList(value.then, depth + 1, state)
  if (!then) return null
  if (!Object.hasOwn(value, 'else')) {
    return Object.freeze({ effect: 'check_label', target, label, then })
  }
  const otherwise = parseEffectList(value.else, depth + 1, state)
  return otherwise
    ? Object.freeze({ effect: 'check_label', target, label, then, else: otherwise })
    : null
}

function effectBranches(effect: Effect): readonly (readonly Effect[])[] {
  if (effect.effect === 'wait' || effect.effect === 'reach') return [effect.then]
  if (effect.effect === 'check_label' || effect.effect === 'chance') {
    return [effect.then, effect.else ?? EMPTY_EFFECTS]
  }
  return []
}

function someEffect(effects: readonly Effect[], matches: (effect: Effect) => boolean): boolean {
  return effects.some(effect => (
    matches(effect) || effectBranches(effect).some(branch => someEffect(branch, matches))
  ))
}

/**
 * The most effect applications one run of a program can make: wait and chance
 * weigh one plus a branch, check_label weighs its larger branch, a reach weighs
 * its max times its steps, and every other brick weighs one.
 */
export function programWeight(effects: readonly Effect[]): number {
  return effects.reduce((total, effect) => {
    if (effect.effect === 'wait') return total + 1 + programWeight(effect.then)
    if (effect.effect === 'reach') return total + effect.max * programWeight(effect.then)
    if (effect.effect === 'check_label' || effect.effect === 'chance') {
      const larger = Math.max(
        programWeight(effect.then),
        programWeight(effect.else ?? EMPTY_EFFECTS),
      )
      return total + (effect.effect === 'chance' ? 1 : 0) + larger
    }
    return total + 1
  }, 0)
}

/** A reach with any harder step, however deep, touches only members whose owners consented. */
export function reachIsHard(effect: ReachEffect): boolean {
  return someEffect(effect.then, step => REACH_HARD_STEP_SET.has(step.effect))
}

/** A wake program names target only for a reach member, and moves only to home. */
function wakeReachesOutside(effects: readonly Effect[], insideReach: boolean): boolean {
  return effects.some(effect => {
    if (effect.effect === 'reach') return wakeReachesOutside(effect.then, true)
    if (effect.effect === 'move' && effect.to !== 'home') return true
    if (!insideReach && 'target' in effect && effect.target === 'target') return true
    return effectBranches(effect).some(branch => wakeReachesOutside(branch, insideReach))
  })
}

function wakeFault(effects: readonly Effect[]): RecipeFault | null {
  if (someEffect(effects, effect => effect.effect === 'transfer')) return 'wake_hand_over'
  return wakeReachesOutside(effects, false) ? 'wake_scope' : null
}

function parseWakeEvents(value: unknown): readonly WakeEvent[] | null {
  if (!isDenseArray(value) || value.length < 1 || value.length > WAKE_EVENTS.length) return null
  const chosen = value.map(event => canonicalToken(event, WAKE_EVENT_SET))
  if (chosen.some(event => event === null) || new Set(chosen).size !== chosen.length) return null
  return Object.freeze(WAKE_EVENTS.filter(event => chosen.includes(event)))
}

function parseWake(value: unknown, state: ParseState): WakeProgram | null {
  if (!isRecord(value) || !hasExactKeys(value, ['then'], ['on', 'every_seconds'])) return null
  const on = Object.hasOwn(value, 'on') ? parseWakeEvents(value.on) : WAKE_DEFAULT_EVENTS
  const everySeconds = Object.hasOwn(value, 'every_seconds')
    ? boundedInteger(value.every_seconds, WAKE_MIN_EVERY_SECONDS, WAKE_MAX_EVERY_SECONDS)
    : WAKE_DEFAULT_EVERY_SECONDS
  if (!on || everySeconds === null) return null
  const then = parseEffectList(value.then, 1, state)
  return then ? Object.freeze({ on, every_seconds: everySeconds, then }) : null
}

type RecipeParse = Readonly<{ recipe: TraitRecipe | null; fault: RecipeFault | null }>

const GRAMMAR_FAULT: RecipeParse = Object.freeze({ recipe: null, fault: 'grammar' })

function recipeInput(value: unknown): UnknownRecord | null {
  if (Array.isArray(value)) {
    return value.length <= MAX_EFFECT_COUNT && isDenseArray(value) ? { use: value } : null
  }
  if (!isRecord(value)) return null
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string' || !RECIPE_KEY_SET.has(key))) return null
  const plain = keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
  })
  return plain ? value : null
}

function parseRecipe(value: unknown): RecipeParse {
  try {
    const input = recipeInput(value)
    if (!input) return GRAMMAR_FAULT
    const state: ParseState = { count: 0 }
    const canonical: { -readonly [Key in keyof TraitRecipe]: TraitRecipe[Key] } = {}
    for (const action of BASIC_ACTIONS) {
      if (!Object.hasOwn(input, action)) continue
      const effects = parseEffectList(input[action], 1, state)
      if (!effects || programWeight(effects) > MAX_APPLICATIONS_PER_PROGRAM) return GRAMMAR_FAULT
      canonical[action] = effects
    }
    if (Object.hasOwn(input, 'wake')) {
      const wake = parseWake(input.wake, state)
      if (!wake || programWeight(wake.then) > MAX_APPLICATIONS_PER_PROGRAM) return GRAMMAR_FAULT
      const fault = wakeFault(wake.then)
      if (fault) return Object.freeze({ recipe: null, fault })
      canonical.wake = wake
    }
    const recipe: TraitRecipe = Object.freeze(canonical)
    return isWithinJsonBudget(recipe) ? Object.freeze({ recipe, fault: null }) : GRAMMAR_FAULT
  } catch {
    return GRAMMAR_FAULT
  }
}

/** Parse and canonicalize a newly authored trait recipe. */
export function parseTraitRecipe(value: unknown): TraitRecipe | null {
  return parseRecipe(value).recipe
}

/** Why a newly authored recipe is refused, or null when it is accepted. */
export function traitRecipeFault(value: unknown): RecipeFault | null {
  return parseRecipe(value).fault
}

function recipeHasEffect(recipe: TraitRecipe, matches: (effect: Effect) => boolean): boolean {
  return BASIC_ACTIONS.some(action => someEffect(recipe[action] ?? EMPTY_EFFECTS, matches))
    || someEffect(recipe.wake?.then ?? EMPTY_EFFECTS, matches)
}

/**
 * Copy, write, the wake key, and a convert without into_kind need a thing of
 * their own, so they work only in a kind's traits.
 */
export function recipeUsesKindOnlyAbility(recipe: TraitRecipe): boolean {
  if (recipe.wake) return true
  return recipeHasEffect(recipe, effect => (
    effect.effect === 'write'
    || effect.effect === 'copy'
    || (effect.effect === 'convert' && effect.into_kind === undefined)
  ))
}

/** A convert that names into_kind turns things into another kind, which only a law may do. */
export function recipeConvertsIntoNamedKind(recipe: TraitRecipe): boolean {
  return recipeIntoKinds(recipe).length > 0
}

/** Every kind a law's converts name, so its adoption can check who owns them. */
export function recipeIntoKinds(recipe: TraitRecipe): readonly string[] {
  const names = new Set<string>()
  recipeHasEffect(recipe, effect => {
    if (effect.effect === 'convert' && effect.into_kind !== undefined) names.add(effect.into_kind)
    return false
  })
  return Object.freeze([...names])
}

/** The stored wake program of a trait, or null when it has none or is malformed. */
export function wakeProgramOf(value: unknown): WakeProgram | null {
  return loadTraitRecipe(value).wake ?? null
}

/** Load untrusted stored data without ever executing a malformed partial recipe. */
export function loadTraitRecipe(value: unknown): TraitRecipe {
  return parseTraitRecipe(value) ?? EMPTY_TRAIT_RECIPE
}

/** Select an action program from stored data; invalid legacy data is inert. */
export function effectsForAction(value: unknown, action: BasicAction): readonly Effect[] {
  if (!isBasicAction(action)) return EMPTY_EFFECTS
  return loadTraitRecipe(value)[action] ?? EMPTY_EFFECTS
}

/** Parse a kind's material recipe without requiring referenced kinds to exist yet. */
export function parseKindRecipe(value: unknown): KindRecipe | null {
  try {
    if (!Array.isArray(value) || value.length > MAX_KIND_INGREDIENTS || !isDenseArray(value)) {
      return null
    }
    const seen = new Set<string>()
    const ingredients: KindIngredient[] = []
    let totalQuantity = 0
    for (const candidate of value) {
      if (!isRecord(candidate) || !hasExactKeys(candidate, ['kind', 'quantity'])) return null
      const kind = canonicalName(candidate.kind)
      const quantity = boundedInteger(candidate.quantity, 1, MAX_CRAFT_INGREDIENTS)
      if (
        !kind
        || quantity === null
        || seen.has(kind)
        || totalQuantity + quantity > MAX_CRAFT_INGREDIENTS
      ) return null
      seen.add(kind)
      totalQuantity += quantity
      ingredients.push(Object.freeze({ kind, quantity }))
    }
    const recipe = Object.freeze(ingredients)
    return isWithinJsonBudget(recipe) ? recipe : null
  } catch {
    return null
  }
}

export function isBasicAction(value: unknown): value is BasicAction {
  return typeof value === 'string' && BASIC_ACTION_SET.has(value)
}

export function isBlockableAction(value: unknown): value is BlockableAction {
  return typeof value === 'string' && BLOCKABLE_ACTION_SET.has(value)
}

export function isEffectBrick(value: unknown): value is EffectBrick {
  return typeof value === 'string' && EFFECT_BRICK_SET.has(value)
}
