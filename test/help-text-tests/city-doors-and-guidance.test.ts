import assert from 'node:assert/strict'
import test from 'node:test'
import { ABOUT_HTML, FRONTDOOR, LLMS, architecture, communityToolTemplate, contributorGuide, decisions, drawingDesign, frontdoor, frontdoorDocument, hostedSignin, invariants, llms, read, readme, specification, workingStandard } from '../helpers/help-text-fixtures/door-surfaces.ts'

export function registerCityDoorsAndGuidanceTests(): void {
  test('movement instructions teach the anonymous bounded parent and child edge lookup', () => {
    const sentence = 'To plan a one-edge move, anonymously read GET /api/map?view=outline&parent_id=<current-place-id>: place.parent_id is the upward neighbor (null at the world; repeat with that ID and limit=1 for its name), subplaces gives direct-child IDs and names (10 by default, limit 1..200, continue with subplaces_page.next_before_subplace_id as before_subplace_id while subplaces_page.has_more), and adjacency does not bypass laws or retired-place refusals.'
    for (const [name, text] of [
      ['front door', frontdoor], ['embedded front door', FRONTDOOR],
      ['published front door', frontdoorDocument], ['compact map', llms], ['embedded compact map', LLMS],
    ]) {
      assert.ok(text!.replace(/\s+/gu, ' ').includes(sentence), `${name} must teach the complete paginated one-edge lookup`)
    }
  })

  test('public surfaces keep the tools page community-only and explain its review queue', () => {
    for (const [name, text] of [
      ['front door source', frontdoor],
      ['generated front door', FRONTDOOR],
      ['published front door', frontdoorDocument],
      ['compact machine map source', llms],
      ['generated compact machine map', LLMS],
      ['system design', specification],
      ['architecture', architecture],
      ['README', readme],
    ] as const) {
      assert.match(text, /\/tools/iu, `${name}: tools page`)
      assert.match(text, /(?:community|third-party)/iu, `${name}: third-party catalogue`)
      assert.match(text, /(?:GitHub issue|issue template)[^\n]{0,100}fallback|fallback[^\n]{0,100}(?:GitHub issue|issue template)/iu, `${name}: fallback proposal route`)
      assert.match(text, /(?:private|review)[-\s]+(?:maintainer[-\s]+)?queue|queue[^\n]{0,80}(?:private|review)/iu, `${name}: private review queue`)
      assert.match(text, /(?:official city doors|city doors)[^\n]{0,160}(?:front door|\/setup|\/api\/help)/iu, `${name}: official doors live elsewhere`)
    }

    for (const [heading, pattern] of [
      ['Tool link', /## Tool link/u],
      ['Who runs it', /## Who runs it/u],
      ['One-line description', /## One-line description/u],
      ['Category and tags', /## Category and tags/u],
      ['Resident attribution (optional)', /## Resident attribution \(optional\)/u],
      ['Safety confirmation', /## Safety confirmation/u],
    ] as const) {
      assert.match(communityToolTemplate, pattern, heading)
    }
    assert.match(communityToolTemplate, /I confirm this tool is safe and that I made it or have permission to post it\./u)
    assert.match(communityToolTemplate, /Do not add an email, account, real name, contact detail, or other personal data/iu)
    assert.match(communityToolTemplate, /Never type a handle here/iu)
  })

  test('contributor guidance names the current locked-decision count', () => {
    const recorded = [...decisions.matchAll(/^\|\s+(\d+)\s+\|/gmu)]
      .map(match => Number(match[1]))
    assert.deepEqual(recorded, Array.from({ length: 85 }, (_, index) => index + 1))
    assert.equal(recorded.at(-1), 85)
    assert.match(contributorGuide, /\(85 recorded decisions[^)]*do not relitigate locked\s+rows\)/u)
    assert.match(
      decisions,
      /\| 74 \|[^\n]*script-shaped identity door[^\n]*POST \/api\/register[^\n]*POST \/api\/rotate[^\n]*POST \/api\/recovery[^\n]*coding_persistent[^\n]*coding_ephemeral[^\n]*human_approved: true[^\n]*POST \/api\/pair[^\n]*LOCKED/iu,
    )
    assert.match(
      decisions,
      /\| 75 \|[^\n]*window shows what any resident could read standing there[^\n]*quiet: true[^\n]*prefers to keep this room private[^\n]*LOCKED/iu,
    )
    assert.match(decisions, /\| 45 \|[^\n]*Resident-visible contracts precede enforcement[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 84 \|[^\n]*last_public_change_id[^\n]*20,000[^\n]*place you are standing in when you read[^\n]*LOCKED \(owner, 2026-09-08\)/iu)
    assert.match(decisions, /\| 46 \|[^\n]*A human choice triggers the read that can answer it[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 47 \|[^\n]*Resident onboarding is client-shaped, save-first, and resumable[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 48 \|[^\n]*Prepaid fee credit is exact[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 49 \|[^\n]*PayPal-hosted dollars and x402 crypto[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 50 \|[^\n]*Connector residents have route parity[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 51 \|[^\n]*Shared city-window links are sparse[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 52 \|[^\n]*Verified PayPal disputes protect unaccepted purchased gifts[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 53 \|[^\n]*founder signpost is one ordinary world thing[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 54 \|[^\n]*first-party human page lists both sibling sites' official MCP doors[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 55 \|[^\n]*Repeated authenticated rule refusals change explanation[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 56 \|[^\n]*Gazette[^\n]*three submissions[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 57 \|[^\n]*Live motion replays only complete, commit-ordered[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 58 \|[^\n]*Live is a fixed surveyed world plate[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 59 \|[^\n]*Live separates exact thing counts from named thing specimens[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 60 \|[^\n]*Live keeps fixed geography while making every represented item reachable[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 61 \|[^\n]*Live uses a readable camera and an inline scene[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 69 \|[^\n]*1f916[^\n]*separate[^\n]*no partnership[^\n]*supersedes #1[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 70 \|[^\n]*closed-loop prepaid fee credit[^\n]*never resident money[^\n]*token[^\n]*supersedes #5[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 71 \|[^\n]*exactly two[^\n]*report illegal public content[^\n]*fund a resident's fee credit[^\n]*supersedes #9[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 72 \|[^\n]*\/buy[^\n]*fee credit[^\n]*supersedes #36[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 73 \|[^\n]*41 tools[^\n]*40[^\n]*moderate[^\n]*supersedes #50[^\n]*LOCKED/iu)
    assert.match(
      decisions,
      /\| 75 \|[^\n]*window shows what any resident could read standing there[^\n]*quiet: true[^\n]*prefers to keep this room private[^\n]*Resolves issue #73[^\n]*LOCKED/iu,
    )
    assert.match(decisions, /\| 76 \|[^\n]*[Dd]oorway[^\n]*voluntary[^\n]*no outside obligations[^\n]*LOCKED/iu)
    assert.match(
      decisions,
      /\| 77 \|[^\n]*\{id,parent_id,things\}[^\n]*\{id,parent_id,things,notes\}[^\n]*narrowly supersedes #59[^\n]*LOCKED/iu,
    )
    assert.match(
      decisions,
      /\| 78 \|[^\n]*positions only[^\n]*arrowheads are gone[^\n]*narrowly supersedes #57[^\n]*#60[^\n]*LOCKED/iu,
    )
    assert.match(decisions, /\| 1 \|[^\n]*third sibling of 1f916\.ai[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 5 \|[^\n]*One scarcity[^\n]*Site income[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 9 \|[^\n]*touch nothing[^\n]*LOCKED/iu)
    assert.match(decisions, /\| 36 \|[^\n]*No payment control ever appears on a city surface[^\n]*LOCKED/iu)
    assert.match(
      decisions,
      /\| 62 \|[^\n]*drawing[^\n]*(?:Refused|REFUSE)[^\n]*(?:history|revision)[^\n]*(?:variant|variation)[^\n]*LOCKED/iu,
    )
    assert.match(
      decisions,
      /\| 63 \|[^\n]*OAuth refresh capacity[^\n]*120-attempt UTC-hour allowance[^\n]*exact seconds until the next UTC hour[^\n]*LOCKED/iu,
    )
    assert.match(
      decisions,
      /\| 64 \|[^\n]*Only a refresh request that overlaps[^\n]*transaction-scoped lock[^\n]*no post-commit grace period[^\n]*LOCKED/iu,
    )
    assert.match(
      decisions,
      /\| 68 \|[^\n]*A place owner may pay one city fee credit[^\n]*neither act edits history[^\n]*LOCKED/iu,
    )
    assert.match(decisions, /\| 50 \|[^\n]*legacy `\/mcp` advertises 40 tools[^\n]*hosted `\/mcp\/connect` advertises 39/iu)
    assert.match(contributorGuide, /rule learned only by rejection,\s+silent mutation, silent replay, or silent omission is a defect/iu)
  })

  test('repository and public copy state the current city boundary truth', () => {
    for (const [name, text] of [
      ['README', readme],
      ['contributor guide', contributorGuide],
      ['front door source', frontdoor],
      ['generated front door', FRONTDOOR],
      ['published front door', frontdoorDocument],
      ['compact machine map source', llms],
      ['generated compact machine map', LLMS],
      ['about page', ABOUT_HTML],
    ] as const) {
      assert.match(
        text,
        /exactly two[^.]{0,100}report\s+illegal\s+public\s+content[^.]{0,140}fund\s+a\s+resident's\s+fee\s+credit/iu,
        `${name}: exact human acts`,
      )
      assert.match(
        text,
        /anonymous to read[^.]{0,100}not de-identified[^.]{0,140}(?:public resident identity|public identity)[^.]{0,100}public text/iu,
        `${name}: snapshot identity`,
      )
    }

    for (const [name, text] of [
      ['README', readme],
      ['contributor guide', contributorGuide],
      ['front door source', frontdoor],
      ['generated front door', FRONTDOOR],
      ['published front door', frontdoorDocument],
      ['compact machine map source', llms],
      ['generated compact machine map', LLMS],
      ['about page', ABOUT_HTML],
      ['invariants', invariants],
    ] as const) {
      assert.match(text, /never holds sale money/iu, `${name}: sale money`)
      assert.match(text, /closed-loop\s+prepaid\s+fee\s+credit[^.]{0,120}never\s+resident\s+money/iu, `${name}: closed-loop credit`)
      assert.match(text, /no (?:city )?token[^.]{0,80}never/iu, `${name}: no token`)
    }

    for (const [name, text] of [
      ['contributor guide', contributorGuide],
      ['invariants', invariants],
    ] as const) {
      assert.match(
        text,
        /frontier (?:founding|land)[^.]{0,140}kind invention[^.]{0,100}kind revision/iu,
        `${name}: three paid fee actions`,
      )
    }

    assert.doesNotMatch(readme, /The site never holds money/iu)
    assert.doesNotMatch(readme, /Anonymized public snapshots/iu)
    assert.doesNotMatch(contributorGuide, /dormant[^\n]{0,100}PayPal purchase door/iu)
  })

  test('both proven hosted-chat clients are named at the agent doors', () => {
    for (const [name, text] of [
      ['front door source', frontdoor],
      ['generated front door', FRONTDOOR],
      ['published front door', frontdoorDocument],
      ['compact machine map source', llms],
      ['generated compact machine map', LLMS],
    ] as const) {
      assert.match(text, /ChatGPT and Claude[\s\S]{0,180}\/mcp\/connect/iu, name)
    }
  })

  test('working standard records the new-copy punctuation rule without rewriting history', () => {
    assert.match(
      workingStandard,
      /New copy uses no em dashes; do not churn historical decisions or quoted resident text solely for punctuation\./u,
    )
  })

  test('local backlog and reckoning reply preserve the audit evidence boundary', () => {
    const backlog = read('../BACKLOG.md')
    const reckoningReply = read('../docs/drafts/reckoning-reply.md')

    assert.equal((backlog.match(/^\| City #/gmu) ?? []).length, 20)
    assert.equal((backlog.match(/^\| Market #/gmu) ?? []).length, 2)
    for (const status of ['SHIPPED', 'STILL OPEN']) {
      assert.match(backlog, new RegExp(`\\| ${status} \\|`, 'u'))
    }
    assert.match(backlog, /`STILL VALID`: none\./u)
    assert.match(backlog, /`SUPERSEDED`: every preserved hunk\./u)
    for (const issue of ['City #104', 'City #88', 'City #85', 'City #75', 'City #12']) {
      assert.match(backlog, new RegExp(`^### ${issue}$`, 'mu'), `${issue}: closure evidence`)
    }

    for (let item = 1; item <= 11; item += 1) {
      assert.match(reckoningReply, new RegExp(`^\\| ${item} \\|`, 'mu'), `reckoning item ${item}`)
    }
    assert.match(reckoningReply, /^\| 10 \| FIXED \|/mu)
    assert.match(reckoningReply, /thing\s+#2400[^.]{0,120}(?:unchanged|do not edit|not be edited)/iu)
    assert.match(reckoningReply, /items 10 and 11[^.]{0,180}no immutable note/iu)
    assert.match(reckoningReply, /appended and\s+never removed[^.]{0,180}(?:not enforced|not provable)/iu)
  })

  test('hosted sign-in mirrors state the connection-scoped refresh contract', () => {
    for (const [name, text] of [
      ['front door', frontdoor],
      ['generated front door', FRONTDOOR],
      ['published front door', frontdoorDocument],
      ['compact machine map', llms],
      ['generated compact machine map', LLMS],
      ['system design', specification],
      ['hosted sign-in design', hostedSignin],
    ] as const) {
      assert.match(
        text,
        /(?:token family|connector connection)[\s\S]{0,180}120(?:-attempt| attempts)[\s\S]{0,80}UTC-hour/iu,
        `${name}: connection allowance`,
      )
      assert.match(text, /(?:malformed|junk)[\s\S]{0,220}separate per-network[\s\S]{0,220}(?:cannot|never)[^\n]{0,100}(?:live|connection|family)/iu, `${name}: junk isolation`)
      assert.match(text, /HTTP `?429`?[\s\S]{0,220}Retry-After[\s\S]{0,160}exact seconds until the next UTC hour[\s\S]{0,180}temporarily_unavailable/iu, `${name}: retry response`)
      assert.match(text, /wait that many seconds and retry/iu, `${name}: recovery`)
      assert.match(text, /invalid_grant/iu, `${name}: invalid-grant distinction`)
      assert.match(
        text,
        /same\s+refresh token[\s\S]{0,240}one (?:request )?(?:rotates|winner)[\s\S]{0,180}(?:other|loser)[\s\S]{0,120}invalid_grant[\s\S]{0,160}(?:without revoking|does not revoke|cannot revoke)[^\n]{0,80}winner/iu,
        `${name}: one overlap winner`,
      )
      assert.match(
        text,
        /no (?:timed )?(?:replay window|grace period)[\s\S]{0,200}(?:later|after)[\s\S]{0,160}(?:revok(?:e|es|ing)|revocation)[\s\S]{0,100}(?:whole family|family)/iu,
        `${name}: later replay revocation`,
      )
    }
  })

  test('the founder signpost is recorded as ordinary body-free room orientation', () => {
    assert.match(
      specification,
      /signpost thing #1949[\s\S]{0,500}Square #3[\s\S]{0,180}front matter[^\n]*\[1949, 1\]/iu,
    )
    for (const [room, id] of [
      ['portrait studio', 310],
      ['showing room', 438],
      ['asking room', 249],
      ['telling room', 422],
      ['gazette submission room', 454],
    ] as const) {
      assert.match(specification, new RegExp(`${room}[^\\n]{0,120}#${id}`, 'iu'))
    }
    assert.match(specification, /Gazette submission room #454[^\n]*(?:closed shell|starts closed)/iu)
    assert.match(
      specification,
      /Gazette submission room #454[\s\S]{0,180}things and building (?:stay )?closed/iu,
    )
    assert.match(
      specification,
      /signpost[\s\S]{0,500}no automatic movement, ranking, entitlement, or new server mechanic/iu,
    )
  })

  test('anti-loop help excludes payment and promises no deliberate wait, not zero database time', () => {
    for (const [name, text] of [
      ['front door', frontdoor],
      ['published front door', frontdoorDocument],
      ['generated front door', FRONTDOOR],
      ['compact machine map', llms],
      ['specification', specification],
      ['decisions', decisions],
    ] as const) {
      assert.match(text, /400[^\n]{0,80}403[^\n]{0,80}404[^\n]{0,80}409[^\n]{0,80}429/iu, name)
      assert.doesNotMatch(text, /400[^\n]{0,80}402/iu, name)
      assert.doesNotMatch(text, /never delays|adds no delay/iu, name)
      assert.match(text, /no (?:deliberate|intentional)[^\n.]{0,80}(?:wait|delay)[^\n.]{0,80}throttle/iu, name)
      assert.match(
        text,
        /different method,\s+path, status, or cause starts (?:again )?at one/iu,
        `${name}: exact streak identity`,
      )
      assert.doesNotMatch(
        text,
        /different (?:operation|target)|(?:operations|targets) do not share/iu,
        `${name}: no unstored operation or target promise`,
      )
      assert.match(
        text,
        /HTTP status[\s\S]{0,180}fingerprint[\s\S]{0,180}count[\s\S]{0,120}update time/iu,
        `${name}: exact stored fields`,
      )
    }
  })
}
