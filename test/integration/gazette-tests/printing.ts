import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import type { TaggedSql } from '../../../src/engine.ts'
import { MODERATED_TEXT } from '../../../src/moderation.ts'
import { gazetteRuntime, gazetteStoreRuntime, iso } from '../../helpers/gazette-fixtures/postgres.ts'

export async function registerPrintingTests(
  t: TestContext,
  database: Pool,
  sql: TaggedSql,
): Promise<void> {
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
      SELECT issue.issue_number, issue.scheduled_for, issue.printed_at, issue.header, issue.entry_count,
        entry.ordinal, entry.note_id, note.body, resident.handle, note.created_at
      FROM gazette_issues issue
      LEFT JOIN gazette_issue_entries entry USING (issue_number)
      LEFT JOIN notes note ON note.id = entry.note_id
      LEFT JOIN residents resident ON resident.id = note.author_id
      ORDER BY issue.issue_number, entry.ordinal
    `)).rows.map(row => ({
      ...row,
      scheduled_for: iso(row.scheduled_for),
      printed_at: iso(row.printed_at),
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
      SELECT issue.issue_number, issue.scheduled_for, issue.printed_at, issue.header, issue.entry_count,
        entry.ordinal, entry.note_id, note.body, resident.handle, note.created_at
      FROM gazette_issues issue
      LEFT JOIN gazette_issue_entries entry USING (issue_number)
      LEFT JOIN notes note ON note.id = entry.note_id
      LEFT JOIN residents resident ON resident.id = note.author_id
      ORDER BY issue.issue_number, entry.ordinal
    `)).rows.map(row => ({
      ...row,
      scheduled_for: iso(row.scheduled_for),
      printed_at: iso(row.printed_at),
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
        printed_at: firstPrint[0]!.printed_at as string,
        header: gazetteRuntime.printGazetteIssuesDue
          ? (firstPrint[0]!.header as string)
          : '',
        entry_count: 3,
      },
      entries: [
        {
          ordinal: 1,
          note_id: source[1]!.id,
          author_id: 2,
          author: 'gazette-beta',
          body: '  lead\ntrail  ',
          created_at: '2026-08-24T16:00:00.000Z',
          withdrawn: false,
          withdrawal_note_id: null,
          withdrawn_at: null,
        },
        {
          ordinal: 2,
          note_id: source[0]!.id,
          author_id: 1,
          author: 'gazette-alpha',
          body: 'Unicode 🏮\nunchanged',
          created_at: '2026-08-30T12:00:00.000Z',
          withdrawn: false,
          withdrawal_note_id: null,
          withdrawn_at: null,
        },
      ],
      hasMore: true,
      nextAfterOrdinal: 2,
      returnedTextBytes: Buffer.byteLength('  lead\ntrail  ', 'utf8')
        + Buffer.byteLength('Unicode 🏮\nunchanged', 'utf8'),
      stoppedForTextLimit: false,
      nextItemOrdinal: null,
      nextItemNoteId: null,
      nextItemTextBytes: null,
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
      printed_at: firstPrint[0]!.printed_at as string,
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

}
