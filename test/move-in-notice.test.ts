import assert from 'node:assert/strict'
import test from 'node:test'
import { BROWSER_IDENTITY_SCRIPT } from '../src/browser-identity-ui.ts'
import { begin, browserPost, fixture } from './oauth-flow-tests/fixture.ts'
import { pageState, postForm } from './helpers/identity-browser-fixtures/browser-session.ts'
import { appWithMemoryStore } from './helpers/identity-browser-fixtures/identity-app.ts'

// Owner, 2026-11-11: "I think just a simple fix of making the button more noticeable and
// adding a highlighted red text on that screen saying something like this resident creation
// will expire in x if you do not finish. Resident is not created until you click {button text}."

const SAVE_BUTTON = 'I saved both files, move in'
const MINUTE = 60_000

function utcSecond(at: number): string {
  return new Date(at).toISOString().slice(0, 19) + 'Z'
}

/** The notice must sit outside every fold, above the final button, and name that button and the stored expiry. */
function assertNotice(html: string, finalButton: string, storedExpiry: string): void {
  const outsideFolds = html.replace(/<details>[\s\S]*?<\/details>/gu, '')
  const notice = outsideFolds.match(/<div class="move-in-notice" role="alert">([\s\S]*?)<\/div>/u)?.[1]
  assert.ok(notice, 'the notice is on the page and not inside a fold')
  assert.ok(notice.includes(`is not created until you press "${finalButton}".`), `the notice quotes "${finalButton}"`)
  assert.ok(
    notice.includes(`expires at <time datetime="${storedExpiry}" data-local-time>${storedExpiry.slice(11, 16)} UTC</time> if you do not finish.`),
    `the notice states the stored expiry ${storedExpiry}`,
  )
  assert.match(notice, /After that the saved files will not work\./u)
  assert.ok(
    html.indexOf('class="move-in-notice"') < html.indexOf(`>${finalButton}</button>`),
    'the notice is above the final button',
  )
  assert.doesNotMatch(html, /has not been created yet/u, 'no second line says the same thing')
  assert.match(html, /\.move-in-notice\{[^}]*border:[^}]*var\(--brick\)/u, 'the notice has a red border, not colour alone')
}

function buttonTag(html: string, label: string): string {
  const found = html.match(new RegExp(`<button[^>]*>${label}</button>`, 'u'))?.[0]
  assert.ok(found, `no button labelled ${label}`)
  return found
}

function assertSavePageButtons(html: string): void {
  assert.match(buttonTag(html, SAVE_BUTTON), /class="primary-action"/u)
  assert.match(buttonTag(html, 'Cancel without creating a resident'), /class="secondary-action"/u)
  assert.doesNotMatch(buttonTag(html, 'Download'), /primary-action/u)
  assert.match(html, /button\.primary-action\{[^}]*width:100%/u, 'the final button is the full-width main action')
  assert.match(html, /button\.secondary-action\{[^}]*background:transparent/u, 'Cancel is visibly weaker')
}

test('the browser join save page says the move-in is not finished and when it expires', async () => {
  const { app, memory } = appWithMemoryStore()
  const start = await pageState(app, '/join')
  const staged = await postForm(app, '/join', start.cookie, {
    action: 'stage', csrf: start.csrf, handle: 'notice-resident', model: 'test-model', client_class: 'hosted_browser',
  })
  assert.equal(staged.status, 200)
  const html = await staged.text()
  const storedExpiry = memory.registrationExpiresAt()
  assert.ok(storedExpiry)
  assertNotice(html, SAVE_BUTTON, storedExpiry)
  assert.match(html, /<strong>notice-resident<\/strong> is not created until you press/u)
  assertSavePageButtons(html)
})

test('the browser join resume page states the time left on the stored expiry, not a fresh 15 minutes', async () => {
  const storedExpiry = utcSecond(Date.now() + 6 * MINUTE)
  const { app } = appWithMemoryStore({ registrationExpiresAt: storedExpiry })
  const start = await pageState(app, '/join')
  await postForm(app, '/join', start.cookie, {
    action: 'stage', csrf: start.csrf, handle: 'notice-resident', model: 'test-model', client_class: 'coding_ephemeral',
  })
  const resumed = await app.request('/join', { headers: { cookie: start.cookie } })
  const html = await resumed.text()
  assertNotice(html, 'Create this resident', storedExpiry)
  assert.match(buttonTag(html, 'Cancel this uncreated resident'), /class="secondary-action"/u)
})

test('the chat sign-in save page counts from when sign-in began, so fewer than 15 minutes can remain', async () => {
  const { app, memory } = fixture()
  const session = await begin(app)
  const heldUntil = Date.now() + 7 * MINUTE + 30_000
  memory.setRequestExpiresAt(session.rawSession, heldUntil)
  const created = await browserPost(app, session, {
    action: 'register', csrf: session.csrf, handle: 'notice-agent', model: 'hosted-chat',
  })
  assert.equal(created.status, 200)
  const html = await created.text()
  assertNotice(html, SAVE_BUTTON, utcSecond(heldUntil))
  assert.match(html, /<strong>notice-agent<\/strong> is not created until you press/u)
  assertSavePageButtons(html)

  const reloaded = await app.request(session.location, { headers: { cookie: session.cookie } })
  const resumedHtml = await reloaded.text()
  assertNotice(resumedHtml, 'Create resident and continue', utcSecond(heldUntil))
  assert.match(buttonTag(resumedHtml, 'Cancel this uncreated resident'), /class="secondary-action"/u)
})

test('the page script shows the expiry in the reader\'s own clock time', () => {
  const datetime = '2026-11-11T06:02:37Z'
  const time = { textContent: '06:02 UTC', getAttribute: (name: string) => (name === 'datetime' ? datetime : null) }
  const document = {
    querySelectorAll: (selector: string) => (selector === '[data-local-time]' ? [time] : []),
    querySelector: () => null,
    getElementById: () => null,
  }
  new Function('document', 'history', BROWSER_IDENTITY_SCRIPT)(document, { state: null, replaceState() {} })
  assert.equal(time.textContent, new Date(datetime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))
})
