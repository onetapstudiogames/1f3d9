import type { Client } from 'pg'

export async function releaseState(client: Client): Promise<Readonly<{
  world: Readonly<{
    count: string
    drawing: unknown
    drawing_state: string
    drawing_description: string
  }>
  worldHistory: readonly Readonly<{
    author_id: number | null
    author_relation: string
    prior_state: string
    prior_description: string | null
    prior_drawing: unknown
    prior_source: string
    current_state: string
    current_description: string | null
    current_drawing: unknown
    current_source: string
  }>[]
  typedThingCurrent: Readonly<{
    drawing: unknown
    drawing_state: string | null
    drawing_description: string | null
  }> | null
  historyCounts: Readonly<{
    founder_rows: string
    legacy_rows: string
    total_rows: string
    typed_legacy_rows: string
  }>
  legacyRows: readonly Readonly<{
    target_type: string
    target_id: number
    author_relation: string
    prior_state: string
    prior_description: string | null
    prior_drawing: unknown
    prior_source: string
    current_state: string
    current_description: string | null
    current_drawing: unknown
    current_source: string
  }>[]
  constraints: readonly Readonly<{ conname: string; convalidated: boolean }>[]
  triggers: readonly Readonly<{ table_name: string; trigger_name: string; enabled: string }>[]
  views: Readonly<{
    drawing_revisions: string | null
    public_records: string | null
    public_records_without_drawing_contract: string | null
  }>
}>> {
  const world = (await client.query<{
    count: string
    drawing: unknown
    drawing_state: string
    drawing_description: string
  }>(`
    SELECT count(*)::text AS count,
      min(drawing::text)::jsonb AS drawing,
      min(drawing_state) AS drawing_state,
      min(drawing_description) AS drawing_description
    FROM places WHERE place_kind = 'world'
  `)).rows[0]!
  const worldHistory = (await client.query<{
    author_id: number | null
    author_relation: string
    prior_state: string
    prior_description: string | null
    prior_drawing: unknown
    prior_source: string
    current_state: string
    current_description: string | null
    current_drawing: unknown
    current_source: string
  }>(`
    SELECT revision.author_id, revision.author_relation,
      revision.prior_state, revision.prior_description, revision.prior_drawing, revision.prior_source,
      revision.current_state, revision.current_description, revision.current_drawing, revision.current_source
    FROM drawing_revisions revision
    JOIN places world ON world.id = revision.target_id
    WHERE revision.target_type = 'place'
      AND world.place_kind = 'world'
    ORDER BY revision.id
  `)).rows
  const typedThingCurrent = (await client.query<{
    drawing: unknown
    drawing_state: string | null
    drawing_description: string | null
  }>(`
    SELECT thing.drawing, thing.drawing_state, thing.drawing_description
    FROM things thing
    WHERE thing.name = 'legacy typed thing'
  `)).rows[0] ?? null
  const historyCounts = (await client.query<{
    founder_rows: string
    legacy_rows: string
    total_rows: string
    typed_legacy_rows: string
  }>(`
    SELECT
      count(*) FILTER (WHERE author_relation = 'founder')::text AS founder_rows,
      count(*) FILTER (WHERE author_relation = 'legacy')::text AS legacy_rows,
      count(*)::text AS total_rows,
      count(*) FILTER (
        WHERE author_relation = 'legacy'
          AND target_type = 'thing'
          AND prior_source = 'thing'
          AND current_source = 'none'
      )::text AS typed_legacy_rows
    FROM drawing_revisions
  `)).rows[0]!
  const legacyRows = (await client.query<{
    target_type: string
    target_id: number
    author_relation: string
    prior_state: string
    prior_description: string | null
    prior_drawing: unknown
    prior_source: string
    current_state: string
    current_description: string | null
    current_drawing: unknown
    current_source: string
  }>(`
    SELECT
      target_type, target_id, author_relation,
      prior_state, prior_description, prior_drawing, prior_source,
      current_state, current_description, current_drawing, current_source
    FROM drawing_revisions
    WHERE author_relation = 'legacy'
    ORDER BY target_type, target_id, id
  `)).rows
  const constraints = (await client.query<{ conname: string; convalidated: boolean }>(`
    SELECT conname, convalidated
    FROM pg_constraint
    WHERE conname IN (
      'residents_drawing_contract',
      'places_drawing_contract',
      'kind_revisions_drawing_contract',
      'things_drawing_contract',
      'places_world_shape',
      'places_world_drawing_exact'
    )
    ORDER BY conname
  `)).rows
  const triggers = (await client.query<{
    table_name: string
    trigger_name: string
    enabled: string
  }>(`
    SELECT trigger.tgrelid::regclass::text AS table_name,
      trigger.tgname AS trigger_name,
      trigger.tgenabled AS enabled
    FROM pg_trigger trigger
    WHERE NOT trigger.tgisinternal AND trigger.tgname IN (
      'drawing_revisions_append_only',
      'places_protect_topology_write'
    )
    ORDER BY table_name, trigger_name
  `)).rows
  const views = (await client.query<{
    drawing_revisions: string | null
    public_records: string | null
    public_records_without_drawing_contract: string | null
  }>(`
    SELECT
      to_regclass('public.drawing_revisions')::text AS drawing_revisions,
      to_regclass('city_snapshot.public_records')::text AS public_records,
      to_regclass('city_snapshot.public_records_without_drawing_contract')::text
        AS public_records_without_drawing_contract
  `)).rows[0]!
  return Object.freeze({
    world: Object.freeze(world),
    worldHistory,
    typedThingCurrent: typedThingCurrent ? Object.freeze(typedThingCurrent) : null,
    historyCounts: Object.freeze(historyCounts),
    legacyRows,
    constraints,
    triggers,
    views: Object.freeze(views),
  })
}
