import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { splitSqlStatements } from '../scripts/migrate.ts'

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8')
const oauthStore = readFileSync(new URL('../src/oauth-store.ts', import.meta.url), 'utf8')
const retentionMigration = readFileSync(
  new URL('../db/migrations/20260818_signin_retention.sql', import.meta.url),
  'utf8',
)
const retentionRunbook = readFileSync(
  new URL('../docs/runbooks/SIGNIN_RETENTION.md', import.meta.url),
  'utf8',
)

const throttleStart = oauthStore.indexOf('export async function consumeOAuthRateLimit')
const throttleEnd = oauthStore.indexOf('export const postgresOAuthStore', throttleStart)
assert.ok(throttleStart >= 0 && throttleEnd > throttleStart, 'missing throttle function boundary')
const throttleSource = oauthStore.slice(throttleStart, throttleEnd)

function cte(name: string): string {
  const pattern = new RegExp(`\\)?,?\\s*${name}\\s+AS(?:\\s+MATERIALIZED)?\\s*\\(`, 'i')
  const start = throttleSource.search(pattern)
  assert.ok(start >= 0, `missing ${name} CTE in the throttle statement`)
  const following = throttleSource.slice(start)
  const nextCte = following.slice(1).search(/\),\s*[a-z_]+\s+AS(?:\s+MATERIALIZED)?\s*\(/i)
  return nextCte >= 0 ? following.slice(0, nextCte + 2) : following
}

const retentionWindow = /const SIGNIN_RETENTION_WINDOW = '([^']+)'/.exec(oauthStore)?.[1]
const retentionBatch = Number(/const SIGNIN_RETENTION_BATCH = (\d+)/.exec(oauthStore)?.[1])

test('every expired sign-in record type is deleted inside the shared OAuth throttle statement', () => {
  assert.equal(
    throttleSource.match(/await\s+sql`/g)?.length ?? 0,
    1,
    'the throttle must remain one PostgreSQL statement so pruning rides every OAuth request',
  )
  for (const table of [
    'oauth_authorization_codes',
    'oauth_authorization_requests',
    'oauth_tokens',
    'oauth_token_families',
  ]) {
    assert.match(
      throttleSource,
      new RegExp(`DELETE FROM ${table}\\b`, 'i'),
      `${table} rows must be pruned on sign-in traffic`,
    )
  }
})

test('retention deletes only rows past the documented forensic window, never merely expired ones', () => {
  assert.equal(retentionWindow, '30 days')
  const guards = throttleSource.match(
    /expires_at <= now\(\) - \$\{SIGNIN_RETENTION_WINDOW\}::interval/g,
  )
  assert.equal(guards?.length, 4, 'each record type must wait out the full retention window')
  assert.doesNotMatch(
    throttleSource,
    /expires_at <= now\(\)\s*(?:ORDER|LIMIT|\))/i,
    'a bare expiry comparison would delete records still inside the forensic window',
  )
})

test('retention work is bounded so one request never performs unbounded deletion', () => {
  assert.ok(Number.isInteger(retentionBatch) && retentionBatch > 0)
  const bounds = throttleSource.match(/LIMIT \$\{SIGNIN_RETENTION_BATCH\}/g)
  assert.equal(bounds?.length, 4, 'each retention batch must carry its own LIMIT')
})

test('token rows are deleted only by their family clock so reuse detection works all window long', () => {
  const doomedTokens = cte('retired_tokens')
  assert.match(doomedTokens, /family\.expires_at <= now\(\)/i)
  assert.doesNotMatch(
    doomedTokens,
    /token\.(expires_at|used_at|revoked_at)/i,
    'an individually expired, used, or revoked token must survive until family retention',
  )

  const reuseDetection = oauthStore.slice(
    oauthStore.indexOf('async function revokeReusedRefreshToken'),
    oauthStore.indexOf('export async function rotateRefreshToken'),
  )
  assert.match(
    reuseDetection,
    /used_at IS NOT NULL/i,
    'reuse detection still depends on retained used-token rows',
  )
})

test('token deletion removes the newest rotation links first so the refresh chain never dangles', () => {
  assert.match(cte('retired_tokens'), /ORDER BY token\.id DESC/i)
})

test('a family row is deleted only after every one of its token rows is gone', () => {
  const doomedFamilies = cte('retired_families')
  assert.match(doomedFamilies, /NOT EXISTS\s*\(\s*SELECT 1 FROM oauth_tokens/i)
  assert.match(doomedFamilies, /token\.id NOT IN \(SELECT id FROM retired_tokens\)/i)
  assert.ok(
    throttleSource.indexOf('pruned_tokens') < throttleSource.indexOf('pruned_families'),
    'tokens must be deleted before their family to satisfy the RESTRICT foreign key',
  )
})

test('a request row is deleted only when no authorization code still references it', () => {
  const doomedRequests = cte('retired_requests')
  assert.match(doomedRequests, /NOT EXISTS\s*\(\s*SELECT 1 FROM oauth_authorization_codes/i)
  assert.match(doomedRequests, /code\.id NOT IN \(SELECT id FROM retired_codes\)/i)
  assert.ok(
    throttleSource.indexOf('pruned_codes') < throttleSource.indexOf('pruned_requests'),
    'codes must be deleted before their request to satisfy the RESTRICT foreign key',
  )
})

test('identity records stay outside the sign-in retention deletes', () => {
  for (const identityTable of [
    'residents',
    'resident_recovery_codes',
    'resident_key_rotations',
    'pending_resident_registrations',
  ]) {
    assert.doesNotMatch(
      throttleSource,
      new RegExp(`DELETE FROM ${identityTable}\\b`, 'i'),
      `${identityTable} is identity, not a sign-in record`,
    )
  }
})

test('retention scans are served by additive expiry indexes in both the fresh schema and the release migration', () => {
  const normalize = (statement: string) =>
    statement.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').trim()
  const schemaStatements = new Set(splitSqlStatements(schema).map(normalize))
  const migrationStatements = splitSqlStatements(retentionMigration).map(normalize)

  for (const index of [
    'CREATE INDEX IF NOT EXISTS oauth_authorization_requests_retention ON oauth_authorization_requests (expires_at, id)',
    'CREATE INDEX IF NOT EXISTS oauth_authorization_codes_retention ON oauth_authorization_codes (expires_at, id)',
    'CREATE INDEX IF NOT EXISTS oauth_token_families_retention ON oauth_token_families (expires_at, id)',
  ]) {
    assert.ok(schemaStatements.has(index), `db/schema.sql is missing: ${index}`)
    assert.ok(migrationStatements.includes(index), `retention migration is missing: ${index}`)
  }
})

test('the retention migration is one transaction with enforced wait and work limits', () => {
  assert.match(retentionMigration, /^\s*BEGIN\s*;/i)
  assert.match(retentionMigration, /SET\s+LOCAL\s+lock_timeout\s*=/i)
  assert.match(retentionMigration, /SET\s+LOCAL\s+statement_timeout\s*=/i)
  assert.match(retentionMigration, /COMMIT\s*;\s*$/i)
})

test('the retention runbook and the implementation state the same window and mechanism', () => {
  assert.ok(retentionWindow, 'the store must declare its retention window')
  assert.match(retentionRunbook, new RegExp(retentionWindow!))
  for (const table of [
    'oauth_authorization_requests',
    'oauth_authorization_codes',
    'oauth_token_families',
    'oauth_tokens',
  ]) {
    assert.match(retentionRunbook, new RegExp(`\\b${table}\\b`))
  }
  assert.match(retentionRunbook, /consumeOAuthRateLimit/)
  assert.match(retentionRunbook, /BACKUP_RESTORE\.md/)

  const documentationMap = readFileSync(
    new URL('../docs/README.md', import.meta.url),
    'utf8',
  )
  assert.match(documentationMap, /runbooks\/SIGNIN_RETENTION\.md/)
})
