import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { installFakeEnvironment, SECRET } from './helpers/routes-fixtures/environment.ts'
import { installFakeFetch } from './helpers/routes-fixtures/fake-fetch.ts'
import { fixtureState } from './helpers/routes-fixtures/state.ts'
import { reset } from './helpers/routes-fixtures/state-tools.ts'

installFakeEnvironment()
installFakeFetch()
const { default: app } = await import('../src/index.ts')
const { setEngineTransactionRunnerForTests } = await import('../src/engine.ts')
setEngineTransactionRunnerForTests(async (db, work) => work(db, false))
test.after(() => setEngineTransactionRunnerForTests(null))

const ARRIVAL = 'You stand in the world; the continents are one step down and open to enter (GET /api/map?view=outline&parent_id=195), first town is inside the mainland at place 2 and open to building, and go_home only works once you own land.'
const headers = { Authorization: `Bearer ${SECRET}` }

test('root me gives the fixed arrival line without replacing private attention', async () => {
  for (const homePlaceId of [null, 2]) {
    reset({ scenario: 'root arrival', currentPlaceId: 195, homePlaceId, attentionPendingGiftsCount: 1 })
    const response = await app.request('/api/me', { headers })
    assert.equal(response.status, 200)
    const body = await response.json() as Record<string, any>
    assert.equal(body.current_place_id, 195)
    assert.equal(body.home_place_id, homePlaceId)
    assert.equal(body.next_step, ARRIVAL)
    assert.deepEqual(body.attention, [
      'You have 1 pending 1F3D9 fee-credit gift awaiting accept or refuse; see city_fee_credit.pending_gifts.',
    ])
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
})

test('every root place view carries the same server line and remains passive with attached auth', async () => {
  for (const view of ['', '?view=outline', '?view=full']) {
    for (const requestHeaders of [{}, headers]) {
      reset({ scenario: 'root arrival', currentPlaceId: 195, homePlaceId: null })
      const response = await app.request(`/api/place/195${view}`, { headers: requestHeaders })
      assert.equal(response.status, 200)
      const body = await response.json() as Record<string, any>
      assert.equal(body.next_step, ARRIVAL)
      assert.equal(body.place.description, '')
      assert.equal(body.place.purpose, '')
      assert.equal(body.place.owner_id, null)
      for (const field of ['open_to_building', 'open_to_things', 'open_to_notes']) {
        assert.equal(body.place[field], false)
      }
      for (const value of [body.notes, body.things, body.front_matter, body.place.labels, body.place.laws]) {
        assert.deepEqual(value, [])
      }
      const queries = fixtureState.current.calls.map(call => call.query ?? '').join('\n')
      assert.doesNotMatch(queries, /secret_hash|resident_presence|pending_effects|\b(?:insert|update|delete)\b/iu)
    }
  }
})

test('ordinary me and place reads never claim the resident stands in the world', async () => {
  reset({ currentPlaceId: 2 })
  for (const path of ['/api/me', '/api/place/2', '/api/place/2?view=outline']) {
    const response = await app.request(path, { headers })
    assert.equal(response.status, 200)
    const body = await response.json() as Record<string, unknown>
    assert.equal(Object.hasOwn(body, 'next_step'), false)
  }
})

test('connector me and look preserve the root arrival line', async () => {
  for (const [name, args] of [['me', {}], ['look', { place_id: 195 }]] as const) {
    reset({ scenario: 'root arrival', currentPlaceId: 195, homePlaceId: null })
    const response = await app.request('/mcp', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
    assert.equal(response.status, 200)
    const body = await response.json() as { result: { content: Array<{ text: string }> } }
    assert.equal(JSON.parse(body.result.content[0]!.text).next_step, ARRIVAL)
  }
})

test('served arrival words match the door mirrors and disclose server next_step guidance', async () => {
  for (const path of ['/', '/llms.txt']) {
    const response = await app.request(path)
    assert.equal(response.status, 200)
    const text = (await response.text()).replace(/\s+/gu, ' ')
    assert.ok(text.includes(ARRIVAL), path)
    assert.match(text, /server-written[^.]*next_step/iu, path)
  }
  const published = readFileSync(new URL('../docs/published/FRONTDOOR.md', import.meta.url), 'utf8')
  assert.ok(published.replace(/\s+/gu, ' ').includes(ARRIVAL))
})
