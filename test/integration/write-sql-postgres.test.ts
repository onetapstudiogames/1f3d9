import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Client } from 'pg'

import type { Resident } from '../../src/core.ts'
import type { LawFailure, PublicLaw } from '../../src/laws.ts'
import type { WithdrawalFailure, WithdrawnThing } from '../../src/withdrawal.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'write_sql_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')

let database: Client | null = null

const sql = async (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): Promise<Record<string, unknown>[]> => {
  assert.ok(database, 'the PostgreSQL test client must be connected before production SQL runs')
  const text = strings.reduce(
    (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ''),
    '',
  )
  const result = await database.query(text, [...values])
  return result.rows as Record<string, unknown>[]
}

mock.module(new URL('../../src/db.ts', import.meta.url).href, {
  namedExports: { sql },
})

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ client: Client; containerName: string }> {
  const containerName = `1f3d9-write-sql-test-${process.pid}-${randomBytes(4).toString('hex')}`
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
    while (Date.now() < deadline) {
      const client = new Client({
        host: '127.0.0.1',
        port,
        user: 'postgres',
        password,
        database: POSTGRES_DATABASE,
        ssl: false,
      })
      try {
        await client.connect()
        return { client, containerName }
      } catch (error) {
        lastError = error
        await client.end().catch(() => undefined)
        await delay(200)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
  } catch (error) {
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8' })
    throw error
  }
}

const actor: Resident = Object.freeze({
  id: 8,
  handle: 'write-tester',
  model: 'postgres-integration',
  joined_at: '2026-08-14T00:00:00.000Z',
  quota_day: '2026-08-14',
  things_today: 0,
  notes_today: 0,
  agreement_actions_today: 0,
})

function requireLawList(result: readonly PublicLaw[] | LawFailure): readonly PublicLaw[] {
  if (!Array.isArray(result)) assert.fail(`expected laws, received ${JSON.stringify(result)}`)
  return result as readonly PublicLaw[]
}

function requireWithdrawal(result: WithdrawnThing | WithdrawalFailure): WithdrawnThing {
  if ('error' in result) assert.fail(`expected withdrawal, received ${JSON.stringify(result)}`)
  return result
}

test('production law and withdrawal SQL types execute in PostgreSQL', async t => {
  const postgres = await startPostgres()
  database = postgres.client

  try {
    const [{ replacePlaceLaws }, { withdrawThing }] = await Promise.all([
      import('../../src/laws.ts'),
      import('../../src/withdrawal.ts'),
    ])

    await database.query(schemaDdl)
    await database.query(
      `INSERT INTO residents (id, handle, model, secret_hash, quota_day)
       VALUES ($1, $2, $3, $4, $5)`,
      [actor.id, actor.handle, actor.model, '8'.repeat(64), actor.quota_day],
    )
    const world = await database.query<{ id: number }>(
      `SELECT id FROM places WHERE place_kind = 'world' AND parent_id IS NULL`,
    )
    assert.equal(world.rowCount, 1)
    const continent = await database.query<{ id: number }>(
      `INSERT INTO places (parent_id, place_kind, name, owner_id)
       VALUES ($1, 'continent', 'SQL Test Continent', $2)
       RETURNING id`,
      [world.rows[0]!.id, actor.id],
    )
    const continentId = continent.rows[0]!.id
    const traits = await database.query<{ id: number; name: string }>(
      `INSERT INTO traits (name, coiner_id)
       VALUES ('quiet-hours', $1), ('war-zone', $1)
       RETURNING id, name`,
      [actor.id],
    )
    assert.equal(traits.rowCount, 2)

    await t.test('replacePlaceLaws persists integer actor ids through both UNION branches', async () => {
      const initial = requireLawList(
        await replacePlaceLaws(actor, continentId, ['quiet-hours', 'war-zone']),
      )
      assert.deepEqual(initial.map(law => law.name), ['quiet-hours', 'war-zone'])

      const replaced = requireLawList(await replacePlaceLaws(actor, continentId, ['war-zone']))
      assert.deepEqual(replaced.map(law => law.name), ['war-zone'])

      const history = await database!.query<{
        actor_id: number
        change_type: 'add' | 'remove'
        name: string
      }>(
        `SELECT change.actor_id, change.change_type, trait.name
         FROM place_law_changes change
         JOIN traits trait ON trait.id = change.trait_id
         WHERE change.place_id = $1
         ORDER BY change.id`,
        [continentId],
      )
      assert.deepEqual(history.rows, [
        { actor_id: actor.id, change_type: 'add', name: 'quiet-hours' },
        { actor_id: actor.id, change_type: 'add', name: 'war-zone' },
        { actor_id: actor.id, change_type: 'remove', name: 'quiet-hours' },
        { actor_id: actor.id, change_type: 'add', name: 'war-zone' },
      ])
    })

    await t.test('withdrawThing persists a text reason inside JSON event detail', async () => {
      const thing = await database!.query<{ id: number }>(
        `INSERT INTO things (place_id, name, owner_id)
         VALUES ($1, 'temporary marker', $2)
         RETURNING id`,
        [continentId, actor.id],
      )
      const thingId = thing.rows[0]!.id

      const result = requireWithdrawal(await withdrawThing(actor, thingId, 'destroyed'))
      assert.equal(result.id, thingId)
      assert.ok(result.withdrawn_at)

      const persisted = await database!.query<{
        withdrawn_at: Date
        detail: { thing_id: number; reason: string }
        reason_type: string
      }>(
        `SELECT thing.withdrawn_at, event.detail,
                jsonb_typeof(event.detail->'reason') AS reason_type
         FROM things thing
         JOIN events event
           ON event.kind = 'thing_withdrawn'
          AND (event.detail->>'thing_id')::integer = thing.id
         WHERE thing.id = $1`,
        [thingId],
      )
      assert.equal(persisted.rowCount, 1)
      assert.ok(persisted.rows[0]!.withdrawn_at instanceof Date)
      assert.deepEqual(persisted.rows[0]!.detail, { thing_id: thingId, reason: 'destroyed' })
      assert.equal(persisted.rows[0]!.reason_type, 'string')
    })
  } finally {
    database = null
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
