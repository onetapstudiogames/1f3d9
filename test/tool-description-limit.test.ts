import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { APP_SAFETY_BLOCK_GUIDANCE, TOOL_DESCRIPTION_MAX_CHARACTERS } from '../src/city-facts.ts'
import { REFERENCE_SECTION_SLUGS } from '../src/door.ts'
import { mcp } from '../src/mcp.ts'

// Claude apps keep 2,048 characters of a tool description and add a 94-character
// "Input constraint" line to tools whose schema uses allOf, so the city serves at
// most 1,950 and the owner's safety-block sentence at the end is never cut off.
const LIMIT = 1_950

interface Door {
  label: string
  hostedChat: boolean
  authorization: boolean
}

const DOORS: Door[] = [
  { label: 'hosted signed in', hostedChat: true, authorization: true },
  { label: 'hosted anonymous', hostedChat: true, authorization: false },
  { label: 'legacy with key', hostedChat: false, authorization: true },
  { label: 'legacy without key', hostedChat: false, authorization: false },
]

async function toolsList(door: Door) {
  const previous = process.env.HOSTED_CHAT_SIGNIN_ENABLED
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  try {
    const gateway = new Hono()
    gateway.post('/mcp', c => mcp(c, new Hono(), {
      hostedChat: door.hostedChat,
      authenticateLegacyCatalog: async () => door.authorization,
    }))
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (door.authorization) headers.Authorization = 'Bearer test-only'
    const response = await gateway.request('/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(response.status, 200, door.label)
    const body = await response.json() as { result: { tools: Array<{ name: string; description: string; securitySchemes?: unknown }> } }
    return body.result.tools
  } finally {
    if (previous === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
    else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previous
  }
}

const count = (text: string) => text.split(APP_SAFETY_BLOCK_GUIDANCE).length - 1

test('the description budget constant is the 1,950-character rule', () => {
  assert.equal(TOOL_DESCRIPTION_MAX_CHARACTERS, LIMIT)
})

test('every tool description on every door fits in 1,950 characters and keeps the safety sentence once', async () => {
  const over: string[] = []
  const missing: string[] = []
  for (const door of DOORS) {
    const tools = await toolsList(door)
    assert.ok(tools.length >= 10, `${door.label} lists tools`)
    if (door.hostedChat) assert.ok(tools.every(tool => tool.securitySchemes), `${door.label} is the hosted door`)
    for (const tool of tools) {
      if (tool.description.length > LIMIT) over.push(`${door.label} ${tool.name} ${tool.description.length}`)
      if (count(tool.description) !== 1) missing.push(`${door.label} ${tool.name}`)
    }
  }
  assert.deepEqual(over, [], `descriptions over ${LIMIT} characters`)
  assert.deepEqual(missing, [], 'descriptions without the safety sentence exactly once')
})

test('every front_door section a description names is a section the front_door tool serves', async () => {
  const tools = await toolsList(DOORS[2]!)
  const named: string[] = []
  for (const tool of tools) {
    for (const match of tool.description.matchAll(/front_door sections? ([a-z0-9, -]+?)(?:\.|$)/gu)) {
      for (const slug of match[1]!.split(/,\s*(?:and\s+)?|\s+and\s+/u)) named.push(`${tool.name} ${slug.trim()}`)
    }
  }
  assert.ok(named.length >= 8, 'the shortened descriptions name their sections')
  const unknown = named.filter(entry => !REFERENCE_SECTION_SLUGS.includes(entry.split(' ')[1]!))
  assert.deepEqual(unknown, [])
})
