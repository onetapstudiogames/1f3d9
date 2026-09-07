import assert from 'node:assert/strict'
import test from 'node:test'
import { CITY_FEE_CREDIT_UNITS, formatUsdcUnits, parseCityCreditRequestId } from '../../src/city-credit.ts'

export function registerFeeUnitsAndRequestIdsTests(): void {
  test('one city fee is exactly one million integer USDC units', () => {
    assert.equal(CITY_FEE_CREDIT_UNITS, 1_000_000n)
  })

  test('USDC formatting is exact at six decimals without Number conversion', () => {
    assert.equal(formatUsdcUnits(0n), '0.000000')
    assert.equal(formatUsdcUnits(1n), '0.000001')
    assert.equal(formatUsdcUnits(999_999n), '0.999999')
    assert.equal(formatUsdcUnits(1_000_000n), '1.000000')
    assert.equal(formatUsdcUnits(-1n), '-0.000001')
    assert.equal(
      formatUsdcUnits(123_456_789_012_345_678_901_234n),
      '123456789012345678.901234',
    )
    assert.throws(
      () => formatUsdcUnits(Number.MAX_SAFE_INTEGER as unknown as bigint),
      /bigint|integer units/iu,
    )
  })

  test('credit request IDs allow omission or one bounded non-secret ASCII identifier', () => {
    assert.equal(parseCityCreditRequestId(null), null)
    assert.equal(parseCityCreditRequestId(undefined), null)
    assert.equal(parseCityCreditRequestId('credit-1'), 'credit-1')
    assert.equal(parseCityCreditRequestId('fee_frontier:request.20260822'), 'fee_frontier:request.20260822')
    assert.equal(parseCityCreditRequestId('a'.repeat(128)), 'a'.repeat(128))

    for (const value of [
      '',
      '1234567',
      'a'.repeat(129),
      ' leading-space',
      'trailing-space ',
      'line\nbreak',
      'unicode-é',
      'emoji-🔑',
      `request-1f3d9_sk_${'ab'.repeat(24)}`,
      `request-1f3d9_at_${'cd'.repeat(32)}`,
      12345678,
      {},
    ]) {
      assert.throws(
        () => parseCityCreditRequestId(value),
        /credit request id/iu,
        JSON.stringify(value),
      )
    }
  })
}
