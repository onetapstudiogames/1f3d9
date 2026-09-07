import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolveMigrationRun, splitSqlStatements } from '../../scripts/migrate.ts'
import { assertPostgresTestDiscovered } from '../helpers/deploy-safety-fixtures/release-documents.ts'
import { fullSchema, identityRecoveryMigrationUrl, identityRotationMigrationUrl, initialRecoveryCodesMigrationUrl } from '../helpers/deploy-safety-fixtures/migration-sources.ts'

export function registerIdentityMigrationsTests(): void {
  test('identity recovery is an explicitly selected additive release with a PostgreSQL gate', () => {
    const migration = readFileSync(identityRecoveryMigrationUrl, 'utf8')
    const uncommented = migration.replace(/^\s*--.*$/gm, '')
    assert.doesNotMatch(uncommented, /^\s*(?:DROP\s+TABLE|DELETE|TRUNCATE)\b/im)
    assert.match(uncommented, /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+recovery_generation\s+BIGINT\s+NOT\s+NULL\s+DEFAULT\s+0/i)
    assert.match(uncommented, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+pending_resident_registrations/i)
    assert.match(uncommented, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+resident_recovery_codes/i)
    assert.match(uncommented, /code_hash\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i)
    assert.doesNotMatch(uncommented, /recovery_code\s+TEXT/i)

    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'identity-recovery'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, 'db/migrations/20260816_identity_recovery.sql')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'identity-recovery'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'identity-recovery-release',
      },
    )
    assert.equal(production.migrationFile, 'db/migrations/20260816_identity_recovery.sql')
    assertPostgresTestDiscovered('identity-recovery-postgres.test.ts')
  })

  test('identity rotation is additive, schema-complete, and covered by the existing identity PostgreSQL gate', () => {
    const migration = readFileSync(identityRotationMigrationUrl, 'utf8')
    const uncommented = migration.replace(/^\s*--.*$/gm, '')
    const statements = splitSqlStatements(migration)

    assert.doesNotMatch(uncommented, /^\s*(?:DROP\s+TABLE|DELETE|TRUNCATE)\b/im)
    assert.match(uncommented, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+resident_key_rotations/i)
    assert.match(uncommented, /replacement_secret_hash\s+TEXT/i)
    assert.doesNotMatch(uncommented, /\breplacement_secret\s+TEXT\b/i)
    assert.match(uncommented, /replacement_secret_hash\s+IS\s+NULL/i)
    for (const attemptKind of ['rotation_begin', 'rotation_confirm']) {
      assert.match(uncommented, new RegExp(`'${attemptKind}'`))
      assert.match(fullSchema, new RegExp(`'${attemptKind}'`))
    }

    const freshInstallStatements = new Set(splitSqlStatements(fullSchema).map(statement =>
      statement.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').trim()
    ))
    const rotationObjects = statements.filter(statement =>
      /^\s*CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s+IF\s+NOT\s+EXISTS\b/i.test(statement)
    )
    assert.ok(rotationObjects.length >= 2)
    for (const statement of rotationObjects) {
      const normalized = statement.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').trim()
      assert.ok(
        freshInstallStatements.has(normalized),
        'db/schema.sql drifted from the reviewed identity-rotation object',
      )
    }

    assertPostgresTestDiscovered('identity-recovery-postgres.test.ts')
    assert.equal(
      existsSync(new URL('../../test/integration/identity-rotation-postgres.test.ts', import.meta.url)),
      false,
      'identity rotation should stay covered by the existing identity integration suite',
    )
  })

  test('initial recovery codes use two additive normalized pending tables', () => {
    const migration = readFileSync(initialRecoveryCodesMigrationUrl, 'utf8')
    const uncommented = migration.replace(/^\s*--.*$/gm, '')
    const statements = splitSqlStatements(migration)

    assert.equal(statements.length, 2)
    assert.doesNotMatch(uncommented, /^\s*(?:ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE)\b/im)
    assert.doesNotMatch(uncommented, /\b(?:recovery_code_hashes|new_recovery_code_hashes)\b/i)
    assert.doesNotMatch(uncommented, /\bTEXT\s*\[\s*\]/i)
    assert.match(uncommented, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+pending_resident_registration_recovery_codes/i)
    assert.match(uncommented, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+oauth_authorization_request_recovery_codes/i)

    for (const statement of statements) {
      assert.match(statement, /^\s*(?:--.*\s+)*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/i)
      assert.match(statement, /code_hash\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i)
      assert.match(statement, /code_hash\s+~\s+'\^\[0-9a-f\]\{64\}\$'/i)
      assert.match(statement, /ordinal\s+SMALLINT\s+NOT\s+NULL\s+CHECK\s*\(ordinal\s+BETWEEN\s+1\s+AND\s+8\)/i)
      assert.match(statement, /ON\s+DELETE\s+CASCADE/i)
    }
  })

  test('initial recovery codes are selected as one separate preview or production migration', () => {
    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'initial-recovery-codes'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, 'db/migrations/20260817_initial_recovery_codes.sql')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'initial-recovery-codes'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'initial-recovery-codes-release',
      },
    )
    assert.equal(production.migrationFile, 'db/migrations/20260817_initial_recovery_codes.sql')

    assertPostgresTestDiscovered('identity-recovery-postgres.test.ts')
    assertPostgresTestDiscovered('oauth-postgres.test.ts')
  })
}
