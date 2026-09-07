import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  close,
  listen,
  sendJson,
  runClient,
} from '../helpers/world-buy-client-fixtures/purchase-client.ts'

export function registerServerProseTests(): void {
  async function refusalOutput(body: Record<string, unknown>, status = 400): Promise<string> {
    const stateDirectory = await mkdtemp(join(tmpdir(), '1f3d9-world-buy-refusal-prose-'))
    const city = await listen((_request, response) => {
      sendJson(response, status, body)
    })
    const market = await listen((_request, response) => {
      sendJson(response, 404, { error: 'unused market stub' })
    })

    try {
      const result = await runClient({ city: city.origin, market: market.origin }, stateDirectory)
      assert.equal(result.status, 1)
      return result.stderr
    } finally {
      await Promise.all([close(city.server), close(market.server)])
      await rm(stateDirectory, { recursive: true, force: true })
    }
  }

  for (const { label, message } of [
    { label: 'a control character', message: 'unsafe\u001b[31mmessage' },
    { label: 'an over-length value', message: 'x'.repeat(301) },
  ]) {
    test(`world-buy replaces ${label} at the refusal print site`, async () => {
      const stderr = await refusalOutput({ error: message })
      assert.match(stderr, /Step 1: HTTP 400 with no usable message/u)
      assert.equal(stderr.includes(message), false)
    })

    test(`world-buy replaces ${label} at the payment-pending print site`, async () => {
      const stateDirectory = await mkdtemp(join(tmpdir(), '1f3d9-world-buy-pending-prose-'))
      const city = await listen((request, response) => {
        if (request.method === 'GET' && request.url === '/api/me') {
          sendJson(response, 200, { handle: 'test-buyer' })
          return
        }
        if (request.method === 'POST' && request.url === '/api/world/offer/31/claim') {
          sendJson(response, 202, {
            error: message,
            offer: { phase: 'payment_pending', asset_id: 2723 },
          })
          return
        }
        sendJson(response, 404, { error: 'unexpected city stub route' })
      })
      const market = await listen((request, response) => {
        if (request.method === 'POST' && request.url === '/api/world/checkout/23') {
          sendJson(response, 201, { checkout: { id: 77 } })
          return
        }
        sendJson(response, 404, { error: 'unexpected market stub route' })
      })

      try {
        const result = await runClient({ city: city.origin, market: market.origin }, stateDirectory)
        assert.equal(result.status, 2)
        assert.match(result.stderr, /Step 4: HTTP 202 with no usable message/u)
        assert.equal(result.stderr.includes(message), false)
      } finally {
        await Promise.all([close(city.server), close(market.server)])
        await rm(stateDirectory, { recursive: true, force: true })
      }
    })
  }

  for (const { label, requestId } of [
    { label: 'a control character', requestId: 'req\u001b[31munsafe' },
    { label: 'an over-length value', requestId: 'r'.repeat(301) },
  ]) {
    test(`world-buy omits a request id containing ${label}`, async () => {
      const stderr = await refusalOutput({ error: 'safe server message', request_id: requestId }, 500)
      assert.equal(stderr, 'Step 1: safe server message\n')
      assert.equal(stderr.includes(requestId), false)
    })
  }

  test('world-buy preserves a safe request id when the server message is unusable', async () => {
    const stderr = await refusalOutput({ error: 'unsafe\u001bmessage', request_id: 'req-safe-1' }, 500)
    assert.equal(stderr, 'Step 1: HTTP 500 with no usable message Request ID: req-safe-1.\n')
  })

  for (const { label, message } of [
    { label: 'DEL', message: 'unsafe\u007fmessage' },
    { label: 'U+2028', message: 'unsafe\u2028message' },
    { label: 'U+2029', message: 'unsafe\u2029message' },
  ]) {
    test(`world-buy replaces ${label} in server prose`, async () => {
      const stderr = await refusalOutput({ error: message })
      assert.match(stderr, /Step 1: HTTP 400 with no usable message/u)
      assert.equal(stderr.includes(message), false)
    })
  }

  test('world-buy accepts exactly 300 characters of server prose', async () => {
    const message = 'x'.repeat(300)
    const stderr = await refusalOutput({ error: message })
    assert.equal(stderr, `Step 1: ${message}\n`)
  })

  test('world-buy trims safe server prose', async () => {
    const stderr = await refusalOutput({ error: '  safe server message  ' })
    assert.equal(stderr, 'Step 1: safe server message\n')
  })

  test('world-buy replaces empty and non-string server prose', async () => {
    for (const error of ['', 42]) {
      const stderr = await refusalOutput({ error })
      assert.equal(stderr, 'Step 1: HTTP 400 with no usable message\n')
    }
  })

  test('world-buy selects the first usable server prose field', async () => {
    const firstUsable = await refusalOutput({ error: 'unsafe\u001bvalue', message: 'safe message', retry: 'safe retry' })
    assert.equal(firstUsable, 'Step 1: safe message\n')
    const firstField = await refusalOutput({ error: 'safe error', message: 'safe message', retry: 'safe retry' })
    assert.equal(firstField, 'Step 1: safe error\n')
  })
}
