import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { Pool, type PoolClient } from 'pg'
import { splitSqlStatements } from '../../../scripts/migrate.ts'
import { earlierStoredActivityMigration } from '../earlier-stored-activity-migration.ts'
import { startNoteSuiteDatabase } from '../note-suite-fixtures/postgres.ts'
import { seedProductionBenchmark } from './production-fixture.ts'

const directory = 'logs/fix4'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const migrationPath = 'db/migrations/20261028_stored_public_activity.sql'
const schemaCommit = 'ff9745d4c3a027b9ec803828c097d3590f847d8f'
const snapshotTag = 'city-snapshot-v3-20261028T150901Z'
const snapshotUrl = `https://github.com/onetapstudiogames/1f3d9/releases/download/${snapshotTag}/events.ndjson`
type Timing = { statement: number; label: string; milliseconds: number; sqlHash: string }

async function input(name: string, create: () => Promise<string>) {
  const path = `${directory}/${name}`
  try { return await readFile(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const value = await create()
  await writeFile(path, value)
  return value
}

async function download(url: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`public fixture download returned HTTP ${response.status}`)
  return response.text()
}

export async function prepareInputs() {
  await mkdir(directory, { recursive: true })
  const baseline = await input('before-migration.sql', async () =>
    earlierStoredActivityMigration(await readFile(migrationPath, 'utf8')))
  assert.equal(hash(baseline), 'a701b4e8eb9b99d73f4c68faa909e578c10932215b18376e4b9e0bcde2d7de57')
  const schema = await input('main-schema.sql', () => download(
    `https://raw.githubusercontent.com/onetapstudiogames/1f3d9/${schemaCommit}/db/schema.sql`))
  assert.equal(hash(schema), '421a97910c34649eff2dc766c3bbf88c850701ef401f197bcce33ec1c52d4ba8')
  const publicEvents = await input('public-events.ndjson', () => download(snapshotUrl))
  assert.equal(hash(publicEvents), '5cc792ee2ecfe54229d356a69a727b67d6b1a13ce26ae389b5270eef7c6febe6')
  const kinds: Record<string, number> = {}, actions: Record<string, number> = {}
  let events = 0
  for (const line of publicEvents.trim().split('\n')) {
    const record = JSON.parse(line).record as { kind?: string; detail?: Record<string, unknown> }
    events += 1
    const kind = record.kind ?? 'undefined'
    kinds[kind] = (kinds[kind] ?? 0) + 1
    if (kind !== 'action') continue
    const key = [record.detail?.action ?? 'unknown', record.detail?.status ?? 'unknown',
      record.detail?.effects_applied ?? 'missing'].join(':')
    actions[key] = (actions[key] ?? 0) + 1
  }
  const expected = { source: `https://github.com/onetapstudiogames/1f3d9/releases/tag/${snapshotTag}`,
    events, kinds: Object.fromEntries(Object.entries(kinds).sort((left, right) => right[1] - left[1])), actions }
  const histogram = await input('public-kind-counts.json', async () => JSON.stringify(expected, null, 2))
  assert.deepEqual(JSON.parse(histogram), expected, 'cached histogram differs from the pinned public records')
  return { baseline, schema, sourceSnapshot: { url: snapshotUrl, sha256: hash(publicEvents) } }
}

function label(sql: string): string {
  return sql.replace(/--[^\n]*/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 145)
}

async function snapshot(db: Pool) {
  const residents = (await db.query('SELECT id,last_public_action_at::text FROM residents ORDER BY id')).rows
  const places = (await db.query('SELECT id,last_public_action_at::text FROM places ORDER BY id')).rows
  const receipt = (await db.query('SELECT to_jsonb(state)-\'backfilled_at\' AS receipt FROM public_activity_schema_state state')).rows[0]!.receipt
  return { residents, places, receipt }
}

async function lookupPlan(client: PoolClient) {
  return (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT CASE WHEN action.destination_place_id IS NOT NULL
      THEN action.place_id IS DISTINCT FROM action.destination_place_id END
    FROM action_runs action JOIN residents actor ON actor.id=action.actor_id AND actor.handle='benchmark-6'
    JOIN action_resolutions resolution ON resolution.action_run_id=action.id AND resolution.status='applied'
    WHERE action.id::text='1' AND action.action_name='move'`)).rows[0]!['QUERY PLAN']
}

export async function measure(db: Pool, migration: string, mode: 'before' | 'after') {
  const client = await db.connect()
  const timings: Timing[] = []
  const notices: string[] = []
  client.on('notice', notice => { if (notice.message?.includes('duration:')) notices.push(notice.message) })
  try {
    await client.query("LOAD 'auto_explain'")
    await client.query("SET auto_explain.log_min_duration='100ms'")
    await client.query('SET auto_explain.log_analyze=on')
    await client.query('SET auto_explain.log_buffers=on')
    await client.query('SET auto_explain.log_timing=off')
    await client.query('SET auto_explain.log_nested_statements=on')
    await client.query("SET auto_explain.log_format='json'")
    await client.query("SET auto_explain.log_level='notice'")
    const plan = await lookupPlan(client)
    await writeFile(`${directory}/${mode}-lookup-plan.json`, JSON.stringify(plan, null, 2))
    const statements = splitSqlStatements(migration)
    let lockStart: number | null = null
    const start = performance.now()
    for (let index = 0; index < statements.length; index += 1) {
      const source = statements[index]!
      const statement = /^SET LOCAL statement_timeout\s*=/u.test(source.trim())
        ? "SET LOCAL statement_timeout='120min'" : source
      const at = performance.now()
      if (lockStart === null && /\bALTER TABLE (residents|places)\b/u.test(statement)) lockStart = at
      console.log(`${mode} statement ${index + 1}/${statements.length}: ${label(source)}`)
      await client.query(statement)
      const timing = { statement: index + 1, label: label(source), milliseconds: performance.now() - at, sqlHash: hash(source) }
      timings.push(timing)
      await writeFile(`${directory}/${mode}-timings.json`, JSON.stringify(timings, null, 2))
      console.log(`${mode} statement ${index + 1} completed ${timing.milliseconds.toFixed(3)} ms`)
    }
    const milliseconds = performance.now() - start
    const lockedMilliseconds = lockStart === null ? 0 : performance.now() - lockStart
    await writeFile(`${directory}/${mode}-plans.json`, JSON.stringify(notices, null, 2))
    const rows = await snapshot(db)
    await writeFile(`${directory}/${mode}-rows.json`, JSON.stringify(rows, null, 2))
    return { migrationHash: hash(migration), milliseconds, lockedMilliseconds, timings, rows }
  } catch (error) {
    await client.query('ROLLBACK')
    await writeFile(`${directory}/${mode}-plans.json`, JSON.stringify(notices, null, 2))
    throw error
  } finally {
    client.release()
  }
}

async function main() {
  const { baseline, schema, sourceSnapshot } = await prepareInputs()
  const service = await startNoteSuiteDatabase('public-activity-scale')
  let db = service.client
  let candidate: Pool | null = null
  const report: Record<string, unknown> = {
    schemaCommit, schemaHash: hash(schema), sourceSnapshot,
    command: 'node --experimental-strip-types --experimental-test-module-mocks test/helpers/public-activity-benchmark/migration-scale.ts',
    started: new Date().toISOString(), complete: false,
  }
  const save = () => writeFile(`${directory}/migration-scale-report.json`, JSON.stringify(report, null, 2))
  try {
    report.postgres = (await db.query('SHOW server_version')).rows[0]!.server_version
    report.counts = await seedProductionBenchmark(db, schema)
    console.log(JSON.stringify({ seeded: report.counts }))
    await save()
    const options = { ...db.options, password: db.options.password }
    await db.end()
    const admin = new Pool({ ...options, database: 'postgres' })
    try { await admin.query('CREATE DATABASE activity_candidate TEMPLATE public_activity_scale') }
    finally { await admin.end() }
    db = new Pool(options)
    candidate = new Pool({ ...options, database: 'activity_candidate' })
    report.before = await measure(db, baseline, 'before')
    await save()
    console.log('BASELINE_COMPLETE: applying current candidate to the identical seed')
    const final = await readFile(migrationPath, 'utf8')
    const after = await measure(candidate, final, 'after')
    report.after = after
    const before = report.before as Awaited<ReturnType<typeof measure>>
    const differences = (kind: 'residents' | 'places') => before.rows[kind].filter((row, index) =>
      JSON.stringify(row) !== JSON.stringify(after.rows[kind][index]))
    const comparison = { residents: differences('residents'), places: differences('places'),
      residentRows: after.rows.residents.length, placeRows: after.rows.places.length,
      receiptEqual: JSON.stringify(before.rows.receipt) === JSON.stringify(after.rows.receipt) }
    report.comparison = comparison
    await save()
    assert.deepEqual(comparison.residents, [])
    assert.deepEqual(comparison.places, [])
    assert.deepEqual(after.rows.residents, before.rows.residents)
    assert.deepEqual(after.rows.places, before.rows.places)
    assert.deepEqual(after.rows.receipt, before.rows.receipt)
    const { verifyPublicActivityClient } = await import('../../../scripts/verify-public-activity.ts')
    const verifier = await candidate.connect()
    try {
      const start = performance.now()
      await verifyPublicActivityClient(verifier)
      report.verifier = { passed: true, milliseconds: performance.now() - start }
    } finally { verifier.release() }
    assert(after.milliseconds < 60000, 'whole migration exceeds 60 seconds')
    assert(after.lockedMilliseconds < 10000, 'resident/place lock interval exceeds 10 seconds')
    report.complete = true
    report.finished = new Date().toISOString()
    await save()
    console.log(JSON.stringify({ complete: true, beforeMs: before.milliseconds, afterMs: after.milliseconds,
      beforeLockedMs: before.lockedMilliseconds, afterLockedMs: after.lockedMilliseconds, comparison, receipt: after.rows.receipt }))
  } catch (error) {
    report.failure = error instanceof Error ? error.message : 'migration scale benchmark failed'
    await save()
    throw error
  } finally {
    await candidate?.end()
    if (db !== service.client) await db.end()
    await service.stop()
    console.log('Owned disposable PostgreSQL stopped')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
