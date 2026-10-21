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
import {
  EngineError, runAction, setEngineTransactionRunnerForTests, type TaggedSql,
} from '../../src/engine.ts'
import type { Effect } from '../../src/physics.ts'
import { ensureChanceDays } from '../../src/engine-chance.ts'

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

test('law_place shares one timed condition through the current owner chain', async t => {
  const postgres = await startPostgres()
  const client = postgres.client
  const db = taggedSql(client)
  let beforeQuery: ((text: string) => Promise<void>) | undefined
  const transaction = async <T>(work: (sql: TaggedSql) => Promise<T>): Promise<T> => {
    const connection = new Client(postgres.clientConfig)
    await connection.connect()
    try {
      await connection.query("SET statement_timeout = '8s'")
      await connection.query('BEGIN')
      const result = await work(taggedSql(connection, beforeQuery))
      await connection.query('COMMIT')
      return result
    } catch (error) {
      await connection.query('ROLLBACK')
      throw error
    } finally {
      await connection.end()
    }
  }
  setEngineTransactionRunnerForTests((_ignored, work) => transaction(sql => work(sql, true)))
  try {
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
      await execute([write('shared-rain', 1)])
      await delay(1_100)
      await execute([check('shared-rain', 'expired'), check('shared-rain', 'named-law', 'place')])
      assert.equal(await present('expired-no'), true)
      assert.equal(await present('named-law-yes'), true)
      await execute([write('one-second'), write('repeated'), write('repeated', 4)])
      await execute([{ effect: 'label', target: 'place', label: 'literal-second', seconds: 1 }])
      await execute([{ effect: 'label', target: 'place', label: 'permanent-collision' }], { ...context, placeId: a })
      await execute([write('permanent-collision')])
      await delay(1_100)
      await execute([check('one-second', 'one-second'), check('repeated', 'repeated'),
        check('permanent-collision', 'permanent'), check('literal-second', 'literal', 'place')])
      assert.equal(await present('one-second-no'), true)
      assert.equal(await present('repeated-yes'), true)
      assert.equal(await present('permanent-yes'), true)
      assert.equal(await present('literal-no'), true)
      assert.equal((await rows('one-second')).length, 1)
      assert.equal((await rows('repeated')).length, 2)
      assert.equal((await rows('permanent-collision')).length, 2)
      await delay(3_000)
      await execute([check('repeated', 'all-expired')])
      assert.equal(await present('all-expired-no'), true)
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
    const lockQuery = (text: string) => /WITH RECURSIVE/.test(text) && /FOR SHARE OF place/.test(text)
    const waitForLock = async () => {
      const end = Date.now() + 5_000
      while (Date.now() < end) {
        await client.query('SELECT pg_stat_clear_snapshot()')
        const waiting = await client.query(`
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

    await t.test('a timer locks actor presence before ancestry like a concurrent action', async () => {
      const destination = await place('presence-race-destination', b)
      await execute([{ effect: 'wait', seconds: 1, then: [
        { effect: 'move', target: 'actor', to: 'destination' }, write('presence-race'),
      ] }], { ...context, destinationPlaceId: destination })
      const paused = barrier()
      beforeQuery = async text => {
        if (/FROM resident_presence/.test(text) && /FOR UPDATE/.test(text)) {
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
  } finally {
    setEngineTransactionRunnerForTests(null)
    await client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})

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
        && error.message === 'thing or destination changed before the move; re-read both and retry'
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
