import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'

Object.assign(process.env, {
  DATABASE_URL: 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb',
  TREASURY_ADDRESS: '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd',
  PUBLIC_ORIGIN: 'https://1f3d9.com',
  BASE_RPC_URL: 'https://base-rpc.test',
  FACILITATOR_URL: 'https://facilitator.test',
  HOSTED_CHAT_SIGNIN_ENABLED: 'true',
  HOSTED_CHAT_CIMD_ORIGINS: '["https://chat.example.test"]',
  IDENTITY_RECOVERY_ENABLED: 'true',
  IDENTITY_ROTATION_ENABLED: 'true',
  CODING_IDENTITY_DOORS_ENABLED: 'true',
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: 'test-client-secret',
  PAYPAL_ENV: 'sandbox',
  PAYPAL_WEBHOOK_ID: 'test-webhook-id',
})

const { CITY_LIMIT_LINES, FRONT_DOOR_MAX_BYTES } = await import('../src/city-facts.ts')
const { default: app, setFrontDoorActivityReaderForTests } = await import('../src/index.ts')

setFrontDoorActivityReaderForTests(async () => Array.from({ length: 5 }, (_, index) => ({
  at: '2026-09-11T23:59:59.999Z',
  actor: `${index}${'a'.repeat(31)}`,
  kind: 'world_sale',
})))
test.after(() => setFrontDoorActivityReaderForTests(null))

test('the actual fully enabled front door with five longest activity rows stays within 8 KiB and indexes its optional reads', async () => {
  const response = await app.request('/')
  assert.equal(response.status, 200)
  const body = await response.text()

  assert.ok(Buffer.byteLength(body, 'utf8') <= FRONT_DOOR_MAX_BYTES)
  assert.equal(body.match(/bought a thing through the world market/gu)?.length, 5)
  assert.match(body, /https:\/\/1f3d9\.com\/mcp\/connect/u)
  assert.match(body, /fund a resident's fee credit at \/buy/u)
  for (const path of ['/api/register', '/api/rotate', '/api/recovery', '/api/pair']) {
    assert.ok(body.includes(path), path)
  }
  for (const line of CITY_LIMIT_LINES) assert.ok(body.includes(`- ${line}`), line)
  assert.match(body, /before your first[\s\S]{0,30}write, read [\s\S]{0,120}action-requests\.txt/iu)
  assert.match(body, /https:\/\/1f3d9\.com\/reference\/gazette\.txt/iu)
  assert.doesNotMatch(body, /read the complete resident contract.*before your first write/iu)
})
