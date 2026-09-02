import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import {
  COMMUNITY_TOOL_CATEGORIES,
  readCommunityToolQueue,
  readCommunityToolWaitingCount,
  reviewCommunityToolSubmission,
  submitCommunityTool,
  type CommunityToolSubmission,
  type CommunityToolSubmissionQuery,
} from '../../src/community-tool-submissions.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const MIGRATION_URL = new URL('../../db/migrations/20260901_community_tool_submissions.sql', import.meta.url)
const PRIVACY_MIGRATION_URL = new URL('../../db/migrations/20260901_community_tool_submission_privacy.sql', import.meta.url)

function docker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim())
  return result.stdout.trim()
}

async function postgres(): Promise<{ pool: Pool; container: string }> {
  const container = `1f3d9-community-tools-${process.pid}-${randomBytes(4).toString('hex')}`
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

const submission = (residentId: number | null): CommunityToolSubmission => Object.freeze({
  title: 'Pocket city atlas',
  url: 'https://tools.example/atlas',
  operator: 'Lantern Workshop',
  description: 'Finds public places by their street names.',
  residentId,
  category: COMMUNITY_TOOL_CATEGORIES[0],
  tags: Object.freeze(['maps', 'streets']),
})

test('PostgreSQL keeps submissions private, bounded, attributable, and operator-readable', {
  timeout: 120_000,
}, async () => {
  assert.equal(existsSync(MIGRATION_URL), true, 'add the queue migration before this gate')
  assert.equal(existsSync(PRIVACY_MIGRATION_URL), true, 'add the queue privacy migration before this gate')
  const ddl = await readFile(MIGRATION_URL, 'utf8')
  const privacyDdl = await readFile(PRIVACY_MIGRATION_URL, 'utf8')
  const server = await postgres()
  const query: CommunityToolSubmissionQuery = async (text, params) =>
    (await server.pool.query(text, [...params])).rows as Record<string, unknown>[]
  try {
    await server.pool.query(`CREATE TABLE residents (id SERIAL PRIMARY KEY, handle TEXT NOT NULL UNIQUE)`)
    await server.pool.query(`INSERT INTO residents (id, handle) VALUES (1, 'founder'), (46, 'solward')`)
    await server.pool.query(ddl)
    await server.pool.query(ddl)
    await server.pool.query(`
      INSERT INTO community_tool_submission_limits (ip_hash, day, used)
      VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)
    `, ['f'.repeat(64)])
    const migrationClient = await server.pool.connect()
    try {
      await assert.rejects(migrationClient.query(privacyDdl), /legacy address hashes/iu)
      await migrationClient.query('ROLLBACK')
    } finally {
      migrationClient.release()
    }
    await server.pool.query(`DELETE FROM community_tool_submission_limits`)
    await server.pool.query(privacyDdl)
    await server.pool.query(privacyDdl)

    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.deepEqual(await submitCommunityTool(query, submission(46), 'a'.repeat(64)), { outcome: 'queued' })
    }
    assert.deepEqual(await submitCommunityTool(query, submission(46), 'a'.repeat(64)), { outcome: 'rate_limited' })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.deepEqual(await submitCommunityTool(query, submission(999), 'b'.repeat(64)), { outcome: 'resident_not_found' })
    }
    assert.deepEqual(await submitCommunityTool(query, submission(null), 'b'.repeat(64)), { outcome: 'rate_limited' })
    assert.deepEqual(await submitCommunityTool(query, submission(null), 'c'.repeat(64)), { outcome: 'queued' })

    assert.equal(await readCommunityToolWaitingCount(query), 4)
    const queue = await readCommunityToolQueue(query)
    assert.equal(queue.waitingCount, 4)
    assert.equal(queue.submissions.length, 4)
    assert.deepEqual(queue.submissions[0], {
      id: 4,
      title: 'Pocket city atlas',
      url: 'https://tools.example/atlas',
      operator: 'Lantern Workshop',
      description: 'Finds public places by their street names.',
      resident: null,
      category: COMMUNITY_TOOL_CATEGORIES[0],
      tags: ['maps', 'streets'],
      submitted_at: queue.submissions[0]!.submitted_at,
    })
    assert.match(queue.submissions[0]!.submitted_at, /^\d{4}-\d{2}-\d{2}T/u)
    assert.equal(JSON.stringify(queue).includes('submitter_ip_hash'), false)
    assert.equal(JSON.stringify(queue).includes('a'.repeat(64)), false)

    assert.deepEqual((await server.pool.query(
      `SELECT submitter_ip_hash FROM community_tool_submissions WHERE id = 4`,
    )).rows, [{ submitter_ip_hash: 'c'.repeat(64) }])

    assert.deepEqual(await reviewCommunityToolSubmission(query, 4, 1, 'listed'), {
      outcome: 'reviewed',
      reviewOutcome: 'listed',
    })
    assert.deepEqual((await server.pool.query(
      `SELECT submitter_ip_hash FROM community_tool_submissions WHERE id = 4`,
    )).rows, [{ submitter_ip_hash: null }])
    assert.deepEqual(await reviewCommunityToolSubmission(query, 4, 1, 'listed'), {
      outcome: 'already_reviewed',
      reviewOutcome: 'listed',
    })
    assert.equal(await readCommunityToolWaitingCount(query), 3)
    assert.equal((await readCommunityToolQueue(query)).submissions.length, 3)
  } finally {
    await server.pool.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', server.container], { encoding: 'utf8' })
  }
})
