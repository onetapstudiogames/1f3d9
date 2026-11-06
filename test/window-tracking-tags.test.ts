import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import * as sharing from '../src/window-sharing.ts'
import { windowPage } from '../src/window.ts'

// Ad, mail, and social tools append link-tracking tags to a shared link. Reddit
// adds rdt_cid to every ad click on /window, so a tag must load the same page
// the bare link loads, while any other unknown name still refuses as before.
const REFUSAL = 'that public city window link is not available; return to /window and create a new Share link'

const NAMED_TAGS = [
  'rdt_cid', 'gclid', 'gad_source', 'gad_campaignid', 'gbraid', 'wbraid', 'dclid',
  'fbclid', 'msclkid', 'ttclid', 'twclid', 'li_fat_id', 'igshid', 'mc_cid', 'mc_eid', 'ref',
] as const

const TAG_TEXT = /rdt_cid|utm_|fbclid|gclid|gad_|ad-click/u

function windowApp() {
  const app = new Hono()
  const readRecord = async () => null
  app.get('/window', c => windowPage(c, false, readRecord))
  app.get('/window/:view', c => windowPage(c, false, readRecord, undefined, async issue => issue === 7))
  app.get('/window/:kind/:id', c => windowPage(c, false, readRecord))
  return app
}

test('the window keeps one named rule for link-tracking tags', () => {
  const rule = (sharing as Record<string, unknown>).WINDOW_LINK_TRACKING_TAGS
  assert.deepEqual(rule, { prefix: 'utm_', names: NAMED_TAGS })
  assert.ok(Object.isFrozen(rule))
  const isTag = (sharing as Record<string, unknown>).isWindowLinkTrackingTag
  assert.equal(typeof isTag, 'function')
  const check = isTag as (name: string) => boolean
  for (const name of [...NAMED_TAGS, 'utm_source', 'utm_medium', 'utm_campaign', 'utm_anything']) {
    assert.equal(check(name), true, name)
  }
  for (const name of ['place', 'resident', 'issue', 'notes', 'unknown', 'UTM_SOURCE', 'Rdt_cid', 'referrer', 'xutm_source']) {
    assert.equal(check(name), false, name)
  }
})

test('a link-tracking tag loads the same window state the bare link loads', () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['/window', '?rdt_cid=x', ''],
    ['/window', '?utm_source=reddit', ''],
    ['/window', '?utm_source=reddit&utm_medium=cpc&utm_campaign=launch&rdt_cid=ad-click', ''],
    ['/window/map', '?place=310&rdt_cid=x', '?place=310'],
    ['/window/map', '?rdt_cid=x&place=310', '?place=310'],
    ['/window/place/310', '?resident=solward&gclid=x&utm_content=a', '?resident=solward'],
    ['/window/archive', '?q=hush+lantern&mode=phrase&type=thing&fbclid=x', '?q=hush+lantern&mode=phrase&type=thing'],
    ['/window/gazette', '?issue=7&utm_source=reddit', '?issue=7'],
    ['/window/note/301', '?fbclid=x', ''],
    ['/window/thing/401', '?utm_source=a&utm_source=b', ''],
    ...NAMED_TAGS.map(name => ['/window', `?${name}=ad-click`, ''] as const),
  ]
  for (const [path, tagged, bare] of cases) {
    const expected = sharing.parseWindowShareRequest(path, bare)
    assert.ok(expected, `${path}${bare} must load`)
    const actual = sharing.parseWindowShareRequest(path, tagged)
    assert.deepEqual(actual, expected, `${path}${tagged}`)
    assert.doesNotMatch(actual?.canonicalPath ?? '', TAG_TEXT, `${path}${tagged}`)
  }
  const mixed = sharing.parseWindowShareRequest('/window/map', '?place=310&rdt_cid=x')
  assert.equal(mixed?.state.placeId, 310)
  assert.equal(mixed?.canonicalPath, '/window/map?place=310')
})

test('every other unknown name still refuses the window link exactly as before', () => {
  const refused: ReadonlyArray<readonly [string, string]> = [
    ['/window', '?notes=open'],
    ['/window', '?rdt_cid=x&notes=open'],
    ['/window', '?UTM_SOURCE=reddit'],
    ['/window', '?referrer=x'],
    ['/window/map', '?place=1&place=2&utm_source=x'],
    ['/window/map', '?place=0&gclid=x'],
    ['/window/note/301', '?place=310'],
    ['/window/note/301', '?place=310&fbclid=x'],
    ['/window/thing/401', '?resident=solward&utm_source=x'],
    ['/window/gazette', '?issue=7&place=1&utm_source=x'],
    ['/window/unknown', '?rdt_cid=x'],
  ]
  for (const [path, search] of refused) {
    assert.equal(sharing.parseWindowShareRequest(path, search), null, `${path}${search}`)
  }
})

test('tagged window pages answer 200 with the same page and never echo the tag', async () => {
  const app = windowApp()
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['/window?rdt_cid=ad-click', '/window'],
    ['/window?utm_source=reddit&utm_campaign=launch', '/window'],
    ['/window/map?place=310&rdt_cid=ad-click', '/window/map?place=310'],
    ['/window/place/310?resident=solward&rdt_cid=ad-click', '/window/place/310?resident=solward'],
    ['/window/gazette?issue=7&utm_source=reddit', '/window/gazette?issue=7'],
    ['/window/note/301?fbclid=ad-click', '/window/note/301'],
    ['/window/thing/401?gclid=ad-click', '/window/thing/401'],
    ['/window?gad_source=1&gad_campaignid=123&gclid=ad-click', '/window'],
  ]
  for (const [tagged, bare] of pairs) {
    const taggedResponse = await app.request(tagged)
    const bareResponse = await app.request(bare)
    assert.equal(bareResponse.status, 200, bare)
    assert.equal(taggedResponse.status, 200, tagged)
    const taggedHtml = await taggedResponse.text()
    assert.equal(taggedHtml, await bareResponse.text(), tagged)
    assert.doesNotMatch(taggedHtml, TAG_TEXT, tagged)
  }

  for (const refused of ['/window?notes=open', '/window?rdt_cid=x&notes=open', '/window/note/301?place=310&fbclid=x']) {
    const response = await app.request(refused)
    assert.equal(response.status, 404, refused)
    assert.equal(await response.text(), REFUSAL, refused)
  }
})
