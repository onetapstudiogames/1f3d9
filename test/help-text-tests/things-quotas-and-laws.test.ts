import assert from 'node:assert/strict'
import test from 'node:test'
import { FRONTDOOR, LLMS, decisions, frontdoor, frontdoorDocument, llms, mcpSource, openQuestions, read, renderCityHelpText, specification } from '../helpers/help-text-fixtures/door-surfaces.ts'

export function registerThingsQuotasAndLawsTests(): void {
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

  test('resident law timing, effect counts, and label privacy are stated before use', () => {
    for (const [name, text] of [
      ['front door source', frontdoor],
      ['front door documentation', frontdoorDocument],
      ['generated front door', FRONTDOOR],
      ['compact machine-map source', llms],
      ['generated compact machine map', LLMS],
      ['specification', specification],
    ] as const) {
      assert.match(text, /move runs the laws of the\s+place being left/iu, `${name}: origin-place laws`)
      assert.match(text, /arrival alone does not run the\s+destination(?:'s)?\s+laws/iu, `${name}: arrival does not run laws`)
      assert.match(
        text,
        /effects_applied[\s\S]{0,180}not distinct visible (?:changes|values)/iu,
        `${name}: effect applications are not visible deltas`,
      )
      assert.match(text, /resident labels are private to their bearer/iu, `${name}: label privacy`)
      assert.match(
        text,
        /public resident[\s\S]{0,180}event[\s\S]{0,180}(?:omit|do not disclose)[\s\S]{0,100}label holdings/iu,
        `${name}: public label omission`,
      )
    }

    for (const [name, text] of [
      ['front door source', frontdoor],
      ['front door documentation', frontdoorDocument],
      ['generated front door', FRONTDOOR],
    ] as const) {
      assert.match(
        text,
        /hosted clients cache the tool list[\s\S]{0,150}remove the connector\s+completely\s+and\s+add it\s+again/iu,
        `${name}: remove and re-add to refresh cached tools`,
      )
    }

    assert.match(mcpSource, /name: 'act'[\s\S]{0,2500}move runs the laws of the\s+place being left/iu)
    assert.match(mcpSource, /name: 'browse'[\s\S]{0,2500}resident label holdings/iu)
    assert.match(mcpSource, /name: 'me'[\s\S]{0,2500}labels are private to the authenticated bearer/iu)
  })

  test('events place matching names a move\'s from_place_id and to_place_id, and a failed action matches nowhere', () => {
    for (const [name, text] of [
      ['front door source', frontdoor],
      ['generated front door', FRONTDOOR],
      ['published front door', frontdoorDocument],
      ['compact machine map source', llms],
      ['generated compact machine map', LLMS],
    ] as const) {
      assert.match(
        text,
        /from_place_id[\s\S]{0,60}to_place_id[\s\S]{0,80}move matches at both/iu,
        `${name}: a move matches at both endpoints`,
      )
      assert.match(
        text,
        /failed action stores no place and matches\s+nowhere/iu,
        `${name}: a failed action matches nowhere`,
      )
    }
  })

  test('the laws help line says laws sets a place\'s law traits and names the PUT route, not that it reads them', () => {
    const helpSource = read('../src/city-help.ts')
    const renderedFrontdoor = renderCityHelpText(frontdoor)
    for (const [name, text] of [
      ['city-help.ts source', helpSource],
      ['rendered front door', renderedFrontdoor],
      ['generated front door', FRONTDOOR],
      ['published front door', frontdoorDocument],
    ] as const) {
      assert.match(text, /`laws`[^\n]{0,40}(?:replaces|sets)[^\n]{0,80}law traits/iu, `${name}: laws sets, not reads`)
      assert.match(text, /PUT \/api\/place\/:id\/laws/u, `${name}: names the PUT route`)
    }
    assert.doesNotMatch(
      helpSource,
      /`laws` reads the laws/iu,
      'the stale "laws reads the laws where you stand" line must be gone',
    )
  })

  test('a kind\'s trait recipe only fires for use, consume, and give with thing_id, never move, talk, make, or go_home', () => {
    for (const [name, text] of [
      ['front door source', frontdoor],
      ['generated front door', FRONTDOOR],
      ['published front door', frontdoorDocument],
      ['compact machine map source', llms],
      ['generated compact machine map', LLMS],
      ['specification', specification],
    ] as const) {
      assert.match(
        text,
        /kind('?s)? traits? (?:is|are) consulted only for[\s\S]{0,60}use[\s\S]{0,20}consume[\s\S]{0,20}give/iu,
        `${name}: kind traits fire only for use, consume, give`,
      )
      assert.match(
        text,
        /move[\s\S]{0,20}talk[\s\S]{0,20}make[\s\S]{0,20}go_home[\s\S]{0,80}never/iu,
        `${name}: move, talk, make, go_home never name a source thing`,
      )
    }
    assert.doesNotMatch(
      mcpSource,
      /other actions can run local laws and thing traits/iu,
      'the misleading "other actions can run ... thing traits" clause must be gone from the act tool',
    )
    assert.match(
      mcpSource,
      /use, consume, and give also run the named thing's kind traits/iu,
      'the act tool must state which actions run kind traits',
    )
  })
}
