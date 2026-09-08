import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { prepareMigrationExecution, resolveMigrationRun } from '../scripts/migrate.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const migrationFile = 'db/migrations/20260908_me_public_checkpoint.sql' as const

test('the last-me public checkpoint is one nullable guarded schema addition', () => {
  const schema = read('../db/schema.sql')
  const migration = read('../db/migrations/20260908_me_public_checkpoint.sql')
  const freshTable = /CREATE TABLE IF NOT EXISTS city_credit_last_me_reads \([\s\S]*?\n\);/u.exec(schema)?.[0]
  assert.ok(freshTable)

  assert.match(
    freshTable,
    /last_public_change_id\s+BIGINT\s+CONSTRAINT city_credit_last_me_reads_public_change_nonnegative\s+CHECK\s*\(last_public_change_id\s*>=\s*0\)/iu,
  )
  assert.doesNotMatch(freshTable, /last_public_change_id[^\n]*(?:DEFAULT|NOT NULL)/iu)
  assert.match(migration, /^BEGIN;/u)
  assert.match(migration, /SET LOCAL lock_timeout = '5s';/u)
  assert.match(migration, /SET LOCAL statement_timeout = '120s';/u)
  assert.match(
    migration,
    /ALTER TABLE city_credit_last_me_reads\s+ADD COLUMN IF NOT EXISTS last_public_change_id BIGINT;/iu,
  )
  assert.match(migration, /ADD CONSTRAINT city_credit_last_me_reads_public_change_nonnegative[\s\S]*last_public_change_id >= 0/iu)
  assert.match(migration, /constraint_row\.convalidated/iu)
  assert.match(migration, /column_name = 'last_public_change_id'[\s\S]*data_type = 'bigint'[\s\S]*is_nullable = 'YES'[\s\S]*column_default IS NULL/iu)
  assert.doesNotMatch(migration, /UPDATE\s+city_credit_last_me_reads/iu)
  assert.match(migration, /COMMIT;\s*$/u)
  assert.equal(prepareMigrationExecution(migrationFile, migration).mode, 'transactional')
})

test('the guarded runner exposes preview and production checkpoint commands', () => {
  const baseEnvironment = {
    NEON_API_KEY: 'test-neon-key',
    NEON_PROJECT_ID: 'test-project',
    NEON_PRODUCTION_BRANCH_ID: 'production-branch',
  }
  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'me-public-checkpoint'],
    {
      ...baseEnvironment,
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_PREVIEW_BRANCH_ID: 'preview-branch',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    },
  )
  assert.equal(preview.migrationFile, migrationFile)

  const production = resolveMigrationRun(
    ['--target', 'production', '--migration', 'me-public-checkpoint'],
    {
      ...baseEnvironment,
      CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
      PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      PRODUCTION_SNAPSHOT_NAME: 'me-public-checkpoint-release',
    },
  )
  assert.equal(production.migrationFile, migrationFile)

  const packageJson = JSON.parse(read('../package.json')) as { scripts: Record<string, string> }
  assert.match(packageJson.scripts['migrate:preview:me-public-checkpoint'] ?? '', /--migration me-public-checkpoint/u)
  assert.match(packageJson.scripts['migrate:production:me-public-checkpoint'] ?? '', /--migration me-public-checkpoint/u)
})
