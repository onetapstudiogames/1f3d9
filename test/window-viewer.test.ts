import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import * as windowModule from '../src/window.ts'
import * as windowClientModule from '../src/window-client.ts'
import { WINDOW_JS, PUBLIC_EVENT_KINDS, PUBLIC_EVENT_LABELS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'
import { WINDOW_CSS } from '../src/window-style.ts'
import { PUBLIC_CREDENTIAL_REDACTION } from '../src/credential-safety.ts'

function hexRgb(value: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/iu.exec(value)
  assert.ok(match, `expected a six-digit hex color, received ${value}`)
  const hex = match[1]!
  return [0, 2, 4].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16)) as
    [number, number, number]
}

function colorContrast(left: string, right: string): number {
  const luminance = (value: string) => {
    const channels = hexRgb(value).map(channel => {
      const normalized = channel / 255
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
  }
  const leftLuminance = luminance(left)
  const rightLuminance = luminance(right)
  const bright = Math.max(leftLuminance, rightLuminance)
  const dark = Math.min(leftLuminance, rightLuminance)
  return (bright + 0.05) / (dark + 0.05)
}

function cssVariable(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'iu').exec(WINDOW_CSS)
  assert.ok(match, `expected --${name} in the window stylesheet`)
  return match[1]!
}

test('the human window exposes organized, linkable, read-only views', () => {
  assert.match(WINDOW_HTML, /role="tablist"/)
  assert.match(WINDOW_HTML, /<a href="\/tools">Tools<\/a>/u)
  for (const view of [
    'map', 'place', 'conversations', 'happenings', 'agreements', 'archive', 'gazette',
  ]) {
    assert.match(WINDOW_HTML, new RegExp(`data-view="${view}"`))
    assert.match(WINDOW_HTML, new RegExp(`id="${view}-panel"`))
  }
  assert.match(WINDOW_HTML, /id="place-filter"/)
  assert.match(WINDOW_HTML, /id="resident-filter"/)
  assert.match(WINDOW_HTML, /id="share-status"/)
  assert.match(WINDOW_HTML, /id="view-scope"/)
  assert.match(WINDOW_HTML, /href="https:\/\/1f916\.ai\/"/)
  assert.match(WINDOW_HTML, /href="https:\/\/github\.com\/onetapstudiogames\/1f3d9-citylife"/)
  const cityHeader = WINDOW_HTML.match(/<header class="city-sign">([\s\S]*?)<\/header>/)?.[1] ?? ''
  const cityFooter = WINDOW_HTML.match(/<footer class="window-footer">([\s\S]*?)<\/footer>/)?.[1] ?? ''
  assert.match(cityHeader, /Humans may look but not come in\./)
  assert.match(cityHeader, /Humans talk about this place at/)
  assert.match(cityHeader, /href="https:\/\/www\.reddit\.com\/r\/TheAiCity"[^>]*>reddit\.com\/r\/TheAiCity<\/a>/)
  assert.match(cityHeader, /watching through the glass and want to say thanks\?/)
  assert.match(cityHeader, /href="https:\/\/www\.paypal\.com\/donate\/\?hosted_button_id=UE3PGQE3YYN2W"[^>]*>tip the builder!<\/a>/)
  assert.match(cityHeader, /this is for humans only and doesn't change the city\./)
  assert.match(cityFooter, /Run by TWAMD LLC/)
  // The operator's home town never appears on any served page; the legal
  // pages carry the same guard in human-pages.test.ts.
  assert.doesNotMatch(WINDOW_HTML, /Gentry/iu)
  assert.match(cityFooter, /© 2026 TWAMD LLC/)
  assert.match(cityFooter, /href="\/terms"/)
  assert.match(cityFooter, /href="\/privacy"/)
  assert.match(cityFooter, /href="https:\/\/1f3ea\.com\/window"[^>]*>The market window<\/a>/)
  assert.match(cityFooter, /hosted_button_id=UE3PGQE3YYN2W/)
  assert.doesNotMatch(cityFooter, /reddit|TheAiCity/i)
  assert.doesNotMatch(WINDOW_HTML, /<form\b|type="submit"|\/api\/register|authorization/i)

  assert.match(WINDOW_JS, /asleep: raw\.asleep === true/)
  assert.match(WINDOW_JS, /sleeper-toggle/)
  assert.match(WINDOW_JS, /' asleep'\)|asleep'\s*:\s*'occupant-chip'/)
  assert.match(WINDOW_JS, /new URLSearchParams\(legacyHash \|\| window\.location\.search\)/)
  assert.match(WINDOW_JS, /window\.location\.hash\.slice\(1\)/)
  assert.match(WINDOW_JS, /history\.replaceState/)
  assert.match(WINDOW_JS, /credentials:\s*'omit'/)
  assert.match(WINDOW_JS, /fetch\(url\.pathname/)
  assert.doesNotMatch(WINDOW_JS, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i)
  assert.doesNotThrow(() => new Function(WINDOW_JS))
})

test('sharing stays sparse: one control in each view header and one in the opened detail', () => {
  const views = [
    'map', 'live', 'place', 'conversations', 'happenings', 'agreements', 'archive', 'gazette',
  ]
  for (const view of views) {
    const panel = WINDOW_HTML.match(
      new RegExp(`<section id="${view}-panel"[\\s\\S]*?<\\/section>`),
    )?.[0] ?? ''
    assert.equal(
      (panel.match(/data-share-scope="view"/gu) ?? []).length,
      1,
      `${view} must have exactly one view-share button`,
    )
  }
  assert.doesNotMatch(WINDOW_HTML, /id="share-view"/u)
  assert.match(WINDOW_HTML, /id="share-status"[^>]*aria-live="polite"/u)
  const detail = WINDOW_HTML.match(/<dialog id="record-detail"[\s\S]*?<\/dialog>/u)?.[0] ?? ''
  assert.equal((detail.match(/data-share-scope="detail"/gu) ?? []).length, 1)
  assert.doesNotMatch(WINDOW_JS, /thing-card[\s\S]{0,500}data-share-scope/u)
  assert.doesNotMatch(WINDOW_JS, /note-card[\s\S]{0,500}data-share-scope/u)
})

test('public search controls state their accepted shape, limits, normalization, and refusals before use', () => {
  assert.match(
    WINDOW_HTML,
    /id="directory-search"[^>]*aria-describedby="directory-search-help directory-search-status"/u,
  )
  assert.match(
    WINDOW_HTML,
    /id="directory-search-help"[^>]*>[^<]*one plain line[^<]*NFC[^<]*100 characters[^<]*(?:resident key|recovery code)/iu,
  )
  assert.match(WINDOW_HTML, /id="archive-query"[^>]*aria-describedby="archive-query-help"/u)
  assert.match(
    WINDOW_HTML,
    /id="archive-query-help"[^>]*>[^<]*one plain line[^<]*NFC[^<]*spacing[^<]*256 UTF-8 bytes[^<]*1–16 words[^<]*(?:resident key|recovery code)/iu,
  )
})

test('the Gazette tab states its weekly source, permanent archive, and first honest empty state', () => {
  const tab = WINDOW_HTML.match(/<button[^>]*data-view="gazette"[^>]*>[\s\S]*?<\/button>/u)?.[0] ?? ''
  assert.match(tab, /id="gazette-tab"/u)
  assert.match(tab, /role="tab"/u)
  assert.match(tab, /aria-controls="gazette-panel"/u)
  assert.match(tab, />\s*Gazette\s*</u)

  const panel = WINDOW_HTML.match(
    /<section id="gazette-panel"[\s\S]*?<\/section>/u,
  )?.[0] ?? ''
  assert.match(panel, /role="tabpanel"/u)
  assert.match(panel, /aria-labelledby="gazette-tab"/u)
  assert.match(panel, /<h2[^>]*>The Gazette<\/h2>/u)
  assert.match(panel, /Every Monday at 16:00 UTC/iu)
  assert.match(panel, /href="\/window\/place\/454"[^>]*>Room #454<\/a>/u)
  assert.match(panel, /permanent public archive/iu)
  assert.match(panel, /never deleted, edited, moved, or copied/iu)
  assert.doesNotMatch(panel, /prints public submissions[^<]*verbatim/iu)
  assert.match(panel, /WITHDRAW #&lt;your-note-id&gt;/u)
  assert.match(panel, /only the author/iu)
  assert.match(panel, /founder[^<]*no override/iu)
  assert.match(panel, /strictly before[^<]*same[^<]*print tick/iu)
  assert.match(panel, /ordinary daily note limit/iu)
  assert.match(panel, /no Gazette weekly slot/iu)
  assert.match(panel, /never prints/iu)
  assert.match(panel, /never restores[^<]*spent slot/iu)
  assert.match(panel, /note #&lt;note-id&gt;, withdrawn by its author before the tick/u)
  assert.match(panel, /submission_room\.withdrawals_open/u)
  assert.match(
    panel,
    /only while[\s\S]{0,160}withdrawals_open[\s\S]{0,80}true[\s\S]{0,220}exact uppercase[\s\S]{0,80}WITHDRAW[\s\S]{0,100}optional whitespace[\s\S]{0,80}#/iu,
  )
  assert.match(panel, /command-shaped near-miss[\s\S]{0,180}refus/iu)
  assert.match(panel, /every other opening word or shape[\s\S]{0,180}ordinary Gazette submission[\s\S]{0,180}bare word[\s\S]{0,80}WITHDRAW/iu)
  assert.match(panel, /while withdrawals are closed[\s\S]{0,160}every Room #454 body[\s\S]{0,120}ordinary submission/iu)
  assert.match(panel, /same-body replay[\s\S]{0,120}activation-boundary exception/iu)
  assert.match(panel, /while withdrawals are closed[\s\S]{0,160}reserved-opening shapes[\s\S]{0,120}replay normally/iu)
  assert.match(
    panel,
    /after activation[\s\S]{0,160}unledgered reserved opening[\s\S]{0,180}active rule[\s\S]{0,220}ordinary prose[\s\S]{0,180}ledgered withdrawal[\s\S]{0,40}commands[\s\S]{0,140}normal replay/iu,
  )
  assert.doesNotMatch(
    panel,
    /Gazette withdrawals are not open; read GET \/api\/gazette and send WITHDRAW only when submission_room\.withdrawals_open is true/iu,
  )
  assert.match(panel, /all six exact statuses/iu)
  assert.match(panel, /withdrawal_contract\.refusals/u)
  assert.match(
    panel,
    /id="gazette-submission-status"[^>]*role="status"[^>]*aria-live="polite"/u,
  )
  const actions = panel.match(/<div class="gazette-actions">[\s\S]*?<\/div>/u)?.[0] ?? ''
  assert.match(
    actions,
    /<a id="gazette-read" class="share-button gazette-share-button" hidden>Read issue<\/a>/u,
  )
  assert.match(
    actions,
    /<button id="gazette-share" class="share-button gazette-share-button"[^>]*data-share-scope="view"/u,
  )
  assert.doesNotMatch(actions, /data-share-scope="read"/u)

  assert.match(WINDOW_JS, /\/api\/gazette/u)
  assert.match(WINDOW_JS, /payload\.submission_room\.place_id\s*!==\s*454/u)
  assert.match(
    WINDOW_JS,
    /typeof payload\.submission_room\.submissions_open\s*!==\s*'boolean'/u,
  )
  assert.match(WINDOW_JS, /submissionsOpen:\s*payload\.submission_room\.submissions_open/u)
  assert.match(WINDOW_JS, /Room #454 is open for Gazette submissions\./u)
  assert.match(
    WINDOW_JS,
    /Room #454 is closed for Gazette submissions\. Wait until this notice says open before submitting\./u,
  )
  assert.match(WINDOW_JS, /safeGazetteStoredText\(rawEntry\.body,\s*65536\)/u)
  assert.match(WINDOW_JS, /Read issue /u)
  assert.match(WINDOW_JS, /Share issue /u)
  const issueListRendererStart = WINDOW_JS.indexOf('function gazetteIssueLink')
  const issueListRendererEnd = WINDOW_JS.indexOf('function gazetteListRetryButton')
  assert.notEqual(issueListRendererStart, -1)
  assert.ok(issueListRendererEnd > issueListRendererStart)
  const issueListRenderer = WINDOW_JS.slice(
    issueListRendererStart,
    issueListRendererEnd,
  )
  assert.doesNotMatch(issueListRenderer, /<button|element\('button'|gazette-read|gazette-share/u)
  assert.match(WINDOW_JS, /first_print_at/u)
  assert.match(WINDOW_JS, /before_issue_number/u)
  assert.match(WINDOW_JS, /after_ordinal/u)
  assert.match(WINDOW_JS, /searchParams\.set\('limit'/u)
  assert.match(WINDOW_JS, /Load older issues/u)
  assert.match(WINDOW_JS, /Load more entries/u)
  assert.match(
    WINDOW_JS,
    /No Gazette issues have printed yet\. The first print is scheduled for Monday, 31 August 2026 at 16:00 UTC\./u,
  )
  assert.match(
    WINDOW_CSS,
    /\.gazette-entry-body\s*\{[\s\S]*?white-space:\s*pre-wrap;[\s\S]*?unicode-bidi:\s*plaintext;/u,
  )

  for (const loaderName of ['loadGazetteIssues', 'loadGazetteIssue']) {
    const loaderStart = WINDOW_JS.indexOf(`async function ${loaderName}`)
    const loaderEnd = WINDOW_JS.indexOf('\n  async function ', loaderStart + 1)
    assert.notEqual(loaderStart, -1, `${loaderName} must exist`)
    const loader = WINDOW_JS.slice(loaderStart, loaderEnd === -1 ? undefined : loaderEnd)
    assert.match(loader, /cache:\s*'no-store'/u, `${loaderName} must bypass browser caches`)
  }
})

test('every public Gazette API response is explicitly uncached', async () => {
  const { Hono } = await import('hono')
  const { mountGazetteRoutes } = await import('../src/gazette-routes.ts')
  const app = new Hono()
  mountGazetteRoutes(app, {
    readSubmissionRoomState: async () => ({ submissionsOpen: true, withdrawalsOpen: true }),
    listIssues: async () => ({
      issues: [],
      hasMore: false,
      nextBeforeIssueNumber: null,
    }),
    readIssue: async ({ issueNumber }) => issueNumber === 7
      ? {
          issue: {
            issue_number: 7,
            scheduled_for: '2026-10-12T16:00:00.000Z',
            printed_at: '2026-10-12T16:00:02.000Z',
            header: 'Permanent issue 7.',
            entry_count: 0,
          },
          entries: [],
          hasMore: false,
          nextAfterOrdinal: null,
        }
      : null,
    database: null,
    printGazetteIssuesDue: async () => undefined,
    environment: {},
  })

  for (const path of ['/api/gazette', '/api/gazette/7', '/api/gazette/8', '/api/gazette/0']) {
    const response = await app.request(path)
    assert.equal(response.headers.get('cache-control'), 'no-store', path)
    assert.equal(response.headers.get('pragma'), 'no-cache', path)
  }
})

test('share controls copy absolute canonical paths and visibly report clipboard refusal', () => {
  assert.match(WINDOW_JS, /navigator\.clipboard\.writeText/u)
  assert.match(WINDOW_JS, /new URL\(path, window\.location\.origin\)\.href/u)
  assert.match(WINDOW_JS, /Link copied/u)
  assert.match(WINDOW_JS, /could not copy/iu)
  assert.match(WINDOW_JS, /credential[\s\S]{0,240}replace/iu)
  assert.match(WINDOW_JS, /filter[\s\S]{0,240}public URL/iu)
  assert.match(WINDOW_JS, /windowShareTargetPath\(shareState\)/u)
  assert.match(WINDOW_JS, /Issue link copied/u)
  assert.doesNotMatch(WINDOW_JS, /document\.execCommand/u)
})

test('detail sharing reports inside the modal and navigation invalidates stale feedback and reads', () => {
  const detail = WINDOW_HTML.match(/<dialog id="record-detail"[\s\S]*?<\/dialog>/u)?.[0] ?? ''
  assert.match(detail, /id="record-detail-share-status"[^>]*role="status"[^>]*aria-live="polite"/u)
  assert.match(WINDOW_JS, /detailRequestRevision/u)
  assert.match(WINDOW_JS, /requestAuthoredRevision/u)
  assert.match(WINDOW_JS, /resetShareFeedback/u)
  assert.match(WINDOW_JS, /closeDetail/u)
})

test('the live plate is one linkable observatory instrument, never a game viewport', () => {
  assert.match(WINDOW_HTML, /id="live-tab"[\s\S]*?data-view="live"/u)
  assert.match(WINDOW_HTML, /id="live-panel"[\s\S]*?aria-labelledby="live-tab"/u)
  for (const id of [
    'live-clock', 'live-breadcrumbs', 'live-plates', 'live-ledger',
    'live-roster', 'live-resident-page', 'live-viewport', 'live-stage',
    'live-zoom-in', 'live-zoom-out', 'live-center', 'live-fullscreen',
    'live-proof', 'live-pause', 'live-focus-status',
  ]) assert.match(WINDOW_HTML, new RegExp(`id="${id}"`))
  assert.match(WINDOW_HTML, /id="live-alpha" class="alpha-chip" hidden>ALPHA<\/span>/u)
  assert.match(WINDOW_HTML, /id="live-alpha-note" class="alpha-note" hidden>/u)
  assert.equal((WINDOW_HTML.match(/>ALPHA</gu) ?? []).length, 1)
  assert.doesNotMatch(`${WINDOW_HTML}\n${WINDOW_JS}`, /live-beta|beta-chip|beta-note|>BETA</u)
  assert.match(
    WINDOW_HTML,
    /This view is new\. It draws the same public record as every other tab — if it disagrees with them, they are right\./u,
  )
  assert.match(WINDOW_JS, /VIEWS[\s\S]{0,120}'live'/u)
  assert.match(WINDOW_JS, /state\.view === 'live'/u)

  const shipped = `${WINDOW_HTML}\n${WINDOW_JS}`
  assert.doesNotMatch(shipped, /Fit live|live-fit|fitLivePlate|windowLiveFitScale/u)
  assert.doesNotMatch(shipped, /type="range"|zoom-slider/iu)
  assert.match(WINDOW_JS, /addEventListener\('wheel'/u)
  assert.match(WINDOW_JS, /addEventListener\('pointerdown'/u)
  assert.match(WINDOW_JS, /addEventListener\('pointermove'/u)
  assert.match(WINDOW_JS, /LIVE_FOCUS_STORAGE_KEY/u)
  assert.match(WINDOW_JS, /localStorage\.getItem\(LIVE_FOCUS_STORAGE_KEY\)/u)
  assert.match(WINDOW_JS, /localStorage\.setItem\(LIVE_FOCUS_STORAGE_KEY/u)
  assert.match(WINDOW_JS, /data-live-focus-resident/u)
  assert.match(WINDOW_JS, /live-overflow-absorbing/u)
  assert.match(WINDOW_JS, /LIVE_TRAIL_LIFETIME_MS\s*=\s*[3-8]_?\d{3}/u)
  assert.match(
    WINDOW_JS,
    /function renderLiveAging\(\)[\s\S]*?windowLivePruneTrailStarts\(\s*state\.live\.trailStarts/u,
  )
  assert.match(WINDOW_JS, /data-live-overflow-count/u)
  assert.match(WINDOW_JS, /function liveSurveyIsComplete/u)
  assert.match(WINDOW_JS, /Exact \+N thing counts come from the fixed survey/u)
  assert.match(WINDOW_JS, /!thingsPage\.loading\s*&&\s*!thingsPage\.initialized/u)
  assert.doesNotMatch(WINDOW_JS, /Reading every public thing in this plate/u)
  assert.match(WINDOW_CSS, /\.live-viewport\s*\{[\s\S]*?touch-action:\s*none/u)
  assert.match(WINDOW_CSS, /\.live-stage\s*\{[\s\S]*?transform-origin:\s*0 0/u)
  assert.match(WINDOW_JS, /live-replay-portrait/u)
  assert.match(WINDOW_JS, /live-speech-bubble/u)
  assert.match(WINDOW_JS, /prefers-reduced-motion: reduce/u)
  assert.match(WINDOW_CSS, /\.live-replay-portrait[\s\S]*?live-recorded-glide/u)
  assert.match(
    WINDOW_CSS,
    /\.live-speech-bubble\s*\{[\s\S]*?background:\s*var\(--paper-light\)[\s\S]*?border:\s*2px solid var\(--line\)[\s\S]*?border-radius:\s*0/u,
  )
  assert.doesNotMatch(WINDOW_CSS, /live-speech-arrive/u)
  assert.match(WINDOW_JS, /recorded endpoints[^\n]*drawn-in glide/u)
  assert.match(WINDOW_JS, /pulse on a thing[^\n]*recorded use/u)
  assert.match(WINDOW_JS, /record\.detail\.status !== 'applied'/u)
  assert.match(WINDOW_JS, /safeExactText\(payload\?\.note\?\.body/u)
  assert.match(WINDOW_JS, /function liveDisplayedThings/u)
  assert.match(WINDOW_JS, /if \(!node\.dataset\.focusKey\) node\.dataset\.focusKey/u)
  assert.match(WINDOW_JS, /state\.resident && actor !== state\.resident/u)
  assert.doesNotMatch(WINDOW_CSS, /position:\s*fixed[^}]*live-|100vw[^}]*live-/iu)
})

test('the live plate states its honest timing and drawing rules in shipped code', () => {
  assert.match(WINDOW_JS, /\b(?:25000|25e3)\b/u)
  assert.match(WINDOW_JS, /\b(?:120000|12e4)\b/u)
  assert.match(WINDOW_JS, /\b(?:240000|24e4)\b/u)
  for (const value of ['60000', '300000', '1800000', '600000', '600']) {
    assert.match(WINDOW_JS, new RegExp(`\\b${value}\\b`))
  }
  assert.match(WINDOW_JS, /\/api\/events/u)
  assert.match(WINDOW_JS, /after_change_marker/u)
  assert.match(WINDOW_JS, /searchParams\.set\('within_seconds', String\(LIVE_MOVE_LIFETIME_MS \/ 1000\)\)/u)
  assert.match(WINDOW_JS, /\/api\/changes/u)
  assert.match(WINDOW_JS, /\/api\/drawing\//u)
  assert.match(WINDOW_JS, /\/api\/note\//u)
  assert.match(WINDOW_CSS, /\.live-trail/u)
  assert.match(WINDOW_CSS, /\.live-footnote-mark/u)
  assert.match(WINDOW_CSS, /\.drawing-undrawn/u)
  assert.match(
    WINDOW_CSS,
    /\.live-plot-terrain\s*>\s*\.drawing-grid\s+\.drawing-undrawn-label\s*\{[^}]*display:\s*(?:block|inline|inline-block)/u,
  )
  assert.match(
    WINDOW_CSS,
    /\.live-plot-owner\s*\{[^}]*pointer-events:\s*none/u,
    'noninteractive plot chrome must not block the place opener',
  )
  assert.doesNotMatch(WINDOW_JS, /cacheRevision/u)
  assert.match(WINDOW_JS, /function invalidateLiveCaches/u)
  assert.match(WINDOW_JS, /resident_edited[\s\S]{0,180}resident:/u)
  assert.match(WINDOW_JS, /state\.live\.drawings\[key\]\s*!==\s+loading/u)
  assert.match(WINDOW_JS, /cache:\s*force\s*\?\s*'reload'\s*:\s*'default'/u)
  assert.match(WINDOW_JS, /loadDirectory\(true, false\), 31_000/u)
  assert.match(
    WINDOW_JS,
    /function scheduleLiveClock\(\)[\s\S]*?renderLiveAging\(\)[\s\S]*?setTimeout\(scheduleLiveClock, 1000\)/u,
  )
  assert.match(WINDOW_CSS, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.live-pulse/u)
  assert.match(
    WINDOW_CSS,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.live-replay-portrait[\s\S]*?animation:\s*none/u,
  )
  assert.match(WINDOW_CSS, /@media \(forced-colors: active\)[\s\S]*?\.live-stage-shell/u)
  assert.match(
    WINDOW_CSS,
    /@media \(max-width: 54rem\)[\s\S]*?\.live-layout\s*\{[^}]*display:\s*block[^}]*\}[\s\S]*?\.live-viewport/u,
  )
})

test('drawing presentation and details expose the complete authored contract without eager history', () => {
  for (const label of ['Undrawn', 'Refused', 'In progress', 'Blank', 'Complete']) {
    assert.match(WINDOW_JS, new RegExp(label.replace(' ', '\\s+'), 'u'))
  }
  for (const field of [
    'presentation_state', 'description', 'rows', 'source', 'kind_id',
    'kind_name', 'revision', 'variant_name',
  ]) {
    assert.match(WINDOW_JS, new RegExp(`\\b${field}\\b`, 'u'))
  }
  assert.match(WINDOW_JS, /Own drawing/u)
  assert.match(WINDOW_JS, /Kind [^'"\n]*revision/u)
  assert.match(WINDOW_CSS, /\.drawing-state-label/u)
  assert.match(WINDOW_CSS, /\.drawing-provenance/u)
  assert.match(WINDOW_CSS, /\.drawing-owner-description/u)
  assert.match(WINDOW_CSS, /\.drawing-canonical-rows/u)

  assert.match(WINDOW_JS, /Show drawing history/u)
  assert.match(WINDOW_JS, /Retry drawing history/u)
  assert.match(WINDOW_JS, /Load earlier drawing revisions/u)
  assert.match(WINDOW_JS, /\/api\/drawing\/'?\s*\+[^\n]*\/history/u)
  assert.match(WINDOW_JS, /searchParams\.set\('limit'/u)
  assert.match(WINDOW_JS, /searchParams\.set\('before'/u)

  const liveRead = /async function fetchLiveDrawing[\s\S]*?\n  function drainLiveDrawingQueue/u
    .exec(WINDOW_JS)?.[0] ?? ''
  const ordinaryDetailRead = /async function ensureDetail[\s\S]*?\n  function renderDetail/u
    .exec(WINDOW_JS)?.[0] ?? ''
  assert.ok(liveRead)
  assert.ok(ordinaryDetailRead)
  assert.doesNotMatch(liveRead, /\/history/u)
  assert.doesNotMatch(ordinaryDetailRead, /\/history/u)
  assert.doesNotMatch(WINDOW_HTML, /drawing history|canonical rows|palette indices/iu)
})

test('the share link round-trips every reproducible window question', () => {
  for (const parameter of [
    'view', 'place', 'resident', 'context', 'q', 'mode', 'type', 'find', 'sleepers', 'issue',
  ]) {
    assert.match(WINDOW_JS, new RegExp(`params\\.(?:get|set)\\('${parameter}'`))
  }
  assert.match(WINDOW_JS, /nodes\.archiveQuery\.value = state\.archive\.query/)
  assert.match(WINDOW_JS, /nodes\.archiveMode\.value = state\.archive\.mode/)
  assert.match(WINDOW_JS, /nodes\.archiveType\.value = state\.archive\.type/)
  assert.match(WINDOW_JS, /state\.view === 'archive'[\s\S]{0,240}loadArchive\(true, true\)/)
  assert.match(WINDOW_JS, /loadArchive\(true, true\)/)
  assert.match(WINDOW_JS, /directorySearch:\s*state\.directorySearch/)
  assert.doesNotMatch(
    WINDOW_JS,
    /params\.get\('sleepers'\)[\s\S]{0,160}\.slice\(/,
    'sleeper expansions must not be silently capped while restoring a share link',
  )
})

test('shared sleeper expansions reject malformed or oversized state without a silent row cap', () => {
  const exports = windowClientModule as unknown as Record<string, unknown>
  assert.equal(typeof exports.parseWindowSleeperPlaceIds, 'function')
  const parse = exports.parseWindowSleeperPlaceIds as (value: string | null) => number[]
  const currentPlaceIds = Array.from({ length: 405 }, (_, index) => index + 1)

  assert.deepEqual(parse(currentPlaceIds.join(',')), currentPlaceIds)
  assert.deepEqual(parse('1,2,2,3'), [1, 2, 3])
  assert.deepEqual(parse('1,,3'), [])
  assert.deepEqual(parse('1,not-an-id,3'), [])
  assert.deepEqual(parse('9'.repeat(8_193)), [])
})

test('every active panel has one shared page heading and compliant window primitives', () => {
  const main = WINDOW_HTML.match(/<main id="city-main"[\s\S]*?<\/main>/u)?.[0] ?? ''
  assert.match(main, /<h1 class="window-title">The City Window<\/h1>/)
  assert.equal((main.match(/<h1\b/gu) ?? []).length, 1)
  for (const panel of [
    'map', 'place', 'conversations', 'happenings', 'agreements', 'archive', 'gazette',
  ]) {
    const content = main.match(new RegExp(`<section id="${panel}-panel"[\\s\\S]*?<\\/section>`))?.[0] ?? ''
    assert.match(content, /<h2\b/)
    assert.doesNotMatch(content, /<h1\b/)
  }

  assert.ok(colorContrast(cssVariable('muted'), cssVariable('paper')) >= 4.5)
  const focusBands = [cssVariable('focus'), cssVariable('focus-dark')]
  const palette = new Set(
    [...WINDOW_CSS.matchAll(/#[0-9a-f]{3}(?:[0-9a-f]{3})?\b/giu)].map(match => {
      const color = match[0].toLowerCase()
      return color.length === 4
        ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
        : color
    }),
  )
  for (const surface of palette) {
    assert.ok(
      Math.max(...focusBands.map(indicator => colorContrast(indicator, surface))) >= 3,
      `one focus band must meet 3:1 against ${surface}`,
    )
  }
  assert.match(WINDOW_CSS, /:focus-visible\s*\{[\s\S]*?outline:[\s\S]*?box-shadow:/)
  assert.match(WINDOW_CSS, /\.place-watch, \.resident-follow\s*\{[\s\S]*?min-width:\s*24px;[\s\S]*?min-height:\s*24px;/)
  assert.match(WINDOW_CSS, /\.window-title\s*\{[\s\S]*?clip-path:\s*inset\(50%\)/)
})

test('the status live region changes only when its state changes', () => {
  assert.match(WINDOW_JS, /if \(nodes\.status\.textContent !== message\) nodes\.status\.textContent = message/)
  assert.match(WINDOW_JS, /if \(nodes\.status\.dataset\.tone !== tone\) nodes\.status\.dataset\.tone = tone/)
  assert.match(WINDOW_JS, /Watching the public streets/)
  assert.doesNotMatch(WINDOW_JS, /Watching · (?:checked|no persisted changes)/)
  assert.doesNotMatch(WINDOW_JS, /setStatus\([^)]*Loading an updated public city view/)
})

test('the live window distinguishes its current bounded view from dated public snapshots', () => {
  assert.match(WINDOW_HTML, /The current bounded public view is loading\./)
  assert.match(WINDOW_HTML, /Loaded resident markers show the current bounded public view\./)
  assert.match(WINDOW_JS, /Excerpt only — the full text is not included in this bounded view\./)
  assert.match(WINDOW_JS, /Current bounded public view shows/)
  assert.match(WINDOW_JS, /The current public city view could not be read\./)
  assert.match(WINDOW_JS, /Retry reading the public city view/)
  assert.match(WINDOW_JS, /No public happening matches this selection\./)
  assert.match(WINDOW_JS, /No public agreement matches this resident selection\./)
  assert.doesNotMatch(WINDOW_JS, /No agreement in the current bounded public view matches/)
  assert.doesNotMatch(WINDOW_JS, /No happening in the current bounded public view matches/)
  assert.doesNotMatch(WINDOW_HTML, /Reading the luggage tags/iu)

  const oldVisibleCopy = [
    'latest public snapshot',
    'not included in this snapshot',
    'not currently loaded in this bounded snapshot',
    'fetched past that snapshot',
    'public city snapshot could not be read',
  ]
  for (const phrase of oldVisibleCopy) {
    assert.doesNotMatch(`${WINDOW_HTML}\n${WINDOW_JS}`, new RegExp(phrase, 'iu'), phrase)
  }

  const routeSource = windowModule.windowSnapshot.toString()
  assert.match(routeSource, /invalid public window query/iu)
  assert.doesNotMatch(routeSource, /invalid public window snapshot query/iu)
})

test('global read retry keeps total failure and stale refresh visibly distinct', () => {
  assert.match(WINDOW_JS, /function renderGlobalReadRetry\(message, tone\)/)
  assert.match(WINDOW_JS, /nodes\.status\.dataset\.tone = tone/)
  assert.match(WINDOW_JS, /renderGlobalReadRetry\(message, 'error'\)/)
  assert.match(WINDOW_JS, /Showing the previous completed view\.',\s*'stale'/)
  assert.match(WINDOW_CSS, /\.watch-state \[data-tone="error"\]::before\s*\{/)
  assert.match(WINDOW_CSS, /\.global-read-retry\s*\{/)
  assert.match(WINDOW_CSS, /\.global-read-retry:focus-visible\s*\{/)
})

test('deliberate navigation makes canonical history and refresh keeps reading state', () => {
  // Tabs, place and resident choices, and filter changes push a history
  // entry; an unchanged canonical path does not add another entry.
  assert.match(WINDOW_JS, /function navigate\(next\)/)
  assert.match(WINDOW_JS, /history\.pushState/)
  assert.match(WINDOW_JS, /if \(current === path && !window\.location\.hash\) return true/)
  assert.match(WINDOW_JS, /window\.addEventListener\('popstate', syncStateFromLocation\)/)
  assert.match(WINDOW_JS, /navigate\(\{ view, placeId, detail: null \}\)/)
  assert.match(
    WINDOW_JS,
    /function syncStateFromLocation\(\)[\s\S]*?previousReplayScope[\s\S]*?settleLiveReplays\(\)/u,
  )
  assert.match(WINDOW_JS, /placeId: safeId\(nodes\.placeFilter\.value\)[\s\S]{0,120}directorySearch: ''/)
  assert.match(WINDOW_JS, /resident: safeHandle\(nodes\.residentFilter\.value\)[\s\S]{0,120}directorySearch: ''/)
  // Expanded bodies are keyed state, and focus lands back on the rebuilt
  // control after a background refresh re-renders the DOM.
  assert.match(WINDOW_JS, /expandedBodies: \[\]/)
  assert.match(WINDOW_JS, /state\.expandedBodies\.includes\(bodyKey\)/)
  assert.match(WINDOW_JS, /function restoreFocus\(focusKey, focusFallbackKey, focusFallbackId\)/)
  assert.match(WINDOW_JS, /focus\(\{ preventScroll: true \}\)/)
  assert.match(WINDOW_JS, /data-focus-key/)
})

test('filtered happenings fetch their real slice from the server', () => {
  assert.match(WINDOW_JS, /function autoLoadFilteredHistory\(collection, filters, entry\)/)
  assert.match(WINDOW_JS, /autoLoadFilteredHistory\('events', filters, historyEntry\('events', filters\)\)/)
  // The events history request carries the active filters so a busy city
  // cannot push a watched place or followed resident out of the page.
  assert.match(WINDOW_JS, /url\.searchParams\.set\('within_place_id', String\(filters\.placeId\)\)/)
  assert.match(WINDOW_JS, /url\.searchParams\.set\('actor', filters\.resident\)/)
  // An initialized filtered view keeps learning: each snapshot refresh
  // silently refetches the newest filtered page and merges it.
  assert.match(WINDOW_JS, /function forwardRefreshHistory\(collection, filters\)/)
  assert.match(WINDOW_JS, /refreshFilteredViews\(\)/)
  // The interim load control stays focusable; disabled buttons cannot
  // receive restored focus. Arrow-key tab roving must not flood history.
  assert.match(WINDOW_JS, /aria-busy/)
  assert.doesNotMatch(WINDOW_JS, /button\.disabled = entry\.loading/)
  assert.match(WINDOW_JS, /rovingTabActivation = true/)
})

test('every event kind an emitter writes is advertised public window life', async () => {
  // The world_* kinds went missing because nothing tied emitters to the
  // label list; this scan fails the moment a new INSERT INTO events kind
  // is not also public window vocabulary.
  const { readdir, readFile } = await import('node:fs/promises')
  const sourceDir = new URL('../src/', import.meta.url)
  const written = new Set<string>()
  for (const name of await readdir(sourceDir)) {
    if (!name.endsWith('.ts')) continue
    const source = await readFile(new URL(name, sourceDir), 'utf8')
    for (const match of source.matchAll(
      /INSERT INTO events \(kind, actor, detail\)\s*(?:SELECT\s*'([a-z_]+)'|VALUES \(\s*'([a-z_]+)')/g,
    )) {
      written.add(match[1] ?? match[2] ?? '')
    }
  }
  written.delete('')
  assert.ok(written.size >= 15, `the emitter scan must find real kinds, saw ${written.size}`)
  const advertised = new Set(PUBLIC_EVENT_KINDS)
  const hidden = [...written].filter(kind => !advertised.has(kind))
  assert.deepEqual(hidden, [], 'every written event kind must be public window life')
})

test('the window covers the whole public life of the city', () => {
  assert.ok(PUBLIC_EVENT_KINDS.includes('home_set'))
  assert.ok(PUBLIC_EVENT_KINDS.includes('agreement_accession'))
  assert.ok(PUBLIC_EVENT_KINDS.includes('payment_repair'))
  assert.ok(PUBLIC_EVENT_KINDS.includes('gazette_printed'))
  assert.equal(
    PUBLIC_EVENT_LABELS.payment_repair,
    'recorded a host payment correction',
  )
  // The full enumeration is a truth surface: every kind the city writes for a
  // public act must be listed, or the window silently hides that life. The
  // world_* kinds are the market bridge — their absence hid every market sale.
  assert.deepEqual(PUBLIC_EVENT_KINDS, [
    'register', 'rotate', 'resident_edited', 'home_set', 'place_created', 'place_edited',
    'kind_invented', 'kind_revised', 'trait_coined', 'thing_created',
    'thing_crafted', 'thing_edited', 'thing_moved', 'thing_upgraded', 'thing_withdrawn',
    'laws_changed', 'action', 'effect_scheduled', 'effect_resolved', 'note', 'gazette_printed',
    'agreement', 'agreement_accession', 'agreement_sign', 'transfer',
    'transfer_offer', 'sale', 'transfer_cancel', 'world_listed', 'world_sale',
    'world_cancel', 'payment_repair', 'flag', 'moderation',
  ])
  for (const phrase of [
    'Who is standing where',
    'Conversations by place',
    'Things inside this place',
    'Recent happenings',
    'Agreements and signatures',
  ]) assert.match(WINDOW_HTML, new RegExp(phrase, 'i'))

  const source = WINDOW_JS.toLowerCase()
  for (const field of ['residents', 'notes', 'things', 'traits', 'agreements', 'signatures']) {
    assert.ok(source.includes(field), `client should render ${field}`)
  }
  assert.match(WINDOW_CSS, /@media \(max-width:/)
  assert.match(WINDOW_CSS, /prefers-reduced-motion/)
})

test('long public bodies share one honest, accessible disclosure', () => {
  assert.match(WINDOW_JS, /function renderExpandableBody\(/)
  for (const kind of ['thing', 'note', 'agreement']) {
    assert.match(WINDOW_JS, new RegExp(`renderExpandableBody\\('${kind}'`))
  }
  assert.match(WINDOW_JS, /setAttribute\('aria-expanded'/)
  assert.match(WINDOW_JS, /setAttribute\('aria-controls'/)
  assert.match(WINDOW_JS, /Excerpt only — this bounded view carries only the first part\./)
  // Notes and things complete through the existing anonymous single-item read;
  // agreements remain terminal because no matching complete read exists.
  assert.match(WINDOW_JS, /fullBodies:\s*\{\}/)
  assert.match(WINDOW_JS, /function bodyDisclosureLabel\(/)
  assert.match(WINDOW_JS, /async function loadFullBody\(/)
  assert.match(WINDOW_JS, /'\/api\/' \+ kind \+ '\/' \+ String\(id\)/)
  assert.match(WINDOW_JS, /credentials:\s*'omit'/)
  assert.match(WINDOW_JS, /kind === 'note' \? 4000 : 65536/)
  assert.match(WINDOW_JS, /Read the whole ' \+ kind/)
  assert.match(WINDOW_JS, /The complete public ' \+ kind \+ ' could not be read\./)
  assert.match(WINDOW_JS, /The full text is not served through the glass\./)
  assert.doesNotMatch(WINDOW_JS, /element\('a', 'body-full-link'/)
  assert.match(WINDOW_CSS, /\.body-full-link/)
  assert.match(WINDOW_CSS, /\.public-body\[data-expanded="false"\]/)
  assert.match(WINDOW_CSS, /-webkit-line-clamp:/)
  assert.match(WINDOW_CSS, /\.body-disclosure:focus-visible/)
})

test('public action happenings preserve meaning and collapse only consecutive repeats', () => {
  assert.match(WINDOW_JS, /SAFE_ACTIONS/)
  assert.match(WINDOW_JS, /SAFE_ACTION_STATUSES/)
  assert.match(WINDOW_JS, /tried to ' \+ actionAttempt/)
  assert.match(WINDOW_JS, /function collapseActivity\(/)
  assert.match(WINDOW_JS, /group\.count > 1/)
  assert.match(WINDOW_JS, /String\(group\.count\) \+ ' times'/)
  assert.match(WINDOW_JS, /element\('span', 'activity-count'/)
  assert.match(WINDOW_CSS, /\.activity-count\s*\{/)
})

test('the /api/window route carries honest bounded causes without exporting its private shaper', () => {
  assert.equal(Object.hasOwn(windowModule, 'publicWindowEvent'), false)
  const rows = [
    { id: 15, kind: 'gazette_printed', actor: 'the Gazette printer', detail: {
      issue_number: 7, place_id: 454, entry_count: 3,
      body: 'must not leak from the Gazette event',
    } },
    { id: 14, kind: 'payment_repair', detail: {
      action: 'credit_dispute_seller_favour', resident_id: 1,
      dispute_id: 'PP-D-PRIVATE', purchase_id: 77, reason: 'private operator context',
    } },
    { id: 13, kind: 'payment_repair', detail: {
      action: 'credit_dispute_buyer_favour', resident_id: 1,
      dispute_id: 'PP-D-PRIVATE', purchase_id: 77, reason: 'private operator context',
    } },
    { id: 12, kind: 'action', detail: {
      action_id: 112, action: 'use', status: 'failed', error: 'y'.repeat(500),
    } },
    { id: 11, kind: 'effect_resolved', detail: {
      effect_id: 111, status: 'skipped', error: 'the stored source thing no longer exists',
    } },
    { id: 10, kind: 'action', detail: {
      action_id: 110, action: 'use', status: 'failed',
      error: '  the recipe needs a lit trait here  ',
    } },
    { id: 9, kind: 'action', detail: {
      action_id: 109, action: 'move', status: 'blocked',
      error: 'a local law blocks entry into this place',
    } },
    { id: 8, kind: 'effect_resolved', detail: {
      effect_id: 108, status: 'failed', error: 'the stored target thing no longer exists',
    } },
    { id: 7, kind: 'action', detail: {
      action_id: 107, action: 'use', status: 'failed', error: 'x'.repeat(700),
    } },
    { id: 6, kind: 'action', detail: {
      action_id: 106, action: 'use', status: 'failed', error: 'unsafe\u0007cause',
    } },
    { id: 5, kind: 'action', detail: {
      action_id: 105, action: 'use', status: 'failed',
    } },
    { id: 4, kind: 'action', detail: {
      action_id: 104, action: 'use', status: 'applied', error: 'successful action leak',
    } },
    { id: 3, kind: 'action', detail: {
      action_id: 103, action: 'use', status: 'noop', error: 'no-op leak',
    } },
    { id: 2, kind: 'effect_resolved', detail: {
      effect_id: 102, status: 'applied', error: 'resolved effect leak',
    } },
    { id: 1, kind: 'note', detail: { error: 'unrelated event leak' } },
  ].map(row => ({
    ...row,
    at: `2026-08-26T12:00:${String(row.id).padStart(2, '0')}.000Z`,
    actor: 'actor' in row ? row.actor : 'tiny-lantern',
  }))
  const databaseUrl = new URL('../src/db.ts', import.meta.url).href
  const windowUrl = new URL('../src/window.ts', import.meta.url).href
  const script = `
    import { mock } from 'node:test'
    import { Hono } from 'hono'
    const eventRows = ${JSON.stringify(rows)}
    const query = async text => {
      const source = String(text)
      if (/FROM events\\s+WHERE kind = ANY/u.test(source)) return eventRows
      if (source.includes('AS conversations') && source.includes('AS events')) {
        return [{ places: 0, residents: 0, conversations: 0, things: 0,
          agreements: 0, events: eventRows.length }]
      }
      return []
    }
    const tagged = async (strings, ...values) => query(Array.from(strings).join(' '), values)
    const sql = Object.assign(tagged, { query })
    mock.module(${JSON.stringify(databaseUrl)}, {
      namedExports: { sql, runtimeDatabaseUrl: () => 'postgresql://window.test/fixture' },
    })
    const { windowSnapshot } = await import(${JSON.stringify(windowUrl)})
    const app = new Hono()
    app.get('/api/window', windowSnapshot)
    const response = await app.request('http://city.test/api/window')
    if (response.status !== 200) throw new Error('window route returned ' + response.status)
    const body = await response.json()
    process.stdout.write(JSON.stringify(body.events))
  `
  const events = JSON.parse(execFileSync(process.execPath, [
    '--no-warnings',
    '--experimental-strip-types',
    '--experimental-test-module-mocks',
    '--input-type=module',
    '--eval',
    script,
  ], { cwd: new URL('..', import.meta.url), encoding: 'utf8' })) as Array<{
    id: number
    actor: string
    kind: string
    detail: Record<string, unknown>
  }>
  const detail = (id: number) => events.find(event => event.id === id)?.detail ?? {}

  assert.deepEqual(events.find(event => event.id === 15), {
    id: 15,
    at: '2026-08-26T12:00:15.000Z',
    kind: 'gazette_printed',
    actor: 'the Gazette printer',
    detail: { place_id: 454, issue_number: 7, entry_count: 3 },
  })
  assert.deepEqual(detail(14), { action: 'credit_dispute_seller_favour' })
  assert.deepEqual(detail(13), { action: 'credit_dispute_buyer_favour' })
  assert.equal(detail(10).error, 'the recipe needs a lit trait here')
  assert.equal(detail(11).error, 'the stored source thing no longer exists')
  assert.equal(detail(9).error, 'a local law blocks entry into this place')
  assert.equal(detail(8).error, 'the stored target thing no longer exists')
  assert.equal(String(detail(7).error).length, 500)
  assert.equal(String(detail(7).error).endsWith('…'), true)
  assert.equal(detail(7).error, `${'x'.repeat(499)}…`)
  assert.equal(detail(7).error_truncated, true)
  assert.equal(detail(12).error, 'y'.repeat(500))
  assert.equal(detail(12).error_truncated, undefined)
  assert.equal(detail(6).error, 'the recorded cause could not be shown safely')
  assert.equal(detail(5).error, undefined)
  for (const id of [4, 3, 2, 1]) assert.equal(detail(id).error, undefined)
})

test('map branches expose accessible lazy-load and collapse controls', () => {
  assert.match(WINDOW_JS, /collapsedPlaceIds:\s*\[\]/)
  assert.match(WINDOW_JS, /element\('button', 'place-disclosure'/)
  assert.match(WINDOW_JS, /setAttribute\('aria-expanded'/)
  assert.match(WINDOW_JS, /setAttribute\('aria-controls'/)
  assert.match(WINDOW_JS, /place\.places\s*>\s*0/)
  assert.match(WINDOW_JS, /children\.hidden = !expanded/)
  assert.match(WINDOW_JS, /collapsedPlaceIds\.filter\(/)
  assert.match(WINDOW_JS, /\[\.\.\.state\.collapsedPlaceIds, placeId\]/)
  assert.doesNotMatch(WINDOW_JS, /collapsedPlaceIds\.(?:add|delete|push|splice)\(/)
  assert.match(WINDOW_CSS, /\.place-disclosure:focus-visible/)
})

test('the shipped window requests bounded map and resident pages', () => {
  assert.match(WINDOW_JS, /searchParams\.set\('view', 'outline'\)/)
  assert.match(WINDOW_JS, /new URL\('\/api\/map'/)
  assert.match(WINDOW_JS, /searchParams\.set\('parent_id', String\(/)
  assert.match(WINDOW_JS, /searchParams\.set\('subplace_limit', '25'\)/)
  assert.match(WINDOW_JS, /searchParams\.set\('before_subplace_id'/)
  assert.match(WINDOW_JS, /new URL\('\/api\/residents'/)
  assert.match(WINDOW_JS, /searchParams\.set\('view', 'presence'\)/)
  assert.match(WINDOW_JS, /searchParams\.set\('limit', '25'\)/)
  assert.match(WINDOW_JS, /searchParams\.set\('before_id'/)
})

test('partial navigation is explicit, retryable, and keyboard-readable', () => {
  assert.match(WINDOW_HTML, /id="resident-page"/)
  assert.match(WINDOW_JS, /currently loaded/i)
  assert.match(WINDOW_JS, /Load more residents/)
  assert.match(WINDOW_JS, /Retry loading residents/)
  assert.match(WINDOW_JS, /Retry loading places inside/)
  assert.match(WINDOW_JS, /No (?:more )?(?:places|residents)[^\n]*loaded/i)
  assert.match(WINDOW_JS, /aria-busy/)
  assert.match(WINDOW_JS, /data-focus-key/)
})

test('window history queries accept only one safe value for each supported filter', () => {
  const exports = windowModule as unknown as Record<string, unknown>
  assert.equal(typeof exports.parseWindowHistoryQuery, 'function')
  const parse = exports.parseWindowHistoryQuery as (
    queries: Record<string, string[]>,
  ) => Record<string, unknown> | null

  assert.deepEqual(parse({ collection: ['notes'] }), {
    collection: 'notes', beforeId: null, limit: 10, placeId: null, resident: null,
    context: false, includeDescendants: false,
  })
  assert.deepEqual(parse({
    collection: ['things'], before_id: ['91'], limit: ['12'],
    place_id: ['7'], resident: ['tiny-lantern'],
  }), {
    collection: 'things', beforeId: 91, limit: 12, placeId: 7, resident: 'tiny-lantern',
    context: false, includeDescendants: false,
  })
  assert.deepEqual(parse({
    collection: ['things'], within_place_id: ['7'], resident: ['tiny-lantern'],
  }), {
    collection: 'things', beforeId: null, limit: 10, placeId: 7, resident: 'tiny-lantern',
    context: false, includeDescendants: true,
  })
  assert.deepEqual(parse({ collection: ['agreements'], resident: ['tiny-lantern'] }), {
    collection: 'agreements', beforeId: null, limit: 10, placeId: null, resident: 'tiny-lantern',
    context: false, includeDescendants: false,
  })
  assert.deepEqual(parse({
    collection: ['notes'], resident: ['tiny-lantern'], context: ['place'],
  }), {
    collection: 'notes', beforeId: null, limit: 10, placeId: null, resident: 'tiny-lantern',
    context: true, includeDescendants: false,
  })
  assert.deepEqual(parse({
    collection: ['notes'], resident: ['tiny-lantern'], context: ['place'], place_id: ['7'],
  }), {
    collection: 'notes', beforeId: null, limit: 10, placeId: 7, resident: 'tiny-lantern',
    context: true, includeDescendants: false,
  })
  // A context page carries neighbors as well as own notes, so its page size
  // is bounded to keep the whole page inside the public row cap.
  assert.deepEqual(parse({
    collection: ['notes'], resident: ['tiny-lantern'], context: ['place'], limit: ['200'],
  }), {
    collection: 'notes', beforeId: null, limit: 39, placeId: null, resident: 'tiny-lantern',
    context: true, includeDescendants: false,
  })
  assert.deepEqual(parse({
    collection: ['notes'], limit: ['200'],
  }), {
    collection: 'notes', beforeId: null, limit: 200, placeId: null, resident: null,
    context: false, includeDescendants: false,
  })

  for (const unsafe of [
    { collection: ['events'] },
    { collection: ['notes', 'things'] },
    { collection: ['notes'], limit: ['0'] },
    { collection: ['notes'], limit: ['201'] },
    { collection: ['notes'], before_id: ['1.5'] },
    { collection: ['notes'], place_id: ['-2'] },
    { collection: ['notes'], place_id: ['2147483648'] },
    { collection: ['notes'], resident: ['not safe!'] },
    { collection: ['agreements'], place_id: ['7'] },
    { collection: ['agreements'], within_place_id: ['7'] },
    { collection: ['notes'], place_id: ['7'], within_place_id: ['7'] },
    { collection: ['notes'], within_place_id: ['-2'] },
    { collection: ['notes'], within_place_id: ['2147483648'] },
    { collection: ['notes'], nonce: ['cache-bust'] },
    { collection: ['notes'], context: ['place'] },
    { collection: ['notes'], resident: ['tiny-lantern'], context: ['thread'] },
    { collection: ['notes'], resident: ['tiny-lantern'], context: ['place', 'place'] },
    { collection: ['things'], resident: ['tiny-lantern'], context: ['place'] },
    { collection: ['agreements'], resident: ['tiny-lantern'], context: ['place'] },
  ]) assert.equal(parse(unsafe), null)
})

test('window collection statements enforce limit plus one without client SQL identifiers', () => {
  const exports = windowModule as unknown as Record<string, unknown>
  assert.equal(typeof exports.windowCollectionStatement, 'function')
  const statement = exports.windowCollectionStatement as (
    options: Record<string, unknown>,
  ) => { text: string; values: unknown[] }
  const notes = statement({
    collection: 'notes', beforeId: 91, limit: 50, placeId: 7, resident: 'tiny-lantern',
  })
  assert.match(notes.text, /FROM notes note/i)
  assert.match(notes.text, /note\.id < \$1/i)
  assert.match(notes.text, /ORDER BY note\.id DESC/i)
  assert.match(notes.text, /LIMIT \$4/i)
  assert.deepEqual(notes.values, [91, 7, 'tiny-lantern', 51])
  assert.equal(notes.text.includes('tiny-lantern'), false)
  assert.equal(notes.text.includes('collection'), false)

  const insideNotes = statement({
    collection: 'notes', beforeId: 91, limit: 50, placeId: 7, resident: null,
    includeDescendants: true,
  })
  assert.match(insideNotes.text, /WITH RECURSIVE selected_places/i)
  assert.match(insideNotes.text, /child\.parent_id = selected\.id/i)
  assert.match(insideNotes.text, /note\.place_id IN \(SELECT id FROM selected_places\)/i)
  assert.deepEqual(insideNotes.values, [91, 7, null, 51])

  const things = statement({
    collection: 'things', beforeId: null, limit: 50, placeId: null, resident: null,
  })
  assert.match(things.text, /FROM things thing/i)
  assert.match(things.text, /thing\.open_to_use/i)
  assert.match(things.text, /thing\.maker_id/i)
  assert.match(things.text, /maker\.handle AS made_by/i)
  assert.match(things.text, /thing\.owner_id AS owner_id/i)
  assert.match(things.text, /thing\.owner_id AS current_owner_id/i)
  assert.match(things.text, /current_owner\.handle AS current_owner/i)
  assert.match(things.text, /current_owner\.handle = \$3::text/i)
  assert.match(things.text, /ORDER BY thing\.id DESC/i)
  assert.deepEqual(things.values, [null, null, null, 51])

  const agreements = statement({
    collection: 'agreements', beforeId: 61, limit: 50, placeId: null, resident: 'tiny-lantern',
  })
  assert.match(agreements.text, /FROM agreements agreement/i)
  assert.match(agreements.text, /ORDER BY id DESC LIMIT \$3/i)
  assert.match(agreements.text, /agreement_accession_openings/i)
  assert.match(agreements.text, /AS accession_open/i)
  assert.match(agreements.text, /AS party_count/i)
  assert.match(agreements.text, /AS acceded/i)
  assert.match(agreements.text, /LIMIT 32/i)
  assert.deepEqual(agreements.values, [61, 'tiny-lantern', 51])

  // The context variant drives the page from the resident's own notes and
  // carries bounded same-place neighbors on each side.
  const context = statement({
    collection: 'notes', beforeId: 91, limit: 25, placeId: null,
    resident: 'tiny-lantern', context: true,
  })
  assert.match(context.text, /WITH resident_notes AS/i)
  assert.match(context.text, /author\.handle = \$3::text/i)
  assert.match(context.text, /CROSS JOIN LATERAL/i)
  assert.match(context.text, /DISTINCT ON \(ctx\.id\)/i)
  assert.match(context.text, /neighbor\.id < own\.id/i)
  assert.match(context.text, /neighbor\.id > own\.id/i)
  assert.match(context.text, /LIMIT 2\)/)
  assert.match(context.text, /UNION ALL/i)
  // Two cursor-safety invariants: context never contains the followed
  // resident (an own note returning as context would freeze the cursor and
  // bury the note under it), and context anchors only to the rows this page
  // keeps, never to the trimmed lookahead note.
  assert.match(context.text, /ctx_author\.handle <> \$3::text/i)
  assert.match(context.text, /row_number\(\) OVER \(ORDER BY note\.id DESC\) AS own_position/i)
  assert.match(context.text, /page_notes AS \(\s*SELECT \* FROM resident_notes WHERE own_position <= \$5::integer/i)
  assert.match(context.text, /FROM page_notes own/i)
  assert.deepEqual(context.values, [91, null, 'tiny-lantern', 26, 25])
})

test('window histories merge immutably, dedupe by id, and stay newest first', () => {
  const exports = windowClientModule as unknown as Record<string, unknown>
  assert.equal(typeof exports.mergeWindowRows, 'function')
  const merge = exports.mergeWindowRows as (
    current: readonly Readonly<Record<string, unknown>>[],
    incoming: readonly Readonly<Record<string, unknown>>[],
  ) => Array<Record<string, unknown>>
  const current = Object.freeze([
    Object.freeze({ id: 3, body: 'old copy' }),
    Object.freeze({ id: 2, body: 'middle' }),
  ])
  const incoming = Object.freeze([
    Object.freeze({ id: 4, body: 'newest' }),
    Object.freeze({ id: 3, body: 'fresh copy' }),
    Object.freeze({ id: 1, body: 'oldest' }),
  ])

  const merged = merge(current, incoming)
  assert.deepEqual(merged.map(row => row.id), [4, 3, 2, 1])
  assert.equal(merged.find(row => row.id === 3)?.body, 'fresh copy')
  assert.deepEqual(current.map(row => row.id), [3, 2])
  assert.deepEqual(incoming.map(row => row.id), [4, 3, 1])
})

test('resident pages merge immutably by joined time and use id only as a tie-breaker', () => {
  const exports = windowClientModule as unknown as Record<string, unknown>
  assert.equal(typeof exports.mergeResidentRows, 'function')
  const merge = exports.mergeResidentRows as (
    current: readonly Readonly<{ id: number, joined_at: Date }>[],
    incoming: readonly Readonly<{ id: number, joined_at: Date }>[],
  ) => Array<{ id: number, joined_at: Date }>
  const current = Object.freeze([
    Object.freeze({ id: 90, joined_at: new Date('2026-08-12T00:00:00.000Z') }),
    Object.freeze({ id: 7, joined_at: new Date('2026-08-14T00:00:00.000Z') }),
  ])
  const incoming = Object.freeze([
    Object.freeze({ id: 2, joined_at: new Date('2026-08-16T00:00:00.000Z') }),
    Object.freeze({ id: 100, joined_at: new Date('2026-08-15T00:00:00.000Z') }),
    Object.freeze({ id: 8, joined_at: new Date('2026-08-14T00:00:00.000Z') }),
  ])

  const merged = merge(current, incoming)
  assert.deepEqual(merged.map(row => row.id), [2, 100, 8, 7, 90])
  assert.deepEqual(current.map(row => row.id), [90, 7])
  assert.deepEqual(incoming.map(row => row.id), [2, 100, 8])
})

test('every paged window view has an accessible older-history surface', () => {
  for (const id of [
    'place-things-page', 'place-notes-page', 'conversation-page',
    'happenings-page', 'agreements-page',
  ]) {
    const matches = [...WINDOW_HTML.matchAll(new RegExp(`id="${id}"`, 'g'))]
    assert.equal(matches.length, 1, `${id} should appear exactly once in the window markup`)
  }
  assert.match(WINDOW_JS, /payload\.pages/)
  assert.match(WINDOW_JS, /collection.*notes/)
  assert.match(WINDOW_JS, /collection.*things/)
  assert.match(WINDOW_JS, /\/api\/events/)
  assert.match(WINDOW_JS, /'Loading ' \+ older \+ label/)
  assert.match(WINDOW_JS, /'Retry loading ' \+ older \+ label/)
  assert.match(WINDOW_JS, /entry\.initialized \? 'older ' : ''/)
  assert.match(WINDOW_CSS, /\.history-page/)
})

test('all-place conversations preserve the server newest-first order', () => {
  assert.match(WINDOW_JS, /const notes = entry\.rows/)
  assert.match(WINDOW_JS, /noteCard\(note, placeOf\(note\.place_id\)\)/)
  assert.doesNotMatch(WINDOW_JS, /const placeIds = \[\.\.\.new Set\(notes\.map/)
})

test('a followed resident defaults to their own history and keeps room context explicit', () => {
  assert.match(WINDOW_HTML, /Conversation question/)
  assert.match(WINDOW_JS, /What ' \+ state\.resident \+ ' said/)
  assert.match(WINDOW_JS, /What was said around ' \+ state\.resident/)
  assert.match(WINDOW_JS, /context: Boolean\(state\.resident && state\.conversationContext\)/)
  assert.doesNotMatch(WINDOW_JS, /context: Boolean\(state\.resident\)/)
  assert.match(WINDOW_JS, /autoLoadFilteredHistory\('notes', filters, historyEntry\('notes', filters\)\)/)
  assert.match(WINDOW_JS, /url\.searchParams\.set\('context', 'place'\)/)
  assert.match(WINDOW_JS, /filters\.context \? '25' : '50'/)
  assert.match(WINDOW_JS, /context-note/)
  // Neighbours are chosen by position in the room, not by clock, so the mark
  // states the measured distance instead of asserting a closeness the
  // selection rule never guarantees.
  assert.match(WINDOW_JS, /function relativeGap\(/)
  assert.match(WINDOW_JS, /relativeGap\(note\.created_at, anchor\.created_at\)/)
  assert.doesNotMatch(WINDOW_JS, /same room, said around then/)
  assert.match(WINDOW_CSS, /\.context-note/)
  assert.match(WINDOW_CSS, /\.context-mark/)
})

test('relativeGap reports the real distance in both directions', () => {
  // Exercised through the shipped source so the assertion tracks the string
  // the reader actually sees rather than a copy of it.
  const source = /function relativeGap\(fromIso, toIso\) \{[\s\S]*?\n  \}/.exec(WINDOW_JS)
  assert.ok(source, 'relativeGap must be present in the client')
  const relativeGap = new Function('return ' + source[0])() as
    (from: string, to: string) => string
  const anchor = '2026-08-18T21:00:00.000Z'
  assert.equal(relativeGap('2026-08-18T21:00:20.000Z', anchor), 'same room · moments apart')
  assert.equal(relativeGap('2026-08-18T21:25:00.000Z', anchor), 'same room · 25m later')
  assert.equal(relativeGap('2026-08-18T20:35:00.000Z', anchor), 'same room · 25m earlier')
  // The case that prompted the change: a quiet room put nearly a day between
  // a note and the one before it, and the old mark still said "around then".
  assert.equal(relativeGap('2026-08-18T00:12:00.000Z', anchor), 'same room · 21h earlier')
  assert.equal(relativeGap('2026-08-15T21:00:00.000Z', anchor), 'same room · 3d earlier')
  assert.equal(relativeGap('nonsense', anchor), 'same room')
})

test('every printed handle is followable, not only the roster', () => {
  assert.match(WINDOW_JS, /function residentNode\(handle, className, focusKey\)/)
  // The complete directory is enough to make a printed handle useful even
  // before that resident's focused presence row has been fetched.
  assert.doesNotMatch(WINDOW_JS,
    /const known = state\.snapshot &&\s*state\.snapshot\.residents\.some/)
  assert.match(WINDOW_JS, /if \(!known\) return element\('span', className, handle\)/)
  for (const [className, key] of [
    ['note-author', 'note-author:'],
    ['thing-maker', 'thing-maker:'],
    ['thing-owner', 'thing-owner:'],
    ['activity-actor', 'activity-actor:'],
    ['agreement-author', 'agreement-author:'],
  ]) {
    assert.match(WINDOW_JS, new RegExp(`residentNode\\([^)]*'${className}'`))
    assert.match(WINDOW_JS, new RegExp(`'${key}'`))
  }
  assert.match(WINDOW_CSS, /\.resident-follow-inline/)
  assert.match(WINDOW_CSS, /\.resident-follow-inline:focus-visible/)
})

test('directory search keeps a bounded menu and reports its exact total', () => {
  const exports = windowClientModule as unknown as Record<string, unknown>
  assert.equal(typeof exports.pageWindowDirectorySearch, 'function')
  const pageSearch = exports.pageWindowDirectorySearch as (
    places: Array<{ id: number, name: string, path: string }>,
    residents: Array<{ id: number, handle: string }>,
    query: string,
    limit?: number,
  ) => {
    results: Array<{ kind: string }>
    total: number
    placeCount: number
    residentCount: number
    hasMore: boolean
  }
  const places = Array.from({ length: 21 }, (_, index) => ({
    id: index + 1,
    name: `room-${index + 1}`,
    path: `world / room-${index + 1}`,
  }))

  const atBound = pageSearch(places.slice(0, 20), [], 'room', 20)
  assert.deepEqual({
    shown: atBound.results.length,
    total: atBound.total,
    places: atBound.placeCount,
    residents: atBound.residentCount,
    hasMore: atBound.hasMore,
  }, { shown: 20, total: 20, places: 20, residents: 0, hasMore: false })

  const pastBound = pageSearch(places, [], 'room', 20)
  assert.deepEqual({
    shown: pastBound.results.length,
    total: pastBound.total,
    places: pastBound.placeCount,
    residents: pastBound.residentCount,
    hasMore: pastBound.hasMore,
  }, { shown: 20, total: 21, places: 21, residents: 0, hasMore: true })
  assert.match(WINDOW_JS, /Showing the first /)
  assert.match(WINDOW_JS, /currently loaded fallback/)
  assert.match(WINDOW_JS, /more citywide matches may exist/)
})

test('thing cards and Archive results name maker and current owner separately', () => {
  assert.match(WINDOW_JS, /safeHandle\(rawResult\.made_by\)/)
  assert.match(WINDOW_JS, /safeHandle\(rawResult\.current_owner \?\? rawResult\.owner\)/)
  assert.match(WINDOW_JS, /made by /)
  assert.match(WINDOW_JS, /currently owned by /)
})

test('bounded map and window rooms carry a short purpose and ordered body-free front matter', () => {
  const purpose = 'p'.repeat(280)
  const frontMatter = [41, 42, 43, 44].map((id, index) => ({
    id,
    type: 'thing',
    name: `room heading ${index + 1}`,
    body: `body ${index + 1} must stay behind its direct link`,
    snippet: `snippet ${index + 1} must not cross the glass`,
    body_text_bytes: 20 + index,
    maker_id: 6,
    made_by: 'old-maker',
    owner_id: 7,
    current_owner_id: 7,
    current_owner: 'tiny-lantern',
    owner: 'tiny-lantern',
  }))
  const places = windowModule.publicPlaceTree([{
    id: 80,
    parent_id: null,
    name: 'reading-room',
    owner: 'tiny-lantern',
    description: 'A full place description stays behind the focused public place read.',
    purpose,
    front_matter: frontMatter,
    places: 0,
    things: 4,
    notes: 0,
  }, {
    id: 81,
    parent_id: null,
    name: 'quiet-room',
    owner: 'tiny-lantern',
    places: 0,
    things: 0,
    notes: 0,
  }, {
    id: 82,
    parent_id: null,
    name: 'overlong-purpose-room',
    owner: 'tiny-lantern',
    purpose: 'x'.repeat(281),
    front_matter: [],
    places: 0,
    things: 0,
    notes: 0,
  }, {
    id: 83,
    parent_id: null,
    name: 'front-matter-shrank-room',
    owner: 'tiny-lantern',
    purpose: '',
    front_matter: [frontMatter[2]],
    places: 0,
    things: 1,
    notes: 0,
  }]) as unknown as Array<Record<string, unknown>>

  const readingRoom = places.find(place => place.id === 80)
  assert.equal(readingRoom?.purpose, purpose)
  assert.ok(readingRoom && !Object.hasOwn(readingRoom, 'description'))
  assert.ok(Array.isArray(readingRoom?.front_matter))
  const headings = readingRoom?.front_matter as Array<Record<string, unknown>>
  assert.equal(headings.length, 3)
  assert.deepEqual(
    headings.map(heading => ({
      id: heading.id,
      name: heading.name,
      body_text_bytes: heading.body_text_bytes,
      made_by: heading.made_by,
      current_owner: heading.current_owner,
    })),
    frontMatter.slice(0, 3).map(heading => ({
      id: heading.id,
      name: heading.name,
      body_text_bytes: heading.body_text_bytes,
      made_by: heading.made_by,
      current_owner: heading.current_owner,
    })),
  )
  assert.ok(headings.every(heading => !('body' in heading) && !('snippet' in heading)))
  assert.equal(places.find(place => place.id === 81)?.purpose, '')
  assert.deepEqual(places.find(place => place.id === 81)?.front_matter, [])
  const boundedPurpose = places.find(place => place.id === 82)?.purpose
  assert.equal(typeof boundedPurpose, 'string')
  assert.ok((boundedPurpose as string).length <= 280)
  const shrunkFrontMatter = places.find(place => place.id === 83)?.front_matter
  assert.ok(Array.isArray(shrunkFrontMatter))
  assert.deepEqual(
    (shrunkFrontMatter as Array<Record<string, unknown>>).map(heading => heading.id),
    [43],
  )
})

test('the selected-place panel identifies owner choices and links front matter without fetching bodies', () => {
  assert.match(WINDOW_JS, /owner-written purpose/iu)
  assert.match(WINDOW_JS, /owner-chosen front matter/iu)
  assert.match(WINDOW_JS, /rawPlace\.purpose/)
  assert.match(WINDOW_JS, /rawPlace\.front_matter/)
  assert.match(WINDOW_JS, /place\.purpose/)
  assert.match(WINDOW_JS, /place\.front_matter/)
  assert.match(WINDOW_JS, /place\.front_matter\.map\(/)
  assert.match(WINDOW_JS, /link\.href\s*=\s*['"]\/window\/['"]\s*\+\s*kind\s*\+\s*['"]\/['"]\s*\+\s*String\(id\)/)
  assert.match(WINDOW_JS, /made by[\s\S]{0,600}currently owned by[\s\S]{0,600}UTF-8 bytes/iu)
  assert.doesNotMatch(WINDOW_JS, /front_matter\.(?:sort|toSorted|reverse|splice)\(/)
  assert.doesNotMatch(WINDOW_JS, /new URL\(\s*['"]\/api\/thing\//u)
  assert.doesNotMatch(WINDOW_JS, /fetch\s*\([^)]*\/api\/thing\//u)
})

test('a followed view names which conversation question its fetched rows answer', () => {
  assert.match(WINDOW_HTML, /Conversation question/)
  assert.match(WINDOW_JS, /What ' \+ state\.resident \+ ' said/)
  assert.match(WINDOW_JS, /What was said around ' \+ state\.resident/)
  assert.match(WINDOW_JS, /followedRows/)
})

test('snapshot row shapers reject malformed public data', () => {
  const exports = windowModule as unknown as Record<string, unknown>
  assert.equal(typeof exports.publicWindowResidents, 'function')
  assert.equal(typeof exports.publicWindowNotes, 'function')
  assert.equal(typeof exports.publicWindowThings, 'function')
  assert.equal(typeof exports.publicWindowAgreements, 'function')

  const residents = (exports.publicWindowResidents as (rows: unknown[]) => unknown[])([
    { id: 7, handle: 'tiny-lantern', current_place_id: 2, joined_at: '2026-08-11T00:00:00Z' },
    { id: 8, handle: '<script>', current_place_id: 2, joined_at: '2026-08-11T00:00:00Z' },
    { id: 9, handle: 'long-gone', current_place_id: 195, joined_at: '2026-07-01T00:00:00Z', asleep: true },
    { id: 10, handle: 'odd-flag', current_place_id: 2, joined_at: '2026-08-11T00:00:00Z', asleep: 'yes' },
  ])
  assert.deepEqual(residents, [{
    id: 7,
    handle: 'tiny-lantern',
    current_place_id: 2,
    joined_at: '2026-08-11T00:00:00.000Z',
    asleep: false,
  }, {
    id: 9,
    handle: 'long-gone',
    current_place_id: 195,
    joined_at: '2026-07-01T00:00:00.000Z',
    asleep: true,
  }, {
    id: 10,
    handle: 'odd-flag',
    current_place_id: 2,
    joined_at: '2026-08-11T00:00:00.000Z',
    asleep: false,
  }])

  const notes = (exports.publicWindowNotes as (rows: unknown[]) => unknown[])([
    { id: 1, place_id: 2, author: 'tiny-lantern', body: 'hello\ncity', created_at: '2026-08-11T00:00:00Z' },
    { id: 2, place_id: 2, author: 'tiny-lantern', body: 'bad\u202Etext', created_at: '2026-08-11T00:00:00Z' },
    { id: 3, place_id: 2, author: 'tiny-lantern', body: 'the inn\u00E2\u20AC\u2122s ledger', created_at: '2026-08-11T00:00:00Z' },
  ])
  assert.deepEqual(notes, [{
    id: 1,
    place_id: 2,
    author: 'tiny-lantern',
    body: 'hello\ncity',
    created_at: '2026-08-11T00:00:00.000Z',
    moderated: false,
  }])

  const things = (exports.publicWindowThings as (rows: unknown[]) => unknown[])([{
    id: 41,
    place_id: 2,
    name: 'porch lantern',
    body: 'warm light',
    maker_id: 6,
    made_by: 'old-maker',
    owner_id: 7,
    current_owner_id: 7,
    current_owner: 'tiny-lantern',
    owner: 'tiny-lantern',
    open_to_use: true,
    kind: 'lantern',
    traits: ['glowing', '<script>'],
    created_at: '2026-08-11T00:00:00Z',
  }, {
    id: 42,
    place_id: 2,
    name: 'bad provenance',
    body: 'must not enter the window',
    maker_id: 6,
    made_by: '<script>',
    owner_id: 7,
    current_owner_id: 7,
    current_owner: 'tiny-lantern',
    owner: 'tiny-lantern',
    open_to_use: false,
    kind: null,
    traits: [],
    created_at: '2026-08-11T00:00:00Z',
  }, {
    id: 43,
    place_id: 2,
    name: 'mismatched owner aliases',
    body: 'must not enter the window',
    maker_id: 6,
    made_by: 'old-maker',
    owner_id: 8,
    current_owner_id: 7,
    current_owner: 'tiny-lantern',
    owner: 'tiny-lantern',
    open_to_use: false,
    kind: null,
    traits: [],
    created_at: '2026-08-11T00:00:00Z',
  }])
  assert.deepEqual(things, [{
    id: 41,
    place_id: 2,
    name: 'porch lantern',
    body: 'warm light',
    maker_id: 6,
    made_by: 'old-maker',
    owner_id: 7,
    current_owner_id: 7,
    current_owner: 'tiny-lantern',
    owner: 'tiny-lantern',
    open_to_use: true,
    kind: 'lantern',
    traits: ['glowing'],
    created_at: '2026-08-11T00:00:00.000Z',
    moderated: false,
    kind_moderated: false,
  }])

  const agreements = (exports.publicWindowAgreements as (rows: unknown[]) => unknown[])([{
    id: 61,
    body: 'we keep the square open',
    created_by: 'tiny-lantern',
    parties: ['tiny-lantern', 'neighbor'],
    acceded: ['neighbor', 'never-a-party', '<script>'],
    signatures: ['tiny-lantern', '<script>'],
    open: true,
    accession_open: true,
    created_at: '2026-08-11T00:00:00Z',
  }])
  assert.deepEqual(agreements, [{
    id: 61,
    body: 'we keep the square open',
    created_by: 'tiny-lantern',
    parties: ['tiny-lantern', 'neighbor'],
    acceded: ['neighbor'],
    signatures: ['tiny-lantern'],
    open: true,
    accession_open: true,
    created_at: '2026-08-11T00:00:00.000Z',
    moderated: false,
  }])

  assert.match(WINDOW_JS, /Closed to later signers/)
  assert.match(WINDOW_JS, /Open to later signers/)
})

test('historical credential text is redacted without hiding window records', () => {
  const credentials = [
    `1f3d9_sk_${'a1'.repeat(24)}`,
    `1f3d9_at_${'b2'.repeat(32)}`,
    `1f3d9_rt_${'c3'.repeat(32)}`,
    `1f3d9_ac_${'d4'.repeat(32)}`,
  ]

  for (const [index, credential] of credentials.entries()) {
    const [note] = windowModule.publicWindowNotes([{
      id: 71 + index,
      place_id: 2,
      author: 'tiny-lantern',
      body: `historical note ${credential}`,
      created_at: '2026-08-11T00:00:00Z',
    }])
    const [thing] = windowModule.publicWindowThings([{
      id: 81 + index,
      place_id: 2,
      name: credential,
      body: credential,
      maker_id: 6,
      made_by: 'old-maker',
      owner_id: 7,
      current_owner_id: 7,
      current_owner: 'tiny-lantern',
      owner: 'tiny-lantern',
      open_to_use: false,
      kind: credential,
      traits: [credential],
      created_at: '2026-08-11T00:00:00Z',
    }])

    assert.equal(note?.id, 71 + index)
    assert.equal(note?.body, PUBLIC_CREDENTIAL_REDACTION)
    assert.equal(thing?.id, 81 + index)
    assert.equal(thing?.name, PUBLIC_CREDENTIAL_REDACTION)
    assert.equal(thing?.body, PUBLIC_CREDENTIAL_REDACTION)
    assert.equal(thing?.kind, PUBLIC_CREDENTIAL_REDACTION)
    assert.deepEqual(thing?.traits, [PUBLIC_CREDENTIAL_REDACTION])
  }
})

test('agreement party previews declare when later signers are not shown', () => {
  const parties = Array.from({ length: 35 }, (_, index) => `member-${String(index).padStart(2, '0')}`)
  const acceded = parties.slice(30)
  const [agreement] = windowModule.publicWindowAgreements([{
    id: 62,
    body: 'the whole city may sign in time',
    created_by: 'tiny-lantern',
    parties,
    party_count: parties.length,
    acceded,
    signatures: acceded,
    open: true,
    accession_open: true,
    created_at: '2026-08-11T00:00:00Z',
  }])

  assert.equal(agreement?.parties.length, 32)
  assert.equal(agreement?.party_count, 35)
  assert.equal(agreement?.parties_truncated, true)
  assert.deepEqual(agreement?.acceded, ['member-30', 'member-31'])
  assert.match(WINDOW_JS, /more not shown here/)
  assert.match(WINDOW_JS, /agreement\.parties_truncated/)
  assert.match(WINDOW_JS, /Party preview is incomplete/)
})

test('the bounded window keeps loaded navigation while fresh outline pages merge immutably', () => {
  assert.match(WINDOW_JS, /mergeWindowRows\([^\n]*residents/i)
  assert.match(WINDOW_JS, /mergeWindowRows\([^\n]*(?:children|subplaces)/i)
  assert.match(WINDOW_JS, /collapsedPlaceIds/)
  assert.match(WINDOW_JS, /restoreFocus\(focusKey, focusFallbackKey, focusFallbackId\)/)
  assert.match(WINDOW_JS, /data-focus-key/u)
  assert.match(WINDOW_JS, /live-record:/u)
  assert.match(WINDOW_JS, /live-thing:/u)
  assert.match(WINDOW_JS, /live-history-opening-retry/u)
  assert.match(WINDOW_JS, /live-history-stream-retry/u)
  assert.doesNotMatch(WINDOW_JS, /(?:residents|subplaces|children)\.(?:push|splice|sort)\(/)
})

test('bounded navigation stays honest and keyboard-safe at page boundaries', () => {
  assert.doesNotMatch(WINDOW_JS, /nodes\.status\?\.removeAttribute\('role'\)/)
  assert.match(WINDOW_JS, /no public place was found/i)
  assert.match(WINDOW_JS, /Retry loading this place/)
  assert.match(WINDOW_JS, /no narrow place-specific presence read/i)
  assert.doesNotMatch(WINDOW_JS, /focused metadata loaded; contents are not currently loaded/i)
  assert.match(WINDOW_JS, /seenBeforeIds/)
  assert.match(WINDOW_JS, /seenBeforeSubplaceIds/)
  assert.match(WINDOW_JS, /focusFallbackKey/)
  assert.match(WINDOW_JS, /forwardReconcile/i)
})

test('the ownerless world remains visible without admitting ownerless ordinary places', () => {
  const places = windowModule.publicPlaceTree([{
    id: 1,
    parent_id: null,
    name: 'the world',
    owner: null,
    places: 2,
    things: 0,
    notes: 0,
  }, {
    id: 2,
    parent_id: 1,
    name: 'possibility',
    owner: 'tiny-lantern',
    places: 0,
    things: 0,
    notes: 0,
  }, {
    id: 3,
    parent_id: 1,
    name: 'ownerless-room',
    owner: null,
    places: 0,
    things: 0,
    notes: 0,
  }, {
    id: 4,
    parent_id: null,
    name: 'ownerless-impostor',
    owner: null,
    places: 0,
    things: 0,
    notes: 0,
  }])

  assert.equal(places.length, 1)
  assert.equal(places[0]?.name, 'the world')
  assert.equal(places[0]?.owner, null)
  assert.deepEqual(places[0]?.children.map(place => place.id), [2])

  const legacyRoots = windowModule.publicPlaceTree([{
    id: 5, parent_id: null, name: 'the-mainland', owner: 'founder',
    places: 0, things: 0, notes: 0,
  }])
  assert.equal(legacyRoots[0]?.owner, 'founder')

  assert.match(WINDOW_JS, /unowned · transit only/)
  assert.match(WINDOW_JS, /nobody owns it · transit only/)
})

test('thing traits stay pinned to each thing current kind revision', () => {
  const exports = windowModule as unknown as Record<string, unknown>
  assert.equal(typeof exports.mergeWindowThingTraits, 'function')
  const merge = exports.mergeWindowThingTraits as (
    things: Array<Record<string, unknown>>,
    facets: Array<Record<string, unknown>>,
  ) => Array<Record<string, unknown>>
  const things = merge([
    { id: 41, kind_id: 3, current_revision: 1, traits: ['wrong'] },
    { id: 42, kind_id: 3, current_revision: 2, traits: ['wrong'] },
  ], [
    { id: 3, revision: 1, traits: ['glowing'] },
    { id: 3, revision: 2, traits: ['glowing', 'weatherproof'] },
  ])
  assert.deepEqual(things.map(thing => thing.traits), [
    ['glowing'],
    ['glowing', 'weatherproof'],
  ])
})

test('snapshot totals preserve city-wide counts beyond the displayed caps', () => {
  const exports = windowModule as unknown as Record<string, unknown>
  assert.equal(typeof exports.publicWindowTotals, 'function')
  const totals = (exports.publicWindowTotals as (
    row: Record<string, unknown>,
    shown: Record<string, number>,
  ) => Record<string, number>)({
    places: 1_200,
    residents: 2_100,
    conversations: 8_000,
    things: 1_400,
    agreements: 180,
    events: 9_000,
  }, {
    places: 1_000,
    residents: 2_000,
    conversations: 1_000,
    things: 1_000,
    agreements: 100,
    events: 100,
  })
  assert.deepEqual(totals, {
    places: 1_200,
    residents: 2_100,
    conversations: 8_000,
    things: 1_400,
    agreements: 180,
    events: 9_000,
  })
  assert.match(WINDOW_JS, /payload\.totals/)
  assert.match(WINDOW_JS, /current bounded public view/i)
})

test('the armed window keeps its look-never-touch promise honest', async () => {
  // Dormant: the absolute promise holds. Armed: the buy page exists, so the
  // footer names the one human act instead of denying it exists.
  const { Hono } = await import('hono')
  const dormantApp = new Hono()
  const armedApp = new Hono()
  dormantApp.get('/window', c => windowModule.windowPage(c, false))
  armedApp.get('/window', c => windowModule.windowPage(c, true))
  const dormant = await (await dormantApp.request('/window')).text()
  const armed = await (await armedApp.request('/window')).text()
  assert.match(dormant, /No registration, credentials, payments, or city-changing controls exist here\./)
  assert.doesNotMatch(dormant, /Buy fee credit/)
  assert.match(armed, /Watching changes nothing\./)
  assert.match(armed, /fund a resident's fees/)
  // One header button beside the guide links, one quiet footer link.
  assert.equal((armed.match(/href="\/buy"/g) || []).length, 2)
  assert.match(
    armed,
    /Solward&#39;s Visual Wiki<\/a>\s*<a href="\/buy">Buy fee credit<\/a>/,
  )
  assert.equal((dormant.match(/href="\/buy"/g) || []).length, 0)
  assert.match(armed, /never power over the city/)
  assert.match(armed, /Buy fee credit/)
  assert.doesNotMatch(armed, /No registration, credentials, payments, or city-changing controls exist here\./)
})

test('canonical window pages render current public metadata and self-contained images', async () => {
  const windowSource = readFileSync(new URL('../src/window.ts', import.meta.url), 'utf8')
  const gazetteExistenceReader = windowSource.match(
    /async function readLiveWindowGazetteIssue[\s\S]*?\n\}\n\nexport async function windowPage/u,
  )?.[0] ?? ''
  assert.match(gazetteExistenceReader, /FROM gazette_issues/u)
  assert.match(gazetteExistenceReader, /issue_number = \$1::integer/u)
  assert.doesNotMatch(gazetteExistenceReader, /gazette_issue_entries|\bnotes\b|\bbody\b/u)

  const { Hono } = await import('hono')
  const reads: Array<{ kind: string; id: number }> = []
  const gazetteIssueReads: number[] = []
  const app = new Hono()
  app.get('/window/:kind/:id', c => windowModule.windowPage(c, false, async detail => {
    reads.push(detail)
    return detail.id === 401
      ? { name: 'field lantern', made_by: 'archive-smith', body: 'A current public inscription from the city.' }
      : null
  }))
  app.get('/window/:view', c => windowModule.windowPage(
    c,
    false,
    async detail => {
      reads.push(detail)
      return null
    },
    undefined,
    async issueNumber => {
      gazetteIssueReads.push(issueNumber)
      if (issueNumber === 9) throw new Error('temporary Gazette lookup failure')
      return issueNumber === 7
    },
  ))
  app.get('/share/thing.png', c => windowModule.windowShareImage(c, 'thing'))

  const response = await app.request('/window/thing/401')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const html = await response.text()
  assert.match(html, /<title>field lantern · Thing #401 by archive-smith — 1F3D9<\/title>/u)
  assert.match(html, /property="og:description" content="A current public inscription from the city\."/u)
  assert.match(html, /property="og:image" content="https:\/\/1f3d9\.com\/share\/thing\.png"/u)
  assert.match(html, /name="twitter:card" content="summary_large_image"/u)
  assert.deepEqual(reads, [{ kind: 'thing', id: 401 }])

  const unavailable = await app.request('/window/thing/999')
  assert.equal(unavailable.status, 200)
  assert.match(await unavailable.text(), /current public state/iu)
  const staticView = await app.request('/window/happenings')
  assert.equal(staticView.status, 200)
  assert.equal(reads.length, 2, 'a body-free view must not load a detail record')

  const gazetteIssue = await app.request('/window/gazette?issue=7')
  assert.equal(gazetteIssue.status, 200)
  const gazetteHtml = await gazetteIssue.text()
  assert.match(gazetteHtml, /<title>The Gazette · Issue 7 — 1F3D9<\/title>/u)
  assert.match(
    gazetteHtml,
    /<link rel="canonical" href="https:\/\/1f3d9\.com\/gazette\/7">/u,
  )
  assert.match(
    gazetteHtml,
    /<meta property="og:image" content="https:\/\/1f3d9\.com\/gazette\/7\/card\.png">/u,
  )
  assert.equal(reads.length, 2, 'a body-free issue unfurl must not load resident note text')
  assert.deepEqual(gazetteIssueReads, [7])

  const missingGazetteIssue = await app.request('/window/gazette?issue=8')
  assert.equal(missingGazetteIssue.status, 200)
  const missingGazetteHtml = await missingGazetteIssue.text()
  assert.match(missingGazetteHtml, /<title>The Gazette · Issue 8 is unavailable — 1F3D9<\/title>/u)
  assert.match(missingGazetteHtml, /not publicly available now/iu)
  assert.match(missingGazetteHtml, /href="https:\/\/1f3d9\.com\/gazette\/8"/u)
  assert.deepEqual(gazetteIssueReads, [7, 8])
  assert.equal(reads.length, 2, 'Gazette existence checks must never read resident note text')

  const unverifiedGazetteIssue = await app.request('/window/gazette?issue=9')
  assert.equal(unverifiedGazetteIssue.status, 200)
  const unverifiedGazetteHtml = await unverifiedGazetteIssue.text()
  assert.match(
    unverifiedGazetteHtml,
    /<title>The Gazette · Issue 9 could not be checked — 1F3D9<\/title>/u,
  )
  assert.match(unverifiedGazetteHtml, /availability could not be checked right now/iu)
  assert.doesNotMatch(unverifiedGazetteHtml, /not publicly available now/iu)
  assert.match(unverifiedGazetteHtml, /href="https:\/\/1f3d9\.com\/gazette\/9"/u)
  assert.deepEqual(gazetteIssueReads, [7, 8, 9])

  const image = await app.request('/share/thing.png')
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.equal(image.headers.get('cross-origin-resource-policy'), 'cross-origin')
  const bytes = new Uint8Array(await image.arrayBuffer())
  assert.deepEqual([...bytes.subarray(1, 4)], [0x50, 0x4e, 0x47])
})

test('Preview metadata trusts Vercel system URLs instead of the request Host', async () => {
  const { Hono } = await import('hono')
  const app = new Hono()
  const previewHost = '1f3d9-git-sharing-onetapstudiogames-projects.vercel.app'
  app.get('/window/:kind/:id', c => windowModule.windowPage(
    c,
    false,
    async () => ({ name: 'field lantern', made_by: 'archive-smith', body: 'Current public text.' }),
    {
      PUBLIC_ORIGIN: 'https://1f3d9-hosted-chat-preview.vercel.app',
      VERCEL: '1',
      VERCEL_ENV: 'preview',
      VERCEL_BRANCH_URL: previewHost,
    },
  ))

  const previewHtml = await (await app.request('https://evil.example/window/thing/401')).text()
  assert.match(previewHtml, new RegExp(`<link rel="canonical" href="https://${previewHost}/window/thing/401">`, 'u'))
  assert.match(previewHtml, new RegExp(`<meta property="og:url" content="https://${previewHost}/window/thing/401">`, 'u'))
  assert.match(previewHtml, new RegExp(`<meta property="og:image" content="https://${previewHost}/share/thing.png">`, 'u'))
  assert.match(previewHtml, new RegExp(`<meta name="twitter:image" content="https://${previewHost}/share/thing.png">`, 'u'))
  assert.match(previewHtml, /id="live-proof"[^>]*data-preview-available="true"/u)
  assert.doesNotMatch(previewHtml, /id="live-proof"[^>]*hidden/u)
  assert.doesNotMatch(previewHtml, /evil\.example|1f3d9-hosted-chat-preview/u)

  const productionApp = new Hono()
  productionApp.get('/window/:kind/:id', c => windowModule.windowPage(
    c,
    false,
    async () => ({ name: 'field lantern', made_by: 'archive-smith', body: 'Current public text.' }),
    {
      PUBLIC_ORIGIN: 'https://1f3d9.com',
      VERCEL: '1',
      VERCEL_ENV: 'production',
      VERCEL_BRANCH_URL: previewHost,
    },
  ))
  const productionHtml = await (await productionApp.request('https://evil.example/window/thing/401')).text()
  assert.match(productionHtml, /href="https:\/\/1f3d9\.com\/window\/thing\/401"/u)
  assert.match(productionHtml, /content="https:\/\/1f3d9\.com\/share\/thing\.png"/u)
  assert.match(productionHtml, /id="live-proof"[^>]*data-preview-available="false"[^>]*hidden/u)
  assert.doesNotMatch(productionHtml, /evil\.example|onetapstudiogames-projects/u)
})
