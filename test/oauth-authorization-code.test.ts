import assert from 'node:assert/strict'
import test from 'node:test'
import { authorizationCodeFor } from '../src/oauth-authorization-code.ts'

const SESSION = 'ab'.repeat(32)
const OTHER_SESSION = 'cd'.repeat(32)

test('an authorization code is worked out from the private browser session and the request', () => {
  const code = authorizationCodeFor(SESSION, 7)
  assert.match(code, /^1f3d9_ac_[0-9a-f]{64}$/u)
  assert.equal(authorizationCodeFor(SESSION, 7), code)
  assert.notEqual(authorizationCodeFor(OTHER_SESSION, 7), code)
  assert.notEqual(authorizationCodeFor(SESSION, 8), code)
  assert.equal(code.includes(SESSION), false)
})
