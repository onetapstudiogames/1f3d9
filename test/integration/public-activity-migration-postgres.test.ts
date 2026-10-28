import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { FOUNDER, GROWER, NEIGHBOUR } from '../helpers/abilities-fixtures.ts'
import { resetCity, startNoteSuiteDatabase } from '../helpers/note-suite-fixtures/postgres.ts'
import { publicActivitySql } from '../../src/public-activity.ts'
import { earlierStoredActivityMigration } from '../helpers/earlier-stored-activity-migration.ts'

const migrationUrl = new URL('../../db/migrations/20261028_stored_public_activity.sql', import.meta.url)

test('stored public activity migration preserves choices, proof, transactions and protected rooms', { timeout: 600_000 }, async t => {
  let postgres: Awaited<ReturnType<typeof startNoteSuiteDatabase>> | undefined
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { postgres = await startNoteSuiteDatabase('stored-activity-migration'); break } catch (error) {
      if (attempt === 3) throw error
    }
  }
  assert.ok(postgres)
  const db = postgres.client
  try {
    const rooms = await resetCity([FOUNDER, GROWER, NEIGHBOUR])
    await t.test('fresh schema has two nullable stamps and one required default-true choice', async () => {
      const columns = (await db.query(`SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns WHERE table_schema='public'
        AND column_name IN ('last_public_action_at','show_activity') ORDER BY table_name,column_name`)).rows
      assert.deepEqual(columns, [
        { table_name: 'places', column_name: 'last_public_action_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
        { table_name: 'residents', column_name: 'last_public_action_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
        { table_name: 'residents', column_name: 'show_activity', data_type: 'boolean', is_nullable: 'NO', column_default: 'true' },
      ])
    })
    const migration = await readFile(migrationUrl, 'utf8')
    await t.test('the earlier applied migration upgrades in place with its receipt and saved state intact', async () => {
      const versionTwo = earlierStoredActivityMigration(migration)
      assert.equal(createHash('sha256').update(versionTwo).digest('hex'),
        'a701b4e8eb9b99d73f4c68faa909e578c10932215b18376e4b9e0bcde2d7de57')
      const earlier = versionTwo
        .replace('  -- Allow small clock retreats; readers omit a stamp until their database time reaches it.\n', '')
        .replaceAll(" + interval '5 seconds'", '')
      assert.equal(createHash('sha256').update(earlier).digest('hex'),
        'bec56c98de5740f41b80077ad4472679043809327cd3423b16770913e3f43e6d')
      await db.query(earlier)
      await db.query(`INSERT INTO events(kind,actor,detail,at)
        VALUES ('register',$1,'{}',clock_timestamp()-interval '1 hour')`, [GROWER.handle])
      await db.query('UPDATE residents SET show_activity=false WHERE id=$1', [GROWER.id])
      const saved = (await db.query('SELECT last_public_action_at,show_activity FROM residents WHERE id=$1', [GROWER.id])).rows
      const receipt = (await db.query('SELECT * FROM public_activity_schema_state')).rows
      await assert.rejects(db.query(`INSERT INTO events(kind,actor,detail,at)
        VALUES ('register',$1,'{}',clock_timestamp()+interval '400 milliseconds')`, [GROWER.handle]), /event time/u)
      await db.query(versionTwo)
      assert.deepEqual((await db.query('SELECT * FROM public_activity_schema_state')).rows, receipt)
      await db.query(migration)
      await db.query(migration)
      assert.deepEqual((await db.query('SELECT last_public_action_at,show_activity FROM residents WHERE id=$1', [GROWER.id])).rows, saved)
      assert.deepEqual((await db.query('SELECT * FROM public_activity_schema_state')).rows, receipt)
      await db.query(`INSERT INTO events(kind,actor,detail,at)
        VALUES ('register',$1,'{}',clock_timestamp()+interval '400 milliseconds')`, [GROWER.handle])
      await resetCity([FOUNDER, GROWER, NEIGHBOUR])
    })
    await t.test('a small clock retreat preserves event time and never computes a band from future time', async () => {
      const event = (await db.query(`INSERT INTO events(kind,actor,detail,at)
        VALUES ('note',$1,$2::jsonb,clock_timestamp()+interval '400 milliseconds') RETURNING id,at::text`,
      [GROWER.handle, JSON.stringify({ applied_public_activity: [
        { actor: GROWER.handle, operation: 'note', place_id: rooms.eastRoomId },
      ] })])).rows[0]!
      const check = async () => {
        const row = (await db.query(`SELECT event.at=$3::timestamptz AS event_unchanged,
          resident.last_public_action_at=place.last_public_action_at AS same_stamp,
          resident.last_public_action_at=event.at AS exact_stamp,
          ${publicActivitySql('resident', true).replaceAll('statement_timestamp()', "event.at-interval '1 millisecond'")} AS before_event,
          ${publicActivitySql('resident', true).replaceAll('statement_timestamp()', 'event.at')} AS at_event
          FROM events event CROSS JOIN residents resident CROSS JOIN places place
          WHERE event.id=$1 AND resident.id=$2 AND place.id=$4`,
        [event.id, GROWER.id, event.at, rooms.eastRoomId])).rows[0]!
        assert.deepEqual(row, { event_unchanged: true, same_stamp: true, exact_stamp: true, before_event: null, at_event: 'active now' })
      }
      await check()
      await db.query('SELECT recompute_public_activity(NULL,NULL,NULL)')
      await check()
      await resetCity([FOUNDER, GROWER, NEIGHBOUR])
    })
    await t.test('explicit outcomes advance the actor and destination, and empty outcomes do not', async () => {
      await db.query(`INSERT INTO events(kind,actor,detail,at) VALUES ('action',$1,$2::jsonb,now()-interval '2 hours')`,
        [GROWER.handle, JSON.stringify({ status: 'applied', applied_public_activity: [{ actor: GROWER.handle, operation: 'move', place_id: rooms.westRoomId }] })])
      const before = (await db.query('SELECT last_public_action_at FROM residents WHERE id=$1', [GROWER.id])).rows[0]
      assert.ok(before?.last_public_action_at)
      await db.query(`INSERT INTO events(kind,actor,detail) VALUES ('home_set',$1,$2::jsonb)`,
        [GROWER.handle, JSON.stringify({ place_id: rooms.eastRoomId, applied_public_activity: [] })])
      assert.deepEqual((await db.query('SELECT last_public_action_at FROM residents WHERE id=$1', [GROWER.id])).rows[0], before)
      assert.equal((await db.query('SELECT last_public_action_at FROM places WHERE id=$1', [rooms.eastRoomId])).rows[0]!.last_public_action_at, null)
    })
    await t.test('reruns preserve false choices and newer stamps without repeating backfill', async () => {
      await db.query('UPDATE residents SET show_activity=false WHERE id=$1', [GROWER.id])
      const before = (await db.query('SELECT last_public_action_at,show_activity FROM residents WHERE id=$1', [GROWER.id])).rows
      const receipt = (await db.query('SELECT * FROM public_activity_schema_state')).rows
      await db.query(migration)
      await db.query(migration)
      assert.deepEqual((await db.query('SELECT last_public_action_at,show_activity FROM residents WHERE id=$1', [GROWER.id])).rows, before)
      assert.deepEqual((await db.query('SELECT * FROM public_activity_schema_state')).rows, receipt)
    })
    await t.test('world arrival stamps but a stamp with a forbidden edit still refuses', async () => {
      const world = Number((await db.query("SELECT id FROM places WHERE place_kind='world'")).rows[0]!.id)
      const before = (await db.query('SELECT last_public_action_at FROM residents WHERE id=$1', [GROWER.id])).rows[0]!.last_public_action_at as Date
      await db.query(`INSERT INTO events(kind,actor,detail) VALUES ('action',$1,$2::jsonb)`,
        [GROWER.handle, JSON.stringify({ status: 'applied', applied_public_activity: [{ actor: GROWER.handle, operation: 'move', place_id: world }] })])
      assert.ok((await db.query('SELECT last_public_action_at FROM places WHERE id=$1', [world])).rows[0]!.last_public_action_at)
      const resident = (await db.query('SELECT show_activity,last_public_action_at FROM residents WHERE id=$1', [GROWER.id])).rows[0]!
      assert.equal(resident.show_activity, false)
      assert.ok((resident.last_public_action_at as Date) > before)
      await assert.rejects(db.query("UPDATE places SET last_public_action_at=now(),name='changed world' WHERE id=$1", [world]), /immutable/u)
      await assert.rejects(db.query('DELETE FROM places WHERE id=$1', [world]), /cannot be deleted/u)
    })
    await t.test('transaction and savepoint aborts preserve stamps and future event times refuse', async () => {
      const before = (await db.query('SELECT id,last_public_action_at FROM residents ORDER BY id')).rows
      const connection = await db.connect()
      try {
        await connection.query('BEGIN')
        await connection.query('SAVEPOINT attempt')
        await connection.query(`INSERT INTO events(kind,actor,detail) VALUES ('action',$1,$2::jsonb)`,
          [GROWER.handle, JSON.stringify({ applied_public_activity: [{ actor: GROWER.handle, operation: 'label', place_id: rooms.eastRoomId }] })])
        await connection.query('ROLLBACK TO SAVEPOINT attempt')
        await connection.query('COMMIT')
      } finally { connection.release() }
      assert.deepEqual((await db.query('SELECT id,last_public_action_at FROM residents ORDER BY id')).rows, before)
      for (const at of ["clock_timestamp()+interval '1 hour'", "'infinity'::timestamptz", "'-infinity'::timestamptz"]) {
        await assert.rejects(db.query(`INSERT INTO events(kind,actor,detail,at) VALUES ('note',$1,$2::jsonb,${at})`,
          [GROWER.handle, JSON.stringify({ applied_public_activity: [{ actor: GROWER.handle, operation: 'note', place_id: rooms.eastRoomId }] })]), /event time/u)
      }
    })
    await t.test('same-statement resident and place creation stamp with deferred and early immediate constraints', async () => {
      for (const [index, immediate] of [false, true].entries()) {
        const connection = await db.connect()
        try {
          await connection.query('BEGIN')
          if (immediate) await connection.query('SET CONSTRAINTS ALL IMMEDIATE')
          const residentId = 20 + index
          await connection.query(`WITH created AS (
            INSERT INTO residents(id,handle,model,secret_hash) VALUES ($1,$2,'test',repeat(md5($2),2)) RETURNING id,handle
          ) INSERT INTO events(kind,actor,detail) SELECT 'register',handle,jsonb_build_object('resident_id',id) FROM created`,
          [residentId, `created-${index}`])
          const place = Number((await connection.query(`WITH created AS (
            INSERT INTO places(parent_id,place_kind,name,owner_id) VALUES ($1,'place',$2,$3) RETURNING id
          ), event AS (
            INSERT INTO events(kind,actor,detail) SELECT 'place_created',$4,jsonb_build_object('place_id',id) FROM created
          ) SELECT id FROM created`, [rooms.continentId, `created room ${index}`, residentId, `created-${index}`])).rows[0]!.id)
          await connection.query('COMMIT')
          assert.ok((await db.query('SELECT last_public_action_at FROM residents WHERE id=$1', [residentId])).rows[0]!.last_public_action_at)
          assert.ok((await db.query('SELECT last_public_action_at FROM places WHERE id=$1', [place])).rows[0]!.last_public_action_at)
        } finally { connection.release() }
      }
      const connection = await db.connect()
      try {
        await connection.query('BEGIN')
        await connection.query('SET CONSTRAINTS ALL IMMEDIATE')
        await connection.query(`WITH created AS (
          INSERT INTO residents(id,handle,model,secret_hash) VALUES (99,'rolled-back-creation','test',repeat('8',64)) RETURNING id,handle
        ) INSERT INTO events(kind,actor,detail) SELECT 'register',handle,jsonb_build_object('resident_id',id) FROM created`)
        await connection.query('ROLLBACK')
        assert.equal((await db.query('SELECT id FROM residents WHERE id=99')).rowCount, 0)
        assert.equal((await db.query("SELECT id FROM events WHERE actor='rolled-back-creation'")).rowCount, 0)
      } finally { connection.release() }
    })
    await t.test('closed, open and withdrawal-ready Gazette states allow only summary maintenance', async () => {
      await db.query(`INSERT INTO places(id,parent_id,place_kind,name,description,purpose,owner_id,open_to_notes,open_to_building,open_to_things)
        VALUES (454,2,'place','the gazette submission room',$1,'',1,false,false,false)`, [
        'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
      ])
      for (const activation of [null, '20260827_gazette_room_activation.sql', '20260901_gazette_withdrawal_activation.sql']) {
        if (activation) await db.query(await readFile(new URL(`../../db/migrations/${activation}`, import.meta.url), 'utf8'))
        await db.query("UPDATE places SET last_public_action_at=clock_timestamp() WHERE id=454")
        await assert.rejects(db.query("UPDATE places SET last_public_action_at=clock_timestamp(),description='changed room' WHERE id=454"), /protected city service/u)
        await assert.rejects(db.query('UPDATE places SET last_public_action_at=clock_timestamp(),owner_id=2 WHERE id=454'), /protected city service/u)
        await assert.rejects(db.query('DELETE FROM places WHERE id=454'), /protected city service/u)
      }
      await db.query(`WITH note AS (INSERT INTO notes(place_id,author_id,body) VALUES (454,2,'a Gazette submission') RETURNING id)
        INSERT INTO events(kind,actor,detail) SELECT 'note',$1,jsonb_build_object('note_id',id,'place_id',454) FROM note`, [GROWER.handle])
      await db.query(`INSERT INTO events(kind,actor,detail) VALUES ('gazette_printed','the city','{"place_id":454,"issue_id":1}'::jsonb)`)
      assert.ok((await db.query('SELECT last_public_action_at FROM places WHERE id=454')).rows[0]!.last_public_action_at)
    })
    await t.test('legacy upgrade backfills a complete cut once and full schema twice preserves it', async () => {
      const schema = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
      const prepared = schema.split('-- Stored public activity summaries, decision #166.')[0]!
      await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
      await db.query(prepared)
      await assert.rejects(db.query("UPDATE places SET name=name WHERE place_kind='world'"), /immutable/u)
      await db.query(`INSERT INTO residents(id,handle,model,secret_hash) VALUES
        (1,'founder','test',repeat('1',64)),(2,'seed-keeper','test',repeat('2',64)),(3,'next-door','test',repeat('3',64))`)
      await db.query(`INSERT INTO places(id,parent_id,place_kind,name,owner_id) VALUES (2,1,'continent','backfill continent',1),(3,2,'place','backfill room',1)`)
      await db.query(`WITH note AS (INSERT INTO notes(place_id,author_id,body,created_at) VALUES (3,2,'historical note',now()-interval '10 days') RETURNING id)
        INSERT INTO events(kind,actor,detail,at) SELECT 'note','seed-keeper',jsonb_build_object('note_id',id),now()-interval '10 days' FROM note`)
      await db.query(`INSERT INTO events(kind,actor,detail,at) VALUES
        ('home_set','seed-keeper','{"place_id":3}',now()-interval '9 days'),
        ('home_set','seed-keeper','{"place_id":3}',now()-interval '8 days'),
        ('laws_changed','seed-keeper','{"place_id":3,"traits":[]}',now()-interval '7 days'),
        ('action','next-door','{"action":"use","status":"applied","place_id":3}',now()-interval '6 days')`)
      await db.query(migration)
      const resident = (await db.query("SELECT last_public_action_at FROM residents WHERE handle='seed-keeper'")).rows[0]!
      assert.equal(resident.last_public_action_at, null)
      assert.equal((await db.query('SELECT last_public_action_at FROM places WHERE id=3')).rows[0]!.last_public_action_at, null)
      assert.equal(Number((await db.query('SELECT unproved_candidates FROM public_activity_schema_state')).rows[0]!.unproved_candidates), 2)
      await db.query("UPDATE residents SET show_activity=false WHERE id=2")
      const receipt = (await db.query('SELECT * FROM public_activity_schema_state')).rows
      await db.query(schema)
      await db.query(schema)
      await db.query(migration)
      assert.deepEqual((await db.query('SELECT * FROM public_activity_schema_state')).rows, receipt)
      assert.equal((await db.query('SELECT show_activity FROM residents WHERE id=2')).rows[0]!.show_activity, false)
    })
    await t.test('moderation and ancestor feed changes recompute affected source history', async () => {
      await resetCity([FOUNDER, GROWER, NEIGHBOUR])
      const note = Number((await db.query(`INSERT INTO notes(place_id,author_id,body) VALUES ($1,2,'newest note') RETURNING id`, [rooms.eastRoomId])).rows[0]!.id)
      await db.query(`INSERT INTO events(kind,actor,detail,at) VALUES ('register',$1,'{}',now()-interval '2 hours'),
        ('note',$1,$2::jsonb,now()-interval '1 hour')`, [GROWER.handle, JSON.stringify({ note_id: note, place_id: rooms.eastRoomId })])
      const stamp = async () => (await db.query('SELECT last_public_action_at FROM residents WHERE id=2')).rows[0]!.last_public_action_at
      const newest = await stamp()
      await db.query(`INSERT INTO moderation_actions(target_type,target_id,action,actor_id,reason) VALUES ('note',$1,'remove',1,'test removal')`, [note])
      assert.ok(await stamp() < newest)
      await db.query(`INSERT INTO moderation_actions(target_type,target_id,action,actor_id,reason) VALUES ('note',$1,'restore',1,'test restore')`, [note])
      assert.deepEqual(await stamp(), newest)
      await db.query('UPDATE places SET quiet=true,feed=true WHERE id=$1', [rooms.continentId])
      assert.ok(await stamp() < newest)
      await db.query('UPDATE places SET feed=false WHERE id=$1', [rooms.continentId])
      assert.deepEqual(await stamp(), newest)
    })
    await t.test('the actual read-only verifier rejects altered function bodies and raw-column grants', async () => {
      const { resolvePublicActivityTarget, verifyPublicActivity } = await import('../../scripts/verify-public-activity.ts')
      const target = resolvePublicActivityTarget(['--target', 'preview'], {
        NEON_API_KEY: 'test-key', NEON_PROJECT_ID: 'project-test', NEON_PREVIEW_BRANCH_ID: 'branch-test',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production', PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://test@fixture.neon.tech/db',
      })
      const verify = () => verifyPublicActivity(target, {
        fetcher: async () => Response.json({ endpoints: [{ id: 'ep-test', host: 'fixture.neon.tech', project_id: 'project-test', branch_id: 'branch-test', type: 'read_write' }] }),
        connect: async () => {
          const client = await db.connect()
          return { query: (statement: string, values?: unknown[]) => client.query(statement, values), end: async () => { client.release() } }
        },
      })
      assert.deepEqual(await verify(), { verified: true, target: 'preview' })
      await db.query('GRANT SELECT(last_public_action_at) ON residents TO city_snapshot_export')
      await assert.rejects(verify(), /public activity verification failed/u)
      await db.query('REVOKE SELECT(last_public_action_at) ON residents FROM city_snapshot_export')
      await db.query("CREATE OR REPLACE FUNCTION public_activity_id(value text) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT NULL::integer'")
      await assert.rejects(verify(), /public activity verification failed/u)
      await db.query(migration)
      assert.deepEqual(await verify(), { verified: true, target: 'preview' })
      for (const [change, restore] of [
        ['ALTER TABLE resident_presence DISABLE TRIGGER resident_presence_reject_retired_place',
          'ALTER TABLE resident_presence ENABLE TRIGGER resident_presence_reject_retired_place'],
        ['DROP TRIGGER resident_presence_reject_retired_place ON resident_presence',
          'CREATE TRIGGER resident_presence_reject_retired_place BEFORE INSERT OR UPDATE OF current_place_id, home_place_id ON resident_presence FOR EACH ROW EXECUTE FUNCTION reject_retired_place_target()'],
        ['DROP TRIGGER resident_presence_reject_retired_place ON resident_presence; CREATE TRIGGER resident_presence_reject_retired_place BEFORE INSERT OR UPDATE OF current_place_id ON resident_presence FOR EACH ROW EXECUTE FUNCTION reject_retired_place_target()',
          'DROP TRIGGER resident_presence_reject_retired_place ON resident_presence; CREATE TRIGGER resident_presence_reject_retired_place BEFORE INSERT OR UPDATE OF current_place_id, home_place_id ON resident_presence FOR EACH ROW EXECUTE FUNCTION reject_retired_place_target()'],
        ['ALTER FUNCTION public_activity_history() SECURITY DEFINER', 'ALTER FUNCTION public_activity_history() SECURITY INVOKER'],
        ["ALTER FUNCTION public_activity_history() SET search_path TO public", 'ALTER FUNCTION public_activity_history() RESET ALL'],
        ['ALTER FUNCTION public_activity_history() VOLATILE', 'ALTER FUNCTION public_activity_history() STABLE'],
        ['GRANT SELECT(unproved_reasons) ON public_activity_schema_state TO city_snapshot_export', 'REVOKE SELECT(unproved_reasons) ON public_activity_schema_state FROM city_snapshot_export'],
        ['GRANT EXECUTE ON FUNCTION public_activity_summaries() TO city_snapshot_export', 'REVOKE EXECUTE ON FUNCTION public_activity_summaries() FROM city_snapshot_export'],
        ['ALTER TABLE public_activity_schema_state ADD COLUMN unreviewed integer', 'ALTER TABLE public_activity_schema_state DROP COLUMN unreviewed'],
        ['ALTER TABLE public_activity_schema_state DROP CONSTRAINT public_activity_schema_state_schema_version_check', 'ALTER TABLE public_activity_schema_state ADD CONSTRAINT public_activity_schema_state_schema_version_check CHECK(schema_version=1)'],
        ['ALTER TABLE public_activity_schema_state DROP CONSTRAINT public_activity_schema_state_schema_version_check; ALTER TABLE public_activity_schema_state ADD CONSTRAINT duplicate_singleton CHECK(singleton)',
          'ALTER TABLE public_activity_schema_state DROP CONSTRAINT duplicate_singleton; ALTER TABLE public_activity_schema_state ADD CONSTRAINT public_activity_schema_state_schema_version_check CHECK(schema_version=1)'],
      ]) {
        await db.query(change!)
        await assert.rejects(verify(), /public activity verification failed/u, change)
        await db.query(restore!)
        assert.deepEqual(await verify(), { verified: true, target: 'preview' })
      }
      await db.query('DROP TRIGGER places_invalidate_public_activity ON places')
      await db.query(`CREATE TRIGGER places_invalidate_public_activity AFTER UPDATE OF name ON places
        FOR EACH ROW WHEN (OLD.feed IS DISTINCT FROM NEW.feed) EXECUTE FUNCTION invalidate_public_activity()`)
      await assert.rejects(verify(), /public activity verification failed/u)
      await db.query(migration)
      await db.query('DROP FUNCTION public_activity_feed_room(integer)')
      await assert.rejects(verify(), /public activity verification failed/u)
      await db.query(migration)
      assert.deepEqual(await verify(), { verified: true, target: 'preview' })
      const idFunction = migration.match(/CREATE OR REPLACE FUNCTION public_activity_id\([\s\S]+?END \$f\$;/u)?.[0]
      assert.ok(idFunction)
      await db.query(idFunction.replace('value text)', 'value text DEFAULT NULL)'))
      await assert.rejects(verify(), /public activity verification failed/u)
      await db.query('DROP FUNCTION public_activity_id(text)')
      await db.query(migration)
      assert.deepEqual(await verify(), { verified: true, target: 'preview' })
    })
    await t.test('upgrade accepts a small clock retreat without changing event time or its receipt on rerun', async () => {
      const schema = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
      await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
      await db.query(schema.split('-- Stored public activity summaries, decision #166.')[0]!)
      await db.query(`INSERT INTO residents(id,handle,model,secret_hash)
        VALUES (1,'founder','test',repeat('1',64))`)
      await db.query(`INSERT INTO places(id,parent_id,place_kind,name,owner_id)
        VALUES (2,1,'continent','clock test',1),(3,2,'place','clock room',1)`)
      await db.query(`INSERT INTO events(kind,actor,detail,at) VALUES ('note','founder',
        '{"applied_public_activity":[{"actor":"founder","operation":"note","place_id":3}]}',
        clock_timestamp()+interval '3 seconds')`)
      await db.query(migration)
      const row = (await db.query(`SELECT resident.last_public_action_at=place.last_public_action_at AS same_stamp,
        resident.last_public_action_at=event.at AS exact_stamp,
        ${publicActivitySql('resident', true).replaceAll('statement_timestamp()', "event.at-interval '1 millisecond'")} AS before_event,
        ${publicActivitySql('resident', true).replaceAll('statement_timestamp()', 'event.at')} AS at_event
        FROM residents resident CROSS JOIN places place CROSS JOIN events event
        WHERE resident.id=1 AND place.id=3 AND event.kind='note'`)).rows[0]!
      assert.deepEqual(row, { same_stamp: true, exact_stamp: true, before_event: null, at_event: 'active now' })
      const receipt = (await db.query('SELECT * FROM public_activity_schema_state')).rows
      await db.query(migration)
      assert.deepEqual((await db.query('SELECT * FROM public_activity_schema_state')).rows, receipt)
    })
    await t.test('upgrade rejects hidden future history and rolls back every added column', async () => {
      const schema = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
      await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
      await db.query(schema.split('-- Stored public activity summaries, decision #166.')[0]!)
      await db.query(`INSERT INTO residents(id,handle,model,secret_hash) VALUES
        (1,'founder','test',repeat('1',64)),(2,'seed-keeper','test',repeat('2',64))`)
      await db.query(`INSERT INTO places(id,parent_id,place_kind,name,owner_id) VALUES (2,1,'continent','future test',1),(3,2,'place','hidden room',1)`)
      const note = Number((await db.query("INSERT INTO notes(place_id,author_id,body) VALUES (3,2,'hidden future history') RETURNING id")).rows[0]!.id)
      await db.query(`INSERT INTO moderation_actions(target_type,target_id,action,actor_id,reason) VALUES ('note',$1,'remove',1,'hidden history')`, [note])
      await db.query(`INSERT INTO events(kind,actor,detail,at) VALUES ('note','seed-keeper',jsonb_build_object('note_id',$1::integer,'place_id',3),now()+interval '1 hour')`, [note])
      await assert.rejects(db.query(migration), /backfill has future or non-finite history/u)
      await db.query('ROLLBACK')
      assert.deepEqual((await db.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND column_name IN ('last_public_action_at','show_activity')`)).rows, [])
      assert.equal((await db.query("SELECT to_regclass('public.public_activity_schema_state') AS receipt")).rows[0]!.receipt, null)
    })
  } finally { await postgres.stop() }
})
