import assert from 'node:assert/strict'
import test from 'node:test'
import { installFakeEnvironment, SECRET } from './helpers/routes-fixtures/environment.ts'
import { installFakeFetch } from './helpers/routes-fixtures/fake-fetch.ts'
import { fixtureState } from './helpers/routes-fixtures/state.ts'

installFakeEnvironment()
installFakeFetch()
process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
process.env.HOSTED_CHAT_CIMD_ORIGINS = '["https://chat.example.test"]'
const { default: app } = await import('../src/index.ts')

const APP = '/mcp/app'
const GROK = 'grok-connectors-manager/0.1.0'
const grokHeaders = { 'User-Agent': GROK }
const initialize = { method: 'initialize' }
const list = { method: 'tools/list' }
const help = { method: 'tools/call', params: { name: 'help', arguments: {} } }
const me = { method: 'tools/call', params: { name: 'me', arguments: {} } }

function rpc(path: string, message: { method: string; params?: object }, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, ...message }),
  })
}

for (const message of [
  initialize, list, help, me,
  { method: 'ping' }, { method: 'notifications/initialized' }, { method: 'unknown' },
  { method: 'tools/call', params: { name: 'unknown' } },
]) {
  const name = 'params' in message ? message.params.name : ''
  test(`unsigned Grok receives the app resident challenge for ${message.method} ${name}`.trim(), async () => {
    const resident = await rpc(APP, me)
    assert.equal(resident.status, 401)
    const challenge = resident.headers.get('WWW-Authenticate')
    assert.ok(challenge)
    assert.ok(challenge.includes('resource_metadata="https://1f3d9.com/.well-known/oauth-protected-resource/mcp/app"'))
    assert.ok(challenge.includes('scope="city:resident"'))

    const previousCalls = fixtureState.current.calls.length
    const response = await rpc(APP, message, grokHeaders)
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('WWW-Authenticate'), challenge)
    if (message.method === 'tools/call') {
      const { result } = await response.json()
      assert.deepEqual(result._meta['mcp/www_authenticate'], [challenge])
      const logs = fixtureState.current.calls.slice(previousCalls).filter(call => call.query?.includes('mcp-call-log:insert'))
      assert.equal(logs.length, 1)
      assert.deepEqual(logs[0]?.params?.slice(4, 6), ['refused', 'auth_required'])
    }
  })
}

async function publicAnswers(path: string, headers: Record<string, string> = {}) {
  const replies = []
  for (const message of [initialize, list, help]) {
    const response = await rpc(path, message, headers)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('WWW-Authenticate'), null)
    const body = await response.text()
    if (message.method === 'tools/call') assert.equal(JSON.parse(body).result.isError, false)
    replies.push({ headers: Object.fromEntries(response.headers), body })
  }
  return replies
}

test('Grok keeps the same anonymous reads on /mcp and /mcp/connect', async () => {
  for (const path of ['/mcp', '/mcp/connect']) {
    assert.deepEqual(await publicAnswers(path, grokHeaders), await publicAnswers(path), path)
    const response = await rpc(path, me, grokHeaders)
    const resident = await rpc(path, me)
    assert.equal(response.status, path === '/mcp/connect' ? 401 : 200)
    assert.equal(response.headers.get('WWW-Authenticate'), resident.headers.get('WWW-Authenticate'))
  }
})

test('the other app callers keep their anonymous replies byte for byte', async () => {
  const expected = await publicAnswers(APP)
  for (const agent of [
    'openai-mcp/1.0.0', 'Claude-User', 'Python-urllib/3.12', 'Mozilla/5.0',
    'Gemini', 'Muse', 'probe grok-connectors-manager/0.1.0', 'grok-connectors-manager',
  ]) {
    assert.deepEqual(await publicAnswers(APP, { 'User-Agent': agent }), expected, agent)
  }
})

test('a Grok request with an Authorization header follows the usual app-door handling', async () => {
  const expected = await publicAnswers(APP)
  assert.deepEqual(await publicAnswers(APP, { ...grokHeaders, Authorization: '' }), expected)
  const authorized = { ...grokHeaders, Authorization: `Bearer ${SECRET}` }
  assert.deepEqual(await publicAnswers(APP, authorized), await publicAnswers(APP, { Authorization: authorized.Authorization }))
  const notice = await rpc(APP, {
    method: 'tools/call', params: { name: 'later_holder_items', arguments: { mode: 'later_holder_notice' } },
  }, authorized)
  assert.equal(notice.status, 200)
  const { result } = await notice.json()
  assert.equal(result.isError, false)
  assert.equal(JSON.parse(result.content[0].text).count, 1)
})
