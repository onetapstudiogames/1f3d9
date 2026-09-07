import assert from 'node:assert/strict'
import type { Client } from 'pg'

export async function registerWorldMigrationTests(
  client: Client,
  freshWorld: { id: number; drawing: unknown },
  migrationDdl: string,
  installLegacyNullWorldDrawing: (client: Client) => Promise<void>,
  worldRootDrawingMigrationDdl: string,
  worldRootTopologyMigrationDdl: string,
  drawingContractMigrationDdl: string,
  schemaDdl: string,
  drawing: (colour: string) => { palette: string[]; indices: (number | null)[] },
): Promise<void> {
  await client.query(migrationDdl)
  await client.query(migrationDdl)
  await installLegacyNullWorldDrawing(client)
  await client.query(worldRootDrawingMigrationDdl)
  await client.query(worldRootDrawingMigrationDdl)
  await client.query(migrationDdl)
  await client.query(worldRootTopologyMigrationDdl)
  await client.query(worldRootTopologyMigrationDdl)
  await client.query(drawingContractMigrationDdl)
  await client.query(drawingContractMigrationDdl)

  await client.query(`
    ALTER TABLE places DROP CONSTRAINT places_drawing_contract;
    ALTER TABLE places ALTER COLUMN drawing_state DROP NOT NULL;
    ALTER TABLE places ALTER COLUMN drawing_state DROP DEFAULT;
    ALTER TABLE places DISABLE TRIGGER places_protect_topology_write;
    UPDATE places SET drawing_state = NULL, drawing_description = NULL
    WHERE place_kind = 'world';
    ALTER TABLE places ENABLE TRIGGER places_protect_topology_write;

    CREATE FUNCTION reject_unrelated_place_backfill() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      RAISE EXCEPTION 'unrelated protected place must not receive a row update';
    END
    $function$;
    CREATE TRIGGER places_reject_unrelated_backfill
    BEFORE UPDATE ON places
    FOR EACH ROW EXECUTE FUNCTION reject_unrelated_place_backfill();
  `)
  try {
    await client.query(drawingContractMigrationDdl)
    assert.deepEqual((await client.query<{ drawing_state: string; tgenabled: string }>(`
      SELECT place.drawing_state, trigger.tgenabled
      FROM places place
      JOIN pg_trigger trigger ON trigger.tgrelid = 'places'::regclass
        AND trigger.tgname = 'places_reject_unrelated_backfill'
        AND NOT trigger.tgisinternal
      WHERE place.place_kind = 'world'
    `)).rows, [{ drawing_state: 'complete', tgenabled: 'O' }])
  } finally {
    await client.query(`
      DROP TRIGGER IF EXISTS places_reject_unrelated_backfill ON places;
      DROP FUNCTION IF EXISTS reject_unrelated_place_backfill();
    `)
  }

  const migratedWorld = (await client.query<{ id: number; drawing: unknown }>(`
    SELECT id, drawing FROM places WHERE place_kind = 'world'
  `)).rows[0]!
  assert.deepEqual(migratedWorld, freshWorld)
  assert.deepEqual((await client.query<{ conname: string; convalidated: boolean }>(`
    SELECT conname, convalidated FROM pg_constraint
    WHERE conrelid = 'places'::regclass
      AND conname IN ('places_world_shape', 'places_world_drawing_exact')
    ORDER BY conname
  `)).rows, [
    { conname: 'places_world_drawing_exact', convalidated: true },
    { conname: 'places_world_shape', convalidated: true },
  ])
  assert.deepEqual((await client.query<{ tgenabled: string }>(`
    SELECT tgenabled FROM pg_trigger
    WHERE tgrelid = 'places'::regclass
      AND tgname = 'places_protect_topology_write'
      AND NOT tgisinternal
  `)).rows, [{ tgenabled: 'O' }])

  await client.query('BEGIN')
  try {
    await client.query('ALTER TABLE places DISABLE TRIGGER places_protect_topology_write')
    await assert.rejects(
      client.query(
        "UPDATE places SET drawing = $1::jsonb WHERE place_kind = 'world'",
        [JSON.stringify(drawing('#174d3c'))],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    )
  } finally {
    await client.query('ROLLBACK')
  }

  await installLegacyNullWorldDrawing(client)
  await client.query(schemaDdl)
  await client.query(schemaDdl)
  assert.deepEqual((await client.query<{ id: number; drawing: unknown }>(`
    SELECT id, drawing FROM places WHERE place_kind = 'world'
  `)).rows[0], freshWorld)

  const columns = (await client.query<{ table_name: string; column_name: string }>(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (
        (table_name IN ('residents', 'places', 'things', 'kind_revisions')
          AND column_name IN ('drawing', 'drawing_state', 'drawing_description'))
        OR (table_name = 'kind_revisions' AND column_name = 'drawing_variants')
        OR (table_name = 'things' AND column_name = 'drawing_variant_name')
      )
    ORDER BY table_name, column_name
  `)).rows
  assert.deepEqual(columns, [
    { table_name: 'kind_revisions', column_name: 'drawing' },
    { table_name: 'kind_revisions', column_name: 'drawing_description' },
    { table_name: 'kind_revisions', column_name: 'drawing_state' },
    { table_name: 'kind_revisions', column_name: 'drawing_variants' },
    { table_name: 'places', column_name: 'drawing' },
    { table_name: 'places', column_name: 'drawing_description' },
    { table_name: 'places', column_name: 'drawing_state' },
    { table_name: 'residents', column_name: 'drawing' },
    { table_name: 'residents', column_name: 'drawing_description' },
    { table_name: 'residents', column_name: 'drawing_state' },
    { table_name: 'things', column_name: 'drawing' },
    { table_name: 'things', column_name: 'drawing_description' },
    { table_name: 'things', column_name: 'drawing_state' },
    { table_name: 'things', column_name: 'drawing_variant_name' },
  ])
  assert.equal((await client.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'drawing_revisions'
  `)).rows[0]?.count, '1')
}
