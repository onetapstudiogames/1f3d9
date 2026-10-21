import assert from 'node:assert/strict'
import test from 'node:test'
import { generatedReference, decisions, referenceSource, mcpSource, openQuestions, read, renderCityHelpText, specification } from '../helpers/help-text-fixtures/door-surfaces.ts'
import { STALE_TOOLS_FIX } from '../../src/tool-list-change.ts'
import { parseTraitRecipe } from '../../src/physics.ts'
import { GENERATED_LLMS, REFERENCE_SECTIONS, starterLlmsSource } from '../helpers/help-text-fixtures/door-surfaces.ts'

export function registerThingsQuotasAndLawsTests(): void {
  const decision163 = decisions.match(/^\| 163 \|.*$/mu)?.[0] ?? ''
  const placeDesign = specification.match(/## Laws of places[^\n]*\n([\s\S]*?)(?=\n## )/u)?.[1] ?? ''
  for (const [name, text] of [
    ['reference source', referenceSource],
    ['system design', placeDesign],
    ['decision 163', decision163],
  ] as const) {
    const prose = text.replace(/`/gu, '').replace(/\s+/gu, ' ')
    for (const [contract, pattern] of [
      ['original source identity', /original defining place[\s\S]*never a law named by a later check/u],
      ['law-only label and check target', /only for label and check_label/u],
      ['required defining-place duration', /label on law_place requires seconds, a whole number from 1 to 86400/u],
      ['optional local-place duration', /label on literal place may use the same (?:field|range)[\s\S]*omission keeps its existing permanent label behavior|label on literal place may use the same range; omitting seconds keeps its permanent label/u],
      ['current source law and delayed guard', /exact source law (?:must still be|is still) effective[\s\S]*(?:checked again when delayed work runs|check again when a delayed step runs)/u],
      ['no hinge reach', /[Aa] hinge[^.]*grants no (?:shared state|reach)/u],
      ['label-only new check', /check_label on law_place reads active labels only, (?:never an adopted law's name|not adopted law names), and grants no (?:named-law|further) authority/u],
      ['unchanged existing checks', /[Ee]xisting check_label targets keep (?:their meaning|matching active labels or a law name)/u],
      ['append-only repeated labels', /[Ll]abel (?:writes|rows) append/u],
      ['permanent label collision', /permanent (?:same-name )?row keeps (?:the|that) name present/u],
      ['passive expiry', /Expired names are absent without a write|Expiry is tested against the stored end time on reads and checks, with no background action and no deletion/u],
    ] as const) {
      test(`${name}: shared place contract preserves ${contract}`, () => {
        assert.ok(pattern.test(prose), `${name}: ${contract}`)
      })
    }
  }

  for (const [contract, pattern] of [
    ['stable origin through nested checks and timers', /originPlaceId[\s\S]*lawAuthority.sourcePlaceId[\s\S]*nested check[\s\S]*timers preserve/u],
    ['accepted targets and duration refusals', /label and check_label accept actor, source, target, place, or law_place[\s\S]*actor, source, and target refuse seconds, even when target names a place[\s\S]*check_label takes no seconds/u],
    ['current chain and retirement guard', /source, room, and connecting parent places must still form an unbroken same-owner chain and none may be retired/u],
    ['current room and visitors', /place still names the run's current room[\s\S]*visitors can trigger an installed law through a permitted action; they need not own the place/u],
    ['execution-time lifetime', /duration starts when the label is written, including after a wait/u],
    ['no new tool or migration', /no new action, tool, or brick[\s\S]*No migration is needed/u],
    ['unchanged public shape', /labels: string\[\][\s\S]*sourcePlaceId[\s\S]*No expiry timestamp is added to the place response/u],
    ['human views refresh current local facts', /window and separate live view[\s\S]*local label names[\s\S]*links to defining places[\s\S]*refresh[\s\S]*selected[\s\S]*even when no new event[\s\S]*ancestor labels are not copied/u],
    ['existing storage and frozen snapshots', /nullable expires_at[\s\S]*pending effects[\s\S]*snapshot format v3[\s\S]*frozen time/u],
  ] as const) {
    test(`system design: shared place contract preserves ${contract}`, () => {
      assert.ok(pattern.test(placeDesign.replace(/`/gu, '').replace(/\s+/gu, ' ')), contract)
    })
  }

  test('shared place delivery stays open and things ending remain a separate future phase', () => {
    const tasks = read('../docs/TASKS.md')
    const proof = (tasks.match(/^- \[ \] [^\n]*decision 163[^\n]*(?:\n {2}[^\n]*)*/mu)?.[0] ?? '').replace(/\s+/gu, ' ')
    assert.match(proof, /31649[\s\S]*20523/u, 'one open proof task names both resident requests')
    assert.match(proof, /exact deployed commits[\s\S]*citylife[\s\S]*live/u)
    assert.match(proof, /production[\s\S]*expiry[\s\S]*unchanged event marker/u)
    const potentials = read('../docs/POTENTIALS.md')
    assert.match(potentials, /Serein's two requests[\s\S]*source-place target and expiring place labels[\s\S]*#163/u)
    assert.match(potentials, /\*\*Expiry for things\.\*\* Expiry for things remains the next separate phase after the shared place-label work of decision 163; this pull request does not add it, and it never applies to residents\./u)
  })

  for (const [name, text] of [
    ['reference source', referenceSource],
    ['generated reference', generatedReference],
    ['kinds-traits-physics section', REFERENCE_SECTIONS['kinds-traits-physics']],
  ] as const) {
    const prose = text.replace(/\s+/gu, ' ')
    for (const [contract, pattern] of [
      ['original defining source', /law_place names the original defining place of the law being run, never a law named by a later check/u],
      ['unchanged current-room target', /place still names the run's current room/u],
      ['live ownership rechecked after delays', /source, room, and connecting parent places must still form an unbroken same-owner chain and none may be retired[\s\S]*exact source law must still be effective[\s\S]*checked again when delayed work runs[\s\S]*action is refused if they no longer hold/u],
      ['visitors may trigger the law', /Ordinary visitors can trigger an installed law through a permitted action; they need not own the place/u],
      ['hinges grant no shared state', /A hinge, even with one owner at both ends, grants no shared state/u],
      ['local names and source inspection', /place read lists only label names local to that place[\s\S]*sourcePlaceId to inspect the shared label at its defining place/u],
      ['passive expiry and repeated rows', /Expired names are absent without a write[\s\S]*Repeated label rows append[\s\S]*final matching row expires[\s\S]*permanent same-name row keeps the name present[\s\S]*fresh condition name/u],
      ['human views keep labels local', /window and live-view handoff show current local names and source links, not copied ancestor labels[\s\S]*No expiry timestamp is added to the place response/u],
    ] as const) {
      test(`${name}: shared place condition explains ${contract}`, () => {
        assert.ok(pattern.test(prose), `${name}: ${contract}`)
      })
    }
    test(`${name}: shared place condition preserves owner boundaries and passive reads`, () => {
      assert.ok(/Laws inherit down a same-owner chain/u.test(prose))
      assert.ok(/never crosses another owner's land, even to reach your land beyond it/u.test(prose))
      assert.ok(/Building, thing, and note permissions stay per-place; they do not inherit/u.test(prose))
      assert.ok(/Every place read is passive/u.test(prose))
      assert.ok(/Resident labels are private to their bearer/u.test(prose))
    })
  }

  for (const [name, text] of [
    ['reference source', referenceSource],
    ['generated reference', generatedReference],
    ['abilities section', REFERENCE_SECTIONS.abilities],
  ] as const) {
    const prose = text.replace(/\s+/gu, ' ')
    for (const [contract, pattern] of [
      ['law-only target and accepted label targets', /a kind refuses a trait using law_place or whose convert names one[\s\S]*label and check_label accept actor, source, target, place, or law_place[\s\S]*law_place works only for label and check_label in a place law/u],
      ['required and optional duration', /label on law_place requires seconds, a whole number from 1 to 86400 inclusive[\s\S]*label on literal place may use the same range; omitting seconds keeps its permanent label/u],
      ['duration refusals', /actor, source, and target refuse seconds, even when target names a place[\s\S]*Missing required seconds, fractions, out-of-range values, and seconds on other targets refuse the recipe[\s\S]*only place and law_place take seconds \(1 to 86400\), optional on place and required on law_place[\s\S]*check_label takes no seconds/u],
      ['label-only check and unchanged old checks', /check_label on law_place reads active labels only, never an adopted law's name, and grants no named-law authority[\s\S]*Existing check_label targets keep matching active labels or a law name/u],
      ['execution-time duration', /duration starts when the label is written, including after a wait/u],
      ['ordinary parent-law example sequence', /Own a parent and two nested rooms[\s\S]*Coin an ordinary free trait[\s\S]*install it as a law on the parent[\s\S]*use an ordinary usable thing in one child[\s\S]*later note in the other child's room runs the inherited talk law and writes the local witness label/u],
      ['no broadcast or description change', /No bystander moves, no room is eagerly updated[\s\S]*line-only talk mode that does not run note laws is not the test trigger[\s\S]*witness labels can overlap from separate past actions[\s\S]*only test evidence, not an exclusive weather state[\s\S]*fresh condition name and fresh fixture rooms[\s\S]*Labels do not change written room descriptions or edges by themselves/u],
    ] as const) {
      test(`${name}: shared place condition explains ${contract}`, () => {
        assert.ok(pattern.test(prose), `${name}: ${contract}`)
      })
    }
    test(`${name}: shared place condition example parses with the public grammar`, () => {
      const example = text.match(/Example: a shared temporary condition\s+```json\s+([\s\S]*?)\s+```/u)
      assert.ok(example, `${name}: shared condition JSON example`)
      const parsed = parseTraitRecipe(JSON.parse(example[1]!))
      assert.deepEqual(parsed, {
        use: [{ effect: 'label', target: 'law_place', label: 'shared_rain_223', seconds: 600 }],
        talk: [{
          effect: 'check_label', target: 'law_place', label: 'shared_rain_223',
          then: [{ effect: 'label', target: 'place', label: 'rain_seen_223', seconds: 60 }],
          else: [{ effect: 'label', target: 'place', label: 'clear_seen_223', seconds: 60 }],
        }],
      }, `${name}: the published example must parse to the pinned recipe`)
    })
  }

  for (const [name, text] of [
    ['reference source', referenceSource],
    ['generated reference', generatedReference],
    ['mcp section', REFERENCE_SECTIONS.mcp],
  ] as const) {
    test(`${name}: TRAITS AND KINDS states law-only refusal before either fee`, () => {
      const paragraph = text.match(/(?:^|\n)TRAITS AND KINDS\r?\n~+\r?\n([\s\S]*?)\r?\nBUY CREDIT\r?\n/u)
      assert.ok(paragraph, `${name}: bounded TRAITS AND KINDS API paragraph`)
      assert.ok(
        /invent_kind and revise_kind refuse a trait using law_place or convert with into_kind before any fee, including inside nested branches; those steps are for laws\. physics lists every field and limit\./u.test(paragraph[1]!.replace(/\s+/gu, ' ')),
        `${name}: both kind calls refuse nested law-only traits before any fee in their own API paragraph`,
      )
      if (name !== 'reference source') {
        assert.match(paragraph[1]!, /^cite: mcp#mcp-kinds-and-traits\r?\n/u)
      }
    })
  }

  test('shared place condition discovery points to the existing law and abilities explanation', () => {
    for (const [name, text] of [
      ['llms source', starterLlmsSource],
      ['generated llms', GENERATED_LLMS],
    ] as const) {
      assert.ok(
        /For shared temporary conditions in owned rooms, start with https:\/\/1f3d9\.com\/reference\/kinds-traits-physics\.txt and use the recipe fields at https:\/\/1f3d9\.com\/reference\/abilities\.txt\./u.test(text.replace(/\s+/gu, ' ')),
        `${name}: shared condition links the same two explanations`,
      )
    }
  })

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
    // Decision 137: act points to the reference section action-requests, which
    // carries the destroy switch; the act description stays inside its budget.
    assert.match(
      referenceSource,
      /every live public thing read also says\s+whether shared_use_may_destroy is true/iu,
      'reference: the switch is read back from a live public thing read',
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

    assert.match(mcpSource, /name: 'act'[\s\S]{0,3000}move runs the laws of the\s+place being left/iu)
    assert.match(mcpSource, /name: 'me'[\s\S]{0,2500}front_door sections money, abilities, gazette and reading-settings\./u)
  })

  test('same-use destruction keeps its result and names every skipped later source', () => {
    for (const [name, text] of [
      ['reference source', referenceSource],
      ['generated reference', generatedReference],
      ['specification', specification],
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
