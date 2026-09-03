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
import { resolveDueEffects, SHARED_SOURCE_MUTATION_ERROR } from '../../src/engine-effects.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'destroy_integration'
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
  const containerName = `1f3d9-destroy-test-${process.pid}-${randomBytes(4).toString('hex')}`
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

test('PostgreSQL fires a destroy brick: the source thing is withdrawn and one destroyed event is public', async () => {
  const postgres = await startPostgres()
  try {
    await postgres.client.query(schemaDdl)
    await postgres.client.query(`
      INSERT INTO residents (
        id, handle, model, secret_hash, things_today, notes_today, agreement_actions_today
      ) VALUES
        (1, 'destroy-owner', 'integration-test', repeat('1', 64), 0, 0, 0),
        (2, 'destroy-visitor', 'integration-test', repeat('2', 64), 0, 0, 0)
    `)
    const placeId = (await postgres.client.query<{ id: number }>(`
      INSERT INTO places (parent_id, place_kind, name, description, owner_id)
      SELECT id, 'continent', 'destroy-workshop', 'a place things get destroyed', 1
      FROM places WHERE place_kind = 'world'
      RETURNING id
    `)).rows[0]!.id
    await postgres.client.query(`
      INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
      VALUES (1, $1, $1), (2, $1, $1)
    `, [placeId])

    // A kind whose 'use' recipe destroys the thing itself (target: source),
    // exactly the shape a resident coins to make a one-use item.
    await postgres.client.query(`
      INSERT INTO traits (id, name, description, recipe, coiner_id)
      VALUES (1, 'self-destructing', 'destroys itself when used', '{"use":[{"effect":"destroy","target":"source"}]}'::jsonb, 1);
      INSERT INTO kinds (id, name, owner_id) VALUES (1, 'fuse', 1);
      INSERT INTO kind_revisions (kind_id, revision, description, traits)
      VALUES (1, 1, 'a fuse that burns out when used', ARRAY['self-destructing']);
    `)
    const ownedThingId = (await postgres.client.query<{ id: number }>(`
      INSERT INTO things (place_id, name, body, owner_id, maker_id, kind_id, birth_revision, current_revision)
      VALUES ($1, 'a lit fuse', 'burns down fast', 1, 1, 1, 1, 1)
      RETURNING id
    `, [placeId])).rows[0]!.id

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

    const destroyed = await runAction({
      actorId: 1,
      actorHandle: 'destroy-owner',
      action: 'use',
      placeId,
      sourceThingId: ownedThingId,
    }, db)
    assert.deepEqual(
      { status: destroyed.status, httpStatus: destroyed.httpStatus, error: destroyed.error, effectsApplied: destroyed.effectsApplied },
      { status: 'applied', httpStatus: 200, error: null, effectsApplied: 1 },
    )

    const thingRow = await postgres.client.query<{ withdrawn_at: string | null }>(
      'SELECT withdrawn_at FROM things WHERE id = $1',
      [ownedThingId],
    )
    assert.ok(thingRow.rows[0]?.withdrawn_at !== null, 'destroyed thing must be marked withdrawn')

    const publicEvents = await postgres.client.query<{
      kind: string
      actor: string
      thing_id: string
      reason: string
    }>(`
      SELECT kind, actor, detail->>'thing_id' AS thing_id, detail->>'reason' AS reason
      FROM events
      WHERE kind = 'thing_withdrawn'
        AND (detail->>'thing_id')::bigint = $1
      ORDER BY id
    `, [ownedThingId])
    assert.deepEqual(publicEvents.rows, [{
      kind: 'thing_withdrawn',
      actor: 'destroy-owner',
      thing_id: String(ownedThingId),
      reason: 'destroyed',
    }])
    // An action row never carries a detail.thing_id, so filtering on it (as
    // the assertion above does) would silently pass even if the suppressed
    // generic 'action' event regressed back into existence. Check for a
    // generic action event tied to this exact action_id instead.
    const actionEventForOwnedDestroy = await postgres.client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM events
       WHERE kind = 'action' AND (detail->>'action_id')::bigint = $1`,
      [destroyed.actionId],
    )
    assert.equal(actionEventForOwnedDestroy.rows[0]?.count, '0')

    // Non-owner shared-use refusal stays in force: a thing opened for shared
    // use still cannot be destroyed by anyone but its owner, and the earlier
    // fix must not have loosened that guard.
    const sharedThingId = (await postgres.client.query<{ id: number }>(`
      INSERT INTO things (
        place_id, name, body, owner_id, maker_id, kind_id, birth_revision, current_revision, open_to_use
      )
      VALUES ($1, 'a shared fuse', 'lent out for shared use', 1, 1, 1, 1, 1, TRUE)
      RETURNING id
    `, [placeId])).rows[0]!.id

    const refused = await runAction({
      actorId: 2,
      actorHandle: 'destroy-visitor',
      action: 'use',
      placeId,
      sourceThingId: sharedThingId,
    }, db)
    assert.equal(refused.status, 'failed')
    assert.equal(refused.httpStatus, 403)
    assert.equal(refused.error, SHARED_SOURCE_MUTATION_ERROR)

    const sharedThingRow = await postgres.client.query<{ withdrawn_at: string | null }>(
      'SELECT withdrawn_at FROM things WHERE id = $1',
      [sharedThingId],
    )
    assert.equal(sharedThingRow.rows[0]?.withdrawn_at, null)
    const sharedEvents = await postgres.client.query(`
      SELECT id FROM events
      WHERE kind = 'thing_withdrawn' AND (detail->>'thing_id')::bigint = $1
    `, [sharedThingId])
    assert.deepEqual(sharedEvents.rows, [])

    // The second, otherwise-identical faulty statement lives in the
    // law-authorized (non-owner) branch of destroyThing. Prove it too: a
    // local damage law lets a non-owner destroy another resident's thing,
    // and the public event must carry the ACTOR's handle, not the owner's,
    // which is exactly what makes the JOIN residents in that branch load-bearing.
    await postgres.client.query(`
      INSERT INTO traits (id, name, description, recipe, coiner_id)
      VALUES (2, 'war-zone', 'a local law that lets anyone break things here', '{"use":[{"effect":"destroy","target":"target"}]}'::jsonb, 1)
    `)
    await postgres.client.query(`
      INSERT INTO place_law_changes (place_id, trait_id, actor_id, change_type, position)
      VALUES ($1, 2, 1, 'add', 0)
    `, [placeId])
    const victimThingId = (await postgres.client.query<{ id: number }>(`
      INSERT INTO things (place_id, name, body, owner_id, maker_id)
      VALUES ($1, 'an unshielded pot', 'belongs to the owner, not the visitor', 1, 1)
      RETURNING id
    `, [placeId])).rows[0]!.id

    const lawDestroyed = await runAction({
      actorId: 2,
      actorHandle: 'destroy-visitor',
      action: 'use',
      placeId,
      target: { type: 'thing', id: victimThingId },
    }, db)
    assert.deepEqual(
      { status: lawDestroyed.status, httpStatus: lawDestroyed.httpStatus, error: lawDestroyed.error, effectsApplied: lawDestroyed.effectsApplied },
      { status: 'applied', httpStatus: 200, error: null, effectsApplied: 1 },
    )
    const victimThingRow = await postgres.client.query<{ withdrawn_at: string | null }>(
      'SELECT withdrawn_at FROM things WHERE id = $1',
      [victimThingId],
    )
    assert.ok(victimThingRow.rows[0]?.withdrawn_at !== null, 'law-authorized destroy must withdraw the target')
    const lawEvents = await postgres.client.query<{
      kind: string
      actor: string
      thing_id: string
      reason: string
    }>(`
      SELECT kind, actor, detail->>'thing_id' AS thing_id, detail->>'reason' AS reason
      FROM events
      WHERE kind = 'thing_withdrawn'
        AND (detail->>'thing_id')::bigint = $1
      ORDER BY id
    `, [victimThingId])
    assert.deepEqual(lawEvents.rows, [{
      kind: 'thing_withdrawn',
      actor: 'destroy-visitor',
      thing_id: String(victimThingId),
      reason: 'destroyed',
    }])
    // Same reasoning as above: check for a generic action event tied to this
    // exact action_id, not a thing_id-filtered slice an action row could
    // never match anyway.
    const actionEventForLawDestroy = await postgres.client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM events
       WHERE kind = 'action' AND (detail->>'action_id')::bigint = $1`,
      [lawDestroyed.actionId],
    )
    assert.equal(actionEventForLawDestroy.rows[0]?.count, '0')
  } finally {
    setEngineTransactionRunnerForTests(null)
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})

test('PostgreSQL fires a deferred destroy: the resolved thing_withdrawn event carries the acting resident, not an empty actor', async () => {
  const postgres = await startPostgres()
  try {
    await postgres.client.query(schemaDdl)
    await postgres.client.query(`
      INSERT INTO residents (
        id, handle, model, secret_hash, things_today, notes_today, agreement_actions_today
      ) VALUES (1, 'fuse-owner', 'integration-test', repeat('1', 64), 0, 0, 0)
    `)
    const placeId = (await postgres.client.query<{ id: number }>(`
      INSERT INTO places (parent_id, place_kind, name, description, owner_id)
      SELECT id, 'continent', 'slow-fuse-workshop', 'a place with a timed fuse', 1
      FROM places WHERE place_kind = 'world'
      RETURNING id
    `)).rows[0]!.id
    await postgres.client.query(`
      INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
      VALUES (1, $1, $1)
    `, [placeId])

    // A kind whose 'use' recipe waits one second, then destroys the thing
    // itself. This is the deferred path: the destroy runs later, out of
    // resolveOne rather than the synchronous action call, which is the only
    // reason destroyThing's law-authorized branch still needs the JOIN
    // residents to recover the acting resident's handle.
    await postgres.client.query(`
      INSERT INTO traits (id, name, description, recipe, coiner_id)
      VALUES (1, 'slow-fuse', 'destroys itself a second after being lit', '{"use":[{"effect":"wait","seconds":1,"then":[{"effect":"destroy","target":"source"}]}]}'::jsonb, 1);
      INSERT INTO kinds (id, name, owner_id) VALUES (1, 'timed-fuse', 1);
      INSERT INTO kind_revisions (kind_id, revision, description, traits)
      VALUES (1, 1, 'a fuse that burns out a second after use', ARRAY['slow-fuse']);
    `)
    const fuseThingId = (await postgres.client.query<{ id: number }>(`
      INSERT INTO things (place_id, name, body, owner_id, maker_id, kind_id, birth_revision, current_revision)
      VALUES ($1, 'a timed fuse', 'ticking down', 1, 1, 1, 1, 1)
      RETURNING id
    `, [placeId])).rows[0]!.id

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

    const lit = await runAction({
      actorId: 1,
      actorHandle: 'fuse-owner',
      action: 'use',
      placeId,
      sourceThingId: fuseThingId,
    }, db)
    assert.deepEqual(
      { status: lit.status, httpStatus: lit.httpStatus, error: lit.error, effectsApplied: lit.effectsApplied },
      { status: 'applied', httpStatus: 200, error: null, effectsApplied: 1 },
    )

    // The thing must still be alive: the destroy is deferred behind the wait,
    // not applied synchronously by the 'use' action above.
    const beforeResolve = await postgres.client.query<{ withdrawn_at: string | null }>(
      'SELECT withdrawn_at FROM things WHERE id = $1',
      [fuseThingId],
    )
    assert.equal(beforeResolve.rows[0]?.withdrawn_at, null)

    // pending_effects is append-only: there is no back-dating due_at to make
    // this due sooner. Wait past the real one-second timer before resolving.
    await delay(1_600)

    assert.deepEqual(
      await resolveDueEffects(placeId, db),
      { resolved: 1, failed: 0, capped: false },
    )

    const afterResolve = await postgres.client.query<{ withdrawn_at: string | null }>(
      'SELECT withdrawn_at FROM things WHERE id = $1',
      [fuseThingId],
    )
    assert.ok(afterResolve.rows[0]?.withdrawn_at !== null, 'deferred destroy must withdraw the fuse once it resolves')

    const withdrawnEvent = await postgres.client.query<{
      kind: string
      actor: string
      thing_id: string
      reason: string
    }>(`
      SELECT kind, actor, detail->>'thing_id' AS thing_id, detail->>'reason' AS reason
      FROM events
      WHERE kind = 'thing_withdrawn'
        AND (detail->>'thing_id')::bigint = $1
      ORDER BY id
    `, [fuseThingId])
    assert.deepEqual(withdrawnEvent.rows, [{
      kind: 'thing_withdrawn',
      actor: 'fuse-owner',
      thing_id: String(fuseThingId),
      reason: 'destroyed',
    }])
  } finally {
    setEngineTransactionRunnerForTests(null)
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
