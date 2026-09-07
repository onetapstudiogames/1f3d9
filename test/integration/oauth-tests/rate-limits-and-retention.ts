import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import {
  database,
  exchangeExistingResidentCode,
  resetDatabase,
  sha256,
  type OAuthStore,
} from '../../helpers/oauth-postgres-fixtures/postgres.ts'

export async function registerRateLimitsAndRetentionTests(
  t: TestContext,
  store: OAuthStore,
): Promise<void> {
  async function ageSignInFlowPastExpiry(
    sessionHash: string,
    anchorTokenHash: string,
    agedInterval: string,
  ): Promise<void> {
    assert.ok(database)
    await database.query(
      `UPDATE oauth_authorization_requests
     SET created_at = now() - $1::interval - interval '15 minutes',
         expires_at = now() - $1::interval
     WHERE session_hash = $2`,
      [agedInterval, sessionHash],
    )
    await database.query(
      `UPDATE oauth_authorization_codes code
     SET created_at = now() - $1::interval - interval '5 minutes',
         expires_at = now() - $1::interval
     FROM oauth_authorization_requests request
     WHERE request.id = code.request_id AND request.session_hash = $2`,
      [agedInterval, sessionHash],
    )
    await database.query(
      `UPDATE oauth_token_families family
     SET created_at = now() - $1::interval - interval '30 days',
         expires_at = now() - $1::interval
     FROM oauth_tokens token
     WHERE token.family_id = family.id AND token.token_hash = $2`,
      [agedInterval, anchorTokenHash],
    )
    await database.query(
      `UPDATE oauth_tokens token
     SET created_at = now() - $1::interval - interval '10 minutes',
         expires_at = now() - $1::interval
     FROM oauth_tokens anchor
     WHERE anchor.token_hash = $2 AND token.family_id = anchor.family_id`,
      [agedInterval, anchorTokenHash],
    )
  }

  async function signInRowCounts(): Promise<Record<string, string>> {
    assert.ok(database)
    const state = await database.query<Record<string, string>>(
      `SELECT
       (SELECT count(*) FROM oauth_authorization_requests)::text AS requests,
       (SELECT count(*) FROM oauth_authorization_codes)::text AS codes,
       (SELECT count(*) FROM oauth_token_families)::text AS families,
       (SELECT count(*) FROM oauth_tokens)::text AS tokens`,
    )
    return state.rows[0]!
  }

  await t.test('rate limiting admits exactly the configured boundary and clears stale buckets', async () => {
    await resetDatabase()
    const bucketHash = sha256('rate-limit-bucket')
    await database!.query(
      `INSERT INTO oauth_rate_limits (bucket_hash, attempt_kind, window_start, used)
         VALUES ($1, 'token', date_trunc('hour', now(), 'UTC') - interval '25 hours', 2)`,
      [sha256('stale-rate-limit-bucket')],
    )

    const attempts = []
    for (let index = 0; index < 5; index += 1) {
      attempts.push(await store.consumeOAuthRateLimit({
        bucketHash,
        attemptKind: 'authorize',
        maximum: 3,
      }))
    }
    assert.deepEqual(attempts.map(result => result.admitted), [true, true, true, false, false])
    for (const result of attempts) {
      assert.ok(Number.isInteger(result.retryAfterSeconds))
      assert.ok(result.retryAfterSeconds >= 1 && result.retryAfterSeconds <= 3_600)
    }
    assert.equal(
      (await store.consumeOAuthRateLimit({
        bucketHash,
        attemptKind: 'refresh',
        maximum: 1,
      })).admitted,
      true,
    )

    const rows = await database!.query<{
      authorize_used: number
      stale_rows: string
    }>(
      `SELECT
           coalesce(max(used) FILTER (WHERE bucket_hash = $1 AND attempt_kind = 'authorize'), 0)
             AS authorize_used,
           count(*) FILTER (WHERE window_start < date_trunc('hour', now(), 'UTC') - interval '24 hours')::text
             AS stale_rows
         FROM oauth_rate_limits`,
      [bucketHash],
    )
    assert.deepEqual(rows.rows[0], { authorize_used: 3, stale_rows: '0' })
  })

  await t.test('sign-in records survive the forensic window and are pruned only after it', async () => {
    await resetDatabase()
    const inside = await exchangeExistingResidentCode(store, 'retention-inside-window')
    const past = await exchangeExistingResidentCode(store, 'retention-past-window')
    for (const [flow, label] of [[inside, 'retention-inside-window'], [past, 'retention-past-window']] as const) {
      assert.equal(await store.rotateRefreshToken({
        presentedRefreshTokenHash: flow.refreshTokenHash,
        clientId: flow.request.clientId,
        resource: flow.request.resource,
        accessTokenHash: sha256(`${label}:rotated-access`),
        newRefreshTokenHash: sha256(`${label}:rotated-refresh`),
      }), 'rotated')
    }
    assert.deepEqual(await signInRowCounts(), {
      requests: '2', codes: '2', families: '2', tokens: '8',
    })

    await ageSignInFlowPastExpiry(past.request.sessionHash, past.accessTokenHash, '31 days')
    await ageSignInFlowPastExpiry(inside.request.sessionHash, inside.accessTokenHash, '29 days')

    assert.equal((await store.consumeOAuthRateLimit({
      bucketHash: sha256('retention-prune-bucket'),
      attemptKind: 'token',
      maximum: 10,
    })).admitted, true)

    assert.deepEqual(await signInRowCounts(), {
      requests: '1', codes: '1', families: '1', tokens: '4',
    })
    const survivors = await database!.query<{ sessions: string[]; anchor_tokens: string }>(
      `SELECT
           (SELECT array_agg(session_hash) FROM oauth_authorization_requests) AS sessions,
           (SELECT count(*) FROM oauth_tokens WHERE token_hash = $1)::text AS anchor_tokens`,
      [inside.refreshTokenHash],
    )
    assert.deepEqual(survivors.rows[0], {
      sessions: [inside.request.sessionHash],
      anchor_tokens: '1',
    })

    const replay = {
      clientId: inside.request.clientId,
      resource: inside.request.resource,
      accessTokenHash: sha256('retention-replay-access'),
      newRefreshTokenHash: sha256('retention-replay-refresh'),
    }
    assert.equal(await store.rotateRefreshToken({
      ...replay,
      presentedRefreshTokenHash: past.refreshTokenHash,
    }), 'invalid', 'a fully retired family leaves nothing for reuse detection to revoke')
    assert.equal(await store.rotateRefreshToken({
      ...replay,
      presentedRefreshTokenHash: inside.refreshTokenHash,
    }), 'reused', 'reuse detection still works on retained rows inside the window')

    assert.equal((await store.consumeOAuthRateLimit({
      bucketHash: sha256('retention-prune-bucket-second-pass'),
      attemptKind: 'refresh',
      maximum: 10,
    })).admitted, true)
    assert.deepEqual(await signInRowCounts(), {
      requests: '1', codes: '1', families: '1', tokens: '4',
    }, 'a revoked family keeps its full window measured from expiry')
  })

  await t.test('an expired access token in a live family is never deleted before the family', async () => {
    await resetDatabase()
    const live = await exchangeExistingResidentCode(store, 'retention-live-family')
    await database!.query(
      `UPDATE oauth_tokens
         SET created_at = now() - interval '31 days' - interval '10 minutes',
             expires_at = now() - interval '31 days'
         WHERE token_hash = $1`,
      [live.accessTokenHash],
    )

    assert.equal((await store.consumeOAuthRateLimit({
      bucketHash: sha256('retention-live-family-bucket'),
      attemptKind: 'refresh',
      maximum: 10,
    })).admitted, true)

    assert.deepEqual(await signInRowCounts(), {
      requests: '1', codes: '1', families: '1', tokens: '2',
    })
    assert.equal(await store.rotateRefreshToken({
      presentedRefreshTokenHash: live.refreshTokenHash,
      clientId: live.request.clientId,
      resource: live.request.resource,
      accessTokenHash: sha256('retention-live-family:rotated-access'),
      newRefreshTokenHash: sha256('retention-live-family:rotated-refresh'),
    }), 'rotated', 'the live grant must keep working after a retention pass')
  })
}
