import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { mcp } from '../src/mcp.ts'
import { connectorWordingHits } from './helpers/connector-wording.ts'

interface Door {
  label: string
  door: 'key' | 'connect' | 'app'
  authorization: boolean
}

// Every door, signed in and not, as tools/list and initialize serve them (decision 147).
const DOORS: Door[] = [
  { label: '/mcp with key', door: 'key', authorization: true },
  { label: '/mcp without key', door: 'key', authorization: false },
  { label: '/mcp/connect signed in', door: 'connect', authorization: true },
  { label: '/mcp/connect anonymous', door: 'connect', authorization: false },
  { label: '/mcp/app signed in', door: 'app', authorization: true },
  { label: '/mcp/app anonymous', door: 'app', authorization: false },
]

async function rpc(door: Door, method: 'initialize' | 'tools/list') {
  const previous = process.env.HOSTED_CHAT_SIGNIN_ENABLED
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  try {
    const gateway = new Hono()
    gateway.post('/mcp', c => mcp(c, new Hono(), {
      door: door.door,
      authenticateLegacyCatalog: async () => door.authorization,
    }))
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (door.authorization) headers.Authorization = 'Bearer test-only'
    const response = await gateway.request('/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
    })
    assert.equal(response.status, 200, door.label)
    return (await response.json() as { result: Record<string, unknown> }).result
  } finally {
    if (previous === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
    else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previous
  }
}

test('no tool description on any door carries app-block advice or safety wording', async () => {
  const hits: string[] = []
  for (const door of DOORS) {
    const { tools } = await rpc(door, 'tools/list') as { tools: Array<{ name: string; title: string; description: string }> }
    assert.ok(tools.length >= 10, `${door.label} lists tools`)
    for (const tool of tools) {
      hits.push(...connectorWordingHits(`${door.label} ${tool.name}`, `${tool.title} ${tool.description}`))
    }
  }
  assert.deepEqual(hits, [])
})

test('no server instructions on any door carry app-block advice or safety wording', async () => {
  const hits: string[] = []
  for (const door of DOORS) {
    const { instructions } = await rpc(door, 'initialize') as { instructions: string }
    assert.ok(instructions.length > 0, door.label)
    hits.push(...connectorWordingHits(door.label, instructions))
  }
  assert.deepEqual(hits, [])
})

test('the look description no longer says encoded bodies can look unsafe to a host', async () => {
  for (const door of DOORS) {
    const { tools } = await rpc(door, 'tools/list') as { tools: Array<{ name: string; description: string }> }
    const look = tools.find(tool => tool.name === 'look')
    assert.ok(look, door.label)
    assert.doesNotMatch(look.description, /unsafe/iu, door.label)
    assert.match(look.description, /use view=outline for a busy room/u, door.label)
  }
})
