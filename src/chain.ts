export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
export const NETWORK = 'base'

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const BALANCE_OF = '0x70a08231'
const RPC = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org'

let rpcId = 0

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  try {
    const response = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
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
  logs: Log[]
}

export interface VerifiedTransfer {
  from: string
  to: string
  amount: bigint
  blockTime: Date
}

export async function verifyUsdcTransfer(
  txHash: string,
  to: string,
  minimum: bigint,
): Promise<VerifiedTransfer | null> {
  const receipt = await rpc<Receipt>('eth_getTransactionReceipt', [txHash])
  if (!receipt || receipt.status !== '0x1') return null

  const target = pad32(to)
  const transfer = receipt.logs.find(
    log =>
      log.address.toLowerCase() === USDC.toLowerCase() &&
      log.topics[0] === TRANSFER_TOPIC &&
      (log.topics[2] ?? '').toLowerCase() === target &&
      BigInt(log.data) >= minimum,
  )
  if (!transfer) return null

  const block = await rpc<{ timestamp: string }>('eth_getBlockByHash', [receipt.blockHash, false])
  if (!block) return null
  return {
    from: addressFromTopic(transfer.topics[1] ?? ''),
    to,
    amount: BigInt(transfer.data),
    blockTime: new Date(Number(BigInt(block.timestamp)) * 1000),
  }
}

export async function usdcBalance(address: string): Promise<string | null> {
  const result = await rpc<string>('eth_call', [
    { to: USDC, data: BALANCE_OF + pad32(address).slice(2) },
    'latest',
  ])
  if (!result) return null
  return (Number(BigInt(result)) / 1e6).toFixed(6)
}
