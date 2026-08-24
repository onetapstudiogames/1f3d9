import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isRetryableCollision,
  postgresErrorCode,
  postgresErrorConstraint,
  postgresErrorMessage,
} from '../src/core.ts'
import {
  jsonDocument,
  optionalBoolean,
  publicLabel,
  publicText,
  stringList,
  usdcAmount,
  worldName,
} from '../src/input.ts'
import { canFoundOrdinaryChild, isWorldRootRow } from '../src/world-root.ts'

test('JSON document limits fail closed on cycles, non-JSON values, and exact byte bounds', () => {
  assert.equal(jsonDocument(null), null)
  assert.deepEqual(jsonDocument({ a: 1 }, 7), { a: 1 })
  assert.equal(jsonDocument({ a: 1 }, 6), null)
  assert.equal(jsonDocument(undefined), null)
  assert.equal(jsonDocument(Symbol('not-json')), null)

  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.equal(jsonDocument(cyclic), null)
})

test('public input helpers cover each type, size, and optional-value boundary', () => {
  assert.equal(publicLabel(1), null)
  assert.equal(publicLabel(' label '), 'label')
  assert.equal(publicText('abcd', { maximumCharacters: 3 }), null)
  assert.equal(publicText('abc', { maximumCharacters: 3 }), 'abc')
  assert.equal(publicText('', { allowEmpty: true }), '')
  assert.equal(worldName(null), null)
  assert.equal(worldName('  Safe_Name  '), 'safe_name')

  assert.equal(usdcAmount(1.1234567), 1.123457)
  assert.equal(usdcAmount('2.5'), 2.5)
  assert.equal(usdcAmount('not-money'), null)
  assert.equal(usdcAmount(0), null)
  assert.equal(usdcAmount(10_001), null)

  assert.equal(stringList('not-a-list'), null)
  assert.equal(stringList(['a', 'b'], 1), null)
  assert.deepEqual(stringList(['safe', 'safe']), ['safe'])
  assert.equal(optionalBoolean(null), undefined)
  assert.equal(optionalBoolean(true), true)
  assert.equal(optionalBoolean('true'), null)
})

test('world-root recognition accepts only the structural transition-safe shapes', () => {
  for (const value of [null, [], 'world', 1, {}, { parent_id: 1, owner_id: null, name: 'the world' }]) {
    assert.equal(isWorldRootRow(value), false)
  }
  assert.equal(isWorldRootRow({ parent_id: null, owner_id: null }), false)
  assert.equal(isWorldRootRow({ parent_id: null, owner_id: null, place_kind: 'place' }), false)
  assert.equal(isWorldRootRow({ parent_id: null, owner_id: null, name: 'another world' }), false)
  assert.equal(isWorldRootRow({ parent_id: null, owner_id: null, place_kind: 'world' }), true)
  assert.equal(isWorldRootRow({ parent_id: null, owner_id: null, name: 'the world' }), true)
  assert.equal(isWorldRootRow({
    parent_id: null,
    owner_id: null,
    place_kind: 'world',
    name: 'the world',
  }), true)

  assert.equal(canFoundOrdinaryChild({ open_to_building: true, parent_id: 1, owner_id: 2 }), true)
  assert.equal(canFoundOrdinaryChild({
    open_to_building: true,
    parent_id: null,
    owner_id: null,
    place_kind: 'world',
  }), false)
  assert.equal(canFoundOrdinaryChild({ open_to_building: false }), false)
  assert.equal(canFoundOrdinaryChild(null), false)
})

test('Postgres error details are found only through a short trusted cause chain', () => {
  assert.equal(postgresErrorCode({ code: '40001' }), '40001')
  assert.equal(postgresErrorCode({ sourceError: { code: '40P01' } }), '40P01')
  assert.equal(postgresErrorCode('40001'), null)
  assert.equal(postgresErrorCode({ sourceError: { sourceError: { sourceError: { sourceError: { code: '40001' } } } } }), null)
  assert.equal(postgresErrorConstraint({ constraint: 'residents_handle_key' }), 'residents_handle_key')
  assert.equal(
    postgresErrorConstraint({ sourceError: { constraint: 'oauth_authorization_codes_code_hash_key' } }),
    'oauth_authorization_codes_code_hash_key',
  )
  assert.equal(postgresErrorConstraint({ code: '23505' }), null)

  assert.equal(postgresErrorMessage({ message: 'outer' }), 'outer')
  assert.equal(postgresErrorMessage({ sourceError: { message: 'inner' } }), 'inner')
  assert.equal(postgresErrorMessage(null), null)
  assert.equal(postgresErrorMessage({ sourceError: 1 }), null)
  assert.equal(postgresErrorMessage({ sourceError: { sourceError: { sourceError: { sourceError: { message: 'too deep' } } } } }), null)

  assert.equal(isRetryableCollision({ sourceError: { code: '55P03' } }), true)
  assert.equal(isRetryableCollision({ code: '22000' }), false)
  assert.equal(isRetryableCollision(null), false)
})
