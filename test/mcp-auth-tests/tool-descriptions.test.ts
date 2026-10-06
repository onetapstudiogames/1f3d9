import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { mcp } from '../../src/mcp.ts'
import { PUBLIC_EVENT_KINDS } from '../../src/public-events.ts'
import { REFERENCE_SECTIONS } from '../../src/door.ts'
import {
  LEGACY_SECRET,
  OAUTH_ACCESS_TOKEN,
  setHostedChatFlag,
  createHarness,
  rpc,
  listTools,
  toolByName,
} from '../helpers/mcp-auth-fixtures/fixture.ts'
import type {
  ToolResult,
} from '../helpers/mcp-auth-fixtures/fixture.ts'

// The owner's two wait sentences (2026-09-28): a wait only listens, and an empty timeout means wait again.
const WAIT_ONLY_LISTENS = 'It only listens: it says nothing, spends nothing, and changes nothing lasting.'
const WAIT_AGAIN = 'A timeout answer brings no lines or pings and only means nothing arrived yet, so call wait_here again at once to keep listening, as often as you like; waiting again has no limit.'
// Decision 135: destructiveHint is true only for a tool whose own write can delete, overwrite, spend, or transfer.
const EXPECTED_DESTRUCTIVE_HINTS: Readonly<Record<string, boolean>> = Object.freeze({
  front_door: false, help: false, official_facts: false, physics: false, search: false, changes: false,
  look: false, browse: false, drawing: false, drawing_history: false, credit_preflight: false,
  buy_credit: true, found: true, place_edit: true, coin_trait: false, invent_kind: true, revise_kind: true,
  make: true, thing_edit: true, thing_upgrade: true, draw_self: true, act: true, laws: true, home: true,
  withdraw: true, list_world: true, claim_world: true, cancel_world: true, reconcile_world: true,
  credit_gift: true, payment_attempt: true, transfer: true, agree: false, open_agreement_accession: false,
  sign: false, say: false, ping: false, wait_here: false, read_here: false, flag: false,
  later_holder_items: false, mark_for_later: true, me: true, moderate: true,
})

export function registerToolDescriptionTests(): void {
  test('browse states where to read the live Gazette submission and withdrawal gates', async () => {
    setHostedChatFlag(true)
    const { gateway } = createHarness()
    const browse = toolByName(await listTools(gateway, '/mcp/connect', `Bearer ${OAUTH_ACCESS_TOKEN}`), 'browse')

    assert.match(
      browse.description,
      /Gazette without issue_number[\s\S]*submission_room[\s\S]*complete withdrawal_contract/iu,
    )
    assert.match(browse.description, /Room #454[\s\S]*browse with view=gazette and no issue_number/iu)
  })

  test('MCP descriptions state enforced caller contracts before use', async () => {
    for (const [hosted, path, authorization] of [
      [true, '/mcp/connect', `Bearer ${OAUTH_ACCESS_TOKEN}`],
      [false, '/mcp', `Bearer ${LEGACY_SECRET}`],
    ] as const) {
      setHostedChatFlag(hosted)
      const { gateway } = createHarness()
      const tools = await listTools(gateway, path, authorization)
      const search = toolByName(tools, 'search')
      const look = toolByName(tools, 'look')
      const found = toolByName(tools, 'found')
      const make = toolByName(tools, 'make')
      const act = toolByName(tools, 'act')
      const laws = toolByName(tools, 'laws')
      const listWorld = toolByName(tools, 'list_world')
      const withdraw = toolByName(tools, 'withdraw')
      const transfer = toolByName(tools, 'transfer')
      const flag = toolByName(tools, 'flag')
      const drawSelf = toolByName(tools, 'draw_self')
      const agree = toolByName(tools, 'agree')
      const sign = toolByName(tools, 'sign')
      const me = toolByName(tools, 'me')
      const waitHere = toolByName(tools, 'wait_here')
      const coinTrait = toolByName(tools, 'coin_trait')
      const waitSeconds = waitHere.inputSchema.properties?.seconds as {
        minimum?: unknown
        maximum?: unknown
        default?: unknown
      }

      assert.match(search.description, /defaults are mode=words, type=all, and limit=10/iu, `${path}: search defaults`)
      assert.match(search.description, /256 UTF-8 bytes[\s\S]*16 simple words[\s\S]*burst 12[\s\S]*one search every 5 seconds/iu, `${path}: search limits`)
      assert.match(
        String((search.inputSchema.properties?.q as { description?: string }).description ?? ''),
        /1 to 256 UTF-8 bytes/iu,
        `${path}: q byte limit`,
      )
      assert.match(look.description, /GET \/api\/place\/:id[^.]*look place read default to outline/iu, `${path}: place-read defaults`)
      assert.match(found.description, /name[^.]*1[^.]*120/iu, `${path}: found name limit`)
      assert.match(found.description, /description[^.]*4,?000/iu, `${path}: found description limit`)
      assert.match(found.description, /defaults?[^.]*closed[^.]*notes[^.]*things[^.]*building/iu, `${path}: found permission defaults`)
      for (const key of ['open_to_building', 'open_to_things', 'open_to_notes'] as const) {
        assert.equal(
          (found.inputSchema.properties?.[key] as { default?: unknown }).default,
          false,
          `${path}: found ${key} default`,
        )
      }
      assert.match(make.description, /standing in place_id/iu, `${path}: make standing requirement`)
      assert.match(make.description, /name[^.]*1[^.]*120/iu, `${path}: make name limit`)
      assert.match(make.description, /open_to_use[^.]*defaults? false/iu, `${path}: make open_to_use default`)
      assert.match(make.description, /ingredient_ids[^.]*empty unless kind_id/iu, `${path}: kindless ingredient rule`)
      assert.match(make.description, /crafted makes return consumed_ingredient_ids[^.]*kindless makes omit/iu, `${path}: make response shape`)
      assert.match(make.description, /Room #454[\s\S]*browse with view=gazette and no issue_number/iu, `${path}: protected make destination`)
      assert.equal(
        (make.inputSchema.properties?.open_to_use as { default?: unknown }).default,
        false,
        `${path}: make schema default`,
      )
      assert.match(
        act.description,
        /move accepts only its required to_place_id and optional carry_thing_id/iu,
        `${path}: move shape`,
      )
      assert.match(act.description, /closed to visitor things it is held[^.]*follows your next move or go_home[^.]*cannot be left behind/iu,
        `${path}: held thing follows the mover`)
      assert.match(act.description, /front_door sections action-requests and kinds-traits-physics/u, `${path}: act names its reference`)
      // Decision 137: the whole carry contract lives in the reference section act points to.
      const actionRequests = (REFERENCE_SECTIONS as Record<string, string>)['action-requests'] ?? ''
      assert.match(
        actionRequests,
        /yours, and in the place being left\. Carry refuses an open sale\s+offer or market lock, another resident's later-holder mark, or a moderation hold/u,
        'reference: carry gates',
      )
      assert.match(actionRequests, /carry one owned thing into any place, including the world/iu, 'reference: carry crosses closed places and the world')
      assert.match(actionRequests, /held thing cannot be left behind; carry it with your next move or go home/iu, 'reference: held thing cannot be left behind')
      assert.match(actionRequests, /Gazette room #454[^.]*held even for its owner/iu, 'reference: Gazette remains held')
      assert.match(
        String((act.inputSchema.properties?.carry_thing_id as { description?: string }).description ?? ''),
        /one owned thing[^.]*moves with you/iu,
        `${path}: carry schema`,
      )
      assert.match(act.description, /use and consume require thing_id/iu, `${path}: thing action shapes`)
      assert.match(act.description, /may also take target_type with target_id, to_place_id, or to_handle/iu, `${path}: effect inputs`)
      assert.match(act.description, /give accepts only required to_handle[\s\S]*thing_id[\s\S]*target_type with target_id/iu, `${path}: give shape`)
      assert.match(act.description, /target_type and target_id always appear together/iu, `${path}: target pair`)
      for (const [name, description] of [
        ['act', act.description],
        ['found', found.description],
        ['laws', laws.description],
      ] as const) {
        assert.match(description, /Room #454[\s\S]*browse with view=gazette and no issue_number/iu, `${path}: protected ${name}`)
      }
      assert.match(act.description, /active[\s\S]*same place[\s\S]*open sale/iu, `${path}: thing state gates`)
      assert.match(act.description, /GET \/api\/physics[^.]*pending-effect safety ceilings/iu, `${path}: effect ceilings`)
      assert.match(listWorld.description, /thing[^.]*owned by you[^.]*not withdrawn[^.]*unlocked/iu, `${path}: world thing state`)
      assert.match(listWorld.description, /draft[^.]*pending[^.]*unexpired[^.]*unlisted/iu, `${path}: world draft state`)
      assert.match(transfer.description, /omitting action defaults to give/iu, `${path}: transfer default`)
      assert.match(transfer.description, /reserve[\s\S]*before payment/iu, `${path}: claim order`)
      assert.match(transfer.description, /greater than 0[\s\S]*10,000[\s\S]*6 decimal/iu, `${path}: price contract`)
      assert.match(transfer.description, /place[\s\S]*nested places[\s\S]*move with it/iu, `${path}: nested place gift`)
      assert.match(transfer.description, /home[\s\S]*cleared/iu, `${path}: transferred home`)
      assert.deepEqual(transfer.inputSchema.properties?.price_usdc, {
        type: 'number', exclusiveMinimum: 0, maximum: 10_000,
        description: 'sale price in USDC; rounded to 6 decimal places',
      }, `${path}: price schema`)
      assert.deepEqual(withdraw.inputSchema.required, ['thing_id', 'thing_name'], `${path}: withdraw confirmation`)
      assert.match(withdraw.description, /exact current name/iu, `${path}: withdraw confirmation`)
      assert.match(flag.description, /target must exist/iu, `${path}: flag target existence`)
      assert.match(drawSelf.description, /\bdrawing\b[\s\S]*\bdrawing_history\b/iu, `${path}: prior drawing reads`)
      assert.match(laws.description, /every named trait[^.]*already exist/iu, `${path}: laws trait existence`)
      assert.match(laws.description, /trimmed[^.]*lowercased/iu, `${path}: laws normalization`)
      assert.match(laws.description, /duplicates[^.]*fail/iu, `${path}: laws duplicate rule`)
      assert.match(agree.description, /1[^.]*32 unique valid resident handles/iu, `${path}: agreement parties`)
      assert.match(agree.description, /already exist/iu, `${path}: agreement party existence`)
      assert.match(agree.description, /1 byte[^.]*64 KB[^.]*safe/iu, `${path}: agreement body limit`)
      assert.match(sign.description, /repeat[^.]*existing signature[^.]*without spending another agreement action[^.]*changing signed_at/iu, `${path}: signature replay`)
      assert.equal(
        (agree.inputSchema.properties?.parties as { uniqueItems?: unknown }).uniqueItems,
        true,
        `${path}: agreement unique parties`,
      )
      assert.match(me.description, /owned places with thing and note counts/iu, `${path}: me place counts`)
      assert.match(me.description, /front_door sections money, abilities and gazette\./u, `${path}: me reference`)
      assert.equal(waitSeconds.minimum, 1, `${path}: wait seconds minimum`)
      assert.equal(waitSeconds.maximum, 30, `${path}: wait seconds maximum`)
      assert.equal(Object.hasOwn(waitSeconds, 'default'), false, `${path}: wait seconds has no default`)
      assert.ok(
        waitHere.description.startsWith(`Wait once in the place where you stand for the next line there or a ping that names you: an invitation to you or an answer to yours. ${WAIT_ONLY_LISTENS} A wait lasts `),
        `${path}: wait says first that it only listens`,
      )
      assert.ok(
        waitHere.description.includes(`or leave both out to start from now. ${WAIT_AGAIN} While it is open,`),
        `${path}: wait says an empty timeout means wait again`,
      )
      assert.ok(
        coinTrait.description.includes("A step's then is required on check_label, chance, wait, and reach, its else is allowed only on check_label and chance, and every other brick takes neither."),
        `${path}: coin_trait lists where then and else may sit`,
      )
      assert.deepEqual(
        { readOnlyHint: waitHere.annotations?.readOnlyHint, destructiveHint: waitHere.annotations?.destructiveHint },
        { readOnlyHint: false, destructiveHint: false },
        `${path}: wait is a write that only adds`,
      )
    }

    setHostedChatFlag(false)
    const { gateway } = createHarness()
    const moderate = toolByName(await listTools(gateway, '/mcp', `Bearer ${LEGACY_SECRET}`), 'moderate')
    assert.match(moderate.description, /founder resident #1[^.]*root key[^.]*key-capable/iu)
  })

  test('changes exposes one cursor and forwards an exact public event kind filter', async () => {
    setHostedChatFlag(true)
    let receivedPath = ''
    const city = new Hono()
    city.get('/api/changes', c => {
      receivedPath = new URL(c.req.url).pathname + new URL(c.req.url).search
      const since = c.req.query('since')
      const unsupportedWithoutSince = since === undefined
        && (c.req.query('kind') !== undefined || c.req.query('limit') !== undefined)
      if (unsupportedWithoutSince) {
        return c.json({
          error: 'kind and limit require since',
          next_step: 'Omit kind, limit, and since to obtain a marker.',
        }, 400)
      }
      return c.json({
        change_marker: '12', changes: [], returned_items: 0,
        unchanged: false, has_more: false, next_since: '12',
      })
    })
    const gateway = new Hono()
    gateway.post('/mcp/connect', c => mcp(c, city, { hostedChat: true }))

    const changes = toolByName(await listTools(gateway), 'changes')
    assert.match(changes.description, /change_id is the only per-notice cursor/iu)
    assert.match(changes.description, /one exact public event kind/iu)
    assert.match(changes.description, /kind and limit require since; omit all three to obtain a marker/iu)
    assert.deepEqual(changes.inputSchema.properties?.kind, {
      type: 'string', enum: PUBLIC_EVENT_KINDS, description: 'Requires since.',
    })
    assert.deepEqual(changes.inputSchema.properties?.limit, {
      type: 'integer', minimum: 1, maximum: 200, description: 'Requires since.',
    })
    assert.equal(Object.hasOwn(changes.inputSchema.properties ?? {}, 'id'), false)
    assert.equal(Object.hasOwn(changes.inputSchema.properties ?? {}, 'action_id'), false)

    const response = await rpc(gateway, 'tools/call', {
      name: 'changes', arguments: { since: '5', kind: 'note', limit: 2 },
    }) as { result: ToolResult }
    assert.equal(response.result.isError, false)
    assert.equal(receivedPath, '/api/changes?since=5&kind=note&limit=2')

    const marker = await rpc(gateway, 'tools/call', {
      name: 'changes', arguments: {},
    }) as { result: ToolResult }
    assert.equal(marker.result.isError, false)
    assert.equal(receivedPath, '/api/changes')

    for (const arguments_ of [{ kind: 'note' }, { limit: 1 }]) {
      const refused = await rpc(gateway, 'tools/call', {
        name: 'changes', arguments: arguments_,
      }) as { result: ToolResult }
      assert.equal(refused.result.isError, true)
      const payload = JSON.parse(refused.result.content[0]?.text ?? '{}') as {
        http_status?: number
        next_step?: string
      }
      assert.equal(payload.http_status, 400)
      assert.match(payload.next_step ?? '', /omit kind, limit, and since to obtain a marker/iu)
    }
  })

  test('tools that can spend, consume, replace, or transfer advertise that destructive reach', async () => {
    for (const [hosted, path, authorization] of [
      [true, '/mcp/connect', `Bearer ${OAUTH_ACCESS_TOKEN}`],
      [false, '/mcp', `Bearer ${LEGACY_SECRET}`],
    ] as const) {
      setHostedChatFlag(hosted)
      const { gateway } = createHarness()
      const tools = await listTools(gateway, path, authorization)

      for (const name of ['found', 'make', 'laws', 'reconcile_world']) {
        assert.equal(toolByName(tools, name).annotations?.destructiveHint, true, `${path}: ${name}`)
      }

      const make = toolByName(tools, 'make')
      assert.match(make.description, /ingredients?[\s\S]*permanently withdrawn/iu, `${path}: consumed ingredients`)
      assert.match(
        String((make.inputSchema.properties?.ingredient_ids as { description?: string }).description ?? ''),
        /permanently withdrawn on success/iu,
        `${path}: ingredient input warning`,
      )

      const reconcile = toolByName(tools, 'reconcile_world')
      assert.match(reconcile.description, /valid finalized payment[\s\S]*ownership transfer/iu, `${path}: transfer effect`)
    }
  })

  test('both MCP doors mark destructive exactly the tools that can delete, overwrite, spend, or transfer', async () => {
    assert.equal(Object.keys(EXPECTED_DESTRUCTIVE_HINTS).length, 44)
    for (const [hosted, path, authorization] of [
      [true, '/mcp/connect', `Bearer ${OAUTH_ACCESS_TOKEN}`],
      [false, '/mcp', `Bearer ${LEGACY_SECRET}`],
    ] as const) {
      setHostedChatFlag(hosted)
      const { gateway } = createHarness()
      const tools = await listTools(gateway, path, authorization)
      const expected = Object.fromEntries(
        Object.entries(EXPECTED_DESTRUCTIVE_HINTS).filter(([name]) => !hosted || name !== 'moderate'),
      )
      assert.deepEqual(
        Object.fromEntries(tools.map(tool => [tool.name, tool.annotations?.destructiveHint])),
        expected,
        path,
      )
    }
    const source = readFileSync(new URL('../../src/mcp.ts', import.meta.url), 'utf8')
    for (const [name, destructive] of Object.entries(EXPECTED_DESTRUCTIVE_HINTS)) {
      const written = new RegExp(String.raw`\n    name: '${name}',[\s\S]*?destructiveHint: (true|false)`, 'u').exec(source)?.[1]
      assert.equal(written, String(destructive), `src/mcp.ts ${name} hard-coded destructiveHint`)
    }
  })
}
