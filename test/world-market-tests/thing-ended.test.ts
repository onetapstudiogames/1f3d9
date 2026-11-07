// Thing endings on the world offer reads and cancel_world (T12), against the fake
// harness: the end fields on every offer answer, the thing_ended phase after the payment
// phases and before reserved, a stored end that cannot be read never hides a real offer,
// reads never record an end while cancel records first, and a remnant's offer unlocks
// once the market listing reads thing_ended (the M1a listing answer).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { makeHarness, jsonHeaders } from '../helpers/world-market-fixtures/harness.ts'
import {
  BUYER_SECRET,
  BUYER_WALLET,
  NOW,
  SELLER_SECRET,
  SELLER_WALLET,
  TX,
  checkout,
  draft,
  openOffer,
  type FakeOffer,
} from '../helpers/world-market-fixtures/offers.ts'

type Json = Record<string, unknown>

// The facts the offer read selects for a kindless thing whose dated end passed an hour
// ago and is not yet recorded, owned and made by the seller, in a room it owns.
function dueFacts(overrides: Json = {}): Json {
  return {
    id: 41,
    kind_id: null,
    current_revision: null,
    as_kind_id: null,
    as_revision: null,
    owner_id: 7,
    maker_id: 7,
    parent_thing_id: null,
    ending_rule: { any: [{ at: '2026-08-12T11:00:00.000Z' }] },
    ending_grant: {
      kindless: true,
      allowed: ['at', 'after_setting_seconds', 'uses', 'idle_seconds', 'label_added'],
      limits: { max_seconds: 31_622_400, max_uses: 10_000, labels: null },
      city_limits_version: 1,
    },
    ending_set_by: 7,
    ending_set_at: '2026-08-12T10:00:00.000Z',
    ending_deadline: '2026-08-12T11:00:00.000Z',
    ending_idle_seconds: null,
    ending_idle_anchor: null,
    ending_uses_left: null,
    ending_uses_spent_at: null,
    ending_label: null,
    ending_copied_from: null,
    ending_copied_at: null,
    ended_at: null,
    ended_cause: null,
    end_program_state: 'none',
    end_program_result: null,
    first_label_at: null,
    set_by: { id: 7, handle: 'tiny-lantern' },
    owner_at_end: null,
    policy: null,
    kind_hidden: false,
    has_end_trait: false,
    traits: [],
    wake_enabled: true,
    held_by: null,
    in_sale: true,
    room: {
      owner_id: 7, wake_visitors: false, wake_pins: [], wake_block_thing_ids: [],
      wake_block_resident_ids: [], retired_at: null,
    },
    ...overrides,
  }
}

function dueOffer(overrides: Partial<FakeOffer> = {}): FakeOffer {
  return openOffer({
    thing_ending_facts: dueFacts(),
    thing_ending_reached: true,
    thing_ending_withdrawn: false,
    ...overrides,
  })
}

const pendingEvidence: Partial<FakeOffer> = {
  buyer_id: 8,
  buyer: 'neighbor',
  reserved_by: 8,
  buyer_wallet: BUYER_WALLET,
  market_listing_id: 91,
  market_checkout_id: 81,
  reserved_at: '2026-08-12T11:57:00.000Z',
  reserved_until: '2026-08-12T12:02:00.000Z',
  pending_x402_tx_hash: TX,
  pending_x402_payer: BUYER_WALLET,
  pending_x402_at: '2026-08-12T11:58:00.000Z',
  x402_evidence_state: 'pending',
}

async function readOffer(offer: FakeOffer | null): Promise<Readonly<{ status: number; body: Json; headers: Headers }>> {
  const harness = makeHarness({ offer, thingLocked: true })
  const response = await harness.app.request('/api/world/offer/101')
  return { status: response.status, body: await response.json() as Json, headers: response.headers }
}

export function registerThingEndedOfferTests(): void {
  test('a world offer read is no-store and carries the end fields of its thing', async () => {
    const plain = await readOffer(openOffer())
    assert.equal(plain.status, 200)
    assert.equal(plain.headers.get('cache-control'), 'no-store')
    const offer = plain.body.offer as Json
    assert.equal(offer.phase, 'listed')
    assert.equal(offer.asset_state, 'active')
    assert.equal(offer.ending, null, 'a row with no end facts reads no end')
    assert.equal(offer.end_program_summary, null)
    assert.equal(offer.ending_checked_at, NOW.toISOString())

    const active = await readOffer(openOffer({
      thing_ending_facts: dueFacts({
        ending_rule: { any: [{ at: '2026-08-20T00:00:00.000Z' }] },
        ending_deadline: '2026-08-20T00:00:00.000Z',
      }),
    }))
    const activeOffer = active.body.offer as Json
    assert.equal(activeOffer.phase, 'listed')
    assert.equal(activeOffer.asset_state, 'active')
    const ending = activeOffer.ending as Json
    assert.equal(ending.status, 'active')
    assert.equal(ending.permission_source, 'kindless_owner')
    assert.equal(ending.soonest_known_end, '2026-08-20T00:00:00.000Z')
    assert.equal(ending.checked_at, NOW.toISOString(), 'the end is judged at the database time of the read')
    assert.equal(activeOffer.end_program_summary, 'When this ends it becomes a remnant.')

    const hidden = makeHarness({ offer: openOffer(), thingLocked: true, thingModerated: true })
    const hiddenResponse = await hidden.app.request('/api/world/offer/101')
    assert.equal(hiddenResponse.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await hiddenResponse.json(), { offer: { id: 101, status: 'maintainer_hidden' } })
  })

  test('a due thing reads thing_ended after the payment phases and before reserved', async () => {
    const listed = (await readOffer(dueOffer())).body.offer as Json
    assert.equal(listed.phase, 'thing_ended')
    assert.equal(listed.asset_state, 'remnant')
    assert.equal((listed.ending as Json).status, 'due_waiting_settle')

    const reserved = (await readOffer(dueOffer({
      buyer_id: 8, buyer: 'neighbor', reserved_by: 8, buyer_wallet: BUYER_WALLET,
      market_listing_id: 91, market_checkout_id: 81,
      reserved_at: '2026-08-12T11:59:00.000Z', reserved_until: '2026-08-12T12:04:00.000Z',
    }))).body.offer as Json
    assert.equal(reserved.phase, 'thing_ended', 'the end wins over an open payment window')

    const pending = (await readOffer(dueOffer(pendingEvidence))).body.offer as Json
    assert.equal(pending.phase, 'payment_pending', 'accepted evidence keeps its payment phase')
    assert.equal(pending.asset_state, 'remnant')
    for (const [state, phase, extra] of [
      ['invalid', 'payment_invalid', { x402_invalid_reason: 'failed_transaction', x402_invalid_at: '2026-08-12T11:59:00.000Z' }],
      ['expired', 'payment_expired', {}],
      ['founder_review', 'founder_review', {}],
    ] as const) {
      const offer = (await readOffer(dueOffer({ ...pendingEvidence, x402_evidence_state: state, ...extra }))).body.offer as Json
      assert.equal(offer.phase, phase, state)
    }

    const claimed = (await readOffer(dueOffer({ status: 'claimed', claimed_at: '2026-08-12T11:30:00.000Z', locked: false }))).body.offer as Json
    assert.equal(claimed.phase, 'claimed')
    assert.equal(claimed.asset_state, 'remnant')
    const canceled = (await readOffer(dueOffer({ status: 'canceled', canceled_at: '2026-08-12T11:30:00.000Z', locked: false }))).body.offer as Json
    assert.equal(canceled.phase, 'canceled')

    const withdrawn = (await readOffer(dueOffer({
      status: 'canceled', canceled_at: '2026-08-12T11:30:00.000Z', locked: false, thing_ending_withdrawn: true,
    }))).body.offer as Json
    assert.equal(withdrawn.asset_state, 'withdrawn')
    assert.equal(withdrawn.ending, null)
    assert.equal(withdrawn.end_program_summary, null)
  })

  test('a stored end that cannot be read never hides a real offer or its claim checks', async () => {
    for (const facts of [
      dueFacts({ ending_rule: 'not a rule', ending_grant: 5, traits: 'none', room: 7, policy: [1], set_by: 'x' }),
      dueFacts({ ending_rule: { any: [{ at: 'never' }, 3, null] }, ending_deadline: 'soon', end_program_state: 'odd' }),
      'not an object',
      [1, 2, 3],
    ]) {
      const read = await readOffer(openOffer({ thing_ending_facts: facts }))
      assert.equal(read.status, 200, JSON.stringify(facts))
      const offer = read.body.offer as Json
      assert.equal(offer.phase, 'listed')
      assert.equal(offer.asset_state, 'active')
      assert.ok(offer.ending === null || typeof offer.ending === 'object', JSON.stringify(facts))

      const harness = makeHarness({
        offer: openOffer({ thing_ending_facts: facts }),
        thingLocked: true,
        checkout: checkout({ city_handle: 'someone-else' }),
        draft: draft({ status: 'active', listing_id: 91, listing_state: 'active' }),
      })
      const claim = await harness.app.request('/api/world/offer/101/claim', {
        method: 'POST', headers: jsonHeaders(BUYER_SECRET),
        body: JSON.stringify({ market_checkout_id: 81, buyer_wallet: BUYER_WALLET }),
      })
      assert.equal(claim.status, 403, 'the claim reaches its own checks, never not found')
    }
  })

  test('offer reads never record an end; cancel_world records the thing first', async () => {
    const harness = makeHarness({ offer: dueOffer(), thingLocked: true })
    await harness.app.request('/api/world/offer/101')
    assert.deepEqual(harness.getRecordEndCalls(), [], 'a read never records (#37)')
    const stranger = await harness.app.request('/api/world/offer/101/cancel', {
      method: 'POST', headers: jsonHeaders(BUYER_SECRET), body: '{}',
    })
    assert.equal(stranger.status, 403)
    assert.deepEqual(harness.getRecordEndCalls(), [], 'only the seller cancel records')
    await harness.app.request('/api/world/offer/101/cancel', {
      method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
    })
    assert.deepEqual(harness.getRecordEndCalls(), [[41]])
  })

  test('cancel_world unlocks a remnant once the market listing reads thing_ended', async () => {
    // The market's own listing answer for an ended thing, copied from 1F3EA PR #71 (M1a)
    // at d6d5ca5; its ids are set to this offer's, its states are used as they are.
    const fixture = JSON.parse(await readFile(
      new URL('../fixtures/m1a-world-thing-ended-listing.json', import.meta.url), 'utf8',
    )) as { listing: Json; draft: Json }
    const listing: Json = { ...fixture.listing, id: 91, world_offer_id: 101, world_draft_id: 71 }
    assert.equal(listing.state, 'thing_ended')
    assert.equal(listing.world_state, 'thing_ended')
    const harness = makeHarness({
      offer: dueOffer({ market_listing_id: 91 }),
      thingLocked: true,
      listing,
    })
    const response = await harness.app.request('/api/world/offer/101/cancel', {
      method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
    })
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(harness.getState().thingLocked, false)
    const offer = (await response.json() as { offer: Json }).offer
    assert.equal(offer.phase, 'canceled')
    assert.equal(offer.asset_state, 'remnant')

    // The draft path: no listing id on the offer, the market's draft for an ended thing.
    const draftHarness = makeHarness({
      offer: dueOffer(),
      thingLocked: true,
      draft: draft({
        status: fixture.draft.status, listing_id: 91, listing_state: fixture.draft.listing_state,
        seller_wallet: SELLER_WALLET,
      }),
    })
    const draftResponse = await draftHarness.app.request('/api/world/offer/101/cancel', {
      method: 'POST', headers: jsonHeaders(SELLER_SECRET), body: '{}',
    })
    assert.equal(draftResponse.status, 200, await draftResponse.clone().text())
    assert.equal(draftHarness.getState().thingLocked, false)
  })
}
