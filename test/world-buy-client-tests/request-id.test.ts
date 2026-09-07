import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requirements } from '../../src/pay.ts'
import {
  close,
  listen,
  sendJson,
  runClient,
} from '../helpers/world-buy-client-fixtures/purchase-client.ts'

export function registerRequestIdTests(): void {
  test('world-buy prints the request id from a paid claim 500', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), '1f3d9-world-buy-request-id-'))
    let cityOrigin = ''

    const city = await listen((request, response) => {
      if (request.method === 'GET' && request.url === '/api/me') {
        sendJson(response, 200, { handle: 'test-buyer' })
        return
      }
      if (request.method === 'POST' && request.url === '/api/world/offer/31/claim') {
        if (request.headers['x-payment'] == null) {
          sendJson(response, 402, {
            error: 'payment required',
            accepts: [requirements(
              '0x1111111111111111111111111111111111111111',
              1,
              `${cityOrigin}/api/world/offer/31/claim`,
              'test world offer',
            )],
          })
          return
        }
        sendJson(response, 500, { error: 'internal city failure', request_id: 'req-sale-1' })
        return
      }
      sendJson(response, 404, { error: `unexpected city route ${request.method} ${request.url}` })
    })
    cityOrigin = city.origin

    const market = await listen((request, response) => {
      if (request.method === 'POST' && request.url === '/api/world/checkout/23') {
        sendJson(response, 201, { checkout: { id: 77 } })
        return
      }
      sendJson(response, 404, { error: `unexpected market route ${request.method} ${request.url}` })
    })

    try {
      const result = await runClient({ city: city.origin, market: market.origin }, stateDirectory)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /internal city failure.*req-sale-1/isu)
    } finally {
      await Promise.all([close(city.server), close(market.server)])
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })
}
