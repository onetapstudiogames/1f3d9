import assert from 'node:assert/strict'
import type { Client } from 'pg'

export async function registerGazetteCutoverTests(
  client: Client,
  preDrawingSchemaDdl: string,
  gazetteMigrationDdl: string,
  gazetteActivationDdl: string,
  drawingContractMigrationDdl: string,
  snapshotExportPrivileges: (client: Client) => Promise<Readonly<{
    public_records: boolean
    public_records_v2: boolean
  }>>,
): Promise<void> {
  await client.query(preDrawingSchemaDdl)
  await client.query(`
    INSERT INTO residents (id, handle, model, secret_hash)
    VALUES (1, 'gazette-founder', 'integration-test', repeat('1', 64));

    INSERT INTO places (
      id, parent_id, place_kind, name, description, owner_id,
      open_to_building, open_to_things, open_to_notes
    )
    SELECT
      2, world.id, 'continent', 'gazette test continent',
      'Integration-only parent for the Gazette room.', 1,
      FALSE, FALSE, FALSE
    FROM places world
    WHERE world.place_kind = 'world';

    INSERT INTO places (
      id, parent_id, place_kind, name, description, purpose, owner_id,
      open_to_building, open_to_things, open_to_notes
    ) VALUES (
      454, 2, 'place', 'the gazette submission room',
      'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
      '', 1, FALSE, FALSE, FALSE
    );
  `)
  await client.query(gazetteMigrationDdl)
  await client.query(gazetteActivationDdl)
  assert.deepEqual(await snapshotExportPrivileges(client), {
    public_records: false,
    public_records_v2: true,
  })

  await client.query(drawingContractMigrationDdl)
  assert.deepEqual(await snapshotExportPrivileges(client), {
    public_records: false,
    public_records_v2: true,
  })
  await client.query(drawingContractMigrationDdl)
  assert.deepEqual(await snapshotExportPrivileges(client), {
    public_records: false,
    public_records_v2: true,
  })
  const viewDefinition = (await client.query<{ definition: string }>(`
    SELECT pg_get_viewdef('city_snapshot.public_records_v2'::regclass, TRUE) AS definition
  `)).rows[0]!.definition
  assert.match(viewDefinition, /FROM city_snapshot\.public_records base_record/iu)
  assert.doesNotMatch(viewDefinition, /public_records_without_drawing_contract/iu)
}
