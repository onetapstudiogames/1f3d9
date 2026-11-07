import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { APP_BANNED_TEXT, APP_DROPPED_TOOLS, type DoorName } from '../../src/door-profile.ts'
import {
  ENDING_MAX_CONDITIONS,
  ENDING_MAX_SECONDS,
  ENDING_MAX_USES,
  ENDING_MIN_SECONDS,
  ENDING_MIN_USES,
  ENDING_POLICY_MAX_LABELS,
  ENDING_POLICY_MIN_LABELS,
} from '../../src/engine-limits.ts'
import { MAX_AGREEMENT_THING_LINKS } from '../../src/agreement-thing-links.ts'
import { mcp } from '../../src/mcp.ts'
import { ENDING_MODES, parseEndingInput } from '../../src/thing-endings.ts'
import { ENDING_UTC_TIME_PATTERN } from '../helpers/connector-tools-fixtures/catalog-schemas.ts'

// Things ending on every door (decisions #171 to #180): the MCP schemas carry ending,
// ending_policy and thing_links the same way on the key, connect and app doors (Gemini
// reads the same catalogue), the changes tool offers thing_ended, and each tool that a
// thing's end changes says so in one short clause.

type Tool = Readonly<{ name: string; description: string; inputSchema: Record<string, any> }>

const DOORS: readonly DoorName[] = ['key', 'connect', 'app']

async function toolsOn(door: DoorName): Promise<Tool[]> {
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
    assert.equal(response.status, 200, door)
    return (await response.json() as { result: { tools: Tool[] } }).result.tools
  } finally {
    if (previous === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
    else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previous
  }
}

function tool(tools: readonly Tool[], name: string): Tool {
  const found = tools.find(entry => entry.name === name)
  assert.ok(found, `missing ${name}`)
  return found
}

// One phrase per tool that only its end clause carries; listed on every door that lists the tool.
const CLAUSES: Readonly<Record<string, readonly string[]>> = {
  make: [
    'Optional ending gives it an end its kind allows, or any end if it has no kind; the answer\'s ends shows it.',
    'Endings: front_door section things-ending.',
  ],
  thing_edit: [
    'ending sets or renews an end, free, and null clears it; a copy may only clear its end, and a thing with your later-holder mark takes none.',
    'Once the end has come the thing is a remnant: its owner can only carry, give or withdraw it.',
    'Endings: front_door section things-ending.',
  ],
  thing_upgrade: [
    'ending may set, renew or clear its end in the same upgrade, under the revision it reaches. A remnant cannot be upgraded.',
  ],
  coin_trait: [
    'with one optional wake key {on, every_seconds, then} and one optional end key {then}.',
    'Each action key, wake program or end program may weigh at most',
    'An end key runs at most once after its thing ends, with nobody acting: beyond the wake program rules it never waits, names actor, or destroys, moves or labels its own thing.',
    'Copy, write, the wake and end keys, and a convert without into_kind work only on a kind, never as a law;',
    'End keys: front_door section things-ending.',
  ],
  invent_kind: [
    'A kind may list only one trait with a wake key.',
    'It may list only one trait with an end key, too.',
    'ending_policy lists the ends owners of its things may set; it defaults to none.',
  ],
  revise_kind: [
    'an omitted description, traits, recipe, base drawing, drawing_variants, or ending_policy keeps its current value.',
    'recipe, drawing, drawing_variants, and ending_policy)',
    'A kind may list only one trait with a wake key.',
    'It may list only one trait with an end key, too.',
    'Only its inventor, while owning it, may allow more endings or change its end-key trait; another owner may keep them or allow fewer.',
  ],
  laws: ['laws refuses a trait that carries copy, write, a wake key, an end key, or a convert without into_kind'],
  agree: [
    'Optional thing_links names up to 16 things that exist and are not withdrawn, remnants included, stored for good; a link moves nothing and changes no terms.',
  ],
  transfer: [
    'A thing with an end set cannot be given until its owner clears the end, and a held gift whose giver has since set one cannot be accepted; a remnant can be given.',
  ],
  mark_for_later: ['A thing with an end set cannot be marked until you clear it, and a remnant cannot be marked.'],
  look: ["A thing read's ending says if and when it ends."],
  list_world: ['A remnant cannot be listed; a thing with an end set can, and offer reads show its end.'],
  claim_world: [
    'No reservation or payment starts once the thing\'s end has come or would come within those five minutes; that 409 can follow a signed X-PAYMENT the city never settled, and no money moved.',
  ],
  cancel_world: ['A thing_ended offer, and a market listing marked thing_ended, cancel the same way.'],
  reconcile_world: [
    'Evidence accepted before the thing\'s end still finishes: a valid payment moves the remnant whole to the buyer.',
  ],
}

// The key and connect doors say this about sale offers; the app door has no offers to say it about.
const OFFER_CLAUSE = 'A remnant cannot be offered, and a claim refuses a thing whose end has come or would come within the payment window.'

export function registerThingEndingToolTests(): void {
  test('make, thing_edit and thing_upgrade publish the same ending schema on every door', async () => {
    const key = await toolsOn('key')
    const reference = tool(key, 'thing_edit').inputSchema.properties.ending
    for (const door of DOORS) {
      const tools = await toolsOn(door)
      for (const name of ['make', 'thing_edit', 'thing_upgrade']) {
        const ending = tool(tools, name).inputSchema.properties.ending
        assert.ok(ending, `${door} ${name} ending`)
        const { description: _description, ...shape } = ending
        const { description: _referenceDescription, ...referenceShape } = reference
        assert.deepEqual(shape, referenceShape, `${door} ${name} ending shape`)
        assert.deepEqual(ending, tool(key, name).inputSchema.properties.ending, `${door} ${name} matches the key door`)
      }
      for (const name of ['invent_kind', 'revise_kind']) {
        assert.deepEqual(
          tool(tools, name).inputSchema.properties.ending_policy,
          tool(key, name).inputSchema.properties.ending_policy,
          `${door} ${name} ending_policy`,
        )
      }
      assert.deepEqual(
        tool(tools, 'agree').inputSchema.properties.thing_links,
        tool(key, 'agree').inputSchema.properties.thing_links,
        `${door} agree thing_links`,
      )
    }
  })

  test('the published end limits are the limits the city enforces', async () => {
    const tools = await toolsOn('key')
    const ending = tool(tools, 'make').inputSchema.properties.ending
    const object = ending.anyOf.find((entry: { type?: string }) => entry.type === 'object')
    const list = object.properties.any
    assert.equal(list.minItems, 1)
    assert.equal(list.maxItems, ENDING_MAX_CONDITIONS)
    const byMode = Object.fromEntries(list.items.anyOf.map((entry: { required: [string]; properties: Record<string, unknown> }) =>
      [entry.required[0], entry.properties[entry.required[0]]]))
    assert.deepEqual(Object.keys(byMode), [...ENDING_MODES])
    for (const mode of ['after_setting_seconds', 'idle_seconds']) {
      assert.deepEqual([byMode[mode].minimum, byMode[mode].maximum], [ENDING_MIN_SECONDS, ENDING_MAX_SECONDS], mode)
    }
    assert.deepEqual([byMode.uses.minimum, byMode.uses.maximum], [ENDING_MIN_USES, ENDING_MAX_USES])
    assert.equal(byMode.at.pattern, ENDING_UTC_TIME_PATTERN)

    const policy = tool(tools, 'invent_kind').inputSchema.properties.ending_policy
    assert.deepEqual(policy.properties.allowed.items.enum, [...ENDING_MODES])
    assert.deepEqual(
      [policy.properties.labels.minItems, policy.properties.labels.maxItems],
      [ENDING_POLICY_MIN_LABELS, ENDING_POLICY_MAX_LABELS],
    )
    assert.deepEqual([policy.properties.max_uses.minimum, policy.properties.max_uses.maximum], [ENDING_MIN_USES, ENDING_MAX_USES])
    assert.deepEqual(
      [policy.properties.max_seconds.minimum, policy.properties.max_seconds.maximum],
      [ENDING_MIN_SECONDS, ENDING_MAX_SECONDS],
    )
    assert.equal(tool(tools, 'agree').inputSchema.properties.thing_links.maxItems, MAX_AGREEMENT_THING_LINKS)
  })

  test('the published end time pattern accepts exactly the times the city reads', () => {
    const published = new RegExp(ENDING_UTC_TIME_PATTERN, 'u')
    const now = new Date('2026-11-07T00:00:00.000Z')
    const candidates = [
      '2026-12-31T00:00:00.000Z',
      '2026-12-31T00:00:00Z',
      '2026-12-31T00:00Z',
      '2026-12-31T00:00:00.5Z',
      '2026-12-31T00:00:00+00:00',
      '2026-12-31T00:00:00.0000Z',
      '2026-12-31T00:00:00+01:00',
      '2026-12-31',
      '2026-12-31 00:00:00Z',
      '2026-12-31T00:00:00z',
    ]
    for (const candidate of candidates) {
      let accepted: boolean
      try {
        accepted = parseEndingInput({ any: [{ at: candidate }] }, now) !== null
      } catch {
        accepted = false
      }
      assert.equal(published.test(candidate), accepted, `published pattern and the city disagree about ${candidate}`)
    }
  })

  test('the changes tool offers thing_ended as a kind on every door', async () => {
    for (const door of DOORS) {
      const kinds = tool(await toolsOn(door), 'changes').inputSchema.properties.kind.enum as string[]
      assert.ok(kinds.includes('thing_ended'), door)
    }
  })

  test('every tool a thing\'s end changes says so on every door that lists it', async () => {
    for (const door of DOORS) {
      const tools = await toolsOn(door)
      for (const [name, phrases] of Object.entries(CLAUSES)) {
        if (door === 'app' && (APP_DROPPED_TOOLS as readonly string[]).includes(name)) {
          assert.equal(tools.find(entry => entry.name === name), undefined, `app lists no ${name}`)
          continue
        }
        const { description } = tool(tools, name)
        for (const phrase of phrases) assert.ok(description.includes(phrase), `${door} ${name}: ${phrase}`)
        if (door === 'app') assert.doesNotMatch(description, APP_BANNED_TEXT, `app ${name}`)
        assert.doesNotMatch(description, /[\u2013\u2014\u2018\u2019\u201c\u201d]/u, `${door} ${name} punctuation`)
      }
      const transfer = tool(tools, 'transfer').description
      if (door === 'app') assert.ok(!transfer.includes(OFFER_CLAUSE), 'app transfer has no offer clause')
      else assert.ok(transfer.includes(OFFER_CLAUSE), `${door} transfer offer clause`)
    }
  })

  test('the coin_trait recipe field names the end key', async () => {
    for (const door of DOORS) {
      const recipe = tool(await toolsOn(door), 'coin_trait').inputSchema.properties.recipe
      assert.match(recipe.description, /one optional wake key and one optional end key/u, door)
    }
  })
}
