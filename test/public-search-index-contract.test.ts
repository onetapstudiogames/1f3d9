import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import {
  prepareMigrationExecution,
  resolveMigrationRun,
  type MigrationFile,
} from '../scripts/migrate.ts'

const migrationPath = new URL(
  '../db/migrations/20260821_public_search_indexes.sql',
  import.meta.url,
)
const migrationFile = 'db/migrations/20260821_public_search_indexes.sql' as MigrationFile
const postgresTestFile = 'public-search-index-postgres.test.ts'

const expectedIndexes = Object.freeze([
  Object.freeze({
    name: 'notes_public_search_words',
    table: 'notes',
    expression: /to_tsvector\s*\(\s*'simple'\s*(?:::regconfig)?\s*,\s*(?:\(?\s*)?body/iu,
    predicate: null,
  }),
  Object.freeze({
    name: 'notes_public_search_phrase',
    table: 'notes',
    expression: /lower\s*\(\s*(?:\(?\s*)?body/iu,
    predicate: null,
  }),
  Object.freeze({
    name: 'things_public_search_words_active',
    table: 'things',
    expression: /to_tsvector\s*\(\s*'simple'\s*(?:::regconfig)?\s*,[\s\S]*(?:name[\s\S]*body|body[\s\S]*name)/iu,
    predicate: /WHERE\s+withdrawn_at\s+IS\s+NULL/iu,
  }),
  Object.freeze({
    name: 'things_public_search_phrase_active',
    table: 'things',
    expression: /lower\s*\([\s\S]*(?:name[\s\S]*body|body[\s\S]*name)/iu,
    predicate: /WHERE\s+withdrawn_at\s+IS\s+NULL/iu,
  }),
])

function indexStatement(ddl: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return ddl.match(new RegExp(
    `CREATE\\s+INDEX(?:\\s+CONCURRENTLY)?\\s+IF\\s+NOT\\s+EXISTS\\s+${escaped}\\b[\\s\\S]*?;`,
    'iu',
  ))?.[0] ?? ''
}

test('fresh installs and the additive release define automatically maintained search indexes', () => {
  assert.equal(
    existsSync(migrationPath),
    true,
    'add db/migrations/20260821_public_search_indexes.sql before changing the search query',
  )
  const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8')
  const migration = readFileSync(migrationPath, 'utf8')

  for (const [surface, ddl] of [['schema', schema], ['migration', migration]] as const) {
    assert.match(ddl, /CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+pg_trgm/iu, `${surface}: pg_trgm`)
    for (const expected of expectedIndexes) {
      const statement = indexStatement(ddl, expected.name)
      assert.ok(statement, `${surface}: ${expected.name}`)
      assert.match(statement, new RegExp(`ON\\s+(?:public\\.)?${expected.table}\\b`, 'iu'))
      assert.match(statement, /USING\s+GIN\b/iu)
      assert.match(statement, expected.expression)
      if (expected.name.includes('phrase')) assert.match(statement, /gin_trgm_ops/iu)
      if (expected.predicate) assert.match(statement, expected.predicate)
    }
  }

  const executableMigration = migration.replace(/^\s*--.*$/gmu, '')
  assert.doesNotMatch(executableMigration, /^\s*(?:DROP\s+TABLE|DELETE|TRUNCATE)\b/imu)
  for (const expected of expectedIndexes) {
    assert.match(indexStatement(migration, expected.name), /CREATE\s+INDEX\s+CONCURRENTLY/iu)
  }
})

test('the search-index release is explicitly selected and runs outside one long transaction', () => {
  assert.equal(existsSync(migrationPath), true, 'the search-index migration is missing')
  const migration = readFileSync(migrationPath, 'utf8')
  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'public-search-indexes'],
    {
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'test-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    },
  )
  assert.equal(preview.migrationFile, migrationFile)
  assert.equal(preview.executionMode, 'nontransactional')

  const production = resolveMigrationRun(
    ['--target', 'production', '--migration', 'public-search-indexes'],
    {
      CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
      NEON_API_KEY: 'test-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      PRODUCTION_SNAPSHOT_NAME: 'public-search-indexes-release',
    },
  )
  assert.equal(production.migrationFile, migrationFile)
  assert.equal(production.executionMode, 'nontransactional')

  const execution = prepareMigrationExecution(migrationFile, migration)
  assert.equal(execution.mode, 'nontransactional')
  assert.ok(execution.sessionStatements.some(statement => /lock_timeout/iu.test(statement)))
  assert.ok(execution.sessionStatements.some(statement => /statement_timeout/iu.test(statement)))

  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts?: Record<string, string>
  }
  assert.match(packageJson.scripts?.['test:postgres'] ?? '', /test\/integration\/\*\.test\.ts/u)
  assert.equal(
    existsSync(new URL(`../test/integration/${postgresTestFile}`, import.meta.url)),
    true,
  )
})
