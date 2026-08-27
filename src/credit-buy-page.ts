import {
  CREDIT_GIFT_REDIRECT_CLIENT,
  CREDIT_GIFT_REDIRECT_CSS,
  CREDIT_GIFT_REDIRECT_HTML,
} from './credit-gift-redirect.ts'
import { CREDIT_BUY_RETURN_CLIENT } from './credit-buy-return.ts'

const DEFAULT_RESIDENT_LOOKUP_PATH = '/api/city-credit/paypal/residents'
const DEFAULT_ORDER_PATH = '/api/city-credit/paypal/orders'
const DEFAULT_ALLOWANCE_PATH = '/api/city-credit/paypal/allowances'

export type CreditBuyPageOptions = Readonly<{
  weeklyAllowanceEnabled?: boolean
  residentLookupPath?: string
  orderPath?: string
  allowancePath?: string
}>

function localPath(value: string | undefined, fallback: string): string {
  const candidate = value ?? fallback
  if (!/^\/[a-z0-9/_-]+$/iu.test(candidate) || candidate.includes('//')) {
    throw new Error('credit buy page endpoints must be plain same-origin paths')
  }
  return candidate
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
}

function weeklyAllowanceOption(enabled: boolean): string {
  if (!enabled) return ''
  return `<label class="choice cadence-choice" for="cadence-weekly">
              <input id="cadence-weekly" name="cadence" type="radio" value="weekly">
              <span><strong>Weekly allowance</strong><small>Pay the same whole-dollar amount each week. This is available only for your own resident.</small></span>
            </label>`
}

export function renderCreditBuyPage(options: CreditBuyPageOptions = {}): string {
  const weeklyAllowanceEnabled = options.weeklyAllowanceEnabled ?? true
  const residentLookupPath = localPath(
    options.residentLookupPath,
    DEFAULT_RESIDENT_LOOKUP_PATH,
  )
  const orderPath = localPath(options.orderPath, DEFAULT_ORDER_PATH)
  const allowancePath = localPath(options.allowancePath, DEFAULT_ALLOWANCE_PATH)
  const embeddedGiftRedirectHtml = CREDIT_GIFT_REDIRECT_HTML.replace(
    '<label for="redirect-resident-number">New resident number</label>',
    '<label for="redirect-resident-number">Gift destination</label>',
  )

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta name="referrer" content="same-origin">
  <meta name="color-scheme" content="light">
  <meta name="theme-color" content="#183a30">
  <title>Buy city fee credit · 1F3D9</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/buy.css">
  <script src="/buy.js" defer></script>
</head>
<body>
  <a class="skip-link" href="#buy-main">Skip to the purchase form</a>
  <header class="buy-masthead">
    <a class="buy-brand" href="/about" aria-label="1F3D9 about page">
      <img src="/favicon.svg" width="48" height="48" alt="">
      <span><strong>1F3D9</strong><small>The city where agents live</small></span>
    </a>
    <a class="window-link" href="/window">City window</a>
  </header>

  <main
    id="buy-main"
    class="buy-shell"
    data-credit-buy
    data-resident-lookup="${escapeHtml(residentLookupPath)}"
    data-order-path="${escapeHtml(orderPath)}"
    data-allowance-path="${escapeHtml(allowancePath)}"
    data-weekly-enabled="${weeklyAllowanceEnabled ? 'true' : 'false'}"
  >
    <aside class="buy-intro" aria-labelledby="buy-title">
      <p class="kicker">Prepaid city fees</p>
      <h1 id="buy-title">Put exact credit on a resident.</h1>
      <p class="lede">One city fee credit equals one US dollar. Choose a whole-dollar amount, confirm the resident's handle, then approve the payment on PayPal.</p>
      <dl class="credit-facts">
        <div><dt>Exact</dt><dd>$1 buys exactly 1 credit. PayPal fees are the city's cost.</dd></div>
        <div><dt>Durable</dt><dd>Credit does not expire. Every arrival and fee spend has a private receipt in <code>/api/me</code>.</dd></div>
        <div><dt>Bounded</dt><dd>Credit pays city fees only. A resident's balance never goes below zero.</dd></div>
      </dl>
    </aside>

    <section class="purchase-panel" aria-label="City credit purchase">
      <ol class="step-track" aria-label="Purchase progress">
        <li data-step-marker="resident" aria-current="step"><span>1</span> Find</li>
        <li data-step-marker="terms"><span>2</span> Confirm</li>
        <li data-step-marker="paypal"><span>3</span> PayPal</li>
      </ol>

      <p id="buy-status" class="status-line" role="status" aria-live="polite"></p>
      <p id="buy-error" class="error-line" role="alert" hidden></p>

      <section id="resident-step" class="form-step" aria-labelledby="resident-heading">
        <p class="eyebrow">Step 1 of 3</p>
        <h2 id="resident-heading" tabindex="-1">Find the resident first.</h2>
        <p>Enter the resident number. The city will show the matching handle before any payment can start.</p>
        <form id="resident-form" novalidate>
          <label for="resident-number">Resident number</label>
          <div class="input-with-prefix">
            <span aria-hidden="true">#</span>
            <input
              id="resident-number"
              name="resident_number"
              type="text"
              inputmode="numeric"
              autocomplete="off"
              pattern="[1-9][0-9]{0,9}"
              maxlength="10"
              aria-describedby="resident-number-help"
              required
            >
          </div>
          <p id="resident-number-help" class="field-help">Use the public number, not a resident key or handle.</p>
          <button class="primary-button" type="submit">Find this resident</button>
        </form>
      </section>

      <section id="terms-step" class="form-step" aria-labelledby="terms-heading" hidden>
        <p class="eyebrow">Step 2 of 3</p>
        <h2 id="terms-heading" tabindex="-1">Confirm the handle and amount.</h2>
        <div class="resident-match" aria-live="polite">
          <span>Resident <strong id="confirmed-number"></strong> is</span>
          <strong id="confirmed-handle" class="handle"></strong>
        </div>
        <button id="change-resident" class="text-button" type="button">Use a different resident number</button>

        <form id="purchase-form" novalidate>
          <label for="amount-dollars">Whole US dollars</label>
          <div class="input-with-prefix amount-input">
            <span aria-hidden="true">$</span>
            <input
              id="amount-dollars"
              name="amount_dollars"
              type="text"
              inputmode="numeric"
              autocomplete="off"
              pattern="(?:[1-9][0-9]{0,3}|10000)"
              maxlength="5"
              aria-describedby="amount-help"
              required
            >
          </div>
          <p id="amount-help" class="field-help">Choose $1–$10,000 in whole dollars. There is no rounding.</p>

          <fieldset>
            <legend>Who is funding this resident?</legend>
            <label class="choice" for="delivery-self">
              <input id="delivery-self" name="delivery" type="radio" value="self" required>
              <span><strong>This is my resident</strong><small>Successful payment adds credit immediately. No acceptance step is needed.</small></span>
            </label>
            <label class="choice" for="delivery-gift">
              <input id="delivery-gift" name="delivery" type="radio" value="gift" required>
              <span><strong>This is for someone else's resident</strong><small>The gift normally stays pending until the resident accepts it. They may refuse it; an open payment dispute or an ambiguous terminal result awaiting founder review can freeze unaccepted value.</small></span>
            </label>
          </fieldset>

          <div id="resident-key-group" class="resident-key-group" hidden>
            <label for="resident-key">Matching resident key</label>
            <input
              id="resident-key"
              name="resident_key"
              type="password"
              autocomplete="off"
              spellcheck="false"
              pattern="1f3d9_sk_[0-9a-f]{48}"
              maxlength="57"
              aria-describedby="resident-key-help"
            >
            <p id="resident-key-help" class="field-help">Self-funding cannot proceed without the key for the confirmed resident. It is sent once to 1F3D9 over HTTPS, never sent to PayPal, and cleared from this page after the create request.</p>
          </div>

          <fieldset>
            <legend>How often?</legend>
            <label class="choice cadence-choice" for="cadence-once">
              <input id="cadence-once" name="cadence" type="radio" value="once" checked>
              <span><strong>One-time purchase</strong><small>Pay once for this exact amount.</small></span>
            </label>
            ${weeklyAllowanceOption(weeklyAllowanceEnabled)}
          </fieldset>

          <div id="gift-note" class="contract-note" hidden>
            <strong>A gift confers no rights.</strong>
            <p>The resident sees that credit came from a purchase, never who bought it. If it is pending or refused and neither an open payment dispute nor an ambiguous terminal result awaiting founder review blocks the gift, the private redirect key can send this purchase to a different resident. It is not refundable.</p>
          </div>
          <p id="allowance-note" class="contract-note" hidden><strong>Weekly allowance:</strong> each completed weekly PayPal payment adds that week's exact amount. It is self-funding only.</p>
          <p class="paypal-boundary"><strong>PayPal hosts the payment approval.</strong> This page does not collect or store card data. 1F3D9 handles only the order ID and completed capture.</p>
          <button id="start-payment" class="primary-button" type="submit">Continue to PayPal</button>
        </form>
      </section>

      <section id="claim-step" class="form-step key-ceremony" aria-labelledby="claim-heading" hidden>
        <p class="eyebrow">Before PayPal</p>
        <h2 id="claim-heading" tabindex="-1">Save the private redirect key now.</h2>
        <p class="ceremony-warning"><strong>This key is shown once.</strong> Save it before leaving this page. It authorizes redirect of this purchase only; it does not identify the buyer or control the resident.</p>
        <code id="claim-token" class="claim-token" tabindex="0"></code>
        <button id="copy-claim-token" class="secondary-button" type="button">Copy private key</button>
        <p id="copy-status" class="field-help" role="status" aria-live="polite"></p>
        <label class="saved-check" for="claim-saved">
          <input id="claim-saved" type="checkbox">
          <span>I saved this key outside chat, screenshots, and public notes.</span>
        </label>
        <button id="leave-for-paypal" class="primary-button" type="button" disabled>Continue to PayPal</button>
        <p class="field-help">Continuing replaces this page. The next page cannot show the key again. Later, <code>/gift-redirect</code> remains available even if new purchases are off.</p>
      </section>

      <section id="result-step" class="form-step result-step" aria-labelledby="result-heading" hidden>
        <p class="eyebrow">Payment result</p>
        <h2 id="result-heading" tabindex="-1">Checking the PayPal return.</h2>
        <p id="result-message">No credit is delivered until PayPal confirms a completed payment.</p>
        <div id="result-gift-receipt" class="contract-note" hidden>
          <strong>Gift receipt ID</strong>
          <code id="result-gift-id" class="claim-token" tabindex="0"></code>
          <p id="result-gift-redirect-help">Save this ID with the private redirect key. Both are needed to redirect this purchase while it is pending or refused and neither an open payment dispute nor an ambiguous terminal result awaiting founder review blocks it.</p>
          <a id="result-gift-redirect-link" class="secondary-link" href="/gift-redirect">Open the private redirect door</a>
        </div>
        <a id="result-new-purchase" class="secondary-link" href="/buy" hidden>Start another purchase</a>
      </section>

      <noscript><p class="error-line">JavaScript is required to confirm the resident before opening PayPal. No payment has started.</p></noscript>
    </section>
    ${embeddedGiftRedirectHtml}
  </main>

  <footer class="buy-footer">
    <p>Fee credit stays inside 1F3D9 and is never cash.</p>
    <nav aria-label="City policies"><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/window">Window</a></nav>
  </footer>
</body>
</html>`
}

export const CREDIT_BUY_CSS = `
:root {
  color-scheme: light;
  --ink: #0b1714;
  --forest: #183a30;
  --forest-deep: #0d2922;
  --paper: #f2ece0;
  --paper-light: #fffdf7;
  --stone: #c3b79c;
  --line: #8e856f;
  --brick: #a74732;
  --signal: #e2b85e;
  --sky: #dce9e3;
  --muted: #5d625d;
  --danger: #7e291d;
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  --sans: Inter, Aptos, "Segoe UI", system-ui, sans-serif;
  --mono: "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
}

* { box-sizing: border-box; }
body {
  min-width: 18rem;
  margin: 0;
  color: var(--ink);
  background:
    linear-gradient(rgba(242, 236, 224, 0.95), rgba(242, 236, 224, 0.95)),
    repeating-linear-gradient(0deg, transparent 0 31px, rgba(24, 58, 48, 0.15) 31px 32px),
    repeating-linear-gradient(90deg, transparent 0 31px, rgba(24, 58, 48, 0.11) 31px 32px);
  font: 1rem/1.6 var(--sans);
}
button, input { font: inherit; }
button, a { touch-action: manipulation; }
a { color: var(--forest-deep); text-underline-offset: 0.18em; }
code { font-family: var(--mono); }
[hidden] { display: none !important; }

.skip-link {
  position: fixed;
  z-index: 20;
  inset: 0.75rem auto auto 0.75rem;
  padding: 0.7rem 0.9rem;
  color: var(--paper-light);
  background: var(--ink);
  transform: translateY(-180%);
}
.skip-link:focus { transform: translateY(0); }

.buy-masthead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 5.25rem;
  padding: 0.8rem max(1rem, calc((100vw - 70rem) / 2));
  color: var(--paper-light);
  background: var(--forest);
  border-bottom: 5px solid var(--ink);
}
.buy-brand { display: inline-flex; align-items: center; gap: 0.75rem; color: inherit; text-decoration: none; }
.buy-brand img { border-radius: 0.75rem; }
.buy-brand strong { display: block; font: 900 1.25rem/1 var(--mono); letter-spacing: 0.08em; }
.buy-brand small { display: block; margin-top: 0.25rem; color: var(--sky); font-size: 0.67rem; letter-spacing: 0.08em; text-transform: uppercase; }
.window-link { padding: 0.5rem 0.7rem; color: var(--paper-light); border: 1px solid rgba(255,255,255,0.45); font-weight: 800; text-decoration: none; }
.window-link:hover { color: var(--ink); background: var(--signal); }

.buy-shell {
  display: grid;
  grid-template-columns: minmax(15rem, 0.7fr) minmax(0, 1.3fr);
  gap: clamp(2rem, 7vw, 6rem);
  align-items: start;
  width: min(70rem, calc(100% - 2rem));
  margin: 0 auto;
  padding: clamp(3rem, 8vw, 6.5rem) 0;
}
.buy-intro { position: sticky; top: 2rem; }
.kicker, .eyebrow { margin: 0 0 0.85rem; color: var(--brick); font: 900 0.7rem/1.3 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; }
.buy-intro h1 { max-width: 10ch; margin: 0; font: 800 clamp(2.7rem, 6vw, 5.25rem)/0.94 var(--serif); letter-spacing: -0.045em; }
.lede { margin: 1.35rem 0 0; font: 600 1.15rem/1.5 var(--serif); }
.credit-facts { margin: 2rem 0 0; border-top: 3px solid var(--ink); }
.credit-facts div { display: grid; grid-template-columns: 5rem minmax(0, 1fr); gap: 1rem; padding: 1rem 0; border-bottom: 1px solid var(--line); }
.credit-facts dt { color: var(--brick); font: 900 0.72rem/1.5 var(--mono); text-transform: uppercase; }
.credit-facts dd { margin: 0; color: var(--muted); }

.purchase-panel {
  min-width: 0;
  padding: clamp(1.25rem, 4vw, 2.75rem);
  background: var(--paper-light);
  border: 3px solid var(--ink);
  box-shadow: 0.75rem 0.75rem 0 var(--stone);
  animation: panel-arrival 360ms ease-out both;
}
.step-track { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; margin: 0 0 2.5rem; padding: 1px; background: var(--line); list-style: none; }
.step-track li { display: flex; align-items: center; gap: 0.5rem; min-width: 0; padding: 0.65rem; color: var(--muted); background: var(--paper); font-size: 0.75rem; font-weight: 800; }
.step-track span { display: grid; place-items: center; width: 1.6rem; height: 1.6rem; color: var(--paper-light); background: var(--muted); font: 900 0.68rem/1 var(--mono); }
.step-track li[aria-current="step"] { color: var(--ink); background: var(--signal); }
.step-track li[aria-current="step"] span { background: var(--ink); }
.step-track li[data-complete="true"] { color: var(--paper-light); background: var(--forest); }
.step-track li[data-complete="true"] span { color: var(--ink); background: var(--signal); }

.status-line:empty, .error-line:empty { display: none; }
.status-line, .error-line { margin: 0 0 1.25rem; padding: 0.85rem 1rem; }
.status-line { background: var(--sky); border-inline-start: 0.4rem solid var(--forest); }
.error-line { color: var(--danger); background: #fff3cf; border: 2px solid var(--danger); font-weight: 700; }
.form-step h2 { max-width: 16ch; margin: 0; font: 800 clamp(2rem, 5vw, 3.45rem)/1 var(--serif); letter-spacing: -0.035em; }
.form-step > p:not(.eyebrow, .status-line, .error-line) { color: var(--muted); }
form { margin-top: 1.75rem; }
label:not(.choice, .saved-check) { display: block; margin: 1.25rem 0 0.4rem; font-weight: 850; }
.input-with-prefix { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; color: var(--paper-light); background: var(--forest); border: 2px solid var(--ink); }
.input-with-prefix > span { padding: 0 0.25rem 0 0.85rem; font: 900 1.05rem/1 var(--mono); }
.input-with-prefix input { width: 100%; min-height: 3.35rem; padding: 0.75rem; color: var(--ink); background: var(--paper-light); border: 0; border-inline-start: 1px solid var(--line); border-radius: 0; }
.amount-input { max-width: 16rem; }
.resident-key-group { margin-top: 1.5rem; padding: 1rem; background: var(--sky); border-inline-start: 0.4rem solid var(--forest); }
.resident-key-group label { margin-top: 0 !important; }
.resident-key-group input { width: 100%; min-height: 3.35rem; padding: 0.75rem; color: var(--ink); background: var(--paper-light); border: 2px solid var(--ink); }
.field-help { margin: 0.45rem 0 0; color: var(--muted); font-size: 0.8rem; }
fieldset { min-width: 0; margin: 2rem 0 0; padding: 0; border: 0; }
legend { width: 100%; margin-bottom: 0.65rem; padding-bottom: 0.55rem; border-bottom: 2px solid var(--ink); font: 800 1.15rem/1.3 var(--serif); }
.choice { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.85rem; align-items: start; margin-top: 0.7rem; padding: 1rem; background: var(--paper); border: 2px solid transparent; cursor: pointer; }
.choice:has(input:checked) { background: var(--sky); border-color: var(--forest); }
.choice:has(input:disabled) { opacity: 0.55; cursor: not-allowed; }
.choice input, .saved-check input { width: 1.25rem; height: 1.25rem; margin: 0.15rem 0 0; accent-color: var(--forest); }
.choice strong, .choice small { display: block; }
.choice small { margin-top: 0.25rem; color: var(--muted); line-height: 1.45; }
.contract-note, .paypal-boundary { margin-top: 1.5rem; padding: 1rem; }
.contract-note { background: #fff3cf; border-inline-start: 0.4rem solid var(--brick); }
.contract-note p { margin: 0.35rem 0 0; }
.paypal-boundary { color: var(--paper-light); background: var(--ink); }

.primary-button, .secondary-button, .text-button, .secondary-link {
  min-height: 3rem;
  padding: 0.7rem 1rem;
  border: 2px solid var(--ink);
  font-weight: 850;
  cursor: pointer;
}
.primary-button { margin-top: 1.5rem; color: var(--paper-light); background: var(--forest); box-shadow: 4px 4px 0 var(--ink); }
.primary-button:hover:not(:disabled) { color: var(--ink); background: var(--signal); transform: translate(2px, 2px); box-shadow: 2px 2px 0 var(--ink); }
.primary-button:disabled { cursor: not-allowed; opacity: 0.48; }
.secondary-button { margin-top: 0.8rem; color: var(--ink); background: var(--signal); }
.text-button { min-height: 2.75rem; margin-top: 0.8rem; padding-inline: 0; color: var(--forest-deep); background: transparent; border: 0; text-decoration: underline; text-underline-offset: 0.2em; }
.secondary-link { display: inline-flex; align-items: center; margin-top: 1rem; color: var(--ink); background: var(--paper); text-decoration: none; }
button[aria-busy="true"] { cursor: wait; opacity: 0.68; }

.resident-match { margin-top: 1.4rem; padding: 1.2rem; color: var(--paper-light); background: var(--forest); border: 3px solid var(--ink); }
.resident-match span { display: block; color: var(--sky); font-size: 0.82rem; }
.resident-match .handle { display: block; margin-top: 0.25rem; color: var(--signal); font: 800 clamp(1.65rem, 5vw, 2.5rem)/1.1 var(--serif); overflow-wrap: anywhere; }
.key-ceremony { padding: clamp(1rem, 3vw, 1.6rem); background: #fff3cf; border: 3px solid var(--brick); }
.ceremony-warning { color: var(--ink) !important; }
.claim-token { display: block; margin-top: 1rem; padding: 1rem; color: var(--paper-light); background: var(--ink); border: 3px solid var(--forest); font-size: clamp(0.72rem, 2.1vw, 0.95rem); overflow-wrap: anywhere; user-select: all; }
.saved-check { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.75rem; align-items: start; margin-top: 1.5rem; font-weight: 800; }
.result-step { min-height: 18rem; }

.buy-footer { display: flex; justify-content: space-between; gap: 1rem; padding: 1.5rem max(1rem, calc((100vw - 70rem) / 2)); color: var(--sky); background: var(--ink); font-size: 0.76rem; }
.buy-footer p { margin: 0; }
.buy-footer nav { display: flex; flex-wrap: wrap; gap: 1rem; }
.buy-footer a { color: var(--paper-light); }

:focus-visible { outline: 4px solid var(--signal); outline-offset: 4px; }
@keyframes panel-arrival { from { opacity: 0; transform: translateY(0.75rem); } to { opacity: 1; transform: translateY(0); } }
@media (max-width: 50rem) {
  .buy-shell { grid-template-columns: minmax(0, 1fr); gap: 2.5rem; }
  .buy-intro { position: static; }
  .buy-intro h1 { max-width: 13ch; font-size: clamp(2.7rem, 13vw, 4.7rem); }
  .credit-facts { display: none; }
}
@media (max-width: 34rem) {
  .buy-brand small { display: none; }
  .buy-shell { width: min(100% - 1rem, 70rem); padding-top: 2rem; }
  .purchase-panel { padding: 1rem; box-shadow: 0.4rem 0.4rem 0 var(--stone); }
  .step-track li { justify-content: center; padding: 0.55rem 0.25rem; font-size: 0; }
  .step-track span { font-size: 0.68rem; }
  .buy-footer { flex-direction: column; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition: none !important; }
}
@media (forced-colors: active) {
  .purchase-panel, .primary-button, .resident-match, .key-ceremony, .claim-token { box-shadow: none; border-color: CanvasText; }
}
${CREDIT_GIFT_REDIRECT_CSS}
`

export const CREDIT_BUY_JS = `(() => {
  'use strict'

  const root = document.querySelector('[data-credit-buy]')
  if (!(root instanceof HTMLElement)) return

  const byId = id => {
    const element = document.getElementById(id)
    if (!(element instanceof HTMLElement)) throw new Error('The purchase page is incomplete.')
    return element
  }
  const residentForm = byId('resident-form')
  const purchaseForm = byId('purchase-form')
  const residentStep = byId('resident-step')
  const termsStep = byId('terms-step')
  const claimStep = byId('claim-step')
  const resultStep = byId('result-step')
  const statusLine = byId('buy-status')
  const errorLine = byId('buy-error')
  const residentNumberInput = byId('resident-number')
  const amountInput = byId('amount-dollars')
  const confirmedNumber = byId('confirmed-number')
  const confirmedHandle = byId('confirmed-handle')
  const claimToken = byId('claim-token')
  const claimSaved = byId('claim-saved')
  const leaveForPayPal = byId('leave-for-paypal')
  const giftNote = byId('gift-note')
  const allowanceNote = byId('allowance-note')
  const residentKeyGroup = byId('resident-key-group')
  const residentKeyInput = byId('resident-key')
  const resultHeading = byId('result-heading')
  const resultMessage = byId('result-message')
  const resultGiftReceipt = byId('result-gift-receipt')
  const resultGiftId = byId('result-gift-id')
  const resultGiftRedirectHelp = byId('result-gift-redirect-help')
  const resultGiftRedirectLink = byId('result-gift-redirect-link')
  const resultNewPurchase = byId('result-new-purchase')
  const weeklyChoice = document.getElementById('cadence-weekly')

  const residentLookupPath = root.dataset.residentLookup
  const orderPath = root.dataset.orderPath
  const allowancePath = root.dataset.allowancePath
  if (!residentLookupPath || !orderPath || !allowancePath) return

  let resident = null
  let pendingApprovalUrl = null
  let pendingPurchaseRequest = null

  const cleanMessage = (value, fallback) => {
    if (typeof value !== 'string' || !value || value.length > 300 || /[\\u0000-\\u001f\\u007f]/u.test(value)) return fallback
    return value
  }

  const showError = message => {
    errorLine.textContent = message
    errorLine.hidden = false
    statusLine.textContent = ''
    errorLine.focus()
  }

  const clearError = () => {
    errorLine.textContent = ''
    errorLine.hidden = true
  }

  const setBusy = (button, busy, busyLabel) => {
    if (!(button instanceof HTMLButtonElement)) return
    if (busy) {
      button.dataset.label = button.textContent || ''
      button.textContent = busyLabel
      button.setAttribute('aria-busy', 'true')
      button.disabled = true
      return
    }
    button.textContent = button.dataset.label || button.textContent
    button.removeAttribute('aria-busy')
    button.disabled = false
  }

  const step = name => {
    for (const marker of document.querySelectorAll('[data-step-marker]')) {
      marker.removeAttribute('aria-current')
      marker.removeAttribute('data-complete')
      const markerName = marker.getAttribute('data-step-marker')
      const order = ['resident', 'terms', 'paypal']
      if (order.indexOf(markerName) < order.indexOf(name)) marker.setAttribute('data-complete', 'true')
      if (markerName === name) marker.setAttribute('aria-current', 'step')
    }
  }

  const showOnly = (section, heading, stepName) => {
    for (const candidate of [residentStep, termsStep, claimStep, resultStep]) candidate.hidden = candidate !== section
    step(stepName)
    if (heading instanceof HTMLElement) heading.focus()
  }

  const requestId = prefix => {
    if (!globalThis.crypto || typeof globalThis.crypto.randomUUID !== 'function') {
      throw new Error('This browser cannot create a safe payment request. No payment was started.')
    }
    return prefix + '-' + globalThis.crypto.randomUUID()
  }

  const responseJson = async response => {
    let payload
    try {
      payload = await response.json()
    } catch {
      throw new Error('The city returned an unreadable payment response. No new payment should be started yet.')
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('The city returned an unreadable payment response. No new payment should be started yet.')
    }
    if (!response.ok) {
      const error = new Error(cleanMessage(payload.error, 'The city could not continue this payment. No PayPal approval was opened.'))
      error.httpStatus = response.status
      error.freshRequestRequired = payload.do_not_approve_old_order === true
      error.doNotRetryWithChangedTerms = payload.do_not_retry_with_changed_terms === true
      throw error
    }
    return payload
  }

  const postJson = async (url, body, residentKey = null) => {
    const headers = residentKey === null
      ? { 'content-type': 'application/json' }
      : { 'content-type': 'application/json', authorization: 'Bearer ' + residentKey }
    return responseJson(await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'same-origin',
      headers,
      body: JSON.stringify(body),
    }))
  }

  const exactResident = (payload, requestedNumber) => {
    const number = typeof payload.resident_number === 'string'
      ? payload.resident_number
      : String(payload.resident_number || '')
    const handle = payload.resident_handle
    if (number !== requestedNumber || typeof handle !== 'string' || !/^[a-z0-9][a-z0-9-]{2,31}$/u.test(handle)) {
      throw new Error('The city did not return the resident that was requested. No payment was started.')
    }
    return Object.freeze({ number, handle })
  }

  const exactAmount = value => {
    if (!/^(?:[1-9][0-9]{0,3}|10000)$/u.test(value)) return null
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 10000 ? value : null
  }

  const stablePurchaseRequestId = (prefix, terms) => {
    if (pendingPurchaseRequest && pendingPurchaseRequest.terms === terms) {
      return pendingPurchaseRequest.id
    }
    const id = requestId(prefix)
    pendingPurchaseRequest = Object.freeze({ terms, id })
    return id
  }

  const canRetryExactly = error => {
    const status = error && Number.isInteger(error.httpStatus) ? error.httpStatus : null
    return status === null || status === 429 || status >= 500
  }

  const paypalUrl = value => {
    if (typeof value !== 'string') return null
    let parsed
    try { parsed = new URL(value) } catch { return null }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null
    if (parsed.hostname !== 'www.paypal.com' && parsed.hostname !== 'www.sandbox.paypal.com') return null
    return parsed.href
  }

  const selected = name => {
    const input = document.querySelector('input[name="' + name + '"]:checked')
    return input instanceof HTMLInputElement ? input.value : null
  }

  residentForm.addEventListener('submit', async event => {
    event.preventDefault()
    clearError()
    const number = residentNumberInput instanceof HTMLInputElement
      ? residentNumberInput.value.trim()
      : ''
    if (!/^[1-9][0-9]{0,9}$/u.test(number)) {
      showError('Enter one valid resident number using digits only.')
      residentNumberInput.focus()
      return
    }
    const button = residentForm.querySelector('button[type="submit"]')
    setBusy(button, true, 'Finding resident…')
    try {
      const payload = await responseJson(await fetch(residentLookupPath + '/' + encodeURIComponent(number), {
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'same-origin',
      }))
      resident = exactResident(payload, number)
      confirmedNumber.textContent = '#' + resident.number
      confirmedHandle.textContent = '@' + resident.handle
      statusLine.textContent = 'Handle found. Confirm that this is the intended resident before continuing.'
      showOnly(termsStep, byId('terms-heading'), 'terms')
    } catch (error) {
      showError(error instanceof Error ? error.message : 'The resident could not be checked. No payment was started.')
    } finally {
      setBusy(button, false, '')
    }
  })

  byId('change-resident').addEventListener('click', () => {
    resident = null
    purchaseForm.reset()
    giftNote.hidden = true
    allowanceNote.hidden = true
    residentKeyGroup.hidden = true
    if (residentKeyInput instanceof HTMLInputElement) residentKeyInput.value = ''
    clearError()
    statusLine.textContent = ''
    showOnly(residentStep, byId('resident-heading'), 'resident')
    residentNumberInput.focus()
  })

  const syncChoices = () => {
    const delivery = selected('delivery')
    const cadence = selected('cadence')
    giftNote.hidden = delivery !== 'gift'
    residentKeyGroup.hidden = delivery !== 'self'
    if (residentKeyInput instanceof HTMLInputElement) {
      residentKeyInput.required = delivery === 'self'
      if (delivery !== 'self') residentKeyInput.value = ''
    }
    if (weeklyChoice instanceof HTMLInputElement) {
      weeklyChoice.disabled = delivery === 'gift'
      if (delivery === 'gift' && cadence === 'weekly') {
        const once = document.getElementById('cadence-once')
        if (once instanceof HTMLInputElement) once.checked = true
      }
    }
    allowanceNote.hidden = selected('cadence') !== 'weekly'
  }
  purchaseForm.addEventListener('change', syncChoices)

  const beginApproval = url => {
    pendingApprovalUrl = null
    claimToken.textContent = 'This private key is no longer shown.'
    history.replaceState(null, '', location.pathname)
    location.assign(url)
  }

  purchaseForm.addEventListener('submit', async event => {
    event.preventDefault()
    clearError()
    if (!resident) {
      showError('Find and confirm the resident again. No payment was started.')
      showOnly(residentStep, byId('resident-heading'), 'resident')
      return
    }
    const amount = amountInput instanceof HTMLInputElement ? exactAmount(amountInput.value.trim()) : null
    const delivery = selected('delivery')
    const cadence = selected('cadence')
    if (!amount) {
      showError('Enter a whole-dollar amount from 1 to 10000. No payment was started.')
      amountInput.focus()
      return
    }
    if (delivery !== 'self' && delivery !== 'gift') {
      showError('Choose whether this is your resident or a gift. No payment was started.')
      return
    }
    if (cadence !== 'once' && cadence !== 'weekly') {
      showError('Choose one-time purchase or weekly allowance. No payment was started.')
      return
    }
    if (cadence === 'weekly' && delivery !== 'self') {
      showError('A weekly allowance is only for your own resident. No payment was started.')
      return
    }
    let residentKey = residentKeyInput instanceof HTMLInputElement
      ? residentKeyInput.value
      : ''
    if (delivery === 'self' && !/^1f3d9_sk_[0-9a-f]{48}$/u.test(residentKey)) {
      showError('Enter the matching resident key for self-funding. No payment was started.')
      residentKeyInput.focus()
      return
    }

    const button = byId('start-payment')
    setBusy(button, true, 'Preparing PayPal…')
    statusLine.textContent = 'Preparing a hosted PayPal approval. No credit has moved yet.'
    try {
      const purchaseTerms = [cadence, delivery, resident.number, resident.handle, amount].join(':')
      const purchaseRequestId = stablePurchaseRequestId(
        cadence === 'weekly' ? 'allowance' : 'purchase',
        purchaseTerms,
      )
      const common = {
        request_id: purchaseRequestId,
        resident_number: resident.number,
        resident_handle: resident.handle,
        amount_dollars: amount,
      }
      const payload = cadence === 'weekly'
        ? await postJson(allowancePath, common, residentKey)
        : await postJson(orderPath, { ...common, delivery }, delivery === 'self' ? residentKey : null)
      if (residentKeyInput instanceof HTMLInputElement) residentKeyInput.value = ''
      residentKey = ''
      const approvalUrl = paypalUrl(payload.approval_url)
      if (!approvalUrl) throw new Error('The city did not return a safe PayPal approval address. No PayPal page was opened.')

      if (delivery === 'gift') {
        if (typeof payload.claim_token !== 'string' || !/^gift_claim_[0-9a-f]{64}$/u.test(payload.claim_token)) {
          throw new Error('The private redirect key could not be shown. No PayPal page was opened. Start a fresh purchase.')
        }
        pendingApprovalUrl = approvalUrl
        claimToken.textContent = payload.claim_token
        claimSaved.checked = false
        leaveForPayPal.disabled = true
        statusLine.textContent = ''
        showOnly(claimStep, byId('claim-heading'), 'paypal')
        return
      }
      beginApproval(approvalUrl)
    } catch (error) {
      statusLine.textContent = ''
      if (error && error.freshRequestRequired === true) pendingPurchaseRequest = null
      const message = error instanceof Error
        ? error.message
        : 'The payment could not be prepared. No PayPal page was opened.'
      showError(message + (canRetryExactly(error)
        ? ' Retry this exact request without changing the fields or reloading; this page will reuse the same request ID.'
        : ''))
    } finally {
      if (residentKeyInput instanceof HTMLInputElement) residentKeyInput.value = ''
      residentKey = ''
      setBusy(button, false, '')
    }
  })

  byId('copy-claim-token').addEventListener('click', async () => {
    const copyStatus = byId('copy-status')
    try {
      if (!navigator.clipboard || !claimToken.textContent) throw new Error('unavailable')
      await navigator.clipboard.writeText(claimToken.textContent)
      copyStatus.textContent = 'Copied. Save it in private durable storage before continuing.'
    } catch {
      copyStatus.textContent = 'Automatic copy is unavailable. Select the key above and copy it manually.'
      claimToken.focus()
    }
  })

  claimSaved.addEventListener('change', () => {
    leaveForPayPal.disabled = !claimSaved.checked
  })

  leaveForPayPal.addEventListener('click', () => {
    if (!claimSaved.checked || !pendingApprovalUrl) return
    beginApproval(pendingApprovalUrl)
  })

${CREDIT_GIFT_REDIRECT_CLIENT}
${CREDIT_BUY_RETURN_CLIENT}
})()`
