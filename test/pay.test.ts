import assert from 'node:assert/strict'
import test from 'node:test'

process.env.FACILITATOR_URL = 'https://facilitator-unit.test'

const PAYER = '0x2222222222222222222222222222222222222222'
const PAYEE = '0x1111111111111111111111111111111111111111'
const NONCE = '0x' + 'ab'.repeat(32)
const TX = '0x' + 'cd'.repeat(32)
const SIGNATURE = '0x' + 'ef'.repeat(65)

const {
  parseX402Payment,
  requirements,
  settleVerifiedX402,
  verifyX402Payment,
} = await import('../src/pay.ts')

const accepted = requirements(PAYEE, 1, 'https://1f3d9.com/api/place', 'frontier fee')

test('x402 requirements rely on the signed nonce without a custom payment identifier', () => {
  assert.equal('extensions' in accepted, false)
  assert.doesNotMatch(JSON.stringify(accepted), /payment-identifier/iu)
})

function paymentHeader(overrides: Record<string, unknown> = {}): string {
  return Buffer.from(JSON.stringify({
    x402Version: 1,
    scheme: 'exact',
    network: 'base',
    payload: {
      signature: SIGNATURE,
      authorization: {
        from: PAYER,
        to: PAYEE,
        value: '1000000',
        validAfter: '1786900000',
        validBefore: '1786907200',
        nonce: NONCE,
        ...overrides,
      },
    },
  }), 'utf8').toString('base64')
}

function parsingError(value: ReturnType<typeof parseX402Payment>): string {
  assert.ok('error' in value)
  return 'error' in value ? value.error : ''
}

test('x402 parsing binds one authorization to the exact payment terms without retaining its signature', () => {
  const parsed = parseX402Payment(paymentHeader(), accepted)

  assert.equal('error' in parsed, false)
  if ('error' in parsed) return
  assert.deepEqual(parsed.authorization, {
    payer: PAYER,
    payee: PAYEE,
    amountUnits: '1000000',
    nonce: NONCE,
    validAfter: 1_786_900_000,
    validBefore: 1_786_907_200,
    identity: parsed.authorization.identity,
    payloadDigest: parsed.authorization.payloadDigest,
  })
  assert.match(parsed.authorization.identity, /^[0-9a-f]{64}$/u)
  assert.match(parsed.authorization.payloadDigest, /^[0-9a-f]{64}$/u)
  assert.doesNotMatch(JSON.stringify(parsed.authorization), /efefefef/u)
})

test('x402 identity is stable for the same payer and nonce but the payload digest detects changed terms', () => {
  const first = parseX402Payment(paymentHeader(), accepted)
  const changed = parseX402Payment(paymentHeader({ validBefore: '1786907300' }), accepted)
  assert.equal('error' in first, false)
  assert.equal('error' in changed, false)
  if ('error' in first || 'error' in changed) return

  assert.equal(first.authorization.identity, changed.authorization.identity)
  assert.notEqual(first.authorization.payloadDigest, changed.authorization.payloadDigest)
})

test('x402 payload identity ignores harmless JSON formatting and key order changes', () => {
  const first = parseX402Payment(paymentHeader(), accepted)
  const reordered = Buffer.from(JSON.stringify({
    network: 'base',
    payload: {
      authorization: {
        nonce: NONCE,
        validBefore: '1786907200',
        value: '1000000',
        to: PAYEE,
        validAfter: '1786900000',
        from: PAYER,
      },
      signature: SIGNATURE,
    },
    scheme: 'exact',
    x402Version: 1,
  }, null, 2), 'utf8').toString('base64')
  const second = parseX402Payment(reordered, accepted)

  assert.equal('error' in first, false)
  assert.equal('error' in second, false)
  if ('error' in first || 'error' in second) return
  assert.equal(second.authorization.identity, first.authorization.identity)
  assert.equal(second.authorization.payloadDigest, first.authorization.payloadDigest)
})

test('x402 parsing rejects malformed, oversized, or mismatched authorizations before facilitator use', () => {
  assert.match(parsingError(parseX402Payment('not base64!', accepted)), /base64/u)
  assert.match(parsingError(parseX402Payment('A'.repeat(40_000), accepted)), /large/u)
  assert.match(parsingError(parseX402Payment(paymentHeader({ to: PAYER }), accepted)), /recipient/u)
  assert.match(parsingError(parseX402Payment(paymentHeader({ value: '999999' }), accepted)), /amount/u)
  assert.match(parsingError(parseX402Payment(paymentHeader({ nonce: '0x12' }), accepted)), /nonce/u)
})

test('verification is separate from settlement so a durable intent can be written between them', async () => {
  const calls: string[] = []
  const fetcher = (async (input: string | URL | Request) => {
    calls.push(String(input))
    return new Response(JSON.stringify({ isValid: true, payer: PAYER }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  const verified = await verifyX402Payment(paymentHeader(), accepted, fetcher)
  assert.equal(verified.state, 'verified')
  assert.deepEqual(calls, ['https://facilitator-unit.test/verify'])
})

test('verification accepts the optional payer field but rejects a present mismatch', async () => {
  const withoutPayer = await verifyX402Payment(paymentHeader(), accepted, (async () => new Response(
    JSON.stringify({ isValid: true }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch)
  assert.equal(withoutPayer.state, 'verified')

  const mismatched = await verifyX402Payment(paymentHeader(), accepted, (async () => new Response(
    JSON.stringify({ isValid: true, payer: PAYEE }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch)

  assert.deepEqual(mismatched, {
    state: 'invalid',
    error: 'facilitator rejected the payment',
  })
})

test('settlement preserves a transaction hash even when the facilitator reports a timeout', async () => {
  const verified = await verifyX402Payment(paymentHeader(), accepted, (async () => new Response(
    JSON.stringify({ isValid: true, payer: PAYER }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch)
  assert.equal(verified.state, 'verified')
  if (verified.state !== 'verified') return

  const settled = await settleVerifiedX402(verified, (async () => new Response(JSON.stringify({
    success: false,
    transaction: TX.toUpperCase().replace(/^0X/u, '0x'),
    payer: PAYER,
    errorReason: 'settle_exact_evm_transaction_confirmation_timed_out',
  }), { status: 500, headers: { 'content-type': 'application/json' } })) as typeof fetch)

  assert.deepEqual(settled, {
    state: 'ambiguous',
    transaction: TX,
    payer: PAYER,
    error: 'settle_exact_evm_transaction_confirmation_timed_out',
  })
})

test('facilitator response bodies are bounded and failures never become a safe fresh-payment response', async () => {
  const oversized = await verifyX402Payment(paymentHeader(), accepted, (async () => new Response(
    JSON.stringify({ isValid: true, padding: 'x'.repeat(70_000) }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch)

  assert.deepEqual(oversized, {
    state: 'unavailable',
    error: 'facilitator verification response was too large',
  })
})
