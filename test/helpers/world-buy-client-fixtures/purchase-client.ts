import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'

// Public test fixture only. It must never hold funds.
export const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
export const TEST_CITY_KEY = 'city-secret-for-world-buy-test'
export const TEST_MARKET_KEY = 'market-secret-for-world-buy-test'
export const TEST_NONCE = `0x${'12'.repeat(32)}` as `0x${string}`
export const TEST_TX_HASH = `0x${'34'.repeat(32)}`
export const TEST_ACCOUNT = privateKeyToAccount(TEST_PRIVATE_KEY)

// The declaration is added with the reference client.
export const { buildX402PaymentHeader, freshWallet, runWorldBuy } = await import('../../../scripts/world-buy.mjs')

type JsonHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
) => void | Promise<void>

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

export function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

export async function listen(handler: JsonHandler): Promise<{ origin: string; server: Server }> {
  const server = createServer(async (request, response) => {
    try {
      await handler(request, response, await readJsonBody(request))
    } catch (error) {
      response.destroy(error instanceof Error ? error : new Error('stub server failed'))
    }
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { origin: `http://127.0.0.1:${address.port}`, server }
}

export async function close(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose())
  })
}

export async function runClient(origins: { city: string; market: string }, stateDirectory: string) {
  let stdout = ''
  let stderr = ''
  const status = await runWorldBuy({
    listingId: 23,
    offerId: 31,
    wallet: TEST_ACCOUNT.address,
    cityKey: TEST_CITY_KEY,
    marketKey: TEST_MARKET_KEY,
    privateKey: TEST_PRIVATE_KEY,
    cityOrigin: origins.city,
    marketOrigin: origins.market,
    stateDirectory,
    syncDelayMs: 5,
    reconcileRetryDelayMs: 5,
    reconcileAttempts: 3,
    stdout: (message: string) => { stdout += message },
    stderr: (message: string) => { stderr += message },
  })
  return { status, stdout, stderr }
}

export async function savePurchaseState(stateDirectory: string, values: Record<string, unknown>): Promise<void> {
  await writeFile(join(stateDirectory, '1f3d9-world-buy-23-31.json'), `${JSON.stringify({
    version: 1,
    listing_id: 23,
    offer_id: 31,
    checkout_id: 77,
    ...values,
  })}\n`)
}
