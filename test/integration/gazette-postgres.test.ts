import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool, type PoolClient } from 'pg'

import {
  setEngineTransactionRunnerForTests,
  type TaggedSql,
} from '../../src/engine.ts'
import { runTalkNoteAction } from '../../src/note-action.ts'
import { MODERATED_TEXT } from '../../src/moderation.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'gazette_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const gazetteSchemaMarker = '-- The Gazette is a deterministic weekly ledger'
const gazetteSchemaOffset = schemaDdl.indexOf(gazetteSchemaMarker)
const postGazetteSchemaMarker = 'CREATE OR REPLACE FUNCTION complete_city_credit_purchase('
const postGazetteSchemaOffset = schemaDdl.indexOf(postGazetteSchemaMarker)
assert.ok(gazetteSchemaOffset > 0, 'schema must keep the stable Gazette section marker')
assert.ok(
  postGazetteSchemaOffset > gazetteSchemaOffset,
  'schema must keep the stable post-Gazette section marker',
)
const preGazetteSchemaDdl = schemaDdl.slice(0, gazetteSchemaOffset)
  + schemaDdl.slice(postGazetteSchemaOffset)
assert.doesNotMatch(preGazetteSchemaDdl, /gazette_/iu)
const migrationDdl = await readFile(
  new URL('../../db/migrations/20260827_gazette.sql', import.meta.url),
  'utf8',
)
const activationDdl = await readFile(
  new URL('../../db/migrations/20260827_gazette_room_activation.sql', import.meta.url),
  'utf8',
)

type GazetteRuntime = Readonly<{
  gazetteCycleFor: (value: string | Date) => Readonly<{
    startsAt: string
    endsAt: string
  }>
  printGazetteIssuesDue?: (
    database: TaggedSql,
    through: string | Date,
  ) => Promise<unknown>
}>

type GazetteStoreRuntime = Readonly<{
  readGazetteSubmissionRoomState?: (
    database: Readonly<{ query(text: string, params?: readonly unknown[]): Promise<unknown> }>,
  ) => Promise<Readonly<{ submissionsOpen: boolean }>>
  listGazetteIssues?: (
    database: Readonly<{ query(text: string, params?: readonly unknown[]): Promise<unknown> }>,
    input: Readonly<{ beforeIssueNumber: number | null; limit: number }>,
  ) => Promise<Readonly<{
    issues: readonly Record<string, unknown>[]
    hasMore: boolean
    nextBeforeIssueNumber: number | null
  }>>
  readGazetteIssue?: (
    database: Readonly<{ query(text: string, params?: readonly unknown[]): Promise<unknown> }>,
    input: Readonly<{ issueNumber: number; afterOrdinal: number | null; limit: number }>,
  ) => Promise<Readonly<{
    issue: Record<string, unknown>
    entries: readonly Record<string, unknown>[]
    hasMore: boolean
    nextAfterOrdinal: number | null
  }> | null>
  readCompleteGazetteIssue?: (
    database: Readonly<{ query(text: string, params?: readonly unknown[]): Promise<unknown> }>,
    issueNumber: number,
  ) => Promise<Readonly<{
    issue: Record<string, unknown>
    entries: readonly Record<string, unknown>[]
  }> | null>
  readGazetteIssueFacts?: (
    database: Readonly<{ query(text: string, params?: readonly unknown[]): Promise<unknown> }>,
    issueNumber: number,
  ) => Promise<Readonly<{
    issue_number: number
    scheduled_for: string
    printed_at: string
    entry_count: number
    resident_count: number
  }> | null>
}>

const gazetteRuntime = await import('../../src/gazette.ts') as GazetteRuntime
const gazetteStoreRuntime = await import(
  new URL('../../src/gazette-store.ts', import.meta.url).href
).catch(() => ({})) as GazetteStoreRuntime

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<Readonly<{
  database: Pool
  containerName: string
}>> {
  const containerName = `1f3d9-gazette-test-${process.pid}-${randomBytes(4).toString('hex')}`
  const password = randomBytes(24).toString('hex')
  runDocker([
    'run', '--detach', '--rm', '--name', containerName,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', `POSTGRES_DB=${POSTGRES_DATABASE}`,
    POSTGRES_IMAGE,
  ])

  try {
    const portOutput = runDocker(['port', containerName, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/)?.[1])
    assert.ok(Number.isInteger(port) && port > 0, `could not read PostgreSQL port from ${portOutput}`)
    const database = new Pool({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password,
      database: POSTGRES_DATABASE,
      ssl: false,
      max: 8,
    })
    const deadline = Date.now() + 30_000
    let lastError: unknown = null
    while (Date.now() < deadline) {
      try {
        await database.query('SELECT 1')
        return { database, containerName }
      } catch (error) {
        lastError = error
        await delay(200)
      }
    }
    await database.end().catch(() => undefined)
    throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
  } catch (error) {
    spawnSync('docker', ['stop', '--time', '0', containerName], {
      encoding: 'utf8',
      windowsHide: true,
    })
    throw error
  }
}

function taggedFor(queryable: Pool | PoolClient): TaggedSql {
  const tagged = (async (
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<Record<string, unknown>[]> => {
    const text = strings.reduce(
      (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ''),
      '',
    )
    return (await queryable.query(text, [...values])).rows as Record<string, unknown>[]
  }) as TaggedSql
  tagged.query = async (text: string, values: readonly unknown[] = []) => (
    await queryable.query(text, [...values])
  ).rows
  return tagged
}

function iso(value: unknown): string {
  assert.ok(value instanceof Date, 'PostgreSQL must return a timestamp')
  return value.toISOString()
}

async function assertGazetteRoomWriteRejected(
  database: Pool,
  text: string,
  values: readonly unknown[] = [],
): Promise<void> {
  await assert.rejects(
    database.query(text, [...values]),
    (error: unknown) => {
      assert.equal(
        (error as { constraint?: string }).constraint,
        'gazette_submission_room_lifecycle',
      )
      return true
    },
  )
}

async function assertGazetteDependencyWriteRejected(
  database: Pool,
  text: string,
  constraint: 'gazette_submission_room_laws'
    | 'gazette_submission_room_children'
    | 'gazette_submission_room_things',
): Promise<void> {
  await assert.rejects(
    database.query(text),
    (error: unknown) => {
      assert.equal((error as { constraint?: string }).constraint, constraint)
      return true
    },
  )
}

test('dormant Gazette migration installs over the exact closed pre-Gazette shell and reruns', async t => {
  const { database, containerName } = await startPostgres()
  t.after(async () => {
    await database.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', containerName], {
      encoding: 'utf8',
      windowsHide: true,
    })
  })

  await database.query(preGazetteSchemaDdl)
  await database.query(`
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

  const roomStateQuery = `
    SELECT gazette_submission_room_state(place) AS state,
      gazette_submission_room_is_open() AS submissions_open
    FROM places place
    WHERE place.id = 454
  `
  await database.query(migrationDdl)
  const installedRoomState = (await database.query(roomStateQuery)).rows[0]
  assert.deepEqual(installedRoomState, { state: 'closed', submissions_open: false })

  await database.query(migrationDdl)
  assert.deepEqual((await database.query(roomStateQuery)).rows[0], installedRoomState)
  assert.deepEqual((await database.query(`
    SELECT trigger.tgname AS trigger_name
    FROM pg_trigger trigger
    WHERE trigger.tgrelid = 'notes'::regclass
      AND trigger.tgname = 'gazette_note_submission_limit'
      AND trigger.tgenabled IN ('O', 'A')
      AND NOT trigger.tgisinternal
  `)).rows, [{ trigger_name: 'gazette_note_submission_limit' }])
})

test('Gazette prints and weekly submissions hold under real PostgreSQL', async t => {
  const postgres = await startPostgres()
  const { database, containerName } = postgres
  t.after(async () => {
    setEngineTransactionRunnerForTests(null)
    await database.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', containerName], {
      encoding: 'utf8',
      windowsHide: true,
    })
  })

  await database.query(schemaDdl)
  await database.query(`
    INSERT INTO residents (id, handle, model, secret_hash)
    VALUES
      (1, 'gazette-alpha', 'integration-test', repeat('1', 64)),
      (2, 'gazette-beta', 'integration-test', repeat('2', 64)),
      (3, 'gazette-capped', 'integration-test', repeat('3', 64)),
      (5, 'gazette-neighbor', 'integration-test', repeat('5', 64)),
      (6, 'gazette-racer', 'integration-test', repeat('6', 64)),
      (8, 'gazette-cutoff', 'integration-test', repeat('8', 64)),
      (9, 'gazette-precutoff', 'integration-test', repeat('9', 64)),
      (10, 'gazette-clock', 'integration-test', repeat('a', 64)),
      (11, 'gazette-boundary', 'integration-test', repeat('b', 64));

    INSERT INTO places (
      id, parent_id, place_kind, name, description, owner_id,
      open_to_building, open_to_things, open_to_notes
    )
    SELECT
      2, world.id, 'continent', 'gazette test continent',
      'Integration-only parent for the Gazette room.', 1,
      FALSE, FALSE, FALSE
    FROM places world
    WHERE world.place_kind = 'world'
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO places (
      id, parent_id, place_kind, name, description, purpose, owner_id,
      open_to_building, open_to_things, open_to_notes
    )
    SELECT
      454, parent.id, 'place', 'the gazette submission room',
      'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
      '', 1, FALSE, FALSE, FALSE
    FROM places parent
    WHERE parent.id = 2
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
    VALUES
      (1, 454, 454),
      (2, 454, 454),
      (3, 454, 454),
      (5, 454, 454),
      (6, 454, 454),
      (8, 454, 454),
      (9, 454, 454),
      (10, 454, 454),
      (11, 454, 454)
    ON CONFLICT (resident_id) DO UPDATE SET current_place_id = 454;
  `)

  const sql = taggedFor(database)
  setEngineTransactionRunnerForTests(async (_ignored, work) => {
    const client = await database.connect()
    try {
      await client.query('BEGIN')
      const result = await work(taggedFor(client), true)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  })

  await database.query(activationDdl)

  await t.test('the database rejects every law, child-place, and thing ingress path', async () => {
    await database.query(`
      WITH marker AS (
        INSERT INTO traits (name, description, coiner_id)
        VALUES ('gazette-guard-marker', 'Protected-room dependency guard fixture.', 1)
        RETURNING id
      )
      INSERT INTO place_law_changes (place_id, trait_id, actor_id, change_type, position)
      SELECT 2, id, 1, 'add', 0 FROM marker;

      INSERT INTO places (
        id, parent_id, place_kind, name, description, owner_id,
        open_to_building, open_to_things, open_to_notes
      ) VALUES (
        6000, 2, 'place', 'gazette guard child fixture', '', 1,
        FALSE, FALSE, FALSE
      );

      INSERT INTO things (place_id, name, body, owner_id, maker_id)
      VALUES (2, 'gazette guard thing fixture', '', 1, 1);
    `)

    await assertGazetteDependencyWriteRejected(database, `
      INSERT INTO place_law_changes (place_id, trait_id, actor_id, change_type, position)
      SELECT 454, id, 1, 'add', 0 FROM traits WHERE name = 'gazette-guard-marker'
    `, 'gazette_submission_room_laws')
    await assertGazetteDependencyWriteRejected(database, `
      UPDATE place_law_changes SET place_id = 454
      WHERE trait_id = (SELECT id FROM traits WHERE name = 'gazette-guard-marker')
    `, 'gazette_submission_room_laws')

    await assertGazetteDependencyWriteRejected(database, `
      INSERT INTO places (
        id, parent_id, place_kind, name, description, owner_id,
        open_to_building, open_to_things, open_to_notes
      ) VALUES (6001, 454, 'place', 'forbidden Gazette child', '', 1, FALSE, FALSE, FALSE)
    `, 'gazette_submission_room_children')
    await assertGazetteDependencyWriteRejected(database, `
      UPDATE places SET parent_id = 454 WHERE name = 'gazette guard child fixture'
    `, 'gazette_submission_room_children')

    await assertGazetteDependencyWriteRejected(database, `
      INSERT INTO things (place_id, name, body, owner_id, maker_id)
      VALUES (454, 'forbidden Gazette thing', '', 1, 1)
    `, 'gazette_submission_room_things')
    await assertGazetteDependencyWriteRejected(database, `
      UPDATE things SET place_id = 454 WHERE name = 'gazette guard thing fixture'
    `, 'gazette_submission_room_things')

    assert.deepEqual((await database.query(`
      SELECT
        (SELECT count(*)::integer FROM place_law_changes WHERE place_id = 454) AS laws,
        (SELECT count(*)::integer FROM places WHERE parent_id = 454) AS children,
        (SELECT count(*)::integer FROM things WHERE place_id = 454) AS things,
        gazette_submission_room_is_open() AS submissions_open
    `)).rows[0], { laws: 0, children: 0, things: 0, submissions_open: true })
  })

  await t.test('print cutoff, catch-up, verbatim order, membership, and replay are deterministic', async () => {
    let source: Array<{
      id: number
      body: string
      created_at: Date
      author_id: number
    }> = []
    await database.query('ALTER TABLE notes DISABLE TRIGGER gazette_note_submission_limit')
    try {
      source = (await database.query<{
        id: number
        body: string
        created_at: Date
        author_id: number
      }>(`
        INSERT INTO notes (place_id, author_id, body, created_at)
        VALUES
          (454, 1, E'Unicode 🏮\\nunchanged', TIMESTAMPTZ '2026-08-30 12:00:00+00'),
          (454, 2, E'  lead\\ntrail  ', TIMESTAMPTZ '2026-08-24 16:00:00+00'),
          (454, 2, 'same instant, later note ID', TIMESTAMPTZ '2026-08-30 12:00:00+00'),
          (454, 1, 'exactly on the next cycle boundary', TIMESTAMPTZ '2026-08-31 16:00:00+00'),
          (454, 2, 'exactly on the third cycle boundary', TIMESTAMPTZ '2026-09-07 16:00:00+00')
        RETURNING id, body, created_at, author_id
      `)).rows
    } finally {
      await database.query('ALTER TABLE notes ENABLE TRIGGER gazette_note_submission_limit')
    }

    assert.equal(
      typeof gazetteRuntime.printGazetteIssuesDue,
      'function',
      'implement printGazetteIssuesDue(database, through)',
    )
    const printGazetteIssuesDue = gazetteRuntime.printGazetteIssuesDue!

    await printGazetteIssuesDue(sql, '2026-08-31T15:59:59.999Z')
    assert.equal((await database.query('SELECT count(*)::integer AS count FROM gazette_issues')).rows[0].count, 0)

    await printGazetteIssuesDue(sql, '2026-08-31T16:00:00.000Z')
    const firstPrint = (await database.query(`
      SELECT issue.issue_number, issue.scheduled_for, issue.header, issue.entry_count,
        entry.ordinal, entry.note_id, note.body, resident.handle, note.created_at
      FROM gazette_issues issue
      LEFT JOIN gazette_issue_entries entry USING (issue_number)
      LEFT JOIN notes note ON note.id = entry.note_id
      LEFT JOIN residents resident ON resident.id = note.author_id
      ORDER BY issue.issue_number, entry.ordinal
    `)).rows.map(row => ({
      ...row,
      scheduled_for: iso(row.scheduled_for),
      created_at: iso(row.created_at),
    }))
    assert.deepEqual(firstPrint.map(row => ({
      issue_number: row.issue_number,
      entry_count: row.entry_count,
      ordinal: row.ordinal,
      note_id: row.note_id,
      body: row.body,
      handle: row.handle,
      created_at: row.created_at,
    })), [
      {
        issue_number: 1, entry_count: 3, ordinal: 1, note_id: source[1]!.id,
        body: '  lead\ntrail  ', handle: 'gazette-beta', created_at: '2026-08-24T16:00:00.000Z',
      },
      {
        issue_number: 1, entry_count: 3, ordinal: 2, note_id: source[0]!.id,
        body: 'Unicode 🏮\nunchanged', handle: 'gazette-alpha', created_at: '2026-08-30T12:00:00.000Z',
      },
      {
        issue_number: 1, entry_count: 3, ordinal: 3, note_id: source[2]!.id,
        body: 'same instant, later note ID', handle: 'gazette-beta', created_at: '2026-08-30T12:00:00.000Z',
      },
    ])
    assert.match(firstPrint[0]!.header as string, /permanently assigning its note ID/iu)
    assert.match(firstPrint[0]!.header as string, /never edited or deleted/iu)

    const immutableSnapshot = JSON.stringify(firstPrint)
    await printGazetteIssuesDue(sql, '2026-08-31T16:00:00.000Z')
    const replaySnapshot = JSON.stringify((await database.query(`
      SELECT issue.issue_number, issue.scheduled_for, issue.header, issue.entry_count,
        entry.ordinal, entry.note_id, note.body, resident.handle, note.created_at
      FROM gazette_issues issue
      LEFT JOIN gazette_issue_entries entry USING (issue_number)
      LEFT JOIN notes note ON note.id = entry.note_id
      LEFT JOIN residents resident ON resident.id = note.author_id
      ORDER BY issue.issue_number, entry.ordinal
    `)).rows.map(row => ({
      ...row,
      scheduled_for: iso(row.scheduled_for),
      created_at: iso(row.created_at),
    })))
    assert.equal(replaySnapshot, immutableSnapshot, 'replaying a print tick changes nothing')

    await printGazetteIssuesDue(sql, '2026-09-21T16:00:00.000Z')
    const archive = (await database.query(`
      SELECT issue.issue_number, issue.scheduled_for, issue.entry_count,
        coalesce(array_agg(entry.note_id ORDER BY entry.ordinal)
          FILTER (WHERE entry.note_id IS NOT NULL), '{}') AS note_ids
      FROM gazette_issues issue
      LEFT JOIN gazette_issue_entries entry USING (issue_number)
      GROUP BY issue.issue_number
      ORDER BY issue.issue_number
    `)).rows.map(row => ({
      ...row,
      scheduled_for: iso(row.scheduled_for),
    }))
    assert.deepEqual(archive, [
      { issue_number: 1, scheduled_for: '2026-08-31T16:00:00.000Z', entry_count: 3, note_ids: [source[1]!.id, source[0]!.id, source[2]!.id] },
      { issue_number: 2, scheduled_for: '2026-09-07T16:00:00.000Z', entry_count: 1, note_ids: [source[3]!.id] },
      { issue_number: 3, scheduled_for: '2026-09-14T16:00:00.000Z', entry_count: 1, note_ids: [source[4]!.id] },
      { issue_number: 4, scheduled_for: '2026-09-21T16:00:00.000Z', entry_count: 0, note_ids: [] },
    ])

    assert.equal(
      typeof gazetteStoreRuntime.listGazetteIssues,
      'function',
      'implement the permanent public Gazette issue list',
    )
    assert.equal(
      typeof gazetteStoreRuntime.readGazetteIssue,
      'function',
      'implement permanent public Gazette issue detail',
    )
    assert.equal(
      typeof gazetteStoreRuntime.readCompleteGazetteIssue,
      'function',
      'implement the complete standalone Gazette issue read',
    )
    assert.equal(
      typeof gazetteStoreRuntime.readGazetteIssueFacts,
      'function',
      'implement body-free Gazette issue facts',
    )
    const publicDatabase = Object.freeze({
      query: async (text: string, params: readonly unknown[] = []) => (
        await database.query(text, [...params])
      ).rows,
    })
    const publicList = await gazetteStoreRuntime.listGazetteIssues!(publicDatabase, {
      beforeIssueNumber: null,
      limit: 2,
    })
    assert.deepEqual(publicList, {
      issues: [
        {
          issue_number: 4,
          scheduled_for: '2026-09-21T16:00:00.000Z',
          printed_at: '2026-09-21T16:00:00.000Z',
          entry_count: 0,
        },
        {
          issue_number: 3,
          scheduled_for: '2026-09-14T16:00:00.000Z',
          printed_at: '2026-09-14T16:00:00.000Z',
          entry_count: 1,
        },
      ],
      hasMore: true,
      nextBeforeIssueNumber: 3,
    })
    const publicDetail = await gazetteStoreRuntime.readGazetteIssue!(publicDatabase, {
      issueNumber: 1,
      afterOrdinal: null,
      limit: 2,
    })
    assert.deepEqual(publicDetail, {
      issue: {
        issue_number: 1,
        scheduled_for: '2026-08-31T16:00:00.000Z',
        printed_at: '2026-08-31T16:00:00.000Z',
        header: gazetteRuntime.printGazetteIssuesDue
          ? (firstPrint[0]!.header as string)
          : '',
        entry_count: 3,
      },
      entries: [
        {
          ordinal: 1,
          note_id: source[1]!.id,
          author: 'gazette-beta',
          body: '  lead\ntrail  ',
          created_at: '2026-08-24T16:00:00.000Z',
        },
        {
          ordinal: 2,
          note_id: source[0]!.id,
          author: 'gazette-alpha',
          body: 'Unicode 🏮\nunchanged',
          created_at: '2026-08-30T12:00:00.000Z',
        },
      ],
      hasMore: true,
      nextAfterOrdinal: 2,
    })
    const completeIssue = await gazetteStoreRuntime.readCompleteGazetteIssue!(publicDatabase, 1)
    assert.deepEqual(
      completeIssue?.entries.map(entry => ({
        ordinal: entry.ordinal,
        note_id: entry.note_id,
        author: entry.author,
        body: entry.body,
      })),
      [
        { ordinal: 1, note_id: source[1]!.id, author: 'gazette-beta', body: '  lead\ntrail  ' },
        { ordinal: 2, note_id: source[0]!.id, author: 'gazette-alpha', body: 'Unicode 🏮\nunchanged' },
        { ordinal: 3, note_id: source[2]!.id, author: 'gazette-beta', body: 'same instant, later note ID' },
      ],
      'the standalone reader must collect every entry without changing stored ordinal order',
    )
    assert.deepEqual(await gazetteStoreRuntime.readGazetteIssueFacts!(publicDatabase, 1), {
      issue_number: 1,
      scheduled_for: '2026-08-31T16:00:00.000Z',
      printed_at: '2026-08-31T16:00:00.000Z',
      entry_count: 3,
      resident_count: 2,
    })

    const unchanged = (await database.query(`
      SELECT id, body, created_at, author_id FROM notes
      WHERE id = ANY($1::integer[]) ORDER BY id
    `, [source.map(note => note.id)])).rows
    assert.deepEqual(
      unchanged.map(row => ({ ...row, created_at: iso(row.created_at) })),
      [...source]
        .sort((left, right) => left.id - right.id)
        .map(row => ({ ...row, created_at: row.created_at.toISOString() })),
      'printing must not edit or delete source notes',
    )
    await assert.rejects(
      database.query('UPDATE gazette_issue_entries SET ordinal = ordinal WHERE note_id = $1', [source[0]!.id]),
      (error: unknown) => (error as { code?: string }).code === '55000',
    )
    await assert.rejects(
      database.query('DELETE FROM gazette_issue_entries WHERE note_id = $1', [source[0]!.id]),
      (error: unknown) => (error as { code?: string }).code === '55000',
    )
    await assert.rejects(
      database.query('UPDATE gazette_issues SET header = header WHERE issue_number = 1'),
      (error: unknown) => (error as { code?: string }).code === '55000',
    )
    await assert.rejects(
      database.query('DELETE FROM gazette_issues WHERE issue_number = 1'),
      (error: unknown) => (error as { code?: string }).code === '55000',
    )

    let laterEligibleNoteId = 0
    await database.query('ALTER TABLE notes DISABLE TRIGGER gazette_note_submission_limit')
    try {
      laterEligibleNoteId = (await database.query<{ id: number }>(`
        INSERT INTO notes (place_id, author_id, body, created_at)
        VALUES (454, 5, 'late membership attack', TIMESTAMPTZ '2026-08-29 12:00:00+00')
        RETURNING id
      `)).rows[0]!.id
    } finally {
      await database.query('ALTER TABLE notes ENABLE TRIGGER gazette_note_submission_limit')
    }
    const membershipBefore = (await database.query(`
      SELECT count(*)::integer AS count
      FROM gazette_issue_entries
      WHERE issue_number = 1
    `)).rows[0].count
    await assert.rejects(
      database.query(`
        INSERT INTO gazette_issue_entries (issue_number, ordinal, note_id)
        VALUES (1, 4, $1)
      `, [laterEligibleNoteId]),
      (error: unknown) => {
        assert.equal(
          (error as { constraint?: string }).constraint,
          'gazette_issue_membership_complete',
        )
        return true
      },
    )
    assert.equal((await database.query(`
      SELECT count(*)::integer AS count
      FROM gazette_issue_entries
      WHERE issue_number = 1
    `)).rows[0].count, membershipBefore, 'a failed late insert must leave the issue unchanged')

    await database.query(`
      INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
      VALUES ('note', $1, 'remove', 1, 'Gazette moderation fixture')
    `, [source[1]!.id])
    const moderated = await gazetteStoreRuntime.readGazetteIssue!(publicDatabase, {
      issueNumber: 1,
      afterOrdinal: null,
      limit: 10,
    })
    assert.equal(moderated?.entries[0]?.note_id, source[1]!.id)
    assert.equal(moderated?.entries[0]?.body, MODERATED_TEXT)
    await database.query(`
      INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
      VALUES ('note', $1, 'restore', 1, 'Gazette moderation fixture restored')
    `, [source[1]!.id])
    const restored = await gazetteStoreRuntime.readGazetteIssue!(publicDatabase, {
      issueNumber: 1,
      afterOrdinal: null,
      limit: 10,
    })
    assert.equal(restored?.entries[0]?.note_id, source[1]!.id)
    assert.equal(restored?.entries[0]?.body, '  lead\ntrail  ')
  })

  await t.test('three submissions are allowed per resident per print week and replay spends none', async () => {
    await database.query(`
      WITH new_trait AS (
        INSERT INTO traits (name, description, recipe, coiner_id)
        VALUES (
          'gazette-quota-marker',
          'Integration proof that capped Gazette submissions roll back talk-law effects.',
          '{"talk":[{"effect":"label","target":"actor","label":"gazette-quota-effect"}]}'::jsonb,
          1
        )
        RETURNING id
      )
      INSERT INTO place_law_changes (
        place_id, trait_id, actor_id, change_type, position
      )
      SELECT 2, id, 1, 'add', 0 FROM new_trait
    `)
    const cycle = gazetteRuntime.gazetteCycleFor(new Date())
    const priorCycleNoteAt = new Date(Date.parse(cycle.startsAt) - (3 * 24 * 60 * 60 * 1_000))
    await database.query('ALTER TABLE notes DISABLE TRIGGER gazette_note_submission_limit')
    try {
      await database.query(`
        INSERT INTO notes (place_id, author_id, body, created_at)
        VALUES
          (454, 3, 'last week one', $1),
          (454, 3, 'last week two', $1 + interval '1 second'),
          (454, 3, 'last week three', $1 + interval '2 seconds')
      `, [priorCycleNoteAt])
    } finally {
      await database.query('ALTER TABLE notes ENABLE TRIGGER gazette_note_submission_limit')
    }
    const submit = (residentId: number, residentHandle: string, text: string) => (
      runTalkNoteAction({ placeId: 454, residentId, residentHandle, text }, sql)
    )

    const first = await submit(3, 'gazette-capped', 'this week one')
    assert.equal(first.ok, true)
    if (!first.ok) return
    assert.equal(first.replayed, false)
    const replay = await submit(3, 'gazette-capped', 'this week one')
    assert.deepEqual(replay, { ok: true, note: first.note, replayed: true })
    assert.equal((await submit(3, 'gazette-capped', 'this week two')).ok, true)
    assert.equal((await submit(3, 'gazette-capped', 'this week three')).ok, true)

    const capped = await submit(3, 'gazette-capped', 'this week four')
    assert.equal(capped.ok, false)
    if (capped.ok) return
    assert.equal(capped.status, 429)
    assert.equal(
      capped.error,
      '3 Gazette submissions per resident are allowed from Monday 16:00 UTC inclusive ' +
        `to the next Monday 16:00 UTC exclusive; this Gazette week's 3 submissions are used; ` +
        `retry at ${cycle.endsAt}`,
    )

    assert.equal((await submit(5, 'gazette-neighbor', 'my independent first')).ok, true)
    const quota = (await database.query<{
      notes_today: number
      weekly: number
      law_effects: number
    }>(`
      SELECT resident.notes_today,
        (count(note.id) FILTER (
          WHERE note.place_id = 454
            AND note.created_at >= $1
            AND note.created_at < $2
        ))::integer AS weekly,
        (SELECT count(*)::integer
          FROM active_labels
          WHERE target_type = 'resident'
            AND target_id = resident.id
            AND label = 'gazette-quota-effect'
        ) AS law_effects
      FROM residents resident
      LEFT JOIN notes note ON note.author_id = resident.id
      WHERE resident.id = 3
      GROUP BY resident.id
    `, [cycle.startsAt, cycle.endsAt])).rows[0]!
    assert.deepEqual(quota, { notes_today: 3, weekly: 3, law_effects: 3 })

    const raced = await Promise.all([
      submit(6, 'gazette-racer', 'concurrent one'),
      submit(6, 'gazette-racer', 'concurrent two'),
      submit(6, 'gazette-racer', 'concurrent three'),
      submit(6, 'gazette-racer', 'concurrent four'),
    ])
    assert.equal(raced.filter(result => result.ok).length, 3)
    const refused = raced.filter(result => !result.ok)
    assert.equal(refused.length, 1)
    assert.deepEqual(refused[0], {
      ok: false,
      status: 429,
      error: '3 Gazette submissions per resident are allowed from Monday 16:00 UTC inclusive ' +
        `to the next Monday 16:00 UTC exclusive; this Gazette week's 3 submissions are used; ` +
        `retry at ${cycle.endsAt}`,
    })
    const racedQuota = (await database.query<{
      notes_today: number
      weekly: number
      law_effects: number
    }>(`
      SELECT resident.notes_today,
        count(note.id) FILTER (
          WHERE note.place_id = 454
            AND note.created_at >= $1
            AND note.created_at < $2
        )::integer AS weekly,
        (SELECT count(*)::integer
          FROM active_labels
          WHERE target_type = 'resident'
            AND target_id = resident.id
            AND label = 'gazette-quota-effect'
        ) AS law_effects
      FROM residents resident
      LEFT JOIN notes note ON note.author_id = resident.id
      WHERE resident.id = 6
      GROUP BY resident.id
    `, [cycle.startsAt, cycle.endsAt])).rows[0]!
    assert.deepEqual(racedQuota, { notes_today: 3, weekly: 3, law_effects: 3 })

    await database.query(`
      INSERT INTO place_law_changes (
        place_id, trait_id, actor_id, change_type, position
      )
      SELECT 2, id, 1, 'remove', NULL
      FROM traits
      WHERE name = 'gazette-quota-marker'
    `)
  })

  await t.test('the locked database clock accepts a cutoff-crossing statement and returns a future retry', async () => {
    const originalCycleFunction = (await database.query<{ definition: string }>(`
      SELECT pg_get_functiondef(
        'gazette_cycle_start(timestamp with time zone)'::regprocedure
      ) AS definition
    `)).rows[0]!.definition
    await database.query(`
      CREATE TABLE gazette_boundary_test_control (
        singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
        boundary_at TIMESTAMPTZ NOT NULL
      );
      INSERT INTO gazette_boundary_test_control (boundary_at)
      VALUES (clock_timestamp() + interval '1 hour');

      CREATE OR REPLACE FUNCTION gazette_cycle_start(value TIMESTAMPTZ)
      RETURNS TIMESTAMPTZ
      LANGUAGE sql
      STABLE
      PARALLEL SAFE
      AS $$
        SELECT date_bin(interval '7 days', value, boundary_at)
        FROM gazette_boundary_test_control
        WHERE singleton
      $$;

      CREATE OR REPLACE FUNCTION pause_gazette_boundary_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        boundary_at TIMESTAMPTZ;
      BEGIN
        IF NEW.author_id = 11 AND NEW.body = 'crosses the Gazette boundary' THEN
          SELECT control.boundary_at
          INTO boundary_at
          FROM gazette_boundary_test_control control
          WHERE control.singleton;
          PERFORM pg_sleep_until(boundary_at + interval '50 milliseconds');
        END IF;
        RETURN NEW;
      END
      $$;

      CREATE TRIGGER gazette_boundary_pause
      BEFORE INSERT ON notes
      FOR EACH ROW EXECUTE FUNCTION pause_gazette_boundary_insert();
    `)

    try {
      const boundaryAt = (await database.query<{ boundary_at: Date }>(`
        UPDATE gazette_boundary_test_control
        SET boundary_at = clock_timestamp() + interval '2 seconds'
        WHERE singleton
        RETURNING boundary_at
      `)).rows[0]!.boundary_at
      await database.query('ALTER TABLE notes DISABLE TRIGGER gazette_note_submission_limit')
      try {
        await database.query(`
          INSERT INTO notes (place_id, author_id, body, created_at)
          VALUES
            (454, 11, 'old-cycle one', $1::timestamptz - interval '1 day'),
            (454, 11, 'old-cycle two', $1::timestamptz - interval '2 days'),
            (454, 11, 'old-cycle three', $1::timestamptz - interval '3 days')
        `, [boundaryAt])
      } finally {
        await database.query('ALTER TABLE notes ENABLE TRIGGER gazette_note_submission_limit')
      }

      const statementStartedAt = (await database.query<{ current_time: Date }>(
        'SELECT clock_timestamp() AS current_time',
      )).rows[0]!.current_time
      assert.ok(statementStartedAt < boundaryAt, 'the request must begin in the capped old cycle')

      const crossing = await runTalkNoteAction({
        placeId: 454,
        residentId: 11,
        residentHandle: 'gazette-boundary',
        text: 'crosses the Gazette boundary',
      }, sql)
      assert.equal(crossing.ok, true)
      if (!crossing.ok) return
      const storedAt = Date.parse(iso(crossing.note.created_at))
      assert.ok(
        storedAt >= boundaryAt.getTime(),
        'the accepted note must use the post-lock database time in the new cycle',
      )

      for (const text of ['new-cycle two', 'new-cycle three']) {
        assert.equal((await runTalkNoteAction({
          placeId: 454,
          residentId: 11,
          residentHandle: 'gazette-boundary',
          text,
        }, sql)).ok, true)
      }
      const retryAt = new Date(boundaryAt.getTime() + (7 * 24 * 60 * 60 * 1_000)).toISOString()
      const refusalObservedAt = (await database.query<{ current_time: Date }>(
        'SELECT clock_timestamp() AS current_time',
      )).rows[0]!.current_time
      const refused = await runTalkNoteAction({
        placeId: 454,
        residentId: 11,
        residentHandle: 'gazette-boundary',
        text: 'new-cycle four',
      }, sql)
      assert.deepEqual(refused, {
        ok: false,
        status: 429,
        error: '3 Gazette submissions per resident are allowed from Monday 16:00 UTC inclusive ' +
          `to the next Monday 16:00 UTC exclusive; this Gazette week's 3 submissions are used; ` +
          `retry at ${retryAt}`,
      })
      assert.ok(refusalObservedAt.getTime() < Date.parse(retryAt), 'retry must still be in the future')
      assert.deepEqual((await database.query(`
        SELECT resident.notes_today,
          count(note.id) FILTER (
            WHERE note.created_at >= $1::timestamptz
              AND note.created_at < $1::timestamptz + interval '7 days'
          )::integer AS current_cycle
        FROM residents resident
        LEFT JOIN notes note ON note.author_id = resident.id AND note.place_id = 454
        WHERE resident.id = 11
        GROUP BY resident.id
      `, [boundaryAt])).rows[0], { notes_today: 3, current_cycle: 3 })
    } finally {
      await database.query('DROP TRIGGER IF EXISTS gazette_boundary_pause ON notes')
      await database.query('DROP FUNCTION IF EXISTS pause_gazette_boundary_insert()')
      await database.query(originalCycleFunction)
      await database.query('DROP TABLE IF EXISTS gazette_boundary_test_control')
    }
  })

  await t.test('the shared lock makes printer-first and submitter-first membership deterministic', async () => {
    const printGazetteIssuesDue = gazetteRuntime.printGazetteIssuesDue!
    setEngineTransactionRunnerForTests(null)

    const printInTransaction = async (through: string): Promise<void> => {
      const client = await database.connect()
      try {
        await client.query('BEGIN')
        await printGazetteIssuesDue(taggedFor(client), through)
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    }

    const printer = await database.connect()
    try {
      await printer.query('BEGIN')
      await printGazetteIssuesDue(taggedFor(printer), '2026-09-28T16:00:00.000Z')
      let printerSecondSettled = false
      const printerSecond = database.query<{ id: number; created_at: Date }>(`
        INSERT INTO notes (place_id, author_id, body)
        VALUES (454, 8, 'printer-first lock order')
        RETURNING id, created_at
      `).finally(() => { printerSecondSettled = true })
      await delay(100)
      assert.equal(printerSecondSettled, false, 'the note must wait for the printer lock')
      const printerReleaseFloor = (await printer.query<{ current_time: Date }>(
        'SELECT clock_timestamp() AS current_time',
      )).rows[0]!.current_time
      await printer.query('COMMIT')
      const printerSecondNote = (await printerSecond).rows[0]!
      assert.ok(
        printerSecondNote.created_at >= printerReleaseFloor,
        'a printer-first note receives its database time only after the printer releases the lock',
      )
      assert.equal((await database.query(`
        SELECT count(*)::integer AS count
        FROM gazette_issue_entries
        WHERE issue_number = 5 AND note_id = $1
      `, [printerSecondNote.id])).rows[0].count, 0)

      await printInTransaction('2026-10-05T16:00:00.000Z')
      assert.equal((await database.query(`
        SELECT count(*)::integer AS count
        FROM gazette_issue_entries
        WHERE issue_number = 6 AND note_id = $1
      `, [printerSecondNote.id])).rows[0].count, 1)
    } catch (error) {
      await printer.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      printer.release()
    }

    const submitter = await database.connect()
    try {
      await submitter.query('BEGIN')
      const submitterFirstNote = (await submitter.query<{ id: number; created_at: Date }>(`
        INSERT INTO notes (place_id, author_id, body)
        VALUES (454, 9, 'submitter-first lock order')
        RETURNING id, created_at
      `)).rows[0]!
      let printSettled = false
      const print = printInTransaction('2026-10-12T16:00:00.000Z')
        .finally(() => { printSettled = true })
      await delay(100)
      assert.equal(printSettled, false, 'the printer must wait for the submission lock')
      await submitter.query('COMMIT')
      await print
      assert.ok(
        submitterFirstNote.created_at < new Date('2026-10-12T16:00:00.000Z'),
        'a submitter-first note keeps the database time assigned while it held the lock',
      )
      assert.equal((await database.query(`
        SELECT count(*)::integer AS count
        FROM gazette_issue_entries
        WHERE issue_number = 7 AND note_id = $1
      `, [submitterFirstNote.id])).rows[0].count, 1)
    } catch (error) {
      await submitter.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      submitter.release()
    }
  })

  await t.test('the database clock defeats explicit past and future quota timestamps', async () => {
    const before = (await database.query<{ current_time: Date }>(
      'SELECT clock_timestamp() AS current_time',
    )).rows[0]!.current_time
    const suppliedTimes = [
      '1900-01-01T00:00:00.000Z',
      '2100-01-01T00:00:00.000Z',
      '1950-01-01T00:00:00.000Z',
    ]
    const storedIds: number[] = []
    for (const [index, suppliedTime] of suppliedTimes.entries()) {
      const stored = (await database.query<{ id: number }>(`
        INSERT INTO notes (place_id, author_id, body, created_at)
        VALUES (454, 10, $1, $2::timestamptz)
        RETURNING id
      `, [`clock-owned ${index + 1}`, suppliedTime])).rows[0]!
      storedIds.push(stored.id)
    }
    const after = (await database.query<{ current_time: Date }>(
      'SELECT clock_timestamp() AS current_time',
    )).rows[0]!.current_time
    const storedTimes = (await database.query<{ created_at: Date }>(`
      SELECT created_at
      FROM notes
      WHERE id = ANY($1::integer[])
      ORDER BY id
    `, [storedIds])).rows.map(row => row.created_at)
    assert.equal(storedTimes.length, 3)
    for (const [index, storedTime] of storedTimes.entries()) {
      assert.ok(storedTime >= before && storedTime <= after)
      assert.notEqual(storedTime.toISOString(), suppliedTimes[index])
    }

    await assert.rejects(
      database.query(`
        INSERT INTO notes (place_id, author_id, body, created_at)
        VALUES (454, 10, 'clock-owned fourth', TIMESTAMPTZ '2200-01-01 00:00:00+00')
      `),
      (error: unknown) => {
        assert.equal(
          (error as { constraint?: string }).constraint,
          'gazette_submission_weekly_limit',
        )
        return true
      },
    )
  })
})

test('Gazette schema stays dormant until the post-deploy room activation and both rerun cleanly', async t => {
  const { database, containerName } = await startPostgres()
  t.after(async () => {
    setEngineTransactionRunnerForTests(null)
    await database.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', containerName], {
      encoding: 'utf8',
      windowsHide: true,
    })
  })

  await database.query(schemaDdl)
  await database.query(`
    INSERT INTO residents (id, handle, model, secret_hash)
    VALUES
      (1, 'gazette-founder', 'integration-test', repeat('1', 64)),
      (2, 'gazette-neighbor', 'integration-test', repeat('2', 64));

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
  `)
  await assertGazetteRoomWriteRejected(database, `
    INSERT INTO places (
      id, parent_id, place_kind, name, description, owner_id,
      open_to_building, open_to_things, open_to_notes
    ) VALUES (
      454, 2, 'place', 'the gazette submission room',
      'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
      1, FALSE, FALSE, TRUE
    );
  `)
  await database.query(`
    INSERT INTO places (
      id, parent_id, place_kind, name, description, owner_id,
      open_to_building, open_to_things, open_to_notes
    ) VALUES (
      454, 2, 'place', 'the gazette submission room',
      'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
      1, FALSE, FALSE, FALSE
    );

    INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
    VALUES (1, 454, 454);
  `)

  const sql = taggedFor(database)
  const publicDatabase = Object.freeze({
    query: async (text: string, params: readonly unknown[] = []) => (
      await database.query(text, [...params])
    ).rows,
  })
  setEngineTransactionRunnerForTests(async (_ignored, work) => {
    const client = await database.connect()
    try {
      await client.query('BEGIN')
      const result = await work(taggedFor(client), true)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  })

  await database.query(
    'GRANT SELECT ON city_snapshot.public_records TO city_snapshot_export',
  )

  await t.test('dormant migration and activation refuse every pre-feature dependency', async () => {
    await database.query(`
      INSERT INTO traits (name, description, coiner_id)
      VALUES ('gazette-dormant-guard', 'Dormant dependency refusal fixture.', 1)
    `)
    const cases = [
      {
        table: 'place_law_changes',
        trigger: 'gazette_submission_room_reject_laws',
        constraint: 'gazette_submission_room_laws',
        insert: `INSERT INTO place_law_changes
          (place_id, trait_id, actor_id, change_type, position)
          SELECT 454, id, 1, 'add', 0 FROM traits WHERE name = 'gazette-dormant-guard'`,
        cleanup: `DELETE FROM place_law_changes
          WHERE trait_id = (SELECT id FROM traits WHERE name = 'gazette-dormant-guard')`,
        extraCleanupTrigger: 'place_law_changes_append_only',
      },
      {
        table: 'places',
        trigger: 'gazette_submission_room_reject_child_places',
        constraint: 'gazette_submission_room_children',
        insert: `INSERT INTO places
          (id, parent_id, place_kind, name, description, owner_id,
            open_to_building, open_to_things, open_to_notes)
          VALUES (6100, 454, 'place', 'dormant Gazette child', '', 1, FALSE, FALSE, FALSE)`,
        cleanup: 'UPDATE places SET parent_id = 2 WHERE id = 6100',
        extraCleanupTrigger: null,
      },
      {
        table: 'things',
        trigger: 'gazette_submission_room_reject_things',
        constraint: 'gazette_submission_room_things',
        insert: `INSERT INTO things (id, place_id, name, body, owner_id, maker_id)
          VALUES (6100, 454, 'dormant Gazette thing', '', 1, 1)`,
        cleanup: 'UPDATE things SET place_id = 2 WHERE id = 6100',
        extraCleanupTrigger: null,
      },
    ] as const

    for (const fixture of cases) {
      await database.query(
        `ALTER TABLE ${fixture.table} DISABLE TRIGGER ${fixture.trigger}`,
      )
      await database.query(fixture.insert)
      await database.query(
        `ALTER TABLE ${fixture.table} ENABLE TRIGGER ${fixture.trigger}`,
      )

      await assert.rejects(database.query(activationDdl), /cannot open while it has local laws, child places, or things/iu)
      await assert.rejects(
        database.query(migrationDdl),
        (error: unknown) => {
          assert.equal((error as { constraint?: string }).constraint, fixture.constraint)
          return true
        },
      )

      await database.query(
        `ALTER TABLE ${fixture.table} DISABLE TRIGGER ${fixture.trigger}`,
      )
      if (fixture.extraCleanupTrigger) {
        await database.query(
          `ALTER TABLE ${fixture.table} DISABLE TRIGGER ${fixture.extraCleanupTrigger}`,
        )
      }
      await database.query(fixture.cleanup)
      if (fixture.extraCleanupTrigger) {
        await database.query(
          `ALTER TABLE ${fixture.table} ENABLE TRIGGER ${fixture.extraCleanupTrigger}`,
        )
      }
      await database.query(
        `ALTER TABLE ${fixture.table} ENABLE TRIGGER ${fixture.trigger}`,
      )
    }
  })

  await database.query(migrationDdl)
  await database.query(`
    WITH new_trait AS (
      INSERT INTO traits (name, description, recipe, coiner_id)
      VALUES (
        'gazette-race-marker',
        'Integration proof that rejected Gazette submissions roll back talk-law effects.',
        '{"talk":[{"effect":"label","target":"actor","label":"gazette-race-leak"}]}'::jsonb,
        1
      )
      RETURNING id
    )
    INSERT INTO place_law_changes (
      place_id, trait_id, actor_id, change_type, position
    )
    SELECT 2, id, 1, 'add', 0 FROM new_trait
  `)
  assert.deepEqual((await database.query(`
    SELECT
      has_table_privilege(
        'city_snapshot_export', 'city_snapshot.public_records', 'SELECT'
      ) AS v1,
      has_table_privilege(
        'city_snapshot_export', 'city_snapshot.public_records_v2', 'SELECT'
      ) AS v2
  `)).rows[0], { v1: true, v2: true }, 'dormant rollout must keep old and new exporters readable')
  const readSubmissionRoomState = gazetteStoreRuntime.readGazetteSubmissionRoomState
  assert.equal(typeof readSubmissionRoomState, 'function')
  if (!readSubmissionRoomState) assert.fail('implement the public Gazette submission-room state')
  assert.deepEqual(
    await readSubmissionRoomState(publicDatabase),
    { submissionsOpen: false },
  )
  const stillClosed = (await database.query(`
    SELECT description, purpose, open_to_building, open_to_things, open_to_notes
    FROM places WHERE id = 454
  `)).rows[0]
  assert.deepEqual(stillClosed, {
    description: 'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
    purpose: '',
    open_to_building: false,
    open_to_things: false,
    open_to_notes: false,
  })
  assert.equal((await database.query(`
    SELECT count(*)::integer AS count
    FROM events
    WHERE kind = 'place_edited'
      AND detail @> '{"place_id":454,"gazette_submission_room_opened":true}'::jsonb
  `)).rows[0].count, 0, 'schema installation must not open submissions')

  await t.test('generic writes cannot edit, trade, transfer, delete, or prematurely open the closed shell', async () => {
    for (const statement of [
      "UPDATE places SET description = 'generic place edit' WHERE id = 454",
      "UPDATE places SET purpose = 'generic repurpose' WHERE id = 454",
      'UPDATE places SET open_to_notes = TRUE WHERE id = 454',
      'UPDATE places SET open_to_building = TRUE WHERE id = 454',
      'UPDATE places SET open_to_things = TRUE WHERE id = 454',
      "UPDATE places SET name = 'renamed submission room' WHERE id = 454",
      'UPDATE places SET parent_id = 1 WHERE id = 454',
      'UPDATE places SET owner_id = 2 WHERE id = 454',
      'UPDATE places SET active_offer_id = 900 WHERE id = 454',
      'UPDATE places SET front_matter_thing_ids = ARRAY[1]::integer[] WHERE id = 454',
      'DELETE FROM places WHERE id = 454',
    ]) await assertGazetteRoomWriteRejected(database, statement)

    await database.query('UPDATE places SET description = description WHERE id = 454')
    assert.deepEqual((await database.query(`
      SELECT gazette_submission_room_state(place) AS state,
        gazette_submission_room_is_open() AS submissions_open
      FROM places place WHERE id = 454
    `)).rows[0], { state: 'closed', submissions_open: false })
  })

  assert.equal(typeof gazetteRuntime.printGazetteIssuesDue, 'function')
  await assert.rejects(
    gazetteRuntime.printGazetteIssuesDue!(sql, '2026-08-31T16:00:00.000Z'),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 409)
      assert.match((error as Error).message, /room #454 is not in its verified open state/iu)
      return true
    },
  )
  assert.deepEqual((await database.query(`
    SELECT
      (SELECT count(*)::integer FROM gazette_issues) AS issues,
      (SELECT count(*)::integer FROM gazette_issue_entries) AS entries,
      (SELECT count(*)::integer FROM events WHERE kind = 'gazette_printed') AS print_events
  `)).rows[0], { issues: 0, entries: 0, print_events: 0 })

  await database.query('ALTER TABLE notes DISABLE TRIGGER gazette_note_submission_limit')
  let preFeatureNoteId = 0
  try {
    preFeatureNoteId = (await database.query<{ id: number }>(`
      INSERT INTO notes (place_id, author_id, body, created_at)
      VALUES (454, 1, 'note left before Gazette rules existed', TIMESTAMPTZ '2026-08-20 12:00:00+00')
      RETURNING id
    `)).rows[0]!.id
  } finally {
    await database.query('ALTER TABLE notes ENABLE TRIGGER gazette_note_submission_limit')
  }
  await assert.rejects(
    database.query(activationDdl),
    /contains notes from before the verified submission rules/iu,
  )
  assert.deepEqual((await database.query(`
    SELECT open_to_notes,
      (SELECT count(*)::integer FROM events
        WHERE kind = 'place_edited'
          AND detail @> '{"place_id":454,"gazette_submission_room_opened":true}'::jsonb
      ) AS opening_events
    FROM places WHERE id = 454
  `)).rows[0], { open_to_notes: false, opening_events: 0 })
  await database.query('ALTER TABLE notes DISABLE TRIGGER notes_append_only')
  try {
    await database.query('DELETE FROM notes WHERE id = $1', [preFeatureNoteId])
  } finally {
    await database.query('ALTER TABLE notes ENABLE TRIGGER notes_append_only')
  }

  await assert.rejects(
    database.query(`
      INSERT INTO notes (place_id, author_id, body)
      VALUES (454, 1, 'raw founder write before activation')
    `),
    (error: unknown) => {
      assert.equal(
        (error as { constraint?: string }).constraint,
        'gazette_submission_room_closed',
      )
      return true
    },
  )

  assert.deepEqual(
    await runTalkNoteAction({
      placeId: 454,
      residentId: 1,
      residentHandle: 'gazette-founder',
      text: 'The founder must also wait.',
    }, sql),
    {
      ok: false,
      status: 409,
      error: 'Gazette submission room #454 is not open; read GET /api/gazette and submit only when submission_room.submissions_open is true',
    },
  )
  assert.deepEqual((await database.query(`
    SELECT resident.notes_today,
      (SELECT count(*)::integer FROM notes WHERE place_id = 454) AS notes,
      (SELECT count(*)::integer
        FROM active_labels
        WHERE target_type = 'resident'
          AND target_id = resident.id
          AND label = 'gazette-race-leak'
      ) AS leaked_law_effects
    FROM residents resident
    WHERE resident.id = 1
  `)).rows[0], { notes_today: 0, notes: 0, leaked_law_effects: 0 })

  await Promise.all([
    database.query(activationDdl),
    database.query(activationDdl),
  ])
  assert.deepEqual((await database.query(`
    SELECT
      has_table_privilege(
        'city_snapshot_export', 'city_snapshot.public_records', 'SELECT'
      ) AS v1,
      has_table_privilege(
        'city_snapshot_export', 'city_snapshot.public_records_v2', 'SELECT'
      ) AS v2
  `)).rows[0], { v1: false, v2: true }, 'exact-commit activation completes the v2 cutover')
  const opened = (await database.query(`
    SELECT description, purpose, open_to_building, open_to_things, open_to_notes
    FROM places WHERE id = 454
  `)).rows[0]
  assert.deepEqual(opened, {
    description: 'Leave a note here for The Gazette. Every Monday at 16:00 UTC, the automatic printer permanently assigns every unprinted note made before the cutoff to the next issue, verbatim with its author, note ID, and time. Printing never deletes, edits, moves, or copies the source note.',
    purpose: 'Residents may submit up to three notes per Gazette week (Monday 16:00 UTC to Monday 16:00 UTC); each submission also uses the ordinary daily note quota.',
    open_to_building: false,
    open_to_things: false,
    open_to_notes: true,
  })
  assert.deepEqual(
    await readSubmissionRoomState(publicDatabase),
    { submissionsOpen: true },
  )
  assert.equal((await database.query(`
    SELECT count(*)::integer AS count
    FROM events
    WHERE kind = 'place_edited'
      AND detail @> '{"place_id":454,"gazette_submission_room_opened":true}'::jsonb
  `)).rows[0].count, 1)

  await t.test('replica-only critical triggers close the live gate and block activation', async () => {
    const criticalTriggers = [
      ['notes', 'gazette_note_submission_limit'],
      ['places', 'gazette_submission_room_lifecycle'],
      ['places', 'gazette_submission_room_reject_child_places'],
      ['place_law_changes', 'gazette_submission_room_reject_laws'],
      ['things', 'gazette_submission_room_reject_things'],
    ] as const

    for (const [table, trigger] of criticalTriggers) {
      await database.query(`ALTER TABLE ${table} ENABLE REPLICA TRIGGER ${trigger}`)
      try {
        assert.equal((await database.query(
          'SELECT gazette_submission_room_is_open() AS submissions_open',
        )).rows[0].submissions_open, false, trigger)
        await assert.rejects(
          database.query(activationDdl),
          /must be installed before room #454 can open/iu,
          trigger,
        )
      } finally {
        await database.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
      }
      assert.equal((await database.query(
        'SELECT gazette_submission_room_is_open() AS submissions_open',
      )).rows[0].submissions_open, true, `${trigger}: restored`)
    }
  })

  await t.test('generic writes cannot change the verified-open room and the public gate proves every field', async () => {
    for (const statement of [
      "UPDATE places SET description = 'generic place edit' WHERE id = 454",
      "UPDATE places SET purpose = 'generic repurpose' WHERE id = 454",
      'UPDATE places SET open_to_notes = FALSE WHERE id = 454',
      'UPDATE places SET open_to_building = TRUE WHERE id = 454',
      'UPDATE places SET open_to_things = TRUE WHERE id = 454',
      "UPDATE places SET name = 'renamed submission room' WHERE id = 454",
      'UPDATE places SET parent_id = 1 WHERE id = 454',
      'UPDATE places SET owner_id = 2 WHERE id = 454',
      'UPDATE places SET active_offer_id = 901 WHERE id = 454',
      'UPDATE places SET front_matter_thing_ids = ARRAY[1]::integer[] WHERE id = 454',
      'DELETE FROM places WHERE id = 454',
    ]) await assertGazetteRoomWriteRejected(database, statement)

    await database.query('UPDATE places SET purpose = purpose WHERE id = 454')
    assert.deepEqual((await database.query(`
      SELECT gazette_submission_room_state(place) AS state,
        gazette_submission_room_is_open() AS submissions_open
      FROM places place WHERE id = 454
    `)).rows[0], { state: 'open', submissions_open: true })

    await database.query('ALTER TABLE places DISABLE TRIGGER gazette_submission_room_lifecycle')
    try {
      await database.query("UPDATE places SET description = 'forced drift proof' WHERE id = 454")
      assert.equal((await database.query(
        'SELECT gazette_submission_room_is_open() AS submissions_open',
      )).rows[0].submissions_open, false)
      assert.deepEqual(
        await readSubmissionRoomState(publicDatabase),
        { submissionsOpen: false },
      )
      await database.query(`
        UPDATE places SET description =
          'Leave a note here for The Gazette. Every Monday at 16:00 UTC, the automatic printer permanently assigns every unprinted note made before the cutoff to the next issue, verbatim with its author, note ID, and time. Printing never deletes, edits, moves, or copies the source note.'
        WHERE id = 454
      `)
    } finally {
      await database.query('ALTER TABLE places ENABLE TRIGGER gazette_submission_room_lifecycle')
    }
    assert.equal((await database.query(
      'SELECT gazette_submission_room_is_open() AS submissions_open',
    )).rows[0].submissions_open, true)
  })

  await database.query(`
    CREATE OR REPLACE FUNCTION enforce_gazette_submission_limit()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.place_id = 454 THEN
        RAISE EXCEPTION 'simulated closed-room enforcement race'
          USING ERRCODE = '23514', CONSTRAINT = 'gazette_submission_room_closed';
      END IF;
      RETURN NEW;
    END
    $$;
  `)
  assert.deepEqual(
    await runTalkNoteAction({
      placeId: 454,
      residentId: 1,
      residentHandle: 'gazette-founder',
      text: 'A trigger race must stay caller-safe.',
    }, sql),
    {
      ok: false,
      status: 409,
      error: 'Gazette submission room #454 is not open; read GET /api/gazette and submit only when submission_room.submissions_open is true',
    },
  )
  assert.deepEqual((await database.query(`
    SELECT resident.notes_today,
      (SELECT count(*)::integer FROM notes WHERE place_id = 454) AS notes,
      (SELECT count(*)::integer
        FROM active_labels
        WHERE target_type = 'resident'
          AND target_id = resident.id
          AND label = 'gazette-race-leak'
      ) AS leaked_law_effects
    FROM residents resident
    WHERE resident.id = 1
  `)).rows[0], { notes_today: 0, notes: 0, leaked_law_effects: 0 })

  assert.deepEqual((await database.query(`
    SELECT resolution.status, resolution.detail
    FROM action_runs run
    JOIN action_resolutions resolution ON resolution.action_run_id = run.id
    WHERE run.actor_id = 1
      AND run.action_name = 'talk'
      AND run.place_id = 454
    ORDER BY run.id DESC
    LIMIT 1
  `)).rows[0], {
    status: 'failed',
    detail: {
      error: 'Gazette submission room #454 is not open; read GET /api/gazette and submit only when submission_room.submissions_open is true',
    },
  })

  await database.query(`
    INSERT INTO place_law_changes (
      place_id, trait_id, actor_id, change_type, position
    )
    SELECT 2, id, 1, 'remove', NULL
    FROM traits
    WHERE name = 'gazette-race-marker'
  `)

  await database.query(migrationDdl)

  const openedSubmission = await runTalkNoteAction({
    placeId: 454,
    residentId: 1,
    residentHandle: 'gazette-founder',
    text: 'The room is now open.',
  }, sql)
  assert.equal(openedSubmission.ok, true)

  await database.query(activationDdl)
  assert.equal((await database.query(`
    SELECT count(*)::integer AS count
    FROM events
    WHERE kind = 'place_edited'
      AND detail @> '{"place_id":454,"gazette_submission_room_opened":true}'::jsonb
  `)).rows[0].count, 1, 'an idempotent rerun emits no second opening event')
})
