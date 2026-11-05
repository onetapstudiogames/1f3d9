/**
 * The founder ends a resident's label at that resident's own request (decision #169).
 *
 * Label rows stay append-only: an ending is one private row in label_endings per ended
 * label row, and every reader of a resident's labels (me and check_label) skips a row
 * that has one. The public record is one moderation event naming the resident and the
 * request note, never the label, because a resident's labels are private.
 */
import { HANDLE_RE } from './core-primitives.ts'
import { positiveId, worldName } from './input.ts'

export type LabelEndingQuery = (
  text: string,
  params: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>

export type LabelEndingInput = Readonly<{
  residentHandle: string
  label: string
  requestNoteId: number
  sourceThingId: number | null
}>

export type LabelEndingResult =
  | Readonly<{ outcome: 'no_resident' }>
  | Readonly<{ outcome: 'not_their_note' }>
  | Readonly<{ outcome: 'nothing_to_end' }>
  | Readonly<{ outcome: 'ended'; ended: number; eventId: number; at: string }>

/** The public event action a label ending writes; its detail never names the label. */
export const LABEL_ENDING_EVENT_ACTION = 'end_labels'

const LABEL_ENDING_FIELDS = Object.freeze(['resident_handle', 'label', 'request_note_id', 'source_thing_id'])

export const LABEL_ENDING_BODY_RULE = 'send one JSON object with resident_handle, label, request_note_id (the id of that resident\'s own note asking for it), and an optional source_thing_id'

/** Reads the founder's body, or says in caller words what is wrong with it. */
export function parseLabelEndingInput(
  body: unknown,
): Readonly<{ ok: true; input: LabelEndingInput } | { ok: false; error: string }> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: `label ending body must be a JSON object; ${LABEL_ENDING_BODY_RULE}` }
  }
  const record = body as Record<string, unknown>
  const unknownField = Object.keys(record).find(key => !LABEL_ENDING_FIELDS.includes(key))
  if (unknownField !== undefined) {
    return { ok: false, error: `label ending body does not accept ${unknownField}; ${LABEL_ENDING_BODY_RULE}` }
  }
  const residentHandle = typeof record.resident_handle === 'string' ? record.resident_handle : ''
  if (!HANDLE_RE.test(residentHandle)) return { ok: false, error: 'resident_handle must be a resident handle' }
  const label = worldName(record.label)
  if (label === null) return { ok: false, error: 'label must be the world name of the label to end' }
  const requestNoteId = typeof record.request_note_id === 'number' ? positiveId(record.request_note_id) : null
  if (requestNoteId === null) {
    return { ok: false, error: "request_note_id must be the positive id of the resident's own note asking for the label to end" }
  }
  const hasSource = Object.hasOwn(record, 'source_thing_id') && record.source_thing_id !== null
  const sourceThingId = hasSource && typeof record.source_thing_id === 'number'
    ? positiveId(record.source_thing_id)
    : null
  if (hasSource && sourceThingId === null) {
    return { ok: false, error: 'source_thing_id must be a positive thing id, or be omitted to end the label from every source' }
  }
  return { ok: true, input: { residentHandle, label, requestNoteId, sourceThingId } }
}

/**
 * Ends every current row of the label on the resident, optionally only those one thing
 * put on, and writes the public record in the same statement. A row already ended or
 * already expired is not ended again; when nothing is left to end, nothing is written.
 */
export async function endResidentLabels(
  query: LabelEndingQuery,
  founder: Readonly<{ id: number; handle: string }>,
  input: LabelEndingInput,
): Promise<LabelEndingResult> {
  const rows = await query(`
    WITH wearer AS MATERIALIZED (
      SELECT id FROM residents WHERE handle = $1
    ), request AS MATERIALIZED (
      SELECT note.id FROM notes note JOIN wearer ON note.author_id = wearer.id WHERE note.id = $3
    ), ended AS (
      INSERT INTO label_endings (label_id, resident_id, request_note_id, founder_id)
      SELECT active.id, wearer.id, request.id, $5
      FROM active_labels active
      CROSS JOIN wearer CROSS JOIN request
      WHERE active.target_type = 'resident' AND active.target_id = wearer.id
        AND active.label = $2
        AND ($4::int IS NULL OR active.source_thing_id = $4::int)
        AND (active.expires_at IS NULL OR active.expires_at > now())
        AND NOT EXISTS (SELECT 1 FROM label_endings done WHERE done.label_id = active.id)
      ON CONFLICT (label_id) DO NOTHING
      RETURNING label_id
    ), record AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'moderation', $6, jsonb_build_object(
        'action', $7::text, 'resident_id', wearer.id, 'note_id', request.id
      )
      FROM wearer CROSS JOIN request
      WHERE EXISTS (SELECT 1 FROM ended)
      RETURNING id, at
    )
    SELECT EXISTS (SELECT 1 FROM wearer) AS resident_found,
      EXISTS (SELECT 1 FROM request) AS note_found,
      (SELECT count(*)::int FROM ended) AS ended,
      (SELECT id FROM record) AS event_id,
      (SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM record) AS at
  `, [
    input.residentHandle, input.label, input.requestNoteId, input.sourceThingId,
    founder.id, founder.handle, LABEL_ENDING_EVENT_ACTION,
  ])
  const row = rows[0] ?? {}
  if (row.resident_found !== true) return { outcome: 'no_resident' }
  if (row.note_found !== true) return { outcome: 'not_their_note' }
  const ended = Number(row.ended ?? 0)
  if (ended === 0 || row.event_id == null) return { outcome: 'nothing_to_end' }
  return { outcome: 'ended', ended, eventId: Number(row.event_id), at: String(row.at) }
}
