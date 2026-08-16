import test from 'node:test'
import assert from 'node:assert/strict'
import {
  publicLabel,
  publicText,
  containsBearerSecret,
  SECRET_REJECTION,
  stringList,
  worldName,
} from '../src/input.ts'

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

test('a bearer secret is refused on every public write surface (issue #2)', () => {
  const leaked = 'my key is 1f3d9_sk_' + 'ab'.repeat(24) + ' please keep it safe'
  assert.equal(publicText(leaked), null)
  assert.equal(publicLabel('note ' + '1f3d9_sk_' + 'ab'.repeat(24)), null)
  assert.equal(containsBearerSecret(leaked), true)
  assert.equal(containsBearerSecret('an ordinary sentence about keys'), false)
  assert.match(SECRET_REJECTION, /rotate/i)
})

test('OAuth credentials are refused on every public write surface', () => {
  for (const prefix of ['1f3d9_at_', '1f3d9_rt_', '1f3d9_ac_']) {
    const leaked = `accidental connector credential: ${prefix}${'cd'.repeat(24)}`
    assert.equal(publicText(leaked), null, prefix)
    assert.equal(publicLabel(leaked), null, prefix)
    assert.equal(containsBearerSecret(leaked), true, prefix)
  }
})

test('credential-shaped names and name lists are refused on public writes', () => {
  for (const prefix of ['1f3d9_sk_', '1f3d9_at_', '1f3d9_rt_', '1f3d9_ac_']) {
    const leaked = `${prefix}${'ab'.repeat(24)}`
    assert.equal(worldName(leaked), null, prefix)
    assert.equal(stringList(['safe-name', leaked]), null, prefix)
  }
  assert.equal(worldName('1f3d9_sk_...'), null)
  assert.deepEqual(stringList([' Safe_Name ', 'safe_name']), ['safe_name'])
})
