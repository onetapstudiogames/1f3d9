import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import {
  authorizationRequestInput,
  database,
  exchangeExistingResidentCode,
  resetDatabase,
  seedAuthorizationCode,
  sha256,
  type OAuthStore,
} from '../../helpers/oauth-postgres-fixtures/postgres.ts'

export async function registerAuthorizationCodeAndAccessTests(
  t: TestContext,
  store: OAuthStore,
): Promise<void> {
  await t.test('existing-resident linking leaves recovery generation and codes unchanged', async () => {
    await resetDatabase()
    const recoveryCodeHashes = Array.from(
      { length: 8 },
      (_, index) => sha256(`existing-link:recovery:${index}`),
    )
    await database!.query('UPDATE residents SET recovery_generation = 1 WHERE id = 1')
    await database!.query(
      `INSERT INTO resident_recovery_codes (resident_id, generation, code_hash)
         SELECT 1, 1, code_hash
         FROM unnest($1::text[]) AS code_hash`,
      [recoveryCodeHashes],
    )
    await seedAuthorizationCode(store, 'existing-link', sha256('existing-link:authorization-code'))

    const state = await database!.query(
      `SELECT resident.recovery_generation,
           array_agg(code.code_hash ORDER BY code.code_hash) AS code_hashes,
           count(*) FILTER (WHERE code.used_at IS NOT NULL OR code.invalidated_at IS NOT NULL) AS inactive
         FROM residents resident
         JOIN resident_recovery_codes code ON code.resident_id = resident.id
         WHERE resident.id = 1
         GROUP BY resident.recovery_generation`,
    )
    assert.deepEqual(state.rows, [{
      recovery_generation: '1', code_hashes: [...recoveryCodeHashes].sort(), inactive: '0',
    }])
  })

  await t.test('authorization-code exchange is exact, single-use, and creates one complete token family', async () => {
    await resetDatabase()
    const request = authorizationRequestInput('code-exchange')
    const codeHash = sha256('code-exchange:code')
    const accessTokenHash = sha256('code-exchange:access')
    const refreshTokenHash = sha256('code-exchange:refresh')
    await seedAuthorizationCode(store, 'code-exchange', codeHash)

    assert.deepEqual(await store.getAuthorizationCode(codeHash), {
      residentId: 1,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      resource: request.resource,
      scope: request.scope,
      codeChallenge: request.codeChallenge,
    })
    assert.equal(await store.getAuthorizationCode(sha256('unknown-code')), null)
    for (const mismatch of [
      { clientId: 'wrong-client' },
      { redirectUri: 'https://wrong-client.example.test/oauth/callback' },
      { resource: 'https://wrong-resource.example.test/mcp/connect' },
    ]) {
      assert.equal(
        await store.exchangeAuthorizationCode({
          codeHash,
          clientId: mismatch.clientId ?? request.clientId,
          redirectUri: mismatch.redirectUri ?? request.redirectUri,
          resource: mismatch.resource ?? request.resource,
          accessTokenHash,
          refreshTokenHash,
        }),
        false,
      )
      assert.ok(await store.getAuthorizationCode(codeHash), 'a mismatch must not burn the code')
    }

    assert.equal(
      await store.exchangeAuthorizationCode({
        codeHash,
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        resource: request.resource,
        accessTokenHash,
        refreshTokenHash,
      }),
      true,
    )
    assert.equal(await store.getAuthorizationCode(codeHash), null)
    assert.equal(
      await store.exchangeAuthorizationCode({
        codeHash,
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        resource: request.resource,
        accessTokenHash: sha256('second-access'),
        refreshTokenHash: sha256('second-refresh'),
      }),
      false,
    )

    const issued = await database!.query<{
      families: string
      access_tokens: string
      refresh_tokens: string
    }>(
      `SELECT
           (SELECT count(*) FROM oauth_token_families) AS families,
           (SELECT count(*) FROM oauth_tokens WHERE token_type = 'access') AS access_tokens,
           (SELECT count(*) FROM oauth_tokens WHERE token_type = 'refresh') AS refresh_tokens`,
    )
    assert.deepEqual(issued.rows[0], {
      families: '1',
      access_tokens: '1',
      refresh_tokens: '1',
    })
  })

  await t.test('a token collision rolls the code consumption and partial family creation back', async () => {
    await resetDatabase()
    const first = await exchangeExistingResidentCode(store, 'collision-seed')
    const targetRequest = authorizationRequestInput('collision-target')
    const targetCodeHash = sha256('collision-target:code')
    await seedAuthorizationCode(store, 'collision-target', targetCodeHash)

    const before = await database!.query<{
      families: string
      tokens: string
    }>(
      `SELECT
           (SELECT count(*) FROM oauth_token_families) AS families,
           (SELECT count(*) FROM oauth_tokens) AS tokens`,
    )
    await assert.rejects(
      store.exchangeAuthorizationCode({
        codeHash: targetCodeHash,
        clientId: targetRequest.clientId,
        redirectUri: targetRequest.redirectUri,
        resource: targetRequest.resource,
        accessTokenHash: first.accessTokenHash,
        refreshTokenHash: sha256('collision-target:refresh'),
      }),
      (error: unknown) => (error as { code?: string }).code === '23505',
    )
    assert.deepEqual(
      await database!.query(
        `SELECT
             (SELECT count(*) FROM oauth_token_families) AS families,
             (SELECT count(*) FROM oauth_tokens) AS tokens`,
      ).then(result => result.rows[0]),
      before.rows[0],
    )
    assert.ok(await store.getAuthorizationCode(targetCodeHash), 'failed exchange must leave code usable')

    assert.equal(
      await store.exchangeAuthorizationCode({
        codeHash: targetCodeHash,
        clientId: targetRequest.clientId,
        redirectUri: targetRequest.redirectUri,
        resource: targetRequest.resource,
        accessTokenHash: sha256('collision-target:retry-access'),
        refreshTokenHash: sha256('collision-target:retry-refresh'),
      }),
      true,
    )
  })

  await t.test('access tokens require the exact resource and scope and stop at expiry or revocation', async () => {
    await resetDatabase()
    const active = await exchangeExistingResidentCode(store, 'access-active')
    await database!.query(
      `UPDATE residents
         SET quota_day = DATE '2000-01-01', things_today = 7, notes_today = 8,
           agreement_actions_today = 9
         WHERE id = 1`,
    )

    assert.equal(
      await store.resolveOAuthAccessToken({
        accessTokenHash: active.accessTokenHash,
        resource: 'https://wrong-resource.example.test/mcp/connect',
        scope: active.request.scope,
      }),
      null,
    )
    assert.equal(
      await store.resolveOAuthAccessToken({
        accessTokenHash: active.accessTokenHash,
        resource: active.request.resource,
        scope: 'city:wrong-scope',
      }),
      null,
    )
    const resident = await store.resolveOAuthAccessToken({
      accessTokenHash: active.accessTokenHash,
      resource: active.request.resource,
      scope: active.request.scope,
    })
    assert.equal(resident?.id, 1)
    assert.equal(resident?.handle, 'existing-agent')
    assert.equal(resident?.things_today, 0)
    assert.equal(resident?.notes_today, 0)
    assert.equal(resident?.agreement_actions_today, 0)

    await database!.query(
      `UPDATE oauth_tokens
         SET created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'
         WHERE token_hash = $1`,
      [active.accessTokenHash],
    )
    assert.equal(
      await store.resolveOAuthAccessToken({
        accessTokenHash: active.accessTokenHash,
        resource: active.request.resource,
        scope: active.request.scope,
      }),
      null,
    )

    const expiredFamily = await exchangeExistingResidentCode(store, 'access-expired-family')
    await database!.query(
      `UPDATE oauth_token_families family
         SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
         FROM oauth_tokens token
         WHERE token.family_id = family.id AND token.token_hash = $1`,
      [expiredFamily.accessTokenHash],
    )
    assert.equal(
      await store.resolveOAuthAccessToken({
        accessTokenHash: expiredFamily.accessTokenHash,
        resource: expiredFamily.request.resource,
        scope: expiredFamily.request.scope,
      }),
      null,
    )
  })

  await t.test('passive access-token resolution validates the grant without touching quotas or token rows', async () => {
    await resetDatabase()
    const active = await exchangeExistingResidentCode(store, 'access-passive')
    await database!.query(
      `UPDATE residents
         SET quota_day = DATE '2000-01-01', things_today = 7, notes_today = 8,
           agreement_actions_today = 9
         WHERE id = 1`,
    )
    const snapshotSql = `
        SELECT resident.quota_day::text, resident.things_today, resident.notes_today,
          resident.agreement_actions_today, resident.xmin::text AS resident_xmin,
          token.xmin::text AS token_xmin, family.xmin::text AS family_xmin
        FROM oauth_tokens token
        JOIN oauth_token_families family ON family.id = token.family_id
        JOIN residents resident ON resident.id = family.resident_id
        WHERE token.token_hash = $1
      `
    const before = (await database!.query(snapshotSql, [active.accessTokenHash])).rows[0]

    assert.equal(await store.resolveOAuthAccessTokenPassive({
      accessTokenHash: active.accessTokenHash,
      resource: 'https://wrong-resource.example.test/mcp/connect',
      scope: active.request.scope,
    }), null)
    assert.equal(await store.resolveOAuthAccessTokenPassive({
      accessTokenHash: active.accessTokenHash,
      resource: active.request.resource,
      scope: 'city:wrong-scope',
    }), null)
    const resident = await store.resolveOAuthAccessTokenPassive({
      accessTokenHash: active.accessTokenHash,
      resource: active.request.resource,
      scope: active.request.scope,
    })
    assert.deepEqual({
      id: resident?.id,
      things_today: resident?.things_today,
      notes_today: resident?.notes_today,
      agreement_actions_today: resident?.agreement_actions_today,
    }, { id: 1, things_today: 7, notes_today: 8, agreement_actions_today: 9 })
    assert.deepEqual(
      (await database!.query(snapshotSql, [active.accessTokenHash])).rows[0],
      before,
      'passive authentication must leave the resident, token, and family versions unchanged',
    )

    await database!.query(
      `UPDATE oauth_tokens
         SET created_at = now() - interval '2 minutes',
           expires_at = now() - interval '1 minute'
         WHERE token_hash = $1`,
      [active.accessTokenHash],
    )
    assert.equal(await store.resolveOAuthAccessTokenPassive({
      accessTokenHash: active.accessTokenHash,
      resource: active.request.resource,
      scope: active.request.scope,
    }), null)
  })

}
