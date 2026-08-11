import type { Hono } from 'hono'
import { err, QUOTAS } from './core.ts'
import { sql } from './db.ts'
import {
  jsonDocument,
  optionalBoolean,
  positiveId,
  publicLabel,
  publicText,
  stringList,
  worldName,
} from './input.ts'
import {
  CLAIM_FEE_USDC,
} from './pay.ts'
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
  requireResident,
  setPaymentHeader,
  THING_BODY_MAX_BYTES,
  treasuryFee,
  type KindRow,
  type PlaceRow,
  type ThingRow,
} from './world-support.ts'

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
      JOIN residents owner ON owner.id = tree.owner_id
      ORDER BY tree.path
    `) as PlaceRow[]
    return c.json({ places: buildPlaceTree(rows, null) })
  })

  app.get('/api/place/:id', async c => {
    const id = positiveId(c.req.param('id'))
    if (!id) return err(c, 400, 'place id must be a positive integer')

    const places = (await sql`
      SELECT p.id, p.parent_id, p.name, p.description, p.owner_id, owner.handle AS owner,
        p.open_to_building, p.open_to_things, p.open_to_notes, p.created_at
      FROM places p
      JOIN residents owner ON owner.id = p.owner_id
      WHERE p.id = ${id}
    `) as PlaceRow[]
    const place = places[0]
    if (!place) return err(c, 404, 'place not found')

    const [subplaces, things, notes] = await Promise.all([
      sql`
        SELECT p.id, p.parent_id, p.name, p.description, p.owner_id, owner.handle AS owner,
          p.open_to_building, p.open_to_things, p.open_to_notes, p.created_at
        FROM places p JOIN residents owner ON owner.id = p.owner_id
        WHERE p.parent_id = ${id} ORDER BY p.created_at, p.id
      `,
      sql`
        SELECT t.id, t.place_id, t.name, t.body, t.owner_id, owner.handle AS owner,
          t.kind_id, k.name AS kind, t.birth_revision, t.current_revision, t.created_at
        FROM things t
        JOIN residents owner ON owner.id = t.owner_id
        LEFT JOIN kinds k ON k.id = t.kind_id
        WHERE t.place_id = ${id} AND t.withdrawn_at IS NULL
        ORDER BY t.created_at, t.id
      `,
      sql`
        SELECT n.id, n.place_id, author.handle AS author, n.body, n.created_at
        FROM notes n JOIN residents author ON author.id = n.author_id
        WHERE n.place_id = ${id} ORDER BY n.created_at, n.id LIMIT 200
      `,
    ])
    return c.json({ place, subplaces, things, notes })
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
      'payer_wallet',
      'fee_tx_hash',
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

    if (parentId != null) {
      const parents = (await sql`
        SELECT id, owner_id, open_to_building FROM places WHERE id = ${parentId}
      `) as Array<{ id: number; owner_id: number; open_to_building: boolean }>
      const parent = parents[0]
      if (!parent) return err(c, 404, 'parent place not found')
      if (parent.owner_id !== resident.id && !parent.open_to_building) {
        return err(c, 403, 'this place does not permit visitors to build')
      }

      try {
        const rows = (await sql`
          WITH permitted_parent AS (
            SELECT parent.id
            FROM places parent
            WHERE parent.id = ${parentId}
              AND (parent.owner_id = ${resident.id} OR parent.open_to_building)
            FOR UPDATE
          ), new_place AS (
            INSERT INTO places (
              parent_id, name, description, owner_id,
              open_to_building, open_to_things, open_to_notes
            )
            SELECT permitted_parent.id, ${name}, ${description}, ${resident.id},
              ${openToBuilding ?? false}, ${openToThings ?? false}, ${openToNotes ?? false}
            FROM permitted_parent
            RETURNING *
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

    const fee = await treasuryFee(c, body, `${DOMAIN}/api/place`, '1F3D9 frontier founding fee')
    if (fee instanceof Response) return fee
    try {
      const rows = (await sql`
        WITH payment_use AS (
          INSERT INTO payment_uses (tx_hash, purpose, actor_id)
          VALUES (${fee.txHash}, 'frontier', ${resident.id})
          RETURNING tx_hash
        ), new_place AS (
          INSERT INTO places (
            parent_id, name, description, owner_id,
            open_to_building, open_to_things, open_to_notes
          )
          SELECT NULL, ${name}, ${description}, ${resident.id},
            ${openToBuilding ?? false}, ${openToThings ?? false}, ${openToNotes ?? false}
          FROM payment_use
          RETURNING *
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
        )
        SELECT new_place.*, ${resident.handle}::text AS owner FROM new_place
      `) as PlaceRow[]
      const place = rows[0]
      if (!place) return err(c, 409, 'frontier founding could not be completed')
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
      owner_id: number
      active_offer_id: number | null
      has_open_offer?: boolean
    }>
    const existing = existingRows[0]
    if (!existing) return err(c, 404, 'place not found')
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

  app.get('/api/kinds', async c => {
    const kinds = (await sql`
      SELECT k.id, k.name, k.owner_id, owner.handle AS owner,
        revision.revision, revision.description, revision.traits, revision.recipe,
        k.created_at
      FROM kinds k
      JOIN residents owner ON owner.id = k.owner_id
      JOIN kind_revisions revision
        ON revision.kind_id = k.id AND revision.revision = k.current_revision
      ORDER BY k.created_at, k.id
    `) as KindRow[]
    return c.json({ kinds })
  })

  app.post('/api/kind', async c => {
    const resident = await requireResident(c)
    if (isResponse(resident)) return resident
    const body = await jsonBody(c)
    if (!body) return err(c, 400, 'body must be a JSON object')
    if (!hasOnly(body, ['name', 'description', 'traits', 'recipe', 'payer_wallet', 'fee_tx_hash'])) {
      return err(c, 400, 'kind body contains an unsupported field')
    }
    const name = worldName(body.name)
    const description = publicText(body.description ?? '', {
      maximumCharacters: DESCRIPTION_MAX,
      allowEmpty: true,
    })
    const traits = stringList(body.traits ?? [])
    const recipe = jsonDocument(body.recipe ?? [])
    if (!name) return err(c, 400, 'kind name must use lowercase letters, numbers, hyphens, or underscores')
    if (description == null) return err(c, 400, 'description must be at most 4000 safe characters')
    if (!traits) return err(c, 400, 'traits must be a list of at most 32 valid trait names')
    if (hasDuplicateNames(body.traits ?? [], traits)) {
      return err(c, 400, 'traits must not contain duplicate names')
    }
    if (recipe == null) return err(c, 400, 'recipe must be JSON no larger than 64 KB')

    const fee = await treasuryFee(c, body, `${DOMAIN}/api/kind`, '1F3D9 kind invention fee')
    if (fee instanceof Response) return fee
    try {
      const rows = (await sql`
        WITH payment_use AS (
          INSERT INTO payment_uses (tx_hash, purpose, actor_id)
          VALUES (${fee.txHash}, 'kind_invention', ${resident.id})
          RETURNING tx_hash
        ), new_kind AS (
          INSERT INTO kinds (name, owner_id, current_revision)
          SELECT ${name}, ${resident.id}, 1 FROM payment_use
          RETURNING id, name, owner_id, current_revision, created_at
        ), new_revision AS (
          INSERT INTO kind_revisions (kind_id, revision, description, traits, recipe)
          SELECT id, 1, ${description}, ${traits}, ${JSON.stringify(recipe)}::jsonb
          FROM new_kind
          RETURNING kind_id, revision, description, traits, recipe
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
        )
        SELECT new_kind.id, new_kind.name, new_kind.owner_id, ${resident.handle}::text AS owner,
          new_revision.revision, new_revision.description, new_revision.traits,
          new_revision.recipe, new_kind.created_at
        FROM new_kind JOIN new_revision ON new_revision.kind_id = new_kind.id
      `) as KindRow[]
      const returned = rows[0]
      if (!returned) return err(c, 409, 'kind invention could not be completed')
      const kind = { ...returned, revision: 1 }
      setPaymentHeader(c, fee)
      return c.json({ kind, fee_tx: fee.txHash }, 201)
    } catch (error) {
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
    if (!hasOnly(body, ['description', 'traits', 'recipe', 'payer_wallet', 'fee_tx_hash'])) {
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
    const recipe = body.recipe === undefined ? current.recipe : jsonDocument(body.recipe)
    if (description == null) return err(c, 400, 'description must be at most 4000 safe characters')
    if (recipe == null) return err(c, 400, 'recipe must be JSON no larger than 64 KB')

    const fee = await treasuryFee(c, body, `${DOMAIN}/api/kind/${id}/revise`, '1F3D9 kind revision fee')
    if (fee instanceof Response) return fee
    try {
      const rows = (await sql`
        WITH locked_kind AS (
          SELECT k.id, k.name, k.owner_id, k.current_revision
          FROM kinds k
          LEFT JOIN transfer_offers offer ON offer.asset_type = 'kind'
            AND offer.asset_id = k.id AND offer.status = 'open'
          WHERE k.id = ${id} AND k.owner_id = ${resident.id}
            AND k.active_offer_id IS NULL AND offer.id IS NULL
          FOR UPDATE OF k
        ), payment_use AS (
          INSERT INTO payment_uses (tx_hash, purpose, actor_id)
          SELECT ${fee.txHash}, 'kind_revision', ${resident.id} FROM locked_kind
          RETURNING tx_hash
        ), new_revision AS (
          INSERT INTO kind_revisions (kind_id, revision, description, traits, recipe)
          SELECT locked_kind.id, locked_kind.current_revision + 1,
            ${description}, ${traits}, ${JSON.stringify(recipe)}::jsonb
          FROM locked_kind CROSS JOIN payment_use
          RETURNING kind_id, revision, description, traits, recipe
        ), changed_kind AS (
          UPDATE kinds SET current_revision = new_revision.revision
          FROM new_revision
          WHERE kinds.id = new_revision.kind_id
          RETURNING kinds.id, kinds.name, kinds.owner_id, kinds.created_at
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
        )
        SELECT changed_kind.id, changed_kind.name, changed_kind.owner_id,
          ${resident.handle}::text AS owner, new_revision.revision,
          new_revision.description, new_revision.traits, new_revision.recipe,
          changed_kind.created_at
        FROM changed_kind JOIN new_revision ON new_revision.kind_id = changed_kind.id
      `) as KindRow[]
      const kind = rows[0]
      if (!kind) return err(c, 409, 'kind changed or received an open sale offer; retry')
      setPaymentHeader(c, fee)
      return c.json({ kind, fee_tx: fee.txHash })
    } catch (error) {
      const message = conflictMessage(error, 'payment proof already used')
      if (message) return err(c, 409, message)
      throw error
    }
  })

  app.get('/api/traits', async c => {
    const traits = await sql`
      SELECT trait.id, trait.name, trait.description, trait.recipe,
        (trait.recipe IS NOT NULL) AS mechanical,
        coiner.handle AS coiner, trait.created_at
      FROM traits trait
      JOIN residents coiner ON coiner.id = trait.coiner_id
      ORDER BY trait.created_at, trait.id
    `
    return c.json({ traits })
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
    const recipe = hasRecipe ? jsonDocument(body.recipe) : null
    if (!name) return err(c, 400, 'trait name must use lowercase letters, numbers, hyphens, or underscores')
    if (description == null) return err(c, 400, 'description must be at most 4000 safe characters')
    if (hasRecipe && recipe == null) return err(c, 400, 'recipe must be JSON no larger than 64 KB')

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
    if (!hasOnly(body, ['place_id', 'name', 'body', 'kind_id'])) {
      return err(c, 400, 'thing accepts place_id, name, body, and optional kind_id')
    }
    const placeId = positiveId(body.place_id)
    const name = publicLabel(body.name)
    const thingBody = publicText(body.body ?? '', { maximumBytes: THING_BODY_MAX_BYTES, allowEmpty: true })
    const kindId = body.kind_id == null ? null : positiveId(body.kind_id)
    if (!placeId) return err(c, 400, 'place_id must be a positive integer')
    if (!name) return err(c, 400, 'name must be one safe line of 1-120 characters')
    if (thingBody == null) return err(c, 400, 'body must be safe text no larger than 64 KB (65536 bytes)')
    if (body.kind_id != null && !kindId) return err(c, 400, 'kind_id must be a positive integer')

    const placeRows = (await sql`
      SELECT id, owner_id, open_to_things FROM places WHERE id = ${placeId}
    `) as Array<{ id: number; owner_id: number; open_to_things: boolean }>
    const place = placeRows[0]
    if (!place) return err(c, 404, 'place not found')
    if (place.owner_id !== resident.id && !place.open_to_things) {
      return err(c, 403, 'this place does not permit visitors to make things')
    }

    if (kindId != null) {
      const kindRows = (await sql`
        SELECT id, current_revision AS revision FROM kinds WHERE id = ${kindId}
      `) as Array<{ id: number; revision: number }>
      const kind = kindRows[0]
      if (!kind) return err(c, 404, 'kind not found')
    }

    const rows = (await sql`
      WITH permitted_place AS (
        SELECT place.id
        FROM places place
        WHERE place.id = ${placeId}
          AND (place.owner_id = ${resident.id} OR place.open_to_things)
        FOR UPDATE
      ), selected_kind AS (
        SELECT kind.id, kind.current_revision
        FROM kinds kind
        WHERE kind.id = ${kindId}
        FOR SHARE
      ), quota_spend AS (
        UPDATE residents SET things_today = things_today + 1
        WHERE id = ${resident.id}
          AND things_today < ${QUOTAS.things}
          AND EXISTS (SELECT 1 FROM permitted_place)
          AND (${kindId}::integer IS NULL OR EXISTS (SELECT 1 FROM selected_kind))
        RETURNING id
      ), new_thing AS (
        INSERT INTO things (
          place_id, name, body, owner_id, kind_id, birth_revision, current_revision
        )
        SELECT permitted_place.id, ${name}, ${thingBody}, ${resident.id}, selected_kind.id,
          selected_kind.current_revision, selected_kind.current_revision
        FROM permitted_place CROSS JOIN quota_spend
        LEFT JOIN selected_kind ON true
        RETURNING *
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'thing_created', ${resident.handle}, jsonb_build_object(
          'thing_id', id, 'place_id', place_id, 'name', name,
          'kind_id', kind_id, 'birth_revision', birth_revision
        ) FROM new_thing
      )
      SELECT new_thing.*, ${resident.handle}::text AS owner,
        kind_definition.name AS kind
      FROM new_thing
      LEFT JOIN kinds kind_definition ON kind_definition.id = new_thing.kind_id
    `) as ThingRow[]
    if (!rows[0]) {
      const quotaRows = (await sql`
        SELECT things_today < ${QUOTAS.things} AS available
        FROM residents WHERE id = ${resident.id}
      `) as Array<{ available: boolean }>
      if (quotaRows[0]?.available === false) {
        return err(c, 429, `daily thing limit reached (${QUOTAS.things})`)
      }
      return err(c, 409, 'place or kind changed before the thing could be made; retry')
    }
    return c.json({ thing: rows[0] }, 201)
  })

  app.patch('/api/thing/:id', async c => {
    const resident = await requireResident(c)
    if (isResponse(resident)) return resident
    const id = positiveId(c.req.param('id'))
    if (!id) return err(c, 400, 'thing id must be a positive integer')
    const body = await jsonBody(c)
    if (!body) return err(c, 400, 'body must be a JSON object')
    if (!hasOnly(body, ['name', 'body']) || Object.keys(body).length === 0) {
      return err(c, 400, 'only name and body are editable; birth_revision is permanent')
    }
    const name = body.name === undefined ? undefined : publicLabel(body.name)
    const thingBody = body.body === undefined
      ? undefined
      : publicText(body.body, { maximumBytes: THING_BODY_MAX_BYTES, allowEmpty: true })
    if (name === null) return err(c, 400, 'name must be one safe line of 1-120 characters')
    if (thingBody === null) return err(c, 400, 'body must be safe text no larger than 64 KB (65536 bytes)')

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
          body = coalesce(${thingBody ?? null}::text, body)
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
}
