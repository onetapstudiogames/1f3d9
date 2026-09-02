import { HANDLE_RE, QUOTAS } from './core.ts'
import { publicLabel, publicText } from './input.ts'
import {
  MAX_CRAFT_INGREDIENTS,
  parseKindRecipe,
  type KindRecipe,
} from './physics.ts'
import { isWorldRootRow, WORLD_TRANSIT_ONLY_ERROR } from './world-root.ts'
import { placePermission, withPlacePermission } from './place-permission.ts'

export type CraftSqlRow = Readonly<Record<string, unknown>>

/** The tagged-template subset shared by Neon and the route-test fake. */
export interface CraftSql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<readonly CraftSqlRow[]>
}

export interface CraftActorInput {
  readonly id: unknown
  readonly handle: unknown
}

export interface CraftThingInput {
  readonly actor: CraftActorInput
  readonly kindId: unknown
  readonly placeId: unknown
  readonly name: unknown
  readonly body: unknown
  readonly openToUse?: unknown
  readonly ingredientIds: unknown
}

export interface CraftedThing {
  readonly id: number
  readonly place_id: number
  readonly name: string
  readonly body: string
  readonly maker_id: number
  readonly made_by: string
  readonly current_owner_id: number
  readonly current_owner: string
  readonly owner_id: number
  readonly owner: string
  readonly open_to_use: boolean
  readonly kind_id: number
  readonly birth_revision: number
  readonly current_revision: number
  readonly created_at: string
  readonly withdrawn_at: null
  readonly kind: string
}

export type CraftFailureStatus = 400 | 403 | 404 | 409 | 429

export type CraftResult =
  | Readonly<{
    ok: true
    status: 201
    thing: CraftedThing
    consumedIngredientIds: readonly number[]
  }>
  | Readonly<{
    ok: false
    status: CraftFailureStatus
    error: string
  }>

export interface CraftOptions {
  readonly dailyThingLimit?: number
}

interface ValidCraftInput {
  readonly actorId: number
  readonly actorHandle: string
  readonly kindId: number
  readonly placeId: number
  readonly name: string
  readonly body: string
  readonly openToUse: boolean
  readonly ingredientIds: readonly number[]
}

interface KindRow {
  readonly id: number
  readonly name: string
  readonly current_revision: number
  readonly recipe: unknown
}

interface PlaceRow {
  readonly id: number
  readonly parent_id: number | null
  readonly place_kind: string
  readonly owner_id: number | null
  readonly open_to_things: boolean
  readonly retired_at: unknown
  readonly place_permits_things: boolean
}

interface IngredientRow {
  readonly id: number
  readonly owner_id: number
  readonly place_id: number
  readonly withdrawn_at: unknown
  readonly active_offer_id: unknown
  readonly has_open_offer: boolean
  readonly kind: unknown
}

const THING_BODY_MAX_BYTES = 65_536
function failure(status: CraftFailureStatus, error: string): CraftResult {
  return Object.freeze({ ok: false, status, error })
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function optionalBoolean(value: unknown): boolean | null {
  return value === undefined ? false : typeof value === 'boolean' ? value : null
}

function ingredientIdList(value: unknown): readonly number[] | null {
  if (!Array.isArray(value) || value.length > MAX_CRAFT_INGREDIENTS) return null
  const ids: number[] = []
  const seen = new Set<number>()
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return null
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null
    const id = positiveInteger(descriptor.value)
    if (id === null || seen.has(id)) return null
    seen.add(id)
    ids.push(id)
  }
  return Object.freeze(ids)
}

function validateRequest(input: CraftThingInput): ValidCraftInput | null {
  if (!input || typeof input !== 'object') return null
  const actorId = positiveInteger(input.actor?.id)
  const actorHandle = typeof input.actor?.handle === 'string' && HANDLE_RE.test(input.actor.handle)
    ? input.actor.handle
    : null
  const kindId = positiveInteger(input.kindId)
  const placeId = positiveInteger(input.placeId)
  const name = publicLabel(input.name)
  const body = publicText(input.body, {
    maximumBytes: THING_BODY_MAX_BYTES,
    allowEmpty: true,
  })
  const openToUse = optionalBoolean(input.openToUse)
  const ingredientIds = ingredientIdList(input.ingredientIds)
  if (
    actorId === null
    || actorHandle === null
    || kindId === null
    || placeId === null
    || name === null
    || body === null
    || openToUse === null
    || ingredientIds === null
  ) return null
  return Object.freeze({ actorId, actorHandle, kindId, placeId, name, body, openToUse, ingredientIds })
}

function exactRecipeMatch(recipe: KindRecipe, ingredients: readonly IngredientRow[]): boolean {
  const actual = new Map<string, number>()
  for (const ingredient of ingredients) {
    if (typeof ingredient.kind !== 'string') return false
    const kind = ingredient.kind.toLowerCase()
    actual.set(kind, (actual.get(kind) ?? 0) + 1)
  }
  if (actual.size !== recipe.length) return false
  return recipe.every(requirement => actual.get(requirement.kind) === requirement.quantity)
}

function allIngredientsEligible(
  ingredients: readonly IngredientRow[],
  input: ValidCraftInput,
): boolean {
  return ingredients.every(ingredient => (
    ingredient.owner_id === input.actorId
    && ingredient.place_id === input.placeId
    && ingredient.withdrawn_at == null
    && ingredient.active_offer_id == null
    && ingredient.has_open_offer !== true
    && typeof ingredient.kind === 'string'
  ))
}

function craftedThing(row: CraftSqlRow): CraftedThing {
  return Object.freeze({
    id: Number(row.id),
    place_id: Number(row.place_id),
    name: String(row.name),
    body: String(row.body),
    maker_id: Number(row.maker_id),
    made_by: String(row.made_by),
    current_owner_id: Number(row.current_owner_id),
    current_owner: String(row.current_owner),
    owner_id: Number(row.owner_id),
    owner: String(row.owner),
    open_to_use: row.open_to_use === true,
    kind_id: Number(row.kind_id),
    birth_revision: Number(row.birth_revision),
    current_revision: Number(row.current_revision),
    created_at: String(row.created_at),
    withdrawn_at: null,
    kind: String(row.kind),
  })
}

/**
 * Make one thing from a kind's current recipe.
 *
 * Reads classify useful 4xx errors. All quota, ingredient, output, and event
 * mutations happen in one SQL statement that re-checks every mutable fact.
 */
export async function craftKindThing(
  sql: CraftSql,
  request: CraftThingInput,
  options: CraftOptions = {},
): Promise<CraftResult> {
  const input = validateRequest(request)
  const dailyThingLimit = options.dailyThingLimit ?? QUOTAS.things
  if (!input || !Number.isSafeInteger(dailyThingLimit) || dailyThingLimit < 1) {
    return failure(400, 'crafting request was rejected because its resident, kind, place, body, or open_to_use value is invalid; retry with the documented craft fields and limits')
  }

  const kindRows = await sql`
    /* crafting:kind */
    SELECT kind.id, kind.name, kind.current_revision, revision.recipe
    FROM kinds AS kind
    JOIN kind_revisions AS revision
      ON revision.kind_id = kind.id AND revision.revision = kind.current_revision
    WHERE kind.id = ${input.kindId}
  `
  const kind = kindRows[0] as KindRow | undefined
  if (!kind) return failure(404, `kind_id ${input.kindId} was not found; use GET /api/kinds and send a current kind_id`)

  const placeRows = await withPlacePermission(sql)`
    /* crafting:place */
    SELECT place.id, place.parent_id, place.place_kind, place.owner_id, place.open_to_things,
      place.retired_at,
      ${placePermission('place', 'open_to_things', input.actorId)} AS place_permits_things
    FROM places place
    WHERE place.id = ${input.placeId}
  `
  const place = placeRows[0] as PlaceRow | undefined
  if (!place) return failure(404, `place_id ${input.placeId} was not found; use GET /api/map?view=outline and send a current place_id`)
  if (isWorldRootRow(place)) return failure(403, WORLD_TRANSIT_ONLY_ERROR)
  if (place.retired_at != null) {
    return failure(409, 'place is retired; restore it before making things there')
  }
  if (place.place_permits_things !== true) {
    return failure(409, 'target place does not accept things; its owner can enable open_to_things, or you can craft in your own or another open place')
  }

  const recipe = parseKindRecipe(kind.recipe)
  if (!recipe) {
    return failure(409, 'kind recipe is invalid; its owner must revise it before anyone can craft this kind')
  }

  if (recipe.length > 0) {
    const requiredNames = recipe.map(ingredient => ingredient.kind)
    const knownRows = await sql`
      /* crafting:known-kinds */
      SELECT lower(name) AS name
      FROM kinds
      WHERE lower(name) = ANY(${requiredNames}::text[])
    `
    const knownNames = new Set(knownRows.map(row => String(row.name).toLowerCase()))
    if (requiredNames.some(name => !knownNames.has(name))) {
      return failure(409, 'kind recipe references kinds that do not exist yet; coin every named kind before retrying this recipe')
    }
  }

  let ingredients: readonly IngredientRow[] = Object.freeze([])
  if (input.ingredientIds.length > 0) {
    ingredients = await sql`
      /* crafting:ingredients */
      SELECT ingredient.id, ingredient.owner_id, ingredient.place_id,
        ingredient.withdrawn_at, ingredient.active_offer_id,
        definition.name AS kind,
        EXISTS (
          SELECT 1 FROM transfer_offers AS offer
          WHERE offer.asset_type = 'thing'
            AND offer.asset_id = ingredient.id
            AND offer.status = 'open'
        ) AS has_open_offer
      FROM things AS ingredient
      LEFT JOIN kinds AS definition ON definition.id = ingredient.kind_id
      WHERE ingredient.id = ANY(${input.ingredientIds}::integer[])
    ` as unknown as readonly IngredientRow[]
  }

  if (!allIngredientsEligible(ingredients, input)) {
    return failure(
      409,
      'every ingredient must be active, owned by you, in the requested place_id, and not offered for sale',
    )
  }
  if (ingredients.length !== input.ingredientIds.length || !exactRecipeMatch(recipe, ingredients)) {
    return failure(409, 'ingredients do not exactly match the current recipe; re-read the kind and retry with every required ingredient in its exact quantity')
  }

  const recipeJson = JSON.stringify(recipe)
  const outputRows = await withPlacePermission(sql)`
    /* crafting:commit */
    WITH utc_day AS (
      SELECT (now() AT TIME ZONE 'utc')::date AS day
    ), locked_kind AS MATERIALIZED (
      SELECT kind.id, kind.name, kind.current_revision
      FROM kinds AS kind
      JOIN kind_revisions AS revision
        ON revision.kind_id = kind.id AND revision.revision = kind.current_revision
      WHERE kind.id = ${input.kindId}
        AND kind.current_revision = ${kind.current_revision}
      FOR UPDATE OF kind
      FOR SHARE OF revision
    ), locked_place AS MATERIALIZED (
      SELECT place.id
      FROM places AS place
      WHERE place.id = ${input.placeId}
        AND place.retired_at IS NULL
        AND ${placePermission('place', 'open_to_things', input.actorId)}
        AND place.owner_id IS NOT NULL
      FOR UPDATE OF place
    ), required AS MATERIALIZED (
      SELECT requirement.kind, requirement.quantity
      FROM jsonb_to_recordset(${recipeJson}::jsonb)
        AS requirement(kind text, quantity integer)
    ), locked_ingredients AS MATERIALIZED (
      SELECT ingredient.id, lower(definition.name) AS kind
      FROM things AS ingredient
      JOIN kinds AS definition ON definition.id = ingredient.kind_id
      WHERE ingredient.id = ANY(${input.ingredientIds}::integer[])
        AND ingredient.owner_id = ${input.actorId}
        AND ingredient.place_id = ${input.placeId}
        AND ingredient.withdrawn_at IS NULL
        AND ingredient.active_offer_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM transfer_offers AS offer
          WHERE offer.asset_type = 'thing'
            AND offer.asset_id = ingredient.id
            AND offer.status = 'open'
        )
      FOR UPDATE OF ingredient
    ), actual AS MATERIALIZED (
      SELECT kind, count(*)::integer AS quantity
      FROM locked_ingredients
      GROUP BY kind
    ), valid AS MATERIALIZED (
      SELECT 1 AS ready
      FROM locked_kind CROSS JOIN locked_place
      WHERE (SELECT count(*) FROM locked_ingredients) = ${input.ingredientIds.length}
        AND NOT EXISTS (
          SELECT 1
          FROM required FULL JOIN actual USING (kind)
          WHERE coalesce(required.quantity, 0) <> coalesce(actual.quantity, 0)
        )
        AND NOT EXISTS (
          SELECT 1 FROM required
          WHERE NOT EXISTS (
            SELECT 1 FROM kinds AS known_kind
            WHERE lower(known_kind.name) = required.kind
          )
        )
    ), quota_spend AS (
      UPDATE residents AS actor SET
        things_today = CASE WHEN actor.quota_day = utc_day.day
          THEN actor.things_today + 1 ELSE 1 END,
        notes_today = CASE WHEN actor.quota_day = utc_day.day
          THEN actor.notes_today ELSE 0 END,
        agreement_actions_today = CASE WHEN actor.quota_day = utc_day.day
          THEN actor.agreement_actions_today ELSE 0 END,
        quota_day = utc_day.day
      FROM utc_day
      WHERE actor.id = ${input.actorId}
        AND (actor.quota_day <> utc_day.day OR actor.things_today < ${dailyThingLimit})
        AND EXISTS (SELECT 1 FROM valid)
      RETURNING actor.id, actor.handle
    ), new_thing AS (
      INSERT INTO things (
        place_id, name, body, owner_id, maker_id, open_to_use,
        kind_id, birth_revision, current_revision
      )
      SELECT locked_place.id, ${input.name}, ${input.body}, quota_spend.id, quota_spend.id,
        ${input.openToUse}, locked_kind.id, locked_kind.current_revision, locked_kind.current_revision
      FROM locked_kind CROSS JOIN locked_place CROSS JOIN quota_spend
      RETURNING *
    ), withdrawn AS (
      UPDATE things AS ingredient
      SET withdrawn_at = clock_timestamp()
      FROM locked_ingredients CROSS JOIN new_thing
      WHERE ingredient.id = locked_ingredients.id
      RETURNING ingredient.id, ingredient.place_id, new_thing.id AS output_thing_id
    ), withdrawal_events AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'thing_withdrawn', quota_spend.handle, jsonb_build_object(
        'thing_id', withdrawn.id,
        'place_id', withdrawn.place_id,
        'reason', 'crafting',
        'output_thing_id', withdrawn.output_thing_id
      )
      FROM withdrawn CROSS JOIN quota_spend
      RETURNING id
    ), craft_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'thing_crafted', quota_spend.handle, jsonb_build_object(
        'thing_id', new_thing.id,
        'place_id', new_thing.place_id,
        'kind_id', new_thing.kind_id,
        'birth_revision', new_thing.birth_revision,
        'ingredient_ids', to_jsonb(${input.ingredientIds}::integer[])
      )
      FROM new_thing CROSS JOIN quota_spend
      WHERE (SELECT count(*) FROM withdrawn) = ${input.ingredientIds.length}
        AND (SELECT count(*) FROM withdrawal_events) = ${input.ingredientIds.length}
      RETURNING id
    )
    SELECT new_thing.*, quota_spend.handle AS made_by,
      new_thing.owner_id AS current_owner_id,
      quota_spend.handle AS current_owner,
      quota_spend.handle AS owner,
      locked_kind.name AS kind
    FROM new_thing CROSS JOIN locked_kind CROSS JOIN craft_event CROSS JOIN quota_spend
  `

  const output = outputRows[0]
  if (!output) {
    const placeState = await sql`
      /* crafting:place-state */
      SELECT retired_at FROM places WHERE id = ${input.placeId}
    `
    if (placeState[0]?.retired_at != null) {
      return failure(409, 'place is retired; restore it before making things there')
    }
    const quotaRows = await sql`
      /* crafting:quota */
      SELECT quota_day <> (now() AT TIME ZONE 'utc')::date
        OR things_today < ${dailyThingLimit} AS available
      FROM residents
      WHERE id = ${input.actorId}
    `
    if (quotaRows[0]?.available === false) {
      return failure(429, `daily thing limit reached (${dailyThingLimit}); retry after the UTC day resets`)
    }
    if (!quotaRows[0]) return failure(404, `resident record for ${input.actorHandle} was not found; reconnect with the current resident key and retry`)
    return failure(409, 'kind, place, or ingredients changed; retry')
  }

  return Object.freeze({
    ok: true,
    status: 201,
    thing: craftedThing(output),
    consumedIngredientIds: input.ingredientIds,
  })
}
