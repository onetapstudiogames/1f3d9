import test from 'node:test'
import assert from 'node:assert/strict'
import { createProductionSnapshot, prepareProductionMigration, resolveMigrationRun, verifyProductionDatabaseTarget } from '../../scripts/migrate.ts'

export function registerProductionAndLocalTargetsTests(): void {
  test('production migration requires a real Neon snapshot configuration and exact acknowledgement', () => {
    const productionUrl = 'postgres://role@example.neon.tech/db'

    assert.throws(
      () => resolveMigrationRun(['--target', 'production', '--migration', 'hosted-chat-signin'], {
        PRODUCTION_DATABASE_URL_UNPOOLED: productionUrl,
      }),
      /APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION/,
    )

    assert.throws(
      () => resolveMigrationRun(['--target', 'production', '--migration', 'hosted-chat-signin'], {
        PRODUCTION_DATABASE_URL_UNPOOLED: productionUrl,
        NEON_API_KEY: 'secret-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PRODUCTION_BRANCH_ID: 'branch-one',
        PRODUCTION_SNAPSHOT_NAME: 'oauth-release-1',
        CONFIRM_PRODUCTION_MIGRATION: 'yes',
      }),
      /APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION/,
    )

    assert.throws(
      () => resolveMigrationRun(['--target', 'production', '--migration', 'hosted-chat-signin'], {
        PRODUCTION_DATABASE_URL_UNPOOLED: productionUrl,
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
      }),
      /NEON_API_KEY/,
    )

    const run = resolveMigrationRun(['--target', 'production', '--migration', 'hosted-chat-signin'], {
      PRODUCTION_DATABASE_URL_UNPOOLED: productionUrl,
      CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-one',
      PRODUCTION_SNAPSHOT_NAME: 'oauth-release-1',
    })
    assert.equal(run.target, 'production')
    assert.deepEqual(run.snapshot, {
      projectId: 'project-one',
      branchId: 'branch-one',
      name: 'oauth-release-1',
    })
    assert.equal(run.migrationFile, 'db/migrations/20260813_hosted_chat_signin.sql')
  })

  test('the full local schema can run only against an acknowledged loopback database', () => {
    const acknowledged = { CONFIRM_LOCAL_SCHEMA: 'APPLY_FULL_SCHEMA_TO_LOOPBACK_DATABASE' }
    assert.throws(
      () => resolveMigrationRun(['--target', 'local'], {
        ...acknowledged,
        LOCAL_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      }),
      /loopback/i,
    )
    assert.throws(
      () => resolveMigrationRun(['--target', 'local'], {
        LOCAL_DATABASE_URL_UNPOOLED: 'postgres://role@127.0.0.1/db',
      }),
      /CONFIRM_LOCAL_SCHEMA/,
    )
    assert.equal(resolveMigrationRun(['--target', 'local'], {
      ...acknowledged,
      LOCAL_DATABASE_URL_UNPOOLED: 'postgres://role@127.0.0.1/db',
    }).migrationFile, 'db/schema.sql')
  })

  test('production snapshot must be created and confirmed before migration can proceed', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = []
    const fetcher = (async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
      })
      return new Response(JSON.stringify({
        snapshot: {
          id: 'snap-oauth-release-1',
          name: 'oauth-release-1',
          source_branch_id: 'branch-one',
        },
        operations: [{ id: 'operation-one', status: 'finished' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const snapshotId = await createProductionSnapshot({
      projectId: 'project-one',
      branchId: 'branch-one',
      name: 'oauth-release-1',
    }, 'secret-neon-key', fetcher)
    assert.equal(snapshotId, 'snap-oauth-release-1')
    assert.equal(calls.length, 1)
    assert.match(calls[0]?.url ?? '', /projects\/project-one\/branches\/branch-one\/snapshot/)
    assert.doesNotMatch(calls[0]?.url ?? '', /secret-neon-key/)
    assert.equal(calls[0]?.authorization, 'Bearer secret-neon-key')
  })

  test('production database host must exactly match a read-write endpoint on the snapshotted branch', async () => {
    const calls: Array<{ url: string; method: string | undefined; authorization: string | null }> = []
    const fetcher = (async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method,
        authorization: new Headers(init?.headers).get('authorization'),
      })
      return new Response(JSON.stringify({
        endpoints: [{
          id: 'ep-production-one',
          host: 'ep-production-one.us-east-2.aws.neon.tech',
          project_id: 'project-one',
          branch_id: 'branch-one',
          type: 'read_write',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    await verifyProductionDatabaseTarget(
      {
        projectId: 'project-one',
        branchId: 'branch-one',
        name: 'oauth-release-1',
      },
      'postgres://role:password@ep-production-one.us-east-2.aws.neon.tech/city',
      'secret-neon-key',
      fetcher,
    )

    assert.equal(calls.length, 1)
    assert.equal(
      calls[0]?.url,
      'https://console.neon.tech/api/v2/projects/project-one/branches/branch-one/endpoints',
    )
    assert.equal(calls[0]?.method, 'GET')
    assert.equal(calls[0]?.authorization, 'Bearer secret-neon-key')
    assert.doesNotMatch(calls[0]?.url ?? '', /password|secret-neon-key/)
  })

  test('production database target verification fails closed on mismatch or unknown endpoint data', async () => {
    const snapshot = {
      projectId: 'project-one',
      branchId: 'branch-one',
      name: 'oauth-release-1',
    } as const
    const databaseUrl = 'postgres://role:password@ep-production-one.us-east-2.aws.neon.tech/city'
    const responses = [
      { endpoints: [] },
      { endpoints: [{
        id: 'ep-other',
        host: 'ep-other.us-east-2.aws.neon.tech',
        project_id: 'project-one',
        branch_id: 'branch-one',
        type: 'read_write',
      }] },
      { endpoints: [{
        id: 'ep-production-one',
        host: 'ep-production-one.us-east-2.aws.neon.tech',
        project_id: 'different-project',
        branch_id: 'branch-one',
        type: 'read_write',
      }] },
      { endpoints: [{
        id: 'ep-production-one',
        host: 'ep-production-one.us-east-2.aws.neon.tech',
        project_id: 'project-one',
        branch_id: 'different-branch',
        type: 'read_write',
      }] },
      { endpoints: [{
        id: 'ep-production-one',
        host: 'ep-production-one.us-east-2.aws.neon.tech',
        project_id: 'project-one',
        branch_id: 'branch-one',
        type: 'read_only',
      }] },
      { endpoints: 'not-an-array' },
    ]

    for (const body of responses) {
      const fetcher = (async () => new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
      await assert.rejects(
        verifyProductionDatabaseTarget(snapshot, databaseUrl, 'secret-neon-key', fetcher),
        /could not prove.*production database/i,
      )
    }
  })

  test('a target mismatch stops before Neon snapshot creation', async () => {
    const calls: string[] = []
    const fetcher = (async (input) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ endpoints: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    await assert.rejects(
      prepareProductionMigration(
        {
          projectId: 'project-one',
          branchId: 'branch-one',
          name: 'oauth-release-1',
        },
        'postgres://role:password@ep-production-one.us-east-2.aws.neon.tech/city',
        'secret-neon-key',
        fetcher,
      ),
      /could not prove.*production database/i,
    )

    assert.deepEqual(calls, [
      'https://console.neon.tech/api/v2/projects/project-one/branches/branch-one/endpoints',
    ])
  })
}
