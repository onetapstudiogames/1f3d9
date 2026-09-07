import assert from 'node:assert/strict'
import test from 'node:test'
import { recoverTypedDataAddress } from 'viem'
import { parseX402Payment, requirements } from '../../src/pay.ts'
import {
  TEST_ACCOUNT,
  TEST_NONCE,
  TEST_PRIVATE_KEY,
  buildX402PaymentHeader,
} from '../helpers/world-buy-client-fixtures/purchase-client.ts'

export function registerSignedPaymentTests(): void {
  test('world-buy builds the exact signed X-PAYMENT shape accepted by the city', async () => {
    const accepted = requirements(
      '0x1111111111111111111111111111111111111111',
      1,
      'https://city.test/api/world/offer/31/claim',
      'test world offer',
    )
    const header = await buildX402PaymentHeader({
      accepted,
      privateKey: TEST_PRIVATE_KEY,
      wallet: TEST_ACCOUNT.address,
      nonce: TEST_NONCE,
      nowSeconds: 1_786_900_000,
    })

    const parsed = parseX402Payment(header, accepted)
    assert.equal('error' in parsed, false)
    if ('error' in parsed) return
    assert.equal(parsed.authorization.payer, TEST_ACCOUNT.address.toLowerCase())

    const payment = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
      payload: {
        signature: `0x${string}`
        authorization: {
          from: `0x${string}`
          to: `0x${string}`
          value: string
          validAfter: string
          validBefore: string
          nonce: `0x${string}`
        }
      }
    }
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: accepted.extra.name,
        version: accepted.extra.version,
        chainId: 8453,
        verifyingContract: accepted.asset as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: payment.payload.authorization.from,
        to: payment.payload.authorization.to,
        value: BigInt(payment.payload.authorization.value),
        validAfter: BigInt(payment.payload.authorization.validAfter),
        validBefore: BigInt(payment.payload.authorization.validBefore),
        nonce: payment.payload.authorization.nonce,
      },
      signature: payment.payload.signature,
    })
    assert.equal(recovered.toLowerCase(), TEST_ACCOUNT.address.toLowerCase())
  })
}
