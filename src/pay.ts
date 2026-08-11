import type { Context } from 'hono'
import { NETWORK, USDC, toUnits, verifyUsdcTransfer } from './chain.ts'

export const TREASURY = (
  process.env.TREASURY_ADDRESS ?? '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
).toLowerCase()
export const CLAIM_FEE_USDC = 1
export const CLAIM_WINDOW_SECONDS = 300

const FACILITATOR = process.env.FACILITATOR_URL ?? 'https://facilitator.payai.network'
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/

export function canonicalTxHash(value: unknown): string | null {
  return typeof value === 'string' && TX_HASH_RE.test(value) ? value.toLowerCase() : null
}

export interface PaymentRequirements {
  scheme: 'exact'
  network: typeof NETWORK
  maxAmountRequired: string
  resource: string
  description: string
  mimeType: 'application/json'
  payTo: string
  maxTimeoutSeconds: number
  asset: string
  extra: { name: 'USD Coin'; version: '2' }
}

export function requirements(
  payTo: string,
  usdc: number,
  resource: string,
  description: string,
): PaymentRequirements {
  return {
    scheme: 'exact',
    network: NETWORK,
    maxAmountRequired: toUnits(usdc).toString(),
    resource,
    description,
    mimeType: 'application/json',
    payTo,
    maxTimeoutSeconds: CLAIM_WINDOW_SECONDS,
    asset: USDC,
    extra: { name: 'USD Coin', version: '2' },
  }
}

export function challenge402(c: Context, accepted: PaymentRequirements, note: string) {
  return c.json({ x402Version: 1, error: note, accepts: [accepted] }, 402)
}

export interface Settled {
  transaction: string
  payer: string
  raw: Record<string, unknown>
}

export async function settleX402(
  paymentHeader: string,
  accepted: PaymentRequirements,
): Promise<Settled | { error: string }> {
  let paymentPayload: unknown
  try {
    paymentPayload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'))
  } catch {
    return { error: 'X-PAYMENT header is not base64 JSON' }
  }

  const body = JSON.stringify({
    x402Version: 1,
    paymentPayload,
    paymentRequirements: accepted,
  })
  const options = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }

  try {
    const verificationResponse = await fetch(`${FACILITATOR}/verify`, options)
    const verification = (await verificationResponse.json().catch(() => null)) as
      | { isValid?: boolean; invalidReason?: string }
      | null
    if (!verificationResponse.ok || !verification?.isValid) {
      return { error: verification?.invalidReason ?? 'facilitator rejected the payment' }
    }

    const settlementResponse = await fetch(`${FACILITATOR}/settle`, options)
    const settlement = (await settlementResponse.json().catch(() => null)) as
      | { success?: boolean; transaction?: string; payer?: string; errorReason?: string }
      | null
    if (!settlementResponse.ok || !settlement?.success || !settlement.transaction) {
      return { error: settlement?.errorReason ?? 'settlement failed' }
    }
    const transaction = canonicalTxHash(settlement.transaction)
    if (!transaction) return { error: 'settlement returned an invalid transaction hash' }

    const embeddedPayer = String(
      (paymentPayload as { payload?: { authorization?: { from?: string } } })?.payload
        ?.authorization?.from ?? '',
    )
    return {
      transaction,
      payer: settlement.payer ?? embeddedPayer,
      raw: settlement as Record<string, unknown>,
    }
  } catch {
    return { error: 'facilitator unreachable — direct USDC transfer + tx-hash proof also works' }
  }
}

export function paymentResponseHeader(settled: Settled): string {
  return Buffer.from(JSON.stringify(settled.raw)).toString('base64')
}

export async function verifyDirectPayment(
  txHash: string,
  to: string,
  usdc: number,
  notBefore: Date,
  notAfter?: Date,
): Promise<{ from: string; amount: string; blockTime: Date } | null> {
  const canonical = canonicalTxHash(txHash)
  if (!canonical) return null
  const transfer = await verifyUsdcTransfer(canonical, to, toUnits(usdc))
  if (!transfer || transfer.blockTime < notBefore) return null
  if (notAfter && transfer.blockTime > notAfter) return null
  return {
    from: transfer.from,
    amount: (Number(transfer.amount) / 1e6).toFixed(6),
    blockTime: transfer.blockTime,
  }
}
