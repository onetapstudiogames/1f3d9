import { createHash, createHmac } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { declaredBodyLength } from './bounded-body.ts'
import { parseCityCreditRequestId } from './city-credit.ts'
import { containsCredentialLikeInput } from './credential-safety.ts'
import { takePayPalCreditRateLimit } from './paypal-credit-store.ts'
import { PlayCreditFailure, playConfiguration, playCredits, playObject, playText, playTransaction,
  verifyPlayPurchase, verifyPlayWebhook, type PlayConfiguration, type PlayProduct } from './play-credit.ts'
import { applyPlayPurchase, createPlayOrder, playOrderReceipt, readPlayOrder, type PlayCreditDatabase } from './play-credit-store.ts'

const BASE = '/api/city-credit/play'
type Dependencies = Readonly<{ database: PlayCreditDatabase; environment?: Readonly<Record<string, string | undefined>>; fetcher?: typeof fetch }>

async function body(c: Context, maximum = 2_048): Promise<string> {
  if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
    || declaredBodyLength(c.req.header('content-length'), maximum) === 'unusable') {
    throw new PlayCreditFailure(400, 'Send one application/json body within the stated size limit.')
  }
  const raw = await c.req.text()
  if (!raw || Buffer.byteLength(raw) > maximum) throw new PlayCreditFailure(400, 'The Play request is empty or too large.')
  return raw
}

function json(raw: string): Record<string, unknown> {
  try { return playObject(JSON.parse(raw)) }
  catch { throw new PlayCreditFailure(400, 'Send one valid JSON object.') }
}

function fields(value: Record<string, unknown>, names: readonly string[]): void {
  if (Object.keys(value).some(key => !names.includes(key)) || names.some(key => !Object.hasOwn(value, key))) {
    throw new PlayCreditFailure(400, `Send only ${names.join(', ')}.`)
  }
}

function orderId(value: string | undefined): string {
  if (!value || !/^city_play_[a-f0-9]{32}$/u.test(value)) throw new PlayCreditFailure(404, 'That Play order was not found.')
  return value
}

async function rate(c: Context, deps: Dependencies, config: PlayConfiguration): Promise<void> {
  const env = deps.environment ?? process.env
  const address = env.VERCEL === '1'
    ? c.req.header('x-vercel-forwarded-for')?.split(',').map(part => part.trim()).filter(Boolean).at(-1) ?? 'unattributed'
    : 'local-or-unattributed'
  const hash = createHmac('sha256', config.callerHashSecret).update(`play:${address}`).digest('hex')
  if (!await takePayPalCreditRateLimit(deps.database, hash)) {
    c.header('Retry-After', '3600')
    throw new PlayCreditFailure(429, 'Please wait before trying Play credit again.')
  }
}

async function webhook(c: Context, deps: Dependencies, config: PlayConfiguration): Promise<Response> {
  if (!verifyPlayWebhook(c.req.header('authorization'), config.webhookAuth, '')) {
    throw new PlayCreditFailure(401, 'The Play notification was not accepted.')
  }
  const raw = await body(c, 1_048_576)
  if (!verifyPlayWebhook(c.req.header('authorization'), config.webhookAuth, raw, config.webhookSecret, c.req.header('x-revenuecat-webhook-signature'))) {
    throw new PlayCreditFailure(401, 'The Play notification was not accepted.')
  }
  const event = playObject(json(raw).event)
  if (!['NON_RENEWING_PURCHASE', 'CANCELLATION'].includes(String(event.type))) return c.json({ outcome: 'ignored' })
  playCredits(event.product_id)
  const transaction = playTransaction(event.transaction_id)
  const eventId = playText(event.id, 'event id')
  if (!['PRODUCTION', 'SANDBOX'].includes(String(event.environment)) || event.store !== 'PLAY_STORE') {
    throw new PlayCreditFailure(400, 'Send a Google Play purchase notification with its environment.')
  }
  const aliases = event.aliases === undefined ? [] : event.aliases
  if (!Array.isArray(aliases) || aliases.length > 100) throw new PlayCreditFailure(400, 'The Play buyer aliases are invalid.')
  const appUserId = playText(event.app_user_id, 'app user id', 1500)
  const ids = [...new Set([appUserId, ...(event.original_app_user_id ? [playText(event.original_app_user_id, 'original app user id', 1500)] : []), ...aliases.map(id => playText(id, 'app user alias', 1500))])]
  const environment = event.environment === 'SANDBOX' ? 'sandbox' : 'production'
  if (environment !== config.environment) {
    const outcome = await applyPlayPurchase(deps.database, { orderId: null, eventId, eventType: event.type as 'NON_RENEWING_PURCHASE',
      transactionId: transaction, productId: event.product_id as PlayProduct, environment, configuredEnvironment: config.environment,
      purchasedAt: 0, appUserIds: ids })
    return c.json({ outcome })
  }
  const verified = await verifyPlayPurchase(config, appUserId, transaction, deps.fetcher)
  if (verified.productId !== event.product_id || verified.environment !== environment) throw new PlayCreditFailure(409, 'Play purchase details do not match this notification.')
  if (event.type === 'CANCELLATION' && !verified.refunded) throw new PlayCreditFailure(503, 'Play has not confirmed this refund yet. Retry this notification.')
  // A retried purchase event may now verify as refunded. Keep the original event
  // immutable and give this later REST observation its own stable private id.
  const observationId = verified.refunded && event.type !== 'CANCELLATION'
    ? `refund-observed:${createHash('sha256').update(eventId).digest('hex')}` : eventId
  const outcome = await applyPlayPurchase(deps.database, { orderId: null, eventId: observationId,
    eventType: verified.refunded ? 'CANCELLATION' : 'NON_RENEWING_PURCHASE', transactionId: transaction,
    productId: verified.productId, environment, configuredEnvironment: config.environment, purchasedAt: verified.purchasedAt, appUserIds: ids })
  return c.json({ outcome })
}

export function mountPlayCreditRoutes(app: Hono, deps: Dependencies): void {
  const route = (operation: string, handler: (c: Context, config: PlayConfiguration) => Promise<Response>) => async (c: Context) => {
    c.header('Cache-Control', 'no-store')
    c.header('Pragma', 'no-cache')
    const config = playConfiguration(deps.environment ?? process.env)
    if (!config) return c.json({ error: `Play ${operation} is unavailable because Play credit is not configured. No credit was added.` }, 503)
    try {
      if (Object.keys(c.req.queries()).length) throw new PlayCreditFailure(400, 'This Play route accepts no query options.')
      return await handler(c, config)
    } catch (error) {
      if (error instanceof PlayCreditFailure) return c.json({ error: error.message }, error.status)
      if (error instanceof TypeError) return c.json({ error: 'The Play request contains an invalid value.' }, 400)
      return c.json({ error: `Play ${operation} is temporarily unavailable. Retry the same request; do not pay again.` }, 503)
    }
  }
  app.get(`${BASE}/residents/by-handle/:handle`, route('resident lookup', async (c, config) => {
    const handle = playText(c.req.param('handle'), 'resident handle', 64)
    await rate(c, deps, config)
    const row = (await deps.database.query('SELECT id, handle FROM residents WHERE handle = $1', [handle]))[0]
    if (!row) throw new PlayCreditFailure(404, 'That resident was not found.')
    return c.json({ resident_number: row.id, resident_handle: row.handle })
  }))
  app.post(`${BASE}/orders`, route('order creation', async (c, config) => {
    const input = json(await body(c))
    fields(input, ['request_id', 'resident_number', 'resident_handle', 'product_id', 'rc_app_user_id'])
    playCredits(input.product_id)
    const requestId = parseCityCreditRequestId(input.request_id)
    if (!requestId) throw new PlayCreditFailure(400, 'Send a new request id for this Play purchase.')
    const appUserId = playText(input.rc_app_user_id, 'app user id', 1500)
    if (containsCredentialLikeInput(appUserId)) throw new PlayCreditFailure(400, 'Send the app user id, never a resident key.')
    if (!Number.isSafeInteger(input.resident_number) || Number(input.resident_number) < 1 || Number(input.resident_number) > 2_147_483_647) throw new PlayCreditFailure(400, 'Send a positive resident number.')
    const handle = playText(input.resident_handle, 'resident handle', 64)
    await rate(c, deps, config)
    const resident = (await deps.database.query('SELECT id FROM residents WHERE id = $1 AND handle = $2', [input.resident_number, handle]))[0]
    if (!resident) throw new PlayCreditFailure(404, 'That resident name and number do not match.')
    const result = await createPlayOrder(deps.database, { requestId, recipientId: Number(input.resident_number), productId: input.product_id as PlayProduct, appUserId, environment: config.environment })
    return c.json({ order_id: result.order.public_id, resident_number: result.order.recipient_id, resident_handle: handle,
      credits: playCredits(result.order.product_id), claim_token: result.claimToken,
      ...(result.claimToken === null ? { notice: 'The claim key was shown once. Use your saved key; if it was not saved, create a new order before paying.' } : {}) })
  }))
  app.get(`${BASE}/orders/:orderId`, route('order lookup', async (c, config) => {
    const id = orderId(c.req.param('orderId'))
    await rate(c, deps, config)
    const order = await readPlayOrder(deps.database, id)
    if (!order) throw new PlayCreditFailure(404, 'That Play order was not found.')
    return c.json(playOrderReceipt(order))
  }))
  app.post(`${BASE}/orders/:orderId/claim`, route('purchase confirmation', async (c, config) => {
    const id = orderId(c.req.param('orderId'))
    const input = json(await body(c))
    fields(input, ['transaction_id'])
    const transaction = playTransaction(input.transaction_id)
    await rate(c, deps, config)
    const order = await readPlayOrder(deps.database, id)
    if (!order) throw new PlayCreditFailure(404, 'That Play order was not found.')
    const verified = await verifyPlayPurchase(config, order.rc_app_user_id, transaction, deps.fetcher)
    if (verified.productId !== order.product_id) throw new PlayCreditFailure(409, 'That Play purchase is for a different pack.')
    const eventType = verified.refunded ? 'CANCELLATION' : 'NON_RENEWING_PURCHASE'
    const eventId = `claim:${createHash('sha256').update(`${id}:${transaction}:${eventType}:${verified.environment}`).digest('hex')}`
    const outcome = await applyPlayPurchase(deps.database, { orderId: id, eventId, eventType, transactionId: transaction,
      productId: verified.productId, environment: verified.environment, configuredEnvironment: config.environment,
      purchasedAt: verified.purchasedAt, appUserIds: [order.rc_app_user_id] })
    if (outcome === 'unmatched') throw new PlayCreditFailure(409, 'That purchase cannot be matched to this Play order.')
    return c.json(playOrderReceipt((await readPlayOrder(deps.database, id))!))
  }))
  app.post(`${BASE}/webhook`, route('notification handling', (c, config) => webhook(c, deps, config)))
}
