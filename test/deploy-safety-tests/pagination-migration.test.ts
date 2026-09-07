import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveMigrationRun, splitSqlStatements } from '../../scripts/migrate.ts'
import { packageJson } from '../helpers/deploy-safety-fixtures/release-documents.ts'

export function registerPaginationMigrationTests(): void {
  test('public pagination indexes are an explicitly selected additive release', () => {
    const paginationMigration = readFileSync(
      new URL('../../db/migrations/20260814_public_pagination.sql', import.meta.url),
      'utf8',
    )
    const uncommented = paginationMigration.replace(/^\s*--.*$/gm, '')
    const statements = splitSqlStatements(paginationMigration)

    assert.equal(statements.length, 10)
    assert.doesNotMatch(uncommented, /^\s*(?:DROP|ALTER|UPDATE|DELETE|TRUNCATE)\b/im)
    for (const statement of statements) {
      const executable = statement.replace(/^\s*--.*$/gm, '').trim()
      assert.match(executable, /^CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\b/i)
    }

    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'public-pagination'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, 'db/migrations/20260814_public_pagination.sql')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'public-pagination'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'public-pagination-release',
      },
    )
    assert.equal(production.migrationFile, 'db/migrations/20260814_public_pagination.sql')

    assert.match(packageJson.scripts['migrate:preview:public-pagination'] ?? '', /--target preview --migration public-pagination$/)
    assert.match(packageJson.scripts['migrate:production:public-pagination'] ?? '', /--target production --migration public-pagination$/)
  })
}
