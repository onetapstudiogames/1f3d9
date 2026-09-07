import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Client } from 'pg'
import { beginCityCreditSpend, issueCityFeeCredit } from '../../../src/city-credit.ts'
import { completeTreasuryPaymentOperation } from '../../../src/payment-treasury-operations.ts'

export async function registerPaidRevisionTests(
  t: TestContext,
  client: Client,
  database: { query: (text: string, params?: readonly unknown[]) => Promise<Record<string, unknown>[]> },
  placeId: number,
  drawing: (colour: string) => { palette: string[]; indices: (number | null)[] },
): Promise<void> {
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
      drawing_state: 'complete',
      drawing_description: 'The first paid kind drawing.',
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
      drawing_state: 'complete',
      drawing_description: 'The second paid kind drawing.',
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
}
