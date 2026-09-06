import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'


export function registerMcpTests(): void {
  const {
    BUYER_WALLET,
    CONTRACT_DRAWING,
    CONTRACT_DRAWING_DESCRIPTION,
    OTHER_SECRET,
    SECRET,
    X_PAYMENT,
    app,
    authHeaders,
    fixtureState,
    inserted,
    reset,
    sqlCalls,
    test,
  } = getRoutesTestContext()


  test('MCP advertises the city tools and dispatches through bearer-header API auth', async () => {
    reset({ scenario: 'mcp', openToNotes: true })
    const listed = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(listed.status, 200)
    const listBody = await listed.json() as {
      result: { tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[] }
    }
    assert.deepEqual(listBody.result.tools.map(tool => tool.name), [
      'front_door', 'help', 'official_facts', 'physics', 'search', 'changes', 'look', 'browse',
      'drawing', 'drawing_history', 'credit_preflight', 'buy_credit', 'found', 'place_edit',
      'coin_trait', 'invent_kind', 'revise_kind', 'make', 'thing_edit', 'thing_upgrade',
      'draw_self', 'act', 'laws', 'home', 'withdraw',
      'list_world', 'claim_world', 'cancel_world', 'reconcile_world', 'credit_gift',
      'payment_attempt', 'transfer',
      'agree', 'open_agreement_accession', 'sign', 'say', 'flag', 'later_holder_items',
      'mark_for_later', 'me', 'moderate',
    ])
    assert.equal(listBody.result.tools.every(tool => !('secret' in (tool.inputSchema.properties ?? {}))), true)
    const transferTool = listBody.result.tools.find(tool => tool.name === 'transfer')
    assert.ok(transferTool?.inputSchema.properties && 'buyer_wallet' in transferTool.inputSchema.properties)
    const makeTool = listBody.result.tools.find(tool => tool.name === 'make')
    assert.ok(makeTool?.inputSchema.properties && 'open_to_use' in makeTool.inputSchema.properties)
    const lookTool = listBody.result.tools.find(tool => tool.name === 'look')
    assert.ok(lookTool?.inputSchema.properties && 'view' in lookTool.inputSchema.properties)
    assert.ok(lookTool?.inputSchema.properties && 'thing_id' in lookTool.inputSchema.properties)
    assert.ok(lookTool?.inputSchema.properties && 'subplace_text_limit_bytes' in lookTool.inputSchema.properties)
    assert.ok(lookTool?.inputSchema.properties && 'thing_text_limit_bytes' in lookTool.inputSchema.properties)
    assert.ok(lookTool?.inputSchema.properties && 'note_text_limit_bytes' in lookTool.inputSchema.properties)
    assert.equal(
      (lookTool?.inputSchema.properties?.thing_text_limit_bytes as { maximum?: number } | undefined)?.maximum,
      655_360,
    )

    fixtureState.current = { ...fixtureState.current, scenario: 'public pagination' }
    const outlined = await app.request('/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 11, method: 'tools/call',
        params: { name: 'look', arguments: { place_id: 2, thing_limit: 1 } },
      }),
    })
    const outlinedBody = await outlined.json() as {
      result: { isError: boolean; content: { text: string }[] }
    }
    assert.equal(outlinedBody.result.isError, false)
    const outlinedPlace = JSON.parse(outlinedBody.result.content[0]!.text) as {
      view: string
      subplaces: Array<{ description?: string; description_text_bytes: number }>
      things: Array<{ body?: string; body_text_bytes: number }>
      notes: Array<{ body?: string; body_text_bytes: number }>
    }
    assert.equal(outlinedPlace.view, 'outline')
    assert.equal(Object.hasOwn(outlinedPlace.subplaces[0]!, 'description'), false)
    assert.ok(outlinedPlace.subplaces[0]!.description_text_bytes > 0)
    assert.equal(Object.hasOwn(outlinedPlace.things[0]!, 'body'), false)
    assert.ok(outlinedPlace.things[0]!.body_text_bytes > 0)
    assert.equal(Object.hasOwn(outlinedPlace.notes[0]!, 'body'), false)
    assert.ok(outlinedPlace.notes[0]!.body_text_bytes > 0)

    const invalidMapPage = await app.request('/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'look', arguments: { limit: 1 } },
      }),
    })
    const invalidMapPageBody = await invalidMapPage.json() as {
      result: { isError: boolean; content: { text: string }[] }
    }
    assert.equal(invalidMapPageBody.result.isError, true)
    assert.match(invalidMapPageBody.result.content[0]!.text, /place_id.*paging|paging.*place_id/i)
    assert.equal(sqlCalls().some(call => /with recursive place_tree/i.test(call.query ?? '')), false)

    for (const key of ['secret', 'authorization', 'token', 'api_key', 'unexpected']) {
      const unsafeArgument = await app.request('/mcp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: { name: 'say', arguments: { [key]: SECRET, place_id: 2, body: 'unsafe' } },
        }),
      })
      const rejected = await unsafeArgument.json() as {
        result: { isError: boolean; content: { text: string }[] }
      }
      assert.equal(rejected.result.isError, true)
      assert.match(rejected.result.content[0]!.text, /authorization header|unsupported tool argument/i)
    }
    assert.equal(inserted('notes'), 0)

    const said = await app.request('/mcp', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'say', arguments: { place_id: 2, body: 'hello from the square' } },
      }),
    })
    const dispatched = await said.json() as { result: { isError: boolean; content: { text: string }[] } }
    assert.equal(dispatched.result.isError, false)
    assert.equal((JSON.parse(dispatched.result.content[0]!.text) as { note: { author: string } }).note.author, 'tiny-lantern')

    fixtureState.current = {
      ...fixtureState.current,
      actorId: 8,
      actorHandle: 'neighbor',
      offer: { id: 90, status: 'open', reservedAt: null, reservedUntil: null, buyerWallet: null },
    }
    const claim = await app.request('/mcp', {
      method: 'POST', headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: {
          name: 'transfer',
          arguments: { action: 'claim', offer_id: 90, buyer_wallet: BUYER_WALLET },
        },
      }),
    })
    const challenged = await claim.json() as { result: { isError: boolean; content: { text: string }[] } }
    assert.equal(challenged.result.isError, true)
    assert.match(challenged.result.content[0]!.text, /reservation opened|five minutes/i)
    assert.equal(fixtureState.current.offer.buyerWallet, BUYER_WALLET)
  })

  test('MCP drawing inputs have parity with every owner write and upgrade route', async () => {
    reset({ scenario: 'mcp drawing contract', openToNotes: true })
    const listed = await app.request('/mcp', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    const tools = (await listed.json() as {
      result: { tools: Array<{
        name: string
        inputSchema: { properties?: Record<string, unknown> }
        description: string
      }> }
    }).result.tools
    const byName = new Map(tools.map(tool => [tool.name, tool]))

    for (const name of ['place_edit', 'thing_edit', 'invent_kind', 'revise_kind']) {
      const properties = byName.get(name)?.inputSchema.properties ?? {}
      for (const field of ['drawing', 'drawing_state', 'drawing_description']) {
        assert.ok(field in properties, `${name} must advertise ${field}`)
      }
      const contractText = JSON.stringify(byName.get(name))
      assert.match(contractText, /REFUSE/u, `${name} must advertise the exact refusal value`)
      assert.match(contractText, /in_progress/u, `${name} must advertise explicit in-progress state`)
      assert.match(contractText, /complete/u, `${name} must advertise explicit complete state`)
    }
    for (const name of ['invent_kind', 'revise_kind']) {
      const schemaText = JSON.stringify(byName.get(name)?.inputSchema.properties?.drawing_variants)
      assert.match(schemaText, /maxItems[^0-9]*8/u)
      assert.match(schemaText, /uniqueItems|name/u)
      assert.match(byName.get(name)?.description ?? '', /owner|variant/iu)
    }
    for (const name of ['thing_edit', 'thing_upgrade']) {
      assert.ok('drawing_variant_name' in (byName.get(name)?.inputSchema.properties ?? {}), name)
    }

    const call = async (
      name: string,
      args: Record<string, unknown>,
      headers: Record<string, string> = authHeaders(),
    ) => {
      const response = await app.request('/mcp', {
        method: 'POST', headers,
        body: JSON.stringify({
          jsonrpc: '2.0', id: name, method: 'tools/call',
          params: { name, arguments: args },
        }),
      })
      assert.equal(response.status, 200, name)
      return await response.json() as {
        result: { isError: boolean; content: Array<{ text: string }> }
      }
    }

    reset({ scenario: 'mcp place drawing', placeOwnerId: 7 })
    const place = await call('place_edit', {
      place_id: 2,
      drawing: CONTRACT_DRAWING,
      drawing_state: 'complete',
      drawing_description: CONTRACT_DRAWING_DESCRIPTION,
    })
    assert.equal(place.result.isError, false, place.result.content[0]?.text)

    reset({ scenario: 'mcp typed thing refusal', thingOwnerId: 7, thingKindId: 3 })
    const thing = await call('thing_edit', {
      thing_id: 41,
      drawing: 'REFUSE',
      drawing_description: 'I decline to show the inherited drawing.',
    })
    assert.equal(thing.result.isError, false, thing.result.content[0]?.text)

    reset({
      scenario: 'mcp kind invention drawing',
      facilitatorVerify: true,
      facilitatorSettle: true,
    })
    const invention = await call('invent_kind', {
      name: 'mcp-painted-lantern',
      description: 'A kind with one deliberate variant.',
      traits: [],
      recipe: [],
      drawing: CONTRACT_DRAWING,
      drawing_state: 'complete',
      drawing_description: CONTRACT_DRAWING_DESCRIPTION,
      drawing_variants: [{
        name: 'ember',
        drawing: CONTRACT_DRAWING,
        drawing_state: 'complete',
        drawing_description: 'A low amber glow around the lantern base.',
      }],
    }, { ...authHeaders(), 'X-PAYMENT': X_PAYMENT })
    assert.equal(invention.result.isError, false, invention.result.content[0]?.text)

    reset({
      scenario: 'mcp kind revision drawing',
      facilitatorVerify: true,
      facilitatorSettle: true,
      kindDrawing: CONTRACT_DRAWING,
      kindDrawingState: 'complete',
      kindDrawingDescription: CONTRACT_DRAWING_DESCRIPTION,
    })
    const revision = await call('revise_kind', {
      kind_id: 3,
      drawing_variants: [],
    }, { ...authHeaders(), 'X-PAYMENT': X_PAYMENT })
    assert.equal(revision.result.isError, false, revision.result.content[0]?.text)

    reset({
      scenario: 'mcp thing upgrade variant',
      thingOwnerId: 7,
      thingKindId: 3,
      thingCurrentRevision: 1,
      thingDrawingVariant: null,
      kindRevision: 2,
      kindDrawingVariants: [{
        name: 'ember',
        drawing: CONTRACT_DRAWING,
        drawing_state: 'complete',
        drawing_description: 'A low amber glow around the lantern base.',
      }],
    })
    const upgrade = await call('thing_upgrade', { thing_id: 41, drawing_variant_name: 'ember' })
    assert.equal(upgrade.result.isError, false, upgrade.result.content[0]?.text)
  })

  test('public MCP reference tools return byte-identical web handler bodies', async () => {
    reset({ scenario: 'activity surfaces' })

    const webBytes = async (path: string): Promise<Buffer> => {
      const response = await app.request(path)
      assert.equal(response.status, 200, path)
      return Buffer.from(await response.arrayBuffer())
    }
    const toolBytes = async (name: string): Promise<Buffer> => {
      const response = await app.request('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: name,
          method: 'tools/call',
          params: { name, arguments: {} },
        }),
      })
      assert.equal(response.status, 200, name)
      const payload = await response.json() as {
        result?: { isError: boolean; content: Array<{ text: string }> }
        error?: { message?: string }
      }
      assert.ok(payload.result, payload.error?.message ?? `${name} returned no tool result`)
      assert.equal(payload.result.isError, false, name)
      assert.equal(payload.result.content.length, 1, name)
      return Buffer.from(payload.result.content[0]!.text, 'utf8')
    }

    for (const [name, path] of [
      ['front_door', '/'],
      ['official_facts', '/api/official'],
      ['physics', '/api/physics'],
    ] as const) {
      assert.deepEqual(await toolBytes(name), await webBytes(path), name)
    }
  })
}
