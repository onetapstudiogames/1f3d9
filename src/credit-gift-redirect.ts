export const CREDIT_GIFT_REDIRECT_HTML = `<details class="redirect-panel">
      <summary>Redirect a pending or refused gift</summary>
      <div class="redirect-body">
        <p>A saved private claim key can move one unaccepted gift to another resident. The purchase stays inside the city and is never refunded.</p>
        <form id="gift-redirect-lookup-form" novalidate>
          <label for="redirect-gift-id">Gift receipt ID</label>
          <input
            id="redirect-gift-id"
            name="gift_id"
            type="text"
            autocomplete="off"
            spellcheck="false"
            pattern="city_gift_[0-9a-f]{32}"
            maxlength="42"
            aria-describedby="redirect-gift-help"
            required
          >
          <p id="redirect-gift-help" class="field-help">This is the public <code>city_gift_…</code> receipt ID, not a PayPal order ID.</p>

          <label for="redirect-claim-token">Private claim key</label>
          <input
            id="redirect-claim-token"
            name="claim_token"
            type="password"
            autocomplete="off"
            spellcheck="false"
            pattern="gift_claim_[0-9a-f]{64}"
            maxlength="75"
            aria-describedby="redirect-claim-help"
            required
          >
          <p id="redirect-claim-help" class="field-help">The key stays on this page until redirect is requested. It is never stored or sent during resident lookup.</p>

          <label for="redirect-request-id">Redirect retry ID</label>
          <input
            id="redirect-request-id"
            name="request_id"
            type="text"
            autocomplete="off"
            spellcheck="false"
            pattern="[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}"
            maxlength="128"
            aria-describedby="redirect-request-help"
            required
          >
          <p id="redirect-request-help" class="field-help">This non-secret ID makes an uncertain redirect safe to retry. Keep the same gift, key, destination, and same retry ID until the city confirms the result.</p>

          <label for="redirect-resident-number">New resident number</label>
          <div class="input-with-prefix redirect-number-input">
            <span aria-hidden="true">#</span>
            <input
              id="redirect-resident-number"
              name="recipient_number"
              type="text"
              inputmode="numeric"
              autocomplete="off"
              pattern="[1-9][0-9]{0,9}"
              maxlength="10"
              aria-describedby="redirect-resident-help"
              required
            >
          </div>
          <p id="redirect-resident-help" class="field-help">The destination handle will be shown before the gift moves. Check the new resident number carefully.</p>
          <button class="secondary-button" type="submit">Find the destination</button>
        </form>

        <div id="gift-redirect-confirm" class="redirect-confirm" hidden>
          <p>New recipient <strong id="redirect-confirmed-number"></strong> is</p>
          <strong id="redirect-confirmed-handle" class="handle" tabindex="-1"></strong>
          <p>Confirm this handle carefully. The resident must still accept the gift.</p>
          <div class="redirect-actions">
            <button id="change-redirect-destination" class="text-button" type="button">Change destination</button>
            <button id="confirm-gift-redirect" class="primary-button" type="button">Redirect this gift</button>
          </div>
        </div>

        <p id="gift-redirect-status" class="status-line" role="status" aria-live="polite"></p>
        <p id="gift-redirect-error" class="error-line" role="alert" tabindex="-1" hidden></p>
        <p id="gift-redirect-result" class="redirect-result" role="status" tabindex="-1" hidden></p>
      </div>
    </details>`

export const CREDIT_GIFT_REDIRECT_CSS = `
.redirect-panel {
  grid-column: 2;
  min-width: 0;
  background: rgba(255, 253, 247, 0.86);
  border: 2px solid var(--ink);
}
.redirect-panel summary {
  padding: 1rem 1.2rem;
  cursor: pointer;
  color: var(--forest-deep);
  font: 800 1.05rem/1.35 var(--serif);
}
.redirect-panel[open] summary { color: var(--paper-light); background: var(--forest); }
.redirect-body { padding: 0 1.2rem 1.4rem; }
.redirect-body > p:first-child { margin-top: 1.2rem; color: var(--muted); }
.redirect-body form { margin-top: 1.2rem; }
.redirect-body form > input { width: 100%; min-height: 3.2rem; padding: 0.7rem; color: var(--ink); background: var(--paper-light); border: 2px solid var(--ink); }
.redirect-number-input { max-width: 18rem; }
.redirect-confirm { margin-top: 1.4rem; padding: 1.1rem; color: var(--paper-light); background: var(--forest); border: 2px solid var(--ink); }
.redirect-confirm p { margin: 0; color: var(--sky); }
.redirect-confirm .handle { display: block; margin: 0.2rem 0 0.75rem; color: var(--signal); font: 800 clamp(1.5rem, 4vw, 2.2rem)/1.15 var(--serif); overflow-wrap: anywhere; }
.redirect-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.8rem; margin-top: 1rem; }
.redirect-actions .primary-button, .redirect-actions .text-button { margin-top: 0; }
.redirect-actions .text-button { color: var(--paper-light); }
.redirect-result { margin: 1.2rem 0 0; padding: 1rem; color: var(--paper-light); background: var(--forest); border-inline-start: 0.45rem solid var(--signal); }
@media (max-width: 50rem) { .redirect-panel { grid-column: 1; } }
`

// This fragment is interpolated inside CREDIT_BUY_JS's private IIFE. It reuses
// that script's bounded same-origin request, resident validation, and request-id helpers.
export const CREDIT_GIFT_REDIRECT_CLIENT = `
  const giftRedirectBasePath = '/api/city-credit/gifts'
  const redirectLookupForm = byId('gift-redirect-lookup-form')
  const redirectGiftIdInput = byId('redirect-gift-id')
  const redirectClaimTokenInput = byId('redirect-claim-token')
  const redirectRequestIdInput = byId('redirect-request-id')
  const redirectResidentNumberInput = byId('redirect-resident-number')
  const redirectConfirm = byId('gift-redirect-confirm')
  const redirectConfirmedNumber = byId('redirect-confirmed-number')
  const redirectConfirmedHandle = byId('redirect-confirmed-handle')
  const redirectStatus = byId('gift-redirect-status')
  const redirectError = byId('gift-redirect-error')
  const redirectResult = byId('gift-redirect-result')
  let redirectDestination = null
  let redirectInFlight = false
  if (redirectRequestIdInput instanceof HTMLInputElement) {
    redirectRequestIdInput.value = requestId('gift-redirect')
  }

  const redirectMessage = (element, message) => {
    element.textContent = message
    element.hidden = false
  }

  const clearRedirectMessages = () => {
    redirectStatus.textContent = ''
    redirectError.textContent = ''
    redirectError.hidden = true
    redirectResult.textContent = ''
    redirectResult.hidden = true
  }

  const validRedirectNumber = value => {
    if (!/^[1-9][0-9]{0,9}$/u.test(value)) return false
    const number = Number(value)
    return Number.isSafeInteger(number) && number <= 2147483647
  }

  const lockRedirectInputs = locked => {
    for (const input of [
      redirectGiftIdInput, redirectClaimTokenInput, redirectRequestIdInput,
      redirectResidentNumberInput,
    ]) {
      if (input instanceof HTMLInputElement) input.readOnly = locked
    }
  }

  redirectLookupForm.addEventListener('submit', async event => {
    event.preventDefault()
    clearRedirectMessages()
    redirectDestination = null
    redirectConfirm.hidden = true
    const giftId = redirectGiftIdInput instanceof HTMLInputElement ? redirectGiftIdInput.value.trim() : ''
    const claim = redirectClaimTokenInput instanceof HTMLInputElement ? redirectClaimTokenInput.value : ''
    const retryId = redirectRequestIdInput instanceof HTMLInputElement ? redirectRequestIdInput.value.trim() : ''
    const number = redirectResidentNumberInput instanceof HTMLInputElement ? redirectResidentNumberInput.value.trim() : ''
    if (!/^city_gift_[0-9a-f]{32}$/u.test(giftId)) {
      redirectMessage(redirectError, 'Enter the city_gift receipt ID from the purchase. Nothing was redirected.')
      redirectGiftIdInput.focus()
      return
    }
    if (!/^gift_claim_[0-9a-f]{64}$/u.test(claim)) {
      redirectMessage(redirectError, 'Enter the complete private claim key. Nothing was redirected.')
      redirectClaimTokenInput.focus()
      return
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/u.test(retryId)) {
      redirectMessage(redirectError, 'Enter the saved non-secret redirect retry ID. Nothing was redirected.')
      redirectRequestIdInput.focus()
      return
    }
    if (!validRedirectNumber(number)) {
      redirectMessage(redirectError, 'Enter one valid destination resident number. Nothing was redirected.')
      redirectResidentNumberInput.focus()
      return
    }
    const button = redirectLookupForm.querySelector('button[type="submit"]')
    setBusy(button, true, 'Finding destination…')
    try {
      const payload = await responseJson(await fetch(residentLookupPath + '/' + encodeURIComponent(number), {
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'same-origin',
      }))
      redirectDestination = exactResident(payload, number)
      redirectConfirmedNumber.textContent = '#' + redirectDestination.number
      redirectConfirmedHandle.textContent = '@' + redirectDestination.handle
      lockRedirectInputs(true)
      redirectConfirm.hidden = false
      redirectStatus.textContent = 'Destination found. Confirm the echoed handle before redirecting.'
      redirectConfirmedHandle.focus()
    } catch (error) {
      redirectMessage(redirectError, error instanceof Error
        ? error.message
        : 'The destination could not be checked. Nothing was redirected.')
    } finally {
      setBusy(button, false, '')
    }
  })

  byId('change-redirect-destination').addEventListener('click', () => {
    redirectDestination = null
    lockRedirectInputs(false)
    redirectConfirm.hidden = true
    redirectStatus.textContent = ''
    if (redirectRequestIdInput instanceof HTMLInputElement) {
      redirectRequestIdInput.value = requestId('gift-redirect')
    }
    redirectResidentNumberInput.focus()
  })

  byId('confirm-gift-redirect').addEventListener('click', async () => {
    if (redirectInFlight) return
    clearRedirectMessages()
    const giftId = redirectGiftIdInput instanceof HTMLInputElement ? redirectGiftIdInput.value.trim() : ''
    let rawClaimToken = redirectClaimTokenInput instanceof HTMLInputElement ? redirectClaimTokenInput.value : ''
    const redirectRequestId = redirectRequestIdInput instanceof HTMLInputElement
      ? redirectRequestIdInput.value.trim()
      : ''
    if (!redirectDestination || !/^city_gift_[0-9a-f]{32}$/u.test(giftId) || !/^gift_claim_[0-9a-f]{64}$/u.test(rawClaimToken) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/u.test(redirectRequestId)) {
      redirectMessage(redirectError, 'The gift, key, retry ID, and confirmed destination are required. Nothing was redirected.')
      return
    }
    const button = byId('confirm-gift-redirect')
    redirectInFlight = true
    setBusy(button, true, 'Redirecting gift…')
    try {
      const payload = await postJson(giftRedirectBasePath + '/' + encodeURIComponent(giftId) + '/redirect', {
        claim_token: rawClaimToken,
        recipient_number: redirectDestination.number,
        recipient_handle: redirectDestination.handle,
        request_id: redirectRequestId,
      })
      const responseGiftId = typeof payload.gift_id === 'string' ? payload.gift_id : ''
      if (responseGiftId !== giftId || payload.status !== 'pending') {
        throw new Error('The city returned an unexpected gift receipt. Do not submit a different redirect yet.')
      }
      redirectLookupForm.hidden = true
      redirectConfirm.hidden = true
      redirectStatus.textContent = ''
      redirectMessage(
        redirectResult,
        'Gift redirected to @' + redirectDestination.handle + '. It remains pending until that resident accepts it.',
      )
      if (redirectClaimTokenInput instanceof HTMLInputElement) redirectClaimTokenInput.value = ''
      rawClaimToken = ''
      redirectResult.focus()
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'The gift redirect could not be confirmed.'
      const status = error && Number.isInteger(error.httpStatus) ? error.httpStatus : null
      const canRetryExactly = status === null || status === 429 || status >= 500
      const terminalGuidance = error && error.doNotRetryWithChangedTerms === true
        ? ' Check the saved gift ID, private key, and current gift status before choosing another redirect. Do not reuse this retry ID with changed terms.'
        : ' Check the saved gift ID, private key, and current gift status before trying corrected terms.'
      redirectMessage(redirectError,
        message + (canRetryExactly
          ? ' Retry this exact redirect with the same gift, key, destination, and retry ID. Do not start a different redirect until this result is known.'
          : terminalGuidance))
      redirectError.focus()
    } finally {
      redirectInFlight = false
      setBusy(button, false, '')
    }
  })
`

export function renderCreditGiftRedirectPage(): string {
  const openRedirectForm = CREDIT_GIFT_REDIRECT_HTML.replace(
    '<details class="redirect-panel">',
    '<details class="redirect-panel" open>',
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
  <title>Redirect city fee credit · 1F3D9</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/gift-redirect.css">
  <script src="/gift-redirect.js" defer></script>
</head>
<body>
  <a class="skip-link" href="#redirect-main">Skip to gift redirect</a>
  <header class="redirect-masthead">
    <a href="/about">1F3D9</a>
    <a href="/window">City window</a>
  </header>
  <main id="redirect-main" class="redirect-shell" data-gift-redirect-page
    data-resident-lookup="/api/city-credit/gifts/residents">
    <div>
      <p class="kicker">Private gift recovery</p>
      <h1>Redirect an unaccepted fee-credit gift.</h1>
      <p>This door stays available even when new PayPal purchases are off. It needs the gift receipt ID and private claim key saved by the purchaser. It never refunds the purchase or reveals the buyer.</p>
    </div>
    ${openRedirectForm}
  </main>
</body>
</html>`
}

export const CREDIT_GIFT_REDIRECT_PAGE_CSS = `
:root { color-scheme: light; --ink:#0b1714; --forest:#183a30; --forest-deep:#0d2922; --paper:#f2ece0; --paper-light:#fffdf7; --sky:#dce9e3; --signal:#e2b85e; --muted:#5d625d; --serif:Georgia,serif; --sans:"Segoe UI",system-ui,sans-serif; --mono:Consolas,monospace; }
* { box-sizing: border-box; }
body { min-width:18rem; margin:0; color:var(--ink); background:var(--paper); font:1rem/1.55 var(--sans); }
.skip-link { position:absolute; inset-inline-start:1rem; top:-5rem; padding:.7rem; background:var(--paper-light); color:var(--ink); }
.skip-link:focus { top:1rem; }
.redirect-masthead { display:flex; justify-content:space-between; gap:1rem; padding:1rem clamp(1rem,5vw,4rem); color:var(--paper-light); background:var(--forest); }
.redirect-masthead a { color:inherit; font-weight:800; }
.redirect-shell { width:min(48rem,calc(100% - 2rem)); margin:clamp(2rem,8vw,6rem) auto; }
h1 { margin:.2rem 0 1rem; font:800 clamp(2rem,7vw,4.5rem)/1 var(--serif); }
.kicker { margin:0; color:var(--forest); font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
label { display:block; margin-top:1rem; font-weight:800; }
button { min-height:2.8rem; padding:.6rem 1rem; border:2px solid var(--ink); font:700 1rem var(--sans); cursor:pointer; }
.primary-button { color:var(--paper-light); background:var(--forest); }
.secondary-button { color:var(--ink); background:var(--signal); }
.text-button { color:var(--forest); background:transparent; border:0; text-decoration:underline; }
.field-help { margin:.35rem 0 0; color:var(--muted); }
.status-line,.error-line { margin-top:1rem; }
.error-line { padding:1rem; color:#fff; background:#7e291d; }
.handle { overflow-wrap:anywhere; }
code,input { font-family:var(--mono); }
${CREDIT_GIFT_REDIRECT_CSS}
.redirect-panel { grid-column:1; margin-top:2rem; }
@media (prefers-reduced-motion:reduce) { * { scroll-behavior:auto !important; } }
@media (forced-colors:active) { button,.redirect-panel { border:2px solid CanvasText; } }
`

export const CREDIT_GIFT_REDIRECT_PAGE_JS = `(() => {
  'use strict'
  const root = document.querySelector('[data-gift-redirect-page]')
  if (!(root instanceof HTMLElement)) return
  const residentLookupPath = root.dataset.residentLookup
  if (!residentLookupPath) return
  const byId = id => {
    const element = document.getElementById(id)
    if (!(element instanceof HTMLElement)) throw new Error('The gift redirect page is incomplete.')
    return element
  }
  const requestId = prefix => {
    if (!globalThis.crypto || typeof globalThis.crypto.randomUUID !== 'function') {
      throw new Error('This browser cannot create a safe redirect request.')
    }
    return prefix + '-' + globalThis.crypto.randomUUID()
  }
  const cleanMessage = (value, fallback) => typeof value === 'string'
    && value.length > 0 && value.length <= 300
    && !/[\\u0000-\\u001f\\u007f]/u.test(value) ? value : fallback
  const responseJson = async response => {
    let payload
    try { payload = await response.json() } catch {
      throw new Error('The city returned an unreadable redirect response. Do not start a different redirect yet.')
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('The city returned an unreadable redirect response. Do not start a different redirect yet.')
    }
    if (!response.ok) {
      const error = new Error(cleanMessage(payload.error, 'The city could not continue this redirect.'))
      error.httpStatus = response.status
      error.doNotRetryWithChangedTerms = payload.do_not_retry_with_changed_terms === true
      throw error
    }
    return payload
  }
  const exactResident = (payload, requestedNumber) => {
    const number = typeof payload.resident_number === 'string'
      ? payload.resident_number
      : String(payload.resident_number || '')
    const handle = payload.resident_handle
    if (number !== requestedNumber || typeof handle !== 'string' || !/^[a-z0-9][a-z0-9-]{2,31}$/u.test(handle)) {
      throw new Error('The city did not return the destination resident that was requested. Nothing was redirected.')
    }
    return Object.freeze({ number, handle })
  }
  const postJson = async (url, body) => responseJson(await fetch(url, {
    method:'POST', credentials:'same-origin', cache:'no-store', redirect:'error',
    referrerPolicy:'same-origin', headers:{ 'content-type':'application/json' },
    body:JSON.stringify(body),
  }))
  const setBusy = (button, busy, label) => {
    if (!(button instanceof HTMLButtonElement)) return
    if (busy) {
      button.dataset.label = button.textContent || ''
      button.textContent = label
      button.disabled = true
      button.setAttribute('aria-busy','true')
    } else {
      button.textContent = button.dataset.label || button.textContent
      button.disabled = false
      button.removeAttribute('aria-busy')
    }
  }
${CREDIT_GIFT_REDIRECT_CLIENT}
})()`
