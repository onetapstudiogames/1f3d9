import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { TestContext } from 'node:test'
import { Hono } from 'hono'
import { OAUTH_REFRESH_TOKEN_PREFIX } from '../../../src/oauth-config.ts'
import { registerGeminiClient } from '../../../src/oauth-gemini.ts'
import { OAUTH_LIMITS } from '../../../src/oauth-limits.ts'
import { database, resetDatabase, sha256, type OAuthStore } from '../../helpers/oauth-postgres-fixtures/postgres.ts'

const origin = 'https://1f3d9.com'

async function oauthConstraints() {
  return (await database!.query(
    `SELECT oid, conrelid::regclass::text AS table_name, conname, convalidated,
       pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE conrelid IN ('oauth_token_families'::regclass, 'oauth_tokens'::regclass)
     ORDER BY table_name, definition`,
  )).rows
}

async function installPreviousSchema() {
  const current = await readFile(new URL('../../../db/schema.sql', import.meta.url), 'utf8')
  const original = await readFile(
    new URL('../../../db/migrations/20260813_hosted_chat_signin.sql', import.meta.url), 'utf8',
  )
  let previous = current
  for (const name of ['oauth_token_families', 'oauth_tokens']) {
    const pattern = new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`, 'u')
    const table = original.match(pattern)?.[0]
    assert.ok(table && pattern.test(current))
    previous = previous.replace(pattern, () => table)
  }
  await database!.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await database!.query(previous)
  // Deliberately use nonstandard names for both old life checks.
  const { rows } = await database!.query<{ statement: string }>(`
    SELECT format('ALTER TABLE %s RENAME CONSTRAINT %I TO test_original_expiry', conrelid::regclass, conname) AS statement
    FROM pg_constraint WHERE conrelid IN ('oauth_token_families'::regclass, 'oauth_tokens'::regclass) AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%30 days%'`)
  assert.equal(rows.length, 2)
  for (const row of rows) await database!.query(row.statement)
  await database!.query(`INSERT INTO residents (id, handle, model, secret_hash)
    VALUES (1, 'renewal-agent', 'integration-test', $1)`, [sha256('renewal-agent')])
  // Main allowed a 721-hour refresh token when a 30-day window crossed the fall clock change.
  await database!.query(`BEGIN;
    SET LOCAL TIME ZONE 'America/New_York';
    WITH family AS (
      INSERT INTO oauth_token_families (resident_id, client_id, resource, scope, created_at, expires_at)
      VALUES (1, 'legacy-fall', 'https://1f3d9.com/mcp/app', 'city:resident',
        '2026-10-20 12:00'::timestamptz, '2026-11-19 12:00'::timestamptz)
      RETURNING id, created_at, expires_at
    ) INSERT INTO oauth_tokens (token_hash, token_type, family_id, created_at, expires_at)
      SELECT repeat('f', 64), 'refresh', id, created_at, expires_at FROM family;
    COMMIT`)
}

async function seedSignIn(clientId: string, resource: string, remainingMinutes: number) {
  const refresh = OAUTH_REFRESH_TOKEN_PREFIX + randomBytes(32).toString('hex')
  const { rows } = await database!.query<{ family_id: string; created_at: string }>(
    `WITH deadline AS (SELECT now() + make_interval(mins => $3) AS ends),
       family AS (INSERT INTO oauth_token_families (resident_id, client_id, resource, scope, created_at, expires_at)
         SELECT 1, $1, $2, 'city:resident', ends - make_interval(days => $4), ends FROM deadline
         RETURNING id, created_at, expires_at)
     INSERT INTO oauth_tokens (token_hash, token_type, family_id, created_at, expires_at)
     SELECT $5, 'refresh', id, created_at, expires_at FROM family RETURNING family_id, created_at::text`,
    [clientId, resource, remainingMinutes, OAUTH_LIMITS.refreshTokenDays, sha256(refresh)],
  )
  const { family_id: id, created_at: createdAt } = rows[0]!
  return { clientId, resource, id, createdAt, refresh }
}

type SignIn = Awaited<ReturnType<typeof seedSignIn>>

function renew(app: Hono, signIn: SignIn, refresh: string) {
  return app.request('/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: signIn.clientId, resource: signIn.resource, refresh_token: refresh,
    }),
  })
}

async function checkRenewal(app: Hono, signIn: SignIn, previous: string): Promise<string> {
  const response = await renew(app, signIn, previous)
  assert.equal(response.status, 200)
  const tokens = await response.json() as {
    access_token: string
    refresh_token: string
    expires_in: number
    refresh_token_expires_in: number
  }
  assert.equal(tokens.expires_in, OAUTH_LIMITS.accessTokenMinutes * 60)
  assert.equal(tokens.refresh_token_expires_in, OAUTH_LIMITS.refreshTokenDays * 24 * 60 * 60)
  const { rows } = await database!.query(
    `SELECT family.created_at::text AS signed_in,
       family.expires_at = previous.used_at + make_interval(secs => $4) AS renewed,
       refresh.expires_at = family.expires_at AS refresh_agrees,
       refresh.created_at = previous.used_at AND access.created_at = previous.used_at AS same_start,
       access.expires_at = previous.used_at + make_interval(mins => $5) AS full_access_life,
       access.expires_at <= family.expires_at AS access_bounded
     FROM oauth_tokens previous
     JOIN oauth_token_families family ON family.id = previous.family_id
     JOIN oauth_tokens refresh ON refresh.family_id = family.id AND refresh.rotated_from_token_id = previous.id
     JOIN oauth_tokens access ON access.family_id = family.id AND access.token_type = 'access'
     WHERE previous.token_hash = $1 AND refresh.token_hash = $2 AND access.token_hash = $3`,
    [sha256(previous), sha256(tokens.refresh_token), sha256(tokens.access_token),
      tokens.refresh_token_expires_in, OAUTH_LIMITS.accessTokenMinutes],
  )
  assert.deepEqual(rows, [{
    signed_in: signIn.createdAt, renewed: true, refresh_agrees: true, same_start: true,
    full_access_life: true, access_bounded: true,
  }])
  return tokens.refresh_token
}

async function checkMigration() {
  const ddl = await readFile(new URL('../../../db/migrations/20261118_oauth_refresh_renewal.sql', import.meta.url), 'utf8')
  const records = async () => (await database!.query(
    `SELECT to_jsonb(f) AS family, f.xmin, to_jsonb(t) AS token, t.xmin AS token_xmin
     FROM oauth_token_families f JOIN oauth_tokens t ON t.family_id = f.id ORDER BY f.id`,
  )).rows
  const before = await records()
  const retained = (await oauthConstraints()).filter(row => row.conname !== 'test_original_expiry')
  await database!.query(ddl)
  assert.deepEqual(await records(), before)
  const installed = await oauthConstraints()
  for (const row of retained) {
    assert.equal(installed.find(check => check.oid === row.oid)?.definition, row.definition)
  }
  await database!.query(ddl)
  assert.deepEqual(await oauthConstraints(), installed, 'rerunning must keep the same constraints, including their OIDs')
  assert.deepEqual(await records(), before)
  await assert.rejects(database!.query('UPDATE oauth_token_families SET expires_at = created_at'), {
    code: '23514', constraint: 'oauth_token_families_expiry_after_creation',
  })
}

export async function registerRefreshRenewalTests(t: TestContext, store: OAuthStore): Promise<void> {
  await resetDatabase()
  const freshChecks = (await oauthConstraints()).map(({ oid, ...constraint }) => constraint)
  await installPreviousSchema()
  const environment = { HOSTED_CHAT_SIGNIN_ENABLED: 'true', GEMINI_DCR_SIGNING_KEY: randomBytes(32).toString('hex') }
  const gemini = registerGeminiClient(['https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-17-1f3d9_com'], environment)
  assert.ok(gemini)
  const app = new Hono()
  const { mountOAuthRoutes } = await import('../../../src/oauth.ts')
  mountOAuthRoutes(app, { environment, store, diagnostics: () => {} })
  const clients = [
    'https://chatgpt.com/oauth/renewal/client.json',
    'https://claude.ai/oauth/hosted-client-metadata',
    gemini,
    'another-client',
  ]
  const active: SignIn[] = []
  for (const door of ['connect', 'app']) {
    for (const client of clients) {
      active.push(await seedSignIn(client, `${origin}/mcp/${door}`, 2))
    }
  }
  const idle = await seedSignIn('idle-client', `${origin}/mcp/app`, -1)
  await t.test('the renewal migration preserves sign-ins, matches a fresh schema and runs twice', async () => {
    await checkMigration()
    const upgraded = (await oauthConstraints()).map(({ oid, ...constraint }) => constraint)
    assert.deepEqual(upgraded, freshChecks)
  })
  await t.test('the migrated database preserves legacy refresh lives and caps only access at 10 minutes', async () => {
    const token = `FROM oauth_tokens WHERE token_hash = repeat('f', 64)`
    const { rows } = await database!.query(`SELECT EXTRACT(EPOCH FROM expires_at - created_at)::int AS seconds ${token}`)
    assert.deepEqual(rows, [{ seconds: 30 * 86400 + 3600 }])
    const insert = (kind: string, seconds: number) => database!.query(
      `INSERT INTO oauth_tokens (token_hash, token_type, family_id, created_at, expires_at)
       SELECT $1, $2, family_id, created_at, created_at + make_interval(secs => $3) ${token}`,
      [randomBytes(32).toString('hex'), kind, seconds],
    )
    const invalidLife = { code: '23514', constraint: 'oauth_tokens_lifetime' }
    await assert.rejects(insert('refresh', 0), invalidLife)
    await assert.rejects(insert('access', 0), invalidLife)
    await insert('access', 600)
    await assert.rejects(insert('access', 601), invalidLife)
    await insert('refresh', 31 * 86400)
  })
  await t.test('each refresh sets a new full lifetime for every client on both hosted doors', async () => {
    for (const signIn of active) {
      const next = await checkRenewal(app, signIn, signIn.refresh)
      await checkRenewal(app, signIn, next)
    }
  })
  await t.test('a sign-in left idle for 30 days returns invalid_grant and keeps its original end', async () => {
    const state = async () => (await database!.query(
      `SELECT f.expires_at::text, f.xmin, t.used_at, t.xmin AS token_xmin FROM oauth_token_families f
       JOIN oauth_tokens t ON t.family_id = f.id WHERE f.id = $1 ORDER BY t.id`, [idle.id],
    )).rows
    const before = await state()
    const response = await renew(app, idle, idle.refresh)
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'invalid_grant' })
    assert.equal(await store.rotateRefreshToken({
      clientId: idle.clientId, resource: idle.resource, presentedRefreshTokenHash: sha256(idle.refresh),
      accessTokenHash: sha256('idle-access'), newRefreshTokenHash: sha256('idle-refresh'),
    }), 'invalid')
    assert.deepEqual(await state(), before)
  })
}
