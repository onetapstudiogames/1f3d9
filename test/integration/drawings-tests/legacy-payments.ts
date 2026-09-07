import assert from 'node:assert/strict'
import type { Client } from 'pg'
import { beginCityCreditSpend, issueCityFeeCredit } from '../../../src/city-credit.ts'
import { completeTreasuryPaymentOperation } from '../../../src/payment-treasury-operations.ts'

export async function registerLegacyPaymentTests(
  client: Client,
  database: { query: (text: string, params?: readonly unknown[]) => Promise<Record<string, unknown>[]> },
  placeId: number,
): Promise<void> {
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
}
