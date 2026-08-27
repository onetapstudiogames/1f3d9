import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PayPalCreditStoreConflictError,
  attachPayPalOrder,
  beginPayPalCreditIntent,
  findPayPalCreditRecipient,
  readDeliveredPayPalOrderCredit,
  recordPayPalCreditEvent,
  storePayPalCatalogProduct,
  type PayPalCreditStoreDatabase,
} from '../src/paypal-credit-store.ts'
import { deliverPayPalCredit } from '../src/paypal-credit-delivery.ts'
import {
  hashGiftClaimToken,
  parseGiftClaimToken,
} from '../src/prepaid-credit.ts'

type QueryCall = Readonly<{ text: string; params: readonly unknown[] }>

function scriptedDatabase(
  answer: (call: QueryCall) => readonly Record<string, unknown>[],
): PayPalCreditStoreDatabase & Readonly<{ calls: QueryCall[] }> {
  const calls: QueryCall[] = []
  return {
    calls,
    async query(text, params = []) {
      const call = { text, params }
      calls.push(call)
      return answer(call)
    },
  }
}

const INTENT = Object.freeze({
  requestId: 'paypal-order-request-0193',
  intentKind: 'order' as const,
  delivery: 'gift' as const,
  recipientId: 193,
  amountUnits: 3_000_000n,
  paypalEnvironment: 'sandbox' as const,
})

test('weekly allowance delivery is self-only at the core ledger boundary', async () => {
  const database = scriptedDatabase(() => assert.fail('invalid allowance gift must not reach storage'))
  await assert.rejects(
    beginPayPalCreditIntent(database, {
      requestId: 'paypal-invalid-allowance-gift-0193',
      intentKind: 'allowance',
      delivery: 'gift',
      recipientId: 193,
      amountUnits: 3_000_000n,
      paypalEnvironment: 'sandbox',
    }),
    /allowance.*self/iu,
  )
  assert.equal(database.calls.length, 0)
})

test('resident confirmation reads only the exact public number and handle', async () => {
  const database = scriptedDatabase(({ text, params }) => {
    assert.match(text, /FROM residents/iu)
    assert.deepEqual(params, [193])
    return [{ id: 193, handle: 'keeps-the-maybe' }]
  })

  assert.deepEqual(await findPayPalCreditRecipient(database, 193), {
    residentNumber: 193,
    residentHandle: 'keeps-the-maybe',
  })
})

test('a first gift intent returns one raw redirect secret while storing only its hash', async () => {
  let storedHash = ''
  const database = scriptedDatabase(({ text, params }) => {
    assert.match(text, /INSERT INTO paypal_credit_intents/iu)
    storedHash = String(params[6])
    assert.match(storedHash, /^[0-9a-f]{64}$/u)
    assert.equal(params.some(value => String(value).startsWith('gift_claim_')), false)
    return [{
      public_id: params[0], request_id: params[1], intent_kind: params[2],
      delivery: params[3], recipient_id: params[4], amount_units: params[5],
      claim_token_hash: params[6], paypal_environment: params[7],
      remote_order_id: null, remote_subscription_id: null,
      status: 'created', created: true,
    }]
  })

  const result = await beginPayPalCreditIntent(database, INTENT)

  assert.equal(result.disposition, 'created')
  assert.match(result.purchaseId, /^city_paypal_[0-9a-f]{32}$/u)
  assert.ok(result.claimToken)
  assert.equal(hashGiftClaimToken(parseGiftClaimToken(result.claimToken)), storedHash)
  assert.doesNotMatch(Object.keys(result).join(','), /buyer|payer|email/iu)
})

test('an intent request replay never reconstructs or returns the one-time gift secret', async () => {
  const database = scriptedDatabase(({ params }) => [{
    public_id: 'city_paypal_0123456789abcdef0123456789abcdef',
    request_id: params[1], intent_kind: params[2], delivery: params[3],
    recipient_id: params[4], amount_units: params[5],
    claim_token_hash: 'ab'.repeat(32), paypal_environment: params[7],
    remote_order_id: '5O190127TN364715T', remote_subscription_id: null,
    status: 'approval_pending', created: false,
  }])

  const replay = await beginPayPalCreditIntent(database, INTENT)

  assert.equal(replay.disposition, 'existing')
  assert.equal(replay.claimToken, null)
  assert.equal(replay.remoteOrderId, '5O190127TN364715T')
})

test('a request id replay with changed amount is rejected before PayPal is called', async () => {
  const database = scriptedDatabase(({ params }) => [{
    public_id: 'city_paypal_0123456789abcdef0123456789abcdef',
    request_id: params[1], intent_kind: params[2], delivery: params[3],
    recipient_id: params[4], amount_units: '2000000',
    claim_token_hash: 'ab'.repeat(32), paypal_environment: params[7],
    remote_order_id: null, remote_subscription_id: null,
    status: 'created', created: false,
  }])

  await assert.rejects(
    beginPayPalCreditIntent(database, INTENT),
    PayPalCreditStoreConflictError,
  )
})

test('resident credentials can never become durable PayPal request ids', async () => {
  const database = scriptedDatabase(() => assert.fail('credential input must not reach storage'))
  const credentials = [
    `1f3d9_sk_${'a'.repeat(48)}`,
    ...['at', 'rt', 'ac', 'rc'].map(kind => `1f3d9_${kind}_${'b'.repeat(64)}`),
  ]

  for (const credential of credentials) {
    await assert.rejects(
      beginPayPalCreditIntent(database, { ...INTENT, requestId: credential }),
      /non-secret|request_id/iu,
    )
  }
  assert.equal(database.calls.length, 0)
})

test('remote order attachment is replay-safe and rejects changed bindings', async () => {
  const database = scriptedDatabase(({ params }) => [{
    public_id: params[0], request_id: INTENT.requestId, intent_kind: 'order',
    delivery: 'self', recipient_id: INTENT.recipientId,
    amount_units: INTENT.amountUnits.toString(), claim_token_hash: null,
    paypal_environment: INTENT.paypalEnvironment, remote_order_id: params[1],
    remote_subscription_id: null, status: 'approval_pending',
  }])
  const purchaseId = 'city_paypal_0123456789abcdef0123456789abcdef'

  assert.deepEqual(await attachPayPalOrder(database, {
    purchaseId,
    orderId: '5O190127TN364715T',
  }), {
    purchaseId,
    orderId: '5O190127TN364715T',
    status: 'approval_pending',
  })

  const changed = scriptedDatabase(() => [{
    public_id: purchaseId, request_id: INTENT.requestId, intent_kind: 'order',
    delivery: 'self', recipient_id: INTENT.recipientId,
    amount_units: INTENT.amountUnits.toString(), claim_token_hash: null,
    paypal_environment: INTENT.paypalEnvironment,
    remote_order_id: 'DIFFERENT-ORDER', remote_subscription_id: null,
    status: 'approval_pending',
  }])
  await assert.rejects(
    attachPayPalOrder(changed, { purchaseId, orderId: '5O190127TN364715T' }),
    PayPalCreditStoreConflictError,
  )
})

test('ignored event and catalog records preserve one immutable remote identity', async () => {
  const eventDatabase = scriptedDatabase(({ params }) => [{
    event_id: params[0], event_kind: params[1], remote_resource_id: params[2],
    source_key: params[3], outcome: params[4], created: true, binding_count: '1',
  }])
  assert.equal((await recordPayPalCreditEvent(eventDatabase, {
    eventId: 'WH-4U497778DK455983B-1',
    eventKind: 'CHECKOUT.ORDER.APPROVED',
    remoteResourceId: '3C679366HH908993F',
    sourceKey: null,
    outcome: 'ignored',
  })).disposition, 'created')

  const catalogDatabase = scriptedDatabase(({ params }) => [{
    paypal_environment: params[0], product_id: params[1], plan_id: null,
  }])
  assert.deepEqual(await storePayPalCatalogProduct(catalogDatabase, {
    paypalEnvironment: 'sandbox',
    productId: 'PROD-6XB24663H4094933M',
  }), {
    paypalEnvironment: 'sandbox',
    productId: 'PROD-6XB24663H4094933M',
    planId: null,
  })
})

test('PayPal delivery is one database operation with exact immutable intent terms', async () => {
  const database = scriptedDatabase(({ text, params }) => {
    assert.match(text, /deliver_paypal_credit/iu)
    assert.deepEqual(params, [
      'city_paypal_0123456789abcdef0123456789abcdef',
      'gift',
      193,
      '3000000',
      'ab'.repeat(32),
      'sandbox',
      '5O190127TN364715T',
      'paypal:capture:3C679366HH908993F',
      'paypal',
      'WH-7W7265122A4531234-0',
      'PAYMENT.CAPTURE.COMPLETED',
      '3C679366HH908993F',
      params[12],
    ])
    assert.match(String(params[12]), /^city_gift_[0-9a-f]{32}$/u)
    return [{
      id: '41', resident_id: 193, amount_units: '3000000',
      source_key: 'paypal:capture:3C679366HH908993F', purchase_kind: 'paypal',
      gift_row_id: '42', gift_public_id: 'city_gift_0123456789abcdef0123456789abcdef',
      claim_token_hash: 'ab'.repeat(32), status: 'pending',
      created: false, balance_units: '0',
    }]
  })
  const result = await deliverPayPalCredit(database, {
    intent: {
      purchaseId: 'city_paypal_0123456789abcdef0123456789abcdef',
      requestId: 'paypal-order-request-0193',
      intentKind: 'order',
      delivery: 'gift',
      recipientId: 193,
      amountUnits: 3_000_000n,
      claimTokenHash: 'ab'.repeat(32),
      paypalEnvironment: 'sandbox',
      remoteOrderId: '5O190127TN364715T',
      remoteSubscriptionId: null,
      status: 'approval_pending',
    },
    sourceKey: 'paypal:capture:3C679366HH908993F',
    purchaseKind: 'paypal',
    eventId: 'WH-7W7265122A4531234-0',
    eventKind: 'PAYMENT.CAPTURE.COMPLETED',
    remoteResourceId: '3C679366HH908993F',
  })

  assert.deepEqual(result, {
    disposition: 'existing',
    receipt_id: '41',
    resident_id: 193,
    amount: '3.000000',
    amount_units: '3000000',
    purchase_kind: 'paypal',
    gift_id: 'city_gift_0123456789abcdef0123456789abcdef',
    status: 'pending',
  })
  assert.equal(database.calls.length, 1)
})

test('a captured order receipt is recovered locally without a provider source input', async () => {
  const database = scriptedDatabase(({ text, params }) => {
    assert.match(text, /read-delivered-order/iu)
    assert.deepEqual(params, ['city_paypal_0123456789abcdef0123456789abcdef'])
    return [{
      id: '41', resident_id: 193, amount_units: '3000000',
      source_key: 'paypal:capture:3C679366HH908993F', purchase_kind: 'paypal',
      gift_row_id: '42', gift_public_id: 'city_gift_0123456789abcdef0123456789abcdef',
      claim_token_hash: 'ab'.repeat(32), status: 'accepted', created: false,
      intent_delivery: 'gift', intent_recipient_id: 193, intent_amount_units: '3000000',
    }]
  })

  assert.deepEqual(await readDeliveredPayPalOrderCredit(
    database,
    'city_paypal_0123456789abcdef0123456789abcdef',
  ), {
    disposition: 'existing',
    receipt_id: '41',
    resident_id: 193,
    amount: '3.000000',
    amount_units: '3000000',
    purchase_kind: 'paypal',
    gift_id: 'city_gift_0123456789abcdef0123456789abcdef',
    status: 'pending',
  })
  assert.equal(database.calls.length, 1)
})
