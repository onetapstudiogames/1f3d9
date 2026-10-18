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

  test('the MCP call log is one explicit guarded transactional preview or production migration', () => {
    const migrationFile = 'db/migrations/20261009_mcp_call_log.sql' as const
    const migration = migrationDdl(migrationFile)
    assert.match(migration, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+mcp_call_log\s*\(/iu)
    assert.match(migration, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+mcp_call_log_retention_state/iu)
    assert.match(migration, /mcp call log table conflicts with the reviewed columns/iu)
    assert.match(migration, /mcp call log table conflicts with the reviewed constraints/iu)
    assert.match(migration, /mcp call log table conflicts with the reviewed indexes/iu)
    assert.match(migration, /mcp call log retention state conflicts with the reviewed shape/iu)
    assert.doesNotMatch(migration, /REFERENCES\s+residents/iu, 'the log holds no resident identity')
    assert.doesNotMatch(migration, /resident_id/iu, 'the log holds no resident identity')
    assert.doesNotMatch(migration, /^\s*(?:user_agent|ip_address|arguments)\s+TEXT/imu, 'only closed fields are stored')
    for (const statement of [
      'CREATE TABLE IF NOT EXISTS mcp_call_log (',
      'CREATE TABLE IF NOT EXISTS mcp_call_log_retention_state (',
      'CREATE INDEX IF NOT EXISTS mcp_call_log_at',
    ]) assert.ok(schemaDdl.includes(statement), `db/schema.sql mirrors ${statement}`)
    assert.equal(schemaDdl.includes('mcp_call_log_resident'), false, 'db/schema.sql has no resident index')
    assert.equal(prepareMigrationExecution(migrationFile, migration).mode, 'transactional')

    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'mcp-call-log'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, migrationFile)
    assert.equal(preview.executionMode, 'transactional')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'mcp-call-log'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'mcp-call-log-release',
      },
    )
    assert.equal(production.migrationFile, migrationFile)
    assert.equal(production.executionMode, 'transactional')

    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> }
    assert.equal(packageJson.scripts?.['migrate:preview:mcp-call-log'],
      'node --experimental-strip-types scripts/migrate.ts --target preview --migration mcp-call-log')
    assert.equal(packageJson.scripts?.['migrate:production:mcp-call-log'],
      'node --experimental-strip-types scripts/migrate.ts --target production --migration mcp-call-log')
    assert.equal(
      existsSync(new URL('../../test/integration/mcp-call-log-postgres.test.ts', import.meta.url)),
      true,
    )
  })

  test('the app door call log widening is one explicit guarded transactional preview or production migration', () => {
    const migrationFile = 'db/migrations/20261009_mcp_call_log_app_door.sql' as const
    const migration = migrationDdl(migrationFile)
    assert.match(
      migration,
      /ALTER\s+TABLE\s+mcp_call_log\s+DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+mcp_call_log_door_known,\s*ADD\s+CONSTRAINT\s+mcp_call_log_door_known\s+CHECK\s*\(\s*door\s+IN\s*\(\s*'mcp',\s*'connect',\s*'app'\s*\)\s*\)/iu,
    )
    assert.match(migration, /mcp call log table conflicts with the reviewed columns/iu)
    assert.match(migration, /mcp call log table conflicts with the reviewed constraints/iu)
    assert.match(migration, /mcp call log door check does not name exactly the three doors/iu)
    assert.doesNotMatch(migration, /resident_id/iu, 'the log still holds no resident identity')
    assert.doesNotMatch(migration, /CREATE\s+TABLE/iu, 'it only widens the existing table')
    assert.ok(
      schemaDdl.includes("CHECK (door IN ('mcp', 'connect', 'app'))"),
      'db/schema.sql mirrors the three-door check',
    )
    assert.equal(prepareMigrationExecution(migrationFile, migration).mode, 'transactional')
    assert.match(migration, /^BEGIN;\s+SET LOCAL lock_timeout = '5s';\s+SET LOCAL statement_timeout = '120s';/u)

    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'mcp-call-log-app-door'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, migrationFile)
    assert.equal(preview.executionMode, 'transactional')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'mcp-call-log-app-door'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'mcp-call-log-app-door-release',
      },
    )
    assert.equal(production.migrationFile, migrationFile)
    assert.equal(production.executionMode, 'transactional')

    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> }
    assert.equal(packageJson.scripts?.['migrate:preview:mcp-call-log-app-door'],
      'node --experimental-strip-types scripts/migrate.ts --target preview --migration mcp-call-log-app-door')
    assert.equal(packageJson.scripts?.['migrate:production:mcp-call-log-app-door'],
      'node --experimental-strip-types scripts/migrate.ts --target production --migration mcp-call-log-app-door')
  })

  test('the moderation holds migration is one guarded, additive, transactional preview or production migration', () => {
    const migrationFile = 'db/migrations/20261015_moderation_holds.sql' as const
    const migration = migrationDdl(migrationFile)
    assert.match(migration, /^BEGIN;\s+SET LOCAL lock_timeout = '5s';\s+SET LOCAL statement_timeout = '120s';/u)
    assert.equal(prepareMigrationExecution(migrationFile, migration).mode, 'transactional')
    assert.match(migration, /a check other than moderation_actions_action_check restricts moderation_actions\.action/u)
    assert.match(migration, /DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+moderation_actions_action_check/iu)
    assert.match(migration, /moderation_actions conflicts with the reviewed hold columns/u)
    assert.match(migration, /moderation_actions is missing a validated hold constraint/u)
    for (const name of [
      'moderation_actions_action_allowed', 'moderation_actions_target_type_allowed',
      'moderation_actions_rule_word_allowed', 'moderation_actions_at_once_for_allowed',
      'moderation_actions_smaller_step_bytes', 'moderation_actions_hold_numbers',
      'moderation_actions_hold_fields', 'moderation_actions_smaller_step_record_fk',
    ]) {
      assert.match(migration, new RegExp(`ADD CONSTRAINT ${name}\\b[\\s\\S]*?NOT VALID;`, 'u'), name)
      assert.match(migration, new RegExp(`VALIDATE CONSTRAINT ${name};`, 'u'), name)
    }
    assert.doesNotMatch(migration, /DROP\s+(?:TABLE|COLUMN)|DELETE\s+FROM|UPDATE\s+moderation_actions|TRUNCATE/iu)
    assert.doesNotMatch(migration, /ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/iu, 'every column add is repeatable')

    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'moderation-holds'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, migrationFile)
    assert.equal(preview.executionMode, 'transactional')
    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'moderation-holds'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'pre-moderation-holds-20261015',
      },
    )
    assert.equal(production.migrationFile, migrationFile)
    assert.equal(production.executionMode, 'transactional')

    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> }
    assert.equal(packageJson.scripts?.['migrate:preview:moderation-holds'],
      'node --experimental-strip-types scripts/migrate.ts --target preview --migration moderation-holds')
    assert.equal(packageJson.scripts?.['migrate:production:moderation-holds'],
      'node --experimental-strip-types scripts/migrate.ts --target production --migration moderation-holds')

    // db/schema.sql carries the same statements, byte for byte, so a fresh city and a
    // migrated one end in the same shape.
    const body = migration.slice(
      migration.indexOf('DO $moderation_holds_guard$'),
      migration.indexOf('DO $moderation_holds_shape$'),
    ).trimEnd()
    assert.ok(body.length > 1_000)
    assert.ok(schemaDdl.includes(body), 'db/schema.sql mirrors the moderation holds statements')
  })

  test('the moderation reviews migration is one guarded, additive, transactional preview or production migration', () => {
    const migrationFile = 'db/migrations/20261015_moderation_reviews.sql' as const
    const migration = migrationDdl(migrationFile)
    assert.match(migration, /^BEGIN;\s+SET LOCAL lock_timeout = '5s';\s+SET LOCAL statement_timeout = '120s';/u)
    assert.equal(prepareMigrationExecution(migrationFile, migration).mode, 'transactional')
    assert.match(migration, /a check other than flags_target_type_check restricts flags\.target_type/u)
    assert.match(migration, /flags_target_type_check is not the reviewed list of flag targets/u)
    assert.match(migration, /ADD CONSTRAINT flags_target_type_check\b[\s\S]*?'moderation'[\s\S]*?NOT VALID;/u)
    assert.match(migration, /VALIDATE CONSTRAINT flags_target_type_check;/u)
    assert.match(migration, /CREATE TABLE IF NOT EXISTS moderation_replies/u)
    assert.match(migration, /moderation_replies conflicts with the reviewed reply columns/u)
    assert.match(migration, /moderation_replies is missing its append-only trigger/u)
    assert.doesNotMatch(migration, /DROP\s+(?:TABLE|COLUMN)|DELETE\s+FROM|UPDATE\s+flags|TRUNCATE/iu)

    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'moderation-reviews'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, migrationFile)
    assert.equal(preview.executionMode, 'transactional')
    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'moderation-reviews'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'pre-moderation-reviews-20261015',
      },
    )
    assert.equal(production.migrationFile, migrationFile)
    assert.equal(production.executionMode, 'transactional')

    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> }
    assert.equal(packageJson.scripts?.['migrate:preview:moderation-reviews'],
      'node --experimental-strip-types scripts/migrate.ts --target preview --migration moderation-reviews')
    assert.equal(packageJson.scripts?.['migrate:production:moderation-reviews'],
      'node --experimental-strip-types scripts/migrate.ts --target production --migration moderation-reviews')

    // db/schema.sql carries the same statements, byte for byte, before the same-room-talk
    // block that closes it, so a fresh city and a migrated one end in the same shape.
    const body = migration.slice(
      migration.indexOf('DO $moderation_reviews_guard$'),
      migration.indexOf('DO $moderation_reviews_shape$'),
    ).trimEnd()
    assert.ok(body.length > 1_000)
    assert.ok(schemaDdl.includes(body), 'db/schema.sql mirrors the moderation reviews statements')
    assert.ok(
      schemaDdl.indexOf(body) < schemaDdl.indexOf('DO $same_room_talk_widen_targets$'),
      'the widened flag check is in place before the talk block checks for it',
    )
  })

  test('the place feed migration is one guarded, additive, transactional preview or production migration', () => {
    const migrationFile = 'db/migrations/20261016_place_feed.sql' as const
    const migration = migrationDdl(migrationFile)
    assert.match(migration, /^BEGIN;\s+SET LOCAL lock_timeout = '5s';\s+SET LOCAL statement_timeout = '120s';/u)
    assert.equal(prepareMigrationExecution(migrationFile, migration).mode, 'transactional')
    assert.match(migration, /place feed migration needs the not-null boolean places\.quiet/u)
    assert.match(migration, /places_feed_needs_quiet already exists with a different definition/u)
    // One ALTER TABLE adds the column and the check NOT VALID; the check is validated alone.
    assert.equal(migration.match(/ALTER TABLE places\b/gu)?.length, 2)
    assert.match(migration, /ALTER TABLE places\s+ADD COLUMN IF NOT EXISTS feed BOOLEAN NOT NULL DEFAULT FALSE,\s+ADD CONSTRAINT places_feed_needs_quiet CHECK \(NOT feed OR quiet\) NOT VALID;/u)
    assert.match(migration, /\nALTER TABLE places VALIDATE CONSTRAINT places_feed_needs_quiet;\n/u)
    assert.match(migration, /places\.feed is not the reviewed not-null boolean with default false/u)
    assert.doesNotMatch(migration, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT)|DELETE\s+FROM|UPDATE\s+places|TRUNCATE/iu)

    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'place-feed'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, migrationFile)
    assert.equal(preview.executionMode, 'transactional')
    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'place-feed'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'pre-place-feed-20261016',
      },
    )
    assert.equal(production.migrationFile, migrationFile)
    assert.equal(production.executionMode, 'transactional')

    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> }
    assert.equal(packageJson.scripts?.['migrate:preview:place-feed'],
      'node --experimental-strip-types scripts/migrate.ts --target preview --migration place-feed')
    assert.equal(packageJson.scripts?.['migrate:production:place-feed'],
      'node --experimental-strip-types scripts/migrate.ts --target production --migration place-feed')

    // db/schema.sql carries the same statements, byte for byte, so a fresh city and a
    // migrated one end in the same shape.
    const body = migration.slice(
      migration.indexOf('DO $place_feed_guard$'),
      migration.indexOf('DO $place_feed_shape$'),
    ).trimEnd()
    assert.ok(body.length > 1_000)
    assert.ok(schemaDdl.includes(body), 'db/schema.sql mirrors the place feed statements')
  })

  test('the resident settings migration is one guarded, additive, transactional preview or production migration', () => {
    const migrationFile = 'db/migrations/20261017_resident_settings.sql' as const
    const migration = migrationDdl(migrationFile)
    assert.match(migration, /^BEGIN;\s+SET LOCAL lock_timeout = '5s';\s+SET LOCAL statement_timeout = '120s';/u)
    assert.equal(prepareMigrationExecution(migrationFile, migration).mode, 'transactional')
    assert.match(migration, /resident settings migration needs the residents table/u)
    assert.match(migration, /resident_settings already exists with columns this migration does not know/u)
    assert.match(migration, /CREATE TABLE IF NOT EXISTS resident_settings \(\s+resident_id INTEGER PRIMARY KEY REFERENCES residents\(id\) ON DELETE CASCADE,\s+focus\s+BOOLEAN NOT NULL DEFAULT FALSE,\s+updated_at\s+TIMESTAMPTZ NOT NULL DEFAULT now\(\)\s+\);/u)
    assert.match(migration, /resident_settings conflicts with the reviewed settings columns/u)
    assert.match(migration, /resident_settings is missing its reviewed key or foreign key/u)
    assert.doesNotMatch(migration, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT)|DELETE\s+FROM|UPDATE\s+|TRUNCATE|ALTER\s+TABLE/iu)

    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'resident-settings'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, migrationFile)
    assert.equal(preview.executionMode, 'transactional')
    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'resident-settings'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'pre-resident-settings-20261017',
      },
    )
    assert.equal(production.migrationFile, migrationFile)
    assert.equal(production.executionMode, 'transactional')

    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> }
    assert.equal(packageJson.scripts?.['migrate:preview:resident-settings'],
      'node --experimental-strip-types scripts/migrate.ts --target preview --migration resident-settings')
    assert.equal(packageJson.scripts?.['migrate:production:resident-settings'],
      'node --experimental-strip-types scripts/migrate.ts --target production --migration resident-settings')

    // db/schema.sql carries the same statements, so a fresh city and a migrated one end in
    // the same shape. Its guard alone also knows the reading filters columns a later block
    // adds (decision #157), so the file still runs twice on one database.
    const body = migration.slice(
      migration.indexOf('DO $resident_settings_guard$'),
      migration.indexOf('DO $resident_settings_shape$'),
    ).trimEnd()
    assert.ok(body.length > 500)
    const known = "AND attname NOT IN ('resident_id', 'focus', 'updated_at')"
    assert.ok(body.includes(known))
    assert.ok(schemaDdl.includes(body.replace(known, "AND attname NOT IN ('resident_id', 'focus', 'updated_at', 'encoded_text_filter', 'drawings_filter',\n        'code_like_text_filter', 'links_filter', 'emoji_filter', 'muted_words')")), 'db/schema.sql mirrors the resident settings statements')
  })

  test('the resident mutes migration is one guarded, additive, transactional preview or production migration', () => {
    const migrationFile = 'db/migrations/20261017_resident_mutes.sql' as const
    const migration = migrationDdl(migrationFile)
    assert.match(migration, /^BEGIN;\s+SET LOCAL lock_timeout = '5s';\s+SET LOCAL statement_timeout = '120s';/u)
    assert.equal(prepareMigrationExecution(migrationFile, migration).mode, 'transactional')
    assert.match(migration, /resident mutes migration needs the residents table/u)
    assert.match(migration, /resident_mutes already exists with columns this migration does not know/u)
    assert.match(migration, /CREATE TABLE IF NOT EXISTS resident_mutes \(\s+id\s+BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\s+resident_id\s+INTEGER NOT NULL REFERENCES residents\(id\) ON DELETE CASCADE,/u)
    for (const name of [
      'resident_mutes_target_type_allowed', 'resident_mutes_target_id_positive', 'resident_mutes_choice_allowed',
      'resident_mutes_allow_targets', 'resident_mutes_not_founder', 'resident_mutes_not_self', 'resident_mutes_one_choice',
    ]) assert.ok(migration.includes(`CONSTRAINT ${name}`), name)
    assert.match(migration, /resident_mutes conflicts with the reviewed mute columns/u)
    assert.match(migration, /resident_mutes is missing one of its reviewed checks, keys or its unique choice/u)
    assert.doesNotMatch(migration, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT)|DELETE\s+FROM|UPDATE\s+|TRUNCATE|ALTER\s+TABLE/iu)

    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'resident-mutes'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, migrationFile)
    assert.equal(preview.executionMode, 'transactional')
    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'resident-mutes'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'pre-resident-mutes-20261017',
      },
    )
    assert.equal(production.migrationFile, migrationFile)
    assert.equal(production.executionMode, 'transactional')

    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> }
    assert.equal(packageJson.scripts?.['migrate:preview:resident-mutes'],
      'node --experimental-strip-types scripts/migrate.ts --target preview --migration resident-mutes')
    assert.equal(packageJson.scripts?.['migrate:production:resident-mutes'],
      'node --experimental-strip-types scripts/migrate.ts --target production --migration resident-mutes')

    // db/schema.sql carries the same statements, so a fresh city and a migrated one end in
    // the same shape. Its guard alone also knows show_anyway, which the reading filters
    // block adds (decision #157), and let_gifts_through, which the waiting transfers block
    // adds (decision #158), so the file still runs twice on one database.
    const body = migration.slice(
      migration.indexOf('DO $resident_mutes_guard$'),
      migration.indexOf('DO $resident_mutes_shape$'),
    ).trimEnd()
    assert.ok(body.length > 1_000)
    const known = "'target_id', 'choice', 'created_at')"
    assert.ok(body.includes(known))
    assert.ok(schemaDdl.includes(body.replace(known, "'target_id', 'choice', 'created_at', 'show_anyway', 'let_gifts_through')")), 'db/schema.sql mirrors the resident mutes statements')
  })

  test('the reading filters migration is one guarded, additive, transactional preview or production migration', () => {
    const migrationFile = 'db/migrations/20261017_reading_filters.sql' as const
    const migration = migrationDdl(migrationFile)
    assert.match(migration, /^BEGIN;\s+SET LOCAL lock_timeout = '5s';\s+SET LOCAL statement_timeout = '120s';/u)
    assert.equal(prepareMigrationExecution(migrationFile, migration).mode, 'transactional')
    assert.match(migration, /reading filters migration needs the resident_settings and resident_mutes tables/u)
    assert.match(migration, /a reading filters column already exists with a shape this migration does not know/u)
    for (const name of [
      'resident_settings_encoded_text_filter_known', 'resident_settings_drawings_filter_known',
      'resident_settings_code_like_text_filter_known', 'resident_settings_links_filter_known',
      'resident_settings_emoji_filter_known', 'resident_settings_muted_words_count',
      'resident_mutes_show_anyway_on_allow',
    ]) {
      assert.ok(migration.includes(`ADD CONSTRAINT ${name}`), name)
      assert.ok(migration.includes(`VALIDATE CONSTRAINT ${name};`), `${name} is validated in its own statement`)
    }
    // One ALTER TABLE per table adds the columns, each with a constant default, and the
    // checks NOT VALID; the only other ALTER TABLE statements validate one check each.
    const alters = migration.match(/ALTER TABLE [a-z_]+\s+ADD COLUMN/gu) ?? []
    assert.deepEqual(alters.map(alter => alter.split(/\s+/u)[2]), ['resident_settings', 'resident_mutes'])
    assert.equal((migration.match(/ ADD COLUMN IF NOT EXISTS /gu) ?? []).length, 7)
    assert.equal((migration.match(/\) NOT VALID[,;]/gu) ?? []).length, 7)
    assert.match(migration, /resident_settings conflicts with the reviewed reading filters columns/u)
    assert.match(migration, /a reading filters check is missing, not validated, or not the reviewed check/u)
    assert.doesNotMatch(migration, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT)|DELETE\s+FROM|UPDATE\s+|TRUNCATE/iu)

    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'reading-filters'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, migrationFile)
    assert.equal(preview.executionMode, 'transactional')
    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'reading-filters'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'pre-reading-filters-20261017',
      },
    )
    assert.equal(production.migrationFile, migrationFile)
    assert.equal(production.executionMode, 'transactional')

    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> }
    assert.equal(packageJson.scripts?.['migrate:preview:reading-filters'],
      'node --experimental-strip-types scripts/migrate.ts --target preview --migration reading-filters')
    assert.equal(packageJson.scripts?.['migrate:production:reading-filters'],
      'node --experimental-strip-types scripts/migrate.ts --target production --migration reading-filters')

    // db/schema.sql carries the same statements, byte for byte, so a fresh city and a
    // migrated one end in the same shape.
    const body = migration.slice(
      migration.indexOf('DO $reading_filters_guard$'),
      migration.indexOf('DO $reading_filters_shape$'),
    ).trimEnd()
    assert.ok(body.length > 2_000)
    assert.ok(schemaDdl.includes(body), 'db/schema.sql mirrors the reading filters statements')
  })

  test('the waiting transfers migration is one guarded, additive, transactional preview or production migration', () => {
    const migrationFile = 'db/migrations/20261018_waiting_transfers.sql' as const
    const migration = migrationDdl(migrationFile)
    assert.match(migration, /^BEGIN;\s+SET LOCAL lock_timeout = '5s';\s+SET LOCAL statement_timeout = '120s';/u)
    assert.equal(prepareMigrationExecution(migrationFile, migration).mode, 'transactional')
    assert.match(migration, /waiting transfers migration needs the residents and resident_mutes tables/u)
    assert.match(migration, /waiting_transfers already exists with columns this migration does not know/u)
    assert.match(migration, /CREATE TABLE IF NOT EXISTS waiting_transfers \(\s+id\s+BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,/u)
    for (const name of [
      'waiting_transfers_asset_type_allowed', 'waiting_transfers_asset_id_positive', 'waiting_transfers_not_self',
      'waiting_transfers_answer_allowed', 'waiting_transfers_answer_complete', 'waiting_transfers_answer_detail_size',
    ]) assert.ok(migration.includes(`CONSTRAINT ${name}`), name)
    // One ALTER TABLE adds the column with a constant default and its check NOT VALID; the
    // only other ALTER TABLE validates that check in its own statement.
    const alters = migration.match(/ALTER TABLE [a-z_]+\s+ADD COLUMN/gu) ?? []
    assert.deepEqual(alters.map(alter => alter.split(/\s+/u)[2]), ['resident_mutes'])
    assert.equal((migration.match(/ ADD COLUMN IF NOT EXISTS /gu) ?? []).length, 1)
    assert.equal((migration.match(/\) NOT VALID[,;]/gu) ?? []).length, 1)
    assert.ok(migration.includes('VALIDATE CONSTRAINT resident_mutes_let_gifts_through_on_resident_mute;'))
    assert.match(migration, /waiting_transfers conflicts with the reviewed waiting transfer columns/u)
    assert.match(migration, /waiting_transfers is missing one of its reviewed checks or keys/u)
    assert.match(migration, /waiting_transfers is missing one of its reviewed indexes/u)
    assert.doesNotMatch(migration, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT)|DELETE\s+FROM|UPDATE\s+|TRUNCATE/iu)

    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'waiting-transfers'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, migrationFile)
    assert.equal(preview.executionMode, 'transactional')
    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'waiting-transfers'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'pre-waiting-transfers-20261018',
      },
    )
    assert.equal(production.migrationFile, migrationFile)
    assert.equal(production.executionMode, 'transactional')

    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> }
    assert.equal(packageJson.scripts?.['migrate:preview:waiting-transfers'],
      'node --experimental-strip-types scripts/migrate.ts --target preview --migration waiting-transfers')
    assert.equal(packageJson.scripts?.['migrate:production:waiting-transfers'],
      'node --experimental-strip-types scripts/migrate.ts --target production --migration waiting-transfers')

    // db/schema.sql carries the same statements, byte for byte, so a fresh city and a
    // migrated one end in the same shape.
    const body = migration.slice(
      migration.indexOf('DO $waiting_transfers_guard$'),
      migration.indexOf('DO $waiting_transfers_shape$'),
    ).trimEnd()
    assert.ok(body.length > 2_000)
    assert.ok(schemaDdl.includes(body), 'db/schema.sql mirrors the waiting transfers statements')
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
