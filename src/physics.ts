/**
 * Pure, reusable boundaries for the world's authored physics.
 *
 * New recipes are rejected as a whole when malformed. Stored recipes use
 * `loadTraitRecipe`, which turns malformed legacy data into an inert program.
 */
import { containsPublicCredential } from './credential-safety.ts'

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
] as const)

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
export const MAX_KIND_QUANTITY = MAX_CRAFT_INGREDIENTS

// Descriptive aliases make the limits harder to misuse at call sites.
export const MAX_RECIPE_EFFECTS = MAX_EFFECT_COUNT
export const MAX_RECIPE_DEPTH = MAX_EFFECT_DEPTH
export const MIN_WAIT_SECONDS = MIN_TIMER_SECONDS
export const MAX_WAIT_SECONDS = MAX_TIMER_SECONDS
export const MAX_GENERATIONS = MAX_EFFECT_GENERATIONS

export type BasicAction = typeof BASIC_ACTIONS[number]
export type BlockableAction = typeof BLOCKABLE_ACTIONS[number]
export type EffectBrick = typeof EFFECT_BRICKS[number]
export type SymbolicTarget = typeof SYMBOLIC_TARGETS[number]
export type MoveDestination = typeof MOVE_DESTINATIONS[number]
export type TransferRecipient = typeof TRANSFER_RECIPIENTS[number]

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

export type Effect =
  | DestroyEffect
  | MoveEffect
  | TransferEffect
  | LabelEffect
  | BlockEffect
  | WaitEffect
  | CheckLabelEffect

export type TraitRecipe = Readonly<Partial<Record<BasicAction, readonly Effect[]>>>

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

/** Parse and canonicalize a newly authored trait recipe. */
export function parseTraitRecipe(value: unknown): TraitRecipe | null {
  try {
    let input: UnknownRecord
    if (Array.isArray(value)) {
      if (value.length > MAX_EFFECT_COUNT || !isDenseArray(value)) return null
      input = { use: value }
    } else {
      if (!isRecord(value)) return null
      input = value
    }

    const keys = Reflect.ownKeys(input)
    if (keys.some(key => typeof key !== 'string' || !BASIC_ACTION_SET.has(key))) return null
    if (keys.some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      return descriptor === undefined || !Object.hasOwn(descriptor, 'value')
    })) return null

    const state: ParseState = { count: 0 }
    const canonical: Partial<Record<BasicAction, readonly Effect[]>> = {}
    for (const action of BASIC_ACTIONS) {
      if (!Object.hasOwn(input, action)) continue
      const effects = parseEffectList(input[action], 1, state)
      if (!effects) return null
      canonical[action] = effects
    }
    const recipe = Object.freeze(canonical)
    return isWithinJsonBudget(recipe) ? recipe : null
  } catch {
    return null
  }
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
      const quantity = boundedInteger(candidate.quantity, 1, MAX_KIND_QUANTITY)
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

export const canonicalTraitRecipe = parseTraitRecipe
export const safeTraitRecipe = loadTraitRecipe
export const canonicalKindRecipe = parseKindRecipe
