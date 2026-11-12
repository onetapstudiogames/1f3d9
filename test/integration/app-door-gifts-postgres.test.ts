// The app door accepts and refuses fee-credit gifts (decision #197) against real PostgreSQL:
// the real schema, the real gift routes, a real hosted pass for /mcp/app and /mcp/connect,
// and gifts made the way the website and a Google Play pack make them. Accept lands its
// credit once, refuse adds nothing, repeating changes nothing, another resident's gift stays
// out of reach, and me shows a waiting gift without anything more about who gave it than
// the chat door shows. The app door still cannot give a gift or add fee credit.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { Hono } from 'hono'
import { FOUNDER, GROWER, NEIGHBOUR, type CityApp, type Json } from '../helpers/abilities-fixtures.ts'
import { connectedDatabase, resetCity, startNoteSuiteDatabase } from '../helpers/note-suite-fixtures/postgres.ts'

// Loaded after the note-suite fixture mocks src/db.ts, so every read and write below is real SQL.
const { deliveredGift } = await import('../helpers/paypal-credit-dispute-fixtures/paypal-gift-custody.ts')

const RESIDENTS = [FOUNDER, GROWER, NEIGHBOUR] as const
const GIFT_UNITS = '3000000'
const PLAY_UNITS = '5000000'
// Written out, not imported, so this suite reads the same against the code before decision #197.
const NOT_WAITING = 'That gift is not waiting for this resident, or it was not found. Call me and send one gift_id from city_fee_credit.pending_gifts.'
const CANCELLED = 'This gift was cancelled and can never add credit. Nothing changed.'
const BANNED = /\$\s?\d|USDC|x402|X-PAYMENT|PayPal|\/buy|\bbuy|bought|buyer|purchase|wallet|dollar|treasury|https?:/iu
// What the gift parts of an app door answer must never name: a web route or how the gift was given.
const GIFT_PARTS_BANNED = /\/api\/|next_actions|source|blocked_reason|claim|capture|order/iu

type Door = '/mcp/app' | '/mcp/connect' | '/mcp'
type ToolAnswer = Readonly<{ isError: boolean; text: string; json: Json }>

const db = () => ({
  query: async (text: string, params: readonly unknown[] = []) => (await connectedDatabase().query(text, [...params])).rows,
})

async function balanceUnits(residentId: number): Promise<string> {
  const rows = (await connectedDatabase().query(
    'SELECT balance_units::text AS units FROM city_credit_accounts WHERE resident_id = $1', [residentId],
  )).rows as Array<{ units: string }>
  return rows[0]?.units ?? '0'
}

async function entryCount(residentId: number, kind: string): Promise<number> {
  const rows = (await connectedDatabase().query(
    'SELECT count(*)::int AS n FROM city_credit_entries WHERE resident_id = $1 AND entry_kind = $2', [residentId, kind],
  )).rows as Array<{ n: number }>
  return rows[0]!.n
}

async function giftStatus(publicId: string): Promise<string> {
  const rows = (await connectedDatabase().query(
    'SELECT status FROM city_credit_gifts WHERE public_id = $1', [publicId],
  )).rows as Array<{ status: string }>
  return rows[0]!.status
}

async function hostedToken(residentId: number, resource: string, seed: string): Promise<string> {
  const token = `1f3d9_at_${seed.repeat(64 / seed.length)}`
  const family = await connectedDatabase().query<{ id: string }>(`
    INSERT INTO oauth_token_families (resident_id, client_id, resource, scope, expires_at)
    VALUES ($1, 'app-door-gift-client', $2, 'city:resident', now() + interval '1 day') RETURNING id
  `, [residentId, resource])
  await connectedDatabase().query(
    `INSERT INTO oauth_tokens (token_hash, token_type, family_id, expires_at) VALUES ($1, 'access', $2, now() + interval '9 minutes')`,
    [createHash('sha256').update(token, 'utf8').digest('hex'), family.rows[0]!.id],
  )
  return token
}

async function playGift(recipientId: number, suffix: string): Promise<Readonly<{ giftId: string; buyer: string; transaction: string }>> {
  const { applyPlayPurchase, createPlayOrder } = await import('../../src/play-credit-store.ts')
  const buyer = `play-buyer-${suffix}`
  const transaction = `GPA.app-door-${suffix}`
  const order = await createPlayOrder(db(), {
    requestId: `app-door-play-${suffix}`, recipientId, productId: 'fee_credit_5_v1', appUserId: buyer, environment: 'production',
  })
  const outcome = await applyPlayPurchase(db(), {
    orderId: order.order.public_id, eventId: `app-door-play-event-${suffix}`, eventType: 'NON_RENEWING_PURCHASE',
    transactionId: transaction, productId: 'fee_credit_5_v1', environment: 'production', configuredEnvironment: 'production',
    purchasedAt: new Date(order.order.created_at).getTime() + 5_000, appUserIds: [buyer],
  })
  assert.equal(outcome, 'delivered')
  const rows = (await connectedDatabase().query(
    'SELECT public_id FROM city_credit_gifts WHERE source_key = $1', [`play:txn:${transaction}`],
  )).rows as Array<{ public_id: string }>
  return Object.freeze({ giftId: rows[0]!.public_id, buyer, transaction })
}

test('the app door accepts and refuses fee-credit gifts against real PostgreSQL (decision #197)', { timeout: 900_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('app-door-gifts')
  const previousSignin = process.env.HOSTED_CHAT_SIGNIN_ENABLED
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const { mcp } = await import('../../src/mcp.ts')
    const { configureOAuthResidentResolver } = await import('../../src/oauth.ts')
    const { oauthResourceFor } = await import('../../src/oauth-config.ts')
    configureOAuthResidentResolver()
    const hosted = new Hono()
    hosted.post('/mcp', c => mcp(c, app as unknown as Hono, { door: 'key' }))
    hosted.post('/mcp/connect', c => mcp(c, app as unknown as Hono, { hostedChat: true, forwardUnauthorizedStatus: true }))
    hosted.post('/mcp/app', c => mcp(c, app as unknown as Hono, { door: 'app', forwardUnauthorizedStatus: true }))

    let tokens: Readonly<Record<Door, string>>
    const reset = async () => {
      await resetCity(RESIDENTS)
      tokens = Object.freeze({
        '/mcp/app': await hostedToken(GROWER.id, oauthResourceFor('app'), 'ab'),
        '/mcp/connect': await hostedToken(GROWER.id, oauthResourceFor('connect'), 'cd'),
        '/mcp': GROWER.secret,
      })
    }
    const rpc = async (door: Door, body: Json, token: string | null = tokens[door]): Promise<Json> => {
      const response = await hosted.request(`http://city.test${door}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
      }, { outgoing: Object.assign(new EventEmitter(), { destroyed: false }) })
      const text = await response.text()
      assert.equal(response.status, 200, `${door} ${text}`)
      return JSON.parse(text) as Json
    }
    const tool = async (door: Door, name: string, args: Json = {}): Promise<ToolAnswer> => {
      const answer = await rpc(door, { method: 'tools/call', params: { name, arguments: args } })
      const result = answer.result as { isError: boolean; content: Array<{ text: string }> } | undefined
      assert.ok(result, JSON.stringify(answer))
      const text = result.content[0]!.text
      return Object.freeze({ isError: result.isError, text, json: JSON.parse(text) as Json })
    }
    const listed = async (door: Door): Promise<string[]> => (
      ((await rpc(door, { method: 'tools/list' })).result as { tools: Array<{ name: string }> }).tools.map(entry => entry.name)
    )
    const me = async (door: Door) => (await tool(door, 'me')).json as Record<string, any>

    await t.test('a website gift: me on the app door shows it, accept lands its credit once, and a repeat changes nothing', async () => {
      await reset()
      const gift = await deliveredGift(db(), GROWER.id)
      assert.equal(await balanceUnits(GROWER.id), '0')

      const before = await me('/mcp/app')
      assert.deepEqual(before.city_fee_credit.pending_gifts.map((item: Json) => Object.keys(item).sort()), [
        ['amount', 'amount_units', 'created_at', 'gift_id', 'status'],
      ])
      assert.equal(before.city_fee_credit.pending_gifts[0].gift_id, gift.giftId)
      assert.equal(before.city_fee_credit.pending_gifts[0].status, 'pending')
      assert.equal(before.city_fee_credit.pending_gifts[0].amount_units, GIFT_UNITS)
      assert.deepEqual(before.since_last_visit.fee_credit_received.pending_gifts, {
        count: 1, sentence: '1 fee-credit gift waits for an accept or refuse.',
      })
      const preflight = (await tool('/mcp/app', 'credit_preflight')).json
      assert.equal(preflight.pending_gifts_count, 1)

      const accepted = await tool('/mcp/app', 'credit_gift', { action: 'accept', gift_id: gift.giftId })
      assert.equal(accepted.isError, false, accepted.text)
      assert.deepEqual(accepted.json, { gift_id: gift.giftId, status: 'accepted', amount_units: GIFT_UNITS })
      assert.equal(await balanceUnits(GROWER.id), GIFT_UNITS)
      assert.equal(await entryCount(GROWER.id, 'gift_accept'), 1)

      const again = await tool('/mcp/app', 'credit_gift', { action: 'accept', gift_id: gift.giftId })
      assert.equal(again.isError, false, again.text)
      assert.deepEqual(again.json, accepted.json)
      assert.equal(await balanceUnits(GROWER.id), GIFT_UNITS)
      assert.equal(await entryCount(GROWER.id, 'gift_accept'), 1)

      const after = await me('/mcp/app')
      assert.deepEqual(after.city_fee_credit.pending_gifts, [])
      assert.deepEqual(after.since_last_visit.fee_credit_received.pending_gifts, { count: 0, sentence: null })
      assert.equal(after.city_fee_credit.balance, '3.000000')
      assert.ok(after.city_fee_credit.receipts.some((entry: Json) => entry.kind === 'received' && entry.amount_units === GIFT_UNITS))
      for (const part of [before.city_fee_credit.pending_gifts, before.since_last_visit.fee_credit_received, before.pages.pending_gifts]) {
        assert.doesNotMatch(JSON.stringify(part), GIFT_PARTS_BANNED)
      }
      for (const answer of [before, after, accepted.json, again.json, preflight]) {
        assert.doesNotMatch(JSON.stringify(answer), BANNED)
        assert.doesNotMatch(JSON.stringify(answer), new RegExp(`${gift.captureId}|${gift.claimToken}`, 'u'))
      }
    })

    await t.test('a Google Play pack gift is accepted on the app door, and neither door shows who gave it', async () => {
      await reset()
      const play = await playGift(GROWER.id, 'accept')
      const onApp = await me('/mcp/app')
      const onConnect = await me('/mcp/connect')
      const appItem = onApp.city_fee_credit.pending_gifts[0] as Json
      const connectItem = onConnect.city_fee_credit.pending_gifts[0] as Json
      assert.equal(appItem.gift_id, play.giftId)
      assert.equal(appItem.amount_units, PLAY_UNITS)
      // The app door shows a subset of what the chat door shows, and the chat door keeps the giver private.
      for (const [key, value] of Object.entries(appItem)) assert.deepEqual(connectItem[key], value, key)
      assert.equal(connectItem.buyer, 'private')
      for (const answer of [onApp, onConnect]) {
        const text = JSON.stringify(answer)
        assert.equal(text.includes(play.buyer), false)
        assert.equal(text.includes(play.transaction), false)
      }
      const accepted = await tool('/mcp/app', 'credit_gift', { action: 'accept', gift_id: play.giftId })
      assert.equal(accepted.isError, false, accepted.text)
      assert.equal(accepted.json.status, 'accepted')
      assert.equal(await balanceUnits(GROWER.id), PLAY_UNITS)
      assert.equal(await entryCount(GROWER.id, 'gift_accept'), 1)
    })

    await t.test('refusing on the app door adds nothing, a repeat changes nothing, and a refused gift cannot then be accepted', async () => {
      await reset()
      const gift = await deliveredGift(db(), GROWER.id)
      const refused = await tool('/mcp/app', 'credit_gift', { action: 'refuse', gift_id: gift.giftId })
      assert.equal(refused.isError, false, refused.text)
      assert.deepEqual(refused.json, { gift_id: gift.giftId, status: 'refused', amount_units: GIFT_UNITS })
      const again = await tool('/mcp/app', 'credit_gift', { action: 'refuse', gift_id: gift.giftId })
      assert.deepEqual(again.json, refused.json)
      assert.equal(await balanceUnits(GROWER.id), '0')
      assert.equal(await entryCount(GROWER.id, 'gift_refuse'), 1)
      const late = await tool('/mcp/app', 'credit_gift', { action: 'accept', gift_id: gift.giftId })
      assert.equal(late.isError, true)
      assert.equal(late.json.error, NOT_WAITING)
      assert.equal(await giftStatus(gift.giftId), 'refused')
      assert.equal(await balanceUnits(GROWER.id), '0')
      assert.deepEqual((await me('/mcp/app')).city_fee_credit.pending_gifts, [])
    })

    await t.test("another resident's gift cannot be accepted or refused through the app door", async () => {
      await reset()
      const gift = await deliveredGift(db(), NEIGHBOUR.id)
      for (const action of ['accept', 'refuse']) {
        const answer = await tool('/mcp/app', 'credit_gift', { action, gift_id: gift.giftId })
        assert.equal(answer.isError, true, action)
        assert.equal(answer.json.error, NOT_WAITING, action)
        assert.doesNotMatch(answer.text, BANNED)
      }
      assert.equal(await giftStatus(gift.giftId), 'pending')
      assert.equal(await balanceUnits(GROWER.id), '0')
      assert.equal(await balanceUnits(NEIGHBOUR.id), '0')
      assert.deepEqual((await me('/mcp/app')).city_fee_credit.pending_gifts, [])
    })

    await t.test('a cancelled Play gift is refused on the app door in its own words, and nothing lands', async () => {
      await reset()
      const play = await playGift(GROWER.id, 'refund')
      const { applyPlayPurchase } = await import('../../src/play-credit-store.ts')
      const order = (await connectedDatabase().query(
        "SELECT public_id, created_at FROM play_credit_orders WHERE request_id = 'app-door-play-refund'",
      )).rows[0] as { public_id: string; created_at: Date }
      assert.equal(await applyPlayPurchase(db(), {
        orderId: order.public_id, eventId: 'app-door-play-refund-event', eventType: 'CANCELLATION',
        transactionId: play.transaction, productId: 'fee_credit_5_v1', environment: 'production', configuredEnvironment: 'production',
        purchasedAt: new Date(order.created_at).getTime() + 5_000, appUserIds: [play.buyer],
      }), 'revoked')
      const answer = await tool('/mcp/app', 'credit_gift', { action: 'accept', gift_id: play.giftId })
      assert.equal(answer.isError, true)
      assert.equal(answer.json.error, CANCELLED)
      assert.doesNotMatch(answer.text, /refund|PayPal|dispute|payment/iu)
      assert.equal(await balanceUnits(GROWER.id), '0')
    })

    await t.test('the app door still cannot give a gift or add fee credit', async () => {
      await reset()
      const appTools = await listed('/mcp/app')
      assert.equal(appTools.length, 37)
      assert.ok(appTools.includes('credit_gift'))
      for (const name of ['buy_credit', 'payment_attempt', 'list_world', 'claim_world', 'cancel_world', 'reconcile_world', 'moderate']) {
        assert.equal(appTools.includes(name), false, name)
      }
      for (const name of ['buy_credit', 'payment_attempt']) {
        const answer = await rpc('/mcp/app', { method: 'tools/call', params: { name, arguments: { amount_usd: 1 } } })
        assert.equal((answer.error as Json | undefined)?.code, -32602, name)
      }
      const redirect = await tool('/mcp/app', 'credit_gift', { action: 'redirect', gift_id: `city_gift_${'c'.repeat(32)}` })
      assert.equal(redirect.isError, true)
      assert.match(redirect.text, /Use one of: accept, refuse\./u)
      assert.equal(await balanceUnits(GROWER.id), '0')
      assert.equal(Number((await connectedDatabase().query('SELECT count(*) FROM city_credit_gifts')).rows[0].count), 0)
    })

    await t.test('the chat door and the key door answer exactly as before', async () => {
      await reset()
      const gift = await deliveredGift(db(), GROWER.id)
      assert.equal((await listed('/mcp/connect')).length, 43)
      assert.equal((await listed('/mcp')).length, 44)
      for (const door of ['/mcp/connect', '/mcp'] as const) {
        const read = await me(door)
        const item = read.city_fee_credit.pending_gifts[0] as Json
        assert.deepEqual(Object.keys(item).sort(), ['amount', 'amount_units', 'buyer', 'created_at', 'gift_id', 'next_actions', 'source', 'status'])
        assert.ok((read.attention as string[]).includes(
          'You have 1 pending 1F3D9 fee-credit gift awaiting accept or refuse; see city_fee_credit.pending_gifts.',
        ), door)
        assert.match(read.since_last_visit.fee_credit_received.pending_gifts.items[0].sentence, /^A human bought you 3\.000000 fee credit\./u)
        assert.equal(Object.hasOwn((await tool(door, 'credit_preflight')).json, 'pending_gifts_count'), true)
      }
      const other = await tool('/mcp/connect', 'credit_gift', { action: 'accept', gift_id: `city_gift_${'d'.repeat(32)}` })
      assert.match(String(other.json.error), /^gift is not pending for this recipient or was not found; call me, or use \/api\/me if your client can open URLs/u)
      const accepted = await tool('/mcp/connect', 'credit_gift', { action: 'accept', gift_id: gift.giftId })
      assert.deepEqual(accepted.json, { gift_id: gift.giftId, status: 'accepted', amount_units: GIFT_UNITS })
      assert.equal(await balanceUnits(GROWER.id), GIFT_UNITS)
    })
  } finally {
    if (previousSignin === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
    else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previousSignin
    await postgres.stop()
  }
})
