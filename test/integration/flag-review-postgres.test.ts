import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import {
  handleFlag,
  readFounderFlagQueue,
  unhandledFlagCount,
  type FlagReviewQuery,
} from '../../src/flag-review.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const MIGRATION_URL = new URL('../../db/migrations/20260915_flag_review.sql', import.meta.url)

function docker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim())
  return result.stdout.trim()
}

async function postgres(): Promise<{ pool: Pool; container: string }> {
  const container = `1f3d9-flag-review-${process.pid}-${randomBytes(4).toString('hex')}`
  const password = randomBytes(24).toString('hex')
  docker(['run', '--detach', '--rm', '--name', container, '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`, POSTGRES_IMAGE])
  try {
    const port = Number(docker(['port', container, '5432/tcp']).match(/:(\d+)\s*$/u)?.[1])
    const pool = new Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres' })
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      try {
        await pool.query('SELECT 1')
        return { pool, container }
      } catch {
        await delay(200)
      }
    }
    await pool.end()
    throw new Error('PostgreSQL did not become ready')
  } catch (error) {
    spawnSync('docker', ['stop', '--time', '0', container], { encoding: 'utf8' })
    throw error
  }
}

const BASE_SCHEMA = `
  CREATE TABLE residents (id SERIAL PRIMARY KEY, handle TEXT NOT NULL UNIQUE);
  INSERT INTO residents (id, handle) VALUES (1, 'founder'), (7, 'tiny-lantern');
  CREATE TABLE flags (
    id            SERIAL PRIMARY KEY,
    reporter_id   INTEGER REFERENCES residents(id) ON DELETE RESTRICT,
    target_type   TEXT NOT NULL CHECK (target_type IN ('resident', 'place', 'thing', 'kind', 'trait', 'note', 'agreement')),
    target_id     INTEGER NOT NULL CHECK (target_id > 0),
    reason        TEXT NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 4000),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE moderation_actions (
    id           BIGSERIAL PRIMARY KEY,
    target_type  TEXT NOT NULL,
    target_id    INTEGER NOT NULL CHECK (target_id > 0),
    action       TEXT NOT NULL CHECK (action IN ('remove', 'restore')),
    actor_id     INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT CHECK (actor_id = 1),
    reason       TEXT NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 4000),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE OR REPLACE FUNCTION deny_history_mutation() RETURNS trigger LANGUAGE plpgsql
    AS $$BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000'; END$$;
  CREATE TRIGGER flags_append_only BEFORE UPDATE OR DELETE ON flags
    FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
`

const SEED = `
  INSERT INTO flags (id, reporter_id, target_type, target_id, reason) VALUES
    (1, 7, 'note', 51, 'a resident wrote this report text'),
    (2, NULL, 'thing', 41, 'an anonymous reader wrote this one');
  SELECT setval(pg_get_serial_sequence('flags', 'id'), 2);
  INSERT INTO moderation_actions (id, target_type, target_id, action, actor_id, reason)
    VALUES (77, 'note', 51, 'remove', 1, 'removed on a report');
  SELECT setval(pg_get_serial_sequence('moderation_actions', 'id'), 77);
`

test('PostgreSQL keeps one permanent founder answer per flag and an honest unhandled count', {
  timeout: 120_000,
}, async () => {
  assert.equal(existsSync(MIGRATION_URL), true, 'add the flag review migration before this gate')
  const ddl = await readFile(MIGRATION_URL, 'utf8')
  const server = await postgres()
  const query: FlagReviewQuery = async (text, params) =>
    (await server.pool.query(text, [...params])).rows as Record<string, unknown>[]
  try {
    await server.pool.query(BASE_SCHEMA)
    await server.pool.query(ddl)
    // Repeating the reviewed migration must stay safe.
    await server.pool.query(ddl)
    await server.pool.query(SEED)

    assert.equal(await unhandledFlagCount(query), 2)
    const queue = await readFounderFlagQueue(query)
    assert.equal(queue.unhandledCount, 2)
    assert.equal(queue.flags.length, 2)
    assert.equal(queue.flags[0]?.id, 2, 'the newest flag is listed first')
    assert.equal(queue.flags[0]?.reporter, null, 'an anonymous report has no reporter')
    assert.deepEqual(queue.flags[1]?.reporter, { id: 7, handle: 'tiny-lantern' })
    assert.equal(queue.flags[1]?.reason, 'a resident wrote this report text')
    assert.equal(queue.flags[1]?.handled, null)

    // An answer must name a moderation act, a note, or both.
    await assert.rejects(server.pool.query(
      `INSERT INTO flag_reviews (flag_id, reviewer_id) VALUES (1, 1)`,
    ), /flag_reviews_check|violates check constraint/iu)
    await assert.rejects(server.pool.query(
      `INSERT INTO flag_reviews (flag_id, reviewer_id, note) VALUES (1, 1, $1)`,
      ['x'.repeat(201)],
    ), /violates check constraint/iu)
    await assert.rejects(server.pool.query(
      `INSERT INTO flag_reviews (flag_id, reviewer_id, note) VALUES (1, 1, $1)`,
      ['two\nlines'],
    ), /violates check constraint/iu)
    await assert.rejects(server.pool.query(
      `INSERT INTO flag_reviews (flag_id, reviewer_id, moderation_id) VALUES (1, 1, 9999)`,
    ), /foreign key constraint/iu)

    const handled = await handleFlag(query, 1, 1, { moderationId: 77, note: null })
    assert.equal(handled.outcome, 'handled')
    assert.equal(handled.outcome === 'handled' ? handled.handled.moderation_id : null, 77)
    assert.match(
      handled.outcome === 'handled' ? handled.handled.at : '',
      /^\d{4}-\d{2}-\d{2}T/u,
    )

    const retried = await handleFlag(query, 1, 1, { moderationId: 77, note: null })
    assert.equal(retried.outcome, 'already_handled')
    const differing = await handleFlag(query, 1, 1, { moderationId: null, note: 'no action' })
    assert.equal(differing.outcome, 'differently_handled')
    assert.equal(
      differing.outcome === 'differently_handled' ? differing.handled.moderation_id : null,
      77,
      'the first answer is never overwritten',
    )
    assert.deepEqual(await handleFlag(query, 4040, 1, { moderationId: null, note: 'no action' }), {
      outcome: 'not_found',
    })

    assert.equal(await unhandledFlagCount(query), 1)
    const answered = await readFounderFlagQueue(query)
    assert.equal(answered.unhandledCount, 1)
    assert.deepEqual(answered.flags[1]?.handled?.moderation_id, 77)
    assert.equal(answered.flags[1]?.handled?.note, null)
    assert.equal(answered.flags[0]?.handled, null)

    const noted = await handleFlag(query, 2, 1, { moderationId: null, note: 'no action needed' })
    assert.equal(noted.outcome, 'handled')
    assert.equal(await unhandledFlagCount(query), 0)

    // The answer is append-only, like every other history table here.
    await assert.rejects(server.pool.query(
      `UPDATE flag_reviews SET note = 'changed' WHERE flag_id = 2`,
    ), /append-only/iu)
    await assert.rejects(server.pool.query(
      `DELETE FROM flag_reviews WHERE flag_id = 2`,
    ), /append-only/iu)
  } finally {
    await server.pool.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', server.container], { encoding: 'utf8' })
  }
})
