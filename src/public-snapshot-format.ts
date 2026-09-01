import { createHash } from 'node:crypto'
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { containsPublicCredential } from './credential-safety.ts'

export const PUBLIC_SNAPSHOT_FORMAT_VERSION = 2 as const
export const PUBLIC_SNAPSHOT_FORMAT_NAME = '1f3d9-public-snapshot' as const

export type SnapshotClassDisposition =
  | 'exported'
  | 'not_public'
  | 'not_exported'
  | 'never_existed'

export type SnapshotClassRegistryEntry = Readonly<{
  class_name: string
  disposition: SnapshotClassDisposition
  reason: string
  database_sources: readonly string[]
}>

/**
 * Version 2 is a closed registry. A new public or private class must be named
 * here before a later exporter can describe it. The database view remains an
 * independent explicit-column allowlist, so a new table or column is never
 * included merely because it exists. Published version-1 bundles remain
 * immutable and verify with the source commit recorded in their manifest.
 */
export const PUBLIC_SNAPSHOT_CLASS_REGISTRY: readonly SnapshotClassRegistryEntry[] =
  Object.freeze(([
    { class_name: 'residents', disposition: 'exported', reason: 'anonymous public identity', database_sources: ['residents', 'resident_id_allocator'] },
    { class_name: 'public_presence', disposition: 'exported', reason: 'anonymous current-place and asleep display facts', database_sources: ['residents', 'resident_presence', 'events'] },
    { class_name: 'places', disposition: 'exported', reason: 'anonymous public land, orientation, labels, and effective laws', database_sources: ['places', 'active_labels', 'place_law_changes', 'traits', 'things', 'moderation_actions'] },
    { class_name: 'things', disposition: 'exported', reason: 'active public things plus body-free withdrawn, hidden, and gap markers', database_sources: ['things', 'residents', 'kinds', 'moderation_actions'] },
    { class_name: 'notes', disposition: 'exported', reason: 'public speech plus legacy-body, hidden, and gap markers', database_sources: ['notes', 'residents', 'moderation_actions'] },
    { class_name: 'traits', disposition: 'exported', reason: 'current public trait vocabulary plus hidden and gap markers', database_sources: ['traits', 'residents', 'moderation_actions'] },
    { class_name: 'kinds', disposition: 'exported', reason: 'current public kind definitions plus hidden and gap markers', database_sources: ['kinds', 'kind_revisions', 'residents', 'moderation_actions'] },
    { class_name: 'agreements', disposition: 'exported', reason: 'public agreements, parties, openings, and signatures', database_sources: ['agreements', 'agreement_parties', 'agreement_accession_openings', 'agreement_signatures', 'residents', 'moderation_actions'] },
    { class_name: 'events', disposition: 'exported', reason: 'append-only approved public event headings and safe references plus body-free private-or-gap markers', database_sources: ['events', 'gazette_issues'] },
    { class_name: 'moderation', disposition: 'exported', reason: 'append-only public moderation history', database_sources: ['moderation_actions', 'residents'] },
    { class_name: 'drawing_revisions', disposition: 'exported', reason: 'deliberately fetched immutable owner-authored drawing history with parent moderation', database_sources: ['drawing_revisions', 'residents', 'places', 'things', 'kinds', 'moderation_actions'] },
    { class_name: 'treasury_fees', disposition: 'exported', reason: 'public city-fee books', database_sources: ['fees', 'residents'] },
    { class_name: 'world_market_offers', disposition: 'exported', reason: 'public world-aisle locks and receipts only', database_sources: ['transfer_offers', 'things', 'residents', 'sale_payments', 'moderation_actions'] },
    { class_name: 'gazette_issues', disposition: 'exported', reason: 'permanent public Gazette issue ledger', database_sources: ['gazette_issues'] },
    { class_name: 'gazette_issue_entries', disposition: 'exported', reason: 'permanent issue membership with public source-note identity and conditional body-free withdrawal facts', database_sources: ['gazette_issue_entries', 'gazette_withdrawals', 'notes', 'residents'] },
    { class_name: 'gazette_withdrawals', disposition: 'exported', reason: 'body-free author withdrawal record for a permanent Gazette submission', database_sources: ['gazette_withdrawals', 'notes', 'residents'] },
    { class_name: 'official', disposition: 'exported', reason: 'versioned canonical city facts supplied by the exporter', database_sources: [] },
    { class_name: 'physics', disposition: 'exported', reason: 'versioned frozen actions, effect bricks, and ceilings supplied by the exporter', database_sources: [] },
    { class_name: 'credentials', disposition: 'not_public', reason: 'resident secrets, hashes, registration, rotation, and recovery material are private', database_sources: ['residents.secret_hash', 'pending_resident_registrations', 'pending_resident_registration_recovery_codes', 'resident_recovery_codes', 'resident_key_rotations'] },
    { class_name: 'oauth', disposition: 'not_public', reason: 'hosted sign-in requests, codes, tokens, families, and limits are private', database_sources: ['oauth_authorization_requests', 'oauth_authorization_request_recovery_codes', 'oauth_authorization_codes', 'oauth_token_families', 'oauth_tokens', 'oauth_rate_limits'] },
    { class_name: 'infrastructure_limits', disposition: 'not_public', reason: 'IP hashes and identity, flag, or drawing rate-limit rows are private operations data', database_sources: ['reg_log', 'identity_rate_limits', 'anonymous_flag_limits', 'resident_drawing_rate_limits'] },
    { class_name: 'resident_private_state', disposition: 'not_public', reason: 'home location, personal quota state, and repeated-refusal state stay private to the resident', database_sources: ['resident_presence.home_place_id', 'residents.quota_day', 'residents.things_today', 'residents.notes_today', 'residents.agreement_actions_today', 'resident_refusal_state'] },
    { class_name: 'private_flags', disposition: 'not_public', reason: 'flag report bodies stay private; their safe public event references remain in events', database_sources: ['flags'] },
    { class_name: 'payment_attempts', disposition: 'not_public', reason: 'attempt request bodies, leases, and recovery state are private', database_sources: ['payment_attempts', 'payment_uses'] },
    { class_name: 'private_direct_offers', disposition: 'not_public', reason: 'direct transfer offers are visible only to their participants; world offers are a separate public class', database_sources: ['transfer_offers[channel=direct]'] },
    { class_name: 'city_fee_credit', disposition: 'not_public', reason: 'balances and append-only credit histories are private resident accounting', database_sources: ['city_credit_accounts', 'city_credit_entries'] },
    { class_name: 'later_holder_marks', disposition: 'not_public', reason: 'deliberate later-holder navigation is private', database_sources: ['thing_later_holder_marks'] },
    { class_name: 'reader_state', disposition: 'not_public', reason: 'the private last-me credit marker is not a public read receipt, opened state, or event', database_sources: ['city_credit_last_me_reads'] },
    { class_name: 'action_runtime', disposition: 'not_exported', reason: 'runtime action, block, timer, and resolution rows are represented by exported public events and current records', database_sources: ['active_blocks', 'action_runs', 'action_resolutions', 'pending_effects', 'effect_resolutions'] },
    { class_name: 'historical_property_transfers', disposition: 'not_exported', reason: 'transfer and sale-payment tables are rebuildable from current public property and exported event records in format v2', database_sources: ['transfers', 'sale_payments'] },
    { class_name: 'reading_counters', disposition: 'not_exported', reason: 'derived byte and item counters can be reproduced from exported records', database_sources: ['place_reading_totals'] },
    { class_name: 'change_markers', disposition: 'not_exported', reason: 'derived cursor state can be rebuilt from exported events', database_sources: ['public_change_state', 'public_change_log'] },
    { class_name: 'window', disposition: 'not_exported', reason: 'derived bounded human presentation', database_sources: [] },
    { class_name: 'map', disposition: 'not_exported', reason: 'derived hierarchy presentation', database_sources: [] },
    { class_name: 'search', disposition: 'not_exported', reason: 'derived discovery surface', database_sources: [] },
    { class_name: 'changes', disposition: 'not_exported', reason: 'derived event cursor surface', database_sources: [] },
    { class_name: 'names_directory', disposition: 'not_exported', reason: 'derived from exported resident and place identities', database_sources: [] },
    { class_name: 'counters', disposition: 'not_exported', reason: 'derived from exported records', database_sources: [] },
    { class_name: 'corrections', disposition: 'never_existed', reason: 'format v2 never edits original records; release errata are separate assets and releases', database_sources: [] },
  ] satisfies readonly SnapshotClassRegistryEntry[]).map(entry => Object.freeze({
    ...entry,
    database_sources: Object.freeze([...entry.database_sources]),
  })))

const EXPORTED_CLASSES = new Set(
  PUBLIC_SNAPSHOT_CLASS_REGISTRY
    .filter(entry => entry.disposition === 'exported')
    .map(entry => entry.class_name),
)
const EXPORTED_CLASS_NAMES = Object.freeze([...EXPORTED_CLASSES].sort())
const SHA256_RE = /^[0-9a-f]{64}$/u
const COMMIT_RE = /^[0-9a-f]{40}$/u
const CLASS_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/u
const RECORD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u
const INTEGER_RE = /^(?:0|[1-9][0-9]*)$/u
const SNAPSHOT_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
export const PUBLIC_SNAPSHOT_DELIBERATELY_OMITTED_LIVE_DETAIL_FIELDS = Object.freeze({
  events: Object.freeze([
    'acceded',
    'accession_open',
    'attempt_id',
    'birth_revision',
    'buyer',
    'current_revision',
    'error',
    'fee_tx_hash',
    'from',
    'from_id',
    'frontier',
    'gazette_submission_room_opened',
    'gazette_withdrawals_opened',
    'ingredient_ids',
    'market_checkout_id',
    'market_draft_id',
    'market_listing_id',
    'mechanical',
    'model',
    'moderated',
    'moderation',
    'name',
    'outcome',
    'output_thing_id',
    'parties',
    'payment_status',
    'place_name',
    'price_usdc',
    'reason',
    'repair_key',
    'revision',
    'source_place_id',
    'source_status',
    'to',
    'to_id',
    'trait',
    'traits',
    'transaction',
    'tx_hash',
  ]),
})

function snapshotDocumentationUrl(sourceCommit: string): string {
  return `https://github.com/onetapstudiogames/1f3d9/blob/${sourceCommit}/docs/PUBLIC_SNAPSHOTS.md`
}

export type PublicSnapshotRecord = Readonly<{
  class_name: string
  record_id: string
  sort_key: string
  payload: Readonly<Record<string, unknown>>
}>

export type SnapshotFile = Readonly<{
  path: string
  sha256: string
  bytes: number
  records?: number
  class_name?: string
}>

export type SnapshotBundle = Readonly<{
  format_version: typeof PUBLIC_SNAPSHOT_FORMAT_VERSION
  tag: string
  exported_at: string
  city_root_sha256: string
  counts: Readonly<Record<string, number>>
  files: readonly SnapshotFile[]
}>

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }

function canonicalValue(value: unknown, path = '$'): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`)
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalValue(item, `${path}[${index}]`))
  if (typeof value !== 'object') throw new TypeError(`${path} is not canonical JSON data`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} is not a plain JSON object`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) {
    throw new TypeError(`${path} contains a non-string key`)
  }
  const result: Record<string, JsonValue> = {}
  for (const key of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[key]!
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${path}.${key} is not plain enumerable data`)
    }
    result[key] = canonicalValue(descriptor.value, `${path}.${key}`)
  }
  return result
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function recordFingerprint(record: unknown): string {
  return sha256(Buffer.from(canonicalJson(record), 'utf8')).slice(0, 16)
}

function assertNoCredential(value: string, label: string): void {
  if (containsPublicCredential(value)) {
    throw new Error(`${label} contains credential-shaped output; snapshot aborted`)
  }
}

function tagFor(exportedAt: string): string {
  if (!SNAPSHOT_TIME_RE.test(exportedAt) || Number.isNaN(Date.parse(exportedAt))) {
    throw new TypeError('exportedAt must be an exact UTC timestamp with milliseconds')
  }
  return `city-snapshot-v${PUBLIC_SNAPSHOT_FORMAT_VERSION}-${exportedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}`
}

function compareRecord(left: PublicSnapshotRecord, right: PublicSnapshotRecord): number {
  if (INTEGER_RE.test(left.sort_key) && INTEGER_RE.test(right.sort_key)) {
    const difference = BigInt(left.sort_key) - BigInt(right.sort_key)
    if (difference !== 0n) return difference < 0n ? -1 : 1
  } else {
    if (left.sort_key !== right.sort_key) return left.sort_key < right.sort_key ? -1 : 1
  }
  return left.record_id === right.record_id ? 0 : left.record_id < right.record_id ? -1 : 1
}

async function prepareOutputDirectory(outputDirectory: string): Promise<void> {
  await mkdir(outputDirectory, { recursive: true })
  const entries = await readdir(outputDirectory)
  if (entries.length !== 0) throw new Error('snapshot output directory must be empty')
}

async function writeExactFile(root: string, path: string, bytes: Buffer): Promise<SnapshotFile> {
  const destination = resolve(root, path)
  const rootPrefix = `${resolve(root)}${sep}`
  if (!destination.startsWith(rootPrefix)) throw new Error('snapshot file escaped the output directory')
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, bytes, { flag: 'wx' })
  return Object.freeze({ path, sha256: sha256(bytes), bytes: bytes.byteLength })
}

export async function createSnapshotBundle(input: Readonly<{
  outputDirectory: string
  exportedAt: string
  sourceCommit: string
  records: readonly PublicSnapshotRecord[]
}>): Promise<SnapshotBundle> {
  if (!COMMIT_RE.test(input.sourceCommit)) throw new TypeError('sourceCommit must be a full lowercase Git commit')
  const tag = tagFor(input.exportedAt)

  const grouped = new Map<string, PublicSnapshotRecord[]>(
    EXPORTED_CLASS_NAMES.map(className => [className, []]),
  )
  for (const record of input.records) {
    if (!CLASS_NAME_RE.test(record.class_name) || !EXPORTED_CLASSES.has(record.class_name)) {
      throw new TypeError(
        `snapshot class is not exported in format v${PUBLIC_SNAPSHOT_FORMAT_VERSION}: ${record.class_name}`,
      )
    }
    if (!RECORD_ID_RE.test(record.record_id)) throw new TypeError('snapshot record_id is invalid')
    if (!INTEGER_RE.test(record.sort_key)) throw new TypeError('snapshot sort_key must be a nonnegative decimal integer')
    if (String(record.payload.id ?? '') !== record.record_id) {
      throw new TypeError(`${record.class_name} record payload id does not match record_id`)
    }
    const items = grouped.get(record.class_name) ?? []
    items.push(record)
    grouped.set(record.class_name, items)
  }

  const files: SnapshotFile[] = []
  const fileBytes = new Map<string, Buffer>()
  const counts: Record<string, number> = {}
  for (const className of EXPORTED_CLASS_NAMES) {
    const records = [...grouped.get(className)!].sort(compareRecord)
    const seen = new Set<string>()
    const lines = records.map(record => {
      if (seen.has(record.record_id)) throw new Error(`duplicate ${className} record id ${record.record_id}`)
      seen.add(record.record_id)
      const recordJson = canonicalJson(record.payload)
      assertNoCredential(recordJson, `${className} ${record.record_id}`)
      return canonicalJson({
        fingerprint: recordFingerprint(record.payload),
        record: record.payload,
      })
    })
    const path = `${className}.ndjson`
    const bytes = Buffer.from(`${lines.join('\n')}\n`, 'utf8')
    fileBytes.set(path, bytes)
    counts[className] = records.length
    files.push(Object.freeze({
      path,
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
      class_name: className,
      records: records.length,
    }))
  }

  const manifest = Object.freeze({
    format: PUBLIC_SNAPSHOT_FORMAT_NAME,
    format_version: PUBLIC_SNAPSHOT_FORMAT_VERSION,
    snapshot_kind: 'original',
    exported_at: input.exportedAt,
    source_commit: input.sourceCommit,
    counts: Object.freeze({ ...counts }),
    files: Object.freeze(files.map(file => Object.freeze({
      class_name: file.class_name,
      path: file.path,
      records: file.records,
      bytes: file.bytes,
      sha256: file.sha256,
    }))),
    class_registry: PUBLIC_SNAPSHOT_CLASS_REGISTRY,
    deliberately_omitted_live_detail_fields:
      PUBLIC_SNAPSHOT_DELIBERATELY_OMITTED_LIVE_DETAIL_FIELDS,
    documentation_url: snapshotDocumentationUrl(input.sourceCommit),
    record_fingerprint: 'first 16 lowercase hexadecimal characters of SHA-256(canonical record JSON UTF-8 bytes)',
    file_hash: 'SHA-256 of the exact file bytes',
    city_root: 'SHA-256 of the exact canonical manifest.json bytes; this is also the full manifest file hash',
    canonical_json: 'UTF-8 JSON with recursively lexicographically sorted object keys, unchanged string code points, and LF record separators',
    corrections: 'Original files are immutable. Corrections are separate append-only errata and never replace this snapshot.',
  })
  const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8')
  assertNoCredential(manifestBytes.toString('utf8'), 'snapshot manifest')

  await prepareOutputDirectory(input.outputDirectory)
  for (const file of files) {
    await writeExactFile(input.outputDirectory, file.path, fileBytes.get(file.path)!)
  }
  const manifestFile = await writeExactFile(input.outputDirectory, 'manifest.json', manifestBytes)
  const cityRoot = manifestFile.sha256

  return Object.freeze({
    format_version: PUBLIC_SNAPSHOT_FORMAT_VERSION,
    tag,
    exported_at: input.exportedAt,
    city_root_sha256: cityRoot,
    counts: Object.freeze({ ...counts }),
    files: Object.freeze([...files, manifestFile]),
  })
}

type SnapshotManifest = Readonly<{
  format: string
  format_version: number
  snapshot_kind: string
  exported_at: string
  source_commit: string
  counts: Readonly<Record<string, number>>
  files: readonly Readonly<{
    class_name: string
    path: string
    records: number
    bytes: number
    sha256: string
  }>[]
  class_registry: readonly SnapshotClassRegistryEntry[]
  deliberately_omitted_live_detail_fields?: Readonly<Record<string, readonly string[]>>
  documentation_url?: string
}>

function manifestShape(value: unknown): SnapshotManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('manifest is not an object')
  const manifest = value as Partial<SnapshotManifest>
  if (
    manifest.format !== PUBLIC_SNAPSHOT_FORMAT_NAME ||
    manifest.format_version !== PUBLIC_SNAPSHOT_FORMAT_VERSION ||
    manifest.snapshot_kind !== 'original' ||
    !SNAPSHOT_TIME_RE.test(String(manifest.exported_at)) ||
    !COMMIT_RE.test(String(manifest.source_commit)) ||
    !manifest.counts || typeof manifest.counts !== 'object' || Array.isArray(manifest.counts) ||
    !Array.isArray(manifest.files) || !Array.isArray(manifest.class_registry)
  ) throw new Error(`manifest has an invalid format v${PUBLIC_SNAPSHOT_FORMAT_VERSION} shape`)
  const hasOmissionDisclosure = Object.hasOwn(
    manifest,
    'deliberately_omitted_live_detail_fields',
  )
  const hasDocumentationPointer = Object.hasOwn(manifest, 'documentation_url')
  if (hasOmissionDisclosure !== hasDocumentationPointer) {
    throw new Error('manifest must pair its live-detail omission disclosure and documentation pointer')
  }
  if (hasOmissionDisclosure) {
    if (
      !manifest.deliberately_omitted_live_detail_fields ||
      typeof manifest.deliberately_omitted_live_detail_fields !== 'object' ||
      Array.isArray(manifest.deliberately_omitted_live_detail_fields) ||
      canonicalJson(manifest.deliberately_omitted_live_detail_fields) !==
        canonicalJson(PUBLIC_SNAPSHOT_DELIBERATELY_OMITTED_LIVE_DETAIL_FIELDS)
    ) throw new Error('manifest has a false live-detail omission disclosure')
    if (manifest.documentation_url !== snapshotDocumentationUrl(String(manifest.source_commit))) {
      throw new Error('manifest has an invalid public snapshot documentation pointer')
    }
  }
  return manifest as SnapshotManifest
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const output: string[] = []
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name)
    if (entry.isDirectory()) output.push(...await listFiles(root, absolute))
    else if (entry.isFile()) output.push(relative(root, absolute).split(sep).join('/'))
    else throw new Error('snapshot contains a non-file entry')
  }
  return output.sort()
}

export async function verifySnapshotDirectory(directory: string): Promise<SnapshotBundle> {
  const manifestBytes = await readFile(join(directory, 'manifest.json'))
  const manifestText = manifestBytes.toString('utf8')
  assertNoCredential(manifestText, 'snapshot manifest')
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestText)
  } catch {
    throw new Error('manifest is not valid JSON')
  }
  const manifest = manifestShape(parsed)
  if (`${canonicalJson(manifest)}\n` !== manifestText) throw new Error('manifest is not canonical JSON')
  if (canonicalJson(manifest.class_registry) !== canonicalJson(PUBLIC_SNAPSHOT_CLASS_REGISTRY)) {
    throw new Error(
      `manifest class registry does not match format v${PUBLIC_SNAPSHOT_FORMAT_VERSION}`,
    )
  }
  const manifestClasses = manifest.files.map(file => file.class_name)
  if (
    canonicalJson(manifestClasses) !== canonicalJson(EXPORTED_CLASS_NAMES) ||
    canonicalJson(Object.keys(manifest.counts).sort()) !== canonicalJson(EXPORTED_CLASS_NAMES)
  ) {
    throw new Error('manifest does not contain every exported class exactly once')
  }

  const expectedPaths = [...manifest.files.map(file => file.path), 'manifest.json'].sort()
  const actualPaths = await listFiles(directory)
  if (canonicalJson(expectedPaths) !== canonicalJson(actualPaths)) {
    throw new Error('snapshot contains a missing or unexpected file')
  }

  const counts: Record<string, number> = {}
  const verifiedFiles: SnapshotFile[] = []
  for (const file of manifest.files) {
    if (
      !CLASS_NAME_RE.test(file.class_name) ||
      file.path !== `${file.class_name}.ndjson` ||
      !Number.isSafeInteger(file.records) || file.records < 0 ||
      !Number.isSafeInteger(file.bytes) || file.bytes < 1 ||
      !SHA256_RE.test(file.sha256)
    ) throw new Error('manifest contains an invalid file entry')
    const bytes = await readFile(join(directory, file.path))
    assertNoCredential(bytes.toString('utf8'), file.path)
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
      throw new Error(`${file.path} hash or byte count does not match the manifest`)
    }
    const text = bytes.toString('utf8')
    if (!text.endsWith('\n')) throw new Error(`${file.path} must end with LF`)
    const lines = text === '\n' ? [] : text.slice(0, -1).split('\n')
    if (lines.length !== file.records || manifest.counts[file.class_name] !== lines.length) {
      throw new Error(`${file.path} record count does not match the manifest`)
    }
    let previousId: string | null = null
    for (const line of lines) {
      let envelope: unknown
      try {
        envelope = JSON.parse(line)
      } catch {
        throw new Error(`${file.path} contains invalid JSON`)
      }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
        throw new Error(`${file.path} contains an invalid record envelope`)
      }
      const candidate = envelope as { fingerprint?: unknown; record?: unknown }
      if (
        typeof candidate.fingerprint !== 'string' ||
        !/^[0-9a-f]{16}$/u.test(candidate.fingerprint) ||
        candidate.fingerprint !== recordFingerprint(candidate.record) ||
        canonicalJson(candidate) !== line
      ) throw new Error(`${file.path} contains a bad fingerprint or noncanonical record`)
      const record = candidate.record as { id?: unknown }
      const id = String(record?.id ?? '')
      if (!id || id === previousId) throw new Error(`${file.path} contains a duplicate or missing stable id`)
      if (previousId !== null) {
        const numericOrder = INTEGER_RE.test(previousId) && INTEGER_RE.test(id)
          ? BigInt(previousId) < BigInt(id)
          : previousId < id
        if (!numericOrder) throw new Error(`${file.path} records are not in stable id order`)
      }
      previousId = id
    }
    counts[file.class_name] = lines.length
    verifiedFiles.push(Object.freeze({
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
      records: file.records,
      class_name: file.class_name,
    }))
  }
  const rootHash = sha256(manifestBytes)
  const manifestStats = await stat(join(directory, 'manifest.json'))
  verifiedFiles.push(Object.freeze({ path: 'manifest.json', sha256: rootHash, bytes: manifestStats.size }))
  return Object.freeze({
    format_version: PUBLIC_SNAPSHOT_FORMAT_VERSION,
    tag: tagFor(manifest.exported_at),
    exported_at: manifest.exported_at,
    city_root_sha256: rootHash,
    counts: Object.freeze({ ...counts }),
    files: Object.freeze(verifiedFiles),
  })
}
