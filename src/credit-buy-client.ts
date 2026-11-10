import { BROWSER_IDENTITY_SCRIPT } from './browser-identity-ui.ts'
import { CREDIT_BUY_RETURN_CLIENT } from './credit-buy-return.ts'

export const CREDIT_BUY_JS = BROWSER_IDENTITY_SCRIPT + String.raw`
;(() => {
  'use strict'
  const root = document.querySelector('[data-credit-buy]')
  if (!root) return
  const $ = id => document.getElementById(id)
  const all = selector => Array.from(document.querySelectorAll(selector))
  const moveOnly = root.hasAttribute('data-gift-redirect-page')
  const FLOW = { own: ['who', 'amount', 'own-key'], gift: ['who', 'amount', 'gift-key'], move: ['move-key', 'move-to'] }
  const LABEL = { pending: 'Not accepted yet', refused: 'Refused. You can move it.', accepted: 'Accepted. It cannot move.', frozen: 'Frozen while the payment is reviewed. It cannot move.', revoked: 'Revoked. It cannot move.', unpaid: 'Not paid yet. Do not pay again.' }
  let state = { screen: moveOnly ? 'move-key' : 'choose', path: moveOnly ? 'move' : 'own', often: 'once', amount: '5', resident: null, destination: null, gift: null, fromWeekly: false, resultCanBuy: false }
  let pendingPurchaseRequest = null
  let preparedGift = null
  let pendingMove = null
  let busy = false
  let uncertain = false
  let returnLocked = false
  let helpFrom = null
  const validKey = value => /^1f3d9_sk_[0-9a-f]{48}$/.test(value)
  const validClaim = value => /^gift_claim_[0-9a-f]{64}$/.test(value)
  const validAmount = value => /^(?:[1-9][0-9]{0,3}|10000)$/.test(value)
  const set = patch => { state = { ...state, ...patch } }
  const showError = message => { $('buy-error').textContent = message; $('buy-error').hidden = false; $('buy-error').focus() }
  const clearError = () => { $('buy-error').hidden = true; $('buy-error').textContent = ''; $('buy-status').textContent = '' }
  const cleanMessage = (value, fallback) => typeof value === 'string' && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value) ? value : fallback
  const canRetryExactly = error => !Number.isInteger(error.httpStatus) || error.httpStatus === 429 || error.httpStatus >= 500
  const responseJson = async response => {
    let payload
    try { payload = await response.json() } catch { throw new Error('The reply could not be read. Try this step again.') }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('The reply could not be read. Try this step again.')
    if (!response.ok) {
      const message = response.status === 429 ? 'Please wait before trying again.' : cleanMessage(payload.error, 'This step could not finish.')
      const error = new Error(/request_id|retry ID|30.*hour|Retry-After/i.test(message) ? 'This step could not finish. Try it again with the same choices.' : message)
      error.httpStatus = response.status
      error.freshRequestRequired = payload.do_not_approve_old_order === true
      error.humanHref = payload.human_href
      throw error
    }
    return payload
  }
  const postJson = async (url, body, residentKey = null) => responseJson(await fetch(url, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'same-origin',
    headers: residentKey === null ? { 'content-type': 'application/json' } : { 'content-type': 'application/json', authorization: 'Bearer ' + residentKey },
    body: JSON.stringify(body),
  }))
  const requestId = prefix => prefix + '-' + crypto.randomUUID()
  const paypalUrl = value => {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && !url.username && !url.password && !url.port && ['www.paypal.com', 'www.sandbox.paypal.com'].includes(url.hostname) ? url.href : null
    } catch { return null }
  }
  const render = () => {
    const screen = state.screen
    root.hidden = screen === 'help'
    $('help').hidden = screen !== 'help'
    all('[data-slide]').forEach(el => { el.hidden = el.dataset.slide !== screen })
    all('[data-for]').forEach(el => { el.hidden = el.dataset.for !== state.path })
    all('[data-weekly]').forEach(el => { el.hidden = !(state.path === 'own' && state.often === 'weekly') })
    all('[data-once]').forEach(el => { el.hidden = !state.fromWeekly })
    const step = FLOW[state.path].indexOf(screen) + 1
    $('progress').textContent = step ? 'Step ' + step + ' of ' + FLOW[state.path].length : ''
    all('#dots i').forEach((dot, i) => { dot.hidden = !step || i >= FLOW[state.path].length; dot.classList.toggle('on', i < step) })
    $('carousel-title').textContent = screen === 'choose' ? 'Buy fee credits' : ({ own: 'For my resident', gift: 'A gift', move: 'Move a gift' })[state.path]
    $('back').hidden = ['choose', 'done'].includes(screen) || returnLocked || (moveOnly && screen === 'move-key')
    $('back').disabled = busy || uncertain
    const next = $('next')
    next.hidden = ['choose', 'trouble', 'help'].includes(screen) || (screen === 'done' && !state.resultCanBuy)
    next.textContent = ['own-key', 'gift-key'].includes(screen) ? 'PayPal >' : screen === 'move-to' ? 'Move gift' : screen === 'done' ? 'Buy more' : 'Next >'
    const canNext = { who: !!state.resident, amount: validAmount(state.amount), 'own-key': $('key-input').value.length > 0, 'gift-key': $('saved-claim').checked && !!preparedGift, 'move-key': !!state.gift && ['pending','refused'].includes(state.gift.status), 'move-to': !!state.destination, done: state.resultCanBuy }
    next.disabled = busy || !canNext[screen]
    $('who-found').hidden = !state.resident
    $('to-found').hidden = !state.destination
    $('gift-found').hidden = !state.gift
    for (const [prefix, resident] of [['who', state.resident], ['to', state.destination]]) {
      if (resident) { $(prefix + '-handle').textContent = '@' + (resident.displayHandle || resident.handle); $(prefix + '-number').textContent = 'Resident #' + resident.number }
    }
    all('.hname').forEach(el => { el.textContent = state.resident ? '@' + (state.resident.displayHandle || state.resident.handle) : 'your resident' })
    all('[data-amt]').forEach(el => { el.setAttribute('aria-pressed', String(el.dataset.amt === state.amount)) })
    all('[data-often]').forEach(el => { el.setAttribute('aria-pressed', String(el.dataset.often === state.often)) })
    $('total').textContent = validAmount(state.amount) ? state.amount + ' credits, $' + state.amount + (state.path === 'own' && state.often === 'weekly' ? ' a week' : '') : 'Pick 1 to 10000, whole numbers.'
    if (state.gift) { $('gift-summary').textContent = Number(state.gift.amount_usd) + ' credits for @' + (state.gift.recipient_display_handle || state.gift.recipient_handle); $('gift-status').textContent = LABEL[state.gift.status] }
    all('button,input').forEach(el => { if (!['next','back'].includes(el.id)) el.disabled = busy || (uncertain && !['key-input','key-input_file'].includes(el.id)) })
  }
  const go = screen => { clearError(); set({ screen }); render(); $('carousel-title').focus() }
  const run = async action => {
    if (busy) return
    busy = true; clearError(); render()
    try { await action() } catch (error) {
      showError(error instanceof Error ? error.message : 'This step could not finish. Try again.')
      if (error.humanHref === '/window') {
        const link = document.createElement('a'); link.href = '/window'; link.textContent = 'Open the city window.'; $('buy-error').append(' ', link)
      }
    } finally { busy = false; render() }
  }
  const lookup = async (input, path) => {
    const query = input.value.trim().toLowerCase()
    if (!/^(?:[1-9][0-9]{0,9}|@?[a-z0-9][a-z0-9-]{2,31})$/.test(query)) throw new Error('Enter a resident name or number. Use @ before an all-number name.')
    const payload = await responseJson(await fetch(path + '/' + encodeURIComponent(query), { credentials: 'same-origin', cache: 'no-store', redirect: 'error' }))
    const number = String(payload.resident_number || '')
    const handle = payload.resident_handle
    const matches = /^[1-9][0-9]{0,9}$/.test(query) ? number === query : handle === query.replace(/^@/, '')
    if (!/^[1-9][0-9]{0,9}$/.test(number) || !/^[a-z0-9][a-z0-9-]{2,31}$/.test(handle) || !matches) throw new Error('The resident did not match. Find them again before continuing.')
    return Object.freeze({ number, handle, displayHandle: payload.display_handle || handle })
  }
  const beginApproval = url => {
    $('claim-key').textContent = ''; $('key-input').value = ''; preparedGift = null
    history.replaceState(null, '', location.pathname)
    location.assign(url)
  }
  const prepare = async () => {
    const resident = state.resident
    const amount = state.amount
    const delivery = state.path === 'own' ? 'self' : 'gift'
    const terms = [state.often, delivery, resident?.number, resident?.handle, amount].join(':')
    if (!resident || !validAmount(amount)) throw new Error('Find the resident and choose an amount first.')
    if (delivery === 'gift' && preparedGift?.terms === terms) { go('gift-key'); return }
    let residentKey = $('key-input').value
    if (delivery === 'self' && !validKey(residentKey)) { $('key-wrong').hidden = false; return }
    if (pendingPurchaseRequest && pendingPurchaseRequest.terms !== terms && uncertain) throw new Error('Finish the previous try before changing the purchase.')
    if (!pendingPurchaseRequest || pendingPurchaseRequest.terms !== terms) pendingPurchaseRequest = Object.freeze({ terms, id: requestId(state.often === 'weekly' ? 'allowance' : 'purchase') })
    try {
      const common = { request_id: pendingPurchaseRequest.id, resident_number: resident.number, resident_handle: resident.handle, amount_dollars: amount }
      const payload = state.often === 'weekly' ? await postJson(root.dataset.allowancePath, common, residentKey) : await postJson(root.dataset.orderPath, { ...common, delivery }, delivery === 'self' ? residentKey : null)
      const url = paypalUrl(payload.approval_url)
      if (!url) throw new Error('PayPal could not be opened. Try this step again.')
      if (delivery === 'gift') {
        if (!validClaim(payload.claim_token)) throw new Error('The claim key could not be read. Try this step again.')
        preparedGift = Object.freeze({ terms, url, key: payload.claim_token })
        $('claim-key').textContent = preparedGift.key; $('saved-claim').checked = false
        uncertain = false; go('gift-key')
      } else { uncertain = false; beginApproval(url) }
    } catch (error) {
      uncertain = canRetryExactly(error)
      if (error.freshRequestRequired) { pendingPurchaseRequest = null; uncertain = false }
      if (delivery === 'self' && [401,403].includes(error.httpStatus)) {
        $('key-wrong').hidden = false; uncertain = false
      } else throw new Error(uncertain ? 'PayPal is not ready yet. Try this step again with the same choices. Do not pay again.' : error.message)
    } finally { $('key-input').value = ''; $('key-input_file').value = ''; residentKey = '' }
  }
  const findGift = async () => {
    const claim = $('move-claim').value.trim()
    if (!validClaim(claim)) throw new Error('Paste the saved claim key or pick its file.')
    const gift = await postJson('/api/city-credit/gifts/status', { claim_token: claim })
    if (!Object.hasOwn(LABEL, gift.status) || !/^[a-z0-9][a-z0-9-]{2,31}$/.test(gift.recipient_handle) || !/^(?:[1-9][0-9]{0,3}|10000)\.00$/.test(gift.amount_usd)) throw new Error('The gift could not be read. Try again.')
    set({ gift: Object.freeze(gift) })
  }
  const moveGift = async () => {
    const destination = state.destination
    const claim = $('move-claim').value.trim()
    if (!destination || !validClaim(claim)) throw new Error('Find the gift and the new resident first.')
    if (!pendingMove) pendingMove = Object.freeze({ claim_token: claim, recipient_number: destination.number, recipient_handle: destination.handle, request_id: requestId('gift-redirect') })
    try {
      const payload = await postJson('/api/city-credit/gifts/redirect', pendingMove)
      if (payload.status !== 'pending' || !/^city_gift_[0-9a-f]{32}$/.test(payload.gift_id)) throw new Error('The move could not be confirmed. Try this step again.')
      $('result-heading').textContent = 'Moved'
      $('result-message').textContent = Number(state.gift.amount_usd) + ' credits now for @' + destination.handle
      $('result-status').textContent = 'Waiting'; $('result-relay').hidden = false
      $('move-claim').value = ''; $('move-claim_file').value = ''; pendingMove = null; uncertain = false
      set({ resultCanBuy: !moveOnly }); $('result-done').hidden = !moveOnly; go('done')
    } catch (error) { uncertain = canRetryExactly(error); if (!uncertain) pendingMove = null; throw new Error(uncertain ? 'The move is not confirmed. Try this step again before choosing someone else.' : error.message) }
  }
  all('[data-path]').forEach(el => el.addEventListener('click', event => {
    event.preventDefault(); if (busy || uncertain || returnLocked) return
    const path = el.dataset.path
    $('key-input').value = ''; $('move-claim').value = ''; $('who-input').value = ''; $('to-input').value = ''; $('key-wrong').hidden = true
    set({ path, often: 'once', amount: '5', resident: null, destination: null, gift: null, fromWeekly: false })
    pendingPurchaseRequest = null; preparedGift = null; pendingMove = null; go(FLOW[path][0])
  }))
  all('[data-go]').forEach(el => el.addEventListener('click', event => {
    event.preventDefault(); if (busy) return
    const screen = el.dataset.go
    if (screen === 'choose') { go(helpFrom || (moveOnly ? 'move-key' : 'choose')); helpFrom = null }
    else { helpFrom = state.screen; go(screen) }
  }))
  all('[data-amt]').forEach(el => el.addEventListener('click', () => { $('amt-other').value = ''; set({ amount: el.dataset.amt }); render() }))
  all('[data-often]').forEach(el => el.addEventListener('click', () => { set({ often: el.dataset.often }); render() }))
  $('amt-other').addEventListener('input', () => { set({ amount: $('amt-other').value.trim() }); render() })
  $('key-input').addEventListener('input', () => { $('key-wrong').hidden = true; render() })
  $('saved-claim').addEventListener('change', render)
  $('who-input').addEventListener('input', () => { set({ resident: null }); render() })
  $('to-input').addEventListener('input', () => { if (uncertain) return; set({ destination: null }); pendingMove = null; render() })
  $('move-claim').addEventListener('input', () => { if (uncertain) return; set({ gift: null, destination: null }); pendingMove = null; render() })
  $('find').addEventListener('click', () => run(async () => { set({ resident: await lookup($('who-input'), root.dataset.residentLookup) }) }))
  $('find-to').addEventListener('click', () => run(async () => { set({ destination: await lookup($('to-input'), '/api/city-credit/gifts/residents') }) }))
  $('find-gift').addEventListener('click', () => run(findGift))
  for (const [id, input, button] of [['who','who-input','find'], ['to','to-input','find-to']]) {
    $(id + '-change').addEventListener('click', event => { event.preventDefault(); if (busy || uncertain) return; $(input).value = ''; $(input).dispatchEvent(new Event('input')); $(input).focus() })
    $(input).addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $(button).click() } })
  }
  $('make-gift').addEventListener('click', () => run(async () => { set({ path: 'gift', fromWeekly: state.often === 'weekly', often: 'once' }); pendingPurchaseRequest = null; await prepare() }))
  $('back').addEventListener('click', () => {
    if (busy || uncertain || returnLocked) return
    if (state.screen === 'trouble') { go(helpFrom || (moveOnly ? 'move-key' : 'choose')); helpFrom = null; return }
    const flow = FLOW[state.path]; const index = flow.indexOf(state.screen); go(index > 0 ? flow[index - 1] : moveOnly ? 'move-key' : 'choose')
  })
  $('next').addEventListener('click', () => run(async () => {
    if (state.screen === 'done') { if (state.resultCanBuy) location.assign('/buy'); return }
    if (state.screen === 'gift-key') { if ($('saved-claim').checked && preparedGift) beginApproval(preparedGift.url); return }
    if (state.screen === 'own-key' || (state.screen === 'amount' && state.path === 'gift')) { await prepare(); return }
    if (state.screen === 'move-to') { await moveGift(); return }
    const flow = FLOW[state.path]; const index = flow.indexOf(state.screen)
    if (index >= 0 && index < flow.length - 1) go(flow[index + 1])
  }))
  all('[data-copy-from]').forEach(el => el.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($(el.dataset.copyFrom).textContent); $('buy-status').textContent = 'Copied.' }
    catch { showError('Select the text and copy it. This browser could not copy it for you.') }
  }))
  $('dl-claim').addEventListener('click', () => {
    if (!preparedGift) return
    try {
      const url = URL.createObjectURL(new Blob([preparedGift.key + '\n'], { type: 'text/plain;charset=utf-8' }))
      const link = document.createElement('a'); link.href = url; link.download = '1f3d9-gift-claim-key.txt'; document.body.append(link); link.click(); link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000); $('buy-status').textContent = 'Download started. Keep the file private.'
    } catch { showError('Download did not work. Copy the key instead.') }
  })
  render()
` + CREDIT_BUY_RETURN_CLIENT + '\n})()'
