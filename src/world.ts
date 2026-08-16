import type { Hono } from 'hono'
import { auth, err } from './core.ts'
import { sql } from './db.ts'
import {
  optionalBoolean,
  positiveId,
  publicLabel,
  publicText,
  stringList,
  worldName, containsBearerSecret, SECRET_REJECTION } from './input.ts'
import {
  CLAIM_FEE_USDC,
  TREASURY,
} from './pay.ts'
import { parseKindRecipe, parseTraitRecipe } from './physics.ts'
import { moderatePlaceDetails, moderatePublicKinds, moderatePublicRows } from './moderation-store.ts'
import { effectiveLaws, residentPresence, resolveDueEffects } from './engine.ts'
import { withdrawThing } from './withdrawal.ts'
import { lawNames, replacePlaceLaws } from './laws.ts'
import { makeThingThroughEngine } from './thing-making.ts'
import {
  isWorldRootRow,
  WORLD_ROOT_NAME,
  WORLD_TRANSIT_ONLY_ERROR,
} from './world-root.ts'
import {
  buildPlaceTree,
  conflictMessage,
  DESCRIPTION_MAX,
  DOMAIN,
  hasDuplicateNames,
  hasOnly,
  isResponse,
  jsonBody,
  openOffer,
  releasePaymentLease,
  requireResident,
  setPaymentHeader,
  THING_BODY_MAX_BYTES,
  treasuryFee,
  unknownTraitMessage,
  type KindRow,
  type PlaceRow,
  type ThingRow,
} from './world-support.ts'
import {
  finalizePublicPage,
  loadPublicPlaceCollectionRows,
  parsePublicPage,
  type PublicQueryExecutor,
} from './public-pagination.ts'

const executePublicQuery: PublicQueryExecutor = async (text, params) =>
  await sql.query(text, [...params]) as Record<string, unknown>[]

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

export function mountWorldRoutes(app: Hono): void {
  app.get('/api/map', async c => {
    const rows = (await sql`
      WITH RECURSIVE place_tree AS (
        SELECT p.id, p.parent_id, p.name, p.description, p.owner_id,
          p.open_to_building, p.open_to_things, p.open_to_notes, p.created_at,
          ARRAY[p.id] AS path
        FROM places p
        WHERE p.parent_id IS NULL
        UNION ALL
        SELECT child.id, child.parent_id, child.name, child.description, child.owner_id,
          child.open_to_building, child.open_to_things, child.open_to_notes, child.created_at,
          parent.path || child.id
        FROM places child
        JOIN place_tree parent ON parent.id = child.parent_id
        WHERE NOT child.id = ANY(parent.path)
      )
      SELECT tree.id, tree.parent_id, tree.name, tree.description, tree.owner_id,
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
    return c.json({ places: buildPlaceTree(publicRows as PlaceRow[], null) })
  })

  app.get('/api/place/:id', async c => {
    const id = positiveId(c.req.param('id'))
    if (!id) return err(c, 400, 'place id must be a positive integer')
    const query = c.req.queries()
    const subplaceRequest = parsePublicPage(query, 'before_subplace_id', 'subplace_limit', 'limit')
    if (!subplaceRequest.ok) return err(c, 400, subplaceRequest.error)
    const thingRequest = parsePublicPage(query, 'before_thing_id', 'thing_limit', 'limit')
    if (!thingRequest.ok) return err(c, 400, thingRequest.error)
    const noteRequest = parsePublicPage(query, 'before_note_id', 'note_limit', 'limit')
    if (!noteRequest.ok) return err(c, 400, noteRequest.error)
    const observer = await auth(c)
    if (observer) await resolveDueEffects(id)

    const places = (await sql`
      SELECT p.id, p.parent_id, p.name, p.description, p.owner_id, owner.handle AS owner,
        p.open_to_building, p.open_to_things, p.open_to_notes, p.created_at
      FROM places p
      LEFT JOIN residents owner ON owner.id = p.owner_id
      WHERE p.id = ${id}
    `) as PlaceRow[]
    const place = places[0]
    if (!place) return err(c, 404, 'place not found')

    const [collections, labels, laws] = await Promise.all([
      loadPublicPlaceCollectionRows(executePublicQuery, id, {
        subplaces: subplaceRequest,
        things: thingRequest,
        notes: noteRequest,
      }),
      activePlaceLabels(id),
      effectiveLaws(id),
    ])
    const subplacesPage = finalizePublicPage(
      collections.subplaces as unknown as readonly (PlaceRow & { id: number })[],
      subplaceRequest.limit,
    )
    const thingsPage = finalizePublicPage(
      collections.things as unknown as readonly (ThingRow & { id: number })[],
      thingRequest.limit,
    )
    const notesPage = finalizePublicPage(
      collections.notes as Array<Record<string, unknown> & { id: number }>,
      noteRequest.limit,
    )
    const [[publicPlace], publicSubplaces, publicDetails, publicNotes] = await Promise.all([
      moderatePublicRows('place', [place]),
      moderatePublicRows('place', subplacesPage.items),
      moderatePlaceDetails(thingsPage.items, laws),
      moderatePublicRows('note', notesPage.items),
    ])
    return c.json({
      place: { ...publicPlace, labels, laws: publicDetails.laws },
      subplaces: publicSubplaces,
      things: publicDetails.things,
      notes: publicNotes,
      subplaces_page: {
        has_more: subplacesPage.hasMore,
        next_before_subplace_id: subplacesPage.nextCursor,
      },
      things_page: {
        has_more: thingsPage.hasMore,
        next_before_thing_id: thingsPage.nextCursor,
      },
      notes_page: {
        has_more: notesPage.hasMore,
        next_before_note_id: notesPage.nextCursor,
      },
    })
  })

  app.get('/api/thing/:id', async c => {
    const id = positiveId(c.req.param('id'))
    if (!id) return err(c, 400, 'thing id must be a positive integer')
    const rows = await sql`
      SELECT thing.id, thing.place_id, thing.name, thing.body,
        thing.owner_id, owner.handle AS owner, thing.open_to_use,
        thing.kind_id, kind.name AS kind,
        thing.birth_revision, thing.current_revision, thing.created_at
      FROM things thing
      JOIN residents owner ON owner.id = thing.owner_id
      LEFT JOIN kinds kind ON kind.id = thing.kind_id
      WHERE thing.id = ${id} AND thing.withdrawn_at IS NULL
    ` as ThingRow[]
    if (!rows[0]) return err(c, 404, 'thing not found')
    const publicDetails = await moderatePlaceDetails(rows, [])
    return c.json({ thing: publicDetails.things[0] })
  })

  app.post('/api/place', async c => {
    const resident = await requireResident(c)
    if (isResponse(resident)) return resident
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
        return c.json({ place: rows[0] }, 201)
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
      const rows = (await sql`
        WITH world_root AS MATERIALIZED (
          SELECT root.id
          FROM places root
          WHERE root.parent_id IS NULL AND root.owner_id IS NULL
            AND root.place_kind = 'world'
            AND root.name = ${WORLD_ROOT_NAME}
            AND (${parentId}::integer IS NULL OR root.id = ${parentId})
          ORDER BY root.id LIMIT 1
          FOR SHARE
        ), world_root_parent AS MATERIALIZED (
          SELECT id FROM world_root
          UNION ALL
          SELECT NULL::integer
          WHERE ${body.parent_id === null}
            AND NOT EXISTS (SELECT 1 FROM world_root)
          LIMIT 1
        ), payment_attempt AS MATERIALIZED (
          SELECT public_id
          FROM payment_attempts
          WHERE public_id = ${fee.attemptId}
            AND lease_owner = ${fee.leaseOwner}
            AND status = 'payment_pending'
            AND tx_hash = ${fee.txHash}
            AND actor_id = ${resident.id}
            AND operation = 'frontier'
          FOR UPDATE
        ), new_place AS (
          INSERT INTO places (
            parent_id, place_kind, name, description, owner_id,
            open_to_building, open_to_things, open_to_notes
          )
          SELECT world_root_parent.id, 'continent', ${name}, ${description}, ${resident.id},
            ${openToBuilding ?? false}, ${openToThings ?? false}, ${openToNotes ?? false}
          FROM world_root_parent CROSS JOIN payment_attempt
          RETURNING *
        ), payment_use AS (
          INSERT INTO payment_uses (
            tx_hash, payment_attempt_id, purpose, actor_id,
            payer_wallet, payee_wallet, amount_usdc
          )
          SELECT ${fee.txHash}, ${fee.attemptId}, 'frontier', ${resident.id},
            ${fee.payerWallet}, ${TREASURY}, ${CLAIM_FEE_USDC}
          FROM new_place
          RETURNING tx_hash
        ), new_presence AS (
          INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
          SELECT ${resident.id}, id, id FROM new_place
          ON CONFLICT (resident_id) DO NOTHING
        ), new_fee AS (
          INSERT INTO fees (resident_id, purpose, amount_usdc, tx_hash)
          SELECT ${resident.id}, 'frontier', ${CLAIM_FEE_USDC}, payment_use.tx_hash
          FROM payment_use JOIN new_place ON true
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'place_created', ${resident.handle}, jsonb_build_object(
            'place_id', id, 'parent_id', parent_id, 'name', name,
            'frontier', true, 'fee_tx_hash', ${fee.txHash}::text
          ) FROM new_place
        ), completed_attempt AS (
          SELECT complete_payment_attempt(
            ${fee.attemptId},
            ${fee.leaseOwner},
            jsonb_build_object('kind', 'place', 'id', new_place.id),
            201::smallint,
            jsonb_build_object(
              'place', to_jsonb(new_place) || jsonb_build_object('owner', ${resident.handle}::text),
              'fee_tx', ${fee.txHash}::text
            )
          ) AS attempt
          FROM new_place CROSS JOIN payment_use
        )
        SELECT new_place.*, ${resident.handle}::text AS owner
        FROM new_place CROSS JOIN completed_attempt
      `) as PlaceRow[]
      const place = rows[0]
      if (!place) {
        await releasePaymentLease(fee)
        return c.json({
          payment: 'pending',
          payment_attempt_id: fee.attemptId,
          fee_tx: fee.txHash,
          do_not_pay_again: true,
          retry: 'retry this same request with the same X-PAYMENT header',
        }, 202)
      }
      setPaymentHeader(c, fee)
      return c.json({ place, fee_tx: fee.txHash }, 201)
    } catch (error) {
      const message = conflictMessage(error, 'place name or payment proof already used')
      if (message) return err(c, 409, message)
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
    const fields = ['description', 'open_to_building', 'open_to_things', 'open_to_notes'] as const
    if (!hasOnly(body, fields) || Object.keys(body).length === 0) {
      return err(c, 400, 'edit description or one of the three permission switches')
    }

    const description = body.description === undefined
      ? undefined
      : publicText(body.description, { maximumCharacters: DESCRIPTION_MAX, allowEmpty: true })
    const openToBuilding = optionalBoolean(body.open_to_building)
    const openToThings = optionalBoolean(body.open_to_things)
    const openToNotes = optionalBoolean(body.open_to_notes)
    if (description === null || openToBuilding === null || openToThings === null || openToNotes === null) {
      return err(c, 400, 'description must be safe text and permissions must be booleans')
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

    const rows = (await sql`
      WITH editable AS (
        SELECT p.id
        FROM places p
        LEFT JOIN transfer_offers offer ON offer.asset_type = 'place'
          AND offer.asset_id = p.id AND offer.status = 'open'
        WHERE p.id = ${id} AND p.owner_id = ${resident.id}
          AND p.active_offer_id IS NULL AND offer.id IS NULL
        FOR UPDATE OF p
      ), changed AS (
        UPDATE places SET
          description = coalesce(${description ?? null}::text, description),
          open_to_building = coalesce(${openToBuilding ?? null}::boolean, open_to_building),
          open_to_things = coalesce(${openToThings ?? null}::boolean, open_to_things),
          open_to_notes = coalesce(${openToNotes ?? null}::boolean, open_to_notes)
        WHERE id IN (SELECT id FROM editable)
        RETURNING *
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'place_edited', ${resident.handle}, jsonb_build_object('place_id', id)
        FROM changed
      )
      SELECT changed.*, ${resident.handle}::text AS owner FROM changed
    `) as PlaceRow[]
    if (!rows[0]) return err(c, 409, 'place changed or received an open sale offer; retry')
    return c.json({ place: rows[0] })
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
    const parsed = parsePublicPage(c.req.queries(), 'before_id', 'limit')
    if (!parsed.ok) return err(c, 400, parsed.error)
    const rows = await executePublicQuery(`
      /* public:kinds */
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
    `, [parsed.cursor, parsed.fetchLimit])
    const page = finalizePublicPage(rows as unknown as readonly KindRow[], parsed.limit)
    return c.json({
      kinds: await moderatePublicKinds(page.items),
      has_more: page.hasMore,
      next_before_id: page.nextCursor,
    })
  })

  app.post('/api/kind', async c => {
    const resident = await requireResident(c)
    if (isResponse(resident)) return resident
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
      const rows = (await sql`
        WITH payment_attempt AS MATERIALIZED (
          SELECT public_id
          FROM payment_attempts
          WHERE public_id = ${fee.attemptId}
            AND lease_owner = ${fee.leaseOwner}
            AND status = 'payment_pending'
            AND tx_hash = ${fee.txHash}
            AND actor_id = ${resident.id}
            AND operation = 'kind_invention'
          FOR UPDATE
        ), new_kind AS (
          INSERT INTO kinds (name, owner_id, current_revision)
          SELECT ${name}, ${resident.id}, 1 FROM payment_attempt
          RETURNING id, name, owner_id, current_revision, created_at
        ), new_revision AS (
          INSERT INTO kind_revisions (kind_id, revision, description, traits, recipe)
          SELECT id, 1, ${description}, ${traits}, ${JSON.stringify(recipe)}::jsonb
          FROM new_kind
          RETURNING kind_id, revision, description, traits, recipe
        ), payment_use AS (
          INSERT INTO payment_uses (
            tx_hash, payment_attempt_id, purpose, actor_id,
            payer_wallet, payee_wallet, amount_usdc
          )
          SELECT ${fee.txHash}, ${fee.attemptId}, 'kind_invention', ${resident.id},
            ${fee.payerWallet}, ${TREASURY}, ${CLAIM_FEE_USDC}
          FROM new_revision
          RETURNING tx_hash
        ), new_fee AS (
          INSERT INTO fees (resident_id, purpose, amount_usdc, tx_hash)
          SELECT ${resident.id}, 'kind_invention', ${CLAIM_FEE_USDC}, payment_use.tx_hash
          FROM payment_use JOIN new_kind ON true
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'kind_invented', ${resident.handle}, jsonb_build_object(
            'kind_id', new_kind.id, 'name', new_kind.name,
            'revision', new_revision.revision, 'fee_tx_hash', ${fee.txHash}::text
          ) FROM new_kind JOIN new_revision ON new_revision.kind_id = new_kind.id
        ), result_row AS (
          SELECT new_kind.id, new_kind.name, new_kind.owner_id, ${resident.handle}::text AS owner,
            new_revision.revision, new_revision.description, new_revision.traits,
            new_revision.recipe, new_kind.created_at
          FROM new_kind JOIN new_revision ON new_revision.kind_id = new_kind.id
        ), completed_attempt AS (
          SELECT complete_payment_attempt(
            ${fee.attemptId},
            ${fee.leaseOwner},
            jsonb_build_object('kind', 'kind_revision', 'id', result_row.id, 'revision', result_row.revision),
            201::smallint,
            jsonb_build_object('kind', to_jsonb(result_row), 'fee_tx', ${fee.txHash}::text)
          ) AS attempt
          FROM result_row CROSS JOIN payment_use
        )
        SELECT result_row.* FROM result_row CROSS JOIN completed_attempt
      `) as KindRow[]
      const returned = rows[0]
      if (!returned) {
        await releasePaymentLease(fee)
        return c.json({
          payment: 'pending',
          payment_attempt_id: fee.attemptId,
          fee_tx: fee.txHash,
          do_not_pay_again: true,
          retry: 'retry this same request with the same X-PAYMENT header',
        }, 202)
      }
      const kind = { ...returned, revision: 1 }
      setPaymentHeader(c, fee)
      return c.json({ kind, fee_tx: fee.txHash }, 201)
    } catch (error) {
      const unknownTrait = unknownTraitMessage(error)
      if (unknownTrait) return err(c, 400, `kind ${unknownTrait}`)
      const message = conflictMessage(error, 'kind name or payment proof already used')
      if (message) return err(c, 409, message)
      throw error
    }
  })

  app.post('/api/kind/:id/revise', async c => {
    const resident = await requireResident(c)
    if (isResponse(resident)) return resident
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
      const rows = (await sql`
        WITH payment_attempt AS MATERIALIZED (
          SELECT public_id
          FROM payment_attempts
          WHERE public_id = ${fee.attemptId}
            AND lease_owner = ${fee.leaseOwner}
            AND status = 'payment_pending'
            AND tx_hash = ${fee.txHash}
            AND actor_id = ${resident.id}
            AND operation = 'kind_revision'
            AND asset_type = 'kind' AND asset_id = ${id}
          FOR UPDATE
        ), locked_kind AS (
          SELECT k.id, k.name, k.owner_id, k.current_revision
          FROM kinds k
          LEFT JOIN transfer_offers offer ON offer.asset_type = 'kind'
            AND offer.asset_id = k.id AND offer.status = 'open'
          WHERE k.id = ${id} AND k.owner_id = ${resident.id}
            AND k.active_offer_id IS NULL AND offer.id IS NULL
          FOR UPDATE OF k
        ), new_revision AS (
          INSERT INTO kind_revisions (kind_id, revision, description, traits, recipe)
          SELECT locked_kind.id, locked_kind.current_revision + 1,
            ${description}, ${traits}, ${JSON.stringify(recipe)}::jsonb
          FROM locked_kind CROSS JOIN payment_attempt
          RETURNING kind_id, revision, description, traits, recipe
        ), changed_kind AS (
          UPDATE kinds SET current_revision = new_revision.revision
          FROM new_revision
          WHERE kinds.id = new_revision.kind_id
          RETURNING kinds.id, kinds.name, kinds.owner_id, kinds.created_at
        ), payment_use AS (
          INSERT INTO payment_uses (
            tx_hash, payment_attempt_id, purpose, actor_id,
            payer_wallet, payee_wallet, amount_usdc
          )
          SELECT ${fee.txHash}, ${fee.attemptId}, 'kind_revision', ${resident.id},
            ${fee.payerWallet}, ${TREASURY}, ${CLAIM_FEE_USDC}
          FROM changed_kind
          RETURNING tx_hash
        ), new_fee AS (
          INSERT INTO fees (resident_id, purpose, amount_usdc, tx_hash)
          SELECT ${resident.id}, 'kind_revision', ${CLAIM_FEE_USDC}, payment_use.tx_hash
          FROM payment_use JOIN changed_kind ON true
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'kind_revised', ${resident.handle}, jsonb_build_object(
            'kind_id', changed_kind.id, 'name', changed_kind.name,
            'revision', new_revision.revision, 'fee_tx_hash', ${fee.txHash}::text
          ) FROM changed_kind JOIN new_revision ON new_revision.kind_id = changed_kind.id
        ), result_row AS (
          SELECT changed_kind.id, changed_kind.name, changed_kind.owner_id,
            ${resident.handle}::text AS owner, new_revision.revision,
            new_revision.description, new_revision.traits, new_revision.recipe,
            changed_kind.created_at
          FROM changed_kind JOIN new_revision ON new_revision.kind_id = changed_kind.id
        ), completed_attempt AS (
          SELECT complete_payment_attempt(
            ${fee.attemptId},
            ${fee.leaseOwner},
            jsonb_build_object('kind', 'kind_revision', 'id', result_row.id, 'revision', result_row.revision),
            200::smallint,
            jsonb_build_object('kind', to_jsonb(result_row), 'fee_tx', ${fee.txHash}::text)
          ) AS attempt
          FROM result_row CROSS JOIN payment_use
        )
        SELECT result_row.* FROM result_row CROSS JOIN completed_attempt
      `) as KindRow[]
      const kind = rows[0]
      if (!kind) {
        await releasePaymentLease(fee)
        return c.json({
          payment: 'pending',
          payment_attempt_id: fee.attemptId,
          fee_tx: fee.txHash,
          do_not_pay_again: true,
          retry: 'retry this same request with the same X-PAYMENT header',
        }, 202)
      }
      setPaymentHeader(c, fee)
      return c.json({ kind, fee_tx: fee.txHash })
    } catch (error) {
      const unknownTrait = unknownTraitMessage(error)
      if (unknownTrait) return err(c, 400, `kind revision ${unknownTrait}`)
      const message = conflictMessage(error, 'payment proof already used')
      if (message) return err(c, 409, message)
      throw error
    }
  })

  app.get('/api/traits', async c => {
    const parsed = parsePublicPage(c.req.queries(), 'before_id', 'limit')
    if (!parsed.ok) return err(c, 400, parsed.error)
    const rows = await executePublicQuery(`
      /* public:traits */
      SELECT trait.id, trait.name, trait.description, trait.recipe,
        (trait.recipe IS NOT NULL) AS mechanical,
        coiner.handle AS coiner, trait.created_at
      FROM traits trait
      JOIN residents coiner ON coiner.id = trait.coiner_id
      WHERE ($1::integer IS NULL OR trait.id < $1::integer)
      ORDER BY trait.id DESC
      LIMIT $2::integer
    `, [parsed.cursor, parsed.fetchLimit])
    const page = finalizePublicPage(
      rows as Array<Record<string, unknown> & { id: number }>,
      parsed.limit,
    )
    return c.json({
      traits: await moderatePublicRows(
        'trait',
        page.items,
      ),
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
    return c.json(made.consumedIngredientIds === null
      ? { thing: made.thing }
      : { thing: made.thing, consumed_ingredient_ids: made.consumedIngredientIds }, 201)
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
      SELECT changed.*, ${resident.handle}::text AS owner,
        kind_definition.name AS kind
      FROM changed
      LEFT JOIN kinds kind_definition ON kind_definition.id = changed.kind_id
    `) as ThingRow[]
    if (!rows[0]) return err(c, 409, 'thing changed or received an open sale offer; retry')
    return c.json({ thing: rows[0] })
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
      SELECT changed.*, ${resident.handle}::text AS owner,
        kind_definition.name AS kind
      FROM changed
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
