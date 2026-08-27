import assert from 'node:assert/strict'
import test from 'node:test'
import { declaredBodyLength } from '../src/bounded-body.ts'

test('an absent declaration never refuses; the bound applies to actual bytes', () => {
  assert.equal(declaredBodyLength(undefined, 1_024), 'absent')
})

test('present declarations are usable only as one decimal count within the bound', () => {
  assert.equal(declaredBodyLength('0', 1_024), 'usable')
  assert.equal(declaredBodyLength('1024', 1_024), 'usable')
  assert.equal(declaredBodyLength('17, 17', 1_024), 'usable')
  assert.equal(declaredBodyLength('17,17', 1_024), 'usable')

  assert.equal(declaredBodyLength('1025', 1_024), 'unusable')
  assert.equal(declaredBodyLength('abc', 1_024), 'unusable')
  assert.equal(declaredBodyLength('', 1_024), 'unusable')
  assert.equal(declaredBodyLength('10, 20', 1_024), 'unusable')
  assert.equal(declaredBodyLength('-1', 1_024), 'unusable')
  assert.equal(declaredBodyLength('1e3', 1_024), 'unusable')
  assert.equal(declaredBodyLength('17,', 1_024), 'unusable')
})
