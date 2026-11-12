import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { PoolClient } from 'pg'
import {
  database,
  resetDatabase,
  sha256,
  type OAuthStore,
} from '../../helpers/oauth-postgres-fixtures/postgres.ts'
import { THROTTLE_STATEMENT_BEFORE } from './retention-statement-before.ts'

// The same values src/oauth-store.ts passes (SIGNIN_RETENTION_WINDOW and
// SIGNIN_RETENTION_BATCH); test/oauth-retention.test.ts pins them there.
const RETENTION_WINDOW = '30 days'
const RETENTION_BATCH = 50

// Regression size: big enough that reading the whole token table cannot hide
// inside a bound, small enough to seed in a few seconds on a CI runner.
const LIVE_FAMILIES = 60
const TOKENS_PER_LIVE_FAMILY = 700
const RETIRED_FAMILIES = 3
const TOKENS_PER_RETIRED_FAMILY = 40
const TOKEN_ROWS_READ_BOUND = 1_000

const EQUIVALENCE_PASSES = 6

interface FamilySeed {
  id: number
  endsIn: string
  tokens: number
  revoked?: boolean
}

interface RequestSeed {
  id: number
  endsIn: string
  codeEndsIn?: string
  recoveryCodes?: boolean
}

interface RateLimitSeed {
  label: string
  windowShift: string
  used: number
}

interface ThrottleInput {
  bucketHash: string
  attemptKind: 'refresh'
  maximum: number
}

interface PlanNode {
  'Node Type': string
  'Relation Name'?: string
  'Actual Rows'?: number
  'Actual Loops'?: number
  'Rows Removed by Filter'?: number
  'Rows Removed by Index Recheck'?: number
  Plans?: PlanNode[]
}

interface SignInSnapshot {
  tokens: string
  families: string
  codes: string
  requests: string
  recovery_codes: string
  rate_limits: string
}

interface PassResult {
  admitted: boolean
  snapshot: SignInSnapshot
}

type Run = (client: PoolClient, input: ThrottleInput) => Promise<boolean>

function hashOf(label: string): string {
  return sha256(`retention-walk:${label}`)
}

async function inRolledBackTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  assert.ok(database)
  const client = await database.connect()
  try {
    await client.query('BEGIN')
    return await work(client)
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

type StoreQuery = (text: string, values: unknown[]) => Promise<{ rows: unknown[] }>

// Points the store's single SQL client at the given handler for one piece of
// work, so seeds, the store's statement and the checks share one transaction
// and therefore one now().
async function withStoreQuery<T>(handler: StoreQuery, work: () => Promise<T>): Promise<T> {
  assert.ok(database)
  const pool = database
  const original = pool.query
  pool.query = handler as typeof pool.query
  try {
    return await work()
  } finally {
    pool.query = original
  }
}

async function seedFamilies(client: PoolClient, families: readonly FamilySeed[], firstTokenId: number) {
  await client.query(
    `INSERT INTO oauth_token_families
       (id, resident_id, client_id, resource, scope, expires_at, created_at, revoked_at, revoke_reason)
     SELECT seed.id, 1, 'retention-walk-client', 'https://city.example.test/mcp/connect',
       'city:resident', now() + seed.ends_in, now() + seed.ends_in - interval '30 days',
       CASE WHEN seed.revoked THEN now() + seed.ends_in - interval '20 days' END,
       CASE WHEN seed.revoked THEN 'refresh token reuse' END
     FROM unnest($1::bigint[], $2::interval[], $3::boolean[]) AS seed(id, ends_in, revoked)`,
    [families.map(f => f.id), families.map(f => f.endsIn), families.map(f => f.revoked ?? false)],
  )
  // Token pairs spread over each family's life and numbered in time order, so
  // ids rise with created_at and the families' rows interleave as in production.
  await client.query(
    `WITH family AS (
       SELECT seed.id, seed.tokens, family.created_at AS starts, family.expires_at AS ends,
         least(family.expires_at, now() - interval '1 minute') AS stops
       FROM unnest($1::bigint[], $2::integer[]) AS seed(id, tokens)
       JOIN oauth_token_families family ON family.id = seed.id
     ), planned AS (
       SELECT family.id AS family_id, family.tokens, family.ends, n,
         family.starts + (family.stops - family.starts)
           * (((n / 2) * 2)::double precision / family.tokens) AS at
       FROM family CROSS JOIN LATERAL generate_series(0, family.tokens - 1) n
     )
     INSERT INTO oauth_tokens
       (id, token_hash, token_type, family_id, expires_at, used_at, revoked_at, created_at)
     SELECT $3::bigint + row_number() OVER (ORDER BY at, family_id, n),
       encode(sha256(convert_to('retention-walk-token:' || family_id || ':' || n, 'UTF8')), 'hex'),
       CASE WHEN n % 2 = 0 THEN 'access' ELSE 'refresh' END,
       family_id,
       CASE WHEN n % 2 = 0 THEN at + interval '10 minutes' ELSE ends END,
       CASE WHEN n % 2 = 1 AND n < tokens - 2 THEN at + interval '1 minute' END,
       CASE WHEN n % 9 = 4 THEN at + interval '1 minute' END,
       at
     FROM planned`,
    [families.map(f => f.id), families.map(f => f.tokens), firstTokenId - 1],
  )
  await client.query(
    `UPDATE oauth_tokens token SET rotated_from_token_id = link.previous
     FROM (
       SELECT id, lag(id) OVER (PARTITION BY family_id ORDER BY id) AS previous
       FROM oauth_tokens WHERE token_type = 'refresh' AND family_id = ANY($1::bigint[])
     ) link
     WHERE token.id = link.id AND link.previous IS NOT NULL`,
    [families.map(f => f.id)],
  )
}

async function seedRequests(client: PoolClient, requests: readonly RequestSeed[]) {
  await client.query(
    `INSERT INTO oauth_authorization_requests
       (id, session_hash, csrf_hash, client_id, redirect_uri, resource, scope, state,
        code_challenge, expires_at, created_at)
     SELECT seed.id,
       encode(sha256(convert_to('retention-walk-session:' || seed.id, 'UTF8')), 'hex'),
       encode(sha256(convert_to('retention-walk-csrf:' || seed.id, 'UTF8')), 'hex'),
       'retention-walk-client', 'https://client.example.test/oauth/callback',
       'https://city.example.test/mcp/connect', 'city:resident', 'retention-walk-state',
       repeat('A', 43), now() + seed.ends_in, now() + seed.ends_in - interval '15 minutes'
     FROM unnest($1::bigint[], $2::interval[]) AS seed(id, ends_in)`,
    [requests.map(r => r.id), requests.map(r => r.endsIn)],
  )
  const coded = requests.filter(r => r.codeEndsIn !== undefined)
  await client.query(
    `INSERT INTO oauth_authorization_codes
       (id, request_id, code_hash, resident_id, client_id, redirect_uri, resource, scope,
        code_challenge, expires_at, created_at)
     SELECT seed.request_id, seed.request_id,
       encode(sha256(convert_to('retention-walk-code:' || seed.request_id, 'UTF8')), 'hex'),
       1, 'retention-walk-client', 'https://client.example.test/oauth/callback',
       'https://city.example.test/mcp/connect', 'city:resident', repeat('A', 43),
       now() + seed.ends_in, now() + seed.ends_in - interval '5 minutes'
     FROM unnest($1::bigint[], $2::interval[]) AS seed(request_id, ends_in)`,
    [coded.map(r => r.id), coded.map(r => r.codeEndsIn)],
  )
  await client.query(
    `INSERT INTO oauth_authorization_request_recovery_codes (request_id, ordinal, code_hash)
     SELECT request_id, ordinal,
       encode(sha256(convert_to('retention-walk-recovery:' || request_id || ':' || ordinal, 'UTF8')), 'hex')
     FROM unnest($1::bigint[]) request_id CROSS JOIN generate_series(1, 8) ordinal`,
    [requests.filter(r => r.recoveryCodes).map(r => r.id)],
  )
}

async function seedRateLimits(client: PoolClient, rows: readonly RateLimitSeed[]) {
  await client.query(
    `INSERT INTO oauth_rate_limits (bucket_hash, attempt_kind, window_start, used)
     SELECT encode(sha256(convert_to('retention-walk-bucket:' || seed.label, 'UTF8')), 'hex'),
       'refresh', date_trunc('hour', now(), 'UTC') + seed.window_shift, seed.used
     FROM unnest($1::text[], $2::interval[], $3::smallint[]) AS seed(label, window_shift, used)`,
    [rows.map(r => r.label), rows.map(r => r.windowShift), rows.map(r => r.used)],
  )
}

// Every row of every table the throttle statement touches, by key.
async function signInSnapshot(client: PoolClient): Promise<SignInSnapshot> {
  const result = await client.query<SignInSnapshot>(
    `SELECT
       (SELECT coalesce(string_agg(id::text, ',' ORDER BY id), '') FROM oauth_tokens) AS tokens,
       (SELECT coalesce(string_agg(id::text, ',' ORDER BY id), '') FROM oauth_token_families) AS families,
       (SELECT coalesce(string_agg(id::text, ',' ORDER BY id), '') FROM oauth_authorization_codes) AS codes,
       (SELECT coalesce(string_agg(id::text, ',' ORDER BY id), '') FROM oauth_authorization_requests) AS requests,
       (SELECT coalesce(string_agg(request_id || ':' || ordinal, ',' ORDER BY request_id, ordinal), '')
          FROM oauth_authorization_request_recovery_codes) AS recovery_codes,
       (SELECT coalesce(string_agg(
          bucket_hash || ':' || attempt_kind || ':'
            || (window_start - date_trunc('hour', now(), 'UTC'))::text || ':' || used,
          ',' ORDER BY bucket_hash, attempt_kind, window_start), '')
          FROM oauth_rate_limits) AS rate_limits`,
  )
  return result.rows[0]!
}

const runBefore: Run = async (client, input) => {
  const result = await client.query<{ admitted: boolean; retry_after_seconds: number }>(
    THROTTLE_STATEMENT_BEFORE,
    [RETENTION_WINDOW, RETENTION_BATCH, input.bucketHash, input.attemptKind, input.maximum],
  )
  assert.equal(result.rowCount, 1)
  return result.rows[0]!.admitted
}

function runCurrent(store: OAuthStore): Run {
  return async (client, input) =>
    withStoreQuery(
      (text, values) => client.query(text, values),
      async () => (await store.consumeOAuthRateLimit(input)).admitted,
    )
}

// Rows the plan read from oauth_tokens, whatever path the planner chose.
function tokenRowsRead(node: PlanNode): number {
  const own = node['Relation Name'] === 'oauth_tokens' && node['Node Type'] !== 'ModifyTable'
    ? ((node['Actual Rows'] ?? 0)
        + (node['Rows Removed by Filter'] ?? 0)
        + (node['Rows Removed by Index Recheck'] ?? 0)) * (node['Actual Loops'] ?? 1)
    : 0
  return own + (node.Plans ?? []).reduce((sum, child) => sum + tokenRowsRead(child), 0)
}

async function explainCurrentStatement(
  store: OAuthStore,
  client: PoolClient,
  input: ThrottleInput,
): Promise<PlanNode> {
  let plan: PlanNode | null = null
  const explain: StoreQuery = async (text, values) => {
    const explained = await client.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`,
      values,
    )
    plan = explained.rows[0]!['QUERY PLAN'][0]!.Plan
    return { rows: [{ admitted: true, retry_after_seconds: 60 }] }
  }
  await withStoreQuery(explain, () => store.consumeOAuthRateLimit(input))
  assert.ok(plan, 'the throttle statement was not explained')
  return plan
}

function equivalenceFamilies(): FamilySeed[] {
  return [
    { id: 1, endsIn: '20 days', tokens: 40 },
    { id: 2, endsIn: '5 days', tokens: 12, revoked: true },
    { id: 3, endsIn: '-29 days', tokens: 30 },
    { id: 4, endsIn: '-29 days -23:59:59.999999', tokens: 20 },
    { id: 5, endsIn: '-30 days', tokens: 20 },
    { id: 6, endsIn: '-31 days', tokens: 70 },
    { id: 7, endsIn: '-33 days', tokens: 45, revoked: true },
    { id: 8, endsIn: '-31 days -12:00:00', tokens: 0 },
    { id: 9, endsIn: '-10 days', tokens: 16, revoked: true },
    { id: 10, endsIn: '-45 days', tokens: 25 },
  ]
}

function equivalenceRequests(): RequestSeed[] {
  const tied = Array.from({ length: 60 }, (_, index) => ({
    id: 8 + index,
    endsIn: '-35 days',
    codeEndsIn: '-35 days',
  }))
  return [
    { id: 1, endsIn: '-31 days', codeEndsIn: '-31 days' },
    { id: 2, endsIn: '-31 days', codeEndsIn: '-29 days' },
    { id: 3, endsIn: '-30 days' },
    { id: 4, endsIn: '-29 days -23:59:59.999999' },
    { id: 5, endsIn: '-40 days', recoveryCodes: true },
    { id: 6, endsIn: '-1 hour', codeEndsIn: '-1 hour', recoveryCodes: true },
    { id: 7, endsIn: '-30 days', codeEndsIn: '-30 days' },
    ...tied,
  ]
}

const EQUIVALENCE_RATE_LIMITS: readonly RateLimitSeed[] = [
  { label: 'stale', windowShift: '-25 hours', used: 3 },
  { label: 'exactly-a-day', windowShift: '-24 hours', used: 2 },
  { label: 'recent', windowShift: '-1 hour', used: 1 },
  { label: 'target', windowShift: '0 hours', used: 2 },
]

async function runEquivalencePasses(run: Run): Promise<PassResult[]> {
  return inRolledBackTransaction(async client => {
    await seedFamilies(client, equivalenceFamilies(), 1)
    await seedRequests(client, equivalenceRequests())
    await seedRateLimits(client, EQUIVALENCE_RATE_LIMITS)
    const input: ThrottleInput = {
      bucketHash: sha256('retention-walk-bucket:target'),
      attemptKind: 'refresh',
      maximum: 3,
    }
    const passes: PassResult[] = []
    for (let pass = 0; pass < EQUIVALENCE_PASSES; pass += 1) {
      const admitted = await run(client, input)
      passes.push({ admitted, snapshot: await signInSnapshot(client) })
    }
    return passes
  })
}

function idsOf(list: string): number[] {
  return list === '' ? [] : list.split(',').map(Number)
}

export async function registerRetentionTokenWalkTests(
  t: TestContext,
  store: OAuthStore,
): Promise<void> {
  await t.test('retention finds retired families first instead of reading the whole token table', async () => {
    await resetDatabase()
    const live = Array.from({ length: LIVE_FAMILIES }, (_, index) => ({
      id: 100 + index,
      endsIn: `${1 + (index % 28)} days`,
      tokens: TOKENS_PER_LIVE_FAMILY,
    }))
    const retired = Array.from({ length: RETIRED_FAMILIES }, (_, index) => ({
      id: 10 + index,
      endsIn: `-${31 + index} days`,
      tokens: TOKENS_PER_RETIRED_FAMILY,
    }))
    const client = await database!.connect()
    try {
      await seedFamilies(client, [...retired, ...live], 1)
      await client.query('ANALYZE oauth_tokens, oauth_token_families')
    } finally {
      client.release()
    }
    const totalTokens = LIVE_FAMILIES * TOKENS_PER_LIVE_FAMILY + RETIRED_FAMILIES * TOKENS_PER_RETIRED_FAMILY

    const plan = await inRolledBackTransaction(client => explainCurrentStatement(store, client, {
      bucketHash: hashOf('regression-bucket'),
      attemptKind: 'refresh',
      maximum: 10,
    }))
    const read = tokenRowsRead(plan)
    // Stable at this size: the retired families hold 120 rows and the batch
    // deletes 50, so a plan reaching tokens only through retired families reads
    // a few hundred rows at most, while any plan that starts from the token
    // table (a backwards primary key walk, a sequential scan, or a hash join)
    // reads every newer live row, about 42,000.
    assert.ok(
      read <= TOKEN_ROWS_READ_BOUND,
      `the clean-up read ${read} of ${totalTokens} token rows; it must reach tokens through retired families`,
    )
  })

  await t.test('the rewritten clean-up deletes and keeps exactly the rows the old statement did', async () => {
    await resetDatabase()
    const before = await runEquivalencePasses(runBefore)
    const current = await runEquivalencePasses(runCurrent(store))
    assert.deepEqual(current, before)

    // The comparison is not vacuous: the old statement really did delete in
    // batches across passes, and the boundary rows fell on the expected sides.
    const first = before[0]!.snapshot
    const last = before.at(-1)!.snapshot
    assert.deepEqual(before.map(pass => pass.admitted), [true, false, false, false, false, false])
    assert.ok(idsOf(first.tokens).length > idsOf(last.tokens).length)
    assert.deepEqual(idsOf(last.families), [1, 2, 3, 4, 9], 'families past the window go, the rest stay')
    assert.equal(idsOf(last.tokens).length, 40 + 12 + 30 + 20 + 16, 'only retired families lose tokens')
    assert.deepEqual(idsOf(last.requests), [2, 4, 6], 'a request goes once no live code points at it')
    assert.deepEqual(idsOf(last.codes), [2, 6])
    assert.ok(!last.recovery_codes.split(',').some(code => code.startsWith('5:')))
    const bucketOf = (label: string) => sha256(`retention-walk-bucket:${label}`)
    assert.ok(last.rate_limits.includes(bucketOf('exactly-a-day')), 'a window exactly a day old is kept')
    assert.ok(!last.rate_limits.includes(bucketOf('stale')), 'a window older than a day is pruned')
  })
}
