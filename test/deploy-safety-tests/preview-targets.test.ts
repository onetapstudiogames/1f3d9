import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveMigrationRun, verifyPreviewDatabaseTarget } from '../../scripts/migrate.ts'

export function registerPreviewTargetsTests(): void {
  test('preview migration requires exact acknowledgement and named isolated Neon targets', () => {
    assert.throws(
      () => resolveMigrationRun(
        ['--target', 'preview', '--migration', 'hosted-chat-signin'],
        { DATABASE_URL: 'postgres://example/db' },
      ),
      /APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW/,
    )

    assert.throws(
      () => resolveMigrationRun(['--target', 'preview', '--migration', 'hosted-chat-signin'], {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example-pooler.neon.tech/db',
      }),
      /direct.*non-pooled/i,
    )

    assert.throws(
      () => resolveMigrationRun(['--target', 'preview', '--migration', 'hosted-chat-signin'], {
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-production',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      }),
      /preview branch.*production branch/i,
    )

    const run = resolveMigrationRun(['--target', 'preview', '--migration', 'hosted-chat-signin'], {
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    })
    assert.equal(run.target, 'preview')
    assert.equal(run.databaseUrl, 'postgres://role@example.neon.tech/db')
    assert.deepEqual(run.preview, {
      projectId: 'project-one',
      branchId: 'branch-preview',
      productionBranchId: 'branch-production',
    })
    assert.equal(run.migrationFile, 'db/migrations/20260813_hosted_chat_signin.sql')
  })

  test('preview database host must match its exact read-write Neon endpoint and not production', async () => {
    const calls: string[] = []
    const fetcher = (async input => {
      calls.push(String(input))
      return new Response(JSON.stringify({
        endpoints: [{
          id: 'ep-preview-one',
          host: 'ep-preview-one.us-east-2.aws.neon.tech',
          project_id: 'project-one',
          branch_id: 'branch-preview',
          type: 'read_write',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    await verifyPreviewDatabaseTarget(
      {
        projectId: 'project-one',
        branchId: 'branch-preview',
        productionBranchId: 'branch-production',
      },
      'postgres://role:password@ep-preview-one.us-east-2.aws.neon.tech/city',
      'secret-neon-key',
      fetcher,
    )
    assert.deepEqual(calls, [
      'https://console.neon.tech/api/v2/projects/project-one/branches/branch-preview/endpoints',
    ])

    await assert.rejects(
      verifyPreviewDatabaseTarget(
        {
          projectId: 'project-one',
          branchId: 'branch-production',
          productionBranchId: 'branch-production',
        },
        'postgres://role:password@ep-preview-one.us-east-2.aws.neon.tech/city',
        'secret-neon-key',
        fetcher,
      ),
      /preview branch.*production branch/i,
    )
  })
}
