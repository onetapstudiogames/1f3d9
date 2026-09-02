import type { Resident } from './core.ts'
import { sql } from './db.ts'
import { executeBudgetedExactQuery } from './public-exact-query.ts'
import {
  MODERATED_TEXT,
  redactModeratedTarget,
  type ModerationInput,
  type ModerationTargetType,
} from './moderation.ts'

interface ModerationOverlay {
  target_id: number
  action: 'remove' | 'restore'
  reason: string
  created_at: string
}

interface NamedModerationOverlay extends ModerationOverlay {
  name: string
}

const EVENT_TARGET_FIELDS = Object.freeze([
  ['resident', 'resident_id'],
  ['place', 'place_id'],
  ['thing', 'thing_id'],
  ['kind', 'kind_id'],
  ['trait', 'trait_id'],
  ['note', 'note_id'],
  ['agreement', 'agreement_id'],
] as const)

const TARGET_TABLES: Readonly<Record<ModerationTargetType, string>> = Object.freeze({
  resident: 'residents',
  place: 'places',
  thing: 'things',
  kind: 'kinds',
  trait: 'traits',
  note: 'notes',
  agreement: 'agreements',
})

async function currentOverlays(
  targetType: ModerationTargetType,
  ids: readonly number[],
): Promise<ReadonlyMap<number, ModerationOverlay>> {
  if (ids.length === 0) return new Map()
  const overlays = await sql`
    SELECT DISTINCT ON (target_id)
      target_id, action, reason, created_at
    FROM moderation_actions
    WHERE target_type = ${targetType} AND target_id = ANY(${[...ids]}::integer[])
    ORDER BY target_id, created_at DESC, id DESC
  ` as ModerationOverlay[]
  return new Map(overlays.map(row => [row.target_id, row]))
}

async function currentNameOverlays(
  targetType: 'kind' | 'trait',
  names: readonly string[],
): Promise<ReadonlyMap<string, NamedModerationOverlay>> {
  const distinct = [...new Set(names.filter(name => typeof name === 'string' && name.length > 0))]
  if (distinct.length === 0) return new Map()
  const overlays = targetType === 'kind' ? await sql`
    SELECT DISTINCT ON (named.name)
      named.name, action.target_id, action.action, action.reason, action.created_at
    FROM moderation_actions action
    JOIN kinds named ON named.id = action.target_id
    WHERE action.target_type = ${targetType} AND named.name = ANY(${distinct}::text[])
    ORDER BY named.name, action.created_at DESC, action.id DESC
  ` : await sql`
    SELECT DISTINCT ON (named.name)
      named.name, action.target_id, action.action, action.reason, action.created_at
    FROM moderation_actions action
    JOIN traits named ON named.id = action.target_id
    WHERE action.target_type = ${targetType} AND named.name = ANY(${distinct}::text[])
    ORDER BY named.name, action.created_at DESC, action.id DESC
  `
  return new Map((overlays as NamedModerationOverlay[]).map(row => [row.name, row]))
}

const positiveIds = (rows: readonly object[], field: string): number[] => [...new Set(rows.flatMap(row => {
  const id = Number((row as Record<string, unknown>)[field])
  return Number.isSafeInteger(id) && id > 0 ? [id] : []
}))]

function moderationDetail(
  targetType: ModerationTargetType,
  targetId: number,
  overlay: ModerationOverlay,
) {
  return Object.freeze({
    target_type: targetType,
    target_id: targetId,
    action: overlay.action,
    reason: overlay.reason,
    created_at: overlay.created_at,
  })
}

function applyDirectOverlays<T extends object>(
  targetType: ModerationTargetType,
  rows: readonly T[],
  latest: ReadonlyMap<number, ModerationOverlay>,
): readonly T[] {
  return Object.freeze(rows.map(row => {
    const id = Number((row as { id?: unknown }).id)
    const overlay = latest.get(id)
    if (overlay?.action !== 'remove') return row
    return Object.freeze({
      ...redactModeratedTarget(targetType, row as Readonly<Record<string, unknown>>),
      moderation: moderationDetail(targetType, id, overlay),
    }) as unknown as T
  }))
}

/** Apply the latest append-only moderation decision without changing stored content. */
export async function moderatePublicRows<T extends object>(
  targetType: ModerationTargetType,
  rows: readonly T[],
): Promise<readonly T[]> {
  const ids = [...new Set(rows
    .map(row => Number((row as { id?: unknown }).id))
    .filter(id => Number.isSafeInteger(id) && id > 0))]
  if (ids.length === 0) return Object.freeze([...rows])

  return applyDirectOverlays(targetType, rows, await currentOverlays(targetType, ids))
}

function namesInField(rows: readonly object[], field: string): string[] {
  return [...new Set(rows.flatMap(row => {
    const value = (row as Record<string, unknown>)[field]
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') as string[] : []
  }))]
}

function ingredientNames(rows: readonly object[], field = 'recipe'): string[] {
  return [...new Set(rows.flatMap(row => {
    const recipe = (row as Record<string, unknown>)[field]
    if (!Array.isArray(recipe)) return []
    return recipe.flatMap(ingredient => (
      ingredient && typeof ingredient === 'object' && !Array.isArray(ingredient)
        && typeof (ingredient as Record<string, unknown>).kind === 'string'
        ? [(ingredient as Record<string, unknown>).kind as string]
        : []
    ))
  }))]
}

function redactNameList(value: unknown, overlays: ReadonlyMap<string, NamedModerationOverlay>) {
  if (!Array.isArray(value)) return value
  let changed = false
  const names = value.map(name => {
    if (typeof name !== 'string' || overlays.get(name)?.action !== 'remove') return name
    changed = true
    return MODERATED_TEXT
  })
  return changed ? Object.freeze(names) : value
}

function redactIngredientNames(value: unknown, overlays: ReadonlyMap<string, NamedModerationOverlay>) {
  if (!Array.isArray(value)) return value
  let changed = false
  const recipe = value.map(ingredient => {
    if (!ingredient || typeof ingredient !== 'object' || Array.isArray(ingredient)) return ingredient
    const record = ingredient as Record<string, unknown>
    if (typeof record.kind !== 'string' || overlays.get(record.kind)?.action !== 'remove') return ingredient
    changed = true
    return Object.freeze({ ...record, kind: MODERATED_TEXT })
  })
  return changed ? Object.freeze(recipe) : value
}

export async function moderatePlaceDetails<TThing extends object, TLaw extends object>(
  things: readonly TThing[],
  laws: readonly TLaw[],
): Promise<Readonly<{ things: readonly TThing[]; laws: readonly TLaw[] }>> {
  const kindIds = positiveIds(things, 'kind_id')
  const traitIds = [...new Set(laws.flatMap(law => {
    const row = law as Record<string, unknown>
    const id = Number(row.traitId ?? row.trait_id)
    return Number.isSafeInteger(id) && id > 0 ? [id] : []
  }))]
  const [thingOverlays, kindOverlays, traitOverlays] = await Promise.all([
    currentOverlays('thing', positiveIds(things, 'id')),
    currentOverlays('kind', kindIds),
    currentOverlays('trait', traitIds),
  ])
  const publicThings = applyDirectOverlays('thing', things, thingOverlays).map(thing => {
    const row = thing as Record<string, unknown>
    const kindId = Number(row.kind_id)
    const overlay = kindOverlays.get(kindId)
    if (overlay?.action !== 'remove' || typeof row.kind !== 'string') return thing
    return Object.freeze({
      ...row,
      kind: MODERATED_TEXT,
      kind_moderated: true,
      kind_moderation: moderationDetail('kind', kindId, overlay),
    }) as unknown as TThing
  })
  const publicLaws = laws.map(law => {
    const row = law as Record<string, unknown>
    const traitId = Number(row.traitId ?? row.trait_id)
    const overlay = traitOverlays.get(traitId)
    if (overlay?.action !== 'remove') return law
    return Object.freeze({
      ...row,
      name: MODERATED_TEXT,
      recipe: null,
      moderated: true,
      moderation: moderationDetail('trait', traitId, overlay),
    }) as unknown as TLaw
  })
  return Object.freeze({ things: Object.freeze(publicThings), laws: Object.freeze(publicLaws) })
}

export async function moderatePublicKinds<T extends object>(rows: readonly T[]): Promise<readonly T[]> {
  const [kindOverlays, traitOverlays, ingredientOverlays] = await Promise.all([
    currentOverlays('kind', positiveIds(rows, 'id')),
    currentNameOverlays('trait', namesInField(rows, 'traits')),
    currentNameOverlays('kind', ingredientNames(rows)),
  ])
  return Object.freeze(applyDirectOverlays('kind', rows, kindOverlays).map(kind => {
    const row = kind as Record<string, unknown>
    const traits = redactNameList(row.traits, traitOverlays)
    const recipe = redactIngredientNames(row.recipe, ingredientOverlays)
    return traits === row.traits && recipe === row.recipe
      ? kind
      : Object.freeze({ ...row, traits, recipe }) as unknown as T
  }))
}

/** Remove authored display text duplicated into event details, while retaining the event. */
export async function moderatePublicEvents<T extends object>(rows: readonly T[]): Promise<readonly T[]> {
  const idsByType = Object.fromEntries(EVENT_TARGET_FIELDS.map(([type, field]) => [
    type,
    [...new Set(rows.flatMap(row => {
      const detail = (row as { detail?: unknown }).detail
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return []
      const id = Number((detail as Record<string, unknown>)[field])
      return Number.isSafeInteger(id) && id > 0 ? [id] : []
    }))],
  ])) as Record<ModerationTargetType, number[]>
  const details = rows.flatMap(row => {
    const detail = (row as { detail?: unknown }).detail
    return detail && typeof detail === 'object' && !Array.isArray(detail) ? [detail as object] : []
  })
  const [overlayEntries, traitNameOverlays, kindNameOverlays] = await Promise.all([
    Promise.all(EVENT_TARGET_FIELDS.map(async ([type]) => (
      [type, await currentOverlays(type, idsByType[type])] as const
    ))),
    currentNameOverlays('trait', namesInField(details, 'traits')),
    currentNameOverlays('kind', ingredientNames(details)),
  ])
  const overlays = Object.fromEntries(overlayEntries) as Record<
    ModerationTargetType,
    ReadonlyMap<number, ModerationOverlay>
  >

  return Object.freeze(rows.map(row => {
    const rawDetail = (row as { detail?: unknown }).detail
    if (!rawDetail || typeof rawDetail !== 'object' || Array.isArray(rawDetail)) return row
    const detail = rawDetail as Record<string, unknown>
    let redacted: Record<string, unknown> = detail
    let changed = false
    let firstModeration: Readonly<Record<string, unknown>> | null = null
    const edit = () => {
      if (!changed) redacted = { ...detail }
      changed = true
    }
    for (const [type, field] of EVENT_TARGET_FIELDS) {
      const id = Number(detail[field])
      const overlay = overlays[type].get(id)
      if (overlay?.action !== 'remove') continue
      edit()
      for (const textField of ['name', 'description', 'body']) {
        if (Object.hasOwn(redacted, textField)) redacted[textField] = MODERATED_TEXT
      }
      if (type === 'place') {
        for (const historicalNameField of ['former_name', 'founding_name']) {
          if (Object.hasOwn(redacted, historicalNameField)) {
            redacted[historicalNameField] = MODERATED_TEXT
          }
        }
      }
      if (type === 'kind') {
        if (Object.hasOwn(redacted, 'kind')) redacted.kind = MODERATED_TEXT
        if (Object.hasOwn(redacted, 'traits')) redacted.traits = Object.freeze([])
        if (Object.hasOwn(redacted, 'recipe')) redacted.recipe = null
      }
      if (type === 'trait') {
        if (Object.hasOwn(redacted, 'trait')) redacted.trait = MODERATED_TEXT
        if (Object.hasOwn(redacted, 'recipe')) redacted.recipe = null
        if (Object.hasOwn(redacted, 'mechanical')) redacted.mechanical = false
      }
      firstModeration ??= moderationDetail(type, id, overlay)
    }
    const traits = redactNameList(redacted.traits, traitNameOverlays)
    if (traits !== redacted.traits) {
      edit()
      redacted.traits = traits
      const removed = Array.isArray(detail.traits)
        ? detail.traits.find(name => typeof name === 'string' && traitNameOverlays.get(name)?.action === 'remove')
        : null
      const overlay = typeof removed === 'string' ? traitNameOverlays.get(removed) : null
      if (overlay) firstModeration ??= moderationDetail('trait', overlay.target_id, overlay)
    }
    const recipe = redactIngredientNames(redacted.recipe, kindNameOverlays)
    if (recipe !== redacted.recipe) {
      edit()
      redacted.recipe = recipe
      const removed = ingredientNames([{ recipe: detail.recipe }])
        .find(name => kindNameOverlays.get(name)?.action === 'remove')
      const overlay = removed ? kindNameOverlays.get(removed) : null
      if (overlay) firstModeration ??= moderationDetail('kind', overlay.target_id, overlay)
    }
    if (!changed) return row
    redacted.moderated = true
    if (firstModeration) redacted.moderation = firstModeration
    return Object.freeze({ ...row, detail: Object.freeze(redacted) }) as T
  }))
}

/** Record the founder's narrow content-only power and its public event atomically. */
export async function recordModeration(
  actor: Resident,
  input: ModerationInput,
): Promise<Record<string, unknown> | null> {
  if (actor.id !== 1) return null
  const table = TARGET_TABLES[input.target_type]
  const rows = await sql.query(`
    WITH target AS MATERIALIZED (
      SELECT id FROM ${table} WHERE id = $1
    ), new_action AS (
      INSERT INTO moderation_actions (
        target_type, target_id, action, actor_id, reason
      )
      SELECT $2, target.id, $3, $4, $5 FROM target
      RETURNING id, target_type, target_id, action, actor_id, reason, created_at
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'moderation', $6, jsonb_build_object(
        'moderation_id', id,
        'action', action,
        'target_type', target_type,
        'target_id', target_id,
        'reason', reason
      )
      FROM new_action
    )
    SELECT * FROM new_action
  `, [
    input.target_id,
    input.target_type,
    input.action,
    actor.id,
    input.reason,
    actor.handle,
  ]) as Record<string, unknown>[]
  return rows[0] ?? null
}

export async function moderationHistory(
  beforeId: number | null,
  fetchLimit: number,
): Promise<readonly Record<string, unknown>[]> {
  return executeBudgetedExactQuery(`
    /* public:moderation */
    WITH totals AS (
      SELECT count(*)::integer AS total_items,
        coalesce(sum(octet_length(reason)), 0)::bigint AS total_text_bytes
      FROM moderation_actions
    )
    SELECT page.id, page.target_type, page.target_id, page.action,
      page.reason, page.created_at, page.actor,
      totals.total_items, totals.total_text_bytes
    FROM totals
    LEFT JOIN LATERAL (
      SELECT action.id, action.target_type, action.target_id, action.action,
        action.reason, action.created_at, actor.handle AS actor
      FROM moderation_actions action
      JOIN residents actor ON actor.id = action.actor_id
      WHERE ($1::integer IS NULL OR action.id < $1::integer)
      ORDER BY action.id DESC
      LIMIT $2::integer
    ) page ON TRUE
    ORDER BY page.id DESC NULLS LAST
  `, [beforeId, fetchLimit]) as Promise<Record<string, unknown>[]>
}
