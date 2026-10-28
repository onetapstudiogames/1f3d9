import assert from 'node:assert/strict'
import test from 'node:test'

test('the app mounts the protected showing room cron with six Monday retries before print', async () => {
  const { readFile } = await import('node:fs/promises')
  const { default: app } = await import('../src/index.ts')
  const previousSecret = process.env.CRON_SECRET
  process.env.CRON_SECRET = `synthetic_cron_${'7b'.repeat(32)}`
  try {
    const response = await app.request('/api/internal/showing-room-close')
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = await response.json()
    assert.equal(typeof body.error, 'string')
    assert.deepEqual(Object.keys(body).filter(key => ![
      'error', 'request_id', 'error_class', 'http_status', 'front_door_tool', 'front_door',
    ].includes(key)), [])
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = previousSecret
  }
  const configuration = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'))
  assert.deepEqual(configuration.crons.filter((entry: {path:string}) => entry.path === '/api/internal/showing-room-close'), [
    { path: '/api/internal/showing-room-close', schedule: '0,10,20,30,40,50 15 * * 1' },
  ])
  assert.ok(configuration.crons.some((entry: {path:string,schedule:string}) =>
    entry.path === '/api/internal/gazette-print' && entry.schedule === '0 16 * * 1'))
})

test('showing room help and quota exceptions agree across public HTTP and MCP reads', async () => {
  const { default: app } = await import('../src/index.ts')
  const { CITY_HELP_DOORS } = await import('../src/city-help.ts')
  const { CITY_LIMIT_LINES } = await import('../src/city-facts.ts')
  const line = CITY_HELP_DOORS.find(value => value.startsWith('The showing room:'))!
  assert.match(line, /after founder activation.*Monday at 15:00 UTC.*before 16:00 UTC/u)
  assert.match(line, /question ten stays manual/u)
  assert.doesNotMatch(line, /['&<>]/u)
  const help = await (await app.request('/api/help')).json()
  assert.ok(help.doors.includes(line))
  const quotaLines = CITY_LIMIT_LINES.filter(value => /^(?:Daily quotas|Gazette):/u.test(value))
  assert.equal(quotaLines.length, 2)
  assert.ok(quotaLines.every(value => value.includes('showing room service')))
  const official = await (await app.request('/api/official')).json()
  for (const quota of quotaLines) assert.ok(official.enforced_limits.includes(quota))
  for (const path of ['/', '/llms.txt']) {
    const response = await app.request(path)
    assert.equal(response.status, 200)
    const text = await response.text()
    for (const quota of quotaLines) assert.ok(text.includes(quota), `${path}: ${quota}`)
  }
  const { Hono } = await import('hono')
  const { mcp } = await import('../src/mcp.ts')
  const previousHosted = process.env.HOSTED_CHAT_SIGNIN_ENABLED
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  try {
    for (const door of ['key', 'connect'] as const) {
      const path = door === 'key' ? '/mcp' : '/mcp/connect'
      const gateway = new Hono()
      gateway.post(path, c => mcp(c, app, { door, authenticateLegacyCatalog: async () => true }))
      const response = await gateway.request(path, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-only' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'help', arguments: {} } }),
      })
      assert.equal(response.status, 200)
      assert.ok(JSON.stringify(await response.json()).includes(line), path)
    }
  } finally {
    if (previousHosted === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
    else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previousHosted
  }
})
