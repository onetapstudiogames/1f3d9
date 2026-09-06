import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  readFileSync,
} from 'node:fs'
import {
  prepareMigrationExecution,
  resolveMigrationRun,
} from '../../scripts/migrate.ts'
import {
  migrationDdl,
  schemaStatement,
} from '../helpers/migrate-fixtures/index.ts'

export function registerResidentDrawingTests(): void {
  const resumableRegistrationMigrationFile =
    'db/migrations/20260826_resumable_registration.sql' as const
  const residentRefusalMigrationFile =
    'db/migrations/20260827_resident_refusal_state.sql' as const
  const drawingsMigrationFile = 'db/migrations/20260827_drawings.sql' as const
  const drawingContractMigrationFile = 'db/migrations/20260828_drawing_contract.sql' as const

  test('resumable registration is one explicit guarded transactional preview or production migration', () => {
    const migration = migrationDdl(resumableRegistrationMigrationFile)
    assert.match(migration, /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+client_class/iu)
    assert.match(migration, /pending_resident_registrations_client_class_valid/iu)
    assert.equal(
      prepareMigrationExecution(resumableRegistrationMigrationFile, migration).mode,
      'transactional',
    )

    const baseEnvironment = {
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
    }
    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'resumable-registration'],
      {
        ...baseEnvironment,
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, resumableRegistrationMigrationFile)
    assert.equal(preview.executionMode, 'transactional')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'resumable-registration'],
      {
        ...baseEnvironment,
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'resumable-registration-release',
      },
    )
    assert.equal(production.migrationFile, resumableRegistrationMigrationFile)
    assert.equal(production.executionMode, 'transactional')

    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> }
    assert.match(
      packageJson.scripts?.['migrate:preview:resumable-registration'] ?? '',
      /--migration resumable-registration/u,
    )
    assert.match(
      packageJson.scripts?.['migrate:production:resumable-registration'] ?? '',
      /--migration resumable-registration/u,
    )
  })

  test('resident refusal state is bounded, private, and one explicit transactional migration', () => {
    const freshTable = schemaStatement('resident_refusal_state')
    const migration = migrationDdl(residentRefusalMigrationFile)

    for (const ddl of [freshTable, migration]) {
      assert.match(ddl, /resident_id\s+INTEGER\s+PRIMARY\s+KEY[\s\S]*REFERENCES\s+residents\s*\(id\)/iu)
      assert.match(ddl, /http_status\s+SMALLINT[\s\S]*400[\s\S]*403[\s\S]*404[\s\S]*409[\s\S]*429/iu)
      assert.doesNotMatch(ddl, /http_status[\s\S]{0,180}\b402\b/iu)
      assert.match(ddl, /cause_hash\s+TEXT[\s\S]*\^\[0-9a-f\]\{64\}\$/iu)
      assert.match(ddl, /repetition_count\s+SMALLINT[\s\S]*BETWEEN\s+1\s+AND\s+10/iu)
      assert.doesNotMatch(ddl, /\bcause\s+TEXT\b/iu)
    }
    assert.equal(
      prepareMigrationExecution(residentRefusalMigrationFile, migration).mode,
      'transactional',
    )

    const baseEnvironment = {
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
    }
    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'resident-refusal-state'],
      {
        ...baseEnvironment,
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, residentRefusalMigrationFile)
    assert.equal(preview.executionMode, 'transactional')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'resident-refusal-state'],
      {
        ...baseEnvironment,
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'resident-refusal-state-release',
      },
    )
    assert.equal(production.migrationFile, residentRefusalMigrationFile)
    assert.equal(production.executionMode, 'transactional')

    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> }
    assert.match(
      packageJson.scripts?.['migrate:preview:resident-refusal-state'] ?? '',
      /--migration resident-refusal-state/u,
    )
    assert.match(
      packageJson.scripts?.['migrate:production:resident-refusal-state'] ?? '',
      /--migration resident-refusal-state/u,
    )
  })

  test('drawings are one explicit guarded transactional preview or production migration', () => {
    const migration = migrationDdl(drawingsMigrationFile)
    assert.match(migration, /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+drawing\s+JSONB/iu)
    assert.equal(prepareMigrationExecution(drawingsMigrationFile, migration).mode, 'transactional')

    const baseEnvironment = {
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
    }
    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'drawings'],
      {
        ...baseEnvironment,
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, drawingsMigrationFile)
    assert.equal(preview.executionMode, 'transactional')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'drawings'],
      {
        ...baseEnvironment,
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'drawings-release',
      },
    )
    assert.equal(production.migrationFile, drawingsMigrationFile)
    assert.equal(production.executionMode, 'transactional')

    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> }
    assert.match(
      packageJson.scripts?.['migrate:preview:drawings'] ?? '',
      /--target preview --migration drawings$/u,
    )
    assert.match(
      packageJson.scripts?.['migrate:production:drawings'] ?? '',
      /--target production --migration drawings$/u,
    )
  })

  test('drawing contract is a separate bounded additive migration over the preview drawing baseline', () => {
    const migrationUrl = new URL(`../../${drawingContractMigrationFile}`, import.meta.url)
    assert.equal(existsSync(migrationUrl), true, 'missing forward drawing-contract migration')
    if (!existsSync(migrationUrl)) return

    const migration = migrationDdl(drawingContractMigrationFile)
    assert.match(migration, /^\s*BEGIN\s*;/iu)
    assert.match(migration, /SET\s+LOCAL\s+lock_timeout\s*=/iu)
    assert.match(migration, /SET\s+LOCAL\s+statement_timeout\s*=/iu)
    assert.match(migration, /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+drawing_state\s+TEXT/iu)
    assert.match(migration, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+drawing_revisions/iu)
    assert.doesNotMatch(migration, /DROP\s+(?:TABLE|COLUMN)\b/iu)
    assert.doesNotMatch(migration, /TRUNCATE\b/iu)
    assert.match(migration, /COMMIT\s*;\s*$/iu)
    assert.equal(
      prepareMigrationExecution(drawingContractMigrationFile, migration).mode,
      'transactional',
    )
  })

  test('drawing contract has exact guarded preview and production registry entries', () => {
    const baseEnvironment = {
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
    }
    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'drawing-contract'],
      {
        ...baseEnvironment,
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, drawingContractMigrationFile)
    assert.equal(preview.executionMode, 'transactional')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'drawing-contract'],
      {
        ...baseEnvironment,
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'drawing-contract-release',
      },
    )
    assert.equal(production.migrationFile, drawingContractMigrationFile)
    assert.equal(production.executionMode, 'transactional')

    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> }
    assert.match(
      packageJson.scripts?.['migrate:preview:drawing-contract'] ?? '',
      /--target preview --migration drawing-contract$/u,
    )
    assert.match(
      packageJson.scripts?.['migrate:production:drawing-contract'] ?? '',
      /--target production --migration drawing-contract$/u,
    )
  })
}
