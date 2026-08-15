import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Client } from 'pg'

import {
  executeEffects,
  resolveDueEffects,
  type EffectExecutionContext,
} from '../../src/engine-effects.ts'
import type { TaggedSql } from '../../src/engine.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'engine_timer_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ client: Client; containerName: string }> {
  const containerName = `1f3d9-engine-timer-test-${process.pid}-${randomBytes(4).toString('hex')}`
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

function taggedSql(client: Client): TaggedSql {
  return (async (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
    const text = strings.reduce(
      (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ''),
      '',
    )
    return (await client.query(text, [...values])).rows
  }) as TaggedSql
}

test('wait effects schedule and resolve against PostgreSQL', async () => {
  const postgres = await startPostgres()
  try {
    await postgres.client.query(schemaDdl)
    await postgres.client.query(`
      INSERT INTO residents (id, handle, model, secret_hash)
      VALUES (1, 'timer-tester', 'integration-test', repeat('1', 64));
    `)
    const placeResult = await postgres.client.query<{ id: number }>(`
      INSERT INTO places (parent_id, place_kind, name, description, owner_id)
      SELECT id, 'continent', 'clock-room', 'where time advances', 1
      FROM places WHERE place_kind = 'world'
      RETURNING id
    `)
    const placeId = placeResult.rows[0]!.id
    await postgres.client.query(`
      INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
      VALUES ($1, $2, $2)
    `, [1, placeId])

    const db = taggedSql(postgres.client)
    const context: EffectExecutionContext = {
      actionId: null,
      actorId: 1,
      actorHandle: 'timer-tester',
      placeId,
      sourceThingId: null,
      target: null,
      destinationPlaceId: null,
      recipientId: null,
      sourceTraitId: null,
      lawAuthority: null,
      parentEffectId: null,
      generation: 0,
      logicalAt: new Date(Date.now() - 5_000),
    }

    const scheduled = await executeEffects([{
      effect: 'wait',
      seconds: 1,
      then: [{ effect: 'label', target: 'actor', label: 'timer-fired' }],
    }], context, db)
    assert.equal(scheduled, 1)

    const pending = await postgres.client.query(`
      SELECT pending.id, scheduled.kind, scheduled.detail->>'place_id' AS place_id
      FROM pending_effects pending
      JOIN events scheduled ON scheduled.kind = 'effect_scheduled'
        AND (scheduled.detail->>'effect_id')::bigint = pending.id
    `)
    assert.deepEqual(pending.rows, [{
      id: '1', kind: 'effect_scheduled', place_id: String(placeId),
    }])

    assert.deepEqual(
      await resolveDueEffects(placeId, db),
      { resolved: 1, failed: 0, capped: false },
    )

    const outcome = await postgres.client.query(`
      SELECT resolution.status, resolution.detail->>'effects_applied' AS effects_applied,
        resolved.kind, resolved.detail->>'status' AS event_status,
        EXISTS (
          SELECT 1 FROM active_labels
          WHERE target_type = 'resident' AND target_id = 1 AND label = 'timer-fired'
        ) AS label_applied
      FROM effect_resolutions resolution
      JOIN events resolved ON resolved.kind = 'effect_resolved'
        AND (resolved.detail->>'effect_id')::bigint = resolution.pending_effect_id
    `)
    assert.deepEqual(outcome.rows, [{
      status: 'applied',
      effects_applied: '1',
      kind: 'effect_resolved',
      event_status: 'applied',
      label_applied: true,
    }])
  } finally {
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
