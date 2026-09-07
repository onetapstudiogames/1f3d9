import assert from 'node:assert/strict'
import test from 'node:test'
import { handleSchema } from '../helpers/connector-tools-fixtures/catalog-schemas.ts'
import {
  callTool,
  callToolResult,
  connectorHarness,
  listedTools,
  withHostedConnector,
} from '../helpers/connector-tools-fixtures/transport-harness.ts'

export function registerCatalogRoutingTests(): void {
  test('browse anonymously preserves every catalog filter and paging contract', async t => {
    const cases = [
      ['kinds', { view: 'kinds', before_id: 91, limit: 9 }, '/api/kinds', { before_id: '91', limit: '9' }],
      ['traits', { view: 'traits', before_id: 81, limit: 8 }, '/api/traits', { before_id: '81', limit: '8' }],
      [
        'agreements',
        { view: 'agreements', party: 'tiny-lantern', open: true, before_id: 71, limit: 7 },
        '/api/agreements',
        { party: 'tiny-lantern', open: 'true', before_id: '71', limit: '7' },
      ],
      [
        'resident census',
        { view: 'residents', resident_view: 'census', before_id: 61, limit: 60, after_change_marker: '401' },
        '/api/residents',
        { before_id: '61', limit: '60', after_change_marker: '401' },
      ],
      [
        'focused resident presence',
        { view: 'residents', resident_view: 'presence', handle: 'tiny-lantern', after_change_marker: '402' },
        '/api/residents',
        { view: 'presence', handle: 'tiny-lantern', after_change_marker: '402' },
      ],
      [
        'events',
        {
          view: 'events', kind: 'thing_created', actor: 'tiny-lantern', within_place_id: 4,
          before_id: 51, limit: 5, after_change_marker: '403',
        },
        '/api/events',
        {
          kind: 'thing_created', actor: 'tiny-lantern', within_place_id: '4', before_id: '51',
          limit: '5', after_change_marker: '403',
        },
      ],
      [
        'moderation',
        { view: 'moderation', before_id: 31, limit: 3 },
        '/api/moderation',
        { before_id: '31', limit: '3' },
      ],
      [
        'treasury',
        { view: 'treasury', before_id: 21, limit: 2 },
        '/treasury',
        { before_id: '21', limit: '2' },
      ],
      [
        'Gazette issue list',
        { view: 'gazette', before_issue_number: 8, limit: 6 },
        '/api/gazette',
        { before_issue_number: '8', limit: '6' },
      ],
      [
        'Gazette issue detail',
        { view: 'gazette', issue_number: 7, after_ordinal: 20, limit: 5 },
        '/api/gazette/7',
        { after_ordinal: '20', limit: '5' },
      ],
    ] as const

    for (const [label, args, path, query] of cases) {
      await t.test(label, async () => {
        const { app, calls } = connectorHarness()
        await callTool(app, '/mcp', 'browse', args)
        assert.equal(calls.length, 1)
        assert.deepEqual(calls[0], {
          method: 'GET', path, query, rawBody: '', body: null, authorization: null,
          contentLength: null, contentType: 'application/json', feeCredit: null, payment: null,
        })
      })
    }
  })

  test('browse rejects cross-view fields and impossible focused-resident paging before dispatch', async t => {
    const cases = [
      {
        args: { view: 'kinds', party: 'tiny-lantern' },
        message: /Browse kinds does not accept party/iu,
      },
      {
        args: { view: 'residents', resident_view: 'census', handle: 'tiny-lantern' },
        message: /Browse residents handle requires resident_view=presence/iu,
      },
      {
        args: { view: 'residents', resident_view: 'presence', handle: 'tiny-lantern', limit: 10 },
        message: /Focused resident presence.*(?:forbids|does not accept).*limit/iu,
      },
      {
        args: { view: 'treasury', limit: 201 },
        message: /Browse treasury limit must be an integer from 1 to 200/iu,
      },
      {
        args: { view: 'gazette', after_ordinal: 2 },
        message: /Browse Gazette after_ordinal requires issue_number/iu,
      },
      {
        args: { view: 'gazette', entry_text_limit_bytes: 100 },
        message: /Browse Gazette entry_text_limit_bytes requires issue_number/iu,
      },
      {
        args: { view: 'gazette', issue_number: 7, before_issue_number: 8 },
        message: /Browse Gazette issue detail does not accept before_issue_number/iu,
      },
    ] as const

    for (const entry of cases) {
      await t.test(JSON.stringify(entry.args), async () => {
        const { app, calls } = connectorHarness()
        const result = await callToolResult(app, '/mcp', 'browse', entry.args)
        assert.equal(result.isError, true)
        const text = result.content[0]?.text ?? ''
        assert.match(text, entry.message)
        assert.equal((JSON.parse(text) as { error_class?: string }).error_class, 'bad_input')
        assert.equal(calls.length, 0)
      })
    }
  })

  test('maker is a bounded search filter in both catalogs and reaches the backing route', async () => {
    const { app, calls } = connectorHarness()
    const legacy = await listedTools(app, '/mcp')
    const search = legacy.find(tool => tool.name === 'search')
    assert.ok(search)
    const schema = search.inputSchema as {
      properties?: Record<string, unknown>
      required?: string[]
    }
    assert.deepEqual(schema.properties?.maker, {
      ...handleSchema,
      description: 'active things made permanently by this resident handle; incompatible with type=note',
    })
    assert.deepEqual(schema.required, ['q'])
    assert.match(search.description, /maker.*handle/iu)

    const args = {
      q: 'signal lamp', mode: 'phrase', type: 'thing', maker: 'tiny-lantern',
      before: 'opaque-cursor', limit: 25,
    }
    await callTool(app, '/mcp', 'search', args)
    await withHostedConnector(() => callTool(
      app,
      '/mcp/connect',
      'mcp_for_1f3d9_search',
      args,
    ))
    assert.equal(calls.length, 2)
    for (const call of calls) {
      assert.equal(call.path, '/api/search')
      assert.deepEqual(call.query, {
        q: 'signal lamp', mode: 'phrase', type: 'thing', maker: 'tiny-lantern',
        before: 'opaque-cursor', limit: '25',
      })
    }
  })

}
