import assert from 'node:assert/strict'
import { applyMigration, EVENTS_PRESENCE_INDEX_STATE_QUERY } from '../../../scripts/migrate.ts'
import { PUBLIC_RESIDENT_HAS_DRAWING_SQL, PUBLIC_THING_HAS_DRAWING_SQL } from '../../../src/public-drawing-presence.ts'
import { affordableReadingMigration, eventsPresenceIndexMigration, publicChangeMarkersMigration } from '../../helpers/public-pagination-fixtures/seed-city.ts'
import type { TestContext } from 'node:test'
import type { PostgresInstance } from '../../helpers/public-pagination-fixtures/postgres.ts'
import type { SeededCity } from '../../helpers/public-pagination-fixtures/seed-city.ts'

export async function registerMigrationsTests(
  t: TestContext,
  postgres: PostgresInstance,
  city: SeededCity,
): Promise<void> {
  await t.test('drawing presence matches public moderation and inherited drawing rules', async () => {
    const thingRows = (await postgres.client.query<{ id: number; has_drawing: boolean }>(`
        WITH things (id, kind_id, drawing, drawing_state, current_revision, drawing_variant_name) AS (
          VALUES
            (1, NULL::integer, '{}'::jsonb, 'complete', 1, NULL::text),
            (2, NULL::integer, '{}'::jsonb, 'complete', 1, NULL::text),
            (3, 10, NULL::jsonb, 'refused', 1, NULL::text),
            (4, 10, NULL::jsonb, 'complete', 1, NULL::text),
            (5, 11, NULL::jsonb, 'complete', 1, 'lit'::text),
            (6, 12, NULL::jsonb, 'complete', 1, NULL::text)
        ),
        moderation_actions (id, target_type, target_id, action, created_at) AS (
          VALUES
            (1, 'thing', 2, 'remove', now()),
            (2, 'kind', 12, 'remove', now())
        ),
        kind_revisions (kind_id, revision, drawing, drawing_variants) AS (
          VALUES
            (10, 1, '{}'::jsonb, '[]'::jsonb),
            (11, 1, NULL::jsonb, '[{"name":"lit","drawing":{}}]'::jsonb),
            (12, 1, '{}'::jsonb, '[]'::jsonb)
        )
        SELECT thing.id, ${PUBLIC_THING_HAS_DRAWING_SQL} AS has_drawing
        FROM things thing
        ORDER BY thing.id
      `)).rows
    assert.deepEqual(thingRows, [
      { id: 1, has_drawing: true },
      { id: 2, has_drawing: false },
      { id: 3, has_drawing: false },
      { id: 4, has_drawing: true },
      { id: 5, has_drawing: true },
      { id: 6, has_drawing: false },
    ])

    const residentRows = (await postgres.client.query<{ id: number; has_drawing: boolean }>(`
        WITH residents (id, drawing) AS (
          VALUES (1, '{}'::jsonb), (2, '{}'::jsonb), (3, NULL::jsonb)
        ),
        moderation_actions (id, target_type, target_id, action, created_at) AS (
          VALUES (1, 'resident', 2, 'remove', now())
        )
        SELECT resident.id, ${PUBLIC_RESIDENT_HAS_DRAWING_SQL} AS has_drawing
        FROM residents resident
        ORDER BY resident.id
      `)).rows
    assert.deepEqual(residentRows, [
      { id: 1, has_drawing: true },
      { id: 2, has_drawing: false },
      { id: 3, has_drawing: false },
    ])
  })

  await t.test('the additive totals migration upgrades old data and reapplies exactly', async () => {
    await postgres.client.query(`
        DROP TRIGGER IF EXISTS places_update_reading_totals ON places;
        DROP TRIGGER IF EXISTS things_update_reading_totals ON things;
        DROP TRIGGER IF EXISTS notes_update_reading_totals ON notes;
        DROP FUNCTION IF EXISTS maintain_place_reading_totals_from_place();
        DROP FUNCTION IF EXISTS maintain_place_reading_totals_from_thing();
        DROP FUNCTION IF EXISTS maintain_place_reading_totals_from_note();
        DROP TABLE place_reading_totals;
      `)
    await postgres.client.query(affordableReadingMigration)
    const first = (await postgres.client.query(
      `SELECT * FROM place_reading_totals WHERE place_id = $1`,
      [city.targetPlaceId],
    )).rows[0]
    const exact = (await postgres.client.query(`
        SELECT
          (SELECT count(*)::integer FROM places WHERE parent_id = $1) AS subplace_items,
          (SELECT coalesce(sum(octet_length(description)), 0)::bigint FROM places WHERE parent_id = $1) AS subplace_text_bytes,
          (SELECT count(*)::integer FROM things WHERE place_id = $1 AND withdrawn_at IS NULL) AS thing_items,
          (SELECT coalesce(sum(octet_length(body)), 0)::bigint FROM things WHERE place_id = $1 AND withdrawn_at IS NULL) AS thing_text_bytes,
          (SELECT count(*)::integer FROM notes WHERE place_id = $1) AS note_items,
          (SELECT coalesce(sum(octet_length(body)), 0)::bigint FROM notes WHERE place_id = $1) AS note_text_bytes
      `, [city.targetPlaceId])).rows[0]
    assert.deepEqual(first, { place_id: city.targetPlaceId, ...exact })

    await postgres.client.query(affordableReadingMigration)
    const second = (await postgres.client.query(
      `SELECT * FROM place_reading_totals WHERE place_id = $1`,
      [city.targetPlaceId],
    )).rows[0]
    assert.deepEqual(second, first)
    const triggers = await postgres.client.query(`
        SELECT tgname FROM pg_trigger
        WHERE NOT tgisinternal AND tgname IN (
          'places_update_reading_totals',
          'things_update_reading_totals',
          'notes_update_reading_totals'
        )
      `)
    assert.equal(triggers.rowCount, 3)
  })

  await t.test('the standalone presence index migration reapplies concurrently', async () => {
    await postgres.client.query('DROP INDEX IF EXISTS events_actor_at_desc')
    assert.equal(await applyMigration(
      postgres.databaseUrl,
      'db/migrations/20260821_events_presence_index.sql',
      eventsPresenceIndexMigration,
    ), 1)
    const first = await postgres.client.query(
      `${EVENTS_PRESENCE_INDEX_STATE_QUERY} LIMIT 1`,
    )
    assert.deepEqual(first.rows[0], {
      index_schema: 'public',
      index_name: 'events_actor_at_desc',
      table_schema: 'public',
      table_name: 'events',
      valid: true,
      ready: true,
      unique_index: false,
      access_method: 'btree',
      key_column_count: 2,
      total_column_count: 2,
      options: [0, 3],
      unfiltered: true,
      columns: ['actor', 'at'],
    })
    const firstOid = (await postgres.client.query(
      `SELECT 'public.events_actor_at_desc'::regclass::oid AS oid`,
    )).rows[0]!.oid

    assert.equal(await applyMigration(
      postgres.databaseUrl,
      'db/migrations/20260821_events_presence_index.sql',
      eventsPresenceIndexMigration,
    ), 0)
    const unchangedOid = (await postgres.client.query(
      `SELECT 'public.events_actor_at_desc'::regclass::oid AS oid`,
    )).rows[0]!.oid
    assert.equal(unchangedOid, firstOid, 'a valid exact index must not be dropped on rerun')

    await postgres.client.query(`
        UPDATE pg_index
        SET indisvalid = FALSE, indisready = FALSE
        WHERE indexrelid = 'public.events_actor_at_desc'::regclass
      `)
    assert.equal(await applyMigration(
      postgres.databaseUrl,
      'db/migrations/20260821_events_presence_index.sql',
      eventsPresenceIndexMigration,
    ), 2)
    const repaired = await postgres.client.query(
      `${EVENTS_PRESENCE_INDEX_STATE_QUERY} LIMIT 1`,
    )
    assert.equal(repaired.rows[0]?.valid, true)
    assert.equal(repaired.rows[0]?.ready, true)
    assert.deepEqual(repaired.rows[0]?.columns, ['actor', 'at'])
    assert.deepEqual(repaired.rows[0]?.options, [0, 3])
    const repairedOid = (await postgres.client.query(
      `SELECT 'public.events_actor_at_desc'::regclass::oid AS oid`,
    )).rows[0]!.oid
    assert.notEqual(repairedOid, firstOid, 'invalid residue must be dropped before retry')
  })

  await t.test('the public change migration preserves one exact marker per committed event on reapply', async () => {
    const before = (await postgres.client.query<{
      current_change_id: string
      event_count: string
      change_count: string
    }>(`
        SELECT state.current_change_id::text,
          (SELECT count(*)::text FROM events) AS event_count,
          (SELECT count(*)::text FROM public_change_log) AS change_count
        FROM public_change_state state
        WHERE state.singleton = true
      `)).rows[0]!
    assert.equal(before.change_count, before.event_count)
    assert.equal(before.current_change_id, before.change_count)

    await postgres.client.query(publicChangeMarkersMigration)
    await postgres.client.query(publicChangeMarkersMigration)

    const after = (await postgres.client.query<{
      current_change_id: string
      event_count: string
      change_count: string
      distinct_event_count: string
    }>(`
        SELECT state.current_change_id::text,
          (SELECT count(*)::text FROM events) AS event_count,
          (SELECT count(*)::text FROM public_change_log) AS change_count,
          (SELECT count(DISTINCT event_id)::text FROM public_change_log) AS distinct_event_count
        FROM public_change_state state
        WHERE state.singleton = true
      `)).rows[0]!
    assert.deepEqual(after, {
      ...before,
      distinct_event_count: before.event_count,
    })
    const markerTriggers = await postgres.client.query(`
        SELECT tgname
        FROM pg_trigger
        WHERE tgrelid = 'events'::regclass
          AND NOT tgisinternal
          AND tgname = 'events_record_public_change'
      `)
    assert.equal(markerTriggers.rowCount, 1)
  })

}
