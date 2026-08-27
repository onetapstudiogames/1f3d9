// Interpolated inside CREDIT_BUY_JS's private IIFE. It uses the validated
// same-origin request helpers and the standalone gift-redirect form binding.
export const CREDIT_BUY_RETURN_CLIENT = `
  const completeReturn = async (purchaseId, paypalOrderId) => {
    showOnly(resultStep, resultHeading, 'paypal')
    resultNewPurchase.hidden = true
    statusLine.textContent = 'Checking PayPal capture. This request is safe to retry.'
    try {
      const payload = await postJson(
        orderPath + '/' + encodeURIComponent(purchaseId) + '/capture',
        { paypal_order_id: paypalOrderId },
      )
      const handle = cleanMessage(payload.resident_handle, 'the confirmed resident')
      const amount = cleanMessage(payload.amount_dollars, '')
      const delivery = payload.delivery
      resultGiftReceipt.hidden = true
      resultGiftId.textContent = ''
      resultHeading.textContent = delivery === 'gift' ? 'Gift purchase captured.' : 'Credit purchase complete.'
      if (delivery === 'gift') {
        const giftId = typeof payload.gift_id === 'string' ? payload.gift_id : ''
        if (!/^city_gift_[0-9a-f]{32}$/u.test(giftId)) {
          throw new Error('The city did not return the gift receipt ID. Do not start another payment; reload to retry this capture.')
        }
        resultGiftId.textContent = giftId
        resultGiftReceipt.hidden = false
        if (redirectGiftIdInput instanceof HTMLInputElement) redirectGiftIdInput.value = giftId
        resultMessage.textContent = 'The ' + amount + '-credit gift for @' + handle + ' is pending. It adds nothing until that resident accepts it in /api/me.'
      } else {
        resultMessage.textContent = amount + ' credits were added to @' + handle + '. The resident can read the durable receipt in /api/me.'
      }
      statusLine.textContent = ''
      resultNewPurchase.hidden = false
      history.replaceState(null, '', location.pathname)
    } catch (error) {
      statusLine.textContent = ''
      showError(error instanceof Error ? error.message : 'The PayPal return could not be checked. Reload this page to retry the same capture.')
      if (canRetryExactly(error)) {
        resultHeading.textContent = 'Capture not confirmed.'
        resultMessage.textContent = 'No new payment should be started. Reload this return page to retry the same capture safely.'
      } else {
        resultHeading.textContent = 'Capture needs resolution.'
        resultMessage.textContent = 'Do not pay again. Keep this return URL. Restore the matching saved purchase and PayPal order facts, or ask the city owner to resolve this same purchase.'
      }
    }
  }

  const query = new URLSearchParams(location.search)
  const purchaseId = query.get('purchase_id')
  const paypalOrderId = query.get('token')
  if (query.get('paypal') === 'return' && purchaseId && /^[A-Za-z0-9._:-]{1,128}$/u.test(purchaseId) && paypalOrderId && /^[A-Za-z0-9._:-]{1,128}$/u.test(paypalOrderId)) {
    void completeReturn(purchaseId, paypalOrderId)
  } else if (query.get('paypal') === 'allowance-return' && purchaseId && /^[A-Za-z0-9._:-]{1,128}$/u.test(purchaseId)) {
    showOnly(resultStep, resultHeading, 'paypal')
    resultNewPurchase.hidden = true
    resultHeading.textContent = 'Returned from allowance approval.'
    resultMessage.textContent = 'This return page does not prove payment. Credit arrives only after PayPal reports a completed weekly payment. Each successful payment will create a private /api/me receipt. Do not start another allowance until that completed payment and receipt are known.'
    history.replaceState(null, '', location.pathname)
  } else if ((query.get('paypal') === 'cancel' || query.get('paypal') === 'allowance-cancel') && purchaseId && /^[A-Za-z0-9._:-]{1,128}$/u.test(purchaseId)) {
    showOnly(resultStep, resultHeading, 'paypal')
    resultNewPurchase.hidden = true
    resultHeading.textContent = 'PayPal approval was cancelled.'
    resultMessage.textContent = 'Approval was cancelled in this browser tab. That does not prove whether another tab or a PayPal callback completed the payment. Do not start another payment yet. Keep this URL so the purchase ID remains available, and ask the city owner to resolve this same purchase before paying again.'
  }
`
