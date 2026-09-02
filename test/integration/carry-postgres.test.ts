import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Client, type ClientConfig } from 'pg'

import {
  runAction,
  setEngineTransactionRunnerForTests,
  type TaggedSql,
} from '../../src/engine.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'carry_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{
  client: Client
  containerName: string
}> {
  const containerName = `1f3d9-carry-test-${process.pid}-${randomBytes(4).toString('hex')}`
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
    const config: ClientConfig = {
      host: '127.0.0.1', port, user: 'postgres', password,
      database: POSTGRES_DATABASE, ssl: false,
    }
    const deadline = Date.now() + 30_000
    let lastError: unknown = null
    while (Date.now() < deadline) {
      const client = new Client(config)
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

function taggedSql(client: Client): TaggedSql {
  return (async (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
    const text = strings.reduce(
      (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ''),
      '',
    )
    return (await client.query(text, [...values])).rows
  }) as TaggedSql
}

test('PostgreSQL carries resident and thing atomically with both movement records', async () => {
  const postgres = await startPostgres()
  try {
    await postgres.client.query(schemaDdl)
    await postgres.client.query(`
      INSERT INTO residents (
        id, handle, model, secret_hash, things_today, notes_today, agreement_actions_today
      ) VALUES
        (1, 'carry-tester', 'integration-test', repeat('1', 64), 5, 4, 3),
        (2, 'original-maker', 'integration-test', repeat('2', 64), 0, 0, 0)
    `)
    const originId = (await postgres.client.query<{ id: number }>(`
      INSERT INTO places (parent_id, place_kind, name, description, owner_id)
      SELECT id, 'continent', 'carry-origin', 'origin', 1
      FROM places WHERE place_kind = 'world'
      RETURNING id
    `)).rows[0]!.id
    const destinationId = (await postgres.client.query<{ id: number }>(`
      INSERT INTO places (parent_id, place_kind, name, description, owner_id)
      VALUES ($1, 'place', 'carry-destination', 'destination', 1)
      RETURNING id
    `, [originId])).rows[0]!.id
    await postgres.client.query(`
      INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
      VALUES (1, $1, $1)
    `, [originId])
    const carriedThingId = (await postgres.client.query<{ id: number }>(`
      INSERT INTO things (place_id, name, body, owner_id, maker_id)
      VALUES ($1, 'carried parcel', 'keeps its provenance', 2, 2)
      RETURNING id
    `, [originId])).rows[0]!.id
    await postgres.client.query('UPDATE things SET owner_id = 1 WHERE id = $1', [carriedThingId])

    const db = taggedSql(postgres.client)
    setEngineTransactionRunnerForTests(async (_ignored, work) => {
      await postgres.client.query('BEGIN')
      try {
        const result = await work(taggedSql(postgres.client), true)
        await postgres.client.query('COMMIT')
        return result
      } catch (error) {
        await postgres.client.query('ROLLBACK')
        throw error
      }
    })

    const carried = await runAction({
      actorId: 1,
      actorHandle: 'carry-tester',
      action: 'move',
      placeId: originId,
      destinationPlaceId: destinationId,
      carryThingId: carriedThingId,
    }, db)
    assert.deepEqual(
      { status: carried.status, httpStatus: carried.httpStatus, effectsApplied: carried.effectsApplied },
      { status: 'applied', httpStatus: 200, effectsApplied: 0 },
    )

    const committed = await postgres.client.query<{
      resident_place_id: number
      thing_place_id: number
      owner_id: number
      maker_id: number
      things_today: number
      notes_today: number
      agreement_actions_today: number
    }>(`
      SELECT presence.current_place_id AS resident_place_id,
        thing.place_id AS thing_place_id, thing.owner_id, thing.maker_id,
        resident.things_today, resident.notes_today, resident.agreement_actions_today
      FROM resident_presence presence
      JOIN residents resident ON resident.id = presence.resident_id
      JOIN things thing ON thing.id = $1
      WHERE presence.resident_id = 1
    `, [carriedThingId])
    assert.deepEqual(committed.rows, [{
      resident_place_id: destinationId,
      thing_place_id: destinationId,
      owner_id: 1,
      maker_id: 2,
      things_today: 5,
      notes_today: 4,
      agreement_actions_today: 3,
    }])

    const movement = await postgres.client.query<{
      kind: string
      action_id: string
      thing_id: string
      mode: string
      from_place_id: string
      to_place_id: string | null
      place_id: string | null
    }>(`
      SELECT kind, detail->>'action_id' AS action_id,
        detail->>'thing_id' AS thing_id, detail->>'mode' AS mode,
        detail->>'from_place_id' AS from_place_id,
        detail->>'to_place_id' AS to_place_id,
        detail->>'place_id' AS place_id
      FROM events
      WHERE (kind = 'action' AND (detail->>'action_id')::bigint = $1)
         OR (kind = 'thing_moved' AND (detail->>'action_id')::bigint = $1)
      ORDER BY id
    `, [carried.actionId])
    assert.deepEqual(movement.rows, [
      {
        kind: 'thing_moved', action_id: String(carried.actionId),
        thing_id: String(carriedThingId), mode: 'carry',
        from_place_id: String(originId), to_place_id: null,
        place_id: String(destinationId),
      },
      {
        kind: 'action', action_id: String(carried.actionId),
        thing_id: String(carriedThingId), mode: 'carry',
        from_place_id: String(originId), to_place_id: String(destinationId),
        place_id: null,
      },
    ])

    await postgres.client.query(
      'UPDATE resident_presence SET current_place_id = $1 WHERE resident_id = 1',
      [originId],
    )
    const rollbackThingId = (await postgres.client.query<{ id: number }>(`
      INSERT INTO things (place_id, name, body, owner_id, maker_id)
      VALUES ($1, 'rollback parcel', 'must stay put', 1, 1)
      RETURNING id
    `, [originId])).rows[0]!.id
    await postgres.client.query(`
      CREATE OR REPLACE FUNCTION reject_fixture_carry() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = ${rollbackThingId} AND NEW.place_id = ${destinationId} THEN
          RAISE EXCEPTION 'fixture rejects carry update';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_fixture_carry
      BEFORE UPDATE OF place_id ON things
      FOR EACH ROW EXECUTE FUNCTION reject_fixture_carry();
    `)

    const refused = await runAction({
      actorId: 1,
      actorHandle: 'carry-tester',
      action: 'move',
      placeId: originId,
      destinationPlaceId: destinationId,
      carryThingId: rollbackThingId,
    }, db)
    assert.equal(refused.status, 'failed')
    assert.equal(refused.httpStatus, 500)
    const rolledBack = await postgres.client.query(`
      SELECT presence.current_place_id AS resident_place_id,
        thing.place_id AS thing_place_id
      FROM resident_presence presence
      JOIN things thing ON thing.id = $1
      WHERE presence.resident_id = 1
    `, [rollbackThingId])
    assert.deepEqual(rolledBack.rows, [{
      resident_place_id: originId,
      thing_place_id: originId,
    }])
    const leakedMovement = await postgres.client.query(`
      SELECT kind FROM events
      WHERE kind = 'thing_moved' AND (detail->>'action_id')::bigint = $1
    `, [refused.actionId])
    assert.deepEqual(leakedMovement.rows, [])
  } finally {
    setEngineTransactionRunnerForTests(null)
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
