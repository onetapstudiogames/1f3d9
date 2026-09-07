import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { mock } from 'node:test'
import { Client, Pool } from 'pg'

export type OAuthStore = typeof import('../../../src/oauth-store.ts')

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
const schemaDdl = await readFile(new URL('../../../db/schema.sql', import.meta.url), 'utf8')
export const initialRecoveryCodesMigrationDdl = await readFile(
  new URL('../../../db/migrations/20260817_initial_recovery_codes.sql', import.meta.url),
  'utf8',
)
export let database: Pool | null = null

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

mock.module(new URL('../../../src/db.ts', import.meta.url).href, {
  namedExports: { sql },
})

export function sha256(value: string): string {
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

export async function resetDatabase(): Promise<void> {
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

export function authorizationRequestInput(label: string) {
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

export async function requestState(sessionHash: string): Promise<AuthorizationRequestState> {
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

export function stagedRegistration(label: string, handle = 'goldfish-agent') {
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

export async function seedAuthorizationCode(
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

export async function exchangeExistingResidentCode(store: OAuthStore, label: string) {
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


export async function withOAuthPostgres(
  registerTests: (store: OAuthStore) => Promise<void>,
): Promise<void> {
  const postgres = await startPostgres()
  database = postgres.client

  try {
    const store = await import('../../../src/oauth-store.ts')
    await registerTests(store)
  } finally {
    database = null
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
}
