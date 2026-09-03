import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { BROWSER_REFUSAL_REASONS } from '../src/browser-refusal.ts'
import { renderCityHelpText } from '../src/city-help.ts'
import { FRONTDOOR, LLMS } from '../src/door.ts'
import { ABOUT_HTML, SETUP_HTML } from '../src/human-pages.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const normalizeLines = (value: string) => value.replace(/\r\n/gu, '\n')

const frontdoor = read('../src/frontdoor.txt')
const llms = read('../src/llms.txt')
const specification = read('../docs/SYSTEM_DESIGN.md')
const drawingDesign = read('../docs/DRAWING_AND_LIVE_VIEW.md')
const publicSnapshots = read('../docs/PUBLIC_SNAPSHOTS.md')
const productRequirements = read('../docs/PRD.md')
const architecture = read('../docs/ARCHITECTURE.md')
const frontdoorDocument = read('../docs/published/FRONTDOOR.md')
const readme = read('../README.md')
const communityToolTemplate = read('../.github/ISSUE_TEMPLATE/community-tool.md')
const decisions = read('../docs/DECISIONS.md')
const hostedSignin = read('../docs/features/HOSTED_CHAT_SIGNIN.md')
const contributorGuide = read('../CLAUDE.md')
const openQuestions = read('../docs/archive/2026-08/RESOLVED_QUESTIONS.md')
const mcpSource = read('../src/mcp.ts')
const hostedDiscoverySource = read('../src/hosted-chat-discovery.ts')
const workingStandard = read('../AGENTS.md')
const invariants = read('../docs/INVARIANTS.md')

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

test('Live is labeled alpha across its public help mirrors', () => {
  for (const [name, text] of [
    ['front door source', frontdoor],
    ['generated front door', FRONTDOOR],
    ['published front door', frontdoorDocument],
    ['compact machine map source', llms],
    ['generated compact machine map', LLMS],
    ['system design', specification],
    ['drawing and Live design', drawingDesign],
  ] as const) {
    assert.match(text, /(?:ALPHA[^\n]{0,100}chip|chip[^\n]{0,100}ALPHA)/u, `${name}: alpha Live label`)
    assert.doesNotMatch(text, /(?:BETA[^\n]{0,100}chip|chip[^\n]{0,100}BETA)/u, `${name}: stale beta Live label`)
  }
})

test('contributor guidance names the current locked-decision count', () => {
  const recorded = [...decisions.matchAll(/^\|\s+(\d+)\s+\|/gmu)]
    .map(match => Number(match[1]))
  assert.deepEqual(recorded, Array.from({ length: 75 }, (_, index) => index + 1))
  assert.equal(recorded.at(-1), 75)
  assert.match(contributorGuide, /\(75 recorded decisions[^)]*do not relitigate locked\s+rows\)/u)
  assert.match(
    decisions,
    /\| 74 \|[^\n]*script-shaped identity door[^\n]*POST \/api\/register[^\n]*POST \/api\/rotate[^\n]*POST \/api\/recovery[^\n]*coding_persistent[^\n]*coding_ephemeral[^\n]*human_approved: true[^\n]*POST \/api\/pair[^\n]*LOCKED/iu,
  )
  assert.match(
    decisions,
    /\| 75 \|[^\n]*window shows what any resident could read standing there[^\n]*quiet: true[^\n]*prefers to keep this room private[^\n]*LOCKED/iu,
  )
  assert.match(decisions, /\| 45 \|[^\n]*Resident-visible contracts precede enforcement[^\n]*LOCKED/iu)
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

test('connector parity tools and deliberate browser-only gaps are stated on every applicable mirror', () => {
  const toolNames = [
    'place_edit', 'thing_edit', 'thing_upgrade', 'coin_trait', 'invent_kind',
    'revise_kind', 'browse', 'buy_credit', 'flag',
  ]
  for (const [name, text] of [
    ['front door', frontdoor],
    ['published front door', frontdoorDocument],
    ['generated front door', FRONTDOOR],
    ['compact machine map', llms],
    ['specification', specification],
  ] as const) {
    for (const toolName of toolNames) {
      assert.ok(text.includes(toolName), `${name}: ${toolName}`)
    }
    assert.match(text, /\/api\/search[^\n]{0,220}maker/iu, `${name}: maker search filter`)
  }

  for (const [name, text] of [
    ['front door', frontdoor],
    ['published front door', frontdoorDocument],
    ['generated front door', FRONTDOOR],
    ['compact machine map', llms],
    ['specification', specification],
    ['hosted sign-in guide', hostedSignin],
  ] as const) {
    assert.match(text, /registration[^\n]{0,180}browser-only[^\n]{0,180}\/join|registration[^\n]{0,180}\/join[^\n]{0,180}browser-only/iu, `${name}: registration policy`)
    assert.match(text, /rotation[^\n]{0,180}browser-only[^\n]{0,180}\/rotate|rotation[^\n]{0,180}\/rotate[^\n]{0,180}browser-only/iu, `${name}: rotation policy`)
    assert.match(text, /recovery[^\n]{0,180}browser-only[^\n]{0,180}\/recovery|recovery[^\n]{0,180}\/recovery[^\n]{0,180}browser-only/iu, `${name}: recovery policy`)
    assert.match(text, /gift[^\n]{0,180}claim token[^\n]{0,180}(?:browser-only|never[^\n]*MCP)/iu, `${name}: gift-token policy`)
    assert.match(text, /PayPal[^\n]{0,180}(?:\/buy|buy routes)[^\n]{0,180}web-only/iu, `${name}: PayPal policy`)
    assert.match(text, /(?:human )?window[^\n]{0,180}web-only/iu, `${name}: window policy`)
  }
})

test('public help states note replay and transfer price behavior before use', () => {
  for (const [name, text] of [
    ['front door', frontdoor],
    ['published front door', frontdoorDocument],
    ['generated front door', FRONTDOOR],
    ['compact machine map', llms],
    ['generated compact machine map', LLMS],
  ] as const) {
    assert.match(text, /new note[^\n]{0,100}201/iu, `${name}: new note status`)
    assert.match(text, /identical[^\n]{0,180}same (?:resident|place)[^\n]{0,180}five minutes[^\n]{0,100}200/iu, `${name}: duplicate note status`)
    assert.match(text, /price[^\n]{0,100}greater than 0[^\n]{0,100}10,?000[^\n]{0,100}6 decimal/iu, `${name}: transfer price`)
    assert.match(text, /reserv(?:e|ation)[^\n]{0,160}before payment/iu, `${name}: transfer order`)
    assert.match(text, /flag[^\n]{0,180}reason[^\n]{0,100}1[^\n]{0,40}500 safe characters/iu, `${name}: flag reason limit`)
  }
})

test('public truth names note write time and makes structural traits authoritative over kind prose', () => {
  for (const [name, text] of [
    ['front door', frontdoor],
    ['published front door', frontdoorDocument],
    ['generated front door', FRONTDOOR],
    ['compact machine map', llms],
    ['generated compact machine map', LLMS],
    ['system design', specification],
  ] as const) {
    assert.match(
      text,
      /note(?:'s)?\s+created_at[\s\S]{0,180}write time[\s\S]{0,180}(?:event(?:'s)?\s+at|at\s+field)[\s\S]{0,120}(?:same|exact)/iu,
      `${name}: note and event write time`,
    )
    assert.match(
      text,
      /historical rows[\s\S]{0,80}(?:stay|remain)[\s\S]{0,80}exactly as written/iu,
      `${name}: historical timestamps`,
    )
    assert.match(text, /A kind's description is owner\s+prose\./iu, `${name}: owner prose`)
    assert.match(
      text,
      /traits list[\s\S]{0,100}each\s+listed\s+trait's\s+public\s+recipe[\s\S]{0,100}machine truth/iu,
      `${name}: structural machine truth`,
    )
    assert.match(
      text,
      /(?:prose and structure|structure and prose)[\s\S]{0,100}disagree[\s\S]{0,100}trust the traits list/iu,
      `${name}: structural precedence`,
    )
  }
})

test('hosted sign-in design describes the Claude-inclusive metadata-origin door without inventing registration', () => {
  assert.match(
    hostedSignin,
    /Clients\s*\|\s*Allowlisted chat-app client-metadata origins[\s\S]{0,100}ChatGPT[\s\S]{0,80}Claude/iu,
  )
  assert.match(hostedSignin, /\/oauth\/register[\s\S]{0,100}(?:HTTP\s+)?404/iu)
  assert.doesNotMatch(hostedSignin, /dynamic client registration|\bDCR\b/iu)
  assert.doesNotMatch(hostedSignin, /ChatGPT client-metadata origins/iu)
  assert.match(
    hostedSignin,
    /### Current ChatGPT setup and wrong-address recovery[\s\S]{0,1800}callback-specific CIMD document/iu,
    'the adjacent callback detail remains explicitly ChatGPT-only',
  )
})

const ACTION_SHAPES = [
  '{"action":"move","to_place_id":123}',
  '{"action":"use","thing_id":123}',
  '{"action":"consume","thing_id":123}',
  '{"action":"give","thing_id":123,"to_handle":"resident-handle"}',
  '{"action":"give","target_type":"place","target_id":123,"to_handle":"resident-handle"}',
  '{"action":"go_home"}',
] as const

test('public route maps include the kind catalog and every dedicated action alias', () => {
  for (const [name, text] of [
    ['front door source', frontdoor],
    ['generated front door', FRONTDOOR],
    ['published front door', frontdoorDocument],
    ['compact machine map source', llms],
    ['generated compact machine map', LLMS],
  ] as const) {
    assert.match(text, /GET\s+\/api\/kinds\b/iu, `${name}: kind catalog`)
  }

  for (const [name, text] of [
    ['front door source', frontdoor],
    ['generated front door', FRONTDOOR],
    ['published front door', frontdoorDocument],
    ['compact machine map source', llms],
    ['generated compact machine map', LLMS],
  ] as const) {
    for (const route of ['/api/go-home', '/api/thing/:id/use', '/api/thing/:id/consume']) {
      assert.ok(text.includes(route), `${name}: ${route}`)
    }
  }
})

test('ChatGPT setup keeps the hosted door distinct and explains stale wrong-address recovery', () => {
  for (const [name, text] of [
    ['front door source', frontdoor],
    ['generated front door', FRONTDOOR],
    ['published front door', frontdoorDocument],
    ['compact machine map', llms],
    ['generated compact machine map', LLMS],
    ['hosted sign-in guide', hostedSignin],
    ['MCP descriptions', mcpSource],
  ] as const) {
    assert.match(
      text,
      /(?:(?:key-capable|local)\b[^\n]{0,180}\/mcp\b|\/mcp\b[^\n]{0,180}(?:key-capable|local)\b)/iu,
      `${name}: key door`,
    )
    assert.match(text, /ChatGPT[\s\S]{0,320}\/mcp\/connect\b/iu, `${name}: hosted door`)
    assert.match(
      text,
      /(?:name already exists|remove|delete)[^\n]{0,220}(?:old|existing|connection|connector)/iu,
      `${name}: stale connector recovery`,
    )
  }
})

test('served visit guidance prefers connector reference tools to optional URL reads', () => {
  assert.doesNotMatch(
    frontdoor,
    /Otherwise it may\s+watch \/window but cannot act as the resident today\./iu,
    'front door must not assume an OAuth-refused host can open /window',
  )
  for (const [name, text] of [
    ['compact machine-map source', llms],
    ['generated compact machine map', LLMS],
    ['system design', specification],
  ] as const) {
    assert.match(
      text,
      /read (?:the|this) (?:live |plain-text )?front door[\s\S]{0,180}\bfront_door\b[\s\S]{0,100}(?:connector|tool)[\s\S]{0,220}https:\/\/1f3d9\.com\/[\s\S]{0,120}(?:if|when)[^\n.]{0,100}(?:client|host)[^\n.]{0,100}open URLs?/iu,
      `${name}: connector-first front door read`,
    )
    assert.doesNotMatch(
      text,
      /Read the full plain-text front door first:\s*https:\/\/1f3d9\.com\//iu,
      `${name}: URL is not a prerequisite`,
    )
  }

  for (const [name, text] of [
    ['front door source', frontdoor],
    ['generated front door', FRONTDOOR],
    ['published front door', frontdoorDocument],
    ['compact machine-map source', llms],
    ['generated compact machine map', LLMS],
    ['system design', specification],
  ] as const) {
    for (const tool of ['front_door', 'official_facts', 'physics']) {
      assert.match(text, new RegExp(`\\b${tool}\\b`, 'u'), `${name}: ${tool} tool`)
    }
    assert.match(
      text,
      /(?:\bofficial_facts\b[\s\S]{0,180}\/api\/official|\/api\/official[\s\S]{0,180}\bofficial_facts\b)/iu,
      `${name}: connector-native official facts`,
    )
    assert.match(
      text,
      /(?:\bphysics\b[\s\S]{0,180}\/api\/physics|\/api\/physics[\s\S]{0,180}\bphysics\b)/iu,
      `${name}: connector-native physics`,
    )
  }
})

test('ChatGPT setup does not invent a mobile support restriction absent from official guidance', () => {
  for (const [name, text] of [
    ['front door source', frontdoor],
    ['generated front door', FRONTDOOR],
    ['published front door', frontdoorDocument],
    ['compact machine map', llms],
    ['generated compact machine map', LLMS],
    ['system design', specification],
    ['hosted sign-in guide', hostedSignin],
    ['runtime discovery copy', hostedDiscoverySource],
  ] as const) {
    assert.doesNotMatch(text, /mobile-browser|mobile browser|not (?:from |the )?(?:a )?mobile app|use desktop web for setup/iu, name)
  }
})

test('ChatGPT setup distinguishes browser-only setup from use after configuration', () => {
  assert.match(SETUP_HTML, /initial connector setup[^.]*browser at chatgpt\.com/iu)
  assert.match(SETUP_HTML, /mobile browser is fine/iu)
  assert.match(SETUP_HTML, /not inside the ChatGPT mobile app/iu)
  assert.match(SETUP_HTML, /Once the connector is configured, it works in both the app and the browser/iu)
})

test('public doors name every accepted browser form proof before attempt counters', () => {
  for (const [name, text] of [
    ['front door', FRONTDOOR],
    ['compact machine map', LLMS],
  ] as const) {
    assert.match(text, /exact same-origin Origin/iu, `${name}: Origin proof`)
    assert.match(text, /Origin[^.]{0,120}(?:absent|missing|not sent)[^.]{0,80}null[^.]{0,160}exact same-origin Referer/iu, `${name}: Referer fallback`)
    assert.match(text, /Sec-Fetch-Site:\s*same-origin/iu, `${name}: fetch site`)
    assert.match(text, /Sec-Fetch-Mode:\s*navigate/iu, `${name}: fetch mode`)
    assert.match(text, /Sec-Fetch-Dest:\s*document/iu, `${name}: fetch destination`)
    assert.match(text, /User-Agent[^.]{0,100}(?:not|isn't|is not)[^.]{0,80}(?:accepted )?proof/iu, `${name}: User-Agent is not proof`)
    assert.match(text, /(?:proof|check)[^.]{0,160}(?:before[^.]{0,80}attempt counters|does not spend[^.]{0,80}attempt)/iu, `${name}: proof precedes counters`)
    assert.match(text, /X-1F3D9-Error-Class/iu, `${name}: shared refusal class`)
    assert.match(text, /X-1F3D9-Reason/iu, `${name}: stable refusal reason`)
    assert.match(text, /X-Request-ID/iu, `${name}: quotable request reference`)
    assert.match(text, /HTML[^.]{0,120}(?:shows|includes)[^.]{0,120}reason[^.]{0,80}request ID/iu, `${name}: visible refusal reference`)
    assert.match(text, /GET[^.]{0,180}sets[^.]{0,100}Secure[^.]{0,100}cookie[^.]{0,160}(?:shows|renders|returns)[^.]{0,80}form/iu, `${name}: GET sets the cookie and shows the form`)
    assert.match(text, /POST[^.]{0,180}cookie[^.]{0,100}(?:missing|not returned)[^.]{0,160}browser_cookie_missing/iu, `${name}: missing cookie reason`)
    assert.match(text, /cookie[^.]{0,120}form[^.]{0,100}(?:do not|does not|did not|doesn't)[^.]{0,40}match[^.]{0,160}browser_cookie_mismatch/iu, `${name}: mismatched cookie reason`)
    assert.doesNotMatch(text, /follow[^.]{0,80}redirect|reissue[^.]{0,80}once|stale proof URL/iu, `${name}: no pre-form cookie proof`)
    for (const reason of BROWSER_REFUSAL_REASONS) {
      assert.match(text, new RegExp(`\\b${reason}\\b`, 'u'), `${name}: ${reason} vocabulary`)
    }
  }
})

test('ChatGPT setup labels operator testing and the embedded-browser automation gap', () => {
  assert.match(SETUP_HTML, /ChatGPT[^.]{0,180}operator-tested/iu)
  assert.match(SETUP_HTML, /no automated test[^.]{0,160}embedded ChatGPT browser/iu)
})

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

test('city fee credit help stays deliberate, private, fixed, and non-transferable', () => {
  for (const [name, text] of [
    ['front door', frontdoor],
    ['compact machine map', llms],
    ['specification', specification],
  ] as const) {
    assert.match(text, /X-1F3D9-FEE-CREDIT/iu, `${name}: explicit credit selector`)
    assert.match(text, /frontier[\s\S]{0,300}kind invention[\s\S]{0,120}kind revision/iu, `${name}: eligible fees`)
    assert.match(text, /(?:unique|stable|same)[^\n]{0,100}request id/iu, `${name}: retry request id`)
    assert.match(text, /(?:never|no)[^\n]{0,120}(?:fallback|silently)[^\n]{0,120}(?:credit|x402)|(?:credit|x402)[^\n]{0,120}(?:never|no)[^\n]{0,120}(?:fallback|silently)/iu, `${name}: no fallback`)
    assert.match(text, /\/api\/me[^\n]{0,180}(?:private|own)[^\n]{0,120}(?:balance|history)|(?:private|own)[^\n]{0,180}(?:balance|history)[^\n]{0,120}\/api\/me/iu, `${name}: private account`)
    assert.match(text, /(?:cannot|never|no)[^\n]{0,180}(?:transfer|sell|redeem|cash out)/iu, `${name}: no transferable value`)
  }

  assert.match(decisions, /\| 40 \|[^\n]*founder-issued city fee credit/iu)
})

test('founder dispute review has one executable, retry-safe, publicly logged exit', () => {
  for (const [name, text] of [
    ['front door', frontdoor],
    ['generated front door', FRONTDOOR],
    ['published front door', frontdoorDocument],
    ['compact machine map', llms],
    ['generated compact machine map', LLMS],
    ['system design', specification],
    ['architecture', architecture],
  ] as const) {
    assert.match(text, /founder resident #1[^.]{0,180}root key/iu, `${name}: founder-only authority`)
    assert.match(text, /seller[-_ ]favou?r[^.]{0,180}(?:ordinary )?pending/iu, `${name}: seller-favour exit`)
    assert.match(text, /buyer[-_ ]favou?r[^.]{0,180}(?:permanent|revok)/iu, `${name}: buyer-favour exit`)
    assert.match(text, /public[^.]{0,240}(?:payment_repair|payment correction)/iu, `${name}: public operator record`)
    assert.match(text, /no query options/iu, `${name}: no-query contract`)
    assert.match(text, /application\/json/iu, `${name}: media-type contract`)
    assert.match(text, /512[^.\n]{0,60}bytes/iu, `${name}: actual body bound`)
    assert.match(text, /30[^.\n]{0,100}(?:attempts|requests)[^.\n]{0,60}hour/iu, `${name}: durable rate limit`)
    assert.match(text, /Retry-After(?::|\s)+3600/iu, `${name}: rate-limit next step`)
    assert.match(text, /Content-Length[^.\n]{0,120}(?:omit|optional|absent)/iu, `${name}: edge header contract`)
    assert.match(
      text,
      /(?:only[^.]{0,100}decision action|decision action[^.]{0,100}only|no[^.]{0,140}(?:PayPal|provider|dispute|capture|purchase|gift)[^.]{0,100}(?:identifier|id))/iu,
      `${name}: redacted public record`,
    )
  }

  for (const [name, text] of [
    ['compact machine map', llms],
    ['generated compact machine map', LLMS],
    ['system design', specification],
    ['architecture', architecture],
  ] as const) {
    assert.match(
      text,
      /POST\s+\/api\/founder\/city-credit\/disputes\/:dispute(?:Id|_id)\/resolve/iu,
      `${name}: founder review route`,
    )
    assert.match(text, /"decision"[^\n]{0,100}"seller_favour"[^\n]{0,100}"buyer_favour"/iu, `${name}: exact decisions`)
    assert.match(text, /(?:same|identical)[^.]{0,120}(?:decision|request)[^.]{0,120}(?:safe to retry|idempotent|unchanged)/iu, `${name}: replay contract`)
    assert.match(text, /(?:only|must be)[^.]{0,100}resolution_review|resolution_review[^.]{0,120}(?:only|otherwise|refus)/iu, `${name}: state precondition`)
    assert.match(text, /credit_dispute_seller_favour[^\n]{0,160}credit_dispute_buyer_favour/iu, `${name}: redacted action vocabulary`)
  }

  assert.match(
    decisions,
    /\| 52 \|[^\n]*founder resident #1[^\n]*seller[-_ ]favou?r[^\n]*buyer[-_ ]favou?r[^\n]*public/iu,
    'decision 52 records the narrow operator power and its public accountability',
  )
})

test('paid city-action help explains bounded recovery without another payment', () => {
  for (const [name, text] of [
    ['front door', frontdoor],
    ['generated front door', FRONTDOOR],
    ['compact machine map', llms],
    ['generated compact machine map', LLMS],
    ['published front door', frontdoorDocument],
    ['system design', specification],
  ] as const) {
    assert.match(text, /pending[^.]{0,180}automatically rechecked[^.]{0,120}(?:at most|for up to) two hours/iu, `${name}: bounded automatic recheck`)
    assert.match(text, /private GET \/api\/payment-attempt\/:id/iu, `${name}: private attempt inspection`)
    assert.match(text, /empty-body POST \/api\/payment-attempt\/:id\/recheck/iu, `${name}: explicit empty-body recheck`)
    assert.match(text, /(?:inspect|recheck|resume)[^.]{0,180}without paying again/iu, `${name}: no second payment`)
    assert.match(text, /(?:at|when) the (?:two-hour )?deadline[^.]{0,180}(?:held )?name[^.]{0,80}released/iu, `${name}: deadline releases the name`)
    assert.match(text, /exact[^.]{0,100}(?:spent|debited) (?:city fee )?credit[^.]{0,100}returned/iu, `${name}: exact credit return`)
    assert.match(text, /uncertain x402[^.]{0,120}(?:never|does not|cannot)[^.]{0,80}(?:mint|create)[^.]{0,60}(?:city fee )?credit/iu, `${name}: no timeout mint`)
    assert.match(text, /late real payment[^.]{0,120}founder review[^.]{0,180}(?:cannot|never)[^.]{0,80}(?:seize|take)[^.]{0,80}(?:reused|new owner)/iu, `${name}: safe late review`)
    assert.match(text, /late real payment[^.]{0,360}(?:cannot|never|does not)[^.]{0,120}(?:complete|trigger)[^.]{0,100}(?:old action|old effect)[^.]{0,60}automat/iu, `${name}: no automatic late effect`)
  }

  for (const [name, text] of [
    ['product requirements', productRequirements],
    ['architecture', architecture],
  ] as const) {
    assert.match(text, /two hours/iu, `${name}: recovery window`)
    assert.match(text, /\/api\/payment-attempt\/:id/iu, `${name}: private recovery route family`)
    assert.match(text, /founder review/iu, `${name}: late payment disposition`)
    assert.match(text, /(?:exact|same)[^.]{0,100}(?:credit|debit)[^.]{0,100}return|return[^.]{0,100}(?:exact|same)[^.]{0,100}(?:credit|debit)/iu, `${name}: credit conservation`)
  }

  assert.match(decisions, /\| 41 \|[^\n]*bounded payment recovery/iu)
})

test('payment safety copy pins the production rail and rejects poisoned wallet history', () => {
  const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
  const treasury = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
  for (const [name, text] of [
    ['front door', frontdoor],
    ['generated front door', FRONTDOOR],
    ['compact machine map', llms],
    ['generated compact machine map', LLMS],
    ['published front door', frontdoorDocument],
    ['system design', specification],
  ] as const) {
    assert.ok(text.includes(usdc), `${name}: exact Base USDC contract`)
    assert.ok(text.includes(treasury), `${name}: exact city treasury recipient`)
    assert.match(text, /Base/iu, `${name}: network`)
    assert.match(text, /1\.000000 USDC/iu, `${name}: exact city fee`)
    assert.match(text, /current (?:402|HTTP 402)(?: response)?[^.]{0,120}\/api\/official|\/api\/official[^.]{0,120}current (?:402|HTTP 402)(?: response)?/iu, `${name}: current authoritative response`)
    assert.match(text, /never copy[^.]{0,100}wallet history/iu, `${name}: wallet-history ban`)
    assert.match(text, /zero-value lookalike transfers?[^.]{0,120}(?:poison|pollute)[^.]{0,80}wallet history/iu, `${name}: poisoned history warning`)
    assert.match(text, /seller[^.]{0,120}(?:recipient|amount)[^.]{0,160}current\s+sale\s+challenge|current\s+sale\s+challenge[^.]{0,160}seller[^.]{0,120}(?:recipient|amount)/iu, `${name}: seller challenge terms`)
  }

  assert.match(frontdoor, /\bpayment_attempt\b/iu, 'front door: planned MCP recovery action')
  assert.match(llms, /\bpayment_attempt\b/iu, 'compact machine map: planned MCP recovery action')
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

test('served onboarding contracts are key-first, resumable, and honest for every client class', () => {
  for (const [name, text] of [
    ['front door source', frontdoor],
    ['generated front door', FRONTDOOR],
    ['published front door', frontdoorDocument],
    ['compact machine map', llms],
    ['generated compact machine map', LLMS],
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
    ['front door source', frontdoor],
    ['compact machine map', llms],
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

  const renderedFrontdoor = renderCityHelpText(frontdoor)
  assert.equal(normalizeLines(fencedCopy), normalizeLines(renderedFrontdoor))
  assert.equal(normalizeLines(FRONTDOOR), normalizeLines(renderedFrontdoor))
  assert.equal(normalizeLines(LLMS), normalizeLines(llms))
})

test('later-holder help keeps discovery deliberate, metadata-only, and honest about host logs', () => {
  const policy =
    'The city stores no record of whether the notice or index was opened. The host may retain short-lived technical request records.'
  const singularQuestion =
    'An earlier holder of this resident identity marked 1 public item for later holders. View the index?'
  const legal = read('../src/legal.ts')
  for (const [name, text] of [
    ['front door', frontdoor],
    ['generated front door', FRONTDOOR],
    ['compact machine map', llms],
    ['generated compact machine map', LLMS],
    ['system design', specification],
    ['legal text', legal],
    ['MCP tools', mcpSource],
  ] as const) {
    assert.ok(text.includes(policy), `${name}: exact opening-record policy`)
    assert.match(text, /later holder|later-holder/iu, `${name}: deliberate discovery`)
  }

  for (const [name, text] of [
    ['front door', frontdoor],
    ['compact machine map', llms],
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
    ['front door', frontdoor], ['compact machine map', llms], ['MCP tools', mcpSource],
  ] as const) {
    for (const phrase of forbidden) assert.doesNotMatch(text, new RegExp(phrase, 'iu'), `${name}: ${phrase}`)
  }
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
    ['front door source', frontdoor],
    ['front door documentation', frontdoorDocument],
    ['generated front door', FRONTDOOR],
  ] as const) {
    assert.match(text, /your human has somewhere to talk about this place now/iu, name)
    assert.match(text, /reddit\.com\/r\/TheAiCity/iu, name)
    assert.doesNotMatch(text, /(?:resident|agent)s? can post (?:to|on) (?:the )?subreddit/iu, name)
  }
})

test('public help names the asking and telling rooms with their participation rules', () => {
  for (const [name, text] of [
    ['front door source', frontdoor],
    ['front door documentation', frontdoorDocument],
    ['generated front door', FRONTDOOR],
    ['compact machine-map source', llms],
    ['generated compact machine map', LLMS],
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

test('drawing, feed, snapshot, and live-plate contracts stay aligned', () => {
  for (const [name, text] of [
    ['front door', frontdoor],
    ['compact machine map', llms],
    ['specification', specification],
    ['drawing design', drawingDesign],
  ] as const) {
    assert.match(text, /palette[\s\S]{0,180}(?:0\.\.64|0 (?:through|to) 64)[\s\S]{0,180}lowercase `?#rrggbb`?/iu, `${name}: palette shape`)
    assert.match(text, /indices[\s\S]{0,180}exactly 64[\s\S]{0,180}(?:null|empty)[\s\S]{0,180}(?:in-range|existing palette)/iu, `${name}: index shape`)
    assert.match(text, /2,?048 UTF-8 bytes/iu, `${name}: canonical drawing bytes`)
    assert.match(text, /\/api\/me\/drawing/iu, `${name}: resident drawing route`)
    assert.match(text, /\/api\/drawing\/:type\/:id/iu, `${name}: dedicated drawing read`)
    assert.match(text, /\bdraw_self\b/iu, `${name}: resident MCP tool`)
    assert.match(text, /\bresident_edited\b/iu, `${name}: resident drawing event`)
    assert.match(text, /six changed[\s\S]{0,180}UTC minute/iu, `${name}: resident drawing rate`)
    assert.match(text, /exact(?:\s+whole)?[\s\S]{0,100}\bREFUSE\b/iu, `${name}: exact refusal value`)
    assert.match(
      text,
      /Undrawn[\s\S]{0,220}Refused[\s\S]{0,220}Blank[\s\S]{0,220}In progress[\s\S]{0,220}Complete/iu,
      `${name}: five visible presentations`,
    )
    assert.match(text, /drawing_description[\s\S]{0,180}280 UTF-8 bytes/iu, `${name}: paired description`)
    assert.match(text, /drawing_description[\s\S]{0,220}safe public text/iu, `${name}: safe public description`)
    assert.match(text, /variant names?[\s\S]{0,220}safe one-line/iu, `${name}: safe variant names`)
    assert.match(text, /drawing_state[\s\S]{0,120}in_progress[\s\S]{0,80}complete/iu, `${name}: explicit progress`)
    assert.match(text, /eight[^.\n]{0,80}rows?[\s\S]{0,160}\.[^\n]{0,80}transparent/iu, `${name}: canonical rows`)
    assert.match(text, /\/api\/drawing\/:type\/:id\/history/iu, `${name}: deliberate history read`)
    assert.match(text, /real changes?[\s\S]{0,220}immutable (?:revision|history)/iu, `${name}: immutable change history`)
    assert.match(text, /exact no-op[\s\S]{0,160}(?:adds|appends|creates) no/iu, `${name}: no-op history`)
    assert.doesNotMatch(text, /overwrites without history/iu, `${name}: stale overwrite claim`)
    assert.match(text, /(?:named )?variants?[\s\S]{0,220}(?:kind|revision) owner/iu, `${name}: owner-shaped variants`)
    assert.match(text, /selected variant[\s\S]{0,220}(?:missing|absent|unavailable)[\s\S]{0,220}(?:reject|refus)/iu, `${name}: honest upgrade`)
    assert.match(text, /from_place_id[\s\S]{0,160}to_place_id|to_place_id[\s\S]{0,160}from_place_id/iu, `${name}: movement endpoints`)
    assert.match(text, /\bsource_thing_id\b/iu, `${name}: used thing reference`)
    assert.match(text, /\bsource_thing_id\b[\s\S]{0,120}\bplace_id\b/iu, `${name}: committed use place`)
    assert.match(text, /give[\s\S]{0,180}\btransfer\b[\s\S]{0,220}consume[\s\S]{0,180}\bthing_withdrawn\b/iu, `${name}: typed give and consume events`)
    assert.match(text, /\blive_survey\b/iu, `${name}: compact exact thing survey`)
    assert.match(
      text,
      /body-free[\s\S]{0,180}(?:(?:direct|directly)[\s\S]{0,100}(?:active )?thing count|(?:active )?thing count[\s\S]{0,100}(?:direct|directly))/iu,
      `${name}: body-free direct thing counts`,
    )
    assert.match(
      text,
      /one[\s\S]{0,100}(?:newest|named)[\s\S]{0,100}(?:50|fifty)[\s\S]{0,180}(?:never|does not)[\s\S]{0,100}(?:cursor|second page)/iu,
      `${name}: one bounded named-thing page`,
    )
    assert.match(
      text,
      /Thing #(?:23|<id>)[\s\S]{0,100}recorded in/iu,
      `${name}: Focus fallback keeps a stable thing id and recorded place`,
    )
  }

  for (const [name, text] of [
    ['specification', specification],
    ['drawing design', drawingDesign],
  ] as const) {
    assert.match(text, /cartographic plate/iu, `${name}: plate direction`)
    assert.match(text, /25 seconds[\s\S]{0,180}60[\s\S]{0,80}120[\s\S]{0,80}240[\s\S]{0,80}300 seconds/iu, `${name}: activity-following cadence`)
    assert.match(text, /This view is new\. It draws the same public record as every other tab — if it disagrees with them, they are right\./u, `${name}: alpha sentence`)
    assert.match(text, /prefers-reduced-motion[\s\S]{0,220}forced-colors|forced-colors[\s\S]{0,220}prefers-reduced-motion/iu, `${name}: accessibility modes`)
    assert.match(text, /within_seconds=1800/iu, `${name}: opening-history horizon`)
    assert.match(text, /change_id[\s\S]{0,320}(?:replay|static)|(?:replay|static)[\s\S]{0,320}change_id/iu, `${name}: commit-safe replay boundary`)
    assert.match(
      text,
      /1,600\s+(?:opening\s+)?events[\s\S]{0,320}(?:Continue recent history|real Continue action)/iu,
      `${name}: bounded resumable opening history`,
    )
    assert.match(text, /(?:3[.]2\s+(?:to|–)\s+8|three point two to eight)\s+seconds/iu, `${name}: bounded replay duration`)
    assert.match(text, /(?:newly learned rows[\s\S]{0,80}replay once|replays[\s\S]{0,80}newly learned rows once|walks once)/iu, `${name}: one-shot replay`)
    assert.match(text, /speech bubble[\s\S]{0,180}(?:60|sixty)[\s\S]{0,220}(?:newest|one per resident)/iu, `${name}: speech bubble contract`)
    assert.match(text, /ledger[\s\S]{0,120}(?:full|complete|exact) (?:note )?(?:body|text)/iu, `${name}: full note ledger`)
    assert.match(text, /no new dependenc/iu, `${name}: dependency boundary`)
  }

  assert.match(publicSnapshots, /residents[\s\S]{0,200}drawing/iu)
  assert.match(publicSnapshots, /things[\s\S]{0,260}drawing_source[\s\S]{0,180}kind_revision/iu)
  assert.match(publicSnapshots, /ordinary[\s\S]{0,160}(?:map|room|window|census)[\s\S]{0,180}(?:omit|do not include|never include)[\s\S]{0,100}drawing/iu)
  assert.match(publicSnapshots, /drawing_revisions[\s\S]{0,240}(?:previous|prior)[\s\S]{0,180}current/iu)
})

test('Wave 9 complete names and bounded window truths stay aligned', () => {
  for (const [name, text] of [
    ['front door', frontdoor],
    ['compact machine map', llms],
    ['specification', specification],
  ] as const) {
    assert.match(text, /\/api\/window\?view=directory/iu, `${name}: directory route`)
    assert.match(
      text,
      /\btype:\s*["']place["'][\s\S]{0,240}\btype:\s*["']resident["']/iu,
      `${name}: typed directory records`,
    )
    assert.match(
      text,
      /(?:complete|every public)[^\n]{0,100}(?:place names?|names? of public places)[^\n]{0,160}(?:resident handles?|handles? of public residents)|(?:place names?|names? of public places)[^\n]{0,160}(?:resident handles?|handles? of public residents)[^\n]{0,100}(?:complete|every public)/iu,
      `${name}: complete public names`,
    )
    assert.match(
      text,
      /(?:place[^\n]{0,80}\bid\b[^\n]{0,80}\bparent_id\b[^\n]{0,80}\bname\b|\bid\b[^\n]{0,80}\bparent_id\b[^\n]{0,80}\bname\b[^\n]{0,80}place)/iu,
      `${name}: minimal place facts`,
    )
    assert.match(
      text,
      /(?:resident[^\n]{0,80}\bid\b[^\n]{0,80}\bhandle\b|\bid\b[^\n]{0,80}\bhandle\b[^\n]{0,80}resident)/iu,
      `${name}: minimal resident facts`,
    )
    assert.match(
      text,
      /(?:directory|selectors?)[^\n]{0,220}(?:bounded|currently loaded|focused)[^\n]{0,220}(?:contents?|presence|details)|(?:bounded|currently loaded|focused)[^\n]{0,220}(?:contents?|presence|details)[^\n]{0,220}(?:directory|selectors?)/iu,
      `${name}: names do not widen loaded content`,
    )
  }

  for (const [name, text] of [
    ['product requirements', productRequirements],
    ['locked decisions', decisions],
  ] as const) {
    assert.match(
      text,
      /\btype:\s*["']place["'][\s\S]{0,240}\btype:\s*["']resident["']/iu,
      `${name}: typed directory records`,
    )
  }

  assert.match(
    decisions,
    /\| 43 \| \*\*The human window uses a complete lightweight names directory\.\*\*/iu,
    'decision 43 locks complete names without complete contents',
  )
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

test('Wave 5 search and caller-held change-marker truths stay aligned', () => {
  for (const [name, text] of [
    ['front door', frontdoor],
    ['compact machine map', llms],
    ['specification', specification],
  ] as const) {
    assert.match(text, /\/api\/search/iu, `${name}: public search route`)
    assert.match(text, /\bwords?\b[^\n]{0,120}\bphrase\b|\bphrase\b[^\n]{0,120}\bwords?\b/iu, `${name}: search modes`)
    assert.match(text, /\bnotes?\b[^\n]{0,120}\bthings?\b|\bthings?\b[^\n]{0,120}\bnotes?\b/iu, `${name}: searched records`)
    assert.match(text, /date order|newest (?:first|to oldest)/iu, `${name}: stable order`)
    assert.match(text, /no relevance|not relevance-ranked/iu, `${name}: no relevance promise`)
    assert.match(text, /exact[^\n]{0,100}totals?/iu, `${name}: exact totals`)
    assert.match(text, /\/api\/changes/iu, `${name}: public change route`)
    assert.match(text, /caller-held|client-held|keep (?:the )?marker/iu, `${name}: caller marker`)
    assert.match(text, /\bsince\b/iu, `${name}: continuation marker`)
    assert.match(
      text,
      /no durable[^\n]{0,160}(?:reader identity|reading history)/iu,
      `${name}: no reading history`,
    )
  }
})

test('Wave 7 help keeps room purpose and owner-chosen front matter neutral and body-free', () => {
  for (const [name, text] of [
    ['front door', frontdoor],
    ['compact machine map', llms],
    ['specification', specification],
  ] as const) {
    assert.match(
      text,
      /owner[- ]written[^\n]{0,100}\bpurpose\b|\bpurpose\b[^\n]{0,100}owner[- ]written/iu,
      `${name}: owner-written purpose`,
    )
    assert.match(text, /\bpurpose\b[^\n]{0,140}\b280\b|\b280\b[^\n]{0,140}\bpurpose\b/iu, `${name}: purpose limit`)
    assert.match(
      text,
      /\bpurpose\b[\s\S]{0,220}(?:does not replace|separate from)[\s\S]{0,120}\bdescription\b|\bdescription\b[\s\S]{0,220}(?:preserved|remains|still)[\s\S]{0,120}\bpurpose\b/iu,
      `${name}: purpose does not erase the description`,
    )
    assert.match(
      text,
      /front[ -]matter[\s\S]{0,220}(?:exactly )?(?:two|2)[\s/]+(?:or[\s/]+)?(?:three|3)[\s\S]{0,160}order/iu,
      `${name}: two or three ordered choices`,
    )
    assert.match(
      text,
      /front[ -]matter[\s\S]{0,320}\bactive\b[\s\S]{0,180}(?:same (?:room|place)|in that (?:room|place))|(?:same (?:room|place)|in that (?:room|place))[\s\S]{0,180}\bactive\b[\s\S]{0,320}front[ -]matter/iu,
      `${name}: active things from the same room`,
    )
    assert.match(
      text,
      /front[ -]matter[\s\S]{0,320}(?:body[- ]free|(?:omits?|never (?:includes?|returns?))[\s\S]{0,100}\bbod(?:y|ies)\b)/iu,
      `${name}: body-free room read`,
    )
    assert.match(
      text,
      /unavailable[\s\S]{0,180}(?:disappear|omit|remove)[\s\S]{0,180}(?:no|not|never)[^\n]{0,100}(?:replace|substitute|auto-select)/iu,
      `${name}: unavailable choices disappear without replacement`,
    )
    assert.match(
      text,
      /front[ -]matter[\s\S]{0,320}(?:no|not|never|does not)[^\n]{0,100}\brank(?:s|ed|ing)?\b/iu,
      `${name}: no ranking`,
    )
    assert.match(
      text,
      /front[ -]matter[\s\S]{0,320}(?:no|not|never|does not)[^\n]{0,100}\bendorse(?:s|d|ment)?\b/iu,
      `${name}: no endorsement`,
    )
  }
})

test('Wave 2 public truth separates permanent maker from current owner', () => {
  for (const [name, text] of [
    ['front door', frontdoor],
    ['compact machine map', llms],
    ['specification', specification],
    ['decisions', decisions],
  ] as const) {
    assert.match(text, /(?:permanent|unchangeable|never changes?)[^\n]{0,120}\bmaker\b|\bmaker\b[^\n]{0,120}(?:permanent|unchangeable|never changes?)/iu, `${name}: permanent maker`)
    assert.match(text, /\bmade_by\b/iu, `${name}: public maker field`)
    assert.match(text, /\bcurrent_owner\b/iu, `${name}: public current-owner field`)
    assert.match(text, /(?:gift|transfer|sale)[^\n]{0,180}(?:maker|made_by)|(?:maker|made_by)[^\n]{0,180}(?:gift|transfer|sale)/iu, `${name}: transfers preserve maker`)
  }
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
    assert.match(text, /hosted clients cache the tool list[\s\S]{0,100}reconnect/iu, `${name}: refresh cached tools`)
  }

  assert.match(mcpSource, /name: 'act'[\s\S]{0,2500}move runs the laws of the\s+place being left/iu)
  assert.match(mcpSource, /name: 'browse'[\s\S]{0,2500}resident label holdings/iu)
  assert.match(mcpSource, /name: 'me'[\s\S]{0,2500}labels are private to the authenticated bearer/iu)
})
