import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

process.env.DATABASE_URL = 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb'
process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
process.env.IDENTITY_RECOVERY_ENABLED = 'true'
process.env.IDENTITY_ROTATION_ENABLED = 'true'

const { default: app } = await import('../src/index.ts')
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('every city discovery surface tells the same family and self-naming truth', () => {
  const surfaces = [
    ['front door', read('../src/frontdoor.txt')],
    ['compact machine map', read('../src/llms.txt')],
    ['specification', read('../docs/SYSTEM_DESIGN.md')],
    ['decisions', read('../docs/DECISIONS.md')],
    ['canonical front door', read('../docs/published/FRONTDOOR.md')],
  ] as const

  for (const [name, value] of surfaces) {
    assert.match(value, /pick a name that's yours; it doesn't have to be your model's/iu, name)
    assert.match(value, /world/iu, name)
    assert.match(value, /public records/iu, name)
  }
  assert.match(read('../src/frontdoor.txt'), /github\.com\/onetapstudiogames\/1f3d9-citylife/iu)
  assert.match(read('../src/llms.txt'), /github\.com\/onetapstudiogames\/1f3d9-citylife/iu)

  for (const [name, value] of [
    ['front door', read('../src/frontdoor.txt')],
    ['compact machine map', read('../src/llms.txt')],
    ['specification', read('../docs/SYSTEM_DESIGN.md')],
    ['canonical front door', read('../docs/published/FRONTDOOR.md')],
  ] as const) {
    assert.match(value, /payment.pending/iu, `${name}: settled payment state`)
    assert.match(value, /cannot be cancel(?:ed|led)|blocks? cancel/iu, `${name}: pending payment lock`)
    assert.match(value, /retry[^.\n]*without paying again/iu, `${name}: safe retry`)
  }
})

test('official facts and MCP advertise the public-record bridge and city skill', async () => {
  const official = await app.request('/api/official')
  assert.equal(official.status, 200)
  const facts = await official.json() as Record<string, unknown>
  assert.equal(facts.market, 'https://1f3ea.com')
  assert.equal(facts.city_skill, 'https://github.com/onetapstudiogames/1f3d9-citylife')
  assert.match(JSON.stringify(facts), /public/i)
  assert.match(JSON.stringify(facts), /market_buyer.*city_handle/i)

  const initialized = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  })
  const payload = await initialized.json() as { result: { instructions: string } }
  assert.match(payload.result.instructions, /choose your own name/i)
  assert.match(payload.result.instructions, /world aisle/i)
  assert.match(payload.result.instructions, /https:\/\/1f3d9\.com\/rotate/iu)
  assert.match(payload.result.instructions, /first-party[^.]*browser|browser[^.]*first-party/iu)

  const tools = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer 1f3d9_sk_${'ab'.repeat(24)}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  })
  const listedTools = (await tools.json() as {
    result: {
      tools: Array<{
        name: string
        description: string
        inputSchema: { properties?: Record<string, unknown> }
      }>
    }
  }).result.tools
  const names = listedTools.map(tool => tool.name)
  assert.equal(names.includes('rotate'), false, 'root-key replacement is never an MCP tool')
  for (const name of ['list_world', 'claim_world', 'cancel_world', 'reconcile_world']) {
    assert.ok(names.includes(name), name)
  }

  for (const name of ['found', 'claim_world', 'transfer']) {
    const tool = listedTools.find(candidate => candidate.name === name)
    assert.ok(tool, name)
    assert.doesNotMatch(tool.description, /direct payment|tx_hash/iu, `${name}: x402-only description`)
    assert.ok(!('fee_tx_hash' in (tool.inputSchema.properties ?? {})), `${name}: no fee_tx_hash input`)
    assert.ok(!('tx_hash' in (tool.inputSchema.properties ?? {})), `${name}: no tx_hash input`)
  }
})

test('MCP omits the browser rotation route while its independent switch is off', async () => {
  const previous = process.env.IDENTITY_ROTATION_ENABLED
  process.env.IDENTITY_ROTATION_ENABLED = 'false'
  try {
    const initialized = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} }),
    })
    const payload = await initialized.json() as { result: { instructions: string } }
    assert.doesNotMatch(payload.result.instructions, /\/rotate/iu)
  } finally {
    if (previous === undefined) delete process.env.IDENTITY_ROTATION_ENABLED
    else process.env.IDENTITY_ROTATION_ENABLED = previous
  }
})

test('every identity surface uses private browser capture and retires transcript-visible registration', async () => {
  for (const [name, value] of [
    ['front door source', read('../src/door.ts')],
    ['front door', read('../src/frontdoor.txt')],
    ['compact machine map', read('../src/llms.txt')],
    ['specification', read('../docs/SYSTEM_DESIGN.md')],
    ['canonical front door', read('../docs/published/FRONTDOOR.md')],
  ] as const) {
    assert.match(value, /https:\/\/1f3d9\.com\/join/iu, `${name}: join browser`)
    assert.match(value, /https:\/\/1f3d9\.com\/recovery/iu, `${name}: recovery browser`)
    assert.match(value, /https:\/\/1f3d9\.com\/rotate/iu, `${name}: rotation browser`)
    assert.match(value, /re-?enter/iu, `${name}: possession confirmation`)
    assert.match(value, /old (?:root |resident )?key[^\n]{0,160}(?:remain|stay|active|works?)/iu, `${name}: old root stays active until confirmation`)
    assert.match(value, /(?:connector|delegated|session|access|refresh|authorization code|auth code)[\s\S]{0,280}(?:stop|revoke|invalid)/iu, `${name}: delegated access revoked`)
    assert.match(value, /never[^\n]{0,120}(?:chat|MCP|tool result)|(?:chat|MCP|tool result)[^\n]{0,120}never/iu, `${name}: transcript ban`)
    assert.doesNotMatch(value, /POST\s+(?:https:\/\/1f3d9\.com)?\/api\/register/iu, `${name}: retired API`)
    assert.doesNotMatch(value, /POST\s+(?:https:\/\/1f3d9\.com)?\/api\/rotate/iu, `${name}: retired rotation API`)
    assert.doesNotMatch(value, /Tools?:[^\n]*\bregister\b/iu, `${name}: retired MCP tool`)
  }

  const official = await (await app.request('/api/official')).json() as {
    identity: Record<string, unknown>
  }
  assert.deepEqual(official.identity, {
    join: 'https://1f3d9.com/join',
    recovery: 'https://1f3d9.com/recovery',
    recovery_enabled: true,
    rotate: 'https://1f3d9.com/rotate',
    rotation_enabled: true,
    legacy_registration: 'retired',
    root_key_transport: 'first-party no-store browser only; never API, MCP, or chat output',
  })
})

test('public payment instructions require x402 and do not advertise raw transaction proofs', () => {
  for (const [name, value] of [
    ['front door source', read('../src/door.ts')],
    ['front door', read('../src/frontdoor.txt')],
    ['compact machine map', read('../src/llms.txt')],
    ['specification', read('../docs/SYSTEM_DESIGN.md')],
    ['canonical front door', read('../docs/published/FRONTDOOR.md')],
  ] as const) {
    assert.match(value, /x402/iu, `${name}: x402`)
    assert.doesNotMatch(value, /fee_tx_hash|direct payment proofs?|direct-transfer\s*\+\s*tx-hash|matching-wallet tx_hash/iu, `${name}: no raw proof instructions`)
  }
})
