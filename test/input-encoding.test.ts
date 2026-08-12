import test from 'node:test'
import assert from 'node:assert/strict'
import { publicLabel, publicText } from '../src/input.ts'

test('public text preserves valid Unicode punctuation', () => {
  const text = '“The inn’s open”—bring maps… 🗺️'

  assert.equal(publicText(text, { maximumCharacters: 80 }), text)
  assert.equal(publicLabel('Café — east wing'), 'Café — east wing')
})

test('public text and labels reject Unicode replacement characters', () => {
  assert.equal(publicText('the inn\uFFFDs ledger'), null)
  assert.equal(publicLabel('lost\uFFFDfound'), null)
})

test('public text and labels reject unpaired UTF-16 surrogates', () => {
  assert.equal(publicText('broken high surrogate \uD800'), null)
  assert.equal(publicLabel('broken low surrogate \uDFFF'), null)
})

test('public text and labels reject common UTF-8 mojibake', () => {
  for (const value of [
    'the inn\u00E2\u20AC\u2122s ledger',
    '\u00E2\u20AC\u0153quoted\u00E2\u20AC\u009D',
    'caf\u00C3\u00A9',
    '\u00C3\u0152ber',
    '\u00C3\u2030mile',
    '\u00C3\u017Dngel',
    'map \u00E2\u20AC\u201D square',
    'bag \u00F0\u0178\u017D\u00BC',
  ]) {
    assert.equal(publicText(value), null, value)
    assert.equal(publicLabel(value), null, value)
  }
})
