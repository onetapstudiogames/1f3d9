import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Hono } from 'hono'
import { APP_SAFETY_BLOCK_GUIDANCE } from '../src/city-facts.ts'
import { FRONTDOOR, LLMS, REFERENCE, REFERENCE_SECTIONS } from '../src/door.ts'
import { mcp } from '../src/mcp.ts'

// Decision 147: the owner's one sentence, once, in the reference only.
const SENTENCE = 'A blocked call never reached the city; never reword to get past a filter.'
const TOKEN = '{{APP_SAFETY_BLOCK}}'

const count = (text: string, part: string = SENTENCE) => text.split(part).length - 1

async function rpc(door: 'key' | 'connect' | 'app', method: 'initialize' | 'tools/list') {
  const previous = process.env.HOSTED_CHAT_SIGNIN_ENABLED
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  try {
    const gateway = new Hono()
    gateway.post('/mcp', c => mcp(c, new Hono(), { door, authenticateLegacyCatalog: async () => true }))
    const response = await gateway.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-only' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
    })
    assert.equal(response.status, 200)
    return (await response.json() as { result: Record<string, unknown> }).result
  } finally {
    if (previous === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
    else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previous
  }
}

test('the app-block sentence is the owner\'s exact words in plain punctuation', () => {
  assert.equal(APP_SAFETY_BLOCK_GUIDANCE, SENTENCE)
  assert.doesNotMatch(SENTENCE, /[\u2013\u2014\u2018\u2019\u201c\u201d]/u)
})

test('only the reference source carries the sentence token, once', () => {
  assert.equal(count(readFileSync(new URL('../src/reference.txt', import.meta.url), 'utf8'), TOKEN), 1, 'reference.txt')
  assert.equal(count(readFileSync(new URL('../src/frontdoor.txt', import.meta.url), 'utf8'), TOKEN), 0, 'frontdoor.txt')
  assert.equal(count(readFileSync(new URL('../src/llms.txt', import.meta.url), 'utf8'), TOKEN), 0, 'llms.txt')
})

test('the reference and its first-calls page carry the sentence once; the front door and llms.txt never', () => {
  assert.equal(count(REFERENCE), 1, 'reference')
  assert.equal(count((REFERENCE_SECTIONS as Record<string, string>).mcp ?? ''), 1, 'reference mcp page')
  assert.equal(count(FRONTDOOR), 0, 'front door')
  assert.equal(count(LLMS), 0, 'llms.txt')
  const firstCalls = REFERENCE.slice(REFERENCE.indexOf('YOUR FIRST CALLS'), REFERENCE.indexOf('WHICH TOOLS EACH DOOR LISTS'))
  assert.equal(count(firstCalls), 1, 'the sentence sits in YOUR FIRST CALLS')
})

test('no tool description and no server instructions on any door carry the sentence', async () => {
  for (const door of ['key', 'connect', 'app'] as const) {
    const { tools } = await rpc(door, 'tools/list') as { tools: Array<{ name: string; description: string }> }
    assert.ok(tools.length >= 36, door)
    for (const tool of tools) assert.equal(count(tool.description), 0, `${door} ${tool.name}`)
    const { instructions } = await rpc(door, 'initialize') as { instructions: string }
    assert.equal(count(instructions), 0, door)
  }
})
