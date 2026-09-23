/**
 * The room owner's wake dials and rough-room mark (decisions #107 and #110),
 * set only with place_edit on a place its owner holds.
 */
import { HANDLE_RE } from './core-primitives.ts'
import {
  WAKE_BLOCKS_MAX,
  WAKE_PINS_MAX,
  WAKE_RANDOM_CAP_MAX,
} from './engine-limits.ts'

export const WAKE_DIAL_FIELDS = Object.freeze([
  'wake_visitors',
  'wake_pins',
  'wake_block_thing_ids',
  'wake_block_residents',
  'wake_random_cap',
  'rough_room',
] as const)

export interface WakeDialEdit {
  readonly wakeVisitors?: boolean
  readonly roughRoom?: boolean
  readonly wakePins?: readonly number[]
  readonly wakeBlockThingIds?: readonly number[]
  readonly wakeBlockResidents?: readonly string[]
  readonly wakeRandomCap?: number
}

type DialParse = Readonly<{ ok: true; dials: WakeDialEdit }> | Readonly<{ ok: false; error: string }>

function uniqueIds(value: unknown, maximum: number): readonly number[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null
  const ids = value.filter(id => Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647) as number[]
  return ids.length === value.length && new Set(ids).size === ids.length ? Object.freeze([...ids]) : null
}

/** Read the wake dials a place_edit body carries; absent fields stay unchanged. */
export function parseWakeDials(body: Readonly<Record<string, unknown>>): DialParse {
  const refuse = (error: string): DialParse => Object.freeze({ ok: false, error })
  const dials: { -readonly [Key in keyof WakeDialEdit]: WakeDialEdit[Key] } = {}
  for (const [field, key] of [['wake_visitors', 'wakeVisitors'], ['rough_room', 'roughRoom']] as const) {
    if (body[field] === undefined) continue
    if (typeof body[field] !== 'boolean') return refuse('wake_visitors and rough_room must be boolean when present')
    dials[key] = body[field]
  }
  if (body.wake_random_cap !== undefined) {
    const cap = body.wake_random_cap
    if (!Number.isSafeInteger(cap) || (cap as number) < 0 || (cap as number) > WAKE_RANDOM_CAP_MAX) {
      return refuse(`wake_random_cap must be a whole number from 0 to ${WAKE_RANDOM_CAP_MAX}`)
    }
    dials.wakeRandomCap = cap as number
  }
  if (body.wake_pins !== undefined) {
    const pins = uniqueIds(body.wake_pins, WAKE_PINS_MAX)
    if (pins === null) return refuse(`wake_pins must be [] or 1 to ${WAKE_PINS_MAX} unique positive thing ids`)
    dials.wakePins = pins
  }
  if (body.wake_block_thing_ids !== undefined) {
    const blocked = uniqueIds(body.wake_block_thing_ids, WAKE_BLOCKS_MAX)
    if (blocked === null) {
      return refuse(`wake_block_thing_ids must be [] or up to ${WAKE_BLOCKS_MAX} unique positive thing ids`)
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
      return refuse(`wake_block_residents must be [] or up to ${WAKE_BLOCKS_MAX} unique resident handles`)
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
