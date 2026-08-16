import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  LOCAL_SCAN_ACKNOWLEDGEMENT,
  PREVIEW_SCAN_ACKNOWLEDGEMENT,
  PUBLIC_EXPOSURE_SQL,
  parseCredentialScanArgs,
  runCredentialExposureScan,
  safeCredentialScanError,
  type CredentialScanClient,
} from '../scripts/credential-exposure-scan.ts'

const rootKey = `1f3d9_sk_${'a1'.repeat(24)}`
const accessToken = `1f3d9_at_${'b2'.repeat(32)}`
const refreshToken = `1f3d9_rt_${'b2'.repeat(32)}`
const authorizationCode = `1f3d9_ac_${'d4'.repeat(32)}`
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

test('the scan allowlist stays limited to public record surfaces', () => {
  for (const table of [
    'FROM public.places',
    'FROM public.traits',
    'FROM public.kinds',
    'FROM public.things',
    'FROM public.notes',
    'FROM public.agreements',
    'FROM public.active_labels',
    'FROM public.moderation_actions',
    'FROM public.events',
  ]) assert.match(PUBLIC_EXPOSURE_SQL, new RegExp(table.replaceAll(' ', '\\s+'), 'i'))

  for (const privateTable of [
    'FROM public.flags',
    'FROM public.action_runs',
    'FROM public.action_resolutions',
    'FROM public.pending_effects',
    'FROM public.effect_resolutions',
  ]) assert.doesNotMatch(PUBLIC_EXPOSURE_SQL, new RegExp(privateTable.replaceAll(' ', '\\s+'), 'i'))

  assert.doesNotMatch(PUBLIC_EXPOSURE_SQL, /\b(?:FROM|JOIN)\s+(?!public\.)[a-z_]+/i)
  assert.doesNotMatch(PUBLIC_EXPOSURE_SQL, /publishing_resident_id/i)
})

test('the read-only scan reports resident IDs and counts without exposing matched content', async () => {
  const exposureRows = Object.freeze([
    Object.freeze({ associated_resident_id: 8, content: `historical ${refreshToken}` }),
    Object.freeze({ associated_resident_id: 7, content: `historical ${rootKey}` }),
    Object.freeze({ associated_resident_id: 11, content: `historical ${accessToken}` }),
    Object.freeze({ associated_resident_id: 12, content: `historical ${authorizationCode}` }),
    Object.freeze({ associated_resident_id: null, content: `partial ${partialAccessToken}` }),
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
          {
            credential_hash: digest(accessToken), credential_kind: 'oauth_access_token',
            resident_id: 11, live: true,
          },
          {
            credential_hash: digest(authorizationCode), credential_kind: 'oauth_authorization_code',
            resident_id: 12, live: false,
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
  assert.deepEqual(result.associated_resident_ids, [7, 8, 11, 12])
  assert.deepEqual(result.credential_owner_resident_ids, [9, 10, 11, 12])
  assert.deepEqual(result.live_credential_owner_resident_ids, [9, 11])
  assert.deepEqual(result.counts, {
    public_fields: 5,
    exact_credentials: 4,
    partial_shapes: 1,
    live_credentials: 2,
    inactive_credentials: 2,
    unresolved_credentials: 0,
    resident_key: 1,
    oauth_access_token: 1,
    oauth_refresh_token: 1,
    oauth_authorization_code: 1,
  })
  assert.match(statements.join('\n'), /BEGIN[^;]*READ ONLY/i)
  assert.match(statements.join('\n'), /statement_timeout/i)
  assert.match(statements.join('\n'), /lock_timeout/i)
  assert.match(statements.join('\n'), /COMMIT/i)
  assert.equal(statements.some(statement => /\b(?:insert|update|delete|alter|drop|create)\b/i.test(statement)), false)

  const publicOutput = JSON.stringify({ result, logLines })
  for (const forbidden of [
    rootKey, accessToken, refreshToken, authorizationCode, partialAccessToken, 'password@', 'postgres://',
  ]) {
    assert.equal(publicOutput.includes(forbidden), false, forbidden)
  }
  assert.doesNotMatch(publicOutput, /credential_hash|content|surface|row_id|handle|body/i)
  assert.match(statements.join('\n'), /SET LOCAL search_path = pg_catalog, public/i)
  assert.doesNotMatch(statements.join('\n'), /\b(?:FROM|JOIN)\s+(?!public\.)[a-z_]+/i)
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

test('the scanner ignores a generic database URL even after acknowledgement', async () => {
  let clients = 0
  let fetches = 0
  await assert.rejects(runCredentialExposureScan({
    argv: ['--target', 'preview', '--database', 'city'],
    environment: {
      CONFIRM_PREVIEW_CREDENTIAL_SCAN: PREVIEW_SCAN_ACKNOWLEDGEMENT,
      DATABASE_URL: 'postgres://generic:password@ep-preview.us-east-2.aws.neon.tech/city',
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
  }), /PREVIEW_DATABASE_URL_UNPOOLED not set/i)
  assert.equal(clients, 0)
  assert.equal(fetches, 0)
})

test('database, transport, and branch mismatches fail before target proof or connection', async () => {
  const basePreview = {
    CONFIRM_PREVIEW_CREDENTIAL_SCAN: PREVIEW_SCAN_ACKNOWLEDGEMENT,
    PREVIEW_DATABASE_URL_UNPOOLED:
      'postgres://operator:password@ep-preview.us-east-2.aws.neon.tech/city?sslmode=require',
    NEON_API_KEY: 'test-api-key',
    NEON_PROJECT_ID: 'project-one',
    NEON_PREVIEW_BRANCH_ID: 'branch-preview',
    NEON_PRODUCTION_BRANCH_ID: 'branch-production',
  }
  const cases = [
    {
      argv: ['--target', 'local', '--database', 'city'],
      environment: {
        CONFIRM_LOCAL_CREDENTIAL_SCAN: LOCAL_SCAN_ACKNOWLEDGEMENT,
        LOCAL_DATABASE_URL_UNPOOLED: 'postgres://operator:password@127.0.0.1:5432/wrong',
      },
      error: /not expected database/i,
    },
    {
      argv: ['--target', 'local', '--database', 'city'],
      environment: {
        CONFIRM_LOCAL_CREDENTIAL_SCAN: LOCAL_SCAN_ACKNOWLEDGEMENT,
        LOCAL_DATABASE_URL_UNPOOLED: 'postgres://operator:password@database.invalid:5432/city',
      },
      error: /loopback/i,
    },
    {
      argv: ['--target', 'preview', '--database', 'city'],
      environment: {
        ...basePreview,
        PREVIEW_DATABASE_URL_UNPOOLED:
          'postgres://operator:password@ep-preview.us-east-2.aws.neon.tech/city',
      },
      error: /TLS/i,
    },
    {
      argv: ['--target', 'preview', '--database', 'city'],
      environment: {
        ...basePreview,
        PREVIEW_DATABASE_URL_UNPOOLED:
          'postgres://operator:password@ep-preview.us-east-2.aws.neon.tech:6543/city?sslmode=require',
      },
      error: /port 5432/i,
    },
    {
      argv: ['--target', 'preview', '--database', 'city'],
      environment: {
        ...basePreview,
        NEON_PREVIEW_BRANCH_ID: 'branch-production',
      },
      error: /must not be the production branch/i,
    },
  ] as const

  for (const fixture of cases) {
    let clients = 0
    let fetches = 0
    await assert.rejects(runCredentialExposureScan({
      argv: fixture.argv,
      environment: fixture.environment,
      createClient: () => {
        clients += 1
        throw new Error('must not create client')
      },
      fetcher: (async () => {
        fetches += 1
        throw new Error('must not fetch')
      }) as typeof fetch,
      log: () => {},
    }), fixture.error)
    assert.equal(clients, 0)
    assert.equal(fetches, 0)
  }
})

test('a matching Neon proof happens before the first database client exists', async () => {
  const events: string[] = []
  const databaseUrl =
    'postgres://operator:password@ep-preview.us-east-2.aws.neon.tech/city?sslmode=require'
  const client: CredentialScanClient = {
    async connect() { events.push('connect') },
    async query(text) {
      events.push(/public_credential_exposures/i.test(text) ? 'scan' : 'query')
      return { rows: [] }
    },
    async end() { events.push('end') },
  }

  const result = await runCredentialExposureScan({
    argv: ['--target', 'preview', '--database', 'city'],
    environment: {
      CONFIRM_PREVIEW_CREDENTIAL_SCAN: PREVIEW_SCAN_ACKNOWLEDGEMENT,
      DATABASE_URL: 'postgres://ignored:password@wrong.invalid/wrong',
      PREVIEW_DATABASE_URL_UNPOOLED: databaseUrl,
      NEON_API_KEY: 'test-api-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
    },
    fetcher: (async (input, init) => {
      events.push('proof')
      assert.match(String(input), /projects\/project-one\/branches\/branch-preview\/endpoints$/)
      assert.equal(init?.method, 'GET')
      return new Response(JSON.stringify({
        endpoints: [{
          id: 'ep-preview',
          host: 'ep-preview.us-east-2.aws.neon.tech',
          project_id: 'project-one',
          branch_id: 'branch-preview',
          type: 'read_write',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch,
    createClient: value => {
      events.push('client')
      assert.equal(value, databaseUrl)
      return client
    },
    log: () => {},
  })

  assert.deepEqual(events.slice(0, 3), ['proof', 'client', 'connect'])
  assert.equal(result.target.mode, 'preview')
  assert.equal(result.target.database, 'city')
  assert.equal(result.target.project_id, 'project-one')
  assert.equal(result.target.branch_id, 'branch-preview')
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
