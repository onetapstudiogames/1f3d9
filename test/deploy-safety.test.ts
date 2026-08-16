import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createProductionSnapshot,
  prepareProductionMigration,
  resolveMigrationRun,
  splitSqlStatements,
  verifyPreviewDatabaseTarget,
  verifyProductionDatabaseTarget,
} from '../scripts/migrate.ts'

const deployScript = readFileSync(new URL('../scripts/deploy.sh', import.meta.url), 'utf8')
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> }
const fullSchema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8')
const oauthMigration = readFileSync(
  new URL('../db/migrations/20260813_hosted_chat_signin.sql', import.meta.url),
  'utf8',
)
const agreementAccessionMigration = readFileSync(
  new URL('../db/migrations/20260814_agreement_accession.sql', import.meta.url),
  'utf8',
)
const openToUseMigrationUrl = new URL(
  '../db/migrations/20260815_open_to_use.sql',
  import.meta.url,
)
const paymentAttemptsMigrationUrl = new URL(
  '../db/migrations/20260816_payment_attempts.sql',
  import.meta.url,
)

function withoutGitHookEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const name of Object.keys(environment)) {
    if (name.startsWith('GIT_')) delete environment[name]
  }
  return { ...environment, ...overrides }
}

test('the retired deploy helper is read-only outside local verification', () => {
  assert.doesNotMatch(deployScript, /RUN_MIGRATE|scripts\/migrate\.ts|npm run migrate/i)
  assert.doesNotMatch(deployScript, /\bVC\s+deploy\b|\bvercel(?:@latest)?\s+deploy\b/i)
  assert.doesNotMatch(deployScript, /\bVC\s+env\s+add\b|\bVAPI\s+(?:POST|PATCH|PUT|DELETE)\b|\bPB\s+/i)
  assert.doesNotMatch(deployScript, /VERCEL_TOKEN|PORKBUN_API_KEY|PORKBUN_SECRET_KEY/)
})

test('every release test gate remains part of explicit branch preparation', () => {
  for (const command of [
    'npm test',
    'npm run typecheck',
    'npm run test:postgres',
    'npm run test:e2e',
  ]) {
    const position = deployScript.indexOf(command)
    assert.ok(position > 0, `missing preparation gate: ${command}`)
  }
  assert.match(deployScript, /--prepare/)
  assert.match(deployScript, /merge[^\n]*\bmain\b/i)
})

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

type PreparationFixture = Readonly<{
  root: string
  commandLog: string
  git: (...args: string[]) => Buffer
  run: () => SpawnSyncReturns<string>
}>

function createPreparationFixture(): PreparationFixture {
  const root = mkdtempSync(join(tmpdir(), '1f3d9-deploy-prepare-'))
  const remoteRoot = mkdtempSync(join(tmpdir(), '1f3d9-deploy-remote-'))
  const remote = join(remoteRoot, 'origin.git')
  const hooks = mkdtempSync(join(tmpdir(), '1f3d9-deploy-hooks-'))
  const bin = mkdtempSync(join(tmpdir(), '1f3d9-deploy-bin-'))
  const commandLog = join(bin, 'npm.log')
  const gitEnvironment = withoutGitHookEnvironment({
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: 'NUL',
  })
  const git = (...args: string[]) => execFileSync(
    'git',
    ['-c', `core.hooksPath=${hooks}`, '-C', root, ...args],
    { cwd: tmpdir(), stdio: 'pipe', env: gitEnvironment },
  )

  execFileSync('git', ['-c', `core.hooksPath=${hooks}`, 'init', '--bare', '-q', remote], {
    cwd: tmpdir(),
    stdio: 'pipe',
    env: gitEnvironment,
  })
  const bashRemoteRoot = spawnSync('bash', ['-lc', 'pwd'], {
    cwd: remoteRoot,
    encoding: 'utf8',
    env: withoutGitHookEnvironment(),
  }).stdout.trim()
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'node_modules'))
  copyFileSync(new URL('../scripts/deploy.sh', import.meta.url), join(root, 'scripts', 'deploy.sh'))
  writeFileSync(join(root, 'README.md'), 'release fixture\n')
  git('init', '-q', '--initial-branch=agent/release-test')
  git('config', '--local', 'user.email', 'release-test@example.invalid')
  git('config', '--local', 'user.name', 'Release Test')
  git('add', 'README.md', 'scripts/deploy.sh')
  git('commit', '-q', '-m', 'test release')
  git('remote', 'add', 'origin', remote)
  git('push', '-q', '-u', 'origin', 'HEAD')
  git('remote', 'set-url', 'origin', `${bashRemoteRoot}/origin.git`)

  const npmStub = join(bin, 'npm')
  writeFileSync(npmStub, [
    '#!/usr/bin/env bash',
    'printf "npm %s\\n" "$*" >> "$TEST_COMMAND_LOG"',
    'exit 0',
    '',
  ].join('\n'))
  chmodSync(npmStub, 0o755)
  const bashBin = spawnSync('bash', ['-lc', 'pwd'], {
    cwd: bin,
    encoding: 'utf8',
    env: withoutGitHookEnvironment(),
  }).stdout.trim()
  const bashRoot = spawnSync('bash', ['-lc', 'pwd'], {
    cwd: root,
    encoding: 'utf8',
    env: withoutGitHookEnvironment(),
  }).stdout.trim()
  const wrapper = join(bin, 'run-prepare.sh')
  writeFileSync(wrapper, [
    '#!/usr/bin/env bash',
    `PATH=${JSON.stringify(bashBin)}:$PATH`,
    'export PATH',
    `TEST_COMMAND_LOG=${JSON.stringify(`${bashBin}/npm.log`)}`,
    'export TEST_COMMAND_LOG',
    `cd ${JSON.stringify(bashRoot)}`,
    'bash scripts/deploy.sh --prepare',
    '',
  ].join('\n'))
  chmodSync(wrapper, 0o755)

  return {
    root,
    commandLog,
    git,
    run: () => spawnSync('bash', [`${bashBin}/run-prepare.sh`], {
      cwd: root,
      encoding: 'utf8',
      env: withoutGitHookEnvironment(),
    }),
  }
}

test('manual deploy invocation fails closed with GitHub-to-Vercel guidance', () => {
  const fixture = createPreparationFixture()
  const result = spawnSync('bash', ['scripts/deploy.sh'], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: withoutGitHookEnvironment(),
  })

  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /--prepare/)
  assert.match(`${result.stdout}\n${result.stderr}`, /merge[^\n]*main/i)
  assert.equal(existsSync(fixture.commandLog), false)
})

test('preparation proves a clean GitHub branch and runs every local gate without deploying', () => {
  const fixture = createPreparationFixture()
  const result = fixture.run()

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /did not deploy/i)
  assert.match(result.stdout, /merge[^\n]*main/i)
  const commands = readFileSync(fixture.commandLog, 'utf8')
  for (const command of ['npm test', 'npm run typecheck', 'npm run test:postgres', 'npm run test:e2e']) {
    assert.match(commands, new RegExp(`^${command}$`, 'm'))
  }
})

test('dirty or not-pushed work stops before any preparation gate', () => {
  const dirty = createPreparationFixture()
  writeFileSync(join(dirty.root, 'untracked.txt'), 'not reviewed\n')
  const dirtyResult = dirty.run()
  assert.notEqual(dirtyResult.status, 0)
  assert.match(`${dirtyResult.stdout}\n${dirtyResult.stderr}`, /worktree.*clean/i)
  assert.equal(existsSync(dirty.commandLog), false)

  const unpushed = createPreparationFixture()
  writeFileSync(join(unpushed.root, 'README.md'), 'new unpushed commit\n')
  unpushed.git('add', 'README.md')
  unpushed.git('commit', '-q', '-m', 'unpushed')
  const unpushedResult = unpushed.run()
  assert.notEqual(unpushedResult.status, 0)
  assert.match(`${unpushedResult.stdout}\n${unpushedResult.stderr}`, /pushed.*origin/i)
  assert.equal(existsSync(unpushed.commandLog), false)
})

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

test('migration target must be named explicitly', () => {
  assert.throws(
    () => resolveMigrationRun([], { DATABASE_URL: 'postgres://role@example.neon.tech/db' }),
    /--target local\|preview\|production/,
  )
})

test('remote migration file must be named explicitly', () => {
  assert.throws(
    () => resolveMigrationRun(['--target', 'preview'], {}),
    /--migration hosted-chat-signin\|world-root-expand\|world-root-topology\|public-pagination\|agreement-accession\|open-to-use\|payment-attempts/,
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
  ] as const) {
    for (const statement of splitSqlStatements(migration)) {
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
})

test('payment attempts are an explicitly selected additive release', () => {
  const paymentAttemptsMigration = readFileSync(paymentAttemptsMigrationUrl, 'utf8')
  const uncommented = paymentAttemptsMigration.replace(/^\s*--.*$/gm, '')
  const statements = splitSqlStatements(paymentAttemptsMigration)

  assert.equal(statements.length, 3)
  assert.doesNotMatch(uncommented, /^\s*(?:DROP|UPDATE|DELETE|TRUNCATE)\b/im)
  assert.match(uncommented, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+payment_attempts/i)
  assert.match(uncommented, /payment_key\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i)
  assert.match(uncommented, /status\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(status\s+IN\s+\('initiated',\s*'settled',\s*'completed',\s*'failed'\)\)/i)
  assert.match(uncommented, /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+payment_attempts_actor_created/i)
  assert.match(uncommented, /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+payment_attempts_completion/i)

  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'payment-attempts'],
    {
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    },
  )
  assert.equal(preview.migrationFile, 'db/migrations/20260816_payment_attempts.sql')

  const production = resolveMigrationRun(
    ['--target', 'production', '--migration', 'payment-attempts'],
    {
      CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      PRODUCTION_SNAPSHOT_NAME: 'payment-attempts-release',
    },
  )
  assert.equal(production.migrationFile, 'db/migrations/20260816_payment_attempts.sql')
})

test('public pagination indexes are an explicitly selected additive release', () => {
  const paginationMigration = readFileSync(
    new URL('../db/migrations/20260814_public_pagination.sql', import.meta.url),
    'utf8',
  )
  const uncommented = paginationMigration.replace(/^\s*--.*$/gm, '')
  const statements = splitSqlStatements(paginationMigration)

  assert.equal(statements.length, 10)
  assert.doesNotMatch(uncommented, /^\s*(?:DROP|ALTER|UPDATE|DELETE|TRUNCATE)\b/im)
  for (const statement of statements) {
    const executable = statement.replace(/^\s*--.*$/gm, '').trim()
    assert.match(executable, /^CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\b/i)
  }

  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'public-pagination'],
    {
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    },
  )
  assert.equal(preview.migrationFile, 'db/migrations/20260814_public_pagination.sql')

  const production = resolveMigrationRun(
    ['--target', 'production', '--migration', 'public-pagination'],
    {
      CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      PRODUCTION_SNAPSHOT_NAME: 'public-pagination-release',
    },
  )
  assert.equal(production.migrationFile, 'db/migrations/20260814_public_pagination.sql')

  assert.match(packageJson.scripts['migrate:preview:public-pagination'] ?? '', /--target preview --migration public-pagination$/)
  assert.match(packageJson.scripts['migrate:production:public-pagination'] ?? '', /--target production --migration public-pagination$/)
})
