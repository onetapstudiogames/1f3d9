import assert from 'node:assert/strict'
import test from 'node:test'
import { privateKeyToAccount } from 'viem/accounts'
import {
  TEST_ACCOUNT,
  TEST_PRIVATE_KEY,
  freshWallet,
} from '../helpers/world-buy-client-fixtures/purchase-client.ts'

export function registerNewWalletTests(): void {
  test('new-wallet makes a key whose address matches it and never reuses a key', () => {
    const first = freshWallet()
    const second = freshWallet()
    assert.match(first.privateKey, /^0x[0-9a-f]{64}$/u)
    assert.equal(privateKeyToAccount(first.privateKey).address, first.address)
    assert.notEqual(first.privateKey, second.privateKey)
    const fixed = freshWallet(() => TEST_PRIVATE_KEY)
    assert.equal(fixed.address, TEST_ACCOUNT.address)
  })
}
