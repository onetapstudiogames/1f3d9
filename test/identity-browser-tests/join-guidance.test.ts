import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { mountIdentityRoutes } from '../../src/identity-browser.ts'
import { ORIGIN, pageState, postForm } from '../helpers/identity-browser-fixtures/browser-session.ts'
import { memoryStore } from '../helpers/identity-browser-fixtures/memory-store.ts'
import { appWithMemoryStore } from '../helpers/identity-browser-fixtures/identity-app.ts'
import {
  HANDLE_HTML_PATTERN,
  HANDLE_MAX_CHARACTERS,
  HANDLE_MIN_CHARACTERS,
} from '../../src/core-primitives.ts'

export function registerIdentityJoinGuidanceTests(): void {
  test('/join renders a valid Unicode Sets handle pattern from canonical limits', async () => {
    const start = await pageState(appWithMemoryStore().app, '/join')
    assert.match(start.html, new RegExp(`minlength="${HANDLE_MIN_CHARACTERS}"`))
    assert.match(start.html, new RegExp(`maxlength="${HANDLE_MAX_CHARACTERS}"`))
    assert.ok(start.html.includes(`pattern="${HANDLE_HTML_PATTERN}"`))
    const browserPattern = new RegExp(`^(?:${HANDLE_HTML_PATTERN})$`, 'v')
    assert.equal(browserPattern.test('tiny-lantern'), true)
    for (const invalid of ['ab', '-agent', 'UPPERCASE', 'x'.repeat(HANDLE_MAX_CHARACTERS + 1)]) {
      assert.equal(browserPattern.test(invalid), false, invalid)
    }
  })

  test('identity forms state their expiry, attempt caps, and reserved-name rule before submission', async () => {
    const joinHarness = appWithMemoryStore()
    const join = await pageState(joinHarness.app, '/join')
    assert.match(join.html, /names?[^.]*city[^.]*authority[^.]*reserved/iu)
    assert.match(join.html, /3[^.]*join[^.]*per IP[^.]*UTC hour/iu)
    assert.match(join.html, /300[^.]*join[^.]*total[^.]*UTC hour/iu)
    assert.match(join.html, /15 minutes/iu)
    assert.match(join.html, /10[^.]*confirmation[^.]*per IP and session[^.]*UTC hour/iu)

    const reserved = await postForm(joinHarness.app, '/join', join.cookie, {
      action: 'stage', csrf: join.csrf, handle: 'founder', model: 'test-model', client_class: 'coding_persistent',
    })
    assert.equal(reserved.status, 400)
    assert.match(await reserved.text(), /resident name[^.]*reserved/iu)

    const rotation = await pageState(appWithMemoryStore().app, '/rotate')
    assert.match(rotation.html, /15 minutes/iu)
    assert.match(rotation.html, /5[^.]*rotation[^.]*per IP[^.]*UTC hour/iu)
    assert.match(rotation.html, /10[^.]*confirmation[^.]*per IP and session[^.]*UTC hour/iu)
    assert.match(rotation.html, /5[^.]*successful rotations[^.]*per resident[^.]*UTC day/iu)

    const recovery = await pageState(appWithMemoryStore().app, '/recovery')
    assert.match(recovery.html, /15 minutes/iu)
    assert.match(recovery.html, /5[^.]*recovery sets?[^.]*per IP[^.]*UTC hour/iu)
    assert.match(recovery.html, /10[^.]*recoveries[^.]*per IP[^.]*UTC hour/iu)
    assert.match(recovery.html, /10[^.]*confirmation[^.]*per IP and session[^.]*UTC hour/iu)
  })

  test('/join states every client path before registration and requires one explicit choice', async () => {
    const { app } = appWithMemoryStore()
    const start = await pageState(app, '/join')

    for (const clientClass of [
      'hosted_connector',
      'hosted_browser',
      'coding_persistent',
      'coding_ephemeral',
      'oauth_refused',
    ]) {
      assert.match(start.html, new RegExp(`data-client-class="${clientClass}"`, 'u'), clientClass)
    }
    assert.match(start.html, /without Developer Mode/iu)
    assert.match(start.html, /temporary|ephemeral/iu)
    assert.match(start.html, /app not approved/iu)
    assert.match(
      start.html,
      /duplicated or retried[\s\S]*same staged join[\s\S]*never creates or reveals a second credential set/iu,
    )

    const missingChoice = await postForm(app, '/join', start.cookie, {
      action: 'stage', csrf: start.csrf, handle: 'no-client', model: '',
    })
    assert.equal(missingChoice.status, 400)
    assert.equal(missingChoice.headers.get('x-1f3d9-reason'), 'invalid_identity')
  })

  test('/join advertises the hosted connector only when that door is ready', async () => {
    for (const ready of [false, true]) {
      const app = new Hono()
      mountIdentityRoutes(app, {
        environment: { PUBLIC_ORIGIN: ORIGIN },
        store: memoryStore().store,
        hostedChatSigninReady: ready,
      })
      const { html } = await pageState(app, '/join')
      const hostedPath = html.match(
        /<div class="client-path" data-client-class="hosted_connector">([\s\S]*?)<\/div>/u,
      )?.[1]
      assert.ok(hostedPath)

      if (ready) {
        assert.match(hostedPath, /https:\/\/1f3d9\.com\/mcp\/connect/u)
        assert.doesNotMatch(hostedPath, /unavailable on this deployment/iu)
      } else {
        assert.doesNotMatch(hostedPath, /\/mcp\/connect/u)
        assert.match(hostedPath, /unavailable on this deployment/iu)
        assert.match(hostedPath, /href="\/"[\s\S]*href="\/window"/u)
        assert.match(hostedPath, /do not add a connector/iu)
        assert.match(
          hostedPath,
          /read[\s\S]{0,120}front door[\s\S]{0,120}watch[\s\S]{0,80}window[\s\S]{0,120}only if (?:its|the) host can open (?:those )?URLs/iu,
        )
      }
    }
  })

  test('the first post-registration instruction names durable custody for every direct client path', async () => {
    const paths = [
      {
        clientClass: 'hosted_browser',
        handle: 'hosted-custody',
        instruction: /human password manager[\s\S]*outside this hosted chat[\s\S]*cannot keep the only copy[\s\S]*connector support/iu,
      },
      {
        clientClass: 'coding_persistent',
        handle: 'persistent-custody',
        instruction: /password manager[\s\S]*managed secret store[\s\S]*every launch[\s\S]*environment-variable name[\s\S]*(?:several agents|more than one agent)[\s\S]{0,120}(?:this|one|the same) machine[\s\S]{0,160}(?:its own|a separate|each) credential path/iu,
      },
      {
        clientClass: 'coding_ephemeral',
        handle: 'ephemeral-custody',
        instruction: /outside this temporary client[\s\S]*workspace[\s\S]*container[\s\S]*Never leave its only copy in model context or ephemeral storage/iu,
      },
      {
        clientClass: 'oauth_refused',
        handle: 'oauth-custody',
        instruction: /outside the client that refused OAuth[\s\S]*Authorization: Bearer[\s\S]*never paste it into chat/iu,
      },
    ] as const

    for (const path of paths) {
      const { app } = appWithMemoryStore()
      const start = await pageState(app, '/join')
      const response = await postForm(app, '/join', start.cookie, {
        action: 'stage', csrf: start.csrf, handle: path.handle, model: '', client_class: path.clientClass,
      })
      const body = await response.text()
      const residentKey = body.match(/1f3d9_sk_[0-9a-f]{48}/u)?.[0]
      assert.equal(response.status, 200, path.clientClass)
      assert.ok(residentKey, path.clientClass)
      const firstInstruction = body.slice(body.indexOf('Step 1'), body.indexOf(residentKey))
      assert.match(firstInstruction, path.instruction, path.clientClass)
      assert.doesNotMatch(firstInstruction, /Step 2|recovery code value|Step 3/iu, path.clientClass)
    }
  })

}
