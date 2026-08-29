import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Pool, type PoolClient } from 'pg'

import { issueCityFeeCredit, type CityCreditDatabase } from '../../src/city-credit.ts'
import type { Resident } from '../../src/core.ts'
import type { TaggedSql } from '../../src/engine.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'world_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')

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

mock.module(new URL('../../src/db.ts', import.meta.url).href, {
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

test('world mutations plan and commit atomically in PostgreSQL', async t => {
  const postgres = await startPostgres()
  database = postgres.client
  try {
    const { replacePlaceLaws } = await import('../../src/laws.ts')
    const { withdrawThing } = await import('../../src/withdrawal.ts')

    await t.test('law replacement keeps typed actor IDs and append-only history', async () => {
      const roomId = await resetDatabase()
      const initial = await replacePlaceLaws(actor, roomId, ['peaceful', 'war-zone'])
      assert.equal('error' in initial, false)
      const replaced = await replacePlaceLaws(actor, roomId, ['war-zone'])
      assert.equal('error' in replaced, false)
      assert.deepEqual(replaced, [{ id: 2, name: 'war-zone', position: 0 }])
      const history = await database!.query(`
        SELECT change.actor_id, change.change_type, change.position, trait.name
        FROM place_law_changes change
        JOIN traits trait ON trait.id = change.trait_id
        WHERE change.place_id = $1
        ORDER BY change.id
      `, [roomId])
      assert.deepEqual(history.rows, [
        { actor_id: 1, change_type: 'add', position: 0, name: 'peaceful' },
        { actor_id: 1, change_type: 'add', position: 1, name: 'war-zone' },
        { actor_id: 1, change_type: 'remove', position: null, name: 'peaceful' },
        { actor_id: 1, change_type: 'add', position: 0, name: 'war-zone' },
      ])
      const events = await database!.query(`
        SELECT kind, detail FROM events
        WHERE kind = 'laws_changed'
        ORDER BY id
      `)
      assert.deepEqual(events.rows, [
        { kind: 'laws_changed', detail: { place_id: roomId, traits: ['peaceful', 'war-zone'] } },
        { kind: 'laws_changed', detail: { place_id: roomId, traits: ['war-zone'] } },
      ])
    })
    await t.test('withdrawal writes the timestamp and event in one statement', async () => {
      await resetDatabase()
      const result = await withdrawThing(actor, 1, 'destroyed')
      assert.equal('error' in result, false)
      assert.ok(Number.isFinite(Date.parse(String('withdrawn_at' in result ? result.withdrawn_at : ''))))
      const state = await database!.query(`
        SELECT thing.withdrawn_at IS NOT NULL AS withdrawn,
          event.kind, event.detail,
          jsonb_typeof(event.detail->'reason') AS reason_type
        FROM things thing
        JOIN events event ON (event.detail->>'thing_id')::integer = thing.id
        WHERE thing.id = 1
      `)
      assert.deepEqual(state.rows, [{
        withdrawn: true,
        kind: 'thing_withdrawn',
        detail: { thing_id: 1, reason: 'destroyed' },
        reason_type: 'string',
      }])
    })

    const { Hono } = await import('hono')
    const { setEngineTransactionRunnerForTests } = await import('../../src/engine.ts')
    const { executeEffects } = await import('../../src/engine-effects.ts')
    const { mountDrawingRoutes } = await import('../../src/drawings.ts')
    const { mountSocietyRoutes } = await import('../../src/society.ts')
    const { mountWorldRoutes } = await import('../../src/world.ts')
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

    await t.test('fresh schema attributes the exact world drawing to the founder once', async () => {
      await resetDatabase()
      const history = await database!.query(`
        SELECT revision.prior_state, revision.prior_description,
          revision.prior_drawing, revision.prior_source,
          revision.current_state, revision.current_description,
          revision.current_drawing = place.drawing AS exact_current_drawing,
          revision.current_source, revision.author_id, revision.author_relation
        FROM places place
        JOIN drawing_revisions revision
          ON revision.target_type = 'place' AND revision.target_id = place.id
        WHERE place.place_kind = 'world'
        ORDER BY revision.id
      `)
      assert.deepEqual(history.rows, [{
        prior_state: 'undrawn',
        prior_description: null,
        prior_drawing: null,
        prior_source: 'none',
        current_state: 'complete',
        current_description: '',
        exact_current_drawing: true,
        current_source: 'place',
        author_id: null,
        author_relation: 'founder',
      }])
    })

    await t.test('undrawn pinned kinds expose no false drawing provenance through routes or snapshots', async () => {
      const roomId = await resetDatabase()
      const completeDrawing = Object.freeze({
        palette: Object.freeze(['#174d3c']),
        indices: Object.freeze([0, ...Array.from({ length: 63 }, () => null)]),
      })
      const kindId = Number((await database!.query<{ id: number }>(`
        INSERT INTO kinds (name, owner_id, current_revision)
        VALUES ('provenance-lantern', 1, 2)
        RETURNING id
      `)).rows[0]!.id)
      await database!.query(`
        INSERT INTO kind_revisions (
          kind_id, revision, description, traits, recipe,
          drawing, drawing_state, drawing_description, drawing_variants
        ) VALUES
          ($1, 1, 'The inherited base is deliberately undrawn.', '{}', '[]',
            NULL, 'undrawn', NULL, '[]'),
          ($1, 2, 'The inherited base is now complete.', '{}', '[]',
            $2, 'complete', 'A dark green lantern with one lit square.', '[]')
      `, [kindId, completeDrawing])
      await database!.query(`
        INSERT INTO things (
          id, place_id, name, body, owner_id, maker_id,
          kind_id, birth_revision, current_revision,
          drawing, drawing_state, drawing_description, drawing_variant_name
        ) VALUES
          (2, $1, 'refusal provenance', '', 1, 1, $2, 1, 1, NULL, 'undrawn', NULL, NULL),
          (3, $1, 'upgrade provenance', '', 1, 1, $2, 1, 1, NULL, 'undrawn', NULL, NULL)
      `, [roomId, kindId])

      const currentBefore = await app.request('/api/drawing/thing/2')
      assert.equal(currentBefore.status, 200, await currentBefore.clone().text())
      assert.deepEqual(await currentBefore.json(), {
        type: 'thing', id: 2,
        state: 'undrawn', presentation_state: 'undrawn',
        description: null, drawing: null, rows: null, source: 'none',
      })
      const snapshotBefore = (await database!.query<{ payload: Record<string, unknown> }>(`
        SELECT payload FROM city_snapshot.public_records
        WHERE class_name = 'things' AND record_id = '2'
      `)).rows[0]!.payload
      assert.equal(snapshotBefore.drawing_source, 'none')
      assert.equal(snapshotBefore.kind_id, null)
      assert.equal(snapshotBefore.kind_name, null)
      assert.equal(snapshotBefore.revision, null)
      assert.equal(snapshotBefore.variant_name, null)

      const refused = await app.request('/api/thing/2', {
        method: 'PATCH',
        headers: { ...bearer(founderSecret), 'content-type': 'application/json' },
        body: JSON.stringify({
          drawing: 'REFUSE',
          drawing_description: 'I decline to show this pinned kind drawing.',
        }),
      })
      assert.equal(refused.status, 200, await refused.clone().text())
      const cleared = await app.request('/api/thing/2', {
        method: 'PATCH',
        headers: { ...bearer(founderSecret), 'content-type': 'application/json' },
        body: JSON.stringify({ drawing: null }),
      })
      assert.equal(cleared.status, 200, await cleared.clone().text())

      const refusalHistory = await app.request('/api/drawing/thing/2/history')
      assert.equal(refusalHistory.status, 200, await refusalHistory.clone().text())
      const refusalRevisions = (await refusalHistory.json() as {
        revisions: Array<{
          previous: Record<string, unknown>
          current: Record<string, unknown>
        }>
      }).revisions
      assert.equal(refusalRevisions.length, 2)
      assert.deepEqual(refusalRevisions[1]!.previous, {
        state: 'undrawn', presentation_state: 'undrawn',
        description: null, drawing: null, rows: null, source: 'none',
      })
      assert.deepEqual(refusalRevisions[1]!.current, {
        state: 'refused', presentation_state: 'refused',
        description: 'I decline to show this pinned kind drawing.',
        drawing: null, rows: null, source: 'thing',
        kind_id: kindId, revision: 1,
      })
      assert.deepEqual(refusalRevisions[0]!.previous, refusalRevisions[1]!.current)
      assert.deepEqual(refusalRevisions[0]!.current, {
        state: 'undrawn', presentation_state: 'undrawn',
        description: null, drawing: null, rows: null, source: 'none',
      })

      const upgraded = await app.request('/api/thing/3/upgrade', {
        method: 'POST',
        headers: bearer(founderSecret),
      })
      assert.equal(upgraded.status, 200, await upgraded.clone().text())
      const upgradeHistory = await app.request('/api/drawing/thing/3/history')
      assert.equal(upgradeHistory.status, 200, await upgradeHistory.clone().text())
      const upgradeRevision = (await upgradeHistory.json() as {
        revisions: Array<{
          previous: Record<string, unknown>
          current: Record<string, unknown>
        }>
      }).revisions[0]!
      assert.deepEqual(upgradeRevision.previous, {
        state: 'undrawn', presentation_state: 'undrawn',
        description: null, drawing: null, rows: null, source: 'none',
      })
      assert.deepEqual(upgradeRevision.current, {
        state: 'complete', presentation_state: 'complete',
        description: 'A dark green lantern with one lit square.',
        drawing: completeDrawing,
        rows: [
          '0 . . . . . . .',
          '. . . . . . . .',
          '. . . . . . . .',
          '. . . . . . . .',
          '. . . . . . . .',
          '. . . . . . . .',
          '. . . . . . . .',
          '. . . . . . . .',
        ],
        source: 'kind_base', kind_id: kindId,
        kind_name: 'provenance-lantern', revision: 2,
      })
    })

    await t.test('thing upgrade refuses a busy kind promptly, then adopts the committed latest revision', async () => {
      const roomId = await resetDatabase()
      const completeDrawing = Object.freeze({
        palette: Object.freeze(['#174d3c']),
        indices: Object.freeze([0, ...Array.from({ length: 63 }, () => null)]),
      })
      const kindId = Number((await database!.query<{ id: number }>(`
        INSERT INTO kinds (name, owner_id, current_revision)
        VALUES ('serialized-lantern', 1, 2)
        RETURNING id
      `)).rows[0]!.id)
      await database!.query(`
        INSERT INTO kind_revisions (
          kind_id, revision, description, traits, recipe,
          drawing, drawing_state, drawing_description, drawing_variants
        ) VALUES
          ($1, 1, 'The birth revision is deliberately undrawn.', '{}', '[]',
            NULL, 'undrawn', NULL, '[]'),
          ($1, 2, 'The current revision has a complete drawing.', '{}', '[]',
            $2, 'complete', 'A dark green lantern with one lit square.', '[]')
      `, [kindId, completeDrawing])
      await database!.query(`
        INSERT INTO things (
          id, place_id, name, body, owner_id, maker_id,
          kind_id, birth_revision, current_revision
        ) VALUES (2, $1, 'serialized upgrade', '', 1, 1, $2, 1, 1)
      `, [roomId, kindId])

      const reviser = await database!.connect()
      const startedAt = Date.now()
      let pendingUpgrade: Promise<Response> | undefined
      try {
        await reviser.query('BEGIN')
        await reviser.query('SELECT id FROM kinds WHERE id = $1 FOR UPDATE', [kindId])
        await reviser.query(`
          INSERT INTO kind_revisions (
            kind_id, revision, description, traits, recipe,
            drawing, drawing_state, drawing_description, drawing_variants
          ) VALUES ($1, 3, 'The concurrently committed latest revision.', '{}', '[]',
            $2, 'complete', 'The committed latest lantern drawing.', '[]')
        `, [kindId, completeDrawing])
        await reviser.query('UPDATE kinds SET current_revision = 3 WHERE id = $1', [kindId])

        const upgradeRequest = Promise.resolve(app.request('/api/thing/2/upgrade', {
          method: 'POST',
          headers: bearer(founderSecret),
        }))
        pendingUpgrade = upgradeRequest
        const firstResult = await Promise.race([
          upgradeRequest.then(response => ({ response })),
          delay(1_000).then(() => ({ response: null })),
        ])
        assert.ok(firstResult.response, 'upgrade must not wait one second on a kind revision lock')
        assert.equal(firstResult.response.status, 409, await firstResult.response.clone().text())
        assert.match(
          (await firstResult.response.json() as { error: string }).error,
          /changing this thing or kind.*retry/iu,
        )

        const unchanged = await database!.query(`
          SELECT current_revision,
            (SELECT count(*)::integer FROM drawing_revisions
              WHERE target_type = 'thing' AND target_id = 2) AS drawing_revisions,
            (SELECT count(*)::integer FROM events
              WHERE kind = 'thing_upgraded' AND (detail->>'thing_id')::integer = 2) AS events
          FROM things WHERE id = 2
        `)
        assert.deepEqual(unchanged.rows, [{ current_revision: 1, drawing_revisions: 0, events: 0 }])
        await reviser.query('COMMIT')
      } finally {
        await reviser.query('ROLLBACK').catch(() => undefined)
        reviser.release()
        if (pendingUpgrade) await pendingUpgrade.catch(() => undefined)
      }

      assert.ok(Date.now() - startedAt < 2_000, 'busy-kind refusal must stay bounded')
      const retried = await app.request('/api/thing/2/upgrade', {
        method: 'POST',
        headers: bearer(founderSecret),
      })
      assert.equal(retried.status, 200, await retried.clone().text())
      assert.equal(
        (await retried.json() as { thing: { current_revision: number } }).thing.current_revision,
        3,
      )
      const committed = await database!.query(`
        SELECT current_revision,
          (SELECT count(*)::integer FROM drawing_revisions
            WHERE target_type = 'thing' AND target_id = 2) AS drawing_revisions,
          (SELECT count(*)::integer FROM events
            WHERE kind = 'thing_upgraded' AND (detail->>'thing_id')::integer = 2) AS events
        FROM things WHERE id = 2
      `)
      assert.deepEqual(committed.rows, [{ current_revision: 3, drawing_revisions: 1, events: 1 }])
    })

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

    await t.test('gift and effect transfers publish their interaction resident and place', async () => {
      const roomId = await resetDatabase()
      await database!.query(`
        INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
        VALUES
          (1, $1, $1),
          (2, $1, NULL)
      `, [roomId])
      await database!.query(`
        INSERT INTO things (id, place_id, name, body, owner_id, maker_id)
        VALUES (2, $1, 'effect gift', 'transferred by a thing effect', 1, 1)
      `, [roomId])

      setEngineTransactionRunnerForTests(async (_db, work) => {
        const connection = await database!.connect()
        try {
          await connection.query('BEGIN')
          const result = await work(transactionSql(connection), true)
          await connection.query('COMMIT')
          return result
        } catch (error) {
          await connection.query('ROLLBACK').catch(() => undefined)
          throw error
        } finally {
          connection.release()
        }
      })
      let giftResponse: Response
      try {
        giftResponse = await app.request('/api/transfer', {
          method: 'POST',
          headers: { ...bearer(founderSecret), 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'thing', id: 1, to_handle: 'neighbor' }),
        })
      } finally {
        setEngineTransactionRunnerForTests(null)
      }
      assert.equal(giftResponse.status, 200, await giftResponse.clone().text())

      const effectsApplied = await executeEffects([{
        effect: 'transfer',
        target: 'source',
        to: 'recipient',
      }], {
        actionId: null,
        actorId: 1,
        actorHandle: 'founder',
        placeId: roomId,
        sourceThingId: 2,
        sharedSourceThingId: null,
        target: null,
        destinationPlaceId: null,
        recipientId: 2,
        sourceTraitId: null,
        lawAuthority: null,
        parentEffectId: null,
        generation: 0,
        logicalAt: new Date(),
      }, sql)
      assert.equal(effectsApplied, 1)

      const committed = await database!.query(`
        SELECT event.actor, event.detail->>'mode' AS mode,
          (event.detail->>'resident_id')::integer AS resident_id,
          (event.detail->>'place_id')::integer AS place_id,
          coalesce(event.detail->>'asset_type', event.detail->>'type') AS asset_type,
          coalesce(
            (event.detail->>'asset_id')::integer,
            (event.detail->>'id')::integer
          ) AS asset_id,
          thing.owner_id
        FROM events event
        JOIN things thing ON thing.id = coalesce(
          (event.detail->>'asset_id')::integer,
          (event.detail->>'id')::integer
        )
        WHERE event.kind = 'transfer'
        ORDER BY event.id
      `)
      assert.deepEqual(committed.rows, [
        {
          actor: 'founder',
          mode: 'gift',
          resident_id: 2,
          place_id: roomId,
          asset_type: 'thing',
          asset_id: 1,
          owner_id: 2,
        },
        {
          actor: 'founder',
          mode: 'effect',
          resident_id: 2,
          place_id: roomId,
          asset_type: 'thing',
          asset_id: 2,
          owner_id: 2,
        },
      ])
    })

    await t.test('generic place, gift, and offer routes cannot alter the closed Gazette shell', async () => {
      const ordinaryRoomId = await resetDatabase()
      const continentId = Number((await database!.query<{ parent_id: number }>(
        'SELECT parent_id FROM places WHERE id = $1',
        [ordinaryRoomId],
      )).rows[0]!.parent_id)
      assert.equal(continentId, 2, 'the Gazette contract owns city place #2 as its parent')
      await database!.query(`
        INSERT INTO places (
          id, parent_id, place_kind, name, description, purpose, owner_id,
          open_to_building, open_to_things, open_to_notes
        ) VALUES (
          454, 2, 'place', 'the gazette submission room',
          'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
          '', 1, FALSE, FALSE, FALSE
        );
        INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
        VALUES (1, 454, 454), (2, 454, 454);
      `)

      setEngineTransactionRunnerForTests(async (_db, work) => {
        const connection = await database!.connect()
        try {
          await connection.query('BEGIN')
          const result = await work(transactionSql(connection), true)
          await connection.query('COMMIT')
          return result
        } catch (error) {
          await connection.query('ROLLBACK').catch(() => undefined)
          throw error
        } finally {
          connection.release()
        }
      })
      let responses: readonly Response[]
      try {
        responses = await Promise.all([
          app.request('/api/place/454', {
            method: 'PATCH',
            headers: { ...bearer(founderSecret), 'content-type': 'application/json' },
            body: JSON.stringify({ description: 'generic route edit' }),
          }),
          app.request('/api/transfer', {
            method: 'POST',
            headers: { ...bearer(founderSecret), 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'place', id: 454, to_handle: 'neighbor' }),
          }),
          app.request('/api/transfer/offer', {
            method: 'POST',
            headers: { ...bearer(founderSecret), 'content-type': 'application/json' },
            body: JSON.stringify({
              type: 'place',
              id: 454,
              to_handle: 'neighbor',
              price_usdc: 1,
              seller_wallet: `0x${'1'.repeat(40)}`,
            }),
          }),
        ])
      } finally {
        setEngineTransactionRunnerForTests(null)
      }

      for (const response of responses) assert.ok(response.status >= 400)
      assert.deepEqual((await database!.query(`
        SELECT gazette_submission_room_state(place) AS state,
          (SELECT count(*)::integer FROM transfers WHERE asset_type = 'place' AND asset_id = 454)
            AS transfers,
          (SELECT count(*)::integer FROM transfer_offers
            WHERE asset_type = 'place' AND asset_id = 454) AS offers
        FROM places place WHERE place.id = 454
      `)).rows[0], { state: 'closed', transfers: 0, offers: 0 })
    })

    await t.test('twelve immediate paid kind requests complete through the real public route', async () => {
      await resetDatabase()
      const creditDatabase: CityCreditDatabase = {
        query: async (text, params = []) => (
          await database!.query(text, [...params])
        ).rows,
      }
      for (let index = 0; index < 12; index += 1) {
        const issued = await issueCityFeeCredit(creditDatabase, {
          founderId: 1,
          residentId: 2,
          sourceKey: `route-burst-kind-credit-${index}`,
          reason: `fund route burst kind ${index}`,
        })
        assert.equal(issued.disposition, 'created')
      }

      for (let index = 0; index < 12; index += 1) {
        const name = `route-burst-kind-${index.toString().padStart(2, '0')}`
        const response = await app.request('/api/kind', {
          method: 'POST',
          headers: {
            ...bearer(neighborSecret),
            'content-type': 'application/json',
            'X-1F3D9-FEE-CREDIT': `route-burst-kind-request-${index}`,
          },
          body: JSON.stringify({
            name,
            description: `Immediate route completion proof ${index}.`,
            traits: [],
            recipe: [],
          }),
        })
        assert.equal(response.status, 201, `request ${index}: ${await response.clone().text()}`)
        const body = await response.json() as {
          readonly kind: { readonly name: string }
          readonly city_fee_credit: { readonly spent_usdc: string }
        }
        assert.equal(body.kind.name, name)
        assert.equal(body.city_fee_credit.spent_usdc, '1.000000')
      }

      const finalState = await database!.query<{
        completed_attempts: number
        spend_entries: number
        return_entries: number
        kind_count: number
        event_count: number
        balance_units: string
      }>(`
        SELECT
          (SELECT count(*)::int FROM payment_attempts
            WHERE actor_id = 2 AND operation = 'kind_invention' AND status = 'completed')
            AS completed_attempts,
          (SELECT count(*)::int FROM city_credit_entries
            WHERE resident_id = 2 AND entry_kind = 'spend') AS spend_entries,
          (SELECT count(*)::int FROM city_credit_entries
            WHERE resident_id = 2 AND entry_kind = 'return') AS return_entries,
          (SELECT count(*)::int FROM kinds
            WHERE owner_id = 2 AND name LIKE 'route-burst-kind-%') AS kind_count,
          (SELECT count(*)::int FROM events
            WHERE actor = 'neighbor' AND kind = 'kind_invented') AS event_count,
          (SELECT balance_units::text FROM city_credit_accounts WHERE resident_id = 2)
            AS balance_units
      `)
      assert.deepEqual(finalState.rows, [{
        completed_attempts: 12,
        spend_entries: 12,
        return_entries: 0,
        kind_count: 12,
        event_count: 12,
        balance_units: '0',
      }])
    })

    await t.test('the reported parent and child both accept make through the public route', async () => {
      const existingRoomId = await resetDatabase()
      const continentId = Number((await database!.query<{ parent_id: number }>(
        'SELECT parent_id FROM places WHERE id = $1',
        [existingRoomId],
      )).rows[0]!.parent_id)
      await database!.query(`
        INSERT INTO places (id, parent_id, place_kind, name, description, owner_id)
        VALUES
          (112, $1, 'place', 'the presence exemption', 'reported parent room', 1),
          (173, 112, 'place', 'the second reading', 'reported child room', 1)
      `, [continentId])
      await database!.query(`
        INSERT INTO traits (id, name, description, recipe, coiner_id)
        VALUES (50, 'hospitable', 'inert inherited law', NULL, 1)
      `)
      await database!.query(`
        INSERT INTO place_law_changes (place_id, trait_id, change_type, position, actor_id)
        VALUES (112, 50, 'add', 0, 1)
      `)
      await database!.query(`
        INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
        VALUES (1, 112, 112)
      `)
      await database!.query(`SELECT setval('places_id_seq', (SELECT max(id) FROM places), true)`)
      await database!.query(`SELECT setval('things_id_seq', (SELECT max(id) FROM things), true)`)

      setEngineTransactionRunnerForTests(async (_db, work) => {
        const connection = await database!.connect()
        try {
          await connection.query('BEGIN')
          const result = await work(transactionSql(connection), true)
          await connection.query('COMMIT')
          return result
        } catch (error) {
          await connection.query('ROLLBACK').catch(() => undefined)
          throw error
        } finally {
          connection.release()
        }
      })
      let parentResponse: Response
      let childResponse: Response
      try {
        parentResponse = await app.request('/api/thing', {
          method: 'POST',
          headers: { ...bearer(founderSecret), 'content-type': 'application/json' },
          body: JSON.stringify({
            place_id: 112,
            name: 'strata parent reproduction',
            body: 'p'.repeat(3_400),
          }),
        })
        await database!.query(`
          UPDATE resident_presence SET current_place_id = 173 WHERE resident_id = 1
        `)
        childResponse = await app.request('/api/thing', {
          method: 'POST',
          headers: { ...bearer(founderSecret), 'content-type': 'application/json' },
          body: JSON.stringify({
            place_id: 173,
            name: 'strata child control',
            body: 'c'.repeat(66),
          }),
        })
      } finally {
        setEngineTransactionRunnerForTests(null)
      }

      assert.equal(parentResponse.status, 201, await parentResponse.clone().text())
      assert.equal(childResponse.status, 201, await childResponse.clone().text())
      const parentBody = await parentResponse.json() as {
        readonly reading_cost: { readonly available: boolean }
      }
      const childBody = await childResponse.json() as {
        readonly reading_cost: { readonly available: boolean }
      }
      assert.equal(parentBody.reading_cost.available, true)
      assert.equal(childBody.reading_cost.available, true)
      const recorded = await database!.query<{
        action_place_id: number
        thing_place_id: number
        event_place_id: string
        status: string
      }>(`
        SELECT action.place_id AS action_place_id,
          thing.place_id AS thing_place_id,
          event.detail->>'place_id' AS event_place_id,
          resolution.status
        FROM things thing
        JOIN events event ON event.kind = 'thing_created'
          AND (event.detail->>'thing_id')::integer = thing.id
        JOIN action_runs action ON action.actor_id = thing.maker_id
          AND action.place_id = thing.place_id
          AND action.action_name = 'make'
        JOIN action_resolutions resolution ON resolution.action_run_id = action.id
        WHERE thing.name IN ('strata parent reproduction', 'strata child control')
        ORDER BY thing.place_id
      `)
      assert.deepEqual(recorded.rows, [
        { action_place_id: 112, thing_place_id: 112, event_place_id: '112', status: 'applied' },
        { action_place_id: 173, thing_place_id: 173, event_place_id: '173', status: 'applied' },
      ])
    })

    await t.test('an existing agreement stays closed until its creator opts in', async () => {
      await resetDatabase()
      const agreementId = await seedAgreement()

      const closedSign = await app.request(`/api/agreement/${agreementId}/sign`, {
        method: 'POST',
        headers: bearer(neighborSecret),
      })
      assert.equal(closedSign.status, 403)

      const state = await database!.query(`
        SELECT
          EXISTS(SELECT 1 FROM agreement_accession_openings WHERE agreement_id = $1) AS opened,
          EXISTS(SELECT 1 FROM agreement_parties WHERE agreement_id = $1 AND resident_id = 2) AS joined,
          EXISTS(SELECT 1 FROM agreement_signatures WHERE agreement_id = $1 AND resident_id = 2) AS signed,
          (SELECT agreement_actions_today FROM residents WHERE id = 2) AS quota
      `, [agreementId])
      assert.deepEqual(state.rows, [{ opened: false, joined: false, signed: false, quota: 0 }])

      await assert.rejects(
        database!.query(`
          INSERT INTO agreement_accession_openings (agreement_id, opened_by_id)
          VALUES ($1, 2)
        `, [agreementId]),
        error => postgresCode(error) === '23503',
      )

      const unauthorizedOpen = await app.request(`/api/agreement/${agreementId}/open-accession`, {
        method: 'POST',
        headers: bearer(neighborSecret),
      })
      assert.equal(unauthorizedOpen.status, 403)

      const opened = await app.request(`/api/agreement/${agreementId}/open-accession`, {
        method: 'POST',
        headers: bearer(founderSecret),
      })
      assert.equal(opened.status, 201)
      assert.equal((await opened.json() as { agreement: { accession_open: boolean } }).agreement.accession_open, true)
    })

    await t.test('an accession opening and named-party provenance are append-only', async () => {
      await resetDatabase()
      const agreementId = await seedAgreement({ accessionOpen: true })

      const named = await database!.query(`
        SELECT named FROM agreement_parties WHERE agreement_id = $1 AND resident_id = 1
      `, [agreementId])
      assert.deepEqual(named.rows, [{ named: true }])

      await assert.rejects(
        database!.query(`
          UPDATE agreement_parties SET named = false
          WHERE agreement_id = $1 AND resident_id = 1
        `, [agreementId]),
        error => postgresCode(error) === '55000',
      )

      await assert.rejects(
        database!.query(`
          UPDATE agreement_accession_openings SET opened_at = opened_at + interval '1 second'
          WHERE agreement_id = $1
        `, [agreementId]),
        error => postgresCode(error) === '55000',
      )
      await assert.rejects(
        database!.query('DELETE FROM agreement_accession_openings WHERE agreement_id = $1', [agreementId]),
        error => postgresCode(error) === '55000',
      )

      const opening = await database!.query(`
        SELECT agreement_id, opened_by_id FROM agreement_accession_openings WHERE agreement_id = $1
      `, [agreementId])
      assert.deepEqual(opening.rows, [{ agreement_id: agreementId, opened_by_id: 1 }])
    })

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

    await t.test('a rejected accession leaves no partial party or signature', async () => {
      await resetDatabase()
      const agreementId = await seedAgreement({ accessionOpen: true })
      await database!.query('UPDATE residents SET agreement_actions_today = 5 WHERE id = 2')

      const response = await app.request(`/api/agreement/${agreementId}/sign`, {
        method: 'POST',
        headers: bearer(neighborSecret),
      })
      assert.equal(response.status, 429)

      const state = await database!.query(`
        SELECT
          EXISTS(SELECT 1 FROM agreement_parties WHERE agreement_id = $1 AND resident_id = 2) AS joined,
          EXISTS(SELECT 1 FROM agreement_signatures WHERE agreement_id = $1 AND resident_id = 2) AS signed,
          (SELECT agreement_actions_today FROM residents WHERE id = 2) AS quota
      `, [agreementId])
      assert.deepEqual(state.rows, [{ joined: false, signed: false, quota: 5 }])
    })
  } finally {
    database = null
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
