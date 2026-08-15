import type { Context, Hono } from 'hono'
import { auth, err, HANDLE_RE, postgresErrorCode, WALLET_RE } from './core.ts'
import { sql } from './db.ts'
import { positiveId, publicLabel, publicText } from './input.ts'
import {
  canonicalTxHash,
  challenge402,
  classifyDirectPayment,
  paymentResponseHeader,
  requirements,
  settleX402,
  type DirectPaymentCheck,
  type PaymentRequirements,
  type Settled,
} from './pay.ts'

const CITY_ORIGIN = process.env.PUBLIC_ORIGIN ?? 'https://1f3d9.com'
const DEFAULT_MARKET_ORIGIN = 'https://1f3ea.com'
const MARKET_RESPONSE_BYTES = 256 * 1024
const MARKET_TIMEOUT_MS = 4_000

type JsonObject = Record<string, unknown>
type QueryRow = Record<string, unknown>

interface BridgeResident {
  id: number
  handle: string
}

interface DraftRecord {
  id: number
  status: 'pending' | 'active' | 'withdrawn' | 'sold' | 'expired' | 'canceled'
  assetId: number
  priceUsdc: number
  sellerWallet: string
  listingId: number | null
  listingState: string | null
  expiresAt: Date
  createdAt: Date
}

interface CheckoutRecord {
  id: number
  status: 'active' | 'expired' | 'completed'
  listingId: number
  offerId: number
  draftId: number
  cityHandle: string
  marketBuyer: string
  expiresAt: Date
  createdAt: Date
}

interface OfferRecord {
  id: number
  channel: 'world'
  asset_type: 'thing'
  asset_id: number
  asset_name: string
  seller_id: number
  seller: string
  buyer_id: number | null
  buyer: string | null
  price_usdc: number
  seller_wallet: string
  status: 'open' | 'claimed' | 'canceled'
  reserved_by: number | null
  buyer_wallet: string | null
  market_origin: string
  market_draft_id: number
  market_listing_id: number | null
  market_checkout_id: number | null
  market_buyer: string | null
  pending_x402_tx_hash: string | null
  pending_x402_payer: string | null
  pending_x402_at: string | null
  x402_evidence_state: 'none' | 'pending' | 'invalid'
  x402_invalid_reason: string | null
  x402_invalid_at: string | null
  reserved_at: string | null
  reserved_until: string | null
  created_at: string
  claimed_at: string | null
  canceled_at: string | null
  locked: boolean
  tx_hash: string | null
  verified_via: 'x402' | 'claim' | null
  block_time: string | null
  from: string | null
  to: string | null
}

export interface WorldMarketDependencies {
  query: (text: string, params: readonly unknown[]) => Promise<QueryRow[]>
  authenticate: (c: Context) => Promise<BridgeResident | null>
  now: () => Date
  marketOrigin: string
  marketGet: (path: string) => Promise<unknown>
  verifyDirectPayment: typeof classifyDirectPayment
  settleX402: (
    paymentHeader: string,
    accepted: PaymentRequirements,
  ) => Promise<Settled | { error: string }>
  paymentResponseHeader: typeof paymentResponseHeader
}

class MarketReadError extends Error {
  readonly kind: 'unavailable' | 'invalid'

  constructor(kind: 'unavailable' | 'invalid') {
    super(kind)
    this.kind = kind
  }
}

function object(value: unknown): JsonObject | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

async function jsonObject(c: Context): Promise<JsonObject | null> {
  return object(await c.req.json().catch(() => null))
}

function hasOnly(value: JsonObject, names: readonly string[]): boolean {
  return Object.keys(value).every(name => names.includes(name))
}

function timestamp(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function exactUsdc(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 10_000) {
    return null
  }
  return Math.round(value * 1_000_000) / 1_000_000 === value ? value : null
}

function wallet(value: unknown): string | null {
  return typeof value === 'string' && WALLET_RE.test(value) ? value.toLowerCase() : null
}

function draftRecord(
  payload: unknown,
  expectedId: number,
): DraftRecord | null {
  const envelope = object(payload)
  const draft = object(envelope?.draft)
  const asset = object(draft?.world_asset)
  if (!draft || !asset) return null
  const id = positiveId(draft.id)
  const assetId = positiveId(asset.id)
  const priceUsdc = exactUsdc(draft.price_usdc)
  const sellerWallet = wallet(draft.seller_wallet)
  const expiresAt = timestamp(draft.expires_at)
  const createdAt = timestamp(draft.created_at)
  const listingId = draft.listing_id == null ? null : positiveId(draft.listing_id)
  const listingState = draft.listing_state == null
    ? null
    : typeof draft.listing_state === 'string' ? draft.listing_state : null
  const statuses = new Set(['pending', 'active', 'withdrawn', 'sold', 'expired', 'canceled'])
  const status = typeof draft.status === 'string' && statuses.has(draft.status)
    ? draft.status as DraftRecord['status']
    : null
  const title = publicLabel(draft.title, 200)
  const description = publicText(draft.description, { allowEmpty: true, maximumBytes: 65_536 })
  const preview = publicText(draft.preview, { allowEmpty: true, maximumBytes: 65_536 })
  if (
    id !== expectedId || asset.type !== 'thing' || !assetId ||
    draft.delivery_kind !== 'city_ownership' || !status || priceUsdc == null ||
    !sellerWallet || !expiresAt || !createdAt || createdAt >= expiresAt ||
    !title || description == null || preview == null ||
    (draft.listing_id != null && listingId == null) ||
    (draft.listing_state != null && listingState == null)
  ) return null
  return {
    id,
    status,
    assetId,
    priceUsdc,
    sellerWallet,
    listingId,
    listingState,
    expiresAt,
    createdAt,
  }
}

function checkoutRecord(payload: unknown, expectedId: number): CheckoutRecord | null {
  const envelope = object(payload)
  const checkout = object(envelope?.checkout)
  if (!checkout) return null
  const id = positiveId(checkout.id)
  const listingId = positiveId(checkout.listing_id)
  const offerId = positiveId(checkout.world_offer_id)
  const draftId = positiveId(checkout.market_draft_id)
  const expiresAt = timestamp(checkout.expires_at)
  const createdAt = timestamp(checkout.created_at)
  const cityHandle = typeof checkout.city_handle === 'string' && HANDLE_RE.test(checkout.city_handle)
    ? checkout.city_handle
    : null
  const marketBuyer = publicLabel(checkout.market_buyer, 120)
  const status = ['active', 'expired', 'completed'].includes(String(checkout.status))
    ? checkout.status as CheckoutRecord['status']
    : null
  if (
    id !== expectedId || !status || !listingId || !offerId || !draftId ||
    !cityHandle || !marketBuyer || !expiresAt || !createdAt || createdAt >= expiresAt
  ) return null
  return {
    id,
    status,
    listingId,
    offerId,
    draftId,
    cityHandle,
    marketBuyer,
    expiresAt,
    createdAt,
  }
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MARKET_RESPONSE_BYTES) {
    throw new MarketReadError('invalid')
  }
  if (!response.body) throw new MarketReadError('invalid')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    bytes += next.value.byteLength
    if (bytes > MARKET_RESPONSE_BYTES) {
      await reader.cancel()
      throw new MarketReadError('invalid')
    }
    chunks.push(next.value)
  }
  const body = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new MarketReadError('invalid')
  }
}

async function publicMarketGet(origin: string, path: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${origin}${path}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(MARKET_TIMEOUT_MS),
    })
  } catch {
    throw new MarketReadError('unavailable')
  }
  if (!response.ok) throw new MarketReadError('unavailable')
  return readLimitedJson(response)
}

function configuredMarketOrigin(): string {
  const raw = process.env.MARKET_ORIGIN ?? DEFAULT_MARKET_ORIGIN
  const parsed = new URL(raw)
  if (parsed.protocol !== 'https:' || parsed.origin !== raw.replace(/\/$/u, '')) {
    throw new Error('MARKET_ORIGIN must be an HTTPS origin with no path')
  }
  return parsed.origin
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function integerValue(value: unknown): number | null {
  const parsed = numberValue(value)
  return parsed != null && Number.isSafeInteger(parsed) ? parsed : null
}

function nullableInteger(value: unknown): number | null {
  return value == null ? null : integerValue(value)
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value)
}

function offerRecord(row: QueryRow | undefined): OfferRecord | null {
  if (!row) return null
  const id = integerValue(row.id)
  const assetId = integerValue(row.asset_id)
  const sellerId = integerValue(row.seller_id)
  const buyerId = nullableInteger(row.buyer_id)
  const priceUsdc = numberValue(row.price_usdc)
  const marketDraftId = integerValue(row.market_draft_id)
  const sellerWallet = wallet(row.seller_wallet)
  const buyerWallet = row.buyer_wallet == null ? null : wallet(row.buyer_wallet)
  const from = row.from == null ? null : wallet(row.from)
  const to = row.to == null ? null : wallet(row.to)
  const pendingHash = row.pending_x402_tx_hash == null
    ? null
    : canonicalTxHash(row.pending_x402_tx_hash)
  const pendingPayer = row.pending_x402_payer == null ? null : wallet(row.pending_x402_payer)
  const marketBuyer = row.market_buyer == null ? null : publicLabel(row.market_buyer, 120)
  const evidenceState = String(row.x402_evidence_state ?? 'none')
  const invalidReason = nullableString(row.x402_invalid_reason)
  const invalidAt = nullableString(row.x402_invalid_at)
  const evidenceConsistent = evidenceState === 'none'
    ? pendingHash == null && pendingPayer == null && row.pending_x402_at == null &&
      invalidReason == null && invalidAt == null
    : evidenceState === 'pending'
      ? pendingHash != null && pendingPayer != null && row.pending_x402_at != null &&
        invalidReason == null && invalidAt == null
      : evidenceState === 'invalid' && pendingHash != null && pendingPayer != null &&
        row.pending_x402_at != null &&
        ['failed_transaction', 'confirmed_mismatch'].includes(String(invalidReason)) && invalidAt != null
  if (
    !id || row.channel !== 'world' || row.asset_type !== 'thing' || !assetId || !sellerId ||
    priceUsdc == null || !marketDraftId || !sellerWallet ||
    (row.buyer_id != null && buyerId == null) ||
    (row.buyer_wallet != null && buyerWallet == null) ||
    (row.pending_x402_tx_hash != null && pendingHash == null) ||
    (row.pending_x402_payer != null && pendingPayer == null) ||
    (row.market_buyer != null && marketBuyer == null) ||
    ((buyerId == null) !== (marketBuyer == null)) ||
    ((pendingHash == null) !== (pendingPayer == null)) ||
    ((pendingHash == null) !== (row.pending_x402_at == null)) ||
    !evidenceConsistent ||
    (row.from != null && from == null) || (row.to != null && to == null) ||
    !['open', 'claimed', 'canceled'].includes(String(row.status))
  ) return null
  return {
    id,
    channel: 'world',
    asset_type: 'thing',
    asset_id: assetId,
    asset_name: String(row.asset_name ?? ''),
    seller_id: sellerId,
    seller: String(row.seller ?? ''),
    buyer_id: buyerId,
    buyer: nullableString(row.buyer),
    price_usdc: priceUsdc,
    seller_wallet: sellerWallet,
    status: String(row.status) as OfferRecord['status'],
    reserved_by: nullableInteger(row.reserved_by),
    buyer_wallet: buyerWallet,
    market_origin: String(row.market_origin ?? ''),
    market_draft_id: marketDraftId,
    market_listing_id: nullableInteger(row.market_listing_id),
    market_checkout_id: nullableInteger(row.market_checkout_id),
    market_buyer: marketBuyer,
    pending_x402_tx_hash: pendingHash,
    pending_x402_payer: pendingPayer,
    pending_x402_at: nullableString(row.pending_x402_at),
    x402_evidence_state: evidenceState as OfferRecord['x402_evidence_state'],
    x402_invalid_reason: invalidReason,
    x402_invalid_at: invalidAt,
    reserved_at: nullableString(row.reserved_at),
    reserved_until: nullableString(row.reserved_until),
    created_at: String(row.created_at ?? ''),
    claimed_at: nullableString(row.claimed_at),
    canceled_at: nullableString(row.canceled_at),
    locked: row.locked === true,
    tx_hash: nullableString(row.tx_hash),
    verified_via: row.verified_via == null
      ? null
      : String(row.verified_via) as OfferRecord['verified_via'],
    block_time: nullableString(row.block_time),
    from,
    to,
  }
}

async function readOffer(
  dependencies: WorldMarketDependencies,
  offerId: number,
): Promise<OfferRecord | null> {
  const rows = await dependencies.query(`
    /* world-market:read-offer */
    SELECT o.id, o.channel, o.asset_type, o.asset_id, thing.name AS asset_name,
      o.seller_id, seller.handle AS seller, o.buyer_id, buyer.handle AS buyer,
      o.price_usdc::float8 AS price_usdc, lower(o.seller_wallet) AS seller_wallet,
      o.status, o.reserved_by, lower(o.buyer_wallet) AS buyer_wallet,
      o.market_origin, o.market_draft_id, o.market_listing_id, o.market_checkout_id,
      o.market_buyer,
      o.pending_x402_tx_hash, lower(o.pending_x402_payer) AS pending_x402_payer,
      o.pending_x402_at, o.x402_evidence_state, o.x402_invalid_reason, o.x402_invalid_at,
      o.reserved_at, o.reserved_until, o.created_at, o.claimed_at, o.canceled_at,
      (
        o.status = 'open' AND thing.owner_id = o.seller_id
        AND thing.withdrawn_at IS NULL AND thing.active_offer_id = o.id
      ) AS locked,
      payment.tx_hash, payment.verified_via, payment.block_time,
      lower(payment.payer_wallet) AS "from", lower(payment.payee_wallet) AS "to"
    FROM transfer_offers o
    JOIN things thing ON thing.id = o.asset_id
    JOIN residents seller ON seller.id = o.seller_id
    LEFT JOIN residents buyer ON buyer.id = o.buyer_id
    LEFT JOIN sale_payments payment ON payment.offer_id = o.id
    WHERE o.id = $1 AND o.channel = 'world' AND o.asset_type = 'thing'
  `, [offerId])
  return offerRecord(rows[0])
}

function reservationActive(offer: OfferRecord, now: Date): boolean {
  const start = timestamp(offer.reserved_at)
  const end = timestamp(offer.reserved_until)
  return offer.status === 'open' && offer.buyer_id != null && offer.reserved_by === offer.buyer_id &&
    offer.buyer_wallet != null && start != null && end != null &&
    start <= now && end > now && end.getTime() - start.getTime() === 300_000
}

function paymentPending(offer: OfferRecord): boolean {
  return offer.status === 'open' && offer.x402_evidence_state === 'pending' && offer.pending_x402_tx_hash != null &&
    offer.pending_x402_payer != null && offer.pending_x402_at != null
}

function paymentInvalid(offer: OfferRecord): boolean {
  return offer.status === 'open' && offer.x402_evidence_state === 'invalid' &&
    offer.pending_x402_tx_hash != null && offer.x402_invalid_reason != null &&
    offer.x402_invalid_at != null
}

function publicOffer(offer: OfferRecord, now: Date) {
  const phase = offer.status === 'claimed'
    ? 'claimed'
    : offer.status === 'canceled'
      ? 'canceled'
      : offer.x402_evidence_state === 'invalid' ? 'payment_invalid'
      : offer.pending_x402_tx_hash != null ? 'payment_pending'
      : reservationActive(offer, now) ? 'reserved' : 'listed'
  return {
    id: offer.id,
    channel: 'world' as const,
    phase,
    asset_type: 'thing' as const,
    asset_id: offer.asset_id,
    asset_name: offer.asset_name,
    locked: offer.locked,
    seller: offer.seller,
    buyer: offer.buyer,
    price_usdc: offer.price_usdc,
    seller_wallet: offer.seller_wallet,
    market_origin: offer.market_origin,
    market_draft_id: offer.market_draft_id,
    market_listing_id: offer.market_listing_id,
    market_checkout_id: offer.market_checkout_id,
    market_buyer: offer.market_buyer,
    pending_x402_tx_hash: offer.pending_x402_tx_hash,
    pending_x402_at: offer.pending_x402_at,
    x402_invalid_reason: offer.x402_invalid_reason,
    x402_invalid_at: offer.x402_invalid_at,
    reserved_at: offer.reserved_at,
    reserved_until: offer.reserved_until,
    created_at: offer.created_at,
    claimed_at: offer.claimed_at,
    canceled_at: offer.canceled_at,
    tx_hash: offer.tx_hash,
    buyer_wallet: offer.buyer_wallet,
    verified_via: offer.verified_via,
    block_time: offer.block_time,
    from: offer.from,
    to: offer.to,
  }
}

function challenge(c: Context, offer: OfferRecord) {
  const accepted = requirements(
    offer.seller_wallet,
    offer.price_usdc,
    `${CITY_ORIGIN}/api/world/offer/${offer.id}/claim`,
    `1F3D9 world offer ${offer.id}`,
  )
  return challenge402(
    c,
    accepted,
    `active five-minute reservation: pay $${offer.price_usdc} USDC from ${offer.buyer_wallet} and retry with X-PAYMENT or tx_hash`,
  )
}

function pending202(c: Context, offer: OfferRecord, now: Date, responseHeader?: string | null) {
  if (responseHeader) c.header('X-PAYMENT-RESPONSE', responseHeader)
  return c.json({
    offer: publicOffer(offer, now),
    note: 'payment settled; the thing stays locked while the city waits for the public Base transfer',
    retry: 'the same resident may retry this claim without another payment',
  }, 202)
}

function x402Payer(header: string): string | null {
  try {
    const parsed = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
      payload?: { authorization?: { from?: unknown } }
    }
    return wallet(parsed.payload?.authorization?.from)
  } catch {
    return null
  }
}

async function confirmedSettlement(
  dependencies: WorldMarketDependencies,
  txHash: string,
  offer: OfferRecord,
  reservedAt: Date,
  reservedUntil: Date,
): Promise<DirectPaymentCheck> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const confirmed = await dependencies.verifyDirectPayment(
      txHash,
      offer.seller_wallet,
      offer.price_usdc,
      reservedAt,
      reservedUntil,
      offer.buyer_wallet == null ? { exactAmount: true } : {
        expectedFrom: offer.buyer_wallet,
        exactAmount: true,
      },
    )
    if (confirmed.state !== 'pending') return confirmed
    if (attempt < 2) {
      await new Promise<void>(resolve => setTimeout(resolve, 150 * (attempt + 1)))
    }
  }
  return { state: 'pending' }
}

async function getMarket(
  c: Context,
  dependencies: WorldMarketDependencies,
  path: string,
): Promise<unknown | Response> {
  try {
    return await dependencies.marketGet(path)
  } catch (error) {
    const message = error instanceof MarketReadError && error.kind === 'invalid'
      ? 'the market returned an invalid public record'
      : 'the market public record is unavailable; nothing changed'
    return err(c, error instanceof MarketReadError && error.kind === 'invalid' ? 502 : 503, message)
  }
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response
}

function draftMatchesOffer(draft: DraftRecord, offer: OfferRecord): boolean {
  return draft.assetId === offer.asset_id && draft.priceUsdc === offer.price_usdc &&
    draft.sellerWallet === offer.seller_wallet
}

function defaultDependencies(): WorldMarketDependencies {
  const marketOrigin = configuredMarketOrigin()
  return {
    query: (text, params) => sql.query(text, params as unknown[]),
    authenticate: auth,
    now: () => new Date(),
    marketOrigin,
    marketGet: path => publicMarketGet(marketOrigin, path),
    verifyDirectPayment: classifyDirectPayment,
    settleX402,
    paymentResponseHeader,
  }
}

async function finalizeReconciledPayment(
  dependencies: WorldMarketDependencies,
  offer: OfferRecord,
  blockTime: Date,
): Promise<OfferRecord | null> {
  if (
    offer.buyer_id == null || offer.buyer == null || offer.buyer_wallet == null ||
    offer.pending_x402_tx_hash == null || offer.market_buyer == null
  ) return null
  const rows = await dependencies.query(`
    /* world-market:reconcile-claim */
    WITH claimed_offer AS (
      UPDATE transfer_offers SET status = 'claimed', claimed_at = clock_timestamp()
      WHERE id = $1 AND channel = 'world' AND asset_type = 'thing' AND status = 'open'
        AND buyer_id = $2 AND reserved_by = $2 AND lower(buyer_wallet) = lower($5)
        AND seller_id = $8 AND asset_id = $9
        AND price_usdc = $10 AND lower(seller_wallet) = lower($11)
        AND reserved_at = $12::timestamptz AND reserved_until = $13::timestamptz
        AND $7::timestamptz IS NOT NULL AND $7::timestamptz >= reserved_at
        AND $7::timestamptz <= reserved_until
        AND x402_evidence_state = 'pending'
        AND pending_x402_tx_hash = $4 AND pending_x402_payer = lower($5)
        AND market_checkout_id = $14 AND market_listing_id = $15
        AND market_draft_id = $16 AND market_buyer = $18
        AND EXISTS (
          SELECT 1 FROM things WHERE things.id = $9 AND things.owner_id = $8
            AND things.withdrawn_at IS NULL AND things.active_offer_id = $1
        )
      RETURNING id, asset_id, seller_id, buyer_id, price_usdc, seller_wallet
    ), used_payment AS (
      INSERT INTO payment_uses (
        tx_hash, actor_id, purpose, payer_wallet, payee_wallet, amount_usdc
      )
      SELECT $4, $2, 'sale', lower($5), lower(seller_wallet), price_usdc
      FROM claimed_offer RETURNING tx_hash
    ), new_payment AS (
      INSERT INTO sale_payments (
        offer_id, buyer_id, payer_wallet, payee_wallet, amount_usdc,
        tx_hash, verified_via, block_time
      )
      SELECT offer.id, offer.buyer_id, lower($5), lower(offer.seller_wallet),
        offer.price_usdc, payment.tx_hash, 'x402', $7
      FROM claimed_offer offer CROSS JOIN used_payment payment
      RETURNING offer_id, tx_hash
    ), changed_owner AS (
      UPDATE things SET owner_id = $2, active_offer_id = NULL
      FROM claimed_offer offer CROSS JOIN new_payment payment
      WHERE things.id = offer.asset_id AND things.owner_id = offer.seller_id
        AND things.withdrawn_at IS NULL AND things.active_offer_id = offer.id
      RETURNING things.id
    ), owner_guard AS MATERIALIZED (
      SELECT CASE
        WHEN NOT EXISTS (SELECT 1 FROM claimed_offer) THEN 0
        WHEN EXISTS (SELECT 1 FROM changed_owner) THEN 1
        ELSE 1 / (SELECT count(*)::int FROM changed_owner)
      END AS ok
    ), new_transfer AS (
      INSERT INTO transfers (
        asset_type, asset_id, from_id, to_id, offer_id, price_usdc, tx_hash
      )
      SELECT 'thing', thing.id, $8, $2, $1, $10, $4
      FROM changed_owner thing CROSS JOIN owner_guard guard WHERE guard.ok = 1
      RETURNING id
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'world_sale', $3, jsonb_build_object(
        'transfer_id', transfer.id, 'offer_id', $1::integer, 'thing_id', $9::integer,
        'from', $17::text, 'to', $3::text, 'price_usdc', $10::numeric,
        'tx_hash', $4::text, 'market_listing_id', $15::integer,
        'market_checkout_id', $14::integer
      ) FROM new_transfer transfer
    )
    SELECT id FROM new_transfer
  `, [
    offer.id,
    offer.buyer_id,
    offer.buyer,
    offer.pending_x402_tx_hash,
    offer.buyer_wallet,
    'x402',
    blockTime.toISOString(),
    offer.seller_id,
    offer.asset_id,
    offer.price_usdc,
    offer.seller_wallet,
    offer.reserved_at,
    offer.reserved_until,
    offer.market_checkout_id,
    offer.market_listing_id,
    offer.market_draft_id,
    offer.seller,
    offer.market_buyer,
  ])
  return rows[0] ? readOffer(dependencies, offer.id) : null
}

export function mountWorldMarketRoutes(
  app: Hono,
  suppliedDependencies?: WorldMarketDependencies,
): void {
  const dependencies = suppliedDependencies ?? defaultDependencies()

  app.get('/api/world/resident/:handle', async c => {
    const handle = c.req.param('handle')
    if (!HANDLE_RE.test(handle)) return err(c, 404, 'no such resident')
    const rows = await dependencies.query(`
      /* world-market:resident */
      SELECT handle FROM residents WHERE handle = $1
    `, [handle])
    return rows[0]?.handle === handle
      ? c.json({ resident: { handle } })
      : err(c, 404, 'no such resident')
  })

  app.get('/api/world/offer/:offerId', async c => {
    const offerId = positiveId(c.req.param('offerId'))
    if (!offerId) return err(c, 400, 'bad world offer id')
    const offer = await readOffer(dependencies, offerId)
    return offer
      ? c.json({ offer: publicOffer(offer, dependencies.now()) })
      : err(c, 404, 'no such world offer')
  })

  app.post('/api/world/listing', async c => {
    const seller = await dependencies.authenticate(c)
    if (!seller) return err(c, 401, 'bad or missing bearer secret')
    const body = await jsonObject(c)
    if (!body || !hasOnly(body, ['thing_id', 'market_draft_id'])) {
      return err(c, 400, 'need exactly thing_id and market_draft_id')
    }
    const thingId = positiveId(body.thing_id)
    const draftId = positiveId(body.market_draft_id)
    if (!thingId || !draftId) return err(c, 400, 'thing_id and market_draft_id must be positive integers')

    const marketPayload = await getMarket(c, dependencies, `/api/world/draft/${draftId}`)
    if (isResponse(marketPayload)) return marketPayload
    const draft = draftRecord(marketPayload, draftId)
    const now = dependencies.now()
    if (!draft) return err(c, 502, 'the market returned an invalid public draft')
    if (draft.assetId !== thingId) return err(c, 409, 'market draft names a different city thing')
    if (
      draft.status !== 'pending' || draft.listingId !== null || draft.listingState !== null ||
      draft.expiresAt <= now || draft.createdAt > new Date(now.getTime() + 60_000)
    ) return err(c, 409, 'market draft must be pending, unexpired, and not yet listed')

    const thingRows = await dependencies.query(`
      /* world-market:thing */
      SELECT id, name, owner_id, withdrawn_at, active_offer_id
      FROM things WHERE id = $1
    `, [thingId])
    const thing = thingRows[0]
    if (!thing) return err(c, 404, 'no such thing')
    if (integerValue(thing.owner_id) !== seller.id) return err(c, 403, 'only the thing owner may list it')
    if (thing.withdrawn_at != null) return err(c, 409, 'a withdrawn thing cannot be listed')
    if (thing.active_offer_id != null) return err(c, 409, 'this thing is already locked by an offer')

    try {
      const rows = await dependencies.query(`
        /* world-market:create */
        WITH next_offer AS MATERIALIZED (
          SELECT nextval(pg_get_serial_sequence('transfer_offers', 'id'))::int AS id
        ), locked_thing AS (
          UPDATE things SET active_offer_id = next_offer.id
          FROM next_offer
          WHERE things.id = $1 AND things.owner_id = $2
            AND things.withdrawn_at IS NULL AND things.active_offer_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM transfer_offers conflict
              WHERE conflict.asset_type = 'thing' AND conflict.asset_id = $1
                AND conflict.status = 'open'
            )
          RETURNING things.id, things.active_offer_id
        ), new_offer AS (
          INSERT INTO transfer_offers (
            id, channel, asset_type, asset_id, seller_id, buyer_id,
            price_usdc, seller_wallet, market_origin, market_draft_id, status
          )
          SELECT active_offer_id, 'world', 'thing', id, $2, NULL,
            $4, $5, $6, $7, 'open'
          FROM locked_thing
          RETURNING id
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'world_listed', $3, jsonb_build_object(
            'offer_id', id, 'thing_id', $1::integer, 'market_draft_id', $7::integer,
            'price_usdc', $4::numeric
          ) FROM new_offer
        )
        SELECT id FROM new_offer
      `, [
        thingId,
        seller.id,
        seller.handle,
        draft.priceUsdc,
        draft.sellerWallet,
        dependencies.marketOrigin,
        draftId,
      ])
      const offerId = integerValue(rows[0]?.id)
      if (!offerId) return err(c, 409, 'ownership or lock state changed; re-read the thing')
      const offer = await readOffer(dependencies, offerId)
      if (!offer) return err(c, 500, 'world offer result is unavailable')
      return c.json({ offer: publicOffer(offer, dependencies.now()) }, 201)
    } catch (error) {
      if (postgresErrorCode(error) === '23505') {
        return err(c, 409, 'this draft or thing already has a world offer')
      }
      throw error
    }
  })

  app.post('/api/world/offer/:offerId/claim', async c => {
    const buyer = await dependencies.authenticate(c)
    if (!buyer) return err(c, 401, 'bad or missing bearer secret; move into the city before paying')
    const offerId = positiveId(c.req.param('offerId'))
    if (!offerId) return err(c, 400, 'bad world offer id')
    const body = await jsonObject(c)
    if (!body || !hasOnly(body, ['market_checkout_id', 'buyer_wallet', 'tx_hash'])) {
      return err(c, 400, 'body may contain market_checkout_id, buyer_wallet, and tx_hash only')
    }
    const checkoutId = body.market_checkout_id == null ? null : positiveId(body.market_checkout_id)
    if (body.market_checkout_id != null && checkoutId == null) {
      return err(c, 400, 'market_checkout_id must be a positive integer')
    }
    const requestedWallet = body.buyer_wallet == null ? null : wallet(body.buyer_wallet)
    if (body.buyer_wallet != null && !requestedWallet) return err(c, 400, 'buyer_wallet must be a Base address')
    const suppliedTx = body.tx_hash == null ? null : canonicalTxHash(body.tx_hash)
    if (body.tx_hash != null && !suppliedTx) {
      return err(c, 400, 'tx_hash must be 0x followed by 64 hex characters')
    }
    const paymentHeader = c.req.header('x-payment')
    if (paymentHeader && suppliedTx) return err(c, 400, 'use either X-PAYMENT or tx_hash, not both')
    const hasPayment = Boolean(paymentHeader || suppliedTx)

    let offer = await readOffer(dependencies, offerId)
    if (!offer) return err(c, 404, 'no such world offer')
    if (offer.status === 'claimed') {
      return offer.buyer_id === buyer.id
        ? c.json({ offer: publicOffer(offer, dependencies.now()) })
        : err(c, 403, 'this world offer was claimed by another resident')
    }
    if (offer.status === 'canceled') return err(c, 409, 'world offer is canceled')
    if (!offer.locked) return err(c, 409, 'the thing is not locked by this world offer')
    if (offer.seller_id === buyer.id) return err(c, 400, 'you cannot buy your own thing')

    const now = dependencies.now()
    const pendingAtStart = paymentPending(offer)
    const active = reservationActive(offer, now)
    if (pendingAtStart) {
      if (offer.buyer_id !== buyer.id) {
        return err(c, 409, 'this world offer has a settled payment pending for another resident')
      }
      if (checkoutId != null && checkoutId !== offer.market_checkout_id) {
        return err(c, 409, 'market_checkout_id does not match the settled payment')
      }
      if (requestedWallet != null && requestedWallet !== offer.buyer_wallet) {
        return err(c, 409, 'buyer_wallet does not match the settled payment')
      }
      if (paymentHeader) {
        return err(c, 409, 'payment is already settled; retry without X-PAYMENT')
      }
      if (suppliedTx != null && suppliedTx !== offer.pending_x402_tx_hash) {
        return err(c, 409, 'tx_hash does not match the settled payment')
      }
    } else if (!active) {
      if (hasPayment) return err(c, 409, 'open a five-minute reservation before sending payment')
      if (!checkoutId || !requestedWallet) {
        return err(c, 400, 'first claim call requires market_checkout_id and buyer_wallet')
      }

      const checkoutPayload = await getMarket(c, dependencies, `/api/world/checkout/${checkoutId}`)
      if (isResponse(checkoutPayload)) return checkoutPayload
      const checkout = checkoutRecord(checkoutPayload, checkoutId)
      if (!checkout) return err(c, 502, 'the market returned an invalid public checkout')
      if (
        checkout.status !== 'active' || checkout.expiresAt <= now ||
        checkout.createdAt > new Date(now.getTime() + 60_000)
      ) {
        return err(c, 409, 'market checkout is expired or not active')
      }
      if (
        checkout.offerId !== offer.id || checkout.draftId !== offer.market_draft_id ||
        checkout.cityHandle !== buyer.handle ||
        (offer.market_listing_id != null && offer.market_listing_id !== checkout.listingId)
      ) return err(c, checkout.cityHandle !== buyer.handle ? 403 : 409, 'market checkout does not match this resident and world offer')

      const draftPayload = await getMarket(c, dependencies, `/api/world/draft/${offer.market_draft_id}`)
      if (isResponse(draftPayload)) return draftPayload
      const draft = draftRecord(draftPayload, offer.market_draft_id)
      if (!draft) return err(c, 502, 'the market returned an invalid public listing record')
      if (
        draft.status !== 'active' || draft.expiresAt <= now ||
        draft.listingId !== checkout.listingId || draft.listingState !== 'active' ||
        !draftMatchesOffer(draft, offer)
      ) return err(c, 409, 'market listing is not active or does not match this world offer')

      try {
        const rows = await dependencies.query(`
          /* world-market:reserve */
          UPDATE transfer_offers SET
            buyer_id = $2,
            reserved_by = $2,
            buyer_wallet = lower($4),
            market_listing_id = $5,
            market_checkout_id = $6,
            market_buyer = $9,
            reserved_at = clock_timestamp(),
            reserved_until = clock_timestamp() + interval '5 minutes'
          WHERE id = $1 AND channel = 'world' AND asset_type = 'thing' AND status = 'open'
            AND seller_id <> $2
            AND market_origin = $7 AND market_draft_id = $8
            AND (reserved_until IS NULL OR reserved_until <= clock_timestamp())
            AND pending_x402_tx_hash IS NULL
            AND (market_listing_id IS NULL OR market_listing_id = $5)
            AND EXISTS (
              SELECT 1 FROM things
              WHERE things.id = transfer_offers.asset_id
                AND things.owner_id = transfer_offers.seller_id
                AND things.withdrawn_at IS NULL AND things.active_offer_id = transfer_offers.id
            )
          RETURNING id
        `, [
          offer.id,
          buyer.id,
          buyer.handle,
          requestedWallet,
          checkout.listingId,
          checkout.id,
          dependencies.marketOrigin,
          offer.market_draft_id,
          checkout.marketBuyer,
        ])
        if (!rows[0]) {
          const raced = await readOffer(dependencies, offer.id)
          if (
            raced && reservationActive(raced, dependencies.now()) && raced.buyer_id === buyer.id &&
            raced.market_checkout_id === checkout.id && raced.buyer_wallet === requestedWallet &&
            raced.market_buyer === checkout.marketBuyer
          ) return challenge(c, raced)
          return err(c, 409, 'offer, checkout, reservation, or ownership changed; re-read the offer')
        }
      } catch (error) {
        if (postgresErrorCode(error) === '23505') {
          return err(c, 409, 'this market checkout is already bound to another world offer')
        }
        throw error
      }
      offer = await readOffer(dependencies, offer.id)
      if (!offer || !reservationActive(offer, dependencies.now())) {
        return err(c, 409, 'the five-minute reservation could not be opened')
      }
      return challenge(c, offer)
    }

    if (!pendingAtStart) {
      if (offer.buyer_id !== buyer.id) return err(c, 409, 'another resident has the active reservation')
      if (checkoutId != null && checkoutId !== offer.market_checkout_id) {
        return err(c, 409, 'market_checkout_id does not match the active reservation')
      }
      if (requestedWallet != null && requestedWallet !== offer.buyer_wallet) {
        return err(c, 409, 'buyer_wallet does not match the active reservation')
      }
      if (!hasPayment) return challenge(c, offer)
    }

    const reservedAt = timestamp(offer.reserved_at)!
    const reservedUntil = timestamp(offer.reserved_until)!
    const accepted = requirements(
      offer.seller_wallet,
      offer.price_usdc,
      `${CITY_ORIGIN}/api/world/offer/${offer.id}/claim`,
      `1F3D9 world offer ${offer.id}`,
    )
    let txHash: string
    let payer: string
    let verifiedVia: 'x402' | 'claim'
    let blockTime: string | null
    let responseHeader: string | null = null
    if (pendingAtStart) {
      txHash = offer.pending_x402_tx_hash!
      const confirmed = await confirmedSettlement(
        dependencies,
        txHash,
        offer,
        reservedAt,
        reservedUntil,
      )
      if (confirmed.state === 'pending') {
        return pending202(c, offer, dependencies.now())
      }
      if (confirmed.state === 'invalid_final') {
        return err(c, 409, 'the settled payment needs reconciliation before this offer can change')
      }
      const confirmedPayer = wallet(confirmed.from)
      if (
        !confirmedPayer || confirmedPayer !== offer.buyer_wallet || confirmedPayer !== offer.pending_x402_payer ||
        confirmed.blockTime < reservedAt || confirmed.blockTime > reservedUntil
      ) {
        return err(c, 409, 'the public Base transfer does not match the settled payment reservation')
      }
      payer = confirmedPayer
      verifiedVia = 'x402'
      blockTime = confirmed.blockTime.toISOString()
    } else if (paymentHeader) {
      const embeddedPayer = x402Payer(paymentHeader)
      if (!embeddedPayer || embeddedPayer !== offer.buyer_wallet) {
        return challenge402(c, accepted, 'X-PAYMENT payer must match the reservation wallet')
      }
      const settled = await dependencies.settleX402(paymentHeader, accepted)
      if ('error' in settled) return challenge402(c, accepted, settled.error)
      const settledPayer = wallet(settled.payer)
      const settledHash = canonicalTxHash(settled.transaction)
      if (!settledPayer || settledPayer !== offer.buyer_wallet || !settledHash) {
        return challenge402(c, accepted, 'settled payment does not match the reservation')
      }
      responseHeader = dependencies.paymentResponseHeader(settled)
      try {
        const rows = await dependencies.query(`
          /* world-market:pending-x402 */
          UPDATE transfer_offers SET
            pending_x402_tx_hash = $4,
            pending_x402_payer = lower($5),
            pending_x402_at = clock_timestamp()
          WHERE id = $1 AND channel = 'world' AND asset_type = 'thing' AND status = 'open'
            AND buyer_id = $2 AND reserved_by = $2
            AND lower(buyer_wallet) = lower($5)
            AND seller_id = $8 AND asset_id = $9
            AND price_usdc = $10 AND lower(seller_wallet) = lower($11)
            AND reserved_at = $12::timestamptz AND reserved_until = $13::timestamptz
            AND reserved_at <= clock_timestamp() AND reserved_until > clock_timestamp()
            AND market_checkout_id = $14 AND market_listing_id = $15 AND market_draft_id = $16
            AND market_buyer = $17
            AND pending_x402_tx_hash IS NULL
            AND EXISTS (
              SELECT 1 FROM things
              WHERE things.id = $9 AND things.owner_id = $8
                AND things.withdrawn_at IS NULL AND things.active_offer_id = $1
            )
          RETURNING id
        `, [
          offer.id,
          buyer.id,
          buyer.handle,
          settledHash,
          settledPayer,
          'x402',
          null,
          offer.seller_id,
          offer.asset_id,
          offer.price_usdc,
          offer.seller_wallet,
          offer.reserved_at,
          offer.reserved_until,
          offer.market_checkout_id,
          offer.market_listing_id,
          offer.market_draft_id,
          offer.market_buyer,
        ])
        if (!rows[0]) {
          const raced = await readOffer(dependencies, offer.id)
          if (
            !raced || raced.buyer_id !== buyer.id || raced.pending_x402_tx_hash !== settledHash ||
            raced.pending_x402_payer !== settledPayer
          ) return err(c, 409, 'offer or reservation changed while the payment settled')
          offer = raced
        } else {
          const pending = await readOffer(dependencies, offer.id)
          if (!pending || !paymentPending(pending)) {
            return err(c, 503, 'payment settled but its durable city record is unavailable')
          }
          offer = pending
        }
      } catch (error) {
        if (postgresErrorCode(error) === '23505') {
          return err(c, 409, 'that settled payment is already bound to another offer')
        }
        throw error
      }
      // The x402 facilitator specification says /settle returns only after chain
      // confirmation, but its response has no block timestamp. Re-read the public
      // Base transfer so the city receipt never trusts facilitator metadata for time.
      const confirmed = await confirmedSettlement(
        dependencies,
        settledHash,
        offer,
        reservedAt,
        reservedUntil,
      )
      const confirmedPayer = confirmed.state === 'matched' ? wallet(confirmed.from) : null
      if (
        confirmed.state !== 'matched' || !confirmedPayer || confirmedPayer !== offer.buyer_wallet ||
        confirmed.blockTime < reservedAt || confirmed.blockTime > reservedUntil
      ) {
        return pending202(c, offer, dependencies.now(), responseHeader)
      }
      txHash = settledHash
      payer = confirmedPayer
      verifiedVia = 'x402'
      blockTime = confirmed.blockTime.toISOString()
    } else {
      const direct = await dependencies.verifyDirectPayment(
        suppliedTx!,
        offer.seller_wallet,
        offer.price_usdc,
        reservedAt,
        reservedUntil,
        offer.buyer_wallet == null ? { exactAmount: true } : {
          expectedFrom: offer.buyer_wallet,
          exactAmount: true,
        },
      )
      const directPayer = direct.state === 'matched' ? wallet(direct.from) : null
      if (
        direct.state !== 'matched' || !directPayer || directPayer !== offer.buyer_wallet ||
        direct.blockTime < reservedAt || direct.blockTime > reservedUntil
      ) return err(c, 402, 'tx did not verify from the reservation wallet inside its five-minute window')
      txHash = suppliedTx!
      payer = directPayer
      verifiedVia = 'claim'
      blockTime = direct.blockTime.toISOString()
    }

    try {
      const rows = await dependencies.query(`
        /* world-market:claim */
        WITH claimed_offer AS (
          UPDATE transfer_offers SET status = 'claimed', claimed_at = clock_timestamp()
          WHERE id = $1 AND channel = 'world' AND asset_type = 'thing' AND status = 'open'
            AND buyer_id = $2 AND reserved_by = $2
            AND lower(buyer_wallet) = lower($5)
            AND seller_id = $8 AND asset_id = $9
            AND price_usdc = $10 AND lower(seller_wallet) = lower($11)
            AND reserved_at = $12::timestamptz AND reserved_until = $13::timestamptz
            AND reserved_at <= clock_timestamp()
            AND (
              reserved_until > clock_timestamp()
              OR ($6 = 'x402' AND pending_x402_tx_hash = $4
                AND pending_x402_payer = lower($5))
            )
            AND $7::timestamptz IS NOT NULL AND $7::timestamptz >= reserved_at
            AND $7::timestamptz <= reserved_until
            AND (
              ($6 = 'x402' AND pending_x402_tx_hash = $4
                AND pending_x402_payer = lower($5))
              OR ($6 = 'claim' AND pending_x402_tx_hash IS NULL)
            )
            AND market_checkout_id = $14 AND market_listing_id = $15 AND market_draft_id = $16
            AND market_buyer = $18
            AND EXISTS (
              SELECT 1 FROM things
              WHERE things.id = $9 AND things.owner_id = $8
                AND things.withdrawn_at IS NULL AND things.active_offer_id = $1
            )
          RETURNING id, asset_id, seller_id, buyer_id, price_usdc, seller_wallet
        ), used_payment AS (
          INSERT INTO payment_uses (
            tx_hash, actor_id, purpose, payer_wallet, payee_wallet, amount_usdc
          )
          SELECT $4, $2, 'sale', lower($5), lower(seller_wallet), price_usdc
          FROM claimed_offer
          RETURNING tx_hash
        ), new_payment AS (
          INSERT INTO sale_payments (
            offer_id, buyer_id, payer_wallet, payee_wallet, amount_usdc,
            tx_hash, verified_via, block_time
          )
          SELECT offer.id, offer.buyer_id, lower($5), lower(offer.seller_wallet),
            offer.price_usdc, payment.tx_hash, $6, $7
          FROM claimed_offer offer CROSS JOIN used_payment payment
          RETURNING offer_id, tx_hash
        ), changed_owner AS (
          UPDATE things SET owner_id = $2, active_offer_id = NULL
          FROM claimed_offer offer CROSS JOIN new_payment payment
          WHERE things.id = offer.asset_id AND things.owner_id = offer.seller_id
            AND things.withdrawn_at IS NULL AND things.active_offer_id = offer.id
          RETURNING things.id
        ), owner_guard AS MATERIALIZED (
          SELECT CASE
            WHEN NOT EXISTS (SELECT 1 FROM claimed_offer) THEN 0
            WHEN EXISTS (SELECT 1 FROM changed_owner) THEN 1
            ELSE 1 / (SELECT count(*)::int FROM changed_owner)
          END AS ok
        ), new_transfer AS (
          INSERT INTO transfers (
            asset_type, asset_id, from_id, to_id, offer_id, price_usdc, tx_hash
          )
          SELECT 'thing', thing.id, $8, $2, $1, $10, $4
          FROM changed_owner thing CROSS JOIN owner_guard guard WHERE guard.ok = 1
          RETURNING id
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'world_sale', $3, jsonb_build_object(
            'transfer_id', transfer.id, 'offer_id', $1::integer, 'thing_id', $9::integer,
            'from', $17::text, 'to', $3::text, 'price_usdc', $10::numeric,
            'tx_hash', $4::text, 'market_listing_id', $15::integer,
            'market_checkout_id', $14::integer
          ) FROM new_transfer transfer
        )
        SELECT id FROM new_transfer
      `, [
        offer.id,
        buyer.id,
        buyer.handle,
        txHash,
        payer,
        verifiedVia,
        blockTime,
        offer.seller_id,
        offer.asset_id,
        offer.price_usdc,
        offer.seller_wallet,
        offer.reserved_at,
        offer.reserved_until,
        offer.market_checkout_id,
        offer.market_listing_id,
        offer.market_draft_id,
        offer.seller,
        offer.market_buyer,
      ])
      if (!rows[0]) {
        const raced = await readOffer(dependencies, offer.id)
        if (raced?.status === 'claimed' && raced.buyer_id === buyer.id) {
          return c.json({ offer: publicOffer(raced, dependencies.now()) })
        }
        return err(c, 409, 'offer, reservation, payment, or ownership changed before transfer')
      }
      const claimed = await readOffer(dependencies, offer.id)
      if (!claimed) return err(c, 500, 'claimed world receipt is unavailable')
      if (responseHeader) c.header('X-PAYMENT-RESPONSE', responseHeader)
      return c.json({ offer: publicOffer(claimed, dependencies.now()) })
    } catch (error) {
      if (postgresErrorCode(error) === '23505') {
        return err(c, 409, 'that payment transaction was already used')
      }
      throw error
    }
  })

  app.post('/api/world/offer/:offerId/reconcile', async c => {
    const actor = await dependencies.authenticate(c)
    if (!actor) return err(c, 401, 'bad or missing bearer secret')
    const offerId = positiveId(c.req.param('offerId'))
    if (!offerId) return err(c, 400, 'bad world offer id')
    const body = await jsonObject(c)
    if (!body || !hasOnly(body, [])) return err(c, 400, 'reconcile body must be empty')
    let offer = await readOffer(dependencies, offerId)
    if (!offer) return err(c, 404, 'no such world offer')
    if (actor.id !== offer.seller_id && actor.id !== offer.buyer_id) {
      return err(c, 403, 'only this offer seller or buyer may reconcile its payment')
    }
    if (offer.status === 'claimed' || offer.status === 'canceled' || paymentInvalid(offer)) {
      return c.json({ offer: publicOffer(offer, dependencies.now()) })
    }
    if (!paymentPending(offer)) return err(c, 409, 'this world offer has no settled payment to reconcile')
    const reservedAt = timestamp(offer.reserved_at)
    const reservedUntil = timestamp(offer.reserved_until)
    if (!reservedAt || !reservedUntil || !offer.buyer_wallet || !offer.pending_x402_tx_hash) {
      return err(c, 409, 'the pending payment record is incomplete')
    }
    const checked = await dependencies.verifyDirectPayment(
      offer.pending_x402_tx_hash,
      offer.seller_wallet,
      offer.price_usdc,
      reservedAt,
      reservedUntil,
      { expectedFrom: offer.buyer_wallet, exactAmount: true },
    )
    if (checked.state === 'pending') return pending202(c, offer, dependencies.now())
    if (checked.state === 'matched') {
      try {
        const claimed = await finalizeReconciledPayment(dependencies, offer, checked.blockTime)
        if (claimed) return c.json({ offer: publicOffer(claimed, dependencies.now()) })
        const raced = await readOffer(dependencies, offer.id)
        if (raced?.status === 'claimed') {
          return c.json({ offer: publicOffer(raced, dependencies.now()) })
        }
        return err(c, 409, 'offer, payment, or ownership changed during reconciliation')
      } catch (error) {
        if (postgresErrorCode(error) === '23505') {
          return err(c, 409, 'that payment transaction was already used')
        }
        throw error
      }
    }

    const rows = await dependencies.query(`
      /* world-market:invalidate-x402 */
      UPDATE transfer_offers SET
        x402_evidence_state = 'invalid',
        x402_invalid_reason = $3,
        x402_invalid_at = clock_timestamp()
      WHERE id = $1 AND channel = 'world' AND status = 'open'
        AND (seller_id = $2 OR buyer_id = $2)
        AND x402_evidence_state = 'pending'
        AND pending_x402_tx_hash = $4 AND pending_x402_payer = lower($5)
        AND reserved_at = $6::timestamptz AND reserved_until = $7::timestamptz
        AND EXISTS (
          SELECT 1 FROM things WHERE things.id = transfer_offers.asset_id
            AND things.owner_id = transfer_offers.seller_id
            AND things.withdrawn_at IS NULL AND things.active_offer_id = transfer_offers.id
        )
      RETURNING id
    `, [
      offer.id,
      actor.id,
      checked.reason,
      offer.pending_x402_tx_hash,
      offer.pending_x402_payer,
      offer.reserved_at,
      offer.reserved_until,
    ])
    if (!rows[0]) return err(c, 409, 'payment evidence or ownership changed during reconciliation')
    offer = await readOffer(dependencies, offer.id)
    if (!offer || !paymentInvalid(offer)) return err(c, 500, 'invalid payment audit record is unavailable')
    return c.json({ offer: publicOffer(offer, dependencies.now()) })
  })

  app.post('/api/world/offer/:offerId/cancel', async c => {
    const seller = await dependencies.authenticate(c)
    if (!seller) return err(c, 401, 'bad or missing bearer secret')
    const offerId = positiveId(c.req.param('offerId'))
    if (!offerId) return err(c, 400, 'bad world offer id')
    const body = await jsonObject(c)
    if (!body || !hasOnly(body, [])) return err(c, 400, 'cancel body must be empty')
    let offer = await readOffer(dependencies, offerId)
    if (!offer) return err(c, 404, 'no such world offer')
    if (offer.seller_id !== seller.id) return err(c, 403, 'only the seller may cancel this world offer')
    if (offer.status === 'canceled') return c.json({ offer: publicOffer(offer, dependencies.now()) })
    if (offer.status === 'claimed') return err(c, 409, 'claimed world offer cannot be canceled')
    if (paymentPending(offer)) {
      return err(c, 409, 'a settled payment is pending; the thing stays locked for its buyer')
    }
    if (!paymentInvalid(offer) && reservationActive(offer, dependencies.now())) {
      return err(c, 409, 'the buyer has an active five-minute payment window')
    }

    const draftPayload = await getMarket(c, dependencies, `/api/world/draft/${offer.market_draft_id}`)
    if (isResponse(draftPayload)) return draftPayload
    const draft = draftRecord(draftPayload, offer.market_draft_id)
    if (!draft || !draftMatchesOffer(draft, offer)) {
      return err(c, 502, 'the market returned an invalid public listing record')
    }
    if (offer.market_listing_id != null && draft.listingId !== offer.market_listing_id) {
      return err(c, 409, 'market listing does not match this world offer')
    }
    const endedStates = new Set(['withdrawn', 'removed', 'expired', 'canceled'])
    const listingEndedStates = paymentInvalid(offer)
      ? new Set([...endedStates, 'stale'])
      : endedStates
    const marketEnded = offer.market_listing_id == null
      ? draft.listingId == null && draft.listingState == null &&
        (endedStates.has(draft.status) ||
          (draft.status === 'pending' && draft.expiresAt <= dependencies.now()))
      : endedStates.has(draft.status) && draft.listingState != null &&
        listingEndedStates.has(draft.listingState)
    if (!marketEnded) return err(c, 409, 'withdraw or expire the market listing before unlocking the thing')

    const rows = await dependencies.query(`
      /* world-market:cancel */
      WITH canceled_offer AS (
        UPDATE transfer_offers SET status = 'canceled', canceled_at = clock_timestamp()
        WHERE id = $1 AND channel = 'world' AND status = 'open' AND seller_id = $2
          AND (pending_x402_tx_hash IS NULL OR x402_evidence_state = 'invalid')
          AND (
            reserved_until IS NULL OR reserved_until <= clock_timestamp()
            OR x402_evidence_state = 'invalid'
          )
          AND EXISTS (
            SELECT 1 FROM things WHERE things.id = transfer_offers.asset_id
              AND things.owner_id = $2 AND things.withdrawn_at IS NULL
              AND things.active_offer_id = transfer_offers.id
          )
        RETURNING id, asset_id
      ), released_thing AS (
        UPDATE things SET active_offer_id = NULL
        FROM canceled_offer offer
        WHERE things.id = offer.asset_id AND things.owner_id = $2
          AND things.withdrawn_at IS NULL AND things.active_offer_id = offer.id
        RETURNING things.id
      ), release_guard AS MATERIALIZED (
        SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM canceled_offer) THEN 0
          WHEN EXISTS (SELECT 1 FROM released_thing) THEN 1
          ELSE 1 / (SELECT count(*)::int FROM released_thing)
        END AS ok
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'world_cancel', $3, jsonb_build_object(
          'offer_id', offer.id, 'thing_id', offer.asset_id, 'market_draft_id', $4::integer
        )
        FROM canceled_offer offer CROSS JOIN released_thing thing CROSS JOIN release_guard guard
        WHERE guard.ok = 1
      )
      SELECT offer.id FROM canceled_offer offer
      CROSS JOIN released_thing thing CROSS JOIN release_guard guard WHERE guard.ok = 1
    `, [offer.id, seller.id, seller.handle, offer.market_draft_id])
    if (!rows[0]) return err(c, 409, 'offer, reservation, or ownership changed before cancellation')
    offer = await readOffer(dependencies, offer.id)
    if (!offer) return err(c, 500, 'canceled world record is unavailable')
    return c.json({ offer: publicOffer(offer, dependencies.now()) })
  })
}
