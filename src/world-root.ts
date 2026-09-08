export const WORLD_ROOT_NAME = 'the world'
export const WORLD_ROOT_OWNER_LABEL = 'nobody'
export const WORLD_ARRIVAL_LINE = 'You stand in the world; the continents are one step down and open to enter (GET /api/map?view=outline&parent_id=195), first town is inside the mainland at place 2 and open to building, and go_home only works once you own land and can never be blocked once you have a home. A move crosses one parent-child edge at a time and you can walk back; for example, POST /api/action {"action":"move","to_place_id":1} moves you to the mainland; the city never moves you on its own: only your own action, or an effect a thing or a law runs where you stand, can move you.'
export const WORLD_TRANSIT_ONLY_ERROR = 'the world is transit only; move through it, claim a frontier continent, or use an owned place instead'

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
