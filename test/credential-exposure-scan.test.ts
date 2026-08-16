import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  LOCAL_SCAN_ACKNOWLEDGEMENT,
  PREVIEW_SCAN_ACKNOWLEDGEMENT,
  parseCredentialScanArgs,
  runCredentialExposureScan,
  safeCredentialScanError,
  type CredentialScanClient,
} from '../scripts/credential-exposure-scan.ts'

const rootKey = `1f3d9_sk_${'a1'.repeat(24)}`
const refreshToken = `1f3d9_rt_${'b2'.repeat(32)}`
const partialAccessToken = `1f3d9_at_${'c3'.repeat(6)}`
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

test('credential scan arguments require one explicit target and expected database', () => {
  assert.deepEqual(parseCredentialScanArgs(['--target', 'production', '--database', 'city']), {
    target: 'production',
    expectedDatabase: 'city',
  })
  for (const args of [
    [],
    ['--target', 'local'],
    ['--database', 'city'],
    ['--target', 'sideways', '--database', 'city'],
    ['--target', 'local', '--database', '../city'],
    ['--target', 'local', '--target', 'preview', '--database', 'city'],
  ]) assert.throws(() => parseCredentialScanArgs(args), /target|database|argument|duplicate/i)
})

test('the read-only scan reports resident IDs and counts without exposing matched content', async () => {
  const exposureRows = Object.freeze([
    Object.freeze({ publishing_resident_id: 8, content: `historical ${refreshToken}` }),
    Object.freeze({ publishing_resident_id: 7, content: `historical ${rootKey}` }),
    Object.freeze({ publishing_resident_id: null, content: `partial ${partialAccessToken}` }),
  ])
  const originalRows = structuredClone(exposureRows)
  const statements: string[] = []
  let connected = 0
  let ended = 0
  const client: CredentialScanClient = {
    async connect() { connected += 1 },
    async query(text) {
      statements.push(text)
      if (/public_credential_exposures/i.test(text)) return { rows: [...exposureRows] }
      if (/credential_identity_matches/i.test(text)) {
        return { rows: [
          {
            credential_hash: digest(rootKey), credential_kind: 'resident_key',
            resident_id: 9, live: true,
          },
          {
            credential_hash: digest(refreshToken), credential_kind: 'oauth_refresh_token',
            resident_id: 10, live: false,
          },
        ] }
      }
      return { rows: [] }
    },
    async end() { ended += 1 },
  }
  const logLines: string[] = []

  const result = await runCredentialExposureScan({
    argv: ['--target', 'local', '--database', 'city'],
    environment: {
      CONFIRM_LOCAL_CREDENTIAL_SCAN: LOCAL_SCAN_ACKNOWLEDGEMENT,
      LOCAL_DATABASE_URL_UNPOOLED: 'postgres://operator:password@127.0.0.1:5432/city',
    },
    createClient: () => client,
    log: line => logLines.push(line),
  })

  assert.equal(connected, 1)
  assert.equal(ended, 1)
  assert.deepEqual(exposureRows, originalRows)
  assert.deepEqual(result.affected_resident_ids, [7, 8])
  assert.deepEqual(result.credential_owner_resident_ids, [9, 10])
  assert.deepEqual(result.live_credential_owner_resident_ids, [9])
  assert.deepEqual(result.counts, {
    public_fields: 3,
    exact_credentials: 2,
    partial_shapes: 1,
    live_credentials: 1,
    inactive_credentials: 1,
    unresolved_credentials: 0,
    resident_key: 1,
    oauth_access_token: 0,
    oauth_refresh_token: 1,
    oauth_authorization_code: 0,
  })
  assert.match(statements.join('\n'), /BEGIN[^;]*READ ONLY/i)
  assert.match(statements.join('\n'), /statement_timeout/i)
  assert.match(statements.join('\n'), /lock_timeout/i)
  assert.match(statements.join('\n'), /COMMIT/i)
  assert.equal(statements.some(statement => /\b(?:insert|update|delete|alter|drop|create)\b/i.test(statement)), false)

  const publicOutput = JSON.stringify({ result, logLines })
  for (const forbidden of [rootKey, refreshToken, partialAccessToken, 'password@', 'postgres://']) {
    assert.equal(publicOutput.includes(forbidden), false, forbidden)
  }
  assert.doesNotMatch(publicOutput, /credential_hash|content|surface|row_id|handle|body/i)
})

test('wrong or unproven targets fail before a database client or Neon request exists', async () => {
  let clients = 0
  let fetches = 0
  await assert.rejects(runCredentialExposureScan({
    argv: ['--target', 'production', '--database', 'city'],
    environment: {
      DATABASE_URL: 'postgres://generic:password@production.invalid/city',
      PRODUCTION_DATABASE_URL_UNPOOLED:
        'postgres://operator:password@ep-production.us-east-2.aws.neon.tech/city?sslmode=require',
    },
    createClient: () => {
      clients += 1
      throw new Error('must not create client')
    },
    fetcher: (async () => {
      fetches += 1
      throw new Error('must not fetch')
    }) as typeof fetch,
    log: () => {},
  }), /CONFIRM_PRODUCTION_CREDENTIAL_SCAN/i)
  assert.equal(clients, 0)
  assert.equal(fetches, 0)
})

test('a mismatched Neon endpoint is rejected before the scan client is created', async () => {
  let clients = 0
  let fetches = 0
  await assert.rejects(runCredentialExposureScan({
    argv: ['--target', 'preview', '--database', 'city'],
    environment: {
      CONFIRM_PREVIEW_CREDENTIAL_SCAN: PREVIEW_SCAN_ACKNOWLEDGEMENT,
      PREVIEW_DATABASE_URL_UNPOOLED:
        'postgres://operator:password@ep-preview.us-east-2.aws.neon.tech/city?sslmode=require',
      NEON_API_KEY: 'test-api-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
    },
    fetcher: (async () => {
      fetches += 1
      return new Response(JSON.stringify({
        endpoints: [{
          id: 'ep-wrong',
          host: 'ep-wrong.us-east-2.aws.neon.tech',
          project_id: 'project-one',
          branch_id: 'branch-preview',
          type: 'read_write',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch,
    createClient: () => {
      clients += 1
      throw new Error('must not create client')
    },
    log: () => {},
  }), /prove the preview database target/i)
  assert.equal(fetches, 1)
  assert.equal(clients, 0)
})

test('scan failures roll back and redact credentials and database URLs', async () => {
  const statements: string[] = []
  const client: CredentialScanClient = {
    async connect() {},
    async query(text) {
      statements.push(text)
      if (/public_credential_exposures/i.test(text)) {
        throw new Error(`failed near ${rootKey} at postgres://operator:password@127.0.0.1/city`)
      }
      return { rows: [] }
    },
    async end() {},
  }

  await assert.rejects(runCredentialExposureScan({
    argv: ['--target', 'local', '--database', 'city'],
    environment: {
      CONFIRM_LOCAL_CREDENTIAL_SCAN: LOCAL_SCAN_ACKNOWLEDGEMENT,
      LOCAL_DATABASE_URL_UNPOOLED: 'postgres://operator:password@127.0.0.1/city',
    },
    createClient: () => client,
    log: () => {},
  }), error => {
    const message = safeCredentialScanError(error)
    assert.doesNotMatch(message, new RegExp(rootKey, 'i'))
    assert.doesNotMatch(message, /postgres:\/\//i)
    assert.doesNotMatch(message, /password@/i)
    return true
  })
  assert.match(statements.join('\n'), /ROLLBACK/i)
})
