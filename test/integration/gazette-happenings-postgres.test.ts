import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import type { Pool } from 'pg'

import { setEngineTransactionRunnerForTests, type TaggedSql } from '../../src/engine.ts'
import {
  GAZETTE_HAPPENINGS_EMPTY_SENTENCE,
  GAZETTE_HAPPENINGS_FAILURE_SENTENCE,
  GAZETTE_HAPPENINGS_HEADING,
  GAZETTE_HAPPENINGS_INTRO,
} from '../../src/gazette-happenings.ts'
import {
  activationDdl,
  gazetteRuntime,
  schemaDdl,
  startPostgres,
  taggedFor,
  withdrawalActivationDdl,
  withdrawalMigrationDdl,
} from '../helpers/gazette-fixtures/postgres.ts'

const emptyBlock = [
  GAZETTE_HAPPENINGS_HEADING,
  GAZETTE_HAPPENINGS_INTRO,
  GAZETTE_HAPPENINGS_EMPTY_SENTENCE,
].join('\n')

async function insertPlace(
  database: Pool,
  input: Readonly<{
    id: number
    parentId: number
    kind?: 'continent' | 'place'
    ownerId: number
    name: string
    createdAt: string
    quiet?: boolean
    retiredAt?: string
  }>,
): Promise<void> {
  await database.query(`
    INSERT INTO places (
      id, parent_id, place_kind, name, description, purpose, owner_id,
      open_to_building, open_to_things, open_to_notes, quiet, retired_at, created_at
    ) VALUES (
      $1, $2, $3, $4, 'Integration-only Gazette Happenings fixture.', '', $5,
      FALSE, FALSE, FALSE, $6, $7, $8
    )
  `, [
    input.id,
    input.parentId,
    input.kind ?? 'place',
    input.name,
    input.ownerId,
    input.quiet ?? false,
    input.retiredAt ?? null,
    input.createdAt,
  ])
}

async function insertNote(
  database: Pool,
  input: Readonly<{
    id: number
    placeId: number
    authorId: number
    body: string
    createdAt: string
    walkToRead?: boolean
  }>,
): Promise<void> {
  await database.query(`
    INSERT INTO notes (id, place_id, author_id, walk_to_read, body, created_at)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [
    input.id,
    input.placeId,
    input.authorId,
    input.walkToRead ?? false,
    input.body,
    input.createdAt,
  ])
}

async function insertLine(
  database: Pool,
  input: Readonly<{ id: number; placeId: number; createdAt: string; body: string }>,
): Promise<void> {
  await database.query(`
    INSERT INTO room_lines (id, place_id, resident_id, body, body_bytes, request_id, created_at)
    VALUES ($1, $2, 1, $3, octet_length($3), $4::uuid, $5)
  `, [
    input.id,
    input.placeId,
    input.body,
    `00000000-0000-0000-0000-${String(input.id).padStart(12, '0')}`,
    input.createdAt,
  ])
}

test('Gazette Happenings prints the public week facts and contains a failed read', async t => {
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
  const residents = [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13]
  await database.query(`
    INSERT INTO residents (id, handle, model, secret_hash)
    VALUES ${residents.map(id => `(${id}, 'happenings-${id}', 'integration-test', repeat('${id.toString(16)}', 64))`).join(', ')}
  `)
  const worldId = Number((await database.query<{ id: number }>(`
    SELECT id FROM places WHERE place_kind = 'world'
  `)).rows[0]?.id)
  await insertPlace(database, {
    id: 2,
    parentId: worldId,
    kind: 'continent',
    ownerId: 1,
    name: 'Gazette Happenings fixture continent',
    createdAt: '2026-08-01T00:00:00.000Z',
  })
  await database.query(`
    INSERT INTO places (
      id, parent_id, place_kind, name, description, purpose, owner_id,
      open_to_building, open_to_things, open_to_notes, created_at
    ) VALUES
      (438, 2, 'place', 'the Showing Room', 'Integration-only Showing Room.', '', 1, FALSE, FALSE, FALSE, '2026-08-01T00:00:00Z'),
      (454, 2, 'place', 'the gazette submission room', 'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.', '', 1, FALSE, FALSE, FALSE, '2026-08-01T00:00:00Z');

    INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
    VALUES (1, 454, 454), (2, 454, 454), (3, 454, 454), (5, 454, 454),
      (6, 454, 454), (7, 454, 454), (8, 454, 454), (9, 454, 454),
      (10, 454, 454), (11, 454, 454), (12, 454, 454), (13, 454, 454);
  `)

  await insertPlace(database, {
    id: 1000,
    parentId: worldId,
    kind: 'continent',
    ownerId: 1,
    name: 'week continent',
    createdAt: '2026-09-22T17:00:00.000Z',
  })
  await insertPlace(database, {
    id: 1001,
    parentId: 1000,
    ownerId: 1,
    name: 'nested same-owner place',
    createdAt: '2026-09-22T17:01:00.000Z',
  })
  await insertPlace(database, {
    id: 1012,
    parentId: 2,
    ownerId: 1,
    name: 'same-owner sibling place',
    createdAt: '2026-09-22T17:02:00.000Z',
  })
  const founderPlaces = [
    [1002, 2, 'founded room 2'],
    [1003, 3, 'founded room 3'],
    [1004, 5, 'founded room 5'],
    [1005, 6, 'founded room 6'],
    [1006, 7, 'founded room 7'],
    [1007, 8, 'founded room 8'],
    [1008, 9, 'founded room 9'],
    [1009, 10, 'founded room 10'],
    [1010, 11, 'founded room 11'],
    [1011, 12, 'founded room 12'],
  ] as const
  for (const [index, [id, ownerId, name]] of founderPlaces.entries()) {
    await insertPlace(database, {
      id,
      parentId: 2,
      ownerId,
      name,
      createdAt: `2026-09-22T18:${String(index).padStart(2, '0')}:00.000Z`,
    })
  }
  await insertPlace(database, {
    id: 1020,
    parentId: 2,
    ownerId: 13,
    name: 'quiet ancestor',
    quiet: true,
    createdAt: '2026-09-23T10:00:00.000Z',
  })
  await insertPlace(database, {
    id: 1021,
    parentId: 1020,
    ownerId: 13,
    name: 'child of quiet ancestor',
    createdAt: '2026-09-23T10:01:00.000Z',
  })
  await insertPlace(database, {
    id: 1022,
    parentId: 2,
    ownerId: 5,
    name: 'retired place',
    retiredAt: '2026-09-24T00:00:00.000Z',
    createdAt: '2026-09-23T11:00:00.000Z',
  })
  await insertPlace(database, {
    id: 1023,
    parentId: 2,
    ownerId: 6,
    name: 'removed place',
    createdAt: '2026-09-23T12:00:00.000Z',
  })
  await insertPlace(database, {
    id: 1024,
    parentId: 2,
    ownerId: 7,
    name: 'after the print slot',
    createdAt: '2026-09-28T17:00:00.000Z',
  })
  for (let index = 0; index < 13; index += 1) {
    await insertPlace(database, {
      id: 2000 + index,
      parentId: 2,
      ownerId: residents[index % residents.length]!,
      name: `first line room ${index}`,
      createdAt: '2026-08-10T00:00:00.000Z',
    })
  }
  await insertPlace(database, {
    id: 3000,
    parentId: 2,
    ownerId: 12,
    name: 'older corner',
    createdAt: '2026-08-11T00:00:00.000Z',
  })
  await insertPlace(database, {
    id: 3001,
    parentId: 2,
    ownerId: 13,
    name: 'newest corner',
    createdAt: '2026-08-12T00:00:00.000Z',
  })

  await database.query(withdrawalMigrationDdl)
  await database.query(activationDdl)
  await database.query(withdrawalActivationDdl)
  const transactionRunner = async (
    _database: TaggedSql,
    work: (transaction: TaggedSql, atomic: boolean) => Promise<unknown>,
  ): Promise<unknown> => {
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
  }
  setEngineTransactionRunnerForTests(transactionRunner)

  await database.query('ALTER TABLE notes DISABLE TRIGGER gazette_note_submission_limit')
  try {
    await insertNote(database, {
      id: 6101,
      placeId: 438,
      authorId: 1,
      body: 'THE WEATHER QUESTION: Will it rain? 2026-09-25 at 15:00:00 UTC, 2026-10-02 at 15:00:00 UTC, 2026-10-03 at 15:00:00 UTC',
      createdAt: '2026-09-22T09:00:00.000Z',
    })
    await insertNote(database, {
      id: 6102,
      placeId: 438,
      authorId: 1,
      body: 'THE NO_TIME QUESTION: this note names no instant',
      createdAt: '2026-09-23T09:00:00.000Z',
    })
    await insertNote(database, {
      id: 6103,
      placeId: 438,
      authorId: 1,
      body: 'THE WEATHER QUESTION: 2026-10-04 at 15:00:00 UTC',
      createdAt: '2026-09-24T09:00:00.000Z',
    })
    await insertNote(database, {
      id: 6104,
      placeId: 438,
      authorId: 2,
      body: 'THE OTHER QUESTION: 2026-10-04 at 15:00:00 UTC',
      createdAt: '2026-09-25T09:00:00.000Z',
    })
    await insertNote(database, {
      id: 6105,
      placeId: 438,
      authorId: 1,
      walkToRead: true,
      body: 'THE WALK QUESTION: 2026-10-04 at 15:00:00 UTC',
      createdAt: '2026-09-26T09:00:00.000Z',
    })
    await insertNote(database, {
      id: 6200,
      placeId: 3000,
      authorId: 12,
      body: 'older corner first note',
      createdAt: '2026-09-24T09:00:00.000Z',
    })
    await insertNote(database, {
      id: 6201,
      placeId: 3001,
      authorId: 13,
      body: 'newest corner first note',
      createdAt: '2026-09-25T09:00:00.000Z',
    })
    await insertNote(database, {
      id: 6300,
      placeId: 454,
      authorId: 1,
      body: 'A deterministic integration entry for the Gazette printer.',
      createdAt: '2026-09-29T09:00:00.000Z',
    })
  } finally {
    await database.query('ALTER TABLE notes ENABLE TRIGGER gazette_note_submission_limit')
  }

  for (let index = 0; index < 11; index += 1) {
    await insertLine(database, {
      id: 8000 + index,
      placeId: 2000 + index,
      body: `first line ${index}`,
      createdAt: `2026-09-22T17:${String(index).padStart(2, '0')}:00.000Z`,
    })
  }
  await insertLine(database, {
    id: 8011,
    placeId: 2011,
    body: 'removed earliest line',
    createdAt: '2026-09-22T17:11:00.000Z',
  })
  await insertLine(database, {
    id: 8012,
    placeId: 2011,
    body: 'first remaining line',
    createdAt: '2026-09-22T17:30:00.000Z',
  })
  await insertLine(database, {
    id: 8013,
    placeId: 2012,
    body: 'issue four first line',
    createdAt: '2026-09-18T17:00:00.000Z',
  })
  await insertLine(database, {
    id: 8014,
    placeId: 2012,
    body: 'issue five second line',
    createdAt: '2026-09-22T18:00:00.000Z',
  })
  await database.query(`
    INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason, created_at)
    VALUES
      ('place', 1023, 'remove', 1, 'Happenings fixture removal', '2026-09-23T13:00:00Z'),
      ('line', 8011, 'remove', 1, 'Happenings fixture line removal', '2026-09-22T18:00:00Z');
  `)

  const printGazetteIssuesDue = gazetteRuntime.printGazetteIssuesDue!
  await t.test('issue 5 prints the exact Happenings block even when printed late', async () => {
    await printGazetteIssuesDue(taggedFor(database), '2026-09-30T00:00:00.000Z')
    const issues = (await database.query<{ issue_number: number; header: string }>(`
      SELECT issue_number, header FROM gazette_issues ORDER BY issue_number
    `)).rows
    assert.equal(issues.length, 5)
    for (const issue of issues.filter(row => row.issue_number <= 3)) {
      assert.ok(issue.header.endsWith(emptyBlock), `issue ${issue.issue_number}`)
    }
    const issueFour = issues.find(row => row.issue_number === 4)?.header
    assert.ok(issueFour?.endsWith([
      GAZETTE_HAPPENINGS_HEADING,
      GAZETTE_HAPPENINGS_INTRO,
      'First lines said: place #2012.',
    ].join('\n')))
    const issueFive = issues.find(row => row.issue_number === 5)?.header
    assert.ok(issueFive)
    assert.equal(issueFive.split('\n').at(-1), 'A small corner: place #3001, first note #6201.')
    assert.equal(issueFive.slice(issueFive.indexOf(GAZETTE_HAPPENINGS_HEADING)), [
      GAZETTE_HAPPENINGS_HEADING,
      GAZETTE_HAPPENINGS_INTRO,
      'Places founded: place #1000 (continent), place #1002, place #1003, place #1004, place #1005, place #1006, place #1007, place #1008, place #1009, place #1010.',
      'And 2 more qualifying places were founded; browse with view events and kind place_created lists every place, including quiet and nested ones.',
      'In the Showing Room, place #438: question note #6101, times named 2026-09-25 at 15:00 UTC and 2026-10-02 at 15:00 UTC, still open at this print.',
      'First lines said: place #2000, place #2001, place #2002, place #2003, place #2004, place #2005, place #2006, place #2007, place #2008, place #2009.',
      'And 2 more rooms had their first lines said.',
      'A small corner: place #3001, first note #6201.',
    ].join('\n'), issueFive)
    assert.doesNotMatch(issueFive, /place #1024/u)
  })

  await t.test('a failed read prints the failure line and the issue still commits', async () => {
    await database.query('ALTER TABLE room_lines RENAME TO room_lines_unavailable')
    try {
      await printGazetteIssuesDue(taggedFor(database), '2026-10-05T16:00:00.000Z')
      const issue = (await database.query<{ header: string; entry_count: number }>(`
        SELECT header, entry_count FROM gazette_issues WHERE issue_number = 6
      `)).rows[0]
      assert.ok(issue)
      assert.equal(issue.entry_count, 1)
      assert.ok(issue.header.endsWith([
        GAZETTE_HAPPENINGS_HEADING,
        GAZETTE_HAPPENINGS_FAILURE_SENTENCE,
      ].join('\n')))
      assert.equal((await database.query<{ count: number }>(`
        SELECT count(*)::integer AS count FROM gazette_issue_entries WHERE issue_number = 6
      `)).rows[0]?.count, 1)
      assert.equal((await database.query<{ count: number }>(`
        SELECT count(*)::integer AS count
        FROM events
        WHERE kind = 'gazette_printed'
          AND detail ->> 'issue_number' = '6'
      `)).rows[0]?.count, 1)
    } finally {
      await database.query('ALTER TABLE room_lines_unavailable RENAME TO room_lines')
    }
  })

  await t.test('the timeout is back to the session value before commit', async () => {
    let timeoutBeforeCommit: string | null = null
    setEngineTransactionRunnerForTests(async (_database, work) => {
      const client = await database.connect()
      try {
        await client.query('BEGIN')
        const result = await work(taggedFor(client), true)
        const timeoutRows = await client.query<{ statement_timeout: string }>('SHOW statement_timeout')
        timeoutBeforeCommit = timeoutRows.rows[0]?.statement_timeout ?? null
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    })
    await printGazetteIssuesDue(taggedFor(database), '2026-10-12T16:00:00.000Z')
    assert.equal(timeoutBeforeCommit, '0')
  })
})
