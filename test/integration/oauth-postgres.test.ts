import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Client, Pool } from 'pg'

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
const initialRecoveryCodesMigrationDdl = await readFile(
  new URL('../../db/migrations/20260817_initial_recovery_codes.sql', import.meta.url),
  'utf8',
)

let database: Pool | null = null

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

async function startPostgres(): Promise<{ client: Pool; containerName: string }> {
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
    const connection = {
      host: '127.0.0.1', port, user: 'postgres', password,
      database: POSTGRES_DATABASE, ssl: false,
    } as const
    while (Date.now() < deadline) {
      const client = new Client(connection)
      try {
        await client.connect()
        await client.end()
        return { client: new Pool(connection), containerName }
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

function stagedRegistration(label: string, handle = 'goldfish-agent') {
  return {
    sessionHash: sha256(`${label}:session`),
    csrfHash: sha256(`${label}:csrf`),
    handle,
    model: 'hosted-chat',
    residentSecretHash: sha256(`${label}:resident-key`),
    recoveryCodeHashes: Array.from(
      { length: 8 },
      (_, index) => sha256(`${label}:recovery:${index}`),
    ),
  }
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
    status: 'approved',
    redirectUri: request.redirectUri,
    state: request.state,
  })
}

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

    await t.test('the initial-code migration is idempotent and legacy new-resident requests fail closed', async () => {
      await resetDatabase()
      await database!.query(initialRecoveryCodesMigrationDdl)
      await database!.query(initialRecoveryCodesMigrationDdl)
      const request = authorizationRequestInput('legacy-oauth-no-codes')
      const staged = stagedRegistration('legacy-oauth-no-codes', 'legacy-oauth-no-codes')
      await store.createAuthorizationRequest(request)
      await database!.query(
        `UPDATE oauth_authorization_requests
         SET intent = 'new', new_handle = $1, new_model = $2,
             new_secret_hash = $3, verified_at = now(), approved_at = now()
         WHERE session_hash = $4`,
        [staged.handle, staged.model, staged.residentSecretHash, request.sessionHash],
      )

      await assert.rejects(
        store.confirmNewResidentAndIssueAuthorizationCode({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          residentSecretHash: staged.residentSecretHash,
          authorizationCodeHash: sha256('legacy-oauth-no-codes:authorization-code'),
        }),
      )
      const state = await database!.query(
        `SELECT
           (SELECT count(*) FROM residents WHERE handle = $1) AS residents,
           (SELECT count(*) FROM resident_presence WHERE resident_id <> 1) AS presences,
           (SELECT count(*) FROM resident_recovery_codes WHERE resident_id <> 1) AS active_codes,
           (SELECT count(*) FROM oauth_authorization_codes) AS authorization_codes,
           (SELECT count(*) FROM oauth_authorization_request_recovery_codes code
             JOIN oauth_authorization_requests request ON request.id = code.request_id
             WHERE request.session_hash = $2) AS pending_codes,
           (SELECT last_id FROM resident_id_allocator WHERE singleton) AS last_id`,
        [staged.handle, request.sessionHash],
      )
      assert.deepEqual(state.rows, [{
        residents: '0', presences: '0', active_codes: '0', authorization_codes: '0',
        pending_codes: '0', last_id: 1,
      }])

      await database!.query(
        `UPDATE oauth_authorization_requests
         SET created_at = now() - interval '16 minutes',
             expires_at = now() - interval '1 minute'
         WHERE session_hash = $1`,
        [request.sessionHash],
      )
      await store.createAuthorizationRequest(authorizationRequestInput('legacy-oauth-cleanup-trigger'))
      const expired = await requestState(request.sessionHash)
      assert.deepEqual({
        intent: expired.intent,
        new_handle: expired.new_handle,
        new_model: expired.new_model,
        new_secret_hash: expired.new_secret_hash,
        used: expired.used_at !== null,
      }, {
        intent: null, new_handle: null, new_model: null, new_secret_hash: null, used: true,
      })
    })

    await t.test('OAuth registration rejects every non-exact, malformed, or duplicate initial-code set', async () => {
      await resetDatabase()
      const valid = stagedRegistration('invalid-oauth-code-set', 'invalid-oauth-code-set')
      const attempts = [
        valid.recoveryCodeHashes.slice(0, 7),
        [...valid.recoveryCodeHashes, sha256('oauth-ninth-code')],
        valid.recoveryCodeHashes.map((hash, index) => index === 7 ? valid.recoveryCodeHashes[0]! : hash),
        valid.recoveryCodeHashes.map((hash, index) => index === 7 ? 'not-a-sha256-hash' : hash),
      ]
      for (const [index, recoveryCodeHashes] of attempts.entries()) {
        const request = authorizationRequestInput(`invalid-oauth-code-set:${index}`)
        await store.createAuthorizationRequest(request)
        await assert.rejects(
          store.stageNewResidentRegistration({
            ...valid,
            sessionHash: request.sessionHash,
            csrfHash: request.csrfHash,
            recoveryCodeHashes,
          }),
          /exactly eight unique sha256 recovery-code hashes are required/i,
        )
      }
      assert.equal((await database!.query('SELECT count(*) FROM oauth_authorization_request_recovery_codes')).rows[0]!.count, '0')
      assert.equal(
        (await database!.query("SELECT count(*) FROM oauth_authorization_requests WHERE intent = 'new'")).rows[0]!.count,
        '0',
      )
    })

    await t.test('concurrent duplicate OAuth staging keeps one resumable credential set', async () => {
      await resetDatabase()
      const request = authorizationRequestInput('concurrent-oauth-stage')
      await store.createAuthorizationRequest(request)
      const firstCredentials = stagedRegistration('concurrent-oauth-stage:first', 'concurrent-oauth-stage')
      const secondCredentials = stagedRegistration('concurrent-oauth-stage:second', 'concurrent-oauth-stage')
      const first = {
        ...firstCredentials,
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
      }
      const second = {
        ...secondCredentials,
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
      }
      const attempts = [first, second] as const

      const results = await Promise.all(
        attempts.map(attempt => store.stageNewResidentRegistration(attempt)),
      )

      assert.deepEqual(
        results.map(result => result.status).sort(),
        ['request_unavailable', 'staged'],
      )
      const winnerIndex = results.findIndex(result => result.status === 'staged')
      const winner = winnerIndex === 0 ? first : second
      const loser = winnerIndex === 0 ? second : first
      const persisted = await requestState(request.sessionHash)
      assert.deepEqual({
        intent: persisted.intent,
        resident_id: persisted.resident_id,
        new_handle: persisted.new_handle,
        new_model: persisted.new_model,
        new_secret_hash: persisted.new_secret_hash,
        root_key_confirmed_at: persisted.root_key_confirmed_at,
        used_at: persisted.used_at,
      }, {
        intent: 'new',
        resident_id: null,
        new_handle: winner.handle,
        new_model: winner.model,
        new_secret_hash: winner.residentSecretHash,
        root_key_confirmed_at: null,
        used_at: null,
      })
      const persistedCodes = await database!.query<{ ordinal: number; code_hash: string }>(
        `SELECT code.ordinal, code.code_hash
         FROM oauth_authorization_request_recovery_codes code
         JOIN oauth_authorization_requests request ON request.id = code.request_id
         WHERE request.session_hash = $1
         ORDER BY code.ordinal`,
        [request.sessionHash],
      )
      assert.deepEqual(
        persistedCodes.rows,
        winner.recoveryCodeHashes.map((code_hash, index) => ({ ordinal: index + 1, code_hash })),
      )
      assert.equal(
        loser.recoveryCodeHashes.some(hash => persistedCodes.rows.some(row => row.code_hash === hash)),
        false,
      )
      const resumable = await store.getAuthorizationRequest(request.sessionHash)
      assert.ok(resumable)
      assert.deepEqual({
        intent: resumable.intent,
        new_handle: resumable.new_handle,
        new_model: resumable.new_model,
        root_key_confirmed_at: resumable.root_key_confirmed_at,
      }, {
        intent: 'new',
        new_handle: winner.handle,
        new_model: winner.model,
        root_key_confirmed_at: null,
      })
    })

    await t.test('unknown and wrong resident keys stay merged and leave the same request retryable', async () => {
      await resetDatabase()
      const request = authorizationRequestInput('existing-key-retry')
      await store.createAuthorizationRequest(request)
      const requestBefore = await requestState(request.sessionHash)

      for (const [index, presentedKey] of [
        'wrong-existing-resident-key',
        'unknown-resident-key',
      ].entries()) {
        assert.deepEqual(
          await store.approveExistingResidentAndIssueAuthorizationCode({
            sessionHash: request.sessionHash,
            csrfHash: request.csrfHash,
            residentSecretHash: sha256(presentedKey),
            authorizationCodeHash: sha256(`existing-key-retry:rejected-code:${index}`),
          }),
          { status: 'resident_key_rejected' },
        )
        assert.deepEqual(
          await requestState(request.sessionHash),
          requestBefore,
          'a rejected key must not consume or alter the authorization request',
        )
      }

      assert.deepEqual(
        await store.approveExistingResidentAndIssueAuthorizationCode({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          residentSecretHash: sha256('existing-resident-key'),
          authorizationCodeHash: sha256('existing-key-retry:accepted-code'),
        }),
        {
          status: 'approved',
          redirectUri: request.redirectUri,
          state: request.state,
        },
      )
    })

    await t.test('a wrong staged-signup key leaves the same request retryable', async () => {
      await resetDatabase()
      const request = authorizationRequestInput('new-key-retry')
      const pending = stagedRegistration('new-key-retry', 'new-key-retry')
      await store.createAuthorizationRequest(request)
      assert.deepEqual(
        await store.stageNewResidentRegistration(pending),
        { status: 'staged', handle: pending.handle },
      )
      const requestBefore = await requestState(request.sessionHash)

      assert.deepEqual(
        await store.confirmNewResidentAndIssueAuthorizationCode({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          residentSecretHash: sha256('wrong-new-resident-key'),
          authorizationCodeHash: sha256('new-key-retry:rejected-code'),
        }),
        { status: 'confirmation_rejected' },
      )
      assert.deepEqual(
        await requestState(request.sessionHash),
        requestBefore,
        'a rejected confirmation key must leave the staged signup intact',
      )
      assert.equal(
        (await database!.query(
          `SELECT count(*)
           FROM oauth_authorization_request_recovery_codes code
           JOIN oauth_authorization_requests request ON request.id = code.request_id
           WHERE request.session_hash = $1`,
          [request.sessionHash],
        )).rows[0]!.count,
        '8',
      )

      assert.deepEqual(
        await store.confirmNewResidentAndIssueAuthorizationCode({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          residentSecretHash: pending.residentSecretHash,
          authorizationCodeHash: sha256('new-key-retry:accepted-code'),
        }),
        {
          status: 'approved',
          redirectUri: request.redirectUri,
          state: request.state,
        },
      )
    })

    await t.test('expired and used authorization requests are unavailable rather than key rejections', async () => {
      await resetDatabase()
      const expired = authorizationRequestInput('unavailable-expired')
      const used = authorizationRequestInput('unavailable-used')
      await store.createAuthorizationRequest(expired)
      await store.createAuthorizationRequest(used)
      await database!.query(
        `UPDATE oauth_authorization_requests
         SET created_at = now() - interval '16 minutes',
             expires_at = now() - interval '1 minute'
         WHERE session_hash = $1`,
        [expired.sessionHash],
      )
      assert.deepEqual(
        await store.cancelAuthorizationRequest({
          sessionHash: used.sessionHash,
          csrfHash: used.csrfHash,
        }),
        { redirectUri: used.redirectUri, state: used.state },
      )

      for (const request of [expired, used]) {
        assert.deepEqual(
          await store.approveExistingResidentAndIssueAuthorizationCode({
            sessionHash: request.sessionHash,
            csrfHash: request.csrfHash,
            residentSecretHash: sha256('existing-resident-key'),
            authorizationCodeHash: sha256(`${request.state}:unavailable-code`),
          }),
          { status: 'request_unavailable' },
        )
      }
    })

    await t.test('a same-handle confirmation returns handle_taken and leaks no resident data', async () => {
      await resetDatabase()
      const request = authorizationRequestInput('duplicate-handle')
      const pendingSecretHash = sha256('pending-new-resident-key')
      const pendingRecoveryCodeHashes = Array.from(
        { length: 8 },
        (_, index) => sha256(`duplicate-handle:recovery:${index}`),
      )
      const authorizationCodeHash = sha256('duplicate-handle-code')

      await store.createAuthorizationRequest(request)
      assert.deepEqual(
        await store.stageNewResidentRegistration({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          handle: 'raced-handle',
          model: 'pending-model',
          residentSecretHash: pendingSecretHash,
          recoveryCodeHashes: pendingRecoveryCodeHashes,
        }),
        { status: 'staged', handle: 'raced-handle' },
      )

      await database!.query(
        `INSERT INTO residents (id, handle, model, secret_hash)
         VALUES (2, 'raced-handle', 'race-winner', $1)`,
        [sha256('race-winner-key')],
      )
      await database!.query('UPDATE resident_id_allocator SET last_id = 2 WHERE singleton')
      const result = await store.confirmNewResidentAndIssueAuthorizationCode({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
        residentSecretHash: pendingSecretHash,
        authorizationCodeHash,
      })

      assert.deepEqual(result, { status: 'handle_taken' })
      const canceled = await requestState(request.sessionHash)
      assert.deepEqual({
        intent: canceled.intent,
        resident_id: canceled.resident_id,
        new_handle: canceled.new_handle,
        new_model: canceled.new_model,
        new_secret_hash: canceled.new_secret_hash,
        verified_at: canceled.verified_at,
        approved_at: canceled.approved_at,
        root_key_confirmed_at: canceled.root_key_confirmed_at,
      }, {
        intent: null,
        resident_id: null,
        new_handle: null,
        new_model: null,
        new_secret_hash: null,
        verified_at: null,
        approved_at: null,
        root_key_confirmed_at: null,
      })
      assert.ok(canceled.used_at)
      const pendingCodes = await database!.query<{ count: string }>(
        `SELECT count(*) FROM oauth_authorization_request_recovery_codes code
         JOIN oauth_authorization_requests request ON request.id = code.request_id
         WHERE request.session_hash = $1`,
        [request.sessionHash],
      )
      assert.equal(pendingCodes.rows[0]!.count, '0')
      assert.equal((await store.getAuthorizationRequestProgress({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
      }))?.status, 'canceled')

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

    await t.test('an unrelated authorization-code collision throws and rolls every new-resident write back', async () => {
      await resetDatabase()
      const collidingCodeHash = sha256('new-code-collision')
      await seedAuthorizationCode(store, 'new-seed', collidingCodeHash)

      const request = authorizationRequestInput('new-target')
      const pendingSecretHash = sha256('atomic-new-resident-key')
      const pendingRecoveryCodeHashes = Array.from(
        { length: 8 },
        (_, index) => sha256(`new-target:recovery:${index}`),
      )
      await store.createAuthorizationRequest(request)
      assert.deepEqual(
        await store.stageNewResidentRegistration({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          handle: 'atomic-new-agent',
          model: 'hosted-chat',
          residentSecretHash: pendingSecretHash,
          recoveryCodeHashes: pendingRecoveryCodeHashes,
        }),
        { status: 'staged', handle: 'atomic-new-agent' },
      )
      const requestBefore = await requestState(request.sessionHash)

      await assert.rejects(
        store.confirmNewResidentAndIssueAuthorizationCode({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          residentSecretHash: pendingSecretHash,
          authorizationCodeHash: collidingCodeHash,
        }),
        (error: unknown) => {
          const postgresError = error as { code?: string; constraint?: string }
          return postgresError.code === '23505' &&
            postgresError.constraint === 'oauth_authorization_codes_code_hash_key'
        },
      )
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
      const canceledProgress = await store.getAuthorizationRequestProgress({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
      })
      assert.equal(canceledProgress?.status, 'canceled')
      assert.equal(canceledProgress?.request.client_id, request.clientId)
      assert.equal(await store.getAuthorizationRequestProgress({
        sessionHash: request.sessionHash,
        csrfHash: sha256('wrong-progress-csrf'),
      }), null)
      assert.ok((await requestState(request.sessionHash)).used_at)
    })

    await t.test('OAuth cancellation and expiry scrub every pending recovery hash', async () => {
      await resetDatabase()
      const canceledRequest = authorizationRequestInput('oauth-canceled-registration')
      const canceled = stagedRegistration('oauth-canceled-registration', 'oauth-canceled-registration')
      await store.createAuthorizationRequest(canceledRequest)
      assert.equal((await store.stageNewResidentRegistration(canceled)).status, 'staged')
      assert.deepEqual(await store.cancelAuthorizationRequest({
        sessionHash: canceledRequest.sessionHash,
        csrfHash: canceledRequest.csrfHash,
      }), { redirectUri: canceledRequest.redirectUri, state: canceledRequest.state })

      const expiredRequest = authorizationRequestInput('oauth-expired-registration')
      const expired = stagedRegistration('oauth-expired-registration', 'oauth-expired-registration')
      await store.createAuthorizationRequest(expiredRequest)
      assert.equal((await store.stageNewResidentRegistration(expired)).status, 'staged')
      await database!.query(
        `UPDATE oauth_authorization_requests
         SET created_at = now() - interval '16 minutes',
             expires_at = now() - interval '1 minute'
         WHERE session_hash = $1`,
        [expiredRequest.sessionHash],
      )
      await store.createAuthorizationRequest(authorizationRequestInput('oauth-cleanup-trigger'))
      const expiredProgress = await store.getAuthorizationRequestProgress({
        sessionHash: expiredRequest.sessionHash,
        csrfHash: expiredRequest.csrfHash,
      })
      assert.equal(expiredProgress?.status, 'expired')
      assert.equal(expiredProgress?.request.client_id, expiredRequest.clientId)

      const state = await database!.query(
        `SELECT request.session_hash, request.intent, request.new_handle, request.new_model,
           request.new_secret_hash, request.used_at IS NOT NULL AS used,
           count(code.code_hash) AS pending_codes
         FROM oauth_authorization_requests request
         LEFT JOIN oauth_authorization_request_recovery_codes code ON code.request_id = request.id
         WHERE request.session_hash IN ($1, $2)
         GROUP BY request.id
         ORDER BY request.session_hash`,
        [canceledRequest.sessionHash, expiredRequest.sessionHash],
      )
      assert.equal(state.rows.length, 2)
      for (const row of state.rows) {
        assert.deepEqual({
          intent: row.intent,
          new_handle: row.new_handle,
          new_model: row.new_model,
          new_secret_hash: row.new_secret_hash,
          used: row.used,
          pending_codes: row.pending_codes,
        }, {
          intent: null,
          new_handle: null,
          new_model: null,
          new_secret_hash: null,
          used: true,
          pending_codes: '0',
        })
      }
    })

    await t.test('a missing world root leaves OAuth resident creation entirely pending', async () => {
      await resetDatabase()
      await database!.query('DROP TRIGGER places_protect_topology_write ON places')
      await database!.query("DELETE FROM places WHERE place_kind = 'world'")
      const request = authorizationRequestInput('oauth-missing-world')
      const pending = stagedRegistration('oauth-missing-world', 'oauth-missing-world')
      await store.createAuthorizationRequest(request)
      assert.equal((await store.stageNewResidentRegistration(pending)).status, 'staged')

      await assert.rejects(
        store.confirmNewResidentAndIssueAuthorizationCode({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          residentSecretHash: pending.residentSecretHash,
          authorizationCodeHash: sha256('oauth-missing-world:authorization-code'),
        }),
      )
      const state = await database!.query(
        `SELECT
           (SELECT last_id FROM resident_id_allocator WHERE singleton) AS last_id,
           (SELECT count(*) FROM residents WHERE handle = $1) AS residents,
           (SELECT count(*) FROM resident_presence WHERE resident_id <> 1) AS presences,
           (SELECT count(*) FROM events WHERE actor = $1) AS events,
           (SELECT count(*) FROM resident_recovery_codes WHERE resident_id <> 1) AS active_codes,
           (SELECT count(*) FROM oauth_authorization_codes) AS authorization_codes,
           (SELECT count(*) FROM oauth_authorization_request_recovery_codes code
             JOIN oauth_authorization_requests request ON request.id = code.request_id
             WHERE request.session_hash = $2) AS pending_codes`,
        [pending.handle, request.sessionHash],
      )
      assert.deepEqual(state.rows, [{
        last_id: 1, residents: '0', presences: '0', events: '0', active_codes: '0',
        authorization_codes: '0', pending_codes: '8',
      }])
    })

    await t.test('an active recovery-code collision rolls the OAuth resident and authorization code back', async () => {
      await resetDatabase()
      const request = authorizationRequestInput('oauth-active-code-collision')
      const pending = stagedRegistration('oauth-active-code-collision', 'oauth-code-collision')
      await database!.query('UPDATE residents SET recovery_generation = 1 WHERE id = 1')
      await database!.query(
        `INSERT INTO resident_recovery_codes (resident_id, generation, code_hash)
         VALUES (1, 1, $1)`,
        [pending.recoveryCodeHashes[5]],
      )
      await store.createAuthorizationRequest(request)
      assert.equal((await store.stageNewResidentRegistration(pending)).status, 'staged')

      await assert.rejects(
        store.confirmNewResidentAndIssueAuthorizationCode({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          residentSecretHash: pending.residentSecretHash,
          authorizationCodeHash: sha256('oauth-active-code-collision:authorization-code'),
        }),
        (error: unknown) => {
          const postgresError = error as { code?: string; constraint?: string }
          return postgresError.code === '23505' &&
            postgresError.constraint === 'resident_recovery_codes_code_hash_key'
        },
      )
      const state = await database!.query(
        `SELECT
           (SELECT last_id FROM resident_id_allocator WHERE singleton) AS last_id,
           (SELECT count(*) FROM residents WHERE handle = $1) AS residents,
           (SELECT count(*) FROM resident_presence WHERE resident_id <> 1) AS presences,
           (SELECT count(*) FROM events WHERE actor = $1) AS events,
           (SELECT count(*) FROM resident_recovery_codes WHERE resident_id <> 1) AS active_codes,
           (SELECT count(*) FROM oauth_authorization_codes) AS authorization_codes,
           (SELECT count(*) FROM oauth_authorization_request_recovery_codes code
             JOIN oauth_authorization_requests request ON request.id = code.request_id
             WHERE request.session_hash = $2) AS pending_codes`,
        [pending.handle, request.sessionHash],
      )
      assert.deepEqual(state.rows, [{
        last_id: 1, residents: '0', presences: '0', events: '0', active_codes: '0',
        authorization_codes: '0', pending_codes: '8',
      }])
    })

    await t.test('an OAuth registration event failure rolls every creation write back', async () => {
      await resetDatabase()
      const request = authorizationRequestInput('oauth-event-rollback')
      const pending = stagedRegistration('oauth-event-rollback', 'oauth-event-rollback')
      await store.createAuthorizationRequest(request)
      assert.equal((await store.stageNewResidentRegistration(pending)).status, 'staged')
      await database!.query(`
        CREATE FUNCTION fail_oauth_registration_event() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.kind = 'register' AND NEW.actor = 'oauth-event-rollback' THEN
            RAISE EXCEPTION 'injected OAuth registration event failure';
          END IF;
          RETURN NEW;
        END
        $$;
        CREATE TRIGGER events_fail_oauth_registration
          BEFORE INSERT ON events
          FOR EACH ROW EXECUTE FUNCTION fail_oauth_registration_event();
      `)

      await assert.rejects(
        store.confirmNewResidentAndIssueAuthorizationCode({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          residentSecretHash: pending.residentSecretHash,
          authorizationCodeHash: sha256('oauth-event-rollback:authorization-code'),
        }),
        /injected OAuth registration event failure/i,
      )
      const state = await database!.query(
        `SELECT
           (SELECT last_id FROM resident_id_allocator WHERE singleton) AS last_id,
           (SELECT count(*) FROM residents WHERE handle = $1) AS residents,
           (SELECT count(*) FROM resident_presence WHERE resident_id <> 1) AS presences,
           (SELECT count(*) FROM events WHERE actor = $1) AS events,
           (SELECT count(*) FROM resident_recovery_codes WHERE resident_id <> 1) AS active_codes,
           (SELECT count(*) FROM oauth_authorization_codes) AS authorization_codes,
           (SELECT count(*) FROM oauth_authorization_request_recovery_codes code
             JOIN oauth_authorization_requests request ON request.id = code.request_id
             WHERE request.session_hash = $2) AS pending_codes`,
        [pending.handle, request.sessionHash],
      )
      assert.deepEqual(state.rows, [{
        last_id: 1, residents: '0', presences: '0', events: '0', active_codes: '0',
        authorization_codes: '0', pending_codes: '8',
      }])
    })

    await t.test('new-resident registration stays staged until confirmation, then issues one code', async () => {
      await resetDatabase()
      const request = authorizationRequestInput('new-resident-success')
      const residentSecretHash = sha256('new-resident-success:key')
      const recoveryCodeHashes = Array.from(
        { length: 8 },
        (_, index) => sha256(`new-resident-success:recovery:${index}`),
      )
      const codeHash = sha256('new-resident-success:code')
      await store.createAuthorizationRequest(request)

      assert.deepEqual(
        await store.confirmNewResidentAndIssueAuthorizationCode({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          residentSecretHash,
          authorizationCodeHash: sha256('new-resident-success:not-ready-code'),
        }),
        { status: 'confirmation_not_ready' },
      )
      assert.deepEqual(
        await store.stageNewResidentRegistration({
          sessionHash: request.sessionHash,
          csrfHash: sha256('wrong-csrf'),
          handle: 'new-resident',
          model: 'hosted-chat',
          residentSecretHash,
          recoveryCodeHashes,
        }),
        { status: 'request_unavailable' },
      )
      assert.deepEqual(
        await store.stageNewResidentRegistration({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          handle: 'existing-agent',
          model: 'hosted-chat',
          residentSecretHash,
          recoveryCodeHashes,
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
          recoveryCodeHashes,
        }),
        { status: 'staged', handle: 'new-resident' },
      )

      const staged = await requestState(request.sessionHash)
      assert.equal(staged.intent, 'new')
      assert.equal(staged.resident_id, null)
      assert.equal(staged.new_secret_hash, residentSecretHash)
      const pendingCodes = await database!.query(
        `SELECT code.ordinal, code.code_hash
         FROM oauth_authorization_request_recovery_codes code
         JOIN oauth_authorization_requests request ON request.id = code.request_id
         WHERE request.session_hash = $1
         ORDER BY code.ordinal`,
        [request.sessionHash],
      )
      assert.deepEqual(
        pendingCodes.rows,
        recoveryCodeHashes.map((code_hash, index) => ({ ordinal: index + 1, code_hash })),
      )
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
        {
          status: 'approved',
          redirectUri: request.redirectUri,
          state: request.state,
        },
      )
      assert.deepEqual(
        await store.confirmNewResidentAndIssueAuthorizationCode({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          residentSecretHash,
          authorizationCodeHash: sha256('second-code'),
        }),
        { status: 'request_unavailable' },
      )
      const confirmedProgress = await store.getAuthorizationRequestProgress({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
      })
      assert.equal(confirmedProgress?.status, 'confirmed')
      if (confirmedProgress?.status === 'confirmed') {
        assert.equal(confirmedProgress.residentId, 2)
        assert.equal(confirmedProgress.handle, 'new-resident')
        assert.equal(confirmedProgress.request.client_id, request.clientId)
      }

      const resident = await database!.query<{
        id: number
        handle: string
        model: string
        secret_hash: string
        recovery_generation: string
      }>("SELECT id, handle, model, secret_hash, recovery_generation FROM residents WHERE handle = 'new-resident'")
      assert.deepEqual(resident.rows, [{
        id: 2,
        handle: 'new-resident',
        model: 'hosted-chat',
        secret_hash: residentSecretHash,
        recovery_generation: '1',
      }])
      const initialRecoveryCodes = await database!.query<{
        code_hashes: string[]
        pending_codes: string
      }>(
        `SELECT array_agg(code_hash ORDER BY code_hash) AS code_hashes,
           (SELECT count(*) FROM oauth_authorization_request_recovery_codes code
             JOIN oauth_authorization_requests request ON request.id = code.request_id
             WHERE request.session_hash = $1) AS pending_codes
         FROM resident_recovery_codes
         WHERE resident_id = 2 AND generation = 1
           AND used_at IS NULL AND invalidated_at IS NULL`,
        [request.sessionHash],
      )
      assert.deepEqual(initialRecoveryCodes.rows, [{
        code_hashes: [...recoveryCodeHashes].sort(), pending_codes: '0',
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

    await t.test('two concurrent OAuth claims for one handle create one complete resident only', async () => {
      await resetDatabase()
      const firstRequest = authorizationRequestInput('oauth-race-first')
      const secondRequest = authorizationRequestInput('oauth-race-second')
      const first = stagedRegistration('oauth-race-first', 'oauth-raced-name')
      const second = stagedRegistration('oauth-race-second', 'oauth-raced-name')
      await Promise.all([
        store.createAuthorizationRequest(firstRequest),
        store.createAuthorizationRequest(secondRequest),
      ])
      assert.equal((await store.stageNewResidentRegistration(first)).status, 'staged')
      assert.equal((await store.stageNewResidentRegistration(second)).status, 'staged')

      const results = await Promise.all([
        store.confirmNewResidentAndIssueAuthorizationCode({
          sessionHash: firstRequest.sessionHash,
          csrfHash: firstRequest.csrfHash,
          residentSecretHash: first.residentSecretHash,
          authorizationCodeHash: sha256('oauth-race-first:authorization-code'),
        }),
        store.confirmNewResidentAndIssueAuthorizationCode({
          sessionHash: secondRequest.sessionHash,
          csrfHash: secondRequest.csrfHash,
          residentSecretHash: second.residentSecretHash,
          authorizationCodeHash: sha256('oauth-race-second:authorization-code'),
        }),
      ])
      assert.deepEqual(
        results.map(result => result.status).sort(),
        ['approved', 'handle_taken'],
      )
      const winner = results[0].status === 'approved' ? first : second
      const loser = results[0].status === 'approved' ? second : first
      const state = await database!.query(
        `SELECT
           (SELECT last_id FROM resident_id_allocator WHERE singleton) AS last_id,
           (SELECT count(*) FROM residents WHERE handle = 'oauth-raced-name') AS residents,
           (SELECT count(*) FROM resident_presence presence
             JOIN residents resident ON resident.id = presence.resident_id
             WHERE resident.handle = 'oauth-raced-name') AS presences,
           (SELECT count(*) FROM events WHERE actor = 'oauth-raced-name') AS events,
           (SELECT count(*) FROM oauth_authorization_codes) AS authorization_codes,
           (SELECT count(*) FROM resident_recovery_codes code
             JOIN residents resident ON resident.id = code.resident_id
             WHERE resident.handle = 'oauth-raced-name' AND code.generation = 1
               AND code.used_at IS NULL AND code.invalidated_at IS NULL) AS active_codes,
           (SELECT count(*) FROM oauth_authorization_request_recovery_codes code
             JOIN oauth_authorization_requests request ON request.id = code.request_id
             WHERE request.session_hash = $1) AS winner_pending_codes,
           (SELECT count(*) FROM oauth_authorization_request_recovery_codes code
             JOIN oauth_authorization_requests request ON request.id = code.request_id
             WHERE request.session_hash = $2) AS loser_pending_codes`,
        [winner.sessionHash, loser.sessionHash],
      )
      assert.deepEqual(state.rows, [{
        last_id: 2, residents: '1', presences: '1', events: '1', authorization_codes: '1',
        active_codes: '8', winner_pending_codes: '0', loser_pending_codes: '0',
      }])
      assert.equal((await store.getAuthorizationRequestProgress({
        sessionHash: loser.sessionHash,
        csrfHash: loser.csrfHash,
      }))?.status, 'canceled')
    })

    await t.test('OAuth cancellation waiting behind confirmation reports the completed resident', async () => {
      await resetDatabase()
      const request = authorizationRequestInput('oauth-cancel-confirm-race')
      const pending = stagedRegistration('oauth-cancel-confirm-race', 'oauth-cancel-race')
      await store.createAuthorizationRequest(request)
      assert.equal((await store.stageNewResidentRegistration(pending)).status, 'staged')
      await database!.query(`
        CREATE OR REPLACE FUNCTION delay_oauth_cancel_race_event() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.kind = 'register' AND NEW.actor = 'oauth-cancel-race' THEN
            PERFORM pg_sleep(0.25);
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER delay_oauth_cancel_race_event
        BEFORE INSERT ON events
        FOR EACH ROW EXECUTE FUNCTION delay_oauth_cancel_race_event();
      `)

      const confirmation = store.confirmNewResidentAndIssueAuthorizationCode({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
        residentSecretHash: pending.residentSecretHash,
        authorizationCodeHash: sha256('oauth-cancel-confirm-race:authorization-code'),
      })
      await delay(25)
      const cancellation = store.cancelAuthorizationRequest({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
      })

      assert.equal((await confirmation).status, 'approved')
      assert.equal(await cancellation, null)
      const progress = await store.getAuthorizationRequestProgress({
        sessionHash: request.sessionHash,
        csrfHash: request.csrfHash,
      })
      assert.equal(progress?.status, 'confirmed')
      if (progress?.status === 'confirmed') {
        assert.equal(progress.handle, 'oauth-cancel-race')
        assert.equal(progress.residentId, 2)
      }
    })

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
  } finally {
    database = null
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
