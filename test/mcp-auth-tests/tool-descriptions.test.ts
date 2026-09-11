import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { mcp } from '../../src/mcp.ts'
import { PUBLIC_EVENT_KINDS } from '../../src/public-events.ts'
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
      assert.match(
        act.description,
        /one thing you own[^.]*place being left[^.]*open sale offer or market lock[^.]*later-holder mark[^.]*moderation hold/iu,
        `${path}: carry gates`,
      )
      assert.match(
        act.description,
        /carry requires the destination owner to be the mover or its open_to_things to be true/iu,
        `${path}: carry destination permission`,
      )
      assert.match(act.description, /open_to_things[^.]*false by default/iu, `${path}: carry closed default`)
      assert.match(
        act.description,
        /drop the carry and walk[^.]*go where things are welcome/iu,
        `${path}: carry refusal alternatives`,
      )
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
      assert.match(me.description, /reference\/public-history\.txt/iu, `${path}: me reference`)
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
    assert.deepEqual(changes.inputSchema.properties?.kind, {
      type: 'string', enum: PUBLIC_EVENT_KINDS,
    })
    assert.equal(Object.hasOwn(changes.inputSchema.properties ?? {}, 'id'), false)
    assert.equal(Object.hasOwn(changes.inputSchema.properties ?? {}, 'action_id'), false)

    const response = await rpc(gateway, 'tools/call', {
      name: 'changes', arguments: { since: '5', kind: 'note', limit: 2 },
    }) as { result: ToolResult }
    assert.equal(response.result.isError, false)
    assert.equal(receivedPath, '/api/changes?since=5&kind=note&limit=2')
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
}
