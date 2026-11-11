import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import * as sharing from '../src/window-sharing.ts'
import { windowPage } from '../src/window.ts'

// Ad, mail, and social tools add their own names to a link someone followed:
// Reddit adds rdt_cid, ChatGPT adds oppref and olref. A window link ignores
// every name the window does not use, so the next tool cannot break it. The
// names the window does use keep every strict rule they have.
const REFUSAL = 'that public city window link is not available; return to /window and create a new Share link'

const NAMED_TAGS = [
  'rdt_cid', 'gclid', 'gad_source', 'gad_campaignid', 'gbraid', 'wbraid', 'dclid',
  'fbclid', 'msclkid', 'ttclid', 'twclid', 'li_fat_id', 'igshid', 'mc_cid', 'mc_eid', 'ref',
  'oppref', 'olref',
] as const

const TAG_TEXT = /rdt_cid|utm_|fbclid|gclid|gad_|ad-click|oppref|olref|gAAAAA|unknown-value|deadbeefdeadbeef|zzzz/u

// A made-up token in the shape a ChatGPT ad click carries: long URL-safe base64.
const AD_TOKEN = 'gAAAAA' + 'Bk9x-Q_z7mT2pL4vN8cR1sW6yH3jF0dK5eU-aZ_'.repeat(4) + 'Xq=='
// Obviously made up: the city's key prefix followed by repeated deadbeef.
const FAKE_KEY_SHAPE = '1f3d9_sk_' + 'deadbeef'.repeat(6)

const ODD_NAMES: readonly string[] = [
  'x=1',
  'Oppref=a',
  'UTM_SOURCE=reddit',
  'Rdt_cid=x',
  'referrer=x',
  'notes=open',
  'drawing=current',
  '=2',
  'a%5B%5D=1',
  'a[]=1',
  'x=1&x=2&x=3',
  `long=${'z'.repeat(2_000)}`,
  'enc=%E2%9C%93%20unknown-value%26more',
  'bare-name',
  `oppref=${AD_TOKEN}&olref=${AD_TOKEN}`,
  ...NAMED_TAGS.map(name => `${name}=ad-click`),
  'utm_source=reddit&utm_medium=cpc&utm_campaign=launch',
]

function windowApp() {
  const app = new Hono()
  const readRecord = async () => null
  app.get('/window', c => windowPage(c, false, readRecord))
  app.get('/window/:view', c => windowPage(c, false, readRecord, undefined, async issue => issue === 7))
  app.get('/window/:kind/:id', c => windowPage(c, false, readRecord))
  return app
}

test('the window keeps no list of names to ignore', () => {
  const exports = sharing as Record<string, unknown>
  assert.equal(exports.WINDOW_LINK_TRACKING_TAGS, undefined)
  assert.equal(exports.isWindowLinkTrackingTag, undefined)
})

test('a name the window does not use loads the same window state the bare link loads', () => {
  const bases: ReadonlyArray<readonly [string, string]> = [
    ['/window', ''],
    ['/window/map', '?place=310'],
    ['/window/place/310', '?resident=solward'],
    ['/window/archive', '?q=hush+lantern&mode=phrase&type=thing'],
    ['/window/gazette', '?issue=7'],
    ['/window/note/301', ''],
    ['/window/thing/401', ''],
  ]
  for (const [path, bare] of bases) {
    const expected = sharing.parseWindowShareRequest(path, bare)
    assert.ok(expected, `${path}${bare} must load`)
    for (const odd of ODD_NAMES) {
      for (const search of [
        bare === '' ? `?${odd}` : `${bare}&${odd}`,
        bare === '' ? `?${odd}` : `?${odd}&${bare.slice(1)}`,
      ]) {
        const actual = sharing.parseWindowShareRequest(path, search)
        assert.deepEqual(actual, expected, `${path}${search.slice(0, 80)}`)
        assert.doesNotMatch(actual?.canonicalPath ?? '', TAG_TEXT, `${path}${search.slice(0, 80)}`)
      }
    }
  }
  const mixed = sharing.parseWindowShareRequest('/window/map', '?x=1&place=310&oppref=a')
  assert.equal(mixed?.state.placeId, 310)
  assert.equal(mixed?.canonicalPath, '/window/map?place=310')
})

test('a credential-shaped value under an unknown name is ignored like any other', async () => {
  const app = windowApp()
  const bare = sharing.parseWindowShareRequest('/window', '')
  const bareHtml = await (await app.request('/window')).text()
  for (const search of [`?anything=${FAKE_KEY_SHAPE}`, `?${FAKE_KEY_SHAPE}=1`]) {
    const parsed = sharing.parseWindowShareRequest('/window', search)
    assert.deepEqual(parsed, bare, search)
    assert.doesNotMatch(parsed?.canonicalPath ?? '', /1f3d9_sk_/u)
    const response = await app.request('/window' + search)
    assert.equal(response.status, 200, search)
    const html = await response.text()
    assert.equal(html, bareHtml, search)
    assert.doesNotMatch(html, /deadbeefdeadbeef/u, search)
  }
})

test('every name the window uses keeps every strict rule, with or without other names', () => {
  const refused: ReadonlyArray<readonly [string, string]> = [
    ['/window', '?place=abc'],
    ['/window/map', '?place=0'],
    ['/window/map', '?place=1&place=2'],
    ['/window/map', '?resident=A'],
    ['/window/map', '?context=place'],
    ['/window/map', '?find=quiet%0Aroom'],
    ['/window/map', '?q=lantern'],
    ['/window/map', '?issue=7'],
    ['/window/archive', '?mode=phrase'],
    ['/window/archive', '?q=lantern&mode=loud'],
    ['/window/place/310', '?place=310'],
    ['/window/note/301', '?place=1'],
    ['/window/thing/401', '?resident=solward'],
    ['/window/gazette', '?issue=7&place=1'],
    ['/window/gazette', '?issue=0'],
    ['/window/gazette', '?issue=7&issue=8'],
    ['/window/unknown', ''],
    ['/window/thing/0', ''],
    ['/window/place/310/extra', ''],
  ]
  for (const [path, search] of refused) {
    assert.equal(sharing.parseWindowShareRequest(path, search), null, `${path}${search}`)
    const tagged = search === '' ? '?oppref=a&x=1' : `${search}&oppref=a&x=1`
    assert.equal(sharing.parseWindowShareRequest(path, tagged), null, `${path}${tagged}`)
  }
})

test('welcome opens the window and an unknown name beside it changes nothing', async () => {
  const app = windowApp()
  const bareHtml = await (await app.request('/window')).text()
  for (const search of [
    '?welcome', '?welcome=1', '?welcome&utm_source=reddit', '?welcome&welcome',
    '?welcome&unknown=yes', '?Welcome', `?welcome=&oppref=${AD_TOKEN}&x=1`,
  ]) {
    assert.deepEqual(sharing.parseWindowShareRequest('/window', search), sharing.parseWindowShareRequest('/window', ''))
    const response = await app.request('/window' + search)
    assert.equal(response.status, 200, search)
    assert.equal(await response.text(), bareHtml, search)
  }
  // The welcome pop-up reads the address bar, which still carries welcome.
  assert.equal(new URLSearchParams(`?welcome=&oppref=${AD_TOKEN}&x=1`).has('welcome'), true)
  for (const search of ['?welcome&place=0', '?welcome&x=1&place=abc']) {
    const response = await app.request('/window' + search)
    assert.equal(response.status, 404, search)
    assert.equal(await response.text(), REFUSAL, search)
  }
})

test('pages with unknown names answer 200 with the same page and never echo them', async () => {
  const app = windowApp()
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['/window?rdt_cid=ad-click', '/window'],
    ['/window?x=1', '/window'],
    ['/window?notes=open&zzzz=1', '/window'],
    ['/window?utm_source=reddit&utm_campaign=launch', '/window'],
    [`/window?oppref=${AD_TOKEN}&olref=${AD_TOKEN}`, '/window'],
    ['/window/map?place=310&rdt_cid=ad-click&a[]=1', '/window/map?place=310'],
    ['/window/place/310?resident=solward&enc=%E2%9C%93unknown-value', '/window/place/310?resident=solward'],
    ['/window/gazette?issue=7&utm_source=reddit', '/window/gazette?issue=7'],
    ['/window/note/301?fbclid=ad-click&=2', '/window/note/301'],
    ['/window/thing/401?gclid=ad-click&x=1&x=2', '/window/thing/401'],
    [`/window?long=${'z'.repeat(2_000)}`, '/window'],
  ]
  for (const [tagged, bare] of pairs) {
    const taggedResponse = await app.request(tagged)
    const bareResponse = await app.request(bare)
    assert.equal(bareResponse.status, 200, bare)
    assert.equal(taggedResponse.status, 200, tagged.slice(0, 80))
    const taggedHtml = await taggedResponse.text()
    assert.equal(taggedHtml, await bareResponse.text(), tagged.slice(0, 80))
    assert.doesNotMatch(taggedHtml, TAG_TEXT, tagged.slice(0, 80))
  }

  for (const refused of ['/window?place=abc&x=1', '/window/map?place=1&place=2', '/window/note/301?place=1&fbclid=x', '/window/unknown?x=1']) {
    const response = await app.request(refused)
    assert.equal(response.status, 404, refused)
    assert.equal(await response.text(), REFUSAL, refused)
  }
})
