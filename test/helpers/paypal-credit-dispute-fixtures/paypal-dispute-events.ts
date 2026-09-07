import type { Pool } from 'pg'
import type { ParsedPayPalDisputeEvent } from '../../../src/paypal-credit-dispute.ts'

export function dispute(input: Readonly<{
  eventId: string
  eventKind: ParsedPayPalDisputeEvent['eventKind']
  disputeId: string
  captureId?: string
  captureIds?: readonly string[]
  updateTime: string
  paypalStatus?: ParsedPayPalDisputeEvent['paypalStatus']
  outcomeCode?: ParsedPayPalDisputeEvent['outcomeCode']
}>): ParsedPayPalDisputeEvent {
  return Object.freeze({
    eventId: input.eventId,
    eventKind: input.eventKind,
    disputeId: input.disputeId,
    captureIds: input.captureIds ?? [input.captureId!],
    paypalStatus: input.paypalStatus ?? (
      input.eventKind === 'CUSTOMER.DISPUTE.RESOLVED'
        ? 'RESOLVED'
        : input.eventKind === 'CUSTOMER.DISPUTE.UPDATED' ? 'UNDER_REVIEW' : 'OPEN'
    ),
    outcomeCode: input.outcomeCode ?? null,
    resourceUpdatedAt: input.updateTime,
  })
}

export async function rawApply(
  pool: Pool,
  input: Readonly<{
    eventId: string
    disputeId: string
    captureIds: readonly string[]
    outcomeCode?: ParsedPayPalDisputeEvent['outcomeCode']
  }>,
) {
  const resolved = input.outcomeCode !== undefined
  return await pool.query(`
    SELECT * FROM apply_paypal_credit_dispute(
      $1::text, $2::text, $3::text, $4::text[],
      $5::text, $6::text, $7::timestamptz
    )
  `, [
    input.eventId,
    resolved ? 'CUSTOMER.DISPUTE.RESOLVED' : 'CUSTOMER.DISPUTE.CREATED',
    input.disputeId,
    input.captureIds,
    resolved ? 'RESOLVED' : 'OPEN',
    input.outcomeCode ?? null,
    '2026-08-27T12:00:00.000Z',
  ])
}
