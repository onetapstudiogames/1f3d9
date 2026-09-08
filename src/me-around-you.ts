import { HANDLE_RE } from './core.ts'
import { PUBLIC_CREDENTIAL_PATTERN_SOURCE } from './credential-safety.ts'
import { parsePublicChangeMarker } from './public-changes.ts'
import { AROUND_YOU_CHANGE_LIMIT } from './me-around-you-limit.ts'

const RECORD_LIMIT = 10
const MAX_RECORD_ID = 2_147_483_647
const CATEGORIES = [
  'notes_in_owned_places', 'new_things_in_owned_places', 'new_agreement_signers', 'mentions',
] as const
type Category = typeof CATEGORIES[number]
type RecordLink = Readonly<{ id: number; change_id: string; href: string; signer?: string }>
type Summary = Readonly<{
  count: number; records: readonly RecordLink[]; has_more: boolean; more_href: string | null
}>
export type AroundYou = Readonly<{
  after_change_id: string | null
  through_change_id: string
  scope: string
}> & (
  Readonly<{ available: true; baseline: boolean }> & Readonly<Record<Category, Summary>>
  | Readonly<{
    available: false; baseline: false; after_change_id: string; message: string; read_href: string
  }> & Readonly<Record<Category, null>>
)

function eventRecordId(field: 'note_id' | 'thing_id' | 'place_id' | 'agreement_id'): string {
  // A nested CASE keeps the casts safe even for malformed historical event detail.
  // Integer joins let the planner use the target tables' primary-key indexes.
  return `CASE WHEN event.detail->>'${field}' ~ '^[1-9][0-9]{0,9}$'
    THEN CASE WHEN (event.detail->>'${field}')::bigint <= ${MAX_RECORD_ID}
      THEN (event.detail->>'${field}')::integer END END AS ${field}`
}

// Embedded only in the private me statement: prior and cutoff are captured in its
// snapshot while the resident lock serializes visits. Public change IDs follow
// commit visibility, unlike record timestamps or sequence-allocated event IDs.
// CASE encloses the entire heavy subquery so baseline/over-limit reads do not
// execute its scans, joins, body matching, or aggregation. The caller's marker
// update is outside this CASE and still commits the captured cutoff.
export const AROUND_YOU_SQL = `(
  SELECT jsonb_build_object(
    'after_change_id', (SELECT last_public_change_id::text FROM prior),
    'through_change_id', cutoff.public_change_id::text
  ) || CASE
    WHEN (SELECT last_public_change_id FROM prior) IS NULL THEN jsonb_build_object(
      'notes_in_owned_places', '{"count":0,"records":[]}'::jsonb,
      'new_things_in_owned_places', '{"count":0,"records":[]}'::jsonb,
      'new_agreement_signers', '{"count":0,"records":[]}'::jsonb,
      'mentions', '{"count":0,"records":[]}'::jsonb
    )
    WHEN cutoff.public_change_id - (SELECT last_public_change_id FROM prior) > ${AROUND_YOU_CHANGE_LIMIT} THEN jsonb_build_object(
      'notes_in_owned_places', NULL, 'new_things_in_owned_places', NULL,
      'new_agreement_signers', NULL, 'mentions', NULL
    )
    ELSE (
  WITH window_events AS MATERIALIZED (
    SELECT change.change_id, event.kind, event.actor,
      ${(['note_id', 'thing_id', 'place_id', 'agreement_id'] as const).map(eventRecordId).join(',\n      ')}
    FROM public_change_log change
    JOIN events event ON event.id = change.event_id
    WHERE change.change_id > (SELECT last_public_change_id FROM prior)
      AND change.change_id <= cutoff.public_change_id
      AND event.kind IN ('note', 'thing_created', 'thing_crafted', 'thing_moved', 'agreement_sign')
    LIMIT ${AROUND_YOU_CHANGE_LIMIT}
  ), window_notes AS MATERIALIZED (
    SELECT note.id, note.place_id, note.body, min(event.change_id) AS change_id
    FROM window_events event
    JOIN notes note ON event.note_id = note.id
    WHERE event.kind = 'note'
      AND coalesce((
        SELECT moderation.action FROM moderation_actions moderation
        WHERE moderation.target_type = 'note' AND moderation.target_id = note.id
        ORDER BY moderation.created_at DESC, moderation.id DESC LIMIT 1
      ), 'restore') <> 'remove'
    GROUP BY note.id
  ), candidates AS MATERIALIZED (
    SELECT 'notes_in_owned_places'::text AS category, note.id, note.change_id,
      NULL::text AS signer
    FROM window_notes note
    JOIN places place ON place.id = note.place_id AND place.owner_id = $1::integer
    UNION ALL
    SELECT 'mentions', note.id, note.change_id, NULL::text
    FROM window_notes note
    JOIN residents reader ON reader.id = $1::integer
    WHERE note.body ~* ('(^|[^a-z0-9-])' || reader.handle || '([^a-z0-9-]|$)')
      AND note.body !~* '${PUBLIC_CREDENTIAL_PATTERN_SOURCE.replace(/'/gu, "''")}'
    UNION ALL
    SELECT 'new_things_in_owned_places', thing.id, min(event.change_id), NULL::text
    FROM window_events event
    JOIN things thing ON event.thing_id = thing.id
    JOIN places place ON event.place_id = place.id AND place.owner_id = $1::integer
    WHERE event.kind IN ('thing_created', 'thing_crafted', 'thing_moved')
      AND thing.withdrawn_at IS NULL
      AND coalesce((
        SELECT moderation.action FROM moderation_actions moderation
        WHERE moderation.target_type = 'thing' AND moderation.target_id = thing.id
        ORDER BY moderation.created_at DESC, moderation.id DESC LIMIT 1
      ), 'restore') <> 'remove'
    GROUP BY thing.id
    UNION ALL
    SELECT 'new_agreement_signers', agreement.id, min(event.change_id), signer.handle
    FROM window_events event
    JOIN agreements agreement ON event.agreement_id = agreement.id
    JOIN agreement_parties party ON party.agreement_id = agreement.id AND party.resident_id = $1::integer
    JOIN residents signer ON signer.handle = event.actor AND signer.id <> $1::integer
    JOIN agreement_signatures signature ON signature.agreement_id = agreement.id AND signature.resident_id = signer.id
    WHERE event.kind = 'agreement_sign'
      AND coalesce((
        SELECT moderation.action FROM moderation_actions moderation
        WHERE moderation.target_type = 'agreement' AND moderation.target_id = agreement.id
        ORDER BY moderation.created_at DESC, moderation.id DESC LIMIT 1
      ), 'restore') <> 'remove'
    GROUP BY agreement.id, signer.handle
  ), numbered AS MATERIALIZED (
    SELECT *, row_number() OVER (PARTITION BY category ORDER BY change_id, id, signer) AS ordinal
    FROM candidates
  ), summaries AS (
    SELECT category, jsonb_build_object(
      'count', count(*),
      'records', jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id', id, 'change_id', change_id::text, 'signer', signer
      )) ORDER BY ordinal) FILTER (WHERE ordinal <= ${RECORD_LIMIT}::integer)
    ) AS summary
    FROM numbered GROUP BY category
  )
  SELECT jsonb_build_object(
    'notes_in_owned_places', coalesce((SELECT summary FROM summaries WHERE category = 'notes_in_owned_places'), '{"count":0,"records":[]}'::jsonb),
    'new_things_in_owned_places', coalesce((SELECT summary FROM summaries WHERE category = 'new_things_in_owned_places'), '{"count":0,"records":[]}'::jsonb),
    'new_agreement_signers', coalesce((SELECT summary FROM summaries WHERE category = 'new_agreement_signers'), '{"count":0,"records":[]}'::jsonb),
    'mentions', coalesce((SELECT summary FROM summaries WHERE category = 'mentions'), '{"count":0,"records":[]}'::jsonb)
  )
    ) END
)`

const SCOPE = `Available counts cover committed public changes after after_change_id through through_change_id, inclusive of the latter, as visible in this read. Intervals containing at most ${AROUND_YOU_CHANGE_LIMIT.toLocaleString('en-US')} city-wide public changes are summarized, including exactly ${AROUND_YOU_CHANGE_LIMIT.toLocaleString('en-US')}. Above ${AROUND_YOU_CHANGE_LIMIT.toLocaleString('en-US')}, available is false, all four category fields are null, and message and read_href identify an unread interval; follow next_since from read_href and stop at through_change_id. The checkpoint still advances, so later me reads do not replay that skipped interval. The first public-checkpoint read sets an available empty baseline without scanning earlier history. Notes are directly in places you currently own. New things are distinct still-active things made, crafted or moved into those places during the interval, even if now elsewhere. New agreement signers are other residents signing agreements you are currently party to. Your own notes and things, and notes containing your own handle, count too; only new agreement signers exclude you. Mentions match your whole handle, case-insensitively, with or without @; notes containing credential-like text are excluded from mentions. Currently moderated-away records are excluded. No bodies are included. Each category lists at most 10 records, oldest change first. When has_more is true, more_href opens the broader public change log, not a filtered category: follow next_since and stop at through_change_id; read the linked records to inspect the remainder. Later ownership, moderation and withdrawals can change those public reads; this summary has no frozen replay.`

function unavailable(): never {
  throw new TypeError('around-you summary is invalid')
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) unavailable()
  return value as Readonly<Record<string, unknown>>
}

function marker(value: unknown): string {
  const parsed = parsePublicChangeMarker(value)
  if (parsed === null) unavailable()
  return parsed
}

function recordLink(value: unknown, category: Category, after: bigint, through: bigint): RecordLink {
  const row = object(value)
  const id = row.id
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || id > MAX_RECORD_ID) unavailable()
  const changeId = marker(row.change_id)
  if (BigInt(changeId) <= after || BigInt(changeId) > through) unavailable()
  if (category === 'new_agreement_signers') {
    if (typeof row.signer !== 'string' || !HANDLE_RE.test(row.signer)) unavailable()
    const cursor = id < MAX_RECORD_ID ? `before_id=${id + 1}&` : ''
    return Object.freeze({ id, change_id: changeId, signer: row.signer, href: `/api/agreements?${cursor}limit=1` })
  }
  const type = category === 'new_things_in_owned_places' ? 'thing' : 'note'
  return Object.freeze({ id, change_id: changeId, href: `/api/${type}/${id}` })
}

function summary(value: unknown, category: Category, after: string | null, through: string): Summary {
  const row = object(value)
  const count = row.count
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) unavailable()
  if (after === null && count !== 0) unavailable()
  if (!Array.isArray(row.records) || row.records.length !== Math.min(count, RECORD_LIMIT)) unavailable()
  const records = Object.freeze(row.records.map(item => recordLink(item, category, BigInt(after ?? through), BigInt(through))))
  for (let index = 1; index < records.length; index += 1) {
    if (BigInt(records[index]!.change_id) <= BigInt(records[index - 1]!.change_id)) unavailable()
  }
  const hasMore = count > records.length
  return Object.freeze({
    count, records, has_more: hasMore,
    more_href: hasMore ? `/api/changes?since=${records.at(-1)!.change_id}&limit=200` : null,
  })
}

export function mapAroundYou(value: unknown): AroundYou {
  const row = object(value)
  const after = row.after_change_id === null ? null : marker(row.after_change_id)
  const through = marker(row.through_change_id)
  if (after !== null && BigInt(after) > BigInt(through)) unavailable()
  if (after !== null && BigInt(through) - BigInt(after) > BigInt(AROUND_YOU_CHANGE_LIMIT)) {
    if (CATEGORIES.some(category => row[category] !== null)) unavailable()
    return Object.freeze({
      after_change_id: after, through_change_id: through, baseline: false, scope: SCOPE,
      available: false,
      message: 'Too much happened since your last visit to summarize here. This interval was not read; follow read_href through through_change_id.',
      read_href: `/api/changes?since=${after}&limit=200`,
      notes_in_owned_places: null, new_things_in_owned_places: null,
      new_agreement_signers: null, mentions: null,
    })
  }
  return Object.freeze({
    after_change_id: after, through_change_id: through, baseline: after === null, scope: SCOPE,
    available: true,
    notes_in_owned_places: summary(row.notes_in_owned_places, 'notes_in_owned_places', after, through),
    new_things_in_owned_places: summary(row.new_things_in_owned_places, 'new_things_in_owned_places', after, through),
    new_agreement_signers: summary(row.new_agreement_signers, 'new_agreement_signers', after, through),
    mentions: summary(row.mentions, 'mentions', after, through),
  })
}
