import type { PaymentRequirements } from '../src/pay.ts'

export declare function buildX402PaymentHeader(options: Readonly<{
  accepted: PaymentRequirements
  privateKey: `0x${string}`
  wallet: `0x${string}`
  nonce: `0x${string}`
  nowSeconds: number
}>): Promise<string>

export declare function runWorldBuy(options: Readonly<{
  listingId: number
  offerId: number
  wallet: string
  cityKey: string
  marketKey: string
  privateKey: string
  cityOrigin?: string
  marketOrigin?: string
  stateDirectory?: string
  syncDelayMs?: number
  stdout?: (message: string) => void
  stderr?: (message: string) => void
}>): Promise<number>

export function freshWallet(makeKey?: () => `0x${string}`): { address: `0x${string}`; privateKey: `0x${string}` }
