import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  exportPublicSnapshot,
  resolveSnapshotDatabaseUrl,
  type SnapshotDatabaseClient,
} from '../scripts/export-public-snapshot.ts'

test('snapshot database selection is explicit and never falls back to an app database', () => {
  assert.throws(
    () => resolveSnapshotDatabaseUrl({ DATABASE_URL: 'postgresql://app:secret@localhost/city' }),
    /SNAPSHOT_DATABASE_URL/,
  )
  assert.throws(
    () => resolveSnapshotDatabaseUrl({ SNAPSHOT_DATABASE_URL: '  ' }),
    /SNAPSHOT_DATABASE_URL/,
  )
  assert.equal(
    resolveSnapshotDatabaseUrl({
      SNAPSHOT_DATABASE_URL: 'postgresql://city_snapshot_export:secret@db.example/city?sslmode=require',
      DATABASE_URL: 'postgresql://app:secret@localhost/wrong',
    }),
    'postgresql://city_snapshot_export:secret@db.example/city?sslmode=require',
  )
  assert.throws(
    () => resolveSnapshotDatabaseUrl({
      SNAPSHOT_DATABASE_URL: 'postgresql://app:secret@db.example/city',
    }),
    /city_snapshot_export/,
  )
  for (const hostname of [
    'ep-example-pooler.us-east-2.aws.neon.tech',
    'aws-0-us-east-1.pooler.supabase.com',
  ]) {
    assert.throws(
      () => resolveSnapshotDatabaseUrl({
        SNAPSHOT_DATABASE_URL: `postgresql://city_snapshot_export:secret@${hostname}/city`,
      }),
      /pooler/,
    )
  }
})

test('export uses one frozen read-only transaction through the exact dual-view Gazette transition', async () => {
  const calls: Array<{ text: string; values?: readonly unknown[] }> = []
  const client: SnapshotDatabaseClient = {
    connect: async () => undefined,
    query: async (text, values) => {
      calls.push(values === undefined ? { text } : { text, values })
      if (/snapshot-export:attest-role/iu.test(text)) {
        return { rows: [{
          current_user: 'city_snapshot_export',
          transaction_read_only: 'on',
          can_read_view: true,
          can_read_legacy_view: true,
          can_read_residents: false,
          can_write_residents: false,
          can_read_public_base: false,
          can_write_public_base: false,
          can_read_private: false,
          view_columns: ['class_name', 'record_id', 'sort_key', 'payload'],
        }] }
      }
      if (/snapshot-export:records/iu.test(text)) {
        return { rows: [
          {
            class_name: 'gazette_issue_entries',
            record_id: '19',
            sort_key: '19',
            payload: {
              id: 19, status: 'exported', issue_number: 1, ordinal: 1,
              note_id: 19, author_id: 2, author: 'writer',
              created_at: '2026-08-31T15:59:59.000Z',
            },
            exported_at: '2026-08-23T12:34:56.000Z',
          },
          {
            class_name: 'gazette_issue_entries',
            record_id: '20',
            sort_key: '20',
            payload: {
              id: 20, status: 'exported', issue_number: 1, ordinal: 2,
              note_id: 20, author_id: 2, author: 'writer',
              created_at: '2026-08-31T15:59:59.250Z', withdrawn: true,
              withdrawal_note_id: 21, withdrawn_at: '2026-08-31T15:59:59.500Z',
            },
            exported_at: '2026-08-23T12:34:56.000Z',
          },
          {
            class_name: 'gazette_issues',
            record_id: '1',
            sort_key: '1',
            payload: {
              id: 1, status: 'exported', issue_number: 1,
              scheduled_for: '2026-08-31T16:00:00.000Z',
              printed_at: '2026-08-31T16:00:01.000Z',
              header: 'THE GAZETTE — ISSUE 1', entry_count: 2, event_id: 41,
            },
            exported_at: '2026-08-23T12:34:56.000Z',
          },
          {
            class_name: 'gazette_withdrawals',
            record_id: '20',
            sort_key: '20',
            payload: {
              id: 20, status: 'exported', target_note_id: 20,
              withdrawal_note_id: 21, author_id: 2, author: 'writer',
              withdrawn_at: '2026-08-31T15:59:59.500Z',
            },
            exported_at: '2026-08-23T12:34:56.000Z',
          },
          {
            class_name: 'residents',
            record_id: '1',
            sort_key: '1',
            payload: { id: 1, status: 'exported', handle: 'founder' },
            exported_at: '2026-08-23T12:34:56.000Z',
          },
        ] }
      }
      return { rows: [] }
    },
    end: async () => undefined,
  }
  const root = await mkdtemp(join(tmpdir(), '1f3d9-snapshot-export-'))
  try {
    const result = await exportPublicSnapshot({
      outputDirectory: root,
      databaseUrl: 'postgresql://city_snapshot_export:secret@db.example/city',
      sourceCommit: 'd'.repeat(40),
      client,
    })
    assert.equal(result.counts.residents, 1)
    assert.equal(result.counts.gazette_issues, 1)
    assert.equal(result.counts.gazette_issue_entries, 2)
    assert.equal(result.counts.gazette_withdrawals, 1)
    assert.match(calls[0]!.text, /BEGIN[\s\S]*REPEATABLE READ[\s\S]*READ ONLY/iu)
    assert.match(calls.at(-1)!.text, /COMMIT/iu)
    assert.equal(calls.filter(call => /snapshot-export:records/iu.test(call.text)).length, 1)
    assert.equal(calls.some(call => /SELECT\s+\*/iu.test(call.text)), false)
    assert.match(
      calls.find(call => /snapshot-export:records/iu.test(call.text))!.text,
      /FROM city_snapshot\.public_records_v2 records/iu,
    )
    assert.match(
      calls.find(call => /snapshot-export:attest-role/iu.test(call.text))!.text,
      /city_snapshot\.public_records'[\s\S]+can_read_legacy_view/iu,
    )
    assert.match(
      calls.find(call => /snapshot-export:attest-role/iu.test(call.text))!.text,
      /public\.resident_refusal_state/iu,
    )
    const entryRecords = (await readFile(join(root, 'gazette_issue_entries.ndjson'), 'utf8'))
      .trimEnd().split('\n').map(line => (
        JSON.parse(line) as { record: Readonly<Record<string, unknown>> }
      ).record)
    assert.deepEqual(entryRecords, [
      {
        id: 19, status: 'exported', issue_number: 1, ordinal: 1,
        note_id: 19, author_id: 2, author: 'writer',
        created_at: '2026-08-31T15:59:59.000Z',
      },
      {
        id: 20, status: 'exported', issue_number: 1, ordinal: 2,
        note_id: 20, author_id: 2, author: 'writer',
        created_at: '2026-08-31T15:59:59.250Z', withdrawn: true,
        withdrawal_note_id: 21, withdrawn_at: '2026-08-31T15:59:59.500Z',
      },
    ])
    const withdrawalEnvelope = JSON.parse(
      await readFile(join(root, 'gazette_withdrawals.ndjson'), 'utf8'),
    ) as { record: Readonly<Record<string, unknown>> }
    assert.deepEqual(withdrawalEnvelope.record, {
      id: 20, status: 'exported', target_note_id: 20,
      withdrawal_note_id: 21, author_id: 2, author: 'writer',
      withdrawn_at: '2026-08-31T15:59:59.500Z',
    })
    assert.equal(Object.hasOwn(withdrawalEnvelope.record, 'body'), false)
    const officialFile = await readFile(join(root, 'official.ndjson'), 'utf8')
    const officialEnvelope = JSON.parse(officialFile.trim()) as {
      record: {
        public_snapshots: { scope: string; format_version: number; releases: string }
        later_holder_discovery: { method: string }
        market_bridge: { payment_reconcile: string }
      }
    }
    assert.equal(
      officialEnvelope.record.public_snapshots.scope,
      'the full approved anonymous public record, not only the names directory',
    )
    assert.equal(officialEnvelope.record.public_snapshots.format_version, 2)
    assert.equal(
      officialEnvelope.record.public_snapshots.releases,
      'https://github.com/onetapstudiogames/1f3d9/releases?q=city-snapshot-',
    )
    assert.equal(officialEnvelope.record.later_holder_discovery.method, 'POST')
    assert.match(officialEnvelope.record.market_bridge.payment_reconcile, /\/api\/world\/offer\/:id\/reconcile$/u)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('credential-shaped public text aborts before any snapshot bundle is written', async () => {
  const credential = `1f3d9_sk_${'ab'.repeat(24)}`
  const sourcePayload = Object.freeze({
    id: 3,
    status: 'exported',
    body: `already-public incident evidence ${credential}`,
  })
  let ended = false
  const client: SnapshotDatabaseClient = {
    connect: async () => undefined,
    query: async text => {
      if (/snapshot-export:attest-role/iu.test(text)) return { rows: [{
        current_user: 'city_snapshot_export',
        transaction_read_only: 'on',
        can_read_view: true,
        can_read_legacy_view: false,
        can_read_residents: false,
        can_write_residents: false,
        can_read_public_base: false,
        can_write_public_base: false,
        can_read_private: false,
        view_columns: ['class_name', 'record_id', 'sort_key', 'payload'],
      }] }
      if (/snapshot-export:records/iu.test(text)) return { rows: [{
        class_name: 'notes',
        record_id: '3',
        sort_key: '3',
        payload: sourcePayload,
        exported_at: '2026-08-23T12:34:56.000Z',
      }] }
      return { rows: [] }
    },
    end: async () => { ended = true },
  }
  const root = await mkdtemp(join(tmpdir(), '1f3d9-snapshot-credential-'))
  try {
    const outputDirectory = join(root, 'snapshot')
    await assert.rejects(() => exportPublicSnapshot({
      outputDirectory,
      databaseUrl: 'postgresql://city_snapshot_export:secret@db.example/city',
      sourceCommit: 'f'.repeat(40),
      client,
    }), /credential/iu)
    assert.equal(sourcePayload.body, `already-public incident evidence ${credential}`)
    assert.deepEqual(await readdir(root), [], 'a failed export must leave no partial bundle')
    assert.equal(ended, true)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('the two approved legacy founder note bodies are represented but not exported', async () => {
  const credential = `1f3d9_sk_${'cd'.repeat(24)}`
  const rows = [56, 57].map(id => ({
    class_name: 'notes',
    record_id: String(id),
    sort_key: String(id),
    payload: {
      id,
      status: 'exported',
      place_id: 3,
      author_id: 1,
      author: 'founder',
      body: `legacy example ${credential}`,
      created_at: id === 56
        ? '2026-08-13T04:32:00.687149+00:00'
        : '2026-08-13T04:36:04.669429+00:00',
    },
    exported_at: '2026-08-23T12:34:56.000Z',
  }))
  const client: SnapshotDatabaseClient = {
    connect: async () => undefined,
    query: async text => {
      if (/snapshot-export:attest-role/iu.test(text)) return { rows: [{
        current_user: 'city_snapshot_export',
        transaction_read_only: 'on',
        can_read_view: true,
        can_read_legacy_view: false,
        can_read_residents: false,
        can_write_residents: false,
        can_read_public_base: false,
        can_write_public_base: false,
        can_read_private: false,
        view_columns: ['class_name', 'record_id', 'sort_key', 'payload'],
      }] }
      if (/snapshot-export:records/iu.test(text)) return { rows }
      return { rows: [] }
    },
    end: async () => undefined,
  }
  const root = await mkdtemp(join(tmpdir(), '1f3d9-snapshot-legacy-notes-'))
  try {
    const result = await exportPublicSnapshot({
      outputDirectory: root,
      databaseUrl: 'postgresql://city_snapshot_export:secret@db.example/city',
      sourceCommit: 'c'.repeat(40),
      client,
    })
    assert.equal(result.counts.notes, 2)
    const notes = (await readFile(join(root, 'notes.ndjson'), 'utf8'))
      .trimEnd()
      .split('\n')
      .map(line => (JSON.parse(line) as { record: Readonly<Record<string, unknown>> }).record)
    assert.deepEqual(notes, rows.map(row => ({
      id: row.payload.id,
      status: 'body_not_exported',
      reason: 'legacy resident key safety',
      place_id: row.payload.place_id,
      author_id: row.payload.author_id,
      author: row.payload.author,
      created_at: row.payload.created_at,
    })))
    assert.doesNotMatch(await readFile(join(root, 'notes.ndjson'), 'utf8'), /1f3d9_sk_/iu)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('an approved legacy note exclusion stops if its immutable metadata drifts', async () => {
  const basePayload = Object.freeze({
    id: 56,
    status: 'exported',
    place_id: 3,
    author_id: 1,
    author: 'founder',
    body: `legacy example 1f3d9_sk_${'ef'.repeat(24)}`,
    created_at: '2026-08-13T04:32:00.687149+00:00',
  })
  const changedRows = [
    { recordId: '56', payload: { ...basePayload, status: 'maintainer_hidden' } },
    { recordId: '56', payload: { ...basePayload, place_id: 4 } },
    { recordId: '56', payload: { ...basePayload, author_id: 2 } },
    { recordId: '56', payload: { ...basePayload, author: 'not-founder' } },
    {
      recordId: '56',
      payload: { ...basePayload, created_at: '2026-08-13T04:32:00.687150+00:00' },
    },
    {
      recordId: '57',
      payload: {
        ...basePayload,
        id: 57,
        created_at: '2026-08-13T04:36:04.669430+00:00',
      },
    },
  ]
  for (const [index, row] of changedRows.entries()) {
    const client: SnapshotDatabaseClient = {
      connect: async () => undefined,
      query: async text => {
        if (/snapshot-export:attest-role/iu.test(text)) return { rows: [{
          current_user: 'city_snapshot_export',
          transaction_read_only: 'on',
          can_read_view: true,
          can_read_legacy_view: false,
          can_read_residents: false,
          can_write_residents: false,
          can_read_public_base: false,
          can_write_public_base: false,
          can_read_private: false,
          view_columns: ['class_name', 'record_id', 'sort_key', 'payload'],
        }] }
        if (/snapshot-export:records/iu.test(text)) return { rows: [{
          class_name: 'notes',
          record_id: row.recordId,
          sort_key: row.recordId,
          payload: row.payload,
          exported_at: '2026-08-23T12:34:56.000Z',
        }] }
        return { rows: [] }
      },
      end: async () => undefined,
    }
    const root = await mkdtemp(join(tmpdir(), `1f3d9-snapshot-drift-${index}-`))
    try {
      await assert.rejects(() => exportPublicSnapshot({
        outputDirectory: root,
        databaseUrl: 'postgresql://city_snapshot_export:secret@db.example/city',
        sourceCommit: 'b'.repeat(40),
        client,
      }), /no longer matches its approved exclusion/iu)
      assert.deepEqual(await readdir(root), [])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }
})

test('export refuses a role with base-table read or write access', async () => {
  const client: SnapshotDatabaseClient = {
    connect: async () => undefined,
    query: async text => {
      if (/attest-role/iu.test(text)) return { rows: [{
        current_user: 'city_snapshot_export',
        transaction_read_only: 'on',
        can_read_view: true,
        can_read_legacy_view: false,
        can_read_residents: true,
        can_write_residents: false,
        can_read_public_base: true,
        can_write_public_base: false,
        can_read_private: false,
        view_columns: ['class_name', 'record_id', 'sort_key', 'payload'],
      }] }
      return { rows: [] }
    },
    end: async () => undefined,
  }
  await assert.rejects(() => exportPublicSnapshot({
    outputDirectory: join(tmpdir(), 'must-not-exist'),
    databaseUrl: 'postgresql://city_snapshot_export:secret@db.example/city',
    sourceCommit: 'e'.repeat(40),
    client,
  }), /base table|restricted/iu)
})
