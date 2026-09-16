import assert from 'node:assert/strict'
import test from 'node:test'
import { CITY_FEE_CREDIT_UNITS, formatUsdcUnits, parseCityCreditRequestId, suggestCityCreditRequestId } from '../../src/city-credit.ts'
import { CREDIT_REQUEST_ID_SHAPE_REFUSAL } from '../../src/city-fee-facts.ts'

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

  test('a number or balance-shaped request id is refused in caller words', () => {
    for (const value of [
      '1.000000',
      '12345678',
      '00000000',
      '0.000001',
      '123456789012',
      '1000000.5',
    ]) {
      assert.throws(
        () => parseCityCreditRequestId(value),
        (error: unknown) => {
          assert.ok(error instanceof TypeError, JSON.stringify(value))
          assert.equal(error.message, CREDIT_REQUEST_ID_SHAPE_REFUSAL)
          return true
        },
        JSON.stringify(value),
      )
    }
    assert.match(CREDIT_REQUEST_ID_SHAPE_REFUSAL, /credit_preflight suggests one/u)
  })

  test('a suggested request id is fresh, safe, and accepted by the validator', () => {
    const first = suggestCityCreditRequestId()
    const second = suggestCityCreditRequestId()
    assert.notEqual(first, second)
    for (const suggestion of [first, second]) {
      assert.ok(suggestion.length >= 8 && suggestion.length <= 128, suggestion)
      assert.match(suggestion, /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u)
      assert.equal(parseCityCreditRequestId(suggestion), suggestion)
    }
  })
}
