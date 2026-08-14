import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
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
const releaseMigration = readFileSync(
  new URL('../db/migrations/20260813_hosted_chat_signin.sql', import.meta.url),
  'utf8',
)

test('the ordinary app deploy never runs or pulls a database migration', () => {
  assert.doesNotMatch(deployScript, /RUN_MIGRATE|scripts\/migrate\.ts|npm run migrate/i)
  assert.doesNotMatch(deployScript, /env pull[^\n]*production/i)
  assert.match(deployScript, /HOSTED_CHAT_SIGNIN_ENABLED/)
  assert.match(deployScript, /HOSTED_CHAT_SIGNIN_ENABLED=false/)
  assert.doesNotMatch(deployScript, /PUBLIC_ORIGIN[^\n]*preview|preview[^\n]*PUBLIC_ORIGIN/i)
})

test('production environment writes cannot fail silently before deployment', () => {
  const environmentWrites = deployScript
    .split('\n')
    .filter(line => /VC env add/.test(line))

  assert.ok(environmentWrites.length >= 2)
  for (const line of environmentWrites) {
    assert.doesNotMatch(line, /\|\|\s*true/)
  }

  const releaseProofs = [...deployScript.matchAll(/^verify_release_intent$/gm)]
  assert.ok(releaseProofs.length >= 3, 'release state must be rechecked immediately before writes and deploy')
  const environmentStep = deployScript.indexOf('echo "== 5. production app environment"')
  const firstEnvironmentWrite = deployScript.indexOf('VC env add', environmentStep)
  const environmentProof = deployScript.indexOf('verify_release_intent', environmentStep)
  assert.ok(environmentProof > environmentStep && environmentProof < firstEnvironmentWrite)
  const deployStep = deployScript.indexOf('echo "== 6. deploy"')
  const productionDeploy = deployScript.indexOf('VC deploy --prod', deployStep)
  const deployProof = deployScript.indexOf('verify_release_intent', deployStep)
  assert.ok(deployProof > deployStep && deployProof < productionDeploy)
})

test('every production release test gate runs before the first provider call', () => {
  const providerStart = deployScript.indexOf('VC whoami')
  assert.ok(providerStart > 0)
  for (const command of [
    'npm test',
    'npm run typecheck',
    'npm run test:postgres',
    'npm run test:e2e',
  ]) {
    const position = deployScript.indexOf(command)
    assert.ok(position > 0, `missing production gate: ${command}`)
    assert.ok(position < providerStart, `${command} must run before provider preflight`)
  }
})

test('preview migration requires exact acknowledgement and named isolated Neon targets', () => {
  assert.throws(
    () => resolveMigrationRun(['--target', 'preview'], { DATABASE_URL: 'postgres://example/db' }),
    /APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW/,
  )

  assert.throws(
    () => resolveMigrationRun(['--target', 'preview'], {
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
    () => resolveMigrationRun(['--target', 'preview'], {
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-production',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    }),
    /preview branch.*production branch/i,
  )

  const run = resolveMigrationRun(['--target', 'preview'], {
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

test('production deploy dry-run proves exact clean branch and commit before network work', () => {
  const root = mkdtempSync(join(tmpdir(), '1f3d9-deploy-guard-'))
  mkdirSync(join(root, 'scripts'))
  copyFileSync(new URL('../scripts/deploy.sh', import.meta.url), join(root, 'scripts', 'deploy.sh'))
  writeFileSync(join(root, 'README.md'), 'release fixture\n')
  writeFileSync(join(root, '.gitignore'), 'env.txt\n')

  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'release-test@example.invalid')
  git('config', 'user.name', 'Release Test')
  git('checkout', '-q', '-b', 'codex/release-test')
  git('add', '.gitignore', 'README.md', 'scripts/deploy.sh')
  git('commit', '-q', '-m', 'test release')
  const commit = git('rev-parse', 'HEAD').toString().trim()
  const writeReleaseIntent = (
    releaseCommit: string,
    acknowledgement = 'DEPLOY_REVIEWED_COMMIT_TO_1F3D9_PRODUCTION',
  ) => writeFileSync(join(root, 'env.txt'), [
    `CONFIRM_PRODUCTION_DEPLOY=${acknowledgement}`,
    'PRODUCTION_RELEASE_BRANCH=codex/release-test',
    `PRODUCTION_RELEASE_COMMIT=${releaseCommit}`,
    '',
  ].join('\n'))

  writeReleaseIntent(commit, 'yes')
  const unacknowledged = spawnSync('bash', ['scripts/deploy.sh', '--verify-release-only'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.notEqual(unacknowledged.status, 0)
  assert.match(
    `${unacknowledged.stdout}\n${unacknowledged.stderr}`,
    /DEPLOY_REVIEWED_COMMIT_TO_1F3D9_PRODUCTION/,
  )

  writeReleaseIntent(commit)
  const verified = spawnSync('bash', ['scripts/deploy.sh', '--verify-release-only'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(verified.status, 0, verified.stderr || verified.stdout)
  assert.match(verified.stdout, /release branch and commit verified/i)
  assert.doesNotMatch(verified.stdout, /vercel ok|porkbun ok/i)

  writeFileSync(join(root, 'untracked.txt'), 'dirty\n')
  const dirty = spawnSync('bash', ['scripts/deploy.sh', '--verify-release-only'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.notEqual(dirty.status, 0)
  assert.match(`${dirty.stdout}\n${dirty.stderr}`, /worktree.*clean/i)

  unlinkSync(join(root, 'untracked.txt'))
  writeReleaseIntent('0'.repeat(40))
  const wrongCommit = spawnSync('bash', ['scripts/deploy.sh', '--verify-release-only'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.notEqual(wrongCommit.status, 0)
})

test('deploy settings are parsed as inert data and shell syntax fails before release proof', () => {
  assert.doesNotMatch(deployScript, /(?:^|[;&]\s*)\.?\s*source\s+env\.txt|\.\s*<\(/m)
  assert.match(deployScript, /load_deploy_settings/)
  assert.match(deployScript, /unexpected key in env\.txt/)

  const root = mkdtempSync(join(tmpdir(), '1f3d9-deploy-data-'))
  mkdirSync(join(root, 'scripts'))
  copyFileSync(new URL('../scripts/deploy.sh', import.meta.url), join(root, 'scripts', 'deploy.sh'))
  writeFileSync(join(root, 'README.md'), 'release fixture\n')
  writeFileSync(join(root, '.gitignore'), 'env.txt\n')

  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'release-test@example.invalid')
  git('config', 'user.name', 'Release Test')
  git('checkout', '-q', '-b', 'codex/release-test')
  git('add', '.gitignore', 'README.md', 'scripts/deploy.sh')
  git('commit', '-q', '-m', 'test release')
  const commit = git('rev-parse', 'HEAD').toString().trim()
  const marker = join(root, 'shell-command-ran')

  const maliciousFiles = [
    [
      'CONFIRM_PRODUCTION_DEPLOY=DEPLOY_REVIEWED_COMMIT_TO_1F3D9_PRODUCTION',
      'PRODUCTION_RELEASE_BRANCH=$(touch shell-command-ran)',
      `PRODUCTION_RELEASE_COMMIT=${commit}`,
    ],
    [
      'CONFIRM_PRODUCTION_DEPLOY=DEPLOY_REVIEWED_COMMIT_TO_1F3D9_PRODUCTION',
      'PRODUCTION_RELEASE_BRANCH=codex/release-test',
      `PRODUCTION_RELEASE_COMMIT=${commit}`,
      'touch shell-command-ran',
    ],
  ]

  for (const lines of maliciousFiles) {
    writeFileSync(join(root, 'env.txt'), `${lines.join('\n')}\n`)
    const result = spawnSync('bash', ['scripts/deploy.sh', '--verify-release-only'], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0)
    assert.equal(existsSync(marker), false, 'env.txt content executed as shell code')
    assert.doesNotMatch(result.stdout, /vercel ok|porkbun ok/i)
  }
})

test('a failed Postgres or browser release gate stops before every provider command', () => {
  const root = mkdtempSync(join(tmpdir(), '1f3d9-deploy-test-gates-'))
  const bin = mkdtempSync(join(tmpdir(), '1f3d9-deploy-test-bin-'))
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'node_modules'))
  copyFileSync(new URL('../scripts/deploy.sh', import.meta.url), join(root, 'scripts', 'deploy.sh'))
  writeFileSync(join(root, 'README.md'), 'release fixture\n')
  writeFileSync(join(root, '.gitignore'), 'env.txt\n')

  const npmStub = join(bin, 'npm')
  const providerStub = (name: string) => join(bin, name)
  writeFileSync(npmStub, [
    '#!/usr/bin/env bash',
    'printf "npm %s\\n" "$*" >> "$TEST_COMMAND_LOG"',
    '[ "${FAIL_GATE:-}" = "postgres" ] && [ "$*" = "run test:postgres" ] && exit 41',
    '[ "${FAIL_GATE:-}" = "e2e" ] && [ "$*" = "run test:e2e" ] && exit 42',
    'exit 0',
    '',
  ].join('\n'))
  for (const name of ['npx', 'curl']) {
    writeFileSync(providerStub(name), [
      '#!/usr/bin/env bash',
      `printf "PROVIDER ${name} %s\\n" "$*" >> "$TEST_COMMAND_LOG"`,
      'exit 99',
      '',
    ].join('\n'))
  }
  for (const name of ['npm', 'npx', 'curl']) chmodSync(join(bin, name), 0o755)
  const bashBin = spawnSync('bash', ['-lc', 'pwd'], { cwd: bin, encoding: 'utf8' }).stdout.trim()

  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'release-test@example.invalid')
  git('config', 'user.name', 'Release Test')
  git('checkout', '-q', '-b', 'codex/release-test')
  git('add', '.gitignore', 'README.md', 'scripts/deploy.sh')
  git('commit', '-q', '-m', 'test release')
  const commit = git('rev-parse', 'HEAD').toString().trim()
  writeFileSync(join(root, 'env.txt'), [
    'CONFIRM_PRODUCTION_DEPLOY=DEPLOY_REVIEWED_COMMIT_TO_1F3D9_PRODUCTION',
    'PRODUCTION_RELEASE_BRANCH=codex/release-test',
    `PRODUCTION_RELEASE_COMMIT=${commit}`,
    'VERCEL_TOKEN=test-token',
    'PORKBUN_API_KEY=pk1_test',
    'PORKBUN_SECRET_KEY=sk1_test',
    '',
  ].join('\n'))

  const wrapper = join(bin, 'run-deploy-gate-test.sh')
  for (const failedGate of ['postgres', 'e2e']) {
    const commandLog = join(bin, `${failedGate}.log`)
    writeFileSync(wrapper, [
      '#!/usr/bin/env bash',
      `PATH=${JSON.stringify(bashBin)}:$PATH`,
      'export PATH',
      `TEST_COMMAND_LOG=${JSON.stringify(`${bashBin}/${failedGate}.log`)}`,
      'export TEST_COMMAND_LOG',
      `FAIL_GATE=${failedGate}`,
      'export FAIL_GATE',
      `cd ${JSON.stringify(
        spawnSync('bash', ['-lc', 'pwd'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
      )}`,
      'bash scripts/deploy.sh',
      '',
    ].join('\n'))
    const result = spawnSync('bash', [`${bashBin}/run-deploy-gate-test.sh`], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0)
    const commands = readFileSync(commandLog, 'utf8')
    assert.match(commands, new RegExp(`npm run test:${failedGate}`))
    assert.doesNotMatch(commands, /PROVIDER/)
  }
})

test('production migration requires a real Neon snapshot configuration and exact acknowledgement', () => {
  const productionUrl = 'postgres://role@example.neon.tech/db'

  assert.throws(
    () => resolveMigrationRun(['--target', 'production'], {
      PRODUCTION_DATABASE_URL_UNPOOLED: productionUrl,
    }),
    /APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION/,
  )

  assert.throws(
    () => resolveMigrationRun(['--target', 'production'], {
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
    () => resolveMigrationRun(['--target', 'production'], {
      PRODUCTION_DATABASE_URL_UNPOOLED: productionUrl,
      CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
    }),
    /NEON_API_KEY/,
  )

  const run = resolveMigrationRun(['--target', 'production'], {
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

test('the reviewed release migration is additive and OAuth-only', () => {
  const uncommented = releaseMigration.replace(/^\s*--.*$/gm, '')
  assert.doesNotMatch(uncommented, /^\s*(?:DROP|ALTER|UPDATE|DELETE|TRUNCATE)\b/im)

  const statements = splitSqlStatements(releaseMigration)
  assert.ok(statements.length > 0)
  for (const statement of statements) {
    const executable = statement.replace(/^\s*--.*$/gm, '').trim()
    assert.match(executable, /^CREATE\s+(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+oauth_/i)
  }

  assert.doesNotMatch(uncommented, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+residents\b/i)
  assert.match(uncommented, /REFERENCES\s+residents\s*\(id\)\s+ON\s+DELETE\s+RESTRICT/i)
  assert.doesNotMatch(fullSchema, /CREATE\s+TRIGGER\s+oauth_\w+_append_only/i)
})

test('fresh installs contain every reviewed OAuth migration statement', () => {
  const normalize = (statement: string) => statement
    .replace(/^\s*--.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()

  const freshInstallStatements = new Set(splitSqlStatements(fullSchema).map(normalize))
  for (const statement of splitSqlStatements(releaseMigration)) {
    assert.ok(
      freshInstallStatements.has(normalize(statement)),
      'db/schema.sql drifted from the reviewed hosted-chat migration',
    )
  }
})

test('package commands name preview and production migrations explicitly', () => {
  assert.equal(packageJson.scripts.migrate, undefined)
  assert.match(packageJson.scripts['migrate:local'] ?? '', /--target local$/)
  assert.match(packageJson.scripts['migrate:preview'] ?? '', /--target preview$/)
  assert.match(packageJson.scripts['migrate:production'] ?? '', /--target production$/)
})
