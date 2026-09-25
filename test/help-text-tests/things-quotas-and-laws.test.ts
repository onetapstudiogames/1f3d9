import assert from 'node:assert/strict'
import test from 'node:test'
import { generatedReference, decisions, referenceSource, mcpSource, openQuestions, read, renderCityHelpText, specification } from '../helpers/help-text-fixtures/door-surfaces.ts'
import { STALE_TOOLS_FIX } from '../../src/tool-list-change.ts'

export function registerThingsQuotasAndLawsTests(): void {
  test('public help explains shared use without promising shared consumption or owner damage', () => {
    for (const [name, text] of [
      ['reference source', referenceSource],
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
      for (const effect of ['move', 'transfer']) {
        assert.match(
          text,
          new RegExp(`(?:shared|visitor|non-?owner)[^\\n]{0,180}\\b${effect}\\b[^\\n]{0,120}(?:source|thing)|\\b${effect}\\b[^\\n]{0,180}(?:shared|visitor|non-?owner)`, 'iu'),
          `${name}: shared use cannot ${effect} the source`,
        )
      }
      assert.match(
        text,
        /shared_use_may_destroy[\s\S]{0,120}defaults?\s+false/iu,
        `${name}: the destroy switch defaults closed`,
      )
      assert.match(
        text,
        /shared_use_may_destroy[\s\S]{0,200}only the owner may change it/iu,
        `${name}: only the owner opens the destroy switch`,
      )
      assert.match(
        text,
        /both\s+switches are true[\s\S]{0,140}visitor[\s\S]{0,80}destroy/iu,
        `${name}: an owner may let a visitor use destroy the thing`,
      )
      assert.match(
        text,
        /delayed\s+destroy[\s\S]{0,200}(?:closing either|still stops|stops it)/iu,
        `${name}: a delayed destroy is checked again when it fires`,
      )
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

  test('served copy says the dated public snapshots do not carry the destroy switch yet', () => {
    for (const [name, text] of [
      ['reference source', referenceSource],
      ['generated reference', generatedReference],
      ['specification', specification],
    ] as const) {
      assert.match(
        text,
        /shared_use_may_destroy[\s\S]{0,200}dated public\s+snapshots do not\s+carry/iu,
        `${name}: the dated public snapshots do not carry the destroy switch yet`,
      )
    }
  })

  test('tool copy needs both switches for a visitor destroy and never narrows it to the thing own recipe', () => {
    assert.match(
      mcpSource,
      /omitted shared_use_may_destroy; a visitor's use may destroy this thing only while you have set both true/iu,
      'make: omitting the switch does not open a visitor destroy',
    )
    assert.equal(
      /shared_use_may_destroy[\s\S]{0,240}its own recipe/iu.test(mcpSource),
      false,
      'no tool copy narrows a shared destroy to the thing own recipe',
    )
    assert.match(
      mcpSource,
      /shared_use_may_destroy, which every live public thing read states/iu,
      'act: the switch is read back from a live public thing read',
    )
  })

  test('public quota copy promises 20 things, 50 notes, and 5 agreement actions', () => {
    for (const [name, text] of [
      ['reference source', referenceSource],
      ['generated reference', generatedReference],
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
    assert.match(mcpSource, /AGREEMENT_ACTIONS_LIMIT_LINE/u)
  })

  test('resident law timing, effect counts, and label privacy are stated before use', () => {
    for (const [name, text] of [
      ['reference source', referenceSource],
      ['generated reference', generatedReference],
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
      ['reference source', referenceSource],
      ['generated reference', generatedReference],
    ] as const) {
      assert.match(
        text,
        /Hosted chat apps keep their own copy of the tool list, and reconnecting can keep the\s+old copy after new city tools ship\./u,
        `${name}: a hosted app keeps its own copy of the tool list`,
      )
      assert.doesNotMatch(text, /remove the connector\s+completely/iu, `${name}: no retired remove-completely wording`)
    }
    assert.ok(
      referenceSource.includes('old copy after new city tools ship. {{STALE_TOOLS_FIX}}'),
      'reference source: moving-in gives the fix through the token',
    )
    assert.ok(
      generatedReference.replace(/\s+/gu, ' ').includes(`old copy after new city tools ship. ${STALE_TOOLS_FIX}`),
      'generated reference: moving-in gives the one fix',
    )

    assert.match(mcpSource, /name: 'act'[\s\S]{0,2800}move runs the laws of the\s+place being left/iu)
    assert.match(mcpSource, /name: 'me'[\s\S]{0,2500}reference\/public-history\.txt/iu)
  })

  test('same-use destruction keeps its result and names every skipped later source', () => {
    for (const [name, text] of [
      ['reference source', referenceSource],
      ['generated reference', generatedReference],
      ['specification', specification],
      ['act tool', mcpSource],
    ] as const) {
      assert.match(
        text,
        /immediate effect destroys a thing/iu,
        `${name}: immediate destroy`,
      )
      assert.match(
        text,
        /later immediate\s+effect[\s\S]{0,180}skipped/iu,
        `${name}: same-use destroyed target is skipped`,
      )
      assert.match(text, /skipped_effects/iu, `${name}: skipped result field`)
      assert.match(
        text,
        /(?:different missing target|another missing or unavailable target)[\s\S]{0,60}still refuses/iu,
        `${name}: another missing target still refuses`,
      )
      assert.match(
        text,
        /wait[\s\S]{0,100}(?:resolves|resolve)[\s\S]{0,80}(?:later|separately)/iu,
        `${name}: delayed effect boundary`,
      )
    }
    assert.match(decisions, /^\| 96 \| \*\*Destruction stands within one immediate use\.\*\*/mu)
  })

  test('events place matching names a move\'s from_place_id and to_place_id, and a failed action matches nowhere', () => {
    for (const [name, text] of [
      ['reference source', referenceSource],
      ['generated reference', generatedReference],
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
    const renderedReference = renderCityHelpText(referenceSource)
    for (const [name, text] of [
      ['city-help.ts source', helpSource],
      ['rendered reference', renderedReference],
      ['generated reference', generatedReference],
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
      ['reference source', referenceSource],
      ['generated reference', generatedReference],
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
