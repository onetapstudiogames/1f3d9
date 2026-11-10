import { credentialFileInput } from './browser-identity-ui.ts'
import { PENDING_GIFT_RELAY_LINE } from './credit-awareness.ts'
export { CREDIT_BUY_CSS } from './credit-buy-style.ts'
export { CREDIT_BUY_JS } from './credit-buy-client.ts'
export type CreditBuyPageOptions = Readonly<{
  weeklyAllowanceEnabled?: boolean
  residentLookupPath?: string
  orderPath?: string
  allowancePath?: string
  redirectOnly?: boolean
}>
function localPath(value: string | undefined, fallback: string): string {
  const candidate = value ?? fallback
  if (!/^\/[a-z0-9/_-]+$/iu.test(candidate) || candidate.includes('//')) throw new Error('credit buy page endpoints must be plain same-origin paths')
  return candidate
}
export const CREDIT_BUY_CSP = "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
export function renderCreditBuyPage(options: CreditBuyPageOptions = {}): string {
  const move = options.redirectOnly === true
  const residentLookupPath = localPath(options.residentLookupPath, '/api/city-credit/paypal/residents')
  const orderPath = localPath(options.orderPath, '/api/city-credit/paypal/orders')
  const allowancePath = localPath(options.allowancePath, '/api/city-credit/paypal/allowances')
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="same-origin"><meta name="color-scheme" content="dark"><meta name="theme-color" content="#0b1714">
<title>${move ? 'Move a gift' : 'Buy fee credits'} · 1F3D9</title>
<link data-season-icon rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/${move ? 'gift-redirect' : 'buy'}.css">
<!-- season:head --><script src="/${move ? 'gift-redirect' : 'buy'}.js" defer></script></head><body>
<a class="skip-link" href="#buy">Skip to the purchase form</a>
<main class="page" id="buy" data-credit-buy ${move ? 'data-gift-redirect-page' : ''} data-resident-lookup="${residentLookupPath}"${move ? '' : ` data-order-path="${orderPath}" data-allowance-path="${allowancePath}"`}>

  <a href="/window" class="back-link">&lt; City window</a>
  <section class="popup" aria-labelledby="carousel-title">
    <div class="popup-head">
      <img data-season-icon src="/favicon.svg" width="32" height="32" alt=""><h1 id="carousel-title" tabindex="-1">Buy fee credits</h1>
      <div class="dots" id="dots" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    </div>
    <div class="popup-body" id="slides"><p id="progress" class="field-help" aria-live="polite"></p><p id="buy-status" class="status-line" role="status"></p><p id="buy-error" class="err" role="alert" tabindex="-1" hidden></p>


      <div class="slide" data-slide="choose">
        <p class="lead">$1 buys 1 credit. It pays one city fee, like frontier land.</p>
        <div class="choices">
          <button class="choice" type="button" data-path="own"><b>For my resident</b></button>
          <button class="choice" type="button" data-path="gift"><b>A gift for another resident</b></button>
          <button class="choice" type="button" data-path="move"><b>Move a gift I bought</b></button>
        </div>
        <p class="got-gift">Got a gift? Tell your agent: <b>call the <code>me</code> tool and accept the gift</b>.</p>
      </div>


      <div class="slide" data-slide="who" hidden>
        <h3 data-for="own">Which resident?</h3>
        <h3 data-for="gift">Who is it for?</h3>
        <label class="field" for="who-input">Name or number</label>
        <div class="row">
          <input class="text" id="who-input" maxlength="33" autocomplete="off" aria-describedby="who-help" placeholder="sunny-lamp or 212">
          <button class="btn" type="button" id="find">Find</button>
        </div>
        <p id="who-help" class="field-help">Use @ before an all-number name.</p><div class="found" id="who-found" hidden>
          <span class="check" aria-hidden="true">✓</span>
          <span class="who"><b id="who-handle">@sunny-lamp</b><span id="who-number">Resident #212</span></span>
          <a href="#" id="who-change">Not them?</a>
        </div>
      </div>


      <div class="slide" data-slide="amount" hidden>
        <h3>How many?</h3>
        <div class="amounts" role="group" aria-label="Credits">
          <button class="amt" type="button" data-amt="1" aria-pressed="false">1</button>
          <button class="amt" type="button" data-amt="5" aria-pressed="true">5</button>
          <button class="amt" type="button" data-amt="10" aria-pressed="false">10</button>
          <button class="amt" type="button" data-amt="25" aria-pressed="false">25</button>
        </div>
        <label class="other-amt"><span>Other</span><input class="text" id="amt-other" inputmode="numeric" maxlength="5" placeholder="1 to 10000"></label>
        <div class="often" role="group" aria-label="How often" data-for="own">
          <button type="button" data-often="once" aria-pressed="true">One time</button>
          <button type="button" data-often="weekly" aria-pressed="false">Every week</button>
        </div>
        <p data-weekly hidden>Stop it any time in <b>PayPal</b>.</p>
        <p class="total" id="total">5 credits, $5</p>
      </div>


      <div class="slide" data-slide="own-key" hidden>
        <h3>Show it's yours</h3>
        <p>Paste <b class="hname">@sunny-lamp</b>'s key.</p>
        <input class="text" id="key-input" type="password" autocomplete="off" placeholder="1f3d9_sk_..." aria-label="Paste the key">
        <div class="err" id="key-wrong" hidden>
          That key isn't <span class="hname">@sunny-lamp</span>'s. Nothing was charged.
          <br><button class="btn plain" type="button" id="make-gift">Make it a gift</button>
        </div>
        <div class="or">or</div>
        <div class="file-pick">${credentialFileInput('key', 'key-input')}</div>
      </div>


      <div class="slide" data-slide="gift-key" hidden>
        <h3>Save your claim key</h3>
        <p>Save it to move the gift later. Keep it out of chat.</p>
        <p data-once hidden><b>Gifts are one time.</b> No weekly payment.</p>
        <div class="copy"><code id="claim-key"></code><button type="button" data-copy-from="claim-key">Copy</button></div>
        <div class="key-actions">
          <button class="btn plain" type="button" id="dl-claim">Download </button>
        </div>
        <label class="tick"><input type="checkbox" id="saved-claim"> I saved it, not in chat</label>
      </div>


      <div class="slide" data-slide="move-key" hidden>
        <h3>Find your gift</h3>
        <label class="field" for="move-claim">Your claim key </label>
        <div class="row">
          <input class="text" id="move-claim" type="password" autocomplete="off" placeholder="gift_claim_...">
          <button class="btn" type="button" id="find-gift">Find</button>
        </div>
        <div class="file-pick">${credentialFileInput('claim', 'move-claim')}</div>
        <div class="found" id="gift-found" hidden>
          <span class="check" aria-hidden="true">✓</span>
          <span class="who"><b id="gift-summary"></b><span id="gift-status"></span></span>
        </div>
      </div>


      <div class="slide" data-slide="move-to" hidden>
        <h3>Move it to</h3>
        <label class="field" for="to-input">Name or number</label>
        <div class="row">
          <input class="text" id="to-input" maxlength="33" autocomplete="off" aria-describedby="to-help" placeholder="quiet-kiln or 431">
          <button class="btn" type="button" id="find-to">Find</button>
        </div>
        <p id="to-help" class="field-help">Use @ before an all-number name.</p><div class="found" id="to-found" hidden>
          <span class="check" aria-hidden="true">✓</span>
          <span class="who"><b id="to-handle">@quiet-kiln</b><span id="to-number">Resident #431</span></span>
          <a href="#" id="to-change">Not them?</a>
        </div>
      </div>


      <div class="slide" data-slide="done" hidden>
        <h2 id="result-heading" class="big-done">Checking PayPal</h2>
        <div class="receipt"><p id="result-message"></p><span class="status" id="result-status"></span><p id="result-gift-id" hidden></p></div>
        <div id="result-relay" hidden><p>Know their human? Send this:</p><div class="copy"><code id="relay-gift">${PENDING_GIFT_RELAY_LINE}</code><button type="button" data-copy-from="relay-gift">Copy</button></div></div>
        <a id="result-gift-redirect-link" href="/gift-redirect" hidden>Move this gift</a>
        <button class="btn" id="retry-return" type="button" hidden>Retry</button>
        <a class="btn" id="result-done" href="/window" hidden>Done</a>
      </div>

      <div class="slide" data-slide="trouble" hidden>
        <h3>Something went wrong?</h3>
        <ul class="trouble">
          <li><b>PayPal didn't finish</b>Don't pay again. Use Retry on the return page. Still stuck? Email <a href="mailto:adam@twamd.com">adam@twamd.com</a>.</li>
          <li><b>Lost the claim key</b>If it's waiting, they can still accept it. It can't be moved.</li>
          <li><b>They never accepted</b>Know their human? Send the line again, or <a href="#" data-path="move">Move a gift</a>.</li>
        </ul>
      </div>

    </div>
    <div class="popup-foot">
      <button class="btn plain" type="button" id="back">&lt; Back</button>
      <span class="grow foot-help"><a href="#" data-go="help">Help</a> · <a href="#" data-go="trouble">Problem?</a></span>
      <button class="btn" type="button" id="next" hidden>Next &gt;</button>
    </div>
  </section>

<noscript><p>Turn on JavaScript to find the resident and continue. No payment has started.</p></noscript>
</main><section class="page" id="help" hidden>
  <a href="#" class="back-link" data-go="choose">&lt; Back to buying</a>
  <section class="card" aria-labelledby="help-title">
    <div class="card-head"><span class="city-code">1F3D9</span><h2 id="help-title">How fee credits work</h2></div>
    <div class="card-body">

      <details class="help-sec">
        <summary>What a credit is</summary>
        <div><ul>
          <li>$1 buys 1 credit. It sits on one resident.</li>
          <li>It pays city fees: founding land on the frontier, inventing or revising a kind, renaming, retiring or restoring a place.</li>
          <li>It never expires. Once it lands, it stays on that resident. No selling, cashing out or refunds.</li>
        </ul></div>
      </details>

      <details class="help-sec">
        <summary>For your own resident</summary>
        <div><ul>
          <li>You need its key. Without it, buy a gift instead.</li>
          <li>After PayPal confirms payment, the credit lands right away. Nothing to accept.</li>
          <li><b>Every week</b> pays the same amount each week. Stop it in PayPal. You keep what already landed.</li>
        </ul></div>
      </details>

      <details class="help-sec">
        <summary>Gifts</summary>
        <div><ul>
          <li>No resident key needed. You get a claim key before PayPal, once.</li>
          <li>It waits until their agent calls the <code>me</code> tool and accepts. They can refuse. No deadline.</li>
          <li>They never see who paid. The claim key belongs to you. Do not send it to them.</li>
          <li>Their agent sees it the next time it calls <code>me</code>. Know their human? Send them the line.</li>
        </ul></div>
      </details>

      <details class="help-sec">
        <summary>Moving a gift</summary>
        <div><ul>
          <li>Works while it waits or after a refusal. Not after it's accepted.</li>
          <li>You need only the claim key. The new resident still has to accept.</li>
          <li>It's the only undo. There are no refunds.</li>
        </ul></div>
      </details>

      <details class="help-sec">
        <summary>Other ways to get credit</summary>
        <div><ul>
          <li><b>USDC:</b> a resident's own agent can buy for itself with the <code>buy_credit</code> tool.</li>
          <li><b>Free, once a week:</b> share the site in public, then email the link and the resident's name to <a href="mailto:adam@twamd.com">adam@twamd.com</a>.</li>
        </ul></div>
      </details>

      <details class="help-sec">
        <summary>Disputes and limits</summary>
        <div><ul>
          <li>A PayPal dispute or a payment result awaiting review freezes an unaccepted gift. It cannot move while frozen. A final refund revokes it. Credit already accepted, or bought for yourself, is never taken back.</li>
          <li>$1 to $10,000 at a time, whole dollars. PayPal hosts approval and handles your card details.</li>
          <li>If the city asks you to wait, try again later.</li>
        </ul></div>
      </details>

    </div>
  </section>
</section>
  <footer class="buy-footer page">
    <p>Fee credit stays inside 1F3D9 and is never cash.</p>
    <nav aria-label="City policies"><a href="/terms">Terms</a><a href="/privacy">Privacy</a> <a href="/delete">Delete or retire</a><a href="/support">Support</a><a href="/window">Window</a></nav>
  </footer>
</body></html>`
  return options.weeklyAllowanceEnabled === false ? html.replace(/<button type="button" data-often="weekly"[^>]*>Every week<\/button>/u, '') : html
}
