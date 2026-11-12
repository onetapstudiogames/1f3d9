// Cap the city's manual Neon snapshots: keep the newest ten, remove the oldest first.
// The migrator calls applyCeremonySnapshotCap after its own snapshot and DDL succeed.
// The first prune brings an existing backlog down to the cap:
//   npm run snapshots:prune                      (dry run, deletes nothing)
//   SNAPSHOT_PRUNE_EXPECTED_DELETIONS=<n> npm run snapshots:prune -- --apply
// The rule is decision #194; the operator steps are in docs/runbooks/BACKUP_RESTORE.md.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSafeIdentifier, requiredIdentifier } from './database-target.ts'
import { safeErrorDetail } from './safe-error-detail.ts'

/** Neon's manual snapshot limit on a paid plan; scheduled snapshots do not count. */
export const NEON_MANUAL_SNAPSHOT_LIMIT = 100

const NEON_API = 'https://console.neon.tech/api/v2'
const POLICY_SCHEMA_VERSION = 1
const MAX_LIST_PAGES = 20
const REQUEST_TIMEOUT_MS = 20_000
const DELETE_PAUSE_MS = 1_000
const MAX_DELETE_ATTEMPTS = 3
const RETRYABLE_DELETE_STATUSES = new Set([423, 503])
const BYTES_PER_GB = 1_000_000_000
const UNAFFECTED = 'the migration result above is unaffected'
const PRUNE_USAGE =
  'Usage: npm run snapshots:prune (dry run) or ' +
  'SNAPSHOT_PRUNE_EXPECTED_DELETIONS=<n> npm run snapshots:prune -- --apply'

export type SnapshotCapPolicy = Readonly<{
  cap: number
  maxDeletionsPerCeremony: number
  keep: readonly string[]
}>

export type SnapshotRecord = Readonly<{
  id: string
  name: string
  sourceBranchId: string
  createdAt: string
  createdMs: number
  manual: boolean
  fullSize: number | null
}>

export type SnapshotCapPlan = Readonly<{
  /** The newest manual production snapshots inside the cap, newest first. */
  kept: readonly SnapshotRecord[]
  /** Manual production snapshots on the keep list, outside the cap. */
  keptByName: readonly SnapshotRecord[]
  /** What this run removes, oldest first. */
  remove: readonly SnapshotRecord[]
  /** Snapshots past the cap that this run leaves for a later run. */
  leftPastCap: number
  /** Manual production snapshots now, keep-list ones included. */
  manualOnBranch: number
}>

type SnapshotTarget = Readonly<{ projectId: string; branchId: string }>
type Pause = (milliseconds: number) => Promise<void>

const realPause: Pause = milliseconds => new Promise(done => setTimeout(done, milliseconds))

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** Validate config/snapshot-cap.json before anything is read or deleted. */
export function parseSnapshotCapPolicy(value: unknown): SnapshotCapPolicy {
  if (!isObject(value) || value.schemaVersion !== POLICY_SCHEMA_VERSION) {
    throw new Error(`snapshot cap config needs schemaVersion ${POLICY_SCHEMA_VERSION}`)
  }
  if (!isPositiveInteger(value.cap)) throw new Error('snapshot cap config needs a positive whole cap')
  if (!isPositiveInteger(value.maxDeletionsPerCeremony)) {
    throw new Error('snapshot cap config needs a positive whole maxDeletionsPerCeremony')
  }
  const keep = Array.isArray(value.keep) ? value.keep : null
  if (!keep || !keep.every(entry => isObject(entry) && typeof entry.name === 'string' && entry.name.trim() !== '')) {
    throw new Error('snapshot cap config needs keep as a list of { name } with a snapshot name each')
  }
  return Object.freeze({
    cap: value.cap,
    maxDeletionsPerCeremony: value.maxDeletionsPerCeremony,
    keep: Object.freeze(keep.map(entry => String((entry as Record<string, unknown>).name))),
  })
}

export const SNAPSHOT_CAP_POLICY = parseSnapshotCapPolicy(JSON.parse(
  readFileSync(new URL('../config/snapshot-cap.json', import.meta.url), 'utf8'),
))

function neonRequest(url: URL, apiKey: string, fetcher: typeof fetch, method = 'GET'): Promise<Response> {
  return fetcher(url, {
    method,
    redirect: 'error',
    headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
}

function parseSnapshotRow(item: unknown): SnapshotRecord {
  if (!isObject(item) || !isSafeIdentifier(item.id) || typeof item.name !== 'string' ||
      !isSafeIdentifier(item.source_branch_id) || typeof item.created_at !== 'string' ||
      typeof item.manual !== 'boolean') {
    throw new Error('the snapshot list had a row without a usable id, name, branch, time or kind')
  }
  const createdMs = Date.parse(item.created_at)
  if (!Number.isFinite(createdMs)) throw new Error(`the snapshot list had an unreadable time for ${item.id}`)
  return Object.freeze({
    id: item.id,
    name: item.name,
    sourceBranchId: item.source_branch_id,
    createdAt: item.created_at,
    createdMs,
    manual: item.manual,
    fullSize: typeof item.full_size === 'number' ? item.full_size : null,
  })
}

/** The next page cursor, null at the end; throws when the paging cannot be followed. */
function nextCursor(pagination: unknown): string | null {
  if (pagination === undefined || pagination === null) return null
  if (!isObject(pagination)) throw new Error('the snapshot list had paging it could not follow')
  if (typeof pagination.next === 'string' && pagination.next !== '') return pagination.next
  const unknownMore = Object.values(pagination).some(value => value !== null && value !== undefined && value !== '')
  if (unknownMore) throw new Error('the snapshot list said there may be more but gave no next page')
  return null
}

/**
 * Read every snapshot in the project, following any paging, or throw.
 * Neon documents no paging for this list today; a next page is still followed.
 */
export async function listProjectSnapshots(
  projectId: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<readonly SnapshotRecord[]> {
  const records: SnapshotRecord[] = []
  const seenIds = new Set<string>()
  const seenCursors = new Set<string>()
  let cursor: string | null = null
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const url = new URL(`${NEON_API}/projects/${encodeURIComponent(projectId)}/snapshots`)
    if (cursor) url.searchParams.set('cursor', cursor)
    const response = await neonRequest(url, apiKey, fetcher)
    if (!response.ok) throw new Error(`the snapshot list could not be read (HTTP ${response.status})`)
    const body: unknown = await response.json().catch(() => null)
    if (!isObject(body) || !Array.isArray(body.snapshots)) {
      throw new Error('the snapshot list was not in the expected shape')
    }
    for (const record of body.snapshots.map(parseSnapshotRow)) {
      if (seenIds.has(record.id)) throw new Error(`the snapshot list named ${record.id} twice`)
      seenIds.add(record.id)
      records.push(record)
    }
    cursor = nextCursor(body.pagination)
    if (cursor === null) return Object.freeze(records)
    if (seenCursors.has(cursor)) throw new Error('the snapshot list repeated a page')
    seenCursors.add(cursor)
  }
  throw new Error(`the snapshot list ran past ${MAX_LIST_PAGES} pages`)
}

function newestFirst(left: SnapshotRecord, right: SnapshotRecord): number {
  if (right.createdMs !== left.createdMs) return right.createdMs - left.createdMs
  return right.id < left.id ? -1 : right.id > left.id ? 1 : 0
}

/**
 * Decide what the cap removes. Only manual snapshots of the production branch count.
 * Scheduled ones, other branches, the keep list, the snapshot just made and the
 * newest `cap` are never removed. `limit` bounds one run; omit it for the first prune.
 */
export function planSnapshotCap(
  records: readonly SnapshotRecord[],
  options: Readonly<{ policy: SnapshotCapPolicy; branchId: string; justMadeId?: string; limit?: number }>,
): SnapshotCapPlan {
  const { policy, branchId, justMadeId, limit } = options
  if (justMadeId !== undefined && !records.some(record => record.id === justMadeId)) {
    throw new Error(`the snapshot list did not include the snapshot just made (${justMadeId}), so it may be stale`)
  }
  const onBranch = records.filter(record => record.manual && record.sourceBranchId === branchId)
  const keptByName = onBranch.filter(record => policy.keep.includes(record.name))
  const counted = onBranch.filter(record => !policy.keep.includes(record.name)).sort(newestFirst)
  const pastCap = counted.slice(policy.cap).filter(record => record.id !== justMadeId).reverse()
  const remove = limit === undefined ? pastCap : pastCap.slice(0, limit)
  return Object.freeze({
    kept: Object.freeze(counted.slice(0, policy.cap)),
    keptByName: Object.freeze(keptByName),
    remove: Object.freeze(remove),
    leftPastCap: pastCap.length - remove.length,
    manualOnBranch: onBranch.length,
  })
}

type DeleteOutcome = 'deleted' | 'already gone'

/** Delete one snapshot. Only 423 and 503 are retried, as Neon says only those are safe. */
async function deleteSnapshot(
  projectId: string,
  record: SnapshotRecord,
  apiKey: string,
  fetcher: typeof fetch,
  pause: Pause,
): Promise<DeleteOutcome> {
  const url = new URL(`${NEON_API}/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(record.id)}`)
  for (let attempt = 1; ; attempt += 1) {
    let response: Response
    try {
      response = await neonRequest(url, apiKey, fetcher, 'DELETE')
    } catch {
      throw new Error(`Neon did not answer the delete of ${record.name}; check the Neon console before trying again`)
    }
    if (response.ok) return 'deleted'
    if (response.status === 404) return 'already gone'
    if (!RETRYABLE_DELETE_STATUSES.has(response.status) || attempt >= MAX_DELETE_ATTEMPTS) {
      throw new Error(`Neon refused to delete ${record.name} (HTTP ${response.status})`)
    }
    await pause(DELETE_PAUSE_MS)
  }
}

type DeleteRun = Readonly<{ done: readonly string[]; failure: string | null }>

/** Delete oldest first, one at a time, stopping at the first refusal. */
async function deleteInOrder(
  target: SnapshotTarget,
  records: readonly SnapshotRecord[],
  apiKey: string,
  fetcher: typeof fetch,
  pause: Pause,
  onDone: (record: SnapshotRecord, outcome: DeleteOutcome) => void = () => {},
): Promise<DeleteRun> {
  const done: string[] = []
  for (const [index, record] of records.entries()) {
    if (index > 0) await pause(DELETE_PAUSE_MS)
    try {
      const outcome = await deleteSnapshot(target.projectId, record, apiKey, fetcher, pause)
      done.push(outcome === 'deleted' ? `${record.name} (${record.id})` : `${record.name} (${record.id}, already gone)`)
      onDone(record, outcome)
    } catch (error) {
      return Object.freeze({ done: Object.freeze(done), failure: safeErrorDetail(error) })
    }
  }
  return Object.freeze({ done: Object.freeze(done), failure: null })
}

function remainingPhrase(remaining: number, plan: SnapshotCapPlan, policy: SnapshotCapPolicy): string {
  return `${remaining} manual production snapshots remain (cap ${policy.cap}, plus ${plan.keptByName.length} kept by name)`
}

/**
 * Trim after a production migration. Never throws: the ceremony is already done,
 * so every outcome is one line for the migrate record.
 */
export async function applyCeremonySnapshotCap(input: Readonly<{
  snapshot: SnapshotTarget
  justMadeId: string
  apiKey: string
  policy?: SnapshotCapPolicy
  fetcher?: typeof fetch
  pause?: Pause
}>): Promise<string> {
  const policy = input.policy ?? SNAPSHOT_CAP_POLICY
  const fetcher = input.fetcher ?? fetch
  const pause = input.pause ?? realPause
  let plan: SnapshotCapPlan
  try {
    const records = await listProjectSnapshots(input.snapshot.projectId, input.apiKey, fetcher)
    plan = planSnapshotCap(records, {
      policy,
      branchId: input.snapshot.branchId,
      justMadeId: input.justMadeId,
      limit: policy.maxDeletionsPerCeremony,
    })
  } catch (error) {
    return `snapshot cap NOT applied: ${safeErrorDetail(error)}; nothing was deleted; ${UNAFFECTED}`
  }
  if (plan.remove.length === 0) {
    return `snapshot cap: nothing removed; ${remainingPhrase(plan.manualOnBranch, plan, policy)}`
  }
  const run = await deleteInOrder(input.snapshot, plan.remove, input.apiKey, fetcher, pause)
  const remaining = plan.manualOnBranch - run.done.length
  if (run.failure !== null) {
    return `snapshot cap NOT applied: ${run.failure}; removed ${run.done.length} before stopping; ` +
      `${remaining} manual production snapshots remain; ${UNAFFECTED}`
  }
  const backlog = plan.leftPastCap > 0
    ? `; ${plan.leftPastCap} older than the newest ${policy.cap} are still there; the first prune removes them`
    : ''
  return `snapshot cap: removed ${run.done.join(', ')}; ${remainingPhrase(remaining, plan, policy)}${backlog}`
}

/**
 * Explain a refused snapshot creation. When the project is at Neon's manual
 * snapshot limit, say so and name the first prune; otherwise keep the HTTP status.
 */
export async function explainSnapshotRefusal(
  projectId: string,
  apiKey: string,
  status: number,
  fetcher: typeof fetch = fetch,
): Promise<Error> {
  const plain = new Error(`Neon snapshot creation failed with HTTP ${status}`)
  let manual: number
  try {
    manual = (await listProjectSnapshots(projectId, apiKey, fetcher)).filter(record => record.manual).length
  } catch {
    return plain
  }
  if (manual < NEON_MANUAL_SNAPSHOT_LIMIT) return plain
  return new Error(
    `Neon refused the production snapshot: the project holds ${manual} manual snapshots and Neon allows at most ` +
    `${NEON_MANUAL_SNAPSHOT_LIMIT} on a paid plan. Nothing was migrated. Run the first prune ` +
    '(npm run snapshots:prune, dry run first; see docs/runbooks/BACKUP_RESTORE.md) to bring them down to the cap of ' +
    `${SNAPSHOT_CAP_POLICY.cap}, then run this migration again.`,
  )
}

function describe(record: SnapshotRecord): string {
  const size = record.fullSize === null ? 'size unknown' : `${(record.fullSize / BYTES_PER_GB).toFixed(2)} GB`
  return `${record.name}  ${record.createdAt}  ${size}`
}

function totalGb(records: readonly SnapshotRecord[]): string {
  return (records.reduce((sum, record) => sum + (record.fullSize ?? 0), 0) / BYTES_PER_GB).toFixed(2)
}

function parsePruneArguments(arguments_: readonly string[]): boolean {
  if (arguments_.length === 0) return false
  if (arguments_.length === 1 && arguments_[0] === '--apply') return true
  throw new Error(PRUNE_USAGE)
}

function requireExpectedDeletions(value: string | undefined, wouldDelete: number): void {
  const name = 'SNAPSHOT_PRUNE_EXPECTED_DELETIONS'
  if (value === undefined || value.trim() === '') {
    throw new Error(`a real first prune needs ${name} set to the number it would delete (${wouldDelete}); nothing was deleted`)
  }
  if (!/^\d+$/u.test(value.trim())) {
    throw new Error(`${name} must be a whole number; the prune would delete ${wouldDelete}; nothing was deleted`)
  }
  if (Number(value.trim()) !== wouldDelete) {
    throw new Error(`${name} is ${value.trim()} but the prune would delete ${wouldDelete}; nothing was deleted`)
  }
}

function printPlan(records: readonly SnapshotRecord[], plan: SnapshotCapPlan, branchId: string, log: (line: string) => void): void {
  const scheduled = records.filter(record => !record.manual).length
  const elsewhere = records.filter(record => record.manual && record.sourceBranchId !== branchId).length
  log(`read ${records.length} snapshots: ${plan.manualOnBranch} manual on the production branch, ` +
    `${scheduled} scheduled and ${elsewhere} manual on other branches (never touched)`)
  for (const record of plan.kept) log(`keep  ${describe(record)}`)
  for (const record of plan.keptByName) log(`keep by name  ${describe(record)}`)
  for (const record of plan.remove) log(`delete  ${describe(record)}`)
}

/**
 * The first prune: a dry run unless `--apply` is passed AND
 * SNAPSHOT_PRUNE_EXPECTED_DELETIONS equals what it would delete.
 */
export async function runSnapshotPrune(input: Readonly<{
  arguments_: readonly string[]
  environment?: NodeJS.ProcessEnv
  policy?: SnapshotCapPolicy
  fetcher?: typeof fetch
  log?: (line: string) => void
  pause?: Pause
}>): Promise<void> {
  const apply = parsePruneArguments(input.arguments_)
  const environment = input.environment ?? process.env
  const policy = input.policy ?? SNAPSHOT_CAP_POLICY
  const fetcher = input.fetcher ?? fetch
  const log = input.log ?? console.log
  const apiKey = environment.NEON_API_KEY?.trim()
  if (!apiKey) throw new Error('the first prune requires NEON_API_KEY')
  const target = Object.freeze({
    projectId: requiredIdentifier(environment.NEON_PROJECT_ID, 'NEON_PROJECT_ID'),
    branchId: requiredIdentifier(environment.NEON_PRODUCTION_BRANCH_ID, 'NEON_PRODUCTION_BRANCH_ID'),
  })

  const records = await listProjectSnapshots(target.projectId, apiKey, fetcher)
  const plan = planSnapshotCap(records, { policy, branchId: target.branchId })
  printPlan(records, plan, target.branchId, log)
  const kept = `the newest ${plan.kept.length} plus ${plan.keptByName.length} kept by name`
  if (!apply) {
    log(`first prune dry run: keeps ${kept}; would delete ${plan.remove.length} (${totalGb(plan.remove)} GB); nothing was deleted`)
    return
  }
  requireExpectedDeletions(environment.SNAPSHOT_PRUNE_EXPECTED_DELETIONS, plan.remove.length)
  const run = await deleteInOrder(target, plan.remove, apiKey, fetcher, input.pause ?? realPause,
    (record, outcome) => log(`${outcome}  ${record.name} (${record.id})`))
  if (run.failure !== null) {
    throw new Error(`${run.failure}; deleted ${run.done.length} before stopping; run the dry run again to see what is left`)
  }
  log(`first prune: deleted ${run.done.length}; ${plan.kept.length} manual production snapshots remain plus ` +
    `${plan.keptByName.length} kept by name`)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  runSnapshotPrune({ arguments_: process.argv.slice(2) }).catch(error => {
    console.error(`first prune stopped: ${safeErrorDetail(error)}`)
    process.exitCode = 1
  })
}
