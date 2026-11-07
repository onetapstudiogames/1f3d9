// Thing endings, the stores only, against real PostgreSQL 17: the migration applied twice
// to the city as it is before C1, the inventor backfill, and when a thing's end falls due.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { Pool } from 'pg'
import {
  connectedDatabase,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const migrationDdl = await readFile(
  new URL('../../db/migrations/20261106_thing_endings.sql', import.meta.url),
  'utf8',
)
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const SECTION_MARKER = '\n-- Thing endings, the same statements as\n'
const NEXT_SECTION_MARKER = '\n-- Stored public activity summaries, decision #166.\n'
/** The city's schema as it is before this migration: db/schema.sql with its section removed. */
function schemaBeforeThingEndings(): string {
  const start = schemaDdl.indexOf(SECTION_MARKER)
  assert.ok(start > 0 && start === schemaDdl.lastIndexOf(SECTION_MARKER), 'one thing endings section')
  const end = schemaDdl.indexOf(NEXT_SECTION_MARKER, start)
  assert.ok(end > start && end === schemaDdl.lastIndexOf(NEXT_SECTION_MARKER), 'the thing endings section ends at the next one')
  const before = schemaDdl.slice(0, start) + schemaDdl.slice(end)
  assert.doesNotMatch(before, /thing_end_due|ending_policy|invented_by|thing_ending_changes/u)
  return before
}

const RESIDENTS = [
  { id: 1, handle: 'founder', joined: '2026-01-01T00:00:00Z' },
  { id: 2, handle: 'kind-maker', joined: '2026-02-01T00:00:00Z' },
  { id: 3, handle: 'late-joiner', joined: '2026-09-01T00:00:00Z' },
  { id: 5, handle: 'second-maker', joined: '2026-02-01T00:00:00Z' },
] as const

type Fixture = Readonly<{
  roomId: number
  kinds: Readonly<Record<'single' | 'twice' | 'none' | 'late' | 'stranger', number>>
  thingIds: readonly number[]
}>

async function resetTo(db: Pool, ddl: string): Promise<void> {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await db.query(ddl)
}

async function insertKind(db: Pool, name: string, ownerId: number): Promise<number> {
  const id = Number((await db.query<{ id: number }>(
    'INSERT INTO kinds (name, owner_id) VALUES ($1, $2) RETURNING id', [name, ownerId],
  )).rows[0]!.id)
  await db.query('INSERT INTO kind_revisions (kind_id, revision) VALUES ($1, 1)', [id])
  return id
}

async function inventionEvent(db: Pool, actor: string, kindId: number, at: string): Promise<void> {
  await db.query(
    `INSERT INTO events (kind, actor, detail, at) VALUES ('kind_invented', $1, $2::jsonb, $3::timestamptz)`,
    [actor, JSON.stringify({ kind_id: kindId, name: `kind-${kindId}`, revision: 1 }), at],
  )
}

async function seedCity(db: Pool): Promise<Fixture> {
  for (const resident of RESIDENTS) {
    await db.query(
      `INSERT INTO residents (id, handle, model, secret_hash, joined_at) VALUES ($1, $2, 'thing-endings', $3, $4)`,
      [resident.id, resident.handle, String(resident.id).repeat(64), resident.joined],
    )
  }
  await db.query('UPDATE resident_id_allocator SET last_id = $1 WHERE singleton', [Math.max(...RESIDENTS.map(resident => resident.id))])
  const worldId = Number((await db.query(`SELECT id FROM places WHERE place_kind = 'world'`)).rows[0]!.id)
  const continentId = Number((await db.query(`
    INSERT INTO places (parent_id, place_kind, name, description, owner_id)
    VALUES ($1, 'continent', 'Ending Continent', 'thing endings land', 1) RETURNING id
  `, [worldId])).rows[0]!.id)
  const roomId = Number((await db.query(`
    INSERT INTO places (parent_id, place_kind, name, description, owner_id, open_to_notes)
    VALUES ($1, 'place', 'Ending Room', 'the ending room', 1, TRUE) RETURNING id
  `, [continentId])).rows[0]!.id)

  const kinds = {
    single: await insertKind(db, 'single-proof', 2),
    twice: await insertKind(db, 'two-proofs', 2),
    none: await insertKind(db, 'no-proof', 2),
    late: await insertKind(db, 'late-proof', 3),
    stranger: await insertKind(db, 'stranger-proof', 2),
  }
  await inventionEvent(db, 'kind-maker', kinds.single, '2026-03-01T00:00:00Z')
  await inventionEvent(db, 'kind-maker', kinds.twice, '2026-03-01T00:00:00Z')
  await inventionEvent(db, 'second-maker', kinds.twice, '2026-03-02T00:00:00Z')
  await inventionEvent(db, 'late-joiner', kinds.late, '2026-03-01T00:00:00Z')
  await inventionEvent(db, 'nobody-here', kinds.stranger, '2026-03-01T00:00:00Z')

  const thingIds: number[] = []
  for (const [name, kindId] of [['plain stone', null], ['proven lamp', kinds.single], ['old lamp', kinds.none]] as const) {
    thingIds.push(Number((await db.query(`
      INSERT INTO things (place_id, name, body, owner_id, kind_id, birth_revision, current_revision)
      VALUES ($1, $2, 'a body', 2, $3::integer, $4::integer, $4::integer) RETURNING id
    `, [roomId, name, kindId, kindId === null ? null : 1])).rows[0]!.id))
  }
  await db.query(`
    INSERT INTO active_labels (target_type, target_id, label, actor_id)
    VALUES ('thing', $1, 'worn', 2)
  `, [thingIds[0]])
  return Object.freeze({ roomId, kinds, thingIds })
}

const NEW_THING_COLUMNS = [
  'ending_rule', 'ending_grant', 'ending_set_by', 'ending_set_at', 'ending_deadline',
  'ending_idle_seconds', 'ending_idle_anchor', 'ending_uses_left', 'ending_uses_spent_at',
  'ending_label', 'ending_copied_from', 'ending_copied_at', 'ended_at', 'ended_cause',
  'ended_owner_id', 'end_program_state', 'end_program_result',
] as const

/** Every existing row, without the columns this migration adds. */
async function rowFingerprint(db: Pool): Promise<Record<string, string>> {
  const fingerprints: Record<string, string> = {}
  const tables: readonly (readonly [string, readonly string[]])[] = [
    ['things', NEW_THING_COLUMNS],
    ['kinds', ['invented_by']],
    ['kind_revisions', ['ending_policy']],
    ['events', []],
    ['active_labels', []],
    ['wake_tries', []],
    ['thing_state_changes', []],
  ]
  for (const [table, added] of tables) {
    const row = (await db.query<{ fingerprint: string; total: string }>(`
      SELECT md5(coalesce(string_agg((to_jsonb(r) - $1::text[])::text, '|' ORDER BY (to_jsonb(r))::text), '')) AS fingerprint,
        count(*)::text AS total
      FROM ${table} AS r
    `, [added])).rows[0]!
    fingerprints[table] = `${row.total}:${row.fingerprint}`
  }
  return fingerprints
}

async function assertEveryNamePresent(db: Pool): Promise<void> {
  const columns = (await db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(`
    SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'things' AND column_name = ANY($1::text[])
    ORDER BY column_name
  `, [NEW_THING_COLUMNS])).rows
  assert.equal(columns.length, NEW_THING_COLUMNS.length)
  assert.deepEqual(columns.find(column => column.column_name === 'end_program_state'),
    { column_name: 'end_program_state', data_type: 'text', is_nullable: 'NO', column_default: `'none'::text` })
  for (const column of columns) {
    if (column.column_name !== 'end_program_state') assert.equal(column.is_nullable, 'YES', column.column_name)
  }
  assert.deepEqual((await db.query(`
    SELECT data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'kind_revisions' AND column_name = 'ending_policy'
  `)).rows, [{ data_type: 'jsonb', is_nullable: 'NO', column_default: `'{"allowed": []}'::jsonb` }])
  assert.deepEqual((await db.query(`
    SELECT data_type, is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'kinds' AND column_name = 'invented_by'
  `)).rows, [{ data_type: 'integer', is_nullable: 'YES' }])
  assert.deepEqual((await db.query(`
    SELECT table_name, string_agg(column_name::text, ',' ORDER BY ordinal_position) AS columns
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ('thing_ending_changes', 'agreement_thing_links')
    GROUP BY table_name ORDER BY table_name
  `)).rows, [
    { table_name: 'agreement_thing_links', columns: 'agreement_id,position,thing_id' },
    { table_name: 'thing_ending_changes', columns: 'id,thing_id,change,actor_id,rule,grant,result,action_id,settle_id,created_at' },
  ])

  const constraints = (await db.query<{ conname: string; convalidated: boolean; definition: string }>(`
    SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conname IN ('wake_tries_reason_known', 'thing_state_changes_trigger_known', 'things_ending_rule_shape',
      'things_ending_uses_range', 'things_ending_idle_range', 'things_ended_consistent', 'things_end_program_state_known',
      'kind_revisions_ending_policy_valid', 'kinds_invented_by_fkey')
    ORDER BY conname
  `)).rows
  assert.equal(constraints.length, 9)
  assert.ok(constraints.every(constraint => constraint.convalidated), 'every new check is validated')
  assert.match(constraints.find(row => row.conname === 'wake_tries_reason_known')!.definition, /'end'::text/u)
  assert.match(constraints.find(row => row.conname === 'thing_state_changes_trigger_known')!.definition, /'wake_end'::text/u)
  assert.deepEqual((await db.query(`
    SELECT conname FROM pg_constraint WHERE conrelid = 'wake_tries'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%reason%'
  `)).rows, [{ conname: 'wake_tries_reason_known' }], 'no unnamed check is left on wake_tries.reason')

  assert.deepEqual((await db.query(`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE indexname IN ('things_ending_open', 'things_end_try_pending', 'thing_ending_changes_thing', 'agreement_thing_links_thing')
    ORDER BY indexname
  `)).rows.map(row => row.indexname), [
    'agreement_thing_links_thing', 'thing_ending_changes_thing', 'things_end_try_pending', 'things_ending_open',
  ])
  assert.deepEqual((await db.query(`
    SELECT proname, provolatile FROM pg_proc
    WHERE proname IN ('thing_end_due', 'thing_end_due_at', 'valid_ending_policy', 'kind_provable_inventor')
    ORDER BY proname
  `)).rows, [
    { proname: 'kind_provable_inventor', provolatile: 's' },
    { proname: 'thing_end_due', provolatile: 's' },
    { proname: 'thing_end_due_at', provolatile: 's' },
    { proname: 'valid_ending_policy', provolatile: 'i' },
  ])
  assert.deepEqual((await db.query(`
    SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
      AND tgname IN ('kinds_invented_by_fixed', 'thing_ending_changes_append_only', 'agreement_thing_links_append_only')
    ORDER BY tgname
  `)).rows.map(row => row.tgname), [
    'agreement_thing_links_append_only', 'kinds_invented_by_fixed', 'thing_ending_changes_append_only',
  ])
}

async function inventors(db: Pool): Promise<Record<string, number | null>> {
  const rows = (await db.query<{ name: string; invented_by: number | null }>(
    'SELECT name, invented_by FROM kinds ORDER BY id',
  )).rows
  return Object.fromEntries(rows.map(row => [row.name, row.invented_by]))
}

function refusedBy(constraint: string) {
  return (error: unknown) => {
    assert.equal((error as { constraint?: string }).constraint, constraint, String(error))
    return true
  }
}

test('thing endings stores against real PostgreSQL 17', { timeout: 900_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('thing-endings-schema')
  try {
    const db = connectedDatabase()

    await t.test('the migration applies twice to the city as it was and changes no existing row', async () => {
      await resetTo(db, schemaBeforeThingEndings())
      const fixture = await seedCity(db)
      const before = await rowFingerprint(db)
      await db.query(migrationDdl)
      await db.query(migrationDdl)
      assert.deepEqual(await rowFingerprint(db), before)
      await assertEveryNamePresent(db)

      assert.deepEqual((await db.query(`
        SELECT count(*)::int AS set FROM things WHERE ending_rule IS NOT NULL OR ending_grant IS NOT NULL
          OR ending_set_by IS NOT NULL OR ending_set_at IS NOT NULL OR ending_deadline IS NOT NULL
          OR ending_idle_seconds IS NOT NULL OR ending_uses_left IS NOT NULL OR ending_label IS NOT NULL
          OR ending_copied_from IS NOT NULL OR ended_at IS NOT NULL OR end_program_state <> 'none'
      `)).rows, [{ set: 0 }])
      assert.deepEqual((await db.query(
        `SELECT count(*)::int AS widened FROM kind_revisions WHERE ending_policy <> '{"allowed": []}'::jsonb`,
      )).rows, [{ widened: 0 }])
      assert.deepEqual((await db.query(
        'SELECT (SELECT count(*)::int FROM thing_ending_changes) AS changes, (SELECT count(*)::int FROM agreement_thing_links) AS links',
      )).rows, [{ changes: 0, links: 0 }])

      // One provable event sets the inventor; two events, none, a handle that joined after
      // its event, or a handle nobody holds leave it empty.
      assert.deepEqual(await inventors(db), {
        'single-proof': 2, 'two-proofs': null, 'no-proof': null, 'late-proof': null, 'stranger-proof': null,
      })
      assert.equal(fixture.thingIds.length, 3)
    })

    await t.test('an inventor is fixed once set and filled only from its one provable event', async () => {
      const kindIds = Object.fromEntries((await db.query<{ name: string; id: number }>('SELECT name, id FROM kinds'))
        .rows.map(row => [row.name, row.id]))
      await assert.rejects(
        db.query('UPDATE kinds SET invented_by = 5 WHERE id = $1', [kindIds['single-proof']]),
        refusedBy('kinds_invented_by_fixed'),
      )
      await assert.rejects(
        db.query('UPDATE kinds SET invented_by = NULL WHERE id = $1', [kindIds['single-proof']]),
        refusedBy('kinds_invented_by_fixed'),
      )
      // A kind with two events has no provable actor, so neither may be written.
      for (const residentId of [2, 5]) {
        await assert.rejects(
          db.query('UPDATE kinds SET invented_by = $2 WHERE id = $1', [kindIds['two-proofs'], residentId]),
          refusedBy('kinds_invented_by_fixed'),
        )
      }
      // A kind invented after the migration ran, by code that wrote no inventor.
      const gapKind = await insertKind(db, 'gap-kind', 5)
      await inventionEvent(db, 'second-maker', gapKind, new Date().toISOString())
      await assert.rejects(
        db.query('UPDATE kinds SET invented_by = 2 WHERE id = $1', [gapKind]),
        refusedBy('kinds_invented_by_fixed'),
      )
      await db.query('UPDATE kinds SET invented_by = 5 WHERE id = $1', [gapKind])
      await assert.rejects(
        db.query('UPDATE kinds SET invented_by = 2 WHERE id = $1', [gapKind]),
        refusedBy('kinds_invented_by_fixed'),
      )
      // The post-deploy rerun fills the gap kind's inventor the same way.
      const rerunKind = await insertKind(db, 'rerun-kind', 2)
      await inventionEvent(db, 'kind-maker', rerunKind, new Date().toISOString())
      await db.query(migrationDdl)
      const after = await inventors(db)
      assert.equal(after['rerun-kind'], 2)
      assert.equal(after['gap-kind'], 5)
      assert.equal(after['two-proofs'], null)
      // Other columns of a kind still change freely.
      await db.query('UPDATE kinds SET owner_id = 3 WHERE id = $1', [kindIds['single-proof']])
    })

    await t.test('the stored shapes refuse partial or out-of-range ends', async () => {
      const thingId = Number((await db.query('SELECT min(id) AS id FROM things')).rows[0]!.id)
      await assert.rejects(
        db.query(`UPDATE things SET ending_rule = '{"any": [{"uses": 3}]}' WHERE id = $1`, [thingId]),
        refusedBy('things_ending_rule_shape'),
      )
      await assert.rejects(db.query(`
        UPDATE things SET ending_rule = '{"any": []}', ending_grant = '{"kindless": true}',
          ending_set_by = 2, ending_set_at = now() WHERE id = $1
      `, [thingId]), refusedBy('things_ending_rule_shape'))
      await assert.rejects(
        db.query('UPDATE things SET ending_uses_left = 0 WHERE id = $1', [thingId]),
        refusedBy('things_ending_uses_range'),
      )
      await assert.rejects(
        db.query('UPDATE things SET ending_uses_left = 10001 WHERE id = $1', [thingId]),
        refusedBy('things_ending_uses_range'),
      )
      await assert.rejects(
        db.query('UPDATE things SET ending_idle_seconds = 59, ending_idle_anchor = now() WHERE id = $1', [thingId]),
        refusedBy('things_ending_idle_range'),
      )
      await assert.rejects(
        db.query(`UPDATE things SET ended_at = now() WHERE id = $1`, [thingId]),
        refusedBy('things_ended_consistent'),
      )
      await assert.rejects(
        db.query(`UPDATE things SET end_program_state = 'pending' WHERE id = $1`, [thingId]),
        refusedBy('things_end_program_state_known'),
      )
      // The copy origin stays outside the rule shape, so a copy keeps it after a clear.
      await db.query('UPDATE things SET ending_copied_from = $1, ending_copied_at = now() WHERE id = $1', [thingId])

      const policies: readonly (readonly [string, boolean])[] = [
        ['{"allowed": []}', true],
        ['{"allowed": ["at", "uses"], "max_seconds": 86400, "max_uses": 10}', true],
        ['{"allowed": ["label_added"], "labels": ["worn", "lit"]}', true],
        ['{"allowed": ["at", "at"]}', false],
        ['{"allowed": ["forever"]}', false],
        ['{"allowed": ["label_added"]}', false],
        ['{"allowed": ["uses"], "labels": ["worn"]}', false],
        ['{"allowed": ["label_added"], "labels": ["Not A Name"]}', false],
        ['{"allowed": ["label_added"], "labels": ["a", "b", "c", "d", "e", "f", "g", "h", "i"]}', false],
        ['{"allowed": ["at"], "max_seconds": 31622401}', false],
        ['{"allowed": ["at"], "max_seconds": 59}', false],
        ['{"allowed": ["at"], "max_seconds": "abc"}', false],
        ['{"allowed": ["uses"], "max_uses": 1.5}', false],
        ['{"allowed": ["uses"], "pause": true}', false],
        ['{"allowed": "uses"}', false],
        ['[]', false],
      ]
      for (const [policy, valid] of policies) {
        assert.deepEqual((await db.query('SELECT valid_ending_policy($1::jsonb) AS valid', [policy])).rows,
          [{ valid }], policy)
        assert.deepEqual((await db.query(`SELECT valid_ending_policy('${policy}'::jsonb) AS valid`)).rows,
          [{ valid }], `constant ${policy}`)
      }
      // Revisions stay append-only with the new column.
      await assert.rejects(db.query(`UPDATE kind_revisions SET ending_policy = '{"allowed": ["at"]}'`), /append-only/u)

      const changeId = Number((await db.query(`
        INSERT INTO thing_ending_changes (thing_id, change, actor_id, rule, "grant")
        VALUES ($1, 'set', 2, '{"any": [{"uses": 3}]}', '{"kindless": true}') RETURNING id
      `, [thingId])).rows[0]!.id)
      await assert.rejects(db.query(`UPDATE thing_ending_changes SET change = 'clear' WHERE id = $1`, [changeId]), /append-only/u)
      await assert.rejects(db.query('DELETE FROM thing_ending_changes WHERE id = $1', [changeId]), /append-only/u)
      await assert.rejects(db.query(`INSERT INTO thing_ending_changes (thing_id, change) VALUES ($1, 'pause')`, [thingId]),
        refusedBy('thing_ending_changes_change_known'))
      const agreementId = Number((await db.query(
        `INSERT INTO agreements (created_by_id, body) VALUES (2, 'a deal about a stone') RETURNING id`,
      )).rows[0]!.id)
      await db.query('INSERT INTO agreement_thing_links (agreement_id, position, thing_id) VALUES ($1, 0, $2)', [agreementId, thingId])
      await assert.rejects(
        db.query('INSERT INTO agreement_thing_links (agreement_id, position, thing_id) VALUES ($1, 1, $2)', [agreementId, thingId]),
        refusedBy('agreement_thing_links_one_per_thing'),
      )
      await assert.rejects(
        db.query('INSERT INTO agreement_thing_links (agreement_id, position, thing_id) VALUES ($1, 16, $2)', [agreementId, thingId]),
        /check constraint/u,
      )
      await assert.rejects(db.query('DELETE FROM agreement_thing_links'), /append-only/u)
    })

    await t.test('an end falls due at the soonest of its conditions', async () => {
      const roomId = Number((await db.query(`SELECT id FROM places WHERE name = 'Ending Room'`)).rows[0]!.id)
      const newThing = async (): Promise<number> => Number((await db.query(`
        INSERT INTO things (place_id, name, body, owner_id) VALUES ($1, 'ending thing', '', 2) RETURNING id
      `, [roomId])).rows[0]!.id)
      const setEnd = async (thingId: number, columns: string, values: readonly unknown[] = []): Promise<void> => {
        await db.query(`
          UPDATE things SET ending_rule = '{"any": [{"uses": 1}]}', ending_grant = '{"kindless": true}',
            ending_set_by = 2, ${columns} WHERE id = $1
        `, [thingId, ...values])
      }
      const dueAt = async (thingId: number): Promise<string | null> => {
        const value = (await db.query<{ due: Date | null }>('SELECT thing_end_due_at($1) AS due', [thingId])).rows[0]!.due
        return value === null ? null : value.toISOString()
      }
      const dueNow = async (thingId: number): Promise<boolean> => Boolean((await db.query(
        'SELECT thing_end_due($1, transaction_timestamp()) AS due', [thingId],
      )).rows[0]!.due)
      const dueBy = async (thingId: number, at: string): Promise<boolean> => Boolean((await db.query(
        'SELECT thing_end_due($1, $2::timestamptz) AS due', [thingId, at],
      )).rows[0]!.due)

      const unset = await newThing()
      assert.equal(await dueAt(unset), null)
      assert.equal(await dueNow(unset), false, 'no end is never due, and never null')
      assert.deepEqual((await db.query('SELECT thing_end_due(-1, now()) AS due')).rows, [{ due: false }])

      const dated = await newThing()
      await setEnd(dated, `ending_set_at = '2026-11-01T00:00:00Z', ending_deadline = '2030-01-01T00:00:00Z'`)
      assert.equal(await dueAt(dated), '2030-01-01T00:00:00.000Z')
      assert.equal(await dueNow(dated), false)
      assert.equal(await dueBy(dated, '2029-12-31T23:59:59Z'), false)
      assert.equal(await dueBy(dated, '2030-01-01T00:00:00Z'), true)

      const afterSetting = await newThing()
      await setEnd(afterSetting, `ending_set_at = now() - interval '10 minutes', ending_deadline = now() - interval '5 minutes'`)
      assert.equal(await dueNow(afterSetting), true)

      const idle = await newThing()
      await setEnd(idle, `ending_set_at = '2026-11-01T00:00:00Z', ending_idle_seconds = 3600, ending_idle_anchor = '2026-11-01T00:00:00Z'`)
      assert.equal(await dueAt(idle), '2026-11-01T01:00:00.000Z')
      assert.equal(await dueNow(idle), true)
      await db.query(`UPDATE things SET ending_idle_anchor = '2031-01-01T00:00:00Z' WHERE id = $1`, [idle])
      assert.equal(await dueAt(idle), '2031-01-01T01:00:00.000Z', 'a use moves the unused deadline')
      assert.equal(await dueNow(idle), false)

      const spent = await newThing()
      await setEnd(spent, `ending_set_at = '2026-11-01T00:00:00Z', ending_uses_left = 3`)
      assert.equal(await dueAt(spent), null)
      await db.query(`UPDATE things SET ending_uses_left = 0, ending_uses_spent_at = '2026-11-02T00:00:00Z' WHERE id = $1`, [spent])
      assert.equal(await dueAt(spent), '2026-11-02T00:00:00.000Z')
      assert.equal(await dueNow(spent), true)

      const labelled = await newThing()
      await setEnd(labelled, `ending_set_at = '2026-11-01T00:00:00Z', ending_label = 'lit'`)
      await db.query(`
        INSERT INTO active_labels (target_type, target_id, label, actor_id, created_at)
        VALUES ('thing', $1, 'lit', 2, '2026-10-31T00:00:00Z'), ('thing', $1, 'other', 2, '2026-11-01T06:00:00Z')
      `, [labelled])
      assert.equal(await dueAt(labelled), null, 'a label before the end was set, or another label, does not count')
      await db.query(`
        INSERT INTO active_labels (target_type, target_id, label, actor_id, created_at, expires_at)
        VALUES ('thing', $1, 'lit', 2, '2026-11-01T12:00:00Z', '2026-11-01T12:05:00Z')
      `, [labelled])
      assert.equal(await dueAt(labelled), '2026-11-01T12:00:00.000Z', 'an expired label still counts')
      assert.equal(await dueNow(labelled), true)
      await db.query(`
        INSERT INTO active_labels (target_type, target_id, label, actor_id, created_at)
        VALUES ('thing', $1, 'lit', 2, '2026-11-01T09:00:00Z')
      `, [labelled])
      assert.equal(await dueAt(labelled), '2026-11-01T09:00:00.000Z', 'the first counted label sets the time')
      await db.query(`INSERT INTO active_labels (target_type, target_id, label, actor_id) VALUES ('place', $1, 'lit', 2)`, [labelled])
      assert.equal(await dueAt(labelled), '2026-11-01T09:00:00.000Z', 'a label on something else never counts')

      // A label written in the same transaction makes the end due at once.
      const sameTransaction = await newThing()
      await setEnd(sameTransaction, `ending_set_at = now() - interval '1 minute', ending_label = 'lit'`)
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        assert.deepEqual((await client.query('SELECT thing_end_due($1, transaction_timestamp()) AS due', [sameTransaction])).rows, [{ due: false }])
        await client.query(`INSERT INTO active_labels (target_type, target_id, label, actor_id) VALUES ('thing', $1, 'lit', 2)`, [sameTransaction])
        assert.deepEqual((await client.query(`
          SELECT thing_end_due($1, transaction_timestamp()) AS due, thing_end_due_at($1) = transaction_timestamp() AS now_exactly
        `, [sameTransaction])).rows, [{ due: true, now_exactly: true }])
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }
      assert.equal(await dueNow(sameTransaction), false)

      const several = await newThing()
      await setEnd(several, `ending_set_at = '2026-11-01T00:00:00Z', ending_deadline = '2026-12-01T00:00:00Z',
        ending_idle_seconds = 86400, ending_idle_anchor = '2026-11-10T00:00:00Z', ending_uses_left = 1,
        ending_label = 'lit'`)
      await db.query(`
        INSERT INTO active_labels (target_type, target_id, label, actor_id, created_at)
        VALUES ('thing', $1, 'lit', 2, '2026-11-20T00:00:00Z')
      `, [several])
      assert.equal(await dueAt(several), '2026-11-11T00:00:00.000Z', 'the least of a date, an unused deadline and a label')
      await db.query(`UPDATE things SET ending_uses_left = 0, ending_uses_spent_at = '2026-11-05T00:00:00Z' WHERE id = $1`, [several])
      assert.equal(await dueAt(several), '2026-11-05T00:00:00.000Z', 'spent uses come first')
    })

    await t.test('a fresh city from db/schema.sql has the same shape, and the migration still repeats on it', async () => {
      await resetTo(db, schemaDdl)
      await assertEveryNamePresent(db)
      await seedCity(db)
      await db.query(migrationDdl)
      await assertEveryNamePresent(db)
      assert.equal((await inventors(db))['single-proof'], 2)
    })
  } finally {
    await postgres.stop()
  }
})
