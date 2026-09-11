import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import {
  AGREEMENT_ACTIONS_LIMIT_LINE,
  FULL_TOOL_CATALOG_PATH,
  IDENTITY_LIMIT_LINES,
  PAYMENT_TERMINAL_STATES_LINE,
  RESIDENT_LOOKING_LIMIT_LINE,
  TOOL_DESCRIPTION_MAX_CHARACTERS,
} from '../src/city-facts.ts'
import { mcp } from '../src/mcp.ts'

type AdvertisedTool = Readonly<{
  name: string
  description: string
  inputSchema: Readonly<{
    properties?: Readonly<Record<string, Readonly<{ enum?: readonly string[] }>>>
  }>
}>

async function rpc(
  hostedChat: boolean,
  method: 'initialize' | 'tools/list',
): Promise<Record<string, unknown>> {
  const gateway = new Hono()
  gateway.post('/mcp', c => mcp(c, new Hono(), {
    hostedChat,
    authenticateLegacyCatalog: async () => true,
  }))
  const response = await gateway.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-only',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
  })
  assert.equal(response.status, 200)
  return response.json() as Promise<Record<string, unknown>>
}

async function advertisedTools(): Promise<readonly AdvertisedTool[]> {
  const payload = await rpc(false, 'tools/list') as {
    result: { tools: readonly AdvertisedTool[] }
  }
  return payload.result.tools
}

test('payment_attempt advertises only inspect and recheck as action inputs', async () => {
  const paymentAttempt = (await advertisedTools()).find(tool => tool.name === 'payment_attempt')
  assert.ok(paymentAttempt)
  const actionProperty = paymentAttempt.inputSchema.properties?.action
  assert.ok(actionProperty)
  assert.deepEqual(actionProperty.enum, ['inspect', 'recheck'])

  const sentences = paymentAttempt.description.split(/(?<=\.)\s+/u)
  const inputSentence = sentences.find(sentence => sentence.includes('accepted action inputs'))
  assert.equal(inputSentence, 'The only accepted action inputs are inspect and recheck.')
  assert.doesNotMatch(
    inputSentence,
    /wait_or_recheck|recheck_for_late_finality|await_founder_review|complete|credit_returned|closed/u,
  )

  const guidanceSentence = sentences.find(sentence => sentence.includes('next_action guidance'))
  assert.ok(guidanceSentence)
  for (const value of [
    'wait_or_recheck',
    'recheck_for_late_finality',
    'await_founder_review',
    'complete',
    'credit_returned',
    'closed',
  ]) {
    assert.match(guidanceSentence, new RegExp(`\\b${value}\\b`, 'u'))
  }
  assert.match(paymentAttempt.description, new RegExp(PAYMENT_TERMINAL_STATES_LINE, 'u'))
})

test('both initialize modes publish the canonical identity limits and full catalog', async () => {
  const previous = process.env.HOSTED_CHAT_SIGNIN_ENABLED
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  try {
    for (const hostedChat of [false, true]) {
      const payload = await rpc(hostedChat, 'initialize') as {
        result: { instructions: string }
      }
      for (const line of IDENTITY_LIMIT_LINES) {
        assert.ok(payload.result.instructions.includes(line), line)
      }
      assert.match(
        payload.result.instructions,
        new RegExp(`Full catalog: ${FULL_TOOL_CATALOG_PATH.replace('/', '\\/')}\\.`),
      )
    }
  } finally {
    if (previous === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
    else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previous
  }
})

test('agreement and looking metadata reuse canonical facts', async () => {
  const byName = new Map((await advertisedTools()).map(tool => [tool.name, tool]))
  for (const name of ['agree', 'sign', 'open_agreement_accession']) {
    assert.ok(byName.get(name)?.description.includes(AGREEMENT_ACTIONS_LIMIT_LINE), name)
  }

  for (const name of ['agree', 'browse']) {
    const description = byName.get(name)?.description ?? ''
    assert.match(description, /open means at least one named party has not signed/u, name)
    assert.match(description, /accession_open means later signers may join/u, name)
  }

  const look = byName.get('look')?.description ?? ''
  assert.match(look, /Only an authenticated resident MCP look may publish/u)
  assert.ok(look.includes(RESIDENT_LOOKING_LIMIT_LINE))
})

test('the final returned descriptions include pointers within the shared budget', async () => {
  for (const tool of await advertisedTools()) {
    assert.ok(tool.description.endsWith('front door with the front_door tool, or at https://1f3d9.com/ if your client can open URLs.'), tool.name)
    assert.match(tool.description, new RegExp(`Full catalog: ${FULL_TOOL_CATALOG_PATH.replace('/', '\\/')}\\.`), tool.name)
    assert.ok(tool.description.length <= TOOL_DESCRIPTION_MAX_CHARACTERS, `${tool.name}: ${tool.description.length}`)
  }
})
