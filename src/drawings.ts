import type { Context, Hono } from 'hono'
import { err, type Resident } from './core.ts'
import {
  DRAWING_BODY_MAX_BYTES,
  parseDrawing,
  readBoundedJsonObject,
  type Drawing,
} from './drawing.ts'

const DRAWING_RECORD_TYPES = Object.freeze(['place', 'resident', 'kind', 'thing'] as const)
const DRAWING_RECORD_TYPE_SET: ReadonlySet<string> = new Set(DRAWING_RECORD_TYPES)

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

type DrawingSource = 'place' | 'resident' | 'thing' | 'kind_revision'

interface StoredDrawingRow extends Record<string, unknown> {
  id: number
  drawing: unknown
  source: DrawingSource | null
  kind_id: number | null
  revision: number | null
}

const DRAWING_READ_SQL: Readonly<Record<DrawingRecordType, string>> = Object.freeze({
  place: `
    /* drawing:place-read */
    SELECT place.id, place.drawing,
      CASE WHEN place.drawing IS NULL THEN NULL ELSE 'place' END AS source,
      NULL::integer AS kind_id, NULL::integer AS revision
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
      CASE WHEN resident.drawing IS NULL THEN NULL ELSE 'resident' END AS source,
      NULL::integer AS kind_id, NULL::integer AS revision
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
      CASE WHEN revision.drawing IS NULL THEN NULL ELSE 'kind_revision' END AS source,
      kind.id AS kind_id, revision.revision
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
        WHEN thing.drawing IS NOT NULL THEN thing.drawing
        WHEN coalesce(kind_moderation.action, 'restore') <> 'remove' THEN revision.drawing
        ELSE NULL
      END AS drawing,
      CASE
        WHEN thing.drawing IS NOT NULL THEN 'thing'
        WHEN coalesce(kind_moderation.action, 'restore') <> 'remove'
          AND revision.drawing IS NOT NULL THEN 'kind_revision'
        ELSE NULL
      END AS source,
      thing.kind_id, thing.current_revision AS revision
    FROM things thing
    LEFT JOIN kind_revisions revision
      ON revision.kind_id = thing.kind_id AND revision.revision = thing.current_revision
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

function drawingRecordType(value: string): DrawingRecordType | null {
  return DRAWING_RECORD_TYPE_SET.has(value) ? value as DrawingRecordType : null
}

function exactPositiveId(value: string): number | null {
  if (!/^[1-9][0-9]*$/u.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id <= 2_147_483_647 ? id : null
}

function publicStoredDrawing(row: StoredDrawingRow): Drawing | null | 'invalid' {
  const parsed = parseDrawing(row.drawing)
  return parsed.ok ? parsed.drawing : 'invalid'
}

function privateHeaders(c: Context): void {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
  c.header('Vary', 'Authorization')
}

export function mountDrawingRoutes(app: Hono, dependencies: DrawingRouteDependencies): void {
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
    if (!row) return err(c, 404, 'drawing record not found')
    const drawing = publicStoredDrawing(row)
    if (drawing === 'invalid') return err(c, 500, 'stored drawing is invalid')

    return c.json({
      type: recordType,
      id,
      drawing,
      source: row.source,
      ...(row.kind_id == null ? {} : { kind_id: Number(row.kind_id) }),
      ...(row.revision == null ? {} : { revision: Number(row.revision) }),
    })
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
    if (Object.keys(decoded.body).length !== 1 || !Object.hasOwn(decoded.body, 'drawing')) {
      return err(c, 400, 'resident drawing body accepts exactly drawing')
    }
    const parsed = parseDrawing(decoded.body.drawing)
    if (!parsed.ok) return err(c, 400, parsed.error)
    const stored = parsed.drawing === null ? null : JSON.stringify(parsed.drawing)

    const rows = await dependencies.database.query(`
      /* drawing:resident-write */
      WITH resident AS MATERIALIZED (
        SELECT id, handle, drawing,
          drawing IS DISTINCT FROM $2::jsonb AS would_change
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
        SET drawing = $2::jsonb
        FROM resident
        WHERE target.id = resident.id
          AND resident.would_change
          AND EXISTS (SELECT 1 FROM admitted WHERE admitted.resident_id = resident.id)
        RETURNING target.id, target.handle, target.drawing
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'resident_edited', $3::text, jsonb_build_object('resident_id', changed.id)
        FROM changed
      ), result AS (
        SELECT changed.id, changed.handle, changed.drawing, 'changed'::text AS state
        FROM changed
        UNION ALL
        SELECT resident.id, resident.handle, resident.drawing, 'unchanged'::text AS state
        FROM resident
        WHERE NOT resident.would_change
        UNION ALL
        SELECT resident.id, resident.handle, resident.drawing, 'rate_limited'::text AS state
        FROM resident
        WHERE resident.would_change AND NOT EXISTS (
          SELECT 1 FROM admitted WHERE admitted.resident_id = resident.id
        )
      )
      SELECT id, handle, drawing, state FROM result
    `, [resident.id, stored, resident.handle])
    const row = rows[0]
    if (!row) return err(c, 409, 'resident changed while its drawing was edited; retry')
    if (row.state === 'rate_limited') {
      c.header('Retry-After', '60')
      return err(c, 429, 'resident drawing allows 6 changed edits per UTC minute; retry after 60 seconds')
    }
    const drawing = publicStoredDrawing({
      id: Number(row.id),
      drawing: row.drawing,
      source: row.drawing == null ? null : 'resident',
      kind_id: null,
      revision: null,
    })
    if (drawing === 'invalid') return err(c, 500, 'stored drawing is invalid')
    return c.json({
      resident: { id: Number(row.id), handle: String(row.handle), drawing },
      changed: row.state === 'changed',
    })
  })
}
