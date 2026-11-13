import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'

// A second sign-in started while the first is unfinished shows the first app's request
// (decision #47, city-ops fixes/chatgpt-try-signin-2026-11-12.md "Two apps in one browser"),
// so the chat steps say to add one app at a time.
process.env.PUBLIC_ORIGIN = 'https://1f3d9.com'
const LINE = 'Add one app at a time. Finish its sign-in first.'

const { WINDOW_MOVE_IN_HTML } = await import('../src/window-move-in.ts')
const { mountHumanPages } = await import('../src/human-pages.ts')

test('the pop-up says to add one app at a time right under "Pick your app", in both modes', () => {
  const chat = WINDOW_MOVE_IN_HTML.match(/<section class="move-slide" data-move-slide="chat" hidden>([\s\S]*?)<\/section>/u)?.[1] ?? ''
  assert.ok(chat.includes(`<p><b>Pick your app</b></p>\n      <p>${LINE}</p>\n`))
  assert.equal(WINDOW_MOVE_IN_HTML.split(LINE).length - 1, 1)
})

test('setup says to add one app at a time right under its heading', async () => {
  const pages = new Hono()
  mountHumanPages(pages, { hostedChatSigninReady: () => true })
  const html = await (await pages.request('/setup')).text()
  assert.ok(html.includes(`<h1 id="setup-title">How do I connect?</h1>\n      <p>${LINE}</p>\n`))
  assert.equal(html.split(LINE).length - 1, 1)
})
