import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveMigrationRun, splitSqlStatements } from '../../scripts/migrate.ts'
import { packageJson } from '../helpers/deploy-safety-fixtures/release-documents.ts'
import { fullSchema, oauthMigration, agreementAccessionMigration, openToUseMigrationUrl, sharedUseMayDestroyMigrationUrl, noteWalkToReadMigrationUrl, abilitiesWakeChanceWriteMigrationUrl, abilitiesCopyReachConvertMigrationUrl, paymentAttemptsMigrationUrl, paymentResponseReplayMigrationUrl, paymentResponseBodyRolloutMigrationUrl, paymentResponseBodyValidationMigrationUrl, identityRecoveryMigrationUrl, identityRotationMigrationUrl, initialRecoveryCodesMigrationUrl, resumableRegistrationMigrationUrl } from '../helpers/deploy-safety-fixtures/migration-sources.ts'

export function registerMigrationSelectionTests(): void {
  test('migration target must be named explicitly', () => {
    assert.throws(
      () => resolveMigrationRun([], { DATABASE_URL: 'postgres://role@example.neon.tech/db' }),
      /--target local\|preview\|production/,
    )
  })

  test('remote migration file must be named explicitly', () => {
    assert.throws(
      () => resolveMigrationRun(['--target', 'preview'], {}),
      /--migration hosted-chat-signin\|world-root-expand\|world-root-topology\|world-root-description\|world-root-drawing\|public-pagination/u,
    )
  })

  test('open-to-use is an additive, idempotent permission migration', () => {
    const migration = readFileSync(openToUseMigrationUrl, 'utf8')
    const uncommented = migration.replace(/^\s*--.*$/gm, '')
    const statements = splitSqlStatements(migration)

    assert.equal(statements.length, 1)
    assert.doesNotMatch(uncommented, /^\s*(?:DROP|UPDATE|DELETE|TRUNCATE)\b/im)
    assert.match(
      uncommented,
      /ALTER\s+TABLE\s+things\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+open_to_use\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/i,
    )
  })

  test('open-to-use is selected as one separate preview or production migration', () => {
    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'open-to-use'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, 'db/migrations/20260815_open_to_use.sql')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'open-to-use'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'open-to-use-release',
      },
    )
    assert.equal(production.migrationFile, 'db/migrations/20260815_open_to_use.sql')
  })

  test('shared-use-may-destroy is an additive, idempotent permission migration', () => {
    const migration = readFileSync(sharedUseMayDestroyMigrationUrl, 'utf8')
    const uncommented = migration.replace(/^\s*--.*$/gm, '')
    const statements = splitSqlStatements(migration)

    assert.equal(statements.length, 1)
    assert.doesNotMatch(uncommented, /^\s*(?:DROP|UPDATE|DELETE|TRUNCATE)\b/im)
    assert.match(
      uncommented,
      /ALTER\s+TABLE\s+things\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+shared_use_may_destroy\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/i,
    )
  })

  test('shared-use-may-destroy is selected as one separate preview or production migration', () => {
    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'shared-use-may-destroy'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, 'db/migrations/20260916_shared_use_may_destroy.sql')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'shared-use-may-destroy'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'shared-use-may-destroy-release',
      },
    )
    assert.equal(production.migrationFile, 'db/migrations/20260916_shared_use_may_destroy.sql')
  })

  test('note-walk-to-read is an additive, idempotent note migration', () => {
    const migration = readFileSync(noteWalkToReadMigrationUrl, 'utf8')
    const uncommented = migration.replace(/^\s*--.*$/gm, '')
    const statements = splitSqlStatements(migration)

    assert.equal(statements.length, 1)
    assert.doesNotMatch(uncommented, /^\s*(?:DROP|UPDATE|DELETE|TRUNCATE)\b/im)
    assert.match(
      uncommented,
      /ALTER\s+TABLE\s+notes\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+walk_to_read\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/i,
    )
  })

  test('note-walk-to-read is selected as one separate preview or production migration', () => {
    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'note-walk-to-read'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, 'db/migrations/20260922_note_walk_to_read.sql')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'note-walk-to-read'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'note-walk-to-read-release',
      },
    )
    assert.equal(production.migrationFile, 'db/migrations/20260922_note_walk_to_read.sql')
  })

  test('public-snapshot-walk-to-read is selected as one separate preview or production migration', () => {
    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'public-snapshot-walk-to-read'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, 'db/migrations/20260922_public_snapshot_walk_to_read.sql')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'public-snapshot-walk-to-read'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'public-snapshot-walk-to-read-release',
      },
    )
    assert.equal(production.migrationFile, 'db/migrations/20260922_public_snapshot_walk_to_read.sql')
  })

  test('the abilities-wake-chance-write migration is additive and idempotent', () => {
    const migration = readFileSync(abilitiesWakeChanceWriteMigrationUrl, 'utf8')
    const uncommented = migration.replace(/^\s*--.*$/gm, '')
    assert.doesNotMatch(uncommented, /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/im)
    assert.doesNotMatch(uncommented, /DROP\s+(?:TABLE|COLUMN|INDEX|CONSTRAINT|FUNCTION|SEQUENCE)\b/i)
    for (const statement of splitSqlStatements(migration)) {
      const trimmed = statement.replace(/^\s*--.*$/gm, '').trim()
      assert.match(
        trimmed,
        /^(?:ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS|CREATE\s+(?:TABLE|INDEX|SEQUENCE)\s+IF\s+NOT\s+EXISTS|CREATE\s+OR\s+REPLACE\s+FUNCTION|DROP\s+TRIGGER\s+IF\s+EXISTS|CREATE\s+TRIGGER)\b/i,
        `every statement must be additive and repeatable: ${trimmed.slice(0, 80)}`,
      )
    }
    for (const column of [
      /ALTER\s+TABLE\s+things\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+wake_enabled\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/i,
      /ALTER\s+TABLE\s+things\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+state\s+JSONB\s+NOT\s+NULL\s+DEFAULT\s+'\{\}'::jsonb/i,
      /ALTER\s+TABLE\s+things\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+state_version\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0/i,
      /ALTER\s+TABLE\s+places\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+rough_room\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/i,
      /ALTER\s+TABLE\s+places\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+wake_random_cap\s+SMALLINT\s+NOT\s+NULL\s+DEFAULT\s+8/i,
    ]) assert.match(uncommented, column)
    for (const table of ['thing_wake_state', 'wake_settles', 'wake_tries', 'chance_days', 'chance_rolls', 'thing_state_changes']) {
      assert.match(uncommented, new RegExp(String.raw`CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+${table}\b`, 'i'))
    }
    for (const table of ['wake_settles', 'wake_tries', 'chance_days', 'chance_rolls', 'thing_state_changes']) {
      assert.match(
        uncommented,
        new RegExp(String.raw`CREATE\s+TRIGGER\s+${table}_append_only[\s\S]*?EXECUTE\s+FUNCTION\s+deny_history_mutation\(\)`, 'i'),
      )
    }
    assert.match(uncommented, /CREATE\s+TRIGGER\s+things_sleep_on_owner_change\s+BEFORE\s+UPDATE\s+OF\s+owner_id\s+ON\s+things/i)
    // A rough room holds only visitors who came in after it was marked rough (decision #109).
    assert.match(uncommented, /ALTER\s+TABLE\s+places\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+rough_since\s+TIMESTAMPTZ;/i)
    assert.match(uncommented, /ALTER\s+TABLE\s+resident_presence\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+arrived_at\s+TIMESTAMPTZ\s+NOT\s+NULL\s+DEFAULT\s+now\(\)/i)
    assert.match(uncommented, /CREATE\s+TRIGGER\s+places_mark_rough_since\s+BEFORE\s+INSERT\s+OR\s+UPDATE\s+OF\s+rough_room,\s*rough_since\s+ON\s+places/i)
    assert.match(uncommented, /CREATE\s+TRIGGER\s+resident_presence_mark_arrival\s+BEFORE\s+UPDATE\s+OF\s+current_place_id,\s*arrived_at\s+ON\s+resident_presence/i)
    for (const later of ['generation', 'parent_thing_id', 'family_id', 'copies_made', 'open_to_reach', 'open_to_convert', 'as_kind_id', 'growth_cap_per_day', 'allow_arriving_copies']) {
      assert.doesNotMatch(uncommented, new RegExp(String.raw`\b${later}\b`, 'i'), `${later} belongs to a later change`)
    }
  })

  test('abilities-wake-chance-write is selected as one separate preview or production migration', () => {
    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'abilities-wake-chance-write'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, 'db/migrations/20260922_abilities_wake_chance_write.sql')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'abilities-wake-chance-write'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'pre-abilities-20260922',
      },
    )
    assert.equal(production.migrationFile, 'db/migrations/20260922_abilities_wake_chance_write.sql')
  })

  test('the abilities-copy-reach-convert migration is additive and idempotent', () => {
    const migration = readFileSync(abilitiesCopyReachConvertMigrationUrl, 'utf8')
    const uncommented = migration.replace(/^\s*--.*$/gm, '')
    assert.doesNotMatch(uncommented, /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/im)
    assert.doesNotMatch(uncommented, /DROP\s+(?:TABLE|COLUMN|INDEX|FUNCTION|SEQUENCE)\b/i)
    for (const statement of splitSqlStatements(migration)) {
      const trimmed = statement.replace(/^\s*--.*$/gm, '').trim()
      assert.match(
        trimmed,
        /^(?:(?:ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS|CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS|DROP\s+TRIGGER\s+IF\s+EXISTS|CREATE\s+TRIGGER)\b|DO\s+\$\w+\$\s)/i,
        `every statement must be additive and repeatable: ${trimmed.slice(0, 80)}`,
      )
    }
    for (const column of [
      /ALTER\s+TABLE\s+things\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+generation\s+SMALLINT\s+NOT\s+NULL\s+DEFAULT\s+0/i,
      /ALTER\s+TABLE\s+things\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+parent_thing_id\s+INTEGER\b/i,
      /ALTER\s+TABLE\s+things\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+family_id\s+INTEGER\b/i,
      /ALTER\s+TABLE\s+things\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+copies_made\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0/i,
      /ALTER\s+TABLE\s+things\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+open_to_reach\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/i,
      /ALTER\s+TABLE\s+things\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+open_to_convert\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/i,
      /ALTER\s+TABLE\s+things\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+as_kind_id\s+INTEGER\b/i,
      /ALTER\s+TABLE\s+things\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+as_revision\s+INTEGER\b/i,
      /ALTER\s+TABLE\s+places\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+growth_cap_per_day\s+SMALLINT\s+NOT\s+NULL\s+DEFAULT\s+10/i,
      /ALTER\s+TABLE\s+places\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+growth_share_per_family\s+SMALLINT\s+NOT\s+NULL\s+DEFAULT\s+5/i,
      /ALTER\s+TABLE\s+places\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+allow_arriving_copies\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/i,
    ]) assert.match(uncommented, column)
    for (const table of ['thing_conversions', 'place_copy_counts', 'family_growth_marks']) {
      assert.match(uncommented, new RegExp(String.raw`CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+${table}\b`, 'i'))
    }
    assert.match(
      uncommented,
      /CREATE\s+TRIGGER\s+thing_conversions_append_only[\s\S]*?EXECUTE\s+FUNCTION\s+deny_history_mutation\(\)/i,
    )
    // The only dropped constraints are narrower checks, each after its wider replacement exists.
    const drops = [...uncommented.matchAll(/DROP\s+CONSTRAINT\b/gi)]
    assert.equal(drops.length, 1, 'one guarded drop of a narrower check, inside the widening block')
    const widening = uncommented.slice(uncommented.indexOf('$abilities_widen_vocabularies$'))
    for (const wider of ['chance_rolls_purpose_known', 'chance_rolls_outcome_known', 'thing_state_changes_op_known', 'thing_state_changes_trigger_known']) {
      const added = widening.search(new RegExp(String.raw`ADD\s+CONSTRAINT\s+${wider}\b`, 'i'))
      assert.ok(added > 0 && added < widening.search(/DROP\s+CONSTRAINT/i), `${wider} is added before any narrower check is dropped`)
    }
    for (const value of ["'copy_place'", "'member_refused'", "'inherit'", "'copy'"]) {
      assert.ok(widening.includes(value), `${value} joins its vocabulary`)
    }
    // A copy never counts toward its owner's daily things, so no mark names that cap.
    assert.doesNotMatch(uncommented, /owner_daily_things/)
  })

  test('abilities-copy-reach-convert is selected as one separate preview or production migration', () => {
    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'abilities-copy-reach-convert'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, 'db/migrations/20260922_abilities_copy_reach_convert.sql')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'abilities-copy-reach-convert'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'pre-abilities-copy-reach-convert-20260922',
      },
    )
    assert.equal(production.migrationFile, 'db/migrations/20260922_abilities_copy_reach_convert.sql')
  })

  test('the reviewed hosted-chat migration is additive and OAuth-only', () => {
    const uncommented = oauthMigration.replace(/^\s*--.*$/gm, '')
    assert.doesNotMatch(uncommented, /^\s*(?:DROP|ALTER|UPDATE|DELETE|TRUNCATE)\b/im)

    const statements = splitSqlStatements(oauthMigration)
    assert.ok(statements.length > 0)
    for (const statement of statements) {
      const executable = statement.replace(/^\s*--.*$/gm, '').trim()
      assert.match(executable, /^CREATE\s+(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+oauth_/i)
    }

    assert.doesNotMatch(uncommented, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+residents\b/i)
    assert.match(uncommented, /REFERENCES\s+residents\s*\(id\)\s+ON\s+DELETE\s+RESTRICT/i)
    assert.doesNotMatch(fullSchema, /CREATE\s+TRIGGER\s+oauth_\w+_append_only/i)
  })

  test('the agreement-accession migration is additive, idempotent, and leaves old agreements closed', () => {
    const uncommented = agreementAccessionMigration.replace(/^\s*--.*$/gm, '')
    assert.doesNotMatch(uncommented, /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/im)
    assert.doesNotMatch(uncommented, /\bsealed\b/i)
    assert.doesNotMatch(uncommented, /DROP\s+(?:TABLE|COLUMN|INDEX)\b/i)
    assert.match(
      uncommented,
      /ALTER\s+TABLE\s+agreement_parties\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+named\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+TRUE/i,
    )
    assert.match(
      uncommented,
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+agreements_id_creator\s+ON\s+agreements\s*\(id,\s*created_by_id\)/i,
    )
    assert.match(
      uncommented,
      /FOREIGN\s+KEY\s*\(agreement_id,\s*opened_by_id\)\s+REFERENCES\s+agreements\s*\(id,\s*created_by_id\)\s+ON\s+DELETE\s+RESTRICT/i,
    )
    assert.match(
      uncommented,
      /DROP\s+TRIGGER\s+IF\s+EXISTS\s+agreement_accession_openings_append_only/i,
    )
    assert.match(
      uncommented,
      /CREATE\s+TRIGGER\s+agreement_accession_openings_append_only[\s\S]*EXECUTE\s+FUNCTION\s+deny_history_mutation\(\)/i,
    )
  })

  test('agreement accession is selected as one separate preview or production migration', () => {
    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'agreement-accession'],
      {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, 'db/migrations/20260814_agreement_accession.sql')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'agreement-accession'],
      {
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'agreement-accession-release',
      },
    )
    assert.equal(production.migrationFile, 'db/migrations/20260814_agreement_accession.sql')
  })

  test('fresh installs contain every reviewed release migration statement', () => {
    const normalize = (statement: string) => statement
      .replace(/^\s*--.*$/gm, '')
      .replace(/\s+/g, ' ')
      .trim()

    const freshInstallStatements = new Set(splitSqlStatements(fullSchema).map(normalize))
    for (const [migration, label] of [
      [oauthMigration, 'hosted-chat'],
      [agreementAccessionMigration, 'agreement-accession'],
      [readFileSync(openToUseMigrationUrl, 'utf8'), 'open-to-use'],
      [readFileSync(sharedUseMayDestroyMigrationUrl, 'utf8'), 'shared-use-may-destroy'],
      [readFileSync(noteWalkToReadMigrationUrl, 'utf8'), 'note-walk-to-read'],
      [readFileSync(abilitiesWakeChanceWriteMigrationUrl, 'utf8'), 'abilities-wake-chance-write'],
      [readFileSync(abilitiesCopyReachConvertMigrationUrl, 'utf8'), 'abilities-copy-reach-convert'],
      [readFileSync(paymentAttemptsMigrationUrl, 'utf8'), 'payment-attempts'],
      [readFileSync(paymentResponseReplayMigrationUrl, 'utf8'), 'payment-response-replay'],
      [readFileSync(paymentResponseBodyRolloutMigrationUrl, 'utf8'), 'payment-response-body-rollout'],
      [readFileSync(paymentResponseBodyValidationMigrationUrl, 'utf8'), 'payment-response-body-validate'],
      [readFileSync(identityRecoveryMigrationUrl, 'utf8'), 'identity-recovery'],
      [readFileSync(identityRotationMigrationUrl, 'utf8'), 'identity-rotation'],
      [readFileSync(initialRecoveryCodesMigrationUrl, 'utf8'), 'initial-recovery-codes'],
      [readFileSync(resumableRegistrationMigrationUrl, 'utf8'), 'resumable-registration'],
    ] as const) {
      const statements = label === 'payment-attempts'
        ? splitSqlStatements(migration).filter(statement => {
          const trimmed = statement.trim()
          return /^(?:CREATE|COMMENT|DROP\s+TRIGGER|CREATE\s+TRIGGER)/i.test(trimmed)
            && !/^CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:complete_payment_attempt|protect_payment_attempt_history)\s*\(/i.test(trimmed)
        })
        : label === 'identity-recovery'
          ? splitSqlStatements(migration).filter(statement => {
            const trimmed = statement.trim()
            if (/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+identity_rate_limits\b/i.test(trimmed)) {
              return false
            }

            return true
          })
          : label === 'identity-rotation'
            ? splitSqlStatements(migration).filter(statement => {
              const trimmed = statement.trim()
              if (/^DO\s+\$identity_rotation_attempt_kinds\$/i.test(trimmed)) {
                return false
              }
              if (/^ALTER\s+TABLE\s+identity_rate_limits\s+VALIDATE\s+CONSTRAINT\s+/i.test(trimmed)) {
                return false
              }

              return true
            })
            : label === 'resumable-registration'
              ? splitSqlStatements(migration).filter(statement => {
                const trimmed = statement.trim()
                return !/^(?:BEGIN|COMMIT|SET\s+LOCAL)\b/i.test(trimmed)
              })
          : splitSqlStatements(migration)
      for (const statement of statements) {
        assert.ok(
          freshInstallStatements.has(normalize(statement)),
          `db/schema.sql drifted from the reviewed ${label} migration`,
        )
      }
    }
  })

  test('package commands name preview and production migrations explicitly', () => {
    assert.equal(packageJson.scripts.migrate, undefined)
    assert.match(packageJson.scripts['migrate:local'] ?? '', /--target local$/)
    assert.match(packageJson.scripts['migrate:preview'] ?? '', /--target preview --migration hosted-chat-signin$/)
    assert.match(packageJson.scripts['migrate:production'] ?? '', /--target production --migration hosted-chat-signin$/)
    assert.match(packageJson.scripts['migrate:preview:world-root-expand'] ?? '', /--migration world-root-expand$/)
    assert.match(packageJson.scripts['migrate:preview:world-root-topology'] ?? '', /--migration world-root-topology$/)
    assert.match(packageJson.scripts['migrate:production:world-root-expand'] ?? '', /--migration world-root-expand$/)
    assert.match(packageJson.scripts['migrate:production:world-root-topology'] ?? '', /--migration world-root-topology$/)
    assert.match(packageJson.scripts['migrate:preview:agreement-accession'] ?? '', /--target preview --migration agreement-accession$/)
    assert.match(packageJson.scripts['migrate:production:agreement-accession'] ?? '', /--target production --migration agreement-accession$/)
    assert.match(packageJson.scripts['migrate:preview:open-to-use'] ?? '', /--target preview --migration open-to-use$/)
    assert.match(packageJson.scripts['migrate:production:open-to-use'] ?? '', /--target production --migration open-to-use$/)
    assert.match(packageJson.scripts['migrate:preview:shared-use-may-destroy'] ?? '', /--target preview --migration shared-use-may-destroy$/)
    assert.match(packageJson.scripts['migrate:production:shared-use-may-destroy'] ?? '', /--target production --migration shared-use-may-destroy$/)
    assert.match(packageJson.scripts['migrate:preview:note-walk-to-read'] ?? '', /--target preview --migration note-walk-to-read$/)
    assert.match(packageJson.scripts['migrate:production:note-walk-to-read'] ?? '', /--target production --migration note-walk-to-read$/)
    assert.match(packageJson.scripts['migrate:preview:public-snapshot-walk-to-read'] ?? '', /--target preview --migration public-snapshot-walk-to-read$/)
    assert.match(packageJson.scripts['migrate:production:public-snapshot-walk-to-read'] ?? '', /--target production --migration public-snapshot-walk-to-read$/)
    assert.match(packageJson.scripts['migrate:preview:abilities-wake-chance-write'] ?? '', /--target preview --migration abilities-wake-chance-write$/)
    assert.match(packageJson.scripts['migrate:production:abilities-wake-chance-write'] ?? '', /--target production --migration abilities-wake-chance-write$/)
    assert.match(packageJson.scripts['migrate:preview:abilities-copy-reach-convert'] ?? '', /--target preview --migration abilities-copy-reach-convert$/)
    assert.match(packageJson.scripts['migrate:production:abilities-copy-reach-convert'] ?? '', /--target production --migration abilities-copy-reach-convert$/)
    assert.match(packageJson.scripts['migrate:preview:payment-attempts'] ?? '', /--target preview --migration payment-attempts$/)
    assert.match(packageJson.scripts['migrate:production:payment-attempts'] ?? '', /--target production --migration payment-attempts$/)
    assert.match(packageJson.scripts['migrate:preview:payment-response-replay'] ?? '', /--target preview --migration payment-response-replay$/)
    assert.match(packageJson.scripts['migrate:production:payment-response-replay'] ?? '', /--target production --migration payment-response-replay$/)
    assert.match(packageJson.scripts['migrate:preview:payment-response-body-replay'] ?? '', /--target preview --migration payment-response-body-replay$/)
    assert.match(packageJson.scripts['migrate:production:payment-response-body-replay'] ?? '', /--target production --migration payment-response-body-replay$/)
    assert.match(packageJson.scripts['migrate:preview:payment-response-body-rollout'] ?? '', /--target preview --migration payment-response-body-rollout$/)
    assert.match(packageJson.scripts['migrate:production:payment-response-body-rollout'] ?? '', /--target production --migration payment-response-body-rollout$/)
    assert.match(packageJson.scripts['migrate:preview:payment-response-body-validate'] ?? '', /--target preview --migration payment-response-body-validate$/)
    assert.match(packageJson.scripts['migrate:production:payment-response-body-validate'] ?? '', /--target production --migration payment-response-body-validate$/)
    assert.match(packageJson.scripts['migrate:preview:identity-recovery'] ?? '', /--target preview --migration identity-recovery$/)
    assert.match(packageJson.scripts['migrate:production:identity-recovery'] ?? '', /--target production --migration identity-recovery$/)
    assert.match(packageJson.scripts['migrate:preview:identity-rotation'] ?? '', /--target preview --migration identity-rotation$/)
    assert.match(packageJson.scripts['migrate:production:identity-rotation'] ?? '', /--target production --migration identity-rotation$/)
    assert.match(packageJson.scripts['migrate:preview:initial-recovery-codes'] ?? '', /--target preview --migration initial-recovery-codes$/)
    assert.match(packageJson.scripts['migrate:production:initial-recovery-codes'] ?? '', /--target production --migration initial-recovery-codes$/)
    assert.match(packageJson.scripts['migrate:preview:events-presence-index'] ?? '', /--target preview --migration events-presence-index$/)
    assert.match(packageJson.scripts['migrate:production:events-presence-index'] ?? '', /--target production --migration events-presence-index$/)
  })
}
