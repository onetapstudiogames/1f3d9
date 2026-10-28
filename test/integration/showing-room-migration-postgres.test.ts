import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Hono } from 'hono'
import { mountShowingRoomRoutes } from '../../src/showing-room-routes.ts'
import { controlShowingRoom, type ShowingRoomDatabase } from '../../src/showing-room-store.ts'
import { startPostgres } from '../helpers/gazette-fixtures/postgres.ts'

const migrationUrl = new URL('../../db/migrations/20261027_showing_room.sql', import.meta.url)
const activationUrl = new URL('../../db/migrations/20261027_showing_room_activation.sql', import.meta.url)

function beforeShowingRoom(schema: string, migration: string): string {
  const normalized = schema.replaceAll('\r\n', '\n').trim()
  const suffix = migration.replaceAll('\r\n', '\n').trim()
  const offset = normalized.indexOf(suffix)
  assert.ok(suffix.length > 0, 'the complete showing room migration must exist')
  assert.ok(offset > 0, 'the schema must contain the complete showing room migration')
  assert.equal(normalized.indexOf(suffix, offset + 1), -1, 'the showing room migration occurs only once')
  assert.equal(normalized.slice(offset), suffix, 'the showing room migration must follow the merged marker schema')
  const baseline = normalized.slice(0, offset).trim()
  assert.match(baseline, /-- Stored public activity summaries, decision #166\./u)
  assert.doesNotMatch(baseline, /CREATE TABLE IF NOT EXISTS showing_room_/u)
  return baseline
}

function activityAllowance(definition: string): string {
  const allowance = definition.match(/  -- The system-owned activity summary preserves the exact protected room state\.\n[\s\S]*?\n  END IF;/u)?.[0]
  assert.ok(allowance, 'the Gazette guard must retain the marker activity-only allowance')
  return allowance
}

test('showing room migrations require explicit targets and a deployed commit for activation', async () => {
  const { resolveMigrationRun } = await import('../../scripts/migrate.ts')
  const preview = {
    CONFIRM_SHOWING_ROOM: 'INSTALL_DORMANT_SHOWING_ROOM_SERVICE',
    CONFIRM_SHOWING_ROOM_ACTIVATION: 'PREPARE_SHOWING_ROOM_AFTER_MATCHING_APP_DEPLOYMENT',
    CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
    NEON_API_KEY: 'synthetic-test-key', NEON_PROJECT_ID: 'test-project',
    NEON_PREVIEW_BRANCH_ID: 'test-preview', NEON_PRODUCTION_BRANCH_ID: 'test-production',
    PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://test@example.neon.tech/test',
  }
  const schemaRun = resolveMigrationRun(['--target','preview','--migration','showing-room'], preview)
  assert.equal(schemaRun.migrationFile, 'db/migrations/20261027_showing_room.sql')
  assert.equal(schemaRun.liveDeployment, undefined)
  assert.throws(() => resolveMigrationRun(['--target','preview','--migration','showing-room-activation'], preview), /SHOWING_ROOM_DEPLOYMENT_COMMIT/u)
  const activationRun = resolveMigrationRun(['--target','preview','--migration','showing-room-activation'], {
    ...preview, SHOWING_ROOM_DEPLOYMENT_COMMIT: 'a'.repeat(40),
    SHOWING_ROOM_PREVIEW_ORIGIN: 'https://1f3d9-qg56l10xf-onetapstudiogames-projects.vercel.app',
  })
  assert.equal(activationRun.migrationFile, 'db/migrations/20261027_showing_room_activation.sql')
  assert.equal(activationRun.liveDeployment?.commit, 'a'.repeat(40))
})

test('showing room storage installs dormant, stays private, and activates only after a verified deployment', { timeout: 600_000 }, async t => {
  const { database, containerName } = await startPostgres()
  t.after(async () => {
    await database.end()
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8', windowsHide: true })
  })
  const migration = (await readFile(migrationUrl, 'utf8')).replaceAll('\r\n', '\n')
  const activation = await readFile(activationUrl, 'utf8')
  const schema = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
  await database.query(beforeShowingRoom(schema, migration))
  const markerGuard = (await database.query("SELECT pg_get_functiondef('protect_gazette_submission_room()'::regprocedure) AS definition")).rows[0]!.definition as string
  const allowance = activityAllowance(markerGuard)
  await database.query(migration)

  await t.test('the showing migration preserves the merged marker activity-only allowance byte for byte', async () => {
    assert.equal(activityAllowance(migration), allowance)
    const installedGuard = (await database.query("SELECT pg_get_functiondef('protect_gazette_submission_room()'::regprocedure) AS definition")).rows[0]!.definition as string
    assert.equal(activityAllowance(installedGuard), allowance)
    assert.equal((await database.query('SELECT schema_version FROM public_activity_schema_state')).rows.length, 1)
  })
  const stores = await database.query(`
    SELECT count(*)::integer AS count FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN (
      'showing_room_contests', 'showing_room_runs', 'showing_room_publications', 'showing_room_control'
    )
  `)
  assert.equal(stores.rows[0].count, 4, 'the four private showing room stores must exist after the inactive migration')

  await t.test('the schema repeats without enabling the service or granting public access', async () => {
    await database.query(migration)
    const control = (await database.query('SELECT * FROM showing_room_control')).rows
    assert.equal(control.length, 1)
    assert.equal(control[0].enabled, false)
    assert.equal(control[0].paused, true)
    assert.equal(control[0].square_announcement, false)
    assert.equal(control[0].activated_at, null)
    for (const table of ['contests', 'runs', 'publications', 'control']) {
      const grants = await database.query('SELECT has_table_privilege($1, $2, $3) AS allowed', ['city_snapshot_export', `showing_room_${table}`, 'SELECT'])
      assert.equal(grants.rows[0].allowed, false, table)
    }
  })

  await t.test('a changed body limit refuses installation and its failed transaction rolls back', async () => {
    await database.query('ALTER TABLE showing_room_contests DROP CONSTRAINT showing_room_contests_title_check')
    await database.query('ALTER TABLE showing_room_contests ADD CONSTRAINT showing_room_contests_title_check CHECK (char_length(title) BETWEEN 1 AND 121)')
    await assert.rejects(database.query(migration), /reviewed stores, limits and guards/u)
    await database.query('ROLLBACK')
    assert.equal((await database.query('SELECT showing_room_guards_ready() AS ready')).rows[0].ready, false)
    await database.query('ALTER TABLE showing_room_contests DROP CONSTRAINT showing_room_contests_title_check')
    await database.query('ALTER TABLE showing_room_contests ADD CONSTRAINT showing_room_contests_title_check CHECK (char_length(title) BETWEEN 1 AND 120)')
    await database.query(migration)
    assert.equal((await database.query('SELECT showing_room_guards_ready() AS ready')).rows[0].ready, true)
  })

  await t.test('every required check and the open-question index retain their exact meaning', async () => {
    const checks = (await database.query(`SELECT conrelid::regclass::text AS table_name,conname
      FROM pg_constraint WHERE contype='c' AND conrelid IN (
        'showing_room_contests'::regclass,'showing_room_runs'::regclass,
        'showing_room_publications'::regclass,'showing_room_control'::regclass
      ) ORDER BY conrelid,conname`)).rows
    assert.equal(checks.length, 22)
    const connection = await database.connect()
    try {
      for (const check of checks) {
        assert.match(check.table_name, /^[a-z_]+$/u)
        assert.match(check.conname, /^[a-z_]+$/u)
        await connection.query('BEGIN')
        try {
          await connection.query(`ALTER TABLE ${check.table_name} DROP CONSTRAINT ${check.conname}`)
          await connection.query(`ALTER TABLE ${check.table_name} ADD CONSTRAINT ${check.conname} CHECK(TRUE)`)
          assert.equal((await connection.query('SELECT showing_room_guards_ready() AS ready')).rows[0].ready, false, check.conname)
        } finally { await connection.query('ROLLBACK') }
      }
      for (const replacement of ["(id) WHERE state='open'", "(state) WHERE state='OPEN'"]) {
        await connection.query('BEGIN')
        try {
          await connection.query('DROP INDEX showing_room_one_open')
          await connection.query(`CREATE UNIQUE INDEX showing_room_one_open ON showing_room_contests ${replacement}`)
          assert.equal((await connection.query('SELECT showing_room_guards_ready() AS ready')).rows[0].ready, false, replacement)
        } finally { await connection.query('ROLLBACK') }
      }
    } finally { connection.release() }
  })

  await database.query(`
    INSERT INTO residents (id,handle,model,secret_hash) VALUES
      (1,'showing-founder','test',repeat('1',64)), (2,'showing-second','test',repeat('2',64)),
      (5,'showing-entrant','test',repeat('5',64));
    INSERT INTO places (id,parent_id,place_kind,name,description,owner_id,open_to_notes)
    SELECT 2,id,'continent','synthetic continent','Synthetic test place.',1,FALSE FROM places WHERE place_kind='world';
    INSERT INTO places (id,parent_id,place_kind,name,description,owner_id,open_to_notes)
    VALUES (438,2,'place','the showing room','The founder will update this description after deployment.',1,TRUE);
    INSERT INTO places (id,parent_id,place_kind,name,description,purpose,owner_id,open_to_building,open_to_things,open_to_notes)
    VALUES (454,2,'place','the gazette submission room',
      'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
      '',1,FALSE,FALSE,FALSE);
  `)
  await t.test('an accepted dormant square switch survives an unchanged migration rerun', async () => {
    const store: ShowingRoomDatabase = {
      query: async (text, params = []) => (await database.query(text, [...params])).rows,
      transaction: async work => {
        const connection = await database.connect()
        try {
          await connection.query('BEGIN')
          const result = await work({ query: async (text, params = []) => (await connection.query(text, [...params])).rows })
          await connection.query('COMMIT')
          return result
        } catch (error) {
          await connection.query('ROLLBACK')
          throw error
        } finally { connection.release() }
      },
    }
    const app = new Hono()
    const unused = async (): Promise<never> => { throw new Error('only the control door is used by this regression') }
    mountShowingRoomRoutes(app, {
      authRootKey: async () => ({ id: 1 }), control: input => controlShowingRoom(store, input),
      list: unused, add: unused, edit: unused,
    })
    const input = { request_id: 'rb8-dormant-square', action: 'square', enabled: true }
    const response = await app.request('/api/founder/showing-room/control', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    })
    assert.equal(response.status, 200)
    const body = await response.json() as Record<string, unknown>
    assert.equal(body.enabled, false)
    assert.equal(body.paused, true)
    assert.equal(body.square_announcement, true)
    const before = (await database.query('SELECT * FROM showing_room_control')).rows
    assert.equal(before[0]!.activated_at, null)
    assert.equal(before[0]!.activation_commit, null)
    assert.equal(before[0]!.management_writes, 1)
    assert.ok(Object.hasOwn(before[0]!.control_requests, input.request_id))
    await database.query(migration)
    assert.deepEqual((await database.query('SELECT * FROM showing_room_control')).rows, before)
    const replay = await controlShowingRoom(store, input)
    assert.deepEqual(replay, { ok: true, value: body })
    assert.deepEqual((await database.query('SELECT * FROM showing_room_control')).rows, before)
  })

  await t.test('all three Gazette room states allow an activity stamp and refuse accompanying public edits', async () => {
    for (const [state, activationFile] of [
      ['closed', null],
      ['open', '20260827_gazette_room_activation.sql'],
      ['withdrawals_open', '20260901_gazette_withdrawal_activation.sql'],
    ] as const) {
      if (activationFile) await database.query(await readFile(new URL(`../../db/migrations/${activationFile}`, import.meta.url), 'utf8'))
      assert.equal((await database.query('SELECT gazette_submission_room_state(place) AS state FROM places place WHERE id=454')).rows[0]!.state, state)
      const before = (await database.query("SELECT to_jsonb(place)-'last_public_action_at' AS retained FROM places place WHERE id=454")).rows
      await database.query('UPDATE places SET last_public_action_at=clock_timestamp() WHERE id=454')
      assert.ok((await database.query('SELECT last_public_action_at FROM places WHERE id=454')).rows[0]!.last_public_action_at)
      await assert.rejects(database.query("UPDATE places SET last_public_action_at=clock_timestamp(),description='changed room' WHERE id=454"), /protected city service/u)
      await assert.rejects(database.query('UPDATE places SET last_public_action_at=clock_timestamp(),owner_id=2 WHERE id=454'), /protected city service/u)
      assert.deepEqual((await database.query("SELECT to_jsonb(place)-'last_public_action_at' AS retained FROM places place WHERE id=454")).rows, before)
    }
  })

  await t.test('unpublished prompt bytes stay outside the export view', async () => {
    await database.query("INSERT INTO showing_room_contests (request_id,request_hash,title,prompt) VALUES ('private-canary','hash','Synthetic prompt','SHOWING_PRIVATE_CANARY_42819')")
    const exported = await database.query("SELECT count(*)::integer AS count FROM city_snapshot.public_records_v3 record WHERE row_to_json(record)::text LIKE '%SHOWING_PRIVATE_CANARY_42819%'")
    assert.equal(exported.rows[0].count, 0)
  })

  await t.test('activation needs a verified commit and preserves showing room description', async () => {
    await assert.rejects(database.query(activation), /verified.*commit|deployment/iu)
    await database.query('ROLLBACK')
    const proof = "SELECT set_config('showing_room.verified_commit', repeat('a',40), true);"
    await database.query(activation.replace('BEGIN;', `BEGIN;\n${proof}`))
    await database.query(activation.replace('BEGIN;', `BEGIN;\n${proof}`))
    const control = (await database.query('SELECT * FROM showing_room_control')).rows[0]
    assert.equal(control.activation_commit, 'a'.repeat(40))
    assert.ok(control.activated_at)
    assert.equal(control.enabled, false, 'founder activation still chooses the first managed slot')
    assert.equal((await database.query('SELECT description FROM places WHERE id=438')).rows[0].description, 'The founder will update this description after deployment.')
    assert.equal((await database.query('SELECT gazette_submission_room_is_open() AS open, gazette_withdrawals_are_open() AS withdrawals')).rows[0].open, true)
    await database.query('UPDATE places SET owner_id=2 WHERE id=438')
    await assert.rejects(database.query(activation.replace('BEGIN;', `BEGIN;\n${proof}`)), /owned by founder #1/u)
    await database.query('ROLLBACK')
    await database.query('UPDATE places SET owner_id=1 WHERE id=438')
  })

  await t.test('at most one managed question opens and published question facts cannot change', async () => {
    await database.query("INSERT INTO notes(id,place_id,author_id,body) VALUES (900001,438,1,'Synthetic rules')")
    await database.query(`UPDATE showing_room_contests SET state='open', question_number=11, rules_note_id=900001,
      opened_at='2026-11-02 15:00Z',entry_closes_at='2026-11-07 15:00Z',vote_closes_at='2026-11-09 15:00Z' WHERE request_id='private-canary'`)
    await assert.rejects(database.query("UPDATE showing_room_contests SET prompt='Changed after opening' WHERE request_id='private-canary'"), /published|opened|immutable/iu)
    await assert.rejects(database.query(`INSERT INTO showing_room_contests(request_id,request_hash,title,prompt,state,question_number,rules_note_id,opened_at,entry_closes_at,vote_closes_at)
      VALUES('second-open','hash','Synthetic','Synthetic','open',12,900001,'2026-11-02 15:00Z','2026-11-07 15:00Z','2026-11-09 15:00Z')`), /unique|one_open/iu)
  })

  await t.test('an activity-stamping note still works after the linked service publication exception is activated', async () => {
    const event = (await database.query(`WITH note AS (
      INSERT INTO notes(place_id,author_id,body) VALUES(454,2,'Synthetic activity-stamping Gazette note') RETURNING id
    ) INSERT INTO events(kind,actor,detail)
      SELECT 'note','showing-second',jsonb_build_object('note_id',id,'place_id',454) FROM note RETURNING id`)).rows[0]!
    const stamps = (await database.query(`SELECT resident.last_public_action_at=event.at AS resident_matches,
      place.last_public_action_at=event.at AS room_matches FROM residents resident CROSS JOIN places place
      CROSS JOIN events event WHERE resident.id=2 AND place.id=454 AND event.id=$1`, [event.id])).rows[0]!
    assert.deepEqual(stamps, { resident_matches: true, room_matches: true })
    await assert.rejects(database.query("UPDATE places SET last_public_action_at=clock_timestamp(),description='changed active room' WHERE id=454"), /protected city service/u)
    await assert.rejects(database.query('UPDATE places SET last_public_action_at=clock_timestamp(),owner_id=2 WHERE id=454'), /protected city service/u)
  })

  await t.test('active admission uses database time and valid publication links alone bypass the Gazette limit', async () => {
    await database.query("UPDATE showing_room_control SET enabled=TRUE,paused=FALSE,first_slot_at='2026-11-02 15:00Z',first_question_number=11")
    const note = await database.query("INSERT INTO notes(place_id,author_id,body,created_at) VALUES(438,5,'ENTRY Synthetic\nSynthetic body','2020-01-01') RETURNING created_at")
    assert.ok(note.rows[0].created_at.getUTCFullYear() >= 2026)
    for (let index=0; index<3; index++) await database.query('INSERT INTO notes(place_id,author_id,body) VALUES(454,1,$1)', [`ordinary synthetic ${index}`])
    await assert.rejects(database.query("INSERT INTO notes(place_id,author_id,body) VALUES(454,1,'fourth ordinary')"), /3 Gazette submissions/iu)
    const connection = await database.connect()
    try {
      await connection.query('BEGIN')
      const run = (await connection.query("INSERT INTO showing_room_runs(slot_at,result) VALUES('2026-11-09 15:00Z','{}') RETURNING id")).rows[0].id
      const noteId = (await connection.query("SELECT nextval(pg_get_serial_sequence('notes','id')) AS id")).rows[0].id
      await connection.query("INSERT INTO showing_room_publications(run_id,purpose,part,note_id,place_id) VALUES($1,'gazette',1,$2,454)", [run,noteId])
      await connection.query("INSERT INTO notes(id,place_id,author_id,body) VALUES($1,454,1,'Synthetic recorded weekly report')", [noteId])
      await connection.query('UPDATE showing_room_runs SET completed_at=clock_timestamp() WHERE id=$1', [run])
      await connection.query('COMMIT')
    } finally { connection.release() }
    await assert.rejects(database.query("INSERT INTO notes(place_id,author_id,body) VALUES(454,1,'ordinary after report')"), /3 Gazette submissions/iu)
  })

  await t.test('completed records are immutable and deferred publication links reject missing notes', async () => {
    await assert.rejects(database.query("UPDATE showing_room_runs SET result='{\"changed\":true}' WHERE slot_at='2026-11-09 15:00Z'"), /completed|immutable/iu)
    await assert.rejects(database.query("DELETE FROM showing_room_runs WHERE slot_at='2026-11-09 15:00Z'"), /completed|immutable|retained/iu)
    await assert.rejects(database.query("INSERT INTO showing_room_publications(run_id,purpose,part,note_id,place_id) SELECT id,'count',99,9999999,438 FROM showing_room_runs LIMIT 1"), /unfinished showing room run/iu)
    const connection = await database.connect()
    try {
      await connection.query('BEGIN')
      const run = (await connection.query("INSERT INTO showing_room_runs(slot_at,result) VALUES('2026-11-16 15:00Z','{}') RETURNING id")).rows[0].id
      await connection.query("INSERT INTO showing_room_publications(run_id,purpose,part,note_id,place_id) VALUES($1,'count',1,9999999,438)", [run])
      await connection.query('UPDATE showing_room_runs SET completed_at=clock_timestamp() WHERE id=$1', [run])
      await assert.rejects(connection.query('COMMIT'), /foreign key/u)
      await connection.query('ROLLBACK')
    } finally { connection.release() }
    assert.equal((await database.query("SELECT count(*)::integer AS count FROM showing_room_runs WHERE slot_at='2026-11-16 15:00Z'")).rows[0].count, 0)
    await assert.rejects(database.query('TRUNCATE showing_room_runs CASCADE'), /history must be retained/u)
  })
})
