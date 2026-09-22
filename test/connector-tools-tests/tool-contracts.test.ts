import assert from 'node:assert/strict'
import test from 'node:test'
import { cityToolFacts } from '../../src/city-facts.ts'
import {
  NOAUTH_SECURITY_SCHEME,
  OAUTH_SECURITY_SCHEME,
  expectedToolContracts,
} from '../helpers/connector-tools-fixtures/tool-contracts.ts'
import {
  AUTHORIZATION,
  HOSTED_AUTHORIZATION,
  connectorHarness,
  listedTools,
  withHostedConnector,
} from '../helpers/connector-tools-fixtures/transport-harness.ts'
import { parseCityCreditRequestId, suggestCityCreditRequestId } from '../../src/city-credit.ts'
import {
  CREDIT_PURCHASE_REQUEST_ID_SHAPE_REFUSAL,
  CREDIT_REQUEST_ID_SHAPE_REFUSAL,
} from '../../src/city-fee-facts.ts'
import { callToolResult } from '../helpers/connector-tools-fixtures/transport-harness.ts'

export function registerToolContractTests(): void {
  test('both MCP catalogs advertise the exact connector tool contracts', async () => {
    const { app } = connectorHarness()
    const legacy = await listedTools(app, '/mcp', AUTHORIZATION)
    const hosted = await withHostedConnector(() => listedTools(app, '/mcp/connect', HOSTED_AUTHORIZATION))
    assert.equal(legacy.length, 42, 'legacy catalog includes public help and two drawing reads')
    assert.equal(hosted.length, 41, 'hosted catalog includes public help and two drawing reads, and omits moderate')

    for (const [name, expected] of Object.entries(expectedToolContracts)) {
      const legacyTool = legacy.find(tool => tool.name === name)
      const hostedTool = hosted.find(tool => tool.name === name)
      assert.ok(legacyTool, `legacy catalog missing ${name}`)
      assert.ok(hostedTool, `hosted catalog missing ${name}`)
      for (const [catalog, tool] of [['legacy', legacyTool], ['hosted', hostedTool]] as const) {
        assert.equal(tool.title, expected.title, `${catalog} ${name} title`)
        assert.deepEqual(tool.inputSchema, expected.inputSchema, `${catalog} ${name} schema`)
        const facts = cityToolFacts(name)
        assert.deepEqual(safetyHints(tool.annotations), {
          ...expected.annotations,
          readOnlyHint: facts.readOnlyHint,
          destructiveHint: facts.destructiveHint,
        }, `${catalog} ${name} annotations`)
      }
      assert.equal(legacyTool.securitySchemes, undefined, `${name} legacy security metadata`)
      const hostedSchemes = ['help', 'browse', 'drawing', 'drawing_history'].includes(name)
        ? [NOAUTH_SECURITY_SCHEME, OAUTH_SECURITY_SCHEME]
        : [OAUTH_SECURITY_SCHEME]
      assert.deepEqual(hostedTool.securitySchemes, hostedSchemes, `${name} hosted security`)
      assert.deepEqual(hostedTool._meta?.securitySchemes, hostedSchemes, `${name} hosted security mirror`)
    }

    const placeEditDescription = legacy.find(tool => tool.name === 'place_edit')!.description
    assert.match(placeEditDescription, /owner.*4,?000/iu)
    assert.match(placeEditDescription, /280.*(?:clear|empty)/iu)
    assert.match(placeEditDescription, /(?:exactly )?2.*3/iu)
    assert.match(legacy.find(tool => tool.name === 'thing_edit')!.description, /owner.*120.*65,?536/iu)
    assert.match(legacy.find(tool => tool.name === 'thing_upgrade')!.description, /owner.*latest.*revision/iu)
    assert.match(legacy.find(tool => tool.name === 'coin_trait')!.description, /free.*4,?000.*128.*8.*65,?536/iu)
    assert.match(legacy.find(tool => tool.name === 'invent_kind')!.description, /\$1|one.*credit/iu)
    assert.match(legacy.find(tool => tool.name === 'revise_kind')!.description, /\$1|one.*credit/iu)
    assert.match(legacy.find(tool => tool.name === 'browse')!.description, /default.*10.*residents.*200.*treasury.*50/iu)
    assert.match(
      legacy.find(tool => tool.name === 'drawing')!.description,
      /Undrawn[\s\S]*Refused[\s\S]*Blank[\s\S]*In progress[\s\S]*Complete[\s\S]*eight[ -]row/iu,
    )
    assert.match(
      legacy.find(tool => tool.name === 'drawing_history')!.description,
      /deliberate[\s\S]*bounded[\s\S]*previous[\s\S]*current[\s\S]*author[\s\S]*time/iu,
    )
    const buyCreditDescription = legacy.find(tool => tool.name === 'buy_credit')!.description
    assert.match(buyCreditDescription, /X-PAYMENT/iu)
    assert.match(buyCreditDescription, /1.*10,?000/iu)
    assert.match(legacy.find(tool => tool.name === 'flag')!.description, /authenticated|resident.*only/iu)
    assert.match(legacy.find(tool => tool.name === 'flag')!.description, /anonymous.*web-only/iu)
    for (const [catalog, tools] of [['legacy', legacy], ['hosted', hosted]] as const) {
      const meDescription = tools.find(tool => tool.name === 'me')!.description
      assert.match(meDescription, /four bounded categories/iu, `${catalog} me bounded summary`)
      assert.match(meDescription, /reference\/public-history\.txt/iu, `${catalog} me detailed reference`)
    }
  })

  test('the published request id pattern accepts exactly what the validator accepts', async () => {
    const { app } = connectorHarness()
    const legacy = await listedTools(app, '/mcp', AUTHORIZATION)
    const patterns = new Set<string>()
    for (const name of ['found', 'invent_kind', 'revise_kind'] as const) {
      const schema = legacy.find(tool => tool.name === name)!.inputSchema as SchemaWithProperties
      patterns.add(String(schema.properties.city_credit_request_id?.pattern))
    }
    const buyCredit = legacy.find(tool => tool.name === 'buy_credit')!.inputSchema as SchemaWithProperties
    patterns.add(String(buyCredit.properties.request_id?.pattern))
    assert.equal(patterns.size, 1, 'every paid tool publishes the same request id pattern')

    const [pattern] = [...patterns]
    assert.ok(pattern && pattern.startsWith('^'), 'every paid tool publishes an anchored pattern')
    const published = new RegExp(pattern, 'u')
    const candidates = [
      suggestCityCreditRequestId(),
      '20260916-2',
      '1726500000-1',
      '1_2345678',
      '1:2345678',
      '1a2345678',
      'fee_frontier:request.20260822',
      '1.000000',
      '12345678',
      '0.000001',
      '1000000.5',
    ]
    for (const candidate of candidates) {
      let accepted: boolean
      try {
        accepted = parseCityCreditRequestId(candidate) !== null
      } catch {
        accepted = false
      }
      assert.equal(published.test(candidate), accepted,
        `published schema and validator disagree about ${candidate}`)
    }
  })

  test('every paid tool refuses a number-shaped request id in the words of its own door', async () => {
    const { app } = connectorHarness()
    for (const name of ['found', 'place_edit', 'invent_kind', 'revise_kind'] as const) {
      const result = await callToolResult(app, '/mcp', name, {
        ...(name === 'found' ? { name: 'Number shaped test' } : {}),
        ...(name === 'place_edit' ? { place_id: 3, name: 'Number shaped test' } : {}),
        ...(name === 'invent_kind' ? { name: 'number-shaped-test' } : {}),
        ...(name === 'revise_kind' ? { kind_id: 3 } : {}),
        city_credit_request_id: '1.000000',
      }, { authorization: AUTHORIZATION })
      assert.equal(result.isError, true, name)
      assert.equal(refusalText(result), CREDIT_REQUEST_ID_SHAPE_REFUSAL, name)
    }

    const bought = await callToolResult(app, '/mcp', 'buy_credit', {
      request_id: '12345678',
      amount_dollars: '3',
    }, { authorization: AUTHORIZATION })
    assert.equal(bought.isError, true)
    assert.equal(refusalText(bought), CREDIT_PURCHASE_REQUEST_ID_SHAPE_REFUSAL)
  })
}

function refusalText(result: Readonly<{ content: readonly { text: string }[] }>): string {
  return String((JSON.parse(result.content[0]!.text) as { error?: unknown }).error)
}

type SchemaWithProperties = Readonly<{
  properties: Record<string, Record<string, unknown>>
}>

function safetyHints(value: Record<string, unknown> = {}): Record<string, unknown> {
  const { title: _title, ...hints } = value
  return hints
}
