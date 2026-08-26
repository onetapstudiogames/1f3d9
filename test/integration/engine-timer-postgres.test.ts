import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Client, type ClientConfig } from 'pg'

import {
  executeEffects,
  resolveDueEffects,
  type EffectExecutionContext,
} from '../../src/engine-effects.ts'
import { EngineError, runAction, type TaggedSql } from '../../src/engine.ts'

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

async function startPostgres(): Promise<{
  client: Client
  clientConfig: ClientConfig
  containerName: string
}> {
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
    const clientConfig: ClientConfig = {
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password,
      database: POSTGRES_DATABASE,
      ssl: false,
    }
    const deadline = Date.now() + 30_000
    let lastError: unknown = null
    while (Date.now() < deadline) {
      const client = new Client(clientConfig)
      try {
        await client.connect()
        return { client, clientConfig, containerName }
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

function taggedSql(
  client: Client,
  beforeQuery?: (text: string) => Promise<void>,
): TaggedSql {
  return (async (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
    const text = strings.reduce(
      (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ''),
      '',
    )
    await beforeQuery?.(text)
    return (await client.query(text, [...values])).rows
  }) as TaggedSql
}

test('shared use and wait effects execute against PostgreSQL', async () => {
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
      sharedSourceThingId: null,
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

    const invalidPendingId = (await postgres.client.query<{ id: number }>(`
      INSERT INTO pending_effects (place_id, actor_id, payload, due_at)
      VALUES ($1, 1, '{}'::jsonb, now())
      RETURNING id
    `, [placeId])).rows[0]!.id
    assert.deepEqual(
      await resolveDueEffects(placeId, db),
      { resolved: 0, failed: 1, capped: false },
    )
    const skipped = await postgres.client.query(`
      SELECT resolution.status, resolution.detail->>'error' AS stored_error,
        resolved.detail->>'error' AS published_error
      FROM effect_resolutions resolution
      JOIN events resolved ON resolved.kind = 'effect_resolved'
        AND (resolved.detail->>'effect_id')::bigint = resolution.pending_effect_id
      WHERE resolution.pending_effect_id = $1
    `, [invalidPendingId])
    assert.deepEqual(skipped.rows, [{
      status: 'skipped',
      stored_error: 'invalid stored effect payload',
      published_error: 'invalid stored effect payload',
    }])

    await postgres.client.query(`
      INSERT INTO residents (id, handle, model, secret_hash)
      VALUES (2, 'timer-visitor', 'integration-test', repeat('2', 64))
    `)
    await postgres.client.query(`
      INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
      VALUES (2, $1, NULL)
    `, [placeId])
    await postgres.client.query(`
      INSERT INTO traits (id, name, description, recipe, coiner_id)
      VALUES (
        1,
        'welcoming',
        'labels a visitor',
        '{"use":[{"effect":"label","target":"actor","label":"welcomed"}]}'::jsonb,
        1
      );
      INSERT INTO kinds (id, name, owner_id) VALUES (1, 'visitor-bell', 1);
      INSERT INTO kind_revisions (kind_id, revision, traits)
      VALUES (1, 1, ARRAY['welcoming']);
    `)
    await postgres.client.query(`
      INSERT INTO things (
        id, place_id, name, body, owner_id, maker_id, open_to_use,
        kind_id, birth_revision, current_revision
      ) VALUES (1, $1, 'visitor bell', 'ring me', 1, 1, true, 1, 1, 1);
    `, [placeId])

    const sharedUse = await runAction({
      actorId: 2,
      actorHandle: 'timer-visitor',
      action: 'use',
      placeId,
      sourceThingId: 1,
    }, db)
    assert.equal(sharedUse.status, 'applied')
    const welcomed = await postgres.client.query(`
      SELECT EXISTS (
        SELECT 1 FROM active_labels
        WHERE target_type = 'resident' AND target_id = 2 AND label = 'welcomed'
      ) AS present
    `)
    assert.deepEqual(welcomed.rows, [{ present: true }])

    await postgres.client.query(`
      UPDATE traits SET recipe = '{
        "use":[{
          "effect":"block",
          "target":"actor",
          "action":"move",
          "seconds":60
        }]
      }'::jsonb
      WHERE id = 1
    `)
    const blockedByThing = await runAction({
      actorId: 2,
      actorHandle: 'timer-visitor',
      action: 'use',
      placeId,
      sourceThingId: 1,
    }, db)
    assert.equal(blockedByThing.status, 'applied')

    const blockedMove = await runAction({
      actorId: 2,
      actorHandle: 'timer-visitor',
      action: 'move',
      placeId,
      destinationPlaceId: placeId,
    }, db)
    assert.equal(blockedMove.status, 'blocked')
    assert.equal(
      blockedMove.error,
      'move is temporarily blocked by thing trait "welcoming" from thing_id 1',
    )

    await postgres.client.query(`
      INSERT INTO moderation_actions (
        target_type, target_id, action, actor_id, reason
      ) VALUES ('trait', 1, 'remove', 1, 'integration moderation check')
    `)
    const blockedAfterRemoval = await runAction({
      actorId: 2,
      actorHandle: 'timer-visitor',
      action: 'move',
      placeId,
      destinationPlaceId: placeId,
    }, db)
    assert.equal(blockedAfterRemoval.status, 'blocked')
    assert.equal(
      blockedAfterRemoval.error,
      'move is temporarily blocked by thing trait_id 1 from thing_id 1; its name is unavailable',
    )
    assert.doesNotMatch(blockedAfterRemoval.error ?? '', /welcoming/u)

    await postgres.client.query(`
      INSERT INTO traits (id, name, description, recipe, coiner_id)
      VALUES
        (2, 'late-law', 'adopted after its block was created', NULL, 1),
        (3, 'retired-law', 'removed before its block was created', NULL, 1);

      INSERT INTO active_blocks (
        resident_id, action_name, actor_id, source_trait_id, source_place_id,
        expires_at, created_at
      ) VALUES
        (1, 'talk', 1, 2, ${placeId}, now() + interval '1 hour', now() - interval '4 hours'),
        (1, 'make', 1, 3, ${placeId}, now() + interval '1 hour', now() - interval '2 hours');

      INSERT INTO place_law_changes (
        place_id, trait_id, actor_id, change_type, position, created_at
      ) VALUES
        (${placeId}, 2, 1, 'add', 0, now() - interval '3 hours'),
        (${placeId}, 3, 1, 'add', 1, now() - interval '4 hours'),
        (${placeId}, 3, 1, 'remove', NULL, now() - interval '3 hours');
    `)

    const lateLawBlock = await runAction({
      actorId: 1,
      actorHandle: 'timer-tester',
      action: 'talk',
      placeId,
    }, db)
    assert.equal(lateLawBlock.status, 'blocked')
    assert.equal(
      lateLawBlock.error,
      'talk is temporarily blocked by trait "late-law"; its source is unavailable',
    )

    const retiredLawBlock = await runAction({
      actorId: 1,
      actorHandle: 'timer-tester',
      action: 'make',
      placeId,
    }, db)
    assert.equal(retiredLawBlock.status, 'blocked')
    assert.equal(
      retiredLawBlock.error,
      'make is temporarily blocked by trait "retired-law"; its source is unavailable',
    )

    await postgres.client.query(`
      UPDATE traits SET recipe = '{
        "use":[{
          "effect":"wait",
          "seconds":10,
          "then":[{"effect":"destroy","target":"target"}]
        }]
      }'::jsonb
      WHERE id = 1
    `)
    const destructiveAlias = await runAction({
      actorId: 2,
      actorHandle: 'timer-visitor',
      action: 'use',
      placeId,
      sourceThingId: 1,
      target: { type: 'thing', id: 1 },
    }, db)
    assert.equal(destructiveAlias.status, 'failed')
    assert.equal(destructiveAlias.httpStatus, 403)

    const consume = await runAction({
      actorId: 2,
      actorHandle: 'timer-visitor',
      action: 'consume',
      placeId,
      sourceThingId: 1,
    }, db)
    assert.equal(consume.status, 'failed')
    assert.equal(consume.httpStatus, 403)
    const protectedSource = await postgres.client.query(`
      SELECT withdrawn_at, (
        SELECT count(*)::int FROM pending_effects pending
        WHERE NOT EXISTS (
          SELECT 1 FROM effect_resolutions resolution
          WHERE resolution.pending_effect_id = pending.id
        )
      ) AS unresolved_pending
      FROM things WHERE id = 1
    `)
    assert.deepEqual(protectedSource.rows, [{ withdrawn_at: null, unresolved_pending: 0 }])

    const raceDestinations = await postgres.client.query<{ id: number; name: string }>(`
      INSERT INTO places (parent_id, place_kind, name, description, owner_id)
      VALUES
        ($1, 'place', 'first-race-destination', 'first stale move destination', 1),
        ($1, 'place', 'second-race-destination', 'winning move destination', 1)
      RETURNING id, name
    `, [placeId])
    const firstDestinationId = raceDestinations.rows.find(
      row => row.name === 'first-race-destination',
    )!.id
    const secondDestinationId = raceDestinations.rows.find(
      row => row.name === 'second-race-destination',
    )!.id
    const racedThingId = (await postgres.client.query<{ id: number }>(`
      INSERT INTO things (id, place_id, name, body, owner_id, maker_id)
      VALUES (2, $1, 'race token', 'moves only once', 1, 1)
      RETURNING id
    `, [placeId])).rows[0]!.id

    const firstMoveClient = new Client(postgres.clientConfig)
    const secondMoveClient = new Client(postgres.clientConfig)
    let markFirstMoveReady!: () => void
    let releaseFirstMove!: () => void
    const firstMoveReady = new Promise<void>(resolve => {
      markFirstMoveReady = resolve
    })
    const firstMoveGate = new Promise<void>(resolve => {
      releaseFirstMove = resolve
    })
    let firstMove: Promise<number> | null = null
    try {
      await Promise.all([firstMoveClient.connect(), secondMoveClient.connect()])
      await Promise.all([
        firstMoveClient.query('BEGIN'),
        secondMoveClient.query('BEGIN'),
      ])

      const firstMoveDb = taggedSql(firstMoveClient, async text => {
        if (!/UPDATE things moving SET place_id/.test(text)) return
        markFirstMoveReady()
        await firstMoveGate
      })
      const secondMoveDb = taggedSql(secondMoveClient)
      const raceContext: EffectExecutionContext = {
        ...context,
        sourceThingId: racedThingId,
        logicalAt: new Date(),
      }
      const moveSource = [{ effect: 'move', target: 'source', to: 'destination' }] as const

      firstMove = executeEffects(moveSource, {
        ...raceContext,
        destinationPlaceId: firstDestinationId,
      }, firstMoveDb)
      const firstMoveEndedEarly = firstMove.then(
        () => {
          throw new Error('first move finished before reaching its guarded update')
        },
        (error: unknown) => {
          throw error
        },
      )
      await Promise.race([
        firstMoveReady,
        firstMoveEndedEarly,
        delay(5_000, undefined, { ref: false }).then(() => {
          throw new Error('first move did not reach its guarded update')
        }),
      ])

      assert.equal(await executeEffects(moveSource, {
        ...raceContext,
        destinationPlaceId: secondDestinationId,
      }, secondMoveDb), 1)
      await secondMoveClient.query('COMMIT')
      releaseFirstMove()

      await assert.rejects(firstMove, (error: unknown) => (
        error instanceof EngineError
        && error.status === 409
        && error.message === 'thing or destination changed before the move'
      ))
      await firstMoveClient.query('ROLLBACK')

      const racedThing = await postgres.client.query<{ place_id: number }>(`
        SELECT place_id FROM things WHERE id = $1
      `, [racedThingId])
      assert.deepEqual(racedThing.rows, [{ place_id: secondDestinationId }])
      const moveEvents = await postgres.client.query<{
        from_place_id: string
        place_id: string
      }>(`
        SELECT detail->>'from_place_id' AS from_place_id,
          detail->>'place_id' AS place_id
        FROM events
        WHERE kind = 'thing_moved' AND (detail->>'thing_id')::integer = $1
        ORDER BY id
      `, [racedThingId])
      assert.deepEqual(moveEvents.rows, [{
        from_place_id: String(placeId),
        place_id: String(secondDestinationId),
      }])
    } finally {
      releaseFirstMove()
      await secondMoveClient.query('ROLLBACK').catch(() => undefined)
      await firstMove?.catch(() => undefined)
      await firstMoveClient.query('ROLLBACK').catch(() => undefined)
      await Promise.all([
        firstMoveClient.end().catch(() => undefined),
        secondMoveClient.end().catch(() => undefined),
      ])
    }
  } finally {
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
