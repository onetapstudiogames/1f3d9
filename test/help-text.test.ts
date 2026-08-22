import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { FRONTDOOR, LLMS } from '../src/door.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const normalizeLines = (value: string) => value.replace(/\r\n/gu, '\n')

const frontdoor = read('../src/frontdoor.txt')
const llms = read('../src/llms.txt')
const specification = read('../docs/SYSTEM_DESIGN.md')
const frontdoorDocument = read('../docs/published/FRONTDOOR.md')
const decisions = read('../docs/DECISIONS.md')
const openQuestions = read('../docs/archive/2026-08/RESOLVED_QUESTIONS.md')
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

test('the truth release keeps every public surface honest', () => {
  for (const [name, text] of [
    ['front door', frontdoor],
    ['generated front door', FRONTDOOR],
    ['compact machine map', llms],
    ['generated compact machine map', LLMS],
  ] as const) {
    // /api/action performs five of the seven basic actions; talk and make route elsewhere
    assert.match(text, /\/api\/action[^\n]*perform move, use, give, consume, or go_home/iu, name)
    assert.doesNotMatch(text, /\/api\/action[^\n]*seven basic actions/iu, name)
    // the anonymous reporting exception is disclosed, without leaking report text
    assert.match(text, /\/api\/flag/u, `${name}: flag route`)
    assert.match(text, /(?:report\s+text|reason)\s+stays\s+private/iu, `${name}: private reason`)
    assert.match(text, /never the report text/iu, `${name}: no report text in events`)
    // withdrawal is permanent on the route line itself
    assert.match(text, /withdraw[^\n]*permanent|permanent[^\n]*withdraw/iu, `${name}: permanent withdraw`)
    // speaking is local, reading is global
    assert.match(text, /public record, readable/iu, `${name}: notes readable from anywhere`)
    // join reveals the key and the first recovery codes together
    assert.match(text, /eight[\s\S]{0,60}recovery codes\s+are shown once/iu, `${name}: join reveals codes`)
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

test('public help sends voluntary root-key replacement only through the private browser', () => {
  for (const [name, text] of [
    ['front door source', frontdoor],
    ['front door documentation', frontdoorDocument],
    ['generated front door', FRONTDOOR],
    ['compact machine map', llms],
    ['generated compact machine map', LLMS],
    ['specification', specification],
  ] as const) {
    assert.match(text, /https:\/\/1f3d9\.com\/rotate/iu, `${name}: browser route`)
    assert.match(text, /show(?:n|s)? once/iu, `${name}: one-time display`)
    assert.match(text, /re-?enter/iu, `${name}: possession confirmation`)
    assert.match(text, /old (?:root |resident )?key[^\n]{0,160}(?:remain|stay|active|works?)/iu, `${name}: old root stays active`)
    assert.match(text, /(?:access|refresh|session|authorization code|auth code)[\s\S]{0,280}(?:stop|revoke|invalid)/iu, `${name}: delegated access dies`)
    assert.doesNotMatch(text, /POST\s+(?:https:\/\/1f3d9\.com)?\/api\/rotate/iu, `${name}: no credential API`)
  }
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

test('Wave 1 size, omission, writer-meter, and input-error truths stay aligned', () => {
  for (const [name, text] of [
    ['front door', frontdoor],
    ['compact machine map', llms],
    ['specification', specification],
  ] as const) {
    for (const field of [
      'total_items', 'total_text_bytes', 'returned_items', 'returned_text_bytes',
    ]) {
      assert.match(text, new RegExp(`\\b${field}\\b`, 'u'), `${name}: ${field}`)
    }
    assert.match(text, /UTF-8 bytes/iu, `${name}: byte unit`)
    assert.match(text, /stored authored text/iu, `${name}: counted text stage`)
    assert.match(text, /reading_cost/iu, `${name}: writer meter`)
    assert.match(text, /meter[^\n]{0,180}unavailable[^\n]{0,180}(?:write succeeded|do not retry)|(?:write succeeded|do not retry)[^\n]{0,180}meter[^\n]{0,180}unavailable/iu, `${name}: meter-only failure`)
    assert.match(text, /unknown query options?[^\n]{0,80}400|400[^\n]{0,80}unknown query options?/iu, `${name}: honest unknown option`)
    assert.match(text, /503[^\n]{0,120}Retry-After:\s*1|Retry-After:\s*1[^\n]{0,120}503/iu, `${name}: exact-read retry contract`)
    assert.match(text, /(?:map|window)[^\n]{0,180}(?:separate|existing|current) shapes?|(?:separate|existing|current) shapes?[^\n]{0,180}(?:map|window)/iu, `${name}: map/window exception`)
    assert.match(text, /\/api\/me[\s\S]{0,500}(?:personal (?:collection )?page metadata|common byte fields)/iu, `${name}: personal-page exception`)
  }

  assert.match(mcpSource, /name:\s*'say'[\s\S]{0,260}reading-cost meter/iu)
  assert.match(mcpSource, /name:\s*'make'[\s\S]{0,260}reading-cost meter/iu)
  assert.match(mcpSource, /place_id[\s\S]{0,500}paging[\s\S]{0,120}place_id/iu)
})

test('Wave 2 lightweight room and compatibility truths stay aligned', () => {
  for (const [name, text] of [
    ['front door', frontdoor],
    ['compact machine map', llms],
    ['specification', specification],
  ] as const) {
    assert.match(text, /view=outline|`view=outline`/iu, `${name}: outline choice`)
    assert.match(text, /view=full|`view=full`/iu, `${name}: full compatibility choice`)
    assert.match(text, /body_text_bytes/iu, `${name}: thing body size`)
    assert.match(text, /official[^\n]{0,80}look[^\n]{0,120}(?:defaults|uses)[^\n]{0,80}(?:view=outline|`view=outline`)/iu, `${name}: official lightweight default`)
    assert.match(text, /(?:raw HTTP|HTTP place)[^\n]{0,100}(?:defaults|default)[^\n]{0,100}(?:view=full|`view=full`|legacy full)|(?:view=full|`view=full`)[^\n]{0,100}(?:legacy|compatib)/iu, `${name}: raw compatibility default`)
    assert.match(text, /authenticated[^\n]{0,100}outline[^\n]{0,140}(?:observe|timer)|outline[^\n]{0,100}authenticated[^\n]{0,140}(?:observe|timer)/iu, `${name}: observation truth`)
  }
})

test('Wave 3 room text limits, strict omissions, and continuation truths stay aligned', () => {
  for (const [name, text] of [
    ['front door', frontdoor],
    ['compact machine map', llms],
    ['specification', specification],
  ] as const) {
    assert.match(text, /description_text_bytes/iu, `${name}: child description size`)
    assert.match(text, /outline[\s\S]{0,400}(?:child\s+descriptions|subplace\s+descriptions)[\s\S]{0,220}(?:note\s+bodies|notes)|(?:child\s+descriptions|subplace\s+descriptions)[\s\S]{0,220}(?:note\s+bodies|notes)[\s\S]{0,400}outline/iu, `${name}: complete outline omission`)
    for (const option of [
      'subplace_text_limit_bytes',
      'thing_text_limit_bytes',
      'note_text_limit_bytes',
    ]) {
      assert.match(text, new RegExp(`\\b${option}\\b`, 'u'), `${name}: ${option}`)
    }
    assert.match(text, /whole records?|never (?:cuts?|truncates?)/iu, `${name}: whole-record boundary`)
    assert.match(text, /stopped_for_text_limit/iu, `${name}: explicit byte omission flag`)
    assert.match(text, /next_item_id/iu, `${name}: blocked item id`)
    assert.match(text, /next_item_text_bytes/iu, `${name}: blocked item size`)
    assert.match(text, /increase[\s\S]{0,120}(?:limit|allowance)|(?:limit|allowance)[\s\S]{0,120}increase/iu, `${name}: increase-limit continuation`)
    assert.match(text, /655(?:,|_)?360/iu, `${name}: hard per-collection ceiling`)
    assert.match(text, /server_text_limit_applied/iu, `${name}: automatic-limit marker`)
    assert.match(text, /view=full[\s\S]{0,240}(?:bounded[\s-]+bulk|bulk[\s-]+page)|(?:bounded[\s-]+bulk|bulk[\s-]+page)[\s\S]{0,240}view=full/iu, `${name}: deliberate bounded bulk path`)
    assert.match(text, /cursor[\s\S]{0,100}complete\s+history|complete\s+history[\s\S]{0,100}cursor/iu, `${name}: complete-history continuation`)
    assert.match(text, /\/api\/thing\/:id[\s\S]{0,180}\/api\/note\/:id|\/api\/note\/:id[\s\S]{0,180}\/api\/thing\/:id/iu, `${name}: direct full reads`)
  }

  for (const option of [
    'subplace_text_limit_bytes',
    'thing_text_limit_bytes',
    'note_text_limit_bytes',
  ]) {
    assert.match(mcpSource, new RegExp(`\\b${option}\\b`, 'u'), `MCP: ${option}`)
  }
  assert.match(mcpSource, /outline[^\n]{0,180}child descriptions[^\n]{0,180}note bodies/iu)
  assert.match(mcpSource, /PUBLIC_PLACE_COLLECTION_TEXT_MAX_BYTES/iu)
})

test('public help explains shared use without promising shared consumption or owner damage', () => {
  for (const [name, text] of [
    ['front door', frontdoor],
    ['compact machine map', llms],
    ['specification', specification],
  ] as const) {
    assert.match(text, /\bopen_to_use\b/iu, `${name}: permission name`)
    assert.match(
      text,
      /(?:visitor|non-?owner|shared)[^\n]{0,140}\buse\b|\buse\b[^\n]{0,140}(?:visitor|non-?owner|shared)/iu,
      `${name}: visitors may use an open thing`,
    )
    assert.match(
      text,
      /\bconsume\b[^\n]{0,100}(?:owner(?:-only| only)|only (?:its |the )?owner)/iu,
      `${name}: consume remains owner-only`,
    )
    for (const effect of ['destroy', 'move', 'transfer']) {
      assert.match(
        text,
        new RegExp(`(?:shared|visitor|non-?owner)[^\\n]{0,180}\\b${effect}\\b[^\\n]{0,120}(?:source|thing)|\\b${effect}\\b[^\\n]{0,180}(?:shared|visitor|non-?owner)`, 'iu'),
        `${name}: shared use cannot ${effect} the source`,
      )
    }
  }

  for (const [name, text] of [
    ['specification', specification],
    ['decisions', decisions],
  ] as const) {
    assert.match(
      text,
      /(?:known limitation|not (?:yet )?supported|remain(?:s)? impossible)[^\n]{0,180}shared consumables|shared consumables[^\n]{0,180}(?:known limitation|not (?:yet )?supported|remain(?:s)? impossible)/iu,
      `${name}: shared consumables are a recorded limitation`,
    )
    assert.match(text, /caf[eé]|food|fruit/iu, `${name}: practical shared-consumable example`)
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
