import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const PLAY_CREDIT_PACKS = Object.freeze({ fee_credit_1_v1: 1, fee_credit_5_v1: 5, fee_credit_10_v1: 10 })
export type PlayProduct = keyof typeof PLAY_CREDIT_PACKS
export type PlayEnvironment = 'production' | 'sandbox'
export type PlayConfiguration = Readonly<{
  secretKey: string; projectId: string; webhookAuth: string; webhookSecret?: string
  callerHashSecret: string; environment: PlayEnvironment
}>

export class PlayCreditFailure extends Error {
  readonly status: 400 | 401 | 404 | 409 | 429 | 503
  constructor(status: PlayCreditFailure['status'], message: string) {
    super(message)
    this.status = status
  }
}

export function playCredits(product: unknown): number {
  if (typeof product !== 'string' || !Object.hasOwn(PLAY_CREDIT_PACKS, product)) {
    throw new PlayCreditFailure(400, 'Choose one of the three Play credit packs.')
  }
  return PLAY_CREDIT_PACKS[product as PlayProduct]
}

export function playConfiguration(env: Readonly<Record<string, string | undefined>>): PlayConfiguration | null {
  const names = ['REVENUECAT_SECRET_KEY', 'REVENUECAT_PROJECT_ID', 'REVENUECAT_WEBHOOK_AUTH', 'PLAY_CREDIT_CALLER_HASH_SECRET']
  if (names.some(name => !env[name]?.trim() || /[\r\n]/u.test(env[name]!))) return null
  if (env.PLAY_CREDIT_ENVIRONMENT !== 'production' && env.PLAY_CREDIT_ENVIRONMENT !== 'sandbox') return null
  if (env.VERCEL_ENV === 'production' && env.PLAY_CREDIT_ENVIRONMENT !== 'production') return null
  if (env.REVENUECAT_WEBHOOK_SECRET !== undefined && !env.REVENUECAT_WEBHOOK_SECRET.trim()) return null
  return Object.freeze({
    secretKey: env.REVENUECAT_SECRET_KEY!, projectId: env.REVENUECAT_PROJECT_ID!,
    webhookAuth: env.REVENUECAT_WEBHOOK_AUTH!,
    ...(env.REVENUECAT_WEBHOOK_SECRET === undefined ? {} : { webhookSecret: env.REVENUECAT_WEBHOOK_SECRET }),
    callerHashSecret: env.PLAY_CREDIT_CALLER_HASH_SECRET!, environment: env.PLAY_CREDIT_ENVIRONMENT,
  })
}

function equal(left: string, right: string): boolean {
  return timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest())
}

export function verifyPlayWebhook(auth: string | undefined, expected: string, body: string,
  secret?: string, signature?: string, now = Date.now() / 1000): boolean {
  if (!equal(auth ?? '', expected) || !auth || !expected) return false
  if (!secret) return true
  const match = /^t=([0-9]{1,12}),v1=([0-9a-f]{64})$/u.exec(signature ?? '')
  if (!match || Math.abs(now - Number(match[1])) > 300) return false
  return equal(createHmac('sha256', secret).update(`${match[1]}.${body}`).digest('hex'), match[2]!)
}

export function playText(value: unknown, name: string, maximum = 255): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new PlayCreditFailure(400, `Send a valid ${name}.`)
  }
  return value
}

export function playTransaction(value: unknown): string {
  const parsed = playText(value, 'Play transaction id', 128)
  if (!/^GPA\.[A-Za-z0-9.-]+$/u.test(parsed)) throw new PlayCreditFailure(400, 'Send the exact Google Play transaction id.')
  return parsed
}

export function playObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlayCreditFailure(400, 'Send one JSON object.')
  return value as Record<string, unknown>
}

type VerifiedPlayPurchase = Readonly<{
  productId: PlayProduct; transactionId: string; environment: PlayEnvironment; refunded: boolean; purchasedAt: number
}>

// v1 non_subscriptions does not document the transaction/refund evidence this rail needs.
// v2 customer purchases scopes verification to this buyer; product_id is a RevenueCat id,
// so resolve its store_identifier rather than confusing it with the Play product id.
export async function verifyPlayPurchase(config: Pick<PlayConfiguration, 'secretKey' | 'projectId'>,
  appUserId: string, transactionId: string, fetcher: typeof fetch = fetch): Promise<VerifiedPlayPurchase> {
  const base = `https://api.revenuecat.com/v2/projects/${encodeURIComponent(config.projectId)}`
  const deadline = AbortSignal.timeout(15_000)
  const get = async (url: string) => {
    try {
      const response = await fetcher(url, { headers: { Authorization: `Bearer ${config.secretKey}` }, signal: deadline, redirect: 'error' })
      if (!response.ok) throw new Error('provider unavailable')
      return playObject(await response.json())
    } catch {
      throw new PlayCreditFailure(503, 'Play could not confirm this purchase yet. Retry the same order; do not pay again.')
    }
  }
  let cursor: string | null = null
  for (let page = 0; page < 10; page += 1) {
    const url = `${base}/customers/${encodeURIComponent(appUserId)}/purchases?limit=100${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ''}`
    const result = await get(url)
    if (!Array.isArray(result.items)) break
    const matches = result.items.map(playObject).filter(item => item.store_purchase_identifier === transactionId)
    if (matches.length > 1) break
    const purchase = matches[0]
    if (purchase) {
      if (purchase.store !== 'play_store' || !['production', 'sandbox'].includes(String(purchase.environment))
        || !['owned', 'refunded'].includes(String(purchase.status)) || typeof purchase.purchased_at !== 'number'
        || !Number.isSafeInteger(purchase.purchased_at)) break
      const product = await get(`${base}/products/${encodeURIComponent(playText(purchase.product_id, 'RevenueCat product id'))}`)
      playCredits(product.store_identifier)
      if (product.type !== 'one_time' || playObject(product.one_time).is_consumable !== true) break
      return Object.freeze({ productId: product.store_identifier as PlayProduct, transactionId,
        environment: purchase.environment as PlayEnvironment, refunded: purchase.status === 'refunded', purchasedAt: purchase.purchased_at })
    }
    if (!result.next_page || result.items.length === 0) break
    cursor = playText(playObject(result.items.at(-1)).id, 'purchase page id')
  }
  throw new PlayCreditFailure(409, 'Play has not confirmed this purchase for this order. Retry this order after the purchase appears in the app.')
}
