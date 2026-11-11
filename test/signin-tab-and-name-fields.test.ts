import assert from 'node:assert/strict'
import test from 'node:test'
import { BROWSER_IDENTITY_SCRIPT } from '../src/browser-identity-ui.ts'
import { RETIREMENT_FORM } from '../src/retirement-page.ts'
import { renderCreditBuyPage } from '../src/credit-buy-page.ts'
import { renderCommunityToolsBody } from '../src/community-tools-page.ts'
import { begin, browserPost, fixture } from './oauth-flow-tests/fixture.ts'
import { pageState } from './helpers/identity-browser-fixtures/browser-session.ts'
import { appWithMemoryStore } from './helpers/identity-browser-fixtures/identity-app.ts'

// Owner, 2026-11-10: the sign-in page opens on "This agent is moving in", and a typed
// resident name starts in lowercase and shows exactly what was typed.

function tag(html: string, id: string): string {
  const found = html.match(new RegExp(`<(?:input|button)[^>]*\\bid="${id}"[^>]*>`, 'u'))?.[0]
  assert.ok(found, `no element with id ${id}`)
  return found
}

function assertPlainNameField(html: string, id: string, label: string): void {
  const input = tag(html, id)
  for (const hint of ['autocapitalize="none"', 'autocorrect="off"', 'spellcheck="false"', 'autocomplete="off"']) {
    assert.ok(input.includes(hint), `${label}: ${id} lacks ${hint}`)
  }
  assert.doesNotMatch(html, /[^{}]*\binput\b[^{}]*\{[^}]*text-transform/u, `${label}: no style upper-cases a field`)
}

interface FakeElement {
  id: string
  hidden: boolean
  tabIndex: number
  attributes: Map<string, string>
  listeners: Map<string, Array<(event: unknown) => void>>
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  addEventListener(name: string, listener: (event: unknown) => void): void
  focus(): void
}

function element(id: string, attributes: Record<string, string> = {}): FakeElement {
  return {
    id,
    hidden: false,
    tabIndex: 0,
    attributes: new Map(Object.entries(attributes)),
    listeners: new Map(),
    getAttribute(name) { return this.attributes.get(name) ?? null },
    setAttribute(name, value) { this.attributes.set(name, value) },
    addEventListener(name, listener) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]) },
    focus() {},
  }
}

/** Run the real page script against the two tabs as the consent page serves them. */
function openPage(html: string, history: PageHistory | null) {
  const tabs = ['tab-old', 'tab-new'].map(id => element(id, {
    'aria-selected': tag(html, id).match(/aria-selected="(true|false)"/u)![1]!,
    'aria-controls': id.replace('tab-', 'pane-'),
  }))
  const panes = new Map(['pane-old', 'pane-new'].map(id => [id, element(id)]))
  const document = {
    querySelectorAll: (selector: string) => selector === '[data-identity-tab]' ? tabs : [],
    querySelector: () => null,
    getElementById: (id: string) => panes.get(id) ?? null,
  }
  const pageHistory = history ?? {
    get state(): unknown { throw new Error('history blocked') },
    replaceState() { throw new Error('history blocked') },
  }
  new Function('document', 'history', BROWSER_IDENTITY_SCRIPT)(document, pageHistory)
  const shown = () => {
    const selected = tabs.filter(tab => tab.getAttribute('aria-selected') === 'true').map(tab => tab.id)
    assert.equal(selected.length, 1)
    const visible = [...panes.values()].filter(pane => !pane.hidden).map(pane => pane.id)
    assert.deepEqual(visible, [selected[0]!.replace('tab-', 'pane-')])
    assert.deepEqual(tabs.map(tab => tab.tabIndex), tabs.map(tab => (tab.id === selected[0] ? 0 : -1)))
    return selected[0]
  }
  const click = (id: string) => tabs.find(tab => tab.id === id)!.listeners.get('click')!.forEach(listener => listener({}))
  return { shown, click }
}

interface PageHistory {
  readonly state: unknown
  replaceState(state: unknown, unused: string): void
}

/** One browser tab's history entry: its state survives a reload and back or forward in that tab. */
function tabHistory(): PageHistory {
  let state: unknown = null
  return {
    get state() { return state },
    replaceState(next: unknown) { state = structuredClone(next) },
  }
}

test('the sign-in page first opens on "This agent is moving in"', async () => {
  const { html } = await begin(fixture().app)
  assert.ok(tag(html, 'tab-new').includes('aria-selected="true"'))
  assert.ok(tag(html, 'tab-old').includes('aria-selected="false"'))
  assert.match(html, />I already live here<\/button>/u, 'both choices stay')
  assert.equal(openPage(html, tabHistory()).shown(), 'tab-new')
  assert.equal(openPage(html, null).shown(), 'tab-new', 'a page that cannot keep history still opens on the default')
})

test('a re-shown sign-in page keeps the choice the person was on', async () => {
  const { html } = await begin(fixture().app)
  const history = tabHistory()
  const first = openPage(html, history)
  first.click('tab-old')
  assert.equal(first.shown(), 'tab-old')
  assert.equal(openPage(html, history).shown(), 'tab-old', 'a reload, or back and forward, in this tab stays on the existing resident')
  const again = openPage(html, history)
  again.click('tab-new')
  assert.equal(openPage(html, history).shown(), 'tab-new')
  assert.equal(openPage(html, tabHistory()).shown(), 'tab-new', 'a fresh tab opens on the default')
})

test('the sign-in page script keeps no web storage', () => {
  assert.doesNotMatch(BROWSER_IDENTITY_SCRIPT, /localStorage|sessionStorage|indexedDB|document[.]cookie/u)
})

test('every first-party field where a person types a resident name starts in lowercase', async () => {
  const oauth = fixture()
  const consent = await begin(oauth.app)
  assertPlainNameField(consent.html, 'handle', 'sign-in page')
  const retry = await browserPost(oauth.app, consent, { action: 'register', csrf: consent.csrf, handle: '-bad', model: '' })
  assert.equal(retry.status, 400)
  assertPlainNameField(await retry.text(), 'handle', 'sign-in retry form')
  const join = await pageState(appWithMemoryStore().app, '/join')
  assertPlainNameField(join.html, 'handle', '/join')
  assertPlainNameField(RETIREMENT_FORM, 'retirement-name', '/delete')
  const buy = renderCreditBuyPage()
  assertPlainNameField(buy, 'who-input', '/buy credit for')
  assertPlainNameField(buy, 'to-input', '/buy gift to')
  assertPlainNameField(renderCommunityToolsBody({ waitingCount: 0, submissionsAvailable: true }, 'csrf'), 'tool-resident', '/tools resident attribution')
})
