import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { mountIdentityRoutes } from '../../src/identity-browser.ts'
import { ORIGIN, pageState, postForm } from '../helpers/identity-browser-fixtures/browser-session.ts'
import { memoryStore } from '../helpers/identity-browser-fixtures/memory-store.ts'
import { appWithMemoryStore } from '../helpers/identity-browser-fixtures/identity-app.ts'

export function registerIdentityConfigurationAndPagesTests(): void {
  test('identity browser rejects a PUBLIC_ORIGIN that is not one exact HTTPS origin', () => {
    for (const publicOrigin of [
      'http://city.test',
      'https://city.test/path',
      'https://city.test?query=yes',
      'not-an-origin',
    ]) {
      assert.throws(
        () => mountIdentityRoutes(new Hono(), {
          environment: { PUBLIC_ORIGIN: publicOrigin },
          store: memoryStore().store,
        }),
        /PUBLIC_ORIGIN must be an HTTPS origin/,
      )
    }
  })

  test('the recovery surface is absent unless its deployment switch is explicitly enabled', async () => {
    for (const environment of [
      { PUBLIC_ORIGIN: ORIGIN },
      { PUBLIC_ORIGIN: ORIGIN, IDENTITY_RECOVERY_ENABLED: 'false' },
    ]) {
      const app = new Hono()
      const memory = memoryStore()
      mountIdentityRoutes(app, { environment, store: memory.store })

      assert.equal((await app.request('/recovery')).status, 404)
      assert.equal((await app.request('/recovery', { method: 'POST' })).status, 404)
      assert.equal(memory.calls.length, 0)
    }
  })

  test('a completed join never advertises the disabled recovery surface', async () => {
    const app = new Hono()
    const memory = memoryStore()
    mountIdentityRoutes(app, {
      environment: { PUBLIC_ORIGIN: ORIGIN, IDENTITY_RECOVERY_ENABLED: 'false' },
      store: memory.store,
    })
    const start = await pageState(app, '/join')
    const staged = await postForm(app, '/join', start.cookie, {
      action: 'stage', csrf: start.csrf, handle: 'recovery-off', model: '', client_class: 'coding_persistent',
    })
    const rootKey = (await staged.text()).match(/1f3d9_sk_[0-9a-f]{48}/u)?.[0]
    assert.ok(rootKey)

    const completed = await postForm(app, '/join', start.cookie, {
      action: 'confirm', csrf: start.csrf, resident_key: rootKey,
    })
    assert.equal(completed.status, 200)
    const body = await completed.text()
    assert.doesNotMatch(body, /href="\/recovery"/u)
    assert.match(body, /recovery[^.]*not available|keep[^.]*recovery codes[^.]*safe/iu)
    assert.equal((await app.request('/recovery')).status, 404)
  })

  test('rotation is absent unless explicitly enabled and its switch is independent of recovery', async () => {
    for (const environment of [
      { PUBLIC_ORIGIN: ORIGIN },
      { PUBLIC_ORIGIN: ORIGIN, IDENTITY_ROTATION_ENABLED: 'false' },
    ]) {
      const app = new Hono()
      const memory = memoryStore()
      mountIdentityRoutes(app, { environment, store: memory.store })

      assert.equal((await app.request('/rotate')).status, 404)
      assert.equal((await app.request('/rotate', { method: 'POST' })).status, 404)
      assert.equal(memory.calls.length, 0)
    }

    const rotationOnly = new Hono()
    mountIdentityRoutes(rotationOnly, {
      environment: { PUBLIC_ORIGIN: ORIGIN, IDENTITY_ROTATION_ENABLED: 'true' },
      store: memoryStore().store,
    })
    assert.equal((await rotationOnly.request('/rotate')).status, 200)
    assert.equal((await rotationOnly.request('/recovery')).status, 404)

    const recoveryOnly = new Hono()
    mountIdentityRoutes(recoveryOnly, {
      environment: { PUBLIC_ORIGIN: ORIGIN, IDENTITY_RECOVERY_ENABLED: 'true' },
      store: memoryStore().store,
    })
    assert.equal((await recoveryOnly.request('/recovery')).status, 200)
    assert.equal((await recoveryOnly.request('/rotate')).status, 404)
  })

  test('rotation GET is private and uses a separate host-only session cookie', async () => {
    const { app } = appWithMemoryStore()
    const response = await app.request('/rotate')

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('pragma'), 'no-cache')
    assert.equal(response.headers.get('referrer-policy'), 'same-origin')
    assert.equal(response.headers.get('x-frame-options'), 'DENY')
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
    assert.equal(response.headers.get('access-control-allow-origin'), null)
    const setCookie = response.headers.get('set-cookie') ?? ''
    assert.match(setCookie, /^__Host-1f3d9_rotate=/)
    assert.match(setCookie, /; Path=\/; Max-Age=900; Secure; HttpOnly; SameSite=Lax$/)
    assert.doesNotMatch(setCookie, /(?:Domain=|join|recovery)/i)
  })

  test('identity doors set one base cookie and show the form immediately', async () => {
    for (const path of ['/join', '/rotate', '/recovery'] as const) {
      const { app, memory } = appWithMemoryStore()
      const state = await pageState(app, path)
      assert.match(state.cookie, new RegExp(`^__Host-1f3d9_${path.slice(1)}=`), path)
      assert.match(state.setCookie, new RegExp(`Max-Age=${path === '/join' ? 1800 : 900}`), path)
      assert.equal(memory.calls.length, 0, path)
    }
  })

  test('every credential-handling page carries the operator contact and safety links', async () => {
    for (const path of ['/join', '/rotate', '/recovery'] as const) {
      const { app } = appWithMemoryStore()
      const { html } = await pageState(app, path)

      assert.match(html, /<footer class="identity-footer">/u, path)
      assert.match(html, /href="mailto:adam@twamd\.com">adam@twamd\.com<\/a>/u, path)
      assert.match(html, /href="\/terms">Terms<\/a>/u, path)
      assert.match(html, /href="\/about">About<\/a>/u, path)
    }
  })

}
