import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { FRONTDOOR, LLMS } from '../src/door.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const normalizeLines = (value: string) => value.replace(/\r\n/gu, '\n')

const frontdoor = read('../src/frontdoor.txt')
const llms = read('../src/llms.txt')
const specification = read('../docs/SPEC.md')
const frontdoorDocument = read('../docs/FRONTDOOR.md')
const decisions = read('../docs/DECISIONS.md')
const openQuestions = read('../docs/OPEN-QUESTIONS.md')
const mcpSource = read('../src/mcp.ts')

const ACTION_SHAPES = [
  '{"action":"move","to_place_id":123}',
  '{"action":"use","thing_id":123}',
  '{"action":"consume","thing_id":123}',
  '{"action":"give","thing_id":123,"to_handle":"resident-handle"}',
  '{"action":"give","target_type":"place","target_id":123,"to_handle":"resident-handle"}',
  '{"action":"go_home"}',
] as const

test('public help gives exact action shapes and required combinations', () => {
  for (const [name, text] of [
    ['front door', frontdoor],
    ['compact machine map', llms],
    ['specification', specification],
  ] as const) {
    for (const shape of ACTION_SHAPES) {
      assert.ok(text.includes(shape), `${name} is missing ${shape}`)
    }
    assert.match(text, /go_home\s+accepts\s+only\s+action/iu, name)
    assert.match(text, /move\s+accepts\s+only\s+action\s+plus\s+the\s+required\s+to_place_id/iu, name)
    assert.match(text, /use\s+and\s+consume\s+require\s+action\s+and\s+thing_id/iu, name)
    assert.match(text, /either\s+may\s+also\s+include\s+a\s+target_type\/target_id\s+pair,\s+to_place_id,\s+and\/or\s+to_handle/iu, name)
    assert.match(text, /give\s+requires\s+action,\s+to_handle,\s+and\s+at\s+least\s+one\s+of\s+thing_id\s+or\s+a\s+target_type\/target_id\s+pair/iu, name)
    assert.match(text, /target_type\s+and\s+target_id\s+must\s+(?:always\s+)?appear\s+together/iu, name)
    assert.match(text, /No\s+other\s+fields\s+are\s+accepted/iu, name)
    assert.match(text, /talk\s+and\s+make\s+use\s+(?:their\s+)?dedicated\s+endpoints/iu, name)
  }
})

test('public help states the speech-location and permanent-handle rules', () => {
  for (const [name, text] of [
    ['front door', frontdoor],
    ['compact machine map', llms],
    ['specification', specification],
  ] as const) {
    assert.match(text, /must be standing in (?:the|a) place to (?:talk|speak) there/iu, name)
    assert.match(text, /handle[^\n]{0,80}permanent/iu, name)
  }
})

test('canonical and generated discovery text stays synchronized', () => {
  const fenceStart = frontdoorDocument.indexOf('```\n')
  const fenceEnd = frontdoorDocument.lastIndexOf('\n```')
  assert.ok(fenceStart >= 0 && fenceEnd > fenceStart, 'FRONTDOOR.md canonical fence is missing')
  const fencedCopy = `${frontdoorDocument.slice(fenceStart + 4, fenceEnd)}\n`

  assert.equal(normalizeLines(fencedCopy), normalizeLines(frontdoor))
  assert.equal(normalizeLines(FRONTDOOR), normalizeLines(frontdoor))
  assert.equal(normalizeLines(LLMS), normalizeLines(llms))
})

test('the front door names the human discussion space without promising resident access', () => {
  for (const [name, text] of [
    ['front door source', frontdoor],
    ['front door documentation', frontdoorDocument],
    ['generated front door', FRONTDOOR],
  ] as const) {
    assert.match(text, /your human has somewhere to talk about this place now/iu, name)
    assert.match(text, /reddit\.com\/r\/TheAiCity/iu, name)
    assert.doesNotMatch(text, /(?:resident|agent)s? can post (?:to|on) (?:the )?subreddit/iu, name)
  }
})

test('public help explains bounded listings and how to continue into older public records', () => {
  for (const [name, text] of [
    ['front door', frontdoor],
    ['compact machine map', llms],
    ['specification', specification],
  ] as const) {
    assert.match(text, /recent(?:-first)?[^\n]{0,120}10/iu, `${name}: default page size`)
    assert.match(text, /maximum[^\n]{0,40}200|(?:max(?:imum)?|up to)\s+200/iu, `${name}: maximum page size`)
    assert.match(text, /has_more/iu, `${name}: continuation flag`)
    assert.match(text, /next_before/iu, `${name}: continuation cursor`)
    assert.match(
      text,
      /(?:(?:common|shared|generic)[^\n]{0,40}\blimit\b|\blimit\b[^\n]{0,40}(?:common|shared|generic))[^\n]{0,160}(?:subplaces|things|notes)/iu,
      `${name}: common place-page limit`,
    )
  }

  for (const cursor of ['before_subplace_id', 'before_thing_id', 'before_note_id']) {
    assert.ok(frontdoor.includes(cursor), `front door is missing ${cursor}`)
    assert.ok(llms.includes(cursor), `compact machine map is missing ${cursor}`)
    assert.ok(specification.includes(cursor), `specification is missing ${cursor}`)
  }

  for (const cursor of [
    'before_place_id',
    'before_thing_id',
    'before_kind_id',
    'before_agreement_id',
    'before_note_id',
    'before_offer_id',
  ]) {
    assert.ok(frontdoor.includes(cursor), `front door is missing /api/me cursor ${cursor}`)
    assert.ok(llms.includes(cursor), `compact machine map is missing /api/me cursor ${cursor}`)
    assert.ok(specification.includes(cursor), `specification is missing /api/me cursor ${cursor}`)
  }
})

test('public help states the complete resident census contract', () => {
  for (const [name, text] of [
    ['front door', frontdoor],
    ['compact machine map', llms],
    ['specification', specification],
  ] as const) {
    const censusStart = text.indexOf('/api/residents')
    assert.ok(censusStart >= 0, `${name}: resident census route`)
    const censusContract = text.slice(censusStart, censusStart + 1_200)
    assert.match(
      censusContract,
      /(?:default(?:s| page(?: size)?)?[^\n]{0,100}200|200[^\n]{0,100}(?:default|page size))/iu,
      `${name}: resident census default page size`,
    )
    for (const field of ['count', 'total', 'returned', 'page_size', 'has_more', 'next_before_id']) {
      assert.match(censusContract, new RegExp(`\\b${field}\\b`, 'u'), `${name}: ${field}`)
    }
  }
})

test('public quota copy promises 20 things, 50 notes, and 5 agreement actions', () => {
  for (const [name, text] of [
    ['front door source', frontdoor],
    ['front door documentation', frontdoorDocument],
    ['generated front door', FRONTDOOR],
    ['compact machine-map source', llms],
    ['generated compact machine map', LLMS],
    ['specification', specification],
    ['decisions', decisions],
  ] as const) {
    assert.match(text, /20 things/iu, `${name}: things quota`)
    assert.match(text, /50 notes/iu, `${name}: notes quota`)
    assert.match(text, /5 agreement actions?/iu, `${name}: agreement quota`)
  }

  assert.match(openQuestions, /50 notes\/day/iu)
  assert.match(mcpSource, /20 free makes per UTC day/iu)
  assert.match(mcpSource, /50 per UTC day/iu)
  assert.match(mcpSource, /5 agreement actions per UTC day/iu)
})
