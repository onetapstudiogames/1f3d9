import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'
import type { FakePaymentAttempt } from '../helpers/routes-fixtures/state.ts'


export function registerDirectSalesTests(): void {
  const {
    AUTHORIZATION_NOW,
    BUYER_WALLET,
    OTHER_SECRET,
    SALE_X_PAYMENT,
    SELLER_WALLET,
    STRANGER_SALE_X_PAYMENT,
    STRANGER_WALLET,
    TX1,
    TX2,
    USDC,
    app,
    authHeaders,
    canonicalPaymentRequest,
    fixtureState,
    inserted,
    networkCalled,
    reset,
    setActor,
    sqlCalls,
    test,
  } = getRoutesTestContext()

  test('transfer offers name the first invalid field', async () => {
    const valid = {
      type: 'thing', id: 41, to_handle: 'neighbor', price_usdc: 2, seller_wallet: SELLER_WALLET,
    }
    for (const [field, value, expected] of [
      ['type', 'unknown', /^type must/iu],
      ['id', 0, /^id must/iu],
      ['to_handle', '', /^to_handle must/iu],
      ['price_usdc', 0, /^price_usdc must/iu],
      ['seller_wallet', 'bad', /^seller_wallet must/iu],
    ] as const) {
      reset({ scenario: 'transfers' })
      const response = await app.request('/api/transfer/offer', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ ...valid, [field]: value }),
      })
      assert.equal(response.status, 400, field)
      assert.match((await response.json() as { error: string }).error, expected, field)
    }
  })


  test('a gift moves immediately, while an open sale offer locks the asset', async () => {
    reset({ scenario: 'transfers' })
    const gift = await app.request('/api/transfer', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ type: 'thing', id: 41, to_handle: 'neighbor' }),
    })
    assert.equal(gift.status, 200, await gift.clone().text())
    const giftWrite = sqlCalls().find(call => /WITH\s+recipient[\s\S]*moved_asset/i.test(call.query ?? ''))
    assert.match(giftWrite?.query ?? '', /UPDATE\s+things\s+SET\s+owner_id\s*=\s*recipient\.id/i)
    assert.match(giftWrite?.query ?? '', /'resident_id'\s*,\s*\$3::?integer/iu)
    assert.match(giftWrite?.query ?? '', /'place_id'\s*,\s*actor_presence\.current_place_id/iu)
    assert.doesNotMatch(giftWrite?.query ?? '', /SET\s+maker_id\s*=/i)
    assert.doesNotMatch(giftWrite?.query ?? '', /SET[\s\S]*drawing_variant\s*=/i)
    assert.doesNotMatch(giftWrite?.query ?? '', /SET[\s\S]*current_revision\s*=/i)

    reset({ scenario: 'offer lock' })
    const offered = await app.request('/api/transfer/offer', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({
        type: 'thing', id: 41, to_handle: 'neighbor', price_usdc: 2, seller_wallet: SELLER_WALLET,
      }),
    })
    assert.equal(offered.status, 201)

    const lockedGift = await app.request('/api/transfer', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ type: 'thing', id: 41, to_handle: 'someone-else' }),
    })
    assert.equal(lockedGift.status, 409)
    assert.deepEqual(await lockedGift.json(), {
      error: 'this asset already has an open transfer offer; cancel or finish that offer before transferring the asset',
    })
  })

  test('a withdrawn thing cannot be gifted or offered for sale', async () => {
    reset({ scenario: 'withdrawn transfer', thingWithdrawn: true })
    const gift = await app.request('/api/transfer', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ type: 'thing', id: 41, to_handle: 'neighbor' }),
    })
    assert.equal(gift.status, 404)
    assert.deepEqual(await gift.json(), {
      error: 'thing_id 41 was not found; re-read the public thing record and send a current id',
    })

    const offer = await app.request('/api/transfer/offer', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({
        type: 'thing', id: 41, to_handle: 'neighbor', price_usdc: 2, seller_wallet: SELLER_WALLET,
      }),
    })
    assert.equal(offer.status, 404)
    assert.deepEqual(await offer.json(), {
      error: 'thing_id 41 was not found; re-read the public thing record and send a current id',
    })
    assert.equal(inserted('transfers'), 0)
    assert.equal(inserted('transfer_offers'), 0)
  })

  test('giving a place moves every nested place, blocks nested offers, and clears homes atomically', async () => {
    reset({ scenario: 'transfers' })
    const gift = await app.request('/api/transfer', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ type: 'place', id: 2, to_handle: 'neighbor' }),
    })
    assert.equal(gift.status, 200, await gift.clone().text())
    const body = await gift.json() as { attention: string[] }
    assert.deepEqual(body.attention, [
      'Your home was inside place_id 2 and was cleared when you transferred that place. Set a new home with home.',
    ])

    const write = sqlCalls().find(call => /society:place-gift-transfer/iu.test(call.query ?? ''))
    assert.ok(write)
    const rootLock = sqlCalls().find(call => /society:place-gift-lock-root/iu.test(call.query ?? ''))
    const childLock = sqlCalls().find(call => /society:place-gift-lock-children/iu.test(call.query ?? ''))
    assert.match(rootLock?.query ?? '', /where\s+id\s*=\s*\$1\s+for\s+update/iu)
    assert.match(childLock?.query ?? '', /parent_id\s*=\s*any[\s\S]*for\s+update\s+of\s+child/iu)
    assert.match(write.query ?? '', /locked_places[\s\S]*place\.id\s*=\s*any\(\$7::integer\[\]\)/iu)
    assert.match(write.query ?? '', /owner_id\s+is\s+distinct\s+from\s+\$4/iu)
    assert.match(write.query ?? '', /transfer_offers[\s\S]*status\s*=\s*'open'/iu)
    assert.match(write.query ?? '', /update\s+places[\s\S]*owner_id\s*=\s*recipient\.id/iu)
    assert.match(write.query ?? '', /update\s+resident_presence[\s\S]*home_place_id\s*=\s*null/iu)
    assert.match(write.query ?? '', /presence\.home_place_id\s+in\s*\(select\s+id\s+from\s+moved_asset\)/iu)
  })

  test('a nested place gift names the first blocking place and exact cause', async () => {
    for (const [scenario, placeId, cause] of [
      ['nested gift owner blocker', 17, 'its owner is not the gifting resident'],
      ['nested gift offer blocker', 18, 'it has an open transfer offer'],
    ] as const) {
      reset({ scenario })
      const response = await app.request('/api/transfer', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ type: 'place', id: 2, to_handle: 'neighbor' }),
      })
      assert.equal(response.status, 409)
      const body = await response.json() as { error: string }
      assert.equal(
        body.error,
        `place_id ${placeId} blocks this place gift because ${cause}; resolve that place before retrying`,
      )
    }
  })

  test('generic transfer claim and cancel routes cannot operate on a world offer', async () => {
    reset({
      scenario: 'world offer direct-route isolation',
      offer: { id: 90, channel: 'world', status: 'open', reservedUntil: null },
    })
    setActor(8, 'neighbor')
    const claim = await app.request('/api/transfer/90/claim', {
      method: 'POST', headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
    })
    assert.equal(claim.status, 404)

    setActor(7, 'tiny-lantern')
    const cancel = await app.request('/api/transfer/90/cancel', {
      method: 'POST', headers: authHeaders(),
    })
    assert.equal(cancel.status, 404)
    assert.equal(
      sqlCalls().some(call => /insert\s+into\s+resident_refusal_state/iu.test(call.query ?? '')),
      false,
      'sale claim and cancel refusals stay outside anti-loop state',
    )
    assert.equal(networkCalled('base-rpc.test'), false)
  })

  test('an unpaid buyer claim reserves five minutes and temporarily blocks seller cancellation', async () => {
    reset({
      scenario: 'reservation',
      chainFrom: BUYER_WALLET,
      chainTo: SELLER_WALLET,
      offer: { id: 90, status: 'open', reservedUntil: null },
    })
    setActor(8, 'neighbor')
    const claim = await app.request('/api/transfer/90/claim', {
      method: 'POST', headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
    })
    assert.equal(claim.status, 402)
    const challenge = await claim.json() as { accepts: { payTo: string; maxAmountRequired: string }[] }
    assert.equal(challenge.accepts[0]?.payTo.toLowerCase(), SELLER_WALLET)
    assert.equal(challenge.accepts[0]?.maxAmountRequired, '2000000')
    assert.ok(fixtureState.current.offer.reservedUntil)
    const remaining = Date.parse(fixtureState.current.offer.reservedUntil!) - Date.now()
    assert.ok(remaining > 4 * 60_000 && remaining <= 5 * 60_000)

    setActor(7, 'tiny-lantern')
    const blockedCancel = await app.request('/api/transfer/90/cancel', {
      method: 'POST', headers: authHeaders(),
    })
    assert.equal(blockedCancel.status, 409)

    fixtureState.current = { ...fixtureState.current, offer: { ...fixtureState.current.offer, reservedUntil: new Date(Date.now() - 1).toISOString() } }
    const canceled = await app.request('/api/transfer/90/cancel', { method: 'POST', headers: authHeaders() })
    assert.equal(canceled.status, 200)
  })

  test('a reserved buyer can retry with signed x402 and ownership closes atomically', async () => {
    reset({
      scenario: 'direct sale',
      chainFrom: BUYER_WALLET,
      chainTo: SELLER_WALLET,
      facilitatorVerify: true,
      facilitatorSettle: true,
      offer: { id: 90, status: 'open', reservedUntil: null },
    })
    setActor(8, 'neighbor')
    const reservation = await app.request('/api/transfer/90/claim', {
      method: 'POST', headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
    })
    assert.equal(reservation.status, 402)
    fixtureState.current = { ...fixtureState.current, chainAgeSeconds: 0 }
    const settled = await app.request('/api/transfer/90/claim', {
      method: 'POST', headers: { ...authHeaders(OTHER_SECRET), 'X-PAYMENT': SALE_X_PAYMENT },
      body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
    })
    assert.equal(settled.status, 200)
    const settledText = await settled.clone().text()
    const settledPaymentResponse = settled.headers.get('X-PAYMENT-RESPONSE')
    const body = await settled.json() as { offer: { status: string }; transfer: { to: string } }
    assert.equal(body.offer.status, 'claimed')
    assert.equal(body.transfer.to, 'neighbor')
    const settledWrite = sqlCalls().find(call =>
      /payment_uses/i.test(call.query ?? '') && /transfer_offers/i.test(call.query ?? '') && /update\s+things/i.test(call.query ?? ''))
    assert.ok(settledWrite)
    assert.match(settledWrite?.query ?? '', /UPDATE\s+things\s+SET\s+owner_id\s*=\s*offer\.actor_id/i)
    assert.doesNotMatch(settledWrite?.query ?? '', /SET\s+maker_id\s*=/i)

    const settlementsBeforeReplay = fixtureState.current.calls.filter(call => call.url.includes('/settle')).length
    const missingWallet = await app.request('/api/transfer/90/claim', {
      method: 'POST', headers: authHeaders(OTHER_SECRET), body: '{}',
    })
    assert.equal(missingWallet.status, 409)
    const changedWallet = await app.request('/api/transfer/90/claim', {
      method: 'POST', headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ buyer_wallet: STRANGER_WALLET }),
    })
    assert.equal(changedWallet.status, 409)

    const replay = await app.request('/api/transfer/90/claim', {
      method: 'POST', headers: { ...authHeaders(OTHER_SECRET), 'X-PAYMENT': SALE_X_PAYMENT },
      body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
    })
    assert.equal(replay.status, 200)
    assert.equal(await replay.text(), settledText)
    assert.equal(replay.headers.get('X-PAYMENT-RESPONSE'), settledPaymentResponse)
    assert.equal(fixtureState.current.calls.filter(call => call.url.includes('/settle')).length, settlementsBeforeReplay)
  })

  test('a completed direct-sale replay preserves its x402 response header', async () => {
    reset({
      scenario: 'direct sale',
      chainFrom: BUYER_WALLET,
      chainTo: SELLER_WALLET,
      facilitatorVerify: true,
      facilitatorSettle: true,
      offer: { id: 90, status: 'open', reservedUntil: null },
    })
    setActor(8, 'neighbor')
    const reservation = await app.request('/api/transfer/90/claim', {
      method: 'POST', headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
    })
    assert.equal(reservation.status, 402)

    const exactBody = '{\n  "transfer": {"id":91,"type":"thing","asset_id":42,"from":"tiny-lantern","to":"neighbor","price_usdc":2,"tx_hash":"' + TX1.toLowerCase() + '"},\n  "offer": {"status":"claimed","id":90}\n}'
    const storedHeader = Buffer.from('{"ok":true}', 'utf8').toString('base64')
    const completedAttempt: FakePaymentAttempt = {
      public_id: 'pay_' + '88'.repeat(32),
      actor_id: 8,
      counterparty_id: 7,
      operation: 'direct_sale',
      target_key: 'direct-sale:90',
      offer_id: 90,
      asset_type: 'thing',
      asset_id: 41,
      request_hash: canonicalPaymentRequest({
        offer_id: 90,
        buyer_wallet: BUYER_WALLET,
        seller_wallet: SELLER_WALLET,
        price_usdc: 2,
        asset_type: 'thing',
        asset_id: 41,
      }).hash,
      request_json: {
        offer_id: 90,
        buyer_wallet: BUYER_WALLET,
        seller_wallet: SELLER_WALLET,
        price_usdc: 2,
        asset_type: 'thing',
        asset_id: 41,
      },
      method: 'x402',
      network: 'base',
      token: USDC.toLowerCase(),
      payer_wallet: BUYER_WALLET.toLowerCase(),
      payee_wallet: SELLER_WALLET.toLowerCase(),
      amount_units: '2000000',
      x402_nonce: '0x' + 'cc'.repeat(32),
      x402_payload_digest: 'aa'.repeat(32),
      x402_valid_after: String(AUTHORIZATION_NOW - 120),
      x402_valid_before: String(AUTHORIZATION_NOW + 3600),
      start_block: '256',
      start_time: new Date(Date.now() - 60_000).toISOString(),
      end_time: new Date(Date.now() + 240_000).toISOString(),
      status: 'completed',
      lease_owner: null,
      lease_expires_at: null,
      tx_hash: TX1.toLowerCase(),
      finalized_block_number: '256',
      finalized_block_hash: TX2,
      finalized_block_time: new Date().toISOString(),
      finalized_at: new Date().toISOString(),
      invalid_reason: null,
      result_json: { kind: 'transfer_offer', id: 90 },
      response_status: 200,
      response_json: {
        __1f3d9_x402_response_v1: {
          header: storedHeader,
          body: {
            offer: { id: 90, status: 'claimed' },
            transfer: {
              id: 91,
              type: 'thing',
              asset_id: 42,
              from: 'tiny-lantern',
              to: 'neighbor',
              price_usdc: 2,
              tx_hash: TX1.toLowerCase(),
            },
          },
        },
      },
      response_body_bytes: Buffer.from(exactBody, 'utf8'),
      created_at: new Date(Date.now() - 60_000).toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    }
    fixtureState.current = {
      ...fixtureState.current,
      paymentAttempts: new Map([[completedAttempt.public_id, completedAttempt]]),
    }

    const replay = await app.request('/api/transfer/90/claim', {
      method: 'POST',
      headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
    })

    assert.equal(replay.status, 200, await replay.clone().text())
    assert.equal(await replay.text(), exactBody)
    assert.equal(replay.headers.get('X-PAYMENT-RESPONSE'), storedHeader)
    assert.equal(fixtureState.current.calls.filter(call => call.url.includes('/settle')).length, 0)
  })

  test('a completed direct-sale replay rejects a different buyer wallet without settling again', async () => {
    reset({
      scenario: 'direct sale',
      chainFrom: BUYER_WALLET,
      chainTo: SELLER_WALLET,
      facilitatorVerify: true,
      facilitatorSettle: true,
      offer: { id: 90, status: 'open', reservedUntil: null },
    })
    setActor(8, 'neighbor')
    const reservation = await app.request('/api/transfer/90/claim', {
      method: 'POST', headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
    })
    assert.equal(reservation.status, 402)
    fixtureState.current = { ...fixtureState.current, chainAgeSeconds: 0 }

    const settled = await app.request('/api/transfer/90/claim', {
      method: 'POST',
      headers: { ...authHeaders(OTHER_SECRET), 'X-PAYMENT': SALE_X_PAYMENT },
      body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
    })
    assert.equal(settled.status, 200, await settled.clone().text())
    const settlementsBeforeReplay = fixtureState.current.calls.filter(call => call.url.includes('/settle')).length

    const replay = await app.request('/api/transfer/90/claim', {
      method: 'POST',
      headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ buyer_wallet: STRANGER_WALLET }),
    })
    assert.equal(replay.status, 409, await replay.clone().text())
    assert.match(await replay.text(), /buyer_wallet does not match the settled payment/i)
    assert.equal(
      sqlCalls().some(call => /insert\s+into\s+resident_refusal_state/iu.test(call.query ?? '')),
      false,
      'a replay-bound refusal stays outside anti-loop state',
    )
    assert.equal(fixtureState.current.calls.filter(call => call.url.includes('/settle')).length, settlementsBeforeReplay)
  })

  test('raw transaction proof cannot create a payment window or bypass its buyer binding', async () => {
    reset({
      scenario: 'sale wallet binding', chainFrom: BUYER_WALLET, chainTo: SELLER_WALLET,
      chainAgeSeconds: 0, offer: { id: 90, status: 'open', reservedUntil: null },
    })
    setActor(8, 'neighbor')
    const premature = await app.request('/api/transfer/90/claim', {
      method: 'POST', headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ buyer_wallet: BUYER_WALLET, tx_hash: TX1 }),
    })
    assert.equal(premature.status, 400)
    assert.equal(fixtureState.current.offer.reservedUntil, null)
    assert.equal(networkCalled('base-rpc.test'), false)

    const reservation = await app.request('/api/transfer/90/claim', {
      method: 'POST', headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
    })
    assert.equal(reservation.status, 402)
    fixtureState.current = { ...fixtureState.current, chainFrom: STRANGER_WALLET, calls: [] }

    const mismatched = await app.request('/api/transfer/90/claim', {
      method: 'POST', headers: { ...authHeaders(OTHER_SECRET), 'X-PAYMENT': STRANGER_SALE_X_PAYMENT },
      body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
    })
    assert.equal(mismatched.status, 400)
    assert.equal(inserted('sale_payments'), 0)
    assert.equal(inserted('payment_uses'), 0)
    assert.equal(fixtureState.current.offer.status, 'open')
  })

  test('x402 payer must match the wallet bound to the active reservation', async () => {
    reset({
      scenario: 'x402 sale wallet binding', chainFrom: BUYER_WALLET, chainTo: SELLER_WALLET,
      facilitatorVerify: true, facilitatorSettle: true,
      offer: { id: 90, status: 'open', reservedUntil: null },
    })
    setActor(8, 'neighbor')
    const reservation = await app.request('/api/transfer/90/claim', {
      method: 'POST', headers: authHeaders(OTHER_SECRET),
      body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
    })
    assert.equal(reservation.status, 402)
    fixtureState.current = { ...fixtureState.current, chainFrom: STRANGER_WALLET, calls: [] }

    const mismatched = await app.request('/api/transfer/90/claim', {
      method: 'POST',
      headers: { ...authHeaders(OTHER_SECRET), 'X-PAYMENT': STRANGER_SALE_X_PAYMENT },
      body: JSON.stringify({ buyer_wallet: BUYER_WALLET }),
    })
    assert.equal(mismatched.status, 400)
    assert.equal(networkCalled('/settle'), false)
    assert.equal(inserted('sale_payments'), 0)
    assert.equal(fixtureState.current.offer.status, 'open')
    const attemptIndex = fixtureState.current.calls.findIndex(call => /insert\s+into\s+payment_attempts/i.test(call.query ?? ''))
    const settleIndex = fixtureState.current.calls.findIndex(call => call.url.includes('/settle'))
    assert.equal(attemptIndex, -1)
    assert.equal(settleIndex, -1)
  })
}
