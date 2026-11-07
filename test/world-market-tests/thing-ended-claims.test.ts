// Thing endings on claim_world and reconcile_world (T13), against the fake harness. A
// claim records a due end first; no new reservation, payment instructions or payment
// starts once the thing's end has come, or when it would come inside the five-minute
// window (E8); payment evidence already accepted keeps its sale (#32); reconcile records
// and goes on unchanged.
import assert from 'node:assert/strict'
import test from 'node:test'
import { makeHarness, jsonHeaders } from '../helpers/world-market-fixtures/harness.ts'
import {
  BUYER_SECRET,
  BUYER_WALLET,
  NOW,
  TX,
  X_PAYMENT,
  draft,
  openOffer,
  type FakeOffer,
  type FakeState,
} from '../helpers/world-market-fixtures/offers.ts'
import { ENDING_PURCHASE_REFUSAL } from '../../src/thing-ending-refusals.ts'

type Json = Record<string, unknown>

const reservation: Partial<FakeOffer> = {
  buyer_id: 8,
  buyer: 'neighbor',
  reserved_by: 8,
  buyer_wallet: BUYER_WALLET,
  market_listing_id: 91,
  market_checkout_id: 81,
  reserved_at: NOW.toISOString(),
  reserved_until: new Date(NOW.getTime() + 300_000).toISOString(),
}

const pendingEvidence: Partial<FakeOffer> = {
  ...reservation,
  reserved_at: '2026-08-12T11:57:00.000Z',
  reserved_until: '2026-08-12T12:02:00.000Z',
  pending_x402_tx_hash: TX,
  pending_x402_payer: BUYER_WALLET,
  pending_x402_at: '2026-08-12T11:58:00.000Z',
  x402_evidence_state: 'pending',
}

function harnessFor(offer: FakeOffer, patch: Partial<FakeState> = {}) {
  const marketReads: string[] = []
  const harness = makeHarness({ offer, thingLocked: true, ...patch }, async path => {
    marketReads.push(path)
    throw new Error(`no market read is expected here: ${path}`)
  })
  const claim = async (body: Json, payment?: string) => {
    const response = await harness.app.request('/api/world/offer/101/claim', {
      method: 'POST',
      headers: { ...jsonHeaders(BUYER_SECRET), ...(payment ? { 'x-payment': payment } : {}) },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() as Json }
  }
  return { harness, marketReads, claim }
}

const reserveQueries = (state: FakeState) => state.queries.filter(query => query.text.includes('world-market:reserve'))

export function registerThingEndedClaimTests(): void {
  test('a first claim on a thing whose end has come records it and refuses E8 before any market read', async () => {
    const { harness, marketReads, claim } = harnessFor(openOffer({ thing_ending_reached: true }))
    const answer = await claim({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET })
    assert.equal(answer.status, 409, JSON.stringify(answer.body))
    assert.equal(answer.body.error, ENDING_PURCHASE_REFUSAL)
    assert.deepEqual(harness.getRecordEndCalls(), [[41]], 'the claim records the due end first')
    assert.deepEqual(marketReads, [], 'a due thing costs no market call')
    assert.deepEqual(reserveQueries(harness.getState()), [], 'no reservation is tried')
  })

  test('a first claim on a thing whose end would come inside the window refuses E8', async () => {
    const { harness, marketReads, claim } = harnessFor(openOffer(), {
      claimEnd: { reached: false, within_window: true },
    })
    const answer = await claim({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET })
    assert.equal(answer.status, 409, JSON.stringify(answer.body))
    assert.equal(answer.body.error, ENDING_PURCHASE_REFUSAL)
    assert.deepEqual(marketReads, [])
    assert.deepEqual(reserveQueries(harness.getState()), [])
  })

  test('a reservation carries the end clause, and one it refuses answers E8, not the generic changed answer', async () => {
    const market = { draft: draft({ status: 'active', listing_id: 91, listing_state: 'active' }) }
    const ordinary = makeHarness({ offer: openOffer(), thingLocked: true, ...market })
    const opened = await ordinary.app.request('/api/world/offer/101/claim', {
      method: 'POST', headers: jsonHeaders(BUYER_SECRET),
      body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
    })
    assert.equal(opened.status, 402, await opened.clone().text())
    const [reserve] = reserveQueries(ordinary.getState())
    assert.match(reserve!.text, /things\.ended_at IS NULL/u)
    assert.match(reserve!.text, /thing_end_due_at_row\(things\) > clock_timestamp\(\) \+ interval '5 minutes'/u)

    // The end comes between the door's read and the UPDATE: the UPDATE writes nothing.
    const raced = makeHarness({ offer: openOffer(), thingLocked: true, ...market, reserveEndRefused: true })
    const refused = await raced.app.request('/api/world/offer/101/claim', {
      method: 'POST', headers: jsonHeaders(BUYER_SECRET),
      body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
    })
    assert.equal(refused.status, 409)
    assert.equal((await refused.json() as Json).error, ENDING_PURCHASE_REFUSAL)
  })

  test('an open window answers E8 instead of payment instructions once the end has come', async () => {
    const { harness, claim } = harnessFor(openOffer({ ...reservation, thing_ending_reached: true }))
    const answer = await claim({})
    assert.equal(answer.status, 409, JSON.stringify(answer.body))
    assert.equal(answer.body.error, ENDING_PURCHASE_REFUSAL)
    assert.equal(Object.hasOwn(answer.body, 'accepts'), false, 'no payment instructions')
    assert.deepEqual(harness.getRunPaymentInputs(), [])

    const active = harnessFor(openOffer({ ...reservation }))
    assert.equal((await active.claim({})).status, 402, 'a thing whose end is still to come gets its instructions')
  })

  test('a payment sent after the end came is refused E8 and never settles', async () => {
    const { harness, claim } = harnessFor(openOffer({ ...reservation, thing_ending_reached: true }))
    const answer = await claim({}, X_PAYMENT)
    assert.equal(answer.status, 409, JSON.stringify(answer.body))
    assert.equal(answer.body.error, ENDING_PURCHASE_REFUSAL)
    assert.deepEqual(harness.getRunPaymentInputs(), [], 'the payment is never verified or settled')
    assert.equal(harness.getState().facilitatorSettlements, 0)
    assert.equal(harness.getState().thingOwner, 7)
  })

  test('accepted payment evidence on a thing whose end has come keeps its sale (#32)', async () => {
    const { harness, claim } = harnessFor(openOffer({ ...pendingEvidence, thing_ending_reached: true }))
    const answer = await claim({})
    assert.notEqual(answer.body.error, ENDING_PURCHASE_REFUSAL, JSON.stringify(answer.body))
    assert.equal(answer.status, 200, JSON.stringify(answer.body))
    assert.equal(harness.getState().thingOwner, 8, 'the remnant moves whole to the buyer')
    assert.equal(harness.getState().directVerifications, 1, 'the recorded payment resumes; nothing is paid again')
  })

  test('reconcile records a due end and goes on unchanged', async () => {
    const { harness } = harnessFor(openOffer({ ...pendingEvidence, thing_ending_reached: true }))
    const response = await harness.app.request('/api/world/offer/101/reconcile', {
      method: 'POST', headers: jsonHeaders(BUYER_SECRET), body: '{}',
    })
    assert.equal(response.status, 200, await response.clone().text())
    assert.deepEqual(harness.getRecordEndCalls(), [[41]])
    assert.equal(harness.getState().thingOwner, 8)
  })
}
