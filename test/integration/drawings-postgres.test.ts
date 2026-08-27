import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Client } from 'pg'
import { Hono, type Context } from 'hono'
import { NETWORK, USDC } from '../../src/chain.ts'
import { beginCityCreditSpend, issueCityFeeCredit } from '../../src/city-credit.ts'
import type { Resident } from '../../src/core.ts'
import { mountDrawingRoutes } from '../../src/drawings.ts'
import { bindPaymentEvidence, canonicalPaymentRequest } from '../../src/payment-attempts.ts'
import { completeTreasuryPaymentOperation } from '../../src/payment-treasury-operations.ts'
import { TREASURY } from '../../src/pay.ts'

const POSTGRES_IMAGE =
  'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'drawings_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const migrationDdl = await readFile(
  new URL('../../db/migrations/20260827_drawings.sql', import.meta.url),
  'utf8',
)

const blankIndices = (): null[] => Array.from({ length: 64 }, () => null)
const drawing = (colour: string) => ({
  palette: [colour],
  indices: [0, ...blankIndices().slice(1)],
})

function docker(args: readonly string[], allowFailure = false): string {
  const result = spawnSync('docker', [...args], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true,
  })
  if (!allowFailure && result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`Docker drawings fixture failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function connect(config: ConstructorParameters<typeof Client>[0]): Promise<Client> {
  const deadline = Date.now() + 30_000
  let lastError: unknown
  while (Date.now() < deadline) {
    const client = new Client(config)
    try {
      await client.connect()
      return client
    } catch (error) {
      lastError = error
      await client.end().catch(() => undefined)
      await delay(200)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
}

async function rejectsCheck(client: Client, candidate: unknown): Promise<void> {
  await assert.rejects(
    client.query('UPDATE residents SET drawing = $1::jsonb WHERE id = 1', [JSON.stringify(candidate)]),
    (error: unknown) => (error as { code?: string }).code === '23514',
  )
}

test('real PostgreSQL enforces, preserves, moderates, exports, and settles drawings', async t => {
  const runId = `${process.pid}-${randomBytes(5).toString('hex')}`
  const container = `1f3d9-drawings-${runId}`
  const password = randomBytes(24).toString('hex')
  let client: Client | undefined
  t.after(async () => {
    await client?.end().catch(() => undefined)
    docker(['rm', '--force', container], true)
  })

  docker([
    'run', '--detach', '--name', container,
    '--label', `com.1f3d9.test=${runId}`,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', `POSTGRES_DB=${POSTGRES_DATABASE}`,
    POSTGRES_IMAGE,
  ])
  const portText = docker(['port', container, '5432/tcp'])
  const port = Number(portText.match(/:(\d+)\s*$/u)?.[1])
  assert.ok(Number.isSafeInteger(port) && port > 0)
  client = await connect({
    host: '127.0.0.1', port, user: 'postgres', password,
    database: POSTGRES_DATABASE, ssl: false,
  })

  await client.query(schemaDdl)
  await client.query(migrationDdl)
  await client.query(migrationDdl)

  const columns = (await client.query<{
    table_name: string
    is_nullable: string
    column_default: string | null
  }>(`
    SELECT table_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'drawing'
    ORDER BY table_name
  `)).rows
  assert.deepEqual(columns, [
    { table_name: 'kind_revisions', is_nullable: 'YES', column_default: null },
    { table_name: 'places', is_nullable: 'YES', column_default: null },
    { table_name: 'residents', is_nullable: 'YES', column_default: null },
    { table_name: 'things', is_nullable: 'YES', column_default: null },
  ])

  const residentDrawing = drawing('#ad3f25')
  const placeDrawing = drawing('#174d3c')
  const kindDrawing = drawing('#f0c95f')
  const thingDrawing = drawing('#9d9276')
  await client.query(`
    INSERT INTO residents (id, handle, model, secret_hash, drawing)
    VALUES
      (1, 'drawing-owner', 'integration', $1, $2::jsonb),
      (2, 'paid-drawing-owner', 'integration', $3, NULL)
  `, ['1'.repeat(64), JSON.stringify(residentDrawing), '2'.repeat(64)])
  await client.query('UPDATE resident_id_allocator SET last_id = 2 WHERE singleton')
  const placeId = Number((await client.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, description, owner_id, drawing)
    SELECT id, 'continent', 'Drawing Quarter', 'exact public place', 1, $1::jsonb
    FROM places WHERE place_kind = 'world'
    RETURNING id
  `, [JSON.stringify(placeDrawing)])).rows[0]!.id)
  const kindId = Number((await client.query<{ id: number }>(`
    INSERT INTO kinds (name, owner_id) VALUES ('drawn-kind', 1) RETURNING id
  `)).rows[0]!.id)
  await client.query(`
    INSERT INTO kind_revisions (kind_id, revision, description, drawing)
    VALUES ($1, 1, 'drawn definition', $2::jsonb)
  `, [kindId, JSON.stringify(kindDrawing)])
  const ownThingId = Number((await client.query<{ id: number }>(`
    INSERT INTO things (
      place_id, name, body, owner_id, maker_id, kind_id,
      birth_revision, current_revision, drawing
    ) VALUES ($1, 'override thing', '', 1, 1, $2, 1, 1, $3::jsonb)
    RETURNING id
  `, [placeId, kindId, JSON.stringify(thingDrawing)])).rows[0]!.id)
  const inheritedThingId = Number((await client.query<{ id: number }>(`
    INSERT INTO things (
      place_id, name, body, owner_id, maker_id, kind_id,
      birth_revision, current_revision
    ) VALUES ($1, 'inherited thing', '', 1, 1, $2, 1, 1)
    RETURNING id
  `, [placeId, kindId])).rows[0]!.id)

  for (const candidate of [
    { palette: ['#ad3f25'], indices: blankIndices(), extra: true },
    { palette: ['#AD3F25'], indices: blankIndices() },
    { palette: Array.from({ length: 65 }, () => '#ad3f25'), indices: blankIndices() },
    { palette: ['#ad3f25'], indices: blankIndices().slice(1) },
    { palette: ['#ad3f25'], indices: [...blankIndices().slice(1), 1] },
    { palette: ['#ad3f25'], indices: [...blankIndices().slice(1), 0.5] },
  ]) await rejectsCheck(client, candidate)

  const replacement = drawing('#0b1714')
  await client.query('UPDATE residents SET drawing = $1::jsonb WHERE id = 1', [JSON.stringify(replacement)])
  assert.deepEqual(
    (await client.query<{ drawing: unknown }>('SELECT drawing FROM residents WHERE id = 1')).rows[0]?.drawing,
    replacement,
  )
  assert.equal((await client.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('drawing_history', 'drawing_versions')
  `)).rows[0]?.count, '0')

  await assert.rejects(
    client.query(
      "UPDATE places SET drawing = $1::jsonb WHERE place_kind = 'world'",
      [JSON.stringify(placeDrawing)],
    ),
    (error: unknown) => (error as { code?: string }).code === '55000',
  )
  assert.equal(
    (await client.query<{ drawing: unknown }>("SELECT drawing FROM places WHERE place_kind = 'world'")).rows[0]?.drawing,
    null,
  )

  await client.query(`
    INSERT INTO events (kind, actor, detail)
    VALUES ('resident_edited', 'drawing-owner', $1::jsonb)
  `, [JSON.stringify({ resident_id: 1, source_thing_id: ownThingId, private: 'omit' })])

  const snapshot = async (className: string, recordId: number) => (
    await client!.query<{ payload: Record<string, unknown> }>(`
      SELECT payload FROM city_snapshot.public_records
      WHERE class_name = $1 AND record_id = $2::text
    `, [className, recordId])
  ).rows[0]!.payload

  assert.deepEqual((await snapshot('residents', 1)).drawing, replacement)
  assert.deepEqual((await snapshot('places', placeId)).drawing, placeDrawing)
  assert.deepEqual((await snapshot('kinds', kindId)).drawing, kindDrawing)
  assert.deepEqual((await snapshot('things', ownThingId)).drawing, thingDrawing)
  assert.deepEqual((await snapshot('things', ownThingId)).drawing_source, { type: 'thing' })
  assert.deepEqual((await snapshot('things', inheritedThingId)).drawing, kindDrawing)
  assert.deepEqual((await snapshot('things', inheritedThingId)).drawing_source, {
    type: 'kind_revision', kind_id: kindId, revision: 1,
  })
  const eventId = Number((await client.query<{ id: number }>(`
    SELECT id FROM events WHERE kind = 'resident_edited' ORDER BY id DESC LIMIT 1
  `)).rows[0]!.id)
  assert.deepEqual((await snapshot('events', eventId)).detail, {
    resident_id: 1, source_thing_id: ownThingId,
  })

  await client.query(`
    INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
    VALUES
      ('resident', 1, 'remove', 1, 'hide resident drawing'),
      ('kind', $1, 'remove', 1, 'hide kind drawing')
  `, [kindId])
  const hiddenResident = await snapshot('residents', 1)
  assert.equal(hiddenResident.handle, 'drawing-owner')
  assert.equal(hiddenResident.drawing, null)
  assert.equal((await snapshot('kinds', kindId)).status, 'maintainer_hidden')
  assert.equal((await snapshot('things', inheritedThingId)).drawing, null)
  assert.equal((await snapshot('things', inheritedThingId)).drawing_source, null)
  assert.deepEqual((await snapshot('things', ownThingId)).drawing, thingDrawing)

  const database = {
    query: async (text: string, params: readonly unknown[] = []) =>
      (await client!.query(text, [...params])).rows,
  }
  const drawingOwner: Resident = Object.freeze({
    id: 2,
    handle: 'paid-drawing-owner',
    model: 'integration',
    joined_at: '2026-08-27T00:00:00.000Z',
    quota_day: '2026-08-27',
    things_today: 0,
    notes_today: 0,
    agreement_actions_today: 0,
  })
  const drawingApp = new Hono()
  mountDrawingRoutes(drawingApp, {
    database,
    authenticate: async (_context: Context) => drawingOwner,
  })
  const admittedColours = ['#101010', '#202020', '#303030', '#404040', '#505050', '#606060']
  for (const colour of admittedColours) {
    const response = await drawingApp.request('/api/me/drawing', {
      method: 'PATCH',
      body: JSON.stringify({ drawing: drawing(colour) }),
    })
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal((await response.json() as { changed: boolean }).changed, true)
  }
  const limited = await drawingApp.request('/api/me/drawing', {
    method: 'PATCH',
    body: JSON.stringify({ drawing: drawing('#707070') }),
  })
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '60')
  const exactRetry = await drawingApp.request('/api/me/drawing', {
    method: 'PATCH',
    body: JSON.stringify({ drawing: drawing(admittedColours.at(-1)!) }),
  })
  assert.equal(exactRetry.status, 200)
  assert.equal((await exactRetry.json() as { changed: boolean }).changed, false)
  assert.deepEqual((await client.query<{ used: number }>(`
    SELECT used FROM resident_drawing_rate_limits WHERE resident_id = 2
  `)).rows.map(row => Number(row.used)), [6])
  assert.equal(Number((await client.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM events
    WHERE kind = 'resident_edited' AND actor = 'paid-drawing-owner'
  `)).rows[0]?.count), 6)

  const firstPaidDrawing = drawing('#8a622d')
  await issueCityFeeCredit(database, {
    founderId: 1,
    residentId: 2,
    sourceKey: 'drawing-kind-invention-credit-0001',
    reason: 'real PostgreSQL drawing invention proof',
  })
  const invention = await beginCityCreditSpend(database, {
    actorId: 2,
    operation: 'kind_invention',
    targetKey: 'kind-invention:paid-drawn-kind',
    requestId: 'drawing-kind-invention-request-0001',
    request: {
      name: 'paid-drawn-kind',
      description: 'a paid kind with a pinned drawing revision',
      traits: [],
      recipe: [],
      drawing: firstPaidDrawing,
    },
  })
  assert.equal(invention.state, 'ready')
  if (invention.state !== 'ready') assert.fail('expected a ready paid kind invention')
  const invented = await completeTreasuryPaymentOperation(database, {
    attemptId: invention.attempt_id,
    leaseOwner: invention.lease_owner,
  })
  assert.equal(invented.state, 'completed')
  if (invented.state !== 'completed') assert.fail('expected a completed paid kind invention')
  assert.equal(invented.status, 201)
  const inventedKind = invented.response.kind as { id: number; drawing: unknown }
  assert.deepEqual(inventedKind.drawing, firstPaidDrawing)

  const pinnedPaidThingId = Number((await client.query<{ id: number }>(`
    INSERT INTO things (
      place_id, name, body, owner_id, maker_id, kind_id,
      birth_revision, current_revision
    ) VALUES ($1, 'paid pinned thing', '', 2, 2, $2, 1, 1)
    RETURNING id
  `, [placeId, inventedKind.id])).rows[0]!.id)
  const secondPaidDrawing = drawing('#1e5964')
  await issueCityFeeCredit(database, {
    founderId: 1,
    residentId: 2,
    sourceKey: 'drawing-kind-revision-credit-0001',
    reason: 'real PostgreSQL drawing revision proof',
  })
  const revision = await beginCityCreditSpend(database, {
    actorId: 2,
    operation: 'kind_revision',
    targetKey: `kind-revision:${inventedKind.id}:2`,
    requestId: 'drawing-kind-revision-request-0001',
    assetType: 'kind',
    assetId: inventedKind.id,
    request: {
      kind_id: inventedKind.id,
      description: 'the second paid drawing revision',
      traits: [],
      recipe: [],
      drawing: secondPaidDrawing,
    },
  })
  assert.equal(revision.state, 'ready')
  if (revision.state !== 'ready') assert.fail('expected a ready paid kind revision')
  const revised = await completeTreasuryPaymentOperation(database, {
    attemptId: revision.attempt_id,
    leaseOwner: revision.lease_owner,
  })
  assert.equal(revised.state, 'completed')
  if (revised.state !== 'completed') assert.fail('expected a completed paid kind revision')
  assert.equal(revised.status, 200)
  assert.deepEqual((revised.response.kind as { drawing: unknown }).drawing, secondPaidDrawing)

  const pinnedDrawing = async () => (await client!.query<{ drawing: unknown }>(`
    SELECT revision.drawing
    FROM things thing
    JOIN kind_revisions revision
      ON revision.kind_id = thing.kind_id AND revision.revision = thing.current_revision
    WHERE thing.id = $1
  `, [pinnedPaidThingId])).rows[0]!.drawing
  assert.deepEqual(await pinnedDrawing(), firstPaidDrawing)
  await client.query('UPDATE things SET current_revision = 2 WHERE id = $1', [pinnedPaidThingId])
  assert.deepEqual(await pinnedDrawing(), secondPaidDrawing)

  const lateFinalityDrawing = drawing('#6f4b7d')
  const lateFinalityRequest = {
    name: 'late-finality-drawn-kind',
    description: 'a drawing-bearing x402 invention finalized after its authorization window',
    traits: [],
    recipe: [],
    drawing: lateFinalityDrawing,
  }
  const lateFinalityCanonical = canonicalPaymentRequest(lateFinalityRequest)
  const lateFinalityAttemptId = 'drawing-late-finality-attempt-0001'
  const lateFinalityLeaseOwner = 'drawing-late-finality-lease-0001'
  const lateFinalityTxHash = `0x${'7'.repeat(64)}`
  const lateFinalityPayer = `0x${'5'.repeat(40)}`
  const lateFinalityResponseHeader = Buffer.from(JSON.stringify({
    success: true,
    transaction: lateFinalityTxHash,
    payer: lateFinalityPayer,
    network: NETWORK,
  })).toString('base64')
  const lateBoundary = (await client.query<{
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
  assert.ok(lateBoundary.block_time >= lateBoundary.start_time)
  assert.ok(lateBoundary.block_time < lateBoundary.end_time)
  await client.query(`
    INSERT INTO payment_attempts (
      public_id, actor_id, operation, target_key, request_hash, request_json,
      method, network, token, payer_wallet, payee_wallet, amount_units,
      x402_nonce, x402_payload_digest, x402_valid_after, x402_valid_before,
      start_block, start_time, end_time, status, lease_owner, lease_expires_at
    ) VALUES (
      $1, 2, 'kind_invention', $2, $3, $4::jsonb,
      'x402', $5, $6, $7, $8, 1000000,
      $9, repeat('a', 64), $10::bigint, $11::bigint,
      50000000, $12::timestamptz, $13::timestamptz,
      'settling', $14, clock_timestamp() + interval '30 seconds'
    )
  `, [
    lateFinalityAttemptId,
    `kind-invention:${lateFinalityRequest.name}`,
    lateFinalityCanonical.hash,
    lateFinalityCanonical.json,
    NETWORK,
    USDC.toLowerCase(),
    lateFinalityPayer,
    TREASURY,
    `0x${'6'.repeat(64)}`,
    lateBoundary.valid_after,
    lateBoundary.valid_before,
    lateBoundary.start_time.toISOString(),
    lateBoundary.end_time.toISOString(),
    lateFinalityLeaseOwner,
  ])

  const pendingLateFinality = await bindPaymentEvidence(database, {
    publicId: lateFinalityAttemptId,
    leaseOwner: lateFinalityLeaseOwner,
    txHash: lateFinalityTxHash,
    finality: null,
    paymentResponseHeader: lateFinalityResponseHeader,
  })
  assert.equal(pendingLateFinality.status, 'payment_pending')
  assert.ok(pendingLateFinality.recoveryDeadlineAt)

  const wallClockStartedAt = Date.now()
  let finalizedAt = ''
  for (;;) {
    const observed = (await client.query<{
      observed_at: Date
      operation_passed: boolean
      authorization_passed: boolean
    }>(`
      SELECT clock_timestamp() AS observed_at,
        clock_timestamp() > $1::timestamptz + interval '1 millisecond' AS operation_passed,
        clock_timestamp() > to_timestamp($2::bigint) + interval '1 millisecond'
          AS authorization_passed
    `, [lateBoundary.end_time.toISOString(), lateBoundary.valid_before])).rows[0]!
    if (observed.operation_passed && observed.authorization_passed) {
      finalizedAt = observed.observed_at.toISOString()
      break
    }
    await delay(25)
  }
  assert.ok(
    Date.now() - wallClockStartedAt >= 1_500,
    'the drawing test must cross a real PostgreSQL authorization window',
  )

  const finalizedLatePayment = await bindPaymentEvidence(database, {
    publicId: lateFinalityAttemptId,
    leaseOwner: lateFinalityLeaseOwner,
    txHash: lateFinalityTxHash,
    finality: {
      blockNumber: 50_000_001n,
      blockHash: `0x${'8'.repeat(64)}`,
      blockTime: lateBoundary.block_time.toISOString(),
      finalizedAt,
    },
    paymentResponseHeader: lateFinalityResponseHeader,
  })
  assert.equal(finalizedLatePayment.status, 'payment_pending')

  const lateTiming = (await client.query<{
    block_inside_authorization: boolean
    block_inside_operation: boolean
    observed_after_authorization: boolean
    observed_after_operation: boolean
    recovery_window_open: boolean
  }>(`
    SELECT finalized_block_time >= to_timestamp(x402_valid_after)
        AND finalized_block_time < to_timestamp(x402_valid_before)
        AS block_inside_authorization,
      finalized_block_time >= start_time AND finalized_block_time < end_time
        AS block_inside_operation,
      finalized_at > to_timestamp(x402_valid_before) AS observed_after_authorization,
      finalized_at > end_time AS observed_after_operation,
      recovery_deadline_at > clock_timestamp() AS recovery_window_open
    FROM payment_attempts WHERE public_id = $1
  `, [lateFinalityAttemptId])).rows[0]
  assert.deepEqual(lateTiming, {
    block_inside_authorization: true,
    block_inside_operation: true,
    observed_after_authorization: true,
    observed_after_operation: true,
    recovery_window_open: true,
  })

  const lateCompleted = await completeTreasuryPaymentOperation(database, {
    attemptId: lateFinalityAttemptId,
    leaseOwner: lateFinalityLeaseOwner,
  })
  assert.equal(lateCompleted.state, 'completed')
  if (lateCompleted.state !== 'completed') {
    assert.fail('expected the late-finalizing drawing invention to complete inside recovery')
  }
  assert.equal(lateCompleted.method, 'x402')
  assert.deepEqual(
    (lateCompleted.response.kind as { drawing: unknown }).drawing,
    lateFinalityDrawing,
  )
  const lateStored = (await client.query<{
    status: string
    payment_uses: number
    kind_drawing: unknown
  }>(`
    SELECT attempt.status,
      (SELECT count(*)::integer FROM payment_uses payment_use
        WHERE payment_use.payment_attempt_id = attempt.public_id) AS payment_uses,
      revision.drawing AS kind_drawing
    FROM payment_attempts attempt
    JOIN kinds kind ON kind.name = $2
    JOIN kind_revisions revision
      ON revision.kind_id = kind.id AND revision.revision = kind.current_revision
    WHERE attempt.public_id = $1
  `, [lateFinalityAttemptId, lateFinalityRequest.name])).rows[0]
  assert.deepEqual(lateStored, {
    status: 'completed',
    payment_uses: 1,
    kind_drawing: lateFinalityDrawing,
  })

  await issueCityFeeCredit(database, {
    founderId: 1,
    residentId: 2,
    sourceKey: 'legacy-kind-invention-credit-0001',
    reason: 'pre-drawing kind invention compatibility proof',
  })
  const legacyInvention = await beginCityCreditSpend(database, {
    actorId: 2,
    operation: 'kind_invention',
    targetKey: 'kind-invention:legacy-undrawn-kind',
    requestId: 'legacy-kind-invention-request-0001',
    request: {
      name: 'legacy-undrawn-kind',
      description: 'the exact request shape stored before drawings existed',
      traits: [],
      recipe: [],
    },
  })
  assert.equal(legacyInvention.state, 'ready')
  if (legacyInvention.state !== 'ready') assert.fail('expected a ready legacy kind invention')
  const legacyInvented = await completeTreasuryPaymentOperation(database, {
    attemptId: legacyInvention.attempt_id,
    leaseOwner: legacyInvention.lease_owner,
  })
  assert.equal(legacyInvented.state, 'completed')
  if (legacyInvented.state !== 'completed') assert.fail('expected a completed legacy kind invention')
  const legacyKind = legacyInvented.response.kind as { id: number; drawing: unknown }
  assert.equal(legacyKind.drawing, null)
  const legacyPinnedThingId = Number((await client.query<{ id: number }>(`
    INSERT INTO things (
      place_id, name, body, owner_id, maker_id, kind_id,
      birth_revision, current_revision
    ) VALUES ($1, 'legacy pinned thing', '', 2, 2, $2, 1, 1)
    RETURNING id
  `, [placeId, legacyKind.id])).rows[0]!.id)

  await issueCityFeeCredit(database, {
    founderId: 1,
    residentId: 2,
    sourceKey: 'legacy-kind-revision-credit-0001',
    reason: 'pre-drawing kind revision compatibility proof',
  })
  const legacyRevision = await beginCityCreditSpend(database, {
    actorId: 2,
    operation: 'kind_revision',
    targetKey: `kind-revision:${legacyKind.id}:2`,
    requestId: 'legacy-kind-revision-request-0001',
    assetType: 'kind',
    assetId: legacyKind.id,
    request: {
      kind_id: legacyKind.id,
      description: 'the old paid revision shape still settles',
      traits: [],
      recipe: [],
    },
  })
  assert.equal(legacyRevision.state, 'ready')
  if (legacyRevision.state !== 'ready') assert.fail('expected a ready legacy kind revision')
  const legacyRevised = await completeTreasuryPaymentOperation(database, {
    attemptId: legacyRevision.attempt_id,
    leaseOwner: legacyRevision.lease_owner,
  })
  assert.equal(legacyRevised.state, 'completed')
  if (legacyRevised.state !== 'completed') assert.fail('expected a completed legacy kind revision')
  assert.equal((legacyRevised.response.kind as { drawing: unknown }).drawing, null)
  assert.equal((await client.query<{ current_revision: number }>(`
    SELECT current_revision FROM things WHERE id = $1
  `, [legacyPinnedThingId])).rows[0]!.current_revision, 1)
})
