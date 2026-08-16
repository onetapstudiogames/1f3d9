import assert from 'node:assert/strict'
import test from 'node:test'
import { runtimeDatabaseUrl } from '../src/db.ts'

const live = 'postgresql://live.example.test/city'
const preview = 'postgresql://preview.example.test/city'
const previewFeatureStates = [undefined, 'false', 'true'] as const

test('every Vercel preview uses its dedicated isolated database', () => {
  for (const hostedChatSigninEnabled of previewFeatureStates) {
    assert.equal(runtimeDatabaseUrl({
      VERCEL_ENV: 'preview',
      HOSTED_CHAT_SIGNIN_ENABLED: hostedChatSigninEnabled,
      HOSTED_CHAT_PREVIEW_DATABASE_URL: preview,
      DATABASE_URL: live,
    }), preview)
  }
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

test('every Vercel preview fails closed without a non-empty dedicated database', () => {
  for (const hostedChatSigninEnabled of previewFeatureStates) {
    for (const previewDatabaseUrl of [undefined, '   ']) {
      assert.throws(() => runtimeDatabaseUrl({
        VERCEL_ENV: 'preview',
        HOSTED_CHAT_SIGNIN_ENABLED: hostedChatSigninEnabled,
        HOSTED_CHAT_PREVIEW_DATABASE_URL: previewDatabaseUrl,
        DATABASE_URL: live,
      }), (error: unknown) => (
        error instanceof Error
        && error.message === 'database is temporarily unavailable'
        && !/HOSTED_CHAT_PREVIEW_DATABASE_URL|DATABASE_URL/u.test(error.message)
      ))
    }
  }
})

test('missing database configuration still fails closed', () => {
  assert.throws(() => runtimeDatabaseUrl({}), (error: unknown) => (
    error instanceof Error
    && error.message === 'database is temporarily unavailable'
    && !/DATABASE_URL/u.test(error.message)
  ))
})
