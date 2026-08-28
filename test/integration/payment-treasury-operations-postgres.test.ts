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
          AS kind_revision
    `, [frontierRequest.name, kindId])
    assert.deepEqual(finalState.rows, [{
      completed_attempts: 3,
      spend_entries: 3,
      return_entries: 0,
      balance_units: '0',
      frontier_places: 1,
      kind_revision: 2,
    }])
  } finally {
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
