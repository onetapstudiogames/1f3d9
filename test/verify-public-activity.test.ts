import assert from 'node:assert/strict'
import test from 'node:test'

const environment = Object.freeze({
  NEON_API_KEY: 'test-neon-key',
  NEON_PROJECT_ID: 'project-one',
  NEON_PREVIEW_BRANCH_ID: 'branch-preview',
  NEON_PRODUCTION_BRANCH_ID: 'branch-production',
  PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role:pass@preview.example.neon.tech/db',
  PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role:pass@production.example.neon.tech/db',
})
const healthy = Object.freeze({
  columns_match: true, receipt_matches: true, triggers_match: true, functions_match: true,
  summaries_match: true,
  private_settings_exported: false, activity_fields_exported: false,
  export_role_exists: true, export_has_select: false,
})

test('activity verifier selects only an explicit guarded remote target', async () => {
  const { resolvePublicActivityTarget } = await import('../scripts/verify-public-activity.ts')
  for (const target of ['preview', 'production']) {
    const run = resolvePublicActivityTarget(['--target', target], environment)
    assert.equal(run.target, target)
    assert.equal(run.branchId, target === 'preview' ? 'branch-preview' : 'branch-production')
  }
  for (const args of [[], ['--target', 'local'], ['--target', 'preview', '--migration', 'public-activity']]) {
    assert.throws(() => resolvePublicActivityTarget(args, environment), /--target preview\|production/u)
  }
  assert.throws(() => resolvePublicActivityTarget(['--target', 'preview'], { ...environment, NEON_PREVIEW_BRANCH_ID: 'branch-production' }), /preview branch must not be the production branch/u)
  assert.throws(() => resolvePublicActivityTarget(['--target', 'preview'], { ...environment, PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@ep-pooler.neon.tech/db' }), /direct, non-pooled/u)
  assert.throws(() => resolvePublicActivityTarget(['--target', 'production'], { ...environment, NEON_PROJECT_ID: '../other' }), /NEON_PROJECT_ID/u)
  assert.throws(() => resolvePublicActivityTarget(['--target', 'production'], { ...environment, NEON_API_KEY: '' }), /NEON_API_KEY/u)
})

test('activity verifier proves the target before a read-only database check and returns no connection values', async () => {
  const { resolvePublicActivityTarget, verifyPublicActivity } = await import('../scripts/verify-public-activity.ts')
  for (const target of ['preview', 'production']) {
    const run = resolvePublicActivityTarget(['--target', target], environment)
    const calls: string[] = []
    const result = await verifyPublicActivity(run, {
      fetcher: async () => {
        calls.push('target')
        return Response.json({ endpoints: [{ id: 'ep-test', host: `${target}.example.neon.tech`, project_id: 'project-one', branch_id: run.branchId, type: 'read_write' }] })
      },
      connect: async () => {
        calls.push('connect')
        return {
          query: async (statement: string) => {
            calls.push(statement.startsWith('WITH RECURSIVE') ? 'check' : statement)
            assert.doesNotMatch(statement, /\b(?:INSERT|UPDATE|DELETE|ALTER|GRANT|REVOKE|CREATE|DROP)\b/iu)
            return { rows: statement.startsWith('WITH RECURSIVE') ? [{ ...healthy }] : [] }
          },
          end: async () => { calls.push('end') },
        }
      },
    })
    assert.deepEqual(result, { verified: true, target })
    assert.deepEqual(calls, ['target', 'connect', 'BEGIN READ ONLY', "SET LOCAL statement_timeout = '30s'", 'check', 'COMMIT', 'end'])
    assert.doesNotMatch(JSON.stringify(result), /role|pass|neon|branch|project/u)
  }
})

test('activity verifier refuses schema, snapshot, grant and target mismatches without leaking raw errors', async () => {
  const { resolvePublicActivityTarget, verifyPublicActivity } = await import('../scripts/verify-public-activity.ts')
  const run = resolvePublicActivityTarget(['--target', 'preview'], environment)
  const fetcher = async () => Response.json({ endpoints: [{ id: 'ep-test', host: 'preview.example.neon.tech', project_id: 'project-one', branch_id: 'branch-preview', type: 'read_write' }] })
  for (const bad of [
    { columns_match: false }, { receipt_matches: false }, { triggers_match: false }, { functions_match: false },
    { summaries_match: false }, { private_settings_exported: true }, { activity_fields_exported: true },
    { export_role_exists: false }, { export_has_select: true },
  ]) {
    const calls: string[] = []
    await assert.rejects(verifyPublicActivity(run, {
      fetcher,
      connect: async () => ({
        query: async (statement: string) => {
          calls.push(statement)
          return { rows: statement.startsWith('WITH RECURSIVE') ? [{ ...healthy, ...bad }] : [] }
        },
        end: async () => { calls.push('end') },
      }),
    }), /public activity verification failed/u)
    assert.ok(calls.includes('ROLLBACK'))
    assert.equal(calls.at(-1), 'end')
  }
  let connected = false
  await assert.rejects(verifyPublicActivity(run, {
    fetcher: async () => Response.json({ endpoints: [] }),
    connect: async () => { connected = true; throw new Error('password private-connection-value') },
  }), /public activity verification failed/u)
  assert.equal(connected, false)
  await assert.rejects(verifyPublicActivity(run, {
    fetcher,
    connect: async () => { throw new Error('password private-connection-value') },
  }), error => {
    assert.equal((error as Error).message, 'public activity verification failed; no database changes were made')
    return true
  })
})
