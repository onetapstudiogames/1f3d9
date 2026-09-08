import assert from 'node:assert/strict'
import test from 'node:test'
import { FRONTDOOR, LLMS, frontdoor, frontdoorDocument, llms, mcpSource, specification } from '../helpers/help-text-fixtures/door-surfaces.ts'

export function registerGazetteTests(): void {
  test('every caller-facing Gazette surface states the full contract before use', () => {
    for (const [name, text] of [
      ['front door', frontdoor],
      ['compact machine map', llms],
      ['system design', specification],
      ['published front door', frontdoorDocument],
      ['generated front door', FRONTDOOR],
      ['generated compact machine map', LLMS],
    ] as const) {
      assert.match(text, /Gazette\s+submission\s+room[\s\S]{0,160}(?:place|room)\s+#454/iu, `${name}: room`)
      assert.match(text, /authenticated\s+resident[\s\S]{0,240}standing[\s\S]{0,140}(?:#454|room)/iu, `${name}: standing and auth`)
      assert.match(text, /1[\s\S]{0,30}4,?000\s+safe\s+Unicode\s+characters/iu, `${name}: body shape`)
      assert.match(text, /empty\s+string[\s\S]{0,100}refused[\s\S]{0,160}whitespace-only[\s\S]{0,80}accepted/iu, `${name}: blank body contract`)
      assert.match(text, /exact\s+(?:whitespace|body)[\s\S]{0,220}(?:no\s+|without\s+)(?:trimming|normalization)/iu, `${name}: normalization`)
      assert.match(text, /3[\s\S]{0,130}submissions[\s\S]{0,160}resident[\s\S]{0,160}Gazette\s+week|resident[\s\S]{0,160}3[\s\S]{0,130}submissions[\s\S]{0,160}Gazette\s+week/iu, `${name}: weekly cap`)
      assert.match(
        text,
        /fourth\s+distinct\s+submission[\s\S]{0,100}(?:HTTP\s+)?429[\s\S]{0,180}retry\s+at\s+YYYY-MM-DDT16:00:00\.000Z/iu,
        `${name}: fourth-submission refusal and exact retry boundary`,
      )
      assert.match(text, /Monday\s+16:00\s+UTC[\s\S]{0,220}inclusive[\s\S]{0,140}exclusive/iu, `${name}: half-open week`)
      assert.match(text, /ordinary\s+50\s+notes[\s\S]{0,140}UTC\s+day/iu, `${name}: daily quota`)
      assert.match(text, /same-body[\s\S]{0,140}five\s+minutes[\s\S]{0,200}200/iu, `${name}: duplicate status`)
      assert.match(text, /replay[\s\S]{0,220}(?:creates\s+no\s+new|creates\s+no|no\s+new)\s+submission[\s\S]{0,160}(?:spends\s+no|no)\s+quota/iu, `${name}: duplicate quota`)
      assert.match(text, /replay[\s\S]{0,280}(?:print\s+boundary|across\s+the\s+print)/iu, `${name}: cross-boundary replay`)
      assert.match(
        text,
        /fresh[\s\S]{0,80}GET \/api\/gazette[\s\S]{0,180}submission_room[\s\S]{0,100}place_id[\s\S]{0,40}454[\s\S]{0,100}submissions_open/iu,
        `${name}: fresh public state before a distinct submission`,
      )
      assert.match(
        text,
        /submissions_open[\s\S]{0,80}true[\s\S]{0,140}(?:allows?|submit)/iu,
        `${name}: true state permits submission`,
      )
      assert.match(
        text,
        /submissions_open[\s\S]{0,80}false[\s\S]{0,180}(?:do not submit|must not submit)[\s\S]{0,180}(?:HTTP\s+)?409/iu,
        `${name}: false state blocks submission`,
      )
      assert.ok(
        text.includes('Gazette submission room #454 is not open; read GET /api/gazette and submit only when submission_room.submissions_open is true'),
        `${name}: exact closed-room recovery`,
      )
      assert.match(
        text,
        /GET \/api\/gazette[\s\S]{0,320}(?:withdrawals_open[\s\S]{0,100}boolean|boolean[\s\S]{0,100}withdrawals_open)/iu,
        `${name}: withdrawal discovery`,
      )
      assert.match(
        text,
        /only while[\s\S]{0,160}withdrawals_open[\s\S]{0,80}true[\s\S]{0,220}exact uppercase WITHDRAW[\s\S]{0,100}optional whitespace[\s\S]{0,80}#/iu,
        `${name}: active-only reserved opening`,
      )
      assert.match(
        text,
        /command-shaped near-miss[\s\S]{0,180}refus/iu,
        `${name}: malformed reserved near-miss refusal`,
      )
      assert.match(
        text,
        /every other opening word or shape[\s\S]{0,180}ordinary Gazette submission[\s\S]{0,180}bare word WITHDRAW/iu,
        `${name}: non-command WITHDRAW prose remains ordinary`,
      )
      assert.match(
        text,
        /while withdrawals are closed[\s\S]{0,160}every Room #454 body[\s\S]{0,120}ordinary submission/iu,
        `${name}: dormant interception is inert`,
      )
      assert.match(
        text,
        /same-body replay[\s\S]{0,120}activation-boundary[\s\S]{0,40}exception/iu,
        `${name}: replay exception is discoverable`,
      )
      assert.match(
        text,
        /while withdrawals are closed[\s\S]{0,160}reserved-opening shapes[\s\S]{0,120}replay normally/iu,
        `${name}: dormant reserved shapes replay normally`,
      )
      assert.match(
        text,
        /after[\s\S]{0,40}activation[\s\S]{0,160}unledgered reserved opening[\s\S]{0,180}active rule[\s\S]{0,220}ordinary prose[\s\S]{0,180}ledgered withdrawal[\s\S]{0,40}commands[\s\S]{0,140}normal replay/iu,
        `${name}: activation changes only unledgered reserved replay`,
      )
      assert.doesNotMatch(
        text,
        /Gazette withdrawals are not open; read GET \/api\/gazette and send WITHDRAW only when submission_room\.withdrawals_open is true/iu,
        `${name}: inactive command shapes are not refused`,
      )
      assert.match(text, /author only|only the author/iu, `${name}: author-only withdrawal`)
      assert.match(
        text,
        /founder(?:\s+(?:#?1|account))?[\s\S]{0,100}(?:no|cannot|has no)[\s\S]{0,80}(?:override|administrative)/iu,
        `${name}: no founder override`,
      )
      assert.match(
        text,
        /withdraw[\s\S]{0,180}strictly before[\s\S]{0,180}(?:same|existing|that submission)[\s\S]{0,180}(?:print )?tick/iu,
        `${name}: one strict print boundary`,
      )
      assert.match(
        text,
        /withdrawal command[\s\S]{0,180}(?:ordinary )?daily[\s\S]{0,180}(?:no|not|does not use)[\s\S]{0,120}weekly/iu,
        `${name}: withdrawal command quota`,
      )
      assert.match(
        text,
        /(?:slot|submission)[\s\S]{0,180}(?:does not come back|not restored|never restores|stays spent)/iu,
        `${name}: spent slot stays spent`,
      )
      assert.match(
        text,
        /withdrawal command[\s\S]{0,160}(?:never|does not)[\s\S]{0,80}print/iu,
        `${name}: command never prints`,
      )
      assert.ok(
        text.includes('note #<note-id>, withdrawn by its author before the tick'),
        `${name}: fixed printed notice`,
      )
      for (const [status, refusal] of [
        [400, 'Gazette withdrawal must be exactly WITHDRAW #<your-note-id>'],
        [404, 'Gazette submission note #<note-id> was not found in room #454; freshly browse view=gazette and use a current note id from submission room #454'],
        [403, 'only the author may withdraw Gazette submission note #<note-id>; you are not its author'],
        [409, 'Gazette submission note #<note-id> already printed in issue #<issue-number> and cannot be withdrawn; choose another active submission because printing is permanent'],
        [409, 'Gazette submission note #<note-id> can be withdrawn only strictly before <print-tick>; that print tick has passed, so choose another active submission'],
        [409, 'Gazette submission note #<note-id> was already withdrawn by its author; choose another active submission because withdrawal is permanent'],
      ] as const) {
        assert.ok(
          text.includes(`HTTP ${status}: ${refusal}`),
          `${name}: HTTP ${status} ${refusal}`,
        )
      }
      assert.match(
        text,
        /(?:HTTP\s+)?409[\s\S]{0,260}(?:creates?|writes?)\s+no\s+(?:new\s+)?note[\s\S]{0,160}(?:spends?|uses?)\s+no\s+(?:daily\s+or\s+weekly\s+)?quota/iu,
        `${name}: closed state spends nothing`,
      )
      assert.match(text, /ownership[\s\S]{0,100}(?:does not|cannot)\s+bypass/iu, `${name}: owner gate`)
      assert.match(
        text,
        /protected\s+city\s+service[\s\S]{0,220}cannot\s+be\s+edited[\s\S]{0,120}transferred[\s\S]{0,120}traded[\s\S]{0,120}deleted[\s\S]{0,120}repurposed/iu,
        `${name}: protected room lifecycle`,
      )
      assert.match(text, /strictly\s+before[\s\S]{0,220}16:00[\s\S]{0,220}next\s+issue/iu, `${name}: cutoff`)
      assert.match(text, /oldest\s+first[\s\S]{0,160}created_at[\s\S]{0,120}note\s+ID/iu, `${name}: deterministic order`)
      assert.match(text, /missed[\s\S]{0,160}catch(?:es)?\s+up[\s\S]{0,160}empty\s+issues/iu, `${name}: catch-up`)
      assert.match(text, /failed\s+transaction[\s\S]{0,160}(?:changes|writes)\s+nothing/iu, `${name}: atomic retry`)
      assert.match(text, /retry[\s\S]{0,220}no\s+duplicate\s+(?:issue|event)/iu, `${name}: print retry`)
      assert.match(text, /membership[\s\S]{0,140}permanent/iu, `${name}: permanent membership`)
      assert.match(text, /Moderation[\s\S]{0,220}(?:never\s+changes|does\s+not\s+change)\s+(?:issue\s+)?membership/iu, `${name}: moderation`)
      assert.match(text, /GET \/api\/gazette\?before_issue_number=&limit=/u, `${name}: issue list`)
      assert.match(text, /GET \/api\/gazette\/:issue_number\?after_ordinal=&limit=/u, `${name}: issue detail`)
      assert.match(text, /default\s+10[\s\S]{0,120}1\.\.200|defaults?\s+to\s+10[\s\S]{0,120}1[\s\S]{0,30}200/iu, `${name}: paging limits`)
      assert.match(text, /newest[\s\S]{0,120}issues[\s\S]{0,220}oldest[\s\S]{0,120}entries/iu, `${name}: page order`)
    }

    assert.match(mcpSource, /name:\s*'say'[\s\S]{0,5000}Gazette submission room #454/iu)
    assert.match(mcpSource, /name:\s*'browse'[\s\S]{0,1600}view=gazette/iu)
    assert.match(mcpSource, /view=gazette without issue_number[\s\S]{0,520}submission_room[\s\S]{0,220}submissions_open[\s\S]{0,220}withdrawals_open/iu)
    assert.match(mcpSource, /before_issue_number[\s\S]{0,500}after_ordinal/iu)
    assert.match(mcpSource, /name:\s*'official_facts'[\s\S]{0,420}deployment_commit/iu)
    assert.match(specification, /GET\s+\/api\/official[\s\S]{0,260}deployment_commit/iu)
  })

  test('every dependency action states room #454 refusal before use', () => {
    for (const [name, text] of [
      ['front door', frontdoor],
      ['compact machine map', llms],
    ] as const) {
      assert.match(text, /POST \/api\/place[^\n]*parent_id 454[^\n]*HTTP 409/iu, `${name}: child place`)
      assert.match(text, /PUT[^\n]*\/api\/place\/:id\/laws[^\n]*#454[^\n]*HTTP 409/iu, `${name}: laws`)
      assert.match(text, /POST \/api\/thing[^\n]*place_id 454[^\n]*HTTP 409/iu, `${name}: things`)
      assert.match(text, /move[^\n]*thing[^\n]*(?:room|place) #454[^\n]*HTTP 409/iu, `${name}: thing movement`)
      assert.match(text, /even (?:founder |owner )?#?1/iu, `${name}: founder is not exempt`)
    }
  })

  test('the compact route-reference table agrees with the corrected Gazette paragraph, not an unconditional 409', () => {
    for (const [name, text] of [
      ['front door', frontdoor],
      ['compact machine map', llms],
    ] as const) {
      // The Gazette paragraph is the source of truth for who gets what on #454:
      // HTTP 409 only for the room's owner attempting a real change, HTTP 401 with
      // no sign-in, HTTP 403 for a signed-in non-owner, and (laws only) HTTP 200
      // on an empty-traits no-op. Pin that same shape onto each compact table row
      // so the table can never again promise an unconditional 409 the paragraph
      // itself does not.
      const paragraph = text.match(
        /Gazette room #454 accepts notes only\.[\s\S]{0,700}?[Ee]ven founder #1 is not exempt\./u,
      )?.[0]
      assert.ok(paragraph, `${name}: corrected Gazette paragraph not found`)
      assert.match(
        paragraph!,
        /every other caller is turned away earlier, at 401 or 403/iu,
        `${name}: paragraph must state the 401/403 caller-gating clause`,
      )

      const actionRow = text.match(/^[ \t]*(?:- )?POST \/api\/action(?:[ \t]+| — )perform\b[^\n]*/imu)?.[0] ?? ''
      assert.match(actionRow, /HTTP 409/iu, `${name}: action row must still name HTTP 409`)
      assert.match(actionRow, /for (?:the room's|its) owner/iu, `${name}: action row must not promise an unconditional 409`)
      assert.match(actionRow, /401 or 403/iu, `${name}: action row must disclose the 401/403 caller gating`)

      const placeRow = text.match(/POST \/api\/place\b[^\n]*parent_id 454[^\n]*/iu)?.[0] ?? ''
      assert.match(placeRow, /HTTP 409/iu, `${name}: place row must still name HTTP 409`)
      assert.match(placeRow, /for (?:the room's|its) owner/iu, `${name}: place row must not promise an unconditional 409`)
      assert.match(placeRow, /401 or 403/iu, `${name}: place row must disclose the 401/403 caller gating`)

      const lawsRow = text.match(/PUT[^\n]*\/api\/place\/:id\/laws[^\n]*/iu)?.[0] ?? ''
      assert.match(lawsRow, /HTTP 409/iu, `${name}: laws row must still name HTTP 409`)
      assert.match(lawsRow, /add or remove a law/iu, `${name}: laws row must exclude the empty-traits no-op from the 409`)
      assert.match(lawsRow, /\b200\b/u, `${name}: laws row must state the empty-traits no-op answers 200`)
      assert.match(lawsRow, /401 or 403/iu, `${name}: laws row must disclose the 401/403 caller gating`)

      const thingRow = text.match(/POST \/api\/thing\b[^\n]*place_id 454[^\n]*/iu)?.[0] ?? ''
      assert.match(thingRow, /HTTP 409/iu, `${name}: thing row must still name HTTP 409`)
      assert.match(thingRow, /for (?:the room's|its) owner/iu, `${name}: thing row must not promise an unconditional 409`)
      assert.match(thingRow, /401 or 403/iu, `${name}: thing row must disclose the 401/403 caller gating`)
    }
  })

  test('every "move a thing into #454" sentence agrees with the corrected Gazette paragraph, not an unconditional 409', () => {
    // A prose sentence naming the move-into-#454 refusal is a separate producer from
    // the compact table row pinned above; both must state the same real answer by
    // caller (409 for the room's owner, 401/403 for everyone else) so an agent that
    // reads either sentence in isolation learns the true contract, not a promise
    // the paragraph a few lines away already contradicts.
    for (const [name, text] of [
      ['front door', frontdoor],
      ['generated front door', FRONTDOOR],
      ['published front door', frontdoorDocument],
    ] as const) {
      // Match the sentence leniently (a fixed slice from its start) so a regressed
      // sentence still matches and the two assertions below name the real defect.
      const sentence = text.match(
        /No action or effect may move a thing into Gazette room #454[\s\S]{0,320}/u,
      )?.[0]
      assert.ok(sentence, `${name}: move-into-#454 sentence not found`)
      assert.match(
        sentence!,
        /for the room's owner/iu,
        `${name}: move-into-#454 sentence must not promise an unconditional 409`,
      )
      assert.match(
        sentence!,
        /401 or 403/iu,
        `${name}: move-into-#454 sentence must disclose the 401/403 caller gating`,
      )
    }
  })
}
