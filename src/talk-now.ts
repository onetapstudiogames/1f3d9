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

export function talkNowAnswer(lineMarker: string, rows: readonly Record<string, unknown>[]): TalkNow {
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
    line_marker: lineMarker,
    check_interval_ms: TALK_CHECK_MS,
    listening,
    listening_page: {
      total_items: totalItems,
      returned_items: listening.length,
      has_more: totalItems > listening.length,
    },
  }
}

// Everything here is already public on GET /api/place/:id (listening_residents) and in the public change log; this read gathers it for human views, leaves rooms with their own quiet mark and retired rooms out of the listening list, as the window resolves quiet at each room's own mark, and records nothing (decisions 82, 122, 130). line_marker is a change id that is already committed, so it is safe as an after_change_marker.
export async function readTalkNow(
  execute: PublicQueryExecutor,
  limits: Readonly<{ listeningLimit: number }> = { listeningLimit: TALK_NOW_LISTENING_LIMIT },
): Promise<TalkNow> {
  const markerRows = await execute(`/* public:talk-now-line-marker */
    SELECT coalesce(max(change.change_id), 0)::text AS line_marker
    FROM (
      (SELECT event.id FROM events event
        WHERE event.kind = 'line_said'
        ORDER BY event.id DESC LIMIT $1::integer)
      UNION ALL
      (SELECT event.id FROM events event
        WHERE event.kind = 'moderation' AND event.detail->>'target_type' = 'line'
        ORDER BY event.id DESC LIMIT $1::integer)
    ) recent
    JOIN public_change_log change ON change.event_id = recent.id
  `, [TALK_LINE_MARKER_SCAN])
  const lineMarker = String(markerRows[0]?.line_marker ?? '0')
  const rows = await execute(`/* public:talk-now-listening */
    SELECT lease.place_id, lease.resident_id, resident.handle, lease.expires_at AS listening_until,
      count(*) OVER () AS total
    FROM wait_leases lease
    JOIN resident_presence presence ON presence.resident_id = lease.resident_id
      AND presence.current_place_id = lease.place_id AND presence.arrived_at = lease.arrived_at
    JOIN residents resident ON resident.id = lease.resident_id
    JOIN places place ON place.id = lease.place_id
    WHERE lease.expires_at > clock_timestamp()
      AND NOT place.quiet AND place.retired_at IS NULL
    ORDER BY lease.place_id, resident.handle
    LIMIT $1::integer
  `, [limits.listeningLimit])
  return talkNowAnswer(lineMarker, rows)
}
