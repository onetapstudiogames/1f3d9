import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveMigrationRun } from '../../scripts/migrate.ts'

export function registerGazetteInstallationTests(): void {
  const gazetteWithdrawalMigrationFile =
    'db/migrations/20260901_gazette_withdrawal.sql' as const
  const gazetteWithdrawalActivationMigrationFile =
    'db/migrations/20260901_gazette_withdrawal_activation.sql' as const

  test('Gazette schema installation and post-deploy room activation are separate guarded migrations', () => {
    const schemaMigrationFile = 'db/migrations/20260827_gazette.sql' as const
    const activationMigrationFile = 'db/migrations/20260827_gazette_room_activation.sql' as const
    const previewEnvironment = {
      CONFIRM_GAZETTE: 'INSTALL_GAZETTE_ARCHIVE_AND_SUBMISSION_LIMIT',
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    }
    assert.throws(
      () => resolveMigrationRun(
        ['--target', 'preview', '--migration', 'gazette'],
        { ...previewEnvironment, CONFIRM_GAZETTE: undefined },
      ),
      /CONFIRM_GAZETTE/iu,
    )

    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'gazette'],
      previewEnvironment,
    )
    assert.equal(preview.migrationFile, schemaMigrationFile)
    assert.equal(preview.executionMode, 'transactional')

    assert.throws(
      () => resolveMigrationRun(
        ['--target', 'preview', '--migration', 'gazette-room-activation'],
        previewEnvironment,
      ),
      /CONFIRM_GAZETTE_ROOM_ACTIVATION/iu,
    )
    assert.throws(
      () => resolveMigrationRun(
        ['--target', 'preview', '--migration', 'gazette-room-activation'],
        {
          ...previewEnvironment,
          CONFIRM_GAZETTE_ROOM_ACTIVATION:
            'OPEN_GAZETTE_ROOM_AFTER_MATCHING_APP_DEPLOYMENT',
        },
      ),
      /GAZETTE_DEPLOYMENT_COMMIT/iu,
    )
    const previewActivation = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'gazette-room-activation'],
      {
        ...previewEnvironment,
        CONFIRM_GAZETTE_ROOM_ACTIVATION:
          'OPEN_GAZETTE_ROOM_AFTER_MATCHING_APP_DEPLOYMENT',
        GAZETTE_DEPLOYMENT_COMMIT: 'a'.repeat(40),
        GAZETTE_PREVIEW_ORIGIN:
          'https://1f3d9-qg56l10xf-onetapstudiogames-projects.vercel.app',
      },
    )
    assert.equal(previewActivation.migrationFile, activationMigrationFile)
    assert.equal(previewActivation.executionMode, 'transactional')
    assert.deepEqual(previewActivation.liveDeployment, {
      origin: 'https://1f3d9-qg56l10xf-onetapstudiogames-projects.vercel.app',
      commit: 'a'.repeat(40),
    })
    for (const unsafeOrigin of [
      'https://1f3d9-git-feat-growth-gazette-onetapstudiogames-projects.vercel.app',
      'https://1f3d9-feat-growth-gazette-onetapstudiogames-projects.vercel.app',
      'https://1f3d9-world-root-preview-qg56l10xf-onetapstudiogames-projects.vercel.app',
      'https://1f3d9-QG56L10XF-onetapstudiogames-projects.vercel.app',
      'https://1f3d9-qg56l10xf-onetapstudiogames-projects.vercel.app:443',
      'https://another-project.vercel.app',
    ]) {
      assert.throws(
        () => resolveMigrationRun(
          ['--target', 'preview', '--migration', 'gazette-room-activation'],
          {
            ...previewEnvironment,
            CONFIRM_GAZETTE_ROOM_ACTIVATION:
              'OPEN_GAZETTE_ROOM_AFTER_MATCHING_APP_DEPLOYMENT',
            GAZETTE_DEPLOYMENT_COMMIT: 'a'.repeat(40),
            GAZETTE_PREVIEW_ORIGIN: unsafeOrigin,
          },
        ),
        /this project's immutable HTTPS Vercel deployment origin/iu,
        unsafeOrigin,
      )
    }

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'gazette'],
      {
        CONFIRM_GAZETTE: 'INSTALL_GAZETTE_ARCHIVE_AND_SUBMISSION_LIMIT',
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'gazette-release',
      },
    )
    assert.equal(production.migrationFile, schemaMigrationFile)

    const productionActivation = resolveMigrationRun(
      ['--target', 'production', '--migration', 'gazette-room-activation'],
      {
        CONFIRM_GAZETTE_ROOM_ACTIVATION:
          'OPEN_GAZETTE_ROOM_AFTER_MATCHING_APP_DEPLOYMENT',
        GAZETTE_DEPLOYMENT_COMMIT: 'b'.repeat(40),
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'gazette-room-activation',
      },
    )
    assert.equal(productionActivation.migrationFile, activationMigrationFile)
    assert.deepEqual(productionActivation.liveDeployment, {
      origin: 'https://1f3d9.com',
      commit: 'b'.repeat(40),
    })

    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> }
    assert.match(
      packageJson.scripts?.['migrate:preview:gazette'] ?? '',
      /--target preview --migration gazette$/u,
    )
    assert.match(
      packageJson.scripts?.['migrate:production:gazette'] ?? '',
      /--target production --migration gazette$/u,
    )
    assert.match(
      packageJson.scripts?.['migrate:preview:gazette-room-activation'] ?? '',
      /--target preview --migration gazette-room-activation$/u,
    )
    assert.match(
      packageJson.scripts?.['migrate:production:gazette-room-activation'] ?? '',
      /--target production --migration gazette-room-activation$/u,
    )
  })

  test('Gazette withdrawal installation is dormant and only its activation proves the deployed commit', () => {
    const previewEnvironment = {
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    }

    assert.throws(
      () => resolveMigrationRun(
        ['--target', 'preview', '--migration', 'gazette-withdrawal'],
        previewEnvironment,
      ),
      /CONFIRM_GAZETTE_WITHDRAWAL/iu,
    )
    const dormant = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'gazette-withdrawal'],
      {
        ...previewEnvironment,
        CONFIRM_GAZETTE_WITHDRAWAL: 'INSTALL_DORMANT_GAZETTE_WITHDRAWAL_LEDGER',
        GAZETTE_DEPLOYMENT_COMMIT: 'a'.repeat(40),
        GAZETTE_PREVIEW_ORIGIN:
          'https://1f3d9-qg56l10xf-onetapstudiogames-projects.vercel.app',
      },
    )
    assert.equal(dormant.migrationFile, gazetteWithdrawalMigrationFile)
    assert.equal(dormant.executionMode, 'transactional')
    assert.equal(dormant.liveDeployment, undefined)

    assert.throws(
      () => resolveMigrationRun(
        ['--target', 'preview', '--migration', 'gazette-withdrawal-activation'],
        previewEnvironment,
      ),
      /CONFIRM_GAZETTE_WITHDRAWAL_ACTIVATION/iu,
    )
    assert.throws(
      () => resolveMigrationRun(
        ['--target', 'preview', '--migration', 'gazette-withdrawal-activation'],
        {
          ...previewEnvironment,
          CONFIRM_GAZETTE_WITHDRAWAL_ACTIVATION:
            'OPEN_GAZETTE_WITHDRAWALS_AFTER_MATCHING_APP_DEPLOYMENT',
        },
      ),
      /GAZETTE_DEPLOYMENT_COMMIT/iu,
    )

    const activation = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'gazette-withdrawal-activation'],
      {
        ...previewEnvironment,
        CONFIRM_GAZETTE_WITHDRAWAL_ACTIVATION:
          'OPEN_GAZETTE_WITHDRAWALS_AFTER_MATCHING_APP_DEPLOYMENT',
        GAZETTE_DEPLOYMENT_COMMIT: 'b'.repeat(40),
        GAZETTE_PREVIEW_ORIGIN:
          'https://1f3d9-qg56l10xf-onetapstudiogames-projects.vercel.app',
      },
    )
    assert.equal(activation.migrationFile, gazetteWithdrawalActivationMigrationFile)
    assert.equal(activation.executionMode, 'transactional')
    assert.deepEqual(activation.liveDeployment, {
      origin: 'https://1f3d9-qg56l10xf-onetapstudiogames-projects.vercel.app',
      commit: 'b'.repeat(40),
    })

    const productionActivation = resolveMigrationRun(
      ['--target', 'production', '--migration', 'gazette-withdrawal-activation'],
      {
        CONFIRM_GAZETTE_WITHDRAWAL_ACTIVATION:
          'OPEN_GAZETTE_WITHDRAWALS_AFTER_MATCHING_APP_DEPLOYMENT',
        GAZETTE_DEPLOYMENT_COMMIT: 'c'.repeat(40),
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'gazette-withdrawal-activation',
      },
    )
    assert.equal(productionActivation.migrationFile, gazetteWithdrawalActivationMigrationFile)
    assert.deepEqual(productionActivation.liveDeployment, {
      origin: 'https://1f3d9.com',
      commit: 'c'.repeat(40),
    })

    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> }
    for (const target of ['preview', 'production'] as const) {
      assert.match(
        packageJson.scripts?.[`migrate:${target}:gazette-withdrawal`] ?? '',
        new RegExp(`--target ${target} --migration gazette-withdrawal$`, 'u'),
      )
      assert.match(
        packageJson.scripts?.[`migrate:${target}:gazette-withdrawal-activation`] ?? '',
        new RegExp(`--target ${target} --migration gazette-withdrawal-activation$`, 'u'),
      )
    }
  })
}
