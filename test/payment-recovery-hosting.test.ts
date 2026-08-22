import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('Vercel invokes the bounded payment recovery endpoint every five minutes', () => {
  const configuration = JSON.parse(read('../vercel.json')) as {
    crons?: Array<{ path: string; schedule: string }>
    functions?: Record<string, { maxDuration?: number; includeFiles?: string }>
  }
  assert.deepEqual(configuration.crons, [{
    path: '/api/internal/payment-recovery',
    schedule: '*/5 * * * *',
  }])
  assert.equal(configuration.functions?.['api/index.ts']?.includeFiles, 'src/**')
  assert.equal(configuration.functions?.['api/index.ts']?.maxDuration, 300)
})

test('the recovery job is bearer-protected, bounded, overlap-safe, and identifier-free', () => {
  const routes = read('../src/payment-recovery-routes.ts')
  const state = read('../src/payment-attempts.ts')
  assert.match(routes, /CRON_SECRET/u)
  assert.match(routes, /Authorization|authorization/u)
  assert.match(routes, /timingSafeEqual/u)
  assert.match(routes, /RECOVERY_BATCH_LIMIT\s*=\s*10/u)
  assert.match(routes, /Cache-Control[^\n]*no-store|no-store/iu)
  assert.match(state, /lease_expires_at/iu)
  assert.match(state, /listRecoverablePaymentAttempts/iu)
  assert.doesNotMatch(
    routes.slice(routes.indexOf("app.get('/api/internal/payment-recovery'")),
    /attemptId|publicId|txHash|transaction/iu,
  )
})
