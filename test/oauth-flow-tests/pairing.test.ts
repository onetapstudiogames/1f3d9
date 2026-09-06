import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { sha256 } from '../../src/core.ts'
import {
  mountOAuthRoutes,
  type OAuthDiagnosticRecord,
} from '../../src/oauth.ts'
import { PAIRING_CODE_PREFIX } from '../../src/pair.ts'
import {
  EXISTING_KEY,
  MemoryOAuthStore,
  rateLimitResult,
} from './memory-oauth-store.ts'
import {
  appFor,
  authorizationCode,
  begin,
  browserPost,
  environment,
  exchangeCode,
  fixture,
  readTokenPair,
} from './fixture.ts'

export function registerPairingTests(): void {
  async function mintedPairingCode(memory: MemoryOAuthStore, residentId = 49): Promise<string> {
    const rawCode = PAIRING_CODE_PREFIX + '11'.repeat(32)
    await memory.api.mintPairingCode({ residentId, codeHash: sha256(rawCode) })
    return rawCode
  }

  test('the consent page offers a pairing-code fieldset that never asks for the resident key', async () => {
    const { app } = fixture()
    const session = await begin(app)
    assert.match(session.html, /Have a pairing code instead/iu)
    assert.match(session.html, /name="pairing_code"[^>]*type="password"/iu)
    assert.match(session.html, new RegExp(`name="action" value="pair"`, 'u'))
    assert.match(session.html, /POST \/api\/pair/u)
    assert.match(session.html, /Pairing codes work once and expire ten minutes after the coding agent creates them/iu)
    assert.match(session.html, /10 shared pairing-code or resident-key attempts per IP and client per UTC hour/iu)
    assert.match(session.html, /never reveal the resident key/iu)
  })

  test('entering a pairing code first names the resident it connects and asks for one click, without consuming it', async () => {
    const { app, memory } = fixture()
    const pairingCode = await mintedPairingCode(memory)
    const session = await begin(app)
    const response = await browserPost(app, session, {
      action: 'pair', csrf: session.csrf, pairing_code: pairingCode,
    })
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.match(body, /it connects the resident <strong>chatty<\/strong>\. Approve\?/iu)
    assert.match(body, /works once and expires ten minutes after the coding agent created it/iu)
    assert.match(body, /name="action" value="pair_confirm"/u)
    assert.match(body, new RegExp(`name="pairing_code" value="${pairingCode}"`, 'u'))
    assert.doesNotMatch(body, /1f3d9_sk_/i)

    // Peeking must not have consumed the code: it is still valid for a real pair_confirm.
    const confirmed = await browserPost(app, session, {
      action: 'pair_confirm', csrf: session.csrf, pairing_code: pairingCode,
    })
    const code = authorizationCode(confirmed)
    const pair = await readTokenPair(await exchangeCode(app, code))
    assert.ok(pair.access_token)
  })

  test('pairing codes and resident keys forgive surrounding pasted whitespace', async () => {
    const { app, memory } = fixture()
    const pairingCode = await mintedPairingCode(memory)
    const pairingSession = await begin(app)
    const pairingResponse = await browserPost(app, pairingSession, {
      action: 'pair', csrf: pairingSession.csrf, pairing_code: ` \r\n${pairingCode}\r\n `,
    })
    assert.equal(pairingResponse.status, 200)

    const keySession = await begin(app)
    const keyResponse = await browserPost(app, keySession, {
      action: 'link', csrf: keySession.csrf, resident_key: `  ${EXISTING_KEY}  `,
    })
    authorizationCode(keyResponse)
  })

  test('an unrecognized pairing code is refused as pairing_code_rejected with a retry form, at either step', async () => {
    const memory = new MemoryOAuthStore()
    const diagnostics: OAuthDiagnosticRecord[] = []
    const app = appFor(memory, record => diagnostics.push(record))
    for (const action of ['pair', 'pair_confirm'] as const) {
      const session = await begin(app)
      const response = await browserPost(app, session, {
        action, csrf: session.csrf, pairing_code: PAIRING_CODE_PREFIX + '22'.repeat(32),
      })
      assert.equal(response.status, 403)
      assert.equal(response.headers.get('x-1f3d9-reason'), 'pairing_code_rejected')
      const body = await response.text()
      assert.match(body, /Pairing codes work once and expire ten minutes after your coding agent creates them; this rejected code will not work again, so ask your coding agent for a fresh code and paste it here\./u)
      assert.match(body, /name="action" value="pair"/u)
      assert.match(body, /name="pairing_code"[^>]*type="password"/iu)
      assert.match(body, /Paste a fresh pairing code/u)
      assert.doesNotMatch(body, /Try this pairing code/u)
    }
    assert.deepEqual(diagnostics.map(record => record.failed_check), ['code_not_accepted', 'code_not_accepted'])
  })

  test('a malformed pairing value records the failed format check at either step without changing the human sentence', async () => {
    for (const action of ['pair', 'pair_confirm'] as const) {
      const memory = new MemoryOAuthStore()
      const diagnostics: OAuthDiagnosticRecord[] = []
      const app = appFor(memory, record => diagnostics.push(record))
      const session = await begin(app)
      const response = await browserPost(app, session, {
        action, csrf: session.csrf, pairing_code: 'not-a-pairing-code',
      })
      assert.equal(response.status, 403, action)
      assert.match(await response.text(), /Pairing codes work once and expire ten minutes/iu, action)
      assert.equal(diagnostics[0]?.failed_check, 'not_a_code', action)
    }
  })

  test('pairing exhausts the shared ten-attempt budget with a pairing-specific message', async () => {
    const { app, memory } = fixture()
    const session = await begin(app)
    const attempts = new Map<string, number>()
    memory.api.consumeOAuthRateLimit = async input => {
      assert.equal(input.attemptKind, 'resident_key')
      assert.equal(input.maximum, 10)
      const count = (attempts.get(input.bucketHash) ?? 0) + 1
      attempts.set(input.bucketHash, count)
      return rateLimitResult(count <= 10)
    }
    const fields = {
      action: 'pair', csrf: session.csrf, pairing_code: PAIRING_CODE_PREFIX + '22'.repeat(32),
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      assert.equal((await browserPost(app, session, fields)).status, 403)
    }
    const exhausted = await browserPost(app, session, fields)
    assert.equal(exhausted.status, 429)
    assert.match(await exhausted.text(), /Too many pairing-code or resident-key attempts/iu)
  })

  test('an expired pairing code is refused the same as an unknown one, at either step', async () => {
    const { app, memory } = fixture()
    for (const action of ['pair', 'pair_confirm'] as const) {
      const pairingCode = await mintedPairingCode(memory)
      memory.expirePairingCode(sha256(pairingCode))
      const session = await begin(app)
      const response = await browserPost(app, session, {
        action, csrf: session.csrf, pairing_code: pairingCode,
      })
      assert.equal(response.status, 403)
      assert.equal(response.headers.get('x-1f3d9-reason'), 'pairing_code_rejected')
    }
  })

  test('a pairing code works exactly once, and a second confirm attempt is refused', async () => {
    const { app, memory } = fixture()
    const pairingCode = await mintedPairingCode(memory)
    const firstSession = await begin(app)
    const first = await browserPost(app, firstSession, {
      action: 'pair_confirm', csrf: firstSession.csrf, pairing_code: pairingCode,
    })
    authorizationCode(first)

    const secondSession = await begin(app)
    const second = await browserPost(app, secondSession, {
      action: 'pair_confirm', csrf: secondSession.csrf, pairing_code: pairingCode,
    })
    assert.equal(second.status, 403)
    assert.equal(second.headers.get('x-1f3d9-reason'), 'pairing_code_rejected')

    // The confirmation page also reports it as no longer valid.
    const thirdSession = await begin(app)
    const peekAfterUse = await browserPost(app, thirdSession, {
      action: 'pair', csrf: thirdSession.csrf, pairing_code: pairingCode,
    })
    assert.equal(peekAfterUse.status, 403)
    assert.equal(peekAfterUse.headers.get('x-1f3d9-reason'), 'pairing_code_rejected')
  })

  // Decision row 74 security fix: mountOAuthRoutes defaults pairingEnabled to
  // false so this already-live consent page cannot offer or accept a pairing
  // code before CODING_IDENTITY_DOORS_ENABLED is on -- see oauth.ts's own
  // OAuthRouteOptions.pairingEnabled doc comment.
  test('with pairingEnabled left at its default, the consent page omits the pairing fieldset and pair actions are refused', async () => {
    const memory = new MemoryOAuthStore()
    const app = new Hono()
    mountOAuthRoutes(app, {
      environment,
      store: memory.api,
      fetcher: (async input => {
        throw new Error(`unexpected network call: ${String(input)}`)
      }) as typeof fetch,
    })
    const session = await begin(app)
    assert.doesNotMatch(session.html, /Have a pairing code instead/iu)
    assert.doesNotMatch(session.html, /name="pairing_code"/iu)
    // "I already live here" and "This agent is moving in" must still render.
    assert.match(session.html, /I already live here/iu)
    assert.match(session.html, /This agent is moving in/iu)

    const pairingCode = await mintedPairingCode(memory)
    for (const action of ['pair', 'pair_confirm'] as const) {
      const attemptSession = await begin(app)
      const response = await browserPost(app, attemptSession, {
        action, csrf: attemptSession.csrf, pairing_code: pairingCode,
      })
      assert.equal(response.status, 503)
      assert.equal(response.headers.get('x-1f3d9-reason'), 'request_unavailable')
      assert.match(await response.text(), /Pairing-code sign-in is unavailable on this deployment/iu)
    }
  })
}
