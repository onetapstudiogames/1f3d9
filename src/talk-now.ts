import type { PublicQueryExecutor } from './public-pagination.ts'
import { isoTimestamp } from './timestamp.ts'
import {
  TALK_CHECK_MS,
  TALK_LINE_MARKER_SCAN,
  TALK_NOW_LISTENING_LIMIT,
} from './talk-watch-limits.ts'

export const TALK_NOW_CREDENTIAL_HEADERS = Object.freeze([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-payment',
  'x-api-key',
])

type ListeningResident = Readonly<{
  place_id: number
  resident_id: number
  handle: string
  listening_until: string | null
}>

export type TalkNow = Readonly<{
  line_marker: string
  place_marker: string
  check_interval_ms: number
  listening: readonly ListeningResident[]
  listening_page: Readonly<{
    total_items: number
    returned_items: number
    has_more: boolean
  }>
}>

type TalkNowRow = Readonly<{
  place_id: number | string
  resident_id: number | string
  handle: string
  listening_until: unknown
  total?: number | string
}>

export type ListeningPage = Readonly<{
  listening: readonly ListeningResident[]
  listening_page: TalkNow['listening_page']
}>

function listeningPage(rows: readonly Record<string, unknown>[]): ListeningPage {
  const listening = rows.map(row => {
    const listeningRow = row as TalkNowRow
    return {
      place_id: Number(listeningRow.place_id),
      resident_id: Number(listeningRow.resident_id),
      handle: listeningRow.handle,
      listening_until: isoTimestamp(listeningRow.listening_until),
    }
  })
  const totalItems = Number((rows[0] as TalkNowRow | undefined)?.total ?? 0)
  return {
    listening,
    listening_page: {
      total_items: totalItems,
      returned_items: listening.length,
      has_more: totalItems > listening.length,
    },
  }
}

export function talkNowAnswer(
  markers: Readonly<{ lineMarker: string; placeMarker: string }>,
  rows: readonly Record<string, unknown>[],
): TalkNow {
  return {
    line_marker: markers.lineMarker,
    place_marker: markers.placeMarker,
    check_interval_ms: TALK_CHECK_MS,
    ...listeningPage(rows),
  }
}

// One query for every listening cue that is live now, in place and handle order, with the
// exact total. Human views leave out rooms quiet by their own mark (decision 130); residents
// see quiet rooms, as their place reads already do, and never a retired resident (decision 203).
// Retired rooms are left out of both.
function listeningSql(tag: string, scope: string): string {
  return `/* ${tag} */
    SELECT lease.place_id, lease.resident_id, resident.handle, lease.expires_at AS listening_until,
      count(*) OVER () AS total
    FROM wait_leases lease
    JOIN resident_presence presence ON presence.resident_id = lease.resident_id
      AND presence.current_place_id = lease.place_id AND presence.arrived_at = lease.arrived_at
    JOIN residents resident ON resident.id = lease.resident_id
    JOIN places place ON place.id = lease.place_id
    WHERE lease.expires_at > clock_timestamp()
      AND ${scope} AND place.retired_at IS NULL
    ORDER BY lease.place_id, resident.handle
    LIMIT $1::integer
  `
}

const HUMAN_LISTENING_SQL = listeningSql('public:talk-now-listening', 'NOT place.quiet')
const RESIDENT_LISTENING_SQL = listeningSql('public:residents-listening', "resident.retirement_state <> 'retired'")

// The one query behind GET /api/residents?view=listening (src/residents-listening.ts):
// every live cue, quiet rooms included, no retired resident (decision 203).
export async function readResidentListening(
  execute: PublicQueryExecutor,
  limit: number = TALK_NOW_LISTENING_LIMIT,
): Promise<ListeningPage> {
  return listeningPage(await execute(RESIDENT_LISTENING_SQL, [limit]))
}

// Everything here is already public on GET /api/place/:id (listening_residents) and in the public change log; this read gathers it for human views, leaves rooms with their own quiet mark and retired rooms out of the listening list, as the window resolves quiet at each room's own mark, and records nothing (decisions 82, 122, 130). place_marker is the change id of the newest place edit, already public in the change log; a quiet edit is a place edit, so human views use it to refresh their city view (decision 129). line_marker is a change id that is already committed, so it is safe as an after_change_marker.
export async function readTalkNow(
  execute: PublicQueryExecutor,
  limits: Readonly<{ listeningLimit: number }> = { listeningLimit: TALK_NOW_LISTENING_LIMIT },
): Promise<TalkNow> {
  const markerRows = await execute(`/* public:talk-now-markers */
    SELECT
      (SELECT coalesce(max(change.change_id), 0)::text
        FROM (
          (SELECT event.id FROM events event
            WHERE event.kind = 'line_said'
            ORDER BY event.id DESC LIMIT $1::integer)
          UNION ALL
          (SELECT event.id FROM events event
            WHERE event.kind = 'moderation' AND event.detail->>'target_type' = 'line'
            ORDER BY event.id DESC LIMIT $1::integer)
        ) recent
        JOIN public_change_log change ON change.event_id = recent.id) AS line_marker,
      (SELECT coalesce(max(change.change_id), 0)::text
        FROM (SELECT event.id FROM events event
          WHERE event.kind = 'place_edited'
          ORDER BY event.id DESC LIMIT $1::integer) recent
        JOIN public_change_log change ON change.event_id = recent.id) AS place_marker
  `, [TALK_LINE_MARKER_SCAN])
  const lineMarker = String(markerRows[0]?.line_marker ?? '0')
  const placeMarker = String(markerRows[0]?.place_marker ?? '0')
  const rows = await execute(HUMAN_LISTENING_SQL, [limits.listeningLimit])
  return talkNowAnswer({ lineMarker, placeMarker }, rows)
}
