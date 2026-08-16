import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { splitSqlStatements } from '../scripts/migrate.ts'

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8')
const oauthStore = readFileSync(new URL('../src/oauth-store.ts', import.meta.url), 'utf8')
const statements = splitSqlStatements(schema)

function functionSource(name: string, nextName: string): string {
  const start = oauthStore.indexOf(`export async function ${name}`)
  const end = oauthStore.indexOf(`export async function ${nextName}`, start)
  assert.ok(start >= 0 && end > start, `missing ${name} function boundary`)
  return oauthStore.slice(start, end)
}

function assertSingleDatabaseStatement(source: string, label: string): void {
  assert.equal(
    source.match(/await\s+sql`/g)?.length ?? 0,
    1,
    `${label} must remain one PostgreSQL statement so every write rolls back together`,
  )
}

function table(name: string) {
  const ddl = statements.find(statement =>
    new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${name}\\b`, 'i').test(statement))
  assert.ok(ddl, `missing additive ${name} table`)
  return ddl
}

test('authorization codes store only a hash and become unusable after one redemption', () => {
  const ddl = table('oauth_authorization_codes')

  assert.match(ddl, /code_hash\s+TEXT\s+NOT NULL\s+UNIQUE/i)
  assert.doesNotMatch(ddl, /(?:^|\n)\s*(?:code|authorization_code)\s+TEXT\b/i)
  assert.match(ddl, /resident_id\s+INTEGER\s+NOT NULL\s+REFERENCES\s+residents\s*\(id\)\s+ON DELETE RESTRICT/i)
  for (const field of ['client_id', 'redirect_uri', 'resource', 'scope', 'code_challenge', 'expires_at', 'used_at']) {
    assert.match(ddl, new RegExp(`\\b${field}\\b`, 'i'))
  }
  assert.match(ddl, /code_challenge_method[^,]*S256/i)
})

test('new resident registration is hash-only and stays out of the city until confirmation', () => {
  const requests = table('oauth_authorization_requests')
  assert.match(requests, /new_secret_hash\s+TEXT[^,]*\^\[0-9a-f\]\{64\}\$/i)
  assert.doesNotMatch(requests, /(?:^|\n)\s*(?:new_secret|root_key|resident_key)\s+TEXT\b/im)
  assert.doesNotMatch(requests, /new_handle[^,]*\bUNIQUE\b/i)

  const stageStart = oauthStore.indexOf('export async function stageNewResidentRegistration')
  const confirmStart = oauthStore.indexOf(
    'export async function confirmNewResidentAndIssueAuthorizationCode',
  )
  assert.ok(stageStart >= 0 && confirmStart > stageStart)
  const stageSql = oauthStore.slice(stageStart, confirmStart)
  assert.doesNotMatch(stageSql, /INSERT INTO residents|INSERT INTO events|UPDATE resident_id_allocator/i)

  const confirmEnd = oauthStore.indexOf('export async function getAuthorizationCode', confirmStart)
  assert.ok(confirmEnd > confirmStart)
  const confirmationSql = oauthStore.slice(confirmStart, confirmEnd)
  assertSingleDatabaseStatement(confirmationSql, 'new-resident confirmation')
  assert.match(confirmationSql, /UPDATE resident_id_allocator/i)
  assert.match(confirmationSql, /INSERT INTO residents/i)
  assert.match(confirmationSql, /INSERT INTO events/i)
  assert.match(confirmationSql, /INSERT INTO oauth_authorization_codes/i)
  assert.match(confirmationSql, /new_secret_hash\s*=\s*NULL/i)
  assert.match(confirmationSql, /postgresErrorCode\(error\)\s*===\s*'23505'/i)

  const createStart = oauthStore.indexOf('export async function createAuthorizationRequest')
  assert.ok(createStart >= 0 && createStart < stageStart)
  const cleanupSql = oauthStore.slice(createStart, stageStart)
  assert.match(cleanupSql, /expires_at\s*<=\s*now\(\)/i)
  assert.match(cleanupSql, /resident_id\s+IS\s+NULL/i)
  assert.match(cleanupSql, /new_secret_hash\s*=\s*NULL/i)
  assert.doesNotMatch(cleanupSql, /DELETE\s+FROM\s+oauth_authorization_requests/i)
})

test('existing resident verification and authorization-code issue share one database statement', () => {
  const existingApprovalSql = functionSource(
    'approveExistingResidentAndIssueAuthorizationCode',
    'stageNewResidentRegistration',
  )
  assertSingleDatabaseStatement(existingApprovalSql, 'existing-resident approval')
  assert.match(existingApprovalSql, /FROM residents/i)
  assert.match(existingApprovalSql, /UPDATE oauth_authorization_requests/i)
  assert.match(existingApprovalSql, /INSERT INTO oauth_authorization_codes/i)
  assert.doesNotMatch(oauthStore, /export async function attachExistingResident/i)
})

test('access and refresh credentials are hash-only, expiring, and belong to one revocable family', () => {
  const families = table('oauth_token_families')
  const tokens = table('oauth_tokens')

  assert.match(families, /resident_id\s+INTEGER\s+NOT NULL\s+REFERENCES\s+residents\s*\(id\)\s+ON DELETE RESTRICT/i)
  assert.match(families, /revoked_at\s+TIMESTAMPTZ/i)
  for (const field of ['client_id', 'resource', 'scope']) {
    assert.match(families, new RegExp(`\\b${field}\\b`, 'i'))
  }

  assert.match(tokens, /token_hash\s+TEXT\s+NOT NULL\s+UNIQUE/i)
  assert.doesNotMatch(tokens, /(?:^|\n)\s*(?:access_token|refresh_token|token)\s+TEXT\b/i)
  assert.match(tokens, /token_type[^,]*(?:access[^,]*refresh|refresh[^,]*access)/i)
  assert.match(tokens, /family_id[^,]*REFERENCES\s+oauth_token_families/i)
  assert.match(tokens, /expires_at\s+TIMESTAMPTZ\s+NOT NULL/i)
  assert.match(tokens, /used_at\s+TIMESTAMPTZ/i)
  assert.match(tokens, /revoked_at\s+TIMESTAMPTZ/i)
})

test('the additive sign-in schema leaves the original resident key column intact', () => {
  const residents = table('residents')

  assert.match(residents, /secret_hash\s+TEXT\s+NOT NULL\s+UNIQUE/i)
  assert.match(residents, /CHECK\s*\(secret_hash\s*~\s*'\^\[0-9a-f\]\{64\}\$'\)/i)
})

test('OAuth counters can reach every configured throttle without a database error', () => {
  const limits = table('oauth_rate_limits')
  const maximum = Number(/used\s+SMALLINT[^,]*BETWEEN\s+1\s+AND\s+(\d+)/i.exec(limits)?.[1])
  assert.ok(maximum >= 300, 'database counter ceiling must cover the largest route throttle')
})
