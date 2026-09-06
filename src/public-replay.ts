import { HANDLE_RE } from './core.ts'
import {
  PUBLIC_RESPONSE_WITHHELD,
  sanitizePublicValue,
  type PublicValueSafety,
} from './credential-safety.ts'
import { sql } from './db.ts'
import { positiveId, publicLabel } from './input.ts'
import { MODERATED_TEXT } from './moderation.ts'
import { moderatePublicEvents, moderatePublicRows } from './moderation-store.ts'
import {
  PublicChangeReadConflictError,
  loadPublicChangeCheckpoint,
  parsePublicChangeMarker,
  readAtStablePublicChangeCheckpoint,
} from './public-changes.ts'
import {
  PUBLIC_EVENT_DETAIL_FIELDS,
  PUBLIC_EVENT_KINDS,
  isPublicSystemEventActor,
} from './public-events.ts'
import {
  PUBLIC_PLACE_COLLECTION_TEXT_MAX_BYTES,
  allowedPublicQuery,
  singlePublicQueryValue,
  utf8TextBytes,
  type PublicQueryExecutor,
} from './public-pagination.ts'
import { isoTimestamp } from './timestamp.ts'

export const PUBLIC_REPLAY_ROW_CEILING = 800
export const PUBLIC_REPLAY_NOTE_LINES_MAX_BYTES = PUBLIC_PLACE_COLLECTION_TEXT_MAX_BYTES
const PUBLIC_REPLAY_NOTE_LINE_CHARACTERS = 200
const PUBLIC_REPLAY_CACHE_MS = 30_000
const POSTGRES_INTEGER_MAX = 2_147_483_647

const PUBLIC_REPLAY_SPAN_HOURS = Object.freeze({
  '1h': 1,
  '2h': 2,
  '6h': 6,
  '24h': 24,
} as const)

export type PublicReplaySpan = keyof typeof PUBLIC_REPLAY_SPAN_HOURS

export type PublicReplayQuery = Readonly<{
  ok: true
  span: PublicReplaySpan
}>

export type PublicReplayQueryResult = PublicReplayQuery | Readonly<{
  ok: false
  error: string
}>

type PublicReplayModerator = <T extends object>(
  targetType: 'note',
  rows: readonly T[],
) => Promise<readonly T[]>

type PublicReplayEventModerator = <T extends object>(rows: readonly T[]) => Promise<readonly T[]>

type PublicReplayTimelineRow = Readonly<{
  change_id: string
  event_id: number
  at: string
  kind: string
  actor: string
  detail: Readonly<Record<string, unknown>>
  line?: string
  line_cut?: boolean
}>

export type PublicReplay = Readonly<{
  span: PublicReplaySpan
  checkpoint: string
  window_end: string
  window_start: string
  row_ceiling: number
  complete: boolean
  map: Readonly<{ places: readonly Readonly<Record<string, unknown>>[] }>
  start: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  timeline: readonly PublicReplayTimelineRow[]
  counts: Readonly<Record<string, Readonly<{ residents: number; things: number }>>>
}>

const executeReplayQuery: PublicQueryExecutor = async (text, params) =>
  await sql.query(text, [...params]) as readonly Record<string, unknown>[]

const moderateReplayNotes: PublicReplayModerator = async (targetType, rows) =>
  await moderatePublicRows(targetType, rows)
const moderateReplayEvents: PublicReplayEventModerator = async rows =>
  await moderatePublicEvents(rows)

export function parsePublicReplayQuery(
  query: Readonly<Record<string, readonly string[]>>,
): PublicReplayQueryResult {
  const allowed = allowedPublicQuery(query, ['span'])
  if (!allowed.ok) return allowed
  const value = singlePublicQueryValue(query, 'span')
  if (!value.ok) return value
  if (value.value === null || !Object.hasOwn(PUBLIC_REPLAY_SPAN_HOURS, value.value)) {
    return { ok: false, error: 'span must be one of 1h, 2h, 6h, or 24h' }
  }
  return Object.freeze({ ok: true, span: value.value as PublicReplaySpan })
}

export function noteTimelineFields(
  row: Readonly<{ id: unknown; body: unknown }>,
): Readonly<{ id: number; line: string; line_cut: boolean }> {
  const id = positiveId(row.id)
  if (id === null || typeof row.body !== 'string') throw new Error('invalid public replay note row')
  const firstLine = row.body.split(/\r\n|[\n\r\u2028\u2029]/u, 1)[0] ?? ''
  const line = Array.from(firstLine).slice(0, PUBLIC_REPLAY_NOTE_LINE_CHARACTERS).join('')
  return Object.freeze({ id, line, line_cut: line !== row.body })
}

const REPLAY_WINDOW_SQL = `
  /* public:replay-window */
  SELECT event.at AS window_end
  FROM public_change_state state
  JOIN public_change_log change ON change.change_id = state.current_change_id
  JOIN events event ON event.id = change.event_id
  WHERE state.singleton = true
`

const REPLAY_MAP_SQL = `
  /* public:replay-map */
  SELECT place.id, place.parent_id,
    CASE WHEN latest_moderation.action = 'remove' THEN $1::text ELSE place.name END AS name,
    place.owner_id, owner.handle AS owner,
    CASE WHEN latest_moderation.action = 'remove' OR place.drawing IS NULL
      THEN NULL::text ELSE state.current_change_id::text END AS drawing_marker,
    place.quiet
  FROM places place
  CROSS JOIN public_change_state state
  LEFT JOIN residents owner ON owner.id = place.owner_id
  LEFT JOIN LATERAL (
    SELECT moderation.action
    FROM moderation_actions moderation
    WHERE moderation.target_type = 'place' AND moderation.target_id = place.id
    ORDER BY moderation.created_at DESC, moderation.id DESC
    LIMIT 1
  ) latest_moderation ON TRUE
  WHERE state.singleton = true AND place.retired_at IS NULL
  ORDER BY place.id
`

const REPLAY_TIMELINE_DETAIL_FIELD_SQL = PUBLIC_EVENT_DETAIL_FIELDS
  .map(field => `'${field}'`)
  .join(', ')

const REPLAY_TIMELINE_SQL = `
  /* public:replay-timeline */
  SELECT change.change_id::text AS change_id, event.id AS event_id,
    event.at, event.kind, event.actor,
    coalesce((
      SELECT jsonb_object_agg(field.key, field.value)
      FROM jsonb_each(event.detail) field
      WHERE field.key = ANY(ARRAY[${REPLAY_TIMELINE_DETAIL_FIELD_SQL}]::text[])
        AND jsonb_typeof(field.value) IN ('null', 'string', 'number', 'boolean')
    ), '{}'::jsonb) AS detail,
    note.id AS note_id,
    left(split_part(replace(replace(replace(replace(
      note.body, E'\\r\\n', E'\\n'), E'\\r', E'\\n'), chr(8232), E'\\n'), chr(8233), E'\\n'),
      E'\\n', 1), ${PUBLIC_REPLAY_NOTE_LINE_CHARACTERS}) AS note_body,
    note.body IS DISTINCT FROM left(split_part(replace(replace(replace(replace(
      note.body, E'\\r\\n', E'\\n'), E'\\r', E'\\n'), chr(8232), E'\\n'), chr(8233), E'\\n'),
      E'\\n', 1), ${PUBLIC_REPLAY_NOTE_LINE_CHARACTERS}) AS note_line_cut
  FROM public_change_log change
  JOIN public_change_state state ON state.singleton = true
    AND change.change_id <= state.current_change_id
  JOIN public_change_log checkpoint_change
    ON checkpoint_change.change_id = state.current_change_id
  JOIN events checkpoint_event ON checkpoint_event.id = checkpoint_change.event_id
  JOIN events event ON event.id = change.event_id
  LEFT JOIN notes note ON event.kind = 'note'
    AND event.detail->>'note_id' ~ '^[1-9][0-9]{0,9}$'
    AND (event.detail->>'note_id')::bigint <= 2147483647
    AND note.id = (event.detail->>'note_id')::integer
  WHERE event.at >= checkpoint_event.at - $1::integer * interval '1 hour'
    AND event.kind = ANY($2::text[])
  ORDER BY change.change_id DESC
  LIMIT $3::integer
`

const REPLAY_START_SQL = `
  /* public:replay-start */
  WITH span_events AS MATERIALIZED (
    SELECT change.change_id, event.id AS event_id, event.kind, event.actor, event.detail
    FROM public_change_log change
    JOIN public_change_state state ON state.singleton = true
      AND change.change_id <= state.current_change_id
    JOIN public_change_log checkpoint_change
      ON checkpoint_change.change_id = state.current_change_id
    JOIN events checkpoint_event ON checkpoint_event.id = checkpoint_change.event_id
    JOIN events event ON event.id = change.event_id
    WHERE event.at >= checkpoint_event.at - $1::integer * interval '1 hour'
      AND event.kind = ANY($2::text[])
  ), resident_activity AS MATERIALIZED (
    SELECT resident.id, resident.handle
    FROM residents resident
    WHERE EXISTS (
      SELECT 1 FROM span_events event
      WHERE event.actor = resident.handle OR (
        event.detail->>'resident_id' ~ '^[1-9][0-9]{0,9}$'
        AND (event.detail->>'resident_id')::bigint <= 2147483647
        AND (event.detail->>'resident_id')::integer = resident.id
      )
    )
  ), thing_activity AS MATERIALIZED (
    SELECT DISTINCT referenced.id
    FROM span_events event
    CROSS JOIN LATERAL (VALUES
      (CASE WHEN event.detail->>'thing_id' ~ '^[1-9][0-9]{0,9}$'
        AND (event.detail->>'thing_id')::bigint <= 2147483647
        THEN (event.detail->>'thing_id')::integer END),
      (CASE WHEN event.detail->>'source_thing_id' ~ '^[1-9][0-9]{0,9}$'
        AND (event.detail->>'source_thing_id')::bigint <= 2147483647
        THEN (event.detail->>'source_thing_id')::integer END),
      (CASE WHEN event.detail->>'asset_type' = 'thing'
        AND event.detail->>'asset_id' ~ '^[1-9][0-9]{0,9}$'
        AND (event.detail->>'asset_id')::bigint <= 2147483647
        THEN (event.detail->>'asset_id')::integer END),
      (CASE WHEN event.detail->>'type' = 'thing'
        AND event.detail->>'id' ~ '^[1-9][0-9]{0,9}$'
        AND (event.detail->>'id')::bigint <= 2147483647
        THEN (event.detail->>'id')::integer END)
    ) referenced(id)
    WHERE referenced.id IS NOT NULL
  )
  SELECT 'resident'::text AS entity_type, resident.id, resident.handle,
    CASE
      WHEN registered.event_id IS NOT NULL THEN NULL::integer
      WHEN first_move.event_id IS NOT NULL THEN first_move.place_id
      ELSE presence.current_place_id
    END AS place_id,
    CASE WHEN registered.event_id IS NULL THEN first_move.event_id END AS origin_event_id,
    CASE WHEN registered.event_id IS NOT NULL THEN 'register'::text
      WHEN first_move.event_id IS NULL AND presence.current_place_id IS NULL THEN 'unknown'::text
      ELSE NULL::text END AS origin,
    NULL::timestamptz AS withdrawn_at
  FROM resident_activity resident
  LEFT JOIN resident_presence presence ON presence.resident_id = resident.id
  LEFT JOIN LATERAL (
    SELECT event.event_id
    FROM span_events event
    WHERE event.kind = 'register' AND event.actor = resident.handle
    ORDER BY event.change_id ASC LIMIT 1
  ) registered ON TRUE
  LEFT JOIN LATERAL (
    SELECT event.event_id, (event.detail->>'from_place_id')::integer AS place_id
    FROM span_events event
    WHERE event.kind = 'action' AND event.actor = resident.handle
      AND event.detail->>'status' = 'applied'
      AND event.detail->>'action' IN ('move', 'go_home')
      AND event.detail->>'from_place_id' ~ '^[1-9][0-9]{0,9}$'
      AND (event.detail->>'from_place_id')::bigint <= 2147483647
      AND event.detail->>'to_place_id' ~ '^[1-9][0-9]{0,9}$'
      AND (event.detail->>'to_place_id')::bigint <= 2147483647
    ORDER BY event.change_id ASC LIMIT 1
  ) first_move ON TRUE
  UNION ALL
  SELECT 'thing'::text AS entity_type, thing.id, NULL::text AS handle,
    CASE
      WHEN created.event_id IS NOT NULL THEN NULL::integer
      WHEN first_move.event_id IS NOT NULL THEN first_move.place_id
      ELSE thing.place_id
    END AS place_id,
    CASE WHEN created.event_id IS NULL THEN first_move.event_id END AS origin_event_id,
    CASE WHEN created.event_id IS NOT NULL OR (
      first_move.event_id IS NULL AND thing.place_id IS NULL
    ) THEN 'unknown'::text ELSE NULL::text END AS origin,
    thing.withdrawn_at
  FROM things thing
  JOIN thing_activity activity ON activity.id = thing.id
  LEFT JOIN LATERAL (
    SELECT event.event_id
    FROM span_events event
    WHERE event.kind IN ('thing_created', 'thing_crafted')
      AND event.detail->>'thing_id' = thing.id::text
    ORDER BY event.change_id ASC LIMIT 1
  ) created ON TRUE
  LEFT JOIN LATERAL (
    SELECT event.event_id, (event.detail->>'from_place_id')::integer AS place_id
    FROM span_events event
    WHERE event.kind = 'thing_moved'
      AND event.detail->>'thing_id' = thing.id::text
      AND event.detail->>'from_place_id' ~ '^[1-9][0-9]{0,9}$'
      AND (event.detail->>'from_place_id')::bigint <= 2147483647
      AND event.detail->>'place_id' ~ '^[1-9][0-9]{0,9}$'
      AND (event.detail->>'place_id')::bigint <= 2147483647
    ORDER BY event.change_id ASC LIMIT 1
  ) first_move ON TRUE
  WHERE thing.withdrawn_at IS NULL
  ORDER BY entity_type, id
`

const REPLAY_COUNTS_SQL = `
  /* public:replay-counts */
  SELECT place.id AS place_id,
    count(presence.resident_id)::integer AS residents,
    totals.thing_items AS things
  FROM places place
  JOIN place_reading_totals totals ON totals.place_id = place.id
  LEFT JOIN resident_presence presence ON presence.current_place_id = place.id
  WHERE place.retired_at IS NULL
  GROUP BY place.id, totals.thing_items
  ORDER BY place.id
`

function safeCount(value: unknown, field: string): number {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`public replay ${field} is invalid`)
  return count
}

function nullablePositiveId(value: unknown): number | null {
  if (value == null) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 && id <= POSTGRES_INTEGER_MAX ? id : null
}

function replayMap(rows: readonly Record<string, unknown>[]) {
  return Object.freeze(rows.map(row => {
    const id = positiveId(row.id)
    const parentId = row.parent_id == null ? null : positiveId(row.parent_id)
    const ownerId = row.owner_id == null ? null : positiveId(row.owner_id)
    const name = publicLabel(row.name)
    const owner = row.owner == null ? null : String(row.owner)
    const drawingMarker = row.drawing_marker == null
      ? null
      : parsePublicChangeMarker(String(row.drawing_marker))
    if (
      id === null || name === null || (row.parent_id != null && parentId === null)
      || (row.owner_id != null && ownerId === null) || (owner !== null && !HANDLE_RE.test(owner))
      || (row.drawing_marker != null && drawingMarker === null)
    ) throw new Error('invalid public replay map row')
    return Object.freeze({
      id,
      parent_id: parentId,
      name,
      owner_id: ownerId,
      owner,
      drawing_marker: drawingMarker,
      quiet: row.quiet === true,
    })
  }))
}

function replayDetail(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({})
  const allowed = new Set<string>(PUBLIC_EVENT_DETAIL_FIELDS)
  return Object.freeze(Object.fromEntries(Object.entries(value).filter(([key, nested]) => (
    allowed.has(key) && (
      nested === null || typeof nested === 'string' || typeof nested === 'number'
      || typeof nested === 'boolean'
    )
  ))))
}

function replayTimelineRow(row: Readonly<Record<string, unknown>>): PublicReplayTimelineRow | null {
  const changeId = parsePublicChangeMarker(String(row.change_id ?? ''))
  const eventId = positiveId(row.event_id)
  if (
    changeId === null || eventId === null
    || typeof row.kind !== 'string' || !PUBLIC_EVENT_KINDS.includes(row.kind)
    || typeof row.actor !== 'string'
    || !(HANDLE_RE.test(row.actor) || isPublicSystemEventActor(row.actor))
  ) return null
  const at = isoTimestamp(row.at)
  if (at === null) return null
  return Object.freeze({
    change_id: changeId,
    event_id: eventId,
    at,
    kind: row.kind,
    actor: row.actor,
    detail: replayDetail(row.detail),
  })
}

function replayStart(
  rows: readonly Record<string, unknown>[],
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  const entries = rows.flatMap(row => {
    if (row.entity_type === 'thing' && row.withdrawn_at != null) return []
    const id = positiveId(row.id)
    if (id === null || (row.entity_type !== 'resident' && row.entity_type !== 'thing')) {
      throw new Error('invalid public replay start row')
    }
    const placeId = nullablePositiveId(row.place_id)
    const key = `${row.entity_type}:${id}`
    const originEventId = nullablePositiveId(row.origin_event_id)
    const origin = row.origin === 'register' || row.origin === 'unknown' ? row.origin : null
    const value = Object.freeze({
      place_id: placeId,
      ...(originEventId === null ? {} : { origin_event_id: originEventId }),
      ...(origin === null ? (placeId === null ? { origin: 'unknown' as const } : {}) : { origin }),
    })
    return [[key, value] as const]
  })
  return Object.freeze(Object.fromEntries(entries))
}

function replayCounts(rows: readonly Record<string, unknown>[]) {
  return Object.freeze(Object.fromEntries(rows.map(row => {
    const placeId = positiveId(row.place_id)
    if (placeId === null) throw new Error('invalid public replay count row')
    return [String(placeId), Object.freeze({
      residents: safeCount(row.residents, 'resident count'),
      things: safeCount(row.things, 'thing count'),
    })]
  })))
}

function compareChangeId(
  left: Readonly<{ change_id: string }>,
  right: Readonly<{ change_id: string }>,
): number {
  const a = BigInt(left.change_id)
  const b = BigInt(right.change_id)
  return a < b ? -1 : a > b ? 1 : 0
}

function invalidModeratedReplayEvents(): never {
  throw new Error('invalid public replay moderated event rows')
}

function sanitizeReplayValues(values: readonly unknown[]): Readonly<{
  values: readonly unknown[]
  changed: boolean
  withheld: boolean
}> {
  const guarded = values.map(value => sanitizePublicValue(value))
  return Object.freeze({
    values: Object.freeze(guarded.map(result => result.value)),
    changed: guarded.some(result => result.changed),
    withheld: guarded.some(result => result.withheld),
  })
}

export function sanitizePublicReplay(replay: PublicReplay): PublicValueSafety {
  const metadata = sanitizePublicValue({
    span: replay.span,
    checkpoint: replay.checkpoint,
    window_end: replay.window_end,
    window_start: replay.window_start,
    row_ceiling: replay.row_ceiling,
    complete: replay.complete,
  })
  const map = sanitizeReplayValues(replay.map.places)
  const startEntries = Object.entries(replay.start)
  const start = sanitizeReplayValues(startEntries.map(([, value]) => value))
  const timeline = sanitizeReplayValues(replay.timeline)
  const countEntries = Object.entries(replay.counts)
  const counts = sanitizeReplayValues(countEntries.map(([, value]) => value))
  const guarded = [metadata, map, start, timeline, counts]
  if (guarded.some(result => result.withheld)) {
    return Object.freeze({ value: PUBLIC_RESPONSE_WITHHELD, changed: true, withheld: true })
  }
  return Object.freeze({
    value: Object.freeze({
      ...(metadata.value as Record<string, unknown>),
      map: Object.freeze({ places: map.values }),
      start: Object.freeze(Object.fromEntries(startEntries.map(([key], index) => [
        key, start.values[index],
      ]))),
      timeline: timeline.values,
      counts: Object.freeze(Object.fromEntries(countEntries.map(([key], index) => [
        key, counts.values[index],
      ]))),
    }),
    changed: guarded.some(result => result.changed),
    withheld: false,
  })
}

export async function buildPublicReplay(
  execute: PublicQueryExecutor,
  query: PublicReplayQuery,
  moderate: PublicReplayModerator = moderateReplayNotes,
  moderateEvents: PublicReplayEventModerator = moderateReplayEvents,
): Promise<PublicReplay> {
  const stable = await readAtStablePublicChangeCheckpoint(execute, null, async () => {
    const windowRows = await execute(REPLAY_WINDOW_SQL, [])
    const windowEnd = isoTimestamp(windowRows[0]?.window_end)
    if (windowEnd === null) throw new Error('public replay is unavailable until the first public change')
    const windowStart = new Date(
      Date.parse(windowEnd) - PUBLIC_REPLAY_SPAN_HOURS[query.span] * 60 * 60 * 1_000,
    ).toISOString()
    const [mapRows, rawTimelineRows, startRows, countRows] = await Promise.all([
      execute(REPLAY_MAP_SQL, [MODERATED_TEXT]),
      execute(REPLAY_TIMELINE_SQL, [
        PUBLIC_REPLAY_SPAN_HOURS[query.span], [...PUBLIC_EVENT_KINDS],
        PUBLIC_REPLAY_ROW_CEILING + 1,
      ]),
      execute(REPLAY_START_SQL, [PUBLIC_REPLAY_SPAN_HOURS[query.span], [...PUBLIC_EVENT_KINDS]]),
      execute(REPLAY_COUNTS_SQL, []),
    ])
    const sortedRows = [...rawTimelineRows]
      .flatMap(row => {
        const timelineRow = replayTimelineRow(row)
        return timelineRow === null ? [] : [{ timelineRow, raw: row }]
      })
      .sort((left, right) => compareChangeId(left.timelineRow, right.timelineRow))
    const complete = sortedRows.length <= PUBLIC_REPLAY_ROW_CEILING
    const selectedRows = sortedRows.slice(-PUBLIC_REPLAY_ROW_CEILING)
    const moderatedTimeline = await moderateEvents(selectedRows.map(row => row.timelineRow))
    if (moderatedTimeline.length !== selectedRows.length) {
      invalidModeratedReplayEvents()
    }
    const publicRows = selectedRows.map((row, index) => {
      const normalized = replayTimelineRow(
        moderatedTimeline[index] as Readonly<Record<string, unknown>>,
      )
      if (
        normalized === null || normalized.change_id !== row.timelineRow.change_id
        || normalized.event_id !== row.timelineRow.event_id
      ) invalidModeratedReplayEvents()
      return Object.freeze({ raw: row.raw, timelineRow: normalized })
    })
    const noteRows = publicRows.flatMap(({ raw, timelineRow }) => (
      timelineRow.kind === 'note' && nullablePositiveId(raw.note_id) !== null
        && typeof raw.note_body === 'string'
        ? [{ id: Number(raw.note_id), body: raw.note_body }]
        : []
    ))
    const moderatedNotes = await moderate('note', noteRows)
    const notesById = new Map(moderatedNotes.map(row => {
      const fields = noteTimelineFields(row as Readonly<{ id: unknown; body: unknown }>)
      const source = noteRows.find(note => note.id === fields.id)
      const raw = publicRows.find(candidate => nullablePositiveId(candidate.raw.note_id) === fields.id)?.raw
      const moderatedBody = typeof (row as { body?: unknown }).body === 'string'
        ? (row as { body: string }).body
        : null
      const moderated = source?.body !== moderatedBody
      return [fields.id, Object.freeze({
        ...fields,
        line_cut: moderated ? fields.line_cut : fields.line_cut || raw?.note_line_cut === true,
      })] as const
    }))
    const timeline = Object.freeze(publicRows.map(({ timelineRow, raw }) => {
      const noteId = nullablePositiveId(raw.note_id)
      const note = noteId === null ? undefined : notesById.get(noteId)
      return Object.freeze({
        ...timelineRow,
        ...(note === undefined ? {} : { line: note.line, line_cut: note.line_cut }),
      })
    }))
    if (utf8TextBytes(timeline, 'line') > PUBLIC_REPLAY_NOTE_LINES_MAX_BYTES) {
      throw new Error('public replay note-line byte ceiling was exceeded')
    }
    return Object.freeze({
      span: query.span,
      window_end: windowEnd,
      window_start: windowStart,
      row_ceiling: PUBLIC_REPLAY_ROW_CEILING,
      complete,
      map: Object.freeze({ places: replayMap(mapRows) }),
      start: replayStart(startRows),
      timeline,
      counts: replayCounts(countRows),
    })
  })
  return Object.freeze({
    span: stable.value.span,
    checkpoint: stable.changeMarker,
    window_end: stable.value.window_end,
    window_start: stable.value.window_start,
    row_ceiling: stable.value.row_ceiling,
    complete: stable.value.complete,
    map: stable.value.map,
    start: stable.value.start,
    timeline: stable.value.timeline,
    counts: stable.value.counts,
  })
}

type ReplayCacheEntry = Readonly<{
  expiresAt: number
  pending: Promise<PublicReplay>
}>

const replayCache = new Map<string, ReplayCacheEntry>()

export async function cachedPublicReplay(query: PublicReplayQuery): Promise<PublicReplay> {
  const checkpoint = await loadPublicChangeCheckpoint(executeReplayQuery)
  const key = `${query.span}:${checkpoint}`
  const now = Date.now()
  const cached = replayCache.get(key)
  if (cached && cached.expiresAt > now) return cached.pending

  const pending = buildPublicReplay(executeReplayQuery, query)
  replayCache.set(key, Object.freeze({ expiresAt: now + PUBLIC_REPLAY_CACHE_MS, pending }))
  try {
    const replay = await pending
    const actualKey = `${query.span}:${replay.checkpoint}`
    for (const heldKey of replayCache.keys()) {
      if (heldKey.startsWith(`${query.span}:`) && heldKey !== actualKey) replayCache.delete(heldKey)
    }
    replayCache.set(actualKey, Object.freeze({
      expiresAt: now + PUBLIC_REPLAY_CACHE_MS,
      pending: Promise.resolve(replay),
    }))
    return replay
  } catch (error) {
    if (replayCache.get(key)?.pending === pending) replayCache.delete(key)
    if (error instanceof PublicChangeReadConflictError) throw error
    throw error
  }
}
