import assert from 'node:assert/strict'
import test from 'node:test'
import { runtimeDatabaseUrl } from '../src/db.ts'

const live = 'postgresql://live.example.test/city'
const preview = 'postgresql://preview.example.test/city'

test('an enabled Vercel preview must use its dedicated isolated database', () => {
  assert.equal(runtimeDatabaseUrl({
    VERCEL_ENV: 'preview',
    HOSTED_CHAT_SIGNIN_ENABLED: 'true',
    HOSTED_CHAT_PREVIEW_DATABASE_URL: preview,
    DATABASE_URL: live,
  }), preview)

  assert.throws(() => runtimeDatabaseUrl({
    VERCEL_ENV: 'preview',
    HOSTED_CHAT_SIGNIN_ENABLED: 'true',
    DATABASE_URL: live,
  }), (error: unknown) => (
    error instanceof Error
    && error.message === 'database is temporarily unavailable'
    && !/HOSTED_CHAT_PREVIEW_DATABASE_URL|DATABASE_URL/u.test(error.message)
  ))
})

test('production and development can never select the preview override', () => {
  for (const vercelEnvironment of ['production', 'development']) {
    assert.equal(runtimeDatabaseUrl({
      VERCEL_ENV: vercelEnvironment,
      HOSTED_CHAT_SIGNIN_ENABLED: 'true',
      HOSTED_CHAT_PREVIEW_DATABASE_URL: preview,
      DATABASE_URL: live,
    }), live)
  }
})

test('an ordinary preview uses the isolated override when present and otherwise keeps legacy behavior', () => {
  assert.equal(runtimeDatabaseUrl({
    VERCEL_ENV: 'preview',
    HOSTED_CHAT_SIGNIN_ENABLED: 'false',
    HOSTED_CHAT_PREVIEW_DATABASE_URL: preview,
    DATABASE_URL: live,
  }), preview)
  assert.equal(runtimeDatabaseUrl({
    VERCEL_ENV: 'preview',
    HOSTED_CHAT_SIGNIN_ENABLED: 'false',
    DATABASE_URL: live,
  }), live)
})

test('missing database configuration still fails closed', () => {
  assert.throws(() => runtimeDatabaseUrl({}), (error: unknown) => (
    error instanceof Error
    && error.message === 'database is temporarily unavailable'
    && !/DATABASE_URL/u.test(error.message)
  ))
})
