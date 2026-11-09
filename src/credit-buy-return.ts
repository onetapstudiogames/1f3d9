// Runs inside the buy carousel's private closure. A return never assumes that
// PayPal approval proves payment; exact capture is the only self-credit receipt.
export const CREDIT_BUY_RETURN_CLIENT = String.raw`
  const query = new URLSearchParams(location.search)
  const purchaseId = query.get('purchase_id')
  const paypalOrderId = query.get('token')
  const identifier = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
  const completeReturn = async () => {
    $('retry-return').hidden = true
    $('result-heading').textContent = 'Checking PayPal'
    $('result-message').textContent = 'Wait while PayPal confirms the payment.'
    $('result-status').textContent = 'Checking'
    try {
      const payload = await postJson(root.dataset.orderPath + '/' + encodeURIComponent(purchaseId) + '/capture', { paypal_order_id: paypalOrderId })
      if (!/^[a-z0-9][a-z0-9-]{2,31}$/.test(payload.resident_handle) || !/^(?:[1-9][0-9]{0,3}|10000)$/.test(payload.amount_dollars) || !['gift','self'].includes(payload.delivery)) throw new Error('The payment receipt could not be read.')
      const amount = payload.amount_dollars
      const handle = payload.display_handle || payload.resident_handle
      if (payload.delivery === 'gift') {
        if (!/^city_gift_[0-9a-f]{32}$/.test(payload.gift_id) || !['pending','accepted','refused','frozen','revoked'].includes(payload.status)) throw new Error('The gift receipt could not be read.')
        set({ path: 'gift' })
        $('result-heading').textContent = 'Gift bought'
        $('result-message').textContent = amount + ' credits for @' + handle
        $('result-status').textContent = LABEL[payload.status]
        $('result-gift-id').hidden = false; $('result-gift-id').textContent = 'Receipt ' + payload.gift_id
        $('result-relay').hidden = payload.status !== 'pending'
        $('result-gift-redirect-link').hidden = !['pending','refused'].includes(payload.status) || Boolean(payload.blocked_reason)
      } else {
        $('result-heading').textContent = 'Done'
        $('result-message').textContent = amount + ' credits added to @' + handle + '. Paid $' + amount + ' with PayPal.'
        $('result-status').textContent = 'Added'
      }
      set({ resultCanBuy: true }); returnLocked = false
      history.replaceState(null, '', location.pathname)
    } catch (error) {
      $('result-heading').textContent = 'Payment not confirmed'
      $('result-message').textContent = 'Do not pay again. Keep this return page. Try Retry, or email adam@twamd.com for help.'
      $('result-status').textContent = 'Needs checking'
      $('retry-return').hidden = !canRetryExactly(error)
      showError(cleanMessage(error.message, 'PayPal could not be checked.'))
    }
  }
  $('retry-return').addEventListener('click', () => run(completeReturn))
  if (!moveOnly && query.has('paypal')) {
    returnLocked = true; set({ resultCanBuy: false }); go('done')
    if (query.get('paypal') === 'return' && identifier(purchaseId) && identifier(paypalOrderId)) {
      void run(completeReturn)
    } else if (query.get('paypal') === 'allowance-return' && identifier(purchaseId)) {
      $('result-heading').textContent = 'Every week'
      $('result-message').textContent = 'Back from PayPal approval. Credit arrives after each completed payment. Stop it in PayPal. Do not start another allowance while the first payment is being checked.'
      $('result-status').textContent = 'Starts at first payment'; $('result-done').hidden = false
      history.replaceState(null, '', location.pathname)
    } else {
      $('result-heading').textContent = query.get('paypal') === 'cancel' || query.get('paypal') === 'allowance-cancel' ? 'PayPal approval cancelled' : 'Payment needs checking'
      $('result-message').textContent = 'This page does not prove whether a payment completed. Do not pay again. Keep this URL and email adam@twamd.com for help.'
      $('result-status').textContent = 'Needs checking'; $('result-done').hidden = false
    }
    render()
  }
`
