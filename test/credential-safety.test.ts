import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import {
  PUBLIC_CREDENTIAL_REDACTION,
  PUBLIC_RESPONSE_WITHHELD,
  containsPublicCredential,
  safeguardPublicPayload,
  sanitizePublicValue,
} from '../src/credential-safety.ts'
import { publicResponseSafety } from '../src/public-output.ts'

const credentials = [
  `1f3d9_sk_${'a1'.repeat(24)}`,
  `1f3d9_at_${'b2'.repeat(32)}`,
  `1f3d9_rt_${'c3'.repeat(32)}`,
  `1f3d9_ac_${'d4'.repeat(32)}`,
]

test('one public credential rule covers every city credential family', () => {
  for (const credential of credentials) {
    assert.equal(containsPublicCredential(credential), true)
    assert.equal(containsPublicCredential(`before ${credential} after`), true)
  }

  for (const safe of [
    'A resident key starts with 1f3d9_sk_...',
    'OAuth access tokens use the 1f3d9_at_ prefix.',
    'ordinary public text',
  ]) assert.equal(containsPublicCredential(safe), false)
})

test('historical credentials are redacted recursively without changing their records', () => {
  const source = Object.freeze({
    place: Object.freeze({ id: 2, description: `unsafe ${credentials[0]}` }),
    things: Object.freeze([
      Object.freeze({ id: 41, recipe: Object.freeze({ label: credentials[1] }) }),
    ]),
    safe: 'The 1f3d9_sk_... format is safe to explain.',
  })

  const result = sanitizePublicValue(source)

  assert.equal(result.withheld, false)
  assert.equal(result.changed, true)
  assert.deepEqual(result.value, {
    place: { id: 2, description: PUBLIC_CREDENTIAL_REDACTION },
    things: [{ id: 41, recipe: { label: PUBLIC_CREDENTIAL_REDACTION } }],
    safe: source.safe,
  })
  assert.equal(source.place.description, `unsafe ${credentials[0]}`)
  assert.equal(source.things[0]?.recipe.label, credentials[1])
  assert.notEqual(result.value, source)
})

test('safe payloads stay byte-for-byte unchanged and uncertain payloads fail closed', () => {
  const safeJson = '{"body":"A key starts with 1f3d9_sk_...","id":7}'
  assert.deepEqual(safeguardPublicPayload(safeJson, 'application/json'), {
    text: safeJson,
    changed: false,
    withheld: false,
  })

  const malformed = `{"body":"${credentials[2]}`
  const guarded = safeguardPublicPayload(malformed, 'application/json')
  assert.equal(guarded.withheld, true)
  assert.equal(guarded.changed, true)
  assert.doesNotMatch(guarded.text, new RegExp(credentials[2]!, 'i'))
  assert.match(guarded.text, new RegExp(PUBLIC_RESPONSE_WITHHELD, 'i'))

  let tooDeep: unknown = credentials[3]
  for (let depth = 0; depth < 40; depth += 1) tooDeep = { child: tooDeep }
  const deepResult = sanitizePublicValue(tooDeep)
  assert.equal(deepResult.withheld, true)
  assert.equal(deepResult.value, PUBLIC_RESPONSE_WITHHELD)
})

test('the HTTP boundary redacts public API output but preserves private identity delivery', async () => {
  const credential = credentials[0]!
  const app = new Hono()
  app.use('*', publicResponseSafety)
  app.get('/api/history', c => c.json({ id: 7, body: `historical ${credential}` }))
  app.post('/api/register', c => c.json({ secret: credential }, 201))
  app.get('/api/me', c => c.json({ private_note: `owner view ${credential}` }))
  app.post('/oauth/token', c => c.json({ access_token: credentials[1] }))

  const history = await (await app.request('/api/history')).json() as { id: number; body: string }
  assert.deepEqual(history, { id: 7, body: PUBLIC_CREDENTIAL_REDACTION })

  const registered = await (await app.request('/api/register', { method: 'POST' })).json() as {
    secret: string
  }
  assert.equal(registered.secret, credential)

  const me = await (await app.request('/api/me')).json() as { private_note: string }
  assert.equal(me.private_note, `owner view ${credential}`)

  const oauth = await (await app.request('/oauth/token', { method: 'POST' })).json() as {
    access_token: string
  }
  assert.equal(oauth.access_token, credentials[1])
})
