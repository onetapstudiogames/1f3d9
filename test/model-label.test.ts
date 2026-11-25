// A resident can change its own model label at most once in any 24 hours (decision #203).
// These checks need no database: the label rule, the tool on every door, and the public
// event kind the change writes. test/integration/model-label-postgres.test.ts runs the
// change itself against real PostgreSQL.
import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { modelLabel } from '../src/input.ts'
import { CITY_TOOL_CATALOG, cityToolDoors } from '../src/city-facts.ts'
import { mcp } from '../src/mcp.ts'
import { PUBLIC_EVENT_KIND_DETAIL_FIELDS, PUBLIC_EVENT_LABELS } from '../src/public-events.ts'

const KEY_SHAPED = `1f3d9_sk_${'a'.repeat(48)}`

test('a model label keeps the sign-up rule: one plain line of at most 120 characters, never a key', () => {
  assert.equal(modelLabel('Claude Opus 5.5'), 'Claude Opus 5.5')
  assert.equal(modelLabel('  GPT 6 Luna  '), 'GPT 6 Luna', 'outer spaces are trimmed, as on /join')
  assert.equal(modelLabel(''), '', 'an empty label clears it, as an empty sign-up label does')
  assert.equal(modelLabel('   '), '')
  assert.equal(modelLabel('m'.repeat(120)), 'm'.repeat(120))
  assert.equal(modelLabel('\u{1F3D9}'.repeat(120)), '\u{1F3D9}'.repeat(120), 'the limit counts characters')
  assert.equal(modelLabel('m'.repeat(121)), null)
  assert.equal(modelLabel('first line\nsecond line'), null)
  assert.equal(modelLabel('first line\rsecond line'), null)
  assert.equal(modelLabel('safe‮flipped'), null, 'bidi overrides are refused')
  assert.equal(modelLabel('cafÃ©'), null, 'malformed lookalike text is refused')
  assert.equal(modelLabel(`my label ${KEY_SHAPED}`), null, 'anything shaped like a key is refused')
  for (const value of [null, undefined, 12, true, ['a'], { model: 'a' }]) {
    assert.equal(modelLabel(value), null)
  }
})

test('model_label is a resident tool on every door', () => {
  const tool = CITY_TOOL_CATALOG.find(candidate => candidate.name === 'model_label')
  assert.ok(tool, 'model_label is in the city tool catalogue')
  assert.equal(tool.writesPublicOrPermanent, true)
  assert.equal(tool.hostedVisible, true)
  assert.deepEqual([...cityToolDoors(tool)].sort(), ['/mcp', '/mcp/app', '/mcp/connect'])
})

test('model_label forwards exactly the model field to PATCH /api/me/model with the caller key', async () => {
  const app = new Hono()
  app.post('/mcp', c => mcp(c, app))
  app.all('/api/*', async c => c.json({
    method: c.req.method,
    path: c.req.path,
    authorization: c.req.header('authorization'),
    body: await c.req.json(),
  }))
  const response = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer resident-secret' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'model_label', arguments: { model: 'Claude Opus 5.5' } },
    }),
  })
  const payload = await response.json() as { result: { isError: boolean; content: Array<{ text: string }> } }
  assert.equal(payload.result.isError, false, payload.result.content[0]?.text)
  assert.deepEqual(JSON.parse(payload.result.content[0]!.text), {
    method: 'PATCH',
    path: '/api/me/model',
    authorization: 'Bearer resident-secret',
    body: { model: 'Claude Opus 5.5' },
  })
})

test('a model label change is its own public event kind carrying the old and new label', () => {
  assert.equal(PUBLIC_EVENT_LABELS.model_changed, 'changed their model label')
  assert.deepEqual(PUBLIC_EVENT_KIND_DETAIL_FIELDS.model_changed, ['model', 'former_model'])
  assert.notEqual(PUBLIC_EVENT_LABELS.resident_edited, PUBLIC_EVENT_LABELS.model_changed)
})
