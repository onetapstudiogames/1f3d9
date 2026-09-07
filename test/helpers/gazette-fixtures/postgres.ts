import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool, type PoolClient } from 'pg'

import type { TaggedSql } from '../../../src/engine.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'gazette_integration'
export const schemaDdl = await readFile(new URL('../../../db/schema.sql', import.meta.url), 'utf8')
const gazetteSchemaMarker = '-- The Gazette is a deterministic weekly ledger'
const gazetteSchemaOffset = schemaDdl.indexOf(gazetteSchemaMarker)
const postGazetteSchemaMarker = 'CREATE OR REPLACE FUNCTION complete_city_credit_purchase('
const postGazetteSchemaOffset = schemaDdl.indexOf(postGazetteSchemaMarker)
assert.ok(gazetteSchemaOffset > 0, 'schema must keep the stable Gazette section marker')
assert.ok(
  postGazetteSchemaOffset > gazetteSchemaOffset,
  'schema must keep the stable post-Gazette section marker',
)
export const preGazetteSchemaDdl = schemaDdl.slice(0, gazetteSchemaOffset)
  + schemaDdl.slice(postGazetteSchemaOffset)
assert.doesNotMatch(preGazetteSchemaDdl, /gazette_/iu)
export const migrationDdl = await readFile(
  new URL('../../../db/migrations/20260827_gazette.sql', import.meta.url),
  'utf8',
)
export const activationDdl = await readFile(
  new URL('../../../db/migrations/20260827_gazette_room_activation.sql', import.meta.url),
  'utf8',
)
export const withdrawalMigrationDdl = await readFile(
  new URL('../../../db/migrations/20260901_gazette_withdrawal.sql', import.meta.url),
  'utf8',
)
export const withdrawalActivationDdl = await readFile(
  new URL('../../../db/migrations/20260901_gazette_withdrawal_activation.sql', import.meta.url),
  'utf8',
)

type GazetteRuntime = Readonly<{
  gazetteCycleFor: (value: string | Date) => Readonly<{
    startsAt: string
    endsAt: string
  }>
  printGazetteIssuesDue?: (
    database: TaggedSql,
    through: string | Date,
  ) => Promise<readonly unknown[]>
  gazetteWithdrawalNotice?: (noteId: number) => string
}>

type GazetteStoreRuntime = Readonly<{
  readGazetteSubmissionRoomState?: (
    database: Readonly<{ query(text: string, params?: readonly unknown[]): Promise<unknown> }>,
  ) => Promise<Readonly<{ submissionsOpen: boolean; withdrawalsOpen: boolean }>>
  listGazetteIssues?: (
    database: Readonly<{ query(text: string, params?: readonly unknown[]): Promise<unknown> }>,
    input: Readonly<{ beforeIssueNumber: number | null; limit: number }>,
  ) => Promise<Readonly<{
    issues: readonly Record<string, unknown>[]
    hasMore: boolean
    nextBeforeIssueNumber: number | null
  }>>
  readGazetteIssue?: (
    database: Readonly<{ query(text: string, params?: readonly unknown[]): Promise<unknown> }>,
    input: Readonly<{
      issueNumber: number
      afterOrdinal: number | null
      limit: number
      textLimitBytes?: number | null
    }>,
  ) => Promise<Readonly<{
    issue: Record<string, unknown>
    entries: readonly Record<string, unknown>[]
    hasMore: boolean
    nextAfterOrdinal: number | null
    returnedTextBytes: number
    stoppedForTextLimit: boolean
    nextItemOrdinal: number | null
    nextItemNoteId: number | null
    nextItemTextBytes: number | null
  }> | null>
  readCompleteGazetteIssue?: (
    database: Readonly<{ query(text: string, params?: readonly unknown[]): Promise<unknown> }>,
    issueNumber: number,
  ) => Promise<Readonly<{
    issue: Record<string, unknown>
    entries: readonly Record<string, unknown>[]
  }> | null>
  readGazetteIssueFacts?: (
    database: Readonly<{ query(text: string, params?: readonly unknown[]): Promise<unknown> }>,
    issueNumber: number,
  ) => Promise<Readonly<{
    issue_number: number
    scheduled_for: string
    printed_at: string
    entry_count: number
    resident_count: number
  }> | null>
}>

export const gazetteRuntime = await import('../../../src/gazette.ts') as GazetteRuntime
export const gazetteStoreRuntime = await import(
  new URL('../../../src/gazette-store.ts', import.meta.url).href
).catch(() => ({})) as GazetteStoreRuntime

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

export async function startPostgres(): Promise<Readonly<{
  database: Pool
  containerName: string
}>> {
  const containerName = `1f3d9-gazette-test-${process.pid}-${randomBytes(4).toString('hex')}`
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
    const port = Number(portOutput.match(/:(\d+)\s*$/)?.[1])
    assert.ok(Number.isInteger(port) && port > 0, `could not read PostgreSQL port from ${portOutput}`)
    const database = new Pool({
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
        await database.query('SELECT 1')
        return { database, containerName }
      } catch (error) {
        lastError = error
        await delay(200)
      }
    }
    await database.end().catch(() => undefined)
    throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
  } catch (error) {
    spawnSync('docker', ['stop', '--time', '0', containerName], {
      encoding: 'utf8',
      windowsHide: true,
    })
    throw error
  }
}

export function taggedFor(queryable: Pool | PoolClient): TaggedSql {
  const tagged = (async (
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<Record<string, unknown>[]> => {
    const text = strings.reduce(
      (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ''),
      '',
    )
    return (await queryable.query(text, [...values])).rows as Record<string, unknown>[]
  }) as TaggedSql
  tagged.query = async (text: string, values: readonly unknown[] = []) => (
    await queryable.query(text, [...values])
  ).rows
  return tagged
}

export function iso(value: unknown): string {
  assert.ok(value instanceof Date, 'PostgreSQL must return a timestamp')
  return value.toISOString()
}

export async function assertGazetteRoomWriteRejected(
  database: Pool,
  text: string,
  values: readonly unknown[] = [],
): Promise<void> {
  await assert.rejects(
    database.query(text, [...values]),
    (error: unknown) => {
      assert.equal(
        (error as { constraint?: string }).constraint,
        'gazette_submission_room_lifecycle',
      )
      return true
    },
  )
}
