// Dry-run-first, guarded operator repair for Bob's two stuck city payments.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client } from 'pg'
import {
  NETWORK,
  classifyUsdcTransfer,
} from '../src/chain.ts'
import { canonicalPaymentRequest } from '../src/payment-attempts.ts'
import { bobPaymentRepairApplyOperations } from './bob-payment-repair-apply.ts'
import {
  describeDatabaseUrl,
  requireDatabaseName,
  requiredIdentifier,
  verifyNeonDatabaseTarget,
  type DatabaseIdentity,
} from './database-target.ts'
import {
  BOB_COFFEE_REPAIR_REASON,
  BOB_HANDLE,
  BOB_REPAIR_APPLY_ACKNOWLEDGEMENT,
  BOB_REPAIR_CREDIT_REASON,
  BOB_REPAIR_CREDIT_SOURCE_KEY,
  BOB_REPAIR_EXPIRY_REASON,
  BOB_REPAIR_EXPECTATIONS,
  BOB_RESIDENT_ID,
  BOB_THEBLUEAI_REPAIR_REASON,
  BobPaymentRepairAbortError,
  EXPECTED_PAYER,
  EXPECTED_RECIPIENT,
  EXPECTED_TOKEN,
  FOUNDER_RESIDENT_ID,
  ONE_USDC_UNITS,
  abort,
  boolean,
  exactRow,
  integer,
  iso,
  normalizedWallet,
  sameTime,
  text,
  type AttemptExpectation,
  type BobPaymentRepairApplyOperations,
  type BobPaymentRepairPlan,
  type BobRepairAction,
  type BobRepairClient,
  type BobRepairQueryClient,
  type BobRepairSnapshot,
  type BobTransferEvidence,
  type GuardedBobPaymentFacts,
  type QueryRow,
} from './bob-payment-repair-model.ts'

export {
  BOB_COFFEE_REPAIR_REASON,
  BOB_REPAIR_APPLY_ACKNOWLEDGEMENT,
  BOB_REPAIR_CREDIT_REASON,
  BOB_REPAIR_CREDIT_SOURCE_KEY,
  BOB_REPAIR_EXPIRY_REASON,
  BOB_REPAIR_EXPECTATIONS,
  BOB_THEBLUEAI_REPAIR_REASON,
  BobPaymentRepairAbortError,
} from './bob-payment-repair-model.ts'

export type {
  BobPaymentRepairApplyOperations,
  BobPaymentRepairPlan,
  BobRepairAction,
  BobRepairQueryClient,
  BobRepairSnapshot,
  BobTransferEvidence,
  CloseCoffeeProbeAction,
  CompleteTheBlueAIAction,
  GuardedBobPaymentFacts,
  IssueFounderCreditAction,
} from './bob-payment-repair-model.ts'

function requestMatches(row: QueryRow, expected: AttemptExpectation): boolean {
  try {
    const request = canonicalPaymentRequest(row.request_json)
    const expectedRequest = canonicalPaymentRequest(expected.request)
    return request.json === expectedRequest.json
      && request.hash === expected.requestHash
      && text(row, 'request_hash') === expected.requestHash
  } catch {
    return false
  }
}

function validateAttemptImmutable(row: QueryRow, expected: AttemptExpectation): void {
  const matches = text(row, 'public_id') === expected.attemptId
    && integer(row, 'actor_id') === BOB_RESIDENT_ID
    && text(row, 'resident_handle') === BOB_HANDLE
    && row.counterparty_id == null
    && text(row, 'operation') === 'frontier'
    && text(row, 'target_key') === expected.targetKey
    && row.offer_id == null
    && row.asset_type == null
    && row.asset_id == null
    && requestMatches(row, expected)
    && text(row, 'method') === 'x402'
    && text(row, 'network') === NETWORK
    && normalizedWallet(row.token) === EXPECTED_TOKEN
    && normalizedWallet(row.payer_wallet) === EXPECTED_PAYER
    && normalizedWallet(row.payee_wallet) === EXPECTED_RECIPIENT
    && text(row, 'amount_units') === ONE_USDC_UNITS.toString()
    && text(row, 'tx_hash')?.toLowerCase() === expected.txHash
    && sameTime(row.recovery_started_at, expected.recoveryStartedAt)
    && sameTime(row.recovery_deadline_at, expected.recoveryDeadlineAt)
  if (!matches) abort(`${expected.attemptId} immutable attempt facts changed`)
}

function observedRepairTimestamp(row: QueryRow, expected: AttemptExpectation): string {
  const updatedAt = iso(row.updated_at)
  const databaseNow = iso(row.database_now)
  const earliest = Date.parse(expected.updatedAt)
  if (
    updatedAt == null
    || databaseNow == null
    || Date.parse(updatedAt) < earliest
    || Date.parse(updatedAt) > Date.parse(databaseNow)
  ) abort(`${expected.attemptId} update time is outside the approved repair window`)
  return updatedAt
}

function validateExpiredAttempt(row: QueryRow, expected: AttemptExpectation): string {
  validateAttemptImmutable(row, expected)
  if (row.lease_owner != null || row.lease_expires_at != null) {
    abort(`${expected.attemptId} expired state retained a recovery lease`)
  }
  const updatedAt = observedRepairTimestamp(row, expected)
  const finalityIsEmpty = row.finalized_block_number == null
    && row.finalized_block_hash == null
    && row.finalized_block_time == null
    && row.finalized_at == null
  if (
    text(row, 'status') !== 'expired'
    || !finalityIsEmpty
    || text(row, 'invalid_reason') !== BOB_REPAIR_EXPIRY_REASON
    || row.completed_at != null
  ) abort(`${expected.attemptId} expired state or stored finality changed`)
  return updatedAt
}

function validateStoredFinality(row: QueryRow, expected: AttemptExpectation): void {
  const blockNumber = text(row, 'finalized_block_number')
  const blockHash = text(row, 'finalized_block_hash')?.toLowerCase()
  if (
    blockNumber !== expected.blockNumber
    || blockHash !== expected.blockHash
    || !sameTime(row.finalized_block_time, expected.blockTime)
    || iso(row.finalized_at) == null
  ) abort(`${expected.attemptId} stored finality changed`)
}

function validateChainEvidence(
  evidence: BobTransferEvidence | undefined,
  expected: AttemptExpectation,
): void {
  if (!evidence || evidence.state !== 'matched') {
    abort(`${expected.txHash} is not one unambiguous finalized Base USDC match`)
  }
  if (
    normalizedWallet(evidence.from) !== EXPECTED_PAYER
    || normalizedWallet(evidence.to) !== EXPECTED_RECIPIENT
    || evidence.amount !== ONE_USDC_UNITS
    || evidence.blockNumber !== BigInt(expected.blockNumber)
    || evidence.blockHash.toLowerCase() !== expected.blockHash
    || evidence.blockTime.getTime() !== new Date(expected.blockTime).getTime()
    || Number.isNaN(evidence.finalizedAt.getTime())
  ) abort(`${expected.txHash} canonical transfer facts changed`)
}

function matchingNamePlaces(snapshot: BobRepairSnapshot, name: string): readonly QueryRow[] {
  return snapshot.places.filter(row => text(row, 'name')?.toLowerCase() === name.toLowerCase())
}

function validateInitialState(snapshot: BobRepairSnapshot): Readonly<{
  worldRootId: number
  coffee: QueryRow
  theBlueAI: QueryRow
}> {
  const resident = exactRow(snapshot.residents, 'Bob resident 68')
  if (integer(resident, 'id') !== BOB_RESIDENT_ID || text(resident, 'handle') !== BOB_HANDLE) {
    abort('resident 68 is no longer Bob')
  }
  if (snapshot.attempts.length !== 2) abort('the guarded attempts are missing or ambiguous')
  const coffee = exactRow(
    snapshot.attempts.filter(row => text(row, 'public_id') === BOB_REPAIR_EXPECTATIONS.coffee.attemptId),
    'coffee-shop attempt',
  )
  const theBlueAI = exactRow(
    snapshot.attempts.filter(row => text(row, 'public_id') === BOB_REPAIR_EXPECTATIONS.theBlueAI.attemptId),
    'TheBlueAI attempt',
  )
  validateExpiredAttempt(coffee, BOB_REPAIR_EXPECTATIONS.coffee)
  validateExpiredAttempt(theBlueAI, BOB_REPAIR_EXPECTATIONS.theBlueAI)
  exactRow(snapshot.worldRoots, 'world root')
  const root = snapshot.worldRoots[0]!
  if (
    text(root, 'name') !== 'the world'
    || text(root, 'place_kind') !== 'world'
    || root.owner_id != null
    || integer(root, 'id') == null
  ) abort('world root facts changed')
  if (snapshot.paymentUses.length !== 0) abort('one of Bob\'s transaction hashes or attempts is already used')
  if (snapshot.fees.length !== 0) abort('one of Bob\'s transaction hashes already has a fee row')
  if (snapshot.places.length !== 0) abort('TheBlueAI or coffee-shop is no longer available')
  if (snapshot.credits.length !== 0) abort('the deterministic founder credit source is already occupied')
  if (snapshot.events.length !== 0) abort('the deterministic repair event keys are already occupied')
  return Object.freeze({
    worldRootId: integer(root, 'id')!,
    coffee,
    theBlueAI,
  })
}

function exactTheBlueAIPlace(row: QueryRow, rootId: number): boolean {
  const request = BOB_REPAIR_EXPECTATIONS.theBlueAI.request
  return integer(row, 'parent_id') === rootId
    && text(row, 'place_kind') === 'continent'
    && text(row, 'name') === request.name
    && text(row, 'description') === request.description
    && integer(row, 'owner_id') === BOB_RESIDENT_ID
    && boolean(row, 'open_to_building') === request.open_to_building
    && boolean(row, 'open_to_things') === request.open_to_things
    && boolean(row, 'open_to_notes') === request.open_to_notes
}

function exactFounderCredit(row: QueryRow): boolean {
  return integer(row, 'resident_id') === BOB_RESIDENT_ID
    && text(row, 'entry_kind') === 'founder_issue'
    && text(row, 'amount_units') === ONE_USDC_UNITS.toString()
    && integer(row, 'founder_id') === FOUNDER_RESIDENT_ID
    && text(row, 'source_key') === BOB_REPAIR_CREDIT_SOURCE_KEY
    && text(row, 'reason') === BOB_REPAIR_CREDIT_REASON
}

function repairEventKey(expected: AttemptExpectation): string {
  return `bob-payment-repair:${expected.attemptId}`
}

function exactRepairEvent(
  row: QueryRow,
  expected: AttemptExpectation,
  outcome: string,
  extras: Readonly<Record<string, unknown>> = {},
): boolean {
  const detail = row.detail
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return false
  const record = detail as Readonly<Record<string, unknown>>
  return text(row, 'kind') === 'payment_repair'
    && text(row, 'actor') === 'host'
    && text(record, 'repair_key') === repairEventKey(expected)
    && text(record, 'attempt_id') === expected.attemptId
    && text(record, 'transaction')?.toLowerCase() === expected.txHash
    && integer(record, 'resident_id') === BOB_RESIDENT_ID
    && text(record, 'source_status') === 'expired'
    && text(record, 'payment_status') === 'founder_review'
    && text(record, 'outcome') === outcome
    && Object.entries(extras).every(([key, value]) => record[key] === value)
}

function validateFinalState(snapshot: BobRepairSnapshot): void {
  const resident = exactRow(snapshot.residents, 'Bob resident 68')
  if (integer(resident, 'id') !== BOB_RESIDENT_ID || text(resident, 'handle') !== BOB_HANDLE) {
    abort('resident 68 is no longer Bob')
  }
  const root = exactRow(snapshot.worldRoots, 'world root')
  const rootId = integer(root, 'id')
  if (
    rootId == null
    || text(root, 'name') !== 'the world'
    || text(root, 'place_kind') !== 'world'
    || root.owner_id != null
  ) abort('world root facts changed')
  if (snapshot.attempts.length !== 2) abort('the guarded attempts are missing or ambiguous')
  const coffee = exactRow(
    snapshot.attempts.filter(row => text(row, 'public_id') === BOB_REPAIR_EXPECTATIONS.coffee.attemptId),
    'coffee-shop attempt',
  )
  const theBlueAI = exactRow(
    snapshot.attempts.filter(row => text(row, 'public_id') === BOB_REPAIR_EXPECTATIONS.theBlueAI.attemptId),
    'TheBlueAI attempt',
  )
  validateAttemptImmutable(coffee, BOB_REPAIR_EXPECTATIONS.coffee)
  validateAttemptImmutable(theBlueAI, BOB_REPAIR_EXPECTATIONS.theBlueAI)
  if (
    coffee.lease_owner != null
    || coffee.lease_expires_at != null
    || theBlueAI.lease_owner != null
    || theBlueAI.lease_expires_at != null
  ) abort('completed Bob repair retained a payment recovery lease')
  validateStoredFinality(coffee, BOB_REPAIR_EXPECTATIONS.coffee)
  validateStoredFinality(theBlueAI, BOB_REPAIR_EXPECTATIONS.theBlueAI)
  if (
    text(coffee, 'status') !== 'founder_review'
    || text(coffee, 'invalid_reason') !== BOB_REPAIR_EXPIRY_REASON
    || coffee.completed_at != null
  ) abort('coffee-shop is not the exact closed founder-review outcome')
  if (
    text(theBlueAI, 'status') !== 'founder_review'
    || text(theBlueAI, 'invalid_reason') !== BOB_REPAIR_EXPIRY_REASON
    || theBlueAI.completed_at != null
  ) abort('TheBlueAI attempt is not the exact founder-review correction')
  if (snapshot.paymentUses.length !== 0) abort('payment use history is not the exact approved outcome')
  if (snapshot.fees.length !== 0) abort('fee history is not the exact approved outcome')
  const coffeePlaces = matchingNamePlaces(snapshot, 'coffee-shop')
  const bluePlaces = matchingNamePlaces(snapshot, 'TheBlueAI')
  if (coffeePlaces.length !== 0 || bluePlaces.length !== 1 || !exactTheBlueAIPlace(bluePlaces[0]!, rootId)) {
    abort('place outcome is not exactly one TheBlueAI and no coffee-shop')
  }
  if (snapshot.credits.length !== 1 || !exactFounderCredit(snapshot.credits[0]!)) {
    abort('founder credit history is not the exact approved outcome')
  }
  if (snapshot.events.length !== 2) abort('payment repair event history is not the exact approved outcome')
  const coffeeEvent = snapshot.events.find(row => {
    const detail = row.detail
    return detail && typeof detail === 'object' && !Array.isArray(detail)
      && text(detail as QueryRow, 'attempt_id') === BOB_REPAIR_EXPECTATIONS.coffee.attemptId
  })
  const blueEvent = snapshot.events.find(row => {
    const detail = row.detail
    return detail && typeof detail === 'object' && !Array.isArray(detail)
      && text(detail as QueryRow, 'attempt_id') === BOB_REPAIR_EXPECTATIONS.theBlueAI.attemptId
  })
  if (
    !coffeeEvent
    || !blueEvent
    || !exactRepairEvent(coffeeEvent, BOB_REPAIR_EXPECTATIONS.coffee, BOB_COFFEE_REPAIR_REASON)
    || !exactRepairEvent(
      blueEvent,
      BOB_REPAIR_EXPECTATIONS.theBlueAI,
      BOB_THEBLUEAI_REPAIR_REASON,
      { place_name: 'TheBlueAI', place_id: integer(bluePlaces[0]!, 'id') },
    )
  ) abort('payment repair event history is not the exact approved outcome')
}

function hasFinalStateSignal(snapshot: BobRepairSnapshot): boolean {
  return snapshot.attempts.some(row => ['completed', 'founder_review'].includes(text(row, 'status') ?? ''))
    || snapshot.paymentUses.length > 0
    || snapshot.fees.length > 0
    || snapshot.places.length > 0
    || snapshot.credits.length > 0
}

function guardedPayment(expected: AttemptExpectation, row: QueryRow): GuardedBobPaymentFacts {
  return Object.freeze({
    attempt_id: expected.attemptId,
    transaction: expected.txHash,
    actor_id: BOB_RESIDENT_ID,
    operation: 'frontier',
    target_key: expected.targetKey,
    request_hash: expected.requestHash,
    request: expected.request,
    expected_updated_at: observedRepairTimestamp(row, expected),
    recovery_started_at: expected.recoveryStartedAt,
    recovery_deadline_at: expected.recoveryDeadlineAt,
    network: NETWORK,
    token: EXPECTED_TOKEN,
    payer: EXPECTED_PAYER,
    recipient: EXPECTED_RECIPIENT,
    amount_units: '1000000',
    canonical_block_number: expected.blockNumber,
    canonical_block_hash: expected.blockHash,
    canonical_block_time: expected.blockTime,
  })
}

export function buildBobPaymentRepairPlan(
  snapshot: BobRepairSnapshot,
  chainEvidence: Readonly<Record<string, BobTransferEvidence>>,
): BobPaymentRepairPlan {
  validateChainEvidence(
    chainEvidence[BOB_REPAIR_EXPECTATIONS.coffee.txHash],
    BOB_REPAIR_EXPECTATIONS.coffee,
  )
  validateChainEvidence(
    chainEvidence[BOB_REPAIR_EXPECTATIONS.theBlueAI.txHash],
    BOB_REPAIR_EXPECTATIONS.theBlueAI,
  )

  if (hasFinalStateSignal(snapshot)) {
    validateFinalState(snapshot)
    return Object.freeze({
      schema_version: 1,
      state: 'no_work',
      resident_id: BOB_RESIDENT_ID,
      actions: Object.freeze([]),
    })
  }

  const initial = validateInitialState(snapshot)
  const theBlueAIRequest = BOB_REPAIR_EXPECTATIONS.theBlueAI.request
  return Object.freeze({
    schema_version: 1,
    state: 'work_required',
    resident_id: BOB_RESIDENT_ID,
    actions: Object.freeze([
      Object.freeze({
        kind: 'complete_theblueai',
        source_state: 'expired',
        attempt_id: BOB_REPAIR_EXPECTATIONS.theBlueAI.attemptId,
        transaction: BOB_REPAIR_EXPECTATIONS.theBlueAI.txHash,
        resident_id: BOB_RESIDENT_ID,
        name: 'TheBlueAI',
        world_root_id: initial.worldRootId,
        place: Object.freeze({
          name: 'TheBlueAI',
          description: theBlueAIRequest.description,
          open_to_building: theBlueAIRequest.open_to_building,
          open_to_things: theBlueAIRequest.open_to_things,
          open_to_notes: theBlueAIRequest.open_to_notes,
        }),
        guard: guardedPayment(BOB_REPAIR_EXPECTATIONS.theBlueAI, initial.theBlueAI),
      }),
      Object.freeze({
        kind: 'close_coffee_probe',
        source_state: 'expired',
        attempt_id: BOB_REPAIR_EXPECTATIONS.coffee.attemptId,
        transaction: BOB_REPAIR_EXPECTATIONS.coffee.txHash,
        resident_id: BOB_RESIDENT_ID,
        terminal_state: 'founder_review',
        reason: BOB_COFFEE_REPAIR_REASON,
        guard: guardedPayment(BOB_REPAIR_EXPECTATIONS.coffee, initial.coffee),
      }),
      Object.freeze({
        kind: 'issue_founder_credit',
        attempt_id: BOB_REPAIR_EXPECTATIONS.coffee.attemptId,
        transaction: BOB_REPAIR_EXPECTATIONS.coffee.txHash,
        founder_id: FOUNDER_RESIDENT_ID,
        resident_id: BOB_RESIDENT_ID,
        amount_units: '1000000',
        source_key: BOB_REPAIR_CREDIT_SOURCE_KEY,
        reason: BOB_REPAIR_CREDIT_REASON,
      }),
    ] satisfies readonly BobRepairAction[]),
  })
}

export type BobPaymentRepairOptions = Readonly<{
  target: 'production'
  expectedDatabase: string
  mode: 'dry-run' | 'apply'
}>

function argumentValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`)
  return value
}

export function parseBobPaymentRepairArgs(args: readonly string[]): BobPaymentRepairOptions {
  let target: 'production' | undefined
  let expectedDatabase: string | undefined
  let apply = false
  let acknowledgement: string | undefined
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!
    if (!['--target', '--database', '--apply', '--ack'].includes(flag)) {
      throw new Error(`unknown Bob repair argument: ${JSON.stringify(flag)}`)
    }
    if (seen.has(flag)) throw new Error(`duplicate Bob repair argument: ${flag}`)
    seen.add(flag)
    if (flag === '--apply') {
      apply = true
      continue
    }
    const value = argumentValue(args, index, flag)
    index += 1
    if (flag === '--target') {
      if (value !== 'production') throw new Error('Bob repair requires --target production')
      target = 'production'
    } else if (flag === '--database') {
      expectedDatabase = requireDatabaseName(value, '--database')
    } else {
      acknowledgement = value
    }
  }
  if (!target) throw new Error('Bob repair requires --target production')
  if (!expectedDatabase) throw new Error('Bob repair requires --database <expected-name>')
  if (!apply && acknowledgement != null) {
    throw new Error('--ack is valid only with --apply')
  }
  if (apply && acknowledgement !== BOB_REPAIR_APPLY_ACKNOWLEDGEMENT) {
    throw new Error(
      `apply acknowledgement must exactly equal ${BOB_REPAIR_APPLY_ACKNOWLEDGEMENT}`,
    )
  }
  return Object.freeze({
    target,
    expectedDatabase,
    mode: apply ? 'apply' : 'dry-run',
  })
}

type RepairEnvironment = Readonly<Record<string, string | undefined>>

type RepairTarget = Readonly<{
  identity: DatabaseIdentity
  projectId: string
  branchId: string
}>

function resolveProductionTarget(
  options: BobPaymentRepairOptions,
  environment: RepairEnvironment,
): RepairTarget {
  const variableName = 'PRODUCTION_DATABASE_URL_UNPOOLED'
  const identity = describeDatabaseUrl(environment[variableName] ?? '', variableName)
  if (identity.databaseName !== options.expectedDatabase) {
    throw new Error(
      `${variableName} names database ${JSON.stringify(identity.databaseName)}, `
      + `not expected database ${JSON.stringify(options.expectedDatabase)}`,
    )
  }
  const parsed = new URL(identity.databaseUrl)
  if (!['require', 'verify-ca', 'verify-full'].includes(parsed.searchParams.get('sslmode') ?? '')) {
    throw new Error(`${variableName} must use TLS with sslmode=require, verify-ca, or verify-full`)
  }
  if (identity.port !== '5432') {
    throw new Error(`${variableName} must use the proven Neon endpoint port 5432`)
  }
  if (!environment.NEON_API_KEY?.trim()) {
    throw new Error('production Bob repair requires NEON_API_KEY')
  }
  return Object.freeze({
    identity,
    projectId: requiredIdentifier(environment.NEON_PROJECT_ID, 'NEON_PROJECT_ID'),
    branchId: requiredIdentifier(
      environment.NEON_PRODUCTION_BRANCH_ID,
      'NEON_PRODUCTION_BRANCH_ID',
    ),
  })
}

async function queryRows(
  database: BobRepairQueryClient,
  statement: string,
  values: readonly unknown[] = [],
): Promise<readonly QueryRow[]> {
  return (await database.query(statement, values)).rows
}

export async function readBobRepairSnapshot(
  database: BobRepairQueryClient,
  locking = false,
): Promise<BobRepairSnapshot> {
  const residentLock = locking ? 'FOR KEY SHARE' : ''
  const attemptLock = locking ? 'FOR UPDATE OF attempt' : ''
  const historyLock = locking ? 'FOR SHARE' : ''
  const placeLock = locking ? 'FOR UPDATE' : ''
  const attemptIds = [
    BOB_REPAIR_EXPECTATIONS.coffee.attemptId,
    BOB_REPAIR_EXPECTATIONS.theBlueAI.attemptId,
  ]
  const transactionHashes = [
    BOB_REPAIR_EXPECTATIONS.coffee.txHash,
    BOB_REPAIR_EXPECTATIONS.theBlueAI.txHash,
  ]
  const repairKeys = [
    repairEventKey(BOB_REPAIR_EXPECTATIONS.coffee),
    repairEventKey(BOB_REPAIR_EXPECTATIONS.theBlueAI),
  ]

  const residents = await queryRows(database, `
    /* bob-payment-repair:residents */
    SELECT id, handle
    FROM residents
    WHERE id = $1::integer
    ${residentLock}
  `, [BOB_RESIDENT_ID])
  const attempts = await queryRows(database, `
    /* bob-payment-repair:attempts */
    SELECT attempt.public_id, attempt.actor_id, resident.handle AS resident_handle,
      attempt.counterparty_id, attempt.operation, attempt.target_key, attempt.offer_id,
      attempt.asset_type, attempt.asset_id, attempt.request_hash, attempt.request_json,
      attempt.method, attempt.network, attempt.token, attempt.payer_wallet,
      attempt.payee_wallet, attempt.amount_units::text AS amount_units,
      attempt.status, attempt.lease_owner, attempt.lease_expires_at,
      attempt.recovery_started_at, attempt.recovery_deadline_at, attempt.tx_hash,
      attempt.finalized_block_number::text AS finalized_block_number,
      attempt.finalized_block_hash, attempt.finalized_block_time, attempt.finalized_at,
      attempt.invalid_reason, attempt.updated_at, attempt.completed_at,
      clock_timestamp() AS database_now
    FROM payment_attempts attempt
    LEFT JOIN residents resident ON resident.id = attempt.actor_id
    WHERE attempt.public_id = ANY($1::text[])
    ORDER BY attempt.public_id
    ${attemptLock}
  `, [attemptIds])
  const paymentUses = await queryRows(database, `
    /* bob-payment-repair:payment-uses */
    SELECT tx_hash, payment_attempt_id, actor_id, purpose, payer_wallet,
      payee_wallet, amount_usdc::text AS amount_usdc
    FROM payment_uses
    WHERE tx_hash = ANY($1::text[]) OR payment_attempt_id = ANY($2::text[])
    ORDER BY tx_hash
    ${historyLock}
  `, [transactionHashes, attemptIds])
  const fees = await queryRows(database, `
    /* bob-payment-repair:fees */
    SELECT resident_id, purpose, amount_usdc::text AS amount_usdc, tx_hash
    FROM fees
    WHERE tx_hash = ANY($1::text[])
    ORDER BY tx_hash
    ${historyLock}
  `, [transactionHashes])
  const worldRoots = await queryRows(database, `
    /* bob-payment-repair:world-roots */
    SELECT id, name, place_kind, owner_id
    FROM places
    WHERE parent_id IS NULL OR place_kind = 'world'
    ORDER BY id
    ${placeLock}
  `)
  const places = await queryRows(database, `
    /* bob-payment-repair:places */
    SELECT id, parent_id, place_kind, name, description, owner_id,
      open_to_building, open_to_things, open_to_notes
    FROM places
    WHERE lower(name) = ANY($1::text[])
    ORDER BY id
    ${placeLock}
  `, [['coffee-shop', 'theblueai']])
  const credits = await queryRows(database, `
    /* bob-payment-repair:credits */
    SELECT resident_id, entry_kind, amount_units::text AS amount_units,
      founder_id, source_key, reason
    FROM city_credit_entries
    WHERE source_key = $1::text
    ORDER BY id
    ${historyLock}
  `, [BOB_REPAIR_CREDIT_SOURCE_KEY])
  const events = await queryRows(database, `
    /* bob-payment-repair:events */
    SELECT kind, actor, detail
    FROM events
    WHERE kind = 'payment_repair'
      AND (
        detail->>'attempt_id' = ANY($1::text[])
        OR detail->>'repair_key' = ANY($2::text[])
      )
    ORDER BY id
    ${historyLock}
  `, [attemptIds, repairKeys])

  return Object.freeze({
    residents: Object.freeze([...residents]),
    attempts: Object.freeze([...attempts]),
    paymentUses: Object.freeze([...paymentUses]),
    fees: Object.freeze([...fees]),
    worldRoots: Object.freeze([...worldRoots]),
    places: Object.freeze([...places]),
    credits: Object.freeze([...credits]),
    events: Object.freeze([...events]),
  })
}

type ClassifyTransfer = (
  txHash: string,
  to: string,
  minimum: bigint,
  options: { expectedFrom?: string; exactAmount?: boolean },
) => Promise<BobTransferEvidence>

async function classifyBobTransfers(
  classify: ClassifyTransfer,
): Promise<Readonly<Record<string, BobTransferEvidence>>> {
  const expectations = [
    BOB_REPAIR_EXPECTATIONS.coffee,
    BOB_REPAIR_EXPECTATIONS.theBlueAI,
  ] as const
  const evidence = await Promise.all(expectations.map(async expected => [
    expected.txHash,
    await classify(expected.txHash, EXPECTED_RECIPIENT, ONE_USDC_UNITS, {
      expectedFrom: EXPECTED_PAYER,
      exactAmount: true,
    }),
  ] as const))
  return Object.freeze(Object.fromEntries(evidence))
}

async function transaction<Result>(
  database: BobRepairQueryClient,
  mode: 'read-only' | 'apply',
  work: () => Promise<Result>,
): Promise<Result> {
  let started = false
  try {
    await database.query(mode === 'read-only'
      ? 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
      : 'BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE')
    started = true
    await database.query('SET LOCAL search_path = pg_catalog, public')
    await database.query("SET LOCAL statement_timeout = '30s'")
    await database.query("SET LOCAL lock_timeout = '2s'")
    await database.query("SET LOCAL idle_in_transaction_session_timeout = '45s'")
    const result = await work()
    await database.query('COMMIT')
    started = false
    return result
  } catch (error) {
    if (started) await database.query('ROLLBACK').catch(() => {})
    throw error
  }
}

function actionSignatures(plan: BobPaymentRepairPlan): string {
  return JSON.stringify(plan.actions)
}

function actionOfKind<Kind extends BobRepairAction['kind']>(
  plan: BobPaymentRepairPlan,
  kind: Kind,
): Extract<BobRepairAction, { kind: Kind }> {
  const matches = plan.actions.filter(action => action.kind === kind)
  if (matches.length !== 1) abort(`plan does not contain exactly one ${kind} action`)
  return matches[0] as Extract<BobRepairAction, { kind: Kind }>
}

async function applyWorkPlan(
  database: BobRepairQueryClient,
  operations: BobPaymentRepairApplyOperations,
  plan: BobPaymentRepairPlan,
): Promise<void> {
  await operations.completeTheBlueAI(database, actionOfKind(plan, 'complete_theblueai'))
  await operations.closeCoffeeProbe(database, actionOfKind(plan, 'close_coffee_probe'))
  await operations.issueFounderCredit(database, actionOfKind(plan, 'issue_founder_credit'))
}

function defaultClient(databaseUrl: string): BobRepairClient {
  return new Client({
    connectionString: databaseUrl,
    application_name: '1f3d9-bob-payment-repair',
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  }) as BobRepairClient
}

export function safeBobPaymentRepairError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/giu, '[redacted database URL]')
    .replace(/(?:NEON_API_KEY|authorization|x-payment|payment-response)\s*[=:]\s*[^\s]+/giu, 'credential=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
}

export async function runBobPaymentRepair(options: Readonly<{
  argv?: readonly string[]
  environment?: RepairEnvironment
  fetcher?: typeof fetch
  createClient?: (databaseUrl: string) => BobRepairClient
  classify?: ClassifyTransfer
  applyOperations?: BobPaymentRepairApplyOperations
  log?: (line: string) => void
}> = {}): Promise<BobPaymentRepairPlan> {
  const parsed = parseBobPaymentRepairArgs(options.argv ?? process.argv.slice(2))
  const environment = options.environment ?? process.env
  const target = resolveProductionTarget(parsed, environment)
  await verifyNeonDatabaseTarget(
    { projectId: target.projectId, branchId: target.branchId },
    target.identity.databaseUrl,
    environment.NEON_API_KEY!,
    'production',
    options.fetcher ?? fetch,
  )

  let client: BobRepairClient
  try {
    client = (options.createClient ?? defaultClient)(target.identity.databaseUrl)
  } catch (error) {
    throw new Error(safeBobPaymentRepairError(error))
  }
  const classify = options.classify ?? classifyUsdcTransfer
  let failure: unknown
  try {
    await client.connect()
    const preflight = await transaction(client, 'read-only', async () => {
      const snapshot = await readBobRepairSnapshot(client)
      const chainEvidence = await classifyBobTransfers(classify)
      return buildBobPaymentRepairPlan(snapshot, chainEvidence)
    })

    if (parsed.mode === 'dry-run' || preflight.state === 'no_work') {
      ;(options.log ?? console.log)(JSON.stringify(preflight))
      return preflight
    }
    const applyOperations = options.applyOperations ?? bobPaymentRepairApplyOperations

    const completed = await transaction(client, 'apply', async () => {
      const snapshot = await readBobRepairSnapshot(client, true)
      const chainEvidence = await classifyBobTransfers(classify)
      const revalidated = buildBobPaymentRepairPlan(snapshot, chainEvidence)
      if (
        revalidated.state !== 'work_required'
        || actionSignatures(revalidated) !== actionSignatures(preflight)
      ) abort('facts or proposed actions changed between dry-run and apply revalidation')

      await applyWorkPlan(client, applyOperations, revalidated)
      const resultingSnapshot = await readBobRepairSnapshot(client, true)
      const resultingPlan = buildBobPaymentRepairPlan(resultingSnapshot, chainEvidence)
      if (resultingPlan.state !== 'no_work') {
        abort('operator operations did not produce the one exact eventual result')
      }
      return resultingPlan
    })
    ;(options.log ?? console.log)(JSON.stringify(completed))
    return completed
  } catch (error) {
    failure = error
    throw new Error(safeBobPaymentRepairError(error))
  } finally {
    try {
      await client.end()
    } catch (error) {
      if (!failure) throw new Error(safeBobPaymentRepairError(error))
    }
  }
}

function isMainModule(): boolean {
  return Boolean(process.argv[1])
    && pathToFileURL(resolve(process.argv[1]!)).href === import.meta.url
}

if (isMainModule()) {
  void runBobPaymentRepair().catch(error => {
    console.error(`Bob payment repair failed: ${safeBobPaymentRepairError(error)}`)
    process.exitCode = 1
  })
}
