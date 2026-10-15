import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Hono } from 'hono'
import { cityToolFacts } from '../src/city-facts.ts'
import { REFERENCE_SECTIONS } from '../src/door.ts'
import { mcp } from '../src/mcp.ts'
import * as contract from '../src/room-talk-contract.ts'

// Decision 148: a listening cue stays 20 seconds after a wait returns with an arrival or at
// its end, and every wait answer says who else is listening. These are the served words.
const LINGER = 20
const LISTENING_HERE_MAX = 20

type Door = Readonly<{ label: string; door: 'key' | 'connect' | 'app' }>
const WAIT_DOORS: readonly Door[] = [
  { label: '/mcp/connect', door: 'connect' },
  { label: '/mcp with a key', door: 'key' },
  { label: '/mcp/app', door: 'app' },
]

async function waitDescription(door: Door): Promise<string> {
  const previous = process.env.HOSTED_CHAT_SIGNIN_ENABLED
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  try {
    const gateway = new Hono()
    gateway.post('/mcp', c => mcp(c, new Hono(), {
      door: door.door,
      authenticateLegacyCatalog: async () => true,
    }))
    const response = await gateway.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-only' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(response.status, 200, door.label)
    const body = await response.json() as { result: { tools: Array<{ name: string; description: string }> } }
    const wait = body.result.tools.find(tool => tool.name === 'wait_here')
    assert.ok(wait, `${door.label} lists wait_here`)
    return wait.description
  } finally {
    if (previous === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
    else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previous
  }
}

test('the linger and the listening_here page are the owner\'s numbers, in one home', () => {
  const values = contract as Record<string, unknown>
  assert.equal(values.WAIT_CUE_LINGER_SECONDS, LINGER)
  assert.equal(values.WAIT_LISTENING_HERE_MAX, LISTENING_HERE_MAX)
  assert.equal(contract.WAIT_SECONDS_MAX, 30, 'the longest wait stays 30 seconds (decision 127)')
})

test('every door that serves wait_here says the cue lingers and names listening_here', async () => {
  for (const door of WAIT_DOORS) {
    const description = (await waitDescription(door)).replace(/\s+/gu, ' ')
    assert.ok(
      description.includes(`for ${LINGER} seconds after it returns with an arrival or at its end`),
      `${door.label} wait_here says how long the cue stays`,
    )
    assert.match(description, /a move, or a closed connection the city sees, ends it at once/iu, `${door.label} move and close`)
    assert.ok(
      description.includes(`listening_here lists up to ${LISTENING_HERE_MAX} other residents listening there`),
      `${door.label} wait_here names listening_here`,
    )
    assert.match(description, /listening_here_page/u, `${door.label} wait_here names the exact total`)
    assert.doesNotMatch(description, /While it is open, place reads/u, `${door.label} old cue sentence is gone`)
    assert.doesNotMatch(description, /\bflag|safety|security/iu, `${door.label} connector text stays plain`)
  }
})

test('the wait_here annotation note says the cue lingers', () => {
  assert.equal(
    cityToolFacts('wait_here').annotationNote,
    `A wait shows a brief public listening cue at your place while it is open and for ${LINGER} seconds after it returns with an arrival or at its end; it writes no event, line, or history.`,
  )
})

test('the reference cue paragraph says the cue lingers, keeps the move and close rules, and names listening_here', () => {
  const section = REFERENCE_SECTIONS['same-room-talk']
  assert.ok(section)
  const compact = section.replace(/\s+/gu, ' ')
  assert.ok(compact.includes(contract.TALK_WAIT_RULE), 'the wait rule paragraph is unchanged')
  assert.ok(compact.includes(
    `When a wait returns because something arrived or its seconds ended, the cue stays ${LINGER} seconds more from that return`,
  ))
  assert.ok(compact.includes(
    'A move ends the cue at once, even during those seconds, and so does the city seeing your connection close while the wait is open.',
  ))
  assert.ok(compact.includes(
    `Every wait answer also carries listening_here: the other residents listening in that place when the answer was built, each with resident_id, handle, and listening_until, at most ${LISTENING_HERE_MAX} in resident order, with listening_here_page for the exact total. You are never in your own list.`,
  ))
  assert.doesNotMatch(compact, /never outlasts the seconds you asked for/u)
  assert.doesNotMatch(compact, /The cue ends when the wait returns/u)
})

test('decision 148 is recorded and locked on the owner\'s word', () => {
  const decisions = readFileSync(new URL('../docs/DECISIONS.md', import.meta.url), 'utf8')
  assert.match(
    decisions,
    /^\| 148 \| \*\*A listening cue stays 20 seconds after a wait returns with an arrival or at its end, and every wait answer says who else is listening\.\*\*[^\n]*supersedes only #122's[^\n]*#124's[^\n]*\| LOCKED \(owner, 2026-10-15, in chat: "all good"[^\n]*"The listening mark stays 20 seconds after a wait ends"/mu,
  )
})
