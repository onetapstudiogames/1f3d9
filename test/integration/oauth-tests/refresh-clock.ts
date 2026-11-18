import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { OAUTH_REFRESH_TOKEN_SECONDS } from '../../../src/oauth-limits.ts'
import { waitPastDatabaseTime } from '../../helpers/database-clock.ts'
import {
  database, exchangeExistingResidentCode, resetDatabase, sha256, type OAuthStore,
} from '../../helpers/oauth-postgres-fixtures/postgres.ts'

function rotation(initial: Awaited<ReturnType<typeof exchangeExistingResidentCode>>) {
  return {
    clientId: initial.request.clientId,
    resource: initial.request.resource,
    presentedRefreshTokenHash: initial.refreshTokenHash,
    accessTokenHash: sha256('clock-next-access'),
    newRefreshTokenHash: sha256('clock-next-refresh'),
  }
}

async function waitForFamilyLock(blockerPid: number) {
  const deadline = Date.now() + 5000
  for (;;) {
    const { rows } = await database!.query<{ began_live: boolean; ends: Date; other_end: Date; observed: string }>(`
      SELECT waiter.xact_start < least(family.expires_at, pass.expires_at) AS began_live,
        least(family.expires_at, pass.expires_at) AS ends, greatest(family.expires_at, pass.expires_at) AS other_end,
        clock_timestamp()::text AS observed
      FROM pg_stat_activity waiter CROSS JOIN oauth_token_families family
      JOIN oauth_tokens pass ON pass.family_id = family.id AND pass.token_type = 'refresh'
      WHERE $1::integer = ANY(pg_blocking_pids(waiter.pid))`, [blockerPid])
    if (rows.length) return rows[0]!
    assert.ok(Date.now() < deadline, 'the refresh did not reach the family row lock')
    await delay(20)
  }
}

async function checkWaitingRefresh(store: OAuthStore, expires: 'family' | 'pass' | 'neither') {
  await resetDatabase()
  const initial = await exchangeExistingResidentCode(store, 'waiting-refresh')
  if (expires !== 'neither') {
    // A faulty refresh fails this fixture check before it can extend the family.
    await database!.query(`ALTER TABLE oauth_token_families ADD CONSTRAINT test_deadline
      CHECK (expires_at < created_at + interval '1 day') NOT VALID`)
    if (expires === 'family') {
      await database!.query("UPDATE oauth_token_families SET expires_at = clock_timestamp() + interval '2 seconds'")
    } else {
      await database!.query("UPDATE oauth_tokens SET expires_at = clock_timestamp() + interval '2 seconds' WHERE token_type = 'refresh'")
    }
  }
  const versions = async () => (await database!.query(`SELECT f.xmin AS family_version, t.id, t.xmin AS token_version
    FROM oauth_token_families f JOIN oauth_tokens t ON t.family_id = f.id ORDER BY t.id`)).rows
  const before = await versions()
  const gate = await database!.connect()
  let settled: Promise<unknown> | undefined
  try {
    await gate.query('BEGIN')
    const { rows } = await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid FROM oauth_token_families FOR UPDATE')
    const pending = store.rotateRefreshToken(rotation(initial))
    settled = Promise.allSettled([pending])
    const observed = await waitForFamilyLock(rows[0]!.pid)
    assert.equal(observed.began_live, true, 'the deadline must follow the start of the waiting transaction')
    if (expires !== 'neither') {
      const now = await waitPastDatabaseTime(database!, observed.ends)
      assert.ok(now < observed.other_end, 'only the selected deadline may expire during the wait')
    }
    await gate.query('COMMIT')
    assert.equal(await pending, expires === 'neither' ? 'rotated' : 'invalid')
    if (expires !== 'neither') {
      assert.deepEqual(await versions(), before, 'refusal must preserve the family and every token row')
    } else {
      const { rows } = await gate.query(`SELECT previous.used_at >= $1::timestamptz AS used_after_wait,
          extract(epoch FROM family.expires_at - previous.used_at)::float8 AS seconds
        FROM oauth_tokens previous JOIN oauth_token_families family ON family.id = previous.family_id
        WHERE previous.token_hash = $2`, [observed.observed, initial.refreshTokenHash])
      assert.deepEqual(rows, [{ used_after_wait: true, seconds: OAUTH_REFRESH_TOKEN_SECONDS }])
    }
  } finally {
    await gate.query('ROLLBACK')
    gate.release()
    await settled
    if (expires !== 'neither') await database!.query('ALTER TABLE oauth_token_families DROP CONSTRAINT test_deadline')
  }
}

async function setDaylightSavingZone(fallsBack: boolean) {
  // POSIX transition days are zero-based. Put a clock change two weeks from
  // the database's UTC date so this exercises a real transition all year.
  const { rows } = await database!.query<{ past: number; next: number }>(`
    SELECT extract(doy FROM (now() AT TIME ZONE 'UTC')::date - 60)::int - 1 AS past,
      extract(doy FROM (now() AT TIME ZONE 'UTC')::date + 14)::int - 1 AS next`)
  const { past, next } = rows[0]!
  const zone = fallsBack ? `STD0DST,${past},${next}` : `STD0DST,${next},${past}`
  await database!.query("SELECT set_config('TimeZone', $1, false)", [zone])
  const interval = await database!.query(`SELECT extract(epoch FROM
    (now() + interval '30 days') - now())::float8 AS seconds`)
  assert.equal(interval.rows[0]!.seconds, OAUTH_REFRESH_TOKEN_SECONDS + (fallsBack ? 3600 : -3600))
}

async function assertRefreshLife(hash: string) {
  const { rows } = await database!.query(`SELECT
      extract(epoch FROM token.expires_at - token.created_at)::float8 AS seconds,
      family.expires_at = token.expires_at AS same_end
    FROM oauth_tokens token JOIN oauth_token_families family ON family.id = token.family_id
    WHERE token.token_hash = $1`, [hash])
  assert.deepEqual(rows, [{ seconds: OAUTH_REFRESH_TOKEN_SECONDS, same_end: true }])
}

export async function registerRefreshClockTests(t: TestContext, store: OAuthStore): Promise<void> {
  await t.test('a refresh waiting past the family deadline preserves the expired sign-in', async () => {
    await checkWaitingRefresh(store, 'family')
  })
  await t.test('a refresh waiting past the pass deadline preserves the still-live sign-in', async () => {
    await checkWaitingRefresh(store, 'pass')
  })
  await t.test('a still-live refresh starts its full lifetime after the family lock', async () => {
    await checkWaitingRefresh(store, 'neither')
  })
  for (const transition of ['fall-back', 'spring-forward']) {
    await t.test(`refresh lifetimes across ${transition}`, async t => {
      await checkDaylightSaving(t, store, transition)
    })
  }
}

async function checkDaylightSaving(t: TestContext, store: OAuthStore, transition: string) {
  await resetDatabase()
  const session = await database!.connect()
  // Keep the store and our observations on the same PostgreSQL session.
  const query = t.mock.method(database!, 'query', session.query.bind(session))
  try {
    const fallsBack = transition === 'fall-back'
    await setDaylightSavingZone(fallsBack)
    const initial = await exchangeExistingResidentCode(store, transition)
    const next = rotation(initial)
    await t.test(`code exchange stores the advertised seconds across ${transition}`, async () => {
      await assertRefreshLife(initial.refreshTokenHash)
    })
    await t.test(`rotation stores the advertised seconds across ${transition}`, async () => {
      assert.equal(await store.rotateRefreshToken(next), 'rotated')
      await assertRefreshLife(next.newRefreshTokenHash)
    })
    await t.test(`the opposite time zone can revoke every pass issued before ${transition}`, async () => {
      await setDaylightSavingZone(!fallsBack)
      await store.revokeTokenFamilyByToken({ tokenHash: initial.refreshTokenHash, clientId: next.clientId })
      const { rows } = await session.query(`SELECT count(*)::int AS tokens,
        bool_and(token.revoked_at IS NOT NULL AND family.revoked_at IS NOT NULL) AS all_revoked
        FROM oauth_tokens token JOIN oauth_token_families family ON family.id = token.family_id`)
      assert.deepEqual(rows, [{ tokens: 4, all_revoked: true }])
    })
  } finally {
    query.mock.restore()
    session.release(true)
  }
}
