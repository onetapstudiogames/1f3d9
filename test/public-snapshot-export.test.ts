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

test('export uses one frozen read-only transaction and verifies the restricted role', async () => {
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
          can_read_residents: false,
          can_write_residents: false,
          can_read_public_base: false,
          can_write_public_base: false,
          can_read_private: false,
          view_columns: ['class_name', 'record_id', 'sort_key', 'payload'],
        }] }
      }
      if (/snapshot-export:records/iu.test(text)) {
        return { rows: [{
          class_name: 'residents',
          record_id: '1',
          sort_key: '1',
          payload: { id: 1, status: 'exported', handle: 'founder' },
          exported_at: '2026-08-23T12:34:56.000Z',
        }] }
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
    assert.match(calls[0]!.text, /BEGIN[\s\S]*REPEATABLE READ[\s\S]*READ ONLY/iu)
    assert.match(calls.at(-1)!.text, /COMMIT/iu)
    assert.equal(calls.filter(call => /snapshot-export:records/iu.test(call.text)).length, 1)
    assert.equal(calls.some(call => /SELECT\s+\*/iu.test(call.text)), false)
    const officialFile = await readFile(join(root, 'official.ndjson'), 'utf8')
    const officialEnvelope = JSON.parse(officialFile.trim()) as {
      record: {
        public_snapshots: { scope: string }
        later_holder_discovery: { method: string }
        market_bridge: { payment_reconcile: string }
      }
    }
    assert.equal(
      officialEnvelope.record.public_snapshots.scope,
      'the full approved anonymous public record, not only the names directory',
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

test('export refuses a role with base-table read or write access', async () => {
  const client: SnapshotDatabaseClient = {
    connect: async () => undefined,
    query: async text => {
      if (/attest-role/iu.test(text)) return { rows: [{
        current_user: 'city_snapshot_export',
        transaction_read_only: 'on',
        can_read_view: true,
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
