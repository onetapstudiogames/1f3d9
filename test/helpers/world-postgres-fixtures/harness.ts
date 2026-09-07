import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import type { TestContext } from 'node:test'
import { mock } from 'node:test'
import { Pool, type PoolClient } from 'pg'

import type { Resident } from '../../../src/core.ts'
import type { TaggedSql } from '../../../src/engine.ts'

import { registerAgreementTests } from '../../integration/world-tests/agreements.ts'
import { registerDrawingsAndUpgradesTests } from '../../integration/world-tests/drawings-and-upgrades.ts'
import { registerMigrationsAndLawsTests } from '../../integration/world-tests/migrations-and-laws.ts'
import { registerProtectedLifecycleTests } from '../../integration/world-tests/protected-lifecycle.ts'
import { registerPlaceLifecycleActionsTests } from '../../integration/world-tests/place-lifecycle-actions.ts'
import { registerRetirementConcurrencyTests } from '../../integration/world-tests/retirement-concurrency.ts'
import { registerRetiredPlaceWritesTests } from '../../integration/world-tests/retired-place-writes.ts'
import { registerTransfersAndRoutesTests } from '../../integration/world-tests/transfers-and-routes.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'world_integration'
const schemaDdl = await readFile(new URL('../../../db/schema.sql', import.meta.url), 'utf8')
const placeLifecycleMigrationDdl = await readFile(
  new URL('../../../db/migrations/20260901_place_lifecycle.sql', import.meta.url),
  'utf8',
)
const preLifecycleSnapshotMigrationDdl = await readFile(
  new URL('../../../db/migrations/20260901_public_snapshot_event_details.sql', import.meta.url),
  'utf8',
)
const quietSnapshotMigrationDdl = await readFile(
  new URL('../../../db/migrations/20260902_public_snapshot_quiet.sql', import.meta.url),
  'utf8',
)

let database: Pool | null = null
let afterAgreementSignPreflight: (() => Promise<void>) | null = null
let afterThingUpgradePreflight: (() => Promise<void>) | null = null

interface IntegrationSql extends TaggedSql {
  transaction: (
    work: (transaction: TaggedSql) => readonly Promise<Record<string, unknown>[]>[],
    options?: Readonly<{ readOnly?: boolean }>,
  ) => Promise<Record<string, unknown>[][]>
}

const sql = (async (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): Promise<Record<string, unknown>[]> => {
  assert.ok(database, 'the PostgreSQL test client must be connected')
  const text = strings.reduce(
    (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ''),
    '',
  )
  const result = await database.query(text, [...values])
  if (afterAgreementSignPreflight && text.includes('AS already_signed')) {
    await afterAgreementSignPreflight()
  }
  if (afterThingUpgradePreflight && text.includes('AS latest_revision')
    && text.includes('latest_drawing_variants')) {
    const preflight = afterThingUpgradePreflight
    afterThingUpgradePreflight = null
    await preflight()
  }
  return result.rows as Record<string, unknown>[]
}) as unknown as IntegrationSql
sql.query = async (text, values = []) => {
  assert.ok(database, 'the PostgreSQL test client must be connected')
  return (await database.query(text, [...values])).rows as Record<string, unknown>[]
}

sql.query = async (text, values = []) => {
  assert.ok(database, 'the PostgreSQL test client must be connected')
  return (await database.query(text, [...values])).rows as Record<string, unknown>[]
}

function transactionSql(client: PoolClient): TaggedSql {
  const tagged = (async (
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<Record<string, unknown>[]> => {
    const text = strings.reduce(
      (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ''),
      '',
    )
    return (await client.query(text, [...values])).rows as Record<string, unknown>[]
  }) as TaggedSql
  tagged.query = async (text, values = []) => (
    await client.query(text, [...values])
  ).rows
  return tagged
}

sql.transaction = async (work, options = {}) => {
  assert.ok(database, 'the PostgreSQL test client must be connected')
  const connection = await database.connect()
  try {
    await connection.query(options.readOnly ? 'BEGIN READ ONLY' : 'BEGIN')
    const results = await Promise.all(work(transactionSql(connection)))
    await connection.query('COMMIT')
    return results
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    connection.release()
  }
}

mock.module(new URL('../../../src/db.ts', import.meta.url).href, {
  namedExports: {
    sql,
    runtimeDatabaseUrl: () => 'postgresql://integration-test.invalid/world',
  },
})
function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ client: Pool; containerName: string }> {
  const containerName = `1f3d9-world-test-${process.pid}-${randomBytes(4).toString('hex')}`
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
    const deadline = Date.now() + 30_000
    let lastError: unknown = null
    const client = new Pool({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password,
      database: POSTGRES_DATABASE,
      ssl: false,
      max: 8,
    })
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
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8' })
    throw error
  }
}

const actor: Resident = {
  id: 1,
  handle: 'founder',
  model: 'integration-test',
  joined_at: '2026-08-11T00:00:00.000Z',
  quota_day: '2026-08-11',
  things_today: 0,
  notes_today: 0,
  agreement_actions_today: 0,
}

const founderSecret = `1f3d9_sk_${'f'.repeat(48)}`
const neighborSecret = `1f3d9_sk_${'a'.repeat(48)}`

function secretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` }
}

function postgresCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : null
}

function twoRequestBarrier(): () => Promise<void> {
  let arrivals = 0
  let release = (): void => undefined
  const bothArrived = new Promise<void>(resolve => {
    release = resolve
  })
  return async () => {
    arrivals += 1
    if (arrivals === 2) release()
    await bothArrived
  }
}

async function assertWaitingOnDatabaseLock(pid: number, label: string): Promise<void> {
  for (let check = 0; check < 100; check += 1) {
    const activity = await database!.query<{ wait_event_type: string | null }>(`
      SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1
    `, [pid])
    if (activity.rows[0]?.wait_event_type === 'Lock') return
    await delay(10)
  }
  assert.fail(`${label} did not wait on the retirement place lock`)
}

async function resetDatabase(): Promise<number> {
  assert.ok(database)
  await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await database.query(schemaDdl)
  await database.query(`
    INSERT INTO residents (id, handle, model, secret_hash) VALUES
      (1, 'founder', 'integration-test', $1),
      (2, 'neighbor', 'integration-test', $2)
  `, [secretHash(founderSecret), secretHash(neighborSecret)])
  await database.query(`
    INSERT INTO traits (id, name, description, coiner_id)
      VALUES
        (1, 'peaceful', 'quiet conduct', 1),
        (2, 'war-zone', 'combat allowed', 1)
  `)
  const room = await database.query<{ place_id: number }>(`
    WITH world AS MATERIALIZED (
      SELECT id FROM places WHERE place_kind = 'world'
    ), continent AS (
      INSERT INTO places (parent_id, place_kind, name, description, owner_id)
      SELECT id, 'continent', 'test-continent', 'integration-test land', 1
      FROM world
      RETURNING id
    ), test_room AS (
      INSERT INTO places (parent_id, place_kind, name, description, owner_id)
      SELECT id, 'place', 'test-room', 'a test room', 1
      FROM continent
      RETURNING id
    )
    INSERT INTO things (id, place_id, name, body, owner_id, maker_id)
    SELECT 1, id, 'test-object', 'still here', 1, 1
    FROM test_room
    RETURNING place_id
  `)
  assert.ok(room.rows[0], 'the PostgreSQL fixture must create a test room')
  return room.rows[0].place_id
}

async function insertProtectedGazetteRoom(parentId: number): Promise<void> {
  await database!.query(`
    INSERT INTO places (
      id, parent_id, place_kind, name, description, purpose, owner_id,
      open_to_building, open_to_things, open_to_notes
    ) VALUES (
      454, $1, 'place', 'the gazette submission room',
      'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
      '', 1, FALSE, FALSE, FALSE
    )
  `, [parentId])
}

async function seedAgreement(options: { accessionOpen?: boolean } = {}): Promise<number> {
  assert.ok(database)
  const agreement = await database.query<{ id: number }>(`
    INSERT INTO agreements (created_by_id, body)
    VALUES (1, 'A durable integration-test agreement.')
    RETURNING id
  `)
  const agreementId = agreement.rows[0]!.id
  await database.query(`
    INSERT INTO agreement_parties (agreement_id, resident_id, named)
    VALUES ($1, 1, true)
  `, [agreementId])
  if (options.accessionOpen) {
    await database.query(`
      INSERT INTO agreement_accession_openings (agreement_id, opened_by_id)
      VALUES ($1, 1)
    `, [agreementId])
  }
  return agreementId
}

export interface WorldTestContext {
  sql: IntegrationSql
  database: Pool
  actor: Resident
  founderSecret: string
  neighborSecret: string
  bearer: typeof bearer
  postgresCode: typeof postgresCode
  assertWaitingOnDatabaseLock: typeof assertWaitingOnDatabaseLock
  resetDatabase: typeof resetDatabase
  insertProtectedGazetteRoom: typeof insertProtectedGazetteRoom
  seedAgreement: typeof seedAgreement
  transactionSql: typeof transactionSql
  placeLifecycleMigrationDdl: string
  preLifecycleSnapshotMigrationDdl: string
  quietSnapshotMigrationDdl: string
  craftKindThing: typeof import('../../../src/crafting.ts')['craftKindThing']
  makeThingThroughEngine: typeof import('../../../src/thing-making.ts')['makeThingThroughEngine']
  replacePlaceLaws: typeof import('../../../src/laws.ts')['replacePlaceLaws']
  withdrawThing: typeof import('../../../src/withdrawal.ts')['withdrawThing']
  moveResident: typeof import('../../../src/engine.ts')['moveResident']
  setEngineTransactionRunnerForTests: typeof import('../../../src/engine.ts')['setEngineTransactionRunnerForTests']
  executeEffects: typeof import('../../../src/engine-effects.ts')['executeEffects']
  app: import('hono').Hono
}

export async function registerWorldPostgresTests(t: TestContext): Promise<void> {
  const postgres = await startPostgres()
  database = postgres.client
  try {
    const { craftKindThing } = await import('../../../src/crafting.ts')
    const { makeThingThroughEngine } = await import('../../../src/thing-making.ts')
    const { replacePlaceLaws } = await import('../../../src/laws.ts')
    const { withdrawThing } = await import('../../../src/withdrawal.ts')

    await registerMigrationsAndLawsTests(t, {
      actor,
      database,
      placeLifecycleMigrationDdl,
      postgresCode,
      preLifecycleSnapshotMigrationDdl,
      quietSnapshotMigrationDdl,
      replacePlaceLaws,
      resetDatabase,
      withdrawThing,
    })

    const { Hono } = await import('hono')
    const { moveResident, setEngineTransactionRunnerForTests } = await import('../../../src/engine.ts')
    const { executeEffects } = await import('../../../src/engine-effects.ts')
    const { mountDrawingRoutes } = await import('../../../src/drawings.ts')
    const { mountSocietyRoutes } = await import('../../../src/society.ts')
    const { mountWorldRoutes } = await import('../../../src/world.ts')
    const app = new Hono()
    mountSocietyRoutes(app)
    mountWorldRoutes(app)
    mountDrawingRoutes(app, {
      database: {
        query: async (text, params = []) => (
          await database!.query(text, [...params])
        ).rows,
      },
      authenticate: async () => actor,
    })

    await registerProtectedLifecycleTests(t, {
      app,
      bearer,
      database,
      founderSecret,
      insertProtectedGazetteRoom,
      resetDatabase,
    })
    await registerPlaceLifecycleActionsTests(t, {
      actor,
      app,
      bearer,
      database,
      founderSecret,
      postgresCode,
      resetDatabase,
      setEngineTransactionRunnerForTests,
      transactionSql,
      withdrawThing,
    })
    await registerRetirementConcurrencyTests(t, {
      actor,
      app,
      assertWaitingOnDatabaseLock,
      bearer,
      database,
      founderSecret,
      moveResident,
      resetDatabase,
      setEngineTransactionRunnerForTests,
      transactionSql,
      withdrawThing,
    })
    await registerRetiredPlaceWritesTests(t, {
      actor,
      app,
      assertWaitingOnDatabaseLock,
      bearer,
      craftKindThing,
      database,
      executeEffects,
      founderSecret,
      makeThingThroughEngine,
      resetDatabase,
      setEngineTransactionRunnerForTests,
      transactionSql,
    })
    await registerDrawingsAndUpgradesTests(t, {
      app,
      bearer,
      database,
      founderSecret,
      resetDatabase,
    }, async () => {
      await t.test('thing upgrade never overwrites a drawing choice changed after its preflight', async () => {
        const variants = [
          {
            name: 'ember', drawing: { palette: ['#9a3412'], indices: [0, ...Array(63).fill(null)] },
            state: 'complete', description: 'An ember lantern.',
          },
          {
            name: 'moon', drawing: { palette: ['#164e63'], indices: [0, ...Array(63).fill(null)] },
            state: 'complete', description: 'A moon lantern.',
          },
        ]
        const seedThing = async (name: string): Promise<number> => {
          const roomId = await resetDatabase()
          const kindId = Number((await database!.query<{ id: number }>(`
          INSERT INTO kinds (name, owner_id, current_revision)
          VALUES ($1, 1, 2)
          RETURNING id
        `, [name])).rows[0]!.id)
          await database!.query(`
          INSERT INTO kind_revisions (
            kind_id, revision, description, traits, recipe,
            drawing, drawing_state, drawing_description, drawing_variants
          ) VALUES
            ($1, 1, 'The pinned revision.', '{}', '[]',
              NULL, 'undrawn', NULL, $2),
            ($1, 2, 'The latest revision.', '{}', '[]',
              NULL, 'undrawn', NULL, $2)
        `, [kindId, JSON.stringify(variants)])
          await database!.query(`
          INSERT INTO things (
            id, place_id, name, body, owner_id, maker_id,
            kind_id, birth_revision, current_revision, drawing_variant_name
          ) VALUES (2, $1, 'racing upgrade', '', 1, 1, $2, 1, 1, 'ember')
        `, [roomId, kindId])
          return kindId
        }

        await seedThing('interstatement-upgrade-kind')
        afterThingUpgradePreflight = async () => {
          const edit = await app.request('/api/thing/2', {
            method: 'PATCH',
            headers: { ...bearer(founderSecret), 'content-type': 'application/json' },
            body: JSON.stringify({ drawing_variant_name: 'moon' }),
          })
          assert.equal(edit.status, 200, await edit.clone().text())
        }
        try {
          const raced = await app.request('/api/thing/2/upgrade', {
            method: 'POST',
            headers: bearer(founderSecret),
          })
          assert.equal(raced.status, 409, await raced.clone().text())
        } finally {
          afterThingUpgradePreflight = null
        }
        const afterCommittedEdit = await database!.query(`
        SELECT current_revision, drawing_variant_name,
          (SELECT count(*)::integer FROM drawing_revisions
            WHERE target_type = 'thing' AND target_id = 2) AS drawing_revisions,
          (SELECT count(*)::integer FROM events
            WHERE kind = 'thing_edited' AND (detail->>'thing_id')::integer = 2) AS edit_events,
          (SELECT count(*)::integer FROM events
            WHERE kind = 'thing_upgraded' AND (detail->>'thing_id')::integer = 2) AS upgrade_events
        FROM things WHERE id = 2
      `)
        assert.deepEqual(afterCommittedEdit.rows, [{
          current_revision: 1,
          drawing_variant_name: 'moon',
          drawing_revisions: 1,
          edit_events: 1,
          upgrade_events: 0,
        }])

        await seedThing('overlapping-upgrade-kind')
        const editor = await database!.connect()
        try {
          await editor.query('BEGIN')
          await editor.query(
            "UPDATE things SET drawing_variant_name = 'moon' WHERE id = 2",
          )
          const startedAt = Date.now()
          const overlapping = await app.request('/api/thing/2/upgrade', {
            method: 'POST',
            headers: bearer(founderSecret),
          })
          assert.equal(overlapping.status, 409, await overlapping.clone().text())
          assert.ok(Date.now() - startedAt < 1_000, 'upgrade must not wait on an overlapping thing edit')
          await editor.query('COMMIT')
        } finally {
          await editor.query('ROLLBACK').catch(() => undefined)
          editor.release()
        }
        const afterOverlappingEdit = await database!.query(`
        SELECT current_revision, drawing_variant_name,
          (SELECT count(*)::integer FROM drawing_revisions
            WHERE target_type = 'thing' AND target_id = 2) AS drawing_revisions,
          (SELECT count(*)::integer FROM events
            WHERE kind = 'thing_upgraded' AND (detail->>'thing_id')::integer = 2) AS upgrade_events
        FROM things WHERE id = 2
      `)
        assert.deepEqual(afterOverlappingEdit.rows, [{
          current_revision: 1,
          drawing_variant_name: 'moon',
          drawing_revisions: 0,
          upgrade_events: 0,
        }])
      })

    })
    await registerTransfersAndRoutesTests(t, {
      app,
      bearer,
      database,
      executeEffects,
      founderSecret,
      neighborSecret,
      resetDatabase,
      setEngineTransactionRunnerForTests,
      sql,
      transactionSql,
    })
    await registerAgreementTests(t, {
      app,
      bearer,
      database,
      neighborSecret,
      postgresCode,
      resetDatabase,
      seedAgreement,
      founderSecret,
    }, async () => {
      await t.test('concurrent accession signing records one party, signature, event, and quota action', async () => {
        await resetDatabase()
        const agreementId = await seedAgreement({ accessionOpen: true })

        afterAgreementSignPreflight = twoRequestBarrier()
        let responses: Response[]
        try {
          responses = await Promise.all([
            app.request(`/api/agreement/${agreementId}/sign`, {
              method: 'POST',
              headers: bearer(neighborSecret),
            }),
            app.request(`/api/agreement/${agreementId}/sign`, {
              method: 'POST',
              headers: bearer(neighborSecret),
            }),
          ])
        } finally {
          afterAgreementSignPreflight = null
        }
        assert.deepEqual(responses.map(response => response.status).sort(), [200, 200])
        const responseBodies = await Promise.all(responses.map(async response => (
          await response.json() as {
            signature: { agreement_id: number; handle: string; acceded: boolean; signed_at: string }
          }
        )))
        assert.deepEqual(responseBodies[0], responseBodies[1])
        assert.deepEqual({
          agreement_id: responseBodies[0]!.signature.agreement_id,
          handle: responseBodies[0]!.signature.handle,
          acceded: responseBodies[0]!.signature.acceded,
        }, {
          agreement_id: agreementId,
          handle: 'neighbor',
          acceded: true,
        })
        assert.ok(Number.isFinite(Date.parse(responseBodies[0]!.signature.signed_at)))

        const state = await database!.query(`
        SELECT
          (SELECT count(*)::int FROM agreement_parties
            WHERE agreement_id = $1 AND resident_id = 2 AND named = false) AS acceded_parties,
          (SELECT count(*)::int FROM agreement_signatures
            WHERE agreement_id = $1 AND resident_id = 2) AS signatures,
          (SELECT count(*)::int FROM events
            WHERE kind = 'agreement_sign' AND actor = 'neighbor'
              AND (detail->>'agreement_id')::int = $1) AS events,
          (SELECT agreement_actions_today FROM residents WHERE id = 2) AS quota
      `, [agreementId])
        assert.deepEqual(state.rows, [{ acceded_parties: 1, signatures: 1, events: 1, quota: 1 }])
      })

    })
  } finally {
    database = null
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
}
