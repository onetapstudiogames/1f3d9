import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Client, type ClientConfig } from 'pg'

import type { EffectExecutionContext } from '../../src/engine-effects.ts'
import type { TaggedSql } from '../../src/engine.ts'
import type { Effect } from '../../src/physics.ts'

let routeDb: TaggedSql | null = null
const routeSql = (async (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
  assert.ok(routeDb, 'the route must use the disposable PostgreSQL connection')
  return routeDb(strings, ...values)
}) as TaggedSql
routeSql.query = async (text, values = []) => {
  assert.ok(routeDb?.query, 'the route must use the disposable PostgreSQL connection')
  return routeDb.query(text, values)
}
mock.module(new URL('../../src/db.ts', import.meta.url).href, {
  namedExports: { sql: routeSql, runtimeDatabaseUrl: () => 'postgresql://integration-test.invalid/timer' },
})
const { executeEffects, resolveDueEffects } = await import('../../src/engine-effects.ts')
const { EngineError, ensurePresence, lockPlaceRowsTopDown, moveResident, runAction,
  setEngineTransactionRunnerForTests } = await import('../../src/engine.ts')
const { ensureChanceDays } = await import('../../src/engine-chance.ts')

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
  afterQuery?: (text: string, client: Client) => Promise<void>,
): TaggedSql {
  const sql = (async (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
    const text = strings.reduce(
      (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ''),
      '',
    )
    await beforeQuery?.(text)
    const result = await client.query(text, [...values])
    await afterQuery?.(text, client)
    return result.rows
  }) as TaggedSql
  // Text queries, as the gift route and place lifecycle send them, pass the same hooks.
  sql.query = async (text, values = []) => {
    await beforeQuery?.(text)
    const result = await client.query(text, [...values])
    await afterQuery?.(text, client)
    return result.rows
  }
  return sql
}

for (const contender of ['same resident', 'another resident movement effect'] as const) {
test(`public activity concurrent actions and their observations both apply without deadlock: ${contender}`, async t => {
  const postgres = await startPostgres()
  const client = postgres.client
  const requests = new AsyncLocalStorage<number>()
  const sqlstates: string[] = []
  const observationErrors: unknown[][] = []
  const barrier = () => {
    let reached!: () => void
    let release!: () => void
    const ready = new Promise<void>(resolve => { reached = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    return { ready, gate, reached, release }
  }
  const observing = barrier()
  const roomLocked = barrier()
  let firstApplied = false
  let observationStarted = false
  let contenderPaused = false
  let firstFinished = false
  let first: Promise<Response> | undefined
  let second: Promise<Response> | undefined
  const captureSqlstate = (error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error) sqlstates.push(String(error.code))
  }
  const atBarrier = async (ready: Promise<void>, operation: Promise<unknown>) => {
    await Promise.race([ready, operation.then(() => {
      throw new Error('the action completed before reaching its planned pause')
    }), delay(5_000, undefined, { ref: false }).then(() => {
      throw new Error('the action did not reach its planned pause')
    })])
  }
  const routeQuery = async (text: string, values: readonly unknown[] = []) => {
    const connection = new Client({
      ...postgres.clientConfig, application_name: `activity-request-${requests.getStore()}`,
    })
    await connection.connect()
    try {
      await connection.query("SET statement_timeout = '8s'")
      if (requests.getStore() === 1 && firstApplied && !observationStarted
        && /resident_presence/.test(text)) {
        observationStarted = true
        observing.reached()
        await observing.gate
      }
      return (await connection.query(text, [...values])).rows
    } catch (error) {
      captureSqlstate(error)
      throw error
    } finally {
      await connection.end()
    }
  }
  routeDb = (async (strings: TemplateStringsArray, ...values: readonly unknown[]) => (
    routeQuery(strings.reduce((text, part, index) => text + part
      + (index < values.length ? `$${index + 1}` : ''), ''), values)
  )) as TaggedSql
  routeDb.query = routeQuery
  setEngineTransactionRunnerForTests(async (_ignored, work) => {
    const request = requests.getStore()
    const connection = new Client({ ...postgres.clientConfig, application_name: `activity-action-${request}` })
    await connection.connect()
    let resolvedAction = false
    try {
      await connection.query("SET statement_timeout = '8s'")
      await connection.query('BEGIN')
      const transaction = taggedSql(connection, undefined, async text => {
        if (/INSERT INTO action_resolutions/.test(text)) resolvedAction = true
        if (request === 2 && !contenderPaused && /WITH RECURSIVE/.test(text)
          && /FOR NO KEY UPDATE OF place/.test(text)) {
          contenderPaused = true
          roomLocked.reached()
          await roomLocked.gate
        }
      })
      const result = await work(transaction, true)
      await connection.query('COMMIT')
      if (request === 1 && resolvedAction) firstApplied = true
      return result
    } catch (error) {
      captureSqlstate(error)
      await connection.query('ROLLBACK')
      throw error
    } finally {
      await connection.end()
    }
  })
  t.mock.method(console, 'error', (...args: unknown[]) => { observationErrors.push(args) })
  try {
    await client.query(schemaDdl)
    const secret = `1f3d9_sk_${randomBytes(24).toString('hex')}`
    await client.query(`
      INSERT INTO residents (id, handle, model, secret_hash)
      VALUES (1, 'activity-actor', 'test', $1)
    `, [createHash('sha256').update(secret, 'utf8').digest('hex')])
    const moverSecret = `1f3d9_sk_${randomBytes(24).toString('hex')}`
    await client.query(`
      INSERT INTO residents (id, handle, model, secret_hash)
      VALUES (2, 'activity-mover', 'test', $1)
    `, [createHash('sha256').update(moverSecret, 'utf8').digest('hex')])
    const room = (await client.query(`
      INSERT INTO places (parent_id, place_kind, name, description, owner_id)
      SELECT id, 'continent', 'activity-room', 'concurrent public actions', 1
      FROM places WHERE place_kind = 'world' RETURNING id
    `)).rows[0].id
    const destination = (await client.query(`
      INSERT INTO places (parent_id, place_kind, name, description, owner_id)
      VALUES ($1, 'place', 'activity-destination', 'a movement effect ends here', 1) RETURNING id
    `, [room])).rows[0].id
    await client.query(`
      INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
      VALUES (1, $1, NULL), (2, $1, NULL)
    `, [room])
    await client.query(`
      INSERT INTO traits (id, name, description, recipe, coiner_id)
      VALUES (1, 'activity-law', 'records each use',
        '{"use":[{"effect":"label","target":"place","label":"activity-mark"}]}'::jsonb, 1)
    `)
    await client.query(`
      INSERT INTO place_law_changes (place_id, trait_id, actor_id, change_type, position)
      VALUES ($1, 1, 1, 'add', 0)
    `, [room])
    const thing = (await client.query(`
      INSERT INTO things (place_id, name, body, owner_id, maker_id, open_to_use)
      VALUES ($1, 'activity-bell', 'used twice', 1, 1, true) RETURNING id
    `, [room])).rows[0].id
    const { Hono } = await import('hono')
    const { mountActionRoutes } = await import('../../src/actions.ts')
    const app = new Hono()
    mountActionRoutes(app)
    const act = (request: number) => requests.run(request, async () => app.request('/api/action', {
      method: 'POST',
      headers: { authorization: `Bearer ${request === 2 && contender !== 'same resident' ? moverSecret : secret}`,
        'content-type': 'application/json' },
      body: JSON.stringify({ action: 'use', thing_id: thing,
        ...(request === 2 && contender !== 'same resident'
          ? { target_type: 'resident', target_id: 1, to_place_id: destination } : {}) }),
    }))
    first = act(1).then(response => { firstFinished = true; return response })
    await atBarrier(observing.ready, first)
    if (contender !== 'same resident') {
      await client.query(`
        UPDATE traits SET recipe = '{"use":[{"effect":"move","target":"target","to":"destination"}]}'::jsonb
        WHERE id = 1
      `)
    }
    second = act(2)
    await atBarrier(roomLocked.ready, second)
    // The old observation holds presence then waits on the room. The fixed read
    // completes while the other action holds its ordinary room lock.
    observing.release()
    const deadline = Date.now() + 3_000
    let observationWaiting = false
    while (!firstFinished && Date.now() < deadline) {
      observationWaiting = (await client.query(`
        SELECT 1 FROM pg_stat_activity waiting
        JOIN pg_stat_activity holder ON holder.pid = ANY(pg_blocking_pids(waiting.pid))
        WHERE waiting.application_name = 'activity-request-1'
          AND holder.application_name = 'activity-action-2' AND waiting.wait_event_type = 'Lock'
      `)).rows.length > 0
      if (observationWaiting) break
      await delay(20)
    }
    assert.ok(firstFinished || observationWaiting, 'the observation must complete or wait on the locked room')
    roomLocked.release()
    const responses = await Promise.all([first, second])
    const bodies = await Promise.all(responses.map(response => response.json()))
    assert.deepEqual(sqlstates, [], 'neither action nor its observation may deadlock or retry')
    assert.deepEqual(observationErrors, [], 'post-action observation must complete without a swallowed error')
    assert.deepEqual(responses.map(response => response.status), [200, 200], JSON.stringify(bodies))
    assert.deepEqual(bodies.map(body => body.action.status), ['applied', 'applied'])
    assert.deepEqual((await client.query(`
      SELECT current_place_id FROM resident_presence WHERE resident_id IN (1, 2) ORDER BY resident_id
    `)).rows.map(row => row.current_place_id), [contender === 'same resident' ? room : destination, room])
    assert.deepEqual((await client.query(`
      SELECT resident.last_public_action_at IS NOT NULL AS resident_stamped,
        place.last_public_action_at IS NOT NULL AS room_stamped
      FROM residents resident JOIN places place ON place.id = $1 WHERE resident.id = 1
    `, [room])).rows, [{ resident_stamped: true, room_stamped: true }])
  } finally {
    observing.release()
    roomLocked.release()
    await Promise.allSettled([first, second])
    routeDb = null
    setEngineTransactionRunnerForTests(null)
    await client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
}

test('public activity presence initialization preserves room order and retired target checks', async t => {
  const postgres = await startPostgres()
  const client = postgres.client
  try {
    await client.query(schemaDdl)
    await client.query(`
      INSERT INTO residents (id, handle, model, secret_hash) VALUES
        (1, 'presence-owner', 'test', repeat('1', 64)),
        (2, 'presence-returning', 'test', repeat('2', 64)),
        (3, 'presence-moving', 'test', repeat('3', 64)),
        (100, 'presence-new', 'test', repeat('4', 64));
    `)
    const world = (await client.query("SELECT id FROM places WHERE place_kind = 'world'")).rows[0].id
    const room = (await client.query(`
      INSERT INTO places (parent_id, place_kind, name, description, owner_id)
      VALUES ($1, 'continent', 'presence-room', 'a current room', 1) RETURNING id
    `, [world])).rows[0].id
    const home = (await client.query(`
      INSERT INTO places (parent_id, place_kind, name, description, owner_id)
      VALUES ($1, 'place', 'presence-home', 'a retained home', 1) RETURNING id
    `, [room])).rows[0].id
    const retired = (await client.query(`
      INSERT INTO places (parent_id, place_kind, name, description, owner_id, retired_at)
      VALUES ($1, 'place', 'presence-retired', 'cannot receive new presence', 1, now()) RETURNING id
    `, [room])).rows[0].id
    await client.query(`
      INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
      VALUES (1, $1, NULL), (2, NULL, $2), (3, NULL, NULL)
    `, [room, home])
    await t.test('initialized presence is a read-only query', async () => {
      await client.query('BEGIN READ ONLY')
      try {
        const presence = await ensurePresence(1, taggedSql(client))
        assert.equal(presence.currentPlaceId, room)
        assert.equal(presence.homePlaceId, null)
      } finally {
        await client.query('ROLLBACK')
      }
    })
    await t.test('initialization does not lock the unchanged retained home', async () => {
      const holder = new Client(postgres.clientConfig)
      const initializer = new Client(postgres.clientConfig)
      await Promise.all([holder.connect(), initializer.connect()])
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT id FROM places WHERE id = $1 FOR NO KEY UPDATE', [home])
        await initializer.query("SET statement_timeout = '1s'")
        const presence = await ensurePresence(2, taggedSql(initializer))
        assert.equal(presence.currentPlaceId, world)
        assert.equal(presence.homePlaceId, home)
      } finally {
        await holder.query('ROLLBACK')
        await Promise.all([holder.end(), initializer.end()])
      }
    })
    await t.test('initialization preserves a move committed after its first read', async () => {
      const initializer = new Client(postgres.clientConfig)
      const mover = new Client(postgres.clientConfig)
      await Promise.all([initializer.connect(), mover.connect()])
      let reached!: () => void
      let release!: () => void
      const ready = new Promise<void>(resolve => { reached = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      const initializing = ensurePresence(3, taggedSql(initializer, async text => {
        if (/WITH first_owned/.test(text)) { reached(); await gate }
      }))
      try {
        await Promise.race([ready, initializing.then(() => {
          throw new Error('initialization completed before its guarded write')
        }), delay(5_000, undefined, { ref: false }).then(() => {
          throw new Error('initialization did not reach its guarded write')
        })])
        await mover.query('BEGIN')
        await mover.query('SELECT id FROM residents WHERE id = 3 FOR NO KEY UPDATE')
        const transaction = taggedSql(mover)
        await lockPlaceRowsTopDown(transaction, {
          placeIds: [world, room], lawChainFrom: null, carryDestinationId: null,
        })
        assert.equal((await moveResident(3, room, transaction)).currentPlaceId, room)
        await mover.query('COMMIT')
        release()
        assert.equal((await initializing).currentPlaceId, room)
        assert.deepEqual((await client.query(`
          SELECT current_place_id, home_place_id FROM resident_presence WHERE resident_id = 3
        `)).rows, [{ current_place_id: room, home_place_id: null }])
      } finally {
        release()
        await initializing.catch(() => undefined)
        await mover.query('ROLLBACK')
        await Promise.all([initializer.end(), mover.end()])
      }
    })
    await t.test('inserted and changed current or home targets still refuse a retired room', async () => {
      const rejected = (error: unknown) => error instanceof Error && 'code' in error
        && error.code === '23514' && /retired place cannot receive resident/.test(error.message)
      for (const column of ['current_place_id', 'home_place_id'] as const) {
        await assert.rejects(client.query(`
          UPDATE resident_presence SET ${column} = $1 WHERE resident_id = 1
        `, [retired]), rejected)
        await assert.rejects(client.query(`
          INSERT INTO resident_presence (resident_id, ${column}) VALUES (100, $1)
        `, [retired]), rejected)
      }
    })
  } finally {
    await client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})

test('law_place shares one timed condition through the current owner chain', async t => {
  const postgres = await startPostgres()
  const client = postgres.client
  const observer = new Client(postgres.clientConfig)
  const db = taggedSql(client)
  let beforeQuery: ((text: string) => Promise<void>) | undefined
  let afterQuery: ((text: string, client: Client) => Promise<void>) | undefined
  let sqlstates: string[] = []
  const transaction = async <T>(work: (sql: TaggedSql) => Promise<T>): Promise<T> => {
    const connection = new Client(postgres.clientConfig)
    await connection.connect()
    try {
      await connection.query("SET statement_timeout = '8s'")
      await connection.query('BEGIN')
      const result = await work(taggedSql(connection, beforeQuery, afterQuery))
      await connection.query('COMMIT')
      return result
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) sqlstates.push(String(error.code))
      await connection.query('ROLLBACK')
      throw error
    } finally {
      await connection.end()
    }
  }
  setEngineTransactionRunnerForTests((_ignored, work) => transaction(sql => work(sql, true)))
  try {
    await observer.connect()
    await client.query(schemaDdl)
    await client.query(`
      INSERT INTO residents (id, handle, model, secret_hash) VALUES
        (1, 'chain-owner', 'test', repeat('1', 64)),
        (2, 'chain-visitor', 'test', repeat('2', 64)),
        (3, 'sibling-visitor', 'test', repeat('3', 64));
    `)
    const world = (await client.query("SELECT id FROM places WHERE place_kind = 'world'")).rows[0].id
    const place = async (name: string, parent: number, owner = 1): Promise<number> => (
      await client.query(`
        INSERT INTO places (parent_id, place_kind, name, description, owner_id)
        VALUES ($1, $4, $2, 'shared condition fixture', $3) RETURNING id
      `, [parent, name, owner, parent === world ? 'continent' : 'place'])
    ).rows[0].id
    const a = await place('parent-a', world)
    const b = await place('child-b', a)
    const c = await place('child-c', a)
    const middle = await place('owned-middle', a)
    const deep = await place('owned-deep', middle)
    const foreign = await place('foreign-middle', a, 2)
    const belowForeign = await place('same-owner-below-foreign', foreign)
    const hinge = await place('hinge-only', world)
    await client.query('UPDATE places SET hinge_to = $1 WHERE id = $2', [hinge, a])
    await client.query('UPDATE places SET hinge_to = $1 WHERE id = $2', [a, hinge])
    await client.query(`
      INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
      VALUES (1, $1, $1), (2, $2, NULL), (3, $3, NULL);
    `, [a, b, c])
    const write = (label: string, seconds = 1): Effect => ({
      effect: 'label', target: 'law_place', label, seconds,
    })
    const check = (label: string, marker: string, target: 'place' | 'law_place' = 'law_place'): Effect => ({
      effect: 'check_label', target, label,
      then: [{ effect: 'label', target: 'actor', label: `${marker}-yes` }],
      else: [{ effect: 'label', target: 'actor', label: `${marker}-no` }],
    })
    await client.query(`
      INSERT INTO traits (id, name, description, recipe, coiner_id)
      VALUES (1, 'shared-rain', 'one condition on the original place', $1::jsonb, 1),
        (2, 'named-gate', 'a nearer named law', NULL, 1);
    `, [JSON.stringify({ use: [write('shared-rain', 1)], talk: [check('shared-rain', 'sibling')] })])
    await client.query(`
      INSERT INTO place_law_changes (place_id, trait_id, actor_id, change_type, position)
      VALUES ($1, 1, 1, 'add', 0), ($2, 2, 1, 'add', 0);
    `, [a, b])
    const thing = (await client.query(`
      INSERT INTO things (place_id, name, body, owner_id, maker_id, open_to_use)
      VALUES ($1, 'rain bell', 'an ordinary shared thing', 1, 1, true) RETURNING id
    `, [b])).rows[0].id
    const context: EffectExecutionContext = {
      actionId: null, actorId: 2, actorHandle: 'chain-visitor', placeId: b,
      sourceThingId: thing, sharedSourceThingId: thing, target: null,
      destinationPlaceId: null, recipientId: null, sourceTraitId: 1,
      originThingId: null, originPlaceId: a, lawAuthority: { traitId: 1, sourcePlaceId: a },
      parentEffectId: null, generation: 0, logicalAt: new Date(Date.now() - 60_000),
    }
    const execute = (effects: readonly Effect[], at = context) => (
      transaction(sql => executeEffects(effects, at, sql))
    )
    const rows = async (label: string) => (await client.query(`
      SELECT target_type, target_id, source_trait_id, source_place_id, source_thing_id,
        expires_at, expires_at > clock_timestamp() AS active,
        extract(epoch FROM expires_at - created_at)::float AS lifetime,
        extract(epoch FROM expires_at - clock_timestamp())::float AS remaining
      FROM active_labels WHERE label = $1 ORDER BY id
    `, [label])).rows
    const present = async (label: string) => (await rows(label)).length > 0
    const stale = (error: unknown) => error instanceof EngineError && error.status === 403
      && error.message === "this law no longer applies from its defining place through this room's current owner chain; read the room's laws before trying again"
    const changeLaw = async (placeId: number, change: 'add' | 'remove') => {
      await client.query(`
        INSERT INTO place_law_changes (place_id, trait_id, actor_id, change_type, position)
        VALUES ($1, 1, 1, $2, $3)
      `, [placeId, change, change === 'add' ? 0 : null])
    }

    await t.test('a visitor use in B writes only A and the inherited law in C reads it', async () => {
      const result = await runAction({ actorId: 2, actorHandle: 'chain-visitor',
        action: 'use', placeId: b, sourceThingId: thing }, db)
      assert.equal(result.status, 'applied', result.error ?? '')
      const labels = await rows('shared-rain')
      assert.equal(labels.length, 1)
      assert.equal(labels[0].target_id, a, 'law_place must write A, not the acting child B')
      assert.equal(labels[0].source_place_id, a)
      assert.equal(labels[0].source_thing_id, null)
      assert.ok(labels[0].remaining > 0.7 && labels[0].remaining <= 1)
      const read = await runAction({ actorId: 3, actorHandle: 'sibling-visitor',
        action: 'talk', placeId: c, payload: { text: 'checking the shared condition' } }, db)
      assert.equal(read.status, 'applied', read.error ?? '')
      assert.equal(await present('sibling-yes'), true)
      await execute([{ effect: 'label', target: 'place', label: 'old-local' }])
      assert.equal((await rows('old-local'))[0].target_id, b)
      assert.equal((await rows('old-local'))[0].expires_at, null)
      assert.deepEqual((await client.query(`
        SELECT current_place_id FROM resident_presence WHERE resident_id IN (2, 3) ORDER BY resident_id
      `)).rows.map(row => row.current_place_id), [b, c])
    })

    await t.test('foreign intermediates, hinges, nearer adoption and retired rooms refuse', async () => {
      for (const placeId of [belowForeign, hinge]) {
        await assert.rejects(execute([write('outside')], { ...context, placeId }), stale)
        await assert.rejects(execute([check('shared-rain', 'outside')], { ...context, placeId }), stale)
      }
      await changeLaw(b, 'add')
      await assert.rejects(execute([write('shadowed')]), stale)
      await execute([write('nearest')], { ...context, originPlaceId: b })
      assert.equal((await rows('nearest'))[0].target_id, b)
      await changeLaw(b, 'remove')
      await execute([write('deep-chain')], { ...context, placeId: deep })
      assert.equal((await rows('deep-chain'))[0].target_id, a)
      for (const retired of [a, b, middle]) {
        await client.query('UPDATE places SET retired_at = clock_timestamp() WHERE id = $1', [retired])
        await assert.rejects(execute([write('retired')], {
          ...context, placeId: retired === middle ? deep : b,
        }), stale)
        await client.query('UPDATE places SET retired_at = NULL WHERE id = $1', [retired])
      }
      await assert.rejects(execute([write('world')], { ...context, placeId: world, originPlaceId: world }),
        (error: unknown) => error instanceof EngineError && error.status === 403
          && error.message === 'the world is transit only; move through it, claim a frontier continent, or use an owned place instead')
      for (const name of ['outside', 'outside-yes', 'outside-no', 'shadowed', 'retired', 'world']) {
        assert.equal(await present(name), false)
      }
    })

    await t.test('expiry is label-only, append-only and fresh in a later transaction', async () => {
      const waitForExpiry = async (label: string) => {
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const labels = await rows(label)
          assert.ok(labels.length > 0, 'the timed label must exist before waiting for its expiry')
          if (labels.every(row => row.active === false)) return
          await delay(25)
        }
        assert.fail(`the database clock did not reach the expiry of ${label}`)
      }
      await execute([write('shared-rain', 1)])
      await waitForExpiry('shared-rain')
      await execute([check('shared-rain', 'expired'), check('shared-rain', 'named-law', 'place')])
      assert.equal(await present('expired-no'), true)
      assert.equal(await present('named-law-yes'), true)
      await execute([write('one-second'), write('repeated'), write('repeated', 4)])
      await execute([{ effect: 'label', target: 'place', label: 'literal-second', seconds: 1 }])
      await execute([{ effect: 'label', target: 'place', label: 'permanent-collision' }], { ...context, placeId: a })
      await execute([write('permanent-collision')])
      await waitForExpiry('literal-second')
      await execute([check('one-second', 'one-second'), check('repeated', 'repeated'),
        check('permanent-collision', 'permanent'), check('literal-second', 'literal', 'place')])
      assert.equal(await present('one-second-no'), true)
      assert.equal(await present('repeated-yes'), true)
      assert.equal(await present('permanent-yes'), true)
      assert.equal(await present('literal-no'), true)
      assert.equal((await rows('one-second')).length, 1)
      assert.equal((await rows('repeated')).length, 2)
      assert.equal((await rows('permanent-collision')).length, 2)
      await waitForExpiry('repeated')
      await execute([check('repeated', 'all-expired')])
      assert.equal(await present('all-expired-no'), true,
        `the repeated labels must have expired: ${JSON.stringify(await rows('repeated'))}`)
      assert.equal((await rows('repeated')).length, 2)
    })

    await t.test('literal place checks use fresh time even inside an older transaction', async () => {
      await execute([{ effect: 'label', target: 'place', label: 'literal-old-transaction', seconds: 1 }])
      await transaction(async sql => {
        await sql`SELECT now()`
        await delay(1_100)
        await executeEffects([check('literal-old-transaction', 'literal-old', 'place')], context, sql)
      })
      assert.equal(await present('literal-old-no'), true)
      assert.equal(await present('literal-old-yes'), false)
    })

    await t.test('legacy contexts use only their proven original law fallback', async () => {
      const { originThingId: _thingOrigin, originPlaceId: _placeOrigin, ...legacy } = context
      await execute([write('legacy-origin')], legacy)
      assert.equal((await rows('legacy-origin'))[0].target_id, a)
      await assert.rejects(execute([write('legacy-borrowed')], {
        ...legacy, lawAuthority: { traitId: 2, sourcePlaceId: b },
      }), (error: unknown) => error instanceof EngineError && error.status === 403
        && error.message === 'law_place is available only to a place law; put this trait on a place you own as a law')
      assert.equal(await present('legacy-borrowed'), false)
    })

    await t.test('a newly nearer adoption invalidates the original delayed source', async () => {
      await execute([{ effect: 'wait', seconds: 1, then: [write('delayed-shadow')] }])
      await changeLaw(b, 'add')
      try {
        assert.deepEqual(await resolveDueEffects(b, db), { resolved: 0, failed: 1, capped: false })
        assert.equal(await present('delayed-shadow'), false)
      } finally {
        await changeLaw(b, 'remove')
      }
    })

    await t.test('named checks, chance, reach and wait keep the original source', async () => {
      await ensureChanceDays(db)
      await client.query(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id, open_to_reach)
        VALUES ($1, 'reached token', 'a local reach member', 2, 2, true)
      `, [b])
      const reached: readonly Effect[] = [{
        effect: 'reach', over: 'things', max: 1, then: [write('nested'), {
          effect: 'wait', seconds: 1, then: [write('nested-later', 2)],
        }],
      }]
      await execute([{
        effect: 'check_label', target: 'place', label: 'named-gate', then: [{
          effect: 'chance', percent: 50, then: reached, else: reached,
        }],
      }])
      assert.equal((await rows('nested'))[0].target_id, a)
      const pending = (await client.query('SELECT payload FROM pending_effects ORDER BY id DESC LIMIT 1')).rows[0].payload
      assert.deepEqual(pending.effect_origin, { source_thing_id: null, source_place_id: a })
      assert.deepEqual(await resolveDueEffects(b, db), { resolved: 1, failed: 0, capped: false })
      const delayed = (await rows('nested-later'))[0]
      assert.equal(delayed.target_id, a)
      assert.ok(delayed.remaining > 1.5 && delayed.remaining <= 2, 'late timers start expiry at execution')
      await client.query('UPDATE places SET wake_label_seconds = 10 WHERE id = $1', [b])
      await execute([{ effect: 'label', target: 'actor', label: 'wake-life' }], { ...context, fromWake: true })
      await execute([{ effect: 'label', target: 'actor', label: 'reach-life' }], {
        ...context, reachMember: { answererId: 2, admittedBy: 'soft' },
      })
      assert.ok((await rows('wake-life'))[0].remaining > 9)
      assert.ok((await rows('wake-life'))[0].remaining <= 10)
      assert.equal((await rows('wake-life'))[0].lifetime, 10)
      assert.ok((await rows('reach-life'))[0].remaining > 86_399)
      assert.ok((await rows('reach-life'))[0].remaining <= 86_400)
      assert.equal((await rows('reach-life'))[0].lifetime, 86_400)
    })

    // Pause the real query, then let the second connection win or wait on its row lock.
    const barrier = () => {
      let release!: () => void
      let reached!: () => void
      return {
        gate: new Promise<void>(resolve => { release = resolve }),
        ready: new Promise<void>(resolve => { reached = resolve }),
        release: () => release(), reached: () => reached(),
      }
    }
    const atBarrier = async (ready: Promise<void>, operation: Promise<unknown>) => {
      await Promise.race([ready, operation.then(() => { throw new Error('operation missed its lock barrier') }),
        delay(5_000, undefined, { ref: false }).then(() => { throw new Error('lock barrier timed out') })])
    }
    const lockQuery = (text: string) => /WITH RECURSIVE/.test(text) && /FOR NO KEY UPDATE OF place/.test(text)
    const waitForLock = async () => {
      const end = Date.now() + 5_000
      while (Date.now() < end) {
        await observer.query('SELECT pg_stat_clear_snapshot()')
        const waiting = await observer.query(`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock') AS waiting
        `)
        if (waiting.rows[0].waiting) return
        await delay(10)
      }
      assert.fail('the other transaction never waited for the place lock')
    }

    await t.test('a write delayed longer than its lifetime still receives a full second', async () => {
      const paused = barrier()
      beforeQuery = async text => { if (lockQuery(text)) paused.reached() }
      await client.query('BEGIN')
      await client.query('SELECT id FROM places WHERE id = $1 FOR UPDATE', [a])
      const operation = execute([write('lock-delayed')])
      try {
        await atBarrier(paused.ready, operation)
        await waitForLock()
        await delay(1_100)
        await client.query('COMMIT')
        await operation
        const label = (await rows('lock-delayed'))[0]
        assert.ok(label.remaining > 0.8 && label.remaining <= 1,
          `write must start its full lifetime after the lock: ${label.remaining}`)
      } finally {
        beforeQuery = undefined
        await client.query('ROLLBACK')
        await operation.catch(() => undefined)
      }
    })

    await t.test('a check begun before expiry reads false after waiting for its guard lock', async () => {
      await execute([write('guard-expiry')])
      assert.equal((await rows('guard-expiry'))[0].active, true)
      const paused = barrier()
      beforeQuery = async text => { if (lockQuery(text)) paused.reached() }
      await client.query('BEGIN')
      await client.query('SELECT id FROM places WHERE id = $1 FOR UPDATE', [a])
      const operation = execute([check('guard-expiry', 'guard-expiry')])
      try {
        await atBarrier(paused.ready, operation)
        await waitForLock()
        await delay(1_100)
        await client.query('COMMIT')
        await operation
        assert.equal(await present('guard-expiry-no'), true)
        assert.equal(await present('guard-expiry-yes'), false)
      } finally {
        beforeQuery = undefined
        await client.query('ROLLBACK')
        await operation.catch(() => undefined)
      }
    })

    for (const mutation of ['law removal', 'source owner', 'acting owner'] as const) {
      await t.test(`a delayed write refuses when ${mutation} wins the chain lock`, async () => {
        await execute([{ effect: 'wait', seconds: 1, then: [write('lost-race')] }])
        const paused = barrier()
        beforeQuery = async text => {
          if (lockQuery(text)) { paused.reached(); await paused.gate }
        }
        const operation = resolveDueEffects(b, db)
        try {
          await atBarrier(paused.ready, operation)
          await client.query('BEGIN')
          await client.query('SELECT id FROM places WHERE id = $1 FOR UPDATE', [mutation === 'acting owner' ? b : a])
          if (mutation === 'law removal') await changeLaw(a, 'remove')
          else await client.query('UPDATE places SET owner_id = 3 WHERE id = $1', [mutation === 'acting owner' ? b : a])
          await client.query('COMMIT')
          paused.release()
          assert.deepEqual(await operation, { resolved: 0, failed: 1, capped: false })
          assert.equal(await present('lost-race'), false)
          const failure = (await client.query('SELECT status, detail FROM effect_resolutions ORDER BY id DESC LIMIT 1')).rows[0]
          assert.equal(failure.status, 'failed')
          assert.equal(failure.detail.error,
            "this law no longer applies from its defining place through this room's current owner chain; read the room's laws before trying again")
        } finally {
          paused.release()
          beforeQuery = undefined
          await client.query('ROLLBACK')
          await operation.catch(() => undefined)
          if (mutation === 'law removal') await changeLaw(a, 'add')
          else await client.query('UPDATE places SET owner_id = 1 WHERE id = $1', [mutation === 'acting owner' ? b : a])
        }
      })
    }

    await t.test('a lock waiter re-reads ownership after the lock statement snapshot', async () => {
      await client.query('BEGIN')
      await client.query('UPDATE places SET owner_id = 3 WHERE id = $1', [a])
      const operation = execute([write('stale-snapshot')])
      // Attach the rejection handler before releasing the blocker.
      const refused = assert.rejects(operation, stale)
      try {
        await waitForLock()
        await client.query('COMMIT')
        await refused
        assert.equal(await present('stale-snapshot'), false)
      } finally {
        await client.query('ROLLBACK')
        await operation.catch(() => undefined)
        await client.query('UPDATE places SET owner_id = 1 WHERE id = $1', [a])
      }
    })

    for (const mutation of ['law removal', 'owner change'] as const) {
      await t.test(`a guarded delayed write commits before a waiting ${mutation}`, async () => {
        await execute([{ effect: 'wait', seconds: 1, then: [write('won-race', 5)] }])
        const paused = barrier()
        beforeQuery = async text => {
          if (/INSERT INTO active_labels/.test(text)) { paused.reached(); await paused.gate }
        }
        const operation = resolveDueEffects(b, db)
        const changer = new Client(postgres.clientConfig)
        await changer.connect()
        let changed: Promise<unknown> | undefined
        try {
          await atBarrier(paused.ready, operation)
          await changer.query('BEGIN')
          changed = (async () => {
            await changer.query('SELECT id FROM places WHERE id = $1 FOR UPDATE', [a])
            if (mutation === 'law removal') {
              await changer.query(`INSERT INTO place_law_changes (place_id, trait_id, actor_id, change_type)
                VALUES ($1, 1, 1, 'remove')`, [a])
            } else await changer.query('UPDATE places SET owner_id = 3 WHERE id = $1', [a])
            await changer.query('COMMIT')
          })()
          await waitForLock()
          paused.release()
          assert.deepEqual(await operation, { resolved: 1, failed: 0, capped: false })
          await changed
          assert.equal((await rows('won-race')).at(-1).target_id, a)
        } finally {
          paused.release()
          beforeQuery = undefined
          await operation.catch(() => undefined)
          await changed?.catch(() => undefined)
          await changer.query('ROLLBACK')
          await changer.end()
          if (mutation === 'law removal') await changeLaw(a, 'add')
          else await client.query('UPDATE places SET owner_id = 1 WHERE id = $1', [a])
        }
      })
    }

    await t.test('failed immediate actions and failed due effects roll back their new label', async () => {
      const invalid: Effect = { effect: 'check_label', target: 'target', label: 'missing', then: [] }
      await client.query('UPDATE traits SET recipe = $1::jsonb WHERE id = 1', [
        JSON.stringify({ use: [write('rollback-action'), invalid] }),
      ])
      const result = await runAction({ actorId: 2, actorHandle: 'chain-visitor', action: 'use',
        placeId: b, sourceThingId: thing }, db)
      assert.equal(result.status, 'failed')
      assert.equal(await present('rollback-action'), false)
      await execute([{ effect: 'wait', seconds: 1, then: [write('rollback-timer'), invalid] }])
      assert.deepEqual(await resolveDueEffects(b, db), { resolved: 0, failed: 1, capped: false })
      assert.equal(await present('rollback-timer'), false)
    })

    for (const mode of ['action', 'timer'] as const) {
      await t.test(`${mode} movement takes ancestry locks before a tree ownership change`, async () => {
        const destination = await place(`race-destination-${mode}`, b)
        await client.query('UPDATE traits SET recipe = $1::jsonb WHERE id = 1', [
          JSON.stringify({ move: [write('tree-race')] }),
        ])
        if (mode === 'timer') await execute([{
          effect: 'wait', seconds: 1, then: [
            { effect: 'move', target: 'actor', to: 'destination' }, write('tree-race'),
          ],
        }], { ...context, destinationPlaceId: destination })
        const paused = barrier()
        beforeQuery = async text => {
          if (lockQuery(text)) { paused.reached(); await paused.gate }
        }
        const operation = mode === 'action'
          ? runAction({ actorId: 2, actorHandle: 'chain-visitor', action: 'move',
              placeId: b, destinationPlaceId: destination }, db)
          : resolveDueEffects(b, db)
        const changer = new Client(postgres.clientConfig)
        const rootLocked = barrier()
        await changer.connect()
        let changed: Promise<void> | undefined
        try {
          await atBarrier(paused.ready, operation)
          changed = (async () => {
            await changer.query('BEGIN')
            // Match the existing place gift's ancestor-first, then children locks.
            await changer.query('SELECT id FROM places WHERE id = $1 FOR UPDATE', [a])
            rootLocked.reached()
            await changer.query('SELECT id FROM places WHERE parent_id = $1 ORDER BY id FOR UPDATE', [a])
            await changer.query('UPDATE places SET owner_id = 3 WHERE id = $1', [a])
            await changer.query('COMMIT')
          })()
          const settledChange = changed.then(() => null, (error: unknown) => error)
          await atBarrier(rootLocked.ready, changed)
          paused.release()
          const result = await operation
          assert.equal(await settledChange, null, 'the ownership transaction must not deadlock')
          if ('status' in result) {
            assert.equal(result.status, 'failed')
            assert.equal(result.httpStatus, 403, 'a broken chain must refuse, not deadlock')
          } else assert.deepEqual(result, { resolved: 0, failed: 1, capped: false })
          assert.equal(await present('tree-race'), false)
        } finally {
          paused.release()
          beforeQuery = undefined
          await operation.catch(() => undefined)
          await changed?.catch(() => undefined)
          await changer.query('ROLLBACK')
          await changer.end()
          await client.query('UPDATE places SET owner_id = 1 WHERE id = $1', [a])
          await client.query('UPDATE resident_presence SET current_place_id = $1 WHERE resident_id = 2', [b])
        }
      })
    }

    await t.test('a timer reserves ancestry before actor presence like a concurrent action', async () => {
      const destination = await place('presence-race-destination', b)
      await execute([{ effect: 'wait', seconds: 1, then: [
        { effect: 'move', target: 'actor', to: 'destination' }, write('presence-race'),
      ] }], { ...context, destinationPlaceId: destination })
      const paused = barrier()
      beforeQuery = async text => {
        if (lockQuery(text)) {
          paused.reached(); await paused.gate
        }
      }
      const operation = resolveDueEffects(b, db)
      const changer = new Client(postgres.clientConfig)
      const presenceLocked = barrier()
      await changer.connect()
      let changed: Promise<void> | undefined
      try {
        await atBarrier(paused.ready, operation)
        changed = (async () => {
          await changer.query('BEGIN')
          await changer.query('SELECT id FROM places WHERE id = $1 FOR NO KEY UPDATE', [a])
          await changer.query('SELECT resident_id FROM resident_presence WHERE resident_id = 2 FOR UPDATE')
          presenceLocked.reached()
          await changer.query('UPDATE places SET owner_id = 3 WHERE id = $1', [a])
          await changer.query('COMMIT')
        })()
        const settledChange = changed.then(() => null, (error: unknown) => error)
        await atBarrier(presenceLocked.ready, changed)
        paused.release()
        assert.deepEqual(await operation, { resolved: 0, failed: 1, capped: false })
        assert.equal(await settledChange, null, 'actor presence and ancestor locks must not invert')
        assert.equal(await present('presence-race'), false)
        const failure = (await client.query('SELECT detail FROM effect_resolutions ORDER BY id DESC LIMIT 1')).rows[0]
        assert.equal(failure.detail.error,
          "this law no longer applies from its defining place through this room's current owner chain; read the room's laws before trying again")
      } finally {
        paused.release()
        beforeQuery = undefined
        await operation.catch(() => undefined)
        await changed?.catch(() => undefined)
        await changer.query('ROLLBACK')
        await changer.end()
        await client.query('UPDATE places SET owner_id = 1 WHERE id = $1', [a])
        await client.query('UPDATE resident_presence SET current_place_id = $1 WHERE resident_id = 2', [b])
      }
    })

    for (const mutation of ['intermediate-owner', 'intermediate-retired', 'source-retired'] as const) {
      await t.test(`delayed law_place refuses ${mutation}`, async () => {
        await execute([{ effect: 'wait', seconds: 1, then: [write(mutation)] }], {
          ...context, placeId: deep,
        })
        const changedId = mutation === 'source-retired' ? a : middle
        if (mutation === 'intermediate-owner') {
          await client.query('UPDATE places SET owner_id = 3 WHERE id = $1', [changedId])
        } else await client.query('UPDATE places SET retired_at = clock_timestamp() WHERE id = $1', [changedId])
        try {
          assert.deepEqual(await resolveDueEffects(deep, db), { resolved: 0, failed: 1, capped: false })
          assert.equal(await present(mutation), false)
        } finally {
          if (mutation === 'intermediate-owner') {
            await client.query('UPDATE places SET owner_id = 1 WHERE id = $1', [changedId])
          } else await client.query('UPDATE places SET retired_at = NULL WHERE id = $1', [changedId])
        }
      })
    }

    await t.test('parent and child movement actions do not deadlock on the chain guard', async () => {
      await client.query('UPDATE traits SET recipe = $1::jsonb WHERE id = 1', [
        JSON.stringify({ move: [write('concurrent-move', 5)] }),
      ])
      const paused = barrier()
      let readers = 0
      beforeQuery = async text => {
        if (!lockQuery(text)) return
        readers += 1
        if (readers === 2) paused.release()
        await paused.gate
      }
      try {
        const outcomes = await Promise.all([
          runAction({ actorId: 1, actorHandle: 'chain-owner', action: 'move', placeId: a, destinationPlaceId: c }, db),
          runAction({ actorId: 2, actorHandle: 'chain-visitor', action: 'move', placeId: b, destinationPlaceId: a }, db),
        ])
        assert.deepEqual(outcomes.map(result => result.status), ['applied', 'applied'])
        assert.deepEqual((await rows('concurrent-move')).map(row => row.target_id), [a, a])
      } finally {
        beforeQuery = undefined
        paused.release()
      }
    })

    for (const target of ['place', 'law_place'] as const) {
      await t.test(`simultaneous sibling carries into the law source do not deadlock with ${target}`, async () => {
        await client.query('UPDATE places SET open_to_things = true WHERE id = $1', [a])
        await client.query(`
          UPDATE resident_presence
          SET current_place_id = CASE resident_id WHEN 2 THEN $1::int ELSE $2::int END
          WHERE resident_id IN (2, 3)
        `, [b, c])
        const label = `carry-race-${target}`
        await client.query('UPDATE traits SET recipe = $1::jsonb WHERE id = 1', [
          JSON.stringify({ move: [{ ...write(label, 5), target }] }),
        ])
        const carried = (await client.query(`
          INSERT INTO things (place_id, name, body, owner_id, maker_id)
          VALUES ($1, 'visitor-two-luggage', 'carry race', 2, 2),
                 ($2, 'visitor-three-luggage', 'carry race', 3, 3)
          RETURNING id
        `, [b, c])).rows.map(row => row.id)
        const paused = barrier()
        let readers = 0
        beforeQuery = async text => {
          if (!/FOR (?:UPDATE|SHARE) OF destination/.test(text)) return
          readers += 1
          if (readers === 2) paused.release()
          await paused.gate
        }
        try {
          const outcomes = await Promise.all([
            runAction({ actorId: 2, actorHandle: 'chain-visitor', action: 'move', placeId: b,
              destinationPlaceId: a, carryThingId: carried[0] }, db),
            runAction({ actorId: 3, actorHandle: 'sibling-visitor', action: 'move', placeId: c,
              destinationPlaceId: a, carryThingId: carried[1] }, db),
          ])
          assert.deepEqual(outcomes.map(result => ({ status: result.status, error: result.error })),
            [{ status: 'applied', error: null }, { status: 'applied', error: null }])
          assert.deepEqual((await client.query(`
            SELECT current_place_id FROM resident_presence WHERE resident_id IN (2, 3) ORDER BY resident_id
          `)).rows.map(row => row.current_place_id), [a, a])
          assert.deepEqual((await client.query(`
            SELECT place_id, held_by FROM things WHERE id = ANY($1::int[]) ORDER BY id
          `, [carried])).rows, [{ place_id: a, held_by: null }, { place_id: a, held_by: null }])
          assert.deepEqual((await rows(label)).map(row => row.target_id).sort((left, right) => left - right),
            target === 'law_place' ? [a, a] : [b, c])
        } finally {
          beforeQuery = undefined
          paused.release()
        }
      })
    }
    routeDb = db
    const { Hono } = await import('hono')
    const { mountSocietyRoutes } = await import('../../src/society.ts')
    const app = new Hono()
    mountSocietyRoutes(app)
    const ownerSecret = `1f3d9_sk_${randomBytes(24).toString('hex')}`
    await client.query('UPDATE residents SET secret_hash = $1 WHERE id = 1', [
      createHash('sha256').update(ownerSecret, 'utf8').digest('hex'),
    ])
    for (const concurrent of [false, true]) {
      await t.test(`${concurrent ? 'concurrent' : 'serial'} carry and subtree gift both apply`, async () => {
        const parent = await place(`gift-parent-${concurrent}`, a)
        const child = await place(`gift-child-${concurrent}`, parent)
        await client.query('UPDATE places SET open_to_things = true WHERE id = ANY($1::int[])', [[parent, child]])
        await client.query('UPDATE resident_presence SET current_place_id = $1 WHERE resident_id = 3', [parent])
        const luggage = (await client.query(`
          INSERT INTO things (place_id, name, body, owner_id, maker_id)
          VALUES ($1, 'gift-race-luggage', 'intact', 3, 3) RETURNING id
        `, [parent])).rows[0].id
        const paused = barrier()
        let carryPid = 0
        sqlstates = []
        afterQuery = async (text, connection) => {
          if (!concurrent || !/FOR UPDATE OF destination/.test(text) || carryPid !== 0) return
          carryPid = Number((await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
          paused.reached()
          await paused.gate
        }
        const gift = () => app.request('/api/transfer', {
          method: 'POST',
          headers: { authorization: `Bearer ${ownerSecret}`, 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'place', id: parent, to_handle: 'chain-visitor' }),
        })
        const moved = runAction({ actorId: 3, actorHandle: 'sibling-visitor', action: 'move',
          placeId: parent, destinationPlaceId: child, carryThingId: luggage }, db)
        let given: ReturnType<typeof gift> | undefined
        try {
          if (concurrent) {
            await atBarrier(paused.ready, moved)
            given = gift()
            let waiting: { query: string; blockers: number[] } | undefined
            const deadline = Date.now() + 3_000
            while (Date.now() < deadline) {
              waiting = (await observer.query(`
                SELECT query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
                WHERE wait_event_type = 'Lock' AND $1::int = ANY(pg_blocking_pids(pid))
              `, [carryPid])).rows.find(row => row.blockers.includes(carryPid))
              if (waiting) break
              await delay(20)
            }
            assert.ok(waiting, 'the actual gift route must wait on a row held by the carry')
            t.diagnostic(`gift waits on its room preparation; releasing carry`)
            paused.release()
          } else {
            await moved
            given = gift()
          }
          const [carry, response] = await Promise.all([moved, given])
          const body = await response.json() as { error?: string }
          t.diagnostic(`carry=${carry.status}; gift HTTP=${response.status}; sqlstates=${JSON.stringify(sqlstates)}`)
          assert.equal(carry.status, 'applied', carry.error ?? '')
          assert.equal(response.status, 200, body.error)
          assert.deepEqual(sqlstates, [], 'neither action may deadlock')
          assert.deepEqual((await client.query(
            'SELECT owner_id FROM places WHERE id = ANY($1::int[]) ORDER BY id', [[parent, child]],
          )).rows, [{ owner_id: 2 }, { owner_id: 2 }])
          assert.deepEqual((await client.query(
            'SELECT place_id, held_by, owner_id, maker_id, body FROM things WHERE id = $1', [luggage],
          )).rows, [{ place_id: child, held_by: null, owner_id: 3, maker_id: 3, body: 'intact' }])
        } finally {
          paused.release()
          await Promise.allSettled([moved, given])
          afterQuery = undefined
        }
      })
    }

    // An order that lets each carry hold its own destination first deadlocks the pairs
    // below. Each exclusive destination lock waits until both carries hold one, or a short
    // while when the one lock order makes the second carry wait before it holds anything.
    const holdBothDestinations = () => {
      const both = barrier()
      let holders = 0
      afterQuery = async text => {
        if (!/FROM places AS destination/.test(text)) return
        holders += 1
        if (holders === 2) both.release()
        await Promise.race([both.gate, delay(1_500)])
      }
      return both
    }

    await t.test('opposite carries between a parent and its child both apply', async () => {
      await client.query('UPDATE traits SET recipe = $1::jsonb WHERE id = 1', [
        JSON.stringify({ move: [write('opposite-carry', 5)] }),
      ])
      const upper = await place('opposite-upper', a)
      const lower = await place('opposite-lower', upper)
      await client.query('UPDATE places SET open_to_things = true WHERE id = ANY($1::int[])', [[upper, lower]])
      await client.query(`
        UPDATE resident_presence SET home_place_id = NULL,
          current_place_id = CASE resident_id WHEN 2 THEN $1::int ELSE $2::int END
        WHERE resident_id IN (2, 3)
      `, [lower, upper])
      const luggage = (await client.query(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id)
        VALUES ($1, 'rising-luggage', 'goes up', 2, 2), ($2, 'falling-luggage', 'goes down', 3, 3)
        RETURNING id
      `, [lower, upper])).rows.map(row => row.id)
      sqlstates = []
      const both = holdBothDestinations()
      try {
        const outcomes = await Promise.all([
          runAction({ actorId: 2, actorHandle: 'chain-visitor', action: 'move', placeId: lower,
            destinationPlaceId: upper, carryThingId: luggage[0] }, db),
          runAction({ actorId: 3, actorHandle: 'sibling-visitor', action: 'move', placeId: upper,
            destinationPlaceId: lower, carryThingId: luggage[1] }, db),
        ])
        assert.deepEqual(outcomes.map(result => ({ status: result.status, error: result.error })),
          [{ status: 'applied', error: null }, { status: 'applied', error: null }])
        assert.deepEqual(sqlstates, [], 'neither carry may deadlock')
        assert.deepEqual((await client.query(`
          SELECT current_place_id FROM resident_presence WHERE resident_id IN (2, 3) ORDER BY resident_id
        `)).rows.map(row => row.current_place_id), [upper, lower])
        assert.deepEqual((await client.query(`
          SELECT place_id, held_by FROM things WHERE id = ANY($1::int[]) ORDER BY id
        `, [luggage])).rows, [{ place_id: upper, held_by: null }, { place_id: lower, held_by: null }])
        assert.deepEqual((await rows('opposite-carry')).map(row => row.target_id), [a, a])
      } finally {
        afterQuery = undefined
        both.release()
      }
    })

    await t.test('a carry below the mover home and a carry into that home both apply', async () => {
      // No law here: the presence update re-reads the mover's home, so the home itself must
      // take its place in the order, above the room the mover carries into.
      const land = await place('home-land', world)
      const home = await place('mover-home', land)
      const upper = await place('home-upper', home)
      const lower = await place('home-lower', upper)
      await client.query('UPDATE places SET open_to_things = true WHERE id = ANY($1::int[])', [[home, upper, lower]])
      await client.query(`
        UPDATE resident_presence SET
          current_place_id = CASE resident_id WHEN 2 THEN $1::int ELSE $2::int END,
          home_place_id = CASE resident_id WHEN 2 THEN $3::int ELSE NULL END
        WHERE resident_id IN (2, 3)
      `, [lower, upper, home])
      const luggage = (await client.query(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id)
        VALUES ($1, 'homeward-luggage', 'goes up', 2, 2), ($2, 'home-bound-luggage', 'goes home', 3, 3)
        RETURNING id
      `, [lower, upper])).rows.map(row => row.id)
      sqlstates = []
      const both = holdBothDestinations()
      try {
        const outcomes = await Promise.all([
          runAction({ actorId: 2, actorHandle: 'chain-visitor', action: 'move', placeId: lower,
            destinationPlaceId: upper, carryThingId: luggage[0] }, db),
          runAction({ actorId: 3, actorHandle: 'sibling-visitor', action: 'move', placeId: upper,
            destinationPlaceId: home, carryThingId: luggage[1] }, db),
        ])
        assert.deepEqual(outcomes.map(result => ({ status: result.status, error: result.error })),
          [{ status: 'applied', error: null }, { status: 'applied', error: null }])
        assert.deepEqual(sqlstates, [], 'neither carry may deadlock')
        assert.deepEqual((await client.query(`
          SELECT current_place_id FROM resident_presence WHERE resident_id IN (2, 3) ORDER BY resident_id
        `)).rows.map(row => row.current_place_id), [upper, home])
        assert.deepEqual((await client.query(`
          SELECT place_id FROM things WHERE id = ANY($1::int[]) ORDER BY id
        `, [luggage])).rows.map(row => row.place_id), [upper, home])
      } finally {
        afterQuery = undefined
        both.release()
        await client.query('UPDATE resident_presence SET home_place_id = NULL WHERE resident_id = 2')
      }
    })

    // Pause one action after its exclusive destination lock, start another, and release
    // the first once the second waits on a row the first holds.
    const pauseAfterDestination = () => {
      const paused = barrier()
      let pid = 0
      afterQuery = async (text, connection) => {
        if (!/FROM places AS destination/.test(text) || pid !== 0) return
        pid = Number((await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        paused.reached()
        await paused.gate
      }
      const waitsOnPaused = async () => {
        const deadline = Date.now() + 3_000
        while (Date.now() < deadline) {
          const waiting = await observer.query(`
            SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND $1::int = ANY(pg_blocking_pids(pid))
          `, [pid])
          if (waiting.rows.length > 0) return
          await delay(20)
        }
        assert.fail('the second action must wait on a row the paused carry holds')
      }
      return { paused, waitsOnPaused }
    }

    await t.test(`a carry into the giver's room and a gift clearing the giver's home both apply`, async () => {
      await client.query('UPDATE traits SET recipe = $1::jsonb WHERE id = 1', [
        JSON.stringify({ move: [write('home-gift-carry', 5)] }),
      ])
      const room = await place('giver-room', a)
      const estate = await place('given-estate', room)
      await client.query('UPDATE places SET open_to_things = true WHERE id = ANY($1::int[])', [[room, estate]])
      // The gift clears the giver's home, and that presence update re-reads the giver's room.
      await client.query(`
        UPDATE resident_presence SET current_place_id = $1, home_place_id = $2 WHERE resident_id = 1
      `, [room, estate])
      await client.query(`
        UPDATE resident_presence SET current_place_id = $1, home_place_id = NULL WHERE resident_id = 3
      `, [estate])
      const luggage = (await client.query(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id)
        VALUES ($1, 'home-gift-luggage', 'intact', 3, 3) RETURNING id
      `, [estate])).rows[0].id
      sqlstates = []
      // The gift reads its laws holding only the giver's presence and waits there. The
      // carry then takes the giver's room for its destination and waits. The gift goes on
      // and must wait on the carry without holding the place the carry still has to read.
      const giftPaused = barrier()
      let giftWaiting = false
      const { paused, waitsOnPaused } = pauseAfterDestination()
      const carryHook = afterQuery
      afterQuery = async (text, connection) => {
        if (!giftWaiting && /WITH RECURSIVE ancestry/.test(text)) {
          giftWaiting = true
          giftPaused.reached()
          await giftPaused.gate
          return
        }
        await carryHook?.(text, connection)
      }
      const given = Promise.resolve(app.request('/api/transfer', {
        method: 'POST',
        headers: { authorization: `Bearer ${ownerSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'place', id: estate, to_handle: 'chain-visitor' }),
      }))
      let moved: ReturnType<typeof runAction> | undefined
      try {
        await atBarrier(giftPaused.ready, given)
        moved = runAction({ actorId: 3, actorHandle: 'sibling-visitor', action: 'move',
          placeId: estate, destinationPlaceId: room, carryThingId: luggage }, db)
        await atBarrier(paused.ready, moved)
        giftPaused.release()
        await waitsOnPaused()
        paused.release()
        const [carry, response] = await Promise.all([moved, given])
        const body = await response.json() as { error?: string }
        assert.equal(carry.status, 'applied', carry.error ?? '')
        assert.equal(response.status, 200, body.error)
        assert.deepEqual(sqlstates, [], 'neither action may deadlock')
        assert.deepEqual((await client.query('SELECT owner_id FROM places WHERE id = $1', [estate])).rows,
          [{ owner_id: 2 }])
        assert.deepEqual((await client.query(`
          SELECT current_place_id, home_place_id FROM resident_presence WHERE resident_id = 1
        `)).rows, [{ current_place_id: room, home_place_id: null }])
        assert.deepEqual((await client.query('SELECT place_id, held_by FROM things WHERE id = $1', [luggage])).rows,
          [{ place_id: room, held_by: null }])
      } finally {
        giftPaused.release()
        paused.release()
        await Promise.allSettled([moved, given])
        afterQuery = undefined
      }
    })

    await t.test('two makers in one room under a law_place make law both apply', async () => {
      const workshop = await place('shared-workshop', a)
      await client.query('UPDATE places SET open_to_things = true WHERE id = $1', [workshop])
      await client.query('UPDATE traits SET recipe = $1::jsonb WHERE id = 1', [
        JSON.stringify({ make: [write('make-race', 5)] }),
      ])
      await client.query(`
        UPDATE resident_presence SET current_place_id = $1, home_place_id = NULL WHERE resident_id IN (2, 3)
      `, [workshop])
      const { makeThingThroughEngine } = await import('../../src/thing-making.ts')
      const make = (id: number, handle: string) => makeThingThroughEngine({
        actor: {
          id, handle, model: 'test', joined_at: '2026-10-21T00:00:00.000Z', quota_day: '2026-10-21',
          things_today: 0, notes_today: 0, agreement_actions_today: 0,
        },
        placeId: workshop, name: `${handle} work`, body: 'made in the same room at once',
        kindId: null, ingredientIds: [],
      })
      // Both makers reach the chain lock before either takes it. A shared lock on the room
      // that making then strengthens would leave each maker waiting on the other.
      const paused = barrier()
      let readers = 0
      sqlstates = []
      beforeQuery = async text => {
        if (!lockQuery(text)) return
        readers += 1
        if (readers === 2) paused.release()
        await paused.gate
      }
      try {
        const made = await Promise.all([make(2, 'chain-visitor'), make(3, 'sibling-visitor')])
        assert.deepEqual(made.map(result => result.ok), [true, true], JSON.stringify(made))
        assert.deepEqual(sqlstates, [], 'neither maker may deadlock')
        assert.deepEqual((await rows('make-race')).map(row => row.target_id), [a, a])
      } finally {
        beforeQuery = undefined
        paused.release()
      }
    })

    await t.test('a shared use of a thing and its owner carrying it up into the law source both finish', async () => {
      await client.query('UPDATE traits SET recipe = $1::jsonb WHERE id = 1', [
        JSON.stringify({ use: [write('use-carry', 5)], move: [write('use-carry-move', 5)] }),
      ])
      const room = await place('shared-use-room', a)
      await client.query('UPDATE places SET open_to_things = true WHERE id = ANY($1::int[])', [[room, a]])
      await client.query(`
        UPDATE resident_presence SET current_place_id = $1, home_place_id = NULL WHERE resident_id IN (2, 3)
      `, [room])
      const shared = (await client.query(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id, open_to_use)
        VALUES ($1, 'shared-lamp', 'used and carried at once', 2, 2, true) RETURNING id
      `, [room])).rows[0].id
      sqlstates = []
      // The carry takes its own thing before any place, as the use does, so the use waits
      // on the thing and never holds it while it waits for the carry's destination.
      const { paused, waitsOnPaused } = pauseAfterDestination()
      const moved = runAction({ actorId: 2, actorHandle: 'chain-visitor', action: 'move',
        placeId: room, destinationPlaceId: a, carryThingId: shared }, db)
      let used: ReturnType<typeof runAction> | undefined
      // The use records its action on its own connection: that insert names the thing,
      // so it waits on the carry's lock, and the polling client must stay free.
      const useClient = new Client(postgres.clientConfig)
      await useClient.connect()
      try {
        await atBarrier(paused.ready, moved)
        used = runAction({ actorId: 3, actorHandle: 'sibling-visitor', action: 'use',
          placeId: room, sourceThingId: shared }, taggedSql(useClient))
        await waitsOnPaused()
        paused.release()
        const [carry, use] = await Promise.all([moved, used])
        assert.equal(carry.status, 'applied', carry.error ?? '')
        assert.deepEqual(sqlstates, [], 'neither the use nor the carry may deadlock')
        assert.deepEqual({ status: use.status, httpStatus: use.httpStatus, error: use.error }, {
          status: 'failed', httpStatus: 403,
          error: `thing_id ${shared} must be in place_id ${room}; its current place_id is ${a}`,
        })
        assert.deepEqual((await client.query('SELECT place_id FROM things WHERE id = $1', [shared])).rows,
          [{ place_id: a }])
      } finally {
        paused.release()
        await Promise.allSettled([moved, used])
        afterQuery = undefined
        await useClient.end()
      }
    })

    await t.test('a carry out of a room and the retirement of that room both finish', async () => {
      const { beginCityCreditSpend, issueCityFeeCredit } = await import('../../src/city-credit.ts')
      const { completePlaceLifecycleOperation } = await import('../../src/place-lifecycle-operation.ts')
      const credit = {
        query: async (text: string, params: readonly unknown[] = []) => (
          await client.query(text, [...params])
        ).rows as Record<string, unknown>[],
      }
      const parent = await place('retire-parent', a)
      const room = await place('retiring-room', parent)
      await client.query('UPDATE places SET open_to_things = true WHERE id = ANY($1::int[])', [[parent, room]])
      await client.query(`
        UPDATE resident_presence SET current_place_id = $1, home_place_id = NULL WHERE resident_id = 3
      `, [room])
      const luggage = (await client.query(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id)
        VALUES ($1, 'leaving-luggage', 'intact', 3, 3) RETURNING id
      `, [room])).rows[0].id
      await issueCityFeeCredit(credit, {
        founderId: 1, residentId: 1, sourceKey: 'retire-race-credit', reason: 'fund the retirement race regression',
      })
      const requestId = 'retire-race-request'
      const spend = await beginCityCreditSpend(credit, {
        actorId: 1, operation: 'place_retire', targetKey: `place:${room}:retire:${requestId}`,
        request: { place_id: room }, requestId, assetType: 'place', assetId: room,
      })
      if (spend.state !== 'ready') assert.fail(`the retirement credit must be ready: ${spend.state}`)
      sqlstates = []
      // The carry holds the parent exclusively; the retirement must not hold the room
      // while it waits for that parent.
      const { paused, waitsOnPaused } = pauseAfterDestination()
      const moved = runAction({ actorId: 3, actorHandle: 'sibling-visitor', action: 'move',
        placeId: room, destinationPlaceId: parent, carryThingId: luggage }, db)
      let retiring: ReturnType<typeof completePlaceLifecycleOperation> | undefined
      try {
        await atBarrier(paused.ready, moved)
        retiring = completePlaceLifecycleOperation({
          query: credit.query,
          transaction: work => transaction(sql => work({
            query: async (text, params = []) => await sql.query!(text, [...params]) as Record<string, unknown>[],
          })),
        }, { attemptId: spend.attempt_id, leaseOwner: spend.lease_owner })
        await waitsOnPaused()
        paused.release()
        const [carry, completion] = await Promise.all([moved, retiring])
        assert.equal(carry.status, 'applied', carry.error ?? '')
        assert.equal(completion.state, 'completed', JSON.stringify(completion))
        assert.deepEqual(sqlstates, [], 'neither the carry nor the retirement may deadlock')
        assert.deepEqual((await client.query(`
          SELECT retired_at IS NOT NULL AS retired FROM places WHERE id = $1
        `, [room])).rows, [{ retired: true }])
        assert.deepEqual((await client.query('SELECT place_id FROM things WHERE id = $1', [luggage])).rows,
          [{ place_id: parent }])
      } finally {
        paused.release()
        await Promise.allSettled([moved, retiring])
        afterQuery = undefined
      }
    })

    // Pause the first statement that matches, after it ran, and remember its backend.
    const pauseAfterFirst = (match: (text: string) => boolean) => {
      const paused = barrier()
      let pid = 0
      const hook = async (text: string, connection: Client): Promise<boolean> => {
        if (pid !== 0 || !match(text)) return false
        pid = Number((await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        paused.reached()
        await paused.gate
        return true
      }
      return { paused, hook, pid: () => pid }
    }
    const waitsOnPid = async (pid: number): Promise<boolean> => {
      const deadline = Date.now() + 3_000
      while (Date.now() < deadline) {
        const waiting = await observer.query(`
          SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND $1::int = ANY(pg_blocking_pids(pid))
        `, [pid])
        if (waiting.rows.length > 0) return true
        await delay(20)
      }
      return false
    }
    const residentLock = (text: string) => /SELECT id FROM residents WHERE id = \$1 FOR NO KEY UPDATE/.test(text)
    const deadlocks = () => sqlstates.filter(code => code === '40P01')

    const targetLand = await place('target-land', world)
    const hall = await place('target-hall', targetLand)
    const alcove = await place('target-alcove', hall)
    await client.query('UPDATE places SET open_to_things = true WHERE id = ANY($1::int[])', [[hall, alcove]])
    await client.query(`
      INSERT INTO traits (id, name, description, recipe, coiner_id)
      VALUES (11, 'hall-tagging', 'marks the hall and the thing used upon', $1::jsonb, 1)
    `, [JSON.stringify({ use: [
      { effect: 'label', target: 'law_place', label: 'hall-busy', seconds: 60 },
      { effect: 'label', target: 'target', label: 'hall-tagged' },
    ] })])
    await client.query(`
      INSERT INTO place_law_changes (place_id, trait_id, actor_id, change_type, position)
      VALUES ($1, 11, 1, 'add', 0)
    `, [hall])
    for (const schedule of ['the carry holds the parcel first', 'the use holds the chain first'] as const) {
      await t.test(`a carry up into the law source and a use that targets the carried thing, ${schedule}`, async () => {
        await client.query(`
          UPDATE resident_presence SET current_place_id = $1, home_place_id = NULL WHERE resident_id IN (2, 3)
        `, [alcove])
        const [tool, parcel] = (await client.query(`
          INSERT INTO things (place_id, name, body, owner_id, maker_id)
          VALUES ($1, 'stamp', 'the user tool', 2, 2), ($1, 'parcel', 'carried up', 3, 3) RETURNING id
        `, [alcove])).rows.map(row => row.id)
        sqlstates = []
        // Each action reserves its room chain before the parcel. The contender waits
        // without holding a resource the first action still needs.
        const carryPause = pauseAfterFirst(schedule === 'the carry holds the parcel first'
          ? text => /FROM things WHERE id = ANY/.test(text) && /FOR UPDATE/.test(text)
          : residentLock)
        const usePause = pauseAfterFirst(lockQuery)
        afterQuery = async (text, connection) => {
          if (await carryPause.hook(text, connection)) return
          if (schedule === 'the use holds the chain first') await usePause.hook(text, connection)
        }
        const carry = runAction({ actorId: 3, actorHandle: 'sibling-visitor', action: 'move', placeId: alcove,
          destinationPlaceId: hall, carryThingId: parcel }, db)
        let use: ReturnType<typeof runAction> | undefined
        try {
          await atBarrier(carryPause.paused.ready, carry)
          use = runAction({ actorId: 2, actorHandle: 'chain-visitor', action: 'use', placeId: alcove,
            sourceThingId: tool, target: { type: 'thing', id: parcel } }, db)
          if (schedule === 'the carry holds the parcel first') {
            assert.ok(await waitsOnPid(carryPause.pid()), 'the use must wait on the carry')
            carryPause.paused.release()
          } else {
            await atBarrier(usePause.paused.ready, use)
            carryPause.paused.release()
            assert.ok(await waitsOnPid(usePause.pid()), 'the carry must wait on the use')
            usePause.paused.release()
          }
          const [moved, used] = await Promise.all([carry, use])
          assert.deepEqual(deadlocks(), [], 'neither action may deadlock')
          assert.equal(moved.status, 'applied', moved.error ?? '')
          if (schedule === 'the carry holds the parcel first') {
            assert.deepEqual({ status: used.status, httpStatus: used.httpStatus, error: used.error }, {
              status: 'failed', httpStatus: 403,
              error: `target thing must be in place_id ${alcove}; target current place_id is ${hall}`,
            })
          } else {
            assert.equal(used.status, 'applied', used.error ?? '')
            assert.deepEqual((await client.query(`
              SELECT label, target_type, target_id FROM active_labels
              WHERE label IN ('hall-busy', 'hall-tagged') ORDER BY id DESC LIMIT 2
            `)).rows.reverse(), [
              { label: 'hall-busy', target_type: 'place', target_id: hall },
              { label: 'hall-tagged', target_type: 'thing', target_id: parcel },
            ])
          }
          assert.deepEqual((await client.query('SELECT place_id FROM things WHERE id = $1', [parcel])).rows,
            [{ place_id: hall }])
        } finally {
          carryPause.paused.release()
          usePause.paused.release()
          await Promise.allSettled([carry, use])
          afterQuery = undefined
        }
      })
    }

    await t.test('a make under a law_place make law that waits and a waiting use in that room both finish', async () => {
      const land = await place('workshop-land', world)
      const workshop = await place('timer-workshop', land)
      await client.query('UPDATE places SET open_to_things = true WHERE id = $1', [workshop])
      const later = { effect: 'wait', seconds: 600, then: [{ effect: 'label', target: 'actor', label: 'workshop-later' }] }
      await client.query(`
        INSERT INTO traits (id, name, description, recipe, coiner_id)
        VALUES (12, 'workshop-rule', 'a room law that waits', $1::jsonb, 1)
      `, [JSON.stringify({
        make: [{ effect: 'label', target: 'law_place', label: 'workshop-busy', seconds: 60 }, later],
        use: [later],
      })])
      await client.query(`
        INSERT INTO place_law_changes (place_id, trait_id, actor_id, change_type, position)
        VALUES ($1, 12, 1, 'add', 0)
      `, [workshop])
      await client.query(`
        UPDATE resident_presence SET current_place_id = $1, home_place_id = NULL WHERE resident_id IN (1, 3)
      `, [workshop])
      const tool = (await client.query(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id)
        VALUES ($1, 'workshop-tool', 'used at once', 3, 3) RETURNING id
      `, [workshop])).rows[0].id
      const { makeThingThroughEngine } = await import('../../src/thing-making.ts')
      sqlstates = []
      // The use holds the room's timer queue; the make's exclusive room lock must still let
      // the use's queued effect name the room by foreign key.
      const usePause = pauseAfterFirst(text => /pg_advisory_xact_lock/.test(text))
      afterQuery = async (text, connection) => { await usePause.hook(text, connection) }
      const used = runAction({ actorId: 3, actorHandle: 'sibling-visitor', action: 'use', placeId: workshop,
        sourceThingId: tool }, db)
      let made: ReturnType<typeof makeThingThroughEngine> | undefined
      try {
        await atBarrier(usePause.paused.ready, used)
        made = makeThingThroughEngine({
          actor: {
            id: 1, handle: 'chain-owner', model: 'test', joined_at: '2026-10-22T00:00:00.000Z',
            quota_day: '2026-10-22', things_today: 0, notes_today: 0, agreement_actions_today: 0,
          },
          placeId: workshop, name: 'made while a use waits', body: 'one room, two queues',
          kindId: null, ingredientIds: [],
        })
        assert.ok(await waitsOnPid(usePause.pid()), 'the make must wait on the use timer queue')
        usePause.paused.release()
        const [use, make] = await Promise.all([used, made])
        assert.deepEqual(deadlocks(), [], 'neither action may deadlock')
        assert.equal(use.status, 'applied', use.error ?? '')
        assert.equal(make.ok, true, JSON.stringify(make))
        assert.deepEqual((await client.query(`
          SELECT count(*)::int AS pending FROM pending_effects WHERE place_id = $1
        `, [workshop])).rows, [{ pending: 2 }])
      } finally {
        usePause.paused.release()
        await Promise.allSettled([used, made])
        afterQuery = undefined
      }
    })

    for (const [from, to, giveLaw, giftFirst] of [
      ['west', 'east', false, false], ['east', 'west', false, false],
      ['west', 'east', false, true], ['east', 'west', false, true],
      ['west', 'east', true, true],
    ] as const) {
      const named = giveLaw ? ' under a law_place give law' : ''
      const order = giftFirst ? 'gift first' : 'walk first'
      await t.test(`a hinge walk ${from} to ${to} and a gift of the estate by its owner standing inside${named}, ${order}, both finish`, async () => {
        const tag = `${from}${giveLaw ? '-law' : ''}-${giftFirst ? 'gift' : 'walk'}`
        const land = await place(`estate-land-${tag}`, world)
        const estate = await place(`hinge-estate-${tag}`, land)
        const rooms = {
          west: await place(`estate-west-${tag}`, estate),
          east: await place(`estate-east-${tag}`, estate),
        }
        if (giveLaw) {
          await client.query(`
            INSERT INTO traits (id, name, description, recipe, coiner_id)
            VALUES (13, 'estate-given', 'marks the estate when it is given', $1::jsonb, 1)
          `, [JSON.stringify({ give: [{ effect: 'label', target: 'law_place', label: 'estate-given', seconds: 60 }] })])
          await client.query(`
            INSERT INTO place_law_changes (place_id, trait_id, actor_id, change_type, position)
            VALUES ($1, 13, 1, 'add', 0)
          `, [estate])
        }
        await client.query('UPDATE places SET hinge_to = $1 WHERE id = $2', [rooms.east, rooms.west])
        await client.query('UPDATE places SET hinge_to = $1 WHERE id = $2', [rooms.west, rooms.east])
        await client.query(`
          UPDATE resident_presence SET home_place_id = NULL,
            current_place_id = CASE resident_id WHEN 1 THEN $1::int ELSE $2::int END
          WHERE resident_id IN (1, 3)
        `, [rooms.east, rooms[from]])
        sqlstates = []
        // The winner reserves the rooms before the other request reaches them. A gift
        // reserves its whole subtree in depth and id order, with or without a give law.
        const walkPause = pauseAfterFirst(giftFirst ? residentLock : lockQuery)
        const giftPause = giftFirst ? pauseAfterFirst(lockQuery) : null
        afterQuery = async (text, connection) => {
          if (!(await walkPause.hook(text, connection))) await giftPause?.hook(text, connection)
        }
        const walked = runAction({ actorId: 3, actorHandle: 'sibling-visitor', action: 'move',
          placeId: rooms[from], destinationPlaceId: rooms[to] }, db)
        let given: Promise<Response> | undefined
        try {
          await atBarrier(walkPause.paused.ready, walked)
          given = Promise.resolve(app.request('/api/transfer', {
            method: 'POST',
            headers: { authorization: `Bearer ${ownerSecret}`, 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'place', id: estate, to_handle: 'chain-visitor' }),
          }))
          if (giftPause) {
            await atBarrier(giftPause.paused.ready, given)
            walkPause.paused.release()
            assert.ok(await waitsOnPid(giftPause.pid()), 'the walk must wait on the gift rooms')
            giftPause.paused.release()
          } else {
            assert.ok(await waitsOnPid(walkPause.pid()), 'the gift must wait on the walk rooms')
            walkPause.paused.release()
          }
          const [walk, response] = await Promise.all([walked, given])
          const body = await response.json() as { error?: string }
          assert.deepEqual(deadlocks(), [], 'neither the walk nor the gift may deadlock')
          assert.equal(response.status, 200, body.error)
          if (giftFirst) {
            // The gift completes its owner change before the walk can check the hinge.
            assert.deepEqual({ status: walk.status, httpStatus: walk.httpStatus, error: walk.error }, {
              status: 'failed', httpStatus: 403,
              error: `place_id ${rooms[to]} exists, but entry is closed from your current place_id ${rooms[from]}; entry opens when you stand in its parent, one of its direct children, or a place with an open hinge to it, so use the public map outline to move one edge at a time`,
            })
          } else assert.equal(walk.status, 'applied', walk.error ?? '')
          assert.deepEqual((await client.query(`
            SELECT owner_id FROM places WHERE id = ANY($1::int[]) ORDER BY id
          `, [[estate, rooms.west, rooms.east]])).rows.map(row => row.owner_id), [2, 2, 2])
          assert.deepEqual((await client.query(`
            SELECT current_place_id FROM resident_presence WHERE resident_id = 3
          `)).rows, [{ current_place_id: giftFirst ? rooms[from] : rooms[to] }])
        } finally {
          walkPause.paused.release()
          giftPause?.paused.release()
          await Promise.allSettled([walked, given])
          afterQuery = undefined
        }
      })
    }

    await t.test('setting home in a room and moving out of it at once both finish', async () => {
      const { setHomeAndRecordEvent } = await import('../../src/actions.ts')
      const land = await place('home-race-land', world)
      const room = await place('home-race-room', land)
      const below = await place('home-race-below', room)
      await client.query(`
        UPDATE resident_presence SET current_place_id = $1, home_place_id = NULL WHERE resident_id = 1
      `, [room])
      sqlstates = []
      // Both requests reserve the responsible resident before rooms or presence.
      const movePause = pauseAfterFirst(residentLock)
      afterQuery = async (text, connection) => { await movePause.hook(text, connection) }
      const moved = runAction({ actorId: 1, actorHandle: 'chain-owner', action: 'move', placeId: room,
        destinationPlaceId: below }, db)
      let homed: Promise<{ ok: boolean; error?: unknown }> | undefined
      try {
        await atBarrier(movePause.paused.ready, moved)
        homed = setHomeAndRecordEvent({ id: 1, handle: 'chain-owner' }, room, db).then(
          () => ({ ok: true }), (error: unknown) => ({ ok: false, error }))
        assert.ok(await waitsOnPid(movePause.pid()), 'setting home must wait on the move')
        movePause.paused.release()
        const [move, home] = await Promise.all([moved, homed])
        assert.deepEqual(deadlocks(), [], 'neither may deadlock')
        assert.equal(move.status, 'applied', move.error ?? '')
        assert.equal(home.ok, false)
        assert.ok(home.error instanceof EngineError && home.error.status === 403
          && home.error.message === 'home must be the owned place where you are standing', String(home.error))
        assert.deepEqual((await client.query(`
          SELECT current_place_id, home_place_id FROM resident_presence WHERE resident_id = 1
        `)).rows, [{ current_place_id: below, home_place_id: null }])
      } finally {
        movePause.paused.release()
        await Promise.allSettled([moved, homed])
        afterQuery = undefined
      }
    })

    const bakeryLand = await place('bakery-land', world)
    const bakery = await place('bakery', bakeryLand)
    await client.query('UPDATE places SET open_to_things = true WHERE id = $1', [bakery])
    await client.query(`
      UPDATE resident_presence SET current_place_id = $1, home_place_id = NULL WHERE resident_id IN (1, 3)
    `, [bakery])
    const kind = async (name: string, owner: number, recipe: readonly unknown[]): Promise<number> => {
      const id = (await client.query(`
        INSERT INTO kinds (name, owner_id) VALUES ($1, $2) RETURNING id
      `, [name, owner])).rows[0].id
      await client.query(`
        INSERT INTO kind_revisions (kind_id, revision, description, traits, recipe)
        VALUES ($1, 1, '', '{}', $2::jsonb)
      `, [id, JSON.stringify(recipe)])
      return id
    }
    const flour = await kind('bakery-flour', 1, [])
    // The visitor owns the loaf kind, so a use may aim at it; the room owner crafts it.
    const loaf = await kind('bakery-loaf', 3, [{ kind: 'bakery-flour', quantity: 1 }])
    const bakeryUse = [
      { effect: 'label', target: 'law_place', label: 'bakery-busy', seconds: 60 },
      { effect: 'label', target: 'target', label: 'bakery-dusted' },
    ]
    await client.query(`
      INSERT INTO traits (id, name, description, recipe, coiner_id)
      VALUES (14, 'bakery-rule', 'marks the bakery and what a use aims at', $1::jsonb, 1)
    `, [JSON.stringify({ use: bakeryUse })])
    await client.query(`
      INSERT INTO place_law_changes (place_id, trait_id, actor_id, change_type, position)
      VALUES ($1, 14, 1, 'add', 0)
    `, [bakery])
    const bakeryThings = async (openToUse = false) => {
      const sack = (await client.query(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id, kind_id, birth_revision, current_revision,
          open_to_use)
        VALUES ($1, 'flour-sack', 'one measure', 1, 1, $2, 1, 1, $3) RETURNING id
      `, [bakery, flour, openToUse])).rows[0].id
      const sieve = (await client.query(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id)
        VALUES ($1, 'sieve', 'the visitor tool', 3, 3) RETURNING id
      `, [bakery])).rows[0].id
      return { sack, sieve }
    }
    const craftLoaf = async (sack: number) => {
      const { makeThingThroughEngine } = await import('../../src/thing-making.ts')
      return makeThingThroughEngine({
        actor: {
          id: 1, handle: 'chain-owner', model: 'test', joined_at: '2026-10-22T00:00:00.000Z',
          quota_day: '2026-10-22', things_today: 0, notes_today: 0, agreement_actions_today: 0,
        },
        placeId: bakery, name: 'bakery loaf', body: 'baked from one sack', kindId: loaf, ingredientIds: [sack],
      })
    }

    for (const [makeLaw, shared] of [[false, false], [true, false], [false, true], [true, true]] as const) {
      const law = makeLaw ? 'under a law_place make law' : 'with no make law'
      const use = shared ? 'a shared use of it under a law_place use law' : 'a law_place use aimed at it'
      await t.test(`crafting from an ingredient and ${use}, ${law}, both finish`, async () => {
        await client.query('UPDATE traits SET recipe = $1::jsonb WHERE id = 14', [JSON.stringify(makeLaw
          ? { use: bakeryUse, make: [{ effect: 'label', target: 'law_place', label: 'bakery-baking', seconds: 60 }] }
          : { use: bakeryUse })])
        const { sack, sieve } = await bakeryThings(shared)
        sqlstates = []
        // The use holds the room and then the sack. Crafting waits for the room
        // before taking any ingredient the use might still need.
        const usePause = pauseAfterFirst(text => /FROM things WHERE id = ANY/.test(text) && /FOR UPDATE/.test(text))
        afterQuery = async (text, connection) => { await usePause.hook(text, connection) }
        const used = runAction({ actorId: 3, actorHandle: 'sibling-visitor', action: 'use', placeId: bakery,
          sourceThingId: shared ? sack : sieve, target: { type: 'thing', id: shared ? sieve : sack } }, db)
        let crafted: ReturnType<typeof craftLoaf> | undefined
        try {
          await atBarrier(usePause.paused.ready, used)
          crafted = craftLoaf(sack)
          assert.ok(await waitsOnPid(usePause.pid()), 'the crafting must wait on the use')
          usePause.paused.release()
          const [use, craft] = await Promise.all([used, crafted])
          assert.deepEqual(deadlocks(), [], 'neither may deadlock')
          assert.equal(use.status, 'applied', use.error ?? '')
          assert.equal(craft.ok, true, JSON.stringify(craft))
          assert.deepEqual((await client.query(`
            SELECT withdrawn_at IS NOT NULL AS used_up FROM things WHERE id = $1
          `, [sack])).rows, [{ used_up: true }])
        } finally {
          usePause.paused.release()
          await Promise.allSettled([used, crafted])
          afterQuery = undefined
        }
      })
    }

    await t.test('crafting a kind and a law_place use aimed at that kind both finish', async () => {
      await client.query('UPDATE traits SET recipe = $1::jsonb WHERE id = 14', [JSON.stringify({ use: bakeryUse })])
      const { sack, sieve } = await bakeryThings()
      sqlstates = []
      // The use takes its room chain, then the kind its recipe labels. The crafting takes the
      // room before the kind, so it waits for the room holding no kind.
      const usePause = pauseAfterFirst(lockQuery)
      afterQuery = async (text, connection) => { await usePause.hook(text, connection) }
      const used = runAction({ actorId: 3, actorHandle: 'sibling-visitor', action: 'use', placeId: bakery,
        sourceThingId: sieve, target: { type: 'kind', id: loaf } }, db)
      let crafted: ReturnType<typeof craftLoaf> | undefined
      try {
        await atBarrier(usePause.paused.ready, used)
        crafted = craftLoaf(sack)
        assert.ok(await waitsOnPid(usePause.pid()), 'the crafting must wait on the use')
        usePause.paused.release()
        const [use, craft] = await Promise.all([used, crafted])
        assert.deepEqual(deadlocks(), [], 'neither may deadlock')
        assert.equal(use.status, 'applied', use.error ?? '')
        assert.equal(craft.ok, true, JSON.stringify(craft))
        assert.deepEqual((await client.query(`
          SELECT target_type, target_id FROM active_labels WHERE label = 'bakery-dusted' ORDER BY id DESC LIMIT 1
        `)).rows, [{ target_type: 'kind', target_id: loaf }])
      } finally {
        usePause.paused.release()
        await Promise.allSettled([used, crafted])
        afterQuery = undefined
      }
    })

    await t.test("a craft naming another resident's thing elsewhere leaves it free and is refused", async () => {
      const elsewhere = await place('bakery-elsewhere', world)
      const vase = (await client.query(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id)
        VALUES ($1, 'vase', 'another resident thing', 2, 2) RETURNING id
      `, [elsewhere])).rows[0].id
      sqlstates = []
      // After its room, a craft locks only the ingredients the crafter owns in its room; the
      // make step reads the rest and refuses them under its own checks.
      const craftPause = pauseAfterFirst(text => /crafting:ingredients/.test(text))
      afterQuery = async (text, connection) => { await craftPause.hook(text, connection) }
      const crafted = craftLoaf(vase)
      try {
        await atBarrier(craftPause.paused.ready, crafted)
        const free = await client.query('SELECT id FROM things WHERE id = $1 FOR UPDATE NOWAIT', [vase]).then(
          () => true,
          (error: unknown) => {
            if (error && typeof error === 'object' && 'code' in error && error.code === '55P03') return false
            throw error
          },
        )
        assert.equal(free, true, "the other resident's vase must stay free while the craft runs")
        craftPause.paused.release()
        assert.deepEqual(await crafted, {
          ok: false, status: 409,
          error: 'every ingredient must be active, owned by you, in the requested place_id, and not offered for sale',
        })
        assert.deepEqual(deadlocks(), [], 'the craft may not deadlock')
        assert.deepEqual((await client.query('SELECT withdrawn_at FROM things WHERE id = $1', [vase])).rows,
          [{ withdrawn_at: null }])
      } finally {
        craftPause.paused.release()
        await Promise.allSettled([crafted])
        afterQuery = undefined
      }
    })
  } finally {
    routeDb = null
    setEngineTransactionRunnerForTests(null)
    await observer.end().catch(() => undefined)
    await client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})

test('shared use and wait effects execute against PostgreSQL', async () => {
  const postgres = await startPostgres()
  try {
    const { COLLISION_CONFLICT_MESSAGE } = await import('../../src/core.ts')
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
        if (!/SELECT thing.id, thing.place_id FROM things thing.*FOR UPDATE OF thing/.test(text)) return
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
        reservedPlaceIds: [placeId, firstDestinationId],
      }, firstMoveDb)
      const firstMoveEndedEarly = firstMove.then(
        () => {
          throw new Error('first move finished before reaching its target lock')
        },
        (error: unknown) => {
          throw error
        },
      )
      await Promise.race([
        firstMoveReady,
        firstMoveEndedEarly,
        delay(5_000, undefined, { ref: false }).then(() => {
          throw new Error('first move did not reach its target lock')
        }),
      ])

      assert.equal(await executeEffects(moveSource, {
        ...raceContext,
        destinationPlaceId: secondDestinationId,
        reservedPlaceIds: [placeId, secondDestinationId],
      }, secondMoveDb), 1)
      await secondMoveClient.query('COMMIT')
      releaseFirstMove()

      // Attribution now locks the target before the guarded update. The stored room
      // plan refuses the stale source there, before the losing move can write anything.
      await assert.rejects(firstMove, (error: unknown) => (
        error instanceof EngineError
        && error.status === 409
        && error.message === COLLISION_CONFLICT_MESSAGE
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
