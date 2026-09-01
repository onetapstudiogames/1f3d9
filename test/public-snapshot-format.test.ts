import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  PUBLIC_SNAPSHOT_CLASS_REGISTRY,
  PUBLIC_SNAPSHOT_FORMAT_VERSION,
  canonicalJson,
  createSnapshotBundle,
  recordFingerprint,
  verifySnapshotDirectory,
} from '../src/public-snapshot-format.ts'

const RECORDS = Object.freeze([
  Object.freeze({
    class_name: 'notes',
    record_id: '9',
    sort_key: '9',
    payload: Object.freeze({
      id: 9,
      status: 'exported',
      body: 'e\u0301 stays decomposed\r\nsecond line\nthird line',
    }),
  }),
  Object.freeze({
    class_name: 'residents',
    record_id: '4',
    sort_key: '4',
    payload: Object.freeze({ id: 4, status: 'reserved', reason: 'permanent_resident_landmark' }),
  }),
  Object.freeze({
    class_name: 'residents',
    record_id: '2',
    sort_key: '2',
    payload: Object.freeze({ id: 2, status: 'exported', handle: 'small-light' }),
  }),
])

test('canonical JSON and short record fingerprints are stable without text normalization', () => {
  const left = { z: 'e\u0301\r\n', a: { y: 2, x: 1 } }
  const right = { a: { x: 1, y: 2 }, z: 'e\u0301\r\n' }
  assert.equal(canonicalJson(left), canonicalJson(right))
  assert.equal(canonicalJson(left), '{"a":{"x":1,"y":2},"z":"é\\r\\n"}')
  assert.match(recordFingerprint(left), /^[0-9a-f]{16}$/u)
  assert.equal(recordFingerprint(left), recordFingerprint(right))
  assert.notEqual(recordFingerprint(left), recordFingerprint({ ...right, z: 'é\r\n' }))
})

test('the registry explicitly classifies exported, private, derived, and absent classes', () => {
  assert.equal(PUBLIC_SNAPSHOT_FORMAT_VERSION, 2)
  const classes = new Map(PUBLIC_SNAPSHOT_CLASS_REGISTRY.map(entry => [entry.class_name, entry]))
  for (const name of [
    'residents', 'public_presence', 'places', 'things', 'notes', 'traits', 'kinds',
    'agreements', 'events', 'moderation', 'drawing_revisions', 'treasury_fees',
    'world_market_offers',
    'gazette_issues', 'gazette_issue_entries', 'gazette_withdrawals', 'official', 'physics',
  ]) assert.equal(classes.get(name)?.disposition, 'exported', name)
  for (const name of [
    'credentials', 'oauth', 'resident_private_state', 'private_flags', 'payment_attempts',
    'city_fee_credit', 'later_holder_marks', 'reader_state',
  ]) assert.equal(classes.get(name)?.disposition, 'not_public', name)
  for (const name of ['window', 'map', 'search', 'changes', 'names_directory', 'counters']) {
    assert.equal(classes.get(name)?.disposition, 'not_exported', name)
  }
  assert.deepEqual(classes.get('world_market_offers')?.database_sources, [
    'transfer_offers', 'things', 'residents', 'sale_payments', 'moderation_actions',
  ])
  assert.deepEqual(classes.get('drawing_revisions')?.database_sources, [
    'drawing_revisions', 'residents', 'places', 'things', 'kinds', 'moderation_actions',
  ])
  assert.deepEqual(classes.get('events')?.database_sources, ['events', 'gazette_issues'])
  assert.deepEqual(classes.get('gazette_issues')?.database_sources, ['gazette_issues'])
  assert.deepEqual(classes.get('gazette_issue_entries')?.database_sources, [
    'gazette_issue_entries', 'gazette_withdrawals', 'notes', 'residents',
  ])
  assert.deepEqual(classes.get('gazette_withdrawals')?.database_sources, [
    'gazette_withdrawals', 'notes', 'residents',
  ])
  assert.deepEqual(classes.get('resident_private_state')?.database_sources, [
    'resident_presence.home_place_id',
    'residents.quota_day',
    'residents.things_today',
    'residents.notes_today',
    'residents.agreement_actions_today',
    'resident_refusal_state',
  ])
  assert.equal(classes.get('corrections')?.disposition, 'never_existed')
})

test('the public format docs list one artifact for every exported class', async () => {
  const docs = await readFile(new URL('../docs/PUBLIC_SNAPSHOTS.md', import.meta.url), 'utf8')
  const artifactLayout = docs.match(/## Artifact layout[\s\S]*?```text\r?\n([\s\S]*?)```/u)?.[1]
  assert.ok(artifactLayout)
  const documentedFiles = [...artifactLayout.matchAll(/\b([a-z_]+\.ndjson|manifest\.json)\b/gu)]
    .map(match => match[1]!)
    .sort()
  const exportedFiles = PUBLIC_SNAPSHOT_CLASS_REGISTRY
    .filter(entry => entry.disposition === 'exported')
    .map(entry => `${entry.class_name}.ndjson`)
  assert.deepEqual(documentedFiles, [...exportedFiles, 'manifest.json'].sort())
})

test('snapshot bundles are deterministic, split by class, and verify offline', async () => {
  const root = await mkdtemp(join(tmpdir(), '1f3d9-snapshot-format-'))
  try {
    const first = await createSnapshotBundle({
      outputDirectory: join(root, 'first'),
      exportedAt: '2026-08-23T12:34:56.000Z',
      sourceCommit: 'a'.repeat(40),
      records: RECORDS,
    })
    const second = await createSnapshotBundle({
      outputDirectory: join(root, 'second'),
      exportedAt: '2026-08-23T12:34:56.000Z',
      sourceCommit: 'a'.repeat(40),
      records: [...RECORDS].reverse(),
    })
    assert.equal(first.city_root_sha256, second.city_root_sha256)
    assert.match(first.city_root_sha256, /^[0-9a-f]{64}$/u)
    assert.equal(first.tag, 'city-snapshot-v2-20260823T123456Z')
    const exportedClasses = PUBLIC_SNAPSHOT_CLASS_REGISTRY
      .filter(entry => entry.disposition === 'exported')
      .map(entry => entry.class_name)
      .sort()
    assert.deepEqual(first.files.map(file => file.path), [
      ...exportedClasses.map(className => `${className}.ndjson`),
      'manifest.json',
    ])
    assert.equal(first.files.every(file => /^[0-9a-f]{64}$/u.test(file.sha256)), true)

    const noteBytes = await readFile(join(root, 'first', 'notes.ndjson'))
    const noteLine = JSON.parse(noteBytes.toString('utf8')) as {
      fingerprint: string
      record: { body: string }
    }
    assert.match(noteLine.fingerprint, /^[0-9a-f]{16}$/u)
    assert.equal(noteLine.record.body, 'e\u0301 stays decomposed\r\nsecond line\nthird line')
    assert.equal(Buffer.from(noteLine.record.body).equals(
      Buffer.from('e\u0301 stays decomposed\r\nsecond line\nthird line'),
    ), true)

    const verified = await verifySnapshotDirectory(join(root, 'first'))
    assert.equal(verified.city_root_sha256, first.city_root_sha256)
    assert.deepEqual(verified.counts, Object.fromEntries(
      exportedClasses.map(className => [
        className,
        className === 'notes' ? 1 : className === 'residents' ? 2 : 0,
      ]),
    ))
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('zero-record classes use one LF byte so release hosts can carry them', async () => {
  const root = await mkdtemp(join(tmpdir(), '1f3d9-snapshot-empty-class-'))
  try {
    const bundle = await createSnapshotBundle({
      outputDirectory: root,
      exportedAt: '2026-08-23T12:34:56.000Z',
      sourceCommit: 'd'.repeat(40),
      records: RECORDS,
    })
    assert.equal(await readFile(join(root, 'moderation.ndjson'), 'utf8'), '\n')
    assert.equal(bundle.files.every(file => file.bytes > 0), true)
    const verified = await verifySnapshotDirectory(root)
    assert.equal(verified.counts.moderation, 0)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('the offline verifier rejects changed records, file hashes, counts, and credential-shaped output', async () => {
  const root = await mkdtemp(join(tmpdir(), '1f3d9-snapshot-reject-'))
  try {
    const output = join(root, 'snapshot')
    await createSnapshotBundle({
      outputDirectory: output,
      exportedAt: '2026-08-23T12:34:56.000Z',
      sourceCommit: 'b'.repeat(40),
      records: RECORDS,
    })
    const notePath = join(output, 'notes.ndjson')
    const changed = (await readFile(notePath, 'utf8')).replace('third line', 'changed')
    await writeFile(notePath, changed, 'utf8')
    await assert.rejects(() => verifySnapshotDirectory(output), /hash|fingerprint|root/iu)

    await assert.rejects(() => createSnapshotBundle({
      outputDirectory: join(root, 'credential'),
      exportedAt: '2026-08-23T12:34:56.000Z',
      sourceCommit: 'c'.repeat(40),
      records: [{
        class_name: 'notes',
        record_id: '1',
        sort_key: '1',
        payload: { id: 1, status: 'exported', body: `do not export 1f3d9_sk_${'ab'.repeat(24)}` },
      }],
    }), /credential/iu)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})
