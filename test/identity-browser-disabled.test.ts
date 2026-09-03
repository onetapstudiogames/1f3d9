// Security-review fix: when PUBLIC_ORIGIN is invalid, IDENTITY_BROWSER_READY
// is false and every identity route (browser pages and the JSON identity
// doors alike) must answer the same documented refusal shape every other
// identity door uses -- reason, next_step, request_id, and the
// X-1F3D9-Reason header -- never a bare {error} body.
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb'
process.env.PUBLIC_ORIGIN = 'http://insecure.example'
delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
delete process.env.HOSTED_CHAT_OAUTH_CLIENTS
delete process.env.HOSTED_CHAT_CIMD_ORIGINS

function neonRows(rows: Record<string, unknown>[]) {
  const names = rows[0] ? Object.keys(rows[0]) : []
  const type = (value: unknown) => typeof value === 'number' ? 23 : 25
  return {
    command: 'SELECT',
    rowCount: rows.length,
    fields: names.map(name => ({ name, dataTypeID: type(rows[0]?.[name]) })),
    rows: rows.map(row => names.map(name => row[name] == null ? null : String(row[name]))),
  }
}

globalThis.fetch = (async () => new Response(JSON.stringify(neonRows([])), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})) as typeof fetch

const { default: app } = await import('../src/index.ts')

test('every identity route answers the same documented refusal shape when identity infrastructure is not ready', async () => {
  for (const [method, path] of [
    ['GET', '/join'],
    ['GET', '/rotate'],
    ['GET', '/recovery'],
    ['POST', '/api/register'],
    ['POST', '/api/rotate'],
    ['POST', '/api/recovery'],
  ] as const) {
    const response = await app.request(path, { method })
    assert.equal(response.status, 503, `${method} ${path}`)
    assert.equal(response.headers.get('X-1F3D9-Reason'), 'request_unavailable', `${method} ${path}`)
    assert.equal(response.headers.get('Cache-Control'), 'no-store', `${method} ${path}`)
    const body = await response.json() as { error: string; reason: string; next_step: string; request_id: string }
    assert.equal(
      body.error,
      'identity routes are unavailable on this deployment because required identity infrastructure is not ready; ask the city operator to enable it',
      `${method} ${path}`,
    )
    assert.equal(body.reason, 'request_unavailable', `${method} ${path}`)
    assert.ok(body.next_step.length > 0, `${method} ${path}`)
    assert.ok(body.request_id.length > 0, `${method} ${path}`)
  }
})
