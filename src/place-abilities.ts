/**
 * The room owner's ability dials: growth caps and arriving copies (decision
 * #112), wake dials, and the rough-room mark (decisions #105 and #109), set only
 * with place_edit on a place its owner holds.
 */
import { HANDLE_RE } from './core-primitives.ts'
import {
  GROWTH_CAP_MAX,
  WAKE_BLOCKS_MAX,
  WAKE_PINS_MAX,
  WAKE_RANDOM_CAP_MAX,
} from './engine-limits.ts'

export const PLACE_DIAL_FIELDS = Object.freeze([
  'growth_cap_per_day',
  'growth_share_per_family',
  'allow_arriving_copies',
  'wake_visitors',
  'wake_pins',
  'wake_block_thing_ids',
  'wake_block_residents',
  'wake_random_cap',
  'rough_room',
] as const)

export interface PlaceDialEdit {
  readonly growthCapPerDay?: number
  readonly growthSharePerFamily?: number
  readonly allowArrivingCopies?: boolean
  readonly wakeVisitors?: boolean
  readonly roughRoom?: boolean
  readonly wakePins?: readonly number[]
  readonly wakeBlockThingIds?: readonly number[]
  readonly wakeBlockResidents?: readonly string[]
  readonly wakeRandomCap?: number
}

type DialParse = Readonly<{ ok: true; dials: PlaceDialEdit }> | Readonly<{ ok: false; error: string }>

function uniqueIds(value: unknown, maximum: number): readonly number[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null
  const ids = value.filter(id => Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647) as number[]
  return ids.length === value.length && new Set(ids).size === ids.length ? Object.freeze([...ids]) : null
}

function wholeNumber(value: unknown, minimum: number, maximum: number): number | null {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? value as number
    : null
}

/** Read the ability dials a place_edit body carries; absent fields stay unchanged. */
export function parsePlaceDials(body: Readonly<Record<string, unknown>>): DialParse {
  const dials: { -readonly [Key in keyof PlaceDialEdit]: PlaceDialEdit[Key] } = {}
  for (const [field, key] of [
    ['allow_arriving_copies', 'allowArrivingCopies'],
    ['wake_visitors', 'wakeVisitors'],
    ['rough_room', 'roughRoom'],
  ] as const) {
    if (body[field] === undefined) continue
    if (typeof body[field] !== 'boolean') {
      return Object.freeze({ ok: false, error: 'allow_arriving_copies, wake_visitors, and rough_room must be boolean when present' })
    }
    dials[key] = body[field]
  }
  if (body.growth_cap_per_day !== undefined) {
    const cap = wholeNumber(body.growth_cap_per_day, 0, GROWTH_CAP_MAX)
    if (cap === null) return Object.freeze({ ok: false, error: `growth_cap_per_day must be a whole number from 0 to ${GROWTH_CAP_MAX}` })
    dials.growthCapPerDay = cap
  }
  if (body.growth_share_per_family !== undefined) {
    const share = wholeNumber(body.growth_share_per_family, 1, GROWTH_CAP_MAX)
    if (share === null) return Object.freeze({ ok: false, error: `growth_share_per_family must be a whole number from 1 to ${GROWTH_CAP_MAX}` })
    dials.growthSharePerFamily = share
  }
  if (body.wake_random_cap !== undefined) {
    const cap = body.wake_random_cap
    if (!Number.isSafeInteger(cap) || (cap as number) < 0 || (cap as number) > WAKE_RANDOM_CAP_MAX) {
      return Object.freeze({ ok: false, error: `wake_random_cap must be a whole number from 0 to ${WAKE_RANDOM_CAP_MAX}` })
    }
    dials.wakeRandomCap = cap as number
  }
  if (body.wake_pins !== undefined) {
    const pins = uniqueIds(body.wake_pins, WAKE_PINS_MAX)
    if (pins === null) return Object.freeze({ ok: false, error: `wake_pins must be [] or 1 to ${WAKE_PINS_MAX} unique positive thing ids` })
    dials.wakePins = pins
  }
  if (body.wake_block_thing_ids !== undefined) {
    const blocked = uniqueIds(body.wake_block_thing_ids, WAKE_BLOCKS_MAX)
    if (blocked === null) {
      return Object.freeze({ ok: false, error: `wake_block_thing_ids must be [] or up to ${WAKE_BLOCKS_MAX} unique positive thing ids` })
    }
    dials.wakeBlockThingIds = blocked
  }
  if (body.wake_block_residents !== undefined) {
    const handles = body.wake_block_residents
    if (
      !Array.isArray(handles)
      || handles.length > WAKE_BLOCKS_MAX
      || !handles.every(handle => typeof handle === 'string' && HANDLE_RE.test(handle))
      || new Set(handles).size !== handles.length
    ) {
      return Object.freeze({ ok: false, error: `wake_block_residents must be [] or up to ${WAKE_BLOCKS_MAX} unique resident handles` })
    }
    dials.wakeBlockResidents = Object.freeze([...handles as string[]])
  }
  return Object.freeze({ ok: true, dials: Object.freeze(dials) })
}

export function pinnedThingElsewhereRefusal(placeId: number, thingId: number): string {
  return `wake_pins must name active things standing in place ${placeId}; thing ${thingId} is elsewhere or gone`
}

export function blockedResidentUnknownRefusal(handle: string): string {
  return `wake_block_residents names ${handle}, who is not a current resident; send current handles`
}
