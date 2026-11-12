import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { auth, setOAuthResidentResolver } from '../../src/core.ts'
import { mcp } from '../../src/mcp.ts'
import { mountOAuthRoutes, residentByOAuthAccessToken } from '../../src/oauth.ts'
import { EXISTING_KEY, MemoryOAuthStore } from './memory-oauth-store.ts'
import {
  CLIENT_ID,
  ORIGIN,
  RESOURCE,
  authorizationCode,
  authorizationUrl,
  begin,
  browserPost,
  environment,
  exchangeCode,
  readTokenPair,
} from './fixture.ts'

const APP_RESOURCE = `${ORIGIN}/mcp/app`
const DOORS = { connect: RESOURCE, app: APP_RESOURCE } as const
type Door = keyof typeof DOORS
type OAuthStore = MemoryOAuthStore['api']

// Decision 190: a connector address with a short query suffix is that connector at sign-in.
// Every resource value the sign-in routes hand to storage is recorded, so a test can
// prove that only the plain door address is ever stored or bound. The door checks below
// read the unrecorded store directly.
function recordingStore(memory: MemoryOAuthStore): { store: OAuthStore; resources: string[] } {
  const resources: string[] = []
  const store = new Proxy(memory.api, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver) as unknown
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        for (const arg of args) {
          if (arg && typeof arg === 'object' && 'resource' in arg) {
            resources.push(String((arg as { resource: unknown }).resource))
          }
        }
        return (value as (...inner: unknown[]) => unknown).apply(target, args)
      }
    },
  }) as OAuthStore
  return { store, resources }
}

function signinFixture() {
  const memory = new MemoryOAuthStore()
  const { store, resources } = recordingStore(memory)
  const app = new Hono()
  app.onError(() => new Response('Internal Server Error', { status: 500 }))
  mountOAuthRoutes(app, {
    environment,
    store,
    fetcher: (async input => {
      throw new Error(`unexpected network call: ${String(input)}`)
    }) as typeof fetch,
    pairingEnabled: true,
  })
  return { app, store: memory.api, resources }
}

// The two hosted doors, backed by one city route that needs a signed-in resident.
function doorGateway(): Hono {
  const city = new Hono()
  city.get('/api/me', async c => {
    const resident = await auth(c)
    if (!resident) return c.json({ error: 'A valid resident sign-in is required.' }, 401)
    return c.json({ resident: { id: resident.id, handle: resident.handle } })
  })
  const gateway = new Hono()
  gateway.post('/mcp/connect', c => mcp(c, city, { door: 'connect', forwardUnauthorizedStatus: false }))
  gateway.post('/mcp/app', c => mcp(c, city, { door: 'app', forwardUnauthorizedStatus: false }))
  return gateway
}

async function callMe(gateway: Hono, address: string, accessToken: string) {
  const response = await gateway.request(address, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'me', arguments: {} } }),
  })
  assert.equal(response.status, 200)
  const body = await response.json() as { result?: { isError?: boolean; content?: { text: string }[] } }
  const text = (body.result?.content ?? []).map(part => part.text).join('\n')
  return { ok: body.result?.isError !== true && /chatty/u.test(text), text }
}

async function withDoorResolver<T>(store: OAuthStore, run: () => Promise<T>): Promise<T> {
  const previous = {
    enabled: process.env.HOSTED_CHAT_SIGNIN_ENABLED,
    origin: process.env.PUBLIC_ORIGIN,
  }
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  process.env.PUBLIC_ORIGIN = ORIGIN
  setOAuthResidentResolver((token, door) => residentByOAuthAccessToken(token, environment, store, door))
  try {
    return await run()
  } finally {
    setOAuthResidentResolver(null)
    if (previous.enabled === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
    else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previous.enabled
    if (previous.origin === undefined) delete process.env.PUBLIC_ORIGIN
    else process.env.PUBLIC_ORIGIN = previous.origin
  }
}

function refresh(app: Hono, resource: string, refreshToken: string) {
  return app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, resource, refresh_token: refreshToken }),
  })
}

function revoke(app: Hono, token: string) {
  return app.request('/oauth/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, token }),
  })
}

interface RoundTrip {
  authorize: string
  token: string
  refresh: string
  callAt: string
}

async function roundTrip(door: Door, steps: RoundTrip): Promise<void> {
  const { app, store, resources } = signinFixture()
  const gateway = doorGateway()
  const other: Door = door === 'connect' ? 'app' : 'connect'
  const label = JSON.stringify(steps)
  await withDoorResolver(store, async () => {
    const session = await begin(app, authorizationUrl({ resource: steps.authorize }))
    const code = authorizationCode(await browserPost(app, session, {
      action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
    }))
    const pair = await readTokenPair(await exchangeCode(app, code, { resource: steps.token }))
    assert.equal((await residentByOAuthAccessToken(pair.access_token, environment, store, door))?.id, 49, label)
    assert.equal(await residentByOAuthAccessToken(pair.access_token, environment, store, other), null, label)

    const refreshed = await readTokenPair(await refresh(app, steps.refresh, pair.refresh_token))
    const atDoor = await callMe(gateway, steps.callAt, refreshed.access_token)
    assert.equal(atDoor.ok, true, `${label}: ${atDoor.text}`)
    const atOtherDoor = await callMe(gateway, `/mcp/${other}?2`, refreshed.access_token)
    assert.equal(atOtherDoor.ok, false, `${label}: a token for one door never works at the other`)

    assert.equal((await revoke(app, refreshed.refresh_token)).status, 200)
    assert.equal(await residentByOAuthAccessToken(refreshed.access_token, environment, store, door), null, label)
    assert.equal((await callMe(gateway, steps.callAt, refreshed.access_token)).ok, false, label)
    assert.equal((await refresh(app, steps.refresh, refreshed.refresh_token)).status, 400, label)
  })
  assert.ok(resources.length > 0)
  for (const stored of resources) assert.equal(stored, DOORS[door], `${label}: only the plain door address is stored or bound`)
}

export function registerSuffixedResourceTests(): void {
  test('sign-in shows the sign-in page for either door named with a short suffix (decision 190)', async () => {
    for (const [resource, appDoor] of [
      [`${RESOURCE}?2`, false],
      [`${RESOURCE}?=2`, false],
      [`${RESOURCE}?agent=work&n=2`, false],
      [`${RESOURCE}?${'a'.repeat(128)}`, false],
      [`${APP_RESOURCE}?2`, true],
      [`${APP_RESOURCE}?a.b_c-d~e=1`, true],
    ] as const) {
      const { app, resources } = signinFixture()
      const page = (await begin(app, authorizationUrl({ resource }))).html
      if (appDoor) assert.match(page, /Paid actions spend the resident's own fee credit\./u, resource)
      else assert.match(page, /It cannot change the resident key\. It can use the resident's fee credit\./u, resource)
      assert.deepEqual(resources, [appDoor ? APP_RESOURCE : RESOURCE], resource)
    }
  })

  test('a suffixed connector address works at every sign-in step, for both doors (decision 190)', async () => {
    for (const door of ['connect', 'app'] as const) {
      const plain = DOORS[door]
      // The suffixed address at every step.
      await roundTrip(door, {
        authorize: `${plain}?2`, token: `${plain}?2`, refresh: `${plain}?2`, callAt: `/mcp/${door}?2`,
      })
      // Only at the authorize request.
      await roundTrip(door, {
        authorize: `${plain}?=2`, token: plain, refresh: plain, callAt: `/mcp/${door}`,
      })
      // Only at the token endpoint, with a different suffix on refresh.
      await roundTrip(door, {
        authorize: plain, token: `${plain}?2`, refresh: `${plain}?other=3`, callAt: `/mcp/${door}?2`,
      })
    }
  })

  test('a code made for one suffixed door cannot be spent on the other door (decision 190)', async () => {
    const { app } = signinFixture()
    const session = await begin(app, authorizationUrl({ resource: `${RESOURCE}?2` }))
    const code = authorizationCode(await browserPost(app, session, {
      action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
    }))
    const wrong = await exchangeCode(app, code, { resource: `${APP_RESOURCE}?2` })
    assert.equal(wrong.status, 400)
    assert.deepEqual(await wrong.json(), { error: 'invalid_grant' })
  })

  test('every other near-match address is still refused at sign-in and at the token endpoint (decision 190)', async () => {
    const credential = `1f3d9_sk_${'ab'.repeat(24)}`
    for (const resource of [
      `${RESOURCE}/`,
      `${RESOURCE}/?2`,
      `${RESOURCE}/2`,
      `${ORIGIN}/mcp`,
      `${ORIGIN}/mcp?2`,
      `${ORIGIN}/mcp/connectx?2`,
      'https://1f3d9.com.example.test/mcp/connect?2',
      'http://1f3d9.com/mcp/connect?2',
      'HTTPS://1F3D9.COM/mcp/connect?2',
      `${RESOURCE}#2`,
      `${RESOURCE}?2#2`,
      `${RESOURCE}?`,
      `${RESOURCE}??2`,
      `${RESOURCE}?a b`,
      `${RESOURCE}?a%20b`,
      `${RESOURCE}?a/b`,
      `${RESOURCE}?a+b`,
      `${RESOURCE}?a?b`,
      `${RESOURCE}?${'a'.repeat(129)}`,
      `${RESOURCE}?key=${credential}`,
      `${APP_RESOURCE}?${credential}`,
    ]) {
      const { app, resources } = signinFixture()
      const refused = await app.request(authorizationUrl({ resource }))
      assert.equal(refused.status, 400, resource)
      assert.doesNotMatch(await refused.text(), new RegExp(credential, 'u'))
      const token = await refresh(app, resource, `1f3d9_rt_${'ab'.repeat(32)}`)
      assert.equal(token.status, 400, resource)
      assert.deepEqual(await token.json(), { error: 'invalid_client' }, resource)
      const exchange = await exchangeCode(app, `1f3d9_ac_${'cd'.repeat(32)}`, { resource })
      assert.equal(exchange.status, 400, resource)
      assert.deepEqual(await exchange.json(), { error: 'invalid_client' }, resource)
      assert.deepEqual(resources, [], `${resource} never reaches storage`)
    }
  })
}
