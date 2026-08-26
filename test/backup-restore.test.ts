import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'

import {
  assertPrivateBackupDirectory,
  dockerDatabaseRoutePlan,
  parseBackupArgs,
  runBackup,
  selectDockerDatabaseRoute,
} from '../scripts/backup.ts'
import {
  combineRestoreCleanupErrors,
  removeRestoreContainer,
  restoreDrillRunArguments,
  runRestoreDrill,
} from '../scripts/restore-drill.ts'

const LOCAL_ACKNOWLEDGEMENT = 'CREATE_1F3D9_LOCAL_RECOVERY_ARCHIVE'
const PREVIEW_ACKNOWLEDGEMENT = 'CREATE_1F3D9_PREVIEW_RECOVERY_ARCHIVE'

async function temporaryRoot(t: test.TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('backup arguments require an explicit target and expected database', () => {
  assert.deepEqual(
    parseBackupArgs([
      '--target', 'production',
      '--database', 'neondb',
      '--out', 'C:/private/1f3d9-production.dump',
    ]),
    {
      target: 'production',
      expectedDatabase: 'neondb',
      out: 'C:/private/1f3d9-production.dump',
      keep: 30,
    },
  )

  for (const args of [
    [],
    ['--target', 'local'],
    ['--database', 'city'],
    ['--target', 'sideways', '--database', 'city'],
    ['--target', 'local', '--database', '../city'],
    ['--target', 'local', '--database', 'city', '--target', 'preview'],
  ]) {
    assert.throws(() => parseBackupArgs(args), /target|database|argument|duplicate/i)
  }
})

test('Docker plans gateway-first loopback access without negotiating remote databases', async () => {
  const linux = dockerDatabaseRoutePlan(
    'postgres://role:password@127.0.0.1:5432/city',
    'linux',
  )
  assert.deepEqual(
    linux,
    {
      candidates: [
        {
          hostname: 'host.docker.internal',
          runArguments: ['--add-host', 'host.docker.internal:host-gateway'],
        },
        { hostname: '127.0.0.1', runArguments: ['--network', 'host'] },
      ],
      defaultSslMode: 'disable',
      loopback: true,
    },
  )
  const windows = dockerDatabaseRoutePlan(
    'postgres://role:password@127.0.0.1:5432/city',
    'win32',
  )
  assert.deepEqual(windows.candidates, [linux.candidates[0]])

  let remoteProbes = 0
  const remote = dockerDatabaseRoutePlan(
    'postgres://role:password@ep-preview.us-east-2.aws.neon.tech/city',
    'linux',
  )
  const selectedRemote = await selectDockerDatabaseRoute(remote, async () => {
    remoteProbes += 1
    return false
  })
  assert.deepEqual(
    selectedRemote,
    {
      hostname: 'ep-preview.us-east-2.aws.neon.tech',
      runArguments: ['--add-host', 'host.docker.internal:host-gateway'],
    },
  )
  assert.equal(remote.defaultSslMode, 'require')
  assert.equal(remote.loopback, false)
  assert.equal(remoteProbes, 0)
})

test('Docker selects only an authenticated reachable loopback route', async () => {
  const linux = dockerDatabaseRoutePlan(
    'postgres://role:password@[::1]:5432/city',
    'linux',
  )
  const gatewayCalls: string[] = []
  const gateway = await selectDockerDatabaseRoute(linux, async candidate => {
    gatewayCalls.push(candidate.hostname)
    return true
  })
  assert.equal(gateway.hostname, 'host.docker.internal')
  assert.deepEqual(gatewayCalls, ['host.docker.internal'])

  const fallbackCalls: string[] = []
  const fallback = await selectDockerDatabaseRoute(linux, async candidate => {
    fallbackCalls.push(candidate.hostname)
    return candidate.hostname === '::1'
  })
  assert.equal(fallback.hostname, '::1')
  assert.deepEqual(fallbackCalls, ['host.docker.internal', '::1'])

  await assert.rejects(
    selectDockerDatabaseRoute(linux, async () => false),
    /could not reach the validated local PostgreSQL endpoint/,
  )

  const windows = dockerDatabaseRoutePlan(
    'postgres://role:password@localhost:5432/city',
    'win32',
  )
  let windowsProbes = 0
  await assert.rejects(
    selectDockerDatabaseRoute(windows, async () => {
      windowsProbes += 1
      return false
    }),
    /could not reach the validated local PostgreSQL endpoint/,
  )
  assert.equal(windowsProbes, 1)
})

test('backup requires a proven source target before starting pg_dump', async t => {
  const root = await temporaryRoot(t, '1f3d9-backup-target-red-')
  let dumpCalls = 0

  await assert.rejects(
    runBackup({
      argv: [],
      root,
      environment: {
        DATABASE_URL: 'postgres://role:password@127.0.0.1/city',
      },
      dumpArchive: async () => {
        dumpCalls += 1
        throw new Error('must not dump')
      },
    }),
    /--target local\|preview\|production/i,
  )

  const mismatchedEndpoint = async () => new Response(JSON.stringify({
    endpoints: [{
      id: 'ep-wrong',
      host: 'ep-wrong.us-east-2.aws.neon.tech',
      project_id: 'project-one',
      branch_id: 'branch-preview',
      type: 'read_write',
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })

  await assert.rejects(
    runBackup({
      argv: [
        '--target', 'preview', '--database', 'city',
        '--out', join(root, 'preview.dump'),
      ],
      root,
      environment: {
        CONFIRM_PREVIEW_BACKUP: PREVIEW_ACKNOWLEDGEMENT,
        NEON_API_KEY: 'test-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED:
          'postgres://role:password@ep-preview.us-east-2.aws.neon.tech/city?sslmode=require',
      },
      fetcher: mismatchedEndpoint as typeof fetch,
      dumpArchive: async () => {
        dumpCalls += 1
        throw new Error('must not dump')
      },
    }),
    /prove the preview database target/i,
  )

  assert.equal(dumpCalls, 0)
  assert.deepEqual(await readdir(root), [])
})

test('remote backup rejects insecure TLS and a nonstandard port before pg_dump', async t => {
  const root = await temporaryRoot(t, '1f3d9-backup-transport-red-')
  const outputRoot = await temporaryRoot(t, '1f3d9-backup-private-red-')
  let dumpCalls = 0
  let fetchCalls = 0
  const matchingEndpoint = async () => {
    fetchCalls += 1
    return new Response(JSON.stringify({
      endpoints: [{
        id: 'ep-preview',
        host: 'ep-preview.us-east-2.aws.neon.tech',
        project_id: 'project-one',
        branch_id: 'branch-preview',
        type: 'read_write',
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const baseEnvironment = {
    CONFIRM_PREVIEW_BACKUP: PREVIEW_ACKNOWLEDGEMENT,
    NEON_API_KEY: 'test-neon-key',
    NEON_PROJECT_ID: 'project-one',
    NEON_PREVIEW_BRANCH_ID: 'branch-preview',
    NEON_PRODUCTION_BRANCH_ID: 'branch-production',
  }

  for (const [name, databaseUrl] of [
    [
      'insecure',
      'postgres://role:password@ep-preview.us-east-2.aws.neon.tech/city?sslmode=disable',
    ],
    [
      'wrong-port',
      'postgres://role:password@ep-preview.us-east-2.aws.neon.tech:6543/city?sslmode=require',
    ],
  ] as const) {
    await assert.rejects(
      runBackup({
        argv: [
          '--target', 'preview', '--database', 'city',
          '--out', join(outputRoot, `${name}.dump`),
        ],
        root,
        environment: {
          ...baseEnvironment,
          PREVIEW_DATABASE_URL_UNPOOLED: databaseUrl,
        },
        fetcher: matchingEndpoint as typeof fetch,
        dumpArchive: async () => {
          dumpCalls += 1
          throw new Error('must not dump')
        },
      }),
      /TLS|sslmode|port|5432/i,
    )
  }

  assert.equal(fetchCalls, 0)
  assert.equal(dumpCalls, 0)
  assert.deepEqual(await readdir(root), [])
})

test('Windows remote backup storage rejects an ACL shared with other users', async t => {
  const root = await temporaryRoot(t, '1f3d9-backup-acl-red-')
  const currentUserSid = 'S-1-5-21-1000-1000-1000-1001'
  const privateRules = [
    { sid: currentUserSid, type: 'Allow' },
    { sid: 'S-1-5-18', type: 'Allow' },
    { sid: 'S-1-5-32-544', type: 'Allow' },
  ]

  await assert.doesNotReject(assertPrivateBackupDirectory(root, {
    platform: 'win32',
    inspectWindowsAcl: async () => ({
      current_user_sid: currentUserSid,
      owner_sid: currentUserSid,
      access_rules_protected: true,
      rules: privateRules,
    }),
  }))

  await assert.rejects(
    assertPrivateBackupDirectory(root, {
      platform: 'win32',
      inspectWindowsAcl: async () => ({
        current_user_sid: currentUserSid,
        owner_sid: currentUserSid,
        access_rules_protected: true,
        rules: [
          ...privateRules,
          { sid: 'S-1-5-32-545', type: 'Allow' },
        ],
      }),
    }),
    /owner-private|access control/i,
  )

  await assert.rejects(
    assertPrivateBackupDirectory(root, {
      platform: 'win32',
      inspectWindowsAcl: async () => ({
        current_user_sid: currentUserSid,
        owner_sid: currentUserSid,
        access_rules_protected: false,
        rules: privateRules,
      }),
    }),
    /owner-private|access control/i,
  )
})

test('remote backup checks private storage before pg_dump', async t => {
  const root = await temporaryRoot(t, '1f3d9-backup-acl-gate-red-')
  const outputRoot = await temporaryRoot(t, '1f3d9-backup-acl-output-red-')
  let dumpCalls = 0
  let privacyChecks = 0
  const matchingEndpoint = async () => new Response(JSON.stringify({
    endpoints: [{
      id: 'ep-preview',
      host: 'ep-preview.us-east-2.aws.neon.tech',
      project_id: 'project-one',
      branch_id: 'branch-preview',
      type: 'read_write',
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })

  await assert.rejects(
    runBackup({
      argv: [
        '--target', 'preview', '--database', 'city',
        '--out', join(outputRoot, 'preview.dump'),
      ],
      root,
      environment: {
        CONFIRM_PREVIEW_BACKUP: PREVIEW_ACKNOWLEDGEMENT,
        NEON_API_KEY: 'test-neon-key',
        NEON_PROJECT_ID: 'project-one',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        NEON_PRODUCTION_BRANCH_ID: 'branch-production',
        PREVIEW_DATABASE_URL_UNPOOLED:
          'postgres://role:password@ep-preview.us-east-2.aws.neon.tech/city?sslmode=require',
      },
      fetcher: matchingEndpoint as typeof fetch,
      verifyPrivateDirectory: async directory => {
        privacyChecks += 1
        assert.equal(directory, outputRoot)
        throw new Error('could not prove owner-private output directory')
      },
      dumpArchive: async () => {
        dumpCalls += 1
        throw new Error('must not dump')
      },
    }),
    /owner-private output directory/i,
  )

  assert.equal(privacyChecks, 1)
  assert.equal(dumpCalls, 0)
  assert.deepEqual(await readdir(outputRoot), [])
})

test('remote backup writes only through the canonical directory it verified', async t => {
  const root = await temporaryRoot(t, '1f3d9-backup-canonical-red-')
  const requestedRoot = await temporaryRoot(t, '1f3d9-backup-alias-red-')
  const canonicalRoot = await temporaryRoot(t, '1f3d9-backup-canonical-output-red-')
  const archiveName = '1f3d9-preview-city-2026-08-16T14-15-16Z.dump'
  const matchingEndpoint = async () => new Response(JSON.stringify({
    endpoints: [{
      id: 'ep-preview',
      host: 'ep-preview.us-east-2.aws.neon.tech',
      project_id: 'project-one',
      branch_id: 'branch-preview',
      type: 'read_write',
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })

  const result = await runBackup({
    argv: [
      '--target', 'preview', '--database', 'city',
      '--out', join(requestedRoot, archiveName),
    ],
    root,
    environment: {
      CONFIRM_PREVIEW_BACKUP: PREVIEW_ACKNOWLEDGEMENT,
      NEON_API_KEY: 'test-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED:
        'postgres://role:password@ep-preview.us-east-2.aws.neon.tech/city?sslmode=require',
    },
    fetcher: matchingEndpoint as typeof fetch,
    verifyPrivateDirectory: async directory => {
      assert.equal(directory, requestedRoot)
      return canonicalRoot
    },
    log: () => {},
    dumpArchive: async ({ outputPath }) => {
      assert.equal(basename(outputPath).startsWith(`.${archiveName}.`), true)
      assert.equal(dirname(outputPath), canonicalRoot)
      await writeFile(outputPath, 'canonical archive')
      return { pgDumpVersion: 'pg_dump (PostgreSQL) 17.6' }
    },
    inspectArchive: async () => ({
      pgRestoreVersion: 'pg_restore (PostgreSQL) 17.6',
      tocEntries: 42,
    }),
  })

  assert.equal(result.archivePath, join(canonicalRoot, archiveName))
  assert.deepEqual(await readdir(requestedRoot), [])
})

test('backup publishes a target-named custom archive with matching SHA-256 evidence', async t => {
  const root = await temporaryRoot(t, '1f3d9-backup-manifest-red-')
  const archiveBytes = Buffer.from('PGDMP\u0001fixed-test-archive', 'utf8')
  const secretUrl = 'postgres://role:do-not-publish@127.0.0.1:5432/city'

  const result = await runBackup({
    argv: ['--target', 'local', '--database', 'city'],
    root,
    environment: {
      CONFIRM_LOCAL_BACKUP: LOCAL_ACKNOWLEDGEMENT,
      LOCAL_DATABASE_URL_UNPOOLED: secretUrl,
      NEON_API_KEY: 'do-not-publish-neon-key',
    },
    now: () => new Date('2026-08-16T14:15:16.789Z'),
    nonce: () => '0011223344556677',
    log: () => {},
    dumpArchive: async ({ databaseUrl, outputPath }) => {
      assert.equal(databaseUrl, secretUrl)
      const reserved = await stat(outputPath)
      assert.equal(reserved.isFile(), true)
      assert.equal(reserved.size, 0)
      if (process.platform !== 'win32') assert.equal(reserved.mode & 0o777, 0o600)
      await writeFile(outputPath, archiveBytes, { flag: 'w' })
      return { pgDumpVersion: 'pg_dump (PostgreSQL) 17.6' }
    },
    inspectArchive: async ({ archivePath }) => {
      assert.deepEqual(await readFile(archivePath), archiveBytes)
      return { pgRestoreVersion: 'pg_restore (PostgreSQL) 17.6', tocEntries: 42 }
    },
  })

  assert.equal(
    basename(result.archivePath),
    '1f3d9-local-city-2026-08-16T14-15-16-789Z.dump',
  )
  assert.equal(result.manifestPath, `${result.archivePath}.manifest.json`)
  assert.equal(
    result.sha256,
    createHash('sha256').update(archiveBytes).digest('hex'),
  )

  const manifestText = await readFile(result.manifestPath, 'utf8')
  const manifest = JSON.parse(manifestText) as {
    schema_version: number
    artifact: string
    taken_at: string
    target: {
      mode: string
      database: string
      endpoint_fingerprint: string
    }
    archive: {
      file: string
      format: string
      bytes: number
      sha256: string
      toc_entries: number
    }
  }

  assert.equal(manifest.schema_version, 1)
  assert.equal(manifest.artifact, 'postgresql-custom-archive')
  assert.equal(manifest.taken_at, '2026-08-16T14:15:16.789Z')
  assert.deepEqual(
    { mode: manifest.target.mode, database: manifest.target.database },
    { mode: 'local', database: 'city' },
  )
  assert.match(manifest.target.endpoint_fingerprint, /^[a-f0-9]{16}$/)
  assert.deepEqual(manifest.archive, {
    file: basename(result.archivePath),
    format: 'custom',
    bytes: archiveBytes.length,
    sha256: result.sha256,
    toc_entries: 42,
  })
  assert.doesNotMatch(manifestText, /do-not-publish|postgres:\/\//i)

  const entries = await readdir(join(root, 'backups'))
  assert.deepEqual(entries.sort(), [
    basename(result.archivePath),
    basename(result.manifestPath),
  ].sort())
})

test('backup never replaces an existing archive or manifest', async t => {
  const now = new Date('2026-08-16T14:15:16.789Z')
  const archiveName = '1f3d9-local-city-2026-08-16T14-15-16-789Z.dump'

  for (const occupied of ['archive', 'manifest'] as const) {
    const root = await temporaryRoot(t, `1f3d9-backup-${occupied}-collision-red-`)
    const backupDirectory = join(root, 'backups')
    const archivePath = join(backupDirectory, archiveName)
    const manifestPath = `${archivePath}.manifest.json`
    const occupiedPath = occupied === 'archive' ? archivePath : manifestPath
    const original = Buffer.from(`existing ${occupied}`)
    await mkdir(backupDirectory)
    await writeFile(occupiedPath, original)

    await assert.rejects(
      runBackup({
        argv: ['--target', 'local', '--database', 'city'],
        root,
        environment: {
          CONFIRM_LOCAL_BACKUP: LOCAL_ACKNOWLEDGEMENT,
          LOCAL_DATABASE_URL_UNPOOLED: 'postgres://role@127.0.0.1/city',
        },
        now: () => now,
        nonce: () => '0011223344556677',
        log: () => {},
        dumpArchive: async ({ outputPath }) => {
          await writeFile(outputPath, 'new archive', { flag: 'w' })
          return { pgDumpVersion: 'pg_dump (PostgreSQL) 17.6' }
        },
        inspectArchive: async () => ({
          pgRestoreVersion: 'pg_restore (PostgreSQL) 17.6',
          tocEntries: 42,
        }),
      }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST',
    )

    assert.deepEqual(await readFile(occupiedPath), original)
    assert.deepEqual(await readdir(backupDirectory), [basename(occupiedPath)])
  }
})

test('backup cleanup never deletes a temporary file it did not create', async t => {
  const now = new Date('2026-08-16T14:15:16.789Z')
  const archiveName = '1f3d9-local-city-2026-08-16T14-15-16-789Z.dump'
  const nonce = '0011223344556677'

  for (const occupied of ['archive-temp', 'manifest-temp'] as const) {
    const root = await temporaryRoot(t, `1f3d9-backup-${occupied}-collision-red-`)
    const backupDirectory = join(root, 'backups')
    const archivePath = join(backupDirectory, archiveName)
    const tempArchive = join(backupDirectory, `.${archiveName}.${nonce}.tmp`)
    const tempManifest = join(backupDirectory, `.${archiveName}.manifest.json.${nonce}.tmp`)
    const occupiedPath = occupied === 'archive-temp' ? tempArchive : tempManifest
    const original = Buffer.from(`existing ${occupied}`)
    let dumpCalls = 0
    let inspectCalls = 0
    await mkdir(backupDirectory)
    await writeFile(occupiedPath, original)

    await assert.rejects(
      runBackup({
        argv: ['--target', 'local', '--database', 'city'],
        root,
        environment: {
          CONFIRM_LOCAL_BACKUP: LOCAL_ACKNOWLEDGEMENT,
          LOCAL_DATABASE_URL_UNPOOLED: 'postgres://role@127.0.0.1/city',
        },
        now: () => now,
        nonce: () => nonce,
        log: () => {},
        dumpArchive: async ({ outputPath }) => {
          dumpCalls += 1
          await writeFile(outputPath, 'new archive', { flag: 'w' })
          return { pgDumpVersion: 'pg_dump (PostgreSQL) 17.6' }
        },
        inspectArchive: async () => {
          inspectCalls += 1
          return { pgRestoreVersion: 'pg_restore (PostgreSQL) 17.6', tocEntries: 42 }
        },
      }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST',
    )

    assert.deepEqual(await readFile(occupiedPath), original)
    assert.deepEqual(await readdir(backupDirectory), [basename(occupiedPath)])
    assert.equal(dumpCalls, occupied === 'archive-temp' ? 0 : 1)
    assert.equal(inspectCalls, occupied === 'archive-temp' ? 0 : 1)
    await assert.rejects(readFile(archivePath), { code: 'ENOENT' })
  }
})

test('retention cleanup cannot discard a newly verified backup', async t => {
  const root = await temporaryRoot(t, '1f3d9-backup-retention-red-')
  const backupDirectory = join(root, 'backups')
  await mkdir(backupDirectory)
  const staleArchive = join(
    backupDirectory,
    '1f3d9-local-city-2026-08-15T00-00-00-000Z.dump',
  )
  await writeFile(staleArchive, 'stale archive missing its manifest')
  const logs: string[] = []

  const result = await runBackup({
    argv: ['--target', 'local', '--database', 'city', '--keep', '1'],
    root,
    environment: {
      CONFIRM_LOCAL_BACKUP: LOCAL_ACKNOWLEDGEMENT,
      LOCAL_DATABASE_URL_UNPOOLED: 'postgres://role@127.0.0.1/city',
    },
    now: () => new Date('2026-08-16T14:15:16.789Z'),
    nonce: () => '0011223344556677',
    log: line => logs.push(line),
    dumpArchive: async ({ outputPath }) => {
      await writeFile(outputPath, 'new verified archive')
      return { pgDumpVersion: 'pg_dump (PostgreSQL) 17.6' }
    },
    inspectArchive: async () => ({
      pgRestoreVersion: 'pg_restore (PostgreSQL) 17.6',
      tocEntries: 42,
    }),
  })

  assert.equal(result.retention.warning, 'cleanup-failed')
  assert.deepEqual((await readdir(backupDirectory)).sort(), [
    basename(result.archivePath),
    basename(result.manifestPath),
    basename(staleArchive),
  ].sort())
  assert.match(logs.join('\n'), /retention cleanup failed/i)
})

test('restore drill container is created without network access', () => {
  const args = restoreDrillRunArguments({
    containerName: '1f3d9-restore-drill-123-deadbeefdeadbeef',
    nonce: 'deadbeefdeadbeef',
    expiresAt: '2026-08-18T00:00:00.000Z',
    environmentKeys: ['POSTGRES_PASSWORD', 'POSTGRES_DB'],
    archivePath: 'C:\\drills\\city.dump',
    toolImage: 'postgres@sha256:0000',
  })

  const networkFlag = args.indexOf('--network')
  assert.notEqual(networkFlag, -1)
  assert.equal(args[networkFlag + 1], 'none')
  assert.equal(args.indexOf('--network', networkFlag + 1), -1)
})

test('restore cleanup fails closed instead of reporting a leaked container as success', async () => {
  let cleanupCalls = 0
  await assert.rejects(
    removeRestoreContainer(
      '1f3d9-restore-drill-123-deadbeefdeadbeef',
      async (executable, args) => {
        cleanupCalls += 1
        assert.equal(executable, 'docker')
        assert.deepEqual(args, [
          'rm', '--force', '1f3d9-restore-drill-123-deadbeefdeadbeef',
        ])
        throw new Error('Docker daemon unavailable')
      },
    ),
    /could not remove its owned container/i,
  )
  assert.equal(cleanupCalls, 1)
})

test('restore and cleanup failures preserve both causes for incident triage', () => {
  const restoreFailure = new Error('archive restore rejected')
  const cleanupFailure = new Error('owned container is still running')
  const combined = combineRestoreCleanupErrors(restoreFailure, cleanupFailure)

  assert.equal(combined instanceof AggregateError, true)
  assert.deepEqual(combined.errors, [restoreFailure, cleanupFailure])
  assert.match(combined.message, /archive restore rejected/i)
  assert.match(combined.message, /owned container is still running/i)
})

test('restore drill rejects a checksum mismatch before creating a database', async t => {
  const root = await temporaryRoot(t, '1f3d9-restore-checksum-red-')
  const archivePath = join(root, 'city.dump')
  const manifestPath = `${archivePath}.manifest.json`
  const archiveBytes = Buffer.from('corrupted archive', 'utf8')
  await writeFile(archivePath, archiveBytes)
  await writeFile(manifestPath, JSON.stringify({
    schema_version: 1,
    artifact: 'postgresql-custom-archive',
    taken_at: '2026-08-16T14:15:16.789Z',
    target: {
      mode: 'local',
      database: 'city',
      endpoint_fingerprint: '0123456789abcdef',
    },
    archive: {
      file: 'city.dump',
      format: 'custom',
      bytes: archiveBytes.length,
      sha256: '0'.repeat(64),
      toc_entries: 42,
    },
  }))

  let drillCalls = 0
  await assert.rejects(
    runRestoreDrill({
      argv: ['--archive', archivePath],
      performDrill: async () => {
        drillCalls += 1
        throw new Error('must not create a drill database')
      },
    }),
    /checksum/i,
  )
  assert.equal(drillCalls, 0)
})

test('restore drill rejects a remote manifest without safe target IDs', async t => {
  const root = await temporaryRoot(t, '1f3d9-restore-identity-red-')
  const archivePath = join(root, 'production.dump')
  const archiveBytes = Buffer.from('PGDMP remote archive', 'utf8')
  await writeFile(archivePath, archiveBytes)
  await writeFile(`${archivePath}.manifest.json`, JSON.stringify({
    schema_version: 1,
    artifact: 'postgresql-custom-archive',
    taken_at: '2026-08-16T14:15:16.789Z',
    target: {
      mode: 'production',
      database: 'city',
      endpoint_fingerprint: '0123456789abcdef',
    },
    archive: {
      file: basename(archivePath),
      format: 'custom',
      bytes: archiveBytes.length,
      sha256: createHash('sha256').update(archiveBytes).digest('hex'),
      toc_entries: 42,
    },
  }))

  let drillCalls = 0
  await assert.rejects(
    runRestoreDrill({
      argv: ['--archive', archivePath],
      performDrill: async () => {
        drillCalls += 1
        throw new Error('must not create a drill database')
      },
    }),
    /remote.*project.*branch|target identity/i,
  )
  assert.equal(drillCalls, 0)
})
