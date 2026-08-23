import type { Hono } from 'hono'
import { err } from './core.ts'
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
import { moderatePlaceDetails, moderatePublicKinds, moderatePublicRows } from './moderation-store.ts'
import { effectiveLaws, residentPresence, resolveDueEffects } from './engine.ts'
import { withdrawThing } from './withdrawal.ts'
import { lawNames, replacePlaceLaws } from './laws.ts'
import { makeThingThroughEngine } from './thing-making.ts'
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
import { safeReadingCostMeter } from './reading-cost.ts'
import { executeBudgetedExactQuery } from './public-exact-query.ts'
import { cachedPublicMapOutline, readPublicMapOutline } from './public-map.ts'
import {
  loadPublicChangeCheckpoint,
  parsePublicChangeMarker,
  PublicChangeFutureError,
} from './public-changes.ts'
import {
  loadPublicPlaceFrontMatter,
  parsePlaceFrontMatter,
  parsePlacePurpose,
} from './room-orientation.ts'

const executePublicQuery: PublicQueryExecutor = async (text, params) =>
  await sql.query(text, [...params]) as Record<string, unknown>[]

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
      WHERE p.parent_id IS NULL
      UNION ALL
      SELECT child.id, child.parent_id, child.name, child.description, child.purpose, child.owner_id,
        child.open_to_building, child.open_to_things, child.open_to_notes, child.created_at,
        parent.path || child.id
      FROM places child
      JOIN place_tree parent ON parent.id = child.parent_id
      WHERE NOT child.id = ANY(parent.path)
    )
    SELECT tree.id, tree.parent_id, tree.name, tree.description, tree.purpose, tree.owner_id,
      owner.handle AS owner, tree.open_to_building, tree.open_to_things,
      tree.open_to_notes, tree.created_at,
      (SELECT count(*)::int FROM places child WHERE child.parent_id = tree.id) AS places,
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
      let changeMarker: string | null = null
      if (minimumMarker !== null) {
        changeMarker = await loadPublicChangeCheckpoint(executePublicQuery)
        if (BigInt(minimumMarker) > BigInt(changeMarker)) {
          return err(c, 409, new PublicChangeFutureError(minimumMarker, changeMarker).message)
        }
      }
      const outline = minimumMarker === null
        ? await cachedPublicMapOutline(parentId, page.cursor, page.limit)
        : await readPublicMapOutline(parentId, page.cursor, page.limit)
      if (!outline) return err(c, 404, 'place not found')
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
    const places = (await sql`
      SELECT p.id, p.parent_id, p.name, p.description, p.purpose,
        p.owner_id, owner.handle AS owner,
        p.open_to_building, p.open_to_things, p.open_to_notes, p.created_at
      FROM places p
      LEFT JOIN residents owner ON owner.id = p.owner_id
      WHERE p.id = ${id}
    `) as PlaceRow[]
    const place = places[0]
    if (!place) return err(c, 404, 'place not found')

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
    const [[publicPlace], publicSubplaces, publicDetails, publicNotes] = await Promise.all([
      moderatePublicRows('place', [place]),
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
    const rows = await sql`
      SELECT thing.id, thing.place_id, thing.name, thing.body,
        thing.maker_id, maker.handle AS made_by,
        thing.owner_id AS current_owner_id, owner.handle AS current_owner,
        thing.owner_id, owner.handle AS owner, thing.open_to_use,
        thing.kind_id, kind.name AS kind,
        thing.birth_revision, thing.current_revision, thing.created_at
      FROM things thing
      JOIN residents maker ON maker.id = thing.maker_id
      JOIN residents owner ON owner.id = thing.owner_id
      LEFT JOIN kinds kind ON kind.id = thing.kind_id
      WHERE thing.id = ${id} AND thing.withdrawn_at IS NULL
    ` as ThingRow[]
    if (!rows[0]) return err(c, 404, 'thing not found')
    const publicDetails = await moderatePlaceDetails(rows, [])
    return publicJson(c, { thing: publicDetails.things[0] })
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
      return err(c, 400, 'place body contains an unsupported field')
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
      const parents = (await sql`
        SELECT id, parent_id, place_kind, owner_id, open_to_building
        FROM places WHERE id = ${parentId}
      `) as Array<{
        id: number
        parent_id: number | null
        place_kind: string
        owner_id: number | null
        open_to_building: boolean
      }>
      const parent = parents[0]
      if (!parent) return err(c, 404, 'parent place not found')
      if (isWorldRootRow(parent)) {
        // An explicit world parent is the same paid frontier operation as the
        // long-standing parent_id:null request. It is never a free build.
      } else if (c.req.header('x-1f3d9-fee-credit')) {
        return err(c, 400, 'city fee credit is only supported for the paid frontier, kind invention, or kind revision fee')
      } else if (parent.owner_id !== resident.id && !parent.open_to_building) {
        return err(c, 403, 'this place does not permit visitors to build')
      } else try {
        const rows = (await sql`
          WITH permitted_parent AS (
            SELECT parent.id
            FROM places parent
            WHERE parent.id = ${parentId}
              AND (parent.owner_id = ${resident.id} OR parent.open_to_building)
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
        return await returnFailedTreasuryFee(
          fee,
          resident.id,
          message ?? 'frontier founding failed before completion',
          message ? 409 : 503,
        ) as Response
      }
      if (message) {
        return await reconcileTreasuryCompletionNoEffect(c, fee, resident.id, message)
      }
      throw error
    }
  })

  app.patch('/api/place/:id', async c => {
    const resident = await requireResident(c)
    if (isResponse(resident)) return resident
    const id = positiveId(c.req.param('id'))
    if (!id) return err(c, 400, 'place id must be a positive integer')
    const body = await jsonBody(c)
    if (!body) return err(c, 400, 'body must be a JSON object')
    const fields = [
      'description', 'purpose', 'front_matter_thing_ids',
      'open_to_building', 'open_to_things', 'open_to_notes',
    ] as const
    if (!hasOnly(body, fields) || Object.keys(body).length === 0) {
      return err(c, 400, 'edit description, purpose, front matter, or a permission switch')
    }

    const description = body.description === undefined
      ? undefined
      : publicText(body.description, { maximumCharacters: DESCRIPTION_MAX, allowEmpty: true })
    const purpose = parsePlacePurpose(body.purpose)
    const frontMatterThingIds = parsePlaceFrontMatter(body.front_matter_thing_ids)
    const openToBuilding = optionalBoolean(body.open_to_building)
    const openToThings = optionalBoolean(body.open_to_things)
    const openToNotes = optionalBoolean(body.open_to_notes)
    if (description === null || purpose === null || frontMatterThingIds === null
        || openToBuilding === null || openToThings === null || openToNotes === null) {
      return err(c, 400, 'place text, front matter, or permissions are invalid')
    }

    const existingRows = (await sql`
      SELECT p.id, p.owner_id, p.active_offer_id,
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
    }>
    const existing = existingRows[0]
    if (!existing) return err(c, 404, 'place not found')
    if (existing.owner_id === null) return err(c, 403, WORLD_TRANSIT_ONLY_ERROR)
    if (existing.owner_id !== resident.id) return err(c, 403, 'only the place owner may edit it')
    if (existing.active_offer_id != null || openOffer(existing)) {
      return err(c, 409, 'place cannot be edited while it has an open sale offer')
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
          SELECT p.id
          FROM places p
          CROSS JOIN selection_state selection
          LEFT JOIN transfer_offers offer ON offer.asset_type = 'place'
            AND offer.asset_id = p.id AND offer.status = 'open'
          WHERE p.id = ${id} AND p.owner_id = ${resident.id}
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
            open_to_notes = coalesce(${openToNotes ?? null}::boolean, open_to_notes)
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
            )
          RETURNING *
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
    const body = await jsonBody(c)
    if (!body) return err(c, 400, 'body must be a JSON object')
    if (!hasOnly(body, ['name', 'description', 'traits', 'recipe'])) {
      return err(c, 400, 'kind body contains an unsupported field')
    }
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
        request: { name, description, traits, recipe },
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
        return await returnFailedTreasuryFee(
          fee,
          resident.id,
          unknownTrait ? `kind ${unknownTrait}` : message ?? 'kind invention failed before completion',
          unknownTrait ? 400 : message ? 409 : 503,
        ) as Response
      }
      if (unknownTrait) return err(c, 400, `kind ${unknownTrait}`)
      if (message) {
        return await reconcileTreasuryCompletionNoEffect(c, fee, resident.id, message)
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
    const body = await jsonBody(c)
    if (!body) return err(c, 400, 'body must be a JSON object')
    if (!hasOnly(body, ['description', 'traits', 'recipe'])) {
      return err(c, 400, 'kind revision contains an unsupported field')
    }
    const suppliedTraits = body.traits === undefined ? undefined : stringList(body.traits)
    if (suppliedTraits === null) {
      return err(c, 400, 'traits must be a list of at most 32 valid trait names')
    }
    if (suppliedTraits !== undefined && hasDuplicateNames(body.traits, suppliedTraits)) {
      return err(c, 400, 'traits must not contain duplicate names')
    }

    const currentRows = (await sql`
      SELECT k.id, k.name, k.owner_id, k.current_revision AS revision,
        revision.description, revision.traits, revision.recipe,
        k.active_offer_id, (offer.id IS NOT NULL) AS has_open_offer
      FROM kinds k
      JOIN kind_revisions revision
        ON revision.kind_id = k.id AND revision.revision = k.current_revision
      LEFT JOIN transfer_offers offer ON offer.asset_type = 'kind'
        AND offer.asset_id = k.id AND offer.status = 'open'
      WHERE k.id = ${id}
    `) as Array<KindRow & { active_offer_id: number | null; has_open_offer?: boolean }>
    const current = currentRows[0]
    if (!current) return err(c, 404, 'kind not found')
    if (current.owner_id !== resident.id) return err(c, 403, 'only the kind owner may revise it')
    if (current.active_offer_id != null || openOffer(current)) {
      return err(c, 409, 'kind cannot be revised while it has an open sale offer')
    }

    const description = body.description === undefined
      ? current.description
      : publicText(body.description, { maximumCharacters: DESCRIPTION_MAX, allowEmpty: true })
    const traits = suppliedTraits ?? current.traits
    const recipe = parseKindRecipe(body.recipe === undefined ? current.recipe : body.recipe)
    if (description == null) return err(c, 400, 'description must be at most 4000 safe characters')
    if (recipe == null) {
      return err(c, 400, 'recipe must be a unique list of {kind, quantity} ingredients within the hard limits')
    }
    if (!await everyTraitExists(traits)) {
      return err(c, 400, 'kind revision names an unknown or duplicate trait; coin each trait first with POST /api/trait')
    }

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
        request: { kind_id: id, description, traits, recipe },
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
        return await returnFailedTreasuryFee(
          fee,
          resident.id,
          unknownTrait
            ? `kind revision ${unknownTrait}`
            : message ?? 'kind revision failed before completion',
          unknownTrait ? 400 : message ? 409 : 503,
        ) as Response
      }
      if (unknownTrait) return err(c, 400, `kind revision ${unknownTrait}`)
      if (message) {
        return await reconcileTreasuryCompletionNoEffect(c, fee, resident.id, message)
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
      return err(c, 400, 'trait accepts name, description, and an optional inert recipe')
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
      return err(c, 400, 'thing accepts place_id, name, body, optional open_to_use, optional kind_id, and ingredient_ids')
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

    const placeRows = (await sql`
      SELECT id, parent_id, place_kind, owner_id, open_to_things
      FROM places WHERE id = ${placeId}
    `) as Array<{
      id: number
      parent_id: number | null
      place_kind: string
      owner_id: number | null
      open_to_things: boolean
    }>
    const place = placeRows[0]
    if (!place) return err(c, 404, 'place not found')
    if (isWorldRootRow(place)) return err(c, 403, WORLD_TRANSIT_ONLY_ERROR)
    if (place.owner_id !== resident.id && !place.open_to_things) {
      return err(c, 403, 'this place does not permit visitors to make things')
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
    const body = await jsonBody(c)
    if (!body) return err(c, 400, 'body must be a JSON object')
    if (!hasOnly(body, ['name', 'body', 'open_to_use']) || Object.keys(body).length === 0) {
      return err(c, 400, 'only name, body, and open_to_use are editable; birth_revision is permanent')
    }
    if (containsBearerSecret(body.body) || containsBearerSecret(body.name)) return err(c, 400, SECRET_REJECTION)
    const name = body.name === undefined ? undefined : publicLabel(body.name)
    const thingBody = body.body === undefined
      ? undefined
      : publicText(body.body, { maximumBytes: THING_BODY_MAX_BYTES, allowEmpty: true })
    const openToUse = body.open_to_use === undefined
      ? undefined
      : typeof body.open_to_use === 'boolean' ? body.open_to_use : null
    if (name === null) return err(c, 400, 'name must be one safe line of 1-120 characters')
    if (thingBody === null) return err(c, 400, 'body must be safe text no larger than 64 KB (65536 bytes)')
    if (openToUse === null) return err(c, 400, 'open_to_use must be boolean when present')

    const existingRows = (await sql`
      SELECT thing.id, thing.owner_id, thing.active_offer_id,
        (offer.id IS NOT NULL) AS has_open_offer
      FROM things thing
      LEFT JOIN transfer_offers offer ON offer.asset_type = 'thing'
        AND offer.asset_id = thing.id AND offer.status = 'open'
      WHERE thing.id = ${id} AND thing.withdrawn_at IS NULL
    `) as Array<{
      id: number
      owner_id: number
      active_offer_id: number | null
      has_open_offer?: boolean
    }>
    const existing = existingRows[0]
    if (!existing) return err(c, 404, 'thing not found')
    if (existing.owner_id !== resident.id) return err(c, 403, 'only the thing owner may edit it')
    if (existing.active_offer_id != null || openOffer(existing)) {
      return err(c, 409, 'thing cannot be edited while it has an open sale offer')
    }

    const rows = (await sql`
      WITH editable AS (
        SELECT thing.id
        FROM things thing
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
          open_to_use = coalesce(${openToUse ?? null}::boolean, open_to_use)
        WHERE id IN (SELECT id FROM editable)
        RETURNING *
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'thing_edited', ${resident.handle}, jsonb_build_object('thing_id', id)
        FROM changed
      )
      SELECT changed.*, maker.handle AS made_by,
        changed.owner_id AS current_owner_id,
        current_owner.handle AS current_owner,
        current_owner.handle AS owner,
        kind_definition.name AS kind
      FROM changed
      JOIN residents maker ON maker.id = changed.maker_id
      JOIN residents current_owner ON current_owner.id = changed.owner_id
      LEFT JOIN kinds kind_definition ON kind_definition.id = changed.kind_id
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

    const existingRows = (await sql`
      SELECT thing.id, thing.owner_id, thing.kind_id, thing.birth_revision,
        thing.current_revision, kind.current_revision AS latest_revision,
        thing.active_offer_id,
        (offer.id IS NOT NULL) AS has_open_offer
      FROM things thing
      LEFT JOIN kinds kind ON kind.id = thing.kind_id
      LEFT JOIN transfer_offers offer ON offer.asset_type = 'thing'
        AND offer.asset_id = thing.id AND offer.status = 'open'
      WHERE thing.id = ${id} AND thing.withdrawn_at IS NULL
    `) as Array<ThingRow & {
      latest_revision?: number
      active_offer_id: number | null
      has_open_offer?: boolean
    }>
    const existing = existingRows[0]
    if (!existing) return err(c, 404, 'thing not found')
    if (existing.owner_id !== resident.id) return err(c, 403, 'only the thing owner may upgrade it')
    if (existing.kind_id == null) return err(c, 409, 'an untyped thing has no kind revision to upgrade')
    if (existing.active_offer_id != null || openOffer(existing)) {
      return err(c, 409, 'thing cannot be upgraded while it has an open sale offer')
    }

    const rows = (await sql`
      WITH upgradeable AS (
        SELECT thing.id, kind.current_revision AS latest_revision
        FROM things thing
        JOIN kinds kind ON kind.id = thing.kind_id
        LEFT JOIN transfer_offers offer ON offer.asset_type = 'thing'
          AND offer.asset_id = thing.id AND offer.status = 'open'
        WHERE thing.id = ${id} AND thing.owner_id = ${resident.id}
          AND thing.withdrawn_at IS NULL
          AND thing.active_offer_id IS NULL AND offer.id IS NULL
        FOR UPDATE OF thing
      ), changed AS (
        UPDATE things SET current_revision = upgradeable.latest_revision
        FROM upgradeable
        WHERE things.id = upgradeable.id
        RETURNING things.*
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'thing_upgraded', ${resident.handle}, jsonb_build_object(
          'thing_id', id, 'birth_revision', birth_revision,
          'current_revision', current_revision
        ) FROM changed
      )
      SELECT changed.*, maker.handle AS made_by,
        changed.owner_id AS current_owner_id,
        current_owner.handle AS current_owner,
        current_owner.handle AS owner,
        kind_definition.name AS kind
      FROM changed
      JOIN residents maker ON maker.id = changed.maker_id
      JOIN residents current_owner ON current_owner.id = changed.owner_id
      LEFT JOIN kinds kind_definition ON kind_definition.id = changed.kind_id
    `) as ThingRow[]
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
