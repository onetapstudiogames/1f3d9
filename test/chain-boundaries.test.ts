import test from 'node:test'
import assert from 'node:assert/strict'

process.env.BASE_RPC_URL = 'https://boundary-rpc.test'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const WRONG_TRANSFER_TOPIC = '0xddf252ad1be2c068fc378daa952ba7f163c4a11628f55a4df523b3ef'.padEnd(66, '0')
const REAL_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const AUTHORIZATION_USED_TOPIC = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5'
const PAYER = '0x2222222222222222222222222222222222222222'
const PAYEE = '0x1111111111111111111111111111111111111111'
const TX = `0x${'ab'.repeat(32)}`
const BLOCK_HASH = `0x${'cd'.repeat(32)}`
const NONCE = `0x${'ef'.repeat(32)}`

const topicAddress = (address: string) => `0x${address.slice(2).padStart(64, '0')}`

type RpcAnswer = Readonly<{ ok?: boolean; reject?: boolean; result?: unknown }>
let answer: (method: string, params: readonly unknown[]) => RpcAnswer

globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
  const request = JSON.parse(String(init?.body)) as {
    method: string
    params: readonly unknown[]
  }
  const response = answer(request.method, request.params)
  if (response.reject) throw new Error('simulated transport failure')
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: response.result }), {
    status: response.ok === false ? 503 : 200,
    headers: { 'content-type': 'application/json' },
  })
}) as typeof fetch

const {
  classifyUsdcTransfer,
  currentBaseBlockNumber,
  findFinalizedAuthorizationTransaction,
  toUnits,
  usdcBalance,
  verifyUsdcTransfer,
} = await import('../src/chain.ts')

const validReceipt = (patch: Record<string, unknown> = {}) => ({
  status: '0x1',
  blockHash: BLOCK_HASH,
  blockNumber: '0x100',
  logs: [],
  ...patch,
})

const transferLog = (patch: Record<string, unknown> = {}) => ({
  address: USDC,
  topics: [REAL_TRANSFER_TOPIC, topicAddress(PAYER), topicAddress(PAYEE)],
  data: '0xf4240',
  ...patch,
})

function finalizedRpc(receipt: unknown, patch: Record<string, unknown> = {}) {
  answer = (method, params) => {
    if (method === 'eth_getTransactionReceipt') return { result: receipt }
    if (method === 'eth_getBlockByNumber' && params[0] === 'finalized') {
      return { result: { number: '0x100' } }
    }
    if (method === 'eth_getBlockByNumber') {
      return { result: { hash: BLOCK_HASH, number: '0x100' } }
    }
    if (method === 'eth_getBlockByHash') return { result: { timestamp: '0x64' } }
    return { result: null }
  }
  const original = answer
  answer = (method, params) => {
    const key = `${method}:${String(params[0] ?? '')}`
    return Object.hasOwn(patch, key)
      ? { result: patch[key] }
      : original(method, params)
  }
}

test('chain helpers fail closed on transport, response, and result failures', async () => {
  for (const response of [
    { ok: false },
    { result: undefined },
    { reject: true },
    { result: 17 },
    { result: 'not-hex' },
  ] satisfies RpcAnswer[]) {
    answer = () => response
    assert.equal(await currentBaseBlockNumber(), null)
  }

  answer = () => ({ result: '0x10' })
  assert.equal(await currentBaseBlockNumber(), 16n)
  assert.equal(toUnits(1.2345674), 1_234_567n)
})

test('receipt validation rejects every malformed public-RPC shape', async () => {
  const malformed = [
    null,
    [],
    'receipt',
    validReceipt({ status: '0x2' }),
    validReceipt({ blockHash: 1 }),
    validReceipt({ blockHash: '0x12' }),
    validReceipt({ blockNumber: 256 }),
    validReceipt({ blockNumber: '256' }),
    validReceipt({ logs: 'logs' }),
    validReceipt({ logs: [null] }),
    validReceipt({ logs: [{ address: 1, topics: [], data: '0x' }] }),
    validReceipt({ logs: [{ address: USDC, topics: 'topics', data: '0x' }] }),
    validReceipt({ logs: [{ address: USDC, topics: [1], data: '0x' }] }),
    validReceipt({ logs: [{ address: USDC, topics: [], data: 1 }] }),
    validReceipt({ logs: [{ address: USDC, topics: [], data: 'not-hex' }] }),
  ]

  for (const receipt of malformed) {
    answer = () => ({ result: receipt })
    assert.deepEqual(await classifyUsdcTransfer(TX, PAYEE, 1n), { state: 'pending' })
  }
})

test('finality checks reject incomplete, changed, and malformed canonical blocks', async () => {
  const receipt = validReceipt({ status: '0x0' })
  const canonicalFailures = [
    null,
    {},
    { hash: 1, number: '0x100' },
    { hash: BLOCK_HASH, number: 256 },
    { hash: `0x${'ee'.repeat(32)}`, number: '0x100' },
    { hash: BLOCK_HASH, number: '0x101' },
  ]
  for (const canonical of canonicalFailures) {
    finalizedRpc(receipt, { 'eth_getBlockByNumber:0x100': canonical })
    assert.deepEqual(await classifyUsdcTransfer(TX, PAYEE, 1n), { state: 'pending' })
  }

  for (const finalized of [null, {}, { number: 256 }, { number: 'bad' }, { number: '0xff' }]) {
    finalizedRpc(receipt, { 'eth_getBlockByNumber:finalized': finalized })
    assert.deepEqual(await classifyUsdcTransfer(TX, PAYEE, 1n), { state: 'pending' })
  }
})

test('transfer classification checks every address, topic, amount, and block-time boundary', async () => {
  const ignoredLogs = [
    transferLog({ address: `0x${'99'.repeat(20)}` }),
    transferLog({ topics: [WRONG_TRANSFER_TOPIC, topicAddress(PAYER), topicAddress(PAYEE)] }),
    transferLog({ topics: [REAL_TRANSFER_TOPIC, topicAddress(PAYER), topicAddress('0x3333333333333333333333333333333333333333')] }),
    transferLog({ topics: [REAL_TRANSFER_TOPIC, topicAddress('0x3333333333333333333333333333333333333333'), topicAddress(PAYEE)] }),
    transferLog({ data: '0x0' }),
  ]
  finalizedRpc(validReceipt({ logs: ignoredLogs }))
  assert.deepEqual(await classifyUsdcTransfer(TX, PAYEE, 1_000_000n, {
    expectedFrom: PAYER,
  }), { state: 'invalid_final', reason: 'confirmed_mismatch' })

  finalizedRpc(validReceipt({ logs: [transferLog({ data: '0xf4241' })] }))
  assert.equal((await classifyUsdcTransfer(TX, PAYEE, 1_000_000n)).state, 'matched')
  assert.deepEqual(await classifyUsdcTransfer(TX, PAYEE, 1_000_000n, {
    exactAmount: true,
  }), { state: 'invalid_final', reason: 'confirmed_mismatch' })

  finalizedRpc(validReceipt({ logs: [transferLog({ topics: [REAL_TRANSFER_TOPIC, '', topicAddress(PAYEE)] })] }))
  assert.deepEqual(await classifyUsdcTransfer(TX, PAYEE, 1n), { state: 'pending' })

  for (const timestamp of [null, {}, { timestamp: 100 }, { timestamp: 'bad' }, { timestamp: `0x1${'0'.repeat(400)}` }]) {
    finalizedRpc(validReceipt({ logs: [transferLog()] }), {
      [`eth_getBlockByHash:${BLOCK_HASH}`]: timestamp,
    })
    assert.deepEqual(await classifyUsdcTransfer(TX, PAYEE, 1n), { state: 'pending' })
  }
})

test('legacy verification and balance reads return only complete chain facts', async () => {
  finalizedRpc(validReceipt({ logs: [transferLog()] }))
  const verified = await verifyUsdcTransfer(TX, PAYEE, 1_000_000n)
  assert.equal(verified?.amount, 1_000_000n)

  answer = () => ({ result: null })
  assert.equal(await verifyUsdcTransfer(TX, PAYEE, 1n), null)
  assert.equal(await usdcBalance(PAYER), null)

  answer = () => ({ result: '0x16e360' })
  assert.equal(await usdcBalance(PAYER), '1.500000')
})

test('authorization lookup rejects malformed bounds and every untrusted log field', async () => {
  const validLog = {
    address: USDC,
    topics: [AUTHORIZATION_USED_TOPIC, topicAddress(PAYER), NONCE],
    data: '0x',
    transactionHash: TX,
    blockNumber: '0x100',
    blockHash: BLOCK_HASH,
  }
  const run = async (logs: unknown, finalized: unknown = { number: '0x100' }) => {
    answer = (method) => method === 'eth_getBlockByNumber'
      ? { result: finalized }
      : { result: logs }
    return await findFinalizedAuthorizationTransaction(PAYER, NONCE, 1n)
  }

  assert.equal(await findFinalizedAuthorizationTransaction('bad', NONCE, 1n), null)
  assert.equal(await findFinalizedAuthorizationTransaction(PAYER, 'bad', 1n), null)
  assert.equal(await run([], null), null)
  assert.equal(await run([], {}), null)
  assert.equal(await run([], { number: 1 }), null)
  assert.equal(await run([], { number: 'bad' }), null)
  assert.equal(await run([], { number: '0x0' }), null)
  assert.equal(await run({}), null)

  const invalidLogs = [
    null,
    [],
    { ...validLog, address: `0x${'99'.repeat(20)}` },
    { ...validLog, topics: [WRONG_TRANSFER_TOPIC, topicAddress(PAYER), NONCE] },
    { ...validLog, topics: [AUTHORIZATION_USED_TOPIC, topicAddress(PAYEE), NONCE] },
    { ...validLog, topics: [AUTHORIZATION_USED_TOPIC, topicAddress(PAYER), `0x${'01'.repeat(32)}`] },
    { ...validLog, transactionHash: 1 },
    { ...validLog, transactionHash: '0x12' },
    { ...validLog, blockNumber: 256 },
    { ...validLog, blockNumber: 'bad' },
    { ...validLog, blockNumber: '0x101' },
  ]
  for (const log of invalidLogs) assert.equal(await run([log]), null)
  assert.equal(await run([validLog]), TX)
  assert.equal(await run([]), null)
})
