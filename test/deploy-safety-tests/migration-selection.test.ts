import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveMigrationRun, splitSqlStatements } from '../../scripts/migrate.ts'
import { packageJson } from '../helpers/deploy-safety-fixtures/release-documents.ts'
import { fullSchema, oauthMigration, agreementAccessionMigration, openToUseMigrationUrl, paymentAttemptsMigrationUrl, paymentResponseReplayMigrationUrl, paymentResponseBodyRolloutMigrationUrl, paymentResponseBodyValidationMigrationUrl, identityRecoveryMigrationUrl, identityRotationMigrationUrl, initialRecoveryCodesMigrationUrl, resumableRegistrationMigrationUrl } from '../helpers/deploy-safety-fixtures/migration-sources.ts'

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
