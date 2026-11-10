import assert from 'node:assert/strict'
import test from 'node:test'
import { CREDIT_BUY_CSS, CREDIT_BUY_JS, renderCreditBuyPage } from '../src/credit-buy-page.ts'
import { renderCreditGiftRedirectPage, CREDIT_GIFT_REDIRECT_PAGE_JS } from '../src/credit-gift-redirect.ts'

test('buy carousel offers the approved paths and browser key files', () => {
  const html = renderCreditBuyPage()
  for (const text of ['For my resident', 'A gift for another resident', 'Move a gift I bought', 'Name or number', 'Save your claim key', 'Download', 'I saved it, not in chat']) assert.ok(html.includes(text), text)
  assert.match(html, /data-file-kind="key"/)
  assert.match(html, /data-file-kind="claim"/)
  assert.doesNotMatch(html, /Redirect retry ID|30 redirect attempts|Mockup|gift_claim_[0-9a-f]{64}/)
})

test('clients parse and keep keys out of URLs and persistent storage', () => {
  assert.doesNotThrow(() => new Function(CREDIT_BUY_JS))
  assert.doesNotThrow(() => new Function(CREDIT_GIFT_REDIRECT_PAGE_JS))
  assert.doesNotMatch(CREDIT_BUY_JS, /localStorage|sessionStorage|console\.|innerHTML/)
  assert.match(CREDIT_BUY_JS, /\/api\/city-credit\/gifts\/status/)
  assert.match(CREDIT_BUY_JS, /\/api\/city-credit\/gifts\/redirect/)
})

test('weekly selection is omitted when disabled and endpoint overrides stay local', () => {
  assert.match(renderCreditBuyPage(), /data-often="weekly"/)
  assert.doesNotMatch(renderCreditBuyPage({ weeklyAllowanceEnabled: false }), /data-often="weekly"/)
  for (const orderPath of ['https://attacker.test/orders','//attacker.test/orders','/orders?next=x','/orders#capture']) {
    assert.throws(() => renderCreditBuyPage({ orderPath }), /plain same-origin paths/)
  }
})

test('standalone move page and mobile carousel stay available', () => {
  assert.match(renderCreditGiftRedirectPage(), /data-gift-redirect-page/)
  assert.match(CREDIT_BUY_CSS, /overflow-x: clip/)
  assert.match(CREDIT_BUY_CSS, /prefers-reduced-motion/)
  assert.match(CREDIT_BUY_CSS, /forced-colors/)
})
