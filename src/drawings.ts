import type { Context, Hono } from 'hono'
import { err, type Resident } from './core.ts'
import {
  DRAWING_BODY_MAX_BYTES,
  drawingPresentationState,
  drawingRows,
  parseDrawing,
  parseDrawingWrite,
  readBoundedJsonObject,
  type Drawing,
  type DrawingState,
} from './drawing.ts'
import { renderDrawingThumbnailPng } from './drawing-thumbnail.ts'
import { parsePublicChangeMarker } from './public-changes.ts'

const DRAWING_RECORD_TYPES = Object.freeze(['place', 'resident', 'kind', 'thing'] as const)
const DRAWING_RECORD_TYPE_SET: ReadonlySet<string> = new Set(DRAWING_RECORD_TYPES)
const DRAWING_STATES: ReadonlySet<string> = new Set([
  'undrawn', 'refused', 'in_progress', 'complete',
])
const DRAWING_SOURCES: ReadonlySet<string> = new Set([
  'none', 'resident', 'place', 'thing', 'kind_base', 'kind_variant',
])
const DRAWING_HISTORY_DEFAULT = 20
const DRAWING_HISTORY_MAX = 50

export type DrawingRecordType = typeof DRAWING_RECORD_TYPES[number]

export interface DrawingRouteDatabase {
  readonly query: (
    text: string,
    params: readonly unknown[],
  ) => Promise<readonly Record<string, unknown>[]>
}

export interface DrawingRouteDependencies {
  readonly database: DrawingRouteDatabase
  readonly authenticate: (context: Context) => Promise<Resident | null>
}

type DrawingSource = 'none' | 'place' | 'resident' | 'thing' | 'kind_base' | 'kind_variant'

interface StoredDrawingRow extends Record<string, unknown> {
  id: number
  drawing: unknown
  drawing_state: unknown
  drawing_description: unknown
  source: unknown
  kind_id: unknown
  kind_name?: unknown
  revision: unknown
  variant_name: unknown
}

type PublicDrawingSnapshot = Readonly<{
  state: DrawingState
  presentation_state: DrawingState | 'blank'
  description: string | null
  drawing: Drawing | null
  rows: readonly string[] | null
  source: DrawingSource
  kind_id?: number
  kind_name?: string
  revision?: number
  variant_name?: string
}>

const DRAWING_READ_SQL: Readonly<Record<DrawingRecordType, string>> = Object.freeze({
  place: `
    /* drawing:place-read */
    SELECT place.id, place.drawing, place.drawing_state, place.drawing_description,
      CASE WHEN place.drawing_state = 'undrawn' THEN 'none' ELSE 'place' END AS source,
      NULL::integer AS kind_id, NULL::text AS kind_name,
      NULL::integer AS revision, NULL::text AS variant_name
    FROM places place
    LEFT JOIN LATERAL (
      SELECT action
      FROM moderation_actions
      WHERE target_type = 'place' AND target_id = place.id
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) moderation ON TRUE
    WHERE place.id = $1::integer
      AND coalesce(moderation.action, 'restore') <> 'remove'
  `,
  resident: `
    /* drawing:resident-read */
    SELECT resident.id, resident.drawing,
      resident.drawing_state, resident.drawing_description,
      CASE WHEN resident.drawing_state = 'undrawn' THEN 'none' ELSE 'resident' END AS source,
      NULL::integer AS kind_id, NULL::text AS kind_name,
      NULL::integer AS revision, NULL::text AS variant_name
    FROM residents resident
    LEFT JOIN LATERAL (
      SELECT action
      FROM moderation_actions
      WHERE target_type = 'resident' AND target_id = resident.id
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) moderation ON TRUE
    WHERE resident.id = $1::integer
      AND coalesce(moderation.action, 'restore') <> 'remove'
  `,
  kind: `
    /* drawing:kind-read */
    SELECT kind.id, revision.drawing,
      revision.drawing_state, revision.drawing_description,
      CASE WHEN revision.drawing_state = 'undrawn' THEN 'none' ELSE 'kind_base' END AS source,
      kind.id AS kind_id, kind.name AS kind_name,
      revision.revision, NULL::text AS variant_name
    FROM kinds kind
    JOIN kind_revisions revision
      ON revision.kind_id = kind.id AND revision.revision = kind.current_revision
    LEFT JOIN LATERAL (
      SELECT action
      FROM moderation_actions
      WHERE target_type = 'kind' AND target_id = kind.id
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) moderation ON TRUE
    WHERE kind.id = $1::integer
      AND coalesce(moderation.action, 'restore') <> 'remove'
  `,
  thing: `
    /* drawing:thing-read */
    SELECT thing.id,
      CASE
        WHEN thing.kind_id IS NULL THEN thing.drawing
        WHEN thing.drawing_state = 'refused' THEN NULL::jsonb
        WHEN coalesce(kind_moderation.action, 'restore') = 'remove' THEN NULL::jsonb
        WHEN selected.variant IS NOT NULL THEN selected.variant -> 'drawing'
        ELSE revision.drawing
      END AS drawing,
      CASE
        WHEN thing.kind_id IS NULL THEN thing.drawing_state
        WHEN thing.drawing_state = 'refused' THEN 'refused'
        WHEN coalesce(kind_moderation.action, 'restore') = 'remove' THEN 'undrawn'
        WHEN selected.variant IS NOT NULL
          THEN coalesce(selected.variant ->> 'state', selected.variant ->> 'drawing_state')
        ELSE coalesce(revision.drawing_state, 'undrawn')
      END AS drawing_state,
      CASE
        WHEN thing.kind_id IS NULL THEN thing.drawing_description
        WHEN thing.drawing_state = 'refused' THEN thing.drawing_description
        WHEN coalesce(kind_moderation.action, 'restore') = 'remove' THEN NULL::text
        WHEN selected.variant IS NOT NULL
          THEN coalesce(selected.variant ->> 'description', selected.variant ->> 'drawing_description')
        ELSE revision.drawing_description
      END AS drawing_description,
      CASE
        WHEN thing.kind_id IS NULL AND thing.drawing_state = 'undrawn' THEN 'none'
        WHEN thing.kind_id IS NULL THEN 'thing'
        WHEN thing.drawing_state = 'refused' THEN 'thing'
        WHEN coalesce(kind_moderation.action, 'restore') = 'remove' THEN 'none'
        WHEN selected.variant IS NOT NULL THEN 'kind_variant'
        WHEN coalesce(revision.drawing_state, 'undrawn') = 'undrawn' THEN 'none'
        ELSE 'kind_base'
      END AS source,
      CASE
        WHEN coalesce(kind_moderation.action, 'restore') = 'remove' THEN NULL
        WHEN thing.drawing_state = 'refused' THEN thing.kind_id
        WHEN selected.variant IS NOT NULL THEN thing.kind_id
        WHEN coalesce(revision.drawing_state, 'undrawn') <> 'undrawn' THEN thing.kind_id
        ELSE NULL
      END AS kind_id,
      CASE
        WHEN coalesce(kind_moderation.action, 'restore') = 'remove' THEN NULL
        WHEN thing.kind_id IS NOT NULL AND thing.drawing_state = 'undrawn'
          AND (selected.variant IS NOT NULL OR coalesce(revision.drawing_state, 'undrawn') <> 'undrawn')
          THEN kind.name
        ELSE NULL
      END AS kind_name,
      CASE
        WHEN coalesce(kind_moderation.action, 'restore') = 'remove' THEN NULL
        WHEN thing.drawing_state = 'refused' THEN thing.current_revision
        WHEN selected.variant IS NOT NULL THEN thing.current_revision
        WHEN coalesce(revision.drawing_state, 'undrawn') <> 'undrawn' THEN thing.current_revision
        ELSE NULL
      END AS revision,
      CASE WHEN thing.drawing_state = 'undrawn'
          AND selected.variant IS NOT NULL
          AND coalesce(kind_moderation.action, 'restore') <> 'remove'
        THEN thing.drawing_variant_name ELSE NULL END AS variant_name
    FROM things thing
    LEFT JOIN kinds kind ON kind.id = thing.kind_id
    LEFT JOIN kind_revisions revision
      ON revision.kind_id = thing.kind_id AND revision.revision = thing.current_revision
    LEFT JOIN LATERAL (
      SELECT candidate AS variant
      FROM jsonb_array_elements(coalesce(revision.drawing_variants, '[]'::jsonb)) candidate
      WHERE candidate ->> 'name' = thing.drawing_variant_name
      LIMIT 1
    ) selected ON TRUE
    LEFT JOIN LATERAL (
      SELECT action
      FROM moderation_actions
      WHERE target_type = 'thing' AND target_id = thing.id
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) moderation ON TRUE
    LEFT JOIN LATERAL (
      SELECT action
      FROM moderation_actions
      WHERE target_type = 'kind' AND target_id = thing.kind_id
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) kind_moderation ON TRUE
    WHERE thing.id = $1::integer AND thing.withdrawn_at IS NULL
      AND coalesce(moderation.action, 'restore') <> 'remove'
  `,
})

const DRAWING_HISTORY_VISIBLE_SQL: Readonly<Record<DrawingRecordType, string>> = Object.freeze({
  place: `
    SELECT place.id
    FROM places place
    LEFT JOIN LATERAL (
      SELECT action FROM moderation_actions
      WHERE target_type = 'place' AND target_id = place.id
      ORDER BY created_at DESC, id DESC LIMIT 1
    ) moderation ON TRUE
    WHERE place.id = $1::integer
      AND coalesce(moderation.action, 'restore') <> 'remove'
  `,
  resident: `
    SELECT resident.id
    FROM residents resident
    LEFT JOIN LATERAL (
      SELECT action FROM moderation_actions
      WHERE target_type = 'resident' AND target_id = resident.id
      ORDER BY created_at DESC, id DESC LIMIT 1
    ) moderation ON TRUE
    WHERE resident.id = $1::integer
      AND coalesce(moderation.action, 'restore') <> 'remove'
  `,
  kind: `
    SELECT kind.id
    FROM kinds kind
    LEFT JOIN LATERAL (
      SELECT action FROM moderation_actions
      WHERE target_type = 'kind' AND target_id = kind.id
      ORDER BY created_at DESC, id DESC LIMIT 1
    ) moderation ON TRUE
    WHERE kind.id = $1::integer
      AND coalesce(moderation.action, 'restore') <> 'remove'
  `,
  thing: `
    SELECT thing.id
    FROM things thing
    LEFT JOIN LATERAL (
      SELECT action FROM moderation_actions
      WHERE target_type = 'thing' AND target_id = thing.id
      ORDER BY created_at DESC, id DESC LIMIT 1
    ) moderation ON TRUE
    WHERE thing.id = $1::integer AND thing.withdrawn_at IS NULL
      AND coalesce(moderation.action, 'restore') <> 'remove'
  `,
})

function drawingHistorySql(recordType: DrawingRecordType): string {
  const inheritedKindModeration = recordType === 'thing' ? `
        AND NOT EXISTS (
          SELECT 1
          FROM (VALUES
            (revision.prior_source, revision.prior_kind_id),
            (revision.current_source, revision.current_kind_id)
          ) inherited(source_type, kind_id)
          JOIN LATERAL (
            SELECT action
            FROM moderation_actions
            WHERE target_type = 'kind' AND target_id = inherited.kind_id
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          ) source_moderation ON TRUE
          WHERE inherited.source_type IN ('kind_base', 'kind_variant')
            AND source_moderation.action = 'remove'
        )
  ` : ''
  return `
    /* drawing:${recordType}-history */
    WITH visible AS MATERIALIZED (
      ${DRAWING_HISTORY_VISIBLE_SQL[recordType]}
    )
    SELECT visible.id AS visible_id,
      history.id AS revision_id, history.slot_variant_name,
      history.prior_state, history.prior_description, history.prior_drawing,
      history.prior_source, history.prior_kind_id,
      CASE WHEN history.prior_source IN ('kind_base', 'kind_variant')
        THEN prior_kind.name ELSE NULL END AS prior_kind_name,
      history.prior_kind_revision, history.prior_variant_name,
      history.current_state, history.current_description, history.current_drawing,
      history.current_source, history.current_kind_id,
      CASE WHEN history.current_source IN ('kind_base', 'kind_variant')
        THEN current_kind.name ELSE NULL END AS current_kind_name,
      history.current_kind_revision, history.current_variant_name,
      history.author_id, author.handle AS author_handle,
      history.author_relation, history.created_at
    FROM visible
    LEFT JOIN LATERAL (
      SELECT revision.*
      FROM drawing_revisions revision
      WHERE revision.target_type = '${recordType}'
        AND revision.target_id = visible.id
        AND ($2::integer IS NULL OR revision.id < $2::integer)
        ${inheritedKindModeration}
      ORDER BY revision.id DESC
      LIMIT $3::integer
    ) history ON TRUE
    LEFT JOIN kinds prior_kind ON prior_kind.id = history.prior_kind_id
    LEFT JOIN kinds current_kind ON current_kind.id = history.current_kind_id
    LEFT JOIN residents author ON author.id = history.author_id
    ORDER BY history.id DESC NULLS LAST
  `
}

function drawingThumbnailSql(recordType: DrawingRecordType): string {
  return `
    /* drawing:${recordType}-thumbnail */
    WITH drawing AS MATERIALIZED (
      ${DRAWING_READ_SQL[recordType]}
    )
    SELECT (
      SELECT current_change_id::text
      FROM public_change_state
      WHERE singleton = true
    ) AS checkpoint, drawing.*
    FROM drawing
  `
}

function drawingRecordType(value: string): DrawingRecordType | null {
  return DRAWING_RECORD_TYPE_SET.has(value) ? value as DrawingRecordType : null
}

function exactPositiveId(value: string): number | null {
  if (!/^[1-9][0-9]*$/u.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id <= 2_147_483_647 ? id : null
}

function optionalPositiveQuery(value: string | null): number | null | 'invalid' {
  if (value === null) return null
  return exactPositiveId(value) ?? 'invalid'
}

function publicStoredDrawing(row: StoredDrawingRow): PublicDrawingSnapshot | 'invalid' {
  if (typeof row.drawing_state !== 'string' || !DRAWING_STATES.has(row.drawing_state)) {
    return 'invalid'
  }
  const state = row.drawing_state as DrawingState
  const parsed = parseDrawing(row.drawing)
  if (!parsed.ok) return 'invalid'
  const description = row.drawing_description
  if (description !== null && typeof description !== 'string') return 'invalid'
  if (state === 'undrawn' && (parsed.drawing !== null || description !== null)) return 'invalid'
  if (state === 'refused' && (parsed.drawing !== null || typeof description !== 'string')) return 'invalid'
  if (
    (state === 'in_progress' || state === 'complete')
    && (parsed.drawing === null || typeof description !== 'string')
  ) return 'invalid'
  if (typeof row.source !== 'string' || !DRAWING_SOURCES.has(row.source)) return 'invalid'
  const source = row.source as DrawingSource

  const kindId = row.kind_id == null ? null : Number(row.kind_id)
  const kindName = row.kind_name == null ? null : String(row.kind_name)
  const revision = row.revision == null ? null : Number(row.revision)
  const variantName = row.variant_name == null ? null : String(row.variant_name)
  if (kindId !== null && !Number.isSafeInteger(kindId)) return 'invalid'
  if (revision !== null && !Number.isSafeInteger(revision)) return 'invalid'

  return Object.freeze({
    state,
    presentation_state: drawingPresentationState({ state, drawing: parsed.drawing }),
    description: description as string | null,
    drawing: parsed.drawing,
    rows: parsed.drawing === null ? null : drawingRows(parsed.drawing),
    source,
    ...(kindId === null ? {} : { kind_id: kindId }),
    ...(kindName === null ? {} : { kind_name: kindName }),
    ...(revision === null ? {} : { revision }),
    ...(variantName === null ? {} : { variant_name: variantName }),
  })
}

function historySnapshot(
  row: Record<string, unknown>,
  side: 'prior' | 'current',
): PublicDrawingSnapshot | 'invalid' {
  const embedded = row[side === 'prior' ? 'previous' : 'current']
  if (embedded && typeof embedded === 'object' && !Array.isArray(embedded)) {
    return embedded as PublicDrawingSnapshot
  }
  return publicStoredDrawing({
    id: Number(row.visible_id),
    drawing: row[`${side}_drawing`],
    drawing_state: row[`${side}_state`],
    drawing_description: row[`${side}_description`],
    source: row[`${side}_source`],
    kind_id: row[`${side}_kind_id`],
    kind_name: row[`${side}_kind_name`],
    revision: row[`${side}_kind_revision`],
    variant_name: row[`${side}_variant_name`],
  })
}

function exactResidentDrawingBody(body: Record<string, unknown>, state: DrawingState): boolean {
  const expected = state === 'undrawn'
    ? ['drawing']
    : state === 'refused'
      ? ['drawing', 'drawing_description']
      : ['drawing', 'drawing_description', 'drawing_state']
  const actual = Object.keys(body).sort()
  return actual.length === expected.length
    && expected.every((field, index) => actual[index] === field)
}

function privateHeaders(c: Context): void {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
  c.header('Vary', 'Authorization')
}

function thumbnailEmpty(c: Context, status: 400 | 404 | 500): Response {
  return c.body(null, status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
}

export function mountDrawingRoutes(app: Hono, dependencies: DrawingRouteDependencies): void {
  app.get('/api/drawing/:type/:id/thumb.png', async c => {
    const recordType = drawingRecordType(c.req.param('type'))
    if (!recordType) return thumbnailEmpty(c, 400)
    const id = exactPositiveId(c.req.param('id'))
    if (id === null) return thumbnailEmpty(c, 400)

    const query = new URL(c.req.url).searchParams
    if ([...query.keys()].some(key => key !== 'rev') || query.getAll('rev').length > 1) {
      return thumbnailEmpty(c, 400)
    }
    const requestedRevisionValue = query.get('rev')
    const requestedRevision = requestedRevisionValue === null
      ? null
      : parsePublicChangeMarker(requestedRevisionValue)
    if (requestedRevisionValue !== null && requestedRevision === null) {
      return thumbnailEmpty(c, 400)
    }

    const rows = await dependencies.database.query(drawingThumbnailSql(recordType), [id])
    const row = rows[0] as StoredDrawingRow | undefined
    if (!row || row.id == null) return thumbnailEmpty(c, 404)
    const checkpoint = parsePublicChangeMarker(String(row.checkpoint ?? ''))
    if (checkpoint === null) return thumbnailEmpty(c, 500)
    const drawing = publicStoredDrawing(row)
    if (drawing === 'invalid') return thumbnailEmpty(c, 500)
    if (
      drawing.drawing === null || drawing.state === 'undrawn' || drawing.state === 'refused'
    ) return thumbnailEmpty(c, 404)

    const canonical = `/api/drawing/${recordType}/${id}/thumb.png?rev=${checkpoint}`
    if (requestedRevision !== checkpoint) {
      return c.body(null, 307, {
        'Cache-Control': 'no-store',
        Location: canonical,
        'X-Content-Type-Options': 'nosniff',
      })
    }

    const png = renderDrawingThumbnailPng(drawing.drawing)
    return c.body(png, 200, {
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': String(png.byteLength),
      'Content-Type': 'image/png',
      'X-Content-Type-Options': 'nosniff',
    })
  })

  app.get('/api/drawing/:type/:id/history', async c => {
    c.header('Cache-Control', 'no-store')
    const recordType = drawingRecordType(c.req.param('type'))
    if (!recordType) return err(c, 400, 'drawing type must be place, resident, kind, or thing')
    const id = exactPositiveId(c.req.param('id'))
    if (id === null) return err(c, 400, 'drawing id must be a positive integer without leading zeroes')

    const query = new URL(c.req.url).searchParams
    if ([...query.keys()].some(key => key !== 'before' && key !== 'limit')) {
      return err(c, 400, 'drawing history accepts only before and limit')
    }
    if (query.getAll('before').length > 1 || query.getAll('limit').length > 1) {
      return err(c, 400, 'drawing history accepts before and limit once each')
    }
    const before = optionalPositiveQuery(query.get('before'))
    if (before === 'invalid') {
      return err(c, 400, 'drawing history before must be a positive integer without leading zeroes')
    }
    const requestedLimit = query.get('limit')
    const parsedLimit = requestedLimit === null ? DRAWING_HISTORY_DEFAULT : exactPositiveId(requestedLimit)
    if (parsedLimit === null || parsedLimit > DRAWING_HISTORY_MAX) {
      return err(c, 400, `drawing history limit must be 1-${DRAWING_HISTORY_MAX}`)
    }

    const rows = await dependencies.database.query(
      drawingHistorySql(recordType),
      [id, before, parsedLimit + 1],
    )
    if (rows.length === 0) return err(c, 404, `drawing record for ${recordType}_id ${id} was not found; read the ${recordType} record or choose another current id`)
    const revisionRows = rows.filter(row => row.revision_id != null)
    const hasMore = revisionRows.length > parsedLimit
    const pageRows = revisionRows.slice(0, parsedLimit)
    const revisions = []
    for (const row of pageRows) {
      const previous = historySnapshot(row, 'prior')
      const current = historySnapshot(row, 'current')
      if (previous === 'invalid' || current === 'invalid') {
        return err(c, 500, 'saved drawing cannot be read because its stored record is invalid; the record owner should save a valid drawing again or contact the city operator')
      }
      revisions.push({
        id: Number(row.revision_id),
        slot_variant_name: row.slot_variant_name == null ? null : String(row.slot_variant_name),
        previous,
        current,
        author: {
          id: row.author_id == null ? null : Number(row.author_id),
          handle: row.author_handle == null ? null : String(row.author_handle),
          relation: String(row.author_relation),
        },
        created_at: row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
      })
    }

    return c.json({
      type: recordType,
      id,
      revisions,
      page: {
        limit: parsedLimit,
        has_more: hasMore,
        next_before: hasMore ? Number(pageRows.at(-1)!.revision_id) : null,
      },
    })
  })

  app.get('/api/drawing/:type/:id', async c => {
    c.header('Cache-Control', 'no-store')
    if (new URL(c.req.url).searchParams.size > 0) {
      return err(c, 400, 'drawing reads do not accept query options')
    }
    const recordType = drawingRecordType(c.req.param('type'))
    if (!recordType) return err(c, 400, 'drawing type must be place, resident, kind, or thing')
    const id = exactPositiveId(c.req.param('id'))
    if (id === null) return err(c, 400, 'drawing id must be a positive integer without leading zeroes')

    const rows = await dependencies.database.query(DRAWING_READ_SQL[recordType], [id])
    const row = rows[0] as StoredDrawingRow | undefined
    if (!row) return err(c, 404, `drawing record for ${recordType}_id ${id} was not found; read the ${recordType} record or choose another current id`)
    const drawing = publicStoredDrawing(row)
    if (drawing === 'invalid') {
      return err(c, 500, 'saved drawing cannot be read because its stored record is invalid; the record owner should save a valid drawing again or contact the city operator')
    }

    return c.json({ type: recordType, id, ...drawing })
  })

  app.patch('/api/me/drawing', async c => {
    privateHeaders(c)
    const resident = await dependencies.authenticate(c)
    if (!resident) return err(c, 401, 'resident sign-in required to edit your drawing')
    if (new URL(c.req.url).searchParams.size > 0) {
      return err(c, 400, 'resident drawing edit does not accept query options')
    }
    const decoded = await readBoundedJsonObject(c.req.raw, DRAWING_BODY_MAX_BYTES)
    if (!decoded.ok) {
      return /no larger than/iu.test(decoded.error)
        ? c.json({ error: decoded.error }, 413)
        : err(c, 400, decoded.error)
    }
    const parsed = parseDrawingWrite(decoded.body)
    if (!parsed.ok) return err(c, 400, parsed.error)
    if (!exactResidentDrawingBody(decoded.body, parsed.value.state)) {
      return err(c, 400, 'resident drawing body must use exactly one documented drawing write shape')
    }
    const stored = parsed.value.drawing === null ? null : JSON.stringify(parsed.value.drawing)

    const rows = await dependencies.database.query(`
      /* drawing:resident-write */
      WITH resident AS MATERIALIZED (
        SELECT id, handle, drawing, drawing_state, drawing_description,
          ROW(drawing, drawing_state, drawing_description)
            IS DISTINCT FROM ROW($2::jsonb, $3::text, $4::text) AS would_change
        FROM residents
        WHERE id = $1::integer
        FOR UPDATE
      ), pruned AS (
        DELETE FROM resident_drawing_rate_limits
        WHERE minute < date_trunc('minute', now(), 'UTC') - interval '2 hours'
      ), admitted AS (
        INSERT INTO resident_drawing_rate_limits (resident_id, minute, used)
        SELECT id, date_trunc('minute', now(), 'UTC'), 1
        FROM resident
        WHERE would_change
        ON CONFLICT (resident_id, minute) DO UPDATE
        SET used = resident_drawing_rate_limits.used + 1
        WHERE resident_drawing_rate_limits.used < 6
        RETURNING resident_id
      ), changed AS (
        UPDATE residents target
        SET drawing = $2::jsonb,
          drawing_state = $3::text,
          drawing_description = $4::text
        FROM resident
        WHERE target.id = resident.id
          AND resident.would_change
          AND EXISTS (SELECT 1 FROM admitted WHERE admitted.resident_id = resident.id)
        RETURNING target.id, target.handle,
          target.drawing, target.drawing_state, target.drawing_description,
          resident.drawing AS prior_drawing,
          resident.drawing_state AS prior_state,
          resident.drawing_description AS prior_description
      ), revision AS (
        INSERT INTO drawing_revisions (
          target_type, target_id, slot_variant_name,
          prior_state, prior_description, prior_drawing, prior_source,
          prior_kind_id, prior_kind_revision, prior_variant_name,
          current_state, current_description, current_drawing, current_source,
          current_kind_id, current_kind_revision, current_variant_name,
          author_id, author_relation
        )
        SELECT 'resident', changed.id, NULL,
          changed.prior_state, changed.prior_description, changed.prior_drawing,
          CASE WHEN changed.prior_state = 'undrawn' THEN 'none' ELSE 'resident' END,
          NULL, NULL, NULL,
          changed.drawing_state, changed.drawing_description, changed.drawing,
          CASE WHEN changed.drawing_state = 'undrawn' THEN 'none' ELSE 'resident' END,
          NULL, NULL, NULL,
          changed.id, 'self'
        FROM changed
        RETURNING id
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'resident_edited', $5::text, jsonb_build_object('resident_id', changed.id)
        FROM changed
      ), result AS (
        SELECT changed.id, changed.handle, changed.drawing,
          changed.drawing_state, changed.drawing_description,
          'changed'::text AS write_state
        FROM changed
        UNION ALL
        SELECT resident.id, resident.handle, resident.drawing,
          resident.drawing_state, resident.drawing_description,
          'unchanged'::text AS write_state
        FROM resident
        WHERE NOT resident.would_change
        UNION ALL
        SELECT resident.id, resident.handle, resident.drawing,
          resident.drawing_state, resident.drawing_description,
          'rate_limited'::text AS write_state
        FROM resident
        WHERE resident.would_change AND NOT EXISTS (
          SELECT 1 FROM admitted WHERE admitted.resident_id = resident.id
        )
      )
      SELECT id, handle, drawing, drawing_state, drawing_description, write_state FROM result
    `, [resident.id, stored, parsed.value.state, parsed.value.description, resident.handle])
    const row = rows[0]
    if (!row) return err(c, 409, 'resident changed while its drawing was edited; retry')
    const writeState = row.write_state ?? row.state
    if (writeState === 'rate_limited') {
      c.header('Retry-After', '60')
      return err(c, 429, 'resident drawing allows 6 changed edits per UTC minute; retry after 60 seconds')
    }
    const publicDrawing = publicStoredDrawing({
      id: Number(row.id),
      drawing: row.drawing,
      drawing_state: row.drawing_state,
      drawing_description: row.drawing_description,
      source: row.drawing_state === 'undrawn' ? 'none' : 'resident',
      kind_id: null,
      kind_name: null,
      revision: null,
      variant_name: null,
    })
    if (publicDrawing === 'invalid') {
      return err(c, 500, 'saved drawing cannot be read because its stored record is invalid; the record owner should save a valid drawing again or contact the city operator')
    }
    return c.json({
      resident: {
        id: Number(row.id),
        handle: String(row.handle),
        drawing: publicDrawing.drawing,
        drawing_state: publicDrawing.state,
        drawing_description: publicDrawing.description,
      },
      changed: writeState === 'changed',
    })
  })
}
