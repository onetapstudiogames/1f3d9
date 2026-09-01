import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
import { withoutInheritedGitEnvironment } from '../scripts/child-process-environment.ts'

const deployScript = readFileSync(new URL('../scripts/deploy.sh', import.meta.url), 'utf8')
const ciWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const liveProbeWorkflow = readFileSync(
  new URL('../.github/workflows/live-probe.yml', import.meta.url),
  'utf8',
)
const llmsContract = readFileSync(new URL('../src/llms.txt', import.meta.url), 'utf8')
const testingGuide = readFileSync(new URL('../docs/TESTING.md', import.meta.url), 'utf8')
const workingStandard = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8')
const PAYMENT_RELIABILITY_STANDARD = [
  '## Payment reliability',
  '',
  'Every payment-path change requires:',
  '',
  '- real-timing tests against real PostgreSQL, including chain finality later than',
  '  the intent or operation window;',
  '- adversarial refuter review before merge; and',
  '- a read-only or self-cleaning post-deploy production probe of the changed',
  '  surface.',
  '',
  'Use city PR #107 as the test model. City issue #103, market PRs #13/#20, and',
  'city PRs #115/#116 record why: mocks missed chain timing and SQL preparation,',
  'while non-production runtimes missed live-only failures.',
].join('\n')
const deploymentRunbook = readFileSync(
  new URL('../docs/runbooks/DEPLOYMENT.md', import.meta.url),
  'utf8',
)
const environmentRunbook = readFileSync(
  new URL('../docs/runbooks/ENVIRONMENT.md', import.meta.url),
  'utf8',
)
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> }

function assertPostgresTestDiscovered(fileName: string): void {
  assert.match(packageJson.scripts['test:postgres'] ?? '', /test\/integration\/\*\.test\.ts/u)
  assert.equal(
    existsSync(new URL(`../test/integration/${fileName}`, import.meta.url)),
    true,
    `missing glob-discovered PostgreSQL test: ${fileName}`,
  )
}

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
const paymentResponseReplayMigrationUrl = new URL(
  '../db/migrations/20260816_payment_response_replay.sql',
  import.meta.url,
)
const paymentResponseBodyReplayMigrationUrl = new URL(
  '../db/migrations/20260817_payment_response_body_replay.sql',
  import.meta.url,
)
const paymentResponseBodyRolloutMigrationUrl = new URL(
  '../db/migrations/20260818_payment_response_body_rollout.sql',
  import.meta.url,
)
const paymentResponseBodyValidationMigrationUrl = new URL(
  '../db/migrations/20260818_payment_response_body_validate.sql',
  import.meta.url,
)
const identityRecoveryMigrationUrl = new URL(
  '../db/migrations/20260816_identity_recovery.sql',
  import.meta.url,
)
const identityRotationMigrationUrl = new URL(
  '../db/migrations/20260816_identity_rotation.sql',
  import.meta.url,
)
const initialRecoveryCodesMigrationUrl = new URL(
  '../db/migrations/20260817_initial_recovery_codes.sql',
  import.meta.url,
)
const resumableRegistrationMigrationUrl = new URL(
  '../db/migrations/20260826_resumable_registration.sql',
  import.meta.url,
)
const paymentRecoveryTriggerRepairMigrationUrl = new URL(
  '../db/migrations/20260823_payment_recovery_trigger_repair.sql',
  import.meta.url,
)
const paymentLateFinalityRecheckMigrationUrl = new URL(
  '../db/migrations/20260825_payment_late_finality_recheck.sql',
  import.meta.url,
)

function finalNonEmptyLine(output: string): string | undefined {
  return output
    .split(/\r?\n/u)
    .filter(line => line.trim().length > 0)
    .at(-1)
}

function waitMilliseconds(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function removeDirectoryWithRetries(path: string): void {
  let lastError: unknown
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      rmSync(path, {
        force: true,
        maxRetries: 3,
        recursive: true,
        retryDelay: 50,
      })
      return
    } catch (error) {
      lastError = error
      waitMilliseconds(50 * (attempt + 1))
    }
  }
  throw lastError
}

const preparationFixtureRoots = new Set<string>()

function createPreparationFixtureRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  preparationFixtureRoots.add(root)
  return root
}

function cleanupPreparationFixtureRoot(root: string): void {
  removeDirectoryWithRetries(root)
  preparationFixtureRoots.delete(root)
}

function cleanupRegisteredPreparationFixtureRoots(): void {
  for (const root of [...preparationFixtureRoots].reverse()) {
    cleanupPreparationFixtureRoot(root)
  }
}

test.after(cleanupRegisteredPreparationFixtureRoots)

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

test('payment reliability is fail-hard in required checks and documented where it binds', () => {
  assert.ok(workingStandard.includes(PAYMENT_RELIABILITY_STANDARD))
  assert.match(workingStandard, /scheduled `live-probe` workflow/iu)
  assert.match(ciWorkflow, /^jobs:\r?\n  checks:\r?\n    runs-on:/mu)
  assert.match(
    ciWorkflow,
    /- name: Run PostgreSQL integration tests\r?\n\s+run: npm run test:postgres/u,
  )
  assert.doesNotMatch(ciWorkflow, /continue-on-error:\s*true/iu)

  const postgresCommand = packageJson.scripts['test:postgres'] ?? ''
  assert.match(postgresCommand, /--test-concurrency=1/u)
  assert.match(postgresCommand, /test\/integration\/\*\.test\.ts/u)
  assert.doesNotMatch(postgresCommand, /test\/integration\/[\w-]+-postgres\.test\.ts/u)

  assert.match(
    testingGuide,
    /CI \(`\.github\/workflows\/ci\.yml`\)[\s\S]{0,300}PostgreSQL/iu,
  )
  assert.doesNotMatch(testingGuide, /postgres suites run locally/iu)

  assert.match(liveProbeWorkflow, /CUSTOMER\.DISPUTE\.CREATED/u)
  assert.match(liveProbeWorkflow, /unsigned dispute events stop at the signature wall/iu)
  assert.match(liveProbeWorkflow, /founder dispute review stops without a root key/iu)
  assert.match(
    liveProbeWorkflow,
    /city-credit\/disputes\/PP-D-LIVE-PROBE\/resolve[\s\S]{0,500}\[ "\$CODE" = "401" \]/u,
  )
  assert.match(liveProbeWorkflow, /\[ "\$CODE" = "401" \]/u)
  assert.doesNotMatch(liveProbeWorkflow, /PAYPAL_CLIENT_SECRET|PAYPAL_WEBHOOK_ID/u)

  for (const eventType of [
    'PAYMENT.CAPTURE.COMPLETED',
    'PAYMENT.SALE.COMPLETED',
    'CUSTOMER.DISPUTE.CREATED',
    'CUSTOMER.DISPUTE.UPDATED',
    'CUSTOMER.DISPUTE.RESOLVED',
  ]) {
    assert.match(environmentRunbook, new RegExp(eventType.replaceAll('.', '\\.'), 'u'))
  }
})

test('the read-only live probe enforces the public kind drawing contract', () => {
  const probe = liveProbeWorkflow.match(
    /- name: paid kind drawings resolve without spending[\s\S]*?(?=\r?\n      - name:)/u,
  )?.[0]
  assert.ok(probe, 'missing paid kind drawing live-probe step')

  const contractAssertions = [...probe.matchAll(
    /echo "\$CONTRACT" \| grep -Fq "([^"]+)"/gu,
  )].map(match => match[1])
  assert.deepEqual(contractAssertions, [
    'A kind revision publishes at most eight variants drawn and described by that exact revision owner.',
    'it pays only for frontier founding, kind invention, and kind revision',
  ])
  for (const assertion of contractAssertions) {
    assert.ok(
      llmsContract.includes(assertion!),
      `live-probe contract assertion is absent from src/llms.txt: ${assertion}`,
    )
  }

  assert.match(probe, /curl -sf --max-time 20 "https:\/\/1f3d9\.com\/api\/drawing\/kind\/\$KIND_ID"/u)
  assert.doesNotMatch(probe, /(?:-X|--request)\s+(?:POST|PUT|PATCH|DELETE)/iu)
  assert.match(probe, /\.state == "undrawn"/u)
  assert.match(probe, /\.state == "refused"/u)
  assert.match(probe, /\.state == "in_progress"/u)
  assert.match(probe, /\.state == "complete"/u)
  assert.match(probe, /\.presentation_state == "blank"/u)
  assert.match(probe, /\.source == "none"/u)
  assert.match(probe, /\.source == "kind_base"/u)
  assert.match(probe, /\.drawing\.indices\s*\|\s*type == "array" and length == 64/u)
  assert.match(probe, /\.rows\s*\|\s*type == "array"\s*and length == 8/u)
  assert.match(probe, /all\(\.\[\]; type == "string" and test\(/u)
  assert.match(probe, /\.kind_name \| type == "string" and length > 0/u)
  assert.doesNotMatch(probe, /\.source == null|kind_revision/u)
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
  run: (overrides?: NodeJS.ProcessEnv) => SpawnSyncReturns<string>
  cleanup: () => void
}>

const laterHolderReleaseReady = Object.freeze({
  CONFIRM_LATER_HOLDER_PROVIDER_KEY: 'VERIFIED_IN_VERCEL_PREVIEW_AND_PRODUCTION',
  CONFIRM_LATER_HOLDER_MIGRATION: 'APPLIED_TO_PREVIEW_AND_PRODUCTION',
  CONFIRM_PAYPAL_CREDIT_DISPUTES_MIGRATION: 'APPLIED_TO_PREVIEW_AND_PRODUCTION',
  CONFIRM_PRODUCTION_DRAWING_RELEASE:
    'DRAWING_CONTRACT_THEN_WORLD_ROOT_DRAWING_APPLIED_WITH_DOCUMENTED_DRAWING_GAZETTE_WORLD_POSTCONDITIONS_RECORDED',
  CONFIRM_GAZETTE_SCHEMA_MIGRATION:
    'APPLIED_TO_PREVIEW_AND_PRODUCTION_WITH_ROOM_CLOSED',
  CONFIRM_GAZETTE_WITHDRAWAL_SCHEMA_MIGRATION:
    'APPLIED_TO_PRODUCTION_WITH_WITHDRAWALS_CLOSED_AND_REAL_POSTGRES_PROVEN',
  CONFIRM_RESUMABLE_REGISTRATION_MIGRATION: 'APPLIED_TO_PREVIEW_AND_PRODUCTION',
  CONFIRM_THING_MAKER_MIGRATION: 'APPLIED_TO_PREVIEW_AND_PRODUCTION',
  CONFIRM_RESIDENT_REFUSAL_STATE_MIGRATION: 'APPLIED_TO_PREVIEW_AND_PRODUCTION',
})

function createPreparationFixture(): PreparationFixture {
  const root = createPreparationFixtureRoot('1f3d9-deploy-prepare-')
  const remoteRoot = createPreparationFixtureRoot('1f3d9-deploy-remote-')
  const remote = join(remoteRoot, 'origin.git')
  const hooks = createPreparationFixtureRoot('1f3d9-deploy-hooks-')
  const bin = createPreparationFixtureRoot('1f3d9-deploy-bin-')
  const commandLog = join(bin, 'npm.log')
  const gitEnvironment = {
    ...withoutInheritedGitEnvironment(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: 'NUL',
  }
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
    env: withoutInheritedGitEnvironment(),
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
    env: withoutInheritedGitEnvironment(),
  }).stdout.trim()
  const bashRoot = spawnSync('bash', ['-lc', 'pwd'], {
    cwd: root,
    encoding: 'utf8',
    env: withoutInheritedGitEnvironment(),
  }).stdout.trim()
  const wrapper = join(bin, 'run-prepare.sh')
  writeFileSync(wrapper, [
    '#!/usr/bin/env bash',
    `PATH=${JSON.stringify(bashBin)}:$PATH`,
    'export PATH',
    `TEST_COMMAND_LOG=${JSON.stringify(`${bashBin}/npm.log`)}`,
    'export TEST_COMMAND_LOG',
    'CONFIRM_LATER_HOLDER_PROVIDER_KEY="${1-}"',
    'export CONFIRM_LATER_HOLDER_PROVIDER_KEY',
    'CONFIRM_LATER_HOLDER_MIGRATION="${2-}"',
    'export CONFIRM_LATER_HOLDER_MIGRATION',
    'CONFIRM_THING_MAKER_MIGRATION="${3-}"',
    'export CONFIRM_THING_MAKER_MIGRATION',
    'CONFIRM_RESUMABLE_REGISTRATION_MIGRATION="${4-}"',
    'export CONFIRM_RESUMABLE_REGISTRATION_MIGRATION',
    'CONFIRM_PAYPAL_CREDIT_DISPUTES_MIGRATION="${5-}"',
    'export CONFIRM_PAYPAL_CREDIT_DISPUTES_MIGRATION',
    'CONFIRM_RESIDENT_REFUSAL_STATE_MIGRATION="${6-}"',
    'export CONFIRM_RESIDENT_REFUSAL_STATE_MIGRATION',
    'CONFIRM_GAZETTE_SCHEMA_MIGRATION="${7-}"',
    'export CONFIRM_GAZETTE_SCHEMA_MIGRATION',
    'CONFIRM_PRODUCTION_DRAWING_RELEASE="${8-}"',
    'export CONFIRM_PRODUCTION_DRAWING_RELEASE',
    'CONFIRM_GAZETTE_WITHDRAWAL_SCHEMA_MIGRATION="${9-}"',
    'export CONFIRM_GAZETTE_WITHDRAWAL_SCHEMA_MIGRATION',
    `cd ${JSON.stringify(bashRoot)}`,
    'bash scripts/deploy.sh --prepare',
    '',
  ].join('\n'))
  chmodSync(wrapper, 0o755)

  return {
    root,
    commandLog,
    git,
    run: (overrides = {}) => {
      const readiness = { ...laterHolderReleaseReady, ...overrides }
      return spawnSync('bash', [
        `${bashBin}/run-prepare.sh`,
        readiness.CONFIRM_LATER_HOLDER_PROVIDER_KEY ?? '',
        readiness.CONFIRM_LATER_HOLDER_MIGRATION ?? '',
        readiness.CONFIRM_THING_MAKER_MIGRATION ?? '',
        readiness.CONFIRM_RESUMABLE_REGISTRATION_MIGRATION ?? '',
        readiness.CONFIRM_PAYPAL_CREDIT_DISPUTES_MIGRATION ?? '',
        readiness.CONFIRM_RESIDENT_REFUSAL_STATE_MIGRATION ?? '',
        readiness.CONFIRM_GAZETTE_SCHEMA_MIGRATION ?? '',
        readiness.CONFIRM_PRODUCTION_DRAWING_RELEASE ?? '',
        readiness.CONFIRM_GAZETTE_WITHDRAWAL_SCHEMA_MIGRATION ?? '',
      ], {
        cwd: root,
        encoding: 'utf8',
        env: withoutInheritedGitEnvironment(),
      })
    },
    cleanup: () => {
      for (const path of [bin, hooks, remoteRoot, root]) {
        cleanupPreparationFixtureRoot(path)
      }
    },
  }
}

test('manual deploy invocation fails closed with GitHub-to-Vercel guidance', t => {
  const fixture = createPreparationFixture()
  t.after(() => fixture.cleanup())
  const result = spawnSync('bash', ['scripts/deploy.sh'], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: withoutInheritedGitEnvironment(),
  })

  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /--prepare/)
  assert.match(`${result.stdout}\n${result.stderr}`, /merge[^\n]*main/i)
  assert.equal(existsSync(fixture.commandLog), false)
})

test('preparation requires provider-key and migration readiness before any release gate', t => {
  const fixture = createPreparationFixture()
  t.after(() => fixture.cleanup())

  const missingProvider = fixture.run({ CONFIRM_LATER_HOLDER_PROVIDER_KEY: '' })
  assert.notEqual(missingProvider.status, 0)
  assert.match(`${missingProvider.stdout}\n${missingProvider.stderr}`, /LATER_HOLDER_CURSOR_KEY.*Vercel/iu)
  assert.equal(existsSync(fixture.commandLog), false)

  const missingMigration = fixture.run({ CONFIRM_LATER_HOLDER_MIGRATION: '' })
  assert.notEqual(missingMigration.status, 0)
  assert.match(`${missingMigration.stdout}\n${missingMigration.stderr}`, /later-holder.*migration.*before.*rollout/iu)
  assert.equal(existsSync(fixture.commandLog), false)

  const missingMakerMigration = fixture.run({ CONFIRM_THING_MAKER_MIGRATION: '' })
  assert.notEqual(missingMakerMigration.status, 0)
  assert.match(
    `${missingMakerMigration.stdout}\n${missingMakerMigration.stderr}`,
    /thing-maker.*migration.*before.*later-holder/iu,
  )
  assert.equal(existsSync(fixture.commandLog), false)

  const missingResumableRegistration = fixture.run({ CONFIRM_RESUMABLE_REGISTRATION_MIGRATION: '' })
  assert.notEqual(missingResumableRegistration.status, 0)
  assert.match(
    `${missingResumableRegistration.stdout}\n${missingResumableRegistration.stderr}`,
    /resumable-registration.*migration.*Preview and Production.*before.*rollout/iu,
  )
  assert.equal(existsSync(fixture.commandLog), false)

  const missingPayPalCreditDisputes = fixture.run({ CONFIRM_PAYPAL_CREDIT_DISPUTES_MIGRATION: '' })
  assert.notEqual(missingPayPalCreditDisputes.status, 0)
  assert.match(
    `${missingPayPalCreditDisputes.stdout}\n${missingPayPalCreditDisputes.stderr}`,
    /paypal-credit-disputes.*migration.*Preview and Production.*before.*rollout/iu,
  )
  assert.equal(existsSync(fixture.commandLog), false)

  const missingResidentRefusalState = fixture.run({ CONFIRM_RESIDENT_REFUSAL_STATE_MIGRATION: '' })
  assert.notEqual(missingResidentRefusalState.status, 0)
  assert.match(
    `${missingResidentRefusalState.stdout}\n${missingResidentRefusalState.stderr}`,
    /resident-refusal-state.*migration.*Preview and Production.*before.*rollout/iu,
  )
  assert.equal(existsSync(fixture.commandLog), false)

  const missingGazette = fixture.run({ CONFIRM_GAZETTE_SCHEMA_MIGRATION: '' })
  assert.notEqual(missingGazette.status, 0)
  assert.match(
    `${missingGazette.stdout}\n${missingGazette.stderr}`,
    /Gazette schema.*was applied.*Preview and Production.*while room #454 was closed/iu,
  )
  assert.equal(existsSync(fixture.commandLog), false)

  const wrongGazetteState = fixture.run({
    CONFIRM_GAZETTE_SCHEMA_MIGRATION: 'APPLIED_TO_PREVIEW_AND_PRODUCTION',
  })
  assert.notEqual(wrongGazetteState.status, 0)
  assert.match(
    `${wrongGazetteState.stdout}\n${wrongGazetteState.stderr}`,
    /Gazette schema.*was applied.*Preview and Production.*while room #454 was closed/iu,
  )
  assert.equal(existsSync(fixture.commandLog), false)

  const missingGazetteWithdrawal = fixture.run({
    CONFIRM_GAZETTE_WITHDRAWAL_SCHEMA_MIGRATION: '',
  })
  assert.notEqual(missingGazetteWithdrawal.status, 0)
  assert.match(
    `${missingGazetteWithdrawal.stdout}\n${missingGazetteWithdrawal.stderr}`,
    /Gazette withdrawal schema.*Production.*withdrawals remained closed.*real PostgreSQL.*before.*rollout/iu,
  )
  assert.equal(existsSync(fixture.commandLog), false)

  const wrongGazetteWithdrawalState = fixture.run({
    CONFIRM_GAZETTE_WITHDRAWAL_SCHEMA_MIGRATION: 'APPLIED_TO_PRODUCTION',
  })
  assert.notEqual(wrongGazetteWithdrawalState.status, 0)
  assert.match(
    `${wrongGazetteWithdrawalState.stdout}\n${wrongGazetteWithdrawalState.stderr}`,
    /Gazette withdrawal schema.*Production.*withdrawals remained closed.*real PostgreSQL.*before.*rollout/iu,
  )
  assert.equal(existsSync(fixture.commandLog), false)

  const missingDrawingRelease = fixture.run({ CONFIRM_PRODUCTION_DRAWING_RELEASE: '' })
  assert.notEqual(missingDrawingRelease.status, 0)
  assert.match(
    `${missingDrawingRelease.stdout}\n${missingDrawingRelease.stderr}`,
    /Production drawing-contract then world-root-drawing migrations ran in that order[\s\S]*drawing\/Gazette\/world postcondition checks were recorded[\s\S]*does not query Production/iu,
  )
  assert.equal(existsSync(fixture.commandLog), false)

  const wrongDrawingRelease = fixture.run({
    CONFIRM_PRODUCTION_DRAWING_RELEASE: 'yes',
  })
  assert.notEqual(wrongDrawingRelease.status, 0)
  assert.match(
    `${wrongDrawingRelease.stdout}\n${wrongDrawingRelease.stderr}`,
    /Production drawing-contract then world-root-drawing migrations ran in that order[\s\S]*drawing\/Gazette\/world postcondition checks were recorded[\s\S]*does not query Production/iu,
  )
  assert.equal(existsSync(fixture.commandLog), false)
})

test('release instructions require maker provenance before later-holder marks in each database', () => {
  const previewMaker = deploymentRunbook.indexOf('npm run migrate:preview:thing-maker')
  const previewMarks = deploymentRunbook.indexOf('npm run migrate:preview:later-holder-marks')
  const productionMaker = deploymentRunbook.indexOf('npm run migrate:production:thing-maker')
  const productionMarks = deploymentRunbook.indexOf('npm run migrate:production:later-holder-marks')

  assert.ok(previewMaker >= 0 && previewMaker < previewMarks)
  assert.ok(productionMaker >= 0 && productionMaker < productionMarks)
  assert.match(
    deploymentRunbook,
    /CONFIRM_THING_MAKER_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION/u,
  )
})

test('Gazette withdrawal release instructions keep schema dormant until exact-commit activation', () => {
  const previewDormant = deploymentRunbook.indexOf(
    'npm run migrate:preview:gazette-withdrawal',
  )
  const previewActivation = deploymentRunbook.indexOf(
    'npm run migrate:preview:gazette-withdrawal-activation',
  )
  const productionDormant = deploymentRunbook.indexOf(
    'npm run migrate:production:gazette-withdrawal',
  )
  const productionActivation = deploymentRunbook.indexOf(
    'npm run migrate:production:gazette-withdrawal-activation',
  )

  assert.ok(previewDormant >= 0 && previewDormant < previewActivation)
  assert.ok(productionDormant >= 0 && productionDormant < productionActivation)
  assert.match(
    deploymentRunbook,
    /CONFIRM_GAZETTE_WITHDRAWAL=INSTALL_DORMANT_GAZETTE_WITHDRAWAL_LEDGER/u,
  )
  assert.match(
    deploymentRunbook,
    /CONFIRM_GAZETTE_WITHDRAWAL_ACTIVATION=OPEN_GAZETTE_WITHDRAWALS_AFTER_MATCHING_APP_DEPLOYMENT/u,
  )
  assert.match(
    deploymentRunbook,
    /withdrawals_open[\s\S]*false[\s\S]*exact[ -]commit[\s\S]*\/api\/official[\s\S]*withdrawals_open[\s\S]*true/iu,
  )
  assert.match(
    deploymentRunbook,
    /Preview database lacks the Gazette base schema[\s\S]*500[\s\S]*not[\s\S]*withdrawal rollout/iu,
  )
  assert.match(
    deploymentRunbook,
    /while[\s\S]{0,180}withdrawals_open[\s\S]{0,80}false[\s\S]{0,320}intercepts? no[\s\S]{0,100}(?:Room #454 )?bod/iu,
  )
  assert.match(
    deploymentRunbook,
    /WITHDRAW #<digits>[\s\S]{0,260}WITHDRAW #12x[\s\S]{0,260}WITHDRAW my nomination for mayor, a poem[\s\S]{0,260}ordinary submissions/iu,
  )
  assert.match(
    deploymentRunbook,
    /ordinary submissions[\s\S]{0,320}(?:use|spend)[\s\S]{0,120}weekly[\s\S]{0,80}slot[\s\S]{0,260}(?:can|may|eligible to) print[\s\S]{0,260}no withdrawal ledger[\s\S]{0,200}no withdrawal refusal/iu,
  )
  assert.match(
    deploymentRunbook,
    /withdrawals_open[\s\S]{0,80}true[\s\S]{0,180}exact uppercase[\s\S]{0,80}WITHDRAW[\s\S]{0,100}optional whitespace[\s\S]{0,80}#/iu,
  )
  assert.match(deploymentRunbook, /command-shaped near-miss[\s\S]{0,120}refus/iu)
  assert.match(deploymentRunbook, /all six[\s\S]{0,80}refusal statuses and messages/iu)
  assert.match(
    deploymentRunbook,
    /withdrawals[\s\S]{0,40}(?:are|remain) closed[\s\S]{0,180}reserved-opening shapes[\s\S]{0,160}(?:replay normally|normal same-body replay)/iu,
  )
  assert.match(
    deploymentRunbook,
    /after[\s\S]{0,40}activation[\s\S]{0,160}unledgered reserved opening[\s\S]{0,180}active rule[\s\S]{0,220}ordinary prose[\s\S]{0,180}ledgered withdrawal[\s\S]{0,40}commands[\s\S]{0,140}normal replay/iu,
  )
  assert.match(
    environmentRunbook,
    /CONFIRM_GAZETTE_WITHDRAWAL[\s\S]*INSTALL_DORMANT_GAZETTE_WITHDRAWAL_LEDGER[\s\S]*CONFIRM_GAZETTE_WITHDRAWAL_ACTIVATION[\s\S]*OPEN_GAZETTE_WITHDRAWALS_AFTER_MATCHING_APP_DEPLOYMENT/iu,
  )
  assert.match(
    environmentRunbook,
    /GAZETTE_DEPLOYMENT_COMMIT[\s\S]*room and withdrawal activations/iu,
  )
})

test('production drawing migrations have one guarded order and rollback boundary', () => {
  const drawingContract = deploymentRunbook.indexOf(
    'npm run migrate:production:drawing-contract',
  )
  const worldRootDrawing = deploymentRunbook.indexOf(
    'npm run migrate:production:world-root-drawing',
  )

  assert.ok(drawingContract >= 0 && drawingContract < worldRootDrawing)
  assert.match(
    deploymentRunbook,
    /CONFIRM_PRODUCTION_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION/u,
  )
  assert.match(
    deploymentRunbook,
    /fresh[^\n]*PRODUCTION_SNAPSHOT_NAME[^\n]*each production drawing command/iu,
  )
  for (const postcondition of [
    'drawing_revisions',
    'residents_drawing_contract',
    'places_drawing_contract',
    'kind_revisions_drawing_contract',
    'things_drawing_contract',
    'places_world_shape',
    'places_world_drawing_exact',
    'places_protect_topology_write',
    'public_records_v2',
    'public_records_without_drawing_contract',
    'resident_edited',
    'gazette_issues',
    'gazette_issue_entries',
    'has_table_privilege',
  ]) assert.match(deploymentRunbook, new RegExp(postcondition, 'u'))
  assert.match(deploymentRunbook, /pg_get_viewdef/iu)
  assert.match(
    deploymentRunbook,
    /pg_get_viewdef\(\s*to_regclass\('city_snapshot\.public_records_v2'\)/u,
  )
  assert.doesNotMatch(
    deploymentRunbook,
    /pg_get_viewdef\(\s*'city_snapshot\.public_records_v2'::regclass/u,
  )
  assert.match(deploymentRunbook, /\{detail,error\}/u)
  assert.match(deploymentRunbook, /no_gazette[\s\S]*true[\s\S]*false/iu)
  assert.match(deploymentRunbook, /dormant[\s\S]*true[\s\S]*true/iu)
  assert.match(deploymentRunbook, /activated[\s\S]*false[\s\S]*true/iu)
  assert.match(deploymentRunbook, /application rollback[^\n]*does not revert database changes/iu)
  assert.match(deploymentRunbook, /destructive down migration[^\n]*not[^\n]*incident/iu)
  assert.match(
    deploymentRunbook,
    /CONFIRM_PRODUCTION_DRAWING_RELEASE=DRAWING_CONTRACT_THEN_WORLD_ROOT_DRAWING_APPLIED_WITH_DOCUMENTED_DRAWING_GAZETTE_WORLD_POSTCONDITIONS_RECORDED/u,
  )
  assert.match(
    environmentRunbook,
    /CONFIRM_PRODUCTION_DRAWING_RELEASE[\s\S]*operator attestation[\s\S]*does not query Production/iu,
  )
})

test('PostgreSQL gate upgrades the checked-in pre-drawing production schema in release order', () => {
  const fileName = 'drawing-upgrade-postgres.test.ts'
  assertPostgresTestDiscovered(fileName)
  const source = readFileSync(
    new URL(`../test/integration/${fileName}`, import.meta.url),
    'utf8',
  )
  const drawingContract = source.indexOf('await client.query(drawingContractMigrationDdl)')
  const worldRootDrawing = source.indexOf('await client.query(worldRootDrawingMigrationDdl)')

  assert.match(source, /production-pre-drawing-schema-98594c0\.sql\.gz\.base64/u)
  assert.ok(drawingContract >= 0 && drawingContract < worldRootDrawing)
  assert.match(source, /places_world_drawing_exact/u)
  assert.match(source, /places_protect_topology_write/u)
  assert.match(source, /drawing_revisions_append_only/u)
  assert.match(source, /gazetteMigrationDdl/u)
  assert.match(source, /gazetteActivationDdl/u)
  assert.match(source, /public_records_v2/u)
  assert.match(source, /public_records_without_drawing_contract/u)
  assert.match(source, /resident_edited/u)
  assert.match(source, /drawing_upgrade_private_fixture/u)
  assert.match(source, /gazette_issues/u)
  assert.match(source, /snapshotExportPrivileges/u)
})

test('release preparation requires the resumable-registration schema in Preview and Production', () => {
  assert.match(deploymentRunbook, /npm run migrate:preview:resumable-registration/u)
  assert.match(deploymentRunbook, /npm run migrate:production:resumable-registration/u)
  assert.match(
    deploymentRunbook,
    /CONFIRM_RESUMABLE_REGISTRATION_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION/u,
  )
})

test('release preparation requires the PayPal credit disputes schema in Preview and Production', () => {
  assert.match(deploymentRunbook, /npm run migrate:preview:paypal-credit-disputes/u)
  assert.match(deploymentRunbook, /npm run migrate:production:paypal-credit-disputes/u)
  assert.match(
    deploymentRunbook,
    /CONFIRM_PAYPAL_CREDIT_DISPUTES_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION/u,
  )
})

test('release preparation requires the resident refusal state schema in Preview and Production', () => {
  assert.match(deploymentRunbook, /npm run migrate:preview:resident-refusal-state/u)
  assert.match(deploymentRunbook, /npm run migrate:production:resident-refusal-state/u)
  assert.match(
    deploymentRunbook,
    /CONFIRM_RESIDENT_REFUSAL_STATE_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION/u,
  )
  assert.match(environmentRunbook, /CONFIRM_RESIDENT_REFUSAL_STATE_MIGRATION/u)
})

test('preparation proves a clean GitHub branch and runs every local gate without deploying', t => {
  const fixture = createPreparationFixture()
  t.after(() => fixture.cleanup())
  const result = fixture.run()

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(
    finalNonEmptyLine(result.stdout),
    `GATE_EXIT=${result.status}`,
    'the final non-empty stdout line must report the captured process status',
  )
  assert.match(result.stdout, /did not deploy/i)
  assert.match(result.stdout, /merge[^\n]*main/i)
  const commands = readFileSync(fixture.commandLog, 'utf8')
  for (const command of ['npm test', 'npm run typecheck', 'npm run test:postgres', 'npm run test:e2e']) {
    assert.match(commands, new RegExp(`^${command}$`, 'm'))
  }
})

test('dirty or not-pushed work stops before any preparation gate', t => {
  const dirty = createPreparationFixture()
  t.after(() => dirty.cleanup())
  writeFileSync(join(dirty.root, 'untracked.txt'), 'not reviewed\n')
  const dirtyResult = dirty.run()
  assert.notEqual(dirtyResult.status, 0)
  assert.equal(
    finalNonEmptyLine(dirtyResult.stdout),
    `GATE_EXIT=${dirtyResult.status}`,
    'the final non-empty stdout line must report the captured dirty-worktree status',
  )
  assert.match(`${dirtyResult.stdout}\n${dirtyResult.stderr}`, /worktree.*clean/i)
  assert.equal(existsSync(dirty.commandLog), false)

  const unpushed = createPreparationFixture()
  t.after(() => unpushed.cleanup())
  writeFileSync(join(unpushed.root, 'README.md'), 'new unpushed commit\n')
  unpushed.git('add', 'README.md')
  unpushed.git('commit', '-q', '-m', 'unpushed')
  const unpushedResult = unpushed.run()
  assert.notEqual(unpushedResult.status, 0)
  assert.equal(
    finalNonEmptyLine(unpushedResult.stdout),
    `GATE_EXIT=${unpushedResult.status}`,
    'the final non-empty stdout line must report the captured unpushed-branch status',
  )
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

test('identity recovery is an explicitly selected additive release with a PostgreSQL gate', () => {
  const migration = readFileSync(identityRecoveryMigrationUrl, 'utf8')
  const uncommented = migration.replace(/^\s*--.*$/gm, '')
  assert.doesNotMatch(uncommented, /^\s*(?:DROP\s+TABLE|DELETE|TRUNCATE)\b/im)
  assert.match(uncommented, /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+recovery_generation\s+BIGINT\s+NOT\s+NULL\s+DEFAULT\s+0/i)
  assert.match(uncommented, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+pending_resident_registrations/i)
  assert.match(uncommented, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+resident_recovery_codes/i)
  assert.match(uncommented, /code_hash\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i)
  assert.doesNotMatch(uncommented, /recovery_code\s+TEXT/i)

  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'identity-recovery'],
    {
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    },
  )
  assert.equal(preview.migrationFile, 'db/migrations/20260816_identity_recovery.sql')

  const production = resolveMigrationRun(
    ['--target', 'production', '--migration', 'identity-recovery'],
    {
      CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      PRODUCTION_SNAPSHOT_NAME: 'identity-recovery-release',
    },
  )
  assert.equal(production.migrationFile, 'db/migrations/20260816_identity_recovery.sql')
  assertPostgresTestDiscovered('identity-recovery-postgres.test.ts')
})

test('identity rotation is additive, schema-complete, and covered by the existing identity PostgreSQL gate', () => {
  const migration = readFileSync(identityRotationMigrationUrl, 'utf8')
  const uncommented = migration.replace(/^\s*--.*$/gm, '')
  const statements = splitSqlStatements(migration)

  assert.doesNotMatch(uncommented, /^\s*(?:DROP\s+TABLE|DELETE|TRUNCATE)\b/im)
  assert.match(uncommented, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+resident_key_rotations/i)
  assert.match(uncommented, /replacement_secret_hash\s+TEXT/i)
  assert.doesNotMatch(uncommented, /\breplacement_secret\s+TEXT\b/i)
  assert.match(uncommented, /replacement_secret_hash\s+IS\s+NULL/i)
  for (const attemptKind of ['rotation_begin', 'rotation_confirm']) {
    assert.match(uncommented, new RegExp(`'${attemptKind}'`))
    assert.match(fullSchema, new RegExp(`'${attemptKind}'`))
  }

  const freshInstallStatements = new Set(splitSqlStatements(fullSchema).map(statement =>
    statement.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').trim()
  ))
  const rotationObjects = statements.filter(statement =>
    /^\s*CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s+IF\s+NOT\s+EXISTS\b/i.test(statement)
  )
  assert.ok(rotationObjects.length >= 2)
  for (const statement of rotationObjects) {
    const normalized = statement.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').trim()
    assert.ok(
      freshInstallStatements.has(normalized),
      'db/schema.sql drifted from the reviewed identity-rotation object',
    )
  }

  assertPostgresTestDiscovered('identity-recovery-postgres.test.ts')
  assert.equal(
    existsSync(new URL('../test/integration/identity-rotation-postgres.test.ts', import.meta.url)),
    false,
    'identity rotation should stay covered by the existing identity integration suite',
  )
})

test('initial recovery codes use two additive normalized pending tables', () => {
  const migration = readFileSync(initialRecoveryCodesMigrationUrl, 'utf8')
  const uncommented = migration.replace(/^\s*--.*$/gm, '')
  const statements = splitSqlStatements(migration)

  assert.equal(statements.length, 2)
  assert.doesNotMatch(uncommented, /^\s*(?:ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE)\b/im)
  assert.doesNotMatch(uncommented, /\b(?:recovery_code_hashes|new_recovery_code_hashes)\b/i)
  assert.doesNotMatch(uncommented, /\bTEXT\s*\[\s*\]/i)
  assert.match(uncommented, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+pending_resident_registration_recovery_codes/i)
  assert.match(uncommented, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+oauth_authorization_request_recovery_codes/i)

  for (const statement of statements) {
    assert.match(statement, /^\s*(?:--.*\s+)*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/i)
    assert.match(statement, /code_hash\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i)
    assert.match(statement, /code_hash\s+~\s+'\^\[0-9a-f\]\{64\}\$'/i)
    assert.match(statement, /ordinal\s+SMALLINT\s+NOT\s+NULL\s+CHECK\s*\(ordinal\s+BETWEEN\s+1\s+AND\s+8\)/i)
    assert.match(statement, /ON\s+DELETE\s+CASCADE/i)
  }
})

test('initial recovery codes are selected as one separate preview or production migration', () => {
  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'initial-recovery-codes'],
    {
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    },
  )
  assert.equal(preview.migrationFile, 'db/migrations/20260817_initial_recovery_codes.sql')

  const production = resolveMigrationRun(
    ['--target', 'production', '--migration', 'initial-recovery-codes'],
    {
      CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      PRODUCTION_SNAPSHOT_NAME: 'initial-recovery-codes-release',
    },
  )
  assert.equal(production.migrationFile, 'db/migrations/20260817_initial_recovery_codes.sql')

  assertPostgresTestDiscovered('identity-recovery-postgres.test.ts')
  assertPostgresTestDiscovered('oauth-postgres.test.ts')
})

test('payment attempts are an explicitly selected additive release', () => {
  const paymentAttemptsMigration = readFileSync(paymentAttemptsMigrationUrl, 'utf8')
  const uncommented = paymentAttemptsMigration.replace(/^\s*--.*$/gm, '')
  const statements = splitSqlStatements(paymentAttemptsMigration)

  assert.ok(statements.length >= 10)
  assert.doesNotMatch(uncommented, /^\s*(?:DROP\s+TABLE|DELETE|TRUNCATE)\b/im)
  assert.match(uncommented, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+payment_attempts/i)
  assert.match(uncommented, /public_id\s+TEXT\s+PRIMARY\s+KEY/i)
  assert.match(uncommented, /status\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(status\s+IN\s*\(\s*'settling',\s*'payment_pending',\s*'completed',\s*'invalid',\s*'expired',\s*'needs_review',\s*'legacy_completed'\s*\)\)/i)
  assert.match(uncommented, /ADD\s+CONSTRAINT\s+payment_attempts_status_check\s+CHECK\s*\(status\s+IN\s*\(\s*'settling',\s*'payment_pending',\s*'completed',\s*'invalid',\s*'expired',\s*'needs_review',\s*'founder_review',\s*'legacy_completed',\s*'credit_returned'\s*\)\)/i)
  assert.match(uncommented, /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+payment_attempts_x402_nonce/i)
  assert.match(uncommented, /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+payment_attempts_one_live_target/i)
  assert.match(uncommented, /INSERT\s+INTO\s+payment_attempts/i)
  assert.match(uncommented, /DROP\s+TRIGGER\s+IF\s+EXISTS\s+sale_payments_match_world_offer\s+ON\s+sale_payments/i)

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

test('payment response replay is an explicitly selected idempotent function repair', () => {
  const migration = readFileSync(paymentResponseReplayMigrationUrl, 'utf8')
  const uncommented = migration.replace(/^\s*--.*$/gm, '')
  const statements = splitSqlStatements(migration)

  assert.equal(statements.length, 2)
  assert.match(uncommented, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+complete_payment_attempt/i)
  assert.match(uncommented, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+protect_payment_attempt_history/i)
  assert.match(uncommented, /__1f3d9_x402_response_v1/i)
  assert.doesNotMatch(uncommented, /^\s*(?:DROP\s+TABLE|ALTER\s+TABLE|DELETE|TRUNCATE)\b/im)

  assert.match(fullSchema, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+protect_payment_attempt_history/i)
  assert.match(fullSchema, /OLD\.status\s*=\s*'payment_pending'[\s\S]*'expired'/i)
  assert.match(fullSchema, /OLD\.status\s*=\s*'expired'[\s\S]*'founder_review'/i)

  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'payment-response-replay'],
    {
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    },
  )
  assert.equal(preview.migrationFile, 'db/migrations/20260816_payment_response_replay.sql')

  const production = resolveMigrationRun(
    ['--target', 'production', '--migration', 'payment-response-replay'],
    {
      CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      PRODUCTION_SNAPSHOT_NAME: 'payment-response-replay-release',
    },
  )
  assert.equal(production.migrationFile, 'db/migrations/20260816_payment_response_replay.sql')
})

test('the applied byte-exact replay migration remains byte-for-byte immutable', () => {
  const migration = readFileSync(paymentResponseBodyReplayMigrationUrl)
  assert.equal(
    createHash('sha256').update(migration).digest('hex'),
    'f2bb76aba013c5ff493920bae6d481106781e10cacd78ab28211614b27b12feb',
  )
  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'payment-response-body-replay'],
    {
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    },
  )
  assert.equal(preview.migrationFile, 'db/migrations/20260817_payment_response_body_replay.sql')
})

test('byte-exact payment replay has an explicitly selected lock-safe rollout', () => {
  const migration = readFileSync(paymentResponseBodyRolloutMigrationUrl, 'utf8')
  const uncommented = migration.replace(/^\s*--.*$/gm, '')
  const constraintBlock = uncommented.match(
    /ADD\s+CONSTRAINT\s+payment_attempts_response_body_bytes_valid[\s\S]*?END\s+IF\s*;/i,
  )?.[0] ?? ''

  assert.match(uncommented, /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+response_body_bytes\s+BYTEA/i)
  assert.match(constraintBlock, /\)\s+NOT\s+VALID\s*;\s*END\s+IF\s*;$/i)
  assert.doesNotMatch(uncommented, /VALIDATE\s+CONSTRAINT/i)
  assert.match(uncommented, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+complete_payment_attempt/i)
  assert.match(uncommented, /completion_response_body\s+BYTEA/i)
  for (const statement of splitSqlStatements(migration)) {
    assert.doesNotMatch(
      statement.replace(/^\s*--.*$/gm, '').trim(),
      /^(?:UPDATE|DELETE|TRUNCATE|DROP\s+TABLE|DROP\s+COLUMN)\b/i,
    )
  }

  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'payment-response-body-rollout'],
    {
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    },
  )
  assert.equal(preview.migrationFile, 'db/migrations/20260818_payment_response_body_rollout.sql')

  const production = resolveMigrationRun(
    ['--target', 'production', '--migration', 'payment-response-body-rollout'],
    {
      CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      PRODUCTION_SNAPSHOT_NAME: 'payment-response-body-rollout-release',
    },
  )
  assert.equal(production.migrationFile, 'db/migrations/20260818_payment_response_body_rollout.sql')
})

test('byte-exact response constraint validation is one separately committed named migration', () => {
  const migration = readFileSync(paymentResponseBodyValidationMigrationUrl, 'utf8')
  const statements = splitSqlStatements(migration)
    .map(statement => statement.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean)
  assert.equal(statements.length, 1)
  assert.match(
    statements[0] ?? '',
    /^ALTER\s+TABLE\s+payment_attempts\s+VALIDATE\s+CONSTRAINT\s+payment_attempts_response_body_bytes_valid\s*;?$/i,
  )

  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'payment-response-body-validate'],
    {
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    },
  )
  assert.equal(preview.migrationFile, 'db/migrations/20260818_payment_response_body_validate.sql')

  const production = resolveMigrationRun(
    ['--target', 'production', '--migration', 'payment-response-body-validate'],
    {
      CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      PRODUCTION_SNAPSHOT_NAME: 'payment-response-body-validate-release',
    },
  )
  assert.equal(production.migrationFile, 'db/migrations/20260818_payment_response_body_validate.sql')
})

test('payment recovery trigger repair is an explicitly selected function correction', () => {
  const migration = readFileSync(paymentRecoveryTriggerRepairMigrationUrl, 'utf8')
  const uncommented = migration.replace(/^\s*--.*$/gm, '')
  const statements = splitSqlStatements(migration)

  assert.equal(statements.length, 1)
  assert.match(uncommented, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+protect_payment_attempt_history/i)
  assert.match(uncommented, /OLD\.status\s*=\s*'payment_pending'[\s\S]*'expired'/i)
  assert.match(uncommented, /OLD\.status\s*=\s*'expired'[\s\S]*'founder_review'/i)
  assert.doesNotMatch(uncommented, /^\s*(?:DROP\s+TABLE|DELETE|TRUNCATE)\b/im)

  assert.match(fullSchema, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+protect_payment_attempt_history/i)
  assert.match(fullSchema, /OLD\.status\s*=\s*'payment_pending'[\s\S]*'expired'/i)
  assert.match(fullSchema, /OLD\.status\s*=\s*'expired'[\s\S]*'founder_review'/i)

  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'payment-recovery-trigger-repair'],
    {
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    },
  )
  assert.equal(preview.migrationFile, 'db/migrations/20260823_payment_recovery_trigger_repair.sql')

  const production = resolveMigrationRun(
    ['--target', 'production', '--migration', 'payment-recovery-trigger-repair'],
    {
      CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      PRODUCTION_SNAPSHOT_NAME: 'payment-recovery-trigger-repair-release',
    },
  )
  assert.equal(production.migrationFile, 'db/migrations/20260823_payment_recovery_trigger_repair.sql')
  assert.match(
    packageJson.scripts['migrate:preview:payment-recovery-trigger-repair'] ?? '',
    /--target preview --migration payment-recovery-trigger-repair$/,
  )
  assert.match(
    packageJson.scripts['migrate:production:payment-recovery-trigger-repair'] ?? '',
    /--target production --migration payment-recovery-trigger-repair$/,
  )
})

test('late-finality recheck guard is an explicitly selected immutable-history correction', () => {
  const migration = readFileSync(paymentLateFinalityRecheckMigrationUrl, 'utf8')
  const uncommented = migration.replace(/^\s*--.*$/gm, '')
  assert.equal(splitSqlStatements(migration).length, 1)
  assert.match(uncommented, /OLD\.status\s*=\s*'expired'[\s\S]*NEW\.status\s*=\s*'founder_review'/i)
  assert.match(uncommented, /OLD\.finalized_block_number\s+IS\s+NULL[\s\S]*OR\s+ROW\(/i)
  assert.doesNotMatch(uncommented, /^\s*(?:DROP\s+TABLE|DELETE|TRUNCATE)\b/im)

  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'payment-late-finality-recheck'],
    {
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    },
  )
  assert.equal(preview.migrationFile, 'db/migrations/20260825_payment_late_finality_recheck.sql')

  const production = resolveMigrationRun(
    ['--target', 'production', '--migration', 'payment-late-finality-recheck'],
    {
      CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      PRODUCTION_SNAPSHOT_NAME: 'payment-late-finality-recheck-release',
    },
  )
  assert.equal(production.migrationFile, 'db/migrations/20260825_payment_late_finality_recheck.sql')
  assert.match(
    packageJson.scripts['migrate:preview:payment-late-finality-recheck'] ?? '',
    /--target preview --migration payment-late-finality-recheck$/,
  )
  assert.match(
    packageJson.scripts['migrate:production:payment-late-finality-recheck'] ?? '',
    /--target production --migration payment-late-finality-recheck$/,
  )
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
