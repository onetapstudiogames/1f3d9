import assert from 'node:assert/strict'
import { getRoutesTestContext } from './context.ts'



export const CITY_CREDIT_ROUTE_CASES = [
  {
    label: 'frontier',
    operation: 'frontier',
    path: '/api/place',
    status: 201,
    requestId: 'wave4-frontier-0001',
    body: { parent_id: null, name: 'Credit Continent', description: 'founded with credit' },
    invalidBody: { parent_id: null, name: '', description: 'invalid before debit' },
    resultKey: 'place',
    failureReason: 'frontier target changed before completion',
    temporaryFailure: 'frontier founding failed before completion',
  },
  {
    label: 'kind invention',
    operation: 'kind_invention',
    path: '/api/kind',
    status: 201,
    requestId: 'wave4-kind-0000001',
    body: { name: 'credit-lantern', description: 'made with credit', traits: [], recipe: [] },
    invalidBody: {
      name: 'invalid-credit-kind', description: 'invalid before debit',
      traits: ['glowing', 'glowing'], recipe: [],
    },
    resultKey: 'kind',
    failureReason: 'kind invention target changed before completion',
    temporaryFailure: 'kind invention failed before completion',
  },
  {
    label: 'kind revision',
    operation: 'kind_revision',
    path: '/api/kind/3/revise',
    status: 200,
    requestId: 'wave4-revision-001',
    body: { description: 'revised with credit', traits: ['glowing'], recipe: [] },
    invalidBody: {
      description: 'invalid before debit', traits: ['glowing', 'glowing'], recipe: [],
    },
    resultKey: 'kind',
    failureReason: 'kind revision target changed before completion',
    temporaryFailure: 'kind revision failed before completion',
  },
] as const

export const cityCreditDomainWriteCount = () => getRoutesTestContext().sqlCalls().filter(call =>
  /complete_city_credit_attempt/iu.test(call.query ?? '')).length

export const assertCityCreditNoStore = (response: Response, label: string) => {
  assert.match(
    response.headers.get('cache-control') ?? '',
    /(?:^|,)\s*no-store\s*(?:,|$)/iu,
    `${label}: city fee credit response must be private and non-cacheable`,
  )
}
