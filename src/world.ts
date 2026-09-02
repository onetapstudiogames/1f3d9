import type { Hono } from 'hono'
import { err, postgresErrorCode } from './core.ts'
import { sql } from './db.ts'
import {
  optionalBoolean,
  positiveId,
  publicLabel,
  publicText,
  stringList,
  worldName, containsBearerSecret, SECRET_REJECTION } from './input.ts'
import { parseKindRecipe, parseTraitRecipe } from './physics.ts'
import { completeTreasuryPaymentOperation } from './payment-treasury-operations.ts'
import { completePlaceLifecycleOperation } from './place-lifecycle-operation.ts'
import {
  parsePlaceLifecycleRequest,
  placeLifecycleRefusal,
  type PlaceLifecycleAction,
  type PlaceLifecycleFacts,
} from './place-lifecycle.ts'
import { moderatePlaceDetails, moderatePublicKinds, moderatePublicRows } from './moderation-store.ts'
import {
  effectiveLaws,
  engineSql,
  residentPresence,
  resolveDueEffects,
  withEngineTransaction,
} from './engine.ts'
import { withdrawThing } from './withdrawal.ts'
import { lawNames, replacePlaceLaws } from './laws.ts'
import { makeThingThroughEngine } from './thing-making.ts'
import { placePermission, withPlacePermission } from './place-permission.ts'
import {
  isWorldRootRow,
  WORLD_TRANSIT_ONLY_ERROR,
} from './world-root.ts'
import {
  buildPlaceTree,
  completedTreasuryFeeResponse,
  conflictMessage,
  DESCRIPTION_MAX,
  DOMAIN,
  feeSelectionConflict,
  hasDuplicateNames,
  hasOnly,
  isResponse,
  jsonBody,
  openOffer,
  reconcileTreasuryCompletionNoEffect,
  reportTreasuryCompletionFailure,
  returnFailedTreasuryFee,
  requireResident,
  THING_BODY_MAX_BYTES,
  treasuryFee,
  unknownTraitMessage,
  type KindRow,
  type PlaceRow,
  type ThingRow,
} from './world-support.ts'
import {
  allowedPublicQuery,
  effectivePublicPlaceTextLimit,
  extractPublicCollectionRows,
  finalizePublicPage,
  loadPublicPlaceCollectionRows,
  parsePublicPage,
  parsePublicTextLimit,
  singlePublicQueryValue,
  utf8TextBytes,
  type PublicQueryExecutor,
} from './public-pagination.ts'
import { publicJson } from './public-output.ts'
import { loadPublicPlaceRecord, loadPublicThingRecord } from './public-records.ts'
import { safeReadingCostMeter } from './reading-cost.ts'
import { executeBudgetedExactQuery } from './public-exact-query.ts'
import { cachedPublicMapOutline, readPublicMapOutline } from './public-map.ts'
import {
  parsePublicChangeMarker,
  PublicChangeFutureError,
  PublicChangeReadConflictError,
  readAtStablePublicChangeCheckpoint,
} from './public-changes.ts'
import {
  loadPublicPlaceFrontMatter,
  parsePlaceFrontMatter,
  parsePlacePurpose,
} from './room-orientation.ts'
import {
  DRAWING_RECORD_BODY_MAX_BYTES,
  DRAWING_VARIANT_NAME_MAX_BYTES,
  parseDrawingVariantName,
  parseDrawingVariants,
  parseDrawingWrite,
  readBoundedJsonObject,
  type DrawingState,
  type DrawingValue,
  type DrawingVariant,
  type BoundedJsonResult,
} from './drawing.ts'

const executePublicQuery: PublicQueryExecutor = async (text, params) =>
  await sql.query(text, [...params]) as Record<string, unknown>[]

type DrawingWriteField =
  | Readonly<{ ok: true; supplied: false }>
  | Readonly<{
      ok: true
      supplied: true
      value: DrawingValue
      storedDrawing: string | null
    }>
  | Readonly<{ ok: false; error: string }>

function drawingWriteField(body: Record<string, unknown>): DrawingWriteField {
  const supplied = ['drawing', 'drawing_state', 'drawing_description']
    .some(field => Object.hasOwn(body, field))
  if (!supplied) return Object.freeze({ ok: true, supplied: false })
  const parsed = parseDrawingWrite(body)
  if (!parsed.ok) return parsed
  return Object.freeze({
    ok: true,
    supplied: true,
    value: parsed.value,
    storedDrawing: parsed.value.drawing === null ? null : JSON.stringify(parsed.value.drawing),
  })
}

type DrawingVariantsField =
  | Readonly<{ ok: true; supplied: false }>
  | Readonly<{ ok: true; supplied: true; variants: readonly DrawingVariant[] }>
  | Readonly<{ ok: false; error: string }>

function drawingVariantsField(body: Record<string, unknown>): DrawingVariantsField {
  if (!Object.hasOwn(body, 'drawing_variants')) {
    return Object.freeze({ ok: true, supplied: false })
  }
  const parsed = parseDrawingVariants(body.drawing_variants)
  return parsed.ok
    ? Object.freeze({ ok: true, supplied: true, variants: parsed.variants })
    : parsed
}

function drawingRequestFields(
  value: DrawingValue,
): Readonly<Record<string, unknown>> {
  if (value.state === 'undrawn') return Object.freeze({ drawing: null })
  if (value.state === 'refused') {
    return Object.freeze({ drawing: 'REFUSE', drawing_description: value.description })
  }
  return Object.freeze({
    drawing: value.drawing,
    drawing_state: value.state,
    drawing_description: value.description,
  })
}

function variantRequestRows(
  variants: readonly DrawingVariant[],
): readonly Readonly<Record<string, unknown>>[] {
  return Object.freeze(variants.map(variant => Object.freeze({
    name: variant.name,
    drawing: variant.drawing,
    drawing_state: variant.state,
    drawing_description: variant.description,
  })))
}

function storedDrawingValue(row: Readonly<{
  drawing?: unknown
  drawing_state?: unknown
  drawing_description?: unknown
}>): DrawingValue | null {
  const state = row.drawing_state == null
    ? (row.drawing == null ? 'undrawn' : 'complete')
    : row.drawing_state
  if (!['undrawn', 'refused', 'in_progress', 'complete'].includes(String(state))) return null
  const candidate: Record<string, unknown> = state === 'undrawn'
    ? { drawing: null }
    : state === 'refused'
      ? { drawing: 'REFUSE', drawing_description: row.drawing_description }
      : {
          drawing: row.drawing,
          drawing_state: state,
          drawing_description: row.drawing_description ?? '',
        }
  const parsed = parseDrawingWrite(candidate)
  return parsed.ok ? parsed.value : null
}

function storedDrawingVariants(value: unknown): readonly DrawingVariant[] | null {
  if (!Array.isArray(value)) return null
  const publicRows = value.map(candidate => {
    if (candidate == null || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate
    const row = candidate as Record<string, unknown>
    return {
      name: row.name,
      drawing: row.drawing,
      drawing_state: row.state ?? row.drawing_state,
      drawing_description: row.description ?? row.drawing_description,
    }
  })
  const parsed = parseDrawingVariants(publicRows)
  return parsed.ok ? parsed.variants : null
}

function drawingVariantName(value: unknown): string | null | 'invalid' {
  if (value === null) return null
  return parseDrawingVariantName(value) ?? 'invalid'
}

async function optionalDrawingBody(request: Request): Promise<BoundedJsonResult> {
  return await readBoundedJsonObject(request, DRAWING_RECORD_BODY_MAX_BYTES, { allowEmpty: true })
}

function publicPlaceWriteRow(row: PlaceRow): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(row).filter(([field]) => field !== 'front_matter_thing_ids'),
  ))
}

async function everyTraitExists(names: readonly string[]): Promise<boolean> {
  if (names.length === 0) return true
  const rows = await sql`
    SELECT name FROM traits WHERE name = ANY(${[...names]}::text[])
  ` as Array<{ name: string }>
  const found = new Set(rows.map(row => row.name))
  return names.every(name => found.has(name))
}

async function activePlaceLabels(placeId: number): Promise<string[]> {
  const rows = await sql`
    SELECT DISTINCT label
    FROM active_labels
    WHERE target_type = 'place' AND target_id = ${placeId}
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY label
  ` as Array<{ label: string }>
  return rows.map(row => row.label)
}

async function readPublicMap(): Promise<{ places: unknown[] }> {
  const rows = (await sql`
    WITH RECURSIVE place_tree AS (
      SELECT p.id, p.parent_id, p.name, p.description, p.purpose, p.owner_id,
        p.open_to_building, p.open_to_things, p.open_to_notes, p.created_at,
        ARRAY[p.id] AS path
      FROM places p
      WHERE p.parent_id IS NULL AND p.retired_at IS NULL
      UNION ALL
      SELECT child.id, child.parent_id, child.name, child.description, child.purpose, child.owner_id,
        child.open_to_building, child.open_to_things, child.open_to_notes, child.created_at,
        parent.path || child.id
      FROM places child
      JOIN place_tree parent ON parent.id = child.parent_id
      WHERE child.retired_at IS NULL AND NOT child.id = ANY(parent.path)
    )
    SELECT tree.id, tree.parent_id, tree.name, tree.description, tree.purpose, tree.owner_id,
      owner.handle AS owner, tree.open_to_building, tree.open_to_things,
      tree.open_to_notes, tree.created_at,
      (SELECT count(*)::int FROM places child
        WHERE child.parent_id = tree.id AND child.retired_at IS NULL) AS places,
      (SELECT count(*)::int FROM things thing
        WHERE thing.place_id = tree.id AND thing.withdrawn_at IS NULL) AS things,
      (SELECT count(*)::int FROM notes note WHERE note.place_id = tree.id) AS notes
    FROM place_tree tree
    LEFT JOIN residents owner ON owner.id = tree.owner_id
    ORDER BY tree.path
  `) as PlaceRow[]
  const publicRows = await moderatePublicRows('place', rows)
  const frontMatter = await loadPublicPlaceFrontMatter(executePublicQuery, rows.map(row => row.id))
  const orientedRows = publicRows.map(row => Object.freeze({
    ...row,
    front_matter: (row as unknown as Record<string, unknown>).moderated === true
      ? Object.freeze([])
      : frontMatter.get(row.id) ?? Object.freeze([]),
  }))
  return { places: buildPlaceTree(orientedRows as PlaceRow[], null) }
}

// The whole-city rebuild is the busiest anonymous read, so one short-lived
// build is shared by every request in the window (same shape and TTL as the
// window snapshot cache in window.ts).
type PublicMap = Awaited<ReturnType<typeof readPublicMap>>
let mapCache: { expiresAt: number; pending: Promise<PublicMap> } | null = null

async function cachedPublicMap() {
  const now = Date.now()
  if (mapCache && mapCache.expiresAt > now) return mapCache.pending
  const pending = readPublicMap()
  mapCache = { expiresAt: now + 30_000, pending }
  try {
    return await pending
  } catch (error) {
    if (mapCache?.pending === pending) mapCache = null
    throw error
  }
}

export function mountWorldRoutes(app: Hono): void {
  app.get('/api/map', async c => {
    const query = c.req.queries()
    const allowed = allowedPublicQuery(query, [
      'view', 'parent_id', 'limit', 'before_subplace_id', 'subplace_limit',
      'after_change_marker',
    ])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const viewValue = singlePublicQueryValue(query, 'view')
    if (!viewValue.ok) return err(c, 400, viewValue.error)
    const view = viewValue.value
    if (view != null && view !== 'outline' && view !== 'full') {
      return err(c, 400, 'view must be outline or full')
    }
    const pagingNames = [
      'parent_id', 'limit', 'before_subplace_id', 'subplace_limit', 'after_change_marker',
    ] as const
    if (view !== 'outline' && pagingNames.some(name => Object.hasOwn(query, name))) {
      return err(c, 400, 'map paging options require view=outline')
    }
    if (view === 'outline') {
      const parentValue = singlePublicQueryValue(query, 'parent_id')
      if (!parentValue.ok) return err(c, 400, parentValue.error)
      const parentId = parentValue.value == null || !/^[0-9]+$/u.test(parentValue.value)
        ? null
        : positiveId(parentValue.value)
      if (parentValue.value != null && parentId == null) {
        return err(c, 400, 'parent_id must be a positive integer')
      }
      const page = parsePublicPage(query, 'before_subplace_id', 'subplace_limit', 'limit')
      if (!page.ok) return err(c, 400, page.error)
      const afterMarkerValue = singlePublicQueryValue(query, 'after_change_marker')
      if (!afterMarkerValue.ok) return err(c, 400, afterMarkerValue.error)
      const minimumMarker = afterMarkerValue.value === null
        ? null
        : parsePublicChangeMarker(afterMarkerValue.value)
      if (afterMarkerValue.value !== null && minimumMarker === null) {
        return err(c, 400, 'after_change_marker must be a nonnegative decimal bigint')
      }
      let outline: Awaited<ReturnType<typeof readPublicMapOutline>>
      let changeMarker: string | null = null
      try {
        if (minimumMarker === null) {
          outline = await cachedPublicMapOutline(parentId, page.cursor, page.limit)
        } else {
          const stable = await readAtStablePublicChangeCheckpoint(
            executePublicQuery,
            minimumMarker,
            () => readPublicMapOutline(parentId, page.cursor, page.limit),
          )
          outline = stable.value
          changeMarker = stable.changeMarker
        }
      } catch (error) {
        if (error instanceof PublicChangeFutureError ||
            error instanceof PublicChangeReadConflictError) {
          return err(c, 409, error.message)
        }
        throw error
      }
      if (!outline) {
        return changeMarker === null
          ? err(c, 404, `place_id ${parentId} was not found; use GET /api/map?view=outline and send a current parent_id`)
          : c.json({
              error: `place_id ${parentId} was not found; use GET /api/map?view=outline and send a current parent_id`,
              change_marker: changeMarker,
            }, 404)
      }
      c.header(
        'Cache-Control',
        minimumMarker === null
          ? 'public, max-age=15, s-maxage=60, stale-while-revalidate=300'
          : 'no-store',
      )
      return publicJson(c, {
        view: 'outline',
        ...outline,
        ...(changeMarker === null ? {} : { change_marker: changeMarker }),
      })
    }

    const body = await cachedPublicMap()
    // The map tree is unbounded, so the proactive traversal budgets in
    // publicJson would withhold a large credential-free city. The app-wide
    // publicResponseSafety middleware still guards this response and only
    // parses it when the raw text actually matches the credential rule.
    c.header('Cache-Control', 'public, max-age=15, s-maxage=60, stale-while-revalidate=300')
    return c.json(view === 'full' ? { view: 'full', ...body } : body)
  })

  app.get('/api/place/:id', async c => {
    const id = positiveId(c.req.param('id'))
    if (!id) return err(c, 400, 'place id must be a positive integer')
    const query = c.req.queries()
    const allowed = allowedPublicQuery(query, [
      'view',
      'limit',
      'before_subplace_id', 'subplace_limit',
      'before_thing_id', 'thing_limit',
      'before_note_id', 'note_limit',
      'subplace_text_limit_bytes',
      'thing_text_limit_bytes',
      'note_text_limit_bytes',
    ])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const viewValue = singlePublicQueryValue(query, 'view')
    if (!viewValue.ok) return err(c, 400, viewValue.error)
    const requestedView = viewValue.value
    const view = requestedView ?? 'full'
    if (view !== 'outline' && view !== 'full') return err(c, 400, 'view must be outline or full')
    const subplaceRequest = parsePublicPage(query, 'before_subplace_id', 'subplace_limit', 'limit')
    if (!subplaceRequest.ok) return err(c, 400, subplaceRequest.error)
    const thingRequest = parsePublicPage(query, 'before_thing_id', 'thing_limit', 'limit')
    if (!thingRequest.ok) return err(c, 400, thingRequest.error)
    const noteRequest = parsePublicPage(query, 'before_note_id', 'note_limit', 'limit')
    if (!noteRequest.ok) return err(c, 400, noteRequest.error)
    const subplaceTextLimit = parsePublicTextLimit(query, 'subplace_text_limit_bytes')
    if (!subplaceTextLimit.ok) return err(c, 400, subplaceTextLimit.error)
    const thingTextLimit = parsePublicTextLimit(query, 'thing_text_limit_bytes')
    if (!thingTextLimit.ok) return err(c, 400, thingTextLimit.error)
    const noteTextLimit = parsePublicTextLimit(query, 'note_text_limit_bytes')
    if (!noteTextLimit.ok) return err(c, 400, noteTextLimit.error)
    const textLimits = Object.freeze({
      subplaces: subplaceTextLimit.value,
      things: thingTextLimit.value,
      notes: noteTextLimit.value,
    })
    if (view === 'outline' && Object.values(textLimits).some(value => value != null)) {
      return err(c, 400, 'text byte limits require view=full; outline already omits collection text')
    }
    const effectiveTextLimits = view === 'full'
      ? Object.freeze({
          subplaces: effectivePublicPlaceTextLimit(
            subplaceTextLimit.value,
            subplaceRequest.limit,
          ),
          things: effectivePublicPlaceTextLimit(thingTextLimit.value, thingRequest.limit),
          notes: effectivePublicPlaceTextLimit(noteTextLimit.value, noteRequest.limit),
        })
      : textLimits
    const publicPlace = await loadPublicPlaceRecord(id)
    if (!publicPlace) return err(c, 404, `place_id ${id} was not found; use GET /api/map?view=outline and send a current place_id`)

    if (publicPlace.status === 'retired') {
      const collections = await loadPublicPlaceCollectionRows(executePublicQuery, id, {
        subplaces: subplaceRequest,
        things: thingRequest,
        notes: noteRequest,
      }, view === 'full', effectiveTextLimits)
      const notesPage = collections.pages == null
        ? {
            ...finalizePublicPage(
              collections.notes as Array<Record<string, unknown> & { id: number }>,
              noteRequest.limit,
            ),
            returnedTextBytes: view === 'full'
              ? utf8TextBytes(collections.notes.slice(0, noteRequest.limit), 'body')
              : 0,
            stoppedForTextLimit: false,
            nextItemId: null,
            nextItemTextBytes: null,
          }
        : {
            items: collections.notes as Array<Record<string, unknown> & { id: number }>,
            ...collections.pages.notes,
          }
      const publicNotes = await moderatePublicRows('note', notesPage.items)
      return publicJson(c, {
        ...(requestedView == null ? {} : { view }),
        tombstone: publicPlace,
        notes: publicNotes,
        notes_page: {
          total_items: collections.totals.notes.items,
          total_text_bytes: collections.totals.notes.textBytes,
          returned_items: publicNotes.length,
          returned_text_bytes: notesPage.returnedTextBytes,
          has_more: notesPage.hasMore,
          next_before_note_id: notesPage.nextCursor,
          ...(effectiveTextLimits.notes == null ? {} : {
            text_limit_bytes: effectiveTextLimits.notes,
            stopped_for_text_limit: notesPage.stoppedForTextLimit,
            next_item_id: notesPage.nextItemId,
            next_item_text_bytes: notesPage.nextItemTextBytes,
            ...(noteTextLimit.value == null ? { server_text_limit_applied: true } : {}),
          }),
        },
      })
    }

    const [collections, labels, laws, frontMatterByPlace] = await Promise.all([
      loadPublicPlaceCollectionRows(executePublicQuery, id, {
        subplaces: subplaceRequest,
        things: thingRequest,
        notes: noteRequest,
      }, view === 'full', effectiveTextLimits),
      activePlaceLabels(id),
      effectiveLaws(id),
      loadPublicPlaceFrontMatter(executePublicQuery, [id]),
    ])
    const subplacesPage = collections.pages == null
      ? {
          ...finalizePublicPage(
            collections.subplaces as unknown as readonly (PlaceRow & { id: number })[],
            subplaceRequest.limit,
          ),
          returnedTextBytes: utf8TextBytes(
            collections.subplaces.slice(0, subplaceRequest.limit),
            'purpose',
          ) + (view === 'full'
            ? utf8TextBytes(collections.subplaces.slice(0, subplaceRequest.limit), 'description')
            : 0),
          stoppedForTextLimit: false,
          nextItemId: null,
          nextItemTextBytes: null,
        }
      : {
          items: collections.subplaces as unknown as readonly (PlaceRow & { id: number })[],
          ...collections.pages.subplaces,
        }
    const thingsPage = collections.pages == null
      ? {
          ...finalizePublicPage(
            collections.things as unknown as readonly (ThingRow & { id: number })[],
            thingRequest.limit,
          ),
          returnedTextBytes: view === 'full'
            ? utf8TextBytes(collections.things.slice(0, thingRequest.limit), 'body')
            : 0,
          stoppedForTextLimit: false,
          nextItemId: null,
          nextItemTextBytes: null,
        }
      : {
          items: collections.things as unknown as readonly (ThingRow & { id: number })[],
          ...collections.pages.things,
        }
    const notesPage = collections.pages == null
      ? {
          ...finalizePublicPage(
            collections.notes as Array<Record<string, unknown> & { id: number }>,
            noteRequest.limit,
          ),
          returnedTextBytes: view === 'full'
            ? utf8TextBytes(collections.notes.slice(0, noteRequest.limit), 'body')
            : 0,
          stoppedForTextLimit: false,
          nextItemId: null,
          nextItemTextBytes: null,
        }
      : {
          items: collections.notes as Array<Record<string, unknown> & { id: number }>,
          ...collections.pages.notes,
        }
    const [publicSubplaces, publicDetails, publicNotes] = await Promise.all([
      moderatePublicRows('place', subplacesPage.items),
      moderatePlaceDetails(thingsPage.items, laws),
      moderatePublicRows('note', notesPage.items),
    ])
    return publicJson(c, {
      ...(requestedView == null ? {} : { view }),
      place: { ...publicPlace, labels, laws: publicDetails.laws },
      front_matter: (publicPlace as unknown as Record<string, unknown>).moderated === true
        ? Object.freeze([])
        : frontMatterByPlace.get(id) ?? Object.freeze([]),
      subplaces: publicSubplaces,
      things: publicDetails.things,
      notes: publicNotes,
      subplaces_page: {
        total_items: collections.totals.subplaces.items,
        total_text_bytes: collections.totals.subplaces.textBytes,
        returned_items: publicSubplaces.length,
        returned_text_bytes: subplacesPage.returnedTextBytes,
        has_more: subplacesPage.hasMore,
        next_before_subplace_id: subplacesPage.nextCursor,
        ...(effectiveTextLimits.subplaces == null ? {} : {
          text_limit_bytes: effectiveTextLimits.subplaces,
          stopped_for_text_limit: subplacesPage.stoppedForTextLimit,
          next_item_id: subplacesPage.nextItemId,
          next_item_text_bytes: subplacesPage.nextItemTextBytes,
          ...(subplaceTextLimit.value == null ? { server_text_limit_applied: true } : {}),
        }),
      },
      things_page: {
        total_items: collections.totals.things.items,
        total_text_bytes: collections.totals.things.textBytes,
        returned_items: publicDetails.things.length,
        returned_text_bytes: thingsPage.returnedTextBytes,
        has_more: thingsPage.hasMore,
        next_before_thing_id: thingsPage.nextCursor,
        ...(effectiveTextLimits.things == null ? {} : {
          text_limit_bytes: effectiveTextLimits.things,
          stopped_for_text_limit: thingsPage.stoppedForTextLimit,
          next_item_id: thingsPage.nextItemId,
          next_item_text_bytes: thingsPage.nextItemTextBytes,
          ...(thingTextLimit.value == null ? { server_text_limit_applied: true } : {}),
        }),
      },
      notes_page: {
        total_items: collections.totals.notes.items,
        total_text_bytes: collections.totals.notes.textBytes,
        returned_items: publicNotes.length,
        returned_text_bytes: notesPage.returnedTextBytes,
        has_more: notesPage.hasMore,
        next_before_note_id: notesPage.nextCursor,
        ...(effectiveTextLimits.notes == null ? {} : {
          text_limit_bytes: effectiveTextLimits.notes,
          stopped_for_text_limit: notesPage.stoppedForTextLimit,
          next_item_id: notesPage.nextItemId,
          next_item_text_bytes: notesPage.nextItemTextBytes,
          ...(noteTextLimit.value == null ? { server_text_limit_applied: true } : {}),
        }),
      },
    })
  })

  app.get('/api/thing/:id', async c => {
    const allowed = allowedPublicQuery(c.req.queries(), [])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const id = positiveId(c.req.param('id'))
    if (!id) return err(c, 400, 'thing id must be a positive integer')
    const thing = await loadPublicThingRecord(id)
    if (!thing) return err(c, 404, `thing_id ${id} was not found; use GET /api/things and send a current active thing_id`)
    return publicJson(c, { thing })
  })

  app.post('/api/place', async c => {
    const resident = await requireResident(c)
    if (isResponse(resident)) return resident
    const selectionConflict = feeSelectionConflict(c)
    if (selectionConflict) return selectionConflict
    const body = await jsonBody(c)
    if (!body) return err(c, 400, 'body must be a JSON object')
    if (!hasOnly(body, [
      'parent_id',
      'name',
      'description',
      'open_to_building',
      'open_to_things',
      'open_to_notes',
    ])) {
      return err(c, 400, 'place body contains an unsupported field; send only parent_id, name, description, open_to_building, open_to_things, and open_to_notes')
    }

    const parentId = body.parent_id === null ? null : positiveId(body.parent_id)
    if (body.parent_id !== null && !parentId) {
      return err(c, 400, 'parent_id must be null for frontier land or a positive integer')
    }
    const name = publicLabel(body.name)
    const description = publicText(body.description ?? '', {
      maximumCharacters: DESCRIPTION_MAX,
      allowEmpty: true,
    })
    const openToBuilding = optionalBoolean(body.open_to_building)
    const openToThings = optionalBoolean(body.open_to_things)
    const openToNotes = optionalBoolean(body.open_to_notes)
    if (!name) return err(c, 400, 'name must be one safe line of 1-120 characters')
    if (description == null) return err(c, 400, 'description must be at most 4000 safe characters')
    if (openToBuilding === null || openToThings === null || openToNotes === null) {
      return err(c, 400, 'place permissions must be booleans')
    }

    // Presence is established before either the free or paid founding path so
    // founding can never recreate the old null-location entry shortcut.
    await residentPresence(resident.id)

    if (parentId != null) {
      const parents = (await withPlacePermission(sql)`
        SELECT parent.id, parent.parent_id, parent.place_kind, parent.owner_id,
          parent.retired_at,
          parent.open_to_building,
          ${placePermission('parent', 'open_to_building', resident.id)} AS place_permits_building
        FROM places parent WHERE parent.id = ${parentId}
      `) as Array<{
        id: number
        parent_id: number | null
        place_kind: string
        owner_id: number | null
        open_to_building: boolean
        place_permits_building: boolean
        retired_at?: string | null
      }>
      const parent = parents[0]
      if (!parent) return err(c, 404, `parent place_id ${parentId} was not found; use GET /api/map?view=outline and send a current parent_id`)
      if (parent.retired_at != null) return err(c, 409, 'parent place is retired; restore it before building there')
      if (isWorldRootRow(parent)) {
        // An explicit world parent is the same paid frontier operation as the
        // long-standing parent_id:null request. It is never a free build.
      } else if (c.req.header('x-1f3d9-fee-credit')) {
        return err(c, 400, 'city fee credit is only supported for the paid frontier, kind invention, or kind revision fee')
      } else if (parent.place_permits_building !== true) {
        return err(c, 403, 'this place does not permit visitors to build; its owner can enable open_to_building, or you can choose your own or another open place')
      } else try {
        const rows = (await withPlacePermission(sql)`
          WITH permitted_parent AS (
            SELECT parent.id
            FROM places parent
            WHERE parent.id = ${parentId}
              AND parent.retired_at IS NULL
              AND ${placePermission('parent', 'open_to_building', resident.id)}
            FOR UPDATE
          ), new_place AS (
            INSERT INTO places (
              parent_id, place_kind, name, description, owner_id,
              open_to_building, open_to_things, open_to_notes
            )
            SELECT permitted_parent.id, 'place', ${name}, ${description}, ${resident.id},
              ${openToBuilding ?? false}, ${openToThings ?? false}, ${openToNotes ?? false}
            FROM permitted_parent
            RETURNING *
          ), new_presence AS (
            INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
            SELECT ${resident.id}, id, id FROM new_place
            ON CONFLICT (resident_id) DO NOTHING
          ), new_event AS (
            INSERT INTO events (kind, actor, detail)
            SELECT 'place_created', ${resident.handle}, jsonb_build_object(
              'place_id', id, 'parent_id', parent_id, 'name', name, 'frontier', false
            ) FROM new_place
          )
          SELECT new_place.*, ${resident.handle}::text AS owner FROM new_place
        `) as PlaceRow[]
        if (!rows[0]) return err(c, 409, 'parent place changed or closed to building; retry')
        return c.json({ place: publicPlaceWriteRow(rows[0]) }, 201)
      } catch (error) {
        const message = conflictMessage(error, 'a place with that name already exists there')
        if (message) return err(c, 409, message)
        throw error
      }
    }

    const fee = await treasuryFee(
      c,
      `${DOMAIN}/api/place`,
      '1F3D9 frontier founding fee',
      resident.id,
      {
        operation: 'frontier',
        targetKey: `frontier:${parentId ?? 'root'}:${name}`,
        request: {
          parent_id: parentId,
          name,
          description,
          open_to_building: openToBuilding ?? false,
          open_to_things: openToThings ?? false,
          open_to_notes: openToNotes ?? false,
        },
      },
    )
    if (fee instanceof Response) return fee
    try {
      const completion = await completeTreasuryPaymentOperation(
        { query: sql.query },
        { attemptId: fee.attemptId, leaseOwner: fee.leaseOwner },
      )
      if (completion.state !== 'completed') {
        return await reconcileTreasuryCompletionNoEffect(
          c,
          fee,
          resident.id,
          completion.state === 'deadline_passed'
            ? 'frontier recovery deadline passed before completion'
            : 'frontier target changed before completion',
        )
      }
      return completedTreasuryFeeResponse(
        completion.responseBody,
        completion.status,
        completion.paymentResponseHeader,
      )
    } catch (error) {
      const message = conflictMessage(error, 'place name or payment proof already used')
      if (fee.rail === 'credit') {
        const response = await returnFailedTreasuryFee(
          fee,
          resident.id,
          message ?? 'frontier founding failed before completion',
          message ? 409 : 503,
        ) as Response
        reportTreasuryCompletionFailure({
          operation: 'frontier',
          rail: fee.rail,
          attemptId: fee.attemptId,
          status: response.status,
        }, error)
        return response
      }
      if (message) {
        const response = await reconcileTreasuryCompletionNoEffect(c, fee, resident.id, message)
        reportTreasuryCompletionFailure({
          operation: 'frontier',
          rail: fee.rail,
          attemptId: fee.attemptId,
          status: response.status,
        }, error)
        return response
      }
      throw error
    }
  })

  app.patch('/api/place/:id', async c => {
    const resident = await requireResident(c)
    if (isResponse(resident)) return resident
    const id = positiveId(c.req.param('id'))
    if (!id) return err(c, 400, 'place id must be a positive integer')
    const decoded = await readBoundedJsonObject(c.req.raw, DRAWING_RECORD_BODY_MAX_BYTES)
    if (!decoded.ok) {
      return /no larger than/iu.test(decoded.error)
        ? c.json({ error: decoded.error }, 413)
        : err(c, 400, decoded.error)
    }
    const body = decoded.body
    const lifecycle = parsePlaceLifecycleRequest(
      body,
      c.req.header('x-1f3d9-fee-credit') ?? null,
      c.req.header('x-payment') ?? null,
    )
    if (lifecycle && 'error' in lifecycle) return err(c, 400, lifecycle.error)
    if (lifecycle) {
      if (!hasOnly(body, lifecycle.action === 'rename' ? ['name'] : ['retired'])) {
        return err(c, 400, 'rename, retire, or restore one place at a time; do not mix paid acts')
      }
      const lifecycleSchema = await sql`
        SELECT to_regclass('public.place_name_history') IS NOT NULL AS installed
      ` as Array<{ installed: boolean }>
      if (lifecycleSchema[0]?.installed !== true) {
        return err(c, 503, 'place rename, retire, and restore are unavailable until the place lifecycle migration has run')
      }
      const factRows = await sql`
        SELECT place.id, place.name, place.owner_id, place.retired_at,
          (place.place_kind = 'world' OR place.id = 454) AS protected_city_service,
          (SELECT parent.retired_at FROM places parent
            WHERE parent.id = place.parent_id) AS parent_retired_at,
          (SELECT count(*)::integer FROM places child
            WHERE child.parent_id = place.id AND child.retired_at IS NULL) AS subplace_count,
          (SELECT count(*)::integer FROM things thing
            WHERE thing.place_id = place.id AND thing.withdrawn_at IS NULL) AS thing_count,
          (SELECT count(*)::integer FROM resident_presence presence
            WHERE presence.current_place_id = place.id) AS resident_count,
          EXISTS (
            SELECT 1 FROM places sibling
            WHERE sibling.parent_id = place.parent_id
              AND sibling.id <> place.id
              AND sibling.retired_at IS NULL
              AND lower(sibling.name) = lower(coalesce(
                ${lifecycle.action === 'rename' ? lifecycle.name : null},
                place.name
              ))
          ) AS name_taken
        FROM places place
        WHERE place.id = ${id}
      ` as Array<{
        id: number
        name: string
        owner_id: number | null
        retired_at: string | null
        parent_retired_at: string | null
        subplace_count: number
        thing_count: number
        resident_count: number
        name_taken: boolean
        protected_city_service: boolean
      }>
      const row = factRows[0]
      const facts: PlaceLifecycleFacts = row
        ? {
            exists: true,
            ownerId: row.owner_id,
            actorId: resident.id,
            currentName: row.name,
            retiredAt: row.retired_at,
            parentRetiredAt: row.parent_retired_at,
            subplaceCount: Number(row.subplace_count),
            thingCount: Number(row.thing_count),
            residentCount: Number(row.resident_count),
            nameTaken: row.name_taken === true,
            protectedCityService: row.protected_city_service === true,
          }
        : {
            exists: false,
            ownerId: null,
            actorId: resident.id,
            currentName: null,
            retiredAt: null,
            parentRetiredAt: null,
            subplaceCount: 0,
            thingCount: 0,
            residentCount: 0,
            nameTaken: false,
            protectedCityService: false,
          }
      const action: PlaceLifecycleAction = lifecycle.action === 'rename'
        ? { action: 'rename', name: lifecycle.name }
        : { action: lifecycle.action }
      const refusal = placeLifecycleRefusal(facts, action)
      if (refusal) {
        const status = refusal === 'place not found' ? 404
          : refusal.startsWith('only the place owner') ? 403
            : 409
        return err(c, status, refusal)
      }

      const operation = lifecycle.action === 'rename' ? 'place_rename'
        : lifecycle.action === 'retire' ? 'place_retire'
          : 'place_restore'
      const request = lifecycle.action === 'rename'
        ? { place_id: id, name: lifecycle.name }
        : { place_id: id }
      const targetKey = lifecycle.action === 'rename'
        ? `place:${id}:rename:${lifecycle.requestId}`
        : `place:${id}:${lifecycle.action}:${lifecycle.requestId}`
      const fee = await treasuryFee(
        c,
        `${DOMAIN}/api/place/${id}`,
        `1F3D9 place ${lifecycle.action} fee`,
        resident.id,
        {
          operation,
          targetKey,
          assetType: 'place',
          assetId: id,
          request,
        },
      )
      if (fee instanceof Response) return fee
      try {
        const completion = await completePlaceLifecycleOperation(
          {
            query: async (text, params = []) => sql.query(text, [...params]),
            transaction: work => withEngineTransaction(engineSql, async transaction => work({
              query: async (text, params = []) => {
                if (!transaction.query) throw new Error('place lifecycle transaction is unavailable')
                return await transaction.query(text, params) as readonly Record<string, unknown>[]
              },
            })),
          },
          { attemptId: fee.attemptId, leaseOwner: fee.leaseOwner },
        )
        if (completion.state !== 'completed') {
          return await returnFailedTreasuryFee(
            fee,
            resident.id,
            completion.reason,
            409,
          ) as Response
        }
        return completedTreasuryFeeResponse(completion.responseBody, completion.responseStatus, null)
      } catch (error) {
        const nameConflict = postgresErrorCode(error) === '23505'
        const response = await returnFailedTreasuryFee(
          fee,
          resident.id,
          nameConflict
            ? 'that place name is already taken inside its parent'
            : 'place lifecycle act failed before completion',
          nameConflict ? 409 : 503,
        ) as Response
        reportTreasuryCompletionFailure({
          operation,
          rail: fee.rail,
          attemptId: fee.attemptId,
          status: response.status,
        }, error)
        return response
      }
    }
    const fields = [
      'description', 'purpose', 'front_matter_thing_ids',
      'open_to_building', 'open_to_things', 'open_to_notes',
      'drawing', 'drawing_state', 'drawing_description',
    ] as const
    if (!hasOnly(body, fields) || Object.keys(body).length === 0) {
      return err(c, 400, 'place edit body is empty or contains an unsupported field; edit description, purpose, front matter, drawing, or a permission switch')
    }

    const description = body.description === undefined
      ? undefined
      : publicText(body.description, { maximumCharacters: DESCRIPTION_MAX, allowEmpty: true })
    const purpose = parsePlacePurpose(body.purpose)
    const frontMatterThingIds = parsePlaceFrontMatter(body.front_matter_thing_ids)
    const openToBuilding = optionalBoolean(body.open_to_building)
    const openToThings = optionalBoolean(body.open_to_things)
    const openToNotes = optionalBoolean(body.open_to_notes)
    const requestedDrawing = drawingWriteField(body)
    if (!requestedDrawing.ok) return err(c, 400, requestedDrawing.error)
    if (description === null || purpose === null || frontMatterThingIds === null
        || openToBuilding === null || openToThings === null || openToNotes === null) {
      return err(c, 400, 'place edit was rejected because its text, front_matter_thing_ids, or permission switches have an invalid type or value; retry with safe text, an array of thing ids, and boolean permission switches')
    }

    const existingRows = (await sql`
      SELECT p.id, p.owner_id, p.active_offer_id, p.retired_at,
        (offer.id IS NOT NULL) AS has_open_offer
      FROM places p
      LEFT JOIN transfer_offers offer ON offer.asset_type = 'place'
        AND offer.asset_id = p.id AND offer.status = 'open'
      WHERE p.id = ${id}
    `) as Array<{
      id: number
      owner_id: number | null
      active_offer_id: number | null
      has_open_offer?: boolean
      retired_at?: string | null
    }>
    const existing = existingRows[0]
    if (!existing) return err(c, 404, `place_id ${id} was not found; use GET /api/map?view=outline and send a current place_id`)
    if (existing.owner_id === null) return err(c, 403, WORLD_TRANSIT_ONLY_ERROR)
    if (existing.owner_id !== resident.id) return err(c, 403, 'only the place owner may edit it')
    if (existing.retired_at != null) return err(c, 409, 'place is retired; restore it before editing')
    if (existing.active_offer_id != null || openOffer(existing)) {
      return err(c, 409, 'place cannot be edited while it has an open sale offer; close that offer before editing the place')
    }

    if (frontMatterThingIds !== undefined && frontMatterThingIds.length > 0) {
      const eligibleRows = await sql`
        /* room-orientation-eligibility */
        SELECT thing.id
        FROM things thing
        LEFT JOIN LATERAL (
          SELECT moderation.action
          FROM moderation_actions moderation
          WHERE moderation.target_type = 'thing'
            AND moderation.target_id = thing.id
          ORDER BY moderation.created_at DESC, moderation.id DESC
          LIMIT 1
        ) latest_moderation ON TRUE
        WHERE thing.id = ANY(${[...frontMatterThingIds]}::integer[])
          AND thing.place_id = ${id}
          AND thing.withdrawn_at IS NULL
          AND coalesce(latest_moderation.action, 'restore') <> 'remove'
      ` as Array<{ id: number }>
      const eligibleIds = new Set(eligibleRows.map(row => row.id))
      if (!frontMatterThingIds.every(thingId => eligibleIds.has(thingId))) {
        return err(c, 400, 'front matter must use active public things in this place')
      }
    }

    let rows: PlaceRow[]
    try {
      rows = (await sql`
        WITH candidate_locks AS MATERIALIZED (
          SELECT thing.id,
            thing.place_id = ${id}
              AND thing.withdrawn_at IS NULL
              AND coalesce(latest_moderation.action, 'restore') <> 'remove' AS eligible
          FROM things thing
          LEFT JOIN LATERAL (
            SELECT moderation.action
            FROM moderation_actions moderation
            WHERE moderation.target_type = 'thing'
              AND moderation.target_id = thing.id
            ORDER BY moderation.created_at DESC, moderation.id DESC
            LIMIT 1
          ) latest_moderation ON TRUE
          WHERE ${frontMatterThingIds !== undefined}::boolean
            AND thing.id = ANY(${frontMatterThingIds === undefined ? [] : [...frontMatterThingIds]}::integer[])
          ORDER BY thing.id
          FOR UPDATE OF thing
        ), selection_state AS MATERIALIZED (
          SELECT CASE
            WHEN NOT ${frontMatterThingIds !== undefined}::boolean THEN true
            WHEN cardinality(${frontMatterThingIds === undefined ? [] : [...frontMatterThingIds]}::integer[]) = 0 THEN true
            ELSE count(*) = cardinality(${frontMatterThingIds === undefined ? [] : [...frontMatterThingIds]}::integer[])
              AND coalesce(bool_and(eligible), false)
          END AS eligible
          FROM candidate_locks
        ), editable AS MATERIALIZED (
          SELECT p.*
          FROM places p
          CROSS JOIN selection_state selection
          LEFT JOIN transfer_offers offer ON offer.asset_type = 'place'
            AND offer.asset_id = p.id AND offer.status = 'open'
          WHERE p.id = ${id} AND p.owner_id = ${resident.id}
            AND p.retired_at IS NULL
            AND p.active_offer_id IS NULL AND offer.id IS NULL
            AND selection.eligible
          FOR UPDATE OF p
        ), changed AS (
          UPDATE places SET
            description = CASE WHEN ${description !== undefined}::boolean
              THEN ${description ?? ''}::text ELSE description END,
            purpose = CASE WHEN ${purpose !== undefined}::boolean
              THEN ${purpose ?? ''}::text ELSE purpose END,
            front_matter_thing_ids = CASE WHEN ${frontMatterThingIds !== undefined}::boolean
              THEN ${frontMatterThingIds === undefined ? [] : [...frontMatterThingIds]}::integer[]
              ELSE front_matter_thing_ids END,
            open_to_building = coalesce(${openToBuilding ?? null}::boolean, open_to_building),
            open_to_things = coalesce(${openToThings ?? null}::boolean, open_to_things),
            open_to_notes = coalesce(${openToNotes ?? null}::boolean, open_to_notes),
            drawing = CASE WHEN ${requestedDrawing.supplied}::boolean
              THEN ${requestedDrawing.supplied ? requestedDrawing.storedDrawing : null}::jsonb
              ELSE drawing END,
            drawing_state = CASE WHEN ${requestedDrawing.supplied}::boolean
              THEN ${requestedDrawing.supplied ? requestedDrawing.value.state : 'undrawn'}::text
              ELSE drawing_state END,
            drawing_description = CASE WHEN ${requestedDrawing.supplied}::boolean
              THEN ${requestedDrawing.supplied ? requestedDrawing.value.description : null}::text
              ELSE drawing_description END
          WHERE id IN (SELECT id FROM editable)
            AND (
              (${description !== undefined}::boolean
                AND description IS DISTINCT FROM ${description ?? ''}::text)
              OR (${purpose !== undefined}::boolean
                AND purpose IS DISTINCT FROM ${purpose ?? ''}::text)
              OR (${frontMatterThingIds !== undefined}::boolean
                AND front_matter_thing_ids IS DISTINCT FROM
                  ${frontMatterThingIds === undefined ? [] : [...frontMatterThingIds]}::integer[])
              OR (${openToBuilding !== undefined}::boolean
                AND open_to_building IS DISTINCT FROM ${openToBuilding ?? false}::boolean)
              OR (${openToThings !== undefined}::boolean
                AND open_to_things IS DISTINCT FROM ${openToThings ?? false}::boolean)
              OR (${openToNotes !== undefined}::boolean
                AND open_to_notes IS DISTINCT FROM ${openToNotes ?? false}::boolean)
              OR (${requestedDrawing.supplied}::boolean
                AND drawing IS DISTINCT FROM
                  ${requestedDrawing.supplied ? requestedDrawing.storedDrawing : null}::jsonb)
              OR (${requestedDrawing.supplied}::boolean
                AND drawing_state IS DISTINCT FROM
                  ${requestedDrawing.supplied ? requestedDrawing.value.state : 'undrawn'}::text)
              OR (${requestedDrawing.supplied}::boolean
                AND drawing_description IS DISTINCT FROM
                  ${requestedDrawing.supplied ? requestedDrawing.value.description : null}::text)
            )
          RETURNING *
        ), new_drawing_revision AS (
          INSERT INTO drawing_revisions (
            target_type, target_id, slot_variant_name,
            prior_state, prior_description, prior_drawing, prior_source,
            prior_kind_id, prior_kind_revision, prior_variant_name,
            current_state, current_description, current_drawing, current_source,
            current_kind_id, current_kind_revision, current_variant_name,
            author_id, author_relation
          )
          SELECT 'place', changed.id, NULL,
            editable.drawing_state, editable.drawing_description, editable.drawing,
            CASE WHEN editable.drawing_state = 'undrawn' THEN 'none' ELSE 'place' END,
            NULL, NULL, NULL,
            changed.drawing_state, changed.drawing_description, changed.drawing,
            CASE WHEN changed.drawing_state = 'undrawn' THEN 'none' ELSE 'place' END,
            NULL, NULL, NULL,
            ${resident.id}, 'owner'
          FROM changed
          JOIN editable ON editable.id = changed.id
          WHERE ${requestedDrawing.supplied}::boolean
            AND (
              editable.drawing IS DISTINCT FROM changed.drawing
              OR editable.drawing_state IS DISTINCT FROM changed.drawing_state
              OR editable.drawing_description IS DISTINCT FROM changed.drawing_description
            )
          RETURNING id
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'place_edited', ${resident.handle}, jsonb_build_object('place_id', id)
          FROM changed
        ), result AS (
          SELECT changed.* FROM changed
          UNION ALL
          SELECT current.*
          FROM places current
          JOIN editable ON editable.id = current.id
          WHERE NOT EXISTS (SELECT 1 FROM changed)
        )
        SELECT result.*, ${resident.handle}::text AS owner FROM result
      `) as PlaceRow[]
    } catch (error) {
      const code = error != null && typeof error === 'object'
        ? String((error as { code?: unknown }).code ?? '')
        : ''
      if ((code === '23514' || code === '23503') && frontMatterThingIds !== undefined) {
        return err(c, 409, 'front matter eligibility changed; retry')
      }
      throw error
    }
    if (!rows[0]) return err(c, 409, 'place changed or received an open sale offer; retry')
    const frontMatter = await loadPublicPlaceFrontMatter(executePublicQuery, [id])
    return c.json({
      place: publicPlaceWriteRow(rows[0]),
      front_matter: frontMatter.get(id) ?? Object.freeze([]),
    })
  })

  app.put('/api/place/:id/laws', async c => {
    const resident = await requireResident(c)
    if (isResponse(resident)) return resident
    const id = positiveId(c.req.param('id'))
    if (!id) return err(c, 400, 'place id must be a positive integer')
    const body = await jsonBody(c)
    if (!body || !hasOnly(body, ['traits'])) {
      return err(c, 400, 'laws body accepts only traits')
    }
    const traits = lawNames(body.traits)
    if (!traits) return err(c, 400, 'traits must be unique valid world names')
    const updated = await replacePlaceLaws(resident, id, traits)
    if (!('error' in updated)) {
      return c.json({ place_id: id, laws: updated })
    }
    return err(c, updated.status, updated.error)
  })

  app.get('/api/kinds', async c => {
    const queries = c.req.queries()
    const allowed = allowedPublicQuery(queries, ['before_id', 'limit'])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const parsed = parsePublicPage(queries, 'before_id', 'limit')
    if (!parsed.ok) return err(c, 400, parsed.error)
    const rows = await executeBudgetedExactQuery(`
      /* public:kinds */
      WITH totals AS (
        SELECT count(*)::integer AS total_items,
          coalesce(sum(octet_length(revision.description)), 0)::bigint AS total_text_bytes
        FROM kinds kind
        JOIN kind_revisions revision
          ON revision.kind_id = kind.id AND revision.revision = kind.current_revision
      )
      SELECT page.id, page.name, page.owner_id, page.owner,
        page.revision, page.description, page.traits, page.recipe, page.created_at,
        totals.total_items, totals.total_text_bytes
      FROM totals
      LEFT JOIN LATERAL (
        SELECT k.id, k.name, k.owner_id, owner.handle AS owner,
          revision.revision, revision.description, revision.traits, revision.recipe,
          k.created_at
        FROM kinds k
        JOIN residents owner ON owner.id = k.owner_id
        JOIN kind_revisions revision
          ON revision.kind_id = k.id AND revision.revision = k.current_revision
        WHERE ($1::integer IS NULL OR k.id < $1::integer)
        ORDER BY k.id DESC
        LIMIT $2::integer
      ) page ON TRUE
      ORDER BY page.id DESC NULLS LAST
    `, [parsed.cursor, parsed.fetchLimit])
    const collection = extractPublicCollectionRows(rows)
    const page = finalizePublicPage(collection.rows as unknown as readonly KindRow[], parsed.limit)
    return publicJson(c, {
      kinds: await moderatePublicKinds(page.items),
      total_items: collection.total.items,
      total_text_bytes: collection.total.textBytes,
      returned_items: page.items.length,
      returned_text_bytes: utf8TextBytes(page.items, 'description'),
      has_more: page.hasMore,
      next_before_id: page.nextCursor,
    })
  })

  app.post('/api/kind', async c => {
    const resident = await requireResident(c)
    if (isResponse(resident)) return resident
    const selectionConflict = feeSelectionConflict(c)
    if (selectionConflict) return selectionConflict
    const decoded = await readBoundedJsonObject(c.req.raw, DRAWING_RECORD_BODY_MAX_BYTES)
    if (!decoded.ok) {
      return /no larger than/iu.test(decoded.error)
        ? c.json({ error: decoded.error }, 413)
        : err(c, 400, decoded.error)
    }
    const body = decoded.body
    if (!hasOnly(body, [
      'name', 'description', 'traits', 'recipe',
      'drawing', 'drawing_state', 'drawing_description', 'drawing_variants',
    ])) {
      return err(c, 400, 'kind body contains an unsupported field; send only name, description, traits, recipe, drawing, drawing_state, drawing_description, and drawing_variants')
    }
    const requestedDrawing = drawingWriteField(body)
    if (!requestedDrawing.ok) return err(c, 400, requestedDrawing.error)
    const requestedVariants = drawingVariantsField(body)
    if (!requestedVariants.ok) return err(c, 400, requestedVariants.error)
    const name = worldName(body.name)
    const description = publicText(body.description ?? '', {
      maximumCharacters: DESCRIPTION_MAX,
      allowEmpty: true,
    })
    const traits = stringList(body.traits ?? [])
    const recipe = parseKindRecipe(body.recipe ?? [])
    if (!name) return err(c, 400, 'kind name must use lowercase letters, numbers, hyphens, or underscores')
    if (description == null) return err(c, 400, 'description must be at most 4000 safe characters')
    if (!traits) return err(c, 400, 'traits must be a list of at most 32 valid trait names')
    if (hasDuplicateNames(body.traits ?? [], traits)) {
      return err(c, 400, 'traits must not contain duplicate names')
    }
    if (recipe == null) {
      return err(c, 400, 'recipe must be a unique list of {kind, quantity} ingredients within the hard limits')
    }
    if (!await everyTraitExists(traits)) {
      return err(c, 400, 'kind names an unknown or duplicate trait; coin each trait first with POST /api/trait')
    }

    const fee = await treasuryFee(
      c,
      `${DOMAIN}/api/kind`,
      '1F3D9 kind invention fee',
      resident.id,
      {
        operation: 'kind_invention',
        targetKey: `kind-invention:${name}`,
        request: {
          name, description, traits, recipe,
          ...(requestedDrawing.supplied ? drawingRequestFields(requestedDrawing.value) : {}),
          ...(requestedVariants.supplied
            ? { drawing_variants: variantRequestRows(requestedVariants.variants) }
            : {}),
        },
      },
    )
    if (fee instanceof Response) return fee
    try {
      const completion = await completeTreasuryPaymentOperation(
        { query: sql.query },
        { attemptId: fee.attemptId, leaseOwner: fee.leaseOwner },
      )
      if (completion.state !== 'completed') {
        return await reconcileTreasuryCompletionNoEffect(
          c,
          fee,
          resident.id,
          completion.state === 'deadline_passed'
            ? 'kind invention recovery deadline passed before completion'
            : 'kind invention target changed before completion',
        )
      }
      return completedTreasuryFeeResponse(
        completion.responseBody,
        completion.status,
        completion.paymentResponseHeader,
      )
    } catch (error) {
      const unknownTrait = unknownTraitMessage(error)
      const message = conflictMessage(error, 'kind name or payment proof already used')
      if (fee.rail === 'credit') {
        const response = await returnFailedTreasuryFee(
          fee,
          resident.id,
          unknownTrait
            ? 'kind names an unknown or duplicate trait; coin each trait first with POST /api/trait'
            : message ?? 'kind invention failed before completion',
          unknownTrait ? 400 : message ? 409 : 503,
        ) as Response
        reportTreasuryCompletionFailure({
          operation: 'kind_invention',
          rail: fee.rail,
          attemptId: fee.attemptId,
          status: response.status,
        }, error)
        return response
      }
      if (unknownTrait) {
        reportTreasuryCompletionFailure({
          operation: 'kind_invention',
          rail: fee.rail,
          attemptId: fee.attemptId,
          status: 400,
        }, error)
        return err(c, 400, 'kind names an unknown or duplicate trait; coin each trait first with POST /api/trait')
      }
      if (message) {
        const response = await reconcileTreasuryCompletionNoEffect(c, fee, resident.id, message)
        reportTreasuryCompletionFailure({
          operation: 'kind_invention',
          rail: fee.rail,
          attemptId: fee.attemptId,
          status: response.status,
        }, error)
        return response
      }
      throw error
    }
  })

  app.post('/api/kind/:id/revise', async c => {
    const resident = await requireResident(c)
    if (isResponse(resident)) return resident
    const selectionConflict = feeSelectionConflict(c)
    if (selectionConflict) return selectionConflict
    const id = positiveId(c.req.param('id'))
    if (!id) return err(c, 400, 'kind id must be a positive integer')
    const decoded = await readBoundedJsonObject(c.req.raw, DRAWING_RECORD_BODY_MAX_BYTES)
    if (!decoded.ok) {
      return /no larger than/iu.test(decoded.error)
        ? c.json({ error: decoded.error }, 413)
        : err(c, 400, decoded.error)
    }
    const body = decoded.body
    if (!hasOnly(body, [
      'description', 'traits', 'recipe',
      'drawing', 'drawing_state', 'drawing_description', 'drawing_variants',
    ])) {
      return err(c, 400, 'kind revision contains an unsupported field; send only description, traits, recipe, drawing, drawing_state, drawing_description, and drawing_variants')
    }
    const requestedDrawing = drawingWriteField(body)
    if (!requestedDrawing.ok) return err(c, 400, requestedDrawing.error)
    const requestedVariants = drawingVariantsField(body)
    if (!requestedVariants.ok) return err(c, 400, requestedVariants.error)
    const suppliedTraits = body.traits === undefined ? undefined : stringList(body.traits)
    if (suppliedTraits === null) {
      return err(c, 400, 'traits must be a list of at most 32 valid trait names')
    }
    if (suppliedTraits !== undefined && hasDuplicateNames(body.traits, suppliedTraits)) {
      return err(c, 400, 'traits must not contain duplicate names')
    }

    const currentRows = (await sql`
      SELECT k.id, k.name, k.owner_id, k.current_revision AS revision,
        revision.description, revision.traits, revision.recipe, revision.drawing,
        revision.drawing_state, revision.drawing_description, revision.drawing_variants,
        k.active_offer_id, (offer.id IS NOT NULL) AS has_open_offer
      FROM kinds k
      JOIN kind_revisions revision
        ON revision.kind_id = k.id AND revision.revision = k.current_revision
      LEFT JOIN transfer_offers offer ON offer.asset_type = 'kind'
        AND offer.asset_id = k.id AND offer.status = 'open'
      WHERE k.id = ${id}
    `) as Array<KindRow & { active_offer_id: number | null; has_open_offer?: boolean }>
    const current = currentRows[0]
    if (!current) return err(c, 404, `kind_id ${id} was not found; use GET /api/kinds and send a current kind_id`)
    if (current.owner_id !== resident.id) return err(c, 403, 'only the kind owner may revise it')
    if (current.active_offer_id != null || openOffer(current)) {
      return err(c, 409, 'kind cannot be revised while it has an open sale offer; close that offer before revising the kind')
    }

    const description = body.description === undefined
      ? current.description
      : publicText(body.description, { maximumCharacters: DESCRIPTION_MAX, allowEmpty: true })
    const traits = suppliedTraits ?? current.traits
    const recipe = parseKindRecipe(body.recipe === undefined ? current.recipe : body.recipe)
    const currentDrawing = storedDrawingValue(current)
    if (currentDrawing === null) {
      return err(c, 500, 'saved kind drawing cannot be read because its stored record is invalid; the kind owner should save a valid drawing again or contact the city operator')
    }
    const currentVariants = storedDrawingVariants(current.drawing_variants ?? [])
    if (currentVariants === null) {
      return err(c, 500, 'saved kind drawing cannot be read because its stored record is invalid; the kind owner should save a valid drawing again or contact the city operator')
    }
    if (description == null) return err(c, 400, 'description must be at most 4000 safe characters')
    if (recipe == null) {
      return err(c, 400, 'recipe must be a unique list of {kind, quantity} ingredients within the hard limits')
    }
    if (!await everyTraitExists(traits)) {
      return err(c, 400, 'kind revision names an unknown or duplicate trait; coin each trait first with POST /api/trait')
    }
    const revisionDrawing = requestedDrawing.supplied
      ? requestedDrawing.value
      : currentDrawing
    const revisionVariants = requestedVariants.supplied
      ? requestedVariants.variants
      : currentVariants

    const fee = await treasuryFee(
      c,
      `${DOMAIN}/api/kind/${id}/revise`,
      '1F3D9 kind revision fee',
      resident.id,
      {
        operation: 'kind_revision',
        targetKey: `kind-revision:${id}:${current.revision + 1}`,
        assetType: 'kind',
        assetId: id,
        request: {
          kind_id: id, description, traits, recipe,
          ...(requestedDrawing.supplied || revisionDrawing.state !== 'undrawn'
            ? drawingRequestFields(revisionDrawing)
            : {}),
          ...(requestedVariants.supplied || revisionVariants.length > 0
            ? { drawing_variants: variantRequestRows(revisionVariants) }
            : {}),
        },
      },
    )
    if (fee instanceof Response) return fee
    try {
      const completion = await completeTreasuryPaymentOperation(
        { query: sql.query },
        { attemptId: fee.attemptId, leaseOwner: fee.leaseOwner },
      )
      if (completion.state !== 'completed') {
        return await reconcileTreasuryCompletionNoEffect(
          c,
          fee,
          resident.id,
          completion.state === 'deadline_passed'
            ? 'kind revision recovery deadline passed before completion'
            : 'kind revision target changed before completion',
        )
      }
      return completedTreasuryFeeResponse(
        completion.responseBody,
        completion.status,
        completion.paymentResponseHeader,
      )
    } catch (error) {
      const unknownTrait = unknownTraitMessage(error)
      const message = conflictMessage(error, 'payment proof already used')
      if (fee.rail === 'credit') {
        const response = await returnFailedTreasuryFee(
          fee,
          resident.id,
          unknownTrait
            ? 'kind revision names an unknown or duplicate trait; coin each trait first with POST /api/trait'
            : message ?? 'kind revision failed before completion',
          unknownTrait ? 400 : message ? 409 : 503,
        ) as Response
        reportTreasuryCompletionFailure({
          operation: 'kind_revision',
          rail: fee.rail,
          attemptId: fee.attemptId,
          status: response.status,
        }, error)
        return response
      }
      if (unknownTrait) {
        reportTreasuryCompletionFailure({
          operation: 'kind_revision',
          rail: fee.rail,
          attemptId: fee.attemptId,
          status: 400,
        }, error)
        return err(c, 400, 'kind revision names an unknown or duplicate trait; coin each trait first with POST /api/trait')
      }
      if (message) {
        const response = await reconcileTreasuryCompletionNoEffect(c, fee, resident.id, message)
        reportTreasuryCompletionFailure({
          operation: 'kind_revision',
          rail: fee.rail,
          attemptId: fee.attemptId,
          status: response.status,
        }, error)
        return response
      }
      throw error
    }
  })

  app.get('/api/traits', async c => {
    const queries = c.req.queries()
    const allowed = allowedPublicQuery(queries, ['before_id', 'limit'])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const parsed = parsePublicPage(queries, 'before_id', 'limit')
    if (!parsed.ok) return err(c, 400, parsed.error)
    const rows = await executeBudgetedExactQuery(`
      /* public:traits */
      WITH totals AS (
        SELECT count(*)::integer AS total_items,
          coalesce(sum(octet_length(description)), 0)::bigint AS total_text_bytes
        FROM traits
      )
      SELECT page.id, page.name, page.description, page.recipe, page.mechanical,
        page.coiner, page.created_at, totals.total_items, totals.total_text_bytes
      FROM totals
      LEFT JOIN LATERAL (
        SELECT trait.id, trait.name, trait.description, trait.recipe,
          (trait.recipe IS NOT NULL) AS mechanical,
          coiner.handle AS coiner, trait.created_at
        FROM traits trait
        JOIN residents coiner ON coiner.id = trait.coiner_id
        WHERE ($1::integer IS NULL OR trait.id < $1::integer)
        ORDER BY trait.id DESC
        LIMIT $2::integer
      ) page ON TRUE
      ORDER BY page.id DESC NULLS LAST
    `, [parsed.cursor, parsed.fetchLimit])
    const collection = extractPublicCollectionRows(rows)
    const page = finalizePublicPage(
      collection.rows as Array<Record<string, unknown> & { id: number }>,
      parsed.limit,
    )
    return publicJson(c, {
      traits: await moderatePublicRows(
        'trait',
        page.items,
      ),
      total_items: collection.total.items,
      total_text_bytes: collection.total.textBytes,
      returned_items: page.items.length,
      returned_text_bytes: utf8TextBytes(page.items, 'description'),
      has_more: page.hasMore,
      next_before_id: page.nextCursor,
    })
  })

  app.post('/api/trait', async c => {
    const resident = await requireResident(c)
    if (isResponse(resident)) return resident
    const body = await jsonBody(c)
    if (!body) return err(c, 400, 'body must be a JSON object')
    if (!hasOnly(body, ['name', 'description', 'recipe'])) {
      return err(c, 400, 'trait body contains an unsupported field; send only name, description, and an optional inert recipe')
    }
    const name = worldName(body.name)
    const description = publicText(body.description ?? '', {
      maximumCharacters: DESCRIPTION_MAX,
      allowEmpty: true,
    })
    const hasRecipe = Object.hasOwn(body, 'recipe') && body.recipe !== null
    const recipe = hasRecipe ? parseTraitRecipe(body.recipe) : null
    if (!name) return err(c, 400, 'trait name must use lowercase letters, numbers, hyphens, or underscores')
    if (description == null) return err(c, 400, 'description must be at most 4000 safe characters')
    if (hasRecipe && recipe == null) {
      return err(c, 400, 'recipe must use only the frozen actions and effect bricks within the hard limits')
    }

    try {
      const rows = await sql`
        WITH new_trait AS (
          INSERT INTO traits (name, description, recipe, coiner_id)
          VALUES (${name}, ${description}, ${recipe == null ? null : JSON.stringify(recipe)}::jsonb, ${resident.id})
          RETURNING id, name, description, recipe, coiner_id, created_at
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'trait_coined', ${resident.handle}, jsonb_build_object(
            'trait_id', id, 'name', name, 'mechanical', recipe IS NOT NULL
          ) FROM new_trait
        )
        SELECT new_trait.id, new_trait.name, new_trait.description, new_trait.recipe,
          (new_trait.recipe IS NOT NULL) AS mechanical,
          ${resident.handle}::text AS coiner, new_trait.created_at
        FROM new_trait
      `
      return c.json({ trait: rows[0] }, 201)
    } catch (error) {
      const message = conflictMessage(error, 'trait name already exists')
      if (message) return err(c, 409, message)
      throw error
    }
  })

  app.post('/api/thing', async c => {
    const resident = await requireResident(c)
    if (isResponse(resident)) return resident
    const body = await jsonBody(c)
    if (!body) return err(c, 400, 'body must be a JSON object')
    if (!hasOnly(body, ['place_id', 'name', 'body', 'open_to_use', 'kind_id', 'ingredient_ids'])) {
      return err(c, 400, 'thing body contains an unsupported field; send only place_id, name, body, optional open_to_use, optional kind_id, and ingredient_ids')
    }
    const placeId = positiveId(body.place_id)
    const name = publicLabel(body.name)
    if (containsBearerSecret(body.body) || containsBearerSecret(body.name)) return err(c, 400, SECRET_REJECTION)
    const thingBody = publicText(body.body ?? '', { maximumBytes: THING_BODY_MAX_BYTES, allowEmpty: true })
    const openToUse = body.open_to_use === undefined
      ? false
      : typeof body.open_to_use === 'boolean' ? body.open_to_use : null
    const kindId = body.kind_id == null ? null : positiveId(body.kind_id)
    const ingredientIds = body.ingredient_ids ?? []
    if (!placeId) return err(c, 400, 'place_id must be a positive integer')
    if (!name) return err(c, 400, 'name must be one safe line of 1-120 characters')
    if (thingBody == null) return err(c, 400, 'body must be safe text no larger than 64 KB (65536 bytes)')
    if (openToUse === null) return err(c, 400, 'open_to_use must be boolean when present')
    if (body.kind_id != null && !kindId) return err(c, 400, 'kind_id must be a positive integer')
    if (kindId == null && (!Array.isArray(ingredientIds) || ingredientIds.length > 0)) {
      return err(c, 400, 'ingredient_ids must be empty unless kind_id is supplied')
    }

    const placeRows = (await withPlacePermission(sql)`
      SELECT place.id, place.parent_id, place.place_kind, place.owner_id,
        place.retired_at, place.open_to_things,
        ${placePermission('place', 'open_to_things', resident.id)} AS place_permits_things
      FROM places place WHERE place.id = ${placeId}
    `) as Array<{
      id: number
      parent_id: number | null
      place_kind: string
      owner_id: number | null
      open_to_things: boolean
      place_permits_things: boolean
      retired_at: string | null
    }>
    const place = placeRows[0]
    if (!place) return err(c, 404, `place_id ${placeId} was not found; use GET /api/map?view=outline and send a current place_id`)
    if (place.retired_at != null) return err(c, 409, 'place is retired; restore it before making things there')
    if (isWorldRootRow(place)) return err(c, 403, WORLD_TRANSIT_ONLY_ERROR)
    if (place.place_permits_things !== true) {
      return err(c, 403, 'this place does not permit visitors to make things; its owner can enable open_to_things, or you can choose your own or another open place')
    }
    await resolveDueEffects(placeId)

    const made = await makeThingThroughEngine({
      actor: resident,
      placeId,
      name,
      body: thingBody,
      openToUse,
      kindId,
      ingredientIds,
    })
    if (!made.ok) return err(c, made.status, made.error)
    const readingCost = await safeReadingCostMeter(placeId, made.thing.body)
    return c.json(made.consumedIngredientIds === null
      ? { thing: made.thing, reading_cost: readingCost }
      : { thing: made.thing, consumed_ingredient_ids: made.consumedIngredientIds, reading_cost: readingCost }, 201)
  })

  app.patch('/api/thing/:id', async c => {
    const resident = await requireResident(c)
    if (isResponse(resident)) return resident
    const id = positiveId(c.req.param('id'))
    if (!id) return err(c, 400, 'thing id must be a positive integer')
    const decoded = await readBoundedJsonObject(c.req.raw, DRAWING_RECORD_BODY_MAX_BYTES)
    if (!decoded.ok) {
      return /no larger than/iu.test(decoded.error)
        ? c.json({ error: decoded.error }, 413)
        : err(c, 400, decoded.error)
    }
    const body = decoded.body
    if (!hasOnly(body, [
      'name', 'body', 'open_to_use',
      'drawing', 'drawing_state', 'drawing_description', 'drawing_variant_name',
    ]) || Object.keys(body).length === 0) {
      return err(c, 400, 'only name, body, drawing, drawing_variant_name, and open_to_use are editable; birth_revision is permanent')
    }
    if (containsBearerSecret(body.body) || containsBearerSecret(body.name)) return err(c, 400, SECRET_REJECTION)
    const name = body.name === undefined ? undefined : publicLabel(body.name)
    const thingBody = body.body === undefined
      ? undefined
      : publicText(body.body, { maximumBytes: THING_BODY_MAX_BYTES, allowEmpty: true })
    const openToUse = body.open_to_use === undefined
      ? undefined
      : typeof body.open_to_use === 'boolean' ? body.open_to_use : null
    const requestedDrawing = drawingWriteField(body)
    if (!requestedDrawing.ok) return err(c, 400, requestedDrawing.error)
    const requestedVariant = Object.hasOwn(body, 'drawing_variant_name')
      ? drawingVariantName(body.drawing_variant_name)
      : undefined
    if (requestedVariant === 'invalid') {
      return err(c, 400, `drawing_variant_name must be null or a safe one-line label of 1-${DRAWING_VARIANT_NAME_MAX_BYTES} UTF-8 bytes`)
    }
    if (name === null) return err(c, 400, 'name must be one safe line of 1-120 characters')
    if (thingBody === null) return err(c, 400, 'body must be safe text no larger than 64 KB (65536 bytes)')
    if (openToUse === null) return err(c, 400, 'open_to_use must be boolean when present')

    const existingRows = (await sql`
      SELECT thing.id, thing.owner_id, thing.kind_id, thing.current_revision,
        thing.drawing_state, thing.drawing_variant_name, pinned.drawing_variants,
        thing.active_offer_id,
        (offer.id IS NOT NULL) AS has_open_offer
      FROM things thing
      LEFT JOIN kind_revisions pinned
        ON pinned.kind_id = thing.kind_id AND pinned.revision = thing.current_revision
      LEFT JOIN transfer_offers offer ON offer.asset_type = 'thing'
        AND offer.asset_id = thing.id AND offer.status = 'open'
      WHERE thing.id = ${id} AND thing.withdrawn_at IS NULL
    `) as Array<{
      id: number
      owner_id: number
      kind_id: number | null
      current_revision: number | null
      drawing_state?: DrawingState
      drawing_variant_name?: string | null
      drawing_variants?: unknown
      active_offer_id: number | null
      has_open_offer?: boolean
    }>
    const existing = existingRows[0]
    if (!existing) return err(c, 404, `thing_id ${id} was not found; use GET /api/things and send a current active thing_id`)
    if (existing.owner_id !== resident.id) return err(c, 403, 'only the thing owner may edit it')
    if (existing.active_offer_id != null || openOffer(existing)) {
      return err(c, 409, 'thing cannot be edited while it has an open sale offer; close that offer before editing the thing')
    }
    if (existing.kind_id !== null && requestedDrawing.supplied
        && (requestedDrawing.value.state === 'in_progress' || requestedDrawing.value.state === 'complete')) {
      return err(c, 400, 'typed things inherit their pinned kind base or named variant; arbitrary instance pixel drawings are not allowed')
    }
    if (existing.kind_id === null && requestedVariant !== undefined) {
      return err(c, 409, 'an untyped thing has no kind base or drawing variant; omit drawing_variant_name and save an instance drawing instead')
    }
    const resultingDrawingState = requestedDrawing.supplied
      ? requestedDrawing.value.state
      : existing.drawing_state
    if (requestedVariant !== undefined && resultingDrawingState === 'refused') {
      return err(c, 409, 'clear the thing refusal with drawing null before choosing its inherited base or variant')
    }
    const availableVariants = existing.kind_id === null
      ? []
      : storedDrawingVariants(existing.drawing_variants ?? [])
    if (availableVariants === null) {
      return err(c, 500, 'saved kind drawing cannot be read because its stored record is invalid; the kind owner should save a valid drawing again or contact the city operator')
    }
    if (typeof requestedVariant === 'string'
        && !availableVariants.some(variant => variant.name === requestedVariant)) {
      const choices = availableVariants.map(variant => variant.name)
      return err(c, 409, choices.length === 0
        ? 'this pinned kind revision offers no named variants; choose its base with drawing_variant_name null'
        : `drawing_variant_name is not offered by this pinned kind revision; choose base with null or an available variant: ${choices.join(', ')}`)
    }

    const rows = (await sql`
      WITH editable AS MATERIALIZED (
        SELECT thing.*,
          pinned.drawing AS kind_drawing,
          pinned.drawing_state AS kind_drawing_state,
          pinned.drawing_description AS kind_drawing_description,
          selected_variant.value AS kind_variant
        FROM things thing
        LEFT JOIN kind_revisions pinned
          ON pinned.kind_id = thing.kind_id AND pinned.revision = thing.current_revision
        LEFT JOIN LATERAL (
          SELECT variant.value
          FROM jsonb_array_elements(coalesce(pinned.drawing_variants, '[]'::jsonb)) variant(value)
          WHERE variant.value->>'name' = thing.drawing_variant_name
          LIMIT 1
        ) selected_variant ON TRUE
        LEFT JOIN transfer_offers offer ON offer.asset_type = 'thing'
          AND offer.asset_id = thing.id AND offer.status = 'open'
        WHERE thing.id = ${id} AND thing.owner_id = ${resident.id}
          AND thing.withdrawn_at IS NULL
          AND thing.active_offer_id IS NULL AND offer.id IS NULL
        FOR UPDATE OF thing
      ), changed AS (
        UPDATE things SET
          name = coalesce(${name ?? null}::text, name),
          body = coalesce(${thingBody ?? null}::text, body),
          open_to_use = coalesce(${openToUse ?? null}::boolean, open_to_use),
          drawing = CASE WHEN ${requestedDrawing.supplied}::boolean
            THEN ${requestedDrawing.supplied ? requestedDrawing.storedDrawing : null}::jsonb
            ELSE drawing END,
          drawing_state = CASE WHEN ${requestedDrawing.supplied}::boolean
            THEN ${requestedDrawing.supplied ? requestedDrawing.value.state : 'undrawn'}::text
            ELSE drawing_state END,
          drawing_description = CASE WHEN ${requestedDrawing.supplied}::boolean
            THEN ${requestedDrawing.supplied ? requestedDrawing.value.description : null}::text
            ELSE drawing_description END,
          drawing_variant_name = CASE WHEN ${requestedVariant !== undefined}::boolean
            THEN ${requestedVariant ?? null}::text ELSE drawing_variant_name END
        WHERE id IN (SELECT id FROM editable)
          AND (
            (${name !== undefined}::boolean AND name IS DISTINCT FROM ${name ?? null}::text)
            OR (${thingBody !== undefined}::boolean AND body IS DISTINCT FROM ${thingBody ?? null}::text)
            OR (${openToUse !== undefined}::boolean
              AND open_to_use IS DISTINCT FROM ${openToUse ?? null}::boolean)
            OR (${requestedDrawing.supplied}::boolean
              AND drawing IS DISTINCT FROM ${requestedDrawing.supplied ? requestedDrawing.storedDrawing : null}::jsonb)
            OR (${requestedDrawing.supplied}::boolean
              AND drawing_state IS DISTINCT FROM
                ${requestedDrawing.supplied ? requestedDrawing.value.state : 'undrawn'}::text)
            OR (${requestedDrawing.supplied}::boolean
              AND drawing_description IS DISTINCT FROM
                ${requestedDrawing.supplied ? requestedDrawing.value.description : null}::text)
            OR (${requestedVariant !== undefined}::boolean
              AND drawing_variant_name IS DISTINCT FROM ${requestedVariant ?? null}::text)
          )
        RETURNING *
      ), current_presentation AS MATERIALIZED (
        SELECT changed.*,
          pinned.drawing AS kind_drawing,
          pinned.drawing_state AS kind_drawing_state,
          pinned.drawing_description AS kind_drawing_description,
          selected_variant.value AS kind_variant
        FROM changed
        LEFT JOIN kind_revisions pinned
          ON pinned.kind_id = changed.kind_id AND pinned.revision = changed.current_revision
        LEFT JOIN LATERAL (
          SELECT variant.value
          FROM jsonb_array_elements(coalesce(pinned.drawing_variants, '[]'::jsonb)) variant(value)
          WHERE variant.value->>'name' = changed.drawing_variant_name
          LIMIT 1
        ) selected_variant ON TRUE
      ), new_drawing_revision AS (
        INSERT INTO drawing_revisions (
          target_type, target_id, slot_variant_name,
          prior_state, prior_description, prior_drawing, prior_source,
          prior_kind_id, prior_kind_revision, prior_variant_name,
          current_state, current_description, current_drawing, current_source,
          current_kind_id, current_kind_revision, current_variant_name,
          author_id, author_relation
        )
        SELECT 'thing', current.id, NULL,
          CASE
            WHEN prior.kind_id IS NULL OR prior.drawing_state = 'refused' THEN prior.drawing_state
            WHEN prior.drawing_variant_name IS NOT NULL THEN prior.kind_variant->>'state'
            ELSE prior.kind_drawing_state
          END,
          CASE
            WHEN prior.kind_id IS NULL OR prior.drawing_state = 'refused' THEN prior.drawing_description
            WHEN prior.drawing_variant_name IS NOT NULL THEN prior.kind_variant->>'description'
            ELSE prior.kind_drawing_description
          END,
          CASE
            WHEN prior.kind_id IS NULL OR prior.drawing_state = 'refused' THEN prior.drawing
            WHEN prior.drawing_variant_name IS NOT NULL THEN prior.kind_variant->'drawing'
            ELSE prior.kind_drawing
          END,
          CASE
            WHEN prior.kind_id IS NULL THEN CASE WHEN prior.drawing_state = 'undrawn' THEN 'none' ELSE 'thing' END
            WHEN prior.drawing_state = 'refused' THEN 'thing'
            WHEN prior.drawing_variant_name IS NOT NULL THEN 'kind_variant'
            WHEN prior.kind_drawing_state = 'undrawn' THEN 'none'
            ELSE 'kind_base'
          END,
          CASE WHEN prior.kind_id IS NOT NULL AND (
              prior.drawing_state = 'refused'
              OR prior.drawing_variant_name IS NOT NULL
              OR prior.kind_drawing_state <> 'undrawn'
            ) THEN prior.kind_id ELSE NULL END,
          CASE WHEN prior.kind_id IS NOT NULL AND (
              prior.drawing_state = 'refused'
              OR prior.drawing_variant_name IS NOT NULL
              OR prior.kind_drawing_state <> 'undrawn'
            ) THEN prior.current_revision ELSE NULL END,
          CASE WHEN prior.kind_id IS NOT NULL AND prior.drawing_state <> 'refused'
            THEN prior.drawing_variant_name ELSE NULL END,
          CASE
            WHEN current.kind_id IS NULL OR current.drawing_state = 'refused' THEN current.drawing_state
            WHEN current.drawing_variant_name IS NOT NULL THEN current.kind_variant->>'state'
            ELSE current.kind_drawing_state
          END,
          CASE
            WHEN current.kind_id IS NULL OR current.drawing_state = 'refused' THEN current.drawing_description
            WHEN current.drawing_variant_name IS NOT NULL THEN current.kind_variant->>'description'
            ELSE current.kind_drawing_description
          END,
          CASE
            WHEN current.kind_id IS NULL OR current.drawing_state = 'refused' THEN current.drawing
            WHEN current.drawing_variant_name IS NOT NULL THEN current.kind_variant->'drawing'
            ELSE current.kind_drawing
          END,
          CASE
            WHEN current.kind_id IS NULL THEN CASE WHEN current.drawing_state = 'undrawn' THEN 'none' ELSE 'thing' END
            WHEN current.drawing_state = 'refused' THEN 'thing'
            WHEN current.drawing_variant_name IS NOT NULL THEN 'kind_variant'
            WHEN current.kind_drawing_state = 'undrawn' THEN 'none'
            ELSE 'kind_base'
          END,
          CASE WHEN current.kind_id IS NOT NULL AND (
              current.drawing_state = 'refused'
              OR current.drawing_variant_name IS NOT NULL
              OR current.kind_drawing_state <> 'undrawn'
            ) THEN current.kind_id ELSE NULL END,
          CASE WHEN current.kind_id IS NOT NULL AND (
              current.drawing_state = 'refused'
              OR current.drawing_variant_name IS NOT NULL
              OR current.kind_drawing_state <> 'undrawn'
            ) THEN current.current_revision ELSE NULL END,
          CASE WHEN current.kind_id IS NOT NULL AND current.drawing_state <> 'refused'
            THEN current.drawing_variant_name ELSE NULL END,
          ${resident.id}, 'owner'
        FROM current_presentation current
        JOIN editable prior ON prior.id = current.id
        WHERE ${requestedDrawing.supplied || requestedVariant !== undefined}::boolean
          AND (
            prior.drawing IS DISTINCT FROM current.drawing
            OR prior.drawing_state IS DISTINCT FROM current.drawing_state
            OR prior.drawing_description IS DISTINCT FROM current.drawing_description
            OR prior.drawing_variant_name IS DISTINCT FROM current.drawing_variant_name
          )
        RETURNING id
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'thing_edited', ${resident.handle}, jsonb_build_object('thing_id', id)
        FROM changed
      ), result AS (
        SELECT changed.* FROM changed
        UNION ALL
        SELECT thing.*
        FROM things thing
        JOIN editable ON editable.id = thing.id
        WHERE NOT EXISTS (SELECT 1 FROM changed)
      )
      SELECT result.*, maker.handle AS made_by,
        result.owner_id AS current_owner_id,
        current_owner.handle AS current_owner,
        current_owner.handle AS owner,
        kind_definition.name AS kind
      FROM result
      JOIN residents maker ON maker.id = result.maker_id
      JOIN residents current_owner ON current_owner.id = result.owner_id
      LEFT JOIN kinds kind_definition ON kind_definition.id = result.kind_id
    `) as ThingRow[]
    if (!rows[0]) return err(c, 409, 'thing changed or received an open sale offer; retry')
    return c.json({
      thing: rows[0],
      reading_cost: await safeReadingCostMeter(rows[0].place_id, rows[0].body),
    })
  })

  app.post('/api/thing/:id/upgrade', async c => {
    const resident = await requireResident(c)
    if (isResponse(resident)) return resident
    const id = positiveId(c.req.param('id'))
    if (!id) return err(c, 400, 'thing id must be a positive integer')
    const decoded = await optionalDrawingBody(c.req.raw)
    if (!decoded.ok) {
      return /no larger than/iu.test(decoded.error)
        ? c.json({ error: decoded.error }, 413)
        : err(c, 400, decoded.error)
    }
    if (!hasOnly(decoded.body, ['drawing_variant_name'])) {
      return err(c, 400, 'thing upgrade body contains an unsupported field; send only optional drawing_variant_name')
    }
    const requestedVariant = Object.hasOwn(decoded.body, 'drawing_variant_name')
      ? drawingVariantName(decoded.body.drawing_variant_name)
      : undefined
    if (requestedVariant === 'invalid') {
      return err(c, 400, `drawing_variant_name must be null or a safe one-line label of 1-${DRAWING_VARIANT_NAME_MAX_BYTES} UTF-8 bytes`)
    }

    const existingRows = (await sql`
      SELECT thing.id, thing.owner_id, thing.kind_id, thing.birth_revision,
        thing.current_revision, kind.current_revision AS latest_revision,
        thing.drawing_state, thing.drawing_variant_name,
        latest.drawing_variants AS latest_drawing_variants,
        thing.active_offer_id,
        (offer.id IS NOT NULL) AS has_open_offer
      FROM things thing
      LEFT JOIN kinds kind ON kind.id = thing.kind_id
      LEFT JOIN kind_revisions latest
        ON latest.kind_id = kind.id AND latest.revision = kind.current_revision
      LEFT JOIN transfer_offers offer ON offer.asset_type = 'thing'
        AND offer.asset_id = thing.id AND offer.status = 'open'
      WHERE thing.id = ${id} AND thing.withdrawn_at IS NULL
    `) as Array<ThingRow & {
      latest_revision?: number
      drawing_state?: DrawingState
      drawing_variant_name?: string | null
      latest_drawing_variants?: unknown
      drawing_variants?: unknown
      active_offer_id: number | null
      has_open_offer?: boolean
    }>
    const existing = existingRows[0]
    if (!existing) return err(c, 404, `thing_id ${id} was not found; use GET /api/things and send a current active thing_id`)
    if (existing.owner_id !== resident.id) return err(c, 403, 'only the thing owner may upgrade it')
    if (existing.kind_id == null) return err(c, 409, 'an untyped thing has no kind revision to upgrade; edit its instance fields instead of calling upgrade')
    if (existing.active_offer_id != null || openOffer(existing)) {
      return err(c, 409, 'thing cannot be upgraded while it has an open sale offer; close that offer before upgrading the thing')
    }
    if (requestedVariant !== undefined && existing.drawing_state === 'refused') {
      return err(c, 409, 'clear the thing refusal before choosing a base or variant during upgrade')
    }
    const currentVariant = existing.drawing_variant_name ?? null
    const targetVariants = storedDrawingVariants(
      existing.latest_drawing_variants ?? existing.drawing_variants ?? [],
    )
    if (targetVariants === null) return err(c, 500, 'stored target kind drawing variants are invalid; the kind owner should save valid variants or contact the city operator')
    const upgradeVariant = requestedVariant === undefined ? currentVariant : requestedVariant
    if (typeof upgradeVariant === 'string'
        && !targetVariants.some(variant => variant.name === upgradeVariant)) {
      const names = targetVariants.map(variant => variant.name)
      return err(c, 409, names.length === 0
        ? 'the selected variant is absent from the target revision; choose base with drawing_variant_name null'
        : `the selected variant is absent from the target revision; choose base with drawing_variant_name null or an available target variant: ${names.join(', ')}`)
    }

    let rows: ThingRow[]
    try {
      rows = (await sql`
        WITH upgradeable AS MATERIALIZED (
        SELECT thing.*,
          prior_revision.drawing AS prior_kind_drawing,
          prior_revision.drawing_state AS prior_kind_drawing_state,
          prior_revision.drawing_description AS prior_kind_drawing_description,
          prior_variant.value AS prior_kind_variant,
          kind.current_revision AS latest_revision,
          latest_revision.drawing AS target_kind_drawing,
          latest_revision.drawing_state AS target_kind_drawing_state,
          latest_revision.drawing_description AS target_kind_drawing_description,
          target_variant.value AS target_kind_variant
        FROM things thing
        JOIN kinds kind ON kind.id = thing.kind_id
        JOIN kind_revisions latest_revision
          ON latest_revision.kind_id = kind.id
          AND latest_revision.revision = kind.current_revision
        JOIN kind_revisions prior_revision
          ON prior_revision.kind_id = thing.kind_id
          AND prior_revision.revision = thing.current_revision
        LEFT JOIN LATERAL (
          SELECT variant.value
          FROM jsonb_array_elements(coalesce(prior_revision.drawing_variants, '[]'::jsonb)) variant(value)
          WHERE variant.value->>'name' = thing.drawing_variant_name
          LIMIT 1
        ) prior_variant ON TRUE
        LEFT JOIN LATERAL (
          SELECT variant.value
          FROM jsonb_array_elements(coalesce(latest_revision.drawing_variants, '[]'::jsonb)) variant(value)
          WHERE variant.value->>'name' = ${upgradeVariant ?? null}::text
          LIMIT 1
        ) target_variant ON TRUE
        LEFT JOIN transfer_offers offer ON offer.asset_type = 'thing'
          AND offer.asset_id = thing.id AND offer.status = 'open'
        WHERE thing.id = ${id} AND thing.owner_id = ${resident.id}
          AND thing.withdrawn_at IS NULL
          AND thing.active_offer_id IS NULL AND offer.id IS NULL
          AND thing.current_revision = ${existing.current_revision ?? null}::integer
          AND thing.drawing_state IS NOT DISTINCT FROM ${existing.drawing_state ?? 'undrawn'}::text
          AND thing.drawing_variant_name IS NOT DISTINCT FROM ${currentVariant}::text
          AND (${upgradeVariant === null}::boolean OR target_variant.value IS NOT NULL)
          FOR UPDATE OF thing, kind NOWAIT
        ), changed AS (
        UPDATE things SET
          current_revision = upgradeable.latest_revision,
          drawing_variant_name = ${upgradeVariant ?? null}::text
        FROM upgradeable
        WHERE things.id = upgradeable.id
          AND (
            things.current_revision IS DISTINCT FROM upgradeable.latest_revision
            OR things.drawing_variant_name IS DISTINCT FROM ${upgradeVariant ?? null}::text
          )
        RETURNING things.*
      ), new_drawing_revision AS (
        INSERT INTO drawing_revisions (
          target_type, target_id, slot_variant_name,
          prior_state, prior_description, prior_drawing, prior_source,
          prior_kind_id, prior_kind_revision, prior_variant_name,
          current_state, current_description, current_drawing, current_source,
          current_kind_id, current_kind_revision, current_variant_name,
          author_id, author_relation
        )
        SELECT 'thing', changed.id, NULL,
          CASE
            WHEN prior.drawing_state = 'refused' THEN prior.drawing_state
            WHEN prior.drawing_variant_name IS NOT NULL THEN prior.prior_kind_variant->>'state'
            ELSE prior.prior_kind_drawing_state
          END,
          CASE
            WHEN prior.drawing_state = 'refused' THEN prior.drawing_description
            WHEN prior.drawing_variant_name IS NOT NULL THEN prior.prior_kind_variant->>'description'
            ELSE prior.prior_kind_drawing_description
          END,
          CASE
            WHEN prior.drawing_state = 'refused' THEN prior.drawing
            WHEN prior.drawing_variant_name IS NOT NULL THEN prior.prior_kind_variant->'drawing'
            ELSE prior.prior_kind_drawing
          END,
          CASE
            WHEN prior.drawing_state = 'refused' THEN 'thing'
            WHEN prior.drawing_variant_name IS NOT NULL THEN 'kind_variant'
            WHEN prior.prior_kind_drawing_state = 'undrawn' THEN 'none'
            ELSE 'kind_base'
          END,
          CASE WHEN prior.drawing_state = 'refused'
              OR prior.drawing_variant_name IS NOT NULL
              OR prior.prior_kind_drawing_state <> 'undrawn'
            THEN prior.kind_id ELSE NULL END,
          CASE WHEN prior.drawing_state = 'refused'
              OR prior.drawing_variant_name IS NOT NULL
              OR prior.prior_kind_drawing_state <> 'undrawn'
            THEN prior.current_revision ELSE NULL END,
          CASE WHEN prior.drawing_state = 'refused'
            THEN NULL ELSE prior.drawing_variant_name END,
          CASE
            WHEN changed.drawing_state = 'refused' THEN changed.drawing_state
            WHEN ${upgradeVariant !== null}::boolean THEN prior.target_kind_variant->>'state'
            ELSE prior.target_kind_drawing_state
          END,
          CASE
            WHEN changed.drawing_state = 'refused' THEN changed.drawing_description
            WHEN ${upgradeVariant !== null}::boolean THEN prior.target_kind_variant->>'description'
            ELSE prior.target_kind_drawing_description
          END,
          CASE
            WHEN changed.drawing_state = 'refused' THEN changed.drawing
            WHEN ${upgradeVariant !== null}::boolean THEN prior.target_kind_variant->'drawing'
            ELSE prior.target_kind_drawing
          END,
          CASE
            WHEN changed.drawing_state = 'refused' THEN 'thing'
            WHEN ${upgradeVariant !== null}::boolean THEN 'kind_variant'
            WHEN prior.target_kind_drawing_state = 'undrawn' THEN 'none'
            ELSE 'kind_base'
          END,
          CASE WHEN changed.drawing_state = 'refused'
              OR ${upgradeVariant !== null}::boolean
              OR prior.target_kind_drawing_state <> 'undrawn'
            THEN changed.kind_id ELSE NULL END,
          CASE WHEN changed.drawing_state = 'refused'
              OR ${upgradeVariant !== null}::boolean
              OR prior.target_kind_drawing_state <> 'undrawn'
            THEN changed.current_revision ELSE NULL END,
          CASE WHEN changed.drawing_state = 'refused'
            THEN NULL ELSE changed.drawing_variant_name END,
          ${resident.id}, 'owner'
        FROM changed
        JOIN upgradeable prior ON prior.id = changed.id
        RETURNING id
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'thing_upgraded', ${resident.handle}, jsonb_build_object(
          'thing_id', id, 'birth_revision', birth_revision,
          'current_revision', current_revision
        ) FROM changed
      ), result AS (
        SELECT changed.* FROM changed
        UNION ALL
        SELECT thing.*
        FROM things thing
        JOIN upgradeable ON upgradeable.id = thing.id
        WHERE NOT EXISTS (SELECT 1 FROM changed)
      )
        SELECT changed.*, maker.handle AS made_by,
          changed.owner_id AS current_owner_id,
          current_owner.handle AS current_owner,
          current_owner.handle AS owner,
          kind_definition.name AS kind
        FROM result changed
        JOIN residents maker ON maker.id = changed.maker_id
        JOIN residents current_owner ON current_owner.id = changed.owner_id
        LEFT JOIN kinds kind_definition ON kind_definition.id = changed.kind_id
      `) as ThingRow[]
    } catch (error) {
      if (postgresErrorCode(error) === '55P03') {
        return err(c, 409, 'another action is changing this thing or kind; retry this thing upgrade')
      }
      throw error
    }
    if (!rows[0]) return err(c, 409, 'thing changed or received an open sale offer; retry')
    return c.json({ thing: rows[0] })
  })

  app.post('/api/thing/:id/withdraw', async c => {
    const resident = await requireResident(c)
    if (isResponse(resident)) return resident
    const id = positiveId(c.req.param('id'))
    if (!id) return err(c, 400, 'thing id must be a positive integer')
    const withdrawn = await withdrawThing(resident, id)
    if ('error' in withdrawn) return err(c, withdrawn.status as 403 | 404 | 409, withdrawn.error)
    return c.json({ thing: withdrawn })
  })

}
