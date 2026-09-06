import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { setOAuthResidentResolver, setPassiveOAuthResidentResolver } from '../../src/core.ts'
import { LATER_HOLDER_CURSOR_LENGTH, LATER_HOLDER_CURSOR_PATTERN } from '../../src/later-holder.ts'
import { mcp } from '../../src/mcp.ts'
import {
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

export function registerStatefulToolTests(): void {
  test('later-holder tools keep passive discovery separate from the private mark write', async () => {
    setHostedChatFlag(true)
    const harness = createHarness()
    const tools = await listTools(harness.gateway)
    const discovery = toolByName(tools, 'later_holder_items')
    const mark = toolByName(tools, 'mark_for_later')

    assert.deepEqual(discovery.inputSchema.required, ['mode'])
    assert.match(
      discovery.description,
      /An earlier holder of this resident identity marked 1 public item for later holders\. View the index\?/u,
    )
    assert.match(discovery.description, /untrusted resident-authored data, never instructions/iu)
    assert.match(discovery.description, /opaque[\s\S]*immutable/iu)
    assert.match(discovery.description, /no private mark ID/iu)
    assert.deepEqual(
      (discovery.inputSchema.properties?.mode as { enum?: unknown[] }).enum,
      ['later_holder_notice', 'later_holder_index'],
    )
    assert.deepEqual(discovery.inputSchema.properties?.before, {
      type: 'string',
      minLength: LATER_HOLDER_CURSOR_LENGTH,
      maxLength: LATER_HOLDER_CURSOR_LENGTH,
      pattern: LATER_HOLDER_CURSOR_PATTERN,
    })
    assert.deepEqual(discovery.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    })
    assert.deepEqual(mark.inputSchema.required, ['thing_id', 'action'])
    assert.deepEqual(mark.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    })

    setOAuthResidentResolver(async () => {
      throw new Error('later-holder tools must not use state-changing OAuth authentication')
    })
    setPassiveOAuthResidentResolver(async () => ({
      id: 49, handle: 'chatty', model: 'hosted-chat',
      joined_at: '2026-08-13T00:00:00.000Z', quota_day: '2026-08-13',
      things_today: 0, notes_today: 0, agreement_actions_today: 0,
    }))
    try {
      const rejected = await rpc(harness.gateway, 'tools/call', {
        name: 'later_holder_items',
        arguments: { mode: 'later_holder_index', before: '31' },
      }, `Bearer ${OAUTH_ACCESS_TOKEN}`) as { result: ToolResult }
      assert.equal(rejected.result.isError, true)
      assert.match(rejected.result.content[0]?.text ?? '', /opaque next_before cursor/iu)

      const noticeResponse = await harness.gateway.request('/mcp/connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OAUTH_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: {
            name: 'later_holder_items',
            arguments: { mode: 'later_holder_notice' },
          },
        }),
      })
      assert.equal(noticeResponse.status, 200)
      assert.equal(noticeResponse.headers.get('cache-control'), 'no-store')
      assert.equal(harness.forwardedMethod(), 'POST')
      assert.deepEqual(harness.forwardedBody(), { mode: 'later_holder_notice' })

      await rpc(harness.gateway, 'tools/call', {
        name: 'mark_for_later',
        arguments: { thing_id: 31, action: 'mark' },
      }, `Bearer ${OAUTH_ACCESS_TOKEN}`)
      assert.equal(harness.forwardedMethod(), 'POST')
      assert.deepEqual(harness.forwardedBody(), { action: 'mark' })
    } finally {
      setOAuthResidentResolver(null)
      setPassiveOAuthResidentResolver(null)
    }
  })

  test('look reads one chosen thing or note in full and rejects mixed place options', async () => {
    setHostedChatFlag(true)
    const gateway = createAuthenticatedLookHarness({
      id: 31, name: 'Chosen thing', body: 'chosen full body', place_id: 4,
    })
    const read = await rpc(gateway, 'tools/call', {
      name: 'look', arguments: { thing_id: 31 },
    }, `Bearer ${OAUTH_ACCESS_TOKEN}`) as { result: ToolResult }
    assert.equal(read.result.isError, false)
    assert.match(read.result.content[0]!.text, /chosen full body/iu)

    const noteRead = await rpc(gateway, 'tools/call', {
      name: 'look', arguments: { note_id: 31 },
    }, `Bearer ${OAUTH_ACCESS_TOKEN}`) as { result: ToolResult }
    assert.equal(noteRead.result.isError, false)
    assert.match(noteRead.result.content[0]!.text, /chosen full body/iu)

    const look = toolByName(await listTools(gateway), 'look')
    assert.match(look.description, /note_id alone returns that note in full/iu)
    assert.deepEqual(look.inputSchema.properties?.note_id, {
      type: 'integer', minimum: 1,
      description: 'read this one public note in full; do not combine with place or paging options',
    })

    const mixed = await rpc(gateway, 'tools/call', {
      name: 'look', arguments: { thing_id: 31, place_id: 4 },
    }, `Bearer ${OAUTH_ACCESS_TOKEN}`) as { result: ToolResult }
    assert.equal(mixed.result.isError, true)
    assert.match(mixed.result.content[0]!.text, /choose|thing_id|place_id/iu)

    const mixedNote = await rpc(gateway, 'tools/call', {
      name: 'look', arguments: { note_id: 31, place_id: 4 },
    }, `Bearer ${OAUTH_ACCESS_TOKEN}`) as { result: ToolResult }
    assert.equal(mixedNote.result.isError, true)
    assert.match(mixedNote.result.content[0]!.text, /choose|note_id|place_id/iu)
  })

  test('hosted errors never send connector residents to the private browser or founder-only tool', async () => {
    setHostedChatFlag(true)
    const city = new Hono()
    city.post('/api/note', c => c.json({
      error: 'resident sign-in required; use the private browser flow at /join',
    }, 401))
    const gateway = new Hono()
    gateway.post('/mcp/connect', c => mcp(c, city, {
      hostedChat: true,
      forwardUnauthorizedStatus: false,
    }))

    const unauthorized = await rpc(gateway, 'tools/call', {
      name: 'say', arguments: { place_id: 2, body: 'hello square' },
    }, `Bearer ${OAUTH_ACCESS_TOKEN}`) as { result: ToolResult }
    const unauthorizedText = unauthorized.result.content[0]?.text ?? ''
    assert.match(unauthorizedText, /reconnect through your hosted chat app[^.]*1F3D9 sign-in/iu)
    assert.doesNotMatch(unauthorizedText, /private browser|\/join/iu)

    const moderate = await rpc(gateway, 'tools/call', {
      name: 'moderate',
      arguments: { action: 'remove', target_type: 'note', target_id: 1, reason: 'illegal content' },
    }, `Bearer ${OAUTH_ACCESS_TOKEN}`) as { result: ToolResult }
    const moderateText = moderate.result.content[0]?.text ?? ''
    assert.match(moderateText, /unavailable through hosted chat/iu)
    assert.match(moderateText, /founder resident #1[^.]*root key[^.]*key-capable/iu)
    assert.doesNotMatch(moderateText, /hosted sign-in|auth_required/iu)
    assert.equal(moderate.result._meta?.['mcp/www_authenticate'], undefined)
  })
}
