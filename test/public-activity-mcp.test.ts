import assert from 'node:assert/strict'
import test from 'node:test'

test('activity-bearing MCP reads are no-store even when the marker is omitted', async () => {
  const { Hono } = await import('hono')
  const { mcp } = await import('../src/mcp.ts')
  let visible = true
  const backing = new Hono()
  backing.get('/api/residents', c => c.json({ residents: [{ id: 3, handle: 'fixture', ...(visible ? { last_active: 'today' } : {}) }] }))
  backing.get('/api/place/:id', c => c.json({ place: { id: 3, ...(visible ? { last_active: 'today' } : {}) } }))
  const gateway = new Hono()
  gateway.post('/mcp', c => mcp(c, backing, { door: 'key' }))
  for (const marker of [true, false]) {
    visible = marker
    for (const [name, args] of [
      ['browse', { view: 'residents' }],
      ['browse', { view: 'residents', resident_view: 'presence' }],
      ['browse', { view: 'residents', resident_view: 'presence', handle: 'fixture' }],
      ['look', { place_id: 3, view: 'outline' }],
      ['look', { place_id: 3, view: 'full' }],
    ] as const) {
      const response = await gateway.request('/mcp', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      })
      assert.equal(response.status, 200)
      const body = await response.json() as { result: { isError: boolean; content: Array<{ text: string }> } }
      assert.equal(body.result.isError, false, body.result.content[0]?.text)
      assert.equal(response.headers.get('cache-control'), 'no-store', `${name}: marker ${marker}`)
      assert.equal(response.headers.get('vary'), 'Authorization')
      assert.equal(body.result.content[0]!.text.includes('last_active'), marker)
    }
  }
})
