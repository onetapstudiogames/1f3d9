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
import { NETWORK, USDC } from '../../src/chain.ts'
import { bindPaymentEvidence, canonicalPaymentRequest } from '../../src/payment-attempts.ts'
import { TREASURY } from '../../src/pay.ts'

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

async function issueCredits(
  db: CityCreditDatabase,
  count: number,
  prefix: string,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const result = await issueCityFeeCredit(db, {
      founderId: 1,
      residentId: 2,
      sourceKey: `${prefix}-${index}`,
      reason: `fund PostgreSQL completion proof ${index}`,
    })
    assert.equal(result.disposition, 'created')
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

test('shared treasury completion survives twelve immediate paid kind inventions in real PostgreSQL', {
  timeout: 120_000,
}, async () => {
  const postgres = await startPostgres()
  try {
    await resetFresh(postgres.client)
    const db = database(postgres.client)
    await issueCredits(db, 12, 'treasury-burst-kind-credit')

    for (let index = 0; index < 12; index += 1) {
      const request = {
        name: `treasury-burst-kind-${index.toString().padStart(2, '0')}`,
        description: `Burst completion proof ${index}.`,
        traits: [],
        recipe: [],
      }
      const spend = await beginCityCreditSpend(db, {
        actorId: 2,
        operation: 'kind_invention',
        targetKey: `kind-invention:${request.name}`,
        request,
        requestId: `treasury-burst-kind-request-${index.toString().padStart(2, '0')}`,
      })
      assert.equal(spend.state, 'ready')
      if (spend.state !== 'ready') assert.fail(`kind invention ${index} did not acquire its lease`)
      const completion = await completeTreasuryPaymentOperation(db, {
        attemptId: spend.attempt_id,
        leaseOwner: spend.lease_owner,
      })
      assert.equal(completion.state, 'completed')
      if (completion.state !== 'completed') assert.fail(`kind invention ${index} did not complete`)
      assert.equal(completion.operation, 'kind_invention')
      assert.equal(completion.method, 'credit')
      assert.equal(completion.status, 201)
    }

    const finalState = await postgres.client.query<{
      completed_attempts: number
      spend_entries: number
      return_entries: number
      kind_count: number
      balance_units: string
    }>(`
      SELECT
        (SELECT count(*)::int FROM payment_attempts WHERE actor_id = 2 AND status = 'completed')
          AS completed_attempts,
        (SELECT count(*)::int FROM city_credit_entries WHERE resident_id = 2 AND entry_kind = 'spend')
          AS spend_entries,
        (SELECT count(*)::int FROM city_credit_entries WHERE resident_id = 2 AND entry_kind = 'return')
          AS return_entries,
        (SELECT count(*)::int FROM kinds WHERE owner_id = 2 AND name LIKE 'treasury-burst-kind-%')
          AS kind_count,
        (SELECT balance_units::text FROM city_credit_accounts WHERE resident_id = 2)
          AS balance_units
    `)
    assert.deepEqual(finalState.rows, [{
      completed_attempts: 12,
      spend_entries: 12,
      return_entries: 0,
      kind_count: 12,
      balance_units: '0',
    }])
  } finally {
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})

// Things ending, T6: a kind fee carries ending_policy. The stored request is the only
// source the completion reads, so every path that completes it must store the policy
// the resident paid for, and a request stored before the change must keep completing.
const ENDING_POLICY = Object.freeze({ allowed: ['uses', 'label_added'], labels: ['spent'], max_uses: 12 })

async function storedKindFee(client: Pool, name: string): Promise<{
  invented_by: number | null
  revisions: number
  ending_policy: unknown
}> {
  return (await client.query(`
    SELECT kind.invented_by,
      (SELECT count(*)::int FROM kind_revisions WHERE kind_id = kind.id) AS revisions,
      revision.ending_policy
    FROM kinds kind
    JOIN kind_revisions revision
      ON revision.kind_id = kind.id AND revision.revision = kind.current_revision
    WHERE kind.name = $1
  `, [name])).rows[0]
}

async function seedOwnedKind(client: Pool, name: string, inventedBy: number | null): Promise<number> {
  const id = Number((await client.query(
    'INSERT INTO kinds (name, owner_id, invented_by) VALUES ($1, 2, $2) RETURNING id', [name, inventedBy],
  )).rows[0].id)
  await client.query(
    `INSERT INTO kind_revisions (kind_id, revision, description) VALUES ($1, 1, 'seeded for a revision proof')`,
    [id],
  )
  return id
}

test('kind fees store ending_policy on credit, legacy and invalid completions in real PostgreSQL', {
  timeout: 180_000,
}, async () => {
  const postgres = await startPostgres()
  try {
    await resetFresh(postgres.client)
    const db = database(postgres.client)
    // Seven fees: a rejected stored request keeps its credit until the caller returns it.
    await issueCredits(db, 7, 'treasury-ending-policy-credit')

    // Credit invention with a policy: stored, answered, and the actor is the inventor.
    const inventionRequest = {
      name: 'treasury-ending-kind', description: 'A kind whose owners may end things.',
      traits: [], recipe: [], ending_policy: ENDING_POLICY,
    }
    const invention = await beginCityCreditSpend(db, {
      actorId: 2, operation: 'kind_invention', targetKey: `kind-invention:${inventionRequest.name}`,
      request: inventionRequest, requestId: 'treasury-ending-invention-request',
    })
    if (invention.state !== 'ready') assert.fail('the invention spend did not acquire its lease')
    const invented = await completeTreasuryPaymentOperation(db, {
      attemptId: invention.attempt_id, leaseOwner: invention.lease_owner,
    })
    if (invented.state !== 'completed') assert.fail(`the invention did not complete: ${invented.state}`)
    const inventedKind = invented.response.kind as Record<string, unknown>
    assert.deepEqual(inventedKind.ending_policy, ENDING_POLICY)
    assert.deepEqual(inventedKind.invented_by, { id: 2, handle: 'resident-two' })
    assert.deepEqual(await storedKindFee(postgres.client, inventionRequest.name), {
      invented_by: 2, revisions: 1, ending_policy: ENDING_POLICY,
    })
    await assert.rejects(
      completeTreasuryPaymentOperation(db, { attemptId: invention.attempt_id, leaseOwner: invention.lease_owner }),
      /no longer owns this attempt lease/u,
      'a second completion writes nothing',
    )
    assert.equal((await storedKindFee(postgres.client, inventionRequest.name)).revisions, 1)

    // Credit revision with a policy, on a kind the actor invented.
    const revisedId = Number(inventedKind.id)
    const revision = await beginCityCreditSpend(db, {
      actorId: 2, operation: 'kind_revision', targetKey: `kind-revision:${revisedId}:2`,
      assetType: 'kind', assetId: revisedId,
      request: {
        kind_id: revisedId, description: 'Owners may now end things only by uses.',
        traits: [], recipe: [], ending_policy: { allowed: ['uses'] },
      },
      requestId: 'treasury-ending-revision-request',
    })
    if (revision.state !== 'ready') assert.fail('the revision spend did not acquire its lease')
    const revised = await completeTreasuryPaymentOperation(db, {
      attemptId: revision.attempt_id, leaseOwner: revision.lease_owner,
    })
    if (revised.state !== 'completed') assert.fail(`the revision did not complete: ${revised.state}`)
    const revisedKind = revised.response.kind as Record<string, unknown>
    assert.deepEqual(revisedKind.ending_policy, { allowed: ['uses'] })
    assert.deepEqual(revisedKind.invented_by, { id: 2, handle: 'resident-two' })
    assert.deepEqual(await storedKindFee(postgres.client, inventionRequest.name), {
      invented_by: 2, revisions: 2, ending_policy: { allowed: ['uses'] },
    })

    // A request stored before C1 has no ending_policy and completes with the default.
    const legacyId = await seedOwnedKind(postgres.client, 'treasury-legacy-revised-kind', null)
    const legacy = [
      ['kind_invention', 'kind-invention:treasury-legacy-kind', {
        name: 'treasury-legacy-kind', description: 'Stored before endings.', traits: [], recipe: [],
      }, undefined],
      ['kind_revision', `kind-revision:${legacyId}:2`, {
        kind_id: legacyId, description: 'Revised from a request stored before endings.', traits: [], recipe: [],
      }, legacyId],
    ] as const
    for (const [operation, targetKey, request, assetId] of legacy) {
      const spend = await beginCityCreditSpend(db, {
        actorId: 2, operation, targetKey, request, requestId: `treasury-legacy-${operation}-request`,
        ...(assetId === undefined ? {} : { assetType: 'kind' as const, assetId }),
      })
      if (spend.state !== 'ready') assert.fail(`the legacy ${operation} spend did not acquire its lease`)
      const completed = await completeTreasuryPaymentOperation(db, {
        attemptId: spend.attempt_id, leaseOwner: spend.lease_owner,
      })
      if (completed.state !== 'completed') assert.fail(`the legacy ${operation} did not complete`)
      assert.deepEqual((completed.response.kind as Record<string, unknown>).ending_policy, { allowed: [] }, operation)
    }
    assert.deepEqual(await storedKindFee(postgres.client, 'treasury-legacy-kind'), {
      invented_by: 2, revisions: 1, ending_policy: { allowed: [] },
    })
    assert.deepEqual(await storedKindFee(postgres.client, 'treasury-legacy-revised-kind'), {
      invented_by: null, revisions: 2, ending_policy: { allowed: [] },
    })

    // A bad stored policy is a changed target, never a raise inside the completion.
    const badId = await seedOwnedKind(postgres.client, 'treasury-bad-policy-kind', 2)
    for (const [index, policy] of [{ allowed: ['forever'] }, null].entries()) {
      const name = `treasury-bad-policy-new-kind-${index}`
      const spend = await beginCityCreditSpend(db, {
        actorId: 2, operation: 'kind_invention', targetKey: `kind-invention:${name}`,
        request: { name, description: `bad policy ${index}`, traits: [], recipe: [], ending_policy: policy },
        requestId: `treasury-bad-policy-invention-${index}`,
      })
      if (spend.state !== 'ready') assert.fail(`the bad invention spend ${index} did not acquire its lease`)
      const rejected = await completeTreasuryPaymentOperation(db, {
        attemptId: spend.attempt_id, leaseOwner: spend.lease_owner,
      })
      assert.equal(rejected.state, 'target_changed', `invention ${JSON.stringify(policy)}`)
      assert.equal((await postgres.client.query('SELECT count(*)::int AS n FROM kinds WHERE name = $1', [name])).rows[0].n, 0)
    }
    const badRevision = await beginCityCreditSpend(db, {
      actorId: 2, operation: 'kind_revision', targetKey: `kind-revision:${badId}:2`,
      assetType: 'kind', assetId: badId,
      request: { kind_id: badId, description: 'bad policy', traits: [], recipe: [], ending_policy: { allowed: ['uses'], max_uses: 0 } },
      requestId: 'treasury-bad-policy-revision',
    })
    if (badRevision.state !== 'ready') assert.fail('the bad revision spend did not acquire its lease')
    const rejectedRevision = await completeTreasuryPaymentOperation(db, {
      attemptId: badRevision.attempt_id, leaseOwner: badRevision.lease_owner,
    })
    assert.equal(rejectedRevision.state, 'target_changed')
    assert.equal((await storedKindFee(postgres.client, 'treasury-bad-policy-kind')).revisions, 1)
  } finally {
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})

test('a kind fee whose first completion failed mid-way is completed by recovery with its ending_policy', {
  timeout: 180_000,
}, async () => {
  const postgres = await startPostgres()
  try {
    await resetFresh(postgres.client)
    const db = database(postgres.client)
    await issueCredits(db, 1, 'treasury-recovered-policy-credit')
    const request = {
      name: 'treasury-recovered-kind', description: 'Completed by recovery.',
      traits: [], recipe: [], ending_policy: ENDING_POLICY,
    }
    const spend = await beginCityCreditSpend(db, {
      actorId: 2, operation: 'kind_invention', targetKey: `kind-invention:${request.name}`,
      request, requestId: 'treasury-recovered-policy-request',
    })
    if (spend.state !== 'ready') assert.fail('the spend did not acquire its lease')

    // The first completion fails inside its one statement, so nothing of it stays.
    await postgres.client.query(`
      CREATE FUNCTION suite_fail_revision() RETURNS trigger LANGUAGE plpgsql AS
        $fail$ BEGIN RAISE EXCEPTION 'suite: the first completion fails mid-way'; END $fail$;
      CREATE TRIGGER suite_fail_revision BEFORE INSERT ON kind_revisions
        FOR EACH ROW EXECUTE FUNCTION suite_fail_revision();
    `)
    await assert.rejects(
      completeTreasuryPaymentOperation(db, { attemptId: spend.attempt_id, leaseOwner: spend.lease_owner }),
      /fails mid-way/u,
    )
    await postgres.client.query('DROP TRIGGER suite_fail_revision ON kind_revisions; DROP FUNCTION suite_fail_revision()')
    assert.equal((await postgres.client.query('SELECT count(*)::int AS n FROM kinds WHERE name = $1', [request.name])).rows[0].n, 0)

    // The request's process died: its lease runs out, and recovery completes it.
    await postgres.client.query(`
      UPDATE payment_attempts SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE public_id = $1
    `, [spend.attempt_id])
    const { createPaymentRecoveryRuntime } = await import('../../src/payment-recovery-runtime.ts')
    const runtime = createPaymentRecoveryRuntime(db as Parameters<typeof createPaymentRecoveryRuntime>[0])
    const batch = await runtime.runBatch(10)
    assert.equal(batch.completed, 1, JSON.stringify(batch))
    assert.deepEqual(await storedKindFee(postgres.client, request.name), {
      invented_by: 2, revisions: 1, ending_policy: ENDING_POLICY,
    })
    const again = await runtime.runBatch(10)
    assert.equal(again.completed, 0, 'a second recovery writes nothing')
    assert.equal((await storedKindFee(postgres.client, request.name)).revisions, 1)
  } finally {
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})

test('x402 kind fees with ending_policy complete when chain finality is later than the operation window', {
  timeout: 180_000,
}, async () => {
  const postgres = await startPostgres()
  try {
    await resetFresh(postgres.client)
    const db = database(postgres.client)
    const revisedId = await seedOwnedKind(postgres.client, 'late-ending-revised-kind', 2)
    const boundary = (await postgres.client.query<{
      start_time: Date
      end_time: Date
      block_time: Date
      valid_after: string
      valid_before: string
    }>(`
      WITH observed AS MATERIALIZED (SELECT clock_timestamp() AS at)
      SELECT at AS start_time,
        at + interval '2 seconds' AS end_time,
        at + interval '1 second' AS block_time,
        extract(epoch FROM date_trunc('second', at))::bigint - 1 AS valid_after,
        extract(epoch FROM date_trunc('second', at))::bigint + 2 AS valid_before
      FROM observed
    `)).rows[0]!
    const fees = [
      {
        attemptId: 'ending-late-finality-invention-0001',
        leaseOwner: 'ending-late-finality-lease-0001',
        operation: 'kind_invention',
        targetKey: 'kind-invention:late-ending-kind',
        assetId: null,
        request: { name: 'late-ending-kind', description: 'Finalized late.', traits: [], recipe: [], ending_policy: ENDING_POLICY },
        txHash: `0x${'a'.repeat(64)}`,
        nonce: `0x${'b'.repeat(64)}`,
        kindName: 'late-ending-kind',
      },
      {
        attemptId: 'ending-late-finality-revision-0001',
        leaseOwner: 'ending-late-finality-lease-0002',
        operation: 'kind_revision',
        targetKey: `kind-revision:${revisedId}:2`,
        assetId: revisedId,
        request: { kind_id: revisedId, description: 'Revised late.', traits: [], recipe: [], ending_policy: { allowed: ['at'] } },
        txHash: `0x${'c'.repeat(64)}`,
        nonce: `0x${'d'.repeat(64)}`,
        kindName: 'late-ending-revised-kind',
      },
    ] as const
    const header = (txHash: string) => Buffer.from(JSON.stringify({
      success: true, transaction: txHash, payer: `0x${'5'.repeat(40)}`, network: NETWORK,
    })).toString('base64')
    for (const fee of fees) {
      const canonical = canonicalPaymentRequest(fee.request)
      await postgres.client.query(`
        INSERT INTO payment_attempts (
          public_id, actor_id, operation, target_key, asset_type, asset_id, request_hash, request_json,
          method, network, token, payer_wallet, payee_wallet, amount_units,
          x402_nonce, x402_payload_digest, x402_valid_after, x402_valid_before,
          start_block, start_time, end_time, status, lease_owner, lease_expires_at
        ) VALUES (
          $1, 2, $2, $3, $4, $5, $6, $7::jsonb,
          'x402', $8, $9, $10, $11, 1000000,
          $12, repeat('a', 64), $13::bigint, $14::bigint,
          50000000, $15::timestamptz, $16::timestamptz,
          'settling', $17, clock_timestamp() + interval '30 seconds'
        )
      `, [
        fee.attemptId, fee.operation, fee.targetKey, fee.assetId === null ? null : 'kind', fee.assetId,
        canonical.hash, canonical.json, NETWORK, USDC.toLowerCase(), `0x${'5'.repeat(40)}`, TREASURY,
        fee.nonce, boundary.valid_after, boundary.valid_before,
        boundary.start_time.toISOString(), boundary.end_time.toISOString(), fee.leaseOwner,
      ])
      const pending = await bindPaymentEvidence(db, {
        publicId: fee.attemptId, leaseOwner: fee.leaseOwner, txHash: fee.txHash,
        finality: null, paymentResponseHeader: header(fee.txHash),
      })
      assert.equal(pending.status, 'payment_pending')
    }

    const startedAt = Date.now()
    let finalizedAt = ''
    for (;;) {
      const observed = (await postgres.client.query<{ observed_at: Date; passed: boolean }>(`
        SELECT clock_timestamp() AS observed_at,
          clock_timestamp() > $1::timestamptz + interval '1 millisecond'
            AND clock_timestamp() > to_timestamp($2::bigint) + interval '1 millisecond' AS passed
      `, [boundary.end_time.toISOString(), boundary.valid_before])).rows[0]!
      if (observed.passed) {
        finalizedAt = observed.observed_at.toISOString()
        break
      }
      await delay(25)
    }
    assert.ok(Date.now() - startedAt >= 1_500, 'the proof must cross a real PostgreSQL operation window')

    for (const [index, fee] of fees.entries()) {
      const finalized = await bindPaymentEvidence(db, {
        publicId: fee.attemptId, leaseOwner: fee.leaseOwner, txHash: fee.txHash,
        finality: {
          blockNumber: 50_000_001n + BigInt(index),
          blockHash: `0x${String(8 - index).repeat(64)}`,
          blockTime: boundary.block_time.toISOString(),
          finalizedAt,
        },
        paymentResponseHeader: header(fee.txHash),
      })
      assert.equal(finalized.status, 'payment_pending')
      const completed = await completeTreasuryPaymentOperation(db, {
        attemptId: fee.attemptId, leaseOwner: fee.leaseOwner,
      })
      if (completed.state !== 'completed') assert.fail(`${fee.operation} did not complete: ${completed.state}`)
      assert.equal(completed.method, 'x402')
      assert.deepEqual((completed.response.kind as Record<string, unknown>).ending_policy, fee.request.ending_policy)
      assert.deepEqual(await storedKindFee(postgres.client, fee.kindName), {
        invented_by: 2,
        revisions: fee.operation === 'kind_invention' ? 1 : 2,
        ending_policy: fee.request.ending_policy,
      })
      const uses = (await postgres.client.query(
        'SELECT count(*)::int AS n FROM payment_uses WHERE payment_attempt_id = $1', [fee.attemptId],
      )).rows[0].n
      assert.equal(uses, 1)
      await assert.rejects(
        completeTreasuryPaymentOperation(db, { attemptId: fee.attemptId, leaseOwner: fee.leaseOwner }),
        /no longer owns this attempt lease/u,
      )
    }
  } finally {
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
