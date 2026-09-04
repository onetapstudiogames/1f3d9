import type { Context, Hono } from 'hono'
import { auth, err, HANDLE_RE, postgresErrorCode, RESIDENT_AUTH_REFUSAL, WALLET_RE } from './core.ts'
import { sql } from './db.ts'
import { positiveId, publicLabel, publicText } from './input.ts'
import {
  canonicalTxHash,
  challenge402,
  paymentReadinessResponse,
  requirements,
} from './pay.ts'
import { findPaymentAttempt, findReplayableTargetPaymentAttempt } from './payment-attempts.ts'
import {
  completedPaymentResponse,
  paymentJsonResponse,
  resumeDurableX402,
  runDurableX402,
} from './payment-flow.ts'
import { PaymentAttemptConflictError } from './payment-attempts.ts'
import {
  closeInvalidSalePaymentTarget,
  closeSalePaymentTarget,
  completeWorldSalePayment,
  parkWorldSalePayment,
  PaymentSaleConflictError,
} from './payment-sale-operations.ts'
import { publicJson } from './public-output.ts'
import { allowedPublicQuery } from './public-pagination.ts'

const CITY_ORIGIN = process.env.PUBLIC_ORIGIN ?? 'https://1f3d9.com'
const DEFAULT_MARKET_ORIGIN = 'https://1f3ea.com'
const MARKET_RESPONSE_BYTES = 256 * 1024
const MARKET_TIMEOUT_MS = 4_000
const WORLD_OFFER_ID_REFUSAL = 'world offer id was rejected because it must be a positive whole number; retry with an offer_id from GET /api/world-market'

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
  maker_id: number
  made_by: string
  current_owner_id: number
  current_owner: string
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
  pending_payment_attempt_id: string | null
  pending_x402_tx_hash: string | null
  pending_x402_payer: string | null
  pending_x402_at: string | null
  x402_evidence_state: 'none' | 'pending' | 'invalid' | 'expired' | 'founder_review'
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
  findPayment: typeof findPaymentAttempt
  runPayment: typeof runDurableX402
  resumePayment: typeof resumeDurableX402
}

class MarketReadError extends Error {
  readonly kind: 'unavailable' | 'invalid' | 'not_found'

  constructor(kind: 'unavailable' | 'invalid' | 'not_found') {
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

export async function publicMarketGet(
  origin: string,
  path: string,
  marketFetch: typeof fetch = fetch,
): Promise<unknown> {
  let response: Response
  try {
    response = await marketFetch(`${origin}${path}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(MARKET_TIMEOUT_MS),
    })
  } catch {
    throw new MarketReadError('unavailable')
  }
  if (response.status === 404) throw new MarketReadError('not_found')
  if (!response.ok) throw new MarketReadError('unavailable')
  return readLimitedJson(response)
}

function missingMarketRecord(path: string): string {
  const match = /^\/api\/(?:world\/)?(draft|checkout|listing)\/([1-9]\d*)$/u.exec(path)
  return match ? `no such market ${match[1]} ${match[2]}` : 'no such market public record'
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
  const makerId = integerValue(row.maker_id)
  const madeBy = typeof row.made_by === 'string' && HANDLE_RE.test(row.made_by)
    ? row.made_by
    : null
  const currentOwnerId = integerValue(row.current_owner_id)
  const currentOwner = typeof row.current_owner === 'string' && HANDLE_RE.test(row.current_owner)
    ? row.current_owner
    : null
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
  const pendingAttemptId = row.pending_payment_attempt_id == null
    ? null
    : String(row.pending_payment_attempt_id)
  const pendingPayer = row.pending_x402_payer == null ? null : wallet(row.pending_x402_payer)
  const marketBuyer = row.market_buyer == null ? null : publicLabel(row.market_buyer, 120)
  const evidenceState = String(row.x402_evidence_state ?? 'none')
  const invalidReason = nullableString(row.x402_invalid_reason)
  const invalidAt = nullableString(row.x402_invalid_at)
  const terminalEvidence = evidenceState === 'expired' || evidenceState === 'founder_review'
  const evidenceConsistent = evidenceState === 'none'
    ? pendingHash == null && pendingPayer == null && row.pending_x402_at == null &&
      invalidReason == null && invalidAt == null
    : evidenceState === 'pending'
      ? pendingHash != null && pendingPayer != null && row.pending_x402_at != null &&
        invalidReason == null && invalidAt == null
      : evidenceState === 'invalid'
        ? pendingHash != null && pendingPayer != null && row.pending_x402_at != null &&
          ['failed_transaction', 'confirmed_mismatch'].includes(String(invalidReason)) && invalidAt != null
        : terminalEvidence && pendingHash != null && pendingPayer != null
          && row.pending_x402_at != null && invalidReason == null && invalidAt == null
  if (
    !id || row.channel !== 'world' || row.asset_type !== 'thing' || !assetId ||
    !makerId || !madeBy || !currentOwnerId || !currentOwner || !sellerId ||
    priceUsdc == null || !marketDraftId || !sellerWallet ||
    (row.buyer_id != null && buyerId == null) ||
    (row.buyer_wallet != null && buyerWallet == null) ||
    (row.pending_x402_tx_hash != null && pendingHash == null) ||
    (row.pending_x402_payer != null && pendingPayer == null) ||
    (row.market_buyer != null && marketBuyer == null) ||
    ((buyerId == null) !== (marketBuyer == null)) ||
    ((pendingHash == null) !== (pendingPayer == null)) ||
    ((pendingHash == null) !== (pendingAttemptId == null)) ||
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
    maker_id: makerId,
    made_by: madeBy,
    current_owner_id: currentOwnerId,
    current_owner: currentOwner,
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
    pending_payment_attempt_id: pendingAttemptId,
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
      thing.maker_id, maker.handle AS made_by,
      thing.owner_id AS current_owner_id, current_owner.handle AS current_owner,
      o.seller_id, seller.handle AS seller, o.buyer_id, buyer.handle AS buyer,
      o.price_usdc::float8 AS price_usdc, lower(o.seller_wallet) AS seller_wallet,
      o.status, o.reserved_by, lower(o.buyer_wallet) AS buyer_wallet,
      o.market_origin, o.market_draft_id, o.market_listing_id, o.market_checkout_id,
      o.market_buyer, o.pending_payment_attempt_id,
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
    JOIN residents maker ON maker.id = thing.maker_id
    JOIN residents current_owner ON current_owner.id = thing.owner_id
    JOIN residents seller ON seller.id = o.seller_id
    LEFT JOIN residents buyer ON buyer.id = o.buyer_id
    LEFT JOIN sale_payments payment ON payment.offer_id = o.id
    WHERE o.id = $1 AND o.channel = 'world' AND o.asset_type = 'thing'
  `, [offerId])
  return offerRecord(rows[0])
}

async function publicOfferIsHidden(
  dependencies: WorldMarketDependencies,
  thingId: number,
): Promise<boolean> {
  const rows = await dependencies.query(`
    /* world-market:public-moderation */
    SELECT action
    FROM moderation_actions
    WHERE target_type = 'thing' AND target_id = $1
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `, [thingId])
  return rows[0]?.action === 'remove'
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

function paymentTerminal(offer: OfferRecord): boolean {
  return offer.status === 'open'
    && (offer.x402_evidence_state === 'expired' || offer.x402_evidence_state === 'founder_review')
    && offer.pending_payment_attempt_id != null && offer.pending_x402_tx_hash != null
    && offer.pending_x402_payer != null && offer.pending_x402_at != null
}

function publicOffer(offer: OfferRecord, now: Date) {
  const phase = offer.status === 'claimed'
    ? 'claimed'
    : offer.status === 'canceled'
      ? 'canceled'
      : offer.x402_evidence_state === 'invalid' ? 'payment_invalid'
      : offer.x402_evidence_state === 'founder_review' ? 'founder_review'
      : offer.x402_evidence_state === 'expired' ? 'payment_expired'
      : offer.pending_x402_tx_hash != null ? 'payment_pending'
      : reservationActive(offer, now) ? 'reserved' : 'listed'
  return {
    id: offer.id,
    channel: 'world' as const,
    phase,
    asset_type: 'thing' as const,
    asset_id: offer.asset_id,
    asset_name: offer.asset_name,
    maker_id: offer.maker_id,
    made_by: offer.made_by,
    current_owner_id: offer.current_owner_id,
    current_owner: offer.current_owner,
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
    `active five-minute reservation: pay $${offer.price_usdc} USDC from ${offer.buyer_wallet} and retry with X-PAYMENT`,
  )
}

async function getMarket(
  c: Context,
  dependencies: WorldMarketDependencies,
  path: string,
): Promise<unknown | Response> {
  try {
    return await dependencies.marketGet(path)
  } catch (error) {
    if (error instanceof MarketReadError && error.kind === 'not_found') {
      return err(c, 404, missingMarketRecord(path))
    }
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
    findPayment: findPaymentAttempt,
    runPayment: runDurableX402,
    resumePayment: resumeDurableX402,
  }
}

export function mountWorldMarketRoutes(
  app: Hono,
  suppliedDependencies?: WorldMarketDependencies,
): void {
  const dependencies = suppliedDependencies ?? defaultDependencies()

  app.get('/api/world/resident/:handle', async c => {
    const allowed = allowedPublicQuery(c.req.queries(), [])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const handle = c.req.param('handle')
    if (!HANDLE_RE.test(handle)) {
      return err(c, 404, `resident handle ${handle} was not found; use GET /api/residents and send a current handle`)
    }
    const rows = await dependencies.query(`
      /* world-market:resident */
      SELECT handle FROM residents WHERE handle = $1
    `, [handle])
    return rows[0]?.handle === handle
      ? c.json({ resident: { handle } })
      : err(c, 404, `resident handle ${handle} was not found; use GET /api/residents and send a current handle`)
  })

  app.get('/api/world/offer/:offerId', async c => {
    const allowed = allowedPublicQuery(c.req.queries(), [])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const offerId = positiveId(c.req.param('offerId'))
    if (!offerId) return err(c, 400, WORLD_OFFER_ID_REFUSAL)
    const offer = await readOffer(dependencies, offerId)
    if (!offer) return err(c, 404, `world offer_id ${offerId} was not found; re-read the 1F3EA listing and send its current city offer_id`)
    if (await publicOfferIsHidden(dependencies, offer.asset_id)) {
      return publicJson(c, { offer: { id: offer.id, status: 'maintainer_hidden' } })
    }
    return publicJson(c, { offer: publicOffer(offer, dependencies.now()) })
  })

  app.post('/api/world/listing', async c => {
    const seller = await dependencies.authenticate(c)
    if (!seller) return err(c, 401, RESIDENT_AUTH_REFUSAL)
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
    if (!draft) return err(c, 502, 'the market returned an invalid public draft; retry after 1F3EA returns the current draft')
    if (draft.assetId !== thingId) return err(c, 409, 'market draft names a different city thing; create a fresh draft for this exact thing_id before listing it')
    if (
      draft.status !== 'pending' || draft.listingId !== null || draft.listingState !== null ||
      draft.expiresAt <= now || draft.createdAt > new Date(now.getTime() + 60_000)
    ) return err(c, 409, 'market draft must be pending, unexpired, and not yet listed; open a fresh draft before listing this thing')

    const thingRows = await dependencies.query(`
      /* world-market:thing */
      SELECT id, name, owner_id, withdrawn_at, active_offer_id
      FROM things WHERE id = $1
    `, [thingId])
    const thing = thingRows[0]
    if (!thing) return err(c, 404, `thing_id ${thingId} was not found; use GET /api/things and send a current active thing_id`)
    if (integerValue(thing.owner_id) !== seller.id) return err(c, 403, 'only the thing owner may list it')
    if (thing.withdrawn_at != null) return err(c, 409, 'a withdrawn thing cannot be listed; choose another active thing because withdrawal is permanent')
    if (thing.active_offer_id != null) return err(c, 409, 'this thing is already locked by an offer; close its current offer before listing it again')

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
      if (!offer) return err(c, 500, `world offer result is unavailable after listing; re-read GET /api/world/offer/${offerId} before deciding whether to retry`)
      return c.json({ offer: publicOffer(offer, dependencies.now()) }, 201)
    } catch (error) {
      if (postgresErrorCode(error) === '23505') {
        return err(c, 409, 'this draft or thing already has a world offer; use that existing offer or close it before listing again')
      }
      throw error
    }
  })

  app.post('/api/world/offer/:offerId/claim', async c => {
    const buyer = await dependencies.authenticate(c)
    if (!buyer) return err(c, 401, `${RESIDENT_AUTH_REFUSAL}, then move into the city before paying`)
    const unavailable = paymentReadinessResponse(c)
    if (unavailable) return unavailable
    const offerId = positiveId(c.req.param('offerId'))
    if (!offerId) return err(c, 400, WORLD_OFFER_ID_REFUSAL)
    const body = await jsonObject(c)
    if (!body || !hasOnly(body, ['market_checkout_id', 'buyer_wallet'])) {
      return err(c, 400, 'body may contain market_checkout_id and buyer_wallet only; paid claims use X-PAYMENT')
    }
    const checkoutId = body.market_checkout_id == null ? null : positiveId(body.market_checkout_id)
    if (body.market_checkout_id != null && checkoutId == null) {
      return err(c, 400, 'market_checkout_id must be a positive integer')
    }
    const requestedWallet = body.buyer_wallet == null ? null : wallet(body.buyer_wallet)
    if (body.buyer_wallet != null && !requestedWallet) return err(c, 400, 'buyer_wallet must be a Base address')
    const paymentHeader = c.req.header('x-payment')
    const hasPayment = Boolean(paymentHeader)

    let offer = await readOffer(dependencies, offerId)
    if (!offer) return err(c, 404, `world offer_id ${offerId} was not found; re-read the 1F3EA listing and send its current city offer_id`)
    if (offer.status === 'claimed') {
      if (offer.buyer_id !== buyer.id) {
        return err(c, 403, 'this world offer was claimed by another resident; choose another active offer because this claim cannot change buyers')
      }
      if (checkoutId != null && checkoutId !== offer.market_checkout_id) {
        return err(c, 409, 'market_checkout_id does not match the settled payment; re-read the offer and resend its settled checkout id')
      }
      if (requestedWallet != null && requestedWallet !== offer.buyer_wallet) {
        return err(c, 409, 'buyer_wallet does not match the settled payment; re-read the offer and resend its settled buyer wallet')
      }
      try {
        const completedAttempt = await findReplayableTargetPaymentAttempt({ query: dependencies.query }, {
          actorId: buyer.id,
          counterpartyId: offer.seller_id,
          operation: 'world_sale',
          targetKey: `world-sale:${offer.id}`,
          offerId: offer.id,
          assetType: 'thing',
          assetId: offer.asset_id,
          request: {
            offer_id: offer.id,
            market_checkout_id: offer.market_checkout_id,
            market_listing_id: offer.market_listing_id,
            market_draft_id: offer.market_draft_id,
            market_buyer: offer.market_buyer,
            buyer_wallet: offer.buyer_wallet,
            seller_wallet: offer.seller_wallet,
            price_usdc: offer.price_usdc,
            asset_id: offer.asset_id,
          },
        })
        if (completedAttempt?.status === 'completed') {
          const replay = await dependencies.resumePayment({
            database: { query: dependencies.query },
            attempt: completedAttempt,
            actorId: buyer.id,
          })
          if (replay.state === 'completed') return completedPaymentResponse(replay)
        }
      } catch (error) {
        if (error instanceof PaymentAttemptConflictError) return err(c, 409, error.message)
        throw error
      }
      return c.json({ offer: publicOffer(offer, dependencies.now()) })
    }
    if (offer.status === 'canceled') return err(c, 409, 'world offer is canceled; choose an active market listing instead')
    if (!offer.locked) return err(c, 409, 'the thing is not locked by this world offer; the seller must list it again from its matching market draft')
    if (offer.seller_id === buyer.id) return err(c, 400, 'you cannot buy your own thing; choose an active offer from another seller')

    const now = dependencies.now()
    const pendingAtStart = paymentPending(offer)
    const active = reservationActive(offer, now)
    const existingAttempt = offer.buyer_id === buyer.id
      ? await dependencies.findPayment({ query: dependencies.query }, {
        actorId: buyer.id,
        operation: 'world_sale',
        offerId: offer.id,
      })
      : null
    if (pendingAtStart) {
      if (offer.buyer_id !== buyer.id) {
        return err(c, 409, 'this world offer has a settled payment pending for another resident; choose another offer and do not pay this one')
      }
      if (checkoutId != null && checkoutId !== offer.market_checkout_id) {
        return err(c, 409, 'market_checkout_id does not match the settled payment; re-read the offer and resend its settled checkout id')
      }
      if (requestedWallet != null && requestedWallet !== offer.buyer_wallet) {
        return err(c, 409, 'buyer_wallet does not match the settled payment; re-read the offer and resend its settled buyer wallet')
      }
      if (!existingAttempt || existingAttempt.publicId !== offer.pending_payment_attempt_id) {
        return err(c, 503, 'the pending payment custody record is unavailable; retry this same offer later and do not pay again')
      }
    } else if (!active && !existingAttempt) {
      if (hasPayment) return err(c, 409, 'open a five-minute reservation before sending payment')
      if (!checkoutId || !requestedWallet) {
        return err(c, 400, 'first claim call requires market_checkout_id and buyer_wallet')
      }

      const checkoutPayload = await getMarket(c, dependencies, `/api/world/checkout/${checkoutId}`)
      if (isResponse(checkoutPayload)) return checkoutPayload
      const checkout = checkoutRecord(checkoutPayload, checkoutId)
      if (!checkout) return err(c, 502, 'the market returned an invalid public checkout; do not pay and retry after 1F3EA returns a current checkout')
      if (
        checkout.status !== 'active' || checkout.expiresAt <= now ||
        checkout.createdAt > new Date(now.getTime() + 60_000)
      ) {
        return err(c, 409, 'market checkout is expired or not active; open a fresh checkout on the current listing, then retry')
      }
      if (
        checkout.offerId !== offer.id || checkout.draftId !== offer.market_draft_id ||
        checkout.cityHandle !== buyer.handle ||
        (offer.market_listing_id != null && offer.market_listing_id !== checkout.listingId)
      ) return err(c, checkout.cityHandle !== buyer.handle ? 403 : 409, 'market checkout does not match this resident and world offer')

      const draftPayload = await getMarket(c, dependencies, `/api/world/draft/${offer.market_draft_id}`)
      if (isResponse(draftPayload)) return draftPayload
      const draft = draftRecord(draftPayload, offer.market_draft_id)
      if (!draft) return err(c, 502, 'the market returned an invalid public listing record; retry after 1F3EA returns the current listing')
      if (
        draft.status !== 'active' ||
        draft.listingId !== checkout.listingId || draft.listingState !== 'active' ||
        !draftMatchesOffer(draft, offer)
      ) return err(c, 409, 'market listing is not active or does not match this world offer; re-read 1F3EA and use its current active listing')

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
            AND NOT EXISTS (
              SELECT 1 FROM payment_attempts
              WHERE payment_attempts.operation = 'world_sale'
                AND payment_attempts.offer_id = transfer_offers.id
                AND payment_attempts.status IN ('settling', 'payment_pending', 'needs_review')
            )
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
          return err(c, 409, 'this market checkout is already bound to another world offer; use its bound offer or open a fresh checkout')
        }
        throw error
      }
      const reservingOfferId = offer.id
      offer = await readOffer(dependencies, reservingOfferId)
      if (!offer || !reservationActive(offer, dependencies.now())) {
        return err(c, 409, `the five-minute reservation could not be opened; re-read GET /api/world/offer/${reservingOfferId} before retrying`)
      }
      return challenge(c, offer)
    }

    if (!pendingAtStart) {
      if (offer.buyer_id !== buyer.id) return err(c, 409, 'another resident has the active reservation; wait for its five-minute window to end or choose another offer')
      if (checkoutId != null && checkoutId !== offer.market_checkout_id) {
        return err(c, 409, 'market_checkout_id does not match the active reservation; re-read the offer and resend its reserved checkout id')
      }
      if (requestedWallet != null && requestedWallet !== offer.buyer_wallet) {
        return err(c, 409, 'buyer_wallet does not match the active reservation; re-read the offer and resend its reserved buyer wallet')
      }
      if (!hasPayment && !existingAttempt) return challenge(c, offer)
    }

    const reservedAt = timestamp(offer.reserved_at)!
    const reservedUntil = timestamp(offer.reserved_until)!
    const accepted = requirements(
      offer.seller_wallet,
      offer.price_usdc,
      `${CITY_ORIGIN}/api/world/offer/${offer.id}/claim`,
      `1F3D9 world offer ${offer.id}`,
    )
    const paymentRequest = {
      offer_id: offer.id,
      market_checkout_id: offer.market_checkout_id,
      market_listing_id: offer.market_listing_id,
      market_draft_id: offer.market_draft_id,
      market_buyer: offer.market_buyer,
      buyer_wallet: offer.buyer_wallet,
      seller_wallet: offer.seller_wallet,
      price_usdc: offer.price_usdc,
      asset_id: offer.asset_id,
    }
    const payment = paymentHeader
      ? await dependencies.runPayment({
        database: { query: dependencies.query },
        paymentHeader,
        accepted,
        actorId: buyer.id,
        counterpartyId: offer.seller_id,
        operation: 'world_sale',
        targetKey: `world-sale:${offer.id}`,
        offerId: offer.id,
        assetType: 'thing',
        assetId: offer.asset_id,
        request: paymentRequest,
        expectedPayerWallet: offer.buyer_wallet!,
        notBefore: reservedAt,
        notAfter: reservedUntil,
      })
      : await dependencies.resumePayment({
        database: { query: dependencies.query },
        attempt: existingAttempt!,
        actorId: buyer.id,
      })

    if (payment.state === 'completed') {
      return completedPaymentResponse(payment)
    }
    if (payment.state === 'unavailable') return c.json(payment.body, 503)
    if (payment.state === 'rejected') {
      if (existingAttempt) {
        try {
          await closeInvalidSalePaymentTarget(dependencies, {
            attemptId: existingAttempt.publicId,
          })
        } catch (error) {
          if (!(error instanceof PaymentSaleConflictError)) throw error
        }
      }
      return payment.status === 409
        ? c.json(payment.body, 409)
        : c.json(payment.body, 400)
    }
    if (payment.state === 'payment_pending') {
      let pendingOffer = offer
      if (payment.txHash && payment.payerWallet) {
        try {
          const parked = await parkWorldSalePayment(dependencies, {
            attemptId: payment.attemptId,
          })
          if (parked.state === 'parked') {
            pendingOffer = await readOffer(dependencies, offer.id) ?? offer
          }
        } catch (error) {
          if (postgresErrorCode(error) !== '23505') throw error
        }
      }
      return c.json({
        ...payment.body,
        offer: publicOffer(pendingOffer, dependencies.now()),
        retry: 'retry this same claim; the recorded payment remains reserved',
      }, 202)
    }

    try {
      const completed = await completeWorldSalePayment(dependencies, {
        attemptId: payment.attemptId,
        leaseOwner: payment.leaseOwner,
      })
      if (completed.state === 'completed') {
        return paymentJsonResponse(
          completed.responseBody,
          completed.status,
          completed.paymentResponseHeader ?? payment.paymentResponseHeader,
        )
      }
      const reason = completed.state === 'deadline_passed'
        ? 'matching payment finalized after automatic recovery closed'
        : completed.reason
      await closeSalePaymentTarget(dependencies, {
        attemptId: payment.attemptId,
        leaseOwner: payment.leaseOwner,
        reason,
        state: 'founder_review',
      })
      const reviewed = await readOffer(dependencies, offer.id)
      return paymentJsonResponse(JSON.stringify({
        payment: 'founder_review',
        payment_attempt_id: payment.attemptId,
        transaction: payment.txHash,
        do_not_pay_again: true,
        error: 'payment needs founder review; no ownership changed',
        ...(reviewed ? { offer: publicOffer(reviewed, dependencies.now()) } : {}),
      }), 409, payment.paymentResponseHeader)
    } catch (error) {
      if (postgresErrorCode(error) === '23505') {
        return c.json({
          error: `that payment transaction is already reserved; inspect GET /api/world/offer/${offer.id} and do not pay again`,
          do_not_pay_again: true,
        }, 409)
      }
      throw error
    }
  })

  app.post('/api/world/offer/:offerId/reconcile', async c => {
    const actor = await dependencies.authenticate(c)
    if (!actor) return err(c, 401, RESIDENT_AUTH_REFUSAL)
    const offerId = positiveId(c.req.param('offerId'))
    if (!offerId) return err(c, 400, WORLD_OFFER_ID_REFUSAL)
    const body = await jsonObject(c)
    if (!body || !hasOnly(body, [])) return err(c, 400, 'reconcile body must be empty')
    let offer = await readOffer(dependencies, offerId)
    if (!offer) return err(c, 404, `world offer_id ${offerId} was not found; re-read the 1F3EA listing and send its current city offer_id`)
    if (actor.id !== offer.seller_id && actor.id !== offer.buyer_id) {
      return err(c, 403, 'only this offer seller or buyer may reconcile its payment')
    }
    if (offer.status === 'claimed' || offer.status === 'canceled' || paymentInvalid(offer)) {
      return c.json({ offer: publicOffer(offer, dependencies.now()) })
    }
    const readiness = paymentReadinessResponse(c)
    if (readiness) return readiness
    if (
      !paymentPending(offer) || offer.buyer_id == null
      || offer.pending_payment_attempt_id == null
    ) return err(c, 409, `this world offer has no durable payment to reconcile; re-read GET /api/world/offer/${offer.id} and reconcile only payment_pending offers`)

    const attempt = await dependencies.findPayment({ query: dependencies.query }, {
      actorId: offer.buyer_id,
      operation: 'world_sale',
      offerId: offer.id,
    })
    if (!attempt || attempt.publicId !== offer.pending_payment_attempt_id) {
      return err(c, 503, 'the pending payment custody record is unavailable; retry this same reconciliation later and do not pay again')
    }
    const payment = await dependencies.resumePayment({
      database: { query: dependencies.query },
      attempt,
      actorId: offer.buyer_id,
    })
    if (payment.state === 'completed') {
      return completedPaymentResponse(payment)
    }
    if (payment.state === 'unavailable') return c.json(payment.body, 503)
    if (payment.state === 'payment_pending') {
      return c.json({
        ...payment.body,
        offer: publicOffer(offer, dependencies.now()),
        retry: 'retry this reconciliation; the recorded payment remains reserved',
      }, 202)
    }
    if (payment.state === 'rejected') {
      const synchronized = await closeInvalidSalePaymentTarget(dependencies, {
        attemptId: attempt.publicId,
      })
      if (!synchronized.evidenceSynchronized) return c.json(payment.body, payment.status)
      offer = await readOffer(dependencies, offer.id)
      if (!offer || !paymentInvalid(offer)) {
        return err(c, 500, 'invalid payment audit record is unavailable; do not pay again and ask the city owner to inspect this offer before retrying')
      }
      return c.json({ offer: publicOffer(offer, dependencies.now()) })
    }

    try {
      const completed = await completeWorldSalePayment(dependencies, {
        attemptId: payment.attemptId,
        leaseOwner: payment.leaseOwner,
      })
      if (completed.state === 'completed') {
        return paymentJsonResponse(
          completed.responseBody,
          completed.status,
          completed.paymentResponseHeader ?? payment.paymentResponseHeader,
        )
      }
      const reason = completed.state === 'deadline_passed'
        ? 'matching payment finalized after automatic recovery closed'
        : completed.reason
      await closeSalePaymentTarget(dependencies, {
        attemptId: payment.attemptId,
        leaseOwner: payment.leaseOwner,
        reason,
        state: 'founder_review',
      })
      const reviewed = await readOffer(dependencies, offer.id)
      return paymentJsonResponse(JSON.stringify({
        payment: 'founder_review',
        payment_attempt_id: payment.attemptId,
        transaction: payment.txHash,
        do_not_pay_again: true,
        error: 'payment needs founder review; no ownership changed',
        ...(reviewed ? { offer: publicOffer(reviewed, dependencies.now()) } : {}),
      }), 409, payment.paymentResponseHeader)
    } catch (error) {
      if (postgresErrorCode(error) === '23505') {
        return c.json({
          error: `that payment transaction is already reserved; inspect GET /api/world/offer/${offer.id} and do not pay again`,
          do_not_pay_again: true,
        }, 409)
      }
      throw error
    }
  })

  app.post('/api/world/offer/:offerId/cancel', async c => {
    const seller = await dependencies.authenticate(c)
    if (!seller) return err(c, 401, RESIDENT_AUTH_REFUSAL)
    const offerId = positiveId(c.req.param('offerId'))
    if (!offerId) return err(c, 400, WORLD_OFFER_ID_REFUSAL)
    const body = await jsonObject(c)
    if (!body || !hasOnly(body, [])) return err(c, 400, 'cancel body must be empty')
    let offer = await readOffer(dependencies, offerId)
    if (!offer) return err(c, 404, `world offer_id ${offerId} was not found; re-read the 1F3EA listing and send its current city offer_id`)
    if (offer.seller_id !== seller.id) return err(c, 403, 'only the seller may cancel this world offer')
    if (offer.status === 'canceled') return c.json({ offer: publicOffer(offer, dependencies.now()) })
    if (offer.status === 'claimed') {
      return err(c, 409, 'claimed world offer cannot be canceled; the completed sale is permanent, so list another owned thing instead')
    }
    if (paymentPending(offer)) {
      return err(c, 409, `a settled payment is pending; the thing stays locked for its buyer, who can retry claim or POST /api/world/offer/${offer.id}/reconcile without paying again`)
    }
    if (!paymentInvalid(offer) && !paymentTerminal(offer) && reservationActive(offer, dependencies.now())) {
      return err(c, 409, 'the buyer has an active five-minute payment window; let the buyer finish or retry cancellation after the window ends')
    }

    const endedStates = new Set(['withdrawn', 'removed', 'expired', 'canceled', 'sold'])
    const listingEndedStates = paymentInvalid(offer) || paymentTerminal(offer)
      ? new Set([...endedStates, 'stale'])
      : endedStates
    let marketEnded: boolean | undefined
    let endedListingAwaitingWorld = false
    if (offer.market_listing_id != null) {
      const listingPayload = await getMarket(c, dependencies, `/api/listing/${offer.market_listing_id}`)
      if (isResponse(listingPayload)) {
        if (listingPayload.status !== 404) return listingPayload
      } else {
        const listing = object(object(listingPayload)?.listing)
        const listingId = positiveId(listing?.id)
        const listingOfferId = positiveId(listing?.world_offer_id)
        const listingDraftId = positiveId(listing?.world_draft_id)
        const listingState = publicLabel(listing?.state, 50)
        const worldState = publicLabel(listing?.world_state, 50)
        if (
          listingId !== offer.market_listing_id || listingOfferId !== offer.id ||
          listingDraftId !== offer.market_draft_id || !listingState || !worldState
        ) {
          return err(c, 502, 'the market returned an invalid public listing record; retry after 1F3EA returns the current listing')
        }
        marketEnded = listingEndedStates.has(listingState) && listingEndedStates.has(worldState)
        endedListingAwaitingWorld = listingEndedStates.has(listingState) && !listingEndedStates.has(worldState)
      }
    }
    if (marketEnded === undefined) {
      const draftPayload = await getMarket(c, dependencies, `/api/world/draft/${offer.market_draft_id}`)
      if (isResponse(draftPayload)) return draftPayload
      const draft = draftRecord(draftPayload, offer.market_draft_id)
      if (!draft || !draftMatchesOffer(draft, offer)) {
        return err(c, 502, 'the market returned an invalid public listing record; retry after 1F3EA returns the current listing')
      }
      marketEnded = draft.listingId != null || draft.listingState != null
        ? draft.listingId != null && draft.listingState != null && listingEndedStates.has(draft.listingState)
        : endedStates.has(draft.status) ||
          (draft.status === 'pending' && draft.expiresAt <= dependencies.now())
    }
    if (!marketEnded) {
      if (endedListingAwaitingWorld) {
        return err(c, 409, 'the market listing has ended, but its world record has not finished catching up; retry after 1F3EA finishes ending the listing')
      }
      return err(c, 409, 'the market listing is still live; withdraw it at 1F3EA, then retry cancellation here to unlock the thing')
    }

    const rows = await dependencies.query(`
      /* world-market:cancel */
      WITH canceled_offer AS (
        UPDATE transfer_offers SET status = 'canceled', canceled_at = clock_timestamp()
        WHERE id = $1 AND channel = 'world' AND status = 'open' AND seller_id = $2
          AND (
            pending_x402_tx_hash IS NULL
            OR x402_evidence_state IN ('invalid', 'expired', 'founder_review')
          )
          AND (
            reserved_until IS NULL OR reserved_until <= clock_timestamp()
            OR x402_evidence_state IN ('invalid', 'expired', 'founder_review')
          )
          AND NOT EXISTS (
            SELECT 1 FROM payment_attempts
            WHERE payment_attempts.offer_id = transfer_offers.id
              AND payment_attempts.operation = 'world_sale'
              AND payment_attempts.status IN ('settling', 'payment_pending', 'needs_review')
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
    if (!rows[0]) return err(c, 409, 'offer, reservation, or ownership changed before cancellation; re-read the offer before retrying')
    offer = await readOffer(dependencies, offer.id)
    if (!offer) return err(c, 500, `canceled world record is unavailable; re-read GET /api/world/offer/${offerId} and do not repeat cancellation until its state is visible`)
    return c.json({ offer: publicOffer(offer, dependencies.now()) })
  })
}
