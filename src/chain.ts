export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
export const NETWORK = 'base'

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const BALANCE_OF = '0x70a08231'
const RPC = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org'
const RPC_TIMEOUT_MS = 4_000

let rpcId = 0

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  try {
    const response = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { result?: T }
    return body.result ?? null
  } catch {
    return null
  }
}

export function toUnits(usdc: number): bigint {
  return BigInt(Math.round(usdc * 1e6))
}

const pad32 = (address: string) =>
  '0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
const addressFromTopic = (topic: string) => '0x' + topic.slice(-40)

interface Log {
  address: string
  topics: string[]
  data: string
}

interface Receipt {
  status: string
  blockHash: string
  blockNumber: string
  logs: Log[]
}

export interface VerifiedTransfer {
  from: string
  to: string
  amount: bigint
  blockTime: Date
}

export type TransferCheck =
  | ({ state: 'matched'; finalized: boolean } & VerifiedTransfer)
  | { state: 'pending' }
  | { state: 'invalid_final'; reason: 'failed_transaction' | 'confirmed_mismatch' }

function completeReceipt(value: unknown): Receipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const receipt = value as Partial<Receipt>
  if (
    !['0x0', '0x1'].includes(String(receipt.status)) ||
    typeof receipt.blockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/u.test(receipt.blockHash) ||
    typeof receipt.blockNumber !== 'string' || !/^0x[0-9a-fA-F]+$/u.test(receipt.blockNumber) ||
    !Array.isArray(receipt.logs)
  ) return null
  for (const log of receipt.logs) {
    if (
      !log || typeof log !== 'object' || typeof log.address !== 'string' ||
      !Array.isArray(log.topics) || log.topics.some(topic => typeof topic !== 'string') ||
      typeof log.data !== 'string' || !/^0x[0-9a-fA-F]+$/u.test(log.data)
    ) return null
  }
  return receipt as Receipt
}

async function finalizedReceipt(
  receipt: Receipt,
): Promise<'finalized' | 'pending'> {
  const canonical = await rpc<{ hash?: unknown; number?: unknown }>(
    'eth_getBlockByNumber',
    [receipt.blockNumber, false],
  )
  if (
    !canonical || typeof canonical.hash !== 'string' || typeof canonical.number !== 'string' ||
    canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
    canonical.number.toLowerCase() !== receipt.blockNumber.toLowerCase()
  ) return 'pending'
  const finalized = await rpc<{ number?: unknown }>('eth_getBlockByNumber', ['finalized', false])
  if (!finalized || typeof finalized.number !== 'string' || !/^0x[0-9a-fA-F]+$/u.test(finalized.number)) {
    return 'pending'
  }
  try {
    return BigInt(finalized.number) >= BigInt(receipt.blockNumber) ? 'finalized' : 'pending'
  } catch {
    return 'pending'
  }
}

export async function classifyUsdcTransfer(
  txHash: string,
  to: string,
  minimum: bigint,
  options: { expectedFrom?: string; exactAmount?: boolean } = {},
): Promise<TransferCheck> {
  const rawReceipt = await rpc<unknown>('eth_getTransactionReceipt', [txHash])
  if (!rawReceipt) return { state: 'pending' }
  const receipt = completeReceipt(rawReceipt)
  if (!receipt) return { state: 'pending' }
  if (receipt.status === '0x0') {
    return await finalizedReceipt(receipt) === 'finalized'
      ? { state: 'invalid_final', reason: 'failed_transaction' }
      : { state: 'pending' }
  }

  const target = pad32(to)
  let transfer: Log | undefined
  try {
    transfer = receipt.logs.find(
      log =>
        log.address.toLowerCase() === USDC.toLowerCase() &&
        log.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
        (log.topics[2] ?? '').toLowerCase() === target &&
        (options.expectedFrom == null ||
          addressFromTopic(log.topics[1] ?? '').toLowerCase() === options.expectedFrom.toLowerCase()) &&
        (options.exactAmount === true ? BigInt(log.data) === minimum : BigInt(log.data) >= minimum),
    )
  } catch {
    return { state: 'pending' }
  }
  if (!transfer) {
    return await finalizedReceipt(receipt) === 'finalized'
      ? { state: 'invalid_final', reason: 'confirmed_mismatch' }
      : { state: 'pending' }
  }
  const fromTopic = transfer.topics[1]
  if (!fromTopic || !/^0x[0-9a-fA-F]{64}$/u.test(fromTopic)) return { state: 'pending' }

  const block = await rpc<{ timestamp?: unknown }>('eth_getBlockByHash', [receipt.blockHash, false])
  if (!block || typeof block.timestamp !== 'string' || !/^0x[0-9a-fA-F]+$/u.test(block.timestamp)) {
    return { state: 'pending' }
  }
  const blockTime = new Date(Number(BigInt(block.timestamp)) * 1000)
  if (Number.isNaN(blockTime.getTime())) return { state: 'pending' }
  const finalized = await finalizedReceipt(receipt) === 'finalized'
  return {
    state: 'matched',
    finalized,
    from: addressFromTopic(fromTopic),
    to,
    amount: BigInt(transfer.data),
    blockTime,
  }
}

export async function verifyUsdcTransfer(
  txHash: string,
  to: string,
  minimum: bigint,
): Promise<VerifiedTransfer | null> {
  const checked = await classifyUsdcTransfer(txHash, to, minimum)
  return checked.state === 'matched'
    ? { from: checked.from, to: checked.to, amount: checked.amount, blockTime: checked.blockTime }
    : null
}

export async function usdcBalance(address: string): Promise<string | null> {
  const result = await rpc<string>('eth_call', [
    { to: USDC, data: BALANCE_OF + pad32(address).slice(2) },
    'latest',
  ])
  if (!result) return null
  return (Number(BigInt(result)) / 1e6).toFixed(6)
}
