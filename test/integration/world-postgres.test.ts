import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Client } from 'pg'

import type { Resident } from '../../src/core.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'world_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')

let database: Client | null = null

const sql = async (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): Promise<Record<string, unknown>[]> => {
  assert.ok(database, 'the PostgreSQL test client must be connected')
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

async function resetDatabase(): Promise<void> {
  assert.ok(database)
  await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await database.query(schemaDdl)
  await database.query(`
    INSERT INTO residents (id, handle, model, secret_hash) VALUES
      (1, 'founder', 'integration-test', repeat('1', 64)),
      (2, 'neighbor', 'integration-test', repeat('2', 64));
    INSERT INTO places (id, name, description, owner_id)
      VALUES (1, 'test-room', 'a test room', 1);
    INSERT INTO traits (id, name, description, coiner_id)
      VALUES (1, 'peaceful', 'quiet conduct', 1);
    INSERT INTO things (id, place_id, name, body, owner_id)
      VALUES (1, 1, 'test-object', 'still here', 1);
  `)
}

test('world mutations plan and commit atomically in PostgreSQL', async t => {
  const postgres = await startPostgres()
  database = postgres.client
  try {
    const { replacePlaceLaws } = await import('../../src/laws.ts')
    const { withdrawThing } = await import('../../src/withdrawal.ts')

    await t.test('law replacement keeps typed actor IDs and append-only history', async () => {
      await resetDatabase()
      const result = await replacePlaceLaws(actor, 1, ['peaceful'])
      assert.equal('error' in result, false)
      assert.deepEqual(result, [{ id: 1, name: 'peaceful', position: 0 }])
      const history = await database!.query(`
        SELECT change.actor_id, change.change_type, change.position, event.kind
        FROM place_law_changes change
        JOIN events event ON event.kind = 'laws_changed'
      `)
      assert.deepEqual(history.rows, [{ actor_id: 1, change_type: 'add', position: 0, kind: 'laws_changed' }])
})
    await t.test('withdrawal writes the timestamp and event in one statement', async () => {
      await resetDatabase()
      const result = await withdrawThing(actor, 1)
      assert.equal('error' in result, false)
      assert.ok(Number.isFinite(Date.parse(String('withdrawn_at' in result ? result.withdrawn_at : ''))))
      const state = await database!.query(`
        SELECT thing.withdrawn_at IS NOT NULL AS withdrawn,
          event.kind, event.detail->>'reason' AS reason
        FROM things thing
        JOIN events event ON (event.detail->>'thing_id')::integer = thing.id
        WHERE thing.id = 1
      `)
      assert.deepEqual(state.rows, [{ withdrawn: true, kind: 'thing_withdrawn', reason: 'withdrawn' }])
    })
  } finally {
    database = null
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
