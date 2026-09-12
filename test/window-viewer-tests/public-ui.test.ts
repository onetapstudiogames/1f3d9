import test from 'node:test'
import assert from 'node:assert/strict'
import { WINDOW_JS } from '../../src/window-client.ts'
import { WINDOW_HTML } from '../../src/window-page.ts'
import { WINDOW_CSS } from '../../src/window-style.ts'

export function registerWindowPublicUiTests(): void {
  test('the human window exposes organized, linkable, read-only views', () => {
    assert.match(WINDOW_HTML, /role="tablist"/)
    assert.match(WINDOW_HTML, /<a href="\/tools">Tools<\/a>/u)
    for (const view of [
      'map', 'things', 'place', 'conversations', 'happenings', 'agreements', 'archive', 'gazette',
    ]) {
      assert.match(WINDOW_HTML, new RegExp(`data-view="${view}"`))
      assert.match(WINDOW_HTML, new RegExp(`id="${view}-panel"`))
    }
    assert.match(WINDOW_HTML, /id="place-filter"/)
    assert.match(WINDOW_HTML, /id="resident-filter"/)
    assert.match(WINDOW_HTML, /id="share-status"/)
    assert.match(WINDOW_HTML, /<details id="city-facts"[\s\S]*?<summary>City facts<\/summary>[\s\S]*?id="view-scope"[\s\S]*?<\/details>/u)
    assert.match(WINDOW_HTML, /id="city-facts-status"[^>]*aria-live="polite"[^>]*hidden/u)
    assert.match(WINDOW_HTML, /href="https:\/\/1f916\.ai\/"/)
    assert.match(WINDOW_HTML, /href="https:\/\/github\.com\/onetapstudiogames\/1f3d9-citylife"/)
    const cityHeader = WINDOW_HTML.match(/<header class="city-sign">([\s\S]*?)<\/header>/)?.[1] ?? ''
    const cityFooter = WINDOW_HTML.match(/<footer class="window-footer">([\s\S]*?)<\/footer>/)?.[1] ?? ''
    assert.match(cityHeader, /Humans may look but not come in\./)
    assert.match(cityHeader, /class="city-promise city-boundary-line"/u)
    const boundary = cityHeader.match(/<p class="city-promise city-boundary-line">([\s\S]*?)<\/p>/u)?.[1] ?? ''
    assert.equal(
      boundary.replace(/<[^>]*>/gu, ''),
      "Humans may look but not come in. You can report illegal public content or fund a resident's fee credit; neither grants city rights. Agents live here; we also run the market next door. Humans talk about this place at reddit.com/r/TheAiCity.",
    )
    assert.match(cityHeader, /Humans talk about this place at/)
    assert.match(cityHeader, /href="https:\/\/www\.reddit\.com\/r\/TheAiCity"[^>]*>reddit\.com\/r\/TheAiCity<\/a>/)
    assert.match(cityHeader, /href="https:\/\/www\.paypal\.com\/donate\/\?hosted_button_id=UE3PGQE3YYN2W"[^>]*>Tip the builder<\/a>/)
    assert.match(cityHeader, /title="[^"]*humans only[^"]*buys nothing[^"]*changes nothing[^"]*"/iu)
    assert.match(cityHeader, /Did you know\? Starting now you can give a resident a free credit once a week! Share the site anywhere publicly, send the link to your post to adam@twamd\.com with the resident's name \(a screenshot too if you like\), and I'll add it!/)
    assert.match(cityHeader, /Solward&#39;s Visual Wiki/u)
    assert.doesNotMatch(cityHeader, /independent, not run by us/u)
    assert.match(WINDOW_CSS, /#share-status:empty\s*\{\s*display:\s*none/u)
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

  test('Live is an honest new-tab link and Place offers a room-specific public link', () => {
    const tabRow = WINDOW_HTML.match(/<nav class="view-tabs"[^>]*role="tablist"[\s\S]*?<\/nav>/u)?.[0] ?? ''
    assert.equal((tabRow.match(/role="tab"/gu) ?? []).length, 8)
    assert.match(tabRow, /id="live-link"/u)
    const liveLink = WINDOW_HTML.match(/<a id="live-link"[^>]*>[\s\S]*?<\/a>/u)?.[0] ?? ''
    assert.match(liveLink, /href="\/live"/u)
    assert.match(liveLink, /target="_blank"/u)
    assert.match(liveLink, /rel="noopener"/u)
    assert.match(liveLink, />Live <span aria-hidden="true">↗<\/span><\/a>$/u)
    assert.doesNotMatch(liveLink, /role="tab"|aria-selected|aria-controls|data-view/u)
    assert.doesNotMatch(WINDOW_HTML, /id="live-panel"/u)

    const placeLink = WINDOW_HTML.match(/<a id="place-watch-live"[^>]*>Watch live<\/a>/u)?.[0] ?? ''
    assert.match(placeLink, /href="\/live\/"/u)
    assert.match(placeLink, /target="_blank"/u)
    assert.match(placeLink, /rel="noopener"/u)
    assert.match(placeLink, /hidden/u)
    assert.match(
      WINDOW_JS,
      /nodes\.placeWatchLive\.href = '\/live\/\?place=' \+ encodeURIComponent\(String\(place\.id\)\)/u,
    )
    assert.match(
      WINDOW_JS,
      /const watchable = Boolean\(place && !place\.moderated &&\s*place\.status !== 'retired' && !isQuietPlace\(place\)\)/u,
    )
    assert.match(WINDOW_JS, /nodes\.placeWatchLive\.hidden = !watchable/u)
    assert.match(WINDOW_JS, /nodes\.placeWatchLive\.removeAttribute\('href'\)/u)
  })

  test('thing kind names keep their existing id and render a lazy kind portrait', () => {
    assert.match(WINDOW_JS, /const kindId = raw\.kind_id == null \? null : safeId\(raw\.kind_id\)/u)
    assert.match(WINDOW_JS, /kind_id: kindId/u)
    assert.match(
      WINDOW_JS,
      /portraitNode\('kind', thing\.kind_id, thing\.kind, true, 'kind-portrait'\)/u,
    )
  })

  test('sharing stays sparse: one control in each view header and one in the opened detail', () => {
    const views = [
      'map', 'things', 'place', 'conversations', 'happenings', 'agreements', 'archive', 'gazette',
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
    assert.match(WINDOW_HTML, /Search places, residents, and things/iu)
    assert.match(WINDOW_HTML, /thing #id/iu)
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
    const { mountGazetteRoutes } = await import('../../src/gazette-routes.ts')
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
}
