import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AROUND_YOU_ADMISSION_CHANGE_THRESHOLD,
  AROUND_YOU_CHANGE_LIMIT,
  AROUND_YOU_STATEMENT_TIMEOUT_MS,
} from '../../src/me-around-you-limit.ts'
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

export function registerToolContractTests(): void {
  test('both MCP catalogs advertise the exact connector tool contracts', async () => {
    const { app } = connectorHarness()
    const legacy = await listedTools(app, '/mcp', AUTHORIZATION)
    const hosted = await withHostedConnector(() => listedTools(app, '/mcp/connect', HOSTED_AUTHORIZATION))
    assert.equal(legacy.length, 41, 'legacy catalog includes public help and two drawing reads')
    assert.equal(hosted.length, 40, 'hosted catalog includes public help and two drawing reads, and omits moderate')

    for (const [name, expected] of Object.entries(expectedToolContracts)) {
      const legacyTool = legacy.find(tool => tool.name === name)
      const hostedTool = hosted.find(tool => tool.name === name)
      assert.ok(legacyTool, `legacy catalog missing ${name}`)
      assert.ok(hostedTool, `hosted catalog missing ${name}`)
      for (const [catalog, tool] of [['legacy', legacyTool], ['hosted', hostedTool]] as const) {
        assert.equal(tool.title, expected.title, `${catalog} ${name} title`)
        assert.deepEqual(tool.inputSchema, expected.inputSchema, `${catalog} ${name} schema`)
        assert.deepEqual(tool.annotations, expected.annotations, `${catalog} ${name} annotations`)
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
    const aroundYouLimit = AROUND_YOU_CHANGE_LIMIT.toLocaleString('en-US')
    const aroundYouAdmissionThreshold = AROUND_YOU_ADMISSION_CHANGE_THRESHOLD.toLocaleString('en-US')
    const aroundYouStatementTimeout = AROUND_YOU_STATEMENT_TIMEOUT_MS.toLocaleString('en-US')
    for (const [catalog, tools] of [['legacy', legacy], ['hosted', hosted]] as const) {
      const meDescription = tools.find(tool => tool.name === 'me')!.description
      assert.ok(
        meDescription.includes(`Intervals under ${aroundYouAdmissionThreshold} changes do not need a summary slot; intervals from ${aroundYouAdmissionThreshold} through ${aroundYouLimit} are admitted two at a time.`),
        `${catalog} me around-you admission boundaries`,
      )
      assert.ok(
        meDescription.includes(`An available interval of at most ${aroundYouLimit} changes, including exactly ${aroundYouLimit}`),
        `${catalog} me exact around-you upper boundary`,
      )
      assert.ok(
        meDescription.includes(`More than ${aroundYouLimit} city-wide changes`),
        `${catalog} me around-you over-cap boundary`,
      )
      assert.ok(
        meDescription.includes(`Every summary-capable me read attempt, including an interval under ${aroundYouAdmissionThreshold} changes, has a ${aroundYouStatementTimeout} ms database statement budget.`),
        `${catalog} me around-you statement budget`,
      )
      assert.ok(
        meDescription.includes('"Your places" means places you own plus the place you are standing in when you read. Notes are directly in those places; descendants and earlier visits do not expand this scope.'),
        `${catalog} me current-place scope`,
      )
      assert.ok(
        meDescription.includes('Both summary slots were busy, so this interval was not summarized; follow read_href through through_change_id.'),
        `${catalog} me around-you busy message`,
      )
      assert.ok(
        meDescription.includes('The me read attempt exceeded its database statement budget, so the around-you summary was skipped. Follow read_href through through_change_id.'),
        `${catalog} me around-you timeout message`,
      )
    }
  })
}
