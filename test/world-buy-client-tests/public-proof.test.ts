import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TEST_NONCE,
  close,
  listen,
  sendJson,
  runClient,
  savePurchaseState,
} from '../helpers/world-buy-client-fixtures/purchase-client.ts'

export function registerPublicProofTests(): void {
  async function publicProofOutput(currentOwner: unknown, worldState: unknown) {
    const stateDirectory = await mkdtemp(join(tmpdir(), '1f3d9-world-buy-public-proof-'))
    await savePurchaseState(stateDirectory, { nonce: TEST_NONCE })
    const city = await listen((request, response) => {
      if (request.method === 'GET' && request.url === '/api/world/offer/31') {
        sendJson(response, 200, { offer: { phase: 'reserved', asset_id: 2723 } })
        return
      }
      if (request.method === 'POST' && request.url === '/api/world/offer/31/claim') {
        sendJson(response, 200, { offer: { phase: 'claimed', asset_id: 2723 } })
        return
      }
      if (request.method === 'GET' && request.url === '/api/thing/2723') {
        sendJson(response, 200, { thing: { id: 2723, current_owner: currentOwner } })
        return
      }
      sendJson(response, 404, { error: 'unexpected city stub route' })
    })
    const market = await listen((request, response) => {
      if (request.method === 'POST' && request.url === '/api/world/sync/23') {
        sendJson(response, 200, { listing: { id: 23, world_state: 'sold' } })
        return
      }
      if (request.method === 'GET' && request.url === '/api/listing/23') {
        sendJson(response, 200, { listing: { id: 23, world_state: worldState } })
        return
      }
      sendJson(response, 404, { error: 'unexpected market stub route' })
    })

    try {
      return await runClient({ city: city.origin, market: market.origin }, stateDirectory)
    } finally {
      await Promise.all([close(city.server), close(market.server)])
      await rm(stateDirectory, { recursive: true, force: true })
    }
  }

  test('world-buy refuses an invalid current_owner before printing either public proof', async () => {
    const currentOwner = 'bad\u001bowner'
    const result = await publicProofOutput(currentOwner, 'sold')
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, 'Step 6: The city public proof current_owner was not a valid city handle. Re-read the thing.\n')
    assert.equal(result.stderr.includes(currentOwner), false)
  })

  test('world-buy refuses an invalid world_state before printing either public proof', async () => {
    const worldState = 'sold\u001bunsafe'
    const result = await publicProofOutput('test-buyer', worldState)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, 'Step 6: The market public proof world_state was not a recognized terminal state. Re-read the listing.\n')
    assert.equal(result.stderr.includes(worldState), false)
  })

  test('world-buy accepts the minimum and maximum city handles in public proof', async () => {
    for (const currentOwner of ['a12', `a${'b'.repeat(31)}`]) {
      const result = await publicProofOutput(currentOwner, 'sold')
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, new RegExp(`currently owned by ${currentOwner}\\.`))
    }
  })
}
