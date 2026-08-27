import {
  deliverPayPalCreditAtomically,
  type PayPalCreditStoreDatabase,
  type StoredPayPalIntent,
} from './paypal-credit-store.ts'

export async function deliverPayPalCredit(
  database: PayPalCreditStoreDatabase,
  input: Readonly<{
    intent: StoredPayPalIntent
    sourceKey: string
    purchaseKind: 'paypal' | 'allowance'
    eventId: string
    eventKind: 'PAYMENT.CAPTURE.COMPLETED' | 'PAYMENT.SALE.COMPLETED'
    remoteResourceId: string
  }>,
): Promise<Readonly<Record<string, unknown>>> {
  return await deliverPayPalCreditAtomically(database, input)
}
