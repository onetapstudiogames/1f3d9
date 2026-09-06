import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  readFileSync,
} from 'node:fs'
import {
  prepareMigrationExecution,
  resolveMigrationRun,
  splitSqlStatements,
} from '../../scripts/migrate.ts'
import {
  migrationDdl,
  schemaDdl,
} from '../helpers/migrate-fixtures/index.ts'

export function registerMigrationReleaseTests(): void {
  const thingMakerMigrationFile = 'db/migrations/20260822_thing_maker.sql' as const
  const laterHolderMarksMigrationFile = 'db/migrations/20260822_later_holder_marks.sql' as const
  const paymentRecoveryTriggerRepairMigrationFile =
    'db/migrations/20260823_payment_recovery_trigger_repair.sql' as const
  const paymentLateFinalityRecheckMigrationFile =
    'db/migrations/20260825_payment_late_finality_recheck.sql' as const
  const runtimeLogsMigrationFile =
    'db/migrations/20260826_runtime_logs.sql' as const

  test('thing-maker migration derives one authenticated immutable birth actor and fails closed', () => {
    const migration = migrationDdl(thingMakerMigrationFile)

    assert.match(
      migration,
      /LOCK\s+TABLE\s+residents\s*,\s*things\s*,\s*events\s+IN\s+SHARE\s+ROW\s+EXCLUSIVE\s+MODE/iu,
      'history and thing writes must stay frozen through validation and backfill',
    )
    assert.match(migration, /kind\s+IN\s*\(\s*'thing_created'\s*,\s*'thing_crafted'\s*\)/iu)
    assert.match(migration, /JOIN\s+residents[\s\S]*handle\s*=\s*(?:creation_)?event\.actor/iu)
    assert.match(
      migration,
      /authenticated_actor\.joined_at\s*<=\s*creation_event\.at/iu,
      'a later resident must not retroactively authenticate an older actor handle',
    )
    assert.match(migration, /(?:creation_)?event\.at\s*=\s*thing\.created_at/iu)
    assert.match(migration, /detail\s*->>\s*'kind_id'[\s\S]*birth_revision/iu)
    assert.match(migration, /COUNT\s*\([^)]*(?:creation_)?event\.id[^)]*\)\s*<>\s*1/iu)
    assert.match(migration, /malformed\s+or\s+orphan\s+creation\s+event\s+ids/iu)
    assert.match(migration, /maker_id\s+IS\s+DISTINCT\s+FROM[\s\S]*authenticated/iu)
    assert.doesNotMatch(migration, /LIMIT\s+25/iu, 'the failure must name every unresolved record')
    assert.doesNotMatch(
      migration,
      /SET\s+maker_id\s*=\s*(?:things?\.)?owner_id/iu,
      'current ownership is not creation evidence',
    )
    assert.doesNotMatch(
      migration,
      /SET\s+maker_id\s*=[^;]*(?:name|body)/iu,
      'mutable prose is not creation evidence',
    )
    assert.match(migration, /ALTER\s+COLUMN\s+maker_id\s+SET\s+NOT\s+NULL/iu)
    assert.match(migration, /FOREIGN\s+KEY\s*\(maker_id\)[\s\S]*REFERENCES\s+residents\s*\(id\)[\s\S]*ON\s+DELETE\s+RESTRICT/iu)
    assert.match(migration, /NEW\.maker_id\s+IS\s+DISTINCT\s+FROM\s+OLD\.maker_id/iu)
    assert.equal(prepareMigrationExecution(thingMakerMigrationFile, migration).mode, 'transactional')
  })

  test('thing-maker is selected as one explicit preview or production migration', () => {
    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'thing-maker'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, thingMakerMigrationFile)
    assert.equal(preview.executionMode, 'transactional')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'thing-maker'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'thing-maker-release',
      },
    )
    assert.equal(production.migrationFile, thingMakerMigrationFile)
    assert.equal(production.executionMode, 'transactional')
  })

  test('later-holder marks are selected as one explicit transactional preview or production migration', () => {
    const migration = migrationDdl(laterHolderMarksMigrationFile)
    assert.match(migration, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+thing_later_holder_marks/iu)
    assert.match(migration, /CREATE\s+TRIGGER\s+thing_later_holder_marks_check_eligibility/iu)
    assert.match(migration, /CREATE\s+TRIGGER\s+things_end_later_holder_mark/iu)
    assert.equal(prepareMigrationExecution(laterHolderMarksMigrationFile, migration).mode, 'transactional')

    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'later-holder-marks'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, laterHolderMarksMigrationFile)
    assert.equal(preview.executionMode, 'transactional')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'later-holder-marks'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'later-holder-marks-release',
      },
    )
    assert.equal(production.migrationFile, laterHolderMarksMigrationFile)
    assert.equal(production.executionMode, 'transactional')
  })

  test('payment recovery trigger repair is selected as one explicit transactional preview or production migration', () => {
    const migration = migrationDdl(paymentRecoveryTriggerRepairMigrationFile)
    assert.match(migration, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+protect_payment_attempt_history/iu)
    assert.match(migration, /payment recovery window is immutable/iu)
    assert.match(migration, /payment_pending',\s*'completed',\s*'invalid',\s*'expired'/iu)
    assert.match(migration, /OLD\.status\s*=\s*'expired'[\s\S]*NEW\.status\s*=\s*'founder_review'/iu)
    assert.equal(
      prepareMigrationExecution(paymentRecoveryTriggerRepairMigrationFile, migration).mode,
      'transactional',
    )

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
    assert.equal(preview.migrationFile, paymentRecoveryTriggerRepairMigrationFile)
    assert.equal(preview.executionMode, 'transactional')

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
    assert.equal(production.migrationFile, paymentRecoveryTriggerRepairMigrationFile)
    assert.equal(production.executionMode, 'transactional')
  })

  test('late-finality recheck guard is one explicit transactional preview or production migration', () => {
    const migration = migrationDdl(paymentLateFinalityRecheckMigrationFile)
    assert.equal(splitSqlStatements(migration).length, 1)
    assert.match(migration, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+protect_payment_attempt_history/iu)
    assert.match(migration, /OLD\.status\s*=\s*'expired'[\s\S]*NEW\.status\s*=\s*'founder_review'/iu)
    assert.match(migration, /OLD\.finalized_block_number\s+IS\s+NULL[\s\S]*OR\s+ROW\(/iu)
    assert.equal(
      prepareMigrationExecution(paymentLateFinalityRecheckMigrationFile, migration).mode,
      'transactional',
    )

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
    assert.equal(preview.migrationFile, paymentLateFinalityRecheckMigrationFile)
    assert.equal(preview.executionMode, 'transactional')

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
    assert.equal(production.migrationFile, paymentLateFinalityRecheckMigrationFile)
    assert.equal(production.executionMode, 'transactional')
  })

  test('runtime logs are one explicit guarded transactional preview or production migration', () => {
    const migration = migrationDdl(runtimeLogsMigrationFile)
    assert.match(migration, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+runtime_logs/iu)
    assert.match(
      migration,
      /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+runtime_log_retention_state/iu,
    )
    assert.match(migration, /runtime log table conflicts with the reviewed columns/iu)
    assert.match(migration, /runtime log table conflicts with the reviewed received_at default/iu)
    assert.match(migration, /pg_get_constraintdef/iu)
    assert.match(migration, /runtime log retention state conflicts with the reviewed columns/iu)
    assert.match(migration, /runtime log retention state conflicts with the reviewed singleton default/iu)
    assert.match(migration, /runtime log retention state conflicts with the reviewed constraints/iu)
    assert.match(migration, /runtime_logs_project_timestamp/iu)
    assert.match(migration, /runtime_logs_retention/iu)
    assert.match(migration, /runtime log table conflicts with the reviewed project timestamp index/iu)
    assert.match(migration, /runtime log table conflicts with the reviewed retention index/iu)
    assert.match(
      schemaDdl,
      /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+runtime_log_retention_state/iu,
    )
    assert.equal(
      prepareMigrationExecution(runtimeLogsMigrationFile, migration).mode,
      'transactional',
    )

    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'runtime-logs'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, runtimeLogsMigrationFile)
    assert.equal(preview.executionMode, 'transactional')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'runtime-logs'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'runtime-logs-release',
      },
    )
    assert.equal(production.migrationFile, runtimeLogsMigrationFile)
    assert.equal(production.executionMode, 'transactional')

    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> }
    assert.match(packageJson.scripts?.['migrate:preview:runtime-logs'] ?? '', /--migration runtime-logs/u)
    assert.match(packageJson.scripts?.['migrate:production:runtime-logs'] ?? '', /--migration runtime-logs/u)
    assert.match(packageJson.scripts?.['test:postgres'] ?? '', /test\/integration\/\*\.test\.ts/u)
    assert.equal(
      existsSync(new URL('../../test/integration/runtime-logs-postgres.test.ts', import.meta.url)),
      true,
    )
  })

  test('prepaid city credit is an explicitly selected transactional payment migration', () => {
    const migrationFile = 'db/migrations/20260826_prepaid_city_credit.sql' as const
    const migration = readFileSync(new URL(`../../${migrationFile}`, import.meta.url), 'utf8')
    assert.equal(prepareMigrationExecution(migrationFile, migration).mode, 'transactional')

    const previewEnvironment = {
      CONFIRM_PREPAID_CITY_CREDIT: 'INSTALL_PREPAID_CITY_CREDIT_AND_PAYPAL_CUSTODY',
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    }
    assert.throws(
      () => resolveMigrationRun(
        ['--target', 'preview', '--migration', 'prepaid-city-credit'],
        { ...previewEnvironment, CONFIRM_PREPAID_CITY_CREDIT: undefined },
      ),
      /CONFIRM_PREPAID_CITY_CREDIT/iu,
    )
    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'prepaid-city-credit'],
      previewEnvironment,
    )
    assert.equal(preview.migrationFile, migrationFile)
    assert.equal(preview.executionMode, 'transactional')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'prepaid-city-credit'],
      {
        CONFIRM_PREPAID_CITY_CREDIT: 'INSTALL_PREPAID_CITY_CREDIT_AND_PAYPAL_CUSTODY',
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'prepaid-city-credit-release',
      },
    )
    assert.equal(production.migrationFile, migrationFile)

    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> }
    assert.match(
      packageJson.scripts?.['migrate:preview:prepaid-city-credit'] ?? '',
      /--target preview --migration prepaid-city-credit$/u,
    )
    assert.match(
      packageJson.scripts?.['migrate:production:prepaid-city-credit'] ?? '',
      /--target production --migration prepaid-city-credit$/u,
    )
  })

  test('PayPal credit disputes are an explicitly selected guarded payment migration', () => {
    const migrationFile = 'db/migrations/20260827_paypal_credit_disputes.sql' as const
    const previewEnvironment = {
      CONFIRM_PAYPAL_CREDIT_DISPUTES: 'INSTALL_PAYPAL_CREDIT_DISPUTE_CUSTODY',
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    }
    assert.throws(
      () => resolveMigrationRun(
        ['--target', 'preview', '--migration', 'paypal-credit-disputes'],
        { ...previewEnvironment, CONFIRM_PAYPAL_CREDIT_DISPUTES: undefined },
      ),
      /CONFIRM_PAYPAL_CREDIT_DISPUTES/iu,
    )

    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'paypal-credit-disputes'],
      previewEnvironment,
    )
    assert.equal(preview.migrationFile, migrationFile)
    assert.equal(preview.executionMode, 'transactional')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'paypal-credit-disputes'],
      {
        CONFIRM_PAYPAL_CREDIT_DISPUTES: 'INSTALL_PAYPAL_CREDIT_DISPUTE_CUSTODY',
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'paypal-credit-disputes-release',
      },
    )
    assert.equal(production.migrationFile, migrationFile)
    assert.equal(production.executionMode, 'transactional')

    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> }
    assert.match(
      packageJson.scripts?.['migrate:preview:paypal-credit-disputes'] ?? '',
      /--target preview --migration paypal-credit-disputes$/u,
    )
    assert.match(
      packageJson.scripts?.['migrate:production:paypal-credit-disputes'] ?? '',
      /--target production --migration paypal-credit-disputes$/u,
    )
  })
}
