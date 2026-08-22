import { USDC, type TransferCheck } from '../src/chain.ts'

export const BOB_REPAIR_APPLY_ACKNOWLEDGEMENT = 'APPLY_BOB_PAYMENT_REPAIR_WAVE_11'
export const BOB_COFFEE_REVIEW_REASON =
  'Founder-approved no-effect closure for the paid coffee-shop probe; compensating city fee credit is tracked by its deterministic source key.'
export const BOB_REPAIR_CREDIT_REASON =
  'Extra finalized coffee-shop probe payment; no place was created.'

export const BOB_RESIDENT_ID = 68
export const BOB_HANDLE = 'bob'
export const FOUNDER_RESIDENT_ID = 1
export const ONE_USDC_UNITS = 1_000_000n
export const ONE_USDC = '1.000000'
export const EXPECTED_PAYER = '0xc644af48219fb10ab9b01bdcc023dd4614c4c17d'
export const EXPECTED_RECIPIENT = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
export const EXPECTED_TOKEN = USDC.toLowerCase()

const COFFEE_REQUEST = Object.freeze({
  name: 'coffee-shop',
  parent_id: null,
  description: '',
  open_to_notes: false,
  open_to_things: false,
  open_to_building: false,
})

const THE_BLUE_AI_REQUEST = Object.freeze({
  name: 'TheBlueAI',
  parent_id: null,
  description: '',
  open_to_notes: false,
  open_to_things: false,
  open_to_building: false,
})

export type FrontierRequest = typeof COFFEE_REQUEST | typeof THE_BLUE_AI_REQUEST

export type AttemptExpectation = Readonly<{
  attemptId: string
  txHash: string
  targetKey: string
  updatedAt: string
  recoveryStartedAt: string
  recoveryDeadlineAt: string
  requestHash: string
  request: FrontierRequest
  blockNumber: string
  blockHash: string
  blockTime: string
}>

export const BOB_REPAIR_EXPECTATIONS = Object.freeze({
  payer: EXPECTED_PAYER,
  recipient: EXPECTED_RECIPIENT,
  token: EXPECTED_TOKEN,
  coffee: Object.freeze({
    attemptId: 'pay_ae6db1c532fdcca0bdc2c977433e842540a5fa2dc1c41c830627dba60fe5c24b',
    txHash: '0x4763c349baa8d207658e5d98f18731352e3bac7dd6bdd93e624537a182df3404',
    targetKey: 'frontier:root:coffee-shop',
    updatedAt: '2026-08-22T07:56:08.722Z',
    recoveryStartedAt: '2026-08-22T07:56:08.722Z',
    recoveryDeadlineAt: '2026-08-22T09:56:08.722Z',
    requestHash: '1f7e05ae3c42ded1383a01a6ab4a95ce846bf85c1cf9c534b99f9806994bfc9f',
    request: COFFEE_REQUEST,
    blockNumber: '50297998',
    blockHash: '0xdca09260a62046ab82535e0d6e517af39e3fd8623a0f29315e1baa52e0f991c8',
    blockTime: '2026-08-22T07:55:43Z',
  }) satisfies AttemptExpectation,
  theBlueAI: Object.freeze({
    attemptId: 'pay_c91797c383589bf8d8f01b81e9097c6430e313be8ef97a8f78ca541bb7c6a1a3',
    txHash: '0x97c6b871917f8be893f2c3f4de0ea52ef8a87875290c53dec10d9115fa9272c8',
    targetKey: 'frontier:root:TheBlueAI',
    updatedAt: '2026-08-22T07:57:45.063Z',
    recoveryStartedAt: '2026-08-22T07:57:45.063Z',
    recoveryDeadlineAt: '2026-08-22T09:57:45.063Z',
    requestHash: 'e4c18fd8ced7e458b674cacdb7359ba12126fea50b5c02fb8c1e3a3ae731c885',
    request: THE_BLUE_AI_REQUEST,
    blockNumber: '50297465',
    blockHash: '0xa81a18a3e45dc7c11d4fb870909a541eb232f033acb15eed099a342962e6ee44',
    blockTime: '2026-08-22T07:37:57Z',
  }) satisfies AttemptExpectation,
})

export const BOB_REPAIR_CREDIT_SOURCE_KEY =
  `bob-payment-repair:${BOB_REPAIR_EXPECTATIONS.coffee.attemptId}`

export type QueryRow = Readonly<Record<string, unknown>>

export type BobRepairSnapshot = Readonly<{
  residents: readonly QueryRow[]
  attempts: readonly QueryRow[]
  paymentUses: readonly QueryRow[]
  fees: readonly QueryRow[]
  worldRoots: readonly QueryRow[]
  places: readonly QueryRow[]
  credits: readonly QueryRow[]
}>

export type BobTransferEvidence = TransferCheck

export type GuardedBobPaymentFacts = Readonly<{
  attempt_id: string
  transaction: string
  actor_id: 68
  operation: 'frontier'
  target_key: string
  request_hash: string
  request: FrontierRequest
  expected_updated_at: string
  recovery_started_at: string
  recovery_deadline_at: string
  network: 'base'
  token: string
  payer: string
  recipient: string
  amount_units: '1000000'
  canonical_block_number: string
  canonical_block_hash: string
  canonical_block_time: string
}>

export type CompleteTheBlueAIAction = Readonly<{
  kind: 'complete_theblueai'
  attempt_id: string
  transaction: string
  resident_id: 68
  name: 'TheBlueAI'
  world_root_id: number
  place: Readonly<{
    name: 'TheBlueAI'
    description: string
    open_to_building: boolean
    open_to_things: boolean
    open_to_notes: boolean
  }>
  guard: GuardedBobPaymentFacts
}>

export type CloseCoffeeProbeAction = Readonly<{
  kind: 'close_coffee_probe'
  attempt_id: string
  transaction: string
  resident_id: 68
  terminal_state: 'founder_review'
  reason: string
  guard: GuardedBobPaymentFacts
}>

export type IssueFounderCreditAction = Readonly<{
  kind: 'issue_founder_credit'
  attempt_id: string
  transaction: string
  founder_id: 1
  resident_id: 68
  amount_units: '1000000'
  source_key: string
  reason: string
}>

export type BobRepairAction =
  | CompleteTheBlueAIAction
  | CloseCoffeeProbeAction
  | IssueFounderCreditAction

export type BobPaymentRepairPlan = Readonly<{
  schema_version: 1
  state: 'work_required' | 'no_work'
  resident_id: 68
  actions: readonly BobRepairAction[]
}>

export interface BobRepairQueryClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly QueryRow[] }>>
}

export interface BobRepairClient extends BobRepairQueryClient {
  connect(): Promise<unknown>
  end(): Promise<void>
}

export interface BobPaymentRepairApplyOperations {
  completeTheBlueAI(
    database: BobRepairQueryClient,
    action: CompleteTheBlueAIAction,
  ): Promise<void>
  closeCoffeeProbe(
    database: BobRepairQueryClient,
    action: CloseCoffeeProbeAction,
  ): Promise<void>
  issueFounderCredit(
    database: BobRepairQueryClient,
    action: IssueFounderCreditAction,
  ): Promise<void>
}

export class BobPaymentRepairAbortError extends Error {
  constructor(message: string) {
    super(`Bob payment repair aborted: ${message}`)
    this.name = 'BobPaymentRepairAbortError'
  }
}

export function abort(message: string): never {
  throw new BobPaymentRepairAbortError(message)
}

export function exactRow(rows: readonly QueryRow[], label: string): QueryRow {
  if (rows.length !== 1) abort(`${label} is missing or ambiguous`)
  return rows[0]!
}

export function text(row: QueryRow, key: string): string | null {
  return row[key] == null ? null : String(row[key])
}

export function integer(row: QueryRow, key: string): number | null {
  if (row[key] == null) return null
  const parsed = Number(row[key])
  return Number.isSafeInteger(parsed) ? parsed : null
}

export function boolean(row: QueryRow, key: string): boolean | null {
  const value = row[key]
  if (value === true || value === 't') return true
  if (value === false || value === 'f') return false
  return null
}

export function iso(value: unknown): string | null {
  if (value == null) return null
  const parsed = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

export function sameTime(left: unknown, right: string): boolean {
  return iso(left) === new Date(right).toISOString()
}

export function normalizedWallet(value: unknown): string | null {
  const candidate = typeof value === 'string' ? value.toLowerCase() : ''
  return /^0x[0-9a-f]{40}$/u.test(candidate) ? candidate : null
}
