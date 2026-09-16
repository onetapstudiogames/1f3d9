export const WORLD_ROOT_NAME = 'the world'
export const WORLD_ROOT_OWNER_LABEL = 'nobody'
/**
 * The three clauses below are the single home of what the world says about
 * itself. The arrival next_step locked by decisions 80 and 83 and the place
 * line the world's own room read serves are both built from them, so the city
 * can never carry the same fact in two wordings or let one of them drift.
 */
const WORLD_STANDING = 'You stand in the world'
const WORLD_ONE_STEP_DOWN = 'the continents are one step down and open to enter'
const WORLD_FIRST_TOWN = 'first town is inside the mainland at place 2 and open to building'
export const WORLD_ARRIVAL_LINE = `${WORLD_STANDING}; ${WORLD_ONE_STEP_DOWN} (GET /api/map?view=outline&parent_id=195), ${WORLD_FIRST_TOWN}, and go_home only works once you own land and can never be blocked once you have a home. A move crosses one parent-child edge at a time and you can walk back; for example, POST /api/action {"action":"move","to_place_id":1} moves you to the mainland; the city never moves you on its own: only your own action, or an effect a thing or a law runs where you stand, can move you.`
export const WORLD_TRANSIT_ONLY_ERROR = 'the world is transit only; move through it, claim a frontier continent, or use an owned place instead'
/**
 * The world has no owner and accepts no laws, so no resident can write a
 * purpose for it. Every public read of the world root serves this city-written
 * line in the place purpose field instead. It is the arrival line's own words
 * with the call syntax dropped, so the room a human watches and the room a
 * resident stands in say one thing, inside the same 280-character bound an
 * owner-written purpose has.
 */
export const WORLD_ROOT_PURPOSE =
  `${WORLD_STANDING}; ${WORLD_ONE_STEP_DOWN}, and ${WORLD_FIRST_TOWN}.`

type UnknownRecord = Readonly<Record<string, unknown>>

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

/**
 * Recognizes both the fully migrated world row and its transition-safe shape.
 * Thin relationship reads can identify it structurally; richer reads must
 * agree with every world-specific field they selected.
 */
export function isWorldRootRow(value: unknown): boolean {
  const row = record(value)
  if (!row || row.parent_id !== null || row.owner_id !== null) return false
  const hasKind = Object.hasOwn(row, 'place_kind')
  const hasName = Object.hasOwn(row, 'name')
  if (!hasKind && !hasName) return false
  if (hasKind && row.place_kind !== 'world') return false
  if (hasName && row.name !== WORLD_ROOT_NAME) return false
  return true
}

export function canFoundOrdinaryChild(value: unknown): boolean {
  const row = record(value)
  return row?.open_to_building === true && !isWorldRootRow(row)
}
