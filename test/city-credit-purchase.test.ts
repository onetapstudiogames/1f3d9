import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

type PurchaseAmount = Readonly<{
  dollars: bigint
  amountUnits: bigint
}>

type PurchaseCompletion = Readonly<{
  state: string
  attemptId?: string
  status?: number
  response?: Record<string, unknown>
  responseBody?: string
  paymentResponseHeader?: string | null
}>

type CityCreditPurchaseModule = Readonly<{
  parseCityCreditPurchaseAmount(value: unknown): PurchaseAmount
  cityCreditPurchaseTargetKey(actorId: number, requestId: unknown): string
  completeCityCreditPurchase(
    database: {
      query(text: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>
    },
    input: Readonly<{ attemptId: string; leaseOwner: string }>,
  ): Promise<PurchaseCompletion>
}>

const PURCHASE_MODULE_URL = new URL('../src/city-credit-purchase.ts', import.meta.url)
const INDEX_URL = new URL('../src/index.ts', import.meta.url)

async function purchaseModule(): Promise<CityCreditPurchaseModule> {
  assert.equal(
    existsSync(PURCHASE_MODULE_URL),
    true,
    'add src/city-credit-purchase.ts for exact x402 credit purchases',
  )
  return await import(PURCHASE_MODULE_URL.href) as unknown as CityCreditPurchaseModule
}

test('whole-dollar credit purchase amounts become exact bigint USDC units', async () => {
  const { parseCityCreditPurchaseAmount } = await purchaseModule()

  assert.deepEqual(parseCityCreditPurchaseAmount('1'), {
    dollars: 1n,
    amountUnits: 1_000_000n,
  })
  assert.deepEqual(parseCityCreditPurchaseAmount('7'), {
    dollars: 7n,
    amountUnits: 7_000_000n,
  })
  assert.deepEqual(parseCityCreditPurchaseAmount('10000'), {
    dollars: 10_000n,
    amountUnits: 10_000_000_000n,
  })

  for (const value of [
    '', '0', '-1', '+1', '01', '1.0', '1.000000', '1e3', ' 1', '1 ',
    '10001', '9007199254740993', 1, 1.1, Number.NaN, Number.POSITIVE_INFINITY,
    null, undefined, {}, [],
  ]) {
    assert.throws(
      () => parseCityCreditPurchaseAmount(value),
      /whole dollar|amount|1.*10000/iu,
      String(value),
    )
  }

  const parserSource = parseCityCreditPurchaseAmount.toString()
  assert.doesNotMatch(parserSource, /Math\.round|parseFloat|parseInt|\bNumber\s*\(/u)
  assert.match(parserSource, /BigInt/u)
})

test('the purchase target is stable for exactly one authenticated buyer request', async () => {
  const { cityCreditPurchaseTargetKey } = await purchaseModule()
  const requestId = 'credit-purchase-request-0001'

  assert.equal(
    cityCreditPurchaseTargetKey(7, requestId),
    'city-credit-purchase:7:credit-purchase-request-0001',
  )
  assert.equal(
    cityCreditPurchaseTargetKey(7, requestId),
    cityCreditPurchaseTargetKey(7, requestId),
  )
  assert.notEqual(
    cityCreditPurchaseTargetKey(8, requestId),
    cityCreditPurchaseTargetKey(7, requestId),
  )
  assert.notEqual(
    cityCreditPurchaseTargetKey(7, 'credit-purchase-request-0002'),
    cityCreditPurchaseTargetKey(7, requestId),
  )

  for (const [actorId, candidate] of [
    [0, requestId],
    [-1, requestId],
    [1.5, requestId],
    [Number.MAX_SAFE_INTEGER + 1, requestId],
    [7, 'short'],
    [7, 'credit purchase spaces'],
    [7, `credit-${'x'.repeat(123)}`],
  ] as const) {
    assert.throws(() => cityCreditPurchaseTargetKey(actorId, candidate), /buyer|request|invalid/iu)
  }
})

test('credit purchase completion is one database statement and replays its exact response', async () => {
  const { completeCityCreditPurchase } = await purchaseModule()
  const attemptId = `pay_${'ab'.repeat(32)}`
  const leaseOwner = 'credit-purchase-lease-0001'
  const paymentResponseHeader = Buffer.from(JSON.stringify({
    success: true,
    transaction: `0x${'cd'.repeat(32)}`,
    payer: `0x${'12'.repeat(20)}`,
    network: 'base',
  })).toString('base64')
  const response = {
    city_fee_credit: {
      purchased: '7.000000',
      purchased_units: '7000000',
      receipt_id: '91',
    },
  }
  const responseBody = JSON.stringify(response)
  const calls: Array<{ text: string; params: readonly unknown[] }> = []
  const database = {
    query: async (text: string, params: readonly unknown[] = []) => {
      calls.push({ text, params: [...params] })
      return [{
        state: 'completed',
        attempt_id: attemptId,
        actor_id: 7,
        amount_units: '7000000',
        entry_id: '91',
        response_status: 201,
        response_json: response,
        response_body: responseBody,
        payment_response_header: paymentResponseHeader,
      }]
    },
  }

  const first = await completeCityCreditPurchase(database, { attemptId, leaseOwner })
  assert.equal(calls.length, 1, 'payment use, purchase receipt, balance, and completion must share one statement')
  assert.match(calls[0]!.text, /city-credit-purchase:complete/iu)
  assert.match(calls[0]!.text, /payment_uses/iu)
  assert.match(calls[0]!.text, /city_credit_entries/iu)
  assert.match(calls[0]!.text, /complete_payment_attempt/iu)
  assert.deepEqual(calls[0]!.params.slice(0, 2), [attemptId, leaseOwner])
  assert.equal(first.state, 'completed')
  assert.equal(first.attemptId, attemptId)
  assert.equal(first.status, 201)
  assert.deepEqual(first.response, response)
  assert.equal(first.responseBody, responseBody)
  assert.equal(first.paymentResponseHeader, paymentResponseHeader)

  const replay = await completeCityCreditPurchase(database, { attemptId, leaseOwner })
  assert.equal(calls.length, 2, 'each replay must remain one statement')
  assert.deepEqual(replay, first)
})

test('the authenticated x402 route resumes a headerless request before offering a new payment', async () => {
  assert.equal(
    existsSync(PURCHASE_MODULE_URL),
    true,
    'add src/city-credit-purchase.ts before mounting the purchase route',
  )
  const [purchaseSource, indexSource] = await Promise.all([
    readFile(PURCHASE_MODULE_URL, 'utf8'),
    readFile(INDEX_URL, 'utf8'),
  ])
  const routeSource = `${purchaseSource}\n${indexSource}`

  assert.match(routeSource, /['"]\/api\/city-credit\/purchase\/x402['"]/u)
  assert.match(routeSource, /findReplayableTargetPaymentAttempt/u)
  assert.match(routeSource, /resumeDurableX402/u)
  assert.match(routeSource, /runDurableX402/u)
  assert.match(routeSource, /challenge402/u)
  assert.match(routeSource, /cityCreditPurchaseTargetKey/u)
  assert.match(routeSource, /credit_purchase/u)

  const routeIndex = routeSource.search(/['"]\/api\/city-credit\/purchase\/x402['"]/u)
  const routeBody = routeSource.slice(routeIndex)
  const lookupIndex = routeBody.indexOf('findReplayableTargetPaymentAttempt')
  const challengeIndex = routeBody.indexOf('challenge402')
  const resumeIndex = routeBody.indexOf('resumeDurableX402')
  assert.ok(lookupIndex >= 0, 'the headerless route must look up its immutable target')
  assert.ok(
    challengeIndex > lookupIndex,
    'the route must look for a recoverable target before offering a fresh payment',
  )
  assert.ok(
    resumeIndex > lookupIndex,
    'the route must use the stored attempt when the target lookup succeeds',
  )
  assert.doesNotMatch(purchaseSource, /\btoUnits\s*\(|\brequirements\s*\(/u)
  assert.match(purchaseSource, /amountUnits\.toString\(\)/u)
})
