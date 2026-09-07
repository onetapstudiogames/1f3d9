import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import {
  database,
  exchangeExistingResidentCode,
  resetDatabase,
  sha256,
  type OAuthStore,
} from '../../helpers/oauth-postgres-fixtures/postgres.ts'

export async function registerRefreshAndRevocationTests(
  t: TestContext,
  store: OAuthStore,
): Promise<void> {
  await t.test('refresh rate-limit routing keeps one stable private connection key', async () => {
    await resetDatabase()
    const initial = await exchangeExistingResidentCode(store, 'refresh-connection-key')
    const input = {
      presentedRefreshTokenHash: initial.refreshTokenHash,
      clientId: initial.request.clientId,
      resource: initial.request.resource,
    }
    const subject = await store.resolveRefreshRateLimitSubject(input)
    assert.equal(subject.status, 'active')
    assert.match(subject.status === 'active' ? subject.connectionKey : '', /^\d+$/u)
    const connectionKey = subject.status === 'active' ? subject.connectionKey : ''
    assert.deepEqual(await store.resolveRefreshRateLimitSubject({
      ...input,
      clientId: 'wrong-client',
    }), { status: 'junk' })
    assert.deepEqual(await store.resolveRefreshRateLimitSubject({
      ...input,
      resource: 'https://wrong-resource.example.test/mcp/connect',
    }), { status: 'junk' })
    assert.deepEqual(await store.resolveRefreshRateLimitSubject({
      ...input,
      presentedRefreshTokenHash: sha256('unknown-refresh-token'),
    }), { status: 'junk' })

    const nextRefreshTokenHash = sha256('refresh-connection-key:next-refresh')
    assert.equal(await store.rotateRefreshToken({
      ...input,
      accessTokenHash: sha256('refresh-connection-key:next-access'),
      newRefreshTokenHash: nextRefreshTokenHash,
    }), 'rotated')
    assert.deepEqual(await store.resolveRefreshRateLimitSubject(input), { status: 'reused' })
    assert.deepEqual(await store.resolveRefreshRateLimitSubject({
      ...input,
      presentedRefreshTokenHash: nextRefreshTokenHash,
    }), { status: 'active', connectionKey })

    assert.equal(await store.rotateRefreshToken({
      ...input,
      accessTokenHash: sha256('refresh-connection-key:replay-access'),
      newRefreshTokenHash: sha256('refresh-connection-key:replay-refresh'),
    }), 'reused')
    assert.deepEqual(await store.resolveRefreshRateLimitSubject(input), { status: 'junk' })
    assert.deepEqual(await store.resolveRefreshRateLimitSubject({
      ...input,
      presentedRefreshTokenHash: nextRefreshTokenHash,
    }), { status: 'junk' })
  })

  await t.test('overlapping refresh rotations leave one usable winner', async () => {
    await resetDatabase()
    const initial = await exchangeExistingResidentCode(store, 'overlapping-refresh-rotation')
    await database!.query(`
        CREATE FUNCTION test_hold_refresh_rotation() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_sleep(0.25);
          RETURN NEW;
        END
        $$;
        CREATE TRIGGER test_hold_refresh_rotation
        BEFORE UPDATE OF used_at ON oauth_tokens
        FOR EACH ROW
        WHEN (
          OLD.used_at IS NULL
          AND NEW.used_at IS NOT NULL
          AND NEW.token_type = 'refresh'
        )
        EXECUTE FUNCTION test_hold_refresh_rotation()
      `)
    const rotations = ['first', 'second'].map(label => store.rotateRefreshToken({
      presentedRefreshTokenHash: initial.refreshTokenHash,
      clientId: initial.request.clientId,
      resource: initial.request.resource,
      accessTokenHash: sha256(`overlapping-refresh-rotation:${label}:access`),
      newRefreshTokenHash: sha256(`overlapping-refresh-rotation:${label}:refresh`),
    }))
    let results: Awaited<(typeof rotations)[number]>[]
    try {
      results = await Promise.all(rotations)
    } finally {
      await database!.query(`
          DROP TRIGGER test_hold_refresh_rotation ON oauth_tokens;
          DROP FUNCTION test_hold_refresh_rotation()
        `)
    }
    assert.deepEqual([...results].sort(), ['overlapping', 'rotated'])

    const state = await database!.query<{
      revoke_reason: string | null
      total_tokens: string
      active_access_tokens: string
      active_refresh_tokens: string
    }>(
      `SELECT family.revoke_reason,
           count(*)::text AS total_tokens,
           count(*) FILTER (
             WHERE token.token_type = 'access' AND token.revoked_at IS NULL
           )::text AS active_access_tokens,
           count(*) FILTER (
             WHERE token.token_type = 'refresh'
               AND token.used_at IS NULL AND token.revoked_at IS NULL
           )::text AS active_refresh_tokens
         FROM oauth_token_families family
         JOIN oauth_tokens token ON token.family_id = family.id
         GROUP BY family.id, family.revoke_reason`,
    )
    assert.deepEqual(state.rows[0], {
      revoke_reason: null,
      total_tokens: '4',
      active_access_tokens: '2',
      active_refresh_tokens: '1',
    })
    const labels = ['first', 'second'] as const
    const winnerIndex = results.indexOf('rotated')
    assert.notEqual(winnerIndex, -1)
    const winnerAccess = sha256(
      `overlapping-refresh-rotation:${labels[winnerIndex]!}:access`,
    )
    assert.equal(
      (await store.resolveOAuthAccessToken({
        accessTokenHash: winnerAccess,
        resource: initial.request.resource,
        scope: initial.request.scope,
      }))?.id,
      1,
    )

    assert.equal(await store.rotateRefreshToken({
      presentedRefreshTokenHash: initial.refreshTokenHash,
      clientId: initial.request.clientId,
      resource: initial.request.resource,
      accessTokenHash: sha256('overlapping-refresh-rotation:late-replay:access'),
      newRefreshTokenHash: sha256('overlapping-refresh-rotation:late-replay:refresh'),
    }), 'reused')
    assert.equal(await store.resolveOAuthAccessToken({
      accessTokenHash: winnerAccess,
      resource: initial.request.resource,
      scope: initial.request.scope,
    }), null)
    const revoked = await database!.query<{ revoke_reason: string }>(
      'SELECT revoke_reason FROM oauth_token_families',
    )
    assert.deepEqual(revoked.rows, [{ revoke_reason: 'refresh token reuse' }])
  })

  await t.test('refresh tokens rotate once and reuse revokes the whole family', async () => {
    await resetDatabase()
    const initial = await exchangeExistingResidentCode(store, 'refresh-rotation')
    const rotatedAccessHash = sha256('refresh-rotation:new-access')
    const rotatedRefreshHash = sha256('refresh-rotation:new-refresh')
    const rotation = {
      presentedRefreshTokenHash: initial.refreshTokenHash,
      clientId: initial.request.clientId,
      resource: initial.request.resource,
      accessTokenHash: rotatedAccessHash,
      newRefreshTokenHash: rotatedRefreshHash,
    }

    await assert.rejects(
      store.rotateRefreshToken({
        ...rotation,
        accessTokenHash: initial.accessTokenHash,
      }),
      (error: unknown) => (error as { code?: string }).code === '23505',
    )
    const afterFailedRotation = await database!.query<{
      tokens: string
      original_still_unused: boolean
    }>(
      `SELECT count(*)::text AS tokens,
           bool_or(token_hash = $1 AND used_at IS NULL) AS original_still_unused
         FROM oauth_tokens`,
      [initial.refreshTokenHash],
    )
    assert.deepEqual(afterFailedRotation.rows[0], {
      tokens: '2',
      original_still_unused: true,
    })

    assert.equal(await store.rotateRefreshToken(rotation), 'rotated')
    const afterRotation = await database!.query<{
      tokens: string
      used_original: boolean
      rotated_from_original: boolean
    }>(
      `SELECT
           count(*)::text AS tokens,
           bool_or(token_hash = $1 AND used_at IS NOT NULL) AS used_original,
           bool_or(token_hash = $2 AND rotated_from_token_id IS NOT NULL) AS rotated_from_original
         FROM oauth_tokens`,
      [initial.refreshTokenHash, rotatedRefreshHash],
    )
    assert.deepEqual(afterRotation.rows[0], {
      tokens: '4',
      used_original: true,
      rotated_from_original: true,
    })
    assert.equal(
      (await store.resolveOAuthAccessToken({
        accessTokenHash: rotatedAccessHash,
        resource: initial.request.resource,
        scope: initial.request.scope,
      }))?.id,
      1,
    )

    assert.equal(await store.rotateRefreshToken(rotation), 'reused')
    const revoked = await database!.query<{
      revoke_reason: string
      active_tokens: string
    }>(
      `SELECT family.revoke_reason,
           count(*) FILTER (WHERE token.revoked_at IS NULL)::text AS active_tokens
         FROM oauth_token_families family
         JOIN oauth_tokens token ON token.family_id = family.id
         GROUP BY family.id, family.revoke_reason`,
    )
    assert.deepEqual(revoked.rows[0], {
      revoke_reason: 'refresh token reuse',
      active_tokens: '0',
    })
    assert.equal(
      await store.resolveOAuthAccessToken({
        accessTokenHash: rotatedAccessHash,
        resource: initial.request.resource,
        scope: initial.request.scope,
      }),
      null,
    )
    assert.equal(
      await store.rotateRefreshToken({ ...rotation, presentedRefreshTokenHash: rotatedRefreshHash }),
      'invalid',
    )
    assert.equal(
      await store.rotateRefreshToken({
        ...rotation,
        presentedRefreshTokenHash: sha256('unknown-refresh'),
      }),
      'invalid',
    )
  })

  await t.test('explicit revocation is client-bound, complete, and idempotent', async () => {
    await resetDatabase()
    const issued = await exchangeExistingResidentCode(store, 'explicit-revocation')

    await store.revokeTokenFamilyByToken({
      tokenHash: issued.accessTokenHash,
      clientId: 'wrong-client',
    })
    assert.equal(
      (await store.resolveOAuthAccessToken({
        accessTokenHash: issued.accessTokenHash,
        resource: issued.request.resource,
        scope: issued.request.scope,
      }))?.id,
      1,
    )

    await store.revokeTokenFamilyByToken({
      tokenHash: issued.accessTokenHash,
      clientId: issued.request.clientId,
    })
    await store.revokeTokenFamilyByToken({
      tokenHash: issued.refreshTokenHash,
      clientId: issued.request.clientId,
    })
    assert.equal(
      await store.resolveOAuthAccessToken({
        accessTokenHash: issued.accessTokenHash,
        resource: issued.request.resource,
        scope: issued.request.scope,
      }),
      null,
    )
    const state = await database!.query<{
      revoke_reason: string
      revoked_tokens: string
    }>(
      `SELECT family.revoke_reason,
           count(*) FILTER (WHERE token.revoked_at IS NOT NULL)::text AS revoked_tokens
         FROM oauth_token_families family
         JOIN oauth_tokens token ON token.family_id = family.id
         GROUP BY family.id, family.revoke_reason`,
    )
    assert.deepEqual(state.rows[0], {
      revoke_reason: 'client revocation',
      revoked_tokens: '2',
    })
  })

}
