import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  PUBLIC_SNAPSHOT_CLASS_REGISTRY,
  PUBLIC_SNAPSHOT_FORMAT_NAME,
  PUBLIC_SNAPSHOT_FORMAT_VERSION,
  canonicalJson,
  createSnapshotBundle,
  recordFingerprint,
  verifySnapshotDirectory,
  type PublicSnapshotRecord,
} from '../src/public-snapshot-format.ts'

const EXPORTED_CLASSES = PUBLIC_SNAPSHOT_CLASS_REGISTRY
  .filter(entry => entry.disposition === 'exported')
  .map(entry => entry.class_name)
  .sort()
const EXPORTED_AT = '2026-08-23T12:34:56.000Z'
const SOURCE_COMMIT = 'a'.repeat(40)

const note = (id: string, sortKey = id): PublicSnapshotRecord => ({
  class_name: 'notes',
  record_id: id,
  sort_key: sortKey,
  payload: { id, status: 'exported', body: `note ${id}` },
})

async function createBaseline(root: string, name: string, records = [note('1')]): Promise<string> {
  const directory = join(root, name)
  await createSnapshotBundle({
    outputDirectory: directory,
    exportedAt: EXPORTED_AT,
    sourceCommit: SOURCE_COMMIT,
    records,
  })
  return directory
}

type MutableManifest = {
  format: unknown
  format_version: unknown
  snapshot_kind: unknown
  exported_at: unknown
  source_commit: unknown
  counts: Record<string, number>
  files: Array<{
    class_name: string
    path: string
    records: number
    bytes: number
    sha256: string
  }>
  class_registry: Array<Record<string, unknown>>
}

async function readManifest(directory: string): Promise<MutableManifest> {
  return JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as MutableManifest
}

async function writeManifest(directory: string, manifest: MutableManifest): Promise<void> {
  await writeFile(join(directory, 'manifest.json'), `${canonicalJson(manifest)}\n`, 'utf8')
}

async function replaceClassFile(
  directory: string,
  className: string,
  text: string,
  records: number,
): Promise<void> {
  const path = join(directory, `${className}.ndjson`)
  const bytes = Buffer.from(text, 'utf8')
  await writeFile(path, bytes)
  const manifest = await readManifest(directory)
  const entry = manifest.files.find(file => file.class_name === className)
  assert.ok(entry)
  entry.bytes = bytes.byteLength
  entry.sha256 = createHash('sha256').update(bytes).digest('hex')
  entry.records = records
  manifest.counts[className] = records
  await writeManifest(directory, manifest)
}

function envelope(record: Record<string, unknown>): string {
  return canonicalJson({ fingerprint: recordFingerprint(record), record })
}

test('canonical snapshot JSON rejects executable, lossy, and accessor-backed values', () => {
  assert.equal(canonicalJson(-0), '0')
  assert.equal(canonicalJson(Object.assign(Object.create(null), { b: 2, a: 1 })), '{"a":1,"b":2}')
  assert.equal(canonicalJson([true, null, 'text', 3]), '[true,null,"text",3]')

  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => canonicalJson(value), /non-finite number/iu)
  }
  for (const value of [undefined, 1n, Symbol('unsafe'), () => undefined]) {
    assert.throws(() => canonicalJson(value), /canonical JSON data/iu)
  }
  assert.throws(() => canonicalJson(new Date()), /plain JSON object/iu)

  const symbolKey = { ordinary: true } as Record<PropertyKey, unknown>
  symbolKey[Symbol('hidden')] = true
  assert.throws(() => canonicalJson(symbolKey), /non-string key/iu)

  const hidden = {}
  Object.defineProperty(hidden, 'value', { enumerable: false, value: 1 })
  assert.throws(() => canonicalJson(hidden), /plain enumerable data/iu)

  const accessor = {}
  Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 1 })
  assert.throws(() => canonicalJson(accessor), /plain enumerable data/iu)
})

test('snapshot creation rejects every ambiguous identity and ordering boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), '1f3d9-snapshot-create-boundaries-'))
  try {
    const invalid: ReadonlyArray<Readonly<{
      name: string
      exportedAt?: string
      sourceCommit?: string
      records?: readonly PublicSnapshotRecord[]
      message: RegExp
    }>> = [
      { name: 'commit', sourceCommit: 'A'.repeat(40), message: /sourceCommit/iu },
      { name: 'time-shape', exportedAt: '2026-08-23T12:34:56Z', message: /timestamp/iu },
      { name: 'time-value', exportedAt: '2026-99-99T99:99:99.999Z', message: /timestamp/iu },
      { name: 'class-shape', records: [{ ...note('1'), class_name: 'Bad' }], message: /class/iu },
      { name: 'class-private', records: [{ ...note('1'), class_name: 'credentials' }], message: /class/iu },
      { name: 'record-id', records: [note('bad id')], message: /record_id/iu },
      { name: 'sort-key-negative', records: [note('1', '-1')], message: /sort_key/iu },
      { name: 'sort-key-leading-zero', records: [note('1', '01')], message: /sort_key/iu },
      { name: 'payload-id', records: [{ ...note('1'), payload: { id: 2 } }], message: /does not match/iu },
      { name: 'payload-id-missing', records: [{ ...note('1'), payload: {} }], message: /does not match/iu },
      { name: 'duplicate', records: [note('1'), note('1')], message: /duplicate/iu },
    ]

    for (const entry of invalid) {
      await assert.rejects(() => createSnapshotBundle({
        outputDirectory: join(root, entry.name),
        exportedAt: entry.exportedAt ?? EXPORTED_AT,
        sourceCommit: entry.sourceCommit ?? SOURCE_COMMIT,
        records: entry.records ?? [],
      }), entry.message)
    }

    const occupied = join(root, 'occupied')
    await mkdir(occupied)
    await writeFile(join(occupied, 'already-here'), 'x')
    await assert.rejects(() => createSnapshotBundle({
      outputDirectory: occupied,
      exportedAt: EXPORTED_AT,
      sourceCommit: SOURCE_COMMIT,
      records: [],
    }), /must be empty/iu)

    const sorted = await createBaseline(root, 'sorted', [
      note('20', '2'),
      note('10', '2'),
      note('30', '10'),
    ])
    const ids = (await readFile(join(sorted, 'notes.ndjson'), 'utf8')).trim().split('\n')
      .map(line => String((JSON.parse(line) as { record: { id: unknown } }).record.id))
    assert.deepEqual(ids, ['10', '20', '30'])
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('snapshot manifests reject malformed, incomplete, and noncanonical declarations', async () => {
  const root = await mkdtemp(join(tmpdir(), '1f3d9-snapshot-manifest-boundaries-'))
  try {
    const baseline = await createBaseline(root, 'baseline')
    const invalidJson = join(root, 'invalid-json')
    await cp(baseline, invalidJson, { recursive: true })
    await writeFile(join(invalidJson, 'manifest.json'), '{not json}\n')
    await assert.rejects(() => verifySnapshotDirectory(invalidJson), /valid JSON/iu)

    const mutations: ReadonlyArray<Readonly<{
      name: string
      change: (manifest: MutableManifest) => void
      message: RegExp
    }>> = [
      { name: 'format', change: manifest => { manifest.format = 'other' }, message: /shape/iu },
      { name: 'version', change: manifest => { manifest.format_version = 2 }, message: /shape/iu },
      { name: 'kind', change: manifest => { manifest.snapshot_kind = 'erratum' }, message: /shape/iu },
      { name: 'time', change: manifest => { manifest.exported_at = 'yesterday' }, message: /shape/iu },
      { name: 'commit', change: manifest => { manifest.source_commit = 'short' }, message: /shape/iu },
      { name: 'counts-null', change: manifest => { manifest.counts = null as never }, message: /shape/iu },
      { name: 'counts-array', change: manifest => { manifest.counts = [] as never }, message: /shape/iu },
      { name: 'files', change: manifest => { manifest.files = null as never }, message: /shape/iu },
      { name: 'registry', change: manifest => { manifest.class_registry = null as never }, message: /shape/iu },
    ]

    for (const entry of mutations) {
      const directory = join(root, entry.name)
      await cp(baseline, directory, { recursive: true })
      const manifest = await readManifest(directory)
      entry.change(manifest)
      await writeManifest(directory, manifest)
      await assert.rejects(() => verifySnapshotDirectory(directory), entry.message)
    }

    const nonObject = join(root, 'not-object')
    await cp(baseline, nonObject, { recursive: true })
    await writeFile(join(nonObject, 'manifest.json'), '[]\n')
    await assert.rejects(() => verifySnapshotDirectory(nonObject), /not an object/iu)

    const pretty = join(root, 'pretty')
    await cp(baseline, pretty, { recursive: true })
    await writeFile(join(pretty, 'manifest.json'), `${JSON.stringify(await readManifest(pretty), null, 2)}\n`)
    await assert.rejects(() => verifySnapshotDirectory(pretty), /canonical/iu)

    const registry = join(root, 'changed-registry')
    await cp(baseline, registry, { recursive: true })
    const registryManifest = await readManifest(registry)
    registryManifest.class_registry[0]!.reason = 'changed'
    await writeManifest(registry, registryManifest)
    await assert.rejects(() => verifySnapshotDirectory(registry), /class registry/iu)

    for (const [name, change] of [
      ['missing-class', (manifest: MutableManifest) => { manifest.files = manifest.files.slice(1) }],
      ['missing-count', (manifest: MutableManifest) => { delete manifest.counts[EXPORTED_CLASSES[0]!] }],
    ] as const) {
      const directory = join(root, name)
      await cp(baseline, directory, { recursive: true })
      const manifest = await readManifest(directory)
      change(manifest)
      await writeManifest(directory, manifest)
      await assert.rejects(() => verifySnapshotDirectory(directory), /every exported class/iu)
    }

    const unexpected = join(root, 'unexpected-file')
    await cp(baseline, unexpected, { recursive: true })
    await writeFile(join(unexpected, 'extra.txt'), 'extra')
    await assert.rejects(() => verifySnapshotDirectory(unexpected), /missing or unexpected/iu)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('snapshot record files reject truncation, bad JSON, bad fingerprints, and unstable ids', async () => {
  const root = await mkdtemp(join(tmpdir(), '1f3d9-snapshot-record-boundaries-'))
  try {
    const baseline = await createBaseline(root, 'baseline')
    const cases: ReadonlyArray<Readonly<{
      name: string
      text: string
      records: number
      message: RegExp
    }>> = [
      { name: 'missing-lf', text: envelope({ id: '1', status: 'exported', body: 'note 1' }), records: 1, message: /end with LF/iu },
      { name: 'count', text: '', records: 1, message: /record count/iu },
      { name: 'invalid-json', text: '{bad}\n', records: 1, message: /invalid JSON/iu },
      { name: 'array-envelope', text: '[]\n', records: 1, message: /invalid record envelope/iu },
      { name: 'fingerprint-type', text: `${canonicalJson({ fingerprint: 1, record: { id: '1' } })}\n`, records: 1, message: /fingerprint/iu },
      { name: 'fingerprint-shape', text: `${canonicalJson({ fingerprint: 'abc', record: { id: '1' } })}\n`, records: 1, message: /fingerprint/iu },
      { name: 'fingerprint-value', text: `${canonicalJson({ fingerprint: '0'.repeat(16), record: { id: '1' } })}\n`, records: 1, message: /fingerprint/iu },
      { name: 'missing-id', text: `${envelope({ body: 'missing id' })}\n`, records: 1, message: /stable id/iu },
      { name: 'duplicate-id', text: `${envelope({ id: '1' })}\n${envelope({ id: '1', body: 'again' })}\n`, records: 2, message: /stable id/iu },
      { name: 'numeric-order', text: `${envelope({ id: '10' })}\n${envelope({ id: '2' })}\n`, records: 2, message: /stable id order/iu },
      { name: 'text-order', text: `${envelope({ id: 'b' })}\n${envelope({ id: 'a' })}\n`, records: 2, message: /stable id order/iu },
    ]

    for (const entry of cases) {
      const directory = join(root, entry.name)
      await cp(baseline, directory, { recursive: true })
      await replaceClassFile(directory, 'notes', entry.text, entry.records)
      await assert.rejects(() => verifySnapshotDirectory(directory), entry.message)
    }

    const invalidEntry = join(root, 'invalid-file-entry')
    await cp(baseline, invalidEntry, { recursive: true })
    const manifest = await readManifest(invalidEntry)
    manifest.files.find(file => file.class_name === 'notes')!.records = -1
    await writeManifest(invalidEntry, manifest)
    await assert.rejects(() => verifySnapshotDirectory(invalidEntry), /invalid file entry/iu)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('snapshot constants remain explicit and versioned', () => {
  assert.equal(PUBLIC_SNAPSHOT_FORMAT_NAME, '1f3d9-public-snapshot')
  assert.equal(PUBLIC_SNAPSHOT_FORMAT_VERSION, 1)
})
