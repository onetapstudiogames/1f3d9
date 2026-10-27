import assert from 'node:assert/strict'
import test from 'node:test'

test('place front matter refusals state the accepted shape through HTTP and MCP', async t => {
  const { installFakeEnvironment, SECRET } = await import('./helpers/routes-fixtures/environment.ts')
  installFakeEnvironment()
  const { installFakeFetch } = await import('./helpers/routes-fixtures/fake-fetch.ts')
  const previousFetch = globalThis.fetch
  installFakeFetch()
  const { default: app } = await import('../src/index.ts')
  const { setEngineTransactionRunnerForTests } = await import('../src/engine.ts')
  const { reset } = await import('./helpers/routes-fixtures/state-tools.ts')
  const { fixtureState } = await import('./helpers/routes-fixtures/state.ts')
  setEngineTransactionRunnerForTests(async (db, work) => work(db, false))
  t.after(() => {
    globalThis.fetch = previousFetch
    setEngineTransactionRunnerForTests(null)
  })
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` }
  const cases = [
    { name: 'one id', value: [41], reason: 'you sent one id' },
    { name: 'one id beside a description', value: [41], description: 'a place made from words', reason: 'you sent one id' },
    { name: 'string', value: '[41]', reason: 'you did not send a list of ids' },
    { name: 'null', value: null, reason: 'you did not send a list of ids' },
    { name: 'four ids', value: [41, 42, 43, 44], reason: 'you sent 4 ids' },
    { name: 'repeated id', value: [41, 41], reason: 'you repeated an id' },
    { name: 'string id in a list', value: ['41', 42], reason: 'every id must be a positive whole number' },
    { name: 'zero id', value: [0, 42], reason: 'every id must be a positive whole number' },
    { name: 'another room', value: [41, 42], state: { frontMatterMovedThingIds: [42] }, reason: 'an id is not an active public thing standing in this place' },
    { name: 'withdrawn thing', value: [41, 42], state: { targetThingWithdrawn: true }, reason: 'an id is not an active public thing standing in this place' },
    { name: 'hidden thing', value: [41, 42], state: { frontMatterHiddenThingIds: [42] }, reason: 'an id is not an active public thing standing in this place' },
  ]

  for (const entry of cases) {
    for (const door of ['HTTP', 'MCP']) {
      await t.test(`${door}: ${entry.name}`, async () => {
        reset({
          scenario: 'room orientation', placeOwnerId: 7,
          roomPurpose: 'A reading room.', frontMatterThingIds: [41, 42], ...entry.state,
        })
        const patch = {
          front_matter_thing_ids: entry.value,
          ...(entry.description === undefined ? {} : { description: entry.description }),
        }
        const response = await app.request(door === 'HTTP' ? '/api/place/2' : '/mcp', {
          method: door === 'HTTP' ? 'PATCH' : 'POST', headers,
          body: JSON.stringify(door === 'HTTP' ? patch : {
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'place_edit', arguments: { place_id: 2, ...patch } },
          }),
        })
        assert.equal(response.status, door === 'HTTP' ? 400 : 200)
        const body = await response.json()
        if (door === 'MCP') assert.equal(body.result.isError, true)
        const message = door === 'HTTP' ? body.error : body.result.content[0].text
        assert.match(message, /front_matter_thing_ids must be an empty list, or two or three distinct ids of active public things standing in this place/u)
        assert.ok(message.includes(entry.reason), message)
        assert.equal(fixtureState.current.roomPurpose, 'A reading room.')
        assert.deepEqual(fixtureState.current.frontMatterThingIds, [41, 42])
      })
    }
  }

  for (const code of ['23514', '23503']) {
    await t.test(`eligibility changed during the edit: ${code}`, async () => {
      reset({ scenario: 'room orientation', placeOwnerId: 7, frontMatterThingIds: [41, 42] })
      const fakeFetch = globalThis.fetch
      globalThis.fetch = async (input, init) => {
        if (String(input).includes('/sql') && typeof init?.body === 'string'
            && init.body.includes('WITH candidate_locks AS MATERIALIZED')) {
          return Response.json({ message: 'chosen thing changed', code }, { status: 400 })
        }
        return fakeFetch(input, init)
      }
      try {
        const response = await app.request('/api/place/2', {
          method: 'PATCH', headers, body: JSON.stringify({ front_matter_thing_ids: [43, 41] }),
        })
        assert.equal(response.status, 409)
        assert.equal((await response.json()).error, 'front_matter_thing_ids must be an empty list, or two or three distinct ids of active public things standing in this place; a chosen thing changed before the edit completed; retry')
        assert.deepEqual(fixtureState.current.frontMatterThingIds, [41, 42])
      } finally {
        globalThis.fetch = fakeFetch
      }
    })
  }

  for (const ids of [[], [42, 41], [43, 41, 42]]) {
    await t.test(`accepted selection: ${JSON.stringify(ids)}`, async () => {
      reset({ scenario: 'room orientation', placeOwnerId: 7, frontMatterThingIds: [41, 42] })
      const response = await app.request('/api/place/2', {
        method: 'PATCH', headers, body: JSON.stringify({ front_matter_thing_ids: ids }),
      })
      assert.equal(response.status, 200, await response.clone().text())
      assert.deepEqual(fixtureState.current.frontMatterThingIds, ids)
    })
  }
})
