import assert from 'node:assert/strict'
import test from 'node:test'
import { residentByOAuthAccessToken } from '../../src/oauth.ts'
import {
  CLIENT_ID,
  RESOURCE,
  environment,
  fixture,
  initialPair,
  readTokenPair,
} from './fixture.ts'

export function registerRefreshReuseTests(): void {
  test('refresh tokens rotate once; reuse revokes the whole token family', async () => {
    const { app, memory } = fixture()
    const first = await initialPair(app)
    const rotate = () => app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        resource: RESOURCE,
        refresh_token: first.refresh_token,
      }),
    })

    const second = await readTokenPair(await rotate())
    assert.notEqual(second.access_token, first.access_token)
    assert.notEqual(second.refresh_token, first.refresh_token)

    const reuse = await rotate()
    assert.equal(reuse.status, 400)
    assert.deepEqual(await reuse.json(), { error: 'invalid_grant' })
    assert.equal(await residentByOAuthAccessToken(first.access_token, environment, memory.api), null)
    assert.equal(await residentByOAuthAccessToken(second.access_token, environment, memory.api), null)

    const descendant = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        resource: RESOURCE,
        refresh_token: second.refresh_token,
      }),
    })
    assert.equal(descendant.status, 400)
    assert.deepEqual(await descendant.json(), { error: 'invalid_grant' })
  })

}
