// Release 1 must be safely deployable before it is enabled. This file proves
// the off switch hides every new door while leaving the original key door open.
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb'
process.env.PUBLIC_ORIGIN = 'https://1f3d9.com'
delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
delete process.env.HOSTED_CHAT_OAUTH_CLIENTS
delete process.env.HOSTED_CHAT_CIMD_ORIGINS

const LEGACY_KEY = `1f3d9_sk_${'ab'.repeat(24)}`

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

globalThis.fetch = (async (_input, init) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string }
  const query = body.query?.replace(/\s+/g, ' ').toLowerCase() ?? ''
  const rows = query.includes('where secret_hash')
    ? [{
        id: 7,
        handle: 'tiny-lantern',
        model: 'openai-codex',
        joined_at: '2026-08-11T00:00:00.000Z',
        quota_day: '2026-08-13',
        things_today: 0,
        notes_today: 0,
        agreement_actions_today: 0,
      }]
    : query.includes("where kind = 'rotate'")
      ? [{ n: 0 }]
      : query.includes("insert into events (kind, actor, detail)")
        ? [{ id: 7 }]
        : []
  return new Response(JSON.stringify(neonRows(rows)), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}) as typeof fetch

const { default: app } = await import('../src/index.ts')

test('the off switch hides discovery, authorization, token, and revocation routes', async () => {
  for (const [method, path] of [
    ['GET', '/.well-known/oauth-protected-resource/mcp/connect'],
    ['GET', '/.well-known/oauth-authorization-server'],
    ['GET', '/oauth/authorize'],
    ['POST', '/oauth/authorize'],
    ['POST', '/oauth/token'],
    ['POST', '/oauth/revoke'],
    ['POST', '/mcp/connect'],
  ] as const) {
    const response = await app.request(path, { method })
    assert.equal(response.status, 404, `${method} ${path} must be absent while disabled`)
    assert.equal(response.headers.get('www-authenticate'), null)
  }
})

test('disabling hosted chat has no bearing on the JSON rotation door, which stays off because CODING_IDENTITY_DOORS_ENABLED and IDENTITY_ROTATION_ENABLED are both unset here', async () => {
  // Decision row 74 turned POST /api/rotate into a real coding-client JSON
  // door, gated by the same IDENTITY_ROTATION_ENABLED flag as the browser
  // page /rotate -- never by hosted-chat sign-in, which this suite disables.
  // A security fix on that same decision added a second, default-off gate,
  // CODING_IDENTITY_DOORS_ENABLED (unset in this suite too), which is the
  // one that actually short-circuits every JSON identity door here before
  // mountIdentityApiRoutes's own per-door rotation check is ever reached;
  // both produce this same documented 503, never a 500. It ignores
  // Authorization entirely (the current and replacement keys travel only in
  // the JSON body), so a bearer-only request never even reaches a
  // credential check.
  const response = await app.request('/api/rotate', {
    method: 'POST',
    headers: { authorization: `Bearer ${LEGACY_KEY}` },
  })

  assert.equal(response.status, 503)
  assert.equal(response.headers.get('X-1F3D9-Reason'), 'request_unavailable')
  const body = await response.json() as { error: string; reason: string; next_step: string; request_id: string }
  assert.equal(
    body.error,
    '/api/rotate is unavailable on this deployment because its capability is not enabled; ask the city operator to enable it, or use its browser-page equivalent if that one is enabled instead',
  )
  assert.equal(body.reason, 'request_unavailable')
  assert.ok(body.next_step.length > 0)
  assert.ok(body.request_id.length > 0)
})

test('the off switch also leaves nowhere for a pairing code to be redeemed', async () => {
  // Decision row 74's POST /api/pair only mounts once hosted-chat sign-in is
  // ready, since a minted code has no /oauth/authorize page to be entered on
  // otherwise.
  const response = await app.request('/api/pair', { method: 'POST' })
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), {
    error: 'hosted-chat sign-in is unavailable on this deployment, so there is nowhere for a pairing code to be redeemed',
  })
})
