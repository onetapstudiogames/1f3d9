import test from 'node:test'
import assert from 'node:assert/strict'
import {
  executeMigrationRun,
  verifyGazetteLocalCandidate,
  verifyGazetteDeployment,
} from '../../scripts/migrate.ts'

export function registerGazetteDeploymentTests(): void {
  test('Gazette room activation proves the exact no-store deployed application commit', async () => {
    const expected = {
      origin: 'https://1f3d9-qg56l10xf-onetapstudiogames-projects.vercel.app',
      commit: 'c'.repeat(40),
    } as const
    let requestedUrl = ''
    let requestedInit: RequestInit | undefined
    await verifyGazetteDeployment(expected, async (input, init) => {
      requestedUrl = String(input)
      requestedInit = init
      return new Response(JSON.stringify({ deployment_commit: expected.commit }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      })
    })
    assert.equal(requestedUrl, `${expected.origin}/api/official`)
    assert.equal(requestedInit?.method, 'GET')
    assert.equal(requestedInit?.cache, 'no-store')
    assert.equal(requestedInit?.redirect, 'error')

    await assert.rejects(
      () => verifyGazetteDeployment(expected, async () => new Response(JSON.stringify({
        deployment_commit: 'd'.repeat(40),
      }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      })),
      /deployed commit did not match/iu,
    )
    await assert.rejects(
      () => verifyGazetteDeployment(expected, async () => new Response('not json', {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      })),
      /deployment proof/iu,
    )
  })

  test('Gazette room activation binds a clean local worktree to its full Git HEAD', () => {
    const expectedCommit = 'e'.repeat(40)
    const calls: string[][] = []

    verifyGazetteLocalCandidate(expectedCommit, args => {
      calls.push([...args])
      return args[0] === 'status' ? '' : `${expectedCommit}\n`
    })

    assert.deepEqual(calls, [
      ['status', '--porcelain=v1', '--untracked-files=all'],
      ['rev-parse', '--verify', 'HEAD^{commit}'],
    ])
  })

  test('Gazette room activation refuses tracked or untracked local changes before reading HEAD', () => {
    for (const dirtyStatus of [' M scripts/migrate.ts\n', '?? scratch-activation.sql\n']) {
      const calls: string[][] = []
      assert.throws(
        () => verifyGazetteLocalCandidate('e'.repeat(40), args => {
          calls.push([...args])
          return dirtyStatus
        }),
        /clean local candidate.*tracked and untracked/iu,
      )
      assert.deepEqual(calls, [['status', '--porcelain=v1', '--untracked-files=all']])
    }
  })

  test('Gazette room activation refuses malformed or mismatched local HEAD commits', () => {
    for (const [head, error] of [
      ['short-head\n', /full lowercase Git HEAD/iu],
      [`${'f'.repeat(40)}\n`, /does not match the clean local candidate HEAD/iu],
    ] as const) {
      assert.throws(
        () => verifyGazetteLocalCandidate('e'.repeat(40), args =>
          args[0] === 'status' ? '' : head,
        ),
        error,
      )
    }
  })

  test('Gazette activation re-proves the deployed commit after the database guard and immediately before DDL', async () => {
    const expectedDeployment = {
      origin: 'https://1f3d9-qg56l10xf-onetapstudiogames-projects.vercel.app',
      commit: 'e'.repeat(40),
    } as const
    const events: string[] = []
    const result = await executeMigrationRun({
      target: 'preview',
      databaseUrl: 'postgres://role@example.neon.tech/db',
      migrationFile: 'db/migrations/20260827_gazette_room_activation.sql',
      executionMode: 'transactional',
      liveDeployment: expectedDeployment,
      preview: {
        projectId: 'project-one',
        branchId: 'branch-preview',
        productionBranchId: 'branch-production',
      },
    }, 'SELECT activation_ddl', 'secret-neon-key', {
      verifyGazetteLocalCandidate: async commit => {
        assert.equal(commit, expectedDeployment.commit)
        events.push('local-candidate-proof')
      },
      verifyGazetteDeployment: async () => { events.push('deployment-proof') },
      verifyPreviewDatabaseTarget: async () => { events.push('database-proof') },
      prepareProductionMigration: async () => {
        assert.fail('Preview activation must not prepare a Production snapshot')
      },
      applyMigration: async (_databaseUrl, _migrationFile, ddl) => {
        events.push(`ddl:${ddl}`)
        return 1
      },
    })

    assert.deepEqual(events, [
      'local-candidate-proof',
      'deployment-proof',
      'database-proof',
      'deployment-proof',
      'ddl:SELECT activation_ddl',
    ])
    assert.deepEqual(result, { statementCount: 1 })
  })

  test('dormant Gazette schema installation does not require candidate or live deployment proof', async () => {
    const events: string[] = []
    const result = await executeMigrationRun({
      target: 'preview',
      databaseUrl: 'postgres://role@example.neon.tech/db',
      migrationFile: 'db/migrations/20260827_gazette.sql',
      executionMode: 'transactional',
      preview: {
        projectId: 'project-one',
        branchId: 'branch-preview',
        productionBranchId: 'branch-production',
      },
    }, 'SELECT dormant_ddl', 'secret-neon-key', {
      verifyGazetteLocalCandidate: async () => {
        assert.fail('Dormant Gazette schema installation must not inspect the local candidate')
      },
      verifyGazetteDeployment: async () => {
        assert.fail('Dormant Gazette schema installation must not request a live deployment')
      },
      verifyPreviewDatabaseTarget: async () => { events.push('database-proof') },
      prepareProductionMigration: async () => {
        assert.fail('Preview migration must not prepare a Production snapshot')
      },
      applyMigration: async (_databaseUrl, _migrationFile, ddl) => {
        events.push(`ddl:${ddl}`)
        return 1
      },
    })

    assert.deepEqual(events, ['database-proof', 'ddl:SELECT dormant_ddl'])
    assert.deepEqual(result, { statementCount: 1 })
  })

  test('Gazette Production activation re-proves the deployed commit after its verified snapshot', async () => {
    const events: string[] = []
    const result = await executeMigrationRun({
      target: 'production',
      databaseUrl: 'postgres://role@example.neon.tech/db',
      migrationFile: 'db/migrations/20260827_gazette_room_activation.sql',
      executionMode: 'transactional',
      liveDeployment: { origin: 'https://1f3d9.com', commit: 'f'.repeat(40) },
      snapshot: {
        projectId: 'project-one',
        branchId: 'branch-production',
        name: 'gazette-room-activation',
      },
    }, 'SELECT activation_ddl', 'secret-neon-key', {
      verifyGazetteLocalCandidate: async commit => {
        assert.equal(commit, 'f'.repeat(40))
        events.push('local-candidate-proof')
      },
      verifyGazetteDeployment: async () => { events.push('deployment-proof') },
      verifyPreviewDatabaseTarget: async () => {
        assert.fail('Production activation must not verify a Preview branch')
      },
      prepareProductionMigration: async () => {
        events.push('verified-snapshot')
        return 'snapshot-one'
      },
      applyMigration: async () => {
        events.push('ddl')
        return 1
      },
    })

    assert.deepEqual(events, [
      'local-candidate-proof',
      'deployment-proof',
      'verified-snapshot',
      'deployment-proof',
      'ddl',
    ])
    assert.deepEqual(result, { statementCount: 1, snapshotId: 'snapshot-one' })
  })

  test('a stale second Gazette deployment proof leaves room activation unapplied', async () => {
    let proofCount = 0
    let applied = false
    await assert.rejects(
      () => executeMigrationRun({
        target: 'preview',
        databaseUrl: 'postgres://role@example.neon.tech/db',
        migrationFile: 'db/migrations/20260827_gazette_room_activation.sql',
        executionMode: 'transactional',
        liveDeployment: {
          origin: 'https://1f3d9-qg56l10xf-onetapstudiogames-projects.vercel.app',
          commit: '1'.repeat(40),
        },
        preview: {
          projectId: 'project-one',
          branchId: 'branch-preview',
          productionBranchId: 'branch-production',
        },
      }, 'SELECT activation_ddl', 'secret-neon-key', {
        verifyGazetteLocalCandidate: async () => {},
        verifyGazetteDeployment: async () => {
          proofCount += 1
          if (proofCount === 2) throw new Error('deployed commit changed during preparation')
        },
        verifyPreviewDatabaseTarget: async () => {},
        prepareProductionMigration: async () => 'not-used',
        applyMigration: async () => {
          applied = true
          return 1
        },
      }),
      /deployed commit changed during preparation/iu,
    )
    assert.equal(proofCount, 2)
    assert.equal(applied, false)
  })

  test('a refused local Gazette candidate performs no live, Neon, snapshot, or DDL operation', async () => {
    const remoteOperation = () => assert.fail('Local candidate refusal must happen before remote work')
    await assert.rejects(
      () => executeMigrationRun({
        target: 'preview',
        databaseUrl: 'postgres://role@example.neon.tech/db',
        migrationFile: 'db/migrations/20260827_gazette_room_activation.sql',
        executionMode: 'transactional',
        liveDeployment: {
          origin: 'https://1f3d9-qg56l10xf-onetapstudiogames-projects.vercel.app',
          commit: '1'.repeat(40),
        },
        preview: {
          projectId: 'project-one',
          branchId: 'branch-preview',
          productionBranchId: 'branch-production',
        },
      }, 'SELECT activation_ddl', 'secret-neon-key', {
        verifyGazetteLocalCandidate: async () => {
          throw new Error('Gazette room activation requires a clean local candidate')
        },
        verifyGazetteDeployment: async () => { remoteOperation() },
        verifyPreviewDatabaseTarget: async () => { remoteOperation() },
        prepareProductionMigration: async () => {
          remoteOperation()
          return 'not-used'
        },
        applyMigration: async () => {
          remoteOperation()
          return 1
        },
      }),
      /requires a clean local candidate/iu,
    )
  })
}
