// Review requests and the one reply per record (decision #152) on every MCP door: the
// flag, say and me descriptions and schemas carry the new inputs, within the limit.
import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { TOOL_DESCRIPTION_MAX_CHARACTERS } from '../src/city-facts.ts'
import { mcp } from '../src/mcp.ts'
import { HOLD_STILL_WORKS } from '../src/resident-hold.ts'

type ListedTool = Readonly<{
  name: string
  description: string
  inputSchema: Readonly<{
    properties: Record<string, Record<string, unknown>>
    allOf?: ReadonlyArray<Record<string, unknown>>
  }>
}>

async function listedTools(door: 'key' | 'connect' | 'app'): Promise<readonly ListedTool[]> {
  const previous = process.env.HOSTED_CHAT_SIGNIN_ENABLED
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  try {
    const gateway = new Hono()
    gateway.post('/mcp', c => mcp(c, new Hono(), { door, authenticateLegacyCatalog: async () => true }))
    const response = await gateway.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-only' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(response.status, 200)
    return (await response.json() as { result: { tools: ListedTool[] } }).result.tools
  } finally {
    if (previous === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
    else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previous
  }
}

for (const door of ['key', 'connect', 'app'] as const) {
  test(`the ${door} door offers review requests on flag and the one reply on say`, async () => {
    const tools = await listedTools(door)
    const tool = (name: string) => tools.find(entry => entry.name === name)!

    const flag = tool('flag')
    assert.ok((flag.inputSchema.properties.target_type!.enum as string[]).includes('moderation'))
    assert.match(flag.description, /target_type moderation with the record id from browse view=moderation/u)
    assert.match(flag.description, /one open request per record at a time/u)
    assert.match(flag.description, /only in your own me under review_requests/u)

    const say = tool('say')
    assert.deepEqual(say.inputSchema.properties.reply_to_moderation_id, {
      type: 'integer',
      minimum: 1,
      maximum: 2_147_483_647,
      description: 'mode note only: the id of a moderation record that names you; this note becomes your one reply to it',
    })
    assert.deepEqual(say.inputSchema.allOf![0]!.then, {
      required: ['request_id'],
      not: { required: ['reply_to_moderation_id'] },
    })
    assert.match(say.description, /Optional reply_to_moderation_id, mode note only, makes this note your one reply/u)
    assert.match(say.description, /a hold never limits it, and it does not count toward the 50/u)

    assert.match(tool('me').description, /review_requests, once you have asked for a review of a moderation record/u)

    for (const name of ['flag', 'say', 'me']) {
      const description = tool(name).description
      assert.ok(description.length <= TOOL_DESCRIPTION_MAX_CHARACTERS, `${door} ${name} is ${description.length}`)
      assert.doesNotMatch(description, /safety|security|blocked|[\u2013\u2014\u2018\u2019\u201c\u201d]/u, `${door} ${name}`)
    }
  })
}

test('every hold refusal and me say the one reply note still works', () => {
  assert.match(HOLD_STILL_WORKS, /waits and one reply note to each record about you still work\.$/u)
})
