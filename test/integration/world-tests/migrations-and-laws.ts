import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { WorldTestContext } from '../../helpers/world-postgres-fixtures/harness.ts'

export async function registerMigrationsAndLawsTests(
  t: TestContext,
  {
    actor, database, placeLifecycleMigrationDdl, postgresCode,
    preLifecycleSnapshotMigrationDdl, quietSnapshotMigrationDdl, replacePlaceLaws,
    resetDatabase, withdrawThing,
  }: Pick<WorldTestContext,
    | 'actor' | 'database' | 'placeLifecycleMigrationDdl' | 'postgresCode'
    | 'preLifecycleSnapshotMigrationDdl' | 'quietSnapshotMigrationDdl' | 'replacePlaceLaws'
    | 'resetDatabase' | 'withdrawThing'
  >,
): Promise<void> {
  await t.test('the additive place lifecycle migration runs twice without losing history or snapshot access', async () => {
    const roomId = await resetDatabase()
    await database!.query(placeLifecycleMigrationDdl)
    await database!.query(placeLifecycleMigrationDdl)
    const installed = await database!.query<{
      founding_name: string
      history_rows: number
      history_trigger: string | null
      public_records: string | null
      public_records_v2: string | null
      export_can_read_v2: boolean
    }>(`
        SELECT place.founding_name,
          (SELECT count(*)::integer FROM place_name_history history
            WHERE history.place_id = place.id) AS history_rows,
          (SELECT trigger.tgname FROM pg_trigger trigger
            WHERE trigger.tgrelid = 'places'::regclass
              AND trigger.tgname = 'places_record_founding_name_history'
              AND NOT trigger.tgisinternal) AS history_trigger,
          to_regclass('city_snapshot.public_records')::text AS public_records,
          to_regclass('city_snapshot.public_records_v2')::text AS public_records_v2,
          has_table_privilege(
            'city_snapshot_export', 'city_snapshot.public_records_v2', 'SELECT'
          ) AS export_can_read_v2
        FROM places place WHERE place.id = $1
      `, [roomId])
    assert.deepEqual(installed.rows, [{
      founding_name: 'test-room',
      history_rows: 1,
      history_trigger: 'places_record_founding_name_history',
      public_records: 'city_snapshot.public_records',
      public_records_v2: 'city_snapshot.public_records_v2',
      export_can_read_v2: true,
    }])

    const candidate = await database!.connect()
    try {
      await candidate.query('BEGIN')
      const inserted = (await candidate.query<{ id: number }>(`
          INSERT INTO places (parent_id, place_kind, name, description, owner_id)
          SELECT parent_id, 'place', 'discarded-candidate', '', owner_id
          FROM places WHERE id = $1
          RETURNING id
        `, [roomId])).rows[0]!
      assert.equal((await candidate.query(
        'SELECT 1 FROM place_name_history WHERE place_id = $1',
        [inserted.id],
      )).rowCount, 1)
      await candidate.query('DELETE FROM places WHERE id = $1', [inserted.id])
      await candidate.query('COMMIT')
      assert.equal((await database!.query(
        'SELECT 1 FROM place_name_history WHERE place_id = $1',
        [inserted.id],
      )).rowCount, 0)
    } catch (error) {
      await candidate.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      candidate.release()
    }
    await assert.rejects(
      database!.query('DELETE FROM place_name_history WHERE place_id = $1', [roomId]),
      error => postgresCode(error) === '55000',
    )
    assert.equal((await database!.query(
      'SELECT 1 FROM place_name_history WHERE place_id = $1',
      [roomId],
    )).rowCount, 1)
  })

  await t.test('fresh and incrementally migrated databases expose the same deep snapshot', async () => {
    const roomId = await resetDatabase()
    const eventId = Number((await database!.query<{ id: number }>(`
        INSERT INTO events (kind, actor, detail, at)
        VALUES ('place_renamed', 'founder', jsonb_build_object(
          'place_id', $1::integer,
          'name', 'current-room-name',
          'former_name', 'former-room-name'
        ), clock_timestamp())
        RETURNING id
      `, [roomId])).rows[0]!.id)
    const snapshotState = async () => ({
      definition: (await database!.query<{ definition: string }>(`
          SELECT pg_get_viewdef(
            'city_snapshot.public_records_without_drawing_contract'::regclass,
            true
          ) AS definition
        `)).rows[0]!.definition,
      rows: (await database!.query(`
          SELECT class_name, record_id, payload
          FROM city_snapshot.public_records_without_drawing_contract
          WHERE (class_name = 'events' AND record_id = $1::text)
            OR (class_name = 'public_presence' AND record_id = '1')
          ORDER BY class_name
        `, [eventId])).rows,
    })

    const fresh = await snapshotState()
    await database!.query(preLifecycleSnapshotMigrationDdl)
    const stale = await snapshotState()
    assert.notDeepEqual(stale, fresh, 'the fixture must represent the pre-lifecycle snapshot')

    await database!.query(placeLifecycleMigrationDdl)
    await database!.query(placeLifecycleMigrationDdl)
    await database!.query(quietSnapshotMigrationDdl)
    await database!.query(quietSnapshotMigrationDdl)
    assert.deepEqual(await snapshotState(), fresh)
    const presence = fresh.rows.find(row => row.class_name === 'public_presence')
    const event = fresh.rows.find(row => row.class_name === 'events')
    assert.equal(presence?.payload.asleep, false)
    assert.deepEqual(event?.payload.detail, {
      place_id: roomId,
      name: 'current-room-name',
      former_name: 'former-room-name',
    })
  })

  await t.test('law replacement keeps typed actor IDs and append-only history', async () => {
    const roomId = await resetDatabase()
    const initial = await replacePlaceLaws(actor, roomId, ['peaceful', 'war-zone'])
    assert.equal('error' in initial, false)
    const replaced = await replacePlaceLaws(actor, roomId, ['war-zone'])
    assert.equal('error' in replaced, false)
    assert.deepEqual(replaced, [{ id: 2, name: 'war-zone', position: 0 }])
    const history = await database!.query(`
        SELECT change.actor_id, change.change_type, change.position, trait.name
        FROM place_law_changes change
        JOIN traits trait ON trait.id = change.trait_id
        WHERE change.place_id = $1
        ORDER BY change.id
      `, [roomId])
    assert.deepEqual(history.rows, [
      { actor_id: 1, change_type: 'add', position: 0, name: 'peaceful' },
      { actor_id: 1, change_type: 'add', position: 1, name: 'war-zone' },
      { actor_id: 1, change_type: 'remove', position: null, name: 'peaceful' },
      { actor_id: 1, change_type: 'add', position: 0, name: 'war-zone' },
    ])
    const events = await database!.query(`
        SELECT kind, detail FROM events
        WHERE kind = 'laws_changed'
        ORDER BY id
      `)
    assert.deepEqual(events.rows, [
      { kind: 'laws_changed', detail: { place_id: roomId, traits: ['peaceful', 'war-zone'] } },
      { kind: 'laws_changed', detail: { place_id: roomId, traits: ['war-zone'] } },
    ])
  })
  await t.test('withdrawal writes the timestamp and event in one statement', async () => {
    await resetDatabase()
    const result = await withdrawThing(actor, 1, 'destroyed')
    assert.equal('error' in result, false)
    assert.ok(Number.isFinite(Date.parse(String('withdrawn_at' in result ? result.withdrawn_at : ''))))
    const state = await database!.query(`
        SELECT thing.withdrawn_at IS NOT NULL AS withdrawn,
          event.kind, event.detail,
          jsonb_typeof(event.detail->'reason') AS reason_type
        FROM things thing
        JOIN events event ON (event.detail->>'thing_id')::integer = thing.id
        WHERE thing.id = 1
      `)
    assert.deepEqual(state.rows, [{
      withdrawn: true,
      kind: 'thing_withdrawn',
      detail: { thing_id: 1, reason: 'destroyed' },
      reason_type: 'string',
    }])
  })

}
