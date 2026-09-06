import assert from 'node:assert/strict'
import test from 'node:test'
import type { OAuthDiagnosticRecord } from '../../src/oauth.ts'
import { EXISTING_KEY, MemoryOAuthStore, rateLimitResult } from './memory-oauth-store.ts'
import {
  CLIENT_ID,
  RESOURCE,
  appFor,
  assertPrivate,
  authorizationUrl,
  authorizeExisting,
  begin,
  browserPost,
  exchangeCode,
  fixture,
  initialPair,
} from './fixture.ts'

export function registerBoundedFailureTests(): void {
  test('an initial authorization rate limit tells the caller how to restart', async () => {
    const { app, memory } = fixture()
    memory.api.consumeOAuthRateLimit = async () => rateLimitResult(false)

    const response = await app.request(authorizationUrl())
    assert.equal(response.status, 429)
    assert.equal(response.headers.get('x-1f3d9-reason'), 'rate_limited')
    assert.equal(response.headers.get('set-cookie'), null)
    assert.match(await response.text(), /Return to the chat app and start sign-in again/iu)
  })

  test('an active existing-resident rate limit discards the expired sign-in form', async () => {
    const { app, memory } = fixture()
    const session = await begin(app)
    memory.api.consumeOAuthRateLimit = async () => rateLimitResult(false)

    const response = await browserPost(app, session, {
      action: 'link', csrf: session.csrf, resident_key: EXISTING_KEY,
    })
    const body = await response.text()

    assert.equal(response.status, 429)
    assert.equal(response.headers.get('x-1f3d9-reason'), 'rate_limited')
    assert.match(body, /after one hour[^.]*return to the chat app[^.]*fresh sign-in/iu)
    assert.doesNotMatch(body, /on this page/iu)
    assert.doesNotMatch(body, /name="action" value="link"/u)
    assert.doesNotMatch(body, /name="resident_key"/u)
  })

  test('approval, exchange, refresh, and revocation failures stay bounded and emit safe stage records', async () => {
    const leakedCredential = `1f3d9_sk_${'fe'.repeat(24)}`

    const approvalMemory = new MemoryOAuthStore()
    const approvalDiagnostics: OAuthDiagnosticRecord[] = []
    const approvalApp = appFor(approvalMemory, record => approvalDiagnostics.push(record))
    const approvalSession = await begin(approvalApp)
    approvalMemory.api.approveExistingResidentAndIssueAuthorizationCode = async () => {
      throw new Error(`approval storage failed near ${leakedCredential}`)
    }
    const approval = await browserPost(approvalApp, approvalSession, {
      action: 'link',
      csrf: approvalSession.csrf,
      resident_key: EXISTING_KEY,
    })
    assert.equal(approval.status, 503)
    assertPrivate(approval, true)
    assert.deepEqual(approvalDiagnostics.map(record => record.stage), ['browser_approval'])

    const exchangeMemory = new MemoryOAuthStore()
    const exchangeDiagnostics: OAuthDiagnosticRecord[] = []
    const exchangeApp = appFor(exchangeMemory, record => exchangeDiagnostics.push(record))
    const { code } = await authorizeExisting(exchangeApp)
    exchangeMemory.api.exchangeAuthorizationCode = async () => {
      throw new Error(`exchange storage failed near ${leakedCredential}`)
    }
    const exchange = await exchangeCode(exchangeApp, code)
    assert.equal(exchange.status, 503)
    assertPrivate(exchange)
    assert.deepEqual(await exchange.json(), { error: 'temporarily_unavailable' })
    assert.deepEqual(exchangeDiagnostics.map(record => record.stage), ['token_exchange'])

    const refreshMemory = new MemoryOAuthStore()
    const refreshDiagnostics: OAuthDiagnosticRecord[] = []
    const refreshApp = appFor(refreshMemory, record => refreshDiagnostics.push(record))
    const pair = await initialPair(refreshApp)
    refreshMemory.api.rotateRefreshToken = async () => {
      throw new Error(`refresh storage failed near ${leakedCredential}`)
    }
    const refresh = await refreshApp.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        resource: RESOURCE,
        refresh_token: pair.refresh_token,
      }),
    })
    assert.equal(refresh.status, 503)
    assertPrivate(refresh)
    assert.deepEqual(await refresh.json(), { error: 'temporarily_unavailable' })
    assert.deepEqual(refreshDiagnostics.map(record => record.stage), ['token_refresh'])

    const revokeMemory = new MemoryOAuthStore()
    const revokeDiagnostics: OAuthDiagnosticRecord[] = []
    const revokeApp = appFor(revokeMemory, record => revokeDiagnostics.push(record))
    const revokePair = await initialPair(revokeApp)
    revokeMemory.api.revokeTokenFamilyByToken = async () => {
      throw new Error(`revocation storage failed near ${leakedCredential}`)
    }
    const revoke = await revokeApp.request('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: revokePair.refresh_token,
        client_id: CLIENT_ID,
      }),
    })
    assert.equal(revoke.status, 200)
    assertPrivate(revoke)
    assert.deepEqual(revokeDiagnostics.map(record => record.stage), ['revocation'])

    for (const records of [
      approvalDiagnostics,
      exchangeDiagnostics,
      refreshDiagnostics,
      revokeDiagnostics,
    ]) {
      assert.equal(records.length, 1)
      assert.deepEqual(
        Object.keys(records[0] ?? {}).sort(),
        ['client_origin', 'elapsed_ms', 'error_class', 'event', 'request_id', 'stage', 'status'],
      )
      assert.equal(records[0]?.client_origin, 'pre-registered')
      assert.equal(records[0]?.error_class, 'storage_unavailable')
      assert.doesNotMatch(JSON.stringify(records), new RegExp(leakedCredential, 'i'))
    }
  })

}
