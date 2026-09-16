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

const ARRIVAL = 'You stand in the world; the continents are one step down and open to enter (GET /api/map?view=outline&parent_id=195), first town is inside the mainland at place 2 and open to building, and go_home only works once you own land and can never be blocked once you have a home. A move crosses one parent-child edge at a time and you can walk back; for example, POST /api/action {"action":"move","to_place_id":1} moves you to the mainland; the city never moves you on its own: only your own action, or an effect a thing or a law runs where you stand, can move you.'
const WORLD_PURPOSE = 'You are standing in the world, the junction between continents. Nothing can be built, left, or written here. The mainland is one step down at place 1, and first town is one step below that at place 2, open to building.'
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
      assert.equal(body.place.purpose, WORLD_PURPOSE)
      assert.equal(body.place.owner_id, null)
      for (const field of ['open_to_building', 'open_to_things', 'open_to_notes']) {
        assert.equal(body.place[field], false)
      }
      for (const value of [body.notes, body.things, body.front_matter, body.place.labels, body.place.laws]) {
        assert.deepEqual(value, [])
      }
      const queries = fixtureState.current.calls.map(call => call.query ?? '').join('\n')
      assert.doesNotMatch(queries, /secret_hash|pending_effects|\b(?:insert|update|delete)\b/iu)
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

test('the world room itself carries the city line that points one step down', async () => {
  const { WORLD_ROOT_PURPOSE } = await import('../src/world-root.ts')
  assert.equal(WORLD_ROOT_PURPOSE, WORLD_PURPOSE)
  assert.ok([...WORLD_PURPOSE].length <= 280, 'a place purpose is at most 280 characters')
  for (const code of [10, 13, 8232, 8233]) {
    assert.equal(WORLD_PURPOSE.includes(String.fromCodePoint(code)), false, String(code))
  }
  assert.equal(WORLD_PURPOSE.includes(String.fromCodePoint(0x2014)), false, 'no em dash')

  reset({ scenario: 'root arrival', currentPlaceId: 195, homePlaceId: null })
  const looked = await app.request('/mcp', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'look', arguments: { place_id: 195 } },
    }),
  })
  assert.equal(looked.status, 200)
  const lookBody = await looked.json() as { result: { content: Array<{ text: string }> } }
  assert.equal(JSON.parse(lookBody.result.content[0]!.text).place.purpose, WORLD_PURPOSE)

  reset({ scenario: 'map outline' })
  const outline = await app.request('/api/map?view=outline&parent_id=1')
  assert.equal(outline.status, 200)
  const outlineBody = await outline.json() as { place: Record<string, unknown> }
  assert.equal(outlineBody.place.name, 'the world')
  assert.equal(outlineBody.place.owner, null)
  assert.equal(outlineBody.place.purpose, WORLD_PURPOSE)
})

test('an ordinary place keeps its own owner-written purpose', async () => {
  const { WORLD_ROOT_PURPOSE } = await import('../src/world-root.ts')
  reset({ currentPlaceId: 2 })
  const response = await app.request('/api/place/2')
  assert.equal(response.status, 200)
  const body = await response.json() as { place: Record<string, unknown> }
  assert.notEqual(body.place.purpose, WORLD_ROOT_PURPOSE)
})

test('served arrival words match the door mirrors and disclose server next_step guidance', async () => {
  for (const path of ['/reference/world-and-walking.txt']) {
    const response = await app.request(path)
    assert.equal(response.status, 200)
    const text = (await response.text()).replace(/\s+/gu, ' ')
    assert.ok(text.includes(ARRIVAL), path)
    assert.match(text, /server-written[^.]*next_step/iu, path)
  }
  for (const path of ['src/reference.txt', 'src/door.ts', 'docs/SYSTEM_DESIGN.md', 'docs/DECISIONS.md']) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    assert.ok(text.replace(/\s+/gu, ' ').includes(ARRIVAL), path)
  }
})

test('the served reference and the design record carry the world line the room read returns', async () => {
  const response = await app.request('/reference/world-and-walking.txt')
  assert.equal(response.status, 200)
  const served = (await response.text()).replace(/\s+/gu, ' ')
  assert.ok(served.includes(WORLD_PURPOSE), '/reference/world-and-walking.txt')
  assert.match(served, /has no owner[^.]*so this line is the city's own/iu)
  for (const path of ['src/door.ts', 'docs/SYSTEM_DESIGN.md']) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    assert.ok(text.replace(/\s+/gu, ' ').includes(WORLD_PURPOSE), path)
  }
  const source = readFileSync(new URL('../src/reference.txt', import.meta.url), 'utf8')
  assert.ok(source.includes('{{WORLD_ROOT_PURPOSE}}'), 'the reference renders the line from its constant')
  assert.equal(source.includes(WORLD_PURPOSE), false, 'the line is never retyped into served source text')
})
