import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { resolveMigrationRun } from '../scripts/migrate.ts'

const root = new URL('../', import.meta.url)

function source(path: string): string {
  return readFileSync(new URL(path, root), 'utf8')
}

const packageJson = JSON.parse(source('package.json')) as {
  scripts: Readonly<Record<string, string>>
}
const migrationFile = 'db/migrations/20260823_public_snapshots.sql' as const

test('the public snapshot migration is explicitly selectable for preview and production', () => {
  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'public-snapshots'],
    {
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'test-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    },
  )
  assert.equal(preview.migrationFile, migrationFile)
  assert.equal(preview.executionMode, 'transactional')

  const production = resolveMigrationRun(
    ['--target', 'production', '--migration', 'public-snapshots'],
    {
      CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
      NEON_API_KEY: 'test-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      PRODUCTION_SNAPSHOT_NAME: 'public-snapshots-release',
    },
  )
  assert.equal(production.migrationFile, migrationFile)
  assert.equal(production.executionMode, 'transactional')
})

test('package scripts expose migration, snapshot, and PostgreSQL proof commands', () => {
  assert.match(
    packageJson.scripts['migrate:preview:public-snapshots'] ?? '',
    /--target preview --migration public-snapshots$/u,
  )
  assert.match(
    packageJson.scripts['migrate:production:public-snapshots'] ?? '',
    /--target production --migration public-snapshots$/u,
  )
  assert.equal(
    packageJson.scripts['snapshot:export'],
    'node --experimental-strip-types scripts/export-public-snapshot.ts',
  )
  assert.equal(
    packageJson.scripts['snapshot:verify'],
    'node --experimental-strip-types scripts/verify-public-snapshot.ts',
  )
  assert.equal(
    packageJson.scripts['snapshot:publish'],
    'node --experimental-strip-types scripts/publish-public-snapshot.ts',
  )
  assert.match(
    packageJson.scripts['test:postgres'] ?? '',
    /test\/integration\/\*\.test\.ts/u,
  )
  assert.equal(
    existsSync(new URL('test/integration/public-snapshot-postgres.test.ts', root)),
    true,
  )
})

test('the runbook verifies preview before it presents the production migration', () => {
  const runbook = source('docs/runbooks/PUBLIC_SNAPSHOTS.md')
  const previewStart = runbook.indexOf('5. Export and verify preview')
  const productionStart = runbook.indexOf('6. After preview export and verification pass')

  assert.ok(previewStart >= 0, 'missing the preview export and verification step')
  assert.ok(productionStart > previewStart, 'production must be a later, separate step')

  const previewStep = runbook.slice(previewStart, productionStart)
  assert.match(previewStep, /npm run snapshot:export/u)
  assert.match(previewStep, /npm run snapshot:verify/u)
  assert.doesNotMatch(previewStep, /migrate:production/u)

  const productionStep = runbook.slice(productionStart, runbook.indexOf('## 2.', productionStart))
  assert.match(productionStep, /separate approval/iu)
  assert.match(productionStep, /npm run migrate:production:public-snapshots/u)
})

test('snapshot workflow defaults manual runs to dry-run and reserves writes for publication', () => {
  const workflow = source('.github/workflows/public-snapshot.yml')

  assert.match(workflow, /workflow_dispatch:[\s\S]*default:\s*dry-run/iu)
  assert.match(workflow, /schedule:\s*\n\s*- cron:\s*['"][^'"]+['"]/u)
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request):/gmu)
  assert.match(workflow, /^permissions:\s*\{\}\s*$/mu)
  assert.equal(
    [...workflow.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/gu)].every(match =>
      /^[0-9a-f]{40}$/u.test(match[1] ?? '')
    ),
    true,
    'every third-party action must be pinned to a full commit',
  )
  assert.equal((workflow.match(/persist-credentials:\s*false/gu) ?? []).length, 2)

  const dryRunStart = workflow.indexOf('  dry-run:')
  const publishStart = workflow.indexOf('  publish:')
  assert.ok(dryRunStart >= 0 && publishStart > dryRunStart, 'expected separate dry-run and publish jobs')
  const dryRunJob = workflow.slice(dryRunStart, publishStart)
  const publishJob = workflow.slice(publishStart)

  assert.match(dryRunJob, /github\.event_name == 'workflow_dispatch'/u)
  assert.match(dryRunJob, /inputs\.mode == 'dry-run'/u)
  assert.match(dryRunJob, /contents:\s*read/u)
  assert.doesNotMatch(dryRunJob, /contents:\s*write/u)
  assert.match(dryRunJob, /snapshot:publish -- --dir "\$RUNNER_TEMP\/public-snapshot" --dry-run/u)

  assert.match(publishJob, /github\.event_name == 'schedule'/u)
  assert.match(publishJob, /inputs\.mode == 'publish'/u)
  assert.match(publishJob, /contents:\s*write/u)
  assert.match(
    publishJob,
    /persist-credentials:\s*false\s*\n\s*ref:\s*\$\{\{ github\.event\.repository\.default_branch \}\}/u,
  )
  assert.match(publishJob, /snapshot:publish -- --dir "\$RUNNER_TEMP\/public-snapshot" --publish/u)
})

test('each workflow path exports, verifies, and cleans one temporary snapshot', () => {
  const workflow = source('.github/workflows/public-snapshot.yml')
  assert.doesNotMatch(workflow, /\bDATABASE_URL\b/u)
  assert.doesNotMatch(workflow, /upload-artifact|actions\/cache/u)

  for (const jobName of ['dry-run', 'publish'] as const) {
    const start = workflow.indexOf(`  ${jobName}:`)
    const nextJob = jobName === 'dry-run' ? workflow.indexOf('  publish:', start) : -1
    const job = workflow.slice(start, nextJob === -1 ? undefined : nextJob)
    assert.doesNotMatch(job, /^    env:/mu, 'secrets must not be available to every job step')
    assert.equal((job.match(/secrets\.SNAPSHOT_DATABASE_URL/gu) ?? []).length, 1)
    assert.equal((job.match(/github\.token/gu) ?? []).length, 1)
    assert.match(job, /SNAPSHOT_DATABASE_URL:\s*\$\{\{ secrets\.SNAPSHOT_DATABASE_URL \}\}/u)
    assert.match(
      job,
      /name: Export one frozen public snapshot\s*\n\s*env:\s*\n\s*SNAPSHOT_DATABASE_URL:[^\n]+\n\s*run: npm run snapshot:export/u,
    )
    assert.match(
      job,
      /name: (?:Prove publication is safe without creating a release|Publish only after verification)\s*\n\s*env:\s*\n\s*GITHUB_TOKEN:[^\n]+\n\s*run: npm run snapshot:publish/u,
    )
    const exportAt = job.indexOf('snapshot:export')
    const verifyAt = job.indexOf('snapshot:verify')
    const publishAt = job.indexOf('snapshot:publish')
    assert.ok(exportAt >= 0 && verifyAt > exportAt && publishAt > verifyAt)
    assert.match(job, /if:\s*always\(\)[\s\S]*rm -rf -- "\$RUNNER_TEMP\/public-snapshot"/u)
  }
})
