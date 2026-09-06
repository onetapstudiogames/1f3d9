import assert from 'node:assert/strict'
import test from 'node:test'
import { FRONTDOOR, LLMS, decisions, frontdoor, frontdoorDocument, hostedSignin, llms, mcpSource, specification } from '../helpers/help-text-fixtures/door-surfaces.ts'

export function registerWindowRecordsTests(): void {
  test('public help describes the human window combined search and flat numbered place picker', () => {
    for (const [name, text] of [
      ['front door source', frontdoor],
      ['front door documentation', frontdoorDocument],
      ['generated front door', FRONTDOOR],
      ['compact machine-map source', llms],
      ['generated compact machine map', LLMS],
    ] as const) {
      assert.match(text, /standalone search[\s\S]{0,220}places?[\s\S]{0,80}residents?/iu, `${name}: combined search`)
      assert.match(text, /results? list[\s\S]{0,100}(?:below|under)/iu, `${name}: separate results list`)
      assert.match(text, /every place row[\s\S]{0,80}place #id/iu, `${name}: typed place rows`)
      assert.match(text, /continent[\s\S]{0,100}(?:once|one)[\s\S]{0,100}clickable/iu, `${name}: one clickable continent row`)
      assert.match(text, /(?:nested )?rooms?[\s\S]{0,100}indent/iu, `${name}: indented rooms`)
      assert.doesNotMatch(text, /Inside <name>/u, `${name}: no non-clickable continent heading`)
      assert.doesNotMatch(text, /the whole continent/iu, `${name}: no duplicate continent row`)
    }
  })

  test('public help states the enabled public-snapshot schedule', () => {
    for (const [name, text] of [
      ['front door source', frontdoor],
      ['front door documentation', frontdoorDocument],
      ['generated front door', FRONTDOOR],
      ['compact machine-map source', llms],
      ['generated compact machine map', LLMS],
    ] as const) {
      assert.match(text, /enabled[\s\S]{0,180}(?:daily[\s\S]{0,80}08:17 UTC|08:17 UTC[\s\S]{0,80}daily)/iu, name)
      assert.match(text, /17 8 \* \* \*/u, `${name}: cron expression`)
      assert.doesNotMatch(text, /after (?:it is enabled|enablement)/iu, `${name}: no stale enablement qualifier`)
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
      const censusContract = text.slice(censusStart, censusStart + 2_800)
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
      assert.match(text, /measurement_timeout/iu, `${name}: named meter timeout`)
      assert.match(text, /database[ -]query[\s\S]{0,100}(?:earlier|bounded)[\s\S]{0,80}deadline|(?:earlier|bounded)[\s\S]{0,80}database[ -]query[\s\S]{0,80}deadline/iu, `${name}: bounded meter query`)
      assert.match(text, /unknown query options?[^\n]{0,80}400|400[^\n]{0,80}unknown query options?/iu, `${name}: honest unknown option`)
      assert.match(text, /503[^\n]{0,120}Retry-After:\s*1|Retry-After:\s*1[^\n]{0,120}503/iu, `${name}: exact-read retry contract`)
      assert.match(text, /(?:map|window)[^\n]{0,180}(?:separate|existing|current) (?:shapes?|fields?)|(?:separate|existing|current) (?:shapes?|fields?)[^\n]{0,180}(?:map|window)/iu, `${name}: map/window exception`)
      assert.match(text, /\/api\/me[\s\S]{0,500}(?:personal (?:collection )?page metadata|common byte fields)/iu, `${name}: personal-page exception`)
    }

    assert.match(mcpSource, /name:\s*'say'[\s\S]{0,2200}reading-cost meter/iu)
    assert.match(mcpSource, /name:\s*'make'[\s\S]{0,600}reading-cost meter/iu)
    assert.match(mcpSource, /place_id[\s\S]{0,500}paging[\s\S]{0,120}place_id/iu)
  })

  test('Wave 2 lightweight room, passive look, and compatibility truths stay aligned', () => {
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
      assert.match(
        text,
        /enter(?:ing|s)?[^\n]{0,100}interact(?:ing|s)?[^\n]{0,100}check(?:ing|s)?[^\n]{0,40}(?:`?me`?)[^\n]{0,100}(?:due )?timers?/iu,
        `${name}: active timer triggers`,
      )
      assert.match(
        text,
        /(?:place (?:reads?|look)|look(?:ing)? at (?:a )?place)[^\n]{0,180}(?:passive|read-only)[^\n]{0,180}(?:credential|auth)|(?:credential|auth)[^\n]{0,180}(?:place (?:reads?|look)|look(?:ing)? at (?:a )?place)[^\n]{0,180}(?:passive|read-only)/iu,
        `${name}: credential-blind passive place reads`,
      )
      assert.doesNotMatch(
        text,
        /authenticated[^\n]{0,100}(?:place|outline|look)[^\n]{0,140}(?:resolve|wake)[^\n]{0,40}(?:due )?timers?/iu,
        `${name}: no credential-triggered look`,
      )
    }

    assert.match(
      decisions,
      /\| 37 \| \*\*Place reads are passive\.\*\*[\s\S]{0,500}never authenticate, wake timers, or change city state/iu,
      'decision 37 locks passive place reads',
    )
    assert.match(
      decisions,
      /Entering, interacting, or checking `me` wakes due timers[\s\S]{0,220}supersedes only the observation-trigger clause of decision #24/iu,
      'decision 37 records active timer triggers and the narrow supersession',
    )
    assert.match(
      specification,
      /shared catalog has 41 tools[\s\S]{0,900}legacy `\/mcp` advertises all 41[\s\S]{0,180}Hosted `\/mcp\/connect`[\s\S]{0,100}40[\s\S]{0,100}omits founder-only `moderate`/iu,
      'the specification distinguishes the exact legacy and hosted catalogs',
    )
    assert.match(
      hostedSignin,
      /shared and\s+authenticated legacy[\s\S]{0,100}catalog has 41 tools[\s\S]{0,100}hosted chat advertises 40[\s\S]{0,100}omits\s+founder-only `moderate`/iu,
      'the hosted sign-in guide distinguishes the exact legacy and hosted catalogs',
    )
  })
}
