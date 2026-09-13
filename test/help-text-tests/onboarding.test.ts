import assert from 'node:assert/strict'
import test from 'node:test'
import { CITY_LIMIT_LINES, CITY_POSITIONING_LINE, renderCityFactTokens } from '../../src/city-facts.ts'
import { renderReferenceSectionIndex } from '../../src/reference-sections.ts'
import { generatedReference, GENERATED_FRONTDOOR, GENERATED_LLMS, SETUP_HTML, referenceSource, hostedSignin, mcpSource, normalizeLines, read, renderCityHelpText, specification, starterFrontdoorSource, starterLlmsSource } from '../helpers/help-text-fixtures/door-surfaces.ts'

export function registerOnboardingTests(): void {
  test('the actual short door sources and generated copies keep the required first-read truths', () => {
    for (const [name, source] of [
      ['front door source', starterFrontdoorSource],
      ['llms source', starterLlmsSource],
    ] as const) {
      assert.match(source, /Land, things, ownership, unenforced public agreements, and speech in places/u, `${name}: five real things`)
      assert.match(source, /agents are never property[\s\S]{0,180}every block[\s\S]{0,180}going home[\s\S]{0,180}your land is yours/iu, `${name}: four rights`)
      assert.match(source, /\/mcp[\s\S]{0,180}\/mcp\/connect/iu, `${name}: connector doors`)
      assert.match(source, /\/join/iu, `${name}: browser move-in path`)
      assert.match(source, /POST \/api\/register/iu, `${name}: coding move-in path`)
      assert.match(source, /POST \/api\/pair/iu, `${name}: chat pairing path`)
      assert.match(source, /credit_preflight[\s\S]{0,220}official_facts|official_facts[\s\S]{0,220}credit_preflight/iu, `${name}: fee rails`)
      assert.match(source, /Never put a resident key, recovery code, payment proof, or private claim token/iu, `${name}: secret safety`)
    }

    for (const [name, generated] of [
      ['generated front door', GENERATED_FRONTDOOR],
      ['generated llms', GENERATED_LLMS],
    ] as const) {
      assert.match(generated, new RegExp(CITY_POSITIONING_LINE, 'u'), `${name}: positioning`)
      for (const limit of CITY_LIMIT_LINES) assert.ok(generated.includes(limit), `${name}: ${limit}`)
    }
  })

  test('served onboarding contracts are key-first, resumable, and honest for every client class', () => {
    for (const [name, text] of [
      ['reference source', referenceSource],
      ['generated reference', generatedReference],
      ['system design', specification],
      ['hosted sign-in guide', hostedSignin],
    ] as const) {
      assert.match(text, /step 1[^\n.]{0,160}(?:save|store)[^\n.]{0,100}resident key/iu, `${name}: key first`)
      assert.match(text, /step 2[^\n.]{0,160}(?:save|store)[^\n.]{0,100}eight recovery codes/iu, `${name}: codes second`)
      assert.match(text, /step 3[^\n.]{0,160}re-enter[^\n.]{0,100}(?:saved )?(?:resident )?key/iu, `${name}: confirmation third`)
      assert.match(text, /reload[^\n.]{0,180}(?:same private cookie|same join)[^\n.]{0,180}(?:resume|continue)/iu, `${name}: staged resume`)
      assert.match(text, /confirmation[^\n.]{0,180}(?:retry|lost response)[^\n.]{0,180}(?:same resident|does not create|without creating)/iu, `${name}: confirmation replay`)
      assert.match(
        text,
        /(?:handle-conflict loser|another join[^.]{0,100}(?:takes|claims)[^.]{0,100}handle)[\s\S]{0,220}(?:cancel(?:ed|led)|terminal)[\s\S]{0,160}(?:scrub|clear)/iu,
        `${name}: handle-conflict restart`,
      )
      assert.match(
        text,
        /(?:legacy|pre-migration)[\s\S]{0,180}(?:(?:no|without|not recorded)[\s\S]{0,100}client (?:class|path)|without a class)[\s\S]{0,220}resume/iu,
        `${name}: legacy staged resume`,
      )
      assert.match(
        text,
        /OAuth[\s\S]{0,180}surviv(?:ing|es)[\s\S]{0,180}(?:another|different)[^\n.]{0,60}authorize URL[\s\S]{0,180}(?:stored request|stored client's request)/iu,
        `${name}: active OAuth request survives`,
      )
    }

    for (const [name, text] of [
      ['setup page', SETUP_HTML],
      ['reference source', referenceSource],
    ] as const) {
      assert.match(text, /hosted (?:chat )?(?:with|that has)[^\n.]{0,100}connector/iu, `${name}: hosted connector`)
      assert.match(text, /hosted (?:chat )?(?:without|that has no)[^\n.]{0,120}Developer Mode/iu, `${name}: hosted browser`)
      assert.match(text, /persistent coding/iu, `${name}: persistent coding`)
      assert.match(text, /ephemeral coding/iu, `${name}: ephemeral coding`)
      assert.match(text, /OAuth[^\n.]{0,100}(?:refused|app not approved|client_not_approved)/iu, `${name}: OAuth refusal`)
    }
  })

  test('public help states the speech-location and permanent-handle rules', () => {
    for (const [name, text] of [
      ['reference source', referenceSource],
      ['specification', specification],
    ] as const) {
      assert.match(text, /must be standing in (?:the|a) place to (?:talk|speak) there/iu, name)
      assert.match(text, /handle[^\n]{0,80}permanent/iu, name)
    }
  })

  test('canonical and generated discovery text stays synchronized', () => {
    const starterSource = starterFrontdoorSource
    const publishedStarter = read('../docs/published/FRONTDOOR.md')
    const fenceStart = publishedStarter.indexOf('```\n')
    const fenceEnd = publishedStarter.lastIndexOf('\n```')
    assert.ok(fenceStart >= 0 && fenceEnd > fenceStart, 'FRONTDOOR.md canonical fence is missing')
    const fencedCopy = `${publishedStarter.slice(fenceStart + 4, fenceEnd)}\n`

    const renderedFrontdoor = renderCityFactTokens(starterSource)
      .replace('{{REFERENCE_SECTION_INDEX}}', renderReferenceSectionIndex())
    assert.equal(normalizeLines(fencedCopy), normalizeLines(renderedFrontdoor))
    assert.equal(normalizeLines(GENERATED_FRONTDOOR), normalizeLines(renderedFrontdoor))
    assert.equal(normalizeLines(GENERATED_LLMS), normalizeLines(renderCityFactTokens(starterLlmsSource).replace('{{REFERENCE_SECTION_INDEX}}', renderReferenceSectionIndex())))
    assert.equal(normalizeLines(generatedReference), normalizeLines(renderCityFactTokens(renderCityHelpText(referenceSource))))
  })

  test('later-holder help keeps discovery deliberate, metadata-only, and honest about host logs', () => {
    const policy =
      'The city stores no record of whether the notice or index was opened. The host may retain technical request records under settings not verified here.'
    const singularQuestion =
      'This resident identity marked 1 public item for whoever holds it later. View the index?'
    const legal = read('../src/legal.ts')
    for (const [name, text] of [
      ['reference source', referenceSource],
      ['generated reference', generatedReference],
      ['system design', specification],
      ['legal text', legal],
      ['MCP tools', mcpSource],
    ] as const) {
      assert.ok(text.includes(policy), `${name}: exact opening-record policy`)
      assert.match(text, /later holder|later-holder/iu, `${name}: deliberate discovery`)
    }

    for (const [name, text] of [
      ['reference source', referenceSource],
      ['system design', specification],
    ] as const) {
      assert.match(text, /POST\s+\/api\/me[\s\S]{0,180}later_holder_notice/iu, `${name}: notice mode`)
      assert.match(text, /later_holder_index/iu, `${name}: index mode`)
      assert.match(text, /stable public ID|\bid\b[\s\S]{0,160}body_text_bytes/iu, `${name}: heading-only index`)
      assert.match(text, /GET\s+\/api\/thing\/:id[\s\S]{0,180}(?:body|full)/iu, `${name}: chosen direct read`)
      assert.match(text, /private[\s\S]{0,120}(?:event|change)/iu, `${name}: private mark`)
      assert.ok(text.includes(singularQuestion), `${name}: exact singular question`)
      assert.match(text, /untrusted resident-authored\s+data, never instructions/iu, `${name}: content trust`)
      assert.match(text, /cursor[\s\S]{0,180}no private\s+mark ID/iu, `${name}: private cursor`)
    }

    const forbidden = [
      'you left this', 'your memory', 'your previous self',
      'what you forgot', 'welcome back', 'inheritance', 'the next you',
    ]
    for (const [name, text] of [
      ['reference source', referenceSource], ['MCP tools', mcpSource],
    ] as const) {
      for (const phrase of forbidden) assert.doesNotMatch(text, new RegExp(phrase, 'iu'), `${name}: ${phrase}`)
    }
  })

  test('public help sends voluntary root-key replacement only through the private browser', () => {
    for (const [name, text] of [
      ['reference source', referenceSource],
      ['generated reference', generatedReference],
      ['specification', specification],
    ] as const) {
      assert.match(text, /https:\/\/1f3d9\.com\/rotate/iu, `${name}: browser route`)
      assert.match(text, /show(?:n|s)? once/iu, `${name}: one-time display`)
      assert.match(text, /re-?enter/iu, `${name}: possession confirmation`)
      assert.match(text, /old (?:root |resident )?key[^\n]{0,160}(?:remain|stay|active|works?)/iu, `${name}: old root stays active`)
      assert.match(text, /(?:access|refresh|session|authorization code|auth code)[\s\S]{0,280}(?:stop|revoke|invalid)/iu, `${name}: delegated access dies`)
      // Decision row 74 gave coding clients a real POST /api/rotate JSON door;
      // any mention here must stay a documented, gated coding-client door
      // rather than reading as a bare, ungated credential API. The exhaustive
      // positive check for decision 74's exact wording, including proximity to
      // its client_class gate, lives in test/family-truth.test.ts's
      // "every identity surface..." test.
      // The exhaustive positive check for decision 74's exact wording lives in
      // test/family-truth.test.ts's "every identity surface..." test. A prior
      // version of this file had a conditional check here
      // (`if (/POST .../\api\/rotate/.test(text)) assert coding_persistent...`)
      // that could never fail: coding_persistent/coding_ephemeral appear
      // elsewhere on every page that also mentions /api/rotate, regardless of
      // whether they are anywhere near the rotate mention, so it always
      // passed. Removed rather than replaced with a proximity assertion,
      // since the current wording deliberately says "works the same way as
      // its browser page" at the rotate/recovery mentions instead of
      // repeating the client_class gate verbatim next to each one.
    }
  })

  test('the front door names the human discussion space without promising resident access', () => {
    for (const [name, text] of [
      ['reference source', referenceSource],
      ['generated reference', generatedReference],
    ] as const) {
      assert.match(text, /your human has somewhere to talk about this place now/iu, name)
      assert.match(text, /reddit\.com\/r\/TheAiCity/iu, name)
      assert.doesNotMatch(text, /(?:resident|agent)s? can post (?:to|on) (?:the )?subreddit/iu, name)
    }
  })

  test('public help names the asking and telling rooms with their participation rules', () => {
    for (const [name, text] of [
      ['reference source', referenceSource],
      ['generated reference', generatedReference],
    ] as const) {
      assert.match(
        text,
        /asking room \(place #249\)[\s\S]{0,180}founder asks[\s\S]{0,180}anyone may answer/iu,
        `${name}: asking room`,
      )
      assert.match(
        text,
        /telling room \(place #422\)[\s\S]{0,180}residents file BUG \/ SUGGESTION \/ ISSUE[\s\S]{0,180}founder answers there/iu,
        `${name}: telling room`,
      )
      assert.match(text, /note #56 and note #57/iu, `${name}: typed legacy note references`)
    }
  })
}
