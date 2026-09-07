import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolveMigrationRun, splitSqlStatements } from '../../scripts/migrate.ts'
import { packageJson } from '../helpers/deploy-safety-fixtures/release-documents.ts'
import { fullSchema, paymentAttemptsMigrationUrl, paymentResponseReplayMigrationUrl, paymentResponseBodyReplayMigrationUrl, paymentResponseBodyRolloutMigrationUrl, paymentResponseBodyValidationMigrationUrl, paymentRecoveryTriggerRepairMigrationUrl, paymentLateFinalityRecheckMigrationUrl } from '../helpers/deploy-safety-fixtures/migration-sources.ts'

export function registerPaymentMigrationsTests(): void {
  test('payment attempts are an explicitly selected additive release', () => {
    const paymentAttemptsMigration = readFileSync(paymentAttemptsMigrationUrl, 'utf8')
    const uncommented = paymentAttemptsMigration.replace(/^\s*--.*$/gm, '')
    const statements = splitSqlStatements(paymentAttemptsMigration)

    assert.ok(statements.length >= 10)
    assert.doesNotMatch(uncommented, /^\s*(?:DROP\s+TABLE|DELETE|TRUNCATE)\b/im)
    assert.match(uncommented, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+payment_attempts/i)
    assert.match(uncommented, /public_id\s+TEXT\s+PRIMARY\s+KEY/i)
    assert.match(uncommented, /status\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(status\s+IN\s*\(\s*'settling',\s*'payment_pending',\s*'completed',\s*'invalid',\s*'expired',\s*'needs_review',\s*'legacy_completed'\s*\)\)/i)
    assert.match(uncommented, /ADD\s+CONSTRAINT\s+payment_attempts_status_check\s+CHECK\s*\(status\s+IN\s*\(\s*'settling',\s*'payment_pending',\s*'completed',\s*'invalid',\s*'expired',\s*'needs_review',\s*'founder_review',\s*'legacy_completed',\s*'credit_returned'\s*\)\)/i)
    assert.match(uncommented, /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+payment_attempts_x402_nonce/i)
    assert.match(uncommented, /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+payment_attempts_one_live_target/i)
    assert.match(uncommented, /INSERT\s+INTO\s+payment_attempts/i)
    assert.match(uncommented, /DROP\s+TRIGGER\s+IF\s+EXISTS\s+sale_payments_match_world_offer\s+ON\s+sale_payments/i)

    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'payment-attempts'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, 'db/migrations/20260816_payment_attempts.sql')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'payment-attempts'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'payment-attempts-release',
      },
    )
    assert.equal(production.migrationFile, 'db/migrations/20260816_payment_attempts.sql')
  })

  test('payment response replay is an explicitly selected idempotent function repair', () => {
    const migration = readFileSync(paymentResponseReplayMigrationUrl, 'utf8')
    const uncommented = migration.replace(/^\s*--.*$/gm, '')
    const statements = splitSqlStatements(migration)

    assert.equal(statements.length, 2)
    assert.match(uncommented, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+complete_payment_attempt/i)
    assert.match(uncommented, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+protect_payment_attempt_history/i)
    assert.match(uncommented, /__1f3d9_x402_response_v1/i)
    assert.doesNotMatch(uncommented, /^\s*(?:DROP\s+TABLE|ALTER\s+TABLE|DELETE|TRUNCATE)\b/im)

    assert.match(fullSchema, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+protect_payment_attempt_history/i)
    assert.match(fullSchema, /OLD\.status\s*=\s*'payment_pending'[\s\S]*'expired'/i)
    assert.match(fullSchema, /OLD\.status\s*=\s*'expired'[\s\S]*'founder_review'/i)

    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'payment-response-replay'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, 'db/migrations/20260816_payment_response_replay.sql')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'payment-response-replay'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'payment-response-replay-release',
      },
    )
    assert.equal(production.migrationFile, 'db/migrations/20260816_payment_response_replay.sql')
  })

  test('the applied byte-exact replay migration remains byte-for-byte immutable', () => {
    const migration = readFileSync(paymentResponseBodyReplayMigrationUrl)
    assert.equal(
      createHash('sha256').update(migration).digest('hex'),
      'f2bb76aba013c5ff493920bae6d481106781e10cacd78ab28211614b27b12feb',
    )
    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'payment-response-body-replay'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, 'db/migrations/20260817_payment_response_body_replay.sql')
  })

  test('byte-exact payment replay has an explicitly selected lock-safe rollout', () => {
    const migration = readFileSync(paymentResponseBodyRolloutMigrationUrl, 'utf8')
    const uncommented = migration.replace(/^\s*--.*$/gm, '')
    const constraintBlock = uncommented.match(
      /ADD\s+CONSTRAINT\s+payment_attempts_response_body_bytes_valid[\s\S]*?END\s+IF\s*;/i,
    )?.[0] ?? ''

    assert.match(uncommented, /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+response_body_bytes\s+BYTEA/i)
    assert.match(constraintBlock, /\)\s+NOT\s+VALID\s*;\s*END\s+IF\s*;$/i)
    assert.doesNotMatch(uncommented, /VALIDATE\s+CONSTRAINT/i)
    assert.match(uncommented, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+complete_payment_attempt/i)
    assert.match(uncommented, /completion_response_body\s+BYTEA/i)
    for (const statement of splitSqlStatements(migration)) {
      assert.doesNotMatch(
        statement.replace(/^\s*--.*$/gm, '').trim(),
        /^(?:UPDATE|DELETE|TRUNCATE|DROP\s+TABLE|DROP\s+COLUMN)\b/i,
      )
    }

    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'payment-response-body-rollout'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, 'db/migrations/20260818_payment_response_body_rollout.sql')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'payment-response-body-rollout'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'payment-response-body-rollout-release',
      },
    )
    assert.equal(production.migrationFile, 'db/migrations/20260818_payment_response_body_rollout.sql')
  })

  test('byte-exact response constraint validation is one separately committed named migration', () => {
    const migration = readFileSync(paymentResponseBodyValidationMigrationUrl, 'utf8')
    const statements = splitSqlStatements(migration)
      .map(statement => statement.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean)
    assert.equal(statements.length, 1)
    assert.match(
      statements[0] ?? '',
      /^ALTER\s+TABLE\s+payment_attempts\s+VALIDATE\s+CONSTRAINT\s+payment_attempts_response_body_bytes_valid\s*;?$/i,
    )

    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'payment-response-body-validate'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, 'db/migrations/20260818_payment_response_body_validate.sql')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'payment-response-body-validate'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'payment-response-body-validate-release',
      },
    )
    assert.equal(production.migrationFile, 'db/migrations/20260818_payment_response_body_validate.sql')
  })

  test('payment recovery trigger repair is an explicitly selected function correction', () => {
    const migration = readFileSync(paymentRecoveryTriggerRepairMigrationUrl, 'utf8')
    const uncommented = migration.replace(/^\s*--.*$/gm, '')
    const statements = splitSqlStatements(migration)

    assert.equal(statements.length, 1)
    assert.match(uncommented, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+protect_payment_attempt_history/i)
    assert.match(uncommented, /OLD\.status\s*=\s*'payment_pending'[\s\S]*'expired'/i)
    assert.match(uncommented, /OLD\.status\s*=\s*'expired'[\s\S]*'founder_review'/i)
    assert.doesNotMatch(uncommented, /^\s*(?:DROP\s+TABLE|DELETE|TRUNCATE)\b/im)

    assert.match(fullSchema, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+protect_payment_attempt_history/i)
    assert.match(fullSchema, /OLD\.status\s*=\s*'payment_pending'[\s\S]*'expired'/i)
    assert.match(fullSchema, /OLD\.status\s*=\s*'expired'[\s\S]*'founder_review'/i)

    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'payment-recovery-trigger-repair'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, 'db/migrations/20260823_payment_recovery_trigger_repair.sql')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'payment-recovery-trigger-repair'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'payment-recovery-trigger-repair-release',
      },
    )
    assert.equal(production.migrationFile, 'db/migrations/20260823_payment_recovery_trigger_repair.sql')
    assert.match(
      packageJson.scripts['migrate:preview:payment-recovery-trigger-repair'] ?? '',
      /--target preview --migration payment-recovery-trigger-repair$/,
    )
    assert.match(
      packageJson.scripts['migrate:production:payment-recovery-trigger-repair'] ?? '',
      /--target production --migration payment-recovery-trigger-repair$/,
    )
  })

  test('late-finality recheck guard is an explicitly selected immutable-history correction', () => {
    const migration = readFileSync(paymentLateFinalityRecheckMigrationUrl, 'utf8')
    const uncommented = migration.replace(/^\s*--.*$/gm, '')
    assert.equal(splitSqlStatements(migration).length, 1)
    assert.match(uncommented, /OLD\.status\s*=\s*'expired'[\s\S]*NEW\.status\s*=\s*'founder_review'/i)
    assert.match(uncommented, /OLD\.finalized_block_number\s+IS\s+NULL[\s\S]*OR\s+ROW\(/i)
    assert.doesNotMatch(uncommented, /^\s*(?:DROP\s+TABLE|DELETE|TRUNCATE)\b/im)

    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'payment-late-finality-recheck'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, 'db/migrations/20260825_payment_late_finality_recheck.sql')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'payment-late-finality-recheck'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'payment-late-finality-recheck-release',
      },
    )
    assert.equal(production.migrationFile, 'db/migrations/20260825_payment_late_finality_recheck.sql')
    assert.match(
      packageJson.scripts['migrate:preview:payment-late-finality-recheck'] ?? '',
      /--target preview --migration payment-late-finality-recheck$/,
    )
    assert.match(
      packageJson.scripts['migrate:production:payment-late-finality-recheck'] ?? '',
      /--target production --migration payment-late-finality-recheck$/,
    )
  })
}
