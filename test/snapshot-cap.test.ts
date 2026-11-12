import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  NEON_MANUAL_SNAPSHOT_LIMIT,
  SNAPSHOT_CAP_POLICY,
  applyCeremonySnapshotCap,
  listProjectSnapshots,
  parseSnapshotCapPolicy,
  planSnapshotCap,
  runSnapshotPrune,
  type SnapshotCapPolicy,
} from '../scripts/snapshot-cap.ts'
import { createProductionSnapshot, executeMigrationRun, type MigrationRun } from '../scripts/migrate.ts'

const PROJECT = 'project-one'
const BRANCH = 'branch-production'
const OTHER_BRANCH = 'branch-other'
const API_KEY = 'secret-neon-key'
const KEEPSAKE = 'open-to-use-20260815-094119'
const POLICY: SnapshotCapPolicy = Object.freeze({
  cap: 10,
  maxDeletionsPerCeremony: 3,
  keep: Object.freeze([KEEPSAKE]),
})
const noPause = async (): Promise<void> => {}

type FakeRow = {
  id: string
  name: string
  source_branch_id: string
  created_at: string
  expires_at: string | null
  manual: boolean
  full_size: number
  diff_size: number | null
}

function day(index: number): string {
  return new Date(Date.UTC(2026, 7, 1) + index * 3_600_000).toISOString().replace('.000', '')
}

/** Manual production rows, index 0 is the oldest. */
function manualRows(count: number, offset = 0): FakeRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `snap-manual-${String(index + offset).padStart(3, '0')}`,
    name: `pre-release-${String(index + offset).padStart(3, '0')}`,
    source_branch_id: BRANCH,
    created_at: day(index + offset + 100),
    expires_at: null,
    manual: true,
    full_size: 1_000_000_000,
    diff_size: null,
  }))
}

function scheduledRow(index: number): FakeRow {
  return {
    id: `snap-scheduled-${index}`,
    name: `${BRANCH}-scheduled-${index}`,
    source_branch_id: BRANCH,
    created_at: day(index),
    expires_at: day(index + 336),
    manual: false,
    full_size: 1_000_000_000,
    diff_size: 1_000,
  }
}

type FakeNeon = {
  fetcher: typeof fetch
  calls: Array<{ method: string; url: string; authorization: string | null }>
  deleted: string[]
  rows: FakeRow[]
}

function fakeNeon(initialRows: FakeRow[], options: {
  listStatus?: number
  listBody?: unknown
  pages?: Array<{ rows: FakeRow[]; pagination?: unknown }>
  failDeleteIds?: Set<string>
  deleteStatus?: Map<string, number[]>
  snapshotCreateStatus?: number
} = {}): FakeNeon {
  const state: FakeNeon = { fetcher: fetch, calls: [], deleted: [], rows: [...initialRows] }
  state.fetcher = (async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    state.calls.push({ method, url: url.toString(), authorization: new Headers(init?.headers).get('authorization') })
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
    if (method === 'GET' && url.pathname.endsWith('/snapshots')) {
      if (options.listStatus) return json({ code: 'x', message: 'raw provider text' }, options.listStatus)
      if (options.listBody !== undefined) return json(options.listBody)
      if (options.pages) {
        const cursor = url.searchParams.get('cursor')
        const index = cursor === null ? 0 : Number(cursor.replace('page-', ''))
        const page = options.pages[index]!
        return json({ snapshots: page.rows, ...(page.pagination === undefined ? {} : { pagination: page.pagination }) })
      }
      return json({ snapshots: state.rows })
    }
    if (method === 'DELETE') {
      const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
      const scripted = options.deleteStatus?.get(id)
      if (scripted && scripted.length > 0) {
        const status = scripted.shift()!
        if (status !== 200) return json({ code: 'x', message: 'raw provider text' }, status)
      }
      if (options.failDeleteIds?.has(id)) return json({ code: 'x', message: 'raw provider text' }, 500)
      state.deleted.push(id)
      state.rows = state.rows.filter(row => row.id !== id)
      return json({ snapshot: { id } })
    }
    if (method === 'POST' && url.pathname.endsWith('/snapshot')) {
      return json({ code: 'x', message: 'raw provider text' }, options.snapshotCreateStatus ?? 422)
    }
    throw new Error(`unexpected fake Neon call ${method} ${url}`)
  }) as typeof fetch
  return state
}

async function ceremony(neon: FakeNeon, justMadeId: string, policy = POLICY): Promise<string> {
  return applyCeremonySnapshotCap({
    snapshot: { projectId: PROJECT, branchId: BRANCH },
    justMadeId,
    apiKey: API_KEY,
    policy,
    fetcher: neon.fetcher,
    pause: noPause,
  })
}

test('the checked-in policy caps manual snapshots at ten, three per ceremony, and keeps the opening-day snapshot', () => {
  assert.equal(SNAPSHOT_CAP_POLICY.cap, 10)
  assert.equal(SNAPSHOT_CAP_POLICY.maxDeletionsPerCeremony, 3)
  assert.deepEqual([...SNAPSHOT_CAP_POLICY.keep], [KEEPSAKE])
  assert.equal(NEON_MANUAL_SNAPSHOT_LIMIT, 100)
  const config = JSON.parse(readFileSync(new URL('../config/snapshot-cap.json', import.meta.url), 'utf8'))
  assert.deepEqual(parseSnapshotCapPolicy(config), SNAPSHOT_CAP_POLICY)
})

test('a malformed policy is refused before anything is read or deleted', () => {
  assert.throws(() => parseSnapshotCapPolicy({ schemaVersion: 1, cap: 0, maxDeletionsPerCeremony: 3, keep: [] }), /cap/)
  assert.throws(() => parseSnapshotCapPolicy({ schemaVersion: 1, cap: 10, maxDeletionsPerCeremony: 0, keep: [] }), /maxDeletionsPerCeremony/)
  assert.throws(() => parseSnapshotCapPolicy({ schemaVersion: 1, cap: 10, maxDeletionsPerCeremony: 3, keep: [{ name: '' }] }), /keep/)
  assert.throws(() => parseSnapshotCapPolicy({ schemaVersion: 2, cap: 10, maxDeletionsPerCeremony: 3, keep: [] }), /schemaVersion/)
})

test('cap arithmetic: nine and ten manual snapshots remove nothing, eleven removes the oldest one', async () => {
  for (const count of [9, 10]) {
    const rows = manualRows(count)
    const neon = fakeNeon(rows)
    const line = await ceremony(neon, rows.at(-1)!.id)
    assert.deepEqual(neon.deleted, [])
    assert.match(line, /^snapshot cap: nothing removed;/)
  }
  const rows = manualRows(11)
  const neon = fakeNeon(rows)
  const line = await ceremony(neon, rows.at(-1)!.id)
  assert.deepEqual(neon.deleted, ['snap-manual-000'])
  assert.match(line, /^snapshot cap: removed pre-release-000 \(snap-manual-000\); 10 manual production snapshots remain/)
})

test('the plan keeps the newest ten and lists the rest oldest first', async () => {
  const rows = manualRows(90)
  const listed = await listProjectSnapshots(PROJECT, API_KEY, fakeNeon(rows).fetcher)
  const plan = planSnapshotCap(listed, { policy: POLICY, branchId: BRANCH })
  assert.deepEqual(plan.kept.map(row => row.id), rows.slice(80).reverse().map(row => row.id))
  assert.deepEqual(plan.remove.map(row => row.id), rows.slice(0, 80).map(row => row.id))
})

test('a ceremony never removes more than three, oldest first', async () => {
  const rows = manualRows(20)
  const neon = fakeNeon(rows)
  const line = await ceremony(neon, rows.at(-1)!.id)
  assert.deepEqual(neon.deleted, ['snap-manual-000', 'snap-manual-001', 'snap-manual-002'])
  assert.match(line, /7 older than the newest 10 are still there; the first prune removes them/)
})

test('scheduled snapshots and other branches are never deleted or counted', async () => {
  const otherBranch = manualRows(5, 500).map(row => ({ ...row, source_branch_id: OTHER_BRANCH, created_at: day(row.id.length) }))
  const rows = [...[0, 1, 2, 3].map(scheduledRow), ...otherBranch, ...manualRows(12)]
  const neon = fakeNeon(rows)
  await ceremony(neon, 'snap-manual-011')
  assert.deepEqual(neon.deleted, ['snap-manual-000', 'snap-manual-001'])
  assert.ok(neon.calls.every(call => call.url.includes(`/projects/${PROJECT}/`)))
  assert.ok(neon.calls.every(call => call.authorization === `Bearer ${API_KEY}`))
  assert.ok(neon.calls.every(call => !call.url.includes(API_KEY)))
})

test('the snapshot just made is never deleted, even when it is not the newest by time', async () => {
  const rows = manualRows(11)
  const justMade = { ...rows[0]!, id: 'snap-just-made', name: 'pre-now' }
  const neon = fakeNeon([justMade, ...rows.slice(1), ...manualRows(1, 50)])
  await ceremony(neon, 'snap-just-made')
  assert.ok(!neon.deleted.includes('snap-just-made'))
  assert.deepEqual(neon.deleted, ['snap-manual-001'])
})

test('a list without the snapshot just made is stale and deletes nothing', async () => {
  const neon = fakeNeon(manualRows(15))
  const line = await ceremony(neon, 'snap-missing')
  assert.deepEqual(neon.deleted, [])
  assert.match(line, /^snapshot cap NOT applied: .*snapshot just made/)
  assert.match(line, /the migration result above is unaffected$/)
})

test('the keep list wins: a kept name is never deleted and does not count toward the cap', async () => {
  const keepsake = { ...manualRows(1, 900)[0]!, id: 'snap-keepsake', name: KEEPSAKE, created_at: day(0) }
  const rows = [keepsake, ...manualRows(11)]
  const neon = fakeNeon(rows)
  const line = await ceremony(neon, 'snap-manual-010')
  assert.deepEqual(neon.deleted, ['snap-manual-000'])
  assert.match(line, /plus 1 kept by name/)
  const plan = planSnapshotCap(await listProjectSnapshots(PROJECT, API_KEY, neon.fetcher), { policy: POLICY, branchId: BRANCH })
  assert.deepEqual(plan.keptByName.map(row => row.id), ['snap-keepsake'])
  assert.equal(plan.kept.length, 10)
})

test('an unreadable or incomplete list deletes nothing', async () => {
  const cases: Array<Parameters<typeof fakeNeon>[1]> = [
    { listStatus: 500 },
    { listBody: { nope: [] } },
    { listBody: { snapshots: [{ id: 'snap-a', name: 'a', manual: true }] } },
    { listBody: { snapshots: [...manualRows(12), manualRows(1)[0]] } },
    { listBody: { snapshots: manualRows(12), pagination: { cursor: 'more-maybe' } } },
    { pages: [{ rows: manualRows(12), pagination: { next: 'page-0' } }] },
  ]
  for (const options of cases) {
    const neon = fakeNeon(manualRows(12), options)
    const line = await ceremony(neon, 'snap-manual-011')
    assert.deepEqual(neon.deleted, [], JSON.stringify(options))
    assert.equal(neon.calls.filter(call => call.method === 'DELETE').length, 0)
    assert.match(line, /^snapshot cap NOT applied: /)
    assert.doesNotMatch(line, /raw provider text/)
  }
})

test('the whole list is read across pages before the oldest is chosen', async () => {
  const all = manualRows(12)
  const neon = fakeNeon(all, {
    pages: [
      { rows: all.slice(2), pagination: { next: 'page-1' } },
      { rows: all.slice(0, 2), pagination: { next: null } },
    ],
  })
  await ceremony(neon, 'snap-manual-011')
  assert.deepEqual(neon.deleted, ['snap-manual-000', 'snap-manual-001'])
  assert.equal(neon.calls.filter(call => call.method === 'GET').length, 2)
})

test('a failed delete stops the trim with one plain warning line and never throws', async () => {
  const rows = manualRows(13)
  const neon = fakeNeon(rows, { failDeleteIds: new Set(['snap-manual-001']) })
  const line = await ceremony(neon, 'snap-manual-012')
  assert.deepEqual(neon.deleted, ['snap-manual-000'])
  assert.equal(line.split('\n').length, 1)
  assert.match(line, /^snapshot cap NOT applied: Neon refused to delete pre-release-001 \(HTTP 500\); removed 1 before stopping; 12 manual production snapshots remain; the migration result above is unaffected$/)
  assert.doesNotMatch(line, /raw provider text/)
})

test('a locked delete is retried, and an already absent snapshot counts as gone', async () => {
  const rows = manualRows(12)
  const neon = fakeNeon(rows, { deleteStatus: new Map([['snap-manual-000', [423, 200]], ['snap-manual-001', [404]]]) })
  const line = await ceremony(neon, 'snap-manual-011')
  assert.deepEqual(neon.deleted, ['snap-manual-000'])
  assert.match(line, /^snapshot cap: removed pre-release-000 \(snap-manual-000\), pre-release-001 \(snap-manual-001, already gone\);/)
})

function productionRun(): MigrationRun {
  return {
    target: 'production',
    databaseUrl: 'postgres://role@example.neon.tech/db',
    migrationFile: 'db/migrations/20260814_public_pagination.sql',
    executionMode: 'transactional',
    snapshot: { projectId: PROJECT, branchId: BRANCH, name: 'pre-test' },
  }
}

test('the migration trims only after its snapshot is made and its DDL applied, and a failed trim keeps the result', async () => {
  const events: string[] = []
  const result = await executeMigrationRun(productionRun(), 'SELECT 1', API_KEY, {
    verifyGazetteLocalCandidate: () => assert.fail('no live deployment'),
    verifyGazetteDeployment: async () => assert.fail('no live deployment'),
    verifyPreviewDatabaseTarget: async () => assert.fail('production run'),
    prepareProductionMigration: async () => { events.push('snapshot'); return 'snap-new' },
    applyMigration: async () => { events.push('ddl'); return 4 },
    capManualSnapshots: async (snapshot, justMadeId) => {
      events.push(`cap:${snapshot.branchId}:${justMadeId}`)
      throw new Error('unexpected')
    },
  })
  assert.deepEqual(events, ['snapshot', 'ddl', `cap:${BRANCH}:snap-new`])
  assert.equal(result.statementCount, 4)
  assert.equal(result.snapshotId, 'snap-new')
  assert.match(result.snapshotCap ?? '', /^snapshot cap NOT applied: .*the migration result above is unaffected$/)
})

test('a failed migration and a preview migration never trim', async () => {
  let trims = 0
  const operations = {
    verifyGazetteLocalCandidate: () => {},
    verifyGazetteDeployment: async () => {},
    verifyPreviewDatabaseTarget: async () => {},
    prepareProductionMigration: async () => 'snap-new',
    applyMigration: async () => { throw new Error('ddl failed') },
    capManualSnapshots: async () => { trims += 1; return 'snapshot cap: nothing removed' },
  }
  await assert.rejects(executeMigrationRun(productionRun(), 'SELECT 1', API_KEY, operations), /ddl failed/)
  const preview = await executeMigrationRun({
    target: 'preview',
    databaseUrl: 'postgres://role@example.neon.tech/db',
    migrationFile: 'db/migrations/20260814_public_pagination.sql',
    executionMode: 'transactional',
    preview: { projectId: PROJECT, branchId: 'branch-preview', productionBranchId: BRANCH },
  }, 'SELECT 1', API_KEY, { ...operations, applyMigration: async () => 1 })
  assert.equal(trims, 0)
  assert.deepEqual(preview, { statementCount: 1 })
})

test('a snapshot refused at the Neon limit says so in plain words', async () => {
  const neon = fakeNeon(manualRows(NEON_MANUAL_SNAPSHOT_LIMIT))
  await assert.rejects(
    createProductionSnapshot({ projectId: PROJECT, branchId: BRANCH, name: 'pre-test' }, API_KEY, neon.fetcher),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /holds 100 manual snapshots and Neon allows at most 100/)
      assert.match(error.message, /npm run snapshots:prune/)
      assert.match(error.message, /Nothing was migrated/)
      assert.doesNotMatch(error.message, /raw provider text/)
      return true
    },
  )
  assert.deepEqual(neon.deleted, [])
})

test('a snapshot refused below the limit keeps the plain HTTP refusal', async () => {
  const neon = fakeNeon(manualRows(40), { snapshotCreateStatus: 500 })
  await assert.rejects(
    createProductionSnapshot({ projectId: PROJECT, branchId: BRANCH, name: 'pre-test' }, API_KEY, neon.fetcher),
    /^Error: Neon snapshot creation failed with HTTP 500$/,
  )
})

const PRUNE_ENVIRONMENT = Object.freeze({
  NEON_API_KEY: API_KEY,
  NEON_PROJECT_ID: PROJECT,
  NEON_PRODUCTION_BRANCH_ID: BRANCH,
})

async function prune(neon: FakeNeon, arguments_: string[], environment: NodeJS.ProcessEnv): Promise<string[]> {
  const lines: string[] = []
  await runSnapshotPrune({
    arguments_,
    environment,
    policy: POLICY,
    fetcher: neon.fetcher,
    log: line => { lines.push(line) },
    pause: noPause,
  })
  return lines
}

function backlog(): FakeRow[] {
  const keepsake = { ...manualRows(1, 900)[0]!, id: 'snap-keepsake', name: KEEPSAKE, created_at: day(0) }
  return [scheduledRow(1), keepsake, ...manualRows(30)]
}

test('the first prune is a dry run by default and prints what it would keep and delete', async () => {
  const neon = fakeNeon(backlog())
  const lines = await prune(neon, [], { ...PRUNE_ENVIRONMENT, SNAPSHOT_PRUNE_EXPECTED_DELETIONS: '20' })
  assert.deepEqual(neon.deleted, [])
  assert.ok(neon.calls.every(call => call.method === 'GET'))
  const text = lines.join('\n')
  assert.match(text, /keep {2}pre-release-029 {2}2026-08-0\dT\d\d:\d\d:\d\dZ {2}1\.00 GB/)
  assert.match(text, new RegExp(`keep by name {2}${KEEPSAKE}`))
  assert.match(text, /delete {2}pre-release-000 /)
  assert.equal(lines.filter(line => line.startsWith('delete  ')).length, 20)
  assert.equal(lines.filter(line => line.startsWith('keep  ')).length, 10)
  assert.match(lines.at(-1)!, /^first prune dry run: keeps the newest 10 plus 1 kept by name; would delete 20 \(20\.00 GB\); nothing was deleted$/)
})

test('a real first prune needs both the flag and the matching number', async () => {
  for (const [arguments_, expected] of [
    [['--apply'], undefined],
    [['--apply'], '19'],
    [['--apply'], 'twenty'],
  ] as const) {
    const neon = fakeNeon(backlog())
    const environment = expected === undefined
      ? { ...PRUNE_ENVIRONMENT }
      : { ...PRUNE_ENVIRONMENT, SNAPSHOT_PRUNE_EXPECTED_DELETIONS: expected }
    await assert.rejects(prune(neon, [...arguments_], environment), /SNAPSHOT_PRUNE_EXPECTED_DELETIONS.*nothing was deleted/)
    assert.deepEqual(neon.deleted, [])
  }
  await assert.rejects(prune(fakeNeon(backlog()), ['--yes'], PRUNE_ENVIRONMENT), /Usage/)

  const neon = fakeNeon(backlog())
  const lines = await prune(neon, ['--apply'], { ...PRUNE_ENVIRONMENT, SNAPSHOT_PRUNE_EXPECTED_DELETIONS: '20' })
  assert.deepEqual(neon.deleted, manualRows(20).map(row => row.id))
  assert.ok(!neon.deleted.includes('snap-keepsake'))
  assert.ok(!neon.deleted.includes('snap-scheduled-1'))
  assert.match(lines.at(-1)!, /^first prune: deleted 20; 10 manual production snapshots remain plus 1 kept by name$/)
})

test('a real first prune stops at the first failed delete and fails the command', async () => {
  const neon = fakeNeon(backlog(), { failDeleteIds: new Set(['snap-manual-002']) })
  await assert.rejects(
    prune(neon, ['--apply'], { ...PRUNE_ENVIRONMENT, SNAPSHOT_PRUNE_EXPECTED_DELETIONS: '20' }),
    /Neon refused to delete pre-release-002 \(HTTP 500\); deleted 2 before stopping/,
  )
  assert.deepEqual(neon.deleted, ['snap-manual-000', 'snap-manual-001'])
})

test('the first prune refuses a missing Neon project or branch before any call', async () => {
  const neon = fakeNeon(backlog())
  await assert.rejects(prune(neon, [], { NEON_API_KEY: API_KEY, NEON_PROJECT_ID: PROJECT }), /NEON_PRODUCTION_BRANCH_ID/)
  await assert.rejects(prune(neon, [], { NEON_PROJECT_ID: PROJECT, NEON_PRODUCTION_BRANCH_ID: BRANCH }), /NEON_API_KEY/)
  assert.equal(neon.calls.length, 0)
})

test('the rule is decision 194 and the first prune has its npm script', () => {
  const decisions = readFileSync(new URL('../docs/DECISIONS.md', import.meta.url), 'utf8')
  const row = decisions.split('\n').find(line => line.startsWith('| 194 |')) ?? ''
  for (const phrase of ['newest 10', 'no expiry dates', 'at most 3 in one run', KEEPSAKE, 'npm run snapshots:prune', 'LOCKED (owner, 2026-11-11']) {
    assert.ok(row.includes(phrase), `decision 194 needs ${phrase}`)
  }
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }
  assert.equal(packageJson.scripts['snapshots:prune'], 'node --experimental-strip-types scripts/snapshot-cap.ts')
  const runbook = readFileSync(new URL('../docs/runbooks/BACKUP_RESTORE.md', import.meta.url), 'utf8')
  assert.doesNotMatch(runbook, /named permanent snapshot/)
  assert.match(runbook, /### The manual snapshot cap/)
})
