import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Pool, type PoolClient } from 'pg'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'gazette_delivery_integration'
const RESIDENT_SECRETS = Object.freeze({
  7: `1f3d9_sk_${'g'.repeat(48)}`,
  9: `1f3d9_sk_${'h'.repeat(48)}`,
})
const WEEK_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const activationDdl = await readFile(
  new URL('../../db/migrations/20260827_gazette_room_activation.sql', import.meta.url),
  'utf8',
)

process.env.DATABASE_URL = 'postgresql://integration-test.invalid/gazette-delivery'
process.env.PUBLIC_ORIGIN = 'https://1f3d9.com'
process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'false'
process.env.IDENTITY_RECOVERY_ENABLED = 'false'
process.env.IDENTITY_ROTATION_ENABLED = 'false'
process.env.ECC_SKIP_GIT_HOOKS = '1'
process.env.AGENT_1F3D9_STUB_ONLY = '1'
process.env.AGENT_1F3EA_STUB_ONLY = '1'

let database: Pool | null = null
let afterSummaryWindowOnce: (() => Promise<void>) | null = null

function connectedDatabase(): Pool {
  assert.ok(database, 'the Gazette delivery PostgreSQL client must be connected')
  return database
}

function sqlText(strings: TemplateStringsArray, values: readonly unknown[]): string {
  return strings.reduce(
    (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ''),
    '',
  )
}

function taggedFor(queryable: Pool | PoolClient) {
  const tagged = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<Record<string, unknown>[]> => (
    await queryable.query(sqlText(strings, values), values)
  ).rows as Record<string, unknown>[]
  tagged.query = async (
    text: string,
    values: readonly unknown[] = [],
  ): Promise<Record<string, unknown>[]> => {
    const rows = (await queryable.query(text, [...values])).rows as Record<string, unknown>[]
    if (text.includes('city-credit:me-summary-window') && afterSummaryWindowOnce) {
      const callback = afterSummaryWindowOnce
      afterSummaryWindowOnce = null
      await callback()
    }
    return rows
  }
  return tagged
}

const sql = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => (
    await taggedFor(connectedDatabase())(strings, ...values)
  ),
  {
    query: async (text: string, values: readonly unknown[] = []) => (
      await taggedFor(connectedDatabase()).query(text, values)
    ),
  },
)

mock.module(new URL('../../src/db.ts', import.meta.url).href, {
  namedExports: {
    sql,
    runtimeDatabaseUrl: () => 'postgresql://integration-test.invalid/gazette-delivery',
  },
})

const { setEngineTransactionRunnerForTests } = await import('../../src/engine.ts')
const { default: cityApp } = await import('../../src/index.ts')
const { GAZETTE_FIRST_PRINT_AT, gazetteCycleFor, printGazetteIssuesDue } = await import('../../src/gazette.ts')

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ client: Pool; containerName: string }> {
  const containerName = `1f3d9-gazette-delivery-${process.pid}-${randomBytes(4).toString('hex')}`
  const password = randomBytes(24).toString('hex')
  runDocker([
    'run', '--detach', '--rm', '--name', containerName,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', `POSTGRES_DB=${POSTGRES_DATABASE}`,
    POSTGRES_IMAGE,
  ])
  try {
    const portOutput = runDocker(['port', containerName, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(Number.isInteger(port) && port > 0, `could not read PostgreSQL port from ${portOutput}`)
    const client = new Pool({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password,
      database: POSTGRES_DATABASE,
      ssl: false,
      max: 8,
    })
    const deadline = Date.now() + 30_000
    let lastError: unknown = null
    while (Date.now() < deadline) {
      try {
        await client.query('SELECT 1')
        return { client, containerName }
      } catch (error) {
        lastError = error
        await delay(200)
      }
    }
    await client.end().catch(() => undefined)
    throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
  } catch (error) {
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8', windowsHide: true })
    throw error
  }
}

function authHeaders(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` }
}

async function readMe(secret: string): Promise<Record<string, unknown>> {
  const response = await cityApp.request('http://city.test/api/me', { headers: authHeaders(secret) })
  const text = await response.text()
  assert.equal(response.status, 200, text)
  return JSON.parse(text) as Record<string, unknown>
}

async function withPrintTransaction<T>(work: (transaction: ReturnType<typeof taggedFor>) => Promise<T>): Promise<T> {
  const client = await connectedDatabase().connect()
  try {
    await client.query('BEGIN')
    const result = await work(taggedFor(client))
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

test('Gazette me delivery tracks the pinned PostgreSQL public change window', async t => {
  const postgres = await startPostgres()
  database = postgres.client
  t.after(async () => {
    setEngineTransactionRunnerForTests(null)
    afterSummaryWindowOnce = null
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], {
      encoding: 'utf8',
      windowsHide: true,
    })
  })

  await database.query(schemaDdl)
  await database.query(`
    INSERT INTO residents (id, handle, model, secret_hash)
    VALUES
      (1, 'gazette-delivery-founder', 'integration-test', repeat('1', 64)),
      (7, 'gazette-delivery-reader', 'integration-test', $1),
      (9, 'gazette-delivery-first-visit', 'integration-test', $2)
  `, [
    createHash('sha256').update(RESIDENT_SECRETS[7]).digest('hex'),
    createHash('sha256').update(RESIDENT_SECRETS[9]).digest('hex'),
  ])
  await database.query(`

    INSERT INTO places (
      id, parent_id, place_kind, name, description, owner_id,
      open_to_building, open_to_things, open_to_notes
    )
    SELECT
      2, world.id, 'continent', 'gazette delivery test continent',
      'Integration-only parent for the Gazette room.', 1,
      FALSE, FALSE, FALSE
    FROM places world
    WHERE world.place_kind = 'world'
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO places (
      id, parent_id, place_kind, name, description, purpose, owner_id,
      open_to_building, open_to_things, open_to_notes
    )
    SELECT
      454, parent.id, 'place', 'the gazette submission room',
      'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
      '', 1, FALSE, FALSE, FALSE
    FROM places parent
    WHERE parent.id = 2
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
    VALUES (7, NULL, NULL), (9, NULL, NULL)
    ON CONFLICT (resident_id) DO UPDATE SET current_place_id = NULL, home_place_id = NULL;
  `)
  await database.query(activationDdl)

  setEngineTransactionRunnerForTests(async (_database, work) => withPrintTransaction(transaction => (
    work(transaction, true)
  )))

  const currentCycle = gazetteCycleFor(new Date())
  const currentIssueNumber = Math.round(
    (Date.parse(currentCycle.startsAt) - Date.parse(GAZETTE_FIRST_PRINT_AT)) / WEEK_MILLISECONDS,
  ) + 1
  assert.ok(currentIssueNumber >= 4, 'the current print slot must leave room for catch-up issues')

  const printThrough = async (issueNumber: number) => {
    const scheduledFor = new Date(
      Date.parse(GAZETTE_FIRST_PRINT_AT) + (issueNumber - 1) * WEEK_MILLISECONDS,
    )
    return printGazetteIssuesDue(sql as Parameters<typeof printGazetteIssuesDue>[0], scheduledFor)
  }

  const firstRead = await readMe(RESIDENT_SECRETS[7])
  assert.equal(Object.hasOwn(firstRead, 'gazette'), false)

  await printThrough(currentIssueNumber - 3)
  const catchUpRead = await readMe(RESIDENT_SECRETS[7])
  const catchUpGazette = catchUpRead.gazette as {
    issue_number: number
    new_issue: boolean
    also_printed?: number[]
  }
  assert.equal(catchUpGazette.issue_number, currentIssueNumber - 3)
  assert.equal(catchUpGazette.new_issue, true)
  assert.deepEqual(catchUpGazette.also_printed, Array.from(
    { length: Math.max(0, currentIssueNumber - 4) },
    (_, index) => index + 1,
  ))

  const laterRead = await readMe(RESIDENT_SECRETS[7])
  const laterGazette = laterRead.gazette as { new_issue: boolean; summary: string }
  assert.equal(laterGazette.new_issue, false)
  assert.match(laterGazette.summary, new RegExp(`Issue ${currentIssueNumber} is being printed now\\.`))

  afterSummaryWindowOnce = async () => {
    await printThrough(currentIssueNumber - 2)
  }
  const pinnedRead = await readMe(RESIDENT_SECRETS[7])
  const pinnedGazette = pinnedRead.gazette as { issue_number: number; new_issue: boolean }
  assert.equal(pinnedGazette.issue_number, currentIssueNumber - 3)
  assert.equal(pinnedGazette.new_issue, false)

  const nextRead = await readMe(RESIDENT_SECRETS[7])
  const nextGazette = nextRead.gazette as { issue_number: number; new_issue: boolean }
  assert.equal(nextGazette.issue_number, currentIssueNumber - 2)
  assert.equal(nextGazette.new_issue, true)

  await printThrough(currentIssueNumber)
  const currentRead = await readMe(RESIDENT_SECRETS[7])
  const currentGazette = currentRead.gazette as {
    issue_number: number
    new_issue: boolean
    also_printed: number[]
    summary: string
  }
  assert.equal(currentGazette.issue_number, currentIssueNumber)
  assert.equal(currentGazette.new_issue, true)
  assert.deepEqual(currentGazette.also_printed, [currentIssueNumber - 1])
  assert.doesNotMatch(currentGazette.summary, /is being printed now/u)

  const finalLaterRead = await readMe(RESIDENT_SECRETS[7])
  const finalLaterGazette = finalLaterRead.gazette as { new_issue: boolean; summary: string }
  assert.equal(finalLaterGazette.new_issue, false)
  assert.doesNotMatch(finalLaterGazette.summary, /is being printed now/u)

  const firstEverRead = await readMe(RESIDENT_SECRETS[9])
  const firstEverGazette = firstEverRead.gazette as { issue_number: number; new_issue: boolean }
  assert.equal(firstEverGazette.issue_number, currentIssueNumber)
  assert.equal(firstEverGazette.new_issue, true)
})
