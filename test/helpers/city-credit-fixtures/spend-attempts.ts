import { canonicalPaymentRequest } from '../../../src/payment-attempts.ts'
import { CITY_FEE_CREDIT_UNITS } from '../../../src/city-credit.ts'
import type { QueryRow } from './ledger-database.ts'
import { REQUEST_ID } from './ledger-entries.ts'

export const ATTEMPT_ID = 'credit_attempt_0001'

export const LEASE_OWNER = 'credit_lease_0001'

const REQUEST = Object.freeze({
  name: 'TheBlueAI',
  kind: 'continent',
  nested: Object.freeze({ b: 2, a: 1 }),
})

export const CANONICAL_REQUEST = canonicalPaymentRequest(REQUEST)

export function spendRow(overrides: QueryRow = {}): QueryRow {
  return {
    state: 'ready',
    attempt_id: ATTEMPT_ID,
    actor_id: 7,
    operation: 'frontier',
    target_key: 'frontier:TheBlueAI',
    request_id: REQUEST_ID,
    request_hash: CANONICAL_REQUEST.hash,
    request_json: CANONICAL_REQUEST.json,
    amount_units: CITY_FEE_CREDIT_UNITS.toString(),
    spend_entry_id: '201',
    return_entry_id: null,
    response_status: null,
    response_json: null,
    lease_acquired: true,
    lease_owner: LEASE_OWNER,
    ...overrides,
  }
}

export function spendInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    actorId: 7,
    operation: 'frontier' as const,
    targetKey: 'frontier:TheBlueAI',
    request: REQUEST,
    requestId: REQUEST_ID,
    ...overrides,
  }
}
