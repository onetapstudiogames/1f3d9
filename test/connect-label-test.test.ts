import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { type TestContext } from 'node:test'
import { Hono } from 'hono'

Object.assign(process.env, {
  DATABASE_URL: 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb',
  TREASURY_ADDRESS: '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd',
  PUBLIC_ORIGIN: 'https://1f3d9.com',
  BASE_RPC_URL: 'https://base-rpc.test',
  FACILITATOR_URL: 'https://facilitator.test',
  HOSTED_CHAT_SIGNIN_ENABLED: 'true',
  HOSTED_CHAT_CIMD_ORIGINS: '["https://chat.example.test"]',
})

const { CONNECT_LABEL_TEST_END, destructiveHintsOff, doorProfile } = await import('../src/door-profile.ts')
const { CITY_PUBLIC_TOOL_CATALOG, mcp } = await import('../src/mcp.ts')
const { default: app } = await import('../src/index.ts')

type Door = 'key' | 'connect' | 'app'
type Tool = { name: string; annotations: Record<string, unknown> }

const END = Date.parse(CONNECT_LABEL_TEST_END)
const DURING = Date.parse('2026-10-21T12:00:00Z')
const AFTER = END + 1

function at(t: TestContext, now: number): void {
  t.mock.timers.enable({ apis: ['Date'], now })
}

/** The raw JSON-RPC answer text, so a comparison is byte for byte. */
async function rpcText(door: Door, method: string, signedIn = true): Promise<string> {
  const gateway = new Hono()
  gateway.post('/mcp', c => mcp(c, new Hono(), { door, authenticateLegacyCatalog: async () => signedIn }))
  const response = await gateway.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-only' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
  })
  return response.text()
}

async function toolsOn(door: Door): Promise<Tool[]> {
  return (JSON.parse(await rpcText(door, 'tools/list')) as { result: { tools: Tool[] } }).result.tools
}

test('the dated test is on /mcp/connect only and ends at 2026-11-03T23:59:59Z', () => {
  assert.equal(CONNECT_LABEL_TEST_END, '2026-11-03T23:59:59Z')
  assert.equal(destructiveHintsOff(doorProfile('connect'), DURING), true)
  assert.equal(destructiveHintsOff(doorProfile('connect'), END), true)
  assert.equal(destructiveHintsOff(doorProfile('connect'), AFTER), false)
  for (const door of ['key', 'app'] as const) {
    assert.equal(destructiveHintsOff(doorProfile(door), DURING), false, door)
  }
})

test('during the test /mcp/connect lists every tool with destructiveHint false and every other byte as after it', async t => {
  at(t, AFTER)
  const after = await rpcText('connect', 'tools/list')
  const afterInit = await rpcText('connect', 'initialize')
  t.mock.timers.setTime(DURING)
  const during = await rpcText('connect', 'tools/list')
  assert.equal(await rpcText('connect', 'initialize'), afterInit)

  const afterTools = (JSON.parse(after) as { result: { tools: Tool[] } }).result.tools
  const duringTools = (JSON.parse(during) as { result: { tools: Tool[] } }).result.tools
  assert.equal(duringTools.length, 43)
  assert.equal(duringTools.length, afterTools.length)
  for (const tool of duringTools) assert.equal(tool.annotations.destructiveHint, false, tool.name)
  assert.ok(afterTools.some(tool => tool.annotations.destructiveHint === true))
  // Put the decision 135 labels back and the answer is the after-test answer, byte for byte.
  const restored = duringTools.map((tool, index) => ({
    ...tool,
    annotations: { ...tool.annotations, destructiveHint: afterTools[index]!.annotations.destructiveHint },
  }))
  assert.equal(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: restored } }), after)
})

test('readOnlyHint on /mcp/connect during the test is the catalogue value', async t => {
  at(t, DURING)
  const facts = new Map(CITY_PUBLIC_TOOL_CATALOG.map(tool => [tool.name, tool.annotations]))
  for (const tool of await toolsOn('connect')) {
    assert.equal(tool.annotations.readOnlyHint, facts.get(tool.name)!.readOnlyHint, tool.name)
    assert.equal(tool.annotations.idempotentHint, facts.get(tool.name)!.idempotentHint, tool.name)
    assert.equal(tool.annotations.openWorldHint, facts.get(tool.name)!.openWorldHint, tool.name)
  }
})

test('/mcp with and without a key and /mcp/app answer byte for byte the same during the test as after it', async t => {
  const cases = [['key', true], ['key', false], ['app', true]] as const
  at(t, AFTER)
  const after = await Promise.all(cases.flatMap(([door, signedIn]) => [
    rpcText(door, 'tools/list', signedIn), rpcText(door, 'initialize', signedIn),
  ]))
  t.mock.timers.setTime(DURING)
  const during = await Promise.all(cases.flatMap(([door, signedIn]) => [
    rpcText(door, 'tools/list', signedIn), rpcText(door, 'initialize', signedIn),
  ]))
  assert.deepEqual(during, after)
  // And those doors keep the catalogue's labels, so they are what main served.
  const facts = new Map(CITY_PUBLIC_TOOL_CATALOG.map(tool => [tool.name, tool.annotations]))
  for (const tool of await toolsOn('key')) {
    assert.deepEqual(tool.annotations, facts.get(tool.name), tool.name)
  }
  const app = await toolsOn('app')
  assert.equal(app.length, 36)
  assert.ok(app.some(tool => tool.annotations.destructiveHint === true))
})

test('after the end /mcp/connect is back to the decision 135 labels with no deploy', async t => {
  at(t, AFTER)
  const facts = new Map(CITY_PUBLIC_TOOL_CATALOG.map(tool => [tool.name, tool.annotations]))
  const tools = await toolsOn('connect')
  for (const tool of tools) assert.deepEqual(tool.annotations, facts.get(tool.name), tool.name)
  assert.equal(tools.filter(tool => tool.annotations.destructiveHint === true).length, 22)
})

test('the public catalogue keeps the decision 135 labels during the test', async t => {
  at(t, DURING)
  const catalog = await (await app.request('/api/tools')).json() as { tools: Tool[] }
  assert.deepEqual(
    catalog.tools.map(tool => [tool.name, tool.annotations.destructiveHint]),
    CITY_PUBLIC_TOOL_CATALOG.map(tool => [tool.name, tool.annotations.destructiveHint]),
  )
})

test('the decision row, the door doc, and the task list name the same end date', () => {
  const decisions = readFileSync(new URL('../docs/DECISIONS.md', import.meta.url), 'utf8')
  const row = decisions.split('\n').find(line => /^\| \d+ \| \*\*On `\/mcp\/connect` only/u.test(line))
  assert.ok(row, 'the decision row for the connect label test')
  assert.match(row, /2026-11-03/u)
  assert.match(row, /LOCKED/u)
  assert.match(readFileSync(new URL('../docs/features/APP_DOOR.md', import.meta.url), 'utf8'), /2026-11-03/u)
  assert.match(readFileSync(new URL('../docs/TASKS.md', import.meta.url), 'utf8'), /2026-11-04[^\n]*connect/u)
})
