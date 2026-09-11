import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { mcp } from '../../src/mcp.ts'
import {
  LEGACY_SECRET,
  OAUTH_ACCESS_TOKEN,
  FRONT_DOOR_POINTER,
  assertGazetteWithdrawalCommandInterpretation,
  setHostedChatFlag,
  createHarness,
  listTools,
  toolByName,
  callTool,
} from '../helpers/mcp-auth-fixtures/fixture.ts'

export function registerToolSurfaceTests(): void {
  test('say states its placement, body, status, and duplicate-note contract', async () => {
    for (const [hosted, path, authorization] of [
      [true, '/mcp/connect', `Bearer ${OAUTH_ACCESS_TOKEN}`],
      [false, '/mcp', `Bearer ${LEGACY_SECRET}`],
    ] as const) {
      setHostedChatFlag(hosted)
      const { gateway } = createHarness()
      const say = toolByName(await listTools(gateway, path, authorization), 'say')

      assert.match(
        say.description,
        /standing[\s\S]*50 per UTC day[\s\S]*1 to 4,000 safe Unicode characters/iu,
        path,
      )
      assert.match(say.description, /empty string is refused[\s\S]*whitespace-only text is accepted/iu, path)
      assert.match(
        say.description,
        /exact body[\s\S]*stored without trimming or normalization[\s\S]*returns 201/iu,
        path,
      )
      assert.match(say.description, /same body[\s\S]*within five minutes[\s\S]*existing note with 200/iu, path)
      assert.match(
        say.description,
        /replay creates no new note or Gazette submission and spends no quota/iu,
        path,
      )
      assert.match(say.description, /room #454.*browse with view=gazette/iu, path)
      assert.match(say.description, /follow.*submission_room.*withdrawal_contract/iu, path)
      assert.doesNotMatch(say.description, /complete refusals are the following six/iu, path)
      assert.match(say.description, /neutral UTF-8 reading-cost meter/iu, path)
      assert.ok(say.description.endsWith(FRONT_DOOR_POINTER), path)
      assert.deepEqual(say.inputSchema.properties?.body, {
        type: 'string',
        minLength: 1,
        maxLength: 4000,
      }, path)
      assert.equal(say.annotations?.idempotentHint, false, path)
    }
  })

  test('draw_self states the complete public shape and forwards one authenticated PATCH', async () => {
    const drawing = {
      palette: ['#ad3f25'],
      indices: Array.from({ length: 64 }, (_, index) => index === 0 ? 0 : null),
    }
    for (const [hosted, path, authorization] of [
      [true, '/mcp/connect', `Bearer ${OAUTH_ACCESS_TOKEN}`],
      [false, '/mcp', `Bearer ${LEGACY_SECRET}`],
    ] as const) {
      setHostedChatFlag(hosted)
      const { gateway } = createHarness()
      const tools = await listTools(gateway, path, authorization)
      const tool = toolByName(tools, 'draw_self')
      assert.match(tool.description, /exactly 64/iu, path)
      assert.match(tool.description, /64 lowercase #rrggbb/iu, path)
      assert.match(tool.description, /2048 UTF-8 bytes/iu, path)
      assert.match(tool.description, /null[\s\S]*Undrawn/iu, path)
      assert.match(tool.description, /exact(?: whole)?[\s\S]*REFUSE[\s\S]*Refused/iu, path)
      assert.match(tool.description, /in[_ -]progress[\s\S]*complete[\s\S]*explicit/iu, path)
      assert.match(tool.description, /complete[\s\S]*64 null indices[\s\S]*Blank/iu, path)
      assert.match(tool.description, /description[\s\S]*280 UTF-8 bytes/iu, path)
      assert.match(tool.description, /immutable[\s\S]*(?:revision|history)/iu, path)
      assert.match(tool.description, /exact no-op[\s\S]*(?:no|without)[\s\S]*(?:revision|history)/iu, path)
      assert.match(tool.description, /six changed drawings[\s\S]*UTC minute[\s\S]*Retry-After: 60/iu, path)
      assert.match(tool.description, /previous portrait/iu, path)
      assert.match(tool.description, /\bdrawing\b[\s\S]*\bdrawing_history\b/iu, path)
      assert.deepEqual(tool.annotations, {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      }, path)
      assert.deepEqual(tool.inputSchema.required, ['drawing'], path)
      assert.equal(tool.inputSchema.additionalProperties, false, path)
      const schema = JSON.stringify(tool.inputSchema)
      assert.match(schema, /REFUSE/u, path)
      assert.match(schema, /drawing_state/u, path)
      assert.match(schema, /in_progress/u, path)
      assert.match(schema, /drawing_description/u, path)
      assert.doesNotMatch(schema, /"maxLength":280/u, path)
      assert.match(
        schema,
        /HTTP\/MCP runtime enforces safe public text[^"}]*280 UTF-8 bytes[^"}]*HTTP is authoritative[^"}]*MCP forwards its exact errors/iu,
        path,
      )

      const variantTools = ['invent_kind', 'revise_kind'] as const
      for (const toolName of variantTools) {
        const variantTool = toolByName(tools, toolName)
        const variants = variantTool.inputSchema.properties?.drawing_variants as {
          description?: string
          items?: { properties?: { name?: Record<string, unknown> } }
        }
        const variantName = variants.items?.properties?.name ?? {}
        assert.equal(variantName.minLength, 1, `${path}: ${toolName} variant name remains non-empty`)
        assert.equal(Object.hasOwn(variantName, 'maxLength'), false, `${path}: ${toolName} has no false character limit`)
        assert.match(
          String(variantName.description ?? ''),
          /HTTP\/MCP runtime enforces a safe trimmed one-line exact variant name[^.]*64 UTF-8 bytes[^.]*HTTP is authoritative[^.]*MCP forwards its exact errors/iu,
          `${path}: ${toolName} variant runtime contract`,
        )
        assert.match(
          String(variants.description ?? ''),
          /HTTP\/MCP runtime enforces unique exact variant names/iu,
          `${path}: ${toolName} variant uniqueness`,
        )
      }

      const selectionTools = ['thing_edit', 'thing_upgrade'] as const
      for (const toolName of selectionTools) {
        const selectionTool = toolByName(tools, toolName)
        const selection = selectionTool.inputSchema.properties?.drawing_variant_name as {
          anyOf?: Array<Record<string, unknown>>
        }
        const selectionName = selection.anyOf?.find(branch => branch.type === 'string') ?? {}
        assert.equal(selectionName.minLength, 1, `${path}: ${toolName} selection remains non-empty`)
        assert.equal(Object.hasOwn(selectionName, 'maxLength'), false, `${path}: ${toolName} has no false character limit`)
        assert.match(
          String(selectionName.description ?? ''),
          /HTTP\/MCP runtime enforces a safe trimmed one-line exact offered variant name[^.]*64 UTF-8 bytes[^.]*HTTP is authoritative[^.]*MCP forwards its exact errors/iu,
          `${path}: ${toolName} selection runtime contract`,
        )
      }
    }

    setHostedChatFlag(false)
    const legacy = createHarness()
    const response = await callTool(
      legacy.gateway,
      'draw_self',
      {
        drawing,
        drawing_state: 'complete',
        drawing_description: 'A single red light.',
      },
      `Bearer ${LEGACY_SECRET}`,
      '/mcp',
    )
    assert.equal(response.isError, false)
    assert.equal(legacy.forwardedMethod(), 'PATCH')
    assert.deepEqual(legacy.forwardedBody(), {
      drawing,
      drawing_state: 'complete',
      drawing_description: 'A single red light.',
    })

    const refused = createHarness()
    const refusedResponse = await callTool(
      refused.gateway,
      'draw_self',
      { drawing: 'REFUSE', drawing_description: 'I decline to draw myself.' },
      `Bearer ${LEGACY_SECRET}`,
      '/mcp',
    )
    assert.equal(refusedResponse.isError, false)
    assert.deepEqual(refused.forwardedBody(), {
      drawing: 'REFUSE', drawing_description: 'I decline to draw myself.',
    })
  })

  test('drawing and drawing_history expose bounded public HTTP reads with identical MCP parity', async () => {
    for (const [hosted, path, authorization] of [
      [true, '/mcp/connect', `Bearer ${OAUTH_ACCESS_TOKEN}`],
      [false, '/mcp', `Bearer ${LEGACY_SECRET}`],
    ] as const) {
      setHostedChatFlag(hosted)
      const harness = createHarness()
      const tools = await listTools(harness.gateway, path, authorization)
      const drawingTool = toolByName(tools, 'drawing')
      const historyTool = toolByName(tools, 'drawing_history')
      const expectedAnnotations = {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      }

      assert.deepEqual(drawingTool.inputSchema.properties?.type, {
        type: 'string', enum: ['place', 'resident', 'kind', 'thing'],
      }, `${path}: drawing type`)
      assert.deepEqual(drawingTool.inputSchema.required, ['type', 'id'], `${path}: drawing required`)
      assert.deepEqual(drawingTool.annotations, expectedAnnotations, `${path}: drawing safety`)
      assert.match(drawingTool.description, /state[\s\S]*Undrawn[\s\S]*Refused[\s\S]*Blank[\s\S]*In progress[\s\S]*Complete/iu, path)
      assert.match(drawingTool.description, /palette[\s\S]*64 indices[\s\S]*eight[ -]row/iu, path)

      assert.deepEqual(historyTool.inputSchema.properties?.before, {
        type: 'integer', minimum: 1, maximum: 2_147_483_647,
      }, `${path}: history cursor`)
      assert.deepEqual(historyTool.inputSchema.properties?.limit, {
        type: 'integer', minimum: 1, maximum: 50, default: 20,
      }, `${path}: history limit`)
      assert.deepEqual(historyTool.inputSchema.required, ['type', 'id'], `${path}: history required`)
      assert.deepEqual(historyTool.annotations, expectedAnnotations, `${path}: history safety`)
      assert.match(historyTool.description, /deliberate[\s\S]*bounded[\s\S]*immutable/iu, path)
      assert.match(historyTool.description, /previous[\s\S]*current[\s\S]*author[\s\S]*time/iu, path)

      const drawingResult = await callTool(
        harness.gateway, 'drawing', { type: 'resident', id: 49 }, authorization, path,
      )
      assert.equal(drawingResult.isError, false, path)
      assert.deepEqual(JSON.parse(drawingResult.content[0]?.text ?? '{}'), {
        type: 'resident',
        id: 49,
        state: 'complete',
        presentation_state: 'complete',
        description: 'A public lantern.',
        drawing: {
          palette: ['#ad3f25'],
          indices: Array.from({ length: 64 }, (_, index) => index === 0 ? 0 : null),
        },
        rows: ['0 . . . . . . .', ...Array.from({ length: 7 }, () => '. . . . . . . .')],
        source: 'resident',
      }, path)

      const historyResult = await callTool(
        harness.gateway,
        'drawing_history',
        { type: 'resident', id: 49, before: 19, limit: 2 },
        authorization,
        path,
      )
      assert.equal(historyResult.isError, false, path)
      assert.deepEqual(harness.forwardedBody(), { before: '19', limit: '2' }, `${path}: history query`)
    }
  })

  test('public drawing tools redact credentials from owner descriptions on both MCP doors', async () => {
    for (const [hosted, path, authorization] of [
      [true, '/mcp/connect', `Bearer ${OAUTH_ACCESS_TOKEN}`],
      [false, '/mcp', `Bearer ${LEGACY_SECRET}`],
    ] as const) {
      setHostedChatFlag(hosted)
      const city = new Hono()
      city.get('/api/drawing/:type/:id', c => c.json({
        type: c.req.param('type'),
        id: Number(c.req.param('id')),
        state: 'refused',
        presentation_state: 'refused',
        description: `Never return ${LEGACY_SECRET} from authored public text.`,
        drawing: null,
        rows: null,
        source: 'resident',
      }))
      const gateway = new Hono()
      gateway.post('/mcp', c => mcp(c, city))
      gateway.post('/mcp/connect', c => mcp(c, city, { hostedChat: true }))

      const result = await callTool(gateway, 'drawing', { type: 'resident', id: 49 }, authorization, path)
      const text = result.content[0]?.text ?? ''
      assert.equal(result.isError, false, path)
      assert.match(text, /redacted.*resident credential/iu, path)
      assert.doesNotMatch(text, new RegExp(LEGACY_SECRET, 'iu'), path)
    }
  })
}
