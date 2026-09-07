import assert from 'node:assert/strict'
import test from 'node:test'
import { FRONTDOOR, LLMS, architecture, decisions, frontdoor, frontdoorDocument, llms, productRequirements, specification } from '../helpers/help-text-fixtures/door-surfaces.ts'

export function registerMoneyTests(): void {
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
}
