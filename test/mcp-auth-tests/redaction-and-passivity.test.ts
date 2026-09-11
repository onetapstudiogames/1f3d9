import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { mcp } from '../../src/mcp.ts'
import {
  LEGACY_SECRET,
  OAUTH_ACCESS_TOKEN,
  setHostedChatFlag,
  createHarness,
  createAuthenticatedLookHarness,
  rpc,
  listTools,
  toolByName,
} from '../helpers/mcp-auth-fixtures/fixture.ts'
import type {
  ToolResult,
} from '../helpers/mcp-auth-fixtures/fixture.ts'

export function registerRedactionAndPassivityTests(): void {
  test('hosted look redacts only a credential-bearing note body and preserves the place response', async () => {
    setHostedChatFlag(true)
    const residentKey = `1f3d9_sk_${'ef'.repeat(24)}`
    const accessToken = `1f3d9_at_${'34'.repeat(32)}`
    const unsafeNote56 = {
      id: 56,
      place_id: 2,
      author: 'guard-test-owner',
      body: `pre-publish guard fixture ${residentKey}`,
      created_at: '2026-08-14T15:00:00.000Z',
    }
    const unsafeNote57 = {
      id: 57,
      place_id: 2,
      author: 'guard-test-owner',
      body: `second pre-publish guard fixture ${accessToken}`,
      created_at: '2026-08-14T15:01:00.000Z',
    }
    const unsafeNote58 = {
      id: 58,
      place_id: 2,
      author: 'guard-test-owner',
      body: `credential followed by lowercase hex ${residentKey}a`,
      created_at: '2026-08-14T15:01:30.000Z',
    }
    const unsafeNote59 = {
      id: 59,
      place_id: 2,
      author: 'guard-test-owner',
      body: `credential followed by uppercase hex ${accessToken}F`,
      created_at: '2026-08-14T15:01:45.000Z',
    }
    const formatNote = {
      id: 49,
      place_id: 2,
      author: 'documentarian',
      body: 'A resident key starts with 1f3d9_sk_...; this is not a credential.',
      created_at: '2026-08-14T14:59:00.000Z',
    }
    const safeNote = {
      id: 60,
      place_id: 2,
      author: 'neighbor',
      body: 'The square remains readable.',
      created_at: '2026-08-14T15:02:00.000Z',
    }
    const placePayload = {
      place: {
        id: 2,
        parent_id: 1,
        name: 'the square',
        description: `unsafe place description ${residentKey}`,
        owner_id: null,
        owner: null,
        labels: ['meeting-place'],
        laws: [],
      },
      subplaces: [{ id: 3, parent_id: 2, name: 'the waystation' }],
      things: [{
        id: 313,
        place_id: 2,
        name: 'credential safety guide',
        body: 'The format 1f3d9_at_... is safe to name when no token follows it.',
      }],
      notes: [formatNote, unsafeNote56, unsafeNote57, unsafeNote58, unsafeNote59, safeNote],
    }
    const gateway = createAuthenticatedLookHarness(placePayload)

    const response = await rpc(
      gateway,
      'tools/call',
      { name: 'look', arguments: { place_id: 2 } },
      `Bearer ${OAUTH_ACCESS_TOKEN}`,
    ) as { result: ToolResult }

    assert.equal(response.result.isError, false)
    const text = response.result.content[0]?.text ?? ''
    const parsed = JSON.parse(text) as typeof placePayload
    const redactedDescription = parsed.place.description
    const redactedBody56 = parsed.notes[1]?.body
    const redactedBody57 = parsed.notes[2]?.body
    const redactedBody58 = parsed.notes[3]?.body
    const redactedBody59 = parsed.notes[4]?.body
    assert.match(redactedDescription ?? '', /redacted.*resident credential/i)
    assert.match(redactedBody56 ?? '', /redacted.*resident credential/i)
    assert.match(redactedBody57 ?? '', /redacted.*resident credential/i)
    assert.match(redactedBody58 ?? '', /redacted.*resident credential/i)
    assert.match(redactedBody59 ?? '', /redacted.*resident credential/i)
    assert.deepEqual(parsed, {
      ...placePayload,
      place: { ...placePayload.place, description: redactedDescription },
      notes: [
        formatNote,
        { ...unsafeNote56, body: redactedBody56 },
        { ...unsafeNote57, body: redactedBody57 },
        { ...unsafeNote58, body: redactedBody58 },
        { ...unsafeNote59, body: redactedBody59 },
        safeNote,
      ],
    })
    assert.doesNotMatch(JSON.stringify(response), new RegExp(residentKey, 'i'))
    assert.doesNotMatch(JSON.stringify(response), new RegExp(accessToken, 'i'))
  })

  test('hosted look redacts credential-bearing fields outside note bodies instead of withholding the response', async () => {
    setHostedChatFlag(true)
    const residentKey = `1f3d9_sk_${'12'.repeat(24)}`
    const gateway = createAuthenticatedLookHarness({
      place: {
        id: 2,
        name: 'the square',
        description: `unsafe place description ${residentKey}`,
      },
      subplaces: [],
      things: [],
      notes: [{ id: 58, place_id: 2, author: 'neighbor', body: 'Safe public note.' }],
    })

    const response = await rpc(
      gateway,
      'tools/call',
      { name: 'look', arguments: { place_id: 2 } },
      `Bearer ${OAUTH_ACCESS_TOKEN}`,
    ) as { result: ToolResult }

    assert.equal(response.result.isError, false)
    const parsed = JSON.parse(response.result.content[0]?.text ?? '{}') as {
      place?: { description?: string }
      notes?: Array<{ body?: string }>
    }
    assert.match(parsed.place?.description ?? '', /redacted.*resident credential/i)
    assert.equal(parsed.notes?.[0]?.body, 'Safe public note.')
    assert.doesNotMatch(JSON.stringify(response), new RegExp(residentKey, 'i'))
  })

  test('legacy MCP reads use the same historical credential redaction rule', async () => {
    setHostedChatFlag(false)
    const leaked = `1f3d9_rt_${'56'.repeat(32)}`
    const gateway = createAuthenticatedLookHarness({
      place: { id: 2, name: 'the square', description: `historical ${leaked}` },
      subplaces: [],
      things: [],
      notes: [{ id: 61, place_id: 2, author: 'neighbor', body: 'Safe public note.' }],
    })

    const response = await rpc(
      gateway,
      'tools/call',
      { name: 'look', arguments: { place_id: 2 } },
      `Bearer ${LEGACY_SECRET}`,
      '/mcp',
    ) as { result: ToolResult }

    assert.equal(response.result.isError, false)
    const text = response.result.content[0]?.text ?? '{}'
    const parsed = JSON.parse(text) as { place?: { description?: string } }
    assert.match(parsed.place?.description ?? '', /redacted.*resident credential/i)
    assert.doesNotMatch(text, new RegExp(leaked, 'i'))
  })

  test('me and MCP look disclose their bounded side effects on both doors', async () => {
    // GET /api/me resolves due timers where the resident stands (label, block,
    // even destroy effects can apply), so the status check must never claim to
    // be read-only. Signed-in MCP look publishes an ephemeral public cue, so
    // the single public-or-permanent-write rule also marks it destructive.
    for (const [hosted, path, authorization] of [
      [true, '/mcp/connect', `Bearer ${OAUTH_ACCESS_TOKEN}`],
      [false, '/mcp', `Bearer ${LEGACY_SECRET}`],
    ] as const) {
      setHostedChatFlag(hosted)
      const { gateway } = createHarness()
      const tools = await listTools(gateway, path, authorization)
      const me = toolByName(tools, 'me')
      assert.deepEqual(me.annotations, {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      }, path)
      assert.match(me.description, /may change the city/iu, path)
      assert.match(me.description, /resolves? due timers/iu, path)
      const look = toolByName(tools, 'look')
      assert.deepEqual(look.annotations, {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      }, path)
      assert.match(look.description, /generic looking cue/iu, path)
      assert.match(look.description, /best effort/iu, path)
      assert.match(look.description, /60 seconds/iu, path)
      assert.doesNotMatch(look.description, /resolves? due timers/iu, path)
    }
  })

  test('an invalid enum value rejects plainly and never routes to a different action', async () => {
    for (const [hosted, path, authorization] of [
      [true, '/mcp/connect', `Bearer ${OAUTH_ACCESS_TOKEN}`],
      [false, '/mcp', `Bearer ${LEGACY_SECRET}`],
    ] as const) {
      setHostedChatFlag(hosted)
      const calls: string[] = []
      const city = new Hono()
      city.all('*', c => {
        calls.push(`${c.req.method} ${new URL(c.req.url).pathname}`)
        return c.json({ ok: true })
      })
      const gateway = new Hono()
      gateway.post('/mcp', c => mcp(c, city))
      gateway.post('/mcp/connect', c => mcp(c, city, { hostedChat: true }))

      // A near-miss transfer action must not fall through to an immediate give.
      const transfer = await rpc(gateway, 'tools/call', {
        name: 'transfer',
        arguments: { action: 'offerr', type: 'thing', id: 7, to_handle: 'neighbor' },
      }, authorization, path) as { result: ToolResult }
      assert.equal(transfer.result.isError, true, path)
      assert.match(transfer.result.content[0]?.text ?? '', /unsupported action value/i, path)
      assert.match(transfer.result.content[0]?.text ?? '', /give, offer, claim, cancel/, path)

      // talk and make are no longer act menu entries; the rejection lists the menu.
      const act = await rpc(gateway, 'tools/call', {
        name: 'act',
        arguments: { action: 'talk' },
      }, authorization, path) as { result: ToolResult }
      assert.equal(act.result.isError, true, path)
      assert.match(act.result.content[0]?.text ?? '', /move, use, give, consume, go_home/, path)

      assert.deepEqual(calls, [], `${path}: no city route may run for an invalid enum value`)

      // The advertised default remains: omitting action routes to the immediate give.
      const defaulted = await rpc(gateway, 'tools/call', {
        name: 'transfer',
        arguments: { type: 'thing', id: 7, to_handle: 'neighbor' },
      }, authorization, path) as { result: ToolResult }
      assert.equal(defaulted.result.isError, false, path)
      assert.deepEqual(calls, ['POST /api/transfer'], `${path}: omitted action uses the declared default`)
    }
  })
}
