import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Client } from 'pg'

type OAuthStore = typeof import('../../src/oauth-store.ts')

interface AuthorizationRequestState {
  intent: 'existing' | 'new' | null
  resident_id: number | null
  new_handle: string | null
  new_model: string | null
  new_secret_hash: string | null
  verified_at: string | null
  approved_at: string | null
  root_key_confirmed_at: string | null
  used_at: string | null
}

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'oauth_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')

let database: Client | null = null

const sql = async (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): Promise<Record<string, unknown>[]> => {
  assert.ok(database, 'the PostgreSQL test client must be connected before the OAuth store runs')
  const text = strings.reduce(
    (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ''),
    '',
  )
  const result = await database.query(text, [...values])
  return result.rows as Record<string, unknown>[]
}

mock.module(new URL('../../src/db.ts', import.meta.url).href, {
  namedExports: { sql },
})

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ client: Client; containerName: string }> {
  const containerName = `1f3d9-oauth-test-${process.pid}-${randomBytes(4).toString('hex')}`
  const password = randomBytes(24).toString('hex')

  runDocker([
    'run', '--detach', '--rm', '--name', containerName,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', `POSTGRES_DB=${POSTGRES_DATABASE}`,
    POSTGRES_IMAGE,
  ])

  try {
    const portOutput = runDocker(['port', containerName, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/)?.[1])
    assert.ok(Number.isInteger(port) && port > 0, `could not read PostgreSQL port from ${portOutput}`)

    const deadline = Date.now() + 30_000
    let lastError: unknown = null
    while (Date.now() < deadline) {
      const client = new Client({
        host: '127.0.0.1',
        port,
        user: 'postgres',
        password,
        database: POSTGRES_DATABASE,
        ssl: false,
      })
      try {
        await client.connect()
        return { client, containerName }
      } catch (error) {
        lastError = error
        await client.end().catch(() => undefined)
        await delay(200)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
  } catch (error) {
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8' })
    throw error
  }
}

async function resetDatabase(): Promise<void> {
  assert.ok(database)
  await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await database.query(schemaDdl)
  await database.query(
    `INSERT INTO residents (id, handle, model, secret_hash)
     VALUES (1, 'existing-agent', 'integration-test', $1)`,
    [sha256('existing-resident-key')],
  )
  await database.query('UPDATE resident_id_allocator SET last_id = 1 WHERE singleton')
}

function authorizationRequestInput(label: string) {
  return {
    sessionHash: sha256(`${label}:session`),
    csrfHash: sha256(`${label}:csrf`),
    clientId: 'postgres-integration-client',
    clientName: 'PostgreSQL integration test',
    redirectUri: 'https://client.example.test/oauth/callback',
    resource: 'https://city.example.test/mcp/connect',
    scope: 'city:resident',
    state: `${label}-state`,
    codeChallenge: 'A'.repeat(43),
  }
}

async function requestState(sessionHash: string): Promise<AuthorizationRequestState> {
  assert.ok(database)
  const result = await database.query<AuthorizationRequestState>(
    `SELECT intent, resident_id, new_handle, new_model, new_secret_hash,
       verified_at::text, approved_at::text, root_key_confirmed_at::text, used_at::text
     FROM oauth_authorization_requests
     WHERE session_hash = $1`,
    [sessionHash],
  )
  assert.equal(result.rowCount, 1)
  return result.rows[0]!
}

async function seedAuthorizationCode(
  store: OAuthStore,
  label: string,
  authorizationCodeHash: string,
): Promise<void> {
  const request = authorizationRequestInput(label)
  await store.createAuthorizationRequest(request)
  const redirect = await store.approveExistingResidentAndIssueAuthorizationCode({
    sessionHash: request.sessionHash,
    csrfHash: request.csrfHash,
    residentSecretHash: sha256('existing-resident-key'),
    authorizationCodeHash,
  })
  assert.deepEqual(redirect, {
    redirectUri: request.redirectUri,
    state: request.state,
  })
}

async function exchangeExistingResidentCode(store: OAuthStore, label: string) {
  const request = authorizationRequestInput(label)
  const codeHash = sha256(`${label}:authorization-code`)
  const accessTokenHash = sha256(`${label}:access-token`)
  const refreshTokenHash = sha256(`${label}:refresh-token`)

  await seedAuthorizationCode(store, label, codeHash)
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

  return { request, codeHash, accessTokenHash, refreshTokenHash }
}

test('OAuth authorization writes roll back atomically in PostgreSQL', async t => {
  const postgres = await startPostgres()
  database = postgres.client

  try {
    const store = await import('../../src/oauth-store.ts')

    await t.test('a duplicate-handle race leaks no resident ID, row, event, or authorization code', async () => {
      await resetDatabase()
      const request = authorizationRequestInput('duplicate-handle')
      const pendingSecretHash = sha256('pending-new-resident-key')
      const authorizationCodeHash = sha256('duplicate-handle-code')

      await store.createAuthorizationRequest(request)
      assert.deepEqual(
        await store.stageNewResidentRegistration({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          handle: 'raced-handle',
          model: 'pending-model',
          residentSecretHash: pendingSecretHash,
        }),
        { status: 'staged', handle: 'raced-handle' },
      )

      await database!.query(
        `INSERT INTO residents (id, handle, model, secret_hash)
         VALUES (2, 'raced-handle', 'race-winner', $1)`,
        [sha256('race-winner-key')],
      )
      await database!.query('UPDATE resident_id_allocator SET last_id = 2 WHERE singleton')
      const pendingBefore = await requestState(request.sessionHash)

      const redirect = await store.confirmNewResidentAndIssueAuthorizationCode({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
        residentSecretHash: pendingSecretHash,
        authorizationCodeHash,
      })

      assert.equal(redirect, null)
      assert.deepEqual(await requestState(request.sessionHash), pendingBefore)

      const allocator = await database!.query<{ last_id: number }>(
        'SELECT last_id FROM resident_id_allocator WHERE singleton',
      )
      assert.equal(allocator.rows[0]!.last_id, 2, 'failed confirmation must return its allocated ID')

      const residents = await database!.query<{
        id: number
        handle: string
        model: string
        secret_hash: string
      }>('SELECT id, handle, model, secret_hash FROM residents ORDER BY id')
      assert.deepEqual(residents.rows, [
        {
          id: 1,
          handle: 'existing-agent',
          model: 'integration-test',
          secret_hash: sha256('existing-resident-key'),
        },
        {
          id: 2,
          handle: 'raced-handle',
          model: 'race-winner',
          secret_hash: sha256('race-winner-key'),
        },
      ])
      assert.ok(!residents.rows.some(resident => resident.secret_hash === pendingSecretHash))

      const leaked = await database!.query<{
        events: string
        authorization_codes: string
      }>(
        `SELECT
           (SELECT count(*) FROM events) AS events,
           (SELECT count(*) FROM oauth_authorization_codes) AS authorization_codes`,
      )
      assert.deepEqual(leaked.rows[0], { events: '0', authorization_codes: '0' })
    })

    await t.test('existing-resident approval rolls its request update back when code issue fails', async () => {
      await resetDatabase()
      const collidingCodeHash = sha256('existing-code-collision')
      await seedAuthorizationCode(store, 'existing-seed', collidingCodeHash)

      const request = authorizationRequestInput('existing-target')
      await store.createAuthorizationRequest(request)
      const requestBefore = await requestState(request.sessionHash)

      await assert.rejects(
        store.approveExistingResidentAndIssueAuthorizationCode({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          residentSecretHash: sha256('existing-resident-key'),
          authorizationCodeHash: collidingCodeHash,
        }),
        (error: unknown) => (error as { code?: string }).code === '23505',
      )

      assert.deepEqual(await requestState(request.sessionHash), requestBefore)
      const codes = await database!.query<{ count: string }>(
        'SELECT count(*) FROM oauth_authorization_codes',
      )
      assert.equal(codes.rows[0]!.count, '1')
    })

    await t.test('new-resident approval rolls every earlier write back when code issue fails', async () => {
      await resetDatabase()
      const collidingCodeHash = sha256('new-code-collision')
      await seedAuthorizationCode(store, 'new-seed', collidingCodeHash)

      const request = authorizationRequestInput('new-target')
      const pendingSecretHash = sha256('atomic-new-resident-key')
      await store.createAuthorizationRequest(request)
      assert.deepEqual(
        await store.stageNewResidentRegistration({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          handle: 'atomic-new-agent',
          model: 'hosted-chat',
          residentSecretHash: pendingSecretHash,
        }),
        { status: 'staged', handle: 'atomic-new-agent' },
      )
      const requestBefore = await requestState(request.sessionHash)

      const redirect = await store.confirmNewResidentAndIssueAuthorizationCode({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
        residentSecretHash: pendingSecretHash,
        authorizationCodeHash: collidingCodeHash,
      })

      assert.equal(redirect, null)
      assert.deepEqual(await requestState(request.sessionHash), requestBefore)

      const state = await database!.query<{
        last_id: number
        residents: string
        events: string
        authorization_codes: string
      }>(
        `SELECT
           (SELECT last_id FROM resident_id_allocator WHERE singleton) AS last_id,
           (SELECT count(*) FROM residents WHERE handle = 'atomic-new-agent') AS residents,
           (SELECT count(*) FROM events WHERE actor = 'atomic-new-agent') AS events,
           (SELECT count(*) FROM oauth_authorization_codes) AS authorization_codes`,
      )
      assert.deepEqual(state.rows[0], {
        last_id: 1,
        residents: '0',
        events: '0',
        authorization_codes: '1',
      })
    })

    await t.test('authorization requests can be read and cancelled only with the matching CSRF value', async () => {
      await resetDatabase()
      const request = authorizationRequestInput('request-lifecycle')
      await store.createAuthorizationRequest(request)

      const current = await store.getAuthorizationRequest(request.sessionHash)
      assert.ok(current)
      assert.equal(String(current.id), '1')
      const { id: _databaseId, ...requestWithoutDatabaseId } = current
      assert.deepEqual(requestWithoutDatabaseId, {
        client_id: request.clientId,
        client_display_name: request.clientName,
        redirect_uri: request.redirectUri,
        resource: request.resource,
        scope: request.scope,
        state: request.state,
        code_challenge: request.codeChallenge,
        intent: null,
        resident_id: null,
        new_handle: null,
        new_model: null,
        root_key_confirmed_at: null,
      })

      assert.equal(
        await store.cancelAuthorizationRequest({
          sessionHash: request.sessionHash,
          csrfHash: sha256('wrong-csrf'),
        }),
        null,
      )
      assert.ok(await store.getAuthorizationRequest(request.sessionHash))

      assert.deepEqual(
        await store.cancelAuthorizationRequest({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
        }),
        { redirectUri: request.redirectUri, state: request.state },
      )
      assert.equal(await store.getAuthorizationRequest(request.sessionHash), null)
      assert.ok((await requestState(request.sessionHash)).used_at)
    })

    await t.test('new-resident registration stays staged until confirmation, then issues one code', async () => {
      await resetDatabase()
      const request = authorizationRequestInput('new-resident-success')
      const residentSecretHash = sha256('new-resident-success:key')
      const codeHash = sha256('new-resident-success:code')
      await store.createAuthorizationRequest(request)

      assert.equal(
        await store.stageNewResidentRegistration({
          sessionHash: request.sessionHash,
          csrfHash: sha256('wrong-csrf'),
          handle: 'new-resident',
          model: 'hosted-chat',
          residentSecretHash,
        }),
        null,
      )
      assert.deepEqual(
        await store.stageNewResidentRegistration({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          handle: 'existing-agent',
          model: 'hosted-chat',
          residentSecretHash,
        }),
        { status: 'handle_taken' },
      )
      assert.deepEqual(
        await store.stageNewResidentRegistration({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          handle: 'new-resident',
          model: 'hosted-chat',
          residentSecretHash,
        }),
        { status: 'staged', handle: 'new-resident' },
      )

      const staged = await requestState(request.sessionHash)
      assert.equal(staged.intent, 'new')
      assert.equal(staged.resident_id, null)
      assert.equal(staged.new_secret_hash, residentSecretHash)
      assert.equal(
        (await database!.query("SELECT count(*) FROM residents WHERE handle = 'new-resident'"))
          .rows[0]!.count,
        '0',
      )

      assert.deepEqual(
        await store.confirmNewResidentAndIssueAuthorizationCode({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          residentSecretHash,
          authorizationCodeHash: codeHash,
        }),
        { redirectUri: request.redirectUri, state: request.state },
      )
      assert.equal(
        await store.confirmNewResidentAndIssueAuthorizationCode({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          residentSecretHash,
          authorizationCodeHash: sha256('second-code'),
        }),
        null,
      )

      const resident = await database!.query<{
        id: number
        handle: string
        model: string
        secret_hash: string
      }>("SELECT id, handle, model, secret_hash FROM residents WHERE handle = 'new-resident'")
      assert.deepEqual(resident.rows, [{
        id: 2,
        handle: 'new-resident',
        model: 'hosted-chat',
        secret_hash: residentSecretHash,
      }])
      assert.deepEqual(await store.getAuthorizationCode(codeHash), {
        residentId: 2,
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        resource: request.resource,
        scope: request.scope,
        codeChallenge: request.codeChallenge,
      })
      assert.equal(
        (await database!.query("SELECT count(*) FROM events WHERE kind = 'register' AND actor = 'new-resident'"))
          .rows[0]!.count,
        '1',
      )
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
      assert.deepEqual(attempts, [true, true, true, false, false])
      assert.equal(
        await store.consumeOAuthRateLimit({
          bucketHash,
          attemptKind: 'refresh',
          maximum: 1,
        }),
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
  } finally {
    database = null
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
