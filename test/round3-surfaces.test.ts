import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { FRONTDOOR, LLMS } from '../src/door.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const normalize = (value: string) => value.replace(/\r\n/gu, '\n')
const frontdoor = read('../src/frontdoor.txt')
const published = read('../docs/published/FRONTDOOR.md')
const llms = read('../src/llms.txt')

const publicSurfaces = [
  ['front door', frontdoor],
  ['published front door', published],
  ['generated front door', FRONTDOOR],
  ['compact map', llms],
  ['generated compact map', LLMS],
] as const

test('the published front-door fence exactly mirrors its source', () => {
  const match = normalize(published).match(/```\n([\s\S]*?)\n```/u)
  assert.ok(match, 'published front door has no fenced source mirror')
  assert.equal(match[1], normalize(frontdoor).trimEnd())
})

test('raw authoring and edit contracts state examples, normalization, limits, and locks', () => {
  const examples = [
    '{"name":"glowing","description":"emits light"}',
    '{"name":"lantern","description":"a light","traits":["glowing"],"recipe":[{"kind":"wick","quantity":1}]}',
    '{"description":"a brighter light","traits":["glowing"]}',
  ] as const
  for (const [name, text] of publicSurfaces) {
    const compact = text.replace(/\s+/gu, ' ')
    for (const example of examples) assert.ok(text.includes(example), `${name}: ${example}`)
    assert.match(compact, /names?[^.]{0,80}trim[^.]{0,80}lowercase/iu, `${name}: normalized names`)
    assert.match(compact, /descriptions?[^.]{0,100}default[^.]{0,40}empty[^.]{0,100}4,?000[^.]{0,40}safe characters/iu, `${name}: description contract`)
    assert.match(compact, /traits?[^.]{0,100}default[^.]{0,40}empty[^.]{0,100}32[^.]{0,60}unique[^.]{0,80}(?:already exist|existing)/iu, `${name}: trait contract`)
    assert.match(compact, /kind recipes?[^.]{0,80}default to `?\[\]`?[^.]{0,80}64 ingredient rows[^.]{0,100}1\.\.1024[^.]{0,100}1024 total[^.]{0,100}65,?536 bytes/iu, `${name}: kind recipe defaults and limits`)
    assert.match(compact, /omitted revise fields[^.]{0,80}(?:retain|keep)[^.]{0,80}current[^.]{0,100}open sale[^.]{0,40}(?:blocks|refuses)/iu, `${name}: revise omission and lock`)
    assert.match(compact, /trait recipes?[^.]{0,80}default to inert `?null`?[^.]{0,100}(?:action\/effect|actions? and effects?)[^.]{0,100}\/api\/physics/iu, `${name}: trait recipe default and vocabulary`)
    assert.match(compact, /safe text rejects[^.]{0,80}control[^.]{0,40}bidi[^.]{0,80}lone surrogates[^.]{0,100}(?:replacement|mojibake)[^.]{0,100}credential-shaped/iu, `${name}: safe text definition`)
    assert.match(compact, /safe one-line labels[^.]{0,60}trimmed[^.]{0,100}world names[^.]{0,100}lowercased[^.]{0,100}other safe text[^.]{0,80}(?:unchanged|not normalized)/iu, `${name}: text normalization`)
    assert.match(compact, /PATCH \/api\/place\/:id[^.]{0,420}4,?000 safe characters[^.]{0,140}open sale/iu, `${name}: place edit limits`)
    assert.match(compact, /PATCH \/api\/thing\/:id[^.]{0,320}1\.\.120 safe characters[^.]{0,160}65,?536 safe UTF-8 bytes[^.]{0,140}open sale/iu, `${name}: thing edit limits`)
  }
})

test('public reads name bounded window text, fuller calls, markers, and reference-only changes', () => {
  for (const [name, text] of publicSurfaces) {
    const compact = text.replace(/\s+/gu, ' ')
    assert.match(compact, /full (?:public )?window[^.]{0,120}(?:depth-bounded at 32|stops (?:place traversal )?at depth 32)[^.]{0,120}map_complete[^.]{0,80}false/iu, `${name}: full-window depth contract`)
    assert.match(compact, /note, thing, and agreement body excerpts[^.]{0,80}2,?000, 1,?000, and 4,?000[^.]{0,100}`?truncated`?/iu, `${name}: window body caps`)
    assert.match(compact, /GET \/api\/note\/:id[^.]{0,120}GET \/api\/thing\/:id[^.]{0,120}full[^.]{0,120}no fuller public agreement/iu, `${name}: fuller body reads`)
    assert.match(compact, /after_change_marker[^.]{0,140}map outline[^.]{0,140}window outline\/history[^.]{0,140}events/iu, `${name}: route marker signatures`)
    assert.match(compact, /\/api\/changes[^.]{0,120}reference-only notices[^.]{0,140}(?:whitelisted scalars and IDs|whitelisted scalar fields and IDs)[^.]{0,100}(?:not|never)[^.]{0,80}full event/iu, `${name}: reference-only changes`)
  }
})

test('world listing, sign replay, pending effects, and make results are disclosed before use', () => {
  for (const [name, text] of publicSurfaces) {
    const compact = text.replace(/\s+/gu, ' ')
    assert.match(compact, /(?:POST \/api\/world\/listing|list_world)[^.]{0,80}(?:active|not[- ]withdrawn)[^.]{0,80}owned[^.]{0,80}unlocked[^.]{0,140}pending[^.]{0,80}unexpired[^.]{0,80}unlisted/iu, `${name}: world listing preconditions`)
    assert.match(compact, /reconcile[^.]{0,100}cancel[^.]{0,100}explicit `?\{\}`?[^.]{0,100}bodyless[^.]{0,40}fails/iu, `${name}: explicit empty objects`)
    assert.match(compact, /repeat(?:ed|ing)? sign[^.]{0,100}existing signature[^.]{0,100}original `?signed_at`?[^.]{0,100}no[^.]{0,40}(?:daily )?(?:agreement[- ]action )?quota/iu, `${name}: sign replay`)
    assert.match(compact, /act[^.]{0,80}me[^.]{0,120}pending effects?[^.]{0,120}\/api\/physics/iu, `${name}: pending-effect ceilings`)
    assert.match(compact, /crafted (?:make|POST \/api\/thing)[^.]{0,100}consumed_ingredient_ids[^.]{0,100}kindless[^.]{0,80}(?:omit|without)/iu, `${name}: make response distinction`)
  }
})

test('the public MCP error contract classifies downstream 404 as not_found', () => {
  for (const [name, text] of publicSurfaces) {
    assert.match(text, /error_class[\s\S]{0,220}not_found[^.\n]{0,80}404/iu, name)
  }
})
