import assert from 'node:assert/strict'
import test from 'node:test'
import type { Hono } from 'hono'
import { sha256 } from '../../src/core.ts'
import { EXISTING_KEY, MemoryOAuthStore } from './memory-oauth-store.ts'
import {
  CALLBACK,
  STATE,
  authorizationCode,
  begin,
  browserPost,
  exchangeCode,
  fixture,
  readTokenPair,
  type BrowserSession,
} from './fixture.ts'

interface SafeState {
  residents: { handle: string }[]
  events: { kind: string; actor: string }[]
  codes: unknown[]
  tokens: unknown[]
}

function stateOf(memory: MemoryOAuthStore): SafeState {
  return JSON.parse(memory.safeState()) as SafeState
}

async function stage(app: Hono, handle: string): Promise<{ session: BrowserSession; key: string }> {
  const session = await begin(app)
  const staged = await browserPost(app, session, {
    action: 'register', csrf: session.csrf, handle, model: '',
  })
  assert.equal(staged.status, 200)
  const key = (await staged.text()).match(/1f3d9_sk_[0-9a-f]{48}/u)?.[0]
  assert.ok(key)
  return { session, key }
}

function confirm(app: Hono, session: BrowserSession, key: string): Promise<Response> {
  return browserPost(app, session, { action: 'confirm', csrf: session.csrf, resident_key: key })
}

function assertOneResident(memory: MemoryOAuthStore, handle: string): void {
  const state = stateOf(memory)
  assert.equal(state.residents.filter(resident => resident.handle === handle).length, 1)
  assert.equal(state.events.filter(event => event.kind === 'register' && event.actor === handle).length, 1)
}

async function assertAlreadyLives(response: Response, handle: string): Promise<void> {
  assert.equal(response.status, 403)
  assert.equal(response.headers.get('x-1f3d9-reason'), 'request_unavailable')
  assert.equal(response.headers.get('location'), null)
  assert.match(await response.text(), new RegExp(`${handle}[^.]*already lives`, 'iu'))
}

export function registerFinalButtonRepeatTests(): void {
  test('a second tap on the last signup button returns the same unused code to the chat app', async () => {
    const { app, memory } = fixture()
    const { session, key } = await stage(app, 'double-tap-resident')

    const first = authorizationCode(await confirm(app, session, key))
    const repeat = await confirm(app, session, key)
    assert.match(repeat.headers.get('set-cookie') ?? '', /Max-Age=0/iu)
    assert.equal(authorizationCode(repeat), first)

    await readTokenPair(await exchangeCode(app, first))
    const again = await exchangeCode(app, first)
    assert.equal(again.status, 400)
    assert.deepEqual(await again.json(), { error: 'invalid_grant' })
    assertOneResident(memory, 'double-tap-resident')
  })

  test('a repeat after the code was exchanged says sign-in finished and issues nothing', async () => {
    const { app, memory } = fixture()
    const { session, key } = await stage(app, 'finished-resident')
    const code = authorizationCode(await confirm(app, session, key))
    await readTokenPair(await exchangeCode(app, code))
    const before = stateOf(memory)

    const repeat = await confirm(app, session, key)
    assert.equal(repeat.status, 200)
    assert.equal(repeat.headers.get('location'), null)
    assert.match(repeat.headers.get('cache-control') ?? '', /no-store/iu)
    assert.match(repeat.headers.get('set-cookie') ?? '', /Max-Age=0/iu)
    const body = await repeat.text()
    assert.match(body, /<h1>Sign-in finished<\/h1>/u)
    assert.match(body, /Go back to the chat app\./u)
    assert.doesNotMatch(body, /already lives|1f3d9_sk_|1f3d9_ac_|1f3d9_rc_/u)
    assert.doesNotMatch(body, /–|—/u)

    const after = stateOf(memory)
    assert.equal(after.codes.length, before.codes.length)
    assert.equal(after.tokens.length, before.tokens.length)
    assertOneResident(memory, 'finished-resident')
  })

  test('two overlapping taps on the last signup button create one resident and return one code', async () => {
    const { app, memory } = fixture()
    const { session, key } = await stage(app, 'overlap-resident')
    const [first, second] = await Promise.all([confirm(app, session, key), confirm(app, session, key)])
    const code = authorizationCode(first)
    assert.equal(authorizationCode(second), code)
    await readTokenPair(await exchangeCode(app, code))
    assertOneResident(memory, 'overlap-resident')
  })

  test('repeating "Connect my resident" or a pairing approval returns the same code', async () => {
    {
      const { app } = fixture()
      const session = await begin(app)
      const link = () => browserPost(app, session, { action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY })
      const code = authorizationCode(await link())
      assert.equal(authorizationCode(await link()), code)
      await readTokenPair(await exchangeCode(app, code))
      const finished = await link()
      assert.equal(finished.status, 200)
      assert.match(await finished.text(), /<h1>Sign-in finished<\/h1>/u)
    }

    {
      const { app, memory } = fixture()
      const pairingCode = `1f3d9_pc_${'ef'.repeat(32)}`
      await memory.api.mintPairingCode({ residentId: 49, codeHash: sha256(pairingCode) })
      const session = await begin(app)
      const pair = () => browserPost(app, session, { action: 'pair_confirm', csrf: session.csrf, pairing_code: pairingCode })
      const code = authorizationCode(await pair())
      assert.equal(authorizationCode(await pair()), code)
      await readTokenPair(await exchangeCode(app, code))
    }
  })

  test('nothing is replayed for another browser, another request or a lapsed code', async () => {
    const { app, memory } = fixture()
    const { session, key } = await stage(app, 'bound-resident')
    const code = authorizationCode(await confirm(app, session, key))

    const noCookie = await browserPost(app, { ...session, cookie: '' }, {
      action: 'confirm', csrf: session.csrf, resident_key: key,
    })
    assert.equal(noCookie.status, 403)
    assert.equal(noCookie.headers.get('x-1f3d9-reason'), 'browser_cookie_missing')

    const other = await begin(app)
    for (const response of [
      await browserPost(app, other, { action: 'confirm', csrf: session.csrf, resident_key: key }),
      await browserPost(app, { ...session, cookie: other.cookie }, { action: 'confirm', csrf: session.csrf, resident_key: key }),
    ]) {
      assert.equal(response.status, 403)
      assert.equal(response.headers.get('x-1f3d9-reason'), 'browser_cookie_mismatch')
      assert.doesNotMatch(await response.text(), new RegExp(code, 'u'))
    }
    const fresh = await confirm(app, other, key)
    assert.equal(fresh.status, 403)
    assert.equal(fresh.headers.get('location'), null)
    assert.doesNotMatch(await fresh.text(), new RegExp(code, 'u'))

    await assertAlreadyLives(
      await browserPost(app, session, { action: 'cancel', csrf: session.csrf }),
      'bound-resident',
    )

    memory.expireAuthorizationCode(code)
    await assertAlreadyLives(await confirm(app, session, key), 'bound-resident')
    assertOneResident(memory, 'bound-resident')
  })

  test('a code the city did not derive from this browser is never replayed', async () => {
    const { app, memory } = fixture()
    const { session, key } = await stage(app, 'foreign-code-resident')
    const original = memory.api.confirmNewResidentAndIssueAuthorizationCode
    memory.api.confirmNewResidentAndIssueAuthorizationCode = input => original({
      ...input,
      authorizationCodeHash: sha256('a code minted some other way'),
    })
    const response = await confirm(app, session, key)
    assert.equal(response.status, 303)
    await assertAlreadyLives(await confirm(app, session, key), 'foreign-code-resident')
    assert.equal(new URL(response.headers.get('location') ?? '').searchParams.get('state'), STATE)
    assert.equal(`${new URL(response.headers.get('location') ?? '').origin}/oauth/callback`, CALLBACK)
  })
}
