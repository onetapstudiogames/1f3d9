import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import {
  beginCityCreditSpend,
  issueCityFeeCredit,
  type CityCreditDatabase,
} from '../../src/city-credit.ts'
import { completeTreasuryPaymentOperation } from '../../src/payment-treasury-operations.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'payment_treasury_operations_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ client: Pool; containerName: string }> {
  const containerName = `1f3d9-payment-treasury-${process.pid}-${randomBytes(4).toString('hex')}`
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
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(Number.isInteger(port) && port > 0, `could not read PostgreSQL port from ${portOutput}`)
    const client = new Pool({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password,
      database: POSTGRES_DATABASE,
      ssl: false,
      max: 4,
    })
    const deadline = Date.now() + 30_000
    let lastError: unknown = null
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

function database(client: Pool): CityCreditDatabase {
  return {
    query: async (text, params = []) => (await client.query(text, [...params])).rows,
  }
}

async function resetFresh(client: Pool): Promise<void> {
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await client.query(schemaDdl)
  await client.query(`
    INSERT INTO residents (id, handle, model, secret_hash) VALUES
      (1, 'founder', 'treasury-operation-test', repeat('1', 64)),
      (2, 'resident-two', 'treasury-operation-test', repeat('2', 64))
  `)
}

async function issueThreeCredits(db: CityCreditDatabase): Promise<void> {
  for (const suffix of ['frontier', 'invention', 'revision']) {
    const result = await issueCityFeeCredit(db, {
      founderId: 1,
      residentId: 2,
      sourceKey: `treasury-operation-${suffix}-credit`,
      reason: `fund the ${suffix} PostgreSQL completion proof`,
    })
    assert.equal(result.disposition, 'created')
  }
}

function proofDrawing(color: string, paintedIndex: number) {
  return {
    palette: [color],
    indices: Array.from({ length: 64 }, (_, index) => index === paintedIndex ? 0 : null),
  }
}

test('shared treasury completion executes every paid credit operation in real PostgreSQL', {
  timeout: 120_000,
}, async () => {
  const postgres = await startPostgres()
  try {
    await resetFresh(postgres.client)
    const db = database(postgres.client)
    await issueThreeCredits(db)

    const frontierRequest = {
      parent_id: null,
      name: 'treasury-proof-frontier',
      description: 'A disposable frontier completion proof.',
      open_to_building: false,
      open_to_things: false,
      open_to_notes: false,
    }
    const frontier = await beginCityCreditSpend(db, {
      actorId: 2,
      operation: 'frontier',
      targetKey: `frontier:root:${frontierRequest.name}`,
      request: frontierRequest,
      requestId: 'treasury-proof-frontier-request',
    })
    assert.equal(frontier.state, 'ready')
    if (frontier.state !== 'ready') assert.fail('frontier spend did not acquire its lease')
    const completedFrontier = await completeTreasuryPaymentOperation(db, {
      attemptId: frontier.attempt_id,
      leaseOwner: frontier.lease_owner,
    })
    assert.equal(completedFrontier.state, 'completed')
    if (completedFrontier.state !== 'completed') assert.fail('frontier did not complete')
    assert.equal(completedFrontier.operation, 'frontier')
    assert.equal(completedFrontier.method, 'credit')
    assert.equal(completedFrontier.status, 201)

    const inventionRequest = {
      name: 'treasury-proof-kind',
      description: 'A disposable kind completion proof.',
      traits: [],
      recipe: [],
      drawing: proofDrawing('#123456', 0),
      drawing_state: 'complete',
      drawing_description: 'The first finished base drawing.',
      drawing_variants: [{
        name: 'ember',
        drawing: proofDrawing('#abcdef', 1),
        drawing_state: 'in_progress',
        drawing_description: 'The ember variant has one unfinished bright cell.',
      }, {
        name: 'ash',
        drawing: proofDrawing('#999999', 2),
        drawing_state: 'complete',
        drawing_description: 'The ash variant has one finished grey cell.',
      }],
    }
    const invention = await beginCityCreditSpend(db, {
      actorId: 2,
      operation: 'kind_invention',
      targetKey: `kind-invention:${inventionRequest.name}`,
      request: inventionRequest,
      requestId: 'treasury-proof-invention-request',
    })
    assert.equal(invention.state, 'ready')
    if (invention.state !== 'ready') assert.fail('kind invention spend did not acquire its lease')
    const completedInvention = await completeTreasuryPaymentOperation(db, {
      attemptId: invention.attempt_id,
      leaseOwner: invention.lease_owner,
    })
    assert.equal(completedInvention.state, 'completed')
    if (completedInvention.state !== 'completed') assert.fail('kind invention did not complete')
    assert.equal(completedInvention.operation, 'kind_invention')
    assert.equal(completedInvention.method, 'credit')
    assert.equal(completedInvention.status, 201)

    const kind = await postgres.client.query<{ id: number }>(`
      SELECT id FROM kinds WHERE name = $1
    `, [inventionRequest.name])
    const kindId = kind.rows[0]?.id
    if (typeof kindId !== 'number' || !Number.isSafeInteger(kindId) || kindId < 1) {
      assert.fail('kind invention did not return one positive kind id')
    }
    const revisionRequest = {
      kind_id: kindId,
      description: 'The revised disposable kind completion proof.',
      traits: [],
      recipe: [],
      drawing: proofDrawing('#654321', 63),
      drawing_state: 'complete',
      drawing_description: 'The revised finished base drawing.',
      drawing_variants: [inventionRequest.drawing_variants[0]!],
    }
    const revision = await beginCityCreditSpend(db, {
      actorId: 2,
      operation: 'kind_revision',
      targetKey: `kind-revision:${kindId}:2`,
      request: revisionRequest,
      requestId: 'treasury-proof-revision-request',
      assetType: 'kind',
      assetId: kindId,
    })
    assert.equal(revision.state, 'ready')
    if (revision.state !== 'ready') assert.fail('kind revision spend did not acquire its lease')
    const completedRevision = await completeTreasuryPaymentOperation(db, {
      attemptId: revision.attempt_id,
      leaseOwner: revision.lease_owner,
    })
    assert.equal(completedRevision.state, 'completed')
    if (completedRevision.state !== 'completed') assert.fail('kind revision did not complete')
    assert.equal(completedRevision.operation, 'kind_revision')
    assert.equal(completedRevision.method, 'credit')
    assert.equal(completedRevision.status, 200)

    const finalState = await postgres.client.query<{
      completed_attempts: number
      spend_entries: number
      return_entries: number
      balance_units: string
      frontier_places: number
      kind_revision: number
      invention_drawing: unknown
      invention_drawing_state: string
      invention_drawing_description: string | null
      invention_drawing_variants: unknown
      revision_drawing: unknown
      revision_drawing_state: string
      revision_drawing_description: string | null
      revision_drawing_variants: unknown
    }>(`
      SELECT
        (SELECT count(*)::int FROM payment_attempts WHERE actor_id = 2 AND status = 'completed')
          AS completed_attempts,
        (SELECT count(*)::int FROM city_credit_entries WHERE resident_id = 2 AND entry_kind = 'spend')
          AS spend_entries,
        (SELECT count(*)::int FROM city_credit_entries WHERE resident_id = 2 AND entry_kind = 'return')
          AS return_entries,
        (SELECT balance_units::text FROM city_credit_accounts WHERE resident_id = 2)
          AS balance_units,
        (SELECT count(*)::int FROM places WHERE name = $1 AND owner_id = 2)
          AS frontier_places,
        (SELECT current_revision FROM kinds WHERE id = $2)
          AS kind_revision,
        (SELECT drawing FROM kind_revisions WHERE kind_id = $2 AND revision = 1)
          AS invention_drawing,
        (SELECT drawing_state FROM kind_revisions WHERE kind_id = $2 AND revision = 1)
          AS invention_drawing_state,
        (SELECT drawing_description FROM kind_revisions WHERE kind_id = $2 AND revision = 1)
          AS invention_drawing_description,
        (SELECT drawing_variants FROM kind_revisions WHERE kind_id = $2 AND revision = 1)
          AS invention_drawing_variants,
        (SELECT drawing FROM kind_revisions WHERE kind_id = $2 AND revision = 2)
          AS revision_drawing,
        (SELECT drawing_state FROM kind_revisions WHERE kind_id = $2 AND revision = 2)
          AS revision_drawing_state,
        (SELECT drawing_description FROM kind_revisions WHERE kind_id = $2 AND revision = 2)
          AS revision_drawing_description,
        (SELECT drawing_variants FROM kind_revisions WHERE kind_id = $2 AND revision = 2)
          AS revision_drawing_variants
    `, [frontierRequest.name, kindId])
    assert.deepEqual(finalState.rows, [{
      completed_attempts: 3,
      spend_entries: 3,
      return_entries: 0,
      balance_units: '0',
      frontier_places: 1,
      kind_revision: 2,
      invention_drawing: inventionRequest.drawing,
      invention_drawing_state: inventionRequest.drawing_state,
      invention_drawing_description: inventionRequest.drawing_description,
      invention_drawing_variants: [{
        name: 'ember',
        drawing: inventionRequest.drawing_variants[0]?.drawing,
        state: 'in_progress',
        description: inventionRequest.drawing_variants[0]?.drawing_description,
      }, {
        name: 'ash',
        drawing: inventionRequest.drawing_variants[1]?.drawing,
        state: 'complete',
        description: inventionRequest.drawing_variants[1]?.drawing_description,
      }],
      revision_drawing: revisionRequest.drawing,
      revision_drawing_state: revisionRequest.drawing_state,
      revision_drawing_description: revisionRequest.drawing_description,
      revision_drawing_variants: [{
        name: 'ember',
        drawing: inventionRequest.drawing_variants[0]?.drawing,
        state: 'in_progress',
        description: inventionRequest.drawing_variants[0]?.drawing_description,
      }],
    }])

    const drawingHistory = await postgres.client.query<{
      slot_variant_name: string | null
      prior_state: string
      prior_source: string
      prior_kind_revision: number | null
      current_state: string
      current_source: string
      current_kind_revision: number | null
      author_id: number
      author_relation: string
    }>(`
      SELECT slot_variant_name,
        prior_state, prior_source, prior_kind_revision,
        current_state, current_source, current_kind_revision,
        author_id, author_relation
      FROM drawing_revisions
      WHERE target_type = 'kind' AND target_id = $1
      ORDER BY id
    `, [kindId])
    assert.deepEqual(drawingHistory.rows, [
      {
        slot_variant_name: null,
        prior_state: 'undrawn', prior_source: 'none', prior_kind_revision: null,
        current_state: 'complete', current_source: 'kind_base', current_kind_revision: 1,
        author_id: 2, author_relation: 'kind_owner',
      },
      {
        slot_variant_name: 'ember',
        prior_state: 'undrawn', prior_source: 'none', prior_kind_revision: null,
        current_state: 'in_progress', current_source: 'kind_variant', current_kind_revision: 1,
        author_id: 2, author_relation: 'kind_owner',
      },
      {
        slot_variant_name: 'ash',
        prior_state: 'undrawn', prior_source: 'none', prior_kind_revision: null,
        current_state: 'complete', current_source: 'kind_variant', current_kind_revision: 1,
        author_id: 2, author_relation: 'kind_owner',
      },
      {
        slot_variant_name: null,
        prior_state: 'complete', prior_source: 'kind_base', prior_kind_revision: 1,
        current_state: 'complete', current_source: 'kind_base', current_kind_revision: 2,
        author_id: 2, author_relation: 'kind_owner',
      },
      {
        slot_variant_name: 'ember',
        prior_state: 'in_progress', prior_source: 'kind_variant', prior_kind_revision: 1,
        current_state: 'in_progress', current_source: 'kind_variant', current_kind_revision: 2,
        author_id: 2, author_relation: 'kind_owner',
      },
      {
        slot_variant_name: 'ash',
        prior_state: 'complete', prior_source: 'kind_variant', prior_kind_revision: 1,
        current_state: 'undrawn', current_source: 'none', current_kind_revision: null,
        author_id: 2, author_relation: 'kind_owner',
      },
    ])

    const beforeRejectedEffects = await postgres.client.query<{ drawing_revisions: number }>(`
      SELECT count(*)::int AS drawing_revisions FROM drawing_revisions
    `)
    const unchangedDrawingRevisionCount = beforeRejectedEffects.rows[0]?.drawing_revisions
    assert.equal(typeof unchangedDrawingRevisionCount, 'number')

    const malformedCredit = await issueCityFeeCredit(db, {
      founderId: 1,
      residentId: 2,
      sourceKey: 'treasury-operation-malformed-drawing-credit',
      reason: 'prove malformed drawing completion has no partial world effect',
    })
    assert.equal(malformedCredit.disposition, 'created')
    const malformedRequest = {
      name: 'treasury-proof-malformed-kind',
      description: 'This drawing intentionally omits its paired authored fields.',
      traits: [],
      recipe: [],
      drawing: proofDrawing('#abcdef', 3),
    }
    const malformed = await beginCityCreditSpend(db, {
      actorId: 2,
      operation: 'kind_invention',
      targetKey: `kind-invention:${malformedRequest.name}`,
      request: malformedRequest,
      requestId: 'treasury-proof-malformed-request',
    })
    assert.equal(malformed.state, 'ready')
    if (malformed.state !== 'ready') assert.fail('malformed drawing spend did not acquire its lease')
    const rejectedMalformed = await completeTreasuryPaymentOperation(db, {
      attemptId: malformed.attempt_id,
      leaseOwner: malformed.lease_owner,
    })
    assert.equal(rejectedMalformed.state, 'target_changed')

    const lateCredit = await issueCityFeeCredit(db, {
      founderId: 1,
      residentId: 2,
      sourceKey: 'treasury-operation-late-drawing-credit',
      reason: 'prove late drawing completion has no partial world effect',
    })
    assert.equal(lateCredit.disposition, 'created')
    const lateRequest = {
      name: 'treasury-proof-late-kind',
      description: 'A valid authored refusal whose completion is deliberately late.',
      traits: [],
      recipe: [],
      drawing: 'REFUSE',
      drawing_description: 'I decline to draw this kind.',
    }
    const late = await beginCityCreditSpend(db, {
      actorId: 2,
      operation: 'kind_invention',
      targetKey: `kind-invention:${lateRequest.name}`,
      request: lateRequest,
      requestId: 'treasury-proof-late-request',
    })
    assert.equal(late.state, 'ready')
    if (late.state !== 'ready') assert.fail('late drawing spend did not acquire its lease')
    await postgres.client.query(
      'ALTER TABLE payment_attempts DISABLE TRIGGER payment_attempts_initialize_recovery_window',
    )
    await postgres.client.query(
      'ALTER TABLE payment_attempts DISABLE TRIGGER payment_attempts_keep_history',
    )
    await postgres.client.query(`
      WITH expired_window AS (
        SELECT clock_timestamp() - interval '3 hours' AS started_at
      )
      UPDATE payment_attempts
      SET recovery_started_at = expired_window.started_at,
          recovery_deadline_at = expired_window.started_at + interval '2 hours'
      FROM expired_window
      WHERE public_id = $1
    `, [late.attempt_id])
    await postgres.client.query(
      'ALTER TABLE payment_attempts ENABLE TRIGGER payment_attempts_initialize_recovery_window',
    )
    await postgres.client.query(
      'ALTER TABLE payment_attempts ENABLE TRIGGER payment_attempts_keep_history',
    )
    const rejectedLate = await completeTreasuryPaymentOperation(db, {
      attemptId: late.attempt_id,
      leaseOwner: late.lease_owner,
    })
    assert.equal(rejectedLate.state, 'deadline_passed')

    const rejectedEffects = await postgres.client.query<{
      rejected_kinds: number
      drawing_revisions: number
    }>(`
      SELECT
        (SELECT count(*)::int FROM kinds WHERE name IN ($1, $2)) AS rejected_kinds,
        (SELECT count(*)::int FROM drawing_revisions) AS drawing_revisions
    `, [malformedRequest.name, lateRequest.name])
    assert.deepEqual(rejectedEffects.rows, [{
      rejected_kinds: 0,
      drawing_revisions: unchangedDrawingRevisionCount,
    }])
  } finally {
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
