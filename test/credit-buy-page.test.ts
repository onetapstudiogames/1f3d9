import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CREDIT_BUY_CSS,
  CREDIT_BUY_JS,
  renderCreditBuyPage,
} from '../src/credit-buy-page.ts'
import { PENDING_GIFT_RELAY_LINE } from '../src/credit-awareness.ts'
import {
  CREDIT_GIFT_REDIRECT_PAGE_JS,
  renderCreditGiftRedirectPage,
} from '../src/credit-gift-redirect.ts'

test('buy page makes resident and hosted-payment confirmation explicit without payment fields', () => {
  const html = renderCreditBuyPage({ weeklyAllowanceEnabled: true })

  assert.match(html, /resident number/iu)
  assert.match(html, /confirm the handle/iu)
  assert.match(html, /PayPal hosts the payment approval/iu)
  assert.match(html, /does not collect or store card data/iu)
  assert.doesNotMatch(html, /card number|security code|\bCVV\b|\bCVC\b/iu)
  assert.match(html, /id="resident-number"[\s\S]{0,220}pattern="\[1-9\]\[0-9\]\{0,9\}"[\s\S]{0,100}maxlength="10"/u)
  assert.match(CREDIT_BUY_JS, /\^\[1-9\]\[0-9\]\{0,9\}\$/u)
  assert.match(html, /Skip to the purchase form/iu)
  assert.match(html, /aria-live="polite"/u)
  assert.match(html, /inputmode="numeric"/u)
})

test('buy page states self, gift, exact-credit, receipt, and one-time-key contracts', () => {
  const html = renderCreditBuyPage({ weeklyAllowanceEnabled: true })

  assert.match(html, /\$1 buys exactly 1 credit/iu)
  assert.match(html, /does not expire/iu)
  assert.match(html, /private receipt[\s\S]{0,80}<code>\/api\/me<\/code>/iu)
  assert.match(html, /Successful payment adds credit immediately[\s\S]{0,80}No acceptance/iu)
  assert.match(html, /gift normally stays pending[\s\S]{0,100}accepts[\s\S]{0,80}refuse/iu)
  assert.match(html, /never who bought it/iu)
  assert.match(html, /private redirect key/iu)
  assert.match(html, /shown once/iu)
  assert.match(html, /does not identify the buyer or control the resident/iu)
})

test('weekly allowance is present only when enabled and is clearly self-funding', () => {
  const enabled = renderCreditBuyPage({ weeklyAllowanceEnabled: true })
  const disabled = renderCreditBuyPage({ weeklyAllowanceEnabled: false })

  assert.match(enabled, /id="cadence-weekly"/u)
  assert.match(enabled, /Weekly allowance/iu)
  assert.match(enabled, /available only for your own resident/iu)
  assert.doesNotMatch(disabled, /id="cadence-weekly"/u)
})

test('client script uses the agreed same-origin contract and does not retain the claim token', () => {
  const html = renderCreditBuyPage()

  assert.match(html, /data-resident-lookup="\/api\/city-credit\/paypal\/residents"/u)
  assert.match(html, /data-order-path="\/api\/city-credit\/paypal\/orders"/u)
  assert.match(html, /data-allowance-path="\/api\/city-credit\/paypal\/allowances"/u)
  assert.match(CREDIT_BUY_JS, /resident_number:\s*resident\.number/u)
  assert.match(CREDIT_BUY_JS, /resident_handle:\s*resident\.handle/u)
  assert.match(CREDIT_BUY_JS, /amount_dollars:\s*amount/u)
  assert.match(CREDIT_BUY_JS, /paypal_order_id:\s*paypalOrderId/u)
  assert.match(CREDIT_BUY_JS, /query\.get\('paypal'\) === 'allowance-return'/u)
  assert.match(CREDIT_BUY_JS, /query\.get\('paypal'\) === 'allowance-cancel'/u)
  assert.match(CREDIT_BUY_JS, /cancelled in this browser tab/iu)
  assert.match(CREDIT_BUY_JS, /keep this URL/iu)
  assert.doesNotMatch(CREDIT_BUY_JS, /No payment was captured|safely start again/iu)
  assert.match(CREDIT_BUY_JS, /canRetryExactly\(error\)/u)
  assert.match(CREDIT_BUY_JS, /restore the matching saved purchase and PayPal order facts/iu)
  assert.match(CREDIT_BUY_JS, /do not start another allowance/iu)
  assert.match(CREDIT_BUY_JS, /\^gift_claim_\[0-9a-f\]\{64\}\$/u)
  assert.doesNotMatch(CREDIT_BUY_JS, /localStorage|innerHTML|console\./u)
  assert.doesNotMatch(CREDIT_BUY_JS, /sessionStorage[\s\S]{0,160}claim_token|claim_token[\s\S]{0,160}sessionStorage/iu)
})

test('purchase preparation keeps one request id for an exact ambiguous retry', () => {
  assert.match(CREDIT_BUY_JS, /let pendingPurchaseRequest\s*=\s*null/u)
  assert.match(CREDIT_BUY_JS, /pendingPurchaseRequest\.terms\s*===\s*terms/u)
  assert.match(CREDIT_BUY_JS, /request_id:\s*purchaseRequestId/u)
  assert.match(CREDIT_BUY_JS, /retry this exact request without changing the fields/iu)
})

test('self-funding requires the matching resident key and clears it after the city request', () => {
  const html = renderCreditBuyPage()

  assert.match(html, /id="resident-key"[\s\S]{0,240}type="password"/u)
  assert.match(html, /Self-funding cannot proceed without the key/iu)
  assert.match(html, /sent once to 1F3D9 over HTTPS, never sent to PayPal/iu)
  assert.match(CREDIT_BUY_JS, /authorization: 'Bearer ' \+ residentKey/u)
  assert.match(CREDIT_BUY_JS, /delivery === 'self' \? residentKey : null/u)
  assert.match(CREDIT_BUY_JS, /residentKeyInput\.value = ''/u)
  assert.match(CREDIT_BUY_JS, /redirect: 'error'/u)
  assert.doesNotMatch(CREDIT_BUY_JS, /resident_key:/u)
})

test('buy page refuses cross-origin or query-bearing endpoint injection', () => {
  for (const orderPath of [
    'https://attacker.test/orders',
    '//attacker.test/orders',
    '/orders?next=https://attacker.test',
    '/orders#capture',
    '/orders&quot; data-stolen="yes',
  ]) {
    assert.throws(
      () => renderCreditBuyPage({ orderPath }),
      /plain same-origin paths/iu,
    )
  }
})

test('buy page style preserves the human-page family and mobile accessibility', () => {
  assert.match(CREDIT_BUY_CSS, /--forest:\s*#183a30/iu)
  assert.match(CREDIT_BUY_CSS, /--signal:\s*#e2b85e/iu)
  assert.match(CREDIT_BUY_CSS, /@media \(max-width:/u)
  assert.match(CREDIT_BUY_CSS, /prefers-reduced-motion:\s*reduce/u)
  assert.match(CREDIT_BUY_CSS, /forced-colors:\s*active/u)
  assert.match(CREDIT_BUY_CSS, /:focus-visible/u)
})

test('saved gift key can resolve and confirm a new resident before redirect', () => {
  const html = renderCreditBuyPage()

  assert.match(html, /Redirect a pending or refused gift/iu)
  assert.match(html, /Gift receipt ID/iu)
  assert.match(html, /id="redirect-claim-token"[\s\S]{0,180}type="password"/u)
  assert.match(html, /Gift destination/iu)
  assert.match(html, /handle will be shown before the gift moves/iu)
  assert.match(html, /id="redirect-confirmed-handle"/u)
  assert.match(html, /id="redirect-request-id"/u)
  assert.match(html, /same retry ID/iu)
  assert.match(html, /Redirect this gift/iu)
})

test('gift redirect sends the exact route contract once and clears the raw key', () => {
  assert.match(CREDIT_BUY_JS, /giftRedirectBasePath \+ '\/' \+ encodeURIComponent\(giftId\) \+ '\/redirect'/u)
  assert.match(CREDIT_BUY_JS, /claim_token:\s*rawClaimToken/u)
  assert.match(CREDIT_BUY_JS, /recipient_number:\s*redirectDestination\.number/u)
  assert.match(CREDIT_BUY_JS, /recipient_handle:\s*redirectDestination\.handle/u)
  assert.match(CREDIT_BUY_JS, /request_id:\s*redirectRequestId/u)
  assert.match(CREDIT_BUY_JS, /if \(redirectInFlight\) return/u)
  assert.match(CREDIT_BUY_JS, /error\.httpStatus\s*=\s*response\.status/u)
  assert.match(CREDIT_BUY_JS, /do_not_retry_with_changed_terms/u)
  assert.match(CREDIT_BUY_JS, /status === null \|\| status === 429 \|\| status >= 500/u)
  assert.match(CREDIT_BUY_JS, /Retry this exact redirect with the same gift, key, destination, and retry ID/iu)
  assert.match(CREDIT_BUY_JS, /Check the saved gift ID, private key, and current gift status/iu)
  assert.match(CREDIT_BUY_JS, /redirectClaimTokenInput\.value = ''/u)
  assert.match(CREDIT_BUY_JS, /rawClaimToken = ''/u)
  assert.doesNotMatch(CREDIT_BUY_JS, /localStorage|console\./u)
  assert.doesNotMatch(CREDIT_BUY_JS, /finally\s*\{[\s\S]{0,240}redirectClaimTokenInput\.value = ''/u)
})

test('captured gift shows the receipt id needed by the redirect form', () => {
  const html = renderCreditBuyPage()
  assert.match(html, /id="result-gift-receipt"[^>]*hidden/u)
  assert.match(html, /id="result-gift-id"/u)
  assert.match(CREDIT_BUY_JS, /payload\.gift_id/u)
  assert.match(CREDIT_BUY_JS, /\^city_gift_\[0-9a-f\]\{32\}\$/u)
  assert.match(CREDIT_BUY_JS, /redirectGiftIdInput\.value\s*=\s*giftId/u)
  assert.match(html, /id="result-new-purchase"[^>]*hidden/u)
  assert.match(CREDIT_BUY_JS, /resultNewPurchase\.hidden\s*=\s*false/u)
  assert.doesNotMatch(CREDIT_BUY_JS, /(?:allowance-return|allowance-cancel|paypal'\) === 'cancel')[\s\S]{0,500}resultNewPurchase\.hidden\s*=\s*false/u)
})

test('captured gift copy follows pending, refused, frozen, accepted, and revoked custody', () => {
  const html = renderCreditBuyPage()

  assert.match(CREDIT_BUY_JS, /payload\.status/u)
  assert.match(CREDIT_BUY_JS, /payload\.blocked_reason/u)
  for (const status of ['pending', 'refused', 'frozen', 'accepted', 'revoked']) {
    assert.match(CREDIT_BUY_JS, new RegExp(`['"]${status}['"]`, 'u'))
  }
  assert.match(CREDIT_BUY_JS, /resultGiftRedirectLink\.hidden/u)
  assert.match(html, /payment dispute is open[\s\S]{0,180}redirect/iu)
  assert.match(
    html,
    /neither an open payment dispute nor an ambiguous terminal result awaiting founder review blocks (?:the gift|it)/iu,
  )
  assert.doesNotMatch(html, /no payment dispute is open or ambiguous terminal result/iu)
  assert.match(html, /id="result-gift-redirect-help"/u)
  assert.match(html, /id="result-gift-redirect-link"/u)
})

test('every human path that leaves a gift pending shows one identical relay line', () => {
  const html = renderCreditBuyPage()
  assert.equal(html.split(PENDING_GIFT_RELAY_LINE).length - 1, 1)
  assert.match(CREDIT_BUY_JS, /pendingGiftRelayLine/u)
  assert.match(CREDIT_BUY_JS, /giftStatus === 'pending'[\s\S]*pendingGiftRelayLine/u)
  assert.match(CREDIT_GIFT_REDIRECT_PAGE_JS, /pendingGiftRelayLine/u)
  assert.match(CREDIT_GIFT_REDIRECT_PAGE_JS, /payload\.status !== 'pending'[\s\S]*pendingGiftRelayLine/u)
})

test('gift redirect remains a standalone non-PayPal recovery door', () => {
  const html = renderCreditGiftRedirectPage()
  assert.match(html, /data-gift-redirect-page/u)
  assert.match(html, /data-resident-lookup="\/api\/city-credit\/gifts\/residents"/u)
  assert.match(html, /stays available even when new PayPal purchases are off/iu)
  assert.match(html, /30 redirect attempts per caller per hour/iu)
  assert.match(html, /429[\s\S]{0,120}Retry-After: 3600/iu)
  assert.match(CREDIT_GIFT_REDIRECT_PAGE_JS, /giftRedirectBasePath/iu)
  assert.doesNotMatch(`${html}\n${CREDIT_GIFT_REDIRECT_PAGE_JS}`, /PAYPAL_CLIENT|paypal\/orders/iu)
})
