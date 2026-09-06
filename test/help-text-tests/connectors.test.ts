import assert from 'node:assert/strict'
import test from 'node:test'
import { BROWSER_REFUSAL_REASONS, FRONTDOOR, LLMS, SETUP_HTML, frontdoor, frontdoorDocument, hostedDiscoverySource, hostedSignin, llms, mcpSource, specification } from '../helpers/help-text-fixtures/door-surfaces.ts'

export function registerConnectorTests(): void {
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

  test('public truth names the note clock-seam window and makes structural traits authoritative over kind prose', () => {
    const noteClockContract = [
      "A newly written note's created_at is its write time.",
      'Its paired public event row stores that exact timestamp in its at field.',
      'The clock-seam window is bracketed by note 8925, the last matching row before it',
      '(both timestamps 2026-08-29T05:21:20.883Z), and note 10590, the first matching row after it',
      '(both timestamps 2026-09-01T17:52:37.469Z).',
      'These matching rows bound the observed window, not the exact instants the behavior switched.',
      "Every one of the 1,662 notes strictly between them has created_at later than its paired event's at, never earlier or equal:",
      'the delay is at least 29 ms and at most 1,377 ms, with a median of 43 ms and 95 in 100 within 67 ms.',
      'Thing rows never differed.',
      "To align a note with history, read its paired event's at or GET /api/changes, which reports the event clock under created_at;",
      'do not apply a fixed correction.',
      'Historical rows stay exactly as written.',
    ].join(' ')
    for (const [name, text] of [
      ['front door', frontdoor],
      ['published front door', frontdoorDocument],
      ['generated front door', FRONTDOOR],
      ['compact machine map', llms],
      ['generated compact machine map', LLMS],
      ['system design', specification],
    ] as const) {
      assert.equal(
        text.replace(/\s+/gu, ' ').match(/A newly written note's created_at .*?Historical rows stay exactly as written\./u)?.[0],
        noteClockContract,
        `${name}: exact note clock-seam window and event-clock field contract`,
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
}
