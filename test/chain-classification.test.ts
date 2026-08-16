import test from 'node:test'
import assert from 'node:assert/strict'

process.env.BASE_RPC_URL = 'https://classification-rpc.test'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const BUYER = '0x2222222222222222222222222222222222222222'
const OTHER = '0x3333333333333333333333333333333333333333'
const SELLER = '0x1111111111111111111111111111111111111111'
const TX = '0x' + 'ab'.repeat(32)
const BLOCK_HASH = '0x' + 'cd'.repeat(32)

const pad32 = (address: string) => '0x' + address.slice(2).padStart(64, '0')
const transfer = (from: string, amount: bigint) => ({
  address: USDC,
  topics: [TRANSFER_TOPIC, pad32(from), pad32(SELLER)],
  data: '0x' + amount.toString(16),
})

const rawLog = (addressByte: string, topicByte: string, data: string) => ({
  address: '0x' + addressByte.repeat(20),
  topics: ['0x' + topicByte.repeat(32)],
  data,
})

interface RpcState {
  status: '0x0' | '0x1'
  logs: ReturnType<typeof transfer>[]
  canonicalHash: string
  finalizedNumber: string
  malformedReceipt: boolean
}

let state: RpcState

globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] }
  let result: unknown = null
  if (body.method === 'eth_getTransactionReceipt') {
    result = state.malformedReceipt ? { status: '0x1' } : {
      status: state.status,
      blockHash: BLOCK_HASH,
      blockNumber: '0x100',
      logs: state.logs,
    }
  } else if (body.method === 'eth_getBlockByHash') {
    result = { timestamp: '0x64' }
  } else if (body.method === 'eth_getBlockByNumber') {
    result = body.params[0] === 'finalized'
      ? { number: state.finalizedNumber }
      : { number: '0x100', hash: state.canonicalHash }
  }
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}) as typeof fetch

const { classifyUsdcTransfer } = await import('../src/chain.ts')
const { classifyDirectPayment } = await import('../src/pay.ts')

function reset(patch: Partial<RpcState> = {}) {
  state = {
    status: '0x1',
    logs: [],
    canonicalHash: BLOCK_HASH,
    finalizedNumber: '0x100',
    malformedReceipt: false,
    ...patch,
  }
}

test('classification checks every transfer log before calling a finalized receipt invalid', async () => {
  reset({ logs: [transfer(OTHER, 2_000_000n), transfer(BUYER, 2_000_000n)] })
  const result = await classifyUsdcTransfer(TX, SELLER, 2_000_000n, {
    expectedFrom: BUYER,
    exactAmount: true,
  })
  assert.equal(result.state, 'matched')
  if (result.state === 'matched') assert.equal(result.from, BUYER)
})

test('an exact matching transfer remains pending until its canonical block is finalized', async () => {
  reset({ logs: [transfer(BUYER, 2_000_000n)], finalizedNumber: '0xff' })

  const result = await classifyUsdcTransfer(TX, SELLER, 2_000_000n, {
    expectedFrom: BUYER,
    exactAmount: true,
  })

  assert.deepEqual(result, { state: 'pending' })
})

test('a nine-log receipt ignores four empty-data logs and matches the later exact $1 transfer', async () => {
  reset({
    logs: [
      rawLog('44', '91', '0x'),
      rawLog('45', '92', '0x1'),
      rawLog('46', '93', '0x'),
      { address: USDC, topics: [TRANSFER_TOPIC, pad32(BUYER), pad32(SELLER)], data: '0x' },
      rawLog('47', '94', '0x2'),
      transfer(OTHER, 999_999n),
      transfer(BUYER, 1_000_000n),
      rawLog('48', '95', '0x'),
      rawLog('49', '96', '0x3'),
    ],
  })

  const result = await classifyUsdcTransfer(TX, SELLER, 1_000_000n, {
    expectedFrom: BUYER,
    exactAmount: true,
  })

  assert.equal(result.state, 'matched')
  if (result.state === 'matched') {
    assert.equal(result.from, BUYER)
    assert.equal(result.to, SELLER)
    assert.equal(result.amount, 1_000_000n)
    assert.equal(result.blockTime.toISOString(), '1970-01-01T00:01:40.000Z')
  }
})

test('an empty-data transfer-like log cannot poison a finalized receipt', async () => {
  reset({
    logs: [
      { address: USDC, topics: [TRANSFER_TOPIC, pad32(BUYER), pad32(SELLER)], data: '0x' },
    ],
  })

  assert.deepEqual(await classifyUsdcTransfer(TX, SELLER, 1_000_000n, {
    expectedFrom: BUYER,
    exactAmount: true,
  }), { state: 'invalid_final', reason: 'confirmed_mismatch' })
})

test('non-hex log data still keeps the receipt pending', async () => {
  reset({
    logs: [
      { address: USDC, topics: [TRANSFER_TOPIC, pad32(BUYER), pad32(SELLER)], data: '0xz1' },
    ],
  })

  assert.equal((await classifyUsdcTransfer(TX, SELLER, 1_000_000n, {
    expectedFrom: BUYER,
    exactAmount: true,
  })).state, 'pending')
})

test('mined but unfinalized mismatch and reorg ambiguity remain pending', async () => {
  reset({ logs: [transfer(OTHER, 2_000_000n)], finalizedNumber: '0xff' })
  assert.equal((await classifyUsdcTransfer(TX, SELLER, 2_000_000n, {
    expectedFrom: BUYER, exactAmount: true,
  })).state, 'pending')

  reset({ logs: [transfer(OTHER, 2_000_000n)], canonicalHash: '0x' + 'ef'.repeat(32) })
  assert.equal((await classifyUsdcTransfer(TX, SELLER, 2_000_000n, {
    expectedFrom: BUYER, exactAmount: true,
  })).state, 'pending')
})

test('a mined out-of-window transfer stays pending until its block is finalized', async () => {
  reset({ logs: [transfer(BUYER, 2_000_000n)], finalizedNumber: '0xff' })
  const pending = await classifyDirectPayment(
    TX,
    SELLER,
    2,
    new Date('1970-01-01T00:02:00.000Z'),
    new Date('1970-01-01T00:07:00.000Z'),
    { expectedFrom: BUYER, exactAmount: true },
  )
  assert.equal(pending.state, 'pending')

  state = { ...state, finalizedNumber: '0x100' }
  assert.deepEqual(await classifyDirectPayment(
    TX,
    SELLER,
    2,
    new Date('1970-01-01T00:02:00.000Z'),
    new Date('1970-01-01T00:07:00.000Z'),
    { expectedFrom: BUYER, exactAmount: true },
  ), { state: 'invalid_final', reason: 'confirmed_mismatch' })
})

test('only canonical finalized failed or mismatched receipts become invalid_final', async () => {
  reset({ logs: [transfer(OTHER, 2_000_000n)] })
  assert.deepEqual(await classifyUsdcTransfer(TX, SELLER, 2_000_000n, {
    expectedFrom: BUYER, exactAmount: true,
  }), { state: 'invalid_final', reason: 'confirmed_mismatch' })

  reset({ status: '0x0' })
  assert.deepEqual(await classifyUsdcTransfer(TX, SELLER, 2_000_000n), {
    state: 'invalid_final', reason: 'failed_transaction',
  })

  reset({ malformedReceipt: true })
  assert.equal((await classifyUsdcTransfer(TX, SELLER, 2_000_000n)).state, 'pending')
})
