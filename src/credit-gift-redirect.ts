import { renderCreditBuyPage } from './credit-buy-page.ts'
export { CREDIT_BUY_CSP as CREDIT_GIFT_REDIRECT_CSP } from './credit-buy-page.ts'
export { CREDIT_BUY_CSS as CREDIT_GIFT_REDIRECT_PAGE_CSS } from './credit-buy-style.ts'
export { CREDIT_BUY_JS as CREDIT_GIFT_REDIRECT_PAGE_JS } from './credit-buy-client.ts'
// Old saved links keep reaching the same claim-key-only recovery carousel.
export function renderCreditGiftRedirectPage(): string {
  return renderCreditBuyPage({ redirectOnly: true, weeklyAllowanceEnabled: false })
}
