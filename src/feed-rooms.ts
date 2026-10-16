// Feed rooms (decision #153). A place owner may mark an owned quiet room as a feed
// room; its notes, lines, things and pings then stay out of residents' city-wide
// lists (search, events, changes, the front door's recent activity, and the
// mention lookups in me), for every caller, and each of those answers counts what it
// left out. The room's own reads, read_here, wait_here and every human view are
// unchanged; place edits are never left out. Pure SQL text and answer shaping: this
// file imports nothing, so public read builders can use it.

/** The event kinds that carry a note, line, thing or ping in a room. */
export const FEED_ROOM_EVENT_KINDS = Object.freeze([
  'note', 'line_said', 'ping_sent', 'ping_answered',
  'thing_created', 'thing_crafted', 'thing_edited', 'thing_moved', 'thing_upgraded',
  'thing_withdrawn',
] as const)

const FEED_ROOM_EVENT_KIND_SQL = FEED_ROOM_EVENT_KINDS.map(kind => `'${kind}'`).join(', ')

/** The most feed room ids one answer names. */
export const LEFT_OUT_FEED_ROOM_IDS_MAX = 10

/**
 * Every feed room's id as one integer array, read once per statement. A place-scoped
 * read passes the place it is scoped to, so that room's own events stay in.
 */
export function feedRoomIdsSql(exceptPlaceSql: string | null = null): string {
  return `ARRAY(SELECT feed_room.id FROM places feed_room WHERE feed_room.feed${
    exceptPlaceSql === null ? '' : ` AND feed_room.id IS DISTINCT FROM ${exceptPlaceSql}`
  } ORDER BY feed_room.id)`
}

// The room an event's note, line, thing or ping is in: the place it names, else the
// thing's current place. Detail ids are regex-guarded before casting because detail is
// caller-shaped JSONB.
function eventRoomSql(eventAlias: string): string {
  return `CASE
      WHEN ${eventAlias}.detail->>'place_id' ~ '^[1-9][0-9]{0,8}$'
        THEN (${eventAlias}.detail->>'place_id')::integer
      WHEN ${eventAlias}.detail->>'thing_id' ~ '^[1-9][0-9]{0,8}$' THEN (
        SELECT feed_thing.place_id FROM things feed_thing
        WHERE feed_thing.id = (${eventAlias}.detail->>'thing_id')::integer)
    END`
}

/**
 * A lateral join adding `<alias>.feed_room_id`: the feed room an event's note, line,
 * thing or ping is in, or null when the event stays in the list. Rooms are looked up
 * only for those kinds and only while any feed room exists.
 */
export function feedRoomEventLateralSql(eventAlias: string, idsSql: string, alias = 'feed'): string {
  return `CROSS JOIN LATERAL (
    SELECT CASE WHEN ${eventAlias}.kind IN (${FEED_ROOM_EVENT_KIND_SQL})
        AND cardinality(${idsSql}) > 0
      THEN (
        SELECT event_room.id
        FROM (SELECT ${eventRoomSql(eventAlias)} AS id) event_room
        WHERE event_room.id = ANY(${idsSql})
      ) END AS feed_room_id
  ) ${alias}`
}

export const FEED_NEEDS_QUIET_REFUSAL =
  'a feed room must be quiet; send quiet: true with feed: true, or set quiet: true first'
export const FEED_KEEPS_QUIET_REFUSAL =
  'a feed room stays quiet; send feed: false with quiet: false, or set feed: false first'

/**
 * place_edit's feed rule (decision #153): feed true needs quiet true already or in the
 * same edit, and quiet false is refused while feed stays true. Null when the edit keeps it.
 */
export function feedQuietRefusal(
  current: Readonly<{ quiet?: boolean; feed?: boolean }>,
  feed: boolean | undefined,
  quiet: boolean | undefined,
): string | null {
  const nextFeed = feed ?? current.feed === true
  const nextQuiet = quiet ?? current.quiet === true
  if (!nextFeed || nextQuiet) return null
  return feed === true ? FEED_NEEDS_QUIET_REFUSAL : FEED_KEEPS_QUIET_REFUSAL
}

export const FEED_ROOMS_READ_LINE =
  'Feed rooms keep their notes, lines, things and pings out of city-wide lists and mention lookups. '
  + 'Read one in the room: look with its place_id, or read events with that place_id.'

export type LeftOutFeedRooms = Readonly<{
  count: number
  place_ids: readonly number[]
  read?: string
}>

function leftOutFailure(): never {
  throw new TypeError('left-out feed room count is invalid')
}

/**
 * The left_out_feed_rooms object every city-wide list answer carries: how many items
 * it left out because they sit in feed rooms, the feed rooms they sit in (at most 10,
 * lowest id first), and, when any were left out, where to read them.
 */
export function leftOutFeedRooms(count: unknown, placeIds: unknown): LeftOutFeedRooms {
  const total = Number(count ?? 0)
  if (!Number.isSafeInteger(total) || total < 0) leftOutFailure()
  const ids = placeIds == null ? [] : placeIds
  if (!Array.isArray(ids)) leftOutFailure()
  const rooms = ids.map(Number)
  if (rooms.some(id => !Number.isSafeInteger(id) || id < 1)) leftOutFailure()
  if ((total === 0) !== (rooms.length === 0)) leftOutFailure()
  const named = Object.freeze([...new Set(rooms)].sort((a, b) => a - b).slice(0, LEFT_OUT_FEED_ROOM_IDS_MAX))
  return Object.freeze(total === 0
    ? { count: 0, place_ids: named }
    : { count: total, place_ids: named, read: FEED_ROOMS_READ_LINE })
}
