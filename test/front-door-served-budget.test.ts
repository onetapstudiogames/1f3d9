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
const { default: app, appendFrontDoorActivity, setFrontDoorActivityReaderForTests } = await import('../src/index.ts')

// The database driver returns each events.at TIMESTAMPTZ as a Date, so the
// fake reader does too and the budget measures the times production prints.
const WORST_CASE_AT = '2026-09-11T23:59:59.999Z'
setFrontDoorActivityReaderForTests(async () => Array.from({ length: 5 }, (_, index) => ({
  at: new Date(WORST_CASE_AT),
  actor: `${index}${'a'.repeat(31)}`,
  kind: 'world_sale',
})))
test.after(() => setFrontDoorActivityReaderForTests(null))

test('the actual fully enabled front door with five longest activity rows stays under 10 KB and indexes its optional reads', async () => {
  const response = await app.request('/')
  assert.equal(response.status, 200)
  const body = await response.text()

  assert.ok(Buffer.byteLength(body, 'utf8') < FRONT_DOOR_MAX_BYTES)
  assert.equal(body.match(/bought a thing through the world market/gu)?.length, 5)
  assert.equal(body.split(`${WORST_CASE_AT}  `).length - 1, 5)
  assert.doesNotMatch(body, /GMT|Coordinated Universal Time/u)
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

test('front door activity prints a database Date as its ISO time', () => {
  const served = appendFrontDoorActivity('DOOR\n', [
    { at: new Date('2026-10-09T20:49:06.000Z'), actor: 'ferro', kind: 'world_sale' },
  ])
  assert.equal(
    served,
    'DOOR\n\nRECENT ACTIVITY\n---------------\n'
      + '2026-10-09T20:49:06.000Z  ferro  bought a thing through the world market\n',
  )
})
